import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { loadEnv } from '../config/env.js';
import { EnvKeyProvider } from '../infra/crypto/key-provider.js';
import { createDb } from '../infra/db/client.js';
import { post, publication, socialAccount, user } from '../infra/db/schema.js';
import { CredentialVault } from '../modules/connections/credential-vault.js';
import { WorkspaceService } from '../modules/workspaces/workspace.service.js';
import { uuidv7 } from '../shared/ids.js';

/**
 * Local development seed (architecture §17). Creates a user, a workspace, a
 * fake LinkedIn account and a due publication so the worker publishes through
 * the FakeProvider immediately. Refuses to run in production or live mode.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  if (env.NODE_ENV === 'production' || env.PROVIDER_MODE !== 'fake') {
    console.error('seed only runs with NODE_ENV!=production and PROVIDER_MODE=fake');
    process.exit(2);
  }
  const { values } = parseArgs({
    options: { email: { type: 'string', default: 'dev@example.com' } },
  });
  const email = values.email.toLowerCase();
  const database = createDb(env.DATABASE_URL, { max: 2 });
  const db = database.db;
  const logger = pino({ level: 'warn' });
  try {
    let [u] = await db.select().from(user).where(eq(user.email, email)).limit(1);
    if (!u) {
      [u] = await db
        .insert(user)
        .values({ id: uuidv7(), email, name: email.split('@')[0] ?? 'dev', emailVerified: true })
        .returning();
    }
    const workspaces = new WorkspaceService(db);
    const ws = await workspaces.ensureDefaultWorkspace({ id: u!.id, email }, 'seed');

    const vault = new CredentialVault(db, EnvKeyProvider.fromEnv(env.ENCRYPTION_KEYS));
    let [acc] = await db
      .select()
      .from(socialAccount)
      .where(eq(socialAccount.workspaceId, ws.id))
      .limit(1);
    if (!acc) {
      const id = uuidv7();
      [acc] = await db
        .insert(socialAccount)
        .values({
          id,
          workspaceId: ws.id,
          provider: 'linkedin',
          accountType: 'member',
          providerAccountId: 'seed-member',
          displayName: 'Seed Member (fake)',
          status: 'active',
          scopes: ['w_member_social'],
          accessTokenEnc: vault.seal(
            { entityType: 'social_account', entityId: id, column: 'access_token' },
            'fake-token',
          ),
          credentialKeyId: vault.currentKeyId,
          tokenExpiresAt: new Date(Date.now() + 60 * 24 * 3600_000),
          connectedByUserId: u!.id,
        })
        .returning();
    }

    const postId = uuidv7();
    const now = new Date();
    await db.insert(post).values({
      id: postId,
      workspaceId: ws.id,
      title: `Seed post ${now.toISOString()}`,
      state: 'scheduled',
      content: {
        v: 1,
        blocks: [
          {
            type: 'paragraph',
            inlines: [{ t: 'text', text: `Hello from the seed at ${now.toISOString()} #postelyo` }],
          },
        ],
        media: [],
        meta: { source: 'native' },
      },
      contentHash: uuidv7().replace(/-/g, ''),
      requestedPlatforms: ['LinkedIn'],
    });
    const pubId = uuidv7();
    await db.insert(publication).values({
      id: pubId,
      workspaceId: ws.id,
      postId,
      socialAccountId: acc!.id,
      provider: 'linkedin',
      state: 'scheduled',
      scheduledAt: now,
      scheduledTz: ws.defaultTimezone,
      scheduledLocal: now.toISOString().slice(0, 16),
    });

    console.log(`Seeded workspace "${ws.name}" (${ws.id}) for ${email}.`);
    console.log(
      `Publication ${pubId} is due now; start the worker and watch it publish via the FakeProvider.`,
    );
    console.log(
      `Sign in at ${env.APP_BASE_URL}/sign-in with ${email} (magic link appears in the api log).`,
    );
    logger.flush();
  } finally {
    await database.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
