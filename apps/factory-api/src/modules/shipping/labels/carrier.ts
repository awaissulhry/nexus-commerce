import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { CARRIER_OPERATIONS, type CarrierLabel, type CarrierLabelRequest, type CarrierPort, type CarrierTrackingEvent, type LabelDocument, type LabelFormat, type TrackedLabel, type VoidOutcome } from '@nexus/factory-domain/ports/carrier'
import type { AdapterAccount } from '@nexus/factory-domain/ports/provider'
import type { LabelEnvironment } from '@nexus/factory-domain/shipping/labels/labels'
import { FakeSendcloud } from '../../../adapters/sendcloud/fake'
import { sendcloudAdapter } from '../../../adapters/sendcloud/sendcloud'
import type { CommandCaller } from '../../../core/command'
import { loadFactoryEnv } from '../../../env'
import { gatewayAccount, GatewayCallFailed, GatewayRefusal, ProviderError, type Gateway } from '../../../platform/gateway/gateway'
import { processGateway } from '../../../platform/gateway/service'

/**
 * The carrier behind the gateway (B-W1-48; plan A1 §4; Commerce hard rule 4 for the factory). Each carrier operation is
 * ONE gateway call for the shipment's Sendcloud account — re-read and checked (mode, the PAUSED kill switch, circuit,
 * rate limit), recorded as one IntegrationCall row — and inside it the adapter of the account's mode: FAKE → the fake
 * (adapters/sendcloud/fake.ts; local and test only), LIVE and SANDBOX → Sendcloud's API v3 (adapters/sendcloud/
 * sendcloud.ts). Only office sessions and the system call it (the gateway refuses floor callers). Never inside a
 * command's transaction.
 *
 *   carrier.create_label    carrier.label_document    carrier.void_label    carrier.tracking
 */

export interface CarrierRuntime {
  readonly environment: LabelEnvironment
  /** The FAKE of this process (local and test), or null. */
  readonly fake: FakeSendcloud | null
  createLabel(caller: CommandCaller, accountId: string, request: CarrierLabelRequest): Promise<CarrierLabel>
  labelDocument(caller: CommandCaller, accountId: string, providerId: string, format: LabelFormat): Promise<LabelDocument>
  voidLabel(caller: CommandCaller, accountId: string, providerId: string): Promise<VoidOutcome>
  tracking(caller: CommandCaller, accountId: string, label: TrackedLabel): Promise<readonly CarrierTrackingEvent[]>
}

export interface CarrierRuntimeOptions {
  readonly gateway: Gateway
  readonly environment: LabelEnvironment
  readonly fake: FakeSendcloud | null
  /** LIVE and SANDBOX accounts; default Sendcloud's API v3. */
  readonly remote?: CarrierPort
}

export function createCarrierRuntime(options: CarrierRuntimeOptions): CarrierRuntime {
  const remote = options.remote ?? sendcloudAdapter()
  function adapterFor(account: AdapterAccount): CarrierPort {
    if (account.provider !== 'SENDCLOUD') throw new ProviderError('This account is not a Sendcloud account.', { retryable: false })
    if (account.mode !== 'FAKE') return remote
    if (!options.fake) throw new ProviderError('A FAKE Sendcloud account needs the fake Sendcloud, which this environment does not have.', { retryable: false })
    return options.fake
  }
  return Object.freeze({
    environment: options.environment,
    fake: options.fake,
    createLabel: (caller, accountId, request) =>
      options.gateway.call(
        gatewayAccount(caller, accountId),
        { ...CARRIER_OPERATIONS.createLabel, idempotencyKey: request.externalReference, request: { shipmentNumber: request.shipmentNumber, seq: request.seq, serviceCode: request.serviceCode, carrierCode: request.carrierCode, weightKg: request.weightKg } },
        (call) => adapterFor(call.account).createLabel(call, request),
      ),
    labelDocument: (caller, accountId, providerId, format) =>
      options.gateway.call(gatewayAccount(caller, accountId), { ...CARRIER_OPERATIONS.labelDocument, request: { providerId, format } }, (call) => adapterFor(call.account).labelDocument(call, providerId, format)),
    voidLabel: (caller, accountId, providerId) =>
      options.gateway.call(gatewayAccount(caller, accountId), { ...CARRIER_OPERATIONS.voidLabel, idempotencyKey: `void:${providerId}`, request: { providerId } }, (call) => adapterFor(call.account).voidLabel(call, providerId)),
    tracking: (caller, accountId, label) =>
      options.gateway.call(gatewayAccount(caller, accountId), { ...CARRIER_OPERATIONS.tracking, request: { providerId: label.providerId } }, (call) => adapterFor(call.account).tracking(call, label)),
  } satisfies CarrierRuntime)
}

let configured: CarrierRuntime | undefined
let fromEnv: CarrierRuntime | undefined

/** Sets the runtime (tests); undefined goes back to the one made from the environment. */
export function useCarrier(runtime: CarrierRuntime | undefined): void {
  configured = runtime
}

export function processCarrier(): CarrierRuntime {
  if (configured) return configured
  if (!fromEnv) {
    const env = loadFactoryEnv()
    const local = env.FACTORY_ENV === 'local' || env.FACTORY_ENV === 'test'
    fromEnv = createCarrierRuntime({ gateway: processGateway(), environment: env.FACTORY_ENV, fake: local ? new FakeSendcloud() : null })
  }
  return fromEnv
}

/**
 * Why a carrier call did not give what was asked, in plain words for the office (no secret: the gateway scrubbed the
 * account's values from its messages). A domain error (the account is gone) keeps its own words.
 */
export function carrierProblem(error: unknown): string {
  if (error instanceof GatewayRefusal) {
    switch (error.reason) {
      case 'account_paused':
        return 'The Sendcloud connection is paused (the kill switch): nothing was sent.'
      case 'account_disabled':
        return 'The Sendcloud connection is disabled: nothing was sent.'
      case 'fake_in_production':
        return 'The Sendcloud connection is a FAKE one, which production never calls: nothing was sent.'
      case 'circuit_open':
        return 'Sendcloud failed several calls in a row; the connection rests a moment: try again shortly.'
      case 'rate_limited':
        return 'Too many Sendcloud calls just now: try again shortly.'
      default:
        return 'The gateway cannot reach its limits right now: nothing was sent, try again shortly.'
    }
  }
  if (error instanceof GatewayCallFailed) {
    if (error.kind === 'timeout') return 'Sendcloud did not answer in time.'
    if (error.kind === 'network_error') return 'Sendcloud could not be reached.'
    return error.message.replace(/^[a-z_.]+ failed after \d+ attempt\(s\): /, '').replace(/^Sendcloud answered \d+: /, 'Sendcloud refused it: ')
  }
  if (error instanceof NotFoundError) return 'The Sendcloud connection is gone.'
  if (error instanceof ProviderError) return error.message
  throw error
}

/** The carrier call threw a final refusal (a 4xx it answered), as opposed to "try again". */
export const isCarrierRefusal = (error: unknown): boolean => error instanceof GatewayCallFailed && error.kind === 'provider_error' && !error.retryable
