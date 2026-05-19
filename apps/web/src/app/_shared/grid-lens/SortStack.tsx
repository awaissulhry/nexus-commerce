'use client'

import { useState } from 'react'

export interface SortFieldOption {
  /** Stable id used in the `field:dir` pair (e.g. "sku", "updatedAt"). */
  value: string
  /** Human-readable label shown in the picker + active chip. */
  label: string
}

export interface SortStackProps {
  /** Catalog of every sortable field. */
  fields: ReadonlyArray<SortFieldOption>
  /** Current sort stack as `field:dir` pairs ("sku:asc", "updatedAt:desc"). */
  stack: ReadonlyArray<string>
  onChange: (next: string[]) => void
  /** Hide the chip bar (show only the add button) — useful when caller renders the chips elsewhere. */
  hideChips?: boolean
  /** Hide the add button (show only the chip bar). */
  hideAddButton?: boolean
}

/**
 * Multi-column sort builder extracted from /products. One source for
 * "+ Sort" + active-sort-chip rendering so every grid workspace gets
 * the same UX. Operators can stack multiple sorts (the order in the
 * stack is the precedence) and flip each direction independently.
 *
 * Wire shape:
 *   <SortStack
 *     fields={SORT_FIELDS}
 *     stack={sortStack}
 *     onChange={(next) => updateUrl({ sorts: next.join(',') || undefined })}
 *   />
 */
export function SortStack({ fields, stack, onChange, hideChips, hideAddButton }: SortStackProps) {
  const stackArr = stack as string[]
  const removeAt = (idx: number) => onChange(stackArr.filter((_, i) => i !== idx))
  const flipDir = (idx: number) =>
    onChange(
      stackArr.map((p, i) => {
        if (i !== idx) return p
        const [field, dir] = p.split(':')
        return `${field}:${dir === 'desc' ? 'asc' : 'desc'}`
      }),
    )

  const labelByValue = new Map(fields.map((f) => [f.value, f.label]))

  return (
    <>
      {!hideChips && stackArr.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap text-sm">
          <span className="text-slate-500 dark:text-slate-400 uppercase tracking-wider font-semibold text-xs">
            Sorting by
          </span>
          {stackArr.map((pair, idx) => {
            const [field, dir] = pair.split(':')
            const label = labelByValue.get(field) ?? field
            return (
              <span
                key={`${pair}-${idx}`}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 rounded text-sm border border-blue-200 dark:border-blue-800"
              >
                <button
                  type="button"
                  onClick={() => flipDir(idx)}
                  className="inline-flex items-center gap-0.5 hover:underline"
                  title="Toggle ascending / descending"
                >
                  {idx > 0 && (
                    <span className="text-blue-500 dark:text-blue-400 text-xs mr-0.5">then</span>
                  )}
                  <span>{label}</span>
                  <span className="text-xs">{dir === 'desc' ? '↓' : '↑'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => removeAt(idx)}
                  aria-label={`Remove ${label} sort`}
                  className="ml-0.5 text-blue-500 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-100 inline-flex items-center justify-center w-3.5 h-3.5"
                >
                  ×
                </button>
              </span>
            )
          })}
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:underline ml-1"
          >
            clear
          </button>
        </div>
      )}
      {!hideAddButton && (
        <AddSortButton
          fields={fields}
          stack={stackArr}
          onAdd={(field, dir) => onChange([...stackArr, `${field}:${dir}`])}
        />
      )}
    </>
  )
}

function AddSortButton({
  fields, stack, onAdd,
}: {
  fields: ReadonlyArray<SortFieldOption>
  stack: string[]
  onAdd: (field: string, dir: 'asc' | 'desc') => void
}) {
  const [open, setOpen] = useState(false)
  const usedFields = new Set(stack.map((p) => p.split(':')[0]))
  const available = fields.filter((f) => !usedFields.has(f.value))

  if (available.length === 0) return null
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        title="Add a sort dimension"
        className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-800 rounded text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
      >
        + Sort
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute right-0 top-full mt-1 z-40 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md shadow-lg py-1 min-w-[200px] text-sm">
            <div className="px-3 py-1 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              Add sort by
            </div>
            {available.map((opt) => (
              <div
                key={opt.value}
                className="flex items-center justify-between px-2 py-0.5 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <span className="text-slate-700 dark:text-slate-300 px-1">{opt.label}</span>
                <span className="inline-flex">
                  <button
                    type="button"
                    onClick={() => { onAdd(opt.value, 'asc'); setOpen(false) }}
                    className="px-1.5 py-0.5 text-xs hover:bg-slate-200 dark:hover:bg-slate-700 rounded"
                    title="Ascending"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => { onAdd(opt.value, 'desc'); setOpen(false) }}
                    className="px-1.5 py-0.5 text-xs hover:bg-slate-200 dark:hover:bg-slate-700 rounded ml-0.5"
                    title="Descending"
                  >
                    ↓
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
