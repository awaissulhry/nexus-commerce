import { describe, expect, it } from 'vitest'
import { designerMayWrite, DRAFT_EDIT_REFUSAL_CODES, DRAFT_EDIT_REFUSALS } from './refusals'

/** owb-pd1 1.4: the designer writes a draft only (S4 settle 6). */
describe("the designer's right on a product draft", () => {
  it('writes a DRAFT revision, or a product with no revision yet; never a released or obsolete one', () => {
    expect(designerMayWrite('DRAFT')).toBe(true)
    expect(designerMayWrite(null)).toBe(true)
    expect(designerMayWrite('RELEASED')).toBe(false)
    expect(designerMayWrite('OBSOLETE')).toBe(false)
  })

  it('has English and Italian words for every refusal', () => {
    for (const code of DRAFT_EDIT_REFUSAL_CODES) {
      expect(DRAFT_EDIT_REFUSALS[code].en.length, code).toBeGreaterThan(0)
      expect(DRAFT_EDIT_REFUSALS[code].it.length, code).toBeGreaterThan(0)
    }
  })
})
