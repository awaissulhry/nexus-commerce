import { describe, expect, it } from 'vitest'
import { matchesConnectionAttempt, type ConnectionAttempt } from './connection-attempt'

const attempt: ConnectionAttempt = { channelKey: 'EBAY', workspaceId: 'chosen-business', state: 'single-use-state' }
const message = { type: 'nexus:channel-connected', channel: 'EBAY', channelKey: 'EBAY', workspaceId: 'chosen-business', state: 'single-use-state' }

describe('account connection callback ownership', () => {
  it('accepts the chosen destination regardless of which profile page opened it', () => {
    expect(matchesConnectionAttempt(message, attempt, true)).toBe(true)
  })
  it.each([
    { workspaceId: 'page-business' }, { state: 'another-tab-state' }, { state: undefined },
    { channelKey: 'AMAZON_SP' }, { channelKey: undefined }, { type: 'nexus:ack' },
  ])('rejects a callback for a different attempt: %j', changes => {
    expect(matchesConnectionAttempt({ ...message, ...changes }, attempt, true)).toBe(false)
  })
  it('rejects unsolicited or already-consumed callbacks and incomplete attempts', () => {
    expect(matchesConnectionAttempt(message, null, true)).toBe(false)
    expect(matchesConnectionAttempt(message, { ...attempt, state: null }, true)).toBe(false)
    expect(matchesConnectionAttempt(null, attempt, true)).toBe(false)
  })
  it('accepts a legacy channel-only response only for an attempt without OAuth state', () => {
    const legacy = { type: 'nexus:channel-connected', channel: 'EBAY' }
    expect(matchesConnectionAttempt(legacy, { ...attempt, state: null, legacy: true }, false)).toBe(true)
    expect(matchesConnectionAttempt(legacy, { ...attempt, state: null }, false)).toBe(false)
    expect(matchesConnectionAttempt(legacy, attempt, false)).toBe(false)
    expect(matchesConnectionAttempt(legacy, null, false)).toBe(false)
    expect(matchesConnectionAttempt({ ...legacy, channel: 'AMAZON' }, attempt, false)).toBe(false)
  })
  it.each(['SHOPIFY', 'ETSY'])('requires the matching state even without business profiles for %s', channelKey => {
    const local = { channelKey, workspaceId: null, state: 'current-attempt' }
    const reply = { type: 'nexus:channel-connected', channelKey, channel: channelKey, state: 'current-attempt' }
    expect(matchesConnectionAttempt(reply, local, false)).toBe(true)
    expect(matchesConnectionAttempt({ ...reply, state: 'earlier-attempt' }, local, false)).toBe(false)
    expect(matchesConnectionAttempt({ ...reply, state: undefined }, local, false)).toBe(false)
  })
})
