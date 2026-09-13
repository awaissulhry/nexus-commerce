vi.mock('../services/pim/product-category-context.js', () => ({ productCategoryContext: async () => ({ categories: ['OUTERWEAR'] }) }))
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const formulaFindUnique = vi.fn()
const formulaFindMany = vi.fn()
const formulaDelete = vi.fn()

vi.mock('../db.js', () => ({
  default: {
    cellFormula: {
      findUnique: (...a: unknown[]) => formulaFindUnique(...a),
      // Regional-language lookups now read coordinate rows and normalize in memory.
      findMany: async (...a: unknown[]) => {
        const rows = await formulaFindMany(...a)
        const row = await formulaFindUnique(...a)
        return rows?.length ? rows : row ? [row] : []
      },
      delete: (...a: unknown[]) => formulaDelete(...a),
    },
    product: { findUnique: async () => null },
    channelListing: { findFirst: async () => null },
    auditLog: { findMany: async () => [] },
  },
}))
vi.mock('../services/audit-log.service.js', () => ({ auditLogService: { write: async () => {} } }))
vi.mock('../services/pim/studio-columns.js', () => ({ getStudioColumns: async () => ({ columns: [] }) }))
vi.mock('../services/pim/schema-mapping.service.js', () => ({ getMappingForMarketplace: async () => ({ expressions: {} }) }))
vi.mock('../services/pim/value-map.service.js', () => ({ loadValueMapLookup: async () => undefined, loadSizeScaleLookup: async () => undefined }))

import routes from './cell-formula.routes.js'

let app: FastifyInstance
beforeEach(async () => {
  formulaFindUnique.mockReset(); formulaFindMany.mockReset(); formulaDelete.mockReset()
  formulaFindMany.mockResolvedValue([])
  formulaDelete.mockResolvedValue({})
  app = Fastify(); await app.register(routes); await app.ready()
})

const del = (qs: string) => app.inject({ method: 'DELETE', url: `/pim/formulas/product/p1?${qs}` })

describe('#763 a DELETE that deletes nothing must not answer 200', () => {
  it('happy path: a matching coordinate pins and answers 200', async () => {
    formulaFindUnique.mockResolvedValue({ id: 'f1', expr: '$x', fieldKey: 'manufacturer', scope: 'master', channel: '', marketplace: '', locale: 'de', dependsOn: [] })
    const res = await del('fieldKey=manufacturer&scope=master&locale=de')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ pinned: true })
    expect(formulaDelete).toHaveBeenCalledTimes(1)
  })

  it('UX.1\'s case: locale omitted while the row is "de" → 400 naming the locale', async () => {
    formulaFindUnique.mockResolvedValue(null)          // the coordinate misses
    formulaFindMany.mockResolvedValue([{ locale: 'de', channel: '', marketplace: '' }])
    const res = await del('fieldKey=manufacturer&scope=master')
    expect(res.statusCode).toBe(400)
    const b = res.json()
    expect(b.error).toContain('locale')
    expect(b.error).toContain('"de"')
    expect(b.coordinate).toMatchObject({ fieldKey: 'manufacturer', scope: 'master', locale: null })
    expect(formulaDelete).not.toHaveBeenCalled()
  })

  it('nothing stored at all → 404 with the coordinate echoed', async () => {
    formulaFindUnique.mockResolvedValue(null)
    formulaFindMany.mockResolvedValue([])
    const res = await del('fieldKey=manufacturer&scope=master&locale=de')
    expect(res.statusCode).toBe(404)
    expect(res.json().coordinate).toMatchObject({ fieldKey: 'manufacturer', locale: 'de' })
    expect(formulaDelete).not.toHaveBeenCalled()
  })

  it('SENSITIVITY: 400 and 404 are different answers, not one code for "no"', async () => {
    // Without this the two arms could both be 404 (or both 400) and each test
    // above would still pass on its own.
    formulaFindUnique.mockResolvedValue(null)
    formulaFindMany.mockResolvedValue([{ locale: 'de', channel: '', marketplace: '' }])
    const mismatch = await del('fieldKey=manufacturer&scope=master')
    formulaFindMany.mockResolvedValue([])
    const absent = await del('fieldKey=manufacturer&scope=master')
    expect([mismatch.statusCode, absent.statusCode]).toEqual([400, 404])
  })
})
