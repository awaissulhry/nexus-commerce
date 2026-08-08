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
import {
  CHIP_CLASS,
  agoTs,
  fmtDuration,
  prettyCron,
  until,
  type RoutineStatus,
  type RunGroup,
  type ScheduleJob,
} from './lib'
import type { BuiltinRoutine } from './routines'

/* ── S1.b — the run-history strip ────────────────────────────────────────
   Was eight 8px dots that encoded outcome and nothing else, capped silently
   at 8 while the caption said "43 runs on record". Airflow's DAG cards spend
   the same ink on two dimensions — colour for how a run ended, HEIGHT for how
   long it took — and we already compute `durationMs` per orchestration in
   lib.ts and threw it away here.

   The honesty rules the shipped list established carry over exactly: a run
   still in flight is never drawn as a failure, a routine that has never run
   gets UiPath's grey — twelve empty slots, a state rather than an absence —
   and the cap is stated on screen ("latest 12 of 43"), not only in an
   aria-label. Nothing is inferred: a group whose duration was never recorded
   draws at a neutral mid height and says so when you hover it. */
const MAX_BARS = 12
const BAR_MIN = 6
const BAR_MAX = 24
/** Neutral height for a group whose duration is unknown — never zero, which
 *  would read as "instant", and never full, which would read as "slowest". */
const BAR_UNKNOWN = 13

function outcomeWord(g: RunGroup): string {
  return g.running ? 'running now' : g.halted ? 'stopped early' : g.ok ? 'ok' : 'failed'
}
function outcomeClass(g: RunGroup): string {
  return g.running ? 'run' : g.halted ? 'halt' : g.ok ? 'ok' : 'fail'
}

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

/** The version chip: every card carries one. Three of four rows used to
 *  carry nothing, because a built-in on the code default has no revision —
 *  which is a fact worth stating, not an absence worth hiding. */
function versionChip(p: RoutineCardProps): { label: string; neutral: boolean; hint: string } {
  if (p.activeRevisionNo != null) {
    return {
      label: `rev ${p.activeRevisionNo}`,
      neutral: false,
      hint: `Running published revision ${p.activeRevisionNo}. Every run stamps the revision that served it.`,
    }
  }
  if (p.source === 'code') {
    return {
      /* Not "built-in wiring" — it sits beside a "Built-in" badge and the pair
         read as a stutter. "As shipped" says the same thing and says it to a
         beginner: no revision has ever been published over this one. */
      label: 'as shipped',
      neutral: true,
      hint: 'No revision published — this routine runs the wiring that ships in code. Reverting to it can never fail.',
    }
  }
  return {
    label: 'not composed yet',
    neutral: true,
    hint: 'No wiring published, so there is nothing to run. Compose it in the editor and publish a first revision.',
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

const KIND_HINT: Record<'builtin' | 'custom', string> = {
  builtin:
    'Ships with the fleet. Its wiring comes from code; publish a revision to change it, and reverting to the built-in can never fail.',
  custom:
    'You created this one. It runs only what you published, and it can be switched off from its own page.',
}

export function RoutineCard(props: RoutineCardProps) {
  const { routineKey, name, purpose, touch, kind, builtin, status, groups, job, chain } = props
  const trigger = triggerLine(props)
  const version = versionChip(props)
  const last = groups[0] ?? null
  /* Oldest on the left, so the strip reads left-to-right like time does. */
  const bars = groups.slice(0, MAX_BARS).reverse()
  const longest = Math.max(
    0,
    ...bars.map((g) => (g.running ? 0 : (g.durationMs ?? 0))),
  )
  const barHeight = (g: RunGroup): number => {
    if (g.running) return BAR_MAX
    const d = g.durationMs
    if (d == null || d <= 0 || longest <= 0) return BAR_UNKNOWN
    return BAR_MIN + Math.round((BAR_MAX - BAR_MIN) * (d / longest))
  }
  const barTitle = (g: RunGroup): string => {
    const when = new Date(g.startedAt).toLocaleString()
    const took = g.running
      ? 'still running'
      : g.durationMs != null && g.durationMs > 0
        ? `took ${fmtDuration(g.durationMs)}`
        : 'duration not recorded'
    return `${when} — ${outcomeWord(g)}, ${took}`
  }
  const stripHint = bars.length
    ? 'Each bar is one run, oldest on the left. Its colour is how the run ended; its height is how long it took, next to the longest run shown here.'
    : 'No runs recorded for this routine yet. Each slot will fill with one run.'
  const stripCaption = !groups.length
    ? 'nothing to chart yet'
    : groups.length > bars.length
      ? `latest ${bars.length} of ${groups.length} runs`
      : `${groups.length} run${groups.length === 1 ? '' : 's'} on record`
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

          <span className="wf-recent">
            <span className="wf-bars" title={stripHint} aria-label={stripHint}>
              {/* Empty slots come FIRST. The strip reads left to right like
                  time does, so the unfilled past belongs on the left and the
                  newest run belongs hard against the right edge. Filling from
                  the left instead put one run at the far left with eleven
                  blanks after it, which reads as eleven runs still to come.
                  UiPath's rule holds either way: never-run is twelve grey
                  slots — a state, not an absence. */}
              {Array.from({ length: MAX_BARS - bars.length }, (_, i) => (
                <span key={`slot-${i}`} className="wf-bar empty" />
              ))}
              {bars.map((g) => (
                <span
                  key={g.id}
                  className={`wf-bar ${outcomeClass(g)}`}
                  style={{ height: `${barHeight(g)}px` }}
                  title={barTitle(g)}
                />
              ))}
            </span>
            <span className="wf-sub">{stripCaption}</span>
          </span>
        </div>
      </div>
    </Link>
  )
}
