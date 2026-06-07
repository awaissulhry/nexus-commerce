'use client'

// CM.1 — Copy-to-markets picker. Collects target markets; the parent does the
// actual copy (buildCrossMarketUpserts → addPendingUpsert). Staged only.

import { useState } from 'react'
import { X, Copy } from 'lucide-react'
import { AMAZON_MARKETPLACES, type AmazonMarketplace } from './useAmazonImages'
import { SHARED_TARGET } from './crossMarketCopy'

export function CopyToMarketsModal({
  sourceMarketplace,
  whatLabel,
  onConfirm,
  onClose,
}: {
  sourceMarketplace: AmazonMarketplace
  /** e.g. "all images" or "PT03" — what's being copied. */
  whatLabel: string
  onConfirm: (targets: string[]) => void
  onClose: () => void
}) {
  const others = AMAZON_MARKETPLACES.filter((m) => m !== sourceMarketplace)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const toggle = (m: string) =>
    setSel((s) => {
      const n = new Set(s)
      if (n.has(m)) n.delete(m)
      else n.add(m)
      return n
    })
  const targets = [...sel]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            Copy {whatLabel} → other markets
          </span>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          From <b>Amazon {sourceMarketplace}</b>. Replaces the same slot(s) at each target, in the same placement.
          Staged as draft — <b>Save</b>, then <b>Publish to Amazon</b>.
        </p>

        <div className="space-y-1 mb-3 max-h-56 overflow-y-auto">
          <label className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer text-sm">
            <input type="checkbox" checked={sel.has(SHARED_TARGET)} onChange={() => toggle(SHARED_TARGET)} className="rounded" />
            <span className="font-medium">All Markets (shared)</span>
            <span className="text-[11px] text-slate-400">applies to every market</span>
          </label>
          {others.map((m) => (
            <label key={m} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer text-sm">
              <input type="checkbox" checked={sel.has(m)} onChange={() => toggle(m)} className="rounded" />
              <span>Amazon {m}</span>
            </label>
          ))}
        </div>

        <button
          type="button"
          disabled={targets.length === 0}
          onClick={() => onConfirm(targets)}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-orange-600 hover:bg-orange-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          <Copy className="w-4 h-4" />
          Copy to {targets.length || ''} market{targets.length === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  )
}
