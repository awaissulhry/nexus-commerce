'use client'

/**
 * ⛔ PARKED 2026-08-18 (U6) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the whole 14-block page — filter bar + ScopeNotes · resolution sentence with the newest budget change · census strip · the €1-floor ratchet warning · truncation and write-status notes · the campaigns/rules grid (?view=) with "Restore N to baseline" and "Transfer…" · the transfer dialog · the "+ New budget rule" footer.
 * Why it left: the Budget tab is now Helium 10's shape — one rules grid and nothing else
 *   (`BudgetRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.5, §7.7).
 * Candidate home: **Budget Manager** — the rail item that already owns budget levels and pacing; the census to Analytics.
 *
 * ⚠ Nothing here was changed and no endpoint was retired. The budget WRITE GATE is server-side and
 * untouched, and the €1-floor ratchet condition is still stated on Budget Pacing & Schedules and on
 * Control Room › Activity. The file stays at this path on purpose: re-mounting it is one import.
 * Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * BUD.1 — Budget Rules, promoted from a tab to its own page, with a live read-only grid.
 *
 * The page answers one question: **what is allowed to change a campaign's budget, by how much, and
 * was it right?** BUD.1 builds the first two thirds — what each budget is, what moved it, and which
 * rules may reach it — over the whole account, at two grains, for four markets. Guardrails, the
 * baseline, the rule record, proposals, reallocation and notifications are BUD.2–BUD.7 and every
 * one of them is a slot at the bottom of this file.
 *
 * 🔴 The read-only era ended with BUD.2 (2026-08-15), and its end is stated where its start was:
 * `WRITE_ACTIONS` replaced `NO_WRITE_ACTIONS`. The page now carries exactly the writes it owns —
 * BUD.2's guardrails & baseline (the panel below the grid), BUD.3's restore-to-baseline and
 * BUD.6's transfer (selection actions), every one a GATED write whose denial reports its reason.
 * Rule records live on Automations (`?rule=` deep-links its drawer) — one owner; this page
 * renders outcomes and links. The interim `RuleListTab` block is gone (BUD.4): the Rules view IS
 * the honest list, and pending budget proposals queue in Automations' one inbox.
 *
 * ── Four things this page refuses to blur, each one measured on prod 2026-08-12 ─────────────────
 *
 *   1. **The write gate does not protect a campaign from a cut — it makes it diverge.** The local
 *      budget is written with no gate call; the gate runs at dispatch. So "a trim can still cut it"
 *      is 28 campaigns and "and it reaches Amazon" is 24. The other 4 have absorbed 488 identical
 *      €10.00 → €1.00 cuts, 122 each, every one skipped at the gate while the local value returned
 *      to €10.00 before the next tick. Two numbers, because they are two facts.
 *   2. **Utilisation is a 7-day AVERAGE and cannot see a campaign going dark at 10am.** After a cut
 *      the average still carries the pre-cut days, which is how a €1.00 campaign reads 392%. The
 *      column says "7-day average" on its face and the page never says "budget-capped".
 *   3. **A refusal is not a failure.** 7,738 of 7,738 historical rule "failures" are
 *      `DAILY_CAP_EXCEEDED` — the cap doing its job. They are counted, and labelled, separately.
 *      And today the count is zero for a worse reason, which the page states outright.
 *   4. **The ratchet is armed, not firing.** 727 budget writes on 08-07, then 11, then 1, then
 *      none — because 58 of 86 campaigns are pinned at €1 and there is nothing left to cut. Both
 *      readings alone are wrong: "live" overstates it, "stopped" badly understates it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Input, Select } from '@/design-system/primitives'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, Info, Plus, RefreshCw } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { useCursorPoll } from '../_shared/useCursorPoll'
import { getBackendUrl } from '@/lib/backend-url'
import { AdsFilterBar } from '../../campaigns/_grid/AdsFilterBar'
import { ScopeNotes } from '../_shared/ScopeNotes'
import { buildScopeFilters, scopeToFilterState, type ScopeOptionsPayload, type ScopeValue } from '../_shared/scopeFilters'
import { useMergedFilters } from '../_shared/useMergedFilters'
import {
  BUD_STATES, LEVEL_LABEL, STATE_LABEL,
  type BudCampaignRow, type BudGridPayload, type BudRuleRow, type BudState, type BudView,
} from './types'
import { WRITE_ACTIONS, type BudSlotProps } from './slot-contract'
import { BudgetSections } from './BudgetSections'
// Interim, until BUD.4 replaces it: rendered exactly as the tab rendered it, so nothing is lost in
// the move off `?tab=budget`.

import { useAdsSync } from '../_shared/adsBus'
import { Listbox } from '@/design-system/components'

/** The four production Amazon Ads markets, plus the account-wide view the header already offers. */
const MARKETS = ['IT', 'DE', 'FR', 'ES']
const DEFAULT_MARKET = 'all'
const DEFAULT_STATUS = 'enabled'
const DEFAULT_WINDOW = '7d'
const DEFAULT_VIEW: BudView = 'campaigns'

const num = (n: number) => n.toLocaleString('en-IE')
const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`
/** Signed money, for a movement column where the sign IS the finding. */
const signedEur = (cents: number) => `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${eur(Math.abs(cents))}`
const pct = (r: number) => `${(r * 100).toFixed(0)}%`
const signedPct = (r: number) => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r * 100).toFixed(0)}%`
const NOT_MEASURED = <span className="h10-bud-ns" title="No performance row for this campaign in the window — it was not served, which is not the same as spending nothing">not served</span>
const NO_VALUE = <span className="h10-bud-nd" title="Nothing to divide by">—</span>

const clockLabel = (iso: string | null) => {
  if (!iso) return null
  const d = new Date(iso)
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })
}

