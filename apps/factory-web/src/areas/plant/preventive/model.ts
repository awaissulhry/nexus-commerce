import { DEPTH_REFUSALS } from '@nexus/factory-domain/plant/requests/refusals'
import {
  addDays,
  addInterval,
  CHECK_INTERVAL_UNITS,
  CHECK_LIMITS,
  CHECK_OUTCOMES,
  daysBetween,
  INTERVAL_MAX,
  STATUTORY_REFUSALS,
  takesJob,
  takesLock,
  type CheckIntervalUnit,
  type CheckOutcome,
} from '@nexus/factory-domain/plant/statutory/rules'
import { issuePath, isApiError } from '../../../lib/api/errors'
import { isIsoDay, isIsoMonth, monthBounds, moveMonth, type CalendarState, type CalendarViewItem } from '../_shared/calendar/model'
import { PLANT_REFUSAL_CODES } from '../_shared/model'
import type { CheckPlan, CheckResult, CheckType, Chip, CountsAnswer, NewPlanBody, RecordBody } from './api'

/**
 * Plant › Maintenance › Preventive & statutory checks (SCR-266; B-W2b-142 on B-W2b-124's API; design plant.preventive;
 * QHS-205, D.Lgs. 81/2008 art. 71): the page's rules, pure — no React, no clock, no fetch. The address ⇄ the page's state,
 * the read windows, a calendar chip in words, the tiles, the plans' and the register's rows, every dialog's draft with why
 * its button is held and what it sends, and the API's refusals in our words (`refusal.<CODE>`, never the API's English).
 * No money anywhere; who did a check is words (the outside body or the inspector), as on the report; a plan's owner is an
 * office person (the design's column), never a floor worker.
 */

// ---- what a person may do -------------------------------------------------------------------------------------------------

export interface PreventiveCan {
  /** plant.view: the page at all. */
  view: boolean
  /** plant.checks.manage: New plan, Move a check, Record a check result, a correction, the report upload, keep the PDF. */
  manage: boolean
  /** plant.jobs.manage: "Make a job" of a failed or remarked check. */
  makeJob: boolean
  /** plant.report: "Lock as unsafe" of a failed check (H1: anyone may report a machine unsafe). */
  lock: boolean
  /** parties.view: the outside body picker. */
  parties: boolean
  /** files.read: a kept PDF's fingerprint (its seal). */
  readFiles: boolean
}

export function preventiveCan(permissions: readonly string[]): PreventiveCan {
  const held = new Set(permissions)
  return {
    view: held.has('plant.view'),
    manage: held.has('plant.checks.manage'),
    makeJob: held.has('plant.jobs.manage'),
    lock: held.has('plant.report'),
    parties: held.has('parties.view'),
    readFiles: held.has('files.read'),
  }
}

// ---- the address ------------------------------------------------------------------------------------------------------------

/** The page's four reads, each loading and failing on its own. */
export type PageSection = 'counts' | 'calendar' | 'plans' | 'register'
export const PAGE_SECTIONS: readonly PageSection[] = ['counts', 'calendar', 'plans', 'register']

export type CalendarMode = 'month' | 'list'
export type DueFilter = 'OVERDUE' | 'DUE_SOON'

/**
 * `?view=month|list&month=YYYY-MM&day=&due=OVERDUE|DUE_SOON&ended=1&missing=1&outcome=&plan=<id>&result=<id>&new=1
 * &record=1|<plan id>&corrects=<result id>&move=<plan id>&date=` — the tiles are filters of the lists (`due` the plans',
 * `missing` the register's); the register's export reads `missing`, `outcome` and the top bar's site.
 */
