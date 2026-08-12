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
import { AlertTriangle, Info, ListPlus } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { getBackendUrl } from '@/lib/backend-url'
import { KeywordScopeBar, type KtScope, type ScopeOptionsPayload } from './KeywordScopeBar'
import { WatchlistPanel } from './WatchlistPanel'

/** The four production Amazon Ads markets. IE/NL/PL/SE/UK are sandbox and hold no listings. */
const MARKETS = ['IT', 'DE', 'ES', 'FR']
const DEFAULT_MARKET = 'IT'

/**
 * KT.1b — why a row is blank, as three states rather than one.
 *
 * KT.1 rendered "not measured" for both *the feed has never reported this term here* and *the feed
 * has it, just not in the week this view renders*. Measured on prod: DE 89 never-measured against
 * 1 aged out, ES 94 against 2, FR 94 against 3 — four markets printing one string for two problems
 * with two different fixes.
 */
type RowState = 'measured' | 'no-row-this-period' | 'never-measured'

interface Row {
  keyword: string
  marketplace: string
  marketVolume: number | null
  marketRank: number | null
  impressionShare: number | null
  asinsCompeting: number
  asOf: string | null
  asOfAgeDays: number | null
  /** absent while the API deploy is still rolling — a commit is TWO deploys */
  state?: RowState
  lastSeen?: string | null
  lastSeenAgeDays?: number | null
  measured: boolean
  branded: boolean
}

/** Tolerates an API that has not yet rolled out `state` (it would then be a KT.1 response). */
const rowState = (r: Row): RowState => r.state ?? (r.measured ? 'measured' : 'never-measured')

interface Payload {
  scope: {
    market: string
    boundBy: 'market' | 'line' | 'portfolio' | 'campaign'
    line: { id: string; name: string } | null
    portfolio: { id: string; name: string } | null
    campaign: { id: string; name: string } | null
    /** KT.2 — a KeywordWatchlist. `enabled` is gone: it was the coverage engine's arming switch. */
    list: { id: string; name: string; marketplace: string; terms: number; isDefault?: boolean; source?: string } | null
    /** KT.2 — ?list= named a real list belonging to ANOTHER market, and was refused */
    listRejected?: boolean
    resolved: {
      campaigns: number; asins: number; keywordsWatched: number; keywordsMeasured: number
      keywordsNoRowThisPeriod?: number; keywordsNeverMeasured?: number
    }
    unreachable: { campaignsWithoutPortfolio: number; campaignsInMarket: number } | null
  }
  /**
   * KT.1b — `period` is THE week the whole grid renders. `periodsUsed` / `newestAsOf` survive as
   * KT.1 fields so an old client keeps working across the deploy gap; they now always hold 0 or 1
   * entries, which is the whole point of the fix.
   */
  window: {
    lookbackDays: number
    completenessRatio?: number
    baselinePeriods?: number
    period?: string | null
    periodAgeDays?: number | null
    periodRows?: number
    baselineRows?: number
    threshold?: number
    reason?: 'complete' | 'incomplete-week' | 'outside-lookback' | 'no-data'
    truncated?: boolean
    rejected?: Array<{ start: string; rows: number }>
    periodsUsed: Array<{ start: string; terms: number }>
    newestAsOf: string | null
    oldestAsOf: string | null
  }
  freshness: {
    sqp: { latestPeriodStart: string | null; ingestedAt: string | null; ageDays: number | null }
    searchTerm: { latestDate: string | null; ageDays: number | null }
    placement: { latestDate: string | null; ageDays: number | null }
  }
  rows: Row[]
  total: number
  lists: Array<{ id: string; name: string; marketplace: string; isDefault: boolean; source: string; terms: number }>
}

