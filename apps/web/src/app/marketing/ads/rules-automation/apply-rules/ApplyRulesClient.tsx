'use client'

/**
 * AR.S0 — Apply Rules, promoted from the landing tab to its own page.
 *
 * The page answers: **what is automation allowed to do here, what has it done, and what is that
 * costing?** S0 builds the half of that sentence which is a *row* — a grid that works at four
 * grains over one merged payload. The other half is S1–S9, and every one of them is a slot in
 * `ApplyRulesSections`.
 *
 * 🔴 **Read-only, and stated rather than implied.** Nothing on this page writes in S0. The grid's
 * write-capable props are passed as explicit nulls via `NO_WRITE_ACTIONS`, because "this page has
 * not got round to writes" and "this page does not write" are different claims and an omitted prop
 * can only make the first one.
 *
 * What replaced the tab: `?tab=rules` renders five columns copied from Helium 10, and three of them
 * are fiction — `Bid Rule` reads a field no API returns, `Budget Rule` renders a hard-coded
 * "None", and `Min/Max Bid` reads `c.minMaxBid`, **a key the payload does not contain**, so it
 * prints "None" on all 220 rows while `minBidCents`/`maxBidCents` sit unread in the same response.
 * Every one of the five returns a single identical value on all 220 rows. **S0 carries none of
 * them forward**; S3 replaces them with the real fields.
 *
 * ── Four things this page refuses to blur, each one measured on prod 2026-08-12 ─────────────────
 *
 *   1. **A grain is not a filter.** A scope bar that only narrowed rows was built on this surface
 *      once and reverted, because no pixel changed that a filter could not have changed. Here the
 *      switch changes what a ROW IS: 220 campaigns · 13 portfolios · 14 product lines · 4 markets.
 *      Market stays the filter, in the header, and the two compose.
 *   2. **Line-grain rows overlap and portfolio rows do not.** A campaign advertises products from
 *      more than one line, so Σ(per-line campaigns) = **224** against **220** campaigns. Portfolio
 *      rows sum to exactly 220. The line grain therefore carries a `reachNote` on every row and its
 *      total is never presented as an account total.
 *   3. **An aggregate row has no `managed` boolean.** A market is not managed; a fraction of its
 *      campaigns are. Every governance fact on a non-campaign row is a count out of `n`.
 *   4. **A refusal is not a failure.** A scope that cannot resolve (a campaign that is not in the
 *      chosen portfolio) is a refusal, and it renders differently and in a different colour from a
 *      read that broke. Substrate §5.6 — four empty states, not three.
 *
 * ── 🔴 The liveness claim this page does NOT make ───────────────────────────────────────────────
 *
 * The ads SSE bus carries 0.21% of writes and the engines publish nothing to it, so this page polls
 * a cursor — `_shared/useCursorPoll`, reused unchanged. **But Apply Rules has no cursor endpoint
 * yet.** The hook is wired at `GET /advertising/apply-rules/cursor`, which does not exist; by the
 * hook's own rule 3 a failed poll is silent, so today no banner can appear, no error reaches the
 * page, and `lastCheckedAt` stays `null`. That null is the armed signal, and it is in the slot
 * contract so that no later section renders an "as of" while the poll has never succeeded.
 *
 * TODO(AR.S5) — the route this is waiting for. Three fields and only three:
 *     { campaignsAt: max(Campaign.updatedAt) in scope,
 *       loggedAt:    max(AdvertisingActionLog.loggedAt) where entityType='CAMPAIGN',
 *       n:           row count }
 * `n` is there because neither timestamp moves on a create or a delete. Do not copy Bid's cursor
 * (it rejected the audit log as load-bearing) or Budget's (it rejected the row timestamp) without
 * re-measuring: this page's subject is the write gate, the bounds and the pins, which move on a
 * third path again.
 *
 * ── One staleness floor nothing on the client can fix ───────────────────────────────────────────
 *
 * `GET /advertising/campaigns` sits behind `cached(key, 300)` (L1 memory + L2 Redis) and the
 * invalidating hook fires `void flushAdsCache()` AFTER the response is sent, so a client refetching
 * immediately after a write can race it. **Five minutes is the floor whatever this page does**, and
 * the page says so rather than implying otherwise with a spinner.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, Info, RefreshCw } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { useCursorPoll } from '../_shared/useCursorPoll'
import { getBackendUrl } from '@/lib/backend-url'
import { NoDataIllus } from '../_shared/NoDataIllus'
import {
  DELIVERY_LABEL, MARKETS, STATUS_LABEL,
  type CampaignRow, type GuardrailPayload, type RawCampaign, type RawGuardrailRow,
  type ScopeOptionsPayload,
} from './types'
import {
  APPLY_RULES_GRAINS, GRAIN_LABEL, NO_WRITE_ACTIONS,
  type AggregateRow, type ApplyRulesGrain, type ApplyRulesScope, type ApplyRulesSlotProps,
  type ApplyRulesTotals,
} from './slot-contract'
import { ApplyRulesSections } from './ApplyRulesSections'

const DEFAULT_MARKET = 'all'
const DEFAULT_GRAIN: ApplyRulesGrain = 'campaign'

/** Campaigns that advertise no product line at all. A real row, not a bucket for missing data. */
const NO_LINE_KEY = '__no_line__'
/** 148 of 220 campaigns carry no portfolio. The largest row on the portfolio grain is this one. */
const NO_PORTFOLIO_KEY = '__no_portfolio__'

