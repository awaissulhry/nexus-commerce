/**
 * Shared stock, step 1 — the lending permission, product links, work queue and the five doors, on a
 * disposable real PostgreSQL (PGlite) with the generated production policies, profiles ON.
 *
 * Contract: docs/2026-09-19-shared-stock-build.md §1. Everything that decides WHO may do WHAT — the
 * guards, row security, the triggers and the doors — is the real database code. Seeding runs as the
 * superuser, but inside the business context the triggers read, so no guard is skipped. The race
 * arms are in stock-pool-concurrency.vitest.test.ts (they need a multi-connection server).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// db.ts exports contextualDatabase(prisma), and so must this mock (see copy-preview.vitest.test.ts).
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})

const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const A = 'ws_a_pool_lender'
const B = 'ws_b_pool_borrower'
const C = 'ws_c_pool_other'

type Row = Record<string, unknown>

describe('Shared stock step 1 — permission, links, queue and doors', () => {
  let doors: typeof import('./pool-doors.js')
  let rules: typeof import('./grant-rules.js')
  const user = { ownerA: '', ownerB: '', viewerB: '', ownerC: '' }
  const loc: Record<string, string> = {}
  const product: Record<string, string> = {}
  const catalog: Record<string, string> = {}
  let shareId = ''

  const as = <T>(workspaceId: string, actorUserId: string | null, work: () => Promise<T>) =>
    withWorkspace({ workspaceId, actorUserId, membershipId: null, roleKeys: [] }, work)
  const sql = async (text: string, params: unknown[] = []) => (await database.db.query(text, params)).rows as Row[]
  /** Superuser SQL inside a business context: row security is bypassed, the triggers still run. */
  const inContext = async (workspaceId: string, actorUserId: string | null, statements: Array<[string, unknown[]?]>) =>
    database.db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('nexus.workspace_id', $1, true), set_config('nexus.actor_id', $2, true)`, [workspaceId, actorUserId ?? ''])
      const out: Row[][] = []
      for (const [text, params] of statements) out.push((await tx.query(text, params ?? [])).rows as Row[])
      return out
    })
  const dbError = async (work: Promise<unknown>) => {
    try { await work } catch (error) { return String((error as Error).message) }
    return 'NO ERROR'
  }
  const tasks = async (workspaceId: string) =>
    sql(`SELECT kind, "productId", "movementId", reason FROM "StockPoolTask" WHERE "workspaceId" = $1 ORDER BY "createdAt", id`, [workspaceId])
  const clearTasks = () => sql(`DELETE FROM "StockPoolTask"`)
  const level = async (locationId: string, productId: string) =>
    (await sql(`SELECT quantity, reserved, available FROM "StockLevel" WHERE "locationId" = $1 AND "productId" = $2`, [locationId, productId]))[0] as
      { quantity: number; reserved: number; available: number } | undefined
  const totalStock = async (productId: string) => Number((await sql(`SELECT "totalStock" FROM "Product" WHERE id = $1`, [productId]))[0].totalStock)

  /** Offer through the runtime role, as the lender. */
  const offer = (actor: string, locationIds: string[], borrower = B) =>
    as(A, actor, () => database.client.stockPoolGrant.create({ data: { ownerWorkspaceId: A, workspaceId: borrower, locationIds, createdByUserId: actor } }))
  const respond = (grantId: string, decision: string, version: number, actor = user.ownerB, borrower = B) =>
    as(borrower, actor, async () => (await database.client.$queryRaw<Array<{ r: Row }>>`SELECT nexus_stock_pool_grant_respond(${grantId}, ${decision}, ${version}::integer) AS r`)[0].r)
  const setGrant = (grantId: string, data: Row, actor = user.ownerA) =>
    as(A, actor, async () => {
      const current = await database.client.stockPoolGrant.findUniqueOrThrow({ where: { id: grantId } })
      return database.client.stockPoolGrant.update({ where: { id: grantId }, data: { ...data, version: current.version + 1 } })
    })
  const link = (productKey: string, grantId: string, actor = user.ownerB) =>
    as(B, actor, () => database.client.stockPoolLink.create({
      data: { grantId, catalogLinkId: catalog[productKey], productId: product[`b_${productKey}`], sourceProductId: product[productKey], createdByUserId: actor },
    }))

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    doors = await import('./pool-doors.js')
    rules = await import('./grant-rules.js')

    // Deployed databases carry these; schema.prisma cannot express them (stock-concurrency.vitest.test.ts).
    await sql(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await sql(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_quantity_nonneg" CHECK ("quantity" >= 0)`)
    await sql(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_reserved_nonneg" CHECK ("reserved" >= 0)`)
    await sql(`ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_quantity_positive" CHECK ("quantity" > 0)`)
    await sql(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId", "locationId", "productId") WHERE "variationId" IS NULL`)

    const ownerRole = randomUUID(), viewerRole = randomUUID()
    await sql(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,CURRENT_TIMESTAMP)`, [ownerRole])
    await sql(`INSERT INTO "Role" (id, key, name, "isSystem", permissions, "updatedAt") VALUES ($1,'VIEWER','Viewer',true,ARRAY['products.view'],CURRENT_TIMESTAMP)`, [viewerRole])
    for (const key of Object.keys(user) as Array<keyof typeof user>) {
      user[key] = randomUUID()
      await sql(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',CURRENT_TIMESTAMP)`, [user[key], `${key}@example.test`])
    }
    for (const [id, name] of [[A, 'Lender A'], [B, 'Borrower B'], [C, 'Business C']]) {
      await sql(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$2,'active','pool',$1,CURRENT_TIMESTAMP)`, [id, name])
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
    await member(C, user.ownerC, ownerRole)
    await member(C, user.ownerB, viewerRole)

    const location = async (workspaceId: string, code: string, type = 'WAREHOUSE', isActive = true) => {
      const id = randomUUID()
      await sql(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "isActive", "updatedAt") VALUES ($1,$2,$3,$4,$4,$5,CURRENT_TIMESTAMP)`, [id, workspaceId, type, code, isActive])
      return id
    }
    loc.main = await location(A, 'IT-MAIN')
    loc.second = await location(A, 'IT-SECOND')
    loc.notLent = await location(A, 'IT-OUTLET')
    loc.fba = await location(A, 'AMAZON-EU-FBA', 'AMAZON_FBA')
    loc.closed = await location(A, 'IT-CLOSED', 'WAREHOUSE', false)
    loc.bOwn = await location(B, 'B-MAIN')
    loc.cOwn = await location(C, 'C-MAIN')

    const seed = async (workspaceId: string, sku: string) => {
      const id = randomUUID()
      await sql(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ($1,$2,$3,$3,10,CURRENT_TIMESTAMP)`, [id, workspaceId, sku])
      return id
    }
    for (const key of ['jacket', 'helmet', 'gloves', 'lotted', 'boots']) {
      product[key] = await seed(A, key.toUpperCase())
      product[`b_${key}`] = await seed(B, key.toUpperCase())
    }
    product.c_jacket = await seed(C, 'JACKET')
    product.c_gloves = await seed(C, 'GLOVES')
    await sql(`INSERT INTO "Lot" (id, "workspaceId", "productId", "lotNumber", "unitsReceived", "unitsRemaining", "updatedAt") VALUES ($1,$2,$3,'L1',5,5,CURRENT_TIMESTAMP)`, [randomUUID(), A, product.lotted])

    // The product share A → B, through the real AE.2/AE.3 rules: offered pending in A, accepted in B.
    const assortmentId = randomUUID()
    shareId = randomUUID()
    await inContext(A, user.ownerA, [
      [`INSERT INTO "Assortment" (id, "workspaceId", name, selection, "updatedAt") VALUES ($1,$2,'For B','list',CURRENT_TIMESTAMP)`, [assortmentId, A]],
      ...['jacket', 'helmet', 'gloves', 'lotted', 'boots'].map((key): [string, unknown[]] => [
        `INSERT INTO "AssortmentMember" (id, "workspaceId", "assortmentId", "productId", mode) VALUES ($1,$2,$3,$4,'include')`, [randomUUID(), A, assortmentId, product[key]]]),
      [`INSERT INTO "AssortmentShare" (id, "assortmentId", "ownerWorkspaceId", "workspaceId", "fieldGroups", "createdByUserId", "updatedAt") VALUES ($1,$2,$3,$4,ARRAY['identity'],$5,CURRENT_TIMESTAMP)`, [shareId, assortmentId, A, B, user.ownerA]],
    ])
    const [[accepted]] = await inContext(B, user.ownerB, [[`SELECT nexus_assortment_share_respond($1,'accept',1) AS r`, [shareId]]])
    expect((accepted.r as Row).error).toBeUndefined()
    for (const key of ['jacket', 'helmet', 'gloves', 'lotted', 'boots']) {
      catalog[key] = randomUUID()
      await inContext(B, user.ownerB, [[
        `INSERT INTO "CatalogLink" (id, "shareId", "sourceWorkspaceId", "sourceProductId", "targetWorkspaceId", "targetProductId", "linkedBy", "sourceVersion", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'created',1,CURRENT_TIMESTAMP)`,
        [catalog[key], shareId, A, product[key], B, product[`b_${key}`]],
      ]])
    }

    // A's stock: jacket 5 at IT-MAIN and 3 at IT-SECOND, 4 at the outlet (not lent); helmet 1 at IT-MAIN.
    const stock = (locationId: string, productId: string, quantity: number, workspaceId = A) =>
      sql(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,CURRENT_TIMESTAMP)`, [randomUUID(), workspaceId, locationId, productId, quantity])
    await stock(loc.main, product.jacket, 5)
    await stock(loc.second, product.jacket, 3)
    await stock(loc.notLent, product.jacket, 4)
    await stock(loc.main, product.helmet, 1)
    await stock(loc.main, product.boots, 2)
    await stock(loc.bOwn, product.b_jacket, 7, B)
    await sql(`UPDATE "Product" SET "totalStock" = 12 WHERE id = $1`, [product.jacket])
    await clearTasks()
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  })

  // ── The lending permission ──────────────────────────────────────────────────────────────────
  let grantId = ''

  it('an offer is made only by an owner of the lender who is a member of the borrower, for its own active warehouses', async () => {
    expect(await dbError(offer(user.ownerC, [loc.main]))).toMatch(/row-level security|owner of the lending business/)
    expect(await dbError(as(A, null, () => database.client.stockPoolGrant.create({ data: { ownerWorkspaceId: A, workspaceId: B, locationIds: [loc.main], createdByUserId: user.ownerA } }))))
      .toMatch(/owner of the lending business/)
    expect(await dbError(offer(user.ownerA, [loc.main], C))).toMatch(/member of the borrowing business/)
    expect(await dbError(offer(user.ownerA, [loc.fba]))).toMatch(/never Amazon FBA stock/)
    expect(await dbError(offer(user.ownerA, [loc.closed]))).toMatch(/Only active warehouses/)
    expect(await dbError(offer(user.ownerA, [loc.bOwn]))).toMatch(/Only active warehouses/)
    expect(await dbError(offer(user.ownerA, [loc.main, loc.main]))).toMatch(/lent once/)
    expect(await dbError(offer(user.ownerA, []))).toMatch(/StockPoolGrant_locations_check/)
    // Positive control: the same call with valid terms passes.
    const created = await offer(user.ownerA, [loc.main, loc.second])
    expect(created.status).toBe('pending')
    grantId = created.id
    expect(await dbError(offer(user.ownerA, [loc.notLent]))).toMatch(/StockPoolGrant_one_open_grant|Unique constraint/)
  })

  it('the borrower reads its incoming offer and cannot write it; a third business sees nothing', async () => {
    const seen = await as(B, user.ownerB, () => database.client.stockPoolGrant.findMany({ where: { id: grantId } }))
    expect(seen).toHaveLength(1)
    const updated = await as(B, user.ownerB, () => database.client.stockPoolGrant.updateMany({ where: { id: grantId }, data: { status: 'active', version: 2 } }))
    expect(updated.count).toBe(0)
    const deleted = await as(B, user.ownerB, () => database.client.stockPoolGrant.deleteMany({ where: { id: grantId } }))
    expect(deleted.count).toBe(0)
    expect(await sql(`SELECT status FROM "StockPoolGrant" WHERE id = $1`, [grantId])).toEqual([{ status: 'pending' }])
    expect(await as(C, user.ownerC, () => database.client.stockPoolGrant.findMany({ where: { id: grantId } }))).toHaveLength(0)
    expect(await dbError(as(A, user.ownerA, () => database.client.stockPoolGrant.delete({ where: { id: grantId } })))).toMatch(/never deleted/)
  })

  it('only the borrower can accept, only an owner of it, and only the version it read', async () => {
    expect(await dbError(setGrant(grantId, { status: 'active' }))).toMatch(/owner cannot change a pending stock lending permission to active/)
    expect(await respond(grantId, 'accept', 1, user.viewerB)).toMatchObject({ code: 'workspace_owner_required' })
    expect(await respond(grantId, 'accept', 7)).toMatchObject({ code: 'grant_changed', currentVersion: 1 })
    const accepted = await respond(grantId, 'accept', 1)
    expect((accepted.grant as Row).status).toBe('active')
    expect((accepted.grant as Row).respondedByUserId).toBe(user.ownerB)
    expect(await dbError(as(A, user.ownerA, () => database.client.stockPoolGrant.update({ where: { id: grantId }, data: { locationIds: [loc.main, loc.notLent], version: 3 } }))))
      .toMatch(/cannot change; end it and offer a new one/)
  })

  it('the guard allows exactly the planned transitions for each side, and nothing else', async () => {
    const statuses = [...rules.GRANT_STATUSES]
    // The database guard and grant-rules.ts must agree on every combination (two copies of one rule drift).
    const allowed = new Set<string>()
    for (const side of ['owner', 'borrower'] as const) for (const from of statuses) for (const to of statuses) if (rules.canTransition(side, from, to)) allowed.add(`${side}:${from}:${to}`)
    const seen: string[] = []
    for (const side of ['owner', 'borrower'] as const) {
      for (const from of statuses) {
        for (const to of statuses) {
          if (from === to) continue
          // A scratch grant in `from`, written as superuser with the guard off, then one guarded change.
          const id = randomUUID()
          const ended = ['declined', 'revoked'].includes(from)
          await sql(`ALTER TABLE "StockPoolGrant" DISABLE TRIGGER nexus_stock_pool_grant_guard`)
          await sql(`INSERT INTO "StockPoolGrant" (id, "ownerWorkspaceId", "workspaceId", "locationIds", status, version, "createdByUserId", "endedBySide", "endedAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,CURRENT_TIMESTAMP)`,
            [id, A, C, [loc.notLent], from, user.ownerA, ended ? 'owner' : null, ended ? new Date() : null])
          await sql(`ALTER TABLE "StockPoolGrant" ENABLE TRIGGER nexus_stock_pool_grant_guard`)
          const actor = side === 'owner' ? user.ownerA : user.ownerC
          const context = side === 'owner' ? A : C
          const endsIt = ['declined', 'revoked'].includes(to)
          const error = await dbError(inContext(context, actor, [[
            `UPDATE "StockPoolGrant" SET status = $2, version = 2, "endedBySide" = $3, "endedByUserId" = $4, "endedAt" = $5 WHERE id = $1`,
            [id, to, endsIt ? side : null, endsIt ? actor : null, endsIt ? new Date() : null],
          ]]))
          if (error === 'NO ERROR') seen.push(`${side}:${from}:${to}`)
          else expect(error).toMatch(/cannot change a|stock lending permission/)
          await sql(`ALTER TABLE "StockPoolGrant" DISABLE TRIGGER nexus_stock_pool_grant_guard`)
          await sql(`UPDATE "StockPoolGrant" SET status = 'revoked', "endedBySide" = 'owner', "endedAt" = CURRENT_TIMESTAMP WHERE id = $1`, [id])
          await sql(`ALTER TABLE "StockPoolGrant" ENABLE TRIGGER nexus_stock_pool_grant_guard`)
        }
      }
    }
    expect(new Set(seen)).toEqual(allowed)
    expect(seen).toHaveLength(9)
  })

  // ── Product links ───────────────────────────────────────────────────────────────────────────
  it('a product link needs an owner of the borrower, an active grant, and a catalog link to that lender product', async () => {
    expect(await dbError(link('jacket', grantId, user.viewerB))).toMatch(/Only an owner of this business/)
    // A catalog link of another product.
    expect(await dbError(as(B, user.ownerB, () => database.client.stockPoolLink.create({
      data: { grantId, catalogLinkId: catalog.helmet, productId: product.b_jacket, sourceProductId: product.jacket, createdByUserId: user.ownerB },
    })))).toMatch(/linked to a product of the lending business/)
    expect(await dbError(link('lotted', grantId))).toMatch(/lot or serial number/)
    // The lender cannot write the borrower's link: the scoped client refuses it, and so does the
    // database guard on its own (superuser SQL in the lender's context skips row security, not the guard).
    expect(await dbError(as(A, user.ownerA, () => database.client.stockPoolLink.create({
      data: { workspaceId: B, grantId, catalogLinkId: catalog.jacket, productId: product.b_jacket, sourceProductId: product.jacket, createdByUserId: user.ownerA },
    })))).toMatch(/belongs to a different business/)
    expect(await dbError(inContext(A, user.ownerA, [[
      `INSERT INTO "StockPoolLink" (id, "workspaceId", "grantId", "catalogLinkId", "productId", "sourceProductId", "createdByUserId", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP)`,
      [randomUUID(), B, grantId, catalog.jacket, product.b_jacket, product.jacket, user.ownerA],
    ]]))).toMatch(/Only the business that borrows stock can link/)
    // Positive control.
    const created = await link('jacket', grantId)
    expect(created.status).toBe('active')
    expect(await tasks(B)).toEqual([{ kind: 'recascade', productId: product.b_jacket, movementId: null, reason: 'link' }])
    expect(await dbError(link('jacket', grantId))).toMatch(/StockPoolLink_one_active_per_product|Unique constraint/)
    await link('helmet', grantId)
    await link('boots', grantId)
    await clearTasks()
  })

  it('shared stock is never passed on: a borrowed product cannot lend, a lending product cannot borrow', async () => {
    // B shares jacket and gloves on to C, and lends C its own warehouse — both through the real rules.
    const assortmentId = randomUUID(), shareBC = randomUUID()
    await inContext(B, user.ownerB, [
      [`INSERT INTO "Assortment" (id, "workspaceId", name, selection, "updatedAt") VALUES ($1,$2,'For C','list',CURRENT_TIMESTAMP)`, [assortmentId, B]],
      [`INSERT INTO "AssortmentMember" (id, "workspaceId", "assortmentId", "productId", mode) VALUES ($1,$2,$3,$4,'include')`, [randomUUID(), B, assortmentId, product.b_jacket]],
      [`INSERT INTO "AssortmentMember" (id, "workspaceId", "assortmentId", "productId", mode) VALUES ($1,$2,$3,$4,'include')`, [randomUUID(), B, assortmentId, product.b_gloves]],
      [`INSERT INTO "AssortmentShare" (id, "assortmentId", "ownerWorkspaceId", "workspaceId", "fieldGroups", "createdByUserId", "updatedAt") VALUES ($1,$2,$3,$4,ARRAY['identity'],$5,CURRENT_TIMESTAMP)`, [shareBC, assortmentId, B, C, user.ownerB]],
    ])
    await inContext(C, user.ownerC, [[`SELECT nexus_assortment_share_respond($1,'accept',1)`, [shareBC]]])
    const catalogC: Record<string, string> = { jacket: randomUUID(), gloves: randomUUID() }
    for (const key of ['jacket', 'gloves']) {
      await inContext(C, user.ownerC, [[
        `INSERT INTO "CatalogLink" (id, "shareId", "sourceWorkspaceId", "sourceProductId", "targetWorkspaceId", "targetProductId", "linkedBy", "sourceVersion", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'created',1,CURRENT_TIMESTAMP)`,
        [catalogC[key], shareBC, B, product[`b_${key}`], C, product[`c_${key}`]],
      ]])
    }
    const grantBC = await as(B, user.ownerB, () => database.client.stockPoolGrant.create({ data: { ownerWorkspaceId: B, workspaceId: C, locationIds: [loc.bOwn], createdByUserId: user.ownerB } }))
    expect(await respond(grantBC.id, 'accept', 1, user.ownerC, C)).toMatchObject({ grant: { status: 'active' } })
    const linkC = (key: string) => as(C, user.ownerC, () => database.client.stockPoolLink.create({
      data: { grantId: grantBC.id, catalogLinkId: catalogC[key], productId: product[`c_${key}`], sourceProductId: product[`b_${key}`], createdByUserId: user.ownerC },
    }))
    // B's jacket borrows from A, so C cannot borrow it from B.
    expect(await dbError(linkC('jacket'))).toMatch(/lends or borrows/)
    // Positive control: B's gloves borrow from no one, so C can.
    expect((await linkC('gloves')).status).toBe('active')
    // …and now B's gloves lend to C, so they cannot borrow from A.
    expect(await dbError(link('gloves', grantId))).toMatch(/lends or borrows/)
    // The lender reads none of the borrower's links.
    expect(await as(A, user.ownerA, () => database.client.stockPoolLink.findMany())).toHaveLength(0)
    await clearTasks()
  })

  // ── The work queue ──────────────────────────────────────────────────────────────────────────
  it('a stock change at a lent warehouse queues the borrower; elsewhere, or for a product nobody borrows, nothing', async () => {
    await clearTasks()
    await sql(`UPDATE "StockLevel" SET quantity = quantity + 1, available = available + 1 WHERE "locationId" = $1 AND "productId" = $2`, [loc.notLent, product.jacket])
    await sql(`UPDATE "StockLevel" SET quantity = quantity + 1, available = available + 1 WHERE "locationId" = $1 AND "productId" = $2`, [loc.bOwn, product.b_jacket])
    await sql(`UPDATE "StockLevel" SET "reorderThreshold" = 3 WHERE "locationId" = $1 AND "productId" = $2`, [loc.main, product.jacket])
    expect(await tasks(B)).toEqual([])
    await sql(`UPDATE "StockLevel" SET quantity = quantity + 1, available = available + 1 WHERE "locationId" = $1 AND "productId" = $2`, [loc.second, product.jacket])
    expect(await tasks(B)).toEqual([{ kind: 'recascade', productId: product.b_jacket, movementId: null, reason: 'stock' }])
    await sql(`UPDATE "StockLevel" SET quantity = quantity - 1, available = available - 1 WHERE "locationId" = $1 AND "productId" = $2`, [loc.second, product.jacket])
    await sql(`UPDATE "StockLevel" SET quantity = quantity - 1, available = available - 1 WHERE "locationId" = $1 AND "productId" = $2`, [loc.notLent, product.jacket])
    await clearTasks()
  })

  it('a lent warehouse switched off, on or retyped queues its borrowers; an unlent one, or a change that keeps it counting, nothing', async () => {
    const borrowers = [product.b_boots, product.b_helmet, product.b_jacket].map((p) => [p, 'location']).sort()
    const queued = async () => (await tasks(B)).map((t) => [t.productId, t.reason]).sort()
    const setLocation = (id: string, set: string, value: unknown) => sql(`UPDATE "StockLocation" SET ${set} = $2 WHERE id = $1`, [id, value])
    await clearTasks()
    // Not lent by any grant: nothing, either way.
    await setLocation(loc.notLent, '"isActive"', false)
    await setLocation(loc.notLent, '"isActive"', true)
    // Lent, but still counting after the change (same flag, another name): nothing.
    await setLocation(loc.second, '"isActive"', true)
    await setLocation(loc.second, 'name', 'IT-SECOND renamed')
    await setLocation(loc.second, 'name', 'IT-SECOND')
    expect(await tasks(B)).toEqual([])
    expect(await tasks(C)).toEqual([])

    // Switched off: one task per borrower product linked through the grant; door 1 now counts it as 0.
    await setLocation(loc.second, '"isActive"', false)
    expect(await queued()).toEqual(borrowers)
    expect(await tasks(C)).toEqual([]) // C borrows from B, not from this lender
    const levels = await as(B, user.ownerB, () => doors.poolLevels(database.client as never, [product.b_jacket]))
    expect(levels.get(product.b_jacket)!.map((l) => [l.locationCode, l.available])).toEqual([['IT-MAIN', 5], ['IT-SECOND', 0]])
    await clearTasks()
    // Still off and retyped: it did not count before and does not count now — nothing.
    await setLocation(loc.second, 'type', 'CHANNEL_RESERVED')
    expect(await tasks(B)).toEqual([])
    await setLocation(loc.second, 'type', 'WAREHOUSE')
    expect(await tasks(B)).toEqual([])
    // Switched on again: queued again.
    await setLocation(loc.second, '"isActive"', true)
    expect(await queued()).toEqual(borrowers)
    await clearTasks()
    // Retyped while on: it stops counting — queued; and back to a warehouse — queued again.
    await setLocation(loc.second, 'type', 'CHANNEL_RESERVED')
    expect(await queued()).toEqual(borrowers)
    await clearTasks()
    await setLocation(loc.second, 'type', 'WAREHOUSE')
    expect(await queued()).toEqual(borrowers)
    expect((await as(B, user.ownerB, () => doors.poolLevels(database.client as never, [product.b_jacket]))).get(product.b_jacket)!.map((l) => l.available)).toEqual([5, 3])
    await clearTasks()
  })

  it('a lending business that stops being active, or comes back, queues every borrower of a grant that is on; a borrower that stops, nothing', async () => {
    const borrowers = [product.b_boots, product.b_helmet, product.b_jacket].map((p) => [p, 'lender']).sort()
    const queued = async () => (await tasks(B)).map((t) => [t.productId, t.reason]).sort()
    await clearTasks()
    // A change that is not about being active: nothing.
    await sql(`UPDATE "Workspace" SET name = 'Lender A renamed' WHERE id = $1`, [A])
    await sql(`UPDATE "Workspace" SET name = 'Lender A' WHERE id = $1`, [A])
    await sql(`UPDATE "Workspace" SET status = 'active' WHERE id = $1`, [A])
    expect(await tasks(B)).toEqual([])

    await sql(`UPDATE "Workspace" SET status = 'archived' WHERE id = $1`, [A])
    expect(await queued()).toEqual(borrowers)
    // While the lender is not active, the borrower sells from no pool.
    expect((await as(B, user.ownerB, () => doors.poolLevels(database.client as never, [product.b_jacket]))).size).toBe(0)
    await clearTasks()
    await sql(`UPDATE "Workspace" SET status = 'active' WHERE id = $1`, [A])
    expect(await queued()).toEqual(borrowers)
    expect((await as(B, user.ownerB, () => doors.poolLevels(database.client as never, [product.b_jacket]))).size).toBe(1)
    await clearTasks()

    // B lends to C as well (grant B → C, one linked product); B stopping queues C, and nothing for B itself.
    await sql(`UPDATE "Workspace" SET status = 'archived' WHERE id = $1`, [B])
    expect(await tasks(B)).toEqual([])
    expect((await tasks(C)).map((t) => [t.productId, t.reason])).toEqual([[product.c_gloves, 'lender']])
    await sql(`UPDATE "Workspace" SET status = 'active' WHERE id = $1`, [B])
    await clearTasks()
  })

  // ── Door 1: check ───────────────────────────────────────────────────────────────────────────
  it('CHECK shows the borrower one row per lent warehouse, only for linked products, and nothing to anyone else', async () => {
    const levels = await as(B, user.ownerB, () => doors.poolLevels(database.client as never, [product.b_jacket, product.b_gloves, product.b_helmet]))
    expect([...levels.keys()].sort()).toEqual([product.b_helmet, product.b_jacket].sort())
    expect(levels.get(product.b_jacket)!.map((l) => [l.locationCode, l.available])).toEqual([['IT-MAIN', 5], ['IT-SECOND', 3]])
    expect(levels.get(product.b_helmet)!.map((l) => [l.locationCode, l.available])).toEqual([['IT-MAIN', 1], ['IT-SECOND', 0]])
    expect((await as(A, user.ownerA, () => doors.poolLevels(database.client as never, [product.jacket, product.b_jacket]))).size).toBe(0)
    expect((await as(C, user.ownerC, () => doors.poolLevels(database.client as never, [product.b_jacket]))).size).toBe(0)
    // The borrower still cannot read the lender's stock rows directly.
    expect(await as(B, user.ownerB, () => database.client.stockLevel.findMany({ where: { productId: product.jacket } }))).toHaveLength(0)
  })

  // ── Door 2: hold ────────────────────────────────────────────────────────────────────────────
  it('HOLD takes from the warehouse with the most, records the borrower and its order, and queues both businesses', async () => {
    const held = await as(B, user.ownerB, () => doors.poolReserve(database.client as never, { productId: product.b_jacket, quantity: 2, orderRef: 'B-ORDER-1', actor: 'amazon-orders-sync' }))
    expect(held).toMatchObject({ ok: true, quantity: 2, state: 'open', reused: false, locationCode: 'IT-MAIN', availableAfter: 3, grantId })
    expect(await level(loc.main, product.jacket)).toEqual({ quantity: 5, reserved: 2, available: 3 })
    const [reservation] = await sql(`SELECT "workspaceId", reason, kind, "orderId", "poolGrantId", "consumerWorkspaceId", "consumerOrderRef" FROM "StockReservation" WHERE id = $1`, [(held as { reservationId: string }).reservationId])
    expect(reservation).toEqual({ workspaceId: A, reason: 'OPEN_ORDER', kind: 'HARD', orderId: null, poolGrantId: grantId, consumerWorkspaceId: B, consumerOrderRef: 'B-ORDER-1' })
    const [movement] = await sql(`SELECT id, reason, change, "consumerWorkspaceId", "poolSettledAt" FROM "StockMovement" WHERE "reservationId" = $1`, [(held as { reservationId: string }).reservationId])
    expect(movement).toMatchObject({ reason: 'RESERVATION_CREATED', change: 0, consumerWorkspaceId: B, poolSettledAt: null })
    expect(await tasks(A)).toEqual([{ kind: 'settle', productId: product.jacket, movementId: movement.id, reason: 'door' }])
    expect(await tasks(B)).toEqual([{ kind: 'recascade', productId: product.b_jacket, movementId: null, reason: 'stock' }])
    // The borrower sees none of it directly.
    expect(await as(B, user.ownerB, () => database.client.stockReservation.findMany())).toHaveLength(0)
    await clearTasks()
  })

  it('HOLD is one per order and product, ever; refuses what cannot be held in one warehouse, and products not in the pool', async () => {
    const again = await as(B, user.ownerB, () => doors.poolReserve(database.client as never, { productId: product.b_jacket, quantity: 5, orderRef: 'B-ORDER-1' }))
    expect(again).toMatchObject({ ok: true, reused: true, state: 'open', quantity: 2 })
    expect(await level(loc.main, product.jacket)).toEqual({ quantity: 5, reserved: 2, available: 3 })
    const tooMany = await as(B, user.ownerB, () => doors.poolReserve(database.client as never, { productId: product.b_jacket, quantity: 4, orderRef: 'B-ORDER-2' }))
    expect(tooMany).toMatchObject({ ok: false, refusal: { code: 'insufficient', status: 409, available: 6 } })
    const own = await as(B, user.ownerB, () => doors.poolReserve(database.client as never, { productId: product.b_gloves, quantity: 1, orderRef: 'B-ORDER-2' }))
    expect(own).toMatchObject({ ok: false, refusal: { code: 'not_pooled' } })
    const lender = await as(A, user.ownerA, () => doors.poolReserve(database.client as never, { productId: product.jacket, quantity: 1, orderRef: 'A-ORDER' }))
    expect(lender).toMatchObject({ ok: false, refusal: { code: 'not_pooled' } })
    const noOrder = await as(B, user.ownerB, () => doors.poolReserve(database.client as never, { productId: product.b_jacket, quantity: 1, orderRef: ' ' }))
    expect(noOrder).toMatchObject({ ok: false, refusal: { code: 'order_required' } })
    expect(await tasks(A)).toEqual([])
  })

  // Shared stock step 4 — the repair job's list.
  it('the repair list shows a business only its OWN orders that hold stock in a pool — order references only', async () => {
    const list = (workspaceId: string, actor: string | null, max = 10) => as(workspaceId, actor, () =>
      database.client.$queryRaw<Array<{ order_ref: string }>>`SELECT order_ref FROM nexus_pool_open_hold_orders(${max}::integer)`)
    expect(await list(B, user.ownerB)).toEqual([{ order_ref: 'B-ORDER-1' }])
    expect(await list(B, user.ownerB, 0)).toEqual([{ order_ref: 'B-ORDER-1' }]) // at least one
    expect(await list(C, user.ownerC)).toEqual([]) // another borrower
    expect(await list(A, user.ownerA)).toEqual([]) // the lender does not see the borrower's orders
    expect(await list('', null)).toEqual([]) // no business
  })

  it('the ship-from doors answer only the borrower: its lent addresses, and where its own order\'s units are', async () => {
    const addresses = (workspaceId: string, actor: string | null) => as(workspaceId, actor, () =>
      database.client.$queryRaw<Array<{ lender_name: string; location_code: string; grant_status: string }>>`SELECT lender_name, location_code, grant_status FROM nexus_pool_lent_addresses()`)
    expect(await addresses(B, user.ownerB)).toEqual([
      { lender_name: 'Lender A', location_code: 'IT-MAIN', grant_status: 'active' },
      { lender_name: 'Lender A', location_code: 'IT-SECOND', grant_status: 'active' },
    ])
    // C borrows from B (the "no chains" arm): C sees exactly B's lent warehouse, and nothing of A's.
    expect(await addresses(C, user.ownerC)).toEqual([{ lender_name: 'Borrower B', location_code: 'B-MAIN', grant_status: 'active' }])
    expect(await addresses(A, user.ownerA)).toEqual([]) // the lender borrows nothing
    const from = (workspaceId: string, actor: string | null, orderRef: string) => as(workspaceId, actor, () =>
      database.client.$queryRaw<Array<{ location_id: string; units: number }>>`SELECT location_id, units FROM nexus_pool_order_locations(${orderRef})`)
    expect(await from(B, user.ownerB, 'B-ORDER-1')).toEqual([{ location_id: loc.main, units: 2 }])
    expect(await from(C, user.ownerC, 'B-ORDER-1')).toEqual([]) // another business's order reference
    expect(await from(A, user.ownerA, 'B-ORDER-1')).toEqual([])
    expect(await from(B, user.ownerB, 'NO-SUCH-ORDER')).toEqual([])
  })

  // ── Door 3: give back ───────────────────────────────────────────────────────────────────────
  it('GIVE BACK releases an order\'s open holds once; a released hold is never held again for that order', async () => {
    const hold = await as(B, user.ownerB, () => doors.poolReserve(database.client as never, { productId: product.b_helmet, quantity: 1, orderRef: 'B-ORDER-3' }))
    expect(hold).toMatchObject({ ok: true, locationCode: 'IT-MAIN' })
    expect(await level(loc.main, product.helmet)).toEqual({ quantity: 1, reserved: 1, available: 0 })
    const released = await as(B, user.ownerB, () => doors.poolRelease(database.client as never, { orderRef: 'B-ORDER-3', reason: 'order cancelled by channel' }))
    expect(released).toMatchObject({ ok: true, released: 1, units: 1 })
    expect(await level(loc.main, product.helmet)).toEqual({ quantity: 1, reserved: 0, available: 1 })
    expect(await as(B, user.ownerB, () => doors.poolRelease(database.client as never, { orderRef: 'B-ORDER-3' }))).toMatchObject({ ok: true, released: 0 })
    // A re-poll of the cancelled order must not hold it again (the re-ingest defect in reserveOpenOrder).
    expect(await as(B, user.ownerB, () => doors.poolReserve(database.client as never, { productId: product.b_helmet, quantity: 1, orderRef: 'B-ORDER-3' })))
      .toMatchObject({ ok: true, reused: true, state: 'released' })
    expect(await level(loc.main, product.helmet)).toEqual({ quantity: 1, reserved: 0, available: 1 })
    // Another business cannot release B's hold.
    expect(await as(C, user.ownerC, () => doors.poolRelease(database.client as never, { orderRef: 'B-ORDER-1' }))).toMatchObject({ ok: true, released: 0 })
    expect(await level(loc.main, product.jacket)).toEqual({ quantity: 5, reserved: 2, available: 3 })
    await clearTasks()
  })

  // ── Door 4a: take out a hold ────────────────────────────────────────────────────────────────
  it('TAKE OUT a hold removes the units, keeps the lender total right, and happens once', async () => {
    const consumed = await as(B, user.ownerB, () => doors.poolConsume(database.client as never, { orderRef: 'B-ORDER-1', actor: 'amazon-orders-sync' }))
    expect(consumed).toMatchObject({ ok: true, consumed: 1, units: 2 })
    expect(await level(loc.main, product.jacket)).toEqual({ quantity: 3, reserved: 0, available: 3 })
    expect(await totalStock(product.jacket)).toBe(3 + 3 + 4) // WAREHOUSE quantity only: IT-MAIN, IT-SECOND, IT-OUTLET
    const [movement] = await sql(`SELECT reason, change, "quantityBefore", "balanceAfter", "consumerOrderRef" FROM "StockMovement" WHERE reason = 'RESERVATION_CONSUMED' AND "consumerOrderRef" = 'B-ORDER-1'`)
    expect(movement).toEqual({ reason: 'RESERVATION_CONSUMED', change: -2, quantityBefore: 5, balanceAfter: 3, consumerOrderRef: 'B-ORDER-1' })
    expect(await as(B, user.ownerB, () => doors.poolConsume(database.client as never, { orderRef: 'B-ORDER-1' }))).toMatchObject({ ok: true, consumed: 0 })
    expect((await tasks(A)).map((t) => t.kind)).toEqual(['settle'])
    await clearTasks()
  })

  // ── Door 4b: take out at once ───────────────────────────────────────────────────────────────
  it('TAKE OUT at once splits across warehouses (most first), is all or nothing, and happens once per order', async () => {
    const short = await as(B, user.ownerB, () => doors.poolTake(database.client as never, { productId: product.b_jacket, quantity: 7, orderRef: 'EBAY-1' }))
    expect(short).toMatchObject({ ok: false, refusal: { code: 'insufficient', available: 6 } })
    expect(await level(loc.main, product.jacket)).toEqual({ quantity: 3, reserved: 0, available: 3 })
    await sql(`UPDATE "StockLevel" SET quantity = 4, available = 4 WHERE "locationId" = $1 AND "productId" = $2`, [loc.second, product.jacket])
    const taken = await as(B, user.ownerB, () => doors.poolTake(database.client as never, { productId: product.b_jacket, quantity: 5, orderRef: 'EBAY-1', actor: 'ebay-orders-sync' }))
    expect(taken).toMatchObject({ ok: true, taken: 5, reused: false })
    expect((taken as { movements: Array<{ units: number }> }).movements.map((m) => m.units)).toEqual([4, 1])
    expect(await level(loc.second, product.jacket)).toEqual({ quantity: 0, reserved: 0, available: 0 })
    expect(await level(loc.main, product.jacket)).toEqual({ quantity: 2, reserved: 0, available: 2 })
    expect(await totalStock(product.jacket)).toBe(2 + 0 + 4)
    expect(await as(B, user.ownerB, () => doors.poolTake(database.client as never, { productId: product.b_jacket, quantity: 5, orderRef: 'EBAY-1' })))
      .toMatchObject({ ok: true, taken: 5, reused: true })
    expect(await level(loc.main, product.jacket)).toEqual({ quantity: 2, reserved: 0, available: 2 })
    expect((await tasks(A)).map((t) => t.kind)).toEqual(['settle', 'settle'])
    await clearTasks()
  })

  // ── Door 5: put back ────────────────────────────────────────────────────────────────────────
  it('PUT BACK returns units to the warehouse they left, never more than the order took, once per return', async () => {
    const notOurs = await as(B, user.ownerB, () => doors.poolPutBack(database.client as never, { productId: product.b_jacket, quantity: 1, orderRef: 'NEVER-SOLD', putBackRef: 'R-0', reason: 'RETURN_RESTOCKED' }))
    expect(notOurs).toMatchObject({ ok: false, refusal: { code: 'not_from_pool' } })
    // EBAY-1 took 4 from IT-SECOND and 1 from IT-MAIN: its units come back to IT-SECOND.
    const back = await as(B, user.ownerB, () => doors.poolPutBack(database.client as never, { productId: product.b_jacket, quantity: 2, orderRef: 'EBAY-1', putBackRef: 'RETURN-1', reason: 'RETURN_RESTOCKED' }))
    expect(back).toMatchObject({ ok: true, reused: false, units: 2 })
    expect(await level(loc.second, product.jacket)).toEqual({ quantity: 2, reserved: 0, available: 2 })
    expect(await as(B, user.ownerB, () => doors.poolPutBack(database.client as never, { productId: product.b_jacket, quantity: 2, orderRef: 'EBAY-1', putBackRef: 'RETURN-1', reason: 'RETURN_RESTOCKED' })))
      .toMatchObject({ ok: true, reused: true })
    expect(await level(loc.second, product.jacket)).toEqual({ quantity: 2, reserved: 0, available: 2 })
    const tooMany = await as(B, user.ownerB, () => doors.poolPutBack(database.client as never, { productId: product.b_jacket, quantity: 4, orderRef: 'EBAY-1', putBackRef: 'CANCEL', reason: 'ORDER_CANCELLED' }))
    expect(tooMany).toMatchObject({ ok: false, refusal: { code: 'more_than_sold', taken: 5, returned: 2 } })
    expect(await as(B, user.ownerB, () => doors.poolPutBack(database.client as never, { productId: product.b_jacket, quantity: 3, orderRef: 'EBAY-1', putBackRef: 'EBAY-1', reason: 'ORDER_CANCELLED' })))
      .toMatchObject({ ok: true, units: 3 })
    expect(await level(loc.second, product.jacket)).toEqual({ quantity: 5, reserved: 0, available: 5 })
    expect(await level(loc.main, product.jacket)).toEqual({ quantity: 2, reserved: 0, available: 2 })
    expect(await totalStock(product.jacket)).toBe(2 + 5 + 4)
    const [returned] = await sql(`SELECT reason, "referenceType", "referenceId", change FROM "StockMovement" WHERE "consumerOrderRef" = 'EBAY-1' AND reason = 'RETURN_RESTOCKED'`)
    expect(returned).toEqual({ reason: 'RETURN_RESTOCKED', referenceType: 'Return', referenceId: 'RETURN-1', change: 2 })
    await clearTasks()
  })

  // ── What each side may know ─────────────────────────────────────────────────────────────
  it('grant details, the pause preview, the switch preview and the work list answer only who may know', async () => {
    const details = (workspaceId: string, actor: string) => as(workspaceId, actor, () =>
      database.client.$queryRaw<Array<{ grant_id: string; linked_products: number; locations: Array<{ code: string }> }>>`SELECT * FROM nexus_pool_grant_details(${[grantId]}::text[])`)
    const lenderView = await details(A, user.ownerA)
    expect(lenderView).toHaveLength(1)
    expect(lenderView[0].locations.map((l) => l.code)).toEqual(['IT-MAIN', 'IT-SECOND'])
    expect(Number(lenderView[0].linked_products)).toBe(3)
    expect(await details(B, user.ownerB)).toHaveLength(1)
    expect(await details(C, user.ownerC)).toHaveLength(0)

    const impact = (workspaceId: string, actor: string) => as(workspaceId, actor, async () =>
      (await database.client.$queryRaw<Array<{ r: Row }>>`SELECT nexus_pool_grant_impact(${grantId}) AS r`)[0].r)
    expect(await impact(A, user.ownerA)).toMatchObject({ grantId, linkedProducts: 3 })
    expect(await impact(C, user.ownerC)).toMatchObject({ code: 'grant_not_found', status: 404 })

    const preview = (workspaceId: string, actor: string, productId: string) => as(workspaceId, actor, () =>
      database.client.$queryRaw<Array<{ product_id: string; available: number }>>`SELECT product_id, available FROM nexus_pool_preview(${grantId}, ${[productId]}::text[])`)
    expect((await preview(B, user.ownerB, product.b_gloves)).map((r) => Number(r.available))).toEqual([0, 0]) // shared, not yet switched
    expect(await preview(C, user.ownerC, product.b_gloves)).toHaveLength(0)
    expect(await preview(A, user.ownerA, product.gloves)).toHaveLength(0)

    // The worker's list: only in the empty (system) context, and only business ids.
    await sql(`INSERT INTO "StockPoolTask" (id, "workspaceId", kind, "productId", reason) VALUES ($1,$2,'recascade',$3,'stock')`, [randomUUID(), B, product.b_jacket])
    const pending = (workspaceId: string) => as(workspaceId, null, () =>
      database.client.$queryRaw<Array<{ workspace_id: string }>>`SELECT workspace_id FROM nexus_pool_pending_workspaces()`)
    expect(await pending(B)).toEqual([])
    expect(await pending('')).toEqual([{ workspace_id: B }])
    await clearTasks()
  })

  // ── Switching off ───────────────────────────────────────────────────────────────────────────
  it('a pause stops new sales and queues the listings; orders already made can still be given back and taken out', async () => {
    const held = await as(B, user.ownerB, () => doors.poolReserve(database.client as never, { productId: product.b_boots, quantity: 1, orderRef: 'B-ORDER-9' }))
    expect(held).toMatchObject({ ok: true })
    await clearTasks()
    const paused = await setGrant(grantId, { status: 'paused', pausedByUserId: user.ownerA, pausedAt: new Date() })
    expect(paused.status).toBe('paused')
    expect((await tasks(B)).map((t) => [t.productId, t.reason]).sort()).toEqual([[product.b_boots, 'grant'], [product.b_helmet, 'grant'], [product.b_jacket, 'grant']].sort())
    expect((await as(B, user.ownerB, () => doors.poolLevels(database.client as never, [product.b_jacket]))).size).toBe(0)
    expect(await as(B, user.ownerB, () => doors.poolTake(database.client as never, { productId: product.b_jacket, quantity: 1, orderRef: 'EBAY-2' })))
      .toMatchObject({ ok: false, refusal: { code: 'not_pooled' } })
    // A stock change while paused queues nothing: the listings already left the pool.
    await clearTasks()
    await sql(`UPDATE "StockLevel" SET quantity = quantity + 1, available = available + 1 WHERE "locationId" = $1 AND "productId" = $2`, [loc.main, product.jacket])
    expect(await tasks(B)).toEqual([])
    expect(await as(B, user.ownerB, () => doors.poolConsume(database.client as never, { orderRef: 'B-ORDER-9' }))).toMatchObject({ ok: true, consumed: 1, units: 1 })
    expect(await level(loc.main, product.boots)).toEqual({ quantity: 1, reserved: 0, available: 1 })
    await setGrant(grantId, { status: 'active', pausedByUserId: null, pausedAt: null })
    expect((await as(B, user.ownerB, () => doors.poolLevels(database.client as never, [product.b_jacket]))).size).toBe(1)
    await clearTasks()
  })

  it('the borrower switching one product back to its own stock ends that link only, and it stays ended', async () => {
    const [helmetLink] = await as(B, user.ownerB, () => database.client.stockPoolLink.findMany({ where: { productId: product.b_helmet, status: 'active' } }))
    await as(B, user.ownerB, () => database.client.stockPoolLink.update({ where: { id: helmetLink.id }, data: { status: 'ended', endedAt: new Date(), endedByUserId: user.ownerB, endedReason: 'Switched to this business\'s own stock.' } }))
    expect(await tasks(B)).toEqual([{ kind: 'recascade', productId: product.b_helmet, movementId: null, reason: 'link' }])
    expect(await dbError(as(B, user.ownerB, () => database.client.stockPoolLink.update({ where: { id: helmetLink.id }, data: { status: 'active', endedAt: null, endedReason: null } }))))
      .toMatch(/stays ended/)
    expect(await dbError(as(B, user.ownerB, () => database.client.stockPoolLink.delete({ where: { id: helmetLink.id } })))).toMatch(/never deleted/)
    expect([...(await as(B, user.ownerB, () => doors.poolLevels(database.client as never, [product.b_helmet, product.b_jacket]))).keys()]).toEqual([product.b_jacket])
    // Switching it back is a new link.
    await link('helmet', grantId)
    await clearTasks()
  })

  it('ending the product share ends the pool links that relied on it; ending the grant ends the rest', async () => {
    // Detach one catalog link the way an ended share does it (the AE.3 trigger, as definer, from A).
    await sql(`ALTER TABLE "CatalogLink" DISABLE TRIGGER nexus_catalog_link_guard`)
    await sql(`UPDATE "CatalogLink" SET status = 'detached', "detachedAt" = CURRENT_TIMESTAMP, "detachedReason" = 'test' WHERE id = $1`, [catalog.boots])
    await sql(`ALTER TABLE "CatalogLink" ENABLE TRIGGER nexus_catalog_link_guard`)
    expect(await sql(`SELECT status, "endedReason" FROM "StockPoolLink" WHERE "productId" = $1`, [product.b_boots]))
      .toEqual([{ status: 'ended', endedReason: 'The product share with the lending business ended.' }])
    expect(await tasks(B)).toEqual([{ kind: 'recascade', productId: product.b_boots, movementId: null, reason: 'link' }])
    await clearTasks()

    const hold = await as(B, user.ownerB, () => doors.poolReserve(database.client as never, { productId: product.b_jacket, quantity: 1, orderRef: 'B-ORDER-10' }))
    expect(hold).toMatchObject({ ok: true })
    await clearTasks() // the hold itself queued B once ('stock'), as the HOLD arm shows
    const now = new Date()
    await setGrant(grantId, { status: 'revoked', endedBySide: 'owner', endedByUserId: user.ownerA, endedAt: now })
    expect(await sql(`SELECT status, "endedReason" FROM "StockPoolLink" WHERE "grantId" = $1 AND "endedReason" LIKE 'The lending%' ORDER BY "productId"`, [grantId]))
      .toEqual([{ status: 'ended', endedReason: 'The lending business ended the shared stock.' }, { status: 'ended', endedReason: 'The lending business ended the shared stock.' }])
    expect((await tasks(B)).map((t) => t.reason)).toEqual(['link', 'link'])
    expect((await as(B, user.ownerB, () => doors.poolLevels(database.client as never, [product.b_jacket]))).size).toBe(0)
    // Orders already made are never stranded: the hold can still be given back after the end.
    expect(await as(B, user.ownerB, () => doors.poolRelease(database.client as never, { orderRef: 'B-ORDER-10' }))).toMatchObject({ ok: true, released: 1 })
    // And a unit sold earlier can still come back to the lender's shelf.
    expect(await as(B, user.ownerB, () => doors.poolPutBack(database.client as never, { productId: product.b_jacket, quantity: 1, orderRef: 'B-ORDER-1', putBackRef: 'RETURN-2', reason: 'RETURN_RESTOCKED' })))
      .toMatchObject({ ok: true, units: 1 })
    // A new offer after the end is possible (one OPEN grant per pair, not one ever).
    const again = await offer(user.ownerA, [loc.main])
    expect(again.status).toBe('pending')
  })

  it('the lender ledger balances: IT-MAIN equals its start plus its movements, and reserved equals the open holds', async () => {
    const rows = await sql(`
      SELECT lv."productId", lv."locationId", lv.quantity, lv.reserved,
        (SELECT COALESCE(SUM(m.change), 0) FROM "StockMovement" m WHERE m."productId" = lv."productId" AND m."locationId" = lv."locationId")::int AS moved,
        (SELECT COALESCE(SUM(r.quantity), 0) FROM "StockReservation" r WHERE r."stockLevelId" = lv.id AND r."releasedAt" IS NULL AND r."consumedAt" IS NULL AND r.kind = 'HARD')::int AS held
      FROM "StockLevel" lv WHERE lv."workspaceId" = $1`, [A])
    expect(rows).toHaveLength(5) // jacket ×3 warehouses, helmet, boots
    for (const row of rows) expect(Number(row.reserved)).toBe(Number(row.held))
    // Jacket at IT-MAIN was seeded at 5 and raised by 1 by hand in the pause arm (no movement);
    // every other change to it was a door writing a movement: −2 consumed, −1 taken, +1 put back.
    const jacketMain = rows.find((r) => r.productId === product.jacket && r.locationId === loc.main)!
    expect(Number(jacketMain.moved)).toBe(-2)
    expect(Number(jacketMain.quantity)).toBe(5 + 1 + Number(jacketMain.moved))
  })
})
