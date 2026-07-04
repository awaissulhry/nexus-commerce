'use client'

/**
 * EV3 — step ④ Rates (General key-based) on the section pattern, plus the
 * rate STRATEGY choice the API always supported but the wizard never exposed:
 * FIXED per-listing rates (the v1 table: computed BE×factor + provenance +
 * red-over-BE overrides + live fee forecast + Rate Discovery) ↔ DYNAMIC
 * (eBay adjusts the rate daily under a hard cap; ads attach without fixed
 * rates; the break-even guardrail runs against the cap at launch).
 * eBay suggested/trending rates: AU/DE/GB/US only — IT/FR/ES say so
 * honestly (teardown §6 #12).
 */
import { Gauge, SlidersHorizontal } from 'lucide-react'
import { money, pct } from '../../../../../campaigns/_grid/format'
import { InfoTip } from '../../../../../campaigns/InfoTip'
import { effRate, includedListings, SUGGEST_MARKETS, type CampaignPlan, type PlanListing } from '../plan'

export function RatesStep({ plan, set, listings }: {
  plan: CampaignPlan
  set: (patch: Partial<CampaignPlan>) => void
  listings: PlanListing[]
}) {
  const included = includedListings(plan, listings)
  const forecast = included.reduce((a, l) => { const r = effRate(plan, l); return a + (r != null ? Math.round(l.trailingSales30dCents * (r / 100)) : 0) }, 0)
  const suggestAvailable = SUGGEST_MARKETS.has(plan.marketplace)
  const d = plan.rateDiscovery
  const dynamic = plan.adRateStrategy === 'DYNAMIC'
  const cap = Number(plan.dynamicCapPct)
  const overCap = Number.isFinite(cap) ? included.filter((l) => l.breakEvenPct != null && cap > l.breakEvenPct) : []

  return (
    <div style={{ maxWidth: 980 }}>
      <section className="h10-spw-sec">
        <h2>Rate strategy</h2>
        <p>How the ad rate (the % fee paid on attributed sales) is managed after launch.</p>
        <div className="h10-cb-cards eb-cb-two">
          <button type="button" className={`h10-cb-card ${!dynamic ? 'eb-cb-on' : ''}`} onClick={() => set({ adRateStrategy: 'FIXED' })}>
            <span className="h10-cb-ic"><SlidersHorizontal size={40} strokeWidth={1.6} /></span>
            <span className="h10-cb-ttl">Fixed — you set every rate</span>
            <span className="h10-cb-desc">Per-listing rates anchored to break-even, editable any time. Rate Discovery can walk them for you, one measured step at a time.</span>
          </button>
          <button type="button" className={`h10-cb-card ${dynamic ? 'eb-cb-on' : ''}`} onClick={() => set({ adRateStrategy: 'DYNAMIC', rateDiscovery: { ...d, on: false } })}>
            <span className="h10-cb-ic"><Gauge size={40} strokeWidth={1.6} /></span>
            <span className="h10-cb-ttl">Dynamic — eBay manages it, under your cap</span>
            <span className="h10-cb-desc">eBay applies its daily suggested rate per listing but never exceeds your hard cap. No per-listing rates to maintain; the cap is the margin guardrail.</span>
          </button>
        </div>
      </section>

      {dynamic ? (
        <section className="h10-spw-sec">
          <h2>Dynamic cap</h2>
          <p>The ceiling eBay may never exceed — checked against every listing&apos;s break-even at launch.</p>
          <div className="h10-cd-card pad">
            <div className="eb-form-row" style={{ alignItems: 'flex-end' }}>
              <div className="h10-cd-field s" style={{ maxWidth: 150 }}>
                <label>Cap % <InfoTip tip="eBay's daily suggested rate applies per listing but is hard-capped here. Listings whose break-even sits BELOW the cap can lose margin on days eBay pushes the rate to the ceiling — launch asks for a named override on those." /></label>
                <input className="h10-cd-input" type="number" min={2} max={100} step={0.5} value={plan.dynamicCapPct} onChange={(e) => set({ dynamicCapPct: e.target.value })} />
              </div>
              <span className="eb-be-hint" style={{ flex: 1 }}>
                Ads attach <b>without fixed rates</b> — eBay adjusts daily under the cap. Rate edits and Rate Discovery don&apos;t apply while dynamic; switching back to Fixed is a one-click campaign edit later.
              </span>
              {overCap.length > 0
                ? <span className="h10-pill warn">{overCap.length} listing(s) break even below {Number.isFinite(cap) ? `${cap}%` : 'the cap'}</span>
                : <span className="h10-pill ok">cap under break-even for every costed listing</span>}
            </div>
          </div>
        </section>
      ) : (
        <>
          <section className="h10-spw-sec">
            <h2>Per-listing rates</h2>
            <p>Computed from break-even where costs exist; override globally or per listing — red means the rate exceeds break-even.</p>
            <div className="h10-cd-card pad" style={{ marginBottom: 14 }}>
              <div className="eb-form-row" style={{ alignItems: 'flex-end' }}>
                <div className="h10-cd-field s" style={{ maxWidth: 190 }}>
                  <label>Rate override <InfoTip tip="Blank = each listing keeps its computed rate (break-even × factor). A value here applies to every staged listing; the per-row inputs below still win." /></label>
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
          </section>

          <section className="h10-spw-sec">
            <h2>Rate Discovery</h2>
            <p>Optional: find the best fixed rate empirically instead of guessing it.</p>
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
          </section>
        </>
      )}
    </div>
  )
}
