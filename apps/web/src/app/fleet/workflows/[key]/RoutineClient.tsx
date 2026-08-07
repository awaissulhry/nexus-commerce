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
import { RunsSection } from '../RunsSection'
import { DiffList, RoutineEditor } from '../RoutineEditor'
import {
  CHIP_CLASS,
  agoTs,
  computeDiff,
  definitionToStory,
  fmtDuration,
  groupRuns,
  prettyCron,
  routineStatus,
  until,
  type CharterRow,
  type FleetState,
  type RunRow,
  type ScheduleJob,
  type WfDefinition,
} from '../lib'

interface RevisionRow {
  id: string
  revision: number
  definition: WfDefinition
  note: string
  author: string | null
  createdAt: string
  activatedAt: string | null
  supersededAt: string | null
}
interface VersionsResp {
  key: string
  kind: string
  source: 'code' | 'revision' | 'none'
  effective: WfDefinition | null
  code: WfDefinition | null
  revisions: RevisionRow[]
}

export function RoutineClient({ routineKey }: { routineKey: string }) {
  const backend = getBackendUrl()
  const routine = BUILTIN_ROUTINES.find((r) => r.key === routineKey)!
  const [jobs, setJobs] = useState<ScheduleJob[]>([])
  const [runs, setRuns] = useState<RunRow[]>([])
  const [charters, setCharters] = useState<CharterRow[]>([])
  const [state, setState] = useState<FleetState | null>(null)
  const [vers, setVers] = useState<VersionsResp | null>(null)
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
      // Versions is deliberately NON-fatal: until the workflows API deploys,
      // the card falls back to its static (and still true) code-truth text.
      try {
        const v = await fetch(`${backend}/api/agent/fleet/workflows/${routine.key}/revisions`, {
          cache: 'no-store',
        })
        if (v.ok) setVers((await v.json()) as VersionsResp)
      } catch {
        /* card falls back */
      }
      setErr(null)
      setLoaded(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      throw e
    }
  }, [backend, routine.mode])

  const { asOf, refresh } = useVisibilityPoll(load)
  const [editing, setEditing] = useState(false)
  const [pendingAct, setPendingAct] = useState<RevisionRow | null>(null)
  const [actBusy, setActBusy] = useState(false)
  const [actErr, setActErr] = useState<string | null>(null)

  const status = useMemo(
    () => routineStatus(routine, state, jobs, charters),
    [routine, state, jobs, charters],
  )

  /* WF.3a — honesty first: when a revision is active, the canvas shows ITS
     wiring, never the hand-authored story of the code path. */
  const displayStory = useMemo(() => {
    if (vers?.source === 'revision' && vers.effective) {
      return definitionToStory(vers.effective, charters)
    }
    return routine.story
  }, [vers, charters, routine])
  const showingRevision = vers?.source === 'revision' && vers.effective != null

  const activate = async (rev: RevisionRow) => {
    setActBusy(true)
    setActErr(null)
    try {
      const r = await fetch(
        `${backend}/api/agent/fleet/workflows/${routine.key}/revisions/${rev.id}/activate`,
        { method: 'POST' },
      )
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `activation failed (${r.status})`)
      }
      setPendingAct(null)
      refresh()
    } catch (e) {
      setActErr(e instanceof Error ? e.message : String(e))
    } finally {
      setActBusy(false)
    }
  }

  /* Reverting is the safe direction — back to code — so per the fleet's
     asymmetric-confirmation convention it applies at once. */
  const revert = async () => {
    await fetch(`${backend}/api/agent/fleet/workflows/${routine.key}/revert-to-builtin`, {
      method: 'POST',
    }).catch(() => null)
    refresh()
  }
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
        {loaded && vers?.kind === 'builtin' && !editing ? (
          <button className="acr-btn" onClick={() => setEditing(true)}>
            Edit the wiring
          </button>
        ) : null}
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
                ? health.last.running
                  ? 'running now…'
                  : health.last.halted
                    ? 'stopped early at one of its limits'
                    : health.last.ok
                      ? `ok · $${health.last.costUSD.toFixed(4)} · ${health.last.findings} finding${health.last.findings === 1 ? '' : 's'}`
                      : 'failed — see Runs below'
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

      {editing && vers?.effective ? (
        <RoutineEditor
          routineKey={routine.key}
          charters={charters}
          baseline={vers.effective}
          backend={backend}
          onDone={(changed) => {
            setEditing(false)
            if (changed) refresh()
          }}
        />
      ) : (
        <section className="acr-card">
          <header className="wf-cardhead">
            <h3>The pipeline</h3>
            <span className="wf-legend">
              {showingRevision ? (
                <>showing the ACTIVE REVISION&rsquo;s wiring — code steps and{' '}
                  <Term k="approval">your approval</Term> still wrap it</>
              ) : (
                <>blue = findings · violet = plan · grey = deterministic code · the last stop is{' '}
                  <Term k="approval">your approval</Term></>
              )}
            </span>
          </header>
          {loaded ? (
            <RoutineCanvas story={displayStory} liveByCharter={liveByCharter} />
          ) : (
            <div className="acr-pg-empty">
              <strong>{err ? 'Nothing to show yet.' : 'Reading the fleet…'}</strong>
              {err
                ? 'The pipeline needs the schedule, run history, worker settings and fleet status.'
                : 'The schedule, the run history, worker settings and the fleet status.'}
            </div>
          )}
        </section>
      )}

      {loaded ? (
        <RunsSection
          groups={groups}
          nameByKey={
            new Map(charters.map((c) => [c.key, c.name ?? c.key] as [string, string]))
          }
          fetchCapReached={runs.length >= 100}
          revisionNoById={
            new Map((vers?.revisions ?? []).map((r) => [r.id, r.revision] as [string, number]))
          }
        />
      ) : null}

      {/* S4 interim — the stored model waits on the locks-doc §4 review, so
          this card tells the truth about today: one version, defined in code.
          It becomes the revision list the moment AgentWorkflowRevision lands. */}
      <section className="acr-card">
        <header className="wf-cardhead">
          <h3>Versions</h3>
        </header>
        <div className="wf-versions">
          {vers && vers.revisions.length > 0 ? (
            <>
              {vers.source === 'revision' ? (
                <div className="acr-banner warn" role="status">
                  <AlertTriangle size={15} />
                  A revision is active and recorded — but runs keep following the built-in
                  definition until stored execution ships. Nothing behaves differently yet.
                </div>
              ) : null}
              {vers.revisions.map((r) => (
                <div className="wf-vrow" key={r.id}>
                  <span className="wf-vbadge">rev {r.revision}</span>
                  <span className="wf-vname">{r.note}</span>
                  <span className="wf-sub">
                    {r.author ?? 'unattributed'} · {agoTs(new Date(r.createdAt).getTime())}
                  </span>
                  {r.activatedAt && !r.supersededAt ? (
                    <>
                      <span className="acr-pg-statechip running">active</span>
                      <button className="acr-btn" onClick={() => void revert()}>
                        Revert to built-in
                      </button>
                    </>
                  ) : r.supersededAt ? (
                    <span className="acr-pg-statechip wf-chip-off">superseded</span>
                  ) : (
                    <>
                      <span className="acr-pg-statechip wf-chip-ready">draft</span>
                      <button
                        className="acr-btn"
                        onClick={() => { setActErr(null); setPendingAct(r) }}
                      >
                        Activate…
                      </button>
                    </>
                  )}
                </div>
              ))}
            </>
          ) : null}
          <div className="wf-vrow">
            <span className="wf-vbadge">v1</span>
            <span className="wf-vname">Built-in — defined in code</span>
            {!vers || vers.source !== 'revision' ? (
              <span className="acr-pg-statechip running">active</span>
            ) : (
              <span className="wf-sub">the fallback every revert returns to</span>
            )}
          </div>
          <p className="wf-vnote">
            Every change to this routine is an immutable revision: a mandatory note saying why,
            a readable diff of steps, connections, gates and trigger, and a one-click return to
            this built-in that cannot fail. Every run will stamp the revision that served it.
            Editing arrives with the editor — and editing never changes what runs until you
            publish.
          </p>
        </div>
      </section>

      <HowWorkflowsWork />

      {pendingAct && vers ? (
        <div className="acr-pg-confirmwrap" role="dialog" aria-modal="true">
          <div className="acr-pg-confirm">
            <h4>Activate rev {pendingAct.revision}?</h4>
            <DiffList
              diff={computeDiff(
                (vers.effective ?? vers.code)!,
                pendingAct.definition,
              )}
            />
            <p>
              This makes rev {pendingAct.revision} the recorded wiring. Until stored execution
              ships, runs keep following the built-in — the record changes, tonight&rsquo;s
              behaviour does not. Revert stays one click.
            </p>
            {actErr ? <p className="acr-pg-warn">{actErr}</p> : null}
            <div className="acr-pg-confirmbtns">
              <button className="acr-btn" onClick={() => setPendingAct(null)} disabled={actBusy}>
                Cancel
              </button>
              <button
                className="acr-btn primary"
                disabled={actBusy}
                onClick={() => void activate(pendingAct)}
              >
                {actBusy ? 'Working…' : 'Activate'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
