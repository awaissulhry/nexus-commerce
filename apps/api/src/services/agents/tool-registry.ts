/**
 * ACP.1 — capability/tool registry. Aggregates the per-domain tool files
 * into one lookup. Types live in tool-types.ts (avoids an import cycle
 * between the registry and the tool files).
 */

import type { AgentTool } from './tool-types.js'
import { READ_TOOLS } from './tools/read.tools.js'
import { ANALYTICS_TOOLS } from './tools/analytics.tools.js'
import { DRAFT_TOOLS } from './tools/draft.tools.js'
import { MUTATE_TOOLS } from './tools/mutate.tools.js'
import { ADS_PROPOSE_TOOLS } from './tools/ads-propose.tools.js'
import { APPROVAL_TOOLS } from './tools/approval.tools.js'
import { CHANNEL_TOOLS } from './tools/channel.tools.js'
import { BULK_TOOLS } from './tools/bulk.tools.js'

export type {
  RiskTier,
  ToolContext,
  ToolResult,
  AgentTool,
} from './tool-types.js'

const ALL: AgentTool[] = [
  ...READ_TOOLS,
  ...ANALYTICS_TOOLS,
  ...DRAFT_TOOLS,
  ...MUTATE_TOOLS,
  // NAF.C — preview-only ads propose tools (no execute until Phase F).
  ...ADS_PROPOSE_TOOLS,
  // MCP.7 — what became of a queued change (Claude follows up; only a person decides).
  ...APPROVAL_TOOLS,
  // MCP.9 — cross-channel reads: listing issues, channel price and stock, out-of-sync listings.
  ...CHANNEL_TOOLS,
  // MCP.10 — bulk master price and master attribute changes, always approved by a person.
  ...BULK_TOOLS,
]
const REGISTRY = new Map<string, AgentTool>(ALL.map((t) => [t.name, t]))

export function getTool(name: string): AgentTool | undefined {
  return REGISTRY.get(name)
}
export function listTools(): AgentTool[] {
  return [...REGISTRY.values()]
}
