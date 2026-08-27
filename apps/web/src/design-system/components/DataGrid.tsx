'use client'

import { useEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode, Fragment } from 'react'
import { ChevronsUpDown, ChevronUp, ChevronDown, SlidersHorizontal } from 'lucide-react'
import { ToolbarButton } from '../primitives'
// The pattern FILE, not the `../patterns` barrel — see the note on the Modal
// import inside PreferencesModal for why the barrel would be a cycle.
import { PreferencesModal, type PreferencesValue } from '../patterns/PreferencesModal'

export interface Column<T> {
  key: string
  label: ReactNode
  render: (row: T) => ReactNode
  align?: 'left' | 'right' | 'center'
  /**
   * A figures column: right-aligned AND `font-variant-numeric: tabular-nums`.
   *
   * Not implied by `align: 'right'`, because a right-aligned STATUS is not a number. Measured:
   * the DS set `font-variant-numeric` on no selector at all, so every converted money column
   * silently lost the proportional-digit fix its hand-rolled version had — and in a grid,
   * digits lining up is the whole point.
   */
  numeric?: boolean
  /**
   * Class for this column's `<td>` AND `<th>`. Without it a per-column tweak has to be reached
   * with `:nth-child()`, which breaks the moment a column is hidden or reordered.
   */
  className?: string
  sortable?: boolean
  sortValue?: (row: T) => number | string
  /**
   * Hold this column in place in the Customise dialog — never hidden, never dragged — WITHOUT
   * pinning it to an edge.
   *
   * `sticky`/`stickyRight` already imply it, and until now they were the only way to say it. That
   * forced a grid whose Product and Actions columns must not move to pin them as well, which is a
   * visible, different decision: /products/next had its sticky toggles removed deliberately
   * because pinning the Product column was not wanted, and the column still has to stay put.
   *
   * Position picks the end it holds: past the last movable column it locks to the right, anywhere
   * else to the left. Ignored unless `customizable`.
   */
  prefsLocked?: boolean
  /** pin this column to the left (sticky); give a numeric `width` so offsets stack */
  sticky?: boolean
  /** pin this column to the right (sticky); give a numeric `width` so offsets stack */
  stickyRight?: boolean
  width?: number
  /** value rendered in the totals row */
  total?: ReactNode
  /**
   * Heading this column sits under in the Customise dialog's column tick-list. Columns without
   * one collect under the dialog's list label, so a grid that declares no groups renders exactly
   * one section and is unchanged. Ignored unless `customizable`.
   *
   * Presentation only — grouping does NOT constrain column order. The dialog's ordered list is
   * flat and reorders freely across groups.
   */
  group?: string
  /**
   * Plain-text name for the Customise dialog. Only needed when `label` is not a
   * string — most grids here pass JSX (`<Hdr …/>`, `<TipText>…</TipText>`), and
   * a dialog row reading "sku" instead of "SKU" is a worse lie than a verbose
   * prop. Falls back to `label` when it is a string, then to `key`.
   */
  prefsLabel?: string
}

