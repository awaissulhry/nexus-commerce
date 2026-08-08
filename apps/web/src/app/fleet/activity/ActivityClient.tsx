'use client'

/**
 * NAF.SB.ACT.2 — the Activity list.
 *
 * The page is the fleet's RECORD: everything it has done, newest first. Three
 * rules from docs/2026-08-07-naf-sbact-activity-page.md drive every decision
 * in this file, and each one is a rule about honesty rather than about looks:
 *
 * 1. **A record is read, not operated.** There is no retry, re-run, approve or
 *    halt here. Every one of those lives on the page that owns it, one click
 *    away. A halted fleet gets a BANNER with a link to Controls — never a stop
 *    button, because two stop buttons is worse than one.
 *
 * 2. **A record must be complete, or say where it is not.** Nothing is capped,
 *    filtered or rolled up without the page saying so in words and offering the
 *    way back. That is why the self-test is *excluded, never concealed*: the
 *    toggle is on screen, the rows are badged, and the footnote counts them.
 *
 * 3. **A record must not editorialise.** No percentage of all history appears
 *    anywhere. 24 of the 25 severe failures in this fleet's life belong to the
 *    self-test inside one six-minute window on 6 August that was diagnosed and
 *    closed; a page that renders "49% of runs fail" sends an operator hunting a
 *    fault that no longer exists. Counts and dates only.
 *
 * The vocabulary is NOT decided here. Every sentence arrives built from
 * `fleet-timeline.service.ts`, so this file decides how things LOOK and never
 * what they MEAN. The one exception is the rolled-up phrasing, because only the
 * client knows how many rows collapsed together.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ClipboardList,
  FlaskConical,
  Gauge,
  Hand,
  HelpCircle,
  Loader,
  Octagon,
  Download,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { DataGrid, type Column } from '@/design-system/components'
import { GridToolbar } from '@/design-system/patterns'
import { PlanStory, type PlanLabels, type StoryPlan } from '@/app/marketing/ads/rules-automation/fleet/PlanStory'
import { FleetPageShell } from '../_shell/FleetPageShell'
import { RunDetail } from '../_shared/RunDetail'
import {
  ago,
  classifyFailure,
  DIAGNOSTIC_HINT,
  type Blame,
  type FailureClass,
} from '../_shared/run-health'
import { useVisibilityPoll } from '../_shared/use-visibility-poll'

/* ── the shape the spine returns (ACT.1) ───────────────────────────────── */

export type FleetEventKind =
  | 'run.ok'
  | 'run.failed'
  | 'run.running'
  | 'finding.raised'
  | 'plan.drafted'
  | 'plan.critiqued'
  | 'approval.requested'
  | 'approval.decided'
  | 'fleet.halted'

export type FleetEventOutcome = 'ok' | 'attention' | 'bad' | 'neutral'

export interface FleetEvent {
  id: string
  at: string
  kind: FleetEventKind
  actorKind: 'worker' | 'human' | 'system'
  actor: string
  actorKey: string | null
  title: string
  detail: string | null
  outcome: FleetEventOutcome
  source: string
  riskTier: string | null
  costUSD: number | null
  entity: { type: string; id: string; name: string | null } | null
  episodeId: string | null
  workflowKey: string | null
  dataVintage: string | null
  diagnostic: boolean
  /** ACT.3 — runs only; null on every other kind. */
  durationMs: number | null
  findingCount: number | null
  /** ACT.5 — the run behind this event; opens the "what it did" drawer. */
  runId: string | null
  /** ACT.4 — raw, so the ONE canonical classifier decides what "failed" means. */
  errorMessage: string | null
  haltedReason: string | null
  /** ACT.4b — badge a test run from this, never from the prose. */
  mode: string | null
  href: string | null
  rollupKey: string
}

interface TimelinePage {
  events: FleetEvent[]
  nextCursor: string | null
  total: number
  countsByKind: Record<string, number>
  actors: Array<{ key: string; name: string; kind: string }>
}

interface FleetStateRow {
  halted: boolean
  haltReason: string | null
  haltedBy: string | null
  haltedAt: string | null
  dailyCeilingUSD: number
  degraded: boolean
}

/* ── how each kind looks and reads ─────────────────────────────────────── */

/** Every kind gets a DIFFERENT icon, so shape alone tells them apart —
 *  colour is never the only signal (WCAG, and the DT.8 teaching gate). */
const MARKER: Record<FleetEventKind, { icon: typeof Check; label: string }> = {
  'run.ok': { icon: Check, label: 'a run that finished' },
  'run.failed': { icon: X, label: 'a run that failed' },
  'run.running': { icon: Loader, label: 'a run happening right now' },
  'finding.raised': { icon: CircleDot, label: 'something a worker found' },
  'plan.drafted': { icon: ClipboardList, label: 'a plan the director wrote' },
  'plan.critiqued': { icon: ShieldCheck, label: "the critic's ruling" },
  'approval.requested': { icon: Hand, label: 'a request for your permission' },
  'approval.decided': { icon: Check, label: 'a decision a person took' },
  'fleet.halted': { icon: Octagon, label: 'the fleet stopping' },
}

/** The state as a WORD. A clean run needs no badge — the tick says it. */
const STATE_WORD: Record<FleetEventOutcome, string | null> = {
  ok: null,
  attention: 'needs a look',
  bad: 'failed',
  neutral: null,
}

/**
 * How a collapsed group reads. Only the client knows the count, so this one
 * scrap of vocabulary has to live here rather than on the server.
 */
function rollupSentence(first: FleetEvent, n: number): string {
  switch (first.kind) {
    case 'run.failed':
      return `${first.actor} failed ${n} runs, every one the same way`
    case 'run.ok':
      return `${first.actor} completed ${n} runs`
    case 'finding.raised':
      return `${first.actor} found ${n} more of the same`
    case 'approval.requested':
      return `${first.actor} asked permission ${n} times for the same kind of action`
    case 'approval.decided':
      return `${n} requests of the same kind were answered the same way`
    default:
      return `${first.title} · ${n} times`
  }
}

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

const dayKey = (iso: string) => new Date(iso).toISOString().slice(0, 10)

function dayLabel(key: string): string {
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  if (key === today) return 'Today'
  if (key === yesterday) return 'Yesterday'
  return new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
}

/** "6 August" — for the scope line, where a weekday adds nothing. */
const shortDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })

/* ── grouping ──────────────────────────────────────────────────────────── */

interface Rollup {
  key: string
  events: FleetEvent[]
}

/** Consecutive events with the same signature collapse into one line.
 *  Repetition is a fact about the fleet, not thirty-four facts. */
function rollUp(events: FleetEvent[]): Rollup[] {
  const out: Rollup[] = []
  for (const e of events) {
    const last = out[out.length - 1]
    if (last && last.key === e.rollupKey) last.events.push(e)
    else out.push({ key: e.rollupKey, events: [e] })
  }
  return out
}

interface Day {
  key: string
  rollups: Rollup[]
  count: number
}

function byDay(events: FleetEvent[]): Day[] {
  const out: Day[] = []
  for (const e of events) {
    const k = dayKey(e.at)
    const last = out[out.length - 1]
    if (last && last.key === k) last.rollups.push({ key: e.rollupKey, events: [e] })
    else out.push({ key: k, rollups: [{ key: e.rollupKey, events: [e] }], count: 0 })
  }
  // Roll up WITHIN a day, never across one — a day header between two
  // identical failures means they are two different days' worth of trouble.
  return out.map((d) => {
    const flat = d.rollups.flatMap((r) => r.events)
    return { key: d.key, rollups: rollUp(flat), count: flat.length }
  })
}

/* ── rows ──────────────────────────────────────────────────────────────── */

function Marker({ kind, outcome }: { kind: FleetEventKind; outcome: FleetEventOutcome }) {
  const m = MARKER[kind]
  const Icon = m.icon
  return (
    <span className={`sba-marker o-${outcome}`}>
      <Icon size={11} aria-hidden />
      <span className="sba-sr">{m.label}</span>
    </span>
  )
}

/** The badges that stop a row being mistaken for something it is not. */
function Badges({ event }: { event: FleetEvent }) {
  return (
    <>
      {event.diagnostic ? (
        <span className="sba-badge diag" title={DIAGNOSTIC_HINT}>
          self-test
        </span>
      ) : null}
      {event.mode === 'preview' ? (
        <span className="sba-badge test" title="A test run from the Workflows page. It read real evidence and used a real model, but nothing it decided was written.">
          test run
        </span>
      ) : null}
      {event.workflowKey ? <span className="sba-badge flow">{event.workflowKey}</span> : null}
    </>
  )
}

/**
 * ACT.5 — a row's title opens the drawer when there is a run behind it, and
 * stays a link otherwise. `<button>` rather than `<a>` on purpose: it opens a
 * panel on this page, and dressing that as a link breaks middle-click, "open
 * in new tab", and every expectation an anchor sets.
 */
function RowTitle({ event, onOpen }: { event: FleetEvent; onOpen: (e: FleetEvent) => void }) {
  const openable = event.runId != null || event.kind.startsWith('plan.') || event.kind === 'plan.critiqued'
  if (openable) {
    return (
      <button type="button" className="sba-open" onClick={() => onOpen(event)}>
        {event.title}
      </button>
    )
  }
  return event.href ? <Link href={event.href}>{event.title}</Link> : <>{event.title}</>
}

