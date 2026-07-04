'use client'

/**
 * ER2 — step ② Targeting (General): key-based vs rules-based choice cards +
 * the CriterionBuilder (finally exposing rules-based creation — critique
 * B-4): selection rules (brand/category/price), auto-select-future toggle,
 * live matching preview via the shared criterion-preview endpoint.
 */
import { useEffect, useState } from 'react'
import { ListChecks, Wand2 } from 'lucide-react'
import { money } from '../../../../../campaigns/_grid/format'
import { postEbayAds } from '../../../../_lib'
import type { CampaignPlan, SelectionRule } from '../plan'

interface Preview { count: number; totalLive: number; sample: Array<{ itemId: string; title: string | null; priceCents: number | null }>; note: string | null }

const emptyRule = (): SelectionRule => ({ brands: [], categoryIds: [], minPrice: '', maxPrice: '' })

export function TargetingStepGen({ plan, set }: { plan: CampaignPlan; set: (patch: Partial<CampaignPlan>) => void }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const rules = plan.criterion.rules

  useEffect(() => {
    if (plan.targetingMode !== 'rules') return
    let alive = true
    const t = setTimeout(() => {
      postEbayAds<Preview>('/criterion-preview', {
        marketplace: plan.marketplace,
        rules: rules.map((r) => ({
          brands: r.brands.length ? r.brands : undefined,
          categoryIds: r.categoryIds.length ? r.categoryIds : undefined,
          minPrice: r.minPrice !== '' ? Number(r.minPrice) : undefined,
          maxPrice: r.maxPrice !== '' ? Number(r.maxPrice) : undefined,
        })),
      }).then((p) => { if (alive) setPreview(p) }).catch(() => { if (alive) setPreview(null) })
    }, 350)
    return () => { alive = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.targetingMode, plan.marketplace, JSON.stringify(rules)])

  const setRule = (i: number, patch: Partial<SelectionRule>) =>
    set({ criterion: { ...plan.criterion, rules: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) } })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 900 }}>
      <div className="h10-cb-cards eb-cb-two">
        <button type="button" className={`h10-cb-card ${plan.targetingMode === 'key' ? 'eb-cb-on' : ''}`} onClick={() => set({ targetingMode: 'key' })}>
          <span className="h10-cb-ic"><ListChecks size={40} strokeWidth={1.6} /></span>
          <span className="h10-cb-ttl">Key-based — pick the listings</span>
          <span className="h10-cb-desc">You choose exactly which listings to promote (next step). Rates live per ad and stay fully editable.</span>
        </button>
        <button type="button" className={`h10-cb-card ${plan.targetingMode === 'rules' ? 'eb-cb-on' : ''}`} onClick={() => set({ targetingMode: 'rules' })}>
          <span className="h10-cb-ic"><Wand2 size={40} strokeWidth={1.6} /></span>
          <span className="h10-cb-ttl">Rules-based — describe the inventory</span>
          <span className="h10-cb-desc">eBay re-evaluates your rules daily; with auto-select ON, new matching listings enroll by themselves — the true catch-all. Selection rules are immutable after launch (clone to change).</span>
        </button>
      </div>

      {plan.targetingMode === 'rules' && (
        <div className="h10-cd-card pad">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#283441' }}>
              <button type="button" role="switch" aria-checked={plan.criterion.autoSelectFutureInventory} className={`h10-bktoggle ${plan.criterion.autoSelectFutureInventory ? 'on' : ''}`}
                onClick={() => set({ criterion: { ...plan.criterion, autoSelectFutureInventory: !plan.criterion.autoSelectFutureInventory } })}>
                <span />
              </button>
              Auto-select future listings (new matches enroll daily)
            </label>
            <span className="grow" style={{ flex: 1 }} />
            {preview && <span className="h10-pill arch">{preview.count} of {preview.totalLive} live listings match now</span>}
          </div>

          {rules.length === 0 && <p className="eb-be-hint">No rules yet — with none, nothing matches. Add at least one selection rule.</p>}
          {rules.map((r, i) => (
            <div key={i} className="eb-form-row" style={{ alignItems: 'flex-end', marginBottom: 10 }}>
              <div className="h10-cd-field s"><label>Brands (comma-sep, blank = any)</label>
                <input value={r.brands.join(', ')} onChange={(e) => setRule(i, { brands: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="Xavia" /></div>
              <div className="h10-cd-field s"><label>Category IDs (blank = any)</label>
                <input value={r.categoryIds.join(', ')} onChange={(e) => setRule(i, { categoryIds: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="177104" /></div>
              <div className="h10-cd-field s" style={{ maxWidth: 120 }}><label>Min €</label>
                <input type="number" min={0} value={r.minPrice} onChange={(e) => setRule(i, { minPrice: e.target.value })} /></div>
              <div className="h10-cd-field s" style={{ maxWidth: 120 }}><label>Max €</label>
                <input type="number" min={0} value={r.maxPrice} onChange={(e) => setRule(i, { maxPrice: e.target.value })} /></div>
              <button type="button" className="h10-am-btn sm" onClick={() => set({ criterion: { ...plan.criterion, rules: rules.filter((_, j) => j !== i) } })}>Remove</button>
            </div>
          ))}
          <button type="button" className="h10-am-btn" onClick={() => set({ criterion: { ...plan.criterion, rules: [...rules, emptyRule()] } })}>+ Selection rule</button>
          <p className="eb-be-hint" style={{ marginTop: 10 }}>A listing matches if it satisfies ANY rule (each rule combines its own conditions). Item condition rules aren&apos;t previewable here but can be added post-launch in Seller Hub. The &quot;up to 10 rules&quot; limit is enforced by eBay at launch.</p>
          {preview?.sample.length ? (
            <ul className="eb-results" style={{ marginTop: 8 }}>
              {preview.sample.map((s) => <li key={s.itemId} className="ok">{s.title ?? s.itemId}{s.priceCents != null ? ` · ${money(s.priceCents)}` : ''}</li>)}
            </ul>
          ) : null}

          <div className="eb-form-row" style={{ marginTop: 14, alignItems: 'flex-end' }}>
            <div className="h10-cd-field s"><label>Rate strategy</label>
              <select className="h10-cd-input" value={plan.adRateStrategy} onChange={(e) => set({ adRateStrategy: e.target.value as 'FIXED' | 'DYNAMIC' })}>
                <option value="FIXED">Fixed — campaign-level %</option>
                <option value="DYNAMIC">Dynamic — eBay&apos;s daily suggestion under a cap</option>
              </select></div>
            <div className="h10-cd-field s" style={{ maxWidth: 140 }}><label>{plan.adRateStrategy === 'DYNAMIC' ? 'Base rate %' : 'Campaign rate %'}</label>
              <input type="number" min={2} max={100} step={0.1} value={plan.campaignRatePct} onChange={(e) => set({ campaignRatePct: e.target.value })} /></div>
            {plan.adRateStrategy === 'DYNAMIC' && (
              <div className="h10-cd-field s" style={{ maxWidth: 140 }}><label>Cap % (Floor Watch alerts above it)</label>
                <input type="number" min={2} max={100} step={0.1} value={plan.dynamicCapPct} onChange={(e) => set({ dynamicCapPct: e.target.value })} /></div>
            )}
          </div>
          <p className="eb-be-hint" style={{ marginTop: 8 }}>Rules-based campaigns carry a campaign-level rate (the one CPS shape where that is real and stays editable). Per-listing break-even clamps don&apos;t apply here — set the rate with your margins in mind.</p>
        </div>
      )}

      {plan.targetingMode === 'key' && <p className="eb-be-hint">Pick the exact listings in the next step — each gets a break-even-derived rate you can override per listing.</p>}
    </div>
  )
}
