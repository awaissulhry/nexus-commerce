'use client'

/**
 * NAF.WF.2 (S2) — the routine's story. One screen answers: who does what, in
 * what order, where a human sits, how healthy the routine is, and when it
 * runs next. Same four load-bearing feeds as the list (a partial read would
 * show a half-true status), same 10s visibility-gated poll.
 */

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, RefreshCw, ShieldAlert, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { useVisibilityPoll } from '../../_shared/use-visibility-poll'
import { BUILTIN_ROUTINES } from '../routines'
import { RoutineCanvas, type StepLive } from '../RoutineCanvas'
import { HowWorkflowsWork } from '../HowWorkflowsWork'
import {
  CHIP_CLASS,
  agoTs,
  fmtDuration,
  groupRuns,
  prettyCron,
  routineStatus,
  until,
  type CharterRow,
  type FleetState,
  type RunRow,
  type ScheduleJob,
} from '../lib'

export function RoutineClient({ routineKey }: { routineKey: string }) {
  const backend = getBackendUrl()
  const routine = BUILTIN_ROUTINES.find((r) => r.key === routineKey)!
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
        fetch(`${backend}/api/agent/fleet/runs?mode=${routine.mode}&limit=100`, {
          cache: 'no-store',
        }),
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
      throw e
    }
  }, [backend, routine.mode])

  const { asOf, refresh } = useVisibilityPoll(load)

  const status = useMemo(
    () => routineStatus(routine, state, jobs, charters),
    [routine, state, jobs, charters],
  )
  const groups = useMemo(() => groupRuns(runs, routine.mode), [runs, routine.mode])
  const job = routine.scheduleKey
    ? (jobs.find((j) => j.key === routine.scheduleKey) ?? null)
    : null

  const liveByCharter = useMemo(() => {
    const m = new Map<string, StepLive>()
    const runningKeys = new Set(
      runs.filter((r) => r.status === 'running').map((r) => r.agentKey),
    )
    for (const c of charters) {
      m.set(c.key, {
        autonomyLevel: c.autonomyLevel,
        degraded: c.degraded,
        running: runningKeys.has(c.key),
      })
    }
    return m
  }, [charters, runs])

  const health = useMemo(() => {
    const last = groups[0] ?? null
    const okCount = groups.filter((g) => g.ok).length
    const durations = groups
      .map((g) => g.durationMs)
      .filter((d): d is number => d != null && d > 0)
    const avgDuration = durations.length
      ? durations.reduce((s, d) => s + d, 0) / durations.length
      : null
    const avgCost = groups.length
      ? groups.reduce((s, g) => s + g.costUSD, 0) / groups.length
      : null
    return { last, okCount, avgDuration, avgCost }
  }, [groups])

  const degraded = charters.filter((c) => c.degraded).length

  return (
    <div className="acr-fleet">
      {err ? (
        <div className="acr-banner err" role="alert">
          <ShieldAlert size={15} /> {err}
          <button className="acr-btn" onClick={refresh}>Try again</button>
        </div>
      ) : null}

      <div className="wf-backrow">
        <Link className="wf-back" href="/fleet/workflows">
          <ArrowLeft size={13} /> All workflows
        </Link>
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

      <div className="wf-sentence">
        {/* No status claim until the feeds were actually read — a chip computed
            from empty arrays would say "Off" about a clock that is on. */}
        {loaded ? (
          <span className={`acr-pg-statechip ${CHIP_CLASS[status.kind]}`}>{status.label}</span>
        ) : null}
        <div>
          <p>{routine.story.sentence}</p>
          <span className="wf-sub">
            {loaded
              ? status.why
              : err
                ? 'The fleet could not be read — its status is unknown, not off.'
                : 'Reading the fleet…'}
          </span>
        </div>
      </div>

      <div className="acr-pg-strip">
        <div className="acr-pg-stat">
          <span className="k">Last run</span>
          <span className="v">{loaded && health.last ? agoTs(health.last.startedAt) : '—'}</span>
          <span className="sub">
            {!loaded
              ? '—'
              : health.last
                ? health.last.halted
                  ? 'stopped early at one of its limits'
                  : health.last.ok
                    ? `ok · $${health.last.costUSD.toFixed(4)} · ${health.last.findings} finding${health.last.findings === 1 ? '' : 's'}`
                    : 'failed — open Recent runs below'
                : job?.lastRun
                  ? `clock fired ${agoTs(new Date(job.lastRun.startedAt).getTime())}, launched nothing`
                  : 'never run'}
          </span>
        </div>
        <div className="acr-pg-stat">
          <span className="k">Record</span>
          <span className="v">
            {loaded && groups.length ? `${health.okCount} of ${groups.length}` : '—'}
          </span>
          <span className="sub">
            {!loaded ? '—' : groups.length ? 'runs finished clean' : 'no runs yet'}
          </span>
        </div>
        <div className="acr-pg-stat">
          <span className="k">Typical duration</span>
          <span className="v">{loaded ? fmtDuration(health.avgDuration) : '—'}</span>
          <span className="sub">average across recorded runs</span>
        </div>
        <div className="acr-pg-stat">
          <span className="k">Cost per run</span>
          <span className="v">
            {loaded && health.avgCost != null ? `$${health.avgCost.toFixed(4)}` : '—'}
          </span>
          <span className="sub">average model spend</span>
        </div>
        <div className="acr-pg-stat">
          <span className="k">Next run</span>
          <span className="v">
            {!loaded
              ? '—'
              : job
                ? job.enabled
                  ? (until(job.nextFireAt) ?? '—')
                  : 'not scheduled'
                : 'when you start it'}
          </span>
          <span className="sub">
            {!loaded ? '—' : job ? prettyCron(job.schedule) : 'from a worker’s page, or the console'}
          </span>
        </div>
      </div>

      {degraded > 0 ? (
        <div className="acr-banner warn" role="status">
          <AlertTriangle size={15} />
          {degraded} worker{degraded === 1 ? '' : 's'} could not have their settings read — the
          tints on the pipeline show the fail-safe posture, not your choices.
        </div>
      ) : null}

      <section className="acr-card">
        <header className="wf-cardhead">
          <h3>The pipeline</h3>
          <span className="wf-legend">
            blue = findings · violet = plan · grey = deterministic code · the last stop is{' '}
            <Term k="approval">your approval</Term>
          </span>
        </header>
        {loaded ? (
          <RoutineCanvas story={routine.story} liveByCharter={liveByCharter} />
        ) : (
          <div className="acr-pg-empty">
            <strong>{err ? 'Nothing to show yet.' : 'Reading the fleet…'}</strong>
            {err
              ? 'The pipeline needs the schedule, run history, worker settings and fleet status.'
              : 'The schedule, the run history, worker settings and the fleet status.'}
          </div>
        )}
      </section>

      <HowWorkflowsWork />
    </div>
  )
}
