'use client'

/**
 * Rank Control — Placement Cockpit (RC2 series).
 *
 * P1: the visual shell + drag-drop "placement ladder". You pick a product +
 * market + keyword context, then drag your product card between placement tiers
 * (Top of search / Rest of search / Product pages). The right panel reflects the
 * chosen tier. No writes yet — real signals (P2), bid-to-win + apply (P3) and the
 * hold loop (P4) layer on top.
 *
 * Honest model: Amazon's API doesn't expose literal SERP rank, so the ladder is
 * a CONTROL METAPHOR — drag = your TARGET placement; later phases translate it
 * into placement % + bid + defend strategy and show impression-share as the
 * real "are you showing there" proxy.
 */

import { useEffect, useMemo, useState } from 'react'
import { DndContext, useDraggable, useDroppable, DragOverlay, type DragEndEvent, type DragStartEvent, PointerSensor, KeyboardSensor, useSensor, useSensors } from '@dnd-kit/core'
import { Search, GripVertical, Info, ArrowUp, Crosshair } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

const MARKETS = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK', 'All']

interface Prod { id: string; name: string; asin: string | null; photoUrl: string | null; marketCount?: number }
interface Sov { query: string; impressions: number; sovPct: number }

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
        {/* competitor placeholder slots for visual context */}
        {!active && Array.from({ length: tierKey === 'top' ? 3 : 4 }).map((_, i) => <div key={i} className="az-slot-ghost" />)}
        {children}
        {!active && <span className="az-tier-hint">{hint}</span>}
      </div>
    </div>
  )
}

export function RankPlacementCockpit() {
  const [market, setMarket] = useState('IT')
  const [products, setProducts] = useState<Prod[]>([])
  const [productId, setProductId] = useState<string>('')
  const [keywords, setKeywords] = useState<Sov[]>([])
  const [keyword, setKeyword] = useState<string>('')
  const [tier, setTier] = useState<TierKey>('rest')
  const [activeId, setActiveId] = useState<string | null>(null)

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

  // Keyword context options (P2 makes these product-specific; P1 uses market SoV queries)
  useEffect(() => {
    void fetch(`${getBackendUrl()}/api/advertising/share-of-voice?windowDays=30&limit=60`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        const rows: Sov[] = (d.rows ?? []).map((s: Record<string, unknown>) => ({ query: s.query as string, impressions: s.impressions as number, sovPct: s.sovPct as number }))
        setKeywords(rows)
        if (rows.length && !keyword) setKeyword(rows[0].query)
      }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const product = useMemo(() => products.find(p => p.id === productId) ?? null, [products, productId])

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id))
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null)
    const over = e.over?.id
    if (over === 'top' || over === 'rest' || over === 'product') setTier(over)
  }

  const tierLabel = TIERS.find(t => t.k === tier)?.label ?? 'Rest of search'

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
            <div className="az-ladder-foot"><Info size={11} /> Drag your product to the placement you want to win. Amazon is an auction — this targets &amp; defends the slot; it can’t pin a fixed rank.</div>
          </div>
          <DragOverlay>{activeId && product ? <ProductCard prod={product} dragging /> : null}</DragOverlay>
        </DndContext>

        {/* ── Strategy panel (P3 wires real bids) ─────── */}
        <div className="az-cockpit-panel">
          <div className="az-cockpit-panel-head"><Crosshair size={15} /> Strategy</div>
          <div className="row"><span>Product</span><b>{product?.name ?? '—'}</b></div>
          <div className="row"><span>Keyword</span><b>{keyword || '—'}</b></div>
          <div className="row"><span>Market</span><b>{market}</b></div>
          <div className="sep" />
          <div className="row"><span>Target placement</span><b>{tierLabel}</b></div>
          <div className="az-cockpit-note">
            <Info size={12} /> Real impression-share signals, bid-to-win and one-click apply land in the next phases. For now this previews the cockpit layout — use the <b>Advanced</b> form for live placement control today.
          </div>
        </div>
      </div>
    </div>
  )
}
