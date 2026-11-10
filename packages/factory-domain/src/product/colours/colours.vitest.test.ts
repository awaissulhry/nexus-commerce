import { describe, expect, it } from 'vitest'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { colourLibraryQuery, createColourBody } from './contracts'
import { PRODUCT_COLOURS_MANAGE } from './permissions'
import { colourProblems, isUnused, normaliseColour, normaliseFamily, normaliseHex, normaliseReference, noticeKey, noticesOf, shownNotices, statusRefusal } from './rules'

describe('the colour library (B-W2b-247, PRD-041)', () => {
  it('reads a hex, a reference and a family as typed', () => {
    expect(normaliseHex('#1a1a1a')).toBe('#1A1A1A')
    expect(normaliseHex('abc')).toBe('#AABBCC')
    expect(normaliseHex('  ')).toBeNull()
    expect(normaliseHex(null)).toBeNull()
    expect(normaliseHex('#12345')).toBeUndefined()
    expect(normaliseHex('red')).toBeUndefined()
    expect(normaliseReference('RAL', '9005')).toBe('RAL 9005')
    expect(normaliseReference('RAL', 'ral 9005')).toBe('RAL 9005')
    expect(normaliseReference('NCS', 's 9000-n')).toBe('S 9000-N')
    expect(normaliseReference('PANTONE', 'Pantone 18-1662 tcx')).toBe('18-1662 TCX')
    expect(normaliseReference('OWN', '  NX  BLU ')).toBe('NX BLU')
    expect(normaliseReference(null, '')).toBeNull()
    expect(normaliseFamily(' Dark  Blue ')).toBe('dark blue')
    expect(normaliseFamily('')).toBeNull()
  })

  it("says the database's Colour_system_check first, per field", () => {
    const ok = normaliseColour({ code: ' nx-blk ', name: 'Nero', names: { it: 'Nero', en: ' Black ' }, system: 'RAL', reference: '9005', family: 'Black', hex: '111' })
    expect(ok).toEqual({ code: 'NX-BLK', name: 'Nero', names: { it: 'Nero', en: 'Black' }, system: 'RAL', reference: 'RAL 9005', family: 'black', hex: '#111111' })
    expect(colourProblems(ok)).toEqual([])
    expect(colourProblems(normaliseColour({ code: 'NX-1', name: 'X', reference: '123' })).map((issue) => issue.path)).toEqual(['body/reference'])
    expect(colourProblems(normaliseColour({ code: 'NX-1', name: 'X', system: 'PANTONE' }))).toEqual([{ path: 'body/reference', message: 'A PANTONE colour needs its PANTONE reference (for example 19-4052 TCX).' }])
    expect(colourProblems(normaliseColour({ code: 'NX-1', name: 'X', system: 'OWN' }))).toEqual([])
    expect(colourProblems(normaliseColour({ code: 'nx 1', name: '', hex: 'zz', family: 'x'.repeat(41) })).map((issue) => issue.path)).toEqual(['body/code', 'body/name', 'body/hex', 'body/family'])
    expect(colourProblems(normaliseColour({ code: 'NX-1', name: 'X', names: { en: 'a\tb' } }), '').map((issue) => issue.path)).toEqual(['names/en'])
  })

  it('archives a colour in use (what names it keeps it) and refuses only a move to where it is', () => {
    expect(statusRefusal('ACTIVE', 'ARCHIVED', 'NX-1')).toBeNull()
    expect(statusRefusal('ARCHIVED', 'ARCHIVED', 'NX-1')).toBe('Colour NX-1 is archived already.')
    expect(statusRefusal('ACTIVE', 'ACTIVE', 'NX-1')).toBe('Colour NX-1 is in use already.')
    expect(isUnused({ inUse: false })).toBe(true)
    expect(isUnused({ inUse: true })).toBe(false)
  })

  it('orders the notices, the most serious first, and keeps a dismissal by value', () => {
    const notices = noticesOf({ ignored: ['system=XYZ'], brandsWithoutSet: 2, noHex: 3 })
    expect(notices.map((notice) => notice.kind)).toEqual(['IGNORED_FILTER', 'BRANDS_WITHOUT_SET', 'NO_HEX'])
    expect(noticesOf({ ignored: [], brandsWithoutSet: 0, noHex: 0 })).toEqual([])
    const dismissed = new Set([noticeKey(notices[2]!)])
    expect(shownNotices(notices, dismissed).map((notice) => notice.kind)).toEqual(['IGNORED_FILTER', 'BRANDS_WITHOUT_SET'])
    // A new value of the same fact shows again.
    expect(shownNotices(noticesOf({ ignored: [], brandsWithoutSet: 0, noHex: 4 }), dismissed).map((notice) => notice.value)).toEqual(['4'])
  })

  it('reads the list address: a view, pages of 50, an unknown system kept for the API to name', () => {
    expect(colourLibraryQuery.parse({})).toEqual({ view: 'active', limit: 50 })
    expect(colourLibraryQuery.parse({ view: 'unused', system: 'XYZ', limit: '100' })).toEqual({ view: 'unused', system: 'XYZ', limit: 100 })
    expect(() => colourLibraryQuery.parse({ view: 'gone' })).toThrow()
    expect(createColourBody.safeParse({ companyId: null, code: 'NX-1', name: 'X', system: 'PANTONE' }).success).toBe(true)
    expect(createColourBody.safeParse({ code: 'NX-1', name: 'X' }).success).toBe(false)
  })

  it('declares product.colours.manage for the production manager and the colour.changed event', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(PRODUCT_COLOURS_MANAGE)).toBe(true)
    const holders = ROLE_TEMPLATES.filter((role) => (role.permissions as readonly string[]).includes(PRODUCT_COLOURS_MANAGE)).map((role) => role.key)
    expect(holders).toContain('production_manager')
    expect(holders).not.toContain('sales')
    expect(EVENT_CATALOGUE.get('colour.changed', 1).live?.permission).toBe('product.styles.view')
  })
})
