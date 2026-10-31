import { JOB_MOVE_RULES, statusAfterReport } from '@nexus/factory-domain/plant/rules'
import type { Locale } from '../../../lib/i18n/locales'
import type { FloorJob, FloorMachine, FloorRequest, JobRecord, MachineAfter, MachineStatus, SafeAfter, StationMachine, Symptom, TechnicianMove } from './api'

/**
 * The machine problem and the technician's job (SCR-179; design floor.machine; Owner answer H1) — the screen's rules, pure:
 * where the screen opens (a technician on My jobs, anyone else on "Which machine?"), a scanned tag among the machines the
 * tablet knows, the symptom tiles of a machine (an unsafe symptom locks the machine at once; "Other" asks for words), what
 * holds the report, the queued report's payload and the machine's state it will cause, the station's banner in our words
 * (never the API's English), which moves a technician may make on a job now and why one is held, the requests of a job
 * that wait for a technician's sign-safe, the hand-back's words (fixed English phrases: the office's job record reads the
 * same in any language) and the machine's state after it. Nothing here names a person or holds money.
 */

// ---- where the screen opens -------------------------------------------------------------------------------------------

export const PLANT_FLOOR = { report: 'plant.report', work: 'plant.jobs.work', signSafe: 'plant.signSafe' } as const

export interface MachineCan {
  readonly report: boolean
  readonly work: boolean
  readonly signSafe: boolean
}

export function machineCan(permissions: readonly string[]): MachineCan {
  const held = new Set(permissions)
  return { report: held.has(PLANT_FLOOR.report), work: held.has(PLANT_FLOOR.work), signSafe: held.has(PLANT_FLOOR.signSafe) }
}

/** The technician (maintenance mode) opens on My jobs; everyone else on "Which machine?". */
export const firstStep = (can: MachineCan): 'jobs' | 'which' => (can.work ? 'jobs' : 'which')

// ---- words of the group's lists ---------------------------------------------------------------------------------------

export interface Worded {
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n?: Readonly<Record<string, string>>
}

/** A class's or symptom's own words in the screen's language (the floor speaks Italian and English). */
export const labelOf = (entry: Worded, locale: Locale): string => (locale === 'it' ? entry.labelIt : entry.labelEn)

// ---- which machine ----------------------------------------------------------------------------------------------------

/** A tag as the API compares it: trimmed, upper case (factory-domain normalAssetNumber). */
export const tagOf = (code: string): string => code.trim().toUpperCase()

/** The machine with this tag among the ones the tablet read this visit (the station's and the ones scanned), or null. */
export function machineByTag<T extends Pick<FloorMachine, 'assetNumber'>>(known: readonly T[], code: string): T | null {
  const tag = tagOf(code)
  return known.find((entry) => entry.assetNumber.toUpperCase() === tag) ?? null
}

export type MachineTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

export const MACHINE_TONE: Readonly<Record<MachineStatus, MachineTone>> = { RUNNING: 'success', DOWN: 'warning', UNDER_MAINTENANCE: 'info', DO_NOT_USE: 'danger', RETIRED: 'neutral' }

/** A machine's state word key: `status.<STATUS>`, or `status.LOCKED` while an unsafe report waits for the sign-safe. */
export const statusKey = (machine: Pick<FloorMachine, 'status' | 'locked'>): string => (machine.locked && machine.status === 'DO_NOT_USE' ? 'status.LOCKED' : `status.${machine.status}`)

/** Why a machine's tile does not open the report, or null: a retired machine reports nothing. */
export const machineHeld = (machine: Pick<FloorMachine, 'status'>): string | null => (machine.status === 'RETIRED' ? 'held.retired' : null)

/** One line of the station's banner, in our words (the API's own sentence is English). */
export interface BannerLine {
  readonly key: 'banner.locked' | 'banner.doNotUse' | 'banner.down' | 'banner.maintenance'
  readonly tone: 'danger' | 'warning' | 'info'
  readonly assetNumber: string
}

