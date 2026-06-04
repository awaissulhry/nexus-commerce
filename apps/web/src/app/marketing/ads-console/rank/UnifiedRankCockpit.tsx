'use client'

/**
 * RC4 — Unified Rank Control cockpit.
 *
 * One surface that consolidates the old Placement / Keyword / Strategy / Conquest
 * / Top-of-Search-IS modes. RC4.0 (this file) is the SHELL: a single sticky
 * context bar (market · window · unified campaign search · autonomy posture ·
 * undo/redo) that drives one shared campaign+market+lookback, with the existing
 * placement cockpit embedded as the working body. Later phases break the body
 * into clean stations (① Where you rank · ② Set · ③ When · ④ Keywords · ⑤
 * Automate), add the staged-changes tray (RC4.5) and the history/undo timeline
 * (RC4.6). The old modes stay reachable via /automation during the migration.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Crosshair, Search, ChevronRight, Undo2, Redo2, Layers, Zap, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { RankPlacementCockpit } from '../automation/RankPlacementCockpit'
import { StagedChangesTray } from './StagedChangesTray'

const MARKETS = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK']
const LOOKBACKS = [7, 14, 30, 60, 90]
interface Camp { id: string; name: string; marketplace: string | null; status: string }
interface Autonomy { killSwitch: boolean; rules: { total: number; enabled: number; live: number; dryRun: number; disabled: number } }

export function UnifiedRankCockpit() {
  const [market, setMarket] = useState('IT')
  const [campaignId, setCampaignId] = useState('')
  const [lookback, setLookback] = useState(30)
  const [campaigns, setCampaigns] = useState<Camp[]>([])
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [autonomy, setAutonomy] = useState<Autonomy | null>(null)
  const [pending, setPending] = useState(0)
  const [trayOpen, setTrayOpen] = useState(false)

  useEffect(() => { void fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' }).then(r => r.json()).then(d => setCampaigns((d.items ?? []) as Camp[])).catch(() => {}) }, [])
  useEffect(() => { void fetch(`${getBackendUrl()}/api/advertising/autonomy/status`, { cache: 'no-store' }).then(r => r.json()).then(d => setAutonomy(d as Autonomy)).catch(() => {}) }, [])
  const loadPending = useCallback(() => {
    if (!campaignId) { setPending(0); return }
    void fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/pending-writes`, { cache: 'no-store' }).then(r => r.json()).then(d => setPending((d.pending ?? []).length)).catch(() => {})
  }, [campaignId])
  useEffect(() => { loadPending() }, [loadPending, market])

  const inMarket = useMemo(() => campaigns.filter(c => c.marketplace === market), [campaigns, market])
  useEffect(() => {
    if (inMarket.length === 0) { setCampaignId(''); return }
    setCampaignId(prev => (inMarket.some(c => c.id === prev) ? prev : inMarket[0]!.id))
  }, [inMarket])
  const campaign = useMemo(() => campaigns.find(c => c.id === campaignId) ?? null, [campaigns, campaignId])
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = q ? inMarket.filter(c => c.name.toLowerCase().includes(q)) : inMarket
    return [...rows].sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'ENABLED' ? -1 : 1)).slice(0, 12)
  }, [inMarket, search])

  const pickCampaign = useCallback((id: string) => { setCampaignId(id); setSearch(''); setSearchOpen(false) }, [])

  // Undo/redo are scaffolded here; the stack is populated once the stations emit
  // changes (RC4.6). Buttons stay disabled until then.
  const canUndo = false
  const canRedo = false

  const tone = autonomy?.killSwitch ? 'off' : (autonomy?.rules.live ?? 0) > 0 ? 'auto' : (autonomy?.rules.enabled ?? 0) > 0 ? 'suggest' : 'idle'
  const autonomyLabel = !autonomy ? '…'
    : autonomy.killSwitch ? 'Automation OFF'
    : autonomy.rules.live > 0 ? `AUTO · ${autonomy.rules.live} live`
    : autonomy.rules.enabled > 0 ? `SUGGEST · ${autonomy.rules.enabled} dry-run`
    : 'No rules yet'

  return (
    <div className="az-wrap az-urc">
      {/* ── Sticky context bar — one source of truth for the whole page ── */}
      <div className="az-urc-bar">
        <span className="az-urc-crumb"><Crosshair size={15} /> Cockpit <ChevronRight size={11} /> Rank Control{campaign ? <> <ChevronRight size={11} /> <b>{campaign.name}</b></> : ''}</span>
        <span className="sp" />
        <label className="az-urc-ctl"><span>Market</span><select value={market} onChange={e => setMarket(e.target.value)}>{MARKETS.map(m => <option key={m}>{m}</option>)}</select></label>
        <label className="az-urc-ctl"><span>Window</span><select value={lookback} onChange={e => setLookback(Number(e.target.value))}>{LOOKBACKS.map(d => <option key={d} value={d}>{d}d</option>)}</select></label>
        <div className="az-urc-search">
          <Search size={13} />
          <input value={search} onChange={e => { setSearch(e.target.value); setSearchOpen(true) }} onFocus={() => setSearchOpen(true)} onBlur={() => setTimeout(() => setSearchOpen(false), 150)} placeholder={`Search ${inMarket.length} campaigns…`} aria-label="Search campaigns" />
          {searchOpen && searchResults.length > 0 && (
            <div className="az-urc-results" role="listbox">
              {searchResults.map(c => <button key={c.id} type="button" role="option" aria-selected={c.id === campaignId} className={c.id === campaignId ? 'on' : ''} onMouseDown={() => pickCampaign(c.id)}>{c.status === 'ENABLED' ? '● ' : '○ '}{c.name}{c.marketplace ? <span className="mk">{c.marketplace}</span> : null}</button>)}
            </div>
          )}
        </div>
        <span className="sp" />
        <span className={`az-urc-chip ${tone}`} title="Global automation posture (all advertising rules)">{tone === 'off' ? <AlertTriangle size={12} /> : <Zap size={12} />} {autonomyLabel}</span>
        <div className="az-urc-undo">
          <button type="button" disabled={!canUndo} title="Undo (⌘Z)" aria-label="Undo"><Undo2 size={15} /></button>
          <button type="button" disabled={!canRedo} title="Redo (⇧⌘Z)" aria-label="Redo"><Redo2 size={15} /></button>
        </div>
      </div>

      {/* ── Body: the existing placement cockpit, driven by the shared context.
            Stations get extracted from here in RC4.1–RC4.4. ── */}
      <RankPlacementCockpit market={market} campaignId={campaignId} lookbackDays={lookback} onMarketChange={setMarket} onCampaignChange={setCampaignId} hideScopeBar />

      {/* ── Footer: opens the staged-changes tray (RC4.5) ── */}
      <div className="az-urc-foot">
        <button type="button" className={`az-urc-staged ${pending > 0 ? 'has' : ''}`} onClick={() => setTrayOpen(v => !v)} aria-expanded={trayOpen}>
          <Layers size={14} /> {pending > 0 ? `${pending} staged change${pending === 1 ? '' : 's'}` : 'No staged changes'} · Review &amp; write-gate {trayOpen ? '▾' : '▸'}
        </button>
      </div>
      <StagedChangesTray campaignId={campaignId} open={trayOpen} onClose={() => setTrayOpen(false)} onChanged={loadPending} />
    </div>
  )
}
