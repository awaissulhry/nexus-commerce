/**
 * Google Ads changes, programme 2 G2 (2026-10-15) — a campaign's demographics: age, gender, parental status and
 * household income, excluded or shown, with bid adjustments per ad group.
 *
 * Google's rules, checked with curl 2026-10-15:
 * - rpc/v25 AgeRangeInfo / GenderInfo / ParentalStatusInfo / IncomeRangeInfo (`type`) and their enums AgeRangeType,
 *   GenderType, ParentalStatusType, IncomeRangeType; AdGroupCriterion / CampaignCriterion age_range, gender,
 *   parental_status, income_range; bid_modifier 0.1–10, never on a negative criterion (CANNOT_BID_MODIFY_NEGATIVE_CRITERION).
 * - The codes page (docs data/codes-formats): age ranges, genders and parental statuses are "for use as ad group-level or
 *   negative campaign-level" criteria — so a bid adjustment lives on an ad group; the campaign only excludes.
 * - CriterionError: CANNOT_EXCLUDE_ALL_TARGETS (every group of a dimension excluded) and CANNOT_TARGET_ONLY_UNDETERMINED
 *   ("unknown" left alone) — refused here before Google is asked.
 * - Google Ads Help 7365594: demographics use the TARGETING setting only, and every group is targeted until something
 *   changes. A positive criterion of a dimension restricts that dimension to the positive groups (TargetRestriction's
 *   default), so a bid adjustment on one group is sent as positive criteria for EVERY group of that dimension the ad
 *   group does not exclude — reach stays the same; only the bid moves. Google Ads Help 2580383 lists age, gender and
 *   household income for Search campaigns; whether a campaign type takes a dimension, Google's check says.
 *
 * Money: a group shown again (an exclusion removed, a group added to a narrowed dimension) and a bid adjustment raised
 * are in `spendsMoney`. Undo restores the exact criteria the change replaced (`restore`).
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import {
  adjustmentWords, DEMOGRAPHIC_DIMENSIONS, DEMOGRAPHIC_FIELD, DEMOGRAPHIC_VALUES, smartBiddingWords, type DemographicDimension,
} from './live-targeting.js'
import type { AudienceLive } from './change-audiences.js'
import type { GoogleMutateOperation } from './write-client.js'

export interface DemographicChange {
  dimension: DemographicDimension
  value: string
  /** The ad group; none = the campaign (exclusions only). */
  adGroupId?: string
  /** true = excluded; false or absent = shown. */
  exclude?: boolean
  /** Shown, with this bid adjustment (0.1–10; null = none). Ad groups only. */
  bidModifier?: number | null
}

/** One criterion exactly as it should be (what undo puts back): none, an exclusion, or a targeted group with its adjustment. */
export interface DemographicRestore {
  dimension: DemographicDimension
  value: string
  adGroupId?: string
  criterion: 'NONE' | 'EXCLUDED' | 'TARGETED'
  bidModifier?: number | null
}

export interface DemographicRequest { changes?: DemographicChange[]; restore?: DemographicRestore[] }
export interface DemographicRecord { campaignId: string; restore: DemographicRestore[]; set: DemographicRestore[] }

interface State { kind: 'POS' | 'NEG'; bidModifier: number | null; criterionId?: string }

const DIMENSION_WORDS: Record<DemographicDimension, string> = { AGE_RANGE: 'age', GENDER: 'gender', PARENTAL_STATUS: 'parental status', INCOME_RANGE: 'household income' }
const VALUE_WORDS: Record<string, string> = {
  AGE_RANGE_18_24: '18–24', AGE_RANGE_25_34: '25–34', AGE_RANGE_35_44: '35–44', AGE_RANGE_45_54: '45–54', AGE_RANGE_55_64: '55–64', AGE_RANGE_65_UP: '65+', AGE_RANGE_UNDETERMINED: 'age unknown',
  FEMALE: 'female', MALE: 'male', PARENT: 'parents', NOT_A_PARENT: 'not parents',
  INCOME_RANGE_90_UP: 'income top 10 %', INCOME_RANGE_80_90: 'income 11–20 %', INCOME_RANGE_70_80: 'income 21–30 %', INCOME_RANGE_60_70: 'income 31–40 %',
  INCOME_RANGE_50_60: 'income 41–50 %', INCOME_RANGE_0_50: 'income lower 50 %', INCOME_RANGE_UNDETERMINED: 'income unknown',
}
const valueWords = (dimension: DemographicDimension, value: string) =>
  value === 'UNDETERMINED' ? `${DIMENSION_WORDS[dimension]} unknown` : VALUE_WORDS[value] ?? value
