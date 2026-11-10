import { describe, expect, it } from 'vitest'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { packagingRulesOf } from '../../compliance/label-artwork/rules'
import { createSetBody, updateSetBody } from './contracts'
import { PRODUCT_BRANDING_MANAGE } from './permissions'
import { idListProblems, isDrawnPicture, normaliseQuantity, normaliseRuleKey, normaliseSetCode, packagingRuleProblems, quantityOk, setProblems, storedRule, unknownFiles } from './rules'

const ITEM = '0190f0e2-1111-7000-8000-000000000010'

describe('the branding sets (B-W2b-247, PRD-045)', () => {
  it('stores a packaging rule as typed, in the shape B-W2b-259 reads back', () => {
    const rules = [storedRule({ key: 'Hang Tag', text: ' Brand hang tag on the zip puller ' }), storedRule({ key: 'polybag', text: 'One per polybag', itemId: ITEM, quantity: '1,5', per: 'GARMENT' })]
    expect(rules).toEqual([
      { key: 'hang-tag', text: 'Brand hang tag on the zip puller' },
      { key: 'polybag', text: 'One per polybag', itemId: ITEM, quantity: '1.5', per: 'GARMENT' },
    ])
    expect(packagingRuleProblems(rules)).toEqual([])
    expect(packagingRulesOf(rules)).toEqual([
      { key: 'hang-tag', text: 'Brand hang tag on the zip puller', itemId: null, quantity: null, per: null },
      { key: 'polybag', text: 'One per polybag', itemId: ITEM, quantity: '1.5', per: 'GARMENT' },
    ])
    expect(normaliseRuleKey(' Brand_Label ')).toBe('brand-label')
    expect(normaliseQuantity(' ')).toBeNull()
  })

  it("says the database's factory_packaging_rules_problem first, per rule and field", () => {
    const problems = packagingRuleProblems([
      { key: 'polybag', text: 'x' },
      { key: 'polybag', text: 'y' },
      { key: '-bad', text: '' },
      { key: 'box', text: 'z', itemId: ITEM },
      { key: 'zero', text: 'z', itemId: ITEM, quantity: '0', per: 'PACK' },
    ])
    expect(problems.map((issue) => issue.path)).toEqual(['body/packagingRules/1/key', 'body/packagingRules/2/key', 'body/packagingRules/2/text', 'body/packagingRules/3/quantity', 'body/packagingRules/4/quantity'])
    expect(quantityOk('0.0001')).toBe(true)
    expect(quantityOk('123456789')).toBe(false)
    expect(packagingRuleProblems(Array.from({ length: 51 }, (_, index) => ({ key: `r${index}`, text: 't' })))[0]?.path).toBe('body/packagingRules')
  })

  it("checks a set's code, name, note and lists; a file list may only be reordered or shortened", () => {
    expect(normaliseSetCode(' bs-p1-2027 ')).toBe('BS-P1-2027')
    expect(setProblems({ code: 'BS P1', name: '', note: ' ' }).map((issue) => issue.path)).toEqual(['body/code', 'body/name', 'body/note'])
    expect(setProblems({ code: 'BS-P1', name: 'P1 2027', note: null })).toEqual([])
    expect(idListProblems([ITEM, ITEM], 'body/brandColourIds', 30)).toEqual([{ path: 'body/brandColourIds', message: 'Each is named once.' }])
    expect(unknownFiles(['a', 'c'], ['a', 'b'])).toEqual(['c'])
    expect(isDrawnPicture('image/png')).toBe(true)
    expect(isDrawnPicture('image/svg+xml')).toBe(false)
    expect(isDrawnPicture('application/pdf')).toBe(false)
  })

  it('reads the bodies: a new set may replace the brand’s set in use; a change goes at its version', () => {
    expect(createSetBody.safeParse({ companyId: ITEM, partyId: ITEM, code: 'BS-1', name: 'One', replace: true, packagingRules: [{ key: 'polybag', text: 'x', itemId: ITEM, quantity: '1', per: 'CARTON' }] }).success).toBe(true)
    expect(createSetBody.safeParse({ companyId: ITEM, partyId: ITEM, code: 'BS-1', name: 'One', packagingRules: [{ key: 'polybag', text: 'x', per: 'BOX' }] }).success).toBe(false)
    expect(updateSetBody.safeParse({ name: 'x' }).success).toBe(false)
    expect(updateSetBody.safeParse({ version: 2, logoFileIds: [] }).success).toBe(true)
  })

  it('declares product.branding.manage for sales and the production manager, and branding_set.changed', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(PRODUCT_BRANDING_MANAGE)).toBe(true)
    const holders = ROLE_TEMPLATES.filter((role) => (role.permissions as readonly string[]).includes(PRODUCT_BRANDING_MANAGE)).map((role) => role.key)
    expect(holders).toEqual(expect.arrayContaining(['sales', 'production_manager']))
    expect(EVENT_CATALOGUE.get('branding_set.changed', 1).live?.fields).toEqual(['brandingSetId', 'partyId', 'code', 'change', 'fields'])
  })
})
