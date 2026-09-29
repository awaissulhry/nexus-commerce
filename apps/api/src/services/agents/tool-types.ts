/**
 * ACP.1 — shared tool types (kept separate from the registry to avoid an
 * import cycle between the registry and the per-domain tool files).
 */

import type { FEATURES, FIELDS } from '@nexus/shared/permissions'

export type RiskTier = 'low' | 'medium' | 'high'

/** An action permission, or a money-field permission a tool cannot be judged without. */
export type ToolPermission =
  | (typeof FEATURES)[keyof typeof FEATURES]
  | (typeof FIELDS)[keyof typeof FIELDS]

export type FieldPermission = (typeof FIELDS)[keyof typeof FIELDS]

export interface ToolContext {
  userId?: string | null
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
  category: string // 'products' | 'orders' | 'fulfillment' | 'pricing' | 'listings' | 'insights' | 'comms'
  description: string
  riskTier: RiskTier // code default; AgentTool DB row may override (stricter only for alwaysAsk)
  readOnly: boolean
  /**
   * MCP.1 — what a person must hold, all of it, to run this tool (preview or
   * execute) or to approve it. `ai.run` is added by call-tool.ts. Checked on
   * every call; there is no default, so a tool without it does not compile.
   */
  requires: readonly [ToolPermission, ...ToolPermission[]]
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
