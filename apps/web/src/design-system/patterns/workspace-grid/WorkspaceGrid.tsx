'use client'

/**
 * CBN.3.2 — WorkspaceGrid: the ONE shared Helium-10 Ad-Manager grid. Prop-driven so every
 * grid in the console (campaign Ad Groups / Search Terms / Negative Targets / Ads — and,
 * after CBN.3.7, the Ad Manager itself) renders through this single component. Change the
 * grid here and every consumer updates.
 *
 * It reproduces the proven `h10-am-*` markup (filters panel · toolbar · sticky checkbox +
 * first column · sortable metric columns with (i) tips · pinned Total row · pager + rows-
 * per-page · "Latest Report" footer) and composes the already-shared controls from
 * ./FilterDropdown (H10Select · HoverCard) and ./AdsFilterBar. No restyling of the shared
 * CSS — only a small CBN.3.2 block adds the Total-row + Customize-popover bits.
 *
 * FB.1 — the filters panel moved to ./AdsFilterBar and is rendered from here. It is the same
 * markup and the same classes; what changed is that a PAGE can now render it too, at the top of
 * the page rather than directly above this card, which is what the eleven Rules & Automation
 * pages needed in order to show one bar instead of a scope bar plus a filter bar.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@/design-system/primitives'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, ChevronsUpDown, Settings2, Download, Pencil, Search, X } from 'lucide-react'
import { PreferencesModal, type PreferencesColumnSpec } from '@/design-system/patterns'
import { AdsFilterBar, stripServerKeys, isServerKey } from './AdsFilterBar'
import { enabledRank } from './enabledRank'

// The DS HoverCard takes a suppression check rather than knowing what a column drag is.
const colDragging = () => document.body.classList.contains('col-dragging')
import { HoverCard, Listbox } from '@/design-system/components'

// FB.1 — the Filters panel now lives in ./AdsFilterBar so a PAGE can render it somewhere other than
// directly above this card. The grid renders that same component, so there is exactly one filter-bar
// implementation; `hideFilterPanel` is for the pages that render their own copy at the top.
export { AdsFilterBar, stripServerKeys, isServerKey } from './AdsFilterBar'

// Re-exported so consumers can import the ranking helper from the grid they already use.
export { enabledRank }

/** A grid column. `render` draws the cell; `sortValue`/`filterValue` drive sort + range
 *  filters; `total` is the value shown in the pinned Total row (omit ⇒ blank). */
/** SGX3 — what the Customize dialog persists per `storageKey`: the visible columns IN ORDER,
 *  plus whether the identity column and the right-pinned set actually stick. */
export interface GridPrefs {
  visible: string[]
  stickyFirst: boolean
  stickyLast: boolean
}

export interface GridColumn<T> {
  key: string
  label: string
  tip?: string
  /** right-aligned numeric look (default true); false renders a left "settings" cell */
  metric?: boolean
  sortable?: boolean
  render: (row: T) => ReactNode
  /**
   * KT.3 — may return `null` / `undefined` for "this row has no value". A blank then sinks in BOTH
   * sort directions rather than being reversed with everything else, so ascending a sparse column
   * surfaces the smallest MEASURED row. Prefer this over a sentinel like `NEGATIVE_INFINITY`.
   */
  sortValue?: (row: T) => number | string | null | undefined
  /** numeric accessor used by range filters keyed on this column */
  filterValue?: (row: T) => number
  /** Total-row cell. ER4 F2: pass a FUNCTION to compute it from the currently
   *  filtered rows (totals then react to the filter panel + search); a plain
   *  ReactNode stays static exactly as before. */
  total?: ReactNode | ((visibleRows: T[]) => ReactNode)
  defaultHidden?: boolean
  /**
   * SG.2 — pin this column to the RIGHT edge during horizontal scroll (H10's decision columns:
   * the ✓ / ✕ / ⏸ verbs stay reachable however wide the metrics get). Requires `width`, because
   * a right-pinned column's offset is the sum of the pinned widths after it — computable only
   * when those widths are declared, never measured. Offsets are computed over the VISIBLE
   * pinned set, so hiding one via Customize re-packs the rest. Additive: columns that don't
   * pass it render byte-identically.
   */
  /**
   * WG.1 — supersedes `metric` and is the DS `Column.align` under its real name. `metric` was a
   * boolean spelling of the same idea ("right-aligned numeric look, or the left settings cell"),
   * which could not say `center`. Both are honoured: `align` wins where it is set, so no existing
   * call site changes behaviour.
   */
  align?: 'left' | 'right' | 'center'
  freezeRight?: boolean
  /** fixed width in px — required with freezeRight (also applied as the column's width) */
  width?: number
}

export interface GridRangeFilter { key: string; label: string; kind: 'range'; unit?: '€' | '%' | ''; tip?: string; value?: (row: unknown) => number }
export interface GridSelectFilter { key: string; label: string; kind: 'select'; options: Array<{ value: string; label: string; title?: string }>; placeholder?: string; wide?: boolean; searchable?: boolean; value?: (row: unknown) => string; tip?: string; disabled?: boolean; note?: string }
export interface GridMultiSelectFilter { key: string; label: string; kind: 'multiselect'; options: Array<{ value: string; label: string; title?: string }>; placeholder?: string; wide?: boolean; searchable?: boolean; value?: (row: unknown) => string; tip?: string; disabled?: boolean; note?: string }

export type GridFilter = GridRangeFilter | GridSelectFilter | GridMultiSelectFilter

/** One inline-editable field (H10 "Edit Groups"). `key` is a column key, or '__first'
 *  for the sticky first column. `initial` seeds the draft; `render` draws the bound input. */
export interface GridEditField<T> {
  key: string
  initial: (row: T) => string
  render: (value: string, set: (v: string) => void, row: T) => ReactNode
  /** optional editor for the hover-edit popover (defaults to `render`); use an inline control
   *  here when `render` is a floating dropdown that would z-fight the popover. */
  renderPopover?: (value: string, set: (v: string) => void, row: T) => ReactNode
}
/** Inline edit mode: the grid renders an Edit toggle that swaps the toolbar for
 *  Discard/Apply and turns the configured cells into inputs; onApply persists the diffs. */
export interface GridEditMode<T> {
  label: string
  fields: GridEditField<T>[]
  onApply: (edits: Array<{ id: string; values: Record<string, string> }>) => Promise<void> | void
  /** show the bulk Edit toggle + Discard/Apply toolbar (default true). false ⇒ hover-edit only. */
  bulk?: boolean
}

export type RangeVal = { min: string; max: string }
export type FilterState = Record<string, RangeVal | string | string[]>

/** GX.2 — what the grid needs in order to draw a tree it does not own. */
export interface GridHierarchy<T> {
  /** 0 for a root row; each level down adds one. Drives the indent. */
  depthOf: (row: T) => number
  /** False on a leaf — the grid must never draw a chevron that opens nothing. */
  expandableOf: (row: T) => boolean
  /** Row ids currently open, by the same `rowId` the grid uses everywhere else. */
  expanded: Set<string>
  /** Row ids whose children are in flight, so the chevron can say so instead of looking inert. */
  loading?: Set<string>
  onToggle: (row: T, next: boolean) => void
  /** Marks a row as a computed remainder so it can be styled and made unselectable. */
  isRemainder?: (row: T) => boolean
}

