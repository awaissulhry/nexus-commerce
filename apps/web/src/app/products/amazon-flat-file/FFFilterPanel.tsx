'use client'

import { useEffect, useRef } from 'react'
import { Filter, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface FFFilterState {
  parentage: 'any' | 'parent' | 'variant'
  hasAsin: 'any' | 'yes' | 'no'
  missingRequired: boolean
}

export const FF_FILTER_DEFAULT: FFFilterState = {
  parentage: 'any',
  hasAsin: 'any',
  missingRequired: false,
}

export function ffFilterActiveCount(f: FFFilterState): number {
  let n = 0
  if (f.parentage !== 'any') n++
  if (f.hasAsin !== 'any') n++
  if (f.missingRequired) n++
  return n
}

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  value: FFFilterState
  onChange: (next: FFFilterState) => void
}

const PARENTAGE_OPTS = [
  { value: 'any' as const,     label: 'Any' },
  { value: 'parent' as const,  label: 'Parent rows only' },
  { value: 'variant' as const, label: 'Variant / child rows only' },
]
const ASIN_OPTS = [
  { value: 'any' as const, label: 'Any' },
  { value: 'yes' as const, label: 'Has ASIN' },
  { value: 'no'  as const, label: 'No ASIN' },
]

export function FFFilterPanel({ open, onOpenChange, value, onChange }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef   = useRef<HTMLDivElement>(null)
  const activeCount = ffFilterActiveCount(value)

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return
      if (panelRef.current?.contains(e.target as Node)) return
      onOpenChange(false)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open, onOpenChange])

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        className={cn(
          'inline-flex items-center gap-1.5 h-7 px-2 text-xs border rounded-md transition-colors',
          activeCount > 0
            ? 'border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
            : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700',
        )}
        title="Row filters"
      >
        <Filter className="w-3 h-3" />
        Filter
        {activeCount > 0 && (
          <span className="text-[10px] tabular-nums bg-blue-600 text-white rounded px-1 leading-none py-0.5">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full mt-1 w-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-30"
        >
          <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Row filters
            </span>
            <div className="flex items-center gap-2">
              {activeCount > 0 && (
                <button
                  type="button"
                  onClick={() => onChange(FF_FILTER_DEFAULT)}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200"
                >
                  Reset
                </button>
              )}
              <button type="button" onClick={() => onOpenChange(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="p-3 space-y-3">
            <Section label="Parentage">
              {PARENTAGE_OPTS.map((o) => (
                <Radio
                  key={o.value}
                  checked={value.parentage === o.value}
                  onChange={() => onChange({ ...value, parentage: o.value })}
                  label={o.label}
                />
              ))}
            </Section>

            <Section label="Has Amazon ASIN">
              <div className="flex items-center gap-4">
                {ASIN_OPTS.map((o) => (
                  <Radio
                    key={o.value}
                    checked={value.hasAsin === o.value}
                    onChange={() => onChange({ ...value, hasAsin: o.value })}
                    label={o.label}
                    inline
                  />
                ))}
              </div>
            </Section>

            <Section label="Required-field readiness">
              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={value.missingRequired}
                  onChange={() => onChange({ ...value, missingRequired: !value.missingRequired })}
                  className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                Only rows with empty required fields
              </label>
            </Section>
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">{label}</div>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function Radio({ checked, onChange, label, inline }: { checked: boolean; onChange: () => void; label: string; inline?: boolean }) {
  return (
    <label className={cn('flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer', inline && 'inline-flex')}>
      <input type="radio" checked={checked} onChange={onChange} className="w-3.5 h-3.5 border-slate-300 text-blue-600 focus:ring-blue-500" />
      {label}
    </label>
  )
}
