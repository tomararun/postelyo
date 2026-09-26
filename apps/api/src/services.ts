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
import {
  FacebookProvider,
  FakeProvider,
  InstagramProvider,
  LinkedInProvider,
  XProvider,
} from '@postelyo/publishing-core';
import { xConfig } from './config/env.js';
import { createStorage, type ObjectStorage } from './infra/storage/index.js';
import { BillingService } from './modules/billing/billing.service.js';
import {
  FakeBillingGateway,
  StripeGateway,
  type BillingGateway,
} from './modules/billing/gateway.js';
import { XOAuthClient } from './modules/connections/x/x-oauth.js';
import { InvitationService } from './modules/workspaces/invitation.service.js';
import { WorkspaceDeletionService } from './modules/workspaces/workspace-deletion.service.js';
import { ReconciliationService } from './modules/publishing/reconciliation.service.js';
import { createProviderRegistry, type ProviderRegistry } from './modules/publishing/registry.js';
import { SchedulerService } from './modules/scheduling/scheduler.service.js';
import { WorkspaceService } from './modules/workspaces/workspace.service.js';
import { systemClock, type Clock } from './shared/clock.js';

export interface ServiceDeps {
  env: Pick<
    Env,
    | 'PROVIDER_MODE'
    | 'APP_BASE_URL'
    | 'ALERT_EMAIL'
    | 'NODE_ENV'
    | 'NOTION_WEBHOOK_SECRET'
    | 'X_CLIENT_ID'
    | 'X_CLIENT_SECRET'
    | 'STORAGE_DRIVER'
    | 'STORAGE_LOCAL_DIR'
    | 'S3_ENDPOINT'
    | 'S3_REGION'
    | 'S3_BUCKET'
    | 'S3_ACCESS_KEY_ID'
    | 'S3_SECRET_ACCESS_KEY'
    | 'S3_PUBLIC_BASE_URL'
    | 'STRIPE_SECRET_KEY'
    | 'STRIPE_WEBHOOK_SECRET'
    | 'STRIPE_PRICE_SOLO'
    | 'STRIPE_PRICE_TEAM'
    | 'STRIPE_PRICE_AGENCY'
  >;
  /** Overrides the storage built from env (tests). */
  storage?: ObjectStorage | undefined;
  /** Overrides the Stripe gateway (tests use the fake; PROVIDER_MODE=fake without keys does too). */
  billingGateway?: BillingGateway | undefined;
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
  invitations: InvitationService;
  deletion: WorkspaceDeletionService;
  billing: BillingService;
  vault: CredentialVault;
  socialAccounts: SocialAccountService;
  contentSources: ContentSourceService;
  providers: ProviderRegistry;
  storage: ObjectStorage;
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
  const socialAccounts = new SocialAccountService(deps.db, vault, clock);
  // X access tokens last ~2 h: the worker refreshes them before publishing.
  const xc = xConfig(deps.env);
  if (xc) {
    const xClient = new XOAuthClient({
      clientId: xc.clientId,
      clientSecret: xc.clientSecret,
      redirectUri: new URL('/oauth/x/callback', deps.env.APP_BASE_URL).toString(),
      ...fetchOpt,
    });
    socialAccounts.registerRefresher('x', async (refreshToken) => {
      const t = await xClient.refresh(refreshToken, clock.now());
      return {
        accessToken: t.accessToken,
        expiresAt: t.expiresAt,
        scopes: t.scopes,
        refreshToken: t.refreshToken,
      };
    });
  }
  const contentSources = new ContentSourceService({ db: deps.db, vault, ...fetchOpt });
  const providers =
    deps.env.PROVIDER_MODE === 'fake'
      ? createProviderRegistry([new FakeProvider()], { fallback: new FakeProvider() })
      : createProviderRegistry([
          new LinkedInProvider(fetchOpt),
          new XProvider(fetchOpt),
          new FacebookProvider(fetchOpt),
          new InstagramProvider(fetchOpt),
        ]);
  const storage = deps.storage ?? createStorage(deps.env);
  const media = new MediaService({
    db: deps.db,
    contentSources,
    storage,
    clock,
    logger: deps.logger,
    ...fetchOpt,
  });
  // Billing (Phase 3): Stripe when keys are present, otherwise the fake gateway in fake
  // provider mode (development) and nothing in live mode (billing pages read-only).
  const gateway =
    deps.billingGateway ??
    (deps.env.STRIPE_SECRET_KEY
      ? new StripeGateway({ secretKey: deps.env.STRIPE_SECRET_KEY })
      : deps.env.PROVIDER_MODE === 'fake'
        ? new FakeBillingGateway()
        : null);
  const billing = new BillingService({
    db: deps.db,
    gateway,
    config: {
      prices: {
        ...(deps.env.STRIPE_PRICE_SOLO ? { solo: deps.env.STRIPE_PRICE_SOLO } : {}),
        ...(deps.env.STRIPE_PRICE_TEAM ? { team: deps.env.STRIPE_PRICE_TEAM } : {}),
        ...(deps.env.STRIPE_PRICE_AGENCY ? { agency: deps.env.STRIPE_PRICE_AGENCY } : {}),
      },
      webhookSecret: deps.env.STRIPE_WEBHOOK_SECRET ?? null,
      appBaseUrl: deps.env.APP_BASE_URL,
    },
    clock,
    logger: deps.logger,
  });
  socialAccounts.registerCapacityGuard((workspaceId, adding) =>
    billing.assertAccountCapacity(workspaceId, adding),
  );
  const ingest = new PostIngestService({
    db: deps.db,
    providers,
    media,
    clock,
    logger: deps.logger,
    postLimit: async (workspaceId) => {
      const r = await billing.postLimitReached(workspaceId);
      return r.reached
        ? `The ${r.plan} plan allows ${r.limit} published posts per month and ${r.used} were already published. Upgrade the plan on the Billing page to schedule more this month.`
        : null;
    },
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
  const invitations = new InvitationService({
    db: deps.db,
    mailer: deps.mailer,
    billing,
    clock,
    appBaseUrl: deps.env.APP_BASE_URL,
  });
  const deletion = new WorkspaceDeletionService({
    db: deps.db,
    enqueue: deps.enqueue,
    providers,
    socialAccounts,
    clock,
    logger: deps.logger,
  });

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
    invitations,
    deletion,
    billing,
    vault,
    socialAccounts,
    contentSources,
    providers,
    storage,
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
