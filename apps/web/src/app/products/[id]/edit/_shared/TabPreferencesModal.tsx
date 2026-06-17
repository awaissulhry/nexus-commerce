'use client'

/**
 * TC.5 — Customize Tabs modal.
 *
 * Replaces the binary "+ More tabs / Show less" toggle with a
 * per-user preference UI: checkbox-toggle visibility for every
 * canonical tab + drag-drop reorder via @dnd-kit/sortable.
 *
 * Three interaction zones per row:
 *   1. Drag handle (`GripVertical`)  — keyboard + pointer reorder.
 *   2. Checkbox                       — toggle visibility (no nav).
 *   3. Row body (label area)          — click to navigate to that
 *      tab; auto-pins as visible + closes the modal. The modal
 *      doubles as a quick-jump menu for hidden tabs.
 *
 * Draft state: edits are held locally and only persisted via
 * useTabPrefs on Save. Cancel discards. Reset restores defaults in
 * the draft (still requires Save to persist).
 *
 * Min-visible guard: Save is disabled (and visually muted) when the
 * draft has zero visible tabs, matching useTabPrefs's setter veto.
 */

import { useEffect, useMemo, useState } from 'react'
import { GripVertical } from 'lucide-react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
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
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'
import {
  DEFAULT_TAB_PREFS,
  resolveTabLabel,
  type TabKey,
  type TabPref,
} from './useTabPrefs'

interface Props {
  open: boolean
  onClose: () => void
  value: TabPref[]
  onSave: (next: TabPref[]) => void
  /** Called when the operator clicks a row body. Auto-pins the tab
   *  (visible=true), persists the new prefs, then the parent should
   *  navigate to it. The modal closes itself before this fires. */
  onNavigateToTab: (key: TabKey, autoPinned: TabPref[]) => void
}

