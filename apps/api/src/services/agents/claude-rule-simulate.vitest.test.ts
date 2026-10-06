/**
 * Approvals grid (PLAN §4) — "what would this rule have done?": of Claude's requests of one tool in this business over
 * the last days, how many the proposed level and limits would have let run by themselves, and how many of those the
 * person rejected. The verdict is the real rule's own check (the tool's limits schema and withinLimits): this file
 * holds it to autoCommitRefusal — the check a rule-run passes at commit — request by request, so the two cannot drift.
 *
 * On a real PostgreSQL (PGlite) with the production schema and business policies.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})

import { __claudeStrategyTest } from '../advertising/ads-strategy/claude.js'
import { autoCommitRefusal } from './claude-trust.service.js'
import { simulateClaudeRule } from './claude-rule-simulate.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const DAY = 24 * 3600_000
const seeAll = (_tool: string, value: unknown) => value
const seeNothing = () => null

/** Claude's requests of set-price in this business (and two that must not count), each with its stored preview. */
const ROWS: Array<{ key: string; deltaPct?: number; status: string; note?: string; reason?: string; agentKey?: string; daysAgo?: number }> = [
  { key: 'ran', deltaPct: 4, status: 'executed' },
  { key: 'said-no', deltaPct: -8, status: 'rejected', note: 'not now' },
  { key: 'too-far', deltaPct: 12, status: 'rejected', note: 'far too much' },
  { key: 'waiting', deltaPct: 2, status: 'pending' },
  { key: 'no-price', status: 'pending' },
  { key: 'withdrawn', deltaPct: 3, status: 'rejected', reason: 'withdrawn: another undo of this change won' },
  { key: 'silent-no', deltaPct: 1, status: 'rejected' },
  { key: 'fleet', deltaPct: 1, status: 'executed', agentKey: 'manual-action' },
  { key: 'old', deltaPct: 1, status: 'executed', daysAgo: 40 },
]
const ids: Record<string, string> = {}
const previewOf = (r: (typeof ROWS)[number]) => (r.deltaPct === undefined ? { summary: `${r.key}: no master price` } : { summary: `${r.key}: price moves ${r.deltaPct} %`, deltaPct: r.deltaPct })

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    // The business lets Claude run set-price by its rule, inside 10 %.
    await db.agentTool.create({ data: { name: 'set-price', riskTier: 'high', requiresApproval: true, claudeTrust: 'auto', claudeLimits: { maxChangePercent: 10 } } })
    for (const r of ROWS) {
      const run = await db.agentRun.create({ data: { agentKey: r.agentKey ?? 'claude', trigger: 'manual', status: 'done', via: r.agentKey ? null : 'claude' } as never })
      ids[r.key] = (await db.agentApproval.create({
        data: {
          agentRunId: run.id,
          toolName: 'set-price',
          riskTier: 'high',
          args: {},
          preview: previewOf(r),
          status: r.status,
          requestedAt: new Date(Date.now() - (r.daysAgo ?? 1) * DAY),
          reason: r.reason ?? (r.note ?? null),
          operatorNote: r.note ?? null,
        },
      })).id
    }
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)

const simulate = (tool: string, query: Record<string, unknown>, see = seeAll) => inside(() => simulateClaudeRule(tool, query, see))

