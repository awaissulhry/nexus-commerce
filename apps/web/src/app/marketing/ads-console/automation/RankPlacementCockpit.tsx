'use client'

/**
 * Rank Control — Placement Cockpit (RC2 series).
 *
 * P1: visual shell + drag-drop placement ladder.
 * P2 (this file): wire REAL signals. Picking a product + market resolves the
 * product's campaigns (/by-product/campaigns), their top-of-search impression
 * share + current placement multiplier + recommendation (/top-of-search), and
 * the keyword's share-of-voice (/share-of-voice). The ladder initialises the
 * card to where the product actually sits today; the strategy panel shows the
 * live IS gauge, current vs recommended top-of-search %, blended ACOS and a
 * per-campaign breakdown. Still read-only — bid-to-win + Apply land in P3.
 *
 * Honest model: Amazon's API exposes no literal SERP rank, so the ladder is a
 * CONTROL METAPHOR — drag = your TARGET placement; impression-share is the real
 * "are you showing there" proxy (null until the IS ingest has run).
 */

import { useEffect, useMemo, useState } from 'react'
import { DndContext, useDraggable, useDroppable, DragOverlay, type DragEndEvent, type DragStartEvent, PointerSensor, KeyboardSensor, useSensor, useSensors } from '@dnd-kit/core'
import { Search, GripVertical, Info, ArrowUp, Crosshair, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

const MARKETS = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK', 'All']
const WINDOW_DAYS = 30
const TOP_TIER_THRESHOLD = 30 // currentPct ≥ this ⇒ product already biased to top-of-search

interface Prod { id: string; name: string; asin: string | null; photoUrl: string | null; marketCount?: number }
interface Sov { query: string; impressions: number; sovPct: number }
interface CampRow { id: string; name: string; marketplace: string | null; status: string; acos: number | null; adSpendCents: number; impressions: number }
interface TosRow { campaignId: string; name: string; marketplace: string | null; topImpr: number; topSpendCents: number; topSalesCents: number; topAcos: number | null; topIS: number | null; currentPct: number; recommendedPct: number; action: 'raise' | 'lower' | 'keep'; reason: string }
interface Agg {
  campaignCount: number
  topIS: number | null
  currentPct: number
  recommendedPct: number
  action: 'raise' | 'lower' | 'keep'
  reason: string
  blendedAcos: number | null
  perCampaign: TosRow[]
}

type TierKey = 'top' | 'rest' | 'product'
const TIERS: Array<{ k: TierKey; label: string; hint: string; accent: string }> = [
  { k: 'top', label: 'Top of search', hint: 'Page 1, above the fold — most visible, most competitive (≈3 sponsored slots).', accent: 'var(--navy)' },
  { k: 'rest', label: 'Rest of search', hint: 'Lower / later search results — cheaper reach.', accent: 'var(--ink3)' },
  { k: 'product', label: 'Product pages', hint: 'On competitors’ and related detail pages.', accent: 'var(--ink3)' },
]

// ── Draggable product card ─────────────────────────────────────────────
function ProductCard({ prod, dragging }: { prod: Prod; dragging?: boolean }) {
  return (
    <div className={`az-prodcard ${dragging ? 'drag' : ''}`}>
      <GripVertical size={14} className="grip" />
      {prod.photoUrl ? <img src={prod.photoUrl} alt="" className="ph" /> : <div className="ph ph-empty" />}
      <div className="meta">
        <div className="nm">{prod.name}</div>
        <div className="as">{prod.asin ?? '—'}</div>
      </div>
      <span className="you">YOU</span>
    </div>
  )
}
function DraggableProduct({ prod }: { prod: Prod }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: 'product' })
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} style={{ opacity: isDragging ? 0.3 : 1, cursor: 'grab', touchAction: 'none' }}>
      <ProductCard prod={prod} />
    </div>
  )
}

