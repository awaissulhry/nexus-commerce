import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { COPY_PARTS } from '@nexus/factory-domain/product/styles/copy'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { hasOwnWords, KNOWN_IMPORTERS } from '../../admin/import/model'
import { designScreen as operationsScreen } from '../operations/fixtures'
import { designScreen as bomScreen } from './bom/fixtures'
import { DEMO_PRICES, demoDuplicated, demoOffer, demoSheetImport, demoStyle, demoSubcontractedRouting, GRAINS, ROWS, STYLE_ID, WORKSHOPS } from './demo/fixtures'
import { blankDraft, draftFor, duplicateBody, duplicateHeld, duplicateProblemKey, noteWords, partWords, refusedAt, togglePart, type DuplicateModel } from './duplicate/duplicate-model'
import { SheetImportDialog } from './import/view/SheetImportDialog'
import { designScreen as listScreen } from './list/fixtures'
import { pickBaseList, pricesByStyle } from './list/list-model'
import { abilitiesOf } from './model'
import { customsDraftOf, customsErrors, customsPatch, hsCodeText, refusedCustoms } from './record/customs'
import { designScreen as recordScreen } from './record/fixtures'
import { designScreen as routingScreen } from './routing/fixtures'
import { subcontractDraftOf, subcontractPatch, subcontractProblems, workshopsFor } from './routing/subcontract-model'

/**
 * B-W2a-37 — the style studio every day: Duplicate style (and New style › Copy of a style), Import BOM and the BOM
 * export, customs and origin on the Overview, subcontracted routing steps, the styles phone card list, the list price
 * and margin columns, Import on the operations library. The W1 tests (styles.vitest.test.ts) stay as they were.
 */

describe('abilities W2a adds', () => {
  it('workshops from the parties list, imports from imports.run + files.upload, prices from pricelists.view', () => {
    expect(abilitiesOf(['parties.view', 'imports.run', 'files.upload', 'imports.apply', 'pricelists.view'])).toMatchObject({ workshops: true, imports: true, importsApply: true, prices: true })
    expect(abilitiesOf(['imports.run'])).toMatchObject({ workshops: false, imports: false, importsApply: false, prices: false })
  })
})

