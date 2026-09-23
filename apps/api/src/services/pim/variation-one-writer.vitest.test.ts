/**
 * Step 2.6c-2 (A-27, R-23) — ONE writer for a variant's values, and the legacy `variantAttributes` is never
 * written again. Every writer puts the value in the store (`categoryAttributes.variations`) and REMOVES the
 * touched axis from the legacy bag.
 *
 * The removal is the point, not a tidy-up: readers let the legacy bag fill in for an axis the store lacks
 * (`variationBag`), so a writer that only stopped writing it would let a stale legacy size come back the moment
 * the store's size is cleared. The "clear" arm below is that trap.
 *
 * Two halves: each live writer through its own entry point on real PostgreSQL, and a source scan of every line
 * that could write the legacy bag.
 *
 * 🔴 This file holds EVERY real-PostgreSQL arm of Step 2.6 — 2.6a's end-to-end sheet edits, 2.6b's writers that
 * keep the store, and 2.6c-2's one writer — in ONE in-process database (`formulaDatabase`, PGlite). These arms
 * test what a write stores, not a race, so they do not need `concurrentDatabase()`: each of those applies the
 * whole schema in one server transaction, and three at once (with the machine's other sessions) overflowed the
 * local server's lock table (`53200 out of shared memory`, "increase max_locks_per_transaction"), failing files
 * that pass alone. PGlite shares no lock table.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  // Real PostgreSQL in-process (PGlite): the same SQL engine, and no server lock table to share — see the header.
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('./readiness-index.service.js', () => ({ produceReadiness: vi.fn() }))
// The eBay import's outside calls (2.6b): one account, one page of inventory items.
const ebayItems = vi.hoisted(() => ({ items: [] as unknown[] }))
vi.mock('../connection-resolver.service.js', async (importOriginal) => ({ ...(await importOriginal<object>()), tryResolveConnection: vi.fn(async () => ({ id: 'ebay-account', displayName: 'eBay' })) }))
vi.mock('../ebay-auth.service.js', async (importOriginal) => ({ ...(await importOriginal<object>()), ebayAuthService: { getValidToken: vi.fn(async () => 'token') } }))
vi.mock('../gateway/ebay.js', async (importOriginal) => ({ ...(await importOriginal<object>()), ebaySend: vi.fn(async () => new Response(JSON.stringify({ inventoryItems: ebayItems.items, total: ebayItems.items.length }))) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { variationBag } from './shared-variation-values.js'
import { attachProduct } from './product-relationship.service.js'
import { applyProductBulkEdits } from '../products/bulk-edit.service.js'
import { catalogRoutes } from '../../routes/catalog.routes.js'
import catalogOrganizeRoutes from '../../routes/catalog-organize.routes.js'
import { importEbayCatalog } from '../ebay-import.service.js'
import { enrichProductFromAmazon } from '../listing-reconciliation.service.js'
import { resolveAttributes } from './attribute-resolver.js'
import { storedVariationValues } from './stored-variation-projection.js'

const BUSINESS = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const scoped = <T>(work: () => Promise<T>) => withWorkspace(BUSINESS, work)
/** A route app that gives each request its business the way production's `workspaceHook` does. */
const routeApp = async (plugin: Parameters<ReturnType<typeof Fastify>['register']>[0]) => {
  const app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(BUSINESS, done))
  await app.register(plugin, { prefix: '/api/catalog' })
  return app
}
const read = (id: string) => scoped(() => prisma.product.findUniqueOrThrow({ where: { id } }))
const store = (p: { categoryAttributes: unknown }) => ((p.categoryAttributes ?? {}) as { variations?: Record<string, unknown> }).variations
const sizeKeysIn = (bag: unknown) => Object.keys((bag ?? {}) as object).filter((k) => /^(size|taglia)$/i.test(k))

