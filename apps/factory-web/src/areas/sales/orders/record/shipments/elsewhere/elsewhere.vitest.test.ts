import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../../../lib/api/errors'
import { LOCALES } from '../../../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../../../lib/i18n/messages'
import { renderView, textOf } from '../../../../../../lib/record-thread/parts/testing'
import type { ReadyCell } from '../../../../../warehouse/shipments/api'
import { designScreen as recordScreen } from '../../fixtures'
import type { ElsewherePreview } from './api'
import { designScreen } from './fixtures'
// F-OP-123: the Warehouse record of a shipment made elsewhere.
import { designScreen as warehouseScreen } from '../../../../../warehouse/shipments/record/fixtures'
import { changed, defaultLeaving, elsewhereBody, elsewhereDoor, emptyForm, liveProblems, madeElsewhereChip, problemPlaces, recordHeld, refusalOf, serialsOf, waitingForQuality } from './model'

/**
 * F-OP-123 (order page N5; 10-order-page §8.5; review R-9, R-10, R-23) — "Record a shipment made elsewhere…" on the order page: the
 * door, the form and its request, the live rules, what holds Record, a refusal in words, the "Made elsewhere" chip. Made-up data only.
 */

const NOW = new Date('2026-11-19T10:00:00.000Z')
const cell = (id: string, over: Partial<ReadyCell> = {}): ReadyCell => ({
  workOrderSizeId: id,
  workOrderId: 'wo',
  workOrderNumber: 'WO-DEMO-0051',
  batchNumber: null,
  siteId: 'site-1',
  salesOrderLineId: 'line-1',
  lineSeq: 1,
  styleCode: 'DEMO-JKT-01',
  styleName: 'Giacca moto Demo',
  colourwayCode: 'BLK',
  colourwayName: 'Nero',
  size: '52',
  pieces: 5,
  released: 3,
  reversed: 0,
  onShipments: 0,
  shippable: 3,
  serialTracked: false,
  ...over,
})
const CELLS = [cell('c1'), cell('c2', { size: '54', serialTracked: true })]
const preview = (over: Partial<ElsewherePreview> = {}): ElsewherePreview => ({
  order: { id: 'o1', number: 'SO-26-0031' },
  siteId: 'site-1',
  lines: [{ workOrderSizeId: 'c1', label: 'WO-DEMO-0051 BLK 52', quantity: 2, shippable: 3, releasedAt: '2026-11-12T09:00:00.000Z', serialTracked: false }],
  earliest: '2026-11-12T09:00:00.000Z',
  problems: [],
  holds: { held: false, accountHold: null, creditHeld: false, mayRelease: false },
  ddtUsed: false,
  noticeOn: false,
  ddtCitable: true,
  ...over,
})
const form = (over = {}) => changed(changed(emptyForm(NOW), { quantities: { c1: 2 }, ddtNumber: '123/2026' }, NOW), { ddtDate: '2026-11-18', ...over }, NOW)
const places = (value: ReturnType<typeof form>, read: ElsewherePreview | null = preview(), cells = CELLS) => problemPlaces(liveProblems(value, cells, read, NOW), elsewhereBody('o1', value, cells), { releasedOn: (iso) => iso.slice(0, 10) })

describe('the door: held with words, never hidden (D4)', () => {
  it('an open order and a warehouse person: open; another state, or Sales without the shipping rights: held', () => {
    const rights = ['shipping.manage', 'shipping.ddt.issue']
    expect(elsewhereDoor({ status: 'PARTLY_SHIPPED' }, rights)).toBeNull()
    expect(elsewhereDoor({ status: 'SHIPPED' }, rights)).toEqual({ key: 'elsewhere.held.state' })
    expect(elsewhereDoor({ status: 'CONFIRMED' }, ['orders.manage', 'shipping.view'])).toEqual({ key: 'elsewhere.held.noRight' })
    expect(elsewhereDoor({ status: 'READY' }, ['shipping.manage'])).toEqual({ key: 'elsewhere.held.noRight' })
  })
})

