/**
 * Shared stock by SKU (Owner 2026-10-01; plan docs/shared-stock-by-sku/PLAN-2026-10-01.md) — on a disposable
 * real PostgreSQL (PGlite) with the generated production policies, profiles ON, and NO product share: a
 * borrower product connects to the lender's product with exactly the same SKU.
 *
 * Covers: which products can connect and why not (nexus_pool_sku_matches), the switch service, the link
 * guard's SKU checks, the doors through a SKU link, D1 (a connected SKU keeps its SKU and its product in
 * both businesses), one lender serving two borrowers, and the wake signal at commit. The older links made
 * through a product share are covered by stock-pool-rules.vitest.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// db.ts exports contextualDatabase(prisma), and so must this mock (see stock-pool-rules.vitest.test.ts).
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})
// The switch module reaches the cascade's queue at import; nothing here sends (see stock-pool-e2e.vitest.test.ts).
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return {
    addJobSafely: vi.fn(async () => undefined),
    outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue,
    redis: { connection: null },
  }
})

const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const roleBefore = process.env.NEXUS_PROCESS_ROLE
const A = 'ws_a_sku_lender'
const B = 'ws_b_sku_borrower'
const C = 'ws_c_sku_borrower'

type Row = Record<string, unknown>

describe('Shared stock by SKU — connect, refuse, keep the SKU, wake', () => {
  let doors: typeof import('./pool-doors.js')
  let links: typeof import('./pool-links.service.js')
  const user = { ownerA: '', ownerB: '', viewerB: '', ownerC: '' }
  const loc: Record<string, string> = {}
  const product: Record<string, string> = {}
  let grantB = ''
  let grantC = ''

  const as = <T>(workspaceId: string, actorUserId: string | null, work: () => Promise<T>) =>
    withWorkspace({ workspaceId, actorUserId, membershipId: null, roleKeys: [] }, work)
  const sql = async (text: string, params: unknown[] = []) => (await database.db.query(text, params)).rows as Row[]
  const dbError = async (work: Promise<unknown>) => {
    try { await work } catch (error) { return String((error as Error).message) }
    return 'NO ERROR'
  }
  const tasks = async (workspaceId: string) =>
    sql(`SELECT kind, "productId", reason FROM "StockPoolTask" WHERE "workspaceId" = $1 ORDER BY "createdAt", id`, [workspaceId])
  const clearTasks = () => sql(`DELETE FROM "StockPoolTask"`)
  const level = async (locationId: string, productId: string) =>
    (await sql(`SELECT quantity, reserved, available FROM "StockLevel" WHERE "locationId" = $1 AND "productId" = $2`, [locationId, productId]))[0]
  const matches = (workspaceId: string, actor: string, grantId: string, productIds: string[]) =>
    as(workspaceId, actor, () => links.loadSkuMatches(database.client as never, grantId, productIds))
  const switchTo = (workspaceId: string, actor: string, to: 'pool' | 'own', productIds: string[], grantId: string | null) =>
    as(workspaceId, actor, () => links.switchProducts({ productIds, to, grantId, withVariations: false }))
  const rename = (workspaceId: string, actor: string, productId: string, sku: string) =>
    as(workspaceId, actor, () => database.client.product.update({ where: { id: productId }, data: { sku } }))
  const softDelete = (workspaceId: string, actor: string, productId: string) =>
    as(workspaceId, actor, () => database.client.product.update({ where: { id: productId }, data: { deletedAt: new Date() } }))

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    // The API role: switching does not kick the worker here, so the queued tasks stay to be read.
    process.env.NEXUS_PROCESS_ROLE = 'api'
    doors = await import('./pool-doors.js')
    links = await import('./pool-links.service.js')

    // Deployed databases carry these; schema.prisma cannot express them (stock-concurrency.vitest.test.ts).
    await sql(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await sql(`ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_quantity_positive" CHECK ("quantity" > 0)`)
    await sql(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId", "locationId", "productId") WHERE "variationId" IS NULL`)

    const ownerRole = randomUUID(), viewerRole = randomUUID()
    await sql(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,CURRENT_TIMESTAMP)`, [ownerRole])
    await sql(`INSERT INTO "Role" (id, key, name, "isSystem", permissions, "updatedAt") VALUES ($1,'VIEWER','Viewer',true,ARRAY['products.view'],CURRENT_TIMESTAMP)`, [viewerRole])
    for (const key of Object.keys(user) as Array<keyof typeof user>) {
      user[key] = randomUUID()
      await sql(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',CURRENT_TIMESTAMP)`, [user[key], `${key}@example.test`])
    }
    for (const [id, name] of [[A, 'Lender A'], [B, 'Borrower B'], [C, 'Borrower C']]) {
      await sql(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$2,'active','pool',$1,CURRENT_TIMESTAMP)`, [id, name])
    }
    const member = async (workspaceId: string, userId: string, roleId: string) => {
      const id = randomUUID()
      await sql(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP)`, [id, workspaceId, userId])
      await sql(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [id, roleId])
    }
    await member(A, user.ownerA, ownerRole)
    await member(B, user.ownerA, viewerRole)
    await member(C, user.ownerA, viewerRole)
    await member(B, user.ownerB, ownerRole)
    await member(B, user.viewerB, viewerRole)
    await member(C, user.ownerC, ownerRole)

    const location = async (workspaceId: string, code: string) => {
      const id = randomUUID()
      await sql(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "isActive", "updatedAt") VALUES ($1,$2,'WAREHOUSE',$3,$3,true,CURRENT_TIMESTAMP)`, [id, workspaceId, code])
      return id
    }
    loc.main = await location(A, 'IT-MAIN')
    loc.second = await location(A, 'IT-SECOND')
    loc.bOwn = await location(B, 'B-MAIN')

    const seed = async (workspaceId: string, sku: string) => {
      const id = randomUUID()
      await sql(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ($1,$2,$3,$3,10,CURRENT_TIMESTAMP)`, [id, workspaceId, sku])
      return id
    }
    // The same SKUs in both businesses — no product share, no catalog link anywhere in this file.
    for (const sku of ['JACKET', 'HELMET', 'LOTTED', 'GONE', 'BOOTS']) {
      product[`a_${sku}`] = await seed(A, sku)
      product[`b_${sku}`] = await seed(B, sku)
    }
    product.b_ONLY = await seed(B, 'ONLY-IN-B')
    product.c_JACKET = await seed(C, 'JACKET')
    await sql(`UPDATE "Product" SET "deletedAt" = CURRENT_TIMESTAMP WHERE id = $1`, [product.a_GONE])
    await sql(`INSERT INTO "Lot" (id, "workspaceId", "productId", "lotNumber", "unitsReceived", "unitsRemaining", "updatedAt") VALUES ($1,$2,$3,'L1',5,5,CURRENT_TIMESTAMP)`, [randomUUID(), A, product.a_LOTTED])

    const stock = (locationId: string, productId: string, quantity: number, workspaceId = A) =>
      sql(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,CURRENT_TIMESTAMP)`, [randomUUID(), workspaceId, locationId, productId, quantity])
    await stock(loc.main, product.a_JACKET, 5)
    await stock(loc.second, product.a_JACKET, 3)
    await stock(loc.main, product.a_HELMET, 1)
    await stock(loc.bOwn, product.b_JACKET, 7, B)

    // A lends to B (both warehouses) and to C (the main one), through the real offer and answer.
    const lend = async (borrower: string, owner: string, locations: string[]) => {
      const grant = await as(A, user.ownerA, () => database.client.stockPoolGrant.create({ data: { ownerWorkspaceId: A, workspaceId: borrower, locationIds: locations, createdByUserId: user.ownerA } }))
      const answer = await as(borrower, owner, async () => (await database.client.$queryRaw<Array<{ r: Row }>>`SELECT nexus_stock_pool_grant_respond(${grant.id}, 'accept', 1::integer) AS r`)[0].r)
      expect((answer.grant as Row).status).toBe('active')
      return grant.id
    }
    grantB = await lend(B, user.ownerB, [loc.main, loc.second])
    grantC = await lend(C, user.ownerC, [loc.main])
    await clearTasks()
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    if (roleBefore === undefined) delete process.env.NEXUS_PROCESS_ROLE
    else process.env.NEXUS_PROCESS_ROLE = roleBefore
    await database?.close()
  })

  it('names the lender product with exactly the same SKU, or why there is none — and answers only the borrower', async () => {
    const found = await matches(B, user.ownerB, grantB, [product.b_JACKET, product.b_ONLY, product.b_GONE, product.b_LOTTED, product.a_JACKET])
    expect(Object.fromEntries([...found].map(([id, m]) => [id, m]))).toEqual({
      [product.b_JACKET]: { sku: 'JACKET', sourceProductId: product.a_JACKET, refusal: null },
      [product.b_ONLY]: { sku: 'ONLY-IN-B', sourceProductId: null, refusal: 'no_match' },
      [product.b_GONE]: { sku: 'GONE', sourceProductId: null, refusal: 'source_deleted' },
      [product.b_LOTTED]: { sku: 'LOTTED', sourceProductId: null, refusal: 'tracked' },
    })
    // Another business, or the lender itself, learns nothing through this grant.
    expect((await matches(C, user.ownerC, grantB, [product.c_JACKET])).size).toBe(0)
    expect((await matches(A, user.ownerA, grantB, [product.a_JACKET])).size).toBe(0)
    // The borrower asks with the other borrower's grant: nothing.
    expect((await matches(B, user.ownerB, grantC, [product.b_JACKET])).size).toBe(0)
  })

  it('the preview shows each refusal in words, and nothing changes', async () => {
    const preview = await as(B, user.ownerB, () => links.previewSwitch({ productIds: [product.b_HELMET, product.b_ONLY, product.b_LOTTED], to: 'pool', grantId: grantB, withVariations: false }))
    const refusal = Object.fromEntries(preview.products.map((p) => [p.sku, p.refusal]))
    expect(refusal).toEqual({
      HELMET: null,
      'ONLY-IN-B': 'Lender A has no product with the SKU ONLY-IN-B, so this product cannot use its stock.',
      LOTTED: 'LOTTED is tracked by lot or serial number in Lender A. Shared stock does not support that yet.',
    })
    expect(await sql(`SELECT count(*)::int AS n FROM "StockPoolLink"`)).toEqual([{ n: 0 }])
  })

  it('connects by SKU through the switch: the link names the SKU and no catalog link, and the listings are queued', async () => {
    expect(await switchTo(B, user.ownerB, 'pool', [product.b_JACKET, product.b_HELMET], grantB)).toEqual({ switched: 2, unchanged: 0 })
    const rows = await sql(`SELECT "productId", "sourceProductId", sku, "catalogLinkId", status FROM "StockPoolLink" WHERE "workspaceId" = $1 ORDER BY sku`, [B])
    expect(rows).toEqual([
      { productId: product.b_HELMET, sourceProductId: product.a_HELMET, sku: 'HELMET', catalogLinkId: null, status: 'active' },
      { productId: product.b_JACKET, sourceProductId: product.a_JACKET, sku: 'JACKET', catalogLinkId: null, status: 'active' },
    ])
    expect((await tasks(B)).map((t) => [t.kind, t.productId, t.reason]).sort()).toEqual([
      ['recascade', product.b_HELMET, 'link'], ['recascade', product.b_JACKET, 'link']].sort())
    // Again: nothing doubles.
    expect(await switchTo(B, user.ownerB, 'pool', [product.b_JACKET], grantB)).toEqual({ switched: 0, unchanged: 1 })
    await clearTasks()
  })

  it('refuses in words, all or nothing: a SKU the lender lacks, a tracked product, a person who is not an owner', async () => {
    expect(await dbError(switchTo(B, user.ownerB, 'pool', [product.b_BOOTS, product.b_ONLY], grantB)))
      .toBe('Lender A has no product with the SKU ONLY-IN-B, so this product cannot use its stock.')
    expect(await dbError(switchTo(B, user.ownerB, 'pool', [product.b_LOTTED], grantB))).toMatch(/tracked by lot or serial number in Lender A/)
    expect(await dbError(switchTo(B, user.viewerB, 'pool', [product.b_BOOTS], grantB))).toMatch(/owner/i)
    // BOOTS could connect, but the switch is all or nothing: it did not.
    expect(await sql(`SELECT count(*)::int AS n FROM "StockPoolLink" WHERE "productId" = $1`, [product.b_BOOTS])).toEqual([{ n: 0 }])
  })

  it('the database refuses a SKU link whose products do not both have that SKU, and a link with two identities or none', async () => {
    const create = (data: Row) => as(B, user.ownerB, () => database.client.stockPoolLink.create({ data: { grantId: grantB, createdByUserId: user.ownerB, ...data } as never }))
    expect(await dbError(create({ sku: 'BOOTS', productId: product.b_ONLY, sourceProductId: product.a_BOOTS }))).toMatch(/not a product of this business with this SKU/)
    expect(await dbError(create({ sku: 'BOOTS', productId: product.b_BOOTS, sourceProductId: product.a_LOTTED }))).toMatch(/lending business has no product with this SKU/)
    expect(await dbError(create({ productId: product.b_BOOTS, sourceProductId: product.a_BOOTS }))).toMatch(/exactly one identity/)
    expect(await dbError(create({ sku: ' ', productId: product.b_BOOTS, sourceProductId: product.a_BOOTS }))).toMatch(/exactly one identity/)
    // A product of another business named as "this business's" product.
    expect(await dbError(create({ sku: 'JACKET', productId: product.c_JACKET, sourceProductId: product.a_JACKET }))).toMatch(/different business|not a product of this business/)
    // Positive control: the same insert, right SKU and products.
    const made = await create({ sku: 'BOOTS', productId: product.b_BOOTS, sourceProductId: product.a_BOOTS })
    expect(made.status).toBe('active')
    // A link's SKU never changes.
    expect(await dbError(as(B, user.ownerB, () => database.client.stockPoolLink.update({ where: { id: made.id }, data: { sku: 'OTHER' } }))))
      .toMatch(/products, permission and origin cannot change/)
    await switchTo(B, user.ownerB, 'own', [product.b_BOOTS], null)
    await clearTasks()
  })

  it('sells through a SKU link: CHECK shows the lent warehouses, HOLD takes from the lender', async () => {
    const levels = await as(B, user.ownerB, () => doors.poolLevels(database.client as never, [product.b_JACKET, product.b_BOOTS]))
    expect([...levels.keys()]).toEqual([product.b_JACKET])
    expect(levels.get(product.b_JACKET)!.map((l) => [l.locationCode, l.available])).toEqual([['IT-MAIN', 5], ['IT-SECOND', 3]])
    const held = await as(B, user.ownerB, () => doors.poolReserve(database.client as never, { productId: product.b_JACKET, quantity: 2, orderRef: 'B-SKU-1' }))
    expect(held).toMatchObject({ ok: true, quantity: 2, locationCode: 'IT-MAIN', grantId: grantB })
    expect(await level(loc.main, product.a_JACKET)).toEqual({ quantity: 5, reserved: 2, available: 3 })
    // B's own warehouse is not touched.
    expect(await level(loc.bOwn, product.b_JACKET)).toEqual({ quantity: 7, reserved: 0, available: 7 })
    await clearTasks()
  })

  it('lists the products whose SKU the lender has, page by page', async () => {
    const all: Array<Awaited<ReturnType<typeof links.listPoolProducts>>['products'][number]> = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page: Awaited<ReturnType<typeof links.listPoolProducts>> = await as(B, user.ownerB, () => links.listPoolProducts({ grantId: grantB, take: 2, cursor }))
      all.push(...page.products)
      cursor = page.nextCursor
      pages++
    } while (cursor && pages < 10)
    expect(pages).toBe(2)
    // ONLY-IN-B: the lender has no such SKU. GONE: the lender deleted it.
    expect(all.map((p) => p.sku).sort()).toEqual(['BOOTS', 'HELMET', 'JACKET', 'LOTTED'])
    expect(all.find((p) => p.sku === 'JACKET')).toMatchObject({ source: 'pool', grantId: grantB })
    expect(all.find((p) => p.sku === 'BOOTS')).toMatchObject({ source: 'own', grantId: null })
  })

  it('D1: a connected SKU cannot be renamed, deleted or moved — in the borrowing business or the lending one', async () => {
    expect(await dbError(rename(B, user.ownerB, product.b_JACKET, 'JACKET-2'))).toMatch(/JACKET sells from the stock of Lender A\. Disconnect it first/)
    expect(await dbError(softDelete(B, user.ownerB, product.b_JACKET))).toMatch(/JACKET sells from the stock of Lender A/)
    expect(await dbError(rename(A, user.ownerA, product.a_JACKET, 'JACKET-2'))).toMatch(/JACKET shares its stock with Borrower B\. Disconnect it there first/)
    expect(await dbError(softDelete(A, user.ownerA, product.a_JACKET))).toMatch(/JACKET shares its stock with Borrower B/)
    expect(await dbError(sql(`DELETE FROM "Product" WHERE id = $1`, [product.a_JACKET]))).toMatch(/shares its stock with Borrower B/)
    expect(await dbError(sql(`UPDATE "Product" SET "workspaceId" = $2 WHERE id = $1`, [product.b_JACKET, C]))).toMatch(/sells from the stock of Lender A/)
    expect(await sql(`SELECT sku, "deletedAt" FROM "Product" WHERE id IN ($1, $2)`, [product.a_JACKET, product.b_JACKET])).toEqual([
      { sku: 'JACKET', deletedAt: null }, { sku: 'JACKET', deletedAt: null }])
    // Positive controls: a product that shares nothing is renamed; writing the same SKU again changes nothing and passes.
    await rename(B, user.ownerB, product.b_ONLY, 'ONLY-IN-B-2')
    await rename(B, user.ownerB, product.b_ONLY, 'ONLY-IN-B')
    await rename(B, user.ownerB, product.b_JACKET, 'JACKET')
    await as(B, user.ownerB, () => database.client.product.update({ where: { id: product.b_JACKET }, data: { name: 'Jacket, new name' } }))
  })

  it('one lender serves two businesses with the same SKU; a stock change queues both; D1 names a borrower', async () => {
    expect(await switchTo(C, user.ownerC, 'pool', [product.c_JACKET], grantC)).toEqual({ switched: 1, unchanged: 0 })
    const levels = await as(C, user.ownerC, () => doors.poolLevels(database.client as never, [product.c_JACKET]))
    expect(levels.get(product.c_JACKET)!.map((l) => [l.locationCode, l.available])).toEqual([['IT-MAIN', 3]])
    await clearTasks()
    await sql(`UPDATE "StockLevel" SET quantity = quantity - 1, available = available - 1 WHERE "locationId" = $1 AND "productId" = $2`, [loc.main, product.a_JACKET])
    expect(await tasks(B)).toEqual([{ kind: 'recascade', productId: product.b_JACKET, reason: 'stock' }])
    expect(await tasks(C)).toEqual([{ kind: 'recascade', productId: product.c_JACKET, reason: 'stock' }])
    // IT-SECOND is lent to B only.
    await clearTasks()
    await sql(`UPDATE "StockLevel" SET quantity = quantity + 1, available = available + 1 WHERE "locationId" = $1 AND "productId" = $2`, [loc.second, product.a_JACKET])
    expect(await tasks(B)).toHaveLength(1)
    expect(await tasks(C)).toEqual([])
    expect(await dbError(rename(A, user.ownerA, product.a_JACKET, 'JACKET-2'))).toMatch(/shares its stock with Borrower (B|C)/)
    await clearTasks()
  })

  it('after both disconnect, the SKU may change again', async () => {
    expect(await switchTo(B, user.ownerB, 'own', [product.b_JACKET], null)).toEqual({ switched: 1, unchanged: 0 })
    await rename(B, user.ownerB, product.b_JACKET, 'JACKET-B')
    // C still borrows A's JACKET.
    expect(await dbError(rename(A, user.ownerA, product.a_JACKET, 'JACKET-2'))).toMatch(/shares its stock with Borrower C/)
    expect(await switchTo(C, user.ownerC, 'own', [product.c_JACKET], null)).toEqual({ switched: 1, unchanged: 0 })
    await rename(A, user.ownerA, product.a_JACKET, 'JACKET-2')
    await rename(A, user.ownerA, product.a_JACKET, 'JACKET')
    await rename(B, user.ownerB, product.b_JACKET, 'JACKET')
    // The hold made through the ended link is still released through its door (rule 5).
    const released = await as(B, user.ownerB, () => doors.poolRelease(database.client as never, { orderRef: 'B-SKU-1' }))
    expect(released).toMatchObject({ ok: true, released: 1, units: 2 })
    await clearTasks()
  })

  it('a SKU link whose SKUs no longer match (written past the guard) stops serving new sales', async () => {
    expect(await switchTo(B, user.ownerB, 'pool', [product.b_HELMET], grantB)).toEqual({ switched: 0, unchanged: 1 })
    expect((await as(B, user.ownerB, () => doors.poolLevels(database.client as never, [product.b_HELMET]))).size).toBe(1)
    await sql(`ALTER TABLE "Product" DISABLE TRIGGER nexus_stock_pool_product_guard`)
    await sql(`UPDATE "Product" SET sku = 'HELMET-X' WHERE id = $1`, [product.a_HELMET])
    expect((await as(B, user.ownerB, () => doors.poolLevels(database.client as never, [product.b_HELMET]))).size).toBe(0)
    const refused = await as(B, user.ownerB, () => doors.poolReserve(database.client as never, { productId: product.b_HELMET, quantity: 1, orderRef: 'B-SKU-2' }))
    expect(refused).toMatchObject({ ok: false, refusal: { code: 'not_pooled' } })
    await sql(`UPDATE "Product" SET sku = 'HELMET' WHERE id = $1`, [product.a_HELMET])
    await sql(`ALTER TABLE "Product" ENABLE TRIGGER nexus_stock_pool_product_guard`)
    expect((await as(B, user.ownerB, () => doors.poolLevels(database.client as never, [product.b_HELMET]))).size).toBe(1)
    await clearTasks()
  })

  it('every write that queues pool work wakes the worker at commit — once per transaction, never on a rollback', async () => {
    const heard: string[] = []
    const unlisten = await database.db.listen('nexus_stock_pool', (payload) => { heard.push(payload) })
    try {
      // A change nobody borrows: no task, no wake.
      await sql(`UPDATE "StockLevel" SET quantity = quantity + 1, available = available + 1 WHERE "locationId" = $1 AND "productId" = $2`, [loc.bOwn, product.b_JACKET])
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(heard).toEqual([])
      // One lent change in one transaction (two rows of work: HELMET is borrowed by B): one wake.
      await sql(`UPDATE "StockLevel" SET quantity = quantity + 1, available = available + 1 WHERE "locationId" = $1 AND "productId" = $2`, [loc.main, product.a_HELMET])
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(heard).toEqual([''])
      expect(await tasks(B)).toHaveLength(1)
      // Rolled back: the task is gone and nobody is woken.
      await database.db.transaction(async (tx) => {
        await tx.query(`UPDATE "StockLevel" SET quantity = quantity + 1, available = available + 1 WHERE "locationId" = $1 AND "productId" = $2`, [loc.main, product.a_HELMET])
        await tx.rollback()
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(heard).toEqual([''])
      expect(await tasks(B)).toHaveLength(1)
    } finally {
      await unlisten()
      await clearTasks()
    }
  })
})
