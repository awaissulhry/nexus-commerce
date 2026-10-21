/**
 * Meta step 18 — set-meta-budget-schedule as a draft: schedule a budget increase (a high-demand period) on a campaign or
 * an ad set, change or delete one, or switch budget scheduling on or off. Master rows CMP-057, CMP-059, CMP-060, CMP-061,
 * AS-088, AS-090. Pure.
 *
 * Meta's rules it follows (checked 2026-10-21, developers.facebook.com/documentation/ads-commerce/marketing-api/…):
 *   - reference/high-demand-period.md: the account needs CAN_USE_BUDGET_SCHEDULING_API; "Budget scheduling can only be
 *     used for campaigns with a daily budget"; at most 50 periods per campaign or ad set; "the total budget cannot exceed
 *     8 times the daily budget"; each period at least 3 hours; not for Advantage+ App campaigns; "Currently we only
 *     support non-recurring high demand periods"; after a period "your budget will automatically revert".
 *   - reference/ad-campaign-group/budget_schedules.md and reference/ad-campaign/budget_schedules.md: POST budget_value
 *     (int64, "140 could be $140 or 140%"), budget_value_type ABSOLUTE | MULTIPLIER, time_start, time_end (int64) — all
 *     required; read-after-write of the new period's id; "Updating / Deleting: You can't perform this operation".
 *   - Meta's SDK highdemandperiod.py: api_update (budget_value, budget_value_type, time_start, time_end) and api_delete on
 *     the period itself — STILL-UNVERIFIED (CMP-059, CMP-060): sent, Meta's answer decides (LIVE-PROBES). So a scheduled
 *     increase has NO undo (Meta documents no way to change or remove one); a change's undo is the same SDK-only change
 *     back, a delete's undo schedules it again (a documented create) while it has not started.
 *   - is_budget_schedule_enabled is a read field of a campaign and only in Meta's SDK as a write (campaign.py, adset.py
 *     api_update) — CMP-061 / AS-090 STILL-UNVERIFIED: sent, Meta's answer decides (LIVE-PROBES).
 *   - The unit of an ABSOLUTE increase is not documented: settings-units.ts scheduleAbsoluteParam sends WHOLE currency
 *     units (the safe side: read as cents it would be 100 times smaller, never larger) — LIVE-PROBES CMP-057.
 */
