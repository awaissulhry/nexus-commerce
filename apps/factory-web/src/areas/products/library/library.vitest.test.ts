import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ITEM_KINDS, ITEM_SOURCINGS, ITEM_TRACKINGS, MATERIAL_WARNINGS, TANNAGES } from '@nexus/factory-domain/product/materials/rules'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { listAddress, recordAddress } from '../../../lib/records/record-links'
import { OFFICE_NAV, OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { permissionCheck } from '../../../lib/session/session'
import { designScreen as materialsScreen } from '../materials/fixtures'
import { designScreen as materialScreen } from '../materials/record/fixtures'
import { designScreen as operationsScreen } from '../operations/fixtures'
import { designScreen as operationScreen } from '../operations/record/fixtures'
import { designScreen as sizesScreen } from '../sizes/fixtures'
import { designScreen as scaleScreen } from '../sizes/record/fixtures'
import { LEATHER, ROWS } from '../materials/demo'
import { limitProblem } from '../materials/record/view/ComplianceTab'
import { archiveHeld, bodyOf, compositionSum, converterOf, costHeld, costInput, createHeld, draftFor, draftProblems, listQuery, MATERIAL_TILES, MATERIAL_VIEWS, materialsCsv, tabsFor, tilesFor, viewQuery, viewsFor } from '../materials/model'
import { codeFrozen, differenceText, minutesInput, OPERATION_TILES, OPERATION_VIEWS, updateHeld, viewQuery as operationQuery } from '../operations/model'
import { SHOULDER } from '../operations/fixtures'
import { badSizes, measureProblems, measuresOf, measureText, missingFor, moved, parseSizes, pointsOf, rangeText, reorderHeld, SCALE_TABS, SCALE_VIEWS, sizesText } from '../sizes/model'
import { EU_SCALE, NEW_SCALE } from '../sizes/fixtures'
import { canFor } from './demo'
import { libraryCan, writeProblem } from './model'
import { ApiError } from '../../../lib/api/errors'

const owner = canFor('owner')

describe('who may do what (permissions and the cost grain)', () => {
  it('the cost grain alone shows a cost; setting it needs product.materials.cost too', () => {
    expect(libraryCan(['product.materials.view']).seesCost).toBe(false)
    expect(libraryCan(['product.materials.view', 'money.cost']).seesCost).toBe(true)
    expect(libraryCan(['product.materials.view', 'money.cost']).materialsCost).toBe(false)
    expect(libraryCan(['product.materials.cost']).materialsCost).toBe(false)
    expect(libraryCan(['product.materials.cost', 'money.cost']).materialsCost).toBe(true)
  })

  it('the role cases follow factory-domain\'s templates', () => {
    expect(canFor('developer')).toMatchObject({ materialsManage: true, operationsManage: true, scalesManage: true, seesCost: false })
    expect(canFor('quality')).toMatchObject({ materials: true, materialsManage: false, operations: true, certificates: true, lots: true, seesCost: false })
    expect(canFor('sales')).toMatchObject({ materials: true, operations: false, seesCost: false })
    expect(owner).toMatchObject({ materialsCost: true, seesCost: true })
  })

  it('a refusal reads its fields without the body part; a version conflict reads the record again', () => {
    const refused = writeProblem(new ApiError('invalid', 400, 'validation', 'no', null, [{ path: 'body/composition/1/percent', message: 'Expected a number' }]))
    expect(refused).toMatchObject({ key: 'problem.write.invalid', paths: ['composition/1/percent'], messages: ['Expected a number'] })
    expect(writeProblem(new ApiError('conflict', 409, 'version_conflict', 'moved')).reload).toBe(true)
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'The material code X is taken.')).key).toBe('problem.write.codeTaken')
  })
})

