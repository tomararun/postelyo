import { eq } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { mediaAsset, type MediaAsset } from '../../infra/db/schema.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import type { ContentSourceService } from '../content-sources/content-source.service.js';
import { NotionApiError, NotionClient } from '../content-sources/notion/notion-client.js';
import { mapPage, type PropertyMap } from '../content-sources/notion/notion-mapper.js';
import type { LoadedMedia, RenderedContent, RenderedMedia } from '../publishing/provider.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { MediaError, MediaFetcher, type FetchedImage } from './media-fetcher.js';

export interface MediaServiceDeps {
  db: Db;
  contentSources: ContentSourceService;
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

/**
 * Media assets (domain-model §2.9, PRD §4.6). Inspected at sync time so bad
 * files become validation errors before the scheduled time; loaded again at
 * publish time (Notion URLs expire), with provider upload refs cached by hash
 * so retries never re-upload.
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
   * Downloads and validates the asset, storing hash/size/type/dimensions.
   * Returns the updated row; a MediaError is recorded on the row and rethrown.
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
   * Loads bytes for publishing. Notion-hosted URLs expire; on 403/expired the
   * fresh URL is read from the page and the download retried once.
   */
  async load(
    ctx: TenantContext,
    asset: MediaAsset,
    source: MediaSourceRef | null,
  ): Promise<LoadedMedia> {
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
    const stored = await this.store(asset, img, this.deps.clock.now());
    return {
      assetId: asset.id,
      bytes: img.bytes,
      mimeType: img.mimeType,
      byteSize: img.byteSize,
      contentHash: img.contentHash,
      ...(stored.name ? { fileName: stored.name } : {}),
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

  private async store(asset: MediaAsset, img: FetchedImage, now: Date): Promise<MediaAsset> {
    const hashChanged = asset.contentHash !== null && asset.contentHash !== img.contentHash;
    const [row] = await this.deps.db
      .update(mediaAsset)
      .set({
        mimeType: img.mimeType,
        byteSize: img.byteSize,
        width: img.width,
        height: img.height,
        contentHash: img.contentHash,
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
      ...(row.contentHash ? { contentHash: row.contentHash } : {}),
      ...(reusable ? { providerRef: cached.ref } : {}),
    };
  });
  return { ...rendered, media };
}
