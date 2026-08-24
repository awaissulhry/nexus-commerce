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
import { Modal } from './Modal'
import { Button } from '../primitives/Button'
import { Toggle } from '../primitives/Toggle'

export interface ColumnGroupProps {
  id: string
  label: string
  color: string
  columns: string[]
  visible: boolean
}

export interface ColumnGroupModalProps {
  open: boolean
  onClose: () => void
  groups: ColumnGroupProps[]
  onGroupsChange: (groups: ColumnGroupProps[]) => void
}

// Export ColumnGroup as an alias for ColumnGroupProps
export type { ColumnGroupProps as ColumnGroup }

interface SortableRowProps {
  group: ColumnGroupProps
  onToggle: (id: string) => void
  canHide: boolean
}

function SortableRow({ group, onToggle, canHide }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: group.id })
  const { visible } = group
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="h10-ds-cgm-row"
    >
      <button
        {...attributes}
        {...listeners}
        tabIndex={0}
        aria-label={`Drag to reorder ${group.label}`}
        className="h10-ds-cgm-grip"
      >
        <GripVertical size={16} />
      </button>
      <span className="h10-ds-cgm-dot" data-color={group.color} aria-hidden />
      <div className="h10-ds-cgm-main">
        <span className="h10-ds-cgm-label" data-hidden={visible ? undefined : ''}>
          {group.label}
        </span>
        <span className="h10-ds-cgm-count">
          {group.columns.length} {group.columns.length === 1 ? 'column' : 'columns'}
        </span>
      </div>
      <Toggle
        checked={visible}
        onChange={() => onToggle(group.id)}
        disabled={visible && !canHide}
        aria-label={`${visible ? 'Hide' : 'Show'} ${group.label}`}
      />
    </div>
  )
}

export function ColumnGroupModal({ open, onClose, groups, onGroupsChange }: ColumnGroupModalProps) {
  const [localGroups, setLocalGroups] = useState<ColumnGroupProps[]>(() => [...groups])

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const visibleCount = localGroups.filter((g) => g.visible).length
  const canHide = visibleCount > 1

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    const oldIdx = localGroups.findIndex((g) => g.id === active.id)
    const newIdx = localGroups.findIndex((g) => g.id === over.id)
    setLocalGroups((prev) => arrayMove(prev, oldIdx, newIdx))
  }

  function handleToggle(id: string) {
    setLocalGroups((prev) =>
      prev.map((g) => g.id === id ? { ...g, visible: !g.visible } : g),
    )
  }

  function handleReset() {
    setLocalGroups(groups.map((g) => ({ ...g, visible: true })))
  }

  function handleApply() {
    onGroupsChange(localGroups)
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
        <div className="h10-ds-cgm-foot">
          <Button variant="ghost" size="sm" onClick={handleReset} className="h10-ds-cgm-reset">
            <RotateCcw size={14} />
            Reset to default
          </Button>
          <div className="h10-ds-cgm-foot-actions">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={handleApply}>Apply</Button>
          </div>
        </div>
      }
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={localGroups.map((g) => g.id)} strategy={verticalListSortingStrategy}>
          <div className="h10-ds-cgm-list">
            {localGroups.map((group) => (
              <SortableRow
                key={group.id}
                group={group}
                onToggle={handleToggle}
                canHide={canHide}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {!canHide && (
        <p className="h10-ds-cgm-note">
          At least one group must remain visible.
        </p>
      )}
    </Modal>
  )
}