export interface PreventiveAddress {
  view: CalendarMode
  month: string | null
  day: string | null
  /** The plans' due filter (the tiles "Checks overdue", "Due in 30 days"). */
  due: DueFilter | null
  /** The plans list shows the ENDED plans. */
  ended: boolean
  /** The register shows only the results in force with no report (the tile "Reports missing"). */
  missing: boolean
  outcome: CheckOutcome | null
  /** The Plan window (a DetailModal). */
  plan: string | null
  /** The result's window (a DetailModal). */
  result: string | null
  /** New plan open. */
  newPlan: boolean
  /** Record a check result: `new` (pick the machine and the check) or the plan it is recorded on. */
  record: string | null
  /** Record a check result as a correction of this result. */
  corrects: string | null
  /** Move a check: the plan; `date` the day a drag dropped it on. */
  move: string | null
  date: string | null
}

export const EMPTY_ADDRESS: PreventiveAddress = Object.freeze({
  view: 'month',
  month: null,
  day: null,
  due: null,
  ended: false,
  missing: false,
  outcome: null,
  plan: null,
  result: null,
  newPlan: false,
  record: null,
  corrects: null,
  move: null,
  date: null,
}) as PreventiveAddress

const isOutcome = (value: unknown): value is CheckOutcome => typeof value === 'string' && (CHECK_OUTCOMES as readonly string[]).includes(value)

export function preventiveAddressOf(params: Pick<URLSearchParams, 'get'> | null): PreventiveAddress {
  const get = (name: string) => params?.get(name) ?? null
  const month = get('month')
  const day = get('day')
  const due = get('due')
  const outcome = get('outcome')
  const record = get('record')
  const date = get('date')
  return {
    view: get('view') === 'list' ? 'list' : 'month',
    month: isIsoMonth(month) ? month : null,
    day: isIsoDay(day) ? day : null,
    due: due === 'OVERDUE' || due === 'DUE_SOON' ? due : null,
    ended: get('ended') === '1',
    missing: get('missing') === '1',
    outcome: isOutcome(outcome) ? outcome : null,
    plan: get('plan') || null,
    result: get('result') || null,
    newPlan: get('new') === '1',
    record: record === '1' ? 'new' : record || null,
    corrects: get('corrects') || null,
    move: get('move') || null,
    date: isIsoDay(date) ? date : null,
  }
}

