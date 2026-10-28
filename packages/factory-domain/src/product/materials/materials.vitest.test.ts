import { describe, expect, it } from 'vitest'
import { filterForGrains, unheldMoneyInput } from '../../money/filter'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { colourListProblems, formatColourList, mergeColours, normaliseColour, parseColourList } from './colours'
import { createMaterialBody, listMaterialsQuery, materialRow, materialView, standardCostBody, updateMaterialBody } from './contracts'
import { changeMaterial, crViProblems, kindDefaults, materialProblems, materialWarnings, newMaterial, type MaterialFields, type MaterialInput } from './rules'

/** Made-up materials: nothing here is a real article or supplier. */
const LEATHER: MaterialInput = {
  code: 'pl-bov-01',
  name: 'Bovine nappa 1.2',
  kind: 'LEATHER',
  baseUom: 'FT2',
  purchaseUom: 'HIDE',
  purchaseFactor: '52.5',
  consumptionUom: 'DM2',
  animalSpecies: 'bovine',
  tannage: 'CHROME',
  grade: 'A',
  thicknessMinMm: '1.10',
  thicknessMaxMm: '1.3',
  requiresCrViTest: true,
  crViLimitMgKg: '3',
}

const made = (input: MaterialInput): MaterialFields => {
  const outcome = newMaterial(input)
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
  return outcome.material
}
const issuesOf = (input: MaterialInput) => {
  const outcome = newMaterial(input)
  return outcome.ok ? [] : outcome.issues
}
const paths = (input: MaterialInput) => issuesOf(input).map((issue) => issue.path)

