'use client'

/**
 * ER2 — step ⑤ Review & Launch (the Teikametrics-verdict transparency gate):
 * full derived-plan recap with jump-to-step links, structural-gap flags,
 * acknowledge-advisories (missing cost, sprawl), OverrideReasonModal for
 * over-break-even rates (X4: no window.prompt), readiness score, rule packs,
 * launch → per-item results + "what happens next" timeline.
 */
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2 } from 'lucide-react'
import { money, pct } from '../../../../../campaigns/_grid/format'
import { postEbayAds } from '../../../../_lib'
import { OverrideReasonModal } from '../../../../_modals/OverrideReasonModal'
import { effRate, includedListings, type CampaignPlan, type PlanListing } from '../plan'
import { clearDraft } from '../draft'

interface LaunchOut {
  ok: boolean; mode: string; campaignId: string
  moveResults: Array<{ listingId: string; ok: boolean; error?: string | null }>
  promoteResults: Array<{ key: string; ok: boolean; blocked?: string | null; error?: string | null; warning?: string | null }>
  keywordResults: Array<{ key: string; ok: boolean; error?: string | null }>
  groupResults: Array<{ name: string; adGroupId?: string; keywords: number; negatives: number; error?: string }>
  rateDiscoveryArmed: boolean
  rulePacksBound: string[]
  timeline: string[]
}

