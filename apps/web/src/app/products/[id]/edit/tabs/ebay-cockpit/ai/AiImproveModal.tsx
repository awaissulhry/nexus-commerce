'use client'

// EC.12 — AiImproveModal
//
// Reusable diff modal that fires AI improve, shows per-field current
// vs proposed values, and lets the operator selectively apply some
// or all suggestions. Two operations supported:
//
//   • essentials — title + description (returns flat fields)
//   • aspects    — Record<aspectId, value> (returns map of fills)
//
// Apply only fires the parent's onApply callback with the
// operator-selected subset, so the cards stay in control of how the
// values plug back in (the essentials card pushes through the Field
// Source System, the aspects card writes to its dirtyValues buffer).

import { useEffect, useState } from 'react'
import { Sparkles, X, Loader2, Check, ArrowRight, TrendingUp } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

type Operation = 'essentials' | 'aspects'

interface EssentialsResponse {
  title: string
  description: string
  rationale?: string
  projectedUplift?: string
}

interface AspectsResponse {
  aspects: Record<string, string>
  rationale?: string
  projectedUplift?: string
}

interface Props {
  open: boolean
  operation: Operation
  productId: string
  marketplace: string
  /** Current values shown on the "before" side. */
  currentEssentials?: { title: string; description: string }
  currentAspects?: Record<string, string>
  /** When operator clicks Apply on essentials. Receives only the
   *  fields they toggled to "apply". Skipped fields are absent. */
  onApplyEssentials?: (next: Partial<{ title: string; description: string }>) => void
  /** When operator clicks Apply on aspects. Only includes aspects
   *  they kept toggled. */
  onApplyAspects?: (next: Record<string, string>) => void
  onClose: () => void
}

