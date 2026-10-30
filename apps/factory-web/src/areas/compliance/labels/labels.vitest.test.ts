import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { renderLabel } from '@nexus/factory-domain/compliance/labels/render'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { LOCALES } from '../../../lib/i18n/locales'
import { I18nProvider } from '../../../lib/i18n/provider'
import { recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { CAN, GLOVES_R1, JACKET_R1, JACKET_R2, job, MANY, previewOf, ROWS, SHARED_R1, TSHIRT_R1, valuesFor, VEST_R1, detailOf } from './demo'
import { designScreen as listScreen } from './fixtures'
import {
  activateHeld,
  checkRows,
  contentOf,
  draftOf,
  factsOf,
  familyOf,
  isDirty,
  jobSettled,
  labelsCsvRows,
  languagesTyped,
  LIST_CAP,
  localActivation,
  localRender,
  mmWords,
  moveField,
  newLabelHeld,
  NEW_LABEL,
  optionalFields,
  partSum,
  patchOf,
  printedOrder,
  printStateOf,
  retireHeld,
  reviseHeld,
  saveHeld,
  sectionOf,
  setCare,
  sheetOf,
  testPrintHeld,
  tileCounts,
  toggleField,
  valuesOf,
  viewOf,
  viewRows,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'

const WORDS = { name: 'Label', ce: 'CE (stand-in)', pictogram: (standard: string, ppeClass: string) => `${standard} ${ppeClass} (stand-in)`, care: (words: string) => `${words} (stand-in)` }

describe('who may do what (the role templates)', () => {
  it('the owner and quality write and print; the product developer reads; sales has no access', () => {
    expect(CAN.owner).toMatchObject({ view: true, manage: true, printLabels: true, printView: true, styles: true })
    expect(CAN.quality).toMatchObject({ view: true, manage: true, printLabels: true })
    expect(CAN.developer).toMatchObject({ view: true, manage: false })
    expect(CAN.sales.view).toBe(false)
  })
})

describe('the list: views, search, tiles, CSV', () => {
  it('reads ?view= (else every label) and searches code, name, style and maker', () => {
    expect([viewOf('drafts'), viewOf('nonsense'), viewOf(null)]).toEqual(['drafts', 'all', 'all'])
    expect(viewRows(ROWS, 'drafts', '').map((row) => row.code)).toEqual(['LBL-DEMO-GLV-01', 'LBL-DEMO-JKT-01', 'LBL-DEMO-TSH-01', 'LBL-DEMO-VST-01'])
    expect(viewRows(ROWS, 'all', 'jkt').map((row) => `${row.code} r${row.revision}`)).toEqual(['LBL-DEMO-JKT-01 r1', 'LBL-DEMO-JKT-01 r2'])
    expect(viewRows(ROWS, 'active', 'officina').length).toBe(2)
  })

  it('a tile counts its view; unknown is null (drawn "—"), being read undefined; 500 read means "500+"', () => {
    expect(tileCounts(ROWS, false)).toEqual({ active: { count: 2, atLeast: false }, drafts: { count: 4, atLeast: false }, retired: { count: 1, atLeast: false } })
    expect(tileCounts(null, true).active).toEqual({ count: null, atLeast: false })
    expect(tileCounts(null, false).active.count).toBeUndefined()
    const full = Array.from({ length: LIST_CAP }, () => SHARED_R1)
    expect(tileCounts(full, false).active.atLeast).toBe(true)
    expect(MANY.length).toBeGreaterThan(30)
  })

  it('a CSV row per label, the API’s codes and sizes as written by a person', () => {
    const rows = labelsCsvRows([SHARED_R1], ['Code'], { status: () => 'Active', shared: 'Shared' })
    expect(rows[1]).toEqual(['LBL-DEMO-STD', 1, 'Etichetta aziendale standard', 'Shared', 'it en de fr', 'Officina Demo S.r.l.', 'Active', '50', '80', 0, SHARED_R1.updatedAt.slice(0, 10)])
    expect([mmWords('50.00'), mmWords('40.50'), mmWords('62.25')]).toEqual(['50', '40.5', '62.25'])
  })
})

describe('the builder: what Save sends', () => {
  it('nothing changed: no patch; a size written "50" is the same as "50.00"; only the changed fields go', () => {
    const draft = draftOf(JACKET_R2)
    expect(patchOf(JACKET_R2, draft)).toEqual({})
    expect(isDirty(JACKET_R2, { ...draft, widthMm: '50' })).toBe(false)
    expect(patchOf(JACKET_R2, { ...draft, name: ' Nuovo nome ', heightMm: '90,5' })).toEqual({ name: 'Nuovo nome', heightMm: '90.5' })
  })

  it('the content as the API reads it: empty optional texts are none, typed phrases trimmed, a decimal comma a point', () => {
    const content = contentOf({ ...draftOf(JACKET_R2), importerName: ' ', animalOriginTexts: { nl: ' Bevat … ', it: '' }, composition: [{ part: ' Esterno ', fibres: [{ fibre: 'lana', percent: '99,5' }] }] })
    expect(content.importerName).toBeNull()
    expect(content.layout.texts.animalOrigin).toEqual({ nl: 'Bevat …' })
    expect(content.composition).toEqual([{ part: 'Esterno', fibres: [{ fibre: 'lana', percent: '99.5' }] }])
  })

  it('fields move one place at a time; the optional ones are switched on and off; one care symbol per kind', () => {
    const draft = draftOf(JACKET_R1)
    const order = printedOrder(draft, true)
    expect(order.slice(0, 3)).toEqual(['ceMark', 'pictogram', 'standard'])
    const moved = moveField(draft, true, 'standard', -1)
    expect(moved.slice(0, 3)).toEqual(['ceMark', 'standard', 'pictogram'])
    expect(moveField(draft, true, 'ceMark', -1)).toEqual(draft.fields)
    expect(optionalFields(true)).toEqual(['class', 'colourway'])
    expect(optionalFields(false)).toEqual(['colourway', 'bodyMeasures'])
    expect(toggleField(draft, 'colourway', true)).toContain('colourway')
    const care = setCare(draft, 'WASH', 'wash-40')
    expect(care.filter((entry) => entry.symbol.startsWith('wash-'))).toEqual([{ symbol: 'wash-40', text: {} }])
    expect(care[0]!.symbol).toBe('wash-40')
    expect(setCare(draft, 'IRON', null).some((entry) => entry.symbol.startsWith('iron'))).toBe(false)
    expect(partSum({ part: 'x', fibres: [{ fibre: 'a', percent: '80' }, { fibre: 'b', percent: '19,5' }] })).toBe(99.5)
    expect(partSum({ part: 'x', fibres: [{ fibre: 'a', percent: '' }] })).toBeNull()
    expect(languagesTyped('de, FR it;de  es')).toEqual(['de', 'fr', 'it', 'es'])
  })
})

describe('the browser renders the draft as typed, with the rules the server uses', () => {
  it('saved content: the same label the server answered; typed content: the problems follow the typing', () => {
    const values = valuesFor('jacket')
    const server = previewOf(JACKET_R2, values).label
    expect(localRender(JACKET_R2, draftOf(JACKET_R2), values)).toEqual(server)
    expect(JSON.parse(JSON.stringify(renderLabel(factsOf(JACKET_R2, draftOf(JACKET_R2)), valuesOf(values))))).toEqual(server)
    const saved = localActivation(JACKET_R2, draftOf(JACKET_R2), values, '2026-10-29').map((issue) => familyOf(issue.path))
    expect(saved).toEqual(expect.arrayContaining(['composition', 'animalOrigin']))
    const fixed = { ...draftOf(JACKET_R2), composition: JACKET_R1.composition.map((part) => ({ part: part.part, fibres: part.fibres.map((fibre) => ({ ...fibre })) })), animalOriginTexts: { nl: 'Bevat niet-textieldelen van dierlijke oorsprong' } }
    expect(localActivation(JACKET_R2, fixed, values, '2026-10-29')).toEqual([])
    expect(localRender(JACKET_R2, fixed, null)).toBeNull()
  })

  it('the fixtures’ checks are the domain’s: the gloves ready, the vest needs its notified body, the t-shirt is not PPE', () => {
    expect(GLOVES_R1.problems).toEqual([])
    expect(GLOVES_R1.activatable).toBe(true)
    expect(VEST_R1.problems.map((issue) => issue.path)).toContain('layout/notifiedBodyNumber')
    const tshirt = previewOf(TSHIRT_R1, valuesFor('tshirt')).label
    expect(tshirt.blocks.map((block) => block.field)).not.toContain('ceMark')
  })
})

describe('the sheet: the rendered blocks as the DS label, stand-ins named as such', () => {
  it('the SAMPLE banner first; the CE mark, the pictogram and each care symbol are stand-in marks, never artwork', () => {
    const label = previewOf(JACKET_R1, valuesFor('jacket')).label
    const sheet = sheetOf(label, 50, 80, WORDS)
    expect(sheet.layout.blocks[0]).toMatchObject({ kind: 'text', text: 'SAMPLE - NOT FOR GARMENTS', bold: true })
    const kinds = Object.values(sheet.marks).map((mark) => mark.kind)
    expect(kinds.filter((kind) => kind === 'ce')).toHaveLength(1)
    expect(kinds.filter((kind) => kind === 'pictogram')).toHaveLength(1)
    expect(kinds.filter((kind) => kind === 'care')).toHaveLength(JACKET_R1.care.length)
    expect(Object.values(sheet.marks).every((mark) => mark.words.endsWith('(stand-in)'))).toBe(true)
    // A preview has no batch value: no bars, the printed placeholder line only.
    expect(sheet.layout.blocks.some((block) => block.kind === 'barcode')).toBe(false)
    expect(sheetOf(label, 50, 80, { ...WORDS, test: 'TEST' }).layout.blocks[0]).toMatchObject({ text: 'TEST' })
  })
})

describe('rule checks in our words, pointing to the field', () => {
  it('a path names its family and the builder section to fix it in', () => {
    expect(['makerAddress', 'importerName', 'composition/0/fibres', 'layout/texts/animalOrigin/nl', 'care/1/symbol', 'layout/notifiedBodyNumber', 'heightMm', 'style/ppeClass', 'certificate', 'pictogram', 'body/name', 'mystery'].map(familyOf)).toEqual([
      'maker',
      'importer',
      'composition',
      'animalOrigin',
      'care',
      'notifiedBody',
      'size',
      'style',
      'certificate',
      'class',
      'name',
      'other',
    ])
    expect([sectionOf('maker'), sectionOf('size'), sectionOf('style')]).toEqual(['lb-sec-maker', 'lb-sec-layout', null])
    const rows = checkRows([{ path: 'makerAddress', message: 'a' }], [{ path: 'makerPartyId', message: 'b' }])
    expect(rows.map((row) => [row.family, row.blocking])).toEqual([
      ['maker', true],
      ['maker', false],
    ])
  })
})

describe('held reasons, said before the click', () => {
  const draft = detailOf(JACKET_R2)
  const active = detailOf(JACKET_R1)
  it('Activate: the right, a draft, saved, no problem', () => {
    expect(activateHeld(draft, CAN.developer, 0, false)).toEqual({ key: 'held.noManage' })
    expect(activateHeld(active, CAN.owner, 0, false)).toEqual({ key: 'held.notDraft' })
    expect(activateHeld(draft, CAN.owner, 0, true)).toEqual({ key: 'held.unsaved' })
    expect(activateHeld(draft, CAN.owner, 2, false)).toEqual({ key: 'held.problems', params: { count: 2 } })
    expect(activateHeld(draft, CAN.owner, 0, false)).toBeNull()
  })
  it('New revision: one draft per code; Retire; a test print needs the right, print.labels and a printer; Save needs a change', () => {
    expect(reviseHeld(active, CAN.owner)).toEqual({ key: 'held.draftExists', params: { revision: 2 } })
    expect(reviseHeld(detailOf(SHARED_R1), CAN.owner)).toBeNull()
    expect(reviseHeld(draft, CAN.owner)).toEqual({ key: 'held.isDraft' })
    expect(retireHeld({ ...active, status: 'RETIRED' }, CAN.owner)).toEqual({ key: 'held.retired' })
    expect(testPrintHeld(CAN.developer, [])).toEqual({ key: 'held.noManage' })
    expect(testPrintHeld({ ...CAN.owner, printLabels: false }, [])).toEqual({ key: 'held.noPrint' })
    expect(testPrintHeld(CAN.owner, [])).toEqual({ key: 'held.noPrinter' })
    expect(testPrintHeld(CAN.owner, null)).toBeNull()
    expect(saveHeld(CAN.owner, false, false)).toEqual({ key: 'held.nothing' })
    expect(saveHeld(CAN.owner, true, true)).toEqual({ key: 'held.busy' })
  })
  it('New label: a style or a shared code, languages, a size within the builder’s range', () => {
    expect(newLabelHeld(NEW_LABEL, CAN.owner, false)).toEqual({ key: 'held.pickStyle' })
    expect(newLabelHeld({ ...NEW_LABEL, kind: 'shared', code: 'bad code' }, CAN.owner, false)).toEqual({ key: 'held.code' })
    expect(newLabelHeld({ ...NEW_LABEL, kind: 'shared', code: 'LBL-DEMO-NEW', languages: [] }, CAN.owner, false)).toEqual({ key: 'held.languages' })
    expect(newLabelHeld({ ...NEW_LABEL, kind: 'shared', code: 'LBL-DEMO-NEW', widthMm: '10' }, CAN.owner, false)).toEqual({ key: 'held.size' })
    expect(newLabelHeld({ ...NEW_LABEL, kind: 'shared', code: 'lbl-demo-new' }, CAN.owner, false)).toBeNull()
  })
})

describe('print jobs', () => {
  it('a job as the DS print state; asked about until printed or failed', () => {
    expect(printStateOf(job('FAILED'), (status) => status.toLowerCase(), 'jam')).toEqual({ status: 'failed', label: 'failed', detail: 'jam' })
    expect([jobSettled(job('QUEUED')), jobSettled(job('SENT')), jobSettled(job('PRINTED')), jobSettled(null)]).toEqual([false, false, true, false])
  })
  it('a label opens its own page once built', () => {
    expect(recordAddress({ type: 'LabelTemplate', id: JACKET_R1.id }, OFFICE_PAGES)).toBe(`/compliance/labels/${JACKET_R1.id}`)
  })
})

describe('every design case draws in both languages with no key left on screen', () => {
  const keys = new Set<string>()
  for (const namespace of ['labels', 'quality']) for (const key of Object.keys(CATALOGUE.en[namespace] ?? {})) keys.add(key.replace(/_(one|other)$/, ''))
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  // A key of the catalogue, or a key the code names that the catalogue lacks (a dotted word of ours left as is).
  const LEFT = /\b(?:list|row|tile|view|status|new|held|record|tab|action|save|notice|problem|field|section|optional|preset|presetHint|dateFormat|careKind|care|preview|source|sheet|checks|family|passed|fixElsewhere|activate|retire|revise|discard|test|print|prints|versions|keys|done|csv|noAccess|revisionStatus)\.[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*/
  const leftKey = (html: string): string | null => {
    for (const key of keys) {
      const at = html.indexOf(key)
      if (at < 0) continue
      const before = html[at - 1] ?? ' '
      const after = html[at + key.length] ?? ' '
      if (!/[\w.-]/.test(before) && !/[\w.]/.test(after)) return key
    }
    const text = html.replace(/<[^>]+>/g, ' ').replace(/compliance\.[a-z.]+|product\.[a-z.]+|print\.labels/g, '')
    return LEFT.exec(text)?.[0] ?? null
  }
  for (const screen of [listScreen, recordScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(200)
          expect(leftKey(html), `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('sales sees no label: the permission is named; the builder never draws a CE mark, only its stand-in', () => {
    const html = render(listScreen as DesignScreen<unknown>, listScreen.cases.find((item) => item.id === 'no-permission')!.model, 'en')
    expect(html).toContain('compliance.certificates.view')
    expect(html).not.toContain('LBL-DEMO-JKT-01')
    const builder = render(recordScreen as DesignScreen<unknown>, recordScreen.cases.find((item) => item.id === 'active')!.model, 'it')
    expect(builder).toContain('segnaposto')
    expect(builder).toContain('Il marchio CE, il pittogramma e i simboli di manutenzione sono segnaposto')
  })

  it('the product developer’s writes are held with their reason; no money anywhere', () => {
    const html = render(recordScreen as DesignScreen<unknown>, recordScreen.cases.find((item) => item.id === 'developer')!.model, 'en')
    expect(html).toContain('You can view this draft, not change it.')
    expect(html).not.toMatch(/<input[^>]*value="Giacca/)
    for (const screen of [listScreen, recordScreen] as DesignScreen<unknown>[]) for (const item of screen.cases) expect(render(screen, item.model, 'en'), item.id).not.toMatch(/€|EUR\b/)
  })
})
