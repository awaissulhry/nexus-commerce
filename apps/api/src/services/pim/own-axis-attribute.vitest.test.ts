/**
 * Sheet pop-up P3, slice A3 (QUALITY-PLAN-2026-09-28 §4.10) — "New attribute" from the variation pop-up.
 *
 * `createOwnAxisAttribute` makes (or reuses) the Shared per-variant attribute an own-name axis takes its values from and
 * places it in the product's family, in one transaction; its answer is the new "Values from" entry. Then every refusal,
 * a placement that fails (no loose attribute), the button's state, and the two routes with and without `pim.manage`.
 *
 * On an in-process PostgreSQL (PGlite) with the generated schema and the production row policies. Every id is invented.
 * The race of two creates of the same name runs on a real server: `own-axis-attribute-postgres.vitest.test.ts`.
 * Run: DATABASE_URL=postgresql://nexus@127.0.0.1:1/nexus_unit_test npx vitest run src/services/pim/own-axis-attribute.vitest.test.ts
 * and again with NEXUS_WORKSPACES_ENABLED=1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))

import Fastify, { type FastifyRequest } from 'fastify'
import studioRoutes from '../../routes/product-studio.routes.js'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { sharedOwnAxisSources } from './family-projection.service.js'
import {
  attributeCodeFor, chooseAttributeGroup, createOwnAxisAttribute, OWN_AXIS_ATTRIBUTE_COPY as COPY, OwnAxisAttributeError, ownAxisAttributeState,
} from './own-axis-attribute.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const create = (name: string, extra: { productId?: string; useExisting?: boolean } = {}) =>
  scoped(() => createOwnAxisAttribute({ productId: extra.productId ?? 'oa-demo', market: 'it', name, useExisting: extra.useExisting }))
const counts = () => scoped(async () => ({ attributes: await prisma.customAttribute.count(), placements: await prisma.familyAttribute.count() }))
const refusal = async (name: string, productId?: string) => {
  const error = await create(name, { productId }).then(() => null, (e: unknown) => e)
  expect(error, `"${name}" was not refused`).toBeInstanceOf(OwnAxisAttributeError)
  return error as OwnAxisAttributeError
}

const VARIANTS = [
  { id: 'oa-a', colore: 'Nero', fit: 'Slim' },
  { id: 'oa-b', colore: 'Rosso', fit: '' },
  { id: 'oa-c', colore: 'Blu', fit: 'Regular' },
]

beforeAll(() => scoped(async () => {
  await prisma.attributeGroup.create({ data: { id: 'oa-group', code: 'oa_fixture', label: 'Specifications', sortOrder: 5 } as never })
  await prisma.attributeGroup.create({ data: { id: 'oa-named', code: 'attributes', label: 'Attributes', sortOrder: 1 } as never })
  await prisma.productFamily.create({ data: { id: 'oa-parent-family', code: 'oa_clothing', label: 'Made-up clothing' } })
  await prisma.productFamily.create({ data: { id: 'oa-family', code: 'oa_jackets', label: 'Made-up jackets', parentFamilyId: 'oa-parent-family' } as never })
  const attribute = (id: string, code: string, label: string, data: Record<string, unknown> = {}) =>
    prisma.customAttribute.create({ data: { id, code, label, type: 'text', groupId: 'oa-group', scope: 'per_variant', ...data } as never })
  await attribute('oa-color', 'color', 'Color', { type: 'select' })
  await attribute('oa-fit', 'fit', 'Fit')
  await attribute('oa-inherited', 'inherited_note', 'Inherited note', { groupId: 'oa-named' })
  await attribute('oa-lining', 'lining', 'Lining', { groupId: 'oa-named' })
  await attribute('oa-material', 'material', 'Material', { scope: 'global' })
  await attribute('oa-old-fit', 'old_fit', 'Old fit', { archivedAt: new Date('2026-01-01') })
  await attribute('oa-sizes', 'sizes_list', 'Sizes list', { type: 'multiselect' })
  await prisma.familyAttribute.create({ data: { attributeId: 'oa-color', familyId: 'oa-family', channels: [], sortOrder: 1 } })
  await prisma.familyAttribute.create({ data: { attributeId: 'oa-fit', familyId: 'oa-family', channels: [], sortOrder: 4 } })
  await prisma.familyAttribute.create({ data: { attributeId: 'oa-inherited', familyId: 'oa-parent-family', channels: [] } })
  await prisma.product.create({ data: { id: 'oa-demo', sku: 'OA-JACKET', name: 'Own attribute jacket', isParent: true, basePrice: 50, familyId: 'oa-family', variationAxes: ['Colore'] } as never })
  for (const v of VARIANTS) {
    await prisma.product.create({ data: { id: v.id, sku: `OA-JACKET-${v.id.slice(-1).toUpperCase()}`, name: v.id, parentId: 'oa-demo', basePrice: 50, familyId: 'oa-family',
      categoryAttributes: { variations: { Colore: v.colore }, ...(v.fit ? { fit: v.fit } : {}) } } as never })
  }
  await prisma.product.create({ data: { id: 'oa-second', sku: 'OA-COAT', name: 'Second jacket', basePrice: 40, familyId: 'oa-family' } as never })
  await prisma.product.create({ data: { id: 'oa-nofam', sku: 'OA-LOOSE', name: 'No family', isParent: true, basePrice: 30, variationAxes: ['Colore'] } as never })
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'EBAY IT', region: 'EU', currency: 'EUR', language: 'it' } as never })
}), 60_000)

afterAll(async () => { await state.db?.close?.() })

describe('the code a typed name becomes', () => {
  it('folds accents, joins the rest with "_", prefixes a leading digit, cuts at 64 — and every code passes the dictionary rule', () => {
    expect(attributeCodeFor('Vestibilità')).toBe('vestibilita')
    expect(attributeCodeFor('  Fit / Taglio  ')).toBe('fit_taglio')
    expect(attributeCodeFor('3D print')).toBe('v_3d_print')
    expect(attributeCodeFor('Größe (EU)')).toBe('gro_e_eu')
    expect(attributeCodeFor('x'.repeat(70))).toBe('x'.repeat(64))
    expect(attributeCodeFor(`${'a'.repeat(63)} b`)).toBe('a'.repeat(63))
    for (const name of ['日本', '---', '   ', '']) expect(attributeCodeFor(name)).toBe('')
    for (const name of ['Vestibilità', '3D print', 'x'.repeat(70), `${'a'.repeat(63)} b`]) expect(attributeCodeFor(name)).toMatch(/^[a-z][a-z0-9_]{0,63}$/)
  })

  it('joins the group most of the family\'s per-variant attributes use, else "attributes", else the first; none = null', () => {
    expect(chooseAttributeGroup(['g2', 'g1', 'g2'], 'named', 'first')).toBe('g2')
    expect(chooseAttributeGroup(['g2', 'g1'], 'named', 'first')).toBe('g1') // a tie never depends on read order
    expect(chooseAttributeGroup([], 'named', 'first')).toBe('named')
    expect(chooseAttributeGroup([], null, 'first')).toBe('first')
    expect(chooseAttributeGroup([], null, null)).toBeNull()
  })
})

describe('the "New attribute" button\'s state', () => {
  it('allowed with the family and its size; held with the permission sentence; held with the family sentence first', async () => {
    expect(await scoped(() => ownAxisAttributeState('oa-a', true))).toEqual({ allowed: true, reason: null, familyLabel: 'Made-up jackets', familyProducts: 2 })
    expect(await scoped(() => ownAxisAttributeState('oa-demo', false))).toEqual({ allowed: false, reason: COPY.noPermission, familyLabel: 'Made-up jackets', familyProducts: 2 })
    expect(await scoped(() => ownAxisAttributeState('oa-nofam', true))).toEqual({ allowed: false, reason: COPY.noFamily, familyLabel: null, familyProducts: null })
  })
})

describe('createOwnAxisAttribute', () => {
  it('refuses before writing: empty, no letter, a family axis, the whole-product / archived / list attributes, a product field, no family', async () => {
    const before = await counts()
    expect((await refusal('   ')).message).toBe(COPY.empty)
    expect((await refusal('日本')).message).toBe(COPY.noCode)
    expect((await refusal('Colore')).message).toBe(COPY.familyAxis('Colore'))
    // another spelling of the same axis is the same axis
    expect((await refusal('Colour')).message).toBe(COPY.familyAxis('Colour'))
    expect((await refusal('Material')).message).toBe(COPY.notPerVariant('Material'))
    expect((await refusal('Old fit')).message).toBe(COPY.archived('Old fit'))
    expect((await refusal('Sizes list')).message).toBe(COPY.notPlain('Sizes list'))
    // Brand is the product's own field (no dictionary row): it holds one value for the whole product
    expect((await refusal('Brand')).message).toMatch(/already exists as an attribute for the whole product/)
    expect((await refusal('Vestibilità', 'oa-nofam')).message).toBe(COPY.noFamily)
    for (const error of [await refusal('Material'), await refusal('   ')]) expect(error).toMatchObject({ statusCode: 400, code: 'own_axis_attribute_refused' })
    expect(await counts()).toEqual(before)
  })

  it('creates a per-variant text attribute, places it last in the product\'s own family, and answers its "Values from" entry', async () => {
    const before = await counts()
    const result = await create('Vestibilità')
    expect(result.outcome).toBe('created')
    expect(result.attribute).toMatchObject({ code: 'vestibilita', label: 'Vestibilità' })
    expect(result.source).toEqual({ field: 'vestibilita', label: 'Vestibilità', filled: 0, of: 3, values: [] })
    expect(await counts()).toEqual({ attributes: before.attributes + 1, placements: before.placements + 1 })
    const row = await scoped(() => prisma.customAttribute.findUniqueOrThrow({ where: { id: result.attribute.id! } }))
    // the group most of the family's per-variant attributes use (Color and Fit: oa-group), not "attributes"
    expect(row).toMatchObject({ type: 'text', scope: 'per_variant', placement: 'shared', groupId: 'oa-group', archivedAt: null })
    const placed = await scoped(() => prisma.familyAttribute.findMany({ where: { attributeId: result.attribute.id! } }))
    expect(placed).toEqual([expect.objectContaining({ familyId: 'oa-family', required: false, channels: [], sortOrder: 5 })])
    // what the save's own check reads: the attribute is a value source now (the caches were cleared)
    expect((await scoped(() => sharedOwnAxisSources('oa-demo', 'IT'))).map(s => s.field)).toContain('vestibilita')
  })

  it('the same name again is already there: "present", nothing written — also for an attribute the parent family carries', async () => {
    const before = await counts()
    const again = await create('vestibilita')
    expect(again).toMatchObject({ outcome: 'present', attribute: { code: 'vestibilita', label: 'Vestibilità' } })
    const fit = await create('Fit')
    expect(fit).toMatchObject({ outcome: 'present', attribute: { id: 'oa-fit' }, source: { field: 'fit', filled: 2, of: 3, values: ['Slim', 'Regular'] } })
    const inherited = await create('Inherited note')
    expect(inherited).toMatchObject({ outcome: 'present', attribute: { id: 'oa-inherited' }, source: { field: 'inherited_note', filled: 0, of: 3 } })
    expect(await counts()).toEqual(before)
  })

  it('an attribute that exists outside the family is offered first (409), and placed — not copied — when the operator says so', async () => {
    const before = await counts()
    const offer = await refusal('Lining')
    expect(offer).toMatchObject({ statusCode: 409, code: 'own_axis_attribute_exists', message: COPY.exists('Lining'), detail: { offer: { code: 'lining', label: 'Lining' } } })
    expect(await counts()).toEqual(before)
    const placed = await create('Lining', { useExisting: true })
    expect(placed).toMatchObject({ outcome: 'placed', attribute: { id: 'oa-lining', code: 'lining' }, source: { field: 'lining', filled: 0, of: 3 } })
    expect(await counts()).toEqual({ attributes: before.attributes, placements: before.placements + 1 })
    expect(await create('Lining', { useExisting: true })).toMatchObject({ outcome: 'present' })
  })

  it('🔴 a placement that fails leaves NO attribute behind (one transaction)', async () => {
    // Forced at the database: the family link for this one code is refused, after the attribute row was inserted.
    await state.db.db.exec(`
      CREATE FUNCTION oa_refuse_placement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "CustomAttribute" WHERE id = NEW."attributeId" AND code = 'will_not_place') THEN RAISE EXCEPTION 'forced placement failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER oa_refuse_placement BEFORE INSERT ON "FamilyAttribute" FOR EACH ROW EXECUTE FUNCTION oa_refuse_placement();`)
    try {
      const before = await counts()
      await expect(create('Will not place')).rejects.toThrow(/forced placement failure/)
      expect(await counts()).toEqual(before)
      expect(await scoped(() => prisma.customAttribute.count({ where: { code: 'will_not_place' } }))).toBe(0)
    } finally {
      await state.db.db.exec('DROP TRIGGER oa_refuse_placement ON "FamilyAttribute"; DROP FUNCTION oa_refuse_placement();')
    }
  })

  it('a business with no attribute group yet is told to add one, and nothing is written', async () => {
    // A family with no per-variant attribute to take a group from, and every group hidden from the application's role.
    await scoped(async () => {
      await prisma.productFamily.create({ data: { id: 'oa-bare', code: 'oa_bare', label: 'Made-up bare family' } })
      await prisma.product.create({ data: { id: 'oa-bare-demo', sku: 'OA-BARE', name: 'Bare family product', isParent: true, basePrice: 20, familyId: 'oa-bare', variationAxes: ['Colore'] } as never })
    })
    await state.db.db.exec('CREATE POLICY oa_hide_groups ON "AttributeGroup" AS RESTRICTIVE FOR SELECT USING (false)')
    try {
      const before = await counts()
      expect((await refusal('Stile nuovo', 'oa-bare-demo')).message).toBe(COPY.noGroup)
      expect(await counts()).toEqual(before)
    } finally {
      await state.db.db.exec('DROP POLICY oa_hide_groups ON "AttributeGroup"')
    }
  })
})

describe('the routes, with and without pim.manage', () => {
  const app = Fastify()
  beforeAll(async () => {
    // As production's hooks do: the business profile, then the signed-in user and the grants its role resolves to.
    app.addHook('onRequest', (_request, _reply, done) => { withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done) })
    app.addHook('onRequest', async (request: FastifyRequest) => {
      const grants = String(request.headers['x-test-grants'] ?? '').split(',').filter(Boolean)
      Object.assign(request, { __sessionLoaded: true, authUser: { id: 'oa-user', roleKeys: [], permissionsVersion: 1 }, __rbacResolved: { isOwner: false, permissions: new Set(grants) } })
    })
    await app.register(studioRoutes, { prefix: '/api' })
    await app.ready()
  })
  afterAll(async () => { await app.close() })
  const manager = { 'x-test-grants': 'products.view,products.edit,pim.manage' }
  const editor = { 'x-test-grants': 'products.view,products.edit' }

  it('GET own-axis-sources carries the button\'s state beside the unchanged sources', async () => {
    const managed = await app.inject({ method: 'GET', url: '/api/products/oa-demo/studio/own-axis-sources?market=it', headers: manager })
    expect(managed.statusCode, managed.body).toBe(200)
    expect(managed.json().newAttribute).toEqual({ allowed: true, reason: null, familyLabel: 'Made-up jackets', familyProducts: 2 })
    expect(managed.json().sources.map((s: { field: string }) => s.field)).toEqual(expect.arrayContaining(['fit', 'vestibilita', 'lining', 'inherited_note']))
    const edited = await app.inject({ method: 'GET', url: '/api/products/oa-demo/studio/own-axis-sources?market=it', headers: editor })
    expect(edited.json().newAttribute).toEqual({ allowed: false, reason: COPY.noPermission, familyLabel: 'Made-up jackets', familyProducts: 2 })
  })

  it('POST: 403 with the sentence for a sheet editor, 201 / 200 / 409 / 400 for a manager — and nothing written on a refusal', async () => {
    const before = await counts()
    const denied = await app.inject({ method: 'POST', url: '/api/products/oa-demo/studio/own-axis-attribute?market=it', headers: editor, payload: { name: 'Stile' } })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toEqual({ error: 'forbidden', message: COPY.noPermission })
    expect(await counts()).toEqual(before)

    const created = await app.inject({ method: 'POST', url: '/api/products/oa-demo/studio/own-axis-attribute?market=it', headers: manager, payload: { name: 'Stile' } })
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json()).toMatchObject({ outcome: 'created', attribute: { code: 'stile', label: 'Stile' }, source: { field: 'stile', label: 'Stile', filled: 0, of: 3, values: [] } })
    const present = await app.inject({ method: 'POST', url: '/api/products/oa-demo/studio/own-axis-attribute?market=it', headers: manager, payload: { name: 'Stile' } })
    expect(present.statusCode).toBe(200)
    expect(present.json().outcome).toBe('present')

    await scoped(() => prisma.customAttribute.create({ data: { id: 'oa-hood', code: 'hood', label: 'Hood', type: 'text', groupId: 'oa-group', scope: 'per_variant' } as never }))
    const offer = await app.inject({ method: 'POST', url: '/api/products/oa-demo/studio/own-axis-attribute?market=it', headers: manager, payload: { name: 'Hood' } })
    expect(offer.statusCode).toBe(409)
    expect(offer.json()).toEqual({ error: 'own_axis_attribute_exists', message: COPY.exists('Hood'), offer: { code: 'hood', label: 'Hood' } })
    const placed = await app.inject({ method: 'POST', url: '/api/products/oa-demo/studio/own-axis-attribute?market=it', headers: manager, payload: { name: 'Hood', useExisting: true } })
    expect(placed.statusCode).toBe(200)
    expect(placed.json()).toMatchObject({ outcome: 'placed', attribute: { id: 'oa-hood' } })

    const refused = await app.inject({ method: 'POST', url: '/api/products/oa-demo/studio/own-axis-attribute?market=it', headers: manager, payload: { name: 'Material' } })
    expect(refused.statusCode).toBe(400)
    expect(refused.json()).toEqual({ error: 'own_axis_attribute_refused', message: COPY.notPerVariant('Material') })
    const badFlag = await app.inject({ method: 'POST', url: '/api/products/oa-demo/studio/own-axis-attribute?market=it', headers: manager, payload: { name: 'Hood', useExisting: false } })
    expect(badFlag.statusCode).toBe(400)
    const noMarket = await app.inject({ method: 'POST', url: '/api/products/oa-demo/studio/own-axis-attribute', headers: manager, payload: { name: 'Hood' } })
    expect(noMarket.statusCode).toBe(400)
  })
})
