import { isApiError, issuePath } from '../../../lib/api/errors'
import {
  clinicalWordsIn,
  HEALTH_LIMITS,
  HEALTH_REFUSALS,
  JUDGEMENT_STATES,
  VISIT_TYPES,
  type FitnessOutcome,
  type JudgementState,
  type VisitCancelReason,
  type VisitState,
  type VisitType,
  type VoidReason,
} from '@nexus/factory-domain/safety/health/rules'
import type { Tone } from '@nexus/ui/primitives'
import type { HealthPlan, JudgementBody, JudgementFilter, PlanBody, PlanItem, Proposal, VisitQuery, VisitRow } from './api'

/**
 * Plant › Health & safety › Health surveillance (SCR-212; B-W2b-148), pure: who may do what, the page's address (the tiles, the
 * due list's status and type, the judgements' state, the dialogs and windows by id — never a name or a value), the tiles as
 * filters of the due list, which rows may be chosen, every button's hold in words, the dialogs' drafts and the bodies they send,
 * the API's refusals in our words, what a live event re-reads. Nothing here holds a person beyond what a recorded read handed
 * the page.
 */

export const HEALTH_PATH = '/plant/health'

/** The page's words for a moment: `{ key, params }` (a held reason, a problem, a notice). */
export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

// ---- who may do what -------------------------------------------------------------------------------------------------------

export interface HealthCan {
  /** safety.health.view: the protected page (the frame, the due list, the judgements; each named read recorded). */
  readonly view: boolean
  /** safety.health.manage: plan, book, move, cancel, done; record and void judgements; their copies. */
  readonly manage: boolean
  /** safety.health.plans: a plan's frequency, doctor and end-of-employment visit. */
  readonly plans: boolean
  /** safety.health.views: "Who looked" (HR and the data protection officer). */
  readonly views: boolean
  /** safety.view: the plans per role (no person in a plan) and the doctors of the safety organisation. */
  readonly plansRead: boolean
  /** safety.organisation.manage: the company's staff list (a person by hand: Record a judgement, a visit by hand). */
  readonly pickPeople: boolean
}

export function healthCan(permissions: Iterable<string>): HealthCan {
  const held = new Set(permissions)
  return {
    view: held.has('safety.health.view'),
    manage: held.has('safety.health.manage'),
    plans: held.has('safety.health.plans'),
    views: held.has('safety.health.views'),
    plansRead: held.has('safety.view'),
    pickPeople: held.has('safety.organisation.manage'),
  }
}

/**
 * What the page opens to: the whole protected page (safety.health.view); the plans and the view log only (the safety officer
 * keeps the plans, the data protection officer reads the log: neither sees a person's health data); nothing.
 */
export function pageMode(can: HealthCan): 'full' | 'limited' | 'none' {
  if (can.view) return 'full'
  if ((can.plans && can.plansRead) || can.views) return 'limited'
  return 'none'
}

// ---- the address (filters and which dialog or window: ids only, never a name or a value) -------------------------------------

export const DUE_STATUSES = ['open', 'done', 'cancelled', 'all'] as const
export type DueStatus = (typeof DUE_STATUSES)[number]
export const TILES = ['overdue', 'dueIn30', 'beforeTask', 'returnVisits', 'unfitEnding'] as const
export type TileId = (typeof TILES)[number]
/** The tiles that filter the due list (the unfit ending in 14 days are judgements: their tile says where to look). */
export const FILTER_TILES = ['overdue', 'dueIn30', 'beforeTask', 'returnVisits'] as const satisfies readonly TileId[]
export type FilterTile = (typeof FILTER_TILES)[number]
export const JUDGEMENT_FILTERS = ['current', 'all', ...JUDGEMENT_STATES] as const satisfies readonly JudgementFilter[]

export interface HealthAddress {
  readonly tile: FilterTile | null
  /** The due list's API status (null: open). */
  readonly status: DueStatus | null
  readonly type: VisitType | null
  /** The judgements' state (null: current). */
  readonly jstate: JudgementFilter | null
  /** Record a judgement: '1', or the visit it comes from. */
  readonly judge: string | null
  readonly planVisits: boolean
  readonly visit: string | null
  readonly judgement: string | null
  /** A role's plan to edit. */
  readonly plan: string | null
}

