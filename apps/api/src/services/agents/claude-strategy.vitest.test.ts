/**
 * ADS AUTONOMY W1-8 — the ads strategy narrows what Claude may do alone, through Claude's own door (runToolForClaude
 * → the gate → confirm-change → the sweep's commit), on PGlite with the production schema and business policies,
 * business profiles ON, two businesses. The ads write gate is the real one (sandbox); nothing reaches Amazon. Values
 * are made up (public repo).
 *
 *   narrows     the business sets an ad tool to confirm; where the strategy says ask, the change waits for a person,
 *               the answer names the strategy row (trust.strategy), and confirm-change is refused — also when the
 *               strategy narrowed it after it was asked for; in a market the strategy does not speak to, confirm stays
 *   off         where the strategy turns a kind of action off, the change is refused before anything runs
 *   never wider a strategy at confirm or auto leaves a business at ask (or confirm) exactly where it is
 *   specific    a product row wins over the market row inside the strategy; across an ad group's products the safer
 *               level; never above the business's
 *   brakes      every kind of ad action off in a market: stop-automation still runs by the business's rule
 *   fail closed a selection by market, or an id Nexus cannot place, takes the strictest row (of the market, or the
 *               business)
 *   plans       each step at its own level where it lands; the plan names the step and the row
 *   commit      a change scheduled by rule goes back to a person when the strategy narrows it inside the window
 *               (no ad tool may run by rule before W2: set-price stands in as a bid change)
 *   businesses  one business's strategy never narrows in another
 *   watch       AA-W2-4 — the strategy may hold a kind at watch: checked as auto would, recorded with the strategy row;
 *               a kind at watch the strategy holds lower is recorded as held by the strategy; the history test counts it
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecret, generateSync } from 'otplib'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// As db.ts wraps it: inside a transaction, `prisma.x` is that transaction's client.
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true, workersOff: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import { __stepUpTest } from '../../lib/auth/step-up.js'
import { commitScheduledApproval } from '../agent-fleet/approval-inbox.service.js'
import { __claudeStrategyTest } from '../advertising/ads-strategy/claude.js'
import { CLAUDE_ACTION_TYPES } from '../advertising/ads-strategy/fields.js'
import { readStrategy } from '../advertising/ads-strategy/read.js'
import type { McpPrincipal } from '../mcp/mcp-auth.js'
import { runToolForClaude } from '../mcp/mcp-tool-call.js'
import { claudeRuleForChange, claudeRuleOf, setClaudeRule } from './claude-trust.service.js'
import { simulateClaudeRule } from './claude-rule-simulate.service.js'
import { getTool } from './tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const B = 'w18_strategy_bravo'
const TIMEOUT = 30_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const db = () => database.client
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = { person: '', p1: '', p2: '', p3: '', priced: '', pricedB: '' }
const names = { A: '', B: 'Bravo strategy business' }
let secret = ''

function claude(workspaceId = A): McpPrincipal {
  return {
    kind: 'user', userId: ids.person, label: 'Stella Strategy', permissions: { isOwner: false, permissions: EVERYTHING },
    workspace: business(workspaceId), business: { id: workspaceId, name: workspaceId === A ? names.A : names.B },
    via: 'claude', oauthGrantId: `grant-${workspaceId}`, scopes: ['nexus.read', 'nexus.write', 'nexus.run'],
  } as McpPrincipal
}
const code = () => {
  __stepUpTest.reset()
  return generateSync({ secret })
}
type Answer = Record<string, any>
async function call(tool: string, args: Record<string, unknown>, workspaceId = A): Promise<{ isError: boolean; answer: Answer }> {
  const who = claude(workspaceId)
  const result = await inside(() => runToolForClaude(who, getTool(tool)!, { ...args, business: who.business.name }), workspaceId)
  return { isError: !!result.isError, answer: JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join('')) }
}
async function setLevel(tool: string, level: string, workspaceId = A) {
  const saved = await inside(() => setClaudeRule({ userId: ids.person, label: 'Stella Strategy', canManage: true }, tool, { level, code: code() }), workspaceId)
  expect(saved, 'error' in saved ? saved.error : '').toMatchObject({ ok: true })
}
/** One strategy row in business A (IT unless named), saying what Claude may do alone. */
const strategy = (level: 'MARKET' | 'CATEGORY' | 'PRODUCT', scopeId: string, label: string, claudeAutonomy: Record<string, string>, market = 'IT') =>
  inside(() => db().adsStrategy.create({ data: { market, level, scopeId, label, claudeAutonomy, updatedBy: 'user:test' } }))
