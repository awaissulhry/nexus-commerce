import type { Issue } from '../core/errors'
import { BUSINESS_TIME_ZONE, businessDate, businessDayStart } from '../core/time'

/**
 * The plant: machines, the requests a station sends when one breaks down, and the maintenance jobs (B-W2a-35; QHS-162,
 * QHS-178, QHS-184; Owner answer H1; D.Lgs. 81/2008 art. 71; design plant.machines, plant.requests, plant.jobs,
 * floor.machine). Pure: the API (apps/factory-api modules/plant) reads the facts inside its command and writes the rows;
 * the …_quality_plant_w2a_guards triggers stay the last word for every login.
 *
 *   machine    registered RUNNING with its class and place (site, station, work centre); its asset number is on its QR
 *              tag and never changes. Its status moves with the work: a report marks it DOWN (the line stopped) or
 *              DO_NOT_USE (unsafe, at once); a job that starts puts it UNDER_MAINTENANCE (a locked machine stays
 *              DO_NOT_USE); a hand-back gives it back RUNNING, DO_NOT_USE or (the office's) RETIRED. Retired for good,
 *              never deleted.
 *   request    a report from a station or the office: the symptom (for the machine's class or every class), the words,
 *              down or not, unsafe or not. Unsafe (the symptom says so, or the reporter does: H1 "anyone at the
 *              station") locks the machine: DO_NOT_USE in the same transaction, until a technician signs the request
 *              safe. Triage: NEW → ACKNOWLEDGED → JOB_MADE (a new job, or an open job of the machine) | MERGED (into
 *              another open request of the machine) | CLOSED (with the reason); an unsafe request not signed safe is
 *              never merged nor closed.
 *   job        numbered from the company's MAINTENANCE_JOB series; NEW → PLANNED → IN_PROGRESS ⇄ WAITING_PARTS →
 *              HANDED_BACK → CLOSED, or CANCELLED with the reason. The technician (an office user or a floor worker of the
 *              site) starts, pauses for parts, hands back and takes the work back; the office plans, assigns, closes and
 *              cancels. Handed back RUNNING only once no unsafe request of the machine waits for its sign-safe.
 *
 * Statuto dei Lavoratori art. 4 (Owner answers W1, F2): no figure here is per person; a request names its reporter and a
 * job its technician only inside the one record, never in a list, a filter, a group or a total.
 */

export const MACHINE_STATUSES = ['RUNNING', 'DOWN', 'UNDER_MAINTENANCE', 'DO_NOT_USE', 'RETIRED'] as const
export type MachineStatus = (typeof MACHINE_STATUSES)[number]

export const REQUEST_STATUSES = ['NEW', 'ACKNOWLEDGED', 'JOB_MADE', 'MERGED', 'CLOSED'] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]
/** Requests still waiting for maintenance. */
export const OPEN_REQUEST_STATUSES = ['NEW', 'ACKNOWLEDGED'] as const satisfies readonly RequestStatus[]

export const CLOSE_REASONS = ['SOLVED_BY_OPERATOR', 'NOT_A_FAULT', 'DUPLICATE', 'OTHER'] as const
export type CloseReason = (typeof CLOSE_REASONS)[number]

export const JOB_TYPES = ['CORRECTIVE', 'PREVENTIVE', 'INSPECTION', 'IMPROVEMENT', 'SAFETY'] as const
export type JobType = (typeof JOB_TYPES)[number]

export const JOB_SOURCES = ['REQUEST', 'PM_PLAN', 'STATUTORY_CHECK', 'INCIDENT', 'MANUAL'] as const
export type JobSource = (typeof JOB_SOURCES)[number]
/** What a job made by hand may name as its source (plans and incidents come with their pages, W2b). */
export const MANUAL_JOB_SOURCES = ['MANUAL', 'STATUTORY_CHECK'] as const satisfies readonly JobSource[]