export const EMPTY_ADDRESS: HealthAddress = Object.freeze({ tile: null, status: null, type: null, jstate: null, judge: null, planVisits: false, visit: null, judgement: null, plan: null })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const idOf = (value: string | null | undefined): string | null => (value && UUID.test(value) ? value : null)
const oneOf = <T extends string>(list: readonly T[], value: string | null | undefined): T | null => (value && (list as readonly string[]).includes(value) ? (value as T) : null)

export function addressOf(params: Pick<URLSearchParams, 'get'> | null): HealthAddress {
  if (!params) return EMPTY_ADDRESS
  const judge = params.get('judge')
  return {
    tile: oneOf(FILTER_TILES, params.get('tile')),
    status: oneOf(DUE_STATUSES, params.get('status')),
    type: oneOf(VISIT_TYPES, params.get('type')),
    jstate: oneOf(JUDGEMENT_FILTERS, params.get('jstate')),
    judge: judge === '1' ? '1' : idOf(judge),
    planVisits: params.get('planVisits') === '1',
    visit: idOf(params.get('visit')),
    judgement: idOf(params.get('judgement')),
    plan: idOf(params.get('plan')),
  }
}

export function addressTerms(address: HealthAddress): string {
  const query = new URLSearchParams()
  if (address.tile) query.set('tile', address.tile)
  if (address.status && address.status !== 'open') query.set('status', address.status)
  if (address.type) query.set('type', address.type)
  if (address.jstate && address.jstate !== 'current') query.set('jstate', address.jstate)
  if (address.judge) query.set('judge', address.judge)
  if (address.planVisits) query.set('planVisits', '1')
  if (address.visit) query.set('visit', address.visit)
  if (address.judgement) query.set('judgement', address.judgement)
  if (address.plan) query.set('plan', address.plan)
  const text = query.toString()
  return text ? `?${text}` : ''
}

export const withAddress = (address: HealthAddress, change: Partial<HealthAddress>): HealthAddress => ({ ...address, ...change })

/** The due list's read: the API's own filters (the tiles filter the rows read, so a tile asks nothing more). */
export const visitQueryOf = (address: HealthAddress, siteId: string | null): VisitQuery => ({ siteId, status: address.status ?? 'open', type: address.type })
export const judgementFilterOf = (address: HealthAddress): JudgementFilter => address.jstate ?? 'current'
export const dueFiltered = (address: HealthAddress): boolean => Boolean(address.tile || (address.status && address.status !== 'open') || address.type)

// ---- days ---------------------------------------------------------------------------------------------------------------------

const dayNumber = (day: string): number => Math.round(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000)
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from)
export const isDay = (value: string | null | undefined): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(dayNumber(value)))
export const todayIn = (timeZone: string, at: Date = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)

// ---- the tiles ----------------------------------------------------------------------------------------------------------------

export const isOpen = (row: Pick<VisitRow, 'status'>): boolean => row.status === 'DUE' || row.status === 'BOOKED'
const beforeTask = (type: VisitType): boolean => type === 'PREVENTIVE' || type === 'CHANGE_OF_TASK'

/** Whether a row of the due list is one a tile counts (the API's healthTiles, row by row). */
export function inTile(row: VisitRow, tile: FilterTile, today: string): boolean {
  if (!isOpen(row)) return false
  switch (tile) {
    case 'overdue':
      return row.state === 'OVERDUE'
    case 'dueIn30':
      return row.state !== 'OVERDUE' && daysBetween(today, row.booked?.on ?? row.dueOn) <= HEALTH_LIMITS.expiringDays
    case 'beforeTask':
      return beforeTask(row.type)
    case 'returnVisits':
      return row.type === 'RETURN_AFTER_ABSENCE'
  }
}

export const tileRows = (rows: readonly VisitRow[], tile: FilterTile | null, today: string): VisitRow[] => (tile ? rows.filter((row) => inTile(row, tile, today)) : [...rows])
export const isFilterTile = (tile: TileId): tile is FilterTile => (FILTER_TILES as readonly string[]).includes(tile)

/** Pressing a tile: its filter on (the open visits), or off again. */
export function tileChange(tile: FilterTile, address: HealthAddress): Partial<HealthAddress> {
  if (address.tile === tile) return { tile: null }
  return { tile, status: null, type: null }
}

// ---- tones --------------------------------------------------------------------------------------------------------------------

