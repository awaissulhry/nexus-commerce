'use client'

/**
 * BUD.1 — Budget Rules, promoted from a tab to its own page, with a live read-only grid.
 *
 * The page answers one question: **what is allowed to change a campaign's budget, by how much, and
 * was it right?** BUD.1 builds the first two thirds — what each budget is, what moved it, and which
 * rules may reach it — over the whole account, at two grains, for four markets. Guardrails, the
 * baseline, the rule record, proposals, reallocation and notifications are BUD.2–BUD.7 and every
 * one of them is a slot at the bottom of this file.
 *
 * 🔴 **Read-only, and stated rather than implied.** No budget and no rule moves from this page. The
 * grid's write-capable props are passed as explicit nulls via `NO_WRITE_ACTIONS`. The two AUTO
 * rules are still armed and the operator has not authorised the intervention: BUD.1 SHOWS the
 * ratchet, BUD.2 stops it.
 *
 * What replaced the tab: `?tab=budget` rendered `<RuleListTab liveType="budget" />` — three columns
 * of rules whose edits changed React state and nothing else, over a Delete that said "cannot be
 * undone" and removed a row while the rule survived. It showed neither the 2,386 budget changes nor
 * the two rules making them. The rule list is still here, at the bottom, lifted verbatim and
 * labelled provisional, because routing a tab must not take anything out of the product. BUD.4
 * replaces it.
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
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, Info, Plus, RefreshCw } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { useCursorPoll } from '../_shared/useCursorPoll'
import { getBackendUrl } from '@/lib/backend-url'
import { BudgetScopeBar, type BudScopeValue, type ScopeOptionsPayload } from './BudgetScopeBar'
import {
  BUD_STATES, LEVEL_LABEL, STATE_LABEL,
  type BudCampaignRow, type BudGridPayload, type BudRuleRow, type BudState, type BudView,
} from './types'
import { NO_WRITE_ACTIONS, type BudSlotProps } from './slot-contract'
import { BudgetSections } from './BudgetSections'
// Interim, until BUD.4 replaces it: rendered exactly as the tab rendered it, so nothing is lost in
// the move off `?tab=budget`.
import { RuleListTab } from '../tabs/RuleListTab'
import { NoDataIllus } from '../_shared/NoDataIllus'

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
  const scope: BudScopeValue = {
    product: params.get('product') ?? '',
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

  const push = useCallback((patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      const isDefault =
        !v || v === 'all'
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
    const qs = next.toString()
    // `push`, not `replace`: back and forward have to walk the filter history. A grid whose filters
    // cannot be undone with the browser's own back button is a grid people stop filtering.
    router.push(qs ? `?${qs}` : '?', { scroll: false })
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
    for (const [k, v] of Object.entries({ product: scope.product, portfolio: scope.portfolio, campaign: scope.campaign, q })) {
      if (v) p[k] = v
    }
    if (state) p.state = state
    if (sortParam) { p.sort = sortParam; p.dir = dirParam }
    return p
  }, [market, view, status, windowParam, scope.product, scope.portfolio, scope.campaign, q, state, sortParam, dirParam])

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
  }, [market, view, status, scope.product, scope.portfolio, scope.campaign])

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
        { key: 'executions7d', label: `Ran (${days}d)`, kind: 'range' },
        { key: 'wrote7d', label: 'Changed a budget', kind: 'range' },
        { key: 'canStillMove', label: 'Can still move', kind: 'range' },
      ]
    }
    return [
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
  }, [data, view, days])

  // The server-side chips ride the URL, so the grid's own filter state is only used for the numeric
  // ranges. Bridged here rather than inside AdsDataGrid, which stays untouched.
  const initialFilters = useMemo(() => ({ __status: status, __state: state ?? '' }), [status, state])

  const onFilterChange = useCallback((next: Record<string, unknown>) => {
    const s = (k: string) => (typeof next[k] === 'string' ? (next[k] as string) : '')
    push({ status: s('__status'), state: s('__state') })
  }, [push])

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
    <span className="h10-bud-search">
      <input
        type="search" defaultValue={q}
        placeholder={view === 'campaigns' ? 'Search campaigns…' : 'Search rules…'}
        aria-label="Search"
        onKeyDown={(e) => { if (e.key === 'Enter') push({ q: (e.target as HTMLInputElement).value }) }}
        onBlur={(e) => { if (e.target.value !== q) push({ q: e.target.value }) }}
      />
    </span>
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
      <select
        value={windowParam} onChange={(e) => push({ window: e.target.value })}
        aria-label="Window" className="h10-bud-select"
        title="The window the spend, movement and rule-activity columns are measured over."
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
        title="Budget Rules"
        subtitle={activeTab?.subtitle ?? 'What may change a budget, by how much, and what it actually did'}
        markets={MARKETS}
        market={market}
        /* 🔴 The header's picker is the ONLY market control on this page. `showMarket` does not
           exist; the scope bar below renders three grains and never a fourth for market. */
        onMarketChange={(m) => push({ market: m, campaign: '', portfolio: '' })}
        showLearn={false}
        showDataSync={false}
        /* The window rides the grid toolbar, next to the grid it changes. The header's date picker
           would be a second control for the same fact, two rows apart. */
        showDateRange={false}
        showChangeLog
      />

      <RulesTabs active="budget" />

      <BudgetScopeBar
        options={options}
        market={market}
        scope={scope}
        applied={sc?.applied ?? []}
        notes={sc?.notes ?? []}
        contradiction={sc?.contradiction ?? null}
        onChange={(next) => push({ product: next.product, portfolio: next.portfolio, campaign: next.campaign })}
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

      {/* 🔴 The sentence the whole page exists to make unmissable. Rendered whenever a majority of
          the scope is pinned at the floor, which today is always. */}
      {census && census.campaigns > 0 && census.atFloor / census.campaigns > 0.5 && (
        <p className="h10-bud-note bad">
          <AlertTriangle size={12} />
          <span>
            <b>{num(census.atFloor)} of {num(census.campaigns)} campaigns sit at Amazon&rsquo;s €1 minimum</b>, and{' '}
            {census.rulesCutOnly > 0 && <>{census.rulesCutOnly === 1 ? 'a rule that only cuts is' : `${census.rulesCutOnly} rules that only cut are`} still running on their own. </>}
            Each applies its percentage to the <b>current</b> budget rather than to a baseline, every
            15 minutes, with no cooldown — so ten applications of −20% leave a budget at 11% of where
            it started. That is why these {num(census.atFloor)} are here, and it is also why the
            trims now change nothing: they have consumed their own target space. The{' '}
            {num(census.cuttable)} campaigns still above €1 are the entire reachable surface.
          </span>
        </p>
      )}

      {/* The cap is the only brake, and it is not connected. Stated where the refusal count is zero,
          because a zero there reads as "nothing was refused" when it means "nothing can be". */}
      {census && census.rulesActing > 0 && (
        <p className="h10-bud-note bad">
          <AlertTriangle size={12} />
          <span>
            <b>The daily execution cap is not enforced, for any rule.</b> The query that counts
            today&rsquo;s executions excludes every successful one — it tests{' '}
            <code>NOT (errorMessage = &lsquo;DAILY_CAP_EXCEEDED&rsquo;)</code>, which is NULL rather
            than true for the null error message a success carries. Measured today: the predicate
            returns <b>0</b> where the correct one returns the rule&rsquo;s full count, and one rule
            with a cap of 5 has already run 5 times without being refused. No rule has been refused
            since 2026-08-03. <b>There is currently no brake on the ratchet at all</b> — which is
            what a &ldquo;Refused&rdquo; column of zeroes below actually means.
          </span>
        </p>
      )}

      {/* Two numbers that look like one. Only rendered where the gate has actually denied something. */}
      {census && census.gateDenied > 0 && (
        <p className="h10-bud-note">
          <Info size={12} />
          <span>
            <b>{num(census.gateDenied)} of the {num(census.cuttable)} campaigns a trim can cut would not reach Amazon.</b>{' '}
            The live-write gate runs at dispatch, not at the cut — so on those the local budget is
            still lowered and still audited, and only the delivery is skipped. They are diverging
            from Amazon, not protected from the rule.
          </span>
        </p>
      )}

      {data?.truncated && (
        <p className="h10-bud-note bad">
          <AlertTriangle size={12} />
          <span>This scope holds more than 5,000 campaigns and the grid is showing the first 5,000 by budget. Narrow the scope — the export would be truncated too.</span>
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
          initialFilters={initialFilters}
          onFilterChange={onFilterChange}
          defaultSort={sortParam ? { key: sortParam, dir: dirParam } : { key: 'budget', dir: 'desc' }}
          onSortChange={onSortChange}
          showTotal
          totalFirst={`${num(campaigns.length)} shown`}
          /* 🔴 BUD.1 is read-only. Passed as explicit absence rather than omitted. */
          selectable={false}
          selectionActions={NO_WRITE_ACTIONS.selectionActions ?? undefined}
          onRowClick={NO_WRITE_ACTIONS.onRowAction ?? undefined}
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
            /* 🔴 NOT a link — BUD.3 makes this open the rule record. The shared grid paints the
               first column #1f6fde at (0,3,1) because every other consumer makes it one, so the
               colour is overridden at matching specificity in rules-automation.css. */
            <div className="h10-bud-rule">
              <span className="t" title={r.name}>{r.name}</span>
              {!r.enabled && <span className="fl off" title="Switched off — it does not evaluate">off</span>}
              {r.acts && r.percent != null && r.percent < 0 && (
                <span className="fl cut" title="This rule changes budgets on its own, and the only budget change it makes is a cut">cuts, on its own</span>
              )}
            </div>
          )}
          firstSortValue={(r) => r.name.toLowerCase()}
          columns={ruleColumns}
          filters={filters}
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

      {/* Interim until BUD.4: the rule list exactly as `?tab=budget` rendered it, so routing the tab
          takes nothing out of the product. BUD.4 deletes this block and its two imports. */}
      <div className="h10-bud-prov">
        <h2>
          Budget rules
          <i>Provisional — this is the old tab, moved unchanged. Its columns edit local state only
          and its Delete removes a row without deleting the rule. BUD.4 replaces it with the Rules
          view above, made editable.</i>
        </h2>
      </div>
      <RuleListTab
        noun="Budget Rule"
        seed={[]}
        liveType="budget"
        editHref={(id) => `/marketing/ads/rules-automation/builder/budget?ruleId=${id}`}
        onAddRule={() => { window.location.href = '/marketing/ads/rules-automation/builder/budget' }}
        emptyNode={(
          <span className="h10-rr-empty">
            <NoDataIllus size={104} />
            <b>Create a Budget Rule to generate suggestions for a campaign!</b>
            <a className="h10-am-btn primary" href="/marketing/ads/rules-automation/builder/budget"><Plus size={13} /> Create Rule</a>
          </span>
        )}
      />
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
  if (loading) return <span className="h10-bud-empty"><b>Loading…</b></span>
  if (!data) return <span className="h10-bud-empty"><b>Nothing loaded.</b><span>The read failed — the message above says why.</span></span>
  if (data.scope.contradiction) {
    return (
      <span className="h10-bud-empty">
        <b>Nothing can match this scope.</b>
        <span>{data.scope.contradiction}</span>
      </span>
    )
  }
  if (data.census.campaigns === 0) {
    return (
      <span className="h10-bud-empty">
        <b>No campaigns in this scope.</b>
        <span>
          That is a real zero: {num(data.scope.campaigns ?? data.scope.total)} campaigns resolved and
          none of them is at this status.
        </span>
      </span>
    )
  }
  return (
    <span className="h10-bud-empty">
      <b>{num(data.census.campaigns)} campaigns are in this scope — the filters hide all of them.</b>
      <span>
        {q ? <>Nothing matches “{q}”. </> : null}
        {state ? <>{STATE_LABEL[state].label} is empty here. </> : null}
        <button type="button" className="lnk" onClick={() => push({ q: '', state: '' })}>Clear the filters</button>
      </span>
    </span>
  )
}
