'use client'

/**
 * ⛔ PARKED 2026-08-17 (U2) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the whole 14-block Placement page — its own scope bar · resolution + freshness sentences · census cells (inverted · compounding · unmanaged · decorative) · the lane split · "the hour" · the campaign×lane grid with the inline lane editor and the row refusal alert.
 * Why it left: the Placement tab is now Helium 10's shape — one rules grid and nothing else
 *   (`PlacementRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.8, §7.3).
 * Candidate home: Analytics — the lane split and the census are measurement; the campaign×lane grid and its editor belong with the write surfaces (Bulk Operations / Ad Manager).
 *
 * Nothing here was changed and no endpoint was retired — the PLC.3 multiplier write path is still
 * served. The file stays at this path on purpose: re-mounting it is one import.
 * Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, Check, Info, Pencil, RefreshCw, Search, Sliders, X } from 'lucide-react'
import { Input } from '@/design-system/primitives'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { RulesTabs, rulesTabByKey, RULES_BASE } from '../_shared/tabs'
import { getBackendUrl } from '@/lib/backend-url'
import { PlacementScopeBar, LANE_OPTIONS, type PlcScope, type PlcLaneKey, type ScopeOptionsPayload } from './PlacementScopeBar'
import { PlcInspector } from './PlcInspector'
import { PlcBulkPanel } from './PlcBulkPanel'
import { useCursorPoll } from '../_shared/useCursorPoll'
import { useAdsSync } from '../_shared/adsBus'

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

type FlagKey = 'inverted' | 'compounding' | 'unmanaged' | 'decorative'
const FLAG_KEYS: readonly FlagKey[] = ['inverted', 'compounding', 'unmanaged', 'decorative']

interface Inversion {
  paidLaneKey: LaneKey; paidPct: number; paidRoas: number
  bestLaneKey: LaneKey; bestPct: number; bestRoas: number
}
interface Decorative { targetKey: string; heldPct: number; targetISPct: number | null; acosCapPct: number | null }
interface Chaseable { targetKey: string; floor: number; ceiling: number; allOut: boolean }

interface RowFlags {
  invertedEvaluable: boolean
  inversion: Inversion | null
  compounding: boolean
  compoundingMultiple: number
  unmanaged: boolean
  decorative: Decorative[]
  chaseable: Chaseable[]
}

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
  /** PLC.3 — from THIS payload, not the cached campaigns endpoint. See the service. */
  pinPlacement: boolean
  gateOpen: boolean
  flags: RowFlags
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
    matchedCampaigns: number
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
    nowUtc: string
    nowLocal: string
    timezone: string
    library: Array<{ targetKey: string; placement: string; heldPct: number; decorative: boolean }>
  }
  flags: {
    inverted: { n: number; of: number; minClicks: number; engineMaintained: number }
    compounding: { n: number; of: number }
    unmanaged: { n: number; of: number; live: number; paused: number; archived: number }
    decorative: { n: number; of: number; withRealCeiling: number; allOutOnly: number; noneCanChase: number }
  }
  lanes: Array<{
    laneKey: LaneKey; impressions: number; clicks: number; spendCents: number; salesCents: number
    orders: number; impressionsPct: number | null; spendPct: number | null
    roas: number | null; cpc: number | null; cvr: number | null
  }>
  cursor: PlcCursor
  lane: LaneKey | 'all'
  flag: FlagKey | 'all'
  rows: Row[]
  total: number
}

