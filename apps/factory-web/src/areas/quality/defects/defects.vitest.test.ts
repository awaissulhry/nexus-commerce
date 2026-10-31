import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GARMENT_ZONES } from '@nexus/factory-domain/quality/defects/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, createScopedTranslator, messagesFor } from '../../../lib/i18n/messages'
import { LOCALES } from '../../../lib/i18n/locales'
import { I18nProvider } from '../../../lib/i18n/provider'
import { recordAddress, listAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { DISPOSITION_ROWS, DISPOSITIONS, LIBRARY, SAFETY, SEAMS } from './demo/fixtures'
import { designScreen } from './fixtures'
import {
  addressOf,
  amountText,
  approvalKeys,
  bulkActiveHeld,
  defectChange,
  deleteHeld,
  dispositionChange,
  fieldOfDefectEdit,
  fieldProblemsOf,
  libraryRows,
  NEW_DEFECT,
  NEW_DISPOSITION,
  newDefectBody,
  newDefectProblems,
  newDispositionBody,
  newDispositionProblems,
  parseAmount,
  problemOf,
  queryOf,
  retireLines,
  stepOpen,
  stockActionKeys,
  typedCode,
  withCode,
  withNewCode,
  withOutcome,
  withoutCode,
} from './model'
import { GarmentZoneMap } from './zones/GarmentZoneMap'
import { figureOf, OFF_SKETCH, PRIMARY_SHAPES, stepZone, ZONE_SHAPES, zoneWords } from './zones/zones'

const params = (query: string) => new URLSearchParams(query)
const OPEN_SEAM = SEAMS.defects[0]!

describe('the address', () => {
  it('reads the tab, the rows, the search, the open code and ?new=1; writes only what differs', () => {
    expect(addressOf(params('tab=dispositions&new=1'))).toMatchObject({ tab: 'dispositions', isNew: true, view: 'all' })
    expect(addressOf(params('tab=severity&view=retired&q=seam&open=x'))).toEqual({ tab: 'defects', view: 'retired', q: 'seam', open: 'x', isNew: false })
    expect(addressOf(null)).toEqual({ tab: 'defects', view: 'all', q: '', open: null, isNew: false })
    expect(queryOf({ tab: 'defects' })).toBe('')
    expect(queryOf({ tab: 'dispositions', view: 'active', q: 'a b', open: 'id' })).toBe('?tab=dispositions&view=active&q=a+b&open=id')
  })

  it('a hold opens on Holds; a library code opens its drawer here (record links)', () => {
    expect(recordAddress({ type: 'DefectCode', id: 'd1' }, OFFICE_PAGES)).toBe('/quality/defects?open=d1')
    expect(listAddress('/quality/defects', { tab: 'dispositions' }, OFFICE_PAGES)).toBe('/quality/defects?tab=dispositions')
  })
})

describe('the library as a tree', () => {
  it('each category, then its defects; a view and a search keep the categories that hold what matches', () => {
    const rows = libraryRows(LIBRARY, 'all', '')
    expect(rows[0]).toMatchObject({ kind: 'category', id: SEAMS.id, defects: 3 })
    expect(rows.slice(1, 4).every((row) => row.kind === 'defect' && row.category.id === SEAMS.id)).toBe(true)
    expect(rows.filter((row) => row.kind === 'category')).toHaveLength(4)
    const retired = libraryRows(LIBRARY, 'retired', '')
    expect(retired.map((row) => row.code.code)).toEqual(['DEMO-LEATHER', 'DEMO-SHADE'])
    // A search for the category's words shows its defects; one for a defect's words shows it under its category.
    expect(libraryRows(LIBRARY, 'all', 'cuciture').map((row) => row.code.code)).toEqual(['DEMO-SEAM', 'DEMO-SEAM-OPEN', 'DEMO-STITCH-SKIP', 'DEMO-PUCKER'])
    expect(libraryRows(LIBRARY, 'all', 'tonalita').map((row) => row.code.code)).toEqual(['DEMO-LEATHER', 'DEMO-SHADE'])
    expect(libraryRows(LIBRARY, 'all', 'zzz')).toEqual([])
    expect(libraryRows(null, 'all', '')).toEqual([])
  })

  it('replaces, adds and removes a code; the drawer walks the rows shown', () => {
    const renamed = withCode(LIBRARY, { ...OPEN_SEAM, labelEn: 'Seam open' })
    expect(renamed.categories[0]!.defects[0]!.labelEn).toBe('Seam open')
    const category = withCode(LIBRARY, { ...SEAMS, labelEn: 'Stitching' })
    expect(category.categories[0]!.defects).toHaveLength(3)
    expect(withoutCode(LIBRARY, OPEN_SEAM.id).categories[0]!.defects).toHaveLength(2)
    expect(withNewCode(LIBRARY, { ...OPEN_SEAM, id: 'new', code: 'DEMO-NEW' }).categories[0]!.defects).toHaveLength(4)
    expect(withNewCode(LIBRARY, { ...SEAMS, id: 'cat', parentId: null }).categories).toHaveLength(5)
    const rows = libraryRows(LIBRARY, 'all', '')
    expect(stepOpen(rows, rows[0]!.id, 1)).toBe(rows[1]!.id)
    expect(stepOpen(rows, rows[0]!.id, -1)).toBeNull()
    expect(stepOpen(rows, null, 1)).toBe(rows[0]!.id)
  })
})

describe('a cell change is the PATCH it sends, or why not', () => {
  it('words, class, zone, stages, note, look, order, the picture taken off', () => {
    expect(defectChange(OPEN_SEAM, 'labelEn', '  Seam open ')).toEqual({ edit: { labelEn: 'Seam open' } })
    expect(defectChange(OPEN_SEAM, 'labelEn', 'Open seam')).toBeNull()
    expect(defectChange(OPEN_SEAM, 'labelIt', ' ')).toEqual({ problem: 'problem.labelIt' })
    expect(defectChange(OPEN_SEAM, 'labelIt', 'x'.repeat(81))).toEqual({ problem: 'problem.tooLong' })
    expect(defectChange(OPEN_SEAM, 'severity', 'CRITICAL')).toEqual({ edit: { severity: 'CRITICAL' } })
    expect(defectChange(SEAMS, 'severity', 'MAJOR')).toEqual({ problem: 'problem.categorySeverity' })
    expect(defectChange(OPEN_SEAM, 'zone', 'BACK')).toEqual({ edit: { zone: 'BACK' } })
    expect(defectChange(OPEN_SEAM, 'zone', 'NOWHERE')).toEqual({ problem: 'problem.zone' })
    expect(defectChange(OPEN_SEAM, 'zone', null)).toEqual({ edit: { zone: null } })
    expect(defectChange(OPEN_SEAM, 'stages', ['FINAL', 'IN_LINE'])).toBeNull()
    expect(defectChange(OPEN_SEAM, 'stages', ['FINAL', 'INCOMING'])).toEqual({ edit: { stages: ['INCOMING', 'FINAL'] } })
    expect(defectChange(OPEN_SEAM, 'needsDetail', true)).toEqual({ edit: { needsDetail: true } })
    expect(defectChange(SEAMS, 'needsDetail', true)).toEqual({ problem: 'problem.categoryDetail' })
    expect(defectChange(OPEN_SEAM, 'look', { colour: '#1f6fde' })).toEqual({ edit: { colour: '#1f6fde' } })
    expect(defectChange(OPEN_SEAM, 'sortOrder', '5')).toEqual({ edit: { sortOrder: 5 } })
    expect(defectChange(OPEN_SEAM, 'sortOrder', '-1')).toEqual({ problem: 'problem.sortOrder' })
    expect(defectChange(OPEN_SEAM, 'picture', null)).toEqual({ edit: { pictureFileId: null } })
    expect(defectChange(OPEN_SEAM, 'lang:ro', 'Cusătură deschisă')).toEqual({ edit: { labelI18n: { ro: 'Cusătură deschisă' } } })
    expect(defectChange(OPEN_SEAM, 'active', false)).toEqual({ edit: { active: false } })
    expect(fieldOfDefectEdit({ labelI18n: { ro: null } })).toBe('lang:ro')
    expect(fieldOfDefectEdit({ colour: null })).toBe('look')
  })

  it('a disposition: words, re-inspection (never for use as is), the class rule, the value rule only with the cost grain', () => {
    const useAsIs = DISPOSITION_ROWS[0]!
    const scrap = DISPOSITION_ROWS.at(-1)!
    expect(dispositionChange(scrap, 'labelEn', 'Scrap it', true)).toEqual({ edit: { labelEn: 'Scrap it' } })
    expect(dispositionChange(useAsIs, 'reinspection', true, true)).toEqual({ problem: 'problem.reinspectUseAsIs' })
    expect(dispositionChange(scrap, 'approvalSeverity', 'CRITICAL', true)).toEqual({ edit: { approvalSeverity: 'CRITICAL' } })
    expect(dispositionChange(scrap, 'approvalAmount', '1.500,00', true)).toEqual({ edit: { approvalAmount: 150_000 } })
    expect(dispositionChange(scrap, 'approvalAmount', '1.500,00', false)).toEqual({ problem: 'problem.noCost' })
    expect(dispositionChange(scrap, 'approvalAmount', 'abc', true)).toEqual({ problem: 'problem.amount' })
    expect(dispositionChange(scrap, 'approvalAmount', '', true)).toEqual({ edit: { approvalAmount: null } })
  })

  it('reads amounts as people type them, in cents', () => {
    expect([parseAmount('120'), parseAmount('120,50'), parseAmount('1.200,50'), parseAmount('1,200.50'), parseAmount('120.5'), parseAmount(''), parseAmount('12a')]).toEqual([12_000, 12_050, 120_050, 120_050, 12_050, null, undefined])
    expect([amountText(120_050, 'it'), amountText(120_050, 'en'), amountText(null, 'it')]).toEqual(['1200,50', '1200.50', ''])
  })
})

describe('refusals in our words, held reasons before the click', () => {
  it('maps the API: stale, code taken, library full, in use, a field, forbidden, no answer', () => {
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'version' }]))).toEqual({ key: 'problem.stale', unknown: false })
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'Code X is taken by a retired code.')).key).toBe('problem.codeTakenRetired')
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'The library holds at most 500 codes: retire or delete some first.')).key).toBe('problem.libraryFull')
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'X is used on 3 records: retire it instead.')).key).toBe('problem.inUse')
    expect(problemOf(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/labelEn' }])).key).toBe('problem.labelEn')
    expect(problemOf(new ApiError('forbidden', 403, 'forbidden', 'x')).key).toBe('problem.forbidden')
    expect(problemOf(new ApiError('unavailable', 0, 'network', 'x'))).toEqual({ key: 'problem.offline', unknown: true })
    expect(fieldProblemsOf(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/code' }, { path: 'body/labelI18n/ro' }]))).toEqual({ code: 'problem.code', labelI18n: 'problem.language' })
  })

  it('delete only an unused code; never a category with defects; nobody without the right', () => {
    const rows = libraryRows(LIBRARY, 'all', '')
    const category = rows.find((row) => row.id === SEAMS.id)!
    const used = rows.find((row) => row.id === OPEN_SEAM.id)!
    const unused = rows.find((row) => row.id === SEAMS.defects[2]!.id)!
    expect(deleteHeld(category, true)).toEqual({ key: 'held.categoryHasDefects', params: { count: 3 } })
    expect(deleteHeld(used, true)).toEqual({ key: 'held.used', params: { count: 214 } })
    expect(deleteHeld(unused, true)).toBeNull()
    expect(deleteHeld(unused, false)).toEqual({ key: 'held.noManage' })
    expect(bulkActiveHeld([OPEN_SEAM], true, true, false)).toBe('held.allActive')
    expect(bulkActiveHeld([OPEN_SEAM], false, true, false)).toBeNull()
    expect(bulkActiveHeld([], false, true, false)).toBe('held.pickRows')
    expect(bulkActiveHeld([OPEN_SEAM], false, false, false)).toBe('held.noManage')
  })

  it('retire says what happens to each code (design df-retire)', () => {
    expect(retireLines([OPEN_SEAM, SEAMS.defects[2]!, SAFETY], { 'DEMO-SAFETY': 3 })).toEqual([
      { key: 'retire.used', params: { code: 'DEMO-SEAM-OPEN', count: 214 } },
      { key: 'retire.unused', params: { code: 'DEMO-PUCKER' } },
      { key: 'retire.category', params: { code: 'DEMO-SAFETY', count: 3 } },
    ])
  })
})

