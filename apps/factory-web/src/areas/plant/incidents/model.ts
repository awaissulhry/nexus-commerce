import { isApiError, issuePath } from '../../../lib/api/errors'
import {
  BODY_PARTS,
  INAIL_RULE,
  INCIDENT_KINDS,
  INCIDENT_LIMITS,
  INCIDENT_REFUSALS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  type BodyPart,
  type BodySide,
  type FilingState,
  type IncidentKind,
  type IncidentSeverity,
  type IncidentStatus,
  type InjuryNature,
  type Involvement,
} from '@nexus/factory-domain/safety/incidents/rules'
import type { Tone } from '@nexus/ui/primitives'
import type { CountsAnswer, EditBody, IncidentAction, IncidentPerson, IncidentRecord, IncidentRow, InailFiling, ListQuery, MakeBody, PersonBody, ReportBody } from './api'

/**
 * Plant › Health & safety › Incidents (SCR-210; B-W2b-149), pure: who may do what, the list's address (Rows ▾, status, the
 * window, the number, the dialogs), the tiles, the deadline in words, where it happened, the holds of every button in words,
 * the dialogs' drafts and the bodies they send, the API's refusals in our words, what a live event re-reads. No person here
 * beyond what a protected read handed the page: the list and the address never carry one.
 */

export const INCIDENTS_PATH = '/plant/incidents'
/** The INAIL portal (design tab:inail: an outside site, opened in a new tab by itself; the filing is a manual send). */
export const INAIL_PORTAL = 'https://www.inail.it/'

// ---- who may do what -------------------------------------------------------------------------------------------------------

export interface IncidentsCan {
  readonly view: boolean
  readonly report: boolean
  readonly manage: boolean
  readonly people: boolean
  /** The stations and machines of the report's Where (GET /plant/places, /plant/machines). */
  readonly plantView: boolean
  /** The staff list of the report's people (GET /safety/organisation/people: its route asks safety.organisation.manage). */
  readonly pickPeople: boolean
}

export function incidentsCan(permissions: Iterable<string>): IncidentsCan {
  const held = new Set(permissions)
  return {
    view: held.has('safety.incidents.view'),
    report: held.has('safety.incidents.report'),
    manage: held.has('safety.incidents.manage'),
    people: held.has('safety.incidents.people'),
    plantView: held.has('plant.view'),
    pickPeople: held.has('safety.organisation.manage'),
  }
}

// ---- the list's address ----------------------------------------------------------------------------------------------------

export const ROWS = ['INJURY', 'NEAR_MISS', 'HAZARD', 'INAIL_DUE'] as const
export type RowsFilter = (typeof ROWS)[number]
export const STATUS_FILTERS = [...INCIDENT_STATUSES, 'ALL'] as const
export type StatusFilter = (typeof STATUS_FILTERS)[number]

export interface IncidentsAddress {
  readonly rows: RowsFilter | null
  readonly status: StatusFilter | null
  readonly from: string | null
  readonly to: string | null
  readonly q: string | null
  /** Report an incident (`?new=1`, the band's primary, `c`). */
  readonly report: boolean
}

export const EMPTY_ADDRESS: IncidentsAddress = Object.freeze({ rows: null, status: null, from: null, to: null, q: null, report: false })

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const pick = <T extends string>(value: string | null | undefined, allowed: readonly T[]): T | null => (value && (allowed as readonly string[]).includes(value) ? (value as T) : null)

export function addressOf(params: Pick<URLSearchParams, 'get'> | null): IncidentsAddress {
  if (!params) return EMPTY_ADDRESS
  const day = (name: string) => {
    const value = params.get(name)
    return value && DAY.test(value) ? value : null
  }
  const q = (params.get('q') ?? '').trim().slice(0, 40)
  return { rows: pick(params.get('rows'), ROWS), status: pick(params.get('status'), STATUS_FILTERS), from: day('from'), to: day('to'), q: q || null, report: params.get('new') === '1' }
}

