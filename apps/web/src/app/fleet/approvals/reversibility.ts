/**
 * MCP full control C1 — how far an approved change can be put back, as the API states it.
 *
 * The tool registry is the ONLY place that decides this (`AgentTool.reversibility` in apps/api); every approval row
 * the API sends carries it as `reversibility`. The page used to keep its own copy (`undoable` on each tool card)
 * next to two lists on the server, and the three drifted. Now the page only reads the row. Anything it cannot read
 * — an older API, an unknown tool — is treated as `none`, the safe direction to be wrong in.
 */
export type Reversibility = 'full' | 'partial' | 'none'

export function reversibilityFrom(value: unknown): Reversibility {
  return value === 'full' || value === 'partial' ? value : 'none'
}
