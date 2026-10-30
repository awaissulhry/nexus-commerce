import type { ListKey } from '../../../list-frame/model'
import type { Translate } from '../../../lib/i18n/messages'
import type { PanelRead } from '../../../record-panels/model'
import { TASK_TILES, type Assignable, type TaskItem, type TaskTile } from '../../../record-panels/tasks/model'

/**
 * Home › My tasks (SCR-233; design home.tasks, W2a; COL-037): the ONE view model the page draws and its pure rules. The
 * rows, tiles and who may change what come from the API (platform/tasks: each row is the person's own — assigned to them
 * or made by them — never a figure about anyone else); the web adds the address (`?scope` `?tile` `?q` `?open` `?new`),
 * the selection and its bulk actions, the keys and where each row opens.
 */

/** Whose tasks: mine (assigned to me) or made by me. "My team's" waits for teams (People, W2b): drawn, held with why. */
export const TASK_SCOPES = ['MINE', 'TEAM', 'CREATED'] as const
export type TasksScope = 'MINE' | 'CREATED'

export const scopeOf = (value: string | null | undefined): TasksScope => (value === 'CREATED' ? 'CREATED' : 'MINE')
export const tileOf = (value: string | null | undefined): TaskTile | null => ((TASK_TILES as readonly string[]).includes(value ?? '') ? (value as TaskTile) : null)

