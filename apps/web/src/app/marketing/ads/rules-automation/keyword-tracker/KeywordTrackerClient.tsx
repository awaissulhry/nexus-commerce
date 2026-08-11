'use client'

/**
 * KT.1 — Keyword Tracker, its own page.
 *
 * One question: **on the keywords I chose, are we on the page — and is it moving?**
 * KT.1 answers the first half. It does not pretend to answer the second.
 *
 * What this page replaces, and why it is one flat grid:
 *
 *   · The old tab rendered `SovTrackerTab kind="tracker"` — a [ Rules | Report ] segmented control
 *     over `KeywordRank`, a table with 0 rows, so all four columns read `#—` on every row. Three of
 *     those columns (Organic Rank, Sponsored Rank, Rank Δ) describe something no Amazon API sells.
 *   · The [ Rules | Report ] control does not come across. Rules for this trigger live on the
 *     Automations page, where all 51 already are, and that segment has never been able to render a
 *     row: `liveType="keyword-tracker"` is not a key of `RULE_TAB_ACTION_TYPES`, so its filter
 *     returns false for every rule. A segment that cannot render a row is not a navigation aid.
 *   · Organic Rank and Sponsored Rank do not appear at all. An empty column is a promise; a missing
 *     column is a decision.
 *
 * Three laws this grid follows:
 *
 *   1. Where we have share, the column says share. `Our impression share` is SQP's
 *      `impressionShare` — our best ASIN's share of the whole market's impressions for that query.
 *      It is NOT `sovPct` (our own ad-traffic mix) and NOT `topOfSearchIS` (Amazon's top-slot
 *      share, campaign grain). Three different quantities; this page names the one it shows.
 *   2. A blank is not a zero. `measured: false` renders "not measured"; a real zero renders
 *      `0.00%`. Measured on prod: IT holds exactly one real zero today.
 *   3. Every row states the age of what it shows — because rows on this grid legitimately come
 *      from different weeks (see the service's period rule).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, Info } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { getBackendUrl } from '@/lib/backend-url'
import { KeywordScopeBar, type KtScope, type ScopeOptionsPayload } from './KeywordScopeBar'

/** The four production Amazon Ads markets. IE/NL/PL/SE/UK are sandbox and hold no listings. */
const MARKETS = ['IT', 'DE', 'ES', 'FR']
const DEFAULT_MARKET = 'IT'

interface Row {
  keyword: string
  marketplace: string
  marketVolume: number | null
  marketRank: number | null
  impressionShare: number | null
  asinsCompeting: number
  asOf: string | null
  asOfAgeDays: number | null
  measured: boolean
  branded: boolean
}

interface Payload {
  scope: {
    market: string
    boundBy: 'market' | 'line' | 'portfolio' | 'campaign'
    line: { id: string; name: string } | null
    portfolio: { id: string; name: string } | null
    campaign: { id: string; name: string } | null
    list: { id: string; name: string; marketplace: string; terms: number } | null
    resolved: { campaigns: number; asins: number; keywordsWatched: number; keywordsMeasured: number }
    unreachable: { campaignsWithoutPortfolio: number; campaignsInMarket: number } | null
  }
  window: { lookbackDays: number; periodsUsed: Array<{ start: string; terms: number }>; newestAsOf: string | null; oldestAsOf: string | null }
  freshness: {
    sqp: { latestPeriodStart: string | null; ingestedAt: string | null; ageDays: number | null }
    searchTerm: { latestDate: string | null; ageDays: number | null }
    placement: { latestDate: string | null; ageDays: number | null }
  }
  rows: Row[]
  total: number
  lists: Array<{ id: string; name: string; marketplace: string; enabled: boolean }>
}

const num = (n: number) => n.toLocaleString('en-IE')
/** A share is 0..1 from SQP. Two decimals of a percent, because 0.7% and 0.04% are both real here. */
const sharePct = (v: number) => `${(v * 100).toFixed(2)}%`
const dayMonth = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}
/** ≤7d fresh · ≤21d ageing · older is stale. Stale is a value, not an absence. */
const ageClass = (d: number | null) => (d == null ? '' : d <= 7 ? 'fresh' : d <= 21 ? 'ageing' : 'stale')

