import { describe, expect, it } from 'vitest'
import {
  alterationsOf,
  baseSizeRuleProblems,
  checkRules,
  consumptionOf,
  inUnit,
  limitsProblems,
  mtmCheck,
  rulesProblems,
  sameRule,
  styleFindings,
  suggestBaseSize,
  type ConsumptionLine,
  type MtmCheckInput,
  type RuleFields,
  type SizeFacts,
  type TemplatePoint,
} from './rules'

/** Made-to-measure rules (B-W2b-248; PRD-017, PRD-201 … PRD-204), pure. Every code and number is made up. */

const point = (code: string, extra: Partial<TemplatePoint> = {}): TemplatePoint => ({ id: `p-${code}`, code, name: code[0]!.toUpperCase() + code.slice(1), uom: 'CM', status: 'ACTIVE', alterationMinus: null, alterationPlus: null, ...extra })
const POINTS: TemplatePoint[] = [point('chest', { alterationMinus: '4', alterationPlus: '6' }), point('waist', { alterationMinus: '4', alterationPlus: '8' }), point('outseam'), point('inseam')]
const words = { it: 'Controlla', en: 'Check it' }
const rule = (fields: Partial<RuleFields> & Pick<RuleFields, 'code' | 'kind' | 'pointCode'>): RuleFields => ({
  otherPointCode: null,
  minFactor: null,
  maxFactor: null,
  minValue: null,
  maxValue: null,
  severity: 'BLOCK',
  messageI18n: words,
  status: 'ACTIVE',
  ...fields,
})
const RULES: RuleFields[] = [
  rule({ code: 'INSEAM_LE_OUTSEAM', kind: 'ORDER', pointCode: 'inseam', otherPointCode: 'outseam', messageI18n: { it: "L'interno gamba supera l'esterno", en: 'The inseam is longer than the outseam' } }),
  rule({ code: 'WAIST_TO_CHEST', kind: 'RATIO', pointCode: 'waist', otherPointCode: 'chest', minFactor: '0.6', maxFactor: '1.15', severity: 'WARN' }),
  rule({ code: 'CHEST_RANGE', kind: 'RANGE', pointCode: 'chest', minValue: '88', maxValue: '116' }),
]
const cm = (value: string) => ({ value, unit: 'cm' })
const SIZES: SizeFacts[] = [
  { code: '50', seq: 2, bodyMeasures: { chest: { min: '96', max: '100', unit: 'cm' }, height: { min: '170', max: '176', unit: 'cm' } } },
  { code: '52', seq: 3, bodyMeasures: { chest: { min: '100', max: '104', unit: 'cm' }, height: { min: '176', max: '182', unit: 'cm' } } },
  { code: '54', seq: 4, bodyMeasures: { chest: { min: '104', max: '108', unit: 'cm' }, height: { min: '182', max: '188', unit: 'cm' } } },
]

