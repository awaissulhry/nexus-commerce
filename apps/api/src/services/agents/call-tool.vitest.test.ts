/**
 * MCP.1 — the one door every agent tool runs through (call-tool.ts).
 *
 * Locks down the three things a person's call must get right: the permission
 * is checked before the tool runs, the tool runs in the person's business and
 * nowhere else, and the money a person may not see never comes back. A system
 * principal (crons, the fleet) is the one exception, and only for 1 and 3.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AgentTool } from './tool-types.js'

const handler = vi.fn()
const execute = vi.fn()

const TOOLS: Record<string, AgentTool> = {
  'read-sales': {
    name: 'read-sales',
    title: 'Test tool',
    category: 'insights',
    description: 'test tool',
    riskTier: 'low',
    readOnly: true,
    requires: ['insights.view'],
    restrictedFields: { revenue: 'financials.revenue.view' },
    input: z.object({}).loose(),
    handler,
  },
  'change-price': {
    name: 'change-price',
    title: 'Test tool',
    category: 'pricing',
    description: 'test tool',
    riskTier: 'high',
    readOnly: false,
    alwaysAsk: true,
    requires: ['products.price.edit'],
    input: z.object({}).loose(),
    handler,
    execute,
  },
  'strict-args': {
    name: 'strict-args',
    title: 'Test tool',
    category: 'pricing',
    description: 'test tool',
    riskTier: 'high',
    readOnly: false,
    requires: ['products.price.edit'],
    input: z.object({ productId: z.string().min(1), price: z.coerce.number().min(0) }),
    handler,
    execute,
  },
  'draft-copy': {
    name: 'draft-copy',
    title: 'Draft copy',
    category: 'products',
    description: 'test tool',
    riskTier: 'low',
    readOnly: true,
    surfaces: ['app'],
    requires: ['products.view'],
    input: z.object({}).loose(),
    handler,
  },
  'preview-only': {
    name: 'preview-only',
    title: 'Test tool',
    category: 'advertising',
    description: 'test tool',
    riskTier: 'high',
    readOnly: false,
    requires: ['ads.bids.edit', 'financials.adspend.view'],
    input: z.object({}).loose(),
    handler,
  },
}

vi.mock('./tool-registry.js', () => ({
  getTool: (name: string) => TOOLS[name],
  listTools: () => Object.values(TOOLS),
}))

import { withWorkspace, workspaceContext } from '../../lib/workspace-context.js'
import {
  approvableToolNames,
  callTool,
  executeTool,
  missingPermissions,
  systemPrincipal,
  toolsFor,
  ToolAccessError,
  type UserPrincipal,
} from './call-tool.js'

const WS_A = { workspaceId: 'ws_alpha_0001', actorUserId: 'u1', membershipId: 'm1', roleKeys: ['OPS'] }
const WS_B = { workspaceId: 'ws_bravo_0002', actorUserId: 'u1', membershipId: 'm2', roleKeys: ['OPS'] }

function person(permissions: string[], workspace = WS_A): UserPrincipal {
  return {
    kind: 'user',
    userId: 'u1',
    label: 'Awais',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    workspace,
    via: 'app',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  handler.mockResolvedValue({ ok: true, data: { units: 4, revenue: 120, costPrice: 30 } })
  execute.mockResolvedValue({ ok: true, data: { changed: true, costPrice: 30 } })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('MCP.1 — permission on every call', () => {
  it('names every missing permission, ai.run first', () => {
    expect(missingPermissions(person([]), TOOLS['preview-only'])).toEqual([
      'ai.run',
      'ads.bids.edit',
      'financials.adspend.view',
    ])
    expect(missingPermissions(person(['ai.run', 'insights.view']), TOOLS['read-sales'])).toEqual([])
  })

  it('an owner and a system principal need nothing', () => {
    const owner = { ...person([]), permissions: { isOwner: true, permissions: new Set<string>() } }
    expect(missingPermissions(owner, TOOLS['change-price'])).toEqual([])
    expect(missingPermissions(systemPrincipal('cron'), TOOLS['change-price'])).toEqual([])
  })

  it('refuses before the tool runs — the handler is never reached', async () => {
    const call = callTool(person(['ai.run', 'insights.view']), 'change-price', { price: 1 })
    await expect(call).rejects.toMatchObject({ code: 'forbidden', statusCode: 403 })
    await expect(call).rejects.toThrow('products.price.edit')
    expect(handler).not.toHaveBeenCalled()
  })

  it('refuses a tool the registry does not know', async () => {
    await expect(callTool(person(['ai.run']), 'nope', {})).rejects.toMatchObject({
      code: 'unknown_tool',
      statusCode: 404,
    })
  })

  it('offers a model only the tools the person may call', () => {
    expect(toolsFor(person(['ai.run', 'insights.view'])).map((t) => t.name)).toEqual(['read-sales'])
    expect(toolsFor(person(['insights.view']))).toEqual([])
  })

  it('lists what a person may approve; null means no limit', () => {
    expect(approvableToolNames(person(['ai.run', 'products.price.edit']))).toEqual(['change-price', 'strict-args'])
    expect(approvableToolNames(systemPrincipal('sweep'))).toBeNull()
  })
})

describe('MCP.1 — the business comes from the principal', () => {
  it('runs the tool inside the principal’s business', async () => {
    let seen: string | undefined
    handler.mockImplementation(async () => {
      seen = workspaceContext()?.workspaceId
      return { ok: true, data: {} }
    })
    await callTool(person(['ai.run', 'insights.view']), 'read-sales', {})
    expect(seen).toBe(WS_A.workspaceId)
  })

  it('refuses when a different business is already bound', async () => {
    const call = withWorkspace(WS_B, () =>
      callTool(person(['ai.run', 'insights.view'], WS_A), 'read-sales', {}),
    )
    await expect(call).rejects.toMatchObject({ code: 'workspace_mismatch', statusCode: 403 })
    expect(handler).not.toHaveBeenCalled()
  })

  it('refuses a person with no business while business profiles are on', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    const noBusiness = { ...person(['ai.run', 'insights.view']), workspace: undefined }
    await expect(callTool(noBusiness, 'read-sales', {})).rejects.toBeInstanceOf(ToolAccessError)
    expect(handler).not.toHaveBeenCalled()
  })

  it('passes the person’s id to the tool, never a label', async () => {
    await callTool(person(['ai.run', 'insights.view']), 'read-sales', {})
    expect(handler).toHaveBeenCalledWith({}, { userId: 'u1', storedOutput: expect.any(Function) })
  })
})

describe('MCP.1 — money a person may not see never comes back', () => {
  it('strips registry and tool-declared money keys, and keeps the raw result whole', async () => {
    const out = await callTool(person(['ai.run', 'insights.view']), 'read-sales', {})
    expect(out.visible).toEqual({ ok: true, data: { units: 4 } })
    expect(out.raw).toEqual({ ok: true, data: { units: 4, revenue: 120, costPrice: 30 } })
  })

  it('a grain permission reveals only its own keys', async () => {
    const out = await callTool(
      person(['ai.run', 'insights.view', 'financials.revenue.view']),
      'read-sales',
      {},
    )
    expect(out.visible.data).toEqual({ units: 4, revenue: 120 })
  })

  it('financials.view sees everything, with no copy made', async () => {
    const out = await callTool(person(['ai.run', 'insights.view', 'financials.view']), 'read-sales', {})
    expect(out.visible).toBe(out.raw)
  })

  it('keeps class instances such as Decimal and Date exactly as they are', async () => {
    class Money {
      constructor(readonly value: string) {}
      toJSON() {
        return this.value
      }
    }
    const price = new Money('19.90')
    const at = new Date('2026-09-29T10:00:00Z')
    handler.mockResolvedValue({ ok: true, data: { rows: [{ price, at, costPrice: 3 }] } })
    const out = await callTool(person(['ai.run', 'insights.view']), 'read-sales', {})
    const row = (out.visible.data as { rows: Record<string, unknown>[] }).rows[0]
    expect(row.price).toBe(price)
    expect(row.at).toBe(at)
    expect(row).not.toHaveProperty('costPrice')
  })

  it('a key named like an Object method is not treated as money', async () => {
    handler.mockResolvedValue({ ok: true, data: { constructor: 'kept', toString: 'kept' } })
    const out = await callTool(person(['ai.run', 'insights.view']), 'read-sales', {})
    expect(out.visible.data).toEqual({ constructor: 'kept', toString: 'kept' })
  })

  it('a system principal gets the raw result', async () => {
    const out = await callTool(systemPrincipal('cron'), 'read-sales', {})
    expect(out.visible).toBe(out.raw)
  })
})

describe('MCP.3 — every call is parsed with the tool’s own schema', () => {
  const pricer = () => person(['ai.run', 'products.price.edit'])

  it('refuses a malformed call with 400, naming every problem, before the tool runs', async () => {
    const call = callTool(pricer(), 'strict-args', { price: 'lots' })
    await expect(call).rejects.toMatchObject({ code: 'invalid_arguments', statusCode: 400 })
    await expect(call).rejects.toThrow(/productId: .*; price: /)
    expect(handler).not.toHaveBeenCalled()
  })

  it('hands the tool only what its schema defines, with numbers as numbers', async () => {
    await callTool(pricer(), 'strict-args', { productId: 'p1', price: '19.90', smuggled: 'x' })
    expect(handler).toHaveBeenCalledWith({ productId: 'p1', price: 19.9 }, { userId: 'u1', storedOutput: expect.any(Function) })
  })

  it('parses stored arguments again before execute', async () => {
    await expect(executeTool(pricer(), 'strict-args', { productId: 'p1', price: -1 })).rejects.toMatchObject({
      code: 'invalid_arguments',
    })
    expect(execute).not.toHaveBeenCalled()
    await executeTool(pricer(), 'strict-args', { productId: 'p1', price: '5' })
    expect(execute).toHaveBeenCalledWith({ productId: 'p1', price: 5 }, { userId: 'u1' })
  })

  it('checks permission before arguments: a stranger learns nothing about the schema', async () => {
    await expect(callTool(person(['ai.run']), 'strict-args', {})).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('MCP.1 — execute', () => {
  it('runs execute as the person, filtered for them', async () => {
    const out = await executeTool(person(['ai.run', 'products.price.edit']), 'change-price', { price: 1 })
    expect(execute).toHaveBeenCalledWith({ price: 1 }, { userId: 'u1' })
    expect(out.visible.data).toEqual({ changed: true })
  })

  it('a system principal carries the decider’s name into the write', async () => {
    await executeTool(systemPrincipal('Awais'), 'change-price', { price: 1 })
    expect(execute).toHaveBeenCalledWith({ price: 1 }, { userId: 'Awais' })
  })

  it('refuses a preview-only tool', async () => {
    await expect(executeTool(systemPrincipal('x'), 'preview-only', {})).rejects.toThrow('preview-only')
  })

  it('refuses a person without the permission before anything runs', async () => {
    await expect(
      executeTool(person(['ai.run']), 'change-price', { price: 1 }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('MCP.7 — each door is offered its own tools', () => {
  const viaClaude = (permissions: string[]): UserPrincipal => ({ ...person(permissions), via: 'claude', oauthGrantId: 'g1' })

  it('an app-only tool is offered in the app, and not to Claude', () => {
    expect(toolsFor(person(['ai.run', 'products.view'])).map((t) => t.name)).toEqual(['draft-copy'])
    expect(toolsFor(viaClaude(['ai.run', 'products.view']))).toEqual([])
    expect(toolsFor(systemPrincipal('cron')).map((t) => t.name)).toContain('draft-copy')
  })

  it('Claude cannot call it by name either, and it never runs', async () => {
    await expect(callTool(viaClaude(['ai.run', 'products.view']), 'draft-copy', {})).rejects.toMatchObject({
      code: 'unknown_tool',
      statusCode: 404,
    })
    // Not even its permission is named: over this door the tool does not exist.
    await expect(callTool(viaClaude([]), 'draft-copy', {})).rejects.toMatchObject({ code: 'unknown_tool' })
    expect(handler).not.toHaveBeenCalled()
    await callTool(person(['ai.run', 'products.view']), 'draft-copy', {})
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('approving is not a door: what a person may approve ignores surfaces', () => {
    expect(approvableToolNames(person(['ai.run', 'products.view']))).toEqual(['draft-copy'])
  })
})

describe('MCP.7 — another tool’s stored output, as the caller may see it', () => {
  beforeEach(() => {
    handler.mockImplementation(async (_args, ctx) => ({
      ok: true,
      data: { seen: ctx.storedOutput('change-price', { price: 1, costPrice: 30 }) },
    }))
  })

  it('money-filtered for a person who may use the tool that stored it', async () => {
    const out = await callTool(person(['ai.run', 'insights.view', 'products.price.edit']), 'read-sales', {})
    expect(out.visible.data).toEqual({ seen: { price: 1 } })
  })

  it('nothing for a person who may not', async () => {
    const out = await callTool(person(['ai.run', 'insights.view']), 'read-sales', {})
    expect(out.visible.data).toEqual({ seen: null })
  })

  it('nothing for a tool the registry no longer knows, unless the caller is the system', async () => {
    handler.mockImplementation(async (_args, ctx) => ({ ok: true, data: { seen: ctx.storedOutput('gone', { a: 1 }) } }))
    expect((await callTool(person(['ai.run', 'insights.view']), 'read-sales', {})).visible.data).toEqual({ seen: null })
    expect((await callTool(systemPrincipal('cron'), 'read-sales', {})).visible.data).toEqual({ seen: { a: 1 } })
  })
})
