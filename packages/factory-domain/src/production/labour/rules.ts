import type { Issue } from '../../core/errors'
import { businessDate, type BusinessDate } from '../../core/time'
import { Dec, type Decimal } from '../../tax/decimal'

/**
 * Labour records and corrections (B-W2b-45; MES-201 … MES-206; c.c. art. 2101; GDPR art. 15; design production.labour
 * "Labour & corrections", floor.myday "Your records" and "Dispute an entry"), pure. The API (modules/production/labour)
 * says these in words before the …_floor_work_w2b_guards triggers would refuse the same.
 *
 *   record      a labour record per scan (MES-201): each REPORT a bundle got at an operation, with what stands of it now
 *               (a later CORRECTION approved by a lead replaces its counts, an UNDO voids it) and its minutes: the
 *               standard minutes earned, good garments × the operation's frozen standard minutes. Its day is the site's
 *               day the REPORT reached the server (a correction approved later changes that day, not the day it was
 *               approved), as the daily production report counts it.
 *   sheet       the operator's daily sheet (MES-202): one person, one day: pieces, production minutes (standard minutes
 *               earned), off-standard minutes by code, attendance minutes where attendance is recorded, and what is still
 *               open. Inside one record only, never a ranking: no percentage, no comparison with others, no colour
 *               judgement (Statuto dei Lavoratori art. 4; Owner answers W1, F2, H3).
 *   line day    each line's day (MES-203): it closes once its off-standard time is coded (no block running or waiting) and
 *               its anomalies are cleared (corrections waiting, open disputes, refused scans not dealt with, attendance
 *               anomalies of the people who worked on it). Closed days feed pay; reopening needs a reason.
 *   edit        every change of a labour or attendance record keeps before and after, who, when and why (MES-204): the
 *               labour edits, the scan corrections, the attendance corrections and the clock events typed or voided by
 *               hand, read as one timeline.
 *   dispute     a worker flags one of their own records as wrong (MES-206) with a reason tile and words; the team leader
 *               or HR answers it, upheld or rejected, in words; an upheld dispute of an off-standard block corrects it in
 *               the same step (its labour edit names the dispute). Never answered by the worker who raised it.
 *
 * No figure here is compared across people, and no list or total by person is ever made from these (Owner answer F2).
 */

export const LABOUR_LIMITS = Object.freeze({
  /** A dispute's words. */
  message: 500,
  /** An answer's words, sent to the worker. */
  answer: 1000,
  /** Why a day is reopened. */
  reason: 500,
  note: 500,
  /** Days one list of line days spans at most. */
  daysPerList: 62,
  /** The days the tiles and the queue look back for line days to close. */
  openDaysWindow: 14,
  /** Rows one queue or timeline answers at most. */
  rows: 500,
  /** Days a worker's own records span at most in one read. */
  mineDays: 31,
})

export interface LabourRefusal {
  readonly code: string
  readonly message: string
  readonly fix: string
}

// ---- minutes ----------------------------------------------------------------------------------------------------------

const MINUTES = /^\d{1,7}(\.\d{1,3})?$/

/** Standard minutes as a decimal (a routing step's per garment: Decimal(10,3) as a string); null when not one. */
export function minutesValue(value: string | null | undefined): Decimal | null {
  if (typeof value !== 'string' || !MINUTES.test(value)) return null
  return new Dec(value)
}

/** Three decimals, exact (a standard of three decimals times whole garments never rounds). */
export const minutesText = (value: Decimal): string => value.toDecimalPlaces(3, Dec.ROUND_HALF_UP).toFixed(3)

/** Standard minutes earned: good garments × the operation's standard minutes per garment. */
export function earnedMinutes(good: number, standardMinutes: string | null | undefined): string {
  const per = minutesValue(standardMinutes) ?? new Dec(0)
  return minutesText(per.times(Math.max(0, Math.trunc(good))))
}

