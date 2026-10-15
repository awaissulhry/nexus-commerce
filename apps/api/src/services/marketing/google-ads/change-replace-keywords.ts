/**
 * Google Ads changes (2026-10-15, programme 2 group G3) — replace or move keywords of ONE Search campaign: a new text, a
 * new match type, another ad group of the campaign, or several of these. Google cannot change a keyword's text or match
 * type, nor move it (AdGroupCriterion `keyword` and `ad_group` are immutable), so each is added anew — with the old one's
 * max CPC of its own, status, final URLs and tracking — and the old one REMOVED, in ONE request. The numbers (clicks,
 * cost, conversions, Quality Score history) and labels stay with the removed keyword, which Google keeps only as history.
 * A removal: only when the person asked for it (the tool's confirmRemove).
 *
 * Checked 2026-10-15 in Google's v25 reference (curl of developers.google.com/google-ads/api/reference/rpc/v25/…):
 *   AdGroupCriterion    `ad_group` immutable, `keyword` (KeywordInfo) immutable; `status`, `cpc_bid_micros`, `final_urls`,
 *                       `final_mobile_urls`, `tracking_url_template`, `final_url_suffix`, `url_custom_parameters` are set
 *                       on create. AdGroupCriterionOperation create / remove (customers/{c}/adGroupCriteria/{ag}~{crit}).
 *   AdGroupCriterionStatus ENABLED / PAUSED / REMOVED.
 * Operations: the removals first, then the new keywords — so a keyword can take the place of one this same request removes
 * (Google applies a request's operations in order, all or nothing).
 *
 * Money (Owner's rules): a new keyword that can serve at once (ENABLED, in an enabled ad group of the enabled campaign)
 * is SPENDS MONEY, as for any keyword added; so is a wider match type (it matches more searches), and a keyword that uses
 * its ad group's default max CPC moved to an ad group whose default is higher.
 */
import { changeLines, keywordTextProblem, money, plural, type GoogleChangeDraft } from './change-draft.js'
import { biddingNote, campaignPausedNote, changeableCampaign, raiseSentence } from './change-ad-groups.js'
import { idOf, keywordKey, microsOfCents, type LiveCampaign, type MatchType } from './live.js'
import { byGoogleId, type LiveAdGroup } from './live-keywords.js'
import type { CustomParameter, LiveKeywordUrls } from './live-edit.js'
import type { GoogleMutateOperation, GoogleMutateResponse } from './write-client.js'

export interface KeywordReplaceRequest {
  campaignId: string
  keywords: Array<{ keywordId: string; text?: string; matchType?: MatchType; toAdGroupId?: string }>
  /** A BROAD match keyword (or a campaign set to broad match for all its keywords) only with this. */
  allowBroad?: boolean
}

export interface KeywordReplaceLiveState {
  campaigns: LiveCampaign[]
  adGroups: LiveAdGroup[]
  /** The campaign's keywords and ad group negatives, with their URLs (live-edit.ts). */
  keywords: LiveKeywordUrls[]
  /** The campaign's keyword match type (BROAD = every keyword acts as broad match). */
  keywordMatchType?: string | null
}

/** One keyword as it was (from) or is made (to). */
export interface KeywordRef { keywordId: string; adGroupId: string; text: string; matchType: MatchType }
/** What a replacement wrote: the keyword removed, the one made (`new:<operation index>` until Google gave its id), what it kept. */
export interface KeywordReplaceRecord {
  campaignId: string
  replaced: Array<{ from: KeywordRef; to: KeywordRef; status: string; bidCents: number | null }>
}
export interface KeywordReplaceBefore { campaignId: string; removed: Array<KeywordRef & { status: string | null; bidCents: number | null }> }

export const MAX_REPLACE_KEYWORDS = 100
const NEW = 'new:'
const kw = (text: string, matchType: string) => (matchType === 'EXACT' ? `[${text}]` : matchType === 'PHRASE' ? `"${text}"` : text)
/** How many searches a match type reaches: EXACT < PHRASE < BROAD. */
const REACH: Record<string, number> = { EXACT: 0, PHRASE: 1, BROAD: 2 }

