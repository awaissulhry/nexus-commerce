'use client'

import { useEffect, useRef } from 'react'
import { Filter } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FilterState } from '../lib/types'

// Re-export with the historical name so call sites that imported
// `FilterValue` keep compiling.
export type FilterValue = FilterState

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: FilterState
  onChange: (next: FilterState) => void
  onReset: () => void
  activeCount: number
  /** T.5 — productTypes seen in the loaded data, for the productType
   *  multi-select. */
  availableProductTypes: string[]
}

const STATUS_OPTIONS = ['ACTIVE', 'DRAFT', 'INACTIVE'] as const
const CHANNEL_OPTIONS = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE'] as const
const STOCK_OPTIONS: Array<{
  value: FilterState['stockLevel']
  label: string
}> = [
  { value: 'all', label: 'All' },
  { value: 'out', label: 'Out of stock (= 0)' },
  { value: 'low', label: 'Low stock (1–5)' },
  { value: 'in', label: 'In stock (> 0)' },
]
const PARENTAGE_OPTIONS: Array<{
  value: FilterState['parentage']
  label: string
}> = [
  { value: 'any', label: 'Any' },
  { value: 'parent', label: 'Master / parent only' },
  { value: 'variant', label: 'Variants only' },
]
const TRISTATE_OPTIONS: Array<{
  value: 'any' | 'yes' | 'no'
  label: string
}> = [
  { value: 'any', label: 'Any' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
]

export default function FilterDropdown({
  open,
  onOpenChange,
  value,
  onChange,
  onReset,
  activeCount,
  availableProductTypes,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) {
        return
      }
      onOpenChange(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onOpenChange(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onOpenChange])

  const toggleArrayValue = (
    key: 'status' | 'channels' | 'productTypes',
    v: string,
  ) => {
    const arr = value[key]
    const next = arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]
    onChange({ ...value, [key]: next })
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        className={cn(
          'inline-flex items-center gap-1.5 h-7 px-2 text-[11px] border rounded-md transition-colors',
          activeCount > 0
            ? 'border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100'
            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900',
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Filter className="w-3 h-3" />
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
          className="absolute right-0 top-full mt-1 w-80 max-h-[80vh] overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg z-30"
          role="dialog"
        >
          <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
              Filters
            </span>
            <button
              type="button"
              onClick={onReset}
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
                  onChange={() => toggleArrayValue('status', s)}
                  label={s}
                />
              ))}
            </Section>

            <Section label="Sync channel">
              {CHANNEL_OPTIONS.map((c) => (
                <Check
                  key={c}
                  checked={value.channels.includes(c)}
                  onChange={() => toggleArrayValue('channels', c)}
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

            {availableProductTypes.length > 0 && (
              <Section
                label={`Product type (${availableProductTypes.length})`}
              >
                <div className="max-h-32 overflow-y-auto space-y-0.5">
                  {availableProductTypes.map((pt) => (
                    <Check
                      key={pt}
                      checked={value.productTypes.includes(pt)}
                      onChange={() => toggleArrayValue('productTypes', pt)}
                      label={pt}
                      mono
                    />
                  ))}
                </div>
              </Section>
            )}

            <Section label="Parentage">
              {PARENTAGE_OPTIONS.map((opt) => (
                <Radio
                  key={opt.value}
                  checked={value.parentage === opt.value}
                  onChange={() =>
                    onChange({ ...value, parentage: opt.value })
                  }
                  label={opt.label}
                />
              ))}
            </Section>

            <Section label="Has Amazon ASIN">
              <div className="flex items-center gap-3">
                {TRISTATE_OPTIONS.map((opt) => (
                  <Radio
                    key={opt.value}
                    checked={value.hasAsin === opt.value}
                    onChange={() =>
                      onChange({ ...value, hasAsin: opt.value })
                    }
                    label={opt.label}
                    inline
                  />
                ))}
              </div>
            </Section>

            <Section label="Has GTIN / UPC / EAN">
              <div className="flex items-center gap-3">
                {TRISTATE_OPTIONS.map((opt) => (
                  <Radio
                    key={opt.value}
                    checked={value.hasGtin === opt.value}
                    onChange={() =>
                      onChange({ ...value, hasGtin: opt.value })
                    }
                    label={opt.label}
                    inline
                  />
                ))}
              </div>
            </Section>

            <Section label="Required-field readiness">
              <Check
                checked={value.missingRequired}
                onChange={() =>
                  onChange({
                    ...value,
                    missingRequired: !value.missingRequired,
                  })
                }
                label="Only show rows with at least one required field unfilled"
              />
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
  mono,
}: {
  checked: boolean
  onChange: () => void
  label: string
  mono?: boolean
}) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-slate-700 cursor-pointer hover:text-slate-900">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
      />
      <span className={mono ? 'font-mono text-[11px]' : undefined}>{label}</span>
    </label>
  )
}

function Radio({
  checked,
  onChange,
  label,
  inline,
}: {
  checked: boolean
  onChange: () => void
  label: string
  inline?: boolean
}) {
  return (
    <label
      className={cn(
        'flex items-center gap-2 text-[12px] text-slate-700 cursor-pointer hover:text-slate-900',
        inline && 'inline-flex',
      )}
    >
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
