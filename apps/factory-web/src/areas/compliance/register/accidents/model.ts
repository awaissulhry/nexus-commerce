import { ACCIDENT_OUTCOMES, NOTIFIABLE_OUTCOMES, REPORT_VIEWS, SAFETY_SOURCES, type AccidentOutcome } from '@nexus/factory-domain/sales/safety-reports/rules'
import { issuePath, isApiError } from '../../../../lib/api/errors'
import { EMPTY_INTAKE, intakeFieldProblems, type FieldProblems, type IntakeDraft } from '../../../../lib/safety-reports/intake'
import type { LogEntry, LogQuery, Person, Report, ReportAction, ReportRow } from './api'

/**
 * Product-safety reports and the accident log in the office (B-W2b-357; design compliance.register page.h "Accident log (W2b)",
 * SAL-414, SAL-415, SAL-423), pure: who may do what, the addresses of the two lists, the tiles, the record's verbs held with
 * why (the API's `actions` for this reader), the drafts of its dialogs and their problems, and a refusal in our words. The
 * injury is never in a list, an export or an address: only the record's ProtectedValue holds it, after a recorded opening.
 */

export const NS = 'safety-reports'

export const SAFETY_PERMISSIONS = {
  view: 'sales.safety.view',
  manage: 'sales.safety.manage',
  injury: 'sales.safety.injury',
  log: 'sales.safety.log',
  serviceManage: 'sales.service.manage',
  serviceView: 'sales.service.view',
  registerView: 'compliance.register.view',
  registerManage: 'compliance.register.manage',
  parties: 'parties.view',
  styles: 'product.styles.view',
} as const
export type SafetyCan = Readonly<Record<keyof typeof SAFETY_PERMISSIONS, boolean>>

export function safetyCan(permissions: readonly string[]): SafetyCan {
  const held = new Set(permissions)
  return Object.fromEntries(Object.entries(SAFETY_PERMISSIONS).map(([name, permission]) => [name, held.has(permission)])) as unknown as SafetyCan
}

// ── addresses ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const LOG_PATH = '/compliance/register/accidents'
export const REPORTS_PATH = '/compliance/register/accidents/reports'
export const reportHref = (prefix: string, id: string, tab?: RecordTab, act?: RecordDo): string => {
  const terms = new URLSearchParams()
  if (tab && tab !== 'report') terms.set('tab', tab)
  if (act) terms.set('do', act)
  const query = terms.toString()
  return `${prefix}${REPORTS_PATH}/${encodeURIComponent(id)}${query ? `?${query}` : ''}`
}

export type ReportView = (typeof REPORT_VIEWS)[number]
export type ReportSource = (typeof SAFETY_SOURCES)[number]

export interface ReportsAddress {
  readonly view: ReportView
  readonly source: ReportSource | null
  readonly q: string
  readonly isNew: boolean
}

const isView = (value: string | null): value is ReportView => (REPORT_VIEWS as readonly string[]).includes(value ?? '')
const isSource = (value: string | null): value is ReportSource => (SAFETY_SOURCES as readonly string[]).includes(value ?? '')

export function reportsAddressOf(params: { get(name: string): string | null } | null): ReportsAddress {
  const view = params?.get('view') ?? null
  const source = params?.get('source') ?? null
  return { view: isView(view) ? view : 'open', source: isSource(source) ? source : null, q: params?.get('q') ?? '', isNew: params?.get('new') === '1' }
}

export function reportsQuery(address: Omit<ReportsAddress, 'isNew'>): string {
  const terms = new URLSearchParams()
  if (address.view !== 'open') terms.set('view', address.view)
  if (address.source) terms.set('source', address.source)
  if (address.q.trim()) terms.set('q', address.q.trim())
  const query = terms.toString()
  return query ? `?${query}` : ''
}

/** The accident log's address: the API's filters, and `view=toTell` (the rows to tell the authority, kept on the page). */
export interface LogAddress extends LogQuery {
  readonly toTell: boolean
}

const isOutcome = (value: string | null): value is AccidentOutcome => (ACCIDENT_OUTCOMES as readonly string[]).includes(value ?? '')
const DAY = /^\d{4}-\d{2}-\d{2}$/

export function logAddressOf(params: { get(name: string): string | null } | null): LogAddress {
  const told = params?.get('told') ?? null
  const outcome = params?.get('outcome') ?? null
  const from = params?.get('from') ?? null
  const to = params?.get('to') ?? null
  return {
    from: from && DAY.test(from) ? from : null,
    to: to && DAY.test(to) ? to : null,
    outcome: isOutcome(outcome) ? outcome : null,
    told: told === 'yes' || told === 'no' ? told : null,
    toTell: params?.get('view') === 'toTell',
  }
}

export function logQuery(address: LogAddress): string {
  const terms = new URLSearchParams()
  if (address.toTell) terms.set('view', 'toTell')
  if (address.told) terms.set('told', address.told)
  if (address.outcome) terms.set('outcome', address.outcome)
  if (address.from) terms.set('from', address.from)
  if (address.to) terms.set('to', address.to)
  const query = terms.toString()
  return query ? `?${query}` : ''
}

