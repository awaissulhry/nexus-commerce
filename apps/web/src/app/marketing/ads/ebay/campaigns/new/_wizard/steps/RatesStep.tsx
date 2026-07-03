'use client'

/**
 * ER2 — step ④ Rates (General key-based): the v1 per-listing rate table
 * re-chromed (computed BE×factor rates + provenance + red-over-BE overrides
 * + live fee forecast) + the Rate Discovery panel (our beat-Rithum item:
 * bounded ladder, cap clamped per listing to break-even at apply time).
 * eBay suggested/trending rates: AU/DE/GB/US only — IT/FR/ES say so
 * honestly (teardown §6 #12).
 */
import { money, pct } from '../../../../../campaigns/_grid/format'
import { effRate, includedListings, type CampaignPlan, type PlanListing } from '../plan'

const SUGGEST_MARKETS = new Set(['EBAY_AU', 'EBAY_DE', 'EBAY_GB', 'EBAY_US'])

export function RatesStep({ plan, set, listings }: {
  plan: CampaignPlan
  set: (patch: Partial<CampaignPlan>) => void
  listings: PlanListing[]
}) {
  const included = includedListings(plan, listings)
  const forecast = included.reduce((a, l) => { const r = effRate(plan, l); return a + (r != null ? Math.round(l.trailingSales30dCents * (r / 100)) : 0) }, 0)
  const suggestAvailable = SUGGEST_MARKETS.has(plan.marketplace)
  const d = plan.rateDiscovery

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="h10-cd-card pad">
        <div className="eb-form-row" style={{ alignItems: 'flex-end' }}>
          <div className="h10-cd-field s" style={{ maxWidth: 190 }}>
            <label>Rate override — blank = per-listing computed</label>
            <input type="number" min={2} max={100} step={0.1} value={plan.globalRate} onChange={(e) => set({ globalRate: e.target.value })} placeholder="per-listing" />
          </div>
          <span className="eb-be-hint" style={{ flex: 1 }}>
            Computed rates = <b>break-even × {plan.template ? 'template factor' : '0.7'}</b> where costs exist, else the default. {suggestAvailable
              ? 'eBay suggested rates load per listing below.'
              : <>eBay exposes <b>no suggested/trending rate API for {plan.marketplace.replace('EBAY_', 'eBay ')}</b> — break-even is the anchor instead.</>}
          </span>
          <span className="h10-pill arch">projected ≈ {money(forecast)}/month at trailing sales</span>
        </div>
      </div>

      <div className="h10-am-card">
        <div className="h10-am-toolbar"><span className="cnt">Promoting <b>{included.length}</b> listing(s)</span></div>
        <div className="h10-am-grid" style={{ maxHeight: 380 }}>
          <table>
            <thead><tr><th className="ed">Listing</th><th className="num">Break-even</th><th className="num">Rate %</th><th className="num">30d sales</th><th className="num">Fee forecast/mo</th></tr></thead>
            <tbody>
              {included.map((l) => {
                const r = effRate(plan, l)
                const over = l.breakEvenPct != null && r != null && r > l.breakEvenPct
                return (
                  <tr key={l.itemId}>
                    <td className="ed"><div className="nmw"><span className="t" title={l.title ?? l.itemId}>{l.title ?? l.itemId}</span><span className="mk">{l.itemId.slice(-6)}</span></div></td>
                    <td className="num">{l.breakEvenPct != null ? pct(l.breakEvenPct / 100) : <span className="h10-pill warn">add cost</span>}</td>
                    <td className="num">
                      <input className="h10-cd-input" style={{ width: 74, borderColor: over ? '#e5484d' : undefined }} type="number" min={2} max={100} step={0.1}
                        value={plan.perRate[l.itemId] ?? (plan.globalRate !== '' ? plan.globalRate : l.computedRatePct ?? '')}
                        title={l.rateSource}
                        onChange={(e) => set({ perRate: { ...plan.perRate, [l.itemId]: e.target.value } })} />
                    </td>
                    <td className="num">{money(l.trailingSales30dCents)}</td>
                    <td className="num">{r != null ? money(Math.round(l.trailingSales30dCents * (r / 100))) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Rate Discovery */}
      <div className="h10-cd-card pad">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" role="switch" aria-checked={d.on} className={`h10-bktoggle ${d.on ? 'on' : ''}`} onClick={() => set({ rateDiscovery: { ...d, on: !d.on } })}><span /></button>
          <b style={{ fontSize: 13.5 }}>Rate Discovery</b>
          <span className="eb-be-hint" style={{ flex: 1 }}>Walks the rate from floor to cap one dwell window at a time, measures each step, and <b>proposes</b> every move for your approval — the cap is additionally clamped per listing to break-even at apply time. Our answer to &quot;what rate is actually best&quot;.</span>
        </div>
        {d.on && (
          <div className="eb-form-row" style={{ marginTop: 12 }}>
            <div className="h10-cd-field s" style={{ maxWidth: 110 }}><label>Floor %</label><input type="number" min={2} max={100} step={0.5} value={d.floorPct} onChange={(e) => set({ rateDiscovery: { ...d, floorPct: e.target.value } })} /></div>
            <div className="h10-cd-field s" style={{ maxWidth: 110 }}><label>Cap %</label><input type="number" min={2} max={100} step={0.5} value={d.capPct} onChange={(e) => set({ rateDiscovery: { ...d, capPct: e.target.value } })} /></div>
            <div className="h10-cd-field s" style={{ maxWidth: 110 }}><label>Step %</label><input type="number" min={0.5} max={20} step={0.5} value={d.stepPct} onChange={(e) => set({ rateDiscovery: { ...d, stepPct: e.target.value } })} /></div>
            <div className="h10-cd-field s" style={{ maxWidth: 130 }}><label>Dwell (days)</label><input type="number" min={1} max={30} step={1} value={d.dwellDays} onChange={(e) => set({ rateDiscovery: { ...d, dwellDays: e.target.value } })} /></div>
            <span className="eb-be-hint">≈ {Math.max(0, Math.ceil((Number(d.capPct) - Number(d.floorPct)) / Math.max(0.5, Number(d.stepPct)))) + 1} steps × {d.dwellDays || '?'} days — progress lands on the campaign&apos;s Automation tab.</span>
          </div>
        )}
      </div>
    </div>
  )
}