export const VISIT_STATE_TONE: Readonly<Record<VisitState, Tone>> = Object.freeze({ OVERDUE: 'danger', DUE_SOON: 'warning', PLANNED: 'neutral', BOOKED: 'info', DONE: 'success', CANCELLED: 'neutral' })
export const JUDGEMENT_STATE_TONE: Readonly<Record<JudgementState, Tone>> = Object.freeze({ IN_FORCE: 'success', EXPIRING: 'warning', EXPIRED: 'danger', SUPERSEDED: 'neutral', VOIDED: 'neutral' })
export const OUTCOME_TONE: Readonly<Record<FitnessOutcome, Tone>> = Object.freeze({ FIT: 'success', FIT_WITH_LIMITS: 'info', TEMPORARILY_UNFIT: 'warning', UNFIT: 'danger' })

/** The due day a visit counts from (a booked one from its booked day), as the API's visitStateOf. */
export const dueDayOf = (row: Pick<VisitRow, 'dueOn' | 'booked'>): string => row.booked?.on ?? row.dueOn

// ---- the due list's selection and Mark booked ---------------------------------------------------------------------------------

/** Only an open visit (due or booked) may be chosen: Mark booked and the doctor's print take open visits. */
export const visitSelectHeld = (row: VisitRow): string | null => (isOpen(row) ? null : 'held.select.closed')

export interface BookDraft {
  readonly on: string
  readonly place: string
}

export const newBookDraft = (): BookDraft => ({ on: '', place: '' })

/** Mark booked: a day from today on, a place of at most 200 characters; at most 100 visits at once. */
export function bookHeld(rows: readonly VisitRow[], draft: BookDraft, today: string): Words | null {
  if (rows.length === 0) return { key: 'held.book.none' }
  if (rows.length > HEALTH_LIMITS.items) return { key: 'held.book.tooMany', params: { most: HEALTH_LIMITS.items } }
  if (!isDay(draft.on)) return { key: 'held.book.day' }
  if (draft.on < today) return { key: 'refusal.BOOKED_IN_PAST' }
  if (draft.place.trim().length > HEALTH_LIMITS.bookedPlace) return { key: 'held.book.place', params: { most: HEALTH_LIMITS.bookedPlace } }
  return null
}

export function bookBody(rows: readonly VisitRow[], draft: BookDraft): { visits: { id: string; version: number }[]; bookedOn: string; bookedPlace?: string } {
  const place = draft.place.trim()
  return { visits: rows.map((row) => ({ id: row.id, version: row.version })), bookedOn: draft.on, ...(place ? { bookedPlace: place } : {}) }
}

// ---- one visit: its moves -----------------------------------------------------------------------------------------------------

export type VisitMoveKind = 'move' | 'unbook' | 'cancel' | 'done' | 'book'

export interface VisitMoveDraft {
  readonly kind: VisitMoveKind
  readonly day: string
  readonly place: string
  readonly reason: VisitCancelReason | null
}

export const newMoveDraft = (kind: VisitMoveKind, today: string, row?: Pick<VisitRow, 'dueOn' | 'booked'>): VisitMoveDraft => ({
  kind,
  day: kind === 'done' ? today : kind === 'move' ? (row?.dueOn ?? '') : kind === 'book' ? (row?.booked?.on ?? '') : '',
  place: kind === 'book' ? (row?.booked?.place ?? '') : '',
  reason: null,
})

/** What a visit's move asks before it is sent (the API's refusals said first, in words). */
export function moveHeld(row: Pick<VisitRow, 'status' | 'dueOn'>, draft: VisitMoveDraft, today: string): Words | null {
  if (row.status === 'DONE' || row.status === 'CANCELLED') return { key: 'refusal.VISIT_CLOSED' }
  switch (draft.kind) {
    case 'unbook':
      return row.status === 'BOOKED' ? null : { key: 'refusal.VISIT_NOT_BOOKED' }
    case 'move':
      if (!isDay(draft.day)) return { key: 'held.move.day' }
      return draft.day === row.dueOn ? { key: 'held.move.same' } : null
    case 'cancel':
      return draft.reason ? null : { key: 'held.cancel.reason' }
    case 'done':
      if (!isDay(draft.day)) return { key: 'held.done.day' }
      return draft.day > today ? { key: 'held.done.future' } : null
    case 'book':
      if (!isDay(draft.day)) return { key: 'held.book.day' }
      if (draft.day < today) return { key: 'refusal.BOOKED_IN_PAST' }
      return draft.place.trim().length > HEALTH_LIMITS.bookedPlace ? { key: 'held.book.place', params: { most: HEALTH_LIMITS.bookedPlace } } : null
  }
}

