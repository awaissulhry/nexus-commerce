/**
 * FL.1.4 — Unit tests for the manifest parentage reader. No DB — pure functions.
 *
 * P8 (docs/attributes/PLAN.md §10.8) deleted `resolveFieldValue` and its tests: it had no production caller (the
 * FL.2 loader it waited for was never written), and `resolveBatch` is the one answer to "what is this value".
 */

import { describe, it, expect } from 'vitest'
import {
  parentageFromTags,
  parentageFromEbayAspect,
} from '../field-resolution/parentage.js'

describe('parentageFromTags', () => {
  it('child-only → CHILD (price/qty)', () => {
    expect(parentageFromTags(['VARIATION_CHILD', 'STANDALONE'])).toBe('CHILD')
  })
  it('parent-applicable → PARENT (title/bullets)', () => {
    expect(parentageFromTags(['VARIATION_PARENT'])).toBe('PARENT')
  })
  it('both parent + child → PARENT (variants inherit)', () => {
    expect(parentageFromTags(['VARIATION_PARENT', 'VARIATION_CHILD'])).toBe('PARENT')
  })
  it('standalone-only → PARENT', () => {
    expect(parentageFromTags(['STANDALONE'])).toBe('PARENT')
  })
  it('untagged / empty → PARENT (safe inherit default)', () => {
    expect(parentageFromTags(undefined)).toBe('PARENT')
    expect(parentageFromTags([])).toBe('PARENT')
  })
})

describe('parentageFromEbayAspect', () => {
  it('variant-defining aspect → CHILD; others → PARENT', () => {
    expect(parentageFromEbayAspect(true)).toBe('CHILD')
    expect(parentageFromEbayAspect(false)).toBe('PARENT')
  })
})