beforeAll(() => scoped(async () => {
  for (const channel of ['AMAZON', 'EBAY']) await prisma.marketplace.create({ data: { channel, code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  const group = await prisma.attributeGroup.create({ data: { code: 'sizing', label: 'Sizing' } })
  const size = await prisma.customAttribute.create({ data: { code: 'size', label: 'Size', type: 'text', groupId: group.id, scope: 'per_variant' } })
  const family = await prisma.productFamily.create({ data: { code: 'jackets', label: 'Jackets' } })
  await prisma.familyAttribute.create({ data: { familyId: family.id, attributeId: size.id, channels: [] } })
  await prisma.product.create({ data: { id: 'parent', sku: 'parent', name: 'p', basePrice: 10, isParent: true, familyId: family.id, variationAxes: ['Taglia'] } })
  // AIR-MESH-JACKET-MEN-XXL-BLACK's shape: the store says XXL, a stale legacy bag says XS.
  for (const id of ['sheet-set', 'sheet-clear', 'patched', 'organized', 'attached']) {
    await prisma.product.create({ data: { id, sku: id, name: id, basePrice: 10, familyId: family.id, ...(id === 'organized' || id === 'attached' ? {} : { parentId: 'parent' }),
      categoryAttributes: { material: 'Mesh', variations: { Size: 'XXL', Color: 'Nero' } }, variantAttributes: { Taglia: 'XS', Colore: 'Nero' } } })
  }
  // 2.6a — xracing's shape (no declared axis, `Size` held), a declared axis, and a plain attribute.
  for (const [id, axes] of [['undeclared', []], ['declared', ['Taglia']], ['plain', []]] as const) {
    await prisma.product.create({ data: { id: `${id}-parent`, sku: `${id}-parent`, name: id, basePrice: 10, isParent: true, familyId: family.id, variationAxes: [...axes] } })
  }
  await prisma.product.create({ data: { id: 'undeclared-child', sku: 'undeclared-child', name: 'c', basePrice: 10, parentId: 'undeclared-parent', familyId: family.id,
    categoryAttributes: { size: null, variations: { Size: 'L', Color: 'Nero' } } } })
  await prisma.product.create({ data: { id: 'declared-child', sku: 'declared-child', name: 'c', basePrice: 10, parentId: 'declared-parent', familyId: family.id } })
  await prisma.product.create({ data: { id: 'plain-child', sku: 'plain-child', name: 'c', basePrice: 10, parentId: 'plain-parent', familyId: family.id } })
  // 2.6b
  await prisma.product.create({ data: { id: 'organize-parent', sku: 'organize-parent', name: 'p', basePrice: 10, isParent: true } })
}))

describe('2.6a — the sheet writer, end to end: a size edit reaches what the publishers send', () => {
  const context = { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }
  const edit = (id: string, value: string) => scoped(async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id } })
    // The master sheet's own request shape (`masterWrite.ts`): the market it read with, no channel.
    const result = await applyProductBulkEdits({ changes: [{ id, field: 'attr_size', value, target: 'master' }],
      marketplaceContexts: [{ marketplace: 'IT', locale: 'it' }] as never, expectedVersion: before.version }, context)
      .catch((error: { body?: unknown }) => { throw new Error(`the sheet writer refused: ${JSON.stringify(error.body ?? error)} ${
        context.logger.warn.mock.calls.map(c => String((c[0] as { err?: Error })?.err?.stack ?? c[1])).join(' | ')}`) })
    return { result, after: await prisma.product.findUniqueOrThrow({ where: { id }, include: { parent: true } }) }
  })
  it('xracing-shaped: a size edit reaches what eBay publishes, and the sheet shows the same value', async () => {
    const { result, after } = await edit('undeclared-child', 'XL')
    expect(result).toMatchObject({ updated: 1 })
    expect(storedVariationValues(after, ['Size']).Size).toBe('XL')
    expect(resolveAttributes({ product: after as any, parent: after.parent as any }).size?.value).toBe('XL')
    expect((after.categoryAttributes as any).variations.Color).toBe('Nero')
  })
  it('declared axis: unchanged behaviour, the value lands under the declared key', async () => {
    const { after } = await edit('declared-child', 'M')
    expect(storedVariationValues(after, ['Taglia']).Taglia).toBe('M')
  })
  it('control — a plain attribute is written to the flat key and nothing else', async () => {
    const { after } = await edit('plain-child', 'S')
    expect((after.categoryAttributes as any).size).toBe('S')
    expect((after.categoryAttributes as any).variations).toBeUndefined()
    expect(after.variantAttributes).toBeNull()
  })
})