describe('the form and the request it sends', () => {
  it('"Left on" follows the DDT date (09:00 in Rome, never later than now) until the person changes it', () => {
    expect(defaultLeaving('2026-11-18', NOW)).toBe('2026-11-18T08:00:00.000Z')
    expect(defaultLeaving('2026-11-19', new Date('2026-11-19T07:02:00.000Z'))).toBe('2026-11-19T07:00:00.000Z')
    const moved = changed(emptyForm(NOW), { ddtDate: '2026-11-17' }, NOW)
    expect(moved.shippedAt).toBe('2026-11-17T08:00:00.000Z')
    const touched = changed(moved, { shippedAt: '2026-11-17T15:30:00.000Z' }, NOW)
    expect(changed(touched, { ddtDate: '2026-11-16' }, NOW).shippedAt).toBe('2026-11-17T15:30:00.000Z')
  })

  it('sends the sizes with garments only, the serials of a serial-tracked style, the carrier only for a carrier, no paper DDT when none is typed', () => {
    const value = form({ quantities: { c1: 2, c2: 1 }, serials: { c1: 'X-1', c2: ' SN-1, SN-2 ' }, carrierName: ' Demo Corriere ', holdReason: '  ' })
    const body = elsewhereBody('o1', value, CELLS)
    expect(body.lines).toEqual([
      { workOrderSizeId: 'c1', quantity: 2 },
      { workOrderSizeId: 'c2', quantity: 1, serials: ['SN-1', 'SN-2'] },
    ])
    expect(body).toMatchObject({ salesOrderId: 'o1', siteId: 'site-1', transportBy: 'CARRIER', carrierName: 'Demo Corriere', externalDdt: { number: '123/2026', date: '2026-11-18' }, ddtRequired: true })
    expect(body).not.toHaveProperty('holdReason')
    expect(elsewhereBody('o1', form({ transportBy: 'SENDER', carrierName: 'X' }), CELLS)).toMatchObject({ carrierName: null, trackingNumber: null })
    expect(elsewhereBody('o1', form({ ddtNumber: '  ', invoiceInstead: true }), CELLS)).toMatchObject({ externalDdt: null, ddtRequired: false })
    expect(serialsOf('A1\nA2;A3  A4')).toEqual(['A1', 'A2', 'A3', 'A4'])
  })

  it('pieces still waiting for quality (ordered, not closed short, not released)', () => {
    expect(waitingForQuality({ progress: { ordered: 30, closedShort: 2, released: 4 } } as never)).toBe(24)
    expect(waitingForQuality({ progress: { ordered: 4, closedShort: 0, released: 4 } } as never)).toBe(0)
  })
})

describe('the live rules under their fields (the API’s own rule, on this clock)', () => {
  it('nothing to say for released garments that left yesterday with a paper DDT of that day', () => {
    expect(places(form())).toEqual({ left: [], ddt: [], lines: [], byCell: {} })
  })

  it('"Not in the future", "At most 60 days back", "Not before the garments were released ({date})"', () => {
    expect(places(form({ shippedAt: '2026-11-20T09:00:00.000Z' })).left).toEqual([{ key: 'elsewhere.future' }])
    expect(places(form({ shippedAt: '2026-09-01T09:00:00.000Z', ddtDate: '2026-09-01' }), preview({ lines: [{ ...preview().lines[0]!, releasedAt: '2026-08-01T09:00:00.000Z' }] })).left).toEqual([{ key: 'elsewhere.tooOld', params: { days: 60 } }])
    expect(places(form({ shippedAt: '2026-11-11T09:00:00.000Z', ddtDate: '2026-11-11' })).left).toEqual([{ key: 'elsewhere.beforeRelease', params: { date: '2026-11-12' } }])
  })

  it('the paper DDT: required unless an immediate invoice travelled instead; dated on or before the day it left', () => {
    expect(places(form({ ddtNumber: '' })).ddt).toEqual([{ key: 'elsewhere.ddtRequired' }])
    expect(places(form({ ddtNumber: '', invoiceInstead: true })).ddt).toEqual([])
    expect(places(form({ shippedAt: '2026-11-17T09:00:00.000Z', ddtDate: '2026-11-18' })).ddt).toEqual([{ key: 'elsewhere.ddtAfter' }])
  })

  it('a size names its own problems: more than it can still ship, a serial missing', () => {
    const over = places(form({ quantities: { c1: 4 } }))
    expect(over.byCell.c1).toEqual([{ key: 'elsewhere.notReleased' }])
    const serials = places(form({ quantities: { c2: 2 }, serials: { c2: 'SN-1' } }), preview({ lines: [{ workOrderSizeId: 'c2', label: 'WO-DEMO-0051 BLK 54', quantity: 2, shippable: 3, releasedAt: '2026-11-12T09:00:00.000Z', serialTracked: true }] }))
    expect(serials.byCell.c2).toEqual([{ key: 'elsewhere.serialsMissing', params: { count: 1, total: 2 } }])
  })
})

