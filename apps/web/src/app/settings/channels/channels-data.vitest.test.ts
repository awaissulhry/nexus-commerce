import { describe, expect, it } from 'vitest'
import { STATUS_LABEL, channelName, relativeTime } from './channels-data'

// The web vitest runner is `environment: 'node'` by design (no jsdom, no new
// deps), so what is tested here is the pure logic every tab renders from.

describe('relativeTime', () => {
  const now = Date.parse('2026-08-29T12:00:00Z')
  it('renders null as "never" — a column nothing wrote is not a time', () => {
    expect(relativeTime(null, now)).toBe('never')
    expect(relativeTime(undefined, now)).toBe('never')
  })
  it('renders garbage as "unknown", never NaN', () => {
    expect(relativeTime('not-a-date', now)).toBe('unknown')
  })
  it('rounds to the nearest unit in both directions', () => {
    expect(relativeTime('2026-08-29T11:59:50Z', now)).toBe('just now')
    expect(relativeTime('2026-08-29T11:48:00Z', now)).toBe('12 mins ago')
    expect(relativeTime('2026-08-29T11:00:00Z', now)).toBe('1 hour ago')
    expect(relativeTime('2026-08-27T12:00:00Z', now)).toBe('2 days ago')
    expect(relativeTime('2026-08-29T13:08:00Z', now)).toBe('in 1 hour')
    expect(relativeTime('2026-08-29T12:30:00Z', now)).toBe('in 30 mins')
  })
})

describe('STATUS_LABEL', () => {
  it('covers every authStatus the API can write, with the tone the spec assigns', () => {
    expect(STATUS_LABEL.connected).toEqual({ label: 'Connected', tone: 'success' })
    expect(STATUS_LABEL.degraded.tone).toBe('warning')
    expect(STATUS_LABEL.needs_reauth).toEqual({ label: 'Sign-in needed', tone: 'danger' })
    expect(STATUS_LABEL.revoked.tone).toBe('danger')
    expect(STATUS_LABEL.disconnected.tone).toBe('neutral')
    expect(STATUS_LABEL.unknown).toEqual({ label: 'Not yet checked', tone: 'info' })
    expect(Object.keys(STATUS_LABEL).sort()).toEqual(['connected', 'degraded', 'disconnected', 'needs_reauth', 'revoked', 'unknown'])
  })
})

describe('channelName', () => {
  it('names the channels the catalogue and accounts use, and echoes unknown keys', () => {
    expect(channelName('EBAY')).toBe('eBay')
    expect(channelName('AMAZON')).toBe('Amazon')
    expect(channelName('AMAZON_ADS')).toBe('Amazon Ads')
    expect(channelName('KAUFLAND')).toBe('KAUFLAND')
  })
})
