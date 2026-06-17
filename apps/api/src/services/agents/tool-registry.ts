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
]
const REGISTRY = new Map<string, AgentTool>(ALL.map((t) => [t.name, t]))

export function getTool(name: string): AgentTool | undefined {
  return REGISTRY.get(name)
}
export function listTools(): AgentTool[] {
  return [...REGISTRY.values()]
}
