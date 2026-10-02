/**
 * MCP full control C7 (D1 = B) — confirm in Claude: the person who asked approves a change set to `confirm` by typing
 * their authenticator code in Claude (confirm-change {approvalId, planHash, code}).
 *
 * Proven through Claude's own door (runToolForClaude → the gate) and the sweep's commit, on PGlite with the production
 * schema and policies; real TOTP codes through the existing step-up verifier (lockout, reuse refusal).
 *
 *   queued    a change (or a plan) at `confirm` answers with its summary, its planHash and how to confirm it
 *   confirm   only the person who asked, only at `confirm`, only with nexus.run, only with the right planHash before
 *             it expires, with a fresh code used once: then scheduleApproval (decisionVia claude-confirm) — the normal
 *             undo window, and the commit's re-check of the person and the preview
 *   never     the code is never stored on the run
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecret, generateSync } from 'otplib'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
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
vi.mock('../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, agentPlanQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true, workersOff: true })),
}))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import { __stepUpTest } from '../../lib/auth/step-up.js'
import { commitScheduledApproval } from '../agent-fleet/approval-inbox.service.js'
import type { McpPrincipal } from '../mcp/mcp-auth.js'
import { runToolForClaude } from '../mcp/mcp-tool-call.js'
import { confirmSummaryOf } from './claude-confirm.service.js'
import { setClaudeRule } from './claude-trust.service.js'
import { getTool } from './tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const TIMEOUT = 30_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>) => withWorkspace(business(A), work)
const db = () => database.client
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids: Record<string, string> = {}
const secrets: Record<'asker' | 'other', string> = { asker: '', other: '' }
let nameA = ''

function claude(who: 'asker' | 'other' = 'asker', scopes = ['nexus.read', 'nexus.write', 'nexus.run']): McpPrincipal {
  return {
    kind: 'user', userId: ids[who], label: who === 'asker' ? 'Cora Confirm' : 'Otto Other', permissions: { isOwner: false, permissions: EVERYTHING },
    workspace: business(A), business: { id: A, name: nameA }, via: 'claude', oauthGrantId: `grant-${who}`, scopes,
  } as McpPrincipal
}
const codeOf = (who: 'asker' | 'other' = 'asker') => generateSync({ secret: secrets[who] })
async function call(tool: string, args: Record<string, unknown>, who = claude()) {
  const result = await runToolForClaude(who, getTool(tool)!, { ...args, business: nameA })
  return { isError: !!result.isError, answer: JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join('')) }
}
const approvalOf = (id: string) => inside(() => db().agentApproval.findUniqueOrThrow({ where: { id } }))
const priceOf = async (key: string) => inside(async () => Number((await db().product.findUniqueOrThrow({ where: { id: ids[key] } })).basePrice))
async function queueAtConfirm(key: string, price: number) {
  const { answer } = await call('set-price', { productId: ids[key], price })
  expect(answer.status, JSON.stringify(answer)).toBe('waiting_for_approval')
  return answer
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  vi.stubEnv('ENABLE_QUEUE_WORKERS', '')
  const client = database.client
  const role = await client.role.create({ data: { key: `C7_${randomUUID().slice(0, 8)}`, name: 'Confirm tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  for (const who of ['asker', 'other'] as const) {
    secrets[who] = generateSecret()
    const person = await client.userProfile.create({
      data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: who === 'asker' ? 'Cora Confirm' : 'Otto Other', twoFactorEnabledAt: new Date(), twoFactorSecret: secrets[who] },
    })
    ids[who] = person.id
    await client.userRole.create({ data: { userId: person.id, roleId: role.id } })
    const membership = await client.workspaceMembership.create({ data: { workspaceId: A, userId: person.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }
  nameA = (await client.workspace.findUniqueOrThrow({ where: { id: A } })).name
  await inside(async () => {
    for (const key of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']) {
      ids[key] = (await client.product.create({ data: { sku: `TEST-CONFIRM-${key.toUpperCase()}`, name: `Confirm jacket ${key}`, basePrice: '100.00' } })).id
    }
  })
  __stepUpTest.reset()
  expect(await inside(() => setClaudeRule({ userId: ids.asker, label: 'Cora Confirm', canManage: true }, 'set-price', { level: 'confirm', code: codeOf() }))).toMatchObject({ ok: true })
}, 120_000)

beforeEach(() => __stepUpTest.reset())

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('C7 — a change set to confirm says how to confirm it', { timeout: TIMEOUT }, () => {
  it('its summary, its planHash, and "type your authenticator code"; both stored on the approval', async () => {
    const answer = await queueAtConfirm('p1', 101)
    expect(answer).toMatchObject({
      trust: { level: 'confirm' },
      confirm: { summary: expect.any(String), planHash: expect.stringMatching(/^[0-9a-f]{64}$/), next: expect.stringContaining('authenticator code') },
    })
    expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'pending', summary: answer.confirm.summary, planHash: answer.confirm.planHash })
  })
})

describe('C7 — the summary a person confirms with a code states exactly what changes', () => {
  // Found in the local end-to-end run (2026-10-02): set-product-tags read "tags — → —".
  it('lists: every value, by name; an empty list says so; never "—" for a value that is there', () => {
    const line = confirmSummaryOf('set-product-tags', {
      sku: 'TEST-SKU-1', changes: { tags: { from: ['summer', 'sale'], to: ['summer', 'sale', 'new'] } },
    })
    expect(line).toBe('Set product tags for TEST-SKU-1: tags: summer, sale → summer, sale, new')
    expect(confirmSummaryOf('set-product-tags', { sku: 'TEST-SKU-1', changes: { tags: { from: [], to: ['new'] } } }))
      .toBe('Set product tags for TEST-SKU-1: tags: (none) → new')
  })

  it('objects: each key and its value; a missing value is the only "—"; more than three changes are counted', () => {
    const line = confirmSummaryOf('set-product-tags', {
      sku: 'TEST-SKU-1',
      changes: {
        dimensions: { from: { length: 10, unit: 'cm' }, to: { length: 12, unit: 'cm' } },
        bullets: { from: null, to: [{ text: 'Light' }, { text: 'Warm' }] },
        price: { from: 9.5, to: 10 },
        title: { from: 'Old', to: 'New' },
      },
    })
    expect(line).toBe(
      'Set product tags for TEST-SKU-1: dimensions: length: 10, unit: cm → length: 12, unit: cm; '
      + 'bullets: — → (text: Light), (text: Warm); price: 9.5 → 10; and 1 more change',
    )
    expect(line).not.toMatch(/object Object/)
  })
})

describe('C7 — confirm-change', { timeout: TIMEOUT }, () => {
  it('the person who asked, the right hash, a fresh code: scheduled through the normal window, and it runs', async () => {
    const queued = await queueAtConfirm('p2', 102)
    const code = codeOf()
    const out = await call('confirm-change', { approvalId: queued.approvalId, planHash: queued.confirm.planHash, code })
    expect(out.isError, JSON.stringify(out.answer)).toBe(false)
    expect(out.answer).toMatchObject({ status: 'confirmed', approvalId: queued.approvalId, runsAt: expect.any(String) })
    expect(await approvalOf(queued.approvalId)).toMatchObject({ status: 'scheduled', decisionVia: 'claude-confirm', decidedByUserId: ids.asker })
    expect(await priceOf('p2')).toBe(100) // the window first
    await inside(() => db().agentApproval.update({ where: { id: queued.approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
    expect(await inside(() => commitScheduledApproval(queued.approvalId))).toMatchObject({ ok: true, status: 'executed' })
    expect(await priceOf('p2')).toBe(102)
    // The code is never kept on the run.
    const run = await inside(() => db().agentRun.findFirstOrThrow({ where: { agentKey: 'claude', input: { path: ['tool'], equals: 'confirm-change' } }, orderBy: { createdAt: 'desc' } }))
    expect(JSON.stringify(run.input)).not.toContain(`"${code}"`)
    expect(run.input).toMatchObject({ tool: 'confirm-change', args: { approvalId: queued.approvalId, code: '[redacted]' } })
  })

  it('a wrong code, then a reused one: refused, and it still waits', async () => {
    const queued = await queueAtConfirm('p3', 103)
    const wrong = await call('confirm-change', { approvalId: queued.approvalId, planHash: queued.confirm.planHash, code: '000000' })
    expect(wrong).toMatchObject({ isError: true, answer: { error: expect.stringContaining('not right') } })
    // A code already used to confirm another change is worthless here.
    const first = await queueAtConfirm('p4', 104)
    const code = codeOf()
    expect((await call('confirm-change', { approvalId: first.approvalId, planHash: first.confirm.planHash, code })).isError).toBe(false)
    const reused = await call('confirm-change', { approvalId: queued.approvalId, planHash: queued.confirm.planHash, code })
    expect(reused).toMatchObject({ isError: true, answer: { error: expect.stringContaining('already used') } })
    expect(await approvalOf(queued.approvalId)).toMatchObject({ status: 'pending', decisionVia: null })
  })

  it('a wrong planHash, an expired request, another person, no nexus.run: refused before the code is even read', async () => {
    const queued = await queueAtConfirm('p5', 105)
    const hash = queued.confirm.planHash
    expect((await call('confirm-change', { approvalId: queued.approvalId, planHash: 'f'.repeat(64), code: codeOf() })).answer.error).toContain('planHash')
    expect((await call('confirm-change', { approvalId: queued.approvalId, planHash: hash, code: codeOf('other') }, claude('other'))).answer.error).toContain('Only the person who asked')
    expect((await call('confirm-change', { approvalId: queued.approvalId, planHash: hash, code: codeOf() }, claude('asker', ['nexus.read', 'nexus.write']))).answer.error).toContain('nexus.run')
    await inside(() => db().agentApproval.update({ where: { id: queued.approvalId }, data: { expiresAt: new Date(Date.now() - 1000) } }))
    expect((await call('confirm-change', { approvalId: queued.approvalId, planHash: hash, code: codeOf() })).answer.error).toContain('expired')
    expect(await approvalOf(queued.approvalId)).toMatchObject({ status: 'pending', decisionVia: null })
    // None of those spent the code: it still confirms a change it may confirm.
    const other = await queueAtConfirm('p6', 106)
    expect((await call('confirm-change', { approvalId: other.approvalId, planHash: other.confirm.planHash, code: codeOf() })).isError).toBe(false)
  })

  it('a tool not set to confirm cannot be confirmed in Claude: a person approves it in Nexus', async () => {
    expect(await inside(() => setClaudeRule({ userId: ids.asker, label: 'Cora Confirm', canManage: true }, 'apply-content', { level: 'ask' }))).toMatchObject({ ok: true })
    const { answer } = await call('apply-content', { productId: ids.p7, title: 'Confirm jacket, new' })
    expect(answer).not.toHaveProperty('confirm')
    const approval = await approvalOf(answer.approvalId)
    const out = await call('confirm-change', { approvalId: answer.approvalId, planHash: approval.planHash ?? 'e'.repeat(64), code: codeOf() })
    expect(out.answer.error).toContain('not set to confirm')
  })

  it('a plan whose steps are set to confirm: confirmed once, handed to the plan worker after the window', async () => {
    const { answer } = await call('submit-change-plan', { title: 'Confirm plan', steps: [{ tool: 'set-price', args: { productId: ids.p1, price: 110 } }, { tool: 'set-price', args: { productId: ids.p3, price: 111 } }] })
    expect(answer).toMatchObject({ status: 'waiting_for_approval', plan: { steps: 2 }, confirm: { planHash: answer.plan.planHash } })
    const out = await call('confirm-change', { approvalId: answer.approvalId, planHash: answer.plan.planHash, code: codeOf() })
    expect(out.isError, JSON.stringify(out.answer)).toBe(false)
    await inside(() => db().agentApproval.update({ where: { id: answer.approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
    expect(await inside(() => commitScheduledApproval(answer.approvalId))).toMatchObject({ ok: true, status: 'executing' })
  })
})