/** The three fields the poll compares. See the service's `PlcCursor` for why these and not Bid's. */
interface PlcCursor extends Record<string, unknown> {
  placementAt: string | null
  n: number
  holding: string
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

const FLAG_DENOM_SHORT: Record<FlagKey, string> = {
  inverted: 'inverted campaigns',
  compounding: 'compounding campaigns',
  unmanaged: 'campaigns governed by nothing',
  decorative: 'campaigns with a decorative goal',
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
  const flag = (FLAG_KEYS as readonly string[]).includes(params.get('flag') ?? '')
    ? (params.get('flag') as FlagKey)
    : 'all'
  const preset = params.get('preset') ?? DEFAULT_PRESET
  const start = params.get('start') ?? ''
  const end = params.get('end') ?? ''
  const q = params.get('q') ?? ''
  const sort = (SORTABLE as readonly string[]).includes(params.get('sort') ?? '')
    ? (params.get('sort') as SortKey)
    : 'spend'
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc'
  // P2 — the inspector rail. `?campaign=` is the scope grain, so the rail gets its own param.
  const rowParam = params.get('row') ?? ''
  /**
   * PLC.3 — `?edit=<campaignId>:<lane>` keeps a half-finished edit across a reload, and `?bulk=1`
   * makes the bulk panel linkable. The VALUE being typed is deliberately NOT in the URL: a
   * half-typed multiplier in a shareable link is an invitation to paste someone else's mistake.
   */
  const editParam = params.get('edit') ?? ''
  const [editCampaign, editLaneRaw] = editParam.split(':')
  const editLane = (['top', 'rest', 'product'] as const).includes(editLaneRaw as LaneKey) ? (editLaneRaw as LaneKey) : null
  const bulkOpen = params.get('bulk') === '1'

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
  // The cursor poll OFFERS a refresh; this is what taking it re-runs. It never fires on its own.
  const [reloadTick, setReloadTick] = useState(0)

  // RT.1 — your own writes, from any tab, applied silently. An ENGINE's write arrives on the
  // other rail (the cursor poll) and offers a banner instead; see `_shared/adsBus.ts`.
  useAdsSync(['ads.placement.changed', 'ads.schedule.changed'], () => setReloadTick((n) => n + 1))

  const push = useCallback((patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      const isDefault =
        !v
        || (k === 'market' && v === DEFAULT_MARKET)
        || (k === 'lane' && v === 'all')
        || (k === 'flag' && v === 'all')
        || (k === 'bulk' && v !== '1')
        || (k === 'preset' && v === DEFAULT_PRESET)
        || (k === 'sort' && v === 'spend')
        || (k === 'dir' && v === 'desc')
      if (isDefault) next.delete(k)
      else next.set(k, v)
    }
    const qs = next.toString()
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }, [params, router])

  // P2 — opening the rail is a navigation (a PUSH), so Back closes it; closing in-place replaces.
  const openRow = useCallback((id: string) => {
    const next = new URLSearchParams(params.toString())
    next.set('row', id)
    router.push(`?${next.toString()}`, { scroll: false })
  }, [params, router])
  const closeRow = useCallback(() => {
    const next = new URLSearchParams(params.toString())
    next.delete('row')
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
    if (flag !== 'all') p.set('flag', flag)
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
  }, [market, scope.line, scope.portfolio, scope.campaign, lane, flag, preset, start, end, q, sort, dir, reloadTick])

  const rows = data?.rows ?? []
  const s = data?.scope
  const c = data?.counts
  const engine = data?.engine

  /**
   * 🔴 The poll, and why the cursor is this page's own.
   *
   * `useCursorPoll`'s header names copying a sibling's cursor as the one way to misuse it. Bid
   * watches `max(AdTarget.updatedAt)` because an hourly resync moves a bid and writes no audit
   * row; no `AdTarget` moves when a placement multiplier changes — the lever is
   * `Campaign.dynamicBidding`. Measured 2026-08-12: `Campaign.updatedAt` touched **219 of 220**
   * campaigns in 24h, so watching it would light the banner far more often wrongly than rightly
   * (BUD.1's finding, on its own subject). This watches `CampaignBidHistory` over the three lane
   * fields — 1,208 writes in 24h over 28 campaigns — plus the engine's held-target tally, because
   * the plan switching hour changes every governed campaign's multiplier in writes a `changedAt`
   * watcher would never see.
   *
   * Writes are bursty: four times an hour, on the 15-minute cron boundary, and 7% of minutes carry
   * all of them. 45 s is fast enough to notice a tick and cheap enough to ignore.
   */
  const pollParams = useMemo(() => {
    const p: Record<string, string> = { market }
    if (scope.line) p.line = scope.line
    if (scope.portfolio) p.portfolio = scope.portfolio
    if (scope.campaign) p.campaign = scope.campaign
    return p
  }, [market, scope.line, scope.portfolio, scope.campaign])

