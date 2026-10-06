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
 *   raising     needs settings.security.manage (the routes) and a fresh 2FA code; lowering does not
 *   businesses  one business's level never applies in another
 *   watch       AA-W2-4 — the full check auto would make runs and its verdict is recorded on the request; it is never
 *               scheduled: a person decides it (as at confirm); the cap counts the watched changes that would have run;
 *               offered only below an auto ceiling and never for a brake; raising to it takes the code
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
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
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
import type { AgentTool } from './tool-types.js'
import { dailyRefusal, LIMIT_FACTS_VERSION, limitFactsOf } from './tools/ads-autonomy-kit.js'
import {
  AUTO_PAUSE_FAILURES,
  limitsTighten,
  claudeOffTools,
  claudeRuleOf,
  levelsFor,
  listClaudeRules,
  pauseAutoRuns,
  resumeAutoRuns,
  setClaudeRule,
  setDailyAutoCap,
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
/** Set a level (and limits) the way the Settings page does: raising takes a fresh code. */
async function setLevel(tool: string, level: string, limits?: Record<string, unknown> | null, workspaceId = A) {
  const saved = await inside(() => setClaudeRule(actor(), tool, { level, ...(limits !== undefined ? { limits } : {}), code: code() }), workspaceId)
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
    const refused = await inside(() => setClaudeRule(actor(), 'send-customer-message', { level: 'auto', code: code() }))
    expect(refused).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('ask at most') })
    const read = await inside(() => setClaudeRule(actor(), 'product-search', { level: 'auto', code: code() }))
    expect(read).toMatchObject({ ok: false, status: 400 })
    // Written straight into the row (an older release, a hand edit): still ask.
    await inside(() => db().agentTool.create({ data: { name: 'send-customer-message', riskTier: 'high', requiresApproval: true, claudeTrust: 'auto' } }))
    expect(await inside(() => claudeRuleOf('send-customer-message'))).toMatchObject({ level: 'ask', stored: 'auto', ceiling: 'ask' })
  })
})

describe('C5 — raising takes a fresh 2FA code; lowering does not; every change is audited', { timeout: TIMEOUT }, () => {
  it('raising without a code, or with a wrong one, is refused; with a fresh one it is saved and audited', async () => {
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { level: 'auto' }))).toMatchObject({ ok: false, status: 403, code: 'mfa_required' })
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { level: 'auto', code: '000000' }))).toMatchObject({ ok: false, status: 400, code: 'mfa_invalid' })
    expect(await inside(() => claudeRuleOf('set-price'))).toMatchObject({ level: 'ask' })
    const saved = await inside(() => setClaudeRule(actor(), 'set-price', { level: 'auto', code: code() }))
    expect(saved).toMatchObject({ ok: true, rule: { level: 'auto' } })
    const audit = await inside(() => db().agentControlAudit.findFirstOrThrow({ where: { charterKey: 'claude', action: 'policy' }, orderBy: { createdAt: 'desc' } }))
    expect(audit).toMatchObject({ actor: 'Tara Trust', fromValue: { tool: 'set-price', level: 'ask' }, toValue: { tool: 'set-price', level: 'auto' } })
  })

  it('limits: checked against the tool’s own schema, and a looser one needs the code', async () => {
    await setLevel('set-price', 'auto')
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { limits: { maxChangePercent: 500 }, code: code() }))).toMatchObject({ ok: false, status: 400 })
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { limits: { maxChangePercent: 5, extra: 1 }, code: code() }))).toMatchObject({ ok: false, status: 400 })
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { limits: { maxChangePercent: 15 } }))).toMatchObject({ ok: false, code: 'mfa_required' })
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { limits: { maxChangePercent: 15 }, code: code() }))).toMatchObject({ ok: true, rule: { limits: { maxChangePercent: 15 } } })
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

  it('raising a level, loosening limits, raising the cap or Resume: refused without it, even with a right code', async () => {
    const forbidden = { ok: false, status: 403, code: 'forbidden', error: expect.stringContaining('settings.security.manage') }
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { level: 'auto', code: code() }))).toMatchObject(forbidden)
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { limits: { maxChangePercent: 15 }, code: code() }))).toMatchObject(forbidden)
    expect(await inside(() => setDailyAutoCap(brake(), { dailyAutoCap: 500, code: code() }))).toMatchObject(forbidden)
    await inside(() => pauseAutoRuns(brake(), 'stop'))
    expect(await inside(() => resumeAutoRuns(brake(), code()))).toMatchObject(forbidden)
    expect(await inside(() => claudeRuleOf('set-price'))).toMatchObject({ level: 'ask' })
  })
})

