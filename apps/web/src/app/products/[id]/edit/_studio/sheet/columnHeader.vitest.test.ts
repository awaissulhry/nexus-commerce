import { describe, expect, it } from 'vitest'
import { requiredOnlyFor, requirementSentence, sheetColumnHeader, type HeaderColumnLike } from './columnHeader'

/**
 * W3-6 — one column header for both sheet scopes: " *" when required, and a tooltip that names who requires it, the
 * cap and the help (the channel scopes showed the name and the help only).
 */
const col = (over: Partial<HeaderColumnLike> = {}): HeaderColumnLike => ({ label: 'Title', group: 'Content', requiredBy: [], ...over })

describe('sheetColumnHeader', () => {
  it('marks a required column and says who requires it, the cap and the help — the same on a channel scope', () => {
    expect(sheetColumnHeader(col({ requiredBy: ['eBay · IT'], maxLength: 80, helpText: 'The listing title.' }))).toEqual({
      headerName: 'Title *',
      headerTooltip: 'Required by eBay · IT · Max 80 characters · The listing title.',
    })
  })

  it('names the cap\'s source on the Shared scope, where several channels set caps', () => {
    expect(sheetColumnHeader(col({ requiredBy: ['Master'], maxLength: 80, capFrom: 'eBay · IT', maxBytes: 200 }), { capSource: true }).headerTooltip)
      .toBe('Required by the Shared product · Max 80 characters (eBay · IT) · Max 200 bytes')
    expect(sheetColumnHeader(col({ maxLength: 80, capFrom: 'eBay · IT' })).headerTooltip).toBe('Max 80 characters')
  })

  it('never says "Master": the Shared product, or the product family when a family rule requires it', () => {
    expect(requirementSentence(col({ requiredBy: ['Master'] }))).toBe('Required by the Shared product')
    expect(requirementSentence(col({ requiredBy: ['Master', 'Amazon · IT'], familyRules: { fam: { required: true, sortOrder: 1 } } })))
      .toBe('Required by the product family, Amazon · IT')
  })

  it('keeps the "*" for a column one product type of a mixed family requires, and names the type (Owner decision 13)', () => {
    const coat = col({ requiredBy: ['Amazon · IT'], applicableProductTypes: ['COAT', 'PANTS'], requiredForProductTypes: ['COAT'] })
    expect(sheetColumnHeader(coat)).toEqual({ headerName: 'Title *', headerTooltip: 'Required by Amazon · IT (COAT only)' })
    // Required for every type it applies to: no qualifier.
    expect(requiredOnlyFor(col({ applicableProductTypes: ['COAT'], requiredForProductTypes: ['COAT'] }))).toBeNull()
    // Applies to every type (an eBay or master field) but required for one: qualified.
    expect(requiredOnlyFor(col({ requiredForProductTypes: ['COAT'] }))).toEqual(['COAT'])
  })

  it('an optional column has no mark; its tooltip is the help, else the caller\'s fallback', () => {
    expect(sheetColumnHeader(col({ helpText: 'Help.' }))).toEqual({ headerName: 'Title', headerTooltip: 'Help.' })
    expect(sheetColumnHeader(col(), { fallbackTooltip: 'Title — Content' })).toEqual({ headerName: 'Title', headerTooltip: 'Title — Content' })
    expect(sheetColumnHeader(col()).headerTooltip).toBeUndefined()
  })
})
