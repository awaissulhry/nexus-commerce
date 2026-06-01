'use client'

/**
 * Activity feed — every automation rule execution with campaign deep links.
 * Phase 1: static load + refresh. Phase 2 wires SSE for live updates.
 */

import { useState, useMemo } from 'react'
import { Activity, RefreshCw, ExternalLink } from 'lucide-react'
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
  actionResults: Array<{ type: string; ok: boolean; output?: unknown; error?: string }>
  rule: { id: string; name: string; trigger: string } | null
}

const STATUS_COLOR: Record<string, string> = { SUCCESS: 'var(--green)', DRY_RUN: 'var(--navy)', FAILED: '#cc1100', PARTIAL: '#cc6a00' }
const relTime = (iso: string) => { const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000); if (s < 60) return 'just now'; const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; return `${Math.floor(h / 24)}d ago` }

function ctxCampaign(td: Record<string, unknown>): { localId?: string; externalId?: string; marketplace?: string } | null {
  const c = td.campaign as Record<string, unknown> | undefined
  if (c?.id) return { localId: String(c.id), externalId: c.externalCampaignId as string | undefined, marketplace: td.marketplace as string | undefined }
  return null
}

// We need profileId per marketplace for Amazon links. Load once from connections.
function useProfileMap() {
  const [map, setMap] = useState<Record<string, string>>({})
  useMemo(() => {
    void fetch(`${getBackendUrl()}/api/advertising/connections`, { cache: 'no-store' })
      .then(r => r.json()).then(d => {
        const m: Record<string, string> = {}
        for (const c of (d.items ?? [])) m[c.marketplace] = c.profileId
        setMap(m)
      }).catch(() => {})
  }, [])
  return map
}

export function ActivityClient({ initial }: { initial: Execution[] }) {
  const [items, setItems] = useState<Execution[]>(initial)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<'all' | 'live' | 'dry' | 'failed'>('all')
  const profileMap = useProfileMap()

  const reload = async () => {
    setLoading(true)
    try {
      const d = await fetch(`${getBackendUrl()}/api/advertising/automation-rule-executions?limit=100`, { cache: 'no-store' }).then(r => r.json())
      setItems(d.items ?? [])
    } finally { setLoading(false) }
  }

  const shown = useMemo(() => items.filter(x => {
    if (filter === 'live') return !x.dryRun && x.status !== 'FAILED'
    if (filter === 'dry') return x.dryRun
    if (filter === 'failed') return x.status === 'FAILED'
    return true
  }), [items, filter])

  return (
    <div className="az-wrap">
      <div className="az-listhead">
        <span className="title"><Activity size={18} style={{ marginRight: 6, color: 'var(--orange)' }} />Activity</span>
        <span style={{ flex: 1 }} />
      </div>

      <div style={{ color: 'var(--ink2)', fontSize: 12.5, marginBottom: 14 }}>
        Every automation rule execution — what fired, what it did, and which campaign it touched. Amazon links open the affected campaign directly in your Ads Console.
      </div>

      {/* Filters + refresh */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {(['all', 'live', 'dry', 'failed'] as const).map(f => (
          <button key={f} className={`az-chip quick ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? `All (${items.length})` : f === 'live' ? 'Live actions' : f === 'dry' ? 'Dry-run' : 'Failed'}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="az-iconbtn" onClick={() => void reload()} title="Refresh"><RefreshCw size={15} className={loading ? 'az-spin' : ''} /></button>
      </div>

      {shown.length === 0 && (
        <div className="az-empty" style={{ border: '1px solid var(--divider)', borderRadius: 10 }}>
          {items.length === 0
            ? 'No automation executions yet. Enable a rule in the Automation tab and let it fire.'
            : 'No executions match this filter.'}
        </div>
      )}

      {shown.map(x => {
        const camp = ctxCampaign(x.triggerData)
        const mkt = camp?.marketplace ?? (x.triggerData.marketplace as string | undefined)
        const profileId = mkt ? profileMap[mkt] : undefined
        const successActions = x.actionResults.filter(a => a.ok).length
        const failedActions = x.actionResults.filter(a => !a.ok).length

        return (
          <div key={x.id} className="az-rule" style={{ flexWrap: 'wrap', alignItems: 'flex-start', gap: 10 }}>
            {/* Status dot */}
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[x.status] ?? 'var(--ink3)', flexShrink: 0, marginTop: 5 }} />

            {/* Rule name + trigger */}
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{x.rule?.name ?? 'Unknown rule'}</div>
              <div style={{ color: 'var(--ink2)', fontSize: 11.5 }}>
                {(x.rule?.trigger ?? '').replace(/_/g, ' ')}
                {mkt && <span style={{ marginLeft: 8 }} className="az-badge">{mkt}</span>}
              </div>
            </div>

            {/* Campaign links */}
            {camp?.localId && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 }}>
                <a className="cn" href={campaignHref(camp.localId)} target="_blank" rel="noopener noreferrer">View in console</a>
                {camp.externalId && profileId && (
                  <a href={amazonCampaignHref(camp.externalId, profileId, mkt)} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--link)', textDecoration: 'none', fontWeight: 600 }}>
                    Open in Amazon <ExternalLink size={10} />
                  </a>
                )}
              </div>
            )}

            {/* Actions summary */}
            <div style={{ fontSize: 11.5, color: 'var(--ink2)', textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontWeight: 700, color: STATUS_COLOR[x.status] ?? 'var(--ink2)' }}>
                {x.status === 'DRY_RUN' ? 'Dry-run' : x.status.toLowerCase()}
                {x.dryRun && x.status !== 'DRY_RUN' && ' (dry)'}
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
