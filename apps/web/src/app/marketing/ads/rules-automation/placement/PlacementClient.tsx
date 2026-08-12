'use client'

/**
 * PLC.0 — Placement, its own page. The basis: read-only, live on production.
 *
 * One question: **for every campaign, in which lane are my ads showing, what is each lane worth,
 * and who put the multiplier there?**
 *
 * ── Why this replaces a rule list with a grid of the LEVER ────────────────────────────────────
 *
 * The old tab rendered `RuleListTab liveType="placement"`: 8 rules, all disabled, 0 successes
 * ever, whose last activity was 2026-08-03 — above a Delete that says "cannot be undone" and only
 * filters `useState`. Meanwhile the lever those rules describe moved 15,366 times in 60 days and
 * no screen in the product listed one campaign's three lanes side by side.
 *
 * The rule list cannot be made into this grid, and that is the argument rather than the
 * arithmetic: a rule's scope is single-valued, which is why ONE rule carries 99 of the 102
 * `set_placement_multiplier` actions with the campaign count in its *name*. The lever is a
 * campaign × lane field with three values, a 0–900 range and an hourly plan behind it. A list of
 * rules has nowhere to put any of that. The 8 rules are already listed on Apply Rules, which lists
 * every rule regardless of type; they do not need a second home.
 *
 * ── Five laws this grid follows, each a mistake already made in this codebase ─────────────────
 *
 *   1. **Every campaign appears, on every lane, always three rows.** The engine governs 33 of 220.
 *      A page showing only what the engine touches would hide 85% of the account — the exact
 *      inverse of the tab's defect, with the same shape.
 *   2. **A blank is never a zero, and there are three different blanks here.** "Not set" (Amazon
 *      treats absent and 0 identically) · "no delivery in this window" · "Amazon publishes no
 *      impression share for this lane". Each has its own words.
 *   3. **The most important value the owner column can take is "nobody"**, and today it is the
 *      most common: 144 campaigns carry a multiplier that no schedule and no plan steers, 40 of
 *      them live with the write gate open.
 *   4. 🔴 **The lever moves by the hour, so the page shows the plan behind the number.** Measured
 *      2026-08-12 at 02:56 Rome: all 33 live schedules held `pause`, whose floor is 0, and 32 of
 *      the 33 governed campaigns therefore carried nothing on any lane. Eight hours earlier they
 *      carried 150%. Without the engine line below, an operator comparing the two would read a
 *      stable page as a broken one.
 *   5. **Nothing here writes.** No inline edit, no pin toggle, no row action that mutates local
 *      state and lies. Those are P1–P7, each a real write with a real audit row.
 *
 * ── What this page links to and must never fork ───────────────────────────────────────────────
 *
 * The three-lane blend editor is `_rank/RankBlendEditor.tsx` and belongs to Rank & Dayparting. A
 * second three-lane editor is a second definition of what a lane means. Base bids and the
 * min/max-bid bounds belong to Bid; the write gate to Apply Rules; the engine's actor row to
 * Automations. This page renders outcomes and points at each of them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, Info, Search, X } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { RulesTabs, rulesTabByKey, RULES_BASE } from '../_shared/tabs'
import { getBackendUrl } from '@/lib/backend-url'
import { PlacementScopeBar, LANE_OPTIONS, type PlcScope, type PlcLaneKey, type ScopeOptionsPayload } from './PlacementScopeBar'

/** The four production Amazon Ads markets, plus the account-wide view the header already offers. */
const MARKETS = ['IT', 'DE', 'ES', 'FR']
/**
 * "All markets" is renderable here and refused on the Keyword Tracker. That page's numbers —
 * market volume, market rank, impression share — are per-marketplace quantities with no honest
 * sum. Everything on this grid is either a per-campaign fact (a campaign belongs to exactly one
 * market) or a EUR amount, and all four markets bill in EUR.
 */
const DEFAULT_MARKET = 'all'
/** Absent `preset` and absent dates mean this. A documented default, never a stored preference. */
const DEFAULT_PRESET = 'last30'

