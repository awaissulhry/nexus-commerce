import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT } from '../labels/rules'
import { careWords, careWordsOf, missingCareGroups } from './care'
import { compareWithLabel, computeComposition, lineWeight, textileShareOf, weightOf, wholePercents, type LineFacts, type MaterialFacts } from './composition'
import { officialName, readFibre } from './fibres'
import { leatherNaming, reservedWords } from './leather'
import { originCheck, type PlaceFacts, type StepFacts } from './origin'
import { DEFAULT_SWITCHES, textileChecks, type LabelFacts, type TextileFacts } from './rules'

// Every code, name and weight here is made up.
let next = 0
const material = (extra: Partial<MaterialFacts> & Pick<MaterialFacts, 'kind'>): MaterialFacts => {
  next += 1
  return {
    id: `m${next}`,
    code: `MAT-${next}`,
    name: `Material ${next}`,
    composition: null,
    animalOrigin: false,
    attributes: null,
    units: { baseUom: 'M', purchaseUom: 'M', purchaseFactor: '1', consumptionUom: 'M', consumptionFactor: '1' },
    ...extra,
  }
}
const line = (seq: number, mat: MaterialFacts, qty: string | null, uom: LineFacts['uom'] = mat.units.baseUom): LineFacts => ({ seq, placement: null, qty, uom, material: mat })

const leather = material({ kind: 'LEATHER', code: 'LEA', name: 'Cowhide', animalOrigin: true, units: { baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: '52.5', consumptionUom: 'FT2', consumptionFactor: '1' } })
const lining = material({ kind: 'LINING', code: 'LIN', composition: [{ fibre: 'polyester', percent: '100' }], attributes: { weight: '120 g/m' } })
const protector = material({ kind: 'PROTECTOR', code: 'PRO', units: { baseUom: 'PCS', purchaseUom: 'PCS', purchaseFactor: '1', consumptionUom: 'PCS', consumptionFactor: '1' }, attributes: { weight: '150 g' } })
const shellA = material({ kind: 'TEXTILE', code: 'SH-A', composition: [{ fibre: 'Cordura', percent: '100' }], attributes: { 'weight (g/m2)': '500' }, units: { baseUom: 'M2', purchaseUom: 'M2', purchaseFactor: '1', consumptionUom: 'M2', consumptionFactor: '1' } })
const shellB = material({ kind: 'TEXTILE', code: 'SH-B', composition: [{ fibre: 'polyester', percent: '80' }, { fibre: 'elastane', percent: '20' }], attributes: { gsm: '250' }, units: { baseUom: 'M2', purchaseUom: 'M2', purchaseFactor: '1', consumptionUom: 'M2', consumptionFactor: '1' } })

describe('fibre names of Reg. (EU) 1007/2011 Annex I (PRD-338)', () => {
  it('reads official names, typed words and trade marks, and tells leather from a fibre', () => {
    expect(readFibre('Nylon')).toMatchObject({ kind: 'ANNEX', brand: false, fibre: { key: 'polyamide' } })
    expect(readFibre('poliammide')).toMatchObject({ kind: 'ANNEX', fibre: { key: 'polyamide' } })
    expect(readFibre('CORDURA®')).toMatchObject({ kind: 'ANNEX', brand: true, fibre: { key: 'polyamide' } })
    expect(readFibre('Elastan')).toMatchObject({ kind: 'ANNEX', fibre: { key: 'elastane' } })
    expect(readFibre('leather (not a textile)')).toEqual({ kind: 'NOT_TEXTILE' })
    expect(readFibre('unobtainium')).toEqual({ kind: 'UNKNOWN' })
    const polyethylene = readFibre('Dyneema')
    expect(polyethylene.kind === 'ANNEX' && officialName(polyethylene.fibre, 'it')).toBe(null)
  })
})

