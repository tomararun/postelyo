/**
 * @postelyo/publishing-core: the publishing provider contract (architecture §9.1),
 * the canonical content format (domain-model §4), rendering helpers, the
 * provider registry and the platform adapters. Adapters are pure I/O
 * translators: no database, no queue, credentials only for the duration of a
 * call. The contract test suite lives at `@postelyo/publishing-core/contract-suite`.
 */

export type { BlockNode, CanonicalContent, InlineNode, MediaRef, PostSnapshot } from './content.js';
export * from './provider.js';
export {
  contentForProvider,
  contentToPlainText,
  plainTextToBlocks,
  textFingerprint,
  validateAgainstCapabilities,
} from './render.js';
export {
  createProviderRegistry,
  UnknownProviderError,
  type ProviderRegistry,
  type ProviderRegistryOptions,
} from './registry.js';
export {
  FakeProvider,
  type FakeCall,
  type FakeProviderOptions,
} from './providers/fake/fake-provider.js';
export {
  LINKEDIN_API_VERSION,
  LINKEDIN_IMAGES_INIT_URL,
  LINKEDIN_MAX_IMAGE_BYTES,
  LINKEDIN_MAX_TEXT,
  LINKEDIN_POSTS_URL,
  LinkedInProvider,
  authorUrn as linkedInAuthorUrn,
  type LinkedInProviderOptions,
} from './providers/linkedin/linkedin-provider.js';
export {
  X_MAX_WEIGHTED_LENGTH,
  X_MEDIA_UPLOAD_URL,
  X_TWEETS_URL,
  X_USERS_URL,
  XProvider,
  weightedLength as xWeightedLength,
  type XProviderOptions,
} from './providers/x/x-provider.js';
export { GRAPH_URL, GRAPH_VERSION } from './providers/meta/graph.js';
export {
  FACEBOOK_MAX_TEXT,
  FacebookProvider,
  type FacebookProviderOptions,
} from './providers/meta/facebook-provider.js';
export {
  INSTAGRAM_MAX_CAPTION,
  InstagramProvider,
  type InstagramProviderOptions,
} from './providers/meta/instagram-provider.js';
