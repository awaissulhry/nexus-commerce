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
/** Meta step 23: business portfolios another business's chosen ad account is of. */
export const gatewayMetaSharedPortfolios = new Set<string>()
/** Meta step 25: Pages and Instagram accounts another business chose (`PAGE:<id>`, `INSTAGRAM:<id>`). */
export const gatewayMetaTakenLinks = new Set<string>()
/** Meta step 36: what Nexus's change records say it made on a Page (`${kind}:${objectId}:${pageId}`); nothing else is. */
export const gatewayMetaNexusMade = new Set<string>()

/** Meta step 24: the posts, media and containers Nexus's change records say it made (`${kind}:${objectId}:${ownerId}`). */
export const gatewayMetaPostsMade = new Set<string>()

/** Meta step 39: each connection's chosen ad account's business portfolio; a connection not here has `9876543210`. */
export const gatewayMetaPortfolio: Record<string, string | null> = {}

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
  // Meta step 23: whether another business's chosen ad account shares this business portfolio.
  metaPortfolioShared: async (portfolioId: string): Promise<boolean> => gatewayMetaSharedPortfolios.has(portfolioId),
  // Meta step 25: whether another business chose this Page or Instagram account.
  metaLinkTaken: async (product: 'PAGE' | 'INSTAGRAM', id: string): Promise<boolean> => gatewayMetaTakenLinks.has(`${product}:${id}`),
  metaChosenPortfolioOf: async (connectionId: string): Promise<string | null> => (connectionId in gatewayMetaPortfolio ? gatewayMetaPortfolio[connectionId] : '9876543210'),
  metaPageObjectNexusMade: async (kind: 'leadform' | 'testlead' | 'canvas', objectId: string, pageId: string): Promise<boolean> => gatewayMetaNexusMade.has(`${kind}:${objectId}:${pageId}`),
  META_LEAD_FORM_CREATE_TOOL: 'create-meta-lead-form',
  META_LEAD_FORM_SET_TOOL: 'set-meta-lead-form',
  // Meta step 27b: the Instant Experience tools.
  META_IX_CREATE_TOOL: 'create-meta-instant-experience',
  META_IX_SET_TOOL: 'set-meta-instant-experience',
  // Meta step 37: the comment tool.
  META_COMMENTS_TOOL: 'set-meta-comments',
  // Meta step 24: the post tools and what their records say Nexus made.
  META_PAGE_POST_CREATE_TOOL: 'create-meta-page-post',
  META_IG_POST_CREATE_TOOL: 'create-meta-instagram-post',
  // Keys `${kind}:${id}:${owner}`; a video post's video: `pagevideo:${videoId}:${pageId}` (B-F2).
  metaPostNexusMade: async (kind: 'pagepost' | 'pagevideo' | 'igmedia' | 'igcontainer', objectId: string, ownerId: string): Promise<boolean> => gatewayMetaPostsMade.has(`${kind}:${objectId}:${ownerId}`),
  // Meta step 24 (re-review N1): a video post's video by its post (`pagepostvideo:${postId}:${pageId}:${videoId}`).
  metaPagePostVideoOf: async (postId: string, pageId: string): Promise<string | null> => [...gatewayMetaPostsMade].find((k) => k.startsWith(`pagepostvideo:${postId}:${pageId}:`))?.split(':')[3] ?? null,
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
