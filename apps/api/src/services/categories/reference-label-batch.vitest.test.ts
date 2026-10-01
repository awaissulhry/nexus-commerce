import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ mappings: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { categoryChannelMapping: { findMany: mocks.mappings } } }))
vi.mock('../pim/channel-specs/index.js', () => ({ loadAmazonSpec: vi.fn() }))
import { cachedCategoryLabelsMany } from './reference-labels.service.js'
beforeEach(() => { mocks.mappings.mockReset() })

describe('bounded selected category paths', () => {
  it('reads all selected IDs once and keeps each exact-market verdict separate', async () => {
    mocks.mappings.mockResolvedValue([
      { channelCategoryId: '123', marketplace: 'IT', channelCategoryPath: 'Example > Jackets' },
      { channelCategoryId: '456', marketplace: 'IT', channelCategoryPath: 'Example > Gloves' },
      { channelCategoryId: '123', marketplace: '*', channelCategoryPath: 'Wrong market' },
    ])
    expect(await cachedCategoryLabelsMany('EBAY', 'IT', ['123', '456', 'missing'])).toEqual({ categoryId: { '123': 'Example > Jackets', '456': 'Example > Gloves' } })
    expect(mocks.mappings).toHaveBeenCalledTimes(1)
    expect(mocks.mappings).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ channel: 'EBAY', marketplace: { in: ['IT'] }, channelCategoryId: { in: ['123', '456', 'missing'] } }) }))
  })
  it('does not choose a conflicting path or borrow another eBay market', async () => {
    mocks.mappings.mockResolvedValue([
      { channelCategoryId: '123', marketplace: 'IT', channelCategoryPath: 'Jackets' },
      { channelCategoryId: '123', marketplace: 'IT', channelCategoryPath: 'Gloves' },
      { channelCategoryId: '456', marketplace: '*', channelCategoryPath: 'Not Italy' },
    ])
    expect(await cachedCategoryLabelsMany('EBAY', 'IT', ['123', '456'])).toEqual({})
  })
  it('preserves the existing Amazon wildcard fallback when no exact label exists', async () => {
    mocks.mappings.mockResolvedValue([{ channelCategoryId: 'OUTERWEAR', marketplace: '*', channelCategoryPath: 'Example > Outerwear' }])
    expect(await cachedCategoryLabelsMany('AMAZON', 'IT', ['OUTERWEAR'])).toEqual({ productType: { OUTERWEAR: 'Example > Outerwear' } })
  })
  it('does no query for an empty selection and refuses an unbounded list', async () => {
    expect(await cachedCategoryLabelsMany('EBAY', 'IT', [])).toEqual({})
    await expect(cachedCategoryLabelsMany('EBAY', 'IT', Array.from({length:1001},(_,i)=>String(i)))).rejects.toThrow()
    expect(mocks.mappings).not.toHaveBeenCalled()
  })
  it('keeps a lookup failure distinct from a completed empty lookup', async () => {
    mocks.mappings.mockRejectedValue(new Error('Unavailable'))
    await expect(cachedCategoryLabelsMany('EBAY', 'IT', ['123'])).rejects.toThrow('Unavailable')
  })
})
