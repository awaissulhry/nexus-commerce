/**
 * MCP full control P10 — the brand settings write moved from brand-settings.routes.ts (PATCH /api/settings/brand)
 * into brand-settings.service.ts, so Claude's `set-business-settings` saves through the same code. The route answers
 * byte for byte what it answered before (goldens recorded on the route as it was), with business profiles off and
 * on: the created row, an update, every validation refusal, and the settings audit rows the saves wrote (read back
 * through GET /api/settings/audit).
 *
 * A created row's id and an audit row's id are random: they are named `<id N>` in order of appearance; every other
 * byte is compared.
 *
 * One answer changed on purpose afterwards (2026-10-01 fix, last describe): a save that leaves a P.IVA with neither
 * an SDI code nor a PEC is refused with the reason. `brand-save-routing` is that refusal now, and the row and the audit
 * goldens after it no longer show the save it used to let through.
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

import { expectGolden, freezeGoldenClock, goldenApp, inGoldenBusiness } from '../../test-support/route-golden.js'
import brandSettingsRoutes from '../../routes/brand-settings.routes.js'
import settingsAuditRoutes from '../../routes/settings-audit.routes.js'

const GOLDEN = './__golden__'

/** Random cuids (rows created by the request) as `<id N>`, in order of first appearance. */
function stableIds(body: string): string {
  const seen = new Map<string, string>()
  return body.replace(/"c[a-z0-9]{20,30}"/g, (id) => {
    if (!seen.has(id)) seen.set(id, `"<id ${seen.size + 1}>"`)
    return seen.get(id)!
  })
}
const patch = (payload: unknown) => ({ method: 'PATCH' as const, payload, normalize: stableIds })

let app: FastifyInstance
beforeAll(async () => {
  freezeGoldenClock()
  await inGoldenBusiness(async () => {
    await state.db.client.brandSettings.deleteMany({})
    await state.db.client.auditLog.deleteMany({ where: { entityType: 'Settings' } })
  })
  app = await goldenApp([
    { plugin: brandSettingsRoutes, prefix: '/api' },
    { plugin: settingsAuditRoutes, prefix: '/api' },
  ])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

describe('P10 — PATCH /api/settings/brand answers exactly as before', () => {
  it('creates the row on the first save, then updates it; empty strings become null; codes upper-cased', async () => {
    await expectGolden(app, 'brand-save-create', '/api/settings/brand', GOLDEN, patch({
      companyName: '  Golden Srl ', addressLines: [' Via Roma 1 ', '', '00100 Roma'], contactEmail: 'shop@example.test',
    }))
    await expectGolden(app, 'brand-save-update', '/api/settings/brand', GOLDEN, patch({
      companyName: 'Golden Srl', taxId: '', websiteUrl: 'https://example.test', piva: '00000000000', sdiCode: 'abc1234',
      codiceFiscale: 'gldgld00a00h501r', vatScheme: 'ORDINARIO', signatureBlockText: 'Kind regards',
      requireApprovalForPo: true, poApprovalThresholdCents: 12345.6, poApprovalApproverEmail: ' Boss@Example.test ',
      unknownKey: 'dropped',
    }))
  })

  it('refuses bad fiscal values field by field, and writes nothing', async () => {
    await expectGolden(app, 'brand-save-bad-piva', '/api/settings/brand', GOLDEN, patch({ piva: '12345678901', sdiCode: 'x', pecEmail: 'nope' }))
    await expectGolden(app, 'brand-save-bad-scheme', '/api/settings/brand', GOLDEN, patch({ vatScheme: 'MAYBE' }))
    // A P.IVA with neither an SDI code nor a PEC address: the invoicing routing check.
    await expectGolden(app, 'brand-save-routing', '/api/settings/brand', GOLDEN, patch({ piva: '00000000000', sdiCode: null, pecEmail: null }))
    await expectGolden(app, 'brand-after-refusals', '/api/settings/brand', GOLDEN, { normalize: stableIds })
  })

  it('the saves are in the settings audit, as before', async () => {
    await expectGolden(app, 'brand-save-audit', '/api/settings/audit?key=company', GOLDEN, { normalize: stableIds })
  })
})

describe('2026-10-01 fix — a P.IVA keeps an SDI code or a PEC after the save', () => {
  const ROUTING = 'Italian B2B invoicing requires either an SDI code or a PEC email (one of the two is mandatory).'
  const row = () => inGoldenBusiness(() => state.db.client.brandSettings.findFirstOrThrow())
  const setRow = (data: Record<string, unknown>) => inGoldenBusiness(() => state.db.client.brandSettings.updateMany({ data }))
  const save = async (payload: unknown) => {
    const response = await app.inject({ method: 'PATCH', url: '/api/settings/brand', payload: payload as never })
    return { status: response.statusCode, body: response.json() as Record<string, any> }
  }

  it('clearing the only routing value of a business with a P.IVA is refused with the reason, and nothing is written', async () => {
    await setRow({ piva: '00000000000', sdiCode: 'ABC1234', pecEmail: null })
    expect(await save({ sdiCode: null })).toEqual({ status: 400, body: { error: 'Validation failed', fieldErrors: { routing: ROUTING } } })
    expect(await save({ sdiCode: '' })).toEqual({ status: 400, body: { error: 'Validation failed', fieldErrors: { routing: ROUTING } } })
    expect((await row()).sdiCode).toBe('ABC1234')
    await setRow({ sdiCode: null, pecEmail: 'golden@pec.example.test' })
    expect(await save({ pecEmail: null })).toMatchObject({ status: 400, body: { fieldErrors: { routing: ROUTING } } })
    expect((await row()).pecEmail).toBe('golden@pec.example.test')
  })

  it('still allowed: swapping one routing value for the other, and clearing the P.IVA with them', async () => {
    await setRow({ piva: '00000000000', sdiCode: 'ABC1234', pecEmail: null })
    expect((await save({ sdiCode: null, pecEmail: 'golden@pec.example.test' })).status).toBe(200)
    expect(await row()).toMatchObject({ sdiCode: null, pecEmail: 'golden@pec.example.test' })
    expect((await save({ piva: null, pecEmail: null })).status).toBe(200)
    expect(await row()).toMatchObject({ piva: null, pecEmail: null })
  })
})
