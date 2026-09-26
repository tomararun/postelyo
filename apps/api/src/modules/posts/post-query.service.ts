import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  post,
  publication,
  socialAccount,
  type AuditLogRow,
  type Post,
  type Publication,
} from '../../infra/db/schema.js';
import { withTenantScope } from '../../infra/db/tenant-scope.js';
import { listAuditForEntity } from '../audit/audit.js';
import type { PublicationDto, PublicationService } from '../publishing/publication.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

export interface PostListItem {
  id: string;
  title: string;
  state: Post['state'];
  sourceStatus: string | null;
  externalId: string | null;
  externalUrl: string | null;
  requestedPlatforms: string[];
  requestedPublishLocal: string | null;
  requestedTimezone: string | null;
  validationErrors: unknown;
  warnings: unknown;
  contentHash: string;
  /** Phase 6 */
  aiAssisted: boolean;
  cycleNo: number;
  deletedAt: Date | null;
  updatedAt: Date;
  publications: PublicationListItem[];
}

export interface PublicationListItem {
  id: string;
  postId: string;
  socialAccountId: string;
  accountName: string | null;
  provider: Publication['provider'];
  state: Publication['state'];
  scheduledAt: Date;
  scheduledTz: string;
  scheduledLocal: string;
  cycleNo: number;
  attemptNo: number;
  publishedAt: Date | null;
  delaySeconds: number | null;
  providerPostUrl: string | null;
  deferredUntil: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  writebackState: Publication['writebackState'];
}

export interface PublicationDetail {
  publication: PublicationDto;
  post: Pick<Post, 'id' | 'title' | 'state' | 'sourceStatus' | 'externalUrl' | 'contentHash'>;
  accountName: string | null;
  audit: AuditLogRow[];
}

/** Read models for the operator UI and the v1 read endpoints (architecture §14.2). */
export class PostQueryService {
  constructor(
    private readonly db: Db,
    private readonly publications: PublicationService,
  ) {}

  async list(
    ctx: TenantContext,
    filter: { state?: string | undefined } = {},
  ): Promise<PostListItem[]> {
    const conditions = [eq(post.workspaceId, ctx.workspaceId)];
    if (filter.state) conditions.push(eq(post.state, filter.state as Post['state']));
    const { posts, pubs } = await withTenantScope(this.db, ctx.workspaceId, async (tx) => {
      const posts = await tx
        .select()
        .from(post)
        .where(and(...conditions))
        .orderBy(desc(post.updatedAt))
        .limit(200);
      const ids = posts.map((p) => p.id);
      const pubs =
        ids.length === 0
          ? []
          : await tx
              .select({ pub: publication, accountName: socialAccount.displayName })
              .from(publication)
              .leftJoin(socialAccount, eq(socialAccount.id, publication.socialAccountId))
              .where(inArray(publication.postId, ids));
      return { posts, pubs };
    });
    return posts.map((p) => ({
      id: p.id,
      title: p.title,
      state: p.state,
      sourceStatus: p.sourceStatus,
      externalId: p.externalId,
      externalUrl: p.externalUrl,
      requestedPlatforms: p.requestedPlatforms,
      requestedPublishLocal: p.requestedPublishLocal,
      requestedTimezone: p.requestedTimezone,
      validationErrors: p.validationErrors,
      warnings: p.warnings,
      contentHash: p.contentHash,
      aiAssisted: p.aiAssisted,
      cycleNo: p.cycleNo,
      deletedAt: p.deletedAt,
      updatedAt: p.updatedAt,
      publications: pubs
        .filter((x) => x.pub.postId === p.id)
        .map(({ pub, accountName }) => ({
          id: pub.id,
          postId: pub.postId,
          socialAccountId: pub.socialAccountId,
          accountName,
          provider: pub.provider,
          state: pub.state,
          scheduledAt: pub.scheduledAt,
          scheduledTz: pub.scheduledTz,
          scheduledLocal: pub.scheduledLocal,
          cycleNo: pub.cycleNo,
          attemptNo: pub.attemptNo,
          publishedAt: pub.publishedAt,
          delaySeconds: pub.delaySeconds,
          providerPostUrl: pub.providerPostUrl,
          deferredUntil: pub.deferredUntil,
          lastErrorCode: pub.lastErrorCode,
          lastErrorMessage: pub.lastErrorMessage,
          writebackState: pub.writebackState,
        })),
    }));
  }

  async publicationDetail(
    ctx: TenantContext,
    publicationId: string,
  ): Promise<PublicationDetail | null> {
    const dto = await this.publications.get(ctx, publicationId);
    if (!dto) return null;
    return withTenantScope(this.db, ctx.workspaceId, async (tx) => {
      const [p] = await tx
        .select({
          id: post.id,
          title: post.title,
          state: post.state,
          sourceStatus: post.sourceStatus,
          externalUrl: post.externalUrl,
          contentHash: post.contentHash,
        })
        .from(post)
        .where(and(eq(post.id, dto.postId), eq(post.workspaceId, ctx.workspaceId)))
        .limit(1);
      if (!p) return null;
      const [acc] = await tx
        .select({ name: socialAccount.displayName })
        .from(socialAccount)
        .where(eq(socialAccount.id, dto.socialAccountId))
        .limit(1);
      const audit = await listAuditForEntity(tx, ctx.workspaceId, 'publication', publicationId);
      return { publication: dto, post: p, accountName: acc?.name ?? null, audit };
    });
  }
}