export const PRIORITIES = ['P1', 'P2', 'P3'] as const
export type Priority = (typeof PRIORITIES)[number]

export const JOB_STATUSES = ['NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_PARTS', 'HANDED_BACK', 'CLOSED', 'CANCELLED'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]
/** Jobs not closed nor cancelled. */
export const OPEN_JOB_STATUSES = ['NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_PARTS', 'HANDED_BACK'] as const satisfies readonly JobStatus[]
/** Jobs the technician has started and not handed back. */
export const STARTED_JOB_STATUSES = ['IN_PROGRESS', 'WAITING_PARTS'] as const satisfies readonly JobStatus[]

/** The machine's state after a hand-back. */
export const MACHINE_AFTER = ['RUNNING', 'DO_NOT_USE', 'RETIRED'] as const
export type MachineAfter = (typeof MACHINE_AFTER)[number]
/** The machine's state after a sign-safe. */
export const SAFE_AFTER = ['RUNNING', 'UNDER_MAINTENANCE'] as const
export type SafeAfter = (typeof SAFE_AFTER)[number]

const includes = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value)
export const isOpenRequest = (status: string): boolean => includes(OPEN_REQUEST_STATUSES, status)
export const isOpenJob = (status: string): boolean => includes(OPEN_JOB_STATUSES, status)

// ---- codes, words, limits -------------------------------------------------------------------------------------------

/** A class or symptom code (the guard: no spaces): upper-case letters, digits and underscores, 2-40, from a letter. */
export const PLANT_CODE = /^[A-Z][A-Z0-9_]{1,39}$/
/** An asset number as printed on the tag (the guard: no spaces): letters, digits, dot, slash, hyphen, underscore; 1-40. */
export const ASSET_NUMBER = /^[A-Z0-9][A-Z0-9._/-]{0,39}$/
/** A design-system icon id (the guard's pattern). */
export const PLANT_ICON = /^[a-z][a-z0-9-]{0,39}$/
/** A swatch, #RRGGBB (stored in lower case). */
export const PLANT_COLOUR = /^#[0-9a-fA-F]{6}$/
const LANGUAGE = /^[a-z]{2,3}$/

export const PLANT_LIMITS = Object.freeze({ label: 80, languages: 12, classes: 100, symptoms: 300, text: 2000, short: 120, note: 500 })

/** An asset number as typed or scanned: trimmed, upper case (the tag prints it so). */
export const normalAssetNumber = (value: string): string => value.trim().toUpperCase()

export interface PlantWordsDraft {
  readonly labelIt?: string | undefined
  readonly labelEn?: string | undefined
  /** Other languages; null takes one out. */
  readonly labelI18n?: Readonly<Record<string, string | null>> | undefined
  readonly icon?: string | null | undefined
  readonly colour?: string | null | undefined
}

/** Words, icon and colour of a class or symptom (only the fields present are checked); paths without `body/`. */
export function plantWordsProblems(draft: PlantWordsDraft, what: 'machine class' | 'symptom'): Issue[] {
  const problems: Issue[] = []
  for (const field of ['labelIt', 'labelEn'] as const) {
    const value = draft[field]
    if (value !== undefined && value.trim() === '') problems.push({ path: field, message: field === 'labelIt' ? `Name the ${what} in Italian.` : `Name the ${what} in English.` })
    else if (value !== undefined && value.trim().length > PLANT_LIMITS.label) problems.push({ path: field, message: `At most ${PLANT_LIMITS.label} characters.` })
  }
  const entries = Object.entries(draft.labelI18n ?? {})
  if (entries.length > PLANT_LIMITS.languages) problems.push({ path: 'labelI18n', message: `At most ${PLANT_LIMITS.languages} other languages.` })
  for (const [language, words] of entries) {
    if (!LANGUAGE.test(language) || language === 'it' || language === 'en') problems.push({ path: `labelI18n/${language}`, message: 'A language is its ISO 639 code (ro, ur, zh); Italian and English have their own words.' })
    else if (words !== null && words.trim() === '') problems.push({ path: `labelI18n/${language}`, message: 'Leave a language out instead of blank words.' })
    else if (words !== null && words.trim().length > PLANT_LIMITS.label) problems.push({ path: `labelI18n/${language}`, message: `At most ${PLANT_LIMITS.label} characters.` })
  }
  if (draft.icon !== undefined && draft.icon !== null && !PLANT_ICON.test(draft.icon)) problems.push({ path: 'icon', message: 'An icon is the id of a design-system icon (lower case, digits and hyphens).' })
  if (draft.colour !== undefined && draft.colour !== null && !PLANT_COLOUR.test(draft.colour)) problems.push({ path: 'colour', message: 'A colour is a swatch written #RRGGBB.' })
  return problems
}