describe('weights and the composition from the BOM (PRD-338)', () => {
  it('reads the weight attribute in its usual forms, and names one it cannot read', () => {
    expect(weightOf(shellA)).toMatchObject({ per: 'M2', text: '500 g/m2' })
    expect((weightOf(shellA) as { gramsPer: Decimal }).gramsPer.eq(500)).toBe(true)
    expect(weightOf(shellB)).toMatchObject({ per: 'M2' })
    expect((weightOf({ attributes: { Peso: '0,25 kg/m' }, units: lining.units }) as { gramsPer: Decimal }).gramsPer.eq(250)).toBe(true)
    expect(weightOf(protector)).toMatchObject({ per: 'PCS' })
    expect(weightOf({ attributes: { weight: 'heavy' }, units: lining.units })).toMatchObject({ problem: expect.stringContaining('180 g/m2') })
    expect(weightOf({ attributes: { colour: 'red' }, units: lining.units })).toBe(null)
  })

  it('weighs a line through its unit, a mass unit or the material weight, and says why when it cannot', () => {
    expect(lineWeight(line(1, lining, '1.8')).grams?.eq(216)).toBe(true)
    expect(lineWeight(line(2, protector, '2')).grams?.eq(300)).toBe(true)
    // 2 dm² of a 500 g/m² fabric: 10 g; a quantity in kilograms needs no attribute.
    expect(lineWeight(line(3, shellA, '2', 'DM2')).grams?.eq(10)).toBe(true)
    expect(lineWeight(line(4, material({ kind: 'THREAD', units: { baseUom: 'KG', purchaseUom: 'CONE', purchaseFactor: '0.25', consumptionUom: 'KG', consumptionFactor: '1' } }), '0.02', 'KG')).grams?.eq(20)).toBe(true)
    expect(lineWeight(line(5, leather, '45'))).toMatchObject({ grams: null, why: expect.stringContaining('has no weight') })
    expect(lineWeight(line(6, lining, null))).toEqual({ grams: null, why: 'not used in this size' })
  })

  it('rounds shares by weight to whole percents that add up to 100', () => {
    const three = wholePercents(new Map([['a', new Decimal(1)], ['b', new Decimal(1)], ['c', new Decimal(1)]]))
    expect([...three.values()].reduce((sum, value) => sum.plus(value), new Decimal(0)).eq(100)).toBe(true)
    expect(three.get('a')?.eq(34)).toBe(true)
  })

  it('computes each part from one composition, or by weight when it mixes, and finds the non-textile animal parts', () => {
    const jacket = computeComposition([line(10, leather, '45'), line(20, lining, '1.8'), line(30, protector, '2')])
    expect(jacket.parts).toEqual([{ component: 'LINING', part: 'lining', words: { en: 'lining', it: 'fodera' }, fibres: [{ fibre: 'polyester', annex: true, percent: '100' }], basis: 'ONE_COMPOSITION', materials: ['LIN'] }])
    expect(jacket.animalParts).toEqual([{ code: 'LEA', name: 'Cowhide' }])
    expect(jacket.findings).toEqual([])

    // 1 m² of 500 g/m² polyamide (500 g) and 2 m² of 250 g/m² polyester-elastane (400 g polyester, 100 g elastane).
    const mixed = computeComposition([line(10, shellA, '1'), line(11, shellB, '2')])
    expect(mixed.parts[0]).toMatchObject({ component: 'SHELL', basis: 'BY_WEIGHT', fibres: [{ fibre: 'polyamide', percent: '50' }, { fibre: 'polyester', percent: '40' }, { fibre: 'elastane', percent: '10' }] })

    const unweighed = computeComposition([line(10, shellA, '1'), line(11, material({ kind: 'TEXTILE', composition: [{ fibre: 'cotton', percent: '100' }] }), '1')])
    expect(unweighed.parts[0]).toMatchObject({ fibres: null, basis: null })
    expect(unweighed.findings).toEqual([expect.objectContaining({ path: 'lines/11/weight', severity: 'WARN' })])

    const bare = computeComposition([line(10, material({ kind: 'TEXTILE', code: 'BARE' }), '1')])
    expect(bare.findings).toEqual([expect.objectContaining({ path: 'materials/BARE/composition', severity: 'FAIL' })])
  })

  it("compares the label's typed parts with the BOM's", () => {
    const parts = computeComposition([line(10, leather, '45'), line(20, lining, '1.8')]).parts
    expect(compareWithLabel(parts, [{ part: 'Fodera', fibres: [{ fibre: 'poliestere', percent: '100' }] }])).toEqual([])
    expect(compareWithLabel(parts, [{ part: 'lining', fibres: [{ fibre: 'polyamide', percent: '100' }] }])).toEqual([expect.objectContaining({ path: 'label/composition/0', severity: 'FAIL', message: expect.stringContaining('the BOM gives lining 100 % polyester') })])
    expect(compareWithLabel(parts, [])).toEqual([expect.objectContaining({ path: 'bom/LINING', severity: 'FAIL' })])
    expect(compareWithLabel(parts, [{ part: 'lining', fibres: [{ fibre: 'polyester', percent: '100' }] }, { part: 'shell', fibres: [{ fibre: 'leather (not a textile)', percent: '100' }] }])).toEqual([
      expect.objectContaining({ path: 'label/composition/1', severity: 'WARN', message: expect.stringContaining('no textile fibre') }),
    ])
  })
})

