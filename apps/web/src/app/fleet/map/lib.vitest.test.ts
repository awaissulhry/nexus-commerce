/**
 * NAF.SB.M.1b — the census invariant, tested rather than trusted.
 *
 * The Workers stream shipped a tile reading 3 above four amber rows, and then
 * "All 3" over two visible rows. Both were the same bug: a summary derived one
 * way and the rows underneath it derived another. These tests make that shape
 * of bug impossible here rather than watched for.
 */
import { describe, it, expect } from 'vitest'
import {
  CHIPS,
  census,
  visibleCensus,
  filterSummary,
  diagnosticFootnote,
  findingsTotals,
  usd,
  verdict,
  type MapNode,
} from './lib'

function node(over: Partial<MapNode> & { key: string }): MapNode {
  return {
    name: over.key,
    description: null,
    tier: 'analyst',
    domain: 'amazon-ads',
    diagnostic: false,
    templateKey: null,
    lane: 'ranked',
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
    runs: {
      window: 0,
      lifetime: 0,
      runningNow: false,
      runningRunId: null,
      runningSince: null,
    },
    findings: { open: 0, openExpired: 0, bySeverity: {} },
    plans: { authoredWindow: 0, verdictsWindow: { pass: 0, revise: 0, block: 0 } },
    approvals: { waiting: 0, scheduled: 0 },
    cost: {
      currency: 'USD',
      windowUSD: 0,
      runs: 0,
      lifetimeUSD: 0,
    },
    declaredBy: [],
    ...over,
  } as MapNode
}

const run = (over: Partial<MapNode['lastRun']> = {}) =>
  ({
    id: 'r1',
    createdAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    status: 'done',
    ok: true,
    mode: 'sweep',
    trigger: 'schedule',
    errorMessage: null,
    haltedReason: null,
    findingCount: 0,
    costUSD: 0,
    latencyMs: 100,
    model: null,
    provider: null,
    workflowKey: null,
    assignmentId: null,
    ...over,
  }) as NonNullable<MapNode['lastRun']>

/** One of every shape a node can actually be, so every chip is reachable. */
const FIXTURE: MapNode[] = [
  node({ key: 'off-worker' }),
  node({ key: 'never-set-up', charter: { ...node({ key: 'x' }).charter, provisioned: false } }),
  node({ key: 'degraded-worker', charter: { ...node({ key: 'x' }).charter, degraded: true } }),
  node({
    key: 'paused-worker',
    charter: {
      ...node({ key: 'x' }).charter,
      pausedUntil: new Date(Date.now() + 86_400_000).toISOString(),
    },
  }),
  node({
    key: 'running-worker',
    charter: { ...node({ key: 'x' }).charter, enabled: true, autonomyLevel: 'OBSERVE' },
    runs: { window: 1, lifetime: 1, runningNow: true, runningRunId: 'r', runningSince: null },
  }),
  node({
    key: 'working-worker',
    charter: { ...node({ key: 'x' }).charter, enabled: true, autonomyLevel: 'OBSERVE' },
    lastRun: run(),
    runs: { window: 1, lifetime: 1, runningNow: false, runningRunId: null, runningSince: null },
  }),
  node({
    key: 'failed-worker',
    charter: { ...node({ key: 'x' }).charter, enabled: true, autonomyLevel: 'OBSERVE' },
    lastRun: run({ ok: false, errorMessage: 'fetch failed' }),
    runs: { window: 1, lifetime: 1, runningNow: false, runningRunId: null, runningSince: null },
  }),
  node({
    key: 'limited-worker',
    charter: { ...node({ key: 'x' }).charter, enabled: true, autonomyLevel: 'OBSERVE' },
    lastRun: run({ ok: false, haltedReason: 'budget_tokens: 20142 of 20000 run tokens used' }),
    runs: { window: 1, lifetime: 1, runningNow: false, runningRunId: null, runningSince: null },
  }),
  node({ key: 'waiting-worker', approvals: { waiting: 2, scheduled: 1 } }),
  node({ key: 'selftest', diagnostic: true, findings: { open: 47, openExpired: 47, bySeverity: {} } }),
]

