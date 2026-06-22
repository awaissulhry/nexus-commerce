'use client'

/**
 * CBN.3.3 — Details tab: the campaign settings form (Helium 10 match). Left sub-nav +
 * scrolling sections (Campaign Details · Bidding Strategy · Sites · Bid Multiplier · Bid
 * Strategy · Product Selection) + a sticky Discard/Save footer.
 *
 * Wired to live endpoints: PATCH /campaigns/:id (dailyBudget, biddingStrategy, endDate),
 * PATCH /campaigns/:id/placements (Top/Product/Rest bid %), PATCH /campaigns/:id/automation
 * (Target-ACoS). Fields with no Amazon counterpart yet (Sites, the video/B2B boosts, the
 * Audience Bid Modifier picker, Bid-algorithm cards other than Target ACoS, Min/Max bid)
 * render per H10 but are UI-only — flagged with the `uiOnly` notes below — exactly as the
 * Ad Manager treats them.
 *
 * Pixel-match pass (ad-manager-campaign-detail.mov): Bid-algorithm card icons
 * (Rocket/Bar-chart/Droplet/Gear + the Adtomic atom mark), Target-ACoS info tooltip,
 * Min/Max enable checkbox + boxed currency prefix, Sites plain subtext (was an Info
 * banner), Amazon-Business-Bid-Boost reveal %, the Audience-Bid-Modifier picker
 * (From AMC / From Amazon · search · +Add · pager · "Audience Added 0/1" panel), the
 * custom End-Date calendar popover, and the Product-Selection amazon badge + ASIN copy.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Calendar, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Search, Check, Copy, Rocket, BarChart3, Droplet, Settings, Ban } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { InfoTip } from '../../InfoTip'
import { num } from '../../_grid/format'
import type { CampaignDetailData } from '../CampaignDetail'
import { PlacementBidMultiplier } from '../../../_shared/PlacementBidMultiplier'

interface DynBidding { strategy?: string; placementBidding?: Array<{ placement: string; percentage: number }> }
type StratUI = 'DOWN' | 'UPDOWN' | 'FIXED'
const STRAT_TO_UI: Record<string, StratUI> = { LEGACY_FOR_SALES: 'DOWN', AUTO_FOR_SALES: 'UPDOWN', MANUAL: 'FIXED' }
const UI_TO_STRAT: Record<StratUI, string> = { DOWN: 'LEGACY_FOR_SALES', UPDOWN: 'AUTO_FOR_SALES', FIXED: 'MANUAL' }
const AMZ_PLACEMENT = { tos: 'PLACEMENT_TOP', pdp: 'PLACEMENT_PRODUCT_PAGE', ros: 'PLACEMENT_REST_OF_SEARCH' } as const

const STRATEGIES: Array<{ key: StratUI; label: string; desc: string }> = [
  { key: 'DOWN', label: 'Dynamic Bids - Down only', desc: 'Amazon lowers your bids in real time when your ad may be less likely to convert to a sale.' },
  { key: 'UPDOWN', label: 'Dynamic Bids - Up and Down', desc: 'Amazon raises your bids (by a maximum of 100%) in real time when your ad may be more likely to convert to a sale, and lower your bids when less likely to convert to a sale.' },
  { key: 'FIXED', label: 'Fixed Bids', desc: "Amazon uses your exact bid and any manual adjustments you set, and won't change your bids based on likelihood of a sale." },
]
const SITES = [
  { key: 'BEYOND', label: 'Amazon and beyond', desc: 'Ads appear on Amazon—including both Amazon retail and Amazon Business—as well as select sites and apps off Amazon.' },
  { key: 'BUSINESS', label: 'Amazon Business', desc: 'Use a B2B strategy to increase sales and exclusively reach business shoppers on Amazon Business.' },
] as const
const ALGOS = [
  { key: 'MAX_IMPRESSIONS', kind: 'Bid Algorithm', label: 'Max Impressions', desc: 'A bid algorithm for products in a launch stage that need to get as many impressions as possible.', Icon: Rocket },
  { key: 'TARGET_ACOS', kind: 'Bid Algorithm', label: 'Target ACoS', desc: 'A bid algorithm for products in a performance stage should target an ACoS for scalable advertising.', Icon: BarChart3 },
  { key: 'MAX_ORDERS', kind: 'Bid Algorithm', label: 'Max Orders', desc: 'A bid algorithm for products in a liquidate stage should bid for maximum orders to clear out inventory.', Icon: Droplet },
  { key: 'CUSTOM', kind: 'Custom Rule', label: 'Custom', desc: "Create a custom rule that adjust a target's bid based on your set performance criteria.", Icon: Settings },
] as const

// Verbatim info-icon tooltip copy captured from the recording (dark hover cards).
const TIPS = {
  placement: 'Apply bid adjustments for sales by entering percentage to increase your default bid. These adjustments will apply on all bids in the campaign. Based on your bidding strategy, your bids can change further.',
  videoBoost: 'Further increase bids for video ads. These increases apply on top of your placement adjustments.',
  abBoost: 'Further increase bids across placements on Amazon Business. The percentage value set is the percentage of the original bid including any other bid adjustments such as placement bidding. For example, a placement bidding with 50% adjustment on a $1.00 bid would increase the bid by $1.50, and an Amazon Business with 100% adjustment would further increase the bid to $3.00. On average, advertisers see a 2x to 3x higher return on ad spend on Amazon Business relative to the overall campaign performance (Amazon internal data, 2024).',
  audience: 'Adjust your bids for specific audiences. Audience bid modifiers apply on top of your placement and platform adjustments.',
  targetAcos: 'Set a target ACoS value for the "Scale" bid algorithm',
  bidRule: 'Select a saved custom rule to adjust target bids based on your performance criteria.',
}

const SUBNAV = [
  { id: 'campaign-details', label: 'Campaign Details' },
  { id: 'bidding-strategy', label: 'Campaign Bidding Strategy' },
  { id: 'bid-multiplier', label: 'Bid Multiplier' },
  { id: 'bid-strategy', label: 'Bid Strategy' },
  { id: 'product-selection', label: 'Product Selection' },
]

interface FormState {
  name: string
  portfolioId: string
  dailyBudget: string
  neverExpire: boolean
  endDate: string
  strategy: StratUI
  tos: string; pdp: string; ros: string
  // UI-only:
  sites: 'BEYOND' | 'BUSINESS'
  videoBoost: boolean; abBoost: boolean; abBoostPct: string; audienceMod: boolean
  algo: string
  targetAcos: string
  minmaxOn: boolean; minBid: string; maxBid: string
}

const pbValue = (dyn: DynBidding | undefined, placement: string): string => {
  const e = dyn?.placementBidding?.find((p) => p.placement === placement)
  return e ? String(e.percentage) : ''
}

/** H10 renders campaign dates as MM/DD/YYYY (US format) regardless of marketplace.
 *  Display-only — the calendar + save paths keep the ISO (YYYY-MM-DD) value. */
