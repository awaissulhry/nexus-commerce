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
import { Button, Input, Select } from '@/design-system/primitives'
import { DataGrid, Tabs, type Column } from '@/design-system/components'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { ConflictsTab } from './ConflictsTab'
// Self-contained: this page borrows no class from the Control Room's stylesheet. Reusing
// `.acr-*` here rendered banners and section heads unstyled on prod, because that sheet is
// imported by the Control Room and nothing else — a cross-page dependency that only shows up
// in the browser.
import './coverage.css'

/**
 * The term grid's columns. Out here rather than inline so the render stays readable at eleven of
 * them, and so each one carries its own `sortValue` — a `null` share is NOT a zero share, so it
 * sorts as -1 and lands with the unknowns rather than among the genuinely invisible terms.
 */
function coverageColumns(maxShare: number, tosIsMeasured: boolean): Array<Column<Row>> {
  const num = (v: number | null) => (v == null ? -1 : v)
  const tip = (label: string, title: string) => <span title={title}>{label}</span>
  return [
    { key: 'term', label: 'Search term', sortable: true, sortValue: (r) => r.term, render: (r) => r.term },
    { key: 'marketImpressions', label: 'Market impressions', align: 'right', sortable: true, sortValue: (r) => r.marketImpressions, render: (r) => intl(r.marketImpressions) },
    { key: 'ourImpressions', label: 'Ours', align: 'right', sortable: true, sortValue: (r) => num(r.ourImpressions), render: (r) => intl(r.ourImpressions) },
    {
      key: 'share', label: 'Share of page one', align: 'right', width: 200, sortable: true, sortValue: (r) => num(r.share),
      render: (r) => (
        <span className="cov-sharecell">
          <span className="cov-bar" aria-hidden><span className="cov-bar-fill" style={{ width: `${barWidth(r.share, maxShare)}%` }} /></span>
          <span className="cov-bar-v">{pct(r.share)}</span>
        </span>
      ),
    },
    {
      key: 'ourAsins', label: tip('Ours on page', 'How many of OUR ASINs appear on this SERP. Context — presence is not the constraint.'),
      prefsLabel: 'Ours on page', align: 'right', sortable: true, sortValue: (r) => r.ourAsins,
      render: (r) => <span className={r.ourAsins > 1 ? 'multi' : undefined}>{r.ourAsins || '—'}</span>,
    },
    {
      key: 'pwScore', label: tip('Position-weighted', "Share re-expressed in top-of-search-equivalent units: share × (top mix + rest mix × the account's own measured rest:top CTR ratio)."),
      prefsLabel: 'Position-weighted', align: 'right', sortable: true, sortValue: (r) => num(r.pwScore),
      render: (r) => <span className="pw" title={POSITION_WHY[r.positionBasis] || undefined}>{r.pwScore != null ? pct(r.pwScore) : <span className="cov-unk">—</span>}</span>,
    },
    {
      key: 'topMix', label: tip('Top mix', 'Share of our paid search impressions that sat in top-of-search, from the placement mix of the campaigns holding this term.'),
      prefsLabel: 'Top mix', align: 'right', sortable: true, sortValue: (r) => num(r.topMix),
      render: (r) => <span title={POSITION_WHY[r.positionBasis] || undefined}>{r.topMix != null ? pctOf(r.topMix) : <span className="cov-unk">—</span>}</span>,
    },
    {
      key: 'tosIS', label: tip('ToS-IS', "Amazon's own top-of-search impression share for the holding campaigns."),
      prefsLabel: 'ToS-IS', align: 'right', sortable: true, sortValue: (r) => num(r.tosIS),
      render: (r) => <span title={tosIsMeasured ? undefined : 'Amazon has not returned this metric yet — the ingest is fixed but has not run.'}>{r.tosIS != null ? pctOf(r.tosIS) : <span className="cov-unk">—</span>}</span>,
    },
    {
      key: 'targets', label: tip('Keywords', 'Non-negative keywords targeting this exact term in this marketplace.'),
      prefsLabel: 'Keywords', align: 'right', sortable: true, sortValue: (r) => r.targets,
      render: (r) => <span className={r.targets === 0 ? 'none' : undefined}>{r.targets || 'none'}</span>,
    },
    { key: 'marketPurchases', label: 'Market buys', align: 'right', sortable: true, sortValue: (r) => r.marketPurchases, render: (r) => intl(r.marketPurchases) },
    { key: 'ourPurchases', label: 'Ours', align: 'right', sortable: true, sortValue: (r) => num(r.ourPurchases), render: (r) => intl(r.ourPurchases) },
  ]
}

interface Row {
  term: string
  marketImpressions: number
  ourImpressions: number | null
  share: number | null
  ourAsins: number
  targets: number
  marketPurchases: number
  ourPurchases: number | null
  tosIS: number | null
  topImpressions: number
  restImpressions: number
  topMix: number | null
  pwScore: number | null
  positionBasis: 'measured' | 'no-paid-impressions' | 'no-holding-campaign' | 'unmeasured-week'
}
interface PositionWeight {
  restWeight: number
  topCtr: number | null
  restCtr: number | null
  topImpressions: number
  restImpressions: number
  windowDays: number
  basis: 'measured' | 'fallback'
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
  positionWeight: PositionWeight
  tosIsMeasured: boolean
  pwTotal: number | null
}