describe('census', () => {
  it('every count equals the nodes its own predicate matches', () => {
    for (const row of census(FIXTURE)) {
      expect(row.count).toBe(FIXTURE.filter(row.chip.matches).length)
    }
  })

  it('the state chips are a partition — each node matches exactly one', () => {
    const state = CHIPS.filter((c) => c.rank === 'state')
    for (const n of FIXTURE) {
      const hits = state.filter((c) => c.matches(n))
      expect(hits.length, `${n.key} matched ${hits.map((h) => h.id).join(',') || 'nothing'}`).toBe(1)
    }
  })

  it('the state chips sum to the total', () => {
    const sum = census(FIXTURE)
      .filter((r) => r.chip.rank === 'state')
      .reduce((s, r) => s + r.count, 0)
    expect(sum).toBe(FIXTURE.length)
  })

  it('every chip is reachable by some node shape', () => {
    for (const row of census(FIXTURE)) {
      expect(row.count, `chip "${row.chip.id}" is unreachable — it teaches a state that cannot exist`).toBeGreaterThan(0)
    }
  })

  it('a count never changes when another chip is active', () => {
    const before = census(FIXTURE).map((r) => r.count)
    // Selecting a chip dims nodes on the canvas; it must never re-count.
    const after = census(FIXTURE).map((r) => r.count)
    expect(after).toEqual(before)
  })

  it('every chip defines what it counts', () => {
    for (const c of CHIPS) expect(c.definition.length).toBeGreaterThan(20)
  })

  it('a limit is not a failure', () => {
    const limited = FIXTURE.find((n) => n.key === 'limited-worker')!
    const failed = CHIPS.find((c) => c.id === 'last-failed')!
    const limit = CHIPS.find((c) => c.id === 'hit-a-limit')!
    expect(limit.matches(limited)).toBe(true)
    expect(failed.matches(limited)).toBe(false)
  })

  it('never-run is lifetime, so a short window cannot invent it', () => {
    const chip = CHIPS.find((c) => c.id === 'never-run')!
    const ranLongAgo = node({
      key: 'ran-once',
      runs: { window: 0, lifetime: 4, runningNow: false, runningRunId: null, runningSince: null },
    })
    expect(chip.matches(ranLongAgo)).toBe(false)
  })

  it('zero-count chips render only when the zero teaches something', () => {
    const quiet = [node({ key: 'a' }), node({ key: 'b' })]
    const ids = visibleCensus(quiet).map((r) => r.chip.id)
    expect(ids).toContain('running') // 0 running above 2 off is the whole repair
    expect(ids).toContain('waiting') // and its zero has a structural cause
    expect(ids).not.toContain('paused')
  })

  it('filterSummary is the one sentence, and it counts the same way', () => {
    // Reads the label from CHIPS rather than restating it: the point of the
    // sentence is that there is ONE source for both the number and the word.
    const chip = CHIPS.find((c) => c.id === 'never-run')!
    expect(filterSummary(FIXTURE, 'never-run')).toBe(
      `Showing ${FIXTURE.filter((n) => n.runs.lifetime === 0).length} of ${FIXTURE.length} — ${chip.label}`,
    )
    expect(filterSummary(FIXTURE, null)).toBe('')
  })

  it('the diagnostic footnote names the skew rather than hiding it', () => {
    expect(diagnosticFootnote(FIXTURE)).toContain('47 of the 47 open findings')
    expect(diagnosticFootnote([node({ key: 'plain' })])).toBeNull()
  })
})

/* ── S1R ────────────────────────────────────────────────────────────────── */

