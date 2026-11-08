import { businessDate } from '@nexus/factory-domain/core/time'
import {
  CAPA_LIMITS,
  CAPA_PRIORITIES,
  CAPA_TYPES,
  CAPA_VIEWS,
  MAX_REMINDERS,
  SOURCE_TYPES,
  STAGES,
  closeChecks,
  isFinal,
  lastStage,
  nextStage,
  type CapaStatus,
  type CloseCheckKey,
} from '@nexus/factory-domain/quality/capa/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { modeOfAddress, withMode, type ListMode } from '../../../list-frame/w2b/model'
import type { ActionChange, ActionKind, CapaAction, CapaPriority, CapaRecord, CapaRow, CapaSource, CapaType, CapaView, EditBody, OpenBody, SourceType } from './api'

/**
 * Corrective actions (SCR-146), pure: the page's address, the rights each screen asks about, the tiles and the board's
 * lanes, what each step needs and why it is held (in OUR words, by code — never the API's English), the drafts of New
 * CAPA, of the Problem form and of an action, what each sends, and a refusal said by its code. No React, no API client.
 */

export const CAPA_NAMESPACE = 'quality-capa'
export const TIME_ZONE = 'Europe/Rome'

/** Words with their parameters, said by the screen in the reader's language. */
export interface Say {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

// ---- rights ---------------------------------------------------------------------------------------------------------------

export const CAPA_PERMISSIONS = {
  view: 'quality.capa.view',
  manage: 'quality.capa.manage',
  ncrView: 'quality.ncr.view',
  complaintsView: 'quality.complaints.view',
  complaintsManage: 'quality.complaints.manage',
  filesRead: 'files.read',
  filesUpload: 'files.upload',
  filesManage: 'files.manage',
  partiesView: 'parties.view',
} as const
export type CapaCan = Readonly<Record<keyof typeof CAPA_PERMISSIONS, boolean>>

export function capaCan(permissions: readonly string[]): CapaCan {
  const held = new Set(permissions)
  return Object.fromEntries(Object.entries(CAPA_PERMISSIONS).map(([name, permission]) => [name, held.has(permission)])) as unknown as CapaCan
}

// ---- the list's address ------------------------------------------------------------------------------------------------------

/** The list modes this page offers: the table and the board by stage (the phone's cards come from the frame). */
export const CAPA_MODES: readonly ListMode[] = ['table', 'board', 'cards']

export interface CapaAddress {
  readonly view: CapaView
  readonly q: string
  readonly type: CapaType | null
  readonly priority: CapaPriority | null
  readonly mode: ListMode
  /** New CAPA (`?new=1`), from records (`&from=Nonconformance|Complaint&ids=<id>,<id>`). */
  readonly isNew: boolean
  readonly from: { readonly recordType: SourceType; readonly ids: readonly string[] } | null
}

export const HOME_ADDRESS: CapaAddress = Object.freeze({ view: 'open', q: '', type: null, priority: null, mode: 'table', isNew: false, from: null })

export function addressOf(params: { get(name: string): string | null } | null | undefined): CapaAddress {
  const view = params?.get('view') ?? ''
  const type = params?.get('type') ?? ''
  const priority = params?.get('priority') ?? ''
  const from = params?.get('from') ?? ''
  const ids = (params?.get('ids') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, CAPA_LIMITS.preview)
  return {
    view: (CAPA_VIEWS as readonly string[]).includes(view) ? (view as CapaView) : 'open',
    q: (params?.get('q') ?? '').slice(0, 100),
    type: (CAPA_TYPES as readonly string[]).includes(type) ? (type as CapaType) : null,
    priority: (CAPA_PRIORITIES as readonly string[]).includes(priority) ? (priority as CapaPriority) : null,
    mode: modeOfAddress(params, CAPA_MODES),
    isNew: params?.get('new') === '1',
    from: (SOURCE_TYPES as readonly string[]).includes(from) && ids.length > 0 ? { recordType: from as SourceType, ids } : null,
  }
}

/** The address terms of a state (`?view=mine&mode=board`); the defaults are left out. */
export function addressText(address: CapaAddress): string {
  const params = new URLSearchParams()
  if (address.view !== 'open') params.set('view', address.view)
  if (address.q.trim()) params.set('q', address.q.trim())
  if (address.type) params.set('type', address.type)
  if (address.priority) params.set('priority', address.priority)
  if (address.isNew) {
    params.set('new', '1')
    if (address.from) {
      params.set('from', address.from.recordType)
      params.set('ids', address.from.ids.join(','))
    }
  }
  const text = withMode(params, address.mode)
  return text ? `?${text}` : ''
}

export const isFiltered = (address: CapaAddress): boolean => address.view !== 'open' || address.q.trim() !== '' || address.type !== null || address.priority !== null

/** New CAPA from records (the NCR list's or a complaint's address into this page). */
export const newCapaAddress = (prefix: string, from?: { recordType: SourceType; ids: readonly string[] }): string =>
  `${prefix}/quality/capa${addressText({ ...HOME_ADDRESS, isNew: true, from: from ?? null })}`

export const recordHref = (prefix: string, capaId: string, tab?: RecordTab, extra?: string): string =>
  `${prefix}/quality/capa/${encodeURIComponent(capaId)}${tab && tab !== 'problem' ? `?tab=${tab}${extra ? `&${extra}` : ''}` : extra ? `?${extra}` : ''}`

/** The 8D report window (design tab:capa-pdf, a new tab). */
export const reportHref = (prefix: string, capaId: string, language?: 'it' | 'en'): string => `${prefix}/quality/capa/report?capa=${encodeURIComponent(capaId)}${language ? `&language=${language}` : ''}`

// ---- tiles and the board ------------------------------------------------------------------------------------------------------

/** The tiles (design capa-metrics; tile = chip): each is a saved row. The W3 tiles (effectiveness, approval, on time) stay out. */
export const CAPA_TILES = [
  { id: 'open', view: 'open' },
  { id: 'actionsOverdue', view: 'overdue' },
  { id: 'mine', view: 'mine' },
] as const satisfies readonly { id: string; view: CapaView }[]

/** The board shows one type at a time (their stages differ): the address's type, else CAPA. */
export const boardTypeOf = (address: Pick<CapaAddress, 'type'>): CapaType => address.type ?? 'CAPA'
export type BoardLane = CapaStatus
export const boardLanesOf = (type: CapaType): BoardLane[] => [...STAGES[type], 'CLOSED']
/** The rows the board draws: its type, never a cancelled one (no lane: the list shows them). */
export const boardRowsOf = (rows: readonly CapaRow[], type: CapaType): CapaRow[] => rows.filter((row) => row.type === type && row.status !== 'CANCELLED')

export type StageTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger'
export function stageTone(status: CapaStatus): StageTone {
  if (status === 'CLOSED') return 'success'
  if (status === 'CANCELLED') return 'neutral'
  if (status === 'PLAN' || status === 'D1' || status === 'D2' || status === 'D3' || status === 'D4') return 'info'
  return 'warning'
}

/** Why a card may not go to a lane (null: it may; a drop on Closed opens the close, which says what is missing). */
export function boardMoveHeld(row: Pick<CapaRow, 'status'>, lane: string, can: Pick<CapaCan, 'manage'>, offline = false): Say | null {
  if (isFinal(row.status)) return { key: 'held.FINAL', params: { stage: row.status } }
  if (!can.manage) return { key: 'held.noManage' }
  if (offline) return { key: 'held.offline' }
  if (lane === row.status) return null
  return null
}

// ---- the close (from a row or a record) ----------------------------------------------------------------------------------------

export interface CloseLine {
  readonly key: CloseCheckKey
  readonly ok: boolean
  readonly say: Say
}

/** What a close needs, from a row's counts (the board) or the record's actions (the record); the API checks it again. */
export function closeLinesOf(facts: { type: CapaType; status: CapaStatus; open: number; done: number }): CloseLine[] {
  const actions = [...Array.from({ length: facts.open }, () => ({ status: 'OPEN' as const })), ...Array.from({ length: facts.done }, () => ({ status: 'DONE' as const }))]
  return closeChecks({ type: facts.type, status: facts.status, actions }).map((check): CloseLine => {
    const state = check.ok ? 'ok' : 'no'
    const say: Say =
      check.key === 'LAST_STAGE'
        ? { key: `close.check.LAST_STAGE.${state}`, params: { stage: lastStage(facts.type) } }
        : check.key === 'NO_OPEN_ACTION'
          ? { key: `close.check.NO_OPEN_ACTION.${state}`, params: { count: facts.open } }
          : { key: `close.check.ACTION_DONE.${state}`, params: { count: facts.done } }
    return { key: check.key, ok: check.ok, say }
  })
}

export const closeLinesOfRow = (row: Pick<CapaRow, 'type' | 'status' | 'actions'>): CloseLine[] => closeLinesOf({ type: row.type, status: row.status, open: row.actions.open, done: row.actions.done })
export const closeLinesOfRecord = (record: CapaRecord): CloseLine[] =>
  closeLinesOf({ type: record.capa.type, status: record.capa.status, open: record.actions.filter((action) => action.status === 'OPEN').length, done: record.actions.filter((action) => action.status === 'DONE').length })

// ---- the record ----------------------------------------------------------------------------------------------------------------

/** The record's tabs (design rec CAPA): the W3 tabs (Root cause, Effectiveness) stay out. */
export const RECORD_TABS = ['problem', 'actions', 'report', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

/** The band's ONE primary: the next stage, else Close at the last stage (null: ended). */
export function primaryOf(capa: Pick<CapaRow, 'type' | 'status'>): { kind: 'move'; to: CapaStatus } | { kind: 'close' } | null {
  if (isFinal(capa.status)) return null
  const next = nextStage(capa.type, capa.status)
  return next ? { kind: 'move', to: next } : { kind: 'close' }
}

/** Why the CAPA itself may not change (its form, its stage, its sources), or null. */
export function editHeld(capa: Pick<CapaRow, 'status'>, can: Pick<CapaCan, 'manage'>): Say | null {
  if (isFinal(capa.status)) return { key: 'held.FINAL', params: { stage: capa.status } }
  if (!can.manage) return { key: 'held.noManage' }
  return null
}

export const addActionHeld = (capa: Pick<CapaRow, 'status'>, actions: readonly CapaAction[], can: Pick<CapaCan, 'manage'>): Say | null =>
  editHeld(capa, can) ?? (actions.length >= CAPA_LIMITS.actions ? { key: 'held.tooManyActions', params: { count: CAPA_LIMITS.actions } } : null)

/** Why an action's cells may not change (an ended CAPA, an ended action, no manage), or null. */
export function actionEditHeld(action: Pick<CapaAction, 'status'>, capa: Pick<CapaRow, 'status'>, can: Pick<CapaCan, 'manage'>): Say | null {
  if (isFinal(capa.status)) return { key: 'held.FINAL', params: { stage: capa.status } }
  if (action.status !== 'OPEN') return { key: 'held.ACTION_ENDED', params: { status: action.status } }
  if (!can.manage) return { key: 'held.noManage' }
  return null
}

/** Done: quality's follow-up, or the action's own owner (quality.capa.view is enough for one's own action). */
export function doneHeld(action: Pick<CapaAction, 'status' | 'ownerId'>, capa: Pick<CapaRow, 'status'>, can: Pick<CapaCan, 'manage' | 'view'>, me: string): Say | null {
  if (isFinal(capa.status)) return { key: 'held.FINAL', params: { stage: capa.status } }
  if (action.status !== 'OPEN') return { key: 'held.ACTION_ENDED', params: { status: action.status } }
  if (!can.manage && action.ownerId !== me) return { key: 'held.notYourAction' }
  return null
}

export function remindHeld(action: Pick<CapaAction, 'status' | 'remindersSent'>, capa: Pick<CapaRow, 'status'>, can: Pick<CapaCan, 'manage'>): Say | null {
  const held = actionEditHeld(action, capa, can)
  if (held) return held
  if (action.remindersSent >= MAX_REMINDERS) return { key: 'held.TOO_MANY_REMINDERS', params: { count: MAX_REMINDERS } }
  return null
}

/** An evidence file goes up before Done: the action open, files.upload, and done allowed for this person. */
export function uploadHeld(action: Pick<CapaAction, 'status' | 'ownerId'>, capa: Pick<CapaRow, 'status'>, can: CapaCan, me: string): Say | null {
  return doneHeld(action, capa, can, me) ?? (can.filesUpload ? null : { key: 'held.noUpload' })
}

/** Remove a source: an NCR decided or closed keeps its CAPA (the API's NCR_KEEPS_CAPA). */
export function removeSourceHeld(source: CapaSource, capa: Pick<CapaRow, 'status'>, can: Pick<CapaCan, 'manage'>): Say | null {
  const held = editHeld(capa, can)
  if (held) return held
  if (source.recordType === 'Nonconformance' && source.record && (source.record.state === 'DECIDED' || source.record.state === 'CLOSED')) return { key: 'held.NCR_KEEPS_CAPA', params: { number: source.record.number } }
  return null
}

export function keepReportHeld(record: Pick<CapaRecord, 'may'>, can: Pick<CapaCan, 'manage'>, offline: boolean): Say | null {
  if (!can.manage || !record.may.report) return { key: 'held.noManage' }
  if (offline) return { key: 'held.offline' }
  return null
}

/**
 * "Share with the customer" (B-W2b-192, on the complaint the 8D answers): a complaint source the reader sees, an 8D, a
 * version kept, quality.complaints.manage and files.manage.
 */
export function shareHeld(source: CapaSource, record: Pick<CapaRecord, 'capa' | 'documents'>, can: CapaCan, offline: boolean): Say | null {
  if (!source.record) return { key: 'held.cannotSee' }
  if (record.capa.type !== 'EIGHT_D') return { key: 'held.shareOnly8D' }
  if (record.documents.length === 0) return { key: 'held.NO_REPORT' }
  if (!can.complaintsManage || !can.filesManage) return { key: 'held.noShare' }
  if (offline) return { key: 'held.offline' }
  return null
}

// ---- dates ------------------------------------------------------------------------------------------------------------------------

/** Today in the factory's zone (a business day, YYYY-MM-DD). */
export const todayOf = (now: string | Date): string => businessDate(typeof now === 'string' ? new Date(now) : now, TIME_ZONE)

/** A business day N days after another. */
export function plusDays(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00.000Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** How a due day reads beside today: overdue by N days, today, in N days. */
export function dueSay(day: string | null, today: string, open = true): Say | null {
  if (!day || !DAY.test(day)) return null
  const diff = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
  if (!open) return null
  if (diff < 0) return { key: 'due.late', params: { count: -diff } }
  if (diff === 0) return { key: 'due.today' }
  return { key: 'due.in', params: { count: diff } }
}

// ---- New CAPA --------------------------------------------------------------------------------------------------------------------

export interface SourcePick {
  readonly recordType: SourceType
  readonly recordId: string
  readonly number: string
  readonly title: string | null
  readonly companyId: string
  /** Why it cannot go (the preview's `held/<CODE>`), else null. */
  readonly held: string | null
}

export interface NewDraft {
  readonly type: CapaType
  readonly title: string
  readonly ownerId: string
  readonly dueOn: string
  readonly priority: CapaPriority
  readonly customerId: string
  readonly customerLabel: string
  readonly problemWhat: string
  readonly sources: readonly SourcePick[]
}

export const emptyNewDraft = (today: string, me: string): NewDraft => ({
  type: 'CAPA',
  title: '',
  ownerId: me,
  dueOn: plusDays(today, 30),
  priority: 'NORMAL',
  customerId: '',
  customerLabel: '',
  problemWhat: '',
  sources: [],
})

/** The New CAPA form's problems by field, in our words (the domain's rules re-stated: title, due today or later, sources). */
export function newDraftProblems(draft: NewDraft, today: string): Readonly<Record<string, Say>> {
  const problems: Record<string, Say> = {}
  if (!draft.title.trim()) problems.title = { key: 'problem.field.title' }
  else if (draft.title.trim().length > CAPA_LIMITS.title) problems.title = { key: 'problem.field.tooLong', params: { count: CAPA_LIMITS.title } }
  if (!DAY.test(draft.dueOn)) problems.dueOn = { key: 'problem.field.dueOn' }
  else if (draft.dueOn < today) problems.dueOn = { key: 'problem.field.dueOnPast' }
  if (draft.problemWhat.trim().length > CAPA_LIMITS.problem) problems.problemWhat = { key: 'problem.field.tooLong', params: { count: CAPA_LIMITS.problem } }
  const held = draft.sources.find((source) => source.held)
  if (held) problems.sources = { key: 'problem.field.sourceHeld', params: { number: held.number } }
  const companies = new Set(draft.sources.map((source) => source.companyId))
  if (companies.size > 1) problems.sources = { key: 'problem.field.sourcesCompanies' }
  return problems
}

/** What New CAPA sends: the company from its sources (else the page's), the caller owns it unless another is named. */
export function newBodyOf(draft: NewDraft, companyId: string | null, me: string): OpenBody {
  const sourceCompany = draft.sources[0]?.companyId ?? null
  return {
    ...(sourceCompany ? {} : companyId ? { companyId } : {}),
    type: draft.type,
    title: draft.title.trim(),
    ...(draft.ownerId && draft.ownerId !== me ? { ownerId: draft.ownerId } : {}),
    dueOn: draft.dueOn,
    priority: draft.priority,
    ...(draft.customerId ? { customerId: draft.customerId } : {}),
    ...(draft.problemWhat.trim() ? { problemWhat: draft.problemWhat.trim() } : {}),
    ...(draft.sources.length > 0 ? { sources: draft.sources.map((source) => ({ recordType: source.recordType, recordId: source.recordId })) } : {}),
  }
}

// ---- the Problem form (D1 team, D2 problem; the head's fields) ----------------------------------------------------------------

export interface ProblemDraft {
  readonly title: string
  readonly ownerId: string
  readonly dueOn: string
  readonly priority: CapaPriority
  readonly customerId: string
  readonly customerLabel: string
  readonly team: readonly { readonly userId: string; readonly role: string }[]
  readonly what: string
  readonly where: string
  readonly when: string
  readonly howMany: string
}

export const problemDraftOf = (capa: CapaRecord['capa']): ProblemDraft => ({
  title: capa.title,
  ownerId: capa.ownerId,
  dueOn: capa.dueOn,
  priority: capa.priority,
  customerId: capa.customer?.id ?? '',
  customerLabel: capa.customer ? `${capa.customer.code} · ${capa.customer.name}` : '',
  team: capa.team.map((member) => ({ userId: member.userId, role: member.role })),
  what: capa.problem.what ?? '',
  where: capa.problem.where ?? '',
  when: capa.problem.when ?? '',
  howMany: capa.problem.howMany ?? '',
})

const words = (value: string): string | null => (value.trim() ? value.trim() : null)
const sameTeam = (a: ProblemDraft['team'], b: ProblemDraft['team']): boolean => a.length === b.length && a.every((member, index) => member.userId === b[index]!.userId && member.role.trim() === b[index]!.role.trim())

/** What the Problem form's Save sends (only what changed; the version is added by the caller). */
export function problemChangesOf(capa: CapaRecord['capa'], draft: ProblemDraft): Omit<EditBody, 'version'> {
  const before = problemDraftOf(capa)
  const changes: Omit<EditBody, 'version'> = {}
  if (draft.title.trim() !== before.title) changes.title = draft.title.trim()
  if (draft.ownerId !== before.ownerId && draft.ownerId) changes.ownerId = draft.ownerId
  if (draft.dueOn !== before.dueOn) changes.dueOn = draft.dueOn
  if (draft.priority !== before.priority) changes.priority = draft.priority
  if (draft.customerId !== before.customerId) changes.customerId = draft.customerId || null
  if (!sameTeam(draft.team, before.team)) changes.team = draft.team.map((member) => ({ userId: member.userId, role: member.role.trim() }))
  if (words(draft.what) !== words(before.what)) changes.problemWhat = words(draft.what)
  if (words(draft.where) !== words(before.where)) changes.problemWhere = words(draft.where)
  if (words(draft.when) !== words(before.when)) changes.problemWhen = words(draft.when)
  if (words(draft.howMany) !== words(before.howMany)) changes.problemHowMany = words(draft.howMany)
  return changes
}

/** The Problem form's problems by field (the team's rows by `team/<n>/role`), in our words. */
export function problemDraftProblems(draft: ProblemDraft): Readonly<Record<string, Say>> {
  const problems: Record<string, Say> = {}
  if (!draft.title.trim()) problems.title = { key: 'problem.field.title' }
  else if (draft.title.trim().length > CAPA_LIMITS.title) problems.title = { key: 'problem.field.tooLong', params: { count: CAPA_LIMITS.title } }
  if (!DAY.test(draft.dueOn)) problems.dueOn = { key: 'problem.field.dueOn' }
  if (draft.team.length > CAPA_LIMITS.team) problems.team = { key: 'problem.field.teamSize', params: { count: CAPA_LIMITS.team } }
  const seen = new Set<string>()
  draft.team.forEach((member, index) => {
    if (seen.has(member.userId)) problems[`team/${index}/userId`] = { key: 'problem.field.teamTwice' }
    seen.add(member.userId)
    if (!member.role.trim()) problems[`team/${index}/role`] = { key: 'problem.field.teamRole' }
    else if (member.role.trim().length > CAPA_LIMITS.teamRole) problems[`team/${index}/role`] = { key: 'problem.field.tooLong', params: { count: CAPA_LIMITS.teamRole } }
  })
  for (const field of ['what', 'where', 'when', 'howMany'] as const) if (draft[field].trim().length > CAPA_LIMITS.problem) problems[field] = { key: 'problem.field.tooLong', params: { count: CAPA_LIMITS.problem } }
  return problems
}

// ---- actions ---------------------------------------------------------------------------------------------------------------------

export interface ActionDraft {
  readonly kind: ActionKind
  readonly description: string
  readonly ownerId: string
  readonly dueOn: string
  readonly escalateToId: string
}

export const emptyActionDraft = (today: string, me: string): ActionDraft => ({ kind: 'CORRECTIVE', description: '', ownerId: me, dueOn: plusDays(today, 14), escalateToId: '' })

export function actionDraftProblems(draft: ActionDraft, today: string): Readonly<Record<string, Say>> {
  const problems: Record<string, Say> = {}
  if (!draft.description.trim()) problems.description = { key: 'problem.field.description' }
  else if (draft.description.trim().length > CAPA_LIMITS.description) problems.description = { key: 'problem.field.tooLong', params: { count: CAPA_LIMITS.description } }
  if (!DAY.test(draft.dueOn)) problems.dueOn = { key: 'problem.field.dueOn' }
  else if (draft.dueOn < today) problems.dueOn = { key: 'problem.field.actionDuePast' }
  if (!draft.ownerId) problems.ownerId = { key: 'problem.field.owner' }
  return problems
}

export const actionBodyOf = (draft: ActionDraft) => ({
  kind: draft.kind,
  description: draft.description.trim(),
  ownerId: draft.ownerId,
  dueOn: draft.dueOn,
  escalateToId: draft.escalateToId || null,
})

/** One cell's change of an action (autosave per cell), or null when the value is the same or not allowed. */
export function actionCellChange(action: CapaAction, field: 'description' | 'kind' | 'ownerId' | 'dueOn' | 'escalateToId', value: string, today: string): ActionChange | null {
  if (field === 'description') return value.trim() && value.trim() !== action.description && value.trim().length <= CAPA_LIMITS.description ? { description: value.trim() } : null
  if (field === 'kind') return value !== action.kind && (value === 'CORRECTIVE' || value === 'PREVENTIVE') ? { kind: value } : null
  if (field === 'ownerId') return value && value !== action.ownerId ? { ownerId: value } : null
  if (field === 'dueOn') return DAY.test(value) && value !== action.dueOn && value >= today ? { dueOn: value } : null
  return (value || null) !== action.escalateToId ? { escalateToId: value || null } : null
}

/** The next / previous action of the docked drawer (⌘↑ / ⌘↓), held at the ends. */
export function stepAction(actions: readonly Pick<CapaAction, 'id'>[], current: string | null, by: 1 | -1): string | null {
  const at = actions.findIndex((action) => action.id === current)
  if (at < 0) return actions[0]?.id ?? null
  return actions[at + by]?.id ?? null
}

// ---- refusals --------------------------------------------------------------------------------------------------------------------

/** Every `held/<CODE>` the CAPA routes send (B-W2b-108) and the complaint's share (B-W2b-192), said by `refused.<CODE>`. */
export const HELD_CODES = ['FINAL', 'NOT_LAST_STAGE', 'NO_ACTION_DONE', 'ACTIONS_OPEN', 'ACTION_ENDED', 'ESCALATED_ELSEWHERE', 'NCR_CANCELLED', 'NCR_KEEPS_CAPA', 'OTHER_COMPANY', 'TOO_MANY_REMINDERS', 'NO_PERMISSION', 'NO_CAPA', 'NO_REPORT'] as const

/** The fields a 400 names (`body/<field>`), said by `field.<name>` (the team's rows as `team`). */
export const FIELD_NAMES = ['title', 'ownerId', 'team', 'dueOn', 'priority', 'customerId', 'companyId', 'problemWhat', 'problemWhere', 'problemWhen', 'problemHowMany', 'sources', 'description', 'kind', 'escalateToId', 'evidenceNote', 'reason', 'note', 'to'] as const

/** The words of an API's held code (no facts in them: the screen's own held words carry the facts). */
export const refusedKey = (code: string): string => `refused.${(HELD_CODES as readonly string[]).includes(code) ? code : 'other'}`

const KIND_KEY: Readonly<Record<string, string>> = {
  signed_out: 'problem.signedOut',
  forbidden: 'problem.forbidden',
  step_up: 'problem.stepUp',
  not_found: 'problem.notFound',
  conflict: 'problem.refused',
  invalid: 'problem.invalid',
  rate_limited: 'problem.rateLimited',
  contract: 'problem.contract',
  unavailable: 'problem.unavailable',
}

export interface Refusal {
  readonly say: Say
  /** One line per held code or field the API named, in our words. */
  readonly lines: readonly Say[]
  /** The record changed since it was read: read it again. */
  readonly stale: boolean
  readonly fields: readonly string[]
}

export function refusalOf(error: unknown): Refusal {
  if (!isApiError(error)) return { say: { key: 'problem.unavailable' }, lines: [], stale: false, fields: [] }
  const paths = error.issues.map((issue) => issuePath(issue))
  const stale = error.kind === 'conflict' && paths.includes('version')
  if (stale) return { say: { key: 'problem.stale' }, lines: [], stale: true, fields: [] }
  const codes = [...new Set(paths.filter((path) => path.startsWith('held/')).map((path) => path.slice(5)))].filter((code) => (HELD_CODES as readonly string[]).includes(code))
  const fields = [...new Set(paths.filter((path) => path.startsWith('body/')).map((path) => path.slice(5).split('/')[0] ?? ''))].filter((field) => (FIELD_NAMES as readonly string[]).includes(field))
  if (codes.length > 0) return { say: { key: 'problem.held' }, lines: codes.map((code) => ({ key: refusedKey(code) })), stale: false, fields }
  if (fields.length > 0) return { say: { key: 'problem.fields' }, lines: fields.map((field) => ({ key: `field.${field}` })), stale: false, fields }
  return { say: { key: KIND_KEY[error.kind] ?? 'problem.internal' }, lines: [], stale: false, fields }
}

/** A failed read in our words. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.unavailable'
  return error.kind === 'conflict' ? 'problem.internal' : (KIND_KEY[error.kind] ?? 'problem.internal')
}

/** The record type of a source said in words (`source.<type>`). */
export const sourceTypeKey = (type: string): string => `source.${(SOURCE_TYPES as readonly string[]).includes(type) ? type : 'other'}`

export const STAGE_KEYS: readonly CapaStatus[] = ['PLAN', 'ACT', 'CHECK', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'CLOSED', 'CANCELLED']

/** The states a source shows (an NCR's stage, a complaint's status), said by `sourceState.<STATE>`; another is "other". */
export const SOURCE_STATES = ['OPEN', 'CONTAINED', 'DECIDED', 'CLOSED', 'CANCELLED', 'NEW', 'TRIAGED', 'INVESTIGATING', 'ANSWERED'] as const
export const sourceStateKey = (state: string): string => `sourceState.${(SOURCE_STATES as readonly string[]).includes(state) ? state : 'other'}`
