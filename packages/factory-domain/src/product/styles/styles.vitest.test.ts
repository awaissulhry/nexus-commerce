import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { canTransition } from '../../state/machine'
import { colourwayCodeChangeRefusal, colourwayListProblems, normaliseColourway } from './colourways'
import { createStyleBody, listStylesQuery, updateSkuBody, updateStyleBody } from './contracts'
import { EMPTY_PLAN, followPlan, generatePlan, isOffered, missingCells, offeredCells, skuClashes, type MatrixColourway, type MatrixVariant } from './matrix'
import { PRODUCT_STYLES_MANAGE, PRODUCT_STYLES_VIEW } from './permissions'
import { currentRevision, newRevisionRefusal, nextRevisionNumber, revisionState, styleRevisionMachine } from './revisions'
import {
  changeStyle,
  classOfStandard,
  garmentTracking,
  garmentTrackingRefusal,
  newStyle,
  ppeProblems,
  reactivatedStatus,
  styleChangeRefusals,
  styleMachine,
  styleWarnings,
  type ScaleSizes,
  type StyleFields,
  type StyleInput,
} from './rules'
import { DEFAULT_SKU_PATTERN, gtinCheckDigit, parseGtin, skuOf, skuProblem } from './sku'

/** Made-up styles: nothing here is a real product, brand or barcode owner. */
const SCALE: ScaleSizes = ['46', '48', '50', '52', '54', '56', '58'].map((code, index) => ({ code, seq: index + 1, status: code === '46' ? 'ARCHIVED' : 'ACTIVE' }))
const SCALE_ID = '0190a2b4-0000-7000-8000-00000000a001'
const JACKET: StyleInput = {
  code: 'gt-jkt-01',
  name: 'Touring jacket',
  productType: 'JACKET',
  sizeScaleId: SCALE_ID,
  sizes: ['54', '50', '52'],
  baseSize: '52',
  ppeCategory: 'CATEGORY_II',
  ppeStandard: 'en 17092-4:2020',
}

const made = (input: StyleInput): StyleFields => {
  const outcome = newStyle(input, SCALE)
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
  return outcome.style
}
const issuesOf = (input: StyleInput) => {
  const outcome = newStyle(input, SCALE)
  return outcome.ok ? [] : outcome.issues
}

describe('a new style (PRD-001, PRD-048)', () => {
  it('upper-cases the code, puts the range in the scale order and fills in the class of an EN 17092 part', () => {
    expect(made(JACKET)).toEqual({
      code: 'GT-JKT-01',
      name: 'Touring jacket',
      nameI18n: null,
      description: null,
      productType: 'JACKET',
      season: null,
      brandPartyId: null,
      sizeScaleId: SCALE_ID,
      sizes: ['50', '52', '54'],
      baseSize: '52',
      ppeCategory: 'CATEGORY_II',
      ppeStandard: 'EN 17092-4:2020',
      ppeClass: 'A',
      mtmAllowed: false,
      measurementTemplateId: null,
      hsCode: null,
      originCountry: null,
      netMassKg: null,
    })
  })

  it('refuses sizes outside the scale, twice, archived ones, and a base size outside the range', () => {
    expect(issuesOf({ ...JACKET, sizes: ['50', '60'] })).toEqual([
      { path: 'sizes/1', message: "The style's size scale has no size 60." },
      { path: 'baseSize', message: 'The base size is one of the range: 50, 60.' },
    ])
    expect(issuesOf({ ...JACKET, sizes: ['50', '50', '52'] })).toEqual([{ path: 'sizes/1', message: 'Size 50 is listed twice.' }])
    expect(issuesOf({ ...JACKET, sizes: ['46', '52'] })).toEqual([{ path: 'sizes/0', message: 'Size 46 is archived in the scale: it is no longer added to a range.' }])
    expect(issuesOf({ ...JACKET, sizes: [], baseSize: '52' })).toEqual([{ path: 'baseSize', message: 'Choose the range before its base size.' }])
    expect(issuesOf({ ...JACKET, code: 'GT JKT' }).map((issue) => issue.path)).toEqual(['code'])
  })

  it('needs a template only for a style made to measure', () => {
    expect(issuesOf({ ...JACKET, measurementTemplateId: '0190a2b4-0000-7000-8000-00000000b001' })).toEqual([
      { path: 'measurementTemplateId', message: 'A measurement template is for a style that may be made to measure (mtmAllowed).' },
    ])
    expect(made({ ...JACKET, mtmAllowed: true, measurementTemplateId: '0190a2b4-0000-7000-8000-00000000b001' }).mtmAllowed).toBe(true)
  })
})

