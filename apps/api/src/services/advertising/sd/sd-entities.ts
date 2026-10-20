/**
 * Sponsored Display extras (P3c) — the Sponsored Display campaigns and ad groups of this business as Claude's SD rule,
 * budget and forecast tools name them (agents/tools/ads-sd-*.tools.ts): Nexus's id in, Amazon's id, market, budget and
 * product ads out. Advertising's own tables are read here, inside the advertising context (scripts/check-context-boundary.mjs).
 *
 * Each lookup answers the row, or why it cannot be used, in a sentence ("not found in this business" first, so a request
 * aimed at another business is refused as not found before anything else is said).
 */
import prisma from '../../../db.js'
import { adProductOf, SPONSORED_DISPLAY } from '@nexus/shared/ads-ad-product'

/** One Sponsored Display campaign of this business. Its daily budget in minor units of its currency. */
export interface SdCampaign {
  campaignId: string
  name: string
  market: string
  externalCampaignId: string
  status: string
  costType: string | null
  dailyBudgetCents: number
  currency: string
}

/** One Sponsored Display ad group of this business, with its campaign and how many of its product ads name a SKU or ASIN. */
export interface SdAdGroup { adGroupId: string; name: string; externalAdGroupId: string; status: string; productAds: number; campaign: SdCampaign }

const CAMPAIGN_SELECT = { id: true, name: true, marketplace: true, externalCampaignId: true, status: true, costType: true, dailyBudget: true, dailyBudgetCurrency: true, adProduct: true, type: true } as const
type CampaignRow = { id: string; name: string; marketplace: string | null; externalCampaignId: string | null; status: unknown; costType: string | null; dailyBudget: unknown; dailyBudgetCurrency: string | null; adProduct: string | null; type: unknown }
const SD_ONLY = { OR: [{ adProduct: SPONSORED_DISPLAY }, { adProduct: null, type: 'SD' as const }] }
const quote = (name: string) => `"${name}"`

function sdCampaignFrom(c: CampaignRow, what: string): SdCampaign | { refusal: string } {
  const product = adProductOf({ adProduct: c.adProduct, type: c.type == null ? null : String(c.type) })
  if (product !== SPONSORED_DISPLAY) return { refusal: `${what} is not a Sponsored Display campaign (${product ?? 'its ad product is not known'}): these rules are Sponsored Display's.` }
  if (!c.externalCampaignId) return { refusal: `${what} has no Amazon id in Nexus yet, so Amazon cannot be asked about it.` }
  if (!c.marketplace) return { refusal: `Nexus does not know the market of ${what}.` }
  return {
    campaignId: c.id, name: c.name, market: c.marketplace.toUpperCase(), externalCampaignId: c.externalCampaignId, status: String(c.status),
    costType: c.costType ? c.costType.toLowerCase() : null, dailyBudgetCents: Math.round(Number(c.dailyBudget ?? 0) * 100), currency: c.dailyBudgetCurrency?.trim() || 'EUR',
  }
}

/** This business's Sponsored Display campaign (Nexus id), or why not. */
export async function sdCampaignOf(campaignId: string): Promise<SdCampaign | { refusal: string }> {
  const c = await prisma.campaign.findFirst({ where: { id: campaignId }, select: CAMPAIGN_SELECT }) as CampaignRow | null
  if (!c) return { refusal: `Campaign ${campaignId} not found in this business (campaignId is Nexus's id, from ad-campaigns).` }
  return sdCampaignFrom(c, `campaign ${quote(c.name)}`)
}

/** This business's Sponsored Display ad group (Nexus id), or why not. */
export async function sdAdGroupOf(adGroupId: string): Promise<SdAdGroup | { refusal: string }> {
  const g = await prisma.adGroup.findFirst({
    where: { id: adGroupId },
    select: { id: true, name: true, externalAdGroupId: true, status: true, campaign: { select: CAMPAIGN_SELECT } },
  }) as { id: string; name: string; externalAdGroupId: string | null; status: unknown; campaign: CampaignRow } | null
  if (!g) return { refusal: `Ad group ${adGroupId} not found in this business (adGroupId is Nexus's id, from ad-groups).` }
  const campaign = sdCampaignFrom(g.campaign, `the campaign ${quote(g.campaign.name)} of ad group ${quote(g.name)}`)
  if ('refusal' in campaign) return campaign
  if (!g.externalAdGroupId) return { refusal: `Ad group ${quote(g.name)} has no Amazon id in Nexus yet, so Amazon cannot be asked about it.` }
  const productAds = await prisma.adProductAd.count({ where: { adGroupId: g.id, status: { not: 'ARCHIVED' }, OR: [{ sku: { not: null } }, { asin: { not: null } }] } })
  return { adGroupId: g.id, name: g.name, externalAdGroupId: g.externalAdGroupId, status: String(g.status), productAds, campaign }
}

/** The market's Sponsored Display campaigns Nexus holds with Amazon's id (not archived), the first `take` by name. */
export async function sdCampaignsIn(market: string, take: number): Promise<SdCampaign[]> {
  const rows = await prisma.campaign.findMany({
    where: { marketplace: market, externalCampaignId: { not: null }, status: { not: 'ARCHIVED' }, ...SD_ONLY },
    select: CAMPAIGN_SELECT, orderBy: [{ name: 'asc' }, { id: 'asc' }], take,
  }) as CampaignRow[]
  return rows.map((c) => sdCampaignFrom(c, 'it')).filter((c): c is SdCampaign => !('refusal' in c))
}

/** The market's Sponsored Display ad groups with Amazon's id (not archived), the first `take` by campaign and name; `more` when there are others. */
export async function sdAdGroupsIn(market: string, take: number): Promise<{ groups: Array<{ adGroupId: string; name: string; externalAdGroupId: string; campaign: SdCampaign }>; more: boolean }> {
  const campaigns = await sdCampaignsIn(market, 200)
  if (!campaigns.length) return { groups: [], more: false }
  const rows = await prisma.adGroup.findMany({
    where: { campaignId: { in: campaigns.map((c) => c.campaignId) }, externalAdGroupId: { not: null }, status: { not: 'ARCHIVED' } },
    select: { id: true, name: true, externalAdGroupId: true, campaignId: true }, orderBy: [{ campaignId: 'asc' }, { name: 'asc' }], take: take + 1,
  })
  const byId = new Map(campaigns.map((c) => [c.campaignId, c]))
  return { groups: rows.slice(0, take).map((g) => ({ adGroupId: g.id, name: g.name, externalAdGroupId: g.externalAdGroupId!, campaign: byId.get(g.campaignId)! })), more: rows.length > take }
}

/** The Nexus campaigns behind Amazon's campaign ids in this market (name and Nexus id), by Amazon's id. */
export async function nexusCampaignsByAmazonId(market: string, externalIds: readonly string[]): Promise<Map<string, { campaignId: string; name: string }>> {
  if (!externalIds.length) return new Map()
  const rows = await prisma.campaign.findMany({ where: { marketplace: market, externalCampaignId: { in: [...externalIds] } }, select: { id: true, name: true, externalCampaignId: true } })
  return new Map(rows.map((c) => [c.externalCampaignId!, { campaignId: c.id, name: c.name }]))
}
