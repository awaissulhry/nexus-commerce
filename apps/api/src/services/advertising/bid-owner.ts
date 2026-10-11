/**
 * Bid page (BAPI, 2026-10-10) — the pure half of GET /api/advertising/bids (bid-rows.service.ts loads the facts).
 *
 *   owner        ONE owner per bid, decided by resolveBidOwner from facts that each come from the read the writer itself
 *                uses (bid-rows.service.ts): the campaign's pin and allowlist, the bid brain's ownership (bid-brain/live.ts),
 *                a person's hold (BidHold, personBidTargetIds), the rules at Auto whose scope reaches the bid (the
 *                evaluator's own matcher), the hourly plan that holds the campaign, and the engines (an autopilot plan,
 *                auto-bid's scope) — and from what really wrote the bid in the last 7 days (writersOf), so "who sets it"
 *                never contradicts "last change": every writer of 7 days is the owner or named in `alsoWrites`
 *   changes      the action log's bid changes of one bid, with the night floor and its morning give-back folded into one
 *                change (or none, when the bid came back to where it was): collapseBidChanges
 *   heldBy       what holds the bid away from the brain's aim, from the brain's newest decision: brainHeldBy
 *   spark        the bid at the same hour on each of the last 7 days, the night floor left out: sparkOf
 *
 * Every number is in cents of the campaign's currency. Nothing here reads or writes the database.
 */
import { classifyActor, engineLabel } from './ads-engine-actors.js'
import { producedActionTypes } from './ads-rule-adapter.service.js'

export const BID_OWNER_KINDS = ['BRAIN', 'RULE', 'PLAN', 'PERSON', 'ENGINE', 'NONE'] as const
export type BidOwnerKind = (typeof BID_OWNER_KINDS)[number]

/** One writer of a bid. */
export interface BidWriterRef {
  kind: BidOwnerKind
  name: string
  /** 'brain' · a rule's id · the hourly plan's group (else schedule or product plan) id · 'you' · the engine's id · null */
  id: string | null
}

/**
 * The owner of a bid: the writer that really writes it most; `contested` when another writer is named in `alsoWrites` —
 * one that writes it too, or one that wrote it in the last 7 days.
 */
export interface BidOwner extends BidWriterRef {
  contested: boolean
  alsoWrites: BidWriterRef[]
}

/** One writer of a bid in the last 7 days, from the action log (writersOf): how many changes, and the newest one's time. */
export interface BidWriterTally extends BidWriterRef {
  writes: number
  /** ISO time of its newest change. */
  lastAt: string
}

export const BRAIN_OWNER_ID = 'brain'
export const PERSON_OWNER_ID = 'you'
export const AUTO_BID_OWNER_ID = 'auto-bid'

const YOU: BidWriterRef = { kind: 'PERSON', name: 'You', id: PERSON_OWNER_ID }
const NOBODY: BidWriterRef = { kind: 'NONE', name: 'Nobody', id: null }

/** What decides who writes one bid. Each fact is read where its writer reads it (bid-rows.service.ts). */
export interface BidOwnerFacts {
  /** Campaign.pinBids — the write gate refuses every automatic writer on this campaign's bids. */
  pinned: boolean
  /**
   * A person holds this bid: an open PIN / PERSON / CLAUDE BidHold (on the bid or its campaign), or a bid a person set or
   * approved in the last 60 days that was not handed back (personBidTargetIds). The bid brain and auto-bid leave it;
   * a rule at Auto, an hourly plan and an autopilot plan do not read it.
   */
  personHold: boolean
  /** Campaign.liveBidWritesEnabled — off the allowlist the write gate refuses every automatic writer. */
  allowlisted: boolean
  /** The target, its ad group and its campaign are all ENABLED (no writer moves a bid that enters no auction). */
  running: boolean
  /** The bid brain owns the campaign now (NEXUS_BID_BRAIN_MODE live, enrollment LIVE or HELD); `stopped`: the Owner's kill switch on its bids. */
  brain: { stopped: boolean } | null
  /**
   * The rules at Auto whose scope reaches the bid and that write it there (rulesWritingOn: a rank-defense raise leaves a
   * campaign an hourly plan holds), in the evaluator's order (priority, then age). A rule does not leave a bid a plan,
   * auto-bid or a person set.
   */
  rules: ReadonlyArray<{ id: string; name: string }>
  /** The hourly plan that holds the campaign (a schedule, or a product plan's campaign), when its engine runs. */
  plan: { id: string; name: string } | null
  /** An engine that writes the bid: an autopilot plan at Auto (it does not read a person's hold), else auto-bid (it does). */
  engine: { id: string; name: string; leavesPersonBids: boolean } | null
}

