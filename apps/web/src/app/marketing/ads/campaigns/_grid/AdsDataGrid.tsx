'use client'

/**
 * CBN.3.2 — AdsDataGrid: the ONE shared Helium-10 Ad-Manager grid. Prop-driven so every
 * grid in the console (campaign Ad Groups / Search Terms / Negative Targets / Ads — and,
 * after CBN.3.7, the Ad Manager itself) renders through this single component. Change the
 * grid here and every consumer updates.
 *
 * It reproduces the proven `h10-am-*` markup (filters panel · toolbar · sticky checkbox +
 * first column · sortable metric columns with (i) tips · pinned Total row · pager + rows-
 * per-page · "Latest Report" footer) and composes the already-shared controls from
 * ./FilterDropdown (FilterDropdown · H10Select · HoverCard) and ./InfoTip. No restyling of
 * the shared CSS — only a small CBN.3.2 block adds the Total-row + Customize-popover bits.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, ChevronsUpDown, Settings2, Download, Pencil, Search, X } from 'lucide-react'
import { FilterDropdown, H10Select, HoverCard, MultiSelect } from '../FilterDropdown'
import { InfoTip } from '../InfoTip'

/** A grid column. `render` draws the cell; `sortValue`/`filterValue` drive sort + range
 *  filters; `total` is the value shown in the pinned Total row (omit ⇒ blank). */
export interface GridColumn<T> {
  key: string
  label: string
  tip?: string
  /** right-aligned numeric look (default true); false renders a left "settings" cell */
  metric?: boolean
  sortable?: boolean
  render: (row: T) => ReactNode
  sortValue?: (row: T) => number | string
  /** numeric accessor used by range filters keyed on this column */
  filterValue?: (row: T) => number
  total?: ReactNode
  defaultHidden?: boolean
}

export interface GridRangeFilter { key: string; label: string; kind: 'range'; unit?: '€' | '%' | ''; tip?: string; value?: (row: unknown) => number }
export interface GridSelectFilter { key: string; label: string; kind: 'select'; options: Array<{ value: string; label: string }>; placeholder?: string; wide?: boolean; searchable?: boolean; value?: (row: unknown) => string }
export interface GridMultiSelectFilter { key: string; label: string; kind: 'multiselect'; options: Array<{ value: string; label: string }>; placeholder?: string; wide?: boolean; value?: (row: unknown) => string }
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

type RangeVal = { min: string; max: string }
type FilterState = Record<string, RangeVal | string | string[]>

export interface AdsDataGridProps<T> {
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
  /** optional row grouping: returns the group key + label for a row. When set, the grid
   *  clusters same-group rows (groups ordered by label) and renders a header row before
   *  each group. Additive — consumers that omit it are unaffected. */
  groupBy?: (row: T) => { key: string; label: string }
  /** optional row click (e.g. open a detail drawer). Clicks landing on an interactive
   *  child (checkbox / link / button / select) are ignored so they keep their own behavior. */
  onRowClick?: (row: T) => void
}

function useClickAway<T extends HTMLElement>(onAway: () => void) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onAway() }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [onAway])
  return ref
}

const pluralize = (noun: string, n: number) => (n === 1 ? noun : `${noun}s`)

