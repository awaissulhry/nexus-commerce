import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { KIT_LINE_STATUSES } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { BUNDLES, canFor, kitLine, LOCATIONS, MATERIALS, order, STOCK, TODAY } from '../demo/fixtures'
import { designScreen as sheetScreen } from '../job-sheet/fixtures'
import { designScreen as recordScreen } from './fixtures'
import {
  addOperationHeld,
  cellPatch,
  cellProblem,
  kitLineHeld,
  NO_KIT_LINE,
  primaryAct,
  ready,
  receiveBody,
  receivedWords,
  receiveDraftOf,
  receiveHeld,
  receiveProblem,
  returnProblem,
  sendBeside,
  sendBody,
  sendDraftOf,
  sendHeld,
  sendProblem,
  sentWords,
  sizesHeld,
  sizesOf,
  sourcesFor,
  stockKey,
  tabOf,
} from './record-model'

/**
 * The subcontract order's record (SCR-128 record) and its job sheet (SCR-128-job-sheet): the record's rules, and every
 * design case in both languages with no message key left on screen.
 */

const conflict = (message: string, issues: { path: string; message: string }[] = []) => new ApiError('conflict', 409, 'conflict', message, null, issues)
const invalid = (path: string, message = 'refused') => new ApiError('invalid', 400, 'validation', message, null, [{ path, message }])

describe('the record: tabs, the band, cells', () => {
  it('reads the tab from the address (default Operations & quantities)', () => {
    expect(tabOf('kit')).toBe('kit')
    expect(tabOf('nonsense')).toBe('ops')
    expect(tabOf(null)).toBe('ops')
  })

  it('the band offers the act of the state, and Send kit beside Receive back while something is left', () => {
    expect(primaryAct(order('DRAFT'))).toBe('issue')
    expect(primaryAct(order('ISSUED'))).toBe('send')
    expect(primaryAct(order('AT_WORKSHOP'))).toBe('receive')
    expect(primaryAct(order('RECEIVED'))).toBe('close')
    expect(primaryAct(order('CLOSED'))).toBeNull()
    expect(sendBeside(order('AT_WORKSHOP'))).toBe(true)
    expect(sendBeside(order('PARTLY_RECEIVED'))).toBe(false)
  })

  it('a typed cell becomes a change, nothing when it did not change, or why not', () => {
    const operation = order('DRAFT').operations[0]!
    expect(cellPatch('pricePerPiece', '7,5', operation)).toEqual({ patch: { pricePerPiece: '7.5' }, problem: null })
    expect(cellPatch('pricePerPiece', '7.00', operation)).toEqual({ patch: null, problem: null })
    expect(cellPatch('pricePerPiece', 'abc', operation).problem?.key).toBe('ops.cell.feeNumber')
    expect(cellPatch('pieces', '0', operation).problem?.key).toBe('ops.cell.piecesWhole')
    expect(cellPatch('expectedBackDate', '', operation)).toEqual({ patch: { expectedBackDate: null }, problem: null })
    expect(cellPatch('note', '  ', { ...operation, note: null })).toEqual({ patch: null, problem: null })
  })

  it('says a refused cell by the path it names, never the API’s words', () => {
    expect(cellProblem(invalid('body/sizes'), 'pieces').key).toBe('ops.cell.sizesAddUp')
    expect(cellProblem(invalid('body/operations/0/pieces', 'already on live orders'), 'pieces').key).toBe('ops.cell.piecesTaken')
    expect(cellProblem(invalid('body/expectedBackDate'), 'expectedBackDate').key).toBe('ops.cell.dateBefore')
    expect(cellProblem(conflict('changed'), 'note').key).toBe('problem.changed')
  })
})

