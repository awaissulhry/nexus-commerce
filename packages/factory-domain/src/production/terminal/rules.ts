import { believedTime } from '../offstandard/rules'
import { CLIENT_SCAN_ID, operationLabel, type ScanOperation } from '../scans/rules'
import type { ScanSubject } from '../settings/monitoring'

/**
 * Operation timing on the tablet (B-W2b-40; MES-087 start, MES-088 pause with a reason, MES-089 resume, MES-091 hand back,
 * MES-092 pieces done so far, MES-094 team operation, MES-117 open work paused at clock-out; design floor.operation
 * "Start, pause, finish", floor.clock "Open work", floor.signin "Continue bundle B-000123 at Op 30?"), pure. The API
 * (apps/factory-api modules/production/terminal) says these in words before the …_floor_work_w2b_guards timing trigger
 * would refuse the same.
 *
 *   rows       the timing of a bundle at an operation is OperationScan rows (append-only), beside the count ledger
 *              (REPORT, UNDO, CORRECTION: production/scans): START, PAUSE (with a code of the PAUSE reason list), RESUME,
 *              HAND_BACK, PARTIAL (the pieces done so far). Rows of one bundle and operation are ordered by the server's
 *              time, then id; the time that counts for minutes is the tablet's when it can be believed (offline work:
 *              offstandard believedTime), else the server's.
 *   stretch    one open stretch per bundle and operation, of one subject (the worker where the site names workers, else
 *              the station): a START opens it, PAUSE and RESUME stop and go on inside it, and any other row closes it — a
 *              HAND_BACK (unfinished work given back: the time is kept, anyone may start it again), a PARTIAL (the pieces
 *              done so far: another person may continue the bundle) or the REPORT. Finishing stays ONE tap (Owner answer
 *              F3): a REPORT needs no START and ends a running stretch; it reports the whole bundle (the counts stay the
 *              REPORT's; a PARTIAL's pieces are what pay counts for the person who did them, B-W2b-43).
 *   one job    a subject runs one bundle at a time (MES-093 "several jobs at once" is a later refinement): starting or
 *              resuming another while one runs is refused in words (pause it, hand it back or finish it first).
 *   team       a team operation (MES-094) names its members on the START, RESUME, PARTIAL and REPORT (OperationScanMember,
 *              the scan's own worker included), taken from the tablet's crew (B-W2b-52): its minutes count once per
 *              member. Only where the site names workers; never at a station-only site.
 *   clock-out  a clock-out pauses the person's running work with the system's code CLOCK_OUT, at the clock-out's moment
 *              (MES-117); the next sign-in offers "Continue bundle B-000123 at Op 30?" (a RESUME).
 *
 * Minutes per operation are records of work, not a ranking (Statuto dei Lavoratori art. 4; Owner answers W1, F2, H3): no
 * function here groups, filters or totals by person; the minutes of a stretch are the stretch's, and one person's minutes
 * are read only behind the site's PERFORMANCE gate (B-W2b-27) by the steps that show them (B-W2b-45 records, -44, -68).
 * The operation screen shows no pace or target (design floor.operation "timing"): only the work in hand's own clock.
 */

export const TIMING_KINDS = ['START', 'PAUSE', 'RESUME', 'HAND_BACK', 'PARTIAL'] as const
export type TimingKind = (typeof TIMING_KINDS)[number]

export const isTimingKind = (kind: string): kind is TimingKind => (TIMING_KINDS as readonly string[]).includes(kind)

/** A bundle at an operation, as the timing sees it. */
export const TIMING_STATES = ['NOT_STARTED', 'RUNNING', 'PAUSED', 'REPORTED'] as const
export type TimingState = (typeof TIMING_STATES)[number]

/** The system's pause code at clock-out (MES-117): never on the reason picker; the database asks a code without spaces. */
export const CLOCK_OUT_PAUSE = 'CLOCK_OUT'
export const SYSTEM_PAUSE_CODES: readonly string[] = Object.freeze([CLOCK_OUT_PAUSE])

