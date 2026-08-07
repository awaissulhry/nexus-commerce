/**
 * NAF.DT.1 — the event spine.
 *
 * The fleet page's "Decision timeline" used to list plans, and exactly one
 * plan exists. But the fleet has lived a real life across five tables — runs,
 * findings, plans, critic verdicts, approvals and the decisions taken on
 * them. This service unions those into ONE chronological stream of
 * `FleetEvent`s.
 *
 * Every event answers the five questions the audit-trail pattern demands, in
 * its own row: WHO (actor), WHAT (title), WHEN (at), WHAT CAME OF IT
 * (outcome), and WHERE IT CAME FROM (source). Sentences are built here, on
 * the server, so every client speaks one vocabulary — the same rule FX.1 set
 * for run traces.
 *
 * Deliberately NOT here: the deterministic ads engines (operator call
 * 2026-08-07 — fleet only), and `AgentControlAudit`, whose table now EXISTS
 * and is applied but holds zero rows. `controlAuditEvents()` below is the seam
 * where it plugs in; NAF.SB.ACT S8 owns wiring it up once an operator has
 * actually moved a dial, because it cannot be backfilled.
 *
 * NAF.SB.ACT.1 — four corrections and one addition, all driven by what the
 * production data actually contains (docs/2026-08-07-naf-sbact-activity-page.md
 * Part 1):
 *
 *  1. Approvals are scoped to FLEET runs. All 18 `AgentApproval` rows hang off
 *     the pre-fleet ACP runtime and none has a `decidedBy` — 36 of 155 events
 *     were dated fifty days before the fleet's first run and attributed to
 *     nobody. A stream titled "everything the fleet has done" must not claim
 *     them.
 *  2. Links point at `/fleet/...`, not the pre-move ads-console URLs.
 *  3. Runs carry `workflowKey`, so a row can say which routine ran it.
 *  4. Findings carry `dataVintage`. Findings are UPSERTED on
 *     (charterKey, entityType, entityId, dedupeKey) and there is no
 *     `updatedAt`, so `createdAt` is the FIRST sighting while the content is
 *     the LATEST. A chronological feed that hides that is quietly wrong.
 *  5. Every event says whether its author is a DIAGNOSTIC worker, and the
 *     filter can drop them server-side. `fleet-selftest` owns 39 of 53 runs
 *     and 47 of 64 findings; counted in, every number on every page is mostly
 *     about the fleet testing itself. Default is INCLUDE, so no existing
 *     caller changes behaviour — Activity opts out explicitly.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { FLEET_CHARTERS } from './charter-registry.js'

/* ── the shape ─────────────────────────────────────────────────────────── */

export type FleetEventKind =
  | 'run.ok'
  | 'run.failed'
  | 'finding.raised'
  | 'plan.drafted'
  | 'plan.critiqued'
  | 'approval.requested'
  | 'approval.decided'
  | 'fleet.halted'

/** Colour-independent state. The UI must pair each with a shape and a word. */
export type FleetEventOutcome = 'ok' | 'attention' | 'bad' | 'neutral'

export interface FleetEvent {
  /** Stable and unique across sources — safe as a React key and a permalink. */
  id: string
  at: string
  kind: FleetEventKind
  actorKind: 'worker' | 'human' | 'system'
  /** Display name. Never a raw key when a name is known. */
  actor: string
  /** The charter key, when the actor is a worker — for filtering and links. */
  actorKey: string | null
  /** One plain sentence a first-time reader can understand. */
  title: string
  /** An optional second line: the verbatim error, the reason, the detail. */
  detail: string | null
  outcome: FleetEventOutcome
  /** Where it came from, in words: "the nightly sweep", "someone asked". */
  source: string
  riskTier: string | null
  costUSD: number | null
  entity: { type: string; id: string; name: string | null } | null
  /** Groups an event into its episode (a sweep, a council, a single run). */
  episodeId: string | null
  /**
   * ACT.1 — the stored routine that ran this, when one did. Null means the
   * code path (the built-in sweep, or a hand-driven `ask`).
   */
  workflowKey: string | null
  /**
   * ACT.1 — when the evidence behind a finding was gathered. Findings are
   * upserted, so `at` is the first sighting and this is how fresh the content
   * actually is. Null for everything that is not a finding.
   */
  dataVintage: string | null
  /**
   * ACT.1 — true when the author is a diagnostic worker (it checks that the
   * fleet itself works, not the operator's account). Excluded from totals,
   * never concealed: the UI badges these rather than hiding them.
   */
  diagnostic: boolean
  /**
   * ACT.3 — how long the run took, and how much it found. Null on everything
   * that is not a run.
   *
   * These exist so the "Runs only" grain is the SAME feed rendered as a table,
   * not a second fetch against `/agent/fleet/runs` — which caps at 100 rows,
   * has no cursor and takes three filters. One list, one filter state, one
   * paging path was the whole argument for dropping the two-tab shape; a
   * second feed behind a tab would have quietly reinstated it.
   */
  durationMs: number | null
  findingCount: number | null
  /** Where clicking it should go, when there is somewhere to go. */
  href: string | null
  /**
   * Events with the same signature on the same day collapse into one line in
   * the stream. Repetition is a fact about the fleet, not 34 facts.
   */
  rollupKey: string
}

