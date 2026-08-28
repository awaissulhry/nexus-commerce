'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { GripVertical, Lock, Plus, Unlock, X } from 'lucide-react'
// The component FILE, not the `../components` barrel: that barrel exports
// `DataGrid`, which now imports this module, and a barrel import here would
// close that loop into a real circular dependency.
import { Modal } from '../components/Modal'
import { Tabs } from '../components/Tabs'
import { Button, Checkbox } from '../primitives'

/**
 * PreferencesModal — the two-panel grid "Customise" dialog (ported to the DS
 * from the live /products workspace). Left panel: optional page-size · sticky
 * first/last column · optional sort · a `workspaceSlot` escape hatch. Right
 * panel: the column list. Edits are held in a local draft and committed
 * atomically on Save; Cancel discards; Reset reverts to defaults.
 *
 * CHOOSING and ORDERING are split across the two panels: a grouped tick-list on
 * the left picks which columns are in the view; the right panel holds only the
 * chosen ones, in order, each with a drag handle, a padlock and a ✕. This
 * replaced a single list of switches — there is no second shape.
 *
 * Pure DS — no app i18n / utils. Optional sections collapse when their option
 * list is empty (pass `pageSizeChoices={[]}` / `sortFieldOptions={[]}`).
 */

export interface PreferencesColumnSpec {
  key: string
  label: string
  /**
   * IMMUTABLE lock: the column is pinned to an edge of the grid and the dialog offers no lock
   * control for it. Distinct from `defaultLocked`, which the operator can undo.
   */
  locked?: boolean
  /**
   * Where this column's OPERATOR lock starts out. A column can be unlocked from the dialog and
   * then reordered or removed like any other — that is the whole point of the lock control.
   */
  defaultLocked?: boolean
  /**
   * Heading this column sits under in the dialog.
   *
   * Columns without one collect under `listLabel`, so a grid that declares no
   * groups renders exactly ONE section and looks identical to a grouped-unaware
   * build. That is the whole migration story: grouping is opt-in per caller and
   * costs the other callers nothing.
   */
  group?: string
}

export interface PreferencesValue {
  visibleColumns: string[]
  /**
   * Columns the OPERATOR has locked: not removable, not draggable, until they unlock it.
   *
   * Optional so every caller that predates the lock keeps compiling and keeps its behaviour —
   * absent falls back to each column's `defaultLocked`.
   */
  lockedColumns?: string[]
  stickyFirstColumn: boolean
  stickyLastColumn: boolean
  pageSize: number
  sortBy: string
  sortDir: 'asc' | 'desc'
  /**
   * Row grouping, outermost first, by column key. Present only for a grid that offers
   * `groupByOptions`; the grid engine turns it into its own group state.
   */
  rowGroups?: string[]
  /** The aggregate shown on a group row per column key, for a grid that offers `aggregationOptions`. */
  aggregations?: Record<string, PreferencesAggFunc>
}