export const TERMINAL_LIMITS = Object.freeze({
  /** A team is the tablet's crew: four people at most (B-W2b-52 CREW.maxMembers). */
  maxMembers: 4,
  /** A pause's note (an "Other" reason asks one). */
  noteMax: 200,
  /** How far back the open work of a person or station is looked for (a stretch older than this is not offered). */
  openLookBackDays: 7,
})

/** The client id the clock-out's pause takes: one per clock event and stretch (no device: the system writes it). */
export const clockOutClientId = (clockEventId: string, n: number): string => `clock-out:${clockEventId}:${n}`

// ---- the rows ---------------------------------------------------------------------------------------------------------------------

/** One OperationScan row of a bundle at an operation (any kind: the count rows close a stretch too). */
export interface TimingRow {
  readonly id: string
  readonly kind: string
  readonly correctsId: string | null
  readonly goodQuantity: number
  readonly scrapQuantity: number
  readonly reworkQuantity: number
  readonly pauseReasonCode: string | null
  readonly workerId: string | null
  readonly stationId: string | null
  readonly deviceId: string | null
  readonly deviceTime: Date | null
  readonly serverTime: Date
}

/** The moment a row counts for minutes: the tablet's time when believable (not ahead, not older than half a day), else the server's. */
export const rowTime = (row: Pick<TimingRow, 'deviceTime' | 'serverTime'>): Date => believedTime(row.deviceTime, row.serverTime)

const byOrder = <Row extends Pick<TimingRow, 'id' | 'serverTime'>>(rows: readonly Row[]): Row[] =>
  [...rows].sort((a, b) => a.serverTime.getTime() - b.serverTime.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const secondsBetween = (from: Date, to: Date): number => Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000))

/** Whose a row is: the worker where the site names workers, else the station. */
export interface TimingSubject {
  readonly workerId: string | null
  readonly stationId: string | null
}

/** The same subject, by the database's rule: the worker when one is named, else the station (and no worker). */
export function sameSubject(row: TimingSubject, subject: TimingSubject): boolean {
  if (subject.workerId !== null) return row.workerId === subject.workerId
  return row.workerId === null && row.stationId !== null && row.stationId === subject.stationId
}

/** One run inside a stretch: from a START or RESUME to a PAUSE or the row that closed the stretch (null: it runs). */
export interface Run {
  readonly openedBy: string
  readonly from: Date
  readonly to: Date | null
  readonly seconds: number
  /** The people it counts for: the members its START or RESUME named (the subject alone when it named none). */
  readonly people: number
}

/** A pause inside a stretch (MES-088): its PAUSE row, the reason's code, from when, to when (null: paused now). */
export interface Pause {
  readonly scanId: string
  readonly code: string
  readonly at: Date
  readonly to: Date | null
  readonly seconds: number
}

/** A stretch of work on a bundle at an operation, from its START to the row that closed it (or still open). */
export interface Stretch {
  readonly startedBy: string
  readonly workerId: string | null
  readonly stationId: string | null
  readonly startedAt: Date
  readonly runs: readonly Run[]
  /** The pauses inside it: their scan, code, moment and how long they lasted (to the RESUME or the closing row; null: paused now). */
  readonly pauses: readonly Pause[]
  /** The row that closed it (HAND_BACK, PARTIAL, REPORT … ) or null while open. */
  readonly closedBy: { readonly scanId: string; readonly kind: string; readonly at: Date } | null
  /** Open: RUNNING (its last row is a START or RESUME) or PAUSED; closed: null. */
  readonly open: 'RUNNING' | 'PAUSED' | null
  /** Seconds worked in the closed runs (pauses left out). */
  readonly secondsClosed: number
  /** Person-seconds of the closed runs (seconds × the people each run counts for). */
  readonly personSecondsClosed: number
}

/**
 * The stretches of one bundle at one operation from its rows (any order, any kind; `members`: scan id → the workers it
 * names). A row the database would have refused (a PAUSE with nothing running …) is passed over.
 */
