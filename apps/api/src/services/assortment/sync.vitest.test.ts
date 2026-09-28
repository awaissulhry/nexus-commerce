/**
 * Shared stock plan step 6 (research AE.4) — live product sync, end to end, on a real disposable
 * PostgreSQL with the generated policies, profiles ON (contract docs/2026-09-19-shared-stock-build.md §6.1).
 *
 * The real path: a first copy through the real transfer engine (AE.3) → an edit saved in business A
 * (plain SQL: the database must notice it, whoever writes) → the capture trigger's note → the worker in
 * business B → B's product. The worker also runs for real in arm 13, woken by LISTEN/NOTIFY, to measure
 * the delay from A's commit to B's product.
 *
 * Mocked, as in the AE.3 copy test: the master-sheet column dictionary (a fixture), the channel
 * catalogue, the read-cache refresh, the queue (Redis), the network and the two image stores; also the
 * cleanup of an image file's bytes (Cloudinary). Every expected value is written before it is read.
 *
 * 🔴 Needs a MULTI-CONNECTION PostgreSQL (NEXUS_TEST_CONCURRENT_PG_URL): the transfer engine holds a
 * transaction while it checkpoints on a second connection. Run it with scripts/run-real-postgres-tests.mjs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

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
const column = (key: string, storage: string, kind = 'text') => ({ key, writeField: key, label: key, group: 'Shared', kind, storage, scope: 'global', shape: 'scalar', requiredBy: [], editable: true, defaultVisible: true })
vi.mock('../pim/sheet-columns.service.js', () => ({
  getSheetColumns: async () => ({ columns: [
    column('name', 'column'), column('description', 'column'), column('gtin', 'column'), column('weightValue', 'column', 'number'), column('armor_level', 'categoryAttributes'),
  ] }),
  clearSheetColumnCache: () => {},
  coordinatesFor: () => [],
}))
vi.mock('../pim/mapping/field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: [], schema: { present: true } }), clearFieldCatalogueCache: () => {} }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: async () => {}, refresh: async () => {}, refreshMany: async () => {} } }))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: async () => ({}), addBulk: async () => [], getJobCounts: async () => ({}), close: async () => {} }
  return {
    resolveRedisTarget: () => ({ kind: 'disabled' }), getRedisRuntimeStatus: () => ({ status: 'disabled' }), redis: { connection: null },
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: () => {} }, channelSyncQueueEvents: { on: () => {} },
    addJobSafely: async () => undefined, resetEnqueueCircuitForTests: () => {}, initializeQueue: async () => {}, closeQueue: async () => {}, getQueueStats: async () => ({}),
  }
})
const storage = vi.hoisted(() => ({ uploads: [] as string[], cleaned: [] as string[] }))
vi.mock('../cloudinary.service.js', () => ({
  isCloudinaryConfigured: () => true,
  uploadBufferToCloudinary: async (buffer: Buffer, options: { folder: string }) => {
    storage.uploads.push(options.folder)
    const n = storage.uploads.length
    return { url: `https://res.cloudinary.com/follower/image/upload/v1/${options.folder}/copy-${n}.png`, publicId: `${options.folder}/copy-${n}`, width: 1, height: 1, format: 'png', bytes: buffer.length }
  },
}))
vi.mock('../images/media-file-cleanup.service.js', () => ({
  cleanUpUnreferencedMedia: async (file: { publicId: string }) => { storage.cleaned.push(file.publicId) },
}))
vi.mock('../shopify/media-library.service.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../shopify/media-library.service.js')),
  defaultShopifyMediaAccount: async () => null,
}))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const bytesFor = (url: string) => Buffer.concat([PNG, Buffer.from(url)])

const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const A = 'ws_a_ae4_sync'
const B = 'ws_b_ae4_sync'
const C = 'ws_c_ae4_sync'

describe.skipIf(!concurrentDatabaseUrl())(`Shared stock step 6 (AE.4) — live product sync, end to end (needs ${CONCURRENT_PG_ENV})`, () => {
  let assortments: typeof import('./assortment.service.js')
  let shares: typeof import('./assortment-share.service.js')
  let preview: typeof import('./copy-preview.service.js')
  let runs: typeof import('./copy-run.service.js')
  let jobs: typeof import('../pim/catalog-transfer-jobs.js')
  let sync: typeof import('./sync.service.js')
  let worker: typeof import('./sync-worker.js')
  let source: typeof import('./copy-source.service.js')

  const user = { ownerA: '', ownerB: '', ownerC: '' }
  const FILE = {
    jacket: 'https://res.cloudinary.com/owner/image/upload/v1/product-images/a/jacket.png',
    side: 'https://m.media-amazon.com/images/I/jacket-side.jpg',
    medium: 'https://res.cloudinary.com/owner/image/upload/v1/product-images/a/medium.png',
    back: 'https://res.cloudinary.com/owner/image/upload/v1/product-images/a/jacket-back.png',
  }
  const product: Record<string, string> = {}
  const link: Record<string, string> = {}
  let shareId = ''
  let familyA = ''
  let ownerRole = ''

  const as = <T>(workspaceId: string, actorUserId: string | null, work: () => Promise<T>) =>
    withWorkspace({ workspaceId, actorUserId, membershipId: null, roleKeys: [] }, work)
  const sql = async (text: string, params: unknown[] = []) => (await database.pool.query(text, params)).rows as Array<Record<string, unknown>>
  const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0]
  const bProduct = (sku: string) => one(`SELECT * FROM "Product" WHERE "workspaceId" = $1 AND sku = $2`, [B, sku])
  const linkRow = (id: string) => one(`SELECT * FROM "CatalogLink" WHERE id = $1`, [id])
  const pending = (linkId: string) => sql(`SELECT reasons, state FROM "AssortmentChange" WHERE "linkId" = $1 AND state = 'pending'`, [linkId])
  const images = (productId: string) => sql(`SELECT url, alt, type, "isPrimary" FROM "Product" p JOIN "ProductImage" i ON i."productId" = p.id WHERE p.id = $1 ORDER BY i."sortOrder", i.url`, [productId])
  const notices = (type: string) => sql(`SELECT n."userId", n.title, n.body, n."entityId" FROM "Notification" n WHERE n.type = $1 ORDER BY n."createdAt"`, [type])
  /** Run B's worker until nothing waits (what the listener does after a notify). */
  const settle = () => worker.kickAssortmentSync()
  const media = async (workspaceId: string, productId: string, url: string, extra: { type?: string; isPrimary?: boolean; sortOrder?: number; publicId?: string | null } = {}) =>
    sql(`INSERT INTO "ProductImage" (id, "workspaceId", "productId", url, "publicId", type, "mediaType", "isPrimary", "sortOrder", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'IMAGE',$7,$8,CURRENT_TIMESTAMP)`,
      [randomUUID(), workspaceId, productId, url, extra.publicId ?? null, extra.type ?? 'ALT', extra.isPrimary ?? false, extra.sortOrder ?? 0])
  const waitForJob = async (jobId: string, states: string[]) => {
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

  beforeAll(async () => {
    vi.stubGlobal('fetch', async (input: string | URL) => new Response(bytesFor(String(input)), { status: 200, headers: { 'content-type': 'image/png' } }))
    database = await concurrentDatabase({ maxConnections: 16 })
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    assortments = await import('./assortment.service.js')
    shares = await import('./assortment-share.service.js')
    preview = await import('./copy-preview.service.js')
    runs = await import('./copy-run.service.js')
    jobs = await import('../pim/catalog-transfer-jobs.js')
    sync = await import('./sync.service.js')
    worker = await import('./sync-worker.js')
    source = await import('./copy-source.service.js')

    ownerRole = randomUUID()
    await sql(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,CURRENT_TIMESTAMP)`, [ownerRole])
    for (const key of Object.keys(user) as Array<keyof typeof user>) {
      user[key] = randomUUID()
      await sql(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',CURRENT_TIMESTAMP)`, [user[key], `${key}-${user[key]}@example.test`])
    }
    for (const [id, name] of [[A, 'Business A'], [B, 'Business B'], [C, 'Business C']]) {
      await sql(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$2,'active','ae4',$1,CURRENT_TIMESTAMP)`, [id, name])
    }
    const member = async (workspaceId: string, userId: string) => {
      const id = randomUUID()
      await sql(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP)`, [id, workspaceId, userId])
      await sql(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [id, ownerRole])
    }
    await member(A, user.ownerA)
    await member(B, user.ownerA) // an owner of A who belongs to B may offer to B
    await member(B, user.ownerB)
    await member(C, user.ownerB) // an owner of B who belongs to C may offer to C (arm 11)
    await member(C, user.ownerC)

    const group = randomUUID(), armor = randomUUID(), family = randomUUID(), apparel = randomUUID(), jackets = randomUUID()
    await sql(`INSERT INTO "AttributeGroup" (id, "workspaceId", code, label, "updatedAt") VALUES ($1,$2,'safety','Safety',CURRENT_TIMESTAMP)`, [group, A])
    await sql(`INSERT INTO "CustomAttribute" (id, "workspaceId", code, label, "groupId", type, "updatedAt") VALUES ($1,$2,'armor_level','Armour level',$3,'select',CURRENT_TIMESTAMP)`, [armor, A, group])
    for (const code of ['l1', 'l2']) await sql(`INSERT INTO "AttributeOption" (id, "workspaceId", "attributeId", code, label, "updatedAt") VALUES ($1,$2,$3,$4,$4,CURRENT_TIMESTAMP)`, [randomUUID(), A, armor, code])
    await sql(`INSERT INTO "ProductFamily" (id, "workspaceId", code, label, "updatedAt") VALUES ($1,$2,'jackets','Jackets',CURRENT_TIMESTAMP)`, [family, A])
    familyA = family
    await sql(`INSERT INTO "FamilyAttribute" (id, "workspaceId", "familyId", "attributeId", required, "updatedAt") VALUES ($1,$2,$3,$4,true,CURRENT_TIMESTAMP)`, [randomUUID(), A, family, armor])
    await sql(`INSERT INTO "Category" (id, "workspaceId", slug, "updatedAt") VALUES ($1,$2,'apparel',CURRENT_TIMESTAMP)`, [apparel, A])
    await sql(`INSERT INTO "Category" (id, "workspaceId", "parentId", slug, depth, "updatedAt") VALUES ($1,$2,$3,'jackets',1,CURRENT_TIMESTAMP)`, [jackets, A, apparel])

    const seed = async (workspaceId: string, sku: string, extra: { parentId?: string; familyId?: string; attrs?: unknown; name?: string } = {}) => {
      const id = randomUUID()
      await sql(
        `INSERT INTO "Product" (id, "workspaceId", sku, name, description, gtin, "weightValue", "basePrice", status, "productType", "parentId", "familyId", "categoryAttributes", "updatedAt")
         VALUES ($1,$2,$3,$4,'Source description','8000000000001',1.5,99,'ACTIVE','COAT',$5,$6,$7,CURRENT_TIMESTAMP)`,
        [id, workspaceId, sku, extra.name ?? `${sku} name`, extra.parentId ?? null, extra.familyId ?? null, JSON.stringify(extra.attrs ?? {})],
      )
      return id
    }
    product.parent = await seed(A, 'JKT', { familyId: family, attrs: { armor_level: 'l2' } })
    await sql(`UPDATE "Product" SET "isParent" = true WHERE id = $1`, [product.parent])
    product.small = await seed(A, 'JKT-S', { parentId: product.parent, familyId: family })
    product.medium = await seed(A, 'JKT-M', { parentId: product.parent, familyId: family })
    await sql(`INSERT INTO "ProductCategory" ("workspaceId", "productId", "categoryId", "isPrimary") VALUES ($1,$2,$3,true)`, [A, product.parent, jackets])
    await sql(`INSERT INTO "ProductTranslation" (id, "workspaceId", "productId", language, name, "updatedAt") VALUES ($1,$2,$3,'de','Jacke',CURRENT_TIMESTAMP)`, [randomUUID(), A, product.parent])
    await media(A, product.parent, FILE.jacket, { type: 'MAIN', isPrimary: true, publicId: 'product-images/a/jacket' })
    await media(A, product.parent, FILE.side, { sortOrder: 1 })
    await media(A, product.medium, FILE.medium, { type: 'MAIN', isPrimary: true, publicId: 'product-images/a/medium' })

    const created = await as(A, user.ownerA, () => assortments.createAssortment({ name: 'Jackets for B' }))
    await as(A, user.ownerA, () => assortments.addMembers(created.id, { productIds: [product.parent], expectedVersion: 1 }))
    const offer = await as(A, user.ownerA, () => shares.offerShare({
      assortmentId: created.id, destinationWorkspaceId: B,
      fieldGroups: ['identity', 'content', 'attributes', 'translations', 'media', 'physical', 'structure', 'price', 'status'],
    }))
    shareId = offer.id
    await as(B, user.ownerB, () => shares.followerDecision(shareId, 'accept', { expectedVersion: 1 }))

    // The first copy, end to end (AE.3).
    const { preview: review } = await as(B, user.ownerB, () => preview.previewCopy({ shareId, market: 'IT' }))
    const run = await as(B, user.ownerB, () => runs.confirmCopy({ shareId, market: 'IT', fingerprint: review.fingerprint }))
    const reviewed = await waitForJob(run.transferJobId!, ['QUEUED'])
    await as(B, user.ownerB, () => jobs.applyTransferJob(run.transferJobId!, user.ownerB, reviewed.payload.reviewToken!))
    await waitForJob(run.transferJobId!, ['COMPLETED'])
    const finished = await as(B, user.ownerB, () => runs.advanceCopyRun(run.id))
    expect(finished.state, finished.error ?? '').toBe('done')
    for (const row of await sql(`SELECT l.id, s.sku FROM "CatalogLink" l JOIN "Product" s ON s.id = l."sourceProductId" WHERE l."shareId" = $1`, [shareId])) link[row.sku as string] = row.id as string
    for (const sku of ['JKT', 'JKT-S', 'JKT-M']) product[`b:${sku}`] = (await bProduct(sku)).id as string
  }, 240_000)

  afterAll(async () => {
    vi.unstubAllGlobals()
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 30_000)

  it('1. the finish records what each link starts from, and queues one catch-up sync that finds nothing to do', async () => {
    expect(Object.keys(link).sort()).toEqual(['JKT', 'JKT-M', 'JKT-S'])
    for (const id of Object.values(link)) {
      const row = await linkRow(id)
      expect(row.syncMarket).toBe('IT')
      const fields = Object.keys((row.appliedState as { fields: object }).fields)
      expect(fields).toEqual(expect.arrayContaining(['name', 'description', 'gtin', 'weightValue', 'armor_level', 'family', 'parentSku', 'primaryCategoryId', 'sku', 'managed:basePrice', 'managed:status', 'managed:productType']))
    }
    const jacket = await linkRow(link.JKT)
    // Only the parent has a category and its own German title (an empty list is not exported).
    expect(Object.keys((jacket.appliedState as { fields: object }).fields)).toEqual(expect.arrayContaining(['categoryIds', 'name@de']))
    expect((jacket.appliedState as { media: { map: unknown[] } }).media.map).toHaveLength(2) // the stored file and the outside address
    expect(await sql(`SELECT reasons, state FROM "AssortmentChange" WHERE "shareId" = $1 ORDER BY id`, [shareId])).toEqual([
      { reasons: ['copied'], state: 'pending' }, { reasons: ['copied'], state: 'pending' }, { reasons: ['copied'], state: 'pending' },
    ])
    const versions = await sql(`SELECT sku, version FROM "Product" WHERE "workspaceId" = $1 ORDER BY sku`, [B])
    const run = await as(B, null, () => worker.processAssortmentChanges())
    expect(run).toMatchObject({ claimed: 3, synced: 0, unchanged: 3, failed: 0, retried: 0 })
    expect(await sql(`SELECT sku, version FROM "Product" WHERE "workspaceId" = $1 ORDER BY sku`, [B])).toEqual(versions) // nothing written
    expect(await sql(`SELECT DISTINCT state FROM "AssortmentChange" WHERE "shareId" = $1`, [shareId])).toEqual([{ state: 'done' }])
  }, 60_000)

  it('2. an edit saved in A reaches B: text, identity, weight, attribute, German title and price; A is untouched and nothing bounces back', async () => {
    await sql(`UPDATE "Product" SET name = 'JKT renamed', description = 'New description', gtin = '8000000000002', "weightValue" = 2.25,
      "categoryAttributes" = '{"armor_level":"l1"}', "basePrice" = 120, version = version + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE id = $1`, [product.parent])
    await sql(`UPDATE "ProductTranslation" SET name = 'Jacke neu', "updatedAt" = CURRENT_TIMESTAMP WHERE "productId" = $1 AND language = 'de'`, [product.parent])
    // The database noted it, in A's own transactions, as one folded note for the link.
    expect(await pending(link.JKT)).toEqual([{ reasons: ['attributes', 'content', 'identity', 'physical', 'price', 'translations'], state: 'pending' }])
    const aVersion = (await one(`SELECT version FROM "Product" WHERE id = $1`, [product.parent])).version
    const run = await as(B, null, () => worker.processAssortmentChanges())
    expect(run).toMatchObject({ claimed: 1, synced: 1, failed: 0 })
    const jacket = await bProduct('JKT')
    expect(jacket).toMatchObject({ name: 'JKT renamed', description: 'New description', gtin: '8000000000002', status: 'ACTIVE' })
    expect(Number(jacket.weightValue)).toBe(2.25)
    expect(Number(jacket.basePrice)).toBe(120)
    expect(jacket.categoryAttributes).toMatchObject({ armor_level: 'l1' })
    expect((await one(`SELECT name FROM "ProductTranslation" WHERE "productId" = $1 AND language = 'de'`, [jacket.id])).name).toBe('Jacke neu')
    expect((await one(`SELECT version FROM "Product" WHERE id = $1`, [product.parent])).version).toBe(aVersion) // the sync wrote nothing in A
    expect(await sql(`SELECT count(*)::int AS n FROM "AssortmentChange" WHERE state = 'pending'`)).toEqual([{ n: 0 }]) // B's write was not noted
    await new Promise((resolve) => setTimeout(resolve, 300)) // the product event is written after the commit
    expect(await sql(`SELECT data->>'source' AS source FROM "ProductEvent" WHERE "aggregateId" = $1 AND "eventType" = 'PRODUCT_UPDATED'`, [jacket.id])).toEqual([{ source: 'assortment-sync' }])
    const state = (await linkRow(link.JKT)).appliedState as { fields: Record<string, [string, string]> }
    expect(state.fields.name[0]).not.toBe('') // re-fingerprinted
  }, 60_000)

  it('3. a save that changes no followed field (a stock count) is not noted at all', async () => {
    await sql(`UPDATE "Product" SET "totalStock" = 77 WHERE id = $1`, [product.parent])
    await sql(`UPDATE "Product" SET "lastAmazonSync" = CURRENT_TIMESTAMP WHERE id = $1`, [product.small])
    expect(await sql(`SELECT count(*)::int AS n FROM "AssortmentChange" WHERE state = 'pending'`)).toEqual([{ n: 0 }])
  })

  it('4. a field edited in B is kept (an override), and "Follow again" brings the source value back', async () => {
    await sql(`UPDATE "Product" SET description = 'B own text' WHERE id = $1`, [product['b:JKT']])
    await sql(`UPDATE "Product" SET description = 'A text 2', name = 'JKT again' WHERE id = $1`, [product.parent])
    await settle()
    expect(await bProduct('JKT')).toMatchObject({ description: 'B own text', name: 'JKT again' })
    expect((await linkRow(link.JKT)).overrides).toEqual(['description'])
    const view = await as(B, user.ownerB, () => sync.catalogLinkState(product['b:JKT']))
    expect(view.link).toMatchObject({ id: link.JKT, sourceBusiness: 'Business A', status: 'active', heldSku: null })
    expect(view.fields.find((f) => f.key === 'description')?.state).toBe('override')
    expect(view.fields.find((f) => f.key === 'name')?.state).toBe('follow')

    expect(await as(B, user.ownerB, () => worker.followAgain(link.JKT, ['description']))).toEqual({ followed: ['description'] })
    await settle()
    expect((await bProduct('JKT')).description).toBe('A text 2')
    expect((await linkRow(link.JKT)).overrides).toEqual([])
    const after = await as(B, user.ownerB, () => sync.catalogLinkState(product['b:JKT']))
    expect(after.fields.find((f) => f.key === 'description')?.state).toBe('follow')
  }, 60_000)

  it('4b. one product\'s sharing, read from each business (the studio page), and the products grid\'s Source column and filter', async () => {
    const sharing = await import('./product-sharing.service.js')
    // B follows: where it comes from, each field in words, its own stock.
    const followed = await as(B, user.ownerB, () => sharing.productSharing(product['b:JKT']))
    expect(followed.following?.link).toMatchObject({ id: link.JKT, sourceBusiness: 'Business A', status: 'active' })
    const description = followed.following?.fields.find((f) => f.key === 'description')
    expect(description).toMatchObject({ state: 'follow', locale: null })
    expect(description?.label.length).toBeGreaterThan(0)
    expect(followed.following?.fields.find((f) => f.key === 'sku')).toMatchObject({ label: 'SKU', group: 'Product' })
    expect(followed.stock).toEqual({ source: { kind: 'own' }, lentTo: [] })

    // A shares: the assortment that holds it, and what B does with it — for the parent and for a variation.
    const shared = await as(A, user.ownerA, () => sharing.productSharing(product.parent))
    expect(shared.following).toBeNull()
    expect(shared.sharedOut.assortments).toEqual([expect.objectContaining({ holds: true, openShares: 1 })])
    expect(shared.sharedOut.businesses).toEqual([expect.objectContaining({ businessName: 'Business B', shareStatus: 'active', copy: 'following', heldSku: null })])
    const variation = await as(A, user.ownerA, () => sharing.productSharing(product.medium))
    expect(variation.product).toMatchObject({ isVariation: true, rootId: product.parent })
    expect(variation.sharedOut.businesses).toEqual([expect.objectContaining({ businessName: 'Business B', copy: 'following' })])

    // Add and take out, whatever the assortment's rule — on assortments nobody is offered, so no link moves.
    const list = await as(A, user.ownerA, () => assortments.createAssortment({ name: 'Studio list', selection: 'list' }))
    const every = await as(A, user.ownerA, () => assortments.createAssortment({ name: 'Studio every', selection: 'all' }))
    const holds = async (id: string) => (await as(A, user.ownerA, () => sharing.productSharing(product.medium))).sharedOut.assortments.find((a) => a.id === id)?.holds
    expect([await holds(list.id), await holds(every.id)]).toEqual([false, true])
    // A variation is written as its main product.
    const added = await as(A, user.ownerA, () => sharing.setProductInAssortment(list.id, { productId: product.medium, holds: true, expectedVersion: list.version }))
    const leftOut = await as(A, user.ownerA, () => sharing.setProductInAssortment(every.id, { productId: product.parent, holds: false, expectedVersion: every.version }))
    expect([await holds(list.id), await holds(every.id)]).toEqual([true, false])
    expect(await sql(`SELECT "productId", mode FROM "AssortmentMember" WHERE "assortmentId" = ANY($1) ORDER BY mode`, [[list.id, every.id]]))
      .toEqual([{ productId: product.parent, mode: 'exclude' }, { productId: product.parent, mode: 'include' }])
    await as(A, user.ownerA, () => sharing.setProductInAssortment(list.id, { productId: product.parent, holds: false, expectedVersion: added.version }))
    await as(A, user.ownerA, () => sharing.setProductInAssortment(every.id, { productId: product.parent, holds: true, expectedVersion: leftOut.version }))
    expect([await holds(list.id), await holds(every.id)]).toEqual([false, true])
    await expect(as(A, user.ownerA, () => sharing.setProductInAssortment(list.id, { productId: product.parent, holds: true, expectedVersion: list.version })))
      .rejects.toMatchObject({ code: 'assortment_changed' })
    await expect(as(B, user.ownerB, () => sharing.setProductInAssortment(list.id, { productId: product['b:JKT'], holds: true, expectedVersion: 3 })))
      .rejects.toMatchObject({ code: 'assortment_not_found' })
    for (const id of [list.id, every.id]) await sql(`DELETE FROM "Assortment" WHERE id = $1`, [id])

    // The grid: each side sees its own fact, and the Source filter narrows by it.
    expect((await as(A, user.ownerA, () => sharing.sharingByProducts([product.parent]))).get(product.parent)).toEqual({ following: null, sharedWith: ['Business B'] })
    expect((await as(B, user.ownerB, () => sharing.sharingByProducts([product['b:JKT']]))).get(product['b:JKT'])).toEqual({ following: { businessName: 'Business A' }, sharedWith: [] })
    const following = await as(B, user.ownerB, () => sharing.sharingSourceCondition(['following'])) as { id: { in: string[] } }
    expect(following.id.in).toContain(product['b:JKT'])
    const own = await as(B, user.ownerB, () => sharing.sharingSourceCondition(['own'])) as { id: { notIn: string[] } }
    expect(own.id.notIn).toContain(product['b:JKT'])
    const out = await as(A, user.ownerA, () => sharing.sharingSourceCondition(['shared'])) as { id: { in: string[] } }
    expect(out.id.in).toContain(product.parent)
    expect(await as(A, user.ownerA, () => sharing.sharingSourceCondition(['own', 'following', 'shared']))).toBeNull()
  }, 60_000)

  it('4c. the shared product\'s listing layout: read from A without its accounts, made in B as drafts on B\'s own account, never doubled', async () => {
    const layout = await import('./listing-layout.service.js')
    // A lists JKT on two eBay accounts: account 1 (primary) on IT with the main listing and an alias "Winter", account 2 on DE.
    const a1 = randomUUID(), a2 = randomUUID(), b1 = randomUUID(), winter = randomUUID()
    await sql(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "accountLabel", "externalAccountId", "isActive", "isPrimary", "updatedAt") VALUES ($1,$3,'EBAY','A main','a-seller-1',true,true,CURRENT_TIMESTAMP), ($2,$3,'EBAY','A outlet','a-seller-2',true,false,CURRENT_TIMESTAMP)`, [a1, a2, A])
    await sql(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "accountLabel", "externalAccountId", "isActive", "isPrimary", "updatedAt") VALUES ($1,$2,'EBAY','B store','b-seller-1',true,true,CURRENT_TIMESTAMP)`, [b1, B])
    await sql(`INSERT INTO "Marketplace" (id, "workspaceId", channel, code, name, region, currency, language, "updatedAt") VALUES ($1,$2,'EBAY','IT','eBay Italy','EU','EUR','it',CURRENT_TIMESTAMP)`, [randomUUID(), B])
    await sql(`INSERT INTO "ProductListingAlias" (id, "workspaceId", "productId", channel, marketplace, "channelConnectionId", label, position, "updatedAt") VALUES ($1,$2,$3,'EBAY','IT',$4,'Winter',1,CURRENT_TIMESTAMP)`, [winter, A, product.parent, a1])
    const listing = (workspaceId: string, productId: string, market: string, connection: string, aliasKey = '') => sql(
      `INSERT INTO "ChannelListing" (id, "workspaceId", "productId", channel, marketplace, region, "channelMarket", "channelConnectionId", "aliasKey", "aliasId", "listingStatus", "isPublished", "syncPaused", "updatedAt")
       VALUES ($1,$2,$3,'EBAY',$4,$4,$5,$6,$7,$8,'ACTIVE',true,false,CURRENT_TIMESTAMP)`, [randomUUID(), workspaceId, productId, market, `EBAY_${market}`, connection, aliasKey, aliasKey || null])
    await listing(A, product.parent, 'IT', a1)
    await listing(A, product.parent, 'IT', a1, winter)
    await listing(A, product.parent, 'DE', a2)

    const view = await as(B, user.ownerB, () => layout.listingLayout(product['b:JKT-M']))
    expect(view).toMatchObject({ rootId: product['b:JKT'], sourceBusiness: 'Business A', accounts: { EBAY: [{ id: b1, label: 'B store', primary: true }] } })
    expect(view.groups.map((g) => [g.key, g.sourceAccount, g.sourceAccounts, g.slots, g.here.suggestedAccountId, g.here.blocked])).toEqual([
      ['EBAY|DE|2', 2, 2, [{ position: 0, label: null }], null, 'eBay DE is not a market of this business. Add it in Settings › Channels.'],
      ['EBAY|IT|1', 1, 2, [{ position: 0, label: null }, { position: 1, label: 'Winter' }], b1, null],
    ])
    // The wall: none of A's accounts crosses it, by id or by name.
    for (const secret of [a1, a2, 'A main', 'A outlet', 'a-seller-1']) expect(JSON.stringify(view)).not.toContain(secret)

    const made = await as(B, user.ownerB, () => layout.applyListingLayout(product['b:JKT'], { choices: [{ key: 'EBAY|IT|1', accountId: b1 }, { key: 'EBAY|DE|2', accountId: b1 }] }))
    expect(made.results).toEqual([
      { key: 'EBAY|IT|1', listings: 3, aliases: 1, refused: null },
      { key: 'EBAY|DE|2', listings: 0, aliases: 0, refused: 'eBay DE is not a market of this business. Add it in Settings › Channels.' },
    ])
    // Inert drafts for the whole family, on B's account: the main listing and the alias "Winter".
    const rows = await sql(`SELECT l."productId", l."aliasKey" = '' AS main, l."listingStatus", l."isPublished", l."syncPaused", l."channelConnectionId"
      FROM "ChannelListing" l WHERE l."workspaceId" = $1 AND l.channel = 'EBAY' ORDER BY 1, 2`, [B])
    expect(rows).toHaveLength(6)
    for (const row of rows) expect(row).toMatchObject({ listingStatus: 'DRAFT', isPublished: false, syncPaused: true, channelConnectionId: b1 })
    expect(await sql(`SELECT label, position FROM "ProductListingAlias" WHERE "workspaceId" = $1`, [B])).toEqual([{ label: 'Winter', position: 1 }])
    // Made again: nothing doubled, and the page says what is here.
    expect((await as(B, user.ownerB, () => layout.applyListingLayout(product['b:JKT'], { choices: [{ key: 'EBAY|IT|1', accountId: b1 }] }))).results)
      .toEqual([{ key: 'EBAY|IT|1', listings: 0, aliases: 0, refused: null }])
    expect(Number((await one(`SELECT count(*) AS n FROM "ChannelListing" WHERE "workspaceId" = $1`, [B])).n)).toBe(6)
    expect((await as(B, user.ownerB, () => layout.listingLayout(product['b:JKT']))).groups.find((g) => g.key === 'EBAY|IT|1')?.here.present[b1]).toEqual({ main: true, aliases: ['Winter'] })
    // A choice naming another business's account, or none, makes nothing.
    expect((await as(B, user.ownerB, () => layout.applyListingLayout(product['b:JKT'], { choices: [{ key: 'EBAY|IT|1', accountId: a1 }, { key: 'EBAY|DE|2', accountId: null }] }))).results)
      .toEqual([{ key: 'EBAY|IT|1', listings: 0, aliases: 0, refused: 'That account is not connected in this business. Reload the page.' }])

    // A's accounts shared with B: one for reading only is never offered (the database refuses a listing on it); one for
    // publishing is, named as A's, and never suggested.
    await sql(`INSERT INTO "ChannelAccountGrant" ("connectionId", "workspaceId", "ownerWorkspaceId", mode, "grantedByUserId") VALUES ($1,$3,$4,'publish',$5), ($2,$3,$4,'read',$5)`, [a1, a2, B, A, user.ownerA])
    const withShared = await as(B, user.ownerB, () => layout.listingLayout(product['b:JKT']))
    expect(withShared.accounts.EBAY.map((a) => [a.label, a.sharedBy])).toEqual([['B store', null], ['A main', 'Business A']])
    expect(withShared.groups.find((g) => g.key === 'EBAY|IT|1')?.here.suggestedAccountId).toBe(b1)
    await sql(`DELETE FROM "ChannelAccountGrant" WHERE "workspaceId" = $1`, [B])

    // The whole share at once, as Settings offers it: one choice per channel and account of A.
    const summary = await as(B, user.ownerB, () => layout.shareLayout(shareId))
    expect(summary.groups).toEqual([
      expect.objectContaining({ key: 'EBAY|1', sourceAccount: 1, sourceAccounts: 2, products: 1, markets: ['IT'], aliases: 1, suggestedAccountId: b1 }),
      expect.objectContaining({ key: 'EBAY|2', sourceAccount: 2, products: 1, markets: ['DE'], aliases: 0, suggestedAccountId: null }),
    ])
    expect(await as(B, user.ownerB, () => layout.applyShareLayout(shareId, { choices: [{ key: 'EBAY|1', accountId: b1 }] })))
      .toEqual({ products: 1, listings: 0, aliases: 0, refused: [] })

    // Step 5 — the publish warning: the same product live on eBay in the other business, in either direction.
    const warning = await import('./shared-listing-warning.js')
    expect(await as(B, user.ownerB, () => warning.sharedListingWarnings(product['b:JKT'], 'EBAY', 'IT'))).toEqual([]) // A's rows have no eBay item yet
    await sql(`UPDATE "ChannelListing" SET "externalListingId" = 'A-ITEM-1' WHERE "workspaceId" = $1 AND "productId" = $2 AND marketplace = 'IT' AND "aliasKey" = ''`, [A, product.parent])
    const fromB = await as(B, user.ownerB, () => warning.sharedListingWarnings(product['b:JKT'], 'EBAY', 'IT'))
    expect(fromB).toHaveLength(1)
    expect(fromB[0].message).toContain('already live on eBay IT in Business A (1 listing)')
    expect(JSON.stringify(fromB)).not.toContain('A-ITEM-1')
    expect(await as(B, user.ownerB, () => warning.sharedListingWarnings(product['b:JKT'], 'EBAY', 'DE'))).toEqual([])
    expect(await as(B, user.ownerB, () => warning.sharedListingWarnings(product['b:JKT'], 'AMAZON', 'IT'))).toEqual([])
    // A product of another business answers nothing, whoever asks.
    expect(await as(B, user.ownerB, () => warning.sharedListingWarnings(product.parent, 'EBAY', 'IT'))).toEqual([])
    // The other direction: B's copy goes live; A is warned when it publishes.
    const bLive = randomUUID()
    await sql(`INSERT INTO "ChannelListing" (id, "workspaceId", "productId", channel, marketplace, region, "channelMarket", "channelConnectionId", "aliasKey", "listingStatus", "isPublished", "externalListingId", "updatedAt")
      VALUES ($1,$2,$3,'EBAY','FR','FR','EBAY_FR',$4,'','ACTIVE',true,'B-ITEM-1',CURRENT_TIMESTAMP)`, [bLive, B, product['b:JKT'], b1])
    expect((await as(A, user.ownerA, () => warning.sharedListingWarnings(product.parent, 'EBAY', 'FR')))[0]?.message).toContain('already live on eBay FR in Business B (1 listing)')
    await sql(`DELETE FROM "ChannelListing" WHERE id = $1`, [bLive])
    await sql(`UPDATE "ChannelListing" SET "externalListingId" = NULL WHERE "externalListingId" = 'A-ITEM-1'`)
  }, 60_000)

  it('5. images: a new source image is copied, a new alt text reaches the copy, a removed image removes the copy; B\'s own image change makes media an override', async () => {
    const bJacket = product['b:JKT']
    const uploads = storage.uploads.length
    await media(A, product.parent, FILE.back, { sortOrder: 2, publicId: 'product-images/a/back' })
    await settle()
    expect(storage.uploads.length).toBe(uploads + 1)
    const copy = `https://res.cloudinary.com/follower/image/upload/v1/product-images/${bJacket}/copy-${storage.uploads.length}.png`
    expect((await images(bJacket)).map((image) => image.url)).toEqual(expect.arrayContaining([copy, FILE.side]))
    expect(await images(bJacket)).toHaveLength(3)

    await sql(`UPDATE "ProductImage" SET alt = 'Side view' WHERE "productId" = $1 AND url = $2`, [product.parent, FILE.side])
    await settle()
    expect((await images(bJacket)).find((image) => image.url === FILE.side)?.alt).toBe('Side view')

    await sql(`DELETE FROM "ProductImage" WHERE "productId" = $1 AND url = $2`, [product.parent, FILE.back])
    await settle()
    expect((await images(bJacket)).map((image) => image.url)).not.toContain(copy)
    expect(await images(bJacket)).toHaveLength(2)
    expect(storage.cleaned).toContain(`product-images/${bJacket}/copy-${storage.uploads.length}`)

    // B's family goes on the media plan: a shared photo is not written behind the Media page. The change stays due,
    // the link says why, and B's owners are told; once the family leaves the plan, the photo arrives.
    const plan = randomUUID()
    await sql(`INSERT INTO "ProductMediaPlan" (id, "workspaceId", "productId", layer, plan, "updatedAt") VALUES ($1,$2,$3,'SHARED','{}'::jsonb,CURRENT_TIMESTAMP)`, [plan, B, bJacket])
    const uploadsBefore = storage.uploads.length
    await media(A, product.parent, FILE.back, { sortOrder: 3, publicId: 'product-images/a/back-2' })
    await settle()
    expect(storage.uploads.length).toBe(uploadsBefore)
    expect(await images(bJacket)).toHaveLength(2)
    expect(String((await linkRow(link.JKT)).lastSyncError)).toContain('managed on the Media page')
    expect((await notices('assortment-sync-refused')).at(-1)?.body).toContain('managed on the Media page')
    await sql(`DELETE FROM "ProductMediaPlan" WHERE id = $1`, [plan])
    expect(await as(B, null, () => worker.queueLinks([link.JKT], 'resync'))).toBe(1)
    await settle()
    expect(storage.uploads.length).toBe(uploadsBefore + 1)
    expect(await images(bJacket)).toHaveLength(3)
    expect((await linkRow(link.JKT)).lastSyncError).toBeNull()
    await sql(`DELETE FROM "ProductImage" WHERE "productId" = $1 AND "publicId" = 'product-images/a/back-2'`, [product.parent])
    await settle()
    expect(await images(bJacket)).toHaveLength(2)

    await media(B, bJacket, 'https://res.cloudinary.com/follower/image/upload/v1/b-own.png', { sortOrder: 9, publicId: 'b-own' })
    await sql(`UPDATE "ProductImage" SET alt = 'Side view 2' WHERE "productId" = $1 AND url = $2`, [product.parent, FILE.side])
    await settle()
    expect((await images(bJacket)).find((image) => image.url === FILE.side)?.alt).toBe('Side view') // kept: B changed its images itself
    expect((await linkRow(link.JKT)).overrides).toEqual(['media'])
  }, 60_000)

  it('6. SKU: renamed in B when B is not live; held with a notice while B is live, applied once it is not; a SKU taken in B is held too', async () => {
    await sql(`UPDATE "Product" SET sku = 'JKT-S2' WHERE id = $1`, [product.small])
    await settle()
    expect((await one(`SELECT sku FROM "Product" WHERE id = $1`, [product['b:JKT-S']])).sku).toBe('JKT-S2')

    const listing = randomUUID()
    await sql(`INSERT INTO "ChannelListing" (id, "workspaceId", "productId", channel, marketplace, region, "channelMarket", "listingStatus", "isPublished", quantity, "updatedAt")
      VALUES ($1,$2,$3,'EBAY','IT','IT','EBAY_IT','ACTIVE',true,1,CURRENT_TIMESTAMP)`, [listing, B, product['b:JKT-M']])
    await sql(`UPDATE "Product" SET sku = 'JKT-M2' WHERE id = $1`, [product.medium])
    await settle()
    expect((await one(`SELECT sku FROM "Product" WHERE id = $1`, [product['b:JKT-M']])).sku).toBe('JKT-M')
    const held = await linkRow(link['JKT-M'])
    expect(held).toMatchObject({ heldSku: 'JKT-M2' })
    expect(String(held.heldReason)).toContain('live on EBAY')
    // Both owners of B are told (owner A is an owner of B too in this setup).
    expect((await notices('assortment-sku-held')).map((n) => [n.userId, n.title]).sort()).toEqual([
      [user.ownerA, 'SKU change waiting: JKT-M → JKT-M2'], [user.ownerB, 'SKU change waiting: JKT-M → JKT-M2']].sort())

    await sql(`UPDATE "ChannelListing" SET "listingStatus" = 'ENDED' WHERE id = $1`, [listing])
    expect(await as(B, null, () => worker.queueStaleLinks())).toBeGreaterThanOrEqual(1) // the held rename is behind
    await settle()
    expect((await one(`SELECT sku FROM "Product" WHERE id = $1`, [product['b:JKT-M']])).sku).toBe('JKT-M2')
    expect(await linkRow(link['JKT-M'])).toMatchObject({ heldSku: null, heldReason: null })

    // Still on the channel, though not active: an INACTIVE listing with a channel id keeps the old SKU too.
    await sql(`UPDATE "ChannelListing" SET "listingStatus" = 'INACTIVE', "isPublished" = false, "externalListingId" = 'EXT-JKT-M' WHERE id = $1`, [listing])
    await sql(`UPDATE "Product" SET sku = 'JKT-M3' WHERE id = $1`, [product.medium])
    await settle()
    expect((await one(`SELECT sku FROM "Product" WHERE id = $1`, [product['b:JKT-M']])).sku).toBe('JKT-M2')
    const inactive = await linkRow(link['JKT-M'])
    expect(inactive).toMatchObject({ heldSku: 'JKT-M3' })
    expect(String(inactive.heldReason)).toContain('still listed on EBAY, though not active there')
    // A shared eBay listing variant names the SKU as well: with the listing ended, it alone holds the rename.
    await sql(`UPDATE "ChannelListing" SET "listingStatus" = 'ENDED' WHERE id = $1`, [listing])
    const member = randomUUID()
    await sql(`INSERT INTO "SharedListingMembership" (id, "workspaceId", marketplace, sku, "itemId", "parentSku", "productId", "variationSpecifics", "updatedAt")
      VALUES ($1,$2,'IT','JKT-M2','ITEM-JKT','JKT',$3,'{}'::jsonb,CURRENT_TIMESTAMP)`, [member, B, product['b:JKT-M']])
    expect(await as(B, null, () => worker.queueStaleLinks())).toBeGreaterThanOrEqual(1)
    await settle()
    expect((await one(`SELECT sku FROM "Product" WHERE id = $1`, [product['b:JKT-M']])).sku).toBe('JKT-M2')
    expect(String((await linkRow(link['JKT-M'])).heldReason)).toContain('live on EBAY')
    // A back to JKT-M2: nothing is waiting any more.
    await sql(`DELETE FROM "SharedListingMembership" WHERE id = $1`, [member])
    await sql(`UPDATE "Product" SET sku = 'JKT-M2' WHERE id = $1`, [product.medium])
    await settle()
    expect(await linkRow(link['JKT-M'])).toMatchObject({ heldSku: null, heldReason: null })

    await sql(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ($1,$2,'B-OWN','B own product',5,CURRENT_TIMESTAMP)`, [randomUUID(), B])
    await sql(`UPDATE "Product" SET sku = 'B-OWN' WHERE id = $1`, [product.small])
    await settle()
    expect((await one(`SELECT sku FROM "Product" WHERE id = $1`, [product['b:JKT-S']])).sku).toBe('JKT-S2')
    const taken = await linkRow(link['JKT-S'])
    expect(taken.heldSku).toBe('B-OWN')
    expect(String(taken.heldReason)).toContain('already has a product with the SKU B-OWN')
    // The test listing goes: this disposable database has no eBay marketplace settings for later applies.
    await sql(`DELETE FROM "ChannelListing" WHERE id = $1`, [listing])
  }, 90_000)

  it('7. a variation added in A is created and linked in B; one whose SKU B already has is left for a person; one deleted in A is detached, and B keeps it', async () => {
    // Sharing studio step 3: B's family has draft listings (test 4c) and one listing on a channel, on eBay UK.
    const bStore = (await one(`SELECT id FROM "ChannelConnection" WHERE "workspaceId" = $1`, [B])).id as string
    const onChannel = randomUUID()
    await sql(`INSERT INTO "ChannelListing" (id, "workspaceId", "productId", channel, marketplace, region, "channelMarket", "channelConnectionId", "listingStatus", "isPublished", "externalListingId", "updatedAt")
      VALUES ($1,$2,$3,'EBAY','UK','UK','EBAY_UK',$4,'ACTIVE',true,'EXT-UK',CURRENT_TIMESTAMP)`, [onChannel, B, product['b:JKT'], bStore])
    const large = randomUUID()
    await sql(`INSERT INTO "Product" (id, "workspaceId", sku, name, description, "basePrice", status, "productType", "parentId", "familyId", "updatedAt")
      VALUES ($1,$2,'JKT-L','JKT-L name','Large',99,'ACTIVE','COAT',$3,$4,CURRENT_TIMESTAMP)`, [large, A, product.parent, familyA])
    expect(await pending(link.JKT)).toEqual([{ reasons: ['structure'], state: 'pending' }])
    await settle()
    const made = await bProduct('JKT-L')
    expect(made).toMatchObject({ name: 'JKT-L name', description: 'Large', parentId: product['b:JKT'], status: 'ACTIVE', productType: 'COAT' })
    expect(Number(made.basePrice)).toBe(99)
    const largeLink = await one(`SELECT * FROM "CatalogLink" WHERE "sourceProductId" = $1 AND status = 'active'`, [large])
    expect(largeLink).toMatchObject({ targetProductId: made.id, linkedBy: 'created', syncMarket: 'IT' })
    expect(Object.keys((largeLink.appliedState as { fields: object }).fields)).toEqual(expect.arrayContaining(['name', 'sku', 'managed:basePrice']))
    expect((await notices('assortment-sync-created')).at(-1)?.body).toContain('variation JKT-L')
    // It joined the family's draft listings (the main one and the alias), as drafts; the listing on eBay UK is untouched,
    // and the owners are told to add it there.
    expect(await sql(`SELECT marketplace, "aliasKey" = '' AS main, "listingStatus", "syncPaused" FROM "ChannelListing" WHERE "productId" = $1 ORDER BY 2 DESC`, [made.id]))
      .toEqual([{ marketplace: 'IT', main: true, listingStatus: 'DRAFT', syncPaused: true }, { marketplace: 'IT', main: false, listingStatus: 'DRAFT', syncPaused: true }])
    expect((await notices('assortment-variation-live-listing')).map((n) => [n.title, n.body]).at(-1)).toEqual([
      "New variation JKT-L: add it to JKT's live listings",
      'It came from the shared product and joined the draft listings. The listings already on a channel were not changed: eBay UK. Add it there before their next publish.',
    ])
    await sql(`DELETE FROM "ChannelListing" WHERE id = $1`, [onChannel])

    await sql(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ($1,$2,'JKT-XL','B own XL',5,CURRENT_TIMESTAMP)`, [randomUUID(), B])
    await sql(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", status, "parentId", "familyId", "updatedAt") VALUES ($1,$2,'JKT-XL','JKT-XL name',99,'ACTIVE',$3,$4,CURRENT_TIMESTAMP)`, [randomUUID(), A, product.parent, familyA])
    await settle()
    expect(await bProduct('JKT-XL')).toMatchObject({ name: 'B own XL', parentId: null })
    // One notice per owner of B (two here), however many runs see it: an unread notice is not repeated.
    expect((await notices('assortment-variation-exists')).map((n) => [n.userId, n.title]).sort()).toEqual([
      [user.ownerA, 'New shared variation JKT-XL was not linked'], [user.ownerB, 'New shared variation JKT-XL was not linked']].sort())
    // Read, it is not sent again: the next sync of the parent still sees the conflict, and says nothing new.
    await sql(`UPDATE "Notification" SET "readAt" = CURRENT_TIMESTAMP WHERE type = 'assortment-variation-exists'`)
    await sql(`UPDATE "Product" SET description = 'Parent, edited again' WHERE id = $1`, [product.parent])
    await settle()
    expect(await notices('assortment-variation-exists')).toHaveLength(2)

    await sql(`UPDATE "Product" SET "deletedAt" = CURRENT_TIMESTAMP WHERE id = $1`, [large])
    await settle()
    expect(await one(`SELECT status, "detachedReason" FROM "CatalogLink" WHERE id = $1`, [largeLink.id])).toEqual({ status: 'detached', detachedReason: 'no longer shared, or deleted in the business that shares it' })
    expect((await bProduct('JKT-L')).deletedAt).toBeNull()
    expect((await notices('assortment-link-detached')).map((n) => n.title)).toEqual(['JKT-L no longer follows a shared product', 'JKT-L no longer follows a shared product'])
  }, 90_000)

  it('7b. a list emptied in A (every category removed) is not followed, and B is told so instead of it being marked done', async () => {
    const before = await sql(`SELECT c.slug FROM "ProductCategory" pc JOIN "Category" c ON c.id = pc."categoryId" WHERE pc."productId" = $1`, [product['b:JKT']])
    expect(before).toEqual([{ slug: 'jackets' }])
    await sql(`DELETE FROM "ProductCategory" WHERE "productId" = $1`, [product.parent])
    expect((await pending(link.JKT))[0]?.reasons).toContain('attributes')
    await settle()
    expect(await sql(`SELECT c.slug FROM "ProductCategory" pc JOIN "Category" c ON c.id = pc."categoryId" WHERE pc."productId" = $1`, [product['b:JKT']])).toEqual(before)
    expect(String((await linkRow(link.JKT)).lastSyncError)).toContain('categoryIds: the shared product has no value here now')
    expect((await notices('assortment-sync-refused')).map((n) => n.title)).toContain('JKT: some shared changes could not be applied')
    // Put back, so the later arms start from a category again.
    await sql(`INSERT INTO "ProductCategory" ("workspaceId", "productId", "categoryId", "isPrimary") SELECT $1, $2, id, true FROM "Category" WHERE "workspaceId" = $1 AND slug = 'jackets'`, [A, product.parent])
    await settle()
    expect((await linkRow(link.JKT)).lastSyncError).toBeNull()
  }, 60_000)

  it('8. a paused share notes nothing; resuming it catches every link up', async () => {
    const version = (await one(`SELECT version FROM "AssortmentShare" WHERE id = $1`, [shareId])).version
    await as(A, user.ownerA, () => shares.ownerAction(shareId, 'pause', { expectedVersion: version }))
    await sql(`UPDATE "Product" SET name = 'Named while paused' WHERE id = $1`, [product.parent])
    expect(await sql(`SELECT count(*)::int AS n FROM "AssortmentChange" WHERE state = 'pending'`)).toEqual([{ n: 0 }])
    // The door agrees: a paused share is not followed.
    expect(await as(B, null, () => source.linkSource(link.JKT)).catch((error: { code?: string }) => error.code)).toBe('share_not_active')
    await as(A, user.ownerA, () => shares.ownerAction(shareId, 'resume', { expectedVersion: version + 1 }))
    // Every active link of the share (JKT-L's link was detached in arm 7).
    expect(await sql(`SELECT reasons FROM "AssortmentChange" WHERE state = 'pending' ORDER BY id`)).toEqual([{ reasons: ['resume'] }, { reasons: ['resume'] }, { reasons: ['resume'] }])
    await settle()
    expect((await bProduct('JKT')).name).toBe('Named while paused')
  }, 60_000)

  it('9. a sync that fails is tried again later; after 8 tries it is marked failed and the owners are told', async () => {
    // The worker loses its door (a database fault): every sync of the link now fails.
    await sql(`REVOKE EXECUTE ON FUNCTION nexus_assortment_sync_source(text) FROM nexus_workspace_runtime`)
    try {
      expect(await as(B, null, () => worker.queueLinks([link['JKT-S']], 'resync'))).toBe(1)
      const first = await as(B, null, () => worker.processAssortmentChanges())
      expect(first).toMatchObject({ claimed: 1, retried: 1, failed: 0 })
      const waiting = await one(`SELECT state, attempts, "lastError", "availableAt" > CURRENT_TIMESTAMP + interval '50 seconds' AS later FROM "AssortmentChange" WHERE "linkId" = $1 AND state <> 'done' ORDER BY "createdAt" DESC`, [link['JKT-S']])
      expect(waiting).toMatchObject({ state: 'pending', attempts: 1, later: true })
      expect(String(waiting.lastError)).toContain('permission denied')
      // A fresh change in A makes the waiting note ready now: the new state may apply.
      await sql(`UPDATE "Product" SET description = 'Fresh while waiting' WHERE id = $1`, [product.small])
      expect(await sql(`SELECT "availableAt" <= CURRENT_TIMESTAMP(3) AS ready, attempts FROM "AssortmentChange" WHERE "linkId" = $1 AND state = 'pending'`, [link['JKT-S']])).toEqual([{ ready: true, attempts: 1 }])
      // The seventh retry has happened; the eighth try is the last.
      await sql(`UPDATE "AssortmentChange" SET attempts = 7, "availableAt" = CURRENT_TIMESTAMP WHERE "linkId" = $1 AND state = 'pending'`, [link['JKT-S']])
      expect(await as(B, null, () => worker.processAssortmentChanges())).toMatchObject({ claimed: 1, failed: 1, retried: 0 })
      expect(await sql(`SELECT state, attempts FROM "AssortmentChange" WHERE "linkId" = $1 AND state = 'failed'`, [link['JKT-S']])).toEqual([{ state: 'failed', attempts: 8 }])
      expect((await notices('assortment-sync-failed')).map((n) => n.title)).toEqual(['JKT-S2 stopped following its shared product', 'JKT-S2 stopped following its shared product'])
    } finally {
      await sql(`GRANT EXECUTE ON FUNCTION nexus_assortment_sync_source(text) TO nexus_workspace_runtime`)
    }
  }, 60_000)

  it('10. two workers at once sync each link exactly once', async () => {
    await sql(`UPDATE "Product" SET description = 'Two workers' WHERE id = ANY($1)`, [[product.parent, product.small, product.medium]])
    expect(await sql(`SELECT count(*)::int AS n FROM "AssortmentChange" WHERE state = 'pending'`)).toEqual([{ n: 3 }])
    const [one_, two] = await Promise.all([as(B, null, () => worker.processAssortmentChanges()), as(B, null, () => worker.processAssortmentChanges())])
    expect(one_.claimed + two.claimed).toBe(3)
    expect(one_.synced + two.synced).toBe(3)
    expect(await sql(`SELECT count(*)::int AS n FROM "AssortmentChange" WHERE state IN ('pending', 'claimed')`)).toEqual([{ n: 0 }])
    expect(await sql(`SELECT DISTINCT description FROM "Product" WHERE id = ANY($1)`, [[product['b:JKT'], product['b:JKT-S'], product['b:JKT-M']]])).toEqual([{ description: 'Two workers' }])
    // A link being worked on (a fresh claim) is not claimed a second time: its new note waits.
    await sql(`INSERT INTO "AssortmentChange" (id, "linkId", "shareId", "sourceWorkspaceId", "targetWorkspaceId", reasons, state, "claimedAt", "updatedAt")
      VALUES ($1,$2,$3,$4,$5,ARRAY['resync'],'claimed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [randomUUID(), link.JKT, shareId, A, B])
    await sql(`UPDATE "Product" SET description = 'While claimed' WHERE id = $1`, [product.parent])
    expect(await as(B, null, () => worker.processAssortmentChanges())).toMatchObject({ claimed: 0 })
    await sql(`DELETE FROM "AssortmentChange" WHERE "linkId" = $1 AND state = 'claimed'`, [link.JKT])
    expect(await as(B, null, () => worker.processAssortmentChanges())).toMatchObject({ claimed: 1, synced: 1 })
  }, 60_000)

  it('11. no chains: a product that follows A passes nothing on when B shares it onward to C', async () => {
    // B shares its JKT (which follows A) and its own B-OWN onward to C, and C links both.
    const bOwn = (await bProduct('B-OWN')).id as string
    const onward = await as(B, user.ownerB, () => assortments.createAssortment({ name: 'Onward to C' }))
    await as(B, user.ownerB, () => assortments.addMembers(onward.id, { productIds: [product['b:JKT'], bOwn], expectedVersion: 1 }))
    const offer = await as(B, user.ownerB, () => shares.offerShare({ assortmentId: onward.id, destinationWorkspaceId: C, fieldGroups: ['content'] }))
    await as(C, user.ownerC, () => shares.followerDecision(offer.id, 'accept', { expectedVersion: 1 }))
    const cJacket = randomUUID(), cOwn = randomUUID()
    await sql(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ($1,$3,'JKT','C jacket',1,CURRENT_TIMESTAMP), ($2,$3,'B-OWN','C copy',1,CURRENT_TIMESTAMP)`, [cJacket, cOwn, C])
    const prismaC = (await import('../../db.js')).default as unknown as { catalogLink: { create: (args: unknown) => Promise<{ id: string }> } }
    const onJacket = await as(C, user.ownerC, () => prismaC.catalogLink.create({ data: { shareId: offer.id, sourceWorkspaceId: B, sourceProductId: product['b:JKT'], targetWorkspaceId: C, targetProductId: cJacket, linkedBy: 'matched', sourceVersion: 1 } }))
    const onOwn = await as(C, user.ownerC, () => prismaC.catalogLink.create({ data: { shareId: offer.id, sourceWorkspaceId: B, sourceProductId: bOwn, targetWorkspaceId: C, targetProductId: cOwn, linkedBy: 'matched', sourceVersion: 1 } }))
    // A group the share does not offer (identity: only content goes to C) is not noted.
    await sql(`UPDATE "Product" SET gtin = '8000000009999' WHERE id = $1`, [bOwn])
    expect(await pending(onOwn.id)).toEqual([])
    // Control: B's own product IS noted for C, in an offered group.
    await sql(`UPDATE "Product" SET name = 'B own renamed' WHERE id = $1`, [bOwn])
    expect(await pending(onOwn.id)).toEqual([{ reasons: ['content'], state: 'pending' }])
    // B's JKT follows A: B editing it notes nothing for C.
    await sql(`UPDATE "Product" SET name = 'B edits a follower' WHERE id = $1`, [product['b:JKT']])
    expect(await pending(onJacket.id)).toEqual([])
    await sql(`DELETE FROM "AssortmentChange" WHERE "targetWorkspaceId" = $1`, [C])
  }, 60_000)

  it('12. the door answers only the follower, for its own active link', async () => {
    expect(await as(A, null, () => source.linkSource(link.JKT)).catch((error: { code?: string }) => error.code)).toBe('link_not_found')
    expect(await as(C, null, () => source.linkSource(link.JKT)).catch((error: { code?: string }) => error.code)).toBe('link_not_found')
    const detached = (await one(`SELECT id FROM "CatalogLink" WHERE status = 'detached' AND "targetWorkspaceId" = $1 LIMIT 1`, [B])).id as string
    expect(await as(B, null, () => source.linkSource(detached)).catch((error: { code?: string }) => error.code)).toBe('link_detached')
    const answer = await as(B, null, () => source.linkSource(link.JKT))
    expect(answer).toMatchObject({ linkId: link.JKT, shareId, ownerWorkspaceId: A, source: { id: product.parent, deleted: false } })
    // The parent's covered variations: JKT-S (renamed B-OWN), JKT-M2 and JKT-XL; JKT-L is deleted.
    expect(answer.variations.map((v) => v.sku).sort()).toEqual(['B-OWN', 'JKT-M2', 'JKT-XL'])
    // The poller's question is answered only with no business context — asked while a note waits.
    const prismaAny = (await import('../../db.js')).default as unknown as { $queryRawUnsafe: (text: string) => Promise<unknown[]>; assortmentChange: { create: (args: unknown) => Promise<unknown> } }
    expect(await as(B, null, () => worker.queueLinks([link.JKT], 'resync'))).toBe(1)
    expect(await as(B, null, () => prismaAny.$queryRawUnsafe('SELECT workspace_id FROM nexus_assortment_pending_workspaces()'))).toEqual([])
    expect(await as('', null, () => prismaAny.$queryRawUnsafe('SELECT workspace_id FROM nexus_assortment_pending_workspaces()'))).toEqual([{ workspace_id: B }]) // control
    await settle()
    // A note B writes itself must match its link: the owner business named wrongly is refused.
    const refused = await as(B, null, () => prismaAny.assortmentChange.create({ data: { linkId: link.JKT, shareId, sourceWorkspaceId: C, targetWorkspaceId: B, reasons: ['resync'] } })).catch((error: Error) => error.message)
    expect(String(refused)).toContain('The change does not match its link')
    // B cannot read A's products itself: the door is the only way.
    const prismaB = (await import('../../db.js')).default as unknown as { product: { count: (args: unknown) => Promise<number> } }
    expect(await as(B, user.ownerB, () => prismaB.product.count({ where: { id: product.parent } }))).toBe(0)
  }, 60_000)

  it('13. the delay from A\'s commit to B\'s product, with the real listener: 20 edits one after another', async () => {
    const url = new URL(concurrentDatabaseUrl()!.toString())
    url.pathname = `/${database.name}`
    // Arm 11 edited B's name, so B keeps its own name now; the description still follows.
    const view = await as(B, user.ownerB, () => sync.catalogLinkState(product['b:JKT']))
    expect(view.fields.find((field) => field.key === 'name')?.state).toBe('override')
    expect(view.fields.find((field) => field.key === 'description')?.state).toBe('follow')
    // AE4_POLL_ONLY=1 is the control: the same edits with the listener off, woken by the poll alone.
    const pollOnly = process.env.AE4_POLL_ONLY === '1'
    const stop = worker.startAssortmentSyncWorker({ listenUrl: pollOnly ? null : url.toString() })
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_000)) // the listener connects
      const lags: number[] = []
      for (let i = 0; i < 20; i++) {
        const value = `Listener edit ${i}`
        const started = Date.now()
        await sql(`UPDATE "Product" SET description = $2 WHERE id = $1`, [product.parent, value]) // committed on return
        const deadline = started + 10_000
        while ((await bProduct('JKT')).description !== value) {
          if (Date.now() > deadline) throw new Error(`edit ${i} did not reach B within 10 s`)
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        lags.push(Date.now() - started)
      }
      const sorted = [...lags].sort((a, b) => a - b)
      const p50 = sorted[Math.floor(sorted.length * 0.5)]
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]
      const line = `[AE.4 latency${pollOnly ? ', CONTROL poll only' : ''}] 20 sequential edits, one link, one worker, disposable PostgreSQL: p50 ${p50} ms, p95 ${p95} ms, max ${sorted.at(-1)} ms`
      console.log(line)
      if (process.env.AE4_LATENCY_FILE) (await import('node:fs')).appendFileSync(process.env.AE4_LATENCY_FILE, `${new Date().toISOString()} ${line}\n`)
      expect(p95).toBeLessThan(5_000)
    } finally {
      stop()
      await worker.kickAssortmentSync()
    }
  }, 120_000)
})