describe('a new material (PRD-028)', () => {
  it('takes the kind defaults, upper-cases the code, derives the unit factors and writes decimals plainly', () => {
    const leather = made(LEATHER)
    expect(leather).toMatchObject({
      code: 'PL-BOV-01',
      sourcing: 'BUY',
      tracking: 'HIDE',
      animalOrigin: true,
      isPpeComponent: false,
      purchaseFactor: '52.5',
      consumptionFactor: '0.1076391',
      thicknessMinMm: '1.1',
      thicknessMaxMm: '1.3',
      crViLimitMgKg: '3',
    })
    expect(made({ code: 'PR-1621', name: 'Back protector', kind: 'PROTECTOR', baseUom: 'PCS' })).toMatchObject({ tracking: 'LOT', isPpeComponent: true, sourcing: 'BUY' })
    expect(made({ code: 'CMP-1', name: 'Pre-sewn yoke', kind: 'COMPONENT', baseUom: 'PCS' })).toMatchObject({ sourcing: 'MAKE' })
    expect(kindDefaults('LINING')).toEqual({ sourcing: 'BUY', tracking: 'NONE', animalOrigin: false, isPpeComponent: false })
  })

  it('needs, for leather, the species, tannage, grade, thickness, an area unit, lot or hide tracking and animal origin (Reg. (EU) 1007/2011 art. 12)', () => {
    const bare: MaterialInput = { code: 'PL-2', name: 'Goat', kind: 'LEATHER', baseUom: 'PCS', tracking: 'NONE', animalOrigin: false }
    expect(issuesOf(bare)).toEqual([
      { path: 'animalSpecies', message: 'Leather names its animal (bovine, goat, kangaroo …).' },
      { path: 'tannage', message: 'Leather names its tannage (chrome tanning is why Cr VI is tested).' },
      { path: 'grade', message: "Leather names the tannery's selection or grade." },
      { path: 'thicknessMinMm', message: 'Leather has its thickness range in millimetres.' },
      { path: 'thicknessMaxMm', message: 'Leather has its thickness range in millimetres.' },
      { path: 'baseUom', message: 'Leather counts in an area unit: m², dm² or ft².' },
      { path: 'tracking', message: 'Leather is traced by lot or hide by hide.' },
      { path: 'animalOrigin', message: 'Leather is of animal origin: the garment label says so (Reg. (EU) 1007/2011 art. 12).' },
    ])
    expect(paths({ ...LEATHER, thicknessMinMm: '1.4' })).toEqual(['thicknessMaxMm'])
    expect(paths({ ...LEATHER, thicknessMinMm: '0' })).toEqual(['thicknessMinMm'])
  })

  it('refuses a Cr VI limit without a test, a test without a limit, and a limit above 3 mg/kg (REACH Annex XVII entry 47)', () => {
    expect(crViProblems(true, null)).toEqual([
      { path: 'crViLimitMgKg', message: "A material whose lots need a Cr VI test has its limit: at most 3 mg/kg (REACH Annex XVII entry 47), or a brand's lower one." },
    ])
    expect(crViProblems(false, '3')).toEqual([{ path: 'crViLimitMgKg', message: 'A Cr VI limit is set only when the lots need a Cr VI test.' }])
    for (const limit of ['3.001', '4', '0', '0.0005']) expect(crViProblems(true, limit)).toHaveLength(1)
    for (const limit of ['3', '2.5', '0.001', '3.000']) expect(crViProblems(true, limit)).toEqual([])
    expect(crViProblems(false, null)).toEqual([])
    expect(paths({ ...LEATHER, crViLimitMgKg: '3.5' })).toEqual(['crViLimitMgKg'])
  })

  it('keeps make or buy straight (PRD-024): a component is made, a made material has no supplier', () => {
    const supplier = '0195f5d0-0000-7000-8000-0000000000aa'
    expect(paths({ code: 'CMP-2', name: 'Yoke', kind: 'COMPONENT', baseUom: 'PCS', sourcing: 'BUY' })).toEqual(['sourcing'])
    expect(paths({ code: 'LB-1', name: 'Label', kind: 'LABEL', baseUom: 'PCS', sourcing: 'MAKE', defaultSupplierId: supplier, supplierArticleCode: 'X1' })).toEqual([
      'defaultSupplierId',
      'supplierArticleCode',
    ])
    expect(paths({ code: 'LB-2', name: 'Label', kind: 'LABEL', baseUom: 'PCS', supplierArticleCode: 'X1' })).toEqual([])
    expect(made({ code: 'LB-3', name: 'Label', kind: 'LABEL', baseUom: 'PCS', sourcing: 'MAKE_OR_BUY', defaultSupplierId: supplier, supplierArticleCode: 'X1' })).toMatchObject({ sourcing: 'MAKE_OR_BUY' })
  })

  it('keeps tracking straight (PRD-025): hide by hide only leather, serials per piece, a PPE component traced (Reg. (EU) 2016/425 art. 8(5))', () => {
    expect(paths({ code: 'TX-1', name: 'Mesh', kind: 'TEXTILE', baseUom: 'M2', tracking: 'HIDE' })).toEqual(['tracking'])
    expect(paths({ code: 'TX-2', name: 'Mesh', kind: 'TEXTILE', baseUom: 'M2', tracking: 'SERIAL' })).toEqual(['tracking'])
    expect(issuesOf({ code: 'PR-2', name: 'Knee protector', kind: 'PROTECTOR', baseUom: 'PAIR', tracking: 'NONE' })).toEqual([
      { path: 'tracking', message: 'A PPE component is traced by lot or serial, so the garments that hold one lot can be found (Reg. (EU) 2016/425 art. 8(5)).' },
    ])
    expect(made({ code: 'PR-3', name: 'Shoulder protector', kind: 'PROTECTOR', baseUom: 'PCS', tracking: 'SERIAL' })).toMatchObject({ tracking: 'SERIAL' })
  })

  it('checks the units (PRD-030), a fibre composition and free attributes', () => {
    expect(issuesOf({ code: 'LN-1', name: 'Lining', kind: 'LINING', baseUom: 'M2', purchaseUom: 'M' })).toEqual([
      { path: 'purchaseFactor', message: 'Say how many m² one m holds.' },
    ])
    const lining: MaterialInput = { code: 'LN-2', name: 'Lining', kind: 'LINING', baseUom: 'M2' }
    expect(made({ ...lining, composition: [{ fibre: 'polyamide', percent: '70.00' }, { fibre: 'elastane', percent: '30' }] }).composition).toEqual([
      { fibre: 'polyamide', percent: '70' },
      { fibre: 'elastane', percent: '30' },
    ])
    expect(issuesOf({ ...lining, composition: [{ fibre: 'polyamide', percent: '70' }, { fibre: 'Polyamide', percent: '20' }] })).toEqual([
      { path: 'composition/1/fibre', message: 'Each fibre is listed once.' },
    ])
    expect(issuesOf({ ...lining, composition: [{ fibre: 'polyamide', percent: '99.5' }] })).toEqual([{ path: 'composition', message: 'The fibres add up to 99.5 %, not 100 %.' }])
    expect(paths({ ...lining, attributes: { '9 bad': 'x' } })).toEqual(['attributes/9 bad'])
    expect(paths({ ...lining, code: 'bad code' })).toEqual(['code'])
    expect(paths({ ...lining, nameI18n: { it: 'Fodera', de: 'Futter' } as never })).toEqual(['nameI18n/de'])
  })

  it('points out a bought material without a supplier and leather without a Cr VI test', () => {
    expect(materialWarnings(made({ ...LEATHER, requiresCrViTest: false, crViLimitMgKg: null })).map((warning) => warning.code)).toEqual([
      'NO_DEFAULT_SUPPLIER',
      'LEATHER_WITHOUT_CR6_TEST',
    ])
    expect(materialWarnings(made({ code: 'CMP-3', name: 'Yoke', kind: 'COMPONENT', baseUom: 'PCS' }))).toEqual([])
  })
})