/** The API's filters of a log address (`toTell` asks the not-told rows; the page keeps those it must tell). */
export const logApiQuery = (address: LogAddress): LogQuery => ({ from: address.from, to: address.to, outcome: address.outcome, told: address.toTell ? 'no' : address.told })

/** The log's rows as the page shows them: the ones to tell the authority first (the screen's choice), then the API's order. */
export function logRows(entries: readonly LogEntry[], address: Pick<LogAddress, 'toTell'>): LogEntry[] {
  const kept = address.toTell ? entries.filter((entry) => entry.mustTell) : [...entries]
  return kept.sort((a, b) => Number(b.mustTell) - Number(a.mustTell))
}

export const logFiltered = (address: LogAddress): boolean => address.toTell || address.told !== null || address.outcome !== null || address.from !== null || address.to !== null

// ── what a row and a record say ──────────────────────────────────────────────────────────────────────────────────────────

/** The garment in one line: our serial (else the typed one), the batch (ours, else typed), the style's code. */
export function garmentOf(row: Pick<ReportRow, 'garmentSerial' | 'serial' | 'garmentBatch' | 'batchNumber' | 'style' | 'size'>): { serial: string | null; batch: string | null; style: string | null; ours: boolean } {
  return { serial: row.garmentSerial ?? row.serial, batch: row.garmentBatch ?? row.batchNumber, style: row.style?.code ?? null, ours: row.garmentSerial !== null || row.garmentBatch !== null }
}

export const isNotifiable = (outcome: AccidentOutcome): boolean => (NOTIFIABLE_OUTCOMES as readonly string[]).includes(outcome)

/** A person's name from the answer's people; null when unknown. */
export const nameOf = (people: readonly Person[] | null | undefined, id: string | null): string | null => (id ? (people?.find((person) => person.id === id)?.name ?? null) : null)

/** The record's tabs. */
export const RECORD_TABS = ['report', 'accident', 'photos'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
export const isRecordTab = (value: string | null): value is RecordTab => (RECORD_TABS as readonly string[]).includes(value ?? '')

/** A dialog a row verb opens on the record (`?do=`). */
export const RECORD_DOS = ['revise', 'told'] as const
export type RecordDo = (typeof RECORD_DOS)[number]
export const isRecordDo = (value: string | null): value is RecordDo => (RECORD_DOS as readonly string[]).includes(value ?? '')

/** Why a verb of the record waits (a key of the catalogue), or null: the API's `actions` for this reader. */
export function actionHeld(report: Pick<Report, 'actions'> | null, action: ReportAction['action'], offline = false): string | null {
  if (offline) return 'held.offline'
  const found = report?.actions.find((entry) => entry.action === action)
  if (!found) return 'held.NO_PERMISSION'
  return found.allowed ? null : `held.${found.held ?? 'NO_PERMISSION'}`
}

/** The band's one primary: Mark seen (new, not seen), Start assessing (new), Close (being assessed); none when closed. */
export function primaryOf(report: Pick<Report, 'status' | 'seen'>): 'seen' | 'assess' | 'close' | null {
  if (report.status === 'CLOSED') return null
  if (report.status === 'ASSESSING') return 'close'
  return report.seen ? 'assess' : 'seen'
}

// ── drafts ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NewReportDraft extends IntakeDraft {
  readonly source: 'OFFICE' | 'MAIL'
  /** A mail: when it came (an instant; '' = now). */
  readonly receivedAt: string
  readonly partyId: string
  readonly styleId: string
}

export const EMPTY_NEW: NewReportDraft = Object.freeze({ ...EMPTY_INTAKE, source: 'MAIL', receivedAt: '', partyId: '', styleId: '' })

export function newReportProblems(draft: NewReportDraft, today: string, now: Date = new Date()): FieldProblems & { receivedAt?: string } {
  const problems: FieldProblems & { receivedAt?: string } = intakeFieldProblems(draft, 'office', today)
  if (draft.source === 'MAIL' && draft.receivedAt !== '' && Date.parse(draft.receivedAt) > now.getTime()) problems.receivedAt = 'problem.receivedFuture'
  return problems
}

export interface ReviseDraft {
  readonly occurredOn: string
  readonly place: string
  readonly outcome: AccidentOutcome | ''
  /** The authority was told: the day (`YYYY-MM-DD`); '' not told in this revision. */
  readonly toldOn: string
  readonly reference: string
  readonly note: string
}

/** A revision's draft: from the newest revision (left out = copied by the API), or empty for the first. */
export function reviseDraftOf(report: Pick<Report, 'accidentLog' | 'occurredOn'>, told = false, today = ''): ReviseDraft {
  const newest = report.accidentLog.newest
  return { occurredOn: newest?.occurredOn ?? report.occurredOn ?? '', place: newest?.place ?? '', outcome: newest?.outcome ?? '', toldOn: told ? today : '', reference: '', note: '' }
}

export type ReviseField = 'occurredOn' | 'place' | 'outcome' | 'toldOn' | 'reference' | 'note'

