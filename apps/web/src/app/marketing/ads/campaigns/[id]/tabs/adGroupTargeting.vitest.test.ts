/**
 * CM-31 — the Create Ad Group modal shows the campaign's targeting type; it no longer offers a choice that wrote nothing.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adGroupTargetingWords } from './adGroupTargeting'

describe('adGroupTargetingWords', () => {
  it('a Sponsored Products campaign: its own type, said as the campaign\'s', () => {
    expect(adGroupTargetingWords({ adProduct: 'SPONSORED_PRODUCTS', targetingType: 'AUTO' }).value).toBe('Automatic targeting (set by the campaign)')
    expect(adGroupTargetingWords({ type: 'SP', targetingType: 'MANUAL' }).value).toBe('Manual targeting (set by the campaign)')
  })
  it('a type Amazon has not reported yet is not guessed', () => {
    const w = adGroupTargetingWords({ adProduct: 'SPONSORED_PRODUCTS', targetingType: null })
    expect(w.value).toBe('Set by the campaign')
    expect(w.hint).toContain('not told Nexus')
  })
  it('Sponsored Brands / Display: no Auto/Manual words', () => {
    expect(adGroupTargetingWords({ adProduct: 'SPONSORED_BRANDS', targetingType: 'MANUAL' }).value).toBe('Set by the campaign')
  })
})

describe('the modal', () => {
  const src = readFileSync(join(__dirname, 'CreateAdGroupModal.tsx'), 'utf8')
  it('offers no targeting choice and sends none', () => {
    expect(src).not.toMatch(/RadioCard/)
    expect(src).not.toMatch(/targetingType:/)
  })
  it('shows the campaign\'s type read-only', () => {
    expect(src).toMatch(/adGroupTargetingWords\(campaign\)/)
    expect(src).toMatch(/readOnly/)
  })
})
