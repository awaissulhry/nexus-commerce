/**
 * NAF.A — fleet runtime state: upsert-on-read singleton with the
 * ads-automation-state fail-safe inversion — an UNREADABLE row reports
 * halted+degraded, never "running fine".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentFleetState: {
      upsert: vi.fn(),
    },
  },
}))

import prisma from '../../db.js'
import { getFleetState, haltFleet, resumeFleet } from './fleet-state.service.js'

const upsert = vi.mocked(prisma.agentFleetState.upsert)

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'singleton',
    halted: false,
    haltedAt: null,
    haltReason: null,
    haltedBy: null,
    dailyCeilingUSD: 2.0,
    updatedAt: new Date(),
    ...overrides,
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getFleetState', () => {
  it('reports the unhalted default on a fresh (upsert-created) row', async () => {
    upsert.mockResolvedValue(row())
    const s = await getFleetState()
    expect(s.halted).toBe(false)
    expect(s.dailyCeilingUSD).toBe(2.0)
    expect(s.degraded).toBe(false)
  })

  it('fails safe to halted+degraded when the row cannot be read', async () => {
    upsert.mockRejectedValue(new Error('pooler blip'))
    const s = await getFleetState()
    expect(s.halted).toBe(true)
    expect(s.degraded).toBe(true)
    // Degraded still reports the schema-default ceiling, not zero — a zero
    // ceiling would read as "spent out" rather than "unknown".
    expect(s.dailyCeilingUSD).toBe(2.0)
  })
})

describe('haltFleet / resumeFleet', () => {
  it('halt writes reason, timestamp and actor', async () => {
    upsert.mockResolvedValue(
      row({ halted: true, haltReason: 'manual stop', haltedBy: 'operator:awais' }),
    )
    const s = await haltFleet('manual stop', 'operator:awais')
    expect(s.halted).toBe(true)
    const args = upsert.mock.calls[0]![0]! as {
      update: Record<string, unknown>
    }
    expect(args.update.halted).toBe(true)
    expect(args.update.haltReason).toBe('manual stop')
    expect(args.update.haltedBy).toBe('operator:awais')
    expect(args.update.haltedAt).toBeInstanceOf(Date)
  })

  it('resume clears the halt but RETAINS the trip record', async () => {
    // ACR 4.3 found resumeAutomation nulls haltedAt/haltReason, erasing the
    // only in-row trace of a trip. The fleet keeps them.
    upsert.mockResolvedValue(
      row({ halted: false, haltReason: 'manual stop', haltedAt: new Date() }),
    )
    const s = await resumeFleet('operator:awais')
    expect(s.halted).toBe(false)
    const args = upsert.mock.calls[0]![0]! as {
      update: Record<string, unknown>
    }
    expect(args.update.halted).toBe(false)
    expect('haltReason' in args.update).toBe(false)
    expect('haltedAt' in args.update).toBe(false)
  })
})
