'use client'

/**
 * AU.7 — Real-time automation activity feed.
 * Shows what the automation engine has actually done — live, with rule names and outcomes.
 */

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle, XCircle, FlaskConical, RefreshCw, Clock } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface FeedItem {
  id: string; ruleName: string; trigger: string; status: string
  dryRun: boolean; startedAt: string; durationMs: number | null
  summary: string; actionCount: number; successCount: number
}

const TRIGGER_SHORT: Record<string, string> = {
  SCHEDULE: '⏱', KEYWORD_ZERO_IMPRESSIONS: '🔇', KEYWORD_LOW_CTR: '📉',
  CVR_DROP: '📊', KEYWORD_WASTED_SPEND: '🗑️', SEARCH_TERM_CONVERTING: '🎯',
  FBA_AGE_THRESHOLD_REACHED: '📦', AD_SPEND_PROFITABILITY_BREACH: '💸',
  CAC_SPIKE: '🔴', AD_TARGET_UNDERPERFORMING: '📉', CAMPAIGN_PERFORMANCE_BUDGET: '💰',
}

export function ActivityFeedClient() {
  const [items, setItems] = useState<FeedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const load = useCallback(async () => {
    setErr('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation-feed?limit=40`, { cache: 'no-store' }).then((x) => x.json())
      setItems((r.items ?? []) as FeedItem[])
      setLastRefresh(new Date())
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load(); const id = setInterval(() => void load(), 60_000); return () => clearInterval(id) }, [load])

  if (loading) return <div className="text-xs text-tertiary px-1 py-3">Loading activity…</div>
  if (err) return <div className="text-xs text-rose-500 px-1 py-2">{err}</div>
  if (items.length === 0) return (
    <div className="text-xs text-tertiary px-1 py-4 text-center">No automation executions yet. Enable a rule to see activity here.</div>
  )

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Live activity</span>
        <button onClick={() => void load()} className="text-[10px] text-tertiary hover:text-slate-600 flex items-center gap-1">
          <RefreshCw className="h-3 w-3" />{lastRefresh ? `${Math.round((Date.now() - lastRefresh.getTime()) / 1000)}s ago` : ''}
        </button>
      </div>
      <div className="rounded-lg border border-default dark:border-slate-800 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800 max-h-80 overflow-y-auto">
        {items.map((item) => (
          <div key={item.id} className="flex items-start gap-2.5 px-3 py-2 bg-white dark:bg-slate-900">
            <div className="mt-0.5 shrink-0">
              {item.dryRun ? <FlaskConical className="h-3.5 w-3.5 text-amber-400" />
                : item.status === 'SUCCESS' ? <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                : item.status === 'FAILED' ? <XCircle className="h-3.5 w-3.5 text-rose-500" />
                : <Clock className="h-3.5 w-3.5 text-tertiary" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-medium text-slate-800 dark:text-slate-100 truncate max-w-[200px]">{item.ruleName}</span>
                <span className="text-[10px] text-tertiary">{TRIGGER_SHORT[item.trigger] ?? item.trigger}</span>
                {item.dryRun && <span className="text-[10px] text-amber-500 font-medium">dry-run</span>}
              </div>
              <div className="text-[11px] text-slate-500 truncate">{item.summary}</div>
            </div>
            <div className="text-[10px] text-tertiary shrink-0 text-right">
              <div>{new Date(item.startedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>
              {item.durationMs && <div className="text-slate-300">{item.durationMs}ms</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