const mdy = (v: string | null | undefined): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''))
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(v ?? '').slice(0, 10)
}

function buildInitial(c: CampaignDetailData | null): FormState {
  const dyn = (c as unknown as { dynamicBidding?: DynBidding })?.dynamicBidding
  const stratRaw = c?.biddingStrategy ?? dyn?.strategy ?? 'LEGACY_FOR_SALES'
  const tAcos = (c as unknown as { targetAcos?: number | null })?.targetAcos
  return {
    name: c?.name ?? '',
    portfolioId: c?.portfolioId ?? '',
    dailyBudget: c?.dailyBudget != null && c.dailyBudget !== '' ? String(num(c.dailyBudget)) : '',
    neverExpire: !c?.endDate,
    endDate: c?.endDate ? String(c.endDate).slice(0, 10) : '',
    strategy: STRAT_TO_UI[stratRaw] ?? 'DOWN',
    tos: pbValue(dyn, 'PLACEMENT_TOP'),
    pdp: pbValue(dyn, 'PLACEMENT_PRODUCT_PAGE'),
    ros: pbValue(dyn, 'PLACEMENT_REST_OF_SEARCH'),
    sites: 'BEYOND',
    videoBoost: false, abBoost: false, abBoostPct: '', audienceMod: false,
    algo: tAcos != null ? 'TARGET_ACOS' : 'NONE',
    targetAcos: tAcos != null ? String(Math.round(num(tAcos) * 100)) : '',
    minmaxOn: true, minBid: '', maxBid: '',
  }
}

