import { isOneLine, isParagraph, PROJECT_LIMITS, type ProjectOutcome } from '@nexus/factory-domain/projects/rules'
import type { LinkedNewsEntry, ProjectView, UpdateProjectBody, CloseProjectBody } from '../api'
import { NO_MANAGE, OFFLINE, type Phrase } from '../model'

/**
 * B-TH-249 — the project page (threads plan TH-5; design PROJ.record, PROJ.thread, PROJ.linked-F08; O-PRD-PROJ-REC = the generic
 * record page grown), pure: whom the project's thread talks to, what the band's ⋯ offers and why a line is held, the Close dialog's
 * rules and body, the Edit details draft and what a save sends, the details view's address term, a linked news line in words.
 * Its words are `products-projects-record` (the shared `products-projects` for statuses, refusals and problems).
 *
 * THE WALL (W01, W20, W38): a project has ONE outside company or none. Its thread offers "Reply to <that company>" only; an
 * office-only project has no outside audience at all (office notes only, no waiting pill, no "tell the customer").
 */

export const RECORD_NS = 'products-projects-record'

// ---- whom the thread talks to ------------------------------------------------------------------------------------------------

export type PartyRole = 'customer' | 'supplier' | 'partner'

/** Whom the outside company is to us, from its roles: a customer first, then a supplier or a subcontractor, else a partner. */
export function partyRoleOf(roles: readonly string[]): PartyRole {
  if (roles.includes('CUSTOMER')) return 'customer'
  if (roles.includes('SUPPLIER') || roles.includes('SUBCONTRACTOR')) return 'supplier'
  return 'partner'
}

/**
 * The thread's audience (PROJ.thread-F02, F08): the project's ONE outside company with its role, or nobody outside — an office-only
 * project writes office notes only, has no "Reply to" and no "waiting on" pill.
 */
export function threadAudience(project: Pick<ProjectView, 'party'>): { readonly party: { readonly id: string; readonly name: string } | null; readonly partyRole: PartyRole | undefined } {
  if (!project.party) return { party: null, partyRole: undefined }
  return { party: { id: project.party.id, name: project.party.name }, partyRole: partyRoleOf(project.party.roles) }
}

// ---- the band's ⋯ ----------------------------------------------------------------------------------------------------------------

/** The API does not allow this move from the status the project is in (the shared refusal's words). */
const MOVE_HELD: Phrase = { key: 'refusal.MOVE' }

export type BandLine = 'edit' | 'hold' | 'resume' | 'close' | 'reopen' | 'copy'

export interface BandRow {
  readonly id: BandLine
  /** Why it is held, in words; null: it may run now. */
  readonly held: Phrase | null
}

/** Why a change of the project is held now (no right first, then a closed project, then offline, then busy), or null. */
export function changeHeld(project: Pick<ProjectView, 'status' | 'may'>, state: { readonly offline: boolean; readonly busy: boolean }, closedHolds = true): Phrase | null {
  if (!project.may.manage) return NO_MANAGE
  if (closedHolds && project.status === 'CLOSED') return { key: 'held.closed' }
  if (state.offline) return OFFLINE
  if (state.busy) return { key: 'held.busy' }
  return null
}

/**
 * The band's ⋯ (PROJ.record-F02…F05): Edit details, Put on hold or Resume (as the API says the project may move now), Close… (never
 * for a closed project: Reopen instead), Copy link. A line the person may not run stays, held with why.
 */
export function bandRows(project: Pick<ProjectView, 'status' | 'may'>, state: { readonly offline: boolean; readonly busy: boolean }): BandRow[] {
  const moves = new Set(project.may.moves)
  // The API lists the moves only for who keeps the project: without the right the line says the right, not the move.
  const moveHeld = (move: string, closedHolds = true): Phrase | null => (!project.may.manage || moves.has(move) ? changeHeld(project, state, closedHolds) : MOVE_HELD)
  const rows: BandRow[] = [{ id: 'edit', held: changeHeld(project, state) }]
  if (project.status === 'ACTIVE') rows.push({ id: 'hold', held: moveHeld('HOLD') })
  if (project.status === 'ON_HOLD') rows.push({ id: 'resume', held: moveHeld('RESUME') })
  if (project.status === 'CLOSED') rows.push({ id: 'reopen', held: moveHeld('REOPEN', false) })
  else rows.push({ id: 'close', held: moveHeld('CLOSE') })
  rows.push({ id: 'copy', held: null })
  return rows
}

/** The band's one primary step: Reopen on a closed project (who keeps projects); none while it runs (Close waits in ⋯). */
export function primaryOf(project: Pick<ProjectView, 'status'>): 'reopen' | null {
  return project.status === 'CLOSED' ? 'reopen' : null
}

// ---- Close with outcome (PROJ.record-F03) ----------------------------------------------------------------------------------------

export interface CloseDraft {
  readonly outcome: ProjectOutcome | null
  readonly note: string
  /** Post the outcome to the outside company too (a project with one only). */
  readonly tell: boolean
}

export const emptyCloseDraft = (): CloseDraft => ({ outcome: null, note: '', tell: false })

/** Why Close is held, in words (the outcome first, then its one line), or null: it may close. */
export function closeProblem(draft: CloseDraft): Phrase | null {
  if (!draft.outcome) return { key: 'close.held.outcome' }
  const note = draft.note.trim()
  if (note === '') return { key: 'close.held.note' }
  if (note.length > PROJECT_LIMITS.outcomeNote) return { key: 'close.held.long', params: { max: PROJECT_LIMITS.outcomeNote } }
  if (!isOneLine(note, PROJECT_LIMITS.outcomeNote)) return { key: 'close.held.line' }
  return null
}