describe('Duplicate style: the offer, the draft, the body', () => {
  const offer = demoOffer()
  it('suggests "<code>-COPY" and the source name, and ticks every part the copy can take', () => {
    const draft = draftFor(offer)
    expect(draft.code).toBe('DEMO-JKT-01-COPY')
    expect(draft.name).toBe('Giacca Touring Demo')
    expect(draft.parts).toEqual(['BOM', 'ROUTING', 'MEASUREMENTS', 'LABELS'])
    // A typed code and name stay when the offer is read again.
    expect(draftFor(offer, { ...blankDraft(), code: 'MINE', name: 'Mine' })).toMatchObject({ code: 'MINE', name: 'Mine' })
  })

  it('a part held by the offer (W2b, not made to measure, the style\'s own label) never moves', () => {
    const held = demoOffer({ held: true })
    const draft = draftFor(held)
    expect(draft.parts).toEqual(['BOM', 'ROUTING'])
    expect(togglePart(draft, held, 'PICTURES')).toBe(draft)
    expect(togglePart(draft, held, 'LABELS')).toBe(draft)
    expect(togglePart(draft, held, 'BOM').parts).toEqual(['ROUTING'])
    expect(togglePart(togglePart(draft, held, 'BOM'), held, 'BOM').parts).toEqual(['BOM', 'ROUTING'])
  })

  it('says each part in our words, the API\'s reasons read by their shape', () => {
    const at = (part: string, o = offer) => partWords(o.parts.find((entry) => entry.part === part)!, o)
    expect(at('BOM')).toEqual({ key: 'duplicate.holds.bom', params: { count: 8, revision: 2 } })
    expect(at('PICTURES')).toEqual({ key: 'duplicate.reason.PICTURES' })
    expect(at('OPTIONS')).toEqual({ key: 'duplicate.reason.OPTIONS' })
    const held = demoOffer({ held: true })
    expect(at('MEASUREMENTS', held)).toEqual({ key: 'duplicate.reason.notMtm', params: { code: 'DEMO-JKT-01' } })
    expect(at('LABELS', held)).toEqual({ key: 'duplicate.reason.ownLabel', params: { label: 'LBL-DEMO-01 r2', code: 'DEMO-JKT-01' } })
    const none = demoOffer({ noRevision: true })
    expect(at('ROUTING', none)).toEqual({ key: 'duplicate.reason.noRevision', params: { code: 'DEMO-JKT-01' } })
    const part = (reason: string, name: 'BOM' | 'ROUTING' | 'LABELS') => partWords({ part: name, available: false, count: null, reason }, offer)
    expect(part('Copying the BOM needs product.bom.manage over every company.', 'BOM')).toEqual({ key: 'duplicate.reason.noRight.BOM' })
    expect(part('Revision 2 has no BOM lines.', 'BOM')).toEqual({ key: 'duplicate.reason.noLines', params: { revision: 2 } })
    expect(part('Revision 2 has no routing steps.', 'ROUTING')).toEqual({ key: 'duplicate.reason.noSteps', params: { revision: 2 } })
    expect(part('Label LBL-X r3 is retired.', 'LABELS')).toEqual({ key: 'duplicate.reason.retiredLabel', params: { label: 'LBL-X r3' } })
    expect(part('Revision 2 has no garment label.', 'LABELS')).toEqual({ key: 'duplicate.reason.noLabel', params: { revision: 2 } })
    expect(part('Something new.', 'LABELS')).toEqual({ key: 'duplicate.reason.other' })
  })

  it('says what the copy left out in our words, never the API\'s sentence', () => {
    expect(noteWords("Size(s) 58, 60 are archived in the scale: the copy's range leaves them out.")).toEqual({ key: 'duplicate.note.sizes', params: { sizes: '58, 60' } })
    expect(noteWords('2 archived colourway(s) are not copied.')).toEqual({ key: 'duplicate.note.colourways', params: { count: 2 } })
    expect(noteWords("Colourway RED: its library colour is archived or another company's; the copy has none.")).toEqual({ key: 'duplicate.note.colour', params: { code: 'RED' } })
    expect(noteWords('3 BOM line(s) of archived colourways are not copied.')).toEqual({ key: 'duplicate.note.lines', params: { count: 3 } })
    expect(noteWords('Anything else.')).toEqual({ key: 'duplicate.note.other' })
    for (const note of demoDuplicated().notes) expect(noteWords(note).key).not.toBe('duplicate.note.other')
  })

  it('holds Duplicate with its reason, in order', () => {
    const base: Pick<DuplicateModel, 'source' | 'offer' | 'draft' | 'busy'> = { source: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'x' }, offer: { status: 'ready', value: offer }, draft: { ...draftFor(offer), code: 'DEMO-JKT-01-SS' }, busy: false }
    expect(duplicateHeld(base, { manage: false })).toEqual({ key: 'held.noManage' })
    expect(duplicateHeld({ ...base, source: null }, { manage: true })).toEqual({ key: 'duplicate.held.source' })
    expect(duplicateHeld({ ...base, offer: { status: 'loading' } }, { manage: true })).toEqual({ key: 'duplicate.held.reading' })
    expect(duplicateHeld({ ...base, offer: { status: 'error', problem: 'x' } }, { manage: true })).toEqual({ key: 'duplicate.held.offer' })
    expect(duplicateHeld({ ...base, draft: { ...base.draft, code: '-BAD' } }, { manage: true })).toEqual({ key: 'duplicate.held.code' })
    expect(duplicateHeld({ ...base, draft: { ...base.draft, code: 'demo-jkt-01' } }, { manage: true })).toEqual({ key: 'duplicate.held.sameCode' })
    expect(duplicateHeld({ ...base, draft: { ...base.draft, name: ' ' } }, { manage: true })).toEqual({ key: 'duplicate.held.name' })
    expect(duplicateHeld({ ...base, busy: true }, { manage: true })).toEqual({ key: 'held.busy' })
    expect(duplicateHeld(base, { manage: true })).toBeNull()
  })

  it('sends what was typed and ticked: the code upper case, a blank season left out, the offer\'s revision', () => {
    const draft = { ...draftFor(offer), code: ' demo-jkt-01-ss ', name: ' Estiva ', season: '', parts: ['ROUTING', 'BOM'] as const, generateSkus: true }
    expect(duplicateBody({ ...draft, parts: [...draft.parts] }, offer)).toEqual({ code: 'DEMO-JKT-01-SS', name: 'Estiva', parts: ['BOM', 'ROUTING'], fromRevisionId: offer.revision!.id, generateSkus: true })
    // A part the offer holds is never sent, even when the draft names it.
    expect(duplicateBody({ ...draft, parts: ['LABELS'], season: 'SS28', generateSkus: false }, demoOffer({ held: true })).parts).toEqual([])
    expect(duplicateBody({ ...draft, parts: [], season: 'SS28', generateSkus: false }, demoOffer({ noRevision: true }))).toEqual({ code: 'DEMO-JKT-01-SS', name: 'Estiva', season: 'SS28', parts: [] })
  })

  it('points at the refused field and says a refused part in our words', () => {
    expect(refusedAt(['body/parts/1'], 'parts')).toBe(true)
    expect(refusedAt(['code'], 'code')).toBe(true)
    expect(refusedAt(['body/name'], 'code')).toBe(false)
    expect(duplicateProblemKey({ key: 'problem.write.state', paths: ['body/parts/0'] })).toBe('duplicate.problem.part')
    expect(duplicateProblemKey({ key: 'problem.write.codeTaken', paths: ['code'] })).toBe('problem.write.codeTaken')
  })
})