describe('a change to a material', () => {
  const leather = made(LEATHER)

  it('reports only what changed, and refuses a change that breaks a rule', () => {
    const outcome = changeMaterial(leather, { name: 'Bovine nappa 1.2 mm', grade: 'A', thicknessMinMm: '1.1' })
    expect(outcome).toMatchObject({ ok: true, changed: ['name'] })
    expect(changeMaterial(leather, { tannage: null })).toEqual({ ok: false, issues: [{ path: 'tannage', message: 'Leather names its tannage (chrome tanning is why Cr VI is tested).' }] })
    expect(changeMaterial(leather, { crViLimitMgKg: '5' })).toMatchObject({ ok: false, issues: [{ path: 'crViLimitMgKg' }] })
  })

  it('clears the Cr VI limit with the test, and asks for one when the test is turned on', () => {
    expect(changeMaterial(leather, { requiresCrViTest: false })).toMatchObject({ ok: true, material: { requiresCrViTest: false, crViLimitMgKg: null }, changed: ['requiresCrViTest', 'crViLimitMgKg'] })
    const off = made({ ...LEATHER, requiresCrViTest: false, crViLimitMgKg: null })
    expect(changeMaterial(off, { requiresCrViTest: true })).toMatchObject({ ok: false, issues: [{ path: 'crViLimitMgKg' }] })
    expect(changeMaterial(off, { requiresCrViTest: true, crViLimitMgKg: '1.5' })).toMatchObject({ ok: true, material: { crViLimitMgKg: '1.5' } })
  })

  it('carries a hide factor over when the base unit moves inside the area dimension, and derives the rest again', () => {
    expect(changeMaterial(leather, { baseUom: 'M2' })).toMatchObject({
      ok: true,
      material: { baseUom: 'M2', purchaseUom: 'HIDE', purchaseFactor: '4.8774096', consumptionUom: 'DM2', consumptionFactor: '0.01' },
      changed: ['baseUom', 'purchaseFactor', 'consumptionFactor'],
    })
    // A new purchase unit asks for its own factor; a typed one wins.
    expect(changeMaterial(leather, { purchaseUom: 'SIDE' })).toMatchObject({ ok: false, issues: [{ path: 'purchaseFactor' }] })
    expect(changeMaterial(leather, { purchaseUom: 'SIDE', purchaseFactor: '26' })).toMatchObject({ ok: true, material: { purchaseFactor: '26' } })
    expect(changeMaterial(leather, { purchaseFactor: '51' })).toMatchObject({ ok: true, changed: ['purchaseFactor'] })
  })

  it('asks for the factor again when the base unit moves to another dimension', () => {
    const lining = made({ code: 'LN-3', name: 'Lining', kind: 'LINING', baseUom: 'M2', purchaseUom: 'ROLL', purchaseFactor: '75' })
    expect(changeMaterial(lining, { baseUom: 'M' })).toEqual({
      ok: false,
      issues: [
        { path: 'purchaseFactor', message: 'Say how many m one rotolo holds.' },
        { path: 'consumptionFactor', message: 'Say how many m one m² holds.' },
      ],
    })
    expect(changeMaterial(lining, { baseUom: 'M', purchaseFactor: '50', consumptionFactor: '0.6667' })).toMatchObject({
      ok: true,
      material: { purchaseFactor: '50', consumptionUom: 'M2', consumptionFactor: '0.6667' },
    })
  })

  it('checks a stored material the same way (the database trigger holds the same units and Cr VI rules)', () => {
    expect(materialProblems(leather)).toEqual([])
    expect(materialProblems({ ...leather, purchaseFactor: '0' })).toEqual([{ path: 'purchaseFactor', message: 'The factor is above 0.' }])
  })
})

