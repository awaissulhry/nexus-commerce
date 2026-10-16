/**
 * Google Ads changes, PR 6 (2026-10-15) — a live campaign as a build (change-build.ts `BuildCampaign`): its settings,
 * budget, bidding, networks, Google's automation switches, locations and the location options, languages, schedule,
 * campaign negatives and lists, ad groups with their bids and statuses, keywords with bids and statuses, ad-group
 * negatives, the whole product group tree of each Shopping ad group (every dimension, as Google reads it), responsive
 * search ads. The copy is always made PAUSED. Every list is put in Google-id order, so the same campaign always gives the
 * same build (a re-check never sees a false "moved").
 *
 * G13 (2026-10-16, build/copy parity — "a copy has nothing 'not copied' that Nexus can set"): the copy also carries
 * device bid adjustments (campaign and ad groups), location bid adjustments and radius targets, audience segments of
 * every kind (targeted, observed, excluded, bid adjustments) at the campaign and its ad groups with the audience setting
 * as Google holds it, demographics, labels on the campaign, its ad groups, keywords and ads, URLs and tracking at every
 * level (custom parameters, keyword final URLs, ad mobile URLs and every final URL), ad rotation, ad group target CPA /
 * ROAS, the Shopping inventory filter and brand-exclusion setting, the location option "search interest" and the
 * exclusion option, every asset link of the campaign and its ad groups (the same assets linked again, with their
 * status), placement / content / IP exclusions, brand lists (campaign and ad group), placement exclusion lists, and the
 * campaign's own conversion goals and custom goal. What it does not carry is named in `notCopied`, each with its reason:
 * what Google's API cannot set (campaign-level broad match; an end date in the past; links Google made itself) and the
 * few things no Nexus tool sets (other kinds of criteria and ads, named one by one).
 *
 * Not a Search or Standard Shopping campaign: a plain refusal that names the tool for it (Performance Max:
 * copy-google-pmax; Demand Gen, Display, App: their create tools; Video: Google's API cannot make one) — never half a copy.
 * A Google draft (it does not serve) is not copied: its base campaign is.
 */
import { biddingNow, type ScheduleSlot } from './change-campaigns.js'
import type { BuildAdGroup, BuildAudience, BuildCampaign, BuildDemographic, BuildDevice, BuildNegative, BuildProductNode } from './change-build.js'
import type { RadiusSpec } from './change-targeting.js'
import type { FilterCondition } from './change-shopping.js'
import { liveCampaignDetail, liveListKeywords, type MatchType } from './live.js'
import { liveProductGroupTree, type ProductGroupNode } from './live-product-groups.js'
import { liveAdGroupDevices, liveAdGroupTargeting, liveTargetingCriteria, type Device } from './live-targeting.js'
import { liveCampaignExclusions } from './live-exclusions.js'
import { liveLabels } from './live-labels.js'
import {
  liveAdGroupBrandLists, liveAdGroupOtherCriteria, liveCampaignAdGroupLinks, liveCampaignGoals, liveCampaignLabels, liveInventoryFilters,
} from './live-copy.js'
import type { GoogleAdsTarget } from './types.js'