describe('customs and origin on the identity card', () => {
  const style = demoStyle()
  it('checks as the domain does, in our words', () => {
    expect(customsErrors({ hsCode: '4203 10 00', originCountry: 'IT', netMassKg: '1,85' })).toEqual({})
    expect(customsErrors({ hsCode: '', originCountry: '', netMassKg: '' })).toEqual({})
    expect(customsErrors({ hsCode: '12345', originCountry: 'XX', netMassKg: '0' })).toEqual({ hsCode: 'customs.problem.hsCode', originCountry: 'customs.problem.origin', netMassKg: 'customs.problem.netMass' })
    expect(customsErrors({ hsCode: '7701.00', originCountry: 'EU', netMassKg: '1,2345' })).toEqual({ hsCode: 'customs.problem.chapter', originCountry: 'customs.problem.eu', netMassKg: 'customs.problem.netMass' })
  })

  it('sends only what changed: digits only, either decimal sign, a cleared field as null', () => {
    expect(customsPatch(style, customsDraftOf(style, 'it'))).toEqual({})
    expect(customsPatch(style, { hsCode: '4203.10.00', originCountry: 'IT', netMassKg: '1,850' })).toEqual({})
    expect(customsPatch(style, { hsCode: '6201 40', originCountry: 'RO', netMassKg: '2,1' })).toEqual({ hsCode: '620140', originCountry: 'RO', netMassKg: '2.1' })
    expect(customsPatch(style, { hsCode: '', originCountry: '', netMassKg: '' })).toEqual({ hsCode: null, originCountry: null, netMassKg: null })
  })

  it('reads the code the way customs papers print it, and finds a refused field', () => {
    expect(hsCodeText('42031000')).toBe('4203 10 00')
    expect(hsCodeText('6201409000')).toBe('6201 40 90 00')
    expect(hsCodeText(null)).toBe('—')
    expect(refusedCustoms(['body/hsCode'], 'hsCode')).toBe(true)
    expect(refusedCustoms(['body/hsCode'], 'netMassKg')).toBe(false)
  })
})