export function AdsDataGrid<T>({
  rows, loading, rowId, noun,
  firstColLabel, renderFirst, firstSortValue,
  columns, filters,
  toolbarLeft, toolbarRight, exportable, onExport, customizable = true, storageKey,
  selectable = true, selected, onSelectedChange,
  showTotal, totalFirst = 'Total',
  reportLabel, emptyLabel = 'No data.', emptyNode, defaultSort, editMode, selectionActions,
  searchable, searchPlaceholder = 'Search…', searchValue, pagerCentered, filtersDefaultOpen = true,
  groupBy, onRowClick,
}: AdsDataGridProps<T>) {
  const [filtersOpen, setFiltersOpen] = useState(filtersDefaultOpen)
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [fstate, setFstate] = useState<FilterState>({})
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(defaultSort ?? null)
  // ── inline edit mode (H10 "Edit Groups") ──
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({})
  const [applying, setApplying] = useState(false)
  const editByKey = useMemo(() => new Map((editMode?.fields ?? []).map((f) => [f.key, f])), [editMode])
  const setDraft = (id: string, key: string, v: string) => setDrafts((d) => ({ ...d, [id]: { ...d[id], [key]: v } }))
  const [page, setPage] = useState(1)
  const [rowsPerPage, setRowsPerPage] = useState(100)
  const [showCustomize, setShowCustomize] = useState(false)

  // column visibility (Customize) — keyed by column.key; first col is always locked on
  const allKeys = useMemo(() => columns.map((c) => c.key), [columns])
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(columns.filter((c) => c.defaultHidden).map((c) => c.key)))
  useEffect(() => {
    if (!storageKey) return
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) { const arr = JSON.parse(raw) as string[]; setHidden(new Set(allKeys.filter((k) => !arr.includes(k)))) }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])
  const persistVisible = (vis: string[]) => { if (storageKey) { try { localStorage.setItem(storageKey, JSON.stringify(vis)) } catch { /* ignore */ } } }
  const visibleCols = useMemo(() => columns.filter((c) => !hidden.has(c.key)), [columns, hidden])

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

  const filtered = useMemo(() => {
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
  }, [rows, filters, fstate, filterAccessor])

  // ── search (H10 inline 🔍) — narrows on the first-column text by default ──
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!searchable || !q) return filtered
    const acc = searchValue ?? firstSortValue
    if (!acc) return filtered
    return filtered.filter((r) => String(acc(r) ?? '').toLowerCase().includes(q))
  }, [filtered, search, searchable, searchValue, firstSortValue])

  // ── sorting ──
  const sorted = useMemo(() => {
    if (!sort && !groupBy) return searched
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
        if (ga.key !== gb.key) return ga.label.localeCompare(gb.label)
      }
      if (!getVal || !sort) return 0
      const va = getVal(a) as number | string, vb = getVal(b) as number | string
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [searched, sort, columns, firstSortValue, groupBy])

  // group row counts (for the group-header labels), computed over the full sorted set
  const groupCounts = useMemo(() => {
    if (!groupBy) return null
    const m = new Map<string, number>()
    for (const r of sorted) { const k = groupBy(r).key; m.set(k, (m.get(k) ?? 0) + 1) }
    return m
  }, [sorted, groupBy])

  const pageCount = Math.max(1, Math.ceil(sorted.length / rowsPerPage))
  const safePage = Math.min(page, pageCount)
  const paged = sorted.slice((safePage - 1) * rowsPerPage, safePage * rowsPerPage)
  const viewStart = sorted.length === 0 ? 0 : (safePage - 1) * rowsPerPage + 1
  const viewEnd = Math.min(safePage * rowsPerPage, sorted.length)

  const onSort = (key: string) => setSort((s) => (s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' }))
  const sortIcon = (key: string) => (sort?.key === key
    ? (sort.dir === 'asc' ? <ChevronUp size={13} className="sa on" /> : <ChevronDown size={13} className="sa on" />)
    : <ChevronsUpDown size={13} className="sa" />)

  const pageIds = paged.map(rowId)
  const allSel = pageIds.length > 0 && pageIds.every((id) => sel.has(id))
  const toggleAll = () => { const n = new Set(sel); if (allSel) pageIds.forEach((id) => n.delete(id)); else pageIds.forEach((id) => n.add(id)); setSel(n) }
  const toggle = (id: string) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n) }

  const setRange = (key: string, side: 'min' | 'max', v: string) =>
    setFstate((s) => ({ ...s, [key]: { min: '', max: '', ...(s[key] as RangeVal | undefined), [side]: v } }))
  const clearFilters = () => { setFstate({}); setPage(1) }
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
      {/* filter bar */}
      {filters?.length ? (
        <div className={`h10-am-fpanel${filtersOpen ? '' : ' is-collapsed'}`}>
          <div className="fphead">
            <h3>Filters</h3>
            <button type="button" className="h10-am-link tog" onClick={() => setFiltersOpen((v) => !v)}>
              <ChevronDown size={14} className={filtersOpen ? 'up' : ''} />{filtersOpen ? 'Hide Filters' : 'Show Filters'}
            </button>
          </div>
          {filtersOpen && (
            <>
              <div className="frow">
                {filters.map((f) => f.kind === 'select' ? (
                  <div className={`ffield ${f.wide ? 'wide' : ''}`} key={f.key}><span>{f.label}</span>
                    <FilterDropdown options={f.options} value={(fstate[f.key] as string) ?? ''} onChange={(v) => { setFstate((s) => ({ ...s, [f.key]: v })); setPage(1) }} emptyLabel={f.placeholder ?? `All`} emptyIsPlaceholder searchable={f.searchable} ariaLabel={f.label} />
                  </div>
                ) : f.kind === 'multiselect' ? (
                  <div className={`ffield ${f.wide ? 'wide' : ''}`} key={f.key}><span>{f.label}</span>
                    <MultiSelect options={f.options} value={(fstate[f.key] as string[]) ?? []} onChange={(v) => { setFstate((s) => ({ ...s, [f.key]: v })); setPage(1) }} placeholder={f.placeholder ?? 'All'} ariaLabel={f.label} />
                  </div>
                ) : (
                  <div className="ffield" key={f.key}>
                    <span>{f.label}{f.tip && <InfoTip tip={f.tip} />}</span>
                    <div className="mm">
                      {(['min', 'max'] as const).map((side) => (
                        <div className={`mmin ${f.unit === '€' ? 'cur' : f.unit === '%' ? 'pct' : ''}`} key={side}>
                          {f.unit === '€' && <span className="ad">€</span>}
                          <input inputMode="decimal" placeholder={side === 'min' ? 'Min' : 'Max'} value={(fstate[f.key] as RangeVal | undefined)?.[side] ?? ''} onChange={(e) => { setRange(f.key, side, e.target.value); setPage(1) }} aria-label={`${f.label} ${side}`} />
                          {f.unit === '%' && <span className="ad">%</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="fft">
                <span className="grow" />
                <button type="button" className="h10-am-btn sm" onClick={clearFilters} disabled={!hasActiveFilters}>Clear</button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* one card: toolbar + grid + pager share the grid rectangle (H10 — toolbar sits inside it) */}
      <div className="h10-am-card">
      {/* toolbar */}
      <div className="h10-am-toolbar">
        <span className="cnt">{selectable && sel.size > 0
          ? <b>{`Selected ${sel.size} ${pluralize(noun, sel.size)}`}</b>
          : sorted.length === 0 ? `Showing 0 ${pluralize(noun, 0)}` : `Viewing ${viewStart}-${viewEnd} of ${sorted.length} ${pluralize(noun, sorted.length)}`}</span>
        {editMode && editMode.bulk !== false ? (editing ? (
          <span className="h10-edit-actions">
            <button type="button" className="h10-discard" onClick={discardEdits}>Discard Changes</button>
            <button type="button" className="h10-am-btn primary" disabled={!dirtyEdits.length || applying} onClick={applyEdits}>{applying ? 'Applying…' : 'Apply Changes'}</button>
          </span>
        ) : (
          <button type="button" className="h10-am-btn primary" onClick={enterEdit}><Pencil size={13} /> {editMode.label}</button>
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
          <div className="h10-custwrap">
            <button type="button" className={`h10-am-btn ${showCustomize ? 'on' : ''}`} onClick={() => setShowCustomize((v) => !v)} aria-haspopup="dialog" aria-expanded={showCustomize}><Settings2 size={13} /> Customize</button>
            {showCustomize && (
              <CustomizePanel
                columns={columns} hidden={hidden} firstLabel={firstColLabel}
                onChange={(vis) => { setHidden(new Set(allKeys.filter((k) => !vis.includes(k)))); persistVisible(vis) }}
                onReset={() => { setHidden(new Set(columns.filter((c) => c.defaultHidden).map((c) => c.key))); persistVisible(allKeys.filter((k) => !columns.find((c) => c.key === k)?.defaultHidden)) }}
                onClose={() => setShowCustomize(false)}
              />
            )}
          </div>
        )}
        {exportable && <button type="button" className="h10-am-btn" onClick={onExport}><Download size={13} /> Export Data…</button>}
      </div>

      {/* grid */}
      <div className="h10-am-grid">
        <table>
          <thead>
            <tr>
              {selectable && <th className="ck"><input type="checkbox" checked={allSel} onChange={toggleAll} aria-label="Select all" /></th>}
              <th className={`nm fz${sort?.key === '__first' ? ' sorted' : ''}`}><button type="button" className="sortable" onClick={() => onSort('__first')}>{firstColLabel} {firstSortValue && sortIcon('__first')}</button></th>
              {visibleCols.map((c) => (
                <th key={c.key} className={`${c.metric === false ? 'ed' : 'num'}${sort?.key === c.key ? ' sorted' : ''}`}>
                  {c.sortable === false
                    ? <span className="hl">{c.tip ? <HoverCard text={c.tip} placement="above" delay={600}><span>{c.label}</span></HoverCard> : c.label}</span>
                    : <button type="button" className="sortable" onClick={() => onSort(c.key)}>
                        {c.tip
                          ? <HoverCard text={c.tip} placement="above" delay={600}><span className="hl">{c.label} {sortIcon(c.key)}</span></HoverCard>
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
                  <td className="nm fz"><span className="skb" style={{ width: 170 }} /></td>
                  {visibleCols.map((c) => <td key={c.key} className={c.metric === false ? 'ed' : 'num'}><span className="skb" style={{ width: 52 }} /></td>)}
                </tr>
              ))
            ) : paged.length === 0 ? (
              <tr><td colSpan={visibleCols.length + (selectable ? 2 : 1)} className="empty">{emptyNode ?? emptyLabel}</td></tr>
            ) : (
              <>
                {showTotal && (
                  <tr className="h10-am-total">
                    {selectable && <td className="ck" />}
                    <td className="nm fz"><b>{totalFirst}</b></td>
                    {visibleCols.map((c) => <td key={c.key} className={c.metric === false ? 'ed' : 'num'}>{c.total ?? ''}</td>)}
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
                        className={`${sel.has(id) ? 'on' : ''}${onRowClick ? ' clickable' : ''}`}
                        onClick={onRowClick ? (e) => { if (!(e.target as HTMLElement).closest('button, a, input, label, select')) onRowClick(row) } : undefined}
                      >
                        {selectable && <td className="ck"><input type="checkbox" checked={sel.has(id)} onChange={() => toggle(id)} aria-label="Select row" /></td>}
                        <td className={`nm fz${ef ? ' editing' : ''}`}>{ef ? ef.render(editVal(row, ef), (v) => setDraft(id, '__first', v), row) : cellWithPencil(row, '__first', renderFirst(row))}</td>
                        {visibleCols.map((c) => {
                          const cf = editing ? editByKey.get(c.key) : undefined
                          return <td key={c.key} className={`${c.metric === false ? 'ed' : 'num'}${cf ? ' editing' : ''}`}>{cf ? cf.render(editVal(row, cf), (v) => setDraft(id, c.key, v), row) : cellWithPencil(row, c.key, c.render(row))}</td>
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
          <H10Select width={84} options={[{ value: '50', label: '50' }, { value: '100', label: '100' }, { value: '200', label: '200' }, { value: '500', label: '500' }]} value={String(rowsPerPage)} onChange={(v) => { setRowsPerPage(Number(v)); setPage(1) }} ariaLabel="Rows per page" />
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
            <button type="button" className="h10-am-btn sm" onClick={() => setInline(null)}>Cancel</button>
            <button type="button" className="h10-am-btn primary sm" disabled={savingInline} onClick={saveInline}>{savingInline ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </>, document.body)}
    </>
  )
}

/** Column show/hide popover — replicates the H10 "Table Customization" dialog (the first
 *  column is locked on). Generic over the grid's own columns; no campaign coupling. */
function CustomizePanel<T>({ columns, hidden, firstLabel, onChange, onReset, onClose }: {
  columns: GridColumn<T>[]; hidden: Set<string>; firstLabel: string
  onChange: (visible: string[]) => void; onReset: () => void; onClose: () => void
}) {
  const ref = useClickAway<HTMLDivElement>(onClose)
  const allKeys = columns.map((c) => c.key)
  const visible = allKeys.filter((k) => !hidden.has(k))
  const vis = new Set(visible)
  const allOn = allKeys.every((k) => vis.has(k))
  const toggle = (k: string) => { const n = new Set(vis); if (n.has(k)) n.delete(k); else n.add(k); onChange([...n]) }
  return (
    <div className="h10-custpop" ref={ref} role="dialog" aria-label="Table Customization">
      <div className="h10-custpop-h">Table Customization<button type="button" className="h10-custpop-reset" onClick={onReset}>Reset to default</button></div>
      <div className="h10-custpop-colsh">
        <span className="ti">Columns</span>
        <label className="h10-custpop-all"><input type="checkbox" ref={(el) => { if (el) el.indeterminate = !allOn && vis.size > 0 }} checked={allOn} onChange={() => onChange(allOn ? [] : [...allKeys])} /> Select All</label>
      </div>
      <div className="h10-custpop-grid" style={{ gridTemplateRows: `repeat(${Math.ceil((columns.length + 1) / 4)}, auto)` }}>
        <label className="h10-custpop-ck locked"><input type="checkbox" checked readOnly disabled /> <span>{firstLabel}</span></label>
        {columns.map((c) => (
          <label className="h10-custpop-ck" key={c.key}>
            <input type="checkbox" checked={vis.has(c.key)} onChange={() => toggle(c.key)} />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
    </div>
  )
}
