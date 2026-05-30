'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

/**
 * RX.S1 — shared timeframe picker (presets + custom from/to).
 *
 * Day-level presets for sales/replenishment views. Built reusable
 * (configurable `presets`) so other surfaces — including the /orders date
 * filter — can adopt it rather than maintaining parallel copies. Theme-aware
 * (light + dark) to match the app shell.
 */
export interface TimeframePreset {
  key: string
  label: string
}

export interface TimeframeValue {
  /** One of the preset keys, or '' when a custom range is active. */
  preset: string
  /** YYYY-MM-DD when a custom range is active. */
  from?: string
  to?: string
}

export const SALES_PRESETS: TimeframePreset[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7', label: 'Last 7 days' },
  { key: '10', label: 'Last 10 days' },
  { key: '30', label: 'Last 30 days' },
  { key: '60', label: 'Last 60 days' },
  { key: '90', label: 'Last 90 days' },
]

export function timeframeLabel(
  value: TimeframeValue,
  presets: TimeframePreset[] = SALES_PRESETS,
): string {
  if (value.from && value.to) return `${value.from} → ${value.to}`
  if (value.from) return `from ${value.from}`
  if (value.to) return `to ${value.to}`
  return presets.find((p) => p.key === value.preset)?.label ?? 'Last 30 days'
}

export function TimeframePicker({
  value,
  onChange,
  presets = SALES_PRESETS,
  labelPrefix = 'Sales',
}: {
  value: TimeframeValue
  onChange: (next: TimeframeValue) => void
  presets?: TimeframePreset[]
  labelPrefix?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const current = timeframeLabel(value, presets)

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 items-center gap-1.5 rounded border border-slate-200 px-3 text-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
      >
        <span className="text-slate-500 dark:text-slate-400">{labelPrefix}:</span>
        <span className="font-medium text-slate-900 dark:text-slate-100">{current}</span>
        <ChevronDown
          size={12}
          className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
        />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 space-y-1 rounded-md border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {presets.map((p) => {
            const active = !value.from && !value.to && value.preset === p.key
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => {
                  onChange({ preset: p.key, from: undefined, to: undefined })
                  setOpen(false)
                }}
                className={`w-full rounded px-2 py-1.5 text-left text-sm ${
                  active
                    ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                    : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'
                }`}
              >
                {p.label}
              </button>
            )
          })}
          <div className="space-y-1.5 border-t border-slate-200 pt-2 dark:border-slate-700">
            <div className="px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Custom range
            </div>
            <div className="flex items-center gap-1">
              <input
                type="date"
                defaultValue={value.from}
                onChange={(e) =>
                  onChange({ preset: '', from: e.target.value || undefined, to: value.to })
                }
                className="h-7 flex-1 rounded border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                aria-label="Start date"
              />
              <span className="text-slate-400">→</span>
              <input
                type="date"
                defaultValue={value.to}
                onChange={(e) =>
                  onChange({ preset: '', from: value.from, to: e.target.value || undefined })
                }
                className="h-7 flex-1 rounded border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                aria-label="End date"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
