/**
 * P1.2 — stand-ins for the channel gateway's two database touches, for unit tests of channel clients.
 *
 *   vi.mock('<rel>/services/gateway/account.js', () => import('<rel>/test-support/gateway-stubs.js').then((m) => m.accountModule))
 *   vi.mock('<rel>/services/gateway/ledger.js', () => import('<rel>/test-support/gateway-stubs.js').then((m) => m.ledgerModule))
 *
 * Every account is connected unless a test sets `gatewayAccounts[id]`; ledger rows land in
 * `gatewayLedger` (a test may assert them).
 */
import type { GatewayAccountState } from '../services/gateway/account.js'
import type { GatewayLedgerRow } from '../services/outbound-api-call-log.service.js'

export const gatewayAccounts: Record<string, GatewayAccountState | null> = {}
export const gatewayLedger: GatewayLedgerRow[] = []

export const accountModule = {
  accountStatusOf: async (id: string): Promise<GatewayAccountState | null> =>
    id in gatewayAccounts ? gatewayAccounts[id] : { authStatus: 'connected', isActive: true, displayName: `Test account ${id}` },
}
export const ledgerModule = {
  writeLedgerRow: async (row: GatewayLedgerRow): Promise<void> => { gatewayLedger.push(row) },
}

/**
 * A fake `fetch` answer as a real `Response` — for tests whose fake returns `{ ok, status, json }`: the
 * gateway reads the answer as a Response. Use: `vi.stubGlobal('fetch', (...a) => asResponse(fake(...a)))`.
 */
export async function asResponse(answer: unknown): Promise<Response> {
  const settled = await answer
  if (settled instanceof Response) return settled
  const o = (settled ?? {}) as { ok?: boolean; status?: number; json?: () => unknown; text?: () => unknown; headers?: Record<string, string> }
  const status = o.status ?? (o.ok === false ? 500 : 200)
  // A fake with both usually means json() is the answer and text() only served error reading.
  const body = o.json ? JSON.stringify(await o.json()) : o.text ? String(await o.text()) : ''
  return new Response(status === 204 || status === 304 ? null : body, { status, headers: o.headers })
}