/** A new code (class or symptom). */
export function codeProblems(code: string | undefined): Issue[] {
  return code === undefined || !PLANT_CODE.test(code) ? [{ path: 'code', message: 'A code is 2 to 40 upper-case letters, digits and underscores, starting with a letter (THREAD_BREAKS).' }] : []
}

/** Other languages after a change (null takes a language out), sorted by language. */
export function mergedWords(current: Readonly<Record<string, string>>, change: Readonly<Record<string, string | null>> | undefined): Record<string, string> {
  const next: Record<string, string> = { ...current }
  for (const [language, words] of Object.entries(change ?? {})) {
    if (words === null) delete next[language]
    else next[language] = words.trim()
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)))
}

// ---- machines -------------------------------------------------------------------------------------------------------

export interface MachineDraft {
  readonly assetNumber?: string | undefined
  readonly make?: string | null | undefined
  readonly modelName?: string | null | undefined
  readonly serialNumber?: string | null | undefined
  readonly year?: number | null | undefined
  readonly purchaseCost?: number | null | undefined
  readonly note?: string | null | undefined
}

/** A new machine or a change (only the fields present are checked); paths without `body/`. */
export function machineDraftProblems(draft: MachineDraft, creating: boolean): Issue[] {
  const problems: Issue[] = []
  if (creating && (draft.assetNumber === undefined || !ASSET_NUMBER.test(normalAssetNumber(draft.assetNumber)))) {
    problems.push({ path: 'assetNumber', message: 'An asset number is 1 to 40 letters, digits, dots, slashes, hyphens and underscores, without spaces (it is printed on the QR tag).' })
  }
  for (const field of ['make', 'modelName', 'serialNumber'] as const) {
    const value = draft[field]
    if (typeof value === 'string' && value.trim().length > PLANT_LIMITS.short) problems.push({ path: field, message: `At most ${PLANT_LIMITS.short} characters.` })
  }
  if (draft.year !== undefined && draft.year !== null && (!Number.isInteger(draft.year) || draft.year < 1900 || draft.year > 2100)) problems.push({ path: 'year', message: 'The year it was built, from 1900 to 2100.' })
  if (draft.purchaseCost !== undefined && draft.purchaseCost !== null && (!Number.isInteger(draft.purchaseCost) || draft.purchaseCost < 0)) problems.push({ path: 'purchaseCost', message: 'The cost in minor units, from 0.' })
  if (typeof draft.note === 'string' && draft.note.trim().length > PLANT_LIMITS.note) problems.push({ path: 'note', message: `At most ${PLANT_LIMITS.note} characters.` })
  return problems
}

// ---- refusals ---------------------------------------------------------------------------------------------------------

export const PLANT_REFUSALS = [
  'RETIRED',
  'CLASS_INACTIVE',
  'SYMPTOM_INACTIVE',
  'SYMPTOM_OTHER_CLASS',
  'DETAIL_NEEDED',
  'NO_REPORTER',
  'ALREADY_TRIAGED',
  'LOCKED_UNSAFE',
  'NOT_UNSAFE',
  'SIGNED_ALREADY',
  'MERGE_SELF',
  'MERGE_OTHER_MACHINE',
  'MERGE_TARGET_DONE',
  'JOB_OTHER_MACHINE',
  'JOB_DONE',
  'MOVE_NOT_ALLOWED',
  'NOT_YOUR_JOB',
  'OPEN_WORK',
] as const
export type PlantRefusalCode = (typeof PLANT_REFUSALS)[number]

