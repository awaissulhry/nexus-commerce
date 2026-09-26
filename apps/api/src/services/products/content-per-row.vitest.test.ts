import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * R-60 — CONTENT rows (title, description, bullets, keywords) are judged PER ROW only on the sheet's opt-in
 * (`contentPerRow`, passed by `PATCH /products/bulk` alone). Every other caller keeps all-or-nothing: the translation form,
 * restore and the AI writes answer "failed" on any error, so a partial save would be hidden from the operator.
 * Real save path on PGlite: `applyProductBulkEdits` → `applyContentBulk` → the content writers; what is STORED is the claim.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn(), { reconcileFamilyReadiness: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkEdits } from './bulk-edit.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const CAP = 20
const LONG = 'x'.repeat(CAP + 5)
const context = { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }
const ids: Record<'a' | 'b' | 'c' | 'd' | 'route', string> = { a: '', b: '', c: '', d: '', route: '' }

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'APJ6JRA9NG5V4' } as never })
  const account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'content-per-row', isActive: true, externalAccountId: 'SELLER' } as never })).id
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'COAT', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000),
    schemaDefinition: { properties: { bullet_point: { type: 'array', maxItems: 5, selectors: ['marketplace_id', 'language_tag'],
      items: { type: 'object', properties: { value: { type: 'string', maxLength: CAP }, language_tag: { type: 'string' }, marketplace_id: { const: 'APJ6JRA9NG5V4' } } } } } } } })
  for (const key of Object.keys(ids) as Array<keyof typeof ids>) {
    const product = await prisma.product.create({ data: { sku: `per-row-${key}`, name: `Vecchio ${key}`, description: `Descrizione ${key}`, basePrice: 10, productType: 'COAT' } })
    await prisma.channelListing.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: account } })
    ids[key] = product.id
  }
}), 60_000)
afterAll(async () => { await state.db?.close() })

const source = { tier: 'source' } as const
/** Two rows of one product: a valid title, and a bullet list over the Amazon·IT cap (R-58 refuses it at the content step). */
const mixedCap = (id: string) => [{ id, field: 'name', value: `Nuovo ${id.slice(-4)}`, contentAddress: source }, { id, field: 'bulletPoints', value: ['ok', LONG], contentAddress: source }]
/** A valid title, and a description sent under the wrong content language (refused INSIDE `applyContentBulk`). */
const mixedAddress = (id: string) => [{ id, field: 'name', value: `Nuovo ${id.slice(-4)}`, contentAddress: source }, { id, field: 'description', value: 'Beschreibung', contentAddress: { tier: 'language', language: 'de' } }]
const save = (id: string, changes: unknown[], perRow: boolean) => scoped(async () => {
  const product = await prisma.product.findUniqueOrThrow({ where: { id } })
  return applyProductBulkEdits({ changes, marketplaceContexts: [{ marketplace: 'IT', locale: 'it' }], expectedVersion: product.version } as never,
    { ...context, ...(perRow ? { contentPerRow: true } : {}) }) as Promise<any>
})
const row = (id: string) => scoped(() => prisma.product.findUniqueOrThrow({ where: { id }, select: { name: true, description: true, bulletPoints: true } }))
const auditFields = (id: string) => scoped(async () => (await prisma.auditLog.findMany({ where: { entityId: id } })).flatMap(a => ((a.metadata as any)?.fields ?? []) as string[]))

it('C1 opt-in: the valid title is stored, the over-cap bullets are refused by name and not stored; the audit names the title only', async () => {
  const result = await save(ids.a, mixedCap(ids.a), true)
  expect(result).toMatchObject({ success: true, updated: 1 })
  expect(result.errors).toEqual([expect.objectContaining({ id: ids.a, field: 'bulletPoints', error: expect.stringMatching(/^Bullet 2 takes at most 20 characters/) })])
  expect(await row(ids.a)).toMatchObject({ name: `Nuovo ${ids.a.slice(-4)}`, bulletPoints: [] })
  const fields = await auditFields(ids.a)
  expect(fields.some(f => f === 'title' || f === 'name')).toBe(true)
  expect(fields).not.toContain('bulletPoints')
})

