/**
 * AE.3a — the guarded source read, catalog-link rules and Review 1, on a real disposable PostgreSQL
 * with the generated policies, profiles ON.
 *
 * The master-sheet column dictionary is a fixture (as in the catalog-transfer suites); everything that
 * decides WHO may read WHAT — the database function, row security, the link trigger — is real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// db.ts exports contextualDatabase(prisma), and so must this mock: without the wrapper a write made inside
// inDatabaseTransaction would commit outside the transaction.
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
    column('name', 'column'), column('description', 'column'), column('gtin', 'column'), column('weightValue', 'column', 'number'),
    column('basePrice', 'column', 'number'), column('totalStock', 'column', 'number'), column('fulfillmentMethod', 'column'), column('armor_level', 'categoryAttributes'),
  ] }),
  clearSheetColumnCache: () => {},
  coordinatesFor: () => [],
}))
vi.mock('../pim/mapping/field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: [], schema: { present: true } }), clearFieldCatalogueCache: () => {} }))

const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const A = 'ws_a_ae3_copy'
const B = 'ws_b_ae3_copy'
const C = 'ws_c_ae3_copy'

describe('AE.3a — reading what a share offers, links, and Review 1', () => {
  let assortments: typeof import('./assortment.service.js')
  let shares: typeof import('./assortment-share.service.js')
  let source: typeof import('./copy-source.service.js')
  let preview: typeof import('./copy-preview.service.js')

  const user = { ownerA: '', ownerB: '', viewerB: '', ownerC: '' }
  const product: Record<string, string> = {}
  let shareId = ''
  let assortmentId = ''

  const as = <T>(workspaceId: string, actorUserId: string | null, work: () => Promise<T>) =>
    withWorkspace({ workspaceId, actorUserId, membershipId: null, roleKeys: [] }, work)
  const sql = async (text: string, params: unknown[] = []) => (await database.db.query(text, params)).rows as Array<Record<string, unknown>>
  const refusal = async (work: Promise<unknown>) => {
    try { await work } catch (error) { return (error as { code?: string }).code ?? String((error as Error).message) }
    throw new Error('expected a refusal, but the call succeeded')
  }
  const dbError = async (work: Promise<unknown>) => {
    try { await work } catch (error) { return String((error as Error).message) }
    return 'NO ERROR'
  }

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    assortments = await import('./assortment.service.js')
    shares = await import('./assortment-share.service.js')
    source = await import('./copy-source.service.js')
    preview = await import('./copy-preview.service.js')

    const ownerRole = randomUUID(), viewerRole = randomUUID()
    await sql(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,CURRENT_TIMESTAMP)`, [ownerRole])
    await sql(`INSERT INTO "Role" (id, key, name, "isSystem", permissions, "updatedAt") VALUES ($1,'VIEWER','Viewer',true,ARRAY['products.view'],CURRENT_TIMESTAMP)`, [viewerRole])
    for (const key of Object.keys(user) as Array<keyof typeof user>) {
      user[key] = randomUUID()
      await sql(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',CURRENT_TIMESTAMP)`, [user[key], `${key}-${user[key]}@example.test`])
    }
    for (const [id, name] of [[A, 'Business A'], [B, 'Business B'], [C, 'Business C']]) {
      await sql(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$2,'active','ae3',$1,CURRENT_TIMESTAMP)`, [id, name])
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

    // ── Business A: definitions ──
    const groupA = randomUUID(), attrArmor = randomUUID(), attrShell = randomUUID(), familyA = randomUUID()
    await sql(`INSERT INTO "AttributeGroup" (id, "workspaceId", code, label, "updatedAt") VALUES ($1,$2,'safety','Safety',CURRENT_TIMESTAMP)`, [groupA, A])
    await sql(`INSERT INTO "CustomAttribute" (id, "workspaceId", code, label, "groupId", type, "updatedAt") VALUES ($1,$2,'armor_level','Armour level',$3,'select',CURRENT_TIMESTAMP)`, [attrArmor, A, groupA])
    await sql(`INSERT INTO "CustomAttribute" (id, "workspaceId", code, label, "groupId", type, "updatedAt") VALUES ($1,$2,'shell_material','Shell material',$3,'text',CURRENT_TIMESTAMP)`, [attrShell, A, groupA])
    for (const code of ['l1', 'l2']) await sql(`INSERT INTO "AttributeOption" (id, "workspaceId", "attributeId", code, label, "updatedAt") VALUES ($1,$2,$3,$4,$4,CURRENT_TIMESTAMP)`, [randomUUID(), A, attrArmor, code])
    await sql(`INSERT INTO "ProductFamily" (id, "workspaceId", code, label, "updatedAt") VALUES ($1,$2,'jackets','Jackets',CURRENT_TIMESTAMP)`, [familyA, A])
    for (const attr of [attrArmor, attrShell]) await sql(`INSERT INTO "FamilyAttribute" (id, "workspaceId", "familyId", "attributeId", "updatedAt") VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)`, [randomUUID(), A, familyA, attr])
    const apparel = randomUUID(), jackets = randomUUID()
    await sql(`INSERT INTO "Category" (id, "workspaceId", slug, "updatedAt") VALUES ($1,$2,'apparel',CURRENT_TIMESTAMP)`, [apparel, A])
    await sql(`INSERT INTO "Category" (id, "workspaceId", "parentId", slug, depth, "updatedAt") VALUES ($1,$2,$3,'jackets',1,CURRENT_TIMESTAMP)`, [jackets, A, apparel])

    // ── Business A: products ──
    const seed = async (workspaceId: string, sku: string, extra: { parentId?: string; familyId?: string; deleted?: boolean; attrs?: unknown } = {}) => {
      const id = randomUUID()
      await sql(
        `INSERT INTO "Product" (id, "workspaceId", sku, name, description, gtin, "weightValue", "basePrice", status, "productType", "parentId", "familyId", "categoryAttributes", "deletedAt", "fulfillmentMethod", "updatedAt")
         VALUES ($1,$2,$3,$4,'Source description','8000000000001',1.5,99,'ACTIVE','COAT',$5,$6,$7,$8,'FBM',CURRENT_TIMESTAMP)`,
        [id, workspaceId, sku, `${sku} name`, extra.parentId ?? null, extra.familyId ?? null, JSON.stringify(extra.attrs ?? {}), extra.deleted ? new Date() : null],
      )
      return id
    }
    product.parent = await seed(A, 'JKT', { familyId: familyA, attrs: { armor_level: 'l2' } })
    await sql(`UPDATE "Product" SET "isParent" = true WHERE id = $1`, [product.parent])
    product.small = await seed(A, 'JKT-S', { parentId: product.parent, familyId: familyA })
    product.medium = await seed(A, 'JKT-M', { parentId: product.parent, familyId: familyA })
    product.deletedVariation = await seed(A, 'JKT-XL', { parentId: product.parent, familyId: familyA, deleted: true })
    product.helmet = await seed(A, 'HELMET')
    product.deleted = await seed(A, 'OLD-JKT', { deleted: true })
    await sql(`INSERT INTO "ProductCategory" ("workspaceId", "productId", "categoryId", "isPrimary") VALUES ($1,$2,$3,true)`, [A, product.parent, jackets])
    await sql(`INSERT INTO "ProductTranslation" (id, "workspaceId", "productId", language, name, "updatedAt") VALUES ($1,$2,$3,'de','Jacke',CURRENT_TIMESTAMP)`, [randomUUID(), A, product.parent])

    // ── Business B: overlaps ──
    product.bMedium = await seed(B, 'JKT-M')
    product.bOther = await seed(B, 'B-OTHER')
    product.bDeletedSmall = await seed(B, 'JKT-S', { deleted: true })
    const groupB = randomUUID()
    await sql(`INSERT INTO "AttributeGroup" (id, "workspaceId", code, label, "updatedAt") VALUES ($1,$2,'b-group','B group',CURRENT_TIMESTAMP)`, [groupB, B])
    await sql(`INSERT INTO "CustomAttribute" (id, "workspaceId", code, label, "groupId", type, "updatedAt") VALUES ($1,$2,'shell_material','Shell',$3,'select',CURRENT_TIMESTAMP)`, [randomUUID(), B, groupB])
    await sql(`INSERT INTO "Category" (id, "workspaceId", slug, "updatedAt") VALUES ($1,$2,'apparel',CURRENT_TIMESTAMP)`, [randomUUID(), B])
    product.cProduct = await seed(C, 'C-ONLY')

    // ── The share: A offers [JKT (+ variations), OLD-JKT (deleted)] to B, default groups ──
    const created = await as(A, user.ownerA, () => assortments.createAssortment({ name: 'Jackets for B' }))
    assortmentId = created.id
    await as(A, user.ownerA, () => assortments.addMembers(assortmentId, { productIds: [product.parent], expectedVersion: 1 }))
    // A member that was valid when added and is deleted since.
    await sql(`INSERT INTO "AssortmentMember" (id, "workspaceId", "assortmentId", "productId", mode) VALUES ($1,$2,$3,$4,'include')`, [randomUUID(), A, assortmentId, product.deleted])
    const offer = await as(A, user.ownerA, () => shares.offerShare({ assortmentId, destinationWorkspaceId: B }))
    shareId = offer.id
    await as(B, user.ownerB, () => shares.followerDecision(shareId, 'accept', { expectedVersion: 1 }))
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 30_000)

  // ── Who may read what ──────────────────────────────────────────────────────
  describe('the database decides what the follower may read', () => {
    it('CONTROL — an owner of B gets exactly the parent and its variations: not the product outside the assortment, not a deleted member, not a deleted variation', async () => {
      const auth = await as(B, user.ownerB, () => source.authorisedSource(shareId))
      expect(auth.ownerWorkspaceId).toBe(A)
      expect(auth.products.map((p) => p.sku)).toEqual(['JKT', 'JKT-M', 'JKT-S'])
      // Positive controls: all three excluded products exist in A, and the deleted variation is JKT's child.
      expect((await sql(`SELECT count(*)::int AS n FROM "Product" WHERE id IN ($1,$2,$3)`, [product.helmet, product.deleted, product.deletedVariation]))[0].n).toBe(3)
      expect((await sql(`SELECT "parentId" FROM "Product" WHERE id = $1`, [product.deletedVariation]))[0].parentId).toBe(product.parent)
    })

    it('refused for a member who is not an owner, for no person, for the owner business itself, and for a third business', async () => {
      expect(await refusal(as(B, user.viewerB, () => source.authorisedSource(shareId)))).toBe('workspace_owner_required')
      expect(await refusal(as(B, null, () => source.authorisedSource(shareId)))).toBe('session_required')
      expect(await refusal(as(A, user.ownerA, () => source.authorisedSource(shareId)))).toBe('share_not_found')
      expect(await refusal(as(C, user.ownerC, () => source.authorisedSource(shareId)))).toBe('share_not_found')
    })

    it('refused while the share is paused, and allowed again once resumed', async () => {
      const version = (await sql(`SELECT version FROM "AssortmentShare" WHERE id = $1`, [shareId]))[0].version as number
      await as(A, user.ownerA, () => shares.ownerAction(shareId, 'pause', { expectedVersion: version }))
      expect(await refusal(as(B, user.ownerB, () => source.authorisedSource(shareId)))).toBe('share_not_active')
      await as(A, user.ownerA, () => shares.ownerAction(shareId, 'resume', { expectedVersion: version + 1 }))
      expect((await as(B, user.ownerB, () => source.authorisedSource(shareId))).products).toHaveLength(3)
    })

    it('refused while the owner business is archived, and allowed again once it is active', async () => {
      await sql(`UPDATE "Workspace" SET status = 'archived' WHERE id = $1`, [A])
      try {
        expect(await refusal(as(B, user.ownerB, () => source.authorisedSource(shareId)))).toBe('owner_unavailable')
      } finally {
        await sql(`UPDATE "Workspace" SET status = 'active' WHERE id = $1`, [A])
      }
      expect((await as(B, user.ownerB, () => source.authorisedSource(shareId))).products).toHaveLength(3)
    })

    it('the membership resolver itself is not callable by the runtime role', async () => {
      expect(await dbError(as(B, user.ownerB, () => database.client.$queryRaw`SELECT * FROM nexus_assortment_share_product_ids(${shareId})`))).toMatch(/permission denied/)
    })

    it('an "all" assortment covers every top-level product except the excluded ones, with their variations', async () => {
      const all = await as(A, user.ownerA, () => assortments.createAssortment({ name: 'All but jackets', selection: 'all' }))
      await as(A, user.ownerA, () => assortments.addMembers(all.id, { productIds: [product.parent], expectedVersion: 1 }))
      const offer = await as(A, user.ownerA, () => shares.offerShare({ assortmentId: all.id, destinationWorkspaceId: B }))
      await as(B, user.ownerB, () => shares.followerDecision(offer.id, 'accept', { expectedVersion: 1 }))
      expect((await as(B, user.ownerB, () => source.authorisedSource(offer.id))).products.map((p) => p.sku)).toEqual(['HELMET'])
    })
  })

  // ── The source read ─────────────────────────────────────────────────────────
  describe('readOfferedCatalog', () => {
    it('keeps only the offered groups, never the stock, never a source version, and returns to the follower context', async () => {
      const catalog = await as(B, user.ownerB, () => source.readOfferedCatalog({ shareId, market: 'IT' }))
      const fields = new Set(catalog.rows.map((r) => r.field))
      for (const expected of ['name', 'description', 'gtin', 'weightValue', 'armor_level', 'family', 'parentSku', 'categoryIds']) expect(fields, expected).toContain(expected)
      expect(fields.has('totalStock')).toBe(false)
      expect(catalog.rows.every((r) => r.version === undefined)).toBe(true)
      expect(catalog.rows.some((r) => r.sku === 'HELMET')).toBe(false)
      // Stock and price never reach a row at all (the engine's MANAGED_FIELDS); a non-managed field that
      // must not travel is reported with its reason.
      expect(catalog.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'fulfillmentMethod', reason: expect.stringMatching(/fulfilment/) })]))
      // Translations were offered by default: the German name travels as its own row.
      expect(catalog.rows).toEqual(expect.arrayContaining([expect.objectContaining({ sku: 'JKT', field: 'name', locale: 'de', value: 'Jacke' })]))
      // Price and status were NOT offered: not in the managed fields. Product type (attributes) was.
      expect(catalog.products.find((p) => p.sku === 'JKT')?.managed).toEqual({ productType: 'COAT' })
    })

    it('carries the family, attribute and category definitions by natural key', async () => {
      const catalog = await as(B, user.ownerB, () => source.readOfferedCatalog({ shareId, market: 'IT' }))
      expect(catalog.families).toEqual([expect.objectContaining({ code: 'jackets', attributes: expect.arrayContaining([expect.objectContaining({ code: 'armor_level' })]) })])
      expect(catalog.attributes.find((a) => a.code === 'armor_level')?.options.map((o) => o.code)).toEqual(['l1', 'l2'])
      expect(catalog.categories.map((c) => c.path)).toEqual([['apparel'], ['apparel', 'jackets']])
      expect(catalog.products.find((p) => p.sku === 'JKT')?.categoryPaths).toEqual([['apparel', 'jackets']])
      expect(catalog.products.find((p) => p.sku === 'JKT-S')?.parentSku).toBe('JKT')
    })

    it('price and status arrive only when offered', async () => {
      const priced = await as(A, user.ownerA, () => assortments.createAssortment({ name: 'Priced helmets' }))
      await as(A, user.ownerA, () => assortments.addMembers(priced.id, { productIds: [product.helmet], expectedVersion: 1 }))
      const offer = await as(A, user.ownerA, () => shares.offerShare({ assortmentId: priced.id, destinationWorkspaceId: B, fieldGroups: ['identity', 'price', 'status'] }))
      await as(B, user.ownerB, () => shares.followerDecision(offer.id, 'accept', { expectedVersion: 1 }))
      const catalog = await as(B, user.ownerB, () => source.readOfferedCatalog({ shareId: offer.id, market: 'IT' }))
      expect(catalog.products[0].managed).toEqual({ basePrice: '99', minPrice: null, maxPrice: null, b2bPrice: null, b2bMinQty: null, status: 'ACTIVE' })
      expect(catalog.rows.some((r) => r.field === 'name')).toBe(false)
      expect(catalog.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'name', reason: 'the "content" group was not offered' })]))
    })
  })

  // ── Review 1 ────────────────────────────────────────────────────────────────
  describe('Review 1', () => {
    it('sorts every product: new, same SKU (match), blocked — and lists what will be created and what conflicts', async () => {
      const { preview: review } = await as(B, user.ownerB, () => preview.previewCopy({ shareId, market: 'IT' }))
      expect(review.products.map((p) => [p.sku, p.kind])).toEqual([['JKT', 'new'], ['JKT-M', 'match'], ['JKT-S', 'blocked']])
      expect(review.counts).toMatchObject({ new: 1, match: 1, linked: 0, blocked: 1 })
      expect(review.create.families).toEqual([{ code: 'jackets', label: 'Jackets' }])
      expect(review.create.attributeGroups).toEqual([{ code: 'safety', label: 'Safety' }])
      expect(review.create.attributes).toEqual([{ code: 'armor_level', label: 'Armour level', type: 'select' }])
      expect(review.create.options.map((o) => o.code)).toEqual(['l1', 'l2'])
      expect(review.create.categories).toEqual([{ path: ['apparel', 'jackets'] }])
      expect(review.conflicts).toEqual([{ kind: 'attribute_type', code: 'shell_material', source: 'text', follower: 'select' }])
    })

    it('the fingerprint is stable, and moves when a source product changes', async () => {
      const first = (await as(B, user.ownerB, () => preview.previewCopy({ shareId, market: 'IT' }))).preview.fingerprint
      const second = (await as(B, user.ownerB, () => preview.previewCopy({ shareId, market: 'IT' }))).preview.fingerprint
      expect(second).toBe(first)
      await sql(`UPDATE "Product" SET description = 'Edited at the source', version = version + 1 WHERE id = $1`, [product.parent])
      const third = (await as(B, user.ownerB, () => preview.previewCopy({ shareId, market: 'IT' }))).preview.fingerprint
      expect(third).not.toBe(first)
    })
  })

  // ── Catalog links ───────────────────────────────────────────────────────────
  describe('catalog link rules (no service in the path)', () => {
    const insertLink = (workspaceId: string, actor: string, sourceProductId: string, targetProductId: string, linkShare = shareId) =>
      as(workspaceId, actor, () => database.client.$executeRaw`
        INSERT INTO "CatalogLink" (id, "shareId", "sourceWorkspaceId", "sourceProductId", "targetWorkspaceId", "targetProductId", "linkedBy", "sourceVersion", "updatedAt")
        VALUES (${randomUUID()}, ${linkShare}, ${A}, ${sourceProductId}, ${B}, ${targetProductId}, 'matched', 1, CURRENT_TIMESTAMP)`)
    let linkId = ''

    it('CONTROL — B links its JKT-M to the shared JKT-M; A can read the link; C cannot', async () => {
      expect(await insertLink(B, user.ownerB, product.medium, product.bMedium)).toBe(1)
      linkId = (await sql(`SELECT id FROM "CatalogLink" WHERE "targetProductId" = $1`, [product.bMedium]))[0].id as string
      expect((await as(A, user.ownerA, () => database.client.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "CatalogLink" WHERE id = ${linkId}`))[0].n).toBe(1)
      expect((await as(C, user.ownerC, () => database.client.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "CatalogLink" WHERE id = ${linkId}`))[0].n).toBe(0)
    })

    it('refuses a source product outside the assortment, a target outside the follower, a second active link from either end, and a link written by the owner', async () => {
      expect(await dbError(insertLink(B, user.ownerB, product.helmet, product.bMedium))).toMatch(/not part of the shared assortment/)
      expect(await dbError(insertLink(B, user.ownerB, product.small, product.cProduct))).toMatch(/not a product of the follower business/)
      // One active link per follower product, and one per shared product: each refused by its own index.
      expect(await dbError(insertLink(B, user.ownerB, product.small, product.bMedium))).toMatch(/CatalogLink_one_active_per_target/)
      expect(await dbError(insertLink(B, user.ownerB, product.medium, product.bOther))).toMatch(/CatalogLink_one_active_per_source/)
      expect(await dbError(insertLink(A, user.ownerA, product.small, product.bMedium))).toMatch(/row-level security|Only the business that follows/)
    })

    it('a link cannot be repointed or deleted; it can be detached, and a detached link stays detached', async () => {
      expect(await dbError(as(B, user.ownerB, () => database.client.$executeRaw`UPDATE "CatalogLink" SET "targetProductId" = ${product.cProduct} WHERE id = ${linkId}`))).toMatch(/cannot change/)
      expect(await dbError(as(B, user.ownerB, () => database.client.$executeRaw`DELETE FROM "CatalogLink" WHERE id = ${linkId}`))).toMatch(/never deleted/)
      expect(await as(B, user.ownerB, () => database.client.$executeRaw`UPDATE "CatalogLink" SET status = 'detached', "detachedAt" = CURRENT_TIMESTAMP WHERE id = ${linkId}`)).toBe(1)
      expect(await dbError(as(B, user.ownerB, () => database.client.$executeRaw`UPDATE "CatalogLink" SET status = 'active', "detachedAt" = NULL WHERE id = ${linkId}`))).toMatch(/stays detached/)
    })

    it('🔴 revoking the share detaches its active links in the same transaction — even when the OWNER revokes', async () => {
      expect(await insertLink(B, user.ownerB, product.medium, product.bMedium)).toBe(1)
      const active = (await sql(`SELECT id FROM "CatalogLink" WHERE "shareId" = $1 AND status = 'active'`, [shareId]))
      expect(active).toHaveLength(1)
      const version = (await sql(`SELECT version FROM "AssortmentShare" WHERE id = $1`, [shareId]))[0].version as number
      await as(A, user.ownerA, () => shares.ownerAction(shareId, 'revoke', { expectedVersion: version }))
      const after = (await sql(`SELECT status, "detachedReason" FROM "CatalogLink" WHERE id = $1`, [active[0].id]))[0]
      expect(after).toEqual({ status: 'detached', detachedReason: 'share revoked by the owner' })
      // And the ended share authorises nothing any more.
      expect(await refusal(as(B, user.ownerB, () => source.authorisedSource(shareId)))).toBe('share_not_active')
    })
  })
})
