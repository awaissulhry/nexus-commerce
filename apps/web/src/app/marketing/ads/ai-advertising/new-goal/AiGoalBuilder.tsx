'use client'

/**
 * CBN/AIAD.4 — AI Advertising · New Product Goal (the "AI Goal" campaign builder).
 * Full-screen takeover (own top bar; the ads rail is covered).
 *
 * AIAD.4 made the builder honest and evidence-based:
 *  - the goal carries a MARKETPLACE (was silently defaulting to IT at materialization);
 *  - five strategies (Impression&Click / Sales / ROAS / Liquidate / Defend Rank) mapping to
 *    the Conductor's presets — a superset of Perpetua's four and H10's three;
 *  - Target ACoS + bid-band dials feed the plan's guardrails;
 *  - Suggested keywords are the ASINs' real converting search terms (clicks · orders · sales,
 *    with an evidence-based starting bid), n-gram winners as a LABELLED fallback — never
 *    product-name tokens;
 *  - Suggested budgets come from the products' own 30-day ad-spend history (€1-floor branch
 *    for never-advertised ASINs) — never from a synthetic score;
 *  - "What will be built" renders the server's pure scaffold plan (planGoalScaffold), the
 *    same plan materialization executes, so the preview cannot lie;
 *  - Launch is a staged overlay with the real result (campaigns, rules, warnings) instead of
 *    a silent redirect.
 */
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { Button } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'
import { useRouter } from 'next/navigation'
import { X, Plus, Search, Trash2, Users, CheckSquare, Share2, BarChart3, ChevronsUpDown, Info, Folder, Check, Settings, Minus, PackageOpen, Shield, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { IconAtom, IconEye, IconBars, IconLine } from '../../_shell/builder-icons'
import { InfoTip } from '../../campaigns/InfoTip'
import { Select } from '@/design-system/primitives/Select'
import { Tag, type TagTone } from '@/design-system/primitives/Tag'
import { Spinner } from '@/design-system/primitives/Spinner'
import { useAdsMarketplace } from '../../_shell/MarketplaceContext'
import { marketLabel } from '../../_shell/MarketSelect'
// Share — reuse SP Super Wizard's product picker (Search/Enter tabs + variation expansion + N-Added)
// so improvements propagate. Imported as-is; AI Goal maps its output to its own budget-bearing Prod.
import { ProductSelection, type SpwProduct } from '../../campaign-builder/sp-super-wizard/ProductSelection'
import { PortfolioPicker } from '../../campaign-builder/sp-super-wizard/PortfolioPicker'
import { AiGoalPreview } from './AiGoalPreview'
import './ai-goal.css'

type TargetKey = 'impression' | 'sales' | 'roas' | 'liquidate' | 'rank'
type BudgetMode = 'strict' | 'shared'
type Prod = { id: string; name: string; sku: string; asin: string; imageUrl: string | null; lqs: number; budget: string }
type RawProduct = { id: string; name: string; sku: string; asin?: string | null; imageUrl?: string | null; photoUrl?: string | null; photoCount?: number; channelCount?: number; hasDescription?: boolean; hasGtin?: boolean }

const IconLiquidate = ({ size }: { size?: number }) => <PackageOpen size={size} />
const IconShieldRank = ({ size }: { size?: number }) => <Shield size={size} />
const TARGETS: Array<{ key: TargetKey; title: string; Icon: ComponentType<{ size?: number }>; bestFor: string; desc: string }> = [
  { key: 'impression', title: 'Impression & Click', Icon: IconEye, bestFor: 'New Products', desc: 'This strategy aims to increase impressions and clicks. It is suitable for new products that require traffic.' },
  { key: 'sales', title: 'Sales', Icon: IconBars, bestFor: 'Gross Revenue', desc: 'This strategy aims to increase orders and sales. It is suitable for products that require orders.' },
  { key: 'roas', title: 'ROAS', Icon: IconLine, bestFor: 'Most Scenarios', desc: 'This strategy emphasizes an adjustment mode focused on ROAS/ACOS and is suitable for most scenarios.' },
  { key: 'liquidate', title: 'Liquidate', Icon: IconLiquidate, bestFor: 'Clearing Inventory', desc: 'Maximize sell-through at a relaxed efficiency target — for overstocked or end-of-life products.' },
  { key: 'rank', title: 'Defend Rank', Icon: IconShieldRank, bestFor: 'Protecting Position', desc: 'Hold visibility on the terms you own — Top-of-Search emphasis with steady, defensive pacing.' },
]
const TARGET_API: Record<TargetKey, string> = { impression: 'IMPRESSION', sales: 'SALES', roas: 'ROAS', liquidate: 'LIQUIDATE', rank: 'RANK' }
const BUDGET_MODES: Array<{ key: BudgetMode; title: string; Icon: typeof CheckSquare; desc: string; audience: string; chips: string[] }> = [
  { key: 'strict', title: 'Strict Control', Icon: CheckSquare, desc: 'Individual products have independent budgets. AI will create a campaign for each ASIN.', audience: 'Experienced Advertisers | Specialized Campaigns', chips: ['Precision Control', 'Budget Safeguarding', 'Data-Driven', 'Scalability'] },
  { key: 'shared', title: 'Shared Budget', Icon: Share2, desc: 'Users allocate a single budget that is shared across multiple selected products managed by AI.', audience: 'New Advertisers', chips: ['Simplified Management', 'Dynamic Allocation', 'Time-Efficiency'] },
]
const ROLE_TONE: Record<string, TagTone> = { AUTO: 'info', RESEARCH: 'neutral', PERF: 'positive', PAT: 'warning' }
const ROLE_LABEL: Record<string, string> = { AUTO: 'Auto', RESEARCH: 'Research', PERF: 'Performance', PAT: 'Products' }

const eur = (n: number) => `€${n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const eurC = (cents: number) => eur(cents / 100)
// Derived Listing Quality Score (0–10) from completeness signals we DO have (display only —
// budgets no longer derive from it; they come from real ad-spend history).
function lqsOf(p: RawProduct): number {
  let s = 3 + Math.min(p.photoCount ?? 0, 8) * 0.55 + (p.hasDescription ? 1 : 0) + (p.hasGtin ? 0.8 : 0) + Math.min((p.channelCount ?? 1) - 1, 3) * 0.3
  return Math.max(1, Math.min(10, Math.round(s * 10) / 10))
}
const spwToProd = (s: SpwProduct, prev?: Prod): Prod => {
  if (prev) return prev
  const lqs = lqsOf({ id: s.id, name: s.name, sku: s.sku, photoCount: s.imageUrl ? 4 : 0, hasDescription: true, hasGtin: !!s.asin, channelCount: 1 })
  return { id: s.id, name: s.name, sku: s.sku, asin: s.asin ?? '', imageUrl: s.imageUrl ?? null, lqs, budget: '' }
}
const prodToSpw = (p: Prod): SpwProduct => ({ id: p.id, name: p.name, sku: p.sku, asin: p.asin, imageUrl: p.imageUrl, parentId: null, childCount: 0 })

// ── server shapes ──
type SuggestedKeyword = { text: string; source: string; impressions: number; clicks: number; orders: number; spendCents: number; salesCents: number; acosPct: number | null; suggestedBidCents: number | null; bidBasis: string | null }
type SuggestedBudget = { asin: string; hasHistory: boolean; daysWithSpend: number; windowDays: number; lowCents: number; highCents: number }
type Suggestions = { keywords: SuggestedKeyword[]; keywordSource: 'search-terms' | 'ngrams' | 'none'; budgets: SuggestedBudget[] }
type PlannedCampaign = { setLabel: string; role: string; name: string; targetingType: string; budgetCents: number; seeds: Array<{ text: string; matchType: string; bidCents: number }>; autoGroups: Array<{ key: string; bidEur: number }>; productTargets: string[]; negativeKeywords: unknown[]; negativeAsins: string[] }
type Scaffold = { marketplace: string; planGoal: string; autonomy: string; campaigns: PlannedCampaign[]; rules: Array<{ kind: string; name: string }>; guardrails: { targetAcosPct: number; bidMinCents: number; bidMaxCents: number; maxDailySpendCents: number }; totalDailyBudgetCents: number; warnings: string[] }

export function AiGoalBuilder() {
  const router = useRouter()
  const mk = useAdsMarketplace()
  const [goalName, setGoalName] = useState('')
  const [market, setMarket] = useState('')
  useEffect(() => { if (!market && mk.market) setMarket(mk.market) }, [market, mk.market])
  const [target, setTarget] = useState<TargetKey>('sales') // H10 default is the middle "Sales" card
  const [targetAcos, setTargetAcos] = useState('30')
  const [bidMin, setBidMin] = useState('')
  const [bidMax, setBidMax] = useState('')
  const [budgetMode, setBudgetMode] = useState<BudgetMode>('strict')
  const [advAlloc, setAdvAlloc] = useState(false)
  const [sharedBudget, setSharedBudget] = useState('')
  const [products, setProducts] = useState<Prod[]>([])
  const [showAddProducts, setShowAddProducts] = useState(false)
  const [seedTab, setSeedTab] = useState<'suggested' | 'list' | 'enter'>('suggested')
  const [seeds, setSeeds] = useState<string[]>([])
  const [excludeText, setExcludeText] = useState('')
  const [excluded, setExcluded] = useState<string[]>([])
  const [advOpen, setAdvOpen] = useState(false)
  const [productTargets, setProductTargets] = useState<string[]>([])
  const [excludeAsins, setExcludeAsins] = useState<string[]>([])
  const [portfolioId, setPortfolioId] = useState('')
  const exitTo = '/marketing/ads/campaign-builder'

  // ── evidence: suggested keywords + budgets for the selected ASINs in the selected market ──
  const asinsKey = useMemo(() => products.map((p) => p.asin).filter(Boolean).sort().join(','), [products])
  const [suggest, setSuggest] = useState<Suggestions | null>(null)
  const [suggestLoading, setSuggestLoading] = useState(false)
  useEffect(() => {
    if (!asinsKey || !market) { setSuggest(null); return }
    let alive = true
    setSuggestLoading(true)
    const t = setTimeout(() => {
      fetch(`${getBackendUrl()}/api/advertising/ai-goals/suggest?asins=${encodeURIComponent(asinsKey)}&marketplace=${encodeURIComponent(market)}`, { cache: 'no-store' })
        .then((r) => r.json()).then((j) => { if (alive && j && Array.isArray(j.keywords)) setSuggest(j as Suggestions) })
        .catch(() => {}).finally(() => { if (alive) setSuggestLoading(false) })
    }, 350)
    return () => { alive = false; clearTimeout(t) }
  }, [asinsKey, market])
  const budgetByAsin = useMemo(() => new Map((suggest?.budgets ?? []).map((b) => [b.asin, b])), [suggest])

  const [launching, setLaunching] = useState(false)
  const [launchPhase, setLaunchPhase] = useState<null | 'create' | 'materialize' | 'done' | 'partial' | 'failed'>(null)
  const [launchResult, setLaunchResult] = useState<{ goalId?: string; campaigns?: number; rules?: number; errors?: string[]; message?: string }>({})
  const totalBudget = useMemo(() => products.reduce((a, p) => a + (Number(p.budget) || 0), 0), [products])
  const setBudget = (id: string, v: string) => setProducts((ps) => ps.map((p) => (p.id === id ? { ...p, budget: v } : p)))
  const removeProduct = (id: string) => setProducts((ps) => ps.filter((p) => p.id !== id))

  const payload = useMemo(() => ({
    name: goalName.trim(),
    aiTarget: TARGET_API[target],
    budgetMode: budgetMode.toUpperCase(),
    advancedAllocation: advAlloc,
    totalBudgetCents: budgetMode === 'shared' ? Math.round((Number(sharedBudget) || 0) * 100) : null,
    products: products.map((p) => ({ productId: p.id, asin: p.asin, sku: p.sku, name: p.name, imageUrl: p.imageUrl, lqs: p.lqs, budgetCents: Math.round((Number(p.budget) || 0) * 100) })),
    seedKeywords: seeds, excludeKeywords: excluded, productTargets, excludeAsins,
    portfolioId: portfolioId || null,
    marketplace: market || null,
    targetAcosPct: Number(targetAcos) >= 5 && Number(targetAcos) <= 300 ? Math.round(Number(targetAcos)) : null,
    bidMinCents: Number(bidMin) > 0 ? Math.round(Number(bidMin) * 100) : null,
    bidMaxCents: Number(bidMax) > 0 ? Math.round(Number(bidMax) * 100) : null,
  }), [goalName, target, budgetMode, advAlloc, sharedBudget, products, seeds, excluded, productTargets, excludeAsins, portfolioId, market, targetAcos, bidMin, bidMax])

  // ── "what will be built": the server's pure scaffold plan, debounced ──
  const [scaffold, setScaffold] = useState<Scaffold | null>(null)
  const [scaffoldLoading, setScaffoldLoading] = useState(false)
  const payloadRef = useRef(payload); payloadRef.current = payload
  useEffect(() => {
    if (!products.length) { setScaffold(null); return }
    let alive = true
    setScaffoldLoading(true)
    const t = setTimeout(() => {
      fetch(`${getBackendUrl()}/api/advertising/ai-goals/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payloadRef.current) })
        .then((r) => r.json()).then((j) => { if (alive) setScaffold(j?.ok ? (j.scaffold as Scaffold) : null) })
        .catch(() => { if (alive) setScaffold(null) }).finally(() => { if (alive) setScaffoldLoading(false) })
    }, 600)
    return () => { alive = false; clearTimeout(t) }
  }, [payload, products.length])

  // Launch enables once the goal is valid: a name, a market, ≥1 product, and a budget per the mode.
  const valid = goalName.trim().length > 0 && !!market && products.length > 0 && (
    budgetMode === 'shared' ? Number(sharedBudget) >= 1 : products.every((p) => Number(p.budget) >= 1)
  )
  const launch = async () => {
    if (!valid || launching) return
    setLaunching(true); setLaunchPhase('create'); setLaunchResult({})
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/ai-goals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) throw new Error(j?.error || 'Could not create the product goal')
      const goalId = j?.goal?.id as string | undefined
      setLaunchPhase('materialize'); setLaunchResult({ goalId })
      const m = await fetch(`${getBackendUrl()}/api/advertising/ai-goals/${goalId}/materialize`, { method: 'POST' })
      const mj = await m.json().catch(() => ({}))
      if (!m.ok || mj?.ok === false) {
        setLaunchPhase('partial')
        setLaunchResult({ goalId, message: mj?.error || 'The goal was saved, but building its campaigns failed. Retry from the dashboard — it shows as "Not launched".' })
      } else {
        setLaunchPhase('done')
        setLaunchResult({ goalId, campaigns: Array.isArray(mj?.campaigns) ? mj.campaigns.length : 0, rules: Array.isArray(mj?.rules) ? mj.rules.length : 0, errors: Array.isArray(mj?.errors) ? mj.errors : [] })
      }
    } catch (e) {
      setLaunchPhase('failed'); setLaunchResult({ message: (e as Error).message })
    } finally { setLaunching(false) }
  }

  return (
    <div className="h10-aig">
      <header className="h10-aig-top">
        <button type="button" className="x" onClick={() => router.push(exitTo)} aria-label="Close"><X size={20} /></button>
        <span className="brand"><IconAtom size={22} /> AI Advertising</span>
        <span className="sep" />
        <span className="crumb">New Product Goal</span>
        <span className="grow" />
        <button type="button" className="launch" disabled={!valid || launching} onClick={launch}>{launching ? 'Launching…' : 'Launch'}</button>
      </header>

      <div className="h10-aig-body">
        <div className="h10-aig-wrap">

          <section className="h10-aig-sec">
            <h2>Product Goal Details</h2>
            <div className="h10-aig-card">
              <label className="h10-aig-field">
                <span className="lbl">Goal Name <i className="req">*</i></span>
                <input value={goalName} onChange={(e) => setGoalName(e.target.value)} placeholder="Enter a goal name" />
              </label>
              <label className="h10-aig-field">
                <span className="lbl">Marketplace <i className="req">*</i> <InfoTip tip="The Amazon marketplace the AI launches these campaigns in. Everything on this page — suggestions, budgets, the preview — is scoped to it." /></span>
                <Select value={market} onChange={(e) => setMarket(e.target.value)}>
                  {!market && <option value="">Select a marketplace</option>}
                  {mk.markets.filter((m) => m.launchable).map((m) => <option key={m.code} value={m.code}>{marketLabel(m.code)}</option>)}
                </Select>
              </label>
              <div className="h10-aig-field">
                <span className="lbl">Portfolio (Optional)</span>
                <PortfolioPicker value={portfolioId} onChange={setPortfolioId} />
              </div>
            </div>
          </section>

          <section className="h10-aig-sec">
            <h2>Select AI Target</h2>
            <div className="h10-aig-targets five">
              {TARGETS.map((t) => (
                <button type="button" key={t.key} className={`h10-aig-target ${target === t.key ? 'on' : ''}`} onClick={() => setTarget(t.key)}>
                  <span className="ic"><t.Icon size={26} /></span>
                  <span className="ttl">{t.title}</span>
                  <span className="bf">Best for <b>{t.bestFor}</b></span>
                  <span className="desc">{t.desc}</span>
                </button>
              ))}
            </div>
            <div className="h10-aig-card" style={{ marginTop: 14 }}>
              <div className="aig2-dials">
                <div className="aig2-dial">
                  <span className="lbl">Target ACoS <InfoTip tip="The efficiency target the AI steers toward. Strategy presets scale it — Liquidate and Impression & Click deliberately run above it while they work." /></span>
                  <span className="h10-aig-money sm"><input inputMode="numeric" value={targetAcos} onChange={(e) => setTargetAcos(e.target.value)} placeholder="30" /><span className="pf">%</span></span>
                </div>
                <div className="aig2-dial">
                  <span className="lbl">Min Bid (Optional) <InfoTip tip="The AI never bids below this. Empty = the 5¢ account floor." /></span>
                  <span className="h10-aig-money sm"><span className="pf">€</span><input inputMode="decimal" value={bidMin} onChange={(e) => setBidMin(e.target.value)} placeholder="0.05" /></span>
                </div>
                <div className="aig2-dial">
                  <span className="lbl">Max Bid (Optional) <InfoTip tip="The AI never bids above this. Empty = the €3.00 default ceiling." /></span>
                  <span className="h10-aig-money sm"><span className="pf">€</span><input inputMode="decimal" value={bidMax} onChange={(e) => setBidMax(e.target.value)} placeholder="3.00" /></span>
                </div>
                <div className="aig2-dial"><span className="sub">These become the plan&apos;s guardrails. Every AI decision stays inside them, and every one is proposed for your approval until you graduate the goal.</span></div>
              </div>
            </div>
          </section>

          <section className="h10-aig-sec">
            <h2>Product Setup</h2>
            <div className="h10-aig-card">

              <div className="h10-aig-sub">
                <h3>Budget Mode</h3>
                <p>Select a Budget mode based on the application scenario</p>
                <div className="h10-aig-budget">
                  {BUDGET_MODES.map((b) => (
                    <button type="button" key={b.key} className={`h10-aig-bcard ${budgetMode === b.key ? 'on' : ''}`} onClick={() => setBudgetMode(b.key)}>
                      <span className="bh"><span className="bic"><b.Icon size={18} /></span><span className="bt">{b.title}</span></span>
                      <span className="bd">{b.desc}</span>
                      <span className="ba"><Users size={13} /> {b.audience}</span>
                      <span className="bchips">{b.chips.map((c) => <span className={`chip ${budgetMode === b.key ? 'on' : ''}`} key={c}>{c}</span>)}</span>
                    </button>
                  ))}
                </div>
                {budgetMode === 'strict' && (
                  <label className="h10-aig-adv">
                    <input type="checkbox" checked={advAlloc} onChange={(e) => setAdvAlloc(e.target.checked)} />
                    <span className="t">Advanced Allocation</span>
                    <span className="d">When the campaign&apos;s budget is exhausted, AI will analyze the spending capacity and effectiveness of a campaign and allocate the budget more efficiently to the campaign under that goal.</span>
                  </label>
                )}
              </div>

              {budgetMode === 'shared' && (
                <div className="h10-aig-sub">
                  <h3>Total Budget</h3>
                  <span className="h10-aig-money"><span className="pf">€</span><input inputMode="decimal" value={sharedBudget} onChange={(e) => setSharedBudget(e.target.value)} placeholder="Please enter" /></span>
                  {suggest && suggest.budgets.length > 0 && (
                    <div className="aig2-srcnote">
                      {suggest.budgets.some((b) => b.hasHistory)
                        ? <>Suggested {eurC(suggest.budgets.reduce((n, b) => n + b.lowCents, 0))} – {eurC(suggest.budgets.reduce((n, b) => n + b.highCents, 0))} from the selected products&apos; last-{suggest.budgets[0].windowDays}-day ad spend.</>
                        : <>No ad history for these products in {market} — Amazon&apos;s €1.00/day floor per campaign is the honest starting point.</>}
                    </div>
                  )}
                </div>
              )}

              <div className="h10-aig-sub">
                <h3>Product Selection</h3>
                <p>Select products for AI Advertising to manage</p>
                <div className="h10-aig-pselbar">
                  <span className="cnt">{products.length} Product{products.length > 1 ? 's' : ''} Added</span>
                  <span className="grow" />
         <Button disabled={!products.length} onClick={() => setProducts([])}><Trash2 size={13} /> Remove All</Button>
         <Button variant="primary" onClick={() => setShowAddProducts(true)}><Plus size={13} /> Add Products</Button>
                </div>
                <div className="h10-aig-psel">
                  <div className={`psel-head ${budgetMode}`}>
                    <span className="c-del" />
                    <span className="c-prod">Product <ChevronsUpDown size={12} /></span>
                    <span className="c-lqs">LQS <ChevronsUpDown size={12} /></span>
                    {budgetMode === 'strict' && <><span className="c-sug">Suggested Budget</span><span className="c-bud">Budget</span></>}
                  </div>
                  {products.length === 0 ? (
                    <div className="psel-empty"><ProductsEmptyArt /><div className="t">No Product Added</div><Button size="sm" onClick={() => setShowAddProducts(true)}><Plus size={13} /> Add Products</Button></div>
                  ) : (
                    <ul className="psel-rows">
                      {products.map((p) => {
                        const b = budgetByAsin.get(p.asin)
                        return (
                        <li key={p.id} className={budgetMode}>
                          <button type="button" className="del" onClick={() => removeProduct(p.id)} aria-label="Remove"><Trash2 size={15} /></button>
                          <span className="c-prod"><span className="th">{p.imageUrl ? <img src={p.imageUrl} alt="" /> : null}</span><span className="m"><span className="nm">{p.name}</span><span className="id">{p.asin || p.sku}{p.asin && p.sku ? ` · ${p.sku}` : ''}</span></span></span>
                          <span className="c-lqs"><span className="lqs"><BarChart3 size={11} /> {p.lqs.toFixed(1)}</span></span>
                          {budgetMode === 'strict' && <>
                            <span className="c-sug">
                              {suggestLoading && !b ? <Spinner /> : b ? (
                                <span className="aig2-sug">
                                  <span className="rng">{eurC(b.lowCents)} – {eurC(b.highCents)}</span>
                                  <span className="src">{b.hasHistory ? `${b.daysWithSpend}d of ad spend, last ${b.windowDays}d` : 'no ad history — €1 floor'}</span>
                                  <button type="button" className="h10-am-link aig2-use" onClick={() => setBudget(p.id, (b.lowCents / 100).toFixed(2))}>Use {eurC(b.lowCents)}</button>
                                </span>
                              ) : '—'}
                            </span>
                            <span className="c-bud"><span className={`h10-aig-money sm ${p.budget && Number(p.budget) < 1 ? 'err' : ''}`}><span className="pf">€</span><input inputMode="decimal" value={p.budget} onChange={(e) => setBudget(p.id, e.target.value)} placeholder="0" /></span></span>
                          </>}
                        </li>
                      )})}
                    </ul>
                  )}
                  {budgetMode === 'strict' && products.length > 0 && (
                    <div className="psel-total"><span>Total Budget:</span><b>{eur(totalBudget)}</b></div>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="h10-aig-sec">
            <h2>Keywords</h2>
            <div className="h10-aig-card">
              <AddSeedKeywords suggest={suggest} loading={suggestLoading} hasProducts={products.length > 0} seeds={seeds} setSeeds={setSeeds} tab={seedTab} setTab={setSeedTab} />
              <div className="h10-aig-sub">
                <h3 className="h10-aig-kwhd"><span className="badge purple"><Minus size={11} strokeWidth={3} /></span> Exclude Keywords</h3>
                <p>Exclude specific search terms from triggering your ads to avoid irrelevant traffic and reduce costs.</p>
                <KeywordEntry placeholder="Enter keywords you do not want to target" text={excludeText} setText={setExcludeText} list={excluded} setList={setExcluded} max={10} />
              </div>
            </div>
          </section>

          <section className="h10-aig-sec">
            <h2>Advanced Targeting</h2>
            <div className="h10-aig-card adv">
              <div className="adv-row">
                <div>
                  <h3>Advanced Targeting</h3>
                  <p>Add or exclude additional types of targets</p>
                </div>
                <Button variant="ghost" onClick={() => setAdvOpen(true)}><Settings size={13} /> Settings</Button>
              </div>
              <div className="adv-note"><Info size={15} /><span>If the SP Auto campaign does not immediately generate keywords or product targets (ASINs), the SP KW and SP PAT campaigns will remain in an Incomplete status due to the lack of required inputs. This is normal and may take some time as the SP Auto campaign gathers data. Please be patient and allow the SP Auto campaign to run long enough to identify relevant keywords and targets.</span></div>
            </div>
          </section>

          <AiGoalPreview targetLabel={TARGETS.find((t) => t.key === target)?.title ?? ''} budgetMode={budgetMode} productCount={products.length} totalBudget={budgetMode === 'shared' ? (Number(sharedBudget) || 0) : totalBudget} seedCount={seeds.length} excludeCount={excluded.length} productTargetCount={productTargets.length} />

          <section className="h10-aig-sec">
            <h2>What will be built</h2>
            <div className="h10-aig-card">
              <ScaffoldPreview scaffold={scaffold} loading={scaffoldLoading} hasProducts={products.length > 0} />
            </div>
          </section>

        </div>
      </div>
      <footer className="h10-aig-bottombar">
    <Button onClick={() => router.push(exitTo)}>Cancel</Button>
        <span className="grow" />
        {launchPhase === 'failed' && <span className="err">{launchResult.message}</span>}
        <button type="button" className="launch" disabled={!valid || launching} onClick={launch}>{launching ? 'Launching…' : 'Launch'}</button>
      </footer>

      {showAddProducts && <AddProductsModal selected={products} onClose={() => setShowAddProducts(false)} onApply={(ps) => { setProducts(ps); setShowAddProducts(false) }} />}
      {advOpen && <AdvancedTargetingDrawer productTargets={productTargets} excludeAsins={excludeAsins} onClose={() => setAdvOpen(false)} onSave={(pt, ea) => { setProductTargets(pt); setExcludeAsins(ea); setAdvOpen(false) }} />}
      {launchPhase && launchPhase !== 'failed' && (
        <LaunchOverlay
          phase={launchPhase}
          result={launchResult}
          onViewGoal={() => router.push(`/marketing/ads/ai-advertising${launchResult.goalId ? `?goal=${launchResult.goalId}` : ''}`)}
          onDone={() => router.push('/marketing/ads/ai-advertising')}
        />
      )}
    </div>
  )
}

/* ── "What will be built" — the server's pure scaffold plan (materialize executes the same plan). ── */
function ScaffoldPreview({ scaffold, loading, hasProducts }: { scaffold: Scaffold | null; loading: boolean; hasProducts: boolean }) {
  if (!hasProducts) return <div className="aig2-pempty">Add products above — the exact campaigns, keywords and guardrails this goal creates appear here before you launch.</div>
  if (!scaffold) return <div className="aig2-pempty">{loading ? 'Computing the scaffold…' : 'The preview appears once the goal has products and a budget.'}</div>
  const targeting = (c: PlannedCampaign) =>
    c.autoGroups.length ? `${c.autoGroups.length} auto groups @ ${c.autoGroups.map((g) => `€${g.bidEur.toFixed(2)}`).slice(0, 1)[0]}+`
      : c.seeds.length ? `${c.seeds.length} ${c.seeds[0].matchType.toLowerCase()} @ ${eurC(c.seeds[0].bidCents)}${c.seeds.length > 1 ? '+' : ''}`
        : c.productTargets.length ? `${c.productTargets.length} ASIN target${c.productTargets.length === 1 ? '' : 's'}`
          : 'harvest destination — fills as winners graduate'
  return (
    <div className="aig2-scaffold">
      <div className="aig2-chips">
        <span className="aig2-chip">Strategy <b>{scaffold.planGoal}</b></span>
        <span className="aig2-chip">Target ACoS <b>{scaffold.guardrails.targetAcosPct}%</b></span>
        <span className="aig2-chip">Bid band <b>{eurC(scaffold.guardrails.bidMinCents)} – {eurC(scaffold.guardrails.bidMaxCents)}</b></span>
        <span className="aig2-chip">Daily cap <b>{eurC(scaffold.guardrails.maxDailySpendCents)}</b></span>
        <span className="aig2-chip">AI mode <b>Propose-only</b></span>
        <span className="aig2-chip">Marketplace <b>{scaffold.marketplace}</b></span>
      </div>
      {scaffold.warnings.map((w) => (
        <div className="aig2-warn" key={w}><AlertTriangle size={15} style={{ flex: 'none', marginTop: 1 }} /><span>{w}</span></div>
      ))}
      <div className="aig2-pwrap">
        <table className="aig2-ptable">
          <thead><tr><th>Campaign</th><th>Role</th><th>Daily Budget</th><th>Targeting</th><th>Negatives</th></tr></thead>
          <tbody>
            {scaffold.campaigns.map((c) => (
              <tr key={c.name}>
                <td className="nm" title={c.name}>{c.name}</td>
                <td><Tag tone={ROLE_TONE[c.role] ?? 'neutral'}>{ROLE_LABEL[c.role] ?? c.role}</Tag></td>
                <td className="num">{eurC(c.budgetCents)}</td>
                <td>{targeting(c)}</td>
                <td className="num">{c.negativeKeywords.length + c.negativeAsins.length || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="aig2-rules">
        + {scaffold.rules.length} automation rule{scaffold.rules.length === 1 ? '' : 's'} (harvest &amp; negate, propose-first) and one Autopilot plan the 15-minute conductor drives. Every optimization lands on the Suggestions page for your approval.
      </div>
    </div>
  )
}

/* ── Launch overlay: staged, with the real result — never a silent redirect. ── */
function LaunchOverlay({ phase, result, onViewGoal, onDone }: {
  phase: 'create' | 'materialize' | 'done' | 'partial'
  result: { goalId?: string; campaigns?: number; rules?: number; errors?: string[]; message?: string }
  onViewGoal: () => void; onDone: () => void
}) {
  const step = (k: 'create' | 'materialize' | 'verify') => {
    if (phase === 'create') return k === 'create' ? 'on' : ''
    if (phase === 'materialize') return k === 'create' ? 'ok' : k === 'materialize' ? 'on' : ''
    if (phase === 'partial') return k === 'create' ? 'ok' : 'err'
    return 'ok'
  }
  const busy = phase === 'create' || phase === 'materialize'
  return (
    <div className="aig2-launch-back" role="dialog" aria-label="Launching product goal">
      <div className="aig2-launch">
        <h3>{busy ? 'Launching your product goal…' : phase === 'partial' ? 'Goal saved — launch incomplete' : 'Goal launched'}</h3>
        <div className="aig2-steps">
          <div className={`aig2-step ${step('create')}`}><span className="dot" />Saving the goal</div>
          <div className={`aig2-step ${step('materialize')}`}><span className="dot" />Building the campaign scaffold</div>
          <div className={`aig2-step ${step('verify')}`}><span className="dot" />Linking the AI plan &amp; verifying</div>
        </div>
        {phase === 'done' && (
          <div className="sum">
            Created <b>{result.campaigns ?? 0}</b> campaign{(result.campaigns ?? 0) === 1 ? '' : 's'} and <b>{result.rules ?? 0}</b> automation rule{(result.rules ?? 0) === 1 ? '' : 's'}.
            The AI evaluates every 15 minutes and proposes its first optimizations on the Suggestions page as click data arrives. The launch receipt is on the Trust page.
          </div>
        )}
        {phase === 'partial' && <div className="sum">{result.message}</div>}
        {phase === 'done' && (result.errors?.length ?? 0) > 0 && (
          <div className="errs">{result.errors!.map((e) => <div key={e}>{e}</div>)}</div>
        )}
        <div className="btns">
          {busy ? <Spinner /> : <>
      <Button onClick={onDone}>Go to dashboard</Button>
      {result.goalId && <Button variant="primary" onClick={onViewGoal}>View goal</Button>}
          </>}
        </div>
      </div>
    </div>
  )
}

/* ── Add Seed Keywords: Suggested (REAL evidence) / Add from List / Enter Keywords + N/10 panel ── */
function AddSeedKeywords({ suggest, loading, hasProducts, seeds, setSeeds, tab, setTab }: {
  suggest: Suggestions | null; loading: boolean; hasProducts: boolean
  seeds: string[]; setSeeds: (v: string[]) => void
  tab: 'suggested' | 'list' | 'enter'; setTab: (t: 'suggested' | 'list' | 'enter') => void
}) {
  const [enter, setEnter] = useState('')
  const [folderQ, setFolderQ] = useState('')
  const kws = suggest?.keywords ?? []
  const add = (k: string) => { const t = k.trim().toLowerCase(); if (t && !seeds.includes(t) && seeds.length < 10) setSeeds([...seeds, t]) }

  return (
    <div className="h10-aig-sub">
      <h3 className="h10-aig-kwhd"><span className="badge green"><Plus size={11} strokeWidth={3} /></span> Add Seed Keywords</h3>
      <p>Seed keywords start the Research (broad) and Performance (exact) campaigns; the AI harvests and expands from there. Suggestions below are your account&apos;s real search-term evidence.</p>
      {!hasProducts ? (
        <div className="h10-aig-kw-empty"><ProductsEmptyArt /><div className="t">Select a product above to add keywords to this product goal.</div></div>
      ) : (
        <div className="h10-aig-kwgrid">
          <div className="kw-left">
            <div className="h10-aig-seedtabs">
              <button type="button" className={tab === 'suggested' ? 'on' : ''} onClick={() => setTab('suggested')}>Suggested <i>{kws.length > 98 ? '99+' : kws.length}</i></button>
              <button type="button" className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>Add from List</button>
              <button type="button" className={tab === 'enter' ? 'on' : ''} onClick={() => setTab('enter')}>Enter Keywords</button>
            </div>
            {tab === 'suggested' && (
              loading ? <div className="aig2-pempty"><Spinner /> Reading your search-term history…</div>
                : kws.length === 0 ? <div className="aig2-pempty">No search-term evidence yet for these products — enter keywords manually, or launch with the Auto campaign only and let the harvest discover them.</div>
                  : <>
                    <ul className="aig2-suglist">
                      {kws.map((k) => (
                        <li key={k.text}>
                          <span className="kw" title={k.text}>{k.text}</span>
                          <span className="ev">{k.orders} order{k.orders === 1 ? '' : 's'} · {k.clicks} click{k.clicks === 1 ? '' : 's'} · {eurC(k.salesCents)}</span>
                          {k.suggestedBidCents != null && <span className="bid" title={`Starting bid from ${k.bidBasis === 'token-match' ? 'similar keywords you run' : k.bidBasis === 'account-median' ? 'your account median CPC' : 'the default'}`}>{eurC(k.suggestedBidCents)}</span>}
                          <span className="grow" />
                          <button type="button" disabled={seeds.includes(k.text.toLowerCase()) || seeds.length >= 10} onClick={() => add(k.text)} aria-label={`Add ${k.text}`}>{seeds.includes(k.text.toLowerCase()) ? <Check size={13} /> : <Plus size={13} />}</button>
                        </li>
                      ))}
                    </ul>
                    <div className={`aig2-srcnote${suggest?.keywordSource === 'ngrams' ? ' warn' : ''}`}>
                      {suggest?.keywordSource === 'ngrams'
                        ? 'These products have no ad history yet — showing your account’s winning n-grams instead (90 days), labelled honestly.'
                        : 'Converting search terms from these products’ own campaigns, last 90 days.'}
                    </div>
                  </>
            )}
            {tab === 'list' && (
              <div className="h10-aig-folderbox">
                <div className="h10-dd-search"><Search size={13} /><input value={folderQ} onChange={(e) => setFolderQ(e.target.value)} placeholder="Search for a folder" /></div>
                <div className="h10-aig-folderempty"><Folder size={18} /> No keyword folders yet</div>
              </div>
            )}
            {tab === 'enter' && (
              <textarea className="h10-aig-enter" value={enter} onChange={(e) => setEnter(e.target.value)} onBlur={() => { enter.split(/[\n,]/).forEach(add); setEnter('') }} placeholder="Enter keywords, one per line" />
            )}
          </div>
          <AddedPanel list={seeds} setList={setSeeds} max={10} />
        </div>
      )}
    </div>
  )
}

/* Generic keyword entry (Exclude Keywords): textarea + Add button + N/10 panel. */
function KeywordEntry({ placeholder, text, setText, list, setList, max }: { placeholder: string; text: string; setText: (v: string) => void; list: string[]; setList: (v: string[]) => void; max: number }) {
  const add = () => { const toks = text.split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean); if (!toks.length) return; setList(Array.from(new Set([...list, ...toks])).slice(0, max)); setText('') }
  return (
    <div className="h10-aig-kwgrid">
      <div className="kw-left">
        <textarea className="h10-aig-enter" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
    <div className="h10-aig-kwbtn"><Button variant="primary" disabled={!text.trim() || list.length >= max} onClick={add}>Add Keywords</Button></div>
      </div>
      <AddedPanel list={list} setList={setList} max={max} />
    </div>
  )
}

function AddedPanel({ list, setList, max }: { list: string[]; setList: (v: string[]) => void; max: number }) {
  return (
    <div className="kw-added">
      <div className="kw-added-h"><span>{list.length}/{max} Added</span><button type="button" className="rm" onClick={() => setList([])} disabled={!list.length}><Trash2 size={12} /> Remove All</button></div>
      <div className="kw-added-col">Keyword</div>
      {list.length === 0 ? <div className="kw-added-empty"><ProductsEmptyArt /></div> : (
        <ul className="kw-added-list">{list.map((k) => <li key={k}>{k}<button type="button" onClick={() => setList(list.filter((x) => x !== k))} aria-label={`Remove ${k}`}><X size={12} /></button></li>)}</ul>
      )}
    </div>
  )
}

function ProductsEmptyArt() {
  return (
    <svg className="h10-aig-emptyart" viewBox="0 0 80 64" fill="none" aria-hidden>
      <rect x="14" y="10" width="38" height="46" rx="3" fill="#eef2f7" />
      <rect x="20" y="18" width="26" height="3" rx="1.5" fill="#d4dce6" /><rect x="20" y="26" width="26" height="3" rx="1.5" fill="#d4dce6" /><rect x="20" y="34" width="18" height="3" rx="1.5" fill="#d4dce6" />
      <circle cx="50" cy="40" r="13" fill="#fff" stroke="#c2cdda" strokeWidth="2.5" /><line x1="59" y1="49" x2="66" y2="56" stroke="#c2cdda" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/* ── Add Products — reuses the shared SP Super Wizard ProductSelection (Search/Enter tabs +
   parent→child variation expansion + N-Added panel), mapped to AI Goal's budget-bearing Prod. ── */
function AddProductsModal({ selected, onClose, onApply }: { selected: Prod[]; onClose: () => void; onApply: (ps: Prod[]) => void }) {
  const [picked, setPicked] = useState<SpwProduct[]>(selected.map(prodToSpw))
  const apply = () => {
    const prevById = new Map(selected.map((p) => [p.id, p]))
    onApply(picked.map((s) => spwToProd(s, prevById.get(s.id))))
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Add Products to Product Selection"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button><span className="grow" /><Button variant="primary" disabled={!picked.length} onClick={apply}>Add Products</Button>
        </>
      }
    >
      <ProductSelection products={picked} setProducts={setPicked} />
    </Modal>
  )
}

/* ── Advanced Targeting drawer (right slide-over): Product Targets + Exclude ASINs ── */
function AdvancedTargetingDrawer({ productTargets, excludeAsins, onClose, onSave }: { productTargets: string[]; excludeAsins: string[]; onClose: () => void; onSave: (pt: string[], ea: string[]) => void }) {
  const [pt, setPt] = useState(productTargets.join('\n'))
  const [ea, setEa] = useState(excludeAsins.join('\n'))
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean)
  const ptN = lines(pt).length, eaN = lines(ea).length
  return (
    <div className="h10-aig-drawer-back" onClick={onClose}>
      <aside className="h10-aig-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Advanced Targeting">
        <div className="dh"><b>Advanced Targeting</b><button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        <div className="db">
          <div className="dfield"><div className="dl"><span>Product Targets <InfoTip tip="Target specific products (ASINs) so your ads show on their detail pages." /></span><span className="cnt">{ptN}/10 Added</span></div>
            <textarea value={pt} onChange={(e) => setPt(e.target.value)} placeholder="Enter product targets, one per line" /></div>
          <div className="dfield"><div className="dl"><span>Exclude ASINs <InfoTip tip="Stop your ads from showing on these ASINs." /></span><span className="cnt">{eaN} Added</span></div>
            <textarea value={ea} onChange={(e) => setEa(e.target.value)} placeholder="Enter product ASINs you do not want to target, one per line" /></div>
        </div>
        <div className="df"><Button onClick={onClose}>Cancel</Button><span className="grow" /><Button variant="primary" disabled={!ptN && !eaN} onClick={() => onSave(lines(pt), lines(ea))}>Save</Button></div>
      </aside>
    </div>
  )
}
