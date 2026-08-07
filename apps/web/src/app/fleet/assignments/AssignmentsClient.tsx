'use client'

/**
 * NAF.SB.AS / AS.1 — the assignments list, the state strip, and Create.
 *
 * The page's one sentence: point one worker at one named thing, say what you
 * want back, and watch that single job through to what it found.
 *
 * Two rules this file exists to keep:
 *
 *  1. Every tile label, chip label, tooltip and filter predicate comes from
 *     `./states`. A tile that says a word its rows do not say is the defect
 *     most likely to ship here, so the words have exactly one home.
 *  2. The list NEVER joins against /agent/fleet/runs to find its runs. That
 *     feed is capped at 100 server-side and is global, so an assignment older
 *     than the newest 100 fleet runs would render "never run" when it had.
 *     The server folds the rollup into the list payload instead.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Plus, RefreshCw, Target, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { useVisibilityPoll } from '../_shared/use-visibility-poll'
import { ago } from '../_shared/run-health'
import {
  ASSIGNMENT_STATES,
  TILE_ORDER,
  outcomeLine,
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

export function AssignmentsClient() {
  const [rows, setRows] = useState<AssignmentRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<AssignmentState | null>(null)
  const [showClosed, setShowClosed] = useState(false)
  const [creating, setCreating] = useState(false)
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

  if (error && !rows) {
    return (
      <div className="acr-pg-empty">
        <AlertTriangle size={18} />
        <p>Could not load assignments.</p>
        <p className="acr-pg-muted">{error}</p>
        <button className="acr-pg-sortbtn" onClick={refresh}>
          Try again
        </button>
      </div>
    )
  }

  return (
    <>
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
              title={def.tip}
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

      <div className="acr-pg-toolbar">
        <button className="acr-pg-sortbtn" onClick={() => setCreating(true)}>
          <Plus size={14} /> New assignment
        </button>
        <span style={{ flex: 1 }} />
        <span className="acr-pg-muted" title="The time of the last successful read. The page refreshes itself about every 10 seconds while this tab is visible.">
          {asOf ? `as of ${asOf.toLocaleTimeString()}` : 'loading…'}
        </span>
        <button className="acr-pg-sortbtn" onClick={refresh} aria-label="Refresh now">
          <RefreshCw size={13} />
        </button>
      </div>

      {rows === null ? (
        <div className="acr-pg-empty">
          <p className="acr-pg-muted">Loading…</p>
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          hasAny={(rows?.length ?? 0) > 0}
          filtered={!!filter || (!showClosed && closed > 0)}
          onClear={() => {
            setFilter(null)
            setShowClosed(true)
          }}
          onCreate={() => setCreating(true)}
        />
      ) : (
        <div className="acr-pg-tablewrap">
          <table className="acr-pg-tbl">
            <thead>
              <tr>
                <th>State</th>
                <th>Assignment</th>
                <th>Points at</th>
                <th>Last run</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <Row key={a.id} a={a} />
              ))}
            </tbody>
          </table>
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
    </>
  )
}

function Row({ a }: { a: AssignmentRow }) {
  const def = stateDef(a.state)
  const outcome = outcomeLine(a)
  return (
    <tr>
      <td>
        <span className={`as-chip ${def.tone}`} title={def.tip}>
          <span className="as-dot" />
          {def.label}
        </span>
      </td>
      <td>
        <span className="as-title">
          <Link href={`/fleet/assignments/${a.id}`}>{a.title}</Link>
        </span>
        {a.wantBack && (
          <span className="as-want" title={a.wantBack}>
            {a.wantBack}
          </span>
        )}
      </td>
      <td>
        <TargetChip a={a} />
      </td>
      <td>
        <span className={`as-outcome${a.runCount === 0 ? ' muted' : ''}`}>{outcome}</span>
        {a.lastRun && (
          <span className="as-want" style={{ marginTop: 1 }}>
            {ago(a.lastRun.createdAt)}
            {a.costUSD > 0 ? ` · $${a.costUSD.toFixed(4)}` : ''}
          </span>
        )}
      </td>
      <td>
        <DueBadge dueAt={a.dueAt} />
      </td>
    </tr>
  )
}

function TargetChip({ a }: { a: AssignmentRow }) {
  if (!a.targetKind) {
    return (
      <span
        className="as-target account"
        title="This worker reads the whole account every time — it has no way to be narrowed."
      >
        the whole account
      </span>
    )
  }
  const label = a.targetLabels.join(', ') || a.targetIds.join(', ')
  // The id lives in the tooltip, not the cell. Ids exist to survive renames,
  // which is a correctness concern, not a reading one.
  const tip =
    a.targetKind === 'CAMPAIGN'
      ? `${label} — campaign ${a.targetIds.join(', ')}. The name was frozen when you made this, so a rename cannot quietly relabel your history.`
      : `Marketplace ${label}.`
  return (
    <span className="as-target" title={tip}>
      <Target size={11} />
      {label}
    </span>
  )
}

function DueBadge({ dueAt }: { dueAt: string | null }) {
  if (!dueAt) return <span className="acr-pg-muted">—</span>
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

function EmptyState({
  hasAny,
  filtered,
  onClear,
  onCreate,
}: {
  hasAny: boolean
  filtered: boolean
  onClear: () => void
  onCreate: () => void
}) {
  // Three states, three copies. Reusing the never-had-data copy for a
  // filtered-to-nothing view teaches the operator something false.
  if (filtered && hasAny) {
    return (
      <div className="acr-pg-empty as-empty">
        <strong>Nothing matches that filter.</strong>
        <button className="acr-pg-sortbtn" onClick={onClear}>
          Show everything
        </button>
      </div>
    )
  }
  return (
    <div className="acr-pg-empty as-empty">
      <Target size={22} className="as-emptyicon" />
      <strong>No assignments yet.</strong>
      <p className="as-emptybody">
        An assignment is one worker pointed at one thing — a campaign, or a
        marketplace — with a note about what you want back. Make one and it will
        sit here until you start it. Nothing starts on its own: every worker in
        this fleet is switched off.
      </p>
      <button className="acr-pg-sortbtn" onClick={onCreate}>
        <Plus size={14} /> New assignment
      </button>
    </div>
  )
}
