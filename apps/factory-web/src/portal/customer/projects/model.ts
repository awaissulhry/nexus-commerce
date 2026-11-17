import type { ProjectStatus } from '@nexus/factory-domain/projects/rules'
import { recordTypeKey } from '../../shell/thread-model'
import type { NewsEntry, PortalProject } from './api'

/**
 * A project as the customer (or a supplier, or a workshop) reads it in its portal (threads plan TH-5, B-TH-253; design
 * PROJ.portal-F01 … F09, PROJ.linked-F09), pure: the address, the status in one word (the same three words as the office:
 * Active · On hold · Closed), which projects Home and Samples & tech packs list, the band, and the news lines of the records the
 * person opens itself. Every word is a key of `portal-projects` (a record type's name is the frame's `portal` one).
 *
 * THE WALL: the portal shows a project only to a person the office ADDED to it (the API's members-only check); a project that is
 * not theirs reads like one that does not exist (`missing`, neutral words: never "you were not added", never another customer).
 * Office-only facts — the lead, the goal, the outcome and its words, office notes, who did what — never come and are never
 * drawn. The office's project number (an office series: it counts every customer's projects) is never drawn either: a project is
 * named by its name (B-TH-303's rule).
 */

export const NS = 'portal-projects'
/** The permission that opens a project in the portal (factory-domain projects/permissions PORTAL_PROJECTS_VIEW). */
export const PROJECTS_PERMISSION = 'portal.projects.view'

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** One word per status, as the office says it (PROJ.record-F02): On hold amber, Closed grey. */
export const STATUS_TONE: Readonly<Record<ProjectStatus, Tone>> = { ACTIVE: 'info', ON_HOLD: 'warning', CLOSED: 'neutral' }
export const statusKey = (status: ProjectStatus): string => `status.${status}`

/** `/p/<party>/projects/<id>` (RECORD_PAGES.Project; `#messages` puts the conversation in view). */
export const projectHref = (prefix: string, projectId: string, messages = false): string => `${prefix}/projects/${encodeURIComponent(projectId)}${messages ? '#messages' : ''}`

/** The projects still going (Home lists these even before a first message), in the API's order (target date first). */
export const openProjects = (projects: readonly PortalProject[]): PortalProject[] => projects.filter((project) => project.status !== 'CLOSED')

/** The project of the person's own list, or null: not theirs, or no longer (the page reads "not found"). */
export const projectOf = (projects: readonly PortalProject[] | null, projectId: string): PortalProject | null => projects?.find((project) => project.id === projectId) ?? null

// ── the page ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type PageState = 'loading' | 'error' | 'missing' | 'ready'

/**
 * The page's state from its two reads: the person's own projects (null while read, 'error' when it failed) and whether the
 * project's conversation said "not found". A project not in the person's list is missing — the same words as one that does not
 * exist.
 */
export function pageStateOf(input: { readonly projects: readonly PortalProject[] | null | 'error'; readonly projectId: string; readonly threadMissing: boolean }): PageState {
  if (input.threadMissing) return 'missing'
  if (input.projects === 'error') return 'error'
  if (input.projects === null) return 'loading'
  return projectOf(input.projects, input.projectId) ? 'ready' : 'missing'
}

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/**
 * The frame's band of a project page: the project's NAME (never the office's number), its status in one word, back to Home, and
 * "Ask a question" about the project (absent when it is not theirs).
 */
export function projectBandOf(input: { readonly t: Translate; readonly project: PortalProject | null; readonly state: PageState; readonly homeHref: string; readonly homeLabel: string; readonly projectId: string }) {
  const { t, project, state } = input
  return {
    title: state === 'missing' ? t('missing.title') : project ? project.name : t('band.title'),
    back: { href: input.homeHref, label: input.homeLabel },
    status: project && state === 'ready' ? { label: t(statusKey(project.status)), tone: STATUS_TONE[project.status] } : null,
    ask: state === 'missing' || !project ? null : { type: 'Project', id: input.projectId, label: project.name },
  }
}

// ── the news of the person's own records ──────────────────────────────────────────────────────────────────────────────

/**
 * The statuses a linked record's move is said in (keys `move.<CODE>` of `portal-projects`): what a customer, a supplier or a
 * workshop knows of its own records. A code without words is never drawn as a code: the line then says the record moved on.
 */
export const MOVE_WORDS: readonly string[] = [
  'REQUESTED',
  'IN_PROGRESS',
  'SENT',
  'RECEIVED',
  'DECIDED',
  'APPROVED',
  'REJECTED',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'CONFIRMED',
  'IN_PRODUCTION',
  'READY',
  'PARTLY_SHIPPED',
  'SHIPPED',
  'DELIVERED',
  'CLOSED',
  'CANCELLED',
  'ON_HOLD',
  'OPEN',
  'COMPLETED',
]
const moveKey = (code: string | null): string | null => (code && MOVE_WORDS.includes(code) ? `move.${code}` : null)

/** One line of "News of your records", as the view says it. */
export interface NewsLine {
  readonly key: string
  /** The record's own page or its conversation (`/open/<type>/<id>`: its own page for the person's kind once built). */
  readonly href: string
  /** The frame's words key of the record type ("Order", "Sample round"). */
  readonly typeKey: string
  /** Their reference first, else ours as their portal shows it; null: the record type alone names it. */
  readonly ref: string | null
  /** The move: both words, only where it got to, or neither ("moved on"). */
  readonly from: string | null
  readonly to: string | null
  /** When (an instant). */
  readonly at: string
  /** Moves of the same record that day beside this one. */
  readonly more: number
}

export function newsLineOf(entry: NewsEntry, prefix: string): NewsLine {
  const to = moveKey(entry.status.to)
  return {
    key: entry.id,
    href: `${prefix}/open/${encodeURIComponent(entry.recordType)}/${encodeURIComponent(entry.recordId)}`,
    typeKey: recordTypeKey(entry.recordType),
    ref: entry.theirRef ?? entry.ourRef,
    // "From" is said only when "to" is: half a move is never drawn.
    from: to ? moveKey(entry.status.from) : null,
    to,
    at: entry.at,
    more: Math.max(0, entry.folded - 1),
  }
}

/** The words key of a news line's move (the view fills record, from, to). */
export const newsMoveKey = (line: Pick<NewsLine, 'from' | 'to'>): string => (line.to && line.from ? 'news.moved' : line.to ? 'news.now' : 'news.changed')
