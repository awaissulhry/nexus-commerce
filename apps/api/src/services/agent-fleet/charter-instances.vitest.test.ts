/**
 * NAF.SB.W.8 — worker instances: the guarantees, asserted rather than intended.
 *
 * The session-locks review (§4) promised this file specifically. An instance
 * row must write SOMETHING into `systemPrompt`, `outputSchemaKey` and
 * `modelFeature` because they are NOT NULL — and a copy of the template's
 * values there would silently fork the day the code charter changes. The
 * resolver is supposed to ignore those columns entirely and read them from the
 * template. "Supposed to" is what tests are for, so these write **garbage**
 * into them and assert the resolved charter is unaffected.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rows: Array<Record<string, unknown>> = []

vi.mock('../../db.js', () => ({
  default: {
    agentCharter: { findMany: vi.fn(async () => rows) },
    agentCharterRevision: { findMany: vi.fn(async () => []) },
  },
}))
vi.mock('./charter-revisions.service.js', () => ({
  getActiveRevisions: vi.fn(async () => new Map()),
}))

const { bustCharterCache, FLEET_CHARTERS, listCharters, resolveCharter } = await import(
  './charter-registry.js'
)

/** A code charter to instantiate from — whichever one the roster actually has. */
const TEMPLATE = 'amazon-negative-miner'

function instanceRow(over: Record<string, unknown> = {}) {
  const def = FLEET_CHARTERS[TEMPLATE]!
  return {
    key: 'negative-miner-de',
    version: def.version,
    templateKey: TEMPLATE,
    promptOverlay: null,
    name: 'Negative miner — Germany',
    description: 'DE only, on a tighter budget.',
    tier: def.tier,
    domain: def.domain,
    // ── the inert columns. Deliberate garbage. ──────────────────────────
    systemPrompt: 'GARBAGE — if this reaches the model the resolver is wrong',
    outputSchemaKey: 'not-a-real-schema',
    modelFeature: 'not-a-real-model',
    observationKeys: ['not-a-real-observation'],
    toolNames: [],
    // ── policy the operator legitimately owns ───────────────────────────
    enabled: false,
    autonomyLevel: 'OFF',
    scopeMarketplaces: ['DE'],
    scopePortfolioIds: [],
    scopeCampaignIds: [],
    maxFindingsPerRun: def.maxFindingsPerRun,
    maxToolCallsPerRun: def.maxToolCallsPerRun,
    maxTokensPerRun: def.maxTokensPerRun,
    dailyBudgetUSD: def.dailyBudgetUSD,
    maxProposedValueCents: null,
    modelProviderOverride: null,
    modelNameOverride: null,
    pausedUntil: null,
    pausedReason: null,
    ...over,
  }
}

