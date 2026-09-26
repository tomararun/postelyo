import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  PUBLICATION_STATES,
  assertPublicationTransition,
  canTransitionPublication,
  derivePostState,
  editorialStateFromSourceStatus,
} from './state-machine.js';

describe('publication transitions', () => {
  it('allows the documented transitions', () => {
    const allowed: [string, string][] = [
      ['pending', 'scheduled'],
      ['pending', 'blocked'],
      ['scheduled', 'queued'],
      ['scheduled', 'scheduled'],
      ['scheduled', 'cancelled'],
      ['blocked', 'scheduled'],
      ['queued', 'publishing'],
      ['queued', 'cancelled'],
      ['publishing', 'published'],
      ['publishing', 'retry_wait'],
      ['publishing', 'failed'],
      ['publishing', 'ambiguous'],
      ['retry_wait', 'queued'],
      ['ambiguous', 'published'],
      ['ambiguous', 'failed'],
      ['failed', 'scheduled'],
      ['cancelled', 'scheduled'],
    ];
    for (const [from, to] of allowed) {
      expect(canTransitionPublication(from as never, to as never), `${from}→${to}`).toBe(true);
    }
  });

  it('forbids anything that could double-publish or resurrect a published row', () => {
    const forbidden: [string, string][] = [
      ['published', 'scheduled'],
      ['published', 'queued'],
      ['published', 'publishing'],
      ['ambiguous', 'queued'],
      ['ambiguous', 'scheduled'],
      ['publishing', 'queued'],
      ['publishing', 'scheduled'],
      ['scheduled', 'publishing'],
      ['pending', 'queued'],
      ['queued', 'scheduled'],
    ];
    for (const [from, to] of forbidden) {
      expect(canTransitionPublication(from as never, to as never), `${from}→${to}`).toBe(false);
    }
    expect(() => assertPublicationTransition('published', 'queued')).toThrow(
      IllegalTransitionError,
    );
  });

  it('published is terminal', () => {
    for (const to of PUBLICATION_STATES) {
      expect(canTransitionPublication('published', to)).toBe(false);
    }
  });
});

describe('derivePostState', () => {
  it('derives from publication states', () => {
    expect(derivePostState([])).toBeNull();
    expect(derivePostState(['scheduled'])).toBe('scheduled');
    expect(derivePostState(['scheduled', 'blocked'])).toBe('scheduled');
    expect(derivePostState(['queued'])).toBe('publishing');
    expect(derivePostState(['published', 'retry_wait'])).toBe('publishing');
    expect(derivePostState(['published'])).toBe('published');
    expect(derivePostState(['published', 'cancelled'])).toBe('published');
    expect(derivePostState(['failed'])).toBe('failed');
    expect(derivePostState(['published', 'failed'])).toBe('partially_failed');
    expect(derivePostState(['cancelled'])).toBe('cancelled');
  });
});

describe('editorialStateFromSourceStatus', () => {
  it('maps the Notion workflow including Idea → draft (P7) and unknown → draft', () => {
    expect(editorialStateFromSourceStatus('Idea')).toBe('draft');
    expect(editorialStateFromSourceStatus('Draft')).toBe('draft');
    expect(editorialStateFromSourceStatus('In review')).toBe('in_review');
    expect(editorialStateFromSourceStatus('changes requested')).toBe('changes_requested');
    expect(editorialStateFromSourceStatus('Ready')).toBe('ready');
    expect(editorialStateFromSourceStatus('Scheduled')).toBe('scheduled');
    expect(editorialStateFromSourceStatus('Cancelled')).toBe('cancelled');
    expect(editorialStateFromSourceStatus('Something else')).toBe('draft');
    expect(editorialStateFromSourceStatus(null)).toBe('draft');
  });
});
