'use client'

/**
 * BSP.0 — the Budget Schedules grid, moved here from `_schedule/BudgetScheduleTab.tsx` and fixed in
 * three places. It was the whole of the old tab; it is now one section of six.
 *
 * ── The three honesty defects, fixed ───────────────────────────────────────────────────────────
 *
 * They were one-liners, they were lies, and they would have been forgotten once the page looked
 * finished. Line numbers refer to the file this replaces:
 *
 *   :42   `catch { /* backend not live yet — empty *\/ }`  — an API 500 rendered "No schedules
 *         created". An account that is broken and an account that is empty were the same screen.
 *         Now: the error surfaces through the shared `broke` empty state, with its real text.
 *   :67   `DELETE … .catch(() => {})` then removed the row locally regardless — a failed delete
 *         looked exactly like a successful one, with no confirmation step. Now: confirm first, and
 *         on failure the row STAYS and says why.
 *   :120  the create button was labelled "Rule" on a page whose noun is "Schedule".
 *
 * ── State of the section as of W4 (2026-08-20) — the old caveats here were STALE ───────────────
 *
 * Two claims this header used to make were contradicted by the code below it and cost a later
 * study real time: the hourly card is REAL (`HourlyPerformanceCard` reads the endpoint; the
 * "not available" sentence renders only on `hasData: false`), and the Exclude columns read real
 * stored ranges (the route stopped hard-coding nulls in BSP.2). W4 then closed the remaining
 * authoring gap — the builder used to send `excludeDates` as a BOOLEAN the route discarded, so
 * the executor's blackout branch was unreachable and these columns were "—" in practice.
 *
 * ── BSP-P2/P3/P4 (2026-08-21) ───────────────────────────────────────────────────────────────
 *
 * · **The market selector binds.** The page header has offered IT/DE/ES/FR since U8 and this
 *   section read none of it: both fetches went out unscoped. Measured on prod with the header
 *   reading "🇩🇪 Germany", the chart was byte-identical — and the markets peak up to four hours
 *   apart (IT h22 · DE h18 · ES h15 · FR h19), so the merged curve was true of no market. A
 *   `Markets` column comes with it: filtering by a market while hiding which markets a row spans
 *   would just move the opacity.
 * · **Delivery is a column now.** `lastApplied[...].state = 'applied'` means written locally and
 *   QUEUED. On this account the write gate skipped 298 of 398 budget writes in 7 days, so "applied"
 *   and "at Amazon" are different facts and the grid shows both. `yielded` is the third: another
 *   writer moved the budget and the schedule stood down — previously silent, while the Status pill
 *   went on saying the windows were in force.
 * · **BSP.6 — a yield NAMES its counterparty.** The precedence rule the operator settled on
 *   2026-08-22 is "a schedule owns a campaign only while its own window is open", so standing down
 *   is correct behaviour rather than a fault. But yielding to the budget pacer (the monthly
 *   envelope holding) and yielding to the operator's own hand call for opposite responses, and one
 *   word for both hid the only distinction that matters. `describeYields` is shared by the Status
 *   tooltip and the Delivery tooltip so they cannot tell different stories about the same row.
 * · **The Status pill uses a LOCAL day key.** It was `new Date().toISOString().slice(0,10)` — UTC —
 *   compared against local calendar dates, so between 00:00 and 02:00 Rome a schedule that ended
 *   yesterday still read "Active" ([[reference_day_grouping_utc_local_trap]]).
 * · **All blackout ranges are visible.** The route has always returned `excludeRanges` (a count)
 *   and this grid dropped it while showing only the FIRST range — a partial truth shown as a whole
 *   one.
 *
 * W4 also added the Status column (toggle + Scheduled/Active/Completed/Off pill — the API's
 * `enabled` used to be dropped on the floor here, leaving a live schedule indistinguishable from
 * a disabled one and no way to stop one short of deleting it), and the DELETE/disable routes now
 * restore base budgets (before that, deleting a schedule mid-window left the boost in place
 * forever). Still absent, deliberately, pending operator decisions: Amazon-event presets (BSP.5),
 * auto-refill (a write-only column with no executor semantics), and precedence between the five
 * dailyBudget writers (BSP.6).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/design-system/primitives'
import { useRouter } from 'next/navigation'
import { Plus, Eye, EyeOff, Info, ExternalLink, Trash2 } from 'lucide-react'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { HoverCard } from '../../campaigns/FilterDropdown'
import { MetricSelect } from '../_schedule/MetricSelect'
import { H10Select } from '../../campaigns/FilterDropdown'
import { GROUP_BY } from '../_schedule/scheduleConfig'
import { HourlyPerformanceCard } from './HourlyPerformanceCard'
import { getBackendUrl } from '@/lib/backend-url'
import { SectionEmpty } from './SectionShell'
// BSP-P5 — the state vocabulary lives in a pure module so it can be TESTED. A client component
// cannot be loaded under vitest here, and these three functions are exactly what the operator
// reads about whether a schedule is working. Same move as `bid/bidState.ts`.
import { deliveryCell, localDayKey, scheduleStatus, type ScheduleDelivery } from './scheduleState'
import { ScheduleContextStrip } from './ScheduleContextStrip'

/** W4 — `autoRefill` dropped (dead client state since BSP.2 removed its column); `enabled` added
 *  (the API always returned it; nothing read it). */
