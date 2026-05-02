'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowUpDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export type SortOption =
  | 'updated'
  | 'created'
  | 'sku'
  | 'name'
  | 'price-asc'
  | 'price-desc'
  | 'stock-asc'
  | 'stock-desc'

interface Props {
  value: SortOption
  onChange: (next: SortOption) => void
}

const OPTIONS: Array<{ value: SortOption; label: string }> = [
  { value: 'updated', label: 'Recently updated' },
  { value: 'created', label: 'Recently created' },
  { value: 'sku', label: 'SKU (A → Z)' },
  { value: 'name', label: 'Name (A → Z)' },
  { value: 'price-asc', label: 'Price (low → high)' },
  { value: 'price-desc', label: 'Price (high → low)' },
  { value: 'stock-asc', label: 'Stock (low → high)' },
  { value: 'stock-desc', label: 'Stock (high → low)' },
]

export default function SortMenu({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t))
        return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0]

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 h-8 px-2.5 text-[12px] border border-slate-200 rounded-md bg-white text-slate-700 hover:bg-slate-50"
      >
        <ArrowUpDown className="w-3.5 h-3.5" />
        {current.label}
      </button>
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full mt-1 w-56 bg-white border border-slate-200 rounded-lg shadow-lg z-30 py-1"
          role="menu"
        >
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
              className={cn(
                'w-full flex items-center justify-between px-3 py-1.5 text-[12px] text-left',
                o.value === value
                  ? 'bg-blue-50 text-blue-800'
                  : 'text-slate-700 hover:bg-slate-50',
              )}
            >
              <span>{o.label}</span>
              {o.value === value && <Check className="w-3 h-3" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