export interface PlantRefusal {
  readonly code: PlantRefusalCode
  /** What happened and why, in words (never a worker's name). */
  readonly message: string
  /** The one thing to do about it. */
  readonly fix: string
}

const refusal = (code: PlantRefusalCode, message: string, fix: string): PlantRefusal => ({ code, message, fix })

const LOCK_FIX = 'A technician checks the machine and signs it safe first (Owner answer H1; D.Lgs. 81/2008 art. 71).'

/** A machine locked as unsafe: what the lock blocks, in words. */
export const lockedWords = (assetNumber: string, what: string): PlantRefusal =>
  refusal('LOCKED_UNSAFE', `Machine ${assetNumber} was marked unsafe and no technician has signed it safe yet: ${what}.`, LOCK_FIX)

// ---- a report from the station (QHS-178, H1) -------------------------------------------------------------------------

export interface ReportFacts {
  readonly machine: { readonly assetNumber: string; readonly status: MachineStatus; readonly classId: string }
  /** The symptom named, as read (null: none named; undefined: named but not found). */
  readonly symptom: { readonly classId: string | null; readonly active: boolean; readonly unsafe: boolean; readonly needsDetail: boolean } | null | undefined
  readonly description: string | null
}

/** Why a report is refused, or null. A missing symptom is the caller's 400. */
export function reportRefusal(facts: ReportFacts): PlantRefusal | null {
  const { machine, symptom } = facts
  if (machine.status === 'RETIRED') return refusal('RETIRED', `Machine ${machine.assetNumber} is retired: its tag no longer reports problems.`, 'Scan the machine that stands at the station now, or ask the office to register it.')
  if (symptom && !symptom.active) return refusal('SYMPTOM_INACTIVE', 'This symptom is no longer offered.', 'Pick another symptom, or "Other" with a note.')
  if (symptom && symptom.classId !== null && symptom.classId !== machine.classId) return refusal('SYMPTOM_OTHER_CLASS', `This symptom is for another kind of machine than ${machine.assetNumber}.`, 'Pick a symptom shown for this machine.')
  if (symptom?.needsDetail && !facts.description) return refusal('DETAIL_NEEDED', 'This symptom needs a few words about what is wrong.', 'Write what you see or hear, then send.')
  if (!symptom && !facts.description) return refusal('DETAIL_NEEDED', 'Say what is wrong: pick a symptom or write a few words.', 'Pick a symptom, or write what you see or hear.')
  return null
}

/** Whether the report locks the machine (H1): the symptom says so, or the reporter does. */
export const isUnsafeReport = (input: { readonly symptomUnsafe: boolean; readonly markedUnsafe: boolean }): boolean => input.symptomUnsafe || input.markedUnsafe

/**
 * The machine's status after a report, or null when it stays: unsafe → DO_NOT_USE at once (from anything but RETIRED);
 * down → DOWN from RUNNING (a machine under maintenance or locked stays as it is).
 */
export function statusAfterReport(input: { readonly status: MachineStatus; readonly unsafe: boolean; readonly down: boolean }): MachineStatus | null {
  if (input.status === 'RETIRED') return null
  if (input.unsafe) return input.status === 'DO_NOT_USE' ? null : 'DO_NOT_USE'
  if (input.down && input.status === 'RUNNING') return 'DOWN'
  return null
}

/** The reason a locked machine shows (Machine.statusReason; required for DO_NOT_USE). */
export const unsafeReason = (symptomWords: string | null, at: string): string => `Marked unsafe${symptomWords ? `: ${symptomWords}` : ''} (reported ${at}); do not use it until a technician signs it safe.`.slice(0, PLANT_LIMITS.note)

