'use client'

/**
 * NAF.WF-S1R / S1.a — one routine, as a card.
 *
 * Replaces the six-column table the list shipped at WF.1. The study (Part 9
 * of docs/2026-08-07-naf-wf-workflows-page.md) measured why: four of those
 * six columns carry SENTENCES, and a table is a device for comparing values
 * down a column. `table-layout: auto` sized the columns by whichever row
 * happened to hold the longest string, and `vertical-align: middle` centred
 * every cell independently — a 19.8px ragged edge per row, on prod.
 *
 * The fix is structural, not cosmetic: three FIXED lanes in a grid. Lane k
 * starts at the same x in every card and every lane starts at the same y, so
 * the alignment cannot drift no matter what any row's text does.
 *
 * This file RENDERS ONLY. Every status word, every reason, every honest
 * sentence comes in as props exactly as `lib.ts` derived it — S1.a changes
 * no derivation, no feed, no contract. What it changes is legibility: the
 * reason for a status used to render at 4.05:1 and the purpose at 2.73:1,
 * i.e. the page's most load-bearing truths were its least readable text.
 */

import Link from 'next/link'
import { ArrowRight, Clock, Play, Shield } from 'lucide-react'
import { RunBars } from './RunBars'
import {
  CHIP_CLASS,
  KIND_HINT,
  agoTs,
  prettyCron,
  until,
  versionChipFor,
  type RoutineStatus,
  type RunGroup,
  type ScheduleJob,
} from './lib'
import type { BuiltinRoutine } from './routines'

/** NAF.WF-S1R / S1.c — one link in the "who hands to whom" chain. */
export interface ChainStep {
  /** Charter key when a worker runs; null for code steps and the gate. */
  charterKey: string | null
  label: string
  kind: 'worker' | 'code' | 'gate'
  /** Worker steps only: is this worker switched on right now. */
  on?: boolean
}

export interface RoutineCardProps {
  routineKey: string
  name: string
  purpose: string
  touch: string
  kind: 'builtin' | 'custom'
  /** Where the effective wiring comes from — drives the version chip. */
  source: 'code' | 'revision' | 'none'
  builtin: BuiltinRoutine | null
  status: RoutineStatus
  groups: RunGroup[]
  job: ScheduleJob | null
  activeRevisionNo: number | null
  /** Empty when there is no effective wiring — the card then says so. */
  chain: ChainStep[]
}

/** The trigger, as one line: what starts it, and when that is next.
 *  Every branch is the WF.1/WF.6 wording, moved verbatim — a routine with no
 *  clock evidence says so rather than inventing one. */
function triggerLine(p: RoutineCardProps): { main: string; sub: string } {
  const { job, kind, status } = p
  if (job) {
    return {
      /* prettyCron already answers 'manual' with "When you start it" — the
         schedule feed reports a stored manual trigger that way (WF.4c). */
      main: prettyCron(job.schedule),
      sub: job.enabled
        ? (until(job.nextFireAt) ? `next ${until(job.nextFireAt)}` : 'next time unknown')
        : 'not scheduled — the clock is off',
    }
  }
  if (kind === 'builtin') {
    return { main: 'When you start it', sub: 'from a worker’s page, or the console' }
  }
  return {
    main: 'When you start it',
    sub: status.kind === 'ready' ? 'Run now, from its page' : 'publish a first revision to run it',
  }
}

/** Every pill explains itself, and a worker's pill also says whether it will
 *  actually do anything — the dials live on another page, so the chain is
 *  where a beginner first meets the consequence. */
function stepHint(s: ChainStep): string {
  if (s.kind === 'gate') return `${s.label} — a person decides here; nothing passes it on its own.`
  if (s.kind === 'code') return `${s.label} — deterministic code, not judgment. It always runs.`
  return s.on === false
    ? `${s.label} is switched OFF, so this step is skipped and costs nothing. The Workers page decides.`
    : `${s.label} is switched on and will run when this routine does.`
}

