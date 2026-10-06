/**
 * Approvals grid (docs/approvals-grid/PLAN.md, 2026-10-05) — the wire contract of the approvals queue.
 *
 * One row per request (`AgentApproval`), whoever asked: Claude through the MCP, a fleet agent, a rule or the in-app
 * assistant. The API builds every field (apps/api `services/agent-fleet/approval-queue.service.ts`); the page only reads it.
 *
 * Honesty rules the API keeps (the Owner's 100% honest UI):
 * - `state` is computed from what is stored; nothing here is stored as a new status.
 * - `changes` and `summary` come from the preview Nexus computed (the tool's own dry run), never from Claude's text.
 * - A field the API cannot know is null, never guessed. `target` is null when the request names no single thing.
 */

/** Which rows a list call returns. `open` = everything a person may still act on or watch. */
export const QUEUE_SHOWS = ['open', 'done', 'all'] as const
export type QueueShow = (typeof QUEUE_SHOWS)[number]

/**
 * The one status a person sees for the whole life of a request (PLAN §3).
 * - `waiting`: pending, nobody decided, no comeback reason.
 * - `starting`: approved, inside the stop window (`executeAfter` in the future, not held). Undo still possible.
 * - `on_hold`: approved, then held (`executeAfter` pushed past the stop window).
 * - `running`: executing (a plan's steps run in the worker; `plan` carries the counts).
 * - `done`: executed.
 * - `failed`: pending again after the run failed (`reason` starts "execution failed" / "execution error").
 * - `back_to_you`: pending again because a check at run time stopped it ("not run —" / "not run by rule —").
 * - `rejected` · `expired` · `replaced` (superseded by an edit) · `recorded` (approved on a preview-only tool; nothing ran).
 */
export const QUEUE_STATES = [
  'waiting',
  'starting',
  'on_hold',
  'running',
  'done',
  'failed',
  'back_to_you',
  'rejected',
  'expired',
  'replaced',
  'recorded',
] as const
export type QueueState = (typeof QUEUE_STATES)[number]

/** The states `show=open` returns. Everything else is `done`. */
export const OPEN_QUEUE_STATES: readonly QueueState[] = ['waiting', 'starting', 'on_hold', 'running', 'failed', 'back_to_you']

/** Same values as the API's tool registry (`AgentTool.reversibility`). Unknown = `none`, the safe direction. */
export type QueueReversibility = 'full' | 'partial' | 'none'

/**
 * Same values as the API's `ClaudeTrust`, lowest first. `watch` (ADS AUTONOMY AA-W2-4): the full check `auto` would make
 * runs and its verdict is recorded on the request (`WatchVerdict`), but a person still decides it, as at `confirm`.
 */
export type QueueTrustLevel = 'off' | 'ask' | 'confirm' | 'watch' | 'auto'

/**
 * The check of the business's rule that held a watched request back, in the order `auto` makes them: `level` (a plan
 * step below watch), `strategy` (the ads strategy narrowed it where it lands), `scope` (the Claude connection lacks
 * nexus.run), `pause` (rule-runs are paused), `limits` (outside the kind's limits), `cap` (the daily cap of changes run by
 * rule), `error` (Nexus could not apply the rule, so a person would have decided).
 */
export const RULE_CHECKS = ['level', 'strategy', 'scope', 'pause', 'limits', 'cap', 'error'] as const
export type RuleCheck = (typeof RULE_CHECKS)[number]

/** One step of a watched change plan: the step's own check (its level, the ads strategy, its limits) and the business's brakes. */
export interface WatchStepVerdict {
  /** 1-based, as the plan's steps are numbered. */
  step: number
  tool: string
  /** The level that applied to the step where it lands. */
  level: QueueTrustLevel
  /** The business set this step's kind to watch (or the ads strategy held it at watch): it counts in the kind's report. */
  watched: boolean
  wouldRun: boolean
  check: RuleCheck | null
  why: string | null
}

