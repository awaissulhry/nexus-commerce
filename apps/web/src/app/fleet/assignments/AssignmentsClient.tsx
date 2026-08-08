'use client'

/**
 * NAF.SB.AS / AS.1 — the assignments list, the state strip, and Create.
 * NAF.SB.AS-S1R / S1.a — the list rebuilt on the DS DataGrid.
 *
 * The page's one sentence: point one worker at one named thing, say what you
 * want back, and watch that single job through to what it found.
 *
 * Rules this file exists to keep:
 *
 *  1. Every tile label, chip label, tooltip and filter predicate comes from
 *     `./states`. A tile that says a word its rows do not say is the defect
 *     most likely to ship here, so the words have exactly one home.
 *  2. The list NEVER joins against /agent/fleet/runs to find its runs. That
 *     feed is capped at 100 server-side and is global, so an assignment older
 *     than the newest 100 fleet runs would render "never run" when it had.
 *     The server folds the rollup into the list payload instead.
 *  3. **The substrate is the shared DS DataGrid** (S1.a, study Part 11.4).
 *     Measured reasons, not taste: on `acr-pg-tbl` 41.8% of the table's width
 *     was allocated by text length rather than importance (POINTS AT ran 3.43×
 *     its widest content), the header is `position: static` so it scrolled to
 *     y=-515 and never came back, and the only click target in a row was the
 *     title anchor at 5.4% of the row's area. `table-layout: fixed` with
 *     declared widths fixes the first, DataGrid's sticky header the second, a
 *     block-level anchor filling its cell the third.
 *  4. **No cell wraps.** One line each, ellipsis, and the full value in the
 *     tooltip. That is what makes row height uniform at every width — the
 *     shipped table varied 34% down one list at 896px.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Plus, RefreshCw, Target, AlertTriangle, Layers, Globe } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { DataGrid, type Column } from '@/design-system/components'
import { GridToolbar } from '@/design-system/patterns'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { useVisibilityPoll } from '../_shared/use-visibility-poll'
import { ago } from '../_shared/run-health'
import {
  ASSIGNMENT_STATES,
  TILE_ORDER,
  errorSentence,
  outcomeLine,
  reasonSentence,
  stateDef,
  type AssignmentState,
} from './states'
// AS.4 — the counts and the filter come from ONE module, proven to agree by
// assignments.vitest. A page that recomputed either would make the test a
// statement about code nobody runs.
import { closedCount, tileCounts, visibleRows } from './views'
import { CreateAssignment } from './CreateAssignment'
import { HowAssignmentsWork } from './HowAssignmentsWork'

export interface AssignmentRow {
  id: string
  charterKey: string
  title: string
  targetKind: string | null
  targetIds: string[]
  targetLabels: string[]
  wantBack: string | null
  dueAt: string | null
  state: AssignmentState
  runCount: number
  findingCount: number
  costUSD: number
  hasUnknownCost: boolean
  createdAt: string
  lastRun: {
    id: string
    ok: boolean
    status: string
    haltedReason: string | null
    errorMessage: string | null
    createdAt: string
  } | null
}

/**
 * The four widths this list is designed at, and what each one drops.
 *
 * Media queries, never an element-width probe — an element probe never fires a
 * media query, which is a trap another fleet stream paid for. AS-S1's own rule
 * is that the state chip, the title and the delta are the row's identity and
 * never drop; When and Due go first, and the target collapses into the title
 * line last rather than disappearing.
 */
type Width = 'xl' | 'lg' | 'md' | 'sm'

function useWidth(): Width {
  // Server and first client render must agree, so both start at `xl` and the
  // effect corrects on mount.
  const [w, setW] = useState<Width>('xl')
  useEffect(() => {
    const read = () => {
      const px = window.innerWidth
      setW(px >= 1400 ? 'xl' : px >= 1100 ? 'lg' : px >= 900 ? 'md' : 'sm')
    }
    read()
    const qs = [
      window.matchMedia('(min-width: 1400px)'),
      window.matchMedia('(min-width: 1100px)'),
      window.matchMedia('(min-width: 900px)'),
    ]
    qs.forEach((q) => q.addEventListener('change', read))
    return () => qs.forEach((q) => q.removeEventListener('change', read))
  }, [])
  return w
}

