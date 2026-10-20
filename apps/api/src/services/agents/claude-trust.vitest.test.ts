/**
 * MCP full control C5 — trust levels and limits for Claude, per business and per tool, and Claude's brakes.
 *
 * Proven through Claude's own door (runToolForClaude → the gate → the Approvals sweep's commit), on a real PostgreSQL
 * with the production schema and business policies (PGlite). The master price service is real; nothing is sent to a
 * marketplace from here.
 *
 *   no rows     every change waits for a person, exactly as before C5 (level ask)
 *   auto        inside the tool's limits and with the connection's nexus.run scope, a change is scheduled by the
 *               business's rule, as the person who asked (decisionVia auto), and the normal commit runs it after the
 *               undo window; outside them, or without the scope, it waits for a person and Claude is told why
 *   off         the tool is refused (and hidden from tools/list)
 *   ceilings    a level above the tool's code ceiling is read as the ceiling, and cannot be saved
 *   brakes      the daily cap, Pause (instant: what waits to run by rule goes back to a person), the level lowered in
 *               the window, and the automatic pause after 5 stale or failed rule-runs in an hour
 *   raising     needs settings.security.manage (the routes); no authenticator code since 2026-10-12 (Owner, "B");
 *               lowering does not
 *   businesses  one business's level never applies in another
 *   watch       AA-W2-4 — the full check auto would make runs and its verdict is recorded on the request; it is never
 *               scheduled: a person decides it (as at confirm); the cap counts the watched changes that would have run;
 *               offered only below an auto ceiling and never for a brake; raising to it takes settings.security.manage
 *   no approval NA — with "Claude's changes need no approval" on, every change (a plan too) is scheduled as the person who
 *               asked (decisionVia no-approval), whatever its kind's level or ceiling, and runs as approved by a person;
 *               off, Pause, no nexus.run, a raise that asks for a code and a kind set to off keep today's answer; off,
 *               Pause or the kind set to off inside the window hands it back (a plan: at commit and before each step);
 *               turning it on takes settings.security.manage, off does not
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecret, generateSync } from 'otplib'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
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
vi.mock('../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, agentPlanQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import { __stepUpTest } from '../../lib/auth/step-up.js'
import { commitScheduledApproval, UNDO_WINDOW_MS } from '../agent-fleet/approval-inbox.service.js'
import type { McpPrincipal } from '../mcp/mcp-auth.js'
import { runToolForClaude } from '../mcp/mcp-tool-call.js'
import { getTool } from './tool-registry.js'
import { z } from 'zod'
import type { AgentTool, ToolContext } from './tool-types.js'
import { runPlan } from './change-plan.service.js'
import { dailyRefusal, LIMIT_FACTS_VERSION, limitFactsOf } from './tools/ads-autonomy-kit.js'
import {
  AUTO_PAUSE_FAILURES,
  AUTO_PAUSE_NOTICE_TYPE,
  limitsTighten,
  claudeOffTools,
  claudeRuleOf,
  levelsFor,
  listClaudeRules,
  pauseAutoRuns,
  resumeAutoRuns,
  setClaudeRule,
  setDailyAutoCap,
  setNoApproval,
  watchedRunsInLastDay,
} from './claude-trust.service.js'

const A = LEGACY_WORKSPACE_ID
const B = 'c5_trust_bravo'
const TIMEOUT = 30_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const db = () => database.client

const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = { person: '', productA: '', productB: '', stale: '' }
let secret = ''
const names = { A: '', B: 'Bravo trust business' }

/** The person, as Claude's door sees them: a token's business, permissions and scopes. */
function claude(workspaceId = A, scopes: string[] = ['nexus.read', 'nexus.write', 'nexus.run']): McpPrincipal {
  return {
    kind: 'user',
    userId: ids.person,
    label: 'Tara Trust',
    permissions: { isOwner: false, permissions: EVERYTHING },
    workspace: business(workspaceId),
    business: { id: workspaceId, name: workspaceId === A ? names.A : names.B },
    via: 'claude',
    oauthGrantId: `grant-${workspaceId}`,
    scopes,
  } as McpPrincipal
}
/** A person who manages security settings (may raise); `brake` = one who may only use Claude here (may lower and pause). */
const actor = () => ({ userId: ids.person, label: 'Tara Trust', canManage: true })
const brake = () => ({ userId: ids.person, label: 'Tara Trust', canManage: false })
const code = () => {
  __stepUpTest.reset()
  return generateSync({ secret })
}

/** One tools/call as Claude makes it, and the JSON Claude reads. */
async function call(tool: string, args: Record<string, unknown>, who = claude()) {
  const result = await runToolForClaude(who, getTool(tool)!, { ...args, business: who.business.name })
  return { isError: !!result.isError, answer: JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join('')) }
}

const approvalOf = (id: string, workspaceId = A) => inside(() => db().agentApproval.findUniqueOrThrow({ where: { id } }), workspaceId)
const priceOf = async (id: string, workspaceId = A) => inside(async () => Number((await db().product.findUniqueOrThrow({ where: { id } })).basePrice), workspaceId)
const setPriceDirectly = (id: string, price: string) => inside(() => db().product.update({ where: { id }, data: { basePrice: price } }))
/** The window closes: what the sweep then does. */
async function windowCloses(approvalId: string) {
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}
/** Set a level (and limits) the way the Settings page does, as a person who may raise. */
async function setLevel(tool: string, level: string, limits?: Record<string, unknown> | null, workspaceId = A) {
  const saved = await inside(() => setClaudeRule(actor(), tool, { level, ...(limits !== undefined ? { limits } : {}) }), workspaceId)
  expect(saved, 'error' in saved ? saved.error : '').toMatchObject({ ok: true })
}
const resetRules = () => inside(async () => {
  await db().agentTool.deleteMany({})
  await db().agentAutonomy.deleteMany({})
})

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const client = database.client
  secret = generateSecret()
  const role = await client.role.create({
    data: { key: `C5_TRUST_${randomUUID().slice(0, 8)}`, name: 'Trust tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] },
  })
  const person = await client.userProfile.create({
    data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Tara Trust', twoFactorEnabledAt: new Date(), twoFactorSecret: secret },
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
    ids.productA = (await client.product.create({ data: { sku: 'TEST-TRUST-1', name: 'Trust jacket', basePrice: '100.00' } })).id
    ids.stale = (await client.product.create({ data: { sku: 'TEST-TRUST-STALE', name: 'Stale jacket', basePrice: '100.00' } })).id
  })
  await inside(async () => {
    // The same SKU in the other business (shared stock by SKU): its own row, its own rules.
    ids.productB = (await client.product.create({ data: { sku: 'TEST-TRUST-1', name: 'Bravo trust jacket', basePrice: '100.00' } })).id
  }, B)
}, 120_000)

