import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const db = vi.hoisted(() => ({
  wizardTemplate: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  listingWizard: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
}))
vi.mock('../db.js', () => ({ default: db }))
import routes from './wizard-templates.routes.js'

const updatedAt = new Date('2026-09-06T09:00:00.000Z')
const template = {
  id: 'preset-1', name: 'Outerwear', description: null, categoryHint: 'Jackets',
  channels: [{ platform: 'EBAY', marketplace: 'IT' }],
  defaults: { skuStrategy: { childSku: 'per-marketplace', parentSku: 'shared' }, variations: { commonTheme: 'Size', includedSkus: ['OTHER-PRODUCT-S'] }, pricing: { basePrice: 25 } },
  builtIn: false, usageCount: 0, updatedAt, createdAt: updatedAt, lastUsedAt: null,
}
const wizard = {
  id: 'wizard-1', productId: 'product-1', status: 'DRAFT', currentStep: 1, version: 3, updatedAt,
  channels: [{ platform: 'AMAZON', marketplace: 'DE' }],
  state: { skuStrategy: { childSku: 'shared' }, variations: { includedSkus: ['THIS-PRODUCT-L'] }, pricing: { basePrice: 0 } },
}
const tokens = { expectedVersion: 3, expectedWizardUpdatedAt: updatedAt.toISOString(), expectedPresetUpdatedAt: updatedAt.toISOString() }
let app: FastifyInstance
beforeAll(async () => { app = Fastify(); await app.register(routes); await app.ready() })
afterAll(async () => { await app.close() })
beforeEach(() => {
  vi.resetAllMocks()
  db.wizardTemplate.findUnique.mockResolvedValue(template)
  db.listingWizard.findUnique.mockResolvedValue(wizard)
  db.wizardTemplate.updateMany.mockResolvedValue({ count: 1 })
  db.listingWizard.updateMany.mockResolvedValue({ count: 1 })
  db.wizardTemplate.findUniqueOrThrow.mockResolvedValue(template)
  db.listingWizard.findUniqueOrThrow.mockResolvedValue(wizard)
  db.$transaction.mockImplementation(async callback => callback(db))
})
const apply = (payload: object) => app.inject({ method: 'POST', url: '/wizard-templates/preset-1/apply', payload: { wizardId: wizard.id, ...payload } })

