'use client'

/**
 * ⛔ PARKED 2026-08-18 (U7) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the ?view=harvested cohort — "did the last batch work".
 * Why it left: the Keyword Harvest tab is now Helium 10's shape — the pill
 *   [ Rules View | Ad Group View ] over one card, and nothing else
 *   (`KeywordHarvestRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.3, §7.8).
 * Candidate home: **Analytics** — an outcome measurement.
 *
 * ⚠ Nothing here was changed, no endpoint was retired, and the harvest engine's own arming is
 * untouched. The file stays at this path on purpose: re-mounting it is one import.
 * Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * HV.5 — the harvested cohort: did the last batch work?
 *
 * The second half of the page's question, as a second **view** on the same page (`?view=harvested`),
 * not a route and not a page. No competitor ships it, because none owns the write path, the
 * performance table and the audit log at once.
 *
 * ── 🔴 Four outcomes, four different failures, four different fixes ───────────────────────────
 *
 *   never reached Amazon   our record says we created a keyword; Amazon has no such keyword.
 *                          Nothing will ever happen to it. **209 of 218.**
 *   not measured           it predates the performance window (2026-07-05), so we cannot see what
 *                          it did. NOT the same as "did nothing".
 *   reached, never served   it exists and is losing the auction, or its ad group is inert.
 *   served                  the only rows where "did it pay" is even a question. **6 of 218.**
 *
 * Merging any two of those is the defect this view exists to remove — and the retraction that
 * taught this page the lesson ("688 harvested keywords, 0 impressions") came from exactly that.
 *
 * ── The comparison refuses to conclude, and that is the point ──────────────────────────────────
 *
 * Six served keywords and eleven orders cannot carry a verdict. The view renders
 * *"not enough evidence yet"* with the confounds and says what would change it, rather than
 * printing "19% vs 25%" as a result. **"We cannot answer this yet, and here is exactly what would
 * make it answerable" is worth more than a confident wrong number.**
 */

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Info, ShieldAlert } from 'lucide-react'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { getBackendUrl } from '@/lib/backend-url'
import type { HvSlotProps } from './slot-contract'

type HvOutcome = 'local-only' | 'not-measured' | 'never-served' | 'served'
type HvActor = 'engine' | 'operator' | 'app-bulk' | 'mirrored'

interface CohortRow {
  targetId: string; term: string; matchType: string; market: string
  campaignName: string; adGroupName: string
  actor: HvActor; actorLabel: string; createdAt: string
  reachedAmazon: boolean; externalTargetId: string | null
  outcome: HvOutcome; asinShaped: boolean
  openingBidCents: number | null; openingBidSource: 'unchanged' | 'reconstructed' | 'unknown'
  currentBidCents: number; status: string
  performance: null | { impressions: number; clicks: number; spendCents: number; salesCents: number; orders: number; acosPct: number | null; firstSeen: string; lastSeen: string; days: number }
  evidenceNote: string | null
}
interface Payload {
  rows: CohortRow[]
  census: {
    cohort: number
    byActor: Record<HvActor, number>
    byOutcome: Record<HvOutcome, number>
    excluded: { mirrored: number; appBulk: number; total: number }
    unclassifiable: number
    served: { keywords: number; spendCents: number; salesCents: number; orders: number; acosPct: number | null }
    backlog: { pushable: number; asinShaped: number }
    window: { start: string; end: string | null }
  }
  comparison: {
    groups: Array<{ actor: HvActor; actorLabel: string; market: string; keywords: number; spendCents: number; salesCents: number; orders: number; acosPct: number | null; avgAgeDays: number }>
    verdict: 'not-enough-evidence' | 'indicative'
    servedHarvested: number; harvestedOrders: number; confounds: string[]
  }
  scope: { market: string; campaignsWithCohort: number; campaignsTotal: number }
  total: number; truncated: boolean
}