describe('2.6b — each writer that sets part of categoryAttributes keeps the store', () => {
  const STORE = { Size: 'L', Color: 'Nero' }
  const seed = (id: string, extra: Record<string, unknown> = {}) => scoped(() => prisma.product.create({ data: { id, sku: id, name: id, basePrice: 10,
    categoryAttributes: { material: 'Mesh', variations: STORE, ...extra } } }))
  const bag = (id: string) => scoped(async () => (await prisma.product.findUniqueOrThrow({ where: { id } })).categoryAttributes as Record<string, unknown>)
  it('eBay Inventory import (update path): sets its aspects, keeps variations and every other attribute', async () => {
    await seed('kept-ebay-imported')
    ebayItems.items = [{ sku: 'kept-ebay-imported', product: { title: 'T', aspects: { Colore: ['Blu'], Taglia: ['M'], Materiale: ['Nylon'] } } }]
    const result = await scoped(() => importEbayCatalog())
    expect(result).toMatchObject({ updated: 1 })
    expect(await bag('kept-ebay-imported')).toEqual({ material: 'Nylon', color: 'Blu', apparel_size: 'M', variations: STORE })
  })
  it('Amazon reconciliation enrich: stores Amazon\'s raw attributes, keeps variations and every other attribute', async () => {
    await seed('kept-amazon-enriched', { armorType: 'CE' })
    const amazonService = { fetchProductDetails: vi.fn(async () => ({ bulletPoints: [], keywords: [], images: [],
      rawAttributes: { color: [{ value: 'Nero', language_tag: 'it_IT' }] } })) }
    await scoped(() => enrichProductFromAmazon('kept-amazon-enriched', 'APJ6JRA9NG5V4', amazonService as never,
      new Map([['kept-amazon-enriched', { productId: 'kept-amazon-enriched', variationId: null, isVariation: false }]]), new Map()))
    expect(await bag('kept-amazon-enriched')).toEqual({ material: 'Mesh', armorType: 'CE', color: [{ value: 'Nero', language_tag: 'it_IT' }], variations: STORE })
  })
  it('organize publish: sets the child\'s axis values, keeps every other attribute', async () => {
    await seed('kept-organized')
    const app = await routeApp(catalogOrganizeRoutes)
    const res = await app.inject({ method: 'POST', url: '/api/catalog/organize/publish',
      payload: { changes: [{ productId: 'kept-organized', toParentId: 'organize-parent', attributes: { Taglia: 'S' } }] } })
    expect(res.statusCode, res.body).toBe(200)
    expect(await bag('kept-organized')).toEqual({ material: 'Mesh', variations: { Taglia: 'S' } })
  })
  it('PATCH /api/catalog/products/:id: the client\'s bag replaces the rest, but not the store it did not send', async () => {
    await seed('kept-patched', { armorType: 'CE' })
    const app = await routeApp(catalogRoutes)
    const res = await app.inject({ method: 'PATCH', url: '/api/catalog/products/kept-patched', payload: { categoryAttributes: { material: 'Leather' } } })
    expect(res.statusCode, res.body).toBe(200)
    expect(await bag('kept-patched')).toEqual({ material: 'Leather', variations: STORE })
  })
  it('control — PATCH that sends variations itself writes them', async () => {
    await seed('kept-patched-with-store')
    const app = await routeApp(catalogRoutes)
    const res = await app.inject({ method: 'PATCH', url: '/api/catalog/products/kept-patched-with-store', payload: { categoryAttributes: { variations: { Size: 'XL' } } } })
    expect(res.statusCode, res.body).toBe(200)
    expect(await bag('kept-patched-with-store')).toEqual({ variations: { Size: 'XL' } })
  })
})

