import { PROJECT_LIMITS } from '@nexus/factory-domain/projects/rules'
import type { MyProject } from '../../../products/projects/api'
import { projectHref, targetPhrase, type Phrase, type Tone } from '../../../products/projects/model'
import type { Loaded } from '../model'

/**
 * Today › My projects (threads plan TH-5, B-TH-252; design PROJ.home-F03 "a Today panel: active projects I am in, target dates,
 * new marks", PROJ.home-F04 the stale nudge): GET /projects/mine — the open projects I am one of the people of, with MY OWN new
 * marks (never anyone else's, art. 4) and whether I lead it. Pure.
 *
 * - none → the panel is hidden (it only shows where there is something of mine);
 * - past its target date → the date's words in amber / red (never colour alone);
 * - a project I LEAD that is past its target date and quiet for 14 days → "Past its target date and quiet: close or update it"
 *   (the alert PROJECT_STALE tells the lead the same; the panel only suggests, it never acts);
 * - every line opens the project; "3 new" opens its thread at what is new (`?thread=new`).
 */

export interface MyProjectRow {
  readonly id: string
  readonly number: string
  readonly name: string
  /** The outside company's name, or null for an office-only project. */
  readonly party: string | null
  readonly status: MyProject['status']
  readonly targetDate: string
  readonly target: { readonly tone: Tone; readonly phrase: Phrase | null }
  /** My own unread notifications of it (0 when muted). */
  readonly newForMe: number
  readonly muted: boolean
  readonly lead: boolean
  /** I lead it, it is past its target date and quiet for 14 days: close or update it. */
  readonly stale: boolean
  readonly href: string
  readonly threadHref: string
}

export interface MyProjectsModel {
  readonly rows: Loaded<{ readonly items: readonly MyProjectRow[] }>
  /** The list of my projects (Products › Development › Projects, its default view). */
  readonly allHref: string
}

const DAY_MS = 86_400_000

/** Whether a project is past its target date and its conversation has been quiet for 14 days (the lead's nudge). */
export function isQuietPastTarget(project: Pick<MyProject, 'status' | 'target' | 'lastMessageAt'>, now: number): boolean {
  if (project.status === 'CLOSED' || project.target.state !== 'OVERDUE') return false
  // No message at all: quiet since it was made, which is at least as long ago as its target date passed.
  if (project.lastMessageAt === null) return Math.abs(project.target.days) >= PROJECT_LIMITS.staleDays
  return now - Date.parse(project.lastMessageAt) >= PROJECT_LIMITS.staleDays * DAY_MS
}

/** A line as the panel draws it. */
export function rowOf(project: MyProject, prefix: string, now: number): MyProjectRow {
  return {
    id: project.id,
    number: project.number,
    name: project.name,
    party: project.party?.name ?? null,
    status: project.status,
    targetDate: project.targetDate,
    target: targetPhrase(project.target),
    newForMe: project.muted ? 0 : project.newForMe,
    muted: project.muted,
    lead: project.lead.me,
    stale: project.lead.me && isQuietPastTarget(project, now),
    href: projectHref(prefix, project.id),
    threadHref: projectHref(prefix, project.id, 'thread=new'),
  }
}

/** The order: what needs me first (my stale ones, then new messages), then by target date (nearest first). */
export function orderRows(rows: readonly MyProjectRow[]): MyProjectRow[] {
  return [...rows].sort((a, b) => Number(b.stale) - Number(a.stale) || Number(b.newForMe > 0) - Number(a.newForMe > 0) || a.targetDate.localeCompare(b.targetDate) || a.number.localeCompare(b.number))
}

/** The panel shows only where there is something: none (or still reading the first time) → hidden. */
export function panelShown(model: MyProjectsModel): boolean {
  if (model.rows.status === 'error') return true
  return model.rows.status === 'ready' && model.rows.data.items.length > 0
}

/** The most lines the panel draws before "All my projects (n)". */
export const PANEL_ROWS = 8
