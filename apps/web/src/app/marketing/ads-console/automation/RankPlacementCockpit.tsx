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
import { GripVertical, Info, ArrowUp, Crosshair, TrendingUp, TrendingDown, Minus, Search, Plus, Loader2, Check, ListPlus, Sparkles, Zap, ShieldCheck, BarChart3, AlertTriangle, Clock, Wallet } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { TimeRankGrid, compileGrid, type Level } from './TimeRankGrid'
import { DemandHeatmap } from './DemandHeatmap'

const MARKETS = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK']
const WINDOW_DAYS = 30
// Shopper-local timezone per market (dayparting windows are enforced in this TZ).
const MARKET_TZ: Record<string, string> = { IT: 'Europe/Rome', DE: 'Europe/Berlin', FR: 'Europe/Paris', ES: 'Europe/Madrid', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels', SE: 'Europe/Stockholm', PL: 'Europe/Warsaw', IE: 'Europe/Dublin', UK: 'Europe/London' }

interface Camp { id: string; name: string; marketplace: string | null; status: string; externalCampaignId: string | null; acos: number | null; dailyBudget: unknown; adProduct: string | null; deliveryStatus?: string | null; deliveryReasons?: unknown }
interface TosRow { campaignId: string; name: string; marketplace: string | null; topImpr: number; topSpendCents: number; topSalesCents: number; topAcos: number | null; topIS: number | null; currentPct: number; recommendedPct: number; action: 'raise' | 'lower' | 'keep'; reason: string }
interface Target { id: string; text: string; matchType: string; bidCents: number; status: string; adGroupId: string; impressions: number; clicks: number; spendCents: number; salesCents: number; acos: number | null }
interface ParsedKw { keyword: string; bidCents: number; basis: string; exists: boolean }
interface PlacementRow { placement: PlacementKey; impressions: number; clicks: number; costCents: number; salesCents: number; orders: number; adjustmentPct: number }
interface SelfComp { campaignId: string; name: string; status: string; asins: string[] }
// T·product — dayparting scoped to the parent product family (orders demand)
interface DemandBucket { key: number; orders: number; units: number; revenueCents: number; index: number | null }
type DemandHour = DemandBucket
interface FamCampaign { id: string; name: string; status: string; marketplace: string | null }
interface HeatCell { orders: number; units: number; revenueCents: number; familyOrders?: number; confidence?: 'high' | 'med' | 'low' }
interface ProductFamily { parentProductId: string | null; parentName: string | null; productIds: string[]; asins: string[]; campaigns: FamCampaign[]; demand: { totals: { orders: number; units: number; revenueCents: number }; hourProfile: DemandHour[]; weekdayProfile: DemandBucket[]; grid?: HeatCell[][]; hasData: boolean; blended?: boolean; familyOrders?: number; windowDays?: number } | null }
type DayRecommend = 'bid-up' | 'keep' | 'bid-down'
const MATCH_TYPES = ['BROAD', 'PHRASE', 'EXACT'] as const
const pad2 = (n: number) => String(n).padStart(2, '0')
const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0] // Mon→Sun for display
// DD4 — guided grid: each day's peak hours → the chosen level, Normal outside,
// the dead overnight → Pause. Per-day peaks (the hours differ by day).
function buildGuidedGrid(grid: HeatCell[][], level: Level, pauseOvernight: boolean): Level[][] {
  return Array.from({ length: 7 }, (_, d) => {
    const row = grid[d] ?? []
    const max = Math.max(1, ...row.map(c => c.revenueCents))
    return Array.from({ length: 24 }, (_, h) => {
      const rev = row[h]?.revenueCents ?? 0
      if (pauseOvernight && rev < max * 0.08) return 'pause' as Level
      if (rev >= max * 0.6) return level
      return 'normal' as Level
    })
  })
}
const demandRecommend = (index: number | null): DayRecommend => index == null ? 'keep' : index >= 1.2 ? 'bid-up' : index < 0.6 ? 'bid-down' : 'keep'