import { changeLines, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { campaignSettingsCheck, isOn, money, type SettingsRecord } from './change-settings-common.js'
import type { LivePeriod } from './live-settings.js'
import { metaUnitsToMinor, MetaUnitError, scheduleAbsoluteCents, scheduleAbsoluteParam, schedulePercentParam, unixSecondsParam } from './settings-units.js'
import { BUDGET_SCHEDULE_READ_BACK, MIN_PERIOD_SECONDS } from '../../gateway/meta-settings-rules.js'

export type ScheduleAction = 'create' | 'change' | 'delete' | 'switch'

export interface BudgetScheduleRequest {
  action: ScheduleAction
  level: 'campaign' | 'adset'
  objectId: string
  periodId?: string
  startTime?: string
  endTime?: string
  /** An increase by an amount, in minor units (whole currency units only: see the header). */
  increaseCents?: number
  /** An increase by a percentage (1–700). */
  increasePercent?: number
  /** switch: budget scheduling on or off. */
  enabled?: boolean
}

export interface ScheduleObject {
  kind: 'campaign' | 'adset'
  id: string
  name: string | null
  status: string | null
  /** The campaign's status (an ad set's parent; a campaign's own). */
  campaignStatus: string | null
  /** Meta offset units as strings. */
  dailyBudget: string | null
  lifetimeBudget: string | null
  /** Under a campaign budget (an ad set then has no budget of its own). */
  underCampaignBudget: boolean
  budgetScheduling: boolean | null
  objective: string | null
  smartPromotionType: string | null
}

export interface BudgetScheduleLive {
  object: ScheduleObject
  periods: LivePeriod[]
  /** The account's capabilities (null: Meta did not answer them). */
  capabilities: string[] | null
  currency: string | null
}

const MAX_PERIODS = 50
const word = (o: ScheduleObject) => `${o.kind === 'campaign' ? 'campaign' : 'ad set'} "${o.name ?? 'no name'}" (${o.id})`
const unix = (iso: string | null) => (iso ? Math.floor(Date.parse(iso) / 1000) : null)
const isoOf = (sec: number) => new Date(sec * 1000).toISOString()

/** A period's increase in words: "+20.00 EUR a day" or "+40%". */
export function increaseWords(type: string | null, value: number | null, currency: string | null): string {
  if (value === null) return 'unknown'
  return type === 'MULTIPLIER' ? `+${value}% of the daily budget` : `+${money(scheduleAbsoluteCents(value, currency), currency)} on the daily budget (Meta's number ${value}: whole ${currency ?? 'units'})`
}

export function budgetScheduleDraft(request: BudgetScheduleRequest, live: BudgetScheduleLive, now: Date = new Date()): MetaChangeDraft | { refusal: string } {
  try {
    return draft(request, live, now)
  } catch (err) {
    if (err instanceof MetaUnitError) return { refusal: err.message }
    throw err
  }
}

function draft(request: BudgetScheduleRequest, live: BudgetScheduleLive, now: Date): MetaChangeDraft | { refusal: string } {
  const o = live.object
  const cur = live.currency
  const who = word(o)
  const on = isOn(o.status, o.campaignStatus)
  const nowSec = Math.floor(now.getTime() / 1000)
  const warnings: string[] = []
  const spendsMoney: string[] = []
  const lines: Array<[string, unknown, unknown]> = []
  if (o.smartPromotionType === 'SMART_APP_PROMOTION' || o.objective === 'OUTCOME_APP_PROMOTION') return { refusal: 'Meta offers budget scheduling for every auction objective except Advantage+ App campaigns.' }
  if (live.capabilities && !live.capabilities.includes('CAN_USE_BUDGET_SCHEDULING_API')) {
    return { refusal: 'This ad account does not have Meta\'s budget scheduling (CAN_USE_BUDGET_SCHEDULING_API is not among its capabilities): Meta grants it; until then schedule increases in Ads Manager.' }
  }
  if (!live.capabilities) warnings.push('Meta did not say whether this account may schedule budgets (CAN_USE_BUDGET_SCHEDULING_API): its answer decides.')
  const dailyCents = metaUnitsToMinor(o.dailyBudget, cur)
  const needsDaily = () => {
    if (o.kind === 'adset' && o.underCampaignBudget) return `${who} is under a campaign budget: schedule the increase on its campaign.`
    if (dailyCents === null) return `${who} has no daily budget: Meta schedules increases of daily budgets only (ad scheduling is for lifetime budgets — set-meta-ad-set dayparting).`
    return null
  }

  // ── switch budget scheduling on / off (CMP-061, AS-090): STILL-UNVERIFIED ──
  if (request.action === 'switch') {
    if (request.enabled === undefined) return { refusal: 'Say whether budget scheduling goes on (enabled: true) or off (enabled: false).' }
    if (request.enabled === o.budgetScheduling) return { refusal: `Nothing to change: budget scheduling of ${who} is already ${request.enabled ? 'on' : 'off'}.` }
    const params = { is_budget_schedule_enabled: String(request.enabled) }
    if (request.enabled) spendsMoney.push(`Budget scheduling on for ${who}: its scheduled increases (${live.periods.length}) apply again — ${on ? 'it is on, so it can spend more in those periods' : 'nothing spends yet: it is not on'}.`)
    warnings.push(`Meta lists is_budget_schedule_enabled as a read field; only its SDK writes it, and Meta does not say whether "off" pauses the scheduled increases or only blocks new ones: its answer decides.`)
    const step: MetaChangeRequest = {
      step: 1, label: `Switch budget scheduling ${request.enabled ? 'on' : 'off'} for ${who}`, kind: o.kind, objectId: o.id, params,
      check: o.kind === 'campaign' ? campaignSettingsCheck() : 'none', raisesSpend: request.enabled, readBackInPost: o.kind === 'campaign', budget: false,
      undoable: o.budgetScheduling !== null, operation: `${o.kind}.settings`, expect: { ...params }, readBackFields: 'id,is_budget_schedule_enabled',
    }
    const before: SettingsRecord = {
      kind: o.kind, id: o.id, fields: { is_budget_schedule_enabled: o.budgetScheduling === null ? null : String(o.budgetScheduling) },
      undo: o.budgetScheduling === null ? null : { action: 'switch', level: o.kind, objectId: o.id, enabled: o.budgetScheduling },
      noUndo: o.budgetScheduling === null ? ['Its previous state was not readable.'] : [],
    }
    return finishDraft(step, [['Budget scheduling', o.budgetScheduling === null ? 'unknown' : o.budgetScheduling ? 'on' : 'off', request.enabled ? 'on' : 'off']], warnings, spendsMoney, before,
      { kind: o.kind, id: o.id, fields: { is_budget_schedule_enabled: String(request.enabled) } }, live)
  }

  // ── the increase asked (create, change) ──
  const asksIncrease = request.increaseCents !== undefined || request.increasePercent !== undefined
  if (request.increaseCents !== undefined && request.increasePercent !== undefined) return { refusal: 'Name an increase by an amount (increaseCents) or by a percentage (increasePercent), not both.' }
  const increase = request.increaseCents !== undefined
    ? { type: 'ABSOLUTE' as const, value: scheduleAbsoluteParam(request.increaseCents, cur), cents: request.increaseCents }
    : request.increasePercent !== undefined ? { type: 'MULTIPLIER' as const, value: schedulePercentParam(request.increasePercent), cents: null } : null

  if (request.action === 'create') {
    const problem = needsDaily()
    if (problem) return { refusal: problem }
    if (!increase || !request.startTime || !request.endTime) return { refusal: 'A scheduled increase names its start (startTime), its end (endTime) and the increase (increaseCents or increasePercent).' }
    if (live.periods.length >= MAX_PERIODS) return { refusal: `${who} has ${live.periods.length} scheduled increases already: Meta allows at most ${MAX_PERIODS}.` }
    const start = Number(unixSecondsParam(request.startTime))
    const end = Number(unixSecondsParam(request.endTime))
    if (start <= nowSec) return { refusal: 'A scheduled increase starts in the future.' }
    if (end - start < MIN_PERIOD_SECONDS) return { refusal: 'Meta schedules an increase of at least 3 hours.' }
    const cap = capProblem(increase, dailyCents!, cur)
    if (cap) return { refusal: cap }
    const params = { budget_value: increase.value, budget_value_type: increase.type, time_start: String(start), time_end: String(end) }
    lines.push(['Scheduled increase', 'none', `${increaseWords(increase.type, Number(increase.value), cur)}, ${isoOf(start)} → ${isoOf(end)}`])
    spendsMoney.push(`A scheduled increase of ${increaseWords(increase.type, Number(increase.value), cur)} on ${who} from ${isoOf(start)} to ${isoOf(end)}: Meta aims to spend that much more in the period — ${on ? 'it is on now' : 'it is not on now: nothing spends unless it is on during the period'}.`)
    if (increase.type === 'ABSOLUTE') warnings.push(`Meta does not document the unit of an increase by an amount ("140 could be $140 or 140%"): Nexus sends whole ${cur ?? 'currency units'} (${increase.value}). Should Meta read it as cents, the increase would be 100 times smaller — never larger.`)
    warnings.push('Meta documents no way to change or remove a scheduled increase once made (only its SDK has one): this change has no undo. Meta has no check for it either.')
    const step: MetaChangeRequest = {
      step: 1, label: `Schedule an increase on ${who}`, kind: o.kind, objectId: o.id, params, check: 'none', raisesSpend: true,
      readBackInPost: true, budget: false, undoable: false, operation: 'budgetSchedule.create', edge: 'budget_schedules',
      expect: { budget_value: increase.value, budget_value_type: increase.type }, readBackFields: [...BUDGET_SCHEDULE_READ_BACK].filter((f) => f !== 'recurrence_type').join(','),
    }
    const before: SettingsRecord = { kind: o.kind, id: o.id, fields: {}, undo: null, noUndo: ['A scheduled increase cannot be taken back through Meta\'s documented API (its SDK has a delete: set-meta-budget-schedule action delete — Meta\'s answer decides).'] }
    const after: SettingsRecord = { kind: 'highdemandperiod', id: '', parent: { kind: o.kind, id: o.id }, fields: periodFields(params) }
    return finishDraft(step, lines, warnings, spendsMoney, before, after, live)
  }

  // ── change or delete one period (CMP-059, CMP-060): SDK only ──
  if (!request.periodId) return { refusal: `Name the scheduled increase (periodId: meta-campaigns view budget-schedules lists ${who}'s).` }
  const period = live.periods.find((p) => p.id === request.periodId)
  if (!period) return { refusal: `${request.periodId} is not one of ${who}'s scheduled increases.` }
  const pStart = unix(period.timeStart)
  const pEnd = unix(period.timeEnd)
  const parent = { kind: o.kind, id: o.id }
  const periodWords = `${increaseWords(period.budgetValueType, period.budgetValue, cur)}, ${period.timeStart ?? '?'} → ${period.timeEnd ?? '?'}`
  if (pEnd !== null && pEnd <= nowSec) return { refusal: `That scheduled increase ended (${period.timeEnd}): nothing to change.` }

  if (request.action === 'delete') {
    warnings.push('Meta documents no delete of a scheduled increase; its SDK has one: Nexus sends it and Meta\'s answer decides.')
    const started = pStart !== null && pStart <= nowSec
    const back = !started && period.budgetValue !== null && period.budgetValueType && pStart !== null && pEnd !== null
      ? { action: 'create', level: o.kind, objectId: o.id, startTime: isoOf(pStart), endTime: isoOf(pEnd), ...(period.budgetValueType === 'MULTIPLIER' ? { increasePercent: period.budgetValue } : { increaseCents: scheduleAbsoluteCents(period.budgetValue, cur) }) }
      : null
    if (started) warnings.push('It has started: deleting it ends the increase now, and Nexus cannot schedule it again (it would start in the past).')
    const step: MetaChangeRequest = {
      step: 1, label: `Delete the scheduled increase ${period.id} of ${who}`, kind: o.kind, objectId: period.id, params: {}, check: 'none', raisesSpend: false,
      readBackInPost: false, budget: false, undoable: false, operation: 'budgetSchedule.delete', objectKind: 'highdemandperiod', method: 'DELETE', parent,
    }
    const before: SettingsRecord = { kind: 'highdemandperiod', id: period.id, parent, fields: { ...livePeriodFields(period), exists: 'yes' }, undo: back, noUndo: back ? [] : ['It has started or was not fully readable: it cannot be scheduled again as it was.'] }
    const after: SettingsRecord = { kind: 'highdemandperiod', id: period.id, parent, fields: { exists: 'no' } }
    return finishDraft(step, [['Scheduled increase', periodWords, 'deleted']], warnings, spendsMoney, before, after, live)
  }

  if (request.action !== 'change') return { refusal: `Unknown action ${request.action}.` }
  const params: Record<string, string> = {}
  if (increase) { params.budget_value = increase.value; params.budget_value_type = increase.type }
  const start = request.startTime ? Number(unixSecondsParam(request.startTime)) : pStart
  const end = request.endTime ? Number(unixSecondsParam(request.endTime)) : pEnd
  if (request.startTime) { if (start! <= nowSec) return { refusal: 'A scheduled increase starts in the future.' }; params.time_start = String(start) }
  if (request.endTime) params.time_end = String(end)
  if (!Object.keys(params).length) return { refusal: 'Name what changes: startTime, endTime or the increase.' }
  if (start !== null && end !== null && end - start < MIN_PERIOD_SECONDS) return { refusal: 'Meta schedules an increase of at least 3 hours.' }
  const problem = needsDaily()
  if (problem) return { refusal: problem }
  if (increase) { const cap = capProblem(increase, dailyCents!, cur); if (cap) return { refusal: cap } }
  const newType = increase?.type ?? period.budgetValueType
  const newValue = increase ? Number(increase.value) : period.budgetValue
  lines.push(['Scheduled increase', periodWords, `${increaseWords(newType, newValue, cur)}, ${isoOf(start!)} → ${isoOf(end!)}`])
  const raises = (increase && (increase.type !== period.budgetValueType || Number(increase.value) > (period.budgetValue ?? 0)))
    || (end !== null && pEnd !== null && end > pEnd) || (start !== null && pStart !== null && start < pStart)
  if (raises) spendsMoney.push(`A larger or longer increase on ${who} (${periodWords} → ${increaseWords(newType, newValue, cur)}, ${isoOf(start!)} → ${isoOf(end!)}): ${on ? 'it is on now' : 'it is not on now: nothing spends unless it is on during the period'}.`)
  warnings.push('Meta documents no change of a scheduled increase; its SDK has one: Nexus sends it and Meta\'s answer decides. Meta has no check for it.')
  if (increase?.type === 'ABSOLUTE') warnings.push(`Meta does not document the unit of an increase by an amount: Nexus sends whole ${cur ?? 'currency units'}.`)
  const back = period.budgetValue !== null && period.budgetValueType && pStart !== null && pEnd !== null && pStart > nowSec
    ? { action: 'change', level: o.kind, objectId: o.id, periodId: period.id, startTime: isoOf(pStart), endTime: isoOf(pEnd), ...(period.budgetValueType === 'MULTIPLIER' ? { increasePercent: period.budgetValue } : { increaseCents: scheduleAbsoluteCents(period.budgetValue, cur) }) }
    : null
  const step: MetaChangeRequest = {
    step: 1, label: `Change the scheduled increase ${period.id} of ${who}`, kind: o.kind, objectId: period.id, params, check: 'none', raisesSpend: !!raises,
    readBackInPost: false, budget: false, undoable: !!back, operation: 'budgetSchedule.update', objectKind: 'highdemandperiod', parent,
    expect: Object.fromEntries(Object.entries(params).filter(([k]) => k === 'budget_value' || k === 'budget_value_type')),
    readBackFields: 'id,budget_value,budget_value_type,time_start,time_end',
  }
  const before: SettingsRecord = { kind: 'highdemandperiod', id: period.id, parent, fields: { ...livePeriodFields(period), exists: 'yes' }, undo: back, noUndo: back ? [] : ['It has started (its old start is in the past) or was not fully readable: it cannot be put back as it was.'] }
  const after: SettingsRecord = { kind: 'highdemandperiod', id: period.id, parent, fields: { ...livePeriodFields(period), ...periodFields(params), exists: 'yes' } }
  return finishDraft(step, lines, warnings, spendsMoney, before, after, live)
}

/** Meta: "the total budget cannot exceed 8 times the daily budget" — the increase is at most 7 daily budgets (700%). */
export function capProblem(increase: { type: 'ABSOLUTE' | 'MULTIPLIER'; value: string; cents: number | null }, dailyCents: number, currency: string | null): string | null {
  if (increase.type === 'MULTIPLIER') return Number(increase.value) > 700 ? 'Meta keeps the total at most 8 times the daily budget: an increase of at most 700%.' : null
  return increase.cents! > 7 * dailyCents ? `Meta keeps the total at most 8 times the daily budget (${money(dailyCents, currency)} a day): an increase of at most ${money(7 * dailyCents, currency)}.` : null
}

/** A period's fields as a record views them (times as Unix seconds). */
export function periodFields(params: Record<string, string>): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const k of ['budget_value', 'budget_value_type', 'time_start', 'time_end']) if (k in params) out[k] = params[k]
  return out
}
export function livePeriodFields(p: LivePeriod): Record<string, string | null> {
  return {
    budget_value: p.budgetValue === null ? null : String(p.budgetValue), budget_value_type: p.budgetValueType,
    time_start: p.timeStart ? String(unix(p.timeStart)) : null, time_end: p.timeEnd ? String(unix(p.timeEnd)) : null,
  }
}

function finishDraft(step: MetaChangeRequest, lines: Array<[string, unknown, unknown]>, warnings: string[], spendsMoney: string[], before: SettingsRecord, after: SettingsRecord, live: BudgetScheduleLive): MetaChangeDraft {
  const { changes, more } = changeLines(lines)
  return {
    summary: `Meta: ${step.label}.`,
    changes,
    totals: { requests: 1, ...(more ? { moreLines: more } : {}) },
    warnings: [...warnings, ...(before.noUndo?.length ? [`No undo for: ${before.noUndo.join(' ')}`] : [])],
    spendsMoney,
    skipped: [],
    requests: [step],
    stands: { object: live.object, periods: live.periods, capabilities: live.capabilities },
    before,
    after,
  }
}
