import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ get: vi.fn(), reader: vi.fn(), account: vi.fn() }))
vi.mock('../etsy/read-client.js', () => ({ etsyReader: mocks.reader }))
vi.mock('../connection-resolver.service.js', () => ({ resolveConnection: mocks.account }))
vi.mock('../../db.js', () => ({ default: {} }))
import { CategorySchemaService } from './schema-sync.service.js'
const db = { categorySchema: { findFirst: vi.fn(), upsert: vi.fn() } }
const service = new CategorySchemaService(db as never, null as never)
beforeEach(() => {
  vi.resetAllMocks()
  mocks.reader.mockResolvedValue({ get: mocks.get })
  mocks.account.mockImplementation(async scope => ({ id: scope.accountId ?? 'primary-account' }))
  mocks.get.mockResolvedValue({ count: 0, results: [] })
  db.categorySchema.upsert.mockImplementation(async args => args.create)
})
it('refreshes the exact seller category through the selected account and caches the complete definition', async () => {
  const row = await service.getSchema({ channel: 'ETSY', marketplace: 'IT', productType: '2838', accountId: 'chosen-shop' }, { force: true })
  expect(mocks.account).toHaveBeenCalledWith({ accountId: 'chosen-shop' })
  expect(mocks.reader).toHaveBeenCalledWith('chosen-shop')
  expect(mocks.get).toHaveBeenCalledWith('/seller-taxonomy/nodes/2838/properties')
  expect(row).toMatchObject({ channel: 'ETSY', marketplace: 'GLOBAL', productType: '2838', schemaDefinition: { count: 0, results: [] } })
  expect(row.schemaVersion).toMatch(/^[a-f0-9]{64}$/)
})
it('keeps a usable cache intact if Etsy returns an incomplete response', async () => {
  mocks.get.mockResolvedValue({ count: 1, results: [] })
  await expect(service.getSchema({ channel: 'ETSY', productType: '5' }, { force: true })).rejects.toThrow('incomplete')
  expect(db.categorySchema.upsert).not.toHaveBeenCalled()
})
it('keeps a usable cache intact if account access or Etsy fails', async () => {
  mocks.get.mockRejectedValue(new Error('Etsy unavailable'))
  await expect(service.getSchema({ channel: 'ETSY', productType: '5' }, { force: true })).rejects.toThrow('Etsy unavailable')
  expect(db.categorySchema.upsert).not.toHaveBeenCalled()
})
it('rejects non-numeric category paths before account or network access', async () => {
  await expect(service.getSchema({ channel: 'ETSY', productType: '../5' }, { force: true })).rejects.toThrow('seller taxonomy category')
  expect(mocks.account).not.toHaveBeenCalled()
  expect(mocks.get).not.toHaveBeenCalled()
})
it('uses the GLOBAL cache even when the sheet is opened from a country market', async () => {
  db.categorySchema.findFirst.mockResolvedValue({ id: 'cached' })
  expect(await service.getSchema({ channel: 'ETSY', marketplace: 'IT', productType: '5' })).toEqual({ id: 'cached' })
  expect(db.categorySchema.findFirst.mock.calls[0][0].where).toMatchObject({ channel: 'ETSY', marketplace: 'GLOBAL', productType: '5' })
  expect(mocks.get).not.toHaveBeenCalled()
})