describe('subcontracted routing steps', () => {
  const routing = demoSubcontractedRouting()
  const sleeves = routing.steps.find((step) => step.code === 'CUC-MAN')!
  const cutting = routing.steps.find((step) => step.code === 'TAG-PEL')!
  const owner = GRAINS.owner
  const production = GRAINS.production

  it('offers the workshops of the style\'s company and of every company only', () => {
    expect(workshopsFor(WORKSHOPS, demoStyle().companyId).map((workshop) => workshop.code)).toEqual(['TERZ-DEMO-01', 'TERZ-DEMO-02'])
    expect(workshopsFor(WORKSHOPS, null).map((workshop) => workshop.code)).toEqual(['TERZ-DEMO-02'])
  })

  it('checks the workshop, the fee (cost grain only) and the days', () => {
    expect(subcontractProblems({ mode: 'in', supplierId: '', fee: 'x', days: 'x' }, owner)).toEqual({})
    expect(subcontractProblems({ mode: 'out', supplierId: '', fee: '-1', days: '400' }, owner)).toEqual({ supplierId: 'subcontract.problem.workshop', fee: 'subcontract.problem.fee', days: 'subcontract.problem.days' })
    expect(subcontractProblems({ mode: 'out', supplierId: 'w', fee: 'anything', days: '6' }, production)).toEqual({})
  })

  it('sends null to bring a step in-house, only what changed otherwise, never a fee without the cost grain', () => {
    const draft = subcontractDraftOf(sleeves, 'it')
    expect(draft).toEqual({ mode: 'out', supplierId: WORKSHOPS[0]!.id, fee: '4,5', days: '6' })
    expect(subcontractPatch(sleeves, draft, owner)).toBeUndefined()
    expect(subcontractPatch(sleeves, { ...draft, mode: 'in' }, owner)).toBeNull()
    expect(subcontractPatch(cutting, subcontractDraftOf(cutting, 'it'), owner)).toBeUndefined()
    expect(subcontractPatch(sleeves, { ...draft, fee: '4,75', days: '7' }, owner)).toEqual({ pricePerPiece: '4.75', transitDays: 7 })
    expect(subcontractPatch(sleeves, { ...draft, fee: '' }, owner)).toEqual({ pricePerPiece: null })
    expect(subcontractPatch(sleeves, { ...draft, supplierId: WORKSHOPS[1]!.id, fee: '', days: '' }, owner)).toEqual({ supplierId: WORKSHOPS[1]!.id })
    expect(subcontractPatch(cutting, { mode: 'out', supplierId: WORKSHOPS[0]!.id, fee: '3', days: '5' }, owner)).toEqual({ supplierId: WORKSHOPS[0]!.id, pricePerPiece: '3', transitDays: 5 })
    expect(subcontractPatch(cutting, { mode: 'out', supplierId: WORKSHOPS[0]!.id, fee: '3', days: '5' }, production)).toEqual({ supplierId: WORKSHOPS[0]!.id, transitDays: 5 })
  })
})

describe('list prices from the base list in force', () => {
  const list = (id: string, companyId: string | null, currency = 'EUR', state = 'IN_FORCE') => ({ id, companyId, code: id, name: id, kind: 'BASE', currency, state, shownVersion: { id: `${id}-v`, revision: 1 } })
  it('the company\'s own list first, then every company\'s; euros first; never one without a version in force', () => {
    expect(pickBaseList([list('ALL', null), list('OWN', 'c1')], 'c1')?.id).toBe('OWN')
    expect(pickBaseList([list('OTHER', 'c2'), list('ALL', null)], 'c1')?.id).toBe('ALL')
    expect(pickBaseList([list('USD', 'c1', 'USD'), list('EUR', 'c1')], 'c1')?.id).toBe('EUR')
    expect(pickBaseList([{ ...list('NONE', 'c1'), shownVersion: null }], 'c1')).toBeNull()
  })
  it('a style\'s own price wins; else the lowest colourway price, said "from"', () => {
    const prices = pricesByStyle(DEMO_PRICES.entries)
    expect(prices[STYLE_ID]).toEqual({ price: '389', from: false, marginPct: '41.2', belowFloor: false })
    expect(prices[ROWS[2]!.id]).toEqual({ price: '279', from: true, marginPct: '22.4', belowFloor: true })
    expect(prices[ROWS[4]!.id]).toBeUndefined()
    // Without the price grain the API leaves unitPrice out: no price at all.
    expect(pricesByStyle([{ styleId: 's', colourwayId: null, marginPct: '40' }])).toEqual({})
  })
})

describe('the importers have their own words', () => {
  it('product.bom and product.operations are known to the import screen', () => {
    expect(KNOWN_IMPORTERS).toContain('product.bom')
    expect(KNOWN_IMPORTERS).toContain('product.operations')
    expect(hasOwnWords('product.bom') && hasOwnWords('product.operations')).toBe(true)
  })
})

// ---- every key W2a names exists in it and en; every new case draws without a key left ------------------------------------

const W2A_PREFIXES = ['duplicate', 'customs', 'subcontract', 'phone']
const SRC = fileURLToPath(new URL('../../..', import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && entry.name !== 'fixtures.ts' ? [path] : []
  })
}
const has = (key: string) =>
  LOCALES.every((locale) => {
    const dictionary = CATALOGUE[locale].products ?? {}
    return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
  })

