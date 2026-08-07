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
 * Derivations live in ./lib (shared with the detail page) and failure
 * semantics in ../_shared/run-health — this file only renders. Unlike the
 * Workers roster, every feed here is load-bearing for status truth, so a
 * failed feed fails the load loudly instead of showing a half-true status.
 */

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { Workflow, RefreshCw, ShieldAlert, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { useVisibilityPoll } from '../_shared/use-visibility-poll'
import { isDiagnostic } from '../_shared/run-health'
import { BUILTIN_ROUTINES } from './routines'
import { HowWorkflowsWork } from './HowWorkflowsWork'
import {
  CHIP_CLASS,
  DAY,
  agoTs,
  groupRuns,
  prettyCron,
  routineStatus,
  until,
  type CharterRow,
  type FleetState,
  type RunRow,
  type ScheduleJob,
} from './lib'

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
    const recentGroups = rows.flatMap((r) => r.groups).filter((g) => g.startedAt >= since)
    // SB.W decision 3: the self-test's notes never masquerade as headline
    // findings — split, footnote, never hide.
    let accountFindings = 0
    let diagnosticFindings = 0
    for (const r of runs) {
      if (new Date(r.createdAt).getTime() < since) continue
      if (isDiagnostic({ key: r.agentKey })) diagnosticFindings += r.findingCount
      else accountFindings += r.findingCount
    }
    const nextJob = jobs
      .filter((j) => j.enabled && j.nextFireAt)
      .sort((a, b) => new Date(a.nextFireAt!).getTime() - new Date(b.nextFireAt!).getTime())[0]
    return {
      runs7d: recentGroups.length,
      cost7d: recentGroups.reduce((s, g) => s + g.costUSD, 0),
      accountFindings,
      diagnosticFindings,
      next: nextJob ?? null,
    }
  }, [rows, runs, jobs])

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
          <span className="v">
            {loaded && totals.next ? (until(totals.next.nextFireAt) ?? '—') : '—'}
          </span>
          <span className="sub">
            {/* No claim about the clock until the feeds were actually read. */}
            {!loaded
              ? err
                ? 'could not read the fleet'
                : 'reading the fleet…'
              : state?.halted
                ? 'nothing runs while the fleet is halted'
                : totals.next
                  ? totals.next.label
                  : 'the fleet clock is off'}
          </span>
        </div>
        <div className="acr-pg-stat">
          <span className="k">Runs, last 7 days</span>
          <span className="v">{loaded ? totals.runs7d : '—'}</span>
          <span className="sub">
            {!loaded
              ? '—'
              : totals.accountFindings + totals.diagnosticFindings === 0
                ? 'no findings reported'
                : totals.diagnosticFindings > 0
                  ? `${totals.accountFindings} findings about your account · ${totals.diagnosticFindings} self-test notes`
                  : `${totals.accountFindings} findings reported`}
          </span>
        </div>
        <div className="acr-pg-stat">
          <span className="k">Spent, last 7 days</span>
          <span className="v">{loaded ? `$${totals.cost7d.toFixed(4)}` : '—'}</span>
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
                          <Link className="nm" href={`/fleet/workflows/${routine.key}`}>
                            {routine.termKey
                              ? <Term k={routine.termKey}>{routine.name}</Term>
                              : routine.name}
                            {' '}
                            <span className="wf-builtin">Built-in</span>
                          </Link>
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
                          {agoTs(last.startedAt)}{' · '}
                          {last.running ? (
                            <span className="wf-run">running now…</span>
                          ) : last.halted ? (
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
                            clock last fired {agoTs(new Date(job.lastRun.startedAt).getTime())} and
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
                                className={`wf-dot ${g.running ? 'run' : g.halted ? 'halt' : g.ok ? 'ok' : 'fail'}`}
                                title={`${new Date(g.startedAt).toLocaleString()} — ${g.running ? 'running now' : g.halted ? 'stopped early' : g.ok ? 'ok' : 'failed'}`}
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

      <div className="wf-howwrap">
        <HowWorkflowsWork />
      </div>
    </div>
  )
}
