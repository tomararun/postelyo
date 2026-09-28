import { DELIVERABLE_EVENTS } from '../../modules/enterprise/webhook.service.js';
import { API_RATE_LIMIT_PER_MINUTE } from '../../modules/enterprise/api-key.service.js';

/**
 * Hand-written OpenAPI 3.1 document for the Phase 7 public API. Kept small
 * and honest: every path here exists in `public-api.ts`, and nothing there is
 * missing here (the phase7 integration test cross-checks the two).
 */

const problem = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    instance: { type: 'string' },
    code: { type: 'string' },
  },
  required: ['title', 'status'],
} as const;

const errorResponses = {
  '401': {
    description: 'Missing, revoked, expired or unentitled API key',
    content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
  },
  '403': {
    description: 'The key lacks the required scope',
    content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
  },
  '429': {
    description: `Rate limit exceeded (${API_RATE_LIMIT_PER_MINUTE} requests per minute per key); see Retry-After`,
    content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
  },
} as const;

const readOp = (summary: string, extra: Record<string, unknown> = {}) => ({
  summary,
  security: [{ apiKey: [] }],
  responses: { '200': { description: 'OK' }, ...errorResponses },
  ...extra,
});

const writeOp = (summary: string, extra: Record<string, unknown> = {}) => ({
  summary,
  security: [{ apiKey: [] }],
  parameters: [
    {
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      schema: { type: 'string', maxLength: 200 },
      description:
        'Replays the stored response for 24 hours; a different request with the same key answers 422.',
    },
  ],
  responses: {
    '200': { description: 'OK' },
    '422': {
      description: 'Idempotency-Key reused for a different request',
      content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
    },
    ...errorResponses,
  },
  ...extra,
});

export function buildOpenApi(baseUrl: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Postelyo API',
      version: '1.0.0',
      description:
        'Public API for Postelyo workspaces. Authenticate with an API key created on the Developers page (`Authorization: Bearer pk_live_…`). Keys carry `read` and/or `write` scopes and are limited to ' +
        `${API_RATE_LIMIT_PER_MINUTE} requests per minute. Errors are RFC 9457 problem documents.`,
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'pk_live_…' } },
      schemas: {
        Problem: problem,
        WebhookEvent: { type: 'string', enum: [...DELIVERABLE_EVENTS] },
        WebhookPayload: {
          type: 'object',
          description:
            'Body of every webhook POST. Verify `X-Postelyo-Signature: t=<unix>,v1=<hex>` where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`); reject when |now − t| > 5 minutes.',
          properties: {
            id: { type: 'string', description: 'Delivery id (also X-Postelyo-Delivery)' },
            event: { $ref: '#/components/schemas/WebhookEvent' },
            occurredAt: { type: 'string', format: 'date-time' },
            workspaceId: { type: 'string' },
            entityType: { type: 'string' },
            entityId: { type: 'string' },
            fromState: { type: ['string', 'null'] },
            toState: { type: ['string', 'null'] },
            actor: {
              type: 'object',
              properties: { type: { type: 'string' }, id: { type: ['string', 'null'] } },
            },
            data: { type: 'object' },
            auditId: { type: 'string' },
          },
        },
        NewPost: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', maxLength: 200 },
            body: {
              type: 'string',
              description: 'Paragraphs separated by blank lines; becomes the page body.',
            },
            platforms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Notion Platforms options, e.g. "LinkedIn", "X".',
            },
            publishAt: {
              type: 'string',
              format: 'date-time',
              description: 'Sets Publish Date; the page stays Draft unless `status` is Scheduled.',
            },
            status: { type: 'string', enum: ['Draft', 'Scheduled'], default: 'Draft' },
            note: { type: 'string', maxLength: 500, description: 'Written to Postelyo Note.' },
          },
        },
      },
    },
    paths: {
      '/workspace': { get: readOp('The workspace the key belongs to') },
      '/posts': {
        get: readOp('List posts (newest updated first, up to 200)', {
          parameters: [
            { name: 'state', in: 'query', schema: { type: 'string' } },
            {
              name: 'since',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
              description: 'Only posts updated at or after this time',
            },
          ],
        }),
        post: writeOp('Create a post as a page in the connected Notion content database', {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPost' } } },
          },
          responses: { '201': { description: 'Page created; Postelyo syncs it within a minute' } },
        }),
      },
      '/posts/{postId}': {
        get: readOp('One post with its publications', {
          parameters: [{ name: 'postId', in: 'path', required: true, schema: { type: 'string' } }],
        }),
      },
      '/publications/{publicationId}': {
        get: readOp('One publication with attempts, links and metrics', {
          parameters: [
            { name: 'publicationId', in: 'path', required: true, schema: { type: 'string' } },
          ],
        }),
      },
      '/publications/{publicationId}/retry': {
        post: writeOp('Retry a failed publication', {
          parameters: [
            { name: 'publicationId', in: 'path', required: true, schema: { type: 'string' } },
          ],
        }),
      },
      '/campaigns': { get: readOp('Campaigns mirrored from Notion with their summaries') },
      '/analytics/summary': {
        get: readOp('Weekly rollups, top posts, hashtags and best times', {
          parameters: [
            {
              name: 'weeks',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 26, default: 8 },
            },
          ],
        }),
      },
      '/audit': {
        get: readOp('Recent audit events (newest first)', {
          parameters: [
            { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
            {
              name: 'event',
              in: 'query',
              schema: { type: 'string' },
              description: 'Comma-separated event names',
            },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500, default: 100 } },
          ],
        }),
      },
      '/audit/export': {
        get: readOp('NDJSON export of the audit trail for a date range (Team plan or higher)', {
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          ],
          responses: {
            '200': {
              description: 'One JSON object per line',
              content: { 'application/x-ndjson': {} },
            },
          },
        }),
      },
      '/webhooks': {
        get: readOp('Webhook endpoints'),
        post: writeOp('Create a webhook endpoint (the signing secret is returned once)', {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['url'],
                  properties: {
                    url: { type: 'string', format: 'uri' },
                    description: { type: 'string' },
                    events: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/WebhookEvent' },
                      description: 'Empty = every event',
                    },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'Created' } },
        }),
      },
      '/webhooks/{endpointId}': {
        patch: writeOp('Update url, description, events or enabled', {
          parameters: [
            { name: 'endpointId', in: 'path', required: true, schema: { type: 'string' } },
          ],
        }),
        delete: writeOp('Delete a webhook endpoint', {
          parameters: [
            { name: 'endpointId', in: 'path', required: true, schema: { type: 'string' } },
          ],
        }),
      },
      '/webhooks/{endpointId}/deliveries': {
        get: readOp('Recent deliveries for an endpoint', {
          parameters: [
            { name: 'endpointId', in: 'path', required: true, schema: { type: 'string' } },
          ],
        }),
      },
      '/webhooks/{endpointId}/test': {
        post: writeOp('Send a `webhook.test` delivery now', {
          parameters: [
            { name: 'endpointId', in: 'path', required: true, schema: { type: 'string' } },
          ],
        }),
      },
    },
  };
}
