import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { createPickLists, KIT_STATUSES, listPickLists, pickListSheets, READINESS_WORDS } from './api'
import { canAs, CHECKED_SHEET, COMPLETE_SHEET, CREATE_RESULTS, PICK_ROWS, pickSheet, SHEET_LINES, STAGING_PLACES } from './demo/fixtures'
import { designScreen as listScreen } from './fixtures'
import {
  addressOf,
  addressText,
  createChoices,
  createHeld,
  heldPhrase,
  isPickingEvent,
  kitCheck,
  kitHeld,
  kitPlaceWords,
  kitProblem,
  markCompleteHeld,
  materialReason,
  pickedByWords,
  printHref,
  readinessKey,
  resultPhrase,
  stagingChoices,
  stopsOf,
  TILES,
  walkOf,
  walkOrder,
} from './model'
import { designScreen as printScreen } from './print/fixtures'

/**
 * Warehouse › Picking & kits (SCR-237, SCR-237-print; B-W2a-58): the pure rules (the address and saved rows, the
 * readiness and held words, where a line is picked from and the walk by bin path, the kit check and why Mark kit complete
 * is held, the Create choices and outcomes, the live events), the calls as the API takes them, the page in the Office's
 * pages and record links, and every design case drawn in Italian and English with no message key or placeholder left.
 */

describe('picking: the address, the saved rows and the tiles', () => {
  it('reads and writes the address (all is the default; ?open= the pick list; ?new=1 Create)', () => {
    const address = addressOf(new URLSearchParams('view=waiting&q=giacca&site=s1&open=w1&new=1'))
    expect(address).toEqual({ view: 'waiting', q: 'giacca', siteId: 's1', open: 'w1', create: true })
    expect(addressText(address)).toBe('?view=waiting&q=giacca&site=s1&open=w1&new=1')
    expect(addressOf(new URLSearchParams('view=toCreate')).view).toBe('all')
    expect(addressText({ view: 'all', q: ' ', siteId: null, open: null, create: false })).toBe('')
    expect(TILES.map((tile) => tile.count({ today: 1, waiting: 2, complete: 3, toCreate: 4, all: 9 }))).toEqual([1, 2, 3])
  })

  it('says abilities from the role templates (read-only cannot create; sales cannot see)', () => {
    expect(canAs('warehouse')).toMatchObject({ view: true, reserve: true })
    expect(canAs('readOnly')).toMatchObject({ view: true, reserve: false })
    expect(canAs('sales').view).toBe(false)
  })
})

describe('picking: readiness and held stock in our words', () => {
  it('gives the word its date and each material its reason', () => {
    expect(readinessKey('EXPECTED', '2026-11-03')).toEqual({ key: 'ready.word.EXPECTED_ON', params: { date: '2026-11-03' } })
    expect(readinessKey('DELAYED', '2026-11-05')).toEqual({ key: 'ready.word.DELAYED' })
    const delayed = PICK_ROWS[1]!.readiness.materials[0]!
    expect(materialReason(delayed).key).toBe('ready.reason.DELAYED_PO')
    expect(materialReason(delayed).params).toMatchObject({ po: 'PO-D-0102', date: '2026-11-05' })
    expect(materialReason(PICK_ROWS[3]!.readiness.materials[0]!).key).toBe('ready.reason.NOT_ENOUGH')
  })

  it('names a quality hold of a hide or a lot with its reason in the language, and a lot status by its reason', () => {
    const [hide, pending] = SHEET_LINES[0]!.held
    expect(heldPhrase(hide!, 'it')).toEqual({ key: 'held.holdHide', params: { hide: 'H-D-0012', lot: hide!.lotCode, reason: 'Controllo qualità', since: hide!.hold!.placedAt } })
    expect(heldPhrase(hide!, 'en').params?.reason).toBe('Quality check')
    expect(heldPhrase(pending!, 'en')).toEqual({ key: 'held.CR_VI_PENDING', params: { lot: pending!.lotCode } })
  })

  it('says who picked by team or the office, never a person', () => {
    expect(pickedByWords(PICK_ROWS[4]!)).toEqual({ teams: ['Taglio'], office: true })
    expect(pickedByWords(PICK_ROWS[1]!)).toBeNull()
  })
})

