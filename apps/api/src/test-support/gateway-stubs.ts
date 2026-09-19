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
