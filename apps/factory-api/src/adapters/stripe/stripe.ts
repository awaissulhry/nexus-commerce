import { PROVIDER_STATES, type PaymentCall, type PaymentProviderPort, type ProviderIntent, type ProviderIntentRequest, type ProviderState } from '@nexus/factory-domain/payments/online/port'
import { ProviderError } from '../../platform/gateway/gateway'

/**
 * Stripe (B-W2b-185; FIN-123): the payment provider's REST API for LIVE and SANDBOX accounts of provider STRIPE. Behind
 * GATE-SPEND: modules/payments/online refuses a LIVE Stripe account until the Owner's yes with the exact cost
 * (factory-domain payments/online/rules LIVE_CARD_PAYMENTS_ALLOWED); no account, no key exists today, so nothing calls it.
 * Every call runs inside one gateway call (account state, rate limit, circuit, timeout, the ledger row); the secret key
 * comes from the account's sealed credentials (`{ secretKey: "sk_…" | "rk_…" }`) and never leaves this file.
 *
 *   payment.create_intent    POST /v1/payment_intents (amount, currency, the method's payment_method_types, our intent id
 *                            in metadata and as the Idempotency-Key: a retry makes the same intent)
 *   payment.retrieve_intent  GET  /v1/payment_intents/:id
 *   payment.cancel_intent    POST /v1/payment_intents/:id/cancel (an intent already cancelled answers its state)
 *
 * The client secret is returned to the caller for the customer's page and never written to the ledger (the answers
 * recorded name the id and the state only). The customer's card or mandate goes from Stripe's own fields to Stripe.
 */

export const STRIPE_API = 'https://api.stripe.com'
export const STRIPE_API_VERSION = '2024-06-20'

type Fetch = (input: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>

export interface StripeOptions {
  /** The HTTP client (tests pass a fake transport; default the platform's fetch). */
  readonly fetch?: Fetch
  readonly baseUrl?: string
}

const isState = (value: unknown): value is ProviderState => typeof value === 'string' && (PROVIDER_STATES as readonly string[]).includes(value)
const SECRET_KEY = /^(sk|rk)_(live|test)_[A-Za-z0-9]{8,}$/

function form(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
}

export function stripeAdapter(options: StripeOptions = {}): PaymentProviderPort {
  const send: Fetch = options.fetch ?? ((input, init) => fetch(input, init))
  const base = options.baseUrl ?? STRIPE_API

  async function request(call: PaymentCall, method: 'GET' | 'POST', path: string, fields?: Record<string, string>): Promise<Record<string, unknown>> {
    if (call.account.provider !== 'STRIPE' || call.account.mode === 'FAKE') throw new ProviderError('Only a LIVE or SANDBOX Stripe account calls Stripe.', { retryable: false })
    const credentials = await call.credentials<{ secretKey?: unknown }>()
    const key = typeof credentials?.secretKey === 'string' ? credentials.secretKey : null
    if (!key || !SECRET_KEY.test(key)) throw new ProviderError('The Stripe account has no secret key (sk_… or rk_…) in its credentials.', { retryable: false })
    if (call.account.mode === 'SANDBOX' && !key.includes('_test_')) throw new ProviderError('A SANDBOX Stripe account takes a test key only.', { retryable: false })
    const headers: Record<string, string> = { authorization: `Bearer ${key}`, 'stripe-version': STRIPE_API_VERSION }
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      if (call.idempotencyKey) headers['idempotency-key'] = call.idempotencyKey
    }
    const answer = await send(`${base}${path}`, { method, headers, ...(fields ? { body: form(fields) } : {}), signal: call.signal })
    const body = (await answer.json().catch(() => null)) as Record<string, unknown> | null
    if (answer.status < 200 || answer.status >= 300) {
      const error = body && typeof body.error === 'object' && body.error !== null ? (body.error as Record<string, unknown>) : null
      const code = typeof error?.code === 'string' ? error.code : typeof error?.type === 'string' ? error.type : 'error'
      call.answer({ httpStatus: answer.status, response: { error: code } })
      throw new ProviderError(`Stripe answered ${answer.status}: ${code}`, { httpStatus: answer.status })
    }
    if (!body) throw new ProviderError('Stripe answered without a body.', { httpStatus: answer.status })
    return body
  }

  function intentOf(call: PaymentCall, httpStatus: number, body: Record<string, unknown>): ProviderIntent {
    const providerRef = typeof body.id === 'string' ? body.id : null
    const clientSecret = typeof body.client_secret === 'string' ? body.client_secret : null
    if (!providerRef || !clientSecret || !isState(body.status)) throw new ProviderError('Stripe answered a payment intent without its id, client secret or status.', { retryable: false })
    // The ledger keeps the id and the state, never the client secret.
    call.answer({ httpStatus, response: { id: providerRef, status: body.status } })
    return { providerRef, state: body.status, clientSecret }
  }

  return Object.freeze({
    async createIntent(call: PaymentCall, input: ProviderIntentRequest): Promise<ProviderIntent> {
      const body = await request(call, 'POST', '/v1/payment_intents', {
        amount: String(input.amount),
        currency: input.currency.toLowerCase(),
        'payment_method_types[0]': input.method === 'CARD' ? 'card' : 'sepa_debit',
        description: input.description.slice(0, 1000),
        'metadata[intentId]': input.intentId,
        'metadata[tenantId]': input.tenantId,
      })
      return intentOf(call, 200, body)
    },
    async retrieveIntent(call: PaymentCall, providerRef: string): Promise<ProviderIntent> {
      return intentOf(call, 200, await request(call, 'GET', `/v1/payment_intents/${encodeURIComponent(providerRef)}`))
    },
    async cancelIntent(call: PaymentCall, providerRef: string): Promise<{ readonly state: ProviderState }> {
      try {
        const body = await request(call, 'POST', `/v1/payment_intents/${encodeURIComponent(providerRef)}/cancel`, {})
        const state = isState(body.status) ? body.status : 'canceled'
        call.answer({ httpStatus: 200, response: { id: providerRef, status: state } })
        return { state }
      } catch (error) {
        // An intent cancelled already (or finished) cannot be cancelled again: Stripe answers 400; its state tells.
        if (error instanceof ProviderError && error.httpStatus === 400) {
          const body = await request(call, 'GET', `/v1/payment_intents/${encodeURIComponent(providerRef)}`)
          const state = isState(body.status) ? body.status : 'canceled'
          call.answer({ httpStatus: 200, response: { id: providerRef, status: state } })
          return { state }
        }
        throw error
      }
    },
  } satisfies PaymentProviderPort)
}