export function sumMinutes(values: readonly string[]): string {
  return minutesText(values.reduce<Decimal>((sum, value) => sum.plus(minutesValue(value) ?? 0), new Dec(0)))
}

// ---- labour records (MES-201) -----------------------------------------------------------------------------------------

/** STANDING as reported; CORRECTED: a lead's correction replaced its counts; UNDONE: voided (nothing of it counts). */
export const RECORD_STATES = ['STANDING', 'CORRECTED', 'UNDONE'] as const
export type RecordState = (typeof RECORD_STATES)[number]

/** A scan of the count ledger as the reader gives it (REPORT, UNDO, CORRECTION; the timing kinds are left out). */
export interface LabourScan {
  readonly id: string
  readonly kind: string
  readonly correctsId: string | null
  readonly goodQuantity: number
  readonly scrapQuantity: number
  readonly reworkQuantity: number
  readonly serverTime: Date
  readonly workOrderId: string
  readonly workOrderOperationId: string
  readonly bundleId: string
  readonly workerId: string | null
  readonly stationId: string | null
  readonly deviceId: string | null
  readonly approvedById: string | null
  readonly reason: string | null
}

export interface Counts {
  readonly good: number
  readonly scrap: number
  readonly rework: number
}

export interface RecordStep {
  readonly scanId: string
  readonly kind: 'CORRECTION' | 'UNDO'
  readonly at: Date
  readonly counts: Counts
  readonly approvedById: string | null
  readonly reason: string | null
}

export interface LabourRecord {
  /** The REPORT the record is. */
  readonly scanId: string
  /** The scan that stands for it now (itself, or its latest correction); null when undone. */
  readonly standingScanId: string | null
  readonly state: RecordState
  /** The site's day of the REPORT. */
  readonly workDate: BusinessDate
  readonly at: Date
  readonly workOrderId: string
  readonly workOrderOperationId: string
  readonly bundleId: string
  readonly workerId: string | null
  readonly stationId: string | null
  readonly deviceId: string | null
  /** As first reported. */
  readonly reported: Counts
  /** What stands now (all zero when undone). */
  readonly counts: Counts
  /** The corrections and the undo after it, oldest first. */
  readonly steps: readonly RecordStep[]
  /** Standard minutes earned by what stands: good × the operation's standard minutes, three decimals. */
  readonly earnedMinutes: string
}

