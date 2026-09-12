import { describe, expect, it } from 'vitest'
import { applyPresentationOrder, effectivePresentationRule, resolvePresentationOrder, validatePresentationRule, type PresentationRule } from './presentation-rules.js'

const context = { accountId: 'account-a', familyId: 'clothing', sharedCategoryIds: ['outerwear', 'sale'], marketplaceCategoryId: '123' }
const rule = (patch: Partial<PresentationRule> = {}): PresentationRule => ({ id: 'rule-1', name: 'Outerwear', version: 1, priority: 10, scope: {}, themeId: 'theme-1', ...patch })
describe('presentation rule scopes and precedence', () => {
  it('resolves account, shared family, shared taxonomy and marketplace category as separate matching dimensions', () => {
    const rules = [rule(), rule({ id: 'account', priority: 20, scope: { accountId: 'account-a', familyId: 'clothing', sharedCategoryId: 'sale', marketplaceCategoryId: '123' }, themeId: 'theme-2' })]
    expect(effectivePresentationRule(rules, context, 'themeId').value).toBe('theme-2')
    expect(effectivePresentationRule(rules, { ...context, accountId: 'account-b' }, 'themeId').value).toBe('theme-1')
    expect(effectivePresentationRule(rules, { ...context, marketplaceCategoryId: 'sale' }, 'themeId').value).toBe('theme-1')
    expect(effectivePresentationRule(rules, { ...context, familyId: 'newly-eligible' }, 'themeId').value).toBe('theme-1')
  })
  it('reports competing equal-priority category rules consistently for future eligible products', () => {
    const a = rule({ scope: { sharedCategoryId: 'outerwear' } })
    const b = rule({ id: 'rule-2', name: 'Sale', scope: { sharedCategoryId: 'sale' }, themeId: 'theme-2' })
    const answer = effectivePresentationRule([b, a], context, 'themeId')
    expect(answer.value).toBeUndefined(); expect(answer.conflicts).toHaveLength(2)
    expect(effectivePresentationRule([a, b], context, 'themeId')).toEqual(answer)
  })
  it('preserves per-axis listing customizations independently of the theme and remaining inherited order', () => {
    const rules = [rule({ order: { axes: ['Size', 'Color'], values: { __dim1__: ['XL', 'S'], Color: ['Black', 'Red'] } } })]
    const result = resolvePresentationOrder(rules, context, { descriptionThemeId: 'custom', _axisValueOrder: { Size: ['S', 'XL'] } })
    expect(result.value.values.__dim1__).toEqual(['S', 'XL'])
    expect(result.value.values.__dim0__).toEqual(['Black', 'Red'])
    expect(result.explicitValues).toEqual(['__dim1__'])
    const axes = applyPresentationOrder([{ name: 'Color', key: '__dim0__', values: ['Red', 'Black'] }, { name: 'Size', key: '__dim1__', values: ['XL', 'M', 'S'] }], result.value)
    expect(axes.map(a => a.name)).toEqual(['Size', 'Color'])
    expect(axes[0].values).toEqual(['S', 'XL', 'M'])
  })
  it('refuses unsupported dimensions and duplicate synonym axes', () => {
    expect(validatePresentationRule(rule({ scope: { locale: 'it' } as never }))).toContain('Unsupported or empty matching dimension: locale')
    expect(validatePresentationRule(rule({ order: { axes: ['Size', 'Taglia'], values: {} } }))).toContain('Choose at most five distinct variation axes')
  })
})

describe('independent order property precedence', () => {
  const base = rule({ order: { axes: ['Size', 'Color'], values: { Size: ['S', 'XL'], Color: ['Red', 'Black'] } } })
  it('an axis customization suppresses only its own conflict; per-axis overrides independently suppress theirs', () => {
    const other = rule({ id: 'other', order: { axes: ['Color', 'Size'], values: { Size: ['XL', 'S'], Color: ['Red', 'Black'] } } })
    expect(resolvePresentationOrder([base, other], context, {}).conflicts).toHaveLength(2)
    const axesOnly = resolvePresentationOrder([base, other], context, { _variationAxes: ['Size', 'Color'] })
    expect(axesOnly.conflicts).toHaveLength(1)
    expect(resolvePresentationOrder([base, other], context, { _variationAxes: ['Size', 'Color'], _axisValueOrder: { Taglia: ['S', 'XL'] } }).conflicts).toEqual([])
  })
  it('a more specific value-only rule keeps independently inherited axis and other value orders', () => {
    const result = resolvePresentationOrder([base, rule({ id: 'size', priority: 20, order: { axes: [], values: { Taglia: ['XL', 'S'] } } })], context, {})
    expect(result.value).toEqual({ axes: ['Size', 'Color'], values: { __dim0__: ['Red', 'Black'], __dim1__: ['XL', 'S'] } })
  })
  it('merges legacy dimensions while canonical empty values deliberately restore domain order', () => {
    const result = resolvePresentationOrder([base], context, { _axisSortOrder: { Color: ['Black', 'Red'], Size: ['S', 'XL'] }, _axisValueOrder: { Taglia: [] } })
    expect(result.value.values).toEqual({ __dim0__: ['Black', 'Red'], __dim1__: [] })
    expect(applyPresentationOrder([{ name: 'Size', key: '__dim1__', values: ['XL', 'M', 'S'] }], result.value)[0].values).toEqual(['S', 'M', 'XL'])
  })
})
