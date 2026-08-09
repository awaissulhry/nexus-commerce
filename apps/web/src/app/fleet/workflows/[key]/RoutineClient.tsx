'use client'

/**
 * NAF.WF.2→6a — one routine's page, API-first. Built-ins keep their
 * hand-authored story and schedule furniture; customs (WF.6a) render
 * entirely from the stored record: name and description from the row,
 * wiring through definitionToStory, run history by workflowKey (the WF.4a
 * stamps — preview rows excluded so tests never pollute it). One screen,
 * one honest status, same four load-bearing feeds, same 10s poll.
 */

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, RefreshCw, ShieldAlert, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { useVisibilityPoll } from '../../_shared/use-visibility-poll'
import { BUILTIN_ROUTINES } from '../routines'
import { RoutinePipeline } from '../RoutinePipeline'
import { HowWorkflowsWork } from '../HowWorkflowsWork'
import { RunsSection } from '../RunsSection'
import { RunBars } from '../RunBars'
import { DiffList, RoutineEditor } from '../RoutineEditor'
import {
  CHIP_CLASS,
  KIND_HINT,
  agoTs,
  computeDiff,
  customStatus,
  definitionToStory,
  fmtDuration,
  groupRuns,
  prettyCron,
  routineStatus,
  triggerLineFor,
  until,
  versionChipFor,
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
  kind: 'builtin' | 'custom'
  name: string
  description: string | null
  enabled: boolean
  source: 'code' | 'revision' | 'none'
  effective: WfDefinition | null
  code: WfDefinition | null
  revisions: RevisionRow[]
}

/** A fresh custom opens straight into composing: manual, empty, honest. */
const EMPTY_DEF: WfDefinition = { v: 1, trigger: { type: 'manual' }, steps: [], edges: [] }

