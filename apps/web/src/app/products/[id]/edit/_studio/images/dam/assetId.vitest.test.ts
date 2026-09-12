/**
 * PES.7 — pins the prefix rule that the shipped picker gets wrong.
 * Proven against prod: the prefixed id 404s, the stripped id creates.
 */
import { describe, expect, it } from 'vitest'

import { assetSource, importableAssetId } from './assetId'

describe('importableAssetId', () => {
  it('strips the da_ prefix the library adds — the whole point of this module', () => {
    // Verified end to end on prod: this exact shape 404s prefixed, 201s stripped.
    expect(importableAssetId('da_cmpgeliy00apfs4410sev0dm4')).toBe('cmpgeliy00apfs4410sev0dm4')
  })

  it('refuses a product_image row rather than sending an id that will 404', () => {
    expect(importableAssetId('pi_cms41esfw02btmz01g3xj7bgy')).toBeNull()
  })

  it('refuses an unprefixed id rather than guessing it is already raw', () => {
    // A bare id might be either table's; guessing would post something that cannot be checked.
    expect(importableAssetId('cmpgeliy00apfs4410sev0dm4')).toBeNull()
  })

  it('strips only the leading prefix, never an occurrence inside the id', () => {
    expect(importableAssetId('da_xda_y')).toBe('xda_y')
  })
})

describe('assetSource', () => {
  it('names the table each prefix came from', () => {
    expect(assetSource('da_abc')).toBe('digital_asset')
    expect(assetSource('pi_abc')).toBe('product_image')
    expect(assetSource('abc')).toBeNull()
  })
})
