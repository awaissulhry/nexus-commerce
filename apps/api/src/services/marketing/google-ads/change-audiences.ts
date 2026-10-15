/**
 * Google Ads changes, programme 2 G2 (2026-10-15) — a Search or Standard Shopping campaign's audience segments, at the
 * campaign or at its ad groups: user lists (website visitors, customer lists), user interests (affinity, in-market),
 * custom audiences, combined audiences and life events — targeted, excluded, their bid adjustments, and whether they
 * narrow who sees the ads (TARGETING) or only adjust bids (OBSERVATION).
 *
 * Google's rules, checked with curl in the v25 reference 2026-10-15:
 * - Criteria guide (docs/targeting/criteria): user list, user interest and life event can be targeted or excluded at the
 *   campaign and the ad group; custom audience and combined audience are positive only. Audience segments serve on
 *   Search and Standard Shopping (docs/remarketing/audience-segments/getting-started). Ids: UserListInfo.user_list
 *   (customers/{c}/userLists/{id}), UserInterestInfo.user_interest_category (customers/{c}/userInterests/{id}),
 *   CustomAudienceInfo.custom_audience (customers/{c}/customAudiences/{id}), CombinedAudienceInfo.combined_audience
 *   (customers/{c}/combinedAudiences/{id}), LifeEventInfo.life_event_id (the id itself).
 * - bid_modifier 0.1–10 on a positive criterion (CampaignCriterion / AdGroupCriterion); never on a negative one
 *   (CriterionError.CANNOT_BID_MODIFY_NEGATIVE_CRITERION). negative is immutable: switching is remove + create.
 * - TargetingSetting / TargetRestriction (rpc/v25; docs/targeting/targeting-settings): AUDIENCE bid_only true =
 *   OBSERVATION, false = TARGETING; a dimension missing from target_restrictions is TARGETING (the API's default). The
 *   setting lives on the campaign OR on its ad groups, never both: an ad group's cannot be set while the campaign has
 *   one, and the campaign's cannot be set while an ad group has one. target_restrictions is written whole (update_mask
 *   targeting_setting.target_restrictions; missing entries are removed; an empty list removes the setting).
 *
 * Money: what lets the ads reach more people or bid more is in `spendsMoney` — an exclusion removed, TARGETING →
 * OBSERVATION while audiences narrow, more audiences in TARGETING, the last audience of a TARGETING level removed, any
 * bid adjustment raised. Narrowing (an exclusion, OBSERVATION → TARGETING, the first audience in TARGETING) is a warning.
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import type { LiveCampaignDetail } from './live.js'
import {
  adjustmentWords, audienceCriterion, SMART_BIDDING,
  type AdGroupTargetingCriterion, type AudienceKind, type AudienceRestriction, type TargetingAdGroup, type TargetingCriterion,
} from './live-targeting.js'
import type { GoogleMutateOperation } from './write-client.js'

/** OBSERVATION: audiences only adjust bids. TARGETING: they narrow who sees the ads. NONE: no setting at this level. */
export type AudienceMode = 'OBSERVATION' | 'TARGETING' | 'NONE'
/** An audience segment at the campaign (no adGroupId) or at one of its ad groups. */
export interface AudienceRef { kind: AudienceKind; id: string; adGroupId?: string }

export interface AudienceRequest {
  add?: Array<AudienceRef & { exclude?: boolean; bidModifier?: number }>
  remove?: Array<AudienceRef & { exclude?: boolean }>
  /** The bid adjustment of a targeted (or observed) audience already there: 0.1–10, or null = none. */
  bids?: Array<AudienceRef & { bidModifier: number | null }>
  modes?: Array<{ adGroupId?: string; mode: AudienceMode }>
}

/** What an audience change did: `undo` puts it back, `set` is what it wrote (so undo can tell whether it still stands). */
export interface AudienceRecord { campaignId: string; undo: AudienceRequest; set: AudienceRequest }

