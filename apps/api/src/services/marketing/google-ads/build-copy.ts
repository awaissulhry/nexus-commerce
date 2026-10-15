/**
 * Google Ads changes, PR 6 (2026-10-15) — a live campaign as a build (change-build.ts `BuildCampaign`): its settings,
 * budget, bidding, networks, Google's automation switches, locations and the location option, languages, schedule,
 * audiences, campaign negatives and lists, ad groups with their bids and statuses, keywords with bids and statuses,
 * ad-group negatives, the whole product group tree of each Shopping ad group (every dimension, as Google reads it),
 * responsive search ads, and the campaign's sitelinks, callouts and structured snippets (linked again, the same assets).
 * What Nexus does not copy is named in `notCopied` (the preview says it); keyword-level URLs, ad-group-level criteria and
 * assets and campaign conversion goals are not read, so never copied. The copy is always made PAUSED. Every list is put in
 * Google-id order, so the same campaign always gives the same build (a re-check never sees a false "moved").
 */
import { biddingNow, type ScheduleSlot } from './change-campaigns.js'
import type { BuildAdGroup, BuildCampaign, BuildNegative, BuildProductNode } from './change-build.js'
import { liveCampaignDetail, liveListKeywords, type MatchType } from './live.js'
import { liveProductGroupTree, type ProductGroupNode } from './live-product-groups.js'
import type { AssetFieldType } from './change-assets.js'
import type { GoogleAdsTarget } from './types.js'

