/**
 * Group 1 (1b) — the one engine → actor map. The strings below are the ones the writing code puts in
 * `AdvertisingActionLog.userId` (file named beside each); the old two copies of this map missed two of them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const warn = vi.hoisted(() => vi.fn())
vi.mock('../../utils/logger.js', () => ({ logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const {
  ENGINE_CAPS_ENV, breakerLimits, breakerLimitsText, classifyActor, countWritesByEngine, engineActorWhere, engineCaps,
  engineForActor, parseEngineCaps,
} = await import('./ads-engine-actors.js')

const savedEnv = process.env[ENGINE_CAPS_ENV]
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENGINE_CAPS_ENV]
  else process.env[ENGINE_CAPS_ENV] = savedEnv
  warn.mockReset()
})

describe('every engine actor the code writes maps to its engine', () => {
  it.each([
    ['automation:rank-defend-clx1', 'rank-defend'], // jobs/ad-rank-defend.job.ts (schedules)
    ['automation:rank-plan-clx2', 'rank-defend'], // jobs/ad-rank-defend.job.ts (product plans) — missing before
    ['automation:dayparting-clx3', 'dayparting'], // jobs/ad-dayparting.job.ts
    ['automation:budget-schedule-clx4', 'budget-schedules'], // jobs/ad-budget-schedule.job.ts
    ['automation:budget-manager-cron', 'budget-enforce'], // jobs/ad-budget-enforce.job.ts
    ['automation:budget-manager', 'budget-enforce'], // ads-budget-enforce.service.ts default — missing before
    ['automation:budget-pool-rebalance', 'budget-pools'], // budget-pool-rebalancer.service.ts
    ['automation:auto-bid', 'auto-bid'], // ads-auto-bid.service.ts
    ['automation:tos-optimizer', 'tos-defense'], // ads-top-of-search.service.ts
    ['automation:coverage-engine', 'coverage-engine'], // ads-coverage-engine.service.ts
    ['automation:autopilot-clx5', 'autopilot'], // autopilot/apply.ts (a plan)
    ['automation:autopilot', 'autopilot'], // autopilot/apply.ts (its top-of-search step)
    ['automation:reconcile', 'write-reconcile'], // ads-write-reconcile.service.ts (bids)
    ['automation:ads-write-reconcile', 'write-reconcile'], // ads-write-reconcile.service.ts (placements)
    ['automation:bid-brain', 'bid-brain'], // bid-brain/live-writer.ts
    ['automation:ads-brain-budgets', 'brain-money'], // brain/budget-live.ts (MONEY_BUDGETS_ACTOR)
    ['automation:ads-brain-portfolio', 'brain-money'], // brain/budget-live.ts (MONEY_PORTFOLIO_ACTOR)
  ])('%s → %s', (actor, engine) => {
    expect(engineForActor(actor)).toBe(engine)
    expect(classifyActor(actor)).toEqual({ kind: 'engine', engine })
  })

  it("a person turning a dayparting schedule off is not the dayparting engine, and not counted", () => {
    for (const a of ['automation:dayparting-disable', 'automation:dayparting-delete', 'automation:resync-bids']) {
      expect(engineForActor(a)).toBeNull()
      expect(classifyActor(a)).toEqual({ kind: 'person' })
    }
  })

  it('rules, people and writes with no author', () => {
    expect(classifyActor('automation:clrule1')).toEqual({ kind: 'rule-candidate', ruleId: 'clrule1' })
    expect(classifyActor('automation:rule-clrule2')).toEqual({ kind: 'rule-candidate', ruleId: 'clrule2' })
    expect(classifyActor('user:u1')).toEqual({ kind: 'person' })
    expect(classifyActor('operator')).toEqual({ kind: 'person' })
    expect(classifyActor(null)).toEqual({ kind: 'unknown' })
    expect(classifyActor('system')).toEqual({ kind: 'unknown' }) // the placement writer's no-actor fallback
  })
})

describe('countWritesByEngine', () => {
  it('buckets per engine; rules and people are left out; an automation actor nobody claims is unknown', () => {
    const counts = countWritesByEngine([
      { userId: 'automation:rank-defend-a', count: 400 },
      { userId: 'automation:rank-plan-b', count: 114 },
      { userId: 'automation:dayparting-c', count: 7 },
      { userId: 'automation:clrule1', count: 30 }, // a rule: its own brakes
      { userId: 'automation:gone-engine', count: 5 }, // no engine, no rule
      { userId: null, count: 3 },
      { userId: 'user:u1', count: 900 },
    ], new Set(['clrule1']))
    expect(counts['rank-defend']).toBe(514)
    expect(counts.dayparting).toBe(7)
    expect(counts.unknown).toBe(8)
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(529)
  })
})

describe('AB-8 — the money writer\'s actors are the brain-money engine, never unknown to the breaker', () => {
  it('both actors the code writes with (budget-ladder.ts) count under brain-money with its own hourly limit', async () => {
    const { MONEY_ACTORS, MONEY_BUDGETS_ACTOR, MONEY_PORTFOLIO_ACTOR } = await import('./brain/budget-ladder.js')
    expect([...MONEY_ACTORS].sort()).toEqual([MONEY_BUDGETS_ACTOR, MONEY_PORTFOLIO_ACTOR].sort())
    for (const actor of MONEY_ACTORS) expect(classifyActor(actor)).toEqual({ kind: 'engine', engine: 'brain-money' })
    const counts = countWritesByEngine([{ userId: MONEY_BUDGETS_ACTOR, count: 7 }, { userId: MONEY_PORTFOLIO_ACTOR, count: 1 }], new Set())
    expect(counts['brain-money']).toBe(8)
    expect(counts.unknown).toBe(0)
    expect(engineActorWhere('brain-money')).toEqual({ OR: [{ userId: { in: [MONEY_BUDGETS_ACTOR, MONEY_PORTFOLIO_ACTOR] } }] })
    expect(breakerLimits()['brain-money']).toBe(200)
  })
})

describe('engineActorWhere', () => {
  it('selects every prefix of the engine and leaves out its person-started strings', () => {
    expect(engineActorWhere('rank-defend')).toEqual({
      OR: [{ userId: { startsWith: 'automation:rank-defend-' } }, { userId: { startsWith: 'automation:rank-plan-' } }],
    })
    expect(engineActorWhere('dayparting')).toEqual({
      OR: [{ userId: { startsWith: 'automation:dayparting-' } }],
      NOT: { userId: { in: ['automation:dayparting-disable', 'automation:dayparting-delete'] } },
    })
    expect(engineActorWhere('budget-enforce')).toEqual({
      OR: [{ userId: { in: ['automation:budget-manager-cron', 'automation:budget-manager'] } }],
    })
  })
})

describe('caps: code defaults, env overrides, never "no cap"', () => {
  it('the defaults the plan set', () => {
    delete process.env[ENGINE_CAPS_ENV]
    expect(engineCaps('rank-defend')).toEqual({ perTick: 600, perDay: 3_000, breakerPerHour: 1_200 })
    expect(engineCaps('dayparting')).toEqual({ perTick: 300, perDay: 1_500, breakerPerHour: 600 })
    expect(engineCaps('write-reconcile')).toEqual({ perTick: null, perDay: null, breakerPerHour: 600 })
    expect(breakerLimits()).toMatchObject({ 'budget-pools': 100, 'tos-defense': 100, autopilot: 300, 'auto-bid': 600, unknown: 300 })
    expect(breakerLimitsText()).toContain('Hourly bid plans 1,200')
  })

  it('the env overrides a single field and keeps the rest', () => {
    process.env[ENGINE_CAPS_ENV] = JSON.stringify({ 'rank-defend': { breakerPerHour: 1500 }, unknown: { breakerPerHour: 50 } })
    expect(engineCaps('rank-defend')).toEqual({ perTick: 600, perDay: 3_000, breakerPerHour: 1_500 })
    expect(engineCaps('unknown').breakerPerHour).toBe(50)
    expect(warn).not.toHaveBeenCalled()
  })

  it('bad JSON: defaults, logged once, never a crash', () => {
    process.env[ENGINE_CAPS_ENV] = '{not json'
    expect(engineCaps('rank-defend').breakerPerHour).toBe(1_200)
    expect(engineCaps('dayparting').breakerPerHour).toBe(600)
    expect(breakerLimits()['rank-defend']).toBe(1_200)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a value that would remove or break a cap keeps the default for that field', () => {
    const { caps, problems } = parseEngineCaps(JSON.stringify({
      'rank-defend': { breakerPerHour: 0, perTick: null, perDay: 2.5 },
      dayparting: { breakerPerHour: -1 },
      'auto-bid': { breakerPerHour: '900' },
      'budget-pools': 'lots',
      'made-up': { breakerPerHour: 1 },
      autopilot: { perWeek: 10, perTick: 120 },
    }))
    expect(caps['rank-defend']).toEqual({ perTick: 600, perDay: 3_000, breakerPerHour: 1_200 })
    expect(caps.dayparting.breakerPerHour).toBe(600)
    expect(caps['auto-bid'].breakerPerHour).toBe(600)
    expect(caps['budget-pools'].breakerPerHour).toBe(100)
    expect(caps.autopilot.perTick).toBe(120) // the valid field in a partly wrong entry still applies
    expect(problems).toHaveLength(8)
    for (const c of Object.values(caps)) expect(Number.isInteger(c.breakerPerHour) && c.breakerPerHour >= 1).toBe(true)
  })

  it('an array or a bare number is not an override', () => {
    expect(parseEngineCaps('[1,2]').problems).toEqual(['not a JSON object'])
    expect(parseEngineCaps('5').problems).toEqual(['not a JSON object'])
    expect(parseEngineCaps('').problems).toEqual([])
  })
})
