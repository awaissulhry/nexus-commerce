'use client'

/**
 * NAF.WF.1 / S1 — the routine list, read-only over the code truth.
 *
 * Three built-in routines — sweep, council, ask — because those are the run
 * modes that actually execute (docs/2026-08-07-naf-wf-workflows-page.md Parts
 * 2 and 8). One row answers: what it is · one honest status with its reason ·
 * when it runs, as a sentence · how the last run went and what it cost · the
 * recent record · what it may touch.
 *
 * Effective status is computed in ONE place (routineStatus) from fleet halt ⊕
 * cron gate ⊕ worker dials — never three toggles the operator must AND
 * together in their head. Unlike the Workers roster, where runs/findings/
 * cards are enrichments, every feed here is load-bearing for status truth —
 * a partial read would show a half-true status, so any failed feed fails the
 * load loudly instead.
 *
 * A routine run is an orchestrationId GROUP of AgentRun rows (sweep,
 * council); an `ask` run stands alone. Reads only endpoints that already
 * exist — WF.1 adds no API surface.
 */

import { useCallback, useMemo, useState } from 'react'
import { Workflow, RefreshCw, ShieldAlert, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { useVisibilityPoll } from '../_shared/use-visibility-poll'
import {
  BUILTIN_ROUTINES,
  DIRECTOR_KEY,
  CRITIC_KEY,
  type BuiltinRoutine,
} from './routines'

/* ── shapes, mirrored from the fleet API ───────────────────────────────── */

interface ScheduleJob {
  key: string
  label: string
  schedule: string
  enabled: boolean
  nextFireAt: string | null
  lastRun: { startedAt: string; status: string; outputSummary: string | null } | null
}
interface RunRow {
  id: string
  agentKey: string
  ok: boolean
  status: string
  mode: string | null
  costUSD: string | number // Decimal serializes as a string — Number() it
  findingCount: number
  orchestrationId: string | null
  haltedReason: string | null
  createdAt: string
}
interface CharterRow {
  key: string
  tier: string
  enabled: boolean
  autonomyLevel: string
  degraded: boolean
}
interface FleetState {
  halted?: boolean
  haltReason?: string | null
}

/** One orchestration of a routine: its runs collapsed to a single record. */
interface RunGroup {
  id: string
  startedAt: number
  ok: boolean
  halted: boolean
  costUSD: number
  findings: number
  runs: number
}

type StatusKind = 'on' | 'ready' | 'idle' | 'off' | 'halted'
interface RoutineStatus {
  kind: StatusKind
  label: string
  why: string
}

/* ── plain-sentence time helpers ───────────────────────────────────────── */

const DAY = 24 * 3600 * 1000
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function ago(ts: number | null): string {
  if (!ts) return 'never'
  const ms = Date.now() - ts
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function until(iso: string | null): string | null {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'due now'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `in ${h}h ${m % 60}m` : `in ${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `in ${d}d ${h % 24}h` : `in ${d}d`
}

/** The two fleet crons in plain words; anything unrecognized stays as cron. */
function prettyCron(expr: string): string {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return expr
  const [min, hr, dom, mon, dow] = f
  const m = Number(min)
  const h = Number(hr)
  if (!Number.isInteger(m) || !Number.isInteger(h)) return `${expr} (UTC)`
  const hhmm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} UTC`
  if (dom === '*' && mon === '*' && dow === '*') return `Nightly at ${hhmm}`
  if (dom === '*' && mon === '*' && /^[0-6]$/.test(dow ?? '')) {
    return `${DAYS[Number(dow)]}s at ${hhmm}`
  }
  return `${expr} (UTC)`
}

/* ── assembly ──────────────────────────────────────────────────────────── */

function groupRuns(runs: RunRow[], mode: BuiltinRoutine['mode']): RunGroup[] {
  const byId = new Map<string, RunRow[]>()
  for (const r of runs) {
    if (r.mode !== mode) continue
    const k = r.orchestrationId ?? r.id
    const list = byId.get(k)
    if (list) list.push(r)
    else byId.set(k, [r])
  }
  const groups: RunGroup[] = []
  for (const [id, list] of byId) {
    groups.push({
      id,
      startedAt: Math.min(...list.map((r) => new Date(r.createdAt).getTime())),
      halted: list.some((r) => r.haltedReason != null),
      ok: list.every((r) => r.ok) && !list.some((r) => r.haltedReason != null),
      costUSD: list.reduce((s, r) => s + Number(r.costUSD || 0), 0),
      findings: list.reduce((s, r) => s + r.findingCount, 0),
      runs: list.length,
    })
  }
  return groups.sort((a, b) => b.startedAt - a.startedAt)
}

/** The one honest status. Precedence: halt → clock → dials. */
function routineStatus(
  r: BuiltinRoutine,
  state: FleetState | null,
  jobs: ScheduleJob[],
  charters: CharterRow[],
): RoutineStatus {
  if (state?.halted) {
    return {
      kind: 'halted',
      label: 'Halted',
      // A halt blocks manual runs too — executeCharter gates them.
      why: state.haltReason ? `Stopped: ${state.haltReason}` : 'Stopped by the operator.',
    }
  }
  if (!r.scheduleKey) {
    return { kind: 'ready', label: 'Ready', why: 'Runs the moment you start it.' }
  }
  const job = jobs.find((j) => j.key === r.scheduleKey)
  if (!job || !job.enabled) {
    return { kind: 'off', label: 'Off', why: 'The fleet clock is off — nothing runs on schedule.' }
  }
  const on = (c: CharterRow) => c.enabled && c.autonomyLevel !== 'OFF'
  const analystsOn = charters.filter((c) => c.tier === 'analyst' && on(c)).length
  if (r.mode === 'sweep') {
    if (analystsOn === 0) {
      return { kind: 'idle', label: 'Idle', why: 'The clock ticks, but every worker is off.' }
    }
    return {
      kind: 'on',
      label: 'On',
      why: `${analystsOn} worker${analystsOn === 1 ? '' : 's'} will report.`,
    }
  }
  const directorOn = charters.some((c) => c.key === DIRECTOR_KEY && on(c))
  const criticOn = charters.some((c) => c.key === CRITIC_KEY && on(c))
  if (!directorOn || !criticOn) {
    return { kind: 'idle', label: 'Idle', why: 'Needs the director and the critic switched on.' }
  }
  if (analystsOn === 0) {
    return { kind: 'idle', label: 'Idle', why: 'Director and critic are on, but no workers report.' }
  }
  return {
    kind: 'on',
    label: 'On',
    why: `${analystsOn} report → director plans → critic rules.`,
  }
}

const CHIP_CLASS: Record<StatusKind, string> = {
  on: 'running',
  halted: 'halted',
  idle: 'wf-chip-idle',
  off: 'wf-chip-off',
  ready: 'wf-chip-ready',
}

/* ── the page ──────────────────────────────────────────────────────────── */

export function WorkflowsClient() {
  const backend = getBackendUrl()
  const [jobs, setJobs] = useState<ScheduleJob[]>([])
  const [runs, setRuns] = useState<RunRow[]>([])
  const [charters, setCharters] = useState<CharterRow[]>([])
  const [state, setState] = useState<FleetState | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [sch, run, cha, st] = await Promise.all([
        fetch(`${backend}/api/agent/fleet/schedule`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/runs?limit=100`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/charters`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/state`, { cache: 'no-store' }),
      ])
      const bad = [
        !sch.ok && 'the schedule',
        !run.ok && 'the run history',
        !cha.ok && 'worker settings',
        !st.ok && 'the fleet status',
      ].filter(Boolean)
      if (bad.length) throw new Error(`Could not read ${bad.join(', ')}.`)
      setJobs(((await sch.json()) as { jobs: ScheduleJob[] }).jobs)
      setRuns(((await run.json()) as { runs: RunRow[] }).runs)
      setCharters(((await cha.json()) as { charters: CharterRow[] }).charters)
      setState((await st.json()) as FleetState)
      setErr(null)
      setLoaded(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      throw e // the poll hook keeps the previous "as of" stamp
    }
  }, [backend])

  const { asOf, refresh } = useVisibilityPoll(load)

  const rows = useMemo(
    () =>
      BUILTIN_ROUTINES.map((routine) => ({
        routine,
        status: routineStatus(routine, state, jobs, charters),
        groups: groupRuns(runs, routine.mode),
        job: routine.scheduleKey ? (jobs.find((j) => j.key === routine.scheduleKey) ?? null) : null,
      })),
    [state, jobs, charters, runs],
  )

  const totals = useMemo(() => {
    const since = Date.now() - 7 * DAY
    const recent = rows.flatMap((r) => r.groups).filter((g) => g.startedAt >= since)
    const nextJob = jobs
      .filter((j) => j.enabled && j.nextFireAt)
      .sort((a, b) => new Date(a.nextFireAt!).getTime() - new Date(b.nextFireAt!).getTime())[0]
    return {
      runs7d: recent.length,
      findings7d: recent.reduce((s, g) => s + g.findings, 0),
      cost7d: recent.reduce((s, g) => s + g.costUSD, 0),
      next: nextJob ?? null,
    }
  }, [rows, jobs])

  const degraded = charters.filter((c) => c.degraded).length

  return (
    <div className="acr-fleet">
      {err ? (
        <div className="acr-banner err" role="alert">
          <ShieldAlert size={15} /> {err}
          <button className="acr-btn" onClick={refresh}>Try again</button>
        </div>
      ) : null}

      <p className="acr-pg-intro">
        A <Term k="workflow">workflow</Term> is a named routine — which workers run, in what
        order, and what each hands to the next. The fleet ships with three built-in routines;
        the map shows the whole fleet live, this page shows each routine on its own. Nothing
        here reaches Amazon without passing an <Term k="approval">approval</Term>.
      </p>

      <div className="acr-pg-strip">
        <div className="acr-pg-stat">
          <span className="k">Routines</span>
          <span className="v">{BUILTIN_ROUTINES.length}</span>
          <span className="sub">built-in · custom ones arrive with the editor</span>
        </div>
        <div className="acr-pg-stat">
          <span className="k">Next scheduled run</span>
          <span className="v">{totals.next ? (until(totals.next.nextFireAt) ?? '—') : '—'}</span>
          <span className="sub">
            {state?.halted
              ? 'nothing runs while the fleet is halted'
              : totals.next
                ? totals.next.label
                : 'the fleet clock is off'}
          </span>
        </div>
        <div className="acr-pg-stat">
          <span className="k">Runs, last 7 days</span>
          <span className="v">{totals.runs7d}</span>
          <span className="sub">
            {totals.findings7d > 0
              ? `${totals.findings7d} findings reported`
              : 'no findings reported'}
          </span>
        </div>
        <div className="acr-pg-stat">
          <span className="k">Spent, last 7 days</span>
          <span className="v">${totals.cost7d.toFixed(4)}</span>
          <span className="sub">model spend across every routine</span>
        </div>
      </div>

      <div className="acr-pg-toolbar">
        {asOf ? (
          <span className="wf-asof">
            as of {asOf.toLocaleTimeString()} · refreshes every 10s while you watch
          </span>
        ) : null}
        <span className="spacer" />
        <button className="acr-btn" onClick={refresh}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {degraded > 0 ? (
        <div className="acr-banner warn" role="status">
          <AlertTriangle size={15} />
          {degraded} worker{degraded === 1 ? '' : 's'} could not have their settings read, so the
          statuses below show the fail-safe posture, not your choices.
        </div>
      ) : null}

      {!loaded ? (
        <div className="acr-pg-empty">
          <strong>{err ? 'Nothing to show yet.' : 'Reading the fleet…'}</strong>
          {err
            ? 'The routine list needs the schedule, run history, worker settings and fleet status.'
            : 'The schedule, the run history, worker settings and the fleet status.'}
        </div>
      ) : (
        <div className="acr-pg-tablewrap">
          <table className="acr-pg-tbl">
            <thead>
              <tr>
                <th>Routine</th>
                <th>Status</th>
                <th><Term k="trigger">When it runs</Term></th>
                <th>Last run</th>
                <th>Recent</th>
                <th>What it may touch</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ routine, status, groups, job }) => {
                const last = groups[0] ?? null
                const dots = groups.slice(0, 8).reverse()
                return (
                  <tr key={routine.key}>
                    <td>
                      <div className="acr-pg-who">
                        <span className="acr-pg-avatar" aria-hidden><Workflow size={15} /></span>
                        <span>
                          <span className="nm">
                            {routine.termKey
                              ? <Term k={routine.termKey}>{routine.name}</Term>
                              : routine.name}
                            {' '}
                            <span className="wf-builtin">Built-in</span>
                          </span>
                          <span className="wf-purpose">{routine.purpose}</span>
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="wf-statecell">
                        <span className={`acr-pg-statechip ${CHIP_CLASS[status.kind]}`}>
                          {status.label}
                        </span>
                        <span className="why">{status.why}</span>
                      </span>
                    </td>
                    <td>
                      <span className="wf-when">
                        {job ? prettyCron(job.schedule) : 'When you start it'}
                      </span>
                      <span className="wf-sub">
                        {job
                          ? job.enabled
                            ? (until(job.nextFireAt) ? `next ${until(job.nextFireAt)}` : 'next time unknown')
                            : 'not scheduled — the clock is off'
                          : 'from a worker’s page, or the console'}
                      </span>
                    </td>
                    <td>
                      {last ? (
                        <>
                          {ago(last.startedAt)}{' · '}
                          {last.halted ? (
                            <span className="wf-halt">stopped early</span>
                          ) : last.ok ? (
                            <span className="acr-pg-ok">ok</span>
                          ) : (
                            <span className="acr-pg-warn">failed</span>
                          )}
                          <span className="wf-sub">
                            ${last.costUSD.toFixed(4)} · {last.findings} finding{last.findings === 1 ? '' : 's'}
                            {last.runs > 1 ? ` · ${last.runs} workers` : ''}
                          </span>
                        </>
                      ) : job?.lastRun ? (
                        /* Dagster's tick-vs-run lesson: the clock firing and
                           launching nothing IS the answer to "why didn't it
                           run?" — say it, don't show a bare "never". */
                        <>
                          <span className="acr-pg-muted">no runs yet</span>
                          <span className="wf-sub">
                            clock last fired {ago(new Date(job.lastRun.startedAt).getTime())} and
                            launched nothing — every worker was off
                          </span>
                        </>
                      ) : (
                        <span className="acr-pg-muted">never run</span>
                      )}
                    </td>
                    <td>
                      {groups.length > 0 ? (
                        <>
                          <span className="wf-dots" aria-label={`Last ${dots.length} runs, oldest first`}>
                            {dots.map((g) => (
                              <span
                                key={g.id}
                                className={`wf-dot ${g.halted ? 'halt' : g.ok ? 'ok' : 'fail'}`}
                                title={`${new Date(g.startedAt).toLocaleString()} — ${g.halted ? 'stopped early' : g.ok ? 'ok' : 'failed'}`}
                              />
                            ))}
                          </span>
                          <span className="wf-sub">{groups.length} run{groups.length === 1 ? '' : 's'} on record</span>
                        </>
                      ) : (
                        <span className="acr-pg-muted">—</span>
                      )}
                    </td>
                    <td><span className="wf-touch">{routine.touch}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