describe('the dialogs: what holds them, what they send', () => {
  const issued = order('ISSUED')
  const warehouse = canFor('warehouse')

  it('the stock a kit line may leave from: its material and colour, available, a released lot (never the workshop’s own place)', () => {
    const line = kitLine(1)
    const row = (over: Record<string, unknown>) => ({ location: { id: 'p1', code: 'P1' }, item: { id: line.item.id }, colour: line.colour, lot: { id: 'l1', code: 'L1', qualityStatus: 'RELEASED' }, hide: null, available: '5.0000', ...over })
    const options = sourcesFor([row({}), row({ available: '0.0000' }), row({ lot: { id: 'l2', code: 'L2', qualityStatus: 'QUARANTINE' } }), row({ lot: null }), row({ location: { id: LOCATIONS.sewing.id, code: 'W' } })], line, new Set([LOCATIONS.sewing.id]))
    expect(options.map((option) => option.lotCode)).toEqual(['L1'])
    expect(options[0]).toMatchObject({ locationId: 'p1', lotId: 'l1', available: '5' })
  })

  it('Send kit is held until each line has its place, the pieces fit and the DDT is complete; then its body', () => {
    const draft = sendDraftOf(issued, warehouse)
    expect(sendHeld(draft, issued)?.key).toBe('send.held.loading')
    const sources = Object.fromEntries(draft.lines.map((line) => [line.lineId, [{ key: `${line.lineId}-k`, locationId: 'p1', locationCode: 'P1', lotId: 'l1', lotCode: 'L1', hideId: null, hideCode: null, available: '99' }]]))
    let next = { ...draft, sources: ready(sources) }
    expect(sendHeld(next, issued)).toMatchObject({ key: 'send.held.from', params: { line: 10 } })
    next = { ...next, lines: next.lines.map((line) => ({ ...line, source: `${line.lineId}-k` })) }
    expect(sendHeld(next, issued)?.key).toBe('send.held.weight')
    next = { ...next, pieces: { ...next.pieces, [issued.operations[0]!.id]: '999' } }
    expect(sendHeld(next, issued)?.key).toBe('send.held.piecesLeft')
    next = { ...next, pieces: { ...next.pieces, [issued.operations[0]!.id]: '10' }, ddt: { ...next.ddt, grossWeightKg: '12,5', transportBy: 'CARRIER' } }
    expect(sendHeld(next, issued)?.key).toBe('send.held.carrier')
    next = { ...next, ddt: { ...next.ddt, carrier: 'Corriere Demo' } }
    expect(sendHeld(next, issued)).toBeNull()
    const body = sendBody({ ...next, bundleIds: [BUNDLES[0]!.id] }, issued)
    expect(body).toMatchObject({ version: issued.version, bundles: [{ bundleId: BUNDLES[0]!.id }], ddt: { reason: 'WORK_ON_ACCOUNT', transportBy: 'CARRIER', carrier: { name: 'Corriere Demo' }, packages: 1, grossWeightKg: '12.5' } })
    expect(body.lines[0]).toMatchObject({ fromLocationId: 'p1', lotId: 'l1', quantity: '42.6' })
    expect(body.pieces.find((entry) => entry.operationId === issued.operations[0]!.id)?.pieces).toBe(10)
    expect(sendBody({ ...next, ddt: { ...next.ddt, issue: false } }, issued).ddt).toBeNull()
  })

  it('without shipping.ddt.issue the DDT starts off (the kit may go without one)', () => {
    expect(sendDraftOf(issued, { ...warehouse, ddtIssue: false }).ddt.issue).toBe(false)
    expect(sendDraftOf(issued, { ...warehouse, workOrders: false }).bundles).toBeNull()
  })

  it('Receive back is held by what is not whole, a missing reason, more than is out, a return without its place; then its body', () => {
    const partly = order('PARTLY_RECEIVED')
    const draft = { ...receiveDraftOf(partly, TODAY, warehouse), stock: ready(STOCK.rows.filter((row) => row.location.id === LOCATIONS.sewing.id)) }
    expect(receiveHeld(draft, partly, TODAY)).toBeNull()
    const line = draft.lines[0]!
    expect(receiveHeld({ ...draft, lines: [{ ...line, defective: '1' }] }, partly, TODAY)?.key).toBe('receive.held.reason')
    expect(receiveHeld({ ...draft, lines: [{ ...line, good: '999' }] }, partly, TODAY)?.key).toBe('receive.held.moreThanOut')
    expect(receiveHeld({ ...draft, lines: [{ ...line, good: '1.5' }] }, partly, TODAY)?.key).toBe('receive.held.whole')
    expect(receiveHeld({ ...draft, receivedOn: '2099-01-01' }, partly, TODAY)?.key).toBe('receive.held.future')
    const key = stockKey(draft.stock.value![0]!)
    expect(receiveHeld({ ...draft, returns: { [key]: { quantity: '2', toLocationId: '' } } }, partly, TODAY)?.key).toBe('receive.held.returnTo')
    expect(receiveHeld({ ...draft, lines: [], returns: {} }, partly, TODAY)?.key).toBe('receive.held.nothing')
    const body = receiveBody({ ...draft, ddtNumber: 'LCD-1', returns: { [key]: { quantity: '2,5', toLocationId: 'p9' } } }, partly, `${TODAY}T10:00:00Z`)
    expect(body).toMatchObject({ version: partly.version, supplierDdt: { number: 'LCD-1' }, returns: [{ itemId: MATERIALS.lining.id, quantity: '2.5', toLocationId: 'p9' }] })
    expect(body).not.toHaveProperty('receivedAt')
    expect(body.lines[0]).toMatchObject({ operationId: line.operationId, good: Number(line.good), defective: 0, scrapped: 0 })
  })

  it('Add operation, pieces per size and a kit line say what holds them', () => {
    const draft = order('DRAFT')
    expect(addOperationHeld({ outside: { value: null, problem: null }, operationId: '', pieces: '' }, draft)?.key).toBe('addOperation.held.loading')
    expect(kitLineHeld(NO_KIT_LINE)?.key).toBe('kitLine.held.material')
    const cells = [{ workOrderSizeId: 'c1', colourway: 'BLK', size: '50', quantity: 4 }]
    expect(sizesHeld({ operationId: 'o', cells: ready(cells), value: { BLK: { '50': 5 } } })).toMatchObject({ key: 'sizes.held.over', params: { max: 4 } })
    expect(sizesOf({ operationId: 'o', cells: ready(cells), value: { BLK: { '50': 3 } } })).toEqual({ sizes: [{ workOrderSizeId: 'c1', pieces: 3 }], pieces: 3 })
  })

  it('answers and refusals in this app’s words', () => {
    expect(sentWords({ ddt: { id: 'd', number: '212/2026', file: null, pdfProblem: 'store down' } })).toMatchObject({ key: 'send.done.pdfMissing', params: { number: '212/2026' } })
    expect(sentWords({ ddt: null }).key).toBe('send.done.noDdt')
    const partly = order('PARTLY_RECEIVED')
    expect(receivedWords({ order: partly, ledger: { posted: 1, waiting: [] } }, { cost: true })).toMatchObject({ key: 'receive.done.partPosted', params: { count: 1 } })
    expect(receivedWords({ order: partly, ledger: { posted: 0, waiting: ['The order is in USD, not EUR (CURRENCY).'] } }, { cost: true }).key).toBe('receive.done.partCurrency')
    expect(receivedWords({ order: order('RECEIVED'), ledger: { posted: 2, waiting: [] } }, { cost: false }).key).toBe('receive.done.all')
    expect(sendProblem(invalid('body/lines/0/lotId', 'Lot X is quarantine; only a released lot goes to a workshop.')).key).toBe('send.refused.lotNotReleased')
    expect(sendProblem(new ApiError('forbidden', 403, 'forbidden', "Issuing the kit's DDT needs shipping.ddt.issue")).key).toBe('send.refused.ddtRight')
    expect(sendProblem(invalid('body/grossWeightKg')).key).toBe('send.refused.weight')
    expect(sendProblem(invalid('company/vatNumber')).key).toBe('send.refused.company')
    expect(receiveProblem(invalid('body/lines/0/good', 'Only 4 piece(s) of this operation are at the workshop.')).key).toBe('receive.refused.moreThanOut')
    expect(receiveProblem(invalid('body/lines/0/bundleId')).key).toBe('receive.refused.bundle')
    expect(returnProblem(conflict('DDT 212/2026 is live for kit line 10')).key).toBe('returnLine.refused.ddtLive')
  })
})