/**
 * The one owner of a bid, and every other writer that writes it too or wrote it in the last 7 days. Precedence:
 *   1. a pin                           → PERSON (the gate refuses every automatic writer)
 *   2. off the allowlist, not running  → PERSON when a person holds it, else NONE (no automatic writer reaches it)
 *   3. the bid brain owns the campaign → PERSON when a person holds it (the brain leaves it), else BRAIN: the gate refuses
 *                                        every other automatic writer there, and a rule's bid action is its input
 *   4. otherwise, first the writers of the last 7 days (`wrote`), the one that wrote most first, a tie to the most recent
 *      (an Ask-me rule whose ask a person approved is one: the write carries the rule's actor); then the writers set up to
 *      write the bid that did not write it, the one that writes most first: the hourly plan (every tick), an engine (an
 *      autopilot plan; auto-bid every 6 hours, unless a person holds the bid), the rules at Auto (on their own schedule,
 *      in the evaluator's order). None of them leaves a bid another of them set. The first is the owner.
 *   5. no writer                       → PERSON when a person holds it, else NONE
 * Every other writer — set up to write it, or a writer of the last 7 days (also under 1–3, where it cannot write now) —
 * is named in `alsoWrites`, never hidden, and the owner is then `contested`. So "who sets it" never contradicts the last
 * change of 7 days: its writer is the owner or named. A writer that is both set up and in the log is one writer. A
 * writer Nexus cannot name (kind NONE: no actor, a rule since deleted) is never the owner; it is named after the others.
 */
export function resolveBidOwner(f: BidOwnerFacts, wrote: readonly BidWriterTally[] = []): BidOwner {
  const recent = wrote
    .filter((w) => w.writes > 0)
    .sort((a, b) => b.writes - a.writes || Date.parse(b.lastAt) - Date.parse(a.lastAt))
    .map(refOf)
  const known = recent.filter((w) => w.kind !== 'NONE')
  const unknown = recent.filter((w) => w.kind === 'NONE')

  const fixed: BidWriterRef | null = f.pinned ? YOU
    : !f.allowlisted || !f.running ? (f.personHold ? YOU : NOBODY)
    : f.brain ? (f.personHold ? YOU : { kind: 'BRAIN', name: f.brain.stopped ? 'Brain · stopped' : 'Brain', id: BRAIN_OWNER_ID })
    : null
  if (fixed) return ownerWith(fixed, [...known, ...unknown])

  const configured: BidWriterRef[] = [
    ...(f.plan ? [{ kind: 'PLAN' as const, name: f.plan.name, id: f.plan.id }] : []),
    ...(f.engine && !(f.engine.leavesPersonBids && f.personHold) ? [{ kind: 'ENGINE' as const, name: f.engine.name, id: f.engine.id }] : []),
    ...f.rules.map((r) => ({ kind: 'RULE' as const, name: r.name, id: r.id })),
  ]
  // A writer set up to write the bid goes by its name of today, also where it heads the list as a writer of 7 days.
  const writers = distinct([...known, ...configured]).map((w) => configured.find((c) => sameWriter(c, w)) ?? w)
  if (!writers.length) return ownerWith(f.personHold ? YOU : NOBODY, unknown)
  return ownerWith(writers[0], [...writers.slice(1), ...unknown])
}

const refOf = (w: BidWriterRef): BidWriterRef => ({ kind: w.kind, name: w.name, id: w.id })

/** One writer: the same kind and id (a writer's name may change; its id does not). */
export const sameWriter = (a: BidWriterRef, b: BidWriterRef) => a.kind === b.kind && a.id === b.id

/** Each writer once, at its first place. */
const distinct = (list: readonly BidWriterRef[]) => list.filter((w, i) => list.findIndex((x) => sameWriter(x, w)) === i)