export interface WorkspaceGridProps<T> {
  rows: T[]
  loading?: boolean
  rowId: (row: T) => string
  /** noun for the count text + Customize lock label, e.g. "Ad Group" */
  noun: string
  /** sticky first column */
  firstColLabel: string
  renderFirst: (row: T) => ReactNode
  firstSortValue?: (row: T) => string
  /** metric / settings columns, in display order */
  columns: GridColumn<T>[]
  /** optional filter panel; range filters read column.filterValue (matched by key) or filter.value */
  filters?: GridFilter[]
  /** toolbar slots (left = beside the count, right = before Customize) */
  toolbarLeft?: ReactNode
  toolbarRight?: ReactNode
  exportable?: boolean
  onExport?: () => void
  customizable?: boolean
  /** localStorage key for column visibility; omit ⇒ not persisted */
  storageKey?: string
  /**
   * GX.2 — DRILL-DOWN MODE. Additive: omit it and every existing consumer is byte-identical.
   *
   * Rows arrive FLAT, with parents and their loaded children already interleaved in tree order,
   * and each row reporting its own depth. The grid stays dumb about the hierarchy — it draws the
   * chevron and the indent and tells you what was clicked; the consumer owns which nodes are open
   * and fetches their children.
   *
   * That split is deliberate. A grid that owned the tree would have to own the fetching too, and
   * expanding here is a QUERY, not a slice of rows already in the browser — the search-terms
   * report alone is 12,443 rows.
   *
   * 🔴 Tree order is the ONLY order. Client sort, filter, search and paging are bypassed exactly
   * as they are in `server` mode: re-sorting a flat tree by Spend would tear children away from
   * their parents and produce a list that still looks plausible. Sort by asking the server for a
   * different order instead.
   */
  hierarchy?: GridHierarchy<T>
  /** selection */
  selectable?: boolean
  selected?: Set<string>
  onSelectedChange?: (s: Set<string>) => void
  /** pinned Total row */
  showTotal?: boolean
  totalFirst?: ReactNode
  /** footer + empty */
  reportLabel?: string
  emptyLabel?: string
  /** richer empty-state (CTA button etc.) — overrides emptyLabel when there are no rows */
  emptyNode?: ReactNode
  /** initial sort (H10 grids default to Spend ↓); the matching header renders blue/active */
  defaultSort?: { key: string; dir: 'asc' | 'desc' }
  /**
   * SF.1 — return the row's live state (a boolean, or a status string like ENABLED/PAUSED/ARCHIVED)
   * and the grid puts the live rows at the top of the DEFAULT view: what is running is what you
   * came to look at, and archived rows sink. The chosen sort still orders rows *within* each band.
   * Clicking a column header hands ordering entirely to that column; clearing the sort (third
   * click) brings this back. See `enabledRank` for the vocabulary.
   */
  enabledFirst?: (row: T) => unknown
  /** inline edit mode (H10 "Edit Groups"): editable cells + Discard/Apply toolbar */
  editMode?: GridEditMode<T>
  /** bulk-action buttons shown in the toolbar when rows are selected (e.g. Adjust Bid / Enable
   *  / Archive / Pause). Receives the selected row ids + a clear-selection callback. */
  selectionActions?: (ids: string[], clear: () => void) => ReactNode
  /** H10 rules grid: a collapsed 🔍 next to the count that expands to an input and
   *  filters rows by `searchValue` (defaults to firstSortValue). */
  searchable?: boolean
  searchPlaceholder?: string
  searchValue?: (row: T) => string
  /** center the pager (H10 rules grid) instead of right-aligning it. */
  pagerCentered?: boolean
  /** initial filters-panel open state (H10 rules grid loads collapsed). */
  filtersDefaultOpen?: boolean
  /** ER3.1 (additive; default off) — Filter Library: when set, the filter
   *  panel gains saveable named presets persisted in localStorage under this
   *  key. Grids that don't pass it render exactly as before. */
  filterPresetsKey?: string
  /** ER3.3 — seed the filter state on mount (deep links like ?status=LIMITED).
   *  Additive: consumers that omit it start empty exactly as before. */
  initialFilters?: FilterState
  /** ER3.5 — optional extra class per row (e.g. digest deep-link highlight).
   *  Additive: consumers that omit it render exactly as before. */
  rowClassName?: (row: T) => string | undefined
  /** optional row grouping: returns the group key + label for a row. When set, the grid
   *  clusters same-group rows and renders a header row before each group. Additive —
   *  consumers that omit it are unaffected.
   *
   *  R1 — `order` is optional and decides the SEQUENCE of the groups; without it they fall
   *  back to alphabetical, as they always have. Alphabetical is wrong wherever the groups
   *  have a meaning-carrying order: Reporting's five headings would render Economics before
   *  Performance, burying the reports that are actually opened. Both existing consumers
   *  (ebay rollup, suggestions) return key+label only, so they are unchanged by construction. */
  groupBy?: (row: T) => { key: string; label: string; order?: number }
  /** optional row click (e.g. open a detail drawer). Clicks landing on an interactive
   *  child (checkbox / link / button / select) are ignored so they keep their own behavior. */
  onRowClick?: (row: T) => void
  /** opt in to keyboard navigation: j/↓ + k/↑ move a focused row, Enter/o fires onRowClick,
   *  any other key is forwarded to onRowKey (e.g. a = approve, e = dismiss). Ignored while a
   *  field is focused. Only enable on ONE grid at a time (a document-level listener). */
  keyboardNav?: boolean
  onRowKey?: (row: T, key: string) => void
  /**
   * BID.S0 (additive; default off) — read the sort and the filters back OUT.
   *
   * `defaultSort` and `initialFilters` could already seed this grid from a URL; nothing could get
   * a change back, because `onSort` is internal. So on every page using this grid, clicking a
   * column header or a filter changed the view and not the address bar: the state was linkable
   * inward and unlinkable outward, and a copied link reproduced the page you arrived at rather
   * than the one you were looking at.
   *
   * Passing either callback also turns on **re-sync**: when the seed props change (the back
   * button, a pasted link), the grid follows them. That is why the behaviour is gated on the
   * callbacks rather than applied always — a consumer that passes neither is provably untouched,
   * and the twenty-odd existing grids pass neither.
   *
   * 🔴 The re-sync keys off `defaultSort?.key` / `?.dir` **primitives**, never the object: every
   * consumer passes an inline literal, so an effect depending on its identity would fire on every
   * render forever.
   */
  onSortChange?: (sort: { key: string; dir: 'asc' | 'desc' } | null) => void
  onFilterChange?: (filters: Record<string, unknown>) => void
  /**
   * S4.1 (additive; default off) — the other half of the URL bridge: page and search.
   *
   * AR.S0 §7 measured why these two could not be bridged from outside: `page` and `search` live in
   * private state with no seed and no callback, so `?page=` could not round-trip on any page in
   * the section. Same contract as the sort/filter pair above — passing a callback turns on
   * re-sync from the seed prop, and consumers that pass neither are provably untouched.
   *
   * The grid's own page resets (a filter click, a search keystroke, a rows-per-page change all
   * `setPage(1)`) EMIT, so the URL follows the grid rather than disagreeing with it. The emitted
   * page is the RAW state, never the render-time clamp: while rows load, `pageCount` is 1 and
   * emitting the clamp would wipe a pasted `?page=5` before the data it names has arrived.
   */
  initialPage?: number
  onPageChange?: (page: number) => void
  initialSearch?: string
  onSearchChange?: (q: string) => void
  /**
   * FB.1 (additive; all three default off) — hand the filter STATE to the page.
   *
   * The eleven Rules & Automation pages render one merged bar at the top of the page, above the
   * summary band, holding both scope and metric filters. They own that state (it is in the URL),
   * so the grid has to read it rather than keep its own: pass `filterState` +
   * `onFilterStateChange` and the grid still does all of its client-side range/select filtering
   * from that state, but stores nothing. `hideFilterPanel` then suppresses the grid's own copy of
   * the panel, since the page is already rendering one.
   *
   * 🔴 Passing `filterState` also disables the BID.S0 seed/emit bridge above — with the page
   * holding the state there is nothing to seed and nothing to emit, and leaving both live would
   * put two writers on one URL.
   *
   * Omitting all three changes nothing, which is why the twenty-odd grids outside this section
   * (campaigns, ebay, reporting) are untouched by construction.
   */
  filterState?: FilterState
  onFilterStateChange?: (next: FilterState) => void
  hideFilterPanel?: boolean
  /**
   * R3 (additive; default off) — SERVER-DRIVEN mode, for a consumer that filters, sorts and
   * pages in SQL rather than in the browser.
   *
   * Everything above assumes the grid holds the whole result: it filters, searches, sorts and
   * slices `rows` itself. That is right for a 220-campaign account and wrong for a report — the
   * search-terms report is 12,276 rows and grows daily. Sorting a 50-row page and presenting it
   * as the top 50 is the failure mode here, and it is invisible: the numbers look plausible and
   * are simply not the answer to the question asked.
   *
   * Passed: the grid renders `rows` VERBATIM — no filtering, no search, no sort, no slicing —
   * and takes the result size from `total`. Clicking a header still cycles the sort and still
   * calls `onSortChange`; typing still calls `onSearchChange`; paging still calls `onPageChange`.
   * The consumer re-queries and hands back the next page. Every visual affordance is unchanged
   * because none of them moved: only who computes the rows did.
   *
   * Omitted: every branch below is gated on `server != null`, so the fifty-odd existing consumers
   * take exactly the code path they take today.
   */
  server?: {
    /** Rows across the WHOLE result, not the page in `rows`. Drives the count and the pager. */
    total: number
    /** Page size the query used. Owned by the consumer, since it is a query parameter. */
    rowsPerPage: number
    onRowsPerPageChange: (n: number) => void
  }
}