/**
 * "Needs you" order, negated.
 *
 * DataGrid's first click on a header sorts DESCENDING, so the value is negated
 * to make that first click show the rows that want attention rather than the
 * ones that are finished with.
 */
const NEEDS_YOU: Record<AssignmentState, number> = {
  failed: 0,
  stopped: 1,
  abandoned: 2,
  finished: 3,
  not_started: 4,
  running: 5,
  closed: 6,
  cancelled: 7,
}

export function AssignmentsClient() {
  const [rows, setRows] = useState<AssignmentRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<AssignmentState | null>(null)
  const [showClosed, setShowClosed] = useState(false)
  const [creating, setCreating] = useState(false)
  const width = useWidth()
  /**
   * NAF.SB.AS.2 — the deep link from the object the operator was standing on.
   * `/fleet/assignments?new=1&targetKind=CAMPAIGN&targetId=…&targetLabel=…`
   * opens the drawer with the target already chosen, so an operator looking at
   * a campaign never has to come here and re-find it among 220.
   *
   * A URL carries none of this page's rules across the boundary — which is why
   * the campaigns grid links rather than importing anything of ours.
   */
  const [prefill, setPrefill] = useState<
    { kind: 'CAMPAIGN' | 'MARKETPLACE' | 'PORTFOLIO'; id: string; label: string } | null
  >(null)

  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (q.get('new') !== '1') return
    const kind = q.get('targetKind')
    const id = q.get('targetId')
    if (kind === 'CAMPAIGN' || kind === 'MARKETPLACE' || kind === 'PORTFOLIO') {
      if (id) setPrefill({ kind, id, label: q.get('targetLabel') || id })
    }
    setCreating(true)
    // Consume the params so a refresh does not reopen the drawer, and so the
    // URL the operator might copy is the plain page.
    window.history.replaceState({}, '', window.location.pathname)
  }, [])

  const load = useCallback(async () => {
    const res = await fetch(`${getBackendUrl()}/api/agent/fleet/assignments`, {
      cache: 'no-store',
      credentials: 'include',
    })
    if (!res.ok) throw new Error(`assignments: ${res.status}`)
    const j = (await res.json()) as { assignments: AssignmentRow[] }
    setRows(j.assignments)
    setError(null)
  }, [])

  const { asOf, refresh } = useVisibilityPoll(
    useCallback(async () => {
      try {
        await load()
      } catch (e) {
        setError(String(e))
        throw e
      }
    }, [load]),
  )

  const counts = useMemo(() => tileCounts(rows ?? []), [rows])
  const closed = useMemo(() => closedCount(rows ?? []), [rows])
  const visible = useMemo(
    () => visibleRows(rows ?? [], { filter, showClosed }),
    [rows, filter, showClosed],
  )

  /** What everything on screen has cost, and what we cannot know. */
  const spend = useMemo(() => {
    const total = visible.reduce((s, a) => s + (a.costUSD || 0), 0)
    const unknown = visible.filter((a) => a.hasUnknownCost).length
    return { total, unknown }
  }, [visible])

  const columns = useMemo<Array<Column<AssignmentRow>>>(() => {
    const cols: Array<Column<AssignmentRow>> = [
      {
        key: 'state',
        label: (
          <span title="Where this job got to. Eight states — hover any chip for what it means and what to do about it.">
            State
          </span>
        ),
        width: 132,
        sortable: true,
        sortValue: (a) => -(NEEDS_YOU[a.state] ?? 9),
        render: (a) => {
          const def = stateDef(a.state)
          return (
            <span className={`as-chip ${def.tone}`} title={def.tip}>
              <span className="as-dot" />
              {def.label}
            </span>
          )
        },
      },
      {
        key: 'title',
        label: (
          <span title="The name given when this was made — the worker, and what it points at. You can rename it on its own page.">
            Assignment
          </span>
        ),
        sortable: true,
        sortValue: (a) => a.title.toLowerCase(),
        render: (a) => (
          <Link
            href={`/fleet/assignments/${a.id}`}
            className="as-titlelink"
            title={a.wantBack ? `${a.title}\n\nWhat you asked for: ${a.wantBack}` : a.title}
          >
            <span className="nm">{a.title}</span>
            {/* Below 900px the target and the deadline have no column of their
                own, so they ride the title line rather than vanishing — the
                row's identity is the chip, the title and the delta. Every row
                gets this second line at that width, so height stays uniform. */}
            {width === 'sm' || (width === 'md' && a.dueAt) ? (
              <span className="sub">
                {width === 'sm' ? <TargetChip a={a} inline /> : null}
                {a.dueAt ? <DueBadge dueAt={a.dueAt} /> : null}
              </span>
            ) : null}
          </Link>
        ),
      },
    ]

    if (width !== 'sm') {
      cols.push({
        key: 'target',
        label: (
          <span title="The one thing this worker is allowed to look at. Everything else in your account is out of scope for this job.">
            Points at
          </span>
        ),
        width: 300,
        sortable: true,
        sortValue: (a) => (a.targetLabels[0] ?? a.targetIds[0] ?? '~').toLowerCase(),
        render: (a) => <TargetChip a={a} />,
      })
    }

    cols.push({
      key: 'last',
      label: (
        <span title="What came back the last time it ran. An assignment can be run many times; each attempt keeps its own result, cost and reason.">
          Last run
        </span>
      ),
      width: 240,
      sortable: true,
      sortValue: (a) => -(NEEDS_YOU[a.state] ?? 9) * 1000 - a.findingCount,
      render: (a) => <DeltaCell a={a} />,
    })

    if (width === 'xl') {
      cols.push({
        key: 'when',
        label: <span title="When the last attempt started.">When</span>,
        width: 104,
        align: 'right',
        sortable: true,
        // Never-run rows sort last in both directions: they have no "when".
        sortValue: (a) => (a.lastRun ? Date.parse(a.lastRun.createdAt) : 0),
        render: (a) =>
          a.lastRun ? (
            <span className="as-when" title={new Date(a.lastRun.createdAt).toLocaleString()}>
              {ago(a.lastRun.createdAt)}
            </span>
          ) : (
            <span className="as-when muted" title="It has never run.">
              —
            </span>
          ),
      })
    }

    if (width === 'xl' || width === 'lg') {
      cols.push({
        key: 'due',
        label: (
          <span title="A deadline you set. It colours the row and moves it up the list. It never starts anything and never stops anything.">
            Due
          </span>
        ),
        width: 96,
        sortable: true,
        sortValue: (a) => (a.dueAt ? Date.parse(a.dueAt) : Number.MAX_SAFE_INTEGER),
        render: (a) => <DueBadge dueAt={a.dueAt} />,
      })
    }

    return cols
  }, [width])

  if (error && !rows) {
    return (
      <div className="as-page">
        <div className="acr-pg-empty">
          <AlertTriangle size={18} />
          <p>Could not load assignments.</p>
          <p className="acr-pg-muted">{error}</p>
          <button className="acr-pg-sortbtn" onClick={refresh}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  const hasAny = (rows?.length ?? 0) > 0

  return (
    <div className="as-page">
      <p className="acr-pg-intro">
        An <Term k="assignment">assignment</Term> is one{' '}
        <Term k="worker">worker</Term> pointed at one{' '}
        <Term k="target">target</Term> — a campaign, or a marketplace — with a
        note about what you want back. Nothing starts on its own: every worker
        in this fleet is switched off, so an assignment waits here until you
        start it. <HowAssignmentsWork />
      </p>

      {/* ── the strip. Every tile is a filter over the list below it. ── */}
      <div className="acr-pg-strip" role="group" aria-label="Filter by state">
        {TILE_ORDER.map((k) => {
          const def = ASSIGNMENT_STATES[k]
          const n = counts[k] ?? 0
          const on = filter === k
          return (
            <button
              key={k}
              type="button"
              className="acr-pg-stat as-tile"
              aria-pressed={on}
              title={`${def.tip}\n\nClick to show only these.`}
              onClick={() => setFilter(on ? null : k)}
            >
              <span className="k">{def.label}</span>
              <span className="v">{n}</span>
            </button>
          )
        })}
      </div>

      {closed > 0 && (
        <p className="as-remainder">
          Showing open assignments — {counts.closed ?? 0} closed,{' '}
          {counts.cancelled ?? 0} cancelled.{' '}
          <button type="button" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? 'Hide them' : 'Show them'}
          </button>
        </p>
      )}

      {rows === null ? (
        <div className="acr-pg-empty">
          <p className="acr-pg-muted">Loading…</p>
        </div>
      ) : !hasAny ? (
        /* Never had data. The teaching panel renders INSTEAD of the grid card:
           a toolbar and a header row above nothing is chrome around nothing. */
        <EmptyState onCreate={() => setCreating(true)} />
      ) : (
        <div className="h10-ds-gridcard as-gridcard">
          <GridToolbar
            count={
              <>
                Showing <b>{visible.length}</b> of <b>{rows.length}</b> assignment
                {rows.length === 1 ? '' : 's'}
                {' · '}
                <span
                  title={
                    spend.unknown > 0
                      ? `What every assignment shown here has cost in model calls. ${spend.unknown} run${spend.unknown === 1 ? '' : 's'} stopped reporting and its cost cannot be known — left out rather than counted as zero.`
                      : 'What every assignment shown here has cost in model calls.'
                  }
                >
                  <b>${spend.total.toFixed(2)}</b> spent{spend.unknown > 0 ? '*' : ''}
                </span>
                {rows.length >= 200 ? (
                  <span
                    className="as-cap"
                    title="This list shows the newest 200 assignments. Older ones exist and are not listed."
                  >
                    {' · newest 200'}
                  </span>
                ) : null}
              </>
            }
            right={
              <>
                <span
                  className="as-order"
                  title="The default order: anything overdue first, then newest. Click a column header to sort by it instead."
                >
                  overdue first, then newest
                </span>
                <span
                  className="as-asof"
                  title="The time of the last successful read. The page refreshes itself about every 10 seconds while this tab is visible."
                >
                  {asOf ? `as of ${asOf.toLocaleTimeString()}` : 'loading…'}
                </span>
                <button className="acr-btn" onClick={refresh} aria-label="Refresh now" title="Read it again now">
                  <RefreshCw size={13} />
                </button>
                <button className="acr-btn" onClick={() => setCreating(true)}>
                  <Plus size={13} /> New assignment
                </button>
              </>
            }
          />
          <DataGrid<AssignmentRow>
            columns={columns}
            rows={visible}
            rowKey={(a) => a.id}
            maxHeight="calc(100vh - 22rem)"
            emptyState={
              <FilteredEmpty
                filter={filter}
                total={rows.length}
                onClear={() => {
                  setFilter(null)
                  setShowClosed(true)
                }}
                onCreate={() => setCreating(true)}
              />
            }
          />
        </div>
      )}

      {creating && (
        <CreateAssignment
          prefill={prefill}
          onClose={() => {
            setCreating(false)
            setPrefill(null)
          }}
          onCreated={() => {
            setCreating(false)
            setPrefill(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

/**
 * The delta — one short phrase, never a spinner and never a percentage.
 *
 * The tooltip carries the full sentence with the fix in it, which `states.ts`
 * already writes for every guard the executor can emit. Before S1.a those
 * sentences existed and the list never showed them.
 */
function DeltaCell({ a }: { a: AssignmentRow }) {
  const text = outcomeLine(a)
  let tip: string | null = null
  if (a.state === 'stopped' || a.state === 'abandoned') {
    tip = reasonSentence(a.lastRun?.haltedReason)
  } else if (a.state === 'failed') {
    tip = errorSentence(a.lastRun?.errorMessage)
  } else if (a.state === 'not_started') {
    tip = 'Nothing has run. Nothing will start it but you — every worker in this fleet is switched off.'
  } else if (a.state === 'running') {
    tip = 'A run is open right now. There is nothing to press: it ends on its own, on a budget, or is closed after two hours if it stops reporting.'
  } else if (a.findingCount === 0) {
    tip = 'It ran, read the evidence, and judged that nothing needed doing. That is a result, not a failure.'
  } else {
    tip = `${a.findingCount} thing${a.findingCount === 1 ? '' : 's'} this worker judged worth your attention. Open it to read them — nothing has been changed on Amazon.`
  }
  return (
    <span className={`as-outcome${a.runCount === 0 ? ' muted' : ''}`} title={tip ?? undefined}>
      {text}
    </span>
  )
}

function TargetChip({ a, inline }: { a: AssignmentRow; inline?: boolean }) {
  if (!a.targetKind) {
    return (
      <span
        className={`as-target account${inline ? ' inline' : ''}`}
        title="This worker reads the whole account every time — it has no way to be narrowed."
      >
        <Globe size={11} />
        the whole account
      </span>
    )
  }
  const label = a.targetLabels.join(', ') || a.targetIds.join(', ')
  const ids = a.targetIds.join(', ')
  // The id lives in the tooltip, not the cell. Ids exist to survive renames,
  // which is a correctness concern, not a reading one.
  //
  // S1.a — three kinds, three sentences. AS.2 shipped PORTFOLIO and this
  // ternary had only a CAMPAIGN branch, so every portfolio row called itself a
  // marketplace: a false sentence about the object, on the page whose whole
  // subject is what the object points at.
  const tip =
    a.targetKind === 'CAMPAIGN'
      ? `${label} — campaign ${ids}. The name was frozen when you made this, so a rename cannot quietly relabel your history.`
      : a.targetKind === 'PORTFOLIO'
        ? `${label} — portfolio ${ids}, resolved to its member campaigns each time it runs. A campaign added to the portfolio tomorrow is in scope tomorrow.`
        : `Marketplace ${label} — everything in your account for that marketplace.`
  const Icon = a.targetKind === 'PORTFOLIO' ? Layers : a.targetKind === 'MARKETPLACE' ? Globe : Target
  return (
    <span className={`as-target${inline ? ' inline' : ''}`} title={tip}>
      <Icon size={11} />
      {label}
    </span>
  )
}

function DueBadge({ dueAt }: { dueAt: string | null }) {
  if (!dueAt) return <span className="as-due none">—</span>
  const d = new Date(dueAt)
  const days = Math.ceil((d.getTime() - Date.now()) / 86400_000)
  const cls = days < 0 ? 'over' : days <= 2 ? 'soon' : 'later'
  const text =
    days < 0 ? `${Math.abs(days)}d late` : days === 0 ? 'today' : `in ${days}d`
  return (
    <span
      className={`as-due ${cls}`}
      title={`Due ${d.toLocaleDateString()}. A due date only colours this row and moves it up the list — it never starts anything and never stops anything.`}
    >
      {text}
    </span>
  )
}

/**
 * Filtered to nothing — and it NAMES what is filtered.
 *
 * "Nothing matches that filter" was ambiguous between three different things
 * on a page with six state chips and a hidden closed set.
 */
function FilteredEmpty({
  filter,
  total,
  onClear,
  onCreate,
}: {
  filter: AssignmentState | null
  total: number
  onClear: () => void
  onCreate: () => void
}) {
  if (filter) {
    return (
      <div className="as-gridempty">
        <strong>No assignments are {stateDef(filter).label.toLowerCase()}.</strong>
        <button className="acr-btn" onClick={onClear}>
          Show all {total}
        </button>
      </div>
    )
  }
  // Nothing open, but rows exist — a finished list, not an empty one.
  return (
    <div className="as-gridempty">
      <strong>Nothing open.</strong>
      <span>Everything you made has been closed or cancelled.</span>
      <span className="as-gridempty-acts">
        <button className="acr-btn" onClick={onClear}>
          Show them
        </button>
        <button className="acr-btn" onClick={onCreate}>
          <Plus size={13} /> New assignment
        </button>
      </span>
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="acr-pg-empty as-empty">
      <Target size={22} className="as-emptyicon" />
      <strong>No assignments yet.</strong>
      <p className="as-emptybody">
        An assignment is one worker pointed at one thing — a campaign, or a
        marketplace — with a note about what you want back. Make one and it will
        sit here until you start it. Nothing starts on its own:{' '}
        <Link href="/fleet/controls">every worker in this fleet is switched off</Link>.
      </p>
      <p className="as-emptybody">
        Some workers read your whole account every time and cannot be pointed at
        one thing. Run those from <Link href="/fleet/workers">Workers</Link>.
      </p>
      <button className="acr-btn" onClick={onCreate}>
        <Plus size={13} /> New assignment
      </button>
    </div>
  )
}
