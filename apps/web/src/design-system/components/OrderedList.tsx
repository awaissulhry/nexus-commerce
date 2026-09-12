'use client'

import { useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react'
import { ToolbarButton } from '../primitives/ToolbarButton'
import { usePointerReorder } from './usePointerReorder'

export interface OrderedListProps {
  label: string
  items: readonly string[]
  onChange: (items: string[]) => void
  renderItem?: (item: string) => ReactNode
  /** Human-readable control names and announcements while items retain stable IDs. */
  itemLabel?: (item: string) => string
  disabled?: boolean
  /** Use the focusable grip with ArrowUp/ArrowDown instead of separate arrow buttons. */
  keyboardGrip?: boolean
  /** Unboxed 28px rows for compact mapping forms. */
  compact?: boolean
  draggable?: boolean
}

/** Controlled ordering with equivalent pointer and keyboard actions; identities remain stable. */
export function OrderedList({ label, items, onChange, renderItem, itemLabel = item => item, disabled = false, draggable = true, keyboardGrip = false, compact = false }: OrderedListProps) {
  const dragged = useRef<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const move = (from: number, to: number) => {
    if (disabled || from < 0 || to < 0 || to >= items.length || from === to) return
    const next = [...items]; const [item] = next.splice(from, 1); next.splice(to, 0, item)
    onChange(next); setAnnouncement(`${itemLabel(item)}, position ${to + 1} of ${items.length}`)
  }
  const pointer = usePointerReorder({ disabled, onMove: move })
  return <>
    <ol className={`nds-ordered-list${compact ? ' compact' : ''}`} aria-label={label} data-nds-reorder-list>
      {items.map((item, index) => <li key={item} data-nds-reorder-item className={`nds-ordered-list-item${pointer.dragging === index ? ' dragging' : ''}`}
        onDragOver={event => { if (dragged.current && !disabled) event.preventDefault() }}
        onDrop={event => { event.preventDefault(); if (dragged.current) move(items.indexOf(dragged.current), index); dragged.current = null }}>
        {draggable && items.length > 1 && (keyboardGrip
          ? <ToolbarButton className="nds-ordered-list-grip" tooltip={false} label={`Reorder ${itemLabel(item)}; use arrow keys`} icon={<GripVertical size={16} />} disabled={disabled}
              onKeyDown={event => {
                if (event.key === 'Escape') pointer.cancel()
                if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(index, index + (event.key === 'ArrowUp' ? -1 : 1)) }
              }}
              {...pointer.handleProps(index)} />
          : <span draggable={!disabled} onDragStart={event => { dragged.current = item; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item) }} onDragEnd={() => { dragged.current = null }} aria-hidden><GripVertical size={16} /></span>)}
        <span className="nds-ordered-list-content">{renderItem ? renderItem(item) : item}</span>
        {items.length > 1 && !keyboardGrip && <><ToolbarButton label={`Move ${itemLabel(item)} up`} icon={<ArrowUp size={16} />} disabled={disabled || index === 0} onClick={() => move(index, index - 1)} />
        <ToolbarButton label={`Move ${itemLabel(item)} down`} icon={<ArrowDown size={16} />} disabled={disabled || index === items.length - 1} onClick={() => move(index, index + 1)} /></>}
      </li>)}
    </ol>
    <span className="sr-only" role="status">{announcement}</span>
  </>
}