// Consonant-y takes -ies ("8 Queries", not "8 Querys" — shipped, seen, fixed).
const pluralize = (noun: string, n: number) => (n === 1 ? noun : /[^aeiou]y$/i.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`)

export function WorkspaceGrid<T>({
  rows, loading, rowId, noun,
  firstColLabel, renderFirst, firstSortValue,
  columns, filters, filterPresetsKey,
  toolbarLeft, toolbarRight, exportable, onExport, customizable = true, storageKey, hierarchy,
  selectable = true, selected, onSelectedChange,
  showTotal, totalFirst = 'Total',
  reportLabel, emptyLabel = 'No data.', emptyNode, defaultSort, enabledFirst, editMode, selectionActions,
  searchable, searchPlaceholder = 'Search…', searchValue, pagerCentered, filtersDefaultOpen = true,
  groupBy, onRowClick, keyboardNav, onRowKey, initialFilters, rowClassName,
  onSortChange, onFilterChange,
  initialPage, onPageChange, initialSearch, onSearchChange,
  filterState, onFilterStateChange, hideFilterPanel, server,
}: WorkspaceGridProps<T>) {
  const [searchOpen, setSearchOpen] = useState(() => !!initialSearch)
  const [search, setSearch] = useState(initialSearch ?? '')
  // FB.1 — controlled when the page passes `filterState`; otherwise the grid keeps its own, exactly
  // as before. `setFstate` keeps the functional-updater signature either way so every call site
  // below is unchanged; the ref is what makes an updater correct under control, where there is no
  // setState to read the previous value from.
  const [ownFstate, setOwnFstate] = useState<FilterState>(initialFilters ?? {})
  const filtersControlled = filterState !== undefined
  const fstate = filtersControlled ? filterState : ownFstate
  const fstateRef = useRef(fstate)
  fstateRef.current = fstate
  const setFstate = (u: FilterState | ((s: FilterState) => FilterState)) => {
    const next = typeof u === 'function' ? u(fstateRef.current) : u
    if (filtersControlled) onFilterStateChange?.(next)
    else setOwnFstate(next)
  }
  // ── ER3.1 Filter Library (only when filterPresetsKey is set) ──
  const [presets, setPresets] = useState<Array<{ name: string; values: FilterState }>>([])
  const [presetSaveOpen, setPresetSaveOpen] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [presetRenaming, setPresetRenaming] = useState<string | null>(null)
  useEffect(() => {
    if (!filterPresetsKey) return
    try { const raw = localStorage.getItem(filterPresetsKey); if (raw) setPresets(JSON.parse(raw)) } catch { /* ignore */ }
  }, [filterPresetsKey])
  const persistPresets = (next: Array<{ name: string; values: FilterState }>) => {
    setPresets(next)
    if (filterPresetsKey) { try { localStorage.setItem(filterPresetsKey, JSON.stringify(next)) } catch { /* ignore */ } }
  }
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(defaultSort ?? null)
  const [userSorted, setUserSorted] = useState(false)
  // ── inline edit mode (H10 "Edit Groups") ──
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({})
  const [applying, setApplying] = useState(false)
  const editByKey = useMemo(() => new Map((editMode?.fields ?? []).map((f) => [f.key, f])), [editMode])
  const setDraft = (id: string, key: string, v: string) => setDrafts((d) => ({ ...d, [id]: { ...d[id], [key]: v } }))
  const [page, setPage] = useState(() =>
    initialPage != null && Number.isFinite(initialPage) && initialPage >= 1 ? Math.floor(initialPage) : 1)
  const [rowsPerPage, setRowsPerPage] = useState(100)
  const [showCustomize, setShowCustomize] = useState(false)

  /**
   * SGX3 — column preferences: WHICH columns, in WHAT ORDER, and what STICKS.
   *
   * One record per `storageKey`, because the operator asked for the /products/next dialog and
   * "the ability to customize it all, or even the locking position thing" — so order and
   * stickiness are preferences here, not fixed component config. `visible` carries both the set
   * AND the order, exactly as the DS `PreferencesModal` returns it, so there is one source of
   * truth rather than a Set beside an array that could disagree.
   */
  const defaultVisibleKeys = useMemo(
    () => columns.filter((c) => !c.defaultHidden).map((c) => c.key), [columns])
  const [prefs, setPrefs] = useState<GridPrefs>(() => ({ visible: defaultVisibleKeys, stickyFirst: true, stickyLast: true }))
  /**
   * 🔴 SGX — a grid that swapped its column set kept the OLD one's hidden keys.
   *
   * `prefs` is seeded by a `useState` INITIALIZER, which runs once per mount. This effect then
   * re-read the persisted set when `storageKey` changed — but did nothing at all when nothing was
   * stored, leaving the previous column set's `defaultHidden` keys in place. On a page whose tabs
   * share one grid instance that is a visible defect, not a nuance: on Suggestions, clicking Bids
   * → New Keywords dropped Date Added, Suggestion Created, Clicks, CTR and PPC Orders, because
   * those are `defaultHidden` on BIDS. The operator's per-family column lists therefore only
   * appeared on a hard page load — every in-app tab click showed the first tab's shape.
   *
   * A storageKey change means a different saved view, so the fall-through is explicit: use what is
   * stored, and when nothing is stored fall back to THESE columns' own defaults.
   *
   * SGX3 — reads BOTH storage shapes. The old one was a bare `string[]` of visible keys; a saved
   * view from before this change keeps working and simply adopts sticky-on, which is what it had.
   * Keys that no longer exist in this column set are dropped rather than trusted.
   */
  useEffect(() => {
    if (!storageKey) return
    const known = new Set(columns.map((c) => c.key))
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) {
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed)) {
          setPrefs({ visible: (parsed as string[]).filter((k) => known.has(k)), stickyFirst: true, stickyLast: true })
          return
        }
        const o = parsed as Partial<GridPrefs>
        if (o && Array.isArray(o.visible)) {
          setPrefs({
            visible: o.visible.filter((k) => known.has(k)),
            stickyFirst: o.stickyFirst !== false,
            stickyLast: o.stickyLast !== false,
          })
          return
        }
      }
    } catch { /* ignore — fall through to this column set's own defaults */ }
    setPrefs({ visible: columns.filter((c) => !c.defaultHidden).map((c) => c.key), stickyFirst: true, stickyLast: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])
  /**
   * 🔴 RPX.0 — a grid whose columns ARRIVE LATER rendered ZERO columns.
   *
   * `prefs` is seeded by a `useState` initializer, which runs once at mount. A consumer that
   * fetches its column definitions — the ads Reporting runner is the one in this codebase —
   * mounts with `columns: []`, so it seeded `visible: []`. The effect above is the repair, but
   * it opens with `if (!storageKey) return`, and the runner persists nothing. Nothing ever
   * refilled the list, so `visibleCols` stayed empty for the life of the page and the table
   * rendered its sticky first column and nothing else.
   *
   * Measured on prod 2026-08-26 before the fix: `/marketing/ads/reporting/campaign` had ONE
   * `<th>` ("Campaign") while `GET /reporting/run` returned all seven columns and a full totals
   * object. Every one of the twelve runnable reports was affected. The regression came in with
   * the inversion of the model from a HIDE-list (`columns.filter(c => !hidden.has(c.key))`,
   * where an empty set showed everything) to a SHOW-list (`prefs.visible.map(...)`, where an
   * empty list shows nothing) — an empty default flipped from "all" to "none".
   *
   * The same omission had a second effect on those consumers: when the column SET changed
   * (a different report, a different grouping), the stale visible list kept only the keys the
   * two sets happened to share, so columns silently went missing on every re-query.
   *
   * So this re-seeds from THIS column set's own defaults whenever the set of column KEYS
   * changes — keyed on the signature rather than the array, because a consumer that rebuilds
   * its `columns` array on every fetch (the runner does) must not lose an in-session Customize
   * choice to a re-render that changed nothing.
   *
   * A grid that DOES persist is covered as well, but only while nothing is stored for it: the
   * same empty seed happens on a first visit to a persisted grid whose columns arrive late, and
   * the effect above cannot repair it because `storageKey` never changes afterwards. Once a view
   * is stored that view wins, which is exactly what the effect above already decides.
   */
  const colKeySig = useMemo(() => columns.map((c) => c.key).join(' '), [columns])
  const lastColSig = useRef<string | null>(null)
  useEffect(() => {
    if (storageKey) {
      try { if (localStorage.getItem(storageKey)) return } catch { /* unreadable - seed from defaults */ }
    }
    if (lastColSig.current === colKeySig) return
    lastColSig.current = colKeySig
    if (!columns.length) return
    const next = columns.filter((c) => !c.defaultHidden).map((c) => c.key)
    // A no-op set still re-renders, and this runs on every column change — compare first.
    setPrefs((p) => (p.visible.length === next.length && p.visible.every((k, i) => k === next[i])
      ? p
      : { ...p, visible: next }))
  }, [colKeySig, storageKey, columns])

  const persistPrefs = (p: GridPrefs) => { if (storageKey) { try { localStorage.setItem(storageKey, JSON.stringify(p)) } catch { /* ignore */ } } }

  /** The operator's order IS the render order — a drag handle that did not move a column would lie. */
  const visibleCols = useMemo(() => {
    const byKey = new Map(columns.map((c) => [c.key, c] as const))
    return prefs.visible.map((k) => byKey.get(k)).filter((c): c is GridColumn<T> => !!c)
  }, [columns, prefs.visible])

  /** The first column is the row's identity cell (`renderFirst`), not a `GridColumn` — it cannot
   *  be hidden or moved, but whether it STICKS is now the operator's call. */
  const fzFirst = prefs.stickyFirst ? ' fz' : ''

  /** The dialog's registry: the identity column (locked — it is the row's name and its selection
   *  target, so it cannot be hidden or moved) followed by every real column, all draggable. */
  const prefsColumns = useMemo<PreferencesColumnSpec[]>(
    () => [{ key: '__first', label: firstColLabel, locked: true }, ...columns.map((c) => ({ key: c.key, label: c.label }))],
    [columns, firstColLabel],
  )

  // SG.2 — right-pinned columns: cumulative offsets over the VISIBLE pinned set, right-to-left.
  // The leftmost pinned column carries the separator (class `fzr0`). SGX3 — an empty list when the
  // operator turns sticky-last off, which drops every `fzr*` class and lets them scroll inline.
  const fzRight = useMemo(() => {
    const list = prefs.stickyLast ? visibleCols.filter((c) => c.freezeRight && c.width != null) : []
    const offsets = new Map<string, number>()
    let acc = 0
    for (let i = list.length - 1; i >= 0; i--) {
      offsets.set(list[i].key, acc)
      acc += list[i].width!
    }
    return { offsets, first: list[0]?.key }
  }, [visibleCols, prefs.stickyLast])
  /** WG.1 — `align` first, `metric` as the legacy spelling. Six call sites read this; before it
   *  existed each of them wrote `c.metric === false ? 'ed' : 'num'` inline, which is six places
   *  to miss when a third alignment arrives. */
  const alignClass = (c: GridColumn<T>): string =>
    c.align === 'center' ? 'ctr' : c.align === 'left' ? 'ed' : c.align === 'right' ? 'num' : c.metric === false ? 'ed' : 'num'

  const fzrClass = (c: GridColumn<T>): string =>
    fzRight.offsets.has(c.key) ? (c.key === fzRight.first ? ' fzr fzr0' : ' fzr') : ''
  const fzrStyle = (c: GridColumn<T>): CSSProperties | undefined =>
    fzRight.offsets.has(c.key)
      ? { right: fzRight.offsets.get(c.key), width: c.width, minWidth: c.width, maxWidth: c.width }
      : c.width != null ? { width: c.width, minWidth: c.width, maxWidth: c.width } : undefined

  // internal selection fallback when uncontrolled
  const [selInner, setSelInner] = useState<Set<string>>(new Set())
  const sel = selected ?? selInner
  const setSel = (s: Set<string>) => { if (onSelectedChange) onSelectedChange(s); else setSelInner(s) }

  // ── filtering ──
  const filterAccessor = useMemo(() => {
    const byKey = new Map<string, GridColumn<T>>()
    for (const c of columns) byKey.set(c.key, c)
    return byKey
  }, [columns])

  // R3 — in server mode the rows ARE the answer: filtering, searching and sorting all
  // happened in SQL over the whole result, and redoing any of them here would narrow a page
  // that is already the correct page.
  const serverMode = server != null
  /**
   * Tree order is the only order, so the client pipeline is bypassed for the same reason server
   * mode bypasses it: the rows arrived in a deliberate sequence and re-deriving one would lie.
   */
  const treeMode = hierarchy != null
  const rawOrder = serverMode || treeMode
  const filtered = useMemo(() => {
    if (rawOrder) return rows
    if (!filters?.length) return rows
    return rows.filter((row) => {
      for (const f of filters) {
        const st = fstate[f.key]
        if (f.kind === 'range') {
          const r = (st as RangeVal | undefined)
          if (!r || (!r.min && !r.max)) continue
          const acc = f.value ?? filterAccessor.get(f.key)?.filterValue
          if (!acc) continue
          const v = (acc as (row: T) => number)(row)
          // NaN = "not measured" by every consumer's convention, and their filter tips promise
          // an unmeasured row never matches a SET range — NaN compares false both ways, so
          // without this it would silently pass instead.
          if (Number.isNaN(v)) return false
          if (r.min !== '' && v < Number(r.min)) return false
          if (r.max !== '' && v > Number(r.max)) return false
        } else if (f.kind === 'multiselect') {
          const vals = (st as string[] | undefined) ?? []
          if (vals.length === 0) continue
          const acc = f.value as ((row: T) => string) | undefined
          if (!acc) continue
          if (!vals.includes(acc(row))) return false
        } else {
          const val = st as string | undefined
          if (!val) continue
          const acc = f.value as ((row: T) => string) | undefined
          if (!acc) continue
          if (acc(row) !== val) return false
        }
      }
      return true
    })
  }, [rows, filters, fstate, filterAccessor, rawOrder])

  // ── search (H10 inline 🔍) — narrows on the first-column text by default ──
  const searched = useMemo(() => {
    if (rawOrder) return filtered
    const q = search.trim().toLowerCase()
    if (!searchable || !q) return filtered
    const acc = searchValue ?? firstSortValue
    if (!acc) return filtered
    return filtered.filter((r) => String(acc(r) ?? '').toLowerCase().includes(q))
  }, [filtered, search, searchable, searchValue, firstSortValue, rawOrder])

  // ── sorting ──
  const sorted = useMemo(() => {
    if (rawOrder) return searched
    // SF.1 — enabled-first governs the DEFAULT view only. Once a header is clicked that column
    // owns the order outright (sorting by Spend must really mean Spend, even if the top spender is
    // paused); clearing the sort restores this banding.
    const bandBy = enabledFirst && !userSorted ? enabledFirst : null
    if (!sort && !groupBy && !bandBy) return searched
    const col = sort ? columns.find((c) => c.key === sort.key) : null
    const getVal = !sort ? null : (sort.key === '__first'
      ? (firstSortValue ?? (() => ''))
      : (col?.sortValue ?? (() => 0)))
    const arr = [...searched]
    arr.sort((a, b) => {
      // groupBy clusters same-group rows (groups ordered by label); the active column
      // sort then orders rows *within* each group.
      if (groupBy) {
        const ga = groupBy(a), gb = groupBy(b)
        if (ga.key !== gb.key) {
          // R1 — an explicit `order` wins; otherwise alphabetical, exactly as before.
          if (ga.order != null && gb.order != null && ga.order !== gb.order) return ga.order - gb.order
          return ga.label.localeCompare(gb.label)
        }
      }
      if (bandBy) {
        const ra = enabledRank(bandBy(a)), rb = enabledRank(bandBy(b))
        if (ra !== rb) return ra - rb
      }
      if (!getVal || !sort) return 0
      const va = getVal(a) as number | string | null | undefined
      const vb = getVal(b) as number | string | null | undefined
      // KT.3 — a column may return null/undefined for "this row has no value", and a blank must sink
      // in BOTH directions. Returned BEFORE the direction flip, so it is not merely reversed:
      // otherwise "sort by spend ascending" surfaces every row we never paid for instead of the
      // cheapest one we did. Additive — of 321 sortValue definitions in the ads tree, none returns
      // null today (28 substitute a sentinel like NEGATIVE_INFINITY, which is exactly the flaw this
      // lets a column opt out of), so no existing consumer changes behaviour.
      if (va == null || vb == null) return va == null ? (vb == null ? 0 : 1) : -1
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [searched, sort, columns, firstSortValue, groupBy, enabledFirst, userSorted, rawOrder])

  // group row counts (for the group-header labels), computed over the full sorted set
  const groupCounts = useMemo(() => {
    if (!groupBy) return null
    const m = new Map<string, number>()
    for (const r of sorted) { const k = groupBy(r).key; m.set(k, (m.get(k) ?? 0) + 1) }
    return m
  }, [sorted, groupBy])

  // The page size is a QUERY PARAMETER in server mode, so the consumer owns it; the grid still
  // renders the same picker. `totalCount` is the whole result, never the page in `rows`.
  const perPage = server ? server.rowsPerPage : rowsPerPage
  const totalCount = server ? server.total : sorted.length
  const pageCount = Math.max(1, Math.ceil(totalCount / perPage))
  const safePage = Math.min(page, pageCount)
  const paged = (server || treeMode) ? sorted : sorted.slice((safePage - 1) * perPage, safePage * perPage)
  const viewStart = totalCount === 0 ? 0 : (safePage - 1) * perPage + 1
  const viewEnd = Math.min(safePage * perPage, totalCount)

  // ── keyboard navigation (opt-in via keyboardNav) ──
  const [focusIdx, setFocusIdx] = useState(-1)
  const focusRef = useRef(-1); focusRef.current = focusIdx
  const pagedRef = useRef(paged); pagedRef.current = paged
  useEffect(() => { setFocusIdx((i) => (i >= paged.length ? paged.length - 1 : i)) }, [paged.length])
  useEffect(() => {
    if (!keyboardNav) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const rows = pagedRef.current, n = rows.length
      if (n === 0) return
      const k = e.key.toLowerCase()
      if (k === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setFocusIdx((i) => Math.min(n - 1, i + 1)) }
      else if (k === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setFocusIdx((i) => Math.max(0, (i < 0 ? 0 : i) - 1)) }
      else {
        const i = focusRef.current
        if (i < 0 || i >= n) return
        if (k === 'o' || e.key === 'Enter') { e.preventDefault(); onRowClick?.(rows[i]) }
        else onRowKey?.(rows[i], k)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [keyboardNav, onRowClick, onRowKey])
  // WG.2b — scope to THIS grid. `document.querySelector('.nds-wsgrid …')` took the first match on
  // the page, so with two grids mounted the keyboard focus scrolled the wrong one.
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (focusIdx < 0) return
    rootRef.current?.querySelector('tr.kbd-focus')?.scrollIntoView({ block: 'nearest' })
  }, [focusIdx])

  // ── BID.S0 — URL-linkable sort + filters (additive; only for consumers that opted in) ──────────
  //
  // Inward: follow the seed props when they change, so the back button and a pasted link land on
  // the view they describe. Keyed on PRIMITIVES — `defaultSort` is an inline literal at every call
  // site, so an effect on the object would re-run on every render.
  const dsKey = defaultSort?.key ?? ''
  const dsDir = defaultSort?.dir ?? 'desc'
  useEffect(() => {
    if (!onSortChange) return
    setSort(dsKey ? { key: dsKey, dir: dsDir } : null)
    setUserSorted(!!dsKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsKey, dsDir])

  // Outward: emit when the filter state actually changed, never on mount, and never as an echo of
  // an inbound seed — otherwise the URL update re-seeds the grid, which re-emits, forever.
  const seededFilters = JSON.stringify(initialFilters ?? {})
  const lastEmitted = useRef<string | null>(null)
  const suppressEmit = useRef(false)
  useEffect(() => {
    if (filtersControlled || !onFilterChange || !initialFilters) return
    const merged = { ...fstateRef.current, ...initialFilters }
    if (JSON.stringify(merged) === JSON.stringify(fstate)) return
    // Merge rather than replace: the seed carries only the params the page puts in the URL, and
    // replacing would silently drop whatever numeric ranges the operator had typed.
    suppressEmit.current = true
    setFstate(merged)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seededFilters])
  useEffect(() => {
    if (filtersControlled || !onFilterChange) return
    const s = JSON.stringify(fstate)
    if (lastEmitted.current === null) { lastEmitted.current = s; return }
    if (lastEmitted.current === s) return
    lastEmitted.current = s
    if (suppressEmit.current) { suppressEmit.current = false; return }
    onFilterChange(fstate)
  }, [fstate, onFilterChange])

  // ── S4.1 — URL-linkable page + search (additive; the same shape as the BID.S0 block above) ─────
  //
  // Inward seeds land through the useState INITIALIZERS on mount; these effects exist only for
  // LATER seed changes (the back button, a pasted link). `bridgeMounted` — declared LAST so the
  // mount pass sees it false — keeps the mount run from arming `suppress*`, which would otherwise
  // swallow the first real user action instead of an echo.
  const bridgeMounted = useRef(false)
  const seedPage = initialPage != null && Number.isFinite(initialPage) && initialPage >= 1 ? Math.floor(initialPage) : null
  const suppressPageEmit = useRef(false)
  useEffect(() => {
    if (!onPageChange || seedPage == null || !bridgeMounted.current) return
    suppressPageEmit.current = true
    setPage(seedPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedPage])
  const lastPageEmitted = useRef<number | null>(null)
  useEffect(() => {
    if (!onPageChange) return
    if (lastPageEmitted.current === null) { lastPageEmitted.current = page; return }
    if (lastPageEmitted.current === page) return
    lastPageEmitted.current = page
    if (suppressPageEmit.current) { suppressPageEmit.current = false; return }
    onPageChange(page)
  }, [page, onPageChange])

  const seedSearch = initialSearch ?? ''
  const suppressSearchEmit = useRef(false)
  useEffect(() => {
    if (!onSearchChange || !bridgeMounted.current) return
    suppressSearchEmit.current = true
    setSearch(seedSearch)
    if (seedSearch) setSearchOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedSearch])
  const lastSearchEmitted = useRef<string | null>(null)
  useEffect(() => {
    if (!onSearchChange) return
    if (lastSearchEmitted.current === null) { lastSearchEmitted.current = search; return }
    if (lastSearchEmitted.current === search) return
    lastSearchEmitted.current = search
    if (suppressSearchEmit.current) { suppressSearchEmit.current = false; return }
    onSearchChange(search)
  }, [search, onSearchChange])
  useEffect(() => { bridgeMounted.current = true }, [])

  // SF.1 — `userSorted` distinguishes "the grid's default order" from "the operator asked for this
  // order". Third click clears the sort, which also drops back to the default (enabled-first) view.
  const onSort = (key: string) => {
    const next: { key: string; dir: 'asc' | 'desc' } | null =
      sort?.key === key ? (sort.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' }
    setSort(next)
    setUserSorted(next !== null)
    // BID.S0 — additive. Undefined on every existing consumer.
    onSortChange?.(next)
  }
  const sortIcon = (key: string) => (sort?.key === key
    ? (sort.dir === 'asc' ? <ChevronUp size={13} className="sa on" /> : <ChevronDown size={13} className="sa on" />)
    : <ChevronsUpDown size={13} className="sa" />)

  const pageIds = paged.map(rowId)
  const allSel = pageIds.length > 0 && pageIds.every((id) => sel.has(id))
  const toggleAll = () => { const n = new Set(sel); if (allSel) pageIds.forEach((id) => n.delete(id)); else pageIds.forEach((id) => n.add(id)); setSel(n) }
  const toggle = (id: string) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n) }

  const hasActiveFilters = Object.values(fstate).some((v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? !!v : !!(v.min || v.max)))

  // edit-mode diffs: a row contributes the fields whose draft differs from its initial
  const dirtyEdits = useMemo(() => {
    if (!editMode) return [] as Array<{ id: string; values: Record<string, string> }>
    const out: Array<{ id: string; values: Record<string, string> }> = []
    for (const row of sorted) {
      const id = rowId(row); const d = drafts[id]
      if (!d) continue
      const values: Record<string, string> = {}
      for (const f of editMode.fields) { const v = d[f.key]; if (v !== undefined && v !== f.initial(row)) values[f.key] = v }
      if (Object.keys(values).length) out.push({ id, values })
    }
    return out
  }, [editMode, sorted, drafts, rowId])
  const enterEdit = () => { setDrafts({}); setEditing(true) }
  const discardEdits = () => { setDrafts({}); setEditing(false) }
  const applyEdits = async () => {
    if (!editMode || !dirtyEdits.length || applying) return
    setApplying(true)
    try { await editMode.onApply(dirtyEdits); setDrafts({}); setEditing(false) } finally { setApplying(false) }
  }
  const editVal = (row: T, f: GridEditField<T>) => drafts[rowId(row)]?.[f.key] ?? f.initial(row)

  // ── per-cell hover-edit: the H10 ".h10-editpen" pencil (shown on row hover) opens a
  //    ".h10-editpop" popover. Reuses the same editMode.fields + onApply as bulk mode, but
  //    for ONE row+field. Available whenever editMode is set and bulk-edit isn't active. ──
  const [inline, setInline] = useState<{ id: string; key: string; top: number; left: number } | null>(null)
  const [inlineDraft, setInlineDraft] = useState('')
  const [savingInline, setSavingInline] = useState(false)
  const editLabelFor = (key: string) => (key === '__first' ? firstColLabel : columns.find((c) => c.key === key)?.label ?? '')
  const openInline = (id: string, key: string, init: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setInlineDraft(init)
    setInline({ id, key, top: r.bottom + 5, left: Math.max(8, Math.min(r.left, window.innerWidth - 226)) })
  }
  const saveInline = async () => {
    if (!inline || !editMode || savingInline) return
    setSavingInline(true)
    try { await editMode.onApply([{ id: inline.id, values: { [inline.key]: inlineDraft } }]); setInline(null) } finally { setSavingInline(false) }
  }
  const cellWithPencil = (row: T, key: string, content: ReactNode) => {
    const f = editByKey.get(key)
    if (!editMode || editing || !f) return content
    return <span className="h10-ec">{content}<button type="button" className="h10-editpen" aria-label={`Edit ${editLabelFor(key)}`} onClick={(e) => openInline(rowId(row), key, f.initial(row), e.currentTarget)}><Pencil size={12} /></button></span>
  }
  const inlineRow = inline ? sorted.find((r) => rowId(r) === inline.id) : undefined
  const inlineField = inline ? editByKey.get(inline.key) : undefined

  return (
    <>
      {/* FB.1 — one implementation, rendered here unless the page renders it itself at the top. */}
      {hideFilterPanel ? null : (
        <AdsFilterBar
          filters={filters ?? []}
          value={fstate}
          onChange={(next) => setFstate(next)}
          onAfterChange={() => setPage(1)}
          defaultOpen={filtersDefaultOpen}
          presetsSlot={filterPresetsKey ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--nds-text-muted)' }}>Presets:</span>
                    {presets.map((p) => (
                      <span key={p.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                        {presetRenaming === p.name ? (
                          <input
                            className="h10-edit-in" autoFocus defaultValue={p.name} style={{ width: 120 }}
                            aria-label="Rename preset"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { const nn = (e.target as HTMLInputElement).value.trim().slice(0, 60); if (nn) persistPresets(presets.map((x) => (x.name === p.name ? { ...x, name: nn } : x))); setPresetRenaming(null) }
                              if (e.key === 'Escape') setPresetRenaming(null)
                            }}
                            onBlur={() => setPresetRenaming(null)}
                          />
                        ) : (
                          <Button
 size="sm" title="Apply preset · double-click to rename"
 /* FB.1 — a preset carries metric filters ONLY. It keeps whatever scope keys are
 set, because a saved metric view must never move you to another account view. */
 onClick={() => { setFstate((cur) => ({ ...Object.fromEntries(Object.entries(cur).filter(([k]) => isServerKey(k))), ...stripServerKeys(p.values) })); setPage(1) }}
 onDoubleClick={() => setPresetRenaming(p.name)}
 >{p.name}</Button>
                        )}
                        <Button variant="link" aria-label={`Delete preset ${p.name}`} style={{ fontSize: 11 }} onClick={() => persistPresets(presets.filter((x) => x.name !== p.name))}>✕</Button>
                      </span>
                    ))}
                    {presetSaveOpen ? (
                      <input
                        className="h10-edit-in" autoFocus placeholder="preset name…" value={presetName} style={{ width: 140 }}
                        aria-label="Preset name"
                        onChange={(e) => setPresetName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { const nn = presetName.trim().slice(0, 60); if (nn) persistPresets([...presets.filter((x) => x.name !== nn), { name: nn, values: stripServerKeys(fstate) }]); setPresetName(''); setPresetSaveOpen(false) }
                          if (e.key === 'Escape') { setPresetName(''); setPresetSaveOpen(false) }
                        }}
                      />
                    ) : (
                      <Button variant="link" style={{ fontSize: 12 }} disabled={!hasActiveFilters} onClick={() => setPresetSaveOpen(true)}>Save preset</Button>
                    )}
                  </span>
          ) : undefined}
        />
      )}

      {/* one card: toolbar + grid + pager share the grid rectangle (H10 — toolbar sits inside it) */}
      <div className="nds-card h10-cardstack">
      {/* toolbar */}
      <div className="h10-am-toolbar">
        <span className="cnt">{selectable && sel.size > 0
          ? <b>{`Selected ${sel.size} ${pluralize(noun, sel.size)}`}</b>
          : totalCount === 0 ? `Showing 0 ${pluralize(noun, 0)}` : `Viewing ${viewStart}-${viewEnd} of ${server ? totalCount.toLocaleString('en-GB') : totalCount} ${pluralize(noun, totalCount)}`}</span>
        {editMode && editMode.bulk !== false ? (editing ? (
          <span className="h10-edit-actions">
            <button type="button" className="h10-discard" onClick={discardEdits}>Discard Changes</button>
      <Button variant="primary" disabled={!dirtyEdits.length || applying} onClick={applyEdits}>{applying ? 'Applying…' : 'Apply Changes'}</Button>
          </span>
        ) : (
     <Button variant="primary" onClick={enterEdit}><Pencil size={13} /> {editMode.label}</Button>
        )) : toolbarLeft}
        {selectable && sel.size > 0 && !editing && selectionActions ? selectionActions([...sel], () => setSel(new Set())) : null}
        {/* inline 🔍 sits after the count + any selection actions (H10 order) */}
        {searchable && (searchOpen ? (
          <span className="h10-am-searchbox">
            <Search size={14} />
            <input autoFocus value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} placeholder={searchPlaceholder} aria-label="Search" />
            <button type="button" className="x" aria-label="Clear search" onMouseDown={(e) => e.preventDefault()} onClick={() => { setSearch(''); setSearchOpen(false) }}><X size={13} /></button>
          </span>
        ) : (
          <button type="button" className="h10-am-searchbtn" aria-label="Search" onClick={() => setSearchOpen(true)}><Search size={15} /></button>
        ))}
        <span className="grow" />
        {toolbarRight}
        {customizable && (
          <>
            <Button active={showCustomize} onClick={() => setShowCustomize(true)} aria-haspopup="dialog" aria-expanded={showCustomize}><Settings2 size={13} /> Customize</Button>
            {/**
              * SGX3 — the SHARED dialog, not a second implementation.
              *
              * This was a bespoke `.h10-custpop` popover: a 4-column checkbox grid that applied
              * instantly, with no reorder and no way back out. `/products/next` had already been
              * moved onto the DS `PreferencesModal`, so the ads console was the odd one out —
              * operator: *"make use of shared components so that there are no inconsistencies at
              * all."* Same component, same draft-and-Save interaction, same drag-to-reorder.
              *
              * The optional left-panel sections stay collapsed on purpose: page size and sort
              * already have their own controls on this grid (the footer picker and the sortable
              * headers), and a second control for one setting is the inconsistency in another
              * costume. The sticky toggles are shown — the operator asked for "the locking
              * position thing" to be theirs too.
              */}
            <PreferencesModal
              open={showCustomize}
              onClose={() => setShowCustomize(false)}
              title="Table Customisation"
              value={{ visibleColumns: prefs.visible, stickyFirstColumn: prefs.stickyFirst, stickyLastColumn: prefs.stickyLast, pageSize: perPage, sortBy: sort?.key ?? '', sortDir: sort?.dir ?? 'desc' }}
              onConfirm={(next) => {
                const p: GridPrefs = { visible: next.visibleColumns, stickyFirst: next.stickyFirstColumn, stickyLast: next.stickyLastColumn }
                setPrefs(p)
                persistPrefs(p)
              }}
              allColumns={prefsColumns}
              defaultVisible={defaultVisibleKeys}
              sortFieldOptions={[]}
              pageSizeChoices={[]}
              showSticky
            />
          </>
        )}
    {exportable && <Button onClick={onExport}><Download size={13} /> Export Data…</Button>}
      </div>

      {/* grid */}
      <div ref={rootRef} className={`nds-wsgrid${selectable ? '' : ' nosel'}`}>
        <table>
          <thead>
            <tr>
              {selectable && <th className="ck"><input type="checkbox" checked={allSel} onChange={toggleAll} aria-label="Select all" /></th>}
              <th className={`nm${fzFirst}${sort?.key === '__first' ? ' sorted' : ''}`}><button type="button" className="sortable" onClick={() => onSort('__first')}>{firstColLabel} {firstSortValue && sortIcon('__first')}</button></th>
              {visibleCols.map((c) => (
                <th key={c.key} className={`${alignClass(c)}${sort?.key === c.key ? ' sorted' : ''}${fzrClass(c)}`} style={fzrStyle(c)}>
                  {c.sortable === false
                    ? <span className="hl">{c.tip ? <HoverCard text={c.tip} placement="above" delay={600} shouldSuppress={colDragging}><span>{c.label}</span></HoverCard> : c.label}</span>
                    : <button type="button" className="sortable" onClick={() => onSort(c.key)}>
                        {c.tip
                          ? <HoverCard text={c.tip} placement="above" delay={600} shouldSuppress={colDragging}><span className="hl">{c.label} {sortIcon(c.key)}</span></HoverCard>
                          : <span className="hl">{c.label} {sortIcon(c.key)}</span>}
                      </button>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={`sk${i}`} className="sk">
                  {selectable && <td className="ck"><span className="skb" style={{ width: 15 }} /></td>}
                  <td className={`nm${fzFirst}`}><span className="skb" style={{ width: 170 }} /></td>
                  {visibleCols.map((c) => <td key={c.key} className={`${alignClass(c)}${fzrClass(c)}`} style={fzrStyle(c)}><span className="skb" style={{ width: 52 }} /></td>)}
                </tr>
              ))
            ) : paged.length === 0 ? (
              <tr><td colSpan={visibleCols.length + (selectable ? 2 : 1)} className="empty">{emptyNode ?? emptyLabel}</td></tr>
            ) : (
              <>
                {showTotal && (
                  <tr className="h10-am-total">
                    {selectable && <td className="ck" />}
                    <td className={`nm${fzFirst}`}><b>{totalFirst}</b></td>
                    {visibleCols.map((c) => <td key={c.key} className={`${alignClass(c)}${fzrClass(c)}`} style={fzrStyle(c)}>{(typeof c.total === 'function' ? (c.total as (r: T[]) => ReactNode)(sorted) : c.total) ?? ''}</td>)}
                  </tr>
                )}
                {paged.map((row, idx) => {
                  const id = rowId(row)
                  const ef = editing ? editByKey.get('__first') : undefined
                  const grp = groupBy ? groupBy(row) : null
                  const showGrp = grp != null && (idx === 0 || groupBy?.(paged[idx - 1])?.key !== grp.key)
                  return (
                    <Fragment key={id}>
                      {showGrp && grp && (
                        <tr className="h10-am-grp"><td colSpan={visibleCols.length + (selectable ? 2 : 1)}><span className="gl">{grp.label}</span><span className="gc">{groupCounts?.get(grp.key) ?? 0} {pluralize(noun, groupCounts?.get(grp.key) ?? 0)}</span></td></tr>
                      )}
                      <tr
                        className={`${sel.has(id) ? 'on' : ''}${onRowClick ? ' clickable' : ''}${keyboardNav && idx === focusIdx ? ' kbd-focus' : ''}${rowClassName?.(row) ? ` ${rowClassName(row)}` : ''}${hierarchy?.isRemainder?.(row) ? ' nds-tree-remainder' : ''}`}
                        onClick={onRowClick ? (e) => { if (!(e.target as HTMLElement).closest('button, a, input, label, select')) onRowClick(row) } : undefined}
                      >
                        {selectable && (
                          <td className="ck">
                            {/* A remainder is arithmetic, not a thing you can act on. Rendering a
                                checkbox beside it would offer a bulk action on a row that has no
                                entity behind it. */}
                            {hierarchy?.isRemainder?.(row)
                              ? null
                              : <input type="checkbox" checked={sel.has(id)} onChange={() => toggle(id)} aria-label="Select row" />}
                          </td>
                        )}
                        <td className={`nm${fzFirst}${ef ? ' editing' : ''}${hierarchy ? ' nds-tree-cell' : ''}`}>
                          {hierarchy ? (
                            /* The chevron lives INSIDE the identity cell, so the hierarchy travels
                               with the thing it belongs to instead of costing a column. The indent
                               is a spacer element rather than padding on the cell, because the cell
                               is sticky and its padding is what holds the frozen column together. */
                            <span className="nds-tree-lead" style={{ paddingInlineStart: `${hierarchy.depthOf(row) * 18}px` }}>
                              {hierarchy.expandableOf(row) ? (
                                <button
                                  type="button"
                                  className={`nds-tree-chev${hierarchy.expanded.has(id) ? ' on' : ''}${hierarchy.loading?.has(id) ? ' busy' : ''}`}
                                  aria-expanded={hierarchy.expanded.has(id)}
                                  aria-label={`${hierarchy.expanded.has(id) ? 'Collapse' : 'Expand'} ${String(firstSortValue?.(row) ?? '')}`.trim()}
                                  onClick={(e) => { e.stopPropagation(); hierarchy.onToggle(row, !hierarchy.expanded.has(id)) }}
                                >
                                  <ChevronDown size={13} aria-hidden />
                                </button>
                              ) : (
                                /* A leaf keeps the chevron's width so its label lines up with its
                                   siblings' — a ragged left edge reads as a broken indent. */
                                <span className="nds-tree-chev is-leaf" aria-hidden />
                              )}
                              <span className="nds-tree-label">{ef ? ef.render(editVal(row, ef), (v) => setDraft(id, '__first', v), row) : cellWithPencil(row, '__first', renderFirst(row))}</span>
                            </span>
                          ) : (ef ? ef.render(editVal(row, ef), (v) => setDraft(id, '__first', v), row) : cellWithPencil(row, '__first', renderFirst(row)))}
                        </td>
                        {visibleCols.map((c) => {
                          const cf = editing ? editByKey.get(c.key) : undefined
                          return <td key={c.key} className={`${alignClass(c)}${cf ? ' editing' : ''}${fzrClass(c)}`} style={fzrStyle(c)}>{cf ? cf.render(editVal(row, cf), (v) => setDraft(id, c.key, v), row) : cellWithPencil(row, c.key, c.render(row))}</td>
                        })}
                      </tr>
                    </Fragment>
                  )
                })}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* pager */}
      <div className="h10-am-pager">
        <span className="grow" />
        <div className="pg">
          <button type="button" className="pgbtn" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">‹</button>
          {Array.from({ length: Math.min(pageCount, 9) }).map((_, i) => (
            <button type="button" key={i} className={`pgbtn ${safePage === i + 1 ? 'on' : ''}`} onClick={() => setPage(i + 1)}>{i + 1}</button>
          ))}
          <button type="button" className="pgbtn" disabled={safePage >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))} aria-label="Next page">›</button>
        </div>
        {pagerCentered && <span className="grow" />}
        <div className="rpp">Rows per page:
          <Listbox width={84} options={[{ value: '50', label: '50' }, { value: '100', label: '100' }, { value: '200', label: '200' }, { value: '500', label: '500' }]} value={String(perPage)} onChange={(v) => { if (server) server.onRowsPerPageChange(Number(v)); else setRowsPerPage(Number(v)); setPage(1) }} ariaLabel="Rows per page" />
        </div>
      </div>
      </div>
      {reportLabel && <div className="h10-am-latest"><b>Latest Report:</b> {reportLabel} · Performance data is not real-time. <span className="lk">Learn More</span></div>}

      {/* per-cell hover-edit popover (portaled; reuses .h10-editpop styling) */}
      {inline && inlineField && typeof document !== 'undefined' && createPortal(<>
        <button type="button" className="h10-dd-back" aria-label="Close" onClick={() => setInline(null)} />
        <div className="h10-editpop" style={{ position: 'fixed', top: inline.top, left: inline.left, zIndex: 1000 }} role="dialog" aria-label={`Edit ${editLabelFor(inline.key)}`}>
          <div className="h">{editLabelFor(inline.key)}</div>
          {(inlineField.renderPopover ?? inlineField.render)(inlineDraft, setInlineDraft, inlineRow as T)}
          <div className="f">
            <Button size="sm" onClick={() => setInline(null)}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={savingInline} onClick={saveInline}>{savingInline ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      </>, document.body)}
    </>
  )
}

/** Column show/hide popover — replicates the H10 "Table Customization" dialog (the first
 *  column is locked on). Generic over the grid's own columns; no campaign coupling. */
