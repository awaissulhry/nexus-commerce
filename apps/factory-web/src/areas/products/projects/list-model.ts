import { isProjectLinkType, PROJECT_LIMITS, type ProjectLinkType, type ProjectMove } from '@nexus/factory-domain/projects/rules'
import type { ApiSort, ApiTarget, ApiView, CreateProjectBody, ProjectQuery, ProjectRow } from './api'
import type { PartyOption } from './list-api'
import { NO_MANAGE, NO_POST, OFFLINE, projectHref, type Phrase, type ProjectsCan } from './model'

/**
 * Products › Development › Projects — the list and New project (SCR-700, B-TH-248; design PROJ.list, PROJ.new), pure: the page's
 * address and the API query it asks, the views, the filters and which of them hide rows, where each cell leads (every cell is a
 * door), the bulk rules (Set status, Add a colleague; Close never in bulk), the New project draft, what holds it and the body it
 * sends. Every word is a key of `products-projects`.
 */

// ---- the address ----------------------------------------------------------------------------------------------------------

/** The page's views (`?view=`): My projects (the default), Active, By outside company, On hold, Closed, All. */
export const PAGE_VIEWS = ['mine', 'active', 'party', 'onHold', 'closed', 'all'] as const
export type PageView = (typeof PAGE_VIEWS)[number]

export const TARGET_FILTERS = ['OVERDUE', 'THIS_MONTH'] as const satisfies readonly ApiTarget[]

export interface ListAddress {
  readonly view: PageView
  /** The outside company (its party id). */
  readonly party: string | null
  /** Office-only projects (no outside company). */
  readonly office: boolean
  readonly lead: string | null
  readonly season: string | null
  readonly target: ApiTarget | null
  readonly q: string
  /** New project open (`?new=1`). */
  readonly isNew: boolean
  /** New project from a record (`?link=<Type>:<id>`, with `&linkLabel=` the record's number). */
  readonly link: { readonly type: ProjectLinkType; readonly id: string; readonly label: string | null } | null
}

export const HOME_ADDRESS: ListAddress = { view: 'mine', party: null, office: false, lead: null, season: null, target: null, q: '', isNew: false, link: null }

const API_TO_PAGE: Readonly<Record<string, PageView>> = { MINE: 'mine', ACTIVE: 'active', ON_HOLD: 'onHold', CLOSED: 'closed', ALL: 'all' }
const ID = /^[0-9a-f-]{8,64}$/i

const viewOf = (value: string | null): PageView => {
  if (!value) return 'mine'
  if ((PAGE_VIEWS as readonly string[]).includes(value)) return value as PageView
  return API_TO_PAGE[value] ?? 'mine'
}

/**
 * The address as the page reads it. It also reads the API's own terms (`partyId`, `leadId`, `seasonCode`, `outside=none`, the
 * views in capitals) so a link made from an API list (lib/records/record-links LIST_PAGES `/projects`) opens the same rows.
 */
export function addressOf(params: { get(name: string): string | null } | null | undefined): ListAddress {
  if (!params) return HOME_ADDRESS
  const party = params.get('party') ?? params.get('partyId')
  const lead = params.get('lead') ?? params.get('leadId')
  const season = (params.get('season') ?? params.get('seasonCode'))?.trim() || null
  const target = params.get('target')
  const office = params.get('office') === '1' || params.get('outside') === 'none'
  const linkTerm = params.get('link')
  let link: ListAddress['link'] = null
  if (linkTerm) {
    const [type, id] = linkTerm.split(':')
    if (type && id && isProjectLinkType(type) && ID.test(id)) link = { type, id, label: params.get('linkLabel')?.trim() || null }
  }
  return {
    view: viewOf(params.get('view')),
    party: office ? null : party && ID.test(party) ? party : null,
    office,
    lead: lead && ID.test(lead) ? lead : null,
    season,
    target: target && (TARGET_FILTERS as readonly string[]).includes(target) ? (target as ApiTarget) : null,
    q: params.get('q') ?? '',
    isNew: params.get('new') === '1',
    link,
  }
}