describe('verdict', () => {
  const off = (k: string) => node({ key: k })
  const on = (k: string, over: Partial<MapNode> = {}) =>
    node({
      key: k,
      charter: { ...node({ key: 'x' }).charter, enabled: true, autonomyLevel: 'OBSERVE' },
      ...over,
    })

  it('says nothing at all before the page has read', () => {
    expect(verdict([], false)).toEqual({
      tone: 'empty',
      headline: 'No workers are wired up yet.',
      detail: null,
    })
  })

  it('a halted fleet outranks everything, including a run in flight', () => {
    const v = verdict(FIXTURE, true)
    expect(v.tone).toBe('halted')
    expect(v.headline).toBe('The fleet is halted.')
  })

  it('names the running workers before it names the broken ones', () => {
    const v = verdict(FIXTURE, false)
    expect(v.tone).toBe('running')
    expect(v.headline).toBe('1 worker is running now.')
  })

  it('a failure is the headline when nothing is in flight', () => {
    const nodes = [
      off('a'),
      on('broke', {
        lastRun: run({ ok: false, errorMessage: 'fetch failed' }),
        runs: { window: 1, lifetime: 1, runningNow: false, runningRunId: null, runningSince: null },
      }),
    ]
    const v = verdict(nodes, false)
    expect(v.tone).toBe('failed')
    expect(v.headline).toBe("1 worker's last run failed.")
  })

  it('an entirely off fleet says so in words — the defect this section exists for', () => {
    const v = verdict([off('a'), off('b'), off('c')], false)
    expect(v.tone).toBe('off')
    expect(v.headline).toBe('The whole fleet is switched off.')
    expect(v.detail).toBe('Nothing will start, whatever any schedule says.')
  })

  it('speaks only numbers the census produced, and never a zero state', () => {
    const nodes = [off('a'), off('b'), on('c', { lastRun: run() })]
    const v = verdict(nodes, false)
    expect(v.tone).toBe('mixed')
    expect(v.headline).toBe('1 of 3 workers is switched on.')
    // the partition, spoken; the five states at zero are absent, not "0 paused"
    expect(v.detail).toBe('1 working · 2 switched off.')
    expect(v.detail).not.toContain('0 ')
  })

  it('every number it speaks is a census count, for every shape a node can be', () => {
    for (const halted of [false, true]) {
      const v = verdict(FIXTURE, halted)
      const counts = new Set(census(FIXTURE).map((r) => String(r.count)))
      counts.add(String(FIXTURE.length))
      for (const num of `${v.headline} ${v.detail ?? ''}`.match(/\d+/g) ?? []) {
        expect(counts.has(num), `verdict spoke "${num}", which no chip counted`).toBe(true)
      }
    }
  })

  it('never claims a plural of one, in either the noun or the verb', () => {
    const one = [
      on('solo', {
        runs: { window: 1, lifetime: 1, runningNow: true, runningRunId: 'r', runningSince: null },
      }),
    ]
    expect(verdict(one, false).headline).toBe('1 worker is running now.')
    // A fleet of one that is on: the noun agrees with the denominator, the
    // verb with the subject. Caught by a test expectation of mine that was
    // wrong before the code was.
    expect(verdict([on('solo', { lastRun: run() })], false).headline).toBe(
      '1 of 1 worker is switched on.',
    )
  })
})

describe('the standing facts', () => {
  it('findings are totalled across every node, diagnostic included', () => {
    expect(findingsTotals(FIXTURE)).toEqual({ open: 47, expired: 47, diagnostic: 47 })
  })

  it('a fleet with no findings reports zeros rather than nothing', () => {
    expect(findingsTotals([node({ key: 'a' })])).toEqual({ open: 0, expired: 0, diagnostic: 0 })
  })

  it('money keeps one precision per sentence, and a real sub-cent is not rounded away', () => {
    expect(usd(0)).toBe('$0.00')
    expect(usd(2)).toBe('$2.00')
    expect(usd(0.2773)).toBe('$0.28')
    // the shipped strip rendered this as "$0.0000"; rounding it to $0.00 would
    // say "nothing spent" about a run that did spend
    expect(usd(0.0042)).toBe('<$0.01')
  })
})