/** The address terms (the export and a saved view read the same: the list's filters, never a dialog). */
export function addressTerms(address: IncidentsAddress, withDialog = true): string {
  const query = new URLSearchParams()
  if (address.rows) query.set('rows', address.rows)
  if (address.status) query.set('status', address.status)
  if (address.from) query.set('from', address.from)
  if (address.to) query.set('to', address.to)
  if (address.q) query.set('q', address.q)
  if (withDialog && address.report) query.set('new', '1')
  const text = query.toString()
  return text ? `?${text}` : ''
}

export const withAddress = (address: IncidentsAddress, change: Partial<IncidentsAddress>): IncidentsAddress => ({ ...address, ...change })

export const listQueryOf = (address: IncidentsAddress, siteId: string | null): ListQuery => ({ siteId, rows: address.rows, status: address.status, from: address.from, to: address.to, q: address.q })

/** Any filter of the list set (the empty state says "nothing matches" then, not "nothing recorded"). */
export const filtered = (address: IncidentsAddress): boolean => Boolean(address.rows || address.status || address.from || address.to || address.q)

// ---- tiles -----------------------------------------------------------------------------------------------------------------

export const TILES = ['openIncidents', 'inailOpen', 'nearMissesThisMonth', 'hazardsOpen', 'actionsOverdue'] as const
export type TileId = (typeof TILES)[number]

/** A tile and the list's filter it sets (Actions overdue has none: the API lists no such rows; it says so in its hint). */
export function tileFilter(tile: TileId, today: string): Partial<IncidentsAddress> | null {
  switch (tile) {
    case 'openIncidents':
      return { rows: null, status: 'OPEN', from: null, to: null }
    case 'inailOpen':
      return { rows: 'INAIL_DUE', status: null, from: null, to: null }
    case 'nearMissesThisMonth':
      return { rows: 'NEAR_MISS', status: null, from: `${today.slice(0, 7)}-01`, to: null }
    case 'hazardsOpen':
      return { rows: 'HAZARD', status: 'OPEN', from: null, to: null }
    default:
      return null
  }
}

/** Whether a tile's filter is the list's now. */
export function tileActive(tile: TileId, address: IncidentsAddress, today: string): boolean {
  const filter = tileFilter(tile, today)
  if (!filter) return false
  return (filter.rows ?? null) === address.rows && (filter.status ?? null) === address.status && (filter.from ?? null) === address.from && address.to === null && address.q === null
}

export function tilesOf(counts: CountsAnswer | null): { id: TileId; value: number | null }[] {
  return TILES.map((id) => ({ id, value: counts ? counts.tiles[id] : null }))
}

// ---- time ------------------------------------------------------------------------------------------------------------------

/** Today in a time zone (YYYY-MM-DD). */
export const todayIn = (timeZone: string, at: Date = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)

/**
 * A span in words ("3 h", "2 d 4 h", "25 min"): the deadline banner's late time and a list cell's time left, counted from
 * the server's `now` the read gave plus what the page's clock moved since (never the browser's clock alone).
 */
export function spanWords(ms: number): { key: string; params: Record<string, number> } {
  const minutes = Math.max(0, Math.floor(Math.abs(ms) / 60_000))
  if (minutes < 60) return { key: 'time.minutes', params: { minutes } }
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return { key: 'time.hours', params: { hours } }
  return { key: 'time.days', params: { days: Math.floor(hours / 24), hours: hours % 24 } }
}

/** A deadline's tone: late danger, under 24 h danger, else warning (a filing due is never neutral). */
export function deadlineTone(countdown: { late: boolean; under24h: boolean } | null): Tone {
  if (!countdown) return 'neutral'
  return countdown.late || countdown.under24h ? 'danger' : 'warning'
}

/** A filing state's tone (design "Not needed / Waiting certificate / Due / Overdue / Filed"). */
export const FILING_TONE: Readonly<Record<FilingState, Tone>> = Object.freeze({ NOT_NEEDED: 'neutral', WAITING_CERTIFICATE: 'info', DUE: 'warning', OVERDUE: 'danger', FILED: 'success' })
export const STATUS_TONE: Readonly<Record<IncidentStatus, Tone>> = Object.freeze({ OPEN: 'warning', CLOSED: 'success', CANCELLED: 'neutral' })
export const KIND_TONE: Readonly<Record<IncidentKind, Tone>> = Object.freeze({ INJURY: 'danger', NEAR_MISS: 'warning', HAZARD: 'info' })
export const SEVERITY_TONE: Readonly<Record<IncidentSeverity, Tone>> = Object.freeze({ NONE: 'neutral', FIRST_AID: 'warning', LOST_DAYS: 'danger' })