export interface FleetTimelineFilters {
  from?: Date
  to?: Date
  /**
   * ACT.3 — charter keys, and/or the literals 'human' / 'system'. A LIST,
   * because the filter chips are multi-select: `kind` and `outcome` were
   * always csv and `actor` was not, so "show me the bid tuner and the
   * harvester" was the one question the filter bar could not ask.
   * Empty or absent means every actor.
   */
  actors?: string[]
  kinds?: FleetEventKind[]
  outcomes?: FleetEventOutcome[]
  /** Free text over the sentence and its detail. */
  q?: string
  /**
   * ACT.1 — set false to drop diagnostic workers' events. Enforced centrally
   * in `matchesFilters`, so `total`, `countsByKind` and `actors` all agree
   * with the rows the caller receives. **Defaults to true**: the Overview's
   * existing stream must not change behaviour under it.
   */
  includeDiagnostic?: boolean
}

export interface FleetTimelinePage {
  events: FleetEvent[]
  /** `null` when this is the last page. */
  nextCursor: string | null
  /**
   * How many events match the filters in total. The stream states this, so a
   * page boundary is never mistaken for the end of the fleet's history.
   */
  total: number
  /** Per-kind totals, for the filter chips' counts. */
  countsByKind: Record<string, number>
  /** Distinct actors present, so the filter offers only what exists. */
  actors: Array<{ key: string; name: string; kind: 'worker' | 'human' | 'system' }>
}

/* ── vocabulary ────────────────────────────────────────────────────────── */

/** Turn `waste_term` into `waste term` — the fallback when we have no phrase. */
const humanize = (s: string) => s.replace(/[_-]+/g, ' ').trim()

/** What a worker found, as a person would say it. Singular. */
const FINDING_PHRASE: Record<string, string> = {
  waste_term: 'a search term wasting money',
  waste_theme: 'a whole theme of wasted spend',
  harvest_candidate: 'a search term worth its own keyword',
  product_harvest_candidate: 'a product worth its own keyword',
  bid_below_target: 'a bid sitting below where it should be',
  bid_above_target: 'a bid sitting above where it should be',
  fleet_brief: 'the nightly brief',
  cron_failing: 'a scheduled job that keeps failing',
  cron_stale: 'a scheduled job that has gone quiet',
}

/** What an action would actually do, in plain English. */
const TOOL_PHRASE: Record<string, string> = {
  'create-negative-keyword': 'stop ads showing for a search term',
  'graduate-keyword': 'promote a search term to its own keyword',
  'set-target-bid': "change a keyword's bid",
  'apply-content': 'apply a content change to a listing',
  'set-price': 'change a price',
  'send-customer-message': 'send a message to a customer',
  'publish-listing': 'publish a listing',
}

/** Why a run happened. */
function sourcePhrase(mode: string | null, trigger: string): string {
  if (mode === 'sweep') return 'the nightly sweep'
  if (mode === 'council') return 'the weekly council'
  if (mode === 'tick') return 'a scheduled check'
  if (mode === 'incident') return 'an incident'
  if (mode === 'summit') return 'a summit'
  // Every phrase here reads after the word "from", so they are all nouns.
  if (mode === 'ask') return 'a request someone made by hand'
  if (mode === 'custom') return 'a custom routine' // WF.6b
  if (trigger === 'schedule') return 'a schedule'
  if (trigger === 'manual') return 'a person, by hand'
  return humanize(trigger)
}

