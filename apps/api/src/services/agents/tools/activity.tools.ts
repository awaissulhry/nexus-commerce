/**
 * MCP full control C8 — what Claude did in this business, for Claude to read back ("what did you change yesterday?").
 *
 *   claude-activity   every call Claude made here (through any of the business's Claude connections), newest first:
 *                     who, which connection, which tool, and what became of it — read, refused, queued, run by the
 *                     business's rule, approved, rejected, expired, handed back, failed, undone — with the change it
 *                     made and whether undo-change can still put it back. Filters and a cursor
 *                     (services/agents/claude-activity.service.ts).
 *
 * Read only; needs ai.view, like approval-status. Previews come through the caller's own money filter (ctx.storedOutput):
 * a change of a tool the caller may not use shows no preview, and money fields they may not see are stripped.
 */

import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { ACTIVITY_FILTERS, ActivityQueryError, claudeActivity } from '../claude-activity.service.js'

const claudeActivityTool: AgentTool = {
  name: 'claude-activity',
  title: 'What Claude did',
  input: ACTIVITY_FILTERS,
  requires: [F.aiView],
  category: 'approvals',
  riskTier: 'low',
  readOnly: true,
  description:
    'List what Claude did in this business, newest first: every call through a Claude connection, who made it, and what '
    + 'became of it (read, refused, queued for a person, run by the business\'s rule, approved, rejected, expired, handed '
    + 'back, failed, undone), with the change it made and whether undo-change can still put it back. Filter by time, '
    + 'connection, tool or outcome; pass nextCursor back as cursor for older rows. Changes nothing.',
  async handler(args, ctx): Promise<ToolResult> {
    try {
      const page = await claudeActivity(args as never, ctx.storedOutput ?? (() => null))
      return { ok: true, data: page }
    } catch (error) {
      if (error instanceof ActivityQueryError) return { ok: false, error: error.message }
      throw error
    }
  },
}

export const ACTIVITY_TOOLS: AgentTool[] = [claudeActivityTool]
