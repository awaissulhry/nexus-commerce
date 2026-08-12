'use client'

/**
 * BID.S0 — Bid, promoted from a tab to its own page, with a live read-only grid.
 *
 * The page answers: **what is each target bidding, why is it that number, who decided, and what is
 * it allowed to be.** S0 builds the first quarter of that — what each target is bidding, and what
 * it bought — over the whole account, at two grains, for four markets. The other three quarters are
 * S1–S9 and every one of them is a slot at the bottom of this file.
 *
 * 🔴 **Read-only, and stated rather than implied.** No bid moves from this page in S0. The grid's
 * write-capable props are passed as explicit nulls via `NO_WRITE_ACTIONS`.
 *
 * What replaced the tab: `?tab=bid` used to render `<RuleListTab liveType="bid" />` and nothing
 * else — three columns of rules, and not one bid. The rule list is still here, at the bottom,
 * lifted verbatim and labelled provisional, because flipping the tab to a route must not take
 * anything out of the product. S7 replaces it.
 *
 * ── Four things this page refuses to blur, each one measured ────────────────────────────────────
 *
 *   1. **A blank metric is not a zero.** Only 521 of 2,944 ENABLED targets (17.7%) carry any
 *      30-day performance row and only 274 have a click, so five metric columns are empty on four
 *      rows in five. That is real — those targets were never served — but a grid that renders it
 *      as "—" teaches the operator the page is broken, and then they stop trusting the columns
 *      that ARE populated. Unmeasured rows say "not served"; measured-but-zero rows say 0.
 *   2. **Live is an intersection.** 217 campaigns hold an ENABLED target; 83 are ENABLED campaigns.
 *      1,853 of the 2,944 ENABLED targets sit inside a paused or archived campaign and enter no
 *      auction. The campaign cell says so on every one of them.
 *   3. **The floor population is a clock reading, not a state.** 647 targets sat at ≤5¢ at 00:10
 *      Rome against 141 at 14:00 the previous day — the rank engine floors bids at midnight and
 *      restores them at 08:00. Any count of the bottom band is true for the minute it was read, and
 *      the page says which minute. Labelling the three DIFFERENT kinds of 2¢ keyword is S2/S5's.
 *   4. **A count and its filter must agree.** Every clickable census cell reproduces its own
 *      number, and the facet counts exclude their own dimension so a chip can never advertise rows
 *      it will not return. NEG.1 shipped two cells that failed this and found them by clicking.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, Info, Plus, RefreshCw } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { getBackendUrl } from '@/lib/backend-url'
import { BidScopeBar, type BidScopeValue, type ScopeOptionsPayload } from './BidScopeBar'
import { useCursorPoll } from './useCursorPoll'
import {
  BAND_LABEL, BID_BANDS,
  type BidCampaignRow, type BidGridPayload, type BidTargetRow, type BidView,
} from './types'
import { NO_WRITE_ACTIONS, type BidSlotProps } from './slot-contract'
import { BidSections } from './BidSections'
// Interim, until S7 replaces it: rendered exactly as the tab rendered it, so nothing is lost in the
// move off `?tab=bid`.
import { RuleListTab } from '../tabs/RuleListTab'
import { NoDataIllus } from '../_shared/NoDataIllus'

/** The four production Amazon Ads markets, plus the account-wide view the header already offers. */
const MARKETS = ['IT', 'DE', 'FR', 'ES']
const DEFAULT_MARKET = 'all'
const DEFAULT_STATUS = 'enabled'
const DEFAULT_WINDOW = '30d'

