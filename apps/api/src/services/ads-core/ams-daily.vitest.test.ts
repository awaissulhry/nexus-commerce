/** AX2.3 — AMS must not double-count the daily grain, and must key markets like everything else. */
import { describe, it, expect } from 'vitest'
import { AMS_DAILY_MARKER, EXCLUDE_AMS_DAILY } from './ams-daily.js'
import { normalizeAmsMarketplace } from '../advertising/ads-marketing-stream.service.js'

describe('EXCLUDE_AMS_DAILY', () => {
  it('excludes exactly the stream-written rows', () => {
    expect(AMS_DAILY_MARKER).toBe('ams-stream')
    expect(EXCLUDE_AMS_DAILY).toEqual({ reportRunId: { not: 'ams-stream' } })
  })

  it('spreads into a where-clause without disturbing an OR arm', () => {
    // This is the exact shape the campaign-detail and trends queries build.
    const where = {
      OR: [{ localEntityId: 'camp_1' }, { entityId: '123456' }],
      ...EXCLUDE_AMS_DAILY,
    }
    expect(where.OR).toHaveLength(2)
    expect(where.reportRunId).toEqual({ not: 'ams-stream' })
  })
})

describe('normalizeAmsMarketplace (AX2.3)', () => {
  it('maps the real production value to the code the rest of Nexus uses', () => {
    // All 9,728 hourly rows had been stored under this raw id.
    expect(normalizeAmsMarketplace('APJ6JRA9NG5V4')).toBe('IT')
  })

  it('maps the other EU marketplaces', () => {
    expect(normalizeAmsMarketplace('A1PA6795UKMFR9')).toBe('DE')
    expect(normalizeAmsMarketplace('A13V1IB3VIYZZH')).toBe('FR')
    expect(normalizeAmsMarketplace('A1RKKUPIHCS9HS')).toBe('ES')
    expect(normalizeAmsMarketplace('A1F83G8C2ARO7P')).toBe('UK')
  })

  it('passes an already-normalised code straight through (idempotent)', () => {
    expect(normalizeAmsMarketplace('IT')).toBe('IT')
    expect(normalizeAmsMarketplace('DE')).toBe('DE')
  })

  it('defaults to IT only when nothing was supplied', () => {
    expect(normalizeAmsMarketplace(null)).toBe('IT')
    expect(normalizeAmsMarketplace(undefined)).toBe('IT')
    expect(normalizeAmsMarketplace('')).toBe('IT')
  })

  it('passes an UNKNOWN id through rather than silently mislabelling it as IT', () => {
    // Guessing a market is worse than showing an id nobody recognises.
    expect(normalizeAmsMarketplace('A_NEW_MARKET_ID')).toBe('A_NEW_MARKET_ID')
  })
})