describe('simulate — would the proposed rule have run these by themselves?', { timeout: 30_000 }, () => {
  it('the business’s rule now (limits absent): the same verdict as the commit’s rule check, request by request', async () => {
    const out = await simulate('set-price', { level: 'auto' })
    expect(out).toMatchObject({ ok: true })
    const sim = (out as Extract<typeof out, { ok: true }>).simulation
    // In the window, from Claude, not withdrawn: ran, said-no, too-far, waiting, no-price, silent-no.
    expect(sim).toMatchObject({ toolName: 'set-price', days: 30, considered: 6, wouldRun: 4, rejectedAmongWouldRun: 2 })
    // The real rule's check, on the same stored previews: exactly these run by rule.
    const counted = ['ran', 'said-no', 'too-far', 'waiting', 'no-price', 'silent-no']
    const byRule = []
    for (const key of counted) {
      const r = ROWS.find((row) => row.key === key)!
      if ((await inside(() => autoCommitRefusal('set-price', previewOf(r)))) === null) byRule.push(key)
    }
    expect(byRule.sort()).toEqual(['ran', 'said-no', 'silent-no', 'waiting'])
    expect(sim.wouldRun).toBe(byRule.length)
    // The rejected ones that would have run, with the person's words when they gave some.
    expect(sim.examples).toHaveLength(2)
    expect(sim.examples).toEqual(expect.arrayContaining([
      { id: ids['said-no'], summary: 'said-no: price moves -8 %', rejectedReason: 'not now' },
      { id: ids['silent-no'], summary: 'silent-no: price moves 1 %', rejectedReason: null },
    ]))
  })

  it('proposed limits: tighter runs fewer, looser runs more; the window widens with days', async () => {
    const at = async (limits: unknown, days?: number) => {
      const out = await simulate('set-price', { level: 'auto', limits: JSON.stringify(limits), ...(days ? { days: String(days) } : {}) })
      return (out as Extract<typeof out, { ok: true }>).simulation
    }
    expect(await at({ maxChangePercent: 5 })).toMatchObject({ considered: 6, wouldRun: 3, rejectedAmongWouldRun: 1 })
    expect(await at({ maxChangePercent: 15 })).toMatchObject({ considered: 6, wouldRun: 5, rejectedAmongWouldRun: 3 })
    // An object is read as well as its JSON text; defaults fill what is not named (as the rule stores them).
    const out = await simulate('set-price', { limits: {} })
    expect((out as Extract<typeof out, { ok: true }>).simulation).toMatchObject({ wouldRun: 4 })
    expect(await at({ maxChangePercent: 10 }, 60)).toMatchObject({ days: 60, considered: 7, wouldRun: 5 })
    expect(await at({ maxChangePercent: 10 }, 500)).toMatchObject({ days: 90 })
  })

  it('W1-8 (AA-W2-3) — an ad change is held to the ads strategy where it lands, as the commit’s rule check holds it', async () => {
    // No ad tool may run by rule before W2: set-price stands in as a bid change (it lands nowhere the strategy can
    // place, so the strictest row of the business applies).
    __claudeStrategyTest.treatAs('set-price', 'bid')
    const row = await inside(() => database.client.adsStrategy.create({
      data: { market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', claudeAutonomy: { bid: 'ask' }, updatedBy: 'user:test' },
    }))
    try {
      const held = await simulate('set-price', { level: 'auto' })
      expect((held as Extract<typeof held, { ok: true }>).simulation).toMatchObject({ considered: 6, wouldRun: 0, rejectedAmongWouldRun: 0, examples: [] })
      for (const key of ['ran', 'said-no', 'waiting', 'silent-no']) {
        const r = ROWS.find((one) => one.key === key)!
        expect(await inside(() => autoCommitRefusal('set-price', previewOf(r), {}))).toMatch(/^the ads strategy lets Claude only ask for bid changes here/)
      }
      // A strategy that lets Claude run bid changes alone narrows nothing: the limits decide again.
      await inside(() => database.client.adsStrategy.update({ where: { id: row.id }, data: { claudeAutonomy: { bid: 'auto' } } }))
      const free = await simulate('set-price', { level: 'auto' })
      expect((free as Extract<typeof free, { ok: true }>).simulation).toMatchObject({ considered: 6, wouldRun: 4, rejectedAmongWouldRun: 2 })
    } finally {
      __claudeStrategyTest.reset()
      await inside(() => database.client.adsStrategy.delete({ where: { id: row.id } }))
    }
  })

  it('only auto runs by itself: at confirm or ask nothing would have', async () => {
    for (const level of ['confirm', 'ask']) {
      const out = await simulate('set-price', { level })
      expect((out as Extract<typeof out, { ok: true }>).simulation).toMatchObject({ considered: 6, wouldRun: 0, rejectedAmongWouldRun: 0, examples: [] })
    }
  })

  it('examples are described only through the reader’s own money filter', async () => {
    const out = await simulate('set-price', {}, seeNothing)
    const sim = (out as Extract<typeof out, { ok: true }>).simulation
    expect(sim.examples.map((e) => e.summary)).toEqual(['Set master price', 'Set master price'])
  })

  it('refuses, in plain words: a level above the ceiling, limits outside the schema, a bad window, a tool Claude is not offered', async () => {
    expect(await simulate('publish-listing', { level: 'auto' })).toEqual({ ok: false, status: 400, error: 'publish-listing can be set to ask at most: a person always approves it.' })
    expect(await simulate('set-stock', { level: 'auto' })).toEqual({ ok: false, status: 400, error: 'set-stock can be set to confirm at most: that is the most it may do without a person.' })
    expect(await simulate('set-price', { level: 'sometimes' })).toEqual({ ok: false, status: 400, error: 'level must be one of off, ask, confirm, auto.' })
    const bad = await simulate('set-price', { limits: JSON.stringify({ maxChangePercent: 'ten' }) })
    expect(bad).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/^Limits for set-price: maxChangePercent — /) })
    const unknown = await simulate('set-price', { limits: JSON.stringify({ maxChangePercent: 5, anything: true }) })
    expect(unknown).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/^Limits for set-price: /) })
    expect(await simulate('set-price', { limits: '{not json' })).toEqual({ ok: false, status: 400, error: 'limits must be a JSON object.' })
    for (const days of ['0', '-3', 'abc', '2.5']) {
      expect(await simulate('set-price', { days })).toEqual({ ok: false, status: 400, error: 'days must be a whole number from 1 to 90.' })
    }
    expect(await simulate('no-such-tool', {})).toEqual({ ok: false, status: 404, error: 'no-such-tool is not a tool Claude is offered.' })
  })

  it('reads only: nothing it looked at changed', async () => {
    const before = await inside(() => database.client.agentApproval.findMany({ orderBy: { id: 'asc' } }))
    await simulate('set-price', { level: 'auto', limits: JSON.stringify({ maxChangePercent: 50 }), days: '90' })
    expect(await inside(() => database.client.agentApproval.findMany({ orderBy: { id: 'asc' } }))).toEqual(before)
  })
})
