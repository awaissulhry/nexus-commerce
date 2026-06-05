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
import { Crosshair, Search, ChevronRight, Undo2, Redo2, Layers, Zap, AlertTriangle, History as HistoryIcon } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { RankPlacementCockpit } from '../automation/RankPlacementCockpit'
import { StagedChangesTray } from './StagedChangesTray'
import { useRankUndo } from './useRankUndo'
import { StrategyStation } from './StrategyStation'
import { ConquestStation } from './ConquestStation'
import { AutomateStation } from './AutomateStation'
import { KeywordBidStation } from './KeywordBidStation'
import { BulkApplyStation } from './BulkApplyStation'
import { SimpleRankPanel } from './SimpleRankPanel'
import { CommandPalette, type CmdAction } from './CommandPalette'
import { IntelligenceBanner } from './IntelligenceBanner'
import { RankTrend } from './RankTrend'

const MARKETS = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK']
const LOOKBACKS = [7, 14, 30, 60, 90]
interface Camp { id: string; name: string; marketplace: string | null; status: string; biddingStrategy?: string | null }
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
  const [trayTab, setTrayTab] = useState<'staged' | 'history'>('staged')
  const [simple, setSimple] = useState(false)
  const [cmdkOpen, setCmdkOpen] = useState(false)
  const [statusFilter, setStatusFilter] = useState<'active' | 'inactive' | 'all'>('active')

  useEffect(() => { void fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' }).then(r => r.json()).then(d => setCampaigns((d.items ?? []) as Camp[])).catch(() => {}) }, [])
  useEffect(() => { void fetch(`${getBackendUrl()}/api/advertising/autonomy/status`, { cache: 'no-store' }).then(r => r.json()).then(d => setAutonomy(d as Autonomy)).catch(() => {}) }, [])
  const loadPending = useCallback(() => {
    if (!campaignId) { setPending(0); return }
    void fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/pending-writes`, { cache: 'no-store' }).then(r => r.json()).then(d => setPending((d.pending ?? []).length)).catch(() => {})
  }, [campaignId])
  useEffect(() => { loadPending() }, [loadPending, market])

  // RC4.6 — history + undo/redo (Cmd+Z / Cmd+Shift+Z). Undo re-stages the prior
  // value through the gated bid path; it refreshes the staged count on change.
  const undoApi = useRankUndo(campaignId, loadPending)
  const { undo, redo, canUndo, canRedo, toast, setToast } = undoApi
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdkOpen(v => !v); return }
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      if (e.shiftKey) { if (canRedo) void redo() } else if (canUndo) void undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, canUndo, canRedo])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 4000); return () => clearTimeout(t) }, [toast, setToast])

  const inMarket = useMemo(() => campaigns.filter(c => c.marketplace === market), [campaigns, market])
  // RC4.13 — Active (ENABLED) / Inactive (paused or archived) / All. Drives every
  // campaign list (search, palette, bulk). Picker stays market-specific via inMarket.
  const matchStatus = useCallback((c: Camp) => (statusFilter === 'all' ? true : statusFilter === 'active' ? c.status === 'ENABLED' : c.status !== 'ENABLED'), [statusFilter])
  const inMarketStatus = useMemo(() => inMarket.filter(matchStatus), [inMarket, matchStatus])
  useEffect(() => {
    if (inMarket.length === 0) { setCampaignId(''); return }
    setCampaignId(prev => (inMarket.some(c => c.id === prev) ? prev : (inMarketStatus[0]?.id ?? inMarket[0]!.id)))
  }, [inMarket]) // eslint-disable-line react-hooks/exhaustive-deps
  const campaign = useMemo(() => campaigns.find(c => c.id === campaignId) ?? null, [campaigns, campaignId])
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = q ? inMarketStatus.filter(c => c.name.toLowerCase().includes(q)) : inMarketStatus
    return [...rows].sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'ENABLED' ? -1 : 1)).slice(0, 12)
  }, [inMarketStatus, search])

  const pickCampaign = useCallback((id: string) => { setCampaignId(id); setSearch(''); setSearchOpen(false) }, [])

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
        <label className="az-urc-ctl"><span>Show</span><select value={statusFilter} onChange={e => setStatusFilter(e.target.value as 'active' | 'inactive' | 'all')}><option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option></select></label>
        <div className="az-urc-search">
          <Search size={13} />
          <input value={search} onChange={e => { setSearch(e.target.value); setSearchOpen(true) }} onFocus={() => setSearchOpen(true)} onBlur={() => setTimeout(() => setSearchOpen(false), 150)} placeholder={`Search ${inMarketStatus.length} campaigns…`} aria-label="Search campaigns" />
          {!searchOpen && <kbd title="Command palette">⌘K</kbd>}
          {searchOpen && searchResults.length > 0 && (
            <div className="az-urc-results" role="listbox">
              {searchResults.map(c => <button key={c.id} type="button" role="option" aria-selected={c.id === campaignId} className={c.id === campaignId ? 'on' : ''} onMouseDown={() => pickCampaign(c.id)}>{c.status === 'ENABLED' ? '● ' : '○ '}{c.name}{c.marketplace ? <span className="mk">{c.marketplace}</span> : null}</button>)}
            </div>
          )}
        </div>
        <span className="sp" />
        <span className="az-mode-seg az-urc-seg" role="tablist" aria-label="View mode">
          <button type="button" role="tab" aria-selected={simple} className={simple ? 'on' : ''} onClick={() => setSimple(true)}>Simple</button>
          <button type="button" role="tab" aria-selected={!simple} className={!simple ? 'on' : ''} onClick={() => setSimple(false)}>Full</button>
        </span>
        <span className={`az-urc-chip ${tone}`} title="Global automation posture (all advertising rules)">{tone === 'off' ? <AlertTriangle size={12} /> : <Zap size={12} />} {autonomyLabel}</span>
        <div className="az-urc-undo">
          <button type="button" disabled={!canUndo} onClick={() => void undo()} title="Undo last change (⌘Z)" aria-label="Undo"><Undo2 size={15} /></button>
          <button type="button" disabled={!canRedo} onClick={() => void redo()} title="Redo (⇧⌘Z)" aria-label="Redo"><Redo2 size={15} /></button>
        </div>
      </div>
      {toast && <div className="az-urc-toast" role="status" aria-live="polite"><Undo2 size={13} /> {toast}</div>}

      {campaignId && <IntelligenceBanner campaignId={campaignId} market={market} />}
      {campaignId && <RankTrend campaignId={campaignId} lookback={lookback} />}

      {/* ── Body: the existing placement cockpit, driven by the shared context.
            Stations get extracted from here in RC4.1–RC4.4. ── */}
      {simple ? (
        <SimpleRankPanel market={market} campaignId={campaignId} campaignName={campaign?.name ?? 'this campaign'} onFull={() => setSimple(false)} onChanged={loadPending} />
      ) : (<>
        <RankPlacementCockpit market={market} campaignId={campaignId} lookbackDays={lookback} onMarketChange={setMarket} onCampaignChange={setCampaignId} hideScopeBar />

        {/* ── Absorbed modes as progressive stations (RC4.2+) ── */}
        {campaignId && <StrategyStation campaignId={campaignId} currentStrategy={campaign?.biddingStrategy ?? null} onChanged={loadPending} />}
        {campaignId && <KeywordBidStation campaignId={campaignId} onChanged={loadPending} />}
        {campaignId && <ConquestStation campaignId={campaignId} onChanged={loadPending} />}
        <AutomateStation market={market} onChanged={loadPending} />
        <BulkApplyStation campaigns={inMarketStatus} market={market} onChanged={loadPending} />
      </>)}

      {/* ── Footer: staged-changes tray + history (RC4.5 / RC4.6) ── */}
      <div className="az-urc-foot">
        <button type="button" className={`az-urc-staged ${pending > 0 ? 'has' : ''}`} onClick={() => { setTrayOpen(o => !(o && trayTab === 'staged')); setTrayTab('staged') }} aria-expanded={trayOpen && trayTab === 'staged'}>
          <Layers size={14} /> {pending > 0 ? `${pending} staged change${pending === 1 ? '' : 's'}` : 'No staged changes'} · Review &amp; write-gate {trayOpen && trayTab === 'staged' ? '▾' : '▸'}
        </button>
        <span className="sp" />
        <button type="button" className="az-urc-histbtn" onClick={() => { setTrayOpen(o => !(o && trayTab === 'history')); setTrayTab('history') }} aria-expanded={trayOpen && trayTab === 'history'}>
          <HistoryIcon size={14} /> History &amp; undo{undoApi.entries.length ? ` (${undoApi.entries.length})` : ''} {trayOpen && trayTab === 'history' ? '▾' : '▸'}
        </button>
      </div>
      <StagedChangesTray campaignId={campaignId} open={trayOpen} tab={trayTab} onTab={setTrayTab} onClose={() => setTrayOpen(false)} onChanged={loadPending} undoApi={undoApi} />
      <CommandPalette
        open={cmdkOpen}
        onClose={() => setCmdkOpen(false)}
        campaigns={inMarketStatus}
        onPick={(id, mk) => { if (mk) setMarket(mk); setCampaignId(id) }}
        actions={[
          { id: 'simple', label: simple ? 'Switch to Full view' : 'Switch to Simple view', run: () => setSimple(v => !v) },
          { id: 'staged', label: 'Open staged changes', run: () => { setTrayTab('staged'); setTrayOpen(true) } },
          { id: 'history', label: 'Open change history', run: () => { setTrayTab('history'); setTrayOpen(true) } },
          { id: 'undo', label: 'Undo last change', run: () => void undo() },
          { id: 'redo', label: 'Redo last undo', run: () => void redo() },
        ] satisfies CmdAction[]}
      />
    </div>
  )
}