describe('listing preset review and ownership', () => {
  it('previews an apply-once operation without persisting values or usage', async () => {
    const res = await apply({ dryRun: true })
    expect(res.statusCode).toBe(200)
    const { preview } = res.json()
    expect(preview).toMatchObject({ ...tokens, operation: 'apply-once', futureProducts: false, publication: 'separate' })
    expect(preview.after.state).toEqual({
      skuStrategy: { childSku: 'shared', parentSku: 'shared' },
      variations: { includedSkus: ['THIS-PRODUCT-L'], commonTheme: 'Size' }, pricing: { basePrice: 0 },
    })
    expect(preview.excluded).toEqual(expect.arrayContaining(['pricing', 'variations.includedSkus']))
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.listingWizard.updateMany).not.toHaveBeenCalled()
  })

  it('requires a reviewed version before applying and never edits an active submission', async () => {
    expect((await apply({})).statusCode).toBe(400)
    db.listingWizard.findUnique.mockResolvedValue({ ...wizard, status: 'SUBMITTING' })
    expect((await apply(tokens)).statusCode).toBe(409)
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a changed wizard even when a legacy writer did not increment its version', async () => {
    db.listingWizard.findUnique.mockResolvedValue({ ...wizard, updatedAt: new Date('2026-09-06T09:01:00Z') })
    expect((await apply(tokens)).statusCode).toBe(409)
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a changed preset and requires another review', async () => {
    db.wizardTemplate.findUnique.mockResolvedValue({ ...template, updatedAt: new Date('2026-09-06T09:01:00Z') })
    expect((await apply(tokens)).statusCode).toBe(409)
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('applies the reviewed values with both wizard guards and a stable definition revision', async () => {
    expect((await apply(tokens)).statusCode).toBe(200)
    const update = db.listingWizard.updateMany.mock.calls[0][0]
    expect(update.where).toEqual({ id: wizard.id, status: 'DRAFT', version: 3, updatedAt })
    expect(update.data.state).toMatchObject({ skuStrategy: { childSku: 'shared', parentSku: 'shared' }, pricing: { basePrice: 0 }, variations: { includedSkus: ['THIS-PRODUCT-L'] } })
    expect(update.data.version).toEqual({ increment: 1 })
    expect(db.wizardTemplate.updateMany).toHaveBeenCalledWith({ where: { id: template.id, updatedAt }, data: { usageCount: { increment: 1 }, lastUsedAt: expect.any(Date), updatedAt } })
  })

  it('refuses a wizard write that loses a race without recording a successful application', async () => {
    db.listingWizard.updateMany.mockResolvedValue({ count: 0 })
    expect((await apply(tokens)).statusCode).toBe(409)
    expect(db.wizardTemplate.updateMany).not.toHaveBeenCalled()
  })

  it('throws inside the transaction when the preset changes during apply, so the wizard write rolls back', async () => {
    let committed = false
    db.$transaction.mockImplementation(async callback => {
      const result = await callback(db)
      committed = true
      return result
    })
    db.wizardTemplate.updateMany.mockResolvedValue({ count: 0 })
    expect((await apply(tokens)).statusCode).toBe(409)
    expect(committed).toBe(false)
    expect(db.listingWizard.findUniqueOrThrow).not.toHaveBeenCalled()
  })

  it('saves reusable settings from a wizard without storing product prices or child selections', async () => {
    db.wizardTemplate.create.mockImplementation(async ({ data }) => ({ ...template, ...data }))
    const res = await app.inject({ method: 'POST', url: '/wizard-templates/from-wizard/wizard-1', payload: { name: 'My preset' } })
    expect(res.statusCode).toBe(201)
    expect(db.wizardTemplate.create.mock.calls[0][0].data.defaults).toEqual({ skuStrategy: { childSku: 'shared' } })
  })

  it('refuses explicit creation with product-owned values', async () => {
    const res = await app.inject({ method: 'POST', url: '/wizard-templates', payload: { name: 'Unsafe', channels: template.channels, defaults: { pricing: { basePrice: 25 } } } })
    expect(res.statusCode).toBe(400)
    expect(db.wizardTemplate.create).not.toHaveBeenCalled()
  })
})

describe('listing preset library', () => {
  it('filters and paginates on the server while surfacing excluded legacy defaults', async () => {
    db.wizardTemplate.count.mockResolvedValue(2500)
    db.wizardTemplate.findMany.mockResolvedValue([template])
    const res = await app.inject({ method: 'GET', url: '/wizard-templates?channel=ebay&market=it&search=jacket&limit=50&offset=100' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ total: 2500, offset: 100, limit: 50, rows: [{ excluded: expect.arrayContaining(['pricing']), defaults: { variations: { commonTheme: 'Size' } } }] })
    expect(db.wizardTemplate.findMany.mock.calls[0][0]).toMatchObject({ take: 50, skip: 100, where: { channels: { array_contains: [{ platform: 'EBAY', marketplace: 'IT' }] }, name: { contains: 'jacket', mode: 'insensitive' } } })
  })

  it('protects built-in rows and refuses stale metadata edits and deletions', async () => {
    const patch = (payload: object) => app.inject({ method: 'PATCH', url: '/wizard-templates/preset-1', payload })
    expect((await patch({ name: 'Changed', expectedUpdatedAt: 'old' })).statusCode).toBe(409)
    expect((await app.inject({ method: 'DELETE', url: '/wizard-templates/preset-1?expectedUpdatedAt=old' })).statusCode).toBe(409)
    db.wizardTemplate.findUnique.mockResolvedValue({ ...template, builtIn: true })
    expect((await patch({ name: 'Changed', expectedUpdatedAt: updatedAt.toISOString() })).statusCode).toBe(409)
    expect(db.wizardTemplate.updateMany).not.toHaveBeenCalled()
    expect(db.wizardTemplate.deleteMany).not.toHaveBeenCalled()
  })
})