const num = (n: number) => n.toLocaleString('en-IE')
/** A share is 0..1 from SQP. Two decimals of a percent, because 0.7% and 0.04% are both real here. */
const sharePct = (v: number) => `${(v * 100).toFixed(2)}%`
const dayMonth = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}
/** KT.2 — where a list's terms came from, in words, for the line under the scope bar. */
const LIST_SOURCE: Record<string, string> = {
  'coverage-set-import': 'copied from the curated coverage set',
  'bid-keywords': 'the keywords we bid on that Brand Analytics can measure',
  sqp: 'Brand Analytics queries',
  manual: 'added by hand',
  import: 'imported',
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
  // KT.2 — the watchlist editor, and a nonce so any write to it re-reads the grid
  const [editing, setEditing] = useState(false)
  const [reload, setReload] = useState(0)

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
  }, [market, isMarket, scope.line, scope.portfolio, scope.campaign, list, branded, measured, sort, dir, reload])

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
      render: (r) => {
        const st = rowState(r)
        if (st === 'measured') {
          return <span className={`h10-kt-share${r.impressionShare === 0 ? ' zero' : ''}`}>{sharePct(r.impressionShare ?? 0)}</span>
        }
        // Two different blanks. "no row this week" is a coverage gap you can chase; "never
        // measured" is a term Amazon has no data for at all. Same pill, different words.
        return st === 'no-row-this-period'
          ? <span className="h10-kt-nm" title={`The feed has this term in ${r.marketplace}, but not in the week this grid renders${r.lastSeen ? ` — its newest row is the week of ${dayMonth(r.lastSeen)}` : ''}`}>no row this week</span>
          : <span className="h10-kt-nm" title={`Brand Analytics has never reported this term in ${r.marketplace}, at any period`}>never measured</span>
      },
      sortValue: (r) => r.impressionShare ?? -1,
      filterValue: (r) => (r.impressionShare ?? 0) * 100,
    },
    {
      key: 'asOf', label: 'As of', metric: false,
      tip: 'The week this whole grid renders — one period for every row, so two rows can be compared with each other. A blank row shows the last week the feed DID report that term, if there is one.',
      render: (r) => {
        if (r.asOf) return <span className={`h10-kt-age ${ageClass(r.asOfAgeDays)}`}>{dayMonth(r.asOf)}<i>{r.asOfAgeDays}d</i></span>
        // A blank row still states an age when there is one to state: the last week the feed DID
        // report it. Deliberately not bounded by the lookback — a date is worth stating at any age.
        if (r.lastSeen) return <span className="h10-kt-age stale" title="The newest week this term has a row in, at any age">last seen {dayMonth(r.lastSeen)}<i>{r.lastSeenAgeDays}d</i></span>
        return <span className="h10-kt-nd">—</span>
      },
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
    // KT.1b — with one period per view this split is a real, actionable number rather than an
    // artefact of every row shopping for its own week.
    const noRow = s.resolved.keywordsNoRowThisPeriod ?? 0
    if (noRow > 0) bits.push(`${num(noRow)} with no row that week`)
    return bits.join(' · ')
  })()

  /**
   * KT.1b — one period, so one clause. This used to scan the rendered rows for their min and max
   * age, which was both a symptom of the defect (a range implies more than one week) and a latent
   * `Math.min()`-over-nothing → `Infinity` if the page ever showed no measured row.
   */
  const period = data?.window.period ?? data?.window.newestAsOf ?? null
  const periodAge = data?.window.periodAgeDays ?? null
  const shareAge = period
    ? `share from the week of ${dayMonth(period)}${periodAge != null ? ` (${periodAge}d old)` : ''}`
    : null

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

          {/* 🔴 KT.1b — every share on the grid comes from one week. When the gate could not find a
              whole one, that is the first thing you need to know, in a full sentence, because it
              makes every number below it suspect. Untriggered on today's data in all four markets
              (verified by unit test, not by eye — stated in the KT.1b doc entry). */}
          {data?.window.truncated && period && (
            <p className="h10-kt-blind">
              <AlertTriangle size={13} />
              <span>
                {data.window.reason === 'outside-lookback' ? (
                  <>
                    <b>No Brand Analytics week inside the last {data.window.lookbackDays} days.</b>{' '}
                    This grid is showing the week of {dayMonth(period)}
                    {periodAge != null ? ` — ${periodAge} days old` : ''}. Treat every share below as
                    a historical figure, not a current one.
                  </>
                ) : (
                  <>
                    <b>
                      The week of {dayMonth(period)} is incomplete: {num(data.window.periodRows ?? 0)}{' '}
                      rows where a normal {market} week holds about {num(data.window.baselineRows ?? 0)}.
                    </b>{' '}
                    No week inside the last {data.window.lookbackDays} days carried at least{' '}
                    {Math.round((data.window.completenessRatio ?? 0.5) * 100)}% of that, so this is the
                    best there is. Every share below is measured against however many of our ASINs the
                    feed happened to cover, so a low number here may be a coverage gap and not a loss.
                  </>
                )}
              </span>
            </p>
          )}

          {/* KT.2 — the watchlist is this market's own object now. KT.1b's sentence said the list
              was "disabled as a coverage set"; that flag was never a display flag — it arms the
              coverage engine's nightly bid ladder — so the honest line is where the terms came
              from and where arming actually happens. */}
          {s?.list && (
            <p className="h10-kt-note">
              <Info size={13} />
              <span>
                Watching <b>“{s.list.name}”</b> — {num(s.list.terms)} term{s.list.terms === 1 ? '' : 's'}
                {s.list.source ? <>, {LIST_SOURCE[s.list.source] ?? s.list.source}</> : null}. It belongs to
                this page and to <b>{s.list.marketplace}</b> only; nothing automated reads it.
                {' '}<button type="button" className="lnk" onClick={() => setEditing(true)}>Edit the list</button>
              </span>
            </p>
          )}

          {/* 🔴 A market with no list borrows nobody's. This is the state KT.1's `?? sets[0]`
              hid by serving 97 Italian terms to Germany, Spain and France.
              Gated on `!err`: when the read fails, `data` is null and this block would otherwise
              assert "DE has no watchlist" — a fact the page does not have. Measured on prod during
              an API redeploy, next to a "Failed to fetch" banner saying the opposite. */}
          {!s?.list && !loading && !err && (
            <p className="h10-kt-blind">
              <AlertTriangle size={13} />
              <span>
                <b>{market} has no watchlist.</b> Earlier this page would have shown you another
                market’s terms here — measured, only 8 of the 97 Italian terms have ever had a{' '}
                {market === 'DE' ? 'German' : market === 'ES' ? 'Spanish' : market === 'FR' ? 'French' : 'local'} row,
                so those grids were a wrong-list artefact rather than a data gap. Create a list for{' '}
                {market} instead.{' '}
                <button type="button" className="lnk" onClick={() => setEditing(true)}>Create one</button>
              </span>
            </p>
          )}

          {/* ?list= named a real list, but one belonging to another market. */}
          {s?.listRejected && (
            <p className="h10-kt-blind">
              <AlertTriangle size={13} />
              <span>
                <b>That link points at another market’s watchlist.</b> A list belongs to one
                marketplace, because volume, rank and share are per-marketplace numbers. Switch the
                market in the header to open it, or pick a {market} list below.
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

          {editing && (
            <WatchlistPanel
              market={market}
              lists={data?.lists ?? []}
              activeId={s?.list?.id ?? null}
              onClose={() => setEditing(false)}
              onChanged={(selectId) => {
                // a write may have changed which list exists, which is default, or its terms
                if (selectId !== undefined) push({ list: selectId ?? '' })
                setReload((n) => n + 1)
              }}
            />
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
                {/* KT.2 — a real picker, driving ?list=. Rendered as a select only when this market
                    actually has a choice: a one-option dropdown is a control where nothing moves. */}
                {(data?.lists.length ?? 0) > 1 && (
                  <select
                    className="h10-kt-listsel"
                    aria-label="Watchlist"
                    value={s?.list?.id ?? ''}
                    onChange={(e) => push({ list: e.target.value })}
                  >
                    {data!.lists.map((l) => (
                      <option key={l.id} value={l.id}>{l.name} · {num(l.terms)} terms{l.isDefault ? ' · default' : ''}</option>
                    ))}
                  </select>
                )}
                <button type="button" className="h10-kt-toggle" onClick={() => setEditing(true)}>
                  <ListPlus size={12} /> Watchlist
                </button>
              </span>
            )}
            toolbarRight={data?.window ? (
              <span className="h10-kt-win">
                lookback {data.window.lookbackDays}d
                {period && (
                  <i
                    className={data.window.truncated ? 'bad' : undefined}
                    title={
                      data.window.truncated
                        ? `This week is incomplete: ${num(data.window.periodRows ?? 0)} rows against a ${num(data.window.baselineRows ?? 0)}-row normal week`
                        : `${num(data.window.periodRows ?? 0)} rows in ${market} that week, against a ${num(data.window.baselineRows ?? 0)}-row normal week`
                        + ((data.window.rejected?.length ?? 0) ? `. Skipped ${data.window.rejected!.length} newer week(s) that were too thin: ${data.window.rejected!.map((r) => `${r.start} (${r.rows} rows)`).join(', ')}` : '')
                    }
                  >
                    week of {dayMonth(period)}
                  </i>
                )}
              </span>
            ) : undefined}
            emptyNode={(
              <span className="h10-kt-empty">
                {measured === 'no' && (data?.scope.resolved.keywordsMeasured ?? 0) > 0 ? (
                  <b>Every watched term has share data in this scope. Nothing is unmeasured.</b>
                ) : err ? (
                  // The same rule as the banner above: an unreachable API is not an empty watchlist.
                  <>
                    <b>Could not load the tracker.</b>
                    <span>{err} — this says nothing about whether {market} has a watchlist or any data.</span>
                  </>
                ) : (data?.scope.resolved.keywordsWatched ?? 0) === 0 ? (
                  <>
                    <b>{data?.scope.list ? `“${data.scope.list.name}” has no terms to show.` : `${market} has no watchlist.`}</b>
                    <span>
                      {data?.scope.list
                        ? <>Every term on it is one of our own brand terms, which are excluded by default. Include brand terms, or add terms to the list.</>
                        : <>A watchlist belongs to one marketplace. Create one for {market} — nothing on this page falls back to another market’s terms.</>}
                      {' '}<button type="button" className="lnk" onClick={() => setEditing(true)}>{data?.scope.list ? 'Edit the list' : 'Create a list'}</button>
                    </span>
                  </>
                ) : (
                  <>
                    <b>
                      No Brand Analytics row for any watched term in {market}
                      {period ? <> in the week of {dayMonth(period)}</> : null}.
                    </b>
                    <span>
                      {num(data?.scope.resolved.keywordsWatched ?? 0)} terms are being watched, and this
                      grid renders one week at a time so its rows can be compared with each other
                      {period && periodAge != null ? <> — the newest week complete enough to use is {dayMonth(period)}, {periodAge} days old</> : null}.
                      {(data?.scope.resolved.keywordsNoRowThisPeriod ?? 0) > 0
                        ? <> {num(data!.scope.resolved.keywordsNoRowThisPeriod!)} of them have rows in an older week; switch the filter to “Not measured” to see when each was last seen.</>
                        : <> That is an absence of measurement, not a zero share.</>}
                    </span>
                  </>
                )}
              </span>
            )}
            /**
             * 🔴 KT.1b — this printed "Brand Analytics ingested 10 Aug" under data from the week of
             * 19 Jul, because `ingestedAt` is when a row was last re-upserted and the cron
             * re-upserts old weeks nightly. Two statements about the same data, three weeks apart,
             * and this is the one you read without looking for it. It carries the PERIOD now;
             * `ingestedAt` stays in the payload for the feed-health work in KT.5.
             */
            reportLabel={period ? `Brand Analytics · week of ${dayMonth(period)}${periodAge != null ? ` · ${periodAge} days old` : ''}` : undefined}
          />
        </>
      )}
    </div>
  )
}
