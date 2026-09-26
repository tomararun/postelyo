import { and, eq, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { ImageSpec, LoadedMedia, MediaUrl } from '@postelyo/publishing-core';
import type { Db } from '../../infra/db/client.js';
import {
  mediaAsset,
  mediaObject,
  type MediaAsset,
  type MediaObject,
} from '../../infra/db/schema.js';
import type { Logger } from '../../infra/logger.js';
import { extensionFor, type ObjectStorage } from '../../infra/storage/index.js';
import type { Clock } from '../../shared/clock.js';
import { uuidv7 } from '../../shared/ids.js';
import type { ContentSourceService } from '../content-sources/content-source.service.js';
import { NotionApiError, NotionClient } from '../content-sources/notion/notion-client.js';
import { mapPage, type PropertyMap } from '../content-sources/notion/notion-mapper.js';
import type { RenderedContent, RenderedMedia } from '../publishing/provider.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { MediaError, MediaFetcher, type FetchedImage } from './media-fetcher.js';
import { deriveVariant, satisfiesSpec, variantKey } from './variants.js';

export interface MediaServiceDeps {
  db: Db;
  contentSources: ContentSourceService;
  storage: ObjectStorage;
  clock: Clock;
  logger: Logger;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
}

export interface ProviderRefEntry {
  ref: string;
  contentHash: string;
  uploadedAt: string;
}

export type ProviderRefs = Record<string, ProviderRefEntry>;

/** Where the asset's page lives, needed to refresh expired Notion-hosted URLs. */
export interface MediaSourceRef {
  contentSourceId: string;
  externalPageId: string;
}

interface VariantEntry {
  key: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
}

/** Public URLs handed to providers stay valid this long; providers fetch once, immediately. */
export const MEDIA_URL_TTL_SECONDS = 60 * 60;
/** Objects no asset references for this long are deleted by maintenance. */
export const MEDIA_OBJECT_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * Media assets (domain-model §2.9, PRD §4.6) and the Phase 2 media pipeline:
 * fetch → validate → store by content hash → per-provider derived variants →
 * public URL. Inspected at sync time so bad files become validation errors
 * before the scheduled time; bytes are re-used from storage at publish time,
 * with provider upload refs cached by hash so retries never re-upload.
 */
export class MediaService {
  private readonly fetcher: MediaFetcher;

  constructor(private readonly deps: MediaServiceDeps) {
    this.fetcher = new MediaFetcher({
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.maxBytes ? { maxBytes: deps.maxBytes } : {}),
    });
  }

  /**
   * Downloads and validates the asset, storing hash/size/type/dimensions and
   * the bytes. Returns the updated row; a MediaError is recorded on the row and rethrown.
   */
  async inspect(asset: MediaAsset): Promise<MediaAsset> {
    const now = this.deps.clock.now();
    try {
      const img = await this.fetcher.fetchImage(asset.sourceUrl);
      return await this.store(asset, img, now);
    } catch (err) {
      const message = err instanceof MediaError ? err.message : 'Could not inspect media';
      const [row] = await this.deps.db
        .update(mediaAsset)
        .set({ lastError: message, inspectedAt: now, updatedAt: now })
        .where(eq(mediaAsset.id, asset.id))
        .returning();
      if (err instanceof MediaError) throw err;
      this.deps.logger.error(
        { err, assetId: asset.id, rowId: row?.id },
        'media inspection crashed',
      );
      throw new MediaError('network', message);
    }
  }

  /**
   * Loads bytes for publishing: from storage when the inspected object is
   * still there, otherwise from the source (Notion-hosted URLs expire; on
   * 403/expired the fresh URL is read from the page and the download retried once).
   */
  async load(
    ctx: TenantContext,
    asset: MediaAsset,
    source: MediaSourceRef | null,
  ): Promise<LoadedMedia> {
    const stored = await this.storedBytes(asset);
    if (stored) {
      return {
        assetId: asset.id,
        bytes: stored.bytes,
        mimeType: stored.object.mimeType,
        byteSize: stored.object.byteSize,
        contentHash: stored.object.contentHash,
        ...(asset.name ? { fileName: asset.name } : {}),
      };
    }
    let img: FetchedImage;
    try {
      img = await this.fetcher.fetchImage(asset.sourceUrl);
    } catch (err) {
      if (
        !(err instanceof MediaError) ||
        err.code !== 'expired' ||
        asset.sourceKind !== 'file' ||
        !source
      )
        throw err;
      const fresh = await this.refreshNotionUrl(ctx, asset, source);
      img = await this.fetcher.fetchImage(fresh);
      await this.deps.db
        .update(mediaAsset)
        .set({ sourceUrl: fresh, updatedAt: this.deps.clock.now() })
        .where(eq(mediaAsset.id, asset.id));
    }
    const row = await this.store(asset, img, this.deps.clock.now());
    return {
      assetId: asset.id,
      bytes: img.bytes,
      mimeType: img.mimeType,
      byteSize: img.byteSize,
      contentHash: img.contentHash,
      ...(row.name ? { fileName: row.name } : {}),
    };
  }

  /**
   * Public URL of a variant that satisfies `spec` (Phase 2, url-delivery
   * providers). Derives and stores the variant on first use; the original is
   * served directly when it already fits.
   */
  async publicUrl(
    ctx: TenantContext,
    asset: MediaAsset,
    spec: ImageSpec,
    source: MediaSourceRef | null,
  ): Promise<MediaUrl> {
    let object = asset.mediaObjectId ? await this.objectById(asset.mediaObjectId) : null;
    if (!object) {
      await this.load(ctx, asset, source);
      const [fresh] = await this.deps.db
        .select()
        .from(mediaAsset)
        .where(eq(mediaAsset.id, asset.id))
        .limit(1);
      object = fresh?.mediaObjectId ? await this.objectById(fresh.mediaObjectId) : null;
      if (!object) throw new MediaError('network', 'media object could not be stored');
    }
    if (satisfiesSpec(object, spec)) {
      return {
        url: await this.deps.storage.publicUrl(object.storageKey, MEDIA_URL_TTL_SECONDS),
        mimeType: object.mimeType,
        width: object.width ?? 0,
        height: object.height ?? 0,
        byteSize: object.byteSize,
      };
    }
    const key = variantKey(spec);
    const variants = object.variants as Record<string, VariantEntry>;
    let entry = variants[key];
    if (!entry) {
      const src = await this.deps.storage.get(object.storageKey);
      if (!src) throw new MediaError('not_found', 'stored media object is missing');
      let derived;
      try {
        derived = await deriveVariant(src.bytes, spec);
      } catch (err) {
        throw new MediaError(
          'not_an_image',
          `Image could not be processed: ${(err as Error).message}`,
        );
      }
      const storageKey = `${object.storageKey.replace(/\.[a-z0-9]+$/, '')}-${key}.${extensionFor(derived.mimeType)}`;
      await this.deps.storage.put(storageKey, derived.bytes, derived.mimeType);
      entry = {
        key: storageKey,
        mimeType: derived.mimeType,
        width: derived.width,
        height: derived.height,
        byteSize: derived.bytes.byteLength,
      };
      await this.deps.db
        .update(mediaObject)
        .set({ variants: { ...variants, [key]: entry }, lastReferencedAt: this.deps.clock.now() })
        .where(eq(mediaObject.id, object.id));
    }
    return {
      url: await this.deps.storage.publicUrl(entry.key, MEDIA_URL_TTL_SECONDS),
      mimeType: entry.mimeType,
      width: entry.width,
      height: entry.height,
      byteSize: entry.byteSize,
    };
  }

  /** Remembers a provider-side upload so the same bytes are never uploaded twice. */
  async recordProviderRef(
    assetId: string,
    provider: string,
    ref: string,
    contentHash: string,
  ): Promise<void> {
    const [row] = await this.deps.db
      .select()
      .from(mediaAsset)
      .where(eq(mediaAsset.id, assetId))
      .limit(1);
    if (!row) return;
    const refs = { ...(row.providerRefs as ProviderRefs) };
    refs[provider] = { ref, contentHash, uploadedAt: this.deps.clock.now().toISOString() };
    await this.deps.db
      .update(mediaAsset)
      .set({ providerRefs: refs, updatedAt: this.deps.clock.now() })
      .where(eq(mediaAsset.id, assetId));
  }

  async rowsFor(assetIds: string[]): Promise<Map<string, MediaAsset>> {
    const map = new Map<string, MediaAsset>();
    for (const id of assetIds) {
      const [row] = await this.deps.db
        .select()
        .from(mediaAsset)
        .where(eq(mediaAsset.id, id))
        .limit(1);
      if (row) map.set(id, row);
    }
    return map;
  }

  /** Deletes stored objects that no asset references and that were last used before the retention window. */
  async pruneUnreferenced(): Promise<number> {
    const cutoff = new Date(this.deps.clock.now().getTime() - MEDIA_OBJECT_RETENTION_MS);
    const referenced = this.deps.db
      .select({ id: mediaAsset.mediaObjectId })
      .from(mediaAsset)
      .where(sql`${mediaAsset.mediaObjectId} is not null`);
    const stale = await this.deps.db
      .select()
      .from(mediaObject)
      .where(and(lt(mediaObject.lastReferencedAt, cutoff), notInArray(mediaObject.id, referenced)))
      .limit(100);
    let n = 0;
    for (const obj of stale) {
      const keys = [
        obj.storageKey,
        ...Object.values(obj.variants as Record<string, VariantEntry>).map((v) => v.key),
      ];
      for (const key of keys) {
        await this.deps.storage.delete(key).catch((err: unknown) => {
          this.deps.logger.warn({ err, key }, 'could not delete media object');
        });
      }
      await this.deps.db.delete(mediaObject).where(eq(mediaObject.id, obj.id));
      n += 1;
    }
    return n;
  }

  private async objectById(id: string): Promise<MediaObject | null> {
    const [row] = await this.deps.db
      .select()
      .from(mediaObject)
      .where(eq(mediaObject.id, id))
      .limit(1);
    return row ?? null;
  }

  private async storedBytes(
    asset: MediaAsset,
  ): Promise<{ object: MediaObject; bytes: Uint8Array } | null> {
    if (!asset.mediaObjectId) return null;
    const object = await this.objectById(asset.mediaObjectId);
    if (!object) return null;
    const got = await this.deps.storage.get(object.storageKey);
    if (!got) return null;
    await this.deps.db
      .update(mediaObject)
      .set({ lastReferencedAt: this.deps.clock.now() })
      .where(eq(mediaObject.id, object.id));
    return { object, bytes: got.bytes };
  }

  /** Upserts the content-addressed object for these bytes and stores them once. */
  private async ensureObject(
    workspaceId: string,
    img: FetchedImage,
    now: Date,
  ): Promise<MediaObject> {
    const [existing] = await this.deps.db
      .select()
      .from(mediaObject)
      .where(
        and(eq(mediaObject.workspaceId, workspaceId), eq(mediaObject.contentHash, img.contentHash)),
      )
      .limit(1);
    if (existing) {
      if (!(await this.deps.storage.get(existing.storageKey))) {
        await this.deps.storage.put(existing.storageKey, img.bytes, img.mimeType);
      }
      const [touched] = await this.deps.db
        .update(mediaObject)
        .set({ lastReferencedAt: now })
        .where(eq(mediaObject.id, existing.id))
        .returning();
      return touched!;
    }
    const storageKey = `ws/${workspaceId}/${img.contentHash}.${extensionFor(img.mimeType)}`;
    await this.deps.storage.put(storageKey, img.bytes, img.mimeType);
    const [inserted] = await this.deps.db
      .insert(mediaObject)
      .values({
        id: uuidv7(),
        workspaceId,
        contentHash: img.contentHash,
        storageKey,
        mimeType: img.mimeType,
        byteSize: img.byteSize,
        width: img.width,
        height: img.height,
        lastReferencedAt: now,
      })
      .onConflictDoNothing({ target: [mediaObject.workspaceId, mediaObject.contentHash] })
      .returning();
    if (inserted) return inserted;
    const [raced] = await this.deps.db
      .select()
      .from(mediaObject)
      .where(
        and(eq(mediaObject.workspaceId, workspaceId), eq(mediaObject.contentHash, img.contentHash)),
      )
      .limit(1);
    return raced!;
  }

  private async store(asset: MediaAsset, img: FetchedImage, now: Date): Promise<MediaAsset> {
    const hashChanged = asset.contentHash !== null && asset.contentHash !== img.contentHash;
    const object = await this.ensureObject(asset.workspaceId, img, now);
    const [row] = await this.deps.db
      .update(mediaAsset)
      .set({
        mimeType: img.mimeType,
        byteSize: img.byteSize,
        width: img.width,
        height: img.height,
        contentHash: img.contentHash,
        mediaObjectId: object.id,
        lastError: null,
        inspectedAt: now,
        // A replaced file invalidates previous uploads.
        ...(hashChanged ? { providerRefs: {} } : {}),
        updatedAt: now,
      })
      .where(eq(mediaAsset.id, asset.id))
      .returning();
    return row!;
  }

  private async refreshNotionUrl(
    ctx: TenantContext,
    asset: MediaAsset,
    source: MediaSourceRef,
  ): Promise<string> {
    const key = (u: string) => (u.split('?')[0] ?? u).replace(/^https?:\/\/[^/]+/, '');
    return this.deps.contentSources.withToken(
      ctx,
      source.contentSourceId,
      'publish',
      async (token, src) => {
        const client = new NotionClient(
          token,
          this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {},
        );
        let page;
        try {
          page = await client.retrievePage(source.externalPageId);
        } catch (err) {
          if (err instanceof NotionApiError && err.code === 'not_found') {
            throw new MediaError('not_found', 'The Notion page holding the image no longer exists');
          }
          throw new MediaError(
            'network',
            `Could not refresh the image link from Notion: ${(err as Error).message}`,
          );
        }
        const map = (src.config as { propertyMap?: PropertyMap }).propertyMap ?? {};
        const mapped = mapPage(page, map);
        const match =
          mapped.media.find((m) => key(m.url) === key(asset.sourceUrl)) ??
          mapped.media.find((m) => m.name === asset.name);
        if (!match)
          throw new MediaError(
            'not_found',
            `Image "${asset.name}" was removed from the Notion page`,
          );
        return match.url;
      },
    );
  }
}