function EventRow({ event, onOpen }: { event: FleetEvent; onOpen: (e: FleetEvent) => void }) {
  const word = STATE_WORD[event.outcome]
  const vintageDiffers =
    event.dataVintage != null && dayKey(event.dataVintage) !== dayKey(event.at)
  return (
    <li className="sba-row" id={`e-${event.id}`}>
      <Marker kind={event.kind} outcome={event.outcome} />
      <div className="sba-body">
        <span className="sba-title">
          <RowTitle event={event} onOpen={onOpen} />
          <Badges event={event} />
        </span>
        <span className="sba-meta">
          <span>from {event.source}</span>
          {event.riskTier ? (
            <>
              <span className="sba-sep">·</span>
              <span className={`sba-risk r-${event.riskTier}`}>{event.riskTier} risk</span>
            </>
          ) : null}
          {word ? (
            <>
              <span className="sba-sep">·</span>
              <span className={`sba-state o-${event.outcome}`}>
                {event.outcome === 'attention' ? <AlertTriangle size={9} aria-hidden /> : null}
                {word}
              </span>
            </>
          ) : null}
          {event.costUSD != null && event.costUSD > 0 ? (
            <>
              <span className="sba-sep">·</span>
              <span>${event.costUSD.toFixed(4)}</span>
            </>
          ) : null}
          {vintageDiffers ? (
            <>
              <span className="sba-sep">·</span>
              {/* Findings are UPSERTED and have no updatedAt, so the row's date
                  is the FIRST sighting while its content is the latest. Saying
                  so is the difference between a record and a guess. */}
              <span className="sba-vintage">
                first seen this day · based on data from {shortDay(event.dataVintage!)}
              </span>
            </>
          ) : null}
        </span>
        {event.detail ? (
          <p className={`sba-detail${event.outcome === 'bad' ? ' bad' : ''}`}>{event.detail}</p>
        ) : null}
      </div>
      <time className="sba-time" dateTime={event.at} title={new Date(event.at).toLocaleString()}>
        {hhmm(event.at)}
      </time>
    </li>
  )
}

function RollupRow({ group, onOpen }: { group: Rollup; onOpen: (e: FleetEvent) => void }) {
  const [open, setOpen] = useState(false)
  const first = group.events[0]!
  const n = group.events.length
  if (n === 1) return <EventRow event={first} onOpen={onOpen} />
  return (
    <>
      <li className="sba-row">
        <Marker kind={first.kind} outcome={first.outcome} />
        <div className="sba-body">
          <span className="sba-title">
            {rollupSentence(first, n)}
            <Badges event={first} />
          </span>
          <span className="sba-meta">
            <span className="sba-count">{n}</span>
            <span>from {first.source}</span>
            <span className="sba-sep">·</span>
            <button
              type="button"
              className="sba-rollupbtn"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? (
                <>
                  <ChevronDown size={11} aria-hidden /> collapse these
                </>
              ) : (
                <>
                  <ChevronRight size={11} aria-hidden /> show all {n}
                </>
              )}
            </button>
          </span>
          {!open && first.detail ? (
            <p className={`sba-detail${first.outcome === 'bad' ? ' bad' : ''}`}>{first.detail}</p>
          ) : null}
        </div>
        <time className="sba-time" dateTime={first.at}>
          {hhmm(first.at)}
        </time>
      </li>
      {open ? group.events.map((e) => <EventRow key={e.id} event={e} onOpen={onOpen} />) : null}
    </>
  )
}

/* ── the runs grain ────────────────────────────────────────────────────── */

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s ? `${m}m ${s}s` : `${m}m`
}

/**
 * The row's sentence with the worker's name taken off the front — the Worker
 * column already says who, and repeating it in every cell reads as a stutter.
 */
function whatHappened(e: FleetEvent): string {
  const t = e.title
  return t.startsWith(e.actor) ? t.slice(e.actor.length).replace(/^\s+/, '') : t
}

/* ── the filter vocabulary ─────────────────────────────────────────────── */

/**
 * Plain English for each event kind. `fleet.halted` is here for completeness
 * but its chip only ever renders if the count is non-zero, and it is zero.
 */
const WHAT_LABEL: Record<string, string> = {
  'run.ok': 'Ran fine',
  'run.failed': 'Run failed',
  'run.running': 'Running now',
  'finding.raised': 'Noticed something',
  'plan.drafted': 'Drafted a plan',
  'plan.critiqued': 'Plan reviewed',
  'approval.requested': 'Asked permission',
  'approval.decided': 'Someone decided',
  'fleet.halted': 'Fleet halted',
}

/** The two kinds the Runs grain is. Named once so nothing can drift. */
const RUN_KINDS: FleetEventKind[] = ['run.ok', 'run.failed', 'run.running']

/* ── S2 · what needs a look ────────────────────────────────────────────── */

/**
 * Failure classes, counted through `run-health.classifyFailure` — the SAME
 * function the worker roster and the worker page call. That is the point: the
 * spine has its own `explainError`/`errorSignature`, and the two disagree about
 * whether a budget halt is a failure (it is not). This page refuses to be the
 * third opinion, so it takes the raw fields and asks the canonical classifier.
 *
 * Two traps this closes by construction:
 *  · a run still in flight is never counted — `classifyFailure` returns null
 *    for `status: 'running'`, which is why the spine now emits `run.running`;
 *  · nothing is ever grouped on the error STRING. The three credit errors each
 *    carry a distinct `request_id`, so a group-by on the message shows four
 *    causes where there are two.
 */
const CLASS_ORDER: FailureClass[] = [
  'provider-unreachable',
  'provider-refused',
  'contract',
  'unknown',
  'limit', // amber, and last: a limit doing its job is not a defect
]

/**
 * `classifyFailure().label` is written to follow a count — "3 of its runs
 * <label>" — and ONE of the five carries its own blame clause after an em-dash:
 * "could not reach the AI provider — a connection problem, not this worker".
 * Beside a meta line that names the blame anyway, that row said it twice.
 *
 * Trimming at the em-dash is presentation, not re-classification: the class,
 * the severity and the blame all still come from the one classifier. If the
 * Workers stream ever rewrites a label without the clause, this no-ops and the
 * row reads exactly as the label does — degrading to today's behaviour rather
 * than to a wrong one.
 */
const shortLabel = (label: string) => label.split(' — ')[0]!

/** Who to go and talk to, in words, on every row — so severity is carried by
 *  language as well as by shape and colour. Derived from `Failure.blame`, so it
 *  cannot drift away from the classification it describes. */
const BLAME_PHRASE: Record<Blame, string> = {
  worker: 'the worker itself',
  infrastructure: 'a connection problem, not the worker',
  billing: 'the AI account',
  nobody: 'a limit doing its job, nobody’s fault',
  unknown: 'no cause was recorded',
}

interface BandRow {
  klass: FailureClass
  label: string
  blame: Blame
  severe: boolean
  count: number
  /** Newest and oldest occurrence, for "· 6 August" and the hidden-note range. */
  newestAt: string
  oldestAt: string
  /** Any of these was a test-lane run. Badged, and never a reason to go red. */
  hasTestRun: boolean
}

/**
 * Group the failed runs by class, counted through `run-health.classifyFailure`
 * — the SAME function the worker roster and the worker page call. The spine has
 * its own `explainError`/`errorSignature` and the two disagree about whether a
 * budget halt is a failure (it is not); this page refuses to be the third
 * opinion, so it hands over the raw fields and asks the canonical classifier.
 *
 * Two traps closed by construction:
 *  · a run still in flight is never counted — the spine emits `run.running` as
 *    its own kind, so one cannot reach this function at all;
 *  · nothing is ever grouped on the error STRING. Measured on production: the
 *    three credit failures carry `request_id`s `req_011CdmDiDZC2…`,
 *    `req_011CdmDWHbwT2…` and `req_011Cdktigtn…`, so a group-by on the message
 *    renders three causes where there is one.
 */
function groupFailures(runs: FleetEvent[]): BandRow[] {
  const byClass = new Map<FailureClass, BandRow>()
  for (const e of runs) {
    if (e.kind !== 'run.failed') continue
    const f = classifyFailure({
      // Always 'done', and tsc proves it: `run.running` is its own kind, so a
      // run in flight cannot reach this line. The guard lives one layer down
      // rather than being copied — which is why the kind was added.
      status: 'done',
      ok: false,
      errorMessage: e.errorMessage,
      haltedReason: e.haltedReason,
      createdAt: e.at,
    })
    if (!f) continue
    const cur = byClass.get(f.klass)
    if (cur) {
      cur.count++
      if (e.at > cur.newestAt) cur.newestAt = e.at
      if (e.at < cur.oldestAt) cur.oldestAt = e.at
      cur.hasTestRun ||= e.mode === 'preview'
    } else {
      byClass.set(f.klass, {
        klass: f.klass,
        label: f.label,
        blame: f.blame,
        severe: f.severe,
        count: 1,
        newestAt: e.at,
        oldestAt: e.at,
        hasTestRun: e.mode === 'preview',
      })
    }
  }
  return CLASS_ORDER.filter((k) => byClass.has(k)).map((k) => byClass.get(k)!)
}

/**
 * What the band is saying right now. Seven values, and every one of them is a
 * different sentence — the three the previous build rendered as an identical
 * green tick are `checking`, `out-of-scope` and `error`.
 */
type BandKind =
  | 'checking'
  | 'out-of-scope'
  | 'error'
  | 'clean'
  | 'settled'
  | 'failing-severe'
  | 'failing-limit'
  | 'failing-test'

interface BandView {
  kind: BandKind
  rows: BandRow[]
  total: number
  /** Runs in scope newer than the newest failure. The evidence behind "settled". */
  runsSince: number
  /** The span the failures cover, already worded. */
  when: string | null
  /** The scope holds more runs than one page — say so rather than under-report. */
  capped: boolean
  /** What the self-test toggle is hiding, for the note. Empty when it is shown. */
  hidden: { total: number; rows: BandRow[]; when: string | null }
}

/**
 * THE RECENCY RULE, and it is the whole of Part 19:
 *
 *   Nothing is failing now  ⟺  the newest run in scope succeeded.
 *
 * Binary, derived from data already on hand, no threshold to tune and no
 * calendar to argue with — which matters on a fleet that ran 51 of its 53 runs
 * because a person pressed a button, where "7 days old" says nothing and
 * "12 runs have run since, all clean" says everything.
 *
 * Recency is a QUALIFIER, never a predicate. Every failure in scope is still
 * counted, still listed and still reachable through the one action; the rule
 * only decides which sentence sits above them. That is what keeps the band's
 * number and the list it produces a single derivation — Part 6's rule 1 asks
 * "is anything wrong NOW", and the previous build answered "what has ever gone
 * wrong" while claiming to answer the first.
 *
 * `runs` arrives newest-first and ALWAYS includes the self-test, so one read
 * answers both the band's counts and the hidden-note's numbers. The band's own
 * scope is re-derived here with `!diagnostic` — the identical predicate the
 * server applies for `includeSelfTest=0`, so the count and the filtered list it
 * offers cannot disagree.
 */
