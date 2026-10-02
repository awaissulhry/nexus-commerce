/**
 * MCP full control C8 — "what did Claude do": every call Claude made in a business, with what became of it.
 *
 * Proven on a real PostgreSQL with the production schema and business policies (PGlite), from calls made through
 * Claude's own door (runToolForClaude), decided through the Approvals page's own functions and the sweep's commit.
 *
 *   rows       one per call (AgentRun via claude): when, who, which connection, which tool, and the outcome — read,
 *              refused, queued, run by rule (auto), approved, rejected, expired, handed back, undone — with the change
 *              it made and whether it can still be undone
 *   filters    dates, connection, tool (the call's or the change's), outcome; cursor paging that neither repeats nor
 *              skips a row
 *   money      a preview is shown through the reader's own money filter: hidden from a person who may not use the
 *              tool that made it, money fields stripped for one who may not see them
 *   business   another business's calls are never in the list
 *   events     agent.change.executed and agent.change.undone are written with the change, agent.autorun.paused with
 *              a Pause — ids, names and counts only
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import { __stepUpTest } from '../../lib/auth/step-up.js'
import { commitScheduledApproval, decideFleetApproval } from '../agent-fleet/approval-inbox.service.js'
import type { McpPrincipal } from '../mcp/mcp-auth.js'
import { runToolForClaude } from '../mcp/mcp-tool-call.js'
import { storedOutputOf, type UserPrincipal } from './call-tool.js'
import { claudeActivity, type ActivityRow } from './claude-activity.service.js'
import { pauseAutoRuns, setClaudeRule } from './claude-trust.service.js'
import { undoChangeByClick } from './change-undo.service.js'
import { getTool } from './tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const B = 'c8_activity_bravo'
const TIMEOUT = 30_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const db = () => database.client

const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
/** May use apply-content and read activity, but sees no cost and may not change prices. */
const CONTENT_ONLY = new Set<string>([F.aiRun, F.aiView, F.productsView, F.productsEdit])
const ids = { person: '', product: '', stale: '', productB: '' }
let secret = ''
let names = { A: '', B: 'Bravo activity business' }

function claude(grant: string, workspaceId = A): McpPrincipal {
  return {
    kind: 'user', userId: ids.person, label: 'Ada Audit',
    permissions: { isOwner: false, permissions: EVERYTHING },
    workspace: business(workspaceId), business: { id: workspaceId, name: workspaceId === A ? names.A : names.B },
    via: 'claude', oauthGrantId: grant, scopes: ['nexus.read', 'nexus.write', 'nexus.run'],
  } as McpPrincipal
}
const reader = (permissions: Set<string>): UserPrincipal => ({
  kind: 'user', userId: ids.person, label: 'Ada Audit', permissions: { isOwner: false, permissions }, workspace: business(A), via: 'app',
})
async function call(tool: string, args: Record<string, unknown>, who = claude('grant-one'), named = who.business.name) {
  const result = await runToolForClaude(who, getTool(tool)!, { ...args, business: named })
  return JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join(''))
}
const priceOf = async (id: string) => inside(async () => Number((await db().product.findUniqueOrThrow({ where: { id } })).basePrice))
async function windowCloses(approvalId: string) {
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}
const activity = (filters: Record<string, unknown> = {}, who = reader(EVERYTHING), workspaceId = A) =>
  inside(() => claudeActivity({ limit: 100, ...filters } as never, storedOutputOf(who)), workspaceId)