/**
 * ADS AUTONOMY AA-W2-4 — what the business's rule said about a request Claude asked for at `watch`, recorded when it was
 * asked (`AgentApproval.ruleVerdict`) and never acted on: a person decides the request. Null on every other request.
 */
export interface WatchVerdict {
  /** The level that applied where it lands: `watch`, or lower when the ads strategy narrowed it (check `strategy`). */
  level: QueueTrustLevel
  /** Had the kind been at auto, would the rule have run it by itself? (A plan: only when every step would.) */
  wouldRun: boolean
  /** The check that held it back; null when it would have run. */
  check: RuleCheck | null
  /** Why not, in a sentence a person reads; null when it would have run. */
  why: string | null
  /** When Nexus checked it (when it was asked). */
  checkedAt: string
  /** The ads strategy row that set the level where it lands (W1-8), with its version; absent when none did. */
  strategy?: { market: string; scope: 'market' | 'category' | 'product'; label: string; version: number; level: QueueTrustLevel }
  /** How many changes it holds (a plan: its steps), as the daily cap counts them. */
  changes: number
  /** A change plan: each step's own verdict, in order. */
  steps?: WatchStepVerdict[]
}

/** Watched changes of one group, and what a person did with them. */
export interface WatchTally {
  changes: number
  /** Approved by a person (in Nexus, or confirmed in Claude with their code), whether or not it ran yet. */
  approved: number
  rejected: number
  expired: number
  /** Replaced by a person's edit. */
  replaced: number
  /** Nobody decided yet (or it came back to a person). */
  waiting: number
}

/** The watched changes the rule would NOT have run: the tally, how many each check held back, and the commonest reasons. */
export interface WatchOutside extends WatchTally {
  byCheck: Partial<Record<RuleCheck, number>>
  /** Up to 5, most frequent first. */
  topReasons: Array<{ why: string; count: number }>
}

/** One kind (tool) in the watch report. */
export interface WatchKind {
  tool: string
  /** Registry title, e.g. "Set price". */
  title: string
  /** This business's level for the kind today: it may have left watch since. */
  level: QueueTrustLevel
  /** When the kind was last set to watch (Settings › AI › Claude audit), or null when not known. */
  watchingSince: string | null
  wouldRun: WatchTally
  outside: WatchOutside
}

/**
 * The watch report (`claude-activity` `watch`, GET /api/claude/activity): over a window (7 days unless named), Claude's
 * watched changes — would-have-run against what a person decided — in total and per kind. A plan's watched steps count
 * one by one, each by its own check.
 */
export interface WatchSummary {
  from: string
  to: string
  wouldRun: WatchTally
  outside: WatchOutside
  kinds: WatchKind[]
  /** True when the window held more watched requests than one report reads: the numbers cover the newest of them. */
  truncated: boolean
}

/** What the request is about. `count` > 1 for a bulk tool or a plan: `sku`/`name` then describe the first item. */
export interface QueueTarget {
  kind: 'product' | 'listing' | 'campaign' | 'ad-target' | 'order' | 'shipment' | 'purchase-order' | 'customer' | 'supplier' | 'rule' | 'other'
  id: string | null
  sku: string | null
  name: string | null
  count: number
  /** App path that opens the target, WITHOUT the /w/<workspaceId> prefix (the web's Link adds it). Null when none. */
  href: string | null
}

/** One before → after line, already in plain words (e.g. label "Price", from "€49.90", to "€44.90"). */
export interface QueueChange {
  label: string
  from: string | null
  to: string | null
}

/** Who asked. `label` is ready to show ("Claude · Awais", "Ads director", "Rule"). */
export interface QueueAsker {
  kind: 'claude' | 'fleet' | 'assistant' | 'rule' | 'system'
  label: string
  /** The signed-in person behind a Claude or assistant request, when stored. */
  person: string | null
  /** The Claude connection's name (OAuth grant), when stored. */
  connection: string | null
}

