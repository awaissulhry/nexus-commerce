/**
 * NAF.A — orchestrator: bounded concurrency, halt/kill/budget short-circuit
 * between agents, one orchestrationId threading, sibling isolation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./agent-executor.js', () => ({
  executeCharter: vi.fn(),
}))
vi.mock('./fleet-state.service.js', () => ({
  getFleetState: vi.fn(),
}))
vi.mock('./budget-guard.js', () => ({
  checkFleetDayBudget: vi.fn(),
}))
vi.mock('./fleet-graph.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./fleet-graph.js')>()
  return { ...orig, FLEET_GRAPH: { nodes: [], edges: [] } }
})

import { executeCharter } from './agent-executor.js'
import { checkFleetDayBudget } from './budget-guard.js'
import { getFleetState } from './fleet-state.service.js'
import { FLEET_GRAPH } from './fleet-graph.js'
import { runFleet } from './orchestrator.js'

const exec = vi.mocked(executeCharter)
const fleetState = vi.mocked(getFleetState)
const fleetBudget = vi.mocked(checkFleetDayBudget)
const graph = FLEET_GRAPH as { nodes: { key: string; tier: string }[]; edges: never[] }

function healthyState(overrides: Record<string, unknown> = {}) {
  return {
    halted: false,
    haltedAt: null,
    haltReason: null,
    haltedBy: null,
    dailyCeilingUSD: 2.0,
    degraded: false,
    ...overrides,
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  graph.nodes = [{ key: 'fleet-selftest', tier: 'analyst' }]
  graph.edges = []
  fleetState.mockResolvedValue(healthyState())
  fleetBudget.mockResolvedValue({ ok: true } as never)
  exec.mockResolvedValue({ runId: 'run_1', ok: true, findingCount: 1 } as never)
})

describe('runFleet', () => {
  it('runs every node with the same orchestrationId and schedule trigger', async () => {
    graph.nodes = [
      { key: 'a', tier: 'analyst' },
      { key: 'b', tier: 'analyst' },
    ]
    const r = await runFleet('sweep')
    expect(r.started).toBe(2)
    expect(r.succeeded).toBe(2)
    expect(exec).toHaveBeenCalledTimes(2)
    const optsA = exec.mock.calls[0]![1]!
    const optsB = exec.mock.calls[1]![1]!
    expect(optsA.trigger).toBe('schedule')
    expect(optsA.mode).toBe('sweep')
    expect(optsA.orchestrationId).toBeTruthy()
    expect(optsA.orchestrationId).toBe(optsB.orchestrationId)
    expect(r.orchestrationId).toBe(optsA.orchestrationId)
  })

  it('bounds concurrency', async () => {
    graph.nodes = Array.from({ length: 8 }, (_, i) => ({
      key: `n${i}`,
      tier: 'analyst',
    }))
    let inFlight = 0
    let peak = 0
    exec.mockImplementation(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return { runId: 'r', ok: true } as never
    })
    await runFleet('sweep', { concurrency: 3 })
    expect(peak).toBeLessThanOrEqual(3)
    expect(exec).toHaveBeenCalledTimes(8)
  })

  it('a halt tripping mid-fleet skips the remainder', async () => {
    graph.nodes = [
      { key: 'a', tier: 'analyst' },
      { key: 'b', tier: 'analyst' },
    ]
    fleetState
      .mockResolvedValueOnce(healthyState())
      .mockResolvedValue(healthyState({ halted: true, haltReason: 'operator stop' }))
    const r = await runFleet('sweep', { concurrency: 1 })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(r.skipped).toBe(1)
    expect(r.haltedReason).toContain('fleet_halted')
  })

  it('a fleet-day budget trip skips the remainder', async () => {
    graph.nodes = [
      { key: 'a', tier: 'analyst' },
      { key: 'b', tier: 'analyst' },
    ]
    fleetBudget
      .mockResolvedValueOnce({ ok: true } as never)
      .mockResolvedValue({
        ok: false,
        reason: 'fleet_day',
        detail: '$2.00 of $2.00 spent',
      } as never)
    const r = await runFleet('sweep', { concurrency: 1 })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(r.skipped).toBe(1)
    expect(r.haltedReason).toContain('fleet_day')
  })

  it('disabled charters count as skipped, not failed — the dark ship', async () => {
    exec.mockResolvedValue({ runId: null, ok: true, skipped: 'disabled' } as never)
    const r = await runFleet('sweep')
    expect(r.started).toBe(1)
    expect(r.skipped).toBe(1)
    expect(r.succeeded).toBe(0)
    expect(r.failed).toBe(0)
  })

  it('one failing agent never stops its siblings', async () => {
    graph.nodes = [
      { key: 'a', tier: 'analyst' },
      { key: 'b', tier: 'analyst' },
      { key: 'c', tier: 'analyst' },
    ]
    exec
      .mockResolvedValueOnce({ runId: 'r1', ok: true } as never)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ runId: 'r3', ok: true } as never)
    const r = await runFleet('council', { concurrency: 1 })
    expect(r.succeeded).toBe(2)
    expect(r.failed).toBe(1)
    expect(exec).toHaveBeenCalledTimes(3)
  })
})
