'use client'

/**
 * PG.5 — Consolidated /products preferences modal.
 *
 * Replaces the old ColumnPickerMenu popover with an Amazon-style
 * two-panel modal: left panel collects page-level preferences (page
 * size, sticky columns, product name display, sort order), right
 * panel lists every togglable column with a drag handle + toggle.
 *
 * Edits are held in local draft state and committed atomically on
 * Confirm; Cancel discards. Reset returns every panel field to its
 * default + reverts the visible-columns array to DEFAULT_VISIBLE.
 *
 * The sticky-columns checkboxes here are settings only — the actual
 * `position: sticky` wiring on VirtualizedGrid lands in PG.6 (the
 * preference is persisted now so PG.6 ships behavior, not state).
 */

import { useEffect, useMemo, useState } from 'react'
import { GripVertical, X } from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'
import { ALL_COLUMNS, DEFAULT_VISIBLE, type ColumnDef } from '../_columns'

export type ProductNameDisplay = 'full' | 'shortened'

export interface PreferencesValue {
  pageSize: number
  visibleColumns: string[]
  stickyFirstColumn: boolean
  stickyLastColumn: boolean
  productNameDisplay: ProductNameDisplay
  sortBy: string
  sortDir: 'asc' | 'desc'
}

export interface PreferencesModalProps {
  open: boolean
  onClose: () => void
  value: PreferencesValue
  onConfirm: (next: PreferencesValue) => void
  /** Reusable so future workspaces with different sort fields can
   *  drop in their own list without forking the modal. */
  sortFieldOptions: Array<{ value: string; label: string }>
}

const PAGE_SIZE_CHOICES = [20, 50, 100, 250] as const

const DEFAULTS: Omit<PreferencesValue, 'visibleColumns'> = {
  pageSize: 100,
  stickyFirstColumn: true,
  stickyLastColumn: true,
  productNameDisplay: 'full',
  sortBy: 'updated',
  sortDir: 'desc',
}

