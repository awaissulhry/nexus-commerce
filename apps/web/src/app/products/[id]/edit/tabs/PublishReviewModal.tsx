'use client'

// OL.B — Publish Review modal.
//
// The one-action multi-channel publish step for the Listing Hub. Instead
// of firing blind, it first calls the read-only /publish-preflight to show,
// per coordinate: readiness (ready / blocked + reasons), the resolved
// title/price that would be sent, and the EFFECTIVE action — because the
// per-coordinate publish endpoint behaves differently per channel:
//   • Amazon  → SP-API submit, dry-run or live per AMAZON_PUBLISH_MODE
//   • eBay / Shopify → marks the listing active + queues an inventory sync
//     (NOT a content push — that stays the cockpit / flat-file job)
// Confirm publishes only the READY coordinates, with per-row progress,
// ✓/⚠/dry-run results, and Retry-failed. Honours the gating model
// (nothing here flips dry-run → live; that's still env-controlled).

import { useCallback, useEffect, useState } from 'react'
import { Loader2, CheckCircle2, AlertTriangle, Upload } from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

export interface PublishCoordinate {
  channel: string
  marketplace: string
}

interface PreflightCoord {
  channel: string
  marketplace: string
  status: 'ready' | 'blocked'
  action: 'amazon-live' | 'amazon-dry-run' | 'amazon-unconfigured' | 'mark-active'
  issues: { message: string; severity: 'ERROR' | 'WARNING' }[]
  resolved: {
    title: string | null
    price: number | null
    productType: string | null
    hasDescription: boolean
    quantity: number | null
  }
  listed: boolean
}

interface Preflight {
  amazonConfigured: boolean
  amazonDryRun: boolean
  coordinates: PreflightCoord[]
}

type RowResult = 'pending' | 'publishing' | 'ok' | 'dry-run' | 'failed'

interface PublishReviewModalProps {
  productId: string
  coordinates: PublishCoordinate[]
  open: boolean
  onClose: () => void
  /** Fired after a publish run completes (any outcome) so the Hub can refresh. */
  onPublished?: () => void
}

const CHANNEL_LABEL: Record<string, string> = {
  AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', WOOCOMMERCE: 'WooCommerce', ETSY: 'Etsy',
}

const coordKey = (c: { channel: string; marketplace: string }) => `${c.channel}:${c.marketplace}`

