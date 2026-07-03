'use client'

/**
 * E4 — campaign builder. Strategies: General fixed / General dynamic-capped /
 * General RULES-BASED (auto-select, with a local match preview) / Priority
 * manual / Priority smart (maxCpc). Hard EBAY_ES branch: Priority hidden.
 * Rules are immutable on eBay after create — the preview matters.
 */
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { AdsPageHeader } from '../../../_shell/AdsPageHeader'
import { Button } from '@/design-system/primitives/Button'
import { Input } from '@/design-system/primitives/Input'
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'
import { Banner } from '@/design-system/components/Banner'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '../../ebay.css'
import { postEbayAds, useWriteMode, SandboxBanner, eurC, EBAY_MARKETS } from '../../_shared'

type Strategy = 'CPS_FIXED' | 'CPS_DYNAMIC' | 'CPS_RULES' | 'CPC_MANUAL' | 'CPC_SMART'

const STRATEGIES: Array<{ value: Strategy; label: string }> = [
  { value: 'CPS_FIXED', label: 'General · fixed' },
  { value: 'CPS_DYNAMIC', label: 'General · dynamic' },
  { value: 'CPS_RULES', label: 'General · rules' },
  { value: 'CPC_MANUAL', label: 'Priority · manual' },
  { value: 'CPC_SMART', label: 'Priority · smart' },
]

interface PreviewMatch { itemId: string; title: string | null; price: string | null; categoryId: string | null }