export function preventiveAddressText(address: PreventiveAddress): string {
  const query = new URLSearchParams()
  if (address.view === 'list') query.set('view', 'list')
  if (address.month) query.set('month', address.month)
  if (address.day) query.set('day', address.day)
  if (address.due) query.set('due', address.due)
  if (address.ended) query.set('ended', '1')
  if (address.missing) query.set('missing', '1')
  if (address.outcome) query.set('outcome', address.outcome)
  if (address.plan) query.set('plan', address.plan)
  if (address.result) query.set('result', address.result)
  if (address.newPlan) query.set('new', '1')
  if (address.record) query.set('record', address.record === 'new' ? '1' : address.record)
  if (address.corrects) query.set('corrects', address.corrects)
  if (address.move) query.set('move', address.move)
  if (address.move && address.date) query.set('date', address.date)
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** The address with a change; closing one dialog never closes the page's filters. */
export const withAddress = (address: PreventiveAddress, change: Partial<PreventiveAddress>): PreventiveAddress => ({ ...address, ...change })

/** Whether a dialog (or a window) is open: the page's own keys wait. */
export const dialogOpen = (address: PreventiveAddress): boolean => address.newPlan || !!address.record || !!address.corrects || !!address.move || !!address.plan || !!address.result

// ---- the read windows -------------------------------------------------------------------------------------------------------

/** Today in the site's zone (Europe/Rome), before the API says its own. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** The Month view reads the month shown and the one each side (a move of a month is drawn at once; ≤ 400 days). */
export function monthWindow(month: string): { from: string; to: string } {
  return { from: monthBounds(moveMonth(month, -1)).first, to: monthBounds(moveMonth(month, 1)).last }
}

/** The List reads 35 days back to a year on (400 days, the API's longest calendar window). */
export const LIST_BACK_DAYS = 35
export const LIST_AHEAD_DAYS = 365

export function listWindow(today: string): { from: string; to: string } {
  return { from: addDays(today, -LIST_BACK_DAYS), to: addDays(today, LIST_AHEAD_DAYS) }
}

/** The register print: any period up to three years (design new tab "Check register (print)"), default the last three. */
export const PRINT_YEARS = 3

export function printWindow(today: string, address: { from: string | null; to: string | null }): { from: string; to: string } {
  if (address.from && address.to && printWindowHeld(address.from, address.to) === null) return { from: address.from, to: address.to }
  return { from: addDays(addInterval(today, -PRINT_YEARS, 'YEAR'), 1), to: today }
}

/** Print N (the register's bulk action): the print tab over the chosen results' days, only those results. */
export function printOfChosen(prefix: string, results: readonly Pick<CheckResult, 'id' | 'performedOn'>[]): string {
  const days = results.map((result) => result.performedOn).sort()
  const query = new URLSearchParams()
  if (days.length > 0) {
    query.set('from', days[0]!)
    query.set('to', days[days.length - 1]!)
    query.set('ids', results.map((result) => result.id).join(','))
  }
  const text = query.toString()
  return `${prefix}/plant/preventive/register${text ? `?${text}` : ''}`
}

/** The print's own address: the period and the chosen results (Print N), if any. */
export function printAddressOf(params: Pick<URLSearchParams, 'get'> | null): { from: string | null; to: string | null; ids: string[] | null } {
  const from = params?.get('from') ?? null
  const to = params?.get('to') ?? null
  const ids = (params?.get('ids') ?? '').split(',').map((id) => id.trim()).filter(Boolean)
  return { from: isIsoDay(from) ? from : null, to: isIsoDay(to) ? to : null, ids: ids.length > 0 ? ids : null }
}

/** Why a print period may not be read (a message key), or null. */
export function printWindowHeld(from: string, to: string): string | null {
  if (!isIsoDay(from) || !isIsoDay(to)) return 'print.heldDays'
  if (to < from) return 'print.heldOrder'
  if (addInterval(from, PRINT_YEARS, 'YEAR') <= to) return 'print.heldLong'
  return null
}

// ---- words ------------------------------------------------------------------------------------------------------------------

export type Locale = 'it' | 'en'

/** A check type's name in the page's language (the type's own Italian or English). */
export const typeLabel = (type: Pick<CheckType, 'labelIt' | 'labelEn'>, locale: Locale): string => (locale === 'it' ? type.labelIt : type.labelEn)

/** A machine's make and model in one line ('' when neither is known). */
export const modelText = (machine: { make?: string | null; modelName?: string | null }): string => [machine.make, machine.modelName].map((part) => part?.trim()).filter(Boolean).join(' ')

/** The machine as one short line: its asset number, then make and model when known. */
export function machineText(machine: { assetNumber: string; make?: string | null; modelName?: string | null }): string {
  const model = modelText(machine)
  return model ? `${machine.assetNumber} · ${model}` : machine.assetNumber
}

/** An interval in words: a message key with the count (`interval.MONTH_other` "Every 3 months"). */
export const intervalWords = (interval: number, unit: CheckIntervalUnit): { key: string; params: { count: number } } => ({ key: `interval.${unit}`, params: { count: interval } })

/** An outcome's tone (a pill): passed success, remarks warning, failed danger. */
export const OUTCOME_TONE: Readonly<Record<CheckOutcome, 'success' | 'warning' | 'danger'>> = Object.freeze({ PASSED: 'success', PASSED_WITH_REMARKS: 'warning', FAILED: 'danger' })

// ---- the calendar -----------------------------------------------------------------------------------------------------------

/** A chip's key: its kind, its plan or result, its day (unique among the chips shown). */
export const chipKey = (chip: Pick<Chip, 'kind' | 'planId' | 'resultId' | 'date'>): string => `${chip.kind}:${chip.kind === 'DONE' ? chip.resultId : chip.planId}:${chip.date}`

/** The calendar state a chip is drawn with: the plan's tone for its next due date, planned (or due soon) for later checks, done. */
export function chipState(chip: Pick<Chip, 'kind' | 'state'>): CalendarState {
  if (chip.kind === 'DONE') return 'DONE'
  return chip.state === 'DONE' ? 'PLANNED' : chip.state
}

/** Only the next due date of a plan moves (a later check follows it by the interval; a check done never moves). */
export const chipMoves = (chip: Pick<Chip, 'kind' | 'planId'>): boolean => chip.kind === 'DUE' && !!chip.planId

/** Where a chip opens: its plan (due, later) or its result (done). */
export function chipTarget(chip: Pick<Chip, 'kind' | 'planId' | 'resultId'>): Partial<PreventiveAddress> | null {
  if (chip.kind === 'DONE') return chip.resultId ? { result: chip.resultId, plan: null } : null
  return chip.planId ? { plan: chip.planId, result: null } : null
}

export interface ChipWords {
  /** "Press guards · SEED-CP-01" — the check and the machine. */
  readonly title: string
  /** The outside body, a later check, the outcome, a locked machine: message keys with their params. */
  readonly meta: readonly { key: string; params?: Readonly<Record<string, string | number>> }[]
}

/** A chip in words (data words in, message keys out). */
export function chipWords(chip: Chip, locale: Locale): ChipWords {
  const meta: { key: string; params?: Record<string, string | number> }[] = []
  if (chip.kind === 'PROJECTED') meta.push({ key: 'chip.projected' })
  if (chip.kind === 'DONE' && chip.outcome) meta.push({ key: `outcome.${chip.outcome}` })
  if (chip.outsideBody) meta.push({ key: 'chip.body', params: { body: chip.outsideBody } })
  if (chip.machine.locked && chip.kind !== 'DONE') meta.push({ key: 'chip.locked' })
  return { title: `${typeLabel(chip.checkType, locale)} · ${chip.machine.assetNumber}`, meta }
}

/** The calendar's items (already in words through `say`), each with its own address for Enter and ⌘-click. */
export function calendarItems(chips: readonly Chip[], locale: Locale, say: (key: string, params?: Readonly<Record<string, string | number>>) => string, allSites: boolean): CalendarViewItem[] {
  return chips.map((chip) => {
    const words = chipWords(chip, locale)
    return {
      key: chipKey(chip),
      date: chip.date,
      title: words.title,
      state: chipState(chip),
      meta: words.meta.map((entry) => say(entry.key, entry.params)).join(' · ') || null,
      site: allSites ? chip.site.name : null,
    }
  })
}

/** The calendar List's rows: by day, then the worst first, then the machine. */
export function chipRows(chips: readonly Chip[]): Chip[] {
  const rank: Record<CalendarState, number> = { OVERDUE: 0, DUE_SOON: 1, TO_CONFIRM: 2, PLANNED: 3, DONE: 4, CANCELLED: 5 }
  return [...chips].sort((a, b) => a.date.localeCompare(b.date) || rank[chipState(a)] - rank[chipState(b)] || a.machine.assetNumber.localeCompare(b.machine.assetNumber) || chipKey(a).localeCompare(chipKey(b)))
}

// ---- the tiles --------------------------------------------------------------------------------------------------------------

export const TILES = ['OVERDUE', 'DUE_SOON', 'REPORTS_MISSING'] as const
export type TileId = (typeof TILES)[number]

export function tilesOf(counts: CountsAnswer | null): { id: TileId; value: number | null }[] {
  return TILES.map((id) => ({ id, value: counts?.tiles[id] ?? null }))
}

/** What a tile does: a filter of the plans (its due state) or of the register (reports missing); a second press clears it. */
export function tileChange(id: TileId, address: PreventiveAddress): Partial<PreventiveAddress> {
  if (id === 'REPORTS_MISSING') return { missing: !address.missing }
  return { due: address.due === id ? null : id, ended: false }
}

export const tileActive = (id: TileId, address: PreventiveAddress): boolean => (id === 'REPORTS_MISSING' ? address.missing : address.due === id)

// ---- the plans --------------------------------------------------------------------------------------------------------------

/** Why a plan may not be chosen for Move N (a message key), or null. */
export function planSelectHeld(plan: Pick<CheckPlan, 'status'>, can: Pick<PreventiveCan, 'manage'>): string | null {
  if (!can.manage) return 'held.manage'
  if (plan.status === 'ENDED') return 'held.ended'
  return null
}

// ---- the register -----------------------------------------------------------------------------------------------------------

/** A result's report in words: on file (its names), missing (in force, none on file), or kept by the result it corrects. */
export function reportState(result: Pick<CheckResult, 'reports' | 'reportOnFile' | 'inForce'>): 'onFile' | 'missing' | 'byCorrected' | 'notNeeded' {
  if (result.reports.length > 0) return 'onFile'
  if (result.reportOnFile) return 'byCorrected'
  return result.inForce ? 'missing' : 'notNeeded'
}

/** A failed or remarked check may make a job; only a failed one locks (the API's rules: takesJob, takesLock). */
export const offersJob = (outcome: CheckOutcome | ''): boolean => outcome !== '' && takesJob(outcome)
export const offersLock = (outcome: CheckOutcome | ''): boolean => outcome !== '' && takesLock(outcome)

// ---- New plan ---------------------------------------------------------------------------------------------------------------

export interface PlanDraft {
  machineId: string
  checkTypeId: string
  interval: string
  intervalUnit: CheckIntervalUnit
  outsideBodyPartyId: string
  ownerId: string
  firstDueOn: string
  reminderDays: string
  note: string
  /** PLAN_EXISTS answered: end that plan in the same step, with this reason. */
  replace: boolean
  replaceReason: string
}

export const EMPTY_PLAN: PlanDraft = Object.freeze({ machineId: '', checkTypeId: '', interval: '', intervalUnit: 'YEAR', outsideBodyPartyId: '', ownerId: '', firstDueOn: '', reminderDays: '30', note: '', replace: false, replaceReason: '' }) as PlanDraft

/** A type picked: its default interval comes with it (the person may change it). */
export const withType = (draft: PlanDraft, type: Pick<CheckType, 'id' | 'defaultInterval' | 'defaultIntervalUnit'> | null): PlanDraft =>
  type ? { ...draft, checkTypeId: type.id, interval: String(type.defaultInterval), intervalUnit: type.defaultIntervalUnit } : { ...draft, checkTypeId: '' }

const wholeNumber = (text: string): number | null => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null)