describe('the PPE classification of a style (PRD-270; Reg. (EU) 2016/425 Annex I)', () => {
  const ppe = (productType: StyleFields['productType'], ppeCategory: StyleFields['ppeCategory'], ppeStandard: string | null, ppeClass: string | null) => ppeProblems({ productType, ppeCategory, ppeStandard, ppeClass })

  it('has no standard or class when not PPE', () => {
    expect(ppe('JACKET', 'NOT_PPE', null, null)).toEqual([])
    expect(ppe('JACKET', 'NOT_PPE', 'EN 17092-4:2020', 'A').map((issue) => issue.path)).toEqual(['ppeStandard', 'ppeClass'])
  })

  it('reads the EN 17092 class from its part, and refuses another class or a glove', () => {
    expect(['2', '3', '4', '5', '6'].map((part) => classOfStandard(`EN 17092-${part}:2020`))).toEqual(['AAA', 'AA', 'A', 'B', 'C'])
    expect(ppe('JACKET', 'CATEGORY_II', 'EN 17092-3:2020', 'AA')).toEqual([])
    expect(ppe('JACKET', 'CATEGORY_II', 'EN 17092-3:2020', 'A')).toEqual([{ path: 'ppeClass', message: 'EN 17092-3:2020 is class AA.' }])
    expect(ppe('JACKET', 'CATEGORY_II', 'EN 17092:2020', 'AAA')).toEqual([])
    expect(ppe('JACKET', 'CATEGORY_II', 'EN 17092:2020', 'D')).toEqual([{ path: 'ppeClass', message: 'EN 17092 classes are AAA, AA, A, B, C.' }])
    expect(ppe('JACKET', 'CATEGORY_II', 'EN 17092-1:2020', null)[0]!.path).toBe('ppeStandard')
    expect(ppe('GLOVES', 'CATEGORY_II', 'EN 17092-4:2020', 'A')).toEqual([{ path: 'ppeStandard', message: 'Rider gloves are made to EN 13594, not EN 17092.' }])
    expect(ppe('JACKET', 'CATEGORY_I', 'EN 17092-4:2020', 'A')[0]!.path).toBe('ppeCategory')
  })

  it('keeps EN 13594 to gloves, with its levels', () => {
    expect(ppe('GLOVES', 'CATEGORY_II', 'EN 13594:2015', '1KP')).toEqual([])
    expect(ppe('GLOVES', 'CATEGORY_II', 'EN 13594:2015', 'A')).toEqual([{ path: 'ppeClass', message: 'EN 13594 levels are 1, 2, 1KP, 2KP.' }])
    expect(ppe('TROUSERS', 'CATEGORY_II', 'EN 13594:2015', '1')).toEqual([{ path: 'ppeStandard', message: 'EN 13594 is the standard of rider gloves.' }])
  })

  it('takes another standard as written, and refuses a class without a standard', () => {
    expect(ppe('VEST', 'CATEGORY_III', 'EN 1621-4:2013', null)).toEqual([])
    expect(ppe('VEST', 'CATEGORY_II', null, 'A')).toEqual([{ path: 'ppeClass', message: 'Name the standard the class is of.' }])
    expect(ppe('VEST', 'CATEGORY_II', 'something odd', null)[0]!.path).toBe('ppeStandard')
  })

  it('traces PPE garments by lot (art. 8(5))', () => {
    expect(garmentTracking({ ppeCategory: 'CATEGORY_II' })).toBe('LOT')
    expect(garmentTracking({ ppeCategory: 'NOT_PPE' })).toBe('NONE')
  })
})

