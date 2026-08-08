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
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import {
  CHIP_CLASS,
  agoTs,
  prettyCron,
  until,
  type RoutineStatus,
  type RunGroup,
  type ScheduleJob,
} from './lib'
import type { BuiltinRoutine } from './routines'

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

const KIND_HINT: Record<'builtin' | 'custom', string> = {
  builtin:
    'Ships with the fleet. Its wiring comes from code; publish a revision to change it, and reverting to the built-in can never fail.',
  custom:
    'You created this one. It runs only what you published, and it can be switched off from its own page.',
}

export function RoutineCard(props: RoutineCardProps) {
  const { routineKey, name, purpose, touch, kind, builtin, status, groups, job } = props
  const trigger = triggerLine(props)
  const version = versionChip(props)
  const last = groups[0] ?? null
  const dots = groups.slice(0, 8).reverse()
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
        <span className="wf-card-name">
          {builtin?.termKey ? <Term k={builtin.termKey}>{name}</Term> : name}
        </span>
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

          {groups.length > 0 ? (
            <span className="wf-recent">
              <span className="wf-dots" aria-label={`Last ${dots.length} runs, oldest first`}>
                {dots.map((g) => (
                  <span
                    key={g.id}
                    className={`wf-dot ${g.running ? 'run' : g.halted ? 'halt' : g.ok ? 'ok' : 'fail'}`}
                    title={`${new Date(g.startedAt).toLocaleString()} — ${g.running ? 'running now' : g.halted ? 'stopped early' : g.ok ? 'ok' : 'failed'}`}
                  />
                ))}
              </span>
              <span className="wf-sub">
                {groups.length > dots.length
                  ? `latest ${dots.length} of ${groups.length} runs`
                  : `${groups.length} run${groups.length === 1 ? '' : 's'} on record`}
              </span>
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  )
}
