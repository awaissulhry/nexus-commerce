/**
 * Google Ads changes (2026-10-15) — keywords and negative keywords of ONE campaign. One atomic request each.
 *
 *   keywordChangeDraft    Search ad groups' keywords: add (EXACT / PHRASE; BROAD only when allowed), change max CPCs by
 *                         keyword, change max CPCs by a filter (a new bid or a percent), and — only as the undo of an
 *                         earlier keyword change — remove the keywords that change added.
 *   negativeChangeDraft   negative keywords of the campaign (campaign criteria) and of its ad groups (ad group
 *                         criteria): add and remove. Search and Standard Shopping campaigns.
 *
 * Checked on 2026-10-15 in Google's v25 reference (curl of developers.google.com/google-ads/api/reference/rpc/v25/…):
 * - AdGroupCriterion: `ad_group` (immutable), `keyword` (KeywordInfo, immutable: `text` "at most 80 characters and 10
 *   words", `match_type` KeywordMatchType EXACT / PHRASE / BROAD), `negative` (immutable: "remove then re-add" to
 *   switch), `status` (AdGroupCriterionStatus ENABLED / PAUSED), `cpc_bid_micros` ("The CPC bid"). Resource name
 *   `customers/{customer_id}/adGroupCriteria/{ad_group_id}~{criterion_id}`; AdGroupCriterionOperation create / update
 *   (+ update_mask) / remove (that resource name).
 * - CampaignCriterion: `campaign` (immutable), `keyword` (immutable), `negative` (immutable). Resource name
 *   `customers/{customer_id}/campaignCriteria/{campaign_id}~{criterion_id}`; CampaignCriterionOperation create / remove.
 * - A max CPC update masks `cpc_bid_micros`; a field in the mask that the body leaves out is CLEARED (PLAN.md "v25
 *   facts"): that is how a keyword goes back to its ad group's default max CPC.
 *
 * Money (Owner's rules): a bid raise is named in `spendsMoney` (how many, from → to for up to 20). New keywords inside
 * a campaign that is not ENABLED are made ENABLED (nothing serves); inside an ENABLED campaign they are made PAUSED
 * unless the request says `enable: true` — new keywords that can serve at once (ENABLED, in an ENABLED ad group of the
 * ENABLED campaign) are named in `spendsMoney`. Removing a negative keyword lets more searches show ads: also named in
 * `spendsMoney` (with "nothing spends until it is enabled" when the campaign is not enabled). A campaign whose keyword
 * match type is BROAD makes every keyword it holds act as broad match: adding keywords there needs allowBroad.
 * Every list read from Google is used in id order, so the operations (and the approved `plan`) never follow row order.
 */
import { changeLines, keywordTextProblem, money, plural, type GoogleChangeDraft } from './change-draft.js'
import { biddingNote, campaignPausedNote, changeableCampaign, raiseSentence, raiseTotal } from './change-ad-groups.js'
import { idOf, keywordKey, microsOfCents, type LiveCampaign, type MatchType } from './live.js'
import { byGoogleId, type LiveAdGroup, type LiveCampaignNegative, type LiveKeyword } from './live-keywords.js'
import type { GoogleMutateOperation, GoogleMutateResponse } from './write-client.js'

/** The most keyword operations one change sends (adds, bid changes and removals together). */
export const MAX_KEYWORD_OPERATIONS = 250

const NEW = 'new:'
const kw = (text: string, matchType: string) => (matchType === 'EXACT' ? `[${text}]` : matchType === 'PHRASE' ? `"${text}"` : text)
const lower = (s: string | null) => String(s ?? 'not enabled').toLowerCase()