describe('a change to a style', () => {
  const style = made(JACKET)

  it('names the fields that change and keeps the range in order', () => {
    const change = changeStyle(style, { sizes: ['56', '50', '52', '54'], name: 'Touring jacket II' }, SCALE)
    expect(change).toEqual({ ok: true, style: { ...style, name: 'Touring jacket II', sizes: ['50', '52', '54', '56'] }, changed: ['name', 'sizes'] })
  })

  it('keeps an archived size already in the range, but adds none', () => {
    const scale: ScaleSizes = SCALE.map((size) => (size.code === '54' ? { ...size, status: 'ARCHIVED' } : size))
    expect(changeStyle(style, { name: 'x' }, scale).ok).toBe(true)
    expect(changeStyle(style, { sizes: ['46', '50', '52', '54'] }, scale)).toMatchObject({ ok: false, issues: [{ path: 'sizes/0' }] })
  })

  it('clears the class when the standard moves, and sets the new part\'s class', () => {
    const change = changeStyle(style, { ppeStandard: 'EN 17092-2:2020' }, SCALE)
    expect(change).toMatchObject({ ok: true, style: { ppeStandard: 'EN 17092-2:2020', ppeClass: 'AAA' }, changed: ['ppeStandard', 'ppeClass'] })
    expect(changeStyle(style, { ppeCategory: 'NOT_PPE' }, SCALE)).toMatchObject({ ok: true, style: { ppeStandard: null, ppeClass: null } })
  })

  it('refuses a base size taken out of the range', () => {
    expect(changeStyle(style, { sizes: ['50', '54'] }, SCALE)).toMatchObject({ ok: false, issues: [{ path: 'baseSize' }] })
  })

  it('keeps the code and the scale of a style with SKUs', () => {
    const next = { ...style, code: 'GT-JKT-02', sizeScaleId: '0190a2b4-0000-7000-8000-00000000a002' }
    expect(styleChangeRefusals(style, next, { variants: 0 })).toEqual([])
    expect(styleChangeRefusals(style, next, { variants: 6 })).toEqual([
      'The style has SKUs, which start with its code: its code stays GT-JKT-01.',
      'The style has SKUs in sizes of its scale: its size scale stays.',
    ])
  })

  it('points out what is missing without refusing it', () => {
    expect(styleWarnings(style, { activeColourways: 2, missingCells: 0 })).toEqual([])
    expect(styleWarnings({ ...style, sizes: [], baseSize: null, ppeStandard: null, ppeClass: null, mtmAllowed: true }, { activeColourways: 0, missingCells: 3 }).map((warning) => warning.code)).toEqual([
      'NO_SIZE_RANGE',
      'NO_COLOURWAY',
      'SKUS_MISSING',
      'NO_PPE_STANDARD',
      'NO_MEASUREMENT_TEMPLATE',
    ])
  })
})

describe('the style machine (PRD-022)', () => {
  it('goes ACTIVE only with a released revision, and archives from any open state', () => {
    expect(canTransition(styleMachine, 'DRAFT', 'ACTIVE', { releasedRevision: false })).toMatchObject({ ok: false, reason: 'guard' })
    expect(canTransition(styleMachine, 'DRAFT', 'ACTIVE', { releasedRevision: true }).ok).toBe(true)
    expect(canTransition(styleMachine, 'ACTIVE', 'ARCHIVED', { releasedRevision: true }).ok).toBe(true)
    expect(canTransition(styleMachine, 'ACTIVE', 'DRAFT', { releasedRevision: true }).ok).toBe(false)
    expect(reactivatedStatus({ releasedRevision: true })).toBe('ACTIVE')
    expect(reactivatedStatus({ releasedRevision: false })).toBe('DRAFT')
  })
})

