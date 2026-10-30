import { z } from 'zod'

/**
 * What a saved view keeps (B-W2a-23; PLT-163; design shell.lists pop:save-view "what it keeps (filters, columns, sort,
 * mode)"), as the Office's ONE list frame reads it (apps/factory-web src/list-frame):
 *
 *   query     the list's own address terms (`late=true&q=rossi`, `view=board`): its filters, its sort and its mode, the
 *             same words a shared link and Home › Today's "See all" use, so every list keeps its state without work of
 *             its own. The transient terms (a record opened over the list, a dialog, a paging cursor, a link's own
 *             `savedView` or `export`) are never kept.
 *   columns   the layout of the grid: the order of its columns, the ones hidden and the ones frozen at the left, by
 *             column id (a column the list no longer has is ignored when the view is applied)
 *   density   the grid's rows: compact, cozy (the default) or spacious
 *
 * Only what was chosen is stored. Pure: the API checks a body with `viewStateSchema`, the web builds the same object.
 */

/** A list: its page id, the Office address with dots (`/sales/orders` → `sales.orders`). */
export const LIST_KEY = /^[a-z][a-z0-9_.-]*$/

export const VIEW_LIMITS = Object.freeze({
  listKey: 120,
  name: 80,
  /** Views one person keeps of one list. */
  perList: 50,
  query: 2000,
  columns: 80,
  columnId: 80,
  pinned: 20,
})

/** The grid's densities (the DS `GridDensityName`). */
export const DENSITIES = ['compact', 'cozy', 'spacious'] as const
export type Density = (typeof DENSITIES)[number]

/**
 * Address terms that are never part of a view: a link to a saved view or an export job, a record or a line opened over
 * the list, a dialog, a record tab, the paging cursor. With `new` (a create dialog) its own terms go too.
 */
export const TRANSIENT_TERMS: readonly string[] = Object.freeze(['savedView', 'export', 'open', 'new', 'cursor', 'tab', 'at', 'focus'])
const WITH_NEW: readonly string[] = Object.freeze(['order', 'invoice', 'lines'])

/** The list key of an Office page (`/sales/orders`); null for a record page (`/sales/orders/[id]`) or a bad path. */
export function listKeyOf(page: string): string | null {
  const path = page.replace(/^\/+|\/+$/g, '')
  if (path === '' || path.includes('[')) return null
  const key = path.split('/').join('.')
  return LIST_KEY.test(key) && key.length <= VIEW_LIMITS.listKey ? key : null
}

/**
 * The terms a view keeps of an address query (with or without its `?`): the transient terms and empty values out, the
 * rest sorted by name (then value) so that two addresses of the same view compare equal.
 */
export function viewQuery(search: string | URLSearchParams): string {
  const params = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : new URLSearchParams(search)
  const creating = params.has('new')
  const kept: [string, string][] = []
  for (const [name, value] of params) {
    if (TRANSIENT_TERMS.includes(name) || (creating && WITH_NEW.includes(name)) || value.trim() === '') continue
    kept.push([name, value])
  }
  kept.sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
  return new URLSearchParams(kept).toString()
}

const columnId = z.string().regex(/^[A-Za-z0-9_.:-]+$/).max(VIEW_LIMITS.columnId)
const ids = (max: number) => z.array(columnId).max(max)

export const columnLayoutSchema = z.strictObject({
  /** Every column the person ordered, left to right (the others keep their place after them). */
  order: ids(VIEW_LIMITS.columns),
  hidden: ids(VIEW_LIMITS.columns),
  /** Frozen at the left edge, in this order. */
  pinned: ids(VIEW_LIMITS.pinned),
})
export type ColumnLayout = z.infer<typeof columnLayoutSchema>

export const viewStateSchema = z.strictObject({
  query: z.string().max(VIEW_LIMITS.query),
  columns: columnLayoutSchema.optional(),
  density: z.enum(DENSITIES).optional(),
})
export type ViewState = z.infer<typeof viewStateSchema>

const unique = (values: readonly string[]): string[] => [...new Set(values)]

/** A view state as stored: the query normalised, each list without repeats, empty parts left out. */
export function normaliseState(state: ViewState): ViewState {
  const query = viewQuery(state.query)
  const columns = state.columns
    ? { order: unique(state.columns.order), hidden: unique(state.columns.hidden), pinned: unique(state.columns.pinned) }
    : undefined
  const layout = columns && (columns.order.length > 0 || columns.hidden.length > 0 || columns.pinned.length > 0) ? columns : undefined
  return { query, ...(layout ? { columns: layout } : {}), ...(state.density ? { density: state.density } : {}) }
}

const sameList = (a: readonly string[] = [], b: readonly string[] = []): boolean => a.length === b.length && a.every((value, index) => value === b[index])
const sameSet = (a: readonly string[] = [], b: readonly string[] = []): boolean => a.length === b.length && a.every((value) => b.includes(value))

/** Two states show the same list: same terms, same column layout (hidden as a set), same density. */
export function sameState(a: ViewState, b: ViewState): boolean {
  const x = normaliseState(a)
  const y = normaliseState(b)
  return (
    x.query === y.query &&
    (x.density ?? 'cozy') === (y.density ?? 'cozy') &&
    sameList(x.columns?.order, y.columns?.order) &&
    sameSet(x.columns?.hidden, y.columns?.hidden) &&
    sameList(x.columns?.pinned, y.columns?.pinned)
  )
}