// ---- where it happened ------------------------------------------------------------------------------------------------------

/** Where, as the list's Area column says it: the area, the station, the place in words (the machine has its own column). */
export function whereText(row: Pick<IncidentRow, 'area' | 'station' | 'place'>): string {
  return [row.area?.name, row.station ? `${row.station.code}` : null, row.place].filter((part): part is string => Boolean(part && part.trim())).join(' · ')
}

// ---- holds (each in words) -------------------------------------------------------------------------------------------------

/** Report an incident: the right, then a company and a site to report at (an "All sites" top bar asks for one). */
export function reportHeldFirst(can: IncidentsCan, companyId: string | null): string | null {
  if (!can.report) return 'held.noReport'
  if (!companyId) return 'held.company'
  return null
}

/** How many of an incident's filings still wait (a certificate or the filing): close and cancel are held while any does. */
export const filingsWaiting = (record: Pick<IncidentRecord, 'inail'>): number => record.inail.deadlines.filter((deadline) => deadline.status === 'WAITING_CERTIFICATE' || deadline.status === 'DUE').length
export const actionsOpen = (record: Pick<IncidentRecord, 'actions'>): number => record.actions.filter((action) => action.status === 'OPEN').length

/** Close (design pop:close "Held while actions are open or a filing is due"). */
export function closeHeld(record: IncidentRecord): string | null {
  if (!record.canManage) return 'held.noManage'
  if (record.status !== 'OPEN') return 'held.notOpen'
  if (actionsOpen(record) > 0) return 'held.actionsOpen'
  if (filingsWaiting(record) > 0) return 'held.filingWaiting'
  return null
}

export function reopenHeld(record: IncidentRecord): string | null {
  if (!record.canManage) return 'held.noManage'
  if (record.status !== 'CLOSED') return 'held.notClosed'
  return null
}

/** Cancel (a report made by mistake, with the reason): held as close is. */
export const cancelHeld = (record: IncidentRecord): string | null => closeHeld(record)

/** Edit the report (EditModeBar for the safety roles): manage, while OPEN. */
export function editHeld(record: IncidentRecord): string | null {
  if (!record.canManage) return 'held.noManage'
  if (record.status !== 'OPEN') return 'held.notOpenEdit'
  return null
}

/** The actions: add, make, done and cancel need manage on an OPEN incident; an action itself while OPEN. */
export function actionsHeld(record: IncidentRecord): string | null {
  if (!record.canManage) return 'held.noManage'
  if (record.status !== 'OPEN') return 'held.notOpenActions'
  return null
}

export function actionHeld(record: IncidentRecord, action: Pick<IncidentAction, 'status'>): string | null {
  return actionsHeld(record) ?? (action.status === 'OPEN' ? null : 'held.actionClosed')
}

/** Why an action may not be chosen for Mark done N (null: it may). */
export const actionSelectHeld = (record: IncidentRecord, action: IncidentAction): string | null => actionHeld(record, action)

/** A photo (office): manage, the incident not cancelled. */
export function photoHeld(record: IncidentRecord): string | null {
  if (!record.canManage) return 'held.noManagePhoto'
  if (record.status === 'CANCELLED') return 'held.cancelled'
  return null
}

/** The protected reads and the filings: safety.incidents.people (HR and the safety officer). */
export const peopleHeld = (record: Pick<IncidentRecord, 'canPeople'>): string | null => (record.canPeople ? null : 'held.noPeople')

/** Record INAIL filing (`f`, the record's primary): people, an open incident, an injury. */
export function filingHeld(record: IncidentRecord): string | null {
  if (!record.canPeople) return 'held.noPeople'
  if (record.kind !== 'INJURY') return 'held.notInjury'
  if (record.status !== 'OPEN' && filingsWaiting(record) === 0) return 'held.notOpen'
  return null
}