/** Who decided, once someone or something did. */
export interface QueueDecider {
  kind: 'person' | 'rule' | 'claude-code' | 'expiry' | 'system'
  /** Ready to show: "Awais", "Rule · Set price", "Awais, code in Claude", "Expired". */
  label: string
}

/** The automation state of this request's KIND (its tool), for this business, read live. */
export interface QueueAutomation {
  /** Today's level for this tool (`AgentTool.claudeTrust`). */
  level: QueueTrustLevel
  /** The highest level the code allows for this tool (`maxClaudeTrust`). `ask` = it always needs a person. */
  max: QueueTrustLevel
  /**
   * Plain words: why THIS request waits for a person under today's rule, computed at read time
   * ("Your rule for Set price: Ask me", "Over your limit: 12% > 10%", "This kind always needs you: it cannot be undone").
   * Null when the request is not waiting.
   */
  whyWaits: string | null
}

export interface QueueRow {
  id: string
  /** Machine name, e.g. `set-price`. Also the "kind" for grouping and bulk. */
  toolName: string
  /** Registry title, e.g. "Set price". Never a humanised tool id. */
  title: string
  /** Registry category (pricing, listings, advertising, …), or null. */
  area: string | null
  state: QueueState
  /** `AgentApproval.status`, for the drawer and tests only. */
  rawStatus: string
  /** Plain words for the "Why / result" column: why it waits, why it failed or came back, or the outcome. */
  note: string | null
  target: QueueTarget | null
  /** Upper-case channel (`AMAZON`, `EBAY`, `SHOPIFY`, `ETSY`) or null when none or unknown. */
  channel: string | null
  /** Market code (`IT`, `DE`, …) or null. */
  market: string | null
  /** Up to 3 lines for the grid cell; `changeCount` says how many exist in total. */
  changes: QueueChange[]
  changeCount: number
  /** The preview's own one-line summary, if it has one. */
  summary: string | null
  asker: QueueAsker
  decider: QueueDecider | null
  reversibility: QueueReversibility
  /** True when running it reaches a marketplace or a buyer (registry `openWorld`). */
  reachesOutside: boolean
  /**
   * True when it changes a record Nexus keeps (a master price, warehouse stock, a product's photos; a plan of only such
   * kinds): its Where is Nexus, even when the listings that follow that record then send the change on
   * (`reachesOutside`). The API decides it (approval-target.ts `NEXUS_RECORD_TOOLS`).
   */
  nexusRecord: boolean
  requestedAt: string
  expiresAt: string | null
  /** When an approved request runs (stop window end, or the end of a hold). */
  executeAfter: string | null
  decidedAt: string | null
  /** For a change plan: the step count and counts by step status. Null for a single request. */
  plan: { steps: number; byStatus: Record<string, number> } | null
  /** Whether THIS viewer may approve it now, and if not, why (permission, plan refusal …). */
  canApprove: boolean
  cannotApproveWhy: string | null
  /** Decision 1 = A: may this row be part of a bulk APPROVE? (same kind only; never a kind that cannot be undone). */
  bulkApprovable: boolean
  bulkBlockedWhy: string | null
  /**
   * ADS AUTONOMY W1-3 — approving it needs the approver's fresh authenticator code (a raise of the ads strategy, alone or
   * in a plan): the sentence to show, naming what it raises; null or absent when it does not. The approve then sends
   * `code` (POST /api/agent/fleet/approvals/:id/decide); without it the answer is 403 `mfa_required`.
   */
  needsCode?: string | null
  automation: QueueAutomation
  /**
   * ADS AUTONOMY AA-W2-4 — asked at `watch`: what the business's rule said when it was asked ("would have run by itself"
   * or why not). Null or absent on every other request.
   */
  ruleVerdict?: WatchVerdict | null
}

