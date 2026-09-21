/**
 * P4.6b — account-scoped WRITES to Etsy Open API v3, through the channel gateway.
 *
 * Until P4.6 the only Etsy writer was the legacy env-credential service, and the connected-account
 * client could only read. This is the writer every P4.6 flow uses: it names its account, takes its
 * token from the token service, carries the app key header, and passes the push lock through to the
 * gateway so a paused, closed or ended listing is never written to.
 *
 * ## What this file does NOT do
 *
 * It does not decide *whether* a write may be sent. The gateway does: the publish mode (P4.6a), the
 * account's sign-in state, the push lock, the rate bucket and the ledger row are all its steps, and
 * putting a second opinion here is how the two drift. This file is the transport and Etsy's own
 * rules about it.
 *
 * ## Etsy's rules that ARE here
 *
 * 1. **`kind` is chosen per operation, not per file.** A listing change is a `write` and answers to
 *    the Etsy publish mode. An order action — marking a receipt shipped — is an `action`, which by
 *    the gateway's contract has its own switch at the call site (the P0.1 pattern:
 *    `NEXUS_ENABLE_*_SHIP_CONFIRM`). Sending a shipment notice is not publishing a listing, and one
 *    switch must not silently govern both.
 * 2. **Only PUT and DELETE are repeatable.** Etsy offers no idempotency key, so a POST or PATCH is
 *    never retried after a transport failure — `maxTransientRetries: 0`. A retried
 *    `uploadListingImage` is a duplicate image; a retried `createReceiptShipment` is a second
 *    tracking number on the buyer's order. The banked rule from P4.5: a transport failure is an
 *    UNKNOWN outcome, not a failure, so the safe move is to stop and let a human or a later
 *    reconcile look.
 */
import { getAccessToken } from '../cx/token.service.js'
import { gatewayCall, GatewayNoAnswer, type GatewayRequest, type GatewayResponse } from '../gateway/gateway.js'
import { assertEtsyPath, etsyAccount, etsyOperation, type EtsyAccount } from './account.js'

const API_BASE = 'https://api.etsy.com/v3/application'

export interface EtsyWriteInput {
  /** A path on the Open API, e.g. `/shops/42/listings/7` or `/listings/7/inventory`. */
  path: string
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** A JSON body, or FormData for an image upload. */
  body?: unknown
  /**
   * `write` — a listing change (content, stock, price, images). Governed by the Etsy publish mode.
   * `action` — an order or buyer action. The caller owns its switch; the publish mode does not apply.
   */
  kind?: 'write' | 'action'
  /** The listings this write touches, so the gateway's push lock can refuse a paused or ended one. */
  pushLock?: GatewayRequest['pushLock']
  ledger?: GatewayRequest['ledger']
  /** Override the ledger operation name when the path alone does not say what the call means. */
  operation?: string
  timeoutMs?: number
}

export class EtsyWriteError extends Error {
  constructor(readonly status: number, readonly body: string, message: string) {
    super(message)
    this.name = 'EtsyWriteError'
  }
}

/**
 * A write client bound to one Etsy account. `send` returns Etsy's parsed answer, or throws:
 * `GatewayRefusal` when the gateway held it (gated, dry run, push lock, needs sign-in), or
 * `EtsyWriteError` when Etsy itself refused.
 */
export async function etsyWriter(accountId: string): Promise<{
  account: EtsyAccount
  shopId: string
  send: <T = unknown>(input: EtsyWriteInput) => Promise<T>
  raw: (input: EtsyWriteInput) => Promise<GatewayResponse>
}> {
  const account = await etsyAccount(accountId)

  const raw = async (input: EtsyWriteInput): Promise<GatewayResponse> => {
    assertEtsyPath(input.path)
    const token = await getAccessToken(accountId)
    const isForm = typeof FormData !== 'undefined' && input.body instanceof FormData
    // Etsy has no idempotency key, so only the two methods HTTP itself calls repeatable are retried.
    const repeatable = input.method === 'PUT' || input.method === 'DELETE'
    const response = await gatewayCall({
      channel: 'ETSY',
      operation: input.operation ?? etsyOperation(input.method, input.path),
      kind: input.kind ?? 'write',
      connectionId: accountId,
      url: `${API_BASE}${input.path}`,
      method: input.method,
      headers: { 'x-api-key': account.apiKey, ...(isForm || input.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: input.body === undefined ? null : isForm ? (input.body as FormData) : JSON.stringify(input.body),
      auth: { token },
      idempotent: repeatable,
      maxTransientRetries: repeatable ? 1 : 0,
      pushLock: input.pushLock,
      ledger: input.ledger,
      timeoutMs: input.timeoutMs ?? 30_000,
    })
    // `gatewayCall` reports "no answer at all" as status 0. For a WRITE that is not a failure — the
    // change may have landed — so it is raised as its own error rather than read as a refusal.
    // (Banked: a transport failure is an UNKNOWN outcome.)
    if (response.status === 0) {
      throw new GatewayNoAnswer('ETSY', input.operation ?? etsyOperation(input.method, input.path),
        response.verdict?.errorClass === 'timeout' ? 'timeout' : 'network', response.text)
    }
    return response
  }

  const send = async <T = unknown>(input: EtsyWriteInput): Promise<T> => {
    const response = await raw(input)
    if (!response.ok) {
      // Etsy's error bodies are `{"error":"…"}`; the sentence is shown to an operator, so it names
      // the shop-facing cause when Etsy gave one rather than only a status number.
      const said = etsyErrorSentence(response.text)
      throw new EtsyWriteError(
        response.status,
        response.text,
        `Etsy refused this change (HTTP ${response.status})${said ? `: ${said}` : ''}.${response.status === 429 ? ' Retry after the Etsy rate limit resets.' : ''}`,
      )
    }
    return (response.json<T>() ?? null) as T
  }

  return { account, shopId: account.shopId, send, raw }
}

/** Etsy's own words from an error body, capped. Returns null when the body says nothing useful. */
export function etsyErrorSentence(body: string): string | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown }
    const said = typeof parsed.error === 'string' ? parsed.error : typeof parsed.error_description === 'string' ? parsed.error_description : null
    return said ? said.slice(0, 300) : null
  } catch {
    return null
  }
}