export function DetailsTab({ campaign, campaignId, onSaved }: { campaign: CampaignDetailData | null; campaignId: string; onSaved?: () => void }) {
  const baseline = useMemo(() => buildInitial(campaign), [campaign])
  const [form, setForm] = useState<FormState>(baseline)
  const [active, setActive] = useState('campaign-details')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => { setForm(baseline) }, [baseline])

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }))
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline)
  const currency = (campaign as unknown as { dailyBudgetCurrency?: string })?.dailyBudgetCurrency === 'EUR' ? '€' : '€'

  // scroll-spy: highlight the section nearest the top of the scroll viewport
  const refs = useRef<Record<string, HTMLElement | null>>({})
  useEffect(() => {
    const obs = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      if (vis[0]?.target.id) setActive(vis[0].target.id)
    }, { rootMargin: '-90px 0px -55% 0px', threshold: 0 })
    Object.values(refs.current).forEach((el) => el && obs.observe(el))
    return () => obs.disconnect()
  }, [])
  const goTo = (id: string) => { refs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setActive(id) }

  async function patch(path: string, body: Record<string, unknown>): Promise<boolean> {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return r.ok
    } catch { return false }
  }

  async function save() {
    setSaving(true)
    const calls: Array<Promise<boolean>> = []
    if (form.name !== baseline.name && form.name.trim() !== '') calls.push(patch('', { name: form.name.trim(), applyImmediately: true, reason: 'Campaign Details name' }))
    if (form.portfolioId !== baseline.portfolioId) calls.push(patch('', { portfolioId: form.portfolioId || null, applyImmediately: true, reason: 'Campaign Details portfolio' }))
    if (form.dailyBudget !== baseline.dailyBudget && form.dailyBudget !== '') calls.push(patch('', { dailyBudget: Number(form.dailyBudget), applyImmediately: true, reason: 'Campaign Details daily budget' }))
    if (form.strategy !== baseline.strategy) calls.push(patch('', { biddingStrategy: UI_TO_STRAT[form.strategy], applyImmediately: true, reason: 'Campaign Details bidding strategy' }))
    if (form.neverExpire !== baseline.neverExpire || form.endDate !== baseline.endDate) calls.push(patch('', { endDate: form.neverExpire ? null : (form.endDate || null), applyImmediately: true, reason: 'Campaign Details end date' }))
    if (form.tos !== baseline.tos || form.pdp !== baseline.pdp || form.ros !== baseline.ros) {
      const adjustments = ([['tos', form.tos], ['pdp', form.pdp], ['ros', form.ros]] as Array<[keyof typeof AMZ_PLACEMENT, string]>)
        .filter(([, v]) => v !== '' && Number(v) > 0)
        .map(([k, v]) => ({ placement: AMZ_PLACEMENT[k], percentage: Number(v) }))
      calls.push(patch('/placements', { adjustments }))
    }
    if (form.algo !== baseline.algo || form.targetAcos !== baseline.targetAcos) {
      const isAcos = form.algo === 'TARGET_ACOS'
      calls.push(patch('/automation', { bidAutomation: isAcos, targetAcos: isAcos && form.targetAcos !== '' ? Number(form.targetAcos) / 100 : null }))
    }
    const results = calls.length ? await Promise.all(calls) : []
    setSaving(false)
    const ok = results.length === 0 || results.every(Boolean)
    setToast(ok ? 'Campaign saved' : 'Some changes could not be saved (write-gate / non-live)')
    setTimeout(() => setToast(null), 3200)
    if (ok && results.length) onSaved?.()
  }

  const reg = (id: string) => (el: HTMLElement | null) => { refs.current[id] = el }

  return (
    <div className="h10-cd-details">
      <div className="h10-cd-cols">
      <nav className="h10-cd-subnav" aria-label="Campaign settings sections">
        {SUBNAV.map((s) => (
          <button key={s.id} type="button" className={active === s.id ? 'on' : ''} onClick={() => goTo(s.id)}>{s.label}</button>
        ))}
      </nav>

      <div className="h10-cd-form">
        {/* ── Campaign Details ── */}
        <section id="campaign-details" ref={reg('campaign-details')} className="h10-cd-sec">
          <h2>Campaign Details</h2>
          <div className="h10-cd-card">
            <div className="h10-cd-field"><label>Campaign Name <i>*</i></label>
              <input type="text" value={form.name} onChange={(e) => set('name', e.target.value)} aria-label="Campaign name" />
            </div>
            <div className="h10-cd-field"><label>Portfolio</label>
              <PortfolioSelect value={form.portfolioId} onChange={(v) => set('portfolioId', v)} marketplace={campaign?.marketplace ?? undefined} />
            </div>
            <div className="h10-cd-field s"><label>Daily Budget <i>*</i></label>
              <div className="h10-cd-money boxed"><span className="pf">{currency}</span><input type="number" min="1" step="1" value={form.dailyBudget} onChange={(e) => set('dailyBudget', e.target.value)} aria-label="Daily budget" /></div>
            </div>
            <div className="h10-cd-daterow">
              <div className="h10-cd-field"><label>Start Date <i>*</i></label>
                <div className="h10-cd-date ro"><span className="ib"><Calendar size={15} /></span><input type="text" value={campaign?.startDate ? mdy(campaign.startDate as string) : ''} readOnly aria-readonly /></div>
              </div>
              <div className="h10-cd-field"><label>End Date {!form.neverExpire ? <i>*</i> : null}</label>
                <EndDateCalendar value={form.endDate} disabled={form.neverExpire} onChange={(v) => set('endDate', v)} />
              </div>
              <label className="h10-cd-switch"><input type="checkbox" checked={form.neverExpire} onChange={(e) => set('neverExpire', e.target.checked)} /><span className="tk" /> Never Expire</label>
            </div>
          </div>
        </section>

        {/* ── Campaign Bidding Strategy ── */}
        <section id="bidding-strategy" ref={reg('bidding-strategy')} className="h10-cd-sec">
          <h2>Campaign Bidding Strategy</h2>
          <p className="sub">Select a strategy to optimize your campaign bidding performance</p>
          <div className="h10-cd-card pad">
            {STRATEGIES.map((s) => (
              <label key={s.key} className={`h10-cd-radio ${form.strategy === s.key ? 'on' : ''}`}>
                <input type="radio" name="strategy" checked={form.strategy === s.key} onChange={() => set('strategy', s.key)} />
                <span className="rc"><span className="t">{s.label}</span><span className="d">{s.desc}</span></span>
              </label>
            ))}
          </div>

          {/* Sites (UI-only — no Amazon field) */}
          <h2 className="mt">Sites</h2>
          <p className="sub">Sites are where your ads appear (websites or apps). Choose placements based on your campaign strategy.</p>
          <div className="h10-cd-card pad">
            {SITES.map((s) => (
              <label key={s.key} className={`h10-cd-radio ${form.sites === s.key ? 'on' : ''}`}>
                <input type="radio" name="sites" checked={form.sites === s.key} onChange={() => set('sites', s.key)} />
                <span className="rc"><span className="t">{s.label}</span><span className="d">{s.desc}</span></span>
              </label>
            ))}
          </div>
        </section>

        {/* ── Bid Multiplier ── */}
        <section id="bid-multiplier" ref={reg('bid-multiplier')} className="h10-cd-sec">
          <h2>Bid Multiplier</h2>
          <p className="sub">Set how much you want to increase your bid based on the placement and platform.</p>
          <div className="h10-cd-card pad">
            <PlacementBidMultiplier
              value={{ tos: form.tos, pdp: form.pdp, ros: form.ros, videoBoost: form.videoBoost, abBoost: form.abBoost, abBoostPct: form.abBoostPct, audienceMod: form.audienceMod }}
              onChange={(p) => setForm((f) => ({ ...f, ...p }))}
            />
          </div>
        </section>

        {/* ── Bid Strategy (H10 automation) ── */}
        <section id="bid-strategy" ref={reg('bid-strategy')} className="h10-cd-sec">
          <h2>Bid Strategy</h2>
          <p className="sub">Select a bid algorithm based on your product &amp; campaign goals</p>
          <div className="h10-cd-bidalgo">
            <div className="h10-cd-algos">
              {ALGOS.map((a) => (
                <button type="button" key={a.key} className={`h10-cd-algo ${form.algo === a.key ? 'on' : ''}`} onClick={() => set('algo', a.key)}>
                  <span className="hd"><span className="k"><AtomMark />{a.kind}</span><span className="ic"><a.Icon size={15} /></span></span>
                  <span className="ti">{a.label}</span>
                  <span className="d">{a.desc}</span>
                </button>
              ))}
            </div>
            <button type="button" className={`h10-cd-none ${form.algo === 'NONE' ? 'on' : ''}`} onClick={() => set('algo', 'NONE')}><span className="ic"><Ban size={18} /></span> None</button>

            {form.algo === 'TARGET_ACOS' && (
              <div className="h10-cd-field s h10-cd-acosrev"><label>Target ACoS <InfoTip tip={TIPS.targetAcos} /></label>
                <div className="h10-cd-pct"><input type="number" min="1" max="500" value={form.targetAcos} onChange={(e) => set('targetAcos', e.target.value)} aria-label="Target ACoS" /><span className="sf">%</span></div>
              </div>
            )}
            {form.algo === 'CUSTOM' && <BidRuleSelect />}

            <div className="h10-cd-bidalgo-sep" />
            <h2>Min/Max Bid</h2>
            <p className="sub">Set limits to keep your bid within an acceptable range</p>
            <div className="h10-cd-minmax">
              <label className="h10-cd-check"><input type="checkbox" checked={form.minmaxOn} onChange={(e) => set('minmaxOn', e.target.checked)} aria-label="Enable min/max bid limits" /><span className="bx"><Check size={13} /></span></label>
              <div className={`h10-cd-money boxed ${!form.minmaxOn ? 'disabled' : ''}`}><span className="pf">{currency}</span><input type="number" min="0" step="0.01" placeholder="Min" value={form.minBid} disabled={!form.minmaxOn} onChange={(e) => set('minBid', e.target.value)} aria-label="Min bid" /></div>
              <div className={`h10-cd-money boxed ${!form.minmaxOn ? 'disabled' : ''}`}><span className="pf">{currency}</span><input type="number" min="0" step="0.01" placeholder="Max" value={form.maxBid} disabled={!form.minmaxOn} onChange={(e) => set('maxBid', e.target.value)} aria-label="Max bid" /></div>
            </div>
          </div>
        </section>

        {/* ── Product Selection ── */}
        <section id="product-selection" ref={reg('product-selection')} className="h10-cd-sec">
          <h2>Product Selection</h2>
          <ProductSelection campaign={campaign} />
        </section>
      </div>
      </div>

      {/* sticky footer */}
      <div className="h10-cd-footer">
        <button type="button" className="h10-am-btn" onClick={() => setForm(baseline)} disabled={!dirty || saving}>Discard Changes</button>
        <span className="grow" />
        {toast && <span className="msg">{toast}</span>}
        <button type="button" className="h10-am-btn primary" onClick={() => void save()} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save Campaign'}</button>
      </div>
    </div>
  )
}