describe('colourways (PRD-004)', () => {
  it('normalise and check codes, never with the SKU separator', () => {
    expect(normaliseColourway({ code: ' blk ', name: ' Black ', description: ' ' })).toEqual({ code: 'BLK', name: 'Black', colourId: null, description: null })
    expect(colourwayListProblems([normaliseColourway({ code: 'BLK', name: 'Black' }), normaliseColourway({ code: 'BLK-RED', name: 'x' }), normaliseColourway({ code: 'blk', name: 'Again' })])).toEqual([
      { path: 'colourways/1/code', message: 'Expected 1 to 12 capital letters or digits, with . or _ inside (no -).' },
      { path: 'colourways/2/code', message: 'The style has colourway BLK already.' },
    ])
    expect(colourwayListProblems([normaliseColourway({ code: 'RED', name: 'Red' })], ['RED'])[0]!.message).toBe('The style has colourway RED already.')
    expect(colourwayCodeChangeRefusal('BLK', 3)).toMatch(/^Colourway BLK is in use/)
    expect(colourwayCodeChangeRefusal('BLK', 0)).toBeNull()
  })
})

describe('SKUs and GTINs (PRD-005)', () => {
  it('builds the SKU by the pattern, deterministically', () => {
    expect(skuOf({ style: 'GT-JKT-01', colourway: 'BLK', size: '52' })).toBe('GT-JKT-01-BLK-52')
    expect(skuOf({ style: 'GT-JKT-01', colourway: 'BLK', size: '52' }, { parts: ['style', 'size', 'colourway'], separator: '-' })).toBe('GT-JKT-01-52-BLK')
    expect(DEFAULT_SKU_PATTERN.parts).toEqual(['style', 'colourway', 'size'])
    expect(skuProblem('GT-JKT-01-BLK-52')).toBeNull()
    expect(skuProblem(`${'A'.repeat(60)}-BLK-52`)).toMatch(/shorten/)
  })

  it('checks the GS1 check digit and stores one canonical form (made-up restricted-circulation numbers)', () => {
    expect(gtinCheckDigit('200123456789')).toBe(3)
    expect(parseGtin('2001234567893')).toEqual({ ok: true, gtin: '2001234567893' })
    expect(parseGtin('2001 2345 6789 3')).toEqual({ ok: true, gtin: '2001234567893' })
    expect(parseGtin('02001234567893')).toEqual({ ok: true, gtin: '2001234567893' })
    expect(parseGtin('200123456788')).toEqual({ ok: true, gtin: '0200123456788' })
    expect(parseGtin('0200123456788')).toEqual({ ok: true, gtin: '0200123456788' })
    expect(parseGtin('20012342')).toEqual({ ok: true, gtin: '20012342' })
    expect(parseGtin('00000020012342')).toEqual({ ok: true, gtin: '20012342' })
    expect(parseGtin('12001234567890')).toEqual({ ok: true, gtin: '12001234567890' })
    expect(parseGtin('2001234567891')).toEqual({ ok: false, message: 'The last digit of the GTIN is not its check digit: it was mistyped.' })
    expect(parseGtin('200123456789')).toMatchObject({ ok: false })
    expect(parseGtin('20012345678A3')).toMatchObject({ ok: false })
    expect(parseGtin('0000000000000')).toEqual({ ok: false, message: 'A GTIN is not all zeros.' })
  })
})

