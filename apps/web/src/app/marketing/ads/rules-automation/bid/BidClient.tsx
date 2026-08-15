'use client'

/**
 * BID.S0 — Bid, promoted from a tab to its own page, with a live read-only grid.
 *
 * The page answers: **what is each target bidding, why is it that number, who decided, and what is
 * it allowed to be.** S0 builds the first quarter of that — what each target is bidding, and what
 * it bought — over the whole account, at two grains, for four markets. The other three quarters are
 * S1–S9 and every one of them is a slot at the bottom of this file.
 *
 * S0 shipped read-only with `NO_WRITE_ACTIONS` as explicit absence; BID.S4 replaced it — the
 * targets selection now carries the three write verbs, every write gated and grace-held.
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
import { AlertTriangle, Info, Pencil, RefreshCw } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { getBackendUrl } from '@/lib/backend-url'
import { BidScopeBar, type BidScopeValue, type ScopeOptionsPayload } from './BidScopeBar'
import { useCursorPoll } from '../_shared/useCursorPoll'
import {
  BAND_LABEL, BID_BANDS, BIDDER_LABEL,
  type BidCampaignRow, type BidGridPayload, type BidTargetRow, type BidView, type BidderKind,
} from './types'
import {
  resolveBidStates, hasBidState, BID_STATE_KEYS, BID_STATE_LABEL, type BidStateKey,
} from './bidState'
import { BidSpark } from './BidSpark'
import { type BidSlotProps } from './slot-contract'
import { BidSelectionActions } from './BidEditing'
import { BidGoalDialog } from './BidGoalDialog'
import { BidSections } from './BidSections'
import { BidTargetDrawer } from './BidTargetDrawer'
import { BidBidderBand } from './BidBidderBand'
// Interim, until S7 replaces it: rendered exactly as the tab rendered it, so nothing is lost in the
// move off `?tab=bid`.
import { BidRules } from './BidRules'
import { useAdsSync } from '../_shared/adsBus'

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

  // BID.S2 — `state=` was reserved by S0 and is now live. It filters on the UNCAPPED chip list:
  // see `hasBidState`, and the reason in its comment.
  const stateParam = params.get('state') ?? ''
  const state = (BID_STATE_KEYS as readonly string[]).includes(stateParam) ? (stateParam as BidStateKey) : null

  // BID.S6 — `bidder=` is LIVE: a client-side filter over the derived bidder kind, same pattern
  // as `state=`. An unknown value filters nothing rather than blanking the grid.
  const bidderParam = params.get('bidder') ?? ''
  const bidder = (['schedule', 'goal', 'manual', 'none'] as const).find((k) => k === bidderParam) ?? null

  // S3 — `target=` opens the single-target drawer. All three reserved params are live now.
  const reserved = {
    bidder: bidderParam || null,
    state: stateParam || null,
    target: params.get('target'),
  }

  /** S3 — the drawer link: current URL + target=<id>. A PUSH (Link default), so Back closes. */
  const targetHref = (id: string) => {
    const p = new URLSearchParams(params.toString())
    p.set('target', id)
    return `?${p.toString()}`
  }
  const closeTarget = () => {
    const p = new URLSearchParams(params.toString())
    p.delete('target')
    router.replace(`?${p.toString()}`, { scroll: false })
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
  // S6 — the campaign whose bidder dialog is open. Local state, not URL: assignment is an
  // action, not a shareable view (the `?bidder=` param is the FILTER, per the URL contract).
  const [goalFor, setGoalFor] = useState<BidCampaignRow | null>(null)

  // RT.1 — your own writes, from any tab, applied silently. An ENGINE's write arrives on the
  // other rail (the cursor poll) and offers a banner instead; see `_shared/adsBus.ts`.
  useAdsSync(['ads.bid.changed', 'ads.guardrail.changed', 'ads.rule.changed'], () => setReloadTick((n) => n + 1))

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

  // 🔴 The cast is gated on the PAYLOAD's own view, not just the URL's. The URL flips
  // synchronously on a view switch while `data` still holds the other view's rows for one
  // fetch round-trip — and a target row rendered through campaignColumns crashes the page on
  // `r.targets.toLocaleString()` (found live: the S1 band's no-bidder click). During the
  // transition both arrays are empty and the grid shows its loading state instead.
  const allRows = view === 'targets' && data?.view === 'targets' ? ((data?.rows ?? []) as BidTargetRow[]) : []
  const allCampaigns = view === 'campaigns' && data?.view === 'campaigns' ? ((data?.rows ?? []) as BidCampaignRow[]) : []

  /**
   * BID.S2 — the state filter runs HERE, not on the server: the vocabulary is a client module so
   * that S3–S9 can import the same resolver, and a second copy in the API would be exactly the
   * "two answers to one question" the resolver exists to prevent.
   *
   * 🔴 Counts are computed over `allRows` with the state filter EXCLUDED — the same
   * exclude-your-own-dimension rule the server applies to its facets. A chip that advertised a
   * count it could not deliver is the NEG.1 defect, and it does not stop being that defect because
   * the arithmetic moved to the browser.
   */
  const stateCounts = useMemo(() => {
    const m = {} as Record<BidStateKey, number>
    for (const k of BID_STATE_KEYS) m[k] = 0
    // S6 — the OTHER live client-side filter (bidder) applies here, so each state option
    // advertises what it would deliver under the current bidder narrowing.
    const src = bidder ? allRows.filter((r) => r.bidder === bidder) : allRows
    for (const r of src) for (const k of BID_STATE_KEYS) if (hasBidState(r, k)) m[k] += 1
    return m
  }, [allRows, bidder])

  // S6 — bidder facet counts, excluding their own dimension but honouring `state=`, at the grain
  // the current view shows.
  const bidderCounts = useMemo(() => {
    const m: Record<string, number> = { schedule: 0, goal: 0, manual: 0, none: 0 }
    if (view === 'targets') {
      const src = state ? allRows.filter((r) => hasBidState(r, state)) : allRows
      for (const r of src) m[r.bidder] += 1
    } else {
      for (const r of allCampaigns) m[r.bidder] += 1
    }
    return m
  }, [allRows, allCampaigns, state, view])

  const rows = useMemo(
    () => allRows.filter((r) => (!state || hasBidState(r, state)) && (!bidder || r.bidder === bidder)),
    [allRows, state, bidder],
  )
  const campaigns = useMemo(
    () => (bidder ? allCampaigns.filter((r) => r.bidder === bidder) : allCampaigns),
    [allCampaigns, bidder],
  )
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
    options,
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
      // BID.S2 — hidden by default to make room for Band/Bidder/History/State. Kind is already a
      // filter chip with counts, so the column was restating a control the operator just used.
      defaultHidden: true,
    },
    {
      key: 'adGroup', label: 'Ad group', metric: false,
      render: (r) => <span className="h10-bd-ag" title={r.adGroupName}>{r.adGroupName}</span>,
      sortValue: (r) => r.adGroupName.toLowerCase(),
      // BID.S2 — hidden by default; the ad group is visible in the Campaign cell's context and in
      // the drawer S3 adds. Customize brings it back and `storageKey` remembers that.
      defaultHidden: true,
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
    // ── BID.S2 — the four columns that turn a list of numbers into a decision ───────────────────
    {
      key: 'band', label: 'Band', metric: false,
      tip: 'The floor and ceiling declared on this target\'s CAMPAIGN, where the write gate reads them. 🔴 "not set" is not a floor of zero — no campaign in the account declares a floor at all (0 of 220), and 82 declare a ceiling. Read-only here; S5 owns the editor.',
      render: (r) => <BandCell r={r} />,
      sortValue: (r) => r.maxBidCents ?? -1,
    },
    {
      key: 'bidder', label: 'Bidder', metric: false,
      tip: 'Who moves this campaign\'s bids: a rank schedule, a target-ACoS goal, an operator in the last 60 days, or nobody. 41 of the 86 enabled campaigns have no bidder, 26 of them spent money last month, and their write gates are open.',
      render: (r) => <BidderCell kind={r.bidder} name={r.bidderName} />,
      sortValue: (r) => `${r.bidder}:${r.bidderName ?? ''}`,
    },
    {
      key: 'history', label: 'History', metric: false,
      tip: 'Every recorded bid change in 60 days, oldest left. Drawn as steps because a bid holds its value until something writes a new one — a sloped line would show a drift that never happened. Only 607 of 2,944 enabled targets have any change at all; the rest show a dotted rule, which means "never written", not "steady".',
      render: (r) => <BidSpark points={data?.series?.[r.id]} label={r.label} format={eur} />,
      sortValue: (r) => data?.series?.[r.id]?.length ?? -1,
    },
    {
      key: 'state', label: 'State', metric: false,
      tip: 'At most two, most decision-changing first. The three floor states are mutually exclusive: "Suppressed" remembers what to restore, "Min-bid window" is a schedule that will restore it, and "At floor · no restore" is neither — nothing on record says what that bid was.',
      render: (r) => <StateCell r={r} />,
      sortValue: (r) => resolveBidStates(r)[0]?.key ?? 'zzz',
    },
    {
      key: 'effCpc', label: 'Eff. max CPC',
      tip: 'The most one click can cost: bid × placement multiplier × bidding strategy. "Down only" (193 campaigns) never raises a bid; "up and down" can add 100% at top of search. Blank where nothing lifts the bid — this column never restates Bid.',
      render: (r) => <EffCpcCell r={r} />,
      sortValue: (r) => r.effectiveMaxCpcCents ?? -1,
      filterValue: (r) => (r.effectiveMaxCpcCents ?? 0) / 100,
      // Derived, not a fact Amazon holds. Off by default; Customize turns it on.
      defaultHidden: true,
    },
    {
      key: 'impressions', label: 'Impr',
      tip: 'From AmazonAdsDailyPerformance, never the AdTarget columns — those are zero on all 3,154 rows. A row reading "not served" got no impressions in this window; that is a measurement, not a gap.',
      render: (r) => (r.measured ? num(r.impressions) : NOT_SERVED),
      sortValue: (r) => (r.measured ? r.impressions : -1), filterValue: (r) => r.impressions,
      total: (vis) => num(vis.reduce((s, r) => s + r.impressions, 0)),
      // BID.S2 — hidden by default. Clicks, CPC, Spend and ACoS carry the story; impressions are
      // the one metric an operator reads only after deciding something is wrong.
      defaultHidden: true,
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
  ], [data?.series])

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
    // ── BID.S2 — the two campaign-grain facts, at the grain they are enforced at ────────────────
    {
      key: 'bidder', label: 'Bidder', metric: false,
      tip: 'Who moves this campaign\'s bids. Measured over the 86 enabled campaigns: schedule 33 · goal 0 · manual 12 · no bidder 41. The pencil assigns: declare a goal here, or add the campaign to a schedule on Rank & Dayparting.',
      render: (r) => (
        <span className="h10-bd6-cell">
          <BidderCell kind={r.bidder} name={r.bidderName} />
          {/* S6 — assignment lives at the grain the bidder is a fact of. */}
          <button type="button" className="h10-bd6-edit" title={`Assign a bidder to ${r.name}`} onClick={() => setGoalFor(r)} aria-label={`Assign a bidder to ${r.name}`}>
            <Pencil size={11} aria-hidden />
          </button>
        </span>
      ),
      sortValue: (r) => `${r.bidder}:${r.bidderName ?? ''}`,
    },
    {
      key: 'band', label: 'Band', metric: false,
      tip: 'The floor and ceiling the write gate enforces, declared on this campaign. 0 of 220 declare a floor; 82 declare a ceiling, at 80¢, 90¢ or 190¢.',
      render: (r) => (
        r.minBidCents == null && r.maxBidCents == null
          ? <span className="h10-bd-band none" title="Nothing declared on this campaign — not a band of zero.">not set</span>
          : <span className="h10-bd-band half" title={`${r.minBidCents != null ? `Floor ${eur(r.minBidCents)}` : 'No floor'} · ${r.maxBidCents != null ? `Ceiling ${eur(r.maxBidCents)}` : 'No ceiling'}`}>
            <i className="cap">{r.maxBidCents != null ? 'max' : 'min'}</i><b>{eur((r.maxBidCents ?? r.minBidCents)!)}</b>
          </span>
      ),
      sortValue: (r) => r.maxBidCents ?? -1,
    },
    {
      key: 'outOfBand', label: 'Above ceiling',
      tip: 'How many of this campaign\'s bids sit above its own declared ceiling. The gate refuses a write outside the band but never pulls an existing bid in, so these are frozen: nothing may raise them and nothing is lowering them. 56 across the account.',
      render: (r) => (r.maxBidCents == null ? <span className="h10-bd-nd" title="No ceiling declared, so nothing can be above it.">—</span>
        : r.outOfBand > 0 ? <span className="h10-bd-oob">{num(r.outOfBand)}</span> : <span className="h10-bd-nd">0</span>),
      sortValue: (r) => r.outOfBand, filterValue: (r) => r.outOfBand,
      total: (vis) => num(vis.reduce((s, r) => s + r.outOfBand, 0)),
    },
    {
      key: 'bidRange', label: 'Bid range',
      tip: 'The lowest and highest bid OBSERVED on these targets — not a policy. The campaign floor and ceiling are the Band column beside this one, and they are a different pair of numbers.',
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
    // BID.S6 — `?bidder=`, reserved by S0 and now live. Counts come from the same predicate the
    // filter uses (r.bidder), at the grain the view shows, so every option delivers its number.
    const bidderFilter: GridFilter = {
      key: '__bidder', label: 'Bidder', kind: 'select', placeholder: 'Any bidder',
      options: [
        { value: '', label: 'Any bidder' },
        ...(['schedule', 'goal', 'manual', 'none'] as const).map((k) => ({
          value: k, label: `${BIDDER_LABEL[k]} (${num(bidderCounts[k] ?? 0)})`,
        })),
      ],
    }
    if (view === 'campaigns') {
      return [...common,
        bidderFilter,
        { key: 'targets', label: 'Targets', kind: 'range' },
        { key: 'spend', label: 'Spend', kind: 'range', unit: '€' },
        { key: 'acos', label: 'ACoS', kind: 'range', unit: '%' },
      ]
    }
    return [
      ...common,
      bidderFilter,
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
      {
        // BID.S2 — `?state=`, reserved by S0 and now live. Counts come from the same uncapped
        // predicate the filter uses, so every option delivers exactly the number it advertises.
        key: '__state', label: 'State', kind: 'select', placeholder: 'Any state', wide: true,
        options: [
          { value: '', label: 'Any state' },
          ...BID_STATE_KEYS.map((k) => ({ value: k, label: `${BID_STATE_LABEL[k]} (${num(stateCounts[k] ?? 0)})` })),
        ],
      },
      { key: 'bid', label: 'Bid', kind: 'range', unit: '€' },
      { key: 'spend', label: 'Spend', kind: 'range', unit: '€' },
      { key: 'acos', label: 'ACoS', kind: 'range', unit: '%' },
      { key: 'clicks', label: 'Clicks', kind: 'range' },
    ]
  }, [data, view, bidderCounts, stateCounts])

  // The four server-side chips ride the URL, so the grid's own filter state is only used for the
  // numeric ranges. Bridging them here rather than inside AdsDataGrid keeps that component
  // untouched apart from the additive sort callback.
  const initialFilters = useMemo(() => ({
    __status: status, __kind: kind, __match: match, __band: band, __measured: measured, __state: stateParam, __bidder: bidderParam,
  }), [status, kind, match, band, measured, stateParam, bidderParam])

  const onFilterChange = useCallback((next: Record<string, unknown>) => {
    const s = (k: string) => (typeof next[k] === 'string' ? (next[k] as string) : '')
    push({ status: s('__status'), kind: s('__kind'), match: s('__match'), band: s('__band'), measured: s('__measured'), state: s('__state'), bidder: s('__bidder') })
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
  // S2 added `state`, S6 added `bidder` — "clear every filter" must clear the client-side pair
  // too, or the census cell's number and the grid disagree while the cell claims to be active.
  const CLEAR = { kind: '', match: '', band: '', measured: 'all', q: '', state: '', bidder: '' }
  const strip = census ? [
    {
      key: 'targets', n: num(census.targets), label: census.targets === 1 ? 'target' : 'targets',
      tip: 'Every positive AdTarget in this scope at the current status. Click to clear every filter.',
      on: !kind && !match && !band && measured === 'all' && !q && !state && !bidder && view === 'targets',
      apply: () => push({ view: 'targets', ...CLEAR }),
    },
    {
      key: 'campaigns', n: num(census.campaigns), label: census.campaigns === 1 ? 'campaign' : 'campaigns',
      // S6 made the campaign grain filter by CAMPAIGN status, so the click is a view switch that
      // lands on the ENABLED ones — the tip says so rather than letting 217 → 86 read as a bug.
      tip: `Campaigns holding one of these targets. ${num(census.liveCampaigns)} of them are ENABLED — the campaign grain's default filter shows those; set Status to “Any” for all of them.`,
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
      ? ['Target', 'Match', 'Kind', 'Ad group', 'Campaign', 'Campaign status', 'Market', 'Bid EUR', 'Bid band', 'Measured', 'Impressions', 'Clicks', 'CPC EUR', 'Spend EUR', 'Sales EUR', 'ACoS %', 'Target name derived',
        // BID.S2 — the export carries every new column, and the STATE list uncapped: a
        // spreadsheet has no width problem, so truncating to two there would lose data for
        // no reason. `Floor EUR` is blank when none is declared, never 0.
        'Floor EUR', 'Ceiling EUR', 'Bidder', 'Bidder name', 'Recorded changes 60d', 'Last audited EUR', 'Unrecorded change', 'Eff max CPC EUR', 'Placement %', 'Bidding strategy', 'State']
      : ['Campaign', 'Market', 'Status', 'Bidder', 'Bidder name', 'Above ceiling', 'Targets', 'Measured', 'Bid min EUR', 'Bid max EUR', 'Impressions', 'Clicks', 'Spend EUR', 'Sales EUR', 'ACoS %']
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
        r.acos == null ? '' : (r.acos * 100).toFixed(1), r.derived ? 'yes' : 'no',
        r.minBidCents == null ? '' : (r.minBidCents / 100).toFixed(2),
        r.maxBidCents == null ? '' : (r.maxBidCents / 100).toFixed(2),
        r.bidder, r.bidderName ?? '',
        data?.series?.[r.id]?.length ?? 0,
        r.lastAuditedCents == null ? '' : (r.lastAuditedCents / 100).toFixed(2),
        r.unrecorded ? 'yes' : 'no',
        r.effectiveMaxCpcCents == null ? '' : (r.effectiveMaxCpcCents / 100).toFixed(2),
        r.placementPct || '', r.biddingStrategy ?? '',
        resolveBidStates(r, Number.MAX_SAFE_INTEGER).map((c) => c.label).join(' | ')])
      : campaigns.map((r) => [r.name, r.market, r.status, r.bidder, r.bidderName ?? '', r.outOfBand, r.targets, r.measured,
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

      {/* S1 — the bidder band, above the grid where the seam comment placed it. */}
      <BidBidderBand {...slotProps} />

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
              {/* S3 — a REAL link at last (the two CSS rules that un-blued it are deleted): it
                  opens the target's drawer via ?target=, so middle-click and Back both behave. */}
              <Link
                href={targetHref(r.id)}
                scroll={false}
                className={r.derived ? 't derived' : 't'}
                title={r.derived
                  ? `This target has no text expression — Amazon identifies it by its targeting group. Shown as "${r.label}", derived from ${r.match.replace(/_/g, ' ').toLowerCase()}. Opens the bid curve.`
                  : `${r.label} — open the bid curve`}
              >{r.label}</Link>
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
          /* BID.S4 — the first write section replaced NO_WRITE_ACTIONS: selection carries the
             three verbs (Set bid · Boost % · Bid to win), every write gated + grace-held. */
          selectable
          selectionActions={(ids, clearSel) => (
            <BidSelectionActions ids={ids} clear={clearSel} rows={rows} reload={slotProps.reload} />
          )}
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

      {/* S3 — the target drawer. The row and its series come from the loaded payload when the
          target is in view; a deep link outside it fetches only the curve and says so. */}
      {reserved.target && (
        <BidTargetDrawer
          targetId={reserved.target}
          row={(view === 'targets' ? (rows as BidTargetRow[]) : []).find((r) => r.id === reserved.target) ?? null}
          series={data?.series?.[reserved.target]}
          loading={loading}
          onClose={closeTarget}
        />
      )}

      {/* S6 — the bidder assignment dialog, opened from a campaign row's Bidder cell. */}
      {goalFor != null && (
        <BidGoalDialog
          campaign={goalFor}
          onClose={() => setGoalFor(null)}
          onDone={() => { setGoalFor(null); slotProps.reload() }}
        />
      )}

      {/* S7 — rules as declared exceptions to a campaign's bidder. Replaced the provisional
          RuleListTab (the old tab, moved unchanged); rule records live on Automations. */}
      <BidRules />
    </div>
  )
}

/**
 * BID.S2 — the band, and the bid's position inside it.
 *
 * 🔴 Three renderings, because three things are true of different rows and only one of them is
 * "here is a range":
 *
 *   · **both ends set** — a bar with the bid's position marked. No campaign is in this state today.
 *   · **one end set** (82 campaigns, ceiling only) — the number and the word, no bar. Inventing a
 *     bar for a half-open interval means choosing an arbitrary other end and drawing it.
 *   · **neither** — "not set", muted. NOT "€0.00 – €0.00", which is a floor of zero: a different
 *     and much stronger claim than the absence of one, and the gap S5 exists to close.
 */
function BandCell({ r }: { r: BidTargetRow }) {
  const { minBidCents: lo, maxBidCents: hi, bidCents: bid } = r
  if (lo == null && hi == null) {
    return <span className="h10-bd-band none" title="No floor and no ceiling declared on this campaign. Not a band of zero — nothing is declared, so the write gate has nothing to enforce and the only floors in play are the engine's own constants.">not set</span>
  }
  if (lo != null && hi != null) {
    const posRaw = (bid - lo) / Math.max(1, hi - lo)
    const pos = Math.max(0, Math.min(1, posRaw))
    return (
      <span className={`h10-bd-band${bid > hi || bid < lo ? ' out' : ''}`} title={`Allowed ${eur(lo)} – ${eur(hi)}; this bid is ${eur(bid)}.`}>
        <span className="rail"><i style={{ left: `${(pos * 100).toFixed(1)}%` }} /></span>
        <b>{eur(lo)}–{eur(hi)}</b>
      </span>
    )
  }
  // One end only. Say which end it is — a bare number here would read as the other one.
  const out = hi != null && bid > hi
  return (
    <span className={`h10-bd-band half${out ? ' out' : ''}`} title={hi != null
      ? `Ceiling ${eur(hi)}, no floor declared. This bid is ${eur(bid)}${out ? ' — above the ceiling. The gate refuses writes outside the band but never pulls an existing bid in.' : '.'}`
      : `Floor ${eur(lo!)}, no ceiling declared. This bid is ${eur(bid)}.`}>
      <i className="cap">{hi != null ? 'max' : 'min'}</i><b>{eur((hi ?? lo)!)}</b>
    </span>
  )
}

/** Who owns this campaign's bids. `none` is loud on purpose — it is the page's largest finding. */
function BidderCell({ kind, name }: { kind: BidderKind; name: string | null }) {
  if (kind === 'none') {
    return <span className="h10-bd-bidder none" title="No rank schedule, no target-ACoS goal, and no operator has moved a bid in this campaign in 60 days. Nothing automated will change this bid. 41 of the 86 enabled campaigns are in this position and 26 of them spent money last month.">No bidder</span>
  }
  if (kind === 'schedule') {
    return <span className="h10-bd-bidder sched" title={`Bid by the rank schedule “${name}”. It floors bids at 00:00 Rome and restores them at 08:00.`}>{name ?? 'Schedule'}</span>
  }
  if (kind === 'goal') {
    return <span className="h10-bd-bidder goal" title="Bid by the target-ACoS optimiser. Set on 0 of 220 campaigns today — this value is reachable and currently unused.">Goal</span>
  }
  return <span className="h10-bd-bidder manual" title="An operator moved a bid in this campaign in the last 60 days, and nothing automated owns it.">Manual</span>
}

/** At most two chips, most decision-changing first. The vocabulary lives in `bidState.ts`. */
function StateCell({ r }: { r: BidTargetRow }) {
  const chips = resolveBidStates(r)
  if (chips.length === 0) return <span className="h10-bd-nd" title="Nothing notable about this bid's state.">—</span>
  return (
    <span className="h10-bd-states">
      {chips.map((c) => <span key={c.key} className={`h10-bd-chip ${c.tone}`} title={c.title}>{c.label}</span>)}
    </span>
  )
}

/** The most one click can cost. Blank rather than a copy of Bid when nothing lifts it. */
function EffCpcCell({ r }: { r: BidTargetRow }) {
  if (r.effectiveMaxCpcCents == null) {
    return <span className="h10-bd-nd" title="No placement multiplier and a strategy that cannot raise a bid, so the most a click can cost is the bid itself.">—</span>
  }
  return (
    <span className="h10-bd-eff" title={`Bid ${eur(r.bidCents)}${r.placementPct > 0 ? ` × +${r.placementPct}% placement` : ''}${r.biddingStrategy === 'AUTO_FOR_SALES' ? ' × up-and-down bidding (up to +100% at top of search)' : ''} ⇒ at most ${eur(r.effectiveMaxCpcCents)} per click. The write gate binds the BASE bid, not this number.`}>
      {eur(r.effectiveMaxCpcCents)}
      {r.placementPct > 0 && <i>+{r.placementPct}%</i>}
    </span>
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