beforeEach(async () => {
  __stepUpTest.reset()
  await resetRules()
  await inside(async () => { await db().agentAutonomy.deleteMany({}); await db().agentTool.deleteMany({}) }, B)
  // What an earlier test left waiting to run by rule is not this test's: set it aside.
  for (const workspaceId of [A, B]) {
    await inside(() => db().agentApproval.updateMany({ where: { status: 'scheduled' }, data: { status: 'rejected', decisionVia: null } }), workspaceId)
  }
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('C5 — with no rows, a change from Claude waits for a person, exactly as before', { timeout: TIMEOUT }, () => {
  it('set-price: queued, nobody decided, and Claude is told nothing new', async () => {
    const { answer } = await call('set-price', { productId: ids.productA, price: 101 })
    expect(answer).toMatchObject({ status: 'waiting_for_approval', approvalId: expect.any(String) })
    expect(answer).not.toHaveProperty('trust')
    expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null, decidedByUserId: null })
    expect(await inside(() => claudeRuleOf('set-price'))).toMatchObject({ level: 'ask', ceiling: 'auto' })
  })
})

describe('C5 — auto: runs by the business’s rule, inside the limits, through the normal window and commit', { timeout: TIMEOUT }, () => {
  it('inside the limits: scheduled as the person who asked (decisionVia auto); after the window it runs as them', async () => {
    await setLevel('set-price', 'auto')
    const before = await priceOf(ids.productA)
    const { answer } = await call('set-price', { productId: ids.productA, price: before + 5 })
    expect(answer).toMatchObject({ status: 'runs_by_rule', approvalId: expect.any(String), trust: { level: 'auto' } })
    const parked = await approvalOf(answer.approvalId)
    expect(parked).toMatchObject({ status: 'scheduled', decisionVia: 'auto', decidedByUserId: ids.person, decidedBy: 'Tara Trust' })
    expect(parked.executeAfter!.getTime() - parked.decidedAt!.getTime()).toBeCloseTo(UNDO_WINDOW_MS, -3)
    expect(new Date(answer.runsAt).getTime()).toBe(parked.executeAfter!.getTime())
    expect(await priceOf(ids.productA)).toBe(before) // nothing inside the window

    expect(await windowCloses(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await priceOf(ids.productA)).toBe(before + 5)
    const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId: answer.approvalId } }))
    expect(change).toMatchObject({ via: 'claude', executedByUserId: ids.person })
    expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'executed', decisionVia: 'auto' })
  })

  it('outside the limits it waits for a person, and Claude is told why; the business’s own limits move the line', async () => {
    await setLevel('set-price', 'auto')
    const before = await priceOf(ids.productA)
    const far = await call('set-price', { productId: ids.productA, price: Math.round(before * 1.5) })
    expect(far.answer).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'auto', why: expect.stringMatching(/moves [\d.]+ %, more than the 10 % allowed without a person; a person approves it in Nexus$/) } })
    expect(await approvalOf(far.answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null })
    await setLevel('set-price', 'auto', { maxChangePercent: 60 })
    const allowed = await call('set-price', { productId: ids.productA, price: Math.round(before * 1.5) })
    expect(allowed.answer.status).toBe('runs_by_rule')
  })

  it('a connection without nexus.run: every change waits for a person', async () => {
    await setLevel('set-price', 'auto')
    const { answer } = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 }, claude(A, ['nexus.read', 'nexus.write']))
    expect(answer).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'auto', why: expect.stringContaining('nexus.run') } })
    expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'pending' })
  })

  it('confirm waits for a person until confirm-change exists, and says so', async () => {
    await setLevel('set-price', 'confirm')
    const { answer } = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 })
    expect(answer).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'confirm', why: expect.stringContaining('Nexus') } })
  })

  it('undo-change follows the level of the change it asks for', async () => {
    await setLevel('set-price', 'auto')
    const before = await priceOf(ids.productA)
    const ran = await call('set-price', { productId: ids.productA, price: before + 2 })
    await windowCloses(ran.answer.approvalId)
    const undo = await call('undo-change', { approvalId: ran.answer.approvalId })
    expect(undo.answer).toMatchObject({ status: 'runs_by_rule', undoes: { changeId: expect.any(String) } })
    expect(await windowCloses(undo.answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await priceOf(ids.productA)).toBe(before)
  })

  it('one business’s rule never applies in the other, for the same SKU', async () => {
    await setLevel('set-price', 'auto')
    const inB = await inside(() => call('set-price', { productId: ids.productB, price: 101 }, claude(B)), B)
    expect(inB.answer).toMatchObject({ business: { id: B }, status: 'waiting_for_approval' })
    expect(inB.answer).not.toHaveProperty('trust')
    expect(await inside(() => claudeRuleOf('set-price'), B)).toMatchObject({ level: 'ask' })
  })
})

describe('C5 — off and the ceilings', { timeout: TIMEOUT }, () => {
  it('off: refused before anything runs, nothing queued, and left out of the tool list', async () => {
    const saved = await inside(() => setClaudeRule(actor(), 'set-price', { level: 'off' })) // lowering: no code
    expect(saved).toMatchObject({ ok: true })
    const pending = () => inside(() => db().agentApproval.count({ where: { toolName: 'set-price', status: 'pending' } }))
    const start = await pending()
    const { isError, answer } = await call('set-price', { productId: ids.productA, price: 101 })
    expect(isError).toBe(true)
    expect(answer.error).toBe(`set-price is turned off for Claude in ${names.A}. Nothing was queued.`)
    expect(await pending()).toBe(start)
    expect(await inside(() => claudeOffTools())).toEqual(new Set(['set-price']))
    expect(await inside(() => claudeOffTools(), B)).toEqual(new Set())
  })

  it('a level above the tool’s ceiling cannot be saved, and a stored one is read as the ceiling', async () => {
    const message = getTool('send-customer-message')!
    expect(message.maxClaudeTrust).toBe('ask')
    const refused = await inside(() => setClaudeRule(actor(), 'send-customer-message', { level: 'auto' }))
    expect(refused).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('ask at most') })
    const read = await inside(() => setClaudeRule(actor(), 'product-search', { level: 'auto' }))
    expect(read).toMatchObject({ ok: false, status: 400 })
    // Written straight into the row (an older release, a hand edit): still ask.
    await inside(() => db().agentTool.create({ data: { name: 'send-customer-message', riskTier: 'high', requiresApproval: true, claudeTrust: 'auto' } }))
    expect(await inside(() => claudeRuleOf('send-customer-message'))).toMatchObject({ level: 'ask', stored: 'auto', ceiling: 'ask' })
  })
})

