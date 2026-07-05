import { describe, it, expect } from 'vitest'
import { MASTER_FIELDS } from '../registry/master-fields'
import { CHANNEL_SHARED_FIELDS, CHANNEL_MARKET_FIELDS } from '../registry/channel-fields'

describe('census coverage', () => {
  it('every field id is unique within its group', () => {
    for (const group of [MASTER_FIELDS, CHANNEL_SHARED_FIELDS, CHANNEL_MARKET_FIELDS]) {
      const ids = group.map(f => f.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
  it('every identifier is forcedText', () => {
    for (const f of [...MASTER_FIELDS, ...CHANNEL_MARKET_FIELDS])
      if (f.cls === 'IDENTITY') expect(f.forcedText, f.id).toBe(true)
  })
  it('every governed field declares its follow/override/master columns', () => {
    for (const f of CHANNEL_MARKET_FIELDS)
      if (f.followMaster) {
        expect(f.followMaster.followColumn).toMatch(/^followMaster/)
        expect(f.followMaster.overrideColumn).toBeTruthy()
        expect(f.followMaster.masterCacheColumn).toBeTruthy()
      }
  })
  it('excludes the deprecated chain and duplicate columns (F15)', () => {
    const cols = [...MASTER_FIELDS, ...CHANNEL_MARKET_FIELDS].map(f => f.source.column)
    expect(cols).not.toContain('parentAsin')       // dup of amazonAsin
    expect(cols).not.toContain('fulfillmentChannel')// dup of fulfillmentMethod
    expect(cols).not.toContain('currentPrice')      // VariantChannelListing dup (excluded chain)
    expect(cols).not.toContain('channelPrice')      // VariantChannelListing dup (excluded chain)
  })
})
