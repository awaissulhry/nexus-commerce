import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CHECK_CODES } from '@nexus/factory-domain/quality/lab/rules'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { recordAddress } from '../../../lib/records/record-links'
import { canFor } from '../../_shared/stock/fixtures'
import { HIDE_ROWS, hideRecordOf, printDialog, PRINTERS, tag } from '../hides/demo/fixtures'
import { designScreen as hidesScreen } from '../hides/list/fixtures'
import { designScreen as hideScreen } from '../hides/record/fixtures'
import { exactHide, HIDE_CSV_COLUMNS, HIDE_VIEWS, hideLabel, hideQuery, hideViewOf, nextStepKey, printHeldKey, tagHeldKey, tagLayout } from '../hides/model'
import { CHECKLIST_OPEN, CHECKLIST_RELEASED, LOT_ROWS, lotRecordOf } from './demo/fixtures'
import { designScreen as lotsScreen } from './list/fixtures'
import { checkKey, checklistHead, defaultLotView, exactLot, LOT_CSV_COLUMNS, LOT_VIEWS, lotQuery, lotTabOf, lotViewOf, traceSummary } from './model'
import { designScreen as lotScreen } from './record/fixtures'
import { areaParts, runningBalances, share } from './shared/model'

/**
 * Warehouse › Hides (SCR-200, SCR-200-record) and Lots & traceability (SCR-201, SCR-201-record): the pure rules (views ⇄
 * the API's filters, a scanned code's one hit, the running balance, a hide's area in parts that add up, the tag and its
 * label, the checklist in our words, the trace in one sentence) and every design case drawn in Italian and English with
 * no message key or placeholder left on screen.
 */

const params = (query: string) => new URLSearchParams(query)

describe('lots: views and the API’s own filters', () => {
  it('maps every view to the API’s query and reads the address (also the API’s own filters)', () => {
    expect(lotQuery('waiting', ' LOT ', 's1')).toEqual({ siteId: 's1', q: 'LOT', cursor: null, limit: 50, onHold: true })
    expect(lotQuery('inStock', '', null)).toMatchObject({ inStock: true, q: null })
    expect(lotQuery('crViFailed', '', null)).toMatchObject({ crVi: 'FAIL' })
    expect(lotQuery('blocked', '', null, 'c1')).toMatchObject({ quality: 'BLOCKED', cursor: 'c1' })
    expect(lotQuery('all', '', null)).toEqual({ siteId: null, q: null, cursor: null, limit: 50 })
    expect(lotViewOf(params('view=released'), canFor('warehouse'))).toBe('released')
    expect(lotViewOf(params('onHold=true'), canFor('warehouse'))).toBe('waiting')
    expect(lotViewOf(params('crVi=PENDING'), canFor('warehouse'))).toBe('crViPending')
    expect(lotViewOf(params(''), canFor('quality'))).toBe('waiting')
    expect(defaultLotView(canFor('warehouse'))).toBe('inStock')
    expect(lotTabOf('trace')).toBe('trace')
    expect(lotTabOf('nonsense')).toBe('overview')
  })

  it('opens a lot only for one exact code', () => {
    expect(exactLot(' lot-d-000101 ', LOT_ROWS)).toBe(LOT_ROWS[0]!.id)
    expect(exactLot('LOT-D-0001', LOT_ROWS)).toBeNull()
    expect(exactLot('', LOT_ROWS)).toBeNull()
  })

  it('says the checklist and the trace in words', () => {
    expect(checklistHead(CHECKLIST_OPEN, 'QUARANTINE')).toEqual({ key: 'lt.release.open', count: 1 })
    expect(checklistHead({ ...CHECKLIST_OPEN, ready: true }, 'QUARANTINE').key).toBe('lt.release.ready')
    expect(checklistHead(CHECKLIST_RELEASED, 'RELEASED').key).toBe('lt.release.released')
    expect(checkKey({ code: 'CR_VI', state: 'OPEN' })).toBe('lt.check.CR_VI.OPEN')
    expect(checkKey({ code: 'STATE', state: 'OPEN' }, 'RELEASED')).toBe('lt.check.STATE.isRELEASED')
    expect(traceSummary(lotRecordOf().trace.forward)).toEqual({ key: 'lt.trace.used', params: { orders: 2, shipments: 1, customers: 1 } })
    expect(traceSummary(lotRecordOf(LOT_ROWS[1]).trace.forward).key).toBe('lt.trace.notUsed')
  })
})

