/**
 * An approval runs only while the person who approved it still may.
 *
 * Every approve from the Approvals page is parked for the undo window, and the page or the maintenance sweep commits
 * it later (commitScheduledApproval). The row kept only the approver's NAME, so the commit could not ask whether that
 * person still held the tool's permissions: a person whose role was taken away inside the window still had their
 * approval run. The row now keeps the person (`decidedByUserId`), and the commit re-reads their permissions in the
 * approval's business — their membership there with business profiles on, their login roles off — before anything
 * runs.
 *
 * Driven on a real PostgreSQL (PGlite) through the real page path with a real tool (publish-listing: its re-checked
 * preview fields are plain values), real roles and real rows.
 */
import { randomUUID } from 'node:crypto'
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
import { commitScheduledApproval, decideFleetApproval } from './approval-inbox.service.js'

const A = LEGACY_WORKSPACE_ID
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

let baseRoleId = ''
let publishRoleId = ''
let productId = ''
let listingId = ''

interface Person { id: string; label: string; membershipId: string; principal: UserPrincipal }

/**
 * A person who may publish listings in business A — through BOTH sources a request reads (login roles, and the
 * membership of the business), so the same test means the same thing with business profiles off and on.
 */
async function publisher(label: string): Promise<Person> {
  const db = database.client
  const user = await db.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: label } })
  for (const roleId of [baseRoleId, publishRoleId]) await db.userRole.create({ data: { userId: user.id, roleId } })
  const membership = await db.workspaceMembership.create({ data: { workspaceId: A, userId: user.id, status: 'active' } })
  for (const roleId of [baseRoleId, publishRoleId]) await db.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId } })
  return {
    id: user.id,
    label,
    membershipId: membership.id,
    principal: {
      kind: 'user',
      userId: user.id,
      label,
      permissions: { isOwner: false, permissions: new Set(['ai.run', F.productsView, F.listingsPublish]) },
      workspace: business,
      via: 'app',
    },
  }
}

/** The publish role taken away, from both sources, as a person managing the team would (the version bumps with it). */
async function takePublishingAway(person: Person) {
  const db = database.client
  await db.userRole.deleteMany({ where: { userId: person.id, roleId: publishRoleId } })
  await db.workspaceMemberRole.deleteMany({ where: { membershipId: person.membershipId, roleId: publishRoleId } })
  await db.userProfile.update({ where: { id: person.id }, data: { permissionsVersion: { increment: 1 } } })
}

