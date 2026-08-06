/**
 * NAF.A — charter registry: code truth ⊕ DB policy, with the floor INVERTED
 * from tool-policy (unreadable DB ⇒ OFF, because a fleet that cannot read
 * its policy must stop, not proceed on defaults).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentCharter: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}))

import prisma from '../../db.js'
import {
  bustCharterCache,
  listCharters,
  resolveCharter,
  seedCharters,
} from './charter-registry.js'
import { fleetSelftestCharter } from './charters/fleet-selftest.charter.js'

const findMany = vi.mocked(prisma.agentCharter.findMany)
const findUnique = vi.mocked(prisma.agentCharter.findUnique)
const create = vi.mocked(prisma.agentCharter.create)

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chr_1',
    key: 'fleet-selftest',
    version: 1,
    enabled: true,
    autonomyLevel: 'OBSERVE',
    autonomyCap: 'OBSERVE',
    scopeMarketplaces: ['IT'],
    scopePortfolioIds: [],
    scopeCampaignIds: [],
    maxFindingsPerRun: 10,
    maxToolCallsPerRun: 2,
    maxTokensPerRun: 20_000,
    dailyBudgetUSD: 0.25,
    maxProposedValueCents: null,
    ...overrides,
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  bustCharterCache()
})

describe('resolveCharter', () => {
  it('returns null for a key not in the code map', async () => {
    findMany.mockResolvedValue([])
    expect(await resolveCharter('does-not-exist')).toBeNull()
  })

  it('resolves OFF and disabled when no DB row exists (fail-safe floor)', async () => {
    findMany.mockResolvedValue([])
    const c = await resolveCharter('fleet-selftest')
    expect(c).not.toBeNull()
    expect(c!.enabled).toBe(false)
    expect(c!.autonomyLevel).toBe('OFF')
    expect(c!.degraded).toBe(false)
  })

  it('clamps the DB autonomy level to the code cap', async () => {
    findMany.mockResolvedValue([dbRow({ autonomyLevel: 'AUTO' })])
    const c = await resolveCharter('fleet-selftest')
    expect(c!.autonomyLevel).toBe('OBSERVE') // cap is OBSERVE
  })

  it('treats a garbage DB autonomy string as OFF', async () => {
    findMany.mockResolvedValue([dbRow({ autonomyLevel: 'YOLO' })])
    const c = await resolveCharter('fleet-selftest')
    expect(c!.autonomyLevel).toBe('OFF')
  })

  it('degrades to disabled OFF when the DB read fails', async () => {
    findMany.mockRejectedValue(new Error('pooler blip'))
    const c = await resolveCharter('fleet-selftest')
    expect(c).not.toBeNull()
    expect(c!.enabled).toBe(false)
    expect(c!.autonomyLevel).toBe('OFF')
    expect(c!.degraded).toBe(true)
  })

  it('lets the DB lower budgets but never raise them', async () => {
    findMany.mockResolvedValue([
      dbRow({ maxTokensPerRun: 5_000, dailyBudgetUSD: 9.99 }),
    ])
    const c = await resolveCharter('fleet-selftest')
    expect(c!.maxTokensPerRun).toBe(5_000) // lowered — respected
    expect(c!.dailyBudgetUSD).toBe(fleetSelftestCharter.dailyBudgetUSD) // raised — refused
  })

  it('carries DB scope onto the effective charter', async () => {
    findMany.mockResolvedValue([dbRow()])
    const c = await resolveCharter('fleet-selftest')
    expect(c!.scopeMarketplaces).toEqual(['IT'])
    expect(c!.enabled).toBe(true)
  })

  it('ignores a DB row whose version does not match the code charter', async () => {
    findMany.mockResolvedValue([dbRow({ version: 99 })])
    const c = await resolveCharter('fleet-selftest')
    expect(c!.enabled).toBe(false)
    expect(c!.autonomyLevel).toBe('OFF')
  })
})

describe('listCharters', () => {
  it('lists every code charter exactly once', async () => {
    findMany.mockResolvedValue([])
    const all = await listCharters()
    expect(all.map((c) => c.key)).toContain('fleet-selftest')
    expect(new Set(all.map((c) => c.key)).size).toBe(all.length)
  })
})

describe('seedCharters', () => {
  it('creates a row per code charter when absent', async () => {
    findUnique.mockResolvedValue(null)
    create.mockResolvedValue(dbRow())
    const r = await seedCharters()
    expect(r.created).toBe(1)
    expect(create).toHaveBeenCalledTimes(1)
    const data = create.mock.calls[0]![0]!.data as Record<string, unknown>
    expect(data.key).toBe('fleet-selftest')
    expect(data.enabled).toBe(false) // seeds dark, always
  })

  it('never clobbers an existing row — second seed creates 0', async () => {
    findUnique.mockResolvedValue(dbRow())
    const r = await seedCharters()
    expect(r.created).toBe(0)
    expect(create).not.toHaveBeenCalled()
  })
})