function deriveBand(
  runs: FleetEvent[],
  includeSelfTest: boolean,
  capped: boolean,
  span: (oldest: string, newest: string) => string,
): BandView {
  const inScope = includeSelfTest ? runs : runs.filter((r) => !r.diagnostic)
  const rows = groupFailures(inScope)
  const total = rows.reduce((n, r) => n + r.count, 0)

  const hiddenRuns = includeSelfTest ? [] : runs.filter((r) => r.diagnostic)
  const hiddenRows = groupFailures(hiddenRuns)
  const hiddenTotal = hiddenRows.reduce((n, r) => n + r.count, 0)
  const hidden = {
    total: hiddenTotal,
    rows: hiddenRows,
    when: hiddenTotal
      ? span(
          hiddenRows.reduce((a, r) => (r.oldestAt < a ? r.oldestAt : a), hiddenRows[0]!.oldestAt),
          hiddenRows.reduce((a, r) => (r.newestAt > a ? r.newestAt : a), hiddenRows[0]!.newestAt),
        )
      : null,
  }

  if (total === 0) {
    return { kind: 'clean', rows, total, runsSince: 0, when: null, capped, hidden }
  }

  const newestFailureAt = rows.reduce(
    (a, r) => (r.newestAt > a ? r.newestAt : a),
    rows[0]!.newestAt,
  )
  const oldestFailureAt = rows.reduce(
    (a, r) => (r.oldestAt < a ? r.oldestAt : a),
    rows[0]!.oldestAt,
  )
  const when = span(oldestFailureAt, newestFailureAt)
  const runsSince = inScope.filter((r) => r.at > newestFailureAt).length
  const failingNow = inScope.length > 0 && inScope[0]!.kind === 'run.failed'

  if (!failingNow) {
    return { kind: 'settled', rows, total, runsSince, when, capped, hidden }
  }

  // A rehearsal that wrote nothing is not a production problem, and Part 6's
  // lesson is that an alarm about something which was never about the
  // operator's account spends the trust the next alarm needs. So a failing test
  // run is counted, listed and badged — and never the reason this goes red.
  // Measured: 0 of 26 not-ok runs have ever been a test run, which is exactly
  // when a rule gets forgotten, so it is asserted rather than remembered.
  const severeForHeadline = rows.some((r) => r.severe && !(r.hasTestRun && r.count === 1))
  if (severeForHeadline) {
    return { kind: 'failing-severe', rows, total, runsSince, when, capped, hidden }
  }
  const newestIsTest = inScope[0]!.mode === 'preview'
  return {
    kind: newestIsTest ? 'failing-test' : 'failing-limit',
    rows,
    total,
    runsSince,
    when,
    capped,
    hidden,
  }
}

/* ── export ────────────────────────────────────────────────────────────── */

/**
 * A spreadsheet treats a leading `= + - @` (and tab/CR) as the start of a
 * FORMULA, so a finding whose rationale begins with a minus sign becomes
 * executable content in someone else's Excel. Every field is prefixed with an
 * apostrophe in that case. The rationales here are model-authored free text,
 * which is exactly the input this guard exists for.
 */
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return `"${guarded.replace(/"/g, '""')}"`
}

const CSV_COLUMNS: Array<[string, (e: FleetEvent) => unknown]> = [
  ['when_utc', (e) => e.at],
  ['what_happened', (e) => e.title],
  ['detail', (e) => e.detail],
  ['actor', (e) => e.actor],
  ['actor_key', (e) => e.actorKey],
  ['actor_kind', (e) => e.actorKind],
  ['kind', (e) => e.kind],
  ['outcome', (e) => e.outcome],
  ['started_by', (e) => e.source],
  ['risk_tier', (e) => e.riskTier],
  ['cost_usd', (e) => e.costUSD],
  ['duration_ms', (e) => e.durationMs],
  ['findings', (e) => e.findingCount],
  ['workflow', (e) => e.workflowKey],
  ['self_test', (e) => (e.diagnostic ? 'yes' : 'no')],
  ['data_vintage_utc', (e) => e.dataVintage],
  ['entity', (e) => e.entity?.name ?? e.entity?.id ?? null],
  ['event_id', (e) => e.id],
]

function toCsv(events: FleetEvent[]): string {
  const head = CSV_COLUMNS.map(([h]) => csvCell(h)).join(',')
  const body = events.map((e) => CSV_COLUMNS.map(([, get]) => csvCell(get(e))).join(','))
  return [head, ...body].join('\r\n')
}

/**
 * ACT.5 — the plan's story in the same drawer as a run's trace.
 *
 * `PlanStory` is a shipped component in another stream's directory and it is
 * good: stages, the critic's twelve checks, blast radius, the dropped items.
 * It is IMPORTED, never copied — the whole reason the Overview's stream came
 * down was that one thing must not be rendered by two files.
 *
 * Until ACT.7 a plan row linked to `/fleet#plan-<id>`, an anchor only
 * `TimelineStream` drew. Retiring that component for the teaser left the link
 * pointing at nothing, so this is the repair as much as the feature.
 */