// ---- the report dialog -----------------------------------------------------------------------------------------------------

export interface PersonDraft {
  readonly key: string
  readonly who: 'EMPLOYEE' | 'OUTSIDE'
  readonly employeeId: string | null
  readonly employeeName: string | null
  readonly outsideName: string
  readonly involvement: Involvement
  readonly bodyParts: readonly BodyPart[]
  readonly bodySide: BodySide | null
  readonly nature: InjuryNature | null
  readonly firstAidGiven: boolean
  readonly sentToHospital: boolean
}

export interface ReportDraft {
  readonly kind: IncidentKind | null
  readonly what: string
  /** ISO instant ('' unset). */
  readonly occurredAt: string
  readonly stationId: string | null
  readonly machineId: string | null
  readonly place: string
  readonly immediateAction: string
  readonly people: readonly PersonDraft[]
}

export const newReportDraft = (now: string): ReportDraft => ({ kind: null, what: '', occurredAt: now, stationId: null, machineId: null, place: '', immediateAction: '', people: [] })

export const newPersonDraft = (key: string, kind: IncidentKind | null): PersonDraft => ({
  key,
  who: 'EMPLOYEE',
  employeeId: null,
  employeeName: null,
  outsideName: '',
  involvement: kind === 'INJURY' ? 'INJURED' : 'INVOLVED',
  bodyParts: [],
  bodySide: null,
  nature: null,
  firstAidGiven: false,
  sentToHospital: false,
})

/** A person's hold (null: fine), the guard's rules in our words. */
export function personHeld(person: PersonDraft, kind: IncidentKind | null): string | null {
  if (person.who === 'EMPLOYEE' && !person.employeeId) return 'held.person.choose'
  if (person.who === 'OUTSIDE' && !person.outsideName.trim()) return 'held.person.name'
  if (person.outsideName.trim().length > INCIDENT_LIMITS.outsideName) return 'held.person.nameLong'
  if (person.involvement === 'INJURED' && kind !== 'INJURY') return 'refusal.INJURED_NOT_INJURY'
  if (person.bodySide && person.bodyParts.length === 0) return 'held.person.side'
  return null
}

/** Send report (design pop:report): a kind, the words, when, where; each person as the guard asks; at most 20 people. */
export function reportHeld(draft: ReportDraft, now: Date): string | null {
  if (!draft.kind) return 'held.report.kind'
  if (!draft.what.trim()) return 'held.report.what'
  if (draft.what.trim().length > INCIDENT_LIMITS.what) return 'held.report.whatLong'
  if (!draft.occurredAt) return 'held.report.when'
  if (new Date(draft.occurredAt).getTime() > now.getTime() + 60_000) return 'refusal.OCCURRED_IN_FUTURE'
  if (!draft.stationId && !draft.machineId && !draft.place.trim()) return 'refusal.WHERE_MISSING'
  if (draft.people.length > INCIDENT_LIMITS.people) return 'held.report.people'
  for (const person of draft.people) {
    const held = personHeld(person, draft.kind)
    if (held) return held
  }
  const employees = draft.people.map((person) => person.employeeId).filter(Boolean)
  if (new Set(employees).size !== employees.length) return 'refusal.PERSON_TWICE'
  return null
}

export function personBody(person: PersonDraft): PersonBody {
  const injured = person.involvement === 'INJURED'
  return {
    involvement: person.involvement,
    ...(person.who === 'EMPLOYEE' && person.employeeId ? { employeeId: person.employeeId } : { outsideName: person.outsideName.trim() }),
    ...(injured ? { bodyParts: [...person.bodyParts], bodySide: person.bodyParts.length > 0 ? person.bodySide : null, nature: person.nature, firstAidGiven: person.firstAidGiven, sentToHospital: person.sentToHospital } : {}),
  }
}