/** GET /api/agent/fleet/approvals/queue?show=&cursor=&limit= */
export interface QueuePage {
  rows: QueueRow[]
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null
  /** How many rows match `show` in total (not only this page). */
  total: number
}

/** GET /api/agent/fleet/approvals/queue/counts — the health strip and the nav badge. */
export interface QueueCounts {
  /** waiting + back_to_you: rows that need a person. The nav badge shows this number. */
  needsYou: number
  waiting: number
  backToYou: number
  starting: number
  running: number
  /** Failed rows still open (pending after a failed run). */
  failed: number
  /** Requests a rule ran since 00:00 in the business's time zone (UTC when unknown). */
  ranByRuleToday: number
  /** `requestedAt` of the oldest row that needs a person, or null. */
  oldestNeedsYouAt: string | null
}

/** One line of the drawer's timeline. */
export interface QueueEvent {
  at: string
  kind: 'asked' | 'approved' | 'held' | 'undone' | 'ran' | 'failed' | 'handed_back' | 'rejected' | 'expired' | 'replaced' | 'reached_channel' | 'change_undone'
  /** Ready to show: "Claude asked", "Approved by Awais", "Ran by rule · Set price", "Amazon IT accepted it". */
  words: string
}

/** GET /api/agent/fleet/approvals/queue/:id — the drawer. */
export interface QueueDetail extends QueueRow {
  /** Every change line (not capped at 3). */
  allChanges: QueueChange[]
  /** Up to 50 items for a bulk tool (sku + name + its change), for the drawer's list. */
  items: Array<{ sku: string | null; name: string | null; change: QueueChange | null }>
  /** What Claude (or the agent) said about why, shown as labelled plain text, never as Markdown. */
  askerReason: string | null
  /** The person's note on the decision, if any. */
  operatorNote: string | null
  /** The system reason, verbatim (`AgentApproval.reason`). */
  reason: string | null
  timeline: QueueEvent[]
  /** What the channel said, where Nexus can know it. `unknown` = Nexus cannot know; the UI says so. */
  channelResult: { state: 'reached' | 'waiting' | 'failed' | 'unknown'; words: string } | null
  /** The recorded change after it ran, for Undo (`POST /api/claude/changes/:id/undo`). */
  change: { id: string; undoable: boolean; undoneAt: string | null; whyNotUndoable: string | null } | null
  /** May the person edit the values, then approve (the server re-runs the tool's own checks on the edit)? */
  canEdit: boolean
  /**
   * The request's own arguments, sent only when `canEdit` (the viewer may use the tool), so the drawer can build an
   * edit form for keys that need the rest of the request (e.g. set-listing-stock's action). Null otherwise.
   */
  editArgs: Record<string, unknown> | null
}

/** POST /api/agent/fleet/approvals/bulk-preview and bulk-decide keep their paths; this is the approve outcome. */
export interface QueueBulkResult {
  ok: boolean
  /** Rows that were approved (scheduled into the stop window) or rejected. */
  done: number
  of: number
  /** Ids the server did not act on, each with the plain reason. */
  skipped: Array<{ id: string; why: string }>
  error?: string
}

/** GET /api/claude/trust/:tool/simulate?days=30&limits=<json> — "what would this rule have done?" */
export interface RuleSimulation {
  toolName: string
  days: number
  /** Requests of this kind in the window. */
  considered: number
  /** Of those, how many the proposed level + limits would have run by themselves. */
  wouldRun: number
  /** Of `wouldRun`, how many the person actually rejected — the number that should make them think. */
  rejectedAmongWouldRun: number
  /**
   * ADS AUTONOMY AA-W2-4 — requests inside the proposed limits that the ads strategy held below auto where they landed,
   * as their recorded watch verdict says: not counted in `wouldRun` (the strategy, not this kind's rule, held them).
   */
  heldByStrategy?: number
  /** Up to 5 examples of rejected ones that would have run, for the modal. */
  examples: Array<{ id: string; summary: string; rejectedReason: string | null }>
}
