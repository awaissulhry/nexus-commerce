'use client'

/**
 * NEG.1 — Negative Targeting, its own page.
 *
 * Two questions: **what am I blocking, and what is it costing me?** NEG.1 answers the first, over
 * the whole account, which nothing in this product has ever done — 2,059 negatives exist, and the
 * only screens that list one are two per-campaign grids you can reach solely by already knowing
 * which campaign to open.
 *
 * It is read-only on the ads data. It creates no negative and retires none.
 *
 * Four laws this page follows, each one a mistake already made in this codebase:
 *
 *   1. **"Blocking now" is an intersection, not a status.** Target ENABLED *and* campaign ENABLED
 *      *and* confirmed at Amazon. 942 of 2,059 — the study's 1,045 is only the third condition,
 *      and 42 rows Amazon has never heard of block nothing whatever our database says.
 *   2. **The match type is normalised at read time and never filtered on raw.** The stored column
 *      is being rewritten by an ingest; it moved by ~700 rows in ten minutes on 2026-08-12. Both
 *      the normalised value and the raw spelling are on screen, so the churn is visible rather
 *      than laundered.
 *   3. **Attribution has four values and never a blank.** "No record at all" and "a record with no
 *      actor" are different facts; 1,225 rows are the first and 198 are the second.
 *   4. **A term is a view, never an Amazon object.** Amazon has no account-level negative list. The
 *      terms view groups; it carries no write action, here or in any later section.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, Info, Plus } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { getBackendUrl } from '@/lib/backend-url'
import { NegativeScopeBar, type NegScope, type ScopeOptionsPayload } from './NegativeScopeBar'
import {
  NO_WRITE_ACTIONS,
  type NegationRow, type TermRow, type NegCensus, type NegSlotProps, type NegGrain, type NegMatchType,
} from './slot-contract'
// The seven sections that follow. Each renders null until its session lands; each takes the same
// typed props, so a later section is one file and one import line. Nobody restructures this client.
import { NegTermDrawer } from './NegTermDrawer'
import { NegRemoval } from './NegRemoval'
import { NegAttention } from './NegAttention'
import { NegProtectedTerms } from './NegProtectedTerms'
import { NegWastefulWords } from './NegWastefulWords'
import { NegRules } from './NegRules'
import { NegRecord } from './NegRecord'
// Interim, until NEG.5 and NEG.7 replace them: rendered exactly as the tab rendered them, so
// nothing is lost in the move off `?tab=negative-targeting`.
import { ProtectedTermsPanel } from '../ProtectedTermsPanel'
import { RuleListTab } from '../tabs/RuleListTab'
import { NoDataIllus } from '../_shared/NoDataIllus'

/** The four production Amazon Ads markets, plus the account-wide view the header already offers. */
const MARKETS = ['IT', 'DE', 'ES', 'FR']
const DEFAULT_MARKET = 'all'

interface Payload {
  scope: {
    market: string
    boundBy: NegGrain
    line: { id: string; name: string } | null
    portfolio: { id: string; name: string } | null
    campaign: { id: string; name: string } | null
    adGroup: { id: string; name: string } | null
    resolved: { campaigns: number; adGroups: number }
    unreachable: { campaignsWithoutPortfolio: number; campaignsInMarket: number; negativesWithoutPortfolio: number; negativesTotal: number } | null
    adGroupOptions: Array<{ id: string; name: string; negatives: number }>
  }
  view: 'negations' | 'terms'
  window: { days: number; since: string }
  census: NegCensus
  facets: {
    match: Array<{ value: NegMatchType; count: number }>
    level: Array<{ value: 'AD_GROUP' | 'CAMPAIGN'; count: number }>
    state: Array<{ value: string; count: number }>
    amazon: Array<{ value: 'yes' | 'no'; count: number }>
    attribution: Array<{ value: NegationRow['attribution']; count: number }>
    rawTypes: Array<{ value: string; count: number }>
  }
  rows: NegationRow[] | TermRow[]
  total: number
  truncated: boolean
  freshness: { newestAddedAt: string | null; oldestAddedAt: string | null; newestSyncedAt: string | null }
}

