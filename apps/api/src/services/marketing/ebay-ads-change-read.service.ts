/**
 * MCP full control A14/A15 (docs/mcp-full-control/sections/01-ads.md §6 steps 14–15) — the reads Claude's eBay ad
 * change tools (services/agents/tools/ebay-ads.tools.ts) preview with. eBay's campaigns, ads, ad groups and keywords
 * are the advertising context's private storage (scripts/check-context-boundary.mjs), so a caller outside it reads
 * them through here, never through prisma.
 *
 * Read-only. Every read runs in the caller's business (row-level security): another business's id is simply absent.
 */
import prisma from '../../db.js'

/** One eBay campaign, as a change tool needs it; null when the id names no campaign of this business. */
export async function ebayCampaignForChange(id: string) {
  return prisma.ebayCampaign.findFirst({
    where: { id },
    select: {
      id: true, name: true, marketplace: true, externalCampaignId: true, status: true, fundingModel: true, campaignTargetingType: true,
      isRulesBased: true, adRateStrategy: true, bidPercentage: true, dynamicAdRatePrefs: true, dailyBudget: true, budgetCurrency: true,
      budgetUpdatesToday: true, budgetUpdatesDay: true, channelConnectionId: true,
    },
  })
}
export type EbayChangeCampaign = NonNullable<Awaited<ReturnType<typeof ebayCampaignForChange>>>

/** The campaign's ads for these eBay item ids: each one's own rate (null = the campaign's) and status. */
export async function ebayAdsByItem(campaignId: string, itemIds: string[]): Promise<Map<string, { adId: string; ratePct: number | null; status: string }>> {
  if (!itemIds.length) return new Map()
  const rows = await prisma.ebayAd.findMany({
    where: { campaignId, listingId: { in: itemIds } },
    select: { id: true, listingId: true, bidPercentage: true, status: true },
  })
  return new Map(rows.map((a) => [a.listingId!, { adId: a.id, ratePct: a.bidPercentage != null ? Number(a.bidPercentage.toString()) : null, status: a.status }]))
}

/** One of the campaign's ad groups; null when it is not one of this campaign's. */
export async function ebayAdGroupOf(campaignId: string, adGroupId: string) {
  return prisma.ebayAdGroup.findFirst({ where: { id: adGroupId, campaignId }, select: { id: true, name: true, externalAdGroupId: true, status: true } })
}

/** The campaign's keywords by Nexus id (others are absent). */
export async function ebayKeywordsById(campaignId: string, keywordIds: string[]) {
  if (!keywordIds.length) return new Map<string, { id: string; text: string; matchType: string; bidCents: number | null; status: string; adGroupId: string }>()
  const rows = await prisma.ebayKeyword.findMany({
    where: { campaignId, id: { in: keywordIds } },
    select: { id: true, text: true, matchType: true, bidCents: true, status: true, adGroupId: true },
  })
  return new Map(rows.map((k) => [k.id, k]))
}

/** An ad group's keywords and negatives, by text and match type (lower-cased): what an add would duplicate. */
export async function ebayAdGroupTerms(adGroupId: string): Promise<{ keywords: Map<string, string>; negatives: Set<string> }> {
  const [keywords, negatives] = await Promise.all([
    prisma.ebayKeyword.findMany({ where: { adGroupId }, select: { id: true, text: true, matchType: true } }),
    prisma.ebayNegativeKeyword.findMany({ where: { adGroupId }, select: { text: true, matchType: true } }),
  ])
  const key = (t: { text: string; matchType: string }) => `${t.matchType} ${t.text.trim().toLowerCase()}`
  return { keywords: new Map(keywords.map((k) => [key(k), k.id])), negatives: new Set(negatives.map(key)) }
}

/** The eBay listings Nexus holds for these item ids, with their SKU and market (others are absent). */
export async function ebayListingsByItem(itemIds: string[]): Promise<Map<string, { sku: string | null; marketplace: string }>> {
  if (!itemIds.length) return new Map()
  const rows = await prisma.channelListing.findMany({
    where: { channel: 'EBAY', externalListingId: { in: itemIds } },
    select: { externalListingId: true, marketplace: true, product: { select: { sku: true } } },
  })
  return new Map(rows.map((l) => [l.externalListingId!, { sku: l.product?.sku ?? null, marketplace: l.marketplace }]))
}

/** The eBay spend ceiling of a market (monthly cap, kill switch); null when it has none. */
export async function ebayMarketCeiling(marketplace: string) {
  return prisma.marketingSpendCeiling.findFirst({ where: { channel: 'EBAY', marketplace }, select: { monthlyCapCents: true, currency: true, killSwitch: true } })
}

/** An eBay campaign of this market by name (case-insensitive): a new campaign's name must be new. */
export async function ebayCampaignNamed(marketplace: string, name: string) {
  return prisma.ebayCampaign.findFirst({ where: { marketplace, name: { equals: name, mode: 'insensitive' } }, select: { id: true } })
}
