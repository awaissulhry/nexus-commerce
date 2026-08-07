/**
 * NAF.SB.AS.3 — the pre-flight's two halves, and the promise each makes.
 *
 * The static half's whole value is that it costs NOTHING, so it can update as
 * the operator types. The study's first draft claimed the counters were free
 * too; they are not — they come from a sixty-day scan — and the split exists
 * because of that correction. These tests pin the split so it cannot quietly
 * collapse back into one expensive call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const buildSpy = vi.fn()

vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('./charter-registry.js', () => ({
  resolveCharter: vi.fn(async (key: string) =>
    key === 'nope'
      ? null
      : {
          key,
          name: 'Negative miner',
          autonomyLevel: 'OFF',
          autonomyCap: 'OBSERVE',
          dailyBudgetUSD: 0.1,
          scopeMarketplaces: [],
          observationKeys: key === 'wide' ? ['cron-health'] : ['negative-candidates'],
        },
  ),
}))
vi.mock('./fleet-state.service.js', () => ({
  getFleetState: vi.fn(async () => ({ dailyCeilingUSD: 2, halted: false })),
}))
vi.mock('./assignment-scope.js', async () => {
  const actual = await vi.importActual<typeof import('./assignment-scope.js')>(
    './assignment-scope.js',
  )
  return {
    ...actual,
    resolveAssignmentScope: vi.fn(async () => ({
      narrow: { campaignExternalIds: ['111'], campaignLabels: ['GALE | IT'] },
    })),
  }
})
vi.mock('./observation-builder.js', () => ({
  getObservation: buildSpy,
  narrowKindsFor: (k: string) =>
    k === 'negative-candidates' ? ['CAMPAIGN', 'MARKETPLACE'] : [],
  observationLabel: (k: string) =>
    k === 'negative-candidates' ? 'wasteful search terms' : k,
  observationNarrowNotes: () => ['for this campaign only.'],
  observationItemCount: () => 4,
}))

const { staticPreflight, measurePreflight } = await import('./assignment-preflight.service.js')

beforeEach(() => {
  buildSpy.mockReset()
  buildSpy.mockResolvedValue({
    id: 'obs1',
    key: 'negative-candidates',
    payload: { caveats: ['narrowed to GALE | IT'] },
    dataVintage: new Date(0),
    computedAt: new Date(0),
    cached: true,
  })
})

const TARGET = { kind: 'CAMPAIGN' as const, ids: ['111'], labels: ['GALE | IT'] }

describe('staticPreflight — must cost nothing', () => {
  it('never builds an observation', async () => {
    await staticPreflight('amazon-negative-miner', TARGET)
    expect(buildSpy).not.toHaveBeenCalled()
  })

  it('answers in one sentence naming the target', async () => {
    const p = await staticPreflight('amazon-negative-miner', TARGET)
    expect(p?.ok).toBe(true)
    expect(p?.headline).toContain('GALE | IT')
    expect(p?.headline).toContain('nothing else in your account')
  })

  it('with no target, says so plainly rather than staying silent', async () => {
    const p = await staticPreflight('amazon-negative-miner', null)
    expect(p?.headline).toContain('whole account')
    expect(buildSpy).not.toHaveBeenCalled()
  })

  it('REFUSES, with the feed named, when the evidence cannot honour the kind', async () => {
    const p = await staticPreflight('wide', TARGET)
    expect(p?.ok).toBe(false)
    expect(p?.refusal).toContain('cron-health')
    expect(p?.refusal).toContain('rather than reading your whole account')
  })

  it('reports the resolved ceilings, not theoretical ones', async () => {
    const p = await staticPreflight('amazon-negative-miner', TARGET)
    expect(p?.ceilingUSD).toBe(0.1)
    expect(p?.fleetCeilingUSD).toBe(2)
  })

  it('returns null for an unknown worker rather than an empty shell', async () => {
    expect(await staticPreflight('nope', TARGET)).toBeNull()
  })
})

describe('measurePreflight — the expensive half', () => {
  it('DOES build, and reports what survives', async () => {
    const m = await measurePreflight('amazon-negative-miner', TARGET)
    expect(buildSpy).toHaveBeenCalledTimes(1)
    expect(m.ok).toBe(true)
    expect(m.totalItems).toBe(4)
    expect(m.feeds[0].caveats[0]).toContain('narrowed')
  })

  it('passes the RESOLVED narrowing down, never the raw target', async () => {
    await measurePreflight('amazon-negative-miner', TARGET)
    const [, , narrow] = buildSpy.mock.calls[0]
    expect(narrow).toEqual({ campaignExternalIds: ['111'], campaignLabels: ['GALE | IT'] })
  })

  it('refuses exactly where a run would refuse, and builds nothing', async () => {
    const scope = await import('./assignment-scope.js')
    vi.mocked(scope.resolveAssignmentScope).mockResolvedValueOnce({
      error: 'target_gone: the campaign this assignment names no longer exists',
    })
    const m = await measurePreflight('amazon-negative-miner', TARGET)
    expect(m.ok).toBe(false)
    expect(m.error).toContain('target_gone')
    expect(buildSpy).not.toHaveBeenCalled()
  })
})
