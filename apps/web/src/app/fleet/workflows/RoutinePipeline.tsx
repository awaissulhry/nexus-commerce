'use client'

/**
 * NAF.WF-S2R / S2.c — the routine's pipeline, as a deterministic block.
 *
 * Replaces the xyflow canvas IN THIS ZONE. `RoutineCanvas.tsx` is untouched
 * and still serves `RoutineEditor` — a live canvas while you wire a draft is
 * a different job from a run report, and that call belongs to S5.
 *
 * Why it changed, measured on prod (Part 10 §10.1 of the WF doc): the canvas
 * rendered 9.4% node ink on the sweep, 5.0% on the custom with 682px dead on
 * EACH side, and 4.5% on the council — where `fitView` had scaled the node
 * sub to 5.00px and the edge label to 4.55px. The fitted zoom was not even a
 * function of the graph and the viewport: the same URL measured 0.455 once and
 * 1.0 on three later loads, because `fitView` runs at mount and nothing
 * re-fits.
 *
 * The deeper reason is Airflow's: a graph earns its area by being a view of a
 * RUN, not a diagram of a definition. The old canvas drew the wiring plus a
 * live autonomy tint and nothing else — switch the routine OFF and the picture
 * did not change. Every row here carries what the step is, whether it will
 * run, and what it did last time.
 *
 * Honesty rules that live in this file because they cannot be re-derived:
 *  - a CODE step has no AgentRun. Grading, report cards and the approval gate
 *    are job-code ordering, so they say "always runs · not separately timed"
 *    and never borrow an outcome.
 *  - a worker with no row in the newest group DID NOT RUN, and the reason is
 *    already known from the same charter feed the status sentence reads: it
 *    was off. Three surfaces, one source, no way to disagree.
 *  - a run still in flight is "working now…", never a failure.
 */

import { ArrowRight } from 'lucide-react'
import { fmtDuration, type CharterRow, type RunGroup, type RunRow } from './lib'
import type { RoutineStory, StoryStep } from './routines'

export interface RoutinePipelineProps {
  story: RoutineStory
  charters: CharterRow[]
  /** The newest orchestration of this routine, or null if it never ran. */
  lastGroup: RunGroup | null
  /** Set when the ROUTINE itself cannot run — switched off, or the fleet is
   *  halted. Distinct from a worker being off: those are step-level facts the
   *  cards already carry, and D7 was about the picture not changing when the
   *  routine's own state did. */
  blockedReason?: string | null
}

/** What crosses INTO a level — the artifact named once, in the gutter, so a
 *  label can never overlap a node the way nine of them did on the canvas. */
function incomingArtifact(story: RoutineStory, levelStepIds: string[]): string | null {
  for (const e of story.edges) {
    if (levelStepIds.includes(e.to) && e.label) return e.label
  }
  return null
}

function roleOf(s: StoryStep, c: CharterRow | undefined): { label: string; cls: string } {
  if (s.kind === 'gate') return { label: 'you decide', cls: 'k-gate' }
  if (s.kind === 'code') return { label: 'code', cls: 'k-code' }
  const lvl = c?.autonomyLevel ?? 'OFF'
  return { label: lvl, cls: `lvl-${lvl.toLowerCase()}` }
}

export function RoutinePipeline({ story, charters, lastGroup, blockedReason }: RoutinePipelineProps) {
  const byKey = new Map(charters.map((c) => [c.key, c]))
  /* The newest orchestration's rows, by worker. A step missing from this map
     simply did not run in that orchestration — which is a fact, not a gap. */
  const lastByKey = new Map<string, RunRow>()
  for (const r of lastGroup?.rows ?? []) if (!lastByKey.has(r.agentKey)) lastByKey.set(r.agentKey, r)

  const cols = [...new Set(story.steps.map((s) => s.col))].sort((a, b) => a - b)
  const levels = cols.map((col) => story.steps.filter((s) => s.col === col))
  /* A routine with one stage runs its steps side by side, so it is drawn side
     by side. Stacking two cards in a full-width column is how the canvas ended
     up 87% empty. */
  const solo = levels.length === 1

  return (
    <>
      {blockedReason ? (
        <p className="wf-pipe-blocked" role="status">{blockedReason}</p>
      ) : null}
      <div className={`wf-pipe${solo ? ' is-solo' : ''}${blockedReason ? ' is-blocked' : ''}`}>
      {levels.map((steps, i) => {
        const artifact = i > 0 ? incomingArtifact(story, steps.map((s) => s.id)) : null
        return (
            <div className="wf-pipe-level" key={cols[i]}>
              {/* The artifact rides the stage label. As its own grid column it
                  took an equal 1fr share — four gutters ate 698px of 1572 and
                  squeezed every card to 174.7px, which is how a layout meant to
                  remove dead width invented some. */}
              <span className="wf-pipe-levelk">
                {i > 0 ? <ArrowRight size={11} className="wf-pipe-arrow" aria-hidden /> : null}
                {steps.length > 1 ? 'at the same time' : i === 0 ? 'first' : 'then'}
                {artifact ? <span className="wf-pipe-artifact">{artifact}</span> : null}
              </span>
              <div className="wf-pipe-steps">
                {steps.map((s) => {
                  const c = s.charterKey ? byKey.get(s.charterKey) : undefined
                  const role = roleOf(s, c)
                  const isWorker = s.kind === 'worker'
                  const on = isWorker && c ? c.enabled && c.autonomyLevel !== 'OFF' : true
                  const run = s.charterKey ? lastByKey.get(s.charterKey) : undefined
                  return (
                    <div
                      key={s.id}
                      className={`wf-pipe-step k-${s.kind}${isWorker && !on ? ' is-off' : ''}`}
                    >
                      <span className="wf-pipe-head">
                        <span className="nm">{s.label}</span>
                        <span className={`wf-pipe-role ${role.cls}`}>{role.label}</span>
                      </span>
                      <span className="wf-pipe-sub">{s.sub}</span>
                      {c?.degraded ? (
                        <span className="wf-pipe-deg">
                          settings unreadable — this shows the fail-safe posture, not your choice
                        </span>
                      ) : null}
                      <span className="wf-pipe-last">
                        {!isWorker ? (
                          <span className="muted">always runs · not separately timed</span>
                        ) : !lastGroup ? (
                          <span className="muted">never run</span>
                        ) : run ? (
                          run.status === 'running' ? (
                            <span className="wf-run">working now…</span>
                          ) : run.haltedReason ? (
                            <span className="wf-halt">stopped early · {run.haltedReason}</span>
                          ) : (
                            <>
                              <span className={run.ok ? 'acr-pg-ok' : 'acr-pg-warn'}>
                                {run.ok ? 'ok' : 'failed'}
                              </span>
                              <span className="sep" aria-hidden>·</span>
                              {fmtDuration(
                                run.endedAt
                                  ? new Date(run.endedAt).getTime() -
                                      new Date(run.createdAt).getTime()
                                  : null,
                              )}
                              <span className="sep" aria-hidden>·</span>${Number(run.costUSD || 0).toFixed(4)}
                              <span className="sep" aria-hidden>·</span>
                              {run.findingCount} finding{run.findingCount === 1 ? '' : 's'}
                            </>
                          )
                        ) : (
                          <span className="muted">
                            {on ? 'did not run last time' : 'skipped — it was switched off'}
                          </span>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
        )
      })}
      </div>
    </>
  )
}
