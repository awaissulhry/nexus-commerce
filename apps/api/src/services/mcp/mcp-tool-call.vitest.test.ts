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
  business: { id: 'business-1', name: 'Xavia Racing' },
  via: 'claude',
  oauthGrantId: 'grant-1',
} as unknown as McpPrincipal

const tool = (readOnly: boolean) => ({ name: readOnly ? 'a-read' : 'a-change', readOnly }) as AgentTool

describe('MCP.7 — the gate Claude goes through', () => {
  beforeEach(() => {
    gate.runOrQueueTool.mockReset()
    gate.runOrQueueTool.mockResolvedValue({ ok: true, mode: 'queued', approvalId: 'approval-1' })
  })

  // C5 — always stored as a request; whether a person or the business's rule decides it is the rule's (claude-trust).
  it('a change is always sent to approval', async () => {
    await runToolForClaude(principal, tool(false), { productId: 'p-1', business: 'Xavia Racing' })
    expect(gate.runOrQueueTool).toHaveBeenCalledWith('a-change', { productId: 'p-1' }, principal, 'run-1', { forceAsk: true, rule: expect.objectContaining({ refusal: expect.any(Function), decide: expect.any(Function) }) })
  })

  it('a read is not', async () => {
    gate.runOrQueueTool.mockResolvedValue({ ok: true, mode: 'executed', data: [] })
    await runToolForClaude(principal, tool(true), {})
    expect(gate.runOrQueueTool).toHaveBeenCalledWith('a-read', {}, principal, 'run-1', { forceAsk: false, rule: expect.objectContaining({ refusal: expect.any(Function) }) })
  })
})

const db = vi.mocked((await import('../../db.js')).default, true) as unknown as {
  agentRun: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
}
const answerOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(result.content.map((block) => block.text ?? '').join(''))
const XAVIA = { id: 'business-1', name: 'Xavia Racing' }

describe('C3 — every result says which business it came from', () => {
  beforeEach(() => gate.runOrQueueTool.mockReset())

  it('a read: its own fields, with the business first', async () => {
    gate.runOrQueueTool.mockResolvedValue({ ok: true, mode: 'executed', data: { products: [{ sku: 'TEST-SKU-1' }] } })
    const result = await runToolForClaude(principal, tool(true), {})
    expect(result.isError).toBeFalsy()
    const answer = answerOf(result)
    expect(answer).toEqual({ business: XAVIA, products: [{ sku: 'TEST-SKU-1' }] })
    expect(Object.keys(answer)[0]).toBe('business')
  })

  it('a list or a bare value comes back under data', async () => {
    gate.runOrQueueTool.mockResolvedValue({ ok: true, mode: 'executed', data: [1, 2] })
    expect(answerOf(await runToolForClaude(principal, tool(true), {}))).toEqual({ business: XAVIA, data: [1, 2] })
    gate.runOrQueueTool.mockResolvedValue({ ok: true, mode: 'executed', data: null })
    expect(answerOf(await runToolForClaude(principal, tool(true), {}))).toEqual({ business: XAVIA, data: null })
  })

  it('the stamp is the token’s business, whatever a tool’s own output says', async () => {
    gate.runOrQueueTool.mockResolvedValue({ ok: true, mode: 'executed', data: { business: 'something else', n: 1 } })
    expect(answerOf(await runToolForClaude(principal, tool(true), {}))).toEqual({ business: XAVIA, n: 1 })
  })

  it('a queued change, and a refusal, carry it too', async () => {
    gate.runOrQueueTool.mockResolvedValue({ ok: true, mode: 'queued', approvalId: 'approval-1', preview: { a: 1 } })
    const queued = answerOf(await runToolForClaude(principal, tool(false), { business: 'Xavia Racing' }))
    expect(queued).toMatchObject({ business: XAVIA, status: 'waiting_for_approval', approvalId: 'approval-1', preview: { a: 1 } })
    gate.runOrQueueTool.mockResolvedValue({ ok: false, mode: 'error', error: 'Product not found' })
    const refused = await runToolForClaude(principal, tool(true), {})
    expect(refused.isError).toBe(true)
    expect(answerOf(refused)).toEqual({ business: XAVIA, error: 'Product not found' })
  })
})

describe('C3 — a change names its business: a check, never a choice', () => {
  beforeEach(() => {
    gate.runOrQueueTool.mockReset()
    gate.runOrQueueTool.mockResolvedValue({ ok: true, mode: 'queued', approvalId: 'approval-1' })
    db.agentRun.create.mockClear()
    db.agentRun.update.mockClear()
  })

  it('a change that names no business is refused, and nothing is queued', async () => {
    const result = await runToolForClaude(principal, tool(false), { productId: 'p-1' })
    expect(result.isError).toBe(true)
    expect(answerOf(result)).toEqual({
      business: XAVIA,
      error: 'Name the business this change is for: business: "Xavia Racing" (this connection works in Xavia Racing). Nothing was queued.',
    })
    expect(gate.runOrQueueTool).not.toHaveBeenCalled()
  })

  it('a change that names another business is refused in so many words, and nothing is queued', async () => {
    const result = await runToolForClaude(principal, tool(false), { productId: 'p-1', business: 'Motovento' })
    expect(result.isError).toBe(true)
    expect(answerOf(result).error).toBe('This connection works in Xavia Racing; you named Motovento. Nothing was queued.')
    expect(gate.runOrQueueTool).not.toHaveBeenCalled()
    // The refusal is a run of its own, recorded as failed.
    expect(db.agentRun.update.mock.calls.at(-1)![0].data).toMatchObject({ status: 'failed', ok: false })
  })

  it('the same name, in any case or spacing, passes; the tool never sees it, and the run records it apart', async () => {
    await runToolForClaude(principal, tool(false), { productId: 'p-1', business: '  xavia   RACING ' })
    expect(gate.runOrQueueTool).toHaveBeenCalledWith('a-change', { productId: 'p-1' }, principal, 'run-1', { forceAsk: true, rule: expect.objectContaining({ refusal: expect.any(Function), decide: expect.any(Function) }) })
    expect(db.agentRun.create.mock.calls.at(-1)![0].data.input).toEqual({
      tool: 'a-change',
      args: { productId: 'p-1' },
      business: '  xavia   RACING ',
    })
  })

  it('a read need not name the business; one that names another is refused too', async () => {
    gate.runOrQueueTool.mockResolvedValue({ ok: true, mode: 'executed', data: {} })
    await runToolForClaude(principal, tool(true), {})
    expect(gate.runOrQueueTool).toHaveBeenCalledTimes(1)
    const wrong = await runToolForClaude(principal, tool(true), { business: 'Motovento' })
    expect(wrong.isError).toBe(true)
    expect(gate.runOrQueueTool).toHaveBeenCalledTimes(1)
    await runToolForClaude(principal, tool(true), { business: 'Xavia Racing' })
    expect(gate.runOrQueueTool).toHaveBeenLastCalledWith('a-read', {}, principal, 'run-1', { forceAsk: false, rule: expect.objectContaining({ refusal: expect.any(Function) }) })
  })

  it('a business named by something other than a name is refused, never used', async () => {
    const result = await runToolForClaude(principal, tool(false), { business: { id: 'business-2' } })
    expect(result.isError).toBe(true)
    expect(gate.runOrQueueTool).not.toHaveBeenCalled()
  })
})