describe('Materials & trims rules (SCR-047/048)', () => {
  it('each saved view is a filter the API applies; Missing cost only with the cost grain', () => {
    expect(viewQuery('leather')).toEqual({ kind: ['LEATHER'] })
    expect(viewQuery('missingCost')).toEqual({ missingCost: true })
    expect(viewQuery('ppe')).toEqual({ ppeComponent: true })
    expect(viewQuery('crvi')).toEqual({ requiresCrViTest: true })
    expect(viewQuery('archived')).toEqual({ status: 'ARCHIVED' })
    expect(viewsFor({ seesCost: false })).not.toContain('missingCost')
    expect(tilesFor({ seesCost: false })).toEqual(['leather', 'crvi', 'ppe'])
    expect(tilesFor({ seesCost: true })).toEqual([...MATERIAL_TILES])
    // A kind picked inside a view narrows it; a kind outside the view's kinds keeps the view.
    expect(listQuery({ view: 'textiles', q: 'rete', kind: 'LINING' }, null)).toMatchObject({ kind: ['LINING'], q: 'rete' })
    expect(listQuery({ view: 'textiles', q: '', kind: 'THREAD' }, null).kind).toEqual(['TEXTILE', 'LINING', 'MEMBRANE', 'PADDING'])
    expect(listQuery({ view: 'open', q: '', kind: 'THREAD' }, 'c1')).toMatchObject({ kind: ['THREAD'], cursor: 'c1' })
  })

  it('the converter reads one hide in ft² and dm² (fixed factors inside a dimension, the article\'s own across)', () => {
    const converter = converterOf({ baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: '52.5', consumptionUom: 'DM2', consumptionFactor: null })
    expect(converter.purchase).toEqual({ uom: 'HIDE', inBase: 52.5 })
    expect(converter.consumption?.perPurchase).toBeCloseTo(487.74, 2)
    expect(converterOf({ baseUom: 'M', purchaseUom: 'M', purchaseFactor: null, consumptionUom: 'M', consumptionFactor: null })).toEqual({ purchase: null, consumption: null })
    expect(converterOf({ baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: '', consumptionUom: 'FT2', consumptionFactor: null }).purchase).toBeNull()
  })

  it('New material: a leather draft is checked by the domain\'s own rules as typed, and its body sends only what it may', () => {
    const fresh = draftFor('LEATHER', null)
    expect(fresh).toMatchObject({ baseUom: 'FT2', purchaseUom: 'HIDE', consumptionUom: 'DM2', tracking: 'HIDE', requiresCrViTest: true, crViLimitMgKg: '3' })
    const typed = { ...fresh, code: 'DEMO-X', name: 'Demo', purchaseFactor: '52,5', animalSpecies: 'Bovino', tannage: 'CHROME' as const, grade: 'A', thicknessMinMm: '1,1', thicknessMaxMm: '1,3', standardCost: '2,4' }
    expect(draftProblems(typed)).toEqual([])
    expect(createHeld(typed, [], false)).toBeNull()
    const paths = draftProblems({ ...typed, purchaseFactor: '', tannage: '', thicknessMaxMm: '1,0', crViLimitMgKg: '5' }).map((issue) => issue.path.split('/')[0])
    expect(paths).toEqual(expect.arrayContaining(['purchaseFactor', 'tannage', 'thicknessMaxMm', 'crViLimitMgKg']))
    expect(bodyOf(typed, { materialsCost: true })).toMatchObject({ purchaseFactor: '52.5', consumptionFactor: null, thicknessMinMm: '1.1', standardCost: '2.4', animalOrigin: true })
    expect('standardCost' in bodyOf(typed, { materialsCost: false })).toBe(false)
    // Switching the kind keeps code and name, resets what the kind decides.
    const thread = draftFor('THREAD', null, typed)
    expect(thread).toMatchObject({ code: 'DEMO-X', name: 'Demo', baseUom: 'M', purchaseUom: 'CONE', tracking: 'NONE', requiresCrViTest: false })
    expect(draftFor('COMPONENT', null, typed)).toMatchObject({ sourcing: 'MAKE', supplier: null })
  })

  it('bulk actions are held with their reason before the click', () => {
    const archived = ROWS.find((row) => row.status === 'ARCHIVED')!
    expect(archiveHeld([ROWS[0]!], owner)).toBeNull()
    expect(archiveHeld([ROWS[0]!, archived], owner)).toBe('list.bulk.archiveHeld')
    expect(archiveHeld([ROWS[0]!], canFor('quality'))).toBe('held.noManage')
    expect(costHeld([ROWS[0]!], canFor('developer'))).toBe('held.noCost')
    expect(costHeld([archived], owner)).toBe('list.bulk.costArchived')
    expect(costInput('2,45')).toBe('2.45')
    expect(costInput('')).toBeNull()
    expect(costInput('2.4.5')).toBeUndefined()
  })

  it('the Cr VI limit is refused above the law, composition must make 100 %', () => {
    expect(limitProblem('3')).toBeNull()
    expect(limitProblem('2,5')).toBeNull()
    expect(limitProblem('3,1')).toBe('law')
    expect(limitProblem('0')).toBe('number')
    expect(limitProblem('')).toBe('empty')
    expect(compositionSum([{ percent: '88' }, { percent: '12' }])).toBe(100)
    expect(compositionSum([{ percent: '80,5' }, { percent: '' }])).toBe(80.5)
    expect(compositionSum([])).toBeNull()
  })

  it('Stock is a tab only for those who read stock; the CSV drops the cost column without the grain', () => {
    expect(tabsFor({ stock: false })).not.toContain('stock')
    const words = { header: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'COST', 'i', 'j', 'k', 'l', 'm'], kind: (x: string) => x, unit: (x: string) => x, status: (x: string) => x }
    expect(materialsCsv([ROWS[0]!], { ...words, seesCost: true }).split('\n')[0]).toContain('COST')
    expect(materialsCsv([ROWS[0]!], { ...words, seesCost: false })).not.toContain('COST')
    expect(MATERIAL_VIEWS).toContain('all')
  })
})