// ── Droppable tier ─────────────────────────────────────────────────────
function Tier({ tierKey, label, hint, accent, active, children }: { tierKey: TierKey; label: string; hint: string; accent: string; active: boolean; children?: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: tierKey })
  return (
    <div ref={setNodeRef} className={`az-tier ${active ? 'has-you' : ''} ${isOver ? 'over' : ''}`} style={{ borderLeftColor: accent }}>
      <div className="az-tier-head">
        <span className="t">{label}</span>
        {active && <span className="badge">YOUR TARGET</span>}
      </div>
      <div className="az-tier-slots">
        {!active && Array.from({ length: tierKey === 'top' ? 3 : 4 }).map((_, i) => <div key={i} className="az-slot-ghost" />)}
        {children}
        {!active && <span className="az-tier-hint">{hint}</span>}
      </div>
    </div>
  )
}

// ── Gauge ───────────────────────────────────────────────────────────────
function Gauge({ pct, target, tone }: { pct: number | null; target?: number; tone?: 'is' | 'sov' }) {
  const v = pct == null ? null : Math.max(0, Math.min(100, pct))
  return (
    <div className="az-gauge">
      <div className="az-gauge-track">
        {v != null && <div className={`az-gauge-fill ${tone ?? ''}`} style={{ width: `${v}%` }} />}
        {target != null && <div className="az-gauge-mark" style={{ left: `${Math.max(0, Math.min(100, target))}%` }} title={`Target ${target}%`} />}
      </div>
      <span className="az-gauge-val">{v == null ? '—' : `${v.toFixed(0)}%`}</span>
    </div>
  )
}

const ActionChip = ({ action }: { action: Agg['action'] }) => (
  <span className={`az-act ${action}`}>
    {action === 'raise' ? <TrendingUp size={11} /> : action === 'lower' ? <TrendingDown size={11} /> : <Minus size={11} />}
    {action === 'raise' ? 'Raise' : action === 'lower' ? 'Ease off' : 'Hold'}
  </span>
)