export default function AiImproveModal({
  open,
  operation,
  productId,
  marketplace,
  currentEssentials,
  currentAspects,
  onApplyEssentials,
  onApplyAspects,
  onClose,
}: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [essentials, setEssentials] = useState<EssentialsResponse | null>(null)
  const [aspectsResp, setAspectsResp] = useState<AspectsResponse | null>(null)
  const [keep, setKeep] = useState<Record<string, boolean>>({})

  // Fetch on open.
  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    setEssentials(null)
    setAspectsResp(null)
    setKeep({})
    ;(async () => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/ebay/cockpit/ai-improve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation, productId, marketplace }),
        })
        const json = await res.json()
        if (!res.ok) {
          setError(json?.error ?? `HTTP ${res.status}`)
        } else if (operation === 'essentials') {
          setEssentials(json)
          // Default: keep everything that differs.
          setKeep({
            title: json.title !== currentEssentials?.title,
            description: json.description !== currentEssentials?.description,
          })
        } else {
          setAspectsResp(json)
          // Default: keep everything (AI only sends what it was confident about).
          const defaultKeep: Record<string, boolean> = {}
          for (const k of Object.keys(json.aspects ?? {})) defaultKeep[k] = true
          setKeep(defaultKeep)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    })()
    // Reload happens on operation/productId/marketplace change too.
  }, [open, operation, productId, marketplace, currentEssentials?.title, currentEssentials?.description])

  // ESC closes.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !loading) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, loading, onClose])

  if (!open) return null

  const handleApply = () => {
    if (operation === 'essentials' && essentials) {
      const out: Partial<{ title: string; description: string }> = {}
      if (keep.title) out.title = essentials.title
      if (keep.description) out.description = essentials.description
      onApplyEssentials?.(out)
    } else if (operation === 'aspects' && aspectsResp) {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(aspectsResp.aspects ?? {})) {
        if (keep[k]) out[k] = v
      }
      onApplyAspects?.(out)
    }
    onClose()
  }

  const keptCount = Object.values(keep).filter(Boolean).length
  const upliftText = essentials?.projectedUplift ?? aspectsResp?.projectedUplift
  const rationaleText = essentials?.rationale ?? aspectsResp?.rationale

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm"
      onClick={() => !loading && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-improve-title"
        className="w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col rounded-lg border border-default dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-subtle dark:border-slate-800 flex items-center justify-between">
          <div>
            <div id="ai-improve-title" className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-500" />
              AI improve — {operation === 'essentials' ? 'Title & Description' : 'Aspects'}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Claude-backed suggestions for eBay {marketplace}. Review per field before applying.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="p-1 text-tertiary hover:text-slate-700 dark:hover:text-slate-200 rounded"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {loading && (
            <div className="text-xs text-slate-500 flex items-center gap-2 py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Thinking…
            </div>
          )}
          {error && (
            <div className="text-xs px-3 py-2 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}

          {!loading && upliftText && (
            <div className="px-3 py-2 rounded border border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/30 text-xs text-emerald-800 dark:text-emerald-200 flex items-center gap-1.5">
              <TrendingUp className="w-3.5 h-3.5" />
              <span className="font-medium">{upliftText}</span>
              {rationaleText && <span className="text-emerald-700/80 dark:text-emerald-300/80 ml-2">— {rationaleText}</span>}
            </div>
          )}

          {!loading && operation === 'essentials' && essentials && currentEssentials && (
            <>
              <DiffRow
                label="Title"
                kept={!!keep.title}
                onToggle={(b) => setKeep((k) => ({ ...k, title: b }))}
                current={currentEssentials.title}
                next={essentials.title}
                isLong={false}
              />
              <DiffRow
                label="Description"
                kept={!!keep.description}
                onToggle={(b) => setKeep((k) => ({ ...k, description: b }))}
                current={currentEssentials.description}
                next={essentials.description}
                isLong
              />
            </>
          )}

          {!loading && operation === 'aspects' && aspectsResp && (
            <>
              {Object.keys(aspectsResp.aspects ?? {}).length === 0 ? (
                <div className="text-xs text-slate-500 italic py-4">
                  AI didn&apos;t find any aspects it could fill with confidence.
                  Try adding more detail to the master description first.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {Object.entries(aspectsResp.aspects).map(([id, val]) => {
                    const current = currentAspects?.[id]
                    const kept = !!keep[id]
                    return (
                      <label
                        key={id}
                        className={cn(
                          'flex items-start gap-2 px-2.5 py-2 rounded border cursor-pointer transition-colors',
                          kept
                            ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20'
                            : 'border-default dark:border-slate-800',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={kept}
                          onChange={(e) => setKeep((k) => ({ ...k, [id]: e.target.checked }))}
                          className="mt-0.5 w-3.5 h-3.5"
                        />
                        <div className="flex-1 min-w-0 text-xs">
                          <div className="font-mono text-[10.5px] text-slate-500 dark:text-slate-400">
                            {id.replace(/^aspect_/, '').replace(/_/g, ' ')}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            {current ? (
                              <span className="text-slate-500 line-through font-mono">{current}</span>
                            ) : (
                              <span className="text-tertiary italic">(empty)</span>
                            )}
                            <ArrowRight className="w-3 h-3 text-tertiary flex-shrink-0" />
                            <span className="font-mono text-emerald-700 dark:text-emerald-300">{val}</span>
                          </div>
                        </div>
                      </label>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-4 py-3 border-t border-subtle dark:border-slate-800 flex items-center justify-end gap-2">
          <span className="text-[10.5px] text-tertiary mr-auto">
            {operation === 'essentials' ? 'ESC to cancel' : `${keptCount} aspect${keptCount === 1 ? '' : 's'} selected`}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium rounded border border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={loading || error != null || keptCount === 0}
            className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Check className="w-3 h-3" />
            Apply{operation === 'aspects' && keptCount > 0 ? ` ${keptCount}` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}

function DiffRow({
  label, kept, onToggle, current, next, isLong,
}: {
  label: string
  kept: boolean
  onToggle: (b: boolean) => void
  current: string
  next: string
  isLong: boolean
}) {
  const unchanged = current === next
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={kept}
            disabled={unchanged}
            onChange={(e) => onToggle(e.target.checked)}
            className="w-3.5 h-3.5"
          />
          Apply {label}
          {unchanged && <span className="text-[10px] text-tertiary ml-1">(unchanged)</span>}
        </label>
      </div>
      <div className={cn('grid gap-2', isLong ? 'grid-cols-1' : 'grid-cols-2')}>
        <div className="space-y-1">
          <div className="text-[10.5px] uppercase tracking-wide text-tertiary font-medium">Current</div>
          <div className="rounded border border-default dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 p-2 text-xs whitespace-pre-wrap break-words font-mono text-slate-700 dark:text-slate-300 min-h-[2.5rem]">
            {current || <em className="not-italic text-tertiary">(empty)</em>}
          </div>
        </div>
        <div className="space-y-1">
          <div className="text-[10.5px] uppercase tracking-wide text-blue-600 dark:text-blue-400 font-medium">AI suggestion</div>
          <div className={cn(
            'rounded border p-2 text-xs whitespace-pre-wrap break-words font-mono min-h-[2.5rem]',
            unchanged
              ? 'border-default dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-slate-500'
              : 'border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/30 text-blue-900 dark:text-blue-200',
          )}>
            {next || <em className="not-italic text-tertiary">(empty)</em>}
          </div>
        </div>
      </div>
    </div>
  )
}