describe('C5 — raising takes settings.security.manage, no authenticator code (Owner "B", 2026-10-12); every change is audited', { timeout: TIMEOUT }, () => {
  it('raising by a person who may raise: saved and audited, no code asked', async () => {
    expect(await inside(() => claudeRuleOf('set-price'))).toMatchObject({ level: 'ask' })
    const saved = await inside(() => setClaudeRule(actor(), 'set-price', { level: 'auto' }))
    expect(saved).toMatchObject({ ok: true, rule: { level: 'auto' } })
    const audit = await inside(() => db().agentControlAudit.findFirstOrThrow({ where: { charterKey: 'claude', action: 'policy' }, orderBy: { createdAt: 'desc' } }))
    expect(audit).toMatchObject({ actor: 'Tara Trust', fromValue: { tool: 'set-price', level: 'ask' }, toValue: { tool: 'set-price', level: 'auto' } })
  })

  it('limits: checked against the tool’s own schema; a looser one saves for a person who may raise', async () => {
    await setLevel('set-price', 'auto')
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { limits: { maxChangePercent: 500 } }))).toMatchObject({ ok: false, status: 400 })
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { limits: { maxChangePercent: 5, extra: 1 } }))).toMatchObject({ ok: false, status: 400 })
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { limits: { maxChangePercent: 15 } }))).toMatchObject({ ok: true, rule: { limits: { maxChangePercent: 15 } } })
  })

  it('raising a level and loosening its limits in one call, even for a kind that cannot be undone (no second code any more)', async () => {
    expect(getTool('archive-ads')!.reversibility).toBe('none')
    const saved = await inside(() => setClaudeRule(actor(), 'archive-ads', { level: 'auto', limits: { maxItems: 1 } }))
    expect(saved).toMatchObject({ ok: true, rule: { level: 'auto', limits: { maxItems: 1 } } })
    expect(await inside(() => setClaudeRule(actor(), 'archive-ads', { level: 'ask', limits: null }))).toMatchObject({ ok: true })
  })

  it('lowering needs no code', async () => {
    await setLevel('set-price', 'auto')
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { level: 'ask' }))).toMatchObject({ ok: true, rule: { level: 'ask' } })
  })

  it('the rules list: every Claude tool, its level, ceiling and limits, and the business’s brakes', async () => {
    await setLevel('set-price', 'auto')
    const view = await inside(() => listClaudeRules())
    expect(view.autonomy).toMatchObject({ paused: false, dailyAutoCap: 200 })
    const setPrice = view.tools.find((t) => t.name === 'set-price')!
    expect(setPrice).toMatchObject({ level: 'auto', ceiling: 'auto', levels: ['off', 'ask', 'confirm', 'watch', 'auto'], limits: { maxChangePercent: 10 }, defaultLimits: { maxChangePercent: 10 } })
    expect(setPrice.limitsSchema).toMatchObject({ type: 'object', properties: { maxChangePercent: expect.any(Object) } })
    expect(view.tools.find((t) => t.name === 'product-search')).toMatchObject({ level: 'ask', levels: ['off', 'ask'] })
    expect(view.tools.find((t) => t.name === 'send-customer-message')).toMatchObject({ ceiling: 'ask', levels: ['off', 'ask'] })
    expect(view.tools.some((t) => t.name === 'draft-seo')).toBe(false) // not offered to Claude
  })
})

describe('C5 — a brake is easy: anyone who may use Claude here lowers and pauses; raising needs settings.security.manage', { timeout: TIMEOUT }, () => {
  it('lowering a level, lowering the cap and Pause need no more than that', async () => {
    await setLevel('set-price', 'auto')
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { level: 'ask' }))).toMatchObject({ ok: true, rule: { level: 'ask' } })
    expect(await inside(() => setDailyAutoCap(brake(), { dailyAutoCap: 50 }))).toMatchObject({ ok: true, dailyAutoCap: 50 })
    expect(await inside(() => pauseAutoRuns(brake(), 'stop'))).toMatchObject({ ok: true, paused: true })
  })

  it('raising a level, loosening limits, raising the cap or Resume: refused without it', async () => {
    const forbidden = { ok: false, status: 403, code: 'forbidden', error: expect.stringContaining('settings.security.manage') }
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { level: 'auto' }))).toMatchObject(forbidden)
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { limits: { maxChangePercent: 15 } }))).toMatchObject(forbidden)
    expect(await inside(() => setDailyAutoCap(brake(), { dailyAutoCap: 500 }))).toMatchObject(forbidden)
    await inside(() => pauseAutoRuns(brake(), 'stop'))
    expect(await inside(() => resumeAutoRuns(brake()))).toMatchObject(forbidden)
    expect(await inside(() => claudeRuleOf('set-price'))).toMatchObject({ level: 'ask' })
  })
})

describe('C5 — tightening a limit is a brake too; loosening one needs settings.security.manage', { timeout: TIMEOUT }, () => {
  it('a smaller max, a shorter list of what is allowed: no code, no permission beyond using Claude', async () => {
    await setLevel('set-price', 'auto')
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { limits: { maxChangePercent: 5 } }))).toMatchObject({ ok: true, rule: { limits: { maxChangePercent: 5 } } })
    expect(await inside(() => setClaudeRule(brake(), 'bulk-price-change', { limits: { maxProducts: 10, maxChangePercent: 10 } }))).toMatchObject({ ok: true })
    expect(await inside(() => setClaudeRule(brake(), 'apply-content', { limits: { fields: ['title'] } }))).toMatchObject({ ok: true, rule: { limits: { fields: ['title'] } } })
    const audit = await inside(() => db().agentControlAudit.findFirstOrThrow({ where: { charterKey: 'claude', action: 'policy' }, orderBy: { createdAt: 'desc' } }))
    expect(audit.toValue).toMatchObject({ tool: 'apply-content', limits: { fields: ['title'] } })
  })

  it('a larger max, a longer list, back to looser defaults, or one looser among tighter: settings.security.manage', async () => {
    const forbidden = { ok: false, status: 403, code: 'forbidden' }
    await inside(() => setClaudeRule(brake(), 'set-price', { limits: { maxChangePercent: 5 } }))
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { limits: { maxChangePercent: 8 } }))).toMatchObject(forbidden)
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { limits: null }))).toMatchObject(forbidden) // the default, 10, is looser
    expect(await inside(() => setClaudeRule(brake(), 'bulk-price-change', { limits: { maxProducts: 10, maxChangePercent: 20 } }))).toMatchObject(forbidden)
    await inside(() => setClaudeRule(brake(), 'apply-content', { limits: { fields: ['title'] } }))
    expect(await inside(() => setClaudeRule(brake(), 'apply-content', { limits: { fields: ['title', 'description'] } }))).toMatchObject(forbidden)
    // The person who may raise loosens it: no code.
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { limits: { maxChangePercent: 8 } }))).toMatchObject({ ok: true })
  })

  it('the direction of every kind of limit: max lower, min higher, allow off, a max level earlier, the allowed list smaller; anything else loosens', () => {
    const tool = {
      name: 'example-limits',
      limits: z.object({
        maxUnits: z.number().default(10).describe('x'),
        minMargin: z.number().default(5).describe('x'),
        allowNew: z.boolean().default(true).describe('x'),
        maxLevel: z.enum(['OBSERVE', 'PROPOSE', 'AUTO']).default('PROPOSE').describe('x'),
        fields: z.array(z.enum(['a', 'b', 'c'])).default(['a', 'b']).describe('x'),
        note: z.string().default('x').describe('x'),
      }),
    } as unknown as AgentTool
    const base = { maxUnits: 10, minMargin: 5, allowNew: true, maxLevel: 'PROPOSE', fields: ['a', 'b'], note: 'x' }
    expect(limitsTighten(tool, base, base)).toBe(true)
    expect(limitsTighten(tool, base, { ...base, maxUnits: 5, minMargin: 8, allowNew: false, maxLevel: 'OBSERVE', fields: ['a'] })).toBe(true)
    for (const looser of [{ maxUnits: 11 }, { minMargin: 4 }, { maxLevel: 'AUTO' }, { fields: ['a', 'c'] }, { note: 'y' }]) {
      expect(limitsTighten(tool, base, { ...base, ...looser }), JSON.stringify(looser)).toBe(false)
    }
    expect(limitsTighten(tool, { ...base, allowNew: false }, base)).toBe(false)
  })
})

