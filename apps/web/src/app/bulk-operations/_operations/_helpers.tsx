'use client'

/**
 * W1.7 — shared form helpers used by every operation config in
 * BulkOperationModal. Lifted out of the 1,750-LOC modal monolith so
 * each operation config can be edited in isolation without
 * scrolling past the helpers every time.
 */

import * as React from 'react'

export const inputCls =
  'w-full h-7 px-2 text-base border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500'

export function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <div className="text-sm text-slate-600 mb-1">{label}</div>
      {children}
    </label>
  )
}

/**
 * E.7 — toggleable numeric override for MARKETPLACE_OVERRIDE_UPDATE.
 * "Apply this field" checkbox controls whether the field is included
 * in the bulk payload at all. When unchecked, the key is absent and
 * the backend leaves the column untouched.
 */
export function OverrideNumber({
  label,
  hint,
  field,
  payload,
  onToggle,
  onChange,
  integer,
}: {
  label: string
  hint?: string
  field: string
  payload: Record<string, unknown>
  onToggle: () => void
  onChange: (value: number | null) => void
  integer?: boolean
}) {
  const enabled = field in payload
  const raw = payload[field]
  const display = raw === null || raw === undefined ? '' : String(raw)
  return (
    <div className="border border-slate-200 rounded-md p-2">
      <label className="flex items-center gap-2 text-base text-slate-700 mb-1">
        <input type="checkbox" checked={enabled} onChange={onToggle} />
        <span className="font-medium">{label}</span>
      </label>
      {hint && (
        <div className="text-sm text-slate-500 mb-1.5 ml-5">{hint}</div>
      )}
      {enabled && (
        <input
          type="number"
          step={integer ? '1' : '0.01'}
          value={display}
          onChange={(e) => {
            if (e.target.value === '') {
              onChange(null)
              return
            }
            const v = integer
              ? parseInt(e.target.value, 10)
              : parseFloat(e.target.value)
            onChange(Number.isNaN(v) ? null : v)
          }}
          placeholder="(empty = clear override)"
          className={`${inputCls} ml-5`}
          style={{ width: 'calc(100% - 1.25rem)' }}
        />
      )}
    </div>
  )
}

export function BoolField({
  label,
  field,
  payload,
  onToggle,
  onChange,
}: {
  label: string
  field: string
  payload: Record<string, unknown>
  onToggle: () => void
  onChange: (value: boolean) => void
}) {
  const enabled = field in payload
  const value = enabled ? (payload[field] as boolean) : false
  return (
    <label className="flex items-center gap-2 text-base">
      <input type="checkbox" checked={enabled} onChange={onToggle} />
      <span className={enabled ? 'text-slate-800' : 'text-slate-500'}>
        {label}
      </span>
      {enabled && (
        <span className="ml-auto inline-flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onChange(true)}
            className={`h-5 px-2 text-xs uppercase tracking-wide font-medium rounded border ${
              value
                ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                : 'bg-white border-slate-200 text-slate-500'
            }`}
          >
            On
          </button>
          <button
            type="button"
            onClick={() => onChange(false)}
            className={`h-5 px-2 text-xs uppercase tracking-wide font-medium rounded border ${
              !value
                ? 'bg-rose-50 border-rose-300 text-rose-700'
                : 'bg-white border-slate-200 text-slate-500'
            }`}
          >
            Off
          </button>
        </span>
      )}
    </label>
  )
}