/** The station's banner: each machine that may not be used (locked first), then each machine that is down or worked on. */
export function bannerOf(machines: readonly Pick<FloorMachine, 'assetNumber' | 'status' | 'locked'>[]): BannerLine[] {
  const lines: BannerLine[] = []
  for (const machine of machines) {
    if (machine.status === 'DO_NOT_USE') lines.push({ key: machine.locked ? 'banner.locked' : 'banner.doNotUse', tone: 'danger', assetNumber: machine.assetNumber })
  }
  lines.sort((a, b) => (a.key === b.key ? 0 : a.key === 'banner.locked' ? -1 : 1))
  for (const machine of machines) {
    if (machine.status === 'DOWN') lines.push({ key: 'banner.down', tone: 'warning', assetNumber: machine.assetNumber })
    else if (machine.status === 'UNDER_MAINTENANCE') lines.push({ key: 'banner.maintenance', tone: 'info', assetNumber: machine.assetNumber })
  }
  return lines
}

// ---- what is wrong ----------------------------------------------------------------------------------------------------

export interface SymptomTile {
  readonly id: string
  readonly label: string
  readonly icon: string | null
  /** An unsafe symptom locks the machine at once (H1); its tile is drawn in danger and says so. */
  readonly unsafe: boolean
  /** "Other": a few words are asked. */
  readonly needsDetail: boolean
}

/** The symptoms a machine shows, as tiles in the screen's language (the API's order: the group's sort order). */
export function symptomTiles(symptoms: readonly Symptom[], locale: Locale): SymptomTile[] {
  return symptoms.filter((entry) => entry.active).map((entry) => ({ id: entry.id, label: labelOf(entry, locale), icon: entry.icon, unsafe: entry.unsafe, needsDetail: entry.needsDetail }))
}

export interface ReportDraft {
  readonly symptomId: string | null
  /** A few words (asked for "Other", or when no symptom is picked). */
  readonly words: string
  /** Marked unsafe by the person (Owner answer H1: anyone at the station may); an unsafe symptom marks it by itself. */
  readonly unsafe: boolean
}

export const EMPTY_DRAFT: ReportDraft = Object.freeze({ symptomId: null, words: '', unsafe: false })

/** The draft's symptom, or null. */
export const pickedSymptom = (machine: Pick<StationMachine, 'symptoms'>, draft: ReportDraft): Symptom | null => machine.symptoms.find((entry) => entry.id === draft.symptomId) ?? null

/** Whether the report locks the machine (H1): the symptom says so, or the person did. */
export const isUnsafe = (symptom: Pick<Symptom, 'unsafe'> | null, draft: Pick<ReportDraft, 'unsafe'>): boolean => (symptom?.unsafe ?? false) || draft.unsafe

/** Whether the screen asks for words now: the symptom wants them, or nothing is picked. */
export const wordsAsked = (symptom: Pick<Symptom, 'needsDetail'> | null): boolean => symptom === null || symptom.needsDetail

/** The most words the API takes (factory-domain PLANT_LIMITS.text). */
export const WORDS_MAX = 2000

/** Why the report cannot be sent now (a `floor-machine` key), or null. Offline is no reason: the report queues. */
export function reportHeld(input: { readonly can: Pick<MachineCan, 'report'>; readonly machine: Pick<FloorMachine, 'status'> | null; readonly symptom: Pick<Symptom, 'needsDetail'> | null; readonly words: string; readonly busy?: boolean }): string | null {
  if (!input.can.report) return 'held.noReport'
  if (!input.machine) return 'held.machineFirst'
  if (input.machine.status === 'RETIRED') return 'held.retired'
  if (input.busy) return 'held.busy'
  if (input.symptom === null && input.words.trim() === '') return 'held.pickOrWords'
  if (input.symptom?.needsDetail && input.words.trim() === '') return 'held.words'
  return null
}

