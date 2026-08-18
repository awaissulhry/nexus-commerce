'use client'

/**
 * ⛔ PARKED 2026-08-18 (U3) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the whole 14-block market-share report — one-market gate · filter bar · reach sentence · three-feed freshness band · the rejection reckoning ("a newer week exists and this page is not showing it") · override banner · summary strip · coverage note · signal chips (outbid · weak relevance · cannibalized · unbid demand) · the query grid with saved views, share-weeks and ad-window segments, brand toggle and watchlist.
 * Why it left: the Share of Voice tab is now Helium 10's shape — one rules grid and nothing else
 *   (`SovRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.9, §7.4).
 * Candidate home: **Analytics › Coverage** — it already owns SOV-flavoured columns and is where market share belongs.
 *
 * Nothing here was changed and no endpoint was retired (`/share-of-voice-page` and its row route are
 * still served). The file stays at this path on purpose: re-mounting it is one import.
 * Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

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
import { AdsFilterBar } from '../../campaigns/_grid/AdsFilterBar'
import { buildScopeFilters, scopeToFilterState, type ScopeOptionsPayload, type ScopeValue as KtScope } from '../_shared/scopeFilters'
import { useMergedFilters } from '../_shared/useMergedFilters'
import { SovRowDrawer } from './SovRowDrawer'
import { buildSovCsv, sovCsvFilename } from './sovExport'
import { SovSavedViews } from './SovSavedViews'
import { useAdsSync } from '../_shared/adsBus'

/** The four production Amazon Ads markets. IE/NL/PL/SE/UK are sandbox and hold no listings. */
const MARKETS = ['IT', 'DE', 'ES', 'FR']
const DEFAULT_MARKET = 'IT'
/** How far back the view may reach for its ONE period, in weeks. See the service's `SOV_WEEKS`. */
const WEEKS = [4, 8, 13] as const
const DEFAULT_WEEKS = 8

type RowState = 'measured' | 'not-covered' | 'no-row-this-period' | 'never-measured'
/**
 * SOV.1 — the Δ's own state, on its own axis. A row is `measured` for share and `delta-no-prior`
 * for its Δ at the same time, so this cannot be a fifth `RowState`. Measured on prod: a comparable
 * prior week exists for only 18–28% of rows, so the REASON a Δ is blank is most of what the column
 * says.
 */
type DeltaState = 'delta-measured' | 'delta-no-prior' | 'delta-not-applicable'

interface Row {
  query: string
  marketplace: string
  marketVolume: number | null
  marketRank: number | null
  marketImpressions: number | null
  ourImpressions: number | null
  /** 0..1, or null. null and 0 mean different things and are never rendered the same way. */
  share: number | null
  /** absent (`undefined`) while the API deploy is still rolling — a commit is TWO deploys */
  marketClicks?: number | null
  ourClicks?: number | null
  clickShare?: number | null
  priorShare?: number | null
  /** percentage POINTS, never a percentage of a percentage */
  deltaPt?: number | null
  deltaState?: DeltaState
  /** the market denominator is below the period's median — too small for its share to mean anything */
  lowConfidence?: boolean
  /** the same test on the CLICK denominator, which is two orders of magnitude smaller */
  lowConfidenceClicks?: boolean
  asinsCompeting: number
  state: RowState
  lastSeen: string | null
  lastSeenAgeDays: number | null
  branded: boolean
  asinLike: boolean
  onList: boolean
  /** SOV.2 — the ad side over its OWN daily window. Optional: a commit is two deploys. */
  ad?: {
    impressions: number
    clicks: number
    spendCents: number
    cpcCents: number | null
    spendShare: number | null
    campaigns: number
  } | null
  /** SOV.3 — outbid / weak-relevance / cannibalized, re-cut against medians server-side */
  signals?: string[]
  /** SOV.4 — organic presence, no ad activity, no enabled keyword target */
  unbid?: boolean
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
    /**
     * The week the Δ compares against. `gapDays` is NOT always 7 — see the band.
     *
     * OPTIONAL on purpose: a commit is TWO deploys, and this client can reach production before the
     * API that serves these fields. Marking them optional makes `tsc` refuse any access that would
     * throw in that window, rather than leaving it to be discovered on the live page.
     */
    prior?: {
      asOf: string | null; ageDays: number | null; rows: number; gapDays: number | null
      reason: 'comparable' | 'no-older-period' | 'all-older-excluded'
    }
    excludedPeriods?: Array<{ asOf: string; rows: number; reason: 'all-zero' | 'below-threshold' }>
    /**
     * SOV.6 — the newest period the GATE DECLINED, or null when nothing newer was rejected.
     * Optional for the same deploy-gap reason as `prior`.
     */
    rejection?: {
      asOf: string; ageDays: number | null; rows: number; threshold: number
      shortBy: number; pctOfBar: number | null; asins: number; chosenAsins: number
      count: number; others: Array<{ asOf: string; rows: number }>
    } | null
    /** SOV.6 — `?period=`: what was overridden, or why an override was refused */
    override?: {
      active: string | null
      refused: 'malformed' | 'not-in-market' | null
      gateAsOf: string | null
      belowBar: boolean
      pctOfBar: number | null
      asins: number
    }
    available?: Array<{ asOf: string; rows: number; asins: number }>
  }
  freshness: {
    sqp: { latest: string | null; ageDays: number | null }
    ads: { latest: string | null; ageDays: number | null }
  }
  census: {
    total: number; measured: number; noRowThisPeriod: number; neverMeasured: number
    notCovered: number; realZeros: number; noMarketTotal: number
    deltaMeasured?: number; deltaNoPrior?: number
    lowConfidence?: number; lowConfidenceClicks?: number
    /** SOV.3/4 — counted BEFORE the signal/view narrowing, so each chip states what it delivers */
    outbid?: number; weakRelevance?: number; cannibalized?: number; unbid?: number
    withAdActivity?: number
  }
  /** the scope-level Δ, over the intersection of both weeks only. Optional — see `prior`. */
  scopeDelta?: {
    queries: number; nowShare: number | null; priorShare: number | null
    deltaPt: number | null; withoutPrior: number
  }
  /** the weighted / median pair. Neither ever ships alone — the gap between them IS the finding. */
  shareSummary?: {
    queries: number; ourImpressions: number; marketImpressions: number
    weighted: number | null; medianQuery: number | null
  }
  /** why cart-add and purchase share are a stated line rather than two permanently empty columns */
  funnelCoverage?: { queries: number; clicks: number; cartAdds: number; purchases: number }
  confidenceFloor?: number
  confidenceFloorClicks?: number
  facets: {
    branded: number; asinLike: number
    byList: Array<{ id: string; name: string; terms: number; isDefault: boolean; source: string }>
  }
  rows: Row[]
  total: number
  /** SOV.2 — the ad columns' own window, so headers can carry it. Optional across the deploy gap. */
  adWindowDays?: number
}