describe('Operations rules (SCR-049)', () => {
  it('views and tiles are the API\'s usage filters', () => {
    expect(operationQuery('unused')).toEqual({ usage: 'UNUSED' })
    expect(operationQuery('differs')).toEqual({ usage: 'DIFFERS' })
    expect(OPERATION_TILES).toEqual(['unused', 'differs'])
    expect(OPERATION_VIEWS[0]).toBe('open')
  })

  it('minutes as typed are the domain\'s own (rounded to 3 decimals, above 0)', () => {
    expect(minutesInput('4,25')).toEqual({ ok: true, minutes: '4.25' })
    expect(minutesInput('0.16667')).toEqual({ ok: true, minutes: '0.167' })
    expect(minutesInput('0.0004')).toEqual({ ok: false, reason: 'invalid' })
    expect(minutesInput(' ')).toEqual({ ok: false, reason: 'empty' })
    expect(differenceText('0.4', 'it')).toBe('+0,4')
    expect(differenceText('-0.3', 'en')).toBe('−0.3')
  })

  it('only a draft step that differs takes the library value; the code is frozen once copied', () => {
    const [draft, released, , same, obsolete] = SHOULDER.whereUsed
    expect(updateHeld(draft!, SHOULDER)).toBeNull()
    expect(updateHeld(released!, SHOULDER)).toBe('operation.used.held.released')
    expect(updateHeld(same!, SHOULDER)).toBe('operation.used.held.same')
    expect(updateHeld(obsolete!, SHOULDER)).toBe('operation.used.held.obsolete')
    expect(codeFrozen(SHOULDER)).toBe(true)
    expect(codeFrozen({ usedIn: 0 })).toBe(false)
  })
})

describe('Sizes & measurements rules (SCR-049)', () => {
  it('sizes typed or pasted in order, each once; a bad code is named', () => {
    expect(parseSizes('44, 46;48\n50 50')).toEqual(['44', '46', '48', '50'])
    expect(parseSizes(' s m  l ')).toEqual(['S', 'M', 'L'])
    expect(badSizes(['44', '46-48', 'XL'])).toEqual(['46-48'])
    expect(sizesText(EU_SCALE.codes)).toBe('44 46 48 … 64')
    expect(rangeText(['46', '48', '50'])).toBe('46–50')
    expect(SCALE_VIEWS).toEqual(['open', 'archived', 'all'])
    expect(SCALE_TABS).toEqual(['sizes', 'points', 'whereused'])
  })

  it('body measures in words, the points of a scale, what a size still lacks', () => {
    expect(pointsOf(EU_SCALE)).toEqual(['chest', 'height'])
    expect(measureText(EU_SCALE.sizes[4]!, 'chest', 'it')).toBe('100–104 cm')
    expect(measureText(EU_SCALE.sizes[10]!, 'height', 'en')).toBeNull()
    expect(measureText({ bodyMeasures: { waist: { min: '80', max: null, unit: 'cm' } } }, 'waist', 'en')).toBe('≥ 80 cm')
    expect(missingFor(EU_SCALE.sizes, 'height')).toBe(1)
    expect(pointsOf(NEW_SCALE)).toEqual([])
  })

  it('measures as typed: a range per point, min ≤ max, one unit per point', () => {
    const rows = [
      { point: 'chest', min: '100', max: '104', unit: 'cm' as const },
      { point: 'waist', min: '', max: '', unit: 'cm' as const },
    ]
    expect(measuresOf(rows)).toEqual({ chest: { min: '100', max: '104', unit: 'cm' } })
    expect(measureProblems(rows, { chest: 'cm' })).toEqual([])
    expect(measureProblems([{ point: 'chest', min: '104', max: '100', unit: 'cm' }], {})).toEqual([{ point: 'chest', reason: 'order' }])
    expect(measureProblems([{ point: 'chest', min: '100', max: '', unit: 'in' }], { chest: 'cm' })).toEqual([{ point: 'chest', reason: 'unit' }])
    expect(measureProblems([{ point: 'Chest', min: '1', max: '', unit: 'cm' }], {})).toEqual([{ point: 'Chest', reason: 'point' }])
    expect(measuresOf([{ point: 'chest', min: '', max: '', unit: 'cm' }])).toBeNull()
  })

  it('the order stays once styles use the scale; a move at an end is none', () => {
    expect(reorderHeld(EU_SCALE, owner)).toBe('scale.held.order')
    expect(reorderHeld(NEW_SCALE, owner)).toBeNull()
    expect(reorderHeld(NEW_SCALE, canFor('quality'))).toBe('held.noManage')
    expect(moved(['38', '40', '42'], '40', -1)).toEqual(['40', '38', '42'])
    expect(moved(['38', '40', '42'], '38', -1)).toBeNull()
  })
})