function actionMeta(action: PreflightCoord['action']): { label: string; cls: string } {
  switch (action) {
    case 'amazon-live':
      return { label: 'Live submit', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' }
    case 'amazon-dry-run':
      return { label: 'Dry-run', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300' }
    case 'amazon-unconfigured':
      return { label: 'Amazon not connected', cls: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300' }
    case 'mark-active':
    default:
      return { label: 'Activate + sync', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' }
  }
}

function fmtPrice(v: number | null, mp: string): string {
  if (v == null) return '—'
  const m = mp.toUpperCase()
  const sym = m === 'UK' || m === 'GB' ? '£' : m === 'US' ? '$' : '€'
  return `${sym}${v.toFixed(2)}`
}

export default function PublishReviewModal({
  productId,
  coordinates,
  open,
  onClose,
  onPublished,
}: PublishReviewModalProps) {
  const [preflight, setPreflight] = useState<Preflight | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [results, setResults] = useState<Record<string, RowResult>>({})
  const [done, setDone] = useState(false)

  // Stable identity for the selected set so a background re-render of the
  // Hub (e.g. an SSE reload) while the modal is open doesn't re-run the
  // effect and wipe in-progress publish results. We only re-preflight when
  // the actual set of coordinates changes.
  const coordsKey = coordinates.map(coordKey).sort().join('|')

  useEffect(() => {
    if (!open) return
    setPreflight(null)
    setError(null)
    setResults({})
    setDone(false)
    if (coordinates.length === 0) return
    let cancelled = false
    setLoading(true)
    fetch(`${getBackendUrl()}/api/products/${productId}/publish-preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: Preflight) => {
        if (!cancelled) setPreflight(j)
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? 'Preflight failed')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, productId, coordsKey])

  const readyCoords = preflight?.coordinates.filter((c) => c.status === 'ready') ?? []
  const blockedCount = (preflight?.coordinates.length ?? 0) - readyCoords.length

  const runPublish = useCallback(
    async (targets: PreflightCoord[]) => {
      if (targets.length === 0) return
      setPublishing(true)
      setResults((prev) => {
        const next = { ...prev }
        for (const c of targets) next[coordKey(c)] = 'pending'
        return next
      })
      await Promise.all(
        targets.map(async (c) => {
          const k = coordKey(c)
          setResults((r) => ({ ...r, [k]: 'publishing' }))
          try {
            const res = await fetch(
              `${getBackendUrl()}/api/products/${productId}/listings/${c.channel}/${c.marketplace}/publish`,
              { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
            )
            const body = await res.json().catch(() => null)
            const ok = res.ok && body?.ok !== false
            const dryRun = body?.status === 'DRY_RUN'
            setResults((r) => ({ ...r, [k]: ok ? (dryRun ? 'dry-run' : 'ok') : 'failed' }))
          } catch {
            setResults((r) => ({ ...r, [k]: 'failed' }))
          }
        }),
      )
      setPublishing(false)
      setDone(true)
      onPublished?.()
    },
    [productId, onPublished],
  )

  const failedCoords = readyCoords.filter((c) => results[coordKey(c)] === 'failed')
  const okCount = readyCoords.filter((c) => {
    const r = results[coordKey(c)]
    return r === 'ok' || r === 'dry-run'
  }).length

  return (
    <Modal open={open} onClose={onClose} title="Publish review" size="2xl">
      <ModalBody className="space-y-3">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Checking {coordinates.length} listing
            {coordinates.length !== 1 ? 's' : ''}…
          </div>
        )}
        {error && <div className="text-sm text-rose-600 dark:text-rose-400">{error}</div>}

        {preflight && (
          <>
            {/* Mode banner */}
            <div className="rounded-md border border-default dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 px-3 py-2 text-xs text-slate-600 dark:text-slate-400 space-y-0.5">
              <div>
                <span className="font-medium text-slate-700 dark:text-slate-300">Amazon:</span>{' '}
                {!preflight.amazonConfigured
                  ? 'not connected — Amazon coordinates can’t publish.'
                  : preflight.amazonDryRun
                    ? 'DRY-RUN — payload is validated, nothing goes live. Set AMAZON_PUBLISH_MODE=live to publish for real.'
                    : 'LIVE — changes submit to Amazon via SP-API.'}
              </div>
              <div>
                <span className="font-medium text-slate-700 dark:text-slate-300">eBay / Shopify:</span>{' '}
                marks the listing active and queues an inventory sync — content is published from the channel cockpit.
              </div>
            </div>

            {/* Per-coordinate rows */}
            <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-default dark:border-slate-800">
              {preflight.coordinates.map((c) => {
                const k = coordKey(c)
                const meta = actionMeta(c.action)
                const result = results[k]
                return (
                  <li key={k} className="px-3 py-2.5 flex items-start justify-between gap-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-800 dark:text-slate-200">
                          {CHANNEL_LABEL[c.channel] ?? c.channel}
                        </span>
                        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{c.marketplace}</span>
                        {c.status === 'ready' ? (
                          <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-medium', meta.cls)}>
                            {meta.label}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-medium bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                            <AlertTriangle aria-hidden className="h-3 w-3" /> Blocked
                          </span>
                        )}
                      </div>
                      {/* Resolved values */}
                      <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 truncate">
                        {c.resolved.title ?? '—'} · {fmtPrice(c.resolved.price, c.marketplace)}
                        {!c.resolved.hasDescription && <span className="text-amber-600 dark:text-amber-400"> · no description</span>}
                      </div>
                      {/* Blockers */}
                      {c.status === 'blocked' && (
                        <ul className="mt-1 space-y-0.5">
                          {c.issues.filter((i) => i.severity === 'ERROR').map((i, idx) => (
                            <li key={idx} className="text-[11px] text-rose-600 dark:text-rose-400">• {i.message}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {/* Result */}
                    <div className="flex-shrink-0 pt-0.5">
                      {result === 'publishing' && <Loader2 aria-hidden className="h-4 w-4 animate-spin text-tertiary" />}
                      {result === 'ok' && <CheckCircle2 aria-hidden className="h-4 w-4 text-emerald-500" />}
                      {result === 'dry-run' && <span className="text-[10.5px] font-medium text-amber-600 dark:text-amber-400">dry-run ✓</span>}
                      {result === 'failed' && <AlertTriangle aria-hidden className="h-4 w-4 text-rose-500" />}
                    </div>
                  </li>
                )
              })}
            </ul>

            {blockedCount > 0 && !done && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {blockedCount} blocked listing{blockedCount !== 1 ? 's' : ''} will be skipped.
              </div>
            )}
            {done && (
              <div className="text-sm text-slate-700 dark:text-slate-300">
                {okCount} published{failedCoords.length > 0 ? ` · ${failedCoords.length} failed` : ''}.
              </div>
            )}
          </>
        )}
      </ModalBody>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={publishing}>
          {done ? 'Close' : 'Cancel'}
        </Button>
        {!done ? (
          <Button
            variant="primary"
            icon={<Upload className="h-4 w-4" />}
            loading={publishing}
            disabled={loading || readyCoords.length === 0}
            onClick={() => void runPublish(readyCoords)}
          >
            Publish {readyCoords.length} ready
          </Button>
        ) : failedCoords.length > 0 ? (
          <Button
            variant="primary"
            loading={publishing}
            onClick={() => void runPublish(failedCoords)}
          >
            Retry {failedCoords.length} failed
          </Button>
        ) : null}
      </ModalFooter>
    </Modal>
  )
}