describe('every W2a key exists in it and en', () => {
  it('products', () => {
    const pattern = new RegExp(`['"\`]((?:${W2A_PREFIXES.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
    const literal = new Set<string>()
    for (const file of sources(join(SRC, 'areas/products/styles'))) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) literal.add(match[1]!)
    const built = [
      ...COPY_PARTS.map((part) => `duplicate.part.${part}`),
      ...['BOM', 'ROUTING', 'LABELS', 'MEASUREMENTS'].map((part) => `duplicate.reason.noRight.${part}`),
      ...['blank', 'copy', 'template', 'commerce'].flatMap((from) => [`newStyle.from.${from}`, `newStyle.fromHint.${from}`]),
      ...['template', 'commerce'].map((from) => `newStyle.fromWhen.${from}`),
      ...['xlsx', 'csv', 'pdf'].flatMap((format) => [`bom.export.${format}`, `bom.export.${format}Hint`]),
    ]
    expect(literal.size).toBeGreaterThan(80)
    expect([...literal, ...built].filter((key) => !has(key))).toEqual([])
  })
})

const ALL_PREFIXES = [...W2A_PREFIXES, 'list', 'newStyle', 'bom', 'routing', 'held', 'problem', 'notice', 'identity', 'record', 'action', 'cost', 'common', 'imp', 'operations']
const LEFT_KEY = new RegExp(`\\b(?:${ALL_PREFIXES.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*\\b`)

function render(view: ComponentType<{ model: unknown }>, model: unknown, locale: (typeof LOCALES)[number]): string {
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(view, { model })))
}
const clean = (html: string) => html.replace(/https?:\/\/[^"\s<]+/g, '').replace(/compliance\.certificates\.[a-z]+/g, '').replace(/\b[\w-]+\.(csv|xlsx|pdf)\b/g, '')

describe('every W2a design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen, bomScreen, routingScreen, operationsScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      const cases = screen.cases.filter((item) => item.label.startsWith('W2a'))
      it(`${screen.screen} in ${locale}: ${cases.length} W2a cases`, () => {
        expect(cases.length).toBeGreaterThan(0)
        for (const item of cases) {
          const html = clean(render(screen.view as ComponentType<{ model: unknown }>, item.model, locale))
          expect(html.length, item.id).toBeGreaterThan(100)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the import wizard on one importer says its name in both languages', () => {
    for (const locale of LOCALES) {
      for (const key of ['product.bom', 'product.operations'] as const) {
        for (const step of ['upload', 'planned', 'applied'] as const) {
          const html = clean(renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(SheetImportDialog, { model: demoSheetImport(key, step), inline: true }))))
          expect(html.match(/\bimp\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/)?.[0] ?? null, `${key} ${step} (${locale})`).toBeNull()
          expect(html).toContain(locale === 'it' ? (key === 'product.bom' ? 'Righe di distinta' : 'Operazioni') : key === 'product.bom' ? 'BOM lines' : 'Operations')
        }
      }
    }
  })
})

describe('money by grain in the W2a parts (A1 §2.6)', () => {
  const phone = listScreen.cases.find((item) => item.id === 'phone')!
  it('the phone list shows the list price with the price grain, nothing without it', () => {
    const html = render(listScreen.view as ComponentType<{ model: unknown }>, phone.model, 'en')
    expect(html).toContain('€389.00')
    const production = { ...(phone.model as object), grains: GRAINS.production, prices: { state: 'hidden' } }
    expect(render(listScreen.view as ComponentType<{ model: unknown }>, production, 'en')).not.toContain('€')
  })
  it('the routing shows the workshop\'s fee with the cost grain, "Not in your role" without', () => {
    const owner = routingScreen.cases.find((item) => item.id === 'subcontracted')!
    const production = routingScreen.cases.find((item) => item.id === 'subcontracted-production')!
    const ownerHtml = render(routingScreen.view as ComponentType<{ model: unknown }>, owner.model, 'en')
    expect(ownerHtml).toContain('€4.50 per piece')
    expect(ownerHtml).toContain('TERZ-DEMO-01')
    const productionHtml = render(routingScreen.view as ComponentType<{ model: unknown }>, production.model, 'en')
    expect(productionHtml).not.toContain('€')
    expect(productionHtml).toContain('fee: not in your role')
    expect(productionHtml).toContain('6 days there and back')
  })
})
