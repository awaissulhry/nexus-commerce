import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  markets: [] as { channel: string; code: string; name: string; languages: string[]; language: string; isActive: boolean }[],
  db: { marketplace: { findMany: vi.fn() }, productFamily: { findMany: vi.fn() } },
  connections: vi.fn(),
}))
vi.mock('../../db.js', () => ({ default: state.db }))
vi.mock('../connection-resolver.service.js', () => ({ listActiveConnections: state.connections }))
import { catalogReadinessOptions, catalogTransferLanguages } from './catalog-transfer-export.js'

beforeEach(() => {
  vi.resetAllMocks()
  state.markets = [
    { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Store', languages: ['it', 'de'], language: 'it', isActive: true },
    { channel: 'AMAZON', code: 'BE', name: 'Belgium', languages: ['nl-BE', 'fr-BE'], language: 'nl', isActive: true },
    { channel: 'EBAY', code: 'IT', name: 'Italy', languages: [], language: 'it-IT', isActive: true },
    { channel: 'AMAZON', code: 'ES', name: 'Spain', languages: ['es'], language: 'es', isActive: false },
  ]
  state.db.marketplace.findMany.mockImplementation(async ({ where, select, orderBy }) => {
    const rows = state.markets.filter(row => row.isActive === where.isActive)
    const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []
    rows.sort((a, b) => {
      for (const order of orders) {
        const field = Object.keys(order)[0] as 'channel' | 'code'
        const comparison = a[field].localeCompare(b[field])
        if (comparison) return comparison
      }
      return 0
    })
    return rows.map(row => Object.fromEntries(Object.keys(select).map(key => [key, row[key as keyof typeof row]])))
  })
  state.db.productFamily.findMany.mockResolvedValue([{ id: 'xavia', code: 'XAVIA', label: 'Xavia' }])
  state.connections.mockImplementation(async channel => channel === 'AMAZON'
    ? [{ id: 'account-123456', channelType: 'AMAZON', marketplace: 'BE', accountLabel: 'Belgium seller', isPrimary: false }]
    : [])
})

it('keeps the source language first and normalizes active multilingual and scalar authorities', async () => {
  expect(await catalogTransferLanguages()).toEqual({ sourceLanguage: 'it', languages: ['it', 'de', 'nl', 'fr'] })
})

it('refuses missing marketplace language configuration instead of inventing a choice', async () => {
  state.markets[0].languages = []
  state.markets[0].language = ''
  await expect(catalogTransferLanguages()).rejects.toMatchObject({ code: 'market_languages_unconfigured', statusCode: 400 })
})

it('keeps readiness markets in channel/code order with the original response fields and account labels', async () => {
  expect(await catalogReadinessOptions()).toEqual({
    families: [{ id: 'xavia', code: 'XAVIA', label: 'Xavia' }],
    accounts: [{ id: 'account-123456', channelType: 'AMAZON', marketplace: 'BE', accountLabel: 'Belgium seller', isPrimary: false, displayName: 'Belgium seller · 123456' }],
    markets: [
      { channel: 'AMAZON', code: 'BE', name: 'Belgium' },
      { channel: 'EBAY', code: 'IT', name: 'Italy' },
      { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Store' },
    ],
  })
})
