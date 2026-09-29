/**
 * MCP.2 — the hourly limit is enforced now (tool-rate.ts), so the policy edit
 * only accepts a count: null for no limit, or a whole number of 0 or more.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: { agentTool: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() } },
}))

import prisma from '../../db.js'
import { setToolPolicy } from './tool-policy.service.js'

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
