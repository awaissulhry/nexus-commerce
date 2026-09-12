import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { $queryRaw: mocks.query } }))
import { browseNodeNamesFromSchemas } from './browse-node-labels.service.js'

const node = (id: string, name?: string, market?: string) => ({ items: { properties: {
  ...(market ? { marketplace_id: { const: market } } : {}),
  value: { enum: [id], ...(name ? { enumNames: [name] } : {}) },
} } })

beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })

describe('cached Amazon browse-node names', () => {
  it('uses a name from another product type in the same market without inventing names', () => {
    expect(browseNodeNamesFromSchemas([
      node('123'), node('123', 'Moto › Jackets'), node('other'),
      node('foreign', 'Not Italy', 'A1PA6795UKMFR9'),
    ], 'IT')).toEqual({ '123': 'Moto › Jackets' })
  })

  it('does not choose between conflicting taxonomy names', () => {
    expect(browseNodeNamesFromSchemas([node('123', 'Jackets'), node('123', 'Boots')], 'IT')).toEqual({})
  })

  it('shares one bounded-subtree database read per market and returns only requested IDs', async () => {
    const { cachedBrowseNodeLabels } = await import('./browse-node-labels.service.js')
    mocks.query.mockImplementation(async (_query, market) => [{ node: node('123', `${market} jackets`) }, { node: node('unused', 'Unrequested') }])
    const [itNames, same, deNames] = await Promise.all([
      cachedBrowseNodeLabels('IT', ['123']), cachedBrowseNodeLabels('IT', ['123']), cachedBrowseNodeLabels('DE', ['123']),
    ])
    expect(itNames).toEqual({ '123': 'IT jackets' }); expect(same).toEqual(itNames)
    expect(deNames).toEqual({ '123': 'DE jackets' })
    expect(mocks.query).toHaveBeenCalledTimes(2)
    expect(mocks.query.mock.calls[0][0].join('?')).toContain('DISTINCT ON ("productType")')
    expect(mocks.query.mock.calls[0][0].join('?')).toContain('"isActive" = true')
    expect(await cachedBrowseNodeLabels('IT', ['missing'])).toEqual({})
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed database lookup and does not query for an empty request', async () => {
    const { cachedBrowseNodeLabels } = await import('./browse-node-labels.service.js')
    expect(await cachedBrowseNodeLabels('IT', [])).toEqual({})
    mocks.query.mockRejectedValueOnce(new Error('Database unavailable')).mockResolvedValue([{ node: node('123', 'Jackets') }])
    await expect(cachedBrowseNodeLabels('IT', ['123'])).rejects.toThrow('Database unavailable')
    expect(await cachedBrowseNodeLabels('IT', ['123'])).toEqual({ '123': 'Jackets' })
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })
})
