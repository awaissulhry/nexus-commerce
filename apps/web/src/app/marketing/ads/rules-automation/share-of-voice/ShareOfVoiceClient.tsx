'use client'

/**
 * SOV.0 — Share of Voice, its own page. The basis only.
 *
 * One question: **on the queries that matter, how much of each market do we hold?**
 *
 * The split with its sibling, stated once and obeyed everywhere:
 *   · **Keyword Tracker is a watchlist view** — a term is there because a human put it there.
 *   · **Share of Voice is a market view** — a term is there because a market exists.
 * So `?list=` defaults to `all` here and to the market's own list there. That inversion is the
 * whole difference between the two pages, and it is deliberate.
 *
 * What this page replaces:
 *   · The old tab rendered `SovTrackerTab kind="sov"` — a [ Rules | Report ] segmented control whose
 *     Rules half is the DEFAULT view and can never render a row (`liveType="sov"` is not a key of
 *     `RULE_TAB_ACTION_TYPES`, so its filter returns false for all 51 of the account's rules, and an
 *     account with 51 rules was shown "create your first rule").
 *   · Its one metric column, "Share of Voice", divided by 498,606 impressions against a real
 *     campaign-grain total of 1,765,323 — **28.2%** — because Amazon's search-term report returns
 *     only CLICKED queries and 76% of our impressions are on product detail pages. It is deleted,
 *     not renamed: no column header is true of that quantity.
 *   · The "Remove" row action mutated local state and lied — the rows are computed per request.
 *     Computed rows have no per-row mutations, so there are none here.
 *
 * ONE metric column, on purpose. Market impression share proves scope resolution, the period gate,
 * the blank-state contract and the coverage statement end to end on real data. If any of those four
 * is wrong, every column added later is wrong in the same way. SOV.1–SOV.7 add the rest.
 *
 * Three laws this grid follows:
 *   1. **A blank is never a zero, and it is never one thing.** `share()` in the data layer returns
 *      `0` when the market total is `0`, so "Amazon reported no market total" and "we hold none of
 *      this market" arrive identically. This page reads an API that never coalesces them, and
 *      renders four states with four different treatments.
 *   2. **Two feeds, two ages, never one number.** The market side is ~17 days behind by
 *      configuration; the ad side is 2 days behind. The band states both.
 *   3. **Every view states its reach before any number** — campaigns resolved, and how many of the
 *      scope's ASINs Brand Analytics actually reports on. Coverage is 12.8% in IT and 4.4% in FR.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, Info, Search } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { getBackendUrl } from '@/lib/backend-url'
// 🔴 Imported from the Keyword Tracker's directory, not copied. It is already generic — it takes
// options, market, scope, onChange and boundBy, and has no watchlist coupling. The moment it needs
// a change it gets lifted to `_shared/ScopeBar.tsx` with KT's import updated in the same commit.
// A second scope bar is a second place for the two pages to disagree about what a portfolio means.
import { KeywordScopeBar, type KtScope, type ScopeOptionsPayload } from '../keyword-tracker/KeywordScopeBar'

/** The four production Amazon Ads markets. IE/NL/PL/SE/UK are sandbox and hold no listings. */
const MARKETS = ['IT', 'DE', 'ES', 'FR']
const DEFAULT_MARKET = 'IT'
/** How far back the view may reach for its ONE period, in weeks. See the service's `SOV_WEEKS`. */
const WEEKS = [4, 8, 13] as const
const DEFAULT_WEEKS = 8

type RowState = 'measured' | 'not-covered' | 'no-row-this-period' | 'never-measured'

interface Row {
  query: string
  marketplace: string
  marketVolume: number | null
  marketRank: number | null
  marketImpressions: number | null
  ourImpressions: number | null
  /** 0..1, or null. null and 0 mean different things and are never rendered the same way. */
  share: number | null
  asinsCompeting: number
  state: RowState
  lastSeen: string | null
  lastSeenAgeDays: number | null
  branded: boolean
  asinLike: boolean
  onList: boolean
}

