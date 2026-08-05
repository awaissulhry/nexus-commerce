'use client'

/**
 * ACR.2.2 — Coverage: how much of page one we own, per keyword.
 *
 * Replaces the "pixel-match in progress" stub. Per the standing split — Reporting = data,
 * Analytics = meaning — this page exists to answer one question and does not try to be a
 * general analytics surface.
 *
 * The measurement that shaped the layout: on `giacca moto estiva uomo` ten of our ASINs already
 * appear on the SERP, and together they hold 0.19% of 1.1M impressions. Presence was never the
 * constraint; share is. So share is the widest, boldest column and "ours on page" sits beside it
 * as context — the opposite of how the page would have been built before the data existed.
 *
 * An unmeasured week renders every share as "—", never 0%. A zero there would say "we are
 * invisible on this term", which is a conclusion an operator would act on; the truth is only
 * that the week has not been re-read since the parser fix.
 *
 * Light-only, like the rest of this console.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Info, RefreshCw, Search } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import './coverage.css'

interface Row {
  term: string
  marketImpressions: number
  ourImpressions: number | null
  share: number | null
  ourAsins: number
  targets: number
  marketPurchases: number
  ourPurchases: number | null
}
interface Week { startDate: string; rows: number; measured: boolean }
interface Board {
  marketplace: string
  week: string | null
  weeks: Week[]
  measured: boolean
  totals: {
    terms: number; marketImpressions: number; ourImpressions: number | null
    share: number | null; marketPurchases: number; ourPurchases: number | null
  }
  rows: Row[]
  headroom: Row[]
  notes: string[]
  marketplaces: string[]
}

const intl = (v: number | null) => (v == null ? '—' : v.toLocaleString('en-IE'))
const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`)

/** Share is tiny everywhere, so a linear bar would be invisible. Scaled to the row set's own max. */
const barWidth = (share: number | null, max: number) =>
  share == null || max <= 0 ? 0 : Math.max(2, (share / max) * 100)

export function CoverageClient() {
  const [board, setBoard] = useState<Board | null>(null)
  const [market, setMarket] = useState('IT')
  const [week, setWeek] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async (mkt: string, wk: string | null) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ marketplace: mkt, limit: '150' })
      if (wk) params.set('week', wk)
      const r = await fetch(`${getBackendUrl()}/api/advertising/coverage/scoreboard?${params}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`coverage: ${r.status}`)
      const j = (await r.json()) as Board
      setBoard(j)
      setWeek(j.week)
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
      setBoard(null)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load(market, null) }, [load, market])

  const rows = (board?.rows ?? []).filter((r) => !q || r.term.toLowerCase().includes(q.toLowerCase()))
  const maxShare = Math.max(0, ...(board?.rows ?? []).map((r) => r.share ?? 0))

  return (
    <div className="cov">
      <AdsPageHeader
        title="Coverage"
        subtitle="How much of page one we hold, per keyword — market size, our share, and what we hold it with."
        markets={board?.marketplaces ?? ['IT']}
        market={market}
        onMarketChange={setMarket}
        showDateRange={false}
        showDataSync={false}
      />

      {err && <div className="acr-banner err" role="alert"><AlertTriangle size={15} /> {err}</div>}
      {loading && !board && <div className="cov-empty">Loading…</div>}

      {board && (
        <>
          <div className="cov-top">
            <div className="cov-hero">
              <div className="cov-hero-k">Share of page one · {board.week ?? '—'}</div>
              <div className="cov-hero-v">
                {pct(board.totals.share)}
                <span className="cov-hero-sub">
                  {intl(board.totals.ourImpressions)} of {intl(board.totals.marketImpressions)} impressions
                  {' · '}{board.totals.terms} terms
                </span>
              </div>
              <p className="cov-hero-note">
                Pooled across every term in the week — not an average of per-term percentages,
                which on this data inverts the conclusion.
              </p>
            </div>

            <div className="cov-controls">
              <label className="cov-field">
                <span>Week</span>
                <select
                  value={week ?? ''}
                  onChange={(e) => { setWeek(e.target.value); void load(market, e.target.value) }}
                >
                  {board.weeks.map((w) => (
                    <option key={w.startDate} value={w.startDate}>
                      {w.startDate}{w.measured ? '' : ' · not measured'}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="acr-refresh" onClick={() => void load(market, week)} disabled={loading}>
                <RefreshCw size={13} /> {loading ? 'Loading…' : 'Refresh'}
              </button>
            </div>
          </div>

          {board.notes.map((n) => (
            <div key={n.slice(0, 40)} className={`acr-banner ${board.measured ? 'warn' : 'err'}`}>
              <Info size={15} /> <span>{n}</span>
            </div>
          ))}

          {board.headroom.length > 0 && (
            <section className="cov-headroom">
              <div className="acr-sec-head">
                <h2>Headroom</h2>
                <span className="acr-sec-count">
                  big markets we hold almost none of — ordered by what is available, not by what we spend
                </span>
              </div>
              <ul className="cov-head-list">
                {board.headroom.map((r) => (
                  <li key={r.term}>
                    <span className="cov-head-term">{r.term}</span>
                    <span className="cov-head-market">{intl(r.marketImpressions)}</span>
                    <span className="cov-head-share">{pct(r.share)}</span>
                    <span className={`cov-head-kw ${r.targets === 0 ? 'none' : ''}`}>
                      {r.targets === 0 ? 'no keyword' : `${r.targets} keywords`}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="acr-sec-head">
            <h2>Every term</h2>
            <span className="acr-sec-count">{rows.length} shown · largest market first</span>
            <label className="cov-search">
              <Search size={13} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter terms" />
            </label>
          </div>

          <div className="cov-tablewrap">
            <table className="cov-table">
              <thead>
                <tr>
                  <th className="l">Search term</th>
                  <th>Market impressions</th>
                  <th>Ours</th>
                  <th className="share">Share of page one</th>
                  <th title="How many of OUR ASINs appear on this SERP. Context — presence is not the constraint.">Ours on page</th>
                  <th title="Non-negative keywords targeting this exact term in this marketplace.">Keywords</th>
                  <th>Market buys</th>
                  <th>Ours</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.term}>
                    <td className="l">{r.term}</td>
                    <td>{intl(r.marketImpressions)}</td>
                    <td>{intl(r.ourImpressions)}</td>
                    <td className="share">
                      <span className="cov-bar" aria-hidden>
                        <span className="cov-bar-fill" style={{ width: `${barWidth(r.share, maxShare)}%` }} />
                      </span>
                      <span className="cov-bar-v">{pct(r.share)}</span>
                    </td>
                    <td className={r.ourAsins > 1 ? 'multi' : undefined}>{r.ourAsins || '—'}</td>
                    <td className={r.targets === 0 ? 'none' : undefined}>{r.targets || 'none'}</td>
                    <td>{intl(r.marketPurchases)}</td>
                    <td>{intl(r.ourPurchases)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="acr-foot">
            Search Query Performance, weekly, from Amazon Brand Analytics. &ldquo;Ours on page&rdquo; counts
            distinct ASINs of ours that took at least one impression on that term — several of our
            products already share these pages, so the gap this board measures is share, not presence.
          </p>
        </>
      )}
    </div>
  )
}
