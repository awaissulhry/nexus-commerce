'use client'

/**
 * ACR.6 (R7) — iROAS, carried over with its uncertainty attached.
 *
 * Not every attributed sale is incremental: someone searching your brand name would mostly have
 * bought anyway, so ROAS on branded terms flatters the ads that captured them. This models the
 * incremental share instead — and "models" is the whole caveat. The two factors below are operator
 * assumptions, not measurements. Only an AMC holdout measures lift, and AMC is refused at Amazon
 * for this account (`reference_amazon_stack_entitlements`).
 *
 * That is precisely why the modelled status is stated in the panel heading, in the KPI label, and
 * beside the two sliders that set it — not tucked into a footnote. The panel exists so a number
 * that looks measured cannot be mistaken for one. Ported from the legacy
 * `/marketing/advertising/incrementality` page (operator decision 2026-08-05: keep it, labelled).
 *
 * It sits under Reporting rather than Analytics only because the operator placed it here; the
 * standing Reporting/Analytics split would otherwise file interpretation next door.
 */
import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, Download, FlaskConical } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Row {
  campaignId: string; name: string; marketplace: string | null; branded: boolean
  spendCents: number; adSalesCents: number; roas: number | null
  incrementalityFactor: number; incrementalSalesCents: number; iroas: number | null
}
interface Result {
  windowDays: number; brandTerms: string[]; brandedFactor: number; nonBrandedFactor: number
  totals: { spendCents: number; adSalesCents: number; roas: number | null; incrementalSalesCents: number; iroas: number | null; brandedSpendCents: number; nonBrandedSpendCents: number }
  rows: Row[]; note: string
}

