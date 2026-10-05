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
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Input, RadioCard, Toggle, ToolbarButton } from '@/design-system/primitives'
import { DateField, Field, Listbox } from '@/design-system/components'
import { Calendar, Check, Copy, Rocket, BarChart3, Droplet, Settings, Ban } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { InfoTip } from '../../InfoTip'
import { num } from '../../_grid/format'
import { readDailyBudget } from '../../../_shared/budgetInput'
import type { CampaignDetailData } from '../CampaignDetail'
import { PlacementBidMultiplier } from '../../../_shared/PlacementBidMultiplier'
import { changedPlacementLanes } from '../../../_shared/placementLanes'
import { assignablePortfolios, isLocalOnlyPortfolio, type PortfolioOption } from '../../../_shared/portfolioPicker'
import '../../campaigns-ds.css'

interface DynBidding { strategy?: string; placementBidding?: Array<{ placement: string; percentage: number }>; bidAlgorithm?: string; targetAcos?: number | null }
/** The algorithms the API stores (`campaign-settings.service.ts` BID_ALGORITHMS). Custom has no store yet. */
const STORED_ALGOS = new Set(['TARGET_ACOS', 'MAX_IMPRESSIONS', 'MAX_ORDERS'])
type StratUI = 'DOWN' | 'UPDOWN' | 'FIXED'
const STRAT_TO_UI: Record<string, StratUI> = { LEGACY_FOR_SALES: 'DOWN', AUTO_FOR_SALES: 'UPDOWN', MANUAL: 'FIXED' }
const UI_TO_STRAT: Record<StratUI, string> = { DOWN: 'LEGACY_FOR_SALES', UPDOWN: 'AUTO_FOR_SALES', FIXED: 'MANUAL' }

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

/** A typed amount: '' = empty, NaN = not a number. A decimal comma is read as a point. */
const amount = (v: string): number => (v.trim() === '' ? NaN : Number(v.trim().replace(',', '.')))
/** Cents as the form shows them (euros, two decimals); '' when unset. */
const centsText = (c: number | null | undefined): string => (c == null ? '' : (c / 100).toFixed(2))
/** The form's Min/Max Bid as the cents `/guardrails` stores; null = no bound (box empty, or the limits switched off). */
const boundCents = (on: boolean, v: string): number | null => (on && v.trim() !== '' ? Math.round(amount(v) * 100) : null)