const intl = (v: number | null) => (v == null ? '—' : v.toLocaleString('en-IE'))
const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`)
const pctOf = (v: number) => `${Math.round(v * 100)}%`
/**
 * Why a null here is never rendered as 0%: `positionBasis` names the reason, and a coverage
 * board that prints 0% for "we have no evidence" says we are absent from the top of the page,
 * which is a conclusion an operator would act on. Same rule the week-level `measured` flag
 * already enforces for share.
 */
const POSITION_WHY: Record<Row['positionBasis'], string> = {
  measured: '',
  'no-paid-impressions': 'we hold this term but bought no search impressions in the window',
  'no-holding-campaign': 'no campaign of ours holds this term, so any presence here is organic and its page position is unknown',
  'unmeasured-week': 'the week itself is unmeasured',
}

/** Share is tiny everywhere, so a linear bar would be invisible. Scaled to the row set's own max. */
const barWidth = (share: number | null, max: number) =>
  share == null || max <= 0 ? 0 : Math.max(2, (share / max) * 100)

export function CoverageClient() {
  const [board, setBoard] = useState<Board | null>(null)
  const [market, setMarket] = useState('IT')
  const [week, setWeek] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<'coverage' | 'conflicts'>('coverage')
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

      {/* Tabs, not routes: §4.1 keeps the sidebar untouched, and both views answer one
          question — how much of page one we hold, and who of ours is fighting over it. */}
      <Tabs
        className="cov-tabs"
        active={tab}
        onChange={(id) => setTab(id as 'coverage' | 'conflicts')}
        tabs={[
          { id: 'coverage', label: 'Coverage scoreboard' },
          { id: 'conflicts', label: 'Conflicts' },
        ]}
      />

      {tab === 'conflicts' && <ConflictsTab market={market} />}

      {tab === 'coverage' && err && <div className="cov-banner err" role="alert"><AlertTriangle size={15} /> {err}</div>}
      {tab === 'coverage' && loading && !board && <div className="cov-empty">Loading…</div>}

      {tab === 'coverage' && board && (
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
              {board.pwTotal != null && (
                <p className="cov-hero-pw">
                  <strong>{pct(board.pwTotal)}</strong> position-weighted — the same share
                  re-expressed in top-of-search-equivalent units, because we hold most of it near
                  the bottom of the page. A rest-of-search impression is worth{' '}
                  {pctOf(board.positionWeight.restWeight)} of a top one in this account
                  {board.positionWeight.basis === 'measured'
                    ? `, measured from our own CTR over ${board.positionWeight.windowDays} days.`
                    : ' (fallback — too little placement traffic to measure our own ratio).'}
                </p>
              )}
            </div>

            <div className="cov-controls">
              <label className="cov-field">
                <span>Week</span>
                <Select
                  value={week ?? ''}
                  style={{ minWidth: 190 }}
                  onChange={(e) => { setWeek(e.target.value); void load(market, e.target.value) }}
                >
                  {board.weeks.map((w) => (
                    <option key={w.startDate} value={w.startDate}>
                      {w.startDate}{w.measured ? '' : ' · not measured'}
                    </option>
                  ))}
                </Select>
              </label>
              <Button size="sm" onClick={() => void load(market, week)} disabled={loading}>
                <RefreshCw size={13} /> {loading ? 'Loading…' : 'Refresh'}
              </Button>
            </div>
          </div>

          {board.notes.map((n) => (
            <div key={n.slice(0, 40)} className={`cov-banner ${board.measured ? 'warn' : 'err'}`}>
              <Info size={15} /> <span>{n}</span>
            </div>
          ))}

          {board.headroom.length > 0 && (
            <section className="cov-headroom">
              <div className="cov-sec-head">
                <h2>Headroom</h2>
                <span className="cov-sec-count">
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

          <div className="cov-sec-head">
            <h2>Every term</h2>
            <span className="cov-sec-count">{rows.length} shown · largest market first</span>
            <Input
              fieldClassName="cov-search"
              leadingIcon={<Search size={13} aria-hidden />}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter terms"
              aria-label="Filter terms"
            />
          </div>

          {/* The eleven-column term table is the DS `DataGrid`. It gains sortable headers, which
              this surface never had — "largest market first" was the only order available, and the
              question "where is our share worst" needed it. Seeded to that original order so the
              first paint is unchanged. */}
          <DataGrid<Row>
            className="cov-termgrid"
            rows={rows}
            rowKey={(r) => r.term}
            initialSort={{ key: 'marketImpressions', dir: 'desc' }}
            columns={coverageColumns(maxShare, board.tosIsMeasured)}
          />

          <p className="cov-foot">
            Search Query Performance, weekly, from Amazon Brand Analytics. &ldquo;Ours on page&rdquo; counts
            distinct ASINs of ours that took at least one impression on that term — several of our
            products already share these pages, so the gap this board measures is share, not presence.
          </p>
        </>
      )}
    </div>
  )
}
