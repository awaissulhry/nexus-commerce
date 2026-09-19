/**
 * AE.3b — a first copy end to end, through the REAL catalog-transfer engine, on a real disposable
 * PostgreSQL with the generated policies, profiles ON:
 *
 *   Review 1 → confirm (definitions, row mapping, staged job) → the job's own preview → apply →
 *   finish (links, owner-managed fields, images; one image upload fails → partial) → finish again
 *   (only the missing image; nothing rewritten) → repeat finish changes nothing → leave detaches.
 *
 * The master-sheet column dictionary is a fixture, as in the catalog-transfer suites. Also mocked: the
 * product read-cache refresh (a derived cache), the channel catalogue (unused: a copy never carries a
 * listing), the queue (Redis), the network and the two image storage providers (one production
 * account each; copy-media.vitest.test.ts covers their rules).
 *
 * 🔴 Needs a MULTI-CONNECTION PostgreSQL: the transfer engine's apply holds a transaction while it
 * checkpoints on a second connection, which the one-connection PGlite database can never serve (every
 * product failed with "timeout exceeded when trying to connect"). Without NEXUS_TEST_CONCURRENT_PG_URL
 * the suite skips with that reason. Run it like the stock race test (scripts/run-stock-race-test.mjs).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
// db.ts exports contextualDatabase(prisma), and so must this mock: without the wrapper a write made
// inside inDatabaseTransaction goes to the root client and commits OUTSIDE the transaction (a refused
// record's checkpoint then survives its rollback, and the job can never record the refusal).
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
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: async () => {}, refresh: async () => {} } }))
// Every export of lib/queue.ts, stubbed. With Redis unreachable a real queue add waits forever and the
// transfer job sits in RUNNING; with Redis reachable it would enqueue into a shared queue. Neither is a test.
vi.mock('../../lib/queue.js', () => {
  const queue = { add: async () => ({}), addBulk: async () => [], getJobCounts: async () => ({}), close: async () => {} }
  return {
    resolveRedisTarget: () => ({ kind: 'disabled' }), getRedisRuntimeStatus: () => ({ status: 'disabled' }), redis: { connection: null },
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: () => {} }, channelSyncQueueEvents: { on: () => {} },
    addJobSafely: async () => undefined, resetEnqueueCircuitForTests: () => {}, initializeQueue: async () => {}, closeQueue: async () => {}, getQueueStats: async () => ({}),
  }
})

const storage = vi.hoisted(() => ({ uploads: [] as string[], failFolders: new Set<string>() }))
vi.mock('../cloudinary.service.js', () => ({
  isCloudinaryConfigured: () => true,
  uploadBufferToCloudinary: async (buffer: Buffer, options: { folder: string }) => {
    storage.uploads.push(options.folder)
    if (storage.failFolders.delete(options.folder)) throw new Error('Cloudinary is unavailable')
    const n = storage.uploads.length
    return { url: `https://res.cloudinary.com/follower/image/upload/v1/${options.folder}/copy-${n}.png`, publicId: `${options.folder}/copy-${n}`, width: 1, height: 1, format: 'png', bytes: buffer.length }
  },
}))
vi.mock('../shopify/media-library.service.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../shopify/media-library.service.js')),
  defaultShopifyMediaAccount: async () => null,
}))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const bytesFor = (url: string) => Buffer.concat([PNG, Buffer.from(url)])

const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const A = 'ws_a_ae3_run'
const B = 'ws_b_ae3_run'

describe.skipIf(!concurrentDatabaseUrl())(`AE.3b — a first copy, end to end (needs ${CONCURRENT_PG_ENV})`, () => {
  let assortments: typeof import('./assortment.service.js')
  let shares: typeof import('./assortment-share.service.js')
  let preview: typeof import('./copy-preview.service.js')
  let runs: typeof import('./copy-run.service.js')
  let jobs: typeof import('../pim/catalog-transfer-jobs.js')

  const user = { ownerA: '', ownerB: '', viewerB: '' }
  const FILE = {
    jacket: 'https://res.cloudinary.com/owner/image/upload/v1/product-images/a/jacket.png',
    side: 'https://m.media-amazon.com/images/I/jacket-side.jpg',
    medium: 'https://res.cloudinary.com/owner/image/upload/v1/product-images/a/medium.png',
  }
  const images = (productId: string) => sql(`SELECT url, type, "isPrimary", "publicId" IS NOT NULL AS stored FROM "ProductImage" WHERE "productId" = $1 ORDER BY "sortOrder", url`, [productId])
  const product: Record<string, string> = {}
  let shareId = ''
  let familyA = ''
  let runId = ''
  let jobId = ''

  const as = <T>(workspaceId: string, actorUserId: string | null, work: () => Promise<T>) =>
    withWorkspace({ workspaceId, actorUserId, membershipId: null, roleKeys: [] }, work)
  const sql = async (text: string, params: unknown[] = []) => (await database.pool.query(text, params)).rows as Array<Record<string, unknown>>
  const refusal = async (work: Promise<unknown>) => {
    try { await work } catch (error) { return (error as { code?: string }).code ?? String((error as Error).message) }
    throw new Error('expected a refusal, but the call succeeded')
  }
  /** Poll the transfer job until it reaches one of the states, or fail loudly with where it stopped. */
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

  beforeAll(async () => {
    vi.stubGlobal('fetch', async (input: string | URL) => new Response(bytesFor(String(input)), { status: 200, headers: { 'content-type': 'image/png' } }))
    database = await concurrentDatabase({ maxConnections: 12 })
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    assortments = await import('./assortment.service.js')
    shares = await import('./assortment-share.service.js')
    preview = await import('./copy-preview.service.js')
    runs = await import('./copy-run.service.js')
    jobs = await import('../pim/catalog-transfer-jobs.js')

    const ownerRole = randomUUID(), viewerRole = randomUUID()
    await sql(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,CURRENT_TIMESTAMP)`, [ownerRole])
    await sql(`INSERT INTO "Role" (id, key, name, "isSystem", permissions, "updatedAt") VALUES ($1,'VIEWER','Viewer',true,ARRAY['products.view'],CURRENT_TIMESTAMP)`, [viewerRole])
    for (const key of Object.keys(user) as Array<keyof typeof user>) {
      user[key] = randomUUID()
      await sql(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',CURRENT_TIMESTAMP)`, [user[key], `${key}-${user[key]}@example.test`])
    }
    for (const [id, name] of [[A, 'Business A'], [B, 'Business B']]) {
      await sql(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$2,'active','ae3b',$1,CURRENT_TIMESTAMP)`, [id, name])
    }
    const member = async (workspaceId: string, userId: string, roleId: string) => {
      const id = randomUUID()
      await sql(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP)`, [id, workspaceId, userId])
      await sql(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [id, roleId])
    }
    await member(A, user.ownerA, ownerRole)
    await member(B, user.ownerA, viewerRole)
    await member(B, user.ownerB, ownerRole)
    await member(B, user.viewerB, viewerRole)

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
    // Media: a stored file and an outside address on the parent, a stored file on JKT-M, a video on JKT-S.
    const media = async (workspaceId: string, productId: string, url: string, extra: { type?: string; mediaType?: string; isPrimary?: boolean; sortOrder?: number; publicId?: string | null; fileSize?: number } = {}) =>
      sql(`INSERT INTO "ProductImage" (id, "workspaceId", "productId", url, "publicId", type, "mediaType", "isPrimary", "sortOrder", "fileSize", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP)`,
        [randomUUID(), workspaceId, productId, url, extra.publicId ?? null, extra.type ?? 'ALT', extra.mediaType ?? 'IMAGE', extra.isPrimary ?? false, extra.sortOrder ?? 0, extra.fileSize ?? null])
    await media(A, product.parent, FILE.jacket, { type: 'MAIN', isPrimary: true, publicId: 'product-images/a/jacket', fileSize: 100 })
    await media(A, product.parent, FILE.side, { sortOrder: 1 })
    await media(A, product.medium, FILE.medium, { type: 'MAIN', isPrimary: true, publicId: 'product-images/a/medium', fileSize: 200 })
    await media(A, product.small, 'https://res.cloudinary.com/owner/video/upload/v1/small.mp4', { type: 'VIDEO', mediaType: 'VIDEO' })

    // B already sells a JKT-M of its own, with its own main image.
    product.bMedium = await seed(B, 'JKT-M', { name: 'B own medium' })
    await media(B, product.bMedium, 'https://res.cloudinary.com/follower/image/upload/v1/own-medium.png', { type: 'MAIN', isPrimary: true, publicId: 'own-medium' })

    const created = await as(A, user.ownerA, () => assortments.createAssortment({ name: 'Jackets for B' }))
    await as(A, user.ownerA, () => assortments.addMembers(created.id, { productIds: [product.parent], expectedVersion: 1 }))
    const offer = await as(A, user.ownerA, () => shares.offerShare({
      assortmentId: created.id, destinationWorkspaceId: B,
      fieldGroups: ['identity', 'content', 'attributes', 'translations', 'media', 'physical', 'structure', 'price', 'status'],
    }))
    shareId = offer.id
    await as(B, user.ownerB, () => shares.followerDecision(shareId, 'accept', { expectedVersion: 1 }))
  }, 180_000)

  afterAll(async () => {
    vi.unstubAllGlobals()
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 30_000)

  it('refuses a stale review, an unknown SKU choice, and a member who is not an owner', async () => {
    const { preview: review } = await as(B, user.ownerB, () => preview.previewCopy({ shareId, market: 'IT' }))
    expect(await refusal(as(B, user.ownerB, () => runs.confirmCopy({ shareId, market: 'IT', fingerprint: 'not-the-review' })))).toBe('copy_review_changed')
    expect(await refusal(as(B, user.ownerB, () => runs.confirmCopy({ shareId, market: 'IT', fingerprint: review.fingerprint, skuChoices: { 'JKT-S': 'link' } })))).toBe('invalid_choices')
    expect(await refusal(as(B, user.viewerB, () => runs.confirmCopy({ shareId, market: 'IT', fingerprint: review.fingerprint })))).toBe('workspace_owner_required')
    expect((await sql(`SELECT count(*)::int AS n FROM "AssortmentCopyRun"`))[0].n).toBe(0)
  })

  it('CONTROL — confirm creates the definitions in B and stages the product review', async () => {
    const { preview: review } = await as(B, user.ownerB, () => preview.previewCopy({ shareId, market: 'IT' }))
    expect(review.products.map((p) => [p.sku, p.kind])).toEqual([['JKT', 'new'], ['JKT-M', 'match'], ['JKT-S', 'new']])
    // Three images arrive (two files to copy, 300 bytes, and one outside address); the video does not.
    expect(review.counts).toMatchObject({ images: 3, mediaNotCopied: 1 })
    expect(review.imageBytes).toBe(300)
    const run = await as(B, user.ownerB, () => runs.confirmCopy({ shareId, market: 'IT', fingerprint: review.fingerprint, skuChoices: { 'JKT-M': 'link' } }))
    runId = run.id
    jobId = run.transferJobId!
    expect(run.state).toBe('reviewing')
    expect(run.plan.products.map((p) => [p.sku, p.kind])).toEqual([['JKT', 'new'], ['JKT-M', 'match'], ['JKT-S', 'new']])
    // The definitions now exist in B, created by natural key; the category tree keeps its ancestor rows.
    expect((await sql(`SELECT code FROM "ProductFamily" WHERE "workspaceId" = $1`, [B])).map((r) => r.code)).toEqual(['jackets'])
    expect((await sql(`SELECT o.code FROM "AttributeOption" o JOIN "CustomAttribute" a ON a.id = o."attributeId" WHERE a."workspaceId" = $1 AND a.code = 'armor_level' ORDER BY o.code`, [B])).map((r) => r.code)).toEqual(['l1', 'l2'])
    const bJackets = await sql(`SELECT c.id FROM "Category" c JOIN "Category" p ON p.id = c."parentId" WHERE c."workspaceId" = $1 AND c.slug = 'jackets' AND p.slug = 'apparel'`, [B])
    expect(bJackets).toHaveLength(1)
    expect((await sql(`SELECT count(*)::int AS n FROM "CategoryClosure" WHERE "descendantId" = $1`, [bJackets[0].id]))[0].n).toBe(2)
    await waitForJob(['QUEUED'])
  }, 120_000)

  it('the product review applies; finish links all three, sets price and status, copies the images, and B holds a faithful copy', async () => {
    const reviewed = await waitForJob(['QUEUED'])
    await as(B, user.ownerB, () => jobs.applyTransferJob(jobId, user.ownerB, reviewed.payload.reviewToken!))
    const applied = await waitForJob(['COMPLETED', 'PARTIAL'])
    const failures = await sql(`SELECT "targetId", "errorMessage" FROM "ImportJobRow" WHERE "jobId" = $1 AND status = 'FAILED'`, [jobId])
    expect(applied.job.status, JSON.stringify({ failures, errors: applied.job.errors })).toBe('COMPLETED')

    // JKT-M's image upload fails this time: the run finishes PARTIAL and says which image.
    const jacketM = (await sql(`SELECT id FROM "Product" WHERE "workspaceId" = $1 AND sku = 'JKT-M'`, [B]))[0].id as string
    storage.failFolders.add(`product-images/${jacketM}`)
    const finished = await as(B, user.ownerB, () => runs.advanceCopyRun(runId))
    expect(finished.state).toBe('partial')
    expect(finished.counts).toMatchObject({ linked: 3, notSaved: 0, linkRefused: 0, managedFailed: 0, imagesCopied: 1, imagesAddressed: 1, imagesReused: 0, imagesFailed: 1, mediaNotCopied: 1 })
    expect(finished.error).toBe('JKT-M: image 1: Cloudinary is unavailable')

    const links = await sql(`SELECT l."linkedBy", p.sku FROM "CatalogLink" l JOIN "Product" p ON p.id = l."targetProductId" WHERE l."shareId" = $1 AND l.status = 'active' ORDER BY p.sku`, [shareId])
    expect(links).toEqual([{ linkedBy: 'created', sku: 'JKT' }, { linkedBy: 'matched', sku: 'JKT-M' }, { linkedBy: 'created', sku: 'JKT-S' }])

    const jacket = (await sql(`SELECT p.*, f.code AS family FROM "Product" p LEFT JOIN "ProductFamily" f ON f.id = p."familyId" WHERE p."workspaceId" = $1 AND p.sku = 'JKT'`, [B]))[0]
    expect(jacket).toMatchObject({ name: 'JKT name', description: 'Source description', gtin: '8000000000001', productType: 'COAT', status: 'ACTIVE', family: 'jackets' })
    expect(Number(jacket.basePrice)).toBe(99)
    expect(jacket.categoryAttributes).toMatchObject({ armor_level: 'l2' })
    expect(jacket.id).not.toBe(product.parent) // B's own record, not A's
    const small = (await sql(`SELECT "parentId" FROM "Product" WHERE "workspaceId" = $1 AND sku = 'JKT-S'`, [B]))[0]
    expect(small.parentId).toBe(jacket.id)
    const category = await sql(`SELECT c.slug FROM "ProductCategory" pc JOIN "Category" c ON c.id = pc."categoryId" WHERE pc."productId" = $1`, [jacket.id])
    expect(category).toEqual([{ slug: 'jackets' }])
    // Translations: the parent carries its own German title and the variations keep inheriting it, as
    // in A. (Before R-AE-17 fixed the transfer engine, both variations were refused at apply: it planned
    // their inherited row against the whole review, then against the single record.)
    expect(await sql(`SELECT p.sku, t.name FROM "ProductTranslation" t JOIN "Product" p ON p.id = t."productId" WHERE p."workspaceId" = $1 AND t.language = 'de' AND t.name IS NOT NULL ORDER BY p.sku`, [B])).toEqual([{ sku: 'JKT', name: 'Jacke' }])
    // The matched product took the shared values.
    expect((await sql(`SELECT name FROM "Product" WHERE id = $1`, [product.bMedium]))[0].name).toBe('JKT-M name')
    // Images: B's jacket holds its OWN copy of the file (not A's address) and the outside address.
    expect(await images(jacket.id as string)).toEqual([
      { url: `https://res.cloudinary.com/follower/image/upload/v1/product-images/${jacket.id}/copy-1.png`, type: 'MAIN', isPrimary: true, stored: true },
      { url: FILE.side, type: 'ALT', isPrimary: false, stored: false },
    ])
    expect(await images(product.bMedium)).toEqual([{ url: 'https://res.cloudinary.com/follower/image/upload/v1/own-medium.png', type: 'MAIN', isPrimary: true, stored: true }])
    // The run list under the incoming share shows this run with its outcome.
    expect((await as(B, user.ownerB, () => runs.listCopyRuns(shareId))).map((run) => [run.id, run.state, run.products, run.skipped, run.counts?.linked])).toEqual([[runId, 'partial', 3, 0, 3]])
    expect(await as(A, user.ownerA, () => runs.listCopyRuns(shareId))).toEqual([]) // the owner's business has no runs of its own
    expect(await sql(`SELECT count(*)::int AS n FROM "ProductImage" p JOIN "Product" x ON x.id = p."productId" WHERE x."workspaceId" = $1 AND x.sku = 'JKT-S'`, [B])).toEqual([{ n: 0 }])
  }, 120_000)

  it('finishing a partial run again does only what is missing: the failed image, and nothing rewritten', async () => {
    const versions = async () => sql(`SELECT sku, version FROM "Product" WHERE "workspaceId" = $1 ORDER BY sku`, [B])
    const before = await versions()
    const uploadsBefore = storage.uploads.length
    const again = await as(B, user.ownerB, () => runs.advanceCopyRun(runId))
    expect(again.state).toBe('done')
    expect(again.counts).toMatchObject({ linked: 0, alreadyLinked: 3, managedApplied: 0, managedFailed: 0, imagesCopied: 1, imagesReused: 2, imagesAddressed: 0, imagesFailed: 0 })
    expect(again.error).toBeNull()
    expect(storage.uploads.length - uploadsBefore).toBe(1)
    expect(await versions()).toEqual(before) // no product write: prices, status and type already held
    expect(await images(product.bMedium)).toEqual([
      { url: 'https://res.cloudinary.com/follower/image/upload/v1/own-medium.png', type: 'MAIN', isPrimary: true, stored: true },
      { url: `https://res.cloudinary.com/follower/image/upload/v1/product-images/${product.bMedium}/copy-${storage.uploads.length}.png`, type: 'ALT', isPrimary: false, stored: true },
    ])
  }, 120_000)

  it('finishing again changes nothing, and business A is untouched', async () => {
    const before = await sql(`SELECT id, status, "updatedAt" FROM "CatalogLink" ORDER BY id`)
    const again = await as(B, user.ownerB, () => runs.advanceCopyRun(runId))
    expect(again.state).toBe('done')
    expect(await sql(`SELECT id, status, "updatedAt" FROM "CatalogLink" ORDER BY id`)).toEqual(before)
    const aProducts = await sql(`SELECT sku, version, name FROM "Product" WHERE "workspaceId" = $1 ORDER BY sku`, [A])
    expect(aProducts).toEqual([
      { sku: 'JKT', version: 1, name: 'JKT name' }, { sku: 'JKT-M', version: 1, name: 'JKT-M name' }, { sku: 'JKT-S', version: 1, name: 'JKT-S name' },
    ])
  })

  it('a second copy brings what the owner added; every variation inherits the parent title, whether new, linked with its own title, or linked without one', async () => {
    // In A, three more variations of JKT, none with a translation of its own.
    for (const sku of ['JKT-L', 'JKT-XL', 'JKT-XS']) {
      await sql(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", status, "parentId", "familyId", "updatedAt") VALUES ($1,$2,$3,$4,99,'ACTIVE',$5,$6,CURRENT_TIMESTAMP)`, [randomUUID(), A, sku, `${sku} name`, product.parent, familyA])
    }
    // In B, its own JKT-XL and JKT-XS, already variations of B's JKT: XL with its own German title, XS without.
    // (Before R-AE-17, XS was refused: the engine counted "inherit" as a change and cleared a translation XS never had.)
    const bJacket = (await sql(`SELECT id FROM "Product" WHERE "workspaceId" = $1 AND sku = 'JKT'`, [B]))[0].id as string
    const bExtraLarge = randomUUID()
    await sql(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "parentId", "updatedAt") VALUES ($1,$2,'JKT-XL','B own XL',5,$3,CURRENT_TIMESTAMP)`, [bExtraLarge, B, bJacket])
    await sql(`INSERT INTO "ProductTranslation" (id, "workspaceId", "productId", language, name, "updatedAt") VALUES ($1,$2,$3,'de','B eigene XL',CURRENT_TIMESTAMP)`, [randomUUID(), B, bExtraLarge])
    await sql(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "parentId", "updatedAt") VALUES ($1,$2,'JKT-XS','B own XS',5,$3,CURRENT_TIMESTAMP)`, [randomUUID(), B, bJacket])

    const { preview: review } = await as(B, user.ownerB, () => preview.previewCopy({ shareId, market: 'IT' }))
    expect(review.products.map((p) => [p.sku, p.kind])).toEqual([['JKT', 'linked'], ['JKT-L', 'new'], ['JKT-M', 'linked'], ['JKT-S', 'linked'], ['JKT-XL', 'match'], ['JKT-XS', 'match']])
    const second = await as(B, user.ownerB, () => runs.confirmCopy({ shareId, market: 'IT', fingerprint: review.fingerprint, skuChoices: { 'JKT-XL': 'link', 'JKT-XS': 'link' } }))
    expect(second.plan.products.map((p) => p.sku)).toEqual(['JKT-L', 'JKT-XL', 'JKT-XS'])
    jobId = second.transferJobId!
    const reviewed = await waitForJob(['QUEUED'])
    await as(B, user.ownerB, () => jobs.applyTransferJob(jobId, user.ownerB, reviewed.payload.reviewToken!))
    const applied = await waitForJob(['COMPLETED', 'PARTIAL'])
    const failures = await sql(`SELECT "targetId", "errorMessage" FROM "ImportJobRow" WHERE "jobId" = $1 AND status = 'FAILED'`, [jobId])
    expect(applied.job.status, JSON.stringify({ failures, errors: applied.job.errors })).toBe('COMPLETED')
    const finished = await as(B, user.ownerB, () => runs.advanceCopyRun(second.id))
    expect(finished.state).toBe('done')
    expect((await as(B, user.ownerB, () => runs.listCopyRuns(shareId))).map((run) => [run.id, run.state])).toEqual([[second.id, 'done'], [runId, 'done']])
    expect(finished.counts).toMatchObject({ linked: 3, notSaved: 0, linkRefused: 0, managedFailed: 0 })

    // Both are variations of B's JKT, and the German title lives on the parent only: B's own XL title was cleared.
    expect(await sql(`SELECT sku FROM "Product" WHERE "workspaceId" = $1 AND "parentId" = $2 ORDER BY sku`, [B, bJacket])).toEqual([{ sku: 'JKT-L' }, { sku: 'JKT-M' }, { sku: 'JKT-S' }, { sku: 'JKT-XL' }, { sku: 'JKT-XS' }])
    expect(await sql(`SELECT p.sku, t.name FROM "ProductTranslation" t JOIN "Product" p ON p.id = t."productId" WHERE p."workspaceId" = $1 AND t.language = 'de' AND t.name IS NOT NULL ORDER BY p.sku`, [B])).toEqual([{ sku: 'JKT', name: 'Jacke' }])
  }, 180_000)

  it('a third Review 1 now shows every product as linked, and nothing to copy', async () => {
    const { preview: review } = await as(B, user.ownerB, () => preview.previewCopy({ shareId, market: 'IT' }))
    expect(review.counts).toMatchObject({ new: 0, match: 0, linked: 6 })
    expect(await refusal(as(B, user.ownerB, () => runs.confirmCopy({ shareId, market: 'IT', fingerprint: review.fingerprint })))).toBe('nothing_to_copy')
  })

  it('B leaving the share detaches every link; the copied products stay in B', async () => {
    const version = (await sql(`SELECT version FROM "AssortmentShare" WHERE id = $1`, [shareId]))[0].version as number
    await as(B, user.ownerB, () => shares.followerDecision(shareId, 'leave', { expectedVersion: version }))
    expect(await sql(`SELECT DISTINCT status, "detachedReason" FROM "CatalogLink" WHERE "shareId" = $1`, [shareId])).toEqual([{ status: 'detached', detachedReason: 'share revoked by the follower' }])
    expect((await sql(`SELECT count(*)::int AS n FROM "Product" WHERE "workspaceId" = $1 AND "deletedAt" IS NULL`, [B]))[0].n).toBe(6)
  })
})
