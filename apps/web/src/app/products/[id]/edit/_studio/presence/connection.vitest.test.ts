import { describe, expect, it } from 'vitest'
import { connectionHealth } from './connection'
const now = Date.parse('2026-09-13T12:00:00Z')
const connected = { isActive: true, authStatus: 'connected', accessTokenExpiresAt: '2026-09-14T12:00:00Z' }
describe('connection evidence is tri-state', () => {
  it('recognises connected evidence and preserves its source', () => {
    expect(connectionHealth(connected, now)).toMatchObject({ state: 'connected', via: 'ChannelConnection', refusal: null })
  })
  it('retains a revoked account as disconnected evidence', () => {
    expect(connectionHealth({ ...connected, isActive: false, authStatus: 'revoked' }, now)).toMatchObject({ state: 'not-connected', refusal: 'Connection revoked. Stored listings remain visible.' })
  })
  it('an expired grant never reads healthy merely because isActive is true', () => {
    expect(connectionHealth({ ...connected, accessTokenExpiresAt: '2026-09-12T12:00:00Z' }, now)).toMatchObject({ state: 'not-connected', refusal: 'Connection grant expired. Stored listings remain visible.' })
  })
  it.each([{}, { isActive: true }, { ...connected, authStatus: 'degraded' }, { ...connected, accessTokenExpiresAt: 'bad date' }])('keeps missing or unreliable evidence unknown: %j', raw => {
    expect(connectionHealth(raw, now).state).toBe('unknown')
  })
})