const approvalOf = (id: string) => inside(() => db().agentApproval.findUniqueOrThrow({ where: { id } }))
const NARROWED_ASK = 'the ads strategy lets Claude only ask for bid changes here'

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const client = database.client
  secret = generateSecret()
  const role = await client.role.create({
    data: { key: `W18_${randomUUID().slice(0, 8)}`, name: 'Strategy tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] },
  })
  const person = await client.userProfile.create({
    data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Stella Strategy', twoFactorEnabledAt: new Date(), twoFactorSecret: secret },
  })
  ids.person = person.id
  await client.userRole.create({ data: { userId: person.id, roleId: role.id } })
  await client.workspace.create({ data: { id: B, name: names.B, createdByUserId: person.id, creationKey: randomUUID() } })
  names.A = (await client.workspace.findUniqueOrThrow({ where: { id: A } })).name
  for (const workspaceId of [A, B]) {
    const membership = await client.workspaceMembership.create({ data: { workspaceId, userId: person.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }
  await inside(async () => {
    await seedAdsFixture(client)
    // c-it's ad group advertises P1; c-off's advertises P2.
    ids.p1 = (await client.product.create({ data: { sku: 'TEST-W18-P1', name: 'Test helmet', basePrice: '10.00' } })).id
    ids.p2 = (await client.product.create({ data: { sku: 'TEST-W18-P2', name: 'Test gloves', basePrice: '10.00' } })).id
    ids.p3 = (await client.product.create({ data: { sku: 'TEST-W18-P3', name: 'Test boots', basePrice: '10.00' } })).id
    ids.priced = (await client.product.create({ data: { sku: 'TEST-W18-PRICE', name: 'Test jacket', basePrice: '100.00' } })).id
    await client.adProductAd.create({ data: { adGroupId: 'g-c-it', productId: ids.p1, asin: 'B0TESTW181' } })
    await client.adProductAd.create({ data: { adGroupId: 'g-c-off', productId: ids.p2, asin: 'B0TESTW182' } })
  })
  await inside(async () => {
    ids.pricedB = (await client.product.create({ data: { sku: 'TEST-W18-PRICE', name: 'Bravo jacket', basePrice: '100.00' } })).id
  }, B)
}, 180_000)

beforeEach(async () => {
  __stepUpTest.reset()
  __claudeStrategyTest.reset()
  for (const workspaceId of [A, B]) {
    await inside(async () => {
      await db().adsStrategy.deleteMany({})
      await db().agentTool.deleteMany({})
      await db().agentAutonomy.deleteMany({})
      await db().agentApproval.updateMany({ where: { status: { in: ['pending', 'scheduled'] } }, data: { status: 'rejected', decisionVia: null } })
    }, workspaceId)
  }
  await inside(() => db().adProductAd.deleteMany({ where: { productId: ids.p3 } }))
})
afterEach(() => __claudeStrategyTest.reset())
afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('W1-8 — the strategy narrows: confirm becomes ask where it says ask', { timeout: TIMEOUT }, () => {
  it('waits for a person, names the strategy row, and confirm-change is refused before the code is spent', async () => {
    await setLevel('set-target-bid', 'confirm')
    await strategy('MARKET', '*', 'Test market (IT)', { bid: 'ask' })
    const { answer } = await call('set-target-bid', { targetId: 't-it', proposedBidCents: 50 })
    expect(answer).toMatchObject({
      status: 'waiting_for_approval',
      trust: {
        level: 'ask',
        why: `${NARROWED_ASK} (IT: market "Test market (IT)", version 1; the business's own level is confirm in Claude); a person approves it in Nexus`,
        strategy: { action: 'bid', level: 'ask', business: 'confirm', market: 'IT', basis: 'scope', row: { scope: 'market', label: 'Test market (IT)', version: 1 } },
      },
    })
    expect(answer).not.toHaveProperty('confirm')
    const refused = await call('confirm-change', { approvalId: answer.approvalId, planHash: '0'.repeat(64), code: '123456' })
    expect(refused.isError).toBe(true)
    expect(refused.answer.error).toBe(`Not confirmed here: ${NARROWED_ASK} (IT: market "Test market (IT)", version 1; the business's own level is confirm in Claude); a person approves it in Nexus. Nothing was approved.`)
    expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null })
  })

  it('in a market the strategy does not speak to, confirm stays', async () => {
    await setLevel('set-target-bid', 'confirm')
    await strategy('MARKET', '*', 'Test market (IT)', { bid: 'ask' })
    const { answer } = await call('set-target-bid', { targetId: 't-uk', proposedBidCents: 61 })
    expect(answer).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'confirm' }, confirm: { planHash: expect.any(String) } })
    expect(answer.trust).not.toHaveProperty('strategy')
  })

  it('a narrowing saved after the request: confirm-change hands it to a person, and lifting it lets the code through', async () => {
    await setLevel('set-target-bid', 'confirm')
    const queued = (await call('set-target-bid', { targetId: 't-it', proposedBidCents: 52 })).answer
    expect(queued.confirm.planHash).toEqual(expect.any(String))
    const row = await strategy('MARKET', '*', 'Test market (IT)', { bid: 'ask' })
    const refused = await call('confirm-change', { approvalId: queued.approvalId, planHash: queued.confirm.planHash, code: code() })
    expect(refused.answer.error).toMatch(/^Not confirmed here: the ads strategy lets Claude only ask for bid changes here \(IT: market "Test market \(IT\)", version 1;/)
    expect(await approvalOf(queued.approvalId)).toMatchObject({ status: 'pending' })
    await inside(() => db().adsStrategy.delete({ where: { id: row.id } }))
    const confirmed = await call('confirm-change', { approvalId: queued.approvalId, planHash: queued.confirm.planHash, code: code() })
    expect(confirmed.answer).toMatchObject({ status: 'confirmed' })
    expect(await approvalOf(queued.approvalId)).toMatchObject({ status: 'scheduled', decisionVia: 'claude-confirm' })
  })

  it('the read tool shows the level that applies here: the lower of the business and the strategy', async () => {
    await setLevel('set-target-bid', 'confirm')
    await strategy('MARKET', '*', 'Test market (IT)', { bid: 'ask' })
    const out = await inside(() => readStrategy({ market: 'IT' }))
    if ('error' in out) throw new Error(out.error)
    const bid = ((out.data.markets as Answer[])[0].claude as Answer[]).find((c) => c.action === 'bid')!
    expect(bid.tools).toEqual([{ tool: 'set-target-bid', business: 'confirm', effective: 'ask' }, { tool: 'bulk-ad-bid-change', business: 'ask', effective: 'ask' }, { tool: 'set-ad-group', business: 'ask', effective: 'ask' }]) // W4-6 — an ad group's default bid is a bid too
  })
})