const countsOf = (scan: Pick<LabourScan, 'goodQuantity' | 'scrapQuantity' | 'reworkQuantity'>): Counts => ({ good: scan.goodQuantity, scrap: scan.scrapQuantity, rework: scan.reworkQuantity })
const ZERO_COUNTS: Counts = Object.freeze({ good: 0, scrap: 0, rework: 0 })
const byTime = <T extends { readonly serverTime: Date; readonly id: string }>(a: T, b: T): number => a.serverTime.getTime() - b.serverTime.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * The labour records of these scans: one per REPORT, with the chain of corrections and the undo that followed it (the
 * scans must hold each REPORT's whole chain: the reader reads every scan of the bundles and operations concerned).
 */
export function labourRecordsOf(scans: readonly LabourScan[], standardMinutes: ReadonlyMap<string, string>, timeZone: string): LabourRecord[] {
  const ordered = [...scans].sort(byTime)
  const voidedBy = new Map<string, LabourScan>()
  for (const scan of ordered) if (scan.correctsId && (scan.kind === 'CORRECTION' || scan.kind === 'UNDO') && !voidedBy.has(scan.correctsId)) voidedBy.set(scan.correctsId, scan)
  const records: LabourRecord[] = []
  for (const root of ordered) {
    if (root.kind !== 'REPORT') continue
    const steps: RecordStep[] = []
    let current: LabourScan = root
    let undone = false
    const seen = new Set<string>([root.id])
    for (;;) {
      const next = voidedBy.get(current.id)
      if (!next || seen.has(next.id)) break
      seen.add(next.id)
      steps.push({ scanId: next.id, kind: next.kind === 'UNDO' ? 'UNDO' : 'CORRECTION', at: next.serverTime, counts: next.kind === 'UNDO' ? ZERO_COUNTS : countsOf(next), approvedById: next.approvedById, reason: next.reason })
      if (next.kind === 'UNDO') {
        undone = true
        break
      }
      current = next
    }
    const counts = undone ? ZERO_COUNTS : countsOf(current)
    records.push({
      scanId: root.id,
      standingScanId: undone ? null : current.id,
      state: undone ? 'UNDONE' : steps.length > 0 ? 'CORRECTED' : 'STANDING',
      workDate: businessDate(root.serverTime, timeZone),
      at: root.serverTime,
      workOrderId: root.workOrderId,
      workOrderOperationId: root.workOrderOperationId,
      bundleId: root.bundleId,
      workerId: root.workerId,
      stationId: root.stationId,
      deviceId: root.deviceId,
      reported: countsOf(root),
      counts,
      steps,
      earnedMinutes: earnedMinutes(counts.good, standardMinutes.get(root.workOrderOperationId)),
    })
  }
  return records
}

/** The REPORT a scan belongs to (itself for a REPORT; a CORRECTION or UNDO goes back along correctsId). */
export function reportOf<T extends Pick<LabourScan, 'id' | 'kind' | 'correctsId'>>(scan: T, byId: ReadonlyMap<string, T>): T | null {
  let current: T | undefined = scan
  const seen = new Set<string>()
  while (current && current.kind !== 'REPORT') {
    if (!current.correctsId || seen.has(current.id)) return null
    seen.add(current.id)
    current = byId.get(current.correctsId)
  }
  return current ?? null
}

// ---- the daily sheet (MES-202) ----------------------------------------------------------------------------------------

export interface SheetBlock {
  readonly codeId: string
  readonly code: string
  readonly kind: string
  readonly status: string
  readonly minutes: number
}

export interface SheetAttendance {
  readonly status: string
  readonly presentMinutes: number
  readonly breakMinutes: number
  readonly ordinaryMinutes: number
  readonly overtimeMinutes: number
  readonly absenceMinutes: number
}

/** What is still open about the person's day: shown as counts, never judged. */
export const SHEET_EXCEPTIONS = ['CORRECTION_WAITING', 'DISPUTE_OPEN', 'BLOCK_WAITING', 'BLOCK_REJECTED', 'RECORD_UNDONE', 'ATTENDANCE_ANOMALY'] as const
export type SheetException = (typeof SHEET_EXCEPTIONS)[number]

export const SHEET_EXCEPTION_WORDS: Readonly<Record<SheetException, string>> = Object.freeze({
  CORRECTION_WAITING: 'corrections waiting for a decision',
  DISPUTE_OPEN: 'disputes waiting for an answer',
  BLOCK_WAITING: 'off-standard blocks running or waiting for approval',
  BLOCK_REJECTED: 'off-standard blocks rejected',
  RECORD_UNDONE: 'reports undone',
  ATTENDANCE_ANOMALY: 'attendance anomalies to fix',
})

export interface SheetInput {
  readonly workDate: BusinessDate
  readonly records: readonly LabourRecord[]
  readonly blocks: readonly SheetBlock[]
  /** Null where attendance is not recorded for the person that day (or its legal gate is off). */
  readonly attendance: SheetAttendance | null
  readonly counts: Partial<Record<Exclude<SheetException, 'BLOCK_WAITING' | 'BLOCK_REJECTED' | 'RECORD_UNDONE'>, number>>
}

export interface DailySheet {
  readonly workDate: BusinessDate
  /** Garments of the records that stand. */
  readonly pieces: Counts
  /** Records that stand (not undone). */
  readonly records: number
  /** Standard minutes earned that day, three decimals. */
  readonly productionMinutes: string
  /** Off-standard and indirect minutes (rejected blocks left out), by code. */
  readonly offStandard: { readonly minutes: number; readonly byCode: readonly { readonly codeId: string; readonly code: string; readonly kind: string; readonly minutes: number; readonly blocks: number }[] }
  readonly attendance: SheetAttendance | null
  readonly exceptions: readonly { readonly kind: SheetException; readonly count: number; readonly words: string }[]
}

/**
 * One person's day, inside one record: sums of the person's own records only. Never a percentage, a pace, a target, a
 * rank or a comparison (design production.labour "Daily sheet": "no percentage, no comparison, no colour judgement").
 */
export function dailySheetOf(input: SheetInput): DailySheet {
  const standing = input.records.filter((record) => record.state !== 'UNDONE')
  const pieces = standing.reduce<Counts>((sum, record) => ({ good: sum.good + record.counts.good, scrap: sum.scrap + record.counts.scrap, rework: sum.rework + record.counts.rework }), ZERO_COUNTS)
  const counted = input.blocks.filter((block) => block.status !== 'REJECTED')
  const byCode = new Map<string, { codeId: string; code: string; kind: string; minutes: number; blocks: number }>()
  for (const block of counted) {
    const entry = byCode.get(block.codeId) ?? { codeId: block.codeId, code: block.code, kind: block.kind, minutes: 0, blocks: 0 }
    entry.minutes += Math.max(0, block.minutes)
    entry.blocks += 1
    byCode.set(block.codeId, entry)
  }
  const exceptionCounts: Record<SheetException, number> = {
    CORRECTION_WAITING: input.counts.CORRECTION_WAITING ?? 0,
    DISPUTE_OPEN: input.counts.DISPUTE_OPEN ?? 0,
    BLOCK_WAITING: input.blocks.filter((block) => block.status === 'OPEN' || block.status === 'PENDING').length,
    BLOCK_REJECTED: input.blocks.filter((block) => block.status === 'REJECTED').length,
    RECORD_UNDONE: input.records.length - standing.length,
    ATTENDANCE_ANOMALY: input.counts.ATTENDANCE_ANOMALY ?? 0,
  }
  return {
    workDate: input.workDate,
    pieces,
    records: standing.length,
    productionMinutes: sumMinutes(standing.map((record) => record.earnedMinutes)),
    offStandard: { minutes: [...byCode.values()].reduce((sum, entry) => sum + entry.minutes, 0), byCode: [...byCode.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)) },
    attendance: input.attendance,
    exceptions: SHEET_EXCEPTIONS.filter((kind) => exceptionCounts[kind] > 0).map((kind) => ({ kind, count: exceptionCounts[kind], words: SHEET_EXCEPTION_WORDS[kind] })),
  }
}

