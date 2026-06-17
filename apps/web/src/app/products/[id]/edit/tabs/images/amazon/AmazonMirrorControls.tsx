'use client'
// deploy-sync(image-mirror): touches apps/web so Vercel rebuilds the web app
// alongside the Railway API redeploy. Safe no-op marker.

// M6 — "Amazon Mirror" control. Additive panel (does not touch the matrix):
//   • Fill from gallery  → map the master gallery onto Amazon slots
//   • Preview            → mirror-diff (adds / replaces / REMOVES) vs live
//   • Publish to Amazon  → exact-mirror publish so Amazon == Nexus (same flow
//                          as the publish bar: save-first + poll + rollback)
// Backed by the M2–M6 engine. Surfaces the deletion count so the operator
// sees removals before publishing.

import { useState } from 'react'
import { Loader2, Sparkles, Eye, ShieldCheck, Copy } from 'lucide-react'
import { beFetch } from '../api'
import { AMAZON_MARKETPLACES, type AmazonMarketplace } from './useAmazonImages'

interface DiffTotals {
  adds: number
  replaces: number
  deletes: number
  asins: number
  skipped: number
}

export function AmazonMirrorControls({
  productId,
  marketplace,
  onReload,
  onCopyToMarkets,
}: {
  productId: string
  marketplace: AmazonMarketplace
  onReload: () => void
  /** CM — open the "copy this market → other markets" picker (active market only). */
  onCopyToMarkets?: () => void
}) {
  const [busy, setBusy] = useState<'fill' | 'preview' | null>(null)
  const [diff, setDiff] = useState<DiffTotals | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const target = marketplace === 'ALL' ? 'IT' : marketplace
  const scopeLabel = marketplace === 'ALL' ? `all EU markets (${AMAZON_MARKETPLACES.join(', ')})` : marketplace

  async function fill() {
    setBusy('fill'); setErr(null); setMsg(null)
    try {
      const res = await beFetch(`/api/products/${productId}/amazon-images/fill-from-gallery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d?.error ?? 'Fill failed')
      setMsg(`Mapped the gallery onto Amazon slots — ${d.created} set, ${d.skippedExisting} already assigned.`)
      setDiff(null)
      onReload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function preview() {
    setBusy('preview'); setErr(null); setMsg(null)
    try {
      const res = await beFetch(`/api/products/${productId}/amazon-images/mirror-diff?marketplace=${target}`)
      const d = await res.json()
      if (!res.ok) throw new Error(d?.error ?? 'Preview failed')
      setDiff((d.totals as DiffTotals) ?? null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-4 mt-4 rounded-xl border border-orange-200 dark:border-orange-900/50 bg-orange-50/60 dark:bg-orange-950/20 p-3">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck className="w-4 h-4 text-orange-600 dark:text-orange-400 flex-shrink-0" />
        <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Amazon images — Nexus is the source of truth
        </span>
      </div>
      <p className="text-xs text-slate-600 dark:text-slate-400 mb-2.5">
        Set up Amazon images here — fill from the gallery, preview the changes, copy across markets —
        then <b>Publish</b> from the bar below. Publishing makes Amazon match Nexus exactly (adds,
        reorders, removals) for {scopeLabel}.
      </p>

      {diff && (
        <div className="text-xs mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-emerald-700 dark:text-emerald-400">+{diff.adds} add</span>
          <span className="text-blue-700 dark:text-blue-400">~{diff.replaces} replace</span>
          <span className={diff.deletes > 0 ? 'text-rose-700 dark:text-rose-400 font-semibold' : 'text-slate-500'}>
            −{diff.deletes} remove
          </span>
          <span className="text-slate-500 dark:text-slate-400">· {diff.asins} ASIN{diff.asins === 1 ? '' : 's'}</span>
          {diff.skipped > 0 && (
            <span className="text-tertiary">· {diff.skipped} skipped (no main image)</span>
          )}
        </div>
      )}
      {msg && <div className="text-xs text-emerald-700 dark:text-emerald-400 mb-2">{msg}</div>}
      {err && <div className="text-xs text-rose-600 dark:text-rose-400 mb-2">{err}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={fill}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50"
        >
          {busy === 'fill' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          Fill from gallery
        </button>
        <button
          type="button"
          onClick={preview}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50"
        >
          {busy === 'preview' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
          Preview
        </button>
        {onCopyToMarkets && (
          <button
            type="button"
            onClick={onCopyToMarkets}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50"
          >
            <Copy className="w-3.5 h-3.5" /> Copy {marketplace} → markets
          </button>
        )}
      </div>
    </div>
  )
}