/** Why an interval is held (a message key), or null: 1 to at most ten years in its unit. */
export function intervalHeld(text: string, unit: CheckIntervalUnit): string | null {
  const n = wholeNumber(text)
  if (n === null || n < 1 || n > INTERVAL_MAX[unit]) return 'held.interval'
  return null
}

/** Why Create plan is held (a message key), or null. */
export function planHeld(draft: PlanDraft, busy = false): string | null {
  if (busy) return 'held.saving'
  if (!draft.machineId) return 'held.machine'
  if (!draft.checkTypeId) return 'held.type'
  const interval = intervalHeld(draft.interval, draft.intervalUnit)
  if (interval) return interval
  if (!isIsoDay(draft.firstDueOn)) return 'held.firstDue'
  const reminder = wholeNumber(draft.reminderDays)
  if (reminder === null || reminder > CHECK_LIMITS.reminderDays) return 'held.reminder'
  if (draft.note.trim().length > CHECK_LIMITS.note) return 'held.noteLong'
  if (draft.replace && !draft.replaceReason.trim()) return 'held.replaceReason'
  return null
}

/** POST /plant/checks/plans. */
export function planBody(draft: PlanDraft): NewPlanBody {
  return {
    machineId: draft.machineId,
    checkTypeId: draft.checkTypeId,
    interval: Number(draft.interval),
    intervalUnit: draft.intervalUnit,
    outsideBodyPartyId: draft.outsideBodyPartyId || null,
    ownerId: draft.ownerId || null,
    firstDueOn: draft.firstDueOn,
    reminderDays: Number(draft.reminderDays),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    ...(draft.replace && draft.replaceReason.trim() ? { replaceReason: draft.replaceReason.trim() } : {}),
  }
}