describe('the 80 % textile threshold (PRD-340)', () => {
  it('weighs textiles against the net mass, or against every line, and says what is missing', () => {
    const lines = [line(10, leather, '45'), line(20, lining, '1.8'), line(30, protector, '2')]
    expect(textileShareOf(lines, '1.200')).toMatchObject({ pct: '18', applies: false, basis: 'NET_MASS', textileGrams: '216', garmentGrams: '1200' })
    expect(textileShareOf(lines, null)).toMatchObject({ pct: null, applies: null, basis: 'BOM', missing: [{ seq: 10, code: 'LEA' }] })
    expect(textileShareOf([line(20, lining, '1.8'), line(30, protector, '0.2')], null)).toMatchObject({ pct: '87.8', applies: true })
  })
})

describe('Made in Italy from the routing (PRD-344)', () => {
  const plants: PlaceFacts[] = [{ code: 'IT1', name: 'Plant 1', country: 'IT' }]
  const step = (seq: number, workCentreKind: string, workshop: PlaceFacts | null = null): StepFacts => ({ seq, code: `OP${seq}`, name: `Op ${seq}`, workCentreKind, workshop })
  const abroad: PlaceFacts = { code: 'WS', name: 'Workshop RO', country: 'RO' }

  it('allows both claims when every step is in Italy', () => {
    const check = originCheck([step(10, 'CUTTING'), step(20, 'SEWING'), step(30, 'PACKING')], plants, 'IT')
    expect(check).toMatchObject({ madeInItaly: 'ALLOWED', fullMadeInItaly: 'ALLOWED', findings: [] })
  })

  it('reads the making-up: cutting abroad keeps "Made in Italy", sewing abroad loses it', () => {
    const cutAbroad = originCheck([step(10, 'CUTTING', abroad), step(20, 'SEWING')], plants, null)
    expect(cutAbroad).toMatchObject({ madeInItaly: 'ALLOWED', fullMadeInItaly: 'NOT_ALLOWED' })
    const sewnAbroad = originCheck([step(10, 'CUTTING'), step(20, 'SEWING', abroad)], plants, null)
    expect(sewnAbroad.madeInItaly).toBe('NOT_ALLOWED')
    expect(sewnAbroad.findings).toEqual([expect.objectContaining({ path: 'steps/20', severity: 'WARN' })])
    // Claimed IT on the style: a failure.
    expect(originCheck([step(20, 'SEWING', abroad)], plants, 'IT').findings).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'style/originCountry', severity: 'FAIL' })]))
  })

  it('says it does not know when a country is missing or the plants are in two countries', () => {
    expect(originCheck([step(20, 'SEWING', { code: 'WS', name: 'Somewhere', country: null })], plants, null).madeInItaly).toBe('UNKNOWN')
    expect(originCheck([step(20, 'SEWING')], [...plants, { code: 'RO1', name: 'Plant RO', country: 'RO' }], null).madeInItaly).toBe('UNKNOWN')
    expect(originCheck([step(10, 'CUTTING')], plants, null).madeInItaly).toBe('UNKNOWN')
  })
})