describe('drafts: Add defect and Add disposition', () => {
  it('the domain checks a new defect at its fields; a category has no class', () => {
    expect(Object.keys(newDefectProblems(NEW_DEFECT, LIBRARY)).sort()).toEqual(['code', 'labelEn', 'labelIt', 'parentId'])
    const ready = { ...NEW_DEFECT, parentId: SEAMS.id, code: 'DEMO-WAVY', labelIt: 'Ondulata', labelEn: 'Wavy', zone: 'BACK', stages: ['FINAL'] }
    expect(newDefectProblems(ready, LIBRARY)).toEqual({})
    expect(newDefectProblems({ ...ready, code: 'DEMO-SEAM-OPEN' }, LIBRARY)).toEqual({ code: 'problem.codeTaken' })
    expect(newDefectProblems({ ...ready, code: 'DEMO-SHADE' }, LIBRARY)).toEqual({ code: 'problem.codeTakenRetired' })
    expect(newDefectBody(ready)).toEqual({ code: 'DEMO-WAVY', parentId: SEAMS.id, labelIt: 'Ondulata', labelEn: 'Wavy', severity: 'MAJOR', zone: 'BACK', stages: ['FINAL'], needsDetail: false })
    const category = { ...ready, kind: 'category' as const, parentId: SEAMS.id, code: 'DEMO-HW' }
    expect(newDefectProblems(category, LIBRARY)).toEqual({})
    expect(newDefectBody(category)).toMatchObject({ parentId: null, severity: null, zone: null, needsDetail: false })
    expect(typedCode('seam open!')).toBe('SEAM-OPEN')
    expect(typedCode('scrap hide', 'disposition')).toBe('SCRAP_HIDE')
  })

  it('an outcome brings its default move and follow-up; the amount goes only with the cost grain', () => {
    const scrap = withOutcome(NEW_DISPOSITION, 'SCRAP', DISPOSITIONS.outcomes)
    expect(scrap).toMatchObject({ outcome: 'SCRAP', stockMoveReason: 'SCRAP', followUp: null, reinspection: false, code: 'SCRAP' })
    const rework = withOutcome(NEW_DISPOSITION, 'REWORK', DISPOSITIONS.outcomes)
    expect(rework).toMatchObject({ stockMoveReason: null, followUp: 'REWORK_ORDER', reinspection: true })
    expect(Object.keys(newDispositionProblems(NEW_DISPOSITION, [], true)).sort()).toEqual(['code', 'labelEn', 'labelIt', 'outcome'])
    const draft = { ...scrap, code: 'DEMO_SCRAP_HIDE', labelIt: 'Scarta pelle', labelEn: 'Scrap hide', approvalAmount: '120,50' }
    expect(newDispositionProblems(draft, ['DEMO_SCRAP'], true)).toEqual({})
    expect(newDispositionProblems({ ...draft, code: 'DEMO_SCRAP' }, ['DEMO_SCRAP'], true)).toEqual({ code: 'problem.codeTaken' })
    expect(newDispositionProblems({ ...draft, approvalAmount: 'lots' }, [], true)).toEqual({ approvalAmount: 'problem.amount' })
    expect(newDispositionBody(draft, true).approvalAmount).toBe(12_050)
    expect('approvalAmount' in newDispositionBody(draft, false)).toBe(false)
  })

  it('a code’s stock action and approval in our words', () => {
    expect(stockActionKeys(DISPOSITION_ROWS[1]!).map((line) => line.key)).toEqual(['move.none', 'followUp.REWORK_ORDER', 'reinspection.yes'])
    expect(stockActionKeys(DISPOSITION_ROWS.at(-1)!).map((line) => line.key)).toEqual(['move.SCRAP'])
    expect(approvalKeys(DISPOSITION_ROWS.at(-1)!).map((line) => line.key)).toEqual(['approval.severity.MAJOR', 'approval.amount'])
    expect(approvalKeys({ approvalSeverity: null, approvalAmount: undefined }).map((line) => line.key)).toEqual(['approval.noneSeen'])
  })
})

