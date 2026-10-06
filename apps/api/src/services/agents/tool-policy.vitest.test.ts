/**
 * MCP.2 — the hourly limit is enforced now (tool-rate.ts), so the policy edit
 * only accepts a count: null for no limit, or a whole number of 0 or more.
 *
 * AA-W2-1 — the alwaysAsk floor holds for a strategy-bound ad tool too: the
 * in-app assistant (tool-loop.service.ts) runs a tool straight away only when
 * this policy says it needs no approval, and for such a tool it always does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AgentTool } from './tool-types.js'

vi.mock('../../db.js', () => ({
  default: { agentTool: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() } },
}))

/** A strategy-bound Amazon ad tool whose Claude ceiling is auto: what a W2 tool PR makes of an ad tool. */
const BOUND: AgentTool = {
  name: 'set-example-bid',
  title: 'Example bid',
  category: 'advertising',
  description: 'test tool',
  riskTier: 'medium',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  maxClaudeTrust: 'auto',
  requires: ['ads.bids.edit'],
  input: z.object({}),
  limits: z.object({ maxRaisePct: z.number().default(0) }),
  withinLimits: () => 'no limit facts',
  handler: async () => ({ ok: true, preview: {} }),
  execute: async () => ({ ok: true }),
}
vi.mock('./tool-registry.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./tool-registry.js')>()
  return {
    ...real,
    getTool: (name: string) => (name === BOUND.name ? BOUND : real.getTool(name)),
    listTools: () => [...real.listTools(), BOUND],
  }
})

import prisma from '../../db.js'
import { bustPolicyCache, resolveToolPolicy, setToolPolicy } from './tool-policy.service.js'

const db = vi.mocked(prisma, true)

beforeEach(() => {
  vi.clearAllMocks()
  db.agentTool.upsert.mockResolvedValue({} as never)
})

describe('MCP.2 — rateLimitPerHour must be a count', () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s and writes nothing', async (limit) => {
    const out = await setToolPolicy('product-search', { rateLimitPerHour: limit })
    expect(out).toEqual({ ok: false, error: 'rateLimitPerHour must be null or a whole number of 0 or more' })
    expect(db.agentTool.upsert).not.toHaveBeenCalled()
  })

  it.each([null, 0, 30])('accepts %s', async (limit) => {
    expect(await setToolPolicy('product-search', { rateLimitPerHour: limit })).toEqual({ ok: true })
    expect(db.agentTool.upsert.mock.calls[0]![0]!.update).toEqual({ rateLimitPerHour: limit })
  })
})

describe('AA-W2-1 — a strategy-bound ad tool keeps the alwaysAsk floor for the in-app assistant', () => {
  it('an operator override cannot lower its tier or switch its approval off, whatever its Claude ceiling', async () => {
    db.agentTool.findMany.mockResolvedValue([
      { name: BOUND.name, riskTier: 'low', enabled: true, requiresApproval: false, rateLimitPerHour: null, dailyBudgetUSD: null },
    ] as never)
    bustPolicyCache()
    expect(await resolveToolPolicy(BOUND.name)).toMatchObject({ riskTier: 'high', requiresApproval: true, alwaysAsk: true })
  })

  it('the policy edit refuses to lower it, and writes nothing', async () => {
    expect(await setToolPolicy(BOUND.name, { riskTier: 'low' })).toEqual({ ok: false, error: `${BOUND.name} is always-ask and cannot be set below 'high'` })
    expect(await setToolPolicy(BOUND.name, { requiresApproval: false })).toEqual({ ok: false, error: `${BOUND.name} is always-ask; approval cannot be disabled` })
    expect(db.agentTool.upsert).not.toHaveBeenCalled()
  })
})
