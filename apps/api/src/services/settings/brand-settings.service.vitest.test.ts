/**
 * MCP full control P3 — the brand settings reads moved from brand-settings.routes.ts into brand-settings.service.ts.
 * GET /api/settings/brand and GET /api/settings/primary-marketplace answer byte for byte what they answered before
 * (goldens recorded on the route as it was), with business profiles off and on.
 *
 * GET /api/settings/brand creates an empty row when the business has none — what it always did. Claude's read
 * (`readBrandSettings`) never writes: a business without a row reads as null and still has no row afterwards.
 * The created row's id is random, so that one golden names it `<created id>`; every other byte is compared.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../cloudinary.service.js', () => ({ isCloudinaryConfigured: () => false, uploadBufferToCloudinary: vi.fn() }))

import { expectGolden, freezeGoldenClock, goldenApp, GOLDEN_NOW, inGoldenBusiness, profilesOn } from '../../test-support/route-golden.js'
import brandSettingsRoutes from '../../routes/brand-settings.routes.js'

const GOLDEN = './__golden__'
const mode = () => (profilesOn() ? 'on' : 'off')

let app: FastifyInstance
beforeAll(async () => {
  freezeGoldenClock()
  // A business starts with no brand row and no account settings.
  await inGoldenBusiness(async () => {
    await state.db.client.brandSettings.deleteMany({})
    await state.db.client.accountSettings.deleteMany({})
  })
  app = await goldenApp([{ plugin: brandSettingsRoutes, prefix: '/api' }])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

describe('P3 — brand settings: the routes answer exactly as before', () => {
  it('GET /api/settings/brand with no row creates the empty row and answers with it', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/settings/brand' })
    const rows = await inGoldenBusiness(() => state.db.client.brandSettings.findMany({}))
    expect(rows).toHaveLength(1)
    const body = response.body.split(rows[0].id).join('<created id>')
    await expect(`${response.statusCode}\n${body}\n`).toMatchFileSnapshot(`${GOLDEN}/brand-created.${mode()}.txt`)
    // Asked again, the same row: nothing more is created.
    const again = await app.inject({ method: 'GET', url: '/api/settings/brand' })
    expect(again.body).toBe(response.body)
    expect(await inGoldenBusiness(() => state.db.client.brandSettings.count({}))).toBe(1)
  })

  it('GET /api/settings/brand with a filled row', async () => {
    await inGoldenBusiness(async () => {
      await state.db.client.brandSettings.deleteMany({})
      await state.db.client.brandSettings.create({
        data: {
          id: 'golden-brand', companyName: 'Golden Company', addressLines: ['Via Example 1', '00100 Roma'], taxId: 'IT00000000000',
          contactEmail: 'brand@example.test', contactPhone: '+39 000 0000', websiteUrl: 'https://brand.example.test',
          piva: '00000000000', codiceFiscale: 'GLDCMP00A00H501X', sdiCode: '0000000', pecEmail: 'pec@example.test', vatScheme: 'ORDINARY',
          logoUrl: 'https://cdn.example.test/logo.png', signatureBlockText: 'Kind regards', defaultPoNotes: 'Deliver mornings',
          factoryEmailFrom: 'factory@example.test', requireApprovalForPo: true, poApprovalThresholdCents: 50000,
          poApprovalApproverEmail: 'approver@example.test', cashOnHandCents: 123456, userManualUrls: { it: 'https://manual.example.test/it' },
          createdAt: new Date(GOLDEN_NOW.getTime() - 86_400_000),
        },
      })
    })
    await expectGolden(app, 'brand-filled', '/api/settings/brand', GOLDEN)
  })

  it('GET /api/settings/primary-marketplace: none, then a market', async () => {
    await expectGolden(app, 'primary-marketplace-none', '/api/settings/primary-marketplace', GOLDEN)
    await inGoldenBusiness(() => state.db.client.accountSettings.create({ data: { id: 'golden-account-settings', businessName: 'Golden', primaryMarketplace: 'IT' } }))
    await expectGolden(app, 'primary-marketplace-it', '/api/settings/primary-marketplace', GOLDEN)
  })
})