// ---- the garment zone map ---------------------------------------------------------------------------------------------------

const renderIn = (locale: (typeof LOCALES)[number], node: ReturnType<typeof createElement>) => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, node))

describe('GarmentZoneMap', () => {
  it('every zone of the domain has exactly one pressable place (a shape on a sketch, or a chip)', () => {
    for (const zone of GARMENT_ZONES) {
      const primaries = ZONE_SHAPES.filter((shape) => shape.zone === zone.id && !shape.copy)
      expect(primaries.length + (OFF_SKETCH.includes(zone.id) ? 1 : 0), zone.id).toBe(1)
    }
    expect(PRIMARY_SHAPES.length + OFF_SKETCH.length).toBe(GARMENT_ZONES.length)
    expect(OFF_SKETCH).toEqual(['LINING'])
    expect([figureOf('SLEEVE_L'), figureOf('ELBOW_R'), figureOf('KNEE_L'), figureOf('LINING'), figureOf(null)]).toEqual(['front', 'back', 'trousers', null, null])
  })

  it('the arrows walk every zone in order, round the end', () => {
    expect(stepZone(null, 1)).toBe('FRONT')
    expect(stepZone('FRONT', -1)).toBe('LABEL')
    expect(stepZone('LABEL', 1)).toBe('FRONT')
    expect(stepZone('COLLAR', 1)).toBe('SHOULDER')
  })

  it("names each zone in the person's language; the picked one by outline, pin and words", () => {
    expect([zoneWords('ELBOW_L', 'it'), zoneWords('ELBOW_L', 'en'), zoneWords('ELBOW_L', 'ro'), zoneWords(null, 'it'), zoneWords('X', 'en')]).toEqual(['Gomito sinistro', 'Left elbow', 'Left elbow', '', 'X'])
    const html = renderIn('it', createElement(GarmentZoneMap, { label: 'Dove', value: 'CHEST', onChange: () => undefined }))
    // Every zone is a button with its Italian name; only the picked one is pressed; one Tab stop.
    expect((html.match(/role="button"/g) ?? []).length).toBe(PRIMARY_SHAPES.length)
    expect(html).toContain('aria-label="Petto"')
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1)
    expect((html.match(/tabindex="0"/gi) ?? []).length).toBe(1)
    expect(html).toContain('fw-zone-pin')
    expect(html).toContain('Zona: Petto')
    // The list holds every zone and "No zone".
    expect((html.match(/<option/g) ?? []).length).toBe(GARMENT_ZONES.length + 1)
    expect(html).toContain('Fodera')
  })

  it('read-only (or held with a reason): the pin and the words, nothing pressable, no list', () => {
    const html = renderIn('en', createElement(GarmentZoneMap, { label: 'Where', value: 'LINING', readOnly: true }))
    expect(html).not.toContain('role="button"')
    expect(html).not.toContain('<select')
    expect(html).toContain('Zone: Lining')
    const held = renderIn('en', createElement(GarmentZoneMap, { label: 'Where', value: null, onChange: () => undefined, heldReason: 'Signed: it no longer changes.' }))
    expect(held).not.toContain('role="button"')
    expect(held).toContain('Signed: it no longer changes.')
    expect(held).toContain('No zone picked')
  })
})