/** The address's terms (`?view=active&party=…`); the defaults are left out. */
export function addressText(address: ListAddress): string {
  const terms = new URLSearchParams()
  if (address.view !== 'mine') terms.set('view', address.view)
  if (address.office) terms.set('office', '1')
  else if (address.party) terms.set('party', address.party)
  if (address.lead) terms.set('lead', address.lead)
  if (address.season) terms.set('season', address.season)
  if (address.target) terms.set('target', address.target)
  if (address.q.trim()) terms.set('q', address.q.trim())
  if (address.isNew) terms.set('new', '1')
  if (address.link) {
    terms.set('link', `${address.link.type}:${address.link.id}`)
    if (address.link.label) terms.set('linkLabel', address.link.label)
  }
  const text = terms.toString()
  return text ? `?${text}` : ''
}

const VIEW_QUERY: Readonly<Record<PageView, { view: ApiView; sort: ApiSort }>> = {
  mine: { view: 'MINE', sort: 'TARGET' },
  active: { view: 'ACTIVE', sort: 'TARGET' },
  // By outside company: the active projects in the order of their outside company (office-only last), then by target date.
  party: { view: 'ACTIVE', sort: 'PARTY' },
  onHold: { view: 'ON_HOLD', sort: 'TARGET' },
  closed: { view: 'CLOSED', sort: 'RECENT' },
  all: { view: 'ALL', sort: 'TARGET' },
}

/** What the page asks GET /projects (the next page with the cursor the last answer gave). */
export function queryOf(address: ListAddress, cursor: string | null = null): ProjectQuery {
  const { view, sort } = VIEW_QUERY[address.view]
  return {
    view,
    sort,
    partyId: address.office ? null : address.party,
    officeOnly: address.office,
    leadId: address.lead,
    seasonCode: address.season,
    target: address.target,
    q: address.q.trim() || null,
    cursor,
    limit: 50,
  }
}

/** The filters on top of the view (each a chip with its own clear). */
export function isFiltered(address: ListAddress): boolean {
  return address.office || address.party !== null || address.lead !== null || address.season !== null || address.target !== null || address.q.trim() !== ''
}

/**
 * "A view with no rows says which filter hides them": the view and each filter set, as phrases (the view first). Names are
 * filled by the caller (`partyName`, `leadName`: what the loaded rows or the pickers know; else a plain word).
 */
export function hiddenBy(address: ListAddress, names: { readonly party?: string | null; readonly lead?: string | null } = {}): Phrase[] {
  const out: Phrase[] = [{ key: `view.${address.view}` }]
  if (address.office) out.push({ key: 'filter.officeChip' })
  else if (address.party) out.push(names.party ? { key: 'filter.partyChip', params: { name: names.party } } : { key: 'filter.partyChipPlain' })
  if (address.lead) out.push(names.lead ? { key: 'filter.leadChip', params: { name: names.lead } } : { key: 'filter.leadChipPlain' })
  if (address.season) out.push({ key: 'filter.seasonChip', params: { code: address.season } })
  if (address.target) out.push({ key: `filter.target.${address.target}` })
  if (address.q.trim()) out.push({ key: 'filter.searchChip', params: { q: address.q.trim() } })
  return out
}

/** A notice of the list (a bulk receipt, a refusal): its first line is the title, the rest under it. */
export interface ListNotice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly lines: readonly Phrase[]
}

/** A party's name as the office calls it (its trade name, else its legal name). */
export const partyNameOf = (party: Pick<PartyOption, 'tradeName' | 'legalName'>): string => party.tradeName ?? party.legalName

/** The outside companies of the pickers, split: customers and brands first, then suppliers and subcontractors (one list each). */
export function partyGroupsOf(parties: readonly PartyOption[]): { readonly customers: PartyOption[]; readonly suppliers: PartyOption[] } {
  const customers: PartyOption[] = []
  const suppliers: PartyOption[] = []
  for (const party of parties) {
    if (party.roles.includes('CUSTOMER') || party.roles.includes('BRAND')) customers.push(party)
    else if (party.roles.includes('SUPPLIER') || party.roles.includes('SUBCONTRACTOR')) suppliers.push(party)
  }
  return { customers, suppliers }
}

// ---- every cell a door -----------------------------------------------------------------------------------------------------