export interface AudienceLive {
  campaign: LiveCampaignDetail['campaign'] | null
  criteria: TargetingCriterion[]
  adGroups: TargetingAdGroup[]
  adGroupCriteria: AdGroupTargetingCriterion[]
}

/** One audience criterion as Nexus compares it ('' = the campaign level). */
interface Segment { level: string; kind: AudienceKind; id: string; negative: boolean; bidModifier: number | null; criterionId: string; name: string | null }

const KIND_WORDS: Record<AudienceKind, string> = {
  USER_LIST: 'your data segment', USER_INTEREST: 'interest segment', CUSTOM_AUDIENCE: 'custom segment', COMBINED_AUDIENCE: 'combined segment', LIFE_EVENT: 'life event',
}
const POSITIVE_ONLY = new Set<AudienceKind>(['CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE'])
const keyOf = (level: string, kind: string, id: string) => `${level}|${kind}|${id}`

export function segmentsOf(live: Pick<AudienceLive, 'criteria' | 'adGroupCriteria'>): Segment[] {
  const out: Segment[] = []
  for (const k of live.criteria) if (k.segment) out.push({ level: '', ...k.segment, negative: k.negative, bidModifier: k.bidModifier, criterionId: k.criterionId, name: k.name })
  for (const k of live.adGroupCriteria) if (k.segment) out.push({ level: k.adGroupId, ...k.segment, negative: k.negative, bidModifier: k.bidModifier, criterionId: k.criterionId, name: k.name })
  return out
}

export const audienceModeOf = (r: AudienceRestriction[]): AudienceMode => {
  const e = r.find((t) => t.dimension === 'AUDIENCE')
  return !e ? 'NONE' : e.observationOnly ? 'OBSERVATION' : 'TARGETING'
}
const withMode = (r: AudienceRestriction[], mode: AudienceMode): AudienceRestriction[] =>
  [...r.filter((t) => t.dimension !== 'AUDIENCE'), ...(mode === 'NONE' ? [] : [{ dimension: 'AUDIENCE', observationOnly: mode === 'OBSERVATION' }])]
const sameRestrictions = (a: AudienceRestriction[], b: AudienceRestriction[]) =>
  JSON.stringify(a.map((t) => `${t.dimension}:${t.observationOnly}`).sort()) === JSON.stringify(b.map((t) => `${t.dimension}:${t.observationOnly}`).sort())
const restrictionJson = (r: AudienceRestriction[]) => r.map((t) => ({ targetingDimension: t.dimension, bidOnly: t.observationOnly }))
const MODE_WORDS: Record<AudienceMode, string> = { OBSERVATION: 'observation (bids only)', TARGETING: 'targeting (narrows who sees the ads)', NONE: 'no setting (Google: targeting)' }

/** The mode that applies to a level: the campaign's setting when it has one (it governs every ad group), else the ad group's. */
function governing(level: string, campaign: AudienceRestriction[]): string {
  return level === '' || campaign.length ? '' : level
}
function effectiveMode(level: string, campaign: AudienceRestriction[], adGroups: Map<string, AudienceRestriction[]>): 'OBSERVATION' | 'TARGETING' {
  const g = governing(level, campaign)
  return audienceModeOf(g === '' ? campaign : adGroups.get(g) ?? []) === 'OBSERVATION' ? 'OBSERVATION' : 'TARGETING'
}