  /**
   * PLC.3 — the single-row lane write.
   *
   * Goes through `PATCH /advertising/placements/:id/lane`, which takes ONE lane and merges
   * server-side via `buildManualAdjustments`. The client never assembles an `adjustments[]` array,
   * and that is deliberate: `updatePlacementBidding` writes the array wholesale, so a client that
   * sent only the lane it changed would erase the other two — silently, on every row it touched.
   * Making the client unable to express that shape is the fix.
   */
  const [saving, setSaving] = useState<string | null>(null)
  const [rowRefusal, setRowRefusal] = useState<{ campaignId: string; name: string; reason: string; deniedAt?: string } | null>(null)
  // Declared before `writeLane` so the write can re-sync the poll; assigned from the hook below.
  const checkRef = useRef<() => void>(() => {})

  const writeLane = useCallback(async (row: Row, pct: number) => {
    const key = `${row.campaignId}:${row.laneKey}`
    setSaving(key); setRowRefusal(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/placements/${row.campaignId}/lane`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lane: row.laneKey,
          percentage: pct,
          reason: `manual — ${LANE_LABEL[row.laneKey]} ${row.multiplierPct}% → ${pct}%`,
        }),
      })
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; mode?: string; reason?: string; deniedAt?: string; error?: string }
      if (!r.ok) { setRowRefusal({ campaignId: row.campaignId, name: row.name, reason: j.error ?? `The request failed (${r.status})` }); return }
      if (j.ok === false) {
        // 🔴 `reason`, never `j.error`: a blocked placement write returns HTTP 200, so the
        // section's existing bulk pattern would report "HTTP 200" as the reason a write was
        // refused. The gate writes a full sentence; this prints it.
        setRowRefusal({
          campaignId: row.campaignId, name: row.name,
          reason: j.reason ?? (j.mode === 'blocked' ? 'The write gate refused this campaign.' : j.error ?? 'Refused, with no reason given.'),
          deniedAt: j.deniedAt,
        })
        return
      }
      push({ edit: '' })
      // Refetch from the SERVER rather than patching local state — a grid that edits its own
      // useState and calls it done is the RuleListTab defect this page exists to correct.
      setReloadTick((n) => n + 1)
      /**
       * 🔴 …and re-poll, or the page accuses the engine of your own edit.
       *
       * Observed on production immediately after the first real write: the banner appeared saying
       * "the engine has moved since this loaded". It had not. The poll's last cursor predated the
       * write, the refetched payload's baseline postdated it, so `stale` went true — the page was
       * NEWER than the poll and reported the opposite. Re-checking re-syncs the cursor to the write
       * the operator just made.
       */
      checkRef.current()
    } catch (e) {
      setRowRefusal({ campaignId: row.campaignId, name: row.name, reason: (e as Error).message })
    } finally { setSaving(null) }
  }, [push])

  const { stale, check } = useCursorPoll<PlcCursor>({
    url: `${getBackendUrl()}/api/advertising/placements/cursor`,
    params: pollParams,
    baseline: data?.cursor ?? null,
    enabled: !loading,
  })
  useEffect(() => { checkRef.current = check }, [check])

  /**
   * The census strip. Each cell is a filter, each states its denominator, and none of them is ever
   * computed from a page of rows — every number comes from the route, over the SCOPE.
   *
   * 🔴 A cell whose denominator is 0 does not print "0". `inverted` needs traffic to be computable
   * and over a short window almost nothing clears 20 clicks on two lanes; "0 inverted" there is
   * *"we could not check"* wearing the words of *"we checked"*. That cell switches to
   * "not enough traffic to judge" and stops being a filter, because there is nothing to filter to.
   */
  const f = data?.flags
  const census: Array<{
    key: FlagKey; n: number; of: number; label: string; sub: string; tip: string
    tone?: string; unknown?: boolean
  }> = f && c ? [
    {
      key: 'inverted',
      n: f.inverted.n, of: f.inverted.of,
      label: 'inverted',
      unknown: f.inverted.of === 0,
      sub: f.inverted.of === 0
        ? `no campaign has ${f.inverted.minClicks}+ clicks on two lanes in this window`
        : `of ${num(f.inverted.of)} with enough traffic to judge${f.inverted.engineMaintained > 0 ? ` · ${f.inverted.engineMaintained} the engine maintains` : ''}`,
      tip: `The highest multiplier sits on a lane a better-returning lane beats. Judged only where at least two lanes carry ${f.inverted.minClicks}+ clicks in this window, so a ROAS is allowed to decide something. Widen the date range to judge more campaigns.`,
      tone: 'warn',
    },
    {
      key: 'compounding',
      n: f.compounding.n, of: f.compounding.of,
      label: 'compounding',
      sub: `of ${num(f.compounding.of)} on up-and-down bidding`,
      tip: 'Amazon charges base × (1 + top %), and up-and-down bidding lets Amazon add up to another +100% at top of search on top of that — so a Top multiplier above 100% can reach 4× the base bid. 0 campaigns are in this state, which is exactly when a guardrail is cheapest to add.',
    },
    {
      key: 'unmanaged',
      n: f.unmanaged.n, of: f.unmanaged.of,
      label: 'governed by nothing',
      sub: `of ${num(f.unmanaged.of)} carrying a multiplier · ${num(f.unmanaged.live)} live, ${num(f.unmanaged.paused)} paused`,
      tip: `Carries a multiplier and no rank schedule or plan steers it. The number that matters is the ${num(f.unmanaged.live)} live ones — a multiplier on a paused campaign spends nothing and is not a mistake to fix.`,
      tone: 'warn',
    },
    {
      key: 'decorative',
      n: f.decorative.n, of: f.decorative.of,
      label: 'decorative goal',
      sub: f.decorative.of === 0
        ? 'no campaign here is governed by an engine'
        : `of ${num(f.decorative.of)} an engine governs · ${num(f.decorative.withRealCeiling)} have a real ceiling`,
      unknown: f.decorative.of === 0,
      tip: 'The plan names a top-of-search share and an ACoS cap that the controller returns before ever reading, because no ceiling is set above the placement %. The engine pins and stops. Fixing it is a change to the rank target, on Rank & Dayparting.',
    },
  ] : []

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
      render: (r) => {
        const key = `${r.campaignId}:${r.laneKey}`
        if (editCampaign === r.campaignId && editLane === r.laneKey) {
          return <LaneEditor row={r} busy={saving === key} onCancel={() => push({ edit: '' })} onSave={(pct) => writeLane(r, pct)} />
        }
        return (
          <span className="h10-plc3-cell">
            {r.multiplierPct > 0
              ? <span className={`h10-plc-mult${r.multiplierPct >= 100 ? ' hot' : ''}`}>+{num(r.multiplierPct)}%</span>
              : <span className="h10-plc-notset" title="No bid adjustment on this placement. Amazon treats an absent lane and a lane set to 0 identically.">not set</span>}
            {/* The affordance appears on row hover only — 660 rows each shouting a pencil is
                noise, and this cell's job is to be read far more often than it is edited. */}
            <button
              type="button" className="h10-plc3-pencil"
              aria-label={`Edit ${LANE_LABEL[r.laneKey]} multiplier for ${r.name}`}
              title={r.owner === 'none'
                ? 'Edit this multiplier. Nothing steers this campaign, so the value will stick.'
                : `Edit this multiplier. ⚠ ${r.ownerLabel ?? 'A rank schedule'} steers this campaign and will snap it back within ~15 minutes.`}
              onClick={() => push({ edit: key })}
            ><Pencil size={11} aria-hidden /></button>
          </span>
        )
      },
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
  ], [nullLast, editCampaign, editLane, saving, push, writeLane])

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
    // The search is stated separately and never folded into the scope's numbers — see the service.
    if (q) bits.push(`showing ${num(c.matchedCampaigns)} matching “${q}”`)
    // The flag is stated as a FILTER, never folded into the scope's numbers — same rule as `?q=`.
    if (flag !== 'all') bits.push(`filtered to ${FLAG_DENOM_SHORT[flag]}`)
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
      {/* Band 4 — freshness, and freshness only. PLC.0 hung the engine clause off the end of this
          sentence; PLC.1 gives the engine its own band below, because "what is the plan, on whose
          clock" needed more than a clause and two statements of one fact is one too many. The
          shared <FreshnessChip> is still substrate S3 and still does not exist. */}
      <p className="h10-plc-fresh">
        {data?.dataThrough ? (
          <>
            Placement data through <b>{dayMonth(data.dataThrough)}</b> · Amazon reports land ~2 days
            behind, so the last two days of any window are empty by design rather than by absence.
          </>
        ) : (
          <>No placement report has ever landed for the campaigns in this scope.</>
        )}
      </p>

      {/* ── PLC.1 · the census. Every number is a filter, and every one states its denominator. ── */}
      {census.length > 0 && (
        <div className="h10-plc-census" role="group" aria-label="What is true in this scope">
          {census.map((cell) => (
            <button
              key={cell.key}
              type="button"
              title={cell.tip}
              className={`h10-plc-cell ${cell.tone ?? ''} ${flag === cell.key ? 'on' : ''} ${cell.unknown ? 'unknown' : ''}`}
              aria-pressed={flag === cell.key}
              disabled={cell.unknown}
              onClick={() => push({ flag: flag === cell.key ? 'all' : cell.key })}
            >
              <span className="h10-plc-cellnum">
                {cell.unknown
                  ? <b>not enough traffic to judge</b>
                  : <><b>{num(cell.n)}</b><i>of {num(cell.of)}</i></>}
              </span>
              <span className="h10-plc-celllab">{cell.label}</span>
              <span className="h10-plc-cellsub">{cell.sub}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── the lane split — the inversion stated at scope level, recomputed every read ──────── */}
      {data && data.lanes.some((l) => l.impressions > 0) && (
        <div className="h10-plc-lanesplit" role="group" aria-label="Where the impressions and the money go">
          {data.lanes.map((l) => (
            <div className="h10-plc-lanebox" key={l.laneKey}>
              <span className="h10-plc-lanehead">
                <b>{LANE_LABEL[l.laneKey]}</b>
                <i className={l.roas == null ? undefined : l.roas >= 2 ? 'good' : l.roas < 1 ? 'bad' : undefined}>
                  {l.roas == null ? 'no spend' : `${l.roas.toFixed(2)}× ROAS`}
                </i>
              </span>
              {/* Two bars, one row: share of impressions above share of spend. A lane whose spend
                  bar dwarfs its impression bar is the inversion, visible without arithmetic. */}
              <span className="h10-plc-lanebar" title={`${((l.impressionsPct ?? 0) * 100).toFixed(1)}% of impressions`}>
                <span className="impr" style={{ width: `${(l.impressionsPct ?? 0) * 100}%` }} />
              </span>
              <span className="h10-plc-lanebar" title={`${((l.spendPct ?? 0) * 100).toFixed(1)}% of spend`}>
                <span className="spend" style={{ width: `${(l.spendPct ?? 0) * 100}%` }} />
              </span>
              <span className="h10-plc-lanefoot">
                <span><b>{((l.impressionsPct ?? 0) * 100).toFixed(1)}%</b> of impressions</span>
                <span><b>{((l.spendPct ?? 0) * 100).toFixed(1)}%</b> of spend</span>
                <span>{l.cpc == null ? '—' : eur2(l.cpc)} CPC</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── the hour, in the engine's own words and on the engine's own clock ───────────────── */}
      {engine && engine.goalSchedules > 0 && c && (
        <p className="h10-plc-hour">
          <span>
            <b>{num(engine.goalSchedules)}</b> campaign{engine.goalSchedules === 1 ? ' is' : 's are'} governed by a rank
            schedule. Right now <span className="clock">{engine.nowLocal} {engine.timezone}</span> they hold{' '}
            {engine.holding.map((h, i) => (
              <span key={h.targetKey}>
                {i > 0 ? ', ' : ''}<b>{num(h.campaigns)}× {h.targetKey}</b>
              </span>
            ))}
            {engine.governedAtZero > 0 && (
              <> — so <b>{num(engine.governedAtZero)}</b> of them carry no multiplier on any lane at this hour</>
            )}
            . Their plan also reaches{' '}
            {engine.library.filter((l) => !engine.holding.some((h) => h.targetKey === l.targetKey))
              .map((l) => `${l.targetKey} (${l.heldPct}%)`).join(', ') || 'nothing else'} at other hours,
            {' '}<b>which is why the counts above are a reading of this hour and not a constant.</b>
          </span>
          <a className="lnk" href={`${RULES_BASE}/dayparting`}>See the plan →</a>
          {/* 🔴 It OFFERS. It never refetches under someone reading — the one screen used to decide
              whether a multiplier is wrong is not a screen that should reorder itself mid-sentence. */}
          {stale && (
            <button type="button" className="h10-plc-stale" onClick={() => { setReloadTick((n) => n + 1); check() }}>
              <RefreshCw size={11} /> A placement multiplier has changed since this loaded — refresh
            </button>
          )}
        </p>
      )}

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

      {/* 🔴 PLC.3 — the refusal renderer. The gate's OWN sentence, verbatim, naming which gate
          refused. Never "HTTP 200", which is what a blocked placement write actually returns and
          what the section's existing bulk pattern would have printed. */}
      {rowRefusal && (
        <p className="h10-plc3-refusal" role="alert">
          <AlertTriangle size={13} aria-hidden />
          <span>
            <b>{rowRefusal.name}</b>
            {rowRefusal.deniedAt && <span className="where">{rowRefusal.deniedAt}</span>}
            {' — '}{rowRefusal.reason}
            {rowRefusal.deniedAt === 'authority_pin' && <> The pin for this page&rsquo;s dimension is on the campaign&rsquo;s row rail — open it with the campaign name.</>}
            {rowRefusal.deniedAt === 'campaign_allowlist' && <> The per-campaign write gate lives on Apply Rules.</>}
            {' '}<button type="button" className="lnk" onClick={() => setRowRefusal(null)}>Dismiss</button>
          </span>
        </p>
      )}

      <AdsDataGrid<Row>
        rows={rows}
        loading={loading}
        rowId={(r) => `${r.campaignId}:${r.laneKey}`}
        noun="Placement"
        firstColLabel="Campaign"
        renderFirst={(r) => (
          <div className="h10-plc-camp">
            {/* P2 — the name opens the inspector rail (`?row=`), so the first column is a real
                control again; the P0 un-link CSS targeted span.t and this is a button. */}
            <button type="button" className="t" title={`${r.name} — open the inspector: three lanes, owner, and the change ledger`} onClick={() => openRow(r.campaignId)}>{r.name}</button>
            {r.owner === 'none' && r.multiplierPct > 0 && (
              <span className="fl warn" title="This campaign carries a multiplier on this lane and no engine governs it. Whatever the number is, nothing will revisit it.">unmanaged</span>
            )}
            {r.flags.compounding && r.laneKey === 'top' && (
              <span className="fl bad" title={`Up-and-down bidding lets Amazon add up to another +100% at top of search on top of this multiplier. Worst case here: ${r.flags.compoundingMultiple.toFixed(2)}× the base bid (base × (1 + ${r.multiplierPct}%) × ${r.biddingStrategy === 'AUTO_FOR_SALES' ? 2 : 1}× strategy headroom).`}>compounding</span>
            )}
            {/* 🔴 The inversion chip renders on the PAID lane only. Repeating it on all three
                would say "this row is inverted" of a row that is the victim, not the cause. */}
            {r.flags.inversion && r.laneKey === r.flags.inversion.paidLaneKey && (
              <span
                className="fl inv"
                title={`This is the highest multiplier among the lanes with enough traffic to judge, and it returns ${r.flags.inversion.paidRoas.toFixed(2)}× — while ${LANE_LABEL[r.flags.inversion.bestLaneKey]} at ${r.flags.inversion.bestPct}% returns ${r.flags.inversion.bestRoas.toFixed(2)}×.${r.owner === 'none' ? ' Nothing governs this campaign, so the multiplier is yours to change.' : ' An engine holds this — the fix is the rank target, on Rank & Dayparting, not this number.'}`}
              >
                inverted → {LANE_LABEL[r.flags.inversion.bestLaneKey].toLowerCase()} {r.flags.inversion.bestRoas.toFixed(1)}×
              </span>
            )}
            {/* Once per campaign, on the lane the target actually drives, so three rows do not
                each claim the same thing about the same plan. */}
            {r.flags.decorative.length > 0 && r.laneKey === 'top' && (
              <span
                className="fl dec"
                title={`${r.flags.decorative.map((d) => `“${d.targetKey}” holds ${d.heldPct}%${d.targetISPct != null ? `, aims at ${d.targetISPct}% top-of-search share` : ''}${d.acosCapPct != null ? ` under a ${d.acosCapPct}% ACoS cap` : ''}`).join('; ')}. No ceiling is set above the placement %, so the controller returns before it reads either number — the engine holds the % and stops.${r.flags.chaseable.length > 0 ? ` It can move on: ${r.flags.chaseable.map((ch) => `${ch.targetKey} (${ch.floor}→${ch.ceiling}%${ch.allOut ? ', all-out — ignores ACoS by design' : ''})`).join(', ')}.` : ' Nothing it can reach moves at all.'}`}
              >
                decorative goal
              </span>
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
            <Input
              size="xs"
              fieldClassName="h10-plc-search"
              leadingIcon={<Search size={12} />}
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') push({ q: qDraft.trim() }) }}
              onBlur={() => { if (qDraft.trim() !== q) push({ q: qDraft.trim() }) }}
              placeholder="Search campaigns…"
              aria-label="Search campaigns"
              suffix={q ? <button type="button" aria-label="Clear search" onClick={() => push({ q: '' })}><X size={12} /></button> : undefined}
            />
            {/* PLC.3 — the scope-bulk trigger. It opens a PREVIEW, never a write: the label says
                so, because a button that writes on click is the wrong shape for an action whose
                blast radius is "every campaign in the current scope". */}
            <button
              type="button" className="h10-plc-toggle" onClick={() => push({ bulk: '1' })}
              title="Set one lane's multiplier across the current scope. Opens a preview first — nothing is written until you confirm."
            >
              <Sliders size={12} aria-hidden /> Set across scope…
            </button>
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
        emptyNode={<EmptyState loading={loading} data={data} q={q} lane={lane} flag={flag} push={push} />}
        reportLabel={data?.dataThrough ? `Amazon placement report · through ${dayMonth(data.dataThrough)}` : undefined}
      />

      {/* P2 — the inspector rail. Lane facts from the loaded payload (no second fetch); the
          ledger fetched by id, so a deep link outside the current filters still answers. */}
      {rowParam && (
        <PlcInspector
          campaignId={rowParam}
          lanes={(data?.rows ?? []).filter((r) => r.campaignId === rowParam)}
          onClose={closeRow}
          onChanged={() => setReloadTick((n) => n + 1)}
        />
      )}

      {/* PLC.3 — the bulk panel. Portalled to document.body from inside the component, so the
          grid card's overflow cannot clip it. */}
      {bulkOpen && (
        <PlcBulkPanel
          scope={{ market, line: scope.line, portfolio: scope.portfolio, campaign: scope.campaign, flag }}
          lane={lane}
          onClose={() => push({ bulk: '' })}
          onDone={() => setReloadTick((n) => n + 1)}
        />
      )}
    </div>
  )
}

const FLAG_EMPTY_LABEL: Record<FlagKey, string> = {
  inverted: 'paying its highest multiplier into a worse-returning lane',
  compounding: 'compounding an up-and-down bid with a Top multiplier over 100%',
  unmanaged: 'carrying a multiplier no engine steers',
  decorative: 'naming a goal its controller cannot read',
}
const FLAG_DENOM_LABEL: Record<FlagKey, string> = {
  inverted: 'campaigns with enough traffic to judge',
  compounding: 'campaigns on up-and-down bidding',
  unmanaged: 'campaigns carrying a multiplier',
  decorative: 'campaigns an engine governs',
}

/**
 * PLC.3 — the inline lane editor.
 *
 * A plain number input, deliberately: a dropdown or a stepper inside a grid cell is the shape this
 * section has already had clipped by the card's own overflow, and a multiplier is a number an
 * operator types rather than picks from a list.
 *
 * 🔴 A GOVERNED row warns BEFORE the write, not after. `ad-rank-defend` runs every 15 minutes and
 * snaps the multiplier back to the active target's `biasPct`, so on the 33 governed campaigns a
 * manual value survives at most one tick. Letting that write go through silently would be a
 * control that appears to work and is undone before the operator looks again — worse than one that
 * refuses. The write is still ALLOWED, because it is legitimate to want it for the next fifteen
 * minutes; it just costs a second, deliberate click.
 */
function LaneEditor({ row, busy, onSave, onCancel }: {
  row: Row
  busy: boolean
  onSave: (pct: number) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(String(row.multiplierPct))
  const [ackGoverned, setAckGoverned] = useState(false)
  const pct = Number(draft)
  const valid = Number.isFinite(pct) && pct >= 0 && pct <= 900
  const governed = row.owner !== 'none'
  const needsAck = governed && !ackGoverned
  const unchanged = valid && Math.round(pct) === row.multiplierPct

  return (
    <span className="h10-plc3-edit">
      <input
        autoFocus inputMode="numeric" value={draft} disabled={busy}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && valid && !unchanged && !needsAck) onSave(Math.round(pct))
        }}
        aria-label={`${LANE_LABEL[row.laneKey]} multiplier percent, 0 to 900`}
      />
      <em>%</em>
      <button
        type="button" className="go" disabled={!valid || busy || unchanged}
        title={
          unchanged ? 'Already at this value — writing it would add a ledger row and change nothing.'
            : needsAck ? `⚠ ${row.ownerLabel ?? 'A rank schedule'} steers this campaign. The write will land and the engine will snap it back within ~15 minutes. Click again to do it anyway.`
              : 'Save'
        }
        onClick={() => { if (needsAck) { setAckGoverned(true); return } if (valid && !unchanged) onSave(Math.round(pct)) }}
      >{needsAck ? <AlertTriangle size={12} aria-hidden /> : <Check size={12} aria-hidden />}</button>
      <button type="button" onClick={onCancel} disabled={busy} title="Cancel"><X size={12} aria-hidden /></button>
    </span>
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
  loading, data, q, lane, flag, push,
}: {
  loading: boolean
  data: Payload | null
  q: string
  lane: LaneKey | 'all'
  flag: FlagKey | 'all'
  push: (p: Record<string, string>) => void
}) {
  if (loading) return <span className="h10-page-empty"><b>Loading…</b></span>
  if (!data) return <span className="h10-page-empty"><b>Nothing loaded.</b><span>The read failed — the message above says why.</span></span>

  if (data.scope.contradiction) {
    return (
      <span className="h10-page-empty">
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
      <span className="h10-page-empty">
        <b>No campaigns in this scope.</b>
        <span>
          Nothing here has a placement to show. Widen the scope — this account holds{' '}
          {num(data.scope.totalCampaigns)} campaigns in total.{' '}
          <button type="button" className="lnk" onClick={() => push({ market: 'all', line: '', portfolio: '', campaign: '' })}>Show all markets</button>
        </span>
      </span>
    )
  }

  /**
   * 🔴 PLC.1 — a flag that matches nothing is a FINDING, not a gap, and there are two of them.
   *
   * "No campaign in this scope is inverted" is good news and must read as such. "Not enough traffic
   * to judge" is not news at all — it means the window is too short for the question — and
   * conflating the two would be the same defect as a bare "0 inverted", one screen along.
   */
  if (flag !== 'all' && data.flags) {
    const stat = data.flags[flag]
    const unmeasurable = (flag === 'inverted' || flag === 'decorative') && stat.of === 0
    return (
      <span className="h10-page-empty">
        <b>
          {unmeasurable
            ? flag === 'inverted'
              ? 'Not enough traffic in this window to judge any campaign.'
              : 'No campaign in this scope is governed by an engine.'
            : `No campaign in this scope is ${FLAG_EMPTY_LABEL[flag]}.`}
        </b>
        <span>
          {unmeasurable
            ? flag === 'inverted'
              ? <>An inversion needs at least {num(data.flags.inverted.minClicks)} clicks on two lanes before a ROAS is allowed to decide anything, and none of the {num(data.counts.campaigns)} campaigns here clears that over {data.range.days} day{data.range.days === 1 ? '' : 's'}. Widen the date range — this is “we could not check”, not “nothing is wrong”.</>
              : <>A decorative goal is a property of a plan, and nothing here has one.</>
            : <>All {num(stat.of)} {FLAG_DENOM_LABEL[flag]} are clear. That is a real zero, not a gap.</>}
          {' '}<button type="button" className="lnk" onClick={() => push({ flag: 'all' })}>Show every campaign</button>
        </span>
      </span>
    )
  }

  /**
   * 🔴 The scope is not empty and the search is: two different sentences with two different fixes.
   *
   * Found by typing into the box on production. The counts used to be computed over the SEARCHED
   * set, so this branch was unreachable — a no-match search collapsed `counts.campaigns` to 0 and
   * the branch above fired, telling the operator to widen a scope that already held 220 campaigns.
   */
  return (
    <span className="h10-page-empty">
      <b>
        {num(data.counts.campaigns)} campaign{data.counts.campaigns === 1 ? '' : 's'} in this scope
        {lane === 'all' ? '' : ` on the ${LANE_LABEL[lane]} lane`} — {q ? 'the search hides' : 'the filters hide'} all of them.
      </b>
      <span>
        {q ? <>No campaign name contains “{q}”. </> : null}
        <button type="button" className="lnk" onClick={() => push({ q: '', lane: 'all' })}>Clear the search and the lane filter</button>
      </span>
    </span>
  )
}