// ---- line days (MES-203) ----------------------------------------------------------------------------------------------

/** OPEN: something holds the close; READY: nothing does; CLOSED: closed (feeds pay). */
export const LINE_DAY_STATES = ['OPEN', 'READY', 'CLOSED'] as const
export type LineDayState = (typeof LINE_DAY_STATES)[number]

/** What holds a line's day from closing, in the order the screen lists it. */
export const DAY_BLOCKERS = ['OFF_STANDARD_RUNNING', 'OFF_STANDARD_WAITING', 'CORRECTION_WAITING', 'DISPUTE_OPEN', 'REFUSED_SCAN', 'ATTENDANCE_ANOMALY'] as const
export type DayBlocker = (typeof DAY_BLOCKERS)[number]

const BLOCKER_WORDS: Readonly<Record<DayBlocker, readonly [string, string]>> = Object.freeze({
  OFF_STANDARD_RUNNING: ['off-standard block still running', 'off-standard blocks still running'],
  OFF_STANDARD_WAITING: ['off-standard block waiting for approval', 'off-standard blocks waiting for approval'],
  CORRECTION_WAITING: ['correction request waiting for a decision', 'correction requests waiting for a decision'],
  DISPUTE_OPEN: ['dispute waiting for an answer', 'disputes waiting for an answer'],
  REFUSED_SCAN: ['refused scan not dealt with', 'refused scans not dealt with'],
  ATTENDANCE_ANOMALY: ['attendance anomaly to fix', 'attendance anomalies to fix'],
})

