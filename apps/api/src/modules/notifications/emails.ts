/**
 * Plain-text email bodies. They carry ids, states and reasons only — never
 * tokens or post content (security.md §7).
 */

export interface EmailContent {
  subject: string;
  text: string;
}

export function alertEmail(input: {
  kind: string;
  message: string;
  link?: string | undefined;
  environment: string;
}): EmailContent {
  return {
    subject: `[Postelyo ${input.environment}] ${input.kind}`,
    text: [
      `Alert: ${input.kind}`,
      '',
      input.message,
      ...(input.link ? ['', `Details: ${input.link}`] : []),
      '',
      'This alert repeats at most once per suppression window while the condition persists.',
      'Runbook: docs/runbook.md',
    ].join('\n'),
  };
}

export function tokenExpiringEmail(input: {
  accountName: string;
  workspaceName: string;
  expiresAt: Date;
  link: string;
}): EmailContent {
  const days = Math.max(0, Math.ceil((input.expiresAt.getTime() - Date.now()) / 86_400_000));
  return {
    subject: `Your LinkedIn connection for ${input.workspaceName} expires in ${days} day${days === 1 ? '' : 's'}`,
    text: [
      `The LinkedIn authorization for "${input.accountName}" in workspace "${input.workspaceName}" expires on ${input.expiresAt.toISOString().slice(0, 10)}.`,
      '',
      'Scheduled posts will be blocked once it expires. Reconnect now to keep publishing without interruption:',
      input.link,
    ].join('\n'),
  };
}

export function tokenExpiredEmail(input: {
  accountName: string;
  workspaceName: string;
  blockedCount: number;
  link: string;
}): EmailContent {
  return {
    subject: `Action needed: LinkedIn connection for ${input.workspaceName} has expired`,
    text: [
      `The LinkedIn authorization for "${input.accountName}" in workspace "${input.workspaceName}" has expired.`,
      input.blockedCount > 0
        ? `${input.blockedCount} scheduled post${input.blockedCount === 1 ? ' is' : 's are'} on hold and will publish after you reconnect.`
        : 'No scheduled posts are affected right now.',
      '',
      'Reconnect here:',
      input.link,
    ].join('\n'),
  };
}

export function needsReauthEmail(input: {
  accountName: string;
  workspaceName: string;
  link: string;
}): EmailContent {
  return {
    subject: `Action needed: re-authorize LinkedIn for ${input.workspaceName}`,
    text: [
      `LinkedIn rejected the authorization for "${input.accountName}" in workspace "${input.workspaceName}" while publishing.`,
      'Posts for this account are on hold until you reconnect:',
      input.link,
    ].join('\n'),
  };
}

export interface DigestRow {
  workspaceName: string;
  failed: number;
  ambiguous: number;
  needsReauth: number;
  sourcesInError: number;
  publishedLast24h: number;
}

export function digestEmail(input: { environment: string; rows: DigestRow[] }): EmailContent {
  const lines = input.rows.map(
    (r) =>
      `- ${r.workspaceName}: published ${r.publishedLast24h}, failed ${r.failed}, needs review ${r.ambiguous}, accounts needing re-auth ${r.needsReauth}, sources in error ${r.sourcesInError}`,
  );
  return {
    subject: `[Postelyo ${input.environment}] Daily digest`,
    text: [
      'Last 24 hours per workspace:',
      '',
      ...(lines.length > 0 ? lines : ['- no workspaces']),
      '',
    ].join('\n'),
  };
}
