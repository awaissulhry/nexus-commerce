import { PROJECT_LIMITS, PROJECT_OUTCOMES, PROJECT_REFUSALS, PROJECT_STATUSES, type ProjectOutcome, type ProjectRefusalCode, type ProjectStatus } from '@nexus/factory-domain/projects/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { rightRef } from '../../../lib/i18n/rights'

/**
 * Products › Development › Projects (threads plan TH-5; design PROJ.*), the part every project screen shares, pure: the catalogue
 * names, who may do what, a project's address, its status and target date in words and tone, a failed read and a refused write in
 * words from their codes. The project screens' catalogues: `products-projects` (this shared part, the list and New project,
 * B-TH-248), `products-projects-record` (the page, B-TH-249), `products-projects-people` (B-TH-250), `products-projects-linked`
 * (B-TH-251); each part brings its own beside this one (so the parts build side by side).
 *
 * THE WALL (Owner, absolute; plan §0): a project has ONE outside company or none, set when it is made; it never mixes customers;
 * the screens never say another customer exists. A refusal is said from its code (`refusal/<CODE>`, factory-domain projects/rules
 * PROJECT_REFUSALS: the catalogue holds the same words, a test keeps them equal).
 */

export const NS = 'products-projects'
/** The shared catalogues of every project screen (the list frame's `lists` too). */
export const NAMESPACES = [NS, 'lists'] as const

export { PROJECT_LIMITS, PROJECT_OUTCOMES, PROJECT_STATUSES }
export type { ProjectOutcome, ProjectStatus }

/** A phrase of a catalogue: its key and parameters. */
export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export interface Notice extends Phrase {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

// ---- who may do what ---------------------------------------------------------------------------------------------------------

export interface ProjectsCan {
  /** Read projects (threads.read: every office person who reads threads, decision 14). */
  readonly view: boolean
  /** Make, change, close, link, add the outside company's people (projects.manage; the API checks it per project again). */
  readonly manage: boolean
  /** Write in a project and add a colleague (threads.post). */
  readonly post: boolean
  /** The outside companies to pick (parties.view). */
  readonly parties: boolean
  /** Export ▾ (views.export). */
  readonly exportRows: boolean
}

export function projectsCan(permissions: readonly string[]): ProjectsCan {
  const held = new Set(permissions)
  return { view: held.has('threads.read'), manage: held.has('projects.manage'), post: held.has('threads.post'), parties: held.has('parties.view'), exportRows: held.has('views.export') }
}

/** "Needs the right …" for a project write without projects.manage (the right in words, never its code). */
export const NO_MANAGE: Phrase = { key: 'held.noManage', params: { right: rightRef('projects.manage') } }
export const NO_POST: Phrase = { key: 'held.noPost', params: { right: rightRef('threads.post') } }
export const OFFLINE: Phrase = { key: 'held.offline' }

// ---- addresses -----------------------------------------------------------------------------------------------------------------

/** The list: `/w/<company>/products/projects` (with its address terms). */
export const listHref = (prefix: string, terms = ''): string => `${prefix}/products/projects${terms}`

/** A project's page: `/w/<company>/products/projects/<id>` (`?thread=new` opens its thread at what is new). */
export function projectHref(prefix: string, projectId: string, extra?: string): string {
  return `${prefix}/products/projects/${encodeURIComponent(projectId)}${extra ? `?${extra}` : ''}`
}

/** An outside company's record (a customer or supplier: one party record). */
export const partyHref = (prefix: string, partyId: string): string => `${prefix}/sales/customers/${encodeURIComponent(partyId)}`

// ---- status and target date ----------------------------------------------------------------------------------------------------

/** One word per status, the same in the list, the band and the portal (PROJ.record-F02): Active · On hold (amber) · Closed (grey). */
export const STATUS_TONE: Readonly<Record<ProjectStatus, Tone>> = { ACTIVE: 'info', ON_HOLD: 'warning', CLOSED: 'neutral' }
export const statusKey = (status: ProjectStatus): string => `status.${status}`
export const outcomeKey = (outcome: ProjectOutcome): string => `outcome.${outcome}`

export type TargetState = 'OVERDUE' | 'SOON' | 'LATER' | 'CLOSED'
const TARGET_STATES: readonly string[] = ['OVERDUE', 'SOON', 'LATER', 'CLOSED']
const stateOf = (state: string): TargetState => (TARGET_STATES.includes(state) ? (state as TargetState) : 'LATER')

/**
 * A target date's words and tone (PROJ.list-F06: colour plus words, never colour alone): overdue in red ("Overdue 3 d"), within 7
 * days amber ("Due in 4 d", "Due today"), later or closed plain (no words beside the date).
 */
export function targetPhrase(target: { readonly state: string; readonly days: number }): { readonly tone: Tone; readonly phrase: Phrase | null } {
  const state = stateOf(target.state)
  if (state === 'OVERDUE') return { tone: 'danger', phrase: { key: 'target.overdue', params: { count: Math.abs(target.days) } } }
  if (state === 'SOON') return { tone: 'warning', phrase: target.days <= 0 ? { key: 'target.today' } : { key: 'target.soon', params: { count: target.days } } }
  return { tone: 'neutral', phrase: null }
}

/** The calendar day of an instant in the site's zone (YYYY-MM-DD). */
export function todayOf(instant: string, timeZone = 'Europe/Rome'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant))
}

