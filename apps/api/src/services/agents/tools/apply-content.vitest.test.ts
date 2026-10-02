/**
 * MCP full control T2 (docs/mcp-full-control/sections/03-content.md §4.3, live defect #5) — `apply-content` saves
 * through the product writer (`applyProductBulkEdits` → `writeContent`, source tier), never by writing the product row
 * itself. Proved through the doors a person and Claude use (callTool, runOrQueueTool, the Approvals page commit), on
 * PostgreSQL with the production schema (PGlite):
 *
 *   · approved, it bumps the product's version, writes an audit row as the approver, and cascades the follow marker
 *     to the listing that follows the title;
 *   · it saves Nexus only (Owner decision d7): 0 channel updates queued, the listing is not marked "Pending";
 *   · keywords can be applied;
 *   · the writer's warnings are shown in the preview, outside the material fields (`changes` stays the only one);
 *   · the listing-quality keeper still queues its proposals, and they are not stale when nothing moved.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES as F } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// As db.ts wraps it: inside a transaction, `prisma.x` is that transaction's client.
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../../pim/readiness-index.service.js', async () => (await import('../../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
// The real writer. One arm adds a warning to its dry run, as a listed channel's cap would (this fixture has no
// channel schemas, so the real writer finds none here).
const writer = vi.hoisted(() => ({ dryRunWarning: null as null | { field: string; warning: string } }))
vi.mock('../../products/bulk-edit.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../products/bulk-edit.service.js')>()
  return {
    ...real,
    applyProductBulkEdits: async (...args: Parameters<typeof real.applyProductBulkEdits>) => {
      const out = await real.applyProductBulkEdits(...args) as Record<string, any>
      if (!writer.dryRunWarning || !args[0].dryRun) return out
      return { ...out, warnings: [...(out.warnings ?? []), { id: args[0].changes[0].id, ...writer.dryRunWarning }] }
    },
  }
})

import { callTool, systemPrincipal, type UserPrincipal } from '../call-tool.js'
import { runOrQueueTool } from '../approval-gate.service.js'
import { checkStaleness, commitScheduledApproval, decideFleetApproval, MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'

const A = LEGACY_WORKSPACE_ID
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const PERMISSIONS = ['ai.run', F.productsView, F.productsEdit]
let PERSON: UserPrincipal
let account = ''

type Data = Record<string, any>
const db = () => database.client
const product = (id: string) => inside(() => db().product.findUniqueOrThrow({ where: { id } }))
const approval = (id: string) => inside(() => db().agentApproval.findUniqueOrThrow({ where: { id } }))

/** A product with one LIVE Amazon IT listing that follows the master title (as a synced listing: account named). */
async function seed(sku: string) {
  return inside(async () => {
    const p = await db().product.create({ data: { sku, name: `${sku} giacca`, basePrice: '10.00', bulletPoints: ['a', 'b'], description: 'Calda.', keywords: ['giacca'], status: 'ACTIVE' } })
    const listing = await db().channelListing.create({ data: {
      productId: p.id, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', channelConnectionId: account, aliasKey: '',
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `FIXTURE-${sku}`, syncPaused: false, followMasterTitle: true,
      lastSyncStatus: 'SUCCESS', lastSyncedAt: new Date('2026-09-30T10:00:00Z'),
    } as never })
    return { product: p, listing }
  })
}