type LaneKey = PlcLaneKey
type OwnerKind = 'schedule' | 'plan' | 'none'

interface Row {
  campaignId: string
  name: string
  marketplace: string | null
  status: string
  adProduct: string | null
  biddingStrategy: string | null
  lane: string
  laneKey: LaneKey
  multiplierPct: number
  impressions: number
  clicks: number
  spendCents: number
  salesCents: number
  orders: number
  roas: number | null
  cpc: number | null
  cvr: number | null
  topOfSearchIS: number | null
  topOfSearchISDays: number
  owner: OwnerKind
  ownerLabel: string | null
  hasReportRow: boolean
}

interface Payload {
  scope: {
    market: string
    boundBy: 'market' | 'line' | 'portfolio' | 'campaign'
    line: { id: string; name: string } | null
    portfolio: { id: string; name: string } | null
    campaign: { id: string; name: string } | null
    applied: string[]
    notes: string[]
    contradiction: string | null
    totalCampaigns: number
  }
  range: { preset: string; start: string; end: string; days: number; includesToday: boolean }
  dataThrough: string | null
  counts: {
    campaigns: number
    carrying: number
    governed: number
    unmanaged: number
    governedTotal: number
    withReportRow: number
    carryingNoReportRow: number
  }
  engine: {
    goalSchedules: number
    enabledPlans: number
    holding: Array<{ targetKey: string; campaigns: number }>
    lastEvaluatedAt: string | null
    governedAtZero: number
  }
  lane: LaneKey | 'all'
  rows: Row[]
  total: number
}

