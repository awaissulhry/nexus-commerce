'use client'
import { useState } from 'react'
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, RotateCcw } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Button } from '@/design-system/primitives/Button'
import { Toggle } from '@/design-system/primitives/Toggle'
import { type FlatFileColumnGroup } from './FlatFileGrid.types'

const GROUP_DOT: Record<string, string> = {
  slate: 'bg-slate-400', blue: 'bg-blue-400', purple: 'bg-purple-400',
  emerald: 'bg-emerald-400', orange: 'bg-orange-400', teal: 'bg-teal-400',
  cyan: 'bg-cyan-400', sky: 'bg-sky-400', amber: 'bg-amber-400',
  violet: 'bg-violet-400', red: 'bg-red-400',
}

interface SortableRowProps {
  group: FlatFileColumnGroup
  visible: boolean
  onToggle: (id: string) => void
  canHide: boolean
}

function SortableRow({ group, visible, onToggle, canHide }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: group.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="flex items-center gap-3 rounded-lg px-1 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50"
    >
      <button
        {...attributes}
        {...listeners}
        tabIndex={-1}
        aria-label={`Drag to reorder ${group.label}`}
        className="flex-shrink-0 cursor-grab text-slate-300 hover:text-slate-500 active:cursor-grabbing dark:text-slate-600 dark:hover:text-tertiary"
      >
        <GripVertical size={16} />
      </button>
      <span
        className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${GROUP_DOT[group.color] ?? 'bg-slate-400'}`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <span className={`text-sm font-medium ${visible ? 'text-slate-800 dark:text-slate-100' : 'text-tertiary dark:text-slate-500'}`}>
          {group.label}
        </span>
        <span className="ml-2 text-xs text-tertiary dark:text-slate-500">
          {group.columns.length} {group.columns.length === 1 ? 'column' : 'columns'}
        </span>
      </div>
      <Toggle
        checked={visible}
        onChange={() => { if (!visible || canHide) onToggle(group.id) }}
        disabled={visible && !canHide}
        aria-label={`${visible ? 'Hide' : 'Show'} ${group.label}`}
      />
    </div>
  )
}

export interface ColumnGroupModalProps {
  open: boolean
  onClose: () => void
  groups: FlatFileColumnGroup[]
  closedGroups: Set<string>
  groupOrder: string[]
  onApply: (closedGroups: Set<string>, groupOrder: string[]) => void
}

export function ColumnGroupModal({ open, onClose, groups, closedGroups, groupOrder, onApply }: ColumnGroupModalProps) {
  const [localOrder, setLocalOrder] = useState<string[]>(() =>
    groupOrder.length ? groupOrder : groups.map((g) => g.id),
  )
  const [localClosed, setLocalClosed] = useState<Set<string>>(() => new Set(closedGroups))

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const orderedGroups = [
    ...localOrder.map((id) => groups.find((g) => g.id === id)).filter(Boolean) as FlatFileColumnGroup[],
    ...groups.filter((g) => !localOrder.includes(g.id)),
  ]

  const visibleCount = groups.length - localClosed.size
  const canHide = visibleCount > 1

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    const oldIdx = orderedGroups.findIndex((g) => g.id === active.id)
    const newIdx = orderedGroups.findIndex((g) => g.id === over.id)
    setLocalOrder(arrayMove(orderedGroups.map((g) => g.id), oldIdx, newIdx))
  }

  function handleToggle(id: string) {
    setLocalClosed((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function handleReset() {
    setLocalOrder(groups.map((g) => g.id))
    setLocalClosed(new Set())
  }

  function handleApply() {
    onApply(localClosed, localOrder)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Column groups"
      subtitle="Show, hide, and reorder groups. Drag the handle to reorder."
      size="md"
      footer={
        <div className="flex w-full items-center justify-between">
          <Button variant="ghost" size="sm" onClick={handleReset} className="gap-1.5">
            <RotateCcw size={14} />
            Reset to default
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={handleApply}>Apply</Button>
          </div>
        </div>
      }
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={orderedGroups.map((g) => g.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-0.5">
            {orderedGroups.map((group) => (
              <SortableRow
                key={group.id}
                group={group}
                visible={!localClosed.has(group.id)}
                onToggle={handleToggle}
                canHide={canHide}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {!canHide && (
        <p className="mt-3 text-xs text-tertiary dark:text-slate-500">
          At least one group must remain visible.
        </p>
      )}
    </Modal>
  )
}
