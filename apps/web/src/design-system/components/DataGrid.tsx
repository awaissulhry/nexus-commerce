'use client'

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
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
  sortable?: boolean
  sortValue?: (row: T) => number | string
  /** pin this column to the left (sticky); give a numeric `width` so offsets stack */
  sticky?: boolean
  /** pin this column to the right (sticky); give a numeric `width` so offsets stack */
  stickyRight?: boolean
  width?: number
  /** value rendered in the totals row */
  total?: ReactNode
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
}

/**
 * The universal data grid (H10 `.h10-am-grid`): sortable headers, row selection
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
  emptyState,
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

  // Pinned columns lead and trail; only the middle is draggable. Feeding the
  // dialog `[...lead, ...movable, ...trail]` is what makes its own
  // locked-leading / locked-trailing partition land on the right columns.
  const { lockedLead, lockedTrail, movableKeys, prefsColumns } = useMemo(() => {
    const lead = columns.filter((c) => c.sticky)
    const trail = columns.filter((c) => c.stickyRight)
    const movable = columns.filter((c) => !c.sticky && !c.stickyRight)
    return {
      lockedLead: lead,
      lockedTrail: trail,
      movableKeys: movable.map((c) => c.key),
      prefsColumns: [...lead, ...movable, ...trail].map((c) => ({
        key: c.key,
        // An empty string is a string, and an actions column legitimately has
        // `label: ''` — a blank draggable row the operator cannot identify (or
        // restore once hidden) is worse than a key.
        label: typeof c.label === 'string' && c.label.trim() ? c.label : c.prefsLabel ?? c.key,
        locked: !!c.sticky || !!c.stickyRight,
      })),
    }
  }, [columns])

  const [prefs, setPrefs] = useState<PreferencesValue>(() => ({
    visibleColumns: movableKeys,
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
    if (!saved) return
    const known = new Set(movableKeys)
    const kept = (Array.isArray(saved.visibleColumns) ? saved.visibleColumns : []).filter((k) => known.has(k))
    // A column shipped after this operator last opened the dialog is absent from
    // their saved list. Appending it beats dropping it: dropping would hide
    // every new column, permanently, from everyone who ever opened this grid.
    const seen = new Set(kept)
    setPrefs((prev) => ({
      ...prev,
      visibleColumns: [...kept, ...movableKeys.filter((k) => !seen.has(k))],
      stickyFirstColumn: saved!.stickyFirstColumn !== false,
      stickyLastColumn: saved!.stickyLastColumn !== false,
    }))
  }, [customizable, storageKey, movableKeys])

  useEffect(() => {
    if (!customizable || !storageKey || loadedFor.current !== storageKey) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(prefs))
    } catch {
      /* private mode / quota — the grid still works, the order just won't survive */
    }
  }, [prefs, customizable, storageKey])

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

  const allKeys = (rowSelectable ? rows.filter(rowSelectable) : rows).map(rowKey)
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
      <table className="nds-grid">
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
            {cols.map((c) => {
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
              return (
                <tr key={k} className={[isSel ? 'sel' : '', rowClassName?.(row) ?? ''].filter(Boolean).join(' ') || undefined}>
                  {selectable && (
                    <td className="ck sticky" style={{ left: 0 }}>
                      {rowSelectable && !rowSelectable(row) ? (
                        <input type="checkbox" checked={false} disabled title={rowSelectableHint} aria-label={rowSelectableHint ?? 'Selection unavailable'} />
                      ) : (
                        <input type="checkbox" checked={isSel} onChange={() => toggleRow(k)} title={selectRowHint} aria-label="Select row" />
                      )}
                    </td>
                  )}
                  {cols.map((c) => (
                    <td key={c.key} className={[alignClass(c.align), stickyCls(c)].filter(Boolean).join(' ')} style={stickyStyle(c)}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
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
          />
        </div>
      )}
      {grid}
      <PreferencesModal
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        value={prefs}
        onConfirm={(next) => {
          setPrefs(next)
          setPrefsOpen(false)
        }}
        allColumns={prefsColumns}
        defaultVisible={movableKeys}
        // Hidden rather than disabled: this grid paginates nothing and sorts
        // from its own headers, so both sections would be controls that change
        // nothing. Their values ride through `prefs` untouched.
        sortFieldOptions={[]}
        pageSizeChoices={[]}
        // No pinned columns ⇒ two toggles that move nothing.
        showSticky={lockedLead.length > 0 || lockedTrail.length > 0}
        title={customizeTitle}
      />
    </>
  )
}