describe('C5 — the brakes', { timeout: TIMEOUT }, () => {
  it('the daily cap: once reached, the next change waits for a person', async () => {
    await setLevel('set-price', 'auto')
    const first = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 })
    expect(first.answer.status).toBe('runs_by_rule')
    const used = (await inside(() => listClaudeRules())).autonomy.autoRunsLastDay
    expect(await inside(() => setDailyAutoCap(actor(), { dailyAutoCap: used }))).toMatchObject({ ok: true }) // lowering: no code
    const second = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 2 })
    expect(second.answer).toMatchObject({ status: 'waiting_for_approval', trust: { why: expect.stringContaining(`${used} changes run by rule in 24 hours`) } })
    // Raising it back takes settings.security.manage, no code.
    expect(await inside(() => setDailyAutoCap(brake(), { dailyAutoCap: 200 }))).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await inside(() => setDailyAutoCap(actor(), { dailyAutoCap: 200 }))).toMatchObject({ ok: true })
  })

  it('Pause: at once, what waits to run by rule goes back to a person, and new ones wait; Resume takes settings.security.manage', async () => {
    await setLevel('set-price', 'auto')
    const parked = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 })
    expect(parked.answer.status).toBe('runs_by_rule')
    expect(await inside(() => pauseAutoRuns(actor(), 'checking prices'))).toMatchObject({ ok: true, handedBack: 1 })
    expect(await approvalOf(parked.answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null, executeAfter: null, reason: expect.stringContaining('paused') })
    const next = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 })
    expect(next.answer).toMatchObject({ status: 'waiting_for_approval', trust: { why: expect.stringContaining('paused') } })
    expect((await inside(() => listClaudeRules())).autonomy).toMatchObject({ paused: true, pausedBy: 'Tara Trust', reason: 'checking prices' })

    expect(await inside(() => resumeAutoRuns(brake()))).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await inside(() => resumeAutoRuns(actor()))).toMatchObject({ ok: true })
    expect((await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 })).answer.status).toBe('runs_by_rule')
  })

  it('a level lowered inside the window: the change goes back to a person instead of running', async () => {
    await setLevel('set-price', 'auto')
    const before = await priceOf(ids.productA)
    const parked = await call('set-price', { productId: ids.productA, price: before + 1 })
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { level: 'ask' }))).toMatchObject({ ok: true })
    const out = await windowCloses(parked.answer.approvalId)
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('no longer') })
    expect(await approvalOf(parked.answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null })
    expect(await priceOf(ids.productA)).toBe(before)
  })

  it(`after ${AUTO_PAUSE_FAILURES} stale rule-runs in an hour, Nexus pauses Claude’s rule-runs itself`, async () => {
    await setLevel('set-price', 'auto')
    for (let i = 0; i < AUTO_PAUSE_FAILURES; i++) {
      const price = await priceOf(ids.stale)
      const parked = await call('set-price', { productId: ids.stale, price: price + 1 })
      expect(parked.answer.status, `run ${i + 1}`).toBe('runs_by_rule')
      await setPriceDirectly(ids.stale, String(price + 0.5)) // someone else moved it inside the window
      expect(await windowCloses(parked.answer.approvalId)).toMatchObject({ ok: false })
      expect(await approvalOf(parked.answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null })
    }
    const autonomy = (await inside(() => listClaudeRules())).autonomy
    expect(autonomy).toMatchObject({ paused: true, pausedBy: 'Nexus', reason: expect.stringContaining(`${AUTO_PAUSE_FAILURES}`) })
    // W4-2 — the Owner hears it at once: a danger notice in the business's bell (its event alone tells no one).
    const notices = await inside(() => database.client.notification.findMany({ where: { type: AUTO_PAUSE_NOTICE_TYPE } }))
    expect(notices.length).toBeGreaterThan(0)
    expect(notices.every((n) => n.severity === 'danger' && n.href === '/settings/ai/claude')).toBe(true)
    expect(notices[0].body).toContain(`${AUTO_PAUSE_FAILURES} changes run by rule were stale or failed within an hour`)
    expect(await inside(() => database.client.notification.count({ where: { type: AUTO_PAUSE_NOTICE_TYPE } }), B)).toBe(0)
    const next = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 })
    expect(next.answer.status).toBe('waiting_for_approval')
    // The other business is not paused.
    expect((await inside(() => listClaudeRules(), B)).autonomy.paused).toBe(false)
  })
})