/** The page view a status opens (the Status cell's door). */
export const viewOfStatus = (status: ProjectRow['status']): PageView => (status === 'ON_HOLD' ? 'onHold' : status === 'CLOSED' ? 'closed' : 'active')

/** The Target date cell's door: overdue → the overdue filter; this month → this month's; else the project itself (null). */
export function targetDoorOf(row: Pick<ProjectRow, 'status' | 'targetDate' | 'target'>, today: string): ApiTarget | null {
  if (row.status !== 'CLOSED' && row.target.state === 'OVERDUE') return 'OVERDUE'
  return row.targetDate.slice(0, 7) === today.slice(0, 7) ? 'THIS_MONTH' : null
}

export interface RowDoors {
  readonly project: string
  /** The thread at what is new to me (Last message, New for me). */
  readonly thread: string
  /** The project's Linked block (the Linked count). */
  readonly linked: string
}

export function doorsOf(prefix: string, row: Pick<ProjectRow, 'id'>): RowDoors {
  const project = projectHref(prefix, row.id)
  return { project, thread: projectHref(prefix, row.id, 'thread=new'), linked: `${project}#linked` }
}

/** The New for me cell: my own unread count (never anyone else's), or the muted mark. */
export function newMarkOf(row: Pick<ProjectRow, 'newForMe' | 'muted'>): { readonly kind: 'muted' } | { readonly kind: 'new'; readonly count: number } | { readonly kind: 'none' } {
  if (row.muted) return { kind: 'muted' }
  return row.newForMe > 0 ? { kind: 'new', count: row.newForMe } : { kind: 'none' }
}

// ---- bulk (PROJ.list-F03) -----------------------------------------------------------------------------------------------------

export type BulkStatus = 'ACTIVE' | 'ON_HOLD'

export interface BulkStatusPlan {
  /** One POST per row that moves, with the version read. */
  readonly moves: readonly { readonly row: ProjectRow; readonly move: Extract<ProjectMove, 'HOLD' | 'RESUME'> }[]
  /** Rows already in that status (nothing sent). */
  readonly already: number
  /** Closed rows: skipped (a closed project is reopened one by one, on its page). */
  readonly closed: number
}

/** Set status for the selected rows: Active resumes the ones on hold, On hold holds the active ones; closed rows are skipped. */
export function bulkStatusPlan(rows: readonly ProjectRow[], to: BulkStatus): BulkStatusPlan {
  const moves: { row: ProjectRow; move: 'HOLD' | 'RESUME' }[] = []
  let already = 0
  let closed = 0
  for (const row of rows) {
    if (row.status === 'CLOSED') closed += 1
    else if (row.status === to) already += 1
    else moves.push({ row, move: to === 'ON_HOLD' ? 'HOLD' : 'RESUME' })
  }
  return { moves, already, closed }
}

/** Why a bulk action is held now (null: it may run). Set status needs projects.manage; Add a colleague threads.post. */
export function bulkHeld(action: 'status' | 'colleague', can: ProjectsCan, offline: boolean, busy: boolean): Phrase | null {
  if (offline) return OFFLINE
  if (busy) return { key: 'held.busy' }
  if (action === 'status' && !can.manage) return NO_MANAGE
  if (action === 'colleague' && !can.post) return NO_POST
  return null
}

/** Close is never a bulk action: each close needs its own outcome line (PROJ.list-F03). The words said where Close would be. */
export const BULK_CLOSE_HELD: Phrase = { key: 'bulk.closeHeld' }

export interface BulkTally {
  readonly done: number
  readonly already: number
  readonly closed: number
  /** Rows the API refused (each with its words), counted. */
  readonly refused: number
}

/** The receipt of a bulk run in words: what moved, what already was, what was skipped and why. */
export function bulkReceipt(kind: 'hold' | 'resume' | 'colleague', tally: BulkTally): { readonly tone: 'success' | 'warning'; readonly lines: readonly Phrase[] } {
  const lines: Phrase[] = [{ key: `bulk.done.${kind}`, params: { count: tally.done } }]
  if (tally.already > 0) lines.push({ key: `bulk.already.${kind}`, params: { count: tally.already } })
  if (tally.closed > 0) lines.push({ key: 'bulk.skippedClosed', params: { count: tally.closed } })
  if (tally.refused > 0) lines.push({ key: 'bulk.skippedRefused', params: { count: tally.refused } })
  return { tone: tally.closed > 0 || tally.refused > 0 ? 'warning' : 'success', lines }
}

