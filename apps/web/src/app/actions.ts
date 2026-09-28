'use server';

import { redirect } from 'next/navigation';
import { ApiError, api, errorMessage } from '@/lib/api';

/** Server actions shared across pages (Phase 3). Each one calls the api with the visitor's cookie. */

/** Text fields only; files or missing keys fall back. */
const field = (formData: FormData, key: string, fallback = ''): string => {
  const v = formData.get(key);
  return typeof v === 'string' ? v : fallback;
};

const back = (path: string, params: Record<string, string>) =>
  `${path}?${new URLSearchParams(params).toString()}`;

export async function signOut(): Promise<void> {
  await api('/api/auth/sign-out', { method: 'POST', body: {}, allow: [200, 401] });
  redirect('/sign-in');
}

export async function requestMagicLink(formData: FormData): Promise<void> {
  const email = field(formData, 'email', '').trim().toLowerCase();
  const next = field(formData, 'next', '/');
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  // Phase 7: domains with single sign-on go to the identity provider instead of email.
  let ssoStart: string | null = null;
  try {
    const lookup = await api<{ sso: boolean }>(
      `/api/auth/sso/lookup?email=${encodeURIComponent(email)}`,
    );
    if (lookup.sso) {
      ssoStart = `/api/auth/sso/start?email=${encodeURIComponent(email)}&next=${encodeURIComponent(safeNext)}`;
    }
  } catch (err) {
    // A failed lookup falls back to the magic link.
    if (!(err instanceof ApiError)) throw err;
  }
  if (ssoStart) redirect(ssoStart);
  try {
    await api('/api/auth/sign-in/magic-link', {
      method: 'POST',
      body: { email, callbackURL: safeNext },
    });
  } catch (err) {
    redirect(back('/sign-in', { error: errorMessage(err), next: safeNext }));
  }
  redirect(back('/sign-in', { sent: email, next: safeNext }));
}

export async function createWorkspace(formData: FormData): Promise<void> {
  const name = field(formData, 'name', '').trim();
  const defaultTimezone = field(formData, 'defaultTimezone', 'UTC').trim() || 'UTC';
  let id: string;
  try {
    const ws = await api<{ id: string }>('/v1/workspaces', {
      method: 'POST',
      body: { name, defaultTimezone },
    });
    id = ws.id;
  } catch (err) {
    redirect(back('/', { error: errorMessage(err) }));
  }
  redirect(`/w/${id}/connections`);
}

