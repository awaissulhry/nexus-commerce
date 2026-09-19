import { describe, expect, it } from 'vitest'
import { appSecretStatus, expiryInputValue, formatExpiryDate, type AppSecretRow } from './app-secrets'

// P0.5 — what the "App secrets" card says. The web runner is node-only, so the pure logic is pinned.

const row = (over: Partial<AppSecretRow>): AppSecretRow => ({
  channelKey: 'AMAZON_SP', label: 'Amazon SP-API', environment: 'production',
  secretExpiresAt: '2026-12-23T00:00:00.000Z', daysLeft: 95, rotatedAt: null, ...over,
})

describe('appSecretStatus', () => {
  it('Amazon with no date is a WARNING that says where to find it', () => {
    const s = appSecretStatus(row({ secretExpiresAt: null, daysLeft: null }))
    expect(s).toMatchObject({ tone: 'warning', label: 'No expiry date recorded' })
    expect(s.detail).toMatch(/Solution Provider Portal/)
  })
  it('a channel without a scheduled expiry and no date is neutral', () => {
    expect(appSecretStatus(row({ channelKey: 'EBAY', label: 'eBay', secretExpiresAt: null, daysLeft: null })).tone).toBe('neutral')
  })
  it.each([
    [120, 'success', '120 days left'],
    [90, 'info', '90 days left'],
    [31, 'info', '31 days left'],
    [30, 'warning', '30 days left'],
    [8, 'warning', '8 days left'],
    [7, 'danger', '7 days left'],
    [1, 'danger', '1 day left'],
    [0, 'danger', '0 days left'],
    [-1, 'danger', 'Expired'],
  ])('%i days → %s "%s"', (daysLeft, tone, label) => {
    expect(appSecretStatus(row({ daysLeft }))).toMatchObject({ tone, label })
  })
  it('names the date in words, not a raw timestamp', () => {
    expect(appSecretStatus(row({})).detail).toBe('The secret expires on 23 Dec 2026. Nexus alerts 90, 30 and 7 days before.')
    expect(formatExpiryDate('2027-03-18T00:00:00.000Z')).toBe('18 Mar 2027')
  })
})

describe('expiryInputValue', () => {
  it('gives the date field yyyy-mm-dd, or empty when no date is recorded', () => {
    expect(expiryInputValue(row({}))).toBe('2026-12-23')
    expect(expiryInputValue(row({ secretExpiresAt: null }))).toBe('')
  })
})
