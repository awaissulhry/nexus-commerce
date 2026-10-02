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
 * Driven on a real PostgreSQL (PGlite) through the real page path with a real tool (publish-listing, on a faked studio
 * service: its re-checked preview fields are plain values), real roles and real rows.
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
/**
 * L5 — publish-listing publishes through the product studio. The studio service is faked here: what this file reads is
 * WHO it publishes as (the user id the submit runs with), not what a channel receives (publish-listing.tools test).
 */
const studio = vi.hoisted(() => ({ submit: vi.fn() }))
vi.mock('../pim/studio-publication.service.js', () => {
  const review = (productId: string) => ({ id: null, productId, scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'account' }, accountLabel: 'decider-amazon',
    aliasLabel: 'Primary listing', mode: 'live', action: 'update', rows: [{ productId, sku: 'DECIDER-1', title: 'Decider jacket', existing: true }], excluded: 0, issues: [],
    expiresAt: '2030-01-01T00:00:00.000Z',
    changes: [{ id: JSON.stringify([productId, 'title']), productId, sku: 'DECIDER-1', field: 'title', label: 'Title', current: { state: 'value', value: 'New title' },
      lastAccepted: { state: 'value', value: 'Decider jacket' }, channel: { state: 'value', value: 'Decider jacket' }, status: 'SEND', selectable: true,
      selectedByDefault: true, localChanged: true, channelChanged: false, reason: 'Nexus changed', operation: 'replace' }] })
  return {
    reviewStudioPublication: async (productId: string) => review(productId),
    previewStudioPublication: async (productId: string, _scope: unknown, userId: string | null) => ({ ...review(productId), id: `review-${userId}` }),
    previewStudioPublicationSelection: async () => ({ token: 'selection-token' }),
    submitStudioPublication: studio.submit,
    readStoredPublication: async () => null,
  }
})
// No Redis here.
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
let priceRoleId = ''
let productId = ''
let listingId = ''

interface Person { id: string; label: string; membershipId: string; principal: UserPrincipal }

/**
 * A person in business A with these roles — through BOTH sources a request reads (login roles, and the membership
 * of the business), so the same test means the same thing with business profiles off and on.
 */
async function personWith(label: string, roles: Array<{ id: string; permissions: string[] }>): Promise<Person> {
  const db = database.client
  const user = await db.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: label } })
  for (const role of roles) await db.userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await db.workspaceMembership.create({ data: { workspaceId: A, userId: user.id, status: 'active' } })
  for (const role of roles) await db.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  return {
    id: user.id,
    label,
    membershipId: membership.id,
    principal: {
      kind: 'user',
      userId: user.id,
      label,
      permissions: { isOwner: false, permissions: new Set(roles.flatMap((role) => role.permissions)) },
      workspace: business,
      via: 'app',
    },
  }
}

const BASE = ['ai.run', F.productsView]
/** A person who may publish listings (L5: products.publish too, as the studio's own Publish needs). */
const publisher = (label: string) => personWith(label, [{ id: baseRoleId, permissions: BASE }, { id: publishRoleId, permissions: [F.productsPublish, F.listingsPublish] }])
/** A person who may change master prices. */
const pricer = (label: string) => personWith(label, [{ id: baseRoleId, permissions: BASE }, { id: priceRoleId, permissions: [F.productsPriceEdit] }])

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
/** How many publishes ran, and as whom (the user id the studio submit ran with). */
const syncRows = async () => studio.submit.mock.calls.length
const publishedAs = () => studio.submit.mock.calls.at(-1)?.[3]
const audits = (action: string) => inside(() => database.client.agentControlAudit.findMany({ where: { action } }))

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  const role = (name: string, permissions: string[]) =>
    db.role.create({ data: { key: `DECIDER_${name}_${randomUUID().slice(0, 8)}`, name, description: 'test', permissions, isSystem: false } })
  baseRoleId = (await role('BASE', ['ai.run', F.productsView])).id
  publishRoleId = (await role('PUBLISH', [F.productsPublish, F.listingsPublish])).id
  studio.submit.mockImplementation(async (_productId: string, id: string) => ({ id, status: 'SUBMITTED', message: 'Submitted to Amazon.', results: [] }))
  priceRoleId = (await role('PRICE', [F.productsPriceEdit])).id
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
    expect(out).toEqual({ ok: false, error: 'not run — Omar Approver no longer holds products.publish and listings.publish, which publish listing needs' })
    expect(await syncRows()).toBe(before)
    const row = await approval(id)
    expect(row).toMatchObject({ status: 'pending', decidedBy: null, decidedByUserId: null, executeAfter: null })
    expect(row.reason).toBe('not run — Omar Approver no longer holds products.publish and listings.publish, which publish listing needs')
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
    // publish-listing submits the studio publication as the `ctx.userId` it ran with.
    expect(publishedAs()).toBe(person.id)
    expect(await approval(id)).toMatchObject({ status: 'executed', decidedBy: 'Sara Approver', decidedByUserId: person.id })
  })

  it('an unchanged set-price approved on the page runs AS the approver: the price audit row names them by id', async () => {
    const person = await pricer('Vera Approver')
    const priced = await inside(() => database.client.product.create({ data: { sku: 'DECIDER-PRICE', name: 'Decider priced jacket', basePrice: '10.00' } }))
    const run = await inside(() => database.client.agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done' } }))
    const queued = await inside(() => runOrQueueTool('set-price', { productId: priced.id, price: 12 }, person.principal, run.id))
    expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
    const parked = await inside(() => decideFleetApproval({ id: queued.approvalId!, decision: 'approve', actor: person.principal }))
    expect(parked).toMatchObject({ ok: true, status: 'scheduled' })

    const out = await commitAfterTheWindow(queued.approvalId!)
    expect(out, out.error).toMatchObject({ ok: true })
    expect(Number((await inside(() => database.client.product.findUniqueOrThrow({ where: { id: priced.id } }))).basePrice)).toBe(12)
    // The master price service's own audit row: who changed this price, by id — not the name shown.
    const audits = (await inside(() => database.client.auditLog.findMany({ where: { entityId: priced.id } })))
      .filter((row) => (row.metadata as { field?: string } | null)?.field === 'basePrice')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ userId: person.id, before: { basePrice: 10 }, after: { basePrice: 12 } })
    expect((audits[0].metadata as { reason?: string }).reason).toBe('agent:set-price')
    expect(await approval(queued.approvalId!)).toMatchObject({ status: 'executed', decidedBy: 'Vera Approver', decidedByUserId: person.id })
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
    expect(publishedAs()).toBe(person.id)
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