/** Adtomic atom mark — the small blue crossed-orbits glyph H10 puts before the
 *  "Bid Algorithm" / "Custom Rule" card label, with the navy cursor at the tip. */
function AtomMark() {
  return (
    <svg className="adt" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
      <ellipse cx="12" cy="12" rx="10" ry="4.3" stroke="#2f6fed" strokeWidth="1.5" transform="rotate(45 12 12)" />
      <ellipse cx="12" cy="12" rx="10" ry="4.3" stroke="#2f6fed" strokeWidth="1.5" transform="rotate(-45 12 12)" />
      <path d="M15.4 5.2 L21 3.4 L19.2 9 Z" fill="#0e2a52" />
    </svg>
  )
}

/** Portfolio picker — live list from GET /advertising/portfolios (sandbox → fixture).
 *  Opens a menu with "No Portfolio" + each portfolio; selecting sets the campaign's
 *  portfolioId (saved via PATCH; pushed to Amazon when the publish gate is live). */
function PortfolioSelect({ value, onChange, marketplace }: { value: string; onChange: (v: string) => void; marketplace?: string }) {
  const [open, setOpen] = useState(false)
  const [portfolios, setPortfolios] = useState<Array<{ portfolioId: string; name: string }>>([])
  const [loading, setLoading] = useState(true)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancel = false
    const qs = marketplace ? `?marketplace=${encodeURIComponent(marketplace)}` : ''
    fetch(`${getBackendUrl()}/api/advertising/portfolios${qs}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (!cancel) setPortfolios(Array.isArray(d?.portfolios) ? d.portfolios : []) })
      .catch(() => { if (!cancel) setPortfolios([]) })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [marketplace])
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k) }
  }, [open])
  const selected = portfolios.find((p) => p.portfolioId === value)
  const label = selected?.name ?? (value || 'Select a Portfolio')
  return (
    <div className={`h10-cd-pfsel ${open ? 'open' : ''}`} ref={ref}>
      <button type="button" className={`h10-cd-fakeselect ${value ? 'has' : ''}`} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="pl">{label}</span><span className="cv"><ChevronDown size={18} /></span>
      </button>
      {open && (
        <div className="h10-cd-pfmenu" role="listbox">
          <button type="button" className={`pfopt ${!value ? 'on' : ''}`} onClick={() => { onChange(''); setOpen(false) }}>
            <span>No Portfolio</span>{!value ? <Check size={14} /> : null}
          </button>
          {loading ? (
            <div className="pfmsg">Loading…</div>
          ) : portfolios.length === 0 ? (
            <div className="pfmsg">No portfolios found</div>
          ) : portfolios.map((p) => (
            <button type="button" key={p.portfolioId} className={`pfopt ${p.portfolioId === value ? 'on' : ''}`} onClick={() => { onChange(p.portfolioId); setOpen(false) }}>
              <span>{p.name}</span>{p.portfolioId === value ? <Check size={14} /> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Bid Rule picker — revealed when the Custom bid algorithm is selected (H10). A searchable
 *  combobox; no custom bid-rule data is wired yet, so it shows the empty "No options" state. */
function BidRuleSelect() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k) }
  }, [open])
  return (
    <div className="h10-cd-field h10-cd-bidrule h10-cd-acosrev">
      <label>Bid Rule <InfoTip tip={TIPS.bidRule} /></label>
      <div className={`h10-cd-pfsel ${open ? 'open' : ''}`} ref={ref}>
        <button type="button" className="h10-cd-fakeselect" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
          <span className="pl">Select a Bid Rule</span><span className="cv">{open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</span>
        </button>
        {open && (
          <div className="h10-cd-pfmenu">
            <div className="h10-cd-pfsearch"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search bid rules" /><Search size={16} /></div>
            <div className="h10-cd-pfempty">No options</div>
          </div>
        )}
      </div>
    </div>
  )
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const isoOf = (y: number, mo: number, d: number) => `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** Custom End-Date calendar popover (H10 match) — replaces the native date input. */
function EndDateCalendar({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const parsed = value ? new Date(`${value}T00:00:00`) : null
  const [view, setView] = useState(() => { const d = parsed ?? new Date(); return { y: d.getFullYear(), m: d.getMonth() } })

  const openCal = () => {
    if (disabled) return
    const d = parsed ?? new Date()
    setView({ y: d.getFullYear(), m: d.getMonth() })
    setPos({ top: -9999, left: -9999 }) // off-screen until measured post-mount
    setOpen(true)
  }

  // Place below the trigger; flip above only when there's no room; clamp to the
  // viewport. Measured AFTER the popover mounts (like InfoTip) so it can never
  // stick to the wrong edge regardless of scroll position.
  useLayoutEffect(() => {
    if (!open || !popRef.current || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const c = popRef.current.getBoundingClientRect()
    const m = 8
    let left = r.left
    if (left + c.width > window.innerWidth - m) left = window.innerWidth - m - c.width
    if (left < m) left = m
    let top = r.bottom + 6
    if (top + c.height > window.innerHeight - m && r.top - 6 - c.height >= m) top = r.top - 6 - c.height
    if (top < m) top = m
    if (!pos || Math.abs(pos.top - top) > 0.5 || Math.abs(pos.left - left) > 0.5) setPos({ top, left })
  }, [open, pos])

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setOpen(false) }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const s = () => setOpen(false) // close on scroll so the fixed popover never detaches
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k); window.addEventListener('scroll', s, true)
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); window.removeEventListener('scroll', s, true) }
  }, [open])

  const startDow = new Date(view.y, view.m, 1).getDay()
  const prevDays = new Date(view.y, view.m, 0).getDate()
  const days = new Date(view.y, view.m + 1, 0).getDate()
  const cells: Array<{ d: number; mo: number; y: number; cur: boolean }> = []
  for (let i = startDow - 1; i >= 0; i--) cells.push({ d: prevDays - i, mo: (view.m + 11) % 12, y: view.m === 0 ? view.y - 1 : view.y, cur: false })
  for (let d = 1; d <= days; d++) cells.push({ d, mo: view.m, y: view.y, cur: true })
  for (let n = 1; cells.length < 42; n++) cells.push({ d: n, mo: (view.m + 1) % 12, y: view.m === 11 ? view.y + 1 : view.y, cur: false })

  const nav = (delta: number) => setView((v) => { const t = v.m + delta; return { y: v.y + Math.floor(t / 12), m: ((t % 12) + 12) % 12 } })
  const pick = (c: { d: number; mo: number; y: number }) => { onChange(isoOf(c.y, c.mo, c.d)); setOpen(false) }

  return (
    <>
      <button type="button" ref={btnRef} className={`h10-cd-date btn ${disabled ? 'disabled' : ''} ${open ? 'open' : ''}`} onClick={openCal} disabled={disabled} aria-haspopup="dialog" aria-expanded={open}>
        <span className="ib"><Calendar size={15} /></span>
        <span className={value ? 'v' : 'ph'}>{value ? mdy(value) : 'Enter a Date'}</span>
      </button>
      {open && pos && typeof document !== 'undefined' && createPortal(
        <div ref={popRef} className="h10-cd-cal" style={{ top: pos.top, left: pos.left }} role="dialog" aria-label="Choose end date">
          <div className="cal-h">
            <button type="button" className="cal-nav" onClick={() => nav(-1)} aria-label="Previous month"><ChevronLeft size={18} /></button>
            <span className="cal-t">{MONTHS[view.m]} {view.y}</span>
            <button type="button" className="cal-nav" onClick={() => nav(1)} aria-label="Next month"><ChevronRight size={18} /></button>
          </div>
          <div className="cal-wd">{WEEKDAYS.map((w, i) => <span key={i}>{w}</span>)}</div>
          <div className="cal-grid">
            {cells.map((c, i) => (
              <button type="button" key={i} className={`cal-d ${c.cur ? '' : 'out'} ${value && isoOf(c.y, c.mo, c.d) === value ? 'sel' : ''}`} onClick={() => pick(c)}>{c.d}</button>
            ))}
          </div>
        </div>, document.body,
      )}
    </>
  )
}