const num = (n: number) => n.toLocaleString('en-IE')
const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`
const pct = (r: number) => `${(r * 100).toFixed(0)}%`
/** A metric that was never measured renders as absence, not as zero. */
const NOT_SERVED = <span className="h10-bd-ns" title="No impressions recorded in this window — this target was never served, which is not the same as earning nothing">not served</span>
const NO_VALUE = <span className="h10-bd-nd" title="Measured, but the denominator is zero — no clicks, or no sales">—</span>

const clockLabel = (iso: string | null) => {
  if (!iso) return null
  const d = new Date(iso)
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })
}

export function BidClient() {
  const router = useRouter()
  const params = useSearchParams()

  // ── the URL contract ──────────────────────────────────────────────────────────────────────────
  // Every view is linkable and an absent param means the default, never a stored preference, so a
  // link renders the same view for whoever opens it.
  const market = params.get('market') ?? DEFAULT_MARKET
  const scope: BidScopeValue = {
    line: params.get('line') ?? '',
    portfolio: params.get('portfolio') ?? '',
    campaign: params.get('campaign') ?? '',
  }
  const view: BidView = params.get('view') === 'campaigns' ? 'campaigns' : 'targets'
  const kind = params.get('kind') ?? ''
  const match = params.get('match') ?? ''
  const band = params.get('band') ?? ''
  const measured = params.get('measured') ?? 'all'
  const status = params.get('status') ?? DEFAULT_STATUS
  const q = params.get('q') ?? ''
  const sortParam = params.get('sort') ?? ''
  const windowParam = params.get('window') ?? DEFAULT_WINDOW

  // 🔴 Reserved for later sections. Parsed into the slot contract from day one and read by NOBODY
  // in S0, so a link someone shares today survives the section that gives it meaning.
  //   bidder= (S6) · state= (S2) · target= (S3)
  const reserved = {
    bidder: params.get('bidder'),
    state: params.get('state'),
    target: params.get('target'),
  }

  const [sortKey, sortDir] = (() => {
    const [k, d] = sortParam.split(':')
    return [k || '', d === 'asc' ? 'asc' : 'desc'] as const
  })()

  const [data, setData] = useState<BidGridPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [options, setOptions] = useState<ScopeOptionsPayload | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  const push = useCallback((patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      const isDefault =
        !v || v === 'all'
        || (k === 'market' && v === DEFAULT_MARKET)
        || (k === 'view' && v === 'targets')
        || (k === 'status' && v === DEFAULT_STATUS)
        || (k === 'window' && v === DEFAULT_WINDOW)
      if (isDefault) next.delete(k)
      else next.set(k, v)
    }
    const qs = next.toString()
    // `push`, not `replace`: back and forward have to walk the filter history. A grid whose
    // filters cannot be un-done with the browser's own back button is a grid people stop filtering.
    router.push(qs ? `?${qs}` : '?', { scroll: false })
  }, [params, router])

  useEffect(() => {
    let alive = true
    void fetch(`${getBackendUrl()}/api/advertising/scope-options`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive && Array.isArray(d?.campaigns)) setOptions(d as ScopeOptionsPayload) })
      .catch(() => { /* the pickers degrade to empty; the grid does not depend on them */ })
    return () => { alive = false }
  }, [])

  const gridParams = useMemo(() => {
    const p: Record<string, string> = { market, view, status, window: windowParam.replace('d', '') }
    for (const [k, v] of Object.entries({ line: scope.line, portfolio: scope.portfolio, campaign: scope.campaign, q, kind, match, band })) {
      if (v) p[k] = v
    }
    if (measured !== 'all') p.measured = measured
    if (sortKey) { p.sort = sortKey; p.dir = sortDir }
    return p
  }, [market, view, status, windowParam, scope.line, scope.portfolio, scope.campaign, q, kind, match, band, measured, sortKey, sortDir])

  const gridKey = JSON.stringify(gridParams)

  useEffect(() => {
    let alive = true
    setLoading(true)
    const qs = new URLSearchParams(JSON.parse(gridKey) as Record<string, string>).toString()
    void fetch(`${getBackendUrl()}/api/advertising/bid-grid?${qs}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Could not load the bids (${r.status})`)
        return r.json()
      })
      .then((d) => { if (alive) { setData(d as BidGridPayload); setErr(null) } })
      .catch((e) => { if (alive) { setErr((e as Error).message); setData(null) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [gridKey, reloadTick])

  // ── the refresh cursor ────────────────────────────────────────────────────────────────────────
  const scopeParams = useMemo(() => {
    const p: Record<string, string> = { market }
    for (const [k, v] of Object.entries(scope)) if (v) p[k] = v
    return p
  }, [market, scope.line, scope.portfolio, scope.campaign])

  const refresh = useCursorPoll({
    url: `${getBackendUrl()}/api/advertising/bid-grid/cursor`,
    params: scopeParams,
    baseline: (data?.cursor ?? null) as unknown as Record<string, unknown> | null,
  })

  const rows = view === 'targets' ? ((data?.rows ?? []) as BidTargetRow[]) : []
  const campaigns = view === 'campaigns' ? ((data?.rows ?? []) as BidCampaignRow[]) : []
  const census = data?.census ?? null

  const slotProps: BidSlotProps = {
    scope: { market, ...scope },
    view,
    data,
    rows,
    campaigns,
    loading,
    push,
    reload: () => setReloadTick((n) => n + 1),
    reserved,
    refresh: { stale: refresh.stale, lastCheckedAt: refresh.lastCheckedAt, cursor: data?.cursor ?? null },
  }

  const onSortChange = useCallback((s: { key: string; dir: 'asc' | 'desc' } | null) => {
    push({ sort: s ? `${s.key}:${s.dir}` : '' })
  }, [push])

  // ── target columns ────────────────────────────────────────────────────────────────────────────
  const targetColumns: GridColumn<BidTargetRow>[] = useMemo(() => [
    {
      key: 'match', label: 'Match', metric: false,
      tip: 'The stored expressionType, not a normalisation. This account holds 13 distinct values across keyword and product targeting — a three-value filter would hide half the grid behind a control that looked complete.',
      render: (r) => <span className="h10-bd-mt">{r.match.replace(/_/g, ' ').toLowerCase()}</span>,
      sortValue: (r) => r.match,
    },
    {
      key: 'kind', label: 'Kind', metric: false,
      tip: 'KEYWORD 1,982 · PRODUCT 759 · AUTO 123 · and four audience/category forms. A bid decision on an exact keyword and one on a product target are not the same decision, which is why these cannot share a chip.',
      render: (r) => <span className="h10-bd-kind">{r.kind.replace(/_/g, ' ').toLowerCase()}</span>,
      sortValue: (r) => r.kind,
    },
    {
      key: 'adGroup', label: 'Ad group', metric: false,
      render: (r) => <span className="h10-bd-ag" title={r.adGroupName}>{r.adGroupName}</span>,
      sortValue: (r) => r.adGroupName.toLowerCase(),
    },
    {
      key: 'campaign', label: 'Campaign', metric: false,
      tip: 'A target ENABLED inside a paused or archived campaign enters no auction. 1,853 of the 2,944 ENABLED targets are in that position, and the chip here is the only thing on the row that says so.',
      render: (r) => (
        <span className="h10-bd-camp">
          <Link href={`/marketing/ads/campaigns/${r.campaignId}`} title={r.campaignName}>{r.campaignName}</Link>
          {r.campaignStatus !== 'ENABLED' && (
            <i className="off" title={`This campaign is ${r.campaignStatus.toLowerCase()} — the bid on this row is not bidding for anything`}>
              {r.campaignStatus.toLowerCase()}
            </i>
          )}
        </span>
      ),
      sortValue: (r) => r.campaignName.toLowerCase(),
    },
    {
      key: 'market', label: 'Market', metric: false,
      render: (r) => <span className="h10-bd-mkt">{r.market}</span>,
      sortValue: (r) => r.market,
    },
    {
      key: 'bid', label: 'Bid',
      tip: 'What this target bids today. The bottom band moves overnight: the rank engine floors bids at 00:00 and restores them at 08:00, so a count of targets at the floor is true for the minute you read it.',
      render: (r) => <span className="h10-bd-bid">{eur(r.bidCents)}</span>,
      sortValue: (r) => r.bidCents, filterValue: (r) => r.bidCents / 100,
      total: (vis) => (vis.length ? `${eur(Math.min(...vis.map((r) => r.bidCents)))}–${eur(Math.max(...vis.map((r) => r.bidCents)))}` : ''),
    },
    {
      key: 'impressions', label: 'Impr',
      tip: 'From AmazonAdsDailyPerformance, never the AdTarget columns — those are zero on all 3,154 rows. A row reading "not served" got no impressions in this window; that is a measurement, not a gap.',
      render: (r) => (r.measured ? num(r.impressions) : NOT_SERVED),
      sortValue: (r) => (r.measured ? r.impressions : -1), filterValue: (r) => r.impressions,
      total: (vis) => num(vis.reduce((s, r) => s + r.impressions, 0)),
    },
    {
      key: 'clicks', label: 'Clicks',
      render: (r) => (r.measured ? num(r.clicks) : NOT_SERVED),
      sortValue: (r) => (r.measured ? r.clicks : -1), filterValue: (r) => r.clicks,
      total: (vis) => num(vis.reduce((s, r) => s + r.clicks, 0)),
    },
    {
      key: 'cpc', label: 'CPC',
      tip: 'Spend ÷ clicks. Blank when there were no clicks — a cost per click of zero would be a claim nobody can make.',
      render: (r) => (!r.measured ? NOT_SERVED : r.cpcCents == null ? NO_VALUE : eur(r.cpcCents)),
      sortValue: (r) => r.cpcCents ?? -1, filterValue: (r) => (r.cpcCents ?? 0) / 100,
      total: (vis) => { const c = vis.reduce((s, r) => s + r.clicks, 0); return c > 0 ? eur(vis.reduce((s, r) => s + r.spendCents, 0) / c) : '—' },
    },
    {
      key: 'spend', label: 'Spend',
      render: (r) => (r.measured ? eur(r.spendCents) : NOT_SERVED),
      sortValue: (r) => (r.measured ? r.spendCents : -1), filterValue: (r) => r.spendCents / 100,
      total: (vis) => eur(vis.reduce((s, r) => s + r.spendCents, 0)),
    },
    {
      key: 'acos', label: 'ACoS',
      tip: 'Spend ÷ sales over the window. Blank where there are no sales — an infinite ACoS is not 0% and must never sort as if it were.',
      render: (r) => (!r.measured ? NOT_SERVED : r.acos == null ? NO_VALUE : <span className={r.acos > 0.5 ? 'h10-bd-acos hi' : 'h10-bd-acos'}>{pct(r.acos)}</span>),
      sortValue: (r) => r.acos ?? -1, filterValue: (r) => (r.acos ?? 0) * 100,
      total: (vis) => { const s = vis.reduce((a, r) => a + r.salesCents, 0); return s > 0 ? pct(vis.reduce((a, r) => a + r.spendCents, 0) / s) : '—' },
    },
  ], [])

  // ── campaign columns ──────────────────────────────────────────────────────────────────────────
  const campaignColumns: GridColumn<BidCampaignRow>[] = useMemo(() => [
    {
      key: 'market', label: 'Market', metric: false,
      render: (r) => <span className="h10-bd-mkt">{r.market}</span>, sortValue: (r) => r.market,
    },
    {
      key: 'targets', label: 'Targets',
      tip: 'Positive targets matching the current filters. Not the campaign\'s total — change the status filter and this changes with it.',
      render: (r) => (
        <span className="h10-bd-tg">
          {num(r.targets)}
          {r.measured > 0 && <i title={`${r.measured} of them have performance data in this window`}>{r.measured} measured</i>}
        </span>
      ),
      sortValue: (r) => r.targets, filterValue: (r) => r.targets,
      total: (vis) => num(vis.reduce((s, r) => s + r.targets, 0)),
    },
    {
      key: 'bidRange', label: 'Bid range',
      tip: 'The lowest and highest bid OBSERVED on these targets — not a policy. The campaign floor and ceiling are a different pair of numbers and they arrive in S5.',
      render: (r) => (
        r.bidMinCents == null ? NO_VALUE
          : <span className="h10-bd-range">{eur(r.bidMinCents)}<i>–</i>{eur(r.bidMaxCents ?? r.bidMinCents)}</span>
      ),
      sortValue: (r) => r.bidMaxCents ?? -1, filterValue: (r) => (r.bidMaxCents ?? 0) / 100,
    },
    {
      key: 'spend', label: 'Spend',
      render: (r) => (r.spendCents > 0 ? eur(r.spendCents) : r.measured === 0 ? NOT_SERVED : eur(0)),
      sortValue: (r) => r.spendCents, filterValue: (r) => r.spendCents / 100,
      total: (vis) => eur(vis.reduce((s, r) => s + r.spendCents, 0)),
    },
    {
      key: 'sales', label: 'Sales',
      render: (r) => (r.measured === 0 ? NOT_SERVED : eur(r.salesCents)),
      sortValue: (r) => r.salesCents, filterValue: (r) => r.salesCents / 100,
      total: (vis) => eur(vis.reduce((s, r) => s + r.salesCents, 0)),
    },
    {
      key: 'acos', label: 'ACoS',
      tip: 'Recomputed from the campaign\'s summed spend and sales, never averaged from its targets\' own ratios. A mean of ratios is not a ratio of means, and on a page about money that difference is the point.',
      render: (r) => (r.acos == null ? NO_VALUE : <span className={r.acos > 0.5 ? 'h10-bd-acos hi' : 'h10-bd-acos'}>{pct(r.acos)}</span>),
      sortValue: (r) => r.acos ?? -1, filterValue: (r) => (r.acos ?? 0) * 100,
      total: (vis) => { const s = vis.reduce((a, r) => a + r.salesCents, 0); return s > 0 ? pct(vis.reduce((a, r) => a + r.spendCents, 0) / s) : '—' },
    },
  ], [])

  // ── filters ───────────────────────────────────────────────────────────────────────────────────
  // 🔴 Market is NOT a filter here: the header owns it. The chip options come from server facets
  // with their counts, so a value the data holds can never be missing from the control.
  const filters: GridFilter[] = useMemo(() => {
    const f = data?.facets
    const common: GridFilter[] = [
      {
        key: '__status', label: 'Status', kind: 'select', placeholder: 'Enabled',
        options: [
          { value: 'enabled', label: 'Enabled' }, { value: 'paused', label: 'Paused' },
          { value: 'archived', label: 'Archived' }, { value: 'all', label: 'Any status' },
        ],
      },
    ]
    if (view === 'campaigns') {
      return [...common,
        { key: 'targets', label: 'Targets', kind: 'range' },
        { key: 'spend', label: 'Spend', kind: 'range', unit: '€' },
        { key: 'acos', label: 'ACoS', kind: 'range', unit: '%' },
      ]
    }
    return [
      ...common,
      {
        key: '__kind', label: 'Kind', kind: 'select', placeholder: 'Any kind', wide: true,
        options: [{ value: '', label: 'Any kind' }, ...(f?.kind ?? []).map((x) => ({
          value: x.value, label: `${x.value.replace(/_/g, ' ').toLowerCase()} (${num(x.count)})`,
        }))],
      },
      {
        key: '__match', label: 'Match', kind: 'select', placeholder: 'Any match', wide: true, searchable: true,
        options: [{ value: '', label: 'Any match' }, ...(f?.match ?? []).map((x) => ({
          value: x.value, label: `${x.value.replace(/_/g, ' ').toLowerCase()} (${num(x.count)})`,
        }))],
      },
      {
        key: '__band', label: 'Bid band', kind: 'select', placeholder: 'Any bid',
        options: [{ value: '', label: 'Any bid' }, ...BID_BANDS.map((b) => ({
          value: b, label: `${BAND_LABEL[b]} (${num(f?.band.find((x) => x.value === b)?.count ?? 0)})`,
        }))],
      },
      {
        key: '__measured', label: 'Data', kind: 'select', placeholder: 'Any',
        options: [
          { value: 'all', label: 'Any' },
          { value: 'yes', label: `Has ${data?.window.days ?? 30}-day data (${num(f?.measured.find((x) => x.value === 'yes')?.count ?? 0)})` },
          { value: 'no', label: `Never served (${num(f?.measured.find((x) => x.value === 'no')?.count ?? 0)})` },
        ],
      },
      { key: 'bid', label: 'Bid', kind: 'range', unit: '€' },
      { key: 'spend', label: 'Spend', kind: 'range', unit: '€' },
      { key: 'acos', label: 'ACoS', kind: 'range', unit: '%' },
      { key: 'clicks', label: 'Clicks', kind: 'range' },
    ]
  }, [data, view])

  // The four server-side chips ride the URL, so the grid's own filter state is only used for the
  // numeric ranges. Bridging them here rather than inside AdsDataGrid keeps that component
  // untouched apart from the additive sort callback.
  const initialFilters = useMemo(() => ({
    __status: status, __kind: kind, __match: match, __band: band, __measured: measured,
  }), [status, kind, match, band, measured])

  const onFilterChange = useCallback((next: Record<string, unknown>) => {
    const s = (k: string) => (typeof next[k] === 'string' ? (next[k] as string) : '')
    push({ status: s('__status'), kind: s('__kind'), match: s('__match'), band: s('__band'), measured: s('__measured') })
  }, [push])

  const activeTab = rulesTabByKey('bid')
  const sc = data?.scope

  /** The one sentence stating what resolved. */
  const resolution = (() => {
    if (!sc || !census) return null
    const bits: string[] = [sc.market === 'all' ? 'All markets' : sc.market]
    bits.push(sc.campaigns == null ? `all ${num(sc.total)} campaigns` : `${num(sc.campaigns)} of ${num(sc.total)} campaigns`)
    bits.push(`${num(census.targets)} positive target${census.targets === 1 ? '' : 's'}`)
    return bits.join(' · ')
  })()

  /**
   * The census. Each clickable cell reproduces its own number — verified against production, not
   * assumed. `spend` carries no click because there is no filter that would return "the rows
   * summing to €X", and a cell whose click did something adjacent to its number is worse than a
   * cell you cannot click.
   */
  const CLEAR = { kind: '', match: '', band: '', measured: 'all', q: '' }
  const strip = census ? [
    {
      key: 'targets', n: num(census.targets), label: census.targets === 1 ? 'target' : 'targets',
      tip: 'Every positive AdTarget in this scope at the current status. Click to clear every filter.',
      on: !kind && !match && !band && measured === 'all' && !q && view === 'targets',
      apply: () => push({ view: 'targets', ...CLEAR }),
    },
    {
      key: 'campaigns', n: num(census.campaigns), label: census.campaigns === 1 ? 'campaign' : 'campaigns',
      tip: `Campaigns holding one of these targets. ${num(census.liveCampaigns)} of them are ENABLED.`,
      on: view === 'campaigns', apply: () => push({ view: 'campaigns' }),
    },
    {
      key: 'live', n: num(census.liveNow), label: 'bidding now',
      tip: 'Target enabled AND campaign enabled. Both, or the bid enters no auction. The rest are switched on inside something switched off.',
      on: false, apply: null, tone: 'live',
    },
    {
      key: 'measured', n: num(census.measured), label: `with ${data?.window.days ?? 30}-day data`,
      tip: 'Targets carrying at least one AmazonAdsDailyPerformance row in this window. The rest were never served — which is why their metric columns are empty.',
      on: measured === 'yes', apply: () => push({ view: 'targets', ...CLEAR, measured: 'yes' }), tone: 'muted',
    },
    {
      key: 'spend', n: eur(census.spendCents), label: `spent in ${data?.window.days ?? 30} days`,
      tip: 'Summed from the daily performance table over the targets in scope.', on: false, apply: null,
    },
  ] : []

  const csv = () => {
    const head = view === 'targets'
      ? ['Target', 'Match', 'Kind', 'Ad group', 'Campaign', 'Campaign status', 'Market', 'Bid EUR', 'Band', 'Measured', 'Impressions', 'Clicks', 'CPC EUR', 'Spend EUR', 'Sales EUR', 'ACoS %', 'Target name derived']
      : ['Campaign', 'Market', 'Status', 'Targets', 'Measured', 'Bid min EUR', 'Bid max EUR', 'Impressions', 'Clicks', 'Spend EUR', 'Sales EUR', 'ACoS %']
    const cell = (v: unknown) => {
      const s = v == null ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const body = view === 'targets'
      ? rows.map((r) => [r.label, r.match, r.kind, r.adGroupName, r.campaignName, r.campaignStatus, r.market,
        (r.bidCents / 100).toFixed(2), r.band, r.measured ? 'yes' : 'no',
        r.measured ? r.impressions : '', r.measured ? r.clicks : '',
        r.cpcCents == null ? '' : (r.cpcCents / 100).toFixed(2),
        r.measured ? (r.spendCents / 100).toFixed(2) : '', r.measured ? (r.salesCents / 100).toFixed(2) : '',
        r.acos == null ? '' : (r.acos * 100).toFixed(1), r.derived ? 'yes' : 'no'])
      : campaigns.map((r) => [r.name, r.market, r.status, r.targets, r.measured,
        r.bidMinCents == null ? '' : (r.bidMinCents / 100).toFixed(2),
        r.bidMaxCents == null ? '' : (r.bidMaxCents / 100).toFixed(2),
        r.impressions, r.clicks, (r.spendCents / 100).toFixed(2), (r.salesCents / 100).toFixed(2),
        r.acos == null ? '' : (r.acos * 100).toFixed(1)])
    const text = [head, ...body].map((line) => line.map(cell).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `bid-${view}-${market}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const searchBox = (
    <span className="h10-bd-search">
      <input
        type="search" defaultValue={q} placeholder="Search target, campaign or ad group…"
        aria-label="Search"
        onKeyDown={(e) => { if (e.key === 'Enter') push({ q: (e.target as HTMLInputElement).value }) }}
        onBlur={(e) => { if (e.target.value !== q) push({ q: e.target.value }) }}
      />
    </span>
  )

  const toolbarLeft = (
    <>
      <span className="h10-svt-seg" role="tablist" aria-label="Grain">
        {([['targets', 'Targets'], ['campaigns', 'Campaigns']] as const).map(([v, label]) => (
          <button
            key={v} type="button" role="tab" aria-selected={view === v}
            className={`seg ${view === v ? 'on' : ''}`}
            onClick={() => push({ view: v })}
            title={v === 'targets'
              ? 'One row per target — the grain a bid is actually set at'
              : 'One row per campaign — the grain a floor, a ceiling and a bidder are set at'}
          >{label}</button>
        ))}
      </span>
      {searchBox}
    </>
  )

  const toolbarRight = (
    <span className="h10-bd-win">
      {refresh.stale && (
        <button type="button" className="h10-bd-stale" onClick={() => setReloadTick((n) => n + 1)}
          title="A bid, a target or a campaign changed since this view was loaded. Nothing has been reordered underneath you — click to pick it up.">
          <RefreshCw size={12} /> Changed since you loaded
        </button>
      )}
      <select
        value={windowParam} onChange={(e) => push({ window: e.target.value })}
        aria-label="Metric window" className="h10-bd-select"
        title="The window the metric columns are summed over. It is NOT the history window — the bid curve arrives in S3 and carries its own."
      >
        <option value="7d">7 days</option>
        <option value="30d">30 days</option>
        <option value="60d">60 days</option>
      </select>
    </span>
  )

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Bid"
        subtitle={activeTab?.subtitle ?? 'What each target bids, why it is that number, and who decided'}
        markets={MARKETS}
        market={market}
        /* 🔴 The header's picker is the ONLY market control on this page. `showMarket` does not
           exist; the scope bar below renders three grains and never a fourth for market. */
        onMarketChange={(m) => push({ market: m, campaign: '' })}
        showLearn={false}
        showDataSync={false}
        /* The metric window rides the grid toolbar, next to the grid it changes. The header's date
           picker would be a second control for the same fact, two rows apart. */
        showDateRange={false}
        showChangeLog
      />

      <RulesTabs active="bid" />

      <BidScopeBar
        options={options}
        market={market}
        scope={scope}
        applied={sc?.applied ?? []}
        notes={sc?.notes ?? []}
        contradiction={sc?.contradiction ?? null}
        onChange={(next) => push({ line: next.line, portfolio: next.portfolio, campaign: next.campaign })}
      />

      {resolution && (
        <p className="h10-bd-said">
          <b>{resolution}</b>
          {data?.freshness.newestTargetAt && <> · newest change {clockLabel(data.freshness.newestTargetAt)}</>}
        </p>
      )}

      {err && <p className="h10-bd-note bad"><AlertTriangle size={13} /><span>{err}</span></p>}

      {census && (
        <div className="h10-bd-census" role="group" aria-label="What is in this scope">
          {strip.map((c) => (
            c.apply
              ? (
                <button key={c.key} type="button" title={c.tip} className={`h10-bd-cell ${c.tone ?? ''} ${c.on ? 'on' : ''}`} onClick={c.apply}>
                  <b>{c.n}</b><span>{c.label}</span>
                </button>
              )
              : (
                <span key={c.key} title={c.tip} className={`h10-bd-cell flat ${c.tone ?? ''}`}>
                  <b>{c.n}</b><span>{c.label}</span>
                </span>
              )
          ))}
        </div>
      )}

      {/* 🔴 The sentence that stops four rows in five reading as a broken page.
          Counted off the `measured` facet, not the census: the facet excludes its own dimension and
          applies every other filter, so its two numbers describe THE ROWS ON SCREEN. The census
          describes the scope. Both are true and they are not the same set — see the band sentence
          below for the same trap caught on production. */}
      {(() => {
        const yes = data?.facets.measured.find((m) => m.value === 'yes')?.count ?? 0
        const no = data?.facets.measured.find((m) => m.value === 'no')?.count ?? 0
        if (!data || no === 0 || no / Math.max(1, yes + no) < 0.1) return null
        return (
          <p className="h10-bd-note">
            <Info size={12} />
            <span>
              <b>{num(no)} of the {num(yes + no)} targets in this view got no impressions in the
              last {data.window.days} days</b>, so their metric columns read “not served” rather
              than zero. Metrics come from the daily performance feed; a target that never entered
              an auction has nothing to report, which is a different fact from one that was served
              and earned nothing.
            </span>
          </p>
        )
      })()}

      {/* The floor population is a clock reading. Say which clock — and 🔴 say which DENOMINATOR.
          The band facet excludes its own dimension but applies every other filter, so its count is
          over the FILTERED view while the census above counts the SCOPE. Printed bare, the two read
          as one set: with `?kind=AUTO` this line said "24 targets sit at €0.05 or below" directly
          beneath a cell reading 2,944. A guard has to share the denominator of the value it
          guards. */}
      {census && data && view === 'targets' && (data.facets.band.find((b) => b.value === '0-5')?.count ?? 0) > 0 && (
        <p className="h10-bd-note">
          <Info size={12} />
          <span>
            <b>
              {num(data.facets.band.find((b) => b.value === '0-5')?.count ?? 0)} of
              the {num(data.facets.band.reduce((s, b) => s + b.count, 0))} targets in this view sit
              at €0.05 or below
            </b>{' '}
            as of {clockLabel(new Date().toISOString())} Rome. That number is a clock reading, not a
            state: the rank engine floors bids at 00:00 and restores them at 08:00, and the
            population swings by hundreds overnight. What each of those bids MEANS — suppressed,
            in a min-bid window, or at the floor with no restore value recorded — is not on this
            page yet.
          </span>
        </p>
      )}

      {data?.truncated && (
        <p className="h10-bd-note bad">
          <AlertTriangle size={12} />
          <span>This scope holds more than 5,000 targets and the grid is showing the first 5,000 by bid. Narrow the scope — the export would be truncated too.</span>
        </p>
      )}

      {view === 'targets' ? (
        <AdsDataGrid<BidTargetRow>
          rows={rows}
          loading={loading}
          rowId={(r) => r.id}
          noun="Target"
          firstColLabel="Target"
          renderFirst={(r) => (
            <div className="h10-bd-target">
              {/* The shared grid paints the first column blue at (0,3,1) because every other
                  consumer makes it a link. This one is not a link yet — S3 makes it open the bid
                  curve — so the colour is overridden at matching specificity in the CSS. */}
              <span
                className={r.derived ? 't derived' : 't'}
                title={r.derived
                  ? `This target has no text expression — Amazon identifies it by its targeting group. Shown as "${r.label}", derived from ${r.match.replace(/_/g, ' ').toLowerCase()}.`
                  : r.label}
              >{r.label}</span>
              {!r.liveNow && <span className="fl off" title="This bid is not in any auction: the target or its campaign is not enabled">not bidding</span>}
            </div>
          )}
          firstSortValue={(r) => r.label.toLowerCase()}
          columns={targetColumns}
          filters={filters}
          initialFilters={initialFilters}
          onFilterChange={onFilterChange}
          defaultSort={sortKey ? { key: sortKey, dir: sortDir } : { key: 'spend', dir: 'desc' }}
          onSortChange={onSortChange}
          showTotal
          totalFirst={`${num(rows.length)} shown`}
          /* 🔴 S0 is read-only. Passed as explicit absence rather than omitted. */
          selectable={false}
          selectionActions={NO_WRITE_ACTIONS.selectionActions ?? undefined}
          onRowClick={NO_WRITE_ACTIONS.onRowAction ?? undefined}
          exportable
          onExport={csv}
          pagerCentered
          storageKey="nexus.bid.cols"
          toolbarLeft={toolbarLeft}
          toolbarRight={toolbarRight}
          emptyNode={<EmptyState loading={loading} data={data} q={q} push={push} />}
          reportLabel={data?.freshness.newestPerfDate ? `Performance data through ${new Date(data.freshness.newestPerfDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : undefined}
        />
      ) : (
        <AdsDataGrid<BidCampaignRow>
          rows={campaigns}
          loading={loading}
          rowId={(r) => r.id}
          noun="Campaign"
          firstColLabel="Campaign"
          renderFirst={(r) => (
            <div className="h10-bd-target">
              <Link className="t" href={`/marketing/ads/campaigns/${r.id}`} title={r.name}>{r.name}</Link>
              {r.status !== 'ENABLED' && <span className="fl off" title={`This campaign is ${r.status.toLowerCase()}`}>{r.status.toLowerCase()}</span>}
            </div>
          )}
          firstSortValue={(r) => r.name.toLowerCase()}
          columns={campaignColumns}
          filters={filters}
          initialFilters={initialFilters}
          onFilterChange={onFilterChange}
          defaultSort={sortKey ? { key: sortKey, dir: sortDir } : { key: 'spend', dir: 'desc' }}
          onSortChange={onSortChange}
          showTotal
          totalFirst={`${num(campaigns.length)} shown`}
          selectable={false}
          exportable
          onExport={csv}
          pagerCentered
          storageKey="nexus.bid.campcols"
          toolbarLeft={toolbarLeft}
          toolbarRight={toolbarRight}
          emptyNode={<EmptyState loading={loading} data={data} q={q} push={push} />}
        />
      )}

      {/* ── The nine sections that follow. Every one attaches in BidSections, which renders null
             today; nobody restructures this client to add one. ─────────────────────────────────── */}
      <BidSections {...slotProps} />


      {/* Interim until S7: the rule list exactly as `?tab=bid` rendered it, so routing the tab
          takes nothing out of the product. S7 deletes this block and its two imports. */}
      <div className="h10-bd-prov">
        <h2>
          Bid rules
          <i>Provisional — this is the old tab, moved unchanged. S7 replaces it with rules as
          declared exceptions to a campaign&rsquo;s bidder.</i>
        </h2>
      </div>
      <RuleListTab
        noun="Bid Rule"
        seed={[]}
        liveType="bid"
        editHref={(id) => `/marketing/ads/rules-automation/builder/bid?ruleId=${id}`}
        onAddRule={() => { window.location.href = '/marketing/ads/rules-automation/builder/bid' }}
        emptyNode={(
          <span className="h10-rr-empty">
            <NoDataIllus size={104} />
            <b>Create a Bid Rule to optimize keyword bids based on performance!</b>
            <a className="h10-am-btn primary" href="/marketing/ads/rules-automation/builder/bid"><Plus size={13} /> Create Rule</a>
          </span>
        )}
      />
    </div>
  )
}

/** An empty grid has three different causes here, and saying which one is the whole job. */
function EmptyState({ loading, data, q, push }: { loading: boolean; data: BidGridPayload | null; q: string; push: (p: Record<string, string>) => void }) {
  if (loading) return <span className="h10-bd-empty"><b>Loading…</b></span>
  if (!data) return <span className="h10-bd-empty"><b>Nothing loaded.</b><span>The read failed — the message above says why.</span></span>
  if (data.scope.contradiction) {
    return (
      <span className="h10-bd-empty">
        <b>Nothing can match this scope.</b>
        <span>{data.scope.contradiction}</span>
      </span>
    )
  }
  if (data.census.targets === 0) {
    return (
      <span className="h10-bd-empty">
        <b>No targets in this scope.</b>
        <span>
          That is a real zero: {num(data.scope.campaigns ?? data.scope.total)} campaigns resolved and
          none of them holds a positive target at this status.
        </span>
      </span>
    )
  }
  return (
    <span className="h10-bd-empty">
      <b>{num(data.census.targets)} targets are in this scope — the filters hide all of them.</b>
      <span>
        {q ? <>Nothing matches “{q}”. </> : null}
        <button type="button" className="lnk" onClick={() => push({ q: '', kind: '', match: '', band: '', measured: 'all' })}>Clear the filters</button>
      </span>
    </span>
  )
}