/** The owner and every other writer, each once; `contested` when one is named. */
function ownerWith(owner: BidWriterRef, others: readonly BidWriterRef[]): BidOwner {
  const alsoWrites = distinct(others).filter((w) => !sameWriter(w, owner))
  return { ...owner, contested: alsoWrites.length > 0, alsoWrites }
}

/**
 * The writers of one bid in the last `days` days, from its changes (collapseBidChanges' net changes: a night floor and
 * its give-back are one change, by the writer of the give-back), each with how many changes it made and its newest.
 */
export function writersOf(
  net: readonly NetChange[],
  author: (actor: string | null) => BidWriterRef,
  now: Date,
  days = 7,
): BidWriterTally[] {
  const since = now.getTime() - days * 86_400_000
  const out: BidWriterTally[] = []
  for (const n of net) {
    if (Date.parse(n.at) < since) continue
    const w = author(n.actor)
    const seen = out.find((x) => sameWriter(x, w))
    if (!seen) out.push({ ...refOf(w), writes: 1, lastAt: n.at })
    else {
      seen.writes++
      if (Date.parse(n.at) > Date.parse(seen.lastAt)) seen.lastAt = n.at
    }
  }
  return out
}

/** `owner=` matches a kind (any case) or an owner's id (a rule's id, 'brain', 'auto-bid', 'you'…). */
export function ownerMatches(owner: BidOwner, wanted: string | null | undefined): boolean {
  if (!wanted) return true
  const kind = wanted.toUpperCase()
  if ((BID_OWNER_KINDS as readonly string[]).includes(kind)) return owner.kind === kind
  return owner.id === wanted
}

/** The rule actions that write a keyword or target bid (brain/read-map.ts leversOfRuleAction 'bids', less the target-ACoS setter). */
const BID_WRITE_ACTIONS = new Set(['bid_apply', 'bid_down', 'bid_up', 'bid_to_target_acos', 'lower_bid_to_floor', 'raise_bids_for_rank_defense', 'scale_bids_for_price_change'])

/** A rank-defense raise leaves a campaign an hourly plan holds (automation-action-handlers.ts rankOwnedSkip). */
const SKIPS_RANK_HELD = new Set(['raise_bids_for_rank_defense'])

/**
 * The rules (writesBids, in the caller's order) that write a bid of this campaign: one whose only bid actions are
 * rank-defense raises leaves a campaign an hourly plan holds (`rankHeld`: rank-release.service.ts rankOwnedCampaignIds).
 */
export function rulesWritingOn<R extends { actions: unknown; conditions?: unknown; id?: string }>(rules: readonly R[], campaign: { rankHeld: boolean }): R[] {
  return rules.filter((r) => {
    const bidActions = producedActionTypes(r).filter((t) => BID_WRITE_ACTIONS.has(t))
    return bidActions.length > 0 && (!campaign.rankHeld || bidActions.some((t) => !SKIPS_RANK_HELD.has(t)))
  })
}

/**
 * A rule that writes bids when it acts: an action that writes a bid (what the rule really produces, op-aware:
 * ads-rule-adapter.service.ts producedActionTypes), and not belted to manual (a builder rule's control 'manual' only ever
 * asks: automation-rule.service.ts EA3). Its level (Auto) and `enabled` are the caller's to read.
 */
export function writesBids(rule: { actions: unknown; conditions?: unknown; id?: string }): boolean {
  const a0 = (Array.isArray(rule.actions) ? rule.actions[0] : null) as { control?: string } | null
  if (a0?.control === 'manual') return false
  return producedActionTypes(rule).some((t) => BID_WRITE_ACTIONS.has(t))
}

// ── Who wrote a change ─────────────────────────────────────────────────────────────────────────────────────────────

/** Who wrote one change: a writer, with the id the owner goes by (so a change and an owner compare: sameWriter). */
export type ChangeAuthor = BidWriterRef

/** The names a change's writers go by. */
export interface AuthorNames {
  /** Rule id → name. */
  rules: ReadonlyMap<string, string>
  /** Schedule or product plan id (the actor's) → the plan as an owner names it: its group's id and name where it has one. */
  plans: ReadonlyMap<string, { id: string; name: string }>
  /** Autopilot plan id → name. */
  autopilots?: ReadonlyMap<string, string>
}