export function stretchesOf(rows: readonly TimingRow[], members: ReadonlyMap<string, readonly string[]> = new Map()): Stretch[] {
  const out: Stretch[] = []
  type Building = { startedBy: string; workerId: string | null; stationId: string | null; startedAt: Date; runs: Run[]; pauses: Pause[]; running: { openedBy: string; from: Date; people: number } | null }
  const endPause = (building: Building, at: Date) => {
    const last = building.pauses.at(-1)
    if (last && last.to === null) building.pauses[building.pauses.length - 1] = { ...last, to: at, seconds: secondsBetween(last.at, at) }
  }
  let current: Building | null = null
  const peopleOf = (scanId: string) => Math.max(1, members.get(scanId)?.length ?? 0)
  const finish = (building: Building, closedBy: Stretch['closedBy']): Stretch => {
    if (closedBy && !building.running) endPause(building, closedBy.at)
    const runs = building.running ? [...building.runs, { openedBy: building.running.openedBy, from: building.running.from, to: closedBy?.at ?? null, seconds: closedBy ? secondsBetween(building.running.from, closedBy.at) : 0, people: building.running.people }] : building.runs
    const closed = runs.filter((run) => run.to !== null)
    return {
      startedBy: building.startedBy,
      workerId: building.workerId,
      stationId: building.stationId,
      startedAt: building.startedAt,
      runs,
      pauses: building.pauses,
      closedBy,
      open: closedBy ? null : building.running ? 'RUNNING' : 'PAUSED',
      secondsClosed: closed.reduce((sum, run) => sum + run.seconds, 0),
      personSecondsClosed: closed.reduce((sum, run) => sum + run.seconds * run.people, 0),
    }
  }
  for (const row of byOrder(rows)) {
    const at = rowTime(row)
    if (row.kind === 'START') {
      if (current) out.push(finish(current, { scanId: row.id, kind: row.kind, at }))
      current = { startedBy: row.id, workerId: row.workerId, stationId: row.stationId, startedAt: at, runs: [], pauses: [], running: { openedBy: row.id, from: at, people: peopleOf(row.id) } }
    } else if (row.kind === 'RESUME') {
      if (current && !current.running) {
        endPause(current, at)
        current.running = { openedBy: row.id, from: at, people: peopleOf(row.id) }
      }
    } else if (row.kind === 'PAUSE') {
      if (current?.running) {
        current.runs.push({ openedBy: current.running.openedBy, from: current.running.from, to: at, seconds: secondsBetween(current.running.from, at), people: current.running.people })
        current.running = null
        current.pauses.push({ scanId: row.id, code: row.pauseReasonCode ?? '', at, to: null, seconds: 0 })
      }
    } else if (current) {
      out.push(finish(current, { scanId: row.id, kind: row.kind, at }))
      current = null
    }
  }
  if (current) out.push(finish(current, null))
  return out
}

/** The stretch still open on a bundle at an operation (running or paused), or null. */
export const openStretchOf = (stretches: readonly Stretch[]): Stretch | null => {
  const last = stretches.at(-1)
  return last && last.open !== null ? last : null
}

/** The seconds worked in a stretch so far: its closed runs, and the running one up to `now`. */
export function secondsSoFar(stretch: Stretch, now: Date): { readonly seconds: number; readonly personSeconds: number } {
  const running = stretch.runs.find((run) => run.to === null)
  const extra = running ? secondsBetween(running.from, now) : 0
  return { seconds: stretch.secondsClosed + extra, personSeconds: stretch.personSecondsClosed + extra * (running?.people ?? 1) }
}

