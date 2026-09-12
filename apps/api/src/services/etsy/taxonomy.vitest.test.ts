import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ account: vi.fn(), reader: vi.fn(), get: vi.fn() }))
vi.mock('../connection-resolver.service.js', () => ({ resolveConnection: mocks.account }))
vi.mock('./read-client.js', () => ({ etsyReader: mocks.reader }))
import { flattenEtsyTaxonomy, getEtsyTaxonomy } from './taxonomy.js'
const tree = { results: [{ id: 100, name: 'Clothing', children: [{ id: 101, name: 'Jackets', children: [] }] }] }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.account.mockImplementation(async scope => ({ id: scope.accountId, channelType: 'ETSY' }))
  mocks.reader.mockResolvedValue({ get: mocks.get })
  mocks.get.mockResolvedValue(tree)
})
it('preserves every seller node and its full breadcrumb, independently of any existing listing', () => {
  expect(flattenEtsyTaxonomy(tree)).toEqual([{ productType: '100', displayName: 'Clothing' }, { productType: '101', displayName: 'Clothing › Jackets' }])
})
it('rejects incomplete branches instead of treating them as empty categories', () => {
  expect(() => flattenEtsyTaxonomy({})).toThrow('incomplete')
  expect(() => flattenEtsyTaxonomy({ results: [{ id: 100, name: 'Clothing' }] })).toThrow('invalid')
  expect(() => flattenEtsyTaxonomy({ results: [tree.results[0], tree.results[0]] })).toThrow('invalid')
})
it('shares concurrent reads only for the same account and allows an explicit refresh', async () => {
  const [a, b] = await Promise.all([getEtsyTaxonomy('one'), getEtsyTaxonomy('one')])
  expect(a).toEqual(b)
  expect(mocks.get).toHaveBeenCalledTimes(1)
  await getEtsyTaxonomy('two')
  expect(mocks.get).toHaveBeenCalledTimes(2)
  await getEtsyTaxonomy('one', true)
  expect(mocks.get).toHaveBeenCalledTimes(3)
})
it('allows a clean retry after a provider failure', async () => {
  mocks.get.mockRejectedValueOnce(new Error('offline'))
  await expect(getEtsyTaxonomy('retry')).rejects.toThrow('offline')
  expect(await getEtsyTaxonomy('retry')).toHaveLength(2)
})
it('refuses a different channel before consulting the cache or network', async () => {
  mocks.account.mockResolvedValue({ id: 'one', channelType: 'AMAZON' })
  await expect(getEtsyTaxonomy('one')).rejects.toThrow('not Etsy')
  expect(mocks.reader).not.toHaveBeenCalled()
})