/** A day N days after another (YYYY-MM-DD). */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

// ---- failed reads and refused writes, in words -----------------------------------------------------------------------------

/** The refusals the API sends at `refusal/<CODE>` (factory-domain projects/rules), each with its words in the shared catalogue. */
export const REFUSAL_CODES = Object.keys(PROJECT_REFUSALS) as ProjectRefusalCode[]

/** The code of a refusal (`refusal/<CODE>`), or null. */
export function refusalCode(error: unknown): string | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/')) return path.slice('refusal/'.length)
  }
  return null
}

/** A refusal said in our words: its code (else `refusal.other`). */
export const refusalPhrase = (code: string | null | undefined): Phrase => ({ key: code && (REFUSAL_CODES as readonly string[]).includes(code) ? `refusal.${code}` : 'refusal.other' })

/** A failed read in words (a failed read is never drawn as an empty list). A project not mine to read is "not found" (W38). */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.unavailable'
  switch (error.kind) {
    case 'forbidden':
      return 'problem.forbidden'
    case 'not_found':
      return 'problem.notFound'
    case 'signed_out':
      return 'problem.signedOut'
    case 'contract':
      return 'problem.contract'
    case 'rate_limited':
      return 'problem.rateLimited'
    default:
      return 'problem.unavailable'
  }
}

export interface WriteProblem extends Phrase {
  /** The API's places of a 400 (`body/name` → `name`). */
  readonly paths: readonly string[]
  /** Someone changed it first: read it again. */
  readonly stale: boolean
}

/** A refused write in words: a project rule's refusal by its code, a stale version, a refused field, the kind. */
export function writeProblem(error: unknown): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.unavailable', paths: [], stale: false }
  const code = refusalCode(error)
  if (code) return { ...refusalPhrase(code), paths: [], stale: false }
  const paths = error.issues.map((issue) => issuePath(issue).replace(/^body[/.]/, '').replace(/\./g, '/')).filter(Boolean)
  if (error.kind === 'conflict') return { key: 'problem.stale', paths: [], stale: true }
  if (error.kind === 'invalid') return { key: 'problem.invalid', paths, stale: false }
  if (error.kind === 'forbidden') return { key: 'problem.writeForbidden', paths: [], stale: false }
  if (error.kind === 'step_up') return { key: 'problem.stepUp', paths: [], stale: false }
  if (error.kind === 'not_found') return { key: 'problem.notFound', paths: [], stale: false }
  if (error.kind === 'rate_limited') return { key: 'problem.rateLimited', paths: [], stale: false }
  return { key: 'problem.unavailable', paths: [], stale: false }
}

/** A 400's place in our words (`name` → `field.name`). */
export function fieldOfPath(path: string): string {
  const top = path.split('/')[0] ?? ''
  const known = ['name', 'partyId', 'leadId', 'targetDate', 'seasonCode', 'goal', 'colleagueIds', 'links', 'outcome', 'outcomeNote', 'recordType', 'recordId', 'recordIds', 'note', 'userId']
  return known.includes(top) ? `field.${top}` : 'field.other'
}

/** Whether a key press is the page's (not typed into a field, not in a dialog or a menu, no modifier). */
export function isPageKey(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'defaultPrevented' | 'target'>): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return false
  const target = event.target as HTMLElement | null
  if (!target || typeof target.closest !== 'function') return true
  if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], .ag-cell-inline-editing')) return false
  return !target.isContentEditable
}