export function BudgetClient() {
  const router = useRouter()
  const params = useSearchParams()

  // ── the URL contract ──────────────────────────────────────────────────────────────────────────
  // Every view is linkable and an absent param means the default, never a stored preference, so a
  // link renders the same view for whoever opens it. An unknown value falls back to the default and
  // never throws — `?view=abc`, `?market=ZZ`, `?state=garbage` all render the default view.
  const rawMarket = params.get('market') ?? DEFAULT_MARKET
  const market = rawMarket === 'all' || MARKETS.includes(rawMarket) ? rawMarket : DEFAULT_MARKET

  // 🔴 Portfolio and campaign are mutually exclusive and CAMPAIGN WINS. Resolved here for what the
  // page renders, normalised out of the address bar by the effect below, and enforced again on the
  // server — three layers, because they answer three different questions: what to show, what the
  // URL should say, and what the scope actually resolves to.
  const campaignParam = params.get('campaign') ?? ''
  const portfolioParam = params.get('portfolio') ?? ''
  // FB.2 — the line grain is `?line=` here as on the other ten pages. This page called it
  // `?product=` alone, which made one grain two names across the section and meant a link could not
  // be carried from Bid to Budget. The old spelling is still READ, so links already out there keep
  // working; `push` rewrites the address bar to the new one the first time anything moves.
  const scope: ScopeValue = {
    line: params.get('line') ?? params.get('product') ?? '',
    portfolio: campaignParam ? '' : portfolioParam,
    campaign: campaignParam,
  }

  const view: BudView = params.get('view') === 'rules' ? 'rules' : DEFAULT_VIEW
  const rawState = params.get('state')
  const state: BudState | null = rawState && (BUD_STATES as readonly string[]).includes(rawState) ? (rawState as BudState) : null
  const status = params.get('status') ?? DEFAULT_STATUS
  const q = params.get('q') ?? ''
  const sortParam = params.get('sort') ?? ''
  const dirParam = params.get('dir') === 'asc' ? 'asc' : 'desc'
  const windowParam = params.get('window') ?? DEFAULT_WINDOW

  // 🔴 Reserved for later sections. Parsed into the slot contract from day one and read by NOBODY
  // in BUD.1, so a link someone shares today survives the section that gives it meaning.
  //   rule= (BUD.3) · open= (BUD.3)
  const reserved = {
    rule: params.get('rule'),
    open: params.get('open'),
    state,
  }

  const [data, setData] = useState<BudGridPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [options, setOptions] = useState<ScopeOptionsPayload | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  // BUD.3/BUD.6 — selection + the two write acts. `writeNote` is the outcome sentence, always
  // rendered with the server's own words (a denial names its gate).
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [writeBusy, setWriteBusy] = useState(false)
  const [writeNote, setWriteNote] = useState<string | null>(null)
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferEur, setTransferEur] = useState('')
  const [transferFrom, setTransferFrom] = useState<string>('')

  // RT.1 — your own writes, from any tab, applied silently. An ENGINE's write arrives on the
  // other rail (the cursor poll) and offers a banner instead; see `_shared/adsBus.ts`.
  useAdsSync(['ads.budget.changed', 'ads.rule.changed', 'ads.guardrail.changed'], () => setReloadTick((n) => n + 1))

  const push = useCallback((patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      // 🔴 Same fix as Bid's: `'all'` is a default for `market` alone here. One merged bar patches
      // every URL key at once, so a blanket rule would delete a live `?status=all` the moment you
      // touched any other control — the Status select would snap back to Enabled on its own.
      const allIsTheDefault = k === 'market'
      const isDefault =
        !v || (allIsTheDefault && v === 'all')
        || (k === 'market' && v === DEFAULT_MARKET)
        || (k === 'view' && v === DEFAULT_VIEW)
        || (k === 'status' && v === DEFAULT_STATUS)
        || (k === 'window' && v === DEFAULT_WINDOW)
        || (k === 'dir' && v === 'desc')
      if (isDefault) next.delete(k)
      else next.set(k, v)
    }
    // The exclusivity rule, applied to the URL itself so the address bar never shows a state the
    // server did not resolve.
    if (next.get('campaign')) next.delete('portfolio')
    // The old spelling never survives a write: one grain, one param.
    next.delete('product')
    const qs = next.toString()
    // FB.2 — `replace`, not `push`. With scope and the chips in ONE panel, three clicks used to
    // stack three history entries and leaving the page took six presses of Back. The view is still
    // fully linkable; it just no longer owns the back button. Five of the seven bars already did this.
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }, [params, router])

  // A link that arrives carrying both grains is rewritten once, quietly, so the URL matches what is
  // on screen. `replace`, not `push` — this is a correction, not a navigation, and it must not put
  // a dead entry in the history for Back to land on.
  useEffect(() => {
    if (campaignParam && portfolioParam) {
      const next = new URLSearchParams(params.toString())
      next.delete('portfolio')
      router.replace(`?${next.toString()}`, { scroll: false })
    }
  }, [campaignParam, portfolioParam, params, router])

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
    // `product` is the SERVER's field name (`BudGridRequest.product`); only the URL param moved.
    for (const [k, v] of Object.entries({ product: scope.line, portfolio: scope.portfolio, campaign: scope.campaign, q })) {
      if (v) p[k] = v
    }
    if (state) p.state = state
    if (sortParam) { p.sort = sortParam; p.dir = dirParam }
    return p
  }, [market, view, status, windowParam, scope.line, scope.portfolio, scope.campaign, q, state, sortParam, dirParam])

  const gridKey = JSON.stringify(gridParams)

  useEffect(() => {
    let alive = true
    setLoading(true)
    const qs = new URLSearchParams(JSON.parse(gridKey) as Record<string, string>).toString()
    void fetch(`${getBackendUrl()}/api/advertising/budget-grid?${qs}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Could not load the budgets (${r.status})`)
        return r.json()
      })
      .then((d) => { if (alive) { setData(d as BudGridPayload); setErr(null) } })
      .catch((e) => { if (alive) { setErr((e as Error).message); setData(null) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [gridKey, reloadTick])

  // ── the refresh cursor ────────────────────────────────────────────────────────────────────────
  // 🔴 NOT the SSE bus: it carries 0.21% of writes and is blind to `budget-manager-cron`, which made
  // 1,164 of the 2,386 budget changes. And the cursor carries `view` and `status`, because the two
  // views render different numbers and the grid defaults to ENABLED — a cursor over a different row
  // set is a banner that fires for changes you cannot see.
  const cursorParams = useMemo(() => {
    const p: Record<string, string> = { market, view, status }
    for (const [k, v] of Object.entries(scope)) if (v) p[k] = v
    return p
  }, [market, view, status, scope.line, scope.portfolio, scope.campaign])

  const refresh = useCursorPoll({
    url: `${getBackendUrl()}/api/advertising/budget-grid/cursor`,
    params: cursorParams,
    baseline: (data?.cursor ?? null) as unknown as Record<string, unknown> | null,
  })

  const campaigns = view === 'campaigns' ? ((data?.rows ?? []) as BudCampaignRow[]) : []
  const rules = view === 'rules' ? ((data?.rows ?? []) as BudRuleRow[]) : []
  const census = data?.census ?? null
  const days = data?.window.days ?? 7

  const slotProps: BudSlotProps = {
    scope: { market, ...scope },
    view,
    data,
    campaigns,
    rules,
    loading,
    push,
    reload: () => setReloadTick((n) => n + 1),
    reserved,
    refresh: { stale: refresh.stale, lastCheckedAt: refresh.lastCheckedAt, cursor: data?.cursor ?? null },
  }

  const onSortChange = useCallback((s: { key: string; dir: 'asc' | 'desc' } | null) => {
    push({ sort: s ? s.key : '', dir: s ? s.dir : '' })
  }, [push])

  // ── campaign columns ──────────────────────────────────────────────────────────────────────────
  const campaignColumns: GridColumn<BudCampaignRow>[] = useMemo(() => [
    {
      key: 'market', label: 'Market', metric: false,
      render: (r) => <span className="h10-bud-mkt">{r.market}</span>,
      sortValue: (r) => r.market,
    },
    {
      key: 'budget', label: 'Daily budget',
      tip: 'The LOCAL value, which is what every rule reads and writes. Where the write gate is closed this can differ from what Amazon holds — the gate stops the dispatch, not the cut.',
      render: (r) => (
        <span className={r.atFloor ? 'h10-bud-amt floor' : 'h10-bud-amt'}>
          {eur(r.dailyBudgetCents)}
          {r.atFloor && <i title="At Amazon's €1 minimum. A −15% or −20% trim computes €1 again and changes nothing.">floor</i>}
        </span>
      ),
      sortValue: (r) => r.dailyBudgetCents, filterValue: (r) => r.dailyBudgetCents / 100,
      total: (vis) => eur(vis.reduce((s, r) => s + r.dailyBudgetCents, 0)),
    },
    {
      // BUD.2 — the anchor and the bounds, on the row they govern. A blank is honest: it means
      // relative rules on this campaign still compound from the current value.
      key: 'baseline', label: 'Baseline · bounds',
      tip: 'The baseline anchors relative budget rules (−20% of the baseline is the same target every tick — no compounding). Floor/ceiling are denied at the write gate. Set below, in Guardrails & the baseline.',
      render: (r) => (
        r.budgetBaselineCents == null && r.minBudgetCents == null && r.maxBudgetCents == null
          ? <span className="h10-bud-nobase" title="No baseline captured and no bounds set — relative rules compound from the current value here.">—</span>
          : (
            <span className="h10-bud-base">
              {r.budgetBaselineCents != null && <em title="Baseline — the anchor relative rules compute from.">⚓ {eur(r.budgetBaselineCents)}</em>}
              {(r.minBudgetCents != null || r.maxBudgetCents != null) && (
                <em title="Gate-enforced bounds: a cut below the floor or a raise above the ceiling is denied.">
                  {r.minBudgetCents != null ? eur(r.minBudgetCents) : '—'}·{r.maxBudgetCents != null ? eur(r.maxBudgetCents) : '—'}
                </em>
              )}
            </span>
          )
      ),
      sortValue: (r) => r.budgetBaselineCents ?? -1,
    },
    {
      key: 'spend', label: `${days}d spend`,
      tip: 'From AmazonAdsDailyPerformance, entityType CAMPAIGN — never a denormalised column.',
      render: (r) => (r.measured ? eur(r.spend7dCents) : NOT_MEASURED),
      sortValue: (r) => (r.measured ? r.spend7dCents : -1), filterValue: (r) => r.spend7dCents / 100,
      total: (vis) => eur(vis.reduce((s, r) => s + r.spend7dCents, 0)),
    },
    {
      key: 'utilization', label: 'Utilisation',
      tip: 'A 7-DAY AVERAGE daily spend ÷ today’s budget. It cannot tell a campaign that runs dry at 10am from one that spends evenly, and after a cut the average still carries the pre-cut days — which is how a €1.00 campaign reads 392%. Amazon’s real out-of-budget hours are not ingested anywhere.',
      render: (r) => {
        if (r.utilization7d == null) return NO_VALUE
        const over = r.utilization7d > 1
        return (
          <span className={over ? 'h10-bud-util hi' : 'h10-bud-util'} title={over ? `${pct(r.utilization7d)} — the 7-day average daily spend is above today's budget, which usually means the budget was cut recently and the average still carries the days before the cut` : undefined}>
            {pct(r.utilization7d)}
            <i>7-day avg</i>
          </span>
        )
      },
      // 🔴 `sortValue` cannot return null — the shared grid types it `string | number`. Unknown
      // must still sort LAST in the default (descending) direction, so it is a sentinel below
      // every real value rather than a 0, which would put "never spent" among the low spenders.
      sortValue: (r) => r.utilization7d ?? Number.NEGATIVE_INFINITY, filterValue: (r) => (r.utilization7d ?? 0) * 100,
    },
    {
      key: 'lastMoved', label: 'Last moved',
      tip: 'The newest AUDITED write. Not "what this budget was before": 39% of consecutive audit rows do not chain, because the pacing engine and the rules overwrite each other holding stale reads.',
      render: (r) => {
        if (!r.lastMovedAt) return <span className="h10-bud-nd" title="No AD_BUDGET_UPDATE row for this campaign in the window">not in {days}d</span>
        const from = r.lastMovedFromCents
        const to = r.lastMovedToCents
        return (
          <span className="h10-bud-moved">
            <b>{from != null && to != null ? `${eur(from)} → ${eur(to)}` : '—'}</b>
            <i title={`${clockLabel(r.lastMovedAt)} Rome`}>
              {clockLabel(r.lastMovedAt)}
              {r.lastMovedBy && <> · {r.lastMovedBy}</>}
            </i>
            {r.lastMovedDelivered === false && (
              <em title="This write was skipped at dispatch by the live-write gate. The local budget changed; Amazon's did not.">never reached Amazon</em>
            )}
          </span>
        )
      },
      // '' sorts below every ISO timestamp, so "not moved in the window" lands at the bottom.
      sortValue: (r) => r.lastMovedAt ?? '',
    },
    {
      key: 'delta7d', label: `Moved in ${days}d`,
      tip: 'Today’s budget against the oldest audited value in the window — measured end to end, not by summing deltas, because the before→after chain is broken on 39% of rows.',
      render: (r) => {
        if (r.writes7d === 0) return <span className="h10-bud-nd">—</span>
        return (
          <span className={r.delta7dCents < 0 ? 'h10-bud-delta down' : r.delta7dCents > 0 ? 'h10-bud-delta up' : 'h10-bud-delta'}>
            {signedEur(r.delta7dCents)}
            {r.delta7dPct != null && <i>{signedPct(r.delta7dPct)}</i>}
          </span>
        )
      },
      // A campaign with no audited write has no movement to rank — not a movement of zero, which
      // would sort it between a cut and a raise as though it had been considered and left alone.
      sortValue: (r) => (r.writes7d === 0 ? Number.NEGATIVE_INFINITY : r.delta7dCents), filterValue: (r) => r.delta7dCents / 100,
    },
    {
      key: 'writes7d', label: 'Writes',
      tip: 'AD_BUDGET_UPDATE rows in the window, by any writer. A campaign written many times to the same value is the repeat-write loop, not activity.',
      render: (r) => (
        <span className="h10-bud-w">
          {num(r.writes7d)}
          {r.writes24h > 0 && <i title={`${r.writes24h} of them in the last 24 hours`}>{r.writes24h} in 24h</i>}
        </span>
      ),
      sortValue: (r) => r.writes7d, filterValue: (r) => r.writes7d,
      total: (vis) => num(vis.reduce((s, r) => s + r.writes7d, 0)),
    },
    {
      key: 'gate', label: 'Reaches Amazon', metric: false,
      tip: '🔴 The live-write allowlist gates DISPATCH, not the cut. A closed gate does not protect this budget — the local value is still cut and still audited; it simply stops matching what Amazon holds.',
      render: (r) => (
        r.gateOpen
          ? <span className="h10-bud-gate on" title="Live-write allowlist open — a budget change here is dispatched to Amazon">yes</span>
          : <span className="h10-bud-gate off" title="Live-write allowlist closed. Cuts still happen to the local budget and are still logged; they are skipped at dispatch, so this campaign DIVERGES from Amazon rather than being protected.">cut only locally</span>
      ),
      sortValue: (r) => (r.gateOpen ? 1 : 0),
    },
    {
      key: 'rules', label: 'Rules that reach it',
      tip: 'Budget rules whose SCOPE permits them to act on this campaign. Not "will act" — the conditions decide that. All six rules are account-wide today, which is why this number is the same on every row, and that sameness is the finding.',
      render: (r) => (
        <button
          type="button" className="h10-bud-rules"
          title="Show these rules"
          onClick={() => push({ view: 'rules' })}
        >{num(r.reachedByRuleIds.length)}</button>
      ),
      sortValue: (r) => r.reachedByRuleIds.length, filterValue: (r) => r.reachedByRuleIds.length,
    },
  ], [days, push])

  // ── rule columns ──────────────────────────────────────────────────────────────────────────────
  const ruleColumns: GridColumn<BudRuleRow>[] = useMemo(() => [
    {
      key: 'level', label: 'Level', metric: false,
      tip: 'The EFFECTIVE level from resolveAutonomy(rule) — not the stored dial. `enabled=false` is OFF whatever the dial says, and two of these six rules read differently between the two.',
      render: (r) => (
        <span className={`h10-bud-lvl ${r.level.toLowerCase()}`} title={LEVEL_LABEL[r.level].hint}>
          {LEVEL_LABEL[r.level].label}
        </span>
      ),
      sortValue: (r) => ({ OFF: 0, OBSERVE: 1, PROPOSE: 2, AUTO: 3 })[r.level],
    },
    {
      key: 'action', label: 'What it does',
      metric: false,
      tip: 'The adjust_ad_budget percent, applied to the CURRENT budget rather than to a baseline — so repeated application compounds.',
      render: (r) => (
        r.percent == null ? <span className="h10-bud-nd">—</span> : (
          <span className={r.percent < 0 ? 'h10-bud-pctc cut' : 'h10-bud-pctc raise'}>
            {r.percent > 0 ? '+' : '−'}{Math.abs(r.percent)}%
            {r.actionTypes.length > 1 && <i title={`Every action on this rule, in order: ${r.actionTypes.join(', ')}`}>+ {r.actionTypes.length - 1} more</i>}
          </span>
        )
      ),
      sortValue: (r) => r.percent ?? Number.NEGATIVE_INFINITY,
    },
    {
      key: 'trigger', label: 'Trigger', metric: false,
      tip: 'The context this rule is evaluated against. A rule reading campaign.* on an ad-target trigger can never match, which is why one of these has 0 matches in 4,864 evaluations.',
      render: (r) => <span className="h10-bud-trig">{r.trigger.replace(/_/g, ' ').toLowerCase()}</span>,
      sortValue: (r) => r.trigger,
    },
    {
      key: 'conditions', label: 'Conditions', metric: false,
      render: (r) => <span className="h10-bud-cond" title={r.conditionsText}>{r.conditionsText}</span>,
      sortValue: (r) => r.conditionsText,
    },
    {
      key: 'scope', label: 'Scope', metric: false,
      tip: 'Which campaigns this rule is BOUND to. Every one of the six is account-wide — no market, portfolio, campaign or product on any of them.',
      render: (r) => (
        <span className={r.scopeText === 'Account-wide' ? 'h10-bud-scopec wide' : 'h10-bud-scopec'}>{r.scopeText}</span>
      ),
      sortValue: (r) => r.scopeText,
    },
    {
      key: 'executions7d', label: `Ran (${days}d)`,
      tip: 'Executions in the window. An execution row exists BECAUSE the rule matched — there is no separate windowed match count, so this is both numbers.',
      render: (r) => (
        <span className="h10-bud-w">
          {num(r.executions7d)}
          {r.dryRun7d > 0 && <i title="Rehearsals — the level was below AUTO, so nothing was written">{num(r.dryRun7d)} rehearsed</i>}
        </span>
      ),
      sortValue: (r) => r.executions7d, filterValue: (r) => r.executions7d,
      total: (vis) => num(vis.reduce((s, r) => s + r.executions7d, 0)),
    },
    {
      key: 'wrote7d', label: `Changed a budget`,
      tip: 'Audit rows this rule actually wrote in the window, over the campaigns in scope. The gap between this and "Ran" is executions that succeeded while changing nothing — a trim recomputing €1 on a campaign already at €1.',
      render: (r) => (
        <span className={r.wrote7d > 0 ? 'h10-bud-wrote hot' : 'h10-bud-wrote'}>
          {num(r.wrote7d)}
          {r.executions7d > 0 && r.wrote7d === 0 && <i title="It ran and changed nothing — every campaign it matched was already at the floor">no-op</i>}
        </span>
      ),
      sortValue: (r) => r.wrote7d, filterValue: (r) => r.wrote7d,
      total: (vis) => num(vis.reduce((s, r) => s + r.wrote7d, 0)),
    },
    {
      key: 'refused7d', label: 'Refused',
      tip: '🔴 Cap refusals, counted as REFUSALS and never as failures — a rule stopped by its own daily cap is the cap working. A zero here is not reassurance: the cap has not refused anything since 2026-08-03, because the predicate that counts today’s executions is broken.',
      render: (r) => (
        <span className="h10-bud-ref">
          {num(r.refused7d)}
          {r.failed7d > 0 && <i title="Genuine errors, not cap refusals">{num(r.failed7d)} failed</i>}
        </span>
      ),
      sortValue: (r) => r.refused7d, filterValue: (r) => r.refused7d,
    },
    {
      key: 'canStillMove', label: 'Can still move',
      tip: 'Campaigns in its scope that are still above the €1 floor. The rest are campaigns it matches, writes to, and changes nothing on.',
      render: (r) => (
        <span className="h10-bud-still">
          {num(r.canStillMove)}
          <i title={`${r.alreadyAtFloor} campaigns in its scope are already at the €1 floor, where this rule is a no-op`}>{num(r.alreadyAtFloor)} at floor</i>
        </span>
      ),
      sortValue: (r) => r.canStillMove, filterValue: (r) => r.canStillMove,
    },
    {
      key: 'lastActed', label: 'Last ran',
      render: (r) => (r.lastActedAt ? <span className="h10-bud-when">{clockLabel(r.lastActedAt)}</span> : <span className="h10-bud-nd">never</span>),
      sortValue: (r) => r.lastActedAt ?? '',
    },
  ], [days])

  // ── filters ───────────────────────────────────────────────────────────────────────────────────
  // 🔴 Market is NOT a filter here: the header owns it.
  const filters: GridFilter[] = useMemo(() => {
    const stateFacet = (s: BudState) => data?.facets.state.find((f) => f.value === s)?.count ?? 0
    // FB.2 — the scope grains lead the bar in BOTH views. They narrow the rules view too (a rule is
    // shown with what it reaches), so leaving them out of that branch would make the same three
    // controls appear and vanish as you switch view.
    const scopeFilters = buildScopeFilters({ options, market, value: scope })
    const common: GridFilter[] = [
      {
        key: '__status', label: 'Status', kind: 'select', placeholder: 'Enabled',
        options: [
          { value: 'enabled', label: 'Enabled' }, { value: 'paused', label: 'Paused' },
          { value: 'archived', label: 'Archived' }, { value: 'all', label: 'Any status' },
        ],
      },
    ]
    if (view === 'rules') {
      return [
        ...scopeFilters,
        { key: 'executions7d', label: `Ran (${days}d)`, kind: 'range' },
        { key: 'wrote7d', label: 'Changed a budget', kind: 'range' },
        { key: 'canStillMove', label: 'Can still move', kind: 'range' },
      ]
    }
    return [
      ...scopeFilters,
      ...common,
      {
        key: '__state', label: 'State', kind: 'select', placeholder: 'Any state', wide: true,
        options: [
          { value: '', label: 'Any state' },
          ...BUD_STATES.map((s) => ({ value: s, label: `${STATE_LABEL[s].label} (${num(stateFacet(s))})` })),
        ],
      },
      { key: 'budget', label: 'Daily budget', kind: 'range', unit: '€' },
      { key: 'spend', label: `${days}d spend`, kind: 'range', unit: '€' },
      { key: 'utilization', label: 'Utilisation', kind: 'range', unit: '%' },
      { key: 'writes7d', label: 'Writes', kind: 'range' },
    ]
  }, [data, view, days, options, market, scope.line, scope.portfolio, scope.campaign])

  // The server-side chips ride the URL, so the grid's own filter state is only used for the numeric
  // ranges. Bridged here rather than inside AdsDataGrid, which stays untouched.
  const urlValues = useMemo(() => ({
    ...scopeToFilterState(scope), __status: status, __state: state ?? '',
  }), [scope.line, scope.portfolio, scope.campaign, status, state])

  const onUrlChange = useCallback((next: Record<string, string>) => {
    push({
      line: next.__line ?? '', portfolio: next.__portfolio ?? '', campaign: next.__campaign ?? '',
      status: next.__status ?? '', state: next.__state ?? '',
    })
  }, [push])

  const { filterState, setFilterState } = useMergedFilters({ urlValues, onUrlChange })

  const activeTab = rulesTabByKey('budget')
  const sc = data?.scope

  /** The one sentence stating what resolved. */
  const resolution = (() => {
    if (!sc || !census) return null
    const bits: string[] = [sc.market === 'all' ? 'All markets' : sc.market]
    bits.push(sc.campaigns == null ? `all ${num(sc.total)} campaigns` : `${num(sc.campaigns)} of ${num(sc.total)} campaigns`)
    bits.push(`${num(census.campaigns)} ${status === 'all' ? '' : `${status} `}here`)
    bits.push(`${eur(census.totalBudgetCents)}/day`)
    return bits.join(' · ')
  })()

  /**
   * The census. Every clickable cell reproduces its own number — verified against production with
   * `_bud-page-verify.mts`, which asserts each chip returns exactly the count its facet advertises.
   * Six cells, one row at 1280.
   */
  const CLEAR = { state: '', q: '' }
  const strip = census ? [
    {
      key: 'campaigns', n: num(census.campaigns), label: census.campaigns === 1 ? 'campaign' : 'campaigns',
      tip: 'Every campaign in this scope at the current status. Click to clear the state filter and the search.',
      on: !state && !q && view === 'campaigns',
      apply: () => push({ view: 'campaigns', ...CLEAR }),
    },
    {
      key: 'total', n: eur(census.totalBudgetCents), label: 'per day, in total',
      tip: 'Summed from the local Campaign.dailyBudget of the rows below. Click to sort the grid by the column this sums.',
      on: sortParam === 'budget',
      apply: () => push({ view: 'campaigns', ...CLEAR, sort: 'budget', dir: 'desc' }),
    },
    {
      key: 'floor', n: num(census.atFloor), label: 'at the €1 floor',
      tip: STATE_LABEL['at-floor'].hint,
      on: state === 'at-floor', apply: () => push({ view: 'campaigns', ...CLEAR, state: 'at-floor' }), tone: 'bad',
    },
    {
      key: 'cuttable', n: num(census.cuttable), label: 'a trim can still cut',
      tip: `Above €1, so a trim would write a genuinely lower number. ${census.reachesAmazon} of them would also reach Amazon; the other ${census.gateDenied} are cut locally and skipped at dispatch, so they diverge rather than being protected.`,
      on: state === 'cuttable', apply: () => push({ view: 'campaigns', ...CLEAR, state: 'cuttable' }),
    },
    {
      key: 'moved', n: num(census.moved24h), label: 'moved in 24h',
      tip: census.moved24h === 0
        ? 'No budget changed in the last 24 hours — because 58 of 86 campaigns are already at the floor, not because the rules stopped. Both AUTO rules are still evaluating every 15 minutes.'
        : `Pacing engine ${census.moved24hByPacer} · rules ${census.moved24hByRule} · a person ${census.moved24hByUser}`,
      on: state === 'moved-24h', apply: () => push({ view: 'campaigns', ...CLEAR, state: 'moved-24h' }), tone: 'muted',
    },
    {
      key: 'rules', n: num(census.rules), label: `rules · ${census.rulesActing} on auto`,
      tip: `${census.rules} rules can change a budget in this account. ${census.rulesActing} act on their own, and ${census.rulesCutOnly} of those only ever cut. Click to see them.`,
      on: view === 'rules', apply: () => push({ view: 'rules' }), tone: census.rulesCutOnly > 0 ? 'bad' : undefined,
    },
  ] : []

  /**
   * BUD.3 — restore the selected campaigns to their captured baselines. The server skips
   * no-baseline and already-there rows and reports each; the sentence here repeats its words
   * and never rounds a partial success up to a clean one.
   */
  const restoreSelected = async (ids: string[]) => {
    setWriteBusy(true); setWriteNote(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/budget-baselines/restore`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignIds: ids }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error ?? `Restore failed (${r.status})`)
      const failed = (j.results as Array<{ name: string; outcome: string; why?: string }> | undefined)?.filter((x) => x.outcome === 'failed') ?? []
      setWriteNote([
        `${j.restored} restored to baseline`,
        j.skipped ? `${j.skipped} skipped (no baseline, or already there)` : null,
        failed.length ? `${failed.length} refused — ${failed.slice(0, 2).map((f) => `“${f.name}”: ${f.why ?? 'refused'}`).join(' · ')}` : null,
        'Each write passed the gate as ENQUEUED; the change log is the delivery record.',
      ].filter(Boolean).join(' · '))
      setSel(new Set())
      setReloadTick((n) => n + 1)
    } catch (e) { setWriteNote(`Restore failed: ${(e as Error).message}`) } finally { setWriteBusy(false) }
  }

  /** BUD.6 — the transfer, source-first with compensation; the server's note is the verdict. */
  const doTransfer = async () => {
    const ids = [...sel]
    const fromId = transferFrom || ids[0]
    const toId = ids.find((x) => x !== fromId)
    const cents = Math.round(Number(transferEur) * 100)
    if (!fromId || !toId || !Number.isFinite(cents) || cents <= 0) return
    setWriteBusy(true); setWriteNote(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/budget-transfer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromId, toId, cents }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) {
        setWriteNote(`Transfer refused at the ${j?.stage ?? 'gate'}: ${j?.error ?? `(${r.status})`}${j?.note ? ` — ${j.note}` : ''}`)
      } else {
        setWriteNote(`Moved €${(cents / 100).toFixed(2)}/day: “${j.from?.name}” → “${j.to?.name}”. ${j.note ?? ''}`)
        setSel(new Set())
        setReloadTick((n) => n + 1)
      }
      setTransferOpen(false); setTransferEur(''); setTransferFrom('')
    } catch (e) { setWriteNote(`Transfer failed: ${(e as Error).message}`) } finally { setWriteBusy(false) }
  }

  const csv = () => {
    const head = view === 'campaigns'
      ? ['Campaign', 'Market', 'Status', 'Daily budget EUR', 'At floor', 'Gate open', `Spend ${days}d EUR`, 'Utilisation 7d avg %', 'Last moved', 'Last moved from EUR', 'Last moved to EUR', 'Last moved by', 'Delivered', `Delta ${days}d EUR`, 'Writes 24h', `Writes ${days}d`, 'Rules reaching']
      : ['Rule', 'Effective level', 'Trigger', 'Percent', 'Actions', 'Conditions', 'Scope', 'Cap per day', `Ran ${days}d`, 'Succeeded', 'Rehearsed', 'Changed a budget', 'Refused', 'Failed', 'Can still move', 'At floor in scope', 'Last ran']
    const cell = (v: unknown) => {
      const s = v == null ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const body = view === 'campaigns'
      ? campaigns.map((r) => [r.name, r.market, r.status, (r.dailyBudgetCents / 100).toFixed(2), r.atFloor ? 'yes' : 'no',
        r.gateOpen ? 'yes' : 'no', (r.spend7dCents / 100).toFixed(2),
        r.utilization7d == null ? '' : (r.utilization7d * 100).toFixed(0),
        r.lastMovedAt ?? '', r.lastMovedFromCents == null ? '' : (r.lastMovedFromCents / 100).toFixed(2),
        r.lastMovedToCents == null ? '' : (r.lastMovedToCents / 100).toFixed(2), r.lastMovedBy ?? '',
        r.lastMovedDelivered == null ? '' : r.lastMovedDelivered ? 'yes' : 'no',
        (r.delta7dCents / 100).toFixed(2), r.writes24h, r.writes7d, r.reachedByRuleIds.length])
      : rules.map((r) => [r.name, r.level, r.trigger, r.percent ?? '', r.actionTypes.join(' + '), r.conditionsText,
        r.scopeText, r.maxExecutionsPerDay ?? '', r.executions7d, r.succeeded7d, r.dryRun7d, r.wrote7d,
        r.refused7d, r.failed7d, r.canStillMove, r.alreadyAtFloor, r.lastActedAt ?? ''])
    const text = [head, ...body].map((line) => line.map(cell).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `budget-${view}-${market}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const searchBox = (
    <Input
      size="xs" fieldClassName="h10-bud-search"
      type="search" defaultValue={q}
      placeholder={view === 'campaigns' ? 'Search campaigns…' : 'Search rules…'}
      aria-label="Search"
      onKeyDown={(e) => { if (e.key === 'Enter') push({ q: (e.target as HTMLInputElement).value }) }}
      onBlur={(e) => { if (e.target.value !== q) push({ q: e.target.value }) }}
    />
  )

  const toolbarLeft = (
    <>
      <span className="h10-bud-seg" role="tablist" aria-label="Grain">
        {([['campaigns', 'Campaigns'], ['rules', 'Rules']] as const).map(([v, label]) => (
          <button
            key={v} type="button" role="tab" aria-selected={view === v}
            className={`seg ${view === v ? 'on' : ''}`}
            onClick={() => push({ view: v })}
            title={v === 'campaigns'
              ? 'One row per campaign — the grain a budget is actually set at'
              : 'One row per rule — what may change a budget, by how much, and what it did'}
          >{label}</button>
        ))}
      </span>
      {searchBox}
    </>
  )

  const toolbarRight = (
    <span className="h10-bud-win">
      {refresh.stale && (
        <button type="button" className="h10-bud-stale" onClick={() => setReloadTick((n) => n + 1)}
          title="A budget, or a rule execution, changed since this view was loaded. Nothing has been reordered underneath you — click to pick it up.">
          <RefreshCw size={12} /> Changed since you loaded
        </button>
      )}
      <Select
        size="xs"
        value={windowParam} onChange={(e) => push({ window: e.target.value })}
        aria-label="Window"
        title="The window the spend, movement and rule-activity columns are measured over."
      >
        <option value="7d">7 days</option>
        <option value="30d">30 days</option>
        <option value="60d">60 days</option>
      </Select>
    </span>
  )

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Budget Rules"
        subtitle={activeTab?.subtitle ?? 'What may change a budget, by how much, and what it actually did'}
        markets={MARKETS}
        market={market}
        /* 🔴 The header's picker is the ONLY market control on this page. `showMarket` does not
           exist; the scope bar below renders three grains and never a fourth for market. */
        onMarketChange={(m) => push({ market: m, campaign: '', portfolio: '' })}
        showDataSync={false}
        /* The window rides the grid toolbar, next to the grid it changes. The header's date picker
           would be a second control for the same fact, two rows apart. */
        showDateRange={false}
        showChangeLog
      />

      <RulesTabs active="budget" />

      {/* FB.2 — ONE bar: controls, then the numbers they produce, then the rows. */}
      <AdsFilterBar
        filters={filters}
        value={filterState}
        onChange={setFilterState}
        defaultOpen
        notesSlot={(
          <ScopeNotes
            applied={sc?.applied ?? []}
            notes={sc?.notes ?? []}
            contradiction={sc?.contradiction ?? null}
          />
        )}
      />

      {resolution && (
        <p className="h10-bud-said">
          <b>{resolution}</b>
          {data?.freshness.newestBudgetLogAt && <> · newest budget change {clockLabel(data.freshness.newestBudgetLogAt)}</>}
        </p>
      )}

      {err && <p className="h10-bud-note bad"><AlertTriangle size={13} /><span>{err}</span></p>}

      {census && (
        <div className="h10-bud-census" role="group" aria-label="What is in this scope">
          {strip.map((c) => (
            <button
              key={c.key} type="button" title={c.tip}
              className={`h10-bud-cell ${c.tone ?? ''} ${c.on ? 'on' : ''}`}
              onClick={c.apply}
            >
              <b>{c.n}</b><span>{c.label}</span>
            </button>
          ))}
        </div>
      )}

      {/*
        🔴 ONE block, not three. The first draft stacked the ratchet, the dead cap and the write-gate
        divergence as three separate warnings totalling 225px above the grid — measured on prod — and
        that is not "minimal teaching text", it is a wall an operator scrolls past. The ratchet and
        the cap are one story (a compounding cut, and the brake that would have stopped it), so they
        are one paragraph. The gate divergence is carried where it can be acted on instead: the
        "a trim can still cut" census cell states the 28 / 24 / 4 split in its tooltip, and the
        "Reaches Amazon" column says "cut only locally" on each of the four rows.
      */}
      {census && census.campaigns > 0 && census.atFloor / census.campaigns > 0.5 && (
        <p className="h10-bud-note warn">
          <AlertTriangle size={12} />
          <span>
            <b>{num(census.atFloor)} of {num(census.campaigns)} campaigns sit at Amazon&rsquo;s €1 minimum</b>,
            and <b>the budget rules did not put most of them there</b>. Measured 2026-08-16:{' '}
            <b>56 of them were floored by the pacing engine in single writes</b> — €100 → €1,
            €60 → €1 — and 55 of those inside one hour on 2026-08-05, when pacing still rewrote every
            budget to its target whether or not the monthly cap was at risk. That behaviour is fixed;
            it now acts only when the month is projected past its cap. Exactly <b>2</b> campaigns
            reached €1 by rule compounding, and both were already near €1 when the rules arrived.
            {census.rulesCutOnly > 0 && <> The compounding is still real, though: {census.rulesCutOnly === 1 ? 'one rule that only cuts is' : `${census.rulesCutOnly} rules that only cut are`} still on
            AUTO, applying their percentage to the <b>current</b> budget, so anything raised above €1
            gets walked back down.</>} What stops that is a <b>baseline</b>: capture one in{' '}
            <a href="#bud-guardrails">Guardrails &amp; the baseline</a> below and every relative rule
            anchors to it instead of walking.
          </span>
        </p>
      )}

      {data?.truncated && (
        <p className="h10-bud-note warn">
          <AlertTriangle size={12} />
          <span>This scope holds more than 5,000 campaigns and the grid is showing the first 5,000 by budget. Narrow the scope — the export would be truncated too.</span>
        </p>
      )}

      {writeNote && (
        <p className="h10-bud-note" role="status">
          <Info size={12} />
          <span>{writeNote}</span>
        </p>
      )}

      {view === 'campaigns' ? (
        <AdsDataGrid<BudCampaignRow>
          rows={campaigns}
          loading={loading}
          rowId={(r) => r.id}
          noun="Campaign"
          firstColLabel="Campaign"
          renderFirst={(r) => (
            <div className="h10-bud-camp">
              <Link className="t" href={`/marketing/ads/campaigns/${r.id}`} title={r.name}>{r.name}</Link>
              {r.status !== 'ENABLED' && <span className="fl off" title={`This campaign is ${r.status.toLowerCase()} — its budget buys nothing`}>{r.status.toLowerCase()}</span>}
            </div>
          )}
          firstSortValue={(r) => r.name.toLowerCase()}
          columns={campaignColumns}
          filters={filters}
          filterState={filterState}
          onFilterStateChange={setFilterState}
          hideFilterPanel
          defaultSort={sortParam ? { key: sortParam, dir: dirParam } : { key: 'budget', dir: 'desc' }}
          onSortChange={onSortChange}
          showTotal
          totalFirst={`${num(campaigns.length)} shown`}
          /* BUD.3/BUD.6 — the page writes now (BUD.2 ended the read-only era): selection carries
             the two acts this page owns — restore to a captured baseline, and the sideways move
             neither AUTO rule can make. Both are gated per write; a denial reports, never hides. */
          selectable
          selected={sel}
          onSelectedChange={setSel}
          selectionActions={(ids) => {
            const chosen = campaigns.filter((c) => ids.includes(c.id))
            const restorable = chosen.filter((c) => c.budgetBaselineCents != null && c.budgetBaselineCents !== c.dailyBudgetCents)
            return (
              <span className="h10-bud-selrow">
                <Button
 variant="ghost"
 disabled={writeBusy || restorable.length === 0}
 title={restorable.length === 0 ? 'None of the selected campaigns has a baseline it is away from — capture baselines below first.' : `Write each campaign's budget back to its captured baseline. ${chosen.length - restorable.length > 0 ? `${chosen.length - restorable.length} of the selection will be skipped (no baseline, or already there).` : ''}`}
 onClick={() => void restoreSelected(ids)}
 >
                  Restore {restorable.length > 0 ? `${restorable.length} ` : ''}to baseline
                </Button>
                <Button
 variant="ghost"
 disabled={writeBusy || ids.length !== 2}
 title={ids.length === 2 ? 'Move €/day from one of the two selected campaigns to the other.' : 'Select exactly two campaigns to transfer budget between them.'}
 onClick={() => setTransferOpen(true)}
 >
                  Transfer…
                </Button>
              </span>
            )
          }}
          onRowClick={WRITE_ACTIONS.onRowAction ?? undefined}
          exportable
          onExport={csv}
          pagerCentered
          storageKey="nexus.budget.cols"
          toolbarLeft={toolbarLeft}
          toolbarRight={toolbarRight}
          emptyNode={<EmptyState loading={loading} data={data} q={q} state={state} push={push} />}
          reportLabel={data?.freshness.newestPerfDate ? `Performance data through ${new Date(data.freshness.newestPerfDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : undefined}
        />
      ) : (
        <AdsDataGrid<BudRuleRow>
          rows={rules}
          loading={loading}
          rowId={(r) => r.id}
          noun="Rule"
          firstColLabel="Rule"
          renderFirst={(r) => (
            /* BUD.3 — the name opens the rule's RECORD, which lives on Automations (one owner:
               that page owns the actor; this one renders outcomes and links). ?rule= deep-links
               its drawer. */
            <div className="h10-bud-rule">
              <Link className="t" href={`/marketing/ads/rules-automation/automations?rule=${r.id}`} title={`${r.name} — open its record on Automations (mode, ceiling, scope, history, simulate)`}>{r.name}</Link>
              {!r.enabled && <span className="fl off" title="Switched off — it does not evaluate">off</span>}
              {r.acts && r.percent != null && r.percent < 0 && (
                <span className="fl cut" title="This rule changes budgets on its own, and the only budget change it makes is a cut">cuts, on its own</span>
              )}
            </div>
          )}
          firstSortValue={(r) => r.name.toLowerCase()}
          columns={ruleColumns}
          filters={filters}
          filterState={filterState}
          onFilterStateChange={setFilterState}
          hideFilterPanel
          defaultSort={sortParam ? { key: sortParam, dir: dirParam } : { key: 'level', dir: 'desc' }}
          onSortChange={onSortChange}
          showTotal
          totalFirst={`${num(rules.length)} shown`}
          selectable={false}
          exportable
          onExport={csv}
          pagerCentered
          storageKey="nexus.budget.rulecols"
          toolbarLeft={toolbarLeft}
          toolbarRight={toolbarRight}
          emptyNode={<EmptyState loading={loading} data={data} q={q} state={state} push={push} />}
        />
      )}

      {/* ── The six sections that follow. Every one attaches in BudgetSections, which renders null
             today; nobody restructures this client to add one. ──────────────────────────────────── */}
      <BudgetSections {...slotProps} />

      {/* BUD.4 — the interim RuleListTab is GONE: the Rules view above is the honest list
          (resolveAutonomy levels, refusals in their own column), each name opens its record on
          Automations, and the builder entry lives below. Pending budget proposals queue in ONE
          inbox — Automations' Queue — per the section's one-owner rule. */}
      <p className="h10-bud-foot">
        <a className="nds-btn" href="/marketing/ads/rules-automation/builder/budget"><Plus size={13} /> New budget rule</a>
        <a className="nds-btn link" href="/marketing/ads/rules-automation/automations?view=queue">Pending budget proposals live in the Queue →</a>
      </p>

      {transferOpen && (() => {
        const ids = [...sel]
        const a = campaigns.find((c) => c.id === ids[0])
        const b = campaigns.find((c) => c.id === ids[1])
        if (!a || !b) return null
        const from = transferFrom === b.id ? b : a
        const to = from.id === a.id ? b : a
        return (
          <div className="h10-ntm-back" onClick={() => setTransferOpen(false)}>
            <div className="h10-ntm" role="dialog" aria-modal="true" aria-label="Transfer budget" onClick={(e) => e.stopPropagation()}>
              <div className="h10-ntm-h"><b>Transfer daily budget</b></div>
              <div className="h10-ntm-sub">
                Moves €/day sideways — the action neither AUTO rule can make. Two gated writes, source first;
                if the destination raise is refused, the source is put back and the outcome says so.
              </div>
              <div className="h10-ntm-b">
                <label className="h10-bud-xferrow">
                  <span>From</span>
                  <Listbox
                    width={280}
                    options={[a, b].map((c) => ({ value: c.id, label: `${c.name} (€${(c.dailyBudgetCents / 100).toFixed(2)}/day)` }))}
                    value={from.id}
                    onChange={setTransferFrom}
                    ariaLabel="Source campaign"
                  />
                </label>
                <p className="h10-bud-xferto">→ “{to.name}” (€{(to.dailyBudgetCents / 100).toFixed(2)}/day)</p>
                <label className="h10-bud-xferrow">
                  <span>Amount</span>
                  <Input fieldClassName="h10-au-limitcap" prefix="€" suffix="/day" inputMode="decimal" placeholder="0.00" value={transferEur} onChange={(e) => setTransferEur(e.target.value)} aria-label="Amount in euros per day" autoFocus />
                </label>
                {Number(transferEur) > 0 && (from.dailyBudgetCents - Math.round(Number(transferEur) * 100)) < 100 && (
                  <p className="h10-au-limiterr"><AlertTriangle size={13} aria-hidden /> That would take “{from.name}” below Amazon&rsquo;s €1 floor — the server will refuse it.</p>
                )}
              </div>
              <div className="h10-ntm-f">
                <button type="button" className="cancel" onClick={() => setTransferOpen(false)}>Cancel</button>
                <span className="grow" />
                <button type="button" className="apply" disabled={writeBusy || !(Number(transferEur) > 0)} onClick={() => void doTransfer()}>
                  {writeBusy ? 'Working…' : `Move €${(Number(transferEur) || 0).toFixed(2)}/day`}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

/** An empty grid has four different causes here, and saying which one is the whole job. */
function EmptyState({ loading, data, q, state, push }: {
  loading: boolean
  data: BudGridPayload | null
  q: string
  state: BudState | null
  push: (p: Record<string, string>) => void
}) {
  if (loading) return <span className="h10-page-empty"><b>Loading…</b></span>
  if (!data) return <span className="h10-page-empty"><b>Nothing loaded.</b><span>The read failed — the message above says why.</span></span>
  if (data.scope.contradiction) {
    return (
      <span className="h10-page-empty">
        <b>Nothing can match this scope.</b>
        <span>{data.scope.contradiction}</span>
      </span>
    )
  }
  if (data.census.campaigns === 0) {
    return (
      <span className="h10-page-empty">
        <b>No campaigns in this scope.</b>
        <span>
          That is a real zero: {num(data.scope.campaigns ?? data.scope.total)} campaigns resolved and
          none of them is at this status.
        </span>
      </span>
    )
  }
  return (
    <span className="h10-page-empty">
      <b>{num(data.census.campaigns)} campaigns are in this scope — the filters hide all of them.</b>
      <span>
        {q ? <>Nothing matches “{q}”. </> : null}
        {state ? <>{STATE_LABEL[state].label} is empty here. </> : null}
        <button type="button" className="lnk" onClick={() => push({ q: '', state: '' })}>Clear the filters</button>
      </span>
    </span>
  )
}