describe('W1-8 — off, never wider, the most specific row', { timeout: TIMEOUT }, () => {
  it('off: refused before anything runs, naming the row; nothing queued', async () => {
    await strategy('MARKET', '*', 'Test market (IT)', { budget: 'off' })
    const pending = () => inside(() => db().agentApproval.count({ where: { toolName: 'set-campaign-budget', status: 'pending' } }))
    const before = await pending()
    const { isError, answer } = await call('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: 2500 })
    expect(isError).toBe(true)
    expect(answer.error).toBe(`The ads strategy turns budget changes off for Claude here (IT: market "Test market (IT)", version 1; the business's own level is ask). Nothing was queued.`)
    expect(await pending()).toBe(before)
  })

  it('never widens: a strategy at auto leaves ask at ask, and confirm at confirm', async () => {
    await strategy('MARKET', '*', 'Test market (IT)', { bid: 'auto' })
    const asked = (await call('set-target-bid', { targetId: 't-it', proposedBidCents: 47 })).answer
    expect(asked).toMatchObject({ status: 'waiting_for_approval' })
    expect(asked).not.toHaveProperty('trust')
    await setLevel('set-target-bid', 'confirm')
    const confirmed = (await call('set-target-bid', { targetId: 't-it', proposedBidCents: 48 })).answer
    expect(confirmed).toMatchObject({ trust: { level: 'confirm' }, confirm: { planHash: expect.any(String) } })
    expect(confirmed.trust).not.toHaveProperty('strategy')
    expect(await inside(() => claudeRuleForChange('set-target-bid', { targetId: 't-it' }))).toMatchObject({ level: 'confirm' })
  })

  it('a product row wins over the market row; across an ad group the safer product; never above the business', async () => {
    await setLevel('set-target-bid', 'confirm')
    await strategy('MARKET', '*', 'Test market (IT)', { bid: 'ask' })
    await strategy('PRODUCT', ids.p1, 'TEST-W18-P1 (IT)', { bid: 'auto' })
    // c-it's ad group advertises only P1: its own row (auto) wins over the market's ask — held to the business's confirm.
    const own = (await call('set-target-bid', { targetId: 't-it', proposedBidCents: 49 })).answer
    expect(own).toMatchObject({ trust: { level: 'confirm' }, confirm: { planHash: expect.any(String) } })
    // P3 joins the ad group with bids turned off: the safer of the two applies to the whole ad group.
    await strategy('PRODUCT', ids.p3, 'TEST-W18-P3 (IT)', { bid: 'off' })
    await inside(() => db().adProductAd.create({ data: { adGroupId: 'g-c-it', productId: ids.p3, asin: 'B0TESTW183' } }))
    const mixed = await call('set-target-bid', { targetId: 't-it', proposedBidCents: 49 })
    expect(mixed.isError).toBe(true)
    expect(mixed.answer.error).toBe(`The ads strategy turns bid changes off for Claude here (IT: product "TEST-W18-P3 (IT)", version 1, from TEST-W18-P3; the business's own level is confirm in Claude). Nothing was queued.`)
  })
})

describe('W1-8 — brakes are never narrowed', { timeout: TIMEOUT }, () => {
  it('every kind of ad action off in IT: stop-automation still runs by the business’s rule', async () => {
    await strategy('MARKET', '*', 'Test market (IT)', Object.fromEntries(CLAUDE_ACTION_TYPES.map((action) => [action, 'off'])))
    await setLevel('stop-automation', 'auto')
    expect(await inside(() => claudeRuleForChange('stop-automation', { area: 'amazon-ads', reason: 'test stop' }))).toEqual(await inside(() => claudeRuleOf('stop-automation')))
    const stop = await call('stop-automation', { area: 'amazon-ads', reason: 'a test stop' })
    expect(stop.answer).toMatchObject({ status: 'runs_by_rule', trust: { level: 'auto' } })
    // …while an ad change there is refused.
    expect((await call('set-target-bid', { targetId: 't-it', proposedBidCents: 50 })).isError).toBe(true)
  })
})

describe('W1-8 — fail closed: what cannot be placed exactly takes the strictest row', { timeout: TIMEOUT }, () => {
  it('a change to every campaign of a market takes the strictest row of the market; one campaign its own ad groups', async () => {
    await setLevel('set-campaign-target-acos', 'confirm')
    await strategy('MARKET', '*', 'Test market (IT)', { target: 'confirm' })
    await strategy('PRODUCT', ids.p2, 'TEST-W18-P2 (IT)', { target: 'ask' })
    const campaign = (await call('set-campaign-target-acos', { campaignIds: ['c-it'], targetAcosPct: 25 })).answer
    expect(campaign).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'confirm' }, confirm: { planHash: expect.any(String) } })
    const market = (await call('set-campaign-target-acos', { market: 'IT', targetAcosPct: 25 })).answer
    expect(market).toMatchObject({
      status: 'waiting_for_approval',
      trust: {
        level: 'ask',
        why: `the ads strategy lets Claude only ask for target ACoS changes here (IT: product "TEST-W18-P2 (IT)", version 1; it sets every campaign of the market, so the strictest row of IT applies; the business's own level is confirm in Claude); a person approves it in Nexus`,
        strategy: { action: 'target', basis: 'market', unplaced: 'it sets every campaign of the market', row: { scope: 'product' } },
      },
    })
    expect(market).not.toHaveProperty('confirm')
  })

  it('a bulk bid selection by market: the strictest row of the market turns it off', async () => {
    await strategy('MARKET', '*', 'Test market (IT)', { bid: 'ask' })
    await strategy('PRODUCT', ids.p2, 'TEST-W18-P2 (IT)', { bid: 'off' })
    expect((await call('bulk-ad-bid-change', { campaignId: 'c-it', percent: 10 })).answer).toMatchObject({ status: 'waiting_for_approval' })
    const market = await call('bulk-ad-bid-change', { market: 'IT', percent: 10 })
    expect(market.isError).toBe(true)
    expect(market.answer.error).toMatch(/^The ads strategy turns bid changes off for Claude here \(IT: product "TEST-W18-P2 \(IT\)", version 1; a selection by market reaches every ad group of it, so the strictest row of IT applies;/)
  })

  it('an id Nexus cannot place: the strictest row of the business', async () => {
    await setLevel('set-target-bid', 'confirm')
    await strategy('MARKET', '*', 'Test market (DE)', { bid: 'ask' }, 'DE')
    const rule = await inside(() => claudeRuleForChange('set-target-bid', { targetId: 'no-such-target' }))
    expect(rule).toMatchObject({ level: 'ask', narrowedBy: { basis: 'business', market: 'DE', unplaced: 'a target it names was not found' } })
    // A target in a market without a strategy row is not touched by DE's.
    expect(await inside(() => claudeRuleForChange('set-target-bid', { targetId: 't-it' }))).toMatchObject({ level: 'confirm' })
  })
})