export function ReviewStep({ plan, set, listings, activeCampaigns, packOptions, goTo }: {
  plan: CampaignPlan
  set: (patch: Partial<CampaignPlan>) => void
  listings: PlanListing[]
  activeCampaigns: number
  packOptions: string[]
  goTo: (step: string) => void
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [launched, setLaunched] = useState<LaunchOut | null>(null)
  const [overrideOpen, setOverrideOpen] = useState(false)

  const isGen = plan.type === 'general'
  const isRules = isGen && plan.targetingMode === 'rules'
  const included = includedListings(plan, listings)
  const selectedSeeds = plan.adGroups.flatMap((g) => g.seeds.filter((s) => s.on))

  // ── gaps (blocking) + advisories (acknowledge) ─────────────────────────
  const gaps: Array<{ text: string; step: string }> = []
  if (!plan.name.trim()) gaps.push({ text: 'Campaign name is required', step: 'setup' })
  if (isGen && !isRules && included.length === 0) gaps.push({ text: 'No listings staged — a key-based General campaign cannot launch empty', step: 'listings' })
  if (isRules && plan.criterion.rules.length === 0) gaps.push({ text: 'Rules-based targeting needs at least one selection rule', step: 'targeting' })
  if (isRules && !(Number(plan.campaignRatePct) >= 2 && Number(plan.campaignRatePct) <= 100)) gaps.push({ text: 'Campaign rate must be 2–100%', step: 'targeting' })
  if (isGen && !isRules) {
    const bad = included.filter((l) => { const r = effRate(plan, l); return r == null || r < 2 || r > 100 })
    if (bad.length) gaps.push({ text: `${bad.length} listing(s) have no valid rate (2–100%)`, step: 'rates' })
    const unresolved = included.filter((l) => l.conflict && (plan.resolutions[l.itemId] ?? 'include') === 'include')
    if (unresolved.length) gaps.push({ text: `${unresolved.length} conflicted listing(s) set to "include" — eBay rejects them (one listing = one General campaign)`, step: 'listings' })
    if (plan.rateDiscovery.on) {
      const d = plan.rateDiscovery
      if (!(Number(d.floorPct) >= 2 && Number(d.capPct) <= 100 && Number(d.floorPct) < Number(d.capPct) && Number(d.stepPct) > 0 && Number(d.dwellDays) >= 1)) {
        gaps.push({ text: 'Rate Discovery bounds invalid (2 ≤ floor < cap ≤ 100, step > 0, dwell ≥ 1 day)', step: 'rates' })
      }
    }
  }
  if (!isGen) {
    if (!(Number(plan.budgetEur) >= 1)) gaps.push({ text: 'Daily budget must be ≥ €1.00', step: 'budget' })
    if (plan.type === 'priority-smart' && !(Number(plan.maxCpcEur) >= 0.02)) gaps.push({ text: 'Smart targeting needs a max CPC ≥ €0.02', step: 'budget' })
    if (plan.type === 'priority-manual') {
      if (selectedSeeds.length === 0) gaps.push({ text: 'No keywords selected — a manual Priority campaign without keywords targets nothing', step: 'keywords' })
      const emptyGroups = plan.adGroups.filter((g) => g.seeds.filter((s) => s.on).length === 0)
      if (emptyGroups.length && plan.adGroups.length > 1) gaps.push({ text: `${emptyGroups.length} ad group(s) have zero keywords — remove them or add keywords`, step: 'keywords' })
      const badBids = selectedSeeds.filter((s) => !(Number(s.bidEur) >= 0.05))
      if (badBids.length) gaps.push({ text: `${badBids.length} keyword(s) need a bid ≥ €0.05`, step: 'keywords' })
    }
  }

  const overBe = isGen && !isRules ? included.filter((l) => { const r = effRate(plan, l); return l.breakEvenPct != null && r != null && r > l.breakEvenPct }) : []
  const missingCost = isGen && !isRules ? included.filter((l) => l.breakEvenPct == null).length : 0
  const advisories: Array<{ key: string; text: string }> = []
  if (missingCost > 0) advisories.push({ key: 'missing-cost', text: `${missingCost} listing(s) have no cost data — rates fall back to defaults, margin unverified` })
  if (activeCampaigns >= 25) advisories.push({ key: 'sprawl', text: `${activeCampaigns} campaigns already running on this market — consider consolidating before adding more` })
  if (overBe.length) advisories.push({ key: 'over-be', text: `${overBe.length} listing(s) priced ABOVE break-even — every attributed sale loses margin (a named override reason is collected at launch)` })
  const unacked = advisories.filter((a) => a.key !== 'over-be' && !plan.acks.includes(a.key))

  const readiness = useMemo(() => {
    let score = 100
    const fixes: string[] = []
    if (gaps.length) { score -= 40; fixes.push('resolve the blocking gaps') }
    if (isGen && !isRules && included.length) {
      const cov = 1 - missingCost / included.length
      if (cov < 1) { const d = Math.round((1 - cov) * 30); score -= d; fixes.push(`+${d}: add product costs (${missingCost} missing)`) }
    }
    if (plan.rulePacks.length === 0) { score -= 15; fixes.push('+15: bind at least one rule pack') }
    if (overBe.length) { score -= 15; fixes.push('+15: bring rates back under break-even') }
    return { score: Math.max(0, score), fixes }
  }, [gaps.length, included.length, missingCost, plan.rulePacks.length, overBe.length, isGen, isRules])

  const launch = async (overrideReason?: string) => {
    if (overBe.length && !overrideReason) { setOverrideOpen(true); return }
    setBusy(true); setError(null)
    try {
      const goal = plan.template ?? (isGen ? 'catch_all' : 'hero')
      const out = await postEbayAds<LaunchOut>('/builder/launch', {
        goal,
        name: plan.name.trim(),
        marketplace: plan.marketplace,
        endDate: plan.endDate || null,
        ...(isGen
          ? isRules
            ? { adRateStrategy: plan.adRateStrategy, ratePct: Number(plan.campaignRatePct), ...(plan.adRateStrategy === 'DYNAMIC' ? { dynamicCapPct: Number(plan.dynamicCapPct) } : {}), criterion: { autoSelectFutureInventory: plan.criterion.autoSelectFutureInventory, selectionRules: plan.criterion.rules.map((r) => ({ ...(r.brands.length ? { brands: r.brands } : {}), ...(r.categoryIds.length ? { categoryIds: r.categoryIds, categoryScope: 'ITEM' } : {}), ...(r.minPrice !== '' ? { minPrice: Number(r.minPrice) } : {}), ...(r.maxPrice !== '' ? { maxPrice: Number(r.maxPrice) } : {}) })) }, items: [] }
            : { items: listings.filter((l) => plan.selected.includes(l.itemId)).map((l) => ({ listingId: l.itemId, resolution: plan.resolutions[l.itemId] ?? 'include', ...(effRate(plan, l) != null ? { ratePct: effRate(plan, l)! } : {}) })), ...(plan.globalRate !== '' ? { ratePct: Number(plan.globalRate) } : {}), ...(plan.rateDiscovery.on ? { rateDiscovery: { floorPct: Number(plan.rateDiscovery.floorPct), capPct: Number(plan.rateDiscovery.capPct), stepPct: Number(plan.rateDiscovery.stepPct), dwellDays: Number(plan.rateDiscovery.dwellDays) } } : {}) }
          : { targetingType: plan.type === 'priority-smart' ? 'SMART' : 'MANUAL', dailyBudgetCents: Math.round(Number(plan.budgetEur) * 100), ...(plan.type === 'priority-smart' ? { maxCpcCents: Math.round(Number(plan.maxCpcEur) * 100) } : {}), items: [], ...(plan.type === 'priority-manual' ? { adGroups: plan.adGroups.filter((g) => g.seeds.some((s) => s.on)).map((g) => ({ name: g.name, defaultBidCents: Math.round(Number(g.defaultBidEur) * 100), keywords: g.seeds.filter((s) => s.on).map((s) => ({ text: s.text, matchType: s.matchType, bidCents: Math.round(Number(s.bidEur) * 100) })), negatives: g.negativesText.split('\n').map((l) => l.trim()).filter(Boolean).map((t) => ({ text: t, matchType: g.negMatch })) })) } : {}) }),
        rulePacks: plan.rulePacks,
        ...(overrideReason ? { override: { reason: overrideReason } } : {}),
      })
      setLaunched(out)
      clearDraft(plan.type, plan.marketplace)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  if (launched) {
    return (
      <div className="h10-cd-card pad" style={{ maxWidth: 760 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <CheckCircle2 size={18} color="#12855f" aria-hidden />
          <b style={{ fontSize: 15 }}>Campaign launched ({launched.mode})</b>
        </div>
        {launched.groupResults?.length > 0 && (
          <ul className="eb-results">{launched.groupResults.map((g, i) => <li key={i} className={g.error ? 'err' : 'ok'}>{g.error ? `${g.name} — ${g.error}` : `${g.name}: ${g.keywords} keyword(s), ${g.negatives} negative(s)`}</li>)}</ul>
        )}
        {launched.promoteResults?.some((r) => !r.ok) && (
          <ul className="eb-results">{launched.promoteResults.filter((r) => !r.ok).map((r, i) => <li key={i} className="err"><code>{r.key}</code> — {r.blocked ?? r.error}</li>)}</ul>
        )}
        <p style={{ fontSize: 12, color: '#667085', margin: '8px 0 4px', fontWeight: 700, textTransform: 'uppercase' }}>What happens next</p>
        <ul className="eb-results">{launched.timeline.map((t, i) => <li key={i} className="ok">{t}</li>)}</ul>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="button" className="h10-am-btn primary" onClick={() => router.push(`/marketing/ads/ebay/campaigns/${launched.campaignId}`)}>Open campaign</button>
          <button type="button" className="h10-am-btn" onClick={() => router.push('/marketing/ads/ebay/campaigns/new')}>Launch another</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* recap */}
      <div className="h10-cd-card pad">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="h10-pill ok">{plan.name || 'unnamed'}</span>
          <span className="h10-pill arch">{plan.type === 'general' ? (isRules ? 'General · rules-based' : 'General · key-based') : plan.type === 'priority-manual' ? 'Priority · manual' : 'Priority · smart'}</span>
          <span className="h10-pill arch">{plan.marketplace}</span>
          {plan.endDate && <span className="h10-pill warn">ends {plan.endDate}</span>}
          {plan.rateDiscovery.on && isGen && !isRules && <span className="h10-pill ok">Rate Discovery {plan.rateDiscovery.floorPct}%→{plan.rateDiscovery.capPct}%</span>}
          <span className="grow" style={{ flex: 1 }} />
          <span title={readiness.fixes.join('\n') || 'Ready'} style={{ fontSize: 12.5, fontWeight: 700, color: readiness.score >= 80 ? '#12855f' : readiness.score >= 50 ? '#b87503' : '#e5484d' }}>
            Launch readiness {readiness.score}/100
          </span>
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap', fontSize: 12.5, color: '#5b6573' }}>
          <button type="button" className="h10-am-link" onClick={() => goTo('setup')}>edit setup</button>
          {isRules && <button type="button" className="h10-am-link" onClick={() => goTo('targeting')}>edit rules ({plan.criterion.rules.length}, auto-select {plan.criterion.autoSelectFutureInventory ? 'ON' : 'off'})</button>}
          {isGen && !isRules && <button type="button" className="h10-am-link" onClick={() => goTo('listings')}>edit listings ({included.length} staged)</button>}
          {isGen && !isRules && <button type="button" className="h10-am-link" onClick={() => goTo('rates')}>edit rates</button>}
          {plan.type === 'priority-manual' && <button type="button" className="h10-am-link" onClick={() => goTo('keywords')}>edit keywords ({selectedSeeds.length} across {plan.adGroups.length} group(s))</button>}
          {!isGen && <button type="button" className="h10-am-link" onClick={() => goTo('budget')}>edit budget ({money(Math.round(Number(plan.budgetEur || '0') * 100))}/day{plan.type === 'priority-smart' ? ` · max CPC ${money(Math.round(Number(plan.maxCpcEur || '0') * 100))}` : ''})</button>}
        </div>
      </div>

      {/* rates summary (GEN key-based, editable in place) */}
      {isGen && !isRules && included.length > 0 && (
        <div className="h10-am-card">
          <div className="h10-am-toolbar"><span className="cnt"><b>{included.length}</b> listing(s) · projected ≈ <b>{money(included.reduce((a, l) => { const r = effRate(plan, l); return a + (r != null ? Math.round(l.trailingSales30dCents * (r / 100)) : 0) }, 0))}</b>/month</span></div>
          <div className="h10-am-grid" style={{ maxHeight: 260 }}>
            <table>
              <thead><tr><th className="ed">Listing</th><th className="num">Break-even</th><th className="num">Rate %</th></tr></thead>
              <tbody>
                {included.map((l) => {
                  const r = effRate(plan, l)
                  const over = l.breakEvenPct != null && r != null && r > l.breakEvenPct
                  return (
                    <tr key={l.itemId}>
                      <td className="ed"><span className="t">{l.title ?? l.itemId}</span></td>
                      <td className="num">{l.breakEvenPct != null ? pct(l.breakEvenPct / 100) : <span className="h10-pill warn">add cost</span>}</td>
                      <td className="num"><input className="h10-cd-input" style={{ width: 74, borderColor: over ? '#e5484d' : undefined }} type="number" min={2} max={100} step={0.1} value={plan.perRate[l.itemId] ?? (plan.globalRate !== '' ? plan.globalRate : l.computedRatePct ?? '')} onChange={(e) => set({ perRate: { ...plan.perRate, [l.itemId]: e.target.value } })} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* rule packs */}
      <div className="h10-cd-card pad">
        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: '#667085', marginBottom: 8 }}>Rule packs bound at launch (PROPOSE mode — born governed)</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {packOptions.map((p) => (
            <label key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#283441', border: '1px solid #d8dde4', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', background: plan.rulePacks.includes(p) ? '#eef5ff' : '#fff' }}>
              <input type="checkbox" checked={plan.rulePacks.includes(p)} onChange={(e) => set({ rulePacks: e.target.checked ? [...plan.rulePacks, p] : plan.rulePacks.filter((x) => x !== p) })} />
              {p}
            </label>
          ))}
        </div>
      </div>

      {/* gaps + advisories */}
      <div className="h10-cd-card pad">
        {gaps.length > 0 && (
          <ul className="eb-results" style={{ marginBottom: advisories.length ? 8 : 0 }}>
            {gaps.map((g) => <li key={g.text} className="err">{g.text} — <button type="button" className="h10-am-link" onClick={() => goTo(g.step)}>fix</button></li>)}
          </ul>
        )}
        {advisories.length > 0 && (
          <ul className="eb-results">
            {advisories.map((a) => (
              <li key={a.key} className="warn">
                {a.text}{a.key !== 'over-be' && (
                  <label style={{ marginLeft: 8, fontSize: 11.5 }}>
                    <input type="checkbox" checked={plan.acks.includes(a.key)} onChange={(e) => set({ acks: e.target.checked ? [...plan.acks, a.key] : plan.acks.filter((x) => x !== a.key) })} /> acknowledge
                  </label>
                )}
              </li>
            ))}
          </ul>
        )}
        {gaps.length === 0 && advisories.length === 0 && <p className="eb-be-hint">All checks green.</p>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
          <span style={{ fontSize: 12.5, color: '#5b6573' }}>
            Will create: <b>1 campaign</b>
            {isGen && !isRules ? <>, <b>{included.length} ads</b></> : null}
            {isRules ? <>, <b>rules-based selection ({plan.criterion.rules.length} rule(s))</b></> : null}
            {plan.type === 'priority-manual' ? <>, <b>{plan.adGroups.filter((g) => g.seeds.some((s) => s.on)).length} ad group(s) + {selectedSeeds.length} keywords</b></> : null}
            , <b>{plan.rulePacks.length} rule binding(s)</b>
            {plan.rateDiscovery.on && isGen && !isRules ? <>, <b>1 discovery plan</b></> : null}
          </span>
          <span className="grow" style={{ flex: 1 }} />
          <button type="button" className="h10-am-btn primary" disabled={busy || gaps.length > 0 || unacked.length > 0} onClick={() => void launch()}>
            {busy ? 'Launching…' : 'Launch campaign'}
          </button>
        </div>
        {error && <ul className="eb-results" style={{ marginTop: 8 }}><li className="err">{error}</li></ul>}
      </div>

      <OverrideReasonModal
        open={overrideOpen}
        onClose={() => setOverrideOpen(false)}
        title="Rates above break-even"
        blockedItems={overBe.map((l) => `${l.title ?? l.itemId} → ${effRate(plan, l)}% (break-even ${l.breakEvenPct}%)`)}
        onSubmit={async (reason) => { setOverrideOpen(false); await launch(reason) }}
      />
    </div>
  )
}