export function reportBody(draft: ReportDraft, place: { companyId: string; siteId: string }): ReportBody {
  return {
    companyId: place.companyId,
    siteId: place.siteId,
    kind: draft.kind!,
    occurredAt: new Date(draft.occurredAt).toISOString(),
    what: draft.what.trim(),
    ...(draft.stationId ? { stationId: draft.stationId } : {}),
    ...(draft.machineId ? { machineId: draft.machineId } : {}),
    ...(draft.place.trim() ? { place: draft.place.trim() } : {}),
    ...(draft.immediateAction.trim() ? { immediateAction: draft.immediateAction.trim() } : {}),
    ...(draft.people.length > 0 ? { people: draft.people.map(personBody) } : {}),
  }
}

/** A changed kind: people are injured only in an injury (the guard's rule): an injured person becomes involved, not hurt. */
export function withKind(draft: ReportDraft, kind: IncidentKind): ReportDraft {
  if (kind === 'INJURY') return { ...draft, kind }
  return { ...draft, kind, people: draft.people.map((person) => (person.involvement === 'INJURED' ? { ...person, involvement: 'INVOLVED', bodyParts: [], bodySide: null, nature: null, firstAidGiven: false, sentToHospital: false } : person)) }
}

export const toggleBodyPart = (parts: readonly BodyPart[], part: BodyPart): BodyPart[] => (parts.includes(part) ? parts.filter((entry) => entry !== part) : BODY_PARTS.filter((entry) => entry === part || parts.includes(entry)))

// ---- the edit of the report (EditModeBar) ----------------------------------------------------------------------------------

export interface EditDraft {
  readonly kind: IncidentKind
  readonly what: string
  readonly occurredAt: string
  readonly place: string
  readonly immediateAction: string
  readonly severity: IncidentSeverity | null
}

export const editDraftOf = (record: IncidentRecord): EditDraft => ({ kind: record.kind, what: record.what, occurredAt: record.occurredAt, place: record.place ?? '', immediateAction: record.immediateAction ?? '', severity: record.severity })

/** What an edit sends: only the fields that changed (none: nothing to save). */
export function editBody(record: IncidentRecord, draft: EditDraft): EditBody | null {
  const body: { -readonly [K in keyof EditBody]?: EditBody[K] } = {}
  if (draft.kind !== record.kind) body.kind = draft.kind
  if (draft.what.trim() !== record.what) body.what = draft.what.trim()
  if (draft.occurredAt && new Date(draft.occurredAt).getTime() !== new Date(record.occurredAt).getTime()) body.occurredAt = new Date(draft.occurredAt).toISOString()
  if (draft.place.trim() !== (record.place ?? '')) body.place = draft.place.trim() || null
  if (draft.immediateAction.trim() !== (record.immediateAction ?? '')) body.immediateAction = draft.immediateAction.trim() || null
  if (draft.severity !== record.severity) body.severity = draft.severity
  return Object.keys(body).length === 0 ? null : { version: record.version, ...body }
}

export function editDraftHeld(record: IncidentRecord, draft: EditDraft): string | null {
  if (!draft.what.trim()) return 'held.report.what'
  if (draft.kind !== 'INJURY' && record.people.injured > 0) return 'refusal.STAYS_INJURY'
  if (!record.station && !record.machine && !record.area && !draft.place.trim()) return 'refusal.WHERE_MISSING'
  return null
}

export const EDIT_SEVERITIES = INCIDENT_SEVERITIES
export const EDIT_KINDS = INCIDENT_KINDS

// ---- the actions -----------------------------------------------------------------------------------------------------------

export type MakeInto = 'NONE' | 'MAINTENANCE_JOB' | 'RISK_MEASURE' | 'TRAINING_SESSION'

export interface ActionDraft {
  readonly title: string
  readonly dueOn: string
  readonly mine: boolean
  readonly into: MakeInto
  readonly machineId: string | null
  readonly priority: 'P1' | 'P2' | 'P3' | null
  readonly problem: string
  readonly risk: string
  readonly evidenceNote: string
  readonly reason: string
}

export const newActionDraft = (into: MakeInto = 'NONE', machineId: string | null = null): ActionDraft => ({ title: '', dueOn: '', mine: false, into, machineId, priority: null, problem: '', risk: '', evidenceNote: '', reason: '' })