const runIdOf = async (approvalId: string) => (await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: approvalId } }))).agentRunId
const lastRunId = async () => (await inside(() => db().agentRun.findFirstOrThrow({ where: { via: 'claude' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }))).id

/** What each call became, by its run: the story the activity list must tell. */
const story: Record<string, { label: string; runId: string; approvalId?: string }> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const client = database.client
  secret = generateSecret()
  const role = await client.role.create({
    data: { key: `C8_AUDIT_${randomUUID().slice(0, 8)}`, name: 'Audit tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] },
  })
  const person = await client.userProfile.create({
    data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Ada Audit', twoFactorEnabledAt: new Date(), twoFactorSecret: secret },
  })
  ids.person = person.id
  await client.userRole.create({ data: { userId: person.id, roleId: role.id } })
  await client.workspace.create({ data: { id: B, name: names.B, createdByUserId: person.id, creationKey: randomUUID() } })
  names = { ...names, A: (await client.workspace.findUniqueOrThrow({ where: { id: A } })).name }
  for (const workspaceId of [A, B]) {
    const membership = await client.workspaceMembership.create({ data: { workspaceId, userId: person.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }
  await inside(async () => {
    ids.product = (await client.product.create({ data: { sku: 'TEST-AUDIT-1', name: 'Audit jacket', basePrice: '100.00' } })).id
    ids.stale = (await client.product.create({ data: { sku: 'TEST-AUDIT-STALE', name: 'Stale audit jacket', basePrice: '100.00' } })).id
  })
  await inside(async () => {
    ids.productB = (await client.product.create({ data: { sku: 'TEST-AUDIT-1', name: 'Bravo audit jacket', basePrice: '100.00' } })).id
  }, B)

  // ── The story, in order ────────────────────────────────────────────────────────────────────────────────
  await call('product-search', { query: 'AUDIT' })
  story.read = { label: 'read', runId: await lastRunId() }
  await call('set-price', { productId: ids.product, price: 101 }, claude('grant-one'), 'Some other business')
  story.refused = { label: 'refused', runId: await lastRunId() }
  const queued = await call('set-price', { productId: ids.product, price: 102 })
  story.queued = { label: 'queued', runId: await runIdOf(queued.approvalId), approvalId: queued.approvalId }

  __stepUpTest.reset()
  expect(await inside(() => setClaudeRule({ userId: ids.person, label: 'Ada Audit', canManage: true }, 'set-price', { level: 'auto', code: generateSync({ secret }) }))).toMatchObject({ ok: true })
  const ran = await call('set-price', { productId: ids.product, price: 103 })
  expect(ran.status).toBe('runs_by_rule')
  expect(await windowCloses(ran.approvalId)).toMatchObject({ ok: true, status: 'executed' })
  story.undone = { label: 'undone', runId: await runIdOf(ran.approvalId), approvalId: ran.approvalId }
  // The undo, over another connection: it runs by the same rule.
  const undo = await call('undo-change', { approvalId: ran.approvalId }, claude('grant-two'))
  expect(undo.status).toBe('runs_by_rule')
  expect(await windowCloses(undo.approvalId)).toMatchObject({ ok: true, status: 'executed' })
  story.auto = { label: 'auto', runId: await runIdOf(undo.approvalId), approvalId: undo.approvalId }

  const stale = await call('set-price', { productId: ids.stale, price: 101 })
  await inside(() => db().product.update({ where: { id: ids.stale }, data: { basePrice: '100.50' } }))
  expect(await windowCloses(stale.approvalId)).toMatchObject({ ok: false })
  story.handedBack = { label: 'handed-back', runId: await runIdOf(stale.approvalId), approvalId: stale.approvalId }

  // Back to ask: what follows waits for a person.
  expect(await inside(() => setClaudeRule({ userId: ids.person, label: 'Ada Audit', canManage: true }, 'set-price', { level: 'ask' }))).toMatchObject({ ok: true })
  const rejected = await call('set-price', { productId: ids.product, price: 104 })
  expect(await inside(() => decideFleetApproval({ id: rejected.approvalId, decision: 'reject', reason: 'not now', actor: reader(EVERYTHING) }))).toMatchObject({ ok: true })
  story.rejected = { label: 'rejected', runId: await runIdOf(rejected.approvalId), approvalId: rejected.approvalId }
  const expired = await call('set-price', { productId: ids.product, price: 105 })
  await inside(() => db().agentApproval.update({ where: { id: expired.approvalId }, data: { status: 'expired' } }))
  story.expired = { label: 'expired', runId: await runIdOf(expired.approvalId), approvalId: expired.approvalId }

  // A request whose stored preview carries a cost (money a content-only person may not see).
  const content = await call('apply-content', { productId: ids.product, title: 'Audit jacket, new title' })
  await inside(() => db().agentApproval.update({ where: { id: content.approvalId }, data: { preview: { action: 'apply-content', costPrice: 4.2, changes: { title: { from: 'Audit jacket', to: 'Audit jacket, new title' } } } } }))
  story.content = { label: 'queued', runId: await runIdOf(content.approvalId), approvalId: content.approvalId }

  // The other business: one call of its own.
  await inside(() => call('product-search', { query: 'AUDIT' }, claude('grant-bravo', B)), B)
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

const byRun = (rows: ActivityRow[]) => new Map(rows.map((row) => [row.runId, row]))

describe('C8 — one row per call Claude made, and what became of it', { timeout: TIMEOUT }, () => {
  it('every call, newest first, with its outcome', async () => {
    const { rows, nextCursor } = await activity()
    expect(nextCursor).toBeNull()
    expect(rows).toHaveLength(Object.keys(story).length)
    const at = rows.map((row) => new Date(row.at).getTime())
    expect(at).toEqual([...at].sort((a, b) => b - a))
    const found = byRun(rows)
    for (const [key, { label, runId }] of Object.entries(story)) expect({ key, outcome: found.get(runId)?.outcome }).toEqual({ key, outcome: label })
  })

  it('who, over which connection, which tool, and the change it made with its undo state', async () => {
    const found = byRun((await activity()).rows)
    expect(found.get(story.read.runId)).toMatchObject({ tool: 'product-search', who: { userId: ids.person, name: 'Ada Audit' }, connection: { id: 'grant-one' } })
    expect(found.get(story.refused.runId)).toMatchObject({ tool: 'set-price', note: expect.stringContaining('you named Some other business') })
    expect(found.get(story.undone.runId)).toMatchObject({
      tool: 'set-price',
      approval: { id: story.undone.approvalId, status: 'executed', decisionVia: 'auto' },
      change: { id: expect.any(String), reversibility: 'full', undo: 'done', undoneByApprovalId: story.auto.approvalId },
    })
    expect(found.get(story.auto.runId)).toMatchObject({
      tool: 'undo-change', connection: { id: 'grant-two' },
      approval: { id: story.auto.approvalId, tool: 'set-price', decisionVia: 'auto' },
      change: { undo: 'possible' },
    })
    expect(found.get(story.handedBack.runId)).toMatchObject({ approval: { status: 'pending', note: expect.stringContaining('not run') } })
    expect(found.get(story.rejected.runId)).toMatchObject({ approval: { status: 'rejected', decidedBy: 'Ada Audit' } })
  })

  it('filters: a tool (the call’s or the change’s), an outcome, a connection, a time window', async () => {
    const undoCalls = (await activity({ tool: 'undo-change' })).rows
    expect(undoCalls.map((row) => row.runId)).toEqual([story.auto.runId])
    const priceRows = (await activity({ tool: 'set-price' })).rows.map((row) => row.runId)
    expect(priceRows).toContain(story.auto.runId) // the undo's change is a set-price
    expect(priceRows).not.toContain(story.read.runId)
    expect((await activity({ outcome: 'auto' })).rows.map((row) => row.runId)).toEqual([story.auto.runId])
    expect((await activity({ outcome: 'undone' })).rows.map((row) => row.runId)).toEqual([story.undone.runId])
    expect((await activity({ connectionId: 'grant-two' })).rows.map((row) => row.runId)).toEqual([story.auto.runId])
    expect((await activity({ connectionId: 'grant-nobody' })).rows).toEqual([])
    const all = (await activity()).rows
    const middle = all.find((row) => row.runId === story.handedBack.runId)!
    const after = (await activity({ from: middle.at })).rows.map((row) => row.runId)
    expect(after).toContain(story.handedBack.runId)
    expect(after).not.toContain(story.read.runId)
    const before = (await activity({ to: middle.at })).rows.map((row) => row.runId)
    expect(before).toContain(story.read.runId)
    expect(before).not.toContain(story.expired.runId)
  })

  it('cursor paging: page after page, every row once, and the end says so', async () => {
    const all = (await activity()).rows.map((row) => row.runId)
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const out = await activity({ limit: 3, ...(cursor ? { cursor } : {}) })
      expect(out.rows.length).toBeLessThanOrEqual(3)
      seen.push(...out.rows.map((row) => row.runId))
      if (!out.nextCursor) break
      cursor = out.nextCursor
    }
    expect(seen).toEqual(all)
    // With an outcome filter the cursor walks the calls, not the matches.
    const firstAuto = await activity({ outcome: 'queued', limit: 1 })
    expect(firstAuto.rows).toHaveLength(1)
    const nextAuto = await activity({ outcome: 'queued', limit: 1, cursor: firstAuto.nextCursor })
    expect(nextAuto.rows.map((row) => row.runId)).not.toEqual(firstAuto.rows.map((row) => row.runId))
    await expect(activity({ cursor: 'not-a-cursor' })).rejects.toThrow(/cursor/)
  })

  it('previews through the reader’s own money filter', async () => {
    const full = byRun((await activity()).rows)
    expect(full.get(story.content.runId)?.preview).toMatchObject({ costPrice: 4.2 })
    expect(full.get(story.undone.runId)?.preview).toMatchObject({ action: 'set-price' })
    const limited = byRun((await activity({}, reader(CONTENT_ONLY))).rows)
    // apply-content is theirs to see, without the cost; set-price is not theirs at all.
    expect(limited.get(story.content.runId)?.preview).toMatchObject({ action: 'apply-content' })
    expect(limited.get(story.content.runId)?.preview).not.toHaveProperty('costPrice')
    expect(limited.get(story.undone.runId)).toMatchObject({ preview: null, previewHidden: expect.stringContaining('set-price') })
  })

  it('another business’s calls are never in the list', async () => {
    const inB = (await activity({}, reader(EVERYTHING), B)).rows
    expect(inB).toHaveLength(1)
    expect(inB[0]).toMatchObject({ tool: 'product-search', connection: { id: 'grant-bravo' } })
    expect((await activity()).rows.some((row) => row.connection.id === 'grant-bravo')).toBe(false)
  })
})

describe('C8 — claude-activity, the read tool', { timeout: TIMEOUT }, () => {
  it('needs ai.view, reads its business, and stamps it', async () => {
    const tool = getTool('claude-activity')!
    expect(tool).toMatchObject({ readOnly: true, requires: [F.aiView] })
    expect(tool.execute).toBeUndefined()
    const answer = await call('claude-activity', { outcome: 'undone' })
    expect(answer).toMatchObject({ business: { id: A, name: names.A }, rows: [{ runId: story.undone.runId, outcome: 'undone' }] })
    const refused = await call('claude-activity', { cursor: 'not-a-cursor' })
    expect(refused.error).toMatch(/cursor/)
  })
})

describe('C8 — events: ids, names and counts only', { timeout: TIMEOUT }, () => {
  const outbox = (type: string) => inside(() => db().eventOutbox.findMany({ where: { type }, orderBy: { occurredAt: 'asc' } }))

  it('agent.change.executed with each recorded change, agent.change.undone when its undo ran', async () => {
    const changes = await inside(() => db().agentChange.findMany({ where: { approvalId: { in: [story.undone.approvalId!, story.auto.approvalId!] } } }))
    const executed = (await outbox('agent.change.executed')).map((row) => row.payload)
    for (const change of changes) {
      expect(executed).toContainEqual({ changeId: change.id, approvalId: change.approvalId, tool: 'set-price', via: 'claude', decisionVia: 'auto' })
    }
    const undone = (await outbox('agent.change.undone')).map((row) => row.payload)
    const first = changes.find((change) => change.approvalId === story.undone.approvalId)!
    expect(undone).toEqual([{ changeId: first.id, undoneByApprovalId: story.auto.approvalId }])
  })

  it('agent.autorun.paused when a business pauses, once', async () => {
    await inside(() => pauseAutoRuns({ userId: ids.person, label: 'Ada Audit', canManage: true }, 'audit check'))
    await inside(() => pauseAutoRuns({ userId: ids.person, label: 'Ada Audit', canManage: true }, 'again'))
    const paused = await outbox('agent.autorun.paused')
    expect(paused).toHaveLength(1)
    expect(paused[0].payload).toEqual({ autonomyId: expect.any(String), automatic: false, failures: null, handedBack: 0 })
    expect(paused[0].subject).toBe((paused[0].payload as { autonomyId: string }).autonomyId)
  })
})

describe('C8 — Undo on the activity page: the person’s click is the approval, through the same window', { timeout: TIMEOUT }, () => {
  const changeOf = async (approvalId: string) => inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))

  it('queues the inverse change as the person, approved by the click, parked for the undo window; the commit runs it', async () => {
    const change = await changeOf(story.auto.approvalId!)
    const before = await priceOf(ids.product)
    const clicked = await inside(() => undoChangeByClick(reader(EVERYTHING), change.id))
    expect(clicked).toMatchObject({ ok: true, approvalId: expect.any(String), tool: 'set-price', undoes: change.id, executeAfter: expect.any(String) })
    if (!clicked.ok) return
    const parked = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: clicked.approvalId } }))
    expect(parked).toMatchObject({ status: 'scheduled', decisionVia: 'nexus', decidedByUserId: ids.person, toolName: 'set-price' })
    const run = await inside(() => db().agentRun.findUniqueOrThrow({ where: { id: parked.agentRunId } }))
    expect(run).toMatchObject({ via: 'app', userId: ids.person, input: { tool: 'undo-change', args: { changeId: change.id } } })
    expect(await priceOf(ids.product)).toBe(before) // nothing inside the window
    expect((await changeOf(story.auto.approvalId!)).undoneByApprovalId).toBe(clicked.approvalId)
    expect(await windowCloses(clicked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await priceOf(ids.product)).toBe(103) // what the change replaced
    expect((await changeOf(story.auto.approvalId!)).undoneAt).not.toBeNull()
    // Not twice.
    expect(await inside(() => undoChangeByClick(reader(EVERYTHING), change.id))).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('already undone') })
  })

  it('refused: a person who may not make the inverse change (403), a change of another business or none (404); nothing queued', async () => {
    const executed = await inside(() => db().agentChange.findFirstOrThrow({ where: { undoneAt: null, toolName: 'set-price' }, orderBy: { executedAt: 'desc' } }))
    const pending = () => inside(() => db().agentApproval.count({ where: { status: { in: ['pending', 'scheduled'] }, toolName: 'set-price' } }))
    const start = await pending()
    expect(await inside(() => undoChangeByClick(reader(CONTENT_ONLY), executed.id))).toMatchObject({ ok: false, status: 403, error: expect.stringContaining('products.price.edit') })
    // A person in the other business, asking for this business's change: not found there.
    expect(await inside(() => undoChangeByClick({ ...reader(EVERYTHING), workspace: business(B) }, executed.id), B)).toMatchObject({ ok: false, status: 404 })
    expect(await inside(() => undoChangeByClick(reader(EVERYTHING), 'no-such-change'))).toMatchObject({ ok: false, status: 404 })
    expect(await pending()).toBe(start)
  })
})
