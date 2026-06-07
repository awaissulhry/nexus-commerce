'use client'

// MM.5 — Customize the Amazon matrix slot-columns: show/hide + reorder.
// Draft state; commits on Save. MAIN is always shown (Amazon requires it).

import { useState } from 'react'
import { X, ChevronUp, ChevronDown, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SLOT_LABELS, type AmazonSlot } from './useAmazonImages'
import type { ColPref } from './useMatrixColumnPrefs'

export function MatrixColumnsModal({
  prefs,
  onSave,
  onReset,
  onClose,
}: {
  prefs: ColPref[]
  onSave: (next: ColPref[]) => void
  onReset: () => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<ColPref[]>(prefs)

  function toggle(slot: AmazonSlot) {
    if (slot === 'MAIN') return // required column
    setDraft((d) => d.map((p) => (p.slot === slot ? { ...p, visible: !p.visible } : p)))
  }
  function move(idx: number, dir: -1 | 1) {
    setDraft((d) => {
      const next = [...d]
      const j = idx + dir
      if (j < 0 || j >= next.length) return d
      ;[next[idx], next[j]] = [next[j]!, next[idx]!]
      return next
    })
  }

  const visibleCount = draft.filter((p) => p.visible).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">Customize columns</span>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          Show, hide and reorder the Amazon slot-columns (e.g. hide PS once done). MAIN is always shown.
        </p>

        <div className="space-y-1 mb-3 max-h-80 overflow-y-auto">
          {draft.map((p, idx) => (
            <div key={p.slot} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800">
              <input
                type="checkbox"
                checked={p.visible}
                disabled={p.slot === 'MAIN'}
                onChange={() => toggle(p.slot)}
                className="accent-orange-600"
              />
              <span className="flex-1 text-sm text-slate-700 dark:text-slate-200">
                <span className="font-mono text-xs text-slate-500 dark:text-slate-400 mr-1.5">{p.slot}</span>
                {SLOT_LABELS[p.slot] ?? p.slot}
              </span>
              <button type="button" onClick={() => move(idx, -1)} disabled={idx === 0} title="Move up" className="text-slate-400 hover:text-slate-600 disabled:opacity-30">
                <ChevronUp className="w-4 h-4" />
              </button>
              <button type="button" onClick={() => move(idx, 1)} disabled={idx === draft.length - 1} title="Move down" className="text-slate-400 hover:text-slate-600 disabled:opacity-30">
                <ChevronDown className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => { onReset(); onClose() }} className="text-slate-500 gap-1.5">
            <RotateCcw className="w-3.5 h-3.5" /> Reset
          </Button>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => { onSave(draft); onClose() }} disabled={visibleCount === 0}>Save</Button>
        </div>
      </div>
    </div>
  )
}
