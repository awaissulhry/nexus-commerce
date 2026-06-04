'use client'

/**
 * Rank Control — Placement Cockpit (RC2 series, campaign-first redesign).
 *
 * Direction (2026-06): manage ONE campaign at a time (Market → Campaign), drag
 * the listing onto an EXACT rank slot (Top of search 1st / 2nd / 3rd, Rest,
 * Product pages), and bulk-manage keywords. Replaces the product-aggregate +
 * coarse-tier model — campaign-first removes the multi-market aggregation pain.
 *
 * Honest rank model (approved): Amazon runs a blind auction — no API sets or
 * reads literal SERP rank. So each slot maps to a top-of-search impression-share
 * TARGET + bid-to-win; the autonomous loop holds it and the real TOS-IS is the
 * "how often you actually win that slot" feedback. Higher slot → higher IS
 * target + more aggressive bid. It targets/defends a position; it can't pin one.
 *
 * R1 (this file): campaign-first scope bar + numbered rank ladder + live
 * per-campaign signals (TOS-IS, current %, recommendation), card initialised to
 * the campaign's current implied rank. Read-only. R2 = IS-band mapping +
 * feedback; R3 = bulk keywords; R4 = apply + hold; R5 = dynamic polish.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { DndContext, useDraggable, useDroppable, DragOverlay, type DragEndEvent, type DragStartEvent, PointerSensor, KeyboardSensor, useSensor, useSensors } from '@dnd-kit/core'
import { GripVertical, Info, ArrowUp, Crosshair, TrendingUp, TrendingDown, Minus, Search, Plus, Loader2, Check, ListPlus, Sparkles } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

const MARKETS = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK']
const WINDOW_DAYS = 30

interface Camp { id: string; name: string; marketplace: string | null; status: string; externalCampaignId: string | null; acos: number | null; dailyBudget: unknown; adProduct: string | null }
interface TosRow { campaignId: string; name: string; marketplace: string | null; topImpr: number; topSpendCents: number; topSalesCents: number; topAcos: number | null; topIS: number | null; currentPct: number; recommendedPct: number; action: 'raise' | 'lower' | 'keep'; reason: string }
interface Target { id: string; text: string; matchType: string; bidCents: number; status: string; adGroupId: string; impressions: number; clicks: number; spendCents: number; salesCents: number; acos: number | null }
interface ParsedKw { keyword: string; bidCents: number; basis: string; exists: boolean }
const MATCH_TYPES = ['BROAD', 'PHRASE', 'EXACT'] as const

// ── The numbered rank ladder. isTarget = the top-of-search impression-share
// band each slot maps to (the honest rank proxy; R2 wires the live feedback). ──
type SlotKey = 'top1' | 'top2' | 'top3' | 'rest' | 'product'
interface Slot { k: SlotKey; group: 'top' | 'rest' | 'product'; rank: number | null; isTarget: number | null; short: string }
const SLOTS: Slot[] = [
  { k: 'top1', group: 'top', rank: 1, isTarget: 0.65, short: '1st' },
  { k: 'top2', group: 'top', rank: 2, isTarget: 0.45, short: '2nd' },
  { k: 'top3', group: 'top', rank: 3, isTarget: 0.30, short: '3rd' },
  { k: 'rest', group: 'rest', rank: null, isTarget: null, short: 'Rest of search' },
  { k: 'product', group: 'product', rank: null, isTarget: null, short: 'Product pages' },
]
const slotLabel = (k: SlotKey) => {
  const s = SLOTS.find(x => x.k === k)
  return s?.group === 'top' ? `Top of search · ${s.short}` : s?.short ?? '—'
}
const euros = (c: number) => `€${(c / 100).toFixed(2)}`
// Map a campaign's current top-of-search state → the slot it effectively sits in.
function impliedSlot(topIS: number | null, currentPct: number): SlotKey {
  if (topIS != null) return topIS >= 0.55 ? 'top1' : topIS >= 0.38 ? 'top2' : topIS >= 0.20 ? 'top3' : 'rest'
  return currentPct >= 150 ? 'top1' : currentPct >= 60 ? 'top2' : currentPct >= 15 ? 'top3' : 'rest'
}

// ── Listing card (the campaign you're placing) ─────────────────────────
function CampaignCard({ camp, dragging }: { camp: Camp; dragging?: boolean }) {
  return (
    <div className={`az-prodcard ${dragging ? 'drag' : ''}`}>
      <GripVertical size={14} className="grip" />
      <div className="meta">
        <div className="nm">{camp.name}</div>
        <div className="as">{camp.marketplace ?? '—'} · {camp.status}</div>
      </div>
      <span className="you">YOU</span>
    </div>
  )
}
function DraggableCard({ camp }: { camp: Camp }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: 'card' })
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} style={{ opacity: isDragging ? 0.3 : 1, cursor: 'grab', touchAction: 'none' }}>
      <CampaignCard camp={camp} />
    </div>
  )
}

// ── A droppable rank slot ──────────────────────────────────────────────
function DropSlot({ slot, active, numbered, children }: { slot: Slot; active: boolean; numbered?: boolean; children?: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: slot.k })
  return (
    <div ref={setNodeRef} className={`az-rankslot ${numbered ? 'num' : 'wide'} ${active ? 'has-you' : ''} ${isOver ? 'over' : ''}`}>
      {numbered && <span className="az-rank-no">{slot.rank}</span>}
      {!numbered && <span className="az-rank-wide-lbl">{slot.short}</span>}
      {active ? children : (numbered ? <span className="az-slot-ghost sm" /> : null)}
    </div>
  )
}

// Rank meter — a single 0–100% top-of-search impression-share scale with the
// 3rd/2nd/1st bands marked, the live IS fill, and a caret at the target slot.
// Makes the honest rank→IS mapping visible: where you're holding vs the target.
const RANK_BANDS = [{ at: 30, lbl: '3rd' }, { at: 45, lbl: '2nd' }, { at: 65, lbl: '1st' }]
function RankMeter({ isPct, targetPct }: { isPct: number | null; targetPct: number | null }) {
  return (
    <div className="az-rankmeter">
      <div className="az-rankmeter-labels">
        {RANK_BANDS.map(b => <span key={b.lbl} className="bl" style={{ left: `${b.at}%` }}>{b.lbl}</span>)}
      </div>
      <div className="az-rankmeter-track">
        {isPct != null && <div className="fill" style={{ width: `${Math.min(100, Math.max(0, isPct))}%` }} />}
        {RANK_BANDS.map(b => <span key={b.lbl} className="tick" style={{ left: `${b.at}%` }} />)}
        {targetPct != null && <span className="target" style={{ left: `${Math.min(100, Math.max(0, targetPct))}%` }} title={`Target ${targetPct}% IS`} />}
      </div>
      <div className="az-rankmeter-foot"><span>{isPct == null ? 'IS — (not ingested)' : `Holding ${isPct.toFixed(0)}% IS`}</span><span className="leg">1st ≥65 · 2nd ≥45 · 3rd ≥30</span></div>
    </div>
  )
}
const ActionChip = ({ action }: { action: TosRow['action'] }) => (
  <span className={`az-act ${action}`}>
    {action === 'raise' ? <TrendingUp size={11} /> : action === 'lower' ? <TrendingDown size={11} /> : <Minus size={11} />}
    {action === 'raise' ? 'Raise' : action === 'lower' ? 'Ease off' : 'Hold'}
  </span>
)

export function RankPlacementCockpit() {
  const [campaigns, setCampaigns] = useState<Camp[]>([])
  const [market, setMarket] = useState('IT')
  const [campaignId, setCampaignId] = useState('')
  const [campaignSearch, setCampaignSearch] = useState('')
  const [slot, setSlot] = useState<SlotKey>('top3')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [cur, setCur] = useState<TosRow | null>(null)
  const [signalsLoading, setSignalsLoading] = useState(false)
  const [userMoved, setUserMoved] = useState(false)
  // R3 — bulk keyword manager
  const [targets, setTargets] = useState<Target[]>([])
  const [targetsLoading, setTargetsLoading] = useState(false)
  const [paste, setPaste] = useState('')
  const [kwMatch, setKwMatch] = useState<typeof MATCH_TYPES[number]>('PHRASE')
  const [parsed, setParsed] = useState<ParsedKw[] | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addMsg, setAddMsg] = useState('')

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor))

  // All campaigns once (campaign-first: filtered by market + search in the picker).
  useEffect(() => {
    void fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => setCampaigns((d.items ?? []) as Camp[]))
      .catch(() => {})
  }, [])

  const inMarket = useMemo(() => campaigns.filter(c => c.marketplace === market), [campaigns, market])
  const filtered = useMemo(() => {
    const q = campaignSearch.trim().toLowerCase()
    const rows = q ? inMarket.filter(c => c.name.toLowerCase().includes(q)) : inMarket
    return [...rows].sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'ENABLED' ? -1 : 1))
  }, [inMarket, campaignSearch])

  // Keep a valid selection as the market/filter changes.
  useEffect(() => {
    if (filtered.length === 0) { setCampaignId(''); return }
    if (!filtered.some(c => c.id === campaignId)) setCampaignId(filtered[0].id)
  }, [filtered, campaignId])

  const campaign = useMemo(() => campaigns.find(c => c.id === campaignId) ?? null, [campaigns, campaignId])

  // Per-campaign top-of-search signals (single row from /top-of-search).
  const loadSignals = useCallback(async (signal?: AbortSignal) => {
    if (!campaignId) { setCur(null); return }
    setSignalsLoading(true)
    try {
      const d = await fetch(`${getBackendUrl()}/api/advertising/top-of-search?windowDays=${WINDOW_DAYS}&marketplace=${market}`, { cache: 'no-store', signal }).then(r => r.json()).catch(() => ({ rows: [] }))
      if (signal?.aborted) return
      const row: TosRow | null = (d.rows ?? []).find((r: TosRow) => r.campaignId === campaignId) ?? null
      setCur(row)
      if (!userMoved) setSlot(row ? impliedSlot(row.topIS, row.currentPct) : 'rest')
    } finally { if (!signal?.aborted) setSignalsLoading(false) }
  }, [campaignId, market]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ac = new AbortController()
    setUserMoved(false)
    void loadSignals(ac.signal)
    return () => ac.abort()
  }, [loadSignals])

  // R3 — load the campaign's existing keywords (also gives the destination ad group)
  const loadTargets = useCallback(async (signal?: AbortSignal) => {
    if (!campaignId) { setTargets([]); return }
    setTargetsLoading(true)
    try {
      const d = await fetch(`${getBackendUrl()}/api/advertising/targets?campaignId=${encodeURIComponent(campaignId)}&windowDays=${WINDOW_DAYS}&kind=KEYWORD&limit=500`, { cache: 'no-store', signal }).then(r => r.json()).catch(() => ({ rows: [] }))
      if (signal?.aborted) return
      setTargets((d.rows ?? []) as Target[])
    } finally { if (!signal?.aborted) setTargetsLoading(false) }
  }, [campaignId])

  useEffect(() => {
    const ac = new AbortController()
    setParsed(null); setPaste(''); setAddMsg('')
    void loadTargets(ac.signal)
    return () => ac.abort()
  }, [loadTargets])

  // Destination ad group = the campaign's keyword ad group with the most targets.
  const adGroupId = useMemo(() => {
    if (targets.length === 0) return null
    const counts = new Map<string, number>()
    for (const t of targets) counts.set(t.adGroupId, (counts.get(t.adGroupId) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }, [targets])

  const existingSet = useMemo(() => new Set(targets.map(t => t.text.trim().toLowerCase())), [targets])
  const parseKeywords = (raw: string): string[] => {
    const seen = new Set<string>(); const out: string[] = []
    for (const part of raw.split(/[\n,]+/)) { const k = part.trim().replace(/\s+/g, ' '); const key = k.toLowerCase(); if (k && !seen.has(key)) { seen.add(key); out.push(k) } }
    return out
  }

  const getBids = useCallback(async () => {
    const kws = parseKeywords(paste)
    if (kws.length === 0) { setParsed([]); return }
    setSuggesting(true); setAddMsg('')
    try {
      const d = await fetch(`${getBackendUrl()}/api/advertising/bid-suggestions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: kws, matchType: kwMatch, marketplace: market }),
      }).then(r => r.json()).catch(() => ({ suggestions: [] }))
      const byKw = new Map<string, { suggestedBidCents: number; basis: string }>((d.suggestions ?? []).map((s: { keyword: string; suggestedBidCents: number; basis: string }) => [s.keyword.toLowerCase(), { suggestedBidCents: s.suggestedBidCents, basis: s.basis }]))
      setParsed(kws.map(k => { const s = byKw.get(k.toLowerCase()); return { keyword: k, bidCents: s?.suggestedBidCents ?? (d.defaultBidCents ?? 50), basis: s?.basis ?? 'default', exists: existingSet.has(k.toLowerCase()) } }))
    } finally { setSuggesting(false) }
  }, [paste, kwMatch, market, existingSet])

  const setParsedBid = (i: number, cents: number) => setParsed(p => p ? p.map((x, j) => j === i ? { ...x, bidCents: Math.max(2, cents) } : x) : p)

  const addKeywords = useCallback(async () => {
    if (!parsed || !adGroupId) return
    const toAdd = parsed.filter(p => !p.exists)
    if (toAdd.length === 0) { setAddMsg('All pasted keywords already exist on this campaign.'); return }
    setAdding(true); setAddMsg('')
    let count = 0; let pushed = 0
    for (const k of toAdd) {
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/keywords/create`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ adGroupId, keywordText: k.keyword, matchType: kwMatch, bidEur: k.bidCents / 100 }),
        }).then(r => r.json())
        if (r?.id) { count += 1; if (r.externalTargetId) pushed += 1 }
      } catch { /* continue; partial result surfaced via count */ }
    }
    setAddMsg(count === 0 ? 'Could not add keywords.' : `Added ${count} keyword${count === 1 ? '' : 's'} to the campaign${pushed === 0 ? ' (staged locally — write-gate closed; not yet on Amazon)' : ` (${pushed} pushed to Amazon)`}.`)
    setParsed(null); setPaste('')
    setAdding(false)
    void loadTargets()
  }, [parsed, adGroupId, kwMatch, loadTargets])

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id))
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null)
    const over = e.over?.id as SlotKey | undefined
    if (over && SLOTS.some(s => s.k === over)) { setSlot(over); setUserMoved(true) }
  }

  const isPct = cur?.topIS != null ? cur.topIS * 100 : null
  const targetSlot = SLOTS.find(s => s.k === slot) ?? null
  const targetIsPct = targetSlot?.isTarget != null ? Math.round(targetSlot.isTarget * 100) : null
  const curRankSlot = cur?.topIS != null ? impliedSlot(cur.topIS, cur.currentPct) : null
  const topSlots = SLOTS.filter(s => s.group === 'top')

  // Honest rank readout: where you're holding vs the target slot.
  const rankReadout = (() => {
    if (!cur) return null
    if (targetSlot?.group !== 'top') return `Targeting ${slotLabel(slot)} — easing off top-of-search to cut cost.`
    if (cur.topIS == null) return `Top-of-search IS not ingested yet — targeting ${slotLabel(slot)}; the hold loop uses ACOS until IS data lands.`
    const x = Math.round(cur.topIS * 100)
    const est = curRankSlot ? slotLabel(curRankSlot) : '—'
    if (targetIsPct == null) return null
    if (x >= targetIsPct) return `On/above target — holding ${x}% IS (≈ ${est}).`
    return `Targeting ${slotLabel(slot)} (≥ ${targetIsPct}% IS). Holding ${x}% ≈ ${est} — about +${targetIsPct - x} pts to reach it.`
  })()

  return (
    <div className="az-cockpit">
      {/* ── Campaign-first scope bar ─────────────────────────── */}
      <div className="az-cockpit-bar">
        <label className="ctl"><span className="lbl">Market</span>
          <select value={market} onChange={e => setMarket(e.target.value)}>{MARKETS.map(m => <option key={m}>{m}</option>)}</select>
        </label>
        <label className="ctl" style={{ flex: 1, minWidth: 220 }}><span className="lbl">Campaign</span>
          <select value={campaignId} onChange={e => { setCampaignId(e.target.value) }} style={{ maxWidth: 'none', width: '100%' }}>
            {filtered.length === 0 && <option>No campaigns in {market}</option>}
            {filtered.map(c => <option key={c.id} value={c.id}>{c.status === 'ENABLED' ? '● ' : '○ '}{c.name}</option>)}
          </select>
        </label>
        <label className="ctl"><span className="lbl">Find</span>
          <div className="kw-wrap"><Search size={13} /><input value={campaignSearch} onChange={e => setCampaignSearch(e.target.value)} placeholder="Filter campaigns…" /></div>
        </label>
        <span style={{ flex: 1 }} />
        {signalsLoading && <span className="az-cockpit-status">Loading…</span>}
        {!signalsLoading && campaign && <span className="az-cockpit-status ok">{filtered.length} in {market} · {WINDOW_DAYS}d</span>}
      </div>

      <div className="az-cockpit-body">
        {/* ── Numbered rank ladder ───────────────────────────── */}
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div className="az-ladder">
            <div className="az-ladder-cap"><ArrowUp size={13} /> Higher rank · more visible · more competitive · costs more</div>

            <div className="az-rankgroup">
              <div className="az-rankgroup-head"><span className="t">Top of search</span><span className="badge">≈ 3 sponsored slots</span></div>
              <div className="az-ranktop">
                {topSlots.map(s => (
                  <DropSlot key={s.k} slot={s} numbered active={slot === s.k && !!campaign}>
                    {campaign && <DraggableCard camp={campaign} />}
                  </DropSlot>
                ))}
              </div>
            </div>

            {SLOTS.filter(s => s.group !== 'top').map(s => (
              <DropSlot key={s.k} slot={s} active={slot === s.k && !!campaign}>
                {campaign && <DraggableCard camp={campaign} />}
              </DropSlot>
            ))}

            <div className="az-ladder-foot"><Info size={11} /> Drag your listing onto the rank you want. Amazon is a blind auction — this targets &amp; defends the slot via impression-share + bid; it can’t pin a fixed rank.</div>
          </div>
          <DragOverlay>{activeId && campaign ? <CampaignCard camp={campaign} dragging /> : null}</DragOverlay>
        </DndContext>

        {/* ── Strategy panel (R2 wires IS mapping; R3 bulk kw; R4 apply/hold) ── */}
        <div className="az-cockpit-panel">
          <div className="az-cockpit-panel-head"><Crosshair size={15} /> Strategy</div>
          <div className="row"><span>Campaign</span><b>{campaign?.name ?? '—'}</b></div>
          <div className="row"><span>Market</span><b>{market}</b></div>
          <div className="row"><span>Status</span><b>{campaign?.status ?? '—'}</b></div>
          <div className="sep" />
          <div className="row"><span>Target rank</span><b>{slotLabel(slot)}{userMoved ? '' : ' (current)'}</b></div>

          <div className="az-rankmeter-wrap">
            <span className="az-gauge-lbl">Rank · top-of-search impression share</span>
            <RankMeter isPct={isPct} targetPct={targetIsPct} />
          </div>
          {rankReadout && <div className="az-cockpit-sub">{rankReadout}</div>}

          <div className="sep" />
          <div className="row"><span>Current top-of-search %</span><b>{cur ? `+${cur.currentPct}%` : '—'}</b></div>
          <div className="row"><span>Recommended</span><b>{cur ? `+${cur.recommendedPct}%` : '—'} {cur && <ActionChip action={cur.action} />}</b></div>
          <div className="row"><span>Top ACOS</span><b>{cur?.topAcos != null ? `${(cur.topAcos * 100).toFixed(0)}%` : '—'}</b></div>
          {cur?.reason && <div className="az-cockpit-sub">{cur.reason}.</div>}

          <div className="az-cockpit-note">
            <Info size={12} /> The numbered rank ladder + live IS feedback are read-only. Bulk keyword management is below; one-click apply + hold-the-slot land in R4.
          </div>
        </div>
      </div>

      {/* ── R3: bulk keyword manager ─────────────────────────────── */}
      <div className="az-kwmgr">
        <div className="az-kwmgr-head"><ListPlus size={15} /> Keywords{campaign ? <> · <span className="cn">{campaign.name}</span></> : ''}<span style={{ flex: 1 }} /><span className="ct">{targetsLoading ? 'Loading…' : `${targets.length} active`}</span></div>
        <div className="az-kwmgr-grid">
          {/* Add — paste → bid-to-win → add */}
          <div className="az-kwmgr-add">
            <div className="az-kwmgr-sublbl">Add in bulk — paste keywords (one per line or comma-separated)</div>
            <textarea className="az-kwmgr-paste" value={paste} onChange={e => setPaste(e.target.value)} placeholder={'giacca moto pelle\ngiubbotto moto estivo, guanti moto racing'} rows={4} />
            <div className="az-kwmgr-row">
              <label className="az-kwmgr-match">Match
                <select value={kwMatch} onChange={e => setKwMatch(e.target.value as typeof MATCH_TYPES[number])}>{MATCH_TYPES.map(m => <option key={m}>{m}</option>)}</select>
              </label>
              <span style={{ flex: 1 }} />
              <button type="button" className="az-btn" disabled={suggesting || !paste.trim()} onClick={() => void getBids()}>
                {suggesting ? <><Loader2 size={14} className="az-spin" /> Pricing…</> : <><Sparkles size={14} /> Get bid-to-win</>}
              </button>
            </div>

            {parsed && parsed.length > 0 && (
              <div className="az-kwmgr-parsed">
                <div className="az-kwmgr-sublbl">{parsed.filter(p => !p.exists).length} to add{parsed.some(p => p.exists) ? ` · ${parsed.filter(p => p.exists).length} already exist` : ''}</div>
                {parsed.map((p, i) => (
                  <div key={p.keyword} className={`az-kwline ${p.exists ? 'dim' : ''}`}>
                    <span className="kw" title={p.keyword}>{p.keyword}</span>
                    {p.exists ? <span className="ex">exists</span> : <>
                      {p.basis === 'default' && <span className="bd" title="No history — account default bid">def</span>}
                      <span className="eur">€<input type="number" min={0.02} step={0.05} value={(p.bidCents / 100).toFixed(2)} onChange={e => setParsedBid(i, Math.round(parseFloat(e.target.value || '0') * 100))} /></span>
                    </>}
                  </div>
                ))}
                <button type="button" className="az-btn dark" style={{ marginTop: 8, width: '100%', justifyContent: 'center' }} disabled={adding || !adGroupId || parsed.filter(p => !p.exists).length === 0} onClick={() => void addKeywords()}>
                  {adding ? <><Loader2 size={14} className="az-spin" /> Adding…</> : <><Plus size={14} /> Add {parsed.filter(p => !p.exists).length} to campaign</>}
                </button>
                {!adGroupId && <div className="az-cockpit-sub" style={{ color: '#cc1100' }}>This campaign has no keyword ad group yet — add keywords via the campaign builder first.</div>}
              </div>
            )}
            {parsed && parsed.length === 0 && <div className="az-cockpit-sub">No keywords parsed — paste some above.</div>}
            {addMsg && <div className="az-cockpit-sub" style={{ color: addMsg.startsWith('Added') ? 'var(--green)' : '#cc1100', marginTop: 6 }}><Check size={12} style={{ verticalAlign: 'text-bottom' }} /> {addMsg}</div>}
            <div className="az-cockpit-note" style={{ marginTop: 8 }}><Info size={12} /> Bids default to your data-grounded bid-to-win (editable). Adds are gated — sandbox stages them locally until the ads write-gate is live.</div>
          </div>

          {/* Existing keywords */}
          <div className="az-kwmgr-existing">
            <div className="az-kwmgr-sublbl">Active keywords{targets.length > 40 ? ' · top 40 by spend' : ''}</div>
            {targets.length === 0 && !targetsLoading && <div className="az-cockpit-sub">No keywords on this campaign{campaign ? '' : ' — pick one above'}.</div>}
            <div className="az-kwmgr-list">
              {[...targets].sort((a, b) => b.spendCents - a.spendCents).slice(0, 40).map(t => (
                <div key={t.id} className="az-kwline">
                  <span className="kw" title={t.text}>{t.text}</span>
                  <span className="mt">{t.matchType}</span>
                  <span className="bid">{euros(t.bidCents)}</span>
                  <span className="ac">{t.acos != null ? `${(t.acos * 100).toFixed(0)}%` : '—'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