/**
 * The verbatim error stays — but it gets a sentence in front of it, because
 * `fetch failed` tells an operator nothing.
 */
function explainError(message: string | null, halted: string | null): string {
  if (halted) return `A guard stopped it: ${halted}`
  const m = message ?? ''
  if (!m) return 'It failed without saying why.'
  if (/fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(m))
    return `It could not reach the model provider. Verbatim: ${m}`
  if (/schema validation failed/i.test(m))
    return `The worker's answer did not match the shape it must return. Verbatim: ${m}`
  if (/\b(429|rate.?limit)\b/i.test(m))
    return `The model provider rate-limited us. Verbatim: ${m}`
  if (/\b4\d\d\b/.test(m)) return `The model provider rejected the request. Verbatim: ${m}`
  if (/budget|ceiling|quota/i.test(m)) return `It ran out of budget. Verbatim: ${m}`
  return m
}

/**
 * The opening sentence of a long passage, for rows whose full text is
 * rendered elsewhere. Falls back to a hard cap when there is no sentence
 * break in reach, so a run-on paragraph cannot flood a row.
 */
function firstSentence(text: string | undefined | null): string | null {
  if (!text) return null
  const trimmed = text.trim()
  const m = /^(.{20,240}?[.!?])\s/.exec(trimmed)
  if (m) return m[1]!
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed
}

/** A short, stable signature for the error, so repeats roll up together. */
function errorSignature(message: string | null, halted: string | null): string {
  if (halted) return 'halted'
  const m = message ?? 'unknown'
  if (/fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(m)) return 'unreachable'
  if (/schema validation failed/i.test(m)) return 'bad-shape'
  if (/\b(429|rate.?limit)\b/i.test(m)) return 'rate-limited'
  if (/\b4\d\d\b/.test(m)) return 'rejected'
  return m.slice(0, 40)
}

/* ── worker names ──────────────────────────────────────────────────────── */

/**
 * Names, not keys. Read straight from the table with an explicit select —
 * the charter registry is owned by the parallel NAF.AC session, and a
 * full-model read would break on its unapplied columns.
 */
interface WorkerInfo {
  name: string
  tier: string
  /**
   * ACT.1 — a diagnostic worker checks that the fleet itself works, so its
   * findings are not about the operator's account. The flag is CODE truth
   * (`CharterDefinition.diagnostic`), never a database column, so it is
   * resolved from `FLEET_CHARTERS` rather than read from the row.
   */
  diagnostic: boolean
}

async function workerNames(): Promise<Map<string, WorkerInfo>> {
  const rows = await prisma.agentCharter.findMany({
    select: { key: true, name: true, tier: true, templateKey: true },
  })
  const map = new Map<string, WorkerInfo>(
    rows.map((r) => [
      r.key,
      {
        name: r.name,
        tier: r.tier,
        // A W.8 instance is a narrower copy of a code charter, so it inherits
        // the template's diagnostic flag. Its own key is absent from
        // FLEET_CHARTERS, which is exactly why templateKey is selected.
        diagnostic:
          FLEET_CHARTERS[r.key]?.diagnostic === true ||
          (r.templateKey != null && FLEET_CHARTERS[r.templateKey]?.diagnostic === true),
      },
    ]),
  )
  // A code charter with no database row still exists and can still have run —
  // `fleet-auditor` was exactly that for a while. Never let a missing row
  // silently make a diagnostic worker look like a business one.
  for (const [key, def] of Object.entries(FLEET_CHARTERS)) {
    if (map.has(key)) continue
    map.set(key, { name: def.name, tier: def.tier, diagnostic: def.diagnostic === true })
  }
  return map
}

const nameOf = (names: Map<string, WorkerInfo>, key: string) =>
  names.get(key)?.name ?? humanize(key)

/** Unknown keys are treated as business workers — never silently excluded. */
const isDiagnostic = (names: Map<string, WorkerInfo>, key: string | null): boolean =>
  key != null && names.get(key)?.diagnostic === true

/**
 * What a run of this kind of worker actually *is*. A critic reviews, it does
 * not "find nothing" — saying so reads as a failure when it is a clean pass.
 */
function runSentence(who: string, tier: string | undefined, findingCount: number): string {
  if (tier === 'critic') return `${who} reviewed a plan`
  if (tier === 'director') return `${who} ran a planning pass`
  if (findingCount > 0)
    return `${who} ran and found ${findingCount} thing${findingCount === 1 ? '' : 's'}`
  return `${who} ran and found nothing`
}