describe('saving a template’s rules (the database’s rules said first)', () => {
  it('accepts the three kinds and refuses each broken shape in words', () => {
    expect(rulesProblems(RULES, POINTS)).toEqual([])
    const broken = rulesProblems(
      [
        rule({ code: 'has space', kind: 'RANGE', pointCode: 'chest', minValue: '1' }),
        rule({ code: 'TWICE', kind: 'ORDER', pointCode: 'inseam' }),
        rule({ code: 'TWICE', kind: 'RATIO', pointCode: 'waist', otherPointCode: 'waist', minFactor: '1' }),
        rule({ code: 'NO_BOUND', kind: 'RATIO', pointCode: 'waist', otherPointCode: 'chest' }),
        rule({ code: 'UPSIDE', kind: 'RANGE', pointCode: 'chest', minValue: '120', maxValue: '100' }),
        rule({ code: 'MIXED', kind: 'RANGE', pointCode: 'chest', otherPointCode: 'waist', minFactor: '1', minValue: '1' }),
        rule({ code: 'GHOST', kind: 'RANGE', pointCode: 'neck', minValue: '1', messageI18n: {} }),
        rule({ code: 'ZERO', kind: 'RATIO', pointCode: 'waist', otherPointCode: 'chest', minFactor: '0' }),
      ],
      POINTS,
    ).map((found) => found.path)
    expect(broken).toEqual([
      'rules/0/code',
      'rules/1/otherPointCode',
      'rules/2/code',
      'rules/2/otherPointCode',
      'rules/3/minFactor',
      'rules/4/maxValue',
      'rules/5/otherPointCode',
      'rules/5/minFactor',
      'rules/6/messageI18n',
      'rules/6/pointCode',
      'rules/7/minFactor',
    ])
  })

  it('an ORDER rule compares points of one unit; an archived point only on an archived rule', () => {
    const mixed = [...POINTS, point('reach', { uom: 'MM' })]
    expect(rulesProblems([rule({ code: 'R', kind: 'ORDER', pointCode: 'inseam', otherPointCode: 'reach' })], mixed)[0]?.message).toMatch(/one unit/)
    const archived = [...POINTS, point('old', { status: 'ARCHIVED' })]
    expect(rulesProblems([rule({ code: 'R', kind: 'RANGE', pointCode: 'old', maxValue: '9' })], archived)[0]?.message).toMatch(/archived/)
    expect(rulesProblems([rule({ code: 'R', kind: 'RANGE', pointCode: 'old', maxValue: '9', status: 'ARCHIVED' })], archived)).toEqual([])
  })

  it('the base size rule names 1 to 10 points of the template once; limits are 0 or more', () => {
    expect(baseSizeRuleProblems({ points: ['chest'], tie: 'LARGER' }, POINTS)).toEqual([])
    expect(baseSizeRuleProblems({ points: ['chest', 'chest', 'neck'], tie: 'LARGER' }, POINTS).map((found) => found.path)).toEqual(['baseSizeRule/points/1', 'baseSizeRule/points/2'])
    expect(baseSizeRuleProblems({ points: [], tie: 'LARGER' }, POINTS).map((found) => found.path)).toEqual(['baseSizeRule/points'])
    expect(limitsProblems([{ code: 'chest', tolerance: '1', alterationMinus: '4', alterationPlus: '6.5' }], POINTS)).toEqual([])
    expect(limitsProblems([{ code: 'chest', tolerance: '-1', alterationMinus: '4.123', alterationPlus: null }, { code: 'neck', tolerance: null, alterationMinus: null, alterationPlus: null }], POINTS).map((found) => found.path)).toEqual([
      'points/0/tolerance',
      'points/0/alterationMinus',
      'points/1/code',
    ])
  })

  it('a rule with the same words in another order or with "4.0" for "4" is the same rule', () => {
    const a = rule({ code: 'C', kind: 'RANGE', pointCode: 'chest', minValue: '88', maxValue: '116', messageI18n: { it: 'a', en: 'b' } })
    expect(sameRule(a, { ...a, minValue: '88.00', messageI18n: { en: 'b', it: 'a' } })).toBe(true)
    expect(sameRule(a, { ...a, severity: 'WARN' })).toBe(false)
  })
})

describe('PRD-201: plausibility', () => {
  it('passes plausible measures, breaks each rule, and does not check a rule whose measure is missing', () => {
    const fine = checkRules(RULES, POINTS, { chest: cm('100'), waist: cm('84'), outseam: cm('104'), inseam: cm('80') })
    expect(fine.map((result) => [result.code, result.outcome])).toEqual([
      ['INSEAM_LE_OUTSEAM', 'PASSED'],
      ['WAIST_TO_CHEST', 'PASSED'],
      ['CHEST_RANGE', 'PASSED'],
    ])
    const wrong = checkRules(RULES, POINTS, { chest: cm('140'), waist: cm('170'), outseam: cm('80'), inseam: cm('86') })
    expect(wrong.map((result) => [result.code, result.outcome])).toEqual([
      ['INSEAM_LE_OUTSEAM', 'BROKEN'],
      ['WAIST_TO_CHEST', 'BROKEN'],
      ['CHEST_RANGE', 'BROKEN'],
    ])
    expect(wrong[0]!.detail).toBe('Inseam 86 cm is longer than Outseam 80 cm.')
    expect(wrong[1]).toMatchObject({ ratio: '1.2143', detail: 'Waist 170 cm ÷ Chest 140 cm = 1.2143, outside 0.6–1.15.' })
    const missing = checkRules(RULES, POINTS, { chest: cm('100') })
    expect(missing.map((result) => result.outcome)).toEqual(['NOT_CHECKED', 'NOT_CHECKED', 'PASSED'])
    expect(missing[0]!.detail).toBe('Inseam is not measured.')
  })

  it('compares in the point’s unit (a centimetre is ten millimetres) and never checks an archived rule', () => {
    expect(inUnit('61.5', 'cm', 'MM')?.toString()).toBe('615')
    expect(inUnit('615', 'mm', 'CM')?.toString()).toBe('61.5')
    expect(inUnit('61.5', 'in', 'CM')).toBeNull()
    const results = checkRules([...RULES.slice(0, 2), { ...RULES[2]!, status: 'ARCHIVED' }], POINTS, { inseam: { value: '900', unit: 'mm' }, outseam: cm('100'), chest: cm('300') })
    expect(results.map((result) => [result.code, result.outcome])).toEqual([
      ['INSEAM_LE_OUTSEAM', 'PASSED'],
      ['WAIST_TO_CHEST', 'NOT_CHECKED'],
    ])
  })
})