/** The draft's problems (factory-domain's revisionProblems said by field): revision 1 its day, place and outcome; later ones why. */
export function reviseProblems(draft: ReviseDraft, input: { first: boolean; receivedOn: string; today: string }): Partial<Record<ReviseField, string>> {
  const problems: Partial<Record<ReviseField, string>> = {}
  if (!draft.occurredOn) problems.occurredOn = 'problem.revise.occurredOn'
  else if (draft.occurredOn > input.today || draft.occurredOn > input.receivedOn) problems.occurredOn = 'problem.revise.occurredOnLate'
  if (draft.place.trim() === '') problems.place = 'problem.revise.place'
  else if (/[\r\n]/.test(draft.place) || draft.place.trim().length > 300) problems.place = 'problem.placeLine'
  if (!draft.outcome) problems.outcome = 'problem.revise.outcome'
  if (!input.first && draft.note.trim() === '') problems.note = 'problem.revise.note'
  if (draft.toldOn) {
    if (draft.toldOn > input.today) problems.toldOn = 'problem.revise.toldFuture'
    else if (draft.occurredOn && draft.toldOn < draft.occurredOn) problems.toldOn = 'problem.revise.toldBefore'
  } else if (draft.reference.trim() !== '') problems.reference = 'problem.revise.referenceAlone'
  return problems
}

/** The revision's body: only what changed against the newest revision (the API copies the rest), the authority's day at noon. */
export function reviseBodyOf(draft: ReviseDraft, newest: Report['accidentLog']['newest']): { occurredOn?: string; place?: string; outcome?: AccidentOutcome; authorityToldAt?: string; authorityReference?: string | null; note?: string | null } {
  const body: ReturnType<typeof reviseBodyOf> = {}
  if (!newest || draft.occurredOn !== newest.occurredOn) body.occurredOn = draft.occurredOn
  if (!newest || draft.place.trim() !== newest.place) body.place = draft.place.trim()
  if (draft.outcome && (!newest || draft.outcome !== newest.outcome)) body.outcome = draft.outcome
  if (draft.toldOn) {
    body.authorityToldAt = toldInstant(draft.toldOn)
    body.authorityReference = draft.reference.trim() || null
  }
  if (draft.note.trim()) body.note = draft.note.trim()
  return body
}

/** The day the authority was told, as an instant the API accepts: today = now (never in the future), an earlier day at noon UTC. */
export function toldInstant(day: string, now: Date = new Date()): string {
  const noon = new Date(`${day}T12:00:00Z`)
  return noon.getTime() > now.getTime() ? now.toISOString() : noon.toISOString()
}

export interface InjuryDraft {
  readonly injured: boolean | null
  readonly consent: boolean
  readonly words: string
}

export const injuryHeld = (draft: InjuryDraft): string | null => (draft.injured === null ? 'problem.injured' : draft.injured && draft.words.trim() !== '' && !draft.consent ? 'problem.consent' : null)

export const reasonHeld = (reason: string): string | null => (reason.trim() === '' ? 'problem.reason' : reason.trim().length > 500 ? 'problem.reasonLong' : null)
export const closeHeld = (note: string): string | null => (note.trim() === '' ? 'problem.closeNote' : note.trim().length > 2000 ? 'problem.closeNoteLong' : null)

// ── refusals ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A refusal in our words: a held code (`held/<CODE>`), a stale version, the person's right, a field, or a failure. */
export function refusalOf(error: unknown): string {
  if (!isApiError(error)) return 'refused.failed'
  const held = error.issues.map(issuePath).find((path) => path.startsWith('held/'))
  if (held) return `held.${held.slice(5)}`
  if (error.kind === 'conflict') return 'refused.stale'
  if (error.kind === 'forbidden') return 'refused.forbiddenOffice'
  if (error.kind === 'not_found') return 'refused.notFound'
  if (error.kind === 'invalid') return 'refused.invalid'
  if (error.kind === 'unavailable') return 'refused.network'
  return 'refused.failed'
}

/** A read's failure in our words. */
export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'read.failed'
  if (error.kind === 'forbidden') return 'read.forbidden'
  if (error.kind === 'not_found') return 'read.notFound'
  if (error.kind === 'unavailable') return 'read.network'
  return 'read.failed'
}

/** The reports' CSV (the selection): never the reporter, what happened or anything of an injury. */
export function reportsCsv(rows: readonly ReportRow[], words: { header: readonly string[]; source: (code: string) => string; status: (code: string) => string; outcome: (code: string) => string }): string {
  const cell = (value: string | null | undefined) => {
    const text = value ?? ''
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = rows.map((row) => {
    const garment = garmentOf(row)
    return [row.number, row.receivedAt, words.source(row.source), row.party?.legalName ?? '', garment.serial ?? '', garment.batch ?? '', garment.style ?? '', row.accident ? words.outcome(row.accident.outcome) : '', row.case?.number ?? '', words.status(row.status)].map(cell).join(',')
  })
  return [words.header.map(cell).join(','), ...lines].join('\n')
}
