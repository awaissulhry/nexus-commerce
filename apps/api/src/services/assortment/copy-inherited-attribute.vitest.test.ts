/**
 * AE.3 — a Link copy where the variations INHERIT an attribute the receiving business has no column for.
 *
 * Production, 2026-09-29: "Gale Jacket" was shared from Xavia Racing to Motovento with every field group,
 * and Motovento already held all 21 SKUs, so the owner chose "Link" for each. The copy review refused all
 * 20 variations with
 *
 *     Row 0 · supplier_declared_dg_hz_regulation: This attribute is not declared by the selected family
 *
 * In Xavia only the parent stores the attribute (a single value); each variation inherits it. In Motovento the
 * parent stores it as a list, the variations store nothing, and the family links the attribute but does not
 * put it on the master sheet — here a channel-placed attribute. The master column model therefore gives the
 * parent a column only from its own saved value, and a variation none at all, so the variation's INHERIT row
 * met no column. Nothing is stored on such a variation, so inheriting changes nothing: it is linked, and it
 * keeps reading its parent's value.
 *
 * The column model is the REAL one (no mocked sheet-columns service): the premise — no column for the
 * variation in the receiving business, a column in the sharing one — is measured, not assumed. Also mocked,
 * as in copy-run.vitest.test.ts: the product read-cache refresh, the channel catalogue (a copy carries no
 * listing), the queue (Redis), and the image storage providers (no media group is shared).
 *
 * Needs NEXUS_TEST_CONCURRENT_PG_URL (scripts/run-real-postgres-tests.mjs); SKIPS without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import type { TransferProduct } from '../pim/catalog-transfer-plan.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})
vi.mock('../pim/mapping/field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: [], schema: { present: true } }), clearFieldCatalogueCache: () => {} }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: async () => {}, refresh: async () => {} } }))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: async () => ({}), addBulk: async () => [], getJobCounts: async () => ({}), close: async () => {} }
  return {
    resolveRedisTarget: () => ({ kind: 'disabled' }), getRedisRuntimeStatus: () => ({ status: 'disabled' }), redis: { connection: null },
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: () => {} }, channelSyncQueueEvents: { on: () => {} },
    addJobSafely: async () => undefined, resetEnqueueCircuitForTests: () => {}, initializeQueue: async () => {}, closeQueue: async () => {}, getQueueStats: async () => ({}),
  }
})
vi.mock('../cloudinary.service.js', () => ({
  isCloudinaryConfigured: () => true,
  uploadBufferToCloudinary: async () => { throw new Error('no media group is shared in this suite') },
}))
vi.mock('../shopify/media-library.service.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../shopify/media-library.service.js')),
  defaultShopifyMediaAccount: async () => null,
}))

const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const A = 'ws_a_ae3_inherit' // Xavia Racing: shares the products
const B = 'ws_b_ae3_inherit' // Motovento: already holds the same SKUs
const DG = 'supplier_declared_dg_hz_regulation'
const PARENT = 'GALE-JACKET'
const VARIATIONS = ['GALE-JACKET-BLACK-MEN-M', 'GALE-JACKET-BLACK-MEN-S']

describe.skipIf(!concurrentDatabaseUrl())(`AE.3 — a Link copy, variations inheriting an attribute with no column here (needs ${CONCURRENT_PG_ENV})`, () => {
  let shares: typeof import('./assortment-share.service.js')
  let preview: typeof import('./copy-preview.service.js')
  let runs: typeof import('./copy-run.service.js')
  let jobs: typeof import('../pim/catalog-transfer-jobs.js')
  let plan: typeof import('../pim/catalog-transfer-plan.js')

  const user = { ownerA: '', ownerB: '' }
  const family = { A: '', B: '' }
  let shareId = ''
  let jobId = ''
  let runId = ''

  const as = <T>(workspaceId: string, actorUserId: string | null, work: () => Promise<T>) =>
    withWorkspace({ workspaceId, actorUserId, membershipId: null, roleKeys: [] }, work)
  const sql = async (text: string, params: unknown[] = []) => (await database.pool.query(text, params)).rows as Array<Record<string, unknown>>
  const waitForJob = async (states: string[]) => {
    const deadline = Date.now() + 60_000
    let last = ''
    while (Date.now() < deadline) {
      const loaded = await as(B, user.ownerB, () => jobs.readTransferJob(jobId, user.ownerB))
      last = loaded?.job.status ?? 'missing'
      if (states.includes(last)) return loaded!
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`transfer job ${jobId} stayed ${last}, expected ${states.join(' or ')}`)
  }
  /** The master column keys the REAL column model gives this product, in its own business. */
  const masterKeys = async (workspaceId: string, sku: string) => {
    const [product] = await sql(`SELECT id, sku, version, "parentId", "familyId", "isParent", "categoryAttributes" FROM "Product" WHERE "workspaceId" = $1 AND sku = $2`, [workspaceId, sku])
    const contracts = plan.transferContracts('IT', { allowIncompleteSchema: true, allowUnknownMarket: true })
    const columns = await as(workspaceId, null, () => contracts.master(product.familyId as string, { ...product, categories: [] } as unknown as TransferProduct))
    return new Map(columns.map((column) => [column.key, column]))
  }

  beforeAll(async () => {
    database = await concurrentDatabase({ maxConnections: 12 })
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    shares = await import('./assortment-share.service.js')
    preview = await import('./copy-preview.service.js')
    runs = await import('./copy-run.service.js')
    jobs = await import('../pim/catalog-transfer-jobs.js')
    plan = await import('../pim/catalog-transfer-plan.js')
    const assortments = await import('./assortment.service.js')

    const ownerRole = randomUUID(), viewerRole = randomUUID()
    await sql(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,CURRENT_TIMESTAMP)`, [ownerRole])
    await sql(`INSERT INTO "Role" (id, key, name, "isSystem", permissions, "updatedAt") VALUES ($1,'VIEWER','Viewer',true,ARRAY['products.view'],CURRENT_TIMESTAMP)`, [viewerRole])
    for (const key of Object.keys(user) as Array<keyof typeof user>) {
      user[key] = randomUUID()
      await sql(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',CURRENT_TIMESTAMP)`, [user[key], `${key}-${user[key]}@example.test`])
    }
    for (const [id, name] of [[A, 'Xavia Racing'], [B, 'Motovento']]) {
      await sql(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$2,'active','ae3',$1,CURRENT_TIMESTAMP)`, [id, name])
    }
    // A's owner may offer only to a business it belongs to: a viewer in B.
    for (const [workspaceId, userId, roleId] of [[A, user.ownerA, ownerRole], [B, user.ownerA, viewerRole], [B, user.ownerB, ownerRole]]) {
      const membership = randomUUID()
      await sql(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP)`, [membership, workspaceId, userId])
      await sql(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [membership, roleId])
    }
    // The sharing business sells on eBay IT: the copy reads its values in that market.
    await sql(`INSERT INTO "Marketplace" (id, "workspaceId", channel, code, name, region, currency, language, languages, "updatedAt")
      VALUES ($1,$2,'EBAY','IT','eBay Italy','EU','EUR','it',ARRAY['it'],CURRENT_TIMESTAMP)`, [randomUUID(), A])

    // Both businesses define the attribute and link it to their "jackets" family. In A it is on the master
    // sheet; in B it is placed on a channel, so B's master sheet shows it only as a saved value.
    for (const [workspaceId, placement, channels] of [[A, 'shared', []], [B, 'channel', ['AMAZON']]] as const) {
      const group = randomUUID(), attribute = randomUUID(), id = randomUUID()
      await sql(`INSERT INTO "AttributeGroup" (id, "workspaceId", code, label, "updatedAt") VALUES ($1,$2,'compliance','Compliance',CURRENT_TIMESTAMP)`, [group, workspaceId])
      await sql(`INSERT INTO "CustomAttribute" (id, "workspaceId", code, label, "groupId", type, placement, "placementChannels", "updatedAt") VALUES ($1,$2,$3,'Dangerous goods regulation',$4,'text',$5,$6,CURRENT_TIMESTAMP)`, [attribute, workspaceId, DG, group, placement, channels])
      await sql(`INSERT INTO "ProductFamily" (id, "workspaceId", code, label, "updatedAt") VALUES ($1,$2,'jackets','Jackets',CURRENT_TIMESTAMP)`, [id, workspaceId])
      await sql(`INSERT INTO "FamilyAttribute" (id, "workspaceId", "familyId", "attributeId", required, "updatedAt") VALUES ($1,$2,$3,$4,false,CURRENT_TIMESTAMP)`, [randomUUID(), workspaceId, id, attribute])
      family[workspaceId === A ? 'A' : 'B'] = id
    }

    const seed = async (workspaceId: string, sku: string, familyId: string, attrs: Record<string, unknown>, parentId: string | null = null) => {
      const id = randomUUID()
      await sql(
        `INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", status, "parentId", "isParent", "familyId", "categoryAttributes", "updatedAt")
         VALUES ($1,$2,$3,$4,99,'ACTIVE',$5,$6,$7,$8,CURRENT_TIMESTAMP)`,
        [id, workspaceId, sku, `${sku} name`, parentId, parentId === null, familyId, JSON.stringify(attrs)],
      )
      return id
    }
    // A: only the parent stores the value, a single one; the variations inherit it.
    const aParent = await seed(A, PARENT, family.A, { [DG]: 'not_applicable' })
    for (const sku of VARIATIONS) await seed(A, sku, family.A, {}, aParent)
    // B: the same SKUs already exist; the parent stores the value as a list, the variations store nothing.
    const bParent = await seed(B, PARENT, family.B, { [DG]: ['not_applicable'] })
    for (const sku of VARIATIONS) await seed(B, sku, family.B, {}, bParent)

    const created = await as(A, user.ownerA, () => assortments.createAssortment({ name: 'Gale Jacket for Motovento' }))
    await as(A, user.ownerA, () => assortments.addMembers(created.id, { productIds: [aParent], expectedVersion: 1 }))
    const offer = await as(A, user.ownerA, () => shares.offerShare({
      assortmentId: created.id, destinationWorkspaceId: B,
      fieldGroups: ['identity', 'content', 'attributes', 'translations', 'physical', 'compliance', 'structure'],
    }))
    shareId = offer.id
    await as(B, user.ownerB, () => shares.followerDecision(shareId, 'accept', { expectedVersion: 1 }))
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 30_000)

  it('PREMISE — the real column model: A gives a variation the column; B gives only its parent one, from the saved list', async () => {
    expect((await masterKeys(A, VARIATIONS[0])).has(DG)).toBe(true)
    expect((await masterKeys(B, VARIATIONS[0])).has(DG)).toBe(false)
    expect((await masterKeys(B, PARENT)).get(DG)).toMatchObject({ storage: 'categoryAttributes', shape: 'list' })
  }, 60_000)

  it('the copy review with Link for every SKU refuses nothing', async () => {
    const { preview: review } = await as(B, user.ownerB, () => preview.previewCopy({ shareId, market: 'IT' }))
    expect(review.products.map((p) => [p.sku, p.kind])).toEqual([[PARENT, 'match'], ...VARIATIONS.map((sku) => [sku, 'match'])])
    const skuChoices = Object.fromEntries([PARENT, ...VARIATIONS].map((sku) => [sku, 'link']))
    const run = await as(B, user.ownerB, () => runs.confirmCopy({ shareId, market: 'IT', fingerprint: review.fingerprint, skuChoices }))
    runId = run.id
    jobId = run.transferJobId!
    const reviewed = await waitForJob(['QUEUED', 'INVALID'])
    const refused = await sql(`SELECT "targetId", "parsedValues"->'issues' AS issues FROM "ImportJobRow" WHERE "jobId" = $1 AND status = 'INVALID' ORDER BY "targetId"`, [jobId])
    expect(refused).toEqual([])
    expect(reviewed.job.status).toBe('QUEUED')
  }, 120_000)

  it('applies and links all three; the parent keeps its list, the variations store nothing and keep inheriting', async () => {
    const reviewed = await waitForJob(['QUEUED'])
    await as(B, user.ownerB, () => jobs.applyTransferJob(jobId, user.ownerB, reviewed.payload.reviewToken!))
    const applied = await waitForJob(['COMPLETED', 'PARTIAL'])
    const failures = await sql(`SELECT "targetId", "errorMessage" FROM "ImportJobRow" WHERE "jobId" = $1 AND status = 'FAILED'`, [jobId])
    expect(applied.job.status, JSON.stringify({ failures, errors: applied.job.errors })).toBe('COMPLETED')
    const finished = await as(B, user.ownerB, () => runs.advanceCopyRun(runId))
    expect(finished.state).toBe('done')
    expect(finished.counts).toMatchObject({ linked: 3, notSaved: 0, linkRefused: 0 })
    const bags = await sql(`SELECT sku, "categoryAttributes" AS attrs FROM "Product" WHERE "workspaceId" = $1 ORDER BY sku`, [B])
    expect(bags).toEqual([
      { sku: PARENT, attrs: { [DG]: ['not_applicable'] } },
      ...VARIATIONS.map((sku) => ({ sku, attrs: {} })),
    ])
  }, 120_000)
})
