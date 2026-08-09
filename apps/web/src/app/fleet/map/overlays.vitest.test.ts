/**
 * NAF.SB.M.4 — the overlay invariants.
 *
 * A legend that disagrees with the graph is the failure mode this section
 * exists to prevent, so the properties that make disagreement impossible are
 * asserted rather than reviewed: every node lands in exactly one declared
 * bucket, every bucket is reachable by some node shape, and no bucket is
 * declared without the words that explain it.
 */
import { describe, it, expect } from 'vitest'
import { OVERLAYS, occupiedBucketIds, visibleBuckets, overlayById } from './overlays'
import type { MapNode } from './lib'

function node(over: Partial<MapNode> & { key: string }): MapNode {
  const base = {
    name: over.key,
    description: null,
    tier: 'analyst',
    domain: 'amazon-ads',
    diagnostic: false,
    templateKey: null,
    lane: 'ranked' as const,
    rank: 0,
    charter: {
      key: over.key,
      domain: 'amazon-ads',
      enabled: false,
      autonomyLevel: 'OFF',
      degraded: false,
      provisioned: true,
      pausedUntil: null,
      pausedReason: null,
      autonomyCap: 'OBSERVE',
      activeRevisionNumber: null,
      modelProvider: null,
      modelName: null,
      cadence: null,
      scopeMarketplaces: [],
      scopePortfolioIds: [],
      scopeCampaignIds: [],
      dailyBudgetUSD: 0.1,
      maxTokensPerRun: 20000,
      maxFindingsPerRun: 20,
      maxToolCallsPerRun: 2,
    },
    lastRun: null,
    recentRuns: [],
    runs: { window: 0, lifetime: 0, notOkWindow: 0, runningNow: false, runningRunId: null, runningSince: null },
    findings: { open: 0, openExpired: 0, bySeverity: {} },
    plans: { authoredWindow: 0, verdictsWindow: { pass: 0, revise: 0, block: 0 } },
    approvals: { waiting: 0, scheduled: 0 },
    cost: { currency: 'USD', windowUSD: 0, runs: 0, todayUSD: 0, lifetimeUSD: 0, inputTokensWindow: 0, outputTokensWindow: 0 },
    declaredBy: [],
  }
  return { ...base, ...over, charter: { ...base.charter, ...(over.charter ?? {}) } } as MapNode
}

const run = (over: Record<string, unknown> = {}) =>
  ({
    id: 'r', createdAt: new Date().toISOString(), endedAt: null, status: 'done', ok: true,
    mode: 'sweep', trigger: 'schedule', errorMessage: null, haltedReason: null, findingCount: 0,
    costUSD: 0, latencyMs: 1, model: null, provider: null, workflowKey: null, assignmentId: null,
    ...over,
  }) as NonNullable<MapNode['lastRun']>

const ran = { window: 1, lifetime: 1, notOkWindow: 0, runningNow: false, runningRunId: null, runningSince: null }

/** One node per bucket that can exist, across all three overlays. */
const FIXTURE: MapNode[] = [
  node({ key: 'degraded', charter: { degraded: true } as never }),
  node({ key: 'unprovisioned', charter: { provisioned: false } as never }),
  node({ key: 'off' }),
  node({ key: 'observe', charter: { enabled: true, autonomyLevel: 'OBSERVE' } as never }),
  node({ key: 'propose', charter: { enabled: true, autonomyLevel: 'PROPOSE' } as never }),
  node({ key: 'auto', charter: { enabled: true, autonomyLevel: 'AUTO' } as never }),
  node({ key: 'never-run' }),
  node({ key: 'clean', lastRun: run(), runs: ran, cost: { currency: 'USD', windowUSD: 0.005, runs: 1, todayUSD: 0, lifetimeUSD: 0.005, inputTokensWindow: 0, outputTokensWindow: 0 } }),
  node({ key: 'failed', lastRun: run({ ok: false, errorMessage: 'fetch failed' }), runs: ran, cost: { currency: 'USD', windowUSD: 0.05, runs: 1, todayUSD: 0, lifetimeUSD: 0.05, inputTokensWindow: 0, outputTokensWindow: 0 } }),
  node({ key: 'limited', lastRun: run({ ok: false, haltedReason: 'budget_tokens: 20142 of 20000 run tokens used' }), runs: ran, cost: { currency: 'USD', windowUSD: 0.9, runs: 1, todayUSD: 0, lifetimeUSD: 0.9, inputTokensWindow: 0, outputTokensWindow: 0 } }),
  node({ key: 'free-run', lastRun: run(), runs: ran, cost: { currency: 'USD', windowUSD: 0, runs: 2, todayUSD: 0, lifetimeUSD: 0, inputTokensWindow: 0, outputTokensWindow: 0 } }),
  node({ key: 'ran-before', runs: { window: 0, lifetime: 4, notOkWindow: 0, runningNow: false, runningRunId: null, runningSince: null } }),
]

