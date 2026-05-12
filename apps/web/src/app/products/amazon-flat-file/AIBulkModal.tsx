'use client'

import { useState } from 'react'
import { Sparkles, X, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

interface Props {
  open: boolean
  onClose: () => void
  selectedProductIds: string[]
  marketplace: string
}

type ActionType = 'AI_TRANSLATE_PRODUCT' | 'AI_SEO_REGEN' | 'AI_ALT_TEXT'

const ACTIONS: Array<{
  type: ActionType
  label: string
  description: string
}> = [
  {
    type: 'AI_TRANSLATE_PRODUCT',
    label: 'Translate fields',
    description: 'Translate name, description and bullet points into the target market language.',
  },
  {
    type: 'AI_SEO_REGEN',
    label: 'SEO regen',
    description: 'Regenerate meta title and description optimised for Amazon search ranking.',
  },
  {
    type: 'AI_ALT_TEXT',
    label: 'Generate alt text',
    description: 'Generate accessibility alt text for product images that are missing it.',
  },
]

const MARKETPLACES = ['IT', 'DE', 'FR', 'ES', 'UK']

export function AIBulkModal({ open, onClose, selectedProductIds, marketplace }: Props) {
  const [action, setAction] = useState<ActionType>('AI_TRANSLATE_PRODUCT')
  const [targetLocales, setTargetLocales] = useState<string[]>([])
  const [skipReviewed, setSkipReviewed] = useState(true)
  const [onlyEmpty, setOnlyEmpty] = useState(true)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)

  if (!open) return null

  const toggleLocale = (mp: string) => {
    setTargetLocales((prev) =>
      prev.includes(mp) ? prev.filter((x) => x !== mp) : [...prev, mp],
    )
  }

  const handleRun = async () => {
    if (selectedProductIds.length === 0) return
    setRunning(true)
    setResult(null)
    try {
      const payload: Record<string, unknown> = { productIds: selectedProductIds }
      if (action === 'AI_TRANSLATE_PRODUCT') {
        payload.actionType = 'AI_TRANSLATE_PRODUCT'
        payload.targetLocales = targetLocales.length > 0 ? targetLocales : [marketplace]
        payload.skipAlreadyReviewed = skipReviewed
      } else if (action === 'AI_SEO_REGEN') {
        payload.actionType = 'AI_SEO_REGEN'
        payload.locales = targetLocales.length > 0 ? targetLocales : [marketplace]
      } else if (action === 'AI_ALT_TEXT') {
        payload.actionType = 'AI_ALT_TEXT'
        payload.onlyEmpty = onlyEmpty
      }

      const res = await fetch(`${getBackendUrl()}/api/bulk-operations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: action,
          productIds: selectedProductIds,
          actionPayload: payload,
          scope: 'custom',
          filters: {},
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setResult({ success: true, message: `Job queued for ${selectedProductIds.length} product${selectedProductIds.length !== 1 ? 's' : ''}. Check bulk operations for progress.` })
    } catch (e) {
      setResult({ success: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[480px] bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
            <Sparkles className="w-4 h-4 text-amber-500" />
            AI bulk actions
            <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
              {selectedProductIds.length} product{selectedProductIds.length !== 1 ? 's' : ''}
            </span>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Action picker */}
          <div className="space-y-1.5">
            {ACTIONS.map((a) => (
              <label
                key={a.type}
                className={cn(
                  'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                  action === a.type
                    ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-600'
                    : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50',
                )}
              >
                <input
                  type="radio"
                  name="ai-action"
                  checked={action === a.type}
                  onChange={() => setAction(a.type)}
                  className="mt-0.5 w-3.5 h-3.5 border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <div className="text-sm font-medium text-slate-800 dark:text-slate-100">{a.label}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{a.description}</div>
                </div>
              </label>
            ))}
          </div>

          {/* Action-specific options */}
          {(action === 'AI_TRANSLATE_PRODUCT' || action === 'AI_SEO_REGEN') && (
            <div>
              <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">Target markets</div>
              <div className="flex gap-1.5 flex-wrap">
                {MARKETPLACES.filter((mp) => mp !== marketplace).map((mp) => (
                  <button
                    key={mp}
                    type="button"
                    onClick={() => toggleLocale(mp)}
                    className={cn(
                      'text-xs px-2.5 py-1 rounded border font-medium transition-colors',
                      targetLocales.includes(mp)
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-slate-400',
                    )}
                  >
                    {mp}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1.5">
                Leave empty to use current market ({marketplace})
              </p>
            </div>
          )}

          {action === 'AI_TRANSLATE_PRODUCT' && (
            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={skipReviewed}
                onChange={() => setSkipReviewed((v) => !v)}
                className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              Skip products already reviewed in target language
            </label>
          )}

          {action === 'AI_ALT_TEXT' && (
            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={onlyEmpty}
                onChange={() => setOnlyEmpty((v) => !v)}
                className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              Only fill images that don't have alt text yet
            </label>
          )}

          {/* Result */}
          {result && (
            <div className={cn(
              'rounded-lg px-3 py-2 text-xs',
              result.success
                ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                : 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800',
            )}>
              {result.message}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-lg"
          >
            Close
          </button>
          <button
            type="button"
            disabled={running || selectedProductIds.length === 0}
            onClick={handleRun}
            className="h-8 px-4 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          >
            {running && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Run on {selectedProductIds.length} product{selectedProductIds.length !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