/** The day the first reminder goes (the first due date minus the lead time), or null. */
export function reminderFrom(firstDueOn: string, reminderDays: string): string | null {
  const days = wholeNumber(reminderDays)
  return isIsoDay(firstDueOn) && days !== null ? addDays(firstDueOn, -days) : null
}

// ---- Record a check result --------------------------------------------------------------------------------------------------

export interface ResultDraft {
  /** Picked when the dialog opens without a plan. */
  machineId: string
  checkTypeId: string
  performedOn: string
  outcome: CheckOutcome | ''
  remarks: string
  performedBy: string
  outsideBodyPartyId: string
  nextDueOn: string
  /** Picked report files, sent once the result is saved. */
  files: readonly File[]
  makeJob: boolean
  lock: boolean
  lockNote: string
  correctionReason: string
}

export function newResultDraft(today: string, plan: Pick<CheckPlan, 'outsideBody'> | null = null): ResultDraft {
  return {
    machineId: '',
    checkTypeId: '',
    performedOn: today,
    outcome: '',
    remarks: '',
    performedBy: plan?.outsideBody?.name ?? '',
    outsideBodyPartyId: plan?.outsideBody?.id ?? '',
    nextDueOn: '',
    files: [],
    makeJob: false,
    lock: false,
    lockNote: '',
    correctionReason: '',
  }
}