/** Seconds as minutes with two decimals, in words of digits ("12.50"); integer arithmetic (no float kept). */
export function minutesText(seconds: number): string {
  const hundredths = Math.round((Math.max(0, Math.floor(seconds)) * 100) / 60)
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`
}

/**
 * The timed seconds a count row (a PARTIAL, a HAND_BACK or a REPORT) carries: the stretch it closed (pauses left out),
 * with its person-seconds (team members counted once each). Null when it closed no stretch (a one-tap REPORT, F3). This
 * is what B-W2b-45's labour record of a REPORT (and pay's PARTIAL) reads beside its earned minutes.
 */
export function timedOfRow(stretches: readonly Stretch[], scanId: string): { readonly seconds: number; readonly personSeconds: number; readonly runs: number; readonly pauses: number } | null {
  const stretch = stretches.find((entry) => entry.closedBy?.scanId === scanId)
  return stretch ? { seconds: stretch.secondsClosed, personSeconds: stretch.personSecondsClosed, runs: stretch.runs.length, pauses: stretch.pauses.length } : null
}

/** The pieces done so far of a bundle at an operation: the sum of its PARTIALs (never voided; the REPORT reports the bundle). */
export const piecesSoFarOf = (rows: readonly Pick<TimingRow, 'kind' | 'goodQuantity' | 'scrapQuantity' | 'reworkQuantity'>[]): number =>
  rows.filter((row) => row.kind === 'PARTIAL').reduce((sum, row) => sum + row.goodQuantity + row.scrapQuantity + row.reworkQuantity, 0)

/** A standing count row (REPORT or CORRECTION no later UNDO or CORRECTION voids): the bundle is reported at the operation. */
export function isReported(rows: readonly Pick<TimingRow, 'id' | 'kind' | 'correctsId'>[]): boolean {
  const voided = new Set(rows.flatMap((row) => (row.correctsId ? [row.correctsId] : [])))
  return rows.some((row) => (row.kind === 'REPORT' || row.kind === 'CORRECTION') && !voided.has(row.id))
}

// ---- the state a screen shows ---------------------------------------------------------------------------------------------------

export interface TimingView {
  readonly state: TimingState
  /** The open stretch is the viewer's (their own at a WORKER site, the device's station's at a STATION site). */
  readonly mine: boolean
  /** When the open stretch started (its START). */
  readonly startedAt: Date | null
  /** When the running part began (the START or the last RESUME); null when paused or not open. */
  readonly runningSince: Date | null
  /** Seconds worked in the open stretch before `runningSince` (earlier runs; a paused stretch: all of them). */
  readonly secondsBefore: number
  /** PAUSED: the code and moment of the pause. */
  readonly pausedAt: Date | null
  readonly pauseReasonCode: string | null
  /** PAUSED by the system at clock-out (MES-117): the next sign-in offers to continue. */
  readonly pausedAtClockOut: boolean
  /** The pieces done so far (the PARTIALs), and the people the running part counts for (1 alone, 2–4 a team). */
  readonly piecesSoFar: number
  readonly people: number
  /** What the viewer may do now (a REPORT is always the scans' one tap, never listed here). */
  readonly actions: readonly TimingKind[]
}

/** What a bundle at an operation shows to the viewer (any kind of rows of that bundle and operation). */
export function timingViewOf(rows: readonly TimingRow[], viewer: TimingSubject, members: ReadonlyMap<string, readonly string[]> = new Map()): TimingView {
  const stretches = stretchesOf(rows, members)
  const open = openStretchOf(stretches)
  const piecesSoFar = piecesSoFarOf(rows)
  if (!open) {
    const reported = isReported(rows)
    return { state: reported ? 'REPORTED' : 'NOT_STARTED', mine: false, startedAt: null, runningSince: null, secondsBefore: 0, pausedAt: null, pauseReasonCode: null, pausedAtClockOut: false, piecesSoFar, people: 1, actions: reported ? [] : ['START'] }
  }
  const mine = sameSubject(open, viewer)
  const running = open.runs.find((run) => run.to === null) ?? null
  const pause = open.open === 'PAUSED' ? (open.pauses.at(-1) ?? null) : null
  const actions: TimingKind[] = !mine ? [] : open.open === 'RUNNING' ? ['PAUSE', 'PARTIAL', 'HAND_BACK'] : ['RESUME', 'PARTIAL', 'HAND_BACK']
  return {
    state: open.open === 'RUNNING' ? 'RUNNING' : 'PAUSED',
    mine,
    startedAt: open.startedAt,
    runningSince: running?.from ?? null,
    secondsBefore: open.secondsClosed,
    pausedAt: pause?.at ?? null,
    pauseReasonCode: pause?.code ?? null,
    pausedAtClockOut: pause?.code === CLOCK_OUT_PAUSE,
    piecesSoFar,
    people: running?.people ?? 1,
    actions,
  }
}

// ---- refusals --------------------------------------------------------------------------------------------------------------------

export const TIMING_REFUSALS = [
  'NOT_STARTED',
  'CHOOSE_OPERATION',
  'ALREADY_RUNNING',
  'ALREADY_PAUSED',
  'PAUSED_RESUME',
  'OPEN_BY_OTHER',
  'OTHER_RUNNING',
  'NO_PIECES',
  'PIECES_TOO_MANY',
  'PAUSE_REASON_UNKNOWN',
  'PAUSE_REASON_SYSTEM',
  'NOTE_NEEDED',
  'TEAM_AT_STATION_SITE',
  'TEAM_NOT_IN_CREW',
  'TEAM_TOO_LARGE',
  'TEAM_NOTICE',
  'NOT_QUALIFIED',
  'NOT_AUTHORISED',
] as const
export type TimingRefusalCode = (typeof TIMING_REFUSALS)[number]

/** A refusal of a timing action, in words: the 409's `refusal/<CODE>` and `fix`; in the offline queue, `final` says whether a resend may pass. */
export interface TimingRefusal {
  readonly code: TimingRefusalCode
  readonly message: string
  readonly fix: string
  readonly final: boolean
}

const refusal = (code: TimingRefusalCode, message: string, fix: string, final = true): TimingRefusal => ({ code, message, fix, final })

export interface WorkPlace {
  readonly bundleCode: string
  readonly operation: Pick<ScanOperation, 'seq' | 'name'>
}

const where = (place: WorkPlace) => `bundle ${place.bundleCode} at ${operationLabel(place.operation)}`
const whereShort = (place: WorkPlace) => `${place.bundleCode} at Op ${place.operation.seq}`

/**
 * Whether the action may be taken on the bundle at the operation (its rows of any kind), for the subject; null when it
 * may. A START on a reported bundle is the scans' ALREADY_REPORTED (the API decides the operation as a report would).
 * Another person's open work is "another person" (never a name: Statuto art. 4; design floor.operation).
 */
export function timingRefusal(action: TimingKind, facts: { readonly rows: readonly TimingRow[]; readonly subject: TimingSubject; readonly place: WorkPlace; readonly scanSubject: ScanSubject }): TimingRefusal | null {
  const open = openStretchOf(stretchesOf(facts.rows))
  const mine = open !== null && sameSubject(open, facts.subject)
  const you = facts.scanSubject === 'STATION' ? 'This station' : 'You'
  const other = facts.scanSubject === 'STATION' ? 'Another station works on it' : 'Another person works on it (your team leader can see who)'
  if (action === 'START') {
    if (!open) return null
    if (!mine) return refusal('OPEN_BY_OTHER', `${other}: ${where(facts.place)} is ${open.open === 'RUNNING' ? 'running' : 'paused'}.`, 'Wait until it is handed back or pieces so far are reported, or ask your team leader.', false)
    return open.open === 'RUNNING'
      ? refusal('ALREADY_RUNNING', `${you} started ${where(facts.place)} already; it runs.`, 'Carry on: Pause, Not all good or Finish.')
      : refusal('PAUSED_RESUME', `${you} paused ${where(facts.place)}.`, 'Resume it.')
  }
  if (!open) {
    const reported = isReported(facts.rows)
    return refusal('NOT_STARTED', reported ? `${where(facts.place)} is reported already: nothing runs on it.` : `Nobody works on ${where(facts.place)} now: it is not started (or was handed back).`, reported ? 'Discard this one.' : 'Start it first.')
  }
  if (!mine) return refusal('OPEN_BY_OTHER', `${other}: only the one who started ${where(facts.place)} pauses, resumes, hands it back or reports pieces so far.`, 'Ask your team leader.')
  if (action === 'PAUSE' && open.open === 'PAUSED') return refusal('ALREADY_PAUSED', `${where(facts.place)} is paused already.`, 'Resume it, or hand it back.')
  if (action === 'RESUME' && open.open === 'RUNNING') return refusal('ALREADY_RUNNING', `${where(facts.place)} runs already.`, 'Carry on: Pause, Not all good or Finish.')
  return null
}

/**
 * The operation a pause, resume, hand back or pieces so far means when the tablet names none: the subject's open work on
 * the bundle that the action fits (PAUSE: the running one; RESUME: a paused one; the others: either). Null: decided;
 * else the refusal (nothing open of theirs on the bundle, or two that fit: the tablet picks).
 */
export function openOperationFor<Op extends Pick<ScanOperation, 'id' | 'seq' | 'name'>>(
  action: Exclude<TimingKind, 'START'>,
  open: readonly { readonly operation: Op; readonly state: 'RUNNING' | 'PAUSED' }[],
  bundleCode: string,
): { readonly ok: true; readonly operation: Op } | { readonly ok: false; readonly refusal: TimingRefusal } {
  const fits = open.filter((entry) => (action === 'PAUSE' ? entry.state === 'RUNNING' : action === 'RESUME' ? entry.state === 'PAUSED' : true))
  if (fits.length === 1) return { ok: true, operation: fits[0]!.operation }
  if (fits.length > 1) return { ok: false, refusal: refusal('CHOOSE_OPERATION', `${fits.map((entry) => operationLabel(entry.operation)).join(' · ')} of bundle ${bundleCode} are open.`, 'Pick the operation.') }
  if (open.length > 0) {
    const entry = open[0]!
    return { ok: false, refusal: action === 'PAUSE' ? refusal('ALREADY_PAUSED', `Bundle ${bundleCode} at ${operationLabel(entry.operation)} is paused already.`, 'Resume it, or hand it back.') : refusal('ALREADY_RUNNING', `Bundle ${bundleCode} at ${operationLabel(entry.operation)} runs already.`, 'Carry on: Pause, Not all good or Finish.') }
  }
  return { ok: false, refusal: refusal('NOT_STARTED', `You have no open work on bundle ${bundleCode}: it is not started, or was handed back.`, 'Start it first.') }
}

/** Starting or resuming while the subject runs another bundle (one job at a time; MES-093 is later). */
export const otherRunningRefusal = (running: WorkPlace, scanSubject: ScanSubject): TimingRefusal =>
  refusal(
    'OTHER_RUNNING',
    `${scanSubject === 'STATION' ? 'This station' : 'You'} ${scanSubject === 'STATION' ? 'runs' : 'run'} ${where(running)}: one bundle at a time.`,
    `Pause ${whereShort(running)}, hand it back or finish it first.`,
    false,
  )

/** The pieces done so far (MES-092): from 1, and with the earlier ones fewer than the bundle's garments (the REPORT reports the bundle). */
export function piecesRefusal(pieces: number, facts: { readonly earlier: number; readonly bundleQuantity: number; readonly place: WorkPlace }): TimingRefusal | null {
  if (!Number.isInteger(pieces) || pieces < 1) return refusal('NO_PIECES', 'Pieces so far start from 1.', 'Count the pieces you finished.')
  const left = facts.bundleQuantity - 1 - facts.earlier
  if (pieces > left) {
    const before = facts.earlier > 0 ? ` (${facts.earlier} reported so far)` : ''
    return refusal(
      'PIECES_TOO_MANY',
      left < 1 ? `${where(facts.place)} carries ${facts.bundleQuantity}${before}: no more pieces so far fit.` : `${where(facts.place)} carries ${facts.bundleQuantity}${before}: at most ${left} more pieces so far.`,
      'When the whole bundle is done, finish it instead.',
    )
  }
  return null
}

/** A pause reason: an active code of the tenant's PAUSE list (not the system's own), with a note when the code asks one. */
export function pauseReasonRefusal(code: string, fact: { readonly active: boolean; readonly needsDetail: boolean } | null, note: string | null): TimingRefusal | null {
  if (SYSTEM_PAUSE_CODES.includes(code)) return refusal('PAUSE_REASON_SYSTEM', `${code} is the system's own pause (at clock-out); it is not picked on the tablet.`, 'Pick one of the pause reasons.')
  if (!fact || !fact.active) return refusal('PAUSE_REASON_UNKNOWN', `${code} is not one of the pause reasons in use.`, 'Pick one of the pause reasons on the screen.')
  if (fact.needsDetail && !note) return refusal('NOTE_NEEDED', 'This pause reason asks a few words.', 'Say why in a few words.')
  return null
}