export function audienceDraft(customer: string, campaignId: string, ask: AudienceRequest, live: AudienceLive): GoogleChangeDraft | { refusal: string } {
  const c = live.campaign
  if (!c) return { refusal: `Campaign ${campaignId} is not in this account (or it is removed).` }
  if (c.type !== 'SEARCH' && c.type !== 'SHOPPING') return { refusal: `"${c.name}" is a ${c.type ?? 'campaign'} campaign: Nexus changes the audiences of Search and Standard Shopping campaigns.` }
  const groups = new Map(live.adGroups.map((a) => [a.adGroupId, a]))
  const res = `${customer}/campaigns/${c.campaignId}`
  const note = c.status === 'ENABLED' ? '' : ' (the campaign is paused: nothing spends until it is enabled)'
  const where = (level: string) => (level === '' ? `"${c.name}"` : `ad group "${groups.get(level)?.name ?? level}"`)
  const whereNote = (level: string) => (level === '' || groups.get(level)?.status === 'ENABLED' ? note : ' (the ad group is paused: nothing spends until it is enabled)')
  const label = (s: { kind: AudienceKind; id: string; name?: string | null }) => s.name ? `"${s.name}"` : `${KIND_WORDS[s.kind]} ${s.id}`

  // Every ad group named is one of this campaign's.
  const named = [...(ask.add ?? []), ...(ask.remove ?? []), ...(ask.bids ?? []), ...(ask.modes ?? [])].map((x) => x.adGroupId).filter((x): x is string => !!x)
  for (const id of named) if (!groups.has(id)) return { refusal: `Ad group ${id} is not in "${c.name}" (or it is removed).` }

  const ops: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  const undo: Required<AudienceRequest> = { add: [], remove: [], bids: [], modes: [] }
  const set: Required<AudienceRequest> = { add: [], remove: [], bids: [], modes: [] }
  const ref = (level: string, kind: AudienceKind, id: string): AudienceRef => ({ kind, id, ...(level ? { adGroupId: level } : {}) })

  const before = segmentsOf(live)
  const removed = new Set<string>() // criterion keys removed by this request (level|kind|id|neg)
  const added: Segment[] = []
  const bidTo = new Map<string, number>() // segment key → its new bid adjustment
  const segKey = (s: { level: string; kind: string; id: string; negative: boolean }) => `${keyOf(s.level, s.kind, s.id)}|${s.negative ? '-' : '+'}`
  const findNow = (level: string, kind: string, id: string, negative: boolean) =>
    before.find((s) => s.level === level && s.kind === kind && s.id === id && s.negative === negative && !removed.has(segKey(s)))

  // ── removes (first: an audience can be switched between targeted and excluded in one request) ──
  const seen = new Set<string>()
  for (const r of ask.remove ?? []) {
    const level = r.adGroupId ?? ''
    const k = `${keyOf(level, r.kind, r.id)}|${r.exclude ? '-' : '+'}`
    if (seen.has(`remove:${k}`)) return { refusal: `${KIND_WORDS[r.kind]} ${r.id} is named twice in remove.` }
    seen.add(`remove:${k}`)
    const found = findNow(level, r.kind, r.id, !!r.exclude)
    if (!found) { skipped.push(`${KIND_WORDS[r.kind]} ${r.id} is not ${r.exclude ? 'excluded' : 'on'} ${where(level)}.`); continue }
    ops.push(level === ''
      ? { campaignCriterionOperation: { remove: `${customer}/campaignCriteria/${c.campaignId}~${found.criterionId}` } }
      : { adGroupCriterionOperation: { remove: `${customer}/adGroupCriteria/${level}~${found.criterionId}` } })
    removed.add(segKey(found))
    undo.add.push({ ...ref(level, r.kind, r.id), ...(found.negative ? { exclude: true } : {}), ...(!found.negative && found.bidModifier !== null && found.bidModifier !== 1 ? { bidModifier: found.bidModifier } : {}) })
    set.remove.push({ ...ref(level, r.kind, r.id), ...(found.negative ? { exclude: true } : {}) })
  }

  // ── adds ──
  for (const a of ask.add ?? []) {
    const level = a.adGroupId ?? ''
    const k = keyOf(level, a.kind, a.id)
    if (seen.has(`add:${k}`)) return { refusal: `${KIND_WORDS[a.kind]} ${a.id} is named twice in add.` }
    seen.add(`add:${k}`)
    if (a.exclude && POSITIVE_ONLY.has(a.kind)) return { refusal: `Google cannot exclude a ${KIND_WORDS[a.kind]} (it is targeted or observed only): ${a.id}.` }
    if (a.exclude && a.bidModifier !== undefined) return { refusal: `${KIND_WORDS[a.kind]} ${a.id}: an excluded audience has no bid adjustment.` }
    if (a.bidModifier !== undefined && !(a.bidModifier >= 0.1 && a.bidModifier <= 10)) return { refusal: `${KIND_WORDS[a.kind]} ${a.id}: a bid adjustment is between 0.1 and 10.` }
    if (findNow(level, a.kind, a.id, !!a.exclude)) { skipped.push(`${KIND_WORDS[a.kind]} ${a.id} is already ${a.exclude ? 'excluded' : 'on'} ${where(level)}.`); continue }
    if (findNow(level, a.kind, a.id, !a.exclude)) return { refusal: `${KIND_WORDS[a.kind]} ${a.id} is already ${a.exclude ? 'targeted or observed' : 'excluded'} ${where(level)}: remove it in the same request (remove).` }
    const body = {
      ...(a.exclude ? { negative: true } : {}),
      ...(a.bidModifier !== undefined && a.bidModifier !== 1 ? { bidModifier: a.bidModifier } : {}),
      ...audienceCriterion(customer, a.kind, a.id),
    }
    ops.push(level === ''
      ? { campaignCriterionOperation: { create: { campaign: res, ...body } } }
      : { adGroupCriterionOperation: { create: { adGroup: `${customer}/adGroups/${level}`, ...body } } })
    added.push({ level, kind: a.kind, id: a.id, negative: !!a.exclude, bidModifier: a.bidModifier ?? null, criterionId: '', name: null })
    undo.remove.push({ ...ref(level, a.kind, a.id), ...(a.exclude ? { exclude: true } : {}) })
    set.add.push({ ...ref(level, a.kind, a.id), ...(a.exclude ? { exclude: true } : {}), ...(a.bidModifier !== undefined && a.bidModifier !== 1 ? { bidModifier: a.bidModifier } : {}) })
  }

  // ── bid adjustments of audiences already there ──
  for (const b of ask.bids ?? []) {
    const level = b.adGroupId ?? ''
    const k = keyOf(level, b.kind, b.id)
    if (seen.has(`bid:${k}`)) return { refusal: `${KIND_WORDS[b.kind]} ${b.id} is named twice in bids.` }
    seen.add(`bid:${k}`)
    if (b.bidModifier !== null && !(b.bidModifier >= 0.1 && b.bidModifier <= 10)) return { refusal: `${KIND_WORDS[b.kind]} ${b.id}: a bid adjustment is between 0.1 and 10 (or null: none).` }
    if (added.some((s) => keyOf(s.level, s.kind, s.id) === k)) return { refusal: `${KIND_WORDS[b.kind]} ${b.id} is added in this request: give its bid adjustment there (add bidModifier).` }
    const found = findNow(level, b.kind, b.id, false)
    if (!found) {
      if (findNow(level, b.kind, b.id, true)) return { refusal: `${KIND_WORDS[b.kind]} ${b.id} is excluded ${where(level)}: an excluded audience has no bid adjustment.` }
      skipped.push(`${KIND_WORDS[b.kind]} ${b.id} is not on ${where(level)}.`)
      continue
    }
    const from = found.bidModifier ?? 1
    const to = b.bidModifier ?? 1
    if (from === to) { skipped.push(`${label(found)} ${where(level)} already has this bid adjustment (${adjustmentWords(to)}).`); continue }
    ops.push(level === ''
      ? { campaignCriterionOperation: { update: { resourceName: `${customer}/campaignCriteria/${c.campaignId}~${found.criterionId}`, bidModifier: to }, updateMask: 'bid_modifier' } }
      : { adGroupCriterionOperation: { update: { resourceName: `${customer}/adGroupCriteria/${level}~${found.criterionId}`, bidModifier: to }, updateMask: 'bid_modifier' } })
    bidTo.set(k, to)
    lines.push([`bid adjustment ${label(found)}, ${where(level)}`, adjustmentWords(from), adjustmentWords(to)])
    undo.bids.push({ ...ref(level, b.kind, b.id), bidModifier: found.bidModifier === 1 ? null : found.bidModifier })
    set.bids.push({ ...ref(level, b.kind, b.id), bidModifier: to === 1 ? null : to })
  }

  // ── the audience setting (observation / targeting) ──
  const campaignBefore = c.audienceMode
  const groupsBefore = new Map(live.adGroups.map((a) => [a.adGroupId, a.audienceMode]))
  let campaignAfter = campaignBefore
  const groupsAfter = new Map(groupsBefore)
  const asked = new Set<string>()
  for (const m of ask.modes ?? []) {
    const level = m.adGroupId ?? ''
    if (asked.has(level)) return { refusal: `${where(level)} is named twice in modes.` }
    asked.add(level)
    if (level === '') campaignAfter = withMode(campaignAfter, m.mode)
    else groupsAfter.set(level, withMode(groupsAfter.get(level) ?? [], m.mode))
  }
  const positivesBefore = (level: string) => before.filter((s) => s.level === level && !s.negative)
  // New targeted / observed audiences go in OBSERVATION unless a mode is named: where the level has no audience setting
  // and nothing narrows there yet, Nexus sets OBSERVATION in the same request (it changes nobody's reach). Anywhere the
  // audiences narrow (TARGETING, said or Google's default), adding or turning them changes who sees the ads: the
  // person names the mode.
  for (const level of new Set(added.filter((s) => !s.negative).map((s) => s.level))) {
    if (effectiveMode(level, campaignAfter, groupsAfter) === 'OBSERVATION') continue
    const g = governing(level, campaignAfter)
    if (asked.has(g)) continue
    const gRestrictions = g === '' ? campaignAfter : groupsAfter.get(g) ?? []
    const narrowing = g === '' ? before.some((s) => !s.negative) : positivesBefore(g).length > 0
    if (audienceModeOf(gRestrictions) === 'NONE' && !narrowing) {
      if (g === '') campaignAfter = withMode(campaignAfter, 'OBSERVATION')
      else groupsAfter.set(g, withMode(gRestrictions, 'OBSERVATION'))
      continue
    }
    return {
      refusal: `${where(g)} uses its audiences as TARGETING (${narrowing ? 'they narrow who sees the ads' : 'the first audience would narrow who sees the ads to it'}). `
        + `Name the mode for it in modes: TARGETING (audiences narrow who sees the ads) or OBSERVATION (they only adjust bids).`,
    }
  }
  // Google keeps the setting on the campaign or on its ad groups, never both.
  if (campaignAfter.length) {
    const own = live.adGroups.filter((a) => (groupsAfter.get(a.adGroupId) ?? []).length)
    if (own.length) {
      return {
        refusal: `Google keeps the audience setting on the campaign or on its ad groups, not both: ${own.slice(0, 5).map((a) => `"${a.name}"`).join(', ')}${own.length > 5 ? ` and ${own.length - 5} more` : ''} `
          + `${own.length === 1 ? 'has its' : 'have their'} own. Set ${own.length === 1 ? 'its' : 'their'} mode to NONE in the same request, or name the mode per ad group.`,
      }
    }
  }
  // Ad groups whose setting goes away first, then the campaign, then ad groups that get one (Google's order rule).
  const modeOps: { clears: GoogleMutateOperation[]; campaign: GoogleMutateOperation[]; sets: GoogleMutateOperation[] } = { clears: [], campaign: [], sets: [] }
  const modeChanged = (level: string, from: AudienceRestriction[], to: AudienceRestriction[]) => {
    lines.push([`audience setting, ${where(level)}`, MODE_WORDS[audienceModeOf(from)], MODE_WORDS[audienceModeOf(to)]])
    undo.modes.push({ ...(level ? { adGroupId: level } : {}), mode: audienceModeOf(from) })
    set.modes.push({ ...(level ? { adGroupId: level } : {}), mode: audienceModeOf(to) })
  }
  if (!sameRestrictions(campaignBefore, campaignAfter)) {
    modeOps.campaign.push({ campaignOperation: { update: { resourceName: res, targetingSetting: { targetRestrictions: restrictionJson(campaignAfter) } }, updateMask: 'targeting_setting.target_restrictions' } })
    modeChanged('', campaignBefore, campaignAfter)
  }
  for (const a of live.adGroups) {
    const from = groupsBefore.get(a.adGroupId) ?? []
    const to = groupsAfter.get(a.adGroupId) ?? []
    if (sameRestrictions(from, to)) continue
    ;(to.length ? modeOps.sets : modeOps.clears).push({ adGroupOperation: { update: { resourceName: `${customer}/adGroups/${a.adGroupId}`, targetingSetting: { targetRestrictions: restrictionJson(to) } }, updateMask: 'targeting_setting.target_restrictions' } })
    modeChanged(a.adGroupId, from, to)
  }
  for (const m of ask.modes ?? []) {
    const level = m.adGroupId ?? ''
    if (!set.modes.some((x) => (x.adGroupId ?? '') === level)) skipped.push(`${where(level)} already has this audience setting (${MODE_WORDS[m.mode]}).`)
  }
  ops.unshift(...modeOps.clears, ...modeOps.campaign)
  ops.push(...modeOps.sets)

  // ── who sees the ads, and what it bids: per level ──
  const after = [
    ...before.filter((s) => !removed.has(segKey(s))).map((s) => ({ ...s, bidModifier: bidTo.has(keyOf(s.level, s.kind, s.id)) ? bidTo.get(keyOf(s.level, s.kind, s.id))! : s.bidModifier })),
    ...added,
  ]
  const adjusted = added.some((s) => !s.negative && s.bidModifier !== null && s.bidModifier !== 1) || bidTo.size > 0
  for (const level of ['', ...live.adGroups.map((a) => a.adGroupId)]) {
    const pos0 = new Map(before.filter((s) => s.level === level && !s.negative).map((s) => [keyOf(level, s.kind, s.id), s.bidModifier ?? 1]))
    const pos1 = new Map(after.filter((s) => s.level === level && !s.negative).map((s) => [keyOf(level, s.kind, s.id), s.bidModifier ?? 1]))
    const neg0 = before.filter((s) => s.level === level && s.negative).length
    const neg1 = after.filter((s) => s.level === level && s.negative).length
    const negGone = before.filter((s) => s.level === level && s.negative && removed.has(segKey(s))).length
    const mode0 = effectiveMode(level, campaignBefore, groupsBefore)
    const mode1 = effectiveMode(level, campaignAfter, groupsAfter)
    const w = where(level)
    const wn = whereNote(level)
    const touched = negGone || neg0 !== neg1 || pos0.size !== pos1.size || [...pos1.keys()].some((k) => !pos0.has(k))
    if (touched) lines.push([`audiences, ${w}`, `${pos0.size} ${mode0 === 'OBSERVATION' ? 'observed' : 'targeted'}, ${neg0} excluded`, `${pos1.size} ${mode1 === 'OBSERVATION' ? 'observed' : 'targeted'}, ${neg1} excluded`])
    if (negGone) spends.push(`${w}: people in ${plural(negGone, 'excluded audience')} can see the ads again${wn}.`)
    if (mode1 === 'TARGETING') {
      if (!pos1.size) {
        if (mode0 === 'TARGETING' && pos0.size) spends.push(`${w}: no audience narrows who sees the ads any more — they can show to everyone${wn}.`)
      } else if (mode0 === 'OBSERVATION' || !pos0.size) {
        warnings.push(`${w}: from now the ads show ONLY to people in ${plural(pos1.size, 'audience')} (TARGETING).`)
      } else {
        const more = [...pos1.keys()].filter((k) => !pos0.has(k)).length
        if (more) spends.push(`${w}: the ads reach people in ${plural(more, 'more audience')} (TARGETING)${wn}.`)
      }
    } else if (mode0 === 'TARGETING' && pos0.size) {
      spends.push(`${w}: its audiences stop narrowing who sees the ads (TARGETING → OBSERVATION) — they can show to everyone${wn}.`)
    }
    // A higher bid adjustment, a new audience bid up, or (in observation) a lowering taken away bids more.
    let raised = 0
    for (const [k, m1] of pos1) if (m1 > (pos0.get(k) ?? 1)) raised += 1
    if (mode1 === 'OBSERVATION') for (const [k, m0] of pos0) if (!pos1.has(k) && m0 < 1) raised += 1
    if (raised) spends.push(`${w}: bids more for people in ${plural(raised, 'audience')}${wn}.`)
  }
  if (adjusted && c.bidding && SMART_BIDDING.has(c.bidding)) {
    warnings.push(`"${c.name}" bids with ${c.bidding}: Google's Smart Bidding does not use audience bid adjustments (the audiences still narrow or are observed as set).`)
  }

  if (!ops.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const { changes, more } = changeLines(lines)
  const record: AudienceRecord = { campaignId: c.campaignId, undo: compact(undo), set: compact(set) }
  return {
    summary: `Google Ads campaign "${c.name}": change its audiences (${[
      added.length ? `${added.length} added` : '', set.remove.length ? `${set.remove.length} removed` : '',
      set.bids.length ? `${plural(set.bids.length, 'bid adjustment')}` : '', set.modes.length ? `${plural(set.modes.length, 'audience setting')}` : '',
    ].filter(Boolean).join(', ')}).`,
    changes,
    totals: { operations: ops.length, audiencesAdded: added.length, audiencesRemoved: set.remove.length, bidAdjustments: set.bids.length, audienceSettings: set.modes.length, linesNotShown: more },
    warnings,
    spendsMoney: spends,
    skipped,
    operations: ops,
    stands: {
      campaignId: c.campaignId,
      status: c.status,
      bidding: c.bidding,
      audienceMode: restrictionJson(campaignBefore),
      adGroups: live.adGroups.map((a) => `${a.adGroupId}:${a.status}:${JSON.stringify(restrictionJson(a.audienceMode))}`).sort(),
      audiences: before.map((s) => `${segKey(s)}x${s.bidModifier ?? 1}`).sort(),
    },
    before: { campaignId: c.campaignId, undo: record.undo },
    after: record,
  }
}

function compact(r: Required<AudienceRequest>): AudienceRequest {
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v.length)) as AudienceRequest
}

/** Whether what an audience change wrote still stands in the live state (undo refuses to overwrite a later change). */
export function audienceRecordHolds(record: AudienceRecord, live: AudienceLive): boolean {
  const now = segmentsOf(live)
  const has = (r: AudienceRef, negative: boolean) => now.find((s) => s.level === (r.adGroupId ?? '') && s.kind === r.kind && s.id === r.id && s.negative === negative)
  const set = record.set ?? {}
  const campaign = live.campaign?.audienceMode ?? []
  const groups = new Map(live.adGroups.map((a) => [a.adGroupId, a.audienceMode]))
  return (set.add ?? []).every((a) => { const s = has(a, !!a.exclude); return !!s && (a.exclude || (s.bidModifier ?? 1) === (a.bidModifier ?? 1)) })
    && (set.remove ?? []).every((r) => !has(r, !!r.exclude))
    && (set.bids ?? []).every((b) => { const s = has(b, false); return !!s && (s.bidModifier ?? 1) === (b.bidModifier ?? 1) })
    && (set.modes ?? []).every((m) => audienceModeOf(m.adGroupId ? groups.get(m.adGroupId) ?? [] : campaign) === m.mode)
}
