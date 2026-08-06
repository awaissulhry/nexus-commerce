/**
 * NAF.B — the three analyst charters: registered, contract-complete, and
 * born dark. The graph grows one flat level of four analyst nodes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({
  default: {
    agentCharter: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  },
}))

import prisma from '../../../db.js'
import {
  bustCharterCache,
  FLEET_CHARTERS,
  resolveCharter,
} from '../charter-registry.js'
import { FLEET_GRAPH, topoLevels } from '../fleet-graph.js'

const findMany = vi.mocked(prisma.agentCharter.findMany)

const KEYS = [
  'amazon-negative-miner',
  'amazon-keyword-harvester',
  'amazon-bid-tuner',
] as const

beforeEach(() => {
  vi.clearAllMocks()
  bustCharterCache()
  findMany.mockResolvedValue([])
})

describe('the three analyst charters', () => {
  it.each(KEYS)('%s is registered at v1 with the Phase B contracts', async (key) => {
    const def = FLEET_CHARTERS[key]
    expect(def).toBeDefined()
    expect(def!.version).toBe(1)
    expect(def!.tier).toBe('analyst')
    expect(def!.domain).toBe('amazon-ads')
    expect(def!.autonomyCap).toBe('OBSERVE')
    expect(def!.modelFeature).toBe('agent-fleet-analyst')
    expect(def!.outputSchemaKey).toBe('analyst-output')
    // the two NAF.B contracts are pinned
    expect(def!.dedupeKeyPattern).toBe('^[a-z_]{3,40}:.+$')
    expect(def!.maxEvidenceAgeHours).toBe(26)
    // budgets per D9
    expect(def!.maxTokensPerRun).toBe(20_000)
    expect(def!.dailyBudgetUSD).toBe(0.1)
    expect(def!.maxFindingsPerRun).toBe(20)
    // orchestrated only — the sweep is the scheduler
    expect(def!.cadence).toBeUndefined()
    // the prompt pins the grammar and permits the empty answer
    expect(def!.systemPrompt).toContain('<kind>:<entityId>')
    expect(def!.systemPrompt.toLowerCase()).toContain('empty')
  })

  it('each resolves dark with no DB row — fail-safe floor', async () => {
    for (const key of KEYS) {
      const c = await resolveCharter(key)
      expect(c).not.toBeNull()
      expect(c!.enabled).toBe(false)
      expect(c!.autonomyLevel).toBe('OFF')
    }
  })

  it('observation keys map to registered builders', () => {
    expect(FLEET_CHARTERS['amazon-negative-miner']!.observationKeys).toEqual([
      'negative-candidates',
    ])
    expect(FLEET_CHARTERS['amazon-keyword-harvester']!.observationKeys).toEqual([
      'harvest-candidates',
    ])
    expect(FLEET_CHARTERS['amazon-bid-tuner']!.observationKeys).toEqual([
      'bid-proposals',
    ])
  })
})

describe('fleet graph', () => {
  it('carries the three analysts in level 1 feeding the director', () => {
    const levels = topoLevels(FLEET_GRAPH)
    expect(levels[0]).toEqual(
      expect.arrayContaining(['amazon-bid-tuner', 'amazon-keyword-harvester', 'amazon-negative-miner']),
    )
    expect(levels).toHaveLength(3)
  })
})