describe('NAF.SB.W.8 — worker instances', () => {
  beforeEach(() => {
    rows.length = 0
    bustCharterCache()
  })

  it('resolves through its template, ignoring the inert columns entirely', async () => {
    rows.push(instanceRow())
    const c = await resolveCharter('negative-miner-de')
    const def = FLEET_CHARTERS[TEMPLATE]!

    expect(c).not.toBeNull()
    // Capability comes from the template, never from the row.
    expect(c!.systemPrompt).toBe(def.systemPrompt)
    expect(c!.systemPrompt).not.toContain('GARBAGE')
    expect(c!.outputSchemaKey).toBe(def.outputSchemaKey)
    expect(c!.modelFeature).toBe(def.modelFeature)
    expect(c!.observationKeys).toEqual(def.observationKeys)
    expect(c!.toolNames).toEqual(def.toolNames)
    expect(c!.autonomyCap).toBe(def.autonomyCap)
    // Identity comes from the row.
    expect(c!.key).toBe('negative-miner-de')
    expect(c!.name).toBe('Negative miner — Germany')
    expect(c!.templateKey).toBe(TEMPLATE)
    // Narrowing the operator owns.
    expect(c!.scopeMarketplaces).toEqual(['DE'])
  })

  it('appends the prompt overlay and never replaces the template prompt', async () => {
    rows.push(instanceRow({ promptOverlay: 'Prefer German long-tail terms.' }))
    const c = await resolveCharter('negative-miner-de')
    const def = FLEET_CHARTERS[TEMPLATE]!
    expect(c!.systemPrompt.startsWith(def.systemPrompt)).toBe(true)
    expect(c!.systemPrompt).toContain('Prefer German long-tail terms.')
  })

  it('cannot raise a limit above its template — narrowing only', async () => {
    const def = FLEET_CHARTERS[TEMPLATE]!
    rows.push(instanceRow({
      dailyBudgetUSD: def.dailyBudgetUSD * 1000,
      maxTokensPerRun: def.maxTokensPerRun * 1000,
      autonomyLevel: 'AUTO',
    }))
    const c = await resolveCharter('negative-miner-de')
    expect(Number(c!.dailyBudgetUSD)).toBe(def.dailyBudgetUSD)
    expect(c!.maxTokensPerRun).toBe(def.maxTokensPerRun)
    // clamped to the template's code ceiling, not to what the row asked for
    expect(c!.autonomyLevel).toBe(def.autonomyCap)
  })

  it('CAN lower a limit — that is the whole point of an instance', async () => {
    const def = FLEET_CHARTERS[TEMPLATE]!
    rows.push(instanceRow({ dailyBudgetUSD: 0.01, maxTokensPerRun: 500 }))
    const c = await resolveCharter('negative-miner-de')
    expect(Number(c!.dailyBudgetUSD)).toBe(0.01)
    expect(c!.maxTokensPerRun).toBe(500)
    expect(def.dailyBudgetUSD).toBeGreaterThan(0.01)
  })

  it('an instance naming a template that does not exist in code does not exist', async () => {
    rows.push(instanceRow({ key: 'ghost', templateKey: 'no-such-charter' }))
    expect(await resolveCharter('ghost')).toBeNull()
    const all = await listCharters()
    expect(all.find((c) => c.key === 'ghost')).toBeUndefined()
  })

  it('is ENUMERATED, not merely resolvable — resolveCharter alone is not enough', async () => {
    rows.push(instanceRow())
    const all = await listCharters()
    // every code charter, plus the instance
    expect(all).toHaveLength(Object.keys(FLEET_CHARTERS).length + 1)
    const mine = all.find((c) => c.key === 'negative-miner-de')
    expect(mine).toBeDefined()
    expect(mine!.templateKey).toBe(TEMPLATE)
    // and it did not displace its own template
    expect(all.find((c) => c.key === TEMPLATE)).toBeDefined()
  })

  it('is born OFF, like every worker', async () => {
    rows.push(instanceRow({ enabled: true, autonomyLevel: 'OFF' }))
    const c = await resolveCharter('negative-miner-de')
    expect(c!.autonomyLevel).toBe('OFF')
  })
})

describe('NAF.SB.W.8 — retirement', () => {
  beforeEach(() => { rows.length = 0; bustCharterCache() })

  it('a retired instance CANNOT run — resolveCharter refuses it', async () => {
    rows.push(instanceRow({ supersededBy: 'retired' }))
    expect(await resolveCharter('negative-miner-de')).toBeNull()
  })

  it('but it is still listed, flagged, because its history is not deleted', async () => {
    rows.push(instanceRow({ supersededBy: 'retired' }))
    const mine = (await listCharters()).find((c) => c.key === 'negative-miner-de')
    expect(mine).toBeDefined()
    expect(mine!.retired).toBe(true)
  })

  it('a live instance is not flagged retired', async () => {
    rows.push(instanceRow())
    const mine = (await listCharters()).find((c) => c.key === 'negative-miner-de')
    expect(mine!.retired).toBe(false)
  })
})
