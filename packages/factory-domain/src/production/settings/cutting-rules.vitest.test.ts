import { describe, expect, it } from 'vitest'
import { changedCuttingFields, changedCuttingRules, cuttingRulesChangeProblems, cuttingRulesOf, cuttingRulesWords, DEFAULT_CUTTING_RULES } from './cutting-rules'

describe('a site\'s cutting rules (B-W2b-219)', () => {
  it('reads a row, else the defaults (ORDER, photo optional, 10 dm²); an unknown value falls back', () => {
    expect(cuttingRulesOf(null)).toEqual(DEFAULT_CUTTING_RULES)
    expect(DEFAULT_CUTTING_RULES).toEqual({ shadeRule: 'ORDER', hidePhotoRequired: false, minimumRemnant: { area: '10.0000', uom: 'DM2' } })
    expect(cuttingRulesOf({ shadeRule: 'GARMENT', hidePhotoRequired: true, minimumRemnantArea: '0.25', minimumRemnantUom: 'M2' })).toEqual({ shadeRule: 'GARMENT', hidePhotoRequired: true, minimumRemnant: { area: '0.2500', uom: 'M2' } })
    expect(cuttingRulesOf({ shadeRule: 'LOT', minimumRemnantArea: '3', minimumRemnantUom: 'PCS' })).toEqual(DEFAULT_CUTTING_RULES)
  })

  it('checks a change: the rule, the switch, the minimum with its unit (above 0, at most 10 m²), the reason', () => {
    expect(cuttingRulesChangeProblems({ shadeRule: 'OFF', hidePhotoRequired: true, minimumRemnantArea: '107.6', minimumRemnantUom: 'FT2' })).toEqual([])
    expect(cuttingRulesChangeProblems({ shadeRule: 'LOT' }).map((problem) => problem.path)).toEqual(['body/shadeRule'])
    expect(cuttingRulesChangeProblems({ minimumRemnantArea: '5' }).map((problem) => problem.path)).toEqual(['body/minimumRemnantUom'])
    expect(cuttingRulesChangeProblems({ minimumRemnantArea: '0', minimumRemnantUom: 'DM2' }).map((problem) => problem.path)).toEqual(['body/minimumRemnantArea'])
    expect(cuttingRulesChangeProblems({ minimumRemnantArea: '1001', minimumRemnantUom: 'DM2' })[0]!.message).toContain('at most 10 m²')
    expect(cuttingRulesChangeProblems({ minimumRemnantArea: '1.23456', minimumRemnantUom: 'M2' })).toHaveLength(1)
    expect(cuttingRulesChangeProblems({ minimumRemnantArea: '1', minimumRemnantUom: 'PCS' }).map((problem) => problem.path)).toEqual(['body/minimumRemnantUom'])
    expect(cuttingRulesChangeProblems({ reason: 'x'.repeat(501) }).map((problem) => problem.path)).toEqual(['body/reason'])
  })

  it('applies a change field by field; the same unit and area again is no change', () => {
    const after = changedCuttingRules(DEFAULT_CUTTING_RULES, { hidePhotoRequired: true, minimumRemnantArea: '0.1', minimumRemnantUom: 'M2' })
    expect(after).toEqual({ shadeRule: 'ORDER', hidePhotoRequired: true, minimumRemnant: { area: '0.1000', uom: 'M2' } })
    expect(changedCuttingFields(DEFAULT_CUTTING_RULES, after)).toEqual(['hidePhotoRequired', 'minimumRemnant'])
    expect(changedCuttingFields(DEFAULT_CUTTING_RULES, changedCuttingRules(DEFAULT_CUTTING_RULES, { minimumRemnantArea: '10', minimumRemnantUom: 'DM2' }))).toEqual([])
    expect(cuttingRulesWords(after)).toEqual(['Shade: one shade lot per order: the reserve and the pick refuse a hide of another shade lot, the cutting table warns.', 'A photo of the hide on the table is taken before every first cut of a hide.', 'A leftover smaller than 0.10 m² is waste, not a remnant.'])
  })
})
