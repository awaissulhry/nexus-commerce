'use client'

/**
 * CD.5 — Contextual recommendations panel (the headline differentiator).
 *
 * Pulls the campaign-scoped /advertising/insights (NEGATIVE_KW / HIGH_ACOS /
 * LOW_ACOS) and turns each into an actionable card. Negative-keyword cards
 * negate wasteful queries in one click (through the cockpit's existing
 * addNegative handler → the create/approval path); ACOS cards deep-link to
 * the relevant tab. Refetches when `refreshKey` changes (live events).
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, TrendingDown, TrendingUp, Sparkles, Check, ChevronRight } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface NegItem { query: string; matchType: string; adProduct: string; marketplace: string; clicks: number; costEur: number }
interface AcosItem { name: string; adProduct: string; marketplace: string; acos: number; spendEur: number }
interface Insight {
  type: 'NEGATIVE_KW' | 'HIGH_ACOS' | 'LOW_ACOS' | 'STALE_CAMPAIGN'
  severity: 'critical' | 'warning' | 'info'
  title: string
  description: string
  count: number
  totalSpendCents: number
  items: Array<NegItem | AcosItem>
}

const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100)
const eurUnits = (v: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(v)

const SEVERITY: Record<string, { ring: string; chip: string; Icon: typeof AlertTriangle }> = {
  critical: { ring: 'border-rose-200 dark:border-rose-900/60', chip: 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300', Icon: AlertTriangle },
  warning:  { ring: 'border-amber-200 dark:border-amber-900/60', chip: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300', Icon: TrendingDown },
  info:     { ring: 'border-blue-200 dark:border-blue-900/60', chip: 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300', Icon: TrendingUp },
}

export function CampaignRecommendations({
  campaignId, onNegate, onGoToTab, refreshKey,
}: {
  campaignId: string
  onNegate: (query: string) => Promise<void>
  onGoToTab: (tab: 'targeting' | 'searchterms' | 'settings') => void
  refreshKey?: number
}) {
  const [insights, setInsights] = useState<Insight[] | null>(null)
  const [negated, setNegated] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await fetch(`${getBackendUrl()}/api/advertising/insights?campaignId=${campaignId}&windowDays=30`, { cache: 'no-store' })
      .then((x) => x.json()).catch(() => ({ insights: [] }))
    setInsights(r.insights ?? [])
  }, [campaignId])
  useEffect(() => { void load() }, [load, refreshKey])

  const negate = useCallback(async (query: string) => {
    setBusy(query)
    try {
      await onNegate(query)
      setNegated((s) => new Set(s).add(query))
    } finally { setBusy(null) }
  }, [onNegate])

  const negateAll = useCallback(async (items: NegItem[]) => {
    for (const it of items) {
      if (negated.has(it.query)) continue
      await negate(it.query)
    }
  }, [negate, negated])

  if (insights == null) return <div className="mb-4 rounded-lg border border-default dark:border-slate-800 p-3 text-sm text-tertiary">Loading recommendations…</div>
  if (insights.length === 0) return null

  return (
    <div className="mb-4 space-y-2">
      <div className="flex items-center gap-1.5 text-sm font-medium text-slate-700 dark:text-slate-200">
        <Sparkles size={15} className="text-violet-500" /> Recommendations
        <span className="text-xs font-normal text-tertiary">· last 30 days</span>
      </div>
      {insights.map((ins, i) => {
        const sev = SEVERITY[ins.severity] ?? SEVERITY.info
        const SevIcon = sev.Icon
        return (
          <div key={i} className={`rounded-lg border ${sev.ring} bg-white dark:bg-slate-950 p-3`}>
            <div className="flex items-start gap-2">
              <span className={`mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md ${sev.chip}`}><SevIcon size={14} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{ins.title}</span>
                  {ins.totalSpendCents > 0 && <span className="text-xs text-tertiary">{eur(ins.totalSpendCents)} at stake</span>}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{ins.description}</p>

                {ins.type === 'NEGATIVE_KW' && (
                  <div className="mt-2 space-y-1">
                    {(ins.items as NegItem[]).map((it) => {
                      const done = negated.has(it.query)
                      return (
                        <div key={it.query} className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate"><span className="font-medium text-slate-700 dark:text-slate-200">{it.query}</span> <span className="text-tertiary">· {it.clicks} clicks · {eurUnits(it.costEur)}</span></span>
                          <button onClick={() => negate(it.query)} disabled={done || busy === it.query}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border flex-shrink-0 ${done ? 'border-emerald-300 text-emerald-600 dark:border-emerald-800' : 'border-rose-300 text-rose-600 hover:bg-rose-50 dark:border-rose-800 dark:hover:bg-rose-950/40'} disabled:opacity-50`}>
                            {done ? <><Check size={11} /> Negated</> : busy === it.query ? 'Negating…' : '⊘ Negate'}
                          </button>
                        </div>
                      )
                    })}
                    {(ins.items as NegItem[]).some((it) => !negated.has(it.query)) && (
                      <button onClick={() => negateAll(ins.items as NegItem[])} disabled={busy != null}
                        className="mt-1 text-xs font-medium text-rose-600 hover:underline disabled:opacity-50">Negate all {ins.items.length} ↓</button>
                    )}
                  </div>
                )}

                {(ins.type === 'HIGH_ACOS' || ins.type === 'LOW_ACOS') && (
                  <button onClick={() => onGoToTab(ins.type === 'LOW_ACOS' ? 'settings' : 'targeting')}
                    className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline">
                    {ins.type === 'LOW_ACOS' ? 'Scale this campaign (bids / budget)' : 'Tune bids & add negatives'} <ChevronRight size={12} />
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