async function queue(args: Record<string, unknown>, who: UserPrincipal | ReturnType<typeof systemPrincipal> = PERSON) {
  const run = await inside(() => db().agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done' } }))
  const queued = await inside(() => runOrQueueTool('apply-content', args, who, run.id))
  expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
  return queued as { approvalId: string; preview: Data }
}

/** Approve on the Approvals page, close the undo window, and commit, as the page does. */
async function approveAndRun(approvalId: string) {
  expect(await inside(() => decideFleetApproval({ id: approvalId, decision: 'approve', actor: PERSON }))).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const role = await db().role.create({ data: { key: `T2_EDITOR_${randomUUID().slice(0, 8)}`, name: 'Editor', description: 'test', permissions: PERMISSIONS, isSystem: false } })
  const user = await db().userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Content approver' } })
  await db().userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await db().workspaceMembership.create({ data: { workspaceId: A, userId: user.id, status: 'active' } })
  await db().workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  PERSON = { kind: 'user', userId: user.id, label: 'Content approver', permissions: { isOwner: false, permissions: new Set(PERMISSIONS) }, workspace: business, via: 'app' }
  await inside(async () => {
    await db().marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'TEST_AMAZON_IT' } as never })
    account = (await db().channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 't2-amazon', isActive: true, isPrimary: true, externalAccountId: 'SELLER-TEST-T2' } as never })).id
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('T2 — apply-content saves through the product writer', { timeout: 30_000 }, () => {
  it('approved: version bumped, audit row as the approver, follow marker cascaded; 0 channel updates, not "Pending"', async () => {
    const { product: before, listing } = await seed('TEST-SKU-T2-RUN')
    const auditsBefore = await inside(() => db().auditLog.count({ where: { entityType: 'Product', entityId: before.id } }))
    const { approvalId, preview } = await queue({ productId: before.id, title: 'Giacca nuova', keywords: ['giacca', 'moto'] })
    expect(preview.changes).toEqual({
      title: { from: 'TEST-SKU-T2-RUN giacca', to: 'Giacca nuova' },
      keywords: { from: ['giacca'], to: ['giacca', 'moto'] },
    })
    expect(await inside(() => checkStaleness(approvalId))).toEqual({ stale: false, why: null })

    const out = await approveAndRun(approvalId)
    expect(out, out.error).toMatchObject({ ok: true })
    expect((await approval(approvalId)).status).toBe('executed')
    const after = await product(before.id)
    expect(after).toMatchObject({ name: 'Giacca nuova', keywords: ['giacca', 'moto'], bulletPoints: ['a', 'b'], description: 'Calda.', version: before.version + 1 })
    const audits = await inside(() => db().auditLog.findMany({ where: { entityType: 'Product', entityId: before.id }, orderBy: { createdAt: 'asc' } }))
    expect(audits.length).toBe(auditsBefore + 1)
    expect(audits.at(-1)).toMatchObject({ action: 'update', userId: PERSON.userId, after: { title: 'Giacca nuova', keywords: ['giacca', 'moto'] }, metadata: expect.objectContaining({ layer: 'master' }) })
    // Nexus only: the listing follows the new title and keywords, nothing is queued for it, and it does not read "Pending".
    expect(await inside(() => db().outboundSyncQueue.count({ where: { productId: before.id } }))).toBe(0)
    expect(await inside(() => db().channelListingTranslation.findFirst({ where: { channelListingId: listing.id, language: 'it' } }))).toMatchObject({ follows: ['title', 'keywords'] })
    expect(await inside(() => db().channelListing.findUniqueOrThrow({ where: { id: listing.id } }))).toMatchObject({ version: listing.version + 1, lastSyncStatus: 'SUCCESS' })
  })

  it('keywords alone can be applied', async () => {
    const { product: p } = await seed('TEST-SKU-T2-KEYWORDS')
    const out = (await inside(() => callTool(PERSON, 'apply-content', { productId: p.id, keywords: ['moto', 'touring'] }))).visible as { ok: boolean; error?: string; preview?: Data }
    expect(out, out.error).toMatchObject({ ok: true, preview: { changes: { keywords: { from: ['giacca'], to: ['moto', 'touring'] } } } })
    // A preview writes nothing.
    expect(await product(p.id)).toMatchObject({ keywords: ['giacca'], version: p.version })
  })

  it('the writer’s warnings are in the preview, and `changes` stays the only material field', async () => {
    const { product: p } = await seed('TEST-SKU-T2-WARN')
    writer.dryRunWarning = { field: 'bulletPoints', warning: 'Amazon · IT takes at most 5 bullet points' }
    try {
      const out = (await inside(() => callTool(PERSON, 'apply-content', { productId: p.id, bulletPoints: ['1', '2', '3', '4', '5', '6'] }))).visible as { ok: boolean; preview?: Data }
      expect(out).toMatchObject({ ok: true, preview: { warnings: ['bulletPoints: Amazon · IT takes at most 5 bullet points'] } })
    } finally {
      writer.dryRunWarning = null
    }
    expect(MATERIAL_PREVIEW_FIELDS['apply-content']).toEqual(['changes'])
  })

  it('the listing-quality keeper still queues its proposal, and it is not stale when nothing moved', async () => {
    const { product: p } = await seed('TEST-SKU-T2-KEEPER')
    const { approvalId, preview } = await queue({ productId: p.id, description: 'Una descrizione migliore.' }, systemPrincipal('listing-quality-keeper'))
    expect(preview.changes).toEqual({ description: { from: 'Calda.', to: 'Una descrizione migliore.' } })
    expect(await inside(() => checkStaleness(approvalId))).toEqual({ stale: false, why: null })
    // Control: the text moves after the proposal → it is stale.
    await inside(() => db().product.update({ where: { id: p.id }, data: { description: 'Edited in the sheet.' } }))
    expect((await inside(() => checkStaleness(approvalId))).stale).toBe(true)
  })
})
