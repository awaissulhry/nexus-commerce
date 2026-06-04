'use client'

/**
 * FM.10 — edit-once catalog cascade drawer.
 *
 * "I changed master fields — show me everywhere that lands across channels
 * + markets, then apply." Previews via FM.5 (POST
 * /api/products/:id/mapping/propagate-preview) and applies via FM.6 (POST
 * /api/products/:id/mapping/apply): translate (both-synced) + enqueue
 * per-coordinate pushes on the 30s undo window + audit. Price fields are
 * handled by the pricing engine, so they're surfaced read-only.
 *
 * Distinct from CrossChannelMatrix (single-field copy FROM a source
 * coordinate); this cascades MASTER-attribute changes THROUGH the catalog
 * mapping rules to every mapped coordinate.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  X,
  Loader2,
  ArrowRight,
  AlertTriangle,
  Languages,
  Wand2,
  Scissors,
  CircleSlash,
} from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface Flags {
  transformed: boolean
  needsTranslation: boolean
  channelLimitTrimmed: boolean
  currencyMismatch: boolean
  unmappedRequired: boolean
}
interface Entry {
  channel: string
  marketplace: string
  fieldKey: string
  current: unknown
  proposed: unknown
  action: 'update' | 'skip' | 'unchanged'
  language: string | null
  flags: Flags
}
interface Plan {
  productId: string
  sku: string
  changedAttributes: string[]
  entries: Entry[]
  counts: {
    total: number
    willUpdate: number
    needsReview: number
    skipped: number
    currencyMismatch: number
    unmappedRequired: number
  }
}

interface Props {
  productId: string
  open: boolean
  onClose: () => void
  /** Master attribute → proposed value (e.g. { title, description, brand }). */
  changes: Record<string, unknown>
  /** Fired after a successful apply (caller should invalidate/refresh). */
  onApplied?: () => void
}

function fmt(v: unknown): string {
  if (v == null || v === '') return '∅'
  if (Array.isArray(v)) return v.join(' · ')
  return String(v)
}

function Chip({ label, tone }: { label: string; tone: 'emerald' | 'amber' | 'red' | 'sky' | 'zinc' }) {
  const tones: Record<string, string> = {
    emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    red: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    sky: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
    zinc: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  }
  return <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', tones[tone])}>{label}</span>
}

export default function CatalogCascadeDrawer({ productId, open, onClose, changes, onApplied }: Props) {
  const { toast } = useToast()
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchPreview = useCallback(async () => {
    if (!open || Object.keys(changes).length === 0) return
    setLoading(true)
    setError(null)
    setPlan(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/products/${productId}/mapping/propagate-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`)
      setPlan(data)
    } catch (e: any) {
      setError(e?.message ?? 'Preview failed')
    } finally {
      setLoading(false)
    }
  }, [open, productId, changes])

  useEffect(() => {
    void fetchPreview()
  }, [fetchPreview])

  const apply = useCallback(async () => {
    setApplying(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/products/${productId}/mapping/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes, reason: 'editor-cascade' }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`)
      const desc = [
        data.queuedCoordinates ? `${data.queuedCoordinates} coordinate(s)` : null,
        data.translatedLanguages?.length ? `${data.translatedLanguages.length} language(s) translated` : null,
        data.skippedPriceFields ? `${data.skippedPriceFields} price field(s) → pricing engine` : null,
      ]
        .filter(Boolean)
        .join(' · ')
      toast.success('Cascade queued', { description: desc || undefined })
      onApplied?.()
      onClose()
    } catch (e: any) {
      toast.error('Cascade failed', { description: e?.message })
    } finally {
      setApplying(false)
    }
  }, [productId, changes, onApplied, onClose, toast])

  if (!open) return null
  const entries = plan?.entries ?? []

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-2xl h-full flex flex-col bg-white dark:bg-zinc-950 border-l border-zinc-200 dark:border-zinc-800 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Cascade master changes to channels
            </h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              {plan
                ? `${plan.sku} · ${plan.changedAttributes.join(', ') || 'no attributes'}`
                : loading
                  ? 'Previewing the fan-out…'
                  : 'Edit-once → propagate'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* counts */}
        {plan && (
          <div className="px-4 py-2 border-b border-zinc-100 dark:border-zinc-800/60 flex flex-wrap items-center gap-1.5">
            <Chip tone="emerald" label={`${plan.counts.willUpdate} will update`} />
            {plan.counts.needsReview > 0 && <Chip tone="amber" label={`${plan.counts.needsReview} need review`} />}
            {plan.counts.currencyMismatch > 0 && <Chip tone="amber" label={`${plan.counts.currencyMismatch} currency-skipped`} />}
            {plan.counts.unmappedRequired > 0 && <Chip tone="red" label={`${plan.counts.unmappedRequired} required unmapped`} />}
            {plan.counts.total === 0 && <span className="text-[11px] text-zinc-400 italic">No coordinates affected.</span>}
          </div>
        )}

        {/* body */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex items-center justify-center py-16 text-zinc-500 text-sm">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Computing the fan-out…
            </div>
          )}
          {error && (
            <div className="m-1 p-3 rounded bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              {error}
            </div>
          )}
          {!loading && !error && entries.length === 0 && plan && (
            <div className="text-center py-16 text-zinc-400 text-sm italic">
              Nothing to cascade — no mapped coordinate's value changes.
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            {entries.map((e, i) => (
              <div
                key={i}
                className={cn(
                  'rounded border px-3 py-2 text-[11px]',
                  e.action === 'skip'
                    ? 'border-amber-200 dark:border-amber-900/40 bg-amber-50/40 dark:bg-amber-900/10'
                    : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950',
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-zinc-500">
                    {e.channel}/{e.marketplace}
                  </span>
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">{e.fieldKey}</span>
                  {e.language && <span className="text-[10px] text-zinc-400">{e.language}</span>}
                  <span className="ml-auto flex items-center gap-1">
                    {e.flags.transformed && (
                      <span title="A transform changed the value"><Wand2 className="w-3 h-3 text-sky-500" /></span>
                    )}
                    {e.flags.needsTranslation && (
                      <span title="Will be AI-translated, flagged for review"><Languages className="w-3 h-3 text-amber-500" /></span>
                    )}
                    {e.flags.channelLimitTrimmed && (
                      <span title="Trimmed to the channel field's max length"><Scissors className="w-3 h-3 text-amber-500" /></span>
                    )}
                    {e.flags.currencyMismatch && <Chip tone="amber" label="currency — skipped" />}
                    {e.flags.unmappedRequired && <Chip tone="red" label="required unmapped" />}
                    {e.action === 'skip' && !e.flags.currencyMismatch && (
                      <span title="Skipped"><CircleSlash className="w-3 h-3 text-zinc-400" /></span>
                    )}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-zinc-400 line-through break-all flex-1">{fmt(e.current)}</span>
                  <ArrowRight className="w-3 h-3 text-zinc-400 flex-shrink-0" />
                  <span className="text-zinc-900 dark:text-zinc-100 font-medium break-all flex-1">
                    {e.flags.needsTranslation ? <span className="italic text-amber-600 dark:text-amber-400">→ translated on apply</span> : fmt(e.proposed)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* footer */}
        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-3">
          <span className="text-[10px] text-zinc-500">
            Applies on a 30s undo window · price fields go through the pricing engine
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void apply()}
              disabled={applying || !plan || plan.counts.willUpdate === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
              Apply cascade{plan && plan.counts.willUpdate > 0 ? ` (${plan.counts.willUpdate})` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
