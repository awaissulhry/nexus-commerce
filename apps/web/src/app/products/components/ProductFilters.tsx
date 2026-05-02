'use client'

import { useEffect, useRef, useState } from 'react'
import { Filter } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ProductFilterState {
  status: string[]
  channels: string[]
  stockLevel: 'all' | 'in' | 'low' | 'out'
}

interface Props {
  value: ProductFilterState
  onChange: (next: ProductFilterState) => void
}

const STATUS_OPTIONS = ['ACTIVE', 'DRAFT', 'INACTIVE'] as const
const CHANNEL_OPTIONS = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE'] as const
const STOCK_OPTIONS: Array<{
  value: ProductFilterState['stockLevel']
  label: string
}> = [
  { value: 'all', label: 'All' },
  { value: 'in', label: 'In stock (> 0)' },
  { value: 'low', label: 'Low stock (1–5)' },
  { value: 'out', label: 'Out of stock (= 0)' },
]

export default function ProductFilters({ value, onChange }: Props) {
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
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const activeCount =
    value.status.length +
    value.channels.length +
    (value.stockLevel !== 'all' ? 1 : 0)

  const toggle = (key: 'status' | 'channels', v: string) => {
    const arr = value[key]
    onChange({
      ...value,
      [key]: arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v],
    })
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1.5 h-8 px-2.5 text-[12px] border rounded-md transition-colors bg-white',
          activeCount > 0
            ? 'border-blue-300 text-blue-800 hover:bg-blue-50'
            : 'border-slate-200 text-slate-700 hover:bg-slate-50',
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Filter className="w-3.5 h-3.5" />
        Filters
        {activeCount > 0 && (
          <span className="text-[10px] tabular-nums bg-blue-600 text-white rounded px-1">
            {activeCount}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full mt-1 w-72 bg-white border border-slate-200 rounded-lg shadow-lg z-30"
          role="dialog"
        >
          <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
              Filters
            </span>
            <button
              type="button"
              onClick={() =>
                onChange({ status: [], channels: [], stockLevel: 'all' })
              }
              disabled={activeCount === 0}
              className="text-[11px] text-blue-700 hover:text-blue-900 disabled:text-slate-400 disabled:cursor-default"
            >
              Reset all
            </button>
          </div>
          <div className="p-3 space-y-3">
            <Section label="Status">
              {STATUS_OPTIONS.map((s) => (
                <Check
                  key={s}
                  checked={value.status.includes(s)}
                  onChange={() => toggle('status', s)}
                  label={s}
                />
              ))}
            </Section>
            <Section label="Channel">
              {CHANNEL_OPTIONS.map((c) => (
                <Check
                  key={c}
                  checked={value.channels.includes(c)}
                  onChange={() => toggle('channels', c)}
                  label={c}
                />
              ))}
            </Section>
            <Section label="Stock level">
              {STOCK_OPTIONS.map((opt) => (
                <Radio
                  key={opt.value}
                  checked={value.stockLevel === opt.value}
                  onChange={() =>
                    onChange({ ...value, stockLevel: opt.value })
                  }
                  label={opt.label}
                />
              ))}
            </Section>
          </div>
        </div>
      )}
    </div>
  )
}

function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
        {label}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label: string
}) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-slate-700 cursor-pointer hover:text-slate-900">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
      />
      <span>{label}</span>
    </label>
  )
}

function Radio({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label: string
}) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-slate-700 cursor-pointer hover:text-slate-900">
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="w-3.5 h-3.5 border-slate-300 text-blue-600 focus:ring-blue-500"
      />
      <span>{label}</span>
    </label>
  )
}
