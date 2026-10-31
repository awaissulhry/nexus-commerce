import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { FLOOR_NAMESPACES } from '../routes'
import type { KitBundle, KitLine, KitOrder } from './api'
import { designScreen } from './fixtures'
import {
  backHeld,
  bringBack,
  bundlesOut,
  ddtHeld,
  emptyBack,
  emptyDdt,
  emptyKit,
  kitHeld,
  missingOf,
  outOf,
  receiveBody,
  rejectBack,
  scanBack,
  scanKit,
  sendBody,
  setReturn,
  tickAll,
  toggleBundle,
  toggleLine,
} from './model'

/** SCR-181's rules: the kit's ticks and their hold, the send's body with its DDT, the way back by bundle (made-up data). */

const place = (id: string) => ({ id, code: id.toUpperCase(), name: id })
const line = (id: string, extra: Partial<KitLine> = {}): KitLine => ({
  id,
  seq: 10,
  item: { id: `item-${id}`, code: `ITEM-${id}`, name: 'Material', baseUom: 'M', tracking: 'LOT' },
  colour: null,
  lot: null,
  hide: null,
  quantity: '5.0000',
  uom: 'M',
  baseQuantity: '5.0000',
  status: 'PLANNED',
  sentAt: null,
  ddtNumber: null,
  sources: [
    { location: place('s2'), lot: { id: 'lot-b', code: 'LOT-B' }, hide: null, available: '2.0000', covers: false },
    { location: place('s1'), lot: { id: 'lot-a', code: 'LOT-A' }, hide: null, available: '50.0000', covers: true },
  ],
  from: null,
  atWorkshop: null,
  ...extra,
})
const bundle = (id: string, extra: Partial<KitBundle> = {}): KitBundle => ({ id, code: `BN-${id}`, replacedCodes: [], workOrderSizeId: 'c1', colourway: 'BLK', size: '50', part: null, quantity: 3, sent: false, back: [], ...extra })
const order = (extra: Partial<KitOrder> = {}): KitOrder => ({
  id: 'o1',
  number: 'SC-T-1',
  status: 'ISSUED',
  version: 5,
  workshop: { code: 'W', name: 'Workshop' },
  location: { code: 'W-PLACE', name: 'At the workshop' },
  workOrder: { number: 'WO-1', style: { code: 'S', name: 'Style' } },
  expectedBackDate: null,
  late: false,
  operations: [{ id: 'op1', seq: 10, code: 'SEW', name: 'Sew', pieces: 9, sent: 0, backGood: 0, backDefective: 0, scrapped: 0, atWorkshop: 0, cells: [] }],
  kitLines: [line('k1')],
  bundles: [bundle('b1', { replacedCodes: ['OLD-1'] }), bundle('b2'), bundle('b3', { sent: true })],
  places: [{ ...place('s1'), kind: 'BIN' }],
  ddts: [],
  actions: { send: null, receive: null },
  ...extra,
})

describe('Send a kit', () => {
  it('a scan ticks a bundle by its ticket (or an earlier one), a line by its lot (that place) or its code (the place that holds it all)', () => {
    const kit = order()
    expect(scanKit(kit, 'bn-b1')).toEqual({ kind: 'bundle', bundleId: 'b1' })
    expect(scanKit(kit, 'OLD-1')).toEqual({ kind: 'bundle', bundleId: 'b1' })
    expect(scanKit(kit, 'BN-b3')).toEqual({ kind: 'sentBefore', code: 'BN-b3' })
    expect(scanKit(kit, 'lot-b')).toEqual({ kind: 'line', lineId: 'k1', source: 0 })
    expect(scanKit(kit, 'ITEM-k1')).toEqual({ kind: 'line', lineId: 'k1', source: 1 })
    expect(scanKit(kit, 'X')).toEqual({ kind: 'none' })
  })

  it("holds the DDT step while anything listed is not ticked, in the design's count; a material not in stock first", () => {
    const kit = order()
    const one = toggleBundle(emptyKit(), 'b1')
    expect(kitHeld(kit, one)).toBe('missing')
    expect(missingOf(kit, one)).toEqual({ lines: 1, bundles: 1, noStock: 0 })
    expect(kitHeld(kit, tickAll(kit))).toBeNull()
    expect(kitHeld(order({ kitLines: [line('k1', { sources: [] })] }), tickAll(kit))).toBe('noStock')
    expect(kitHeld(order({ actions: { send: 'On hold.', receive: null } }), tickAll(kit))).toBe('state')
    expect(kitHeld(order({ kitLines: [], bundles: [bundle('b3', { sent: true })] }), emptyKit())).toBe('nothing')
    // Untick and tick again.
    expect(toggleBundle(toggleBundle(one, 'b2'), 'b2')).toEqual(one)
    expect(toggleLine(toggleLine(emptyKit(), kit.kitLines[0]!), kit.kitLines[0]!)).toEqual(emptyKit())
  })

  it('sends the ticked lines from their places with their lots, the bundles not sent before, and the DDT in its own words', () => {
    const kit = order()
    expect(ddtHeld(emptyDdt())).toBe('transport')
    expect(ddtHeld({ ...emptyDdt(), transportBy: 'SENDER' })).toBe('weight')
    const ddt = { transportBy: 'RECIPIENT' as const, packages: 2, grossWeightKg: 6.5, appearance: 'BAGS' as const }
    expect(ddtHeld(ddt)).toBeNull()
    expect(sendBody(kit, tickAll(kit), ddt)).toEqual({
      version: 5,
      lines: [{ lineId: 'k1', fromLocationId: 's1', lotId: 'lot-a', hideId: null }],
      bundles: [{ bundleId: 'b1' }, { bundleId: 'b2' }],
      ddt: { transportBy: 'RECIPIENT', packages: 2, grossWeightKg: '6.500', appearance: 'Sacchi' },
    })
  })
})