/**
 * Fills provider-facing media metadata from stored asset rows and reuses a cached
 * upload reference when the bytes have not changed since that upload.
 */
export function enrichRenderedMedia(
  rendered: RenderedContent,
  rows: Map<string, MediaAsset>,
  provider: string,
): RenderedContent {
  const media: RenderedMedia[] = rendered.media.map((m) => {
    const row = rows.get(m.assetId);
    if (!row) return m;
    const cached = (row.providerRefs as ProviderRefs)[provider];
    const reusable = cached && row.contentHash && cached.contentHash === row.contentHash;
    return {
      ...m,
      mimeType: row.mimeType ?? m.mimeType,
      byteSize: row.byteSize ?? m.byteSize,
      ...(row.width !== null ? { width: row.width } : {}),
      ...(row.height !== null ? { height: row.height } : {}),
      ...(row.contentHash ? { contentHash: row.contentHash } : {}),
      ...(reusable ? { providerRef: cached.ref } : {}),
    };
  });
  return { ...rendered, media };
}

/** Unused-object check helper for tests and preflight. */
export function isUnreferenced(obj: Pick<MediaObject, 'lastReferencedAt'>, now: Date): boolean {
  return obj.lastReferencedAt.getTime() < now.getTime() - MEDIA_OBJECT_RETENTION_MS;
}

export { isNull as _isNull };
