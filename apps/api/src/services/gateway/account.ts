/**
 * P1.1 step 2 — the account's state, read fresh for every call. Its own module so a unit test of a
 * channel client can stand it in with one line (test-support/gateway-stubs.ts).
 */
import prisma from '../../db.js'
import { MERCHANT_DATA_SOURCES_TOOL } from './google-merchant-calls.js'

export interface GatewayAccountState { authStatus: string; isActive: boolean; displayName: string | null }

export async function accountStatusOf(connectionId: string): Promise<GatewayAccountState | null> {
  return prisma.channelConnection.findUnique({ where: { id: connectionId }, select: { authStatus: true, isActive: true, displayName: true } })
}

/**
 * Google Ads changes (2026-10-15): is this Google Ads customer the Ads account a person chose for the business, through
 * this Google connection? Read in the business the call runs in (row-level security), so a customer another business
 * chose is never one.
 */
export async function googleAdsCustomerLinked(connectionId: string, customerId: string): Promise<boolean> {
  const link = await prisma.googleAccountLink.findFirst({ where: { connectionId, product: 'ADS', externalId: customerId }, select: { id: true } })
  return link !== null
}

/**
 * Merchant Center (G12, 2026-10-16): is this Merchant Center account the one a person chose for the business, through this
 * Google connection (its GoogleAccountLink, product MERCHANT)? Read in the business the call runs in (row-level security),
 * so an account another business chose is never one: a Merchant Center id never crosses businesses.
 */
export async function googleMerchantAccountLinked(connectionId: string, merchantId: string): Promise<boolean> {
  const link = await prisma.googleAccountLink.findFirst({ where: { connectionId, product: 'MERCHANT', externalId: merchantId }, select: { id: true } })
  return link !== null
}

/**
 * Merchant Center (G12): did Nexus make this data source, in this Merchant Center account, for the business the call runs
 * in? Its create is in Nexus's own change records (AgentChange of set-google-merchant-data-sources with after.created,
 * row-level security: only this business's rows). Every Merchant change but a create must name one (gateway.ts).
 */
export async function googleMerchantDataSourceNexusMade(merchantId: string, dataSourceId: string): Promise<boolean> {
  const row = await prisma.agentChange.findFirst({
    where: {
      toolName: MERCHANT_DATA_SOURCES_TOOL,
      AND: [
        { after: { path: ['created'], equals: true } },
        { after: { path: ['merchantCenterId'], equals: merchantId } },
        { after: { path: ['dataSourceId'], equals: dataSourceId } },
      ],
    },
    select: { id: true },
  })
  return row !== null
}

/**
 * Meta step 17 (write base): the ad account this business chose through this Meta connection (its AD_ACCOUNT
 * MetaAccountLink, digits only), or null. Read in the business the call runs in (row-level security): an account another
 * business chose is never this one (a Meta id belongs to one business: MetaAccountLink is unique on product + id).
 */
export async function metaChosenAdAccountOf(connectionId: string): Promise<string | null> {
  const link = await prisma.metaAccountLink.findFirst({ where: { connectionId, product: 'AD_ACCOUNT' }, select: { externalId: true } })
  return link?.externalId ?? null
}

/** Meta step 19: the Facebook Page this business chose through this connection (its PAGE MetaAccountLink), or null. */
export async function metaChosenPageOf(connectionId: string): Promise<string | null> {
  const link = await prisma.metaAccountLink.findFirst({ where: { connectionId, product: 'PAGE' }, select: { externalId: true } })
  return link?.externalId ?? null
}

/** Meta step 21: the Instagram account this business chose through this connection (its INSTAGRAM MetaAccountLink), or null. */
export async function metaChosenInstagramOf(connectionId: string): Promise<string | null> {
  const link = await prisma.metaAccountLink.findFirst({ where: { connectionId, product: 'INSTAGRAM' }, select: { externalId: true } })
  return link?.externalId ?? null
}

/** The kinds of Meta object Nexus's daily read stores (and a change by object id may name). */
export type MetaStoredKind = 'campaign' | 'adset' | 'ad'

/**
 * Meta step 17: which ad account a Meta object belongs to, from this business's own rows of its daily read (row-level
 * security: another business's rows are never read), with its kind. Null when Nexus has not read it for this business —
 * the gateway then asks Meta once (`GET /<id>?fields=account_id`).
 */
export async function metaStoredObject(objectId: string): Promise<{ adAccountId: string; kind: MetaStoredKind } | null> {
  const [campaign, adSet, ad] = await Promise.all([
    prisma.metaAdsCampaign.findFirst({ where: { campaignId: objectId }, select: { adAccountId: true } }),
    prisma.metaAdsAdSet.findFirst({ where: { adSetId: objectId }, select: { adAccountId: true } }),
    prisma.metaAdsAd.findFirst({ where: { adId: objectId }, select: { adAccountId: true } }),
  ])
  if (campaign) return { adAccountId: campaign.adAccountId, kind: 'campaign' }
  if (adSet) return { adAccountId: adSet.adAccountId, kind: 'adset' }
  if (ad) return { adAccountId: ad.adAccountId, kind: 'ad' }
  return null
}

/**
 * Meta step 23 (create-meta-media): the business portfolio of the ad account this business chose through this Meta
 * connection (as Meta named it when the account was chosen: the AD_ACCOUNT link's metadata.businessId), or null. Read in
 * the business the call runs in (row-level security): another business's choice is never this one. (The chosen Instagram
 * account is step 21's metaChosenInstagramOf.)
 */
export async function metaChosenPortfolioOf(connectionId: string): Promise<string | null> {
  const link = await prisma.metaAccountLink.findFirst({ where: { connectionId, product: 'AD_ACCOUNT' }, select: { metadata: true } })
  const meta = link?.metadata
  const portfolio = meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as { businessId?: unknown }).businessId : null
  return typeof portfolio === 'string' && /^\d{1,20}$/.test(portfolio) ? portfolio : null
}

/**
 * Meta step 23: is this business portfolio also that of ANOTHER business's chosen ad account (nexus_meta_links_taken
 * PORTFOLIO, step 10)? Then its media library is that business's too, and no Nexus change writes there.
 */
export async function metaPortfolioShared(portfolioId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT t.id FROM nexus_meta_links_taken('PORTFOLIO', ${[portfolioId]}::text[]) AS t(id)`
  return rows.some((row) => row.id === portfolioId)
}