interface ScheduleRow {
  id: string; name: string; type: string; days: string; enabled: boolean
  startDate: string; endDate: string; excludeStart: string; excludeEnd: string
  /** BSP-P4 — the route returns how many blackout ranges exist; the grid used to drop it and show
   *  only the first, which reads as "there is one". */
  excludeRanges: number
  /** BSP-P2 — the markets this schedule's campaigns are in. A BudgetSchedule has no marketplace
   *  column: its reach IS its campaign snapshot. */
  markets: string[]
  /** BSP-P3 — what it last did, and how much of that reached Amazon. */
  delivery: ScheduleDelivery | null
  lastEvaluatedAt: string | null
}

const TYPE_LABEL: Record<string, string> = { 'campaign-budget': 'Campaign Budget', 'budget-multiplier': 'Budget Multiplier' }

export function SchedulesSection({ market }: { market?: string }) {
  const router = useRouter()
  const scope = market && market !== 'all' ? market : null
  const [rows, setRows] = useState<ScheduleRow[]>([])
  const [loading, setLoading] = useState(true)
  // 🔴 The fix for :42. A fetch that threw is a different fact from an account with no schedules,
  // and the operator has to be able to tell them apart.
  const [err, setErr] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [metric1, setMetric1] = useState('Spend')
  const [metric2, setMetric2] = useState('ACoS')
  /**
   * BSP-P5 — Day-of-Week grouping, which the BUILDER has had all along and the TAB — the screen
   * where the decision is actually made — did not. It is newly supportable: the 2026-08-11 study
   * measured 1.14 samples per weekday and ruled it out until late September; the store now holds 90
   * distinct days, so a 60-day window carries ~8.6 per weekday. Shares `GROUP_BY` with the builder
   * so the two cannot offer different words for the same thing.
   */
  const [groupBy, setGroupBy] = useState<'hour' | 'weekday' | 'cell'>('hour')
  const [chartOpen, setChartOpen] = useState(true)
  const [total, setTotal] = useState(0)
  const [deleteErr, setDeleteErr] = useState<string | null>(null)
  const [toggleErr, setToggleErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    ;(async () => {
      try {
        // BSP-P2 — scoped. `total` comes back too, so the grid can say what a market filter HID
        // rather than letting a filtered-to-nothing view read as "you have no schedules".
        const qs = scope ? `?marketplace=${encodeURIComponent(scope)}` : ''
        const r = await fetch(`${getBackendUrl()}/api/advertising/budget-schedules${qs}`, { cache: 'no-store' })
        if (!r.ok) throw new Error(`The schedules request failed (${r.status}).`)
        const j = await r.json()
        const items = (Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : []) as Array<Record<string, unknown>>
        if (alive) {
          setErr(null)
          setTotal(typeof j?.total === 'number' ? j.total : items.length)
          setRows(items.map((s) => ({
            id: String(s.id), name: String(s.name ?? ''), type: TYPE_LABEL[String(s.type ?? '')] ?? String(s.type ?? '—'),
            days: String(s.days ?? '—'), enabled: s.enabled !== false,
            startDate: s.startDate ? String(s.startDate) : '—', endDate: s.endDate ? String(s.endDate) : '—',
            excludeStart: s.excludeStart ? String(s.excludeStart) : '—', excludeEnd: s.excludeEnd ? String(s.excludeEnd) : '—',
            excludeRanges: Number(s.excludeRanges ?? 0),
            markets: Array.isArray(s.markets) ? (s.markets as string[]).map(String) : [],
            delivery: (s.delivery ?? null) as ScheduleDelivery | null,
            lastEvaluatedAt: s.lastEvaluatedAt ? String(s.lastEvaluatedAt) : null,
          })))
        }
      } catch (e) {
        if (alive) { setErr((e as Error).message); setRows([]) }
      } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [scope])

  /**
   * W4 — pause/resume, on the PATCH that existed with no caller. Optimistic with revert-on-failure
   * (the list is cached 15s server-side, so a refetch would flip the switch back under the
   * operator's finger — the U13 lesson). Turning a schedule OFF also restores base budgets
   * server-side; the tooltip says so, because that is a spend-affecting side effect.
   */
  const toggleEnabled = useCallback(async (id: string, on: boolean) => {
    setToggleErr(null)
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, enabled: on } : r)))
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/budget-schedules/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.error != null) throw new Error(String(j?.error ?? `the server answered ${r.status}`))
    } catch (e) {
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, enabled: !on } : r)))
      setToggleErr(`The schedule could not be ${on ? 'resumed' : 'paused'} (${(e as Error).message}) — the switch shows its real state.`)
    }
  }, [])

  /**
   * 🔴 BSP-P4 — a LOCAL day key. This was `toISOString().slice(0,10)` — UTC — compared against
   * `startDate`/`endDate`, which are local calendar dates the operator typed. In Europe/Rome every
   * instant between 00:00 and 02:00 local is still "yesterday" in UTC, so a schedule that ended
   * yesterday kept reporting **Active** for the first two hours of every day, and one starting
   * today read **Scheduled**. [[reference_day_grouping_utc_local_trap]] — derive the key from
   * getFullYear/getMonth/getDate, never from an ISO string.
   */
  const todayIso = useMemo(() => localDayKey(), [])
  const columns: GridColumn<ScheduleRow>[] = useMemo(() => [
    /**
     * W4 — H10's color-coded Status pill (Scheduled / Active / Completed), plus the pause switch.
     * Both read/write facts the API already carried: `enabled` came back on every row and was
     * dropped; `PATCH {enabled}` was a reachable endpoint with no caller. A schedule that is live
     * and one that is off used to be the same row on this screen.
     */
    {
      key: 'status', label: 'Status', metric: false, sortable: true,
      sortValue: (r) => scheduleStatus(r, todayIso).word,
      render: (r) => {
        const s = scheduleStatus(r, todayIso)
        return (
          <span className="h10-bs-statecell">
            <button
              type="button" role="switch" aria-checked={r.enabled}
              className={`h10-bktoggle ${r.enabled ? 'on' : ''}`}
              aria-label={`${r.enabled ? 'Pause' : 'Resume'} ${r.name}`}
              title={r.enabled ? 'Pause this schedule — its campaigns are restored to their base budgets.' : 'Resume this schedule.'}
              onClick={() => void toggleEnabled(r.id, !r.enabled)}
            ><span /></button>
            <span className={`h10-bd7-posture ${s.cls}`} title={s.why}>{s.word}</span>
          </span>
        )
      },
    },
    /**
     * 🔴 BSP-P3 — the column this tab never had: did the last write REACH AMAZON?
     *
     * `applied` in the schedule's own memo means written locally and queued. The write gate runs
     * afterwards in the sync worker and skipped 298 of 398 budget writes on this account in 7 days,
     * so a schedule can report success while nothing moved at Amazon. `yielded` is the other silent
     * outcome: another writer took the budget and the schedule stood down.
     */
    {
      key: 'delivery', label: 'Delivery', metric: false, sortable: true,
      sortValue: (r) => deliveryCell(r.delivery).word,
      render: (r) => {
        const d = deliveryCell(r.delivery)
        return (
          <HoverCard text={d.why} placement="below">
            <span className={`h10-bs-deliv ${d.cls}`}>{d.word}</span>
          </HoverCard>
        )
      },
    },
    { key: 'type', label: 'Type', metric: false, sortable: true, render: (r) => r.type },
    // BSP-P2 — a schedule's reach IS its campaign snapshot; with a market filter live, saying which
    // markets a row spans is what keeps the filter legible.
    {
      key: 'markets', label: 'Markets', metric: false, sortable: true,
      sortValue: (r) => r.markets.join(','),
      render: (r) => (r.markets.length ? r.markets.join(', ') : <span className="h10-bs-unknown" title="This schedule's campaign snapshot carries no marketplace, so its reach is unknown — it is never hidden by a market filter.">unknown</span>),
    },
    { key: 'days', label: 'Days', metric: false, sortable: false, render: (r) => r.days },
    // BSP.2 (§2.3) — the Auto Refill column is GONE, not relabelled: `autoRefill` has zero
    // readers anywhere in api or web, the builder never sends it, and a column that is
    // permanently "Off" and would mean nothing "On" is a promise the object cannot keep.
    { key: 'startDate', label: 'Start Date', metric: false, sortable: true, render: (r) => r.startDate },
    { key: 'endDate', label: 'End Date', metric: false, sortable: true, render: (r) => r.endDate },
    // §2.2 — these two now render REAL values: the route stopped hard-coding nulls and returns
    // the first stored blackout range (rows that stored the old boolean fall through to none).
    // BSP-P4 — the grid has two columns and a schedule may hold many blackout ranges. Showing the
    // first and dropping the count read as "there is one"; the extras are now named.
    { key: 'excludeStart', label: 'Exclude Start Date', metric: false, sortable: false, render: (r) => r.excludeStart },
    {
      key: 'excludeEnd', label: 'Exclude End Date', metric: false, sortable: false,
      render: (r) => (
        <>
          {r.excludeEnd}
          {r.excludeRanges > 1 && (
            <HoverCard text={`This schedule has ${r.excludeRanges} blackout ranges. The grid has room for the first; open the schedule to see them all.`} placement="below">
              <span className="h10-bs-more"> +{r.excludeRanges - 1}</span>
            </HoverCard>
          )}
        </>
      ),
    },
  ], [todayIso, toggleEnabled])

  const renderFirst = (r: ScheduleRow): ReactNode => (
    <span className="h10-nt-namew">
      <a className="h10-nt-name" href={`/marketing/ads/rules-automation/builder/budget-schedule?scheduleId=${r.id}`}>{r.name}</a>
      <a className="h10-nt-open" href={`/marketing/ads/rules-automation/builder/budget-schedule?scheduleId=${r.id}`}><ExternalLink size={11} /> Open</a>
    </span>
  )

  const newSchedule = () => router.push('/marketing/ads/rules-automation/builder/budget-schedule')

  /**
   * 🔴 The fix for :67. Two changes, and the second is the one that mattered:
   *   · confirm before deleting — this is destructive and had no gate at all;
   *   · a row is removed ONLY if its DELETE actually succeeded. A schedule that is still on the
   *     server must still be on the screen, or the next page load resurrects it and the operator
   *     learns not to trust the grid.
   */
  const deleteSchedules = async (ids: string[]) => {
    const n = ids.length
    if (!window.confirm(`Delete ${n} budget schedule${n === 1 ? '' : 's'}? This cannot be undone.`)) return
    setDeleteErr(null)
    const results = await Promise.all(ids.map(async (id) => {
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/budget-schedules/${id}`, { method: 'DELETE' })
        return { id, ok: r.ok, status: r.status }
      } catch {
        return { id, ok: false, status: 0 }
      }
    }))
    const gone = results.filter((r) => r.ok).map((r) => r.id)
    const failed = results.filter((r) => !r.ok)
    if (gone.length) setRows((rs) => rs.filter((r) => !gone.includes(r.id)))
    setSel(new Set(failed.map((f) => f.id)))
    if (failed.length) {
      const one = failed[0]
      setDeleteErr(
        `${failed.length} of ${n} could not be deleted and ${failed.length === 1 ? 'is' : 'are'} still here` +
        `${one.status ? ` (the server answered ${one.status})` : ' (the request did not reach the server)'}.`,
      )
    }
  }

  // The `broke` state of the shared vocabulary. It replaces the grid rather than sitting above an
  // empty one, because an empty grid beside an error still reads as "you have no schedules".
  if (!loading && err) {
    return (
      <SectionEmpty
        kind="broke"
        noun="budget schedules"
        error={err}
      />
    )
  }

  return (
    <>
      {/* BSP-P5 — the census strip, above the work. Renders nothing if its fetch fails. */}
      <ScheduleContextStrip market={market} />

      <div className="h10-sb-listchart">
        <div className="hd">
          <b>Hourly Campaign Performance</b>
          <HoverCard text="Spend, ACoS and other metrics by hour of day or day of week — use it to decide when to raise or lower budgets. Read over the last 60 days, in the account timezone." placement="below"><span className="i" aria-hidden="true"><Info size={14} /></span></HoverCard>
        </div>
        {chartOpen && (
          <div className="bd">
            <div className="controls">
              <MetricSelect value={metric1} onChange={setMetric1} dot="#0b2447" label="Metric 1" />
              {/* BSP-B3 — "Weekday × Hour" is the 7×24 grid, and the consumer the `cell` grain
                  was missing. Shares GROUP_BY with the builder plus this tab's own third option. */}
              <H10Select
                width={190}
                options={[...GROUP_BY, { value: 'cell', label: 'Weekday × Hour' }]}
                value={groupBy}
                onChange={(v) => setGroupBy(v === 'weekday' ? 'weekday' : v === 'cell' ? 'cell' : 'hour')}
                ariaLabel="Group by"
              />
              <span className="grow" />
              {/* A grid is a single-metric view: Metric 2 has nowhere to go on a heatmap, so it is
                  hidden rather than left showing a value the picture does not contain. */}
              {groupBy !== 'cell' && <MetricSelect value={metric2} onChange={setMetric2} dot="#1f6fde" label="Metric 2" />}
            </div>
            {/* U8 — was the constant "Hourly data is not available for this marketplace." with two
                metric pickers that changed nothing. The card reads the endpoint now; that sentence
                still renders, but only when the endpoint says `hasData: false`. */}
            <HourlyPerformanceCard metric1={metric1} metric2={metric2} market={market} groupBy={groupBy} />
          </div>
        )}
      </div>

      {deleteErr && <p className="h10-bsp-note bad"><span>{deleteErr}</span></p>}
      {toggleErr && <p className="h10-bsp-note bad"><span>{toggleErr}</span></p>}

      <AdsDataGrid<ScheduleRow>
        rows={rows}
        loading={loading}
        rowId={(r) => r.id}
        noun="Schedule"
        firstColLabel="Budget Schedule Name"
        renderFirst={renderFirst}
        firstSortValue={(r) => r.name}
        columns={columns}
        selectable
        selected={sel}
        onSelectedChange={setSel}
        selectionActions={(ids) => (
          <span className="h10-bulkrow">
            <Button variant="ghost" onClick={() => deleteSchedules(ids)}><Trash2 size={13} /> Delete</Button>
          </span>
        )}
        customizable={false}
        searchable
        searchPlaceholder="Search schedules…"
        searchValue={(r) => r.name}
        pagerCentered
        defaultSort={{ key: 'startDate', dir: 'desc' }}
        emptyLabel={scope && total > 0
          ? `No budget schedules reach ${scope} — ${total} exist${total === 1 ? 's' : ''} on other markets`
          : 'No budget schedules yet'}
        toolbarRight={<>
          <button type="button" className="h10-sb-eye" aria-label={chartOpen ? 'Hide hourly chart' : 'Show hourly chart'} aria-pressed={chartOpen} onClick={() => setChartOpen((v) => !v)}>{chartOpen ? <Eye size={17} /> : <EyeOff size={17} />}</button>
          {/* 🔴 The fix for :120 — the noun on this page is Schedule. */}
     <Button variant="primary" onClick={newSchedule}><Plus size={13} /> Schedule</Button>
        </>}
      />
    </>
  )
}
