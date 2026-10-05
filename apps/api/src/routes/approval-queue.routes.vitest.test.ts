/**
 * Approvals grid — the one queue's reads (routes/approval-queue.routes.ts → services/agent-fleet/approval-queue.service.ts).
 *
 *   list     every tool and every asker in one paged list; show=open oldest first, done/all newest first; a stable cursor;
 *            `total` counts everything `show` matches
 *   state    one status from what is stored: waiting · starting · on hold · running · failed · back to you · done …
 *   words    who asked (Claude and the person and connection, a fleet worker, a cron), who decided, the target and its
 *            before → after lines, why it waits under today's rule, whether THIS viewer may approve it, bulk or not
 *   counts   the health strip and the sidebar badge
 *   detail   every line, the timeline from stored times, the recorded change and whether it can be undone
 *
 * The real route in a Fastify app, on a real PostgreSQL (PGlite); the signed-in person resolved as the workspace hook
 * resolves them. Requests queued through the real gate (set-price, apply-content, a change plan) carry the previews the
 * tools really write; the other states are stored as the inbox, the gate and the trust brakes store them.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { QueueCounts, QueueDetail, QueuePage, QueueRow } from '@nexus/shared/approval-queue'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, agentPlanQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))

import { resolvePermissions } from '../lib/auth/rbac.js'
import { createWorkspaceService } from '../services/workspace.service.js'
import { runOrQueueTool } from '../services/agents/approval-gate.service.js'
import type { UserPrincipal } from '../services/agents/call-tool.js'
import { approvalsNeedYouCount, queueStateOf } from '../services/agent-fleet/approval-queue.service.js'
import approvalQueueRoutes from './approval-queue.routes.js'

const A = LEGACY_WORKSPACE_ID
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const PRICES = ['ai.run', 'ai.view', F.productsView, F.productsPriceEdit]
const EVERYTHING = [...PRICES, F.productsEdit]

let ready = false
let app: FastifyInstance
let signedIn = ''
const people: Record<'all' | 'prices' | 'ads', { id: string; principal: UserPrincipal }> = {} as never
const ids: Record<string, string> = {}
const T0 = Date.now() - 3600_000

async function person(label: string, permissions: string[]) {
  const db = database.client
  const role = await db.role.create({ data: { key: `AQ_${randomUUID().slice(0, 8)}`, name: label, description: 'test', permissions, isSystem: false } })
  const user = await db.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: label } })
  await db.userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await db.workspaceMembership.create({ data: { workspaceId: A, userId: user.id, status: 'active' } })
  await db.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  return {
    id: user.id,
    principal: { kind: 'user', userId: user.id, label, permissions: { isOwner: false, permissions: new Set(permissions) }, workspace: business, via: 'app' } as UserPrincipal,
  }
}

type Who = 'all' | 'prices' | 'ads'
const get = (who: Who, url: string) => {
  signedIn = people[who].id
  return app.inject({ method: 'GET', url })
}
const page = async (who: Who, query = '') => (await get(who, `/agent/fleet/approvals/queue${query}`)).json() as QueuePage
const rowOf = async (who: Who, key: string, show = 'open') => {
  const rows = (await page(who, `?show=${show}&limit=200`)).rows
  return rows.find((r) => r.id === ids[key]) as QueueRow
}

beforeAll(async () => {
  database = await formulaDatabase()
  ready = true
  const db = database.client
  people.all = await person('Ana Plan', EVERYTHING)
  people.prices = await person('Pat Prices', PRICES)
  people.ads = await person('Ada Ads', ['ai.run', 'ai.view', F.adsBidsEdit, FIELDS.financialsAdspendView])
  await inside(async () => {
    const p1 = await db.product.create({ data: { sku: 'AQ-GLOVE-M', name: 'Gale glove M', basePrice: '50.00' } })
    const p2 = await db.product.create({ data: { sku: 'AQ-HELM-L', name: 'Helm L', basePrice: '60.00' } })
    const p3 = await db.product.create({ data: { sku: 'AQ-JKT-S', name: 'Jacket S', basePrice: '100.00' } })
    ids.p1 = p1.id
    ids.p2 = p2.id
    ids.p3 = p3.id
    const client = await db.oAuthClient.create({ data: { clientId: `nxc_${randomUUID().replace(/-/g, '')}`, registration: 'dcr', clientName: 'Claude Desktop', redirectUris: ['https://claude.ai/cb'] } })
    const grant = await db.oAuthGrant.create({ data: { workspaceId: A, userId: people.all.id, clientId: client.id, scopes: ['nexus.read', 'nexus.write', 'nexus.run'] } })
    const claude = await db.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'awaiting_approval', via: 'claude', userId: people.all.id, oauthGrantId: grant.id } })
    const fleet = await db.agentRun.create({ data: { agentKey: 'amazon-ads-director', trigger: 'schedule', status: 'done', mode: 'council' } })
    const watchdog = await db.agentRun.create({ data: { agentKey: 'pricing-watchdog', trigger: 'schedule', status: 'done' } })

    const queue = async (key: string, tool: string, args: Record<string, unknown>) => {
      const out = await runOrQueueTool(tool, args, people.all.principal, claude.id, { forceAsk: true })
      expect(out, out.error).toMatchObject({ ok: true, mode: 'queued' })
      ids[key] = out.approvalId!
    }
    // Through the real gate: the previews the tools really write.
    await queue('priceOk', 'set-price', { productId: p1.id, price: 52 }) // +4 %: inside the 10 % limit
    await queue('priceBig', 'set-price', { productId: p3.id, price: 130 }) // +30 %: over it
    await queue('content', 'apply-content', { productId: p2.id, title: 'Helm L, new' })
    await queue('plan', 'submit-change-plan', {
      title: 'Autumn',
      steps: [
        { tool: 'set-price', args: { productId: p1.id, price: 51 } },
        { tool: 'apply-content', args: { productId: p2.id, title: 'Helm L, plan' } },
        { tool: 'set-price', args: { productId: p2.id, price: 61 } },
      ],
    })
    // Stored as the inbox, the gate and the brakes store them.
    const raw = (data: Record<string, unknown>) => db.agentApproval.create({ data: { riskTier: 'high', expiresAt: new Date(Date.now() + 24 * 3600_000), ...data } as never })
    const pricePreview = (id: string, sku: string, from: number, to: number) => ({ action: 'set-price', sku, scope: 'master', changes: { 'base price': { from, to } }, deltaPct: Math.round(((to - from) / from) * 1000) / 10 })
    ids.fleet = (await raw({
      agentRunId: fleet.id,
      toolName: 'set-target-bid',
      status: 'pending',
      args: { targetId: 'ctargetaq0000000000000001', proposedBidCents: 84, why: 'converts at 12 % ACoS' },
      preview: { action: 'set-target-bid', target: { id: 'ctargetaq0000000000000001', expression: 'giacca moto', matchType: 'EXACT' }, campaign: { id: 'camp-aq', name: 'Giacche IT', marketplace: 'IT' }, currency: 'EUR', currentBidCents: 31, proposedBidCents: 84 },
    })).id
    ids.failed = (await raw({ agentRunId: claude.id, toolName: 'set-price', status: 'pending', args: { productId: p1.id, price: 53 }, preview: pricePreview(p1.id, p1.sku, 50, 53), reason: 'execution failed: the channel said no' })).id
    ids.back = (await raw({ agentRunId: claude.id, toolName: 'set-price', status: 'pending', args: { productId: p2.id, price: 62 }, preview: pricePreview(p2.id, p2.sku, 60, 62), reason: 'not run by rule — changes that run by rule were paused in this business' })).id
    const now = new Date()
    ids.starting = (await raw({ agentRunId: claude.id, toolName: 'apply-content', status: 'scheduled', args: { productId: p2.id, title: 'x' }, preview: { action: 'apply-content', productId: p2.id, changes: { title: { from: 'Helm L', to: 'x' } } }, decidedBy: 'Ana Plan', decidedByUserId: people.all.id, decidedAt: now, executeAfter: new Date(now.getTime() + 20_000), decisionVia: 'nexus' })).id
    ids.hold = (await raw({ agentRunId: claude.id, toolName: 'set-price', status: 'scheduled', args: { productId: p3.id, price: 101 }, preview: pricePreview(p3.id, p3.sku, 100, 101), decidedBy: 'Ana Plan', decidedByUserId: people.all.id, decidedAt: now, executeAfter: new Date(now.getTime() + 600_000), decisionVia: 'auto' })).id
    ids.running = (await raw({ agentRunId: watchdog.id, toolName: 'set-price', status: 'executing', args: { productId: p3.id, price: 102 }, preview: pricePreview(p3.id, p3.sku, 100, 102), decidedBy: 'Ana Plan', decidedByUserId: people.all.id, decidedAt: now })).id
    ids.done = (await raw({ agentRunId: claude.id, toolName: 'set-price', status: 'executed', args: { productId: p1.id, price: 51 }, preview: pricePreview(p1.id, p1.sku, 50, 51), decidedBy: 'Ana Plan', decidedByUserId: people.all.id, decidedAt: now, decisionVia: 'auto' })).id
    ids.doneOld = (await raw({ agentRunId: claude.id, toolName: 'set-price', status: 'executed', args: { productId: p1.id, price: 50.5 }, preview: pricePreview(p1.id, p1.sku, 50, 50.5), decidedBy: 'Ana Plan', decidedAt: new Date(Date.now() - 2 * 86400_000), decisionVia: 'auto' })).id
    ids.rejected = (await raw({ agentRunId: claude.id, toolName: 'apply-content', status: 'rejected', args: { productId: p2.id, title: 'y' }, preview: null, decidedBy: 'Ana Plan', decidedByUserId: people.all.id, decidedAt: now, reason: 'too long', operatorNote: 'too long' })).id
    ids.expired = (await raw({ agentRunId: claude.id, toolName: 'set-price', status: 'expired', args: { productId: p1.id, price: 49 }, preview: pricePreview(p1.id, p1.sku, 50, 49), expiresAt: new Date(Date.now() - 60_000) })).id
    ids.replaced = (await raw({ agentRunId: claude.id, toolName: 'set-price', status: 'superseded', args: { productId: p1.id, price: 48 }, preview: pricePreview(p1.id, p1.sku, 50, 48), decidedBy: 'Ana Plan', decidedAt: now, reason: 'superseded — you edited this before approving' })).id
    ids.recorded = (await raw({ agentRunId: claude.id, toolName: 'set-price', status: 'approved', args: { productId: p1.id, price: 47 }, preview: pricePreview(p1.id, p1.sku, 50, 47), decidedBy: 'Ana Plan', decidedAt: now, reason: 'approved; this tool is preview-only (no execute)' })).id
    await db.agentChange.create({ data: { approvalId: ids.done, toolName: 'set-price', via: 'claude', reversibility: 'full', before: { productId: p1.id, price: 50 }, after: { productId: p1.id, price: 51 }, executedAt: now } })

    // A fixed order: each request asked one second after the one before, in the order above.
    const order = ['priceOk', 'priceBig', 'content', 'plan', 'fleet', 'failed', 'back', 'starting', 'hold', 'running', 'done', 'doneOld', 'rejected', 'expired', 'replaced', 'recorded']
    for (const [i, key] of order.entries()) await db.agentApproval.update({ where: { id: ids[key] }, data: { requestedAt: new Date(T0 + i * 1000) } })

    // This business lets Claude run set-price by rule (inside the code default: 10 %).
    await db.agentTool.create({ data: { name: 'set-price', riskTier: 'high', requiresApproval: true, claudeTrust: 'auto' } })
  })

  const workspaces = createWorkspaceService(database.client as never)
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    void (async () => {
      const user = await database.client.userProfile.findUniqueOrThrow({
        where: { id: signedIn },
        select: { id: true, email: true, displayName: true, status: true, permissionsVersion: true, roleAssignments: { select: { role: { select: { key: true } } } } },
      })
      const authUser = { ...user, roleKeys: user.roleAssignments.map((a) => a.role.key) }
      const r = request as unknown as Record<string, unknown>
      r.__sessionLoaded = true
      r.authUser = authUser
      if (process.env.NEXUS_WORKSPACES_ENABLED === '1') {
        const access = await workspaces.membership(user.id, A)
        r.__rbacResolved = { isOwner: access.isOwner, permissions: access.permissions }
        r.workspace = access.context
      } else {
        r.__rbacResolved = await resolvePermissions(authUser as never)
      }
      withWorkspace(business, done)
    })().catch(done)
  })
  await app.register(approvalQueueRoutes)
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app?.close()
  if (ready) await database.close()
}, 30_000)

describe('the one status, from what is stored', () => {
  const at = (s: number) => new Date(T0 + s * 1000)
  it.each([
    [{ status: 'pending', reason: null }, 'waiting'],
    [{ status: 'pending', reason: 'execution failed: x' }, 'failed'],
    [{ status: 'pending', reason: 'execution error: x' }, 'failed'],
    [{ status: 'pending', reason: 'not run — the facts moved' }, 'back_to_you'],
    [{ status: 'pending', reason: 'not run by rule — paused' }, 'back_to_you'],
    [{ status: 'scheduled', reason: null, decidedAt: at(0), executeAfter: at(20) }, 'starting'],
    [{ status: 'scheduled', reason: null, decidedAt: at(0), executeAfter: at(600) }, 'on_hold'],
    [{ status: 'scheduled', reason: null, decidedAt: null, executeAfter: null }, 'starting'],
    [{ status: 'executing', reason: null }, 'running'],
    [{ status: 'executed', reason: null }, 'done'],
    [{ status: 'approved', reason: null }, 'recorded'],
    [{ status: 'rejected', reason: null }, 'rejected'],
    [{ status: 'expired', reason: null }, 'expired'],
    [{ status: 'superseded', reason: null }, 'replaced'],
  ])('%o → %s', (row, state) => {
    expect(queueStateOf({ executeAfter: null, decidedAt: null, ...row } as never)).toBe(state)
  })
})

describe('GET /agent/fleet/approvals/queue', { timeout: 30_000 }, () => {
  it('open: every tool and every asker, oldest first, with the total', async () => {
    const out = await page('all')
    expect(out.total).toBe(10)
    expect(out.nextCursor).toBeNull()
    expect(out.rows.map((r) => r.id)).toEqual(['priceOk', 'priceBig', 'content', 'plan', 'fleet', 'failed', 'back', 'starting', 'hold', 'running'].map((k) => ids[k]))
    expect(Object.fromEntries(out.rows.map((r) => [Object.keys(ids).find((k) => ids[k] === r.id), r.state]))).toEqual({
      priceOk: 'waiting', priceBig: 'waiting', content: 'waiting', plan: 'waiting', fleet: 'waiting',
      failed: 'failed', back: 'back_to_you', starting: 'starting', hold: 'on_hold', running: 'running',
    })
  })

  it('done newest first, all = open + done; a cursor walks the pages without a gap or a repeat', async () => {
    const done = await page('all', '?show=done')
    expect(done.total).toBe(6)
    expect(done.rows.map((r) => r.id)).toEqual(['recorded', 'replaced', 'expired', 'rejected', 'doneOld', 'done'].map((k) => ids[k]))
    expect(done.rows.map((r) => r.state)).toEqual(['recorded', 'replaced', 'expired', 'rejected', 'done', 'done'])
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const next: QueuePage = await page('all', `?show=all&limit=4${cursor ? `&cursor=${cursor}` : ''}`)
      expect(next.total).toBe(16)
      seen.push(...next.rows.map((r) => r.id))
      cursor = next.nextCursor
    } while (cursor)
    expect(seen).toHaveLength(16)
    expect(new Set(seen).size).toBe(16)
  })

  it('a Claude request: who asked (the person and the connection), its product, its change, and why it waits under today’s rule', async () => {
    const row = await rowOf('all', 'priceOk')
    expect(row).toMatchObject({
      toolName: 'set-price',
      title: 'Set master price',
      area: 'pricing',
      rawStatus: 'pending',
      asker: { kind: 'claude', label: 'Claude · Ana', person: 'Ana Plan', connection: 'Claude Desktop' },
      decider: null,
      target: { kind: 'product', id: ids.p1, sku: 'AQ-GLOVE-M', name: 'Gale glove M', count: 1, href: `/products/${ids.p1}/edit` },
      changes: [{ label: 'Base price', from: '€50.00', to: '€52.00' }],
      changeCount: 1,
      reversibility: 'full',
      reachesOutside: true,
      canApprove: true,
      cannotApproveWhy: null,
      bulkApprovable: true,
      bulkBlockedWhy: null,
      automation: { level: 'auto', max: 'auto', whyWaits: 'Your rule for Set master price would run it by itself now; when it was asked, it did not' },
    })
    expect(row.note).toBe(row.automation.whyWaits)
    expect((await rowOf('all', 'priceBig')).automation.whyWaits).toBe('Over your limit: the master price moves 30 %, more than the 10 % allowed without a person')
    expect((await rowOf('all', 'content')).automation).toEqual({ level: 'ask', max: 'auto', whyWaits: 'Your rule for Apply product content: Ask me' })
  })

  it('a fleet worker’s request names the worker; rules apply only to Claude', async () => {
    const row = await rowOf('ads', 'fleet')
    expect(row.asker).toEqual({ kind: 'fleet', label: 'Amazon Ads director', person: null, connection: null })
    expect(row.target).toMatchObject({ kind: 'ad-target', name: '“giacca moto” (exact)', href: '/marketing/ads/campaigns/camp-aq' })
    expect(row).toMatchObject({ channel: 'AMAZON', market: 'IT', changes: [{ label: 'Bid', from: '€0.31', to: '€0.84' }] })
    expect(row.automation.whyWaits).toBe('Rules apply only to Claude’s requests: a person approves every request from Amazon Ads director')
    expect(row).toMatchObject({ canApprove: true, bulkApprovable: true })
    // Ana may not change ads: she may not approve it (in the approve's own words), and its preview is not hers to read.
    const hers = await rowOf('all', 'fleet')
    expect(hers).toMatchObject({ canApprove: false, bulkApprovable: false, changes: [], target: { kind: 'ad-target', id: 'ctargetaq0000000000000001', name: null } })
    expect(hers.cannotApproveWhy).toMatch(/^set-target-bid needs the /)
    expect(hers.channel).toBe('AMAZON') // the kind of tool says Amazon; the market was in the preview
    expect(hers.market).toBeNull()
  })

  it('a change plan: named by its first step, counted by its steps, approved on its own, why it waits', async () => {
    const row = await rowOf('all', 'plan')
    expect(row).toMatchObject({
      toolName: 'submit-change-plan',
      target: { kind: 'product', id: ids.p1, sku: 'AQ-GLOVE-M', count: 3 },
      plan: { steps: 3, byStatus: { pending: 3 } },
      changeCount: 3,
      bulkApprovable: false,
      bulkBlockedWhy: 'A plan is approved on its own',
      automation: { level: 'ask', whyWaits: 'A plan runs by itself only when every step may: your rule for Apply product content is Ask me' },
    })
    expect(row.summary).toMatch(/^Autumn — 3 changes/)
    expect(row.changes.map((c) => c.label)).toEqual(['Set master price', 'Apply product content'])
  })

  it('failed, back to you, starting, on hold, running: each says why or how', async () => {
    expect((await rowOf('all', 'failed')).note).toBe('Failed: the channel said no')
    expect((await rowOf('all', 'back')).note).toBe('Not run by your rule: changes that run by rule were paused in this business')
    const starting = await rowOf('all', 'starting')
    expect(starting).toMatchObject({ decider: { kind: 'person', label: 'Ana Plan' }, note: 'Approved by Ana Plan', canApprove: false, bulkApprovable: false })
    expect(starting.executeAfter).not.toBeNull()
    expect(await rowOf('all', 'hold')).toMatchObject({ decider: { kind: 'rule', label: 'Rule · Set master price' }, note: 'On hold · Runs by your rule' })
    expect(await rowOf('all', 'running')).toMatchObject({ asker: { kind: 'system', label: 'Pricing Watchdog' }, note: 'Running' })
  })

  it('done rows: who decided and what became of it', async () => {
    expect(await rowOf('all', 'done', 'done')).toMatchObject({ note: 'Ran by your rule', decider: { kind: 'rule' } })
    expect(await rowOf('all', 'rejected', 'done')).toMatchObject({ note: 'Rejected: too long', decider: { kind: 'person', label: 'Ana Plan' } })
    expect(await rowOf('all', 'expired', 'done')).toMatchObject({ note: 'Nobody decided in time. Nothing changed.', decider: { kind: 'expiry', label: 'Expired' } })
    expect((await rowOf('all', 'replaced', 'done')).note).toBe('Replaced by an edit')
    expect((await rowOf('all', 'recorded', 'done')).note).toBe('Approved; this kind only previews, so nothing ran')
  })

  it('another viewer: what they may not approve says why, and a preview they may not see shows no change line', async () => {
    const content = await rowOf('prices', 'content')
    expect(content.canApprove).toBe(false)
    expect(content.cannotApproveWhy).toMatch(/apply-content needs the .*products\.edit/)
    expect(content.changes).toEqual([])
    expect(content.target).toMatchObject({ kind: 'product', id: ids.p2, name: 'Helm L' }) // the ids of the request still name it
    const plan = await rowOf('prices', 'plan')
    expect(plan.cannotApproveWhy).toMatch(/^Approving this plan needs what each of its steps needs: apply-content needs/)
    expect((await rowOf('prices', 'priceOk')).canApprove).toBe(true)
  })

  it('a query it cannot read is a 400', async () => {
    expect((await get('all', '/agent/fleet/approvals/queue?show=later')).statusCode).toBe(400)
    expect((await get('all', '/agent/fleet/approvals/queue?limit=500')).statusCode).toBe(400)
    expect((await get('all', '/agent/fleet/approvals/queue?cursor=nope')).statusCode).toBe(400)
  })
})

describe('GET /agent/fleet/approvals/queue/counts and the sidebar badge', { timeout: 30_000 }, () => {
  it('the health strip', async () => {
    const counts = (await get('all', '/agent/fleet/approvals/queue/counts')).json() as QueueCounts
    expect(counts).toEqual({
      needsYou: 6,
      waiting: 5,
      backToYou: 1,
      starting: 1,
      running: 1,
      failed: 1,
      ranByRuleToday: 1,
      oldestNeedsYouAt: new Date(T0).toISOString(),
    })
    expect(await inside(() => approvalsNeedYouCount())).toBe(6)
  })
})

describe('GET /agent/fleet/approvals/queue/:id', { timeout: 30_000 }, () => {
  it('a waiting request: every line, the timeline, what the asker said, and that it can be edited', async () => {
    const detail = (await get('ads', `/agent/fleet/approvals/queue/${ids.fleet}`)).json() as QueueDetail
    expect(detail).toMatchObject({ id: ids.fleet, askerReason: 'converts at 12 % ACoS', change: null, channelResult: null, canEdit: true })
    // The asker's words go with the preview: not to a viewer who may not read it.
    expect(((await get('all', `/agent/fleet/approvals/queue/${ids.fleet}`)).json() as QueueDetail).askerReason).toBeNull()
    expect(detail.timeline).toEqual([{ at: new Date(T0 + 4000).toISOString(), kind: 'asked', words: 'Amazon Ads director asked' }])
    const price = (await get('all', `/agent/fleet/approvals/queue/${ids.priceOk}`)).json() as QueueDetail
    expect(price).toMatchObject({ canEdit: true, allChanges: [{ label: 'Base price', from: '€50.00', to: '€52.00' }] })
    expect((await get('prices', `/agent/fleet/approvals/queue/${ids.content}`)).json()).toMatchObject({ canEdit: false })
  })

  it('a plan: its steps as items', async () => {
    const detail = (await get('all', `/agent/fleet/approvals/queue/${ids.plan}`)).json() as QueueDetail
    expect(detail.items).toHaveLength(3)
    expect(detail.items[0]).toMatchObject({ sku: 'AQ-GLOVE-M', name: 'Gale glove M', change: { label: '1. Set master price · Base price', from: '€50.00', to: '€51.00' } })
  })

  it('a change that ran: when, by which rule, the recorded change and whether it can be undone, what the channel said', async () => {
    const detail = (await get('all', `/agent/fleet/approvals/queue/${ids.done}`)).json() as QueueDetail
    expect(detail.change).toMatchObject({ undoable: true, undoneAt: null, whyNotUndoable: null })
    expect(detail.timeline.map((e) => e.kind)).toEqual(['asked', 'ran'])
    expect(detail.timeline[1].words).toBe('Ran by your rule · Set master price')
    // No price push was queued for it: Nexus says what it knows, never "reached".
    expect(detail.channelResult?.state).toBe('unknown')
    expect(detail.channelResult?.words).toMatch(/No price update was queued/)
  })

  it('a failed run has a moment only when its clock was restamped', async () => {
    const detail = (await get('all', `/agent/fleet/approvals/queue/${ids.failed}`)).json() as QueueDetail
    expect(detail.reason).toBe('execution failed: the channel said no')
    expect(detail.timeline.map((e) => e.kind)).toEqual(['asked', 'failed'])
  })

  it('an unknown id is a 404', async () => {
    expect((await get('all', '/agent/fleet/approvals/queue/nope')).statusCode).toBe(404)
  })
})
