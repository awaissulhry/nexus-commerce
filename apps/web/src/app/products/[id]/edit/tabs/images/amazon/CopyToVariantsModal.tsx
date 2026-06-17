'use client'

// VC — pick target variants (other colours / siblings) to replicate the selected
// images into. The parent does the actual copy (buildVariantCopyUpserts →
// addPendingUpsert). Staged only.

import { useState } from 'react'
import { X, Copy } from 'lucide-react'

export function CopyToVariantsModal({
  sourceLabel,
  targetOptions,
  onConfirm,
  onClose,
}: {
  /** e.g. "3 images" — what's being copied. */
  sourceLabel: string
  /** Variant-group values available as targets (excludes the source variants). */
  targetOptions: string[]
  onConfirm: (targetGroups: string[]) => void
  onClose: () => void
}) {
  const [sel, setSel] = useState<Set<string>>(new Set())
  const allChecked = targetOptions.length > 0 && targetOptions.every((g) => sel.has(g))
  const toggle = (g: string) =>
    setSel((s) => {
      const n = new Set(s)
      if (n.has(g)) n.delete(g)
      else n.add(g)
      return n
    })
  const toggleAll = () => setSel(allChecked ? new Set() : new Set(targetOptions))
  const targets = [...sel]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-default dark:border-slate-700 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">Copy {sourceLabel} → other variants</span>
          <button type="button" onClick={onClose} className="text-tertiary hover:text-slate-600 dark:hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          Replicates the selected images into the chosen variants, at the same slot. Staged as draft — <b>Save</b>, then <b>Publish</b>.
        </p>

        {targetOptions.length === 0 ? (
          <p className="px-2 py-3 text-xs text-tertiary">No other variants to copy to.</p>
        ) : (
          <div className="space-y-1 mb-3 max-h-56 overflow-y-auto">
            <label className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer text-sm">
              <input type="checkbox" checked={allChecked} onChange={toggleAll} className="rounded" />
              <span className="font-medium">All other variants</span>
            </label>
            {targetOptions.map((g) => (
              <label key={g} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer text-sm">
                <input type="checkbox" checked={sel.has(g)} onChange={() => toggle(g)} className="rounded" />
                <span>{g}</span>
              </label>
            ))}
          </div>
        )}

        <button
          type="button"
          disabled={targets.length === 0}
          onClick={() => onConfirm(targets)}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-orange-600 hover:bg-orange-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          <Copy className="w-4 h-4" />
          Copy to {targets.length || ''} variant{targets.length === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  )
}
