'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { GripVertical, Lock, Unlock, X } from 'lucide-react'
// The component FILE, not the `../components` barrel: that barrel exports
// `DataGrid`, which now imports this module, and a barrel import here would
// close that loop into a real circular dependency.
import { Modal } from '../components/Modal'
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
}

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
  title = 'Customise',
  listLabel = 'Columns',
  listHint,
  workspaceSlot,
}: PreferencesModalProps) {
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

  // Draft mirrors `value`; reset on every open so a prior Cancel can't leak.
  const [draft, setDraft] = useState<PreferencesValue>(value)
  useEffect(() => {
    if (open) setDraft(value)
  }, [open, value])

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

  const resetAll = () =>
    setDraft({
      ...SHARED_DEFAULTS,
      // Clamp the default sort field to one this grid actually offers (the shared
      // default 'updated' isn't valid on every workspace); fall back to the first.
      sortBy: sortFieldOptions.some((o) => o.value === SHARED_DEFAULTS.sortBy)
        ? SHARED_DEFAULTS.sortBy
        : sortFieldOptions[0]?.value ?? SHARED_DEFAULTS.sortBy,
      visibleColumns: [...defaultVisible],
      lockedColumns: [...defaultLocked],
    })
  const handleConfirm = () => { onConfirm(draft); onClose() }

  // Does the left panel have ANY section to show? `workspaceSlot` counts — a caller can fill it
  // even when all three built-ins are off. The tick-list lives there too, so it is never empty —
  // the `single` one-column fallback below is kept for a caller that renders no list at all.
  const hasLeftPanel = true

  // The heading NAMES the rows under it for a screen reader, which a styled <p> above a list
  // does not. Withheld when there is one unnamed section, so nothing is announced twice.
  const groupProps = (heading: string) =>
    showHeadings ? ({ role: 'group', 'aria-label': heading } as const) : {}

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
      {/* Single column when the left panel would be EMPTY. All three of its sections are
          optional — `pageSizeChoices=[]`, `sortFieldOptions=[]`, `showSticky={false}` — and a
          grid that locks its edge columns with `prefsLocked` rather than `sticky` switches off
          all three at once. The two-column grid then reserved half the dialog for nothing:
          measured at 1512px, the columns list sat in the right 375px of an 800px body. */}
      <div className={`nds-prefs${hasLeftPanel ? '' : ' single'}`}>
        {/* ── Left: page-level preferences, then the column tick-list ── */}
        {hasLeftPanel && (
        <div className="nds-prefs-col">
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
        </div>
        )}

        {/* ── Right: the column list ── */}
        <div className="nds-prefs-col">
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
        </div>
      </div>
    </Modal>
  )
}

export const PREFERENCES_DEFAULTS = SHARED_DEFAULTS
