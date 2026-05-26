'use client'

// FL.4.3 — Propagation diff modal (the "never silent" gate).
//
// Shows the planned fan-out per linked member: current → proposed, with a
// per-member checkbox. Unchanged / skip / not-yet-translated members are
// unchecked by default. The operator confirms which members to write;
// only then does the cockpit PUT each through the editor's endpoint.

import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PropagationEntryDto } from './useFieldLinks'

export interface PropagationDiffModalProps {
  open: boolean
  onClose: () => void
  fieldLabel: string
  entries: PropagationEntryDto[]
  translatable: boolean
  aiBudgetExceeded?: boolean
  busy?: boolean
  /** Glossary note, e.g. "Giacca→Giubbotto applied". */
  glossaryNote?: string
  onApply: (selected: PropagationEntryDto[]) => void
}

function coordKey(e: PropagationEntryDto) {
  return `${e.channel}:${e.marketplace}${e.variantId ? `:${e.variantId}` : ''}`
}

function defaultChecked(e: PropagationEntryDto): boolean {
  // Auto-check actionable, changing members; skip no-ops + untranslated.
  if (e.action === 'skip') return false
  if (e.unchanged) return false
  if (e.proposedValue == null) return false
  return true
}

export default function PropagationDiffModal({
  open,
  onClose,
  fieldLabel,
  entries,
  translatable,
  aiBudgetExceeded,
  busy,
  glossaryNote,
  onApply,
}: PropagationDiffModalProps) {
  const [checked, setChecked] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    setChecked(new Set(entries.filter(defaultChecked).map(coordKey)))
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const selectedCount = checked.size
  const toggle = (k: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  const apply = () => onApply(entries.filter((e) => checked.has(coordKey(e))))

  const hasActionable = useMemo(
    () => entries.some((e) => e.action !== 'skip' && !e.unchanged),
    [entries],
  )

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="presentation">
      <div className="absolute inset-0 bg-slate-900/40" onClick={busy ? undefined : onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Propagate ${fieldLabel}`}
        className="relative flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex items-start justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div>
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Propagate · {fieldLabel}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {translatable ? 'Cross-language members are AI-translated' : 'Copied verbatim'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {entries.length === 0 && (
            <div className="py-6 text-center text-sm text-slate-500">No linked members to update.</div>
          )}
          <ul className="space-y-1.5">
            {entries.map((e) => {
              const k = coordKey(e)
              const disabled = e.action === 'skip' || e.proposedValue == null
              return (
                <li
                  key={k}
                  className={cn(
                    'rounded-md border px-2.5 py-2 text-sm',
                    disabled
                      ? 'border-slate-100 opacity-60 dark:border-slate-800'
                      : 'border-slate-200 dark:border-slate-700',
                  )}
                >
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 rounded border-slate-300 dark:border-slate-600"
                      checked={checked.has(k)}
                      disabled={disabled}
                      onChange={() => toggle(k)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="font-medium text-slate-800 dark:text-slate-200">
                          {e.channel} {e.marketplace}
                        </span>
                        {e.action === 'translate' && (
                          <span className="text-[10px] text-sky-600 dark:text-sky-400">🤖 translated</span>
                        )}
                        {e.unchanged && <span className="text-[10px] text-slate-400">unchanged</span>}
                        {e.action === 'skip' && <span className="text-[10px] text-slate-400">skipped</span>}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-slate-400 line-through">
                        {e.currentValue ?? '—'}
                      </span>
                      <span className="block truncate text-xs text-slate-700 dark:text-slate-300">
                        {e.proposedValue ?? <span className="text-amber-500">translation unavailable</span>}
                      </span>
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
          {aiBudgetExceeded && (
            <div className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              AI translation budget reached — some members weren't translated.
            </div>
          )}
          {glossaryNote && (
            <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">{glossaryNote}</div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 dark:border-slate-800">
          <span className="text-xs text-slate-500">{selectedCount} selected</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={busy || selectedCount === 0 || !hasActionable}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
            >
              {busy ? 'Applying…' : `Apply to ${selectedCount}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
