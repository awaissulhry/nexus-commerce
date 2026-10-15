/**
 * Google Ads changes, PR 6 (2026-10-15) — a live campaign as a build (change-build.ts `BuildCampaign`): its settings,
 * budget, bidding, networks, Google's automation switches, locations and the location option, languages, schedule,
 * audiences, campaign negatives and lists, ad groups with their bids and statuses, keywords with bids and statuses,
 * ad-group negatives, the whole product group tree of each Shopping ad group (every dimension, as Google reads it),
 * responsive search ads, and the campaign's sitelinks, callouts and structured snippets (linked again, the same assets).
 * What Nexus does not copy is named in `notCopied` (the preview says it). The copy is always made PAUSED.
 */
import { biddingNow, type ScheduleSlot } from './change-campaigns.js'
import type { BuildAdGroup, BuildCampaign, BuildNegative, BuildProductNode } from './change-build.js'
import { liveCampaignDetail, liveListKeywords, type MatchType } from './live.js'
import { liveProductGroupTree, type ProductGroupNode } from './live-product-groups.js'
import type { AssetFieldType } from './change-assets.js'
import type { GoogleAdsTarget } from './types.js'

const tail = (s: string | null | undefined) => (s ?? '').split('/').pop() ?? ''
const LINKABLE: readonly string[] = ['SITELINK', 'CALLOUT', 'STRUCTURED_SNIPPET']

export interface CopyOverrides {
  name: string
  budget?: BuildCampaign['budget']
  startDate?: string
  endDate?: string
  negativeLists?: BuildCampaign['negativeLists']
}

/** A product group tree in an order where a parent comes before its children, parents by index. */
export function treeNodes(nodes: ProductGroupNode[]): BuildProductNode[] {
  const out: BuildProductNode[] = []
  const index = new Map<string, number>()
  const byParent = new Map<string | null, ProductGroupNode[]>()
  for (const n of nodes) byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n])
  const walk = (parentId: string | null) => {
    for (const n of byParent.get(parentId) ?? []) {
      index.set(n.criterionId, out.length)
      out.push({
        parent: n.parentId === null ? null : index.get(n.parentId) ?? null,
        kind: n.kind === 'SUBDIVISION' ? 'SUBDIVISION' : 'UNIT',
        caseValue: n.caseValue,
        excluded: n.excluded,
        bidCents: n.bidCents,
      })
      walk(n.criterionId)
    }
  }
  walk(null)
  return out
}