describe('AA-W2-4 — watch: the full check auto would make, recorded on the request; a person still decides', { timeout: TIMEOUT }, () => {
  const verdictOf = async (approvalId: string, workspaceId = A) => (await approvalOf(approvalId, workspaceId)).ruleVerdict

  it('inside the limits: never scheduled, recorded as "would have run"; the person who asked may confirm it with their code', async () => {
    await setLevel('set-price', 'watch')
    const before = await priceOf(ids.productA)
    const { answer } = await call('set-price', { productId: ids.productA, price: before + 1 })
    expect(answer).toMatchObject({
      status: 'waiting_for_approval',
      trust: { level: 'watch', why: expect.stringMatching(/^watching: it would have run by rule; the person who asked types their authenticator code/), watch: { wouldRun: true, check: null, why: null } },
      confirm: { planHash: expect.any(String) },
    })
    expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null, executeAfter: null })
    expect(await verdictOf(answer.approvalId)).toEqual({ level: 'watch', wouldRun: true, check: null, why: null, checkedAt: expect.any(String), changes: 1 })
    expect(await priceOf(ids.productA)).toBe(before)
    // As at confirm: confirmed with the asker's code, it runs as theirs through the normal window.
    const confirmed = await call('confirm-change', { approvalId: answer.approvalId, planHash: answer.confirm.planHash, code: code() })
    expect(confirmed.answer).toMatchObject({ status: 'confirmed' })
    expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'scheduled', decisionVia: 'claude-confirm' })
    expect(await windowCloses(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await priceOf(ids.productA)).toBe(before + 1)
  })

  it('outside the limits, without nexus.run, under Pause: recorded with the check that held it; a person decides', async () => {
    await setLevel('set-price', 'watch')
    const before = await priceOf(ids.productA)
    const far = await call('set-price', { productId: ids.productA, price: Math.round(before * 1.5) })
    expect(far.answer).toMatchObject({ trust: { level: 'watch', watch: { wouldRun: false, check: 'limits', why: expect.stringMatching(/more than the 10 % allowed without a person$/) } } })
    expect(far.answer.trust.why).toMatch(/^watching: it would not — the master price moves [\d.]+ %, more than the 10 % allowed without a person; the person who asked types/)
    expect(await verdictOf(far.answer.approvalId)).toMatchObject({ level: 'watch', wouldRun: false, check: 'limits' })

    // W4-5 (lead decision) — without nexus.run a watched change is judged as if the connection had it; the scope is
    // recorded beside the verdict, not as its check.
    const noScope = await call('set-price', { productId: ids.productA, price: before + 1 }, claude(A, ['nexus.read', 'nexus.write']))
    expect(noScope.answer).toMatchObject({
      trust: {
        level: 'watch',
        why: expect.stringMatching(/^watching: it would have run by rule \(judged as if this connection may run changes by rule; it was connected without nexus\.run\); a person approves it in Nexus$/),
        watch: { wouldRun: true, check: null, scope: 'no-run-by-rule' },
      },
    })
    expect(noScope.answer).not.toHaveProperty('confirm')
    expect(await verdictOf(noScope.answer.approvalId)).toMatchObject({ wouldRun: true, check: null, scope: 'no-run-by-rule' })
    // Far outside the limits, the same connection: the limits hold it, and the scope is still beside it.
    const noScopeFar = await call('set-price', { productId: ids.productA, price: Math.round(before * 1.5) }, claude(A, ['nexus.read', 'nexus.write']))
    expect(noScopeFar.answer.trust.watch).toMatchObject({ wouldRun: false, check: 'limits', scope: 'no-run-by-rule' })

    await inside(() => pauseAutoRuns(actor(), 'watch week'))
    const paused = await call('set-price', { productId: ids.productA, price: before + 1 })
    expect(paused.answer).toMatchObject({ trust: { watch: { wouldRun: false, check: 'pause', why: expect.stringContaining('(watch week)') } } })
    for (const id of [far.answer.approvalId, noScope.answer.approvalId, paused.answer.approvalId]) {
      expect(await approvalOf(id)).toMatchObject({ status: 'pending', decisionVia: null, executeAfter: null })
    }
  })

  it('W4-5: a watched plan without nexus.run is judged as if the connection had it; a real verdict (auto) still needs nexus.run', async () => {
    await setLevel('set-price', 'watch')
    const step = async () => ({ tool: 'set-price', args: { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 } })
    const watched = await call('submit-change-plan', { title: 'A watched plan', steps: [await step()] }, claude(A, ['nexus.read', 'nexus.write']))
    expect(watched.answer).toMatchObject({ trust: { level: 'watch', watch: { wouldRun: true, check: null, scope: 'no-run-by-rule' } } })
    expect(await verdictOf(watched.answer.approvalId)).toMatchObject({
      wouldRun: true, check: null, scope: 'no-run-by-rule', steps: [{ step: 1, tool: 'set-price', watched: true, wouldRun: true, check: null }],
    })
    // At auto nothing changed: without nexus.run the change waits for a person, a single request and a plan alike.
    await setLevel('set-price', 'auto')
    const single = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 }, claude(A, ['nexus.read', 'nexus.write']))
    expect(single.answer).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'auto', why: expect.stringContaining('nexus.run') } })
    expect(single.answer.trust).not.toHaveProperty('watch')
    const plan = await call('submit-change-plan', { title: 'An auto plan', steps: [await step()] }, claude(A, ['nexus.read', 'nexus.write']))
    expect(plan.answer).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'auto', why: expect.stringContaining('nexus.run') } })
    for (const id of [single.answer.approvalId, plan.answer.approvalId]) expect(await verdictOf(id)).toBeNull()
  })

  it('the daily cap counts the watched changes that would have run, as if their kinds were at auto', async () => {
    await setLevel('set-price', 'watch')
    const first = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 })
    expect(first.answer.trust.watch).toMatchObject({ wouldRun: true })
    const used = (await inside(() => listClaudeRules())).autonomy.autoRunsLastDay + await inside(() => watchedRunsInLastDay())
    expect(used).toBeGreaterThan(0)
    expect(await inside(() => setDailyAutoCap(actor(), { dailyAutoCap: used }))).toMatchObject({ ok: true }) // lowering: no code
    const second = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 })
    expect(second.answer.trust.watch).toEqual({ wouldRun: false, check: 'cap', why: `this business's limit of ${used} changes run by rule in 24 hours is reached` })
  })

  it('levels: watch sits between confirm and auto, only below an auto ceiling and never for a brake', async () => {
    expect(levelsFor(getTool('set-price')!)).toEqual(['off', 'ask', 'confirm', 'watch', 'auto'])
    for (const brake of ['stop-automation', 'turn-down-automation', 'set-ad-guardrail']) {
      expect(levelsFor(getTool(brake)!), brake).toEqual(['off', 'ask', 'confirm', 'auto'])
    }
    // AA-W2-11 — a tool whose ceiling is confirm (turn-up-automation, the earlier example, may now run by rule).
    expect(levelsFor(getTool('steer-fleet')!)).toEqual(['off', 'ask', 'confirm'])
    expect(await inside(() => setClaudeRule(actor(), 'stop-automation', { level: 'watch' })))
      .toMatchObject({ ok: false, status: 400, error: 'stop-automation cannot be watched: it is a brake, so it runs by rule or waits for a person.' })
    expect(await inside(() => setClaudeRule(actor(), 'steer-fleet', { level: 'watch' })))
      .toMatchObject({ ok: false, status: 400, error: 'steer-fleet cannot be watched: only a kind that may run by rule (auto) can be.' })
    // Written straight into the row (a hand edit): a watch the tool does not allow reads as the level below it.
    await inside(() => db().agentTool.create({ data: { name: 'steer-fleet', riskTier: 'medium', requiresApproval: true, claudeTrust: 'watch' } }))
    expect(await inside(() => claudeRuleOf('steer-fleet'))).toMatchObject({ level: 'confirm', stored: 'watch', ceiling: 'confirm' })
    expect((await inside(() => listClaudeRules())).tools.find((t) => t.name === 'stop-automation')).toMatchObject({ ceiling: 'auto', levels: ['off', 'ask', 'confirm', 'auto'] })
  })

  it('raising to watch takes settings.security.manage; auto → watch is a free brake; watch → auto a raise', async () => {
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { level: 'watch' }))).toMatchObject({ ok: false, code: 'forbidden' })
    await setLevel('set-price', 'confirm')
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { level: 'watch' }))).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { level: 'watch' }))).toMatchObject({ ok: true, rule: { level: 'watch' } })
    await setLevel('set-price', 'auto')
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { level: 'watch' }))).toMatchObject({ ok: true, rule: { level: 'watch' } })
    const audit = await inside(() => db().agentControlAudit.findFirstOrThrow({ where: { charterKey: 'claude', action: 'policy' }, orderBy: { createdAt: 'desc' } }))
    expect(audit).toMatchObject({ fromValue: { tool: 'set-price', level: 'auto' }, toValue: { tool: 'set-price', level: 'watch' } })
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { level: 'confirm' }))).toMatchObject({ ok: true, rule: { level: 'confirm' } })
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { level: 'watch' }))).toMatchObject({ ok: false, code: 'forbidden' })
    await setLevel('set-price', 'watch')
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { level: 'auto' }))).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('lowered from auto to watch inside the undo window: the change goes back to a person instead of running', async () => {
    await setLevel('set-price', 'auto')
    const before = await priceOf(ids.productA)
    const parked = await call('set-price', { productId: ids.productA, price: before + 1 })
    expect(parked.answer.status).toBe('runs_by_rule')
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { level: 'watch' }))).toMatchObject({ ok: true })
    expect(await windowCloses(parked.answer.approvalId)).toMatchObject({ ok: false, error: expect.stringContaining('no longer') })
    expect(await approvalOf(parked.answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null })
    expect(await priceOf(ids.productA)).toBe(before)
  })

  it('nothing is recorded below watch or at auto, and one business’s watch never applies in the other', async () => {
    await setLevel('set-price', 'auto')
    const ran = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 })
    expect(ran.answer.status).toBe('runs_by_rule')
    expect(await verdictOf(ran.answer.approvalId)).toBeNull()
    await setLevel('set-price', 'confirm')
    const confirm = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 })
    expect(confirm.answer.trust).not.toHaveProperty('watch')
    expect(await verdictOf(confirm.answer.approvalId)).toBeNull()
    await setLevel('set-price', 'watch')
    const inB = await inside(() => call('set-price', { productId: ids.productB, price: 101 }, claude(B)), B)
    expect(inB.answer).toMatchObject({ business: { id: B }, status: 'waiting_for_approval' })
    expect(inB.answer).not.toHaveProperty('trust')
    expect(await verdictOf(inB.answer.approvalId, B)).toBeNull()
  })
})