/** The priority a job of a request starts with (design make-job): P1 when unsafe or the line stopped, else P2. */
export const defaultPriority = (input: { readonly unsafe: boolean; readonly down: boolean }): Priority => (input.unsafe || input.down ? 'P1' : 'P2')

/** The type a job of a request starts with: SAFETY for an unsafe one, else CORRECTIVE. */
export const defaultJobType = (unsafe: boolean): JobType => (unsafe ? 'SAFETY' : 'CORRECTIVE')

/** A job's problem from a request: the symptom's words and the reporter's. */
export function problemOf(symptomWords: string | null, description: string | null): string {
  const parts = [symptomWords, description?.trim() || null].filter((part): part is string => part !== null && part !== '')
  return (parts.length > 0 ? parts.join(': ') : 'Machine problem reported from the station.').slice(0, PLANT_LIMITS.text)
}

export type ScanSubjectKind = 'WORKER' | 'STATION'

/**
 * Who a floor report names (Statuto art. 4; MES-278): at a WORKER site the signed-in worker once they acknowledged the
 * notice, with the station; otherwise the station only (the device's, else the machine's). A report is never refused for
 * the privacy set-up (a safety report goes through at once): with neither a namable worker nor a station it is refused
 * in words.
 */
export function floorReporter(input: {
  readonly scanSubject: ScanSubjectKind
  readonly workerId: string | null
  readonly workerAcknowledged: boolean
  readonly deviceStationId: string | null
  readonly machineStationId: string | null
}): { readonly ok: true; readonly reportedByWorkerId: string | null; readonly stationId: string | null } | { readonly ok: false; readonly refusal: PlantRefusal } {
  const stationId = input.deviceStationId ?? input.machineStationId
  const worker = input.scanSubject === 'WORKER' && input.workerId && input.workerAcknowledged ? input.workerId : null
  if (worker === null && stationId === null) {
    return { ok: false, refusal: refusal('NO_REPORTER', 'This tablet has no station and the machine stands at none, so the report cannot say where it came from.', 'An administrator gives the tablet a station (Admin › Devices), or the office gives the machine its station; report from the office meanwhile.') }
  }
  return { ok: true, reportedByWorkerId: worker, stationId }
}

// ---- triage -------------------------------------------------------------------------------------------------------------

export type RequestMove = 'acknowledge' | 'job' | 'merge' | 'close'

export interface TriageFacts {
  readonly request: { readonly status: RequestStatus; readonly unsafe: boolean; readonly signedSafe: boolean }
  readonly assetNumber: string
}

/** Why a triage move is refused, or null. */
export function triageRefusal(facts: TriageFacts, move: RequestMove): PlantRefusal | null {
  const { request } = facts
  if (!isOpenRequest(request.status)) return refusal('ALREADY_TRIAGED', `This request is already ${request.status === 'JOB_MADE' ? 'in a job' : request.status === 'MERGED' ? 'merged into another' : 'closed'}.`, 'Read it again.')
  if (move === 'acknowledge' && request.status === 'ACKNOWLEDGED') return refusal('ALREADY_TRIAGED', 'This request is already acknowledged.', 'Make a job of it, or close it.')
  if ((move === 'merge' || move === 'close') && request.unsafe && !request.signedSafe) return lockedWords(facts.assetNumber, `its request is ${move === 'merge' ? 'merged' : 'closed'} only after that`)
  return null
}

/** Why a merge into another request is refused, or null. */
export function mergeTargetRefusal(input: { readonly requestId: string; readonly machineId: string; readonly target: { readonly id: string; readonly machineId: string; readonly status: RequestStatus } }): PlantRefusal | null {
  if (input.target.id === input.requestId) return refusal('MERGE_SELF', 'A request is not merged into itself.', 'Pick the other request of the machine.')
  if (input.target.machineId !== input.machineId) return refusal('MERGE_OTHER_MACHINE', 'The two requests are about different machines.', 'Merge only requests of the same machine.')
  if (input.target.status === 'MERGED' || input.target.status === 'CLOSED') return refusal('MERGE_TARGET_DONE', 'The request to merge into is merged or closed itself.', 'Merge into the request that is still open, or into its job.')
  return null
}