/** One live campaign as a build campaign under a new name, or why it cannot be copied. */
export async function campaignAsBuild(
  target: GoogleAdsTarget,
  campaignId: string,
  overrides: CopyOverrides,
): Promise<{ campaign: BuildCampaign; notCopied: string[] } | { refusal: string }> {
  const d = await liveCampaignDetail(target, campaignId)
  if (!d) return { refusal: `Campaign ${campaignId} is not in this account (or it is removed).` }
  const c = d.campaign
  if (c.type !== 'SEARCH' && c.type !== 'SHOPPING') return { refusal: `"${c.name}" is a ${c.type ?? 'campaign'} campaign: Nexus copies Search and Standard Shopping campaigns.` }
  if (d.notRead.length) return { refusal: `Parts of "${c.name}" could not be read (${d.notRead.map((n) => n.part).join(', ')}): a copy would miss them.` }
  const notCopied: string[] = []
  const bidding = biddingNow(c)
  if (!bidding) return { refusal: `"${c.name}" uses a bidding Nexus does not copy (${c.bidding}).` }
  if (c.locationOption.include === 'SEARCH_INTEREST') notCopied.push('location option "search interest" (the copy uses presence or interest)')
  const budget: BuildCampaign['budget'] = overrides.budget
    ?? (c.budget?.shared && c.budget.budgetId ? { budgetId: c.budget.budgetId } : { dailyBudgetCents: c.budget?.amountCents ?? 0 })
  if ('dailyBudgetCents' in budget && !(budget.dailyBudgetCents > 0)) return { refusal: `"${c.name}" has no budget amount Nexus can read: give the copy a budget.` }

  const schedule: ScheduleSlot[] = d.criteria.schedule.filter((k) => k.schedule).map((k) => ({
    days: [k.schedule!.day ?? ''], from: k.schedule!.from, to: k.schedule!.to, ...(k.bidModifier !== null && k.bidModifier !== 1 ? { bidModifier: k.bidModifier } : {}),
  }))
  if (c.keywordMatchType === 'BROAD') notCopied.push('campaign-level broad match (Google Ads API v25 no longer lets it be set)')
  const audiences: string[] = []
  for (const a of d.criteria.audiences) {
    if (a.type === 'USER_INTEREST' && a.audience) audiences.push(tail(a.audience))
    else notCopied.push(`audience ${a.name ?? a.criterionId} (${a.type})`)
  }
  for (const o of d.criteria.other) notCopied.push(`campaign criterion ${o.name ?? o.criterionId} (${o.type})`)
  const negatives: BuildNegative[] = d.criteria.negativeKeywords.filter((k) => k.keyword).map((k) => ({ text: k.keyword!.text, matchType: (k.keyword!.matchType ?? 'BROAD') as MatchType }))

  const adGroups: BuildAdGroup[] = []
  for (const g of d.adGroups) {
    const own = d.keywords.filter((k) => k.adGroupId === g.adGroupId)
    const group: BuildAdGroup = {
      name: g.name,
      ...(g.cpcBidCents ? { defaultBidCents: g.cpcBidCents } : {}),
      status: g.status === 'PAUSED' ? 'PAUSED' : 'ENABLED',
      keywords: own.filter((k) => !k.negative).map((k) => ({
        text: k.text, matchType: (k.matchType ?? 'BROAD') as MatchType, ...(k.cpcBidCents ? { bidCents: k.cpcBidCents } : {}), status: k.status === 'PAUSED' ? 'PAUSED' : 'ENABLED',
      })),
      negatives: own.filter((k) => k.negative).map((k) => ({ text: k.text, matchType: (k.matchType ?? 'BROAD') as MatchType })),
    }
    if (c.type === 'SHOPPING') {
      const tree = await liveProductGroupTree(target, g.adGroupId)
      if (tree.nodes.length) group.productGroups = { nodes: treeNodes(tree.nodes) }
    } else {
      group.ads = []
      for (const ad of d.ads.filter((a) => a.adGroupId === g.adGroupId)) {
        if (ad.type !== 'RESPONSIVE_SEARCH_AD' || !ad.finalUrls[0]) { notCopied.push(`ad ${ad.adId} (${ad.type ?? 'ad'}) in "${g.name}"`); continue }
        group.ads.push({
          headlines: ad.headlines.map((h) => ({ text: h.text, ...(h.pinned ? { pin: h.pinned as never } : {}) })),
          descriptions: ad.descriptions.map((h) => ({ text: h.text, ...(h.pinned ? { pin: h.pinned as never } : {}) })),
          ...(ad.path1 ? { path1: ad.path1 } : {}),
          ...(ad.path2 ? { path2: ad.path2 } : {}),
          finalUrl: ad.finalUrls[0],
          status: ad.status === 'PAUSED' ? 'PAUSED' : 'ENABLED',
        })
      }
    }
    adGroups.push(group)
  }
  const link: Array<{ assetId: string; fieldType: AssetFieldType }> = []
  for (const a of d.assets) {
    if (a.fieldType && LINKABLE.includes(a.fieldType) && a.status !== 'REMOVED') link.push({ assetId: a.assetId, fieldType: a.fieldType as AssetFieldType })
    else notCopied.push(`asset ${a.assetId} (${a.fieldType ?? 'asset'})`)
  }

  const automation = (type: string) => c.assetAutomation.some((x) => x.type === type && x.status === 'OPTED_IN')
  const campaign: BuildCampaign = {
    type: c.type,
    name: overrides.name,
    budget,
    bidding,
    ...(overrides.startDate ? { startDate: overrides.startDate } : {}),
    ...(overrides.endDate ? { endDate: overrides.endDate } : {}),
    searchPartners: c.networks.searchPartners,
    ...(c.type === 'SEARCH' ? { display: c.networks.display } : {}),
    ...(c.type === 'SHOPPING' && c.shopping
      ? { shopping: { merchantId: c.shopping.merchantId ?? '', ...(c.shopping.feedLabel ? { feedLabel: c.shopping.feedLabel } : {}), priority: c.shopping.priority ?? 'LOW', localInventory: c.localInventory } }
      : {}),
    ...(c.type === 'SEARCH'
      ? { search: { aiMax: c.aiMax, textCustomization: automation('TEXT_ASSET_AUTOMATION'), finalUrlExpansion: automation('FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION') } }
      : {}),
    locations: d.criteria.locations.map((k) => ({
      id: tail(k.location), ...(k.negative ? { exclude: true } : {}), ...(!k.negative && k.bidModifier !== null && k.bidModifier !== 1 ? { bidModifier: k.bidModifier } : {}),
    })),
    locationOption: c.locationOption.include === 'PRESENCE' ? 'PRESENCE' : 'PRESENCE_OR_INTEREST',
    ...(c.type === 'SEARCH' ? { languages: d.criteria.languages.map((k) => tail(k.language)) } : {}),
    schedule,
    audiences,
    euPoliticalAds: c.euPoliticalAds === 'CONTAINS_EU_POLITICAL_ADVERTISING',
    negatives,
    negativeLists: overrides.negativeLists ?? d.negativeLists.map((l) => ({ listId: l.listId })),
    adGroups,
    assets: { link },
  }
  return { campaign, notCopied }
}

/** A live negative keyword list's keywords, for a copy of the list. */
export async function listAsBuild(target: GoogleAdsTarget, listId: string): Promise<BuildNegative[]> {
  return (await liveListKeywords(target, listId)).map((k) => ({ text: k.text, matchType: k.matchType }))
}
