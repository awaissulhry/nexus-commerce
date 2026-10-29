import type { IntegrationMode } from '@nexus/factory-domain/ports/provider'
import { SDI_OPERATIONS, type SdiArchiveReceipt, type SdiArchiveRequest, type SdiMessage, type SdiSendReceipt, type SdiSendRequest, type SdiStatusAnswer, type SdiStatusRequest } from '@nexus/factory-domain/ports/sdi'
import type { AdapterAccount } from '@nexus/factory-domain/ports/provider'
import { failureReasonOf } from '@nexus/factory-domain/invoicing/sdi/states'
import { FakeSdi } from '../../../adapters/sdi/fake'
import { UNCHOSEN_SDI_PROVIDER, type SdiAdapter } from '../../../adapters/sdi/port'
import type { CommandCaller } from '../../../core/command'
import { loadFactoryEnv } from '../../../env'
import { gatewayAccount, GatewayCallFailed, GatewayRefusal, ProviderError, type Gateway } from '../../../platform/gateway/gateway'
import { processGateway } from '../../../platform/gateway/service'

/**
 * The process's SDI runtime (plan A1 §4; B-W1-50): each operation is ONE gateway call for the company's SDI account
 * (rate limit, circuit, timeout, retries of an idempotent operation, one IntegrationCall row), inside it the adapter of
 * the account's mode: FAKE → adapters/sdi/fake.ts (local and test only), LIVE and SANDBOX → the chosen provider's adapter
 * (none until Owner question Q21: every call is refused). Tests set their own with useSdi(createSdiRuntime({ … })).
 */

/** How a send ended at the provider: its receipt, or why it failed (a failureReason, `<CODE>: <words> (detail)`). */
export type SendResult = { readonly ok: true; readonly receipt: SdiSendReceipt } | { readonly ok: false; readonly failureReason: string }

export interface SdiRuntime {
  /** The send; a refusal or a failure is an answer (FAILED), never a throw. */
  send(caller: CommandCaller, accountId: string, request: SdiSendRequest): Promise<SendResult>
  /** What the provider knows of a send. Throws the gateway's GatewayRefusal or GatewayCallFailed. */
  status(caller: CommandCaller, accountId: string, request: SdiStatusRequest): Promise<SdiStatusAnswer>
  /** Legal archiving of a sent file. Throws the gateway's errors. */
  archive(caller: CommandCaller, accountId: string, request: SdiArchiveRequest): Promise<SdiArchiveReceipt>
  /** The notifications of a verified webhook body for an account in this mode. */
  webhookMessages(mode: IntegrationMode, body: string): SdiMessage[]
  /** The FAKE adapter of this process (local and test), or null. */
  readonly fake: FakeSdi | null
}

export interface SdiRuntimeOptions {
  readonly gateway: Gateway
  readonly fake: FakeSdi | null
  /** LIVE and SANDBOX accounts; default UNCHOSEN_SDI_PROVIDER (Q21). */
  readonly remote?: SdiAdapter
}

/** The failureReason of a send the gateway did not carry through. */
export function sendFailureOf(error: unknown): string | null {
  if (error instanceof GatewayRefusal) return failureReasonOf('NOT_SENT', `the SDI connection refused it: ${error.reason}`)
  if (error instanceof GatewayCallFailed) {
    // A 4xx is the provider's answer: it refused the file. A timeout, the network or a 5xx (after the retries): it may
    // have taken it.
    const refused = error.kind === 'provider_error' && error.httpStatus !== null && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 429
    return failureReasonOf(refused ? 'REFUSED' : 'NO_ANSWER', error.message)
  }
  return null
}

export function createSdiRuntime(options: SdiRuntimeOptions): SdiRuntime {
  const remote = options.remote ?? UNCHOSEN_SDI_PROVIDER
  function adapterFor(account: Pick<AdapterAccount, 'provider' | 'mode'>): SdiAdapter {
    if (account.provider !== 'SDI') throw new ProviderError('This account is not an SDI account.', { retryable: false })
    if (account.mode !== 'FAKE') return remote
    if (!options.fake) throw new ProviderError('A FAKE SDI account needs the fake SDI, which this environment does not have.', { retryable: false })
    return options.fake
  }
  return Object.freeze({
    fake: options.fake,
    async send(caller: CommandCaller, accountId: string, request: SdiSendRequest): Promise<SendResult> {
      try {
        const receipt = await options.gateway.call(
          gatewayAccount(caller, accountId),
          { ...SDI_OPERATIONS.send, idempotencyKey: request.idempotencyKey, request: { fileName: request.fileName, bytes: Buffer.byteLength(request.xml, 'utf8') } },
          (call) => adapterFor(call.account).send(call, request),
        )
        return { ok: true, receipt }
      } catch (error) {
        const failureReason = sendFailureOf(error)
        if (failureReason === null) throw error
        return { ok: false, failureReason }
      }
    },
    status: (caller: CommandCaller, accountId: string, request: SdiStatusRequest) =>
      options.gateway.call(gatewayAccount(caller, accountId), { ...SDI_OPERATIONS.status, idempotencyKey: request.idempotencyKey, request: { fileName: request.fileName, byRef: request.providerRef !== null } }, (call) =>
        adapterFor(call.account).status(call, request),
      ),
    archive: (caller: CommandCaller, accountId: string, request: SdiArchiveRequest) =>
      options.gateway.call(gatewayAccount(caller, accountId), { ...SDI_OPERATIONS.archive, idempotencyKey: `archive.${request.providerRef}`, request: { fileName: request.fileName } }, (call) =>
        adapterFor(call.account).archive(call, request),
      ),
    webhookMessages: (mode: IntegrationMode, body: string) => adapterFor({ provider: 'SDI', mode }).webhookMessages(body),
  } satisfies SdiRuntime)
}

let configured: SdiRuntime | undefined
let fromEnv: SdiRuntime | undefined

/** Sets the runtime (tests); undefined goes back to the one made from the environment. */
export function useSdi(runtime: SdiRuntime | undefined): void {
  configured = runtime
}

export function processSdi(): SdiRuntime {
  if (configured) return configured
  if (!fromEnv) {
    const env = loadFactoryEnv()
    const local = env.FACTORY_ENV === 'local' || env.FACTORY_ENV === 'test'
    fromEnv = createSdiRuntime({ gateway: processGateway(), fake: local ? new FakeSdi() : null })
  }
  return fromEnv
}