/** The queued report's payload (POST /plant/requests' body without the envelope): the machine by its id and its tag. */
export function reportPayload(machine: Pick<FloorMachine, 'id' | 'assetNumber'>, draft: ReportDraft, down: boolean): Record<string, unknown> {
  const words = draft.words.trim().slice(0, WORDS_MAX)
  return {
    machineId: machine.id,
    assetNumber: machine.assetNumber,
    ...(draft.symptomId ? { symptomId: draft.symptomId } : {}),
    ...(words ? { description: words } : {}),
    ...(draft.unsafe ? { unsafe: true } : {}),
    down,
  }
}

/** The machine's state once the office records the report (factory-domain statusAfterReport), or null when it stays. */
export const statusOnArrival = (machine: Pick<FloorMachine, 'status'>, unsafe: boolean, down: boolean): MachineStatus | null => statusAfterReport({ status: machine.status, unsafe, down })

// ---- the technician's job ---------------------------------------------------------------------------------------------

/** The moves a technician makes on the floor, in the order the action bar shows them (the main one last). */
const TECHNICIAN_MOVES: readonly TechnicianMove[] = ['reopen', 'wait', 'start', 'handBack']

/** The moves the job's state allows now (JOB_MOVE_RULES: the technician's moves only). */
export function movesOf(job: Pick<FloorJob, 'status'>): TechnicianMove[] {
  return TECHNICIAN_MOVES.filter((move) => (JOB_MOVE_RULES[move].from as readonly string[]).includes(job.status))
}

/** Why a move is held now (a `floor-machine` key), or null. Offline: every move waits for the network. */
export function moveHeld(job: Pick<FloorJob, 'ownership' | 'open'>, can: Pick<MachineCan, 'work'>, online: boolean, busy = false): string | null {
  if (!can.work) return 'held.noWork'
  if (!job.open) return 'held.jobDone'
  if (job.ownership === 'OTHER') return 'held.notYours'
  if (!online) return 'held.offline'
  if (busy) return 'held.busy'
  return null
}

/** The requests behind a job that still lock its machine: each waits for a technician's sign-safe (H1). */
export const lockingRequests = (record: Pick<JobRecord, 'requests'>): FloorRequest[] => record.requests.filter((request) => request.locking)

/** Photos the reporters added (the office shows them; the floor may not open files). */
export const photosOf = (requests: readonly Pick<FloorRequest, 'photos'>[]): number => requests.reduce((total, request) => total + request.photos, 0)

/** The reporters' own words, oldest first, without blanks or repeats. */
export const reporterWords = (requests: readonly Pick<FloorRequest, 'description' | 'reportedAt'>[]): string[] =>
  [...new Set([...requests].sort((a, b) => a.reportedAt.localeCompare(b.reportedAt)).map((request) => request.description?.trim() ?? '').filter(Boolean))]

/**
 * The job's own words beyond its symptom: the API writes a job of a report as "<symptom's English words>: <the reporter's
 * words>" (factory-domain problemOf); the screen says the symptom in its language, so only the rest is shown (null: none).
 * A job made by hand keeps the office's words as written.
 */
export function problemBeyond(job: Pick<FloorJob, 'problem' | 'symptom'>): string | null {
  const problem = job.problem.trim()
  if (!job.symptom) return problem || null
  const words = job.symptom.labelEn.trim()
  if (problem === words || problem === 'Machine problem reported from the station.') return null
  if (problem.startsWith(`${words}: `)) return problem.slice(words.length + 2).trim() || null
  return problem
}

/** The priority tone of a job row. */
export const priorityTone = (job: Pick<FloorJob, 'priority' | 'machine'>): 'danger' | 'warning' | 'neutral' => (job.machine.locked || job.priority === 'P1' ? 'danger' : job.priority === 'P2' ? 'warning' : 'neutral')

/** Minutes as the screen says them (`age.*` keys): "14 min", "3 h 05", "2 d". */
export function ageParts(minutes: number): { key: 'age.minutes' | 'age.hours' | 'age.days'; params: Record<string, string | number> } {
  const value = Math.max(0, Math.floor(minutes))
  if (value < 60) return { key: 'age.minutes', params: { count: value } }
  if (value < 24 * 60) return { key: 'age.hours', params: { hours: Math.floor(value / 60), minutes: String(value % 60).padStart(2, '0') } }
  return { key: 'age.days', params: { count: Math.floor(value / (24 * 60)) } }
}