/* ── the sources ───────────────────────────────────────────────────────── */

/**
 * Each source fetches `limit + 1` rows at or before the cursor. Merging then
 * slicing gives a correct page without loading the whole history: every
 * source is individually ordered, so the merged head is the true head.
 */
const overFetch = (limit: number) => limit + 1

interface Cursor {
  at: Date
  id: string
}

function parseCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null
  const i = raw.lastIndexOf('|')
  if (i < 0) return null
  const at = new Date(raw.slice(0, i))
  if (Number.isNaN(at.getTime())) return null
  return { at, id: raw.slice(i + 1) }
}

const makeCursor = (e: FleetEvent) => `${e.at}|${e.id}`

/**
 * ACT.3 — the actor filter, resolved once for every source.
 *
 * `null` means "no actor filter". Otherwise `keys` are charter keys to match
 * and `wantsNonWorker` says whether 'human' or 'system' was also picked. A
 * source that only ever produces worker events can skip its query entirely
 * when `keys` is empty — which is what made the old single-actor version fast,
 * and is worth keeping now that it is a list.
 */
function actorFilter(f: FleetTimelineFilters): { keys: string[]; wantsNonWorker: boolean } | null {
  if (!f.actors || f.actors.length === 0) return null
  const keys = f.actors.filter((a) => a !== 'human' && a !== 'system')
  return { keys, wantsNonWorker: f.actors.some((a) => a === 'human' || a === 'system') }
}

/** `at <= cursor` bound, applied to whichever column carries the time. */
function timeBound(f: FleetTimelineFilters, cursor: Cursor | null) {
  const lte = cursor ? (f.to && f.to < cursor.at ? f.to : cursor.at) : f.to
  if (!f.from && !lte) return undefined
  return { ...(f.from ? { gte: f.from } : {}), ...(lte ? { lte } : {}) }
}