describe('leather names in Italy (PRD-345)', () => {
  const style = { code: 'ST', name: 'Rider jacket', nameI18n: null, description: null }
  it('finds the reserved words, as words or inside made-up words', () => {
    expect(reservedWords('Ecopelle nera')).toEqual(['ecopelle'])
    expect(reservedWords('Vegan leather')).toEqual(['leather'])
    expect(reservedWords('Pellet di plastica')).toEqual([])
  })

  it('refuses leather words on materials that are not leather, and on a style without leather', () => {
    const fake = { code: 'PU', name: 'Similpelle PU', nameI18n: { en: 'Faux leather' }, kind: 'TEXTILE', animalOrigin: false, finish: null }
    expect(leatherNaming(style, [fake])).toEqual([expect.objectContaining({ path: 'materials/PU/name', severity: 'FAIL' })])
    expect(leatherNaming({ ...style, nameI18n: { it: 'Giacca in pelle' } }, [])).toEqual([expect.objectContaining({ path: 'style/name', severity: 'FAIL' })])
  })

  it('checks full grain against the finish, and the animal origin of leather', () => {
    const cow = { code: 'COW', name: 'Pelle pieno fiore', nameI18n: null, kind: 'LEATHER', animalOrigin: true, finish: 'corrected grain' }
    expect(leatherNaming(style, [cow])).toEqual([expect.objectContaining({ path: 'materials/COW/name', severity: 'FAIL' })])
    expect(leatherNaming(style, [{ ...cow, finish: 'full grain' }])).toEqual([])
    expect(leatherNaming(style, [{ ...cow, finish: 'full grain', animalOrigin: false }])).toEqual([expect.objectContaining({ path: 'materials/COW/animalOrigin' })])
    expect(leatherNaming({ ...style, name: 'Leather jacket' }, [{ ...cow, finish: 'full grain' }])).toEqual([])
  })
})

describe('care words (PRD-342)', () => {
  it('gives the words in Italian and English, a typed text first, and the missing groups', () => {
    expect(careWords('wash-not', 'it')).toBe('Non lavare')
    expect(careWords('wash-not', 'de')).toBe(null)
    expect(careWordsOf([{ symbol: 'iron-not', text: { de: 'Nicht bügeln' } }], ['it', 'de', 'fr'])[0]?.words).toEqual([
      { language: 'it', text: 'Non stirare', typed: false },
      { language: 'de', text: 'Nicht bügeln', typed: true },
      { language: 'fr', text: null, typed: false },
    ])
    expect(missingCareGroups([{ symbol: 'wash-not' }, { symbol: 'bleach-not' }, { symbol: 'iron-not' }, { symbol: 'dryclean-professional' }])).toEqual(['DRYING'])
  })
})

