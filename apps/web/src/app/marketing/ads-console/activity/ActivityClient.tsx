'use client'

/**
 * Activity feed — real-time automation execution log (Phase 2).
 * SSE stream from /advertising/execution-events pushes every rule firing
 * as it happens. Reconnect-with-replay (?since=<ts>) fills gaps from
 * a 50-event / 5-min ring buffer. Falls back to polling on SSE error.
 * Each execution shows campaign deep links to both the internal console
 * and Amazon's Ads Console (via stored profileId).
 */

import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { Activity, RefreshCw, ExternalLink, Radio } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { campaignHref } from '../automation/useCampaignMap'
import { amazonCampaignHref } from '../_shared/amazonLinks'

interface Execution {
  id: string
  startedAt: string
  status: string
  dryRun: boolean
  durationMs: number | null
  triggerData: Record<string, unknown>
  actionResults: Array<{ type: string; ok: boolean }>
  rule: { id: string; name: string; trigger: string } | null
}

interface LiveEvent {
  type: string
  executionId: string
  ruleId: string
  ruleName: string
  trigger: string
  status: string
  dryRun: boolean
  durationMs: number | null
  marketplace: string | null
  campaignId: string | null
  campaignName: string | null
  externalCampaignId: string | null
  actionCount: number
  ts: number
}

const STATUS_COLOR: Record<string, string> = { SUCCESS: 'var(--green)', DRY_RUN: 'var(--navy)', FAILED: '#cc1100', PARTIAL: '#cc6a00', CAP_EXCEEDED: '#999' }
const relTime = (ts: number | string) => { const s = Math.floor((Date.now() - (typeof ts === 'string' ? new Date(ts).getTime() : ts)) / 1000); if (s < 5) return 'just now'; if (s < 60) return `${s}s ago`; const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; return `${Math.floor(h / 24)}d ago` }

function liveToExecution(e: LiveEvent): Execution {
  return {
    id: e.executionId,
    startedAt: new Date(e.ts).toISOString(),
    status: e.status,
    dryRun: e.dryRun,
    durationMs: e.durationMs,
    triggerData: { marketplace: e.marketplace, campaign: e.campaignId ? { id: e.campaignId, name: e.campaignName, externalCampaignId: e.externalCampaignId } : undefined },
    actionResults: Array.from({ length: e.actionCount }, () => ({ type: '', ok: true })),
    rule: { id: e.ruleId, name: e.ruleName, trigger: e.trigger },
  }
}