const keyOf = (level: string, dimension: string, value: string) => `${level}|${dimension}|${value}`
const values = (dimension: DemographicDimension): readonly string[] => DEMOGRAPHIC_VALUES[dimension]
const isUndetermined = (value: string) => value.endsWith('UNDETERMINED')
/** ×1 is no adjustment: kept as null. */
const noAdjustment = (factor: number | null | undefined): number | null => (factor === undefined || factor === null || factor === 1 ? null : factor)

/** The demographic criteria now, by level ('' = campaign) | dimension | value. */
export function demographicState(live: Pick<AudienceLive, 'criteria' | 'adGroupCriteria'>): Map<string, State> {
  const out = new Map<string, State>()
  for (const k of live.criteria) {
    if (k.demographic?.value) out.set(keyOf('', k.demographic.dimension, k.demographic.value), { kind: k.negative ? 'NEG' : 'POS', bidModifier: k.bidModifier, criterionId: k.criterionId })
  }
  for (const k of live.adGroupCriteria) {
    if (k.demographic?.value) out.set(keyOf(k.adGroupId, k.demographic.dimension, k.demographic.value), { kind: k.negative ? 'NEG' : 'POS', bidModifier: k.bidModifier, criterionId: k.criterionId })
  }
  return out
}

/** Who sees the ads of a level in one dimension: the positive groups (or all, when none), less what it or the campaign excludes. */
function shown(state: Map<string, State>, level: string, dimension: DemographicDimension): string[] {
  const all = values(dimension)
  const excluded = (v: string) => state.get(keyOf('', dimension, v))?.kind === 'NEG' || (level !== '' && state.get(keyOf(level, dimension, v))?.kind === 'NEG')
  const positives = level === '' ? [] : all.filter((v) => state.get(keyOf(level, dimension, v))?.kind === 'POS')
  return (positives.length ? positives : [...all]).filter((v) => !excluded(v))
}
const factorAt = (state: Map<string, State>, level: string, dimension: string, value: string) => {
  const s = state.get(keyOf(level, dimension, value))
  return s?.kind === 'POS' ? s.bidModifier ?? 1 : 1
}
const restoreOf = (dimension: DemographicDimension, value: string, level: string, s: State | undefined): DemographicRestore => ({
  dimension, value, ...(level ? { adGroupId: level } : {}),
  criterion: !s ? 'NONE' : s.kind === 'NEG' ? 'EXCLUDED' : 'TARGETED',
  ...(s?.kind === 'POS' && s.bidModifier !== null && s.bidModifier !== 1 ? { bidModifier: s.bidModifier } : {}),
})

