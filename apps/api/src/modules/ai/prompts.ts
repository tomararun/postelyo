/**
 * Phase 6 prompts. Stable instructions go in `system` (cached); everything
 * that changes per request goes in `prompt`. Outputs that the code must
 * parse are requested as JSON with a single, explicit shape.
 */

export const PLATFORM_LIMITS: Record<string, { name: string; maxChars: number; hints: string }> = {
  linkedin: {
    name: 'LinkedIn',
    maxChars: 3000,
    hints:
      'Professional but human. Short paragraphs, a clear opening line, up to three hashtags at the end.',
  },
  x: {
    name: 'X',
    maxChars: 280,
    hints: 'One tight message under 280 characters (links count as 23). At most two hashtags.',
  },
  facebook: {
    name: 'Facebook Page',
    maxChars: 2000,
    hints: 'Conversational. One or two short paragraphs, a question or call to action.',
  },
  instagram: {
    name: 'Instagram',
    maxChars: 2200,
    hints:
      'Caption style: strong first line, line breaks between thoughts, hashtags on the last line (up to ten).',
  },
};

const BASE_RULES = `You are Postelyo's writing assistant. You adapt and draft social media posts for a team that plans content in Notion.
Rules:
- Keep the author's meaning, facts, names and links exactly; never invent facts, numbers or quotes.
- Write in the same language as the source text.
- Respect every length limit given; count characters carefully.
- No preamble, no explanations, no markdown headings. Return only what is asked.
- If the source is unusable (empty, or asks for something you should not write), return an empty result rather than guessing.`;

export function variantsSystem(): string {
  return BASE_RULES;
}

export function variantsPrompt(input: {
  title: string;
  sourceText: string;
  platforms: string[];
  hashtags: string[];
  bestTimes: string | null;
}): string {
  const specs = input.platforms
    .map((p) => {
      const l = PLATFORM_LIMITS[p];
      return l
        ? `- ${p}: ${l.name}, max ${l.maxChars} characters. ${l.hints}`
        : `- ${p}: max 2000 characters.`;
    })
    .join('\n');
  return `Adapt the source text into one variant per platform.
platforms: ${input.platforms.join(', ')}
${specs}
${input.hashtags.length > 0 ? `Hashtags that performed well for this team (use only when they fit): ${input.hashtags.map((h) => `#${h}`).join(' ')}` : ''}
${input.bestTimes ? `Best publishing times for this team (for your information only): ${input.bestTimes}` : ''}

TITLE: ${input.title}
SOURCE TEXT:
${input.sourceText}

OUTPUT: a JSON object whose keys are exactly the platform ids listed above and whose values are the variant texts. Plain text values with "\\n" for line breaks. No other keys, no markdown fences.`;
}

export function draftSystem(): string {
  return `${BASE_RULES}
- A draft is a complete social post body (not a summary of the idea): a hook, two to four short paragraphs, a closing line or call to action.`;
}

export function draftPrompt(input: {
  title: string;
  notes: string;
  body: string;
  platforms: string[];
}): string {
  return `Write a draft post from this idea.
TITLE: ${input.title}
INTENDED PLATFORMS: ${input.platforms.length > 0 ? input.platforms.join(', ') : 'LinkedIn'}
NOTES:
${input.notes || '(none)'}
IDEA PAGE BODY:
${input.body || '(empty)'}

OUTPUT: the post text only, paragraphs separated by blank lines. Under 2500 characters.`;
}

export type RepurposeKind = 'thread' | 'short_variants' | 'carousel_outline';

export function repurposeSystem(): string {
  return `${BASE_RULES}
- Repurposing keeps every claim from the source; it changes form, not substance.`;
}

export function repurposePrompt(input: {
  title: string;
  sourceText: string;
  kind: RepurposeKind;
}): string {
  const shape = {
    thread:
      'a thread of 4 to 8 posts, each under 280 characters, the first one a hook and the last one a takeaway',
    short_variants:
      'three standalone short posts (each under 300 characters) with different angles on the source',
    carousel_outline:
      'a carousel outline of 5 to 8 slides: each slide has a title (under 8 words) and one or two lines of body text',
  }[input.kind];
  return `Repurpose the source into ${shape}.
KIND: ${input.kind}
TITLE: ${input.title}
SOURCE TEXT:
${input.sourceText}

OUTPUT: a JSON array of objects {"title": string, "body": string}, one per post or slide, in order. No markdown fences.`;
}

export function altTextSystem(): string {
  return `You write alternative text for images in social media posts. Describe what the image shows in one sentence, under 125 characters, plain language, no "image of" prefix, no hashtags.`;
}

export function altTextPrompt(context: { postTitle: string; fileName: string }): string {
  return `The image is attached to a post titled "${context.postTitle}" (file name ${context.fileName}). Write the alt text.`;
}

/** Tolerant JSON extraction: models sometimes wrap JSON in fences or prose. */
export function extractJson<T>(text: string): T | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const candidates = [trimmed];
  const first = trimmed.search(/[[{]/);
  if (first > 0) candidates.push(trimmed.slice(first));
  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
