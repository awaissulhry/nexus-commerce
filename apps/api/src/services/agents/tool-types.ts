/**
 * ACP.1 — shared tool types (kept separate from the registry to avoid an
 * import cycle between the registry and the per-domain tool files).
 */

import type { z } from 'zod'
import type { FEATURES, FIELDS } from '@nexus/shared/permissions'

export type RiskTier = 'low' | 'medium' | 'high'

/** An action permission, or a money-field permission a tool cannot be judged without. */
export type ToolPermission =
  | (typeof FEATURES)[keyof typeof FEATURES]
  | (typeof FIELDS)[keyof typeof FIELDS]

export type FieldPermission = (typeof FIELDS)[keyof typeof FIELDS]

/** MCP.7 — the front doors a tool can be offered on: the assistant in Nexus, and Claude over MCP. */
export type ToolSurface = 'app' | 'mcp'

export interface ToolContext {
  userId?: string | null
  /**
   * MCP.7 — what the caller may see of output another tool stored (approval-status reads an
   * approval's preview): that tool's money filter for this caller, or null when the caller may
   * not use that tool. Set by call-tool.ts; absent means nothing stored may be shown.
   */
  storedOutput?: (toolName: string, value: unknown) => unknown | null
}

export interface ToolResult {
  ok: boolean
  /** Result of a read/draft tool. */
  data?: unknown
  /** Dry-run preview of a mutating tool's effect (no execution). */
  preview?: unknown
  error?: string
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