/** The address of the list (its own query: the API's filters, as the page reads them back). */
export function tasksAddress(state: { readonly scope: TasksScope; readonly tile: TaskTile | null; readonly q: string; readonly open: string | null; readonly newTask?: boolean }): string {
  const query = new URLSearchParams()
  if (state.scope !== 'MINE') query.set('scope', state.scope)
  if (state.tile) query.set('tile', state.tile)
  if (state.q.trim()) query.set('q', state.q.trim())
  if (state.open) query.set('open', state.open)
  if (state.newTask) query.set('new', '1')
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** A row as the page draws it: the API's task, its popup's address and its record's. */
export interface TaskRow extends TaskItem {
  /** `?open=<id>` on this page (a real link: ⌘-click opens it in a new tab). */
  readonly href: string
  /** The record it is on (its own page, else its panels), or null for a task of its own. */
  readonly recordHref: string | null
}

export type LiveState = 'connecting' | 'live' | 'offline'

export interface TasksList {
  readonly asOf: string
  readonly tiles: readonly { readonly tile: TaskTile; readonly count: number }[]
  readonly total: number
  /** False: more than 500 tasks in the scope; only the newest were read (the tiles say "at least"). */
  readonly complete: boolean
  readonly rows: readonly TaskRow[]
  readonly more: boolean
  readonly loadingMore: boolean
}

/** The open task's popup: its row (or the task read alone), and who it may be given to. */
export interface OpenTask {
  readonly id: string
  readonly task: PanelRead<TaskRow>
  /** Who it may be given to (read when the person may change it). */
  readonly people: PanelRead<readonly Assignable[]> | null
}

export type TasksDialog =
  | { readonly kind: 'new'; readonly people: PanelRead<readonly Assignable[]> }
  | { readonly kind: 'reassign'; readonly ids: readonly string[]; readonly people: PanelRead<readonly Assignable[]> }
  | { readonly kind: 'due'; readonly ids: readonly string[] }
  | { readonly kind: 'snooze'; readonly id: string }
  | { readonly kind: 'help' }

export interface TasksNotice {
  /** A message key of `home-tasks` (or `records` for `tasks.*`). */
  readonly key: string
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly params?: Readonly<Record<string, string | number>>
  /** The notice offers Undo (a task just ticked done). */
  readonly undo?: boolean
}

export interface TasksViewModel {
  /** home.view: else the page says so and reads nothing. */
  readonly access: 'open' | 'refused'
  /** The read's clock (the snooze choices). */
  readonly now: number
  readonly prefix: string
  readonly me: string | null
  /** tasks.manage: make, change, tick (the API checks each task again). */
  readonly canManage: boolean
  readonly live: LiveState
  readonly scope: TasksScope
  readonly tile: TaskTile | null
  readonly q: string
  readonly list: PanelRead<TasksList>
  /** Live changes waiting behind "N updates · Show". */
  readonly updates: number
  readonly selected: readonly string[]
  readonly open: OpenTask | null
  readonly dialog: TasksDialog | null
  readonly busy: boolean
  readonly notice: TasksNotice | null
  /** Design cases: the row that has the focus. */
  readonly focusRow?: number
}

// ---- rules ------------------------------------------------------------------------------------------------------------

/** Why a row cannot be ticked for a bulk action (a message key of `home-tasks`), or null. */
export function selectHeld(row: Pick<TaskItem, 'canChange' | 'status'>): string | null {
  if (!row.canChange) return 'held.rowReadOnly'
  if (row.status !== 'OPEN') return 'held.rowClosed'
  return null
}

/** The selected rows a bulk action may change (open ones the person may change), in the list's order. */
export function bulkRows<T extends Pick<TaskItem, 'id' | 'canChange' | 'status'>>(rows: readonly T[], selected: readonly string[]): T[] {
  return rows.filter((row) => selected.includes(row.id) && selectHeld(row) === null)
}

/** Why a bulk action or a change is held now (a message key of `home-tasks`), or null. */
export function actionHeld(state: { readonly canManage: boolean; readonly live: LiveState; readonly busy: boolean }): string | null {
  if (!state.canManage) return 'held.noManage'
  if (state.live === 'offline') return 'held.offline'
  if (state.busy) return 'held.busy'
  return null
}

/** Reassign N: each task with whose it is now and whose it becomes ("from → to"), for the review before it is sent. */
export function reassignChanges(rows: readonly Pick<TaskItem, 'id' | 'title' | 'assignee'>[], to: { readonly id: string | null; readonly name: string }, nobody: string): { id: string; title: string; from: string; to: string; same: boolean }[] {
  return rows.map((row) => ({ id: row.id, title: row.title, from: row.assignee?.name ?? nobody, to: to.id === null ? nobody : to.name, same: (row.assignee?.id ?? null) === to.id }))
}

/** The rows the popup steps through (J / K): the list as shown. */
export const popupIds = (rows: readonly { readonly id: string }[]): string[] => rows.map((row) => row.id)

/** After a task left the list (done): the next row, else the one before, else none. */
export function nextAfter(ids: readonly string[], gone: string): string | null {
  const index = ids.indexOf(gone)
  if (index < 0) return null
  return ids[index + 1] ?? ids[index - 1] ?? null
}

/** How many rows of a fresh read differ from those shown (new, changed or gone): "N updates · Show". */
export function updatesBetween(shown: readonly Pick<TaskItem, 'id' | 'version'>[], fresh: readonly Pick<TaskItem, 'id' | 'version'>[]): number {
  const before = new Map(shown.map((row) => [row.id, row.version]))
  const after = new Map(fresh.map((row) => [row.id, row.version]))
  let count = 0
  for (const [id, version] of after) if (before.get(id) !== version) count += 1
  for (const id of before.keys()) if (!after.has(id)) count += 1
  return count
}

/** A tile's number: exact, or "at least" when the scope holds more than the API read. */
export const tileValue = (count: number, complete: boolean): { key: string; count: number } => (complete ? { key: 'tile.count', count } : { key: 'tile.atLeast', count })

/** The page's own keys, in the list footer's info icon (the frame adds j / k, Enter, x and the rest). */
export function tasksKeys(t: Translate): ListKey[] {
  return [
    { keys: ['c'], does: t('keys.new') },
    { keys: ['e'], does: t('keys.done') },
  ]
}

/** The page's keys outside a field: c opens New task, e ticks the focused row done. */
export function pageKey(key: string): 'new' | 'done' | null {
  if (key === 'c') return 'new'
  if (key === 'e') return 'done'
  return null
}