describe('navigation, pages and record links', () => {
  it('Products holds Materials & trims in Main and Operations, Sizes & measurements in Libraries (the approved tree\'s order)', () => {
    const products = officeNavFor(permissionCheck(['product.styles.view', 'product.materials.view', 'product.routing.view'])).areas.find((area) => area.id === 'products')!
    expect(products.sections?.map((section) => [section.id, section.items.map((item) => item.id)])).toEqual([
      ['products-main', ['products-styles', 'products-materials']],
      ['products-libraries', ['products-operations', 'products-sizes']],
    ])
    // Sales reads materials and styles, not routings: no Operations row.
    const sales = officeNavFor(permissionCheck(['product.styles.view', 'product.materials.view'])).areas.find((area) => area.id === 'products')!
    expect(sales.sections?.flatMap((section) => section.items.map((item) => item.id))).toEqual(['products-styles', 'products-materials', 'products-sizes'])
    expect(OFFICE_NAV.areas.find((area) => area.id === 'compliance')?.sections?.[0]?.items.map((item) => item.id)).toEqual(['compliance-certificates', 'compliance-labels', 'compliance-tests'])
  })

  it('each record opens its own page, each API list its page', () => {
    expect(recordAddress({ type: 'Item', id: LEATHER.id }, OFFICE_PAGES)).toBe(`/products/materials/${LEATHER.id}`)
    expect(recordAddress({ type: 'Operation', id: 'x' }, OFFICE_PAGES)).toBe('/products/operations/x')
    expect(recordAddress({ type: 'SizeScale', id: 'y' }, OFFICE_PAGES)).toBe('/products/sizes/y')
    expect(listAddress('/product/materials', { requiresCrViTest: 'true' }, OFFICE_PAGES)).toBe('/products/materials?requiresCrViTest=true')
    expect(listAddress('/product/size-scales', null, OFFICE_PAGES)).toBe('/products/sizes')
  })
})

// ---- every key and every design case ------------------------------------------------------------------------------------

