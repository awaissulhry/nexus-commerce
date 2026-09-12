import { expect, it } from 'vitest'
import { changedVariationSelection, effectiveVariationTheme } from './variation-selection'
it.each(['', null, false, 0])('does not replace the explicit channel theme %j with a common theme', value => {
  expect(effectiveVariationTheme({ 'AMAZON:IT': value }, 'COLOR_NAME', 'AMAZON:IT')).toEqual(value)
  expect(effectiveVariationTheme({}, 'COLOR_NAME', 'AMAZON:IT')).toBe('COLOR_NAME')
})
it('does not turn rendered defaults into edits when entering or resuming the step', () => {
  const original = { commonTheme: false, includedSkus: null, customAttributesByChannel: { 'AMAZON:FR': [] } }
  const initial = { commonTheme: false, includedSkus: [], themeByChannel: {}, customAttributesByChannel: original.customAttributesByChannel }
  expect(changedVariationSelection(original, initial, initial)).toEqual(original)
  expect(changedVariationSelection(original, initial, { ...initial, themeByChannel: { 'AMAZON:IT': 'SIZE_NAME' } })).toEqual({ ...original, themeByChannel: { 'AMAZON:IT': 'SIZE_NAME' } })
})
it('preserves explicit empty variant selection and unrelated saved variation settings', () => {
  const original = { includedSkus: [], customState: { enabled: false } }
  const initial = { includedSkus: [], commonTheme: null }
  expect(changedVariationSelection(original, initial, { ...initial, commonTheme: 'SIZE_NAME' })).toEqual({ ...original, commonTheme: 'SIZE_NAME' })
})