export function KeywordTrackerClient() {
  const router = useRouter()
  const params = useSearchParams()

  // Every view is linkable, and an absent param means the default — never a stored preference, so
  // a link renders the same view for whoever opens it. Market is in the URL too (it is the one
  // thing this page cannot be read without, and localStorage is invisible in a pasted link).
  const market = params.get('market') ?? DEFAULT_MARKET
  const scope: KtScope = {
    line: params.get('line') ?? '',
    portfolio: params.get('portfolio') ?? '',
    campaign: params.get('campaign') ?? '',
  }
  const list = params.get('list') ?? ''
  const branded = params.get('branded') === '1'
  const measured = (['all', 'yes', 'no'] as const).includes(params.get('measured') as 'all' | 'yes' | 'no')
    ? (params.get('measured') as 'all' | 'yes' | 'no')
    : 'all'
  const sort = params.get('sort') ?? 'volume'
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc'
  const kw = params.get('kw') ?? ''

  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [options, setOptions] = useState<ScopeOptionsPayload | null>(null)

  const push = useCallback((patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (!v || v === 'all' || (k === 'branded' && v === '0') || (k === 'market' && v === DEFAULT_MARKET)) next.delete(k)
      else next.set(k, v)
    }
    const qs = next.toString()
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }, [params, router])

  useEffect(() => {
    let alive = true
    void fetch(`${getBackendUrl()}/api/advertising/scope-options`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive && Array.isArray(d?.campaigns)) setOptions(d as ScopeOptionsPayload) })
      .catch(() => { /* the pickers degrade to empty; the grid does not depend on them */ })
    return () => { alive = false }
  }, [])

  const isMarket = MARKETS.includes(market)

  useEffect(() => {
    if (!isMarket) { setLoading(false); return }
    let alive = true
    setLoading(true)
    const q = new URLSearchParams({ market, measured, sort, dir, limit: '500' })
    if (scope.line) q.set('line', scope.line)
    if (scope.portfolio) q.set('portfolio', scope.portfolio)
    if (scope.campaign) q.set('campaign', scope.campaign)
    if (list) q.set('list', list)
    if (branded) q.set('branded', '1')
    void fetch(`${getBackendUrl()}/api/advertising/keyword-tracker?${q.toString()}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Could not load the tracker (${r.status})`)
        return r.json()
      })
      .then((d) => { if (alive) { setData(d as Payload); setErr(null) } })
      .catch((e) => { if (alive) { setErr((e as Error).message); setData(null) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [market, isMarket, scope.line, scope.portfolio, scope.campaign, list, branded, measured, sort, dir])

  const rows = useMemo(() => {
    const all = data?.rows ?? []
    return kw ? all.filter((r) => r.keyword === kw) : all
  }, [data, kw])

  const columns: GridColumn<Row>[] = useMemo(() => [
    {
      key: 'market', label: 'Market', metric: false,
      render: (r) => <span className="h10-kt-mkt">{r.marketplace}</span>,
      sortValue: (r) => r.marketplace,
    },
    {
      key: 'volume', label: 'Market volume',
      tip: 'Brand Analytics search-query volume: how many times the whole marketplace searched this term in the week this row reads. Not our impressions.',
      render: (r) => (r.marketVolume == null ? <span className="h10-kt-nd">—</span> : num(r.marketVolume)),
      sortValue: (r) => r.marketVolume ?? -1,
      filterValue: (r) => r.marketVolume ?? 0,
    },
    {
      key: 'rank', label: 'Market rank',
      tip: "The term's popularity rank in this marketplace (#1 = most searched). This is the QUERY's rank in the market — not our position in the results, which no Amazon API returns.",
      render: (r) => (r.marketRank == null ? <span className="h10-kt-nd">—</span> : `#${num(r.marketRank)}`),
      sortValue: (r) => r.marketRank ?? Number.MAX_SAFE_INTEGER,
      filterValue: (r) => r.marketRank ?? 0,
    },
    {
      key: 'share', label: 'Our impression share',
      tip: 'Brand Analytics impressionShare for our BEST ASIN on this query: our share of every impression the marketplace served for it. Not Share of Voice (our own ad-traffic mix) and not top-of-search impression share (Amazon\'s top-slot share, measured per campaign).',
      render: (r) => (
        r.measured
          ? <span className={`h10-kt-share${r.impressionShare === 0 ? ' zero' : ''}`}>{sharePct(r.impressionShare ?? 0)}</span>
          : <span className="h10-kt-nm">not measured</span>
      ),
      sortValue: (r) => r.impressionShare ?? -1,
      filterValue: (r) => (r.impressionShare ?? 0) * 100,
    },
    {
      key: 'asOf', label: 'As of', metric: false,
      tip: 'The week this row\'s volume, rank and share came from. Rows can differ: each term reads the newest weekly period that actually holds a row for it, inside the lookback window stated above the grid.',
      render: (r) => (
        r.asOf
          ? <span className={`h10-kt-age ${ageClass(r.asOfAgeDays)}`}>{dayMonth(r.asOf)}<i>{r.asOfAgeDays}d</i></span>
          : <span className="h10-kt-nd">no row in window</span>
      ),
      sortValue: (r) => r.asOf ?? '',
    },
  ], [])

  const activeTab = rulesTabByKey('keyword-tracker')
  const s = data?.scope
  const f = data?.freshness

  /** The one sentence stating what resolved — scope, then the age of what the grid is made of. */
  const resolution = (() => {
    if (!s || !data) return null
    const bits: string[] = [s.market]
    if (s.boundBy === 'campaign' && s.campaign) bits.push(`campaign “${s.campaign.name}”`)
    else if (s.boundBy === 'portfolio' && s.portfolio) bits.push(`portfolio “${s.portfolio.name}”`)
    else if (s.boundBy === 'line' && s.line) bits.push(`${s.line.name.split(' — ')[0]} line`)
    else bits.push('all campaigns')
    bits.push(`${num(s.resolved.campaigns)} campaign${s.resolved.campaigns === 1 ? '' : 's'}`)
    bits.push(`${num(s.resolved.asins)} ASIN${s.resolved.asins === 1 ? '' : 's'}`)
    bits.push(`watching ${num(s.resolved.keywordsWatched)} term${s.resolved.keywordsWatched === 1 ? '' : 's'}`)
    bits.push(`${num(s.resolved.keywordsMeasured)} with share data`)
    return bits.join(' · ')
  })()

  const shareAge = (() => {
    if (!data || !data.window.newestAsOf) return null
    const { newestAsOf, oldestAsOf } = data.window
    const ages = data.rows.filter((r) => r.asOfAgeDays != null).map((r) => r.asOfAgeDays!)
    const lo = Math.min(...ages), hi = Math.max(...ages)
    if (newestAsOf === oldestAsOf) return `share from the week of ${dayMonth(newestAsOf)} (${lo}d old)`
    return `share from the weeks of ${dayMonth(oldestAsOf!)}–${dayMonth(newestAsOf)} (${lo}–${hi}d old)`
  })()

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Keyword Tracker"
        subtitle={activeTab?.subtitle ?? 'On the keywords you chose — are we on the page, and is it moving?'}
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => push({ market: m })}
        showLearn={false}
        showDataSync={false}
        /* SQP is weekly and paid data is daily. One range control over both would be two
           vocabularies wearing one label, so this page carries no date control at all: each
           column states its own date instead. */
        showDateRange={false}
      />

      <RulesTabs active="keyword-tracker" />

      {!isMarket ? (
        // The header offers "All markets" on every ads page. Volume, rank and share are all
        // per-marketplace quantities, so there is no honest way to render them summed. Say that,
        // and hand back the four one-click routes out of it.
        <div className="h10-kt-pick">
          <h3>Pick one market</h3>
          <p>
            Market volume, market rank and impression share are per-marketplace numbers from Amazon
            Brand Analytics. There is no honest way to add them together, so this grid needs one
            market rather than “all”.
          </p>
          <div className="h10-kt-pickrow">
            {MARKETS.map((m) => (
              <button type="button" key={m} className="h10-am-btn" onClick={() => push({ market: m })}>{m}</button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <KeywordScopeBar
            options={options}
            market={market}
            scope={scope}
            boundBy={s?.boundBy ?? null}
            onChange={(next) => push({ line: next.line, portfolio: next.portfolio, campaign: next.campaign })}
          />

          {resolution && (
            <p className="h10-kt-said">
              <b>{resolution}</b>
              {shareAge && <> · {shareAge}</>}
              {f?.searchTerm.latestDate && (
                <> · paid data current to {dayMonth(f.searchTerm.latestDate)} ({f.searchTerm.ageDays}d) — not on this grid until KT.3</>
              )}
            </p>
          )}

          {/* 🔴 The portfolio grain has a hole in it, and a portfolio-scoped view must not look
              complete. Measured 2026-08-11: only 72 of 220 campaigns carry a portfolioId. */}
          {s?.unreachable && (
            <p className="h10-kt-blind">
              <AlertTriangle size={13} />
              <span>
                <b>This portfolio view cannot see {num(s.unreachable.campaignsWithoutPortfolio)} of
                the {num(s.unreachable.campaignsInMarket)} {s.market} campaigns.</b>{' '}
                They carry no portfolio id, so no portfolio-scoped view reaches them. Their ASINs are
                excluded from the share figures below.
              </span>
            </p>
          )}

          {/* The curated list is IT-only. Reading it against another market is legitimate — the
              terms are the terms — but the page has to say that is what is happening. */}
          {s?.list && s.list.marketplace !== market && (
            <p className="h10-kt-note out">
              <Info size={13} />
              <span>
                “{s.list.name}” was curated for <b>{s.list.marketplace}</b>. You are reading its{' '}
                {num(s.list.terms)} terms against <b>{market}</b>.
              </span>
            </p>
          )}

          {err && <p className="h10-kt-blind"><AlertTriangle size={13} /><span>{err}</span></p>}

          {kw && (
            <p className="h10-kt-note">
              <Info size={13} />
              <span>Showing one keyword: <b>{kw}</b>. <button type="button" className="lnk" onClick={() => push({ kw: '' })}>Show all {num(data?.total ?? 0)}</button></span>
            </p>
          )}

          <AdsDataGrid<Row>
            rows={rows}
            loading={loading}
            rowId={(r) => `${r.marketplace}:${r.keyword}`}
            noun="Keyword"
            firstColLabel="Keyword"
            renderFirst={(r) => (
              <div className="h10-kt-kw">
                <span className="t" title={r.keyword}>{r.keyword}</span>
                {r.branded && <span className="bd" title="One of the 10 protected brand terms">brand</span>}
                {/* Our own ASINs splitting one query's impressions — the operator's
                    "three similar products competing for one keyword" question, measurable only
                    from SQP because the search-term report carries no ASIN column. */}
                {r.asinsCompeting > 1 && (
                  <span className="ac" title={`${r.asinsCompeting} of our own ASINs hold a row on this query in the week this row reads — they are splitting its impressions`}>
                    {r.asinsCompeting} of ours
                  </span>
                )}
              </div>
            )}
            firstSortValue={(r) => r.keyword}
            columns={columns}
            defaultSort={{ key: sort === 'keyword' ? '__first' : sort, dir }}
            selectable={false}
            customizable={false}
            searchable
            searchPlaceholder="Search keywords…"
            searchValue={(r) => r.keyword}
            pagerCentered
            storageKey="nexus.kt.cols"
            toolbarLeft={(
              <span className="h10-kt-tools">
                <span className="h10-svt-seg" role="tablist" aria-label="Share data filter">
                  {([['all', 'All'], ['yes', 'With share data'], ['no', 'Not measured']] as const).map(([v, label]) => (
                    <button
                      key={v} type="button" role="tab" aria-selected={measured === v}
                      className={`seg ${measured === v ? 'on' : ''}`}
                      onClick={() => push({ measured: v })}
                    >{label}</button>
                  ))}
                </span>
                <button
                  type="button"
                  className={`h10-kt-toggle ${branded ? 'on' : ''}`}
                  onClick={() => push({ branded: branded ? '0' : '1' })}
                  title="Our own brand terms flatter every share number on this page, so they are excluded by default"
                >
                  Brand terms: {branded ? 'included' : 'excluded'}
                </button>
              </span>
            )}
            toolbarRight={data?.window ? (
              <span className="h10-kt-win">
                lookback {data.window.lookbackDays}d
                {data.window.periodsUsed.length > 1 && (
                  <i title={data.window.periodsUsed.map((p) => `${p.start}: ${p.terms} terms`).join(' · ')}>
                    {data.window.periodsUsed.length} weeks in view
                  </i>
                )}
              </span>
            ) : undefined}
            emptyNode={(
              <span className="h10-kt-empty">
                {measured === 'no' && (data?.scope.resolved.keywordsMeasured ?? 0) > 0 ? (
                  <b>Every watched term has share data in this scope. Nothing is unmeasured.</b>
                ) : (data?.scope.resolved.keywordsWatched ?? 0) === 0 ? (
                  <>
                    <b>No watchlist for this view.</b>
                    <span>
                      The tracker reads the curated coverage list plus the protected brand terms.
                      Excluding brand terms left nothing — try including them.
                    </span>
                  </>
                ) : (
                  <>
                    <b>Not measured — no Brand Analytics row for any watched term in {market}.</b>
                    <span>
                      {num(data?.scope.resolved.keywordsWatched ?? 0)} terms are being watched. The
                      weekly Brand Analytics feed holds no row for any of them within the last{' '}
                      {data?.window.lookbackDays ?? 56} days
                      {f?.sqp.latestPeriodStart ? <> — its newest {market} period is {dayMonth(f.sqp.latestPeriodStart)} ({f.sqp.ageDays}d old)</> : null}.
                      That is an absence of measurement, not a zero share.
                    </span>
                  </>
                )}
              </span>
            )}
            reportLabel={f?.sqp.ingestedAt ? `Brand Analytics ingested ${new Date(f.sqp.ingestedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : undefined}
          />
        </>
      )}
    </div>
  )
}