describe('PRD-202: the base size suggested', () => {
  const RULE = { points: ['chest', 'height'], tie: 'LARGER' as const }
  const POINTS_H = [...POINTS, point('height')]

  it('the size whose ranges hold the measures; on a shared edge the next point decides, then the tie', () => {
    expect(suggestBaseSize(RULE, SIZES, POINTS_H, { chest: cm('102'), height: cm('179') })).toMatchObject({ size: '52', how: 'INSIDE', tie: false })
    // 100 is the top of 50 and the bottom of 52: the height (172) decides for 50.
    expect(suggestBaseSize(RULE, SIZES, POINTS_H, { chest: cm('100'), height: cm('172') })).toMatchObject({ size: '50', how: 'INSIDE', tie: false })
    // Without a height both hold the chest: the larger by default, the smaller when the rule says so.
    expect(suggestBaseSize(RULE, SIZES, POINTS_H, { chest: cm('100') })).toMatchObject({ size: '52', tie: true, detail: 'Chest 100 cm (height not measured: passed over): size 52 holds the measures; 50 and 52 were as close, the larger is taken.' })
    expect(suggestBaseSize({ ...RULE, tie: 'SMALLER' }, SIZES, POINTS_H, { chest: cm('100') })).toMatchObject({ size: '50', tie: true })
  })

  it('outside every size: the nearest; nothing measured, no rule or no body measures: none, said', () => {
    expect(suggestBaseSize(RULE, SIZES, POINTS_H, { chest: cm('111'), height: cm('190') })).toMatchObject({ size: '54', how: 'NEAREST', points: [{ code: 'chest', distance: '3' }, { code: 'height', distance: '2' }] })
    expect(suggestBaseSize(RULE, SIZES, POINTS_H, { waist: cm('80') })).toMatchObject({ size: null, detail: 'chest, height are not measured: no base size is suggested.' })
    expect(suggestBaseSize(null, SIZES, POINTS_H, { chest: cm('100') }).size).toBeNull()
    expect(suggestBaseSize({ points: ['waist'], tie: 'LARGER' }, SIZES, POINTS_H, { waist: cm('80') }).detail).toMatch(/No size of the range gives body measures for waist/)
  })
})

describe('PRD-203: alteration limits against the base size', () => {
  it('measured from the middle of the base size’s range; beyond a limit, a point without a base measure is not checked', () => {
    const base = SIZES[1]!
    const rows = alterationsOf(POINTS, base, { chest: cm('109'), waist: cm('90') })
    expect(rows.map((row) => [row.code, row.outcome, row.difference])).toEqual([
      ['chest', 'BEYOND', '7'],
      ['waist', 'NO_BASE_MEASURE', null],
      ['outseam', 'NO_LIMIT', null],
      ['inseam', 'NO_LIMIT', null],
    ])
    expect(rows[0]!.detail).toBe('Chest 109 cm is +7 cm from size 52 (102): beyond its limits −4/+6.')
    expect(alterationsOf(POINTS, base, { chest: cm('98') })[0]).toMatchObject({ outcome: 'WITHIN', difference: '-4' })
    expect(alterationsOf(POINTS, base, {})[0]!.outcome).toBe('NOT_MEASURED')
  })
})

describe('PRD-204: consumption scaled for the unit', () => {
  const LINES: ConsumptionLine[] = [
    { id: 'l10', seq: 10, item: { id: 'i1', code: 'LEA', name: 'Leather' }, placement: 'Shell', qty: '45', uom: 'FT2', wastagePct: '12', sizeDependent: true, sizes: { '50': '43', '52': '45', '54': '47.5' }, scale: { pointCode: 'chest', factor: '1' } },
    { id: 'l20', seq: 20, item: { id: 'i2', code: 'LIN', name: 'Lining' }, placement: null, qty: '1.8', uom: 'M', wastagePct: '5', sizeDependent: false, sizes: {}, scale: { pointCode: 'chest', factor: '0.8' } },
    { id: 'l30', seq: 30, item: { id: 'i3', code: 'PRO', name: 'Protector' }, placement: null, qty: '2', uom: 'PCS', wastagePct: '0', sizeDependent: false, sizes: {}, scale: null },
    { id: 'l40', seq: 40, item: { id: 'i4', code: 'BIG', name: 'Big size only' }, placement: null, qty: '1', uom: 'PCS', wastagePct: '0', sizeDependent: true, sizes: { '54': '1' }, scale: null },
  ]

  it('base quantity × (1 + factor × (measure ÷ base measure − 1)); a line not marked takes the base size’s', () => {
    const rows = consumptionOf(LINES, POINTS, SIZES[1]!, { chest: cm('112.2') })
    expect(rows.map((row) => [row.seq, row.baseQty, row.unitQty])).toEqual([
      [10, '45', '49.5'],
      [20, '1.8', '1.944'],
      [30, '2', '2'],
      [40, null, null],
    ])
    expect(rows[0]!.detail).toBe('45 × (1 + 1 × (Chest 112.2 ÷ 102 − 1)) = 49.5 ft2.')
    expect(rows[3]!.detail).toBe('Size 52 does not use this line.')
  })

  it('a measure missing, or a result of 0 or less, keeps the base size’s quantity, said', () => {
    expect(consumptionOf(LINES.slice(1, 2), POINTS, SIZES[1]!, {})[0]).toMatchObject({ unitQty: '1.8', scaled: null, detail: 'Chest is not measured: size 52’s quantity.'.replace('’', "'") })
    const extreme = consumptionOf([{ ...LINES[1]!, scale: { pointCode: 'chest', factor: '10' } }], POINTS, SIZES[1]!, { chest: cm('80') })[0]!
    expect(extreme).toMatchObject({ unitQty: '1.8', detail: "Scaled by Chest it would be 0 or less: size 52's quantity is kept." })
  })
})