const num = (n: number) => n.toLocaleString('en-IE')
const dayMonth = (iso: string) => {
  const d = new Date(iso)
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}
const MATCH_LABEL: Record<NegMatchType, string> = { EXACT: 'Exact', PHRASE: 'Phrase', ASIN: 'ASIN', OTHER: 'Unrecognised' }

export function NegativeTargetingClient() {
  const router = useRouter()
  const params = useSearchParams()

  // Every view is linkable, and an absent param means the default — never a stored preference, so
  // a link renders the same view for whoever opens it. `focus` and `alert` are in the contract from
  // day one even though NEG.2 and NEG.4 are the sections that read them: they are what make
  // "look at this" a link rather than a description of where to click.
  const market = params.get('market') ?? DEFAULT_MARKET
  const scope: NegScope = {
    line: params.get('line') ?? '',
    portfolio: params.get('portfolio') ?? '',
    campaign: params.get('campaign') ?? '',
    adGroup: params.get('adGroup') ?? '',
  }
  const view = params.get('view') === 'terms' ? 'terms' : 'negations'
  const match = (params.get('match') ?? 'all') as NegMatchType | 'all'
  const level = (params.get('level') ?? 'all') as 'AD_GROUP' | 'CAMPAIGN' | 'all'
  const state = (params.get('state') ?? 'all') as 'live' | 'paused' | 'archived' | 'all'
  const amazon = (params.get('amazon') ?? 'all') as 'yes' | 'no' | 'all'
  const attribution = (params.get('attribution') ?? 'all') as NegationRow['attribution'] | 'all'
  const q = params.get('q') ?? ''
  const focus = params.get('focus')
  const alert = params.get('alert')

  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [options, setOptions] = useState<ScopeOptionsPayload | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  const push = useCallback((patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (!v || v === 'all' || (k === 'market' && v === DEFAULT_MARKET) || (k === 'view' && v === 'negations')) next.delete(k)
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
    const p = new URLSearchParams({ market, view })
    for (const [k, v] of Object.entries({ line: scope.line, portfolio: scope.portfolio, campaign: scope.campaign, adGroup: scope.adGroup, q })) {
      if (v) p.set(k, v)
    }
    for (const [k, v] of Object.entries({ match, level, state, amazon, attribution })) {
      if (v && v !== 'all') p.set(k, v)
    }
    void fetch(`${getBackendUrl()}/api/advertising/negatives?${p.toString()}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Could not load the negatives (${r.status})`)
        return r.json()
      })
      .then((d) => { if (alive) { setData(d as Payload); setErr(null) } })
      .catch((e) => { if (alive) { setErr((e as Error).message); setData(null) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [market, view, scope.line, scope.portfolio, scope.campaign, scope.adGroup, q, match, level, state, amazon, attribution, reloadTick])

  const rows = (data?.rows ?? []) as NegationRow[]
  const termRows = (data?.rows ?? []) as TermRow[]
  const census = data?.census ?? null

  const slotProps: NegSlotProps = {
    scope: { market, ...scope, boundBy: data?.scope.boundBy ?? null },
    census,
    rows: view === 'negations' ? rows : [],
    terms: view === 'terms' ? termRows : [],
    view,
    loading,
    push,
    focus,
    alert,
    reload: () => setReloadTick((n) => n + 1),
  }

  // ── the inventory columns ────────────────────────────────────────────────────────────────────
  const negColumns: GridColumn<NegationRow>[] = useMemo(() => [
    {
      key: 'match', label: 'Match type', metric: false,
      tip: 'Normalised at read time. The stored column holds six spellings of three concepts and an ingest rewrites it — hover the chip for what this row actually stores.',
      render: (r) => (
        <span className="h10-ng-mt" title={`stored as "${r.matchRaw}"`}>
          {MATCH_LABEL[r.match]}
          {r.match === 'OTHER' && <i>{r.matchRaw || 'empty'}</i>}
        </span>
      ),
      sortValue: (r) => r.match,
    },
    {
      key: 'scope', label: 'Scope', metric: false,
      tip: 'Campaign-wide blocks the term everywhere in that campaign; an ad-group negative funnels traffic to another ad group instead. The difference between blocked and routed.',
      render: (r) => (
        <span className="h10-ng-sc">
          {r.level === 'CAMPAIGN'
            ? <b className="camp">campaign-wide</b>
            : <span className="ag" title={r.adGroupName}>{r.adGroupName}</span>}
          <i title={r.campaignName}>{r.campaignName}</i>
        </span>
      ),
      sortValue: (r) => `${r.level}:${r.campaignName}`,
    },
    {
      key: 'market', label: 'Market', metric: false,
      render: (r) => <span className="h10-ng-mkt">{r.market}</span>,
      sortValue: (r) => r.market,
    },
    {
      key: 'state', label: 'Campaign state', metric: false,
      tip: '1,014 of 2,059 negatives sit in a paused or archived campaign. They are inert — they block nothing — and counting them as blocking is the mistake this column exists to prevent.',
      render: (r) => <span className={`h10-ng-st ${r.campaignStatus.toLowerCase()}`}>{r.campaignStatus.toLowerCase()}</span>,
      sortValue: (r) => r.campaignStatus,
    },
    {
      key: 'amazon', label: 'At Amazon', metric: false,
      tip: 'Whether Amazon ever confirmed this negative with an id. 42 rows say no — every campaign-scope negative this system has created is among them. They are counted by every screen and honoured by no auction.',
      render: (r) => (
        r.atAmazon
          ? <span className="h10-ng-am yes">confirmed</span>
          : <span className="h10-ng-am no" title="No externalTargetId — Amazon has never acknowledged this negative">never confirmed</span>
      ),
      sortValue: (r) => (r.atAmazon ? 1 : 0),
    },
    {
      key: 'blocking', label: 'Blocking', metric: false,
      tip: 'Target enabled AND campaign enabled AND confirmed at Amazon. All three, or it is not blocking anything right now.',
      render: (r) => (r.blockingNow ? <span className="h10-ng-bl on">blocking</span> : <span className="h10-ng-bl off">inert</span>),
      sortValue: (r) => (r.blockingNow ? 1 : 0),
    },
    {
      key: 'added', label: 'Added', metric: false,
      render: (r) => <span className="h10-ng-dt">{dayMonth(r.addedAt)}<i>{new Date(r.addedAt).getUTCFullYear()}</i></span>,
      sortValue: (r) => r.addedAt,
    },
    {
      key: 'by', label: 'By', metric: false,
      tip: 'Joined from the action log. "unattributed" means no log row exists (1,225 rows) — which is a different fact from a log row that recorded no actor (198 rows), and neither is a blank.',
      render: (r) => <span className={`h10-ng-by ${r.attribution}`}>{r.attributionLabel}</span>,
      sortValue: (r) => r.attributionLabel,
    },
    {
      key: 'spread', label: 'Also negated in',
      tip: 'How far this same term reaches inside the current scope. Removing one row of a term negated in 49 ad groups changes almost nothing — this is the number that says so before you act.',
      render: (r) => (
        <button type="button" className="h10-ng-spread" onClick={() => push({ view: 'terms', q: r.term })} title={`${r.spread.rows} rows · ${r.spread.adGroups} ad groups · ${r.spread.campaigns} campaigns`}>
          {num(r.spread.rows)}<i>{r.spread.adGroups} ag · {r.spread.campaigns} camp</i>
        </button>
      ),
      sortValue: (r) => r.spread.rows,
      filterValue: (r) => r.spread.rows,
    },
  ], [push])

  const termColumns: GridColumn<TermRow>[] = useMemo(() => [
    {
      key: 'rows', label: 'Negations',
      tip: 'One row per real AdTarget. A term is a Nexus-side grouping — Amazon has no account-level negative list, so acting on a term is always N separate writes.',
      render: (r) => num(r.rows), sortValue: (r) => r.rows, filterValue: (r) => r.rows,
    },
    { key: 'adGroups', label: 'Ad groups', render: (r) => num(r.adGroups), sortValue: (r) => r.adGroups, filterValue: (r) => r.adGroups },
    { key: 'campaigns', label: 'Campaigns', render: (r) => num(r.campaigns), sortValue: (r) => r.campaigns, filterValue: (r) => r.campaigns },
    {
      key: 'blocking', label: 'Blocking now',
      tip: 'How many of this term\'s negations pass all three conditions. A term negated 72 times can be blocking 20.',
      render: (r) => <span className={r.blockingNow > 0 ? 'h10-ng-bl on' : 'h10-ng-bl off'}>{num(r.blockingNow)}</span>,
      sortValue: (r) => r.blockingNow, filterValue: (r) => r.blockingNow,
    },
    {
      key: 'amazon', label: 'Never confirmed',
      render: (r) => (r.notAtAmazon > 0 ? <span className="h10-ng-am no">{num(r.notAtAmazon)}</span> : <span className="h10-ng-nd">—</span>),
      sortValue: (r) => r.notAtAmazon, filterValue: (r) => r.notAtAmazon,
    },
    {
      key: 'match', label: 'Match types', metric: false,
      render: (r) => <span className="h10-ng-mt">{r.matches.map((m) => MATCH_LABEL[m]).join(' · ')}</span>,
      sortValue: (r) => r.matches.join(','),
    },
    {
      key: 'market', label: 'Markets', metric: false,
      render: (r) => <span className="h10-ng-mkt">{r.markets.join(' ')}</span>,
      sortValue: (r) => r.markets.join(','),
    },
    {
      key: 'by', label: 'By', metric: false,
      render: (r) => <span className="h10-ng-by multi">{r.attributions.join(' · ')}</span>,
      sortValue: (r) => r.attributions.join(','),
    },
    {
      key: 'added', label: 'Added', metric: false,
      render: (r) => (
        r.firstAddedAt === r.lastAddedAt
          ? <span className="h10-ng-dt">{dayMonth(r.firstAddedAt)}</span>
          : <span className="h10-ng-dt">{dayMonth(r.firstAddedAt)}<i>→ {dayMonth(r.lastAddedAt)}</i></span>
      ),
      sortValue: (r) => r.lastAddedAt,
    },
  ], [])

  const activeTab = rulesTabByKey('negative-targeting')
  const s = data?.scope

  /** The one sentence stating what resolved. */
  const resolution = (() => {
    if (!s || !census) return null
    const bits: string[] = [s.market === 'all' ? 'All markets' : s.market]
    if (s.boundBy === 'adGroup' && s.adGroup) bits.push(`ad group “${s.adGroup.name}”`)
    else if (s.boundBy === 'campaign' && s.campaign) bits.push(`campaign “${s.campaign.name}”`)
    else if (s.boundBy === 'portfolio' && s.portfolio) bits.push(`portfolio “${s.portfolio.name}”`)
    else if (s.boundBy === 'line' && s.line) bits.push(`${s.line.name.split(' — ')[0]} line`)
    else bits.push('all campaigns')
    bits.push(`${num(s.resolved.campaigns)} campaign${s.resolved.campaigns === 1 ? '' : 's'}`)
    bits.push(`${num(s.resolved.adGroups)} ad group${s.resolved.adGroups === 1 ? '' : 's'} holding a negative`)
    return bits.join(' · ')
  })()

  /** The census strip. Each count is a filter, and each one is computed over the full filtered set
   *  in the route — never in this client from a page of rows. */
  const strip: Array<{ key: string; n: number; label: string; tip: string; on: boolean; apply: () => void; tone?: string }> = census ? [
    {
      key: 'negations', n: census.negations, label: census.negations === 1 ? 'negative' : 'negatives',
      tip: 'Every AdTarget row with isNegative = true in this scope.',
      on: match === 'all' && level === 'all' && state === 'all' && amazon === 'all' && attribution === 'all' && view === 'negations',
      apply: () => push({ view: 'negations', match: 'all', level: 'all', state: 'all', amazon: 'all', attribution: 'all' }),
    },
    {
      key: 'terms', n: census.terms, label: census.terms === 1 ? 'term' : 'terms',
      tip: 'Distinct terms, case-folded and whitespace-collapsed. A term is a view over negations, not an object Amazon holds.',
      on: view === 'terms', apply: () => push({ view: 'terms' }),
    },
    {
      key: 'blocking', n: census.blockingNow, label: 'blocking now',
      tip: 'Target enabled AND campaign enabled AND confirmed at Amazon. All three. This is the live number.',
      on: state === 'live' && amazon === 'yes', apply: () => push({ view: 'negations', state: 'live', amazon: 'yes' }), tone: 'on',
    },
    {
      key: 'inert', n: census.inInertCampaign, label: 'in a paused campaign',
      tip: 'Sitting in a campaign that is paused or archived. They block nothing, and a count that mixes them with live ones is not an answer to "what am I blocking".',
      on: state === 'paused', apply: () => push({ view: 'negations', state: 'paused', amazon: 'all' }), tone: 'muted',
    },
    {
      key: 'split', n: census.notAtAmazon, label: 'never confirmed at Amazon',
      tip: 'No externalTargetId. Amazon has never acknowledged these; they are counted by every screen and honoured by no auction.',
      on: amazon === 'no', apply: () => push({ view: 'negations', amazon: 'no', state: 'all' }), tone: 'warn',
    },
  ] : []

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Negative Targeting"
        subtitle={activeTab?.subtitle ?? 'What you are blocking, where, and who decided'}
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => push({ market: m, campaign: '', adGroup: '' })}
        showLearn={false}
        showDataSync={false}
        /* A negative has no date range. Every row states when it was added, and the two dated
           facts on this page — added, last synced — are per-row, not per-view. */
        showDateRange={false}
      />

      <RulesTabs active="negative-targeting" />

      <NegativeScopeBar
        options={options}
        market={market}
        scope={scope}
        boundBy={s?.boundBy ?? null}
        adGroupOptions={s?.adGroupOptions ?? []}
        onChange={(next) => push({ line: next.line, portfolio: next.portfolio, campaign: next.campaign, adGroup: next.adGroup })}
      />

      {resolution && (
        <p className="h10-ng-said">
          <b>{resolution}</b>
          {data?.freshness.newestAddedAt && <> · newest added {dayMonth(data.freshness.newestAddedAt)}</>}
          {census && census.addedInWindow > 0 && <> · {num(census.addedInWindow)} in the last {data?.window.days}d</>}
        </p>
      )}

      {/* 🔴 The portfolio grain has a hole in it, and a portfolio-scoped view must not look
          complete. Measured 2026-08-12: 1,310 of 2,059 negatives account-wide sit in campaigns
          carrying no portfolioId. */}
      {s?.unreachable && (
        <p className="h10-ng-blind">
          <AlertTriangle size={13} />
          <span>
            <b>This portfolio view cannot see {num(s.unreachable.negativesWithoutPortfolio)} of
            the {num(s.unreachable.negativesTotal)} negatives in this market.</b>{' '}
            They sit in {num(s.unreachable.campaignsWithoutPortfolio)} of {num(s.unreachable.campaignsInMarket)} campaigns
            that carry no portfolio id, so no portfolio-scoped view reaches them.
          </span>
        </p>
      )}

      {err && <p className="h10-ng-blind"><AlertTriangle size={13} /><span>{err}</span></p>}

      {census && (
        <div className="h10-ng-census" role="group" aria-label="What is in this scope">
          {strip.map((c) => (
            <button
              key={c.key} type="button" title={c.tip}
              className={`h10-ng-cell ${c.tone ?? ''} ${c.on ? 'on' : ''}`}
              onClick={c.apply}
            >
              <b>{num(c.n)}</b>
              <span>{c.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* 🔴 The raw column is rewritten by an ingest — measured moving ~700 rows in ten minutes on
          2026-08-12. Every filter and label on this page reads the NORMALISED value; this line
          shows what is actually stored underneath, so the next person to see the spellings move
          does not have to rediscover it. */}
      {data && data.facets.rawTypes.length > 1 && (
        <p className="h10-ng-note">
          <Info size={12} />
          <span>
            Match type is normalised for this page. Underneath, these rows store{' '}
            {data.facets.rawTypes.map((t) => `${t.value} ${num(t.count)}`).join(' · ')} — six spellings
            of three concepts, rewritten by the keyword-list sync. Nothing here filters on the raw value.
          </span>
        </p>
      )}

      {view === 'negations' ? (
        <AdsDataGrid<NegationRow>
          rows={rows}
          loading={loading}
          rowId={(r) => r.id}
          noun="Negative"
          firstColLabel="Term"
          renderFirst={(r) => (
            <div className="h10-ng-term">
              {/* The shared grid paints the first column blue at (0,3,1) because every other
                  consumer makes it a link. This one is not a link yet — NEG.2 makes it open the
                  term drawer — so the colour is overridden at matching specificity in the CSS. */}
              <span className="t" title={r.term}>{r.term}</span>
              {!r.atAmazon && <span className="fl warn" title="Amazon has never confirmed this negative">not at Amazon</span>}
              {r.level === 'CAMPAIGN' && <span className="fl camp" title="Campaign-wide: blocks the term everywhere in this campaign">campaign</span>}
            </div>
          )}
          firstSortValue={(r) => r.termKey}
          columns={negColumns}
          defaultSort={{ key: 'spread', dir: 'desc' }}
          selectable={false}
          /* NEG.3 supplies these. Declared in the contract on day one and passed as null here, so
             the removal and conflict sections ship without opening this file. */
          selectionActions={NO_WRITE_ACTIONS.selectionActions ?? undefined}
          onRowClick={NO_WRITE_ACTIONS.onRowAction ?? undefined}
          searchable
          searchPlaceholder="Search term, campaign or ad group…"
          searchValue={(r) => `${r.term} ${r.campaignName} ${r.adGroupName}`}
          pagerCentered
          storageKey="nexus.neg.cols"
          toolbarLeft={<ViewToggle view={view} push={push} />}
          toolbarRight={data ? <span className="h10-ng-win">{num(data.total)} of {num(data.census.negations)} in scope</span> : undefined}
          emptyNode={<EmptyState loading={loading} data={data} q={q} push={push} />}
          reportLabel={data?.freshness.newestSyncedAt ? `last synced from Amazon ${dayMonth(data.freshness.newestSyncedAt)}` : undefined}
        />
      ) : (
        <AdsDataGrid<TermRow>
          rows={termRows}
          loading={loading}
          rowId={(r) => r.termKey}
          noun="Term"
          firstColLabel="Term"
          renderFirst={(r) => (
            <div className="h10-ng-term">
              <span className="t" title={r.term}>{r.term}</span>
              {r.campaignLevel > 0 && <span className="fl camp" title={`${r.campaignLevel} of these are campaign-wide`}>{r.campaignLevel} campaign-wide</span>}
            </div>
          )}
          firstSortValue={(r) => r.termKey}
          columns={termColumns}
          defaultSort={{ key: 'rows', dir: 'desc' }}
          /* 🔴 A term row carries no write action, ever — not now and not in NEG.3. A term is not
             an Amazon object and cannot be archived; every bulk action is N writes with N
             outcomes, and selection here would promise otherwise. */
          selectable={false}
          searchable
          searchPlaceholder="Search terms…"
          searchValue={(r) => r.term}
          pagerCentered
          storageKey="nexus.neg.termcols"
          toolbarLeft={<ViewToggle view={view} push={push} />}
          toolbarRight={data ? <span className="h10-ng-win">{num(data.total)} of {num(data.census.terms)} in scope</span> : undefined}
          emptyNode={<EmptyState loading={loading} data={data} q={q} push={push} />}
        />
      )}

      {/* ── The seven sections that follow, in order. Every one renders null today. ───────────── */}
      <NegTermDrawer {...slotProps} />
      <NegRemoval {...slotProps} />
      <NegAttention {...slotProps} />

      <NegProtectedTerms {...slotProps} />
      {/* Interim until NEG.5: the panel exactly as the tab rendered it, so the move loses nothing.
          NEG.5 deletes this line and its import when it lands. It keeps its position above the
          rules for the reason its own comment gives — those decide what gets negated, this decides
          what never can be — and sits below the inventory, because the inventory is what you came
          for. */}
      <ProtectedTermsPanel />

      <NegWastefulWords {...slotProps} />

      <NegRules {...slotProps} />
      {/* Interim until NEG.7, same deal. */}
      <RuleListTab
        noun="Negative Targeting Rule"
        seed={[]}
        liveType="negative-targeting"
        editHref={(id) => `/marketing/ads/rules-automation/builder/negative-targeting?ruleId=${id}`}
        onAddRule={() => { window.location.href = '/marketing/ads/rules-automation/builder/negative-targeting' }}
        emptyNode={(
          <span className="h10-rr-empty">
            <NoDataIllus size={104} />
            <b>Create a Negative Targeting Rule to block wasted spend!</b>
            <a className="h10-am-btn primary" href="/marketing/ads/rules-automation/builder/negative-targeting"><Plus size={13} /> Create Rule</a>
          </span>
        )}
      />

      <NegRecord {...slotProps} />
    </div>
  )
}

/** The two grains, never blurred — and the control that says which one you are looking at. */
function ViewToggle({ view, push }: { view: 'negations' | 'terms'; push: (p: Record<string, string>) => void }) {
  return (
    <span className="h10-svt-seg" role="tablist" aria-label="Grain">
      {([['negations', 'Negations'], ['terms', 'Terms']] as const).map(([v, label]) => (
        <button
          key={v} type="button" role="tab" aria-selected={view === v}
          className={`seg ${view === v ? 'on' : ''}`}
          onClick={() => push({ view: v })}
          title={v === 'negations'
            ? 'One row per AdTarget — what Amazon stores, and what later gets archived'
            : 'One row per term — what an operator reasons about. 2,059 negations over 258 terms'}
        >{label}</button>
      ))}
    </span>
  )
}

/** An empty grid has three quite different causes here, and saying which one is the whole job. */
function EmptyState({ loading, data, q, push }: { loading: boolean; data: Payload | null; q: string; push: (p: Record<string, string>) => void }) {
  if (loading) return <span className="h10-ng-empty"><b>Loading…</b></span>
  if (!data) return <span className="h10-ng-empty"><b>Nothing loaded.</b><span>The read failed — the message above says why.</span></span>
  if (data.census.negations === 0) {
    return (
      <span className="h10-ng-empty">
        <b>No negatives in this scope.</b>
        <span>
          Nothing is blocked here. That is a real zero: {data.scope.resolved.campaigns} campaigns
          resolved and none of them holds a negative.
        </span>
      </span>
    )
  }
  return (
    <span className="h10-ng-empty">
      <b>{num(data.census.negations)} negatives are in this scope — the filters hide all of them.</b>
      <span>
        {q ? <>Nothing matches “{q}”. </> : null}
        <button type="button" className="lnk" onClick={() => push({ q: '', match: 'all', level: 'all', state: 'all', amazon: 'all', attribution: 'all' })}>Clear the filters</button>
      </span>
    </span>
  )
}