/** An outcome picked: a failed check offers the job ticked (the lock stays the person's choice); a pass drops both. */
export function withOutcome(draft: ResultDraft, outcome: CheckOutcome): ResultDraft {
  return { ...draft, outcome, makeJob: outcome === 'FAILED' ? true : offersJob(outcome) ? draft.makeJob : false, lock: offersLock(outcome) ? draft.lock : false }
}

export interface ResultContext {
  /** Recorded on a plan (null: the machine and check picked in the dialog). */
  readonly planId: string | null
  /** The result it corrects (a correction). */
  readonly correctsId: string | null
  /** The machine is locked as unsafe already: no second lock (the API's LOCKED_ALREADY). */
  readonly machineLocked: boolean
  readonly can: Pick<PreventiveCan, 'manage' | 'makeJob' | 'lock'>
}

/** Why Save result is held (a message key), or null. */
export function resultHeld(draft: ResultDraft, context: ResultContext, today: string, busy = false): string | null {
  if (!context.can.manage) return 'held.manage'
  if (busy) return 'held.saving'
  if (!context.planId && !context.correctsId && (!draft.machineId || !draft.checkTypeId)) return draft.machineId ? 'held.type' : 'held.machine'
  if (!isIsoDay(draft.performedOn)) return 'held.performedOn'
  if (draft.performedOn > today) return 'held.future'
  if (!draft.outcome) return 'held.outcome'
  if (draft.outcome !== 'PASSED' && !draft.remarks.trim()) return draft.outcome === 'FAILED' ? 'held.remarksFailed' : 'held.remarks'
  if (draft.remarks.trim().length > CHECK_LIMITS.text) return 'held.remarksLong'
  if (!draft.performedBy.trim()) return 'held.performedBy'
  if (draft.performedBy.trim().length > CHECK_LIMITS.performedBy) return 'held.performedByLong'
  if (draft.nextDueOn && (!isIsoDay(draft.nextDueOn) || draft.nextDueOn <= draft.performedOn)) return 'held.nextDue'
  if (context.correctsId && !draft.correctionReason.trim()) return 'held.correctionReason'
  if (draft.makeJob && offersJob(draft.outcome) && !context.can.makeJob) return 'held.jobRight'
  if (draft.lock && offersLock(draft.outcome) && !context.can.lock) return 'held.lockRight'
  if (draft.lock && offersLock(draft.outcome) && context.machineLocked) return 'refusal.LOCKED_ALREADY'
  return null
}