// ---- Record a judgement ------------------------------------------------------------------------------------------------------

export interface JudgementDraft {
  /** From an open visit of the due list, or a person by hand (HR: the staff list). */
  readonly from: 'visit' | 'person'
  readonly visitId: string | null
  readonly employeeId: string | null
  readonly outcome: FitnessOutcome | null
  readonly taskLimits: string
  readonly unfitUntil: string
  readonly judgedOn: string
  readonly expiresOn: string
}

export const newJudgementDraft = (today: string, visit?: Pick<VisitRow, 'id' | 'employee'> | null): JudgementDraft => ({
  from: 'visit',
  visitId: visit?.id ?? null,
  employeeId: visit?.employee.id ?? null,
  outcome: null,
  taskLimits: '',
  unfitUntil: '',
  judgedOn: today,
  expiresOn: '',
})

/** The medical words a task limit names (the API refuses them: "Never the medical reason"). */
export const clinicalWords = (text: string): string[] => clinicalWordsIn(text)

/** Save judgement is held until the judgement is whole, in words; the API's own rules said before the call. */
export function judgementHeld(draft: JudgementDraft, today: string): Words | null {
  if (!draft.employeeId) return { key: draft.from === 'visit' ? 'held.judgement.visit' : 'held.judgement.person' }
  if (!draft.outcome) return { key: 'held.judgement.outcome' }
  const limits = draft.taskLimits.trim()
  if (draft.outcome === 'FIT_WITH_LIMITS') {
    if (!limits) return { key: 'held.judgement.limits' }
    if (limits.length > HEALTH_LIMITS.taskLimits) return { key: 'held.judgement.limitsLong', params: { most: HEALTH_LIMITS.taskLimits } }
    const words = clinicalWords(limits)
    if (words.length > 0) return { key: 'held.judgement.clinical', params: { words: words.join(', ') } }
  }
  if (!isDay(draft.judgedOn)) return { key: 'held.judgement.day' }
  if (draft.judgedOn > today) return { key: 'held.judgement.future' }
  if (draft.outcome === 'TEMPORARILY_UNFIT') {
    if (!isDay(draft.unfitUntil)) return { key: 'held.judgement.unfitUntil' }
    if (draft.unfitUntil <= draft.judgedOn) return { key: 'held.judgement.unfitAfter' }
  }
  if (draft.outcome !== 'UNFIT' && draft.expiresOn && (!isDay(draft.expiresOn) || draft.expiresOn <= draft.judgedOn)) return { key: 'held.judgement.expiresAfter' }
  return null
}

/** What Save judgement sends: the limits only with "fit with limits", the day only with "temporarily unfit", no expiry for "unfit". */
export function judgementBody(draft: JudgementDraft): JudgementBody {
  const outcome = draft.outcome!
  return {
    employeeId: draft.employeeId!,
    ...(draft.from === 'visit' && draft.visitId ? { visitId: draft.visitId } : {}),
    outcome,
    ...(outcome === 'FIT_WITH_LIMITS' ? { taskLimits: draft.taskLimits.trim() } : {}),
    ...(outcome === 'TEMPORARILY_UNFIT' ? { unfitUntil: draft.unfitUntil } : {}),
    judgedOn: draft.judgedOn,
    ...(outcome !== 'UNFIT' && draft.expiresOn ? { expiresOn: draft.expiresOn } : {}),
  }
}

/** A copy of the doctor's judgement: a PDF or a picture of the paper, at most 20 MB. */
export const COPY_ACCEPT = '.pdf,.jpg,.jpeg,.png'
export const COPY_MOST_BYTES = 20 * 1024 * 1024

// ---- the copy window ---------------------------------------------------------------------------------------------------------

/** What a copy is, from its first bytes: `%PDF`, a PNG or a JPEG (its name is never trusted or shown). */
export function copyKindOf(bytes: Uint8Array): 'pdf' | 'image' | null {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf'
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image'
  return null
}

// ---- Plan visits --------------------------------------------------------------------------------------------------------------

export const proposalKey = (proposal: Pick<Proposal, 'employee' | 'type'>): string => `${proposal.employee.id}:${proposal.type}`

/** A visit planned by hand: on request (art. 41 c.1 c), or the return after more than 60 days away with its length only. */
export const BY_HAND_TYPES = ['ON_REQUEST', 'RETURN_AFTER_ABSENCE'] as const satisfies readonly VisitType[]
export type ByHandType = (typeof BY_HAND_TYPES)[number]