// ---- every design case, both languages, no key on screen ------------------------------------------------------------------

const KEYS = Object.keys(CATALOGUE.en.defects ?? {})
const PREFIXES = [...new Set(KEYS.map((key) => key.split('.')[0]!))].filter((prefix) => prefix.length > 2)
const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.join('|')})\\.[a-zA-Z][a-zA-Z0-9_]*(?:\\.[a-zA-Z0-9_]+)*`)

describe('every design case draws in both languages with no key left on screen', () => {
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  for (const locale of LOCALES) {
    it(`SCR-079 in ${locale}: ${designScreen.cases.length} cases`, () => {
      for (const item of designScreen.cases) {
        const html = render(designScreen as DesignScreen<unknown>, item.model, locale).replace(/(?:href|src|id|class|aria-[a-z]+|data-[a-z-]+|name|for|value|lang)="[^"]*"/g, '')
        expect(html.length, item.id).toBeGreaterThan(300)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-079/${item.id} (${locale})`).toBeNull()
      }
    })
  }

  it('Italian words where English would be (a sample)', () => {
    const it = createScopedTranslator('it', messagesFor('it', ['defects']), 'defects')
    expect(it('head.addDefect')).toBe('Aggiungi difetto')
    expect(it('retire.used', { code: 'X', count: 3 })).toBe('X è usato su 3 ispezioni o NC; resta su di esse ed esce dagli elenchi di scelta.')
  })

  it('the amount rule shows only with the cost grain (the API leaves it out; the cells read the rows as given)', () => {
    const noCost = designScreen.cases.find((item) => item.id === 'dispositions-no-cost')!.model as { model: { seesCost: boolean; dispositions: { value: { dispositions: { approvalAmount?: number | null }[] } } } }
    const withCost = designScreen.cases.find((item) => item.id === 'dispositions')!.model as typeof noCost
    expect(noCost.model.seesCost).toBe(false)
    expect(noCost.model.dispositions.value.dispositions.every((row) => !('approvalAmount' in row))).toBe(true)
    expect(withCost.model.seesCost).toBe(true)
    expect(withCost.model.dispositions.value.dispositions.some((row) => typeof row.approvalAmount === 'number')).toBe(true)
  })
})