describe('2.6c-2 — each writer: the value goes to the store, the axis leaves the legacy bag', () => {
  const sheet = (id: string, value: string | null, intent?: 'reset') => scoped(async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id } })
    return applyProductBulkEdits({ changes: [{ id, field: 'attr_size', value, target: 'master', ...(intent ? { intent } : {}) }],
      marketplaceContexts: [{ marketplace: 'IT', locale: 'it' }] as never, expectedVersion: before.version },
    { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } })
  })

  it('the sheet (set): the store takes M under every spelling it holds; the legacy size leaves; colour untouched', async () => {
    await sheet('sheet-set', 'M')
    const after = await read('sheet-set')
    expect(store(after)).toMatchObject({ Size: 'M', Taglia: 'M', Color: 'Nero' })
    expect(after.variantAttributes).toEqual({ Colore: 'Nero' })
    expect(variationBag(after).Size).toBe('M')
  })
  it('the sheet (clear) — THE TRAP: the stale legacy XS must not come back', async () => {
    await sheet('sheet-clear', null, 'reset')
    const after = await read('sheet-clear')
    expect(sizeKeysIn(store(after))).toEqual([])
    expect(sizeKeysIn(after.variantAttributes)).toEqual([])
    expect(sizeKeysIn(variationBag(after))).toEqual([])
  })
  it('PATCH /catalog/products/:id/variant-attributes: set, then delete with an empty string', async () => {
    const app = await routeApp(catalogRoutes)
    const set = await app.inject({ method: 'PATCH', url: '/api/catalog/products/patched/variant-attributes', payload: { Taglia: 'L' } })
    expect(set.statusCode, set.body).toBe(200)
    let after = await read('patched')
    expect(store(after)).toMatchObject({ Taglia: 'L', Color: 'Nero' })
    expect(sizeKeysIn(after.variantAttributes)).toEqual([])
    expect(set.json().variantAttributes).toMatchObject({ Taglia: 'L' })
    await app.inject({ method: 'PATCH', url: '/api/catalog/products/patched/variant-attributes', payload: { Taglia: '' } })
    after = await read('patched')
    expect(sizeKeysIn(variationBag(after))).toEqual([])
  })
  it('attach to a parent (attachProduct)', async () => {
    await scoped(() => prisma.$transaction((tx) => attachProduct(tx as never, 'parent', 'attached', { Taglia: 'S' })))
    const after = await read('attached')
    expect(store(after)).toMatchObject({ Taglia: 'S' })
    expect(sizeKeysIn(after.variantAttributes)).toEqual([])
    expect(variationBag(after).Taglia).toBe('S')
  })
  it('add a child (POST /catalog/products/:parentId/children): the store only, the legacy bag never written', async () => {
    const app = await routeApp(catalogRoutes)
    const res = await app.inject({ method: 'POST', url: '/api/catalog/products/parent/children', payload: { sku: 'new-child', name: 'n', variantAttributes: { Taglia: 'M' } } })
    expect(res.statusCode, res.body).toBeLessThan(300)
    const after = await scoped(() => prisma.product.findFirstOrThrow({ where: { sku: 'new-child' } }))
    expect(store(after)).toEqual({ Taglia: 'M' })
    expect(after.variantAttributes).toBeNull()
  })
  it('organize publish: the child\'s axis map replaces the store; the legacy bag is emptied', async () => {
    const app = await routeApp(catalogOrganizeRoutes)
    const res = await app.inject({ method: 'POST', url: '/api/catalog/organize/publish', payload: { changes: [{ productId: 'organized', toParentId: 'parent', attributes: { Taglia: 'S' } }] } })
    expect(res.statusCode, res.body).toBe(200)
    const after = await read('organized')
    expect(after.categoryAttributes).toEqual({ material: 'Mesh', variations: { Taglia: 'S' } })
    expect(after.variantAttributes).toEqual({})
  })
})

// ── the source scan ────────────────────────────────────────────────────────────────────────────────────────
const API_SRC = join(__dirname, '../..')
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path)
    return /\.ts$/.test(name) && !/\.test\.ts$|test-store\.ts$/.test(name) ? [path] : []
  })
}
const lines = sourceFiles(API_SRC).flatMap((path) => readFileSync(path, 'utf8').split('\n').map((text, i) => ({ file: relative(API_SRC, path), line: i + 1, text })))
  .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text))
const where = (r: { file: string; line: number; text: string }) => `${r.file}:${r.line}: ${r.text.trim()}`

/** Object-key lines `variantAttributes: <value>` that are NOT a write to the column: selects are filtered out
 * (`: true`), and type annotations (`: unknown`, `: Record<…>`). Each remaining one is named. */