// ── The numbered rank ladder. Each slot maps to an Amazon placement + a
// starting bias % (the hold loop fine-tunes from there). Top-of-search slots
// also carry an impression-share TARGET (the honest rank proxy). Rest-of-search
// has no IS metric exposed, so its feedback is the placement's real spend. ──
type SlotKey = 'top1' | 'top2' | 'top3' | 'rest1' | 'rest2' | 'rest3' | 'product'
type PlacementKey = 'PLACEMENT_TOP' | 'PLACEMENT_REST_OF_SEARCH' | 'PLACEMENT_PRODUCT_PAGE'
interface Slot { k: SlotKey; group: 'top' | 'rest' | 'product'; placement: PlacementKey; rank: number | null; isTarget: number | null; push: number; short: string }
const SLOTS: Slot[] = [
  { k: 'top1', group: 'top', placement: 'PLACEMENT_TOP', rank: 1, isTarget: 0.65, push: 120, short: '1st' },
  { k: 'top2', group: 'top', placement: 'PLACEMENT_TOP', rank: 2, isTarget: 0.45, push: 70, short: '2nd' },
  { k: 'top3', group: 'top', placement: 'PLACEMENT_TOP', rank: 3, isTarget: 0.30, push: 35, short: '3rd' },
  { k: 'rest1', group: 'rest', placement: 'PLACEMENT_REST_OF_SEARCH', rank: 1, isTarget: null, push: 80, short: '1st' },
  { k: 'rest2', group: 'rest', placement: 'PLACEMENT_REST_OF_SEARCH', rank: 2, isTarget: null, push: 40, short: '2nd' },
  { k: 'rest3', group: 'rest', placement: 'PLACEMENT_REST_OF_SEARCH', rank: 3, isTarget: null, push: 15, short: '3rd' },
  { k: 'product', group: 'product', placement: 'PLACEMENT_PRODUCT_PAGE', rank: null, isTarget: null, push: 30, short: 'Product pages' },
]
// Amazon placement-report row name → canonical placement key.
const PLACEMENT_RAW: Record<string, PlacementKey> = {
  'Top of Search on-Amazon': 'PLACEMENT_TOP',
  'Other on-Amazon': 'PLACEMENT_REST_OF_SEARCH',
  'Detail Page on-Amazon': 'PLACEMENT_PRODUCT_PAGE',
}
const PLACEMENT_SHORT: Record<PlacementKey, string> = { PLACEMENT_TOP: 'Top of search', PLACEMENT_REST_OF_SEARCH: 'Rest of search', PLACEMENT_PRODUCT_PAGE: 'Product pages' }
const slotLabel = (k: SlotKey) => {
  const s = SLOTS.find(x => x.k === k)
  if (!s) return '—'
  return s.group === 'top' ? `Top of search · ${s.short}` : s.group === 'rest' ? `Rest of search · ${s.short}` : s.short
}
const euros = (c: number) => `€${(c / 100).toFixed(2)}`
// Map a campaign's current top-of-search state → the slot it effectively sits in.
function impliedSlot(topIS: number | null, currentPct: number): SlotKey {
  if (topIS != null) return topIS >= 0.55 ? 'top1' : topIS >= 0.38 ? 'top2' : topIS >= 0.20 ? 'top3' : 'rest3'
  return currentPct >= 150 ? 'top1' : currentPct >= 60 ? 'top2' : currentPct >= 15 ? 'top3' : 'rest3'
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
  // R5/R6 — per-placement spend + bias (Top / Rest / Product)
  const [placements, setPlacements] = useState<PlacementRow[]>([])
  const [selfComp, setSelfComp] = useState<SelfComp[]>([]) // R8 — same-ASIN rivals
  // T·product — dayparting scoped to the parent product family
  const [family, setFamily] = useState<ProductFamily | null>(null)
  const [whenLoading, setWhenLoading] = useState(false)
  // T2 — smart schedule params (bid-down default; pause only the dead overnight)
  const [bidUpPct, setBidUpPct] = useState(25)
  const [bidDownPct, setBidDownPct] = useState(40)
  const [pauseOvernight, setPauseOvernight] = useState(true)
  // T3 — the family's persisted AdSchedules + apply state
  const [famScheds, setFamScheds] = useState<{ id: string; campaignId: string; enabled: boolean }[]>([])
  const [schedSaving, setSchedSaving] = useState(false)
  const [schedMsg, setSchedMsg] = useState('')
  // T6 — autonomous self-refresh rule
  const [creatingRule, setCreatingRule] = useState(false)
  const [autoMsg, setAutoMsg] = useState('')
  // TR1/TR3 — time × rank grid editor + apply
  const [showGrid, setShowGrid] = useState(false)
  const [trGrid, setTrGrid] = useState<Level[][] | null>(null)
  // DD4 — guided "maintain rank at peak"
  const [guidedLevel, setGuidedLevel] = useState<Level>('strong')
  const [guidedPause, setGuidedPause] = useState(true)
  const [guidedGrid, setGuidedGrid] = useState<Level[][] | null>(null)
  const [gridSaving, setGridSaving] = useState(false)
  const [gridMsg, setGridMsg] = useState('')
  // TR5 — defend the rank during the grid's push hours
  const [gridHolding, setGridHolding] = useState(false)
  const [gridHoldMsg, setGridHoldMsg] = useState('')
  // R3 — bulk keyword manager
  const [targets, setTargets] = useState<Target[]>([])
  const [targetsLoading, setTargetsLoading] = useState(false)
  const [paste, setPaste] = useState('')
  const [kwMatch, setKwMatch] = useState<typeof MATCH_TYPES[number]>('PHRASE')
  const [parsed, setParsed] = useState<ParsedKw[] | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addMsg, setAddMsg] = useState('')
  // R4/R7 — placement bias draft (all 3 placements), apply + hold
  const [biasDraft, setBiasDraft] = useState<Record<PlacementKey, number>>({ PLACEMENT_TOP: 0, PLACEMENT_REST_OF_SEARCH: 0, PLACEMENT_PRODUCT_PAGE: 0 })
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState<{ mode: string } | null>(null)
  const [holdIS, setHoldIS] = useState(30)
  const [holdAcos, setHoldAcos] = useState(25)
  const [holding, setHolding] = useState(false)
  const [holdMsg, setHoldMsg] = useState('')

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

  // Per-campaign signals: top-of-search row (/top-of-search) + per-placement
  // spend & bias (/campaigns/:id/placements) — the spend data + bidding-%.
  const loadSignals = useCallback(async (signal?: AbortSignal) => {
    if (!campaignId) { setCur(null); setPlacements([]); return }
    setSignalsLoading(true)
    try {
      const [tos, pl, sc] = await Promise.all([
        fetch(`${getBackendUrl()}/api/advertising/top-of-search?windowDays=${WINDOW_DAYS}&marketplace=${market}`, { cache: 'no-store', signal }).then(r => r.json()).catch(() => ({ rows: [] })),
        fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/placements?windowDays=${WINDOW_DAYS}`, { cache: 'no-store', signal }).then(r => r.json()).catch(() => ({ placements: [] })),
        fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/self-competition`, { cache: 'no-store', signal }).then(r => r.json()).catch(() => ({ conflicts: [] })),
      ])
      if (signal?.aborted) return
      setSelfComp((sc.conflicts ?? []) as SelfComp[])
      const row: TosRow | null = (tos.rows ?? []).find((r: TosRow) => r.campaignId === campaignId) ?? null
      setCur(row)
      const prows: PlacementRow[] = (pl.placements ?? []).map((p: Record<string, unknown>) => {
        const key = PLACEMENT_RAW[p.placement as string]
        if (!key) return null
        return { placement: key, impressions: Number(p.impressions ?? 0), clicks: Number(p.clicks ?? 0), costCents: Math.round(Number(p.costMicros ?? 0) / 10000), salesCents: Number(p.sales7dCents ?? 0), orders: Number(p.orders7d ?? 0), adjustmentPct: Number(p.adjustmentPct ?? 0) }
      }).filter(Boolean) as PlacementRow[]
      setPlacements(prows)
      const draft: Record<PlacementKey, number> = { PLACEMENT_TOP: 0, PLACEMENT_REST_OF_SEARCH: 0, PLACEMENT_PRODUCT_PAGE: 0 }
      for (const p of prows) draft[p.placement] = p.adjustmentPct
      setBiasDraft(draft)
      if (!userMoved) setSlot(row ? impliedSlot(row.topIS, row.currentPct) : 'rest3')
    } finally { if (!signal?.aborted) setSignalsLoading(false) }
  }, [campaignId, market]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ac = new AbortController()
    setUserMoved(false)
    void loadSignals(ac.signal)
    return () => ac.abort()
  }, [loadSignals])

  // T·product — resolve the campaign to its PARENT product family + the family's
  // roll-up order demand (when the product sells) in this market. One call.
  useEffect(() => {
    if (!campaignId) { setFamily(null); return }
    const ac = new AbortController()
    setWhenLoading(true)
    fetch(`${getBackendUrl()}/api/advertising/campaigns/${encodeURIComponent(campaignId)}/product-dayparting?marketplace=${market}&windowDays=90`, { cache: 'no-store', signal: ac.signal })
      .then(r => r.json()).then(d => { if (!ac.signal.aborted) setFamily(d && Array.isArray(d.campaigns) ? d as ProductFamily : null) })
      .catch(() => {}).finally(() => { if (!ac.signal.aborted) setWhenLoading(false) })
    return () => ac.abort()
  }, [campaignId, market])

  // T·product — family demand → weekday rows + hour profile (the schedule signal).
  const demand = family?.demand?.hourProfile ?? null
  const dayRows = useMemo(() => (family?.demand?.weekdayProfile ?? []).map(w => ({ weekday: w.key, label: DOW_LABEL[w.key] ?? String(w.key), revenueCents: w.revenueCents, orders: w.orders, index: w.index, recommend: demandRecommend(w.index) })), [family])
  const maxDemand = demand && demand.length ? Math.max(1, ...demand.map(h => h.revenueCents)) : 1
  const dayLabel = (wd: number) => DOW_LABEL[wd] ?? String(wd)

  // DD4 — per-day demand peak (the hours differ by day) + one-click guided set-up.
  const dayPeaks = useMemo(() => {
    const grid = family?.demand?.grid
    if (!grid) return []
    return DOW_ORDER.map(d => {
      const row = grid[d] ?? []
      const max = Math.max(1, ...row.map(c => c.revenueCents))
      const dayTotal = row.reduce((s, c) => s + c.revenueCents, 0)
      const peakHs = row.map((c, h) => ({ h, rev: c.revenueCents })).filter(x => x.rev >= max * 0.6).map(x => x.h)
      if (peakHs.length === 0) return { d, label: DOW_LABEL[d], range: null as string | null, pct: 0 }
      const start = Math.min(...peakHs), end = (Math.max(...peakHs) + 1) % 24
      const peakRev = peakHs.reduce((s, h) => s + (row[h]?.revenueCents ?? 0), 0)
      return { d, label: DOW_LABEL[d], range: `${pad2(start)}–${pad2(end)}`, pct: dayTotal > 0 ? Math.round((peakRev / dayTotal) * 100) : 0 }
    })
  }, [family])

  const applyGuided = useCallback(() => {
    const grid = family?.demand?.grid
    if (!grid) return
    const g = buildGuidedGrid(grid, guidedLevel, guidedPause)
    setGuidedGrid(g); setTrGrid(g); setShowGrid(true)
  }, [family, guidedLevel, guidedPause])

  // T2 — generate the family schedule from demand: bid-up high-demand days,
  // bid-down low-demand days, keep average, pause the dead overnight (≈0 demand).
  const smartSchedule = useMemo(() => {
    if (!dayRows.length) return null
    const peak = dayRows.filter(d => d.recommend === 'bid-up').map(d => d.weekday)
    const weak = dayRows.filter(d => d.recommend === 'bid-down').map(d => d.weekday)
    const keep = dayRows.filter(d => d.recommend === 'keep').map(d => d.weekday)
    let activeStart = 0, activeEnd = 24, deadHours: number[] = []
    if (pauseOvernight && demand && demand.length) {
      const max = Math.max(1, ...demand.map(h => h.revenueCents))
      const thr = max * 0.05
      const live = demand.filter(h => h.revenueCents >= thr).map(h => h.key)
      if (live.length && live.length < 24) { activeStart = Math.min(...live); activeEnd = Math.max(...live) + 1; deadHours = demand.filter(h => h.revenueCents < thr).map(h => h.key) }
    }
    const windows: Array<{ days: number[]; startHour: number; endHour: number; bidMultiplierPct?: number }> = []
    if (peak.length) windows.push({ days: peak, startHour: activeStart, endHour: activeEnd, bidMultiplierPct: bidUpPct })
    if (weak.length) windows.push({ days: weak, startHour: activeStart, endHour: activeEnd, bidMultiplierPct: -bidDownPct })
    if (keep.length) windows.push({ days: keep, startHour: activeStart, endHour: activeEnd })
    return { windows, peak, weak, keep, activeStart, activeEnd, deadHours }
  }, [dayRows, demand, bidUpPct, bidDownPct, pauseOvernight])

  // T3 — the family's persisted schedules (one AdSchedule per campaign).
  const loadSchedules = useCallback(async (signal?: AbortSignal) => {
    if (!family || family.campaigns.length === 0) { setFamScheds([]); return }
    const ids = new Set(family.campaigns.map(c => c.id))
    const d = await fetch(`${getBackendUrl()}/api/advertising/schedules`, { cache: 'no-store', signal }).then(r => r.json()).catch(() => ({ items: [] }))
    if (signal?.aborted) return
    setFamScheds(((d.items ?? []) as { id: string; campaignId: string; enabled: boolean }[]).filter(s => ids.has(s.campaignId)).map(s => ({ id: s.id, campaignId: s.campaignId, enabled: s.enabled })))
  }, [family])

  useEffect(() => {
    const ac = new AbortController()
    setSchedMsg('')
    void loadSchedules(ac.signal)
    return () => ac.abort()
  }, [loadSchedules])

  // Apply the schedule to EVERY campaign in the product family (this market).
  const applySchedule = useCallback(async () => {
    if (!smartSchedule || !family || family.campaigns.length === 0) return
    setSchedSaving(true); setSchedMsg('')
    const timezone = MARKET_TZ[market] ?? 'Europe/Rome'
    const existing = new Map(famScheds.map(s => [s.campaignId, s.id]))
    let ok = 0
    for (const c of family.campaigns) {
      try {
        const sid = existing.get(c.id)
        if (sid) await fetch(`${getBackendUrl()}/api/advertising/schedules/${sid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windows: smartSchedule.windows, timezone }) })
        else await fetch(`${getBackendUrl()}/api/advertising/schedules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId: c.id, name: `Dayparting — ${family.parentName ?? 'product'} (${market})`, windows: smartSchedule.windows, timezone, enabled: false }) })
        ok += 1
      } catch { /* continue; partial result surfaced via reload */ }
    }
    setSchedMsg(ok > 0 ? 'saved' : 'error')
    setSchedSaving(false)
    void loadSchedules()
  }, [smartSchedule, family, market, famScheds, loadSchedules])

  // Enable/disable the whole family's schedules at once.
  const toggleAll = useCallback(async (enabled: boolean) => {
    if (famScheds.length === 0) return
    setSchedSaving(true)
    for (const s of famScheds) { try { await fetch(`${getBackendUrl()}/api/advertising/schedules/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }) } catch { /* ignore */ } }
    setSchedSaving(false)
    void loadSchedules()
  }, [famScheds, loadSchedules])

  // T6 — create the autonomous self-refresh rule: weekly, re-derive the family's
  // windows from fresh demand + update its schedules (refresh_dayparting action).
  const createRefreshRule = useCallback(async () => {
    if (!family?.parentProductId) return
    setCreatingRule(true); setAutoMsg('')
    const name = family.parentName ?? 'product'
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Auto-maintain dayparting — ${name} (${market})`,
          description: `Weekly: re-derive the ${name} family's dayparting windows from fresh order demand and update its schedules — bid-up high-demand days +${bidUpPct}%, bid-down low −${bidDownPct}%${pauseOvernight ? ', pause the dead overnight' : ''}. Keeps the schedule current as demand shifts.`,
          trigger: 'SCHEDULE', conditions: [],
          actions: [
            { type: 'refresh_dayparting', parentProductId: family.parentProductId, marketplace: market, bidUpPct, bidDownPct, pauseOvernight },
            { type: 'notify', target: 'operator', message: `Dayparting refreshed for ${name} (${market})` },
          ],
          scopeMarketplace: market,
          maxExecutionsPerDay: 1,
        }),
      })
      setAutoMsg(r.ok ? 'created' : 'error')
    } catch { setAutoMsg('error') }
    setCreatingRule(false)
  }, [family, market, bidUpPct, bidDownPct, pauseOvernight])

  // TR3 — compile the painted grid → windows and apply across the whole family
  // (per-market timezone, disabled-by-default; the Enabled toggle flips them all).
  const applyGrid = useCallback(async () => {
    if (!trGrid || !family || family.campaigns.length === 0) return
    const windows = compileGrid(trGrid)
    setGridSaving(true); setGridMsg('')
    const timezone = MARKET_TZ[market] ?? 'Europe/Rome'
    const existing = new Map(famScheds.map(s => [s.campaignId, s.id]))
    let ok = 0
    for (const c of family.campaigns) {
      try {
        const sid = existing.get(c.id)
        if (sid) await fetch(`${getBackendUrl()}/api/advertising/schedules/${sid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windows, timezone }) })
        else await fetch(`${getBackendUrl()}/api/advertising/schedules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId: c.id, name: `Time×rank — ${family.parentName ?? 'product'} (${market})`, windows, timezone, enabled: false }) })
        ok += 1
      } catch { /* continue */ }
    }
    setGridMsg(ok > 0 ? 'saved' : 'error')
    setGridSaving(false)
    void loadSchedules()
  }, [trGrid, family, market, famScheds, loadSchedules])

  // TR5 — defend the top rank during the grid's push hours. The placement % is
  // constant, so the grid concentrates aggression into Max/Strong hours and this
  // defense rule holds the IS target (calibrated to the strongest level painted);
  // the T4b guard keeps it from pushing while a campaign is paused.
  const createGridHold = useCallback(async () => {
    if (!family?.parentProductId || !trGrid) return
    const flat = trGrid.flat()
    const targetIS = flat.includes('max') ? 60 : flat.includes('strong') ? 45 : 30
    setGridHolding(true); setGridHoldMsg('')
    const name = family.parentName ?? 'product'
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Hold top rank ≥ ${targetIS}% — ${name} (${market})`,
          description: `Holds top-of-search impression share ≥ ${targetIS}% in ${market} for the ${name} family — calibrated to the strongest level in your time×rank grid. The grid concentrates the push into your high-demand hours; this defends the slot when ROAS allows and eases off otherwise (won't push a campaign the grid has paused).`,
          trigger: 'SCHEDULE', conditions: [],
          actions: [
            { type: 'defend_top_of_search', targetIS: targetIS / 100, targetAcos: 0.25, marketplace: market },
            { type: 'notify', target: 'operator', message: `Defending top rank ≥ ${targetIS}% for ${name} (${market})` },
          ],
          scopeMarketplace: market,
          maxExecutionsPerDay: 48,
        }),
      })
      setGridHoldMsg(r.ok ? 'created' : 'error')
    } catch { setGridHoldMsg('error') }
    setGridHolding(false)
  }, [family, trGrid, market])

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

  const pctForPlacement = useCallback((key: PlacementKey) => placements.find(p => p.placement === key)?.adjustmentPct ?? 0, [placements])
  const setBias = useCallback((key: PlacementKey, v: number) => setBiasDraft(d => ({ ...d, [key]: Math.max(0, Math.min(900, Math.round(v) || 0)) })), [])
  const PLACEMENT_ORDER: PlacementKey[] = ['PLACEMENT_TOP', 'PLACEMENT_REST_OF_SEARCH', 'PLACEMENT_PRODUCT_PAGE']
  const dirtyPlacements = PLACEMENT_ORDER.filter(k => biasDraft[k] !== pctForPlacement(k))
  const resetBias = useCallback(() => {
    const d: Record<PlacementKey, number> = { PLACEMENT_TOP: 0, PLACEMENT_REST_OF_SEARCH: 0, PLACEMENT_PRODUCT_PAGE: 0 }
    for (const p of placements) d[p.placement] = p.adjustmentPct
    setBiasDraft(d); setApplyResult(null)
  }, [placements])

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id))
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null)
    const over = e.over?.id as SlotKey | undefined
    const s = over ? SLOTS.find(x => x.k === over) : null
    if (s) { setSlot(s.k); setUserMoved(true); setApplyResult(null); setHoldMsg(''); setBias(s.placement, s.push) }
  }

  // Drag/slot only re-targets the hold loop's IS target (bias is set per placement).
  useEffect(() => {
    const s = SLOTS.find(x => x.k === slot)
    if (s?.isTarget != null) setHoldIS(Math.round(s.isTarget * 100))
  }, [slot])

  // R7 — apply ALL placement biases at once (multi-placement mixer). Amazon
  // serves a campaign in every placement simultaneously, weighted by these %s.
  const applyAll = useCallback(async () => {
    if (!campaignId) return
    setApplying(true); setApplyResult(null)
    const adjustments = PLACEMENT_ORDER.map(k => ({ placement: k, percentage: biasDraft[k] }))
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/placements`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adjustments }),
      }).then(r => r.json())
      setApplyResult({ mode: r?.mode ?? (r?.ok ? 'local' : 'error') })
    } catch { setApplyResult({ mode: 'error' }) }
    setApplying(false)
    void loadSignals()
  }, [campaignId, biasDraft, loadSignals]) // eslint-disable-line react-hooks/exhaustive-deps

  // Create the autonomous hold-the-slot loop (defend_top_of_search), targetIS
  // from the chosen rank. Allowlist-enforced + dry-run; market-scoped engine.
  const createHold = useCallback(async () => {
    if (!campaign) return
    setHolding(true); setHoldMsg('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Hold ${slotLabel(slot)} — IS ≥ ${holdIS}% (${market})`,
          description: `Holds top-of-search impression share ≥ ${holdIS}% (target rank ${slotLabel(slot)}) by tuning PLACEMENT_TOP ±15%/run, ≤900%, bounded by ${holdAcos}% ACOS — raise while below target and in budget, ease off once above or over ACOS (win the slot for least cost). Created from the Placement Cockpit for ${campaign.name}.`,
          trigger: 'SCHEDULE', conditions: [],
          actions: [
            { type: 'defend_top_of_search', targetIS: holdIS / 100, targetAcos: holdAcos / 100, marketplace: market },
            { type: 'notify', target: 'operator', message: `Holding ${slotLabel(slot)} (IS ≥ ${holdIS}%) in ${market}` },
          ],
          scopeMarketplace: market,
          maxExecutionsPerDay: 48,
        }),
      })
      setHoldMsg(r.ok ? 'created' : 'error')
    } catch { setHoldMsg('error') }
    finally { setHolding(false) }
  }, [campaign, slot, holdIS, holdAcos, market])

  const isPct = cur?.topIS != null ? cur.topIS * 100 : null
  const targetSlot = SLOTS.find(s => s.k === slot) ?? null
  const targetIsPct = targetSlot?.isTarget != null ? Math.round(targetSlot.isTarget * 100) : null
  const curRankSlot = cur?.topIS != null ? impliedSlot(cur.topIS, cur.currentPct) : null
  const topSlots = SLOTS.filter(s => s.group === 'top')
  const restSlots = SLOTS.filter(s => s.group === 'rest')
  const targetPlacementRow = targetSlot ? placements.find(p => p.placement === targetSlot.placement) ?? null : null
  const targetCurrentPct = targetSlot ? pctForPlacement(targetSlot.placement) : 0

  // R6 — spend data. dailyBudget + per-placement €/day and a first-order
  // projection at the chosen bias (CPC effect; auction volume may add more).
  const dailyBudgetCents = campaign?.dailyBudget != null && String(campaign.dailyBudget) !== '' ? Math.round(parseFloat(String(campaign.dailyBudget)) * 100) : null
  const spendRows = PLACEMENT_ORDER.map(key => {
    const r = placements.find(p => p.placement === key)
    const costCents = r?.costCents ?? 0
    const curBias = r?.adjustmentPct ?? 0
    const perDay = costCents / WINDOW_DAYS
    const newBias = biasDraft[key]
    const projPerDay = perDay * ((1 + newBias / 100) / (1 + curBias / 100))
    return { key, row: r, costCents, curBias, newBias, perDay, projPerDay, changed: newBias !== curBias }
  })
  const totalPerDay = spendRows.reduce((s, r) => s + r.perDay, 0)
  const totalProjPerDay = spendRows.reduce((s, r) => s + r.projPerDay, 0)

  // Demand coverage: % of revenue in the overnight block the schedule would pause.
  const totalRevenueCents = family?.demand?.totals?.revenueCents ?? 0
  const pausedRevenuePct = smartSchedule && totalRevenueCents > 0 && demand
    ? Math.round((smartSchedule.deadHours.reduce((s, h) => s + (demand.find(d => d.key === h)?.revenueCents ?? 0), 0) / totalRevenueCents) * 100)
    : 0

  // T4 — placement × time coupling. The top-of-search bias compounds with the
  // day's dayparting multiplier: effective bid factor = (1+top%)·(1+dayMult%).
  const topBias = biasDraft.PLACEMENT_TOP
  const couplingDays = smartSchedule ? dayRows.map(d => {
    const mult = smartSchedule.peak.includes(d.weekday) ? bidUpPct : smartSchedule.weak.includes(d.weekday) ? -bidDownPct : 0
    return { weekday: d.weekday, label: d.label, mult, eff: (1 + topBias / 100) * (1 + mult / 100) }
  }) : []
  const maxEff = couplingDays.length ? Math.max(1, ...couplingDays.map(c => c.eff)) : 1

  // T5 — budget pacing. Join the family's campaigns to the loaded list for budget
  // + Amazon delivery status; size the evening demand peak the budget must reach.
  const famDetails = (family?.campaigns ?? []).map(fc => campaigns.find(c => c.id === fc.id)).filter(Boolean) as Camp[]
  const totalDailyBudgetCents = Math.round(famDetails.reduce((s, c) => s + (parseFloat(String(c.dailyBudget ?? '0')) || 0), 0) * 100)
  const budgetLimited = famDetails.filter(c => (c.deliveryStatus && c.deliveryStatus !== 'DELIVERING') || (Array.isArray(c.deliveryReasons) && (c.deliveryReasons as unknown[]).some(r => String(r).toUpperCase().includes('BUDGET'))))
  const peakHrs = demand ? demand.filter(h => h.revenueCents >= maxDemand * 0.6) : []
  const peakRevShare = demand && totalRevenueCents > 0 ? Math.round(peakHrs.reduce((s, h) => s + h.revenueCents, 0) / totalRevenueCents * 100) : 0
  const peakRange = peakHrs.length ? `${pad2(Math.min(...peakHrs.map(h => h.key)))}:00–${pad2((Math.max(...peakHrs.map(h => h.key)) + 1) % 24)}:00` : null

  // Honest rank readout: where you're holding vs the target slot.
  const rankReadout = (() => {
    if (!cur && placements.length === 0) return null
    if (targetSlot?.group === 'rest') {
      const pr = targetPlacementRow
      return pr ? `Targeting ${slotLabel(slot)}. Rest-of-search now: ${pr.impressions.toLocaleString()} impr · ${pr.clicks} clicks · ${euros(pr.costCents)} (no IS metric for rest — using spend).` : `Targeting ${slotLabel(slot)} — no rest-of-search data in window yet.`
    }
    if (targetSlot?.group === 'product') return `Targeting product pages — bias the PLACEMENT_PRODUCT_PAGE multiplier.`
    if (!cur) return `Targeting ${slotLabel(slot)} — no top-of-search data in window yet.`
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

      {/* ── R8: self-competition warning ─────────────────────────── */}
      {selfComp.length > 0 && campaign && (
        <div className="az-selfcomp">
          <AlertTriangle size={15} />
          <span><b>Self-competition in {market}:</b> {selfComp.length} other campaign{selfComp.length === 1 ? '' : 's'} advertise the same ASIN as this one, so they bid against each other in the same auction (only your highest-eligible bid serves). {selfComp.slice(0, 3).map(c => c.name).join(', ')}{selfComp.length > 3 ? `, +${selfComp.length - 3} more` : ''}.</span>
        </div>
      )}

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

            <div className="az-rankgroup">
              <div className="az-rankgroup-head"><span className="t">Rest of search</span><span className="badge alt">below the top slots</span></div>
              <div className="az-ranktop">
                {restSlots.map(s => (
                  <DropSlot key={s.k} slot={s} numbered active={slot === s.k && !!campaign}>
                    {campaign && <DraggableCard camp={campaign} />}
                  </DropSlot>
                ))}
              </div>
            </div>

            {SLOTS.filter(s => s.group === 'product').map(s => (
              <DropSlot key={s.k} slot={s} active={slot === s.k && !!campaign}>
                {campaign && <DraggableCard camp={campaign} />}
              </DropSlot>
            ))}

            <div className="az-ladder-foot"><Info size={11} /> Drag your listing onto the rank you want. Amazon is a blind auction — this targets &amp; defends the slot via placement bid % + impression share; it can’t pin a fixed rank.</div>
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

          {targetSlot?.group === 'top' && (
            <div className="az-rankmeter-wrap">
              <span className="az-gauge-lbl">Rank · top-of-search impression share</span>
              <RankMeter isPct={isPct} targetPct={targetIsPct} />
            </div>
          )}
          {rankReadout && <div className="az-cockpit-sub">{rankReadout}</div>}

          <div className="sep" />
          <div className="row"><span>Current {targetSlot ? PLACEMENT_SHORT[targetSlot.placement] : 'placement'} bias</span><b>+{targetCurrentPct}%</b></div>
          {targetSlot?.group === 'top' ? (
            <>
              <div className="row"><span>Recommended</span><b>{cur ? `+${cur.recommendedPct}%` : '—'} {cur && <ActionChip action={cur.action} />}</b></div>
              <div className="row"><span>Top ACOS</span><b>{cur?.topAcos != null ? `${(cur.topAcos * 100).toFixed(0)}%` : '—'}</b></div>
              {cur?.reason && <div className="az-cockpit-sub">{cur.reason}.</div>}
            </>
          ) : targetPlacementRow ? (
            <>
              <div className="row"><span>Spend · 30d</span><b>{euros(targetPlacementRow.costCents)}</b></div>
              <div className="row"><span>Clicks · ACOS</span><b>{targetPlacementRow.clicks} · {targetPlacementRow.salesCents > 0 ? `${Math.round(targetPlacementRow.costCents / targetPlacementRow.salesCents * 100)}%` : '—'}</b></div>
            </>
          ) : null}

          <div className="sep" />
          {/* ── R4/R7: set this placement's bias (full mixer is the spend table) ── */}
          {!userMoved ? (
            <div className="az-cockpit-note"><Info size={12} /> Drag your listing onto a rank to set that placement's bias. Tune all three placements together in the spend mixer below.</div>
          ) : !campaign ? null : (
            <>
              <div className="az-plan-head">Set {targetSlot ? PLACEMENT_SHORT[targetSlot.placement] : ''} bias{targetSlot && targetSlot.group !== 'product' ? ` → ${slotLabel(slot)}` : ''}</div>
              <div className="az-plan-target">
                <span className="az-gauge-lbl">Bias · now +{targetCurrentPct}%</span>
                <div className="az-stepper">
                  <button type="button" onClick={() => targetSlot && setBias(targetSlot.placement, biasDraft[targetSlot.placement] - 10)} disabled={applying} aria-label="Decrease bias">−</button>
                  <span className="v">+{targetSlot ? biasDraft[targetSlot.placement] : 0}%</span>
                  <button type="button" onClick={() => targetSlot && setBias(targetSlot.placement, biasDraft[targetSlot.placement] + 10)} disabled={applying} aria-label="Increase bias">+</button>
                </div>
              </div>
              <button type="button" className="az-btn dark" style={{ marginTop: 8, width: '100%', justifyContent: 'center' }} disabled={applying || dirtyPlacements.length === 0} onClick={() => void applyAll()}>
                {applying ? <><Loader2 size={14} className="az-spin" /> Applying…</> : <><Zap size={14} /> Apply {dirtyPlacements.length || ''} placement{dirtyPlacements.length === 1 ? '' : 's'}</>}
              </button>
              {applyResult && (
                <div className="az-cockpit-sub" style={{ marginTop: 6, color: applyResult.mode === 'live' ? 'var(--green)' : applyResult.mode === 'error' ? '#cc1100' : 'var(--ink2)' }}>
                  {applyResult.mode === 'error' ? 'Apply failed — check the campaign sync status.'
                    : applyResult.mode === 'live' ? <><Check size={12} style={{ verticalAlign: 'text-bottom' }} /> Applied live on Amazon.</>
                    : <><Check size={12} style={{ verticalAlign: 'text-bottom' }} /> Staged locally ({applyResult.mode}) — not live on Amazon. Flip the write-gate to push live.</>}
                </div>
              )}

              {targetSlot?.group === 'top' && (
                <div className="az-hold">
                  <div className="az-hold-head"><ShieldCheck size={13} /> Hold {slotLabel(slot)}</div>
                  <div className="az-hold-sub">Run an autonomous loop that keeps impression share at the target for the least cost — raise while below &amp; ACOS is in budget, ease off otherwise.</div>
                  <div className="az-hold-ctls">
                    <label>Target IS <input type="number" min={1} max={100} value={holdIS} onChange={e => setHoldIS(Math.max(1, Math.min(100, Number(e.target.value))))} disabled={holding} />%</label>
                    <label>Max ACOS <input type="number" min={1} max={200} value={holdAcos} onChange={e => setHoldAcos(Math.max(1, Math.min(200, Number(e.target.value))))} disabled={holding} />%</label>
                  </div>
                  <button type="button" className="az-btn" style={{ marginTop: 8, width: '100%', justifyContent: 'center' }} disabled={holding} onClick={() => void createHold()}>
                    {holding ? <><Loader2 size={14} className="az-spin" /> Creating…</> : <><ShieldCheck size={14} /> Hold IS ≥ {holdIS}%</>}
                  </button>
                  {holdMsg === 'created' && <div className="az-cockpit-sub" style={{ marginTop: 6, color: 'var(--green)' }}><Check size={12} style={{ verticalAlign: 'text-bottom' }} /> Hold rule created (disabled + dry-run). Enable it in Active rules and allowlist this campaign to go live.</div>}
                  {holdMsg === 'error' && <div className="az-cockpit-sub" style={{ marginTop: 6, color: '#cc1100' }}>Could not create the hold rule.</div>}
                </div>
              )}
              <div className="az-cockpit-note" style={{ marginTop: 8 }}><Info size={12} /> Apply &amp; Hold are gated — sandbox stages locally until the ads write-gate is live (needs approval). The hold loop is market-scoped; allowlist this campaign to include it.</div>
            </>
          )}
        </div>
      </div>

      {/* ── R6: spend by placement + projection ──────────────────── */}
      <div className="az-spend">
        <div className="az-spend-head"><BarChart3 size={15} /> Spend by placement{campaign ? <> · <span className="cn">{campaign.name}</span></> : ''} · {WINDOW_DAYS}d
          <span style={{ flex: 1 }} />
          {dailyBudgetCents != null && <span className="az-budget-chip">Daily budget {euros(dailyBudgetCents)}</span>}
        </div>
        <div className="az-spend-tablewrap">
          <table className="az-spend-table">
            <thead><tr><th className="l">Placement</th><th>Impr</th><th>Clicks</th><th>Spend {WINDOW_DAYS}d</th><th>€/day</th><th>Sales</th><th>ACOS</th><th>Bias % (bid)</th><th>Proj €/day</th></tr></thead>
            <tbody>
              {spendRows.map(sr => {
                const r = sr.row
                const acos = r && r.salesCents > 0 ? Math.round(r.costCents / r.salesCents * 100) : null
                return (
                  <tr key={sr.key} className={targetSlot?.placement === sr.key && userMoved ? 'on' : ''}>
                    <td className="l">{PLACEMENT_SHORT[sr.key]}</td>
                    <td>{(r?.impressions ?? 0).toLocaleString()}</td>
                    <td>{r?.clicks ?? 0}</td>
                    <td>{euros(sr.costCents)}</td>
                    <td>{euros(Math.round(sr.perDay))}</td>
                    <td>{euros(r?.salesCents ?? 0)}</td>
                    <td>{acos != null ? `${acos}%` : '—'}</td>
                    <td>
                      <span className="az-bias-edit">
                        <button type="button" onClick={() => setBias(sr.key, sr.newBias - 10)} disabled={applying} aria-label="Decrease bias">−</button>
                        <input type="number" min={0} max={900} value={sr.newBias} onChange={e => setBias(sr.key, Number(e.target.value))} disabled={applying} />
                        <button type="button" onClick={() => setBias(sr.key, sr.newBias + 10)} disabled={applying} aria-label="Increase bias">+</button>
                      </span>
                      {sr.changed && <span className="was">was +{sr.curBias}%</span>}
                    </td>
                    <td className={sr.changed ? 'chg' : ''}>{euros(Math.round(sr.projPerDay))}</td>
                  </tr>
                )
              })}
              <tr className="tot">
                <td className="l">Total</td>
                <td></td><td></td>
                <td>{euros(spendRows.reduce((s, r) => s + r.costCents, 0))}</td>
                <td>{euros(Math.round(totalPerDay))}</td>
                <td></td><td></td><td></td>
                <td className={Math.round(totalProjPerDay) !== Math.round(totalPerDay) ? 'chg' : ''}>{euros(Math.round(totalProjPerDay))}{dailyBudgetCents != null && totalProjPerDay > dailyBudgetCents ? ' ⚠' : ''}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="az-spend-actions">
          <button type="button" className="az-btn dark" disabled={applying || !campaign || dirtyPlacements.length === 0} onClick={() => void applyAll()}>
            {applying ? <><Loader2 size={14} className="az-spin" /> Applying…</> : <><Zap size={14} /> Apply {dirtyPlacements.length || 'all'} placement{dirtyPlacements.length === 1 ? '' : 's'}</>}
          </button>
          {dirtyPlacements.length > 0 && <button type="button" className="az-btn" disabled={applying} onClick={resetBias}>Reset</button>}
          {applyResult && <span className="az-cockpit-sub" style={{ color: applyResult.mode === 'live' ? 'var(--green)' : applyResult.mode === 'error' ? '#cc1100' : 'var(--ink2)' }}>{applyResult.mode === 'error' ? 'Apply failed.' : applyResult.mode === 'live' ? 'Applied live on Amazon.' : `Staged (${applyResult.mode}) — not live; flip the write-gate.`}</span>}
        </div>
        <div className="az-cockpit-note"><Info size={12} /> €/day = window spend ÷ {WINDOW_DAYS}. Projection estimates the CPC effect at the chosen bias % — actual spend also depends on how many more impressions you win in the auction.{dailyBudgetCents != null && totalProjPerDay > dailyBudgetCents ? ' Projected daily spend exceeds the daily budget (Amazon will cap at the budget).' : ''}</div>
      </div>

      {/* ── T·product: When · dayparting for the product family ──── */}
      <div className="az-when">
        <div className="az-when-head"><Clock size={15} /> When · {family?.parentName ? <span className="cn">{family.parentName}</span> : 'product'} family
          <span style={{ flex: 1 }} />
          {whenLoading && <span className="az-cockpit-status">Loading…</span>}
          {!whenLoading && family && family.campaigns.length > 0 && <span className="az-cockpit-status ok">{family.campaigns.length} campaign{family.campaigns.length === 1 ? '' : 's'} · {family.asins.length} ASIN{family.asins.length === 1 ? '' : 's'} in {market}</span>}
          <a className="az-when-link" href={`/marketing/ads-console/automation?tab=dayparting&dpMarket=${market}`} title={`Open the full ${market} demand heatmap`}>Full heatmap →</a>
        </div>

        <div className="az-when-sub">Family demand by day of week — when the product sells ({market}, 90d orders)</div>
        <div className="az-when-days" role="img" aria-label={dayRows.length ? `Family demand by weekday in ${market}: ${dayRows.map(d => `${d.label} ${d.index != null ? d.index.toFixed(1) + '×' : 'n/a'}`).join(', ')}` : 'Family demand by weekday'}>
          {whenLoading && dayRows.length === 0
            ? Array.from({ length: 7 }).map((_, i) => <div key={i} className="az-dpday"><div className="lbl">&nbsp;</div><div className="bar"><div className="fill skel" style={{ height: `${25 + ((i * 17) % 55)}%` }} /></div></div>)
            : dayRows.map(d => (
              <div key={d.weekday} className={`az-dpday ${d.recommend}`} title={`${d.label}: ${euros(d.revenueCents)} · ${d.orders} orders${d.index != null ? ` · ${(d.index).toFixed(2)}× avg` : ''}`}>
                <div className="lbl">{d.label}</div>
                <div className="bar"><div className="fill" style={{ height: `${Math.max(3, Math.min(100, (d.index ?? 0) * 55))}%` }} /></div>
                <div className="val">{d.index != null ? `${d.index.toFixed(1)}×` : '—'}</div>
                <div className="rec">{d.recommend === 'bid-up' ? <TrendingUp size={11} /> : d.recommend === 'bid-down' ? <TrendingDown size={11} /> : <Minus size={11} />}</div>
              </div>
            ))}
          {dayRows.length === 0 && !whenLoading && <div className="az-cockpit-sub">No order-demand data for this product family in {market}.</div>}
        </div>

        <div className="az-when-sub" style={{ marginTop: 12 }}>Demand by day &amp; hour ({market}, Europe/Rome) — how the hours differ across days{family?.demand?.blended ? ` · blended with the market pattern where ${family.parentName ?? 'this product'} is thin (${family.demand.familyOrders} orders, ${family.demand.windowDays}d)` : ''}</div>
        {whenLoading && !family?.demand?.grid
          ? <div className="az-heat-skel">{Array.from({ length: 7 }).map((_, i) => <div key={i} className="r" />)}</div>
          : <DemandHeatmap grid={family?.demand?.grid ?? null} />}
        {!family?.demand?.grid && !whenLoading && <div className="az-cockpit-sub">No order-demand data for {market}.</div>}

        {/* ── DD4: guided "maintain rank at peak" (lead set-up) ────── */}
        {family && family.demand?.grid && family.campaigns.length > 0 && (
          <div className="az-guided">
            <div className="az-guided-head"><Sparkles size={14} /> Maintain your rank when it sells</div>
            <div className="az-guided-row">
              <span>Maintain</span>
              <select value={guidedLevel} onChange={e => setGuidedLevel(e.target.value as Level)}><option value="max">Max</option><option value="strong">Strong</option></select>
              <span>rank during each day&apos;s peak hours, Normal outside.</span>
              <label className="az-sched-check"><input type="checkbox" checked={guidedPause} onChange={e => setGuidedPause(e.target.checked)} /> Pause dead overnight</label>
              <span style={{ flex: 1 }} />
              <button type="button" className="az-btn dark" onClick={applyGuided}><Sparkles size={14} /> Set it up</button>
            </div>
            <div className="az-guided-peaks">
              {dayPeaks.map(p => <span key={p.d} className="it"><b>{p.label}</b> {p.range ? `${p.range} · ${p.pct}%` : '—'}</span>)}
            </div>
            <div className="az-cockpit-sub">Detected each day&apos;s sales peak from {family.parentName ?? 'the product'}&apos;s demand — the hours genuinely differ by day. &ldquo;Set it up&rdquo; fills the grid below; review &amp; apply there.</div>
          </div>
        )}

        {/* ── T5: budget pacing ────────────────────────────────────── */}
        {family && family.campaigns.length > 0 && totalDailyBudgetCents > 0 && (
          <div className={`az-budget-pace ${budgetLimited.length > 0 ? 'warn' : ''}`}>
            <Wallet size={14} />
            <span>
              Family budget <b>{euros(totalDailyBudgetCents)}/day</b> across {family.campaigns.length} campaigns.{' '}
              {budgetLimited.length > 0
                ? <><b>{budgetLimited.length} budget-limited</b> — likely exhausting before peak. </>
                : 'All delivering. '}
              {peakRange && <>Peak demand <b>{peakRange}</b> carries <b>{peakRevShare}%</b> of revenue{peakRevShare >= 40 ? ' — concentrate the limited budget there: the schedule pauses dead hours so spend survives to peak' : ''}.</>}
            </span>
          </div>
        )}

        {/* ── TR1: time × rank grid editor ─────────────────────────── */}
        {family && family.campaigns.length > 0 && (
          <div className="az-tr-section">
            <button type="button" className="az-tr-toggle" onClick={() => setShowGrid(v => !v)} aria-expanded={showGrid}>
              <Sparkles size={13} /> Time × rank grid — paint the rank/pause for every hour {showGrid ? '▾' : '▸'}
            </button>
            {showGrid && <>
              <div className="az-cockpit-sub" style={{ marginTop: 6 }}>Seeded from {family.parentName ?? 'the family'}&apos;s demand. Paint each hour: <b>Max/Strong</b> push for higher rank, <b>Light</b> eases off, <b>Pause</b> stops spend (e.g. 2am). Applies across all {family.campaigns.length} campaigns ({MARKET_TZ[market] ?? 'Europe/Rome'}). Apply lands in TR3.</div>
              <TimeRankGrid demandGrid={family.demand?.grid ?? null} onChange={setTrGrid} pushGrid={guidedGrid} />
              <div className="az-sched-actions">
                <button type="button" className="az-btn dark" disabled={gridSaving || !trGrid || family.campaigns.length === 0} onClick={() => void applyGrid()}>
                  {gridSaving ? <><Loader2 size={14} className="az-spin" /> Saving…</> : <><Clock size={14} /> Apply grid to {family.campaigns.length} campaign{family.campaigns.length === 1 ? '' : 's'}</>}
                </button>
                {famScheds.length > 0 && <label className="az-sched-toggle"><input type="checkbox" checked={famScheds.every(s => s.enabled)} disabled={gridSaving} onChange={e => void toggleAll(e.target.checked)} /> Enabled ({famScheds.filter(s => s.enabled).length}/{famScheds.length})</label>}
                {trGrid && <span className="az-cockpit-sub" style={{ margin: 0 }}>{trGrid.flat().filter(l => l === 'pause').length}h/week paused</span>}
                {gridMsg === 'saved' && <span className="az-cockpit-sub" style={{ margin: 0, color: 'var(--green)' }}><Check size={12} style={{ verticalAlign: 'text-bottom' }} /> Saved across the family{famScheds.length && !famScheds.every(s => s.enabled) ? ' — toggle Enabled to run' : ''}</span>}
                {gridMsg === 'error' && <span className="az-cockpit-sub" style={{ margin: 0, color: '#cc1100' }}>Save failed</span>}
              </div>
              <div className="az-cockpit-note" style={{ marginTop: 8 }}><Info size={12} /> Compiles to a delivery schedule across <b>all {family.campaigns.length} campaigns</b> in <b>{MARKET_TZ[market] ?? 'Europe/Rome'}</b> — Pause hours stop spend, Max/Strong/Light scale bids per hour (the cron now transitions cleanly between levels). Starts <b>disabled</b>; writes are gated (sandbox stages locally until the write-gate is live). Enforced at hour boundaries on the cron tick.</div>
              <div className="az-sched-actions" style={{ borderTop: '1px solid var(--divider)', marginTop: 10, paddingTop: 10 }}>
                <button type="button" className="az-btn" disabled={gridHolding || !family?.parentProductId} onClick={() => void createGridHold()}>
                  {gridHolding ? <><Loader2 size={14} className="az-spin" /> Creating…</> : <><ShieldCheck size={14} /> Defend top rank in push hours</>}
                </button>
                <span className="az-cockpit-sub" style={{ margin: 0 }}>Holds the IS target where you painted Max/Strong</span>
                {gridHoldMsg === 'created' && <span className="az-cockpit-sub" style={{ margin: 0, color: 'var(--green)' }}><Check size={12} style={{ verticalAlign: 'text-bottom' }} /> Defense rule created (disabled + dry-run) — enable in Active rules.</span>}
                {gridHoldMsg === 'error' && <span className="az-cockpit-sub" style={{ margin: 0, color: '#cc1100' }}>Could not create the rule.</span>}
              </div>
            </>}
          </div>
        )}

        {/* ── T2/T3: demand-auto smart schedule (alternative to the grid) ── */}
        {!showGrid && smartSchedule && (smartSchedule.peak.length > 0 || smartSchedule.weak.length > 0 || smartSchedule.deadHours.length > 0) ? (
          <div className="az-sched">
            <div className="az-sched-head"><Sparkles size={14} /> Smart schedule <span className="tag">preview</span></div>
            <div className="az-sched-sum">
              {smartSchedule.peak.length > 0 && <>Bid <b>+{bidUpPct}%</b> on <b>{smartSchedule.peak.map(dayLabel).join(', ')}</b> (best selling). </>}
              {smartSchedule.weak.length > 0 && <>Bid <b>−{bidDownPct}%</b> on <b>{smartSchedule.weak.map(dayLabel).join(', ')}</b> (low demand). </>}
              {smartSchedule.keep.length > 0 && <>Keep {smartSchedule.keep.map(dayLabel).join(', ')}. </>}
              {pauseOvernight && smartSchedule.deadHours.length > 0 && <>Pause <b>{pad2(smartSchedule.activeEnd % 24)}:00–{pad2(smartSchedule.activeStart)}:00</b> ({pausedRevenuePct <= 1 ? '≈0' : `${pausedRevenuePct}%`} of revenue). </>}
            </div>
            <div className="az-sched-ctls">
              <label>Bid-up <input type="number" min={0} max={900} value={bidUpPct} onChange={e => setBidUpPct(Math.max(0, Math.min(900, Number(e.target.value) || 0)))} />%</label>
              <label>Bid-down <input type="number" min={0} max={99} value={bidDownPct} onChange={e => setBidDownPct(Math.max(0, Math.min(99, Number(e.target.value) || 0)))} />%</label>
              <label className="az-sched-check"><input type="checkbox" checked={pauseOvernight} onChange={e => setPauseOvernight(e.target.checked)} /> Pause dead overnight hours</label>
            </div>
            <div className="az-sched-actions">
              <button type="button" className="az-btn dark" disabled={schedSaving || !family || family.campaigns.length === 0} onClick={() => void applySchedule()}>
                {schedSaving ? <><Loader2 size={14} className="az-spin" /> Saving…</> : <><Clock size={14} /> Apply to {family?.campaigns.length ?? 0} campaign{(family?.campaigns.length ?? 0) === 1 ? '' : 's'}</>}
              </button>
              {famScheds.length > 0 && <label className="az-sched-toggle"><input type="checkbox" checked={famScheds.every(s => s.enabled)} disabled={schedSaving} onChange={e => void toggleAll(e.target.checked)} /> Enabled ({famScheds.filter(s => s.enabled).length}/{famScheds.length})</label>}
              {schedMsg === 'saved' && <span className="az-cockpit-sub" style={{ margin: 0, color: 'var(--green)' }}><Check size={12} style={{ verticalAlign: 'text-bottom' }} /> Saved across the family{famScheds.length && !famScheds.every(s => s.enabled) ? ' — toggle Enabled to run' : ''}</span>}
              {schedMsg === 'error' && <span className="az-cockpit-sub" style={{ margin: 0, color: '#cc1100' }}>Save failed</span>}
            </div>
            <div className="az-cockpit-note" style={{ marginTop: 8 }}><Info size={12} /> One schedule applied to <b>all {family?.campaigns.length ?? 0} {family?.parentName ?? 'product'} campaigns in {market}</b>, enforced in <b>{MARKET_TZ[market] ?? 'Europe/Rome'}</b>. Starts <b>disabled</b> — enable to run. The cron bid-adjusts low-demand days &amp; pauses the dead overnight; writes are gated (sandbox stages locally until the ads write-gate is live). Disabling/deleting auto-resumes a paused campaign.</div>

            {/* ── T6: autonomous self-refresh ─────────────────────── */}
            <div className="az-sched-actions" style={{ borderTop: '1px solid var(--divider)', marginTop: 10, paddingTop: 10 }}>
              <button type="button" className="az-btn" disabled={creatingRule || !family?.parentProductId} onClick={() => void createRefreshRule()}>
                {creatingRule ? <><Loader2 size={14} className="az-spin" /> Creating…</> : <><Sparkles size={14} /> Auto-maintain weekly</>}
              </button>
              <span className="az-cockpit-sub" style={{ margin: 0 }}>Self-refresh the schedule from fresh demand as it shifts</span>
              {autoMsg === 'created' && <span className="az-cockpit-sub" style={{ margin: 0, color: 'var(--green)' }}><Check size={12} style={{ verticalAlign: 'text-bottom' }} /> Auto-maintain rule created (disabled + dry-run) — enable it in Active rules.</span>}
              {autoMsg === 'error' && <span className="az-cockpit-sub" style={{ margin: 0, color: '#cc1100' }}>Could not create the rule.</span>}
            </div>
          </div>
        ) : family && family.campaigns.length > 0 && !whenLoading ? (
          <div className="az-cockpit-sub" style={{ marginTop: 8 }}>Demand is even across the week — no day-level schedule needed yet.</div>
        ) : null}

        {/* ── T4: placement × time coupling ────────────────────────── */}
        {smartSchedule && couplingDays.length > 0 && (topBias > 0 ? (
          <div className="az-couple">
            <div className="az-when-sub" style={{ marginTop: 4 }}>Top-of-search push × demand — effective aggressiveness by day (placement +{topBias}% compounded with the schedule)</div>
            <div className="az-couple-days">
              {couplingDays.map(c => (
                <div key={c.weekday} className={`az-couplecell ${c.mult > 0 ? 'up' : c.mult < 0 ? 'down' : ''}`} title={`${c.label}: placement +${topBias}% × time ${c.mult >= 0 ? '+' : ''}${c.mult}% = ${c.eff.toFixed(2)}× base bid`}>
                  <div className="lbl">{c.label}</div>
                  <div className="bar"><div className="fill" style={{ height: `${Math.max(4, (c.eff / maxEff) * 100)}%` }} /></div>
                  <div className="val">{c.eff.toFixed(1)}×</div>
                </div>
              ))}
            </div>
            <div className="az-cockpit-sub">Your top-of-search push runs full-strength on high-demand days and is throttled on low-demand days — you win the slot when it converts and ease off when it doesn&apos;t. The hold-loop also won&apos;t raise the slot while a campaign is paused by the schedule.</div>
          </div>
        ) : (
          <div className="az-cockpit-sub" style={{ marginTop: 6 }}>Set a <b>Top-of-search</b> bias in the spend mixer above to see it compounded with this schedule (full on high-demand days, throttled on low-demand days).</div>
        ))}

        <div className="az-cockpit-note"><Info size={12} /> Timing is a product property, so this covers the whole parent family (all variants &amp; their campaigns) in {market}. Demand is order-placed time (Europe/Rome) — a live proxy until Amazon Marketing Stream provides true hourly ad data.</div>
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
