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
  handler: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult>
}