describe('picking: where to pick, the walk by bin path, the kit check', () => {
  it("takes a line's reserved stock with its places, else what a pick list proposes, sorted by place", () => {
    const leather = stopsOf(SHEET_LINES[0]!)
    expect(leather.map((stop) => [stop.locationCode, stop.hideCode, stop.reserved])).toEqual([
      ['N-MAG-A-01', 'H-D-0009', true],
      ['N-MAG-A-01', 'H-D-0010', true],
      ['N-MAG-A-02', 'H-D-0011', true],
    ])
    expect(stopsOf(SHEET_LINES[2]!)).toEqual([{ locationCode: 'N-MAG-A', lotCode: SHEET_LINES[2]!.pick.proposed[0]!.lotCode, hideCode: null, quantity: '24.0000', reserved: false }])
    expect(walkOrder(SHEET_LINES).map((line) => line.itemCode)).toEqual([SHEET_LINES[2]!.itemCode, SHEET_LINES[0]!.itemCode, SHEET_LINES[1]!.itemCode])
  })

  it('walks the store once for many work orders, place by place, leaving out lines picked in full', () => {
    const walk = walkOf([pickSheet(PICK_ROWS[0]!), pickSheet(PICK_ROWS[1]!, { lines: SHEET_LINES.slice(0, 1) })])
    expect(walk.map((stop) => stop.locationCode)).toEqual(['N-MAG-A', 'N-MAG-A-01', 'N-MAG-A-02'])
    expect(walk[1]!.picks.map((pick) => pick.workOrder)).toEqual(['WO-D-0031', 'WO-D-0031', 'WO-D-0032', 'WO-D-0032'])
    expect(walk.flatMap((stop) => stop.picks).some((pick) => pick.itemCode === SHEET_LINES[1]!.itemCode)).toBe(false)
    expect(printHref('/w/DEMO', ['a', 'b c'])).toBe('/w/DEMO/warehouse/picking/print?ids=a,b%20c')
  })

  it('B-W2b-15: Mark kit complete is held with why (lines short, no right, already checked) and allowed once every line is picked', () => {
    const warehouse = canAs('warehouse')
    expect(warehouse.kits).toBe(true)
    expect(kitCheck(pickSheet(PICK_ROWS[0]!))).toMatchObject({ complete: false })
    expect(markCompleteHeld(pickSheet(PICK_ROWS[0]!), warehouse)).toEqual({ key: 'kit.markShort', params: { count: 3 } })
    expect(kitCheck(COMPLETE_SHEET).complete).toBe(true)
    expect(markCompleteHeld(COMPLETE_SHEET, warehouse)).toBeNull()
    expect(markCompleteHeld(COMPLETE_SHEET, canAs('readOnly'))).toEqual({ key: 'kit.heldNoRight' })
    expect(markCompleteHeld(CHECKED_SHEET, warehouse)).toEqual({ key: 'kit.heldChecked' })
    expect(kitHeld(CHECKED_SHEET, warehouse, 'reopen')).toBeNull()
    expect(kitHeld(COMPLETE_SHEET, warehouse, 'reopen')).toEqual({ key: 'kit.heldNotChecked' })
    const closed = { ...COMPLETE_SHEET, workOrder: { ...COMPLETE_SHEET.workOrder, status: 'COMPLETED' as const } }
    expect(kitHeld(closed, warehouse, 'stage')).toEqual({ key: 'kit.heldNotOpen' })
    expect(kitPlaceWords(PICK_ROWS[0]!.kit)).toEqual({ key: 'kit.placeAt', params: { code: 'N-TAG', name: 'Reparto taglio · rastrelliera' } })
    expect(kitPlaceWords(PICK_ROWS[1]!.kit)).toEqual({ key: 'kit.placeNone' })
  })

  it('B-W2b-15: a kit waits at a place of the site in use, never a workshop\'s, in walking order; refusals in our words', () => {
    const place = (id: string, path: string[], kind = 'BIN', status = 'ACTIVE') => ({ id, companyId: 'c', siteId: 's', parentId: null, code: path[path.length - 1]!, name: id, kind, status, depth: path.length - 1, path, version: 1, createdAt: '', updatedAt: '' })
    const site = { locations: [place('b', ['M', 'M-02']), place('a', ['M']), place('w', ['W'], 'SUBCONTRACTOR'), place('z', ['M', 'M-09'], 'BIN', 'ARCHIVED'), place('c', ['M', 'M-01'])] } as never
    expect(stagingChoices(site).map((choice) => choice.id)).toEqual(['a', 'c', 'b'])
    expect(stagingChoices(undefined)).toEqual([])
    expect(STAGING_PLACES.length).toBeGreaterThan(0)
    const refusal = (path: string) => new ApiError('conflict', 409, 'conflict', 'x', null, [{ path, message: 'x' }])
    expect(kitProblem(refusal('kit/LINES_SHORT'))).toEqual({ key: 'kit.refused.LINES_SHORT' })
    expect(kitProblem(refusal('kit/ALREADY_CHECKED'))).toEqual({ key: 'kit.refused.ALREADY_CHECKED' })
    expect(kitProblem(new ApiError('invalid', 400, 'validation_error', 'x', null, [{ path: 'body/locationId', message: 'x' }]))).toEqual({ key: 'kit.refused.PLACE' })
  })
})

