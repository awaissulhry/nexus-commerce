'use client'

/**
 * NAF.DT.2 + DT.3 — the decision timeline.
 *
 * DT.2: one chronological stream, grouped by day, one plain sentence per
 * event, repeats rolled up so the page stays scannable.
 * DT.3: events belonging to the same episode (one run and everything it
 * produced; one council and its whole chain) collapse into a single card you
 * can open — the story kept whole, with `PlanStory` as the plan's detail.
 *
 * Sentences arrive built from the server (`fleet-timeline.service.ts`), so
 * this file decides how things LOOK and never what they MEAN. The one piece
 * of vocabulary that must live here is the rolled-up phrasing, because only
 * the client knows how many rows collapsed together.
 */

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/design-system/primitives'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ClipboardList,
  Hand,
  Octagon,
  ShieldCheck,
  X,
} from 'lucide-react'
import { Term } from './glossary'
import { PlanStory, type PlanLabels, type StoryPlan } from './PlanStory'

/* ── the shape the spine returns ───────────────────────────────────────── */

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
  href: string | null
  rollupKey: string
}

export interface FleetTimelinePage {
  events: FleetEvent[]
  nextCursor: string | null
  total: number
  countsByKind: Record<string, number>
  actors: Array<{ key: string; name: string; kind: string }>
}

/* ── how each kind looks and reads ─────────────────────────────────────── */

/** Every kind gets a DIFFERENT icon, so shape alone tells them apart. */
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

/** The state as a word. Colour is never the only signal. */
const STATE_WORD: Record<FleetEventOutcome, string | null> = {
  ok: null, // a clean run needs no badge; the tick says it
  attention: 'needs a look',
  bad: 'failed',
  neutral: null,
}

/**
 * How a collapsed group of identical events reads. Only the client knows the
 * count, so this one scrap of vocabulary has to live here.
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

function dayKey(iso: string) {
  return new Date(iso).toISOString().slice(0, 10)
}

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

/* ── grouping ──────────────────────────────────────────────────────────── */

interface Rollup {
  key: string
  events: FleetEvent[]
}

/** Consecutive events with the same signature collapse into one line. */
function rollUp(events: FleetEvent[]): Rollup[] {
  const out: Rollup[] = []
  for (const e of events) {
    const last = out[out.length - 1]
    if (last && last.key === e.rollupKey) last.events.push(e)
    else out.push({ key: e.rollupKey, events: [e] })
  }
  return out
}

interface Episode {
  id: string
  events: FleetEvent[]
  /** The newest moment in the episode — what it sorts by. */
  at: string
}

/** Group a day's events into episodes, newest episode first. */
function toEpisodes(events: FleetEvent[]): Episode[] {
  const byId = new Map<string, FleetEvent[]>()
  const order: string[] = []
  for (const e of events) {
    const id = e.episodeId ?? e.id
    if (!byId.has(id)) {
      byId.set(id, [])
      order.push(id)
    }
    byId.get(id)!.push(e)
  }
  return order.map((id) => {
    const evs = byId.get(id)!
    return { id, events: evs, at: evs[0]!.at }
  })
}

/**
 * What an episode is, in one sentence, derived from what it contains. A
 * council reads differently from a single worker run, and saying so is the
 * difference between a card you understand and a card you skip.
 */
function episodeSummary(events: FleetEvent[]): { title: string; sub: string[] } {
  const plan = events.find((e) => e.kind === 'plan.drafted')
  const critic = events.find((e) => e.kind === 'plan.critiqued')
  const findings = events.filter((e) => e.kind === 'finding.raised')
  const runs = events.filter((e) => e.kind === 'run.ok' || e.kind === 'run.failed')
  const asks = events.filter((e) => e.kind === 'approval.requested')
  const sub: string[] = []

  if (plan) {
    if (findings.length) sub.push(`${findings.length} found`)
    // "Ads director drew up a plan of 15 actions" → "a plan of 15 actions".
    sub.push(plan.title.replace(/^.*?\bdrew up\s+/, ''))
    if (critic) sub.push(critic.title.replace('The critic ', 'the critic '))
    return { title: 'The council met', sub }
  }

  if (runs.length === 1 && findings.length > 0) {
    sub.push(`${findings.length} finding${findings.length === 1 ? '' : 's'}`)
    if (asks.length) sub.push(`${asks.length} asked your permission`)
    return { title: runs[0]!.title, sub }
  }

  if (runs.length > 1) {
    const failed = runs.filter((r) => r.kind === 'run.failed').length
    sub.push(`${runs.length} runs`)
    if (failed) sub.push(`${failed} failed`)
    if (findings.length) sub.push(`${findings.length} findings`)
    return { title: 'A batch of runs', sub }
  }

  // Findings with no run event of their own (the run fell off this page):
  // still say what happened, not "6 events".
  if (findings.length > 1) {
    return {
      title: `${findings[0]!.actor} found ${findings.length} things`,
      sub: [],
    }
  }

  return {
    title: events[0]!.title,
    sub: events.length > 1 ? [`${events.length} events`] : [],
  }
}

