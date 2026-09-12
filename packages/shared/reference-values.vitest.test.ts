import { describe, expect, it } from 'vitest'
import { isReferenceField, resolveReferenceValue } from './reference-values.js'

const choices = [{ id: 'active-id', name: 'Modern' }, { id: 'archived-id', name: 'Archived', active: false }]
describe('reference value identity', () => {
  it('accepts exact IDs and unique trimmed names, preserving ID case', () => {
    expect(resolveReferenceValue('descriptionThemeId', ' active-id ', choices)).toBe('active-id')
    expect(resolveReferenceValue('descriptionThemeId', ' modern ', choices)).toBe('active-id')
    expect(() => resolveReferenceValue('descriptionThemeId', 'ACTIVE-ID', choices)).toThrow('not an available choice')
  })
  it('rejects duplicate names, including active/inactive collisions, without choosing the first', () => {
    const duplicate = [...choices, { id: 'another', name: 'MODERN', active: false }]
    expect(() => resolveReferenceValue('descriptionThemeId', 'Modern', duplicate)).toThrow('more than one choice')
    expect(resolveReferenceValue('descriptionThemeId', 'active-id', duplicate)).toBe('active-id')
  })
  it('gives exact IDs precedence over an identical display name', () => {
    expect(resolveReferenceValue('descriptionThemeId', 'active-id', [...choices, { id: 'other', name: 'active-id' }])).toBe('active-id')
  })
  it('rejects inactive, deleted and unknown choices', () => {
    expect(() => resolveReferenceValue('descriptionThemeId', 'Archived', choices)).toThrow('inactive')
    expect(() => resolveReferenceValue('descriptionThemeId', 'deleted-id', choices)).toThrow('not an available choice')
  })
  it('keeps explicit clearing separate from text values and rejects structured or numeric IDs', () => {
    for (const value of [null, undefined, '', '  ']) expect(resolveReferenceValue('paymentPolicyId', value, [])).toBeNull()
    for (const value of [123, false, ['active-id'], {}]) expect(() => resolveReferenceValue('paymentPolicyId', value, choices)).toThrow('as text')
  })
  it('recognizes only the declared reference fields', () => {
    expect(isReferenceField('merchant_shipping_group')).toBe(true)
    for (const key of ['constructor', '__proto__', 'theme', 'description', 'completeness', 'productRole']) expect(isReferenceField(key)).toBe(false)
  })
})