const num = (n: number) => n.toLocaleString('en-IE')
/**
 * A share is 0..1 from Brand Analytics. Two decimals of a percent — 0.07% and 2.19% are both real.
 *
 * 🔴 `<0.01%` rather than `0.00%` for a small non-zero share. Found by looking at the deployed page,
 * not by reading the code: `gilet refrigerante` holds **2 impressions of 93,869** (0.0000213) and
 * `hugo boss uomo` **1 of 48,699**, and `toFixed(2)` rendered both as `0.00%` — the same string a
 * genuine zero produces. That is the exact collapse this whole column exists to prevent, sneaking
 * back in one layer above the API that so carefully refuses to make it: "we are barely present" and
 * "we hold none of this market" are different findings and must never share a rendering.
 */
const sharePct = (v: number) => (v > 0 && v * 100 < 0.005 ? '<0.01%' : `${(v * 100).toFixed(2)}%`)
/**
 * 🔴 The SAME guard, on the Δ. A formatter can reintroduce a collapse the data layer refuses to
 * make, and this is the second place it would have: measured on prod, the smallest non-zero |Δ| is
 * **0.0015pt** in IT, 0.0029 in DE and 0.0032 in FR — every one of which `toFixed(2)` renders as
 * `0.00pt`, the exact string a genuine "no change" produces. A movement that rounds away is still a
 * movement, and it must not be dressed as stillness.
 */
const deltaPt = (v: number) => {
  if (v === 0) return '0.00pt'
  const sign = v > 0 ? '+' : '−'
  const abs = Math.abs(v)
  return abs < 0.005 ? `${sign}<0.01pt` : `${sign}${abs.toFixed(2)}pt`
}
/**
 * The colour band for a share, calibrated against this account's MEASURED distribution rather than
 * a 0–100% ramp or Pacvue's 10% ceiling alone.
 *
 * Measured 2026-08-12 across the four default views: p50 IT 1.80% · DE 1.34% · ES 2.35% · FR 0.54%;
 * p90 4.76% / 4.76% / 4.92% / 4.44%; and above 10% there are 5 rows in IT, 1 in ES and 0 in DE/FR.
 * So the resolution has to live between 0 and ~5%, with a distinct treatment for the rare row above
 * 10%. Pacvue's "84 brands compete for the top 10 keywords, none exceeding 10% paid SOV" is
 * corroborated by that ceiling — it just cannot be the whole scale.
 */