/** Why adding a request to an existing job is refused, or null. */
export function joinJobRefusal(input: { readonly machineId: string; readonly job: { readonly machineId: string; readonly status: JobStatus; readonly number: string } }): PlantRefusal | null {
  if (input.job.machineId !== input.machineId) return refusal('JOB_OTHER_MACHINE', `Job ${input.job.number} is about another machine.`, 'Add the request to a job of the same machine, or make a new job.')
  if (!isOpenJob(input.job.status)) return refusal('JOB_DONE', `Job ${input.job.number} is ${input.job.status === 'CLOSED' ? 'closed' : 'cancelled'}.`, 'Make a new job.')
  return null
}

/** Why a sign-safe is refused, or null. */
export function signSafeRefusal(request: { readonly unsafe: boolean; readonly signedSafe: boolean }): PlantRefusal | null {
  if (!request.unsafe) return refusal('NOT_UNSAFE', 'This request did not mark the machine unsafe: there is nothing to sign safe.', 'Make a job of it, or close it.')
  if (request.signedSafe) return refusal('SIGNED_ALREADY', 'This request was signed safe already.', 'Read it again.')
  return null
}

/** The machine's status after the last lock is signed safe: the signer's, else under maintenance while a job is started. */
export const statusAfterSignSafe = (input: { readonly asked: SafeAfter | undefined; readonly startedJob: boolean }): SafeAfter => input.asked ?? (input.startedJob ? 'UNDER_MAINTENANCE' : 'RUNNING')

// ---- jobs (QHS-184) ---------------------------------------------------------------------------------------------------

export const JOB_MOVES = ['plan', 'start', 'wait', 'handBack', 'reopen', 'close', 'cancel'] as const
export type JobMove = (typeof JOB_MOVES)[number]

/** What each move does: the statuses it starts from, where it goes, and who makes it (the technician or the office). */
export const JOB_MOVE_RULES: Readonly<Record<JobMove, { readonly from: readonly JobStatus[]; readonly to: JobStatus; readonly by: 'technician' | 'office' }>> = Object.freeze({
  plan: { from: ['NEW'], to: 'PLANNED', by: 'office' },
  start: { from: ['NEW', 'PLANNED', 'WAITING_PARTS'], to: 'IN_PROGRESS', by: 'technician' },
  wait: { from: ['IN_PROGRESS'], to: 'WAITING_PARTS', by: 'technician' },
  handBack: { from: ['IN_PROGRESS'], to: 'HANDED_BACK', by: 'technician' },
  reopen: { from: ['HANDED_BACK'], to: 'IN_PROGRESS', by: 'technician' },
  close: { from: ['HANDED_BACK'], to: 'CLOSED', by: 'office' },
  cancel: { from: ['NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_PARTS'], to: 'CANCELLED', by: 'office' },
})

const MOVE_WORDS: Readonly<Record<JobMove, string>> = Object.freeze({
  plan: 'planned',
  start: 'started',
  wait: 'put to wait for parts',
  handBack: 'handed back',
  reopen: 'taken back to work',
  close: 'closed',
  cancel: 'cancelled',
})

/** Whose job it is, as the technician sees it (no name: Statuto art. 4). */
export type JobOwnership = 'MINE' | 'NOBODY' | 'OTHER'

export interface JobMoveFacts {
  readonly job: { readonly number: string; readonly status: JobStatus }
  readonly machine: { readonly assetNumber: string; readonly status: MachineStatus; readonly locked: boolean }
  /** The caller is the floor (a floor technician may work only jobs given to them or to nobody). */
  readonly floor: boolean
  readonly ownership: JobOwnership
  /** handBack: the machine's state after. */
  readonly machineAfter?: MachineAfter | undefined
}