/** What a new keyword copies of the old one besides its text and match type: max CPC of its own, URLs and tracking. */
function keptFields(k: LiveKeywordUrls): Record<string, unknown> {
  return {
    ...(k.cpcBidCents !== null ? { cpcBidMicros: microsOfCents(k.cpcBidCents) } : {}),
    ...(k.finalUrls.length ? { finalUrls: k.finalUrls } : {}),
    ...(k.finalMobileUrls.length ? { finalMobileUrls: k.finalMobileUrls } : {}),
    ...(k.urls.trackingTemplate ? { trackingUrlTemplate: k.urls.trackingTemplate } : {}),
    ...(k.urls.finalUrlSuffix ? { finalUrlSuffix: k.urls.finalUrlSuffix } : {}),
    ...(k.urls.customParameters.length ? { urlCustomParameters: k.urls.customParameters satisfies CustomParameter[] } : {}),
  }
}

export function keywordReplaceDraft(customer: string, currency: string, request: KeywordReplaceRequest, live: KeywordReplaceLiveState): GoogleChangeDraft | { refusal: string } {
  const asked = request.keywords ?? []
  if (!asked.length) return { refusal: 'Name the keywords to replace or move (keywords).' }
  if (asked.length > MAX_REPLACE_KEYWORDS) return { refusal: `At most ${MAX_REPLACE_KEYWORDS} keywords in one request (${asked.length} asked).` }
  const picked = changeableCampaign(live.campaigns, request.campaignId)
  if ('refusal' in picked) return picked
  const { campaign, kind } = picked
  if (kind !== 'SEARCH') return { refusal: `Campaign "${campaign.name}" is a Shopping campaign: it has no keywords.` }
  const groupById = new Map(live.adGroups.map((g) => [g.adGroupId, g]))
  const positives = live.keywords.filter((k) => !k.negative)
  const byId = new Map(positives.map((k) => [k.id, k]))
  const groupName = (id: string) => `"${groupById.get(id)?.name ?? id}"`

  // 1. what each becomes; every problem is refused before anything is sent
  const plans: Array<{ old: LiveKeywordUrls; to: KeywordRef }> = []
  const seen = new Set<string>()
  for (const a of asked) {
    if (seen.has(a.keywordId)) return { refusal: `Keyword ${a.keywordId} is named twice.` }
    seen.add(a.keywordId)
    const old = byId.get(a.keywordId)
    if (!old) return { refusal: `Keyword ${a.keywordId} is not a keyword of campaign "${campaign.name}" (or it is removed, or a negative keyword: set-google-negatives). google-ads-live view campaign lists its keywords as adGroupId and criterionId.` }
    if (old.status !== 'ENABLED' && old.status !== 'PAUSED') return { refusal: `Keyword ${a.keywordId} is ${String(old.status ?? 'in an unknown state').toLowerCase()}: only an enabled or paused keyword is replaced.` }
    const adGroupId = a.toAdGroupId ?? old.adGroupId
    const g = groupById.get(adGroupId)
    if (!g) return { refusal: `Ad group ${adGroupId} is not in campaign "${campaign.name}" (or it is removed): keywords move within one campaign.` }
    if (g.type !== 'SEARCH_STANDARD') return { refusal: `Ad group "${g.name}" is a ${g.type ?? 'special'} ad group: keywords go in standard Search ad groups only.` }
    const text = (a.text ?? old.text).trim().replace(/\s+/g, ' ')
    const problem = keywordTextProblem(text)
    if (problem) return { refusal: `The keyword "${a.text}" ${problem}.` }
    const matchType = a.matchType ?? old.matchType
    if (matchType === 'BROAD' && !request.allowBroad) return { refusal: `The keyword ${kw(text, matchType)} is BROAD match: Nexus adds EXACT and PHRASE keywords; BROAD only with allowBroad: true.` }
    if (adGroupId === old.adGroupId && keywordKey(text, matchType) === keywordKey(old.text, old.matchType)) {
      return { refusal: `Keyword ${kw(old.text, old.matchType)} (${a.keywordId}) would stay the same keyword in the same ad group (Google compares keywords without case): nothing to replace.` }
    }
    plans.push({ old, to: { keywordId: '', adGroupId, text, matchType } })
  }
  if (live.keywordMatchType === 'BROAD' && !request.allowBroad) {
    return { refusal: `Campaign "${campaign.name}" is set to broad match for all its keywords (its keyword match type is BROAD): every keyword added there acts as broad match. Replace keywords in it only with allowBroad: true.` }
  }
  // Two keywords with one text and match type in one ad group: Google refuses the second. What the ad group holds after
  // the removals, plus each new keyword in turn.
  const removing = new Set(plans.map((p) => p.old.id))
  const holds = new Map<string, Set<string>>()
  for (const k of positives) if (!removing.has(k.id)) holds.set(k.adGroupId, (holds.get(k.adGroupId) ?? new Set()).add(keywordKey(k.text, k.matchType)))
  for (const p of plans) {
    const key = keywordKey(p.to.text, p.to.matchType)
    const there = holds.get(p.to.adGroupId) ?? new Set<string>()
    if (there.has(key)) return { refusal: `Ad group ${groupName(p.to.adGroupId)} already holds ${kw(p.to.text, p.to.matchType)} (or this request makes it twice): to only take ${kw(p.old.text, p.old.matchType)} away, remove it (remove-google-ads-items).` }
    holds.set(p.to.adGroupId, there.add(key))
  }

  // 2. the operations: removals first, then the new keywords
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const record: KeywordReplaceRecord = { campaignId: campaign.campaignId, replaced: [] }
  const before: KeywordReplaceBefore = { campaignId: campaign.campaignId, removed: [] }
  for (const p of plans) operations.push({ adGroupCriterionOperation: { remove: `${customer}/adGroupCriteria/${p.old.id}` } })
  const bidOf = (k: LiveKeywordUrls, adGroupId: string) => k.cpcBidCents ?? groupById.get(adGroupId)?.cpcBidCents ?? null
  const serving: string[] = []
  const wider: string[] = []
  const raises: Array<{ label: string; from: string; to: string }> = []
  for (const p of plans) {
    const { old, to } = p
    const status = old.status as 'ENABLED' | 'PAUSED'
    to.keywordId = `${NEW}${operations.length}`
    operations.push({ adGroupCriterionOperation: { create: { adGroup: `${customer}/adGroups/${to.adGroupId}`, status, keyword: { text: to.text, matchType: to.matchType }, ...keptFields(old) } } })
    const from: KeywordRef = { keywordId: old.id, adGroupId: old.adGroupId, text: old.text, matchType: old.matchType }
    record.replaced.push({ from, to, status, bidCents: old.cpcBidCents })
    before.removed.push({ ...from, status: old.status, bidCents: old.cpcBidCents })
    const moved = to.adGroupId !== old.adGroupId
    const bidNow = bidOf(old, old.adGroupId)
    const bidThen = bidOf(old, to.adGroupId)
    lines.push([
      `${kw(old.text, old.matchType)} in ${groupName(old.adGroupId)}`,
      `${status}, max CPC ${money(bidNow, currency)}${old.cpcBidCents === null ? ' (its ad group\'s default)' : ''}`,
      `REMOVED; new ${kw(to.text, to.matchType)}${moved ? ` in ${groupName(to.adGroupId)}` : ''}, ${status}, max CPC ${money(bidThen, currency)}${old.cpcBidCents === null ? ' (its ad group\'s default)' : ''}`,
    ])
    const label = `${kw(old.text, old.matchType)} → ${kw(to.text, to.matchType)}${moved ? ` (${groupName(to.adGroupId)})` : ''}`
    if (status === 'ENABLED' && campaign.status === 'ENABLED' && groupById.get(to.adGroupId)?.status === 'ENABLED') serving.push(label)
    if ((REACH[to.matchType] ?? 2) > (REACH[old.matchType] ?? 2)) wider.push(label)
    if (bidThen !== null && (bidNow === null || bidThen > bidNow)) raises.push({ label, from: money(bidNow, currency), to: money(bidThen, currency) })
  }

  const n = plans.length
  const spendsMoney: string[] = []
  if (serving.length) spendsMoney.push(`Adds ${plural(serving.length, 'keyword')} that can show ads at once (each in place of a removed one): ENABLED, in enabled ad groups of the enabled campaign "${campaign.name}" — ${serving.slice(0, 10).join('; ')}${serving.length > 10 ? ` (+${serving.length - 10} more)` : ''}.`)
  if (wider.length) spendsMoney.push(`${plural(wider.length, 'replacement')} ${wider.length === 1 ? 'has' : 'have'} a wider match type, so ${wider.length === 1 ? 'it matches' : 'they match'} more searches: ${wider.slice(0, 10).join('; ')}${wider.length > 10 ? ` (+${wider.length - 10} more)` : ''}${campaignPausedNote(campaign)}.`)
  if (raises.length) spendsMoney.push(raiseSentence('max CPC', plural(raises.length, 'keyword'), raises, ` (each uses the default max CPC of the ad group it moves to)${campaignPausedNote(campaign)}`))
  const warnings = [
    `Google cannot change a keyword's text or match type, nor move it: each is added anew (its max CPC of its own, status, final URLs and tracking kept) and the old one REMOVED, in this one request. The numbers (clicks, cost, conversions, Quality Score history) and labels stay with the removed ${n === 1 ? 'keyword' : 'keywords'}, which Google keeps only as history; the new ${n === 1 ? 'one starts' : 'ones start'} from nothing. Undo replaces back the same way (new ids again).`,
  ]
  if (live.keywordMatchType === 'BROAD') warnings.push(`Campaign "${campaign.name}" is set to broad match for all its keywords: every new keyword acts as broad match, whatever its own match type.`)
  const bidNote = biddingNote(campaign, 'the keywords\' max CPCs')
  if (bidNote) warnings.push(bidNote)
  const { changes, more } = changeLines(lines)
  const movedCount = plans.filter((p) => p.to.adGroupId !== p.old.adGroupId).length
  const involvedGroups = new Set(plans.flatMap((p) => [p.old.adGroupId, p.to.adGroupId]))
  return {
    summary: `Google Ads keywords in "${campaign.name}": replace ${plural(n, 'keyword')}${movedCount ? ` (${movedCount} into another ad group)` : ''} — each added anew, the old one removed.`,
    changes,
    totals: { operations: operations.length, keywordsReplaced: n, keywordsMoved: movedCount, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney,
    skipped: [],
    operations,
    stands: {
      campaign: { campaignId: campaign.campaignId, status: campaign.status, type: campaign.type, bidding: campaign.bidding },
      keywordMatchType: live.keywordMatchType ?? null,
      adGroups: live.adGroups.filter((g) => involvedGroups.has(g.adGroupId))
        .map((g) => ({ adGroupId: g.adGroupId, status: g.status, type: g.type, cpcBidCents: g.cpcBidCents, keywords: positives.filter((k) => k.adGroupId === g.adGroupId).map((k) => `${k.id}:${keywordKey(k.text, k.matchType)}`) }))
        .sort((x, y) => byGoogleId(x.adGroupId, y.adGroupId)),
      // Everything a new keyword copies: a later change of an old one changes the request.
      keywords: plans.map((p) => ({ id: p.old.id, status: p.old.status, cpcBidCents: p.old.cpcBidCents, finalUrls: p.old.finalUrls, finalMobileUrls: p.old.finalMobileUrls, urls: p.old.urls })),
    },
    before,
    after: record,
  }
}

/** The record of a run: each new keyword gets the id Google gave it (`adGroupId~criterionId`), by operation index. */
export function keywordReplaceRecordAfterRun(after: KeywordReplaceRecord, responses: GoogleMutateResponse[]): KeywordReplaceRecord {
  return {
    ...after,
    replaced: after.replaced.map((r) => {
      if (!r.to.keywordId.startsWith(NEW)) return { ...r }
      const id = idOf(responses[Number(r.to.keywordId.slice(NEW.length))]?.adGroupCriterionResult?.resourceName)
      return { ...r, to: { ...r.to, keywordId: id ?? r.to.keywordId } }
    }),
  }
}