async function runEvents(
  f: FleetTimelineFilters,
  cursor: Cursor | null,
  limit: number,
  names: Map<string, WorkerInfo>,
): Promise<FleetEvent[]> {
  const createdAt = timeBound(f, cursor)
  const af = actorFilter(f)
  // A filter naming only human/system can never match a worker's run.
  if (af && af.keys.length === 0) return []
  const where: Prisma.AgentRunWhereInput = {
    mode: { not: null },
    ...(createdAt ? { createdAt } : {}),
    ...(af ? { agentKey: { in: af.keys } } : {}),
  }
  const rows = await prisma.agentRun.findMany({
    where,
    select: {
      id: true, agentKey: true, mode: true, trigger: true, ok: true, status: true,
      findingCount: true, costUSD: true, latencyMs: true, errorMessage: true,
      haltedReason: true, orchestrationId: true, createdAt: true, workflowKey: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: overFetch(limit),
  })
  return rows.map((r) => {
    const who = nameOf(names, r.agentKey)
    const src = sourcePhrase(r.mode, r.trigger)
    const failed = !r.ok || r.status === 'failed'
    const sig = failed ? errorSignature(r.errorMessage, r.haltedReason) : 'ok'
    return {
      id: `run.${r.id}`,
      at: r.createdAt.toISOString(),
      kind: failed ? ('run.failed' as const) : ('run.ok' as const),
      actorKind: 'worker' as const,
      actor: who,
      actorKey: r.agentKey,
      title: failed
        ? `${who} tried to run, and failed`
        : runSentence(who, names.get(r.agentKey)?.tier, r.findingCount),
      detail: failed ? explainError(r.errorMessage, r.haltedReason) : null,
      outcome: failed ? ('bad' as const) : ('ok' as const),
      source: src,
      riskTier: null,
      costUSD: Number(r.costUSD),
      entity: null,
      episodeId: r.orchestrationId ?? `run:${r.id}`,
      // `?? null` is not belt-and-braces: an `undefined` here serializes as a
      // MISSING KEY rather than a null, so a client doing `'workflowKey' in e`
      // would silently disagree with one doing `e.workflowKey === null`.
      workflowKey: r.workflowKey ?? null,
      dataVintage: null,
      diagnostic: isDiagnostic(names, r.agentKey),
      durationMs: r.latencyMs,
      findingCount: r.findingCount,
      href: `/fleet/workers/${r.agentKey}`,
      rollupKey: `run:${r.agentKey}:${sig}`,
    }
  })
}

async function findingEvents(
  f: FleetTimelineFilters,
  cursor: Cursor | null,
  limit: number,
  names: Map<string, WorkerInfo>,
  episodeOf: Map<string, string>,
): Promise<FleetEvent[]> {
  const af = actorFilter(f)
  if (af && af.keys.length === 0) return []
  const createdAt = timeBound(f, cursor)
  const rows = await prisma.agentFinding.findMany({
    where: {
      ...(createdAt ? { createdAt } : {}),
      ...(af ? { charterKey: { in: af.keys } } : {}),
    },
    select: {
      id: true, runId: true, charterKey: true, kind: true, severity: true,
      entityType: true, entityId: true, entityName: true, rationale: true,
      status: true, createdAt: true, dataVintage: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: overFetch(limit),
  })
  return rows.map((r) => {
    const who = nameOf(names, r.charterKey)
    const what = FINDING_PHRASE[r.kind] ?? humanize(r.kind)
    const on = r.entityName ? ` — ${r.entityName}` : ''
    return {
      id: `finding.${r.id}`,
      at: r.createdAt.toISOString(),
      kind: 'finding.raised' as const,
      actorKind: 'worker' as const,
      actor: who,
      actorKey: r.charterKey,
      title: `${who} found ${what}${on}`,
      // The rationale is written for a human and never parsed by code.
      detail: r.rationale ? r.rationale.slice(0, 400) : null,
      outcome:
        r.severity === 'critical' || r.severity === 'high'
          ? ('attention' as const)
          : ('neutral' as const),
      source: 'a worker run',
      riskTier: null,
      costUSD: null,
      entity: { type: r.entityType, id: r.entityId, name: r.entityName },
      episodeId: episodeOf.get(r.runId) ?? `run:${r.runId}`,
      workflowKey: null,
      // The row is upserted, so `at` is the first sighting; this is how fresh
      // the content behind it actually is.
      dataVintage: r.dataVintage ? r.dataVintage.toISOString() : null,
      diagnostic: isDiagnostic(names, r.charterKey),
      durationMs: null,
      findingCount: null,
      href: `/fleet/workers/${r.charterKey}`,
      rollupKey: `finding:${r.charterKey}:${r.kind}`,
    }
  })
}

async function planEvents(
  f: FleetTimelineFilters,
  cursor: Cursor | null,
  limit: number,
  names: Map<string, WorkerInfo>,
  episodeOf: Map<string, string>,
): Promise<FleetEvent[]> {
  const af = actorFilter(f)
  if (af && af.keys.length === 0) return []
  const createdAt = timeBound(f, cursor)
  const rows = await prisma.agentPlan.findMany({
    where: {
      ...(createdAt ? { createdAt } : {}),
      ...(af ? { charterKey: { in: af.keys } } : {}),
    },
    select: {
      id: true, runId: true, charterKey: true, headline: true, items: true,
      droppedItems: true, criticVerdict: true, criticNotes: true, status: true,
      approvalIds: true, createdAt: true, decidedAt: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: overFetch(limit),
  })
  const out: FleetEvent[] = []
  for (const r of rows) {
    const who = nameOf(names, r.charterKey)
    const n = Array.isArray(r.items) ? r.items.length : 0
    const dropped = Array.isArray(r.droppedItems) ? r.droppedItems.length : 0
    const episode = episodeOf.get(r.runId) ?? `run:${r.runId}`
    // The plan's story is rendered on the Overview today; ACT.5 moves the
    // detail into Activity's own drawer and this anchor moves with it.
    const href = `/fleet#plan-${r.id}`
    out.push({
      id: `plan.${r.id}`,
      at: r.createdAt.toISOString(),
      kind: 'plan.drafted',
      actorKind: 'worker',
      actor: who,
      actorKey: r.charterKey,
      title: `${who} drew up a plan of ${n} action${n === 1 ? '' : 's'}`,
      detail: dropped > 0 ? `${r.headline} · it set aside ${dropped} more.` : r.headline,
      outcome: 'neutral',
      source: 'the weekly council',
      riskTier: null,
      costUSD: null,
      entity: null,
      episodeId: episode,
      workflowKey: null,
      dataVintage: null,
      diagnostic: isDiagnostic(names, r.charterKey),
      durationMs: null,
      findingCount: null,
      href,
      rollupKey: `plan:${r.charterKey}`,
    })

    // The critic's ruling is its own moment, and it is the one that matters.
    if (r.criticVerdict) {
      const notes = (r.criticNotes ?? null) as { summary?: string } | null
      const verdictWord =
        r.criticVerdict === 'pass'
          ? 'passed'
          : r.criticVerdict === 'block'
            ? 'blocked'
            : 'sent back for changes'
      out.push({
        id: `critic.${r.id}`,
        at: (r.decidedAt ?? r.createdAt).toISOString(),
        kind: 'plan.critiqued',
        actorKind: 'worker',
        actor: nameOf(names, 'plan-critic'),
        actorKey: 'plan-critic',
        title: `The critic ${verdictWord} that plan`,
        // The FIRST sentence only. The critic's full reasoning is rendered
        // one row below by the plan's own story — repeating the whole essay
        // here turned the card into a wall of the same text twice.
        detail:
          firstSentence(notes?.summary) ??
          (r.criticVerdict === 'block'
            ? 'Nothing from a blocked plan reaches Amazon.'
            : null),
        outcome:
          r.criticVerdict === 'block'
            ? 'bad'
            : r.criticVerdict === 'pass'
              ? 'ok'
              : 'attention',
        source: 'the weekly council',
        riskTier: null,
        costUSD: null,
        entity: null,
        episodeId: episode,
        workflowKey: null,
        dataVintage: null,
        diagnostic: isDiagnostic(names, 'plan-critic'),
        durationMs: null,
        findingCount: null,
        href,
        rollupKey: `critic:${r.criticVerdict}`,
      })
    }
  }
  return out
}

async function approvalEvents(
  f: FleetTimelineFilters,
  cursor: Cursor | null,
  limit: number,
  names: Map<string, WorkerInfo>,
  episodeOf: Map<string, string>,
  workerOfRun: Map<string, string>,
): Promise<FleetEvent[]> {
  const bound = timeBound(f, cursor)
  // Requests are worker-authored; decisions are human. A worker filter keeps
  // only the requests, a 'human' filter keeps only the decisions.
  const rows = await prisma.agentApproval.findMany({
    where: { ...(bound ? { requestedAt: bound } : {}) },
    select: {
      id: true, agentRunId: true, toolName: true, riskTier: true, status: true,
      reason: true, requestedAt: true, decidedBy: true, decidedAt: true,
    },
    orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }],
    take: overFetch(limit) * 2,
  })

  const out: FleetEvent[] = []
  for (const r of rows) {
    // ACT.1 — THE approval scoping rule.
    //
    // `workerOfRun` is built from fleet runs only (`mode: { not: null }`), so
    // a miss here means the approval belongs to the PRE-FLEET ACP runtime —
    // agent keys like `manual-action` and `listing-quality-keeper`, which are
    // not fleet workers and have no charter. Verified 2026-08-07: ALL 18
    // approval rows in production are such rows, dated 2026-06-17, fifty days
    // before the fleet's first run, every one with `decidedBy` null.
    //
    // The old code looked them up by id so it could at least name them. That
    // was the right instinct against the unnamed-actor anti-pattern, and the
    // wrong fix: it put 36 events — 23% of the whole stream — under a heading
    // that says "everything the FLEET has done", attributed to "Someone (not
    // recorded)". A reader would conclude the fleet took 18 decisions with no
    // accountability trail. It never took any.
    //
    // They are not deleted from the product: the Approvals page lists them
    // under Decided, labelled, and Activity's footnote points there. Skipping
    // them here is what makes both pages true at once.
    const key = workerOfRun.get(r.agentRunId)
    if (!key) continue
    const who = nameOf(names, key)
    const act = TOOL_PHRASE[r.toolName] ?? humanize(r.toolName)
    const episode = episodeOf.get(r.agentRunId) ?? `run:${r.agentRunId}`

    const af = actorFilter(f)
    if (!af || af.keys.includes(key)) {
      out.push({
        id: `approval.${r.id}`,
        at: r.requestedAt.toISOString(),
        kind: 'approval.requested',
        actorKind: 'worker',
        actor: who,
        actorKey: key,
        title: `${who} asked permission to ${act}`,
        detail: null,
        outcome: r.status === 'pending' ? 'attention' : 'neutral',
        source: 'a worker run',
        riskTier: r.riskTier,
        costUSD: null,
        entity: null,
        episodeId: episode,
        workflowKey: null,
        dataVintage: null,
        diagnostic: isDiagnostic(names, key),
        durationMs: null,
        findingCount: null,
        href: null,
        rollupKey: `approval-req:${key}:${r.toolName}`,
      })
    }

    if (r.decidedAt && (!af || f.actors!.includes('human'))) {
      const decided =
        r.status === 'rejected'
          ? 'said no to'
          : r.status === 'executed'
            ? 'approved, and it went through —'
            : 'approved'
      out.push({
        id: `decision.${r.id}`,
        at: r.decidedAt.toISOString(),
        kind: 'approval.decided',
        actorKind: 'human',
        // No decision in the table records who took it. Say so rather than
        // inventing an operator.
        actor: r.decidedBy ?? 'Someone (not recorded)',
        actorKey: null,
        title: `${r.decidedBy ?? 'Someone'} ${decided} the request to ${act}`,
        detail: r.reason ? `Reason given: ${r.reason}` : 'No reason was recorded.',
        outcome: r.status === 'rejected' ? 'neutral' : 'ok',
        source: 'a person',
        riskTier: r.riskTier,
        costUSD: null,
        entity: null,
        episodeId: episode,
        workflowKey: null,
        dataVintage: null,
        // A human decision is never diagnostic, whatever the worker was: the
        // actor is the person, and a person is not a self-test.
        diagnostic: false,
        durationMs: null,
        findingCount: null,
        href: null,
        rollupKey: `approval-dec:${r.status}:${r.toolName}`,
      })
    }
  }
  return out
}

/**
 * The fleet-state table is a singleton with no history — so it can honestly
 * contribute exactly one event: the halt that is in force right now.
 */
async function haltEvents(f: FleetTimelineFilters, cursor: Cursor | null): Promise<FleetEvent[]> {
  if (f.actors?.length && !f.actors.includes('system')) return []
  const s = await prisma.agentFleetState.findUnique({
    where: { id: 'singleton' },
    select: { halted: true, haltedAt: true, haltReason: true, haltedBy: true },
  })
  if (!s?.halted || !s.haltedAt) return []
  if (f.from && s.haltedAt < f.from) return []
  const lte = cursor ? (f.to && f.to < cursor.at ? f.to : cursor.at) : f.to
  if (lte && s.haltedAt > lte) return []
  return [
    {
      id: `halt.${s.haltedAt.toISOString()}`,
      at: s.haltedAt.toISOString(),
      kind: 'fleet.halted',
      actorKind: 'system',
      actor: s.haltedBy ?? 'The fleet',
      actorKey: null,
      title: 'The whole fleet was halted',
      detail: s.haltReason ?? 'No reason was recorded.',
      outcome: 'bad',
      source: s.haltedBy?.startsWith('auto:') ? 'a guard' : 'a person',
      riskTier: null,
      costUSD: null,
      entity: null,
      episodeId: null,
      workflowKey: null,
      dataVintage: null,
      diagnostic: false,
      durationMs: null,
      findingCount: null,
      href: null,
      rollupKey: 'halt',
    },
  ]
}

/**
 * Seam for NAF.AC.7's `AgentControlAudit` — who moved which dial, when, and
 * why. The table is written but its migration is not applied, so querying it
 * would throw. Wire this up once AC lands; the stream needs no other change.
 */
async function controlAuditEvents(): Promise<FleetEvent[]> {
  return []
}

/* ── assembly ──────────────────────────────────────────────────────────── */

function matchesFilters(e: FleetEvent, f: FleetTimelineFilters): boolean {
  // ACT.1 — enforced HERE and nowhere else, for the same reason the actor
  // filter is: `total`, `countsByKind` and `actors` are all computed by
  // running every event through this function, so a caller can never receive
  // rows the headline counts disagree with. Undefined means include, so the
  // Overview's existing stream is untouched.
  if (f.includeDiagnostic === false && e.diagnostic) return false
  // The actor filter is enforced HERE, not only in each source's where
  // clause, so it means one thing everywhere: "who performed this act".
  // A plan row belongs to the director, but the critic's ruling on it is the
  // critic's act — filtering to the director must not return it.
  if (f.actors?.length) {
    const hit = f.actors.some((a) =>
      a === 'human' || a === 'system' ? e.actorKind === a : e.actorKey === a,
    )
    if (!hit) return false
  }
  if (f.kinds?.length && !f.kinds.includes(e.kind)) return false
  if (f.outcomes?.length && !f.outcomes.includes(e.outcome)) return false
  if (f.q) {
    const hay = `${e.title} ${e.detail ?? ''} ${e.actor}`.toLowerCase()
    if (!hay.includes(f.q.toLowerCase())) return false
  }
  return true
}

/** Newest first; ties broken by id so paging is deterministic. */
function byNewest(a: FleetEvent, b: FleetEvent): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Runs carry the episode id (`orchestrationId`); findings, plans and
 * approvals reference a run. One map resolves them all.
 */
async function episodeIndex(): Promise<{
  episodeOf: Map<string, string>
  workerOfRun: Map<string, string>
}> {
  const runs = await prisma.agentRun.findMany({
    where: { mode: { not: null } },
    select: { id: true, orchestrationId: true, agentKey: true },
  })
  const episodeOf = new Map<string, string>()
  const workerOfRun = new Map<string, string>()
  for (const r of runs) {
    episodeOf.set(r.id, r.orchestrationId ?? `run:${r.id}`)
    workerOfRun.set(r.id, r.agentKey)
  }
  return { episodeOf, workerOfRun }
}

export async function getFleetTimeline(
  filters: FleetTimelineFilters = {},
  opts: { limit?: number; cursor?: string } = {},
): Promise<FleetTimelinePage> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const cursor = parseCursor(opts.cursor)
  const [names, { episodeOf, workerOfRun }] = await Promise.all([workerNames(), episodeIndex()])

  const [runs, findings, plans, approvals, halts, audit] = await Promise.all([
    runEvents(filters, cursor, limit, names),
    findingEvents(filters, cursor, limit, names, episodeOf),
    planEvents(filters, cursor, limit, names, episodeOf),
    approvalEvents(filters, cursor, limit, names, episodeOf, workerOfRun),
    haltEvents(filters, cursor),
    controlAuditEvents(),
  ])

  const all = [...runs, ...findings, ...plans, ...approvals, ...halts, ...audit]
    .filter((e) => matchesFilters(e, filters))
    // A source's own time bound is inclusive, so drop anything the previous
    // page already emitted at exactly the cursor instant.
    .filter((e) => !cursor || e.at < cursor.at.toISOString() || (e.at === cursor.at.toISOString() && e.id > cursor.id))
    .sort(byNewest)

  const page = all.slice(0, limit)
  const hasMore = all.length > limit
  const totals = await countFleetTimeline(filters)

  return {
    events: page,
    nextCursor: hasMore && page.length > 0 ? makeCursor(page[page.length - 1]!) : null,
    ...totals,
  }
}

