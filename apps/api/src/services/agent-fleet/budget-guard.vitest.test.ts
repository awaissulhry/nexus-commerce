/**
 * NAF.A — budget guard: per-run circuit breaker (pure) + per-charter-day and
 * per-fleet-day ceilings (DB-backed, FAIL CLOSED). This is the enforcement
 * AgentTool.dailyBudgetUSD never got.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentRun: {
      aggregate: vi.fn(),
    },
  },
}))

import prisma from '../../db.js'
import {
  checkCharterDayBudget,
  checkFleetDayBudget,
  checkRunBudget,
} from './budget-guard.js'

const aggregate = vi.mocked(prisma.agentRun.aggregate)

beforeEach(() => {
  vi.clearAllMocks()
})

const CAPS = { maxTokensPerRun: 1000, maxToolCallsPerRun: 2 }

describe('checkRunBudget (pure)', () => {
  it('allows a run under both caps', () => {
    expect(checkRunBudget({ tokens: 999, toolCalls: 1 }, CAPS)).toEqual({
      ok: true,
    })
  })

  it('denies at the token boundary — a run that spent its allowance stops', () => {
    const v = checkRunBudget({ tokens: 1000, toolCalls: 0 }, CAPS)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('tokens')
  })

  it('denies over the token cap', () => {
    const v = checkRunBudget({ tokens: 1500, toolCalls: 0 }, CAPS)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('tokens')
  })

  it('denies at the tool-call boundary', () => {
    const v = checkRunBudget({ tokens: 0, toolCalls: 2 }, CAPS)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('tool_calls')
  })

  it('ACCEPTANCE: aborts mid-run when cumulative tokens cross the cap', () => {
    // A simulated run loop: each step consumes tokens, the guard is
    // consulted after every step, and the loop must stop mid-run — not
    // after — the moment the cumulative spend crosses the cap.
    const stepCost = 400
    const used = { tokens: 0, toolCalls: 0 }
    let stepsExecuted = 0
    let aborted = false
    for (let i = 0; i < 10; i++) {
      used.tokens += stepCost
      stepsExecuted++
      const verdict = checkRunBudget(used, CAPS)
      if (!verdict.ok) {
        aborted = true
        expect(verdict.reason).toBe('tokens')
        break
      }
    }
    expect(aborted).toBe(true)
    expect(stepsExecuted).toBe(3) // 400, 800 ok; 1200 crosses 1000 → abort
    expect(stepsExecuted).toBeLessThan(10) // demonstrably mid-run
  })
})

describe('checkCharterDayBudget', () => {
  it('allows when today’s spend is under the budget', async () => {
    aggregate.mockResolvedValue({ _sum: { costUSD: 0.1 } } as never)
    expect(await checkCharterDayBudget('fleet-selftest', 0.25)).toEqual({
      ok: true,
    })
    // scoped to the charter's runs today via agentKey
    const where = aggregate.mock.calls[0]![0]!.where as Record<string, unknown>
    expect(where.agentKey).toBe('fleet-selftest')
  })

  it('denies at/over the daily budget', async () => {
    aggregate.mockResolvedValue({ _sum: { costUSD: 0.25 } } as never)
    const v = await checkCharterDayBudget('fleet-selftest', 0.25)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('charter_day')
  })

  it('treats a null sum (no runs today) as zero spend', async () => {
    aggregate.mockResolvedValue({ _sum: { costUSD: null } } as never)
    expect((await checkCharterDayBudget('fleet-selftest', 0.25)).ok).toBe(true)
  })

  it('FAILS CLOSED when the DB is unreadable', async () => {
    aggregate.mockRejectedValue(new Error('pooler blip'))
    const v = await checkCharterDayBudget('fleet-selftest', 0.25)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reason).toBe('charter_day')
      expect(v.detail).toContain('unreadable')
    }
  })
})

describe('checkFleetDayBudget', () => {
  it('sums only fleet runs (mode NOT NULL) and allows under the ceiling', async () => {
    aggregate.mockResolvedValue({ _sum: { costUSD: 1.2 } } as never)
    expect(await checkFleetDayBudget(2.0)).toEqual({ ok: true })
    const where = aggregate.mock.calls[0]![0]!.where as Record<string, unknown>
    expect(where.mode).toEqual({ not: null })
  })

  it('denies at the ceiling', async () => {
    aggregate.mockResolvedValue({ _sum: { costUSD: 2.0 } } as never)
    const v = await checkFleetDayBudget(2.0)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('fleet_day')
  })

  it('FAILS CLOSED when the DB is unreadable', async () => {
    aggregate.mockRejectedValue(new Error('down'))
    const v = await checkFleetDayBudget(2.0)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('fleet_day')
  })

  it('bounds "today" in UTC — createdAt window passed as Dates', async () => {
    aggregate.mockResolvedValue({ _sum: { costUSD: 0 } } as never)
    await checkFleetDayBudget(2.0)
    const where = aggregate.mock.calls[0]![0]!.where as {
      createdAt: { gte: Date; lt: Date }
    }
    expect(where.createdAt.gte).toBeInstanceOf(Date)
    expect(where.createdAt.lt).toBeInstanceOf(Date)
    const gte = where.createdAt.gte
    expect(gte.getUTCHours()).toBe(0)
    expect(gte.getUTCMinutes()).toBe(0)
    expect(where.createdAt.lt.getTime() - gte.getTime()).toBe(24 * 3600_000)
  })
})
