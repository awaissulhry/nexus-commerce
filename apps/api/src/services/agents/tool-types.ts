/**
 * ACP.1 — shared tool types (kept separate from the registry to avoid an
 * import cycle between the registry and the per-domain tool files).
 */

export type RiskTier = 'low' | 'medium' | 'high'

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
  /** Hard floor — can NEVER be auto-run (pricing/publish/customer comms/
   *  spend/fiscal). Enforced in code; the policy layer cannot downgrade it. */
  alwaysAsk?: boolean
  /** Default-on approval for a mutating tool below high tier (e.g.
   *  apply-content). high / alwaysAsk already imply approval. */
  requiresApprovalDefault?: boolean
  /** Dry-run preview (no side effects). Always safe to run. */
  handler: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult>
  /** The real mutation — runs ONLY after approval (or directly when the
   *  tool requires no approval). Absent ⇒ preview-only. */
  execute?: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult>
}