export function demographicsDraft(customer: string, campaignId: string, ask: DemographicRequest, live: AudienceLive): GoogleChangeDraft | { refusal: string } {
  const c = live.campaign
  if (!c) return { refusal: `Campaign ${campaignId} is not in this account (or it is removed).` }
  if (c.type !== 'SEARCH' && c.type !== 'SHOPPING') return { refusal: `"${c.name}" is a ${c.type ?? 'campaign'} campaign: Nexus changes the demographics of Search and Standard Shopping campaigns.` }
  const groups = new Map(live.adGroups.map((a) => [a.adGroupId, a]))
  const note = c.status === 'ENABLED' ? '' : ' (the campaign is paused: nothing spends until it is enabled)'
  const where = (level: string) => (level === '' ? `"${c.name}"` : `ad group "${groups.get(level)?.name ?? level}"`)
  const whereNote = (level: string) => (level === '' || groups.get(level)?.status === 'ENABLED' ? note : ' (the ad group is paused: nothing spends until it is enabled)')
  for (const x of [...(ask.changes ?? []), ...(ask.restore ?? [])]) {
    if (!(values(x.dimension) as readonly string[]).includes(x.value)) return { refusal: `${x.value} is not a ${DIMENSION_WORDS[x.dimension]} group (Google's are ${values(x.dimension).join(', ')}).` }
    if (x.adGroupId && !groups.has(x.adGroupId)) return { refusal: `Ad group ${x.adGroupId} is not in "${c.name}" (or it is removed).` }
  }

  const before = demographicState(live)
  const state = new Map(before)
  const touched = new Set<string>()
  const skipped: string[] = []
  /** Said in the warnings: a group shown at an ad group while the campaign still excludes it. */
  const notes: string[] = []
  const seen = new Set<string>()
  const put = (k: string, s: State | null) => { if (s) state.set(k, s); else state.delete(k); touched.add(k) }

  for (const ch of ask.changes ?? []) {
    const level = ch.adGroupId ?? ''
    const k = keyOf(level, ch.dimension, ch.value)
    if (seen.has(k)) return { refusal: `${valueWords(ch.dimension, ch.value)} at ${where(level)} is named twice.` }
    seen.add(k)
    const cur = state.get(k)
    const what = `${valueWords(ch.dimension, ch.value)} at ${where(level)}`
    if (ch.bidModifier !== undefined && ch.bidModifier !== null && !(ch.bidModifier >= 0.1 && ch.bidModifier <= 10)) return { refusal: `${what}: a bid adjustment is between 0.1 and 10 (or null: none).` }
    if (ch.exclude && ch.bidModifier !== undefined && ch.bidModifier !== null) return { refusal: `${what}: an excluded group has no bid adjustment.` }
    if (level === '') {
      if (ch.bidModifier !== undefined) return { refusal: `${what}: Google takes demographic bid adjustments per ad group; a campaign can only exclude a group.` }
      if (ch.exclude) { if (cur?.kind === 'NEG') skipped.push(`${what} is already excluded.`); else put(k, { kind: 'NEG', bidModifier: null }) }
      else if (cur?.kind === 'NEG') put(k, null)
      else skipped.push(`${what} is not excluded.`)
      continue
    }
    if (ch.exclude) {
      if (cur?.kind === 'NEG') skipped.push(`${what} is already excluded.`)
      else put(k, { kind: 'NEG', bidModifier: null })
      continue
    }
    // Shown (with or without a bid adjustment). A group the campaign excludes stays hidden at every ad group.
    const campaignHides = state.get(keyOf('', ch.dimension, ch.value))?.kind === 'NEG'
    const hidden = `${what}: the campaign excludes it, so it stays hidden there until the campaign shows it again (this tool without adGroupId).`
    const wasExcluded = cur?.kind === 'NEG'
    if (wasExcluded) put(k, null)
    const positives = values(ch.dimension).some((v) => state.get(keyOf(level, ch.dimension, v))?.kind === 'POS')
    const m = ch.bidModifier === undefined ? undefined : noAdjustment(ch.bidModifier)
    if (positives) {
      const now = state.get(k)
      if (now?.kind === 'POS' && (m === undefined || noAdjustment(now.bidModifier) === m)) {
        if (!wasExcluded) skipped.push(campaignHides ? hidden : `${what} is already shown${m === undefined ? '' : ` with this adjustment (${adjustmentWords(m)})`}.`)
        else if (campaignHides) notes.push(hidden)
      } else {
        put(k, { kind: 'POS', bidModifier: m !== undefined ? m : now?.kind === 'POS' ? now.bidModifier : null })
        if (campaignHides) notes.push(hidden)
      }
    } else if (m !== undefined && m !== null) {
      // Every group of the dimension (unknown too) gets a positive criterion at the ad group, this one with its
      // adjustment, so the dimension is not narrowed to this group; only the ad group's own exclusions stay out. A
      // group the campaign excludes gets one too: the campaign's exclusion still applies on top, and the ad group
      // keeps it the day the campaign shows it again.
      for (const v of values(ch.dimension)) {
        const kv = keyOf(level, ch.dimension, v)
        if (state.get(kv)?.kind === 'NEG') continue
        put(kv, { kind: 'POS', bidModifier: v === ch.value ? m : null })
      }
      if (campaignHides) notes.push(hidden)
    } else if (!wasExcluded) skipped.push(campaignHides ? hidden : `${what} is already shown${m === null ? ' with no adjustment' : ''}.`)
    else if (campaignHides) notes.push(hidden)
  }
  for (const r of ask.restore ?? []) {
    const level = r.adGroupId ?? ''
    const k = keyOf(level, r.dimension, r.value)
    if (seen.has(k)) return { refusal: `${valueWords(r.dimension, r.value)} at ${where(level)} is named twice.` }
    seen.add(k)
    if (r.criterion === 'TARGETED' && r.bidModifier !== undefined && r.bidModifier !== null && !(r.bidModifier >= 0.1 && r.bidModifier <= 10)) return { refusal: 'A bid adjustment is between 0.1 and 10.' }
    put(k, r.criterion === 'NONE' ? null : r.criterion === 'EXCLUDED' ? { kind: 'NEG', bidModifier: null } : { kind: 'POS', bidModifier: noAdjustment(r.bidModifier) })
  }

  // Google refuses a dimension with every group excluded, or with only "unknown" left: say so first.
  const dims = new Set([...touched].map((k) => k.split('|').slice(0, 2).join('|')))
  for (const ld of dims) {
    const [level, dimension] = ld.split('|') as [string, DemographicDimension]
    for (const l of level === '' ? ['', ...live.adGroups.map((a) => a.adGroupId)] : [level]) {
      const after = shown(state, l, dimension)
      if (!after.length) return { refusal: `That leaves ${where(l)} with every ${DIMENSION_WORDS[dimension]} group excluded: Google refuses it (its ads could show to nobody).` }
      const was = shown(before, l, dimension)
      if (after.length === 1 && isUndetermined(after[0]) && !(was.length === 1 && was[0] === after[0])) return { refusal: `That leaves ${where(l)} showing only to "${valueWords(dimension, after[0])}" in ${DIMENSION_WORDS[dimension]}: Google refuses targeting only the unknown group.` }
    }
  }

  // Operations: removes first (a group switched between shown and excluded is removed, then made again), then creates,
  // then bid adjustments changed in place.
  const res = `${customer}/campaigns/${c.campaignId}`
  const removes: GoogleMutateOperation[] = []
  const creates: GoogleMutateOperation[] = []
  const updates: GoogleMutateOperation[] = []
  const restore: DemographicRestore[] = []
  const set: DemographicRestore[] = []
  const resource = (level: string, criterionId: string) => (level === '' ? `${customer}/campaignCriteria/${c.campaignId}~${criterionId}` : `${customer}/adGroupCriteria/${level}~${criterionId}`)
  for (const k of [...touched].sort()) {
    const [level, dimension, value] = k.split('|') as [string, DemographicDimension, string]
    const b = before.get(k)
    const a = state.get(k)
    const same = b?.kind === a?.kind && (b?.kind !== 'POS' || (b!.bidModifier ?? 1) === (a!.bidModifier ?? 1))
    if (same) continue
    if (b && (!a || a.kind !== b.kind)) {
      const op = { remove: resource(level, b.criterionId ?? '') }
      removes.push(level === '' ? { campaignCriterionOperation: op } : { adGroupCriterionOperation: op })
    }
    if (a && (!b || a.kind !== b.kind)) {
      const body = { ...(a.kind === 'NEG' ? { negative: true } : {}), ...(a.kind === 'POS' && a.bidModifier !== null && a.bidModifier !== 1 ? { bidModifier: a.bidModifier } : {}), [DEMOGRAPHIC_FIELD[dimension]]: { type: value } }
      creates.push(level === '' ? { campaignCriterionOperation: { create: { campaign: res, ...body } } } : { adGroupCriterionOperation: { create: { adGroup: `${customer}/adGroups/${level}`, ...body } } })
    }
    if (a && b && a.kind === 'POS' && b.kind === 'POS') {
      const op = { update: { resourceName: resource(level, b.criterionId ?? ''), bidModifier: a.bidModifier ?? 1 }, updateMask: 'bid_modifier' }
      updates.push(level === '' ? { campaignCriterionOperation: op } : { adGroupCriterionOperation: op })
    }
    restore.push(restoreOf(dimension, value, level, b))
    set.push(restoreOf(dimension, value, level, a))
  }
  const ops = [...removes, ...creates, ...updates]
  if (!ops.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }

  // Who sees the ads and what it bids, per level and dimension changed.
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = [...notes]
  let adjusted = false
  const changedDims = new Set(set.map((x) => `${x.adGroupId ?? ''}|${x.dimension}`))
  const describe = (s: Map<string, State>, level: string, dimension: DemographicDimension) => {
    const on = shown(s, level, dimension)
    const adjustments = on.filter((v) => factorAt(s, level, dimension, v) !== 1).map((v) => `${valueWords(dimension, v)} ${adjustmentWords(factorAt(s, level, dimension, v))}`)
    return `${on.length} of ${values(dimension).length} shown${adjustments.length ? `; ${adjustments.join(', ')}` : ''}`
  }
  for (const ld of changedDims) {
    const [level, dimension] = ld.split('|') as [string, DemographicDimension]
    const w = where(level)
    lines.push([`${DIMENSION_WORDS[dimension]}, ${w}`, describe(before, level, dimension), describe(state, level, dimension)])
    const on0 = shown(before, level, dimension)
    const on1 = shown(state, level, dimension)
    const again = on1.filter((v) => !on0.includes(v))
    if (again.length) spends.push(`${w}: ${again.map((v) => valueWords(dimension, v)).join(', ')} can see the ads again${whereNote(level)}.`)
    const narrowed = on0.filter((v) => !on1.includes(v))
    if (narrowed.length) warnings.push(`${w}: ${narrowed.map((v) => valueWords(dimension, v)).join(', ')} no longer see${narrowed.length === 1 ? 's' : ''} the ads.`)
    const raised = on1.filter((v) => on0.includes(v) && factorAt(state, level, dimension, v) > factorAt(before, level, dimension, v))
    if (raised.length) spends.push(`${w}: bids more for ${raised.map((v) => `${valueWords(dimension, v)} (${adjustmentWords(factorAt(before, level, dimension, v))} → ${adjustmentWords(factorAt(state, level, dimension, v))})`).join(', ')}${whereNote(level)}.`)
    if (on1.some((v) => factorAt(state, level, dimension, v) !== 1)) adjusted = true
  }
  const smart = adjusted ? smartBiddingWords(c, 'other') : null
  if (smart) warnings.push(smart.replace('these bid adjustments', 'demographic bid adjustments'))

  const { changes, more } = changeLines(lines)
  const record: DemographicRecord = { campaignId: c.campaignId, restore, set }
  return {
    summary: `Google Ads campaign "${c.name}": change its demographics (${[...new Set([...changedDims].map((d) => DIMENSION_WORDS[d.split('|')[1] as DemographicDimension]))].join(', ')}; ${plural(ops.length, 'criterion', 'criteria')}).`,
    changes,
    totals: { operations: ops.length, criteriaAdded: creates.length, criteriaRemoved: removes.length, bidAdjustmentsChanged: updates.length, linesNotShown: more },
    warnings,
    spendsMoney: spends,
    skipped,
    operations: ops,
    stands: {
      campaignId: c.campaignId,
      status: c.status,
      bidding: c.bidding,
      adGroups: live.adGroups.map((a) => `${a.adGroupId}:${a.status}`).sort(),
      demographics: [...before].map(([k, s]) => `${k}:${s.kind}x${s.bidModifier ?? 1}`).sort(),
    },
    before: { campaignId: c.campaignId, restore },
    after: record,
  }
}

/** Whether what a demographics change wrote still stands in the live state (undo refuses to overwrite a later change). */
export function demographicRecordHolds(record: DemographicRecord, live: Pick<AudienceLive, 'criteria' | 'adGroupCriteria'>): boolean {
  const now = demographicState(live)
  return (record.set ?? []).every((x) => {
    const s = now.get(keyOf(x.adGroupId ?? '', x.dimension, x.value))
    if (x.criterion === 'NONE') return !s
    if (x.criterion === 'EXCLUDED') return s?.kind === 'NEG'
    return s?.kind === 'POS' && (s.bidModifier ?? 1) === (x.bidModifier ?? 1)
  })
}

export { DEMOGRAPHIC_DIMENSIONS }