function PlanDrawer({
  plan,
  labels,
  onClose,
}: {
  plan: StoryPlan | null
  labels: PlanLabels
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="sba-drawerwrap"
      role="dialog"
      aria-modal="true"
      aria-label="The plan"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="sba-drawer">
        <header className="sba-drawerhead">
          <h3>The plan</h3>
          <button className="acr-btn" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </header>
        <div className="sba-drawerbody">
          {plan ? (
            <PlanStory plan={plan} labels={labels} />
          ) : (
            <p className="acr-pg-muted">
              That plan is no longer on record — it may have been cleared since this event.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * S7 (ACT.6) — "How this page works".
 *
 * Collapsed by default, so it costs an experienced operator nothing, and last
 * in the reading order because only after seeing the rows does a beginner want
 * the words. Not a tour, not a modal, not a first-visit overlay: those get
 * dismissed once and never found again.
 */
function HowActivityWorks() {
  const [open, setOpen] = useState(false)
  return (
    <section className="acr-card sba-how">
      <button
        type="button"
        className="sba-howhead"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>How this page works</span>
        <span className="sba-howtoggle">{open ? 'Close' : 'Read it'}</span>
      </button>
      {open ? (
        <div className="sba-howbody">
          <p>
            <strong>A <Term k="run">run</Term> is one worker doing its job once.</strong> It reads
            evidence that code prepared for it, thinks, and writes down what it found. Everything
            else on this page — findings, plans, approvals — was produced by some run, which is
            why almost every line here opens the run behind it.
          </p>
          <p>
            <strong>Workers only ever write things down.</strong> A{' '}
            <Term k="finding">finding</Term> is an observation, not an action. Turning findings
            into a change takes a <Term k="plan">plan</Term> from the director, a{' '}
            <Term k="critic">critic</Term> that tries to block it, and then your{' '}
            <Term k="approval">approval</Term>. Nothing on this page has touched Amazon by
            itself.
          </p>
          <p>
            <strong>Failing is four different things, and only one is the worker&apos;s fault.</strong>{' '}
            It could not reach the AI provider (a connection problem), the provider refused us (a
            billing problem), it broke its own output contract (the worker), or it stopped at one
            of its own limits — and that last one is a limit working, not a defect. The band at
            the top says which.
          </p>
          <p>
            <strong>The <Term k="selftest">self-test</Term> is hidden by default.</strong> It
            checks that the fleet itself works, so its findings are about our scheduled jobs
            rather than your account. It has produced most of the history on record, so counting
            it in would make every number on this page mostly about the fleet testing itself.
          </p>
          <p>
            <strong>Nothing here is deleted on a schedule.</strong> This page keeps everything the
            fleet has ever done. It refreshes about every ten seconds while you are looking at
            it, pauses when you are not, and never moves rows under you — new events wait behind
            a button.
          </p>
        </div>
      ) : null}
    </section>
  )
}

/* ── S1 · the header instrument, and the words under the title ─────────── */

/** HH:MM. Seconds are noise on a ten-second poll — they change on every read
 *  and no decision turns on them. The shipped header printed `03:25:22`. */
const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** "4s ago" / "3m ago" / "2h ago". Deliberately finer at the bottom end than
 *  `_shared/run-health.ago()`, whose floor is "just now": this number is watched
 *  ticking, so the seconds ARE the signal rather than noise. */
function sinceShort(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** "a minute" / "43 minutes" / "32 hours" / "5 days".
 *  A duration, never a day word: "yesterday" would have to agree with the
 *  list's day headers, which group on the UTC day while this line prints a
 *  local clock. Two adjacent things disagreeing about a date is exactly the
 *  defect class this page exists to avoid, so the ambiguity is removed rather
 *  than resolved. */
function durationWords(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 2) return 'a minute'
  if (m < 60) return `${m} minutes`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`
  return `${Math.round(h / 24)} days`
}

/** "6 August" · "6–7 August" · "28 July – 6 August". */
function dateRange(oldestIso: string, newestIso: string): string {
  const a = new Date(oldestIso)
  const b = new Date(newestIso)
  if (a.toDateString() === b.toDateString()) return shortDay(oldestIso)
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear())
    return `${a.getDate()}–${shortDay(newestIso)}`
  return `${shortDay(oldestIso)} – ${shortDay(newestIso)}`
}

type FreshnessState = 'reading' | 'live' | 'stale' | 'error'

/** Three missed polls. Under this the screen is current; over it, printing
 *  "Live" would be a claim the page cannot support. */
const STALE_AFTER_MS = 30_000

const FRESHNESS_WORD: Record<FreshnessState, string> = {
  reading: 'Reading…',
  live: 'Live',
  stale: 'Not updating',
  error: 'Can’t read',
}

/**
 * S1R — the freshness instrument, in the title row's right slot.
 *
 * It replaces `as of 03:25:22` in tiny grey beside an unrelated outline button.
 * Three things about it are deliberate:
 *
 * 1. **The age ticks every second, and that is the feature.** A counter running
 *    1s → 2s → … → 0s is the only VISIBLE proof that the page re-reads itself;
 *    a wall-clock stamp is indistinguishable from a frozen wall-clock stamp,
 *    which is why the shipped header made a live page look static and made the
 *    manual button look like the only way to update it. Its own component with
 *    its own interval, so the list does not re-render once a second.
 *
 * 2. **The state is derived from the AGE, never from a flag.** The poll is
 *    genuinely held while the run drawer is open, so a flag-based "Live" would
 *    become a lie the moment somebody reads a trace for a minute. An age cannot
 *    lie: if the number says 90s, the screen is 90s old, whatever the reason.
 *
 * 3. **Shape, colour and a word all move together.** Filled disc / hollow ring
 *    / square, plus the word — so no state is signalled by colour alone.
 *
 * The readout is a label and the button is a control; they share one border
 * because they are one instrument. Pattern: Microsoft Fabric's Live-refresh
 * ribbon (a NAMED state on the control, not a bare timestamp) and Grafana's
 * refresh-button-plus-interval. No interval picker: ten seconds is a house
 * decision, not a setting, and a control that is not enforced is not rendered.
 */
function Freshness({
  asOf,
  err,
  busy,
  onRefresh,
}: {
  asOf: Date | null
  err: string | null
  busy: boolean
  onRefresh: () => void
}) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // `asOf` is null until the first successful read, so the server and the first
  // client render agree on 'reading' and nothing here can mismatch on hydration.
  const ageMs = asOf ? Date.now() - asOf.getTime() : null
  const state: FreshnessState =
    err != null ? 'error' : ageMs == null ? 'reading' : ageMs <= STALE_AFTER_MS ? 'live' : 'stale'
  const word = FRESHNESS_WORD[state]

  const detail =
    state === 'reading'
      ? null
      : state === 'live'
        ? `updated ${sinceShort(ageMs!)}`
        : asOf
          ? `${state === 'error' ? 'last good read' : 'last read'} ${clock(asOf)}`
          : 'nothing read yet'

  const spoken = asOf
    ? `${word}. Last successful read at ${clock(asOf)}. This page re-reads every 10 seconds while you are looking at it.`
    : `${word}. This page re-reads every 10 seconds while you are looking at it.`

  return (
    <div className={`sba-fresh s-${state}`}>
      <span className="sba-freshread" title={spoken}>
        <span className="sba-freshdot" aria-hidden />
        <span className="sba-freshword">{word}</span>
        {detail ? (
          <>
            <span className="sba-freshsep" aria-hidden>
              ·
            </span>
            {asOf ? (
              <time className="sba-freshage" dateTime={asOf.toISOString()}>
                {detail}
              </time>
            ) : (
              <span className="sba-freshage">{detail}</span>
            )}
          </>
        ) : null}
        {/* The absolute time and the cadence reach a screen reader here and a
            mouse through `title`. Primer's own revision to its RelativeTime
            guidance is that `title` alone is inaccessible to keyboard and
            screen-reader users. No aria-live: the age changes every second and
            announcing it would be unusable. */}
        <span className="sba-sr">{spoken}</span>
      </span>
      <button
        type="button"
        className="sba-freshbtn"
        onClick={onRefresh}
        aria-busy={busy}
        // Never disabled: the poll is held while the drawer is open, and a
        // disabled control waiting on a tick it cannot see is worse than a
        // second press that the hook already de-duplicates.
      >
        <RefreshCw size={12} className={busy ? 'acr-spin' : undefined} aria-hidden /> Refresh
      </button>
    </div>
  )
}

/* ── the page ──────────────────────────────────────────────────────────── */

const PAGE = 50

export function ActivityClient() {
  const backend = getBackendUrl()

  /** What is on screen. Never replaced by a poll — see `incoming`. */
  const [shown, setShown] = useState<TimelinePage | null>(null)
  /** Pages the operator asked for with "Show older", kept apart so a refresh
   *  of page 1 cannot silently drop them. */
  const [older, setOlder] = useState<FleetEvent[]>([])
  /**
   * Three states, and the difference matters: `undefined` = the tail has not
   * been started, so page 1's `nextCursor` is where it begins; a string = the
   * next page; `null` = the tail is EXHAUSTED.
   *
   * A plain `string | null` cannot express that. `cursor ?? shown.nextCursor`
   * reads an exhausted `null` as "not started" and falls back to page 1's
   * still-non-null cursor, so "Show older" survived reaching the end — the
   * page said "Showing 119 of 119" with a button that did nothing. Caught in
   * the browser; tsc cannot see it.
   */
  const [cursor, setCursor] = useState<string | null | undefined>(undefined)
  /**
   * A newer page 1, fetched but NOT rendered. Rows are never inserted under a
   * reader: the operator is told and chooses.
   */
  const [incoming, setIncoming] = useState<TimelinePage | null>(null)
  const [state, setState] = useState<FleetStateRow | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /** S1R — true only while a MANUAL refresh is in flight. A spinner on every
   *  poll tick would be a flicker every ten seconds. */
  const [manualBusy, setManualBusy] = useState(false)
  /** S1R — how many workers exist and how many are switched on. It is the
   *  *reason* the page is quiet, and without it "nothing new for 32 hours"
   *  reads as a fault rather than as a fleet that is turned off. */
  const [workers, setWorkers] = useState<{ enabled: number; total: number } | null>(null)
  /** S1R — the size of the WHOLE history, unfiltered and self-test included.
   *  Subtracting the page's unfiltered scope from it gives exactly what the
   *  self-test toggle is hiding, which is the number "say what is missing"
   *  owes the reader in the header rather than only in the footnote. */
  const [historyTotal, setHistoryTotal] = useState<number | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [exporting, setExporting] = useState(false)
  /**
   * ACT.5 — what the drawer is showing. A run id opens the trace; a plan id
   * opens the director's story. One drawer, two contents, because "why did
   * this happen" is the same question either way.
   */
  const [detail, setDetail] = useState<{ runId: string } | { planId: string } | null>(null)
  const [plans, setPlans] = useState<StoryPlan[]>([])
  const [planLabels, setPlanLabels] = useState<PlanLabels>({ campaigns: {}, targets: {} })

  /* ── the filters (ACT.3) ─────────────────────────────────────────────── */

  /**
   * Read once from the URL, so a filtered view is a LINK — the DT.5 rule. The
   * URL is the source of truth on first paint and a mirror thereafter.
   */
  const initial = useMemo(() => {
    const p = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
    const csv = (k: string) => (p.get(k) ?? '').split(',').filter(Boolean)
    return {
      grain: p.get('grain') === 'runs' ? ('runs' as const) : ('all' as const),
      actors: csv('actor'),
      kinds: csv('kind') as FleetEventKind[],
      q: p.get('q') ?? '',
      selfTest: p.get('selfTest') === '1',
    }
  }, [])

  const [grain, setGrain] = useState<'all' | 'runs'>(initial.grain)
  const [actors, setActors] = useState<string[]>(initial.actors)
  const [kinds, setKinds] = useState<FleetEventKind[]>(initial.kinds)
  const [q, setQ] = useState(initial.q)
  const [includeSelfTest, setIncludeSelfTest] = useState(initial.selfTest)

  /** The ids currently rendered — what "new" is measured against. */
  const shownIds = useRef<Set<string>>(new Set())

  /**
   * The Runs grain IS a kind filter — the same feed, narrowed. Keeping that
   * in one place is what stops the switch and the chips contradicting each
   * other; the chips are hidden in that grain rather than fighting it.
   */
  const effectiveKinds = grain === 'runs' ? RUN_KINDS : kinds

  const qs = useCallback(
    (extra?: Record<string, string>) => {
      const p = new URLSearchParams({ limit: String(PAGE) })
      // ACT.1 — the exclusion is enforced SERVER-side, so `total`,
      // `countsByKind` and the rows can never disagree. Filtering here would
      // leave the headline counting rows the page had already hidden.
      if (!includeSelfTest) p.set('includeSelfTest', '0')
      if (actors.length) p.set('actor', actors.join(','))
      if (effectiveKinds.length) p.set('kind', effectiveKinds.join(','))
      if (q.trim()) p.set('q', q.trim())
      for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v)
      return p.toString()
    },
    [includeSelfTest, actors, effectiveKinds, q],
  )

  /* Mirror the filters into the address bar. `replaceState`, not `push` —
     typing in the search box must not fill the back button with keystrokes. */
  useEffect(() => {
    const p = new URLSearchParams()
    if (grain === 'runs') p.set('grain', 'runs')
    if (actors.length) p.set('actor', actors.join(','))
    if (kinds.length) p.set('kind', kinds.join(','))
    if (q.trim()) p.set('q', q.trim())
    if (includeSelfTest) p.set('selfTest', '1')
    const s = p.toString()
    // Keep the hash: it is a permalink to a row, and filtering is not a reason
    // to forget which row you arrived for.
    const hash = window.location.hash
    window.history.replaceState(null, '', `${window.location.pathname}${s ? `?${s}` : ''}${hash}`)
  }, [grain, actors, kinds, q, includeSelfTest])

  const load = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([
        fetch(`${backend}/api/agent/fleet/timeline?${qs()}`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/state`, { cache: 'no-store' }),
      ])
      if (!t.ok) throw new Error(`timeline: ${t.status}`)
      const page = (await t.json()) as TimelinePage
      if (s.ok) setState((await s.json()) as FleetStateRow)

      setShown((current) => {
        if (current === null) {
          shownIds.current = new Set(page.events.map((e) => e.id))
          return page
        }
        const fresh = page.events.filter((e) => !shownIds.current.has(e.id))
        if (fresh.length > 0) {
          setIncoming(page)
          return current
        }
        shownIds.current = new Set(page.events.map((e) => e.id))
        return page
      })
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      // The poll hook's contract: throw, so `asOf` stays at the last
      // SUCCESSFUL read rather than advancing on a failed attempt.
      throw e
    } finally {
      setLoading(false)
    }
  }, [backend, qs])

  /* The plan feed is small (one plan exists) and static enough not to poll —
     it is fetched once so a plan row has something to open. */
  useEffect(() => {
    let live = true
    fetch(`${backend}/api/agent/fleet/plans`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { plans?: StoryPlan[]; labels?: PlanLabels } | null) => {
        if (!live || !d) return
        setPlans(d.plans ?? [])
        if (d.labels) setPlanLabels(d.labels)
      })
      .catch(() => {
        /* a plan row simply will not open; the list is unaffected */
      })
    return () => {
      live = false
    }
  }, [backend])

  /**
   * A plan event's id is `plan.<id>` and a critic verdict's is
   * `critic.<planId>` — both name the same plan, which is why the critic's
   * ruling opens the plan it ruled on rather than a trace of the critic's run.
   * That is the question the reader is actually asking.
   */
  const openDetail = useCallback((e: FleetEvent) => {
    if (e.id.startsWith('plan.')) return setDetail({ planId: e.id.slice('plan.'.length) })
    if (e.id.startsWith('critic.')) return setDetail({ planId: e.id.slice('critic.'.length) })
    if (e.runId) return setDetail({ runId: e.runId })
  }, [])

  /**
   * S1R — the charter roster: seven rows, one of them the self-test. Read once
   * per mount and on a manual refresh, NOT in the ten-second poll: each row
   * carries a full `systemPrompt`, and a worker's on/off state is only ever
   * changed on Controls or Workers — pages a reader has to navigate to, which
   * remounts this one. Refresh covers the second-tab case.
   *
   * The diagnostic charter is excluded so the count matches this page's own
   * default scope: six workers, which is also what the nightly sweep reports
   * starting and skipping.
   */
  const loadWorkers = useCallback(async () => {
    try {
      const r = await fetch(`${backend}/api/agent/fleet/charters`, { cache: 'no-store' })
      if (!r.ok) return
      const d = (await r.json()) as { charters?: Array<{ enabled?: boolean; diagnostic?: boolean }> }
      const real = (d.charters ?? []).filter((c) => !c.diagnostic)
      setWorkers({ enabled: real.filter((c) => c.enabled).length, total: real.length })
    } catch {
      /* the state sentence simply omits the reason; it never invents one */
    }
  }, [backend])

  useEffect(() => {
    void loadWorkers()
  }, [loadWorkers])

  useEffect(() => {
    let live = true
    fetch(`${backend}/api/agent/fleet/timeline?limit=1`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TimelinePage | null) => {
        if (live && d) setHistoryTotal(d.total)
      })
      .catch(() => {
        /* the hidden-count clause is omitted rather than guessed */
      })
    return () => {
      live = false
    }
  }, [backend])

  /* Nothing shifts under someone reading a run. Throwing is how the hook is
     told "we did not read", so the `as of` stamp stays honest too. */
  const pollable = useCallback(async () => {
    try {
      if (detail) throw new Error('skipped: a run is open')
      await load()
    } finally {
      // Clears whether the read succeeded, failed, or was skipped for the
      // drawer — a spinner with no path back to rest is its own defect.
      setManualBusy(false)
    }
  }, [load, detail])

  const { asOf, refresh } = useVisibilityPoll(pollable)

  const manualRefresh = useCallback(() => {
    setManualBusy(true)
    void loadWorkers()
    refresh()
  }, [refresh, loadWorkers])

  /** Adopt the waiting page. The only way rows ever change under the reader. */
  const showIncoming = useCallback(() => {
    if (!incoming) return
    shownIds.current = new Set(incoming.events.map((e) => e.id))
    setShown(incoming)
    setIncoming(null)
    // "Show older" pages were fetched against the OLD head; keeping them would
    // interleave two reads of a moving list. Start the tail again.
    setOlder([])
    setCursor(undefined)
  }, [incoming])

  /* A filter change is a reload, not a merge. */
  useEffect(() => {
    setShown(null)
    setIncoming(null)
    setOlder([])
    setCursor(undefined)
    shownIds.current = new Set()
    setLoading(true)
    void load()
    // `load` is recreated by the qs change that triggered this effect.
  }, [load])

  const moreToLoad = cursor === undefined ? (shown?.nextCursor ?? null) : cursor

  const loadOlder = useCallback(async () => {
    const from = cursor === undefined ? shown?.nextCursor : cursor
    if (!from) return
    setLoadingOlder(true)
    try {
      const r = await fetch(`${backend}/api/agent/fleet/timeline?${qs({ cursor: from })}`, {
        cache: 'no-store',
      })
      if (!r.ok) throw new Error(`timeline: ${r.status}`)
      const page = (await r.json()) as TimelinePage
      setOlder((prev) => [...prev, ...page.events])
      for (const e of page.events) shownIds.current.add(e.id)
      setCursor(page.nextCursor)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingOlder(false)
    }
  }, [backend, cursor, qs, shown])

  /* One list, deduped by id — page 1 and the tail can overlap after a refresh. */
  const events = useMemo(() => {
    const seen = new Set<string>()
    const out: FleetEvent[] = []
    for (const e of [...(shown?.events ?? []), ...older]) {
      if (seen.has(e.id)) continue
      seen.add(e.id)
      out.push(e)
    }
    return out
  }, [shown, older])

  const days = useMemo(() => byDay(events), [events])

  /**
   * ACT.7 — permalinks. The Overview's "see the plan" button now sends
   * `/fleet/activity#e-plan.<id>` rather than scrolling to a row on its own
   * page, because that row moved here. Honour the hash once the events it
   * names are actually on screen: scroll to it and mark it, so arriving from
   * somewhere else lands on the thing you clicked rather than at the top.
   *
   * Runs on every event change, but only acts once — a poll must not yank the
   * page back to an anchor the reader has since scrolled away from.
   */
  const jumped = useRef(false)
  /**
   * Captured during the first render, NOT inside the effect. The filter-sync
   * effect below rewrites the URL on mount, and its no-filters branch used to
   * replace the whole location with `pathname` — which silently deleted the
   * permalink before anything could act on it. Reading it here happens first.
   */
  const hashOnMount = useRef<string>(
    typeof window === 'undefined' ? '' : decodeURIComponent(window.location.hash.slice(1)),
  )
  useEffect(() => {
    if (jumped.current || events.length === 0) return
    const id = hashOnMount.current
    if (!id) return
    const el = document.getElementById(id)
    if (!el) return
    jumped.current = true
    el.classList.add('sba-jumped')

    // Getting this to actually move took three tries, so the reasons are here.
    //
    // The page scrolls inside `<main class="overflow-auto">`, not the
    // document. A SMOOTH scroll started here is cancelled by the re-render
    // that lands with the first fetch. And an instant scroll on the next
    // frame is undone a moment later by the router's own scroll reset, which
    // runs after a navigation completes — the row was highlighted and the
    // container sat at zero.
    //
    // So: scroll now, then CHECK, and only scroll again if something put it
    // back. Self-correcting beats guessing a delay that is right on this
    // machine and wrong on a slower one.
    const bring = () => el.scrollIntoView({ block: 'center' })
    requestAnimationFrame(bring)
    const recheck = setTimeout(() => {
      const r = el.getBoundingClientRect()
      if (r.top < 0 || r.bottom > window.innerHeight) bring()
    }, 400)
    return () => clearTimeout(recheck)
  }, [events])

  /** A run in flight is a run. The kind exists, its count is zero today, and
   *  zero is exactly when an omission goes unnoticed. */
  const runCount = useMemo(() => {
    const c = shown?.countsByKind ?? {}
    return (c['run.ok'] ?? 0) + (c['run.failed'] ?? 0) + (c['run.running'] ?? 0)
  }, [shown])

  const newCount = incoming
    ? incoming.events.filter((e) => !shownIds.current.has(e.id)).length
    : 0

  /**
   * The chip VOCABULARY comes from a read narrowed only by the self-test
   * toggle — never from the filtered response.
   *
   * Taking it from `shown` (which was the first attempt) looks right and is
   * broken: `page.actors` describes the rows that came back, so the moment you
   * pick one worker every OTHER worker's chip vanishes and a second worker can
   * never be added. Multi-select was unreachable from the UI while working
   * perfectly in the API. Caught in the browser by trying to click two chips.
   *
   * So the counts are "how many of these exist in the current scope", fixed as
   * you refine — the behaviour Sentry and GitHub facets have — and what you are
   * actually looking at is stated by the scope line and the footer instead.
   */
  const [facets, setFacets] = useState<
    Pick<TimelinePage, 'actors' | 'countsByKind' | 'total'> | null
  >(null)
  useEffect(() => {
    const p = new URLSearchParams({ limit: '1' })
    if (!includeSelfTest) p.set('includeSelfTest', '0')
    let live = true
    fetch(`${backend}/api/agent/fleet/timeline?${p.toString()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TimelinePage | null) => {
        // `total` here is this page's scope with the self-test toggle applied
        // and NO other filter — which is what "filtered from N" must count
        // against, and what the hidden-count clause subtracts from the whole
        // history. Taking either from `shown` would compare a number with
        // itself.
        if (live && d) setFacets({ actors: d.actors, countsByKind: d.countsByKind, total: d.total })
      })
      .catch(() => {
        /* the list's own error banner covers a dead endpoint; chips just stay put */
      })
    return () => {
      live = false
    }
  }, [backend, includeSelfTest])

  /**
   * S2 keeps its OWN read. Tallying the loaded rows would be a silent cap —
   * with the self-test shown only 50 of 119 events are on screen, so the band
   * would under-report by more than half while looking authoritative.
   *
   * S2R changes it from "the failures" to "the RUNS", and always with the
   * self-test included. One read then answers three questions that used to need
   * three: which failures are in scope, whether the newest run succeeded (the
   * recency rule), and what the self-test toggle is hiding. The self-test scope
   * is re-derived client-side with `!diagnostic` — the identical predicate the
   * server applies for `includeSelfTest=0`, so the band's count and the list its
   * action produces cannot disagree.
   *
   * `null` means NOT YET READ and is rendered as "Checking…", never as an
   * all-clear. The previous build initialised to `[]` and swallowed its errors,
   * so a band whose silence means *all clear* showed a green tick both before it
   * had asked and when asking had failed.
   */
  const failuresInScope = effectiveKinds.length === 0 || effectiveKinds.includes('run.failed')
  const [bandRuns, setBandRuns] = useState<{ runs: FleetEvent[]; capped: boolean } | null>(null)
  const [bandErr, setBandErr] = useState<string | null>(null)
  useEffect(() => {
    if (!failuresInScope) return
    const p = new URLSearchParams({ limit: '200', kind: RUN_KINDS.join(',') })
    if (actors.length) p.set('actor', actors.join(','))
    if (q.trim()) p.set('q', q.trim())
    let live = true
    fetch(`${backend}/api/agent/fleet/timeline?${p.toString()}`, { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error(`timeline: ${r.status}`)
        return r.json()
      })
      .then((d: TimelinePage) => {
        if (!live) return
        setBandRuns({ runs: d.events, capped: d.nextCursor != null })
        setBandErr(null)
      })
      .catch((e: unknown) => {
        if (!live) return
        // Say so. A check that could not run is not an all-clear.
        setBandRuns(null)
        setBandErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      live = false
    }
  }, [backend, actors, q, failuresInScope])

  const band = useMemo<BandView>(() => {
    if (!failuresInScope)
      return {
        kind: 'out-of-scope',
        rows: [],
        total: 0,
        runsSince: 0,
        when: null,
        capped: false,
        hidden: { total: 0, rows: [], when: null },
      }
    if (bandErr)
      return {
        kind: 'error',
        rows: [],
        total: 0,
        runsSince: 0,
        when: null,
        capped: false,
        hidden: { total: 0, rows: [], when: null },
      }
    if (!bandRuns)
      return {
        kind: 'checking',
        rows: [],
        total: 0,
        runsSince: 0,
        when: null,
        capped: false,
        hidden: { total: 0, rows: [], when: null },
      }
    return deriveBand(bandRuns.runs, includeSelfTest, bandRuns.capped, dateRange)
  }, [failuresInScope, bandErr, bandRuns, includeSelfTest])

  /** The band's one filter, and it is exactly the one its number describes.
   *  SET, never appended: appending to an existing kind selection would produce
   *  a list larger than the count on the button. */
  const bandFilterOn = kinds.length === 1 && kinds[0] === 'run.failed' && grain === 'all'
  const toggleBandFilter = useCallback(() => {
    setGrain('all')
    setKinds((prev) => (prev.length === 1 && prev[0] === 'run.failed' ? [] : ['run.failed']))
  }, [])

  const actorChips = facets?.actors ?? []
  const kindChips = useMemo(() => {
    const c = facets?.countsByKind ?? {}
    return Object.entries(c)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
  }, [facets])

  const toggle = <T,>(list: T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v]

  const filterCount = actors.length + (grain === 'runs' ? 0 : kinds.length) + (q.trim() ? 1 : 0)
  const anyNarrowing = filterCount > 0 || grain === 'runs'

  const clearAll = useCallback(() => {
    setActors([])
    setKinds([])
    setQ('')
    setGrain('all')
  }, [])

  /* ── export ──────────────────────────────────────────────────────────── */

  /**
   * Walks EVERY page under the current filters before writing the file, so
   * "Download these 119 rows" is 119 rows and not the 50 that happen to be on
   * screen. An export that silently ships a page is the same lie as a table
   * with a silent cap.
   */
  const exportCsv = useCallback(async () => {
    setExporting(true)
    try {
      const all: FleetEvent[] = []
      let c: string | null | undefined
      for (let guard = 0; guard < 200; guard++) {
        const url = `${backend}/api/agent/fleet/timeline?${qs(c ? { cursor: c } : undefined)}`
        const r = await fetch(url, { cache: 'no-store' })
        if (!r.ok) throw new Error(`timeline: ${r.status}`)
        const page = (await r.json()) as TimelinePage
        all.push(...page.events)
        if (!page.nextCursor) break
        c = page.nextCursor
      }
      const blob = new Blob([toCsv(all)], { type: 'text/csv;charset=utf-8' })
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = `fleet-activity-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(href)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setExporting(false)
    }
  }, [backend, qs])

  /* ── the runs grid ───────────────────────────────────────────────────── */

  const runColumns: Array<Column<FleetEvent>> = useMemo(
    () => [
      {
        key: 'when',
        label: 'When',
        sortable: true,
        sortValue: (e) => new Date(e.at).getTime(),
        render: (e) => (
          <button
            type="button"
            className="sba-open sba-nowrap"
            title={new Date(e.at).toLocaleString()}
            onClick={() => openDetail(e)}
          >
            {ago(e.at)}
          </button>
        ),
      },
      {
        key: 'worker',
        label: 'Worker',
        sortable: true,
        sortValue: (e) => e.actor,
        render: (e) => (
          <span>
            {e.actor}
            <Badges event={e} />
          </span>
        ),
      },
      {
        key: 'what',
        label: 'What happened',
        render: (e) => (
          <span className="sba-cellprose">
            {whatHappened(e)}
            {e.detail ? <span className="sba-cellwhy">{e.detail}</span> : null}
          </span>
        ),
      },
      {
        key: 'startedby',
        label: 'Started by',
        sortable: true,
        sortValue: (e) => e.source,
        render: (e) => <span className="sba-nowrap">{e.source}</span>,
      },
      {
        key: 'howlong',
        label: 'How long',
        align: 'right',
        sortable: true,
        sortValue: (e) => e.durationMs ?? -1,
        render: (e) => <span className="sba-nowrap">{fmtDuration(e.durationMs)}</span>,
      },
      {
        key: 'found',
        label: 'Found',
        align: 'right',
        sortable: true,
        sortValue: (e) => e.findingCount ?? -1,
        render: (e) =>
          e.findingCount ? e.findingCount : <span className="acr-pg-muted">—</span>,
      },
      {
        key: 'cost',
        label: 'Cost',
        align: 'right',
        sortable: true,
        sortValue: (e) => e.costUSD ?? -1,
        // Blank, never "$0.0000": 39 of 53 runs cost nothing measurable, and a
        // column of zeroes reads as a broken meter rather than a cheap fleet.
        render: (e) =>
          e.costUSD && e.costUSD > 0 ? (
            `$${e.costUSD.toFixed(4)}`
          ) : (
            <span className="acr-pg-muted">—</span>
          ),
      },
    ],
    [openDetail],
  )

  /* ── S1 · the scope line ─────────────────────────────────────────────── */

  /** How much the self-test toggle is hiding, right now.
   *
   *  `historyTotal` is everything; `facets.total` is this page's scope with the
   *  toggle applied and no other filter. The difference is exactly what the
   *  toggle removed — which is the number the header owes the reader, because
   *  *excluded, never concealed* applies to the COUNT and not only to the rows.
   *  86 of 119 events are hidden by default and the shipped header said so
   *  nowhere. */
  const hiddenBySelfTest =
    !includeSelfTest && historyTotal != null && facets != null
      ? Math.max(0, historyTotal - facets.total)
      : 0

  /** The counts, as nodes rather than a string, so the numbers can carry the
   *  weight and the prose can stay one size. Hierarchy from weight and colour,
   *  not from a fourth font size. */
  const num = (v: number) => <strong className="sba-n">{v.toLocaleString()}</strong>

  const scopeCounts = (() => {
    if (!shown || shown.total === 0) return null
    const total = shown.total
    const haveAll = moreToLoad === null
    const oldest = events[events.length - 1]
    const newest = events[0]
    const noun = grain === 'runs' ? (total === 1 ? 'run' : 'runs') : total === 1 ? 'event' : 'events'
    // "5 events across 0 runs" is true and reads as nonsense — it happens the
    // moment a filter excludes every run event, e.g. a text search that only
    // matches findings. Say the clause only when there is something to say.
    const withRuns = grain !== 'runs' && runCount > 0
    return (
      <>
        {num(total)} {noun}
        {withRuns ? (
          <>
            {' '}
            across {num(runCount)} {runCount === 1 ? 'run' : 'runs'}
          </>
        ) : null}
        {haveAll && oldest && newest ? <>, {dateRange(oldest.at, newest.at)}</> : null}
        {!haveAll ? <>, newest {events.length} shown</> : null}.
      </>
    )
  })()

  /**
   * The one clause that says what is NOT in the number beside it.
   *
   * Only in the unfiltered "Everything" grain, on purpose: in the Runs grain
   * `shown.total` counts runs while the hidden count counts events of every
   * kind, so "86 more are hidden" printed next to "14 runs" would invite the
   * reading "86 more runs". A clause that is right in one grain and misleading
   * in another is not rendered in the other.
   */
  const scopeAside = (() => {
    if (!shown || grain === 'runs') return null
    if (filterCount > 0) {
      return facets ? <>Filtered from {facets.total.toLocaleString()}.</> : null
    }
    if (hiddenBySelfTest > 0) {
      return (
        <>
          {num(hiddenBySelfTest)} more from the <Term k="selftest">self-test</Term> are hidden.{' '}
          <button
            type="button"
            className="sba-inlinebtn"
            onClick={() => setIncludeSelfTest(true)}
          >
            Show them
          </button>
        </>
      )
    }
    return null
  })()

  /**
   * The liveness half of S1's purpose, and the clause the original build lost:
   * Part 3 specified "The fleet is switched off, so nothing new is arriving"
   * and what shipped was "The newest is at the top." — a restatement of the
   * subtitle, in the lowest contrast on the page, where the answer should have
   * been.
   *
   * A duration rather than a next-fire time. `/agent/fleet/schedule` says the
   * nightly sweep fires at 04:45Z, but with every worker off it skips all six —
   * last night's did. "Next run in 3 hours" would be true and misleading, which
   * is the failure mode Part 6 exists to prevent.
   */
  const stateSentence = (() => {
    if (!shown || state?.halted) return null
    const running = shown.countsByKind['run.running'] ?? 0
    if (running > 0)
      return `${running} ${running === 1 ? 'run is' : 'runs are'} happening right now.`
    const newest = events[0]
    // "Nothing new for 2 minutes" is a strange thing to say two minutes after
    // something happened — it reads as a complaint about a page that is working.
    // Under a quarter of an hour the same fact is news, so it is phrased as
    // news. Caught by watching a sibling session run the bid tuner live.
    const gapMs = newest ? Date.now() - new Date(newest.at).getTime() : 0
    const lead = newest
      ? gapMs < 15 * 60_000
        ? `The last thing happened ${durationWords(gapMs)} ago`
        : `Nothing new for ${durationWords(gapMs)}`
      : null
    const why = workers
      ? workers.enabled === 0
        ? 'no worker is switched on'
        : `${workers.enabled} of ${workers.total} workers are switched on`
      : null
    if (lead && why) return `${lead} — ${why}.`
    if (lead) return `${lead}.`
    if (why) return `${why.charAt(0).toUpperCase()}${why.slice(1)}.`
    return null
  })()

  return (
    <FleetPageShell
      title="Activity"
      sub="Everything the fleet has done, newest first — and every run that tried."
      aside={
        <Freshness asOf={asOf} err={err} busy={manualBusy} onRefresh={manualRefresh} />
      }
    >
      <div className="acr-fleet sba">
        {/* S1 — identity is above the rule, data is below it. The rule is the
            only new furniture on the page and it exists because five loose
            lines of near-identical small text read as a wall: it says which two
            belong to the page and which three belong to the data. */}
        <section className="sba-head" aria-label="What this page is showing">
          {/* The halt is a FACT here and a control on /fleet/controls. One click
              apart, never two stop buttons. Placed immediately under the title
              block — GOV.UK puts a notification banner directly before the page
              heading, Atlassian reserves banners for system-level messages, and
              a fleet-wide halt is exactly that. Only ONE banner ever shows: if
              the fleet is halted AND the last read failed, the halt wins and the
              read failure is carried by the freshness instrument. */}
          {state?.halted ? (
            <div className="acr-banner err sba-alert" role="alert">
              <Octagon size={14} aria-hidden />
              <span className="sba-alerttext">
                <strong>The whole fleet is halted.</strong>{' '}
                {state.haltReason ?? 'No reason was recorded.'}
                {state.haltedBy ? ` Stopped by ${state.haltedBy}` : ''}
                {state.haltedAt
                  ? `${state.haltedBy ? '' : ' Stopped'} ${durationWords(
                      Date.now() - new Date(state.haltedAt).getTime(),
                    )} ago`
                  : ''}
                {state.haltedBy || state.haltedAt ? '.' : ''} Nothing will run until it is
                resumed.
              </span>
              <Link className="sba-alertlink" href="/fleet/controls">
                Open Controls <ArrowRight size={11} aria-hidden />
              </Link>
            </div>
          ) : null}

          {/* Rendered only when it has something to say. An always-present <p>
              left a 19.5px blank line where the sentence should be whenever the
              FIRST read failed — `shown` null, `loading` false, so every branch
              was empty and the block silently grew a gap. Caught in a browser
              with the API unreachable; tsc renders an empty paragraph happily. */}
          {loading && !shown ? (
            <p className="sba-scopetext">Reading the fleet’s history…</p>
          ) : scopeCounts ? (
            <p className="sba-scopetext">
              {scopeCounts}
              {scopeAside ? <span className="sba-scopeaside"> {scopeAside}</span> : null}
            </p>
          ) : shown ? (
            /* Zero events. The shipped line vanished entirely here too, leaving
               a header with a freshness stamp and no sentence — a page that
               says nothing reads as a page that broke. */
            <p className="sba-scopetext">
              {anyNarrowing ? (
                <>
                  Nothing matches what you asked for
                  {facets ? <>, out of {facets.total.toLocaleString()}</> : null}.
                </>
              ) : !includeSelfTest && (historyTotal ?? 0) > 0 ? (
                <>
                  Nothing to show — all {num(historyTotal!)} events on record came from the{' '}
                  <Term k="selftest">self-test</Term>.{' '}
                  <button
                    type="button"
                    className="sba-inlinebtn"
                    onClick={() => setIncludeSelfTest(true)}
                  >
                    Show them
                  </button>
                </>
              ) : (
                <>Nothing on record yet.</>
              )}
            </p>
          ) : null}

          {stateSentence ? <p className="sba-scopestate">{stateSentence}</p> : null}

          {/* A failed read belongs beside the freshness it invalidates, not
              below the filter bar where it shipped. The instrument above already
              says "Can't read"; this says what and points at the control that
              retries rather than growing a second one. */}
          {err && !state?.halted ? (
            <div className="acr-banner err sba-alert" role="alert">
              <AlertTriangle size={14} aria-hidden />
              <span className="sba-alerttext">
                <strong>Could not read the fleet’s history.</strong> {err}.{' '}
                {asOf
                  ? `This is the last good read, from ${clock(asOf)}. Press Refresh to try again.`
                  : 'Nothing has been read yet. Press Refresh to try again.'}
              </span>
            </div>
          ) : null}
        </section>

        {/* ── S2: what needs a look ──────────────────────────────────────────
            One panel with a stated status, in the same idiom as S1's freshness
            instrument: a marker, a headline, a qualifying line, and — only when
            there is something to list — one line per failure class.

            The headline answers "is anything wrong NOW"; the rows answer "what".
            A green tick above a red row is not a contradiction, it is the two
            questions answered separately and reconciled by the line between
            them. Nothing is hidden and nothing is filtered, so the band's number
            and the list its action produces stay one derivation.

            No <h3>: the headline sentence already names the panel, and the
            12px uppercase 4.05:1 heading it replaces was a treatment shared with
            nothing else on the page. The section keeps an accessible name, which
            makes it a named region landmark — MORE navigable than a
            visually-tiny heading, not less. */}
        <section
          className={`sba-needs s-${band.kind}`}
          aria-label="What needs a look"
        >
          <p className="sba-needshead">
            <span className="sba-needsicon" aria-hidden>
              {band.kind === 'checking' ? (
                <Loader size={14} className="acr-spin" />
              ) : band.kind === 'error' ? (
                <AlertTriangle size={14} />
              ) : band.kind === 'out-of-scope' ? (
                <HelpCircle size={14} />
              ) : band.kind === 'failing-severe' ? (
                <X size={14} />
              ) : band.kind === 'failing-limit' ? (
                <Gauge size={14} />
              ) : band.kind === 'failing-test' ? (
                <FlaskConical size={14} />
              ) : (
                <Check size={14} />
              )}
            </span>
            <span className="sba-needsword">
              {band.kind === 'checking'
                ? 'Checking what needs a look…'
                : band.kind === 'error'
                  ? 'Could not check what needs a look'
                  : band.kind === 'out-of-scope'
                    ? 'Failures are hidden by your filters, so this cannot say'
                    : band.kind === 'clean'
                      ? 'Nothing has failed in what you are looking at'
                      : band.kind === 'settled'
                        ? 'Nothing is failing now'
                        : band.kind === 'failing-severe'
                          ? `${band.total} ${band.total === 1 ? 'run needs' : 'runs need'} a look`
                          : band.kind === 'failing-test'
                            ? 'The newest run was a test run, and it failed'
                            : `${band.total} ${band.total === 1 ? 'run' : 'runs'} stopped at ${band.total === 1 ? 'its own limit' : 'their own limits'}`}
            </span>
          </p>

          {/* The qualifying line — the evidence behind the headline. */}
          {band.kind === 'error' ? (
            <p className="sba-needssub">
              {bandErr}. The list below is unaffected — press Refresh to try again.
            </p>
          ) : band.kind === 'settled' ? (
            <p className="sba-needssub">
              {band.total} {band.total === 1 ? 'run' : 'runs'} failed on {band.when}, and the{' '}
              {band.runsSince} {band.runsSince === 1 ? 'run' : 'runs'} since{' '}
              {band.runsSince === 1 ? 'has' : 'have'} all been clean.
            </p>
          ) : band.kind === 'failing-severe' ? (
            <p className="sba-needssub">The newest run failed.</p>
          ) : band.kind === 'failing-limit' ? (
            <p className="sba-needssub">
              That limit worked — nothing is broken. Raise it, or accept the shorter answer.
            </p>
          ) : band.kind === 'failing-test' ? (
            <p className="sba-needssub">
              Nothing it decided was written. A test run is a rehearsal from the Workflows
              page, so this is not about your Amazon account.
            </p>
          ) : null}

          {/* One line per class. Labels, not controls: a per-class filter does
              not exist server-side, so a per-class control could only ever
              produce a list that disagrees with the number on it — which is
              exactly what the tiles did, measured on production. */}
          {band.rows.length > 0 ? (
            <ul className="sba-needsrows">
              {band.rows.map((r) => (
                <li key={r.klass} className={`sba-needsrow${r.severe ? ' severe' : ' mild'}`}>
                  <span className="sba-rowicon" aria-hidden>
                    {r.severe ? <X size={12} /> : <Gauge size={12} />}
                  </span>
                  <span className="sba-rowbody">
                    <span className="sba-rowline">
                      <strong className="sba-rowcount">
                        {r.count} {r.count === 1 ? 'run' : 'runs'}
                      </strong>{' '}
                      {shortLabel(r.label)}
                      {r.hasTestRun ? <span className="sba-badge test">test run</span> : null}
                    </span>
                    <span className="sba-rowmeta">
                      {BLAME_PHRASE[r.blame]} · {shortDay(r.newestAt)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {band.capped ? (
            <p className="sba-needssub">
              More runs match than fit one read, so this counts the newest 200.
            </p>
          ) : null}

          {/* The one control, labelled with the number it actually produces, and
              a real toggle so the band is never a dead end only S3's Clear can
              undo. Pressed is carried by fill AND a tick AND the changed word. */}
          {band.total > 0 ? (
            <button
              type="button"
              className={`sba-needsbtn${bandFilterOn ? ' on' : ''}`}
              aria-pressed={bandFilterOn}
              onClick={toggleBandFilter}
            >
              {bandFilterOn ? (
                <>
                  <Check size={12} aria-hidden /> Showing only failed runs
                </>
              ) : (
                <>
                  Show {band.total === 1 ? 'this run' : `these ${band.total} runs`}
                </>
              )}
            </button>
          ) : null}

          {/* Excluded, never concealed — and rendered whenever the self-test is
              hidden, not only when the band is otherwise empty. The numbers are
              DERIVED now: the previous copy hardcoded "a run of failures in six
              minutes when its model server restarted", which explains 21 of the
              24 and is silently wrong about the 3 that were the AI account
              running out of credit. */}
          {!includeSelfTest && band.hidden.total > 0 ? (
            <p className="sba-needsnote">
              The <Term k="selftest">self-test</Term> is hidden. {band.hidden.total} of its runs
              failed{band.hidden.when ? ` on ${band.hidden.when}` : ''} — the fleet testing
              itself, never your Amazon account.{' '}
              <button
                type="button"
                className="sba-inlinebtn"
                onClick={() => setIncludeSelfTest(true)}
              >
                Show me
              </button>
              {/* No cause is named here on purpose. The previous copy asserted
                  ONE — "a run of failures in six minutes when its model server
                  restarted" — which is true of 21 of the 24 and silently wrong
                  about the 3 that were the AI account running out of credit.
                  Pressing Show me puts all 24 into the rows above, classified
                  correctly and per class, which is the honest way to explain
                  them: excluded, never concealed, and never mis-explained. */}
            </p>
          ) : null}
        </section>

        {/* ── S3: the controls ─────────────────────────────────────────────── */}
        <div className="sba-toolbar">
          <div className="sba-grain" role="group" aria-label="What to show">
            <span className="sba-grainlabel">Show</span>
            <button
              type="button"
              className={`sba-grainbtn${grain === 'all' ? ' on' : ''}`}
              aria-pressed={grain === 'all'}
              onClick={() => setGrain('all')}
            >
              Everything
            </button>
            <button
              type="button"
              className={`sba-grainbtn${grain === 'runs' ? ' on' : ''}`}
              aria-pressed={grain === 'runs'}
              onClick={() => setGrain('runs')}
            >
              Runs only
            </button>
          </div>

          <div className="sba-chipset">
            {actorChips.map((a) => (
              <button
                key={a.key}
                type="button"
                className={`acr-pg-chip${actors.includes(a.key) ? ' on' : ''}`}
                aria-pressed={actors.includes(a.key)}
                onClick={() => setActors((prev) => toggle(prev, a.key))}
              >
                {a.name}
              </button>
            ))}
          </div>

          {grain === 'all' ? (
            <div className="sba-chipset">
              {kindChips.map(([k, n]) => (
                <button
                  key={k}
                  type="button"
                  className={`acr-pg-chip${kinds.includes(k as FleetEventKind) ? ' on' : ''}`}
                  aria-pressed={kinds.includes(k as FleetEventKind)}
                  onClick={() => setKinds((prev) => toggle(prev, k as FleetEventKind))}
                >
                  {WHAT_LABEL[k] ?? k} <span className="sba-chipn">{n}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="sba-toolright">
            <label className="sba-toggle" title={DIAGNOSTIC_HINT}>
              <input
                type="checkbox"
                checked={includeSelfTest}
                onChange={(e) => setIncludeSelfTest(e.target.checked)}
              />
              Include the <Term k="selftest">self-test</Term>
            </label>
            <label className="sba-searchwrap">
              <Search size={12} aria-hidden />
              <input
                className="sba-search"
                type="search"
                placeholder="Search what happened…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Search the activity"
              />
            </label>
            {anyNarrowing ? (
              <button type="button" className="sba-clear" onClick={clearAll}>
                <X size={11} aria-hidden /> Clear
              </button>
            ) : null}
            <button
              type="button"
              className="sba-export"
              onClick={exportCsv}
              disabled={exporting || !shown?.total}
            >
              <Download size={12} aria-hidden />
              {exporting
                ? 'Preparing…'
                : `Download ${shown?.total ?? 0} ${shown?.total === 1 ? 'row' : 'rows'} (CSV)`}
            </button>
          </div>
        </div>

        {/* S1R — the read-failure banner moved UP into the header block, beside
            the freshness instrument that reports the same failure. It is not
            repeated here. */}

        {newCount > 0 ? (
          <button type="button" className="sba-new" onClick={showIncoming}>
            {newCount} new {newCount === 1 ? 'event' : 'events'} since you looked — show{' '}
            {newCount === 1 ? 'it' : 'them'}
          </button>
        ) : null}

        {/* ── the list ─────────────────────────────────────────────────────── */}
        {loading && !shown ? (
          <section className="acr-card sba-list">
            <div className="acr-pg-empty">
              <strong>Reading the fleet’s history…</strong>
              Every run, every finding and every decision, newest first.
            </div>
          </section>
        ) : events.length === 0 ? (
          <section className="acr-card sba-list">
            {anyNarrowing ? (
              /* Filters hid everything. Never a dead end — offer the way back. */
              <div className="acr-pg-empty">
                <strong>Nothing matches what you asked for.</strong>
                {includeSelfTest ? null : (
                  <>
                    The self-test is hidden, and it produced most of what is on record.{' '}
                    <button
                      type="button"
                      className="sba-inlinebtn"
                      onClick={() => setIncludeSelfTest(true)}
                    >
                      Include it
                    </button>
                    , or{' '}
                  </>
                )}
                <button type="button" className="sba-inlinebtn" onClick={clearAll}>
                  clear the filters
                </button>{' '}
                to see everything.
              </div>
            ) : !includeSelfTest ? (
              <div className="acr-pg-empty">
                <strong>Nothing here, because the self-test is hidden.</strong>
                Every event on record was produced by the self-test, which checks that the fleet
                itself works.{' '}
                <button
                  type="button"
                  className="sba-inlinebtn"
                  onClick={() => setIncludeSelfTest(true)}
                >
                  Include it
                </button>{' '}
                to see them.
              </div>
            ) : (
              <div className="acr-pg-empty">
                <strong>Nothing has happened yet.</strong>
                When a worker runs, every step it takes lands here — what it read, what it
                decided, what it cost, and, if something went wrong, what in plain words.
              </div>
            )}
          </section>
        ) : grain === 'runs' ? (
          <>
            <div className="h10-ds-gridcard sba-gridcard">
              <GridToolbar>
                <span className="sba-gridcount">
                  {events.length} {events.length === 1 ? 'run' : 'runs'}
                  {shown && shown.total > events.length ? ` of ${shown.total}` : ''} · newest first
                </span>
              </GridToolbar>
              <DataGrid
                columns={runColumns}
                rows={events}
                rowKey={(e) => e.id}
                initialSort={{ key: 'when', dir: 'desc' }}
              />
            </div>
            <div className="sba-foot bare">
              <span className="acr-pg-muted">
                Showing {events.length} of {shown?.total ?? events.length}
              </span>
              {moreToLoad ? (
                <button
                  type="button"
                  className="sba-more"
                  onClick={loadOlder}
                  disabled={loadingOlder}
                >
                  {loadingOlder ? 'Loading…' : 'Show older'}
                </button>
              ) : (
                <span className="acr-pg-muted">That is every run on record.</span>
              )}
            </div>
          </>
        ) : (
          <section className="acr-card sba-list">
            {days.map((d) => (
              <div className="sba-day" key={d.key}>
                <h3 className="sba-dayhead">
                  <span>{dayLabel(d.key)}</span>
                  <span className="sba-daycount">
                    {d.count} {d.count === 1 ? 'event' : 'events'}
                  </span>
                </h3>
                <ul className="sba-rows">
                  {d.rollups.map((g, i) => (
                    <RollupRow key={`${g.key}-${i}`} group={g} onOpen={openDetail} />
                  ))}
                </ul>
              </div>
            ))}

            <div className="sba-foot">
              <span className="acr-pg-muted">
                Showing {events.length} of {shown?.total ?? events.length}
              </span>
              {moreToLoad ? (
                <button
                  type="button"
                  className="sba-more"
                  onClick={loadOlder}
                  disabled={loadingOlder}
                >
                  {loadingOlder ? 'Loading…' : 'Show older'}
                </button>
              ) : (
                <span className="acr-pg-muted">That is the whole history.</span>
              )}
            </div>
          </section>
        )}

        {detail && 'runId' in detail ? (
          <RunDetail runId={detail.runId} backend={backend} onClose={() => setDetail(null)} />
        ) : null}
        {detail && 'planId' in detail ? (
          <PlanDrawer
            plan={plans.find((p) => p.id === detail.planId) ?? null}
            labels={planLabels}
            onClose={() => setDetail(null)}
          />
        ) : null}

        {/* S6 — say out loud what is missing, so a gap reads as a boundary
            rather than a bug. Every sentence here is checked against the data. */}
        <section className="sba-notshown">
          <h3>What this page doesn’t show</h3>
          <ul>
            <li>
              The rules engines that run your ads day to day are not here — this page is the
              AI fleet only.{' '}
              <Link href="/marketing/ads/rules-automation/control-room">
                The Control Room has those <ArrowRight size={11} aria-hidden />
              </Link>
            </li>
            <li>
              {includeSelfTest
                ? 'The self-test is currently included. It checks that the fleet itself works, so its findings are about the fleet, not about your Amazon account.'
                : 'The self-test is hidden. It checks that the fleet itself works, so its findings are about the fleet, not about your Amazon account — tick the box above to see them.'}
            </li>
            <li>
              Approval decisions taken before the fleet existed belong to the older Copilot
              system, so they are not counted here.{' '}
              <Link href="/fleet/approvals">
                The Approvals page lists them under Decided <ArrowRight size={11} aria-hidden />
              </Link>
            </li>
            <li>
              Nothing is deleted on a schedule — there is no retention limit on any of this.
            </li>
          </ul>
        </section>

        <HowActivityWorks />
      </div>
    </FleetPageShell>
  )
}
