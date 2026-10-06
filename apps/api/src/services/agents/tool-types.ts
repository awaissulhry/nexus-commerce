/**
 * ACP.1 — shared tool types (kept separate from the registry to avoid an
 * import cycle between the registry and the per-domain tool files).
 *
 * MCP full control C1 (tool contract v2): every change tool also says how far it can be undone
 * (`reversibility`, `undo`), how far Claude may ever run it without a person (`maxClaudeTrust`),
 * and inside which limits (`limits`, `withinLimits`). Its `execute` returns what it changed
 * (`ToolResult.change`), which the approval gate stores as an AgentChange (C2).
 * tool-contract.vitest.test.ts holds these rules for every registered tool.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { z } from 'zod'
import type { FEATURES, FIELDS } from '@nexus/shared/permissions'

/**
 * 4A (Owner decided 2026-10-06) — set while `execute` carries out a request a standing rule approved (`decisionVia:
 * 'auto'`), not a person. The ads change tools judge a request as the approver's own click (`gateContextFor`); inside
 * such a run their re-check asks the write gate as a machine's write instead, so a halt, autonomy OFF, pins, the
 * allowlist and his own limits refuse it exactly as before.
 */
const ruleApprovedRun = new AsyncLocalStorage<true>()
export const runAsRuleApproved = <T>(work: () => Promise<T>): Promise<T> => ruleApprovedRun.run(true, work)
export const isRuleApprovedRun = (): boolean => ruleApprovedRun.getStore() === true

export type RiskTier = 'low' | 'medium' | 'high'

/** An action permission, or a money-field permission a tool cannot be judged without. */
export type ToolPermission =
  | (typeof FEATURES)[keyof typeof FEATURES]
  | (typeof FIELDS)[keyof typeof FIELDS]

export type FieldPermission = (typeof FIELDS)[keyof typeof FIELDS]

/** MCP.7 — the front doors a tool can be offered on: the assistant in Nexus, and Claude over MCP. */
export type ToolSurface = 'app' | 'mcp'

/**
 * C1 — the front door a call came through, recorded and passed to the tool; never trusted for access.
 * `app` = a person in Nexus (the assistant, the Approvals page); `claude` = a person over MCP;
 * `fleet` = an agent-fleet worker; `system` = anything else in-process (crons, autonomous agents, re-checks).
 */
export type ToolDoor = 'app' | 'claude' | 'fleet' | 'system'

/**
 * C1 — how far an executed change can be put back.
 *   full     undo restores the value it replaced (what happened in between — orders at a price — stands)
 *   partial  only part of it can be put back (a published listing was seen; an ad spent)
 *   none     it cannot be taken back at all (a sent message)
 */
export type Reversibility = 'full' | 'partial' | 'none'

/**
 * C1 / D1 = B — how far Claude may run a change without a person, lowest first.
 *   off      not offered to Claude at all
 *   ask      a person approves it in Nexus (today, and the default for every tool)
 *   confirm  the person who asked confirms it in Claude with their authenticator code (C7)
 *   auto     runs after the undo window without a person, only inside its limits (C5)
 * A tool's `maxClaudeTrust` is the ceiling the business's own level (AgentTool row, C5) cannot exceed.
 */
export type ClaudeTrust = 'off' | 'ask' | 'confirm' | 'auto'
export const CLAUDE_TRUST_LEVELS: readonly ClaudeTrust[] = ['off', 'ask', 'confirm', 'auto']

/**
 * C9 — the preview convention: what the Approvals page reads from a change tool's dry-run preview when the tool has
 * no card of its own (most tools do not). Every key is OPTIONAL and a tool keeps its own shape beside them; adding
 * them is what makes a request approvable from the generic card, which never shows raw JSON:
 *
 *   summary    ONE plain sentence of what the change does, as a person reads it before approving
 *              ("Stock 4 → 6 on eBay IT for TEST-SKU-1."). The card's first line. (`effect`, older, is read too.)
 *   changes    the before → after table: `{ [field]: { from, to } }` — a field named as a person reads it
 *              ("base price", "title"), values plain (a number, a string, a short list); a value missing reads as
 *              "(empty)"; a nested value is counted, not dumped.
 *   totals     counts, `{ [what]: number }` in camelCase ("listingsSent" reads "listings sent"); numbers only.
 *   warning / warnings   a sentence, or several, a person must read before approving (a paused listing, a price
 *              outside a pricing floor): shown in a warning box.
 *   sku / product   the one product it changes: its SKU and its name (strings). The card says "on <name> (SKU …)".
 *
 * Whether it can be undone and whether it reaches a marketplace or a buyer come from the tool's own `reversibility`
 * and `openWorld`, never from the preview. Keep a preview to 20 detail lines plus totals (rule 8).
 */