const shareBand = (v: number) => (v >= 0.10 ? 'b5' : v >= 0.05 ? 'b4' : v >= 0.02 ? 'b3' : v >= 0.005 ? 'b2' : 'b1')
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
   * SOV.2–SOV.5 (2026-08-15) — the four reserved params are LIVE:
   *   ?adWindow=7|14|30      SOV.2 — the ad-side columns' OWN daily window ('7d' spellings accepted).
   *                          Two grains on one page, each labelled; one control never moves both.
   *   ?view=unbid            SOV.4 — organic presence we never buy.
   *   ?signal=outbid|weak-relevance|cannibalized   SOV.3 — re-cut against medians.
   *   ?row=<query>@<market>  SOV.5 — the detail drawer (the @market half makes a pasted link
   *                          self-contained; absent, the page's market is used).
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
  /**
   * SOV.6 — `?period=`. A deliberate look at a week the gate declined.
   * 🔴 Never defaulted, never remembered, never pre-selected: the gate's choice is the honest
   * default and this is an override you have to ask for, by name, in the URL.
   */
  const period = params.get('period') ?? ''
  const sort = params.get('sort') ?? 'volume'
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc'
  // SOV.2/3/4/5 — the four params that were reserved. Unknown values fall back to defaults.
  const adWindowRaw = Number((params.get('adWindow') ?? '').replace(/d$/i, ''))
  const adWindow = [7, 14, 30].includes(adWindowRaw) ? adWindowRaw : 30
  const signalRaw = params.get('signal') ?? ''
  const signal = ['outbid', 'weak-relevance', 'cannibalized'].includes(signalRaw) ? signalRaw : ''
  const view = params.get('view') === 'unbid' ? 'unbid' : ''
  const rowParam = params.get('row') ?? ''

  // RT.1 — this page had no refetch handle at all: its one fetch was a `useEffect` keyed only on
  // URL params, so nothing short of a navigation could re-read it. The tick is the handle.
  const [reloadTick, setReloadTick] = useState(0)
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
        || (k === 'adWindow' && Number(v) === 30)
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
    if (period) qs.set('period', period)
    // SOV.2/3/4 — the ad window rides always (the columns need their label even at the default);
    // signal and view only when narrowing.
    qs.set('adWindow', String(adWindow))
    if (signal) qs.set('signal', signal)
    if (view) qs.set('view', view)
    void fetch(`${getBackendUrl()}/api/advertising/share-of-voice-page?${qs.toString()}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Could not load Share of Voice (${r.status})`)
        return r.json()
      })
      .then((d) => { if (alive) { setData(d as Payload); setErr(null) } })
      .catch((e) => { if (alive) { setErr((e as Error).message); setData(null) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [market, isMarket, scope.line, scope.portfolio, scope.campaign, list, branded, weeks, q, period, sort, dir, adWindow, signal, view, reloadTick])

  // RT.1 — your own writes, from any tab, applied silently. This page does NOT poll a cursor: its
  // market side is a weekly Brand Analytics period rendering 24–31 days old, so a 45s poll could
  // only ever report "nothing changed". A watchlist edit, though, is instant and yours.
  useAdsSync(['ads.keyword.changed'], () => setReloadTick((n) => n + 1))

  const rows = data?.rows ?? []
  const s = data?.scope

  // FB.2 — the three grains, as filters in the merged bar. This page's server reports most-specific-
  // wins as `boundBy`; 'market' means nothing narrower was picked.
  const scopeFilters = useMemo(
    () => buildScopeFilters({
      options, market, value: scope,
      boundBy: s?.boundBy && s.boundBy !== 'market' ? s.boundBy : null,
    }),
    [options, market, scope.line, scope.portfolio, scope.campaign, s?.boundBy],
  )
  const urlValues = useMemo(
    () => scopeToFilterState(scope),
    [scope.line, scope.portfolio, scope.campaign],
  )
  const onScopeUrlChange = useCallback((next: Record<string, string>) => {
    push({ line: next.__line ?? '', portfolio: next.__portfolio ?? '', campaign: next.__campaign ?? '' })
  }, [push])
  const { filterState, setFilterState } = useMergedFilters({ urlValues, onUrlChange: onScopeUrlChange })
  const p = data?.period
  const f = data?.freshness
  const c = data?.census
  const sd = data?.scopeDelta
  const ss = data?.shareSummary
  const fc = data?.funnelCoverage
  const rj = data?.period.rejection
  const ov = data?.period.override

  /**
   * 🔴 The sort discipline has to be expressed in `sortValue`, not only server-side.
   *
   * Found by looking at the deployed page: the service ranks low-confidence rows last and
   * `AdsDataGrid` then **re-sorts client-side from `sortValue`**, which threw that ordering away —
   * `sappnetta knee spider nero` (50.00% of FOUR market impressions) was still the first row, muted
   * but first. The server was right and the grid overruled it.
   *
   * A single scalar cannot say "last in whichever direction you are sorting", because the meaning of
   * "last" flips. So the penalty reads the direction from the URL — the same `dir` the grid was
   * seeded with — and pushes low-confidence rows to the far end of it. `1000` is beyond any share
   * (0..1) or Δ (percentage points), so it dominates without distorting the order within each group.
   */
  const sink = useCallback(
    (v: number, low: boolean | undefined) => (low ? v + (dir === 'desc' ? -1000 : 1000) : v),
    [dir],
  )

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
          // 🔴 The colour band, and the low-confidence override. Calibrated against this
          // account's MEASURED distribution, not a 0–100% ramp: IT p50 is 1.80%, p90 4.76%, and
          // only 5 of 480 rows clear 10% — a linear 0–100% scale renders the page one flat colour.
          // A low-confidence row is muted REGARDLESS of its value, because `sappnetta knee spider
          // nero` at 50.00% is 2 impressions of 4 and must never be the brightest thing on screen.
          return (
            <span
              className={`h10-sov-share ${r.lowConfidence ? 'thin' : shareBand(r.share)}`}
              title={r.lowConfidence
                ? `${num(r.ourImpressions ?? 0)} of only ${num(r.marketImpressions ?? 0)} market impressions — below this week's median of ${num(Math.round(data?.confidenceFloor ?? 0))}, so this percentage is too small a sample to rank by.`
                : `${num(r.ourImpressions ?? 0)} of ${num(r.marketImpressions ?? 0)} market impressions`}
            >
              {sharePct(r.share)}
            </span>
          )
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
      sortValue: (r) => sink(r.share ?? -1, r.lowConfidence),
      filterValue: (r) => (r.share ?? 0) * 100,
    },
    {
      key: 'delta', label: 'Δ vs prior week',
      tip: 'The change in market impression share against the nearest COMPARABLE earlier week, in percentage points — 1.71% to 1.83% is +0.12pt, not "+7%". Most rows have no comparable prior week: Brand Analytics reports on a fixed ten ASINs per market and the queries they surface change week to week.',
      render: (r) => {
        // Four rows in five have no Δ, so the REASON is most of what this column says. Three
        // renderings, never one blank standing for all of them.
        if (r.deltaState === 'delta-measured' && r.deltaPt != null) {
          const dir = r.deltaPt > 0 ? 'up' : r.deltaPt < 0 ? 'down' : 'flat'
          return (
            <span
              className={`h10-sov-delta ${dir}${r.lowConfidence ? ' thin' : ''}`}
              title={`${sharePct(r.priorShare ?? 0)} in the week of ${p?.prior?.asOf ? dayMonth(p.prior.asOf) : '—'} → ${sharePct(r.share ?? 0)} now`}
            >
              {deltaPt(r.deltaPt)}
            </span>
          )
        }
        if (r.deltaState === 'delta-no-prior') {
          return (
            <span
              className="h10-sov-nm"
              title={`This query is measured this week but has no row in ${p?.prior?.asOf ? `the week of ${dayMonth(p.prior.asOf)}` : 'the comparable prior week'}, so there is nothing to compare it against. Not a zero change.`}
            >
              no prior week
            </span>
          )
        }
        return <span className="h10-sov-nd">—</span>
      },
      sortValue: (r) => sink(r.deltaPt ?? Number.NEGATIVE_INFINITY, r.lowConfidence),
      filterValue: (r) => r.deltaPt ?? 0,
    },
    {
      key: 'clickShare', label: 'Click share',
      tip: 'Of everyone who clicked ANY result for this query, the fraction who clicked us. Beside impression share it answers the one question impression share cannot: we are on the page — are we being chosen? A query with 2% impression share and 0.5% click share is a creative or price problem; 2% and 4% is a bidding opportunity.',
      render: (r) => {
        if (r.state !== 'measured') return <span className="h10-sov-nd">—</span>
        // 🔴 `undefined` and `null` are not the same thing HERE either, for one deploy's worth of
        // time: `undefined` means this client is newer than the API serving it (a commit is TWO
        // deploys), `null` means Amazon reported no market clicks to divide by. Rendering the
        // deploy gap as "no market clicks" would be the page stating a fact it does not have.
        if (r.clickShare === undefined) return <span className="h10-sov-nd">—</span>
        if (r.clickShare === null) {
          return <span className="h10-sov-nm" title="Amazon reported no market clicks for this query in this week, so there is nothing to divide by. This is not a zero share.">no market clicks</span>
        }
        // 🔴 Its OWN confidence flag. The click denominator is two orders of magnitude below the
        // impression one — IT's median is 17 clicks against 370 impressions — so the impression
        // flag would leave "25.00% click share" (1 of 4) looking authoritative.
        return (
          <span
            className={`h10-sov-share ${r.lowConfidenceClicks ? 'thin' : shareBand(r.clickShare)}`}
            title={r.lowConfidenceClicks
              ? `${num(r.ourClicks ?? 0)} of only ${num(r.marketClicks ?? 0)} market clicks — below this week's median of ${num(Math.round(data?.confidenceFloorClicks ?? 0))}, so this percentage is too small a sample to rank by.`
              : `${num(r.ourClicks ?? 0)} of ${num(r.marketClicks ?? 0)} market clicks`}
          >
            {r.clickShare === 0 ? '0.00%' : sharePct(r.clickShare)}
          </span>
        )
      },
      sortValue: (r) => sink(r.clickShare ?? -1, r.lowConfidenceClicks),
      filterValue: (r) => (r.clickShare ?? 0) * 100,
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
    // ── SOV.2 — the AD side, on its OWN daily window. The label carries the window so the two
    //    grains on this page can never be read as one; a dash means no ad activity, a fact. ──
    {
      key: 'adSpend', label: `Ad spend · ${data?.adWindowDays ?? 30}d`, unit: '€',
      tip: `What the scoped campaigns spent buying this query over the last ${data?.adWindowDays ?? 30} days (search-term report, ~2 days behind — a different clock from the weekly market columns). The hover carries impressions, clicks and this query's share of the scope's ad spend.`,
      render: (r) => (r.ad == null
        ? <span className="h10-sov-nd" title="No ad activity on this query in the window — a fact, not missing data.">—</span>
        : <span title={`${num(r.ad.impressions)} ad impressions · ${num(r.ad.clicks)} clicks · ${r.ad.spendShare != null ? `${(r.ad.spendShare * 100).toFixed(1)}% of this scope's ad spend` : 'share of spend unavailable'} · ${r.ad.campaigns} campaign${r.ad.campaigns === 1 ? '' : 's'}`}>€{(r.ad.spendCents / 100).toFixed(2)}</span>),
      sortValue: (r) => r.ad?.spendCents ?? -1,
      filterValue: (r) => (r.ad?.spendCents ?? 0) / 100,
    },
    {
      key: 'adCpc', label: `Ad CPC · ${data?.adWindowDays ?? 30}d`,
      tip: 'Spend ÷ clicks on this query in the ad window. Blank when there were no clicks — never €0.00.',
      render: (r) => (r.ad?.cpcCents == null ? <span className="h10-sov-nd">—</span> : `€${(r.ad.cpcCents / 100).toFixed(2)}`),
      sortValue: (r) => r.ad?.cpcCents ?? -1,
    },
    // ── SOV.3 — the judgement, re-cut against medians server-side. ──
    {
      key: 'signal', label: 'Signal', metric: false,
      tip: 'outbid = above-median CPC and below-median ad impressions (probably losing the auction) · weak = we show and are not clicked (CTR under half the median on ≥50 impressions) · cannibalized = two or more of our campaigns buying the same query. Re-cut against MEDIANS — the old mean-based bar fired on 32% of the account.',
      render: (r) => {
        const sg = r.signals ?? []
        if (r.unbid) return <span className="h10-sov-sig unbid" title="We appear organically on this query and never buy it: no ad activity in the window and no enabled keyword target.">unbid</span>
        if (sg.length === 0) return <span className="h10-sov-nd">—</span>
        return (
          <span className="h10-sov-sigs">
            {sg.map((s) => <span key={s} className={`h10-sov-sig ${s === 'weak-relevance' ? 'weak' : s}`}>{s === 'weak-relevance' ? 'weak' : s}</span>)}
          </span>
        )
      },
      sortValue: (r) => (r.unbid ? 'unbid' : (r.signals ?? []).join(',')),
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
  ], [p?.asOf, p?.ageDays, data?.confidenceFloor, data?.confidenceFloorClicks, data?.adWindowDays, sink])

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

  /**
   * SOV.6 — the export. `AdsDataGrid` already owns the button (`exportable` + `onExport`), so this
   * supplies only the file. See `sovExport.ts` for why the header block is the substance.
   *
   * 🔴 It exports the FULL FILTERED SET, not the page on screen: the read requests one page of
   * 2,000 and the grid pages locally, so `data.rows` IS every row in scope. `rowsExported` vs
   * `rowsInScope` goes into the header regardless, so the file says so if that ever stops being
   * true rather than quietly shipping one page and calling it a scope.
   */
  const onExport = useCallback(() => {
    if (!data || !p) return
    const csv = buildSovCsv(data.rows, {
      market,
      periodAsOf: p.asOf, periodAgeDays: p.ageDays, periodRows: p.rows,
      periodThreshold: p.threshold, periodBaseline: p.baselineRows, periodComplete: !p.truncated,
      overrideActive: ov?.active ?? null, overridePctOfBar: ov?.pctOfBar ?? null,
      rejectionAsOf: rj?.asOf ?? null, rejectionRows: rj?.rows, rejectionShortBy: rj?.shortBy,
      adWindowDays: adWindow, adLatest: f?.ads.latest ?? null, adAgeDays: f?.ads.ageDays ?? null,
      priorAsOf: p.prior?.asOf ?? null, priorGapDays: p.prior?.gapDays ?? null,
      scopeLabel: reach ?? market,
      campaignsResolved: s?.resolved.campaigns ?? 0,
      campaignsInMarket: s?.resolved.campaignsInMarket ?? 0,
      asins: s?.resolved.asins ?? 0,
      asinsWithRows: s?.resolved.asinsWithSqpRowsEver ?? 0,
      filters: Object.fromEntries(
        Object.entries({
          list, branded: branded ? '1' : '0', kind: params.get('kind') ?? '', signal, view, q,
          weeks: String(weeks), period: ov?.active ?? '',
        }).filter(([, v]) => v && v !== 'all'),
      ) as Record<string, string>,
      rowsExported: data.rows.length,
      rowsInScope: data.total,
    })
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const el = document.createElement('a')
    el.href = URL.createObjectURL(blob)
    el.download = sovCsvFilename(market, p.asOf)
    el.click()
    URL.revokeObjectURL(el.href)
  }, [data, p, ov, rj, f, s, market, adWindow, list, branded, params, signal, view, q, weeks, reach])

  /**
   * A scope that can measure nothing is a RENDERED state naming which pair conflicts — never a
   * silently empty grid.
   *
   * 🔴 Keyed on `census.measured === 0`, not on `asinsWithSqpRowsEver === 0`. Measured on prod:
   * portfolio "IT AIREON" holds 40 ASINs of which **2 have a Brand Analytics row ever and 0 in the
   * week the grid renders**, so an `ever`-based test stayed silent on a view where all 480 rows read
   * "outside coverage". The question the sentence answers is "can this view measure anything", and
   * that is a fact about the rendered week.
   */
  const noAsins = !!s && !loading && s.resolved.asins === 0
  const emptyScope = !!s && !!c && !loading && !noAsins && c.total > 0 && c.measured === 0

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
          {/* FB.2 — ONE bar. The portfolio blind-spot note travelled with it: it is a fact about the
              grain in use, so it belongs under the control that chose the grain. */}
          <AdsFilterBar
            filters={scopeFilters}
            value={filterState}
            onChange={setFilterState}
            defaultOpen
            notesSlot={s?.boundBy === 'portfolio' && s.resolved.campaignsWithoutPortfolio > 0 ? (
              <p className="h10-ra-note bad">
                <AlertTriangle size={13} />
                <span>
                  <b>This portfolio view cannot see {num(s.resolved.campaignsWithoutPortfolio)} of the{' '}
                  {num(s.resolved.campaignsInMarket)} {s.market} campaigns.</b>{' '}
                  They carry no portfolio id, so no portfolio-scoped view reaches them, and their ASINs
                  are excluded from every share below.
                </span>
              </p>
            ) : undefined}
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
                <i>the Ad spend / CPC / Signal columns · last {data?.adWindowDays ?? 30} days</i>
              </span>
              <span className="h10-sov-feed">
                <b>Coverage</b>
                {' '}{num(s?.resolved.asinsWithSqpRows ?? 0)} of {num(s?.resolved.asins ?? 0)} scoped ASINs measured this week
                <i title="Brand Analytics is requested for ten ASINs per market per run and the set does not rotate, so a market-share number describes those ASINs and no others.">{num(s?.resolved.asinsWithSqpRowsEver ?? 0)} ever</i>
              </span>
            </p>
          )}

          {/* 🔴 SOV.1 — the pair of numbers, and the scope-level Δ. Both always rendered.
              The weighted figure and the median per-query figure DISAGREE by 1.6–3.8× on this
              account, and the gap is the finding: we hold a couple of percent of hundreds of tiny
              queries and almost nothing of the big ones. Showing only the median would flatter the
              account; showing only the weighted figure would hide where we actually win. */}
            {/* 🔴 SOV.6 — THE REJECTION RECKONING. The page is DECLINING newer data, and until now
                it only said its data was old. Those are different facts and only this one can be
                acted on. Renders ONLY when something newer was actually rejected — a permanent
                "everything is fine" banner is furniture. */}
            {rj && !ov?.active && (
              <p className="h10-sov-decline">
                <AlertTriangle size={13} />
                <span>
                  <b>A newer week exists and this page is not showing it.</b>{' '}
                  The week of <b>{dayMonth(rj.asOf)}</b> ({rj.ageDays}d) holds{' '}
                  <b>{num(rj.rows)} of the {num(rj.threshold)} rows</b> this market's recent weeks
                  average — {rj.pctOfBar}% of the bar, <b>short by {num(rj.shortBy)}</b> — on{' '}
                  <b>{num(rj.asins)} ASINs</b> against {num(rj.chosenAsins)} in the week below.
                  {rj.count > 1 && <> {rj.count - 1} older week{rj.count - 1 === 1 ? '' : 's'} {rj.count - 1 === 1 ? 'was' : 'were'} declined too.</>}
                  {' '}A share from a part-week wearing the same label as a whole one is worse than a
                  blank, so the grid keeps the complete week.{' '}
                  <button type="button" className="lnk" onClick={() => push({ period: rj.asOf })}>
                    Show {dayMonth(rj.asOf)} anyway
                  </button>
                </span>
              </p>
            )}

            {/* The override, marked persistently and unmissably for as long as it is on. */}
            {ov?.active && (
              <p className="h10-sov-override">
                <AlertTriangle size={13} />
                <span>
                  <b>You are looking at {dayMonth(ov.active)}, a week the gate declined.</b>{' '}
                  It holds {num(p?.rows ?? 0)} of {num(p?.threshold ?? 0)} rows
                  {ov.pctOfBar != null && <> — <b>{ov.pctOfBar}% complete</b></>}, on {num(ov.asins)} ASINs.
                  <b> Every share on this view under-reports.</b>{' '}
                  <button type="button" className="lnk" onClick={() => push({ period: '' })}>
                    Back to {ov.gateAsOf ? dayMonth(ov.gateAsOf) : 'the complete week'}
                  </button>
                </span>
              </p>
            )}

            {/* A refused override says so. Never a silent fallback to a week the link does not name. */}
            {ov?.refused && (
              <p className="h10-sov-decline">
                <AlertTriangle size={13} />
                <span>
                  <b>That link asks for a week this market does not have.</b>{' '}
                  {ov.refused === 'malformed'
                    ? <>“{period}” is not a date in <code>YYYY-MM-DD</code> form.</>
                    : <>Brand Analytics has no <b>{period}</b> period for {market}.</>}{' '}
                  Showing {ov.gateAsOf ? dayMonth(ov.gateAsOf) : 'the gate\u2019s choice'} instead, which is
                  what this page would show without the link.{' '}
                  <button type="button" className="lnk" onClick={() => push({ period: '' })}>Clear it</button>
                </span>
              </p>
            )}

          {ss && p && (
            <p className="h10-sov-summary">
              <span className="h10-sov-stat">
                <i>Our share of all measured demand</i>
                <b>{ss.weighted == null ? '—' : sharePct(ss.weighted)}</b>
                <em title={`${num(ss.ourImpressions)} of ${num(ss.marketImpressions)} market impressions across the ${num(ss.queries)} measured queries in this view`}>
                  {num(ss.ourImpressions)} of {num(ss.marketImpressions)}
                </em>
              </span>
              <span className="h10-sov-stat">
                <i>Median query share</i>
                <b>{ss.medianQuery == null ? '—' : sharePct(ss.medianQuery)}</b>
                <em title="The middle row's share. Higher than the weighted figure because our share is concentrated in small queries.">across {num(ss.queries)} queries</em>
              </span>
              {/* The scope Δ names its POPULATION before its value. An intersection is not a
                  filter: comparing this week's total against last week's over two different query
                  sets is a headline number that moves when nothing changed. */}
              <span className="h10-sov-stat">
                <i>
                  Δ vs {p.prior?.asOf ? <>the week of {dayMonth(p.prior.asOf)}</> : 'a prior week'}
                  {p.prior?.gapDays != null && p.prior.gapDays !== 7 && <> ({p.prior.gapDays}d earlier)</>}
                </i>
                {/* 🔴 TWO different reasons a Δ is absent, and they had one message between them
                    until prod showed it: at ?market=FR&weeks=4 the strip read "no comparable prior
                    week" directly beneath a header naming 12 Jul. There IS a prior week there —
                    what is missing is any query measured in both. A page built to stop one blank
                    meaning four things cannot ship one sentence meaning two. */}
                {sd && sd.deltaPt != null ? (
                  <b className={sd.deltaPt > 0 ? 'up' : sd.deltaPt < 0 ? 'down' : undefined}>{deltaPt(sd.deltaPt)}</b>
                ) : p.prior?.asOf ? (
                  <b className="none">no query in both weeks</b>
                ) : (
                  <b className="none">no comparable prior week</b>
                )}
                <em title={sd && sd.queries > 0
                  ? `Computed over the ${num(sd.queries)} queries measured in BOTH weeks within this scope — never across two different query populations. ${num(sd.withoutPrior)} measured queries have no row in the prior week and are excluded from both sides.`
                  : p.prior?.asOf
                    ? `The week of ${dayMonth(p.prior.asOf)} is comparable, but not one of the ${num(c?.measured ?? 0)} queries measured here has a row in it — Brand Analytics reports on a fixed ten ASINs per market and the queries they surface change week to week.`
                    : 'No earlier week is comparable: every older period is either too thin to use or carries a zero our-side count on every row.'}>
                  {sd && sd.queries > 0
                    ? <>{sharePct(sd.priorShare ?? 0)} → {sharePct(sd.nowShare ?? 0)} on {num(sd.queries)} queries in both</>
                    : p.prior?.asOf
                      ? <>0 of {num(c?.measured ?? 0)} measured queries appear in both</>
                      : <>nothing to compare</>}
                </em>
              </span>
            </p>
          )}

          {/* Why two columns are missing. Stated once, in a full sentence, rather than shipped as
              two permanently-`—` columns — an empty column is a promise, a missing one is a
              decision. Cart-adds and purchases are genuinely sparse at query × ASIN × week grain;
              this is NOT the parser defect, because clicks parse fine in the same rows. */}
          {fc && fc.queries > 0 && (
            <p className="h10-sov-note">
              <Info size={13} />
              <span>
                Click data covers <b>{num(fc.clicks)} of {num(fc.queries)}</b> measured queries here.
                Cart-add data exists on <b>{num(fc.cartAdds)}</b> and purchase data on <b>{num(fc.purchases)}</b>,
                so neither is a column — both are in the row drawer instead.
              </span>
            </p>
          )}

          {/* The Δ's baseline skipped a week, and the operator should be told which and why. Today
              this is unreachable — a nearer week always qualifies first — so it is a guard that
              says so if the feed ever stalls into the corrupted May/June range. */}
          {(p?.excludedPeriods?.length ?? 0) > 0 && (
            <p className="h10-sov-note">
              <Info size={13} />
              <span>
                The Δ skipped{' '}
                {p!.excludedPeriods!.map((e, i) => (
                  <span key={e.asOf}>
                    {i > 0 ? ', ' : ''}<b>{dayMonth(e.asOf)}</b>{' '}
                    ({e.reason === 'all-zero'
                      ? `every one of its ${num(e.rows)} rows reports zero impressions for us — a known ingest defect, not a collapse`
                      : `only ${num(e.rows)} rows, too thin to compare against`})
                  </span>
                ))}{' '}and compared against {p!.prior?.asOf ? dayMonth(p!.prior.asOf) : 'nothing'} instead.
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
                    <b>
                      Not one of this {s!.boundBy}’s {num(s!.resolved.asins)} ASINs has a Brand
                      Analytics row in the week of {p?.asOf ? dayMonth(p.asOf) : 'this grid'}
                      {(s!.resolved.asinsWithSqpRowsEver ?? 0) > 0
                        ? ` — ${num(s!.resolved.asinsWithSqpRowsEver)} of them have one in some other week`
                        : ', and none ever has'}.
                    </b>{' '}
                    The {num(c?.total ?? 0)} queries below are the {market} market’s and every one of
                    them is real — but this {s!.boundBy} cannot be measured against them. Amazon
                    returns Brand Analytics for ten ASINs per market per run and the set does not
                    rotate, so this is a reporting gap, not an absence of demand.
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

          {/* SOV.3/4 — the judgement chips. Counts come from the census BEFORE the narrowing
              (their own dimension), so each chip advertises exactly what clicking delivers;
              clicking an active chip clears it. `unbid` is a VIEW, not a signal — organic demand
              we never buy — and it composes with nothing (it replaces the signal narrowing). */}
          {c && (c.outbid != null || c.unbid != null) && (
            <div className="h10-sov-chips" role="group" aria-label="Signals">
              {([['outbid', c.outbid ?? 0, 'Above-median CPC and below-median ad impressions — probably losing the auction. Raise the bid or let it go, but decide.'],
                ['weak-relevance', c.weakRelevance ?? 0, 'We show and are not clicked: CTR under half the median on ≥50 ad impressions. A creative or match-type problem, not a bid problem.'],
                ['cannibalized', c.cannibalized ?? 0, 'Two or more of our campaigns buying the same query — paying to outbid ourselves.']] as const
              ).map(([k, n, tip]) => (
                <button key={k} type="button" className={`h10-sov-chip${signal === k ? ' on' : ''}${n === 0 ? ' zero' : ''}`}
                  aria-pressed={signal === k} title={tip}
                  onClick={() => push({ signal: signal === k ? '' : k, view: '' })}>
                  <b>{num(n)}</b> {k === 'weak-relevance' ? 'weak relevance' : k}
                </button>
              ))}
              <button type="button" className={`h10-sov-chip unbid${view === 'unbid' ? ' on' : ''}${(c.unbid ?? 0) === 0 ? ' zero' : ''}`}
                aria-pressed={view === 'unbid'}
                title="Demand we already appear in organically and never buy: measured presence, no ad activity in the window, no enabled keyword target. Not Keyword Harvest's terms — harvest promotes what we already PAID on; these were never touched."
                onClick={() => push({ view: view === 'unbid' ? '' : 'unbid', signal: '' })}>
                <b>{num(c.unbid ?? 0)}</b> unbid demand
              </button>
              <span className="h10-sov-chipnote">{num(c.withAdActivity ?? 0)} of {num(c.total)} queries carry any ad activity in the {data?.adWindowDays ?? 30}d window</span>
            </div>
          )}

          <AdsDataGrid<Row>
            rows={rows}
            loading={loading}
            rowId={(r) => `${r.marketplace}:${r.query}`}
            noun="Query"
            firstColLabel="Search query"
            renderFirst={(r) => (
              <div className="h10-sov-q">
                {/* SOV.5 — the first column is a real control again: it opens the row drawer.
                    A PUSH, so Back closes; the @market half makes a copied link self-contained. */}
                <button type="button" className="t" title={`${r.query} — open the drawer: every measured week, the funnel, who holds it, who buys it`}
                  onClick={() => {
                    const next = new URLSearchParams(params.toString())
                    next.set('row', `${r.query}@${r.marketplace}`)
                    router.push(`?${next.toString()}`, { scroll: false })
                  }}>{r.query}</button>
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
            exportable
            onExport={onExport}
            toolbarLeft={(
              <span className="h10-sov-tools">
                <SovSavedViews
                  currentQs={params.toString()}
                  onApply={(qs) => router.replace(qs ? `?${qs}` : '?', { scroll: false })}
                />
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
                  <span className="cap" title="How far back this view may reach for the one week it renders. It moves the SHARE columns only — the ad columns have their own daily control beside this one; one control never moves both grains.">Share weeks</span>
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

                {/* SOV.2 — the AD columns' own window. Daily, ~2 days behind, a different clock
                    from the weekly market columns — which is why it is a second control. */}
                <span className="h10-sov-weeks">
                  <span className="cap" title="The window for the Ad spend / Ad CPC / Signal columns, in days. It moves the AD columns only.">Ad window</span>
                  <span className="h10-svt-seg" role="tablist" aria-label="Ad window in days">
                    {[7, 14, 30].map((w) => (
                      <button
                        key={w} type="button" role="tab" aria-selected={adWindow === w}
                        className={`seg ${adWindow === w ? 'on' : ''}`}
                        onClick={() => push({ adWindow: String(w) })}
                      >{w}d</button>
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
                {/* 🔴 The sort floor, STATED. Sorting by a share without it puts `sappnetta knee
                    spider nero` first — 50.00% of four market impressions — while the five queries
                    above 10% share carry 0.01% of the demand. Nothing is hidden; small denominators
                    rank below confident ones and say so. */}
                {c && (sort === 'share' || sort === 'clickShare' || sort === 'delta') && (
                  <i
                    className="floor"
                    title={sort === 'clickShare'
                      ? `Ranked below the rest: ${num(c.lowConfidenceClicks ?? 0)} queries with fewer than ${num(Math.round(data?.confidenceFloorClicks ?? 0))} market clicks — the median for this week. A share of 1 click in 4 is not a share.`
                      : `Ranked below the rest: ${num(c.lowConfidence ?? 0)} queries with fewer than ${num(Math.round(data?.confidenceFloor ?? 0))} market impressions — the median for this week. Their percentages are real but the sample is too small to rank by.`}
                  >
                    {sort === 'clickShare'
                      ? <>below {num(Math.round(data?.confidenceFloorClicks ?? 0))} clicks: ranked last</>
                      : <>below {num(Math.round(data?.confidenceFloor ?? 0))} impressions: ranked last</>}
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

      {/* SOV.5 — the row drawer. `?row=<query>@<market>` makes a pasted link self-contained; a
          missing @market half falls back to the page's market. */}
      {rowParam && (() => {
        const at = rowParam.lastIndexOf('@')
        const rowQuery = at > 0 ? rowParam.slice(0, at) : rowParam
        const rowMarket = at > 0 ? rowParam.slice(at + 1) : market
        return (
          <SovRowDrawer
            query={rowQuery}
            market={rowMarket}
            scope={scope}
            onClose={() => {
              const next = new URLSearchParams(params.toString())
              next.delete('row')
              const qs = next.toString()
              router.replace(qs ? `?${qs}` : '?', { scroll: false })
            }}
          />
        )
      })()}
    </div>
  )
}