const NAMESPACES = ['shell', 'subcontracting', 'subcontract-order', 'lists', 'records']
const groups = [...new Set(['subcontract-order', 'subcontracting'].flatMap((namespace) => Object.keys(CATALOGUE.en[namespace] ?? {}).map((key) => key.split('.')[0]!)))].join('|')
const LEFT_KEY = new RegExp(`\\b(?:${groups})\\.[a-zA-Z_]+(?:\\.[a-zA-Z_]+)*\\b`)
/** Permission names are said on purpose ("needs shipping.ddt.issue"); a file name is no key. */
const SAID = /\b(?:purchasing\.(?:view|subcontract\.(?:manage|kit|receive))|shipping\.ddt\.(?:issue|cancel)|workorders\.view|files\.read|inventory\.locations\.view|product\.materials\.view|money\.cost)\b|DDT-[\w-]+\.pdf/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, NAMESPACES) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [recordScreen, sheetScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      }
    })
  }

  it('no fee and no amount anywhere for a role without the cost grain, nor on the job sheet', () => {
    for (const item of recordScreen.cases.filter((entry) => !entry.model.record.can.cost)) {
      const html = render(recordScreen as unknown as DesignScreen<unknown>, item.model, 'en')
      expect(html, item.id).not.toMatch(/Fee per piece|Order amount/)
    }
    for (const item of sheetScreen.cases) expect(render(sheetScreen as unknown as DesignScreen<unknown>, item.model, 'en'), item.id).not.toMatch(/€|Fee|fee per/)
  })

  it('the dynamic words exist in both languages (units, line states, lot states, tabs, journey, acts)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['subcontract-order'])['subcontract-order']!)
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const unit of UOMS) has(`uom.${unit}`)
      for (const status of KIT_LINE_STATUSES) has(`kitLine.status.${status}`)
      for (const status of ['QUARANTINE', 'RELEASED', 'BLOCKED', 'REJECTED']) has(`lot.${status}`)
      for (const tab of ['ops', 'kit', 'back', 'documents', 'activity']) has(`tab.${tab}`)
      for (const step of ['draft', 'sent', 'kitOut', 'back', 'closed']) has(`journey.${step}`)
      for (const act of ['issue', 'send', 'receive', 'close', 'reopen', 'cancel']) has(`band.act.${act}`)
      for (const status of ['not_found', 'forbidden', 'error']) has(`record.${status}.title`)
      for (const by of ['SENDER', 'RECIPIENT', 'CARRIER']) has(`send.ddt.by.${by}`)
      for (const reason of ['WORK_ON_ACCOUNT', 'OTHER']) has(`send.ddt.reasons.${reason}`)
      for (const state of ['part', 'all']) for (const suffix of ['', 'Waiting', 'Currency']) has(`receive.done.${state}${suffix}`)
      has('receive.done.partPosted', 2)
    }
    expect(Object.keys(CATALOGUE.en['subcontract-order'] ?? {}).length).toBeGreaterThan(400)
  })
})
