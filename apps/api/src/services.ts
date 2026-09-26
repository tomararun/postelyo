import type { Env } from './config/env.js';
import type { Db } from './infra/db/client.js';
import type { KeyProvider } from './infra/crypto/key-provider.js';
import type { Logger } from './infra/logger.js';
import type { Mailer } from './infra/mailer.js';
import { CredentialVault } from './modules/connections/credential-vault.js';
import { SocialAccountService } from './modules/connections/social-account.service.js';
import { ContentSourceService } from './modules/content-sources/content-source.service.js';
import { NotionSyncService } from './modules/content-sources/notion/notion-sync.service.js';
import { NotionWebhookService } from './modules/content-sources/notion/notion-webhook.service.js';
import { ResultWritebackService } from './modules/content-sources/notion/result-writeback.service.js';
import { MediaService } from './modules/media/media.service.js';
import { NotificationTargets } from './modules/notifications/targets.js';
import { AlertService } from './modules/ops/alerts.service.js';
import { DigestService } from './modules/ops/digest.service.js';
import { HeartbeatService } from './modules/ops/heartbeat.service.js';
import { MetricsService } from './modules/ops/metrics.service.js';
import { TokenExpiryService } from './modules/ops/token-expiry.service.js';
import { PostIngestService } from './modules/posts/post-ingest.service.js';
import { PostQueryService } from './modules/posts/post-query.service.js';
import { PublishEngine } from './modules/publishing/engine.js';
import type { JobEnqueuer } from './modules/publishing/jobs.js';
import { PublicationService } from './modules/publishing/publication.service.js';
import { FakeProvider } from './modules/publishing/providers/fake/fake-provider.js';
import { LinkedInProvider } from './modules/publishing/providers/linkedin/linkedin-provider.js';
import { ReconciliationService } from './modules/publishing/reconciliation.service.js';
import { createProviderRegistry, type ProviderRegistry } from './modules/publishing/registry.js';
import { SchedulerService } from './modules/scheduling/scheduler.service.js';
import { WorkspaceService } from './modules/workspaces/workspace.service.js';
import { systemClock, type Clock } from './shared/clock.js';

export interface ServiceDeps {
  env: Pick<
    Env,
    'PROVIDER_MODE' | 'APP_BASE_URL' | 'ALERT_EMAIL' | 'NODE_ENV' | 'NOTION_WEBHOOK_SECRET'
  >;
  db: Db;
  logger: Logger;
  keyProvider: KeyProvider;
  mailer: Mailer;
  enqueue: JobEnqueuer;
  /** Identifies this process as lease owner; hostname-pid in production. */
  workerId: string;
  fetchImpl?: typeof fetch | undefined;
  clock?: Clock | undefined;
  random?: (() => number) | undefined;
}

export interface Services {
  workspaces: WorkspaceService;
  vault: CredentialVault;
  socialAccounts: SocialAccountService;
  contentSources: ContentSourceService;
  providers: ProviderRegistry;
  media: MediaService;
  ingest: PostIngestService;
  notionSync: NotionSyncService;
  scheduler: SchedulerService;
  engine: PublishEngine;
  resultWriteback: ResultWritebackService;
  publications: PublicationService;
  reconciliation: ReconciliationService;
  notionWebhooks: NotionWebhookService;
  postQuery: PostQueryService;
  targets: NotificationTargets;
  heartbeat: HeartbeatService;
  alerts: AlertService;
  tokenExpiry: TokenExpiryService;
  digest: DigestService;
  metrics: MetricsService;
  enqueue: JobEnqueuer;
  clock: Clock;
}

/** One composition root shared by the api and worker roles (architecture §2.1). */
export function buildServices(deps: ServiceDeps): Services {
  const clock = deps.clock ?? systemClock;
  const fetchOpt = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  const workspaces = new WorkspaceService(deps.db);
  const vault = new CredentialVault(deps.db, deps.keyProvider);
  const socialAccounts = new SocialAccountService(deps.db, vault);
  const contentSources = new ContentSourceService({ db: deps.db, vault, ...fetchOpt });
  const providers =
    deps.env.PROVIDER_MODE === 'fake'
      ? createProviderRegistry([new FakeProvider()], { fallback: new FakeProvider() })
      : createProviderRegistry([new LinkedInProvider(fetchOpt)]);
  const media = new MediaService({
    db: deps.db,
    contentSources,
    clock,
    logger: deps.logger,
    ...fetchOpt,
  });
  const ingest = new PostIngestService({
    db: deps.db,
    providers,
    media,
    clock,
    logger: deps.logger,
  });
  const notionSync = new NotionSyncService({
    db: deps.db,
    contentSources,
    ingest,
    logger: deps.logger,
    clock,
    ...fetchOpt,
  });
  const scheduler = new SchedulerService({
    db: deps.db,
    enqueue: deps.enqueue,
    clock,
    logger: deps.logger,
  });
  const engine = new PublishEngine({
    db: deps.db,
    providers,
    socialAccounts,
    media,
    enqueue: deps.enqueue,
    clock,
    logger: deps.logger,
    workerId: deps.workerId,
    ...(deps.random ? { random: deps.random } : {}),
  });
  const resultWriteback = new ResultWritebackService({
    db: deps.db,
    contentSources,
    clock,
    logger: deps.logger,
    ...fetchOpt,
  });
  const publications = new PublicationService(deps.db, deps.enqueue, clock);
  const reconciliation = new ReconciliationService({
    db: deps.db,
    providers,
    socialAccounts,
    publications,
    clock,
    logger: deps.logger,
  });
  const notionWebhooks = new NotionWebhookService({
    db: deps.db,
    enqueue: deps.enqueue,
    clock,
    logger: deps.logger,
    secret: deps.env.NOTION_WEBHOOK_SECRET ?? null,
  });
  const postQuery = new PostQueryService(deps.db, publications);

  const targets = new NotificationTargets(deps.db, deps.env.ALERT_EMAIL ?? null);
  const heartbeat = new HeartbeatService(deps.db, clock);
  const environment = deps.env.NODE_ENV;
  const alerts = new AlertService({
    db: deps.db,
    mailer: deps.mailer,
    targets,
    heartbeat,
    clock,
    logger: deps.logger,
    appBaseUrl: deps.env.APP_BASE_URL,
    environment,
  });
  const tokenExpiry = new TokenExpiryService({
    db: deps.db,
    mailer: deps.mailer,
    targets,
    clock,
    logger: deps.logger,
    appBaseUrl: deps.env.APP_BASE_URL,
  });
  const digest = new DigestService({
    db: deps.db,
    mailer: deps.mailer,
    targets,
    alerts,
    clock,
    environment,
  });
  const metrics = new MetricsService(deps.db, heartbeat, clock);

  return {
    workspaces,
    vault,
    socialAccounts,
    contentSources,
    providers,
    media,
    ingest,
    notionSync,
    scheduler,
    engine,
    resultWriteback,
    publications,
    reconciliation,
    notionWebhooks,
    postQuery,
    targets,
    heartbeat,
    alerts,
    tokenExpiry,
    digest,
    metrics,
    enqueue: deps.enqueue,
    clock,
  };
}
