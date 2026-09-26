/**
 * Post and Publication state machines (architecture §7, domain-model §3).
 * The transition tables here are the single source of truth; `assertTransition`
 * is called by every writer before changing a state column.
 */

export const POST_STATES = [
  'draft',
  'in_review',
  'changes_requested',
  'ready',
  'scheduled',
  'publishing',
  'published',
  'partially_failed',
  'failed',
  'cancelled',
] as const;
export type PostState = (typeof POST_STATES)[number];

/** Editorial states mirrored from the source (never enforced, P6). */
export const EDITORIAL_STATES: readonly PostState[] = [
  'draft',
  'in_review',
  'changes_requested',
  'ready',
  'cancelled',
];

export const PUBLICATION_STATES = [
  'pending',
  'scheduled',
  'blocked',
  'queued',
  'publishing',
  'retry_wait',
  'published',
  'failed',
  'ambiguous',
  'cancelled',
] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

/** States in which a publication is still waiting and may be rescheduled or cancelled by the source. */
export const PUBLICATION_WAITING: readonly PublicationState[] = ['pending', 'scheduled', 'blocked'];
/** States in which the engine owns the publication; the source cannot change it. */
export const PUBLICATION_IN_FLIGHT: readonly PublicationState[] = [
  'queued',
  'publishing',
  'retry_wait',
  'ambiguous',
];
export const PUBLICATION_TERMINAL: readonly PublicationState[] = [
  'published',
  'failed',
  'cancelled',
];

const PUBLICATION_TRANSITIONS: Record<PublicationState, readonly PublicationState[]> = {
  pending: ['scheduled', 'blocked', 'cancelled'],
  scheduled: ['scheduled', 'queued', 'blocked', 'cancelled'],
  blocked: ['scheduled', 'cancelled'],
  queued: ['publishing', 'cancelled'],
  publishing: ['published', 'retry_wait', 'failed', 'ambiguous'],
  retry_wait: ['queued', 'cancelled'],
  ambiguous: ['published', 'failed'],
  // Manual retry / re-schedule from the source starts a new cycle.
  failed: ['scheduled', 'blocked'],
  cancelled: ['scheduled', 'blocked'],
  published: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly entity: 'publication' | 'post',
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`illegal ${entity} transition ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransitionPublication(from: PublicationState, to: PublicationState): boolean {
  return PUBLICATION_TRANSITIONS[from].includes(to);
}

export function assertPublicationTransition(from: PublicationState, to: PublicationState): void {
  if (!canTransitionPublication(from, to))
    throw new IllegalTransitionError('publication', from, to);
}

/**
 * Post state after `scheduled` is derived from its publications (domain-model §3.1).
 * Returns null when there are no publications (the caller keeps the mirrored state).
 */
export function derivePostState(states: readonly PublicationState[]): PostState | null {
  if (states.length === 0) return null;
  if (states.some((s) => PUBLICATION_IN_FLIGHT.includes(s))) return 'publishing';
  const live = states.filter((s) => s !== 'cancelled');
  if (live.length === 0) return 'cancelled';
  if (live.every((s) => s === 'published')) return 'published';
  if (live.every((s) => s === 'failed')) return 'failed';
  if (live.some((s) => s === 'published') && live.some((s) => s === 'failed')) {
    return 'partially_failed';
  }
  if (live.some((s) => s === 'published')) return 'published';
  // Only waiting states (scheduled/blocked/pending) remain.
  return 'scheduled';
}

/** Notion `Status` → editorial post state (PRD §4.5; `Idea` maps to draft, P7). */
export function editorialStateFromSourceStatus(status: string | null): PostState {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'idea':
    case 'draft':
    case '':
      return 'draft';
    case 'in review':
      return 'in_review';
    case 'changes requested':
      return 'changes_requested';
    case 'ready':
      return 'ready';
    case 'scheduled':
      return 'scheduled';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'draft';
  }
}