const tail = (s: string | null | undefined) => (s ?? '').split('/').pop() ?? ''
/** Google ids compared as numbers (`51~602` part by part): GAQL without ORDER BY returns rows in any order. */
export function byId(a: string, b: string): number {
  const x = a.split('~').map(Number)
  const y = b.split('~').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}
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
  // Siblings by Google id: the same tree gives the same operations whatever order Google returns its rows in.
  for (const n of [...nodes].sort((a, b) => byId(a.criterionId, b.criterionId))) byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n])
  const walk = (parentId: string | null) => {
    for (const n of byParent.get(parentId) ?? []) {
      index.set(n.criterionId, out.length)
      out.push({
        parent: n.parentId === null ? null : index.get(n.parentId) ?? null,
        kind: n.kind === 'SUBDIVISION' ? 'SUBDIVISION' : 'UNIT',
        caseValue: n.caseValue,
        excluded: n.excluded,
        bidCents: n.bidCents,
        rest: n.parentId !== null && n.value === null,
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

  const schedule: ScheduleSlot[] = [...d.criteria.schedule].sort((x, y) => byId(x.criterionId, y.criterionId)).filter((k) => k.schedule).map((k) => ({
    days: [k.schedule!.day ?? ''], from: k.schedule!.from, to: k.schedule!.to, ...(k.bidModifier !== null && k.bidModifier !== 1 ? { bidModifier: k.bidModifier } : {}),
  }))
  if (c.keywordMatchType === 'BROAD') notCopied.push('campaign-level broad match (Google Ads API v25 no longer lets it be set)')
  const audiences: string[] = []
  const excludedAudiences: string[] = []
  for (const a of [...d.criteria.audiences].sort((x, y) => byId(x.criterionId, y.criterionId))) {
    if (a.type === 'USER_INTEREST' && a.audience) (a.negative ? excludedAudiences : audiences).push(tail(a.audience))
    else notCopied.push(`audience ${a.name ?? a.criterionId} (${a.type})`)
    if (a.bidModifier !== null && a.bidModifier !== 1) notCopied.push(`the bid adjustment of audience ${a.name ?? a.criterionId}`)
  }
  const audienceTargeting = c.audienceMode.some((t) => t.dimension === 'AUDIENCE' && !t.observationOnly)
  for (const s of d.otherSharedSets ?? []) notCopied.push(`shared set "${s.name ?? s.listId}" (${s.type})`)
  const end = c.end && !c.end.startsWith('2037-12-30') ? c.end.slice(0, 10) : null
  const today = new Date().toISOString().slice(0, 10)
  if (end && end < today && !overrides.endDate) notCopied.push(`the end date ${end} (in the past)`)
  for (const o of d.criteria.other) notCopied.push(`campaign criterion ${o.name ?? o.criterionId} (${o.type})`)
  const negatives: BuildNegative[] = [...d.criteria.negativeKeywords].sort((x, y) => byId(x.criterionId, y.criterionId))
    .filter((k) => k.keyword).map((k) => ({ text: k.keyword!.text, matchType: (k.keyword!.matchType ?? 'BROAD') as MatchType }))

  const adGroups: BuildAdGroup[] = []
  for (const g of [...d.adGroups].sort((x, y) => byId(x.adGroupId, y.adGroupId))) {
    const own = d.keywords.filter((k) => k.adGroupId === g.adGroupId).sort((x, y) => byId(x.criterionId, y.criterionId))
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
      for (const ad of d.ads.filter((a) => a.adGroupId === g.adGroupId).sort((x, y) => byId(x.adId, y.adId))) {
        if (ad.type !== 'RESPONSIVE_SEARCH_AD' || !ad.finalUrls[0]) { notCopied.push(`ad ${ad.adId} (${ad.type ?? 'ad'}) in "${g.name}"`); continue }
        if (ad.finalUrls.length > 1) notCopied.push(`the final URLs after the first of ad ${ad.adId} in "${g.name}"`)
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
  const link: Array<{ assetId: string; fieldType: AssetFieldType; status?: 'ENABLED' | 'PAUSED' }> = []
  for (const a of [...d.assets].sort((x, y) => byId(x.assetId, y.assetId) || String(x.fieldType).localeCompare(String(y.fieldType)))) {
    if (a.fieldType && LINKABLE.includes(a.fieldType) && a.status !== 'REMOVED') link.push({ assetId: a.assetId, fieldType: a.fieldType as AssetFieldType, ...(a.status === 'PAUSED' ? { status: 'PAUSED' as const } : {}) })
    else notCopied.push(`asset ${a.assetId} (${a.fieldType ?? 'asset'})`)
  }

  const automation = (type: string) => c.assetAutomation.some((x) => x.type === type && x.status === 'OPTED_IN')
  const campaign: BuildCampaign = {
    type: c.type,
    name: overrides.name,
    budget,
    bidding,
    ...(overrides.startDate ? { startDate: overrides.startDate } : {}),
    ...(overrides.endDate ? { endDate: overrides.endDate } : end && end >= today ? { endDate: end } : {}),
    searchPartners: c.networks.searchPartners,
    ...(c.type === 'SEARCH' ? { display: c.networks.display } : {}),
    ...(c.type === 'SHOPPING' && c.shopping
      ? { shopping: { merchantId: c.shopping.merchantId ?? '', ...(c.shopping.feedLabel ? { feedLabel: c.shopping.feedLabel } : {}), priority: c.shopping.priority ?? 'LOW', localInventory: c.localInventory } }
      : {}),
    ...(c.type === 'SEARCH'
      ? { search: { aiMax: c.aiMax, textCustomization: automation('TEXT_ASSET_AUTOMATION'), finalUrlExpansion: automation('FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION') } }
      : {}),
    locations: [...d.criteria.locations].sort((x, y) => byId(x.criterionId, y.criterionId)).map((k) => ({
      id: tail(k.location), ...(k.negative ? { exclude: true } : {}), ...(!k.negative && k.bidModifier !== null && k.bidModifier !== 1 ? { bidModifier: k.bidModifier } : {}),
    })),
    locationOption: c.locationOption.include === 'PRESENCE' ? 'PRESENCE' : 'PRESENCE_OR_INTEREST',
    ...(c.type === 'SEARCH' ? { languages: [...d.criteria.languages].sort((x, y) => byId(x.criterionId, y.criterionId)).map((k) => tail(k.language)) } : {}),
    schedule,
    audiences,
    ...(excludedAudiences.length ? { excludedAudiences } : {}),
    ...(audienceTargeting ? { audienceTargeting: true } : {}),
    ...(c.trackingTemplate ? { trackingTemplate: c.trackingTemplate } : {}),
    ...(c.finalUrlSuffix ? { finalUrlSuffix: c.finalUrlSuffix } : {}),
    // A copy keeps the keywords the source holds, broad ones too.
    allowBroad: true,
    euPoliticalAds: c.euPoliticalAds === 'CONTAINS_EU_POLITICAL_ADVERTISING',
    negatives,
    negativeLists: overrides.negativeLists ?? [...d.negativeLists].sort((x, y) => byId(x.listId, y.listId)).map((l) => ({ listId: l.listId })),
    adGroups,
    assets: { link },
  }
  return { campaign, notCopied }
}

/** A live negative keyword list's keywords, for a copy of the list. */
export async function listAsBuild(target: GoogleAdsTarget, listId: string): Promise<BuildNegative[]> {
  return (await liveListKeywords(target, listId)).sort((x, y) => byId(x.criterionId, y.criterionId)).map((k) => ({ text: k.text, matchType: k.matchType }))
}
