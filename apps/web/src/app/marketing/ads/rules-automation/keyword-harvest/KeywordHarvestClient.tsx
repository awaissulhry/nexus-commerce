'use client'

/**
 * HV.1 — Keyword Harvest, its own page.
 *
 * **One question: which search terms have earned their own keyword — and did the last batch work?**
 * HV.1 answers the first half only, and does not pretend to answer the second: the cohort view is
 * HV.5, and until it exists this page says nothing about what a harvested keyword went on to do.
 *
 * It is read-only. No approve, no reject, no bulk, no promote, no negate, no threshold control.
 * Those are HV.2, HV.4 and HV.7, and each has a stub below holding its place.
 *
 * Six laws, each one a mistake already made in this codebase:
 *
 *   1. **A blank is not a zero.** ACoS with no sales and CPC with no clicks render `—` with the
 *      reason on hover, never `0.00`. "not measured" and a real zero are different facts.
 *   2. **`local-only` is a status, not an absence.** 210 of 2,129 positive keywords exist here and
 *      not at Amazon, and **209 of those 210 were written by the harvest engine, each reporting
 *      success.** A row saying "already exact" when the keyword never reached Amazon is the same
 *      lie as an empty grid under a badge of 5.
 *   3. **Hidden, not disabled.** There is no greyed-out Approve button waiting for HV.4. A disabled
 *      control that will never enable is the same defect class as the Delete button on
 *      `RuleListTab.tsx:120` that promises "this cannot be undone" and mutates `useState`.
 *   4. **Four empty states, never one string** — *not measured · nothing to do · filtered out ·
 *      could not load*. "Never ran" and "nothing to do" must never render the same (doctrine D4).
 *   5. **Never read `AdTarget.impressions/clicks/spendCents/salesCents/ordersCount`** — measured 0
 *      on all 5,213 rows. Every metric here comes from `AmazonAdsSearchTerm`.
 *   6. **Negativity is `isNegative`, not `expressionType`** — 1,068 negatives are stored with a
 *      positive-sounding match type. The Blocked column is counted server-side on `isNegative`.
 *
 * 🔴 And the one this page had to discover for itself: **`previewHarvest` has no match-type
 * filter**, so a term that matched an EXACT keyword is offered as a candidate to create that same
 * keyword. Without the *Matched via* column, "0 of 14 are new" reads as a finding about the account
 * when for 5 of them it is the definition of the input. The column is what separates a tautology
 * from a genuine PHRASE/BROAD/auto discovery.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, ArrowUpRight, Check, Copy, Info } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { useAdsMarketplace } from '../../_shell/MarketplaceContext'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { getBackendUrl } from '@/lib/backend-url'
import { AdsFilterBar } from '../../campaigns/_grid/AdsFilterBar'
import { buildScopeFilters, scopeToFilterState, type ScopeOptionsPayload, type ScopeValue } from '../_shared/scopeFilters'
import { useMergedFilters } from '../_shared/useMergedFilters'

/** This page carries the ad-group grain, so its scope is the shared one with `adGroup` required. */
type HvScope = ScopeValue & { adGroup: string }
import {
  // 🔴 NO_WRITE_ACTIONS is gone: HV.4 supplies the selection action, which is what the seam was
  // holding open. `onRowClick` still patches the URL rather than mutating anything.
  type HarvestRow, type HvCensus, type HvFreshness, type HvGrain, type HvSlotProps, type HvStatus,
  type HvCriteriaState, type HvAttrition,
} from './slot-contract'
// The seven sections that follow. Each renders null until its session lands; each takes the same
// typed props, so a later section is one file and one import line. Nobody restructures this client.
import { HvThresholds } from './HvThresholds'
import { HvDestination, DestName, DEST_STATUS_LABEL, DEST_STATUS_TIP } from './HvDestination'
import { HvPromote, promoteSelectionActions } from './HvPromote'
import { HvCohort } from './HvCohort'
import { HvActors } from './HvActors'
import { HvQueue } from './HvQueue'
import { HvRepairs } from './HvRepairs'
// Interim, until HV.6 and HV.7 replace it: the rule list exactly as the tab rendered it, so
// nothing is lost in the move off `?tab=keyword-harvest`.
import { TabRules } from '../_shared/TabRules'
import { useAdsSync } from '../_shared/adsBus'
import { useCursorBaseline, useCursorPoll } from '../_shared/useCursorPoll'
import { StaleBanner } from '../_shared/StaleBanner'

/** The four production Amazon Ads markets, plus the account-wide view the header already offers. */
const MARKETS = ['IT', 'DE', 'ES', 'FR']
const FALLBACK_MARKET = 'all'

interface Payload {
  scope: {
    market: string
    boundBy: HvGrain
    line: { id: string; name: string } | null
    portfolio: { id: string; name: string } | null
    campaign: { id: string; name: string } | null
    adGroup: { id: string; name: string } | null
    resolved: { campaigns: number; campaignsInMarket: number; campaignsWithTerms: number; adGroups: number }
    adGroupOptions: Array<{ id: string; name: string; campaignName: string; terms: number }>
  }
  window: { days: number; since: string; until: string }
  thresholds: { minOrders: number; minSpendEur: number }
  criteria: HvCriteriaState
  attrition: HvAttrition
  freshness: HvFreshness
  census: HvCensus
  facets: {
    status: Array<{ value: HvStatus; count: number }>
    kind: Array<{ value: string; count: number }>
    market: Array<{ value: string; count: number }>
    targetingType: Array<{ value: string; count: number }>
    matchedVia: Array<{ value: string; count: number }>
  }
  rows: HarvestRow[]
  total: number
  truncated: boolean
}

const num = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dayMonth = (iso: string) => {
  const d = new Date(iso)
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}

