'use client'

/**
 * XG.1 — Shared workspace Preferences modal.
 *
 * Hoisted from /products/_components/PreferencesModal.tsx (PG.5) so
 * every VirtualizedGrid consumer can plug in the same Amazon-style
 * two-panel preferences UI.
 *
 * Generic shape:
 *   - left panel:  page size · sticky columns · workspaceSlot · sort
 *   - right panel: every togglable column with drag-handle + iOS toggle
 *
 * Workspace-specific preferences (e.g. /products' "Product name
 * display" radios, /stock's hypothetical "Show ABC badge" toggle)
 * render via `workspaceSlot`. The workspace owns those bits of state
 * + their persistence; the modal just composes the JSX.
 *
 * Edits are held in local draft state and committed atomically on
 * Confirm; Cancel discards. Reset returns every panel field to its
 * default + reverts the visible-columns array to `defaultVisible`.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { GripVertical } from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Listbox } from '@/design-system/components/Listbox'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

/**
 * Minimal column shape the modal needs. Both /products' ColumnDef and
 * /listings' bespoke column type extend this naturally; workspaces
 * pass their own column registry without forking the modal.
 */
export interface PreferencesColumnSpec {
  key: string
  label: string
  labelKey?: string
  width?: number
  locked?: boolean
}

export interface PreferencesValue {
  pageSize: number
  visibleColumns: string[]
  stickyFirstColumn: boolean
  stickyLastColumn: boolean
  sortBy: string
  sortDir: 'asc' | 'desc'
}

export interface PreferencesModalProps {
  open: boolean
  onClose: () => void
  value: PreferencesValue
  onConfirm: (next: PreferencesValue) => void
  /** Workspace's full column registry (visible + hidden + locked). */
  allColumns: readonly PreferencesColumnSpec[]
  /** Workspace's "Reset" target visible-columns list. */
  defaultVisible: readonly string[]
  /** Workspace's sort field options. Pass an empty array to hide
   *  the sort section entirely (matches the pageSizeChoices=[] opt-out
   *  pattern; used by /pricing where sort happens via column-header
   *  click, not a global setting). */
  sortFieldOptions: ReadonlyArray<{ value: string; label: string }>
  /** Optional override of the 20/50/100/250 page-size choices.
   *  Pass an empty array to hide the page-size section entirely
   *  (workspaces with a fixed page size, e.g. /fulfillment/stock at
   *  200, opt out this way). */
  pageSizeChoices?: number[]
  /** Modal title (defaults to t('products.preferences.title')). */
  title?: string
  /**
   * Escape hatch for workspace-specific preference panels. Rendered
   * between Sort order and the Column panel on desktop. Workspace
   * owns the state + persistence for whatever's in here.
   *
   * Example: /products renders a "Product name display" radio group;
   * /stock could render "Show ABC class badge" toggle, etc.
   */
  workspaceSlot?: ReactNode
}

const DEFAULT_PAGE_SIZE_CHOICES = [20, 50, 100, 250]

const SHARED_DEFAULTS: Omit<PreferencesValue, 'visibleColumns'> = {
  pageSize: 100,
  stickyFirstColumn: true,
  stickyLastColumn: true,
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
  sortFieldOptions,
  pageSizeChoices = DEFAULT_PAGE_SIZE_CHOICES,
  title,
  workspaceSlot,
}: PreferencesModalProps) {
  const { t } = useTranslations()

  // Draft mirrors `value` and is what the modal mutates. Reset on
  // every open so a previous Cancel doesn't leak edits into the next
  // session of the modal.
  const [draft, setDraft] = useState<PreferencesValue>(value)
  useEffect(() => {
    if (open) setDraft(value)
  }, [open, value])

  // Split togglable vs locked columns. Locked columns (workspace-
  // defined `locked: true`) render with a disabled toggle so the
  // operator sees they exist but can't hide them.
  const togglable = useMemo(
    () => allColumns.filter((c) => c.label || c.key === 'thumb'),
    [allColumns],
  )

  // Render order on the right panel: locked-leading (any locked
  // column whose position in `allColumns` precedes the first unlocked
  // column) → visible columns in draft order → hidden columns →
  // locked-trailing (locked columns appearing after the last unlocked).
  //
  // Workspaces designate leading vs trailing by ordering their
  // `allColumns` registry; we never hardcode column keys here.
  const orderedForDisplay = useMemo<PreferencesColumnSpec[]>(() => {
    const firstUnlockedIdx = togglable.findIndex((c) => !c.locked)
    const lastUnlockedIdx = (() => {
      for (let i = togglable.length - 1; i >= 0; i--) {
        if (!togglable[i].locked) return i
      }
      return -1
    })()
    const lockedLeading = togglable.filter(
      (c, i) => c.locked && (firstUnlockedIdx === -1 || i < firstUnlockedIdx),
    )
    const lockedTrailing = togglable.filter(
      (c, i) => c.locked && lastUnlockedIdx !== -1 && i > lastUnlockedIdx,
    )
    const unlockedVisible = draft.visibleColumns
      .map((k) => togglable.find((c) => c.key === k && !c.locked))
      .filter((c): c is PreferencesColumnSpec => !!c)
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
      ...SHARED_DEFAULTS,
      visibleColumns: [...defaultVisible],
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
      title={title ?? t('products.preferences.title')}
      size="3xl"
      className="max-h-[85vh] flex flex-col"
    >
      <ModalBody className="grid grid-cols-1 md:grid-cols-2 gap-8 p-6">
        {/* ── Left panel: page-level preferences ────────────────── */}
        <div className="space-y-6">
          {/* Page size — hidden when workspace passes pageSizeChoices=[] */}
          {pageSizeChoices.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                {t('products.preferences.pageSize')}
              </legend>
              <div className="space-y-1.5">
                {pageSizeChoices.map((n) => (
                  <label
                    key={n}
                    className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer"
                  >
                    <input
                      type="radio"
                      name="xg1-page-size"
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
          )}

          {/* Sticky columns */}
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

          {/* Workspace-specific extras (e.g. /products name display) */}
          {workspaceSlot}

          {/* Sort order — single-field select. Per-workspace SortStack
              still drives multi-sort for power users; this is the
              simple Amazon-style entry point. Hidden when the workspace
              passes sortFieldOptions=[] (e.g. /pricing where sort is
              column-header-driven, not a global preference). */}
          {sortFieldOptions.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                {t('products.preferences.sortOrder')}
              </legend>
              <div className="flex gap-2">
                <Listbox
                  value={draft.sortBy}
                  onChange={(v) => setDraft((d) => ({ ...d, sortBy: v }))}
                  options={sortFieldOptions.map((o) => ({ value: o.value, label: o.label }))}
                  ariaLabel={t('products.preferences.sortOrder')}
                  className="flex-1"
                />
                <Listbox
                  value={draft.sortDir}
                  onChange={(v) =>
                    setDraft((d) => ({ ...d, sortDir: v as 'asc' | 'desc' }))
                  }
                  options={[
                    { value: 'desc', label: '↓ Descending' },
                    { value: 'asc', label: '↑ Ascending' },
                  ]}
                  ariaLabel="Sort direction"
                  className="w-36"
                />
              </div>
            </fieldset>
          )}
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
          <div className="border border-default dark:border-slate-700 rounded-md divide-y divide-slate-100 dark:divide-slate-800 max-h-[55vh] overflow-y-auto">
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
                    <span className="text-[10px] uppercase tracking-wider text-tertiary dark:text-slate-500">
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

export const PREFERENCES_DEFAULTS = SHARED_DEFAULTS