/** Queue as a person in the app does, and approve it on the Approvals page: it is parked, not run. */
async function approveOnThePage(person: Person) {
  const run = await inside(() => database.client.agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done' } }))
  const queued = await inside(() => runOrQueueTool('publish-listing', { productId, channel: 'AMAZON' }, person.principal, run.id))
  expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
  const parked = await inside(() => decideFleetApproval({ id: queued.approvalId!, decision: 'approve', actor: person.principal }))
  expect(parked).toMatchObject({ ok: true, status: 'scheduled' })
  return queued.approvalId!
}

/** The undo window closes (moved into the past rather than waited for), and the page commits it. */
async function commitAfterTheWindow(approvalId: string) {
  await inside(() => database.client.agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}

const approval = (id: string) => inside(() => database.client.agentApproval.findUniqueOrThrow({ where: { id } }))
const syncRows = () => inside(() => database.client.outboundSyncQueue.count({ where: { channelListingId: listingId, syncType: 'LISTING_SYNC' } }))
const audits = (action: string) => inside(() => database.client.agentControlAudit.findMany({ where: { action } }))

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  const role = (name: string, permissions: string[]) =>
    db.role.create({ data: { key: `DECIDER_${name}_${randomUUID().slice(0, 8)}`, name, description: 'test', permissions, isSystem: false } })
  baseRoleId = (await role('BASE', ['ai.run', F.productsView])).id
  publishRoleId = (await role('PUBLISH', [F.listingsPublish])).id
  await inside(async () => {
    const account = await db.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'decider-amazon', isActive: true, externalAccountId: 'SELLER-TEST-D' } as never })
    productId = (await db.product.create({ data: { sku: 'DECIDER-1', name: 'Decider jacket', basePrice: '10.00' } })).id
    listingId = (await db.channelListing.create({
      data: { productId, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', channelConnectionId: account.id, title: 'Decider jacket' } as never,
    })).id
  })
}, 120_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('an approval from the Approvals page runs only while its approver still may', { timeout: 30_000 }, () => {
  it('keeps the person beside the name shown, and runs when nothing changed', async () => {
    const person = await publisher('Rosa Approver')
    const id = await approveOnThePage(person)
    expect(await approval(id)).toMatchObject({ status: 'scheduled', decidedBy: 'Rosa Approver', decidedByUserId: person.id })

    const before = await syncRows()
    const out = await commitAfterTheWindow(id)
    expect(out, out.error).toMatchObject({ ok: true })
    expect(await approval(id)).toMatchObject({ status: 'executed', decidedBy: 'Rosa Approver', decidedByUserId: person.id })
    expect(await syncRows()).toBe(before + 1)
  })

  it('a permission taken away during the undo window: not run, handed back with a plain reason', async () => {
    const person = await publisher('Omar Approver')
    const id = await approveOnThePage(person)
    await takePublishingAway(person)

    const before = await syncRows()
    const out = await commitAfterTheWindow(id)
    expect(out).toEqual({ ok: false, error: 'not run — Omar Approver no longer holds listings.publish, which publish listing needs' })
    expect(await syncRows()).toBe(before)
    const row = await approval(id)
    expect(row).toMatchObject({ status: 'pending', decidedBy: null, decidedByUserId: null, executeAfter: null })
    expect(row.reason).toBe('not run — Omar Approver no longer holds listings.publish, which publish listing needs')
    expect((await audits('permission_refused')).some((a) => (a.toValue as { approvalId?: string })?.approvalId === id)).toBe(true)
  })

  it('a person who no longer has access at all: not run', async () => {
    const person = await publisher('Lea Approver')
    const id = await approveOnThePage(person)
    await database.client.userProfile.update({ where: { id: person.id }, data: { status: 'deactivated' } })

    const before = await syncRows()
    const out = await commitAfterTheWindow(id)
    expect(out).toEqual({ ok: false, error: 'not run — Lea Approver no longer has access to this business profile' })
    expect(await syncRows()).toBe(before)
    expect((await approval(id)).status).toBe('pending')
  })

  it('an approve through the gate directly (the /settings/ai page) records the person too', async () => {
    const person = await publisher('Noor Approver')
    const run = await inside(() => database.client.agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done' } }))
    const queued = await inside(() => runOrQueueTool('publish-listing', { productId, channel: 'AMAZON' }, person.principal, run.id))
    const { decideApproval } = await import('../agents/approval-gate.service.js')
    expect(await inside(() => decideApproval(queued.approvalId!, 'approve', person.principal))).toMatchObject({ ok: true, status: 'executed' })
    expect(await approval(queued.approvalId!)).toMatchObject({ decidedBy: 'Noor Approver', decidedByUserId: person.id })
  })

  it('the committed tool runs AS the approver: it records their id, not the name shown', async () => {
    const person = await publisher('Sara Approver')
    const id = await approveOnThePage(person)
    expect(await commitAfterTheWindow(id)).toMatchObject({ ok: true })
    // publish-listing writes the `ctx.userId` it ran with into the push it queues.
    const [push] = await inside(() => database.client.outboundSyncQueue.findMany({
      where: { channelListingId: listingId, syncType: 'LISTING_SYNC' }, orderBy: { createdAt: 'desc' }, take: 1,
    }))
    expect((push.payload as { requestedBy?: string }).requestedBy).toBe(person.id)
    expect(await approval(id)).toMatchObject({ status: 'executed', decidedBy: 'Sara Approver', decidedByUserId: person.id })
  })

  it('a fleet worker proposes as the system; a person approves it; it runs as that person', async () => {
    const person = await publisher('Tomas Approver')
    const run = await inside(() => database.client.agentRun.create({ data: { agentKey: 'pricing-watchdog', trigger: 'cron', status: 'done' } }))
    const { systemPrincipal } = await import('../agents/call-tool.js')
    // As the autonomous agents do (pricing-watchdog, listing-quality-keeper): the proposal is the system's…
    const queued = await inside(() => runOrQueueTool('publish-listing', { productId, channel: 'AMAZON' }, systemPrincipal('pricing-watchdog'), run.id))
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    expect(await approval(queued.approvalId!)).toMatchObject({ decidedBy: null, decidedByUserId: null })
    // …the decision is a person's, and so is the run.
    const parked = await inside(() => decideFleetApproval({ id: queued.approvalId!, decision: 'approve', actor: person.principal }))
    expect(parked).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commitAfterTheWindow(queued.approvalId!)).toMatchObject({ ok: true })
    const [push] = await inside(() => database.client.outboundSyncQueue.findMany({
      where: { channelListingId: listingId, syncType: 'LISTING_SYNC' }, orderBy: { createdAt: 'desc' }, take: 1,
    }))
    expect((push.payload as { requestedBy?: string }).requestedBy).toBe(person.id)
  })

  it('a system run that no person decides (a tool that needs no approval) still runs as the system', async () => {
    const run = await inside(() => database.client.agentRun.create({ data: { agentKey: 'amazon-ads-director', trigger: 'cron', status: 'done' } }))
    const { systemPrincipal } = await import('../agents/call-tool.js')
    const out = await inside(() => runOrQueueTool('product-snapshot', { productId }, systemPrincipal('amazon-ads-director'), run.id))
    expect(out).toMatchObject({ ok: true, mode: 'executed' })
    expect(out.data).toMatchObject({ sku: 'DECIDER-1' })
  })

  it('taking an approve back inside the window forgets the person too', async () => {
    const person = await publisher('Ines Approver')
    const id = await approveOnThePage(person)
    const { undoScheduledApproval } = await import('./approval-inbox.service.js')
    expect(await inside(() => undoScheduledApproval({ id, actor: { label: 'Ines Approver' } as never }))).toEqual({ ok: true })
    expect(await approval(id)).toMatchObject({ status: 'pending', decidedBy: null, decidedByUserId: null })
  })
})
