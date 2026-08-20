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
 * W4 also added the Status column (toggle + Scheduled/Active/Completed/Off pill — the API's
 * `enabled` used to be dropped on the floor here, leaving a live schedule indistinguishable from
 * a disabled one and no way to stop one short of deleting it), and the DELETE/disable routes now
 * restore base budgets (before that, deleting a schedule mid-window left the boost in place
 * forever). Still absent, deliberately, pending operator decisions: Amazon-event presets (BSP.5),
 * auto-refill (a write-only column with no executor semantics), and precedence between the five
 * dailyBudget writers (BSP.6).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Eye, EyeOff, Info, ExternalLink, Trash2 } from 'lucide-react'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { HoverCard } from '../../campaigns/FilterDropdown'
import { MetricSelect } from '../_schedule/MetricSelect'
import { HourlyPerformanceCard } from './HourlyPerformanceCard'
import { getBackendUrl } from '@/lib/backend-url'
import { SectionEmpty } from './SectionShell'

/** W4 — `autoRefill` dropped (dead client state since BSP.2 removed its column); `enabled` added
 *  (the API always returned it; nothing read it). */
interface ScheduleRow { id: string; name: string; type: string; days: string; enabled: boolean; startDate: string; endDate: string; excludeStart: string; excludeEnd: string }

/** Scheduled / Active / Completed / Off — derived, because no status field exists to drift from.
 *  ISO date strings compare correctly as strings; '—' means "no bound on this side". */
function scheduleStatus(r: ScheduleRow, todayIso: string): { word: string; cls: string; why: string } {
  if (!r.enabled) return { word: 'Off', cls: 'off', why: 'Paused — the executor skips this schedule and campaigns hold their base budgets.' }
  if (r.startDate !== '—' && r.startDate > todayIso) return { word: 'Scheduled', cls: 'bs-sched', why: `Starts ${r.startDate}. Until then, nothing is changed.` }
  if (r.endDate !== '—' && r.endDate < todayIso) return { word: 'Completed', cls: 'bs-done', why: `Ended ${r.endDate}. Budgets have been restored to base.` }
  return { word: 'Active', cls: 'bs-active', why: 'In its date range — the weekly windows decide each campaign’s budget right now.' }
}

const TYPE_LABEL: Record<string, string> = { 'campaign-budget': 'Campaign Budget', 'budget-multiplier': 'Budget Multiplier' }

export function SchedulesSection() {
  const router = useRouter()
  const [rows, setRows] = useState<ScheduleRow[]>([])
  const [loading, setLoading] = useState(true)
  // 🔴 The fix for :42. A fetch that threw is a different fact from an account with no schedules,
  // and the operator has to be able to tell them apart.
  const [err, setErr] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [metric1, setMetric1] = useState('Spend')
  const [metric2, setMetric2] = useState('ACoS')
  const [chartOpen, setChartOpen] = useState(true)
  const [deleteErr, setDeleteErr] = useState<string | null>(null)
  const [toggleErr, setToggleErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/budget-schedules`, { cache: 'no-store' })
        if (!r.ok) throw new Error(`The schedules request failed (${r.status}).`)
        const j = await r.json()
        const items = (Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : []) as Array<Record<string, unknown>>
        if (alive) {
          setErr(null)
          setRows(items.map((s) => ({
            id: String(s.id), name: String(s.name ?? ''), type: TYPE_LABEL[String(s.type ?? '')] ?? String(s.type ?? '—'),
            days: String(s.days ?? '—'), enabled: s.enabled !== false,
            startDate: s.startDate ? String(s.startDate) : '—', endDate: s.endDate ? String(s.endDate) : '—',
            excludeStart: s.excludeStart ? String(s.excludeStart) : '—', excludeEnd: s.excludeEnd ? String(s.excludeEnd) : '—',
          })))
        }
      } catch (e) {
        if (alive) { setErr((e as Error).message); setRows([]) }
      } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])

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

  const todayIso = new Date().toISOString().slice(0, 10)
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
    { key: 'type', label: 'Type', metric: false, sortable: true, render: (r) => r.type },
    { key: 'days', label: 'Days', metric: false, sortable: false, render: (r) => r.days },
    // BSP.2 (§2.3) — the Auto Refill column is GONE, not relabelled: `autoRefill` has zero
    // readers anywhere in api or web, the builder never sends it, and a column that is
    // permanently "Off" and would mean nothing "On" is a promise the object cannot keep.
    { key: 'startDate', label: 'Start Date', metric: false, sortable: true, render: (r) => r.startDate },
    { key: 'endDate', label: 'End Date', metric: false, sortable: true, render: (r) => r.endDate },
    // §2.2 — these two now render REAL values: the route stopped hard-coding nulls and returns
    // the first stored blackout range (rows that stored the old boolean fall through to none).
    { key: 'excludeStart', label: 'Exclude Start Date', metric: false, sortable: false, render: (r) => r.excludeStart },
    { key: 'excludeEnd', label: 'Exclude End Date', metric: false, sortable: false, render: (r) => r.excludeEnd },
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
      <div className="h10-sb-listchart">
        <div className="hd">
          <b>Hourly Campaign Performance</b>
          <HoverCard text="Spend, ACoS and other metrics by hour of day — use it to decide when to raise or lower budgets." placement="below"><span className="i" aria-hidden="true"><Info size={14} /></span></HoverCard>
        </div>
        {chartOpen && (
          <div className="bd">
            <div className="controls">
              <MetricSelect value={metric1} onChange={setMetric1} dot="#0b2447" label="Metric 1" />
              <span className="grow" />
              <MetricSelect value={metric2} onChange={setMetric2} dot="#1f6fde" label="Metric 2" />
            </div>
            {/* U8 — was the constant "Hourly data is not available for this marketplace." with two
                metric pickers that changed nothing. The card reads the endpoint now; that sentence
                still renders, but only when the endpoint says `hasData: false`. */}
            <HourlyPerformanceCard metric1={metric1} metric2={metric2} />
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
            <button type="button" className="h10-am-btn bulk" onClick={() => deleteSchedules(ids)}><Trash2 size={13} /> Delete</button>
          </span>
        )}
        customizable={false}
        searchable
        searchPlaceholder="Search schedules…"
        searchValue={(r) => r.name}
        pagerCentered
        defaultSort={{ key: 'startDate', dir: 'desc' }}
        emptyLabel="No budget schedules yet"
        toolbarRight={<>
          <button type="button" className="h10-sb-eye" aria-label={chartOpen ? 'Hide hourly chart' : 'Show hourly chart'} aria-pressed={chartOpen} onClick={() => setChartOpen((v) => !v)}>{chartOpen ? <Eye size={17} /> : <EyeOff size={17} />}</button>
          {/* 🔴 The fix for :120 — the noun on this page is Schedule. */}
          <button type="button" className="h10-am-btn primary" onClick={newSchedule}><Plus size={13} /> Schedule</button>
        </>}
      />
    </>
  )
}