export async function updateWorkspace(workspaceId: string, formData: FormData): Promise<void> {
  const text = (k: string) => {
    const v = formData.get(k);
    return typeof v === 'string' ? v.trim() : undefined;
  };
  const emailOrNull = (k: string) => {
    const v = text(k);
    return v === undefined ? undefined : v === '' ? null : v;
  };
  const cap = text('dailyCapPerAccount');
  const body: Record<string, unknown> = {
    ...(text('name') !== undefined ? { name: text('name') } : {}),
    ...(text('defaultTimezone') ? { defaultTimezone: text('defaultTimezone') } : {}),
    ...(text('defaultPublishTime') ? { defaultPublishTime: text('defaultPublishTime') } : {}),
    ...(cap !== undefined ? { dailyCapPerAccount: cap === '' ? null : Number(cap) } : {}),
    ...(formData.has('settingsForm')
      ? {
          notionWebhooks: formData.get('notionWebhooks') === 'on',
          providers: {
            x: formData.get('provider_x') === 'on',
            facebook: formData.get('provider_facebook') === 'on',
            instagram: formData.get('provider_instagram') === 'on',
          },
          notificationEmail: emailOrNull('notificationEmail'),
          alertCopyEmail: emailOrNull('alertCopyEmail'),
        }
      : {}),
  };
  // Phase 4 forms: each replaces its structured setting wholesale.
  if (formData.has('linksForm')) {
    const utm = {
      ...(text('utmSource') ? { source: text('utmSource') } : {}),
      ...(text('utmMedium') ? { medium: text('utmMedium') } : {}),
      ...(text('utmCampaign') ? { campaign: text('utmCampaign') } : {}),
    };
    const shorten = formData.get('shorten') === 'on';
    body['links'] = Object.keys(utm).length === 0 && !shorten ? null : { utm, shorten };
  }
  if (formData.has('evergreenForm')) {
    const slots: { weekday: number; time: string }[] = [];
    for (let i = 0; i < 7; i++) {
      const weekday = Number(text(`slot_${i}_weekday`) ?? '');
      const time = text(`slot_${i}_time`) ?? '';
      if (weekday >= 1 && weekday <= 7 && /^\d{2}:\d{2}$/.test(time)) slots.push({ weekday, time });
    }
    const gap = Number(text('minGapDays') ?? '');
    body['evergreen'] =
      slots.length === 0 ? null : { slots, ...(gap >= 1 ? { minGapDays: gap } : {}) };
  }
  if (formData.has('approvalForm')) {
    const required = formData.get('approvalRequired') === 'on';
    const reviewers = formData.getAll('reviewer').filter((v): v is string => typeof v === 'string');
    body['approval'] = required || reviewers.length > 0 ? { required, reviewers } : null;
  }
  const path = `/w/${workspaceId}/settings`;
  try {
    await api(`/v1/workspaces/${workspaceId}`, { method: 'PATCH', body });
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(back(path, { notice: 'Settings saved.' }));
}

export async function updateAiSettings(workspaceId: string, formData: FormData): Promise<void> {
  const path = `/w/${workspaceId}/ai`;
  const budget = field(formData, 'monthlyTokenBudget').trim();
  const model = field(formData, 'model').trim();
  const voice = field(formData, 'voice').trim();
  const banned = field(formData, 'bannedPhrases')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  try {
    await api(`/v1/workspaces/${workspaceId}`, {
      method: 'PATCH',
      body: {
        ai: {
          enabled: formData.get('enabled') === 'on',
          ...(voice ? { voice } : {}),
          ...(model ? { model } : {}),
          bannedPhrases: banned,
          ...(budget ? { monthlyTokenBudget: Number(budget) } : {}),
        },
      },
    });
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(back(path, { notice: 'AI settings saved.' }));
}

export async function setWeeklyReport(workspaceId: string, formData: FormData): Promise<void> {
  const path = `/w/${workspaceId}/settings`;
  try {
    await api(`/v1/workspaces/${workspaceId}/members/me`, {
      method: 'PATCH',
      body: { weeklyReport: formData.get('weeklyReport') === 'on' },
    });
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(back(path, { notice: 'Preference saved.' }));
}

export async function approvePost(workspaceId: string, postId: string): Promise<void> {
  const path = `/w/${workspaceId}/posts`;
  try {
    await api(`/v1/workspaces/${workspaceId}/posts/${postId}/approve`, {
      method: 'POST',
      body: {},
    });
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(back(path, { notice: 'Approved. Notion updates within a minute.' }));
}

export async function revokeApproval(workspaceId: string, postId: string): Promise<void> {
  const path = `/w/${workspaceId}/posts`;
  try {
    await api(`/v1/workspaces/${workspaceId}/posts/${postId}/approvals`, { method: 'DELETE' });
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(back(path, { notice: 'Approval revoked.' }));
}

export async function deleteWorkspace(workspaceId: string, formData: FormData): Promise<void> {
  if (field(formData, 'confirm', '') !== 'DELETE') {
    redirect(back(`/w/${workspaceId}/settings`, { error: 'Type DELETE to confirm.' }));
  }
  await api(`/v1/workspaces/${workspaceId}`, { method: 'DELETE' });
  redirect('/?notice=' + encodeURIComponent('Workspace deletion started.'));
}

export async function disconnectAccount(workspaceId: string, accountId: string): Promise<void> {
  const path = `/w/${workspaceId}/connections`;
  try {
    await api(`/v1/workspaces/${workspaceId}/social-accounts/${accountId}`, { method: 'DELETE' });
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(back(path, { notice: 'Account disconnected.' }));
}

export async function connectNotionToken(workspaceId: string, formData: FormData): Promise<void> {
  const path = `/w/${workspaceId}/connections`;
  try {
    await api(`/v1/workspaces/${workspaceId}/content-sources/notion`, {
      method: 'POST',
      body: { token: field(formData, 'token', ''), database: field(formData, 'database', '') },
    });
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(back(path, { notice: 'Notion database connected.' }));
}

export async function syncSource(workspaceId: string, sourceId: string): Promise<void> {
  const path = `/w/${workspaceId}/connections`;
  try {
    const s = await api<{ pagesSeen: number; errors: string[] }>(
      `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/sync`,
      { method: 'POST', body: {}, allow: [207] },
    );
    redirect(
      back(
        path,
        s.errors.length > 0
          ? { error: s.errors.join('; ') }
          : { notice: `Synced ${s.pagesSeen} page(s).` },
      ),
    );
  } catch (err) {
    if (isRedirect(err)) throw err;
    redirect(back(path, { error: errorMessage(err) }));
  }
}

export async function disconnectSource(workspaceId: string, sourceId: string): Promise<void> {
  await api(`/v1/workspaces/${workspaceId}/content-sources/${sourceId}`, {
    method: 'DELETE',
    allow: [404],
  });
  redirect(back(`/w/${workspaceId}/connections`, { notice: 'Notion disconnected.' }));
}

export async function completeSetup(
  workspaceId: string,
  sourceId: string,
  formData: FormData,
): Promise<void> {
  const mode = field(formData, 'mode', '');
  const body =
    mode === 'create'
      ? {
          mode,
          parentPageId: field(formData, 'parentPageId', ''),
          title: field(formData, 'title') || 'Postelyo Content',
        }
      : {
          mode: 'existing',
          databaseId: field(formData, 'databaseId', ''),
          ...(field(formData, 'ideasDatabaseId')
            ? { ideasDatabaseId: field(formData, 'ideasDatabaseId') }
            : {}),
        };
  const path = `/w/${workspaceId}/setup?source=${sourceId}`;
  try {
    await api(`/v1/workspaces/${workspaceId}/content-sources/${sourceId}/setup`, {
      method: 'POST',
      body,
    });
  } catch (err) {
    redirect(`${path}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(
    back(`/w/${workspaceId}/connections`, {
      notice: 'Notion is set up. Add a page and set Status to Scheduled to test.',
    }),
  );
}

export async function invite(workspaceId: string, formData: FormData): Promise<void> {
  const path = `/w/${workspaceId}/team`;
  try {
    await api(`/v1/workspaces/${workspaceId}/invitations`, {
      method: 'POST',
      body: { email: field(formData, 'email', ''), role: field(formData, 'role', 'editor') },
    });
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(back(path, { notice: 'Invitation sent.' }));
}

export async function revokeInvitation(workspaceId: string, invitationId: string): Promise<void> {
  await api(`/v1/workspaces/${workspaceId}/invitations/${invitationId}`, {
    method: 'DELETE',
    allow: [404],
  });
  redirect(back(`/w/${workspaceId}/team`, { notice: 'Invitation revoked.' }));
}

export async function setRole(
  workspaceId: string,
  userId: string,
  formData: FormData,
): Promise<void> {
  const path = `/w/${workspaceId}/team`;
  try {
    await api(`/v1/workspaces/${workspaceId}/members/${userId}`, {
      method: 'PATCH',
      body: { role: field(formData, 'role', 'viewer') },
    });
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(back(path, { notice: 'Role updated.' }));
}

export async function removeMember(
  workspaceId: string,
  userId: string,
  self: boolean,
): Promise<void> {
  const path = `/w/${workspaceId}/team`;
  try {
    await api(`/v1/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' });
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(self ? '/' : back(path, { notice: 'Member removed.' }));
}

export async function acceptInvitation(token: string): Promise<void> {
  let workspaceId: string;
  try {
    const r = await api<{ workspaceId: string }>(
      `/v1/invitations/${encodeURIComponent(token)}/accept`,
      {
        method: 'POST',
        body: {},
      },
    );
    workspaceId = r.workspaceId;
  } catch (err) {
    redirect(
      `/invitations/${encodeURIComponent(token)}?error=${encodeURIComponent(errorMessage(err))}`,
    );
  }
  redirect(`/w/${workspaceId}/posts`);
}

export async function startCheckout(workspaceId: string, formData: FormData): Promise<void> {
  const path = `/w/${workspaceId}/billing`;
  let url: string;
  try {
    const r = await api<{ url: string }>(`/v1/workspaces/${workspaceId}/billing/checkout`, {
      method: 'POST',
      body: { plan: field(formData, 'plan', '') },
    });
    url = r.url;
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(url);
}

export async function openPortal(workspaceId: string): Promise<void> {
  const path = `/w/${workspaceId}/billing`;
  let url: string;
  try {
    const r = await api<{ url: string }>(`/v1/workspaces/${workspaceId}/billing/portal`, {
      method: 'POST',
      body: {},
    });
    url = r.url;
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(url);
}

export async function retryPublication(workspaceId: string, publicationId: string): Promise<void> {
  const path = `/w/${workspaceId}/publications/${publicationId}`;
  try {
    await api(`/v1/workspaces/${workspaceId}/publications/${publicationId}/retry`, {
      method: 'POST',
      body: {},
    });
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(back(path, { notice: 'Retry scheduled; the worker publishes within a minute.' }));
}

export async function resolvePublication(
  workspaceId: string,
  publicationId: string,
  formData: FormData,
): Promise<void> {
  const path = `/w/${workspaceId}/publications/${publicationId}`;
  const url = field(formData, 'providerPostUrl', '').trim();
  try {
    await api(`/v1/workspaces/${workspaceId}/publications/${publicationId}/resolve`, {
      method: 'POST',
      body: {
        outcome: field(formData, 'outcome', 'failed'),
        ...(url ? { providerPostUrl: url, providerPostId: url } : {}),
      },
    });
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(back(path, { notice: 'Resolved.' }));
}

/** Next signals `redirect()` with a thrown control-flow error; never swallow it. */
function isRedirect(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'digest' in err &&
    String(err.digest).startsWith('NEXT_REDIRECT')
  );
}

// --- Phase 7: developers and security -------------------------------------------

export interface SecretResult {
  secret?: string;
  label?: string;
  error?: string;
}

/** Creates an API key; the secret is returned to the client component and shown once. */
export async function createApiKey(
  workspaceId: string,
  _prev: SecretResult,
  formData: FormData,
): Promise<SecretResult> {
  const scopes = ['read', ...(formData.get('write') === 'on' ? ['write'] : [])];
  const days = field(formData, 'expiresInDays').trim();
  try {
    const res = await api<{ key: { prefix: string }; secret: string }>(
      `/v1/workspaces/${workspaceId}/api-keys`,
      {
        method: 'POST',
        body: {
          name: field(formData, 'name').trim(),
          scopes,
          ...(days ? { expiresInDays: Number(days) } : {}),
        },
      },
    );
    return { secret: res.secret, label: `API key ${res.key.prefix}…` };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function revokeApiKey(workspaceId: string, keyId: string): Promise<void> {
  const path = `/w/${workspaceId}/developers`;
  try {
    await api(`/v1/workspaces/${workspaceId}/api-keys/${keyId}`, { method: 'DELETE' });
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(back(path, { notice: 'API key revoked.' }));
}

/** Creates a webhook endpoint; the signing secret is returned to the client component and shown once. */
export async function createWebhook(
  workspaceId: string,
  _prev: SecretResult,
  formData: FormData,
): Promise<SecretResult> {
  const events = formData
    .getAll('events')
    .map((e) => (typeof e === 'string' ? e : ''))
    .filter((e) => e.length > 0);
  try {
    const res = await api<{ endpoint: { url: string }; secret: string }>(
      `/v1/workspaces/${workspaceId}/webhooks`,
      {
        method: 'POST',
        body: {
          url: field(formData, 'url').trim(),
          description: field(formData, 'description').trim(),
          events,
        },
      },
    );
    return { secret: res.secret, label: `Signing secret for ${res.endpoint.url}` };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function webhookAction(
  workspaceId: string,
  endpointId: string,
  formData: FormData,
): Promise<void> {
  const path = `/w/${workspaceId}/developers`;
  const op = field(formData, 'op');
  let notice = 'Webhook updated.';
  try {
    if (op === 'delete') {
      await api(`/v1/workspaces/${workspaceId}/webhooks/${endpointId}`, { method: 'DELETE' });
      notice = 'Webhook deleted.';
    } else if (op === 'test') {
      const d = await api<{
        status: string;
        lastStatusCode: number | null;
        lastError: string | null;
      }>(`/v1/workspaces/${workspaceId}/webhooks/${endpointId}/test`, {
        method: 'POST',
        body: {},
      });
      notice = `Test delivery ${d.status}${d.lastStatusCode ? ` (HTTP ${d.lastStatusCode})` : ''}${d.lastError ? `: ${d.lastError}` : ''}.`;
    } else if (op === 'enable' || op === 'disable') {
      await api(`/v1/workspaces/${workspaceId}/webhooks/${endpointId}`, {
        method: 'PATCH',
        body: { enabled: op === 'enable' },
      });
    }
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(back(path, { notice }));
}

export async function saveSso(workspaceId: string, formData: FormData): Promise<void> {
  const path = `/w/${workspaceId}/security`;
  const secret = field(formData, 'clientSecret').trim();
  const remove = formData.get('op') === 'remove';
  try {
    if (remove) {
      await api(`/v1/workspaces/${workspaceId}/sso`, { method: 'DELETE' });
    } else {
      await api(`/v1/workspaces/${workspaceId}/sso`, {
        method: 'PUT',
        body: {
          issuer: field(formData, 'issuer').trim(),
          clientId: field(formData, 'clientId').trim(),
          ...(secret ? { clientSecret: secret } : {}),
          emailDomain: field(formData, 'emailDomain').trim(),
          defaultRole: field(formData, 'defaultRole', 'viewer'),
          enabled: formData.get('enabled') === 'on',
        },
      });
    }
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(back(path, { notice: remove ? 'Single sign-on removed.' : 'Single sign-on saved.' }));
}

export async function tenantKeyAction(workspaceId: string, formData: FormData): Promise<void> {
  const path = `/w/${workspaceId}/security`;
  const op = field(formData, 'op') === 'rotate' ? 'rotate' : 'enable';
  try {
    await api(`/v1/workspaces/${workspaceId}/tenant-keys/${op}`, { method: 'POST', body: {} });
  } catch (err) {
    redirect(back(path, { error: errorMessage(err) }));
  }
  redirect(
    back(path, {
      notice: op === 'rotate' ? 'Workspace key rotated.' : 'Per-workspace encryption enabled.',
    }),
  );
}
