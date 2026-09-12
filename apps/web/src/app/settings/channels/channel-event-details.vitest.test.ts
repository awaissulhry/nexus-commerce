import { describe, expect, it } from 'vitest'
import { readableAccountText, summariseDetail } from './channel-event-details'

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
  it('names accounts inside historical error messages without changing the audit data', () => {
    const id = 'cmothu9bo0000nz01asw6wx8j'
    const detail = { message: `Connection ${id} is env-managed.`, failures: 6 }
    expect(summariseDetail(detail, { [id]: 'XAVIA RACING' })).toBe('message: Connection XAVIA RACING is env-managed. · failures: 6')
    expect(detail.message).toContain(id)
  })
  it('replaces embedded unknown keys, including nested messages', () => {
    expect(summariseDetail({ error: { message: 'Seller A1VRHKTGYO1JNU unavailable' } })).toBe('error: {"message":"Seller account (name unavailable) unavailable"}')
  })
  it('keeps numbers and real names while resolving numeric profile IDs', () => {
    expect(readableAccountText('Profile 123456789 failed after 360000 ms for ALPHARACING', { '123456789': 'Xavia Racing Italia' })).toBe('Profile Xavia Racing Italia failed after 360000 ms for ALPHARACING')
  })
  it('escapes known keys and replaces complete tokens only', () => {
    expect(readableAccountText('Account internal.key, not internalXkey or prefixinternal.key', { 'internal.key': 'motovento' })).toBe('Account motovento, not internalXkey or prefixinternal.key')
  })
})