// ---- hand back ---------------------------------------------------------------------------------------------------------

/** What the technician did (design floor.machine "close": action tiles), sent as fixed English words the office reads. */
export const WORK_DONE = {
  adjusted: 'Adjusted',
  replaced: 'Replaced a part',
  cleaned: 'Cleaned and lubricated',
  other: 'Other',
} as const
export type WorkDoneCode = keyof typeof WORK_DONE
export const WORK_DONE_CODES = Object.keys(WORK_DONE) as WorkDoneCode[]

export interface HandBackDraft {
  readonly done: WorkDoneCode | null
  readonly words: string
  readonly after: MachineAfter | null
}

export const EMPTY_HAND_BACK: HandBackDraft = Object.freeze({ done: null, words: '', after: null })

/** The hand-back's words: the tile's phrase, then what the technician wrote ("Other" is the words alone). */
export function workDoneText(draft: Pick<HandBackDraft, 'done' | 'words'>): string {
  const words = draft.words.trim()
  if (!draft.done) return words
  if (draft.done === 'other') return words
  return words ? `${WORK_DONE[draft.done]}: ${words}`.slice(0, WORDS_MAX) : WORK_DONE[draft.done]
}

/** Why a machine state after the hand-back is held, or null: running only once nothing locks it (H1). */
export const afterHeld = (after: MachineAfter, machine: Pick<FloorMachine, 'locked'>): string | null => (after === 'RUNNING' && machine.locked ? 'held.signFirst' : null)

/** Why the hand-back cannot be sent now, or null. */
export function handBackHeld(draft: HandBackDraft, machine: Pick<FloorMachine, 'locked'>, online: boolean, busy = false): string | null {
  if (!online) return 'held.offline'
  if (busy) return 'held.busy'
  if (!draft.done) return 'held.whatDone'
  if (draft.done === 'other' && draft.words.trim() === '') return 'held.words'
  if (!draft.after) return 'held.after'
  return afterHeld(draft.after, machine)
}

// ---- sign safe (H1) ----------------------------------------------------------------------------------------------------

export interface SignDraft {
  readonly words: string
  readonly after: SafeAfter
}

/** The machine's state once no lock is left: under maintenance while its job is started, else running (the API's default). */
export const defaultSafeAfter = (job: Pick<FloorJob, 'status'> | null): SafeAfter => (job && (job.status === 'IN_PROGRESS' || job.status === 'WAITING_PARTS') ? 'UNDER_MAINTENANCE' : 'RUNNING')

/** The most words a sign-safe takes (factory-domain PLANT_LIMITS.note). */
export const NOTE_MAX = 500

/** Why the sign-safe cannot be sent now, or null: what was checked is said in words (D.Lgs. 81/2008 art. 71). */
export function signHeld(draft: SignDraft, can: Pick<MachineCan, 'signSafe'>, online: boolean, busy = false): string | null {
  if (!can.signSafe) return 'held.noSign'
  if (!online) return 'held.offline'
  if (busy) return 'held.busy'
  if (draft.words.trim() === '') return 'held.checked'
  return null
}

// ---- the API's refusals in our words ------------------------------------------------------------------------------------

/** The plant refusal codes this screen says in its own words (`refusal.<CODE>.message` + `.fix`); others: the API's. */
export const KNOWN_REFUSALS = ['RETIRED', 'SYMPTOM_INACTIVE', 'SYMPTOM_OTHER_CLASS', 'DETAIL_NEEDED', 'NO_REPORTER', 'LOCKED_UNSAFE', 'NOT_UNSAFE', 'SIGNED_ALREADY', 'MOVE_NOT_ALLOWED', 'NOT_YOUR_JOB'] as const

export const isKnownRefusal = (code: string): boolean => (KNOWN_REFUSALS as readonly string[]).includes(code)