interface Payload {
  scope: {
    market: string
    boundBy: 'market' | 'line' | 'portfolio' | 'campaign'
    line: { id: string; name: string } | null
    portfolio: { id: string; name: string } | null
    campaign: { id: string; name: string } | null
    list: { id: string; name: string; terms: number; isDefault: boolean; source: string } | null
    listRejected: boolean
    resolved: {
      campaigns: number; campaignsInMarket: number; campaignsWithoutPortfolio: number
      asins: number; asinsWithSqpRows: number; asinsWithSqpRowsEver: number; queries: number
    }
  }
  period: {
    asOf: string | null; ageDays: number | null; rows: number; baselineRows: number
    threshold: number; reason: 'complete' | 'incomplete-week' | 'outside-lookback' | 'no-data'
    truncated: boolean; rejected: Array<{ start: string; rows: number }>
    weeks: number; lookbackDays: number; ktLookbackDays: number
    completenessRatio: number; baselinePeriods: number
  }
  freshness: {
    sqp: { latest: string | null; ageDays: number | null }
    ads: { latest: string | null; ageDays: number | null }
  }
  census: {
    total: number; measured: number; noRowThisPeriod: number; neverMeasured: number
    notCovered: number; realZeros: number; noMarketTotal: number
  }
  facets: {
    branded: number; asinLike: number
    byList: Array<{ id: string; name: string; terms: number; isDefault: boolean; source: string }>
  }
  rows: Row[]
  total: number
}

const num = (n: number) => n.toLocaleString('en-IE')
/** A share is 0..1 from Brand Analytics. Two decimals of a percent — 0.07% and 2.19% are both real. */
const sharePct = (v: number) => `${(v * 100).toFixed(2)}%`
const dayMonth = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}
/** ≤7d fresh · ≤21d ageing · older is stale. Stale is a value, not an absence. */
const ageClass = (d: number | null) => (d == null ? '' : d <= 7 ? 'fresh' : d <= 21 ? 'ageing' : 'stale')

const LIST_SOURCE: Record<string, string> = {
  'coverage-set-import': 'copied from the curated coverage set',
  'bid-keywords': 'the keywords we bid on that Brand Analytics can measure',
  sqp: 'Brand Analytics queries',
  manual: 'added by hand',
  import: 'imported',
}

