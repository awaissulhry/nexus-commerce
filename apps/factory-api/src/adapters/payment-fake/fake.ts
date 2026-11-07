import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PaymentCall, PaymentProviderPort, ProviderIntent, ProviderIntentRequest, ProviderMethod, ProviderState } from '@nexus/factory-domain/payments/online/port'
import { stripeSignature } from '@nexus/factory-domain/payments/online/webhook'
import { ProviderError } from '../../platform/gateway/gateway'
import { fakeSignatureHeaders } from '../../platform/inbound/verifiers'

/**
 * The FAKE payment provider (B-W2b-185; plan A1 §4 "Fake behaviour"; W2b-3 question 2: build on the fake, no account, no
 * key, no cost). Local and test only: modules/payments/online/runtime.ts makes none in staging or production, where the
 * gateway refuses FAKE accounts anyway. Nothing leaves the process. It speaks Stripe's words (states, the event shape), so
 * the webhook processor reads one shape for both.
 *
 *   intents     deterministic: the factory's intent id gives the provider's id (`pi_fake_` + the id's hex written as the
 *               letters a-p: never a digit, so never a run of twelve) and the client secret (the provider id, the tenant,
 *               the account and an HMAC: the page's "provider fields" hand it back on confirm; nothing stores it)
 *   confirm     what the provider's own fields do in the browser, as a scenario (never a card number):
 *                 CARD        succeed · decline (card_declined) · insufficient_funds · authenticate (3-D Secure asks: the
 *                             page then confirms again with succeed or fail_authentication)
 *                 SEPA_DEBIT  succeed (the mandate is taken: processing, the money on its way) · settle (it arrived) ·
 *                             return (the bank refused the debit: debit_not_authorized)
 *               and the webhook(s) the provider then posts, signed with the account's webhook secret (Stripe's header AND
 *               the factory's fake header, which a FAKE account's inbound route checks)
 *   failures    `failNext(n, status)` scripts the next calls' failures (a 503 is retried by the gateway, a 4xx is final)
 */

export const FAKE_SCENARIOS = ['succeed', 'decline', 'insufficient_funds', 'authenticate', 'fail_authentication', 'settle', 'return'] as const
export type FakeScenario = (typeof FAKE_SCENARIOS)[number]

const SCENARIOS_OF: Readonly<Record<ProviderMethod, readonly FakeScenario[]>> = {
  CARD: ['succeed', 'decline', 'insufficient_funds', 'authenticate', 'fail_authentication'],
  SEPA_DEBIT: ['succeed', 'settle', 'return'],
}
export const scenarioFits = (method: ProviderMethod, scenario: FakeScenario): boolean => SCENARIOS_OF[method].includes(scenario)

/** The fake's HMAC key: a fake needs no secret of ours, only a check that the page hands back what it was given. */
const FAKE_KEY = 'nexus-factory-payment-fake'
const LETTERS = 'abcdefghijklmnop'
const PROVIDER_REF = /^pi_fake_[a-p]{32}$/
const CLIENT_SECRET = /^(pi_fake_[a-p]{32})_secret_([0-9a-f-]{36})_([0-9a-f-]{36})_([0-9a-f]{32})$/

/** The fake provider's id of an intent: its hex written as letters. */
export const fakeProviderRef = (intentId: string): string => `pi_fake_${intentId.replace(/-/g, '').toLowerCase().replace(/[0-9a-f]/g, (digit) => LETTERS[Number.parseInt(digit, 16)]!)}`