export interface TeamFacts {
  readonly scanSubject: ScanSubject
  /** The workers asked as members (the one who starts is added when missing). */
  readonly asked: readonly string[]
  /** The workers in the tablet's open crew now (none: no crew). */
  readonly crew: readonly string[]
  /** The asked workers who acknowledged the worker notice in force. */
  readonly acknowledged: ReadonlySet<string>
}

/**
 * A team's members (MES-094): the tablet's crew members asked (B-W2b-52), at most four, each having acknowledged the
 * worker notice (no record names a worker before that: Statuto art. 4 c.3); never at a site that records the station only.
 */
export function teamRefusal(facts: TeamFacts): TimingRefusal | null {
  if (facts.asked.length === 0) return null
  if (facts.scanSubject === 'STATION') return refusal('TEAM_AT_STATION_SITE', 'This site records the station, not the people: a team names its members, so it is not recorded here.', 'Start it without a team.')
  if (facts.asked.length > TERMINAL_LIMITS.maxMembers) return refusal('TEAM_TOO_LARGE', `A team is at most ${TERMINAL_LIMITS.maxMembers} people.`, 'Name fewer people.')
  if (facts.asked.some((workerId) => !facts.crew.includes(workerId))) return refusal('TEAM_NOT_IN_CREW', 'A team is the people of this tablet’s crew: someone named is not in it now.', 'Add them to the crew on this tablet first, or leave them out.', false)
  if (facts.asked.some((workerId) => !facts.acknowledged.has(workerId))) return refusal('TEAM_NOTICE', 'Someone in the team has not acknowledged the information notice in force (L. 300/1970 art. 4 c.3; GDPR art. 13).', 'They read and acknowledge the notice on this tablet first, or leave them out.', false)
  return null
}

