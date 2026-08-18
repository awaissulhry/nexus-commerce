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
 * a cursor — `_shared/useCursorPoll`, reused unchanged.
 *
 * ✅ RT.2 (2026-08-15) — the endpoint exists and the baseline is wired. For a fortnight before that
 * this page polled `GET /advertising/apply-rules/cursor`, which **did not exist**, with
 * `baseline: null`: rule 3 swallowed the 404 and the `stale` definition made a banner unreachable.
 * A live-looking poll wired to nothing, and nothing on screen said so.
 *
 * 🔴 The TODO that stood here proposed `{ campaignsAt: max(Campaign.updatedAt), loggedAt, n }`.
 * **Both halves were wrong, and it was superseded rather than implemented.** Measured on prod:
 * `Campaign.updatedAt` moved on **200 of 220 rows in 25 minutes** — `ads-campaign-settings-sync`
 * re-stamps every campaign every 20 minutes, so that cursor would have cried wolf about 72 times a
 * day. And the audit log cannot see this page's headline column at all: `PATCH /live-writes` flips
 * the write gate and logs only to `logger.warn`, writing no `AdvertisingActionLog` row.
 * The shipped cursor is a value fingerprint — `{ n, managed, bounded, pinned, suppressed,
 * liveBudgetCents, loggedAt }` — where the counts ARE the witness. See `ads-cursors.service.ts`.
 *
 * ── One staleness floor nothing on the client can fix ───────────────────────────────────────────
 *
 * `GET /advertising/campaigns` sits behind `cached(key, 300)` (L1 memory + L2 Redis) and the
 * invalidating hook fires `void flushAdsCache()` AFTER the response is sent, so a client refetching
 * immediately after a write can race it. **Five minutes is the floor whatever this page does**, and
 * the page says so rather than implying otherwise with a spinner.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, Info, Pencil, RefreshCw } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import { AdsFilterBar } from '../../campaigns/_grid/AdsFilterBar'
import { useMergedFilters } from '../_shared/useMergedFilters'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { useCursorBaseline, useCursorPoll } from '../_shared/useCursorPoll'
import { getBackendUrl } from '@/lib/backend-url'
import { NoDataIllus } from '../_shared/NoDataIllus'
import {
  DELIVERY_LABEL, MARKETS, STATUS_LABEL, STRATEGY_LABEL,
  type CampaignRow, type GuardrailPayload, type RawCampaign, type RawGuardrailRow,
  type ScopeOptionsPayload,
} from './types'
import {
  APPLY_RULES_GRAINS, GRAIN_LABEL, NO_WRITE_ACTIONS,
  type AggregateRow, type ApplyRulesGrain, type ApplyRulesScope, type ApplyRulesSlotProps,
  type ApplyRulesTotals,
} from './slot-contract'
import { ApplyRulesSections } from './ApplyRulesSections'
import { ArBulkVerbs } from './ArBulkVerbs'
import { useAdsSync } from '../_shared/adsBus'

const DEFAULT_MARKET = 'all'
const DEFAULT_GRAIN: ApplyRulesGrain = 'campaign'

/**
 * The params that change which rows exist. A change to any of them invalidates `?page=`.
 *
 * 🔴 `status` and `delivery` are in this list BECAUSE the filter panel moved out of the grid.
 * `AdsDataGrid` reset its own page from the panel's `onAfterChange`; under FB.2 the page renders
 * the bar and passes `hideFilterPanel`, so that reset no longer fires and the page owes it. Left
 * out, narrowing to 3 rows while standing on page 2 shows an empty grid and no reason why.
 */