export function RoutineCard(props: RoutineCardProps) {
  const { routineKey, name, purpose, touch, kind, builtin, status, groups, job, chain } = props
  const trigger = triggerLine(props)
  const version = versionChipFor({ activeRevisionNo: props.activeRevisionNo, source: props.source })
  const last = groups[0] ?? null
  /* The glyph is the trigger TYPE, not its state: a routine with a clock is a
     clock routine even when the clock is off. No clock evidence → by hand,
     which is exactly what the sentence beside it says. */
  const scheduled = Boolean(job ?? builtin?.scheduleKey)

  return (
    <Link className="wf-card" href={`/fleet/workflows/${routineKey}`}>
      <div className="wf-card-head">
        <span className={`wf-glyph k-${status.kind}`} aria-hidden>
          {scheduled ? <Clock size={15} /> : <Play size={15} />}
        </span>
        {/* S1.d — no <Term> on the name any more. The whole card is a link
            now, and a Term is a tabIndex={0} span, so it put a second focus
            stop inside the link whose Enter key activates the link anyway.
            The definition it carried is better served by the purpose sentence
            directly below it and by the chain beside that. */}
        <span className="wf-card-name">{name}</span>
        <span className="wf-kind" title={KIND_HINT[kind]}>
          {kind === 'builtin' ? 'Built-in' : 'Custom'}
        </span>
        <span className={`wf-vbadge${version.neutral ? ' neutral' : ''}`} title={version.hint}>
          {version.label}
        </span>
        <span className="wf-card-spacer" />
        <span className="wf-card-when">
          {trigger.main}
          <span className="sep" aria-hidden>·</span>
          <span className="nx">{trigger.sub}</span>
        </span>
        <span className="wf-card-go" aria-hidden>
          <ArrowRight size={15} />
        </span>
      </div>

      <div className="wf-card-body">
        <div className="wf-lane wf-lane-what">
          <p className="wf-purpose">{purpose}</p>
          {/* S1.c — the routine's shape, at a glance. This is the one thing
              the old list never showed: a beginner could read four sentences
              and still not know a routine IS a sequence of workers. A worker
              that is switched off renders muted, so "the clock ticks, but
              every worker is off" is visible as well as stated. */}
          {chain.length ? (
            <span className="wf-chain">
              {chain.map((s, i) => (
                <span key={`${s.charterKey ?? s.kind}-${i}`} className="wf-chainitem">
                  {i > 0 ? <span className="wf-chainarrow" aria-hidden>→</span> : null}
                  <span
                    className={`wf-step k-${s.kind}${s.kind === 'worker' && s.on === false ? ' is-off' : ''}`}
                    title={stepHint(s)}
                  >
                    {s.label}
                  </span>
                </span>
              ))}
            </span>
          ) : (
            <span className="wf-chain-empty">
              No wiring published yet — nothing would run.
            </span>
          )}
        </div>

        <div className="wf-lane wf-lane-where">
          <span className={`acr-pg-statechip ${CHIP_CLASS[status.kind]}`}>{status.label}</span>
          <p className="wf-why">{status.why}</p>
        </div>

        <div className="wf-lane wf-lane-reach">
          <p className="wf-touch">
            <Shield size={12} aria-hidden /> <span>{touch}</span>
          </p>
        </div>

        <div className="wf-lane wf-lane-rhythm">
          <span className="wf-lane-k">Last run</span>
          {last ? (
            <>
              <span className="wf-lastline">
                {agoTs(last.startedAt)}
                <span className="sep" aria-hidden>·</span>
                {last.running ? (
                  <span className="wf-run">running now…</span>
                ) : last.halted ? (
                  <span className="wf-halt">stopped early</span>
                ) : last.ok ? (
                  <span className="acr-pg-ok">ok</span>
                ) : (
                  <span className="acr-pg-warn">failed</span>
                )}
              </span>
              <span className="wf-sub">
                ${last.costUSD.toFixed(4)} · {last.findings} finding
                {last.findings === 1 ? '' : 's'}
                {last.runs > 1 ? ` · ${last.runs} workers` : ''}
              </span>
            </>
          ) : job?.lastRun ? (
            /* Dagster's tick-vs-run lesson, shipped at WF.1 and kept word for
               word: the clock firing and launching nothing IS the answer to
               "why didn't it run?" — say it, never show a bare "never". */
            <>
              <span className="wf-lastline muted">no runs yet</span>
              <span className="wf-sub">
                clock last fired {agoTs(new Date(job.lastRun.startedAt).getTime())} and launched
                nothing — every worker was off
              </span>
            </>
          ) : (
            <span className="wf-lastline muted">never run</span>
          )}

          <RunBars groups={groups} />
        </div>
      </div>
    </Link>
  )
}