/** The members a team START or RESUME names: the asked ones and the one who starts, each once, in the order asked. */
export const teamMembers = (asked: readonly string[], actorId: string): string[] => (asked.length === 0 ? [] : [...new Set([actorId, ...asked])])

// ---- qualification (B-W2b-39's check at the start) --------------------------------------------------------------------------------

/** The qualification check's hold at a START (people/skills qualificationGuard STRICT): a skill hold is overridable by a team leader, an authorisation never. */
export function qualificationRefusal(guard: { readonly mode: 'WARN' | 'STRICT'; readonly overridable: boolean; readonly message: string; readonly fix: string }): TimingRefusal | null {
  if (guard.mode !== 'STRICT') return null
  return guard.overridable
    ? refusal('NOT_QUALIFIED', guard.message, `${guard.fix} A team leader may override it with their PIN and a reason.`.trim(), false)
    : refusal('NOT_AUTHORISED', guard.message, guard.fix, false)
}

// ---- words -----------------------------------------------------------------------------------------------------------------------

/** "B-000123 at Op 30 paused." (design floor.clock "Open work"). */
export const pausedWords = (place: WorkPlace): string => `${whereShort(place)} paused.`
/** "Continue bundle B-000123 at Op 30?" (design floor.signin after an auto-pause). */
export const continueWords = (place: WorkPlace): string => `Continue bundle ${whereShort(place)}?`
/** "Your open bundle B-000123 will be paused." (design floor.clock pop-up "Clock out?"). */
export const clockOutWarning = (places: readonly WorkPlace[]): string | null =>
  places.length === 0 ? null : places.length === 1 ? `Your open bundle ${places[0]!.bundleCode} will be paused.` : `Your ${places.length} open bundles (${places.map((place) => place.bundleCode).join(', ')}) will be paused.`

/** What a timing action did, in words for the tablet's receipt. */
export function doneWords(kind: TimingKind, place: WorkPlace, pieces = 0): string {
  switch (kind) {
    case 'START':
      return `Started ${whereShort(place)}.`
    case 'PAUSE':
      return pausedWords(place)
    case 'RESUME':
      return `${whereShort(place)} goes on.`
    case 'HAND_BACK':
      return `${whereShort(place)} handed back: the time is kept; anyone may start it again.`
    case 'PARTIAL':
      return `${pieces} piece${pieces === 1 ? '' : 's'} so far on ${whereShort(place)}: another person may continue it.`
  }
}

/** A device's id for one timing action (the scans' rule: 8 to 64 letters, digits, dots, colons, underscores or hyphens). */
export const TIMING_CLIENT_ID = CLIENT_SCAN_ID