const ROW_SET_KEYS = ['market', 'grain', 'portfolio', 'line', 'campaign', 'q', 'status', 'delivery'] as const

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
  // S4.1 closed the half of the URL contract AR.S0 §7 had to leave open. A junk or out-of-range
  // value falls back to page 1 rather than to an empty grid.
  const pageParam = Math.max(1, Math.floor(Number(params.get('page')) || 1))

  // 🔴 Reserved for S7. Parsed into the slot contract from day one and read by NOBODY in S0, so a
  // link someone shares today survives the section that gives it meaning.
  const row = params.get('row')
  const drawer = params.get('drawer')

  const [campaigns, setCampaigns] = useState<RawCampaign[] | null>(null)
  const [guardrails, setGuardrails] = useState<GuardrailPayload | null>(null)
  /**
   * U9 — the checked campaigns for the three bulk verbs. Campaign grain only: the verbs write
   * campaign fields and an aggregate row is not a campaign, so the other three grains stay
   * read-only rather than offering a control that could not mean anything there.
   */
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [options, setOptions] = useState<ScopeOptionsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  // AR.S1 — the campaign whose bid-band dialog is open. Local state: an action, not a view.
  const [boundsFor, setBoundsFor] = useState<CampaignRow | null>(null)

  /** The one writer of page state. '' or a default value deletes the param. */
  // RT.1 — your own writes, from any tab, applied silently. An ENGINE's write arrives on the
  // other rail (the cursor poll) and offers a banner instead; see `_shared/adsBus.ts`.
  useAdsSync(['ads.budget.changed', 'ads.guardrail.changed', 'ads.bid.changed', 'ads.rule.changed'], () => setReloadTick((n) => n + 1))

  const push = useCallback((patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      const isDefault = !v
        || (k === 'market' && v === DEFAULT_MARKET)
        || (k === 'grain' && v === DEFAULT_GRAIN)
        || (k === 'dir' && v === 'desc')
        || (k === 'page' && v === '1')
      if (isDefault) next.delete(k)
      else next.set(k, v)
    }
    // 🔴 Anything that changes WHICH ROWS EXIST sends you back to page 1, and the rule lives here so
    // that no call site can forget it. Page 3 of 220 campaigns is not page 3 of 4 market rows, and a
    // pager that survives a grain switch strands the operator on an empty page with no clue why.
    // The grid resets itself on a filter or search change it owns, but market/grain/scope and this
    // page's own `?q=` box are pushed from here, where the grid cannot see them.
    if (ROW_SET_KEYS.some((k) => k in patch) && !('page' in patch)) next.delete('page')
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
        targetAcosPct: g?.targetAcosPct ?? null,
        boundRules: Array.isArray(g?.boundRules) ? g.boundRules.length : 0,
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
  // RT.2 — the endpoint exists now, and the baseline is read alongside the data. Before this the
  // hook polled `/apply-rules/cursor` (a 404) with `baseline: null`, so by rule 3 the failure was
  // silent and by the `stale` definition no banner could ever have fired: the page had a live-
  // looking poll wired to nothing, for a fortnight, and nothing on screen said so.
  const cursorParams = useMemo(() => {
    const p: Record<string, string> = { market, grain }
    for (const [k, v] of Object.entries({ line: scope.line, portfolio: scope.portfolio, campaign: scope.campaign })) {
      if (v) p[k] = v
    }
    return p
  }, [market, grain, scope.line, scope.portfolio, scope.campaign])

  const cursorUrl = `${getBackendUrl()}/api/advertising/apply-rules/cursor`
  const cursorBaseline = useCursorBaseline<Record<string, unknown>>(cursorUrl, cursorParams, reloadTick)
  const refresh = useCursorPoll<Record<string, unknown>>({
    url: cursorUrl,
    params: cursorParams,
    baseline: cursorBaseline,
    // A dialog open on one campaign is a conversation about that campaign; a banner about other
    // rows can wait for it to close.
    enabled: boundsFor == null,
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
    campaign: ['__first', 'status', 'delivery', 'portfolio', 'lines', 'managed', 'bounds', 'strategy', 'tacos'],
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
    // ── AR.S1 — the four connected columns ───────────────────────────────────────────────────
    {
      key: 'managed',
      label: 'Automations',
      metric: false,
      tip: 'The write gate\'s verdict, which is the most useful sentence on this grid: MANAGED means armed automation can write to this campaign; OFF-LIMITS means rules still match it and every write is refused at campaign_allowlist. Resuming a paused campaign does NOT re-open the gate.',
      sortValue: (r) => (r.managed ? 1 : 0),
      render: (r) => {
        if (r.authorityMissing) return <span className="h10-ar-nd" title="The guardrail grid returned no row for this campaign — authority unknown, not open">unknown</span>
        const nAcct = totals?.accountWideRules ?? 0
        return r.managed
          ? <span className="h10-ar-pill mg-on" title={`The gate is OPEN: the ${nAcct} account-wide rules (count includes market-scoped ones — the payload's own caveat) plus ${r.boundRules} bound to this campaign can write here, inside their caps.`}>Managed{r.boundRules > 0 ? ` · ${r.boundRules} bound` : ''}</span>
          : <span className="h10-ar-pill mg-off" title={`The gate is SHUT: the same ${nAcct} account-wide rules match this campaign and every write is refused at campaign_allowlist. A refusal is the gate working, not a failure.`}>Off-limits</span>
      },
    },
    {
      key: 'bounds',
      label: 'Min · Max bid',
      metric: false,
      tip: 'The band the write gate enforces on this campaign\'s bids — DENIED at the gate, never clamped. "not set" is not a band of zero: nothing bounds this campaign\'s bids but the €0.02 suppression floor. The pencil edits both ends; measured 2026-08-12, minBidCents was set on 0 of 220 — this is its first UI.',
      sortValue: (r) => r.maxBidCents ?? -1,
      render: (r) => (
        <span className="h10-ar-bounds">
          {r.minBidCents == null && r.maxBidCents == null
            ? <span className="h10-ar-nd">not set</span>
            : <b>{r.minBidCents != null ? `€${(r.minBidCents / 100).toFixed(2)}` : '—'} – {r.maxBidCents != null ? `€${(r.maxBidCents / 100).toFixed(2)}` : '—'}</b>}
          <button type="button" className="h10-ar-edit" title={`Set the bid band for ${r.name}`} aria-label={`Set the bid band for ${r.name}`} onClick={() => setBoundsFor(r)}>
            <Pencil size={11} aria-hidden />
          </button>
        </span>
      ),
    },
    {
      key: 'strategy',
      label: 'Bidding strategy',
      metric: false,
      tip: 'Amazon\'s campaign bidding strategy — a real, varying field (the column it replaces read a key the payload never contained and printed a constant). Up & down lets Amazon add up to +100% on top of placement multipliers.',
      sortValue: (r) => r.biddingStrategy ?? '',
      render: (r) => (r.biddingStrategy
        ? <span title={r.biddingStrategy}>{STRATEGY_LABEL[r.biddingStrategy] ?? r.biddingStrategy}</span>
        : <span className="h10-ar-nd">not reported</span>),
    },
    {
      key: 'tacos',
      label: 'Target ACoS',
      metric: false,
      tip: 'The campaign\'s DECLARED target ACoS, from the guardrail grid. A dash means unset — the optimiser falls back to a flat 30% when asked, but a fallback is not a setting and this column no longer asserts it on 220 rows.',
      sortValue: (r) => r.targetAcosPct ?? -1,
      render: (r) => (r.targetAcosPct == null
        ? <span className="h10-ar-nd">—</span>
        : <span>{r.targetAcosPct}%</span>),
    },
  ], [portfolioNames, lineNames, push, totals?.accountWideRules])

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

  /**
   * FB.1 / FB.2 — the page OWNS the filter state; the grid reads it and stores nothing.
   *
   * This replaces BID.S0's `initialFilters` + `onFilterChange` seed/emit bridge, which existed only
   * because the grid kept its own copy: the seed had to MERGE rather than replace, and the outward
   * emit had to be suppressed for one tick or URL → seed → emit → URL looped forever. Neither
   * mechanism is needed once there is one writer, and both of this page's filters are already
   * fully described by the URL — so there was never a second copy worth keeping, only one worth
   * deleting.
   *
   * `useMergedFilters` rather than a hand-rolled version of it: FB.2 gave Bid, Budget and
   * Automations one bar over one state object, and a fourth page resolving the same thing its own
   * way is how this section ended up with five scope bars. It also already handles the two things
   * a hand-rolled one gets wrong — a page-local range filter (which S4's metric columns will bring)
   * and not rewriting an identical address bar on every keystroke.
   *
   * ⚠ The `__` prefix is load-bearing, not decoration: `isServerKey` treats a `__` key as owned by
   * the page, so applying a saved filter preset (S8) preserves these two rather than clobbering the
   * scope an operator arrived on.
   */
  const urlValues = useMemo(
    () => ({ __status: statusFilter, __delivery: deliveryFilter }),
    [statusFilter.join(','), deliveryFilter.join(',')],
  )

  const onUrlChange = useCallback((next: Record<string, string>) => {
    push({ status: next.__status ?? '', delivery: next.__delivery ?? '' })
  }, [push])

  const { filterState, setFilterState } = useMergedFilters({ urlValues, onUrlChange })

  /**
   * S4.1 — page 1 is the default and is absent from the URL; `push` deletes it.
   *
   * 🔴 The seed must NOT be handed back the value the grid just emitted, and this is the first
   * adoption of that bridge so it is worth saying why. `AdsDataGrid`'s inward effect arms
   * `suppressPageEmit` **unconditionally** before calling `setPage(seedPage)`. When the seed is an
   * echo of the grid's own emit, that `setPage` is a no-op, nothing changes, and the outward effect
   * never runs to consume the flag — so the suppression is still armed when the operator clicks the
   * NEXT page, and that click is swallowed. The symptom is a pager that updates the URL on every
   * other click: grid on page 3, address bar still saying 2.
   *
   * So the seed is withheld while the URL merely mirrors what we emitted. A genuine inbound change —
   * the back button, a pasted link — never matches `lastEmittedPage` and seeds normally.
   * Handed to the shared owner in the locks doc §4; the grid-side fix is one line (skip the effect
   * when `seedPage` already equals `page`), and it is not mine to make in a file three sessions hold.
   */
  const lastEmittedPage = useRef<number | null>(null)
  const onPageChange = useCallback((n: number) => {
    lastEmittedPage.current = n
    push({ page: String(n) })
  }, [push])
  const seedPage = pageParam === lastEmittedPage.current ? undefined : pageParam

  // ── the toolbar ───────────────────────────────────────────────────────────────────────────────
  //
  // 🔴 `?q=` stays owned HERE, and that is now a choice rather than a workaround.
  //
  // S4.1 added `initialSearch`/`onSearchChange`, so this box could be handed to the grid — and it
  // must not be, because the grid searches the rows it renders and this page renders four different
  // kinds of row. Searching "gale" here filters CAMPAIGNS and then re-aggregates, so at market grain
  // you get four rows counting only the gale campaigns. Handed to the grid, the same word would
  // filter the four market rows by their own labels and return nothing. One box that means one
  // thing at all four grains beats one box that quietly changes subject when the grain does.
  //
  // (`?page=` had the same shape of hole and does NOT have this problem — a page number means the
  // same thing whatever a row is — so it is bridged below.)
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

      {/* FB.2 — one bar, at the top of the page, above the numbers it produces. It replaces the
          grid's own collapsed "Show Filters" panel (`hideFilterPanel` below), which put this page's
          only two filters inside the card they filter and two scroll-lengths from the sentence
          stating what they resolved to. Collapsed by default here, unlike Bid's: these are two
          optional narrowings of a complete population, not the page's primary control — the grain
          switch is, and it lives in the toolbar beside the rows it reshapes. */}
      <AdsFilterBar filters={filters} value={filterState} onChange={setFilterState} />

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
          filterState={filterState}
          onFilterStateChange={setFilterState}
          hideFilterPanel
          initialPage={seedPage}
          onPageChange={onPageChange}
          defaultSort={sortKey ? { key: sortKey, dir: dirParam } : undefined}
          onSortChange={onSortChange}
          enabledFirst={(r) => r.status}
          showTotal
          totalFirst={`${num(campaignRows.length)} shown`}
          pagerCentered
          reportLabel="Amazon Advertising"
          /* U9 — the campaign grain writes now: H10's three safe verbs. `onRowClick` stays the
             explicit null of the S0 contract (the row drawer is S7's, not this unit's). */
          selectable
          selected={sel}
          onSelectedChange={setSel}
          selectionActions={(picked) => (
            <ArBulkVerbs
              ids={picked}
              names={new Map(campaignRows.map((r) => [r.id, r.name]))}
              onDone={() => { setSel(new Set()); setReloadTick((n) => n + 1) }}
            />
          )}
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
          initialPage={seedPage}
          onPageChange={onPageChange}
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
            line is counted under each. <b>Every total on this grain over-counts, and is not meant to add up
            to the account:</b> Enabled and Delivering carry the same duplication as Campaigns does.
          </span>
        </p>
      )}

      <ApplyRulesSections {...slotProps} />

      {/* AR.S1 — the bid-band dialog: the two enforced guardrails become settable from the page
          the operator said they should be set from. Writes ride PATCH /guardrails (the gate's own
          columns) and never touch Amazon — the bounds are local governance. */}
      {boundsFor != null && (
        <ArBoundsDialog
          row={boundsFor}
          onClose={() => setBoundsFor(null)}
          onDone={() => { setBoundsFor(null); setReloadTick((n) => n + 1) }}
        />
      )}
    </div>
  )
}