// ── keywords ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface KeywordChangeRequest {
  campaignId: string
  /** Keywords to add to Search ad groups of the campaign; a max CPC of its own, or the ad group's default. */
  add?: Array<{ adGroupId: string; text: string; matchType: MatchType; bidCents?: number; status?: 'ENABLED' | 'PAUSED' }>
  /** New max CPCs of keywords by id (`adGroupId~criterionId`); null = no bid of its own (its ad group's default). */
  bids?: Array<{ keywordId: string; bidCents: number | null }>
  /** New max CPCs of every keyword a filter matches: a new bid, or a percent of the bid each uses now. */
  bulk?: { adGroupId?: string; matchType?: MatchType; minBidCents?: number; maxBidCents?: number; bidCents?: number; percent?: number }
  /** BROAD match keywords are refused unless this is true. */
  allowBroad?: boolean
  /** In an ENABLED campaign: make the new keywords ENABLED (they can spend at once) instead of PAUSED. */
  enable?: boolean
  /** Only the undo of an earlier keyword change: the keywords it added, removed again. */
  removeAdded?: string[]
}

export interface KeywordLiveState {
  campaigns: LiveCampaign[]
  adGroups: LiveAdGroup[]
  /** The campaign's keywords and ad group negatives (live-keywords.ts). */
  keywords: LiveKeyword[]
  /** For removeAdded: the keywords the earlier change (the one undone) added, as its record holds them. */
  addedByChange?: KeywordRecordEntry[]
  /** For add: the campaign's keyword match type (BROAD = every keyword acts as broad match). */
  keywordMatchType?: string | null
}

export interface KeywordRecordEntry { keywordId: string; adGroupId: string; text: string; matchType: MatchType; bidCents: number | null; status: string }

/** What a keyword change replaced (before) and wrote (after). */
export interface KeywordChangeRecord {
  campaignId: string
  /** Max CPCs of its own: before what they were, after what it wrote (null = the ad group's default). */
  bids: Array<{ keywordId: string; bidCents: number | null }>
  /** after: the keywords it added (Google's ids after the run; `new:<operation index>` before). */
  added?: KeywordRecordEntry[]
  /** before: the keywords it removed (the undo of an earlier change), as they were. */
  removed?: KeywordRecordEntry[]
}