const num = (n: number) => n.toLocaleString('en-IE')
// No money formatter here on purpose. `dailyBudgetCents` is carried on every row and every
// aggregate — S1's band and S4's columns need it — but S0 renders no metric column, because "no
// date control on Apply Rules" is conditioned on exactly that. S4 adds the formatter with the
// column and the control, together.

/**
 * 🔴 The market sentinel is the string 'all', and on this page it is *structurally* impossible to
 * send it anywhere. `?marketplace=all` is a real filter value that matches a marketplace of that
 * literal name and returns zero rows with no error — probed again on 2026-08-12: HTTP 200,
 * `items: []`. This page fetches every campaign once and resolves market client-side, so no market
 * value is ever put into a request at all.
 */
const inMarket = (r: CampaignRow, market: string) => market === DEFAULT_MARKET || r.market === market

export function ApplyRulesClient() {
  const router = useRouter()
  const params = useSearchParams()

  // ── the URL contract ──────────────────────────────────────────────────────────────────────────
  // Every view is linkable and an absent param means its documented default, never a stored
  // preference, so a link renders the same view for whoever opens it. The one deliberate exception
  // the substrate names is `market`, which falls back to the provider's persisted choice because a
  // market is a place you are working in rather than a view of a dataset.
  const market = params.get('market') ?? DEFAULT_MARKET
  const grainParam = params.get('grain') ?? DEFAULT_GRAIN
  const grain: ApplyRulesGrain = (APPLY_RULES_GRAINS as readonly string[]).includes(grainParam)
    ? (grainParam as ApplyRulesGrain)
    : DEFAULT_GRAIN
  const scope: ApplyRulesScope = {
    market,
    line: params.get('line') ?? '',
    portfolio: params.get('portfolio') ?? '',
    campaign: params.get('campaign') ?? '',
  }
  const q = params.get('q') ?? ''
  const sortParam = params.get('sort') ?? ''
  const dirParam = params.get('dir') === 'asc' ? 'asc' : 'desc'
  const statusFilter = (params.get('status') ?? '').split(',').filter(Boolean)
  const deliveryFilter = (params.get('delivery') ?? '').split(',').filter(Boolean)

  // 🔴 Reserved for S7. Parsed into the slot contract from day one and read by NOBODY in S0, so a
  // link someone shares today survives the section that gives it meaning.
  const row = params.get('row')
  const drawer = params.get('drawer')

  const [campaigns, setCampaigns] = useState<RawCampaign[] | null>(null)
  const [guardrails, setGuardrails] = useState<GuardrailPayload | null>(null)
  const [options, setOptions] = useState<ScopeOptionsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  /** The one writer of page state. '' or a default value deletes the param. */
  const push = useCallback((patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      const isDefault = !v
        || (k === 'market' && v === DEFAULT_MARKET)
        || (k === 'grain' && v === DEFAULT_GRAIN)
        || (k === 'dir' && v === 'desc')
      if (isDefault) next.delete(k)
      else next.set(k, v)
    }
    const qs = next.toString()
    // `push`, not `replace`: back and forward have to walk the filter history. A grid whose filters
    // cannot be undone with the browser's own back button is a grid people stop filtering.
    router.push(qs ? `?${qs}` : '?', { scroll: false })
  }, [params, router])

  // ── the read ──────────────────────────────────────────────────────────────────────────────────
  // Three deployed endpoints, fetched once and unfiltered, every grain resolved client-side. 220
  // rows is small, the grain aggregates need the whole account anyway, and resolving reach on the
  // client off `scope-options` is what makes a later reach preview unable to disagree with what
  // enforcement does.
  useEffect(() => {
    let alive = true
    setLoading(true)
    const backend = getBackendUrl()
    const get = async <T,>(path: string, label: string): Promise<T> => {
      const r = await fetch(`${backend}${path}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`Could not load ${label} (${r.status})`)
      return r.json() as Promise<T>
    }
    void Promise.all([
      get<{ items?: RawCampaign[] }>('/api/advertising/campaigns?limit=500', 'the campaigns'),
      get<GuardrailPayload>('/api/advertising/control-room/guardrail-grid?limit=500', 'the write gate'),
      get<ScopeOptionsPayload>('/api/advertising/scope-options', 'the product lines'),
    ])
      .then(([c, g, o]) => {
        if (!alive) return
        setCampaigns(c.items ?? [])
        setGuardrails(g)
        setOptions(o)
        setError(null)
      })
      .catch((e: unknown) => {
        // Kept, never swallowed: substrate §5.6 needs "broke" to render differently from "empty",
        // and a `.catch(() => [])` makes that distinction unbuildable above this line.
        if (alive) { setError((e as Error).message); setCampaigns(null); setGuardrails(null) }
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [reloadTick])

  // ── the merge ─────────────────────────────────────────────────────────────────────────────────
  const allRows: CampaignRow[] = useMemo(() => {
    if (!campaigns) return []
    const byId = new Map<string, RawGuardrailRow>((guardrails?.rows ?? []).map((r) => [r.id, r]))
    // A campaign appears under every line that lists it, which is exactly why the line grain
    // over-counts. The map is built once from `scope-options` rather than per row.
    const linesOf = new Map<string, string[]>()
    for (const l of options?.productLines ?? []) {
      for (const cid of l.campaigns) {
        const cur = linesOf.get(cid)
        if (cur) cur.push(l.id)
        else linesOf.set(cid, [l.id])
      }
    }
    return campaigns.map((c) => {
      const g = byId.get(c.id)
      const pins = {
        placement: !!g?.pins?.placement, bids: !!g?.pins?.bids, budget: !!g?.pins?.budget,
      }
      return {
        id: c.id,
        name: c.name,
        market: c.marketplace ?? '—',
        status: c.status,
        deliveryStatus: c.deliveryStatus ?? null,
        type: c.type ?? c.adProduct ?? '',
        externalCampaignId: c.externalCampaignId ?? null,
        // 🔴 EUROS → cents, exactly once and only here. See `types.ts`.
        dailyBudgetCents: Math.round((Number(c.dailyBudget) || 0) * 100),
        biddingStrategy: c.biddingStrategy ?? null,
        portfolioId: c.portfolioId ?? null,
        portfolioName: g?.portfolioName ?? null,
        lineIds: linesOf.get(c.id) ?? [],
        managed: !!g?.managed,
        minBidCents: g?.minBidCents ?? null,
        maxBidCents: g?.maxBidCents ?? null,
        pinned: pins.placement || pins.bids || pins.budget,
        pins,
        suppressedAt: g?.suppressedAt ?? null,
        suppressedBy: g?.suppressedBy ?? null,
        authorityMissing: !g,
      }
    })
  }, [campaigns, guardrails, options])

  const portfolioNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of options?.portfolios ?? []) m.set(p.externalPortfolioId, p.name)
    // The guardrail grid carries a non-null `portfolioName`; `GET /advertising/portfolios` returns
    // its array under `portfolios` and not `items`, which is why a previous "fix" to show names was
    // verified by reading the diff and never worked. This page never calls that route.
    for (const r of guardrails?.rows ?? []) if (r.portfolioId && r.portfolioName) m.set(r.portfolioId, r.portfolioName)
    return m
  }, [options, guardrails])

  const lineNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of options?.productLines ?? []) m.set(l.id, l.sku)
    return m
  }, [options])

  // ── scope resolution ──────────────────────────────────────────────────────────────────────────
  // The four grains AND together, exactly as `ruleMatchesScope()` ANDs them.
  const scoped = useMemo(() => allRows.filter((r) => {
    if (!inMarket(r, market)) return false
    if (scope.portfolio && r.portfolioId !== scope.portfolio) return false
    if (scope.line && !r.lineIds.includes(scope.line)) return false
    if (scope.campaign && r.id !== scope.campaign) return false
    return true
  }), [allRows, market, scope.portfolio, scope.line, scope.campaign])

  /**
   * 🔴 Portfolio ⇄ campaign are mutually exclusive under AND, and that is provably right: a
   * campaign has at most one portfolio, so holding both is either redundant or contradictory. When
   * it is contradictory the page says so — a REFUSAL, which is not a failure and is not the same
   * colour as one.
   */
  const contradiction = useMemo(() => {
    if (!campaigns) return null
    const c = scope.campaign ? allRows.find((r) => r.id === scope.campaign) : null
    if (scope.campaign && !c) return 'That campaign is not in this account.'
    if (c && scope.portfolio && c.portfolioId !== scope.portfolio) {
      const pf = portfolioNames.get(scope.portfolio) ?? scope.portfolio
      return `${c.name} is not in ${pf}. A campaign has at most one portfolio, so these two cannot both hold.`
    }
    if (c && scope.line && !c.lineIds.includes(scope.line)) {
      const ln = lineNames.get(scope.line) ?? scope.line
      return `${c.name} does not advertise ${ln}.`
    }
    if (c && !inMarket(c, market)) return `${c.name} is a ${c.market} campaign, and this view is filtered to ${market}.`
    return null
  }, [campaigns, allRows, scope.campaign, scope.portfolio, scope.line, market, portfolioNames, lineNames])

  const appliedScope = useMemo(() => {
    const bits: string[] = []
    if (market !== DEFAULT_MARKET) bits.push(market)
    if (scope.portfolio) bits.push(portfolioNames.get(scope.portfolio) ?? scope.portfolio)
    if (scope.line) bits.push(lineNames.get(scope.line) ?? scope.line)
    if (scope.campaign) bits.push(allRows.find((r) => r.id === scope.campaign)?.name ?? scope.campaign)
    return bits
  }, [market, scope.portfolio, scope.line, scope.campaign, portfolioNames, lineNames, allRows])

  // ── the rows the grid renders ─────────────────────────────────────────────────────────────────
  const search = q.trim().toLowerCase()

  const campaignRows = useMemo(() => scoped.filter((r) => {
    if (statusFilter.length && !statusFilter.includes(r.status)) return false
    if (deliveryFilter.length && !deliveryFilter.includes(r.deliveryStatus ?? '')) return false
    if (search && !r.name.toLowerCase().includes(search)) return false
    return true
  }), [scoped, statusFilter.join(','), deliveryFilter.join(','), search])

  const aggregates: AggregateRow[] = useMemo(() => {
    if (grain === 'campaign') return []
    const pass = (r: CampaignRow) => (search ? r.name.toLowerCase().includes(search) : true)
    const make = (key: string, label: string, list: CampaignRow[], reachNote: string | null): AggregateRow => ({
      key, label,
      n: list.length,
      live: list.filter((r) => r.status === 'ENABLED').length,
      managed: list.filter((r) => r.managed).length,
      bounded: list.filter((r) => r.minBidCents != null || r.maxBidCents != null).length,
      pinned: list.filter((r) => r.pinned).length,
      delivering: list.filter((r) => r.deliveryStatus === 'DELIVERING').length,
      dailyBudgetCents: list.reduce((s, r) => s + r.dailyBudgetCents, 0),
      reachNote,
      campaignIds: list.map((r) => r.id),
    })
    const base = scoped.filter(pass)

    if (grain === 'market') {
      // Every market that has a campaign, in descending size. No campaign carries a null
      // marketplace today; if one ever does it gets its own row rather than disappearing.
      const keys = Array.from(new Set(base.map((r) => r.market)))
      return keys
        .map((m) => make(m, m, base.filter((r) => r.market === m), null))
        .sort((a, b) => b.n - a.n)
    }

    if (grain === 'portfolio') {
      // 🔴 Every portfolio renders, including the two that hold nothing. "State what is empty and
      // why" — a portfolio missing from the list is indistinguishable from a portfolio that does
      // not exist, and one of these two is a real object an operator created.
      const out = (options?.portfolios ?? []).map((p) => make(
        p.externalPortfolioId, p.name,
        base.filter((r) => r.portfolioId === p.externalPortfolioId),
        null,
      ))
      const orphans = base.filter((r) => !r.portfolioId)
      out.push(make(NO_PORTFOLIO_KEY, 'No portfolio', orphans,
        'These campaigns carry no portfolio at all, so no portfolio-scoped rule can reach them.'))
      return out.sort((a, b) => b.n - a.n)
    }

    // 🔴 line grain — the rows OVERLAP. A campaign advertising products from two lines is counted
    // under both, so Σ n is 224 against 220 campaigns. The note rides every row rather than sitting
    // in a footnote, because the sum is the thing a reader will do in their head.
    const overlap = 'A campaign advertising more than one product line is counted under each, so these counts sum to more than the account.'
    const out = (options?.productLines ?? []).map((l) => make(
      l.id, l.sku, base.filter((r) => r.lineIds.includes(l.id)), overlap,
    ))
    const none = base.filter((r) => r.lineIds.length === 0)
    out.push(make(NO_LINE_KEY, 'Advertising nothing', none,
      'These campaigns are not linked to any product, so no product-scoped rule can reach them.'))
    return out.sort((a, b) => b.n - a.n)
  }, [grain, scoped, options, search])

  // ── the account's numbers ─────────────────────────────────────────────────────────────────────
  const totals: ApplyRulesTotals | null = useMemo(() => {
    if (!guardrails || !campaigns) return null
    const t = guardrails.totals ?? {}
    const live = allRows.filter((r) => r.status === 'ENABLED')
    const paused = allRows.filter((r) => r.status === 'PAUSED')
    return {
      // Straight from the endpoint two other screens already read. Not recounted here, or this page
      // and the Control Room would drift.
      campaigns: t.campaigns ?? allRows.length,
      managed: t.managed ?? 0,
      withMinBid: t.withMinBid ?? 0,
      withMaxBid: t.withMaxBid ?? 0,
      pinned: t.pinned ?? 0,
      suppressed: t.suppressed ?? 0,
      accountWideRules: guardrails.accountWideRules ?? 0,
      accountWideRulesIncludesMarketScoped: true,
      live: live.length,
      paused: paused.length,
      archived: allRows.filter((r) => r.status === 'ARCHIVED').length,
      delivering: allRows.filter((r) => r.deliveryStatus === 'DELIVERING').length,
      liveNotDelivering: live.filter((r) => r.deliveryStatus === 'NOT_DELIVERING').length,
      liveDailyBudgetCents: live.reduce((s, r) => s + r.dailyBudgetCents, 0),
      pausedDailyBudgetCents: paused.reduce((s, r) => s + r.dailyBudgetCents, 0),
    }
  }, [guardrails, campaigns, allRows])

  // ── the refresh cursor ────────────────────────────────────────────────────────────────────────
  // See the file header: the endpoint does not exist yet, the poll fails silently by design, and
  // `lastCheckedAt === null` is what a later section must check before claiming anything is live.
  const cursorParams = useMemo(() => {
    const p: Record<string, string> = { market, grain }
    for (const [k, v] of Object.entries({ line: scope.line, portfolio: scope.portfolio, campaign: scope.campaign })) {
      if (v) p[k] = v
    }
    return p
  }, [market, grain, scope.line, scope.portfolio, scope.campaign])

  const refresh = useCursorPoll<Record<string, unknown>>({
    url: `${getBackendUrl()}/api/advertising/apply-rules/cursor`,
    params: cursorParams,
    baseline: null,
  })

  const slotProps: ApplyRulesSlotProps = {
    scope, grain,
    rows: campaignRows,
    allRows,
    aggregates,
    totals,
    loading,
    error,
    stale: refresh.stale,
    lastCheckedAt: refresh.lastCheckedAt,
    push,
    reload: () => setReloadTick((n) => n + 1),
    row, drawer,
  }

  const onSortChange = useCallback((s: { key: string; dir: 'asc' | 'desc' } | null) => {
    push({ sort: s ? s.key : '', dir: s ? s.dir : '' })
  }, [push])

  /**
   * 🔴 A `?sort=` belongs to a grain, because the grains do not share a column set. `?sort=live`
   * pasted onto the campaign grain names a column that does not exist there, and the grid would
   * render a sorted-looking header over rows in their original order. An unknown key is dropped
   * rather than honoured — and switching grain clears it, so the URL never carries a key its own
   * view cannot use.
   */
  const SORTABLE: Record<ApplyRulesGrain, string[]> = {
    campaign: ['__first', 'status', 'delivery', 'portfolio', 'lines'],
    market: ['__first', 'n', 'live', 'delivering'],
    portfolio: ['__first', 'n', 'live', 'delivering'],
    line: ['__first', 'n', 'live', 'delivering'],
  }
  const sortKey = SORTABLE[grain].includes(sortParam) ? sortParam : ''

  // ── campaign-grain columns ────────────────────────────────────────────────────────────────────
  //
  // 🔴 The old grid has NO STATUS COLUMN — status lives only inside a hover card, on a grid whose
  // Status filter's resting label reads "Enabled" inside a panel that loads collapsed while all 220
  // rows render. Status and Delivery are both here, side by side, because they are different facts:
  // measured 2026-08-12, 5 ENABLED campaigns are NOT_DELIVERING.
  const campaignColumns: GridColumn<CampaignRow>[] = useMemo(() => [
    {
      key: 'status',
      label: 'Status',
      metric: false,
      tip: 'What the campaign itself is set to. Amazon enforces it; nothing on this page changes it.',
      sortValue: (r) => r.status,
      render: (r) => (
        <span className={`h10-ar-pill st-${r.status.toLowerCase()}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
      ),
    },
    {
      key: 'delivery',
      label: 'Delivery',
      metric: false,
      tip: 'Whether Amazon is actually serving this campaign right now. Enabled and delivering are different facts — a campaign can be enabled and serve nothing. This value moves through the day; it is read at the same moment as everything else on this page.',
      sortValue: (r) => r.deliveryStatus ?? '',
      render: (r) => {
        if (!r.deliveryStatus) return <span className="h10-ar-nd" title="Amazon has not reported a delivery state for this campaign">not reported</span>
        const live = r.deliveryStatus === 'DELIVERING'
        // 🔴 The footgun, on the one row shape where it matters. Resuming a PAUSED campaign does NOT
        // re-open the write gate: the write is refused at `campaign_allowlist`, and the gate's own
        // comment calls that the intended trade. So an enabled, non-delivering, gate-shut campaign
        // is a campaign nothing may correct — which should be visible rather than quiet.
        const shut = r.status === 'ENABLED' && !live && !r.managed
        return (
          <span className={`h10-ar-pill dl-${live ? 'on' : 'off'}`}
            title={shut
              ? 'Enabled, not delivering, and the write gate is shut — automation matches this campaign and every write to it is refused at campaign_allowlist. Resuming a campaign does not re-open the gate.'
              : DELIVERY_LABEL[r.deliveryStatus] ?? r.deliveryStatus}
          >
            {DELIVERY_LABEL[r.deliveryStatus] ?? r.deliveryStatus}
            {shut && <i className="h10-ar-flag" aria-hidden="true">!</i>}
          </span>
        )
      },
    },
    {
      key: 'portfolio',
      label: 'Portfolio',
      metric: false,
      tip: 'The portfolio grain, on a campaign row. 148 of 220 campaigns carry no portfolio at all, so no portfolio-scoped rule can reach them.',
      sortValue: (r) => (r.portfolioId ? (r.portfolioName ?? portfolioNames.get(r.portfolioId) ?? '') : '￿'),
      render: (r) => (r.portfolioId
        ? (
          <button type="button" className="h10-ar-lnk" onClick={() => push({ portfolio: r.portfolioId ?? '', grain: 'campaign' })}>
            {r.portfolioName ?? portfolioNames.get(r.portfolioId) ?? r.portfolioId}
          </button>
        )
        : <span className="h10-ar-nd" title="No portfolio — a portfolio-scoped rule cannot reach this campaign">none</span>),
    },
    {
      key: 'lines',
      label: 'Product lines',
      metric: false,
      tip: 'Which product lines this campaign advertises. A campaign can advertise more than one, which is why the product-line grain counts more campaigns than the account has.',
      sortValue: (r) => r.lineIds.length,
      render: (r) => {
        if (!r.lineIds.length) return <span className="h10-ar-nd" title="This campaign advertises no product we hold — no product-scoped rule can reach it">advertising nothing</span>
        const names = r.lineIds.map((id) => lineNames.get(id) ?? id)
        return (
          <button type="button" className="h10-ar-lnk" title={names.join(' · ')}
            onClick={() => push({ line: r.lineIds[0], grain: 'campaign' })}>
            {names[0]}{names.length > 1 ? ` +${names.length - 1}` : ''}
          </button>
        )
      },
    },
  ], [portfolioNames, lineNames, push])

  // ── aggregate-grain columns ───────────────────────────────────────────────────────────────────
  //
  // Every column renders at all four grains or it does not ship. Status on a market row is not a
  // status, it is a fraction — so it is rendered as one, out of the row's own `n`.
  const aggregateColumns: GridColumn<AggregateRow>[] = useMemo(() => [
    {
      key: 'n',
      label: 'Campaigns',
      tip: 'How many campaigns this row is. On the product-line grain these sum to more than the account, because a campaign advertising two lines is counted under both.',
      sortValue: (r) => r.n,
      render: (r) => (r.n === 0
        ? <span className="h10-ar-nd" title="This exists and holds no campaign. It is shown rather than hidden, because a missing row and an empty one look identical.">0</span>
        : num(r.n)),
      // A function total, so it reacts to the search. On the line grain this deliberately reads 224
      // against 220 campaigns — the double-count made visible rather than quietly summed away.
      total: (rows) => num(rows.reduce((s, r) => s + r.n, 0)),
    },
    {
      key: 'live',
      label: 'Enabled',
      tip: 'Campaigns in this row whose own status is ENABLED. Paused campaigns still hold their daily budget.',
      sortValue: (r) => r.live,
      render: (r) => (r.n === 0 ? <span className="h10-ar-nd">—</span> : <><b>{num(r.live)}</b><span className="h10-ar-of"> of {num(r.n)}</span></>),
      total: (rows) => num(rows.reduce((s, r) => s + r.live, 0)),
    },
    {
      key: 'delivering',
      label: 'Delivering',
      tip: 'Campaigns Amazon is actually serving. Enabled and delivering are different facts, which is why this is not the same number as Enabled.',
      sortValue: (r) => r.delivering,
      render: (r) => (r.n === 0 ? <span className="h10-ar-nd">—</span> : <><b>{num(r.delivering)}</b><span className="h10-ar-of"> of {num(r.n)}</span></>),
      total: (rows) => num(rows.reduce((s, r) => s + r.delivering, 0)),
    },
  ], [])

  // ── filters ───────────────────────────────────────────────────────────────────────────────────
  //
  // 🔴 `placeholder: 'All'`, because that is what an unset multiselect DOES. The tab this page
  // replaces renders a Status control whose resting label reads "Enabled" while all 220 rows are on
  // screen — a control naming a filter it is not applying. The population is stated honestly
  // instead, and no hidden default filter is added.
  const filters: GridFilter[] = useMemo(() => (grain === 'campaign' ? [
    {
      key: '__status', label: 'Status', kind: 'multiselect', placeholder: 'All',
      options: ['ENABLED', 'PAUSED', 'ARCHIVED'].map((v) => ({ value: v, label: STATUS_LABEL[v] })),
      value: (r) => (r as CampaignRow).status,
    },
    {
      key: '__delivery', label: 'Delivery', kind: 'multiselect', placeholder: 'All',
      options: [
        { value: 'DELIVERING', label: 'Delivering' },
        { value: 'NOT_DELIVERING', label: 'Not delivering' },
      ],
      value: (r) => (r as CampaignRow).deliveryStatus ?? '',
    },
  ] : []), [grain])

  const initialFilters = useMemo(
    () => ({ __status: statusFilter, __delivery: deliveryFilter }),
    [statusFilter.join(','), deliveryFilter.join(',')],
  )

  const onFilterChange = useCallback((next: Record<string, unknown>) => {
    const list = (k: string) => (Array.isArray(next[k]) ? (next[k] as string[]).join(',') : '')
    push({ status: list('__status'), delivery: list('__delivery') })
  }, [push])

  // ── the toolbar ───────────────────────────────────────────────────────────────────────────────
  //
  // 🔴 `?q=` is owned here rather than handed to the grid. `AdsDataGrid` keeps `search`, `page` and
  // `rowsPerPage` in private state with no seed and no callback, so a search typed into the grid
  // cannot reach the URL and a `?q=` in the URL cannot reach the grid. One search box, and it is
  // linkable. (`?page=` is deliberately not emitted for the same reason — a param that cannot
  // restore the view it names is worse than no param.)
  const searchBox = (
    <span className="h10-ar-search">
      <input
        type="search" defaultValue={q} placeholder="Search by name…" aria-label="Search"
        onKeyDown={(e) => { if (e.key === 'Enter') push({ q: (e.target as HTMLInputElement).value }) }}
        onBlur={(e) => { if (e.target.value !== q) push({ q: e.target.value }) }}
      />
    </span>
  )

  const toolbarLeft = (
    <span className="h10-ar-tools">
      {/* The grain switch. 🔴 `.h10-svt-seg` carries `margin: 10px 24px 0` (`rules-automation.css`
          :523) and is where the 24px pattern on this page gets copied from — the page gutter here
          is 0, so that margin is zeroed under `.h10-ar-tools` rather than inherited. */}
      <span className="h10-svt-seg" role="tablist" aria-label="Grain">
        {APPLY_RULES_GRAINS.map((g) => (
          <button
            key={g} type="button" role="tab" aria-selected={grain === g}
            className={`seg ${grain === g ? 'on' : ''}`}
            onClick={() => push({ grain: g, sort: '', dir: '' })}
            title={g === 'campaign'
              ? 'One row per campaign — the grain the write gate, the bounds and the pins are set at'
              : g === 'portfolio'
                ? 'One row per portfolio. 148 of 220 campaigns carry none, so they group under "No portfolio".'
                : g === 'line'
                  ? 'One row per product line. A campaign advertising two lines appears under both, so these rows sum to more than the account.'
                  : 'One row per marketplace.'}
          >{GRAIN_LABEL[g]}</button>
        ))}
      </span>
      {searchBox}
    </span>
  )

  const toolbarRight = refresh.stale ? (
    <button type="button" className="h10-ar-stale" onClick={() => setReloadTick((n) => n + 1)}
      title="Something changed since this view was loaded. Nothing has been reordered underneath you — click to pick it up.">
      <RefreshCw size={12} /> Changed since you loaded
    </button>
  ) : null

  const activeTab = rulesTabByKey('rules')

  /** The one sentence stating what resolved. */
  const resolution = (() => {
    if (loading || !campaigns) return null
    const bits = [appliedScope.length ? appliedScope.join(' · ') : 'All markets']
    bits.push(`${num(scoped.length)} of ${num(allRows.length)} campaigns`)
    if (grain !== 'campaign') bits.push(`${num(aggregates.length)} ${GRAIN_LABEL[grain].toLowerCase()}`)
    return bits.join(' · ')
  })()

  const clearScope = () => push({ market: '', portfolio: '', line: '', campaign: '', status: '', delivery: '', q: '' })

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Apply Rules"
        subtitle={activeTab?.subtitle ?? 'Which campaigns automation may write to, and what it is allowed to change'}
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => push({ market: m, campaign: '' })}
        showLearn={false}
        showDataSync={false}
        /* No date control. This grid has no metric column, so nothing on the page would change when
           the range moved — a control earns its place only if some pixel changes when you move it.
           S4 adds the metrics AND the control together; it must not add one without the other. */
        showDateRange={false}
        showChangeLog
        /* No "+ Rule". Hidden, not disabled: authoring a rule is session 10's builder, and a button
           here would navigate away from the page rather than do anything on it. The sibling routed
           pages dropped it for the same reason. */
      />

      <RulesTabs active="rules" />

      {resolution && (
        <p className="h10-ar-said">
          <b>{resolution}</b>
          {' · '}
          <span className="h10-ar-floor" title="GET /advertising/campaigns is cached for 300 seconds behind an L1 memory + L2 Redis cache, and the invalidating hook runs after the response is sent. Five minutes is the floor whatever this page does.">
            campaign data can be up to 5 minutes old
          </span>
          {appliedScope.length > 0 && (
            <> · <button type="button" className="h10-ar-lnk" onClick={clearScope}>clear scope</button></>
          )}
        </p>
      )}

      {error && (
        <p className="h10-ar-note bad">
          <AlertTriangle size={13} />
          <span>{error}{' '}
            <button type="button" className="h10-ar-lnk" onClick={() => setReloadTick((n) => n + 1)}>try again</button>
          </span>
        </p>
      )}

      {/* A refusal, and it is not a failure: different words, different colour, and it names the
          thing that would clear it. Substrate §5.6's fourth empty state. */}
      {contradiction && !error && (
        <p className="h10-ar-note refused">
          <Info size={13} />
          <span>{contradiction}{' '}
            <button type="button" className="h10-ar-lnk" onClick={clearScope}>clear the scope</button> to see every campaign.</span>
        </p>
      )}

      {grain === 'campaign' ? (
        <AdsDataGrid<CampaignRow>
          rows={campaignRows}
          loading={loading}
          rowId={(r) => r.id}
          noun="Campaign"
          firstColLabel="Campaign"
          renderFirst={(r) => (
            <div className="h10-ar-first">
              {/* 🔴 `.h10-am-grid td.nm .t` paints the first column #1f6fde at (0,3,1) with a
                  pointer cursor, because every other consumer of this grid makes that column a
                  link. This one is not a link — S7 makes the name open the row drawer — so it does
                  not use `.t` at all and carries its own class. A blue name that does nothing when
                  clicked is a promise the page cannot keep. */}
              <span className="h10-ar-nm" title={r.name}>{r.name}</span>
              <span className="mk">{r.market}</span>
              <Link className="h10-ar-open" href={`/marketing/ads/campaigns/${r.id}`}
                title="Open this campaign in the Ad Manager — performance, structure and its ~45 columns">Open</Link>
            </div>
          )}
          firstSortValue={(r) => r.name.toLowerCase()}
          columns={campaignColumns}
          filters={filters}
          initialFilters={initialFilters}
          onFilterChange={onFilterChange}
          filtersDefaultOpen={false}
          defaultSort={sortKey ? { key: sortKey, dir: dirParam } : undefined}
          onSortChange={onSortChange}
          enabledFirst={(r) => r.status}
          showTotal
          totalFirst={`${num(campaignRows.length)} shown`}
          pagerCentered
          reportLabel="Amazon Advertising"
          /* 🔴 Read-only, stated. S5 replaces this object; it does not stop passing it. */
          selectionActions={NO_WRITE_ACTIONS.selectionActions ?? undefined}
          onRowClick={NO_WRITE_ACTIONS.onRowAction ?? undefined}
          toolbarLeft={toolbarLeft}
          toolbarRight={toolbarRight}
          emptyNode={<EmptyState loading={loading} error={error} contradiction={contradiction}
            account={allRows.length} scoped={scoped.length} filtered={campaignRows.length}
            q={q} onClear={clearScope} onRetry={() => setReloadTick((n) => n + 1)} />}
        />
      ) : (
        <AdsDataGrid<AggregateRow>
          rows={aggregates}
          loading={loading}
          rowId={(r) => r.key}
          noun={GRAIN_LABEL[grain].replace(/s$/, '')}
          firstColLabel={GRAIN_LABEL[grain].replace(/s$/, '')}
          renderFirst={(r) => (
            <div className="h10-ar-first agg">
              <span className="h10-ar-nm" title={r.label}>{r.label}</span>
              {r.reachNote && <span className="h10-ar-reach" title={r.reachNote}>why</span>}
            </div>
          )}
          firstSortValue={(r) => r.label.toLowerCase()}
          columns={aggregateColumns}
          defaultSort={sortKey ? { key: sortKey, dir: dirParam } : { key: 'n', dir: 'desc' }}
          onSortChange={onSortChange}
          showTotal
          totalFirst={grain === 'line'
            ? `${num(aggregates.length)} lines — rows overlap`
            : `${num(aggregates.length)} rows`}
          pagerCentered
          reportLabel="Amazon Advertising"
          selectionActions={NO_WRITE_ACTIONS.selectionActions ?? undefined}
          toolbarLeft={toolbarLeft}
          toolbarRight={toolbarRight}
          emptyNode={<EmptyState loading={loading} error={error} contradiction={contradiction}
            account={allRows.length} scoped={scoped.length} filtered={aggregates.length}
            q={q} onClear={clearScope} onRetry={() => setReloadTick((n) => n + 1)} />}
        />
      )}

      {/* 🔴 The product-line grain double-counts, and the sum is the thing a reader will do in
          their head. Said at the control, not in a footnote. */}
      {grain === 'line' && aggregates.length > 0 && (
        <p className="h10-ar-note">
          <Info size={13} />
          <span>
            These {num(aggregates.length)} rows hold {num(aggregates.reduce((s, r) => s + r.n, 0))} campaign
            memberships across {num(scoped.length)} campaigns — a campaign advertising more than one product
            line is counted under each. <b>This column does not add up to the account, and is not meant to.</b>
          </span>
        </p>
      )}

      <ApplyRulesSections {...slotProps} />
    </div>
  )
}

