import Stripe from 'stripe';

/**
 * The slice of Stripe the app uses (Phase 3), behind an interface so services
 * and tests never touch the SDK's network layer. Hosted Checkout and the
 * Customer Portal do the UI; webhooks tell us what happened.
 */

export interface CheckoutInput {
  workspaceId: string;
  /** Existing Stripe customer id, or the email to create one with. */
  customerId: string | null;
  customerEmail: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingGateway {
  createCheckoutSession(input: CheckoutInput): Promise<{ id: string; url: string }>;
  createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }>;
}

export interface StripeGatewayConfig {
  secretKey: string;
}

export class StripeGateway implements BillingGateway {
  private readonly stripe: Stripe;

  constructor(cfg: StripeGatewayConfig) {
    this.stripe = new Stripe(cfg.secretKey, {
      apiVersion: '2026-09-30.clover' as Stripe.LatestApiVersion,
    });
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ id: string; url: string }> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: input.priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.workspaceId,
      ...(input.customerId
        ? { customer: input.customerId }
        : { customer_email: input.customerEmail }),
      metadata: { workspaceId: input.workspaceId },
      subscription_data: { metadata: { workspaceId: input.workspaceId } },
      allow_promotion_codes: true,
    });
    if (!session.url) throw new Error('Stripe returned a checkout session without a url');
    return { id: session.id, url: session.url };
  }

  async createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }
}

/** Records calls and hands out deterministic URLs (tests, PROVIDER_MODE=fake without Stripe keys). */
export class FakeBillingGateway implements BillingGateway {
  readonly checkouts: CheckoutInput[] = [];
  readonly portals: { customerId: string; returnUrl: string }[] = [];

  async createCheckoutSession(input: CheckoutInput): Promise<{ id: string; url: string }> {
    this.checkouts.push(input);
    const id = `cs_test_${this.checkouts.length}`;
    return { id, url: `https://checkout.stripe.test/${id}` };
  }

  async createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }> {
    this.portals.push({ customerId, returnUrl });
    return {
      url: `https://billing.stripe.test/${customerId}?return=${encodeURIComponent(returnUrl)}`,
    };
  }
}

/**
 * Webhook signature verification is pure crypto in the SDK (no network), so
 * the real implementation is used everywhere; tests sign payloads with
 * `Stripe.webhooks.generateTestHeaderString`.
 */
export function verifyStripeWebhook(
  rawBody: Buffer,
  signature: string,
  secret: string,
): Stripe.Event {
  return Stripe.webhooks.constructEvent(rawBody, signature, secret);
}

export type { Stripe };