const NOT_A_WRITE: Array<[string, string, string]> = [
  ['routes/listing-wizard.routes.ts', 'variantAttributes: product.variantAttributes,', 'AI prompt context'],
  ['routes/products-ai.routes.ts', 'variantAttributes: product.variantAttributes,', 'AI prompt context'],
  ['routes/product-translations.routes.ts', 'variantAttributes: product.variantAttributes,', 'AI prompt context'],
  ['routes/listing-content.routes.ts', 'variantAttributes: product.variantAttributes,', 'AI prompt context'],
  ['jobs/listing-quality-snapshot.job.ts', 'variantAttributes: product.variantAttributes,', 'AI prompt context'],
  ['routes/marketing-automation.routes.ts', 'variantAttributes: (product.variantAttributes ?? undefined)', 'AI prompt context'],
  ['routes/pim.routes.ts', 'variantAttributes: variationBag({ categoryAttributes: _store', 'response DTO'],
  ['routes/images/images-workspace.routes.ts', 'variantAttributes: attrs,', 'response DTO (the store-first bag)'],
  ['routes/images/images-workspace.routes.ts', 'variantAttributes: v.variationAttributes as Record<string, string> | null,', 'response DTO (legacy ProductVariation rows)'],
  ['routes/images/images-workspace.routes.ts', 'variantAttributes: c.variantAttributes as Record<string, unknown> | null,', 'input to deriveWorkspaceAxes'],
  ['routes/images/images-workspace.routes.ts', 'variantAttributes: v.variationAttributes as Record<string, unknown> | null,', 'input to deriveWorkspaceAxes'],
  ['routes/catalog.routes.ts', 'variantAttributes: nextVA,', 'response DTO (the store-first bag)'],
  ['routes/products-catalog.routes.ts', 'variantAttributes: null,', 'response DTO'],
  ['services/ebay-family-axes.service.ts', 'variantAttributes: c.variantAttributes,', 'input to buildFlatRow'],
  ['services/bulk-action.service.ts', 'variantAttributes: (item as ProductLike).variantAttributes }', 'input to the one writer\'s plan'],
  ['services/bulk-action/attribute-helpers.ts', 'variantAttributes: product.variantAttributes })', 'input to variationBag'],
  ['services/shopify/content-workspace.service.ts', "variantAttributes: 'variantAttributes' in p ? p.variantAttributes : {}", 'input to the helpers'],
  ['services/assortment/field-groups.ts', "variantAttributes: g('attributes'),", 'the assortment copy field map: copies the column as-is between businesses, never a new value'],
  // The one write left outside the writer: the organize undo restores a snapshot (A-28, for the Owner).
  ['routes/catalog-organize.routes.ts', 'variantAttributes: (change.fromVariantAttributes as any) ?? null,', 'organize undo (A-28)'],
]
const FLAT_FILE_ASSIGNMENTS = ['services/amazon/flat-file.service.ts', 'services/ebay-flat-file-create.logic.ts']

describe('the source scan — nothing else writes the legacy bag', () => {
  it('raw SQL may only REMOVE keys from it (the one writer, and the sheet\'s transaction)', () => {
    const sql = lines.filter((r) => /"variantAttributes"\s*=/.test(r.text))
    expect(sql.length).toBeGreaterThan(0)   // positive control: the scan sees the writer itself
    expect(sql.filter((r) => !/"variantAttributes"\s*-\s*\$\{/.test(r.text)).map(where)).toEqual([])
  })
  it('a direct assignment exists only in the two no-touch flat-file creates', () => {
    const assigned = lines.filter((r) => /\.variantAttributes\s*=[^=]/.test(r.text))
    expect([...new Set(assigned.map((r) => r.file))].sort()).toEqual([...FLAT_FILE_ASSIGNMENTS].sort())
  })
  it('every other `variantAttributes: <value>` line is named, and none is stale', () => {
    const keyed = lines.filter((r) => /\bvariantAttributes\s*:\s*(?!true\b|unknown\b|Record<)\S/.test(r.text))
    expect(keyed.filter((r) => !NOT_A_WRITE.some(([file, snippet]) => r.file === file && r.text.includes(snippet))).map(where)).toEqual([])
    expect(NOT_A_WRITE.filter(([file, snippet]) => !keyed.some((r) => r.file === file && r.text.includes(snippet)))).toEqual([])
  })
})

// Close the throwaway database; a named budget, because the hook runs this beside the whole suite.
afterAll(async () => { await state.db?.close() }, 60_000)