/** The hourly-plan engines' actors (ads-engine-actors.ts): their Min-bid floors are the night floor. */
const isPlanActor = (actor: string | null) => {
  const c = classifyActor(stripLegacy(actor))
  return c.kind === 'engine' && (c.engine === 'rank-defend' || c.engine === 'dayparting')
}

/** Rows written before the actor fix carry `automation:automation:<x>` (ads-changes.service.ts parseActor). */
const stripLegacy = (actor: string | null): string | null => {
  let a = actor
  while (a?.startsWith('automation:automation:')) a = a.slice('automation:'.length)
  return a
}

/**
 * Who wrote one change, in the owner's words and with the owner's id: 'you' · 'brain' · the hourly plan's group (else
 * schedule or product plan) id · 'auto-bid' · an autopilot plan's id · another engine's key · a rule's id · null when
 * Nexus cannot say (no actor, a rule since deleted).
 */
export function authorOf(actor: string | null, names: AuthorNames): ChangeAuthor {
  const a = stripLegacy(actor)
  const c = classifyActor(a)
  if (c.kind === 'person') return { ...YOU }
  if (c.kind === 'engine') {
    if (c.engine === 'bid-brain' || c.engine.startsWith('brain-')) return { kind: 'BRAIN', name: 'Brain', id: BRAIN_OWNER_ID }
    if (c.engine === 'rank-defend' || c.engine === 'dayparting') {
      const id = a!.replace(/^automation:(rank-defend|rank-plan|dayparting)-/, '')
      const plan = names.plans.get(id)
      return { kind: 'PLAN', name: plan?.name ?? 'Hourly plan', id: plan?.id ?? id }
    }
    if (c.engine === 'auto-bid') return { kind: 'ENGINE', name: 'Auto-bid', id: AUTO_BID_OWNER_ID }
    const autopilot = /^automation:autopilot-(.+)$/.exec(a!)
    if (c.engine === 'autopilot' && autopilot) return { kind: 'ENGINE', name: names.autopilots?.get(autopilot[1]) ?? engineLabel('autopilot'), id: autopilot[1] }
    return { kind: 'ENGINE', name: engineLabel(c.engine), id: c.engine }
  }
  if (c.kind === 'rule-candidate') {
    const name = names.rules.get(c.ruleId)
    if (name) return { kind: 'RULE', name, id: c.ruleId }
  }
  return { kind: 'NONE', name: 'Unknown', id: null }
}

// ── An undone approved ask folded away ─────────────────────────────────────────────────────────────────────────────

/**
 * Bid page R4 — a rule's approved ask that was undone (bid-rules/ask-undo.ts) is no change: its write and the undo that put
 * the value back (written as the rule, `evidence.undoOf` naming the write) both leave, so "who sets it", the last change
 * and the 7-day counts are what they were before the approval. Every other write stays, a person's Undo of any change
 * included. Pure.
 */
export function withoutUndonePairs<T extends { id: string; undoOf?: string | null }>(rows: readonly T[]): T[] {
  const undone = new Set(rows.map((r) => r.undoOf).filter((x): x is string => !!x))
  return rows.filter((r) => !r.undoOf && !undone.has(r.id))
}

// ── The night floor folded away ────────────────────────────────────────────────────────────────────────────────────

/** A floor the hourly plans set is at most this (2¢ by default; a plan may name another small floor). */
export const NIGHT_FLOOR_MAX_CENTS = 5

/** One bid change from the action log, oldest first. `layer`: the bid brain's deciding layer (evidence.brain.layer). */
export interface BidChange {
  at: string
  from: number
  to: number
  actor: string | null
  layer: string | null
}

/** A change that stays after the folding: from → to, when, and the writer of its last step. */
export interface NetChange {
  at: string
  from: number
  to: number
  actor: string | null
}

/**
 * The night floor: the brain's Min-bid hour (layer min_bid_hour), or an hourly plan lowering a bid to its floor. A stop,
 * low stock, the money brake… are changes of their own and are kept.
 */
export function isNightFloor(c: Pick<BidChange, 'from' | 'to' | 'actor' | 'layer'>): boolean {
  if (c.to >= c.from) return false
  if (c.layer === 'min_bid_hour') return true
  return c.layer == null && c.to <= NIGHT_FLOOR_MAX_CENTS && isPlanActor(c.actor)
}