export interface PreviewConvention {
  summary?: string
  changes?: Record<string, { from: unknown; to: unknown }>
  totals?: Record<string, number>
  warning?: string
  warnings?: string[]
  sku?: string
  product?: string
}

/** C1 — what an `execute` changed: the values it replaced and the values it wrote, in one shape per tool. */
export interface ToolChange {
  before: unknown
  after: unknown
}

/** C2 — a call of a registered tool, e.g. the request that puts a change back. */
export interface ToolRequest {
  tool: string
  args: Record<string, unknown>
}

/** C6 — the tool a change plan is asked for with, and the toolName of a plan's approval. */
export const PLAN_TOOL = 'submit-change-plan'
/** C6 — the most steps one plan holds (a bulk tool of up to 250 products counts as one step). */
export const PLAN_MAX_STEPS = 200

/**
 * C6 — a change plan: up to PLAN_MAX_STEPS change requests, approved once and run in order by the plan worker.
 * `undoes` (an undo plan): for each step, the AgentChange it puts back.
 */
export interface PlanRequest {
  title: string
  steps: ToolRequest[]
  undoes?: string[]
}

/**
 * C2 — how a change of this tool is put back. Undo is never a write of its own: it is a NEW request of
 * `request(change).tool`, through the same gate (preview, staleness, approval, audit), refused while what
 * is stored now (`current`) is no longer what the change wrote (`change.after`) — undo would overwrite
 * someone's later change.
 */
export interface ToolUndo {
  /** What is stored NOW, in the shape of `change.after`, read in the business the call runs in. */
  current: (change: ToolChange) => Promise<unknown>
  /** The request that puts `change.before` back, or why it cannot be put back. Pure: no reads, no writes. */
  request: (change: ToolChange) => ToolRequest | { refusal: string }
}

export interface ToolContext {
  userId?: string | null
  /**
   * MCP.7 — what the caller may see of output another tool stored (approval-status reads an
   * approval's preview): that tool's money filter for this caller, or null when the caller may
   * not use that tool. Set by call-tool.ts; absent means nothing stored may be shown.
   */
  storedOutput?: (toolName: string, value: unknown) => unknown | null
  /**
   * C1 — does the caller hold this permission in the business the call runs in? Their resolved permissions
   * (an owner holds all); a system caller holds all. Set by call-tool.ts on every call.
   */
  can: (permission: ToolPermission) => boolean
  /**
   * C1 — the front door. In a dry run, the caller's. In `execute`, the door the approved REQUEST came
   * through (the approver always decides in Nexus): a change Claude asked for runs with `claude`.
   */
  via: ToolDoor
  /** C1 — `execute` (and the approval's staleness re-check): the approval this run carries out. */
  approvalId?: string
  /**
   * 4A (Owner decided 2026-10-06) — `execute` only: a PERSON approved this request (in Nexus, or with his code in
   * Claude), not a standing rule (`decisionVia: 'auto'`). Such a run counts as his own click: an ads write carries his
   * manual mark (it passes a halt, autonomy OFF, pins and the allowlist) and his approval counts as "Send anyway" past
   * his own limits, which the card showed before he approved.
   */
  approvedByPerson?: boolean
  /**
   * C1 — `execute` only: the preview the person approved, raw, as the approval stores it. A tool may compare its
   * fresh dry run with it and refuse on a difference (the gate's staleness check runs just before, on the
   * MATERIAL_PREVIEW_FIELDS of the tool).
   */
  approvedPreview?: unknown
}

export interface ToolResult {
  ok: boolean
  /** Result of a read/draft tool. */
  data?: unknown
  /** Dry-run preview of a mutating tool's effect (no execution). */
  preview?: unknown
  error?: string
  /**
   * C1 — `execute`: what it changed (before → after), stored as the AgentChange of the approval (C2) and the
   * input of `undo`. Absent when nothing was changed or the tool keeps no record.
   */
  change?: ToolChange
  /**
   * C2 — a control tool's dry run only: the request the gate then queues, as a NEW request of that tool through
   * the same gate (its permissions, preview, approval, staleness). `undoes`: the AgentChange it puts back.
   */
  request?: ToolRequest & { undoes?: string }
  /**
   * C6 — a control tool's dry run only: the change plan the gate then dry-runs step by step as the caller and stores
   * as ONE approval (submit-change-plan; undo-change of a plan).
   */
  plan?: PlanRequest
  /**
   * C7 — confirm-change's dry run only: the approval the person confirms in Claude with their authenticator code. The
   * door's rule checks it (only the person who asked, only at `confirm`, nexus.run, the planHash, the expiry, the code)
   * and schedules it; nothing else can.
   */
  confirm?: { approvalId: string; planHash: string; code: string }
}