describe('overlays', () => {
  for (const o of OVERLAYS) {
    it(`${o.id}: every node lands in exactly one DECLARED bucket`, () => {
      for (const n of FIXTURE) {
        const b = o.bucketOf(n)
        expect(b, `${n.key} got no bucket`).toBeTruthy()
        expect(o.buckets.map((x) => x.id), `${n.key} → "${b.id}" is not declared`).toContain(b.id)
      }
    })

    it(`${o.id}: every declared bucket is reachable`, () => {
      const hit = new Set(FIXTURE.map((n) => o.bucketOf(n).id))
      for (const b of o.buckets) {
        expect(hit.has(b.id), `bucket "${b.id}" is unreachable — it teaches a colour nothing can have`).toBe(true)
      }
    })

    it(`${o.id}: every bucket has words, and a class rather than a colour`, () => {
      for (const b of o.buckets) {
        expect(b.label.length).toBeGreaterThan(3)
        expect(b.className).toMatch(/^ov-/)
      }
    })
  }

  it('a short label exists exactly where the tint is the only channel', () => {
    // The armed autonomy rungs: `deriveStatus` prints "running" for all three,
    // so without words the difference between "may look" and "may act on its
    // own" is hue alone — measured 1.37:1 in greyscale.
    const autonomy = overlayById('autonomy')
    const withShort = autonomy.buckets.filter((b) => b.short).map((b) => b.id)
    expect(withShort).toEqual(['observe', 'propose', 'auto'])

    // Not on the buckets the status word already names, and not on the hatch,
    // which is a texture rather than a colour.
    for (const id of ['off', 'unreadable', 'not-set-up']) {
      expect(autonomy.buckets.find((b) => b.id === id)!.short, id).toBeUndefined()
    }

    // Health and cost state their fact in words on the card already
    // ("last run failed", "$0.11 spent"), so a second label would be noise.
    for (const o of OVERLAYS.filter((x) => x.id !== 'autonomy')) {
      for (const b of o.buckets) expect(b.short, `${o.id}/${b.id}`).toBeUndefined()
    }
  })

  it('no data is never the bottom of the scale', () => {
    const cost = overlayById('cost')
    const neverRan = FIXTURE.find((n) => n.key === 'never-run')!
    const ranFree = FIXTURE.find((n) => n.key === 'free-run')!
    // Both are "$0.00" — and they are different facts, so different buckets.
    expect(cost.bucketOf(neverRan).id).toBe('no-data')
    expect(cost.bucketOf(ranFree).id).toBe('free')
    expect(cost.bucketOf(neverRan).className).toBe('ov-nodata')
  })

  it('a limit is amber, a failure is red, and they are different buckets', () => {
    const health = overlayById('health')
    const limited = FIXTURE.find((n) => n.key === 'limited')!
    const failed = FIXTURE.find((n) => n.key === 'failed')!
    expect(health.bucketOf(limited).className).toBe('ov-warn')
    expect(health.bucketOf(failed).className).toBe('ov-bad')
  })

  it('a paused worker is not painted as armed', () => {
    const autonomy = overlayById('autonomy')
    // enabled resolves false under a live pause WITHOUT the dial moving, so a
    // tint read from autonomyLevel alone would show this as OBSERVE.
    const paused = node({
      key: 'paused',
      charter: {
        enabled: false,
        autonomyLevel: 'OBSERVE',
        pausedUntil: new Date(Date.now() + 86_400_000).toISOString(),
      } as never,
    })
    expect(autonomy.bucketOf(paused).id).toBe('off')
  })

  it('occupancy is exactly the set of buckets some node is in', () => {
    for (const o of OVERLAYS) {
      const occupied = occupiedBucketIds(o, FIXTURE)
      const expected = new Set(FIXTURE.map((n) => o.bucketOf(n).id))
      expect(occupied, `${o.id}`).toEqual(expected)
      // Nothing may be claimed occupied that no node is in — that would print
      // "…" against a colour the canvas is not showing.
      for (const id of occupied) {
        expect(FIXTURE.some((n) => o.bucketOf(n).id === id), `${o.id}/${id}`).toBe(true)
      }
    }
  })

  it('a vacant rung is still a rung: swatch, label, and a marker instead of prose', () => {
    const quiet = [node({ key: 'a' }), node({ key: 'b' })] // an all-off fleet, as prod is today
    const autonomy = overlayById('autonomy')
    const shown = visibleBuckets(autonomy, quiet)
    const occupied = occupiedBucketIds(autonomy, quiet)

    expect(occupied).toEqual(new Set(['off']))
    expect(shown).toHaveLength(6) // the ladder keeps every rung

    const vacant = shown.filter((b) => !occupied.has(b.id))
    expect(vacant).toHaveLength(5)
    for (const b of vacant) {
      // The rung can still be drawn and named — only its sentence is withheld,
      // because a note explains something on the canvas and there is nothing
      // on the canvas to explain.
      expect(b.className).toMatch(/^ov-/)
      expect(b.label.length).toBeGreaterThan(3)
    }
  })

  it('the autonomy ladder keeps its unused rungs; the others drop empty ones', () => {
    const quiet = [node({ key: 'a' }), node({ key: 'b' })]
    expect(visibleBuckets(overlayById('autonomy'), quiet)).toHaveLength(
      overlayById('autonomy').buckets.length,
    )
    const health = visibleBuckets(overlayById('health'), quiet).map((b) => b.id)
    expect(health).toEqual(['never-run'])
  })
})