/** A give-back after a floor this list does not hold (it fell before the window): the brain's restore, or a plan's raise off its floor. */
const isOrphanGiveBack = (c: BidChange) => c.to > c.from
  && (c.layer === 'restore' || (c.layer == null && c.from <= NIGHT_FLOOR_MAX_CENTS && isPlanActor(c.actor)))

/**
 * Fold every night floor with the change that ends it: the floor (A → 2¢) and the next change off it (2¢ → B) become one
 * change A → B by the writer of the second, and nothing when B = A. A second floor while one is on keeps the first's A.
 * A floor still on at the end is `openFloor` (A: the bid it gives back). A give-back first in the list, whose floor fell
 * before it, is left out. `changes`: one bid's, oldest first.
 */
export function collapseBidChanges(changes: readonly BidChange[]): { net: NetChange[]; openFloor: { fromCents: number; at: string } | null } {
  const net: NetChange[] = []
  let open: { fromCents: number; at: string } | null = null
  changes.forEach((c, i) => {
    if (isNightFloor(c)) {
      if (!open) open = { fromCents: c.from, at: c.at }
      return
    }
    if (open) {
      if (c.to !== open.fromCents) net.push({ at: c.at, from: open.fromCents, to: c.to, actor: c.actor })
      open = null
      return
    }
    if (i === 0 && isOrphanGiveBack(c)) return
    net.push({ at: c.at, from: c.from, to: c.to, actor: c.actor })
  })
  return { net, openFloor: open }
}

/**
 * The bid at the same hour on each of the last `days` days, oldest first; the last is now. `baseCents`: the bid now with
 * the night floor left out (the bid it gives back). `net`: collapseBidChanges' changes, oldest first.
 */
export function sparkOf(net: readonly NetChange[], baseCents: number, now: Date, days = 7): number[] {
  const out: number[] = []
  for (let k = days - 1; k >= 0; k--) {
    const at = now.getTime() - k * 86_400_000
    const after = net.find((c) => Date.parse(c.at) > at)
    out.push(after ? after.from : baseCents)
  }
  return out
}

// ── The brain's aim and what holds it ──────────────────────────────────────────────────────────────────────────────

/** The bid brain's newest decision on a bid (BidBrainDecision). */
export interface BrainDecisionFacts {
  action: string
  layer: string
  goalBidCents: number | null
}

export interface HeldBy { kind: string; label: string }

const HELD_BY: Record<string, HeldBy> = {
  min_bid_hour: { kind: 'night_floor', label: 'Night floor' },
  pin: { kind: 'person', label: 'You' },
  money: { kind: 'money_brake', label: 'Money brake' },
  intraday: { kind: 'spend_brake', label: 'Spend brake' },
  brake: { kind: 'brake', label: 'Brake' },
  stop: { kind: 'stop', label: 'Stop' },
  stock: { kind: 'stock', label: 'Low stock' },
  freeze: { kind: 'freeze', label: 'Undo freeze' },
  phase: { kind: 'phase', label: 'Launch phase' },
  band: { kind: 'in_band', label: 'In band' },
  no_goal: { kind: 'no_evidence', label: 'No evidence' },
  limit: { kind: 'limit', label: 'Limit' },
  explore: { kind: 'test', label: 'Test' },
  revive: { kind: 'test', label: 'Test' },
  probe: { kind: 'test', label: 'Test' },
}

/**
 * What holds the bid away from the brain's aim, from its newest decision; null when nothing does — the brain moved
 * the bid to its aim (a goal write) or gave it back (restore). A goal decision that held waits for a newer data day
 * (the step was taken, too small, or a raise cap holds it). `autoUndoPin`: the brain's pin on this bid is auto-undo's own
 * (an UNDO_PIN hold, with no pin or hold of a person before it — bid-brain/facts.ts), not a person's.
 */
export function brainHeldBy(d: BrainDecisionFacts | null, opts: { autoUndoPin?: boolean } = {}): HeldBy | null {
  if (!d) return null
  if (d.layer === 'goal') return d.action === 'write' ? null : { kind: 'waits', label: 'Waits a day' }
  if (d.layer === 'restore') return null
  if (d.layer === 'pin' && opts.autoUndoPin) return { kind: 'auto_undo', label: 'Auto-undo' }
  return HELD_BY[d.layer] ?? { kind: d.layer, label: d.layer.replace(/_/g, ' ') }
}
