'use client'

/**
 * Apex F.3 — beginner Autopilot cockpit.
 *
 * One north star → a plain-language plan you can read and trust → one-click
 * apply. Glass-box: every line says what changes and why; nothing touches a
 * live bid until you press Apply, and even then only allowlisted campaigns are
 * written (the rest are reported as skipped).
 */

import { useCallback, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

type Mode = 'profit' | 'balanced' | 'growth'

interface Action { kind: 'bid' | 'top_of_search'; scope: string; summary: string; deltaLabel: string; basis: string }
interface Plan {
  northStar: { mode: Mode; label: string }
  headline: string
  counts: { bidChanges: number; topOfSearchChanges: number }
  actions: Action[]
}
interface ApplyResult {
  bid: { applied: number; skippedNotAllowlisted: number }
  topOfSearch: { applied: number; skippedNotAllowlisted: number; evaluated: number }
}

const NORTH_STARS: Array<{ mode: Mode; title: string; blurb: string }> = [
  { mode: 'profit', title: 'Maximize profit', blurb: 'Spend conservatively — keep more of each sale as profit.' },
  { mode: 'balanced', title: 'Balanced', blurb: 'A middle ground between profit and growth.' },
  { mode: 'growth', title: 'Grow aggressively', blurb: 'Spend up to break-even to win volume and rank.' },
]

export function AutopilotClient() {
  const [mode, setMode] = useState<Mode>('profit')
  const [marketplace, setMarketplace] = useState('IT')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [err, setErr] = useState('')
  const [applied, setApplied] = useState<ApplyResult | null>(null)

  const qs = useCallback(() => {
    const p = new URLSearchParams({ mode })
    if (marketplace.trim()) p.set('marketplace', marketplace.trim().toUpperCase())
    return p.toString()
  }, [mode, marketplace])

  const preview = useCallback(async () => {
    setLoading(true); setErr(''); setApplied(null); setPlan(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autopilot/simulate?${qs()}`, { cache: 'no-store' }).then((x) => x.json())
      if (r?.error) throw new Error(r.error)
      setPlan(r as Plan)
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }, [qs])

  const apply = useCallback(async () => {
    if (!plan) return
    if (!confirm('Apply this plan? Bids are written live to allowlisted campaigns only; everything else is skipped.')) return
    setApplying(true); setErr('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autopilot/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, marketplace: marketplace.trim().toUpperCase() || undefined }),
      }).then((x) => x.json())
      if (r?.error || r?.ok === false) throw new Error(r.error || 'apply failed')
      setApplied(r as ApplyResult)
      await preview() // refresh the plan post-apply
    } catch (e) { setErr((e as Error).message) } finally { setApplying(false) }
  }, [plan, mode, marketplace, preview])

  return (
    <div className="max-w-[820px] mx-auto space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">Autopilot</h1>
        <p className="text-sm text-slate-500">Pick one goal. Autopilot tunes bids toward each product’s profit-based target, handles low-data keywords sensibly, and defends your top-of-search slots — and shows you exactly what it would do before anything goes live.</p>
      </div>

      {/* North star */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {NORTH_STARS.map((n) => (
          <button
            key={n.mode}
            onClick={() => { setMode(n.mode); setPlan(null); setApplied(null) }}
            className={`text-left rounded-lg border p-3 transition ${mode === n.mode ? 'border-blue-500 ring-1 ring-blue-500 bg-blue-50/60 dark:bg-blue-950/30' : 'border-default dark:border-slate-700 hover:border-slate-300'}`}
            aria-pressed={mode === n.mode}
          >
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{n.title}</div>
            <div className="text-xs text-slate-500 mt-0.5">{n.blurb}</div>
          </button>
        ))}
      </div>

      <div className="flex items-end gap-3">
        <label className="text-xs text-slate-500 flex flex-col">Marketplace
          <input value={marketplace} onChange={(e) => setMarketplace(e.target.value)} placeholder="all" className="mt-0.5 w-24 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />
        </label>
        <button onClick={() => void preview()} disabled={loading} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{loading ? 'Previewing…' : 'Preview plan'}</button>
        {plan && (plan.counts.bidChanges + plan.counts.topOfSearchChanges > 0) && (
          <button onClick={() => void apply()} disabled={applying} className="px-3 py-1.5 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">{applying ? 'Applying…' : 'Apply plan'}</button>
        )}
      </div>

      {err && <div className="text-sm text-rose-600">{err}</div>}

      {applied && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300">
          ✓ Applied — bids: {applied.bid.applied} written{applied.bid.skippedNotAllowlisted > 0 ? `, ${applied.bid.skippedNotAllowlisted} skipped (not allowlisted)` : ''}; top-of-search: {applied.topOfSearch.applied} written{applied.topOfSearch.skippedNotAllowlisted > 0 ? `, ${applied.topOfSearch.skippedNotAllowlisted} skipped` : ''}.
        </div>
      )}

      {/* The plan */}
      {plan && (
        <div className="rounded-lg border border-default dark:border-slate-700">
          <div className="px-3 py-2.5 border-b border-subtle dark:border-slate-800">
            <div className="text-sm font-medium text-slate-800 dark:text-slate-100">{plan.headline}</div>
            <div className="text-xs text-slate-500 mt-0.5">North star: {plan.northStar.label} · {plan.counts.bidChanges} bid change(s), {plan.counts.topOfSearchChanges} top-of-search change(s)</div>
          </div>
          {plan.actions.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-tertiary">Nothing to change right now.</div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {plan.actions.map((a, i) => (
                <li key={i} className="px-3 py-2 flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2">
                    <span className={`mt-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded ${a.kind === 'top_of_search' ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>{a.kind === 'top_of_search' ? 'ToS' : 'bid'}</span>
                    <span className="text-sm text-slate-700 dark:text-slate-200">{a.summary}</span>
                  </div>
                  <span className="text-xs tabular-nums text-slate-500 whitespace-nowrap">{a.deltaLabel}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="text-xs text-tertiary">Apply writes live bids only to campaigns on the live-write allowlist; all others are reported as skipped. Review the plan before applying.</p>
    </div>
  )
}