/** The factory's intent id back from a fake provider id. */
export function intentIdOfFakeRef(providerRef: string): string | null {
  if (!PROVIDER_REF.test(providerRef)) return null
  const hex = providerRef.slice('pi_fake_'.length).replace(/[a-p]/g, (letter) => LETTERS.indexOf(letter).toString(16))
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const mac = (providerRef: string, tenantId: string, accountId: string): string => createHmac('sha256', FAKE_KEY).update(`${providerRef}|${tenantId}|${accountId}`).digest('hex').slice(0, 32)

export const fakeClientSecret = (providerRef: string, tenantId: string, accountId: string): string => `${providerRef}_secret_${tenantId}_${accountId}_${mac(providerRef, tenantId, accountId)}`

/** What a client secret names (the provider id, the tenant and the account), or null when it is not one the fake made. */
export function readFakeClientSecret(secret: string): { readonly providerRef: string; readonly tenantId: string; readonly accountId: string } | null {
  const match = CLIENT_SECRET.exec(secret)
  if (!match) return null
  const [, providerRef, tenantId, accountId, given] = match as unknown as [string, string, string, string, string]
  const expected = mac(providerRef, tenantId, accountId)
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given)) ? { providerRef, tenantId, accountId } : null
}

/** One webhook as the provider posts it. */
export interface FakePaymentWebhook {
  readonly body: string
  readonly headers: Record<string, string>
  readonly eventId: string
  readonly type: string
}

/** What the provider's fields answer the page for a scenario, and the webhooks it then posts. */
export interface FakeConfirmation {
  readonly state: ProviderState
  /** The provider's reason when it declined (its code). */
  readonly errorCode: string | null
  readonly webhooks: readonly FakePaymentWebhook[]
}

/** The intent as the confirm needs it (read from the factory's row: the fake keeps no state it would lose on a restart). */
export interface FakeIntentFacts {
  readonly intentId: string
  readonly tenantId: string
  readonly providerRef: string
  readonly method: ProviderMethod
  readonly amount: number
  readonly currency: string
}

export class FakePaymentProvider implements PaymentProviderPort {
  /** The intents made, in order (a repeat of an id is listed again). */
  readonly created: ProviderIntentRequest[] = []
  readonly cancelled: string[] = []
  private readonly failures: { readonly httpStatus: number; readonly message: string }[] = []
  private sequence = 0