export function ActivityClient({ initial }: { initial: Execution[] }) {
  const searchParams = useSearchParams()

  const [items, setItems] = useState<Execution[]>(initial)
  const [loading, setLoading] = useState(false)
  const filter = (searchParams.get('filter') ?? 'all') as 'all' | 'live' | 'dry' | 'failed'
  const [connected, setConnected] = useState(false)
  const [todayCount, setTodayCount] = useState(0)
  const [profileMap, setProfileMap] = useState<Record<string, string>>({})
  const lastTs = useRef(Date.now())
  const esRef = useRef<EventSource | null>(null)

  // Load profileId map for Amazon links
  useEffect(() => {
    void fetch(`${getBackendUrl()}/api/advertising/connections`, { cache: 'no-store' })
      .then(r => r.json()).then(d => {
        const m: Record<string, string> = {}
        for (const c of (d.items ?? [])) m[c.marketplace] = c.profileId
        setProfileMap(m)
      }).catch(() => {})
  }, [])

  // SSE connection with reconnect-on-close + replay
  const connect = useCallback(() => {
    esRef.current?.close()
    const url = `${getBackendUrl()}/api/advertising/execution-events?since=${lastTs.current}`
    const es = new EventSource(url)
    esRef.current = es

    es.addEventListener('ping', () => setConnected(true))
    es.addEventListener('automation.rule.fired', (ev) => {
      try {
        const e = JSON.parse(ev.data) as LiveEvent
        lastTs.current = Math.max(lastTs.current, e.ts)
        const exec = liveToExecution(e)
        setItems(prev => [exec, ...prev].slice(0, 200))
        setTodayCount(c => c + 1)
      } catch { /* ignore */ }
    })
    es.onerror = () => {
      setConnected(false)
      es.close()
      // Back-off reconnect: 8s
      setTimeout(connect, 8_000)
    }
    return es
  }, [])

  useEffect(() => {
    const es = connect()
    return () => { es.close(); setConnected(false) }
  }, [connect])

  const reload = async () => {
    setLoading(true)
    try {
      const d = await fetch(`${getBackendUrl()}/api/advertising/automation-rule-executions?limit=100`, { cache: 'no-store' }).then(r => r.json())
      setItems(d.items ?? [])
    } finally { setLoading(false) }
  }

  const shown = useMemo(() => items.filter(x => {
    if (filter === 'live') return !x.dryRun && x.status !== 'FAILED' && x.status !== 'CAP_EXCEEDED'
    if (filter === 'dry') return x.dryRun
    if (filter === 'failed') return x.status === 'FAILED' || x.status === 'CAP_EXCEEDED'
    return true
  }), [items, filter])

  return (
    <div className="az-wrap">
      <div className="az-listhead">
        <span className="title"><Activity size={18} style={{ marginRight: 6, color: 'var(--orange)' }} />Activity</span>
        <span style={{ flex: 1 }} />
        {/* Live indicator */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: connected ? 'var(--green)' : 'var(--ink3)', marginRight: 8 }}>
          <Radio size={13} style={{ color: connected ? 'var(--green)' : 'var(--ink3)' }} />
          {connected ? 'Live' : 'Connecting…'}
          {todayCount > 0 && <span style={{ fontWeight: 700, color: 'var(--green)' }}>+{todayCount} new</span>}
        </span>
      </div>

      <div style={{ color: 'var(--ink2)', fontSize: 12.5, marginBottom: 14 }}>
        Every automation rule execution — what fired, what it did, and which campaign it touched. Updates in real time as rules run. Amazon links open the campaign directly in your Ads Console.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 14 }}>
        <button className="az-iconbtn" onClick={() => void reload()} title="Refresh"><RefreshCw size={15} className={loading ? 'az-spin' : ''} /></button>
      </div>

      {shown.length === 0 && (
        <div className="az-empty" style={{ border: '1px solid var(--divider)', borderRadius: 10 }}>
          {items.length === 0
            ? 'No automation executions yet. Enable a rule and let it fire — executions will appear here in real time.'
            : 'No executions match this filter.'}
        </div>
      )}

      {shown.map(x => {
        const ctx = x.triggerData as Record<string, unknown>
        const camp = ctx.campaign as Record<string, unknown> | undefined
        const localId = camp?.id as string | undefined
        const extId = camp?.externalCampaignId as string | undefined
        const mkt = (ctx.marketplace ?? camp?.marketplace) as string | undefined
        const campName = camp?.name as string | undefined
        const profileId = mkt ? profileMap[mkt] : undefined
        const amzHref = extId && profileId ? amazonCampaignHref(extId, profileId, mkt) : null
        const successActions = x.actionResults.filter(a => a.ok).length
        const failedActions = x.actionResults.filter(a => !a.ok).length

        return (
          <div key={x.id} className="az-rule" style={{ flexWrap: 'wrap', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
            {/* Status dot */}
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[x.status] ?? 'var(--ink3)', flexShrink: 0, marginTop: 5 }} />

            {/* Rule + trigger */}
            <div style={{ flex: '1 1 200px', minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.rule?.name ?? 'Unknown rule'}</div>
              <div style={{ color: 'var(--ink2)', fontSize: 11.5, marginTop: 2 }}>
                {(x.rule?.trigger ?? '').replace(/_/g, ' ')}
                {mkt && <span className="az-badge" style={{ marginLeft: 8 }}>{mkt}</span>}
              </div>
            </div>

            {/* Campaign links */}
            {(localId || campName) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, flexShrink: 0 }}>
                {localId && <a className="cn" href={campaignHref(localId)} target="_blank" rel="noopener noreferrer" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{campName ?? localId}</a>}
                {amzHref && (
                  <a href={amzHref} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--link)', textDecoration: 'none', fontWeight: 600, fontSize: 11.5 }}>
                    Open in Amazon <ExternalLink size={10} />
                  </a>
                )}
              </div>
            )}

            {/* Status + timing */}
            <div style={{ fontSize: 11.5, color: 'var(--ink2)', textAlign: 'right', flexShrink: 0, minWidth: 90 }}>
              <div style={{ fontWeight: 700, color: STATUS_COLOR[x.status] ?? 'var(--ink2)' }}>
                {x.status === 'DRY_RUN' ? 'Dry-run' : x.status === 'CAP_EXCEEDED' ? 'Cap hit' : x.status.toLowerCase()}
              </div>
              <div>{successActions} action{successActions !== 1 ? 's' : ''}{failedActions > 0 ? `, ${failedActions} failed` : ''}</div>
              <div title={new Date(x.startedAt).toLocaleString()}>{relTime(x.startedAt)}{x.durationMs ? ` · ${x.durationMs}ms` : ''}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