export function RankPlacementCockpit() {
  const [market, setMarket] = useState('IT')
  const [products, setProducts] = useState<Prod[]>([])
  const [productId, setProductId] = useState<string>('')
  const [keywords, setKeywords] = useState<Sov[]>([])
  const [keyword, setKeyword] = useState<string>('')
  const [tier, setTier] = useState<TierKey>('rest')
  const [activeId, setActiveId] = useState<string | null>(null)
  // P2 live signals
  const [agg, setAgg] = useState<Agg | null>(null)
  const [signalsLoading, setSignalsLoading] = useState(false)
  const [signalErr, setSignalErr] = useState(false)
  const [userMoved, setUserMoved] = useState(false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor))

  // Products (real, with photos) for the picker
  useEffect(() => {
    void fetch(`${getBackendUrl()}/api/advertising/by-product?windowDays=30&limit=200`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        const rows: Prod[] = (d.rows ?? []).map((p: Record<string, unknown>) => ({ id: p.id as string, name: p.name as string, asin: (p.asin as string) ?? null, photoUrl: (p.photoUrl as string) ?? null, marketCount: p.marketCount as number }))
        setProducts(rows)
        if (rows.length && !productId) setProductId(rows[0].id)
      }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Keyword context options (market SoV queries)
  useEffect(() => {
    void fetch(`${getBackendUrl()}/api/advertising/share-of-voice?windowDays=30&limit=60`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        const rows: Sov[] = (d.rows ?? []).map((s: Record<string, unknown>) => ({ query: s.query as string, impressions: s.impressions as number, sovPct: s.sovPct as number }))
        setKeywords(rows)
        if (rows.length && !keyword) setKeyword(rows[0].query)
      }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── P2: resolve the product's campaigns + their top-of-search state ──────
  useEffect(() => {
    if (!productId) return
    let cancelled = false
    setSignalsLoading(true); setSignalErr(false); setUserMoved(false)
    const mq = market === 'All' ? '' : `&marketplace=${market}`
    Promise.all([
      fetch(`${getBackendUrl()}/api/advertising/by-product/campaigns?productId=${encodeURIComponent(productId)}&windowDays=${WINDOW_DAYS}${mq}`, { cache: 'no-store' }).then(r => r.json()).catch(() => ({ rows: [] })),
      fetch(`${getBackendUrl()}/api/advertising/top-of-search?windowDays=${WINDOW_DAYS}${mq}`, { cache: 'no-store' }).then(r => r.json()).catch(() => ({ rows: [] })),
    ]).then(([campD, tosD]) => {
      if (cancelled) return
      const camps: CampRow[] = campD.rows ?? []
      const mineIds = new Set(camps.map(c => c.id))
      const tosRows: TosRow[] = (tosD.rows ?? []).filter((r: TosRow) => mineIds.has(r.campaignId))
      if (tosRows.length === 0) { setAgg(camps.length ? { campaignCount: camps.length, topIS: null, currentPct: 0, recommendedPct: 0, action: 'keep', reason: 'no top-of-search spend in window', blendedAcos: null, perCampaign: [] } : null); setTier('rest'); setSignalsLoading(false); return }
      const totImpr = tosRows.reduce((s, r) => s + (r.topImpr || 0), 0)
      const isRows = tosRows.filter(r => r.topIS != null)
      const isImpr = isRows.reduce((s, r) => s + (r.topImpr || 0), 0)
      const wTopIS = isImpr > 0 ? isRows.reduce((s, r) => s + (r.topIS as number) * (r.topImpr || 0), 0) / isImpr : (isRows.length ? isRows.reduce((s, r) => s + (r.topIS as number), 0) / isRows.length : null)
      const totSpend = tosRows.reduce((s, r) => s + (r.topSpendCents || 0), 0)
      const totSales = tosRows.reduce((s, r) => s + (r.topSalesCents || 0), 0)
      const curPct = totImpr > 0 ? Math.round(tosRows.reduce((s, r) => s + r.currentPct * (r.topImpr || 0), 0) / totImpr) : Math.round(tosRows.reduce((s, r) => s + r.currentPct, 0) / tosRows.length)
      const rep = [...tosRows].sort((a, b) => b.topSpendCents - a.topSpendCents)[0]
      const next: Agg = {
        campaignCount: camps.length || tosRows.length,
        topIS: wTopIS,
        currentPct: curPct,
        recommendedPct: rep?.recommendedPct ?? curPct,
        action: rep?.action ?? 'keep',
        reason: rep?.reason ?? 'within target',
        blendedAcos: totSales > 0 ? totSpend / totSales : null,
        perCampaign: [...tosRows].sort((a, b) => b.topSpendCents - a.topSpendCents).slice(0, 6),
      }
      setAgg(next)
      // Initialise the card to where the product actually sits today.
      setTier(curPct >= TOP_TIER_THRESHOLD || (wTopIS != null && wTopIS >= 0.4) ? 'top' : 'rest')
      setSignalsLoading(false)
    }).catch(() => { if (!cancelled) { setSignalErr(true); setSignalsLoading(false) } })
    return () => { cancelled = true }
  }, [productId, market])

  const product = useMemo(() => products.find(p => p.id === productId) ?? null, [products, productId])
  const kwSov = useMemo(() => keywords.find(k => k.query === keyword) ?? null, [keywords, keyword])

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id))
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null)
    const over = e.over?.id
    if (over === 'top' || over === 'rest' || over === 'product') { setTier(over); setUserMoved(true) }
  }

  const tierLabel = TIERS.find(t => t.k === tier)?.label ?? 'Rest of search'
  const isPct = agg?.topIS != null ? agg.topIS * 100 : null

  return (
    <div className="az-cockpit">
      {/* ── Context bar ─────────────────────────────── */}
      <div className="az-cockpit-bar">
        <label className="ctl"><span className="lbl">Product</span>
          <select value={productId} onChange={e => setProductId(e.target.value)}>
            {products.length === 0 && <option>Loading…</option>}
            {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="ctl"><span className="lbl">Keyword</span>
          <div className="kw-wrap">
            <Search size={13} />
            <select value={keyword} onChange={e => setKeyword(e.target.value)}>
              {keywords.length === 0 && <option>Loading…</option>}
              {keywords.map(k => <option key={k.query} value={k.query}>{k.query}</option>)}
            </select>
          </div>
        </label>
        <label className="ctl"><span className="lbl">Market</span>
          <select value={market} onChange={e => setMarket(e.target.value)}>{MARKETS.map(m => <option key={m}>{m === 'All' ? 'All markets' : m}</option>)}</select>
        </label>
        <span style={{ flex: 1 }} />
        {signalsLoading && <span className="az-cockpit-status">Loading live signals…</span>}
        {!signalsLoading && agg && <span className="az-cockpit-status ok">{agg.campaignCount} campaign{agg.campaignCount === 1 ? '' : 's'} · {WINDOW_DAYS}d</span>}
        {!signalsLoading && !agg && !signalErr && <span className="az-cockpit-status">No campaigns for this product{market !== 'All' ? ` in ${market}` : ''}</span>}
      </div>

      <div className="az-cockpit-body">
        {/* ── Placement ladder ───────────────────────── */}
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div className="az-ladder">
            <div className="az-ladder-cap"><ArrowUp size={13} /> More visible · more competitive · costs more</div>
            {TIERS.map(t => (
              <Tier key={t.k} tierKey={t.k} label={t.label} hint={t.hint} accent={t.accent} active={tier === t.k}>
                {tier === t.k && product && <DraggableProduct prod={product} />}
              </Tier>
            ))}
            <div className="az-ladder-foot"><Info size={11} /> Drag your product to the placement you want to win. The card starts where your campaigns actually sit today. Amazon is an auction — this targets &amp; defends the slot; it can’t pin a fixed rank.</div>
          </div>
          <DragOverlay>{activeId && product ? <ProductCard prod={product} dragging /> : null}</DragOverlay>
        </DndContext>

        {/* ── Strategy panel — live read-only signals (P3 wires Apply) ── */}
        <div className="az-cockpit-panel">
          <div className="az-cockpit-panel-head"><Crosshair size={15} /> Strategy</div>
          <div className="row"><span>Product</span><b>{product?.name ?? '—'}</b></div>
          <div className="row"><span>Keyword</span><b>{keyword || '—'}</b></div>
          <div className="row"><span>Market</span><b>{market}</b></div>
          <div className="sep" />
          <div className="row"><span>Target placement</span><b>{tierLabel}{userMoved ? '' : ' (current)'}</b></div>

          {/* Top-of-search impression share — the real "are you showing there" proxy */}
          <div className="az-gauge-row">
            <span className="az-gauge-lbl">Top-of-search IS{tier === 'top' ? ' · target 40%' : ''}</span>
            <Gauge pct={isPct} target={tier === 'top' ? 40 : undefined} tone="is" />
          </div>
          {agg && agg.topIS == null && <div className="az-cockpit-sub">IS not ingested yet — recommendation falls back to ACOS.</div>}

          {/* Keyword share-of-voice */}
          <div className="az-gauge-row">
            <span className="az-gauge-lbl">Keyword share-of-voice</span>
            <Gauge pct={kwSov?.sovPct ?? null} tone="sov" />
          </div>

          <div className="sep" />
          <div className="row"><span>Current top-of-search %</span><b>{agg ? `+${agg.currentPct}%` : '—'}</b></div>
          <div className="row"><span>Recommended</span><b>{agg ? `+${agg.recommendedPct}%` : '—'} {agg && <ActionChip action={agg.action} />}</b></div>
          <div className="row"><span>Blended ACOS</span><b>{agg?.blendedAcos != null ? `${(agg.blendedAcos * 100).toFixed(0)}%` : '—'}</b></div>
          {agg?.reason && <div className="az-cockpit-sub">{agg.reason}.</div>}

          {agg && agg.perCampaign.length > 0 && (
            <>
              <div className="sep" />
              <div className="az-cockpit-sublbl">Per campaign</div>
              {agg.perCampaign.map(c => (
                <div key={c.campaignId} className="az-campline">
                  <span className="nm" title={c.name}>{c.name}</span>
                  <span className="pct">+{c.currentPct}%</span>
                  <ActionChip action={c.action} />
                </div>
              ))}
            </>
          )}

          <div className="az-cockpit-note">
            <Info size={12} /> Read-only preview. One-click <b>Apply</b> (set placement % + bid-to-win) and the <b>hold-the-slot</b> loop land in the next phases. Use <b>Advanced</b> for live placement control today.
          </div>
        </div>
      </div>
    </div>
  )
}