/**
 * Plan training is held in words: the API makes the session in one step, but no route lists the safety courses yet (the
 * Safety training page, B-W2b-133/-139, brings them): the person plans it there.
 */
export const TRAINING_HELD = 'held.trainingLater'

/** Make into …: the record it makes, in one step (design "'Make a job', 'Add to improvement plan', 'Plan training'"). */
export function makeHeld(into: MakeInto, draft: Pick<ActionDraft, 'machineId'>, record: Pick<IncidentRecord, 'machine'>): string | null {
  if (into === 'TRAINING_SESSION') return TRAINING_HELD
  if (into === 'MAINTENANCE_JOB' && !draft.machineId && !record.machine) return 'refusal.NO_MACHINE'
  return null
}

export function makeBodyOf(draft: ActionDraft, record: Pick<IncidentRecord, 'machine'>): MakeBody | undefined {
  if (draft.into === 'MAINTENANCE_JOB') {
    const machineId = draft.machineId ?? record.machine?.id
    return { into: 'MAINTENANCE_JOB', ...(machineId ? { machineId } : {}), type: 'SAFETY', ...(draft.priority ? { priority: draft.priority } : {}), ...(draft.problem.trim() ? { problem: draft.problem.trim() } : {}) }
  }
  if (draft.into === 'RISK_MEASURE') return { into: 'RISK_MEASURE', ...(draft.risk.trim() ? { risk: draft.risk.trim() } : {}) }
  return undefined
}

export function newActionHeld(draft: ActionDraft, record: IncidentRecord): string | null {
  const held = actionsHeld(record)
  if (held) return held
  if (!draft.title.trim()) return 'held.action.title'
  if (draft.title.trim().length > INCIDENT_LIMITS.title) return 'held.action.titleLong'
  return draft.into === 'NONE' ? null : makeHeld(draft.into, draft, record)
}

export function newActionBody(draft: ActionDraft, record: IncidentRecord, userId: string): { title: string; ownerId?: string; dueOn?: string; make?: MakeBody } {
  const make = makeBodyOf(draft, record)
  return { title: draft.title.trim(), ...(draft.mine ? { ownerId: userId } : {}), ...(draft.dueOn ? { dueOn: draft.dueOn } : {}), ...(make ? { make } : {}) }
}

/** Where an action's made record opens (its own page once built, else its panels). */
export const madeRecordKey = (action: Pick<IncidentAction, 'madeInto'>): string => (action.madeInto ? `madeInto.${action.madeInto}` : 'madeInto.none')

// ---- INAIL filings ---------------------------------------------------------------------------------------------------------

export interface FilingDraft {
  /** `new`: a person and the absence (the API decides the type); else the filing being recorded. */
  readonly filingId: string | 'new'
  readonly personId: string | null
  readonly expectedAbsenceDays: string
  readonly actualAbsenceDays: string
  readonly certificateReference: string
  readonly certificateReceivedAt: string
  readonly filedAt: string
  readonly protocolNumber: string
  readonly receipt: File | null
}

export function filingDraftOf(filing: InailFiling | null, injured: readonly IncidentPerson[]): FilingDraft {
  if (!filing) return { filingId: 'new', personId: injured.length === 1 ? injured[0]!.id : null, expectedAbsenceDays: '', actualAbsenceDays: '', certificateReference: '', certificateReceivedAt: '', filedAt: '', protocolNumber: '', receipt: null }
  return {
    filingId: filing.id,
    personId: filing.personId,
    expectedAbsenceDays: filing.expectedAbsenceDays === null ? '' : String(filing.expectedAbsenceDays),
    actualAbsenceDays: filing.actualAbsenceDays === null ? '' : String(filing.actualAbsenceDays),
    certificateReference: filing.certificateReference ?? '',
    certificateReceivedAt: filing.certificateReceivedAt ?? '',
    filedAt: filing.filedAt ?? '',
    protocolNumber: filing.protocolNumber ?? '',
    receipt: null,
  }
}

const days = (value: string): number | null => (/^\d{1,4}$/.test(value.trim()) ? Number(value.trim()) : null)