  constructor(private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  /** The next `count` calls (any operation) fail with this HTTP status (503: the gateway retries it; 4xx: final). */
  failNext(count: number, httpStatus = 503, message = 'The payment provider is not available (fake).'): void {
    for (let index = 0; index < count; index++) this.failures.push({ httpStatus, message })
  }

  private guard(call: PaymentCall): void {
    if (call.account.mode !== 'FAKE') throw new ProviderError('Only a FAKE payment account uses the fake provider.', { retryable: false })
    const failure = this.failures.shift()
    if (failure) {
      call.answer({ httpStatus: failure.httpStatus, response: { fake: true, error: failure.message } })
      throw new ProviderError(failure.message, { httpStatus: failure.httpStatus })
    }
  }

  private intentOf(call: PaymentCall, providerRef: string, state: ProviderState): ProviderIntent {
    return { providerRef, state, clientSecret: fakeClientSecret(providerRef, call.account.tenantId, call.account.id) }
  }

  async createIntent(call: PaymentCall, request: ProviderIntentRequest): Promise<ProviderIntent> {
    this.guard(call)
    if (!Number.isSafeInteger(request.amount) || request.amount <= 0) {
      call.answer({ httpStatus: 400, response: { fake: true, error: 'amount' } })
      throw new ProviderError('The payment provider answered 400: the amount must be above 0 (fake).', { httpStatus: 400 })
    }
    this.created.push(Object.freeze({ ...request }))
    const providerRef = fakeProviderRef(request.intentId)
    call.answer({ httpStatus: 200, response: { fake: true, providerRef, state: 'requires_payment_method' } })
    return this.intentOf(call, providerRef, 'requires_payment_method')
  }

  async retrieveIntent(call: PaymentCall, providerRef: string): Promise<ProviderIntent> {
    this.guard(call)
    if (!PROVIDER_REF.test(providerRef)) throw new ProviderError('No such payment intent (fake).', { httpStatus: 404, retryable: false })
    call.answer({ httpStatus: 200, response: { fake: true, providerRef } })
    return this.intentOf(call, providerRef, this.cancelled.includes(providerRef) ? 'canceled' : 'requires_payment_method')
  }

  async cancelIntent(call: PaymentCall, providerRef: string): Promise<{ readonly state: ProviderState }> {
    this.guard(call)
    if (!PROVIDER_REF.test(providerRef)) throw new ProviderError('No such payment intent (fake).', { httpStatus: 404, retryable: false })
    if (!this.cancelled.includes(providerRef)) this.cancelled.push(providerRef)
    call.answer({ httpStatus: 200, response: { fake: true, providerRef, state: 'canceled' } })
    return { state: 'canceled' }
  }

  /**
   * The customer confirms in the provider's fields (a scenario, never card data): the answer the page gets, and the
   * webhooks the provider posts, signed with `secret` (the account's webhook secret).
   */
  confirm(intent: FakeIntentFacts, scenario: FakeScenario, secret: string): FakeConfirmation {
    if (!scenarioFits(intent.method, scenario)) throw new ProviderError(`The scenario ${scenario} is not one of a ${intent.method} payment (fake).`, { httpStatus: 400, retryable: false })
    if (this.cancelled.includes(intent.providerRef)) throw new ProviderError('This payment intent was cancelled (fake).', { httpStatus: 400, retryable: false })
    const event = (type: string, state: ProviderState, errorCode: string | null = null) => this.webhook(intent, type, state, errorCode, secret)
    switch (scenario) {
      case 'succeed':
        return intent.method === 'CARD'
          ? { state: 'succeeded', errorCode: null, webhooks: [event('payment_intent.succeeded', 'succeeded')] }
          : { state: 'processing', errorCode: null, webhooks: [event('payment_intent.processing', 'processing')] }
      case 'settle':
        return { state: 'succeeded', errorCode: null, webhooks: [event('payment_intent.succeeded', 'succeeded')] }
      case 'decline':
        return { state: 'requires_payment_method', errorCode: 'card_declined', webhooks: [event('payment_intent.payment_failed', 'requires_payment_method', 'card_declined')] }
      case 'insufficient_funds':
        return { state: 'requires_payment_method', errorCode: 'insufficient_funds', webhooks: [event('payment_intent.payment_failed', 'requires_payment_method', 'insufficient_funds')] }
      case 'authenticate':
        return { state: 'requires_action', errorCode: null, webhooks: [event('payment_intent.requires_action', 'requires_action')] }
      case 'fail_authentication':
        return { state: 'requires_payment_method', errorCode: 'payment_intent_authentication_failure', webhooks: [event('payment_intent.payment_failed', 'requires_payment_method', 'payment_intent_authentication_failure')] }
      case 'return':
        return { state: 'requires_payment_method', errorCode: 'debit_not_authorized', webhooks: [event('payment_intent.payment_failed', 'requires_payment_method', 'debit_not_authorized')] }
    }
  }

  private webhook(intent: FakeIntentFacts, type: string, state: ProviderState, errorCode: string | null, secret: string): FakePaymentWebhook {
    const now = this.clock.now()
    const eventId = `evt_fake_${intent.providerRef.slice('pi_fake_'.length, 'pi_fake_'.length + 12)}${LETTERS[this.sequence++ % 16]}${now.getTime().toString(36)}`
    const body = JSON.stringify({
      id: eventId,
      object: 'event',
      type,
      created: Math.floor(now.getTime() / 1000),
      data: {
        object: {
          id: intent.providerRef,
          object: 'payment_intent',
          status: state,
          amount: intent.amount,
          amount_received: state === 'succeeded' ? intent.amount : 0,
          currency: intent.currency.toLowerCase(),
          payment_method_types: [intent.method === 'CARD' ? 'card' : 'sepa_debit'],
          metadata: { intentId: intent.intentId, tenantId: intent.tenantId },
          last_payment_error: errorCode ? { code: errorCode === 'card_declined' || errorCode === 'insufficient_funds' ? 'card_declined' : errorCode, decline_code: errorCode, type: 'card_error' } : null,
        },
      },
    })
    return {
      body,
      eventId,
      type,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripeSignature(secret, body, now),
        ...fakeSignatureHeaders(secret, body, now, { id: eventId, type }),
      },
    }
  }
}