const num = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dayMonth = (iso: string) => { const d = new Date(iso); return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}` }

const OUTCOME_LABEL: Record<HvOutcome, string> = {
  'served': 'served',
  'never-served': 'never served',
  'not-measured': 'not measured',
  'local-only': 'never reached Amazon',
}
const OUTCOME_TIP: Record<HvOutcome, string> = {
  'served': 'It reached Amazon and took at least one impression. These are the only rows where "did it pay?" is even a question.',
  'never-served': 'It reached Amazon and took no impressions at all. It exists and is losing the auction, or its ad group is inert — a bidding problem, not a plumbing one.',
  'not-measured': 'It was created before 2026-07-05, when performance data begins, and has no rows. We cannot see what it did. This is NOT the same as "it did nothing".',
  'local-only': 'Our record says we created a keyword. Amazon has no such keyword. Nothing will ever happen to it — this is a plumbing failure, not a performance one.',
}

export function HvCohort({ scope, push }: HvSlotProps) {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // The view lives in the URL — HV.1 reserved `?view=` for exactly this.
  const params = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search)
  const view = params?.get('view') ?? 'candidates'
  const outcome = (params?.get('outcome') ?? 'all') as HvOutcome | 'all'
  const actor = (params?.get('actor') ?? 'all') as HvActor | 'all'

  useEffect(() => {
    if (view !== 'harvested') return
    let alive = true
    setLoading(true)
    const p = new URLSearchParams({ market: scope.market })
    if (outcome !== 'all') p.set('outcome', outcome)
    if (actor !== 'all') p.set('actor', actor)
    void fetch(`${getBackendUrl()}/api/advertising/harvest-cohort?${p.toString()}`, { cache: 'no-store', credentials: 'include' })
      .then(async (r) => { if (!r.ok) throw new Error(`Could not load the cohort (${r.status})`); return r.json() })
      .then((d) => { if (alive) { setData(d as Payload); setErr(null) } })
      .catch((e) => { if (alive) { setErr((e as Error).message); setData(null) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [view, scope.market, outcome, actor])

  const columns: GridColumn<CohortRow>[] = useMemo(() => [
    {
      key: 'outcome', label: 'Outcome', metric: false,
      tip: 'Four different failures with four different fixes. "Never reached Amazon" is plumbing; "never served" is bidding; "not measured" is us, not the keyword.',
      render: (r) => <span className={`h10-hv-oc ${r.outcome}`} title={OUTCOME_TIP[r.outcome]}>{OUTCOME_LABEL[r.outcome]}</span>,
      sortValue: (r) => r.outcome,
    },
    {
      key: 'where', label: 'Where', metric: false,
      render: (r) => (
        <span className="h10-hv-src">
          <span className="ag" title={r.adGroupName}>{r.adGroupName}</span>
          <i title={r.campaignName}>{r.campaignName}<b className="tt manual">{r.market}</b></i>
        </span>
      ),
      sortValue: (r) => `${r.campaignName} ${r.adGroupName}`,
    },
    {
      key: 'created', label: 'Harvested', metric: false,
      render: (r) => <span className="h10-hv-dt">{dayMonth(r.createdAt)}<i>{new Date(r.createdAt).getUTCFullYear()}</i></span>,
      sortValue: (r) => r.createdAt,
    },
    {
      key: 'bid', label: 'Opening → now',
      tip: 'The bid it was harvested at, and what it bids now. 99 keywords have never had a recorded bid change, so today\'s bid IS the opening one; 119 were reconstructed from the earliest recorded change. None is unknown. Session 9 owns the curve between them.',
      render: (r) => (
        <span className="h10-hv-bid2">
          <b title={r.openingBidSource === 'reconstructed' ? 'reconstructed from the earliest recorded bid change' : 'never changed since creation'}>
            {r.openingBidCents == null ? '—' : eur(r.openingBidCents)}
            {r.openingBidSource === 'reconstructed' && <em>~</em>}
          </b>
          <i>→ {eur(r.currentBidCents)}</i>
        </span>
      ),
      sortValue: (r) => r.openingBidCents ?? -1,
    },
    // 🔴 Every performance column renders a dash when there is nothing to show, never a zero.
    { key: 'impr', label: 'Impressions', render: (r) => (r.performance ? num(r.performance.impressions) : <Nd o={r.outcome} />), sortValue: (r) => r.performance?.impressions ?? -1, filterValue: (r) => r.performance?.impressions ?? 0 },
    { key: 'clicks', label: 'Clicks', render: (r) => (r.performance ? num(r.performance.clicks) : <Nd o={r.outcome} />), sortValue: (r) => r.performance?.clicks ?? -1 },
    { key: 'spend', label: 'Spend', render: (r) => (r.performance ? eur(r.performance.spendCents) : <Nd o={r.outcome} />), sortValue: (r) => r.performance?.spendCents ?? -1 },
    { key: 'sales', label: 'Sales', render: (r) => (r.performance ? eur(r.performance.salesCents) : <Nd o={r.outcome} />), sortValue: (r) => r.performance?.salesCents ?? -1 },
    { key: 'orders', label: 'Orders', render: (r) => (r.performance ? num(r.performance.orders) : <Nd o={r.outcome} />), sortValue: (r) => r.performance?.orders ?? -1 },
    {
      key: 'acos', label: 'ACoS',
      render: (r) => (r.performance ? (r.performance.acosPct == null ? <span className="h10-hv-nd" title="served, but no attributed sales to divide by">—</span> : `${r.performance.acosPct.toFixed(0)}%`) : <Nd o={r.outcome} />),
      sortValue: (r) => r.performance?.acosPct ?? -1,
    },
    {
      key: 'seen', label: 'Measured over', metric: false,
      tip: 'The span of performance data behind this row. A number resting on two days is not the same as one resting on thirty, and the row says which.',
      render: (r) => (r.performance
        ? <span className="h10-hv-dt">{dayMonth(r.performance.firstSeen)} → {dayMonth(r.performance.lastSeen)}<i>{r.performance.days} days</i></span>
        : <Nd o={r.outcome} />),
      sortValue: (r) => r.performance?.days ?? -1,
    },
  ], [])

  if (view !== 'harvested') return null

  const c = data?.census
  return (
    <>
      {err && <p className="h10-hv-blind"><AlertTriangle size={13} /><span>{err}</span></p>}

      {c && data && (
        <>
          {/* ── what this view is about, and what it deliberately leaves out ────────────── */}
          <div className="h10-hv-lede">
            <p>
              <b>{num(c.cohort)} keyword{c.cohort === 1 ? '' : 's'} this account harvested</b>, across{' '}
              <b>{num(data.scope.campaignsWithCohort)} of {num(data.scope.campaignsTotal)} campaigns</b>.
              {' '}Of those, <b>{num(c.byOutcome.served)} ever served</b>
              {c.served.acosPct != null && <> — {eur(c.served.spendCents)} spent, {eur(c.served.salesCents)} back, {num(c.served.orders)} orders, <b>{c.served.acosPct.toFixed(0)}% ACoS</b></>}.
            </p>
            <p className="sub">
              <Info size={12} />
              <span>
                {num(c.excluded.total)} other keywords are excluded and not folded in:{' '}
                <b>{num(c.excluded.mirrored)} mirrored from Amazon</b> (this system never wrote them — no creation record, and
                every one carries a sync stamp and an Amazon id) and <b>{num(c.excluded.appBulk)} bulk-created in the app</b>{' '}
                on four days. <b>Nothing is unclassifiable.</b> Before the promote button shipped there was no
                operator-initiated harvest path at all, so the only harvest writer that has ever existed is the engine.
              </span>
            </p>
            <p className="sub">
              <span>
                Performance data begins <b>{dayMonth(c.window.start)}</b>
                {c.window.end && <> and runs to <b>{dayMonth(c.window.end)}</b></>}. A keyword created before it has
                no measurable “after” — that is <b>not measured</b>, and it is not the same as “did nothing”.
              </span>
            </p>
          </div>

          {/* ── the four outcomes, each a filter that reproduces its own number ─────────── */}
          <div className="h10-hv-census" role="group" aria-label="What happened to them">
            {(['served', 'never-served', 'not-measured', 'local-only'] as HvOutcome[]).map((o) => (
              <button
                key={o} type="button" title={OUTCOME_TIP[o]}
                className={`h10-hv-cell ${o === 'served' ? 'live' : o === 'local-only' ? 'warn' : 'muted'} ${outcome === o ? 'on' : ''}`}
                onClick={() => push({ outcome: outcome === o ? 'all' : o })}
              >
                <b>{num(c.byOutcome[o])}</b><span>{OUTCOME_LABEL[o]}</span>
              </button>
            ))}
          </div>

          {/* 🔴 the backlog — a work queue, with the 54 separated */}
          {c.backlog.pushable > 0 && (
            <p className="h10-hv-critwarn">
              <ShieldAlert size={12} />
              <span>
                <b>{num(c.backlog.pushable)} of these exist here and not at Amazon, and the write gate is open in every market.</b>{' '}
                They can be pushed — nothing has been. A further <b>{num(c.backlog.asinShaped)} are ASIN text stored as keywords</b>{' '}
                (pre-H.5 legacy) and are <b>refused</b> rather than pushed: an ASIN is a product target, so those are deletions, not retries.
              </span>
            </p>
          )}

          {/* ── §4.7 — the comparison, and the refusal to conclude ──────────────────────── */}
          <div className="h10-hv-destsum">
            <p className="hd"><Info size={13} /> <b>Does harvesting pay here?</b></p>
            {data.comparison.verdict === 'not-enough-evidence' ? (
              <p className="couple">
                <AlertTriangle size={12} />
                <span>
                  <b>Not enough evidence yet.</b> {num(data.comparison.servedHarvested)} harvested keyword
                  {data.comparison.servedHarvested === 1 ? ' has' : 's have'} ever served, carrying{' '}
                  {num(data.comparison.harvestedOrders)} order{data.comparison.harvestedOrders === 1 ? '' : 's'}. That cannot
                  carry a verdict, and a number here would be inventing confidence.{' '}
                  <b>What would change it:</b> harvests that actually land — the {num(c.backlog.pushable)} above, and
                  keywords promoted from the Candidates view.
                </span>
              </p>
            ) : (
              <p className="couple"><Info size={12} /><span>Indicative — the sample now supports a comparison. Read the confounds below before quoting it.</span></p>
            )}
            {data.comparison.groups.length > 0 && (
              <table className="h10-hv-cmp">
                <thead><tr><th>Group</th><th>Market</th><th>Served</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACoS</th><th>Avg age</th></tr></thead>
                <tbody>
                  {data.comparison.groups.map((g) => (
                    <tr key={`${g.actor}|${g.market}`} className={g.actor === 'engine' || g.actor === 'operator' ? 'me' : ''}>
                      <td>{g.actorLabel}</td><td>{g.market}</td><td>{num(g.keywords)}</td>
                      <td>{eur(g.spendCents)}</td><td>{eur(g.salesCents)}</td><td>{num(g.orders)}</td>
                      <td>{g.acosPct == null ? '—' : `${g.acosPct.toFixed(0)}%`}</td><td>{g.avgAgeDays.toFixed(0)}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <ul className="h10-hv-conf">
              {data.comparison.confounds.map((f) => <li key={f}>{f}</li>)}
            </ul>
          </div>
        </>
      )}

      <AdsDataGrid<CohortRow>
        rows={data?.rows ?? []}
        loading={loading}
        rowId={(r) => r.targetId}
        noun="Harvested keyword"
        firstColLabel="Keyword"
        renderFirst={(r) => (
          <div className="h10-hv-term">
            <span className="t" title={r.term}>{r.term}</span>
            {r.asinShaped && <span className="fl warn" title="An ASIN stored as keyword text — pre-H.5 legacy. It must be deleted, not pushed.">ASIN as keyword</span>}
            {r.actor === 'operator' && <span className="fl neg" title="Harvested from this page">by you</span>}
          </div>
        )}
        firstSortValue={(r) => r.term.toLowerCase()}
        columns={columns}
        defaultSort={{ key: 'spend', dir: 'desc' }}
        selectable={false}
        searchable
        searchPlaceholder="Search keyword, campaign or ad group…"
        searchValue={(r) => `${r.term} ${r.campaignName} ${r.adGroupName}`}
        pagerCentered
        storageKey="nexus.hv.cohortcols"
        toolbarRight={data ? <span className="h10-hv-win">{num(data.total)} of {num(data.census.cohort)} harvested</span> : undefined}
        emptyNode={<CohortEmpty loading={loading} data={data} outcome={outcome} push={push} />}
        reportLabel={c?.window.end ? `performance to ${dayMonth(c.window.end)}` : undefined}
      />
    </>
  )
}

/**
 * 🔴 A dash with the REASON, never a zero. Which of the three non-served states a row is in decides
 * what the blank means, and they are not interchangeable.
 */
function Nd({ o }: { o: HvOutcome }) {
  return <span className="h10-hv-nd" title={OUTCOME_TIP[o]}>{o === 'not-measured' ? 'not measured' : o === 'local-only' ? 'not at Amazon' : '—'}</span>
}

function CohortEmpty({ loading, data, outcome, push }: { loading: boolean; data: Payload | null; outcome: string; push: (p: Record<string, string>) => void }) {
  if (loading) return <span className="h10-hv-empty"><b>Loading…</b></span>
  if (!data) return <span className="h10-hv-empty"><b>Nothing loaded.</b><span>The read failed, so this is not telling you there are no harvested keywords — it is telling you it does not know.</span></span>
  if (data.census.cohort === 0) {
    return (
      <span className="h10-hv-empty">
        <b>Nothing has been harvested in this scope.</b>
        <span>
          {num(data.census.excluded.total)} keywords exist here, but none was created by a harvest — they were
          mirrored from Amazon or bulk-created in the app. Promote a candidate to start this list.
        </span>
      </span>
    )
  }
  return (
    <span className="h10-hv-empty">
      <b>{num(data.census.cohort)} harvested keywords are in this scope — the filter hides all of them.</b>
      <span><button type="button" className="lnk" onClick={() => push({ outcome: 'all', actor: 'all' })}>Clear the filter</button> {outcome !== 'all' && `(showing “${OUTCOME_LABEL[outcome as HvOutcome] ?? outcome}” only)`}</span>
    </span>
  )
}