function buildInitial(c: CampaignDetailData | null): FormState {
  const dyn = (c?.dynamicBidding ?? undefined) as DynBidding | undefined
  const stratRaw = c?.biddingStrategy ?? dyn?.strategy ?? 'LEGACY_FOR_SALES'
  // 🔴 CM-12 — the target lives in `dynamicBidding.targetAcos` (a fraction), the store the grid and the bid engines
  // read. This read `campaign.targetAcos`, which the detail endpoint never returns, so the box was always empty.
  const tAcos = dyn?.targetAcos ?? null
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
    /**
     * 🔴 C4 — reads the REAL field now. It used to infer the algorithm from whether a target ACoS
     * happened to be set, which is why saving this form wrote `bidAutomation` (see `save`): the
     * two were entangled because neither had a store of its own. `dynamicBidding.bidAlgorithm`
     * has been that store since C1, and it is what both grids' Bid Rule column reads.
     */
    // CM-12 — no longer guessed from the target: a target ACoS is its own setting (the grid shows it in its own
    // column), and "Target ACoS" shown as chosen when nobody chose it is the same fallback-as-setting the grid removed.
    algo: dyn?.bidAlgorithm ?? 'NONE',
    // Two decimals, as the grid shows it: a whole-percent round would show 26 for a stored 25.5.
    targetAcos: tAcos != null ? String(Number((num(tAcos) * 100).toFixed(2))) : '',
    // CM-12 — the campaign's real bid bounds (`Campaign.minBidCents/maxBidCents`, enforced by the write gate), which
    // these boxes never loaded and Save never wrote.
    minmaxOn: true, minBid: centsText(c?.minBidCents), maxBid: centsText(c?.maxBidCents),
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
  // PR 1c (CM-7) — the budget box follows the one rule in `_shared/budgetInput.ts`: to the cent, and
  // an empty, non-number or below-€1.00 box sends nothing. Save stays off while the field says why.
  const budgetRead = readDailyBudget(form.dailyBudget)
  const budgetProblem = form.dailyBudget !== baseline.dailyBudget && !budgetRead.ok ? budgetRead.message : null
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
    // CM-12 — refuse what cannot be saved before anything is sent, with the reason.
    const fail = (m: string) => { setToast(m); setTimeout(() => setToast(null), 4200) }
    const acosChanged = form.targetAcos !== baseline.targetAcos
    if (acosChanged && form.targetAcos.trim() !== '' && !(amount(form.targetAcos) >= 0)) return fail('Target ACoS must be a number (or empty for none).')
    const minCents = boundCents(form.minmaxOn, form.minBid)
    const maxCents = boundCents(form.minmaxOn, form.maxBid)
    const boundsChanged = minCents !== boundCents(baseline.minmaxOn, baseline.minBid) || maxCents !== boundCents(baseline.minmaxOn, baseline.maxBid)
    if (boundsChanged) {
      if ((minCents != null && !(minCents >= 0)) || (maxCents != null && !(maxCents >= 0))) return fail('Min and Max Bid must be amounts (or empty for no limit).')
      if (minCents != null && maxCents != null && minCents > maxCents) return fail('Min Bid is above Max Bid.')
    }
    setSaving(true)
    // CM-12 — one call after the other. `/placements`, `/automation` and `/guardrails` each read the campaign's
    // settings and write them back; sent together, the last one to finish put back what the others had just saved.
    const calls: Array<() => Promise<boolean>> = []
    let customNotSaved = false
    if (form.name !== baseline.name && form.name.trim() !== '') calls.push(() => patch('', { name: form.name.trim(), applyImmediately: true, reason: 'Campaign Details name' }))
    if (form.portfolioId !== baseline.portfolioId) calls.push(() => patch('', { portfolioId: form.portfolioId || null, applyImmediately: true, reason: 'Campaign Details portfolio' }))
    if (form.dailyBudget !== baseline.dailyBudget && budgetRead.ok && budgetRead.value !== num(baseline.dailyBudget)) calls.push(() => patch('', { dailyBudget: budgetRead.value, applyImmediately: true, reason: 'Campaign Details daily budget' }))
    if (form.strategy !== baseline.strategy) calls.push(() => patch('', { biddingStrategy: UI_TO_STRAT[form.strategy], applyImmediately: true, reason: 'Campaign Details bidding strategy' }))
    if (form.neverExpire !== baseline.neverExpire || form.endDate !== baseline.endDate) calls.push(() => patch('', { endDate: form.neverExpire ? null : (form.endDate || null), applyImmediately: true, reason: 'Campaign Details end date' }))
    // CM-18 — only the lanes changed here; a lane left alone is not re-sent from this page's copy.
    const changedLanes = changedPlacementLanes(baseline, form)
    if (changedLanes.length) calls.push(() => patch('/placements', { adjustments: changedLanes, partial: true }))
    // CM-12 — the algorithm saves as chosen, and the target only when it changed. Choosing Max Impressions or Max
    // Orders sent `bidAlgorithm: null, targetAcos: null`, erasing what was stored.
    const automation: Record<string, unknown> = {}
    if (form.algo !== baseline.algo) {
      if (form.algo === 'CUSTOM') customNotSaved = true // no custom bid rule can be stored yet (the Bid Rule list is empty)
      else automation.bidAlgorithm = STORED_ALGOS.has(form.algo) ? form.algo : null
    }
    if (acosChanged) automation.targetAcos = form.targetAcos.trim() === '' ? null : amount(form.targetAcos) / 100
    if (Object.keys(automation).length) {
      /**
       * 🔴 C4 — this used to send `bidAutomation: isAcos`, so choosing the Target ACoS algorithm
       * here — or merely editing the target percentage — silently switched **Bid Automation** on,
       * a field both grids present as an independent operator switch with its own toggle and its
       * own bulk verb. One control, two meanings, depending on which page you were standing on.
       * The algorithm now writes `bidAlgorithm`, which is its own field, and `bidAutomation` is
       * left alone here: nothing but the switch itself should ever move it.
       */
      calls.push(() => patch('/automation', automation))
    }
    // CM-12 — Min/Max Bid through the same endpoint the grid's Min/Max Bid cell uses.
    if (boundsChanged) calls.push(() => patch('/guardrails', { minBidCents: minCents, maxBidCents: maxCents }))
    const results: boolean[] = []
    for (const call of calls) results.push(await call())
    setSaving(false)
    const ok = results.length === 0 || results.every(Boolean)
    // A custom bid rule has nowhere to be stored yet, so choosing it changes nothing — said, not toasted as saved.
    const customNote = 'A custom bid rule cannot be saved yet, so the bid algorithm was not changed.'
    setToast(customNotSaved && !results.length ? customNote
      : `${ok ? 'Campaign saved' : 'Some changes could not be saved (write-gate / non-live)'}${customNotSaved ? `. ${customNote}` : ''}`)
    setTimeout(() => setToast(null), 3200)
    if (ok && results.length) onSaved?.()
  }

  const reg = (id: string) => (el: HTMLElement | null) => { refs.current[id] = el }

  return (
    <div className="h10-cd-details">
      <div className="h10-cd-cols">
      <nav className="cd-subnav" aria-label="Campaign settings sections">
        {SUBNAV.map((s) => (
          <Button key={s.id} variant={active === s.id ? 'tonal' : 'quiet'} block onClick={() => goTo(s.id)}>{s.label}</Button>
        ))}
      </nav>

      <div className="h10-cd-form">
        {/* ── Campaign Details ── */}
        <section id="campaign-details" ref={reg('campaign-details')} className="h10-cd-sec">
          <h2>Campaign Details</h2>
          <div className="h10-cd-card">
            <Field className="cd-field" label="Campaign Name" required>
              <Input value={form.name} onChange={(e) => set('name', e.target.value)} fieldClassName="cd-field-full" />
            </Field>
            <Field className="cd-field" label="Portfolio">
              <PortfolioSelect value={form.portfolioId} onChange={(v) => set('portfolioId', v)} marketplace={campaign?.marketplace ?? undefined} />
            </Field>
            <Field className="cd-field s" label="Daily Budget" required error={budgetProblem}>
              <Input inputMode="decimal" prefix={currency} value={form.dailyBudget} onChange={(e) => set('dailyBudget', e.target.value)} fieldClassName="cd-money-boxed" />
            </Field>
            <div className="h10-cd-daterow">
              <Field className="cd-field" label="Start Date" required htmlFor="cd-startdate">
                <div className="h10-cd-date ro"><span className="ib"><Calendar size={15} /></span><input id="cd-startdate" type="text" value={campaign?.startDate ? mdy(campaign.startDate as string) : ''} readOnly aria-readonly /></div>
              </Field>
              {/* `Field` auto-associates by cloning its single child with a generated id, and
                  `DateField` takes an `id` now — so the label reaches the trigger without one
                  being invented here. */}
              <Field className="cd-field" label="End Date" required={!form.neverExpire}>
                <DateField
                  className="cd-datefield"
                  value={form.endDate}
                  onChange={(v) => set('endDate', v)}
                  format="mm/dd/yyyy"
                  locale="en-US"
                  disabled={form.neverExpire}
                  placeholder="Enter a Date"
                  clearable={false}
                  ariaLabel="End date"
                />
              </Field>
              <span className="h10-cd-switch"><Toggle checked={form.neverExpire} onChange={(v) => set('neverExpire', v)} aria-label="Never Expire" /> Never Expire</span>
            </div>
          </div>
        </section>

        {/* ── Campaign Bidding Strategy ── */}
        <section id="bidding-strategy" ref={reg('bidding-strategy')} className="h10-cd-sec">
          <h2>Campaign Bidding Strategy</h2>
          <p className="sub">Select a strategy to optimize your campaign bidding performance</p>
          <div className="h10-cd-card pad">
            {STRATEGIES.map((s) => (
              <RadioCard
                key={s.key}
                variant="row"
                name="strategy"
                title={s.label}
                description={s.desc}
                selected={form.strategy === s.key}
                checked={form.strategy === s.key}
                onChange={() => set('strategy', s.key)}
              />
            ))}
          </div>

          {/* Sites (UI-only — no Amazon field) */}
          <h2 className="mt">Sites</h2>
          <p className="sub">Sites are where your ads appear (websites or apps). Choose placements based on your campaign strategy.</p>
          <div className="h10-cd-card pad">
            {SITES.map((s) => (
              <RadioCard
                key={s.key}
                variant="row"
                name="sites"
                title={s.label}
                description={s.desc}
                selected={form.sites === s.key}
                checked={form.sites === s.key}
                onChange={() => set('sites', s.key)}
              />
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

            {/* CM-12 — also shown when a target is stored under another algorithm: the bid engines read it either way. */}
            {(form.algo === 'TARGET_ACOS' || baseline.targetAcos !== '') && (
              <Field className="cd-field s h10-cd-acosrev" label="Target ACoS" info={<InfoTip tip={TIPS.targetAcos} />}>
                <Input inputMode="decimal" suffix="%" value={form.targetAcos} onChange={(e) => set('targetAcos', e.target.value)} fieldClassName="cd-pct-field" />
              </Field>
            )}
            {form.algo === 'CUSTOM' && <BidRuleSelect />}

            <div className="h10-cd-bidalgo-sep" />
            <h2>Min/Max Bid</h2>
            <p className="sub">Set limits to keep your bid within an acceptable range</p>
            <div className="h10-cd-minmax">
              <Checkbox checked={form.minmaxOn} onChange={(e) => set('minmaxOn', e.target.checked)} aria-label="Enable min/max bid limits" />
              <Input inputMode="decimal" prefix={currency} placeholder="Min" value={form.minBid} disabled={!form.minmaxOn} onChange={(e) => set('minBid', e.target.value)} aria-label="Min bid" fieldClassName="cd-money-boxed" />
              <Input inputMode="decimal" prefix={currency} placeholder="Max" value={form.maxBid} disabled={!form.minmaxOn} onChange={(e) => set('maxBid', e.target.value)} aria-label="Max bid" fieldClassName="cd-money-boxed" />
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
    <Button onClick={() => setForm(baseline)} disabled={!dirty || saving}>Discard Changes</Button>
        <span className="grow" />
        {toast && <span className="msg">{toast}</span>}
    <Button variant="primary" onClick={() => void save()} disabled={!dirty || saving || budgetProblem != null}>{saving ? 'Saving…' : 'Save Campaign'}</Button>
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
function PortfolioSelect({ value, onChange, marketplace, id }: { value: string; onChange: (v: string) => void; marketplace?: string; id?: string }) {
  const [portfolios, setPortfolios] = useState<PortfolioOption[]>([])
  const [loading, setLoading] = useState(true)
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
  // CM-21 — only this market's portfolios that exist on Amazon can be chosen: one created in Nexus while writes were
  // closed (`local-pf-…`) has no Amazon id. The campaign's current portfolio stays visible, named for what it is.
  const options = useMemo(() => {
    const list = assignablePortfolios(portfolios, marketplace ?? null).map((p) => ({ value: p.portfolioId, label: p.name }))
    if (value && !list.some((o) => o.value === value)) {
      const name = portfolios.find((p) => p.portfolioId === value)?.name ?? value
      list.unshift({ value, label: isLocalOnlyPortfolio(value) ? `${name} (only in Nexus, not on Amazon)` : name })
    }
    return list
  }, [portfolios, marketplace, value])
  // `emptyLabel` is the DS's clear ROW — the difference between a filter select and a form
  // one — so "No Portfolio" is a real option here rather than a button above the list.
  return (
    <Listbox
      id={id}
      width="100%"
      ariaLabel="Portfolio"
      value={value}
      onChange={onChange}
      emptyLabel="No Portfolio"
      placeholder={loading ? 'Loading…' : 'Select a Portfolio'}
      options={options}
    />
  )
}

/** Bid Rule picker — revealed when the Custom bid algorithm is selected (H10). A searchable
 *  combobox; no custom bid-rule data is wired yet, so it shows the empty "No options" state. */
function BidRuleSelect() {
  return (
    <div className="h10-cd-field h10-cd-bidrule h10-cd-acosrev">
      <label>Bid Rule <InfoTip tip={TIPS.bidRule} /></label>
      {/* No custom bid-rule data is wired yet, so the list is deliberately empty: the DS
          renders its own "No options" state and the in-popover search. */}
      <Listbox
          width="100%"
        ariaLabel="Bid Rule"
        value=""
        onChange={() => {}}
        searchable
        searchPlaceholder="Search"
        placeholder="Select a Bid Rule"
        emptyIsPlaceholder
        options={[]}
      />
    </div>
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
                    {p.asin ? <ToolbarButton size="sm" tooltip={false} icon={copied === p.asin ? <Check size={12} /> : <Copy size={12} />} label="Copy ASIN" title={copied === p.asin ? 'Copied' : 'Copy ASIN'} onClick={() => copy(p.asin as string)} /> : null}
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