/**
 * The icon on a collapsed episode should describe the EPISODE, not whichever
 * event happens to sort first inside it.
 */
function episodeKind(events: FleetEvent[]): FleetEventKind {
  const plan = events.find((e) => e.kind === 'plan.drafted')
  if (plan) return plan.kind
  const run = events.find((e) => e.kind === 'run.failed') ?? events.find((e) => e.kind === 'run.ok')
  if (run) return run.kind
  return events[0]!.kind
}

/* ── rows ──────────────────────────────────────────────────────────────── */

function Marker({ kind, outcome }: { kind: FleetEventKind; outcome: FleetEventOutcome }) {
  const m = MARKER[kind]
  const Icon = m.icon
  return (
    <span className={`dt-marker o-${outcome}`} title={m.label}>
      <Icon size={11} aria-hidden />
      <span className="dt-sr">{m.label}</span>
    </span>
  )
}

function EventRow({
  event,
  extra,
  anchorId,
}: {
  event: FleetEvent
  /** Rendered under the row — the plan story, when there is one. */
  extra?: React.ReactNode
  /** A DOM id other panels can scroll to (the approval inbox does). */
  anchorId?: string
}) {
  const word = STATE_WORD[event.outcome]
  return (
    <li className="dt-row" id={anchorId}>
      <Marker kind={event.kind} outcome={event.outcome} />
      <div className="dt-body">
        <span className="dt-title">{event.title}</span>
        <span className="dt-meta">
          <span>from {event.source}</span>
          {event.riskTier ? (
            <>
              <span className="dt-sep">·</span>
              <span className={`dt-risk r-${event.riskTier}`}>{event.riskTier} risk</span>
            </>
          ) : null}
          {word ? (
            <>
              <span className="dt-sep">·</span>
              <span className={`dt-state o-${event.outcome}`}>
                {event.outcome === 'attention' ? <AlertTriangle size={9} aria-hidden /> : null}
                {word}
              </span>
            </>
          ) : null}
        </span>
        {event.detail ? (
          <p className={`dt-detail${event.outcome === 'bad' ? ' bad' : ''}`}>{event.detail}</p>
        ) : null}
        {extra}
      </div>
      <time className="dt-time" dateTime={event.at} title={new Date(event.at).toLocaleString()}>
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
      <li className="dt-row">
        <Marker kind={first.kind} outcome={first.outcome} />
        <div className="dt-body">
          <span className="dt-title">{rollupSentence(first, n)}</span>
          <span className="dt-meta">
            <span className="dt-count">{n}</span>
            <span>from {first.source}</span>
            <span className="dt-sep">·</span>
            <button
              className="dt-rollupbtn"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? 'collapse these' : `show all ${n}`}
            </button>
          </span>
          {!open && first.detail ? (
            <p className={`dt-detail${first.outcome === 'bad' ? ' bad' : ''}`}>{first.detail}</p>
          ) : null}
        </div>
        <time className="dt-time" dateTime={first.at}>
          {hhmm(first.at)}
        </time>
      </li>
      {open ? group.events.map((e) => <EventRow key={e.id} event={e} />) : null}
    </>
  )
}

/* ── the episode card ──────────────────────────────────────────────────── */

