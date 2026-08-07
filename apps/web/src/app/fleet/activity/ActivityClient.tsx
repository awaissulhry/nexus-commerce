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
  Hand,
  Octagon,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { DIAGNOSTIC_HINT } from '../_shared/run-health'
import { useVisibilityPoll } from '../_shared/use-visibility-poll'

/* ── the shape the spine returns (ACT.1) ───────────────────────────────── */

export type FleetEventKind =
  | 'run.ok'
  | 'run.failed'
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
      {event.source.includes('test') ? <span className="sba-badge test">test run</span> : null}
      {event.workflowKey ? <span className="sba-badge flow">{event.workflowKey}</span> : null}
    </>
  )
}

function EventRow({ event }: { event: FleetEvent }) {
  const word = STATE_WORD[event.outcome]
  const vintageDiffers =
    event.dataVintage != null && dayKey(event.dataVintage) !== dayKey(event.at)
  return (
    <li className="sba-row" id={`e-${event.id}`}>
      <Marker kind={event.kind} outcome={event.outcome} />
      <div className="sba-body">
        <span className="sba-title">
          {event.href ? <Link href={event.href}>{event.title}</Link> : event.title}
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

function RollupRow({ group }: { group: Rollup }) {
  const [open, setOpen] = useState(false)
  const first = group.events[0]!
  const n = group.events.length
  if (n === 1) return <EventRow event={first} />
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
      {open ? group.events.map((e) => <EventRow key={e.id} event={e} />) : null}
    </>
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
   * reader: the operator is told and chooses. Vercel's "Show New Logs" over
   * auto-scroll, and the house rule from WorkersClient.
   */
  const [incoming, setIncoming] = useState<TimelinePage | null>(null)
  const [state, setState] = useState<FleetStateRow | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [includeSelfTest, setIncludeSelfTest] = useState(false)

  /** The ids currently rendered — what "new" is measured against. */
  const shownIds = useRef<Set<string>>(new Set())

  const qs = useCallback(
    (extra?: Record<string, string>) => {
      const p = new URLSearchParams({ limit: String(PAGE) })
      // ACT.1 — the exclusion is enforced SERVER-side, so `total`,
      // `countsByKind` and the rows can never disagree. Filtering here would
      // leave the headline counting rows the page had already hidden.
      if (!includeSelfTest) p.set('includeSelfTest', '0')
      for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v)
      return p.toString()
    },
    [includeSelfTest],
  )

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
        // First read, or a filter change reset us — render it directly.
        if (current === null) {
          shownIds.current = new Set(page.events.map((e) => e.id))
          return page
        }
        const fresh = page.events.filter((e) => !shownIds.current.has(e.id))
        if (fresh.length > 0) {
          setIncoming(page)
          return current
        }
        // Nothing new arrived: adopt the read silently. Totals and rows move
        // together, so the scope line can never describe a page you cannot see.
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

  const { asOf, refresh } = useVisibilityPoll(load)

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

  const runCount = useMemo(() => {
    const c = shown?.countsByKind ?? {}
    return (c['run.ok'] ?? 0) + (c['run.failed'] ?? 0)
  }, [shown])
  const newCount = incoming
    ? incoming.events.filter((e) => !shownIds.current.has(e.id)).length
    : 0

  /* ── the scope line ──────────────────────────────────────────────────── */

  const scope = (() => {
    if (!shown) return null
    const total = shown.total
    if (total === 0) return null
    const oldest = events[events.length - 1]
    const haveAll = moreToLoad === null
    const bits: string[] = [
      `${total.toLocaleString()} ${total === 1 ? 'event' : 'events'} across ${runCount} ${runCount === 1 ? 'run' : 'runs'}`,
    ]
    if (haveAll && oldest) bits.push(`all of it since ${shortDay(oldest.at)}`)
    else bits.push(`newest ${events.length} shown`)
    return bits.join(', ')
  })()

  return (
    <div className="acr-fleet sba">
      {/* The halt is a FACT here and a control on /fleet/controls. One click
          apart, never two stop buttons. */}
      {state?.halted ? (
        <div className="acr-banner err sba-banner">
          <Octagon size={14} aria-hidden />
          <span>
            <strong>The whole fleet is halted.</strong>{' '}
            {state.haltReason ?? 'No reason was recorded.'} Nothing will run until it is
            resumed. <Link href="/fleet/controls">Open Controls →</Link>
          </span>
        </div>
      ) : null}

      <div className="sba-scope">
        <p className="sba-scopetext">
          {loading && !shown ? (
            'Reading the fleet’s history…'
          ) : scope ? (
            <>
              {scope}.{' '}
              {state && !state.halted ? (
                <span className="acr-pg-muted">
                  {runCount === 0
                    ? 'Nothing has run yet.'
                    : 'The newest is at the top.'}
                </span>
              ) : null}
            </>
          ) : null}
        </p>
        <div className="sba-scopetools">
          <label className="sba-toggle" title={DIAGNOSTIC_HINT}>
            <input
              type="checkbox"
              checked={includeSelfTest}
              onChange={(e) => setIncludeSelfTest(e.target.checked)}
            />
            Include the <Term k="selftest">self-test</Term>
          </label>
          <span className="sba-asof">
            {asOf ? `as of ${asOf.toLocaleTimeString()}` : 'not read yet'}
          </span>
          <button type="button" className="sba-refresh" onClick={refresh}>
            <RefreshCw size={12} aria-hidden /> Refresh
          </button>
        </div>
      </div>

      {err ? (
        <div className="acr-banner err sba-banner">
          <AlertTriangle size={14} aria-hidden />
          <span>
            <strong>Could not read the fleet’s history.</strong> {err}. The page is showing
            the last good read; press Refresh to try again.
          </span>
        </div>
      ) : null}

      {newCount > 0 ? (
        <button type="button" className="sba-new" onClick={showIncoming}>
          {newCount} new {newCount === 1 ? 'event' : 'events'} since you looked — show{' '}
          {newCount === 1 ? 'it' : 'them'}
        </button>
      ) : null}

      <section className="acr-card sba-list">
        {loading && !shown ? (
          <div className="acr-pg-empty">
            <strong>Reading the fleet’s history…</strong>
            Every run, every finding and every decision, newest first.
          </div>
        ) : events.length === 0 && !includeSelfTest && shown?.total === 0 ? (
          /* Filters hid everything. Never a dead end — offer the way back. */
          <div className="acr-pg-empty">
            <strong>Nothing here, because the self-test is hidden.</strong>
            Every event on record was produced by the self-test, which checks that the fleet
            itself works.{' '}
            <button type="button" className="sba-inlinebtn" onClick={() => setIncludeSelfTest(true)}>
              Include it
            </button>{' '}
            to see them.
          </div>
        ) : events.length === 0 ? (
          <div className="acr-pg-empty">
            <strong>Nothing has happened yet.</strong>
            When a worker runs, every step it takes lands here — what it read, what it
            decided, what it cost, and, if something went wrong, what in plain words.
          </div>
        ) : (
          <>
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
                    <RollupRow key={`${g.key}-${i}`} group={g} />
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
          </>
        )}
      </section>

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
    </div>
  )
}
