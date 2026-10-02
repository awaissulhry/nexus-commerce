/**
 * MCP full control P4 — claude-safe.ts: what a platform read may hand Claude. Every credential shape it knows is
 * removed under any key, secret and personal keys keep their name and lose their value, e-mails are masked, and a big
 * value is cut down.
 */
import { describe, expect, it } from 'vitest'
import { HIDDEN, capped, personName, safeText, safeValue } from './claude-safe.js'

describe('claude-safe — texts', () => {
  it('removes every credential shape it knows, wherever it sits in a text', () => {
    const credentials = [
      'v^1.1#i^1#p^3#r^1#I^3#f^0#t^Ul4xMF8yOkFCQ0RFRg==',
      'Atzr|IwEBIExampleRefreshToken0123456789',
      'Atza|IwEBIExampleAccessToken0123456789',
      // Built at run time so no secret scanner mistakes this fake value for a real Shopify token.
      ['shp', 'at_', '0123456789abcdef'.repeat(2)].join(''),
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ]
    for (const credential of credentials) {
      expect(safeText(`call failed with ${credential} today`)).toBe(`call failed with ${HIDDEN} today`)
    }
    expect(safeText('header Authorization: Bearer abc.def-ghi/jkl= sent')).toBe(`header Authorization: ${HIDDEN} sent`)
    expect(safeText('Bearer v^1.1#i^1#secret')).toBe(HIDDEN)
  })

  it('masks e-mail addresses to their first letter and domain, and clips long texts', () => {
    expect(safeText('ask maria.rossi@example.test or b@example.test')).toBe('ask m***@example.test or b***@example.test')
    expect(safeText('x'.repeat(400))).toHaveLength(300)
    expect(safeText('x'.repeat(400)).endsWith('…')).toBe(true)
    expect(safeText('short', 3)).toBe('sh…')
  })
})

describe('claude-safe — values', () => {
  it('hides secret and personal keys at any depth, keeping the key; leaves the rest', () => {
    expect(safeValue({
      price: 19.9,
      refreshToken: 'anything',
      nested: { clientSecret: 'x', api_key: 'y', passwordHash: 'z', note: 'kept', list: [{ accessToken: 't', sku: 'TEST-SKU-1' }] },
      customerEmail: 'buyer@example.test',
      shippingAddress: { city: 'Milano' },
      phone: '+39 000',
      ip: '10.0.0.1',
      empty: null,
    })).toEqual({
      price: 19.9,
      refreshToken: HIDDEN,
      nested: { clientSecret: HIDDEN, api_key: HIDDEN, passwordHash: HIDDEN, note: 'kept', list: [{ accessToken: HIDDEN, sku: 'TEST-SKU-1' }] },
      customerEmail: HIDDEN,
      shippingAddress: HIDDEN,
      phone: HIDDEN,
      ip: HIDDEN,
      empty: null,
    })
  })

  it('cleans strings under ordinary keys too, and cuts big values down', () => {
    expect(safeValue({ message: 'token Atzr|abc123 for owner@example.test' })).toEqual({ message: `token ${HIDDEN} for o***@example.test` })
    const many = safeValue(Array.from({ length: 25 }, (_, i) => i)) as unknown[]
    expect(many).toHaveLength(21)
    expect(many.at(-1)).toBe('… 5 more')
    const wide = safeValue(Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`k${i}`, i]))) as Record<string, unknown>
    expect(Object.keys(wide)).toHaveLength(41)
    expect(wide['…']).toBe('5 more keys')
    let deep: unknown = 'bottom'
    for (let i = 0; i < 10; i++) deep = { down: deep }
    expect(JSON.stringify(safeValue(deep))).toContain('"…"')
    expect(safeValue(new Date('2026-09-15T10:00:00Z'))).toBe('2026-09-15T10:00:00.000Z')
    expect(safeValue(12n)).toBe(12)
  })
})

describe('claude-safe — people and lists', () => {
  it('names a person by display name, never by anything else', () => {
    expect(personName('Paola')).toBe('Paola')
    expect(personName('  ')).toBe('a team member')
    expect(personName(null)).toBe('a team member')
  })

  it('caps a list and says how many it left out', () => {
    expect(capped([1, 2, 3], 2)).toEqual({ items: [1, 2], more: 1 })
    expect(capped([1], 2)).toEqual({ items: [1], more: 0 })
  })
})
