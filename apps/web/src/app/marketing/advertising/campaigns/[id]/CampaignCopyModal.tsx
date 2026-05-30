'use client'

/**
 * CD.10b — "Copy settings to…" bulk template.
 *
 * Applies this campaign's reliably-readable campaign-level settings (bidding
 * strategy, daily budget, placement bid adjustments) to one or more other
 * campaigns in the same marketplace, via the existing P8-gated PATCH endpoints
 * (/campaigns/:id + /campaigns/:id/placements). Structural copy (ad groups /
 * targets) is intentionally out of scope — that's "duplicate campaign", not a
 * settings template. Sandbox-first; live writes stay behind the P8 gate.
 */

import { useEffect, useState } from 'react'
import { X, Copy, Check } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Candidate { id: string; name: string; status: string; marketplace: string | null }

export function CampaignCopyModal({
  sourceId, sourceName, marketplace, biddingStrategy, dailyBudget, onClose,
}: {
  sourceId: string
  sourceName: string
  marketplace: string | null
  biddingStrategy: string // normalised: legacyForSales | autoForSales | manual
  dailyBudget: number
  onClose: () => void
}) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [placeAdjustments, setPlaceAdjustments] = useState<Array<{ placement: string; percentage: number }>>([])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [opts, setOpts] = useState({ bidding: true, budget: false, placements: true })
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Record<string, 'ok' | 'fail'>>({})

  useEffect(() => {
    void (async () => {
      const [cl, pl] = await Promise.all([
        fetch(`${getBackendUrl()}/api/advertising/campaigns?${marketplace ? `marketplace=${encodeURIComponent(marketplace)}&` : ''}limit=300`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ items: [] })),
        fetch(`${getBackendUrl()}/api/advertising/campaigns/${sourceId}/placements`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ placements: [] })),
      ])
      setCandidates((cl.items ?? []).filter((c: Candidate) => c.id !== sourceId))
      setPlaceAdjustments(((pl.placements ?? []) as Array<{ placement: string; adjustmentPct: number }>).map((p) => ({ placement: p.placement, percentage: Math.max(0, Math.min(900, Math.round(Number(p.adjustmentPct) || 0))) })))
    })()
  }, [sourceId, marketplace])

  const apply = async () => {
    setBusy(true)
    const res: Record<string, 'ok' | 'fail'> = {}
    for (const id of sel) {
      try {
        if (opts.bidding || opts.budget) {
          const body: Record<string, unknown> = {}
          if (opts.bidding) body.biddingStrategy = biddingStrategy
          if (opts.budget) body.dailyBudget = dailyBudget
          const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json())
          if (r?.error) throw new Error(r.error)
        }
        if (opts.placements && placeAdjustments.length > 0) {
          const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${id}/placements`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adjustments: placeAdjustments, biddingStrategy }) }).then((x) => x.json())
          if (r?.error) throw new Error(r.error)
        }
        res[id] = 'ok'
      } catch { res[id] = 'fail' }
      setResults({ ...res })
    }
    setBusy(false)
  }

  const okCount = Object.values(results).filter((v) => v === 'ok').length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[85vh] flex flex-col rounded-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <div className="text-sm font-medium text-slate-800 dark:text-slate-100 inline-flex items-center gap-1.5"><Copy size={14} /> Copy settings from <span className="text-slate-500">{sourceName}</span></div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>

        <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800">
          <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1.5">Which settings</div>
          <div className="flex flex-wrap gap-3 text-sm">
            {([['bidding', `Bidding strategy (${biddingStrategy})`], ['budget', `Daily budget (€${dailyBudget.toFixed(2)})`], ['placements', `Placement adjustments (${placeAdjustments.length})`]] as const).map(([k, label]) => (
              <label key={k} className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={opts[k]} onChange={(e) => setOpts((o) => ({ ...o, [k]: e.target.checked }))} /> {label}
              </label>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">Apply to {marketplace ?? 'all'} campaigns</div>
          {candidates == null ? <div className="py-6 text-center text-sm text-slate-400">Loading…</div>
            : candidates.length === 0 ? <div className="py-6 text-center text-sm text-slate-400">No other campaigns in this marketplace.</div>
            : candidates.map((c) => (
              <label key={c.id} className="flex items-center gap-2 py-1 text-sm">
                <input type="checkbox" checked={sel.has(c.id)} disabled={busy} onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n })} />
                <span className="flex-1 truncate text-slate-700 dark:text-slate-200">{c.name}</span>
                <span className="text-xs text-slate-400">{c.status}</span>
                {results[c.id] === 'ok' && <Check size={13} className="text-emerald-500" />}
                {results[c.id] === 'fail' && <X size={13} className="text-rose-500" />}
              </label>
            ))}
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 dark:border-slate-800">
          <span className="text-xs text-slate-500">{sel.size} selected{okCount > 0 ? ` · ${okCount} applied` : ''}</span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700">Close</button>
            <button onClick={apply} disabled={busy || sel.size === 0 || (!opts.bidding && !opts.budget && !opts.placements)} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{busy ? 'Applying…' : `Apply to ${sel.size}`}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