/**
 * Totals are counted over the WHOLE filtered range, not the page — the stream
 * says "showing 50 of 154", so a page boundary is never read as the end of
 * the history. There is no silent cap anywhere in this service.
 */
export async function countFleetTimeline(
  filters: FleetTimelineFilters = {},
): Promise<Pick<FleetTimelinePage, 'total' | 'countsByKind' | 'actors'>> {
  const [names, { episodeOf, workerOfRun }] = await Promise.all([workerNames(), episodeIndex()])
  // Counting exactly means building the events; the fleet's history is ~150
  // rows, so this is honest and cheap. Revisit if it ever reaches five
  // figures — at which point per-source SQL counts replace this.
  const big = 10_000
  const [runs, findings, plans, approvals, halts, audit] = await Promise.all([
    runEvents(filters, null, big, names),
    findingEvents(filters, null, big, names, episodeOf),
    planEvents(filters, null, big, names, episodeOf),
    approvalEvents(filters, null, big, names, episodeOf, workerOfRun),
    haltEvents(filters, null),
    controlAuditEvents(),
  ])
  const all = [...runs, ...findings, ...plans, ...approvals, ...halts, ...audit].filter((e) =>
    matchesFilters(e, filters),
  )
  const countsByKind: Record<string, number> = {}
  const actors = new Map<string, { key: string; name: string; kind: 'worker' | 'human' | 'system' }>()
  for (const e of all) {
    countsByKind[e.kind] = (countsByKind[e.kind] ?? 0) + 1
    const key = e.actorKey ?? e.actorKind
    if (!actors.has(key)) actors.set(key, { key, name: e.actor, kind: e.actorKind })
  }
  return { total: all.length, countsByKind, actors: [...actors.values()] }
}
