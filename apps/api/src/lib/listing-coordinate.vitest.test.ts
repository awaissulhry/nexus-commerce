import { describe, expect, it } from 'vitest'
import { ListingCoordinateError, whereCoordinate, type ListingCoordinate } from './listing-coordinate.js'

const coordinate: ListingCoordinate = {
  productId: 'product', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '',
}

describe('whereCoordinate', () => {
  // PR.5 M3, 2026-09-13 16:51Z: all measured rows have an account and aliasKey=''.
  it.each([
    ['local', 'AMAZON', 731], ['local', 'EBAY', 277], ['local', 'ETSY', 2], ['local', 'SHOPIFY', 2],
    ['prod', 'AMAZON', 725], ['prod', 'EBAY', 252],
  ])('preserves M3 %s %s shape (%i rows; aliasId NULL is a different field)', (_db, channel) => {
    expect(whereCoordinate({ ...coordinate, channel: String(channel) })).toEqual({ ...coordinate, channel })
  })
  for (const level of Object.keys(coordinate) as Array<keyof ListingCoordinate>) {
    it(`refuses omitted and undefined ${level} before Prisma can widen`, () => {
      const missing = { ...coordinate }
      delete missing[level]
      for (const c of [missing, { ...coordinate, [level]: undefined }]) {
        expect(() => whereCoordinate(c)).toThrowError(ListingCoordinateError)
        expect(() => whereCoordinate(c)).toThrowError(`LISTING_COORDINATE_MISSING_LEVEL: ${level}`)
      }
    })
    if (level !== 'channelConnectionId') {
      it(`refuses NULL ${level}, which the current schema cannot store`, () => {
        expect(() => whereCoordinate({ ...coordinate, [level]: null })).toThrowError(`LISTING_COORDINATE_INVALID_LEVEL: ${level}`)
      })
    }
  }

  it('names all five levels, preserves explicit primary alias and discards unrelated input', () => {
    expect(whereCoordinate({ ...coordinate, id: 'ignored' } as ListingCoordinate)).toEqual(coordinate)
    expect(Object.keys(whereCoordinate(coordinate))).toHaveLength(5)
  })

  it('preserves explicit NULL account and a non-primary alias without a compound unique', () => {
    const c = { ...coordinate, channelConnectionId: null, aliasKey: 'alias' }
    expect(whereCoordinate(c)).toEqual(c)
  })

  it.each(['productId', 'channel', 'marketplace', 'channelConnectionId'] as const)('refuses blank %s', level => {
    expect(() => whereCoordinate({ ...coordinate, [level]: '  ' })).toThrowError(`LISTING_COORDINATE_INVALID_LEVEL: ${level}`)
  })
})
