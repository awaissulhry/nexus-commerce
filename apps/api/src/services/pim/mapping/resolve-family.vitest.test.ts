import { expect, it, vi } from 'vitest'
const resolve = vi.hoisted(() => vi.fn())
vi.mock('./resolve-batch.service.js', () => ({ resolveBatch: resolve }))
import { resolveChannelValues } from './index.js'
it('resolves the whole large family in bounded batches with one exact account, alias and language', async () => {
  resolve.mockImplementation(async input => ({ products: input.productIds.filter((id: string) => id !== 'missing').map((productId: string) => ({ productId, cells: { title: { value: `${input.aliasKey}:${productId}` } }, category: { channelCategoryId: 'coat' } })), missingProductIds: input.productIds.includes('missing') ? ['missing'] : [] }))
  const ids = [...Array.from({ length: 601 }, (_, index) => `p${index}`), 'missing']
  const result = await resolveChannelValues({ channel: 'AMAZON', marketplace: 'DE', channelConnectionId: 'second-account', aliasKey: 'second-alias', locale: 'de', productIds: [...ids, ids[0]] })
  expect(Object.keys(result.byProduct)).toHaveLength(601)
  expect(result.byProduct.p600.title.value).toBe('second-alias:p600')
  expect(result.missingProductIds).toEqual(['missing'])
  expect(resolve.mock.calls.map(([input]) => input.productIds.length)).toEqual([250, 250, 102])
  for (const [input] of resolve.mock.calls) expect(input).toMatchObject({ channelConnectionId: 'second-account', aliasKey: 'second-alias', locale: 'de' })
})
