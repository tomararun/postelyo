import Anthropic from '@anthropic-ai/sdk';

/**
 * Phase 6 AI provider abstraction. Claude through the official SDK by default;
 * the fake provider drives tests and local development so the suite never
 * calls the API. Everything above this file is provider-agnostic.
 */

export type AiPurpose = 'variants' | 'draft_from_idea' | 'repurpose' | 'alt_text' | 'suggestions';

export interface AiRequest {
  purpose: AiPurpose;
  /** Stable, cacheable instructions (workspace voice, rules). */
  system: string;
  /** The volatile part of the prompt. */
  prompt: string;
  /** Optional image for vision requests (alt text). */
  image?: { mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'; base64: string };
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  /** Ask the model for a JSON object; providers may enforce it. */
  json?: boolean;
  correlationId: string;
}

export interface AiResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  stopReason: string;
  durationMs: number;
}

export class AiProviderError extends Error {
  constructor(
    public readonly code: 'auth' | 'rate_limit' | 'refusal' | 'transient' | 'invalid' | 'other',
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export interface AiProvider {
  readonly id: string;
  readonly model: string;
  generate(req: AiRequest): Promise<AiResponse>;
}

export const DEFAULT_AI_MODEL = 'claude-opus-5';

/** USD per million tokens (input, output). Unknown models are billed at the Opus rate. */
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 1 },
};

export function costUsd(
  model: string,
  r: Pick<AiResponse, 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>,
): number {
  const p = MODEL_PRICING[model] ?? MODEL_PRICING['claude-opus-5']!;
  return (
    (r.inputTokens * p.input + r.outputTokens * p.output + r.cacheReadTokens * p.cacheRead) /
    1_000_000
  );
}

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts: AnthropicProviderOptions) {
    this.model = opts.model ?? DEFAULT_AI_MODEL;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      timeout: opts.timeoutMs ?? 120_000,
      maxRetries: 2,
    });
  }

  async generate(req: AiRequest): Promise<AiResponse> {
    const started = Date.now();
    const userContent: Anthropic.ContentBlockParam[] = [];
    if (req.image) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: req.image.mimeType, data: req.image.base64 },
      });
    }
    userContent.push({ type: 'text', text: req.prompt });
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? 4000,
        // The voice document and rules are the stable prefix: cached across a workspace's requests.
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userContent }],
        thinking: { type: 'adaptive' },
        output_config: { effort: req.effort ?? 'medium' },
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError)
        throw new AiProviderError('auth', 'The AI provider rejected the API key.', false);
      if (err instanceof Anthropic.RateLimitError)
        throw new AiProviderError('rate_limit', 'The AI provider is rate limiting requests.', true);
      if (err instanceof Anthropic.BadRequestError)
        throw new AiProviderError(
          'invalid',
          `The AI provider rejected the request: ${err.message}`,
          false,
        );
      if (
        err instanceof Anthropic.APIConnectionError ||
        err instanceof Anthropic.InternalServerError
      )
        throw new AiProviderError(
          'transient',
          `The AI provider is unreachable: ${err.message}`,
          true,
        );
      if (err instanceof Anthropic.APIError)
        throw new AiProviderError(
          'other',
          `AI provider error ${err.status}: ${err.message}`,
          false,
        );
      throw err;
    }
    if (response.stop_reason === 'refusal') {
      throw new AiProviderError(
        'refusal',
        `The model declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : '.'}`,
        false,
      );
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return {
      text,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      stopReason: response.stop_reason ?? 'end_turn',
      durationMs: Date.now() - started,
    };
  }
}

export interface FakeAiOptions {
  /** Decide the output per call; the default produces recognisable deterministic text. */
  decide?: (req: AiRequest, callNo: number) => string | AiProviderError;
  model?: string;
}

/** Deterministic provider for tests and `AI_PROVIDER=fake`; records every request. */
export class FakeAiProvider implements AiProvider {
  readonly id = 'fake';
  readonly model: string;
  readonly calls: { req: AiRequest; text: string | null }[] = [];
  /** Replaces the decision at runtime (tests). */
  decide: FakeAiOptions['decide'] | null = null;

  constructor(private readonly opts: FakeAiOptions = {}) {
    this.model = opts.model ?? DEFAULT_AI_MODEL;
  }

  async generate(req: AiRequest): Promise<AiResponse> {
    const decide = this.decide ?? this.opts.decide;
    const out = decide ? decide(req, this.calls.length) : fakeOutput(req);
    if (out instanceof AiProviderError) {
      this.calls.push({ req, text: null });
      throw out;
    }
    this.calls.push({ req, text: out });
    return {
      text: out,
      model: this.model,
      inputTokens: Math.ceil((req.system.length + req.prompt.length) / 4),
      outputTokens: Math.ceil(out.length / 4),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      stopReason: 'end_turn',
      durationMs: 1,
    };
  }
}

function fakeOutput(req: AiRequest): string {
  switch (req.purpose) {
    case 'variants': {
      const platforms =
        /platforms: ([^\n]+)/i
          .exec(req.prompt)?.[1]
          ?.split(',')
          .map((s) => s.trim()) ?? [];
      const source = /SOURCE TEXT:\n([\s\S]+?)\n\nOUTPUT/.exec(req.prompt)?.[1]?.trim() ?? 'text';
      const first = source.split('\n')[0]!.slice(0, 120);
      const obj: Record<string, string> = {};
      for (const p of platforms) obj[p] = `[${p}] ${first}`;
      return JSON.stringify(obj);
    }
    case 'draft_from_idea': {
      const title = /TITLE: ([^\n]+)/.exec(req.prompt)?.[1] ?? 'Draft';
      return `${title}\n\nA first paragraph written by the fake model.\n\nA second paragraph with a call to action.`;
    }
    case 'repurpose': {
      const kind = /KIND: ([^\n]+)/.exec(req.prompt)?.[1] ?? 'thread';
      return JSON.stringify([
        { title: `${kind} part 1`, body: 'First piece of the repurposed content.' },
        { title: `${kind} part 2`, body: 'Second piece of the repurposed content.' },
      ]);
    }
    case 'alt_text':
      return 'A simple test image with a single colour.';
    default:
      return 'ok';
  }
}