const AREA = fileURLToPath(new URL('..', import.meta.url))
const FOLDERS = ['library', 'materials', 'operations', 'sizes']
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.') ? [path] : []
  })
}
const literalKeys = (): string[] => [
  ...new Set(
    FOLDERS.flatMap((folder) => sources(join(AREA, folder))).flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return [...text.matchAll(/\bt\(\s*'([a-zA-Z][\w.]+)'/g), ...text.matchAll(/'((?:held|newMaterial|newOperation|newScale|materials|material|operations|operation|sizes|scale|list|keys)\.[a-zA-Z][\w.]+)'/g)].map((match) => match[1]!)
    }),
  ),
]
const built = [
  ...ITEM_KINDS.flatMap((kind) => [`kind.${kind}`, `kindHint.${kind}`]),
  ...ITEM_SOURCINGS.map((value) => `sourcing.${value}`),
  ...ITEM_TRACKINGS.flatMap((value) => [`tracking.${value}`, `trackingHint.${value}`]),
  ...TANNAGES.map((value) => `tannage.${value}`),
  ...UOMS.map((uom) => `uom.${uom}`),
  ...WORK_CENTRE_KINDS.map((kind) => `department.${kind}`),
  ...MATERIAL_WARNINGS.map((code) => `material.warning.${code}`),
  ...MATERIAL_VIEWS.map((view) => `materials.view.${view}`),
  ...MATERIAL_TILES.flatMap((tile) => [`materials.tile.${tile}`, `materials.tileHint.${tile}`]),
  ...OPERATION_VIEWS.map((view) => `operations.view.${view}`),
  ...OPERATION_TILES.flatMap((tile) => [`operations.tile.${tile}`, `operations.tileHint.${tile}`]),
  ...SCALE_VIEWS.map((view) => `sizes.view.${view}`),
  ...SCALE_TABS.map((tab) => `scale.tab.${tab}`),
  ...['overview', 'colours', 'properties', 'suppliers', 'compliance', 'stock'].map((tab) => `material.tab.${tab}`),
  ...['definition', 'minutes', 'whereused'].map((tab) => `operation.tab.${tab}`),
  ...['empty', 'number', 'law'].map((reason) => `material.cp.limit.${reason}`),
  ...['point', 'number', 'order', 'unit', 'tooMany'].map((reason) => `scale.size.held.${reason}`),
  ...['loading', 'error', 'notFound', 'forbidden'].flatMap((state) => [`record.state.${state}.title`, `record.state.${state}.body`]),
  ...['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'contract', 'internal'].map((kind) => `problem.read.${kind}`),
  ...['moved', 'state', 'codeTaken', 'invalid', 'stepUp', 'signed_out', 'forbidden', 'not_found', 'rate_limited', 'unavailable', 'internal'].map((kind) => `problem.write.${kind}`),
]

describe('every key the libraries name exists in it and en', () => {
  for (const locale of LOCALES) {
    it(`library (${locale})`, () => {
      const dictionary = CATALOGUE[locale]?.library ?? {}
      const has = (key: string) => key in dictionary || `${key}_other` in dictionary
      const keys = [...literalKeys(), ...built].filter((key) => !key.startsWith('keys.search') && !['keys.rows', 'keys.cells', 'keys.open', 'keys.select', 'keys.range'].includes(key))
      expect(keys.length).toBeGreaterThan(400)
      expect(keys.filter((key) => !has(key))).toEqual([])
    })
  }
})

const PREFIXES = ['common', 'problem', 'held', 'list', 'record', 'save', 'keys', 'status', 'styleStatus', 'revisionStatus', 'certStatus', 'lotStatus', 'crViStatus', 'kindHint', 'sourcing', 'tracking', 'trackingHint', 'tannage', 'uom', 'department', 'converter', 'csv', 'materials', 'material', 'newMaterial', 'operations', 'operation', 'newOperation', 'sizes', 'scale', 'newScale']
const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*\\b`)

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

const SCREENS = [materialsScreen, materialScreen, operationsScreen, operationScreen, sizesScreen, scaleScreen] as DesignScreen<unknown>[]

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of SCREENS) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale).replace(/https?:\/\/[^"\s<]+/g, '').replace(/\b(?:product|compliance|quality|inventory|parties|money)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})

describe('money by grain (A1 §2.6): no cost reaches a person without the cost grain', () => {
  it('the record shows € for the Owner and never for the product developer, quality or sales; the list offers no cost view without the grain', () => {
    // The grid's cells are drawn in the browser only; the tiles and views are in the server render.
    const ownerList = render(materialsScreen as DesignScreen<unknown>, materialsScreen.cases.find((item) => item.id === 'owner')!.model, 'en')
    expect(ownerList).toContain('Missing standard cost')
    for (const id of ['developer', 'quality', 'sales', 'selected-developer', 'new-developer']) {
      const html = render(materialsScreen as DesignScreen<unknown>, materialsScreen.cases.find((item) => item.id === id)!.model, 'en')
      expect(html, id).not.toContain('€')
      expect(html, id).not.toContain('Missing standard cost')
    }
    expect(render(materialScreen as DesignScreen<unknown>, materialScreen.cases.find((item) => item.id === 'suppliers')!.model, 'en')).toContain('€')
    for (const id of ['overview-developer', 'overview-sales', 'suppliers-developer', 'compliance-quality']) {
      expect(render(materialScreen as DesignScreen<unknown>, materialScreen.cases.find((item) => item.id === id)!.model, 'en'), id).not.toContain('€')
    }
  })
})