describe('what holds Record, and a refusal in words', () => {
  const held = (over: Partial<Parameters<typeof recordHeld>[0]> = {}) => recordHeld({ busy: false, form: form(), problems: [], preview: preview(), customer: 'Moto Demo S.r.l.', ...over })

  it('busy, no garment, still reading, a live problem, the paper DDT recorded already, the customer held (R-9) — in that order', () => {
    expect(held()).toBeNull()
    expect(held({ busy: true })).toEqual({ key: 'held.busy' })
    expect(held({ form: form({ quantities: {} }) })).toEqual({ key: 'elsewhere.noLines' })
    expect(held({ preview: null })).toEqual({ key: 'elsewhere.held.reading' })
    expect(held({ problems: liveProblems(form({ ddtNumber: '' }), CELLS, preview(), NOW) })).toEqual({ key: 'elsewhere.held.problems' })
    expect(held({ preview: preview({ ddtUsed: true }) })).toEqual({ key: 'elsewhere.ddtUsed' })
    expect(held({ preview: preview({ holds: { held: true, accountHold: 'On hold.', creditHeld: false, mayRelease: false } }) })).toEqual({ key: 'elsewhere.held.customer', params: { customer: 'Moto Demo S.r.l.' } })
    const releaser = preview({ holds: { held: true, accountHold: null, creditHeld: true, mayRelease: true } })
    expect(held({ preview: releaser })).toEqual({ key: 'elsewhere.held.reason' })
    expect(held({ preview: releaser, form: form({ holdReason: 'The van left before the hold' }) })).toBeNull()
  })

  it('the API’s refusals in this screen’s words (R-10: "already recorded" names no customer)', () => {
    const conflict = (path: string) => new ApiError('conflict', 409, 'conflict', 'x', null, [{ path, message: 'x' }])
    expect(refusalOf(conflict('refusal/DDT_NUMBER_USED'), 'Moto Demo S.r.l.')).toEqual({ words: { key: 'elsewhere.ddtUsed' }, detail: null })
    expect(refusalOf(conflict('refusal/HELD'), 'Moto Demo S.r.l.').words).toEqual({ key: 'elsewhere.held.customer', params: { customer: 'Moto Demo S.r.l.' } })
    expect(refusalOf(conflict('refusal/REASON_REQUIRED'), 'Moto Demo S.r.l.').words).toEqual({ key: 'elsewhere.held.reason' })
    expect(refusalOf(new ApiError('forbidden', 403, 'forbidden', 'x'), 'C').words).toEqual({ key: 'elsewhere.held.noRight' })
    expect(refusalOf(new ApiError('conflict', 409, 'invalid_state', 'Several orders in one shipment come with the next update.'), 'C')).toEqual({ words: { key: 'elsewhere.refusal.state' }, detail: 'Several orders in one shipment come with the next update.' })
    expect(refusalOf(new Error('offline'), 'C').words).toEqual({ key: 'elsewhere.refusal.failed' })
    expect(CATALOGUE.en.orders?.['elsewhere.ddtUsed']).toBe('That DDT number and date are already recorded.')
  })
})