export interface DataGridProps<T> {
  columns: Array<Column<T>>
  rows: T[]
  rowKey: (row: T) => string
  selectable?: boolean
  selected?: Set<string>
  onSelectedChange?: (next: Set<string>) => void
  /** Per-row selection gate (additive): rows where this returns false render a
   *  disabled checkbox and are excluded from select-all. Absent = all rows
   *  selectable (existing behavior — /products/next unchanged). */
  rowSelectable?: (row: T) => boolean
  /** Tooltip/aria label for a disabled row checkbox. */
  rowSelectableHint?: string
  /** SCT.1 — hover help for the select-all checkbox (what "all" means here). */
  selectAllHint?: string
  /** SCT.1 — hover help for a row checkbox. */
  selectRowHint?: string
  showTotals?: boolean
  emptyState?: ReactNode
  /**
   * Render an extra full-width row beneath a row. Return `null`/`undefined` for rows that do not
   * expand; the sub-row is only rendered when `rowKey(row)` is in `expanded`.
   *
   * The GRID owns the `colSpan`, because only it knows the column count — which shifts with
   * `selectable` and with hidden columns, and is exactly the number every hand-rolled version got
   * wrong the moment a column was toggled. The CALLER owns the caret: put it in whichever cell it
   * belongs to, with its own `aria-expanded` — the caret pattern `CampaignsTable` uses today for
   * its own hand-rolled expansion. (It does NOT use this prop; the precedent is the CARET, not
   * the expansion.)
   *
   * Renders ONE full-width cell. For children that must line up under the SAME columns as their
   * parent — a campaign's spend under the same Spend header — use `getSubRows` instead.
   */
  renderExpanded?: (row: T) => ReactNode
  /** Keys of the currently expanded rows. Controlled — the grid keeps no expansion state. */
  expanded?: Set<string>
  /**
   * Extra props for each `<tr>` — drag handlers, data-*, title.
   *
   * `rowClassName` covers appearance only; a grid whose ROWS are drop targets needs real
   * handlers. The portfolios list spreads onDragOver/onDragLeave/onDrop onto each row so a rule
   * can be dragged onto a family, and could not adopt the grid without this.
   */
  rowProps?: (row: T) => HTMLAttributes<HTMLTableRowElement>
  /**
   * Extra props for each `<th>` — pointer handlers and `data-*`.
   *
   * Drag-to-reorder columns needs `onPointerDown`/`onMouseEnter`/`onMouseLeave` on the header and
   * `data-col` readable back off the DOM. Without these a grid that already ships column dragging
   * cannot adopt `DataGrid` without DELETING that behaviour.
   */
  headerProps?: (column: Column<T>, index: number) => HTMLAttributes<HTMLTableCellElement>
  /** Extra props for each `<td>` — the same drag code reads `data-item`/`data-col` off cells. */
  cellProps?: (row: T, column: Column<T>, index: number) => HTMLAttributes<HTMLTableCellElement>
  /**
   * Children rendered as REAL rows beneath their parent, using the SAME columns — so a child's
   * spend sits under the same Spend header as its parent's.
   *
   * `renderExpanded` gives one full-width cell, which cannot express that. The workaround was
   * flattening parents and children into one `rows` array with a `kind` union and `sort={null}`,
   * which works but costs the grid its sorting. Shown only for rows in `expanded`.
   */
  getSubRows?: (row: T) => T[] | undefined
  /**
   * Let `getSubRows` children carry their own selection checkbox, and count them in select-all
   * while they are visible.
   *
   * Off by default, because the two grids using `getSubRows` with `selectable` today render an
   * EMPTY checkbox cell for children — an ad group is acted on through its campaign, and turning
   * that on under them would change what their select-all means. A grid whose children are
   * independently actionable (a product variation has its own status, its own price) opts in.
   *
   * `rowSelectable` still gates each child, exactly as it gates each parent.
   */
  subRowSelectable?: boolean
  /**
   * Row density. `md` (default) is 13px with 11px/14px cells; `sm` is 12.5px / 7px 10px; `xs` is
   * 11.5px / 5px 9px, matching the tier every other control gained.
   *
   * Measured against five real tables: 12px/11px 14px, 12.5px/7px 10px, 12.5px/6px 11px,
   * 11px/6px 10px, 11.5px/5px 9px. At one density the grid added up to 12px per row, which on a
   * page of six stacked tables is the difference between a page and a scroll.
   *
   * It scales UP as well: `lg` (14px) and `xl` (19px) vertical padding. A grid with no density
   * above its default cannot host a density control at all, and the campaigns grid ships a live
   * Compact / Comfortable / Spacious switch whose two looser steps had no DS equivalent.
   */
  size?: 'xl' | 'lg' | 'md' | 'sm' | 'xs'
  initialSort?: { key: string; dir: 'asc' | 'desc' }
  /**
   * Controlled sort (NAF.SB.AS-S1R S1.e — additive, opt-in).
   *
   * Pass `sort` AND `onSortChange` to own the sort state yourself: the grid
   * then renders the order you give it and reports header clicks instead of
   * keeping its own. That is what lets a page put its sort in the URL, choose
   * which direction a first click means per column, or offer a "back to the
   * default order" control — none of which are reachable while the state lives
   * in here.
   *
   * Omit both (every existing consumer) and nothing changes: the grid keeps its
   * own state seeded from `initialSort`, exactly as before. `undefined` means
   * uncontrolled; `null` means controlled-and-currently-unsorted, which is a
   * real state — it renders `rows` in the order they were passed.
   */
  sort?: { key: string; dir: 'asc' | 'desc' } | null
  onSortChange?: (next: { key: string; dir: 'asc' | 'desc' }) => void
  /**
   * Per-row class (NAF.SB.M-S3 — additive, opt-in).
   *
   * For pages whose law is *filtering dims, it never removes*: the row stays in
   * the table, in order, and recedes. Returning nothing (every existing
   * consumer) changes nothing. It composes with the built-in `sel` class rather
   * than replacing it.
   *
   * Deliberately a class and not a style, so the page owns what "dimmed" means
   * — a table that greys a row to unreadability has removed it in every sense
   * that matters to the reader.
   */
  rowClassName?: (row: T) => string | undefined
  /** cap height + scroll (sticky header/footer stay pinned) */
  maxHeight?: number | string
  className?: string
  /**
   * Column order + visibility as OPERATOR preferences (additive, opt-in).
   *
   * Omit it and nothing changes: `columns` renders in array order, exactly as
   * every consumer before this. Pass it and the grid gains the same Customise
   * dialog `AdsDataGrid` has had since SGX3 — the same `PreferencesModal`, so
   * the product has one Customise UI rather than a second spelling of it.
   *
   * Pinned columns (`sticky` / `stickyRight`) are **locked**: reorderable in
   * neither direction. The DS pins per column with offsets stacked by `width`,
   * which presumes pinned columns sit contiguously at an edge; the dialog pins
   * positionally. A developer-pinned column dragged into the middle would pin
   * over its neighbours, so the dialog holds them at the ends instead.
   */
  customizable?: boolean
  /**
   * localStorage key for those preferences. Without it `customizable` still
   * works, but the operator's order dies with the page — so pass it.
   */
  storageKey?: string
  /**
   * Controlled dialog state, for pages that already host their own Customise
   * button in a toolbar. Omit both and the grid renders its own trigger.
   */
  customizeOpen?: boolean
  onCustomizeOpenChange?: (open: boolean) => void
  /** Dialog heading + trigger label (default "Customise"). */
  customizeTitle?: string
  /**
   * Sort fields offered INSIDE the Customise dialog, as `{value: columnKey, label}`.
   *
   * Omit it (every existing consumer) and the dialog shows no Sort section, exactly as before:
   * a grid that sorts from its headers does not need a second way to say the same thing.
   *
   * Pass it when the operator is used to setting sort there. A page that HAD this section and
   * then adopted `customizable` lost it silently, with no way to ask for it back — that is the
   * gap this closes. The chosen field is applied through the same path as a header click, so
   * controlled `sort` / `onSortChange` consumers stay in charge of their own state.
   */
  prefsSortFields?: ReadonlyArray<{ value: string; label: string }>
}