const num = (n: number) => n.toLocaleString('en-IE')
const eur = (cents: number) => `€${(cents / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
/** A CPC is small; two decimals hide the difference between €0.40 and €0.45 nowhere else. */
const eur2 = (cents: number) => `€${(cents / 100).toFixed(2)}`
const dayMonth = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}
/**
 * 🔴 Local date parts, never `toISOString().slice(0,10)`.
 *
 * `DateRangePicker` hands back local midnights. In Rome in August that is 22:00Z the day BEFORE,
 * so the ISO shortcut silently shifts every picked range back a day. This repo has already paid
 * for that once (the day-grouping UTC/local trap).
 */
const ymdLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const LANE_LABEL: Record<LaneKey, string> = { top: 'Top of search', rest: 'Rest of search', product: 'Product pages' }
/** Amazon's own report label, so the tooltip can name what the number was actually read from. */
const LANE_REPORT_LABEL: Record<LaneKey, string> = {
  top: 'Top of Search on-Amazon',
  rest: 'Other on-Amazon',
  product: 'Detail Page on-Amazon',
}

const SORTABLE = [
  'campaign', 'market', 'status', 'lane', 'multiplier',
  'impressions', 'clicks', 'spend', 'roas', 'cpc', 'cvr', 'is', 'owner',
] as const
type SortKey = (typeof SORTABLE)[number]
/** The grid's own key for the sticky first column, which is the campaign here. */
const FIRST = '__first'

export function PlacementClient() {
  const router = useRouter()
  const params = useSearchParams()

  // Every view is linkable, and an absent param means the documented default — never a stored
  // preference, so a link renders the same view for whoever opens it. Market is the one deliberate
  // exception in the substrate contract, and it is written into the URL the moment it is moved so
  // a shared link still means what it said.
  const market = params.get('market') ?? DEFAULT_MARKET
  const scope: PlcScope = {
    line: params.get('line') ?? '',
    portfolio: params.get('portfolio') ?? '',
    campaign: params.get('campaign') ?? '',
  }
  const lane = (['top', 'rest', 'product'] as const).includes(params.get('lane') as LaneKey)
    ? (params.get('lane') as LaneKey)
    : 'all'
  const preset = params.get('preset') ?? DEFAULT_PRESET
  const start = params.get('start') ?? ''
  const end = params.get('end') ?? ''
  const q = params.get('q') ?? ''
  const sort = (SORTABLE as readonly string[]).includes(params.get('sort') ?? '')
    ? (params.get('sort') as SortKey)
    : 'spend'
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc'

  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [options, setOptions] = useState<ScopeOptionsPayload | null>(null)
  // The search box is this page's own, driving ?q= and filtered on the server. The shared grid's
  // search is private `useState` with no callback, so a term typed into it can never reach the
  // URL — and a page whose every view is supposed to be linkable cannot have one control that
  // is not. Local draft so typing does not push a history entry per keystroke.
  const [qDraft, setQDraft] = useState(q)
  useEffect(() => { setQDraft(q) }, [q])

  const push = useCallback((patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      const isDefault =
        !v
        || (k === 'market' && v === DEFAULT_MARKET)
        || (k === 'lane' && v === 'all')
        || (k === 'preset' && v === DEFAULT_PRESET)
        || (k === 'sort' && v === 'spend')
        || (k === 'dir' && v === 'desc')
      if (isDefault) next.delete(k)
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

  useEffect(() => {
    let alive = true
    setLoading(true)
    const p = new URLSearchParams({ market, sort, dir })
    for (const [k, v] of Object.entries({ line: scope.line, portfolio: scope.portfolio, campaign: scope.campaign, q })) {
      if (v) p.set(k, v)
    }
    if (lane !== 'all') p.set('lane', lane)
    // The server owns the date vocabulary. A custom range travels as explicit dates; anything else
    // travels as a server preset key. A `DateRangePicker` key never leaves this file.
    if (preset === 'custom' && start && end) { p.set('preset', 'custom'); p.set('start', start); p.set('end', end) }
    else p.set('preset', preset)

    void fetch(`${getBackendUrl()}/api/advertising/placements?${p.toString()}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Could not load the placement grid (${r.status})`)
        return r.json()
      })
      .then((d) => { if (alive) { setData(d as Payload); setErr(null) } })
      .catch((e) => { if (alive) { setErr((e as Error).message); setData(null) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [market, scope.line, scope.portfolio, scope.campaign, lane, preset, start, end, q, sort, dir])

  const rows = data?.rows ?? []
  const s = data?.scope
  const c = data?.counts
  const engine = data?.engine

  /**
   * The header's date control is CONTROLLED from here, so the label and the grid can never
   * disagree. The authority is the response's own `range` echo (substrate spec §1.2.5 — resolved
   * dates for display come from the server, because the client and the server anchor presets to
   * different clocks). Before the first response lands, an explicit `?start`/`?end` still renders
   * exactly; a preset falls back to a local approximation for one render.
   */
  const headerRange = useMemo(() => {
    const iso = (v: string) => { const [y, m, d] = v.split('-').map(Number); return new Date(y!, (m ?? 1) - 1, d ?? 1) }
    if (data?.range) return { start: iso(data.range.start), end: iso(data.range.end) }
    if (start && end) return { start: iso(start), end: iso(end) }
    const e = new Date(); e.setHours(0, 0, 0, 0)
    const st = new Date(e); st.setDate(st.getDate() - 29)
    return { start: st, end: e }
  }, [data?.range, start, end])

  /**
   * 🔴 The shared grid's `sortValue` returns `number | string` — it has no null branch, so a
   * missing metric cannot say "sort me last" the way the server's comparator does.
   *
   * That matters because BOTH sorts run: the header click pushes `?sort=` and the server returns
   * rows in that order, and then the grid re-sorts the array it was handed. Left at 0, the 452
   * rows with no delivery in the window would lead an ascending sort and the top of the screen
   * would be rows about nothing.
   *
   * A sentinel keyed off the ACTIVE direction reproduces the server's null-last rule exactly in
   * both directions. "Unknown" is not "worst", and here it is the common case, not the edge one.
   */
  const nullLast = dir === 'desc' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY

  const columns: GridColumn<Row>[] = useMemo(() => [
    {
      key: 'market', label: 'Market', metric: false,
      render: (r) => <span className="h10-plc-mkt">{r.marketplace ?? '—'}</span>,
      sortValue: (r) => r.marketplace ?? '',
    },
    {
      key: 'status', label: 'Campaign', metric: false,
      tip: 'The campaign\'s own status. A multiplier on a PAUSED campaign spends nothing and is not a mistake to fix — 103 of the 144 unmanaged multipliers sit on paused campaigns.',
      render: (r) => <span className={`h10-plc-st ${r.status.toLowerCase()}`}>{r.status.toLowerCase()}</span>,
      sortValue: (r) => r.status,
    },
    {
      key: 'lane', label: 'Lane', metric: false,
      tip: 'Amazon\'s three Sponsored Products placements. Amazon\'s own console lists a fourth — Amazon Business — which this account is not entitled to, so it is deliberately absent rather than silently omitted.',
      render: (r) => (
        <span className={`h10-plc-lane ${r.laneKey}`} title={`Amazon reports this lane as “${LANE_REPORT_LABEL[r.laneKey]}”`}>
          {LANE_LABEL[r.laneKey]}
        </span>
      ),
      sortValue: (r) => ['top', 'rest', 'product'].indexOf(r.laneKey),
    },
    {
      key: 'multiplier', label: 'Multiplier',
      tip: 'The bid adjustment on this placement, 0–900%. Amazon adjustments are one-directional: you cannot bid a placement DOWN, only raise the others or zero this one. A lane absent from the campaign and a lane set to 0 are the same instruction, so both read “not set”.',
      render: (r) => (
        r.multiplierPct > 0
          ? <span className={`h10-plc-mult${r.multiplierPct >= 100 ? ' hot' : ''}`}>+{num(r.multiplierPct)}%</span>
          : <span className="h10-plc-notset" title="No bid adjustment on this placement. Amazon treats an absent lane and a lane set to 0 identically.">not set</span>
      ),
      sortValue: (r) => r.multiplierPct,
      filterValue: (r) => r.multiplierPct,
      total: (visible) => {
        const set = visible.filter((r) => r.multiplierPct > 0).length
        return <span className="h10-plc-tot">{num(set)} set</span>
      },
    },
    {
      key: 'impressions', label: 'Impressions',
      render: (r) => (r.hasReportRow ? num(r.impressions) : <NoDelivery />),
      sortValue: (r) => (r.hasReportRow ? r.impressions : nullLast),
      filterValue: (r) => r.impressions,
      total: (visible) => num(visible.reduce((a, r) => a + r.impressions, 0)),
    },
    {
      key: 'clicks', label: 'Clicks',
      render: (r) => (r.hasReportRow ? num(r.clicks) : <NoDelivery />),
      sortValue: (r) => (r.hasReportRow ? r.clicks : nullLast),
      filterValue: (r) => r.clicks,
      total: (visible) => num(visible.reduce((a, r) => a + r.clicks, 0)),
    },
    {
      key: 'spend', label: 'Spend',
      tip: 'Amazon\'s placement report, summed over the window in the header. Account-wide over 60 days, Top of Search takes 45% of the spend for 2.3% of the impressions.',
      render: (r) => (r.hasReportRow ? eur(r.spendCents) : <NoDelivery />),
      sortValue: (r) => (r.hasReportRow ? r.spendCents : nullLast),
      filterValue: (r) => r.spendCents / 100,
      total: (visible) => eur(visible.reduce((a, r) => a + r.spendCents, 0)),
    },
    {
      key: 'roas', label: 'ROAS',
      tip: 'Sales ÷ spend, from Amazon\'s 7-day attribution on this placement. Blank where there was no spend to divide by.',
      render: (r) => (r.roas == null ? <NoValue reason={r.hasReportRow ? 'No spend on this lane in the window, so there is nothing to divide by.' : undefined} /> : <span className={`h10-plc-roas${r.roas >= 2 ? ' good' : r.roas < 1 ? ' bad' : ''}`}>{r.roas.toFixed(2)}</span>),
      sortValue: (r) => r.roas ?? nullLast,
      filterValue: (r) => r.roas ?? 0,
      total: (visible) => {
        const sp = visible.reduce((a, r) => a + r.spendCents, 0)
        const sa = visible.reduce((a, r) => a + r.salesCents, 0)
        return sp > 0 ? sa / sp === 0 ? '0.00' : (sa / sp).toFixed(2) : '—'
      },
    },
    {
      key: 'cpc', label: 'CPC',
      render: (r) => (r.cpc == null ? <NoValue reason={r.hasReportRow ? 'No clicks on this lane in the window.' : undefined} /> : eur2(r.cpc)),
      sortValue: (r) => r.cpc ?? nullLast,
      filterValue: (r) => (r.cpc ?? 0) / 100,
      total: (visible) => {
        const sp = visible.reduce((a, r) => a + r.spendCents, 0)
        const cl = visible.reduce((a, r) => a + r.clicks, 0)
        return cl > 0 ? eur2(sp / cl) : '—'
      },
    },
    {
      key: 'cvr', label: 'CVR',
      render: (r) => (r.cvr == null ? <NoValue reason={r.hasReportRow ? 'No clicks on this lane in the window.' : undefined} /> : `${(r.cvr * 100).toFixed(1)}%`),
      sortValue: (r) => r.cvr ?? nullLast,
      filterValue: (r) => (r.cvr ?? 0) * 100,
      total: (visible) => {
        const o = visible.reduce((a, r) => a + r.orders, 0)
        const cl = visible.reduce((a, r) => a + r.clicks, 0)
        return cl > 0 ? `${((o / cl) * 100).toFixed(1)}%` : '—'
      },
    },
    {
      key: 'is', label: 'Top-of-search IS',
      tip: 'Amazon\'s true top-of-search impression share, averaged over the days in the window and weighted by that day\'s impressions — a share is a ratio, so days are never summed. Amazon publishes NO impression share for Rest of Search or Product Pages; that blank is a permanent property of Amazon\'s reporting, not a gap in ours.',
      render: (r) => {
        if (r.laneKey !== 'top') {
          return <span className="h10-plc-nolane" title="Amazon publishes an impression share for Top of Search only. There is no such metric for this lane at any grain.">no share published</span>
        }
        if (r.topOfSearchIS == null) {
          return <span className="h10-plc-nm" title={r.hasReportRow ? 'This campaign delivered on Top of Search in the window but Amazon attached no impression share to any of those days.' : 'No Top-of-Search delivery in this window, so no share to report.'}>not measured</span>
        }
        return (
          <span className="h10-plc-is" title={`Weighted by impressions across the ${r.topOfSearchISDays} day${r.topOfSearchISDays === 1 ? '' : 's'} in this window that carried a share`}>
            {(r.topOfSearchIS * 100).toFixed(1)}%<i>{r.topOfSearchISDays}d</i>
          </span>
        )
      },
      sortValue: (r) => r.topOfSearchIS ?? nullLast,
      filterValue: (r) => (r.topOfSearchIS ?? 0) * 100,
    },
    {
      key: 'owner', label: 'Owner', metric: false,
      tip: 'What steers this campaign\'s placement: a rank schedule, a product rank plan, or nothing. “Nobody” is the most important value this column takes and today it is the most common — 144 campaigns carry a multiplier no engine will ever revisit.',
      render: (r) => {
        if (r.owner === 'none') {
          return (
            <span className="h10-plc-own none" title="No enabled rank schedule and no enabled product rank plan governs this campaign. Whatever multiplier it carries was set once — by a rule, a launch wizard, or by hand in Seller Central — and no engine will revisit it.">
              nobody
            </span>
          )
        }
        return (
          <a
            className={`h10-plc-own ${r.owner}`}
            href={`${RULES_BASE}/dayparting`}
            title={`Governed by ${r.owner === 'plan' ? 'a product rank plan' : 'a rank schedule'}${r.ownerLabel ? ` — “${r.ownerLabel}”` : ''}. The plan behind the number lives on Rank & Dayparting.`}
          >
            {r.ownerLabel ?? (r.owner === 'plan' ? 'a rank plan' : 'a rank schedule')}
          </a>
        )
      },
      sortValue: (r) => `${r.owner}:${r.ownerLabel ?? ''}`,
    },
  ], [nullLast])

  const activeTab = rulesTabByKey('placement')

  /** The one sentence stating what resolved. */
  const resolution = (() => {
    if (!s || !c) return null
    const bits: string[] = [s.market === 'all' ? 'All markets' : s.market]
    if (s.boundBy === 'campaign' && s.campaign) bits.push(`campaign “${s.campaign.name}”`)
    else if (s.boundBy === 'portfolio' && s.portfolio) bits.push(`portfolio “${s.portfolio.name}”`)
    else if (s.boundBy === 'line' && s.line) bits.push(`${s.line.name.split(' — ')[0]} line`)
    else bits.push('all campaigns')
    bits.push(`${num(c.campaigns)} campaign${c.campaigns === 1 ? '' : 's'}`)
    bits.push(`${num(c.carrying)} carrying a multiplier`)
    bits.push(`${num(c.unmanaged)} of those governed by nothing`)
    return bits.join(' · ')
  })()

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Placement"
        subtitle={activeTab?.subtitle ?? 'Which lane your ads show in, what each one is worth, and who put the multiplier there'}
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => push({ market: m, campaign: '' })}
        showLearn={false}
        showDataSync={false}
        /* 🔴 Unlike Keyword Tracker, this page KEEPS the date control: spend, ROAS, CPC, CVR and
           the impression-share average all move when you move it. There is exactly one date
           control on this page and it is this one — it is controlled from the URL, and the range
           it renders is the range the server says it resolved. */
        dateRange={headerRange}
        onDateRange={(st, en) => push({ preset: 'custom', start: ymdLocal(st), end: ymdLocal(en) })}
      />

      <RulesTabs active="placement" />

      <PlacementScopeBar
        options={options}
        market={market}
        scope={scope}
        lane={lane}
        boundBy={s?.boundBy ?? null}
        reach={c ? { campaigns: c.campaigns, total: s?.totalCampaigns ?? c.campaigns } : null}
        onChange={(next) => push({ line: next.line, portfolio: next.portfolio, campaign: next.campaign })}
        onLaneChange={(next) => push({ lane: next })}
      />

      {resolution && (
        <p className="h10-plc-said">
          <b>{resolution}</b>
          {data?.range && <> · window {dayMonth(data.range.start)} → {dayMonth(data.range.end)} ({data.range.days}d)</>}
        </p>
      )}

      {/* Band 4 — freshness, plainly. The shared <FreshnessChip> is substrate S3 and does not
          exist yet; this is a sentence, not a component, and it says so in the locks doc. */}
      <p className="h10-plc-fresh">
        {data?.dataThrough ? (
          <>
            Placement data through <b>{dayMonth(data.dataThrough)}</b> · Amazon reports land ~2 days
            behind, so the last two days of any window are empty by design rather than by absence.
          </>
        ) : (
          <>No placement report has ever landed for the campaigns in this scope.</>
        )}
        {engine && engine.goalSchedules > 0 && (
          <>
            {' · '}
            {/* 🔴 The plan behind the number. `AdSchedule.lastApplied` is the receipt the engine
                STAMPS after it decides — reading it is not the same thing as re-deriving which
                target governs this hour, which is `resolveActiveTargetKey` and belongs to the
                substrate. Without this clause the counts above read as instability. */}
            <span
              className="h10-plc-eng"
              title="What the rank engine last recorded holding, read from its own receipt on each schedule. The multiplier a governed campaign carries changes with it, so these counts are a reading of this hour."
            >
              the rank engine holds <b>{num(engine.goalSchedules)}</b> schedule{engine.goalSchedules === 1 ? '' : 's'}
              {engine.holding.length > 0 && (
                <> — {engine.holding.map((h) => `${h.campaigns}× ${h.targetKey}`).join(', ')}</>
              )}
              {engine.governedAtZero > 0 && c && (
                <>, so <b>{num(engine.governedAtZero)}</b> of the {num(c.governedTotal)} governed campaigns
                {' '}carry nothing on any lane right now</>
              )}
            </span>
            {' · '}
            <a className="lnk" href={`${RULES_BASE}/dayparting`}>see the plan</a>
          </>
        )}
      </p>

      {s?.contradiction && (
        <p className="h10-plc-blind">
          <AlertTriangle size={13} />
          <span><b>This scope resolves to no campaign.</b> {s.contradiction}. Widen it — the market picker in the header and the pickers above are ANDed together.</span>
        </p>
      )}

      {(s?.notes ?? []).map((n) => (
        <p className="h10-plc-note" key={n}><Info size={12} /><span>{n}</span></p>
      ))}

      {err && <p className="h10-plc-blind"><AlertTriangle size={13} /><span>{err}</span></p>}

      <AdsDataGrid<Row>
        rows={rows}
        loading={loading}
        rowId={(r) => `${r.campaignId}:${r.laneKey}`}
        noun="Placement"
        firstColLabel="Campaign"
        renderFirst={(r) => (
          <div className="h10-plc-camp">
            {/* 🔴 `.h10-am-grid td.nm .t` paints this blue at (0,3,1), sets `cursor: pointer` and
                underlines on hover, because every other consumer of this grid makes the first
                column a link. This one is not a link — P1 gives the row an inspector — so all
                three halves of that promise are undone in the CSS at matching specificity. */}
            <span className="t" title={r.name}>{r.name}</span>
            {r.owner === 'none' && r.multiplierPct > 0 && (
              <span className="fl warn" title="This campaign carries a multiplier on this lane and no engine governs it. Whatever the number is, nothing will revisit it.">unmanaged</span>
            )}
            {r.biddingStrategy === 'AUTO_FOR_SALES' && r.laneKey === 'top' && r.multiplierPct > 100 && (
              <span className="fl bad" title="Up-and-down bidding can already double the top-of-search bid; a Top multiplier above 100% compounds on top of that. Measured 2026-08-11: 0 campaigns were in this state.">compounding</span>
            )}
          </div>
        )}
        firstSortValue={(r) => r.name}
        columns={columns}
        showTotal
        totalFirst={<span className="h10-plc-tot">Total · {num(new Set(rows.map((r) => r.campaignId)).size)} campaigns</span>}
        defaultSort={{ key: sort === 'campaign' ? FIRST : sort, dir }}
        onSortChange={(next) => push({
          sort: next ? (next.key === FIRST ? 'campaign' : next.key) : 'spend',
          dir: next?.dir ?? 'desc',
        })}
        selectable={false}
        /* No row actions, no selection, no edit mode. Every write on this subject is P1–P7 and
           lands with an audit row; a control that mutated `useState` and claimed otherwise is the
           exact defect of the tab this page replaces. */
        customizable
        storageKey="nexus.plc.cols"
        pagerCentered
        toolbarLeft={(
          <span className="h10-plc-tools">
            <span className="h10-plc-search">
              <Search size={12} />
              <input
                value={qDraft}
                onChange={(e) => setQDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') push({ q: qDraft.trim() }) }}
                onBlur={() => { if (qDraft.trim() !== q) push({ q: qDraft.trim() }) }}
                placeholder="Search campaigns…"
                aria-label="Search campaigns"
              />
              {q && (
                <button type="button" aria-label="Clear search" onClick={() => push({ q: '' })}><X size={12} /></button>
              )}
            </span>
            <span className="h10-plc-lanes" role="tablist" aria-label="Placement lane">
              {LANE_OPTIONS.map((l) => (
                <button
                  key={l.value} type="button" role="tab" aria-selected={lane === l.value}
                  className={`seg ${lane === l.value ? 'on' : ''}`}
                  title={l.tip}
                  onClick={() => push({ lane: l.value })}
                >{l.value === 'all' ? 'All' : LANE_LABEL[l.value as LaneKey]}</button>
              ))}
            </span>
          </span>
        )}
        toolbarRight={data ? (
          <span className="h10-plc-win">
            {num(data.total)} row{data.total === 1 ? '' : 's'}
            <i title="Every campaign contributes three rows — one per lane — whether or not it carries a multiplier on them, because a lane carrying nothing beside a lane carrying everything is the finding this grid exists to show.">
              {num(data.counts.campaigns)} campaigns × {lane === 'all' ? 3 : 1} lane{lane === 'all' ? 's' : ''}
            </i>
          </span>
        ) : undefined}
        emptyNode={<EmptyState loading={loading} data={data} q={q} lane={lane} push={push} />}
        reportLabel={data?.dataThrough ? `Amazon placement report · through ${dayMonth(data.dataThrough)}` : undefined}
      />
    </div>
  )
}

/** "No delivery in this window" is not zero, and the two must never share a glyph. */
function NoDelivery() {
  return (
    <span className="h10-plc-nodel" title="This campaign has no Amazon placement report row for this lane in this window. That is an absence of delivery, not a measurement of zero.">
      no delivery
    </span>
  )
}

/** A derived number with no denominator. Distinct again from both of the above. */
function NoValue({ reason }: { reason?: string }) {
  return <span className="h10-plc-nd" title={reason ?? 'No delivery in this window, so nothing to derive this from.'}>—</span>
}

/**
 * An empty grid has four quite different causes here, and saying which one is the whole job.
 *
 * The fifth and sixth states — "not set" and "no delivery" — are per-CELL and live in the columns
 * above, because a campaign with no multiplier still has a row worth reading.
 */
function EmptyState({
  loading, data, q, lane, push,
}: {
  loading: boolean
  data: Payload | null
  q: string
  lane: LaneKey | 'all'
  push: (p: Record<string, string>) => void
}) {
  if (loading) return <span className="h10-plc-empty"><b>Loading…</b></span>
  if (!data) return <span className="h10-plc-empty"><b>Nothing loaded.</b><span>The read failed — the message above says why.</span></span>

  if (data.scope.contradiction) {
    return (
      <span className="h10-plc-empty">
        <b>This scope resolves to no campaign at all.</b>
        <span>
          {data.scope.contradiction}. The market in the header and the pickers above are ANDed
          together, so two choices that share no campaign leave nothing to show.{' '}
          <button type="button" className="lnk" onClick={() => push({ line: '', portfolio: '', campaign: '' })}>Clear the scope</button>
        </span>
      </span>
    )
  }

  if (data.counts.campaigns === 0) {
    return (
      <span className="h10-plc-empty">
        <b>No campaigns in this scope.</b>
        <span>
          Nothing here has a placement to show. Widen the scope — this account holds{' '}
          {num(data.scope.totalCampaigns)} campaigns in total.{' '}
          <button type="button" className="lnk" onClick={() => push({ market: 'all', line: '', portfolio: '', campaign: '' })}>Show all markets</button>
        </span>
      </span>
    )
  }

  return (
    <span className="h10-plc-empty">
      <b>
        {num(data.counts.campaigns)} campaign{data.counts.campaigns === 1 ? '' : 's'} resolved
        {lane === 'all' ? '' : ` on the ${LANE_LABEL[lane]} lane`} — the search hides all of them.
      </b>
      <span>
        {q ? <>Nothing matches “{q}”. </> : null}
        <button type="button" className="lnk" onClick={() => push({ q: '', lane: 'all' })}>Clear the search and the lane filter</button>
      </span>
    </span>
  )
}
