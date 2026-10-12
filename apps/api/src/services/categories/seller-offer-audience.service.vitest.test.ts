import { beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ connections: [] as Array<{ id: string; workspaceId: string | null }>, audience: vi.fn(), upsert: vi.fn(), findMany: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { sellerReferenceLabel: { upsert: m.upsert, findMany: m.findMany } } }))
vi.mock('../../lib/workspace-context.js', () => ({ workspaceIdForQuery: () => 'ws-own' }))
vi.mock('../connection-resolver.service.js', () => ({
  listActiveConnections: async () => m.connections,
  isOwnConnection: (row: { workspaceId?: string | null }) => !row.workspaceId || row.workspaceId === 'ws-own',
}))
vi.mock('./seller-schema.service.js', () => ({ amazonSellerOfferAudience: m.audience }))
import { OFFER_AUDIENCE_FIELD_KEY, offerAudienceKey, refreshSellerOfferAudiences, storedOfferAudiences } from './seller-offer-audience.service.js'

beforeEach(() => { m.audience.mockReset(); m.upsert.mockReset().mockResolvedValue({}); m.findMany.mockReset() })

it('asks per own Amazon account × pair, keeps a non-empty answer, skips an empty one, and goes on past a failure', async () => {
  m.connections = [{ id: 'own', workspaceId: 'ws-own' }, { id: 'lent', workspaceId: 'ws-other' }]
  m.audience.mockImplementation(async (_account: string, market: string) => {
    if (market === 'DE') throw new Error('Unavailable')
    if (market === 'FR') return {}
    return { B2B: 'Amazon Business (B2B)', ALL: 'Vendita su Amazon' }
  })
  const out = await refreshSellerOfferAudiences([{ marketplace: 'it', productType: 'COAT' }, { marketplace: 'DE', productType: 'COAT' }, { marketplace: 'FR', productType: 'COAT' }], { throttleMs: 0 })
  expect(out).toEqual({ stored: 1, failed: 1 })
  // Another business's account is never asked with its credentials.
  expect(m.audience.mock.calls.map(c => `${c[0]} ${c[1]} ${c[2]}`)).toEqual(['own IT COAT', 'own DE COAT', 'own FR COAT'])
  expect(m.upsert).toHaveBeenCalledTimes(1)
  expect(m.upsert.mock.calls[0][0]).toMatchObject({
    where: { channel_connectionId_marketplace_productType_fieldKey: { workspaceId: 'ws-own', channel: 'AMAZON', connectionId: 'own', marketplace: 'IT', productType: 'COAT', fieldKey: OFFER_AUDIENCE_FIELD_KEY } },
    update: { labels: { B2B: 'Amazon Business (B2B)', ALL: 'Vendita su Amazon' } },
  })
})

it('reads the kept codes by account and market; no accounts → no query', async () => {
  m.findMany.mockResolvedValue([{ connectionId: 'own', marketplace: 'IT', labels: { B2B: 'x', ALL: 'y' } }, { connectionId: 'own', marketplace: 'DE', labels: { ALL: 'y' } }])
  const map = await storedOfferAudiences('COAT', ['own'])
  expect(map.get(offerAudienceKey('own', 'it'))).toEqual(['B2B', 'ALL'])
  expect(map.get(offerAudienceKey('own', 'DE'))).toEqual(['ALL'])
  expect(map.has(offerAudienceKey('own', 'FR'))).toBe(false)
  expect(m.findMany.mock.calls[0][0].where).toEqual({ channel: 'AMAZON', fieldKey: OFFER_AUDIENCE_FIELD_KEY, productType: 'COAT', connectionId: { in: ['own'] } })
  m.findMany.mockClear()
  expect((await storedOfferAudiences('COAT', [])).size).toBe(0)
  expect(m.findMany).not.toHaveBeenCalled()
})
