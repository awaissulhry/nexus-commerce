'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { GripVertical } from 'lucide-react'
import { Modal } from '../components'
import { Button, Toggle } from '../primitives'

/**
 * PreferencesModal — the two-panel grid "Customise" dialog (ported to the DS
 * from the live /products workspace). Left panel: optional page-size · sticky
 * first/last column · optional sort · a `workspaceSlot` escape hatch. Right
 * panel: every togglable column with a drag handle + visibility toggle (locked
 * columns shown disabled). Edits are held in a local draft and committed
 * atomically on Save; Cancel discards; Reset reverts to defaults.
 *
 * Pure DS — no app i18n / utils. Optional sections collapse when their option
 * list is empty (pass `pageSizeChoices={[]}` / `sortFieldOptions={[]}`).
 */

export interface PreferencesColumnSpec {
  key: string
  label: string
  locked?: boolean
}

export interface PreferencesValue {
  visibleColumns: string[]
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
  /** Extra left-panel content (workspace-specific preferences). */
  workspaceSlot?: ReactNode
}

const DEFAULT_PAGE_SIZE_CHOICES = [20, 50, 100, 250]

const SHARED_DEFAULTS: Omit<PreferencesValue, 'visibleColumns'> = {
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
  workspaceSlot,
}: PreferencesModalProps) {
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

  // ── Drag-reorder (within unlocked visible columns) ──
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
    })
  const handleConfirm = () => { onConfirm(draft); onClose() }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={resetAll} className="h10-ds-prefs-reset">Reset to default</Button>
          <span className="grow" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleConfirm}>Save</Button>
        </>
      }
    >
      <div className="h10-ds-prefs">
        {/* ── Left: page-level preferences ── */}
        <div className="h10-ds-prefs-col">
          {pageSizeChoices.length > 0 && (
            <fieldset className="h10-ds-prefs-set">
              <legend>Rows per page</legend>
              <div className="h10-ds-prefs-radios">
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
            <fieldset className="h10-ds-prefs-set">
              <legend>Sticky columns</legend>
              <p className="h10-ds-prefs-help">Keep the first / last column pinned while scrolling sideways.</p>
              <label className="h10-ds-prefs-check">
                <input
                  type="checkbox"
                  checked={draft.stickyFirstColumn}
                  onChange={(e) => setDraft((d) => ({ ...d, stickyFirstColumn: e.target.checked }))}
                />
                <span>Pin first column</span>
              </label>
              <label className="h10-ds-prefs-check">
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
            <fieldset className="h10-ds-prefs-set">
              <legend>Sort order</legend>
              <div className="h10-ds-prefs-sort">
                <select
                  className="h10-ds-select"
                  value={draft.sortBy}
                  onChange={(e) => setDraft((d) => ({ ...d, sortBy: e.target.value }))}
                >
                  {sortFieldOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <select
                  className="h10-ds-select"
                  value={draft.sortDir}
                  onChange={(e) => setDraft((d) => ({ ...d, sortDir: e.target.value as 'asc' | 'desc' }))}
                >
                  <option value="desc">↓ Descending</option>
                  <option value="asc">↑ Ascending</option>
                </select>
              </div>
            </fieldset>
          )}
        </div>

        {/* ── Right: column visibility + drag-reorder ── */}
        <div className="h10-ds-prefs-col">
          <div className="h10-ds-prefs-set">
            <legend>Columns</legend>
            <p className="h10-ds-prefs-help">Drag to reorder · toggle to show or hide.</p>
          </div>
          <div className="h10-ds-prefs-cols">
            {orderedForDisplay.map((c) => {
              const isLocked = !!c.locked
              const isVisible = isLocked || draft.visibleColumns.includes(c.key)
              const draggable = !isLocked && isVisible
              return (
                <div
                  key={c.key}
                  className={['h10-ds-prefs-row', draggable ? 'draggable' : '', dragKey === c.key ? 'dragging' : '', isLocked ? 'locked' : ''].filter(Boolean).join(' ')}
                  draggable={draggable}
                  onDragStart={draggable ? (e) => { setDragKey(c.key); e.dataTransfer.effectAllowed = 'move' } : undefined}
                  onDragOver={draggable ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } : undefined}
                  onDrop={draggable ? onDrop(c.key) : undefined}
                >
                  <GripVertical size={14} className="h10-ds-prefs-grip" aria-hidden />
                  <span className="h10-ds-prefs-lbl">{c.label}</span>
                  {isLocked && <span className="h10-ds-prefs-locked">Locked</span>}
                  <Toggle
                    checked={isVisible}
                    disabled={isLocked}
                    onChange={() => !isLocked && toggleColumn(c.key)}
                    aria-label={`Toggle ${c.label}`}
                  />
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