describe('W1-8 — a plan: each step at its own level where it lands', { timeout: TIMEOUT }, () => {
  it('a step the strategy narrowed makes the plan wait for a person, naming the step and the row', async () => {
    await setLevel('set-target-bid', 'confirm')
    await strategy('MARKET', '*', 'Test market (IT)', { bid: 'ask' })
    const steps = [
      { tool: 'set-target-bid', args: { targetId: 't-uk', proposedBidCents: 62 } },
      { tool: 'set-target-bid', args: { targetId: 't-it', proposedBidCents: 51 } },
    ]
    const both = (await call('submit-change-plan', { title: 'Two bids', steps })).answer
    expect(both).toMatchObject({
      status: 'waiting_for_approval',
      trust: { level: 'ask', why: expect.stringMatching(/^a plan runs by rule only when every step may: step 2 \(set-target-bid\): the ads strategy lets Claude only ask for bid changes here \(IT: market "Test market \(IT\)"/), strategy: { market: 'IT', row: { scope: 'market' } } },
    })
    expect(both).not.toHaveProperty('confirm')
    const ukOnly = (await call('submit-change-plan', { title: 'One bid', steps: [steps[0]] })).answer
    expect(ukOnly).toMatchObject({ trust: { level: 'confirm' }, confirm: { planHash: expect.any(String) } })
  })

  it('a step the strategy turns off: the plan is not stored, and the step says why', async () => {
    await strategy('MARKET', '*', 'Test market (IT)', { bid: 'off' })
    const out = await call('submit-change-plan', { title: 'Two bids', steps: [
      { tool: 'set-target-bid', args: { targetId: 't-uk', proposedBidCents: 62 } },
      { tool: 'set-target-bid', args: { targetId: 't-it', proposedBidCents: 51 } },
    ] })
    expect(out.isError).toBe(true)
    expect(out.answer.refusals).toEqual([{ step: 2, tool: 'set-target-bid', error: expect.stringMatching(/^The ads strategy turns bid changes off for Claude here \(IT: market/) }])
  })
})

describe('W1-8 — run by rule (set-price stands in as a bid change: no ad tool may run by rule before W2)', { timeout: TIMEOUT }, () => {
  it('a strategy at auto lets it run by rule; narrowed to confirm, it waits and says where the row is', async () => {
    __claudeStrategyTest.treatAs('set-price', 'bid')
    await setLevel('set-price', 'auto')
    await strategy('MARKET', '*', 'Test market (IT)', { bid: 'auto' })
    expect((await call('set-price', { productId: ids.priced, price: 101 })).answer).toMatchObject({ status: 'runs_by_rule' })
    await inside(() => db().adsStrategy.updateMany({ data: { claudeAutonomy: { bid: 'confirm' }, version: 2 } }))
    const narrowed = (await call('set-price', { productId: ids.priced, price: 102 })).answer
    expect(narrowed).toMatchObject({
      status: 'waiting_for_approval',
      trust: { level: 'confirm', strategy: { basis: 'business', unplaced: 'Nexus cannot tell where this change lands', business: 'auto' } },
      confirm: { planHash: expect.any(String) },
    })
    expect(narrowed.trust.why).toMatch(/^the ads strategy lets Claude go no further than confirm in Claude for bid changes here \(IT: market "Test market \(IT\)", version 2; Nexus cannot tell where this change lands, so the strictest row of the business applies; the business's own level is run by rule\), so the person who asked types their authenticator code/)
  })

  it('narrowed inside the undo window: at commit the change goes back to a person, naming the row', async () => {
    __claudeStrategyTest.treatAs('set-price', 'bid')
    await setLevel('set-price', 'auto')
    const before = Number((await inside(() => db().product.findUniqueOrThrow({ where: { id: ids.priced } }))).basePrice)
    const parked = (await call('set-price', { productId: ids.priced, price: before + 1 })).answer
    expect(parked.status).toBe('runs_by_rule')
    await strategy('MARKET', '*', 'Test market (IT)', { bid: 'ask' })
    await inside(() => db().agentApproval.update({ where: { id: parked.approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
    const out = await inside(() => commitScheduledApproval(parked.approvalId))
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining(NARROWED_ASK) })
    expect(await approvalOf(parked.approvalId)).toMatchObject({ status: 'pending', decisionVia: null, reason: expect.stringMatching(/^not run — the ads strategy lets Claude only ask for bid changes here/) })
    expect(Number((await inside(() => db().product.findUniqueOrThrow({ where: { id: ids.priced } }))).basePrice)).toBe(before)
  })

  it('one business’s strategy never narrows in another', async () => {
    __claudeStrategyTest.treatAs('set-price', 'bid')
    await setLevel('set-price', 'auto')
    await setLevel('set-price', 'auto', B)
    await strategy('MARKET', '*', 'Test market (IT)', { bid: 'ask' })
    const inB = (await call('set-price', { productId: ids.pricedB, price: 101 }, B)).answer
    expect(inB).toMatchObject({ business: { id: B }, status: 'runs_by_rule' })
    expect(await inside(() => claudeRuleForChange('set-price', {}), B)).toMatchObject({ level: 'auto' })
    expect(await inside(() => claudeRuleForChange('set-price', {}))).toMatchObject({ level: 'ask', narrowedBy: { market: 'IT' } })
  })
})

describe('AA-W2-4 — the strategy may hold a kind at watch (set-price stands in as a bid change)', { timeout: TIMEOUT }, () => {
  it('a strategy at watch holds an auto kind there: checked as auto would, recorded with its row; a person decides', async () => {
    __claudeStrategyTest.treatAs('set-price', 'bid')
    await setLevel('set-price', 'auto')
    await strategy('MARKET', '*', 'Test market (IT)', { bid: 'watch' })
    const answer = (await call('set-price', { productId: ids.priced, price: 101 })).answer
    expect(answer).toMatchObject({
      status: 'waiting_for_approval',
      trust: { level: 'watch', strategy: { market: 'IT', level: 'watch', business: 'auto' }, watch: { wouldRun: true, check: null } },
      confirm: { planHash: expect.any(String) },
    })
    expect(answer.trust.why).toMatch(/^watching: it would have run by rule; the person who asked types their authenticator code/)
    const stored = await approvalOf(answer.approvalId)
    expect(stored).toMatchObject({ status: 'pending', decisionVia: null, executeAfter: null })
    expect(stored.ruleVerdict).toMatchObject({ level: 'watch', wouldRun: true, strategy: { market: 'IT', scope: 'market', label: 'Test market (IT)', version: 1, level: 'watch' } })
    // The history test: inside the limits, but today's strategy (not this kind's rule) holds every such request here at
    // watch, so none would have run by itself; each is counted as held by the strategy.
    const sim = await inside(() => simulateClaudeRule('set-price', { level: 'auto' }, (_tool, value) => value))
    expect(sim).toMatchObject({ ok: true, simulation: { wouldRun: 0 } })
    expect((sim as Extract<typeof sim, { ok: true }>).simulation.heldByStrategy).toBeGreaterThan(0)
  })

  it('the kind at watch, the strategy at ask where it lands: recorded as held by the strategy; it waits at ask', async () => {
    __claudeStrategyTest.treatAs('set-price', 'bid')
    await setLevel('set-price', 'watch')
    await strategy('MARKET', '*', 'Test market (IT)', { bid: 'ask' })
    const answer = (await call('set-price', { productId: ids.priced, price: 102 })).answer
    expect(answer).toMatchObject({
      status: 'waiting_for_approval',
      trust: { level: 'ask', strategy: { level: 'ask', business: 'watch' }, watch: { wouldRun: false, check: 'strategy', why: expect.stringContaining(NARROWED_ASK) } },
    })
    expect(answer).not.toHaveProperty('confirm')
    expect((await approvalOf(answer.approvalId)).ruleVerdict).toMatchObject({ level: 'ask', wouldRun: false, check: 'strategy', strategy: { level: 'ask' } })
  })

  it('the read tool shows a strategy at watch, and it never lifts a business level below it', async () => {
    await setLevel('set-target-bid', 'confirm')
    await strategy('MARKET', '*', 'Test market (IT)', { bid: 'watch' })
    const out = await inside(() => readStrategy({ market: 'IT' }))
    if ('error' in out) throw new Error(out.error)
    const bid = ((out.data.markets as Answer[])[0].claude as Answer[]).find((c) => c.action === 'bid')!
    expect(bid).toMatchObject({ strategy: 'watch' })
    expect(bid.tools).toEqual([{ tool: 'set-target-bid', business: 'confirm', effective: 'confirm' }, { tool: 'bulk-ad-bid-change', business: 'ask', effective: 'ask' }, { tool: 'set-ad-group', business: 'ask', effective: 'ask' }]) // W4-6 — an ad group's default bid is a bid too
    const rule = await inside(() => claudeRuleForChange('set-target-bid', { targetId: 't-it', proposedBidCents: 51 }))
    expect(rule).toMatchObject({ level: 'confirm' })
    expect(rule).not.toHaveProperty('narrowedBy')
  })
})

/**
 * AA-W2-8 — the first ad tools that may run by rule: a campaign's daily budget, its placement adjustments and campaign
 * target ACoS. Each runs alone only inside its own limits (a raise waits for a person until the business sets how large
 * one may be) and the ads strategy where it lands (C1–C7, the month for a budget raise, the strategy's own ACoS target
 * for a target raise), and only where Amazon's write gate lets the rule's own write through.
 */
describe('AA-W2-8 — budgets, placements and target ACoS run by rule only inside the limits and the ads strategy', { timeout: TIMEOUT }, () => {
  const room = { claudeMaxChangesPerDay: 20, claudeMaxRaisesPerDay: 5, claudeMaxBudgetIncreasePerDayCents: 1000 }
  const market = (extra: Record<string, unknown> = {}) => inside(() => db().adsStrategy.create({
    data: { market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', claudeAutonomy: { budget: 'auto', placement: 'auto', target: 'auto' }, ...room, ...extra, updatedBy: 'user:test' },
  }))
  async function setLimits(tool: string, limits: Record<string, unknown>) {
    const saved = await inside(() => setClaudeRule({ userId: ids.person, label: 'Stella Strategy', canManage: true }, tool, { limits, code: code() }))
    expect(saved, 'error' in saved ? saved.error : '').toMatchObject({ ok: true })
  }
  const budgetOf = async (id: string) => Math.round(Number((await inside(() => db().campaign.findUniqueOrThrow({ where: { id } }))).dailyBudget) * 100)
  /** A change the rule scheduled, its undo window over: the sweep's commit. */
  async function commitNow(approvalId: string) {
    await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
    return inside(() => commitScheduledApproval(approvalId))
  }

  it('a budget cut runs by rule: the preview carries the strategy facts and the rule\'s own reach', async () => {
    await setLevel('set-campaign-budget', 'auto')
    await market()
    const before = await budgetOf('c-it')
    const parked = (await call('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: before - 100, why: 'test cut' })).answer
    expect(parked).toMatchObject({ status: 'runs_by_rule' })
    const stored = (await approvalOf(parked.approvalId)).preview as Answer
    expect(stored).toMatchObject({
      ruleGate: null,
      limitFacts: { tool: 'set-campaign-budget', action: 'budget', this: { markets: ['IT'], items: 1, raises: 0, cuts: 1, budgetIncreaseCents: 0 }, markets: { IT: { strategy: { version: expect.any(String) } } } },
    })
    expect(stored.limitsNote).toEqual(expect.arrayContaining([expect.stringMatching(/^IT: ads strategy version /)]))
  })

  it('a raise waits for a person until the business sets how large one may be; past the month\'s cap it waits; inside both it runs; never twice a day on one campaign', async () => {
    await setLevel('set-campaign-budget', 'auto')
    const row = await market({ monthlySpendCapCents: 100 })
    const before = await budgetOf('c-it')
    const byDefault = (await call('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: before + 100 })).answer
    expect(byDefault).toMatchObject({ status: 'waiting_for_approval' })
    expect(byDefault.trust.why).toMatch(/its largest raise is [\d.]+ %, more than the 0 % this tool's limits let run without a person \(0: every raise waits for a person\)/)
    await setLimits('set-campaign-budget', { maxRaisePct: 50 })
    const pastCap = (await call('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: before + 100 })).answer
    expect(pastCap).toMatchObject({ status: 'waiting_for_approval' })
    expect(pastCap.trust.why).toMatch(/IT: this month could reach EUR [\d.,]+ with this change — .* above the monthly cap EUR 1\.00 \(ads strategy: Test market \(IT\)/)
    await inside(() => db().adsStrategy.update({ where: { id: row.id }, data: { monthlySpendCapCents: null, version: 2 } }))
    const inside1 = (await call('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: before + 100 })).answer
    expect(inside1).toMatchObject({ status: 'runs_by_rule' })
    const again = (await call('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: before + 200 })).answer
    expect(again).toMatchObject({ status: 'waiting_for_approval' })
    expect(again.trust.why).toMatch(/Claude already changed campaign "Italy exact" 1 time by rule in the last 24 hours, and this tool's limits allow 1 a day/)
  })

  it('the write gate binds a run by rule: off the live-write allowlist, a cut waits for a person (his own approval passes it)', async () => {
    await setLevel('set-campaign-budget', 'auto')
    await market()
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    try {
      const answer = (await call('set-campaign-budget', { campaignId: 'c-off', dailyBudgetCents: (await budgetOf('c-off')) - 100 })).answer
      expect(answer).toMatchObject({ status: 'waiting_for_approval' })
      expect(answer.trust.why).toMatch(/campaign "Italy not allowlisted": Amazon's write gate refuses it as a run by rule — .*allowlist/)
      expect(((await approvalOf(answer.approvalId)).preview as Answer).reach).toMatchObject({ reach: 'live' })
    } finally {
      vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'sandbox')
    }
  })

  it('placements: a raise waits for a person by default; a cut runs by rule', async () => {
    await setLevel('set-placement-multipliers', 'auto')
    await market()
    await inside(() => db().campaign.update({ where: { id: 'c-it' }, data: { dynamicBidding: { placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 50 }] } } }))
    const raise = (await call('set-placement-multipliers', { campaignId: 'c-it', topOfSearchPct: 60 })).answer
    expect(raise).toMatchObject({ status: 'waiting_for_approval' })
    expect(raise.trust.why).toMatch(/its largest raise is 10 points, more than the 0 points this tool's limits let run without a person/)
    const cut = (await call('set-placement-multipliers', { campaignId: 'c-it', topOfSearchPct: 30 })).answer
    expect(cut).toMatchObject({ status: 'runs_by_rule' })
    expect(((await approvalOf(cut.approvalId)).preview as Answer).limitFacts.this).toMatchObject({ items: 1, cuts: 1, largestCutPoints: 20, raises: 0 })
  })

  it('target ACoS: a cut runs by rule; a raise past the strategy\'s target, a first target larger than the limits or a cleared one waits', async () => {
    await setLevel('set-campaign-target-acos', 'auto')
    await market({ targetKind: 'ACOS', targetPct: 30 })
    await setLimits('set-campaign-target-acos', { maxRaisePoints: 10 })
    for (const id of ['c-it', 'c-off']) await inside(() => db().campaign.update({ where: { id }, data: { dynamicBidding: { targetAcos: 0.25 } } }))
    const cut = (await call('set-campaign-target-acos', { campaignIds: ['c-it'], targetAcosPct: 20, why: 'test cut' })).answer
    expect(cut).toMatchObject({ status: 'runs_by_rule' })
    // At commit it is judged again on a fresh dry run (AA-W2-3), runs, and the audit says the rule decided it.
    expect(await commitNow(cut.approvalId)).toMatchObject({ ok: true })
    expect((await inside(() => db().campaign.findUniqueOrThrow({ where: { id: 'c-it' } }))).dynamicBidding).toMatchObject({ targetAcos: 0.2 })
    const log = await inside(() => db().advertisingActionLog.findFirstOrThrow({ where: { entityId: 'c-it', actionType: 'set_campaign_goal' }, orderBy: { createdAt: 'desc' } }))
    expect(log).toMatchObject({ userId: `user:${ids.person}`, evidence: { note: `Claude request ${cut.approvalId} (run by rule): test cut — Nexus only: never sent to Amazon.` } })
    const past = (await call('set-campaign-target-acos', { campaignIds: ['c-off'], targetAcosPct: 34 })).answer
    expect(past).toMatchObject({ status: 'waiting_for_approval' })
    expect(past.trust.why).toMatch(/Italy not allowlisted: the new target ACoS 34% is above the 30% the ads strategy sets there \(ads strategy: Test market \(IT\)/)
    const cleared = (await call('set-campaign-target-acos', { targets: [{ campaignId: 'c-off', targetAcosPct: null }] })).answer
    expect(cleared.trust.why).toMatch(/Italy not allowlisted: its target ACoS is cleared, so Nexus's bid optimiser falls back to the business default, profit data or 30%/)
    const first = (await call('set-campaign-target-acos', { campaignIds: ['c-pin'], targetAcosPct: 25 })).answer
    expect(first.trust.why).toMatch(/its largest raise is 25 points, more than the 10 points this tool's limits let run without a person/)
    expect((await call('set-campaign-target-acos', { campaignIds: ['c-off'], targetAcosPct: 29 })).answer).toMatchObject({ status: 'runs_by_rule' })
  })
})

/**
 * AA-W2-9 — a stop, a restart, the live-write allowlist and an ad undo may run by rule too, each only inside its limits
 * and the ads strategy: a stop never on a protected product's campaign; a restart waits until the business sets the
 * highest bid one may put back, and its budget counts as a budget increase; on the allowlist only a campaign a Claude
 * request created, and taking one off is a brake.
 */
describe('AA-W2-9 — stop, restore and the allowlist run by rule only inside the limits and the ads strategy', { timeout: TIMEOUT }, () => {
  const room = { claudeMaxChangesPerDay: 20, claudeMaxRaisesPerDay: 5, claudeMaxBudgetIncreasePerDayCents: 1000 }
  const market = (claudeAutonomy: Record<string, string>, extra: Record<string, unknown> = {}) => inside(() => db().adsStrategy.create({
    data: { market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', claudeAutonomy, ...room, ...extra, updatedBy: 'user:test' },
  }))
  async function setLimits(tool: string, limits: Record<string, unknown>) {
    const saved = await inside(() => setClaudeRule({ userId: ids.person, label: 'Stella Strategy', canManage: true }, tool, { limits, code: code() }))
    expect(saved, 'error' in saved ? saved.error : '').toMatchObject({ ok: true })
  }

  it('a stop runs by rule; never the campaign of a product the strategy protects', async () => {
    // A campaign of its own (no change by rule today), advertising P1.
    await inside(async () => {
      await db().campaign.create({ data: { id: 'c-w9-stop', name: 'Italy stop by rule', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-w9-stop', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true } })
      await db().adGroup.create({ data: { id: 'g-w9-stop', campaignId: 'c-w9-stop', name: 'stop group', externalAdGroupId: 'EXT-g-w9-stop', defaultBidCents: 40 } })
      await db().adTarget.create({ data: { id: 't-w9-stop', adGroupId: 'g-w9-stop', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'stop by rule', bidCents: 55, externalTargetId: 'EXT-t-w9-stop' } })
      await db().adProductAd.create({ data: { adGroupId: 'g-w9-stop', productId: ids.p1, asin: 'B0TESTW9S1' } })
    })
    await setLevel('suppress-campaign', 'auto')
    await market({ stop: 'auto' })
    const guarded = await inside(() => db().adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: ids.p1, label: 'TEST-W18-P1 (IT)', protect: true, updatedBy: 'user:test' } }))
    const held = (await call('suppress-campaign', { campaignId: 'c-w9-stop' })).answer
    expect(held).toMatchObject({ status: 'waiting_for_approval' })
    expect(held.trust.why).toMatch(/the ads strategy protects a product it advertises \(ads strategy: TEST-W18-P1 \(IT\).*\), so lowering its bid waits for a person/)
    await inside(() => db().adsStrategy.delete({ where: { id: guarded.id } }))
    const stop = (await call('suppress-campaign', { campaignId: 'c-w9-stop' })).answer
    expect(stop).toMatchObject({ status: 'runs_by_rule' })
    // One change: the campaign's bids go down together, from the highest (55) to the stop bid.
    expect(((await approvalOf(stop.approvalId)).preview as Answer).limitFacts.this).toMatchObject({ items: 1, cuts: 1, raises: 0, largestCutPct: 96.36, highestNewBidCents: 2 })
  })

  it('a restore waits until the business sets the highest bid it may put back, and its budget counts as a budget increase', async () => {
    await inside(async () => {
      await db().campaign.update({ where: { id: 'c-off' }, data: { bidsSuppressedAt: new Date(), bidsSuppressedBy: `user:${ids.person}`, bidsSuppressedFloorCents: 2 } })
      await db().adTarget.updateMany({ where: { adGroup: { campaignId: 'c-off' }, isNegative: false }, data: { bidCents: 2, suppressedFromBidCents: 40 } })
    })
    await setLevel('restore-campaign', 'auto')
    const row = await market({ restore: 'auto' }, { claudeMaxBudgetIncreasePerDayCents: 5000 })
    const byDefault = (await call('restore-campaign', { campaignId: 'c-off' })).answer
    expect(byDefault).toMatchObject({ status: 'waiting_for_approval' })
    expect(byDefault.trust.why).toMatch(/its highest restored bid is EUR 0\.40, more than the EUR 0\.00 this tool's limits let run without a person \(0: every restore waits for a person\)/)
    await setLimits('restore-campaign', { maxRestoredBidCents: 50 })
    // Its daily budget spends again: a budget increase the market's daily limit by rule must hold.
    await inside(() => db().adsStrategy.update({ where: { id: row.id }, data: { claudeMaxBudgetIncreasePerDayCents: 1000, version: 2 } }))
    const budget = (await call('restore-campaign', { campaignId: 'c-off' })).answer
    expect(budget.trust.why).toMatch(/IT: .* and this adds EUR 20\.00 of daily budget, more than the EUR 10\.00 a day the ads strategy allows/)
    await inside(() => db().adsStrategy.update({ where: { id: row.id }, data: { claudeMaxBudgetIncreasePerDayCents: 5000, version: 3 } }))
    expect((await call('restore-campaign', { campaignId: 'c-off' })).answer).toMatchObject({ status: 'runs_by_rule' })
  })

  it('the allowlist: off is a brake and runs by rule; on only for a campaign a Claude request created, within the day\'s count', async () => {
    await setLevel('set-campaign-live-writes', 'auto')
    await market({ allowlist: 'auto' })
    expect((await call('set-campaign-live-writes', { campaignId: 'c-pin', enabled: false })).answer).toMatchObject({ status: 'runs_by_rule' })
    const notOurs = (await call('set-campaign-live-writes', { campaignId: 'c-off', enabled: true })).answer
    expect(notOurs).toMatchObject({ status: 'waiting_for_approval' })
    expect(notOurs.trust.why).toMatch(/only a campaign a Claude request created in this business goes on the live-write allowlist by rule \(allowAnyCampaign is off\)/)
    // As create-ad-campaign records it: the campaign a Claude request made (made up here).
    await inside(async () => {
      const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done' } })
      const made = await db().agentApproval.create({ data: { agentRunId: run.id, toolName: 'create-ad-campaign', riskTier: 'high', args: {}, status: 'executed', decidedAt: new Date() } })
      await db().agentChange.create({ data: { approvalId: made.id, toolName: 'create-ad-campaign', via: 'claude', reversibility: 'none', before: { campaignId: null }, after: { campaignId: 'c-off', name: 'Italy not allowlisted', market: 'IT' } } })
    })
    const zero = (await call('set-campaign-live-writes', { campaignId: 'c-off', enabled: true })).answer
    expect(zero.trust.why).toMatch(/this tool's limits let no campaign go on the live-write allowlist by rule \(maxCampaignsOnPerDay 0\)/)
    await setLimits('set-campaign-live-writes', { maxCampaignsOnPerDay: 1 })
    const on = (await call('set-campaign-live-writes', { campaignId: 'c-off', enabled: true })).answer
    expect(on).toMatchObject({ status: 'runs_by_rule' })
    expect(((await approvalOf(on.approvalId)).preview as Answer)).toMatchObject({ createdBy: { approvalId: expect.any(String) }, onByRuleToday: 0 })
  })

  it('on by rule also for a campaign one of Claude\'s builder tools made (its create carries the approval); never a playbook\'s', async () => {
    await setLevel('set-campaign-live-writes', 'auto')
    await market({ allowlist: 'auto' })
    await setLimits('set-campaign-live-writes', { maxCampaignsOnPerDay: 5 })
    await inside(async () => {
      const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done' } })
      for (const [id, tool] of [['c-built', 'build-sp-wizard-campaigns'], ['c-pb-built', 'apply-ads-playbook']] as const) {
        await db().campaign.create({ data: { id, name: `Italy ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: false } })
        const made = await db().agentApproval.create({ data: { agentRunId: run.id, toolName: tool, riskTier: 'high', args: {}, status: 'executed', decidedAt: new Date() } })
        await db().agentChange.create({ data: { approvalId: made.id, toolName: tool, via: 'claude', reversibility: 'none', before: {}, after: { applicationId: `run-${id}` } } })
        // As every builder's create logs it: the campaign's create carries the approval as its change set.
        await db().advertisingActionLog.create({ data: { executionId: made.id, actionType: 'create_campaign', entityType: 'CAMPAIGN', entityId: id, payloadBefore: {}, payloadAfter: {} } })
      }
    })
    const built = (await call('set-campaign-live-writes', { campaignId: 'c-built', enabled: true })).answer
    expect(built).toMatchObject({ status: 'runs_by_rule' })
    expect(((await approvalOf(built.approvalId)).preview as Answer)).toMatchObject({ createdBy: { approvalId: expect.any(String) } })
    // A playbook's campaign goes live only with its START (the approver's code): never on by rule here.
    const playbook = (await call('set-campaign-live-writes', { campaignId: 'c-pb-built', enabled: true })).answer
    expect(playbook).toMatchObject({ status: 'waiting_for_approval' })
    expect(playbook.trust.why).toMatch(/only a campaign a Claude request created in this business goes on the live-write allowlist by rule/)
  })
})