/** Whether the Close dialog offers "Also post the outcome to <outside company>": only a project that has one. */
export const offersTell = (project: Pick<ProjectView, 'party'>): boolean => project.party !== null

/** What Close sends (null while it is held): the version read, the outcome, its line, and the tick only with an outside company. */
export function closeBody(project: Pick<ProjectView, 'version' | 'party'>, draft: CloseDraft): CloseProjectBody | null {
  if (closeProblem(draft) || !draft.outcome) return null
  return { version: project.version, outcome: draft.outcome, outcomeNote: draft.note.trim(), ...(offersTell(project) && draft.tell ? { tellCustomer: true } : {}) }
}

// ---- Edit details (PROJ.record-F05) ----------------------------------------------------------------------------------------------

export interface EditDraft {
  readonly name: string
  readonly goal: string
  readonly leadId: string
  readonly targetDate: string
  readonly seasonCode: string
}

export const editDraftOf = (project: Pick<ProjectView, 'name' | 'goal' | 'lead' | 'targetDate' | 'seasonCode'>): EditDraft => ({
  name: project.name,
  goal: project.goal ?? '',
  leadId: project.lead.id,
  targetDate: project.targetDate,
  seasonCode: project.seasonCode ?? '',
})

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** What is wrong with the draft, field by field (the dialog marks each), or nothing. */
export function editProblems(draft: EditDraft): Partial<Record<keyof EditDraft, Phrase>> {
  const problems: Partial<Record<keyof EditDraft, Phrase>> = {}
  const name = draft.name.trim()
  if (name === '') problems.name = { key: 'edit.problem.nameEmpty' }
  else if (!isOneLine(name, PROJECT_LIMITS.name)) problems.name = { key: 'edit.problem.nameLong', params: { max: PROJECT_LIMITS.name } }
  const goal = draft.goal.trim()
  if (goal !== '' && !isParagraph(goal, PROJECT_LIMITS.goal)) problems.goal = { key: 'edit.problem.goalLong', params: { max: PROJECT_LIMITS.goal } }
  if (draft.leadId === '') problems.leadId = { key: 'edit.problem.lead' }
  if (!DAY.test(draft.targetDate)) problems.targetDate = { key: 'edit.problem.target' }
  if (draft.seasonCode.trim().length > 40) problems.seasonCode = { key: 'edit.problem.season', params: { max: 40 } }
  return problems
}

/** What a save sends: the version read and ONLY the fields that changed; null when nothing changed or a field is wrong. */
export function editBody(project: Pick<ProjectView, 'version' | 'name' | 'goal' | 'lead' | 'targetDate' | 'seasonCode'>, draft: EditDraft): UpdateProjectBody | null {
  if (Object.keys(editProblems(draft)).length > 0) return null
  const name = draft.name.trim()
  const goal = draft.goal.trim() === '' ? null : draft.goal.trim()
  const season = draft.seasonCode.trim() === '' ? null : draft.seasonCode.trim()
  const changes: { -readonly [K in keyof UpdateProjectBody]?: UpdateProjectBody[K] } = {}
  if (name !== project.name) changes.name = name
  if (goal !== (project.goal ?? null)) changes.goal = goal
  if (draft.leadId !== project.lead.id) changes.leadId = draft.leadId
  if (draft.targetDate !== project.targetDate) changes.targetDate = draft.targetDate
  if (season !== (project.seasonCode ?? null)) changes.seasonCode = season
  if (Object.keys(changes).length === 0) return null
  return { ...changes, version: project.version }
}

/** The lead choices: the project's office people and the colleagues who may read it (no one twice), the current lead first. */
export function leadChoices(current: { readonly id: string; readonly name: string }, people: readonly { readonly userId: string; readonly name: string }[], others: readonly { readonly userId: string; readonly name: string }[]): { id: string; name: string }[] {
  const seen = new Set<string>([current.id])
  const out = [{ id: current.id, name: current.name }]
  for (const person of [...people, ...others]) {
    if (seen.has(person.userId)) continue
    seen.add(person.userId)
    out.push({ id: person.userId, name: person.name })
  }
  return out
}

// ---- the details view below 1280 px (the side column behind the band's "Details") ------------------------------------------

/** The address term that keeps the details view open below 1280 px (Back closes it: the browser's history holds it). */
export const DETAILS_PARAM = 'details'

export const detailsOpenOf = (search: { get(name: string): string | null } | null | undefined): boolean => search?.get(DETAILS_PARAM) === 'open'

// ---- linked news (PROJ.linked-F08; B-TH-072), one line per record per day ---------------------------------------------------

export interface NewsLine {
  readonly id: string
  readonly at: string
  readonly recordType: string
  readonly recordId: string
  readonly label: string
  /** The status codes of the move (their words come from the `search` catalogue); null: no move (a decision). */
  readonly from: string | null
  readonly to: string | null
  readonly actor: string | null
  /** How many more moves of the record that day the line stands for (0: none). */
  readonly more: number
}

/** A linked news entry as a line: its move as codes only (never a value), the office person by name, the moves it folds. */
export function newsLineOf(entry: LinkedNewsEntry): NewsLine {
  return {
    id: entry.id,
    at: entry.at,
    recordType: entry.recordType,
    recordId: entry.recordId,
    label: entry.label,
    from: entry.status?.from ?? null,
    to: entry.status?.to ?? null,
    actor: entry.actorName,
    more: Math.max(0, entry.folded - 1),
  }
}
