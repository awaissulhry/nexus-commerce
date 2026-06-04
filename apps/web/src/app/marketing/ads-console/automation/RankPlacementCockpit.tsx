'use client'

/**
 * Rank Control — Placement Cockpit (RC2 series).
 *
 * P1: visual shell + drag-drop placement ladder.
 * P2: wire REAL signals. Picking a product + market resolves the product's
 * campaigns (/by-product/campaigns), their top-of-search impression share +
 * current placement multiplier + recommendation (/top-of-search), and the
 * keyword's share-of-voice (/share-of-voice).
 * P3 (this file): drop → plan + bid-to-win + sandbox Apply. Dragging the card
 * to a tier computes a per-campaign placement-% plan (TOP_OF_SEARCH lever) and
 * a bid-to-win for the selected keyword (/bid-suggestions). "Apply" pushes the
 * plan via /top-of-search/apply, which is gated: with the ads write-gate closed
 * it stages the change locally (mode:'local', sandbox) without touching live
 * Amazon ads; the result surfaces which mode it took. Hold-the-slot loop = P4.
 *
 * Honest model: Amazon's API exposes no literal SERP rank, so the ladder is a
 * CONTROL METAPHOR — drag = your TARGET placement; impression-share is the real
 * "are you showing there" proxy (null until the IS ingest has run).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { DndContext, useDraggable, useDroppable, DragOverlay, type DragEndEvent, type DragStartEvent, PointerSensor, KeyboardSensor, useSensor, useSensors } from '@dnd-kit/core'
import { Search, GripVertical, Info, ArrowUp, Crosshair, TrendingUp, TrendingDown, Minus, Check, Loader2, Zap } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

const MARKETS = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK', 'All']
const WINDOW_DAYS = 30
const TOP_TIER_THRESHOLD = 30 // currentPct ≥ this ⇒ product already biased to top-of-search

interface Prod { id: string; name: string; asin: string | null; photoUrl: string | null; marketCount?: number }
interface Sov { query: string; impressions: number; sovPct: number }
interface CampRow { id: string; name: string; marketplace: string | null; status: string; acos: number | null; adSpendCents: number; impressions: number }
interface TosRow { campaignId: string; name: string; marketplace: string | null; topImpr: number; topSpendCents: number; topSalesCents: number; topAcos: number | null; topIS: number | null; currentPct: number; recommendedPct: number; action: 'raise' | 'lower' | 'keep'; reason: string }
interface Bid { suggestedBidCents: number; lowCents: number; highCents: number; basis: string; samples: number }
interface PlanItem { campaignId: string; name: string; fromPct: number; toPct: number }
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
  // P3 — plan + bid-to-win + apply
  const [targetPct, setTargetPct] = useState(50)
  const [bid, setBid] = useState<Bid | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState<{ mode: string; count: number } | null>(null)

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
  // Extracted so P3's Apply can refresh the panel after a write. `keepTier`
  // preserves the operator's dragged tier on a post-apply reload.
  const loadSignals = useCallback(async (signal?: AbortSignal, keepTier?: boolean) => {
    if (!productId) return
    setSignalsLoading(true); setSignalErr(false)
    const mq = market === 'All' ? '' : `&marketplace=${market}`
    try {
      const [campD, tosD] = await Promise.all([
        fetch(`${getBackendUrl()}/api/advertising/by-product/campaigns?productId=${encodeURIComponent(productId)}&windowDays=${WINDOW_DAYS}${mq}`, { cache: 'no-store', signal }).then(r => r.json()).catch(() => ({ rows: [] })),
        fetch(`${getBackendUrl()}/api/advertising/top-of-search?windowDays=${WINDOW_DAYS}${mq}`, { cache: 'no-store', signal }).then(r => r.json()).catch(() => ({ rows: [] })),
      ])
      if (signal?.aborted) return
      const camps: CampRow[] = campD.rows ?? []
      const mineIds = new Set(camps.map(c => c.id))
      const tosRows: TosRow[] = (tosD.rows ?? []).filter((r: TosRow) => mineIds.has(r.campaignId))
      if (tosRows.length === 0) {
        setAgg(camps.length ? { campaignCount: camps.length, topIS: null, currentPct: 0, recommendedPct: 0, action: 'keep', reason: 'no top-of-search spend in window', blendedAcos: null, perCampaign: [] } : null)
        if (!keepTier) setTier('rest')
        return
      }
      const totImpr = tosRows.reduce((s, r) => s + (r.topImpr || 0), 0)
      const isRows = tosRows.filter(r => r.topIS != null)
      const isImpr = isRows.reduce((s, r) => s + (r.topImpr || 0), 0)
      const wTopIS = isImpr > 0 ? isRows.reduce((s, r) => s + (r.topIS as number) * (r.topImpr || 0), 0) / isImpr : (isRows.length ? isRows.reduce((s, r) => s + (r.topIS as number), 0) / isRows.length : null)
      const totSpend = tosRows.reduce((s, r) => s + (r.topSpendCents || 0), 0)
      const totSales = tosRows.reduce((s, r) => s + (r.topSalesCents || 0), 0)
      const curPct = totImpr > 0 ? Math.round(tosRows.reduce((s, r) => s + r.currentPct * (r.topImpr || 0), 0) / totImpr) : Math.round(tosRows.reduce((s, r) => s + r.currentPct, 0) / tosRows.length)
      const rep = [...tosRows].sort((a, b) => b.topSpendCents - a.topSpendCents)[0]
      setAgg({
        campaignCount: camps.length || tosRows.length,
        topIS: wTopIS,
        currentPct: curPct,
        recommendedPct: rep?.recommendedPct ?? curPct,
        action: rep?.action ?? 'keep',
        reason: rep?.reason ?? 'within target',
        blendedAcos: totSales > 0 ? totSpend / totSales : null,
        perCampaign: [...tosRows].sort((a, b) => b.topSpendCents - a.topSpendCents).slice(0, 6),
      })
      // Initialise the card to where the product actually sits today.
      if (!keepTier) setTier(curPct >= TOP_TIER_THRESHOLD || (wTopIS != null && wTopIS >= 0.4) ? 'top' : 'rest')
    } catch { if (!signal?.aborted) setSignalErr(true) }
    finally { if (!signal?.aborted) setSignalsLoading(false) }
  }, [productId, market])

  useEffect(() => {
    const ac = new AbortController()
    setUserMoved(false); setApplyResult(null)
    void loadSignals(ac.signal)
    return () => ac.abort()
  }, [loadSignals])

  const product = useMemo(() => products.find(p => p.id === productId) ?? null, [products, productId])
  const kwSov = useMemo(() => keywords.find(k => k.query === keyword) ?? null, [keywords, keyword])

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id))
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null)
    const over = e.over?.id
    if (over === 'top' || over === 'rest' || over === 'product') { setTier(over); setUserMoved(true); setApplyResult(null) }
  }

  // When the operator drops on TOP, propose a deliberate push above the current
  // bias (engine-aware: at least the recommendation, floored at +50%).
  useEffect(() => {
    if (tier === 'top' && agg) setTargetPct(Math.min(900, Math.max(50, agg.currentPct + 50, agg.recommendedPct)))
  }, [tier, agg])

  // Bid-to-win for the selected keyword (read-only; recomputes on keyword/market).
  useEffect(() => {
    if (!keyword) { setBid(null); return }
    const ac = new AbortController()
    void fetch(`${getBackendUrl()}/api/advertising/bid-suggestions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal,
      body: JSON.stringify({ keywords: [keyword], matchType: 'BROAD', ...(market === 'All' ? {} : { marketplace: market }) }),
    }).then(r => r.json()).then(d => {
      if (ac.signal.aborted) return
      const s = d?.suggestions?.[0]
      setBid(s ? { suggestedBidCents: s.suggestedBidCents, lowCents: s.lowCents, highCents: s.highCents, basis: s.basis, samples: s.samples } : null)
    }).catch(() => {})
    return () => ac.abort()
  }, [keyword, market])

  // The placement plan implied by the dropped tier (TOP_OF_SEARCH lever).
  // 'rest' removes the top bias (→0); 'product' apply is deferred to a later phase.
  const plan = useMemo<PlanItem[] | null>(() => {
    if (!agg || !userMoved || tier === 'product' || agg.perCampaign.length === 0) return null
    const toPct = tier === 'rest' ? 0 : targetPct
    return agg.perCampaign.map(c => ({ campaignId: c.campaignId, name: c.name, fromPct: c.currentPct, toPct }))
  }, [agg, userMoved, tier, targetPct])

  const planChanges = useMemo(() => (plan ?? []).filter(p => p.fromPct !== p.toPct), [plan])

  const apply = useCallback(async () => {
    if (!plan || planChanges.length === 0) return
    setApplying(true)
    let mode = 'local'; let count = 0
    for (const item of planChanges) {
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/top-of-search/apply`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ campaignId: item.campaignId, percentage: item.toPct }),
        }).then(r => r.json())
        if (r?.ok) { count += 1; if (r.result?.mode) mode = r.result.mode }
      } catch { /* continue; partial apply is surfaced via count */ }
    }
    setApplyResult({ mode, count })
    setApplying(false)
    setUserMoved(false)
    void loadSignals(undefined, true) // refresh, keep the dragged tier
  }, [plan, planChanges, loadSignals])

  const tierLabel = TIERS.find(t => t.k === tier)?.label ?? 'Rest of search'
  const isPct = agg?.topIS != null ? agg.topIS * 100 : null
  const euros = (c: number) => `€${(c / 100).toFixed(2)}`

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
          {bid && (
            <>
              <div className="row"><span>Keyword bid to win</span><b>{euros(bid.suggestedBidCents)} <span style={{ fontWeight: 500, color: 'var(--ink3)', fontSize: 11 }}>{euros(bid.lowCents)}–{euros(bid.highCents)}</span></b></div>
              {bid.basis === 'default' && <div className="az-cockpit-sub">No history for this keyword yet — account default; refines after clicks.</div>}
            </>
          )}

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

          <div className="sep" />
          {/* ── P3: plan + sandbox apply ─────────────────────────── */}
          {tier === 'product' ? (
            <div className="az-cockpit-note"><Info size={12} /> Product-page targeting is read-only here for now — its one-click apply lands in a later phase. The bid-to-win above still applies.</div>
          ) : !userMoved ? (
            <div className="az-cockpit-note"><Info size={12} /> Drag your product up to <b>Top of search</b> (or down to <b>Rest of search</b>) to build a placement plan you can apply.</div>
          ) : (
            <div className="az-cockpit-plan">
              {tier === 'top' && (
                <div className="az-plan-target">
                  <span className="az-gauge-lbl">Target top-of-search bias</span>
                  <div className="az-stepper">
                    <button type="button" onClick={() => setTargetPct(p => Math.max(0, p - 10))} disabled={applying} aria-label="Decrease target">−</button>
                    <span className="v">+{targetPct}%</span>
                    <button type="button" onClick={() => setTargetPct(p => Math.min(900, p + 10))} disabled={applying} aria-label="Increase target">+</button>
                  </div>
                </div>
              )}
              <div className="az-plan-head">{tier === 'rest' ? 'Remove top-of-search bias' : 'Push to top of search'} · {planChanges.length} of {plan?.length ?? 0} campaign{(plan?.length ?? 0) === 1 ? '' : 's'} change</div>
              {planChanges.slice(0, 6).map(p => (
                <div key={p.campaignId} className="az-campline">
                  <span className="nm" title={p.name}>{p.name}</span>
                  <span className="pct">+{p.fromPct}% → +{p.toPct}%</span>
                </div>
              ))}
              {planChanges.length === 0 && <div className="az-cockpit-sub">Already at the target — nothing to change.</div>}
              <button type="button" className="az-btn dark" style={{ marginTop: 10, width: '100%', justifyContent: 'center' }} disabled={applying || planChanges.length === 0} onClick={() => void apply()}>
                {applying ? <><Loader2 size={14} className="az-spin" /> Applying…</> : <><Zap size={14} /> Apply to {planChanges.length} campaign{planChanges.length === 1 ? '' : 's'}</>}
              </button>
              {applyResult && (
                <div className="az-cockpit-sub" style={{ marginTop: 6, color: applyResult.mode === 'live' ? 'var(--green)' : 'var(--ink2)' }}>
                  <Check size={12} style={{ verticalAlign: 'text-bottom' }} /> {applyResult.mode === 'live'
                    ? `Applied live on ${applyResult.count} campaign(s).`
                    : `Staged on ${applyResult.count} campaign(s) (${applyResult.mode}) — not live on Amazon. Flip the write-gate to push live.`}
                </div>
              )}
              <div className="az-cockpit-note"><Info size={12} /> Apply is gated: with the ads write-gate closed it stages the placement % locally (sandbox); the result says which mode it took. Flipping the gate live needs approval. The hold-the-slot loop lands in P4.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