const DAYS = [7, 14, 30, 60, 90]
const eur = (c?: number | null) => (c == null ? '—' : `€${Math.round(c / 100).toLocaleString('en-IE')}`)
const x2 = (n?: number | null) => (n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(2)}×`)

export function IncrementalityPanel() {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<Result | null>(null)
  const [loading, setLoading] = useState(false)
  const [days, setDays] = useState(30)
  const [brandTerms, setBrandTerms] = useState('Xavia')
  const [brandedFactor, setBrandedFactor] = useState(0.3)
  const [nonBrandedFactor, setNonBrandedFactor] = useState(0.85)

  const load = useCallback(() => {
    setLoading(true)
    const qs = new URLSearchParams({
      windowDays: String(days),
      brandedFactor: String(brandedFactor),
      nonBrandedFactor: String(nonBrandedFactor),
      ...(brandTerms.trim() ? { brandTerms: brandTerms.trim() } : {}),
    })
    fetch(`${getBackendUrl()}/api/advertising/incrementality?${qs}`, { cache: 'no-store' })
      .then((r) => r.json()).then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [days, brandTerms, brandedFactor, nonBrandedFactor])
  // Debounced so dragging a slider does not fire a request per step.
  useEffect(() => { if (!open) return undefined; const t = setTimeout(load, 250); return () => clearTimeout(t) }, [open, load])

  const csv = () => {
    const head = 'campaign,branded,spend,ad_sales,roas,incrementality_factor,incremental_sales,iroas\n'
    const body = (data?.rows ?? []).map((r) => `"${r.name.replace(/"/g, '""')}",${r.branded},${(r.spendCents / 100).toFixed(2)},${(r.adSalesCents / 100).toFixed(2)},${r.roas?.toFixed(2) ?? ''},${r.incrementalityFactor},${(r.incrementalSalesCents / 100).toFixed(2)},${r.iroas?.toFixed(2) ?? ''}`).join('\n')
    const blob = new Blob([head + body], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `incrementality-${days}d.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const t = data?.totals

  return (
    <section className="rpt-group">
      <h2 className="rpt-group-hd">
        <button type="button" className="rpt-iro-t" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          Incremental return (iROAS)
          <ChevronDown size={15} className={open ? 'open' : ''} aria-hidden />
        </button>
        <span className="count rpt-iro-tag"><FlaskConical size={11} aria-hidden /> Modeled, not measured</span>
      </h2>

      {open && (
        <div className="rpt-iro">
          <p className="rpt-iro-lede">
            A branded-search buyer would mostly have bought anyway, so ROAS on branded terms credits the ad
            with a sale it did not cause. This estimates the <b>incremental</b> share instead. The two
            percentages below are <b>your assumptions</b>, not observations — only a holdout test measures
            lift, and AMC is not available on this account. Treat every number here as directional.
          </p>

          <div className="rpt-iro-ctl">
            <span className="rpt-iro-seg" role="radiogroup" aria-label="Window">
              {DAYS.map((d) => (
                <button key={d} type="button" role="radio" aria-checked={days === d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d}d</button>
              ))}
            </span>
            <label className="rpt-iro-f">
              <span>Brand terms</span>
              <input value={brandTerms} onChange={(e) => setBrandTerms(e.target.value)} placeholder="comma-separated" aria-label="Brand terms" />
            </label>
            <label className="rpt-iro-f">
              <span>Branded lift · assumed {Math.round(brandedFactor * 100)}%</span>
              <input type="range" min="0" max="1" step="0.05" value={brandedFactor} onChange={(e) => setBrandedFactor(Number(e.target.value))} aria-label="Assumed branded incrementality" />
            </label>
            <label className="rpt-iro-f">
              <span>Non-branded lift · assumed {Math.round(nonBrandedFactor * 100)}%</span>
              <input type="range" min="0" max="1" step="0.05" value={nonBrandedFactor} onChange={(e) => setNonBrandedFactor(Number(e.target.value))} aria-label="Assumed non-branded incrementality" />
            </label>
            <button type="button" className="rpt-iro-csv" onClick={csv} disabled={!data?.rows.length}><Download size={13} aria-hidden /> CSV</button>
          </div>

          {t && (
            <div className="rpt-iro-kpis">
              <div className="rpt-iro-k"><span className="lbl">Ad spend</span><span className="val">{eur(t.spendCents)}</span><span className="sub">{eur(t.brandedSpendCents)} on branded terms</span></div>
              <div className="rpt-iro-k"><span className="lbl">Reported ROAS</span><span className="val">{x2(t.roas)}</span><span className="sub">attributed sales ÷ spend</span></div>
              <div className="rpt-iro-k"><span className="lbl">Incremental sales <i>est.</i></span><span className="val em">{eur(t.incrementalSalesCents)}</span><span className="sub">of {eur(t.adSalesCents)} attributed</span></div>
              <div className="rpt-iro-k"><span className="lbl">iROAS <i>est.</i></span><span className="val em">{x2(t.iroas)}</span><span className="sub">incremental ÷ spend</span></div>
            </div>
          )}

          <div className="rpt-iro-scroll">
            <table className="rpt-iro-tbl">
              <thead>
                <tr>
                  <th>Campaign</th><th>Type</th><th className="r">Spend</th><th className="r">Ad sales</th>
                  <th className="r">ROAS</th><th className="r">Assumed lift</th><th className="r">Incr. sales</th><th className="r">iROAS</th>
                </tr>
              </thead>
              <tbody>
                {(data?.rows ?? []).length === 0 ? (
                  <tr><td colSpan={8} className="empty">{loading ? 'Loading…' : 'No spend in this window.'}</td></tr>
                ) : (data?.rows ?? []).map((r) => (
                  <tr key={r.campaignId}>
                    <td className="nm" title={r.name}>{r.name}</td>
                    <td><span className={`rpt-iro-b ${r.branded ? 'br' : 'nb'}`}>{r.branded ? 'Branded' : 'Non-brand'}</span></td>
                    <td className="r">{eur(r.spendCents)}</td>
                    <td className="r">{eur(r.adSalesCents)}</td>
                    <td className="r dim">{x2(r.roas)}</td>
                    <td className="r dim">×{r.incrementalityFactor}</td>
                    <td className="r em">{eur(r.incrementalSalesCents)}</td>
                    <td className="r em b">{x2(r.iroas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data?.note && <p className="rpt-iro-note">{data.note}</p>}
        </div>
      )}
    </section>
  )
}
