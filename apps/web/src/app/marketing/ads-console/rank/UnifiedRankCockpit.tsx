'use client'

/**
 * RC4 — Unified Rank Control cockpit.
 *
 * 2026-06-06: the placement ladder now reflects the TRUE current bias — the
 * /placements read previously joined report display-names against the bidding
 * enum keys, so it always showed 0% even when a bias was set.
 *
 * One surface that consolidates the old Placement / Keyword / Strategy / Conquest
 * / Top-of-Search-IS modes. RC4.0 (this file) is the SHELL: a single sticky
 * context bar (market · window · unified campaign search · autonomy posture ·
 * undo/redo) that drives one shared campaign+market+lookback, with the existing
 * placement cockpit embedded as the working body. Later phases break the body
 * into clean stations (① Where you rank · ② Set · ③ When · ④ Keywords · ⑤
 * Automate), add the staged-changes tray (RC4.5) and the history/undo timeline
 * (RC4.6). The old modes stay reachable via /automation during the migration.
 *
 * RK.1 — campaign + market are URL-driven (?campaignId=, ?market=) so the cockpit
 * is reload-safe, shareable and deep-linkable (the Managed → "Cockpit" jump lands
 * on the clicked campaign, not the default).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Crosshair, Search, ChevronRight, Undo2, Redo2, Layers, Zap, AlertTriangle, History as HistoryIcon, Info, Package } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { RankPlacementCockpit } from '../automation/RankPlacementCockpit'
import { StagedChangesTray } from './StagedChangesTray'
import { useRankUndo } from './useRankUndo'
import { StrategyStation } from './StrategyStation'
import { ConquestStation } from './ConquestStation'
import { AutomateStation } from './AutomateStation'
import { KeywordBidStation } from './KeywordBidStation'
import { BulkApplyStation } from './BulkApplyStation'
import { QuickRankSet } from './QuickRankSet'
import { CommandPalette, type CmdAction } from './CommandPalette'
import { IntelligenceBanner } from './IntelligenceBanner'
import { RankTrend } from './RankTrend'
import { ManagedCampaigns } from './ManagedCampaigns'
import { RankOverview } from './RankOverview'
import { RankPlanPanel } from './RankPlanPanel'
import { RankDirectorPanel } from './RankDirectorPanel'

const MARKETS = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK']
const LOOKBACKS = [7, 14, 30, 60, 90]
interface Camp { id: string; name: string; marketplace: string | null; status: string; biddingStrategy?: string | null }
interface Autonomy { killSwitch: boolean; rules: { total: number; enabled: number; live: number; dryRun: number; disabled: number } }

export function UnifiedRankCockpit() {
  const [lookback, setLookback] = useState(30)
  const [campaigns, setCampaigns] = useState<Camp[]>([])
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [autonomy, setAutonomy] = useState<Autonomy | null>(null)
  const [pending, setPending] = useState(0)
  const [gateOpen, setGateOpen] = useState<boolean | null>(null)
  const [trayOpen, setTrayOpen] = useState(false)
  const [trayTab, setTrayTab] = useState<'staged' | 'history'>('staged')
  const [cmdkOpen, setCmdkOpen] = useState(false)
  const [statusFilter, setStatusFilter] = useState<'active' | 'inactive' | 'all'>('active')

  // RK.1 — campaign + market are URL-driven (source of truth) so the cockpit is
  // reload-safe, shareable and deep-linkable (e.g. the Managed "Cockpit" jump).
  const sp = useSearchParams()
  const router = useRouter()
  const RANK_PATH = '/marketing/ads-console/rank'
  const setParams = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString())
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v) }
    router.replace(`${RANK_PATH}?${next.toString()}`, { scroll: false })
  }, [sp, router])
  const market = sp.get('market') ?? 'IT'
  const campaignId = sp.get('campaignId') ?? ''
  const mode = sp.get('mode') ?? 'cockpit'
  const productId = sp.get('productId') ?? ''
  const view: 'cockpit' | 'managed' | 'overview' | 'plan' = mode === 'managed' ? 'managed' : mode === 'overview' ? 'overview' : mode === 'plan' ? 'plan' : 'cockpit'
  const viewLabel = view === 'managed' ? 'Managed campaigns' : view === 'overview' ? 'Overview' : view === 'plan' ? 'Rank Director' : 'Cockpit'
  const setMarket = useCallback((m: string) => setParams({ market: m, campaignId: null }), [setParams])
  const setCampaignId = useCallback((id: string) => setParams({ campaignId: id || null }), [setParams])

  useEffect(() => { void fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' }).then(r => r.json()).then(d => setCampaigns((d.items ?? []) as Camp[])).catch(() => {}) }, [])
  useEffect(() => { void fetch(`${getBackendUrl()}/api/advertising/autonomy/status`, { cache: 'no-store' }).then(r => r.json()).then(d => setAutonomy(d as Autonomy)).catch(() => {}) }, [])
  const loadPending = useCallback(() => {
    if (!campaignId) { setPending(0); setGateOpen(null); return }
    void fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/pending-writes`, { cache: 'no-store' }).then(r => r.json()).then(d => { setPending((d.pending ?? []).length); setGateOpen(d.gate?.allowed ?? d.campaign?.liveBidWritesEnabled ?? false) }).catch(() => {})
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
  // RK.1 — pick a sensible default ONLY when the URL has no valid in-market
  // campaign; honor an explicit URL campaign even if it's paused/archived.
  useEffect(() => {
    if (view !== 'cockpit' || campaigns.length === 0) return
    if (inMarket.length === 0) { if (campaignId) setCampaignId(''); return }
    if (campaignId && inMarket.some(c => c.id === campaignId)) return
    const def = inMarketStatus[0]?.id ?? inMarket[0]?.id ?? ''
    if (def && def !== campaignId) setCampaignId(def)
  }, [view, campaigns, inMarket, inMarketStatus, campaignId, setCampaignId])
  const campaign = useMemo(() => campaigns.find(c => c.id === campaignId) ?? null, [campaigns, campaignId])
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = q ? inMarketStatus.filter(c => c.name.toLowerCase().includes(q)) : inMarketStatus
    return [...rows].sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'ENABLED' ? -1 : 1)).slice(0, 12)
  }, [inMarketStatus, search])

  const pickCampaign = useCallback((id: string) => { setCampaignId(id); setSearch(''); setSearchOpen(false) }, [])

  // RC5.1 / RK.1 — jump to a specific campaign in the cockpit via the URL (reliable
  // deep-link). Widen the status filter if the target is paused/archived so it's
  // visible + selected rather than silently filtered out.
  const goCockpit = useCallback((id: string) => {
    const c = campaigns.find(x => x.id === id)
    if (c && c.status !== 'ENABLED') setStatusFilter('all')
    setParams({ mode: 'cockpit', campaignId: id })
  }, [campaigns, setParams])

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
        <span className="az-urc-crumb"><Crosshair size={15} /> Rank Control <ChevronRight size={11} /> <b>{viewLabel}</b>{view === 'cockpit' && campaign ? <> <ChevronRight size={11} /> {campaign.name}</> : ''}</span>
        <span className="sp" />
        <label className="az-urc-ctl"><span>Market</span><select value={market} onChange={e => setMarket(e.target.value)}>{MARKETS.map(m => <option key={m}>{m}</option>)}</select></label>
        <button type="button" className={`az-urc-modebtn ${view === 'plan' ? 'on' : ''}`} onClick={() => setParams({ mode: view === 'plan' ? 'cockpit' : 'plan' })} title="Rank Director — manage rank by product across all its campaigns at once"><Package size={13} /> By product</button>
        {view === 'cockpit' && (<>
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
        </>)}
        <span className="sp" />
        <span className={`az-urc-chip ${tone}`} title="Global automation posture (all advertising rules)">{tone === 'off' ? <AlertTriangle size={12} /> : <Zap size={12} />} {autonomyLabel}</span>
        {view === 'cockpit' && (
          <div className="az-urc-undo">
            <button type="button" disabled={!canUndo} onClick={() => void undo()} title="Undo last change (⌘Z)" aria-label="Undo"><Undo2 size={15} /></button>
            <button type="button" disabled={!canRedo} onClick={() => void redo()} title="Redo (⇧⌘Z)" aria-label="Redo"><Redo2 size={15} /></button>
          </div>
        )}
      </div>
      {toast && <div className="az-urc-toast" role="status" aria-live="polite"><Undo2 size={13} /> {toast}</div>}

      {view === 'overview' && <RankOverview market={market} onMode={m => router.push(`/marketing/ads-console/rank?mode=${m}`)} />}
      {view === 'managed' && <ManagedCampaigns market={market} onJump={goCockpit} onChanged={loadPending} />}
      {view === 'plan' && (
        <section className="az-cr-sec">
          <div className="az-cr-sechd"><span className="n">★</span><div className="x"><b>Rank Director — by product</b><span>Pick a product → hold the top slot when its whole family sells, across every campaign at once.</span></div></div>
          <RankDirectorPanel market={market} productId={productId} onPickProduct={id => setParams({ mode: 'plan', productId: id || null })} />
        </section>
      )}

      {view === 'cockpit' && (<>
        {/* CR.1 — one guided journey: ① see where you rank → ② set the goal →
            ③ adjust → ④ automate. (Later phases de-duplicate the controls inside.) */}
        {campaignId && (
          <section className="az-cr-sec">
            <div className="az-cr-sechd"><span className="n">1</span><div className="x"><b>Where you rank</b><span>Top-of-Search share + trend, and any self-competition to clear first.</span></div></div>
            <IntelligenceBanner campaignId={campaignId} market={market} />
            <RankTrend campaignId={campaignId} lookback={lookback} />
            <div className="az-cr-note"><Info size={12} /> This is your Top-of-Search <b>share</b> — how often your ad wins a top slot — <b>not a fixed position</b>. Amazon&apos;s auction runs per search, so judge it on the trend over days, not a single search.</div>
          </section>
        )}
        {campaignId && (
          <section className="az-cr-sec">
            <div className="az-cr-sechd"><span className="n">2</span><div className="x"><b>Your rank goal &amp; schedule</b><span>Hold this rank, on this schedule — Save, Publish, or Discard.</span></div></div>
            <RankPlanPanel campaignId={campaignId} campaignName={campaign?.name ?? 'this campaign'} />
          </section>
        )}

        <section className="az-cr-sec">
          <div className="az-cr-sechd"><span className="n">3</span><div className="x"><b>Adjust placement &amp; bids</b><span>Quick-set the push, or fine-tune the placement ladder &amp; bids below.</span></div></div>
          {campaignId && <QuickRankSet campaignId={campaignId} onChanged={loadPending} />}
          <RankPlacementCockpit market={market} campaignId={campaignId} lookbackDays={lookback} onMarketChange={setMarket} onCampaignChange={setCampaignId} hideScopeBar hideKeywordManager hideDayparting />
          {campaignId && <StrategyStation campaignId={campaignId} currentStrategy={campaign?.biddingStrategy ?? null} onChanged={loadPending} />}
          {campaignId && <KeywordBidStation campaignId={campaignId} onChanged={loadPending} />}
          {campaignId && <ConquestStation campaignId={campaignId} onChanged={loadPending} />}
        </section>
        <section className="az-cr-sec">
          <div className="az-cr-sechd"><span className="n">4</span><div className="x"><b>Automate &amp; apply</b><span>Hands-off rules, and apply across multiple campaigns at once.</span></div></div>
          <AutomateStation market={market} onChanged={loadPending} />
          <BulkApplyStation campaigns={inMarketStatus} market={market} onChanged={loadPending} />
        </section>

        {/* ── Footer: staged-changes tray + history (RC4.5 / RC4.6) ── */}
        <div className="az-urc-foot">
          <button type="button" className={`az-urc-staged ${pending > 0 ? 'has' : ''}`} onClick={() => { setTrayOpen(o => !(o && trayTab === 'staged')); setTrayTab('staged') }} aria-expanded={trayOpen && trayTab === 'staged'}>
            <Layers size={14} /> {pending > 0 ? `${pending} staged change${pending === 1 ? '' : 's'}` : 'No staged changes'} · Review &amp; write-gate {trayOpen && trayTab === 'staged' ? '▾' : '▸'}
          </button>
          {campaignId && gateOpen != null && <span className={`az-urc-gate ${gateOpen ? 'open' : 'closed'}`} title={gateOpen ? 'Live writes ON — published changes reach Amazon' : 'Live writes gated — changes stay in Nexus until you open the gate'}>{gateOpen ? 'Write-gate OPEN' : 'Write-gate closed'}</span>}
          <span className="sp" />
          <button type="button" className="az-urc-histbtn" onClick={() => { setTrayOpen(o => !(o && trayTab === 'history')); setTrayTab('history') }} aria-expanded={trayOpen && trayTab === 'history'}>
            <HistoryIcon size={14} /> History &amp; undo{undoApi.entries.length ? ` (${undoApi.entries.length})` : ''} {trayOpen && trayTab === 'history' ? '▾' : '▸'}
          </button>
        </div>
        <StagedChangesTray campaignId={campaignId} open={trayOpen} tab={trayTab} onTab={setTrayTab} onClose={() => setTrayOpen(false)} onChanged={loadPending} undoApi={undoApi} />
      </>)}
      <CommandPalette
        open={cmdkOpen}
        onClose={() => setCmdkOpen(false)}
        campaigns={inMarketStatus}
        onPick={(id, mk) => setParams(mk ? { market: mk, campaignId: id } : { campaignId: id })}
        actions={[
          { id: 'staged', label: 'Open staged changes', run: () => { setTrayTab('staged'); setTrayOpen(true) } },
          { id: 'history', label: 'Open change history', run: () => { setTrayTab('history'); setTrayOpen(true) } },
          { id: 'undo', label: 'Undo last change', run: () => void undo() },
          { id: 'redo', label: 'Redo last undo', run: () => void redo() },
        ] satisfies CmdAction[]}
      />
    </div>
  )
}
