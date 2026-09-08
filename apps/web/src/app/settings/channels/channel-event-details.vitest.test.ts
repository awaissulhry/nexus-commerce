import { describe, expect, it } from 'vitest'
import { summariseDetail } from './channel-event-details'

describe('connection ledger names', () => {
  it('omits account identifiers, including the legacy identity string', () => {
    const summary = summariseDetail({ actorKind: 'operator', identity: 'A1VRHKTGYO1JNU', connectionId: 'internal-key', profileId: '123456789', region: 'EU', scopes: 2 })
    expect(summary).toBe('region: EU · scopes: 2')
  })
  it('retains real names and operational details', () => {
    expect(summariseDetail({ identity: 'XAVIA RACING', latencyMs: 253 })).toBe('identity: XAVIA RACING · latencyMs: 253')
  })
  it('removes nested provider identity keys', () => {
    expect(summariseDetail({ identity: { userId: 'raw-id', username: 'motovento' } })).toBe('identity: {"username":"motovento"}')
  })
  it.each(['0e31caaf-9a00-454d-b5dd-1d4459fc3cf8', 123456789012])('hides opaque identity %s', (identity) => {
    expect(summariseDetail({ identity, region: 'EU' })).toBe('region: EU')
  })
})