describe("a material's colours (PRD-032)", () => {
  it('reads and writes the colour cell of an import, and merges without removing', () => {
    expect(parseColourList(' ner=Nero|T-0001; ROS = Rosso \n BLU ')).toEqual({
      ok: true,
      colours: [
        { code: 'NER', name: 'Nero', supplierColourCode: 'T-0001' },
        { code: 'ROS', name: 'Rosso', supplierColourCode: null },
        { code: 'BLU', name: 'BLU', supplierColourCode: null },
      ],
    })
    expect(parseColourList('NER=Nero; ner=Black')).toEqual({ ok: false, message: 'Colour 2 repeats a code.' })
    expect(parseColourList('bad code=Nero')).toMatchObject({ ok: false, message: expect.stringMatching(/^Colour 1 is not valid/) })
    expect(parseColourList(' ; ')).toMatchObject({ ok: false })
    const current = [normaliseColour({ code: 'ros', name: 'Red' }), normaliseColour({ code: 'NER', name: 'Nero', supplierColourCode: 'T-1' })]
    expect(formatColourList(current)).toBe('NER=Nero|T-1; ROS=Red')
    expect(formatColourList(mergeColours(current, [normaliseColour({ code: 'ROS', name: 'Rosso' }), normaliseColour({ code: 'BLU', name: 'Blu' })]))).toBe(
      'BLU=Blu; NER=Nero|T-1; ROS=Rosso',
    )
    // A colour given without its supplier code keeps the one it has; a new one replaces it.
    expect(formatColourList(mergeColours(current, [normaliseColour({ code: 'NER', name: 'Black' })]))).toBe('NER=Black|T-1; ROS=Red')
    expect(formatColourList(mergeColours(current, [normaliseColour({ code: 'NER', name: 'Nero', supplierColourCode: 'T-2' })]))).toBe('NER=Nero|T-2; ROS=Red')
    expect(colourListProblems([normaliseColour({ code: 'A', name: 'x' }), normaliseColour({ code: 'a', name: 'y' })])).toEqual([
      { path: 'colours/1/code', message: 'Each colour code is listed once.' },
    ])
  })
})