describe('Receive back', () => {
  const out = order({
    status: 'AT_WORKSHOP',
    operations: [
      { id: 'op1', seq: 10, code: 'SEW', name: 'Sew', pieces: 9, sent: 6, backGood: 1, backDefective: 0, scrapped: 0, atWorkshop: 5, cells: [] },
      { id: 'op2', seq: 20, code: 'PRESS', name: 'Press', pieces: 3, sent: 3, backGood: 0, backDefective: 0, scrapped: 0, atWorkshop: 3, cells: ['c2'] },
    ],
    bundles: [bundle('b1', { sent: true, back: [{ operationId: 'op1', good: 1, defective: 0, scrapped: 0 }] }), bundle('b2', { sent: true }), bundle('b4', { sent: true, part: 'SLEEVES' }), bundle('b5')],
    kitLines: [line('k1', { status: 'SENT', sources: [], from: place('s1'), atWorkshop: '4.0000', lot: { id: 'lot-a', code: 'LOT-A' } })],
  })

  it('lists the whole-garment bundles out; a scan brings back the garments still out (no tap), once', () => {
    expect(bundlesOut(out).map((entry) => entry.id)).toEqual(['b1', 'b2'])
    expect(outOf(out, out.bundles[0]!)).toBe(2)
    expect(scanBack(out, emptyBack(), 'BN-b1')).toEqual({ kind: 'bundle', bundleId: 'b1' })
    const back = bringBack(out, emptyBack(), 'b1')
    expect(back.entries.b1).toEqual({ good: 2, defective: 0, scrapped: 0, reason: null })
    expect(scanBack(out, back, 'BN-b1')).toEqual({ kind: 'allBack', code: 'BN-b1' })
    expect(scanBack(out, back, 'BN-b4')).toEqual({ kind: 'notOut', code: 'BN-b4' })
    expect(scanBack(out, back, 'BN-b5')).toEqual({ kind: 'notOut', code: 'BN-b5' })
    expect(scanBack(out, back, 'DDT-77')).toEqual({ kind: 'none' })
  })

  it('a rejection takes garments off the good ones with its reason; Finish waits for the reason when reasons exist', () => {
    const back = rejectBack(out, bringBack(out, emptyBack(), 'b2'), 'b2', 1, 'scrapped', null)
    expect(back.entries.b2).toEqual({ good: 2, defective: 0, scrapped: 1, reason: null })
    expect(backHeld(out, back, true)).toBe('reason')
    expect(backHeld(out, back, false)).toBeNull()
    expect(backHeld(out, emptyBack(), true)).toBe('nothing')
  })

  it('posts each bundle once per operation it passes, the material back to its place, the workshop’s note', () => {
    let back = rejectBack(out, bringBack(out, emptyBack(), 'b2'), 'b2', 1, 'defective', 'OPEN_SEAM')
    back = setReturn(back, out.kitLines[0]!, 9, null)
    back = { ...back, ddtNumber: 'W-77' }
    // b2's cell c1 is sent by op1 only (op2 sends c2); the material is capped at what is at the workshop.
    expect(receiveBody(out, back)).toEqual({
      version: 5,
      lines: [{ operationId: 'op1', bundleId: 'b2', good: 2, defective: 1, scrapped: 0, reason: 'OPEN_SEAM' }],
      returns: [{ itemId: 'item-k1', itemColourId: null, lotId: 'lot-a', hideId: null, quantity: '4.0000', uom: 'M', toLocationId: 's1' }],
      supplierDdt: { number: 'W-77' },
    })
  })
})

describe('SCR-181 Receive back: why a bundle came back rejected (B-W2a-F6: the floor\'s one reason picker)', () => {
  const render = (id: string, locale: 'it' | 'en' = 'en') => {
    const item = designScreen.cases.find((entry) => entry.id === id)
    if (!item) throw new Error(id)
    const View = designScreen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, FLOOR_NAMESPACES) }, createElement(View, { model: item.model })))
  }

  it('asks why in the picker over the REWORK list; Confirm waits for a reason while the list offers some', () => {
    const picked = render('back-reject')
    for (const word of ['Back from the workshop', 'Why were they rejected?', 'Chosen: Open seam', 'Wrong stitch']) expect(picked).toContain(word)
    expect(render('back-reject', 'it')).toContain('Scelto: Cucitura aperta')
    const missing = render('back-scrapped')
    expect(missing).toContain('No reason chosen yet')
    expect(missing).toContain('Choose a reason first')
  })

  it('without the list (reading, failed, none set) the picker says so, and the rejection goes without a reason', () => {
    expect(render('back-reasons-loading')).toContain('Loading the reasons')
    expect(render('back-reasons-loading')).not.toContain('The rejection goes without a reason.')
    const failed = render('back-no-reasons')
    expect(failed).toContain('Could not load the reasons')
    expect(failed).toContain('The rejection goes without a reason.')
    expect(failed).not.toContain('Choose a reason first')
    expect(render('back-reasons-none')).toContain('Ask the office')
    expect(render('back-reasons-none', 'it')).toContain('Lo scarto va senza motivo.')
  })
})
