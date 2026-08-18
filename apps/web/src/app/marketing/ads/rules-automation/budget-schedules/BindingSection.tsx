'use client'

/**
 * ⛔ PARKED 2026-08-18 (U8) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: "Binding now" — the campaigns spending at or over the budget in force.
 * Why it left: the Budget Schedules tab is now Helium 10's shape — the hourly-performance card over
 *   the schedules grid, and nothing else (`BudgetSchedulesTabClient.tsx`; study
 *   `docs/2026-08-16-ra-h10-reference-study.md` §3.7, §7.9).
 * Candidate home: **Budget Manager** / Analytics.
 *
 * ⚠ Nothing here was changed and no endpoint was retired — `/budget-manager*`, `/budget-binding`
 * and `/budget-schedules*` are all still served. The file stays at this path on purpose:
 * re-mounting it is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * BSP.2 · binding — campaigns spending at or over the budget that was actually in force.
 *
 * The study calls this the highest-value new view on the page, and the reason is one number: budget
 * binds on **a third of all campaign-days**, but only **3.0%** of days go dark before noon. So the
 * money question this account has is *how big is the budget*, not *when did it run out* — and this
 * grid is the evidence for it.
 *
 * ── 🔴 What this section may not do ────────────────────────────────────────────────────────────
 *
 * It is READ-ONLY, and that is an arbitration outcome rather than a scope cut. Substrate spec §4:
 * *"budget level and budget rules → 6 · Budget. 4 shows the consequence, 6 owns the cause."* So
 * there is no budget field, no rule editor and **no row actions** here — §8.13 forbids a row action
 * on a computed grid outright, because the only thing it could do is mutate local state and lie.
 * Where an operator wants to act, one link out to Budget Rules and stop.
 *
 * ── The honesty this grid owes ─────────────────────────────────────────────────────────────────
 *
 * Every number here is DERIVED. Nothing stores what a campaign's budget was on a past day; it is
 * reconstructed from an audit log that is 41% broken at the seams and absent for 136 of 220
 * campaigns. That makes the direction trustworthy and the decimals not, so: the method and the
 * coverage are printed ON THE CARD rather than in a tooltip, ratios render as whole percent, and a
 * campaign with no budget history is marked `≈` on the row and explained in the rail.
 *
 * ── Why there is no live cursor ────────────────────────────────────────────────────────────────
 *
 * Measured 2026-08-16 before deciding: the hourly feed inserts ~984 rows/day and is alive, but this
 * grid is computed over **complete Rome days only** — today's rows change nothing on it until the
 * day closes. And the budget half of the subject has not moved since 2026-08-11: zero
 * `AD_BUDGET_UPDATE` rows in 24 hours. The grid therefore changes at most once a day, at the day
 * boundary. A 30-second poll against that is theatre, and an honestly stale page beats one that
 * feels live and lies. The card states the window instead.
 */

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink, Info } from 'lucide-react'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { getBackendUrl } from '@/lib/backend-url'
import { SectionEmpty } from './SectionShell'
import type { BindingResult, BindingCampaignRow, BspSlotProps } from './slot-contract'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const eur0 = (c: number) => `€${Math.round(c / 100).toLocaleString('en-IE')}`
/** 🔴 Whole percent. The reconstruction does not support a decimal and must not imply one. */
const ratioPct = (r: number) => `${Math.round(r * 100)}%`
const hourLabel = (h: number | null) => (h == null ? '—' : `${String(h).padStart(2, '0')}:00`)

const dayLabel = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

