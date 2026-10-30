import type { SdiReceivedFile, SdiReceivedList, SdiReceivedListRequest } from '@nexus/factory-domain/payables/sdi-port'
import type { SdiArchiveReceipt, SdiArchiveRequest, SdiMessage, SdiSendReceipt, SdiSendRequest, SdiStatusAnswer, SdiStatusRequest } from '@nexus/factory-domain/ports/sdi'
import type { SignatureVerifier } from '@nexus/factory-domain/ports/signature'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'

/**
 * The SDI adapters' shape (plan A1 §4 "SdiPort"; the port's types: @nexus/factory-domain/ports/sdi). Each operation runs
 * INSIDE one gateway call (modules/invoicing/sdi/runtime.ts): the adapter gets the call (its account, attempt, abort
 * signal and the account's sealed credentials) and answers, or throws a ProviderError the gateway retries when it may
 * pass later (a 429, a 5xx, no answer; never a 4xx).
 *
 *   ./fake.ts        FAKE accounts (local and test only; the gateway refuses FAKE in production)
 *   ./<provider>.ts  LIVE and SANDBOX accounts: the intermediary the Owner picks with his accountant (A-Cube or
 *                    Openapi, question Q21). Until then `UNCHOSEN_SDI_PROVIDER` refuses every call, and its webhooks
 *                    never verify (`SDI_PROVIDER_VERIFIER`). The real adapter is ONE file implementing SdiAdapter (its
 *                    HTTP client, its webhook format in `webhook`) plus its verifier, wired in runtime.ts and
 *                    platform/inbound/providers.ts.
 */
export interface SdiAdapter {
  /** Sends the XML; the request's idempotency key makes a retry return the first send's receipt. */
  send(call: GatewayCall, request: SdiSendRequest): Promise<SdiSendReceipt>
  /** What the provider knows of a send: whether it has the file, and SDI's notifications so far. */
  status(call: GatewayCall, request: SdiStatusRequest): Promise<SdiStatusAnswer>
  /** Puts the sent file and its receipts in legal archiving (conservazione, DM 17.6.2014); idempotent. */
  archive(call: GatewayCall, request: SdiArchiveRequest): Promise<SdiArchiveReceipt>
  /** The notifications a verified webhook body holds, in the port's shape (the provider's format is the adapter's). */
  webhookMessages(body: string): SdiMessage[]
  /**
   * B-W2a-62, the passive side (factory-domain payables/sdi-port): the supplier invoices SDI delivered to the account's
   * company that the provider holds, delivered at or after `since` (a page of them). Read only.
   */
  listReceived(call: GatewayCall, request: SdiReceivedListRequest): Promise<SdiReceivedList>
  /** One delivered supplier invoice: its FatturaPA XML (out of its signed envelope), by the provider's id. Read only. */
  getReceived(call: GatewayCall, providerRef: string): Promise<SdiReceivedFile>
}

const UNCHOSEN = 'No SDI intermediary is chosen yet (Owner question Q21): a LIVE or SANDBOX SDI account cannot be called until its adapter exists.'

/** LIVE and SANDBOX accounts until the provider is chosen: every call is refused (final, nothing sent). */
export const UNCHOSEN_SDI_PROVIDER: SdiAdapter = Object.freeze({
  send: async () => {
    throw new ProviderError(UNCHOSEN, { retryable: false })
  },
  status: async () => {
    throw new ProviderError(UNCHOSEN, { retryable: false })
  },
  archive: async () => {
    throw new ProviderError(UNCHOSEN, { retryable: false })
  },
  webhookMessages: () => {
    throw new Error(UNCHOSEN)
  },
  listReceived: async () => {
    throw new ProviderError(UNCHOSEN, { retryable: false })
  },
  getReceived: async () => {
    throw new ProviderError(UNCHOSEN, { retryable: false })
  },
})

/** The webhooks of LIVE and SANDBOX SDI accounts: none verifies until the provider's verifier exists (FAKE accounts use the fake one). */
export const SDI_PROVIDER_VERIFIER: SignatureVerifier = Object.freeze({
  verify: () => ({ ok: false as const, reason: 'no_sdi_provider' }),
})