export function EbayCampaignBuilder() {
  const router = useRouter()
  const writeMode = useWriteMode()
  const [name, setName] = useState('')
  const [marketplace, setMarketplace] = useState('EBAY_IT')
  const [strategy, setStrategy] = useState<Strategy>('CPS_FIXED')
  const [ratePct, setRatePct] = useState('8')
  const [capPct, setCapPct] = useState('12')
  const [adjustmentPct, setAdjustmentPct] = useState('0')
  const [budgetEur, setBudgetEur] = useState('5.00')
  const [maxCpcEur, setMaxCpcEur] = useState('0.40')
  const [autoSelect, setAutoSelect] = useState(true)
  const [ruleCategoryIds, setRuleCategoryIds] = useState('')
  const [ruleBrands, setRuleBrands] = useState('')
  const [ruleMinPrice, setRuleMinPrice] = useState('')
  const [ruleMaxPrice, setRuleMaxPrice] = useState('')
  const [preview, setPreview] = useState<{ matched: PreviewMatch[]; totalLive: number; note: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isEs = marketplace === 'EBAY_ES'
  const visibleStrategies = useMemo(() => STRATEGIES.filter((s) => !isEs || s.value.startsWith('CPS')), [isEs])
  const isCps = strategy.startsWith('CPS')
  const isRules = strategy === 'CPS_RULES'

  const selectionRules = () => [{
    ...(ruleBrands.trim() ? { brands: ruleBrands.split(',').map((b) => b.trim()).filter(Boolean) } : {}),
    ...(ruleCategoryIds.trim() ? { categoryIds: ruleCategoryIds.split(',').map((c) => c.trim()).filter(Boolean), categoryScope: 'MARKETPLACE' } : {}),
    ...(ruleMinPrice ? { minPrice: Number(ruleMinPrice) } : {}),
    ...(ruleMaxPrice ? { maxPrice: Number(ruleMaxPrice) } : {}),
  }]

  const runPreview = async () => {
    setBusy(true); setError(null)
    try {
      setPreview(await postEbayAds('/campaigns/preview-rules', { marketplace, selectionRules: selectionRules() }))
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const launch = async () => {
    setBusy(true); setError(null)
    try {
      const out = await postEbayAds<{ campaignId: string; mode: string }>('/campaigns', {
        name: name.trim(),
        marketplace,
        fundingModel: isCps ? 'COST_PER_SALE' : 'COST_PER_CLICK',
        ...(isCps
          ? strategy === 'CPS_DYNAMIC'
            ? { adRateStrategy: 'DYNAMIC', dynamicCapPct: Number(capPct), dynamicAdjustmentPct: Number(adjustmentPct) }
            : { adRateStrategy: 'FIXED', ratePct: Number(ratePct) }
          : {
              targetingType: strategy === 'CPC_SMART' ? 'SMART' : 'MANUAL',
              dailyBudgetCents: Math.round(Number(budgetEur) * 100),
              ...(strategy === 'CPC_SMART' ? { maxCpcCents: Math.round(Number(maxCpcEur) * 100) } : {}),
            }),
        ...(isRules ? { selectionRules: selectionRules(), autoSelectFutureInventory: autoSelect } : {}),
      })
      router.push(`/marketing/ads/ebay/campaigns/${out.campaignId}`)
    } catch (e) { setError((e as Error).message); setBusy(false) }
  }

  return (
    <div className="eb-page">
      <AdsPageHeader
        title="New eBay campaign"
        subtitle="General = % of sale under any-click attribution. Priority = CPC with keywords. Selection rules are immutable after launch."
        markets={EBAY_MARKETS.filter((m) => m.id !== 'all').map((m) => m.id)}
        market={marketplace}
        onMarketChange={(m) => { setMarketplace(m); if (m === 'EBAY_ES' && !strategy.startsWith('CPS')) setStrategy('CPS_FIXED') }}
      />
      <div className="eb-controls">
        <Link href="/marketing/ads/ebay/campaigns" className="eb-linkbtn"><ArrowLeft size={13} aria-hidden /> All campaigns</Link>
      </div>
      <SandboxBanner mode={writeMode} />
      {isEs && <Banner tone="warning" title="Priority is not available on eBay Spain">General and Offsite only — a verified eBay marketplace limitation.</Banner>}

      <section className="eb-panel">
        <div className="eb-form">
          <div className="eb-form-row">
            <div style={{ flex: 2 }}><label>Campaign name</label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Catch-all IT — General 8%" /></div>
            <div style={{ flex: 3 }}><label>Strategy</label><SegmentedControl options={visibleStrategies} value={strategy} onChange={(v) => setStrategy(v as Strategy)} aria-label="Strategy" /></div>
          </div>

          {isCps && strategy === 'CPS_FIXED' && (
            <div className="eb-form-row">
              <div><label>Ad rate % (2–100)</label><Input type="number" min={2} max={100} step={0.1} value={ratePct} onChange={(e) => setRatePct(e.target.value)} /></div>
              <p className="eb-be-hint">Ads inherit this rate at creation; per-ad rates can override later. Rates above a listing's break-even are guardrail-checked on every rate write.</p>
            </div>
          )}
          {isCps && strategy === 'CPS_DYNAMIC' && (
            <div className="eb-form-row">
              <div><label>Hard cap % (required)</label><Input type="number" min={2} max={100} step={0.1} value={capPct} onChange={(e) => setCapPct(e.target.value)} /></div>
              <div><label>Adjustment vs suggested %</label><Input type="number" min={-50} max={50} step={1} value={adjustmentPct} onChange={(e) => setAdjustmentPct(e.target.value)} /></div>
              <p className="eb-be-hint">Dynamic follows eBay's suggested rate daily — <b>the cap is your protection</b> (eBay once raised dynamic floors without notice). No suggested-rate API exists for IT/FR/ES; this is the bounded alternative.</p>
            </div>
          )}
          {!isCps && (
            <div className="eb-form-row">
              <div><label>Daily budget (EUR)</label><Input type="number" min={1} step={0.5} value={budgetEur} onChange={(e) => setBudgetEur(e.target.value)} /></div>
              {strategy === 'CPC_SMART' && <div><label>Max CPC (EUR)</label><Input type="number" min={0.02} max={100} step={0.01} value={maxCpcEur} onChange={(e) => setMaxCpcEur(e.target.value)} /></div>}
              <p className="eb-be-hint">eBay paces budgets monthly: a single day may spend up to 2× the daily budget (month capped at 30.4×). Budget edits: hard limit 15/day/campaign.{strategy === 'CPC_SMART' ? ' Smart: eBay picks keywords/bids under your max CPC; ≤3,000 listings; cannot switch to manual later.' : ' Add ad groups + keywords from the campaign page after launch.'}</p>
            </div>
          )}

          {isRules && (
            <>
              <div className="eb-form-row">
                <div style={{ flex: 1 }}><label>Category IDs (comma-sep)</label><Input value={ruleCategoryIds} onChange={(e) => setRuleCategoryIds(e.target.value)} placeholder="177104, 177101" /></div>
                <div style={{ flex: 1 }}><label>Brands (comma-sep)</label><Input value={ruleBrands} onChange={(e) => setRuleBrands(e.target.value)} placeholder="XAVIA" /></div>
                <div><label>Min price €</label><Input type="number" value={ruleMinPrice} onChange={(e) => setRuleMinPrice(e.target.value)} /></div>
                <div><label>Max price €</label><Input type="number" value={ruleMaxPrice} onChange={(e) => setRuleMaxPrice(e.target.value)} /></div>
              </div>
              <div className="eb-form-row">
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none' }}>
                  <input type="checkbox" checked={autoSelect} onChange={(e) => setAutoSelect(e.target.checked)} />
                  Auto-select future listings (eBay adds AND removes matching listings daily — the always-on catch-all)
                </label>
                <Button variant="ghost" onClick={runPreview} disabled={busy}>Preview matches</Button>
              </div>
              {preview && (
                <div>
                  <p className="eb-be-hint"><b>{preview.matched.length}</b> of {preview.totalLive} live listings match today · {preview.note}</p>
                  <div className="eb-itemids">
                    {preview.matched.slice(0, 30).map((m) => <span key={m.itemId} className="eb-chip eb-chip--item" title={m.title ?? ''}>{m.itemId.slice(-6)} {m.price != null ? eurC(Math.round(Number(m.price) * 100)) : ''}</span>)}
                    {preview.matched.length > 30 && <span className="eb-chip eb-chip--dim">+{preview.matched.length - 30} more</span>}
                  </div>
                </div>
              )}
            </>
          )}

          {error && <ul className="eb-results"><li className="err">{error}</li></ul>}
          <div className="eb-actions">
            <Button onClick={launch} disabled={busy || !name.trim()}>{busy ? 'Launching…' : 'Launch campaign'}</Button>
          </div>
        </div>
      </section>
    </div>
  )
}