describe('the colour x size matrix (PRD-005)', () => {
  const BLK: MatrixColourway = { id: 'c-blk', code: 'BLK', status: 'ACTIVE' }
  const RED: MatrixColourway = { id: 'c-red', code: 'RED', status: 'ACTIVE' }
  const offer = { colourways: [BLK, RED], sizes: ['50', '52', '54'] }
  const variant = (colourway: MatrixColourway, size: string, status: MatrixVariant['status'] = 'ACTIVE'): MatrixVariant => ({
    id: `v-${colourway.code}-${size}`,
    colourwayId: colourway.id,
    size,
    sku: `GT-JKT-01-${colourway.code}-${size}`,
    status,
  })

  it('generates one SKU per colourway and size: 2 colours x 3 sizes are 6 unique SKUs', () => {
    const plan = generatePlan('GT-JKT-01', offer, [])
    expect(plan.create.map((entry) => entry.sku)).toEqual(['GT-JKT-01-BLK-50', 'GT-JKT-01-BLK-52', 'GT-JKT-01-BLK-54', 'GT-JKT-01-RED-50', 'GT-JKT-01-RED-52', 'GT-JKT-01-RED-54'])
    expect(new Set(plan.create.map((entry) => entry.sku)).size).toBe(6)
    expect(skuClashes(plan, new Set())).toEqual([])
    expect(skuClashes(plan, new Set(['GT-JKT-01-RED-52']))).toEqual(['GT-JKT-01-RED-52'])
  })

  it('generates only the missing cells, and leaves a cell switched off as it is', () => {
    const variants = [variant(BLK, '50'), variant(BLK, '52', 'ARCHIVED')]
    expect(generatePlan('GT-JKT-01', offer, variants).create.map((entry) => `${entry.colourwayId}/${entry.size}`)).toEqual(['c-blk/54', 'c-red/50', 'c-red/52', 'c-red/54'])
    expect(missingCells(offer, variants)).toHaveLength(4)
    expect(offeredCells({ colourways: [BLK, { ...RED, status: 'ARCHIVED' }], sizes: ['50'] })).toEqual([{ colourwayId: 'c-blk', size: '50' }])
    expect(isOffered(offer, { colourwayId: 'c-red', size: '56' })).toBe(false)
  })

  it('follows the offer once generated: new cells made, removed ones archived, offered again restored', () => {
    const variants = [BLK, RED].flatMap((colourway) => ['50', '52', '54'].map((size) => variant(colourway, size)))
    const wider = followPlan('GT-JKT-01', offer, { ...offer, sizes: ['50', '52', '54', '56'] }, variants)
    expect(wider).toEqual({ create: [{ colourwayId: 'c-blk', size: '56', sku: 'GT-JKT-01-BLK-56' }, { colourwayId: 'c-red', size: '56', sku: 'GT-JKT-01-RED-56' }], archive: [], restore: [] })
    const narrower = followPlan('GT-JKT-01', offer, { ...offer, sizes: ['50', '52'] }, variants)
    expect(narrower).toEqual({ create: [], archive: ['v-BLK-54', 'v-RED-54'], restore: [] })
    const archivedRed = followPlan('GT-JKT-01', offer, { ...offer, colourways: [BLK, { ...RED, status: 'ARCHIVED' }] }, variants)
    expect(archivedRed.archive).toEqual(['v-RED-50', 'v-RED-52', 'v-RED-54'])
    const offAgain = variants.map((entry) => (entry.size === '54' ? { ...entry, status: 'ARCHIVED' as const } : entry))
    expect(followPlan('GT-JKT-01', { ...offer, sizes: ['50', '52'] }, offer, offAgain)).toEqual({ create: [], archive: [], restore: ['v-BLK-54', 'v-RED-54'] })
    // A cell switched off by hand stays off while its offer does not change.
    const handOff = variants.map((entry) => (entry.id === 'v-RED-50' ? { ...entry, status: 'ARCHIVED' as const } : entry))
    expect(followPlan('GT-JKT-01', offer, { ...offer, sizes: ['50', '52', '54', '56'] }, handOff).restore).toEqual([])
    // Before the matrix is generated, nothing follows.
    expect(followPlan('GT-JKT-01', offer, { ...offer, sizes: ['50'] }, [])).toBe(EMPTY_PLAN)
  })
})