it('C2 opt-in: a row refused inside the content writer is not stored; the valid row beside it is', async () => {
  const result = await save(ids.b, mixedAddress(ids.b), true)
  expect(result).toMatchObject({ success: true, updated: 1 })
  expect(result.errors).toEqual([expect.objectContaining({ id: ids.b, field: 'description' })])
  expect(await row(ids.b)).toMatchObject({ name: `Nuovo ${ids.b.slice(-4)}`, description: 'Descrizione b' })
})

it('C3 without the opt-in (the translation form, restore, the AI writes): the same mixed inputs store NOTHING', async () => {
  const cap = await save(ids.c, mixedCap(ids.c), false)
  expect(cap).toMatchObject({ success: false, updated: 0 })
  expect(await row(ids.c)).toMatchObject({ name: 'Vecchio c', bulletPoints: [] })
  const address = await save(ids.d, mixedAddress(ids.d), false)
  expect(address).toMatchObject({ success: false, updated: 0 })
  expect(await row(ids.d)).toMatchObject({ name: 'Vecchio d', description: 'Descrizione d' })
  expect(await auditFields(ids.c)).toEqual([])
  expect(await auditFields(ids.d)).toEqual([])
})

it('C4 (source read): only the sheet route passes the opt-in; the three all-or-nothing callers do not', () => {
  const read = (file: string) => readFileSync(fileURLToPath(new URL(`../../routes/${file}`, import.meta.url)), 'utf8')
  const call = (text: string, from: number) => text.slice(from, text.indexOf('logger:', from) + 60)
  const products = read('products.routes.ts')
  expect(call(products, products.indexOf("fastify.patch<{ Body: ProductBulkInput }>('/products/bulk'"))).toContain('contentPerRow: true')
  expect(call(products, products.indexOf('const restored = await applyProductBulkEdits('))).not.toContain('contentPerRow')
  const translations = read('product-translations.routes.ts')
  expect(call(translations, translations.indexOf('await applyProductBulkEdits('))).not.toContain('contentPerRow')
  const ai = read('products-ai.routes.ts')
  expect(call(ai, ai.indexOf('await applyProductBulkEdits('))).not.toContain('contentPerRow')
  // Positive control: every one of the four call sites was found (a moved call would make `indexOf` -1 and prove nothing).
  expect([products.indexOf("'/products/bulk'"), products.indexOf('const restored = await applyProductBulkEdits('), translations.indexOf('await applyProductBulkEdits('), ai.indexOf('await applyProductBulkEdits(')].every(i => i > 0)).toBe(true)
})

it('C5 the sheet route itself (PATCH /products/bulk, real handler): the mixed request stores the title and refuses the bullets', async () => {
  const Fastify = (await import('fastify')).default
  const { default: productsRoutes } = await import('../../routes/products.routes.js')
  const app = Fastify()
  // What production has and this bare app lacked (B1d): the global workspace preHandler (`lib/workspace-hook.ts`
  // `createWorkspaceHook`) enters the request's business with `withWorkspace(scope, done)` — the CALLBACK form, so the whole
  // handler runs inside it — and does nothing when profiles are OFF. Without it, under profiles ON the handler had no
  // business: the contract load threw "Select a business profile." and every content row was refused.
  app.addHook('preHandler', (_request, _reply, done) => {
    if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') { done(); return }
    withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done)
  })
  await app.register(productsRoutes)
  await app.ready()
  try {
    const product = await row(ids.route)
    const version = (await scoped(() => prisma.product.findUniqueOrThrow({ where: { id: ids.route } }))).version
    const response = await scoped(() => app.inject({ method: 'PATCH', url: '/products/bulk',
      payload: { changes: mixedCap(ids.route), marketplaceContexts: [{ marketplace: 'IT', locale: 'it' }], expectedVersion: version } }))
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({ success: true, updated: 1 })
    expect(body.errors).toEqual([expect.objectContaining({ field: 'bulletPoints' })])
    expect(await row(ids.route)).toMatchObject({ name: `Nuovo ${ids.route.slice(-4)}`, bulletPoints: product.bulletPoints })
  } finally { await app.close() }
}, 60_000)
