'use client'

import { useEffect, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import ScheduledReportsSection from './ScheduledReportsSection'
import type { T } from '../_lib/types'

/**
 * DO.32 / DO.33 — dashboard customise sheet with drag-drop reorder.
 *
 * Operator can both hide individual widgets (checkbox per row) and
 * reorder them via the grip handle on the left. Order is persisted
 * to DashboardLayout.widgetOrder; visibility to .hiddenWidgets.
 *
 * KpiGrid + AlertsPanel are intentionally omitted from this list
 * — they're the operator's two non-negotiable signals (financial
 * state + what needs attention right now). Hiding either turns
 * the Command Center into a hollow shell.
 */

export interface ToggleableWidget {
  id: string
  labelKey: string
  /**
   * Layout column the widget belongs to. The renderer respects
   * this regardless of the operator's order — reorder is allowed
   * within a column, not across columns. Mixing them would break
   * the responsive 2-column grid the dashboard depends on.
   */
  column: 'left' | 'right'
}

export const TOGGLEABLE_WIDGETS: ToggleableWidget[] = [
  // Left column (charts + lists)
  { id: 'sparkline', labelKey: 'overview.customize.widget.sparkline', column: 'left' },
  { id: 'channelTrend', labelKey: 'overview.customize.widget.channelTrend', column: 'left' },
  { id: 'channelGrid', labelKey: 'overview.customize.widget.channelGrid', column: 'left' },
  { id: 'marketplaceMatrix', labelKey: 'overview.customize.widget.marketplaceMatrix', column: 'left' },
  { id: 'financial', labelKey: 'overview.customize.widget.financial', column: 'left' },
  { id: 'predictive', labelKey: 'overview.customize.widget.predictive', column: 'left' },
  { id: 'heatmap', labelKey: 'overview.customize.widget.heatmap', column: 'left' },
  { id: 'topProducts', labelKey: 'overview.customize.widget.topProducts', column: 'left' },
  // Right column (panels)
  { id: 'goals', labelKey: 'overview.customize.widget.goals', column: 'right' },
  { id: 'customer', labelKey: 'overview.customize.widget.customer', column: 'right' },
  { id: 'catalog', labelKey: 'overview.customize.widget.catalog', column: 'right' },
  { id: 'activity', labelKey: 'overview.customize.widget.activity', column: 'right' },
  { id: 'quickActions', labelKey: 'overview.customize.widget.quickActions', column: 'right' },
]

/**
 * Resolve a canonical widget order respecting (1) the operator's
 * saved order, (2) any new widgets that didn't exist when the
 * order was saved.
 *
 * Returned list contains every TOGGLEABLE_WIDGET id exactly once;
 * widgets in `saved` come first in saved order, unknown ones fall
 * through to canonical position at the end.
 */
export function resolveWidgetOrder(saved: string[]): string[] {
  const known = new Set(TOGGLEABLE_WIDGETS.map((w) => w.id))
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of saved) {
    if (known.has(id) && !seen.has(id)) {
      result.push(id)
      seen.add(id)
    }
  }
  for (const w of TOGGLEABLE_WIDGETS) {
    if (!seen.has(w.id)) result.push(w.id)
  }
  return result
}