const tail = (s: string | null | undefined) => (s ?? '').split('/').pop() ?? ''
/** Google ids compared as numbers (`51~602` part by part): GAQL without ORDER BY returns rows in any order. */
export function byId(a: string, b: string): number {
  const x = a.split('~').map(Number)
  const y = b.split('~').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

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

/**
 * Why a campaign of another type is not copied here, naming the tool that handles it (G10, G11), or null for a Search
 * or Standard Shopping campaign.
 */
export function otherTypeRefusal(c: { name: string; type: string | null; subType: string | null }): string | null {
  const name = `"${c.name}"`
  switch (c.type) {
    case 'SEARCH':
      return c.subType && !['UNSPECIFIED', 'UNKNOWN'].includes(c.subType) ? `${name} is a ${c.subType} Search campaign: Nexus copies standard Search and Standard Shopping campaigns.` : null
    case 'SHOPPING':
      return c.subType && !['UNSPECIFIED', 'UNKNOWN'].includes(c.subType) ? `${name} is a ${c.subType} Shopping campaign: Nexus copies Standard Shopping campaigns (and Performance Max with copy-google-pmax).` : null
    case 'PERFORMANCE_MAX': return `${name} is a Performance Max campaign: copy it with copy-google-pmax (it copies the asset groups, their assets, product filters and signals).`
    case 'DEMAND_GEN': return `${name} is a Demand Gen campaign: Nexus has no copy for it — make a new one with create-google-demand-gen-campaign (google-ads-live view campaign shows this one's settings).`
    case 'DISPLAY': return `${name} is a Display campaign: Nexus has no copy for it — make a new one with create-google-display-campaign (google-ads-live view campaign shows this one's settings).`
    case 'MULTI_CHANNEL': return `${name} is an App campaign: Nexus has no copy for it — make a new one with create-google-app-campaign.`
    case 'VIDEO': return `${name} is a Video campaign: Google's API cannot make Video campaigns (developers.google.com/google-ads/api/docs/video/overview), so it cannot be copied; copy it in Google Ads.`
    default: return `${name} is a ${c.type ?? 'campaign'} campaign: Nexus copies Search and Standard Shopping campaigns (Performance Max: copy-google-pmax).`
  }
}

const DEVICE_TYPES: readonly string[] = ['MOBILE', 'DESKTOP', 'TABLET', 'CONNECTED_TV']
/** The criteria types of a campaign the copy carries (the rest is named in notCopied). */
const AUDIENCE_TYPES = new Set(['USER_LIST', 'USER_INTEREST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE', 'LIFE_EVENT'])
const DEMOGRAPHIC_TYPES = new Set(['AGE_RANGE', 'GENDER', 'PARENTAL_STATUS', 'INCOME_RANGE'])
const AD_GROUP_TYPE: Record<string, string> = { SEARCH: 'SEARCH_STANDARD', SHOPPING: 'SHOPPING_PRODUCT_ADS' }
/** An ad Google no longer lets anyone make (v25: expanded text ads can no longer be created). */
const AD_REASON: Record<string, string> = {
  EXPANDED_TEXT_AD: 'Google no longer lets an expanded text ad be made',
  TEXT_AD: 'Google no longer lets a text ad be made',
}
const asStatus = (s: string | null | undefined): 'ENABLED' | 'PAUSED' => (s === 'PAUSED' ? 'PAUSED' : 'ENABLED')
const factor = (f: number | null | undefined) => (f === null || f === undefined || f === 1 ? undefined : f)
const urlFields = (u: { trackingTemplate: string | null; finalUrlSuffix: string | null; customParameters: Array<{ key: string; value: string }> } | undefined) => ({
  ...(u?.trackingTemplate ? { trackingTemplate: u.trackingTemplate } : {}),
  ...(u?.finalUrlSuffix ? { finalUrlSuffix: u.finalUrlSuffix } : {}),
  ...(u?.customParameters?.length ? { customParameters: u.customParameters } : {}),
})

/** One live campaign as a build campaign under a new name, or why it cannot be copied. */
export async function campaignAsBuild(
  target: GoogleAdsTarget,
  campaignId: string,
  overrides: CopyOverrides,
): Promise<{ campaign: BuildCampaign; notCopied: string[] } | { refusal: string }> {
  const d = await liveCampaignDetail(target, campaignId)
  if (!d) return { refusal: `Campaign ${campaignId} is not in this account (or it is removed).` }
  const c = d.campaign
  const other = otherTypeRefusal(c)
  if (other) return { refusal: other }
  if (c.experimentType === 'DRAFT') return { refusal: `"${c.name}" is a Google draft (a campaign draft, or an experiment's trial still in design): it does not serve. Copy its base campaign, or promote the draft first.` }
  if (d.notRead.length) return { refusal: `Parts of "${c.name}" could not be read (${d.notRead.map((n) => n.part).join(', ')}): a copy would miss them.` }
  const notCopied: string[] = []
  const bidding = biddingNow(c)
  if (!bidding) return { refusal: `"${c.name}" uses a bidding Nexus does not copy (${c.bidding}).` }
  if (c.manualCpcEnhanced) notCopied.push('enhanced CPC (no Nexus tool turns it on: the copy bids Manual CPC; turn it on in Google Ads where Google still offers it)')
  const budget: BuildCampaign['budget'] = overrides.budget
    ?? (c.budget?.shared && c.budget.budgetId ? { budgetId: c.budget.budgetId } : { dailyBudgetCents: c.budget?.amountCents ?? 0 })
  if ('dailyBudgetCents' in budget && !(budget.dailyBudgetCents > 0)) return { refusal: `"${c.name}" has no budget amount Nexus can read: give the copy a budget.` }

  // ── the parts the newer change tools set, read live (a part Google refuses fails the copy) ──
  const isShopping = c.type === 'SHOPPING'
  const targeting = await liveTargetingCriteria(target, campaignId)
  const groupCriteria = await liveAdGroupTargeting(target, campaignId)
  const groupDevices = await liveAdGroupDevices(target, campaignId)
  const exclusions = await liveCampaignExclusions(target, campaignId)
  const groupBrandLists = await liveAdGroupBrandLists(target, campaignId)
  const groupOthers = await liveAdGroupOtherCriteria(target, campaignId)
  const groupLinks = await liveCampaignAdGroupLinks(target, campaignId)
  // Labels: four reads only when the account has a label at all.
  const labels = (await liveLabels(target)).length ? await liveCampaignLabels(target, campaignId) : []
  const goals = await liveCampaignGoals(target, campaignId)
  const scopes = isShopping ? await liveInventoryFilters(target, campaignId) : []
  const labelsOf = (kind: string, id: string) => labels.filter((l) => l.kind === kind && l.id === id).map((l) => l.labelId)

  // ── campaign criteria ──
  const used = new Set<string>()
  const schedule: ScheduleSlot[] = [...d.criteria.schedule].sort((x, y) => byId(x.criterionId, y.criterionId)).filter((k) => k.schedule).map((k) => {
    used.add(k.criterionId)
    return { days: [k.schedule!.day ?? ''], from: k.schedule!.from, to: k.schedule!.to, ...(k.bidModifier !== null && k.bidModifier !== 1 ? { bidModifier: k.bidModifier } : {}) }
  })
  if (c.keywordMatchType === 'BROAD') notCopied.push('campaign-level broad match (Google Ads API v25 no longer lets it be set: CANNOT_SET_CAMPAIGN_KEYWORD_MATCH_TYPE)')
  const devices: BuildDevice[] = []
  const radius: RadiusSpec[] = []
  const audienceSegments: BuildAudience[] = []
  const demographics: BuildDemographic[] = []
  for (const k of [...targeting].sort((x, y) => byId(x.criterionId, y.criterionId))) {
    if (k.type === 'DEVICE' && k.device && DEVICE_TYPES.includes(k.device)) {
      used.add(k.criterionId)
      if (k.bidModifier !== null && k.bidModifier !== 1) devices.push({ device: k.device as Device, bidModifier: k.bidModifier })
    } else if (k.type === 'PROXIMITY' && k.proximity) {
      const p = k.proximity
      used.add(k.criterionId)
      if (p.latitudeMicro === null || p.longitudeMicro === null || p.radius === null) { notCopied.push(`radius ${k.name ?? k.criterionId} (Google gave back no point and radius for it)`); continue }
      radius.push({ latitude: p.latitudeMicro / 1_000_000, longitude: p.longitudeMicro / 1_000_000, radius: p.radius, units: p.units === 'MILES' ? 'MILES' : 'KILOMETERS', ...(factor(k.bidModifier) !== undefined ? { bidModifier: k.bidModifier! } : {}) })
    } else if (k.type && AUDIENCE_TYPES.has(k.type) && k.segment) {
      used.add(k.criterionId)
      audienceSegments.push({ kind: k.segment.kind, id: k.segment.id, ...(k.negative ? { exclude: true } : {}), ...(!k.negative && factor(k.bidModifier) !== undefined ? { bidModifier: k.bidModifier! } : {}) })
    } else if (k.type && DEMOGRAPHIC_TYPES.has(k.type) && k.demographic?.value) {
      used.add(k.criterionId)
      demographics.push({ dimension: k.demographic.dimension, value: k.demographic.value, ...(k.negative ? { exclude: true } : {}), ...(!k.negative && factor(k.bidModifier) !== undefined ? { bidModifier: k.bidModifier! } : {}) })
    }
  }
  const locations = [...d.criteria.locations].sort((x, y) => byId(x.criterionId, y.criterionId)).map((k) => {
    used.add(k.criterionId)
    return { id: tail(k.location), ...(k.negative ? { exclude: true } : {}), ...(!k.negative && k.bidModifier !== null && k.bidModifier !== 1 ? { bidModifier: k.bidModifier } : {}) }
  })
  const languages = c.type === 'SEARCH' ? [...d.criteria.languages].sort((x, y) => byId(x.criterionId, y.criterionId)).map((k) => { used.add(k.criterionId); return tail(k.language) }) : []
  const negatives: BuildNegative[] = [...d.criteria.negativeKeywords].sort((x, y) => byId(x.criterionId, y.criterionId))
    .filter((k) => k.keyword).map((k) => { used.add(k.criterionId); return { text: k.keyword!.text, matchType: (k.keyword!.matchType ?? 'BROAD') as MatchType } })
  for (const e of exclusions.items) used.add(e.criterionId)
  for (const b of exclusions.brandLists) used.add(b.criterionId)
  const inventoryFilter: FilterCondition[] = []
  for (const s of scopes) {
    used.add(s.criterionId)
    if (s.conditions.some((x) => !x.dimension || x.value === null)) { notCopied.push(`the inventory filter (${s.conditions.map((x) => x.raw ?? '?').join(', ')}: a condition Nexus cannot read)`); continue }
    inventoryFilter.push(...s.conditions.map((x) => ({ dimension: x.dimension!, value: x.value! })))
  }
  const allCriteria = [...d.criteria.locations, ...d.criteria.languages, ...d.criteria.schedule, ...d.criteria.audiences, ...d.criteria.negativeKeywords, ...d.criteria.other]
  for (const k of allCriteria.sort((x, y) => byId(x.criterionId, y.criterionId))) {
    if (!used.has(k.criterionId)) notCopied.push(`campaign criterion ${k.name ?? k.criterionId} (${k.type ?? 'criterion'}${k.negative ? ', excluded' : ''}: no Nexus tool sets this kind)`)
  }

  // ── lists, dates ──
  const placementLists: string[] = []
  for (const s of [...(d.otherSharedSets ?? [])].sort((x, y) => byId(x.listId, y.listId))) {
    if (s.type === 'NEGATIVE_PLACEMENTS') placementLists.push(s.listId)
    else notCopied.push(`shared set "${s.name ?? s.listId}" (${s.type}: no Nexus tool attaches this kind)`)
  }
  const end = c.end && !c.end.startsWith('2037-12-30') ? c.end.slice(0, 10) : null
  const today = new Date().toISOString().slice(0, 10)
  if (end && end < today && !overrides.endDate) notCopied.push(`the end date ${end} (in the past: Google refuses a past end date; the copy runs on)`)

  // ── ad groups ──
  const adGroups: BuildAdGroup[] = []
  for (const g of [...d.adGroups].sort((x, y) => byId(x.adGroupId, y.adGroupId))) {
    if (g.type && g.type !== AD_GROUP_TYPE[c.type!]) { notCopied.push(`ad group "${g.name}" (${g.type}: Nexus makes ${AD_GROUP_TYPE[c.type!]} ad groups)`); continue }
    const own = d.keywords.filter((k) => k.adGroupId === g.adGroupId).sort((x, y) => byId(x.criterionId, y.criterionId))
    const criteria = groupCriteria.filter((k) => k.adGroupId === g.adGroupId).sort((x, y) => byId(x.criterionId, y.criterionId))
    const group: BuildAdGroup = {
      name: g.name,
      ...(g.cpcBidCents ? { defaultBidCents: g.cpcBidCents } : {}),
      ...(g.targetCpaCents ? { targetCpaCents: g.targetCpaCents } : {}),
      ...(g.targetRoas ? { targetRoas: g.targetRoas } : {}),
      status: asStatus(g.status),
      ...(g.rotation === 'OPTIMIZE' || g.rotation === 'ROTATE_FOREVER' ? { adRotation: g.rotation } : {}),
      ...urlFields(g.urls),
      ...(g.audienceMode.length ? { targetRestrictions: g.audienceMode } : {}),
      keywords: own.filter((k) => !k.negative).map((k) => ({
        text: k.text, matchType: (k.matchType ?? 'BROAD') as MatchType, ...(k.cpcBidCents ? { bidCents: k.cpcBidCents } : {}), status: asStatus(k.status),
        ...(k.finalUrls[0] ? { finalUrl: k.finalUrls[0] } : {}),
        ...(k.finalMobileUrls[0] ? { finalMobileUrl: k.finalMobileUrls[0] } : {}),
        ...urlFields(k.urls),
        ...(labelsOf('keyword', `${g.adGroupId}~${k.criterionId}`).length ? { labels: labelsOf('keyword', `${g.adGroupId}~${k.criterionId}`) } : {}),
      })),
      negatives: own.filter((k) => k.negative).map((k) => ({ text: k.text, matchType: (k.matchType ?? 'BROAD') as MatchType })),
      devices: groupDevices.filter((m) => m.adGroupId === g.adGroupId && m.device && DEVICE_TYPES.includes(m.device) && m.bidModifier !== null)
        .sort((x, y) => byId(x.criterionId, y.criterionId)).map((m) => ({ device: m.device as Device, bidModifier: m.bidModifier! })),
      audiences: criteria.filter((k) => k.segment).map((k) => ({ kind: k.segment!.kind, id: k.segment!.id, ...(k.negative ? { exclude: true } : {}), ...(!k.negative && factor(k.bidModifier) !== undefined ? { bidModifier: k.bidModifier! } : {}) })),
      demographics: criteria.filter((k) => k.demographic?.value).map((k) => ({ dimension: k.demographic!.dimension, value: k.demographic!.value!, ...(k.negative ? { exclude: true } : {}), ...(!k.negative && factor(k.bidModifier) !== undefined ? { bidModifier: k.bidModifier! } : {}) })),
      brandLists: groupBrandLists.filter((b) => b.adGroupId === g.adGroupId && b.listId && !b.negative).map((b) => b.listId!),
      ...(labelsOf('ad-group', g.adGroupId).length ? { labels: labelsOf('ad-group', g.adGroupId) } : {}),
    }
    for (const k of criteria.filter((x) => !x.segment && !x.demographic?.value)) notCopied.push(`criterion ${k.name ?? k.criterionId} (${k.type ?? 'criterion'}) of "${g.name}" (Nexus cannot read its value)`)
    for (const k of groupOthers.filter((x) => x.adGroupId === g.adGroupId)) notCopied.push(`criterion ${k.name ?? k.criterionId} (${k.type ?? 'criterion'}${k.negative ? ', excluded' : ''}) of "${g.name}" (no Nexus tool sets this kind)`)
    if (isShopping) {
      const tree = await liveProductGroupTree(target, g.adGroupId)
      if (tree.nodes.length) group.productGroups = { nodes: treeNodes(tree.nodes) }
      // Its product ad: the build makes one per Shopping ad group, with the source's status and labels.
      const productAds = d.ads.filter((a) => a.adGroupId === g.adGroupId && a.type === 'SHOPPING_PRODUCT_AD').sort((x, y) => byId(x.adId, y.adId))
      if (productAds[0]) {
        const adLabels = labelsOf('ad', `${g.adGroupId}~${productAds[0].adId}`)
        if (productAds[0].status === 'PAUSED') group.productAdStatus = 'PAUSED'
        if (adLabels.length) group.productAdLabels = adLabels
      }
      for (const ad of d.ads.filter((a) => a.adGroupId === g.adGroupId && !(a.type === 'SHOPPING_PRODUCT_AD' && a.adId === productAds[0]?.adId))) {
        notCopied.push(`ad ${ad.adId} (${ad.type ?? 'ad'}) in "${g.name}" (${ad.type === 'SHOPPING_PRODUCT_AD' ? 'a second product ad: the copy has one, as Google shows one per ad group' : 'Nexus makes product ads only in a Shopping ad group'})`)
      }
    } else {
      group.ads = []
      for (const ad of d.ads.filter((a) => a.adGroupId === g.adGroupId).sort((x, y) => byId(x.adId, y.adId))) {
        if (ad.type !== 'RESPONSIVE_SEARCH_AD' || !ad.finalUrls[0]) {
          notCopied.push(`ad ${ad.adId} (${ad.type ?? 'ad'}) in "${g.name}" (${AD_REASON[ad.type ?? ''] ?? (ad.finalUrls[0] ? 'Nexus makes responsive search ads only' : 'it has no final URL')})`)
          continue
        }
        const adLabels = labelsOf('ad', `${g.adGroupId}~${ad.adId}`)
        group.ads.push({
          headlines: ad.headlines.map((h) => ({ text: h.text, ...(h.pinned ? { pin: h.pinned as never } : {}) })),
          descriptions: ad.descriptions.map((h) => ({ text: h.text, ...(h.pinned ? { pin: h.pinned as never } : {}) })),
          ...(ad.path1 ? { path1: ad.path1 } : {}),
          ...(ad.path2 ? { path2: ad.path2 } : {}),
          finalUrl: ad.finalUrls[0],
          ...(ad.finalUrls.length > 1 ? { finalUrls: ad.finalUrls } : {}),
          ...(ad.finalMobileUrls[0] ? { finalMobileUrl: ad.finalMobileUrls[0] } : {}),
          ...urlFields(ad.urls),
          status: asStatus(ad.status),
          ...(adLabels.length ? { labels: adLabels } : {}),
        })
      }
    }
    const ownLinks = groupLinks.filter((l) => l.adGroupId === g.adGroupId && l.status !== 'REMOVED')
      .sort((x, y) => byId(x.assetId, y.assetId) || String(x.fieldType).localeCompare(String(y.fieldType)))
    const link: NonNullable<NonNullable<BuildAdGroup['assets']>['link']> = []
    for (const l of ownLinks) {
      if (l.source === 'AUTOMATICALLY_CREATED' || !l.fieldType) { notCopied.push(`asset ${l.assetId} (${l.fieldType ?? 'asset'}) of "${g.name}" (Google linked it itself; it makes its own for the copy)`); continue }
      link.push({ assetId: l.assetId, fieldType: l.fieldType, ...(l.status === 'PAUSED' ? { status: 'PAUSED' as const } : {}) })
    }
    if (link.length) group.assets = { link }
    adGroups.push(group)
  }

  // ── campaign assets: every link the advertiser made, the same assets linked again with their status ──
  const link: NonNullable<NonNullable<BuildCampaign['assets']>['link']> = []
  for (const a of [...d.assets].sort((x, y) => byId(x.assetId, y.assetId) || String(x.fieldType).localeCompare(String(y.fieldType)))) {
    if (a.status === 'REMOVED') continue
    if (a.source === 'AUTOMATICALLY_CREATED' || !a.fieldType) { notCopied.push(`asset ${a.assetId} (${a.fieldType ?? 'asset'}) (Google linked it itself; it makes its own for the copy)`); continue }
    link.push({ assetId: a.assetId, fieldType: a.fieldType, ...(a.status === 'PAUSED' ? { status: 'PAUSED' as const } : {}) })
  }

  const automation = (type: string) => c.assetAutomation.some((x) => x.type === type && x.status === 'OPTED_IN')
  const option = c.locationOption.include
  const campaign: BuildCampaign = {
    type: c.type as 'SEARCH' | 'SHOPPING',
    name: overrides.name,
    budget,
    bidding,
    ...(overrides.startDate ? { startDate: overrides.startDate } : {}),
    ...(overrides.endDate ? { endDate: overrides.endDate } : end && end >= today ? { endDate: end } : {}),
    searchPartners: c.networks.searchPartners,
    ...(c.type === 'SEARCH' ? { display: c.networks.display } : {}),
    ...(isShopping && c.shopping
      ? { shopping: {
        merchantId: c.shopping.merchantId ?? '', ...(c.shopping.feedLabel ? { feedLabel: c.shopping.feedLabel } : {}), priority: c.shopping.priority ?? 'LOW',
        localInventory: c.localInventory, ...(c.ignoreBrandExclusions ? { ignoreBrandExclusions: true } : {}),
      } }
      : {}),
    ...(c.type === 'SEARCH'
      ? { search: { aiMax: c.aiMax, textCustomization: automation('TEXT_ASSET_AUTOMATION'), finalUrlExpansion: automation('FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION') } }
      : {}),
    locations,
    locationOption: option === 'PRESENCE' || option === 'SEARCH_INTEREST' ? option : 'PRESENCE_OR_INTEREST',
    ...(c.locationOption.exclude === 'PRESENCE_OR_INTEREST' ? { negativeLocationOption: 'PRESENCE_OR_INTEREST' as const } : {}),
    ...(c.type === 'SEARCH' ? { languages } : {}),
    schedule,
    // Google's targeting setting as it is (audience observation or targeting, at the campaign).
    targetRestrictions: c.audienceMode,
    ...(audienceSegments.length ? { audienceSegments } : {}),
    ...(demographics.length ? { demographics } : {}),
    ...(devices.length ? { devices } : {}),
    ...(radius.length ? { radius } : {}),
    ...urlFields({ trackingTemplate: c.trackingTemplate, finalUrlSuffix: c.finalUrlSuffix, customParameters: c.customParameters }),
    // A copy keeps the keywords the source holds, broad ones too.
    allowBroad: true,
    euPoliticalAds: c.euPoliticalAds === 'CONTAINS_EU_POLITICAL_ADVERTISING',
    negatives,
    negativeLists: overrides.negativeLists ?? [...d.negativeLists].sort((x, y) => byId(x.listId, y.listId)).map((l) => ({ listId: l.listId })),
    ...(placementLists.length ? { placementLists } : {}),
    ...(exclusions.items.length ? { exclusions: exclusions.items.map(({ kind, value }) => ({ kind, value })) } : {}),
    ...(exclusions.brandLists.length ? { brandLists: [...exclusions.brandLists].sort((x, y) => byId(x.criterionId, y.criterionId)).map((b) => ({ listId: b.listId, mode: b.mode })) } : {}),
    ...(inventoryFilter.length ? { inventoryFilter } : {}),
    ...(labelsOf('campaign', c.campaignId).length ? { labels: labelsOf('campaign', c.campaignId) } : {}),
    ...(goals.level === 'CAMPAIGN' && goals.goals.length ? { conversionGoals: goals.goals } : {}),
    ...(goals.customGoalId ? { customConversionGoalId: goals.customGoalId } : {}),
    adGroups,
    assets: { link },
  }
  return { campaign, notCopied }
}

/** A live negative keyword list's keywords, for a copy of the list. */
export async function listAsBuild(target: GoogleAdsTarget, listId: string): Promise<BuildNegative[]> {
  return (await liveListKeywords(target, listId)).sort((x, y) => byId(x.criterionId, y.criterionId)).map((k) => ({ text: k.text, matchType: k.matchType }))
}