/**
 * Four empty states, not three (substrate §5.6), and a refusal is never rendered as a failure and
 * never in the same colour as one.
 *
 *   broke     the read failed              — red, carries the message and a retry
 *   refused   the scope cannot resolve     — neutral, names what would clear it
 *   empty     the scope resolves to none   — neutral, says which narrowing did it
 *   nothing   the account holds no rows    — the only state where "no data" is the truth
 */
function EmptyState({
  loading, error, contradiction, account, scoped, filtered, q, onClear, onRetry,
}: {
  loading: boolean; error: string | null; contradiction: string | null
  account: number; scoped: number; filtered: number; q: string
  onClear: () => void; onRetry: () => void
}) {
  if (loading) return null

  if (error) {
    return (
      <div className="h10-ar-empty bad">
        <b>This did not load</b>
        <span>{error} Nothing is wrong with the account — the page could not read it.</span>
        <button type="button" className="h10-ar-lnk" onClick={onRetry}>Try again</button>
      </div>
    )
  }

  if (contradiction) {
    return (
      <div className="h10-ar-empty refused">
        <b>This scope cannot resolve</b>
        <span>{contradiction}</span>
        <button type="button" className="h10-ar-lnk" onClick={onClear}>Clear the scope</button>
      </div>
    )
  }

  if (account === 0) {
    return (
      <div className="h10-ar-empty">
        <NoDataIllus />
        <b>No campaigns</b>
        <span>This account holds no advertising campaigns, so there is nothing for automation to be
          allowed or refused on.</span>
      </div>
    )
  }

  return (
    <div className="h10-ar-empty">
      <b>Nothing matches</b>
      <span>
        {scoped === 0
          ? `The scope you picked resolves to none of the ${account} campaigns in this account.`
          : q
            ? `${scoped} campaign${scoped === 1 ? '' : 's'} are in scope, and none of them match “${q}”.`
            : `${scoped} campaign${scoped === 1 ? '' : 's'} are in scope, and the filters hide all of them.`}
        {filtered === 0 && ' Nothing is hidden that you did not hide.'}
      </span>
      <button type="button" className="h10-ar-lnk" onClick={onClear}>Clear everything</button>
    </div>
  )
}