/** Why a job move is refused, or null. */
export function jobMoveRefusal(facts: JobMoveFacts, move: JobMove): PlantRefusal | null {
  const rule = JOB_MOVE_RULES[move]
  const { job, machine } = facts
  if (!rule.from.includes(job.status)) {
    return refusal('MOVE_NOT_ALLOWED', `Job ${job.number} is ${job.status.toLowerCase().replace('_', ' ')}: it cannot be ${MOVE_WORDS[move]} now.`, 'Read it again.')
  }
  if (facts.floor && rule.by === 'technician' && facts.ownership === 'OTHER') {
    return refusal('NOT_YOUR_JOB', `Job ${job.number} is given to another technician.`, 'Work the jobs given to you or to nobody; the office reassigns it.')
  }
  if (move === 'start' && machine.status === 'RETIRED') return refusal('RETIRED', `Machine ${machine.assetNumber} is retired.`, 'Cancel the job.')
  if (move === 'handBack' && facts.machineAfter === 'RUNNING' && machine.locked) return lockedWords(machine.assetNumber, 'it is handed back running only after that')
  return null
}

/**
 * The machine's status after a job move, or null when it stays:
 *   start / reopen   UNDER_MAINTENANCE (a DO_NOT_USE machine — locked, or so handed back — and a retired one stay)
 *   handBack         the state after; the floor never retires (RETIRED from the floor leaves it DO_NOT_USE until the office
 *                    closes the job)
 *   close            RETIRED when the hand-back said so
 *   cancel           DOWN when it was under maintenance and no other job of it is started
 */
export function statusAfterJobMove(input: {
  readonly move: JobMove
  readonly status: MachineStatus
  readonly machineAfter?: MachineAfter | null | undefined
  readonly floor: boolean
  readonly otherStartedJob: boolean
}): MachineStatus | null {
  const { status } = input
  if (status === 'RETIRED') return null
  switch (input.move) {
    case 'start':
    case 'reopen':
      return status === 'DO_NOT_USE' || status === 'UNDER_MAINTENANCE' ? null : 'UNDER_MAINTENANCE'
    case 'handBack': {
      const after: MachineStatus = input.machineAfter === 'RETIRED' && input.floor ? 'DO_NOT_USE' : (input.machineAfter ?? 'RUNNING')
      return after === status ? null : after
    }
    case 'close':
      return input.machineAfter === 'RETIRED' ? 'RETIRED' : null
    case 'cancel':
      return status === 'UNDER_MAINTENANCE' && !input.otherStartedJob ? 'DOWN' : null
    default:
      return null
  }
}

/** The reason a DO_NOT_USE machine shows after a hand-back. */
export const handBackReason = (number: string, machineAfter: MachineAfter, workDone: string): string =>
  (machineAfter === 'RETIRED' ? `To be retired (job ${number}): ${workDone}` : `Handed back as do-not-use (job ${number}): ${workDone}`).slice(0, PLANT_LIMITS.note)

/** Why a machine cannot be retired (by hand), or null. */
export function retireRefusal(input: { readonly assetNumber: string; readonly status: MachineStatus; readonly openRequests: number; readonly openJobs: number }): PlantRefusal | null {
  if (input.status === 'RETIRED') return refusal('RETIRED', `Machine ${input.assetNumber} is retired already.`, 'Read it again.')
  if (input.openRequests > 0 || input.openJobs > 0) {
    return refusal('OPEN_WORK', `Machine ${input.assetNumber} still has ${input.openRequests} open request(s) and ${input.openJobs} open job(s).`, 'Close or cancel them first, or hand the machine back as retired from its job.')
  }
  return null
}

// ---- the station (H1: a locked machine says so in words) ---------------------------------------------------------------