describe('hides: views, the scanned tag, the tag label', () => {
  it('maps every view to the API’s query with the address filters', () => {
    const none = { lotId: null, grade: null, shade: null, locationId: null }
    expect(hideQuery('inStock', '', null, none)).toMatchObject({ inStock: true, limit: 50 })
    expect(hideQuery('remnants', '', null, { ...none, lotId: 'l1' })).toMatchObject({ state: 'REMNANT', lotId: 'l1' })
    expect(hideQuery('quarantine', 'HD', 's1', none)).toMatchObject({ inStock: true, quality: 'QUARANTINE', q: 'HD', siteId: 's1' })
    expect(hideViewOf(params('state=REMNANT'))).toBe('remnants')
    expect(hideViewOf(params(''))).toBe('inStock')
  })

  it('opens a hide only for one exact tag; a consumed or scrapped hide gets no tag', () => {
    expect(exactHide(HIDE_ROWS[0]!.code.toLowerCase(), HIDE_ROWS)).toBe(HIDE_ROWS[0]!.id)
    expect(exactHide('HD-DM', HIDE_ROWS)).toBeNull()
    expect(tagHeldKey({ state: 'CONSUMED' })).toBe('hd.print.consumed')
    expect(tagHeldKey({ state: 'PARTLY_CUT' })).toBeNull()
  })

  it('prints the HIDE label of a real tag (article, colour, grade, area, thickness, lot); a foreign code is not printable', () => {
    const label = hideLabel(HIDE_ROWS[0]!, 'it', (uom) => (uom === 'FT2' ? 'ft²' : uom))
    expect(label).toMatchObject({ kind: 'HIDE', language: 'it', scanId: tag(1), fields: { lot: 'LOT-D-000101', grade: 'A' } })
    expect(label.fields.area).toMatch(/ft²$/)
    const layout = tagLayout(label, 'Tag')
    expect(layout?.blocks.some((block) => block.kind === 'barcode')).toBe(true)
    expect(tagLayout({ ...label, scanId: 'HD-DEMO-0001' }, 'Tag')).toBeNull()
  })

  it('holds Print until a printer is chosen and copies are 1–5', () => {
    expect(printHeldKey(printDialog(['h']))).toBeNull()
    expect(printHeldKey(printDialog(['h'], { printerId: null, printers: { value: PRINTERS, problem: null } }))).toBe('hd.print.pickPrinter')
    expect(printHeldKey(printDialog(['h'], { copies: 9 }))).toBe('hd.print.copiesRange')
    expect(printHeldKey(printDialog(['h'], { printers: { value: null, problem: null } }))).toBe('hd.print.loadingPrinters')
  })

  it('says the next step: held with the lot’s reason, at a work order, ready, read only', () => {
    expect(nextStepKey(hideRecordOf(HIDE_ROWS[0]))).toBe('hd.next.ready')
    expect(nextStepKey(hideRecordOf(HIDE_ROWS[2]))).toBe('hd.next.atWorkOrder')
    expect(nextStepKey(hideRecordOf(HIDE_ROWS[4]))).toBe('hd.next.consumed')
    expect(nextStepKey(hideRecordOf(HIDE_ROWS[6]))).toBe('hd.next.held')
  })
})

describe('shared: running balance and the area in parts', () => {
  it('walks the balance back from the closing figure, newest first', () => {
    const rows = [
      { id: 'c', delta: '6.1000' },
      { id: 'b', delta: '-48.8000' },
      { id: 'a', delta: '412.5000' },
    ]
    const balances = runningBalances(rows, '369.8000')
    expect([balances.get('c'), balances.get('b'), balances.get('a')]).toEqual([369.8, 363.7, 412.5])
    expect(runningBalances(rows, null).size).toBe(0)
  })

  it('splits a hide’s area into cut, in stock and at the work order; a gap is said', () => {
    expect(areaParts({ measured: '51.9000', cut: '28.6000', remnant: '0.0000', onHand: '0.0000', uom: 'FT2' })).toMatchObject({ cut: 28.6, onHand: 0, elsewhere: 23.3, addsUp: true })
    expect(areaParts({ measured: '10.0000', cut: '12.0000', remnant: '0.0000', onHand: '0.0000', uom: 'M2' })).toMatchObject({ elsewhere: 0, addsUp: false })
    expect(share(28.6, 51.9)).toBe(55)
    expect(share(1, 0)).toBe(0)
  })
})

describe('record links: a lot, a hide land on the warehouse records', () => {
  it('opens the built pages', () => {
    expect(recordAddress({ type: 'Lot', id: 'l1' }, OFFICE_PAGES)).toBe('/warehouse/lots/l1')
    expect(recordAddress({ type: 'Hide', id: 'h1' }, OFFICE_PAGES)).toBe('/warehouse/hides/h1')
  })
})

const LEFT_KEY = /\b(?:hd|lt|mv|rec|common|problem|uom|reason|quality|crVi|hideState|wait|held|side|postedBy|live|evidence|locationKind|money)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs inventory.stock.view"): not keys. */
const PERMISSIONS = /\b(?:inventory\.stock\.view|quality\.lots\.view)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'stock', 'lists', 'records', 'warehouse-lots']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [hidesScreen, hideScreen, lotsScreen, lotScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(PERMISSIONS, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the dynamic words exist in both languages (checks, views, shipment states, print states, CSV columns)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['warehouse-lots'])['warehouse-lots']!)
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const code of CHECK_CODES) {
        has(`lt.checkName.${code}`)
        for (const state of ['OK', 'OPEN', 'NOT_NEEDED'] as const) has(checkKey({ code, state }))
        for (const status of ['QUARANTINE', 'RELEASED', 'BLOCKED', 'REJECTED'] as const) has(checkKey({ code, state: 'OPEN' }, status))
      }
      for (const view of LOT_VIEWS) has(`lt.view.${view}`)
      for (const status of ['NOT_REQUIRED', 'PENDING', 'PASS', 'FAIL']) has(`lt.crViShort.${status}`)
      for (const view of HIDE_VIEWS) has(`hd.view.${view}`)
      for (const status of ['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED']) has(`lt.shipmentStatus.${status}`)
      for (const status of ['QUEUED', 'SENT', 'PRINTED', 'FAILED', 'REFUSED']) has(`hd.print.status.${status}`)
      for (const column of LOT_CSV_COLUMNS) has(`lt.csv.${column}`)
      for (const column of HIDE_CSV_COLUMNS) has(`hd.csv.${column}`)
      for (const key of ['hd.next.ready', 'hd.next.remnant', 'hd.next.atWorkOrder', 'hd.next.held', 'hd.next.consumed', 'hd.next.scrapped', 'lt.release.readyUnblock', 'lt.release.rejected']) has(key)
      has('lt.release.open', 2)
    }
  })
})