describe('PRD-017 and the one check', () => {
  const template = { id: 't1', code: 'JACKET', rulesOn: true, baseSizeRule: { points: ['chest'], tie: 'LARGER' as const }, points: POINTS, rules: RULES }
  const base: MtmCheckInput = {
    template,
    measures: { chest: cm('102'), waist: cm('84'), outseam: cm('104'), inseam: cm('80') },
    garmentType: 'JACKET',
    style: { code: 'JKT', mtmAllowed: true, measurementTemplateId: 't1', sizes: SIZES },
    baseSize: null,
    lines: null,
    certificate: null,
  }

  it('only a style flagged made to measure, measured with its own template and garment type', () => {
    expect(styleFindings({ code: 'JKT', mtmAllowed: true, measurementTemplateId: 't1' }, { id: 't1', code: 'JACKET' }, 'JACKET')).toEqual([])
    expect(styleFindings({ code: 'JKT', mtmAllowed: false, measurementTemplateId: null }, { id: 't1', code: 'JACKET' }, 'TROUSERS').map((found) => found.kind)).toEqual(['STYLE_NOT_MTM', 'NO_TEMPLATE', 'GARMENT_TYPE'])
    expect(styleFindings({ code: 'JKT', mtmAllowed: true, measurementTemplateId: 't2' }, { id: 't1', code: 'JACKET' }, null).map((found) => found.kind)).toEqual(['OTHER_TEMPLATE'])
  })

  it('OK inside everything; a BLOCK rule, an alteration beyond its limit and a refused certificate block; a WARN rule and a typed base size warn', () => {
    const fine = mtmCheck(base)
    expect(fine).toMatchObject({ verdict: 'OK', baseSize: { size: '52', used: '52', how: 'INSIDE' }, insideCertifiedRange: true, blocks: [], warnings: [] })
    const wrong = mtmCheck({ ...base, measures: { chest: cm('120'), waist: cm('150'), outseam: cm('104'), inseam: cm('80') }, baseSize: '52', certificate: { allowed: false, outcome: 'refused', reasons: [{ code: 'style_not_made_to_measure', message: 'x' }, { code: 'measurement_outside', message: 'Chest outside', point: 'chest' }] } })
    expect(wrong.verdict).toBe('BLOCK')
    expect(wrong.blocks.map((found) => [found.kind, found.ref])).toEqual([
      ['RULE', 'CHEST_RANGE'],
      ['ALTERATION', 'chest'],
      ['CERTIFICATE', 'chest'],
    ])
    expect(wrong.warnings.map((found) => [found.kind, found.ref])).toEqual([
      ['RULE', 'WAIST_TO_CHEST'],
      ['BASE_SIZE', '52'],
    ])
    expect(wrong.insideCertifiedRange).toBe(false)
  })

  it('rules off: nothing of the template is checked, a typed base size still scales the BOM', () => {
    const off = mtmCheck({ ...base, template: { ...template, rulesOn: false }, measures: { chest: cm('150') }, baseSize: '52', lines: [{ id: 'l', seq: 10, item: { id: 'i', code: 'LIN', name: 'Lining' }, placement: null, qty: '1.8', uom: 'M', wastagePct: '0', sizeDependent: false, sizes: {}, scale: { pointCode: 'chest', factor: '1' } }] })
    expect(off).toMatchObject({ verdict: 'OK', rulesOn: false, rules: [], alterations: [], insideCertifiedRange: null, baseSize: { size: null, used: '52' } })
    expect(off.consumption?.[0]?.unitQty).toBe('2.6471')
    expect(off.notes[0]).toMatch(/rules of this template are off/)
    expect(mtmCheck({ ...base, template: { ...template, rulesOn: false }, lines: [] }).notes).toContain('No base size: the consumption is not scaled (type one, or turn the rules on to have one suggested).')
  })
})
