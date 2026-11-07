import type { AdapterAccount, OperationDescriptor } from '../../ports/provider'

/**
 * The payment provider port (B-W2b-185; FIN-123; plan A1 §4 "Pattern for every adapter"; design links.pay "Pay by card":
 * "PaymentPanel: the provider's own fields inside the page; no card data touches our app"). A provider makes a payment
 * intent for an amount; the customer's card or SEPA mandate goes from the browser straight to the provider (its own
 * fields, strong customer authentication by the provider, PSD2); the provider's signed webhook says how it ended. The
 * factory keeps the intent's id, its state and the provider's reason code — never a card number, a mandate or the client
 * secret (the database refuses a run of twelve digits in providerRef and failureCode).
 *
 * Adapters (apps/factory-api src/adapters): `payment-fake` (FAKE accounts of any payment provider: local and test, no
 * network) and `stripe` (LIVE and SANDBOX Stripe accounts; LIVE waits for GATE-SPEND, ./rules.ts). Every call goes through
 * the gateway (account state, rate limit, circuit, timeout, one IntegrationCall row per call). Pure types: no I/O.
 */

export const PAYMENT_OPERATIONS = Object.freeze({
  /** Make the provider's intent for an amount. Idempotent: the factory's intent id is the provider idempotency key. */
  createIntent: { name: 'payment.create_intent', idempotent: true },
  /** The provider's intent again (its state and the client secret the page needs to go on). A read. */
  retrieveIntent: { name: 'payment.retrieve_intent', idempotent: true },
  /** Cancel an intent that must not take money any more (replaced, or failed on our side). Asking twice cancels once. */
  cancelIntent: { name: 'payment.cancel_intent', idempotent: true },
} as const satisfies Record<string, OperationDescriptor>)

/** What an adapter gets for one attempt of a gateway call (the API's GatewayCall has this shape). */
export interface PaymentCall {
  readonly account: AdapterAccount
  readonly attempt: number
  readonly signal: AbortSignal
  readonly idempotencyKey: string | null
  /** The account's sealed credentials (Stripe: `{ secretKey }`), opened for this call; null when it has none. */
  credentials<T = Record<string, unknown>>(): Promise<T | null>
  /** The provider's HTTP status and answer of this attempt, for the ledger (redacted there; never the client secret). */
  answer(details: { readonly httpStatus?: number; readonly response?: unknown }): void
}

export type ProviderMethod = 'CARD' | 'SEPA_DEBIT'

/** One intent to make at the provider. */
export interface ProviderIntentRequest {
  /** The factory's PaymentIntent id: the provider's idempotency key and the `intentId` of its metadata. */
  readonly intentId: string
  readonly tenantId: string
  readonly method: ProviderMethod
  /** Minor units (cents). */
  readonly amount: number
  /** ISO 4217, upper case. */
  readonly currency: string
  /** What it pays, as the customer's bank statement shows it ("Invoice FT-2026-00012"). */
  readonly description: string
}

/**
 * The provider's state of an intent, in Stripe's words (the fake speaks them too):
 *   requires_payment_method   waits for the customer's card or mandate (or the last one was declined)
 *   requires_confirmation     a payment method is attached, not yet confirmed
 *   requires_action           the bank asks: 3-D Secure in the provider's window
 *   processing                the money is on its way (a SEPA debit clears in days)
 *   succeeded | canceled      final
 */
export const PROVIDER_STATES = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'succeeded', 'canceled'] as const
export type ProviderState = (typeof PROVIDER_STATES)[number]

/** The provider's intent as an adapter answers it. `clientSecret` goes to the customer's page only, never stored. */
export interface ProviderIntent {
  readonly providerRef: string
  readonly state: ProviderState
  readonly clientSecret: string
}

export interface PaymentProviderPort {
  createIntent(call: PaymentCall, request: ProviderIntentRequest): Promise<ProviderIntent>
  retrieveIntent(call: PaymentCall, providerRef: string): Promise<ProviderIntent>
  cancelIntent(call: PaymentCall, providerRef: string): Promise<{ readonly state: ProviderState }>
}

/**
 * What the provider's webhook says about one intent (the Stripe event shape: `payment_intent.<what>`; the fake posts the
 * same shape). `intentId` is the factory's id from the intent's metadata when the provider sent it back.
 */
export interface ProviderIntentEvent {
  /** The provider's event id (Stripe's `evt_…`): the webhook's dedupe key. */
  readonly eventId: string
  readonly type: string
  readonly providerRef: string
  readonly intentId: string | null
  readonly state: ProviderState | null
  /** Minor units the provider received (succeeded) or asked. */
  readonly amount: number | null
  readonly currency: string | null
  /** payment_failed: the decline code or error code ("card_declined", "insufficient_funds"). */
  readonly failureCode: string | null
}
