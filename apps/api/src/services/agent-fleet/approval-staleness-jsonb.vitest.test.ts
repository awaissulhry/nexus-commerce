/**
 * AP.6 — an approval given in the Approvals page runs, unless the facts really moved.
 *
 * Every approve from the Approvals page (/fleet/approvals — its fleet queue and its "outside the fleet" queue,
 * where set-price and apply-content wait) goes one way: POST /agent/fleet/approvals/:id/decide →
 * decideFleetApproval parks it for the undo window → the page or the maintenance sweep commits it →
 * commitScheduledApproval re-runs the tool's dry run and compares the material preview fields (checkStaleness) →
 * it runs, or it is handed back.
 *
 * The stored preview is jsonb, which re-orders an object's keys. Compared as plain JSON text, an unchanged
 * set-price or apply-content was handed back as stale every time, so an approved change never ran. This file drives
 * that path on a real PostgreSQL (PGlite) with the real tools and real rows: nothing is mocked in between.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES as F } from '@nexus/shared/permissions'
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
// No Redis here: the queue row is the fact this file reads.
vi.mock('../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))

import { runOrQueueTool } from '../agents/approval-gate.service.js'
import type { UserPrincipal } from '../agents/call-tool.js'
import { checkStaleness, commitScheduledApproval, decideFleetApproval } from './approval-inbox.service.js'

const A = LEGACY_WORKSPACE_ID
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

const PERSON: UserPrincipal = {
  kind: 'user',
  userId: 'u-jsonb',
  label: 'Page approver',
  permissions: { isOwner: false, permissions: new Set(['ai.run', F.productsPriceEdit, F.productsEdit]) },
  workspace: business,
  via: 'app',
}

const ids: Record<string, string> = {}
const product = (sku: string) => inside(() => database.client.product.findUniqueOrThrow({ where: { id: ids[sku] } }))
const approval = (id: string) => inside(() => database.client.agentApproval.findUniqueOrThrow({ where: { id } }))

/** Queue as a person in the app does, and approve on the Approvals page: it is parked, not run. */
async function approveOnThePage(tool: string, args: Record<string, unknown>) {
  const run = await inside(() => database.client.agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done' } }))
  const queued = await inside(() => runOrQueueTool(tool, args, PERSON, run.id))
  expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
  const parked = await inside(() => decideFleetApproval({ id: queued.approvalId!, decision: 'approve', actor: PERSON }))
  expect(parked).toMatchObject({ ok: true, status: 'scheduled' })
  return queued.approvalId!
}

/** The undo window closes (moved into the past rather than waited for), and the page commits it. */
async function commitAfterTheWindow(approvalId: string) {
  await inside(() => database.client.agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    await db.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'AMAZON IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'TEST_AMAZON_IT' } as never })
    // Each listing names its account, as a synced listing does. (One that names none makes the queue writer look the
    // channel's only account up outside the price service's transaction: a second connection, which PGlite has not.)
    const account = await db.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'jsonb-amazon', isActive: true, externalAccountId: 'SELLER-TEST-J' } as never })
    for (const sku of ['J-PRICE', 'J-CONTENT', 'J-PRICE-MOVED', 'J-BULLETS-MOVED']) {
      ids[sku] = (await db.product.create({
        data: { sku, name: `${sku} jacket`, basePrice: '10.00', bulletPoints: ['a', 'b', 'c'], description: 'Warm.' },
      })).id
      await db.channelListing.create({
        data: { productId: ids[sku], channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', channelConnectionId: account.id, price: '10.00', followMasterPrice: true, pricingRule: 'FIXED' } as never,
      })
    }
  })
}, 120_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('AP.6 — an unchanged approval from the Approvals page runs after the undo window', { timeout: 30_000 }, () => {
  it('set-price: the stored preview comes back from jsonb with its keys re-ordered, and still runs', async () => {
    const id = await approveOnThePage('set-price', { productId: ids['J-PRICE'], price: 12 })
    // The control: jsonb really did re-order the keys the tool wrote as { from, to }.
    const stored = (await approval(id)).preview as { changes: Record<string, object> }
    expect(Object.keys(stored.changes['base price'])).toEqual(['to', 'from'])
    expect(await inside(() => checkStaleness(id))).toEqual({ stale: false, why: null })

    const out = await commitAfterTheWindow(id)
    expect(out, out.error).toMatchObject({ ok: true })
    expect((await approval(id)).status).toBe('executed')
    expect(Number((await product('J-PRICE')).basePrice)).toBe(12)
    const pushes = await inside(() => database.client.outboundSyncQueue.findMany({ where: { productId: ids['J-PRICE'] } }))
    expect(pushes.map((row) => row.syncType)).toEqual(['PRICE_UPDATE'])
  })

  it('apply-content: nested bullets and all, it runs', async () => {
    const id = await approveOnThePage('apply-content', { productId: ids['J-CONTENT'], title: 'Better title', bulletPoints: ['x', 'y'] })
    expect(await inside(() => checkStaleness(id))).toEqual({ stale: false, why: null })
    const out = await commitAfterTheWindow(id)
    expect(out, out.error).toMatchObject({ ok: true })
    expect((await approval(id)).status).toBe('executed')
    const stored = await product('J-CONTENT')
    expect([stored.name, stored.bulletPoints]).toEqual(['Better title', ['x', 'y']])
  })
})

describe('AP.6 — a real change in between still hands the approval back', { timeout: 30_000 }, () => {
  it('set-price whose starting price moved is not run', async () => {
    const id = await approveOnThePage('set-price', { productId: ids['J-PRICE-MOVED'], price: 12 })
    await inside(() => database.client.product.update({ where: { id: ids['J-PRICE-MOVED'] }, data: { basePrice: '11.00' } }))
    const out = await commitAfterTheWindow(id)
    expect(out.ok).toBe(false)
    expect(out.error).toContain('not run')
    const row = await approval(id)
    expect(row.status).toBe('pending')
    expect(row.reason).toContain('changes changed')
    expect(Number((await product('J-PRICE-MOVED')).basePrice)).toBe(11)
  })

  it('apply-content whose bullets were re-ordered is not run: array order counts', async () => {
    const id = await approveOnThePage('apply-content', { productId: ids['J-BULLETS-MOVED'], bulletPoints: ['x'] })
    await inside(() => database.client.product.update({ where: { id: ids['J-BULLETS-MOVED'] }, data: { bulletPoints: ['c', 'b', 'a'] } }))
    const out = await commitAfterTheWindow(id)
    expect(out.ok).toBe(false)
    const row = await approval(id)
    expect(row.status).toBe('pending')
    expect(row.reason).toContain('changes changed')
    expect((await product('J-BULLETS-MOVED')).bulletPoints).toEqual(['c', 'b', 'a'])
  })
})
