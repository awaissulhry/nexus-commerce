import { z } from 'zod'
import type { PaymentState } from '@nexus/ui/components/PaymentPanel/index'
import { newIdempotencyKey, type ApiClient } from '../api/client'
import { isApiError, issuePath } from '../api/errors'

/**
 * Paying online on the FAKE provider (B-W2b-185's API; B-W2b-199 lifted these pure parts here so a link page and a portal
 * page share them — a link page may not import a portal page): the intent as the API answers it, the start's answer,
 * the FAKE provider's own fields (its scenarios, never card data), where a payment stands for the DS PaymentPanel, and
 * the start's refusal code. Words stay in each screen's catalogue: the API's English or `failure` text is never shown.
 * Live card payments wait for the Owner (GATE-SPEND): only the FAKE provider's fields are drawn; any other provider is
 * held (`providerRuns`).
 */

export const PAYMENT_METHODS = ['CARD', 'SEPA_DEBIT'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const INTENT_STATUSES = ['CREATED', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const
export type IntentStatus = (typeof INTENT_STATUSES)[number]

/** Money comes with the price grain only (absent without it). */
const price = z.number().int().optional()

export const intentSchema = z.object({
  id: z.string(),
  method: z.enum(PAYMENT_METHODS),
  amount: price,
  currency: z.string(),
  status: z.enum(INTENT_STATUSES),
  /** The provider's id ("pi_…"): the payment's reference. */
  providerRef: z.string().nullable(),
  failureCode: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
})
export type PaymentIntent = z.infer<typeof intentSchema>

export const startedSchema = z.object({
  intent: intentSchema,
  /** What the provider's fields need: the client secret is kept in memory only, never stored or shown. */
  provider: z.object({ name: z.string(), mode: z.string(), clientSecret: z.string(), publishableKey: z.string().nullable() }).nullable(),
  /** The payment under way of the same payer was taken up again (a reload, a double click). */
  resumed: z.boolean(),
})
export type StartedPayment = z.infer<typeof startedSchema>

/** Card and SEPA as offered (the provider and its mode) or why not (`reason`, a code). */
export const cardOfferSchema = z.object({
  available: z.boolean(),
  methods: z.array(z.enum(PAYMENT_METHODS)),
  provider: z.string().nullable(),
  mode: z.string().nullable(),
  reason: z.string().nullable(),
})
export type CardOffer = z.infer<typeof cardOfferSchema>

/** GATE-SPEND: only the FAKE provider runs (local and test). A Stripe account, or any live mode, is held until the Owner's yes. */
export const providerRuns = (offer: Pick<CardOffer, 'provider' | 'mode'> | { name: string; mode: string }): boolean =>
  ('name' in offer ? offer.name : offer.provider) === 'PAYMENT_FAKE' && offer.mode === 'FAKE'

// ── the FAKE provider's own fields ──────────────────────────────────────────────────────────────────────────────────
/** What a card or a bank does, as the FAKE provider plays it (never a card number). */
export const FAKE_SCENARIOS = ['succeed', 'decline', 'insufficient_funds', 'authenticate', 'fail_authentication', 'settle', 'return'] as const
export type FakeScenario = (typeof FAKE_SCENARIOS)[number]

/**
 * The FAKE provider's buttons for a method at a step: a card first (pay, declined, not enough funds, the bank asks to
 * confirm), then the bank's confirmation window (3-D Secure: confirm or fail); SEPA first (sign the mandate), then — while
 * the debit is on its way — what the bank does days later (the money arrives, or the debit is returned).
 */
export function fakeScenariosFor(method: PaymentMethod, step: 'first' | 'confirm' | 'processing'): readonly FakeScenario[] {
  if (method === 'SEPA_DEBIT') return step === 'processing' ? ['settle', 'return'] : ['succeed']
  return step === 'confirm' ? ['succeed', 'fail_authentication'] : ['succeed', 'decline', 'insufficient_funds', 'authenticate']
}

export const fakeConfirmSchema = z.object({ state: z.string() })

/** `POST /payment-fake/confirm` (a PUBLIC route of the API, 404 outside local and test): what the provider's fields do. */
export const confirmFake = (api: ApiClient, clientSecret: string, scenario: FakeScenario) =>
  api.post('/payment-fake/confirm', { body: { clientSecret, scenario }, schema: fakeConfirmSchema, idempotencyKey: newIdempotencyKey() })

// ── where a payment stands ──────────────────────────────────────────────────────────────────────────────────────────
/** What the page is doing: nothing yet, asking for a payment, the provider's fields shown, sent to the provider. */
export type PayPhase = 'idle' | 'starting' | 'ready' | 'paying'

/** Where the payment stands, for the DS PaymentPanel: the intent's end wins; a payment sent and still decided is waiting. */
export function paymentStateOf(phase: PayPhase, intent: Pick<PaymentIntent, 'status'> | null): PaymentState {
  if (intent?.status === 'SUCCEEDED') return 'succeeded'
  if (intent?.status === 'FAILED' || intent?.status === 'CANCELLED') return 'failed'
  if (phase === 'paying' && intent?.status === 'WAITING') return 'waiting'
  return phase
}

/** The page asks how a payment stands every few seconds until the provider decided (no live event reaches a partner). */
export const POLL_MS = 2500
export const isFinal = (intent: Pick<PaymentIntent, 'status'> | null): boolean => intent !== null && (intent.status === 'SUCCEEDED' || intent.status === 'FAILED' || intent.status === 'CANCELLED')

/** The provider's reasons a screen words (factory-domain payments/online FAILURE_WORDS); any other code is the default. */
export const FAILURE_CODES = [
  'card_declined',
  'insufficient_funds',
  'expired_card',
  'incorrect_cvc',
  'authentication_failed',
  'payment_intent_authentication_failure',
  'debit_not_authorized',
  'insufficient_funds_sepa',
  'provider_unavailable',
  'provider_refused',
] as const
export const failureKeyOf = (code: string | null | undefined): string => (code && (FAILURE_CODES as readonly string[]).includes(code) ? code : 'default')

/** Why card and SEPA are not offered (factory-domain AccountRefusal + NO_ACCOUNT); any other code is NO_ACCOUNT's words. */
export const UNAVAILABLE_CODES = ['NO_ACCOUNT', 'NOT_A_PAYMENT_ACCOUNT', 'NOT_ACTIVE', 'GATE_SPEND', 'FAKE_IN_PRODUCTION', 'FAKE_PROVIDER_LIVE'] as const
export const unavailableKeyOf = (code: string | null | undefined): string => (code && (UNAVAILABLE_CODES as readonly string[]).includes(code) ? code : 'NO_ACCOUNT')

/** The start's refusals (409 `payment/<CODE>`, factory-domain START_REFUSALS). */
export const START_REFUSALS = ['NOT_OPEN', 'NO_PROVIDER', 'CURRENCY', 'NOT_PAYABLE', 'PROVIDER', 'IN_PROGRESS'] as const
export type StartRefusal = (typeof START_REFUSALS)[number]

/** The code of a refused start or confirm (`payment/IN_PROGRESS` → IN_PROGRESS), or null when the answer names none. */
export function startRefusalOf(error: unknown): StartRefusal | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const match = /^payment\/([A-Z_]+)$/.exec(issuePath(issue))
    if (match && (START_REFUSALS as readonly string[]).includes(match[1]!)) return match[1] as StartRefusal
  }
  return null
}