function ArBoundsDialog({ row, onClose, onDone }: { row: CampaignRow; onClose: () => void; onDone: () => void }) {
  const [minS, setMinS] = useState(row.minBidCents != null ? (row.minBidCents / 100).toFixed(2) : '')
  const [maxS, setMaxS] = useState(row.maxBidCents != null ? (row.maxBidCents / 100).toFixed(2) : '')
  const [busy, setBusy] = useState(false)
  const [errS, setErrS] = useState<string | null>(null)
  const toCents = (s: string) => (s.trim() === '' ? null : Math.round(Number(s) * 100))
  const minC = toCents(minS)
  const maxC = toCents(maxS)
  const invalid = (minC != null && (!Number.isFinite(minC) || minC < 2))
    || (maxC != null && (!Number.isFinite(maxC) || maxC < 2))
    || (minC != null && maxC != null && minC > maxC)
  const save = async () => {
    if (busy || invalid) return
    setBusy(true); setErrS(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${row.id}/guardrails`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minBidCents: minC, maxBidCents: maxC }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) throw new Error(j?.error ?? `Save failed (${r.status})`)
      onDone()
    } catch (e) { setErrS((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="h10-bd4-back" role="dialog" aria-modal="true" aria-label="Bid band" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="h10-bd4-card">
        <h3>Bid band — {row.name}</h3>
        <p className="h10-bd4-sub">Enforced at the write gate on every bid write to this campaign — a write outside the band is DENIED and recorded, never clamped. An existing bid outside it stays where it is until something tries to move it. Blank clears an end.</p>
        <div className="h10-bd6-goalrow">
          <label className="h10-bd4-field">Floor (€)<input type="number" step="0.01" min="0.02" value={minS} onChange={(e) => setMinS(e.target.value)} /></label>
          <label className="h10-bd4-field">Ceiling (€)<input type="number" step="0.01" min="0.02" value={maxS} onChange={(e) => setMaxS(e.target.value)} /></label>
        </div>
        {invalid && <p className="h10-bd4-err" role="alert"><AlertTriangle size={13} aria-hidden /> Each end must be ≥ €0.02 and the floor must not exceed the ceiling.</p>}
        {errS != null && <p className="h10-bd4-err" role="alert"><AlertTriangle size={13} aria-hidden /> {errS}</p>}
        <div className="h10-bd4-row">
          <button type="button" className="h10-bd4-cancel" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="h10-bd4-primary" disabled={busy || invalid} onClick={() => void save()}>{busy ? 'Saving…' : 'Save band'}</button>
        </div>
      </div>
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
