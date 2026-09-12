vi.mock('../services/pim/product-category-context.js', () => ({ productCategoryContext: async () => ({ categories: ['OUTERWEAR'] }) }))
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const formulaFindUnique = vi.fn()
const formulaFindMany = vi.fn()
const formulaDelete = vi.fn()
const auditWrite = vi.fn()

vi.mock('../db.js', () => ({
  default: {
    cellFormula: {
      findUnique: (...a: unknown[]) => formulaFindUnique(...a),
      findMany: (...a: unknown[]) => formulaFindMany(...a),
      delete: (...a: unknown[]) => formulaDelete(...a),
    },
    product: { findUnique: async () => null },
    channelListing: { findFirst: async () => null },
    auditLog: { findMany: async () => [] },
  },
}))
vi.mock('../services/audit-log.service.js', () => ({
  auditLogService: { write: (...a: unknown[]) => auditWrite(...a) },
}))
vi.mock('../services/pim/studio-columns.js', () => ({ getStudioColumns: async () => ({ columns: [] }) }))
vi.mock('../services/pim/schema-mapping.service.js', () => ({ getMappingForMarketplace: async () => ({ expressions: {} }) }))
vi.mock('../services/pim/value-map.service.js', () => ({ loadValueMapLookup: async () => undefined, loadSizeScaleLookup: async () => undefined }))

import routes from './cell-formula.routes.js'

let app: FastifyInstance
beforeEach(async () => {
  formulaFindUnique.mockReset(); formulaFindMany.mockReset(); formulaDelete.mockReset(); auditWrite.mockReset()
  formulaFindUnique.mockResolvedValue({
    id: 'f1', expr: '$x', fieldKey: 'manufacturer', scope: 'master',
    channel: '', marketplace: '', locale: 'de', dependsOn: [],
  })
  formulaDelete.mockResolvedValue({}); formulaFindMany.mockResolvedValue([])
  app = Fastify(); await app.register(routes); await app.ready()
})

describe('#764 the formula audit row carries the request IP', () => {
  it('a pin records the caller\'s ip, as the bulk path does', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/pim/formulas/product/p1?fieldKey=manufacturer&scope=master&locale=de',
      remoteAddress: '127.0.0.1',
    })
    expect(res.statusCode).toBe(200)
    expect(auditWrite).toHaveBeenCalledTimes(1)
    const row = auditWrite.mock.calls[0][0]
    expect(row.action).toBe('formula.pinned')
    // The point of the item: this was `undefined` before, so every
    // formula.pinned row read `ip = null` while the bulk rows beside it
    // carried an address.
    expect(row.ip).toBe('127.0.0.1')
  })

  it('SENSITIVITY: the ip comes from the REQUEST, not a constant', async () => {
    // Without this the assertion above would pass on a hardcoded value.
    const res = await app.inject({
      method: 'DELETE',
      url: '/pim/formulas/product/p1?fieldKey=manufacturer&scope=master&locale=de',
      remoteAddress: '10.1.2.3',
    })
    expect(res.statusCode).toBe(200)
    expect(auditWrite.mock.calls[0][0].ip).toBe('10.1.2.3')
  })

  it('no audit row is written when nothing was pinned', async () => {
    formulaFindUnique.mockResolvedValue(null)
    const res = await app.inject({
      method: 'DELETE',
      url: '/pim/formulas/product/p1?fieldKey=manufacturer&scope=master&locale=de',
    })
    expect(res.statusCode).toBe(404)
    expect(auditWrite).not.toHaveBeenCalled()
  })
})
