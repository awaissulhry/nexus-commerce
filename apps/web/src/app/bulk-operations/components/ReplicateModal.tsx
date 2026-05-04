'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { MarketplaceContext, MarketplaceOption } from './MarketplaceSelector'

interface Props {
  open: boolean
  onClose: () => void
  /** Product ids the action is scoped to. Caller decides whether
   *  they're "selected rows", "filter result", or "everything visible";
   *  the modal just trusts the count. */
  productIds: string[]
  scopeLabel: string
  options: MarketplaceOption[]
  /** Called after a successful replicate so the grid can refresh
   *  hydrated _channelListing data. */
  onReplicated: () => void
}

/** AA.1 — copy listing values from a source marketplace to one or
 *  more targets across many products at once. The big use case is
 *  "I edited title + description + price on AMAZON:IT for these
 *  products; replicate to AMAZON:DE/FR/ES + EBAY:IT in one go." */
export default function ReplicateModal({
  open,
  onClose,
  productIds,
  scopeLabel,
  options,
  onReplicated,
}: Props) {
  const [source, setSource] = useState<MarketplaceContext | null>(null)
  const [targets, setTargets] = useState<MarketplaceContext[]>([])
  const [columnsOnly, setColumnsOnly] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{
    replicated: number
    skipped: number
    errors: Array<{ productId: string; channel: string; marketplace: string; error: string }>
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setSource(null)
      setTargets([])
      setColumnsOnly(false)
      setSubmitting(false)
      setResult(null)
      setError(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, submitting, onClose])

  // Group options by channel for the dropdown sections.
  const byChannel = useMemo(() => {
    const m = new Map<MarketplaceOption['channel'], MarketplaceOption[]>()
    for (const o of options) {
      const arr = m.get(o.channel) ?? []
      arr.push(o)
      m.set(o.channel, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => a.code.localeCompare(b.code))
    return Array.from(m.entries())
  }, [options])

  const sourceKey = source ? `${source.channel}:${source.marketplace}` : null

  const toggleTarget = (ctx: MarketplaceContext) => {
    setTargets((prev) => {
      const k = `${ctx.channel}:${ctx.marketplace}`
      const has = prev.some(
        (t) => `${t.channel}:${t.marketplace}` === k,
      )
      return has
        ? prev.filter((t) => `${t.channel}:${t.marketplace}` !== k)
        : [...prev, ctx]
    })
  }

  // Source can't double as a target — filter it out and render disabled.
  const targetsByChannel = byChannel.map(([ch, list]) => [
    ch,
    list.filter(
      (o) =>
        sourceKey === null ||
        `${o.channel}:${o.code}` !== sourceKey,
    ),
  ]) as Array<[MarketplaceOption['channel'], MarketplaceOption[]]>

  const valid =
    source !== null && targets.length > 0 && productIds.length > 0

  const handleSubmit = async () => {
    if (!valid || submitting) return
    setSubmitting(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/bulk-replicate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productIds: productIds.slice(0, 1000),
            sourceContext: source,
            targetContexts: targets,
            columnsOnly,
          }),
        },
      )
      const json = await res.json()
      if (!res.ok) {
        throw new Error(json?.error ?? `HTTP ${res.status}`)
      }
      setResult({
        replicated: json.replicated ?? 0,
        skipped: json.skippedNoSource ?? 0,
        errors: json.errors ?? [],
      })
      if ((json.replicated ?? 0) > 0) onReplicated()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 backdrop-blur-sm pt-[5vh] px-4"
      role="dialog"
      aria-modal="true"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="bg-white rounded-lg shadow-xl border border-slate-200 w-[640px] max-w-[92vw] flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h2 className="text-[15px] font-semibold text-slate-900">
            Replicate marketplace data
          </h2>
          <button
            type="button"
            onClick={() => !submitting && onClose()}
            className="text-slate-400 hover:text-slate-700"
            disabled={submitting}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <p className="text-[12px] text-slate-600">
            Pull listing values (title, description, bullet points,
            price, stock, attributes) from a source marketplace and
            replicate them to one or more targets across{' '}
            <strong className="tabular-nums">{productIds.length}</strong>{' '}
            {scopeLabel}.
          </p>

          {/* Source */}
          <Section title="Source marketplace">
            <div className="space-y-2">
              {byChannel.map(([channel, list]) => (
                <div key={channel}>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                    {channel === 'AMAZON' ? 'Amazon' : 'eBay'}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {list.map((o) => {
                      const k = `${o.channel}:${o.code}`
                      const active = sourceKey === k
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() =>
                            setSource({
                              channel: o.channel,
                              marketplace: o.code,
                            })
                          }
                          className={cn(
                            'h-7 px-2 text-[11px] font-mono border rounded transition-colors',
                            active
                              ? 'bg-blue-50 border-blue-500 text-blue-900'
                              : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50',
                          )}
                        >
                          {o.code}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* Arrow visual */}
          <div className="flex items-center justify-center text-slate-400">
            <ArrowRight className="w-4 h-4" />
          </div>

          {/* Targets */}
          <Section
            title={`Target marketplaces (${targets.length} selected)`}
          >
            <div className="space-y-2">
              {targetsByChannel.map(([channel, list]) => {
                const channelTargets = targets.filter((t) => t.channel === channel)
                const allSelected =
                  list.length > 0 && channelTargets.length === list.length
                return (
                  <div key={channel}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                        {channel === 'AMAZON' ? 'Amazon' : 'eBay'}
                      </span>
                      {list.length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setTargets((prev) => {
                              const others = prev.filter(
                                (t) => t.channel !== channel,
                              )
                              return allSelected
                                ? others
                                : [
                                    ...others,
                                    ...list.map((o) => ({
                                      channel: o.channel,
                                      marketplace: o.code,
                                    })),
                                  ]
                            })
                          }}
                          className="text-[10px] text-blue-600 hover:underline"
                        >
                          {allSelected ? 'Clear' : 'All'}
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {list.length === 0 ? (
                        <span className="text-[11px] text-slate-400 italic">
                          source disabled
                        </span>
                      ) : (
                        list.map((o) => {
                          const k = `${o.channel}:${o.code}`
                          const active = targets.some(
                            (t) =>
                              `${t.channel}:${t.marketplace}` === k,
                          )
                          return (
                            <button
                              key={k}
                              type="button"
                              onClick={() =>
                                toggleTarget({
                                  channel: o.channel,
                                  marketplace: o.code,
                                })
                              }
                              className={cn(
                                'h-7 px-2 text-[11px] font-mono border rounded transition-colors',
                                active
                                  ? 'bg-emerald-50 border-emerald-500 text-emerald-900'
                                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50',
                              )}
                            >
                              {o.code}
                            </button>
                          )
                        })
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </Section>

          {/* Options */}
          <Section title="Options">
            <label className="flex items-start gap-2 text-[12px] text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={columnsOnly}
                onChange={(e) => setColumnsOnly(e.target.checked)}
                className="mt-0.5 w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span>
                <span className="font-medium">Columns only</span> — copy
                title / description / bullet points / price / stock,
                skip attributes entirely. EE.5 — cross-channel copies
                (Amazon ↔ eBay) automatically map well-known concepts
                (brand, color, size, material, mpn, style, pattern,
                manufacturer) when this is off; non-overlapping
                attributes are dropped silently.
              </span>
            </label>
          </Section>

          {/* Result / error */}
          {result && (
            <div className="text-[12px] bg-emerald-50 border border-emerald-200 rounded px-3 py-2 inline-flex items-start gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-emerald-600" />
              <div>
                <div className="text-emerald-800">
                  Replicated to{' '}
                  <strong className="tabular-nums">
                    {result.replicated}
                  </strong>{' '}
                  listing{result.replicated === 1 ? '' : 's'}.
                </div>
                {result.skipped > 0 && (
                  <div className="text-amber-700 mt-1">
                    Skipped{' '}
                    <strong className="tabular-nums">{result.skipped}</strong>{' '}
                    {result.skipped === 1 ? 'product' : 'products'} with no
                    source listing on {sourceKey}.
                  </div>
                )}
                {result.errors.length > 0 && (
                  <div className="text-rose-700 mt-1">
                    {result.errors.length} target
                    {result.errors.length === 1 ? '' : 's'} failed (see
                    console).
                  </div>
                )}
              </div>
            </div>
          )}
          {error && (
            <div className="text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2 inline-flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <div>{error}</div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-slate-200">
          <span className="text-[11px] text-slate-500 tabular-nums">
            {productIds.length} {scopeLabel} ×{' '}
            {targets.length || '0'} target
            {targets.length === 1 ? '' : 's'} ={' '}
            <strong className="text-slate-700">
              {productIds.length * targets.length}
            </strong>{' '}
            listing write{productIds.length * targets.length === 1 ? '' : 's'}
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => !submitting && onClose()}
              disabled={submitting}
            >
              {result ? 'Close' : 'Cancel'}
            </Button>
            {!result && (
              <Button
                variant="primary"
                size="sm"
                onClick={handleSubmit}
                disabled={!valid || submitting}
                loading={submitting}
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    Replicating…
                  </>
                ) : (
                  `Replicate to ${targets.length}`
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
        {title}
      </div>
      {children}
    </div>
  )
}