// ---- New project (PROJ.new) -----------------------------------------------------------------------------------------------------

export interface NewDraft {
  readonly name: string
  /** The outside company, chosen now and never changed; null: office only. */
  readonly partyId: string | null
  /** YYYY-MM-DD or ''. */
  readonly targetDate: string
  readonly seasonCode: string | null
  readonly goal: string
}

export const emptyNewDraft = (partyId: string | null = null): NewDraft => ({ name: '', partyId, targetDate: '', seasonCode: null, goal: '' })

const CONTROL = /[\u0000-\u001f\u007f]/
const PARAGRAPH_CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** What is wrong with the name (required, one line, at most 200 characters), or null. */
export function nameProblem(name: string): Phrase | null {
  const trimmed = name.trim()
  if (trimmed === '') return { key: 'new.nameRequired' }
  if (CONTROL.test(name)) return { key: 'new.nameOneLine' }
  if (trimmed.length > PROJECT_LIMITS.name) return { key: 'new.nameTooLong', params: { count: PROJECT_LIMITS.name } }
  return null
}

/** What is wrong with the goal (optional, a paragraph of at most 4,000 characters), or null. */
export function goalProblem(goal: string): Phrase | null {
  const trimmed = goal.trim()
  if (trimmed === '') return null
  if (PARAGRAPH_CONTROL.test(goal)) return { key: 'new.goalCharacters' }
  if (trimmed.length > PROJECT_LIMITS.goal) return { key: 'new.goalTooLong', params: { count: PROJECT_LIMITS.goal } }
  return null
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Why Create is held (null: it may be sent): the right, the network, the required fields (name, lead, target date). */
export function newDraftHeld(draft: NewDraft, input: { readonly can: ProjectsCan; readonly offline: boolean; readonly leadId: string | null; readonly companyId: string | null }): Phrase | null {
  if (!input.can.manage) return NO_MANAGE
  if (input.offline) return OFFLINE
  if (!input.companyId) return { key: 'new.noCompany' }
  const name = nameProblem(draft.name)
  if (name) return name
  if (!input.leadId) return { key: 'new.leadRequired' }
  if (!DAY.test(draft.targetDate)) return { key: 'new.targetRequired' }
  return goalProblem(draft.goal)
}

/**
 * The set-once line, said BEFORE Create (PROJ.new-F02): with an outside company "Only <company> and our team will be in this
 * project. This cannot be changed later."; office only: "Only our team… no outside company can be added later." — never null.
 */
export function setOnceLine(partyName: string | null): Phrase {
  return partyName ? { key: 'new.setOnceParty', params: { name: partyName } } : { key: 'new.setOnceOffice' }
}

/** The body of POST /projects: office only → partyId null; the lead is the person (me by default); a record started from → `links`. */
export function newBodyOf(draft: NewDraft, input: { readonly companyId: string; readonly leadId: string; readonly link: ListAddress['link'] }): CreateProjectBody {
  const goal = draft.goal.trim()
  return {
    companyId: input.companyId,
    name: draft.name.trim(),
    partyId: draft.partyId,
    leadId: input.leadId,
    targetDate: draft.targetDate,
    ...(draft.seasonCode ? { seasonCode: draft.seasonCode } : {}),
    ...(goal ? { goal } : {}),
    ...(input.link ? { links: [{ recordType: input.link.type, recordId: input.link.id }] } : {}),
  }
}

/** The duplicate warning is asked once the name has this many characters (GET /projects/similar). */
export const SIMILAR_FROM = 3

/** Whether to ask the duplicate warning for this name (projects.manage, a name long enough). */
export const asksSimilar = (name: string, can: ProjectsCan): boolean => can.manage && name.trim().length >= SIMILAR_FROM

/** The character counter shows near the end of the name's room (the last 40 characters). */
export const nameCounterShown = (name: string): boolean => name.trim().length >= PROJECT_LIMITS.name - 40