export interface ByHandDraft {
  readonly key: string
  readonly employeeId: string | null
  readonly name: string
  readonly type: ByHandType
  readonly dueOn: string
  readonly absenceDays: string
}

export const newByHand = (key: string, today: string): ByHandDraft => ({ key, employeeId: null, name: '', type: 'ON_REQUEST', dueOn: today, absenceDays: '' })

const absenceOf = (text: string): number | null => (/^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) : null)

export function byHandHeld(item: ByHandDraft): Words | null {
  if (!item.employeeId) return { key: 'held.plan.person' }
  if (!isDay(item.dueOn)) return { key: 'held.plan.day' }
  if (item.type === 'RETURN_AFTER_ABSENCE') {
    const days = absenceOf(item.absenceDays)
    if (days === null || days < HEALTH_LIMITS.absenceDaysMin || days > HEALTH_LIMITS.absenceDaysMax) return { key: 'held.plan.absence', params: { least: HEALTH_LIMITS.absenceDaysMin, most: HEALTH_LIMITS.absenceDaysMax } }
  }
  return null
}

/** The items "Plan N visits" sends: the chosen proposals (with their role), then the visits by hand. */
export function planItemsOf(proposals: readonly Proposal[], chosen: ReadonlySet<string>, byHand: readonly ByHandDraft[]): PlanItem[] {
  return [
    ...proposals.filter((proposal) => chosen.has(proposalKey(proposal))).map((proposal) => ({ employeeId: proposal.employee.id, type: proposal.type, dueOn: proposal.dueOn, roleSheetId: proposal.role.id })),
    ...byHand.map((item) => ({ employeeId: item.employeeId!, type: item.type, dueOn: item.dueOn, ...(item.type === 'RETURN_AFTER_ABSENCE' ? { absenceDays: absenceOf(item.absenceDays)! } : {}) })),
  ]
}

export function planVisitsHeld(proposals: readonly Proposal[], chosen: ReadonlySet<string>, byHand: readonly ByHandDraft[]): Words | null {
  for (const item of byHand) {
    const held = byHandHeld(item)
    if (held) return held
  }
  const count = proposals.filter((proposal) => chosen.has(proposalKey(proposal))).length + byHand.length
  if (count === 0) return { key: 'held.plan.none' }
  if (count > HEALTH_LIMITS.items) return { key: 'held.plan.tooMany', params: { most: HEALTH_LIMITS.items } }
  return null
}

// ---- a role's plan ------------------------------------------------------------------------------------------------------------

export interface PlanDraft {
  readonly frequency: string
  readonly endOfEmployment: boolean
  /** The doctor's appointment ('' = none named). */
  readonly doctorId: string
  readonly setOn: string
}

export const planDraftOf = (plan: HealthPlan, today: string): PlanDraft => ({ frequency: plan.frequencyMonths === null ? '' : String(plan.frequencyMonths), endOfEmployment: plan.endOfEmploymentVisit, doctorId: plan.doctor?.id ?? '', setOn: today })

const frequencyOf = (text: string): number | null => (/^\d{1,2}$/.test(text.trim()) ? Number(text.trim()) : null)

/** What Save sends: only what changed, at the version read; null when nothing did. */
export function planBody(plan: HealthPlan, draft: PlanDraft): PlanBody | null {
  const frequency = frequencyOf(draft.frequency)
  const body: { -readonly [K in keyof PlanBody]: PlanBody[K] } = { version: plan.version }
  if (frequency !== null && frequency !== plan.frequencyMonths) body.frequencyMonths = frequency
  if (draft.endOfEmployment !== plan.endOfEmploymentVisit) body.endOfEmploymentVisit = draft.endOfEmployment
  if ((draft.doctorId || null) !== (plan.doctor?.id ?? null)) body.doctorAppointmentId = draft.doctorId || null
  if (Object.keys(body).length === 1) return null
  if (isDay(draft.setOn)) body.setOn = draft.setOn
  return body
}