/** The filing an absence calls for, said before it is sent (the API decides; null: none needed). */
export function filingTypeFor(absence: string): 'STATISTICAL' | 'INSURANCE' | null {
  const count = days(absence)
  if (count === null) return null
  if (count > INAIL_RULE.insuranceAboveDays) return 'INSURANCE'
  if (count >= INAIL_RULE.statisticalFromDays) return 'STATISTICAL'
  return null
}

/** The injured people of the company a filing is for (FILING_NOT_EMPLOYEE otherwise). */
export const filingPeople = (people: readonly IncidentPerson[]): IncidentPerson[] => people.filter((person) => person.involvement === 'INJURED' && person.employee !== null)

/** Record filing (design pop:filing): the holds in our words, the same order as the API. */
export function filingDraftHeld(draft: FilingDraft, filing: InailFiling | null, facts: { occurredAt: string; now: Date }): string | null {
  // A filing recorded as filed takes only INAIL's receipt now.
  if (filing?.status === 'FILED') return draft.receipt ? null : 'refusal.FILING_FILED'
  if (draft.filingId === 'new') {
    if (!draft.personId) return 'held.filing.person'
    const absence = days(draft.expectedAbsenceDays)
    if (absence === null) return 'held.filing.absence'
    if (filingTypeFor(draft.expectedAbsenceDays) === null) return 'refusal.NO_FILING_NEEDED'
  } else {
    if (draft.expectedAbsenceDays.trim() && days(draft.expectedAbsenceDays) === null) return 'held.filing.absence'
    if (draft.actualAbsenceDays.trim() && days(draft.actualAbsenceDays) === null) return 'held.filing.absence'
  }
  if (draft.certificateReceivedAt) {
    const at = new Date(draft.certificateReceivedAt).getTime()
    if (at > facts.now.getTime() + 60_000) return 'refusal.CERTIFICATE_IN_FUTURE'
    if (at < new Date(facts.occurredAt).getTime()) return 'refusal.CERTIFICATE_BEFORE_EVENT'
  }
  const filing_ = draft.filedAt || draft.protocolNumber.trim()
  if (filing_) {
    if (!draft.certificateReceivedAt) return 'refusal.CERTIFICATE_MISSING'
    if (!draft.filedAt) return 'held.filing.filedAt'
    if (!draft.protocolNumber.trim()) return 'held.filing.protocol'
    const filed = new Date(draft.filedAt).getTime()
    if (filed > facts.now.getTime() + 60_000) return 'refusal.FILED_IN_FUTURE'
    if (filed < new Date(draft.certificateReceivedAt).getTime()) return 'refusal.FILED_BEFORE_CERTIFICATE'
  }
  if (draft.receipt && !filing_) return 'held.filing.receiptAfter'
  return null
}

/** The calls a recorded filing makes, in order: the absence and the certificate, then the filing, then the receipt. */
export interface FilingPlan {
  readonly add: { incidentPersonId: string; expectedAbsenceDays: number; certificateReference?: string; certificateReceivedAt?: string } | null
  readonly edit: { expectedAbsenceDays?: number | null; actualAbsenceDays?: number | null; certificateReference?: string | null; certificateReceivedAt?: string } | null
  readonly file: { filedAt: string; protocolNumber: string } | null
  readonly receipt: File | null
}