export interface AgentTool {
  name: string
  /**
   * MCP.7 — a short name a person reads (Claude shows it next to every call). Required, so a
   * tool without one does not compile.
   */
  title: string
  category: string // 'products' | 'orders' | 'fulfillment' | 'pricing' | 'listings' | 'insights' | 'comms'
  description: string
  /**
   * MCP.7 — where the tool is offered. Absent = everywhere. A tool that spends OUR AI budget
   * (the drafts) is 'app' only: Claude writes its own drafts.
   */
  surfaces?: readonly ToolSurface[]
  /**
   * MCP.7 — its preview or its real action reaches someone outside Nexus: a marketplace, or a
   * buyer's inbox. Claude is told so (openWorldHint).
   */
  openWorld?: boolean
  riskTier: RiskTier // code default; AgentTool DB row may override (stricter only for alwaysAsk)
  readOnly: boolean
  /**
   * MCP.1 — what a person must hold, all of it, to run this tool (preview or
   * execute) or to approve it. `ai.run` is added by call-tool.ts. Checked on
   * every call; there is no default, so a tool without it does not compile.
   */
  requires: readonly [ToolPermission, ...ToolPermission[]]
  /**
   * MCP.3 — the tool's arguments, in one place. call-tool.ts parses every
   * call with it (unknown keys dropped, numbers coerced, a bad call refused
   * before the tool runs); the assistant's tool list and the MCP endpoint
   * both describe the tool from it.
   */
  input: z.ZodObject
  /**
   * MCP.1 — money keys in this tool's output that the shared registry
   * (lib/auth/financial-fields.ts) does not name, each with the field
   * permission that reveals it. Stripped for a person without it.
   */
  restrictedFields?: Readonly<Record<string, FieldPermission>>
  /** Hard floor — can NEVER be auto-run (pricing/publish/customer comms/
   *  spend/fiscal). Enforced in code; the policy layer cannot downgrade it. */
  alwaysAsk?: boolean
  /** Default-on approval for a mutating tool below high tier (e.g.
   *  apply-content). high / alwaysAsk already imply approval. */
  requiresApprovalDefault?: boolean
  /**
   * C1 — every change tool (not readOnly): how far an executed change can be put back. The Approvals page
   * reads it from here, through the API; nothing else states it.
   */
  reversibility?: Reversibility
  /**
   * C7 — arguments that are secrets (an authenticator code): never written to the run record, never echoed back.
   */
  secretArgs?: readonly string[]
  /** C1/C2 — how an executed change is put back. Every executable tool that is not `none` has one (C2). */
  undo?: ToolUndo
  /**
   * C2 — a control tool (`undo-change`, `submit-change-plan`): it runs in the door and is never queued itself.
   * Its dry run (a pure read, like every handler) returns `request`, and the gate queues THAT as a new request of
   * the tool it names, with that tool's own permissions, approval and trust level. It has no `execute`.
   */
  control?: boolean
  /**
   * C1 — every change tool: the most Claude may ever do with it without a person in Nexus. Floors:
   * `none` (irreversible) is `ask` at most; `auto` needs `withinLimits`.
   */
  maxClaudeTrust?: ClaudeTrust
  /**
   * C1 — the limits a business may set for running this tool without a person (C5 stores them per business).
   * A zod object whose every field has a default: `limits.parse({})` is the code default.
   *
   * Name each limit so its direction is known (claude-trust.service.ts limitsTighten): TIGHTENING is a brake anyone
   * who may use Claude can apply; anything else needs settings.security.manage and a fresh 2FA code.
   *   `max…` number      lower is tighter            `min…` number       higher is tighter
   *   `allow…` boolean   false is tighter            `max…` enum         an earlier option is tighter (order them)
   *   a list of what is allowed (e.g. `fields`)      fewer items is tighter
   * A limit named otherwise is treated as loosening on every change.
   */
  limits?: z.ZodObject
  /**
   * C1 — is this preview inside these limits (`limits.parse(stored)`)? Null when it is; otherwise the reason,
   * in a sentence a person reads ("the price moves 14 %, more than the 10 % you allow without a person").
   */
  withinLimits?: (preview: unknown, limits: Record<string, unknown>) => string | null
  /** Dry-run preview (no side effects). Always safe to run. Call it only
   *  through call-tool.ts. */
  handler: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult>
  /** The real mutation — runs ONLY after approval (or directly when the
   *  tool requires no approval). Absent ⇒ preview-only. Call it only
   *  through call-tool.ts. */
  execute?: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult>
}