function EpisodeCard({
  episode,
  plans,
  labels,
  focusPlanId,
}: {
  episode: Episode
  plans: StoryPlan[]
  labels: PlanLabels
  focusPlanId: string | null
}) {
  // An episode holding the plan another panel pointed at opens itself, so the
  // approval inbox's "see the plan" lands on something visible.
  const holdsFocus = focusPlanId
    ? episode.events.some((e) => e.id === `plan.${focusPlanId}`)
    : false
  const [open, setOpen] = useState(holdsFocus)
  useEffect(() => {
    if (holdsFocus) setOpen(true)
  }, [holdsFocus])
  const { title, sub } = episodeSummary(episode.events)
  const worst = episode.events.some((e) => e.outcome === 'bad')
    ? 'bad'
    : episode.events.some((e) => e.outcome === 'attention')
      ? 'attention'
      : 'ok'
  const groups = useMemo(() => rollUp(episode.events), [episode.events])

  return (
    <div className={`dt-episode${open ? ' open' : ''}`}>
      <button className="dt-ephead" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Marker kind={episodeKind(episode.events)} outcome={worst as FleetEventOutcome} />
        <span>
          <span className="dt-eptitle">{title}</span>
          <span className="dt-epsub">
            {sub.map((s, i) => (
              <span key={i}>
                {i > 0 ? <span className="dt-sep">→ </span> : null}
                {s}
              </span>
            ))}
          </span>
        </span>
        <span className="dt-epright">
          <span className="dt-count">{episode.events.length}</span>
          <time className="dt-time" dateTime={episode.at}>
            {hhmm(episode.at)}
          </time>
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        </span>
      </button>
      {open ? (
        <div className="dt-epbody">
          <ol className="dt-stream">
            {groups.map((g) => {
              const first = g.events[0]!
              // The plan's detail IS the story — FX.2's PlanStory, unchanged.
              if (g.events.length === 1 && first.kind === 'plan.drafted') {
                const plan = plans.find((p) => `plan.${p.id}` === first.id)
                return (
                  <EventRow
                    key={first.id}
                    event={first}
                    anchorId={plan ? `plan-${plan.id}` : undefined}
                    extra={
                      plan ? (
                        <div className="dt-planstory">
                          <PlanStory plan={plan} labels={labels} />
                        </div>
                      ) : null
                    }
                  />
                )
              }
              return <RollupRow key={`${g.key}:${first.id}`} group={g} />
            })}
          </ol>
        </div>
      ) : null}
    </div>
  )
}

/* ── the stream ────────────────────────────────────────────────────────── */

export function TimelineStream({
  page,
  plans,
  labels,
  loading,
  loadingMore,
  onLoadMore,
  focusPlanId = null,
}: {
  page: FleetTimelinePage | null
  plans: StoryPlan[]
  labels: PlanLabels
  loading: boolean
  loadingMore: boolean
  onLoadMore: () => void
  /** A plan another panel asked us to reveal — its episode opens itself. */
  focusPlanId?: string | null
}) {
  const days = useMemo(() => {
    if (!page) return []
    const byDay = new Map<string, FleetEvent[]>()
    const order: string[] = []
    for (const e of page.events) {
      const k = dayKey(e.at)
      if (!byDay.has(k)) {
        byDay.set(k, [])
        order.push(k)
      }
      byDay.get(k)!.push(e)
    }
    return order.map((k) => ({ key: k, events: byDay.get(k)! }))
  }, [page])

  if (loading && !page) {
    return (
      <div aria-busy="true" aria-label="Loading the timeline">
        {[64, 48, 48, 64, 48].map((h, i) => (
          <div key={i} className="dt-skeleton" style={{ height: h, marginBottom: 6 }} />
        ))}
      </div>
    )
  }

  if (!page || page.total === 0) {
    return (
      <p className="acr-fl-empty">
        Nothing has happened yet. Every run, <Term k="finding">finding</Term>, plan,{' '}
        <Term k="critic">critic</Term> ruling and approval will appear here the moment it
        happens — newest first.
      </p>
    )
  }

  return (
    <>
      <div className="dt-legend" aria-hidden>
        {(
          [
            'run.ok',
            'run.failed',
            'finding.raised',
            'plan.drafted',
            'plan.critiqued',
            'approval.requested',
          ] as FleetEventKind[]
        ).map((k) => (
          <span key={k} className="dt-legenditem">
            <Marker kind={k} outcome={k === 'run.failed' ? 'bad' : 'neutral'} />
            {MARKER[k].label}
          </span>
        ))}
      </div>

      {days.map((d) => {
        const episodes = toEpisodes(d.events)
        return (
          <section key={d.key} className="dt-daygroup" aria-label={dayLabel(d.key)}>
            <h4 className="dt-dayhead">
              {dayLabel(d.key)}
              <span className="dt-daycount">
                {d.events.length} event{d.events.length === 1 ? '' : 's'}
              </span>
            </h4>
            <ol className="dt-stream">
              {episodes.map((ep) =>
                ep.events.length > 1 ? (
                  <EpisodeCard
                    key={ep.id}
                    episode={ep}
                    plans={plans}
                    labels={labels}
                    focusPlanId={focusPlanId}
                  />
                ) : (
                  <RollupRow key={ep.id} group={{ key: ep.id, events: ep.events }} />
                ),
              )}
            </ol>
          </section>
        )
      })}

      <div className="dt-more">
        <span className="dt-showing">
          Showing {page.events.length} of {page.total}
        </span>
        {page.nextCursor ? (
          <Button variant="quiet" size="sm" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Show older'}
          </Button>
        ) : (
          <span className="dt-showing">— that is the whole history.</span>
        )}
      </div>
    </>
  )
}
