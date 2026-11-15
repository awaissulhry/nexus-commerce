import type { AdapterAccount } from '@nexus/factory-domain/ports/provider'
import type { LabelEnvironment } from '@nexus/factory-domain/shipping/labels/labels'
import { PICKUP_OPERATIONS, type PickupBooked, type PickupBookingRequest, type PickupCancelOutcome, type PickupPort } from '@nexus/factory-domain/shipping/pickups/port'
import { FakeSendcloudPickups, sendcloudPickupsAdapter } from '../../../adapters/sendcloud/pickups'
import type { CommandCaller } from '../../../core/command'
import { loadFactoryEnv } from '../../../env'
import { gatewayAccount, ProviderError, type Gateway } from '../../../platform/gateway/gateway'
import { processGateway } from '../../../platform/gateway/service'

/**
 * Carrier pickups behind the gateway (B-W2b-395; LOG-048; plan A1 §4): each pickup operation is ONE gateway call for the
 * company's Sendcloud account (re-read and checked: mode, the PAUSED kill switch, circuit, rate limit; one IntegrationCall
 * row), and inside it the adapter of the account's mode: FAKE → the fake (local and test only), LIVE and SANDBOX → Sendcloud's
 * API v3 (adapters/sendcloud/pickups.ts). Office sessions and the system call it, never a floor one. Never inside a command's
 * transaction. A site in test mode never reaches it: the TEST pickup answers in the process (pickups.ts).
 *
 *   carrier.book_pickup (tried once)    carrier.cancel_pickup
 */

export interface PickupRuntime {
  readonly environment: LabelEnvironment
  /** The FAKE of this process (local and test), or null. */
  readonly fake: FakeSendcloudPickups | null
  book(caller: CommandCaller, accountId: string, pickupId: string, request: PickupBookingRequest): Promise<PickupBooked>
  cancel(caller: CommandCaller, accountId: string, pickupId: string, providerReference: string): Promise<PickupCancelOutcome>
}

export interface PickupRuntimeOptions {
  readonly gateway: Gateway
  readonly environment: LabelEnvironment
  readonly fake: FakeSendcloudPickups | null
  /** LIVE and SANDBOX accounts; default Sendcloud's API v3. */
  readonly remote?: PickupPort
}

export function createPickupRuntime(options: PickupRuntimeOptions): PickupRuntime {
  const remote = options.remote ?? sendcloudPickupsAdapter()
  function adapterFor(account: AdapterAccount): PickupPort {
    if (account.provider !== 'SENDCLOUD') throw new ProviderError('This account is not a Sendcloud account.', { retryable: false })
    if (account.mode !== 'FAKE') return remote
    if (!options.fake) throw new ProviderError('A FAKE Sendcloud account needs the fake Sendcloud, which this environment does not have.', { retryable: false })
    return options.fake
  }
  return Object.freeze({
    environment: options.environment,
    fake: options.fake,
    book: (caller, accountId, pickupId, request) =>
      options.gateway.call(
        gatewayAccount(caller, accountId),
        { ...PICKUP_OPERATIONS.book, idempotencyKey: `pickup:${pickupId}`, request: { pickupId, carrierCode: request.carrierCode, readyFrom: request.readyFrom, parcels: request.parcels, pallets: request.pallets } },
        (call) => adapterFor(call.account).book(call, request),
      ),
    cancel: (caller, accountId, pickupId, providerReference) =>
      options.gateway.call(gatewayAccount(caller, accountId), { ...PICKUP_OPERATIONS.cancel, idempotencyKey: `pickup-cancel:${pickupId}`, request: { pickupId } }, (call) => adapterFor(call.account).cancel(call, providerReference)),
  } satisfies PickupRuntime)
}

let configured: PickupRuntime | undefined
let fromEnv: PickupRuntime | undefined

/** Sets the runtime (tests); undefined goes back to the one made from the environment. */
export function usePickups(runtime: PickupRuntime | undefined): void {
  configured = runtime
}

export function processPickups(): PickupRuntime {
  if (configured) return configured
  if (!fromEnv) {
    const env = loadFactoryEnv()
    const local = env.FACTORY_ENV === 'local' || env.FACTORY_ENV === 'test'
    fromEnv = createPickupRuntime({ gateway: processGateway(), environment: env.FACTORY_ENV, fake: local ? new FakeSendcloudPickups() : null })
  }
  return fromEnv
}
