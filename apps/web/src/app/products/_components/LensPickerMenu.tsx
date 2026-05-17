'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ALL_LENS_META, OPTIONAL_LENSES } from '../ProductsWorkspace'
import type { Lens } from '../ProductsWorkspace'

interface Props {
  anchorRect: DOMRect
  visible: Lens[]
  onChange: (next: Lens[]) => void
  onClose: () => void
}

export function LensPickerMenu({ anchorRect, visible, onChange, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [dragKey, setDragKey] = useState<Lens | null>(null)
  const [mounted, setMounted] = useState(false)

  // Defer portal render until after hydration
  useEffect(() => { setMounted(true) }, [])

  // Close on outside mousedown — uses contains() so clicks inside the
  // menu are never treated as "outside" clicks.
  useEffect(() => {
    const onOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [onClose])

  const metaByKey = new Map(ALL_LENS_META.map((m) => [m.key, m]))

  const shownOptional = visible
    .filter((k) => OPTIONAL_LENSES.includes(k))
    .map((k) => metaByKey.get(k)!)
    .filter(Boolean)

  const hiddenOptional = OPTIONAL_LENSES
    .filter((k) => !visible.includes(k))
    .map((k) => metaByKey.get(k)!)
    .filter(Boolean)

  const onDragStart = (key: Lens) => (e: React.DragEvent) => {
    setDragKey(key)
    e.dataTransfer.effectAllowed = 'move'
  }
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }
  const onDrop = (targetKey: Lens) => (e: React.DragEvent) => {
    e.preventDefault()
    if (!dragKey || dragKey === targetKey) { setDragKey(null); return }
    const next = [...visible]
    const fromIdx = next.indexOf(dragKey)
    const toIdx = next.indexOf(targetKey)
    if (fromIdx === -1 || toIdx === -1) { setDragKey(null); return }
    next.splice(fromIdx, 1)
    next.splice(toIdx, 0, dragKey)
    onChange(next)
    setDragKey(null)
  }

  // Position: align right edge of menu with right edge of anchor button,
  // open below the anchor. Clamp so the menu never overflows the viewport.
  const W = 224
  const top = anchorRect.bottom + 6
  const right = Math.max(8, window.innerWidth - anchorRect.right)

  const menu = (
    <div
      ref={ref}
      style={{ position: 'fixed', top, right, width: W, zIndex: 9999 }}
      className="bg-white border border-slate-200 rounded-md shadow-xl p-1.5 dark:bg-slate-900 dark:border-slate-800 animate-fade-in"
    >
      <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 px-2 py-1.5">
        Shown
      </div>

      {shownOptional.length === 0 && (
        <div className="px-2 py-1.5 text-xs text-slate-400 dark:text-slate-500 italic">
          No extra tabs selected
        </div>
      )}

      {shownOptional.map((meta) => {
        const Icon = meta.icon
        return (
          <div
            key={meta.key}
            draggable
            onDragStart={onDragStart(meta.key)}
            onDragOver={onDragOver}
            onDrop={onDrop(meta.key)}
            className={`flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 rounded text-base cursor-move dark:hover:bg-slate-800 ${dragKey === meta.key ? 'opacity-40' : ''}`}
          >
            <span className="text-slate-300 dark:text-slate-600 font-mono select-none">⠿</span>
            <Icon size={12} className="text-slate-400 shrink-0" />
            <span className="flex-1 text-slate-700 dark:text-slate-300 text-sm">{meta.label}</span>
            <button
              type="button"
              onClick={() => onChange(visible.filter((k) => k !== meta.key))}
              className="text-slate-300 hover:text-slate-600 dark:text-slate-600 dark:hover:text-slate-300 text-xs leading-none px-1"
              title={`Remove ${meta.label}`}
            >
              ✕
            </button>
          </div>
        )
      })}

      {hiddenOptional.length > 0 && (
        <>
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 px-2 py-1.5 mt-1 border-t border-slate-100 dark:border-slate-800 pt-2">
            Add tab
          </div>
          {hiddenOptional.map((meta) => {
            const Icon = meta.icon
            return (
              <button
                key={meta.key}
                type="button"
                onClick={() => onChange([...visible, meta.key])}
                className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 rounded text-base cursor-pointer dark:hover:bg-slate-800 text-left"
              >
                <span className="text-transparent select-none font-mono">⠿</span>
                <Icon size={12} className="text-slate-400 shrink-0" />
                <span className="flex-1 text-slate-700 dark:text-slate-300 text-sm">{meta.label}</span>
                <span className="text-slate-400 text-xs font-medium">+</span>
              </button>
            )
          })}
        </>
      )}

      <div className="border-t border-slate-100 dark:border-slate-800 mt-1.5 pt-1.5 px-2 py-1 flex items-center justify-between">
        <button
          type="button"
          onClick={() => onChange([])}
          className="text-xs text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
        >
          Done
        </button>
      </div>
    </div>
  )

  if (!mounted) return null
  return createPortal(menu, document.body)
}