export function RoutineClient({ routineKey }: { routineKey: string }) {
  const backend = getBackendUrl()
  const builtin = BUILTIN_ROUTINES.find((r) => r.key === routineKey) ?? null
  const [jobs, setJobs] = useState<ScheduleJob[]>([])
  const [runs, setRuns] = useState<RunRow[]>([])
  const [charters, setCharters] = useState<CharterRow[]>([])
  const [state, setState] = useState<FleetState | null>(null)
  const [vers, setVers] = useState<VersionsResp | null>(null)
  const [missing, setMissing] = useState(false)
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
      // For a BUILT-IN this feed enriches (static fallback covers a gap);
      // for a CUSTOM it is the page — a 404 is the honest "no such routine".
      try {
        const v = await fetch(`${backend}/api/agent/fleet/workflows/${routineKey}/revisions`, {
          cache: 'no-store',
        })
        if (v.ok) {
          setVers((await v.json()) as VersionsResp)
          setMissing(false)
        } else if (v.status === 404 && !builtin) {
          setMissing(true)
        }
      } catch {
        /* built-ins fall back to code truth; customs show the error state */
      }
      setErr(null)
      setLoaded(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      throw e // the poll hook keeps the previous "as of" stamp
    }
  }, [backend, routineKey, builtin])

  const { asOf, refresh } = useVisibilityPoll(load)
  const [editing, setEditing] = useState(false)
  const [pendingAct, setPendingAct] = useState<RevisionRow | null>(null)
  const [actBusy, setActBusy] = useState(false)
  const [actErr, setActErr] = useState<string | null>(null)
  const [runDialog, setRunDialog] = useState(false)
  const [runEstimate, setRunEstimate] = useState<number | null>(null)
  const [runBusy, setRunBusy] = useState(false)
  const [runErr, setRunErr] = useState<string | null>(null)
  const [runNotice, setRunNotice] = useState<string | null>(null)
  const [toggleDialog, setToggleDialog] = useState<'off' | 'on' | null>(null)
  const [toggleBusy, setToggleBusy] = useState(false)
  const [toggleErr, setToggleErr] = useState<string | null>(null)
  /* S3.c — which run the pipeline is drawing. null = the newest, which is what
     S2R shipped and what the page returns to when the selection is cleared. */
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [openDiff, setOpenDiff] = useState<string | null>(null)

  /* WF.6b — Run-now for a published custom. A REAL run: findings write to
     the board; OFF workers still skip; the fleet gates bind. */
  const canRunNow =
    !builtin && vers?.kind === 'custom' && vers.source === 'revision' && vers.enabled

  /* WF.6d — the operator's off switch, custom routines only: built-ins ride
     the fleet clock and the workers' dials. */
  const canToggle = !builtin && vers?.kind === 'custom'

  const setEnabled = async (enabled: boolean) => {
    setToggleBusy(true)
    setToggleErr(null)
    try {
      const r = await fetch(`${backend}/api/agent/fleet/workflows/${routineKey}/enabled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const body = (await r.json()) as { enabled?: boolean; error?: string }
      if (!r.ok) throw new Error(body.error ?? `switch failed (${r.status})`)
      setToggleDialog(null)
      setRunNotice(
        enabled
          ? 'This routine is on again — its clock re-arms if the wiring is scheduled, and Run now is back.'
          : 'This routine is off — its clock is disarmed and Run now is refused until you turn it back on.',
      )
      refresh()
    } catch (e) {
      setToggleErr(e instanceof Error ? e.message : String(e))
    } finally {
      setToggleBusy(false)
    }
  }

  const openRunDialog = async () => {
    setRunErr(null)
    setRunEstimate(null)
    setRunDialog(true)
    try {
      const keys = (vers?.effective?.steps ?? []).map((s) => s.charterKey).join(',')
      const r = await fetch(
        `${backend}/api/agent/fleet/workflows/${routineKey}/test-estimate?steps=${encodeURIComponent(keys)}`,
        { cache: 'no-store' },
      )
      if (r.ok) setRunEstimate(((await r.json()) as { estimatedCostUSD: number }).estimatedCostUSD)
    } catch { /* the dialog says "estimating…" honestly */ }
  }

  const runNow = async () => {
    setRunBusy(true)
    setRunErr(null)
    try {
      const r = await fetch(`${backend}/api/agent/fleet/workflows/${routineKey}/run`, {
        method: 'POST',
      })
      const body = (await r.json()) as {
        pending?: boolean
        note?: string
        started?: number
        succeeded?: number
        failed?: number
        skipped?: number
        haltedReason?: string
        error?: string
      }
      if (!r.ok) throw new Error(body.error ?? `run failed (${r.status})`)
      setRunDialog(false)
      if (body.pending) {
        setRunNotice(body.note ?? 'Running — watch the Runs section.')
      } else if (body.haltedReason) {
        setRunNotice(`Stopped: ${body.haltedReason}`)
      } else if ((body.succeeded ?? 0) === 0 && (body.skipped ?? 0) > 0) {
        setRunNotice(
          `Every worker in this routine is OFF, so nothing ran (${body.skipped} skipped). The dials on the Workers page decide what actually executes.`,
        )
      } else {
        setRunNotice(
          `Run finished: ${body.succeeded ?? 0} worked · ${body.skipped ?? 0} skipped${(body.failed ?? 0) > 0 ? ` · ${body.failed} failed` : ''}. Details below in Runs.`,
        )
      }
      refresh()
    } catch (e) {
      setRunErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRunBusy(false)
    }
  }

  const title = builtin?.name ?? vers?.name ?? routineKey
  /* S2.a — the routine's own story is the page's subtitle, which is where a
     description belongs and where the shell already renders one. It used to
     live in a card below with 940px of empty beside it. */
  const sub = builtin
    ? builtin.story.sentence
    : (vers?.description ?? 'A custom routine over the fleet’s workers.')

  const kindLabel: 'builtin' | 'custom' | null = builtin ? 'builtin' : vers ? 'custom' : null
  const activeRevisionNo =
    vers?.revisions.find((r) => r.activatedAt && !r.supersededAt)?.revision ?? null
  const version = versionChipFor({
    activeRevisionNo,
    source: vers?.source ?? (builtin ? 'code' : 'none'),
  })

  const job = builtin?.scheduleKey
    ? (jobs.find((j) => j.key === builtin.scheduleKey) ?? null)
    : // WF.6c — an enabled scheduled custom rides the same feed.
      (jobs.find((j) => j.key === `workflow:${routineKey}`) ?? null)

  const status = useMemo(() => {
    if (builtin) return routineStatus(builtin, state, jobs, charters)
    return customStatus(
      state,
      { enabled: vers?.enabled ?? true, source: vers?.source ?? 'none' },
      job,
    )
  }, [builtin, state, jobs, charters, vers, job])

  const groups = useMemo(
    () => groupRuns(runs, builtin ? builtin.mode : { workflowKey: routineKey }),
    [runs, builtin, routineKey],
  )

  /* S4.c — how many runs each revision actually served. S3R stamps every run
     row with `wiring rev N`; this is where those chips resolve.
     `groups` is already preview-free on both branches of `groupRuns` (built-ins
     select by mode, and 'preview' is not one; customs exclude it explicitly),
     so the test lane can never appear in a revision's tally. A group with no
     stamp ran the code path and is counted against the built-in row. */
  const CODE_PATH = '__code__'
  const runsByRevision = useMemo(() => {
    const m = new Map<string, number>()
    for (const g of groups) {
      const key = g.rows.find((r) => r.workflowRevisionId)?.workflowRevisionId ?? CODE_PATH
      m.set(key, (m.get(key) ?? 0) + 1)
    }
    return m
  }, [groups])

  /* The count is over the FETCHED window, so when the feed returns its cap the
     sentence says so rather than implying a lifetime total. */
  const servedSentence = (n: number) =>
    n === 0
      ? 'no runs under this wiring'
      : runs.length >= 100
        ? `served ${n} of the newest 100 runs`
        : `served ${n} run${n === 1 ? '' : 's'}`

  const shownGroup = groups.find((g) => g.id === selectedRun) ?? groups[0] ?? null
  /* Historical only when the operator picked something that is NOT the newest
     run — selecting the newest is the same picture the page defaults to. */
  const historical = shownGroup != null && groups[0] != null && shownGroup.id !== groups[0].id

  const { main: triggerMain, sub: triggerSub } = triggerLineFor({
    job,
    kind: builtin ? 'builtin' : 'custom',
    statusKind: status.kind,
  })

  /* WF.3a/6a — honesty first: an active revision's wiring is what renders;
     the hand-authored story is the pure-code built-in state only. */
  const displayStory = useMemo(() => {
    if (builtin && vers?.source !== 'revision') return builtin.story
    if (vers?.effective) return definitionToStory(vers.effective, charters)
    return null
  }, [builtin, vers, charters])
  const showingRevision = vers?.source === 'revision' && vers.effective != null

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

  const activate = async (rev: RevisionRow) => {
    setActBusy(true)
    setActErr(null)
    try {
      const r = await fetch(
        `${backend}/api/agent/fleet/workflows/${routineKey}/revisions/${rev.id}/activate`,
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
     asymmetric-confirmation convention it applies at once. Built-ins only:
     a custom has no code to return to. */
  const revert = async () => {
    await fetch(`${backend}/api/agent/fleet/workflows/${routineKey}/revert-to-builtin`, {
      method: 'POST',
    }).catch(() => null)
    refresh()
  }

  const degraded = charters.filter((c) => c.degraded).length

  if (missing) {
    return (
      <div className="acr wf-page">
        <header className="acr-head">
          <div>
            <h1>{routineKey}</h1>
            <p className="acr-sub">No routine by this name.</p>
          </div>
        </header>
        <div className="acr-fleet">
          {/* S2.d — a dead link used to answer with one sentence and 81% of an
              empty viewport. The three built-ins are static code truth, so
              naming them here costs no fetch and turns a dead end into the
              place you were probably trying to reach. */}
          <div className="acr-pg-empty wf-notfound">
            <strong>This workflow does not exist.</strong>
            It may have been renamed, or the link is stale.
            <div className="wf-notfound-list">
              {BUILTIN_ROUTINES.map((r) => (
                <Link key={r.key} className="wf-notfound-item" href={`/fleet/workflows/${r.key}`}>
                  <span className="nm">{r.name}</span>
                  <span className="ds">{r.purpose}</span>
                </Link>
              ))}
            </div>
            <Link className="wf-back" href="/fleet/workflows">
              <ArrowLeft size={13} /> All workflows, including any you created
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="acr wf-page">
      {/* S2.a — the actions live beside the title, where Airflow, Dagster and
          GitHub all put them. `.acr-head` was already a space-between flex with
          only one child, so the old separate action row existed for no reason
          and carried a 767.7px void. */}
      {/* The back link gets its own row: with it inside the title block the
          actions aligned to IT rather than to the title, 26.4px high, and the
          row reached y=20 where the app shell's own top-right chrome lives. */}
      <div className="wf-backline">
        <Link className="wf-back" href="/fleet/workflows">
          <ArrowLeft size={13} /> All workflows
        </Link>
      </div>
      <header className="acr-head wf-head">
        <div className="wf-head-main">
          <div className="wf-titleline">
            <h1>{title}</h1>
            {loaded && kindLabel ? (
              <span className="wf-kind" title={KIND_HINT[kindLabel]}>
                {kindLabel === 'builtin' ? 'Built-in' : 'Custom'}
              </span>
            ) : null}
            {loaded && version ? (
              <span
                className={`wf-vbadge${version.neutral ? ' neutral' : ''}`}
                title={version.hint}
              >
                {version.label}
              </span>
            ) : null}
          </div>
          <p className="acr-sub">{sub}</p>
        </div>
        <div className="wf-headactions">
          {loaded && canRunNow && !editing ? (
            <button className="acr-btn go" onClick={() => void openRunDialog()}>
              Run now…
            </button>
          ) : null}
          {loaded && vers && !editing ? (
            <button className="acr-btn ghost" onClick={() => setEditing(true)}>
              Edit the wiring
            </button>
          ) : null}
          {loaded && canToggle && vers && !editing ? (
            <button
              className="acr-btn ghost"
              title={
                vers.enabled
                  ? 'Disarm its clock and refuse Run now until you turn it back on'
                  : 'Re-arm its clock (if scheduled) and allow Run now again'
              }
              onClick={() => {
                setToggleErr(null)
                setToggleDialog(vers.enabled ? 'off' : 'on')
              }}
            >
              {vers.enabled ? 'Turn off…' : 'Turn on…'}
            </button>
          ) : null}
          <button className="acr-btn ghost" onClick={refresh}>
            <RefreshCw size={13} /> Refresh
          </button>
          {asOf ? (
            <span
              className="wf-asof"
              title="This page re-reads the fleet every 10 seconds while the tab is visible, and pauses when it is not."
            >
              as of {asOf.toLocaleTimeString()}
            </span>
          ) : null}
        </div>
      </header>
      <div className="acr-fleet">
        {err ? (
          <div className="acr-banner err" role="alert">
            <ShieldAlert size={15} /> {err}
            <button className="acr-btn" onClick={refresh}>Try again</button>
          </div>
        ) : null}

        {runNotice ? (
          <div className="acr-banner warn" role="status">
            <AlertTriangle size={15} /> {runNotice}
            <button className="acr-btn" onClick={() => setRunNotice(null)}>Dismiss</button>
          </div>
        ) : null}

        {/* S2.a — one band. The status, its reason and when it next runs answer
            a single question and used to sit 400px apart, the reason in a card
            with 940px of empty beside it and the next fire in a strip cell. */}
        <div className="wf-statusband">
          {loaded ? (
            <span className={`acr-pg-statechip ${CHIP_CLASS[status.kind]}`}>{status.label}</span>
          ) : null}
          <p className="wf-why">
            {loaded
              ? status.why
              : err
                ? 'The fleet could not be read — its status is unknown, not off.'
                : 'Reading the fleet…'}
          </p>
          <span className="wf-band-spacer" />
          <span className="wf-bandwhen">
            {triggerMain}
            <span className="sep" aria-hidden>·</span>
            <span className="nx">{triggerSub}</span>
          </span>
        </div>

        {/* S2.b — the S1R fact-bar token, and no cell may render a bare
            em-dash. Four of five cells read "—" on two of the three routines,
            spending 109,301px2 on em-dashes while the sentence that answers
            the question sat underneath in the quiet slot. A cell that cannot
            know something says what WOULD fill it. */}
        <div className="wf-factbar">
          <div className="wf-fact">
            <span className="k">Last run</span>
            <span className="v">
              {!loaded ? 'reading…' : health.last ? agoTs(health.last.startedAt) : 'never run'}
            </span>
            <span className="sub">
              {!loaded
                ? 'the fleet has not answered yet'
                : health.last
                  ? health.last.running
                    ? 'running now…'
                    : health.last.halted
                      ? 'stopped early at one of its limits'
                      : health.last.ok
                        ? `ok · $${health.last.costUSD.toFixed(4)} · ${health.last.findings} finding${health.last.findings === 1 ? '' : 's'}`
                        : 'failed — see Runs below'
                  : job?.lastRun
                    ? /* Dagster's tick-vs-run lesson, word for word. */
                      `the clock fired ${agoTs(new Date(job.lastRun.startedAt).getTime())} and launched nothing — every worker was off`
                    : 'nothing has started this routine yet'}
            </span>
          </div>
          <div className="wf-fact">
            <span className="k">Record</span>
            <span className="v">
              {!loaded ? 'reading…' : groups.length ? `${health.okCount} of ${groups.length}` : 'no runs yet'}
            </span>
            <span className="sub">
              {loaded && groups.length ? 'runs finished clean' : 'this will read “N of M” once it has run'}
            </span>
            {/* Only when there IS history. The value already says "no runs
                yet" at 17px, so twelve grey slots plus "nothing to chart yet"
                would be a third way of saying the same nothing. */}
            {loaded && groups.length ? <RunBars groups={groups} /> : null}
          </div>
          <div className="wf-fact">
            <span className="k">Typical duration</span>
            <span className="v">
              {!loaded ? 'reading…' : health.avgDuration != null ? fmtDuration(health.avgDuration) : 'not yet known'}
            </span>
            <span className="sub">
              {loaded && health.avgDuration != null
                ? 'average across recorded runs'
                : 'averages appear after the first run'}
            </span>
          </div>
          <div className="wf-fact">
            <span className="k">Cost per run</span>
            <span className="v">
              {!loaded ? 'reading…' : health.avgCost != null ? `$${health.avgCost.toFixed(4)}` : 'not yet known'}
            </span>
            <span className="sub">
              {loaded && health.avgCost != null
                ? 'average model spend'
                : 'averages appear after the first run'}
            </span>
          </div>
          <div className="wf-fact">
            <span className="k">Next run</span>
            <span className="v">
              {!loaded
                ? 'reading…'
                : job
                  ? job.enabled
                    ? (until(job.nextFireAt) ?? 'next time unknown')
                    : 'not scheduled'
                  : builtin || canRunNow
                    ? 'when you start it'
                    : canToggle && vers && !vers.enabled
                      ? 'switched off'
                      : 'nothing to run yet'}
            </span>
            <span className="sub">
              {!loaded
                ? 'the fleet has not answered yet'
                : job
                  ? prettyCron(job.schedule)
                  : builtin
                    ? 'from a worker’s page, or the console'
                    : canRunNow
                      ? 'Run now, above — or publish a schedule'
                      : canToggle && vers && !vers.enabled
                        ? 'turn it back on to run it'
                        : 'publish a first revision to run it'}
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

        {editing && vers ? (
          <RoutineEditor
            routineKey={routineKey}
            charters={charters}
            baseline={vers.effective ?? EMPTY_DEF}
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
              {historical && shownGroup ? (
                /* S3.c — the picture is no longer "now", so it says so, and
                   says why the worker dials are missing from it. */
                <span className="wf-legend wf-pipe-histnote">
                  showing the run from {agoTs(shownGroup.startedAt)}
                  {' · '}
                  worker settings are today&rsquo;s, so they are not shown for a past run
                  <button className="acr-btn ghost" onClick={() => setSelectedRun(null)}>
                    Back to the latest run
                  </button>
                </span>
              ) : (
              <span className="wf-legend">
                {showingRevision ? (
                  <>the wiring you published · every path still ends at an{' '}
                    <Term k="approval">approval</Term></>
                ) : (
                  <>what runs, in order · every path ends at an{' '}
                    <Term k="approval">approval</Term></>
                )}
              </span>
              )}
            </header>
            {loaded && displayStory ? (
              <RoutinePipeline
                story={displayStory}
                charters={charters}
                lastGroup={shownGroup}
                historical={historical}
                /* §10.5 promised the picture would change when the ROUTINE's
                   own state does — the whole indictment of the old canvas.
                   A worker being off is already on its card; this is the
                   routine being off, which no card can say. */
                blockedReason={
                  status.kind === 'halted'
                    ? 'The fleet is halted — none of these steps will run, scheduled or by hand.'
                    : status.kind === 'off' && canToggle && vers && !vers.enabled
                      ? 'This routine is switched off — none of these steps will run until you turn it back on.'
                      : null
                }
              />
            ) : (
              <div className="acr-pg-empty">
                <strong>
                  {err
                    ? 'Nothing to show yet.'
                    : loaded
                      ? 'Nothing composed yet.'
                      : 'Reading the fleet…'}
                </strong>
                {err
                  ? 'The pipeline needs the schedule, run history, worker settings and fleet status.'
                  : loaded
                    ? 'Open the editor, add workers, connect who hands what to whom, and publish.'
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
            selectedId={selectedRun}
            onSelect={(id) => setSelectedRun((cur) => (cur === id ? null : id))}
            revisionNoById={
              new Map((vers?.revisions ?? []).map((r) => [r.id, r.revision] as [string, number]))
            }
          />
        ) : null}

        <section className="acr-card">
          <header className="wf-cardhead">
            <h3>Versions</h3>
          </header>
          <div className="wf-versions">
            {vers && vers.revisions.length > 0 ? (
              <>
                {vers.source === 'revision' && builtin ? (
                  <p className="wf-vnote">
                    This routine runs its active revision — the built-in default is set
                    aside until you revert (one click below; it cannot fail).
                  </p>
                ) : null}
                {/* S4.a — a grid, so the state chip has ONE x on every row.
                    As a flex row it landed anywhere across 549.6px: on a
                    reverted built-in the "active" marker sat at 321.4 while the
                    revision rows' chips sat at 860.8 and 870.4, and the one
                    thing this section is scanned for had no fixed place. */}
                {vers.revisions.map((r) => {
                  const isActive = Boolean(r.activatedAt && !r.supersededAt)
                  const isDraft = !r.activatedAt && !r.supersededAt
                  /* S4.d — what THIS revision changed, against the one before
                     it by number. Not Grafana's select-two-and-compare: at
                     three rows a selection model costs two clicks and a mental
                     mode to answer a question each row can answer alone.
                     rev 1 has no predecessor, so it shows what it introduced. */
                  const prev = vers.revisions.find((x) => x.revision === r.revision - 1)
                  const isOpen = openDiff === r.id
                  return (
                    <div className={`wf-vrow${isActive ? ' is-active' : ''}`} key={r.id}>
                      <span className="wf-vbadge">rev {r.revision}</span>
                      <span className="wf-vname">{r.note}</span>
                      <span className="wf-vauthor">{r.author ?? 'unattributed'}</span>
                      <span className="wf-vwhen">
                        {agoTs(new Date(r.createdAt).getTime())}
                        {/* The pointer's own history, from the two timestamps
                            the row has always carried and never shown. */}
                        <span className="wf-sub">
                          {isActive
                            ? `active since ${agoTs(new Date(r.activatedAt!).getTime())}`
                            : r.supersededAt && r.activatedAt
                              ? `was active ${agoTs(new Date(r.activatedAt).getTime())} → ${agoTs(new Date(r.supersededAt).getTime())}`
                              : r.supersededAt
                                ? 'set aside without ever running'
                                : 'never activated'}
                        </span>
                      </span>
                      <span className="wf-vstate">
                        {isActive ? (
                          <span className="acr-pg-statechip running">active</span>
                        ) : isDraft ? (
                          <span className="acr-pg-statechip wf-chip-ready">draft</span>
                        ) : (
                          <span className="acr-pg-statechip wf-chip-off">superseded</span>
                        )}
                        <span className="wf-sub">
                          {isDraft
                            ? 'never ran — it has never been active'
                            : servedSentence(runsByRevision.get(r.id) ?? 0)}
                        </span>
                      </span>
                      <span className="wf-vactions">
                        {isActive && builtin ? (
                          <button className="acr-btn ghost" onClick={() => void revert()}>
                            Revert to built-in
                          </button>
                        ) : !isActive ? (
                          /* S4.b — `activateWorkflowRevision` supersedes whatever
                             is active and points at ANY target; it has never
                             refused a superseded one. The UI offered this only
                             on a never-activated draft, which left a custom
                             with no rollback at all — it has no
                             revert-to-built-in, because there is no code to
                             return to. Same endpoint, same semantics, now
                             reachable from the row that needs it. */
                          <button
                            className="acr-btn ghost"
                            title={
                              isDraft
                                ? 'Make this recorded draft the wiring that runs'
                                : 'Go back to this wiring — it becomes active again, and what runs now is set aside'
                            }
                            onClick={() => { setActErr(null); setPendingAct(r) }}
                          >
                            {isDraft ? 'Activate…' : 'Make this active…'}
                          </button>
                        ) : null}
                        <button
                          className="acr-btn ghost wf-vdiffbtn"
                          aria-expanded={isOpen}
                          onClick={() => setOpenDiff(isOpen ? null : r.id)}
                        >
                          {isOpen ? 'Hide' : 'What changed'}
                        </button>
                      </span>
                      {isOpen ? (
                        <div className="wf-vdiff">
                          <span className="wf-vdiff-k">
                            {prev
                              ? `what rev ${r.revision} changed, against rev ${prev.revision}`
                              : `what rev ${r.revision} introduced`}
                          </span>
                          <DiffList diff={computeDiff(prev ? prev.definition : EMPTY_DEF, r.definition)} />
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </>
            ) : null}
            {builtin && (!vers || vers.revisions.length === 0) ? (
              <p className="wf-vnote">
                No changes have ever been published — this routine runs the wiring that ships
                in code.
              </p>
            ) : null}
            {builtin ? (
              /* A peer row on the same grid — it genuinely has fewer facts, so
                 its description spans the columns it has nothing to put in,
                 and its state chip still lands in the state column. */
              <div className={`wf-vrow is-builtin${!vers || vers.source !== 'revision' ? ' is-active' : ''}`}>
                <span className="wf-vbadge neutral">v1</span>
                <span className="wf-vname">
                  Built-in — defined in code
                  <span className="wf-sub">
                    {!vers || vers.source !== 'revision'
                      ? 'the wiring that ships with the fleet'
                      : 'the fallback every revert returns to'}
                  </span>
                </span>
                <span className="wf-vstate">
                  {!vers || vers.source !== 'revision' ? (
                    <span className="acr-pg-statechip running">active</span>
                  ) : (
                    <span className="acr-pg-statechip wf-chip-off">set aside</span>
                  )}
                  {/* Runs that carry no revision stamp ran the code path — so
                      the built-in closes the same loop the revisions do. */}
                  <span className="wf-sub">
                    {servedSentence(runsByRevision.get(CODE_PATH) ?? 0)}
                  </span>
                </span>
                <span className="wf-vactions" />
              </div>
            ) : vers && vers.revisions.length === 0 ? (
              <p className="wf-vnote">
                No published wiring yet. A custom routine has no code fallback — until you publish
                a first revision from the editor, it is honestly nothing.
              </p>
            ) : null}
            <p className="wf-vnote">
              Every change to this routine is an immutable revision: a mandatory note saying why,
              a readable diff of steps, connections, gates and trigger
              {builtin ? ', and a one-click return to the built-in that cannot fail' : ''}. Every
              run will stamp the revision that served it. Editing never changes what runs until
              you publish.
            </p>
          </div>
        </section>

        <HowWorkflowsWork />

        {runDialog ? (
          <div className="acr-pg-confirmwrap" role="dialog" aria-modal="true">
            <div className="acr-pg-confirm">
              <h4>Run this routine now?</h4>
              <p>
                This is a <strong>real run</strong>: findings write to the shared board, and
                anything proposed still waits for <Term k="approval">your approval</Term>.
                Workers that are OFF skip — the dials decide what actually executes. Estimated
                cost if every worker runs:{' '}
                <strong>
                  {runEstimate != null ? `$${runEstimate.toFixed(4)}` : 'estimating…'}
                </strong>
                .
              </p>
              {runErr ? <p className="acr-pg-warn">{runErr}</p> : null}
              <div className="acr-pg-confirmbtns">
                <button className="acr-btn" onClick={() => setRunDialog(false)} disabled={runBusy}>
                  Cancel
                </button>
                <button className="acr-btn primary" disabled={runBusy} onClick={() => void runNow()}>
                  {runBusy ? 'Starting…' : 'Run it'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {toggleDialog ? (
          <div className="acr-pg-confirmwrap" role="dialog" aria-modal="true">
            <div className="acr-pg-confirm">
              <h4>{toggleDialog === 'off' ? 'Turn this routine off?' : 'Turn this routine on?'}</h4>
              <p>
                {toggleDialog === 'off' ? (
                  <>
                    Its clock disarms this moment, Run now is refused, and nothing launches until
                    you turn it back on. The wiring and every version stay exactly as they are.
                  </>
                ) : (
                  <>
                    If its published wiring is on a clock, the clock re-arms this moment. Workers
                    that are OFF still skip — the dials on the Workers page decide what actually
                    executes, and nothing can spend while they are off.
                  </>
                )}
              </p>
              {toggleErr ? <p className="acr-pg-warn">{toggleErr}</p> : null}
              <div className="acr-pg-confirmbtns">
                <button
                  className="acr-btn"
                  onClick={() => setToggleDialog(null)}
                  disabled={toggleBusy}
                >
                  Cancel
                </button>
                <button
                  className="acr-btn primary"
                  disabled={toggleBusy}
                  onClick={() => void setEnabled(toggleDialog === 'on')}
                >
                  {toggleBusy ? 'Working…' : toggleDialog === 'off' ? 'Turn it off' : 'Turn it on'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {pendingAct && vers ? (
          <div className="acr-pg-confirmwrap" role="dialog" aria-modal="true">
            <div className="acr-pg-confirm">
              <h4>Activate rev {pendingAct.revision}?</h4>
              <DiffList
                diff={computeDiff(
                  vers.effective ?? vers.code ?? EMPTY_DEF,
                  pendingAct.definition,
                )}
              />
              <p>
                This makes rev {pendingAct.revision} the active wiring — what actually runs,
                starting now. If its trigger is a clock, the clock re-arms this moment.
                {builtin ? ' Revert stays one click.' : ''}
              </p>
              {/* S4.b — the settled copy is accurate in both directions but
                  names neither. A restore is the direction worth stating: it
                  is the one where something already running gets set aside,
                  and on a custom there is no revert to fall back on. Added,
                  not rewritten. */}
              {pendingAct.activatedAt ? (
                <p>
                  This one ran before, so this is a step back:{' '}
                  {(() => {
                    const cur = vers.revisions.find((x) => x.activatedAt && !x.supersededAt)
                    return cur
                      ? `rev ${cur.revision} is set aside and stops running.`
                      : 'whatever is running now is set aside.'
                  })()}{' '}
                  Nothing is rewritten — the numbers stay put, so a run that stamped rev{' '}
                  {pendingAct.revision} still means rev {pendingAct.revision}.
                </p>
              ) : null}
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
    </div>
  )
}