export const blockerWords = (kind: DayBlocker, count: number): string => `${count} ${BLOCKER_WORDS[kind][count === 1 ? 0 : 1]}`

export interface LineDayFacts {
  readonly closed: boolean
  readonly counts: Partial<Record<DayBlocker, number>>
}

export function blockersOf(facts: LineDayFacts): { readonly kind: DayBlocker; readonly count: number; readonly words: string }[] {
  return DAY_BLOCKERS.filter((kind) => (facts.counts[kind] ?? 0) > 0).map((kind) => ({ kind, count: facts.counts[kind]!, words: blockerWords(kind, facts.counts[kind]!) }))
}

export function lineDayState(facts: LineDayFacts): LineDayState {
  if (facts.closed) return 'CLOSED'
  return blockersOf(facts).length === 0 ? 'READY' : 'OPEN'
}

/** "Off-standard coded (yes / 3 blocks left)": blocks of the day still running or waiting. */
export function offStandardCoded(facts: LineDayFacts): { readonly coded: boolean; readonly left: number } {
  const left = (facts.counts.OFF_STANDARD_RUNNING ?? 0) + (facts.counts.OFF_STANDARD_WAITING ?? 0)
  return { coded: left === 0, left }
}

/** Why a line's day cannot close now; null when it can. */
export function closeRefusal(input: { readonly facts: LineDayFacts; readonly workDate: BusinessDate; readonly today: BusinessDate; readonly lineCode: string }): LabourRefusal | null {
  if (input.facts.closed) return { code: 'ALREADY_CLOSED', message: `The day ${input.workDate} of line ${input.lineCode} is closed already.`, fix: 'Nothing to do; reopen it with a reason to change it.' }
  if (input.workDate > input.today) return { code: 'NOT_YET', message: `The day ${input.workDate} of line ${input.lineCode} has not come yet.`, fix: 'Close a day once its work is done.' }
  const blockers = blockersOf(input.facts)
  if (blockers.length > 0) {
    return {
      code: 'HELD',
      message: `The day ${input.workDate} of line ${input.lineCode} closes once its off-standard time is coded and its anomalies are cleared: ${blockers.map((blocker) => blocker.words).join(', ')}.`,
      fix: 'Decide them in the queue, then close the day.',
    }
  }
  return null
}

export function reopenRefusal(input: { readonly closed: boolean; readonly workDate: BusinessDate; readonly lineCode: string }): LabourRefusal | null {
  return input.closed ? null : { code: 'NOT_CLOSED', message: `The day ${input.workDate} of line ${input.lineCode} is not closed.`, fix: 'Only a closed day is reopened.' }
}

/** A day of a list of line days: key `<lineId>|<day>`. */
export const lineDayKey = (lineId: string, workDate: BusinessDate): string => `${lineId}|${workDate}`

/** `day` moved by a number of days. */
export function addDays(day: BusinessDate, delta: number): BusinessDate {
  const at = new Date(`${day}T12:00:00.000Z`)
  at.setUTCDate(at.getUTCDate() + delta)
  return at.toISOString().slice(0, 10)
}

export function rangeProblems(from: BusinessDate, to: BusinessDate, at = 'querystring'): Issue[] {
  if (from > to) return [{ path: `${at}/from`, message: 'The range starts after it ends.' }]
  if (addDays(from, LABOUR_LIMITS.daysPerList - 1) < to) return [{ path: `${at}/to`, message: `A list spans at most ${LABOUR_LIMITS.daysPerList} days.` }]
  return []
}

// ---- edits (MES-204) --------------------------------------------------------------------------------------------------

