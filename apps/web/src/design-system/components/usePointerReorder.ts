'use client'

import { useRef, useState, type HTMLAttributes } from 'react'

/** Pointer capture for a reorder grip. The caller supplies the equivalent keyboard action. */
export function usePointerReorder({ disabled = false, horizontal = false, onMove }: {
  disabled?: boolean
  horizontal?: boolean
  onMove(from: number, to: number): void
}) {
  const pointer = useRef<{ index: number; position: number } | null>(null)
  const suppressClick = useRef(false)
  const [dragging, setDragging] = useState<number | null>(null)
  const cancel = () => { pointer.current = null; setDragging(null) }
  const handleProps = (index: number): HTMLAttributes<HTMLElement> => ({
    draggable: false,
    onDragStart: event => event.preventDefault(),
    onPointerDown: event => {
      if (disabled || event.button !== 0) return
      suppressClick.current = false
      pointer.current = { index, position: horizontal ? event.clientX : event.clientY }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove: event => {
      if (pointer.current && Math.abs((horizontal ? event.clientX : event.clientY) - pointer.current.position) > 4) setDragging(index)
    },
    onPointerUp: event => {
      const start = pointer.current
      cancel()
      if (!start || disabled || Math.abs((horizontal ? event.clientX : event.clientY) - start.position) <= 4) return
      suppressClick.current = true
      const group = event.currentTarget.closest('[data-nds-reorder-list]')
      const target = [...(group?.querySelectorAll('[data-nds-reorder-item]') ?? [])].findIndex(item => {
        const rect = item.getBoundingClientRect()
        return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
      })
      if (target >= 0 && start.index !== target) onMove(start.index, target)
    },
    onClickCapture: event => {
      if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false }
    },
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
  })
  return { dragging, cancel, handleProps }
}
