import { describe, expect, it } from 'vitest'
import { emptyMapping } from '../schema-mapping.service.js'
import { expressionDraft, validateReviewMapping } from './review-draft.js'

describe('reviewed business-rule changes', () => {
  it('renames and edits atomically across field overlays and nested named dependencies', () => {
    const before = { ...emptyMapping(), expressions: { '20% margin': '$price * 0.8', outer: 'rule("20% margin") + 1' },
      fields: { price: { source: 'price', transforms: [{ type: 'expr' as const, ref: 'outer' }] } },
      byProductType: { COAT: { price: { source: 'price', transforms: [{ type: 'expr' as const, ref: '20% margin' }] } } } }
    const after = expressionDraft(before, { previousName: '20% margin', name: 'Net $ price', expr: '$price * 0.7' })
    expect(after.expressions).toEqual({ 'Net $ price': '$price * 0.7', outer: 'rule("Net $ price") + 1' })
    expect(after.byProductType?.COAT.price.transforms?.[0]).toEqual({ type: 'expr', ref: 'Net $ price' })
    expect(before.expressions['20% margin']).toBe('$price * 0.8')
  })
  it('refuses dangling references through other formulas, even with no catalog products', () => {
    expect(() => expressionDraft({ ...emptyMapping(), expressions: { inner: '1', outer: 'rule("inner")' } }, { name: 'inner', expr: null })).toThrow(/missing business rule/)
  })
  it('refuses cycles and competing names without altering the original mapping', () => {
    expect(() => validateReviewMapping({ ...emptyMapping(), expressions: { a: 'rule("b")', b: 'rule("a")' } })).toThrow(/circular/)
    expect(() => expressionDraft({ ...emptyMapping(), expressions: { a: '1', b: '2' } }, { previousName: 'a', name: 'b', expr: '3' })).toThrow(/already exists/)
  })
})

it('renames real calls with escaped names while preserving literal text and case-distinct names', () => {
  const from = 'A "quoted" price'
  const before = { ...emptyMapping(), expressions: { [from]: '1', lower: '2', Lower: '3',
    quoted: `rule(${JSON.stringify(from)}) + rule('lower')`, text: `'rule("lower")'`, upper: 'rule("Lower")' } }
  const renamed = expressionDraft(before, { previousName: from, name: 'New price', expr: '2' })
  expect(renamed.expressions?.quoted).toBe('rule("New price") + rule(\'lower\')')
  const next = expressionDraft(renamed, { previousName: 'lower', name: 'net', expr: '4' })
  expect(next.expressions?.text).toBe('\'rule("lower")\'')
  expect(next.expressions?.upper).toBe('rule("Lower")')
})