describe('AA-W2-4 — the ads strategy\'s daily limits: watch counts the watched changes that would have run; a plan\'s ad steps count together', { timeout: TIMEOUT }, () => {
  // set-price stands in for a strategy-bound ad tool: its preview carries the kit's limit facts (2 changes in IT; the
  // strategy allows 5 changes a day) and its limits add the kit's daily check. No ad tool carries facts before AA-W2-6.
  const facts = () => ({
    v: LIMIT_FACTS_VERSION, tool: 'set-price', action: 'bid',
    markets: { IT: { strategy: { version: 'test' }, currency: 'EUR', maxActionsPerRun: null, maxChangesPerDay: 5, maxRaisesPerDay: null, maxBudgetIncreasePerDayCents: null, sources: {} } },
    scopes: {}, entityScopes: {}, labels: {},
    this: { markets: ['IT'], items: 2, writes: 2, raises: 0, cuts: 2, largestRaisePct: 0, largestCutPct: 1, largestRaisePoints: 0, largestCutPoints: 0, highestNewBidCents: null, budgetIncreaseCents: 0, byMarket: { IT: { items: 2, changes: 2, writes: 2, raises: 0, budgetIncreaseCents: 0, addedDailyCents: 0 } }, entities: [], rowsOutsideStrategy: 0, firstOutside: null },
    today: { IT: { changes: 0, writes: 0, raises: 0, budgetIncreaseCents: 0 } },
    perEntityToday: { maxChangesByRule: 0, entity: null }, unplaced: [], engineOwned: [], protectedHit: [],
  })
  async function asStrategyBound<T>(work: () => Promise<T>): Promise<T> {
    const tool = getTool('set-price')!
    const original = { handler: tool.handler, withinLimits: tool.withinLimits!, strategyBound: tool.strategyBound }
    tool.strategyBound = 'amazon-ads'
    tool.handler = async (args, ctx) => {
      const out = await original.handler(args, ctx)
      return out.ok ? { ...out, preview: { ...(out.preview as object), limitFacts: facts() } } : out
    }
    tool.withinLimits = (preview, limits) => original.withinLimits(preview, limits) ?? dailyRefusal(limitFactsOf(preview)!)
    try {
      return await work()
    } finally {
      Object.assign(tool, original)
      if (!original.strategyBound) delete tool.strategyBound
    }
  }
  const nextPrice = async () => (await priceOf(ids.productA)) + 1
  const step = async () => ({ tool: 'set-price', args: { productId: ids.productA, price: await nextPrice() } })

  it('watch: the second day\'s worth is outside; a plan whose steps pass alone but not together is outside, step by step', async () => {
    await asStrategyBound(async () => {
      await setLevel('set-price', 'watch')
      const first = await call('set-price', { productId: ids.productA, price: await nextPrice() })
      expect(first.answer.trust.watch).toMatchObject({ wouldRun: true })
      // Each step alone: 2 watched + 2 ≤ 5; together: 2 + 4 > 5.
      const plan = await call('submit-change-plan', { title: 'Two bid steps', steps: [await step(), await step()] })
      expect(plan.answer.trust.watch).toEqual({
        wouldRun: false, check: 'limits', steps: { total: 2, wouldRun: 0 },
        why: 'the plan\'s ad steps together — IT: 2 changes ran or would have run by rule in the last 24 hours and this adds 4 changes, more than the 5 a day the ads strategy allows (most changes Claude may run by rule a day)',
      })
      expect((await approvalOf(plan.answer.approvalId)).ruleVerdict).toMatchObject({ steps: [{ wouldRun: false, check: 'limits' }, { wouldRun: false, check: 'limits' }] })
      // The plan would not have run, so it adds nothing; the next single change still fits, the one after does not.
      expect((await call('set-price', { productId: ids.productA, price: await nextPrice() })).answer.trust.watch).toMatchObject({ wouldRun: true })
      const third = await call('set-price', { productId: ids.productA, price: await nextPrice() })
      expect(third.answer.trust.watch).toEqual({ wouldRun: false, check: 'limits', why: 'IT: 4 changes ran or would have run by rule in the last 24 hours and this adds 2 changes, more than the 5 a day the ads strategy allows (most changes Claude may run by rule a day)' })
    })
  })

  it('auto: a plan whose ad steps pass alone but not together waits for a person, and Claude is told why', async () => {
    await asStrategyBound(async () => {
      await setLevel('set-price', 'auto')
      const plan = await call('submit-change-plan', { title: 'Three bid steps', steps: [await step(), await step(), await step()] })
      expect(plan.answer).toMatchObject({
        status: 'waiting_for_approval',
        trust: { level: 'auto', why: 'the plan\'s ad steps together — IT: 0 changes ran by rule in the last 24 hours and this adds 6 changes, more than the 5 a day the ads strategy allows (most changes Claude may run by rule a day); a person approves it in Nexus' },
      })
      expect(await approvalOf(plan.answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null, ruleVerdict: null })
      const two = await call('submit-change-plan', { title: 'Two bid steps', steps: [await step(), await step()] })
      expect(two.answer.status).toBe('runs_by_rule')
    })
  })
})