/** POST /plant/checks/results: the result, and in the same step the job and the lock the person ticked. */
export function resultBody(draft: ResultDraft, context: Pick<ResultContext, 'planId' | 'correctsId' | 'machineLocked'>): RecordBody {
  const outcome = draft.outcome as CheckOutcome
  return {
    ...(context.planId ? { planId: context.planId } : !context.correctsId ? { machineId: draft.machineId, checkTypeId: draft.checkTypeId } : {}),
    ...(context.correctsId && draft.machineId && draft.checkTypeId ? { machineId: draft.machineId, checkTypeId: draft.checkTypeId } : {}),
    performedOn: draft.performedOn,
    outcome,
    remarks: draft.remarks.trim() || null,
    performedBy: draft.performedBy.trim(),
    outsideBodyPartyId: draft.outsideBodyPartyId || null,
    nextDueOn: draft.nextDueOn || null,
    ...(context.correctsId ? { correctsId: context.correctsId, correctionReason: draft.correctionReason.trim() } : {}),
    ...(draft.makeJob && offersJob(outcome) ? { job: {} } : {}),
    ...(draft.lock && offersLock(outcome) && !context.machineLocked ? { lock: draft.lockNote.trim() ? { note: draft.lockNote.trim() } : {} } : {}),
  }
}

/** The plan's next due date the result will give (the date typed, else the day plus the plan's interval), or null. */
export function nextDueOf(draft: Pick<ResultDraft, 'performedOn' | 'nextDueOn'>, plan: Pick<CheckPlan, 'interval' | 'intervalUnit' | 'firstDueOn'> | null): string | null {
  if (draft.nextDueOn && isIsoDay(draft.nextDueOn)) return draft.nextDueOn
  if (!plan || !isIsoDay(draft.performedOn)) return null
  const next = addInterval(draft.performedOn, plan.interval, plan.intervalUnit)
  return next < plan.firstDueOn ? plan.firstDueOn : next
}

// ---- Move a check -----------------------------------------------------------------------------------------------------------

export interface MoveDraft {
  nextDueOn: string
  reason: string
}

/** Why Move is held (a message key), or null: a new day on or after the plan's first, not the day it has, and why. */
export function moveHeld(draft: MoveDraft, plans: readonly Pick<CheckPlan, 'firstDueOn' | 'nextDueOn' | 'status'>[], busy = false): string | null {
  if (busy) return 'held.saving'
  if (plans.length === 0) return 'held.reading'
  if (plans.some((plan) => plan.status === 'ENDED')) return 'refusal.PLAN_ENDED'
  if (!isIsoDay(draft.nextDueOn)) return 'held.newDate'
  if (plans.some((plan) => draft.nextDueOn < plan.firstDueOn)) return 'refusal.BEFORE_FIRST_DUE'
  if (plans.length === 1 && plans[0]!.nextDueOn === draft.nextDueOn) return 'refusal.SAME_DATE'
  if (!draft.reason.trim()) return 'held.reason'
  if (draft.reason.trim().length > CHECK_LIMITS.reason) return 'held.reasonLong'
  return null
}

/** How far a move goes, in days (negative: earlier). */
export const moveDays = (from: string, to: string): number => (isIsoDay(from) && isIsoDay(to) ? daysBetween(from, to) : 0)

// ---- live -------------------------------------------------------------------------------------------------------------------