/**
 * What the station's tablet says about its machines (the floor's banner) and whether its work is blocked: blocked when
 * the station has machines and none of them is usable (every one locked or set do-not-use). The scans module's hook
 * refuses a scan at a blocked station with these words (modules/plant/checks.ts stationBlock).
 */
export function stationWords(machines: readonly { readonly assetNumber: string; readonly status: MachineStatus; readonly locked: boolean }[]): { readonly blocked: boolean; readonly message: string | null; readonly fix: string | null } {
  const live = machines.filter((machine) => machine.status !== 'RETIRED')
  const stopped = live.filter((machine) => machine.status === 'DO_NOT_USE')
  if (stopped.length === 0) return { blocked: false, message: null, fix: null }
  const names = stopped.map((machine) => machine.assetNumber).join(', ')
  const locked = stopped.some((machine) => machine.locked)
  const message = `${stopped.length === 1 ? 'Machine' : 'Machines'} ${names} ${stopped.length === 1 ? 'is' : 'are'} marked do not use${locked ? ' (unsafe)' : ''}: do not work on ${stopped.length === 1 ? 'it' : 'them'}.`
  return { blocked: stopped.length === live.length, message, fix: locked ? LOCK_FIX : 'Ask maintenance: the office set it do-not-use.' }
}

// ---- lists ------------------------------------------------------------------------------------------------------------

/** The machine requests' tiles (design plant.requests tiles). */
export const REQUEST_TILES = ['NEW', 'UNSAFE', 'DOWN', 'WAITING', 'DUPLICATES'] as const
export type RequestTile = (typeof REQUEST_TILES)[number]
/** "Waiting technician over 30 min". */
export const WAITING_MINUTES = 30

/** The maintenance jobs' tiles (design plant.jobs tiles). */
export const JOB_TILES = ['OPEN', 'OVERDUE', 'UNSAFE', 'WAITING_PARTS', 'CLOSED_THIS_WEEK'] as const
export type JobTile = (typeof JOB_TILES)[number]

/** The machines' tiles (design plant.machines tiles; checks overdue and CE on file come with W2b). */
export const MACHINE_TILES = ['DOWN', 'DO_NOT_USE', 'UNDER_MAINTENANCE'] as const
export type MachineTile = (typeof MACHINE_TILES)[number]

/** A job is overdue: open, not handed back, past its due time. */
export const isOverdue = (job: { readonly status: string; readonly dueAt: Date | null }, now: Date): boolean =>
  job.dueAt !== null && job.dueAt.getTime() < now.getTime() && isOpenJob(job.status) && job.status !== 'HANDED_BACK'

/** The design's "third failure in 30 days" hint: three or more requests of the machine in 30 days. */
export const REPEAT_FAILURE = Object.freeze({ days: 30, requests: 3 })
export const isRepeatFailure = (requestsIn30Days: number): boolean => requestsIn30Days >= REPEAT_FAILURE.requests

/** Monday 00:00 of the business week of `now` (Europe/Rome): "closed this week". */
export function weekStart(now: Date, timeZone: string = BUSINESS_TIME_ZONE): Date {
  const today = businessDate(now, timeZone)
  const [year, month, day] = today.split('-').map(Number) as [number, number, number]
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const back = (weekday + 6) % 7
  const monday = new Date(Date.UTC(year, month - 1, day - back))
  return businessDayStart(monday.toISOString().slice(0, 10), timeZone)
}

/** Minutes since a moment (never below 0). */
export const minutesSince = (at: Date, now: Date): number => Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60_000))

/** The device time a queued floor report carries, kept when it is plausible: not ahead of the server, at most 7 days old. */
export function reportedAtOf(occurredAt: Date | null | undefined, now: Date): Date {
  if (!occurredAt) return now
  const age = now.getTime() - occurredAt.getTime()
  return age >= 0 && age <= 7 * 24 * 60 * 60_000 ? occurredAt : now
}