describe('NA — "Claude\'s changes need no approval": every change Claude asks for, approved in the name of the person who asked', { timeout: TIMEOUT }, () => {
  const switchTo = (noApproval: unknown, who = actor()) => inside(() => setNoApproval(who, { noApproval }))
  const skuOf = async (id: string) => (await inside(() => db().product.findUniqueOrThrow({ where: { id } }))).sku
  /** A product of its own for each rename (a kind that always waits for a person: alwaysAsk, ceiling ask). */
  const freshProduct = () => inside(() => db().product.create({ data: { sku: `TEST-NA-${randomUUID().slice(0, 8)}`, name: 'No-approval jacket', basePrice: '100.00' } }))
  /** What `execute` is told about who approved the request it carries out. */
  async function seenByExecute<T>(toolName: string, work: (seen: Array<Pick<ToolContext, 'approvedByPerson' | 'decidedVia'>>) => Promise<T>): Promise<T> {
    const tool = getTool(toolName)!
    const original = tool.execute!
    const seen: Array<Pick<ToolContext, 'approvedByPerson' | 'decidedVia'>> = []
    tool.execute = async (args, ctx) => {
      seen.push({ approvedByPerson: ctx.approvedByPerson, decidedVia: ctx.decidedVia })
      return original(args, ctx)
    }
    try {
      return await work(seen)
    } finally {
      tool.execute = original
    }
  }
  const latestPolicyAudit = () => inside(() => db().agentControlAudit.findFirstOrThrow({ where: { charterKey: 'claude', action: 'policy' }, orderBy: { createdAt: 'desc' } }))

  it('off (no row): exactly as before — a kind that always waits for a person waits for one', async () => {
    const product = await freshProduct()
    const { answer } = await call('set-product-sku', { productId: product.id, sku: `${product.sku}-X` })
    expect(answer).toMatchObject({ status: 'waiting_for_approval' })
    expect(answer).not.toHaveProperty('trust')
    expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null })
    expect((await inside(() => listClaudeRules())).autonomy.noApproval).toEqual({ on: false, since: null, by: null })
  })

  it('on: a kind whose ceiling is ask is scheduled as the person who asked and runs after the window, approved by a person in Claude', async () => {
    expect(getTool('set-product-sku')).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask' })
    expect(await switchTo(true)).toMatchObject({ ok: true, noApproval: { on: true, since: expect.any(String), by: 'Tara Trust' } })
    const capBefore = (await inside(() => listClaudeRules())).autonomy.autoRunsLastDay
    const product = await freshProduct()
    const { answer } = await call('set-product-sku', { productId: product.id, sku: `${product.sku}-NA` })
    expect(answer).toMatchObject({
      status: 'runs_by_rule',
      approvalId: expect.any(String),
      trust: { level: 'auto', noApproval: true },
      next: expect.stringMatching(new RegExp(`^${names.A} turned on "Claude's changes need no approval": nobody needs to approve it\\. It runs at runsAt`)),
    })
    const parked = await approvalOf(answer.approvalId)
    expect(parked).toMatchObject({ status: 'scheduled', decisionVia: 'no-approval', decidedByUserId: ids.person, decidedBy: 'Tara Trust' })
    expect(parked.executeAfter!.getTime() - parked.decidedAt!.getTime()).toBeCloseTo(UNDO_WINDOW_MS, -3)
    expect(new Date(answer.runsAt).getTime()).toBe(parked.executeAfter!.getTime())
    expect(await skuOf(product.id)).toBe(product.sku) // nothing inside the window
    await seenByExecute('set-product-sku', async (seen) => {
      expect(await windowCloses(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
      expect(seen).toEqual([{ approvedByPerson: true, decidedVia: 'claude' }])
    })
    expect(await skuOf(product.id)).toBe(`${product.sku}-NA`)
    expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'executed', decisionVia: 'no-approval' })
    // Not a rule-run: the daily cap does not count it.
    expect((await inside(() => listClaudeRules())).autonomy.autoRunsLastDay).toBe(capBefore)
  })

  it('on: a plan is one request, scheduled as the asker, outside every level and limit; each step runs as approved by a person', async () => {
    await switchTo(true)
    const before = await priceOf(ids.productA)
    const far = Math.round(before * 1.5) // outside set-price's 10 % limit, and set-price is at ask (no row)
    const plan = await call('submit-change-plan', { title: 'No approval plan', steps: [{ tool: 'set-price', args: { productId: ids.productA, price: far } }] })
    expect(plan.answer).toMatchObject({ status: 'runs_by_rule', trust: { level: 'auto', noApproval: true }, plan: { steps: 1 } })
    expect(await approvalOf(plan.answer.approvalId)).toMatchObject({ status: 'scheduled', decisionVia: 'no-approval', decidedByUserId: ids.person })
    expect(await windowCloses(plan.answer.approvalId)).toMatchObject({ ok: true, status: 'executing' })
    await seenByExecute('set-price', async (seen) => {
      expect(await inside(() => runPlan(plan.answer.approvalId))).toMatchObject({ finished: true })
      expect(seen).toEqual([{ approvedByPerson: true, decidedVia: 'claude' }])
    })
    expect(await priceOf(ids.productA)).toBe(far)
  })

  it('on, but paused: as without the switch; on, but without nexus.run: as without the switch (a watch verdict still recorded)', async () => {
    await switchTo(true)
    await inside(() => pauseAutoRuns(actor(), 'checking'))
    const paused = await call('set-product-sku', { productId: (await freshProduct()).id, sku: `TEST-NA-PAUSED-${randomUUID().slice(0, 6)}` })
    expect(paused.answer).toMatchObject({ status: 'waiting_for_approval' })
    expect(paused.answer).not.toHaveProperty('trust')
    await setLevel('set-price', 'auto')
    const pausedAuto = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 })
    expect(pausedAuto.answer).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'auto', why: expect.stringContaining('(checking)') } })
    for (const id of [paused.answer.approvalId, pausedAuto.answer.approvalId]) expect(await approvalOf(id)).toMatchObject({ status: 'pending', decisionVia: null })

    expect(await inside(() => resumeAutoRuns(actor()))).toMatchObject({ ok: true })
    const noRun = claude(A, ['nexus.read', 'nexus.write'])
    const noScope = await call('set-product-sku', { productId: (await freshProduct()).id, sku: `TEST-NA-SCOPE-${randomUUID().slice(0, 6)}` }, noRun)
    expect(noScope.answer).toMatchObject({ status: 'waiting_for_approval' })
    expect(noScope.answer).not.toHaveProperty('trust')
    // A watched kind keeps its watch: the verdict is recorded, the words say who decides.
    await setLevel('set-price', 'watch')
    const watched = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 }, noRun)
    expect(watched.answer).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'watch', watch: { wouldRun: true, scope: 'no-run-by-rule' } } })
    expect((await approvalOf(watched.answer.approvalId)).ruleVerdict).toMatchObject({ level: 'watch', wouldRun: true, scope: 'no-run-by-rule' })
    for (const id of [noScope.answer.approvalId, watched.answer.approvalId]) expect(await approvalOf(id)).toMatchObject({ status: 'pending', decisionVia: null })
  })

  it('on: a raise that asks for the approver’s code (stepUp) is not the switch’s — it goes as without the switch', async () => {
    await switchTo(true)
    const tool = getTool('set-price')!
    const handler = tool.handler
    tool.handler = async (args, ctx) => {
      const out = await handler(args, ctx)
      return out.ok ? { ...out, preview: { ...(out.preview as object), stepUp: { what: 'raises a limit', raises: ['Price'] } } } : out
    }
    try {
      const { answer } = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 })
      expect(answer).toMatchObject({ status: 'waiting_for_approval' })
      expect(answer).not.toHaveProperty('trust')
      expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null })
    } finally {
      tool.handler = handler
    }
  })

  it('on: a kind set to off is still refused before anything runs', async () => {
    await switchTo(true)
    expect(await inside(() => setClaudeRule(brake(), 'set-product-sku', { level: 'off' }))).toMatchObject({ ok: true })
    const product = await freshProduct()
    const { isError, answer } = await call('set-product-sku', { productId: product.id, sku: `${product.sku}-OFF` })
    expect(isError).toBe(true)
    expect(answer.error).toBe(`set-product-sku is turned off for Claude in ${names.A}. Nothing was queued.`)
  })

  it('turned off or paused inside the window: back to a person, nothing ran — a plan’s steps too', async () => {
    const before = await priceOf(ids.productA)
    const ask = (price: number) => call('set-price', { productId: ids.productA, price })
    // Off: what it scheduled goes back at once.
    await switchTo(true)
    const first = await ask(before + 1)
    expect(first.answer.status).toBe('runs_by_rule')
    expect(await switchTo(false, brake())).toMatchObject({ ok: true, noApproval: { on: false, since: null, by: null }, handedBack: 1 })
    expect(await approvalOf(first.answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null, executeAfter: null, reason: expect.stringContaining('was turned off') })
    // And at the commit itself, whatever turned it off: handed back, not run.
    await switchTo(true)
    const second = await ask(before + 2)
    await inside(() => db().agentAutonomy.updateMany({ data: { claudeNoApprovalAt: null } }))
    expect(await windowCloses(second.answer.approvalId)).toMatchObject({ ok: false, error: 'not run — "Claude\'s changes need no approval" was turned off in this business before it ran' })
    expect(await approvalOf(second.answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null })
    // Pause hands it back, as it does a rule-run.
    await switchTo(true)
    const third = await ask(before + 3)
    expect(await inside(() => pauseAutoRuns(brake(), 'stop'))).toMatchObject({ handedBack: 1 })
    expect(await approvalOf(third.answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null, reason: expect.stringContaining('paused') })
    expect(await inside(() => resumeAutoRuns(actor()))).toMatchObject({ ok: true })
    // A plan already handed to its worker: each step checks the switch again before it runs.
    const plan = await call('submit-change-plan', { title: 'Stopped plan', steps: [{ tool: 'set-price', args: { productId: ids.productA, price: before + 4 } }] })
    expect(plan.answer.status).toBe('runs_by_rule')
    expect(await windowCloses(plan.answer.approvalId)).toMatchObject({ ok: true, status: 'executing' })
    await switchTo(false, brake())
    await inside(() => runPlan(plan.answer.approvalId))
    const [step] = await inside(() => db().agentPlanStep.findMany({ where: { approvalId: plan.answer.approvalId } }))
    expect(step).toMatchObject({ status: 'skipped', reason: expect.stringContaining('was turned off in this business before it ran') })
    expect(await priceOf(ids.productA)).toBe(before)
  })

  it('the kind set to off inside the window: back to a person at the commit; a plan at its commit and before each step', async () => {
    const before = await priceOf(ids.productA)
    await switchTo(true)
    const single = await call('set-price', { productId: ids.productA, price: before + 1 })
    const plan = await call('submit-change-plan', { title: 'Off plan', steps: [{ tool: 'set-price', args: { productId: ids.productA, price: before + 2 } }] })
    const running = await call('submit-change-plan', { title: 'Running plan', steps: [{ tool: 'set-price', args: { productId: ids.productA, price: before + 3 } }] })
    for (const out of [single, plan, running]) expect(out.answer).toMatchObject({ status: 'runs_by_rule', trust: { noApproval: true } })
    expect(await windowCloses(running.answer.approvalId)).toMatchObject({ ok: true, status: 'executing' })
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { level: 'off' }))).toMatchObject({ ok: true }) // lowering: a brake
    expect(await windowCloses(single.answer.approvalId)).toMatchObject({ ok: false, error: 'not run — set-price was turned off for Claude in this business before it ran' })
    expect(await windowCloses(plan.answer.approvalId)).toMatchObject({ ok: false, error: 'not run — step 1: set-price was turned off for Claude in this business before it ran' })
    for (const out of [single, plan]) expect(await approvalOf(out.answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null })
    await inside(() => runPlan(running.answer.approvalId))
    const [step] = await inside(() => db().agentPlanStep.findMany({ where: { approvalId: running.answer.approvalId } }))
    expect(step).toMatchObject({ status: 'skipped', reason: 'not run — set-price was turned off for Claude in this business before it ran' })
    expect(await priceOf(ids.productA)).toBe(before)
  })

  it('turning it on takes settings.security.manage; off is a brake anyone who may use Claude pulls; audited; the rules list shows it', async () => {
    const forbidden = { ok: false, status: 403, code: 'forbidden', error: expect.stringContaining('settings.security.manage') }
    expect(await switchTo(true, brake())).toMatchObject(forbidden)
    expect((await inside(() => listClaudeRules())).autonomy.noApproval.on).toBe(false)
    expect(await switchTo(true)).toMatchObject({ ok: true, noApproval: { on: true, by: 'Tara Trust' }, dailyAutoCap: 200, handedBack: 0 })
    expect(await latestPolicyAudit()).toMatchObject({ actor: 'Tara Trust', fromValue: { noApproval: false }, toValue: { noApproval: true } })
    expect((await inside(() => listClaudeRules())).autonomy).toMatchObject({ paused: false, noApproval: { on: true, since: expect.any(String), by: 'Tara Trust' } })
    expect(await switchTo(false, brake())).toMatchObject({ ok: true, noApproval: { on: false } })
    expect(await latestPolicyAudit()).toMatchObject({ fromValue: { noApproval: true }, toValue: { noApproval: false, handedBack: 0 } })
    // With the cap in the same call, both are checked before either is saved.
    expect(await inside(() => setNoApproval(brake(), { noApproval: true, dailyAutoCap: 50 }))).toMatchObject(forbidden)
    expect(await inside(() => setNoApproval(brake(), { noApproval: false, dailyAutoCap: 500 }))).toMatchObject(forbidden)
    expect(await inside(() => setNoApproval(actor(), { noApproval: true, dailyAutoCap: -1 }))).toMatchObject({ ok: false, status: 400 })
    expect(await switchTo('yes')).toMatchObject({ ok: false, status: 400, error: 'noApproval must be true or false.' })
    expect((await inside(() => listClaudeRules())).autonomy).toMatchObject({ dailyAutoCap: 200, noApproval: { on: false } })
    expect(await inside(() => setNoApproval(actor(), { noApproval: true, dailyAutoCap: 50 }))).toMatchObject({ ok: true, noApproval: { on: true }, dailyAutoCap: 50 })
  })
})
