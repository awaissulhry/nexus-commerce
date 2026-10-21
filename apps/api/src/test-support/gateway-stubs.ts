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
/** Google Ads customers NOT chosen for their connection's business (`${connectionId}:${customerId}`); every other is. */
export const gatewayGoogleUnlinked = new Set<string>()
/** Merchant Center accounts NOT chosen for their connection's business (`${connectionId}:${merchantId}`); every other is. */
export const gatewayMerchantUnlinked = new Set<string>()
/** Merchant Center data sources Nexus did NOT make (`${merchantId}:${dataSourceId}`); every other is Nexus's. */
export const gatewayMerchantForeignSources = new Set<string>()
export const gatewayLedger: GatewayLedgerRow[] = []
/** Meta step 17: the ad account each Meta connection chose (`connectionId` → digits); a connection not here chose `1234567890`. */
export const gatewayMetaChosen: Record<string, string | null> = {}
/** Meta step 17: Meta objects in this business's stored rows (`objectId` → account and kind); every other is not stored. */
export const gatewayMetaStored: Record<string, { adAccountId: string; kind: 'campaign' | 'adset' | 'ad' }> = {}
/** Meta step 19: the Facebook Page each connection chose (`connectionId` → Page id); none unless a test sets it. */
export const gatewayMetaPage: Record<string, string> = {}
/** Meta step 21: the Instagram account each connection chose (`connectionId` → id); none unless a test sets it. */
export const gatewayMetaInstagram: Record<string, string> = {}

export const accountModule = {
  accountStatusOf: async (id: string): Promise<GatewayAccountState | null> =>
    id in gatewayAccounts ? gatewayAccounts[id] : { authStatus: 'connected', isActive: true, displayName: `Test account ${id}` },
  googleAdsCustomerLinked: async (connectionId: string, customerId: string): Promise<boolean> => !gatewayGoogleUnlinked.has(`${connectionId}:${customerId}`),
  googleMerchantAccountLinked: async (connectionId: string, merchantId: string): Promise<boolean> => !gatewayMerchantUnlinked.has(`${connectionId}:${merchantId}`),
  googleMerchantDataSourceNexusMade: async (merchantId: string, dataSourceId: string): Promise<boolean> => !gatewayMerchantForeignSources.has(`${merchantId}:${dataSourceId}`),
  metaChosenAdAccountOf: async (connectionId: string): Promise<string | null> => (connectionId in gatewayMetaChosen ? gatewayMetaChosen[connectionId] : '1234567890'),
  metaStoredObject: async (objectId: string): Promise<{ adAccountId: string; kind: 'campaign' | 'adset' | 'ad' } | null> => gatewayMetaStored[objectId] ?? null,
  // Meta step 19: the chosen Facebook Page of a connection (a test sets gatewayMetaPage[connectionId]).
  metaChosenPageOf: async (connectionId: string): Promise<string | null> => gatewayMetaPage[connectionId] ?? null,
  // Meta step 21: the chosen Instagram account of a connection (a test sets gatewayMetaInstagram[connectionId]).
  metaChosenInstagramOf: async (connectionId: string): Promise<string | null> => gatewayMetaInstagram[connectionId] ?? null,
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