describe('the "Made elsewhere" chip and the doors on the order page', () => {
  it('names the paper DDT, or the immediate invoice that travelled instead; nothing for a shipment made here', () => {
    expect(madeElsewhereChip({ origin: 'ELSEWHERE', externalDdt: { number: '123/2026' } })).toEqual({ key: 'elsewhere.chip', params: { ddt: '123/2026' } })
    expect(madeElsewhereChip({ origin: 'ELSEWHERE', externalDdt: null })).toEqual({ key: 'elsewhere.chipInvoice' })
    expect(madeElsewhereChip({ origin: 'NEXUS', externalDdt: null })).toBeNull()
    expect(madeElsewhereChip({})).toBeNull()
  })

  it('Shipments: the card head’s door and the row’s chip, in both languages', () => {
    const item = recordScreen.cases.find((entry) => entry.id === 'shipments')!.model
    const value = item.record.order.status === 'ready' ? item.record.order.value : null
    expect(value).not.toBeNull()
    const order = { ...value!, chain: { ...value!.chain, shipments: value!.chain.shipments.map((row, index) => (index === 0 ? { ...row, origin: 'ELSEWHERE' as const, externalDdt: { number: '123/2026', date: '2026-11-18' } } : row)) } }
    const model = { ...item, record: { ...item.record, order: { status: 'ready' as const, value: order }, elsewhere: { held: { key: 'elsewhere.held.noRight' }, dialog: null } } }
    for (const locale of LOCALES) {
      const text = textOf(renderView(recordScreen.view as ComponentType<{ model: unknown }>, model, locale))
      expect(text).toContain(locale === 'en' ? 'Made elsewhere · DDT 123/2026' : 'Fatta altrove · DDT 123/2026')
      expect(text).toContain(locale === 'en' ? 'Record a shipment made elsewhere…' : 'Registra una spedizione fatta altrove…')
    }
  })

  it('the ⋯ Next steps and the card head open the same dialog; the view fetches nothing (its container reads)', () => {
    const view = readFileSync(new URL('../../view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("{ id: 'elsewhere', label: t('elsewhere.title')")
    const tab = readFileSync(new URL('../../view/ShipmentsTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('onClick={() => actions?.onRecordElsewhere?.()}')
    const dialog = readFileSync(new URL('./view/ElsewhereDialog.tsx', import.meta.url), 'utf8')
    expect(dialog).not.toMatch(/useOfficeApi|previewElsewhere\(|recordElsewhere\(|readyToShip\(/)
  })
})

describe('Warehouse shows a shipment made elsewhere as it is (no "issue the replacement DDT")', () => {
  it('the band’s tag and the notice name its paper DDT; Documents never offers a Nexus DDT of it', () => {
    const item = warehouseScreen.cases.find((entry) => entry.id === 'shipped')!.model
    const shipment = item.record.shipment.status === 'ready' ? item.record.shipment.value : null
    expect(shipment).not.toBeNull()
    const elsewhere = { ...shipment!, origin: 'ELSEWHERE' as const, externalDdt: { number: '123/2026', date: '2026-11-18' } }
    for (const tab of ['lines', 'documents'] as const) {
      const model = { ...item, record: { ...item.record, tab, shipment: { status: 'ready' as const, value: elsewhere }, ddts: { value: [], problem: null }, ddt: null } }
      const text = textOf(renderView(warehouseScreen.view as ComponentType<{ model: unknown }>, model, 'en'))
      expect(text).toContain('Made elsewhere · DDT 123/2026')
      expect(text).not.toContain('issue the replacement DDT')
      // Documents: the DDT card says the paper DDT is the document (no draft, no Issue DDT).
      if (tab === 'documents') {
        expect(text).toContain('Recorded as made elsewhere: it left with paper DDT n. 123/2026')
      }
    }
  })
})

describe('every word it draws, in both languages', () => {
  it('each elsewhere.* key the dialog, the model and the order page use exists in it and en (a plural by its forms)', () => {
    const sources = ['./view/ElsewhereDialog.tsx', './model.ts', '../../view/ShipmentsTab.tsx', '../../view/OrderRecordView.tsx'].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n')
    const keys = [...new Set([...sources.matchAll(/'(elsewhere\.[a-zA-Z.]+)'/g)].map((match) => match[1]!))]
    expect(keys.length).toBeGreaterThan(30)
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale].orders ?? {}
      for (const key of keys) expect(words[key] ?? words[`${key}_other`], `${locale} ${key}`).toBeTruthy()
      for (const by of ['CARRIER', 'SENDER', 'RECIPIENT']) expect(words[`elsewhere.by.${by}`], `${locale} by ${by}`).toBeTruthy()
    }
  })

  it('every design case is made of the API’s shapes and the live rules of its clock', () => {
    expect(designScreen.cases.length).toBeGreaterThan(10)
    const future = designScreen.cases.find((entry) => entry.id === 'future')!.model
    expect(future.problems.map((problem) => problem.code)).toEqual(expect.arrayContaining(['FUTURE', 'DDT_AFTER_LEFT']))
    expect(designScreen.cases.find((entry) => entry.id === 'ready')!.model.problems).toEqual([])
    expect(createElement(designScreen.view, { model: designScreen.cases[0]!.model })).toBeTruthy()
  })
})