export function keywordChangeDraft(customer: string, currency: string, request: KeywordChangeRequest, live: KeywordLiveState): GoogleChangeDraft | { refusal: string } {
  const adds = request.add ?? []
  const bids = request.bids ?? []
  const removes = request.removeAdded ?? []
  const bulk = request.bulk
  if (!adds.length && !bids.length && !removes.length && !bulk) return { refusal: 'Say what to change: add, bids or bulk.' }
  const picked = changeableCampaign(live.campaigns, request.campaignId)
  if ('refusal' in picked) return picked
  const { campaign, kind } = picked
  if (kind !== 'SEARCH') return { refusal: `Campaign "${campaign.name}" is a Shopping campaign: it has no keywords (its negative keywords: set-google-negatives; its bids are on product groups).` }
  const groupById = new Map(live.adGroups.map((g) => [g.adGroupId, g]))
  // In id order (never Google's row order): the operations, and so the approved `plan`, do not move with it.
  const positives = live.keywords.filter((k) => !k.negative).sort((a, b) => byGoogleId(a.keywordId, b.keywordId))
  const keywordById = new Map(positives.map((k) => [k.keywordId, k]))
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  const before: KeywordChangeRecord = { campaignId: campaign.campaignId, bids: [] }
  const after: KeywordChangeRecord = { campaignId: campaign.campaignId, bids: [] }
  const groupName = (id: string) => `"${groupById.get(id)?.name ?? id}"`
  const usesNow = (k: LiveKeyword): number | null => k.cpcBidCents ?? k.effectiveCpcBidCents ?? groupById.get(k.adGroupId)?.cpcBidCents ?? null
  const bidWords = (k: LiveKeyword, cents: number | null): string =>
    cents === null ? `its ad group's default ${money(groupById.get(k.adGroupId)?.cpcBidCents ?? null, currency)}` : money(cents, currency)

  // 1. removals (only the undo of an earlier change: the keywords it added)
  const removing = new Set<string>()
  if (removes.length) {
    const allowed = new Map((live.addedByChange ?? []).map((a) => [a.keywordId, a]))
    const moved: string[] = []
    for (const id of [...new Set(removes)].sort(byGoogleId)) {
      const wrote = allowed.get(id)
      if (!wrote) return { refusal: `Keyword ${id} was not added by the change this undoes: removeAdded removes only what that change added, nothing else.` }
      const k = keywordById.get(id)
      if (!k) { skipped.push(`Keyword ${id} is no longer in the campaign.`); continue }
      // Undo's "nothing moved since": only a keyword still as that change made it is removed.
      const diff = [
        ...(k.status !== wrote.status ? [`status ${wrote.status} → ${k.status ?? '(none)'}`] : []),
        ...(k.cpcBidCents !== wrote.bidCents ? [`max CPC ${bidWords(k, wrote.bidCents)} → ${bidWords(k, k.cpcBidCents)}`] : []),
      ]
      if (diff.length) { moved.push(`${kw(k.text, k.matchType)} (${id}): ${diff.join(', ')}`); continue }
      operations.push({ adGroupCriterionOperation: { remove: `${customer}/adGroupCriteria/${id}` } })
      removing.add(id)
      before.removed = [...(before.removed ?? []), { keywordId: id, adGroupId: k.adGroupId, text: k.text, matchType: k.matchType, bidCents: k.cpcBidCents, status: k.status ?? 'ENABLED' }]
      lines.push([`${kw(k.text, k.matchType)} in ${groupName(k.adGroupId)}`, k.status ?? 'in the ad group', '(removed)'])
    }
    if (moved.length) {
      return { refusal: `Not removed: ${moved.length === 1 ? 'a keyword' : `${moved.length} keywords`} the undone change added moved since it ran — ${moved.join('; ')}. Removing ${moved.length === 1 ? 'it' : 'them'} would overwrite that later change.` }
    }
    if (removing.size) warnings.push(`Removes ${plural(removing.size, 'keyword')} that the undone change added: they stop showing ads (a removed keyword cannot be enabled again, only added anew).`)
  }

  // 2. bids by keyword, then by filter (a keyword named by id is left out of the filter)
  const target = new Map<string, { k: LiveKeyword; to: number | null }>()
  for (const b of bids) {
    if (target.has(b.keywordId)) return { refusal: `Keyword ${b.keywordId} is named twice in bids.` }
    const k = keywordById.get(b.keywordId)
    if (!k) return { refusal: `Keyword ${b.keywordId} is not a keyword of campaign "${campaign.name}" (or it is removed, or a negative). google-ads-live view campaign lists its keywords as adGroupId and criterionId.` }
    if (removing.has(b.keywordId)) return { refusal: `Keyword ${b.keywordId} is both removed and given a bid.` }
    target.set(b.keywordId, { k, to: b.bidCents })
  }
  if (bulk) {
    if ((bulk.bidCents === undefined) === (bulk.percent === undefined)) return { refusal: 'bulk: give bidCents (a new max CPC) or percent (a change of the max CPC each keyword uses now), one of them.' }
    if (bulk.adGroupId && !groupById.has(bulk.adGroupId)) return { refusal: `Ad group ${bulk.adGroupId} is not in campaign "${campaign.name}" (or it is removed).` }
    if (bulk.minBidCents !== undefined && bulk.maxBidCents !== undefined && bulk.minBidCents > bulk.maxBidCents) return { refusal: 'bulk: minBidCents is above maxBidCents.' }
    let matched = 0
    let noBid = 0
    for (const k of positives) {
      if (target.has(k.keywordId) || removing.has(k.keywordId)) continue
      if (bulk.adGroupId && k.adGroupId !== bulk.adGroupId) continue
      if (bulk.matchType && k.matchType !== bulk.matchType) continue
      const now = usesNow(k)
      if ((bulk.minBidCents !== undefined || bulk.maxBidCents !== undefined) && now === null) continue
      if (bulk.minBidCents !== undefined && now! < bulk.minBidCents) continue
      if (bulk.maxBidCents !== undefined && now! > bulk.maxBidCents) continue
      matched += 1
      if (bulk.bidCents !== undefined) { target.set(k.keywordId, { k, to: bulk.bidCents }); continue }
      if (now === null) { noBid += 1; continue }
      target.set(k.keywordId, { k, to: Math.max(1, Math.round(now * (100 + bulk.percent!) / 100)) })
    }
    if (!matched) skipped.push('bulk: no keyword of the campaign matches the filter.')
    if (noBid) skipped.push(`bulk: ${plural(noBid, 'keyword')} ${noBid === 1 ? 'has' : 'have'} no max CPC to change by a percent.`)
  }
  if (target.size + adds.length + removing.size > MAX_KEYWORD_OPERATIONS) {
    return { refusal: `This change would touch ${target.size + adds.length + removing.size} keywords: at most ${MAX_KEYWORD_OPERATIONS} in one request. Narrow it (adGroupId, matchType, a bid range) or split it.` }
  }
  const raises: Array<{ label: string; from: string; to: string; fromCents: number | null; toCents: number; canServe: boolean }> = []
  let lowered = 0
  let same = 0
  for (const { k, to } of target.values()) {
    if (to === k.cpcBidCents) { same += 1; continue }
    // A bid it uses now: its own, or (none of its own) its ad group's default.
    const fromUses = usesNow(k)
    const toUses = to ?? groupById.get(k.adGroupId)?.cpcBidCents ?? null
    operations.push({
      adGroupCriterionOperation: { update: { resourceName: `${customer}/adGroupCriteria/${k.keywordId}`, ...(to !== null ? { cpcBidMicros: microsOfCents(to) } : {}) }, updateMask: 'cpc_bid_micros' },
    })
    before.bids.push({ keywordId: k.keywordId, bidCents: k.cpcBidCents })
    after.bids.push({ keywordId: k.keywordId, bidCents: to })
    lines.push([`${kw(k.text, k.matchType)} in ${groupName(k.adGroupId)} max CPC`, bidWords(k, k.cpcBidCents), bidWords(k, to)])
    if (toUses !== null && (fromUses === null || toUses > fromUses)) {
      raises.push({ label: `${kw(k.text, k.matchType)} (${groupName(k.adGroupId)})`, from: money(fromUses, currency), to: money(toUses, currency), fromCents: fromUses, toCents: toUses, canServe: k.status === 'ENABLED' && groupById.get(k.adGroupId)?.status === 'ENABLED' })
    } else if (toUses !== fromUses) lowered += 1
  }
  if (same) skipped.push(`${plural(same, 'keyword')} already ${same === 1 ? 'has' : 'have'} that max CPC.`)
  if (raises.length) {
    const serving = raises.filter((r) => r.canServe).length
    const note = campaignPausedNote(campaign) || (serving === raises.length ? '' : ` (${serving} of them can serve now: keyword and ad group enabled)`)
    spends.push(raiseSentence('max CPC', plural(raises.length, 'keyword'), raises, note))
    const total = raiseTotal('max CPCs', plural(raises.length, 'keyword'), raises, currency, lowered)
    if (total) spends.push(total)
  }

  // 3. new keywords
  const on = campaign.status === 'ENABLED'
  const byRule = !on || request.enable ? 'ENABLED' : 'PAUSED'
  if (adds.length && live.keywordMatchType === 'BROAD') {
    if (!request.allowBroad) {
      return { refusal: `Campaign "${campaign.name}" is set to broad match for all its keywords (its keyword match type is BROAD): every keyword added there acts as broad match, whatever its own match type. Add keywords to it only with allowBroad: true.` }
    }
    warnings.push(`Campaign "${campaign.name}" is set to broad match for all its keywords (keyword match type BROAD): every new keyword acts as broad match, whatever its own match type, and matches many more searches.`)
  }
  const existing = new Map<string, Set<string>>()
  for (const k of positives) existing.set(k.adGroupId, (existing.get(k.adGroupId) ?? new Set()).add(keywordKey(k.text, k.matchType)))
  const seen = new Set<string>()
  const added: KeywordRecordEntry[] = []
  let broad = 0
  let pausedByRule = 0
  for (const a of adds) {
    const g = groupById.get(a.adGroupId)
    if (!g) return { refusal: `Ad group ${a.adGroupId} is not in campaign "${campaign.name}" (or it is removed). google-ads-live view campaign lists its ad groups.` }
    if (g.type !== 'SEARCH_STANDARD') return { refusal: `Ad group "${g.name}" is a ${g.type ?? 'special'} ad group: keywords are added to standard Search ad groups only.` }
    const text = a.text.trim().replace(/\s+/g, ' ')
    const problem = keywordTextProblem(text)
    if (problem) return { refusal: `The keyword "${a.text}" ${problem}.` }
    if (a.matchType === 'BROAD' && !request.allowBroad) return { refusal: `The keyword ${kw(text, a.matchType)} is BROAD match: Nexus adds EXACT and PHRASE keywords; BROAD only with allowBroad: true.` }
    const key = keywordKey(text, a.matchType)
    if (seen.has(`${g.adGroupId}|${key}`)) continue
    seen.add(`${g.adGroupId}|${key}`)
    if (existing.get(g.adGroupId)?.has(key)) { skipped.push(`${kw(text, a.matchType)} is already in ad group "${g.name}".`); continue }
    if (a.matchType === 'BROAD') broad += 1
    // An undo puts a keyword back with the status it had; anything else follows the rule above.
    const status = a.status ?? byRule
    if (!a.status && status === 'PAUSED') pausedByRule += 1
    added.push({ keywordId: `${NEW}${operations.length}`, adGroupId: g.adGroupId, text, matchType: a.matchType, bidCents: a.bidCents ?? null, status })
    operations.push({
      adGroupCriterionOperation: {
        create: { adGroup: `${customer}/adGroups/${g.adGroupId}`, status, keyword: { text, matchType: a.matchType }, ...(a.bidCents !== undefined ? { cpcBidMicros: microsOfCents(a.bidCents) } : {}) },
      },
    })
    lines.push([`add ${kw(text, a.matchType)} to "${g.name}"`, '(none)', `${status}, max CPC ${a.bidCents !== undefined ? money(a.bidCents, currency) : `its ad group's default ${money(g.cpcBidCents, currency)}`}`])
  }
  if (added.length) {
    after.added = added
    const enabledNew = added.filter((a) => a.status === 'ENABLED')
    if (on) {
      const serving = enabledNew.filter((a) => groupById.get(a.adGroupId)?.status === 'ENABLED')
      if (serving.length) {
        const groups = [...new Set(serving.map((a) => a.adGroupId))]
        spends.push(`Adds ${plural(serving.length, 'keyword')} that can show ads at once: ENABLED, in ${groups.length === 1 ? `the enabled ad group ${groupName(groups[0])}` : `${groups.length} enabled ad groups`} of the enabled campaign "${campaign.name}".`)
      }
      const idle = enabledNew.length - serving.length
      if (idle) warnings.push(`${plural(idle, 'new keyword')} ${idle === 1 ? 'is' : 'are'} ENABLED in a paused ad group: ${idle === 1 ? 'it shows' : 'they show'} no ads until the ad group is enabled.`)
      if (pausedByRule) warnings.push(`${pausedByRule === added.length ? 'New keywords are' : `${plural(pausedByRule, 'new keyword')} are`} made PAUSED because the campaign "${campaign.name}" is enabled: they show no ads until a person enables them (or ask again with enable: true).`)
    } else if (enabledNew.length) {
      warnings.push(`New keywords are made ENABLED: the campaign "${campaign.name}" is ${lower(campaign.status)}, so they show no ads until it is enabled.`)
    }
    if (broad) warnings.push(`${plural(broad, 'BROAD match keyword')}: ${broad === 1 ? 'it matches' : 'they match'} many more searches than EXACT or PHRASE (and can spend on them).`)
  } else if (request.enable) {
    warnings.push('enable: true changes nothing here: it applies to new keywords only.')
  }
  const bidNote = after.bids.length || added.some((a) => a.bidCents !== null) ? biddingNote(campaign, 'keyword max CPCs') : null
  if (bidNote) warnings.push(bidNote)

  if (operations.length === 0) return { refusal: `Nothing to change: ${skipped.join(' ') || 'no keyword is changed.'}` }
  const { changes, more } = changeLines(lines)
  const parts: string[] = []
  const statuses = [...new Set(added.map((a) => a.status))]
  if (added.length) parts.push(`add ${plural(added.length, 'keyword')} (${statuses.length === 1 ? statuses[0] : statuses.join(' and ')})`)
  if (after.bids.length) parts.push(`change the max CPC of ${plural(after.bids.length, 'keyword')} (${raises.length} up, ${lowered} down)`)
  if (removing.size) parts.push(`remove ${plural(removing.size, 'keyword')} the undone change added`)
  const involvedGroups = new Set([...adds.map((a) => a.adGroupId), ...[...target.values()].map((t) => t.k.adGroupId), ...[...removing].map((id) => keywordById.get(id)!.adGroupId)])
  const involvedKeywords = new Set([...target.keys(), ...removing])
  return {
    summary: `Google Ads keywords in "${campaign.name}": ${parts.join('; ')}.`,
    changes,
    totals: {
      operations: operations.length,
      keywordsAdded: added.length,
      bidsRaised: raises.length,
      bidsLowered: lowered,
      keywordsRemoved: removing.size,
      ...(more ? { linesNotShown: more } : {}),
    },
    warnings,
    spendsMoney: spends,
    skipped,
    operations,
    stands: {
      campaign: { campaignId: campaign.campaignId, status: campaign.status, type: campaign.type, bidding: campaign.bidding },
      adGroups: live.adGroups.filter((g) => involvedGroups.has(g.adGroupId))
        .map((g) => ({ adGroupId: g.adGroupId, status: g.status, type: g.type, cpcBidCents: g.cpcBidCents })).sort((x, y) => byGoogleId(x.adGroupId, y.adGroupId)),
      keywords: positives.filter((k) => involvedKeywords.has(k.keywordId))
        .map((k) => ({ keywordId: k.keywordId, status: k.status, cpcBidCents: k.cpcBidCents, effectiveCpcBidCents: k.effectiveCpcBidCents })),
      existing: [...new Set(adds.map((a) => a.adGroupId))].sort(byGoogleId).map((id) => ({ adGroupId: id, keywords: [...(existing.get(id) ?? [])].sort() })),
      ...(adds.length ? { keywordMatchType: live.keywordMatchType ?? null } : {}),
    },
    before,
    after,
  }
}

/** The record of a run: the keywords it added get the ids Google gave them (`adGroupId~criterionId`), by operation index. */
export function keywordRecordAfterRun(after: KeywordChangeRecord, responses: GoogleMutateResponse[]): KeywordChangeRecord {
  return {
    ...after,
    bids: after.bids.map((b) => ({ ...b })),
    ...(after.added ? {
      added: after.added.map((a) => {
        if (!a.keywordId.startsWith(NEW)) return { ...a }
        const id = idOf(responses[Number(a.keywordId.slice(NEW.length))]?.adGroupCriterionResult?.resourceName)
        return { ...a, keywordId: id ?? a.keywordId }
      }),
    } : {}),
  }
}

// ── negative keywords ──────────────────────────────────────────────────────────────────────────────────────────────

export interface NegativeKeyword {
  text: string
  matchType: MatchType
  /** An ad group of the campaign; absent = the campaign's own negative keyword. */
  adGroupId?: string
}

export interface NegativeChangeRequest {
  campaignId: string
  add?: NegativeKeyword[]
  remove?: NegativeKeyword[]
}

export interface NegativeLiveState {
  campaigns: LiveCampaign[]
  adGroups: LiveAdGroup[]
  /** The campaign's keywords and ad group negatives (live-keywords.ts). */
  keywords: LiveKeyword[]
  campaignNegatives: LiveCampaignNegative[]
}

export interface NegativeRecordEntry { adGroupId: string | null; text: string; matchType: MatchType; criterionId?: string }

/** What a negative keyword change wrote: the negatives it added (Google's criterion ids after the run) and removed. */
export interface NegativeChangeRecord {
  campaignId: string
  added: NegativeRecordEntry[]
  removed: NegativeRecordEntry[]
}

export function negativeChangeDraft(customer: string, request: NegativeChangeRequest, live: NegativeLiveState): GoogleChangeDraft | { refusal: string } {
  const add = request.add ?? []
  const remove = request.remove ?? []
  if (!add.length && !remove.length) return { refusal: 'Say what to change: add or remove.' }
  const picked = changeableCampaign(live.campaigns, request.campaignId)
  if ('refusal' in picked) return picked
  const { campaign } = picked
  const groupById = new Map(live.adGroups.map((g) => [g.adGroupId, g]))
  const where = (adGroupId: string | null) => (adGroupId ? `ad group "${groupById.get(adGroupId)?.name ?? adGroupId}"` : `campaign "${campaign.name}"`)
  // Each level's negatives now: the campaign's own ('' key), and each ad group's.
  const negativesAt = new Map<string, Map<string, { criterionId: string; text: string; matchType: MatchType }>>()
  const at = (level: string) => negativesAt.get(level) ?? negativesAt.set(level, new Map()).get(level)!
  for (const n of live.campaignNegatives) at('').set(keywordKey(n.text, n.matchType), n)
  for (const k of live.keywords) if (k.negative) at(k.adGroupId).set(keywordKey(k.text, k.matchType), { criterionId: k.criterionId, text: k.text, matchType: k.matchType })
  const positives = live.keywords.filter((k) => !k.negative).sort((a, b) => byGoogleId(a.keywordId, b.keywordId))
  const positivesByText = new Map<string, LiveKeyword[]>()
  for (const k of positives) positivesByText.set(keywordKey(k.text, ''), [...(positivesByText.get(keywordKey(k.text, '')) ?? []), k])

  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const skipped: string[] = []
  const record: NegativeChangeRecord = { campaignId: campaign.campaignId, added: [], removed: [] }
  const levelOf = (n: NegativeKeyword): { refusal: string } | string => {
    if (!n.adGroupId) return ''
    if (!groupById.has(n.adGroupId)) return { refusal: `Ad group ${n.adGroupId} is not in campaign "${campaign.name}" (or it is removed). google-ads-live view campaign lists its ad groups.` }
    return n.adGroupId
  }
  const askedKey = (level: string, n: NegativeKeyword) => `${level}|${keywordKey(n.text, n.matchType)}`
  const removeKeys = new Set<string>()
  for (const n of remove) {
    const level = levelOf(n)
    if (typeof level !== 'string') return level
    removeKeys.add(askedKey(level, n))
  }

  const seen = new Set<string>()
  const blocks: string[] = []
  for (const n of add) {
    const level = levelOf(n)
    if (typeof level !== 'string') return level
    const text = n.text.trim().replace(/\s+/g, ' ')
    const problem = keywordTextProblem(text)
    if (problem) return { refusal: `The negative keyword "${n.text}" ${problem}.` }
    const key = askedKey(level, { ...n, text })
    if (removeKeys.has(key)) return { refusal: `${kw(text, n.matchType)} at ${where(level || null)} is both added and removed.` }
    if (seen.has(key)) continue
    seen.add(key)
    if (at(level).has(keywordKey(text, n.matchType))) { skipped.push(`${kw(text, n.matchType)} is already a negative keyword of ${where(level || null)}.`); continue }
    record.added.push({ adGroupId: level || null, text, matchType: n.matchType, criterionId: `${NEW}${operations.length}` })
    operations.push(level
      ? { adGroupCriterionOperation: { create: { adGroup: `${customer}/adGroups/${level}`, negative: true, keyword: { text, matchType: n.matchType } } } }
      : { campaignCriterionOperation: { create: { campaign: `${customer}/campaigns/${campaign.campaignId}`, negative: true, keyword: { text, matchType: n.matchType } } } })
    lines.push([`negative ${kw(text, n.matchType)} at ${where(level || null)}`, '(none)', 'added'])
    for (const p of positivesByText.get(keywordKey(text, '')) ?? []) {
      if (!level || p.adGroupId === level) blocks.push(`${kw(text, n.matchType)} blocks the keyword ${kw(p.text, p.matchType)} of ad group "${groupById.get(p.adGroupId)?.name ?? p.adGroupId}"`)
    }
  }
  if (blocks.length) warnings.push(`A negative keyword can stop a keyword of the campaign from showing ads: ${blocks.slice(0, 10).join('; ')}${blocks.length > 10 ? ` (+${blocks.length - 10} more)` : ''}.`)

  const removedSeen = new Set<string>()
  for (const n of remove) {
    const level = n.adGroupId ?? ''
    const found = at(level).get(keywordKey(n.text, n.matchType))
    if (!found) { skipped.push(`${kw(n.text.trim(), n.matchType)} is not a negative keyword of ${where(level || null)}.`); continue }
    if (removedSeen.has(askedKey(level, n))) continue
    removedSeen.add(askedKey(level, n))
    operations.push(level
      ? { adGroupCriterionOperation: { remove: `${customer}/adGroupCriteria/${level}~${found.criterionId}` } }
      : { campaignCriterionOperation: { remove: `${customer}/campaignCriteria/${campaign.campaignId}~${found.criterionId}` } })
    record.removed.push({ adGroupId: level || null, text: found.text, matchType: found.matchType })
    lines.push([`negative ${kw(found.text, found.matchType)} at ${where(level || null)}`, 'a negative keyword', '(removed)'])
  }
  // Owner's rule (2026-10-15): a removed negative lets more searches show the ads — it can spend more.
  const spends = record.removed.length ? [`Removes ${plural(record.removed.length, 'negative keyword')}: more searches can show the ads of campaign "${campaign.name}"${campaignPausedNote(campaign)}.`] : []

  if (operations.length === 0) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const { changes, more } = changeLines(lines)
  const parts: string[] = []
  if (record.added.length) parts.push(`add ${plural(record.added.length, 'negative keyword')}`)
  if (record.removed.length) parts.push(`remove ${plural(record.removed.length, 'negative keyword')}`)
  const levels = [...new Set([...add, ...remove].map((n) => n.adGroupId ?? ''))].sort()
  return {
    summary: `Google Ads negative keywords of "${campaign.name}": ${parts.join(', ')}.`,
    changes,
    totals: { operations: operations.length, negativesAdded: record.added.length, negativesRemoved: record.removed.length, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped,
    operations,
    stands: {
      campaign: { campaignId: campaign.campaignId, status: campaign.status, type: campaign.type },
      negatives: levels.map((level) => ({ level: level || 'campaign', keys: [...at(level).entries()].map(([key, n]) => `${key}#${n.criterionId}`).sort() })),
      // The keywords each touched place holds (the "blocks a keyword" warning stands on them).
      positives: levels.map((level) => ({ level: level || 'campaign', keys: positives.filter((k) => !level || k.adGroupId === level).map((k) => `${k.keywordId}#${keywordKey(k.text, k.matchType)}`) })),
    },
    before: { campaignId: campaign.campaignId, negatives: record.removed },
    after: record,
  }
}

/** The record of a run: each negative it added gets the criterion id Google gave it, by operation index. */
export function negativeRecordAfterRun(after: NegativeChangeRecord, responses: GoogleMutateResponse[]): NegativeChangeRecord {
  return {
    campaignId: after.campaignId,
    added: after.added.map((n) => {
      if (!n.criterionId?.startsWith(NEW)) return { ...n }
      const response = responses[Number(n.criterionId.slice(NEW.length))]
      const id = idOf((n.adGroupId ? response?.adGroupCriterionResult : response?.campaignCriterionResult)?.resourceName)
      return { ...n, criterionId: id?.split('~')[1] ?? n.criterionId }
    }),
    removed: after.removed.map((n) => ({ ...n })),
  }
}
