/**
 * MCP.1 — the approval gate names its principal.
 *
 * Before MCP.1 the copilot's approve route needed only `ai.run`, so a person
 * who may not change prices could approve a price change, and it recorded the
 * decider as nobody. These lock down the fix: a person approves only what
 * they could have done, the decision carries their name, and the stored
 * preview stays whole while the caller gets a filtered one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool } from './tool-types.js'

const handler = vi.fn()
const execute = vi.fn()

const TOOLS: Record<string, AgentTool> = {
  'change-price': {
    name: 'change-price',
    category: 'pricing',
    description: 'test tool',
    riskTier: 'high',
    readOnly: false,
    alwaysAsk: true,
    requires: ['products.price.edit'],
    handler,
    execute,
  },
}

vi.mock('./tool-registry.js', () => ({
  getTool: (name: string) => TOOLS[name],
  listTools: () => Object.values(TOOLS),
}))
vi.mock('./tool-policy.service.js', () => ({
  resolveToolPolicy: vi.fn(async (name: string) =>
    TOOLS[name]
      ? { name, riskTier: 'high', enabled: true, requiresApproval: true, readOnly: false }
      : null,
  ),
}))
vi.mock('../../db.js', () => ({
  default: {
    agentApproval: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    agentRun: { create: vi.fn() },
  },
}))

import prisma from '../../db.js'
import { decideApproval, runOrQueueTool } from './approval-gate.service.js'
import { systemPrincipal, type UserPrincipal } from './call-tool.js'

const db = vi.mocked(prisma, true)

function person(permissions: string[]): UserPrincipal {
  return {
    kind: 'user',
    userId: 'u1',
    label: 'Awais',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    via: 'app',
  }
}

const PRICE_PERSON = person(['ai.run', 'products.price.edit'])
const VIEWER = person(['ai.run', 'products.view'])

beforeEach(() => {
  vi.clearAllMocks()
  handler.mockResolvedValue({ ok: true, preview: { price: { from: 10, to: 12 }, costPrice: 7 } })
  execute.mockResolvedValue({ ok: true, data: { changed: true, costPrice: 7 } })
  db.agentApproval.findUnique.mockResolvedValue({
    id: 'a1',
    status: 'pending',
    toolName: 'change-price',
    args: { price: 12 },
  } as never)
  db.agentApproval.updateMany.mockResolvedValue({ count: 1 } as never)
  db.agentApproval.update.mockResolvedValue({} as never)
  db.agentApproval.create.mockResolvedValue({ id: 'a1' } as never)
})

describe('MCP.1 — who may approve', () => {
  it('refuses a person who could not make the change, before claiming the row', async () => {
    const out = await decideApproval('a1', 'approve', VIEWER)
    expect(out).toMatchObject({ ok: false, code: 'forbidden' })
    expect(out.error).toContain('products.price.edit')
    expect(db.agentApproval.updateMany).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('lets a person with the permission approve, under their own name and id', async () => {
    const out = await decideApproval('a1', 'approve', PRICE_PERSON)
    expect(out).toMatchObject({ ok: true, status: 'executed' })
    expect(db.agentApproval.updateMany.mock.calls[0]![0]!.data).toMatchObject({
      status: 'executing',
      decidedBy: 'Awais',
    })
    expect(execute).toHaveBeenCalledWith({ price: 12 }, { userId: 'u1' })
  })

  it('hands the approver a result without money they may not see', async () => {
    const out = await decideApproval('a1', 'approve', PRICE_PERSON)
    expect(out.result).toEqual({ changed: true })
  })

  it('anyone who may use the assistant can say no', async () => {
    const out = await decideApproval('a1', 'reject', VIEWER, 'not now')
    expect(out).toMatchObject({ ok: true, status: 'rejected' })
    expect(db.agentApproval.update.mock.calls[0]![0]!.data).toMatchObject({ decidedBy: 'Awais' })
  })

  it('the sweep runs a decision already taken, under the decider’s name', async () => {
    const out = await decideApproval('a1', 'approve', systemPrincipal('Awais'))
    expect(out.ok).toBe(true)
    expect(execute).toHaveBeenCalledWith({ price: 12 }, { userId: 'Awais' })
  })
})

describe('MCP.1 — queueing', () => {
  it('stores the whole preview and returns the filtered one', async () => {
    const out = await runOrQueueTool('change-price', { price: 12 }, PRICE_PERSON, 'run1')
    expect(out).toEqual({
      ok: true,
      mode: 'queued',
      approvalId: 'a1',
      preview: { price: { from: 10, to: 12 } },
    })
    expect(db.agentApproval.create.mock.calls[0]![0]!.data).toMatchObject({
      preview: { price: { from: 10, to: 12 }, costPrice: 7 },
    })
  })

  it('a person without the permission cannot even queue it', async () => {
    const out = await runOrQueueTool('change-price', { price: 12 }, VIEWER, 'run1')
    expect(out).toMatchObject({ ok: false, mode: 'error' })
    expect(handler).not.toHaveBeenCalled()
    expect(db.agentApproval.create).not.toHaveBeenCalled()
  })
})