export type PreferencesAggFunc = 'sum' | 'avg' | 'min' | 'max' | 'count'
const AGG_LABELS: Record<PreferencesAggFunc, string> = { sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum', count: 'Count' }

export interface PreferencesModalProps {
  open: boolean
  onClose: () => void
  value: PreferencesValue
  onConfirm: (next: PreferencesValue) => void
  /** Full column registry (visible + hidden + locked), in canonical order. */
  allColumns: readonly PreferencesColumnSpec[]
  /** The "Reset" target visible-columns list. */
  defaultVisible: readonly string[]
  /** Sort field options. Empty ⇒ the Sort section is hidden. */
  sortFieldOptions?: ReadonlyArray<{ value: string; label: string }>
  /** Page-size choices. Empty ⇒ the Page-size section is hidden. */
  pageSizeChoices?: number[]
  /** Show the sticky first/last column toggles (default true). */
  showSticky?: boolean
  /** Columns rows can be grouped by. Empty/absent ⇒ the Group section is hidden. */
  groupByOptions?: ReadonlyArray<{ key: string; label: string }>
  /** Columns a group row can aggregate, with the functions each allows. Empty/absent ⇒ hidden. */
  aggregationOptions?: ReadonlyArray<{ key: string; label: string; funcs: readonly PreferencesAggFunc[] }>
  /** Modal title (default "Customise"). */
  title?: string
  /**
   * What the list is called. Default "Columns" — every grid keeps its wording unchanged.
   *
   * GX.7 opened this dialog for a page's SECTIONS, where a legend reading "Columns" describes
   * something the reader is not looking at. Forking the dialog to fix a noun would give the
   * platform two Customize dialogs, which is the thing it decided not to have.
   *
   * Doubles as the fallback heading for any column that declares no `group`.
   */
  listLabel?: string
  /** The hint under the tick-list legend. */
  listHint?: string
  /** Extra left-panel content (workspace-specific preferences). */
  workspaceSlot?: ReactNode
}

const DEFAULT_PAGE_SIZE_CHOICES = [20, 50, 100, 250]

const SHARED_DEFAULTS: Omit<PreferencesValue, 'visibleColumns' | 'lockedColumns'> = {
  stickyFirstColumn: true,
  stickyLastColumn: true,
  pageSize: 100,
  sortBy: 'updated',
  sortDir: 'desc',
}

/** Everything the panes need; the modal and the popover both supply it. */
export interface PreferencesPanesOptions {
  value: PreferencesValue
  onChange: (next: PreferencesValue) => void
  allColumns: readonly PreferencesColumnSpec[]
  defaultVisible: readonly string[]
  sortFieldOptions?: ReadonlyArray<{ value: string; label: string }>
  pageSizeChoices?: number[]
  showSticky?: boolean
  groupByOptions?: ReadonlyArray<{ key: string; label: string }>
  aggregationOptions?: ReadonlyArray<{ key: string; label: string; funcs: readonly PreferencesAggFunc[] }>
  listLabel?: string
  listHint?: ReactNode
  workspaceSlot?: ReactNode
}

/**
 * The dialog's panes as a hook: the tick-list, the in-view list, the grouping zones and the
 * display sections, each a piece of JSX that edits `value` through `onChange`. The modal feeds
 * it a draft and commits on Save; the popover feeds it the grid's live state and every change
 * applies at once. ONE implementation of every control, whichever surface shows it.
 */
export function usePreferencesPanes({
  value,
  onChange,
  allColumns,
  defaultVisible,
  sortFieldOptions = [],
  pageSizeChoices = DEFAULT_PAGE_SIZE_CHOICES,
  showSticky = true,
  groupByOptions = [],
  aggregationOptions = [],
  listLabel = 'Columns',
  listHint,
  workspaceSlot,
}: PreferencesPanesOptions) {
  // 🔴 The padlock is offered ONLY to a caller that round-trips `lockedColumns`. Three callers
  // map this dialog's value onto their own persisted shape — WorkspaceGrid's `GridPrefs`,
  // CampaignsGrid's `{order,visible}`, SectionControls' `{order,widths}` — and none of them
  // carry the lock. Rendering a padlock there would give the operator a control that works
  // until they reload and then silently forgets, which is worse than not offering it. Grids
  // reached through `DataGrid customizable` persist it, so they get it.
  const locksPersist = value.lockedColumns !== undefined

  // Where the operator's locks start if these prefs predate the control.
  const defaultLocked = useMemo(
    () => allColumns.filter((c) => c.defaultLocked).map((c) => c.key),
    [allColumns],
  )

  // `draft` is whatever the caller holds — a modal's uncommitted copy or a live grid's state —
  // and `setDraft` hands the next value back the same way React's own setter would.
  const draft = value
  const setDraft = (next: PreferencesValue | ((d: PreferencesValue) => PreferencesValue)) =>
    onChange(typeof next === 'function' ? next(value) : next)

  // Render order: locked-leading → visible (draft order) → hidden → locked-trailing.
  const orderedForDisplay = useMemo<PreferencesColumnSpec[]>(() => {
    const firstUnlockedIdx = allColumns.findIndex((c) => !c.locked)
    let lastUnlockedIdx = -1
    for (let i = allColumns.length - 1; i >= 0; i--) {
      if (!allColumns[i].locked) { lastUnlockedIdx = i; break }
    }
    const lockedLeading = allColumns.filter((c, i) => c.locked && (firstUnlockedIdx === -1 || i < firstUnlockedIdx))
    const lockedTrailing = allColumns.filter((c, i) => c.locked && lastUnlockedIdx !== -1 && i > lastUnlockedIdx)
    const unlockedVisible = draft.visibleColumns
      .map((k) => allColumns.find((c) => c.key === k && !c.locked))
      .filter((c): c is PreferencesColumnSpec => !!c)
    const unlockedHidden = allColumns.filter((c) => !c.locked && !draft.visibleColumns.includes(c.key))
    return [...lockedLeading, ...unlockedVisible, ...unlockedHidden, ...lockedTrailing]
  }, [allColumns, draft.visibleColumns])

  // The heading a column sits under — the LEFT tick-list only. The right-hand list is flat:
  // grouping answers "what columns are there", ordering answers "in what order", and putting
  // headings on both made the second list look grouped when the order it shows is one flat
  // sequence.
  const headingOf = (c: PreferencesColumnSpec) => c.group?.trim() || listLabel

  // Two kinds of locked, and they are not the same question. `c.locked` is the grid's own
  // immutable pin and offers no control; the operator's set is theirs to change.
  const operatorLocks = draft.lockedColumns ?? defaultLocked
  const isLocked = (c: PreferencesColumnSpec) => !!c.locked || operatorLocks.includes(c.key)
  const toggleLock = (key: string) =>
    setDraft((d) => {
      const cur = d.lockedColumns ?? defaultLocked
      return {
        ...d,
        lockedColumns: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key],
      }
    })

  // The LEFT tick-list is the registry: what columns this grid has. It follows `allColumns`
  // canonical order and never reshuffles, because a row that jumps the moment you untick it
  // makes the operator lose their place — measured on /products/next, unticking Channels moved
  // it below Status. Order is the RIGHT panel's job; existence is this one's.
  const pickSections = useMemo(() => {
    const byHeading = new Map<string, PreferencesColumnSpec[]>()
    for (const c of allColumns) {
      const heading = headingOf(c)
      const bucket = byHeading.get(heading)
      if (bucket) bucket.push(c)
      else byHeading.set(heading, [c])
    }
    return [...byHeading.entries()].map(([heading, columns]) => ({ heading, columns }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allColumns, listLabel])

  // The right panel holds ONLY what is in the view, as one flat ordered list.
  const shownColumns = useMemo(
    () => orderedForDisplay.filter((c) => !!c.locked || draft.visibleColumns.includes(c.key)),
    [orderedForDisplay, draft.visibleColumns],
  )

  // With one section the legend above the tick-list already names it; repeating it inside the
  // box would be a heading over the only thing there is.
  const showHeadings = pickSections.length > 1

  // ── Drag-reorder (within the unlocked visible columns) ──
  // No group constraint: the right-hand list is flat, so a drop anywhere in it is exactly what
  // it looks like. An earlier revision restricted drops to one group and had to refuse them
  // visibly; with the headings gone from this list, so is the reason for the refusal.
  const [dragKey, setDragKey] = useState<string | null>(null)
  const onDrop = (targetKey: string) => (e: React.DragEvent) => {
    e.preventDefault()
    if (!dragKey || dragKey === targetKey) { setDragKey(null); return }
    const next = [...draft.visibleColumns]
    const from = next.indexOf(dragKey)
    const to = next.indexOf(targetKey)
    if (from === -1 || to === -1) { setDragKey(null); return }
    next.splice(from, 1)
    next.splice(to, 0, dragKey)
    setDraft((d) => ({ ...d, visibleColumns: next }))
    setDragKey(null)
  }

  const toggleColumn = (key: string) =>
    setDraft((d) => ({
      ...d,
      visibleColumns: d.visibleColumns.includes(key)
        ? d.visibleColumns.filter((k) => k !== key)
        : [...d.visibleColumns, key],
    }))

  /** The grid's defaults, as a value — the modal drafts it, the popover applies it. */
  const resetValue = (): PreferencesValue => ({
      ...SHARED_DEFAULTS,
      // Clamp the default sort field to one this grid actually offers (the shared
      // default 'updated' isn't valid on every workspace); fall back to the first.
      sortBy: sortFieldOptions.some((o) => o.value === SHARED_DEFAULTS.sortBy)
        ? SHARED_DEFAULTS.sortBy
        : sortFieldOptions[0]?.value ?? SHARED_DEFAULTS.sortBy,
      visibleColumns: [...defaultVisible],
      lockedColumns: [...defaultLocked],
      ...(groupByOptions.length ? { rowGroups: [] } : {}),
      ...(aggregationOptions.length ? { aggregations: {} } : {}),
    })

  // Does the left panel have ANY section to show? `workspaceSlot` counts — a caller can fill it
  // even when all three built-ins are off. The tick-list lives there too, so it is never empty —
  // the `single` one-column fallback below is kept for a caller that renders no list at all.
  const hasLeftPanel = true || groupByOptions.length > 0 || aggregationOptions.length > 0

  // The heading NAMES the rows under it for a screen reader, which a styled <p> above a list
  // does not. Withheld when there is one unnamed section, so nothing is announced twice.
  const groupProps = (heading: string) =>
    showHeadings ? ({ role: 'group', 'aria-label': heading } as const) : {}

  // ── The three panes, built once and placed by the layout below ─────────────────────────
  const displaySections = (
    <>
          {pageSizeChoices.length > 0 && (
            <fieldset className="nds-prefs-set">
              <legend>Rows per page</legend>
              <div className="nds-prefs-radios">
                {pageSizeChoices.map((n) => (
                  <label key={n}>
                    <input
                      type="radio"
                      name="ds-prefs-pagesize"
                      checked={draft.pageSize === n}
                      onChange={() => setDraft((d) => ({ ...d, pageSize: n }))}
                    />
                    <span>{n}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {showSticky && (
            <fieldset className="nds-prefs-set">
              <legend>Sticky columns</legend>
              <p className="nds-prefs-help">Keep the first / last column pinned while scrolling sideways.</p>
              <label className="nds-prefs-check">
                <input
                  type="checkbox"
                  checked={draft.stickyFirstColumn}
                  onChange={(e) => setDraft((d) => ({ ...d, stickyFirstColumn: e.target.checked }))}
                />
                <span>Pin first column</span>
              </label>
              <label className="nds-prefs-check">
                <input
                  type="checkbox"
                  checked={draft.stickyLastColumn}
                  onChange={(e) => setDraft((d) => ({ ...d, stickyLastColumn: e.target.checked }))}
                />
                <span>Pin last column</span>
              </label>
            </fieldset>
          )}

          {workspaceSlot}

          {sortFieldOptions.length > 0 && (
            <fieldset className="nds-prefs-set">
              <legend>Sort order</legend>
              <div className="nds-prefs-sort">
                <select
                  className="nds-select"
                  value={draft.sortBy}
                  onChange={(e) => setDraft((d) => ({ ...d, sortBy: e.target.value }))}
                >
                  {sortFieldOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <select
                  className="nds-select"
                  value={draft.sortDir}
                  onChange={(e) => setDraft((d) => ({ ...d, sortDir: e.target.value as 'asc' | 'desc' }))}
                >
                  <option value="desc">↓ Descending</option>
                  <option value="asc">↑ Ascending</option>
                </select>
              </div>
            </fieldset>
          )}
    </>
  )
  const pickList = (
    <>
          {/* The CHOOSING half: every column the grid has, grouped, each a tick. */}
          {(
            <div className="nds-prefs-set nds-prefs-pickset">
              <legend>{listLabel}</legend>
              <p className="nds-prefs-help">{listHint ?? 'Tick a column to add it to the view.'}</p>
              <div className="nds-prefs-cols nds-prefs-picks">
                {pickSections.map((section) => (
                  <div key={section.heading} className="nds-prefs-group" {...groupProps(section.heading)}>
                    {showHeadings && <p className="nds-prefs-grouphd">{section.heading}</p>}
                    {section.columns.map((c) => {
                      const locked = isLocked(c)
                      return (
                        <div key={c.key} className={`nds-prefs-pick${locked ? ' locked' : ''}`}>
                          {/* Disabled-and-ticked rather than absent: a locked column missing from
                              the list looks like a column the grid does not have, and a disabled
                              tick cannot be unticked, so the column cannot be lost. */}
                          <Checkbox
                            checked={locked || draft.visibleColumns.includes(c.key)}
                            disabled={locked}
                            onChange={() => !locked && toggleColumn(c.key)}
                            label={
                              <span className="nds-prefs-picklbl">
                                <span className="nds-prefs-lbl">{c.label}</span>
                                {locked && <span className="nds-prefs-locked">Locked</span>}
                              </span>
                            }
                          />
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}
    </>
  )
  const inView = (
    <>
          <div className="nds-prefs-set">
            <legend>In view</legend>
            <p className="nds-prefs-help">Drag to reorder · ✕ removes a column from the view.</p>
          </div>
          <div className="nds-prefs-cols">
            {shownColumns.map((c) => {
              const locked = isLocked(c)
              const isVisible = locked || draft.visibleColumns.includes(c.key)
              const draggable = !locked && isVisible
              return (
                <div
                  key={c.key}
                  className={['nds-prefs-row', draggable ? 'draggable' : '', dragKey === c.key ? 'dragging' : '', locked ? 'locked' : ''].filter(Boolean).join(' ')}
                  draggable={draggable}
                  onDragStart={draggable ? (e) => { setDragKey(c.key); e.dataTransfer.effectAllowed = 'move' } : undefined}
                  onDragOver={draggable ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } : undefined}
                  onDrop={draggable ? onDrop(c.key) : undefined}
                >
                  <GripVertical size={14} className="nds-prefs-grip" aria-hidden />
                  <span className="nds-prefs-lbl">{c.label}</span>
                  {/* The grid's own pin: nowhere to move to, so no control to offer. */}
                  {c.locked ? (
                    <span className="nds-prefs-locked">Locked</span>
                  ) : locksPersist ? (
                    <button
                      type="button"
                      className={`nds-prefs-lockbtn${locked ? ' on' : ''}`}
                      onClick={() => toggleLock(c.key)}
                      aria-pressed={locked}
                      aria-label={locked ? `Unlock ${c.label}` : `Lock ${c.label} in place`}
                      title={locked ? 'Locked — click to unlock' : 'Lock in place'}
                    >
                      {locked ? <Lock size={13} aria-hidden /> : <Unlock size={13} aria-hidden />}
                    </button>
                  ) : (
                    locked && <span className="nds-prefs-locked">Locked</span>
                  )}
                  {/* The slot holds its width when the ✕ is withheld, so locking a row does not
                      shuffle every label beside it. */}
                  <span className="nds-prefs-xslot">
                    {!locked && (
                      <button
                        type="button"
                        className="nds-prefs-x"
                        onClick={() => toggleColumn(c.key)}
                        // An icon-only button with no name is announced as "button", which is
                        // useless next to twenty identical ones.
                        aria-label={`Remove ${c.label} from the view`}
                      >
                        <X size={13} aria-hidden />
                      </button>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
    </>
  )

  // ── Grouping tab: two drop zones, AG's Columns-panel idea rendered by the DS ────────────
  const groups = draft.rowGroups ?? []
  const aggs = draft.aggregations ?? {}
  const availableGroups = groupByOptions.filter((o) => !groups.includes(o.key))
  const availableAggs = aggregationOptions.filter((o) => !(o.key in aggs))
  const addGroup = (key: string) => setDraft((d) => ({ ...d, rowGroups: [...(d.rowGroups ?? []).filter((k) => k !== key), key] }))
  const removeGroup = (key: string) => setDraft((d) => ({ ...d, rowGroups: (d.rowGroups ?? []).filter((k) => k !== key) }))
  const moveGroup = (key: string, before: string) =>
    setDraft((d) => {
      const next = (d.rowGroups ?? []).filter((k) => k !== key)
      const at = next.indexOf(before)
      next.splice(at < 0 ? next.length : at, 0, key)
      return { ...d, rowGroups: next }
    })
  const setAgg = (key: string, func: PreferencesAggFunc | null) =>
    setDraft((d) => {
      const next = { ...(d.aggregations ?? {}) }
      if (func) next[key] = func
      else delete next[key]
      return { ...d, aggregations: next }
    })
  // One drag at a time, typed by the zone it may land in; a dataTransfer type routes the drop.
  const [zoneDrag, setZoneDrag] = useState<{ kind: 'group' | 'agg'; key: string } | null>(null)
  const [zoneOver, setZoneOver] = useState<'group' | 'agg' | null>(null)
  const dragProps = (kind: 'group' | 'agg', key: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { setZoneDrag({ kind, key }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(`text/nds-${kind}`, key) },
    onDragEnd: () => { setZoneDrag(null); setZoneOver(null) },
  })
  const zoneProps = (kind: 'group' | 'agg') => ({
    onDragOver: (e: React.DragEvent) => { if (zoneDrag?.kind === kind) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setZoneOver(kind) } },
    onDragLeave: () => setZoneOver((z) => (z === kind ? null : z)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      const key = zoneDrag?.kind === kind ? zoneDrag.key : e.dataTransfer.getData(`text/nds-${kind}`)
      if (!key) return
      if (kind === 'group') addGroup(key)
      else if (!(key in aggs)) setAgg(key, aggregationOptions.find((o) => o.key === key)?.funcs[0] ?? 'sum')
      setZoneDrag(null); setZoneOver(null)
    },
  })
  const chipDropBefore = (before: string) => (e: React.DragEvent) => {
    if (zoneDrag?.kind !== 'group' || zoneDrag.key === before) return
    e.preventDefault(); e.stopPropagation()
    moveGroup(zoneDrag.key, before)
    setZoneDrag(null); setZoneOver(null)
  }
  const groupingTab = (
    <div className="nds-prefs nds-prefs-tabbed">
      <div className="nds-prefs-pane">
        <div className="nds-prefs-set">
          <legend>Row groups</legend>
          <p className="nds-prefs-help">Drag a column here to fold the rows into groups — outermost first. While grouped, families do not expand.</p>
        </div>
        <div className={['nds-prefs-zone', zoneOver === 'group' ? 'over' : '', groups.length ? '' : 'empty'].filter(Boolean).join(' ')} {...zoneProps('group')} role="list" aria-label="Row groups">
          {groups.length === 0 && <p className="nds-prefs-zonehint">No grouping · drop a column here</p>}
          {groups.map((key, i) => {
            const o = groupByOptions.find((x) => x.key === key)
            return (
              <div key={key} role="listitem" className={['nds-prefs-chip', 'draggable', zoneDrag?.key === key ? 'dragging' : ''].filter(Boolean).join(' ')} {...dragProps('group', key)} onDragOver={(e) => { if (zoneDrag?.kind === 'group') { e.preventDefault(); e.stopPropagation() } }} onDrop={chipDropBefore(key)}>
                <GripVertical size={14} className="nds-prefs-grip" aria-hidden />
                <span className="nds-prefs-chiplvl">{i + 1}</span>
                <span className="nds-prefs-lbl">{o?.label ?? key}</span>
                <button type="button" className="nds-prefs-x" onClick={() => removeGroup(key)} aria-label={`Stop grouping by ${o?.label ?? key}`}><X size={13} aria-hidden /></button>
              </div>
            )
          })}
        </div>
        <div className="nds-prefs-set">
          <legend>Columns you can group by</legend>
        </div>
        <div className="nds-prefs-cols nds-prefs-avail" role="list" aria-label="Columns you can group by">
          {availableGroups.length === 0 && <p className="nds-prefs-zonehint">Every groupable column is in use.</p>}
          {availableGroups.map((o) => (
            <div key={o.key} role="listitem" className="nds-prefs-chip draggable" {...dragProps('group', o.key)}>
              <GripVertical size={14} className="nds-prefs-grip" aria-hidden />
              <span className="nds-prefs-lbl">{o.label}</span>
              <button type="button" className="nds-prefs-add" onClick={() => addGroup(o.key)} aria-label={`Group by ${o.label}`}><Plus size={13} aria-hidden /></button>
            </div>
          ))}
        </div>
      </div>
      <div className="nds-prefs-pane">
        <div className="nds-prefs-set">
          <legend>Totals</legend>
          <p className="nds-prefs-help">What a group row shows for a column. Drag a column here and pick its total.</p>
        </div>
        <div className={['nds-prefs-zone', zoneOver === 'agg' ? 'over' : '', Object.keys(aggs).length ? '' : 'empty'].filter(Boolean).join(' ')} {...zoneProps('agg')} role="list" aria-label="Totals">
          {Object.keys(aggs).length === 0 && <p className="nds-prefs-zonehint">No totals · drop a column here</p>}
          {aggregationOptions.filter((o) => o.key in aggs).map((o) => (
            <div key={o.key} role="listitem" className="nds-prefs-chip">
              <span className="nds-prefs-lbl">{o.label}</span>
              <select className="nds-select nds-prefs-chipsel" aria-label={`Total for ${o.label}`} value={aggs[o.key]} onChange={(e) => setAgg(o.key, e.target.value as PreferencesAggFunc)}>
                {o.funcs.map((f) => <option key={f} value={f}>{AGG_LABELS[f]}</option>)}
              </select>
              <button type="button" className="nds-prefs-x" onClick={() => setAgg(o.key, null)} aria-label={`Remove the total for ${o.label}`}><X size={13} aria-hidden /></button>
            </div>
          ))}
        </div>
        <div className="nds-prefs-set">
          <legend>Columns you can total</legend>
        </div>
        <div className="nds-prefs-cols nds-prefs-avail" role="list" aria-label="Columns you can total">
          {availableAggs.length === 0 && <p className="nds-prefs-zonehint">Every column with a total is in use.</p>}
          {availableAggs.map((o) => (
            <div key={o.key} role="listitem" className="nds-prefs-chip draggable" {...dragProps('agg', o.key)}>
              <GripVertical size={14} className="nds-prefs-grip" aria-hidden />
              <span className="nds-prefs-lbl">{o.label}</span>
              <button type="button" className="nds-prefs-add" onClick={() => setAgg(o.key, o.funcs[0])} aria-label={`Add a total for ${o.label}`}><Plus size={13} aria-hidden /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )

  // ── Layout: tabs when a grid offers grouping (five stacked sections clipped the tick-list to
  //    three of twelve rows); the two-panel page otherwise, byte-for-byte what it was. ─────
  const tabbed = groupByOptions.length > 0 || aggregationOptions.length > 0
  const groupingCount = groups.length + Object.keys(aggs).length
  const hasDisplay = pageSizeChoices.length > 0 || showSticky || sortFieldOptions.length > 0 || workspaceSlot != null

  return { pickList, inView, groupingTab, displaySections, resetValue, tabbed, hasDisplay, hasLeftPanel, groupingCount }
}

export function PreferencesModal({
  open,
  onClose,
  value,
  onConfirm,
  allColumns,
  defaultVisible,
  sortFieldOptions = [],
  pageSizeChoices = DEFAULT_PAGE_SIZE_CHOICES,
  showSticky = true,
  groupByOptions = [],
  aggregationOptions = [],
  title = 'Customise',
  listLabel = 'Columns',
  listHint,
  workspaceSlot,
}: PreferencesModalProps) {
  // Draft mirrors `value`; reset on every open so a prior Cancel can't leak.
  const [draft, setDraft] = useState<PreferencesValue>(value)
  const [tab, setTab] = useState<'columns' | 'grouping' | 'display'>('columns')
  useEffect(() => {
    if (open) { setDraft(value); setTab('columns') }
  }, [open, value])
  const { pickList, inView, groupingTab, displaySections, resetValue, tabbed, hasDisplay, hasLeftPanel, groupingCount } = usePreferencesPanes({
    value: draft, onChange: setDraft, allColumns, defaultVisible, sortFieldOptions, pageSizeChoices, showSticky, groupByOptions, aggregationOptions, listLabel, listHint, workspaceSlot,
  })
  const resetAll = () => setDraft(resetValue())
  const handleConfirm = () => { onConfirm(draft); onClose() }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      // The width follows the LAYOUT. `xl` (920px) is sized for two panels side by side; with the
      // left one collapsed it stretched a list of one-word column names to 884px, putting 748px
      // of empty space between each label and its control. `md` (560px) puts the list back at
      // roughly the width it had as a panel.
      size={hasLeftPanel ? 'xl' : 'md'}
      footer={
        <>
          <Button variant="ghost" onClick={resetAll} className="nds-prefs-reset">Reset to default</Button>
          <span className="grow" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleConfirm}>Save</Button>
        </>
      }
    >
      {tabbed ? (
        <>
          <Tabs
            ariaLabel="Customise sections"
            className="nds-prefs-tabs"
            active={tab}
            onChange={(id) => setTab(id as typeof tab)}
            tabs={[
              { id: 'columns', label: 'Columns' },
              { id: 'grouping', label: 'Grouping', count: groupingCount > 0 ? groupingCount : null },
              ...(hasDisplay ? [{ id: 'display', label: 'Display' }] : []),
            ]}
          />
          {tab === 'columns' && (
            <div className="nds-prefs nds-prefs-tabbed">
              <div className="nds-prefs-pane">{pickList}</div>
              <div className="nds-prefs-pane">{inView}</div>
            </div>
          )}
          {tab === 'grouping' && groupingTab}
          {tab === 'display' && (
            <div className="nds-prefs nds-prefs-tabbed single">
              <div className="nds-prefs-pane nds-prefs-col">{displaySections}</div>
            </div>
          )}
        </>
      ) : (
        <div className={`nds-prefs${hasLeftPanel ? '' : ' single'}`}>
          {hasLeftPanel && (
            <div className="nds-prefs-col">
              {displaySections}
              {pickList}
            </div>
          )}
          <div className="nds-prefs-col">{inView}</div>
        </div>
      )}
    </Modal>
  )
}

export const PREFERENCES_DEFAULTS = SHARED_DEFAULTS
