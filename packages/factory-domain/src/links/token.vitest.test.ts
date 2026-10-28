import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LINK_SECRET_BYTES, linkTokenHash, matchesLinkHash, mintLinkToken, parseLinkToken } from './token'

const IDS = {
  tenantId: '0195f5d0-0000-7000-8000-0000000000f1',
  partyId: '0195f5d0-0000-7000-8000-0000000000d1',
  linkId: '0195f5d0-0000-7000-8000-0000000000e1',
}

describe('link tokens', () => {
  it('carry the ids and 256 random bits, URL-safe', () => {
    const token = mintLinkToken(IDS)
    const secret = token.value.split('.')[3]!
    expect(token.value.startsWith(`${IDS.tenantId}.${IDS.partyId}.${IDS.linkId}.`)).toBe(true)
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(secret, 'base64url')).toHaveLength(LINK_SECRET_BYTES)
    expect(encodeURIComponent(token.value)).toBe(token.value)
    expect(mintLinkToken(IDS).value).not.toBe(token.value)
  })

  it('read back what they were minted with, and nothing else', () => {
    const token = mintLinkToken(IDS, () => new Uint8Array(32).fill(7))
    expect(parseLinkToken(token.value)).toEqual(token)
    expect(parseLinkToken(`${token.value}x`)).toBeNull()
    expect(parseLinkToken(token.value.slice(0, -1))).toBeNull()
    expect(parseLinkToken(`${token.value.slice(0, -1)}!`)).toBeNull()
    expect(parseLinkToken(token.value.replace(IDS.partyId, 'not-a-uuid-at-all-but-36-characters!'))).toBeNull()
    expect(parseLinkToken(`${IDS.tenantId}.${IDS.linkId}.${token.value.split('.')[3]}`)).toBeNull()
    expect(parseLinkToken(undefined)).toBeNull()
    expect(parseLinkToken(42)).toBeNull()
  })

  it('refuse to mint without UUIDs or with a short secret', () => {
    expect(() => mintLinkToken({ ...IDS, partyId: 'p1' })).toThrow(/UUID partyId/)
    expect(() => mintLinkToken(IDS, () => new Uint8Array(16))).toThrow(/32 random bytes/)
  })

  it('are stored as SHA-256 of the whole value and compared in constant time', () => {
    const token = mintLinkToken(IDS)
    const hash = linkTokenHash(token.value)
    expect(hash).toBe(createHash('sha256').update(token.value).digest('hex'))
    expect(matchesLinkHash(token, hash)).toBe(true)
    expect(matchesLinkHash(mintLinkToken(IDS), hash)).toBe(false)
    expect(matchesLinkHash(token, hash.toUpperCase())).toBe(false)
    expect(matchesLinkHash(token, null)).toBe(false)
    expect(matchesLinkHash(token, token.value)).toBe(false)
  })
})