describe('the material contracts', () => {
  const view = {
    id: '0195f5d0-0000-7000-8000-000000000001',
    companyId: null,
    code: 'PL-BOV-01',
    name: 'Bovine nappa',
    nameI18n: null,
    kind: 'LEATHER',
    sourcing: 'BUY',
    tracking: 'HIDE',
    baseUom: 'FT2',
    purchaseUom: 'HIDE',
    consumptionUom: 'DM2',
    defaultSupplier: null,
    supplierArticleCode: null,
    isPpeComponent: false,
    requiresCrViTest: true,
    crViLimitMgKg: '3',
    standardCost: '2.4',
    currency: 'EUR',
    colourCount: 0,
    status: 'ACTIVE',
    version: 1,
    updatedAt: '2026-10-28T09:00:00.000Z',
  }

  it('marks the standard cost and its per-unit costs with the cost grain (GAP-006)', () => {
    expect(filterForGrains(materialRow, view, new Set(['price']))).not.toHaveProperty('standardCost')
    expect(filterForGrains(materialRow, view, new Set(['cost']))).toHaveProperty('standardCost', '2.4')
    const record = { ...view, standardCostPerPurchaseUnit: '126', standardCostPerConsumptionUnit: '0.258334', colours: [], warnings: [] }
    const seen = filterForGrains(materialView, record, new Set())
    expect(seen).not.toHaveProperty('standardCost')
    expect(seen).not.toHaveProperty('standardCostPerPurchaseUnit')
    expect(seen).not.toHaveProperty('standardCostPerConsumptionUnit')
    expect(unheldMoneyInput(createMaterialBody, { code: 'X', name: 'x', kind: 'TRIM', baseUom: 'PCS', standardCost: '1' }, new Set())).toEqual([
      { path: 'standardCost', message: 'Needs the cost grain.' },
    ])
    expect(unheldMoneyInput(standardCostBody, { version: 1, standardCost: null }, new Set())).toHaveLength(1)
    expect(unheldMoneyInput(standardCostBody, { version: 1, standardCost: '1' }, new Set(['cost']))).toEqual([])
  })

  it('refuses unknown keys, keeps the cost off a change, and reads the list filters', () => {
    expect(createMaterialBody.safeParse({ code: 'x-1', name: 'x', kind: 'TRIM', baseUom: 'PCS', colour: 'red' }).success).toBe(false)
    expect(createMaterialBody.parse({ code: ' x-1 ', name: 'x', kind: 'TRIM', baseUom: 'PCS' }).code).toBe('X-1')
    expect(updateMaterialBody.safeParse({ version: 1, standardCost: '1' }).success).toBe(false)
    expect(updateMaterialBody.safeParse({ version: 1, tannage: null }).success).toBe(true)
    expect(updateMaterialBody.safeParse({ name: 'x' }).success).toBe(false)
    expect(listMaterialsQuery.parse({ kind: 'leather, LINING', requiresCrViTest: 'true' })).toMatchObject({ kind: ['LEATHER', 'LINING'], requiresCrViTest: true, status: 'ACTIVE', limit: 50 })
    expect(listMaterialsQuery.safeParse({ kind: 'LEATHER,SHOES' }).success).toBe(false)
  })
})

describe('the material permissions and events', () => {
  it('declares view, manage and cost in the product area and gives them to the templates that work with materials', () => {
    expect(FACTORY_PERMISSIONS.get('product.materials.view')).toMatchObject({ area: 'product', risk: 'read' })
    expect(FACTORY_PERMISSIONS.get('product.materials.manage')).toMatchObject({ area: 'product', risk: 'write' })
    expect(FACTORY_PERMISSIONS.get('product.materials.cost')).toMatchObject({ area: 'product', risk: 'write' })
    const holders = (permission: string) => ROLE_TEMPLATES.filter((role) => role.permissions.includes(permission as never)).map((role) => role.key)
    expect(holders('product.materials.manage')).toEqual(['owner', 'buyer', 'production_manager'])
    expect(holders('product.materials.cost')).toEqual(['owner', 'finance', 'buyer'])
    // Everyone who may change a cost also sees it.
    for (const role of ROLE_TEMPLATES.filter((entry) => entry.permissions.includes('product.materials.cost'))) expect(role.grains).toContain('cost')
    expect(holders('product.materials.view')).toEqual(['owner', 'finance', 'sales', 'planner', 'buyer', 'warehouse', 'production_manager', 'quality_inspector', 'floor_supervisor', 'read_only'])
  })

  it('declares the material events with ids and codes only, never a cost', () => {
    const types = EVENT_CATALOGUE.types().filter((type) => type.startsWith('material.'))
    expect(types).toEqual(['material.colours_changed', 'material.created', 'material.standard_cost_changed', 'material.status_changed', 'material.updated'])
    for (const type of types) {
      const keys = Object.keys(EVENT_CATALOGUE.get(type, 1).payload.shape)
      expect(keys.some((key) => /cost|price|amount/i.test(key))).toBe(false)
    }
  })
})