describe('picking: Create pick lists and live', () => {
  it('offers the released work orders without a pick list; a held one cannot be ticked, with why', () => {
    expect(createChoices(PICK_ROWS).map((row) => row.workOrder.number)).toEqual(['WO-D-0032', 'WO-D-0033', 'WO-D-0034'])
    expect(createHeld(PICK_ROWS[5]!)).toEqual({ key: 'create.heldOnHold' })
    expect(createHeld(PICK_ROWS[0]!)).toEqual({ key: 'create.heldHasList' })
    expect(createHeld(PICK_ROWS[1]!)).toBeNull()
  })

  it('says each outcome in words (made, made with a shortage, refused by its code)', () => {
    expect(CREATE_RESULTS.map((result) => resultPhrase(result).key)).toEqual(['create.result.createdShort', 'create.result.created', 'create.refusal.HIDE_RESERVED'])
    expect(resultPhrase({ ...CREATE_RESULTS[2]!, refusal: { code: 'SOMETHING_NEW', message: '' } }).key).toBe('create.refusal.OTHER')
  })

  it('re-reads on issues, reservations, holds, purchase orders and the plan', () => {
    for (const type of ['inventory.issued', 'inventory.returned', 'inventory.reserved', 'quality.hold_placed', 'purchasing.po_confirmed', 'planning.run_finished', 'workorder.status_changed']) expect(isPickingEvent(type), type).toBe(true)
    expect(isPickingEvent('invoice.issued')).toBe(false)
  })
})

describe('picking: the calls as the API takes them', () => {
  it('lists, reads the sheets of many work orders and creates with an Idempotency-Key', async () => {
    const calls: { url: string; method: string; body: unknown; key: string | null }[] = []
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, key: new Headers(init?.headers).get('idempotency-key') })
      const body = url.includes('/sheet') ? { asOf: '2026-10-30T08:00:00.000Z', sheets: [] } : init?.method === 'POST' ? { created: 0, results: [] } : { asOf: '2026-10-30T08:00:00.000Z', sites: [], tiles: { today: 0, waiting: 0, complete: 0, toCreate: 0, all: 0 }, rows: [], total: 0, nextCursor: null }
      return new Response(JSON.stringify(body), { status: init?.method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } })
    }
    const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetcher as unknown as typeof globalThis.fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' })
    await listPickLists(api, { view: 'waiting', q: ' giacca ', siteId: null, limit: 50 })
    expect(calls[0]!.url).toBe('/api/inventory/picking/pick-lists?view=waiting&q=giacca&limit=50')
    await pickListSheets(api, ['a', 'b'])
    expect(calls[1]!.url).toBe('/api/inventory/picking/pick-lists/sheet?workOrderIds=a%2Cb')
    await createPickLists(api, 's1', ['a', 'b'])
    expect(calls[2]).toMatchObject({ url: '/api/inventory/picking/pick-lists', method: 'POST', body: { siteId: 's1', workOrderIds: ['a', 'b'] } })
    expect(calls[2]!.key).toBeTruthy()
  })

  it('is a built Office page, and the API list opens it', () => {
    expect(OFFICE_PAGES.has('/warehouse/picking') && OFFICE_PAGES.has('/warehouse/picking/print')).toBe(true)
    expect(LIST_PAGES['/inventory/picking/pick-lists']).toBe('/warehouse/picking')
  })
})

const LEFT_KEY = /\b(?:list|col|view|tile|tileHint|band|held|kit|ready|sheet|create|print|keys|problem|common|uom|live)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs inventory.stock.view"); domains are not keys. */
const SAID = /\b(?:inventory\.[a-z]+(?:\.[a-z]+)?|example\.com)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'stock', 'lists', 'records', 'warehouse-picking']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, printScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the dynamic words exist in both languages (readiness, kit, held, outcomes, refusals)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['warehouse-picking'])['warehouse-picking']!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const word of READINESS_WORDS) {
        has(`ready.word.${word}`)
        has(`ready.reason.${word}`)
      }
      for (const status of KIT_STATUSES) has(`kit.status.${status}`)
      for (const reason of ['CR_VI_PENDING', 'CR_VI_FAILED', 'QUALITY_HOLD', 'BLOCKED', 'REJECTED', 'holdLot', 'holdHide']) has(`held.${reason}`)
      for (const outcome of ['created', 'createdShort', 'nothing', 'nothingShort']) has(`create.result.${outcome}`, { count: 2, number: 'WO-D-0031', short: 1 })
      for (const code of ['ON_HOLD', 'NOT_RELEASED', 'NOT_FOUND', 'NOT_AVAILABLE', 'LOT_NOT_AVAILABLE', 'HIDE_RESERVED', 'HIDE_NOT_IN_STOCK', 'LOT_HELD', 'OTHER']) has(`create.refusal.${code}`)
      has('kit.markShort', { count: 2 })
      for (const key of ['placeAt', 'placeLabel', 'placeHint', 'heldNoRight', 'heldNoPlaces', 'heldNotOpen', 'heldNothing', 'heldChecked', 'heldNotChecked', 'checked', 'checkedAt', 'reopen', 'reopenReason', 'reopenWhy']) has(`kit.${key}`, { code: 'N-TAG', name: 'Rack', at: '1 Nov' })
      for (const code of ['LINES_SHORT', 'WORK_ORDER_NOT_OPEN', 'NOTHING_PLANNED', 'ALREADY_CHECKED', 'NOT_CHECKED', 'PLACE', 'OTHER']) has(`kit.refused.${code}`)
    }
  })
})