describe('C5 — tightening a limit is a brake too; loosening one needs settings.security.manage and the code', { timeout: TIMEOUT }, () => {
  it('a smaller max, a shorter list of what is allowed: no code, no permission beyond using Claude', async () => {
    await setLevel('set-price', 'auto')
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { limits: { maxChangePercent: 5 } }))).toMatchObject({ ok: true, rule: { limits: { maxChangePercent: 5 } } })
    expect(await inside(() => setClaudeRule(brake(), 'bulk-price-change', { limits: { maxProducts: 10, maxChangePercent: 10 } }))).toMatchObject({ ok: true })
    expect(await inside(() => setClaudeRule(brake(), 'apply-content', { limits: { fields: ['title'] } }))).toMatchObject({ ok: true, rule: { limits: { fields: ['title'] } } })
    const audit = await inside(() => db().agentControlAudit.findFirstOrThrow({ where: { charterKey: 'claude', action: 'policy' }, orderBy: { createdAt: 'desc' } }))
    expect(audit.toValue).toMatchObject({ tool: 'apply-content', limits: { fields: ['title'] } })
  })

  it('a larger max, a longer list, back to looser defaults, or one looser among tighter: settings.security.manage and the code', async () => {
    const forbidden = { ok: false, status: 403, code: 'forbidden' }
    await inside(() => setClaudeRule(brake(), 'set-price', { limits: { maxChangePercent: 5 } }))
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { limits: { maxChangePercent: 8 } }))).toMatchObject(forbidden)
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { limits: null }))).toMatchObject(forbidden) // the default, 10, is looser
    expect(await inside(() => setClaudeRule(brake(), 'bulk-price-change', { limits: { maxProducts: 10, maxChangePercent: 20 } }))).toMatchObject(forbidden)
    await inside(() => setClaudeRule(brake(), 'apply-content', { limits: { fields: ['title'] } }))
    expect(await inside(() => setClaudeRule(brake(), 'apply-content', { limits: { fields: ['title', 'description'] } }))).toMatchObject(forbidden)
    // The person who may raise still needs the code to loosen.
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { limits: { maxChangePercent: 8 } }))).toMatchObject({ ok: false, code: 'mfa_required' })
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { limits: { maxChangePercent: 8 }, code: code() }))).toMatchObject({ ok: true })
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
    // Raising it back takes the code.
    expect(await inside(() => setDailyAutoCap(actor(), { dailyAutoCap: 200 }))).toMatchObject({ ok: false, code: 'mfa_required' })
    expect(await inside(() => setDailyAutoCap(actor(), { dailyAutoCap: 200, code: code() }))).toMatchObject({ ok: true })
  })

  it('Pause: at once, what waits to run by rule goes back to a person, and new ones wait; Resume takes the code', async () => {
    await setLevel('set-price', 'auto')
    const parked = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 })
    expect(parked.answer.status).toBe('runs_by_rule')
    expect(await inside(() => pauseAutoRuns(actor(), 'checking prices'))).toMatchObject({ ok: true, handedBack: 1 })
    expect(await approvalOf(parked.answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null, executeAfter: null, reason: expect.stringContaining('paused') })
    const next = await call('set-price', { productId: ids.productA, price: (await priceOf(ids.productA)) + 1 })
    expect(next.answer).toMatchObject({ status: 'waiting_for_approval', trust: { why: expect.stringContaining('paused') } })
    expect((await inside(() => listClaudeRules())).autonomy).toMatchObject({ paused: true, pausedBy: 'Tara Trust', reason: 'checking prices' })

    expect(await inside(() => resumeAutoRuns(actor(), undefined))).toMatchObject({ ok: false, code: 'mfa_required' })
    expect(await inside(() => resumeAutoRuns(actor(), code()))).toMatchObject({ ok: true })
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

    const noScope = await call('set-price', { productId: ids.productA, price: before + 1 }, claude(A, ['nexus.read', 'nexus.write']))
    expect(noScope.answer).toMatchObject({ trust: { level: 'watch', why: expect.stringMatching(/nexus\.run.*; a person approves it in Nexus$/), watch: { wouldRun: false, check: 'scope' } } })
    expect(noScope.answer).not.toHaveProperty('confirm')

    await inside(() => pauseAutoRuns(actor(), 'watch week'))
    const paused = await call('set-price', { productId: ids.productA, price: before + 1 })
    expect(paused.answer).toMatchObject({ trust: { watch: { wouldRun: false, check: 'pause', why: expect.stringContaining('(watch week)') } } })
    for (const id of [far.answer.approvalId, noScope.answer.approvalId, paused.answer.approvalId]) {
      expect(await approvalOf(id)).toMatchObject({ status: 'pending', decisionVia: null, executeAfter: null })
    }
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
    expect(levelsFor(getTool('turn-up-automation')!)).toEqual(['off', 'ask', 'confirm'])
    expect(await inside(() => setClaudeRule(actor(), 'stop-automation', { level: 'watch', code: code() })))
      .toMatchObject({ ok: false, status: 400, error: 'stop-automation cannot be watched: it is a brake, so it runs by rule or waits for a person.' })
    expect(await inside(() => setClaudeRule(actor(), 'turn-up-automation', { level: 'watch', code: code() })))
      .toMatchObject({ ok: false, status: 400, error: 'turn-up-automation cannot be watched: only a kind that may run by rule (auto) can be.' })
    // Written straight into the row (a hand edit): a watch the tool does not allow reads as the level below it.
    await inside(() => db().agentTool.create({ data: { name: 'turn-up-automation', riskTier: 'medium', requiresApproval: true, claudeTrust: 'watch' } }))
    expect(await inside(() => claudeRuleOf('turn-up-automation'))).toMatchObject({ level: 'confirm', stored: 'watch', ceiling: 'confirm' })
    expect((await inside(() => listClaudeRules())).tools.find((t) => t.name === 'stop-automation')).toMatchObject({ ceiling: 'auto', levels: ['off', 'ask', 'confirm', 'auto'] })
  })

  it('raising to watch takes settings.security.manage and the code; auto → watch is a free brake; watch → auto a raise', async () => {
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { level: 'watch' }))).toMatchObject({ ok: false, code: 'mfa_required' })
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { level: 'watch', code: code() }))).toMatchObject({ ok: false, code: 'forbidden' })
    await setLevel('set-price', 'confirm')
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { level: 'watch' }))).toMatchObject({ ok: false, code: 'mfa_required' })
    await setLevel('set-price', 'auto')
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { level: 'watch' }))).toMatchObject({ ok: true, rule: { level: 'watch' } })
    const audit = await inside(() => db().agentControlAudit.findFirstOrThrow({ where: { charterKey: 'claude', action: 'policy' }, orderBy: { createdAt: 'desc' } }))
    expect(audit).toMatchObject({ fromValue: { tool: 'set-price', level: 'auto' }, toValue: { tool: 'set-price', level: 'watch' } })
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { level: 'confirm' }))).toMatchObject({ ok: true, rule: { level: 'confirm' } })
    expect(await inside(() => setClaudeRule(brake(), 'set-price', { level: 'watch' }))).toMatchObject({ ok: false, code: 'forbidden' })
    await setLevel('set-price', 'watch')
    expect(await inside(() => setClaudeRule(actor(), 'set-price', { level: 'auto' }))).toMatchObject({ ok: false, code: 'mfa_required' })
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
