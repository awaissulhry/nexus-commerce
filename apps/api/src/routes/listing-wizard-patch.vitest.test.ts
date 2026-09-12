import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const db = vi.hoisted(() => ({ listingWizard: { findUnique: vi.fn(), update: vi.fn() } }))
vi.mock('../db.js', () => ({ default: db }))
// PATCH must never call a marketplace or AI service. Stub their constructors, keeping the
// actual route's validation, merging and compare-and-swap write path under test.
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class {} }))
vi.mock('../services/categories/schema-sync.service.js', () => ({ CategorySchemaService: class {} }))
vi.mock('../services/listing-wizard/product-types.service.js', () => ({ ProductTypesService: class {} }))
vi.mock('../services/listing-wizard/schema-parser.service.js', () => ({ SchemaParserService: class {} }))
vi.mock('../services/listing-wizard/telemetry.service.js', () => ({ WIZARD_EVENT_TYPES: [], writeStepTransition: vi.fn(), writeWizardEvent: vi.fn() }))
vi.mock('../services/ebay-category.service.js', () => ({ EbayCategoryService: class {} }))
vi.mock('../services/listing-wizard/variations.service.js', () => ({ VariationsService: class {} }))
vi.mock('../services/listing-wizard/submission.service.js', () => ({ SubmissionService: class {} }))
vi.mock('../services/listing-wizard/channel-publish.service.js', () => ({ ChannelPublishService: class {} }))
vi.mock('../services/listing-images/image-resolution.service.js', () => ({ ImageResolutionService: class {} }))
vi.mock('../services/ai/listing-content.service.js', () => ({ ListingContentService: class {}, BudgetExceededError: class extends Error {} }))
vi.mock('../services/ai/budget.service.js', () => ({ readBudgetLimits: vi.fn() }))
vi.mock('../services/ai/usage-logger.service.js', () => ({ logUsage: vi.fn() }))
vi.mock('../services/idempotency.service.js', () => ({ idempotencyService: {} }))
vi.mock('../services/listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))
vi.mock('../services/connection-resolver.service.js', () => ({ listActiveConnections: vi.fn() }))
import routes from './listing-wizard.routes.js'

const stamp = new Date('2026-09-06T10:00:00Z')
const wizard = { id: 'wizard', status: 'DRAFT', version: 4, currentStep: 1, updatedAt: stamp,
  state: { pricing: { basePrice: 120 }, variations: { includedSkus: ['JACKET-S'] } },
  channelStates: { 'EBAY:IT': { attributes: { Color: 'Black' }, productType: 'Jacket' } },
}
let app: FastifyInstance
beforeAll(async () => { app = Fastify(); await app.register(routes); await app.ready() })
afterAll(async () => { await app.close() })
beforeEach(() => {
  vi.clearAllMocks()
  db.listingWizard.findUnique.mockResolvedValue(wizard)
  db.listingWizard.update.mockResolvedValue({ ...wizard, version: 5 })
})
const patch = (payload: object) => app.inject({ method: 'PATCH', url: '/listing-wizard/wizard', payload })

it('refuses stale choices before preparing a preset review', async () => {
  const res = await patch({ expectedUpdatedAt: '2026-09-06T09:59:00Z', state: { skuStrategy: { childSku: 'shared' } } })
  expect(res.statusCode).toBe(409)
  expect(db.listingWizard.update).not.toHaveBeenCalled()
})

it('retains unrelated product settings and channel values while atomically saving current choices', async () => {
  const res = await patch({ expectedUpdatedAt: stamp.toISOString(), state: { skuStrategy: { childSku: 'shared' } }, channels: [{ platform: 'ebay', marketplace: 'it' }] })
  expect(res.statusCode).toBe(200)
  expect(db.listingWizard.update.mock.calls[0][0]).toMatchObject({
    where: { id: 'wizard', status: 'DRAFT', version: 4, updatedAt: stamp },
    data: { version: { increment: 1 }, state: { ...wizard.state, skuStrategy: { childSku: 'shared' } }, channelStates: wizard.channelStates, channels: [{ platform: 'EBAY', marketplace: 'IT' }] },
  })
})

it('reports a conflict if another writer or a submission wins the race', async () => {
  db.listingWizard.update.mockRejectedValue({ code: 'P2025' })
  expect((await patch({ state: { skuStrategy: { childSku: 'shared' } } })).statusCode).toBe(409)
})

it('refuses edits once publication has started', async () => {
  db.listingWizard.findUnique.mockResolvedValue({ ...wizard, status: 'SUBMITTING' })
  expect((await patch({ state: {} })).statusCode).toBe(409)
  expect(db.listingWizard.update).not.toHaveBeenCalled()
})