/** LABOUR_EDIT a labour edit (off-standard block, dispute correction…); SCAN_CORRECTION a lead's correction of a report;
 * ATTENDANCE_CORRECTION a closed attendance day's correction; CLOCK_EDIT a clock event typed or voided by hand. */
export const EDIT_KINDS = ['LABOUR_EDIT', 'SCAN_CORRECTION', 'ATTENDANCE_CORRECTION', 'CLOCK_EDIT'] as const
export type EditKind = (typeof EDIT_KINDS)[number]

export type JsonScalar = string | number | boolean | null
export interface Change {
  readonly field: string
  readonly from: JsonScalar
  readonly to: JsonScalar
}

const scalar = (value: unknown): JsonScalar => (value === null || value === undefined ? null : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : JSON.stringify(value))

/** The fields that changed, from → to (ChangeValue), in key order. */
export function changesOf(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): Change[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  return keys.flatMap((field) => {
    const from = scalar(before[field])
    const to = scalar(after[field])
    return from === to ? [] : [{ field, from, to }]
  })
}

// ---- disputes (MES-206) -----------------------------------------------------------------------------------------------

/** The records a worker disputes: their own reports and their own off-standard blocks. */
export const DISPUTE_RECORD_TYPES = ['OperationScan', 'OffStandardEntry'] as const
export type DisputeRecordType = (typeof DISPUTE_RECORD_TYPES)[number]

/** The reason tiles (design floor.myday "Reason tiles (wrong quantity, not me, wrong operation, other)"; a block's own). */
export const DISPUTE_REASONS = ['WRONG_QUANTITY', 'WRONG_OPERATION', 'WRONG_TIME', 'WRONG_CODE', 'NOT_ME', 'OTHER'] as const
export type DisputeReason = (typeof DISPUTE_REASONS)[number]

export const DISPUTE_REASONS_FOR: Readonly<Record<DisputeRecordType, readonly DisputeReason[]>> = Object.freeze({
  OperationScan: ['WRONG_QUANTITY', 'NOT_ME', 'WRONG_OPERATION', 'OTHER'],
  OffStandardEntry: ['WRONG_TIME', 'WRONG_CODE', 'NOT_ME', 'OTHER'],
})

export const DISPUTE_REASON_WORDS: Readonly<Record<DisputeReason, string>> = Object.freeze({
  WRONG_QUANTITY: 'Wrong quantity',
  WRONG_OPERATION: 'Wrong operation',
  WRONG_TIME: 'Wrong time',
  WRONG_CODE: 'Wrong reason',
  NOT_ME: 'Not me',
  OTHER: 'Other',
})

export const DISPUTE_OUTCOMES = ['UPHELD', 'REJECTED'] as const
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number]

export const isDisputeReason = (value: unknown): value is DisputeReason => (DISPUTE_REASONS as readonly unknown[]).includes(value)

/** The dispute's words as the row keeps them: the reason tile first ("WRONG_QUANTITY: I sewed 12, not 10."). */
export function disputeMessageOf(reason: DisputeReason, words: string | null | undefined): string {
  const text = words?.trim() ?? ''
  return text ? `${reason}: ${text}` : reason
}

/** The reason tile and the words back from a dispute's message (a message typed elsewhere has no tile: null). */
export function readDisputeMessage(message: string): { readonly reason: DisputeReason | null; readonly words: string } {
  const match = /^([A-Z_]+)(?::\s*([\s\S]*))?$/.exec(message.trim())
  if (match && isDisputeReason(match[1])) return { reason: match[1], words: (match[2] ?? '').trim() }
  return { reason: null, words: message.trim() }
}