export function ShareOfVoiceClient() {
  const router = useRouter()
  const params = useSearchParams()

  /**
   * The URL contract. Every param round-trips and an absent one means its DOCUMENTED default,
   * never a stored preference — a pasted link must render the same view for whoever opens it.
   *
   * Reserved, declared here, and deliberately NOT implemented — each names the section that owns it
   * so the next seven sessions do not invent a second spelling:
   *   ?adWindow=7d|14d|30d   SOV.2 — the ad-side columns, which are DAILY. Two grains on one page,
   *                          each labelled, exactly as Keyword Tracker settled it. It is not built
   *                          because no ad-side column exists yet to move.
   *   ?view=share|mix|unbid  SOV.4 — the unbid-demand view.
   *   ?signal=…              SOV.3 — outbid / weak-relevance / cannibalised, once they are re-cut.
   *   ?row=<query>@<market>  SOV.5 — the detail drawer. Read below so a link survives the deploy
   *                          that adds the drawer; it opens nothing today.
   */
  const market = params.get('market') ?? DEFAULT_MARKET
  const scope: KtScope = {
    line: params.get('line') ?? '',
    portfolio: params.get('portfolio') ?? '',
    campaign: params.get('campaign') ?? '',
  }
  const list = params.get('list') ?? 'all'
  const weeksRaw = Number(params.get('weeks'))
  const weeks = (WEEKS as readonly number[]).includes(weeksRaw) ? weeksRaw : DEFAULT_WEEKS
  const branded = params.get('branded') === '1'
  const q = params.get('q') ?? ''
  const sort = params.get('sort') ?? 'volume'
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc'

  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [options, setOptions] = useState<ScopeOptionsPayload | null>(null)
  const [qDraft, setQDraft] = useState(q)

  const push = useCallback((patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      // Drop a param that equals its default, so a shared link carries only what makes it different
      // — except `market`, which is written back explicitly below.
      const isDefault = !v
        || (k === 'list' && v === 'all')
        || (k === 'branded' && v === '0')
        || (k === 'weeks' && Number(v) === DEFAULT_WEEKS)
      if (isDefault) next.delete(k)
      else next.set(k, v)
    }
    const qs = next.toString()
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }, [params, router])

  /**
   * 🔴 `market` is WRITTEN BACK when it defaults, unlike every other param.
   *
   * Share is a per-market quantity — impression share, market volume and market rank are all
   * per-marketplace — so a link that does not name its market is ambiguous in a way a link with no
   * `?weeks=` is not. Writing it in means a copied URL says IT rather than meaning "whatever IT
   * happens to be the default on the day you open it".
   */
  useEffect(() => {
    if (params.get('market')) return
    const next = new URLSearchParams(params.toString())
    next.set('market', DEFAULT_MARKET)
    router.replace(`?${next.toString()}`, { scroll: false })
  }, [params, router])

  useEffect(() => { setQDraft(q) }, [q])

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
    // One page large enough to hold the biggest market (IT: 480 rows today) so the grid's own pager
    // is the operator-facing one. `limit`/`offset` ARE implemented server-side and verified — see
    // the doc's known-gaps section for why `?page=` cannot yet be driven from the grid.
    const qs = new URLSearchParams({ market, sort, dir, weeks: String(weeks), limit: '2000' })
    if (scope.line) qs.set('line', scope.line)
    if (scope.portfolio) qs.set('portfolio', scope.portfolio)
    if (scope.campaign) qs.set('campaign', scope.campaign)
    if (list && list !== 'all') qs.set('list', list)
    if (branded) qs.set('branded', '1')
    if (q) qs.set('q', q)
    void fetch(`${getBackendUrl()}/api/advertising/share-of-voice-page?${qs.toString()}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Could not load Share of Voice (${r.status})`)
        return r.json()
      })
      .then((d) => { if (alive) { setData(d as Payload); setErr(null) } })
      .catch((e) => { if (alive) { setErr((e as Error).message); setData(null) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [market, isMarket, scope.line, scope.portfolio, scope.campaign, list, branded, weeks, q, sort, dir])

  const rows = data?.rows ?? []
  const s = data?.scope
  const p = data?.period
  const f = data?.freshness
  const c = data?.census

  const columns: GridColumn<Row>[] = useMemo(() => [
    {
      key: 'market', label: 'Market', metric: false,
      render: (r) => <span className="h10-sov-mkt">{r.marketplace}</span>,
      sortValue: (r) => r.marketplace,
    },
    {
      key: 'volume', label: 'Market volume',
      tip: 'Brand Analytics search-query volume: how many times the WHOLE marketplace searched this term in the week this grid renders. Not our impressions.',
      render: (r) => (r.marketVolume == null ? <span className="h10-sov-nd">—</span> : num(r.marketVolume)),
      sortValue: (r) => r.marketVolume ?? -1,
      filterValue: (r) => r.marketVolume ?? 0,
    },
    {
      key: 'rank', label: 'Market rank',
      tip: "The QUERY's popularity rank in this marketplace (#1 = most searched). Not our position in the results, which no Amazon API returns.",
      render: (r) => (r.marketRank == null ? <span className="h10-sov-nd">—</span> : `#${num(r.marketRank)}`),
      sortValue: (r) => r.marketRank ?? Number.MAX_SAFE_INTEGER,
      filterValue: (r) => r.marketRank ?? 0,
    },
    {
      key: 'share', label: 'Market impression share',
      tip: 'Our impressions ÷ every impression the whole marketplace served for this query, in the week this grid renders, summed over the ASINs in scope. This is Brand Analytics — NOT the old "Share of Voice" column, which divided by our own clicked search-term impressions (28% of our real total).',
      render: (r) => {
        if (r.state === 'measured') {
          // A measured row with no share means Amazon reported no market total to divide by. That
          // is NOT "we hold none", and the API is careful to send null rather than 0 for it.
          if (r.share == null) {
            return <span className="h10-sov-nm" title="Amazon reported no market total for this query in this week, so there is nothing to divide by. This is not a zero share.">no market total</span>
          }
          // 🔴 A real zero is a FINDING, not a blank: the market served impressions for this query
          // and we took none of them. It carries its own treatment and states the market's size.
          if (r.share === 0) {
            return (
              <span className="h10-sov-share zero" title={`The marketplace served ${num(r.marketImpressions ?? 0)} impressions for this query in this week and none of them were ours.`}>
                0.00%<i>{num(r.marketImpressions ?? 0)} in the market</i>
              </span>
            )
          }
          return <span className="h10-sov-share">{sharePct(r.share)}</span>
        }
        // Three blanks, three sentences. A blank that means four things is worse than no column.
        if (r.state === 'not-covered') {
          return (
            <span className="h10-sov-nc" title={`The marketplace has this query this week — ${num(r.marketImpressions ?? 0)} impressions — but Brand Analytics reports on none of the ASINs in this scope. Coverage is ten ASINs per market per run, so this is a reporting gap, not an absence of demand.`}>
              outside coverage
            </span>
          )
        }
        return r.state === 'no-row-this-period'
          ? <span className="h10-sov-nm" title={`Brand Analytics has this query in ${r.marketplace}, but not in the week this grid renders${r.lastSeen ? ` — its newest row is the week of ${dayMonth(r.lastSeen)}` : ''}`}>no row this week</span>
          : <span className="h10-sov-nm muted" title={`Brand Analytics has never reported this query in ${r.marketplace}, at any period`}>never measured</span>
      },
      sortValue: (r) => r.share ?? -1,
      filterValue: (r) => (r.share ?? 0) * 100,
    },
    {
      key: 'asins', label: 'ASINs competing',
      tip: 'How many of OUR ASINs in this scope hold a Brand Analytics row on this query in the week the grid renders. More than one means our own products are splitting the same query.',
      render: (r) => (r.state === 'measured'
        ? <span className={`h10-sov-ac${r.asinsCompeting > 1 ? ' many' : ''}`}>{r.asinsCompeting}</span>
        : <span className="h10-sov-nd">—</span>),
      sortValue: (r) => r.asinsCompeting,
      filterValue: (r) => r.asinsCompeting,
    },
    {
      key: 'asOf', label: 'As of', metric: false,
      tip: 'The week this WHOLE grid renders — one period for every row, so two rows can be compared with each other. A blank row shows the last week Brand Analytics did report that query, if there is one.',
      render: (r) => {
        if (r.state === 'measured' && p?.asOf) {
          return <span className={`h10-sov-age ${ageClass(p.ageDays)}`}>{dayMonth(p.asOf)}<i>{p.ageDays}d</i></span>
        }
        // Deliberately unbounded by the lookback: a date is worth stating at any age, and
        // "last seen 12 Jul" is a more useful sentence than "never measured" is a true one.
        if (r.lastSeen) {
          return <span className="h10-sov-age stale" title="The newest week this query has a row in, at any age">last seen {dayMonth(r.lastSeen)}<i>{r.lastSeenAgeDays}d</i></span>
        }
        return <span className="h10-sov-nd">—</span>
      },
      sortValue: (r) => (r.state === 'measured' ? (p?.asOf ?? '') : (r.lastSeen ?? '')),
    },
  ], [p?.asOf, p?.ageDays])

  const activeTab = rulesTabByKey('share-of-voice')

  /** The two-number reach sentence, before any figure on the grid. */
  const reach = (() => {
    if (!s) return null
    const bits: string[] = [s.market]
    if (s.boundBy === 'campaign' && s.campaign) bits.push(`campaign “${s.campaign.name}”`)
    else if (s.boundBy === 'portfolio' && s.portfolio) bits.push(`portfolio “${s.portfolio.name}”`)
    else if (s.boundBy === 'line' && s.line) bits.push(`${s.line.name.split(' — ')[0]} line`)
    else bits.push('all campaigns')
    bits.push(`${num(s.resolved.campaigns)} of ${num(s.resolved.campaignsInMarket)} ${s.market} campaign${s.resolved.campaignsInMarket === 1 ? '' : 's'}`)
    bits.push(`${num(s.resolved.asinsWithSqpRowsEver)} of ${num(s.resolved.asins)} ASIN${s.resolved.asins === 1 ? '' : 's'} have Brand Analytics rows`)
    return bits.join(' · ')
  })()

  /** A scope that reaches no measured ASIN is a RENDERED state naming which pair conflicts. */
  const emptyScope = !!s && !loading && s.resolved.asins > 0 && s.resolved.asinsWithSqpRowsEver === 0
  const noAsins = !!s && !loading && s.resolved.asins === 0

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Share of Voice"
        subtitle={activeTab?.subtitle ?? 'On the queries that matter, how much of each market do we hold?'}
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => push({ market: m })}
        showLearn={false}
        showDataSync={false}
        /* No date range. Brand Analytics is WEEKLY and the paid feed is daily, and they are 15 days
           apart — one range control over both would be two vocabularies wearing one label. The
           `weeks` control in the toolbar states which columns it moves, and each column states its
           own date. `?adWindow=` arrives with the ad-side columns in SOV.2. */
        showDateRange={false}
      />

      <RulesTabs active="share-of-voice" />

      {!isMarket ? (
        // The shared header offers "All markets" on every ads page. Impression share, market volume
        // and market rank are all per-marketplace quantities and there is no honest way to add them,
        // so this says so and hands back the four one-click routes out of it. The endpoint 400s with
        // `market_required` for the same reason.
        <div className="h10-sov-pick">
          <h3>Pick one market</h3>
          <p>
            Market impression share, market volume and market rank are per-marketplace numbers from
            Amazon Brand Analytics — and <i>veste moto homme</i> in France is a different row from
            the same words in Germany. There is no honest way to add them together, so this grid
            needs one market rather than “all”.
          </p>
          <div className="h10-sov-pickrow">
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

          {reach && <p className="h10-sov-said"><b>{reach}</b></p>}

          {/* 🔴 The band. TWO feeds, and they are 15 days apart — a single "last synced" chip would
              be wrong whichever one it named. Age alone is not enough either: 85 rows in a fresh
              week is a worse fact than a two-week-old full one, so the row count against the
              trailing norm is stated beside it.

              Rendered inline, in the shape `<FreshnessChip source=… />` will replace: freshness is
              substrate-owned (spec §4, §6.3) and Phase S has not happened. This is NOT a rival
              freshness endpoint — it is two fields on this page's own read. */}
          {p && f && (
            <p className="h10-sov-band">
              <span className={`h10-sov-feed ${ageClass(p.ageDays)}`}>
                <b>Market data</b>
                {p.asOf ? <> week of {dayMonth(p.asOf)} · {p.ageDays}d old</> : <> none</>}
                {p.asOf && <i title={`${num(p.rows)} Brand Analytics rows in ${market} that week, against about ${num(p.baselineRows)} in a normal week here. The gate needed ${num(p.threshold)}.`}>{num(p.rows)} rows vs {num(p.baselineRows)} normal</i>}
              </span>
              <span className={`h10-sov-feed ${ageClass(f.ads.ageDays)}`}>
                <b>Ad data</b>
                {f.ads.latest ? <> {dayMonth(f.ads.latest)} · {f.ads.ageDays}d old</> : <> none</>}
                <i>not on this grid until SOV.2</i>
              </span>
              <span className="h10-sov-feed">
                <b>Coverage</b>
                {' '}{num(s?.resolved.asinsWithSqpRows ?? 0)} of {num(s?.resolved.asins ?? 0)} scoped ASINs measured this week
                <i title="Brand Analytics is requested for ten ASINs per market per run and the set does not rotate, so a market-share number describes those ASINs and no others.">{num(s?.resolved.asinsWithSqpRowsEver ?? 0)} ever</i>
              </span>
            </p>
          )}

          {/* Every share on the grid comes from ONE week. When the gate could not find a whole one,
              that is the first thing you need to know, because it makes every number below suspect.
              Unlike on the Keyword Tracker this branch IS reachable by hand today: `?weeks=4` puts
              ES and FR on the 26 Jul week, which holds 71 ES rows against a 414-row normal week. */}
          {p?.truncated && p.asOf && (
            <p className="h10-sov-blind">
              <AlertTriangle size={13} />
              <span>
                {p.reason === 'outside-lookback' ? (
                  <>
                    <b>No Brand Analytics week inside the last {p.lookbackDays} days.</b>{' '}
                    This grid is showing the week of {dayMonth(p.asOf)}
                    {p.ageDays != null ? ` — ${p.ageDays} days old` : ''}. Treat every share below as
                    a historical figure, not a current one.
                  </>
                ) : (
                  <>
                    <b>
                      The week of {dayMonth(p.asOf)} is incomplete: {num(p.rows)} rows where a normal{' '}
                      {market} week holds about {num(p.baselineRows)}.
                    </b>{' '}
                    No week inside the last {p.lookbackDays} days carried at least{' '}
                    {Math.round(p.completenessRatio * 100)}% of that, so this is the best there is.
                    Every share below is measured against however many of our ASINs the feed happened
                    to cover, so a low number may be a coverage gap and not a loss.{' '}
                    {p.weeks !== DEFAULT_WEEKS && (
                      <button type="button" className="lnk" onClick={() => push({ weeks: String(DEFAULT_WEEKS) })}>
                        Look back {DEFAULT_WEEKS} weeks instead
                      </button>
                    )}
                  </>
                )}
              </span>
            </p>
          )}

          {/* 🔴 The portfolio grain has a hole in it and a portfolio-scoped view must not look
              complete: only 72 of 220 campaigns account-wide carry a portfolioId. */}
          {s?.boundBy === 'portfolio' && s.resolved.campaignsWithoutPortfolio > 0 && (
            <p className="h10-sov-blind">
              <AlertTriangle size={13} />
              <span>
                <b>This portfolio view cannot see {num(s.resolved.campaignsWithoutPortfolio)} of the{' '}
                {num(s.resolved.campaignsInMarket)} {s.market} campaigns.</b>{' '}
                They carry no portfolio id, so no portfolio-scoped view reaches them, and their ASINs
                are excluded from every share below.
              </span>
            </p>
          )}

          {/* A scope that resolves to zero measurable ASINs is a rendered state naming which pair
              conflicts — never a silently empty grid. Measured: IT portfolio 190601227863497 holds
              40 ASINs and Brand Analytics reports on none of them. */}
          {(emptyScope || noAsins) && (
            <p className="h10-sov-blind">
              <AlertTriangle size={13} />
              <span>
                {noAsins ? (
                  <>
                    <b>This scope advertises no ASINs in {market}.</b> The {s!.boundBy} you picked and
                    the {market} market do not overlap, so there is nothing to measure a share for.
                  </>
                ) : (
                  <>
                    <b>Brand Analytics reports on none of this scope’s {num(s!.resolved.asins)} ASINs.</b>{' '}
                    The queries below are the {market} market’s — every one of them is real — but this{' '}
                    {s!.boundBy} cannot be measured against them. Amazon returns Brand Analytics for
                    ten ASINs per market per run and the set does not rotate, so this is a reporting
                    gap, not an absence of demand.
                  </>
                )}
              </span>
            </p>
          )}

          {s?.list && (
            <p className="h10-sov-note">
              <Info size={13} />
              <span>
                Filtered to <b>“{s.list.name}”</b> — {num(s.list.terms)} term{s.list.terms === 1 ? '' : 's'}
                {s.list.source ? <>, {LIST_SOURCE[s.list.source] ?? s.list.source}</> : null}. The list
                belongs to <b>Keyword Tracker</b>, which owns it; this page only reads it.{' '}
                <button type="button" className="lnk" onClick={() => push({ list: 'all' })}>Show the whole market instead</button>
              </span>
            </p>
          )}

          {s?.listRejected && (
            <p className="h10-sov-blind">
              <AlertTriangle size={13} />
              <span>
                <b>That link points at another market’s watchlist.</b> A list belongs to one
                marketplace, because volume, rank and share are per-marketplace numbers. Switch the
                market in the header to open it, or pick a {market} list in the toolbar.
              </span>
            </p>
          )}

          {err && <p className="h10-sov-blind"><AlertTriangle size={13} /><span>{err}</span></p>}

          <AdsDataGrid<Row>
            rows={rows}
            loading={loading}
            rowId={(r) => `${r.marketplace}:${r.query}`}
            noun="Query"
            firstColLabel="Search query"
            renderFirst={(r) => (
              <div className="h10-sov-q">
                <span className="t" title={r.query}>{r.query}</span>
                {r.branded && <span className="bd" title="Contains one of the 10 protected brand terms">brand</span>}
                {r.onList && <span className="ls" title="On this market’s Keyword Tracker watchlist">watched</span>}
              </div>
            )}
            firstSortValue={(r) => r.query}
            columns={columns}
            defaultSort={{ key: sort === 'query' ? '__first' : sort, dir }}
            /* BID.S0 landed `onSortChange` on the shared grid (313828494), so a header click reaches
               the URL. Before it, `?sort=` was linkable inward and unlinkable outward on all nine
               pages that render this grid. `__first` is the grid's key for the first column. */
            onSortChange={(next) => push({ sort: next ? (next.key === '__first' ? 'query' : next.key) : '', dir: next?.dir ?? '' })}
            selectable={false}
            customizable={false}
            /* The grid's own search box is deliberately OFF: it keeps its text in local state with
               no callback out, so it could not write `?q=`. One search box, in the toolbar, whose
               value is the URL. */
            searchable={false}
            pagerCentered
            storageKey="nexus.sov.cols"
            toolbarLeft={(
              <span className="h10-sov-tools">
                <span className="h10-sov-search">
                  <Search size={13} />
                  <input
                    value={qDraft}
                    onChange={(e) => setQDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') push({ q: qDraft.trim() }) }}
                    onBlur={() => { if (qDraft.trim() !== q) push({ q: qDraft.trim() }) }}
                    placeholder="Search queries…"
                    aria-label="Search queries"
                  />
                  {q && <button type="button" className="x" onClick={() => { setQDraft(''); push({ q: '' }) }} aria-label="Clear search">×</button>}
                </span>

                {/* Not decoration: with ONE period rendered, this decides WHICH. At 4 weeks ES and
                    FR have no complete week inside the bound and both fall to the truncated-week
                    branch. It moves the share columns and says so. */}
                <span className="h10-sov-weeks">
                  <span className="cap" title="How far back this view may reach for the one week it renders. It moves the share column only — the ad-side columns arrive in SOV.2 with their own daily control.">Share weeks</span>
                  <span className="h10-svt-seg" role="tablist" aria-label="Lookback in weeks">
                    {WEEKS.map((w) => (
                      <button
                        key={w} type="button" role="tab" aria-selected={weeks === w}
                        className={`seg ${weeks === w ? 'on' : ''}`}
                        onClick={() => push({ weeks: String(w) })}
                      >{w}</button>
                    ))}
                  </span>
                </span>

                <button
                  type="button"
                  className={`h10-sov-toggle ${branded ? 'on' : ''}`}
                  onClick={() => push({ branded: branded ? '0' : '1' })}
                  title="Our own brand terms flatter every share number on this page — xavia measures 5.45% against a market volume of 3 — so they are excluded by default"
                >
                  Brand terms: {branded ? 'included' : 'excluded'}{data ? ` (${num(data.facets.branded)})` : ''}
                </button>

                {/* The watchlist as a FILTER, not the population — the inverse of Keyword Tracker.
                    Offered only where the market has a list to filter by. */}
                {(data?.facets.byList.length ?? 0) > 0 && (
                  <select
                    className="h10-sov-listsel"
                    aria-label="Filter by watchlist"
                    value={s?.list?.id ?? 'all'}
                    onChange={(e) => push({ list: e.target.value })}
                  >
                    <option value="all">All market queries</option>
                    {data!.facets.byList.map((l) => (
                      <option key={l.id} value={l.id}>{l.name} · {num(l.terms)} terms</option>
                    ))}
                  </select>
                )}
              </span>
            )}
            toolbarRight={p ? (
              <span className="h10-sov-win">
                {c && (
                  <i title={`${num(c.measured)} measured · ${num(c.notCovered)} outside Brand Analytics coverage · ${num(c.noRowThisPeriod)} with no row this week · ${num(c.neverMeasured)} never measured · ${num(c.realZeros)} real zeros`}>
                    {num(c.measured)}/{num(c.total)} measured
                  </i>
                )}
                {p.asOf && (
                  <i
                    className={p.truncated ? 'bad' : undefined}
                    title={
                      `${num(p.rows)} rows in ${market} that week, against a ${num(p.baselineRows)}-row normal week`
                      + ((p.rejected?.length ?? 0) ? `. Skipped ${p.rejected.length} newer week(s) that were too thin: ${p.rejected.map((x) => `${x.start} (${x.rows} rows)`).join(', ')}` : '')
                    }
                  >
                    week of {dayMonth(p.asOf)}
                  </i>
                )}
              </span>
            ) : undefined}
            emptyNode={(
              <span className="h10-sov-empty">
                {q ? (
                  <>
                    <b>No query in {market} matches “{q}”.</b>
                    <span>
                      This grid holds the {num(data?.scope.resolved.queries ?? 0)} queries Brand
                      Analytics reported for {market} in the week it renders.{' '}
                      <button type="button" className="lnk" onClick={() => { setQDraft(''); push({ q: '' }) }}>Clear the search</button>
                    </span>
                  </>
                ) : s?.list ? (
                  <>
                    <b>No term on “{s.list.name}” appears in the {market} market this week.</b>
                    <span>
                      A watchlist is a filter here, not the population.{' '}
                      <button type="button" className="lnk" onClick={() => push({ list: 'all' })}>Show the whole market</button>
                    </span>
                  </>
                ) : (
                  <>
                    <b>
                      Brand Analytics reported no query for {market}
                      {p?.asOf ? <> in the week of {dayMonth(p.asOf)}</> : null}.
                    </b>
                    <span>
                      That is an absence of measurement, not a zero share. This grid renders one week
                      at a time so its rows can be compared with each other.
                    </span>
                  </>
                )}
              </span>
            )}
            reportLabel={p?.asOf ? `Brand Analytics · week of ${dayMonth(p.asOf)}${p.ageDays != null ? ` · ${p.ageDays} days old` : ''}` : undefined}
          />
        </>
      )}
    </div>
  )
}
