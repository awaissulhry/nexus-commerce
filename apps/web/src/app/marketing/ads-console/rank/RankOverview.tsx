'use client'

/**
 * RC5.1 — Rank Control overview. A small at-a-glance summary: how many campaigns
 * Rank Control runs on in this market, live vs dry-run rules, with quick jumps to
 * the Cockpit and the Managed-campaigns dashboard.
 */

import { useEffect, useMemo, useState } from 'react'
import { Crosshair, History, Zap, ChevronRight } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Sched { campaignId: string; enabled: boolean }
interface Camp { id: string; marketplace: string | null }
interface Autonomy { killSwitch: boolean; rules: { total: number; enabled: number; live: number; dryRun: number } }

export function RankOverview({ market, onMode }: { market: string; onMode: (m: string) => void }) {
  const [scheds, setScheds] = useState<Sched[]>([])
  const [camps, setCamps] = useState<Camp[]>([])
  const [autonomy, setAutonomy] = useState<Autonomy | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    void fetch(`${getBackendUrl()}/api/advertising/schedules`, { cache: 'no-store', signal: ac.signal }).then(r => r.json()).then(d => setScheds((d.items ?? []) as Sched[])).catch(() => {})
    void fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store', signal: ac.signal }).then(r => r.json()).then(d => setCamps((d.items ?? []) as Camp[])).catch(() => {})
    void fetch(`${getBackendUrl()}/api/advertising/autonomy/status`, { cache: 'no-store', signal: ac.signal }).then(r => r.json()).then(d => setAutonomy(d as Autonomy)).catch(() => {})
    return () => ac.abort()
  }, [])

  const marketIds = useMemo(() => new Set(camps.filter(c => c.marketplace === market).map(c => c.id)), [camps, market])
  const managed = scheds.filter(s => marketIds.has(s.campaignId))
  const active = managed.filter(s => s.enabled)

  return (
    <div className="az-rovw">
      <div className="az-rovw-cards">
        <button type="button" className="az-rovw-card act" onClick={() => onMode('managed')}>
          <span className="n">{active.length}</span>
          <span className="l">campaign{active.length === 1 ? '' : 's'} managed in {market}{managed.length > active.length ? ` · ${managed.length - active.length} paused` : ''}</span>
          <span className="go"><History size={15} /> Manage <ChevronRight size={13} /></span>
        </button>
        <div className="az-rovw-card">
          <span className="n">{autonomy ? autonomy.rules.live : '—'}</span>
          <span className="l">live automation rule{(autonomy?.rules.live ?? 0) === 1 ? '' : 's'} · {autonomy?.rules.dryRun ?? 0} dry-run{autonomy?.killSwitch ? ' · ⚠ kill-switch ON' : ''}</span>
          <span className="go muted"><Zap size={15} /> Account-wide</span>
        </div>
        <button type="button" className="az-rovw-card act" onClick={() => onMode('cockpit')}>
          <span className="n"><Crosshair size={26} /></span>
          <span className="l">Set or tune a campaign&apos;s rank, schedule, keywords &amp; automation</span>
          <span className="go">Open the cockpit <ChevronRight size={13} /></span>
        </button>
      </div>
      <div className="az-cockpit-note">Rank Control is running on <b>{active.length}</b> campaign{active.length === 1 ? '' : 's'} in {market}. Open <b>Managed campaigns</b> to see results + revert any of them, or the <b>Cockpit</b> to set a new one.</div>
    </div>
  )
}