export function BindingSection({ scope, weeks, openRail, onRows }: Pick<BspSlotProps, 'scope' | 'weeks' | 'openRail'> & {
  /** Lifts the fetched rows so the `campaign:` rail reads the same ones, with no second request. */
  onRows: (rows: BindingCampaignRow[]) => void
}) {
  const [data, setData] = useState<BindingResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Narrowed server-side by the spine: an operator scoped to one portfolio must not be handed 86
  // campaigns. The ids come from the resolved scope, never from a second parse of the URL.
  const key = JSON.stringify({ ids: scope.campaignIds, weeks })
  useEffect(() => {
    let alive = true
    setLoading(true)
    const { ids, weeks: w } = JSON.parse(key) as { ids: string[]; weeks: number }
    const qs = new URLSearchParams({ weeks: String(w) })
    // Only send ids when the scope actually narrowed; an unnarrowed page would otherwise ship a
    // 220-id query string on every load.
    if (ids.length && ids.length < 200) qs.set('campaignIds', ids.join(','))
    void fetch(`${getBackendUrl()}/api/advertising/budget-binding?${qs}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`The binding query failed (${r.status}).`)
        return r.json()
      })
      .then((d) => { if (alive) { setData(d as BindingResult); setErr(null); onRows((d as BindingResult).campaigns ?? []) } })
      .catch((e) => { if (alive) { setErr((e as Error).message); setData(null) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // `onRows` is a setState setter and stable; keying on it would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const rows = data?.campaigns ?? []
  const cov = data?.coverage
  const rec = data?.reconstruction

  const columns: GridColumn<BindingCampaignRow>[] = useMemo(() => [
    {
      key: 'marketplace', label: 'Market', metric: false, sortable: true,
      render: (r) => <span className="h10-bsp-mkt">{r.marketplace}</span>,
      sortValue: (r) => r.marketplace,
    },
    {
      key: 'currentBudgetCents', label: 'Budget now', metric: false, sortable: true,
      tip: 'Today’s daily budget. The ratios beside it are against the budget in force on each past day, which is usually a different number.',
      render: (r) => <span className="h10-bsp-num">{eur(r.currentBudgetCents)}</span>,
      sortValue: (r) => String(r.currentBudgetCents).padStart(12, '0'),
    },
    {
      key: 'spendCents', label: 'Spend in window', metric: false, sortable: true,
      render: (r) => <span className="h10-bsp-num">{eur0(r.spendCents)}</span>,
      sortValue: (r) => String(r.spendCents).padStart(12, '0'),
    },
    {
      key: 'daysBinding', label: 'Binding', metric: false, sortable: true,
      tip: 'Days this campaign spent at or over the budget in force, out of the days it spent anything at all.',
      render: (r) => (
        <span className={`h10-bsp-bind${r.daysBinding > 0 ? ' on' : ''}`}>
          <b>{r.daysBinding}</b> / {r.daysWithSpend}
        </span>
      ),
      sortValue: (r) => String(r.daysBinding).padStart(4, '0'),
    },
    {
      key: 'maxRatio', label: 'Max ratio', metric: false, sortable: true,
      // 🔴 Over 100% is normal and must never be styled as an error. Amazon treats a daily budget
      // as a rate governor it may overshoot, settling the average across the month.
      tip: 'The highest single day. Over 100% is normal — Amazon lets a day exceed its daily budget and settles the average over the month.',
      render: (r) => <span className={`h10-bsp-ratio${r.maxRatio >= 1 ? ' over' : ''}`}>{ratioPct(r.maxRatio)}</span>,
      sortValue: (r) => String(Math.round(r.maxRatio * 1000)).padStart(8, '0'),
    },
    {
      key: 'lastDeliveringHour', label: 'Last hour', metric: false, sortable: true,
      tip: 'The hour it last spent anything, on the days it was binding. Rome. This is what an hourly budget schedule would act on — and only 3% of campaign-days go quiet before noon.',
      render: (r) => <span className="h10-bsp-num">{hourLabel(r.lastDeliveringHour)}</span>,
      sortValue: (r) => String(r.lastDeliveringHour ?? -1).padStart(3, '0'),
    },
    {
      key: 'lastBudgetWrite', label: 'Last write', metric: false, sortable: true,
      render: (r) => (r.lastBudgetWrite
        ? <span className="h10-bsp-lw">
            {dayLabel(r.lastBudgetWrite.at.slice(0, 10))}
            {r.lastBudgetWrite.toCents != null && <i> → {eur(r.lastBudgetWrite.toCents)}</i>}
          </span>
        : <span className="h10-bsp-dim">never</span>),
      sortValue: (r) => r.lastBudgetWrite?.at ?? '',
    },
  ], [])

  // ── broke: the fetch threw, or nothing in the window is usable ───────────────────────────────
  if (!loading && (err || cov?.daysUsable === 0)) {
    return (
      <SectionEmpty
        kind="broke"
        noun="binding"
        error={err ?? `No day in the last ${cov?.daysRequested ?? 0} is usable. The hourly feed returned rows with zero cost for the whole window, so a ratio computed over it would be an artefact rather than a measurement.`}
      />
    )
  }

  return (
    <>
      {/* 🔴 The method and the coverage go ON the card. An operator acting on these rows from page
          6 is entitled to know how the number was made without hovering to find out. */}
      {cov && rec && (
        <div className="h10-bsp-method">
          <p>
            <b>{cov.daysUsable} complete {cov.daysUsable === 1 ? 'day' : 'days'}, {cov.from} → {cov.to}.</b>{' '}
            {cov.daysUsable < cov.daysRequested && (
              <>Earlier days are not usable — the hourly feed returned zero for the month before that.{' '}</>
            )}
            {cov.daysUnverifiable > 0 && (
              <>{cov.daysUnverifiable} of them could not be cross-checked: the daily report is itself empty for those days.</>
            )}
          </p>
          <p>
            Budget-in-force is <b>reconstructed</b> from {rec.writesRead.toLocaleString('en-IE')} audit rows.{' '}
            {rec.chainBreaks > 0 && <>{rec.chainBreaks.toLocaleString('en-IE')} have a gap at the seam, </>}
            {rec.campaignsWithoutLog > 0 && (
              <>and {rec.campaignsWithoutLog} campaigns have no budget history at all — those are marked{' '}
                <span className="h10-bsp-approx">≈</span> and measured against today&rsquo;s budget instead.</>
            )}
          </p>
        </div>
      )}

      <AdsDataGrid<BindingCampaignRow>
        rows={rows}
        loading={loading}
        rowId={(r) => r.id}
        noun="Campaign"
        firstColLabel="Campaign"
        renderFirst={(r) => (
          <span className="h10-bsp-cname" title={r.name}>
            {/* A button, not a link: this opens the inspector rail via the URL, and the rail is a
                view of this page rather than a destination. */}
            <button type="button" className="h10-bsp-open" onClick={() => openRail({ kind: 'campaign', id: r.id })}>
              {r.name}
            </button>
            {r.approximate && (
              <span className="h10-bsp-approx" title="This campaign has no budget history in the audit log, so every ratio is measured against today's budget rather than the budget actually in force that day.">≈</span>
            )}
            {r.status !== 'ENABLED' && <span className="h10-bsp-cstat">{r.status.toLowerCase()}</span>}
          </span>
        )}
        firstSortValue={(r) => r.name.toLowerCase()}
        columns={columns}
        searchable
        searchPlaceholder="Search campaigns…"
        searchValue={(r) => r.name}
        filters={[
          {
            key: 'binding', label: 'Binding', kind: 'select',
            options: [{ value: 'yes', label: 'Bound at least once' }, { value: 'no', label: 'Never bound' }],
            value: (r) => ((r as BindingCampaignRow).daysBinding > 0 ? 'yes' : 'no'),
          },
          {
            key: 'marketplace', label: 'Market', kind: 'multiselect',
            options: ['IT', 'DE', 'ES', 'FR'].map((m) => ({ value: m, label: m })),
            value: (r) => (r as BindingCampaignRow).marketplace,
          },
        ]}
        customizable={false}
        pagerCentered
        // The server already sorts by days-binding then max ratio; this keeps a header click honest.
        defaultSort={{ key: 'daysBinding', dir: 'desc' }}
        emptyLabel="No campaign spent anything in this window"
        toolbarRight={
          // 🔴 The ONLY affordance on this grid, and it leaves the page. §8.13 + D9: 4 shows the
          // consequence, 6 owns the cause.
          <a className="h10-bsp-cause" href="/marketing/ads/rules-automation/budget">
            What may change a budget <ExternalLink size={11} />
          </a>
        }
      />

      {/* ── ran-nothing: spend exists, nothing bound. A real answer, not an empty grid. ───────── */}
      {!loading && rows.length > 0 && rows.every((r) => r.daysNear === 0) && cov && (
        <p className="h10-bsp-note">
          <Info size={12} />
          <span>
            <b>No campaign reached 90% of its budget in these {cov.daysUsable} days.</b> Budget is not
            the constraint on this scope right now — every campaign delivered inside what it was allowed.
          </span>
        </p>
      )}

      {/* nothing-made: nothing in scope spent at all. */}
      {!loading && rows.length === 0 && cov && cov.daysUsable > 0 && (
        <SectionEmpty
          kind="nothing-made"
          noun="campaigns with spend"
          what={`No campaign in this scope spent anything between ${cov.from} and ${cov.to}. Nothing can bind a budget it never reached.`}
        />
      )}

      {rows.some((r) => r.approximate) && (
        <p className="h10-bsp-note">
          <AlertTriangle size={12} />
          <span>
            Rows marked <span className="h10-bsp-approx">≈</span> have no budget history, so their
            ratios are measured against today&rsquo;s budget. If that budget changed during the
            window, those ratios are wrong by however much it changed.
          </span>
        </p>
      )}
    </>
  )
}
