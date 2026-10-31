import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DocumentSeal } from './DocumentSeal'
import { normalizeSha256, sealGroups, sealMatches, sealShort, sealSigned, sha256Hex } from './documentSealModel'

/** B-W2b-28 — DocumentSeal: a frozen document's proof, verified on the device. Made-up document. */
// SHA-256 of the ASCII bytes "abc" (FIPS 180-2 test vector).
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

describe('the fingerprint', () => {
  it('computes SHA-256 on the device (Web Crypto)', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(ABC)
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer)).toBe(ABC)
  })
  it('compares without case, spaces or colons; a malformed fingerprint never matches', () => {
    expect(normalizeSha256(ABC.toUpperCase())).toBe(ABC)
    expect(sealMatches(sealGroups(ABC), ABC.toUpperCase())).toBe(true)
    expect(sealMatches(ABC, ABC.replace(/a$/, 'b').replace(/d$/, 'e'))).toBe(false)
    expect(sealMatches('not-a-hash', 'not-a-hash')).toBe(false)
    expect(normalizeSha256('abc')).toBeNull()
  })
  it('shows it short and whole in groups of 8', () => {
    expect(sealShort(ABC)).toBe('ba7816bf…f20015ad')
    expect(sealGroups(ABC).split(' ')).toHaveLength(8)
  })
  it('counts the signers who signed', () => {
    expect(sealSigned([{ signedAt: '3 Nov' }, { signedAt: null }, {}])).toEqual({ signed: 1, total: 3 })
  })
})

describe('DocumentSeal', () => {
  it('shows version, the whole fingerprint, when and by which clock, and the signers with dates or waiting', () => {
    const html = render(
      h(DocumentSeal, {
        title: 'LUL calendar · October 2026',
        version: 'v1',
        sha256: ABC,
        sealedAt: '1 Nov 2026, 18:02',
        timestampSource: 'Nexus server clock',
        sealedBy: 'Demo Person',
        signers: [
          { id: 'e', name: 'Demo Employer', role: 'Employer', signedAt: '2 Nov 2026' },
          { id: 'r', name: 'Demo RSPP', role: 'RSPP' },
        ],
      }),
    )
    for (const word of ['Version v1', sealGroups(ABC), '1 Nov 2026, 18:02', 'Nexus server clock', 'Demo Person', 'Signatures · 1 of 2 signed', 'Signed 2 Nov 2026', 'Waiting to sign', 'Verify a file', 'The file stays on this device']) expect(html).toContain(word)
    expect(html).toContain('role="status"')
  })
  it('without verify there is no file picker; the host’s language reaches the words', () => {
    const html = render(h(DocumentSeal, { version: 'v2', sha256: ABC, sealedAt: 'x', timestampSource: 'y', verify: false, labels: { version: 'Versione' } }))
    expect(html).not.toContain('type="file"')
    expect(html).toContain('Versione v2')
  })
})