export default function TabPreferencesModal({
  open,
  onClose,
  value,
  onSave,
  onNavigateToTab,
}: Props) {
  const { t } = useTranslations()

  // Local draft — only flushed to parent on Save.
  const [draft, setDraft] = useState<TabPref[]>(value)

  // Re-seed draft each time the modal opens so it reflects the
  // current persisted state (operator may have made changes via
  // some other path between opens).
  useEffect(() => {
    if (open) setDraft(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const visibleCount = useMemo(
    () => draft.filter((p) => p.visible).length,
    [draft],
  )
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(value),
    [draft, value],
  )

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 8 px activation distance keeps the row's click-to-navigate
      // intact — a stationary click on the label still navigates;
      // only intentional drags engage the sortable.
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setDraft((prev) => {
      const oldIndex = prev.findIndex((p) => p.key === active.id)
      const newIndex = prev.findIndex((p) => p.key === over.id)
      if (oldIndex < 0 || newIndex < 0) return prev
      return arrayMove(prev, oldIndex, newIndex)
    })
  }

  // TC.9 — Localised screen-reader announcements for the drag flow.
  // @dnd-kit's defaults are English-only; routing them through `t`
  // keeps the IT operators' VoiceOver consistent with the visible UI.
  // Position in announcements is 1-indexed for natural-language read.
  const announcements: Announcements = {
    onDragStart({ active }) {
      return t('products.edit.tabs.customize.a11y.dragStart', {
        label: resolveTabLabel(active.id as TabKey, t),
      })
    },
    onDragOver({ active, over }) {
      if (!over) return undefined
      const position = draft.findIndex((p) => p.key === over.id) + 1
      return t('products.edit.tabs.customize.a11y.dragOver', {
        label: resolveTabLabel(active.id as TabKey, t),
        position,
      })
    },
    onDragEnd({ active, over }) {
      if (!over) {
        return t('products.edit.tabs.customize.a11y.dragCancel', {
          label: resolveTabLabel(active.id as TabKey, t),
        })
      }
      const position = draft.findIndex((p) => p.key === over.id) + 1
      return t('products.edit.tabs.customize.a11y.dragEnd', {
        label: resolveTabLabel(active.id as TabKey, t),
        position,
      })
    },
    onDragCancel({ active }) {
      return t('products.edit.tabs.customize.a11y.dragCancel', {
        label: resolveTabLabel(active.id as TabKey, t),
      })
    },
  }

  const toggle = (key: TabKey) => {
    setDraft((prev) =>
      prev.map((p) => (p.key === key ? { ...p, visible: !p.visible } : p)),
    )
  }

  const handleNavigate = (key: TabKey) => {
    // Auto-pin the navigated tab + persist immediately so the operator
    // lands on a tab that's now in their pinned set. Bypasses Save —
    // navigation is itself the confirming action.
    const pinned = draft.map((p) =>
      p.key === key ? { ...p, visible: true } : p,
    )
    onNavigateToTab(key, pinned)
    onClose()
  }

  const handleSave = () => {
    if (visibleCount === 0) return
    onSave(draft)
    onClose()
  }

  const handleReset = () => {
    setDraft(DEFAULT_TAB_PREFS.map((p) => ({ ...p })))
  }

  const handleCancel = () => {
    setDraft(value)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={handleCancel}
      title={t('products.edit.tabs.customize.title')}
      description={t('products.edit.tabs.customize.description')}
      size="md"
    >
      <ModalBody>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
          accessibility={{ announcements }}
        >
          <SortableContext
            items={draft.map((p) => p.key)}
            strategy={verticalListSortingStrategy}
          >
            <ul
              role="list"
              className="space-y-1 max-h-[60vh] overflow-y-auto pr-1"
            >
              {draft.map((pref) => (
                <SortableRow
                  key={pref.key}
                  pref={pref}
                  label={resolveTabLabel(pref.key, t)}
                  onToggle={() => toggle(pref.key)}
                  onNavigate={() => handleNavigate(pref.key)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
        {visibleCount === 0 && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            {t('products.edit.tabs.customize.minOneVisible')}
          </p>
        )}
      </ModalBody>
      <ModalFooter>
        <div className="flex items-center justify-between w-full gap-2">
          <Button variant="ghost" size="sm" onClick={handleReset}>
            {t('products.edit.tabs.customize.reset')}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={handleCancel}>
              {t('products.edit.tabs.customize.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={!dirty || visibleCount === 0}
            >
              {t('products.edit.tabs.customize.save')}
            </Button>
          </div>
        </div>
      </ModalFooter>
    </Modal>
  )
}

interface SortableRowProps {
  pref: TabPref
  label: string
  onToggle: () => void
  onNavigate: () => void
}

function SortableRow({ pref, label, onToggle, onNavigate }: SortableRowProps) {
  const { t } = useTranslations()
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: pref.key })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'group flex items-center gap-2 rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5',
        isDragging && 'opacity-50 shadow-lg z-10',
        !pref.visible && 'opacity-70',
      )}
    >
      {/* Drag handle */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('products.edit.tabs.customize.dragHandleAria', { label })}
        title={t('products.edit.tabs.customize.dragHandleTooltip')}
        className="cursor-grab active:cursor-grabbing p-1 text-tertiary hover:text-slate-600 dark:hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 rounded"
      >
        <GripVertical className="w-4 h-4" />
      </button>

      {/* Visibility checkbox */}
      <input
        type="checkbox"
        checked={pref.visible}
        onChange={onToggle}
        aria-label={t('products.edit.tabs.customize.visibilityAria', { label })}
        className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus-visible:ring-2 focus-visible:ring-blue-500/40 cursor-pointer"
      />

      {/* Row body — click navigates */}
      <button
        type="button"
        onClick={onNavigate}
        className="flex-1 text-left text-sm text-slate-700 dark:text-slate-200 hover:text-slate-900 dark:hover:text-slate-50 px-1 py-0.5 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        title={t('products.edit.tabs.customize.rowNavTooltip', { label })}
      >
        {label}
        {!pref.visible && (
          <span className="ml-2 text-xs text-tertiary font-normal">
            {t('products.edit.tabs.customize.hiddenBadge')}
          </span>
        )}
      </button>
    </li>
  )
}