export function PreferencesModal({
  open,
  onClose,
  value,
  onConfirm,
  sortFieldOptions,
}: PreferencesModalProps) {
  const { t } = useTranslations()

  // Draft mirrors `value` and is what the modal mutates. Reset on
  // every open so a previous Cancel doesn't leak edits into the next
  // session of the modal.
  const [draft, setDraft] = useState<PreferencesValue>(value)
  useEffect(() => {
    if (open) setDraft(value)
  }, [open, value])

  // Split togglable vs locked columns. Locked columns (`product`,
  // `actions`) render with a disabled toggle so the operator sees
  // they exist but can't hide them.
  const togglable = useMemo(
    () => ALL_COLUMNS.filter((c) => c.label || c.key === 'thumb'),
    [],
  )

  // Render order on the right panel: visible columns in their current
  // order first (drag-reorderable), then hidden columns at the end.
  // Locked columns float to the top to match the table's leading
  // position.
  const orderedForDisplay = useMemo<ColumnDef[]>(() => {
    const lockedLeading = togglable.filter((c) => c.locked && c.key === 'product')
    const lockedTrailing = togglable.filter((c) => c.locked && c.key === 'actions')
    const unlockedVisible = draft.visibleColumns
      .map((k) => togglable.find((c) => c.key === k && !c.locked))
      .filter((c): c is ColumnDef => !!c)
    const unlockedHidden = togglable.filter(
      (c) => !c.locked && !draft.visibleColumns.includes(c.key),
    )
    return [...lockedLeading, ...unlockedVisible, ...unlockedHidden, ...lockedTrailing]
  }, [togglable, draft.visibleColumns])

  // ── Drag-reorder (only within unlocked visible) ────────────────────
  const [dragKey, setDragKey] = useState<string | null>(null)
  const onDragStart = (key: string) => (e: React.DragEvent) => {
    setDragKey(key)
    e.dataTransfer.effectAllowed = 'move'
  }
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }
  const onDrop = (targetKey: string) => (e: React.DragEvent) => {
    e.preventDefault()
    if (!dragKey || dragKey === targetKey) {
      setDragKey(null)
      return
    }
    const next = [...draft.visibleColumns]
    const fromIdx = next.indexOf(dragKey)
    const toIdx = next.indexOf(targetKey)
    if (fromIdx === -1 || toIdx === -1) {
      setDragKey(null)
      return
    }
    next.splice(fromIdx, 1)
    next.splice(toIdx, 0, dragKey)
    setDraft((d) => ({ ...d, visibleColumns: next }))
    setDragKey(null)
  }

  const toggleColumn = (key: string) => {
    setDraft((d) => ({
      ...d,
      visibleColumns: d.visibleColumns.includes(key)
        ? d.visibleColumns.filter((k) => k !== key)
        : [...d.visibleColumns, key],
    }))
  }

  const resetAll = () => {
    setDraft({
      ...DEFAULTS,
      visibleColumns: DEFAULT_VISIBLE,
    })
  }

  const handleConfirm = () => {
    onConfirm(draft)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('products.preferences.title')}
      size="3xl"
      className="max-h-[85vh] flex flex-col"
    >
      <ModalBody className="grid grid-cols-1 md:grid-cols-2 gap-8 p-6">
        {/* ── Left panel: page-level preferences ────────────────── */}
        <div className="space-y-6">
          {/* Page size */}
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              {t('products.preferences.pageSize')}
            </legend>
            <div className="space-y-1.5">
              {PAGE_SIZE_CHOICES.map((n) => (
                <label
                  key={n}
                  className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer"
                >
                  <input
                    type="radio"
                    name="pg5-page-size"
                    value={n}
                    checked={draft.pageSize === n}
                    onChange={() => setDraft((d) => ({ ...d, pageSize: n }))}
                    className="accent-blue-600"
                  />
                  <span>{n}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* Sticky columns (PG.6 wires the behavior; we persist the
              setting now so the flip is data-only when PG.6 lands). */}
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              {t('products.preferences.stickyColumns')}
            </legend>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('products.preferences.stickyColumnsHelp')}
            </p>
            <div className="space-y-1.5 pt-1">
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.stickyFirstColumn}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, stickyFirstColumn: e.target.checked }))
                  }
                  className="accent-blue-600"
                />
                <span>{t('products.preferences.stickyFirst')}</span>
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.stickyLastColumn}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, stickyLastColumn: e.target.checked }))
                  }
                  className="accent-blue-600"
                />
                <span>{t('products.preferences.stickyLast')}</span>
              </label>
            </div>
          </fieldset>

          {/* Product name display */}
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              {t('products.preferences.nameDisplay')}
            </legend>
            <div className="space-y-1.5">
              <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="radio"
                  name="pg5-name-display"
                  value="full"
                  checked={draft.productNameDisplay === 'full'}
                  onChange={() => setDraft((d) => ({ ...d, productNameDisplay: 'full' }))}
                  className="accent-blue-600 mt-0.5"
                />
                <span>{t('products.preferences.nameDisplayFull')}</span>
              </label>
              <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="radio"
                  name="pg5-name-display"
                  value="shortened"
                  checked={draft.productNameDisplay === 'shortened'}
                  onChange={() => setDraft((d) => ({ ...d, productNameDisplay: 'shortened' }))}
                  className="accent-blue-600 mt-0.5"
                />
                <span>{t('products.preferences.nameDisplayShort')}</span>
              </label>
            </div>
          </fieldset>

          {/* Sort order — single-field select. SortStackBar in the
              toolbar still drives multi-sort for power users; this is
              the simple Amazon-style entry point. */}
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              {t('products.preferences.sortOrder')}
            </legend>
            <div className="flex gap-2">
              <select
                value={draft.sortBy}
                onChange={(e) => setDraft((d) => ({ ...d, sortBy: e.target.value }))}
                className="flex-1 h-9 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
              >
                {sortFieldOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select
                value={draft.sortDir}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, sortDir: e.target.value as 'asc' | 'desc' }))
                }
                className="h-9 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
              >
                <option value="desc">↓ Descending</option>
                <option value="asc">↑ Ascending</option>
              </select>
            </div>
          </fieldset>
        </div>

        {/* ── Right panel: column visibility + drag reorder ─────── */}
        <div className="space-y-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              {t('products.preferences.columnsHeader')}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('products.preferences.columnsHelp')}
            </p>
          </div>
          <div className="border border-slate-200 dark:border-slate-700 rounded-md divide-y divide-slate-100 dark:divide-slate-800 max-h-[55vh] overflow-y-auto">
            {orderedForDisplay.map((c) => {
              const isLocked = !!c.locked
              const isVisible = isLocked || draft.visibleColumns.includes(c.key)
              const isDragging = dragKey === c.key
              const draggable = !isLocked && isVisible
              return (
                <div
                  key={c.key}
                  draggable={draggable}
                  onDragStart={draggable ? onDragStart(c.key) : undefined}
                  onDragOver={draggable ? onDragOver : undefined}
                  onDrop={draggable ? onDrop(c.key) : undefined}
                  className={cn(
                    'flex items-center gap-2 px-2 py-2 text-sm',
                    draggable && 'cursor-move hover:bg-slate-50 dark:hover:bg-slate-800',
                    isDragging && 'opacity-40',
                    isLocked && 'bg-slate-50/60 dark:bg-slate-900/40',
                  )}
                >
                  <GripVertical
                    size={14}
                    className={cn(
                      'flex-shrink-0',
                      draggable
                        ? 'text-slate-300 dark:text-slate-600'
                        : 'text-transparent',
                    )}
                    aria-hidden="true"
                  />
                  <span className="flex-1 text-slate-700 dark:text-slate-300 truncate">
                    {c.labelKey ? t(c.labelKey) : c.label || c.key}
                  </span>
                  {isLocked && (
                    <span className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
                      {t('products.preferences.lockedHint')}
                    </span>
                  )}
                  {/* iOS-style toggle */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isVisible}
                    disabled={isLocked}
                    onClick={() => !isLocked && toggleColumn(c.key)}
                    className={cn(
                      'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                      isLocked
                        ? 'bg-blue-300 dark:bg-blue-700 opacity-60 cursor-not-allowed'
                        : isVisible
                          ? 'bg-blue-600'
                          : 'bg-slate-300 dark:bg-slate-700',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                        isVisible ? 'translate-x-4' : 'translate-x-1',
                      )}
                    />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </ModalBody>

      <ModalFooter>
        <Button
          variant="ghost"
          size="sm"
          onClick={resetAll}
          className="mr-auto text-slate-500"
        >
          {t('products.preferences.reset')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('products.preferences.cancel')}
        </Button>
        <Button size="sm" onClick={handleConfirm}>
          {t('products.preferences.confirm')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// Re-export the default value object so the workspace can hydrate
// its own state without duplicating the constants.
export const PREFERENCES_DEFAULTS = DEFAULTS
export { X as CloseIcon }
