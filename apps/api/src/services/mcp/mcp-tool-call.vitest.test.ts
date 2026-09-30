/**
 * MCP.7 — a change Claude asks for always waits for a person (D1 = A), whatever the tool's policy
 * says: runToolForClaude tightens the gate for every tool that is not read-only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const gate = vi.hoisted(() => ({ runOrQueueTool: vi.fn() }))
vi.mock('../agents/approval-gate.service.js', () => gate)
vi.mock('../../db.js', () => ({
  default: {
    agentRun: {
      create: vi.fn(async () => ({ id: 'run-1' })),
      update: vi.fn(async () => ({})),
    },
  },
}))
vi.mock('../../lib/workspace-context.js', () => ({ withWorkspace: (_ctx: unknown, work: () => unknown) => work() }))
vi.mock('../ai/providers/index.js', () => ({ isAiKillSwitchOn: () => false }))
vi.mock('../oauth/oauth-config.js', () => ({ oauthIssuer: () => 'https://web.example.test' }))

import { runToolForClaude } from './mcp-tool-call.js'
import type { McpPrincipal } from './mcp-auth.js'
import type { AgentTool } from '../agents/tool-types.js'

const principal = {
  kind: 'user',
  userId: 'user-1',
  label: 'Example Person',
  permissions: { isOwner: false, permissions: new Set<string>() },
  workspace: { workspaceId: 'business-1' },
  via: 'claude',
  oauthGrantId: 'grant-1',
} as unknown as McpPrincipal

const tool = (readOnly: boolean) => ({ name: readOnly ? 'a-read' : 'a-change', readOnly }) as AgentTool

describe('MCP.7 — the gate Claude goes through', () => {
  beforeEach(() => {
    gate.runOrQueueTool.mockReset()
    gate.runOrQueueTool.mockResolvedValue({ ok: true, mode: 'queued', approvalId: 'approval-1' })
  })

  it('a change is always sent to approval', async () => {
    await runToolForClaude(principal, tool(false), { productId: 'p-1' })
    expect(gate.runOrQueueTool).toHaveBeenCalledWith('a-change', { productId: 'p-1' }, principal, 'run-1', { forceAsk: true })
  })

  it('a read is not', async () => {
    gate.runOrQueueTool.mockResolvedValue({ ok: true, mode: 'executed', data: [] })
    await runToolForClaude(principal, tool(true), {})
    expect(gate.runOrQueueTool).toHaveBeenCalledWith('a-read', {}, principal, 'run-1', { forceAsk: false })
  })
})
