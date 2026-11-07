import type { AdapterAccount } from '@nexus/factory-domain/ports/provider'
import { PAYMENT_OPERATIONS, type PaymentProviderPort, type ProviderIntent, type ProviderIntentRequest, type ProviderState } from '@nexus/factory-domain/payments/online/port'
import { accountRefusal } from '@nexus/factory-domain/payments/online/rules'
import { FakePaymentProvider } from '../../../adapters/payment-fake/fake'
import { stripeAdapter } from '../../../adapters/stripe/stripe'
import type { CommandCaller } from '../../../core/command'
import { loadFactoryEnv } from '../../../env'
import { gatewayAccount, ProviderError, type Gateway } from '../../../platform/gateway/gateway'
import { processGateway } from '../../../platform/gateway/service'

/**
 * The payment provider behind the gateway (B-W2b-185; plan A1 §4; Commerce hard rule 4 for the factory). Each operation is
 * ONE gateway call for the payment account — re-read and checked (mode, the PAUSED kill switch, circuit, rate limit),
 * recorded as one IntegrationCall row — and inside it the adapter of the account's mode: FAKE → the fake (adapters/
 * payment-fake; local and test only), LIVE and SANDBOX of provider STRIPE → Stripe's API (adapters/stripe), a LIVE one only
 * once GATE-SPEND is lifted (factory-domain payments/online/rules accountRefusal). Only office sessions and the system call
 * it: a link or portal session starts a payment through its tenant's system caller. Never inside a command's transaction.
 */

export interface PaymentsRuntime {
  readonly environment: string
  /** The FAKE of this process (local and test), or null. */
  readonly fake: FakePaymentProvider | null
  createIntent(caller: CommandCaller, accountId: string, request: ProviderIntentRequest): Promise<ProviderIntent>
  retrieveIntent(caller: CommandCaller, accountId: string, providerRef: string): Promise<ProviderIntent>
  cancelIntent(caller: CommandCaller, accountId: string, providerRef: string): Promise<{ readonly state: ProviderState }>
}

export interface PaymentsRuntimeOptions {
  readonly gateway: Gateway
  readonly environment: string
  readonly fake: FakePaymentProvider | null
  /** LIVE and SANDBOX Stripe accounts; default Stripe's REST API. */
  readonly stripe?: PaymentProviderPort
}

export function createPaymentsRuntime(options: PaymentsRuntimeOptions): PaymentsRuntime {
  const stripe = options.stripe ?? stripeAdapter()
  function adapterFor(account: AdapterAccount): PaymentProviderPort {
    // The gateway read the account again; its state may have changed since the page was shown.
    const refused = accountRefusal({ provider: account.provider, mode: account.mode, status: 'ACTIVE' }, options.environment)
    if (refused) throw new ProviderError(`This payment account may not take payments (${refused}).`, { retryable: false })
    if (account.mode === 'FAKE') {
      if (!options.fake) throw new ProviderError('A FAKE payment account needs the fake provider, which this environment does not have.', { retryable: false })
      return options.fake
    }
    return stripe
  }
  return Object.freeze({
    environment: options.environment,
    fake: options.fake,
    createIntent: (caller, accountId, request) =>
      options.gateway.call(
        gatewayAccount(caller, accountId),
        { ...PAYMENT_OPERATIONS.createIntent, idempotencyKey: request.intentId, request: { intentId: request.intentId, method: request.method, currency: request.currency } },
        (call) => adapterFor(call.account).createIntent(call, request),
      ),
    retrieveIntent: (caller, accountId, providerRef) =>
      options.gateway.call(gatewayAccount(caller, accountId), { ...PAYMENT_OPERATIONS.retrieveIntent, request: { providerRef } }, (call) => adapterFor(call.account).retrieveIntent(call, providerRef)),
    cancelIntent: (caller, accountId, providerRef) =>
      options.gateway.call(gatewayAccount(caller, accountId), { ...PAYMENT_OPERATIONS.cancelIntent, idempotencyKey: `cancel:${providerRef}`, request: { providerRef } }, (call) => adapterFor(call.account).cancelIntent(call, providerRef)),
  } satisfies PaymentsRuntime)
}

let configured: PaymentsRuntime | undefined
let fromEnv: PaymentsRuntime | undefined

/** Sets the runtime (tests); undefined goes back to the one made from the environment. */
export function usePayments(runtime: PaymentsRuntime | undefined): void {
  configured = runtime
}

export function processPayments(): PaymentsRuntime {
  if (configured) return configured
  if (!fromEnv) {
    const env = loadFactoryEnv()
    const local = env.FACTORY_ENV === 'local' || env.FACTORY_ENV === 'test'
    fromEnv = createPaymentsRuntime({ gateway: processGateway(), environment: env.FACTORY_ENV, fake: local ? new FakePaymentProvider() : null })
  }
  return fromEnv
}