describe('revisions (A1 §2.5)', () => {
  it('numbers revisions and keeps one open draft, none on an archived style', () => {
    expect(nextRevisionNumber([])).toBe(1)
    expect(nextRevisionNumber([{ revision: 1, status: 'OBSOLETE' }, { revision: 2, status: 'RELEASED' }])).toBe(3)
    expect(newRevisionRefusal('DRAFT', [{ revision: 1, status: 'DRAFT' }])).toMatch(/^Revision 1 is still a draft/)
    expect(newRevisionRefusal('ARCHIVED', [])).toMatch(/archived/)
    expect(newRevisionRefusal('ACTIVE', [{ revision: 1, status: 'RELEASED' }])).toBeNull()
    expect(currentRevision([{ revision: 1, status: 'OBSOLETE' }, { revision: 2, status: 'RELEASED' }])).toEqual({ revision: 2, status: 'RELEASED' })
    expect(revisionState([{ revision: 1, status: 'DRAFT' }])).toBe('DRAFT')
    expect(revisionState([])).toBe('NONE')
    expect(canTransition(styleRevisionMachine, 'RELEASED', 'DRAFT').ok).toBe(false)
  })
})

describe('contracts, permissions and events', () => {
  it('parses a style body and refuses unknown keys', () => {
    expect(createStyleBody.parse({ code: 'gt-1', name: 'x', productType: 'JACKET', sizeScaleId: SCALE_ID, sizes: ['xl'], colourways: [{ code: 'blk', name: 'Black' }] })).toMatchObject({
      code: 'GT-1',
      sizes: ['XL'],
      colourways: [{ code: 'BLK', name: 'Black' }],
    })
    expect(updateStyleBody.safeParse({ version: 1, colour: 'x' }).success).toBe(false)
    expect(updateSkuBody.safeParse({ version: 1, gtin: null }).success).toBe(true)
    expect(listStylesQuery.parse({ productType: 'jacket,trousers', status: 'ALL' })).toMatchObject({ productType: ['JACKET', 'TROUSERS'], status: 'ALL', limit: 50 })
    expect(listStylesQuery.safeParse({ productType: 'SHOES' }).success).toBe(false)
  })

  it('declares the permissions, gives them to the templates and declares the events', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(PRODUCT_STYLES_VIEW)).toBe(true)
    expect(FACTORY_PERMISSIONS.isDeclared(PRODUCT_STYLES_MANAGE)).toBe(true)
    const holders = (permission: string) => ROLE_TEMPLATES.filter((template) => template.permissions.includes(permission as never)).map((template) => template.key)
    expect(holders(PRODUCT_STYLES_MANAGE)).toEqual(['owner', 'production_manager'])
    expect(holders(PRODUCT_STYLES_VIEW)).toEqual(['owner', 'finance', 'sales', 'planner', 'buyer', 'warehouse', 'production_manager', 'quality_inspector', 'floor_supervisor', 'read_only'])
    for (const type of ['style.created', 'style.updated', 'style.status_changed', 'style.colourways_changed', 'style.skus_changed', 'style.revision_created', 'size_scale.created', 'size_scale.changed']) {
      expect(EVENT_CATALOGUE.find(type, 1)?.live?.permission).toBe(PRODUCT_STYLES_VIEW)
    }
  })
})

describe('garment numbering per style (Q31)', () => {
  it('changes while nothing was numbered; then says what fixed it', () => {
    expect(garmentTrackingRefusal({ code: 'GF-JKT-01', tracking: 'BATCH' }, { labels: 0, serials: 0, releases: 0 })).toBeNull()
    expect(garmentTrackingRefusal({ code: 'GF-JKT-01', tracking: 'BATCH' }, { labels: 2, serials: 0, releases: 0 })).toBe(
      'Style GF-JKT-01 has work orders with garment labels printed: its garments stay numbered by batch (Q31). Another numbering is a new style.',
    )
    expect(garmentTrackingRefusal({ code: 'GF-JKT-01', tracking: 'SERIAL' }, { labels: 1, serials: 4, releases: 1 })).toBe(
      'Style GF-JKT-01 has work orders with garment labels printed, serials given and garments released: its garments stay numbered by serial (Q31). Another numbering is a new style.',
    )
  })
})