export default function CustomizeSheet({
  t,
  open,
  onClose,
  hiddenWidgets,
  widgetOrder,
  activeView,
  onSaved,
}: {
  t: T
  open: boolean
  onClose: () => void
  hiddenWidgets: string[]
  widgetOrder: string[]
  /** DO.49 — when a saved view is active, the sheet offers an
   * "Update this view" path that overwrites the source row. null
   * when no saved view is active (just live state). */
  activeView: { id: string; name: string } | null
  onSaved: (next: { hiddenWidgets: string[]; widgetOrder: string[] }) => void
}) {
  const [draftHidden, setDraftHidden] = useState<Set<string>>(
    () => new Set(hiddenWidgets),
  )
  const [draftOrder, setDraftOrder] = useState<string[]>(() =>
    resolveWidgetOrder(widgetOrder),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-seed drafts whenever the modal opens with a fresh baseline.
  // Cancelling a previous edit shouldn't carry into the next session.
  useEffect(() => {
    if (open) {
      setDraftHidden(new Set(hiddenWidgets))
      setDraftOrder(resolveWidgetOrder(widgetOrder))
      setError(null)
    }
  }, [open, hiddenWidgets, widgetOrder])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const toggle = (id: string) => {
    setDraftHidden((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setDraftOrder((items) => {
      const oldIndex = items.indexOf(active.id as string)
      const newIndex = items.indexOf(over.id as string)
      if (oldIndex < 0 || newIndex < 0) return items
      // Only allow reorder within the same column. Cross-column
      // moves silently no-op so the operator's drag doesn't break
      // the layout shape.
      const widgetById = new Map(TOGGLEABLE_WIDGETS.map((w) => [w.id, w]))
      const activeCol = widgetById.get(active.id as string)?.column
      const overCol = widgetById.get(over.id as string)?.column
      if (activeCol !== overCol) return items
      return arrayMove(items, oldIndex, newIndex)
    })
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const nextHidden = Array.from(draftHidden)
      const res = await fetch(`${getBackendUrl()}/api/dashboard/layout`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hiddenWidgets: nextHidden,
          widgetOrder: draftOrder,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      onSaved({ hiddenWidgets: nextHidden, widgetOrder: draftOrder })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // DO.49 — overwrite the active saved view with the current draft.
  // PUT /api/dashboard/views/:id with the new hidden + order arrays
  // (existing endpoint from DO.39). Also writes the same draft to
  // the live layout so the dashboard reflects immediately.
  const saveToActiveView = async () => {
    if (!activeView) return
    setSaving(true)
    setError(null)
    try {
      const nextHidden = Array.from(draftHidden)
      const viewRes = await fetch(
        `${getBackendUrl()}/api/dashboard/views/${activeView.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hiddenWidgets: nextHidden,
            widgetOrder: draftOrder,
          }),
        },
      )
      if (!viewRes.ok) {
        const j = await viewRes.json().catch(() => ({}))
        throw new Error(j?.error ?? `HTTP ${viewRes.status}`)
      }
      // Mirror to live layout so the dashboard updates.
      await fetch(`${getBackendUrl()}/api/dashboard/layout`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hiddenWidgets: nextHidden,
          widgetOrder: draftOrder,
        }),
      })
      onSaved({ hiddenWidgets: nextHidden, widgetOrder: draftOrder })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  // Group draftOrder by column for separate sortable sections.
  const widgetById = new Map(TOGGLEABLE_WIDGETS.map((w) => [w.id, w]))
  const leftIds = draftOrder.filter(
    (id) => widgetById.get(id)?.column === 'left',
  )
  const rightIds = draftOrder.filter(
    (id) => widgetById.get(id)?.column === 'right',
  )

  return (
    <Modal open={open} onClose={onClose} title={t('overview.customize.title')}>
      <div className="px-4 py-3 space-y-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t('overview.customize.description')}
        </p>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <ColumnList
            t={t}
            heading={t('overview.customize.column.left')}
            ids={leftIds}
            hidden={draftHidden}
            onToggle={toggle}
          />
          <ColumnList
            t={t}
            heading={t('overview.customize.column.right')}
            ids={rightIds}
            hidden={draftHidden}
            onToggle={toggle}
          />
        </DndContext>
        {error && (
          <div className="text-sm text-rose-600 dark:text-rose-400">
            {error}
          </div>
        )}
        {/* DO.40 — scheduled email digest config tucked under the
            same Customise modal. Operator manages layout + report
            subscriptions in one place. */}
        <div className="pt-3 mt-3 border-t border-slate-100 dark:border-slate-800">
          <ScheduledReportsSection t={t} />
        </div>
      </div>
      <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2 flex-wrap">
        {/* DO.39 — save current draft as a named view. Inline
            single-input form rather than a separate modal — the
            roster fits in a header dropdown and the operator
            already has the customise context open. */}
        <SaveAsView
          t={t}
          hiddenWidgets={Array.from(draftHidden)}
          widgetOrder={draftOrder}
          onSaved={() => {
            // Bubble up so the parent refetches and the new view
            // appears in the header switcher.
            onSaved({
              hiddenWidgets: Array.from(draftHidden),
              widgetOrder: draftOrder,
            })
          }}
        />
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          {/* DO.49 — when a saved view is active, the primary action
              becomes "Update [view name]" (overwrites the view). The
              "Save (live)" secondary saves to the live layout only,
              leaving the view untouched. When no view is active, the
              single Save button persists to the live layout. */}
          {activeView ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={save}
                loading={saving}
              >
                {t('overview.views.saveLiveOnly')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={saveToActiveView}
                loading={saving}
                title={t('overview.views.updateThisView', {
                  name: activeView.name,
                })}
              >
                {t('overview.views.updateThisView', { name: activeView.name })}
              </Button>
            </>
          ) : (
            <Button variant="primary" size="sm" onClick={save} loading={saving}>
              {t('common.save')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}

function SaveAsView({
  t,
  hiddenWidgets,
  widgetOrder,
  onSaved,
}: {
  t: T
  hiddenWidgets: string[]
  widgetOrder: string[]
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/dashboard/views`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          hiddenWidgets,
          widgetOrder,
        }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json?.error ?? `HTTP ${res.status}`)
      }
      setName('')
      onSaved()
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      onSubmit={submit}
      className="inline-flex items-center gap-1.5 flex-wrap"
    >
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('overview.views.savePlaceholder')}
        maxLength={80}
        aria-label={t('overview.views.saveLabel')}
        className={cn(
          'h-7 px-2 text-sm rounded-md border tabular-nums w-44',
          'border-slate-200 dark:border-slate-700',
          'bg-white dark:bg-slate-900',
          'text-slate-700 dark:text-slate-300',
          'placeholder:text-slate-400 dark:placeholder:text-slate-500',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
        )}
      />
      <Button
        variant="secondary"
        size="sm"
        type="submit"
        loading={busy}
        disabled={!name.trim()}
      >
        {t('overview.views.saveAs')}
      </Button>
      {err && (
        <span className="text-xs text-rose-600 dark:text-rose-400">{err}</span>
      )}
    </form>
  )
}

function ColumnList({
  t,
  heading,
  ids,
  hidden,
  onToggle,
}: {
  t: T
  heading: string
  ids: string[]
  hidden: Set<string>
  onToggle: (id: string) => void
}) {
  if (ids.length === 0) return null
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-semibold mb-1.5">
        {heading}
      </div>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-md">
          {ids.map((id) => {
            const widgetDef = TOGGLEABLE_WIDGETS.find((w) => w.id === id)
            if (!widgetDef) return null
            return (
              <SortableRow
                key={id}
                t={t}
                id={id}
                labelKey={widgetDef.labelKey}
                checked={!hidden.has(id)}
                onToggle={() => onToggle(id)}
              />
            )
          })}
        </ul>
      </SortableContext>
    </div>
  )
}

function SortableRow({
  t,
  id,
  labelKey,
  checked,
  onToggle,
}: {
  t: T
  id: string
  labelKey: string
  checked: boolean
  onToggle: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  } as React.CSSProperties
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-2 px-3 py-2 text-base bg-white dark:bg-slate-900',
        isDragging && 'opacity-50 z-10',
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('overview.customize.dragHandle')}
        className={cn(
          'inline-flex items-center justify-center w-5 h-5 rounded',
          'text-slate-400 dark:text-slate-500 cursor-grab',
          'hover:text-slate-700 dark:hover:text-slate-200',
          'hover:bg-slate-100 dark:hover:bg-slate-800',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
        )}
      >
        <GripVertical className="w-3.5 h-3.5" />
      </button>
      <label className="flex items-center gap-2 flex-1 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="w-4 h-4 rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-500/40"
        />
        <span className="text-slate-800 dark:text-slate-200">
          {t(labelKey)}
        </span>
      </label>
    </li>
  )
}