/** Which sections a live message reads again (a message is a hint: the page reads, it never takes data from it). */
export function sectionsOfChange(change: { readonly type: string }): PageSection[] {
  switch (change.type) {
    case 'machine_check.recorded':
      return ['register', 'plans', 'calendar', 'counts']
    case 'machine_check_plan.changed':
    case 'machine_check.due':
      return ['plans', 'calendar', 'counts']
    case 'machine_check_type.changed':
      return ['plans', 'calendar']
    case 'maintenance_request.locked':
    case 'maintenance_request.signed_safe':
    case 'machine.status_changed':
      return ['plans', 'calendar']
    default:
      return change.type.startsWith('maintenance_job.') ? ['register'] : []
  }
}

// ---- the API's answers in our words -----------------------------------------------------------------------------------------

/**
 * The refusals these routes answer: every statutory one, and the plant's own that the job and the lock made in the same
 * step may answer (a retired machine, the site's lock rule H1, a lock the site does not allow). Any other refusal is said
 * as "refused" (never as "it changed meanwhile").
 */
const PLANT_ONES: readonly string[] = ['RETIRED', 'CLASS_INACTIVE', 'LOCKED_UNSAFE'].filter((code) => (PLANT_REFUSAL_CODES as readonly string[]).includes(code))
const DEPTH_ONES: readonly string[] = ['H1_HELD', 'LOCK_NOT_ALLOWED'].filter((code) => (DEPTH_REFUSALS as readonly string[]).includes(code))
const REFUSALS = new Set<string>([...STATUTORY_REFUSALS, ...PLANT_ONES, ...DEPTH_ONES])

/** A failed call in our words: a refusal by its code, else the kind; `field` = the body field at fault (said at it). */
export interface Problem {
  readonly key: string
  readonly field: string | null
  /** No answer: whether it was done is not known (never said "saved"). */
  readonly unknown?: boolean
}

export function problemOf(error: unknown): Problem {
  if (!isApiError(error)) return { key: 'problem.unavailable', field: null, unknown: true }
  let refusal: string | null = null
  let other = false
  let field: string | null = null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/') && !refusal) {
      const code = path.slice('refusal/'.length)
      if (REFUSALS.has(code)) refusal = code
      else other = true
    } else if (/^body[./]/.test(path) && !field) {
      field = path.replace(/^body[./]/, '').split(/[./]/)[0] || null
    }
  }
  if (refusal) return { key: `refusal.${refusal}`, field }
  if (other) return { key: 'problem.refused', field }
  switch (error.kind) {
    case 'invalid':
      return { key: field ? 'problem.field' : 'problem.invalid', field }
    case 'signed_out':
      return { key: 'problem.signedOut', field: null }
    case 'forbidden':
      return { key: 'problem.forbidden', field: null }
    case 'step_up':
      return { key: 'problem.stepUp', field: null }
    case 'not_found':
      return { key: 'problem.notFound', field: null }
    case 'conflict':
      return { key: 'problem.conflict', field: null }
    case 'rate_limited':
      return { key: 'problem.rateLimited', field: null }
    case 'contract':
      return { key: 'problem.contract', field: null }
    case 'unavailable':
      return error.code === 'network' ? { key: 'problem.noAnswer', field: null, unknown: true } : { key: 'problem.unavailable', field: null }
    default:
      return { key: 'problem.internal', field: null }
  }
}

/** A read that failed, in words (a section says it and offers Try again; never drawn as empty). */
export const readProblemOf = (error: unknown): string => {
  const problem = problemOf(error)
  return problem.key === 'problem.forbidden' || problem.key === 'problem.signedOut' || problem.key === 'problem.notFound' || problem.key === 'problem.rateLimited' ? problem.key : 'problem.read'
}

/** The problem's words at a field, when it names that field. */
export const atField = (problem: Problem | null, ...fields: readonly string[]): string | null => (problem && problem.field && fields.includes(problem.field) ? problem.key : null)

/** Every refusal the page says in words (the catalogue holds each: a test reads this list). */
export const KNOWN_REFUSALS: readonly string[] = [...REFUSALS]

export { CHECK_INTERVAL_UNITS, CHECK_OUTCOMES }