type Prod = { asin?: string | null; sku?: string | null; name?: string | null; photoUrl?: string | null }
function ProductSelection({ campaign }: { campaign: CampaignDetailData | null }) {
  // The campaign-embedded productAds carry null details; the per-ad-group endpoint returns
  // the real asin/sku/name/photoUrl, so fetch those and dedupe by ASIN/SKU.
  const adGroups = useMemo(() => (campaign?.adGroups as Array<{ id: string }> | undefined) ?? [], [campaign])
  const [products, setProducts] = useState<Prod[]>([])
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => {
    if (!adGroups.length) { setLoading(false); setProducts([]); return }
    let cancel = false; setLoading(true)
    Promise.all(adGroups.map((ag) => fetch(`${getBackendUrl()}/api/advertising/ad-groups/${ag.id}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)))
      .then((results) => {
        if (cancel) return
        const seen = new Set<string>(); const out: Prod[] = []
        for (const res of results) for (const a of ((res?.adGroup?.ads ?? []) as Prod[])) { const k = a.asin || a.sku || a.name; if (k && !seen.has(k)) { seen.add(k); out.push({ asin: a.asin, sku: a.sku, name: a.name, photoUrl: a.photoUrl }) } }
        setProducts(out)
      })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [adGroups])

  const copy = (asin: string) => { try { void navigator.clipboard?.writeText(asin); setCopied(asin); setTimeout(() => setCopied((c) => (c === asin ? null : c)), 1400) } catch { /* clipboard unavailable */ } }

  if (loading) return <div className="h10-cd-card pad"><span className="h10-cd-muted">Loading products…</span></div>
  return (
    <div className="h10-cd-card">
      <div className="h10-cd-prodcount">{products.length} Product{products.length === 1 ? '' : 's'} Added</div>
      {products.length === 0 ? (
        <div className="h10-cd-prodempty">No products are attached to this campaign.</div>
      ) : (
        <ul className="h10-cd-products">
          <li className="hd"><span>Product</span></li>
          {products.map((p, i) => (
            <li key={(p.asin || p.sku || i).toString()}>
              <span className="thumb">{p.photoUrl ? <img src={p.photoUrl} alt="" /> : <span className="ph" />}<span className="amz" aria-label="Amazon">a</span></span>
              <div className="pi">
                <span className="t">{p.name || p.asin || p.sku || 'Advertised product'}</span>
                {p.asin || p.sku ? (
                  <span className="m">
                    <span className="asin">{p.asin || p.sku}</span>
                    {p.asin ? <button type="button" className="cp" onClick={() => copy(p.asin as string)} aria-label="Copy ASIN" title={copied === p.asin ? 'Copied' : 'Copy ASIN'}>{copied === p.asin ? <Check size={12} /> : <Copy size={12} />}</button> : null}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