/**
 * The universal data grid (`.nds-grid`; the richer `.nds-wsgrid` is the ads console's): sortable headers, row selection
 * with select-all, sticky header, pinned left columns, an optional sticky totals
 * row, and an empty state. Generic over the row type.
 */
export function DataGrid<T>({
  columns,
  rows,
  rowKey,
  selectable,
  selected,
  onSelectedChange,
  rowSelectable,
  rowSelectableHint,
  selectAllHint,
  selectRowHint,
  showTotals,
  emptyState, renderExpanded, expanded, rowProps, size = 'md', headerProps, cellProps, getSubRows, subRowSelectable,
  initialSort,
  sort: controlledSort,
  onSortChange,
  rowClassName,
  maxHeight,
  className,
  customizable,
  storageKey,
  customizeOpen,
  onCustomizeOpenChange,
  customizeTitle,
  prefsSortFields,
}: DataGridProps<T>) {
  const [ownSort, setOwnSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(
    initialSort ?? null,
  )
  // `undefined` = uncontrolled (every consumer before S1.e). `null` = controlled
  // and deliberately unsorted, which is not the same thing.
  const controlled = controlledSort !== undefined
  const sort = controlled ? controlledSort : ownSort

  // ── Column preferences (inert unless `customizable`) ─────────────────────
  const [ownPrefsOpen, setOwnPrefsOpen] = useState(false)
  const prefsControlled = customizeOpen !== undefined
  const prefsOpen = customizeOpen ?? ownPrefsOpen
  const setPrefsOpen = (next: boolean) => {
    onCustomizeOpenChange?.(next)
    if (!prefsControlled) setOwnPrefsOpen(next)
  }

  // Pinned columns lead and trail; everything else is ordered by the operator.
  //
  // 🔴 `sticky`/`stickyRight` PIN a column to an edge — a layout decision the operator cannot
  // override from the dialog. `prefsLocked` is different now: it only SEEDS the column's lock,
  // and the operator can unlock it and then reorder or remove it like any other. It used to
  // hold the column out of the movable pool entirely, which is why Product and Actions could
  // never be moved on /products/next.
  const { lockedLead, lockedTrail, togglableKeys, defaultLockedKeys, prefsColumns, anyPinned } = useMemo(() => {
    const isPinned = (c: Column<T>) => !!c.sticky || !!c.stickyRight
    const togglable = columns.filter((c) => !isPinned(c))
    const lead = columns.filter((c) => c.sticky)
    const trail = columns.filter((c) => c.stickyRight && !c.sticky)
    return {
      lockedLead: lead,
      lockedTrail: trail,
      // The roster of columns the operator can show, hide, reorder or lock. Independent of the
      // current lock set on purpose: it is what `knownColumns` records, and a roster that
      // shrank every time a column was locked would make the loader read locked columns as new.
      togglableKeys: togglable.map((c) => c.key),
      defaultLockedKeys: togglable.filter((c) => c.prefsLocked).map((c) => c.key),
      // Whether anything actually PINS — which is what the dialog's sticky toggles govern.
      anyPinned: columns.some((c) => c.sticky || c.stickyRight),
      prefsColumns: [...lead, ...togglable, ...trail].map((c) => ({
        key: c.key,
        // An empty string is a string, and an actions column legitimately has
        // `label: ''` — a blank draggable row the operator cannot identify (or
        // restore once hidden) is worse than a key.
        label: typeof c.label === 'string' && c.label.trim() ? c.label : c.prefsLabel ?? c.key,
        // `locked` is now the IMMUTABLE kind: pinned to an edge, no lock control offered.
        locked: isPinned(c),
        // …and this one is merely where the operator's lock starts out.
        defaultLocked: !!c.prefsLocked,
        group: c.group,
      })),
    }
  }, [columns])

  const [prefs, setPrefs] = useState<PreferencesValue>(() => ({
    visibleColumns: togglableKeys,
    lockedColumns: defaultLockedKeys,
    stickyFirstColumn: true,
    stickyLastColumn: true,
    // This grid paginates nothing and sorts from its own headers, so these
    // three are carried untouched and their dialog sections stay hidden — a
    // Page-size control that changed nothing would be a lie.
    pageSize: 100,
    sortBy: '',
    sortDir: 'desc',
  }))

  // Once per storageKey, never in the state initializer: the server renders the
  // defaults, so seeding from localStorage during the first render is a
  // hydration mismatch. The ref (not a dep list) is what makes it once — a call
  // site that builds `columns` inline hands us a new array every render, and a
  // dep-driven reload would overwrite the operator's in-session order forever.
  const loadedFor = useRef<string | null>(null)
  // 🔴 A ref cannot gate the writer. `loadedFor` is set synchronously inside the load effect, so
  // the write effect below — same commit, declared after — already passed its guard while
  // `prefs` was still the un-reconciled initial state, and persisted the FULL default roster.
  // Measured on /products/next: two writes of all eight columns landed 24ms before the
  // reconciled five, and a reload inside that window restored every hidden column permanently.
  // A state flag defers the writer to the next render, by which time `prefs` is the real one.
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  useEffect(() => {
    if (!customizable || !storageKey || loadedFor.current === storageKey) return
    loadedFor.current = storageKey
    let saved: Partial<PreferencesValue> | null = null
    try {
      const raw = window.localStorage.getItem(storageKey)
      saved = raw ? (JSON.parse(raw) as Partial<PreferencesValue>) : null
    } catch {
      saved = null
    }
    if (saved) {
      const known = new Set(togglableKeys)
      const kept = (Array.isArray(saved.visibleColumns) ? saved.visibleColumns : []).filter((k) => known.has(k))
      // A column shipped after this operator last opened the dialog must appear — dropping it
      // would hide every new column, permanently, from everyone who ever opened this grid.
      //
      // 🔴 But "new" cannot be inferred from `visibleColumns` alone, and inferring it was a bug:
      // that list records what is VISIBLE, so a column the operator deliberately HID and a
      // column that did not exist yet are both simply absent from it. Every hidden column was
      // therefore treated as new and re-appended on load — the operator hid it, saved,
      // refreshed, and found it back at the END of the row, which is the tell.
      //
      // `knownColumns` is the roster the grid held when these prefs were written, so the two
      // cases are distinguishable: in the roster but not visible ⇒ hidden on purpose; not in the
      // roster at all ⇒ genuinely new. Absent entirely (prefs written before that field) ⇒ fall
      // back to append-everything, which is wrong in the same way but no worse than before.
      const savedKnown = Array.isArray((saved as { knownColumns?: string[] }).knownColumns)
        ? new Set((saved as { knownColumns?: string[] }).knownColumns)
        : null
      const seen = new Set(kept)
      const appended = togglableKeys.filter((k) => !seen.has(k) && (savedKnown ? !savedKnown.has(k) : true))
      // Placed at its CANONICAL index, not at the end. Appending was survivable while every new
      // column was a metric column; it stopped being survivable when `prefsLocked` columns
      // joined this roster, because appending would have moved Product to the far right of every
      // grid whose prefs predate the change.
      const merged = [...kept]
      for (const k of appended) {
        const canon = togglableKeys.indexOf(k)
        let at = merged.length
        for (let i = 0; i < merged.length; i++) {
          if (togglableKeys.indexOf(merged[i]) > canon) { at = i; break }
        }
        merged.splice(at, 0, k)
      }
      const savedLocks = (saved as { lockedColumns?: string[] }).lockedColumns
      setPrefs((prev) => ({
        ...prev,
        visibleColumns: merged,
        // Absent ⇒ prefs written before the lock existed ⇒ the grid's own defaults.
        lockedColumns: Array.isArray(savedLocks) ? savedLocks.filter((k) => known.has(k)) : defaultLockedKeys,
        stickyFirstColumn: saved!.stickyFirstColumn !== false,
        stickyLastColumn: saved!.stickyLastColumn !== false,
      }))
    }
    setPrefsLoaded(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customizable, storageKey, togglableKeys])

  useEffect(() => {
    if (!customizable || !storageKey || !prefsLoaded) return
    try {
      // `knownColumns` travels with the prefs so the loader can tell a hidden column from one
      // that did not exist when these were written. Without it, hiding a column cannot survive
      // a reload — see the reconciliation above.
      window.localStorage.setItem(storageKey, JSON.stringify({ ...prefs, knownColumns: togglableKeys }))
    } catch {
      /* private mode / quota — the grid still works, the order just won't survive */
    }
  }, [prefs, customizable, storageKey, togglableKeys, prefsLoaded])

  // The operator's order IS the render order; a drag that did not move a column
  // would lie. Untouched when `customizable` is absent.
  const cols = useMemo(() => {
    if (!customizable) return columns
    const byKey = new Map(columns.map((c) => [c.key, c] as const))
    const mid: Array<Column<T>> = []
    for (const k of prefs.visibleColumns) {
      const c = byKey.get(k)
      if (c && !c.sticky && !c.stickyRight) mid.push(c)
    }
    return [...lockedLead, ...mid, ...lockedTrail]
  }, [customizable, columns, prefs.visibleColumns, lockedLead, lockedTrail])

  // The operator's toggle GATES the developer's flag — it never overrides which
  // columns pin, only whether pinning applies at all.
  const pinLeft = !customizable || prefs.stickyFirstColumn
  const pinRight = !customizable || prefs.stickyLastColumn
  const isSticky = (c: Column<T>) => !!c.sticky && pinLeft
  const isStickyRight = (c: Column<T>) => !!c.stickyRight && pinRight

  const sortedRows = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col?.sortValue) return rows
    const sv = col.sortValue
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = sv(a)
      const bv = sv(b)
      return av < bv ? -dir : av > bv ? dir : 0
    })
  }, [rows, sort, columns])

  const toggleSort = (key: string) => {
    const next: { key: string; dir: 'asc' | 'desc' } =
      sort?.key === key
        ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'desc' }
    if (onSortChange) onSortChange(next)
    if (!controlled) setOwnSort(next)
  }

  // Select-all covers the rows the operator can actually SEE ticked. With `subRowSelectable` the
  // expanded children are among them, so leaving them out would render a select-all that ticks
  // the header box while visible checkboxes below it stay empty. Gated, so the default is the
  // parents-only list every existing consumer has.
  const allKeys = useMemo(() => {
    const base = rowSelectable ? rows.filter(rowSelectable) : rows
    const keys = base.map(rowKey)
    if (!subRowSelectable || !getSubRows || !expanded) return keys
    for (const r of rows) {
      if (!expanded.has(rowKey(r))) continue
      for (const kid of getSubRows(r) ?? []) {
        if (rowSelectable && !rowSelectable(kid)) continue
        keys.push(rowKey(kid))
      }
    }
    return keys
  }, [rows, rowKey, rowSelectable, subRowSelectable, getSubRows, expanded])
  const selCount = selected?.size ?? 0
  const allSelected = !!selectable && selCount > 0 && allKeys.length > 0 && allKeys.every((k) => selected!.has(k))
  const someSelected = !!selectable && selCount > 0 && !allSelected

  const toggleAll = () => onSelectedChange?.(allSelected ? new Set() : new Set(allKeys))
  const toggleRow = (k: string) => {
    if (!selected) return onSelectedChange?.(new Set([k]))
    const next = new Set(selected)
    next.has(k) ? next.delete(k) : next.add(k)
    onSelectedChange?.(next)
  }

  // accumulate sticky-left offsets (checkbox is 40px wide and pinned at 0)
  const CK = 40
  let acc = selectable ? CK : 0
  const leftOf: Record<string, number> = {}
  for (const c of cols) {
    if (isSticky(c)) {
      leftOf[c.key] = acc
      acc += c.width ?? 0
    }
  }
  // accumulate sticky-right offsets (right-pinned columns stack from the edge in)
  let accR = 0
  const rightOf: Record<string, number> = {}
  for (let i = cols.length - 1; i >= 0; i--) {
    const c = cols[i]
    if (isStickyRight(c)) {
      rightOf[c.key] = accR
      accR += c.width ?? 0
    }
  }
  const stickyStyle = (c: Column<T>): CSSProperties | undefined =>
    isSticky(c) ? { left: leftOf[c.key], width: c.width }
    : isStickyRight(c) ? { right: rightOf[c.key], width: c.width }
    : c.width != null ? { width: c.width }
    : undefined
  const stickyCls = (c: Column<T>) => (isSticky(c) ? 'sticky' : isStickyRight(c) ? 'sticky-right' : '')

  const alignClass = (a?: 'left' | 'right' | 'center') => (a === 'right' ? 'r' : a === 'center' ? 'c' : '')
  const sortIcon = (key: string) =>
    sort?.key === key ? sort.dir === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} /> : <ChevronsUpDown size={13} />

  const grid = (
    <div className={`nds-grid-wrap${className ? ` ${className}` : ''}`} style={maxHeight != null ? { maxHeight } : undefined}>
      <table className={['nds-grid', size === 'md' ? '' : size].filter(Boolean).join(' ')}>
        <thead>
          <tr>
            {selectable && (
              <th className="ck sticky" style={{ left: 0 }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected
                  }}
                  onChange={toggleAll}
                  title={selectAllHint}
                  aria-label="Select all rows"
                />
              </th>
            )}
            {cols.map((c, ci) => {
              const sorted = sort?.key === c.key
              const cls = [alignClass(c.align), stickyCls(c), sorted ? 'sorted' : ''].filter(Boolean).join(' ')
              return (
                <th
                  key={c.key}
                  className={cls}
                  style={stickyStyle(c)}
                  // A sortable header must announce its state; without this a
                  // screen reader hears a button and never learns the table is
                  // ordered by it. Only emitted for sortable columns, so plain
                  // headers are unaffected.
                  aria-sort={
                    c.sortable
                      ? sorted
                        ? sort!.dir === 'asc' ? 'ascending' : 'descending'
                        : 'none'
                      : undefined
                  }
                      {...(headerProps?.(c, ci) ?? {})}
                >
                  {c.sortable ? (
                    <button type="button" className="sortbtn" onClick={() => toggleSort(c.key)}>
                      {c.label}
                      {sortIcon(c.key)}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 ? (
            <tr>
              <td className="nds-grid-empty" colSpan={cols.length + (selectable ? 1 : 0)}>
                {emptyState ?? 'No rows.'}
              </td>
            </tr>
          ) : (
            sortedRows.map((row) => {
              const k = rowKey(row)
              const isSel = !!selected?.has(k)
              const main = (
                <tr key={k} {...(rowProps?.(row) ?? {})} className={[isSel ? 'sel' : '', rowClassName?.(row) ?? ''].filter(Boolean).join(' ') || undefined}>
                  {selectable && (
                    <td className="ck sticky" style={{ left: 0 }}>
                      {rowSelectable && !rowSelectable(row) ? (
                        <input type="checkbox" checked={false} disabled title={rowSelectableHint} aria-label={rowSelectableHint ?? 'Selection unavailable'} />
                      ) : (
                        <input type="checkbox" checked={isSel} onChange={() => toggleRow(k)} title={selectRowHint} aria-label="Select row" />
                      )}
                    </td>
                  )}
                  {cols.map((c, ci) => (
                    <td key={c.key} {...(cellProps?.(row, c, ci) ?? {})} className={[alignClass(c.numeric ? 'right' : c.align), c.numeric ? 'num' : '', c.className ?? '', stickyCls(c)].filter(Boolean).join(' ')} style={stickyStyle(c)}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              )
              const isOpen = !!expanded?.has(k)
              const sub = renderExpanded && isOpen ? renderExpanded(row) : null
              const kids = getSubRows && isOpen ? (getSubRows(row) ?? []) : []
              if (sub == null && kids.length === 0) return main
              return (
                <Fragment key={k}>
                  {main}
                  {/* Children as REAL rows: same `cols`, so a child's figure sits under the same
                      header as its parent's. That is the whole reason to expand. */}
                  {kids.map((kid) => {
                    const kk = rowKey(kid)
                    return (
                      <tr key={kk} {...(rowProps?.(kid) ?? {})} className={['nds-grid-kid', rowClassName?.(kid) ?? ''].filter(Boolean).join(' ') || undefined}>
                        {selectable && (
                          <td className="ck sticky" style={{ left: 0 }}>
                            {subRowSelectable && (!rowSelectable || rowSelectable(kid)) && (
                              <input
                                type="checkbox"
                                checked={selected?.has(kk) ?? false}
                                onChange={() => toggleRow(kk)}
                                title={selectRowHint}
                                aria-label="Select row"
                              />
                            )}
                          </td>
                        )}
                        {cols.map((c, ci) => (
                          <td key={c.key} {...(cellProps?.(kid, c, ci) ?? {})} className={[alignClass(c.numeric ? 'right' : c.align), c.numeric ? 'num' : '', c.className ?? '', stickyCls(c)].filter(Boolean).join(' ')} style={stickyStyle(c)}>
                            {c.render(kid)}
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                  {sub != null && (
                    <tr className="nds-grid-sub">
                      <td colSpan={cols.length + (selectable ? 1 : 0)}>{sub}</td>
                    </tr>
                  )}
                </Fragment>
              )
            })
          )}
        </tbody>
        {showTotals && sortedRows.length > 0 && (
          <tfoot>
            <tr className="totals">
              {selectable && <td className="ck sticky" style={{ left: 0 }} />}
              {cols.map((c) => (
                <td key={c.key} className={[alignClass(c.align), stickyCls(c)].filter(Boolean).join(' ')} style={stickyStyle(c)}>
                  {c.total}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )

  // Not customizable ⇒ the exact element every existing consumer already
  // renders. No wrapper, no extra node, nothing to re-verify.
  if (!customizable) return grid

  return (
    <>
      {!prefsControlled && (
        <div className="nds-grid-prefsbar">
          <ToolbarButton
            icon={<SlidersHorizontal size={14} />}
            label={customizeTitle ?? 'Customise'}
            description="Choose which columns show, and drag to reorder them."
            onClick={() => setPrefsOpen(true)}
            active={prefsOpen}
            // The bar is `justify-content: flex-end`, so this button is ALWAYS at the right edge
            // and a centred bubble always overflows — measured at 21px past the viewport on the
            // DataGrid card before this.
            tooltipAlign="end"
          />
        </div>
      )}
      {grid}
      <PreferencesModal
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        // Seeded from the LIVE sort, so opening the dialog after sorting from a header shows what
        // is actually in force rather than whatever it was last saved with.
        value={{ ...prefs, sortBy: sort?.key ?? prefs.sortBy, sortDir: sort?.dir ?? prefs.sortDir }}
        onConfirm={(next) => {
          setPrefs(next)
          // Only when the caller asked for the section — otherwise `next.sortBy` is the inert
          // value carried through untouched, and applying it would sort by an empty key.
          if (prefsSortFields?.length && next.sortBy && (next.sortBy !== sort?.key || next.sortDir !== sort?.dir)) {
            const applied = { key: next.sortBy, dir: next.sortDir }
            onSortChange?.(applied)
            if (!controlled) setOwnSort(applied)
          }
          setPrefsOpen(false)
        }}
        allColumns={prefsColumns}
        defaultVisible={togglableKeys}
        // Page-size stays hidden — this grid paginates nothing, and a control that changed
        // nothing would be a lie. Sort is the CALLER's call now: omitted, the section is hidden
        // and the grid sorts from its headers as before; supplied, the dialog drives the very
        // same sort those headers do.
        sortFieldOptions={prefsSortFields ?? []}
        pageSizeChoices={[]}
        // No pinned columns ⇒ two toggles that move nothing.
        showSticky={anyPinned}
        title={customizeTitle}
      />
    </>
  )
}