export function raiseProblems(input: { readonly recordType: DisputeRecordType; readonly reason: unknown; readonly words: unknown }, at = 'body'): Issue[] {
  const problems: Issue[] = []
  const allowed = DISPUTE_REASONS_FOR[input.recordType]
  if (!isDisputeReason(input.reason) || !allowed.includes(input.reason)) problems.push({ path: `${at}/reason`, message: `Pick what is wrong: ${allowed.map((reason) => DISPUTE_REASON_WORDS[reason].toLowerCase()).join(', ')}.` })
  const words = typeof input.words === 'string' ? input.words.trim() : ''
  if (input.words !== undefined && input.words !== null && typeof input.words !== 'string') problems.push({ path: `${at}/message`, message: 'Words, if any.' })
  else if (words.length > LABOUR_LIMITS.message) problems.push({ path: `${at}/message`, message: `Keep it to ${LABOUR_LIMITS.message} characters.` })
  else if (input.reason === 'OTHER' && words === '') problems.push({ path: `${at}/message`, message: 'Say what is wrong.' })
  return problems
}

export function answerProblems(input: { readonly outcome: unknown; readonly answer: unknown; readonly correcting: boolean; readonly recordType: string }, at = 'body'): Issue[] {
  const problems: Issue[] = []
  if (!(DISPUTE_OUTCOMES as readonly unknown[]).includes(input.outcome)) problems.push({ path: `${at}/outcome`, message: 'Upheld or rejected.' })
  const answer = typeof input.answer === 'string' ? input.answer.trim() : ''
  if (answer === '') problems.push({ path: `${at}/answer`, message: 'Say the answer in words: it is sent to the worker.' })
  else if (answer.length > LABOUR_LIMITS.answer) problems.push({ path: `${at}/answer`, message: `Keep it to ${LABOUR_LIMITS.answer} characters.` })
  if (input.correcting && input.outcome !== 'UPHELD') problems.push({ path: `${at}/correction`, message: 'Only an upheld dispute corrects its record.' })
  if (input.correcting && input.recordType !== 'OffStandardEntry') problems.push({ path: `${at}/correction`, message: "A report's counts change through its correction (the worker asks, a lead approves): answer the dispute in words." })
  return problems
}

export const STATION_SITE: LabourRefusal = Object.freeze({
  code: 'STATION_SITE',
  message: 'This site records stations, not people: there is no personal list.',
  fix: 'Per-person sheets and disputes exist only where the site records workers (Production › Settings).',
})
export const NOT_YOURS: LabourRefusal = Object.freeze({ code: 'NOT_YOURS', message: 'This record is not yours: you dispute only your own records.', fix: 'Pick one of your own records.' })
export const NOT_DISPUTABLE: LabourRefusal = Object.freeze({ code: 'NOT_DISPUTABLE', message: 'This entry cannot be disputed: an undone scan or a block still running counts nothing yet.', fix: 'End the block first, or dispute the report itself.' })
export const DISPUTE_NOT_OPEN: LabourRefusal = Object.freeze({ code: 'DISPUTE_NOT_OPEN', message: 'This dispute is answered or withdrawn already.', fix: 'Raise a new dispute if something is still wrong.' })
export const OWN_DISPUTE: LabourRefusal = Object.freeze({ code: 'OWN_DISPUTE', message: 'You raised this dispute, or it is about your own record: the team leader or HR answers it.', fix: 'Ask another person to answer it.' })
export const BLOCK_RUNNING: LabourRefusal = Object.freeze({ code: 'BLOCK_RUNNING', message: 'The block is still running: its times are corrected once it ended.', fix: 'End the block first.' })

export function dayClosedRefusal(lineCode: string, workDate: BusinessDate): LabourRefusal {
  return { code: 'DAY_CLOSED', message: `The day ${workDate} of line ${lineCode} is closed (closed days feed pay): nothing of it changes until it is reopened with a reason.`, fix: 'Reopen the day first (Labour & corrections › Line days).' }
}

// ---- the queue ------------------------------------------------------------------------------------------------------

/** The four kinds of one queue (design production.labour "To decide"). */
export const INBOX_KINDS = ['CORRECTION', 'DISPUTE', 'OFF_STANDARD', 'LINE_DAY'] as const
export type InboxKind = (typeof INBOX_KINDS)[number]