export function planHeld(plan: HealthPlan, draft: PlanDraft, today: string): Words | null {
  if (!plan.canEdit) return { key: plan.status === 'ARCHIVED' ? 'refusal.PLAN_ARCHIVED' : 'held.plan.noRight' }
  const frequency = frequencyOf(draft.frequency)
  const typed = draft.frequency.trim() !== ''
  if (typed && (frequency === null || frequency < HEALTH_LIMITS.frequencyMin || frequency > HEALTH_LIMITS.frequencyMax)) return { key: 'held.plan.frequency', params: { least: HEALTH_LIMITS.frequencyMin, most: HEALTH_LIMITS.frequencyMax } }
  if (!plan.needed && ((typed && frequency !== plan.frequencyMonths) || (draft.endOfEmployment && !plan.endOfEmploymentVisit))) return { key: 'refusal.PLAN_NOT_NEEDED' }
  if (!isDay(draft.setOn)) return { key: 'held.plan.setOn' }
  if (draft.setOn > today) return { key: 'held.plan.setOnFuture' }
  if (!planBody(plan, draft)) return { key: 'held.plan.unchanged' }
  return null
}

// ---- void ----------------------------------------------------------------------------------------------------------------------

export const voidHeld = (reason: VoidReason | null, voided: boolean): Words | null => (voided ? { key: 'refusal.JUDGEMENT_VOIDED' } : reason ? null : { key: 'held.void.reason' })

// ---- the API's answers in our words -------------------------------------------------------------------------------------------

const REFUSALS: ReadonlySet<string> = new Set(HEALTH_REFUSALS)

export interface Problem {
  readonly key: string
  /** The body field the API named (`taskLimits`, `absenceDays`…). */
  readonly field: string | null
  /** Plan visits: the item it names (`body/items/<i>/…`). */
  readonly item: number | null
  readonly params?: Readonly<Record<string, string | number>>
}

export function problemOf(error: unknown): Problem {
  if (!isApiError(error)) return { key: 'problem.unavailable', field: null, item: null }
  let refusal: string | null = null
  let field: string | null = null
  let item: number | null = null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/') && !refusal) {
      const code = path.slice('refusal/'.length)
      if (REFUSALS.has(code)) refusal = code
    } else if (/^body[./]/.test(path) && field === null) {
      const parts = path.replace(/^body[./]/, '').split(/[./]/)
      if (parts[0] === 'items' && /^\d+$/.test(parts[1] ?? '')) {
        item = Number(parts[1])
        field = parts[2] ?? null
      } else field = parts[0] || null
    }
  }
  if (refusal) return { key: `refusal.${refusal}`, field, item }
  // A task limit naming a medical reason: the API's 400 at body/taskLimits says it; ours names the words the form found.
  switch (error.kind) {
    case 'invalid':
      return { key: field === 'taskLimits' ? 'problem.taskLimits' : field ? 'problem.field' : 'problem.invalid', field, item }
    case 'signed_out':
      return { key: 'problem.signedOut', field: null, item: null }
    case 'forbidden':
      return { key: 'problem.forbidden', field: null, item: null }
    case 'not_found':
      return { key: 'problem.notFound', field: null, item: null }
    case 'conflict':
      return { key: 'problem.conflict', field: null, item: null }
    case 'rate_limited':
      return { key: 'problem.rateLimited', field: null, item: null }
    case 'contract':
      return { key: 'problem.contract', field: null, item: null }
    case 'unavailable':
      return { key: error.code === 'network' ? 'problem.noAnswer' : 'problem.unavailable', field: null, item: null }
    default:
      return { key: 'problem.internal', field: null, item: null }
  }
}

/** A read that failed, in words (a section says it and offers Try again; never drawn as empty). */
export function readProblemOf(error: unknown): string {
  const problem = problemOf(error)
  if (problem.key === 'problem.forbidden' || problem.key === 'problem.signedOut' || problem.key === 'problem.notFound') return problem.key
  return 'problem.read'
}

// ---- live ---------------------------------------------------------------------------------------------------------------------

/** What a live change moves: the visits (the due list, the tiles), the judgements (and the visit a judgement closed), the plans. */
export function healthOfChange(change: { readonly type: string }): { visits: boolean; judgements: boolean; plans: boolean } {
  switch (change.type) {
    case 'health_visit.changed':
      return { visits: true, judgements: false, plans: false }
    case 'fitness_judgement.changed':
      return { visits: true, judgements: true, plans: false }
    case 'health_plan.changed':
      return { visits: false, judgements: false, plans: true }
    default:
      return { visits: false, judgements: false, plans: false }
  }
}

/** A locale's words of a pair the API sends in both languages. */
export const wordsIn = (words: { readonly en: string; readonly it: string }, locale: string): string => (locale === 'it' ? words.it : words.en)
