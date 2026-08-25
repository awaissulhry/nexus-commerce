'use client'

/**
 * RPT.11 — the business-context panel.
 *
 * Everything else in Reporting measures advertising against itself. ACOS compares
 * spend to *attributed* sales, which cannot answer the question that actually
 * decides a budget: what does advertising cost the business as a whole? TACoS
 * answers that, and the gap between the two is the finding.
 *
 * The per-market split is where it earns its place. Italy reads a frightening
 * 66% ACOS but only 15.7% TACoS, because 76% of Italian revenue is organic;
 * Germany reads a comfortable 25% ACOS while 59% of its revenue depends on ads.
 * Those are opposite situations that ACOS alone reports as "Germany is fine,
 * Italy is broken".
 *
 * Caveats render as part of the panel, not a footnote — the wasted-spend figure
 * in particular is NOT margin-based, because no product in this catalogue carries
 * a cost price yet, and a number that implies more rigour than it has is worse
 * than no number.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, Info, TrendingDown } from 'lucide-react'
import { DataGrid } from '@/design-system/components'
import { fetchBusinessContext, money, money2, pct, type BusinessContext, type MarketContext } from './business-api'

export function BusinessContextPanel() {
  const [ctx, setCtx] = useState<BusinessContext | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    fetchBusinessContext(30, ac.signal)
      .then(setCtx)
      .catch((e: unknown) => { if ((e as Error).name !== 'AbortError') setErr((e as Error).message) })
    return () => ac.abort()
  }, [])

  if (err) return null
  if (!ctx) return null

  const t = ctx.totals
  const organic = t.adShare == null ? null : Math.max(0, 1 - t.adShare)

  return (
    <section className="rpt-group">
      <h2 className="rpt-group-hd">
        Business context <span className="count">last 30 days · Amazon</span>
      </h2>

      <div className="rpt-biz">
        <div className="rpt-biz-top">
          <div className="rpt-biz-kpi">
            <span className="lbl">TACoS</span>
            <span className="val">{pct(t.tacos)}</span>
            <span className="sub">ad spend ÷ <b>total</b> sales</span>
          </div>
          <div className="rpt-biz-kpi">
            <span className="lbl">ACOS</span>
            <span className="val">{pct(t.acos)}</span>
            <span className="sub">ad spend ÷ <b>attributed</b> sales</span>
          </div>
          <div className="rpt-biz-kpi">
            <span className="lbl">Total sales</span>
            <span className="val">{money(t.totalSales, ctx.currency)}</span>
            <span className="sub">{money(t.adSpend, ctx.currency)} of ad spend behind it</span>
          </div>
          <div className="rpt-biz-kpi wide">
            <span className="lbl">Where revenue comes from</span>
            {/* A 2px surface gap separates the two fills, and both carry a text
                label — the split is never read from colour alone. */}
            <span className="rpt-split" role="img"
              aria-label={`Ads ${pct(t.adShare)}, organic ${pct(organic)}`}>
              <span className="ad" style={{ flexGrow: Math.max(0.02, t.adShare ?? 0) }} />
              <span className="org" style={{ flexGrow: Math.max(0.02, organic ?? 1) }} />
            </span>
            <span className="sub">
              <b>{pct(t.adShare)}</b> ad-attributed · <b>{pct(organic)}</b> organic
            </span>
          </div>
        </div>

        <DataGrid<MarketContext>
          size="sm"
          rows={ctx.byMarket}
          rowKey={(m) => m.marketplace}
          columns={[
            { key: 'mkt', label: 'Market', sortable: true, sortValue: (m) => m.marketplace, render: (m) => <b>{m.marketplace}</b> },
            { key: 'spend', label: 'Ad spend', align: 'right', sortable: true, sortValue: (m) => m.adSpend, render: (m) => money2(m.adSpend, ctx.currency) },
            { key: 'sales', label: 'Total sales', align: 'right', sortable: true, sortValue: (m) => m.totalSales, render: (m) => money2(m.totalSales, ctx.currency) },
            { key: 'acos', label: 'ACOS', align: 'right', sortable: true, sortValue: (m) => m.acos ?? -1, render: (m) => pct(m.acos) },
            { key: 'tacos', label: 'TACoS', align: 'right', sortable: true, sortValue: (m) => m.tacos ?? -1, render: (m) => pct(m.tacos) },
            { key: 'adshare', label: 'Ad-driven', align: 'right', sortable: true, sortValue: (m) => m.adShare ?? -1, render: (m) => pct(m.adShare) },
          ]}
        />

        <div className="rpt-biz-waste">
          <div className="hd">
            <TrendingDown size={14} aria-hidden />
            <span className="amt">{money2(ctx.wasted.amount, ctx.currency)}</span>
            <span>
              spent on <b>{ctx.wasted.terms}</b> search terms that produced no sales
              {' — '}{pct(ctx.wasted.pctOfSpend)} of the spend examined
            </span>
          </div>
          <p className="rule">
            Counted only where a term took <b>{ctx.wasted.minClicks}+ clicks</b> and still
            converted nothing, judged to <b>{ctx.wasted.maturedTo}</b>.
          </p>
          {ctx.wasted.top.length > 0 && (
            <ul className="top">
              {ctx.wasted.top.slice(0, 5).map((w) => (
                <li key={`${w.marketplace}-${w.query}`}>
                  <span className="s">{money2(w.spend, ctx.currency)}</span>
                  <span className="c">{w.clicks} clicks</span>
                  <span className="m">{w.marketplace}</span>
                  <span className="q">{w.query}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <ul className="rpt-biz-caveats">
          {ctx.caveats.map((c) => (
            <li key={c}>
              {/^Ad-attributed sales exceed/.test(c)
                ? <AlertTriangle size={12} aria-hidden />
                : <Info size={12} aria-hidden />}
              {c}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