export function filingPlan(draft: FilingDraft, filing: InailFiling | null): FilingPlan {
  const file = draft.filedAt && draft.protocolNumber.trim() && filing?.status !== 'FILED' ? { filedAt: new Date(draft.filedAt).toISOString(), protocolNumber: draft.protocolNumber.trim() } : null
  if (draft.filingId === 'new' || !filing) {
    return {
      add: {
        incidentPersonId: draft.personId ?? '',
        expectedAbsenceDays: days(draft.expectedAbsenceDays) ?? 0,
        ...(draft.certificateReference.trim() ? { certificateReference: draft.certificateReference.trim() } : {}),
        ...(draft.certificateReceivedAt ? { certificateReceivedAt: new Date(draft.certificateReceivedAt).toISOString() } : {}),
      },
      edit: null,
      file,
      receipt: draft.receipt,
    }
  }
  const edit: { -readonly [K in keyof NonNullable<FilingPlan['edit']>]?: NonNullable<FilingPlan['edit']>[K] } = {}
  const expected = draft.expectedAbsenceDays.trim() ? days(draft.expectedAbsenceDays) : null
  const actual = draft.actualAbsenceDays.trim() ? days(draft.actualAbsenceDays) : null
  if (expected !== filing.expectedAbsenceDays) edit.expectedAbsenceDays = expected
  if (actual !== filing.actualAbsenceDays) edit.actualAbsenceDays = actual
  if (draft.certificateReference.trim() !== (filing.certificateReference ?? '')) edit.certificateReference = draft.certificateReference.trim() || null
  if (draft.certificateReceivedAt && (!filing.certificateReceivedAt || new Date(draft.certificateReceivedAt).getTime() !== new Date(filing.certificateReceivedAt).getTime())) edit.certificateReceivedAt = new Date(draft.certificateReceivedAt).toISOString()
  return { add: null, edit: filing.status === 'FILED' || Object.keys(edit).length === 0 ? null : edit, file, receipt: draft.receipt }
}

/** Nothing to send. */
export const planEmpty = (plan: FilingPlan): boolean => !plan.add && !plan.edit && !plan.file && !plan.receipt

// ---- the API's refusals in our words ----------------------------------------------------------------------------------------

export interface Problem {
  readonly key: string
  readonly field: string | null
}

const REFUSALS: ReadonlySet<string> = new Set(INCIDENT_REFUSALS)

export function problemOf(error: unknown): Problem {
  if (!isApiError(error)) return { key: 'problem.unavailable', field: null }
  let refusal: string | null = null
  let field: string | null = null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/') && !refusal) {
      const code = path.slice('refusal/'.length)
      if (REFUSALS.has(code)) refusal = code
    } else if (/^body[./]/.test(path) && !field) {
      field = path.replace(/^body[./]/, '').split(/[./]/)[0] || null
    }
  }
  if (refusal) return { key: `refusal.${refusal}`, field }
  switch (error.kind) {
    case 'invalid':
      return { key: field ? 'problem.field' : 'problem.invalid', field }
    case 'signed_out':
      return { key: 'problem.signedOut', field: null }
    case 'forbidden':
      return { key: 'problem.forbidden', field: null }
    case 'not_found':
      return { key: 'problem.notFound', field: null }
    case 'conflict':
      return { key: 'problem.conflict', field: null }
    case 'rate_limited':
      return { key: 'problem.rateLimited', field: null }
    case 'contract':
      return { key: 'problem.contract', field: null }
    case 'unavailable':
      return { key: error.code === 'network' ? 'problem.noAnswer' : 'problem.unavailable', field: null }
    default:
      return { key: 'problem.internal', field: null }
  }
}

/** A read that failed, in words (a section says it and offers Try again; never drawn as empty). */
export function readProblemOf(error: unknown): string {
  const problem = problemOf(error)
  if (problem.key === 'problem.forbidden' || problem.key === 'problem.signedOut' || problem.key === 'problem.notFound') return problem.key
  return 'problem.read'
}

// ---- live ------------------------------------------------------------------------------------------------------------------

const INCIDENT_EVENTS = new Set(['incident.reported', 'incident.changed', 'incident.seen', 'incident_action.changed', 'inail_filing.changed'])

/** Whether a live change moves this page (the list, the tiles, the banner), and which incident (the record re-reads its own). */
export function incidentOfChange(change: { readonly type: string; readonly fields: Readonly<Record<string, unknown>> }): { moves: boolean; incidentId: string | null } {
  if (!INCIDENT_EVENTS.has(change.type)) return { moves: false, incidentId: null }
  const id = change.fields.incidentId
  return { moves: true, incidentId: typeof id === 'string' ? id : null }
}

// ---- people in words (only what a protected read handed the page) ----------------------------------------------------------

export const personName = (person: Pick<IncidentPerson, 'employee' | 'outsideName'>): string => person.employee?.name ?? person.outsideName ?? ''