const STATUS_LABEL: Record<HvStatus, string> = {
  'new': 'new',
  'already-exact-here': 'already exact here',
  'exact-elsewhere': 'exact elsewhere',
  'local-only': 'local only',
}
const STATUS_TIP: Record<HvStatus, string> = {
  'new': 'No positive keyword for this text anywhere in the account. Harvesting it would create something that does not exist.',
  'already-exact-here': 'An EXACT keyword for this text already exists in the ad group the traffic came from, and Amazon has confirmed it. Harvesting it would create nothing.',
  'exact-elsewhere': 'An EXACT keyword for this text exists, but in a different ad group. Whether that counts as covered is a destination question — HV.3.',
  'local-only': 'A keyword row exists in the source ad group and NONE of them ever reached Amazon. Nexus thinks it is covered; the auction has never seen it.',
}

export function KeywordHarvestClient() {
  const router = useRouter()
  const params = useSearchParams()
  // 🔴 The one deliberate exception to "absent means the documented default": a market is a place
  // you work in, not a view of a dataset, so an absent `?market=` falls back to the console's
  // persisted choice. That makes the URL ambiguous for a reader, which is why Copy link writes the
  // resolved market in explicitly rather than sharing whatever the opener happens to have set.
  const { market: ctxMarket, ready: marketReady } = useAdsMarketplace()
  const urlMarket = params.get('market')
  const market = urlMarket ?? (marketReady ? (ctxMarket || FALLBACK_MARKET) : FALLBACK_MARKET)

  const scope: HvScope = {
    line: params.get('line') ?? '',
    portfolio: params.get('portfolio') ?? '',
    campaign: params.get('campaign') ?? '',
    adGroup: params.get('adGroup') ?? '',
  }
  const status = (params.get('status') ?? 'all') as HvStatus | 'all'
  const kind = (params.get('kind') ?? 'all') as 'keyword' | 'product' | 'all'
  const q = params.get('q') ?? ''
  const row = params.get('row')
  // HV.3 — how the destination resolved, and the self-competition filter.
  const dest = params.get('dest') ?? 'all'
  const competing = params.get('competing') ?? ''
  // HV.4 — the candidates queued for the confirm dialog. Repeated params, because a candidate id
  // is `market|campaign|adGroup|term` and a term may contain a comma or a pipe.
  const confirm = params.getAll('confirm')
  // HV.5 — the second view. `?view=` was reserved in HV.1's contract for exactly this: the cohort
  // is a VIEW on this page, not a route and not a twelfth page.
  const view = params.get('view') === 'harvested' ? 'harvested' : 'candidates'
  // Read here so a link can carry them; the CONTROLS that move them are HV.2. `?minOrders=` is the
  // one that matters — the whole finding of the study is that the threshold decides whether this
  // tab has any content.
  // HV.2 — the FILTER half. Absent means "use the policy in force for this scope", which the
  // server resolves; it never means a hard-coded default in this client.
  const minOrders = params.get('minOrders')
  const minClicks = params.get('minClicks')
  const maxAcos = params.get('maxAcos')
  const matched = params.get('matched')
  const minSpend = params.get('minSpend')
  const windowParam = params.get('window')

  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [options, setOptions] = useState<ScopeOptionsPayload | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const [copied, setCopied] = useState(false)

  /**
   * 🔴 HV.10 — `market` is the one key where `'all'` is a VALUE, not an absence.
   *
   * Every other filter here means "no filter" when it reads `all` — `status`, `kind`, `dest`,
   * `matched` — so dropping the param is right for them and keeps the URL short. `market` is not
   * one of those: this page's read accepts `market=all` as a real scope (`HV_MARKET_ALL`) covering
   * every marketplace, and an absent `?market=` means something *different* — fall back to the
   * console's persisted choice, per the note on `ctxMarket` above.
   *
   * Deleting it on `'all'` therefore made "All markets" unselectable. Measured on prod 2026-08-14:
   * choosing it wrote no param, the resolver fell through to the context market, and the header
   * snapped back to 🇫🇷 France — which has **0 candidates**, while `all` has 6. The operator landed
   * on an empty page and the one control that would have shown them data silently refused. The
   * picker was not broken; it was being overruled one line later.
   */
  const ALL_IS_A_VALUE = new Set(['market'])
  // RT.1 — your own writes, from any tab, applied silently. An ENGINE's write arrives on the
  // other rail (the cursor poll) and offers a banner instead; see `_shared/adsBus.ts`.
  useAdsSync(['ads.keyword.changed', 'ads.negative.changed', 'ads.suggestion.changed', 'ads.rule.changed'], () => setReloadTick((n) => n + 1))

  // RT.2 — the cursor. Harvest's subject is EXISTENCE (does this term have a keyword yet), so the
  // cursor counts rather than reading `AdTarget.updatedAt` — measured, that column moved on 2,937
  // of 3,155 rows in three hours because `ads-v1-sync` re-stamps every matched row.
  const hvCursorParams = useMemo(() => {
    const p: Record<string, string> = { market }
    if (scope.campaign) p.campaign = scope.campaign
    return p
  }, [market, scope.campaign])
  const hvCursorUrl = `${getBackendUrl()}/api/advertising/keyword-harvest/cursor`
  const hvBaseline = useCursorBaseline<Record<string, unknown>>(hvCursorUrl, hvCursorParams, reloadTick)
  const hvRefresh = useCursorPoll<Record<string, unknown>>({ url: hvCursorUrl, params: hvCursorParams, baseline: hvBaseline })

  const push = useCallback((patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (!v || (v === 'all' && !ALL_IS_A_VALUE.has(k))) next.delete(k)
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

  // Gated on the market having resolved, so the page does not fetch `all`, paint it, and then
  // repaint the operator's real market a moment later.
  const canFetch = urlMarket != null || marketReady
  useEffect(() => {
    if (!canFetch) return
    let alive = true
    setLoading(true)
    const p = new URLSearchParams({ market })
    for (const [k, v] of Object.entries({
      line: scope.line, portfolio: scope.portfolio, campaign: scope.campaign, adGroup: scope.adGroup,
      q, minOrders: minOrders ?? '', minClicks: minClicks ?? '', maxAcos: maxAcos ?? '',
      matched: matched ?? '', minSpend: minSpend ?? '', window: windowParam ?? '',
    })) {
      if (v) p.set(k, v)
    }
    for (const [k, v] of Object.entries({ status, kind, dest })) {
      if (v && v !== 'all') p.set(k, v)
    }
    if (competing === '1') p.set('competing', '1')
    void fetch(`${getBackendUrl()}/api/advertising/keyword-harvest?${p.toString()}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Could not load the harvest candidates (${r.status})`)
        return r.json()
      })
      .then((d) => { if (alive) { setData(d as Payload); setErr(null) } })
      .catch((e) => { if (alive) { setErr((e as Error).message); setData(null) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [canFetch, market, scope.line, scope.portfolio, scope.campaign, scope.adGroup, q, status, kind, dest, competing, minOrders, minClicks, maxAcos, matched, minSpend, windowParam, reloadTick])

  const rows = data?.rows ?? []
  const census = data?.census ?? null
  const s = data?.scope

  // FB.2 — the four grains, as filters in the merged bar. The ad-group options are the SERVER's:
  // ad groups holding at least one search term inside the resolved scope, with their counts. An
  // empty list still renders the control, disabled, because that is a real answer about this scope.
  const scopeFilters = useMemo(
    () => buildScopeFilters({
      options, market, value: scope,
      boundBy: s?.boundBy && s.boundBy !== 'market' ? (s.boundBy as 'adGroup' | 'campaign' | 'portfolio' | 'line') : null,
      adGroupOptions: (s?.adGroupOptions ?? []).map((g) => ({
        value: g.id, label: `${g.name} · ${g.terms} term${g.terms === 1 ? '' : 's'}`,
      })),
    }),
    [options, market, scope.line, scope.portfolio, scope.campaign, scope.adGroup, s?.boundBy, s?.adGroupOptions],
  )
  const urlValues = useMemo(
    () => scopeToFilterState(scope),
    [scope.line, scope.portfolio, scope.campaign, scope.adGroup],
  )
  const onScopeUrlChange = useCallback((next: Record<string, string>) => {
    push({
      line: next.__line ?? '', portfolio: next.__portfolio ?? '',
      campaign: next.__campaign ?? '', adGroup: next.__adGroup ?? '',
    })
  }, [push])
  const { filterState, setFilterState } = useMergedFilters({ urlValues, onUrlChange: onScopeUrlChange })

  const slotProps: HvSlotProps = {
    // HV.6 reads its own two params off the URL here rather than reaching for `params` itself, so
    // the slot contract stays the only thing a section depends on.
    scope: { market, ...scope, boundBy: s?.boundBy ?? null, actors: params.get('actors') === '1', actor: params.get('actor') },
    census,
    rows,
    criteria: data?.criteria ?? null,
    attrition: data?.attrition ?? null,
    minSpendEur: data?.thresholds.minSpendEur ?? 15,
    freshness: data?.freshness ?? null,
    loading,
    push,
    row,
    confirm,
    reload: () => setReloadTick((n) => n + 1),
  }

  const copyLink = useCallback(() => {
    const next = new URLSearchParams(params.toString())
    // Write the resolved market in explicitly. Without this, a link shared while `?market=` was
    // absent renders whatever market the OPENER last worked in — a different page under one URL.
    next.set('market', market)
    // 🔴 HV.2 — and the resolved CRITERIA, for the same reason and a sharper one: an absent
    // `?minOrders=` means "whatever policy is in force", and the policy can be edited by someone
    // else between sending the link and opening it. A shared link has to be a snapshot of what the
    // sender was looking at, not a query that re-resolves.
    if (data) {
      const c = data.criteria.inForce
      next.set('minOrders', String(c.minOrders))
      next.set('minClicks', String(c.minClicks))
      next.set('maxAcos', c.maxAcosPct == null ? 'none' : String(c.maxAcosPct))
      next.set('window', String(c.windowDays))
      next.set('matched', c.excludeExactMatched ? 'harvestable' : 'all')
      if (dest !== 'all') next.set('dest', dest)
      if (competing === '1') next.set('competing', '1')
    }
    const url = `${window.location.origin}${window.location.pathname}?${next.toString()}`
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    }).catch(() => { /* clipboard denied — the URL bar still carries every filter */ })
  }, [params, market, data, dest, competing])

  const onExport = useCallback(() => {
    // The retiring console offers CSV on this exact data and this tab did not.
    const head = ['Search term', 'Market', 'Kind', 'Campaign', 'Targeting', 'Ad group', 'Impressions', 'Clicks', 'Spend EUR', 'Orders', 'Sales EUR', 'ACoS %', 'Observed CPC EUR', 'Matched via', 'Status', 'Existing rows', 'Existing at Amazon', 'Negated rows', 'Negated blocking']
    const cell = (v: unknown) => {
      const t = v == null ? '' : String(v)
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
    }
    const lines = [head.join(',')].concat(rows.map((r) => [
      r.term, r.market, r.kind, r.campaign.name, r.campaign.targetingType ?? '', r.adGroup.name,
      r.metrics.impressions, r.metrics.clicks, (r.metrics.spendCents / 100).toFixed(2), r.metrics.orders,
      (r.metrics.salesCents / 100).toFixed(2),
      // 🔴 An empty cell, not a 0, for the same reason the grid renders a dash: a spreadsheet
      // that reads 0 where nothing was measured is the bug leaving the building in a new format.
      r.metrics.acosPct == null ? '' : r.metrics.acosPct.toFixed(1),
      r.metrics.cpcCents == null ? '' : (r.metrics.cpcCents / 100).toFixed(2),
      r.matchedVia.map((m) => `${m.matchType}=${m.orders}`).join(' '),
      r.status, r.existing?.rows ?? '', r.existing?.atAmazon ?? '', r.negatedIn.rows, r.negatedIn.blocking,
    ].map(cell).join(',')))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `keyword-harvest-${market}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [rows, market])

  // ── the candidate columns ────────────────────────────────────────────────────────────────────
  const columns: GridColumn<HarvestRow>[] = useMemo(() => [
    {
      key: 'market', label: 'Market', metric: false,
      render: (r) => <span className="h10-hv-mkt">{r.market}</span>,
      sortValue: (r) => r.market,
    },
    {
      key: 'source', label: 'Source', metric: false,
      tip: 'The campaign and ad group the traffic actually came from. AUTO campaigns are where discovery happens — and they are the ones the rule path cannot see.',
      render: (r) => (
        <span className="h10-hv-src">
          <span className="ag" title={r.adGroup.name}>{r.adGroup.name}</span>
          <i title={r.campaign.name}>
            {r.campaign.name}
            {r.campaign.targetingType && <b className={`tt ${r.campaign.targetingType.toLowerCase()}`}>{r.campaign.targetingType.toLowerCase()}</b>}
          </i>
        </span>
      ),
      sortValue: (r) => `${r.campaign.name} ${r.adGroup.name}`,
    },
    {
      key: 'destination', label: 'Destination', metric: false,
      tip: 'Where the keyword would be created, and how that was decided. 🔴 It also decides whether the source gets a negative: applyHarvest adds the isolation negative ONLY when the keyword lands in a different ad group. Click a row to choose.',
      render: (r) => {
        const d = r.destination
        if (!d) return <span className="h10-hv-nd" title="this row has no local ad group">—</span>
        if (d.chosen) {
          return (
            <button type="button" className="h10-hv-destbtn" onClick={() => push({ row: r.termKey })} title={`${d.source === 'stored' ? 'Stored for this scope' : 'The only ad group that matches'} · ${d.chosen.why}`}>
              <DestName c={d.chosen} />
              <i className={`src ${d.source}`}>{d.source === 'stored' ? 'chosen' : 'one match'}</i>
            </button>
          )
        }
        if (d.source === 'none') {
          return <span className="h10-hv-destnone" title={DEST_STATUS_TIP['no-destination']}>nowhere to put it</span>
        }
        return (
          <button type="button" className="h10-hv-destbtn amb" onClick={() => push({ row: r.termKey })} title={`${d.shortlist.length} ad groups could hold this keyword and none is obviously right. Click to choose one.`}>
            <span className="pickme">{d.shortlist.length} possible — choose</span>
          </button>
        )
      },
      sortValue: (r) => `${r.destination?.source ?? 'zz'}|${r.destination?.chosen?.adGroupName ?? ''}`,
    },
    {
      key: 'negateSrc', label: 'Negates source', metric: false,
      tip: '🔴 The coupling that made this page necessary. applyHarvest fires the isolation negative only when the keyword lands elsewhere, so "promoted into the source" and "did not negate the source" are ONE defect. Hover for the sentence.',
      render: (r) => {
        const d = r.destination
        if (!d) return <span className="h10-hv-nd">—</span>
        return (
          <span className={`h10-hv-neg2 ${d.wouldNegateAtSource ? 'yes' : 'no'}`} title={d.negateReason}>
            {d.wouldNegateAtSource ? 'yes' : 'no'}
          </span>
        )
      },
      sortValue: (r) => (r.destination?.wouldNegateAtSource ? 1 : 0),
    },
    { key: 'impressions', label: 'Impressions', render: (r) => num(r.metrics.impressions), sortValue: (r) => r.metrics.impressions, filterValue: (r) => r.metrics.impressions },
    { key: 'clicks', label: 'Clicks', render: (r) => num(r.metrics.clicks), sortValue: (r) => r.metrics.clicks, filterValue: (r) => r.metrics.clicks },
    { key: 'spend', label: 'Spend', render: (r) => eur(r.metrics.spendCents), sortValue: (r) => r.metrics.spendCents, filterValue: (r) => r.metrics.spendCents },
    { key: 'orders', label: 'Orders', render: (r) => num(r.metrics.orders), sortValue: (r) => r.metrics.orders, filterValue: (r) => r.metrics.orders },
    { key: 'sales', label: 'Sales', render: (r) => eur(r.metrics.salesCents), sortValue: (r) => r.metrics.salesCents, filterValue: (r) => r.metrics.salesCents },
    {
      key: 'acos', label: 'ACoS',
      tip: 'Spend ÷ attributed sales over the window. A dash means no attributed sales to divide by — which is not the same as 0%.',
      render: (r) => (r.metrics.acosPct == null
        ? <span className="h10-hv-nd" title="not measured — no attributed sales in this window">—</span>
        : <span>{r.metrics.acosPct.toFixed(0)}%</span>),
      // A null sorts below every real value rather than as a zero, which would rank
      // "not measured" as the best ACoS on the page.
      sortValue: (r) => (r.metrics.acosPct == null ? Number.NEGATIVE_INFINITY : r.metrics.acosPct),
      filterValue: (r) => r.metrics.acosPct ?? 0,
    },
    {
      key: 'cpc', label: 'Observed CPC',
      tip: 'Spend ÷ clicks: the bid this term has already earned. The account median is €0.46, so the €0.50–€0.75 constants the rule path passes overpay on 60–93% of candidates. A dash means it has never been clicked.',
      render: (r) => (r.metrics.cpcCents == null
        ? <span className="h10-hv-nd" title="not measured — no clicks in this window">—</span>
        : <span>{eur(r.metrics.cpcCents)}</span>),
      sortValue: (r) => (r.metrics.cpcCents == null ? Number.NEGATIVE_INFINITY : r.metrics.cpcCents),
      filterValue: (r) => r.metrics.cpcCents ?? 0,
    },
    {
      key: 'matched', label: 'Matched via', metric: false,
      tip: 'Which match types produced this term\'s orders. The harvest read has no match-type filter, so a term that matched an EXACT keyword is offered as a candidate to create that same keyword — this column is how you tell that apart from a real PHRASE, BROAD or auto discovery.',
      render: (r) => (
        <span className={`h10-hv-mv ${r.exactMatchedOnly ? 'taut' : ''}`}>
          {r.matchedVia.length === 0
            ? <i title="no order was attributed to a match type in this window">not attributed</i>
            : r.matchedVia.map((m) => (
              <b key={m.matchType} className={m.matchType === 'EXACT' ? 'ex' : m.matchType.startsWith('TARGETING_EXPRESSION') ? 'au' : ''} title={`${m.orders} order${m.orders === 1 ? '' : 's'} from a ${m.matchType} match`}>
                {m.matchType === 'TARGETING_EXPRESSION_PREDEFINED' ? 'auto' : m.matchType === 'TARGETING_EXPRESSION' ? 'product' : m.matchType.toLowerCase()}
              </b>
            ))}
        </span>
      ),
      sortValue: (r) => r.matchedVia.map((m) => m.matchType).join(','),
    },
    {
      key: 'status', label: 'Status', metric: false,
      tip: 'Does this keyword already exist? Four states, and "local only" is the one that matters: a row that exists here and never reached Amazon.',
      render: (r) => (
        <span className={`h10-hv-st ${r.status}`} title={STATUS_TIP[r.status]}>
          {STATUS_LABEL[r.status]}
          {r.existing && r.status !== 'new' && (
            <i>{r.existing.rows} row{r.existing.rows === 1 ? '' : 's'}{r.status === 'local-only' ? ', none at Amazon' : `, ${r.existing.atAmazon} at Amazon`}</i>
          )}
        </span>
      ),
      sortValue: (r) => r.status,
    },
    {
      key: 'destStatus', label: 'At destination', metric: false,
      tip: 'The same question asked of the DESTINATION rather than the source. HV.1\'s Status says whether the keyword exists where the traffic came from — a fact about the account. This says whether promoting would create anything — a fact about a decision, and undecidable until a destination is chosen.',
      render: (r) => {
        const d = r.destination
        if (!d) return <span className="h10-hv-nd">—</span>
        return <span className={`h10-hv-dst ${d.status}`} title={DEST_STATUS_TIP[d.status]}>{DEST_STATUS_LABEL[d.status]}</span>
      },
      sortValue: (r) => String(r.destination?.status ?? ''),
    },
    {
      key: 'negated', label: 'Blocked',
      tip: 'How many negatives already block this term, account-wide, and how many of those are live (target enabled, campaign enabled, confirmed at Amazon). Refusing to propose a blocked term is HV.4; this only states the fact.',
      render: (r) => (r.negatedIn.rows === 0
        ? <span className="h10-hv-nd" title="not negated anywhere in the account — a real zero">—</span>
        : (
          <span className={`h10-hv-neg ${r.negatedIn.blocking > 0 ? 'on' : ''}`} title={`${r.negatedIn.rows} negative rows · ${r.negatedIn.blocking} of them live · ${r.negatedIn.campaignLevel} campaign-wide`}>
            {num(r.negatedIn.rows)}<i>{r.negatedIn.blocking} live</i>
          </span>
        )),
      sortValue: (r) => r.negatedIn.rows,
      filterValue: (r) => r.negatedIn.rows,
    },
    {
      key: 'kind', label: 'Kind', metric: false,
      tip: 'A search term that is an ASIN is a product-targeting match, not a keyword — applyHarvest routes it to a product target (H.5). The engine skips these entirely today.',
      render: (r) => <span className={`h10-hv-kind ${r.kind}`}>{r.kind === 'product' ? 'product target' : 'keyword'}</span>,
      sortValue: (r) => r.kind,
    },
  ], [])

  const activeTab = rulesTabByKey('keyword-harvest')

  /** The one sentence stating what resolved. */
  const resolution = (() => {
    if (!s) return null
    const bits: string[] = [s.market === 'all' ? 'All markets' : s.market]
    if (s.boundBy === 'adGroup' && s.adGroup) bits.push(`ad group “${s.adGroup.name}”`)
    else if (s.boundBy === 'campaign' && s.campaign) bits.push(`campaign “${s.campaign.name}”`)
    else if (s.boundBy === 'portfolio' && s.portfolio) bits.push(`portfolio “${s.portfolio.name}”`)
    else if (s.boundBy === 'line' && s.line) bits.push(`${s.line.name.split(' — ')[0]} line`)
    else bits.push('all campaigns')
    // 🔴 Two numbers, and the second is the honest one: most campaigns have no search-term data at
    // all in this window. A scope claiming "220 campaigns" over a grid built from 64 is the
    // denominator bug this section has already shipped twice (§11 C5).
    bits.push(`${num(s.resolved.campaignsWithTerms)} of ${num(s.resolved.campaigns)} campaigns have search-term data in the last ${data?.window.days}d`)
    return bits.join(' · ')
  })()

  /**
   * The census strip. Every cell is a filter, and **every cell's `apply` reproduces that cell's own
   * number** — each one sends a single `status=` that the server counts with the same predicate.
   * A cell whose number and whose filter disagree is worse than no cell: it teaches the operator
   * that the strip is approximate. (NEG.1 shipped two of those and found both by clicking on prod.)
   */
  const strip: Array<{ key: string; n: number; label: string; tip: string; on: boolean; apply: () => void; tone?: string }> = census ? [
    {
      key: 'all', n: census.candidates, label: census.candidates === 1 ? 'candidate' : 'candidates',
      tip: `Search terms meeting every criterion above, in this scope. Click to clear the status and kind filters.`,
      on: status === 'all' && kind === 'all',
      apply: () => push({ status: 'all', kind: 'all' }),
    },
    {
      key: 'new', n: census.new, label: 'new',
      tip: STATUS_TIP.new,
      on: status === 'new', apply: () => push({ status: 'new', kind: 'all' }), tone: 'live',
    },
    {
      key: 'already-exact-here', n: census.alreadyExactHere, label: 'already exact here',
      tip: STATUS_TIP['already-exact-here'],
      on: status === 'already-exact-here', apply: () => push({ status: 'already-exact-here', kind: 'all' }), tone: 'muted',
    },
    {
      key: 'exact-elsewhere', n: census.exactElsewhere, label: 'exact elsewhere',
      tip: STATUS_TIP['exact-elsewhere'],
      on: status === 'exact-elsewhere', apply: () => push({ status: 'exact-elsewhere', kind: 'all' }),
    },
    {
      key: 'local-only', n: census.localOnly, label: 'never reached Amazon',
      tip: STATUS_TIP['local-only'],
      on: status === 'local-only', apply: () => push({ status: 'local-only', kind: 'all' }), tone: 'warn',
    },
  ] : []

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Keyword Harvest"
        subtitle={activeTab?.subtitle ?? 'Which search terms have earned their own keyword'}
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => push({ market: m, campaign: '', adGroup: '' })}
        showLearn={false}
        showDataSync={false}
        /* No date range. The window is a harvest parameter (30/60/90), not a report range, and it
           belongs to the threshold controls in HV.2 — two controls for one fact is what sank the
           reverted scope bar. Until then the window is stated in the sentence and carried by the
           URL. */
        showDateRange={false}
      />

      <RulesTabs active="keyword-harvest" />

      {/* FB.2 — ONE bar: controls, then the numbers they produce, then the rows. */}
      <AdsFilterBar filters={scopeFilters} value={filterState} onChange={setFilterState} defaultOpen />

      {/* 🔴 HV.2 sits HERE, not in the slot list below the grid where its stub lived.
          Measured on prod: rendered in stub order it landed at y=1301 with the census it governs
          at y=523 — the control that changes the count, 700px below the count. The seven-slot
          ordering was written for sections that REPORT; this one is the only one that CONTROLS,
          so it belongs above the thing it controls. Everything else about the seam is unchanged:
          same typed props, same file, one import line. */}
      {/* Two questions, one page: which terms have earned a keyword, and did the last batch work.
          A segmented control rather than a tab, because the scope, market and header above it apply
          to both — a tab would imply a different page. */}
      <div className="h10-hv-viewseg" role="tablist" aria-label="View">
        {([['candidates', 'Candidates'], ['harvested', 'Harvested']] as const).map(([v, label]) => (
          <button
            key={v} type="button" role="tab" aria-selected={view === v}
            className={`seg ${view === v ? 'on' : ''}`}
            onClick={() => push({ view: v === 'candidates' ? '' : v })}
            title={v === 'candidates'
              ? 'Search terms that have earned their own keyword'
              : 'What happened to every keyword this account harvested'}
          >{label}</button>
        ))}
      </div>

      {view === 'candidates' && <HvThresholds {...slotProps} />}

      {view === 'candidates' && resolution && <p className="h10-hv-said"><b>{resolution}</b></p>}

      {err && <p className="h10-hv-blind"><AlertTriangle size={13} /><span>{err}</span></p>}

      {/* ── The census sentence. Every value computed; none hard-coded. ─────────────────────── */}
      {view === 'candidates' && census && data && (
        <div className="h10-hv-lede">
          <p>
            <b>
              {num(census.candidates)} candidate{census.candidates === 1 ? '' : 's'} meet the criteria
              ({data.criteria.inForce.minOrders}+ order{data.criteria.inForce.minOrders === 1 ? '' : 's'}
              {data.criteria.inForce.minClicks > 0 && <>, {data.criteria.inForce.minClicks}+ clicks</>}
              {data.criteria.inForce.maxAcosPct != null && <>, ACoS ≤ {data.criteria.inForce.maxAcosPct}%</>}
              , {data.criteria.inForce.windowDays} days)
            </b>
            {census.byKind.product > 0 && <> — {num(census.byKind.keyword)} search term{census.byKind.keyword === 1 ? '' : 's'} and {num(census.byKind.product)} product target{census.byKind.product === 1 ? '' : 's'}</>}.{' '}
            {census.newByKind.keyword === 0 && census.byKind.keyword > 0 ? (
              <>
                <b>None of the {num(census.byKind.keyword)} search terms {census.byKind.keyword === 1 ? 'is' : 'are'} new</b> — every one already has an
                exact keyword where it came from{census.localOnly > 0 && <>, though {num(census.localOnly)} of those {census.localOnly === 1 ? 'keyword has' : 'keywords have'} never reached Amazon</>}.
              </>
            ) : (
              <><b>{num(census.new)} {census.new === 1 ? 'is' : 'are'} new.</b></>
            )}
          </p>

          {/* 🔴 The tautology, stated rather than buried. Without this the count above reads as a
              finding about the account when for some rows it is the definition of the input. */}
          {/* 🔴 This sentence has to know whether the criterion is on. With `excludeExactMatched`
              active those rows are NOT in `candidates` at all, so quoting them as a fraction of it
              would describe rows the grid is not showing. */}
          {data.criteria.inForce.excludeExactMatched ? (
            <p className="sub">
              <Info size={12} />
              <span>
                Terms whose <b>every</b> order came from an EXACT match are excluded: the harvest read has no match-type
                filter, so those rows offer to create the very keyword that produced the traffic. Everything below arrived
                through phrase, broad or auto targeting — a looser match than the one it would create.{' '}
                <button type="button" className="lnk" onClick={() => push({ matched: 'all' })}>Show them anyway</button>
              </span>
            </p>
          ) : census.exactMatchedOnly > 0 && (
            <p className="sub">
              <Info size={12} />
              <span>
                {num(census.exactMatchedOnly)} of {num(census.candidates)} got <b>every</b> order from an EXACT match — those rows
                are offering to create the very keyword that produced the traffic.{' '}
                <button type="button" className="lnk" onClick={() => push({ matched: 'harvestable' })}>Exclude them</button>
              </span>
            </p>
          )}

          {census.atOneOrder.withoutKeywordInSource > 0 && (
            <p className="sub">
              <span>
                At <button type="button" className="lnk" onClick={() => push({ minOrders: '1' })}>1+ order</button>,{' '}
                <b>{num(census.atOneOrder.withoutKeywordInSource)} of {num(census.atOneOrder.candidates)}</b> terms have no exact keyword in the ad group
                they came from — {eur(census.atOneOrder.spendCents)} spent
                {census.atOneOrder.acosPct != null && <>, {census.atOneOrder.acosPct.toFixed(0)}% blended ACoS</>}.
                {census.atOneOrder.noExactMatch > 0 && <> {num(census.atOneOrder.noExactMatch)} of them never matched an exact keyword at all.</>}
              </span>
            </p>
          )}

          {/* ⚠️ The attribution caveat, carried as measured numbers rather than restated analysis. */}
          {census.atOneOrder.repeatedValues.length > 0 && (
            <p className="caveat">
              <AlertTriangle size={12} />
              <span>
                {num(census.atOneOrder.singleOrder)} of those {num(census.atOneOrder.withoutKeywordInSource)} are <b>single-order attributions</b>, and the
                sale values repeat — {census.atOneOrder.repeatedValues.slice(0, 3).map((v) => `${eur(v.salesCents)} across ${v.terms} terms`).join(', ')}.
                That is one product at one price converting once per term: <b>evidence of intent, not a bankable {eur(census.atOneOrder.salesCents)}</b>.
              </span>
            </p>
          )}

          <p className="sub">
            <span>
              {/* Computed, never stated as a constant: the study said "1 day old" and it was two the
                  next morning, because ads-v1-export-ingest has landed nothing since. */}
              Search-term data through <b>{data.freshness.newestTermDate ? dayMonth(data.freshness.newestTermDate) : 'unknown'}</b>
              {data.freshness.ageDays != null && <> ({data.freshness.ageDays === 0 ? 'today' : `${data.freshness.ageDays} day${data.freshness.ageDays === 1 ? '' : 's'} old`})</>}
              {' '}· {num(data.freshness.rows)} rows. The freshest signal in this section — Share of Voice and Keyword Tracker read SQP at 16+ days.
              {census.negativeCandidates.count > 0 && (
                <>
                  {' '}· {num(census.negativeCandidates.count)} wasteful term{census.negativeCandidates.count === 1 ? '' : 's'} ({eur(census.negativeCandidates.spendCents)})
                  {' '}{census.negativeCandidates.count === 1 ? 'is a negative candidate' : 'are negative candidates'} —{' '}
                  <a className="lnk" href="/marketing/ads/rules-automation/negative-targeting">those belong to Negative Targeting <ArrowUpRight size={11} /></a>
                </>
              )}
            </span>
          </p>
        </div>
      )}

      {view === 'candidates' && census && (
        <div className="h10-hv-census" role="group" aria-label="What is in this scope">
          {strip.map((c) => (
            <button
              key={c.key} type="button" title={c.tip}
              className={`h10-hv-cell ${c.tone ?? ''} ${c.on ? 'on' : ''}`}
              onClick={c.apply}
            >
              <b>{num(c.n)}</b>
              <span>{c.label}</span>
            </button>
          ))}
        </div>
      )}

      {view === 'candidates' && (
      <AdsDataGrid<HarvestRow>
        rows={rows}
        loading={loading}
        rowId={(r) => r.id}
        noun="Candidate"
        firstColLabel="Search term"
        renderFirst={(r) => (
          <div className="h10-hv-term">
            {/* The shared grid paints the first column blue at (0,3,1) because every other consumer
                makes it a link. This one is not a link — HV.3 gives it a detail panel — so the
                colour is overridden at matching specificity in the CSS rather than with
                !important, which would be harder to delete later. */}
            <span className="t" title={r.term}>{r.term}</span>
            {r.status === 'local-only' && <span className="fl warn" title="A keyword row exists here and never reached Amazon">never reached Amazon</span>}
            {r.negatedIn.blocking > 0 && <span className="fl neg" title={`${r.negatedIn.blocking} live negatives already block this term`}>blocked</span>}
          </div>
        )}
        firstSortValue={(r) => r.termKey}
        columns={columns}
        defaultSort={{ key: 'orders', dir: 'desc' }}
        /* 🔴 HV.4 — the grid becomes selectable, and this is the first control on the page that
           spends money. The action does not write: it queues the selection into the URL, so the
           confirm dialog it opens is a LINK someone can review before anyone acts (§4.11). */
        selectable
        selectionActions={promoteSelectionActions((queued) => {
          const next = new URLSearchParams(params.toString())
          next.delete('confirm')
          for (const id of queued) next.append('confirm', id)
          router.replace(`?${next.toString()}`, { scroll: false })
        })}
        /* HV.3 — a row opens its destination picker. This is NOT a write action: it patches the
           URL, so "look at this one" is a link. NO_WRITE_ACTIONS still supplies HV.4's row menu. */
        onRowClick={(r: HarvestRow) => push({ row: r.termKey })}
        searchable
        searchPlaceholder="Search term, campaign or ad group…"
        searchValue={(r) => `${r.term} ${r.campaign.name} ${r.adGroup.name}`}
        pagerCentered
        storageKey="nexus.hv.cols"
        exportable
        onExport={onExport}
        toolbarLeft={(
          <>
            <StaleBanner stale={hvRefresh.stale} subject="The search-term feed or a harvested keyword" onRefresh={() => setReloadTick((n) => n + 1)} />
            <button type="button" className="h10-hv-copy" onClick={copyLink} title="Copy a link to exactly this view, with the market written in explicitly">
              {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy link</>}
            </button>
          </>
        )}
        toolbarRight={data ? <span className="h10-hv-win">{num(data.total)} of {num(data.census.candidates)} in scope</span> : undefined}
        emptyNode={<EmptyState loading={loading} data={data} err={err} q={q} status={status} kind={kind} push={push} />}
        reportLabel={data?.freshness.newestTermDate ? `search terms through ${dayMonth(data.freshness.newestTermDate)}` : undefined}
      />
      )}

      {/* HV.5 — the second view. One file, one import line, as the contract promised. */}
      <HvCohort {...slotProps} />

      {/* ── The sections that follow the grid. Every one still renders null today. ──────────── */}
      <HvDestination {...slotProps} />
      <HvPromote {...slotProps} />

      <HvActors {...slotProps} />
      {/* HV close-out — the interim RuleListTab retired onto the shared TabRules (BID.S7's
          shape): the badge and this section share ruleBelongsToTab, the record lives on
          Automations, and creation stays one click into the builder. */}
      <TabRules
        tabKey="keyword-harvest"
        sectionId="hv-rules"
        heading="who may graduate a search term"
        subject="harvest besides the engine"
        builderHref="/marketing/ads/rules-automation/builder/keyword-harvesting"
        builderLabel="Harvest Rule"
        emptyLine="No rule is allowed to graduate search terms — the engine (disarmed) and the operator are the whole story until one is created."
      />

      <HvQueue {...slotProps} />
      <HvRepairs {...slotProps} />
    </div>
  )
}

/**
 * An empty grid has four quite different causes here, and saying which one is the whole job.
 * Doctrine D4: **"never ran" and "nothing to do" must never render the same.**
 */
function EmptyState({
  loading, data, err, q, status, kind, push,
}: {
  loading: boolean
  data: Payload | null
  err: string | null
  q: string
  status: string
  kind: string
  push: (p: Record<string, string>) => void
}) {
  // 1 · could not load — the read failed, and the message above says why.
  if (loading) return <span className="h10-hv-empty"><b>Loading…</b></span>
  if (err || !data) {
    return (
      <span className="h10-hv-empty">
        <b>Nothing loaded.</b>
        <span>The read failed, so this grid is not telling you there are no candidates — it is telling you it does not know.</span>
      </span>
    )
  }
  // 2 · not measured — no search-term data reaches this scope at all.
  if (data.scope.resolved.campaignsWithTerms === 0) {
    return (
      <span className="h10-hv-empty">
        <b>No search-term data in this scope.</b>
        <span>
          {num(data.scope.resolved.campaigns)} campaign{data.scope.resolved.campaigns === 1 ? '' : 's'} resolved and none of them has a
          search term in the last {data.window.days} days. That is <b>not measured</b>, not “nothing to harvest”.
        </span>
      </span>
    )
  }
  // 3 · nothing to do — data exists, no term cleared the bar. This is the honest zero, and the
  //     threshold is the reason, so the state names it and offers the next value down.
  if (data.census.candidates === 0) {
    return (
      <span className="h10-hv-empty">
        <b>Nothing in this scope meets all five criteria.</b>
        <span>
          {num(data.scope.resolved.campaignsWithTerms)} campaigns have search-term data here, and{' '}
          {num(data.attrition.base)} {data.attrition.base === 1 ? 'term' : 'terms'} converted at least once — every one was
          removed by a criterion.{' '}
          {/* 🔴 Name the criterion that did the most damage, and offer to relax THAT one. A generic
              "try widening your filters" makes the operator guess which of five to touch. */}
          {(() => {
            const worst = [...data.attrition.steps].sort((a, b) => b.removed - a.removed)[0]
            if (!worst || worst.removed === 0) return null
            return <><b>“{worst.label}”</b> removed the most ({num(worst.removed)}).</>
          })()}
          {data.criteria.inForce.minOrders > 1 && (
            <> Try <button type="button" className="lnk" onClick={() => push({ minOrders: String(data.criteria.inForce.minOrders - 1) })}>{data.criteria.inForce.minOrders - 1}+ order{data.criteria.inForce.minOrders - 1 === 1 ? '' : 's'}</button>.</>
          )}
        </span>
      </span>
    )
  }
  // 4 · filtered out — candidates exist and the filters hide all of them.
  return (
    <span className="h10-hv-empty">
      <b>{num(data.census.candidates)} candidates are in this scope — the filters hide all of them.</b>
      <span>
        {q ? <>Nothing matches “{q}”. </> : null}
        {status !== 'all' ? <>Status is filtered to “{STATUS_LABEL[status as HvStatus] ?? status}”. </> : null}
        {kind !== 'all' ? <>Kind is filtered to “{kind}”. </> : null}
        <button type="button" className="lnk" onClick={() => push({ q: '', status: 'all', kind: 'all' })}>Clear the filters</button>
      </span>
    </span>
  )
}