describe('the checks of a style revision', () => {
  const label: LabelFacts = {
    code: 'LBL-ST',
    revision: 1,
    status: 'ACTIVE',
    languages: ['it', 'en'],
    composition: [{ part: 'lining', fibres: [{ fibre: 'polyester', percent: '100' }] }],
    animalOriginPhrase: true,
    care: [{ symbol: 'wash-not' }, { symbol: 'bleach-not' }, { symbol: 'iron-not' }, { symbol: 'dryclean-professional' }],
    layout: DEFAULT_LAYOUT,
  }
  const facts: TextileFacts = {
    style: { code: 'ST', name: 'Leather jacket', nameI18n: { it: 'Giacca in pelle' }, description: null, originCountry: null, netMassKg: '1.800' },
    revision: 1,
    label,
    colourways: [{ colourway: 'BLK', lines: [line(10, leather, '45'), line(20, lining, '1.8'), line(30, protector, '2')] }, { colourway: 'RED', lines: [line(10, leather, '45'), line(20, lining, '1.8'), line(30, protector, '2')] }],
    materials: [{ code: 'LEA', name: 'Cowhide', nameI18n: null, kind: 'LEATHER', animalOrigin: true, finish: null }],
    steps: [{ seq: 10, code: 'CUT', name: 'Cut', workCentreKind: 'CUTTING', workshop: null }, { seq: 20, code: 'SEW', name: 'Sew', workCentreKind: 'SEWING', workshop: null }],
    plants: [{ code: 'IT1', name: 'Plant 1', country: 'IT' }],
  }
  const outcomes = (report: ReturnType<typeof textileChecks>) => Object.fromEntries(report.results.map((result) => [result.key, result.outcome]))

  it('runs every check; the three open ones are OFF by default and say why, and still compute', () => {
    const report = textileChecks(facts, DEFAULT_SWITCHES)
    expect(outcomes(report)).toEqual({ composition: 'PASS', fibreNames: 'PASS', animalOrigin: 'PASS', textileShare: 'OFF', careLabel: 'OFF', madeInItaly: 'OFF', leatherNaming: 'PASS' })
    expect(report.results.find((result) => result.key === 'textileShare')).toMatchObject({ switchable: true, on: false, words: expect.stringContaining('Q10'), findings: [] })
    expect(report.composition).toHaveLength(1)
    expect(report.composition[0]?.colourways).toEqual(['BLK', 'RED'])
    expect(report.textileShare[0]?.value).toMatchObject({ pct: '12', applies: false })
    expect(report.origin.madeInItaly).toBe('ALLOWED')
    expect(report.animalOrigin.phrases).toEqual([
      { language: 'it', text: 'Contiene parti non tessili di origine animale', typed: false },
      { language: 'en', text: 'Contains non-textile parts of animal origin', typed: false },
    ])
    for (const result of report.results) expect(result.law.length).toBeGreaterThan(0)
  })

  it('switched on, the open checks answer; the 80 % rule makes the phrase not required', () => {
    const report = textileChecks(facts, { textileShare: true, careLabel: true, madeInItaly: true })
    expect(outcomes(report)).toMatchObject({ textileShare: 'PASS', careLabel: 'WARN', madeInItaly: 'PASS', animalOrigin: 'NOT_APPLICABLE' })
    expect(report.results.find((result) => result.key === 'careLabel')?.findings).toEqual([expect.objectContaining({ message: expect.stringContaining('drying') })])
  })

  it('fails the phrase the label leaves out, and says UNKNOWN without a label', () => {
    expect(outcomes(textileChecks({ ...facts, label: { ...label, animalOriginPhrase: false } }, DEFAULT_SWITCHES)).animalOrigin).toBe('FAIL')
    const unlabelled = textileChecks({ ...facts, label: null }, DEFAULT_SWITCHES)
    expect(outcomes(unlabelled)).toMatchObject({ composition: 'UNKNOWN', animalOrigin: 'UNKNOWN' })
    expect(unlabelled.results.find((result) => result.key === 'composition')?.words).toContain('lining 100 % polyester')
  })

  it('groups colourways whose BOM differs', () => {
    const red = [line(10, leather, '45'), line(20, material({ kind: 'LINING', code: 'LIN-R', composition: [{ fibre: 'polyamide', percent: '100' }] }), '1.8')]
    const report = textileChecks({ ...facts, colourways: [facts.colourways[0]!, { colourway: 'RED', lines: red }] }, DEFAULT_SWITCHES)
    expect(report.composition.map((group) => group.colourways)).toEqual([['BLK'], ['RED']])
    expect(report.results.find((result) => result.key === 'composition')).toMatchObject({ outcome: 'FAIL', findings: [expect.objectContaining({ message: expect.stringMatching(/^RED: /) })] })
  })
})
