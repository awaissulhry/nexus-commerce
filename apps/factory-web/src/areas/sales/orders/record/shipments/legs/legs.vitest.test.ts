import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../../../lib/api/errors'
import type { Leg } from './api'
import { atWarehouseIds, legActsOf, legByShipment, legChipOf, legsForAct, sendOnActKey, sendOnBody, sendOnHeld, sendOnLines, SEND_ON_MAX, warningsOf } from './model'

/**
 * owb-ss3 step 3.2 (design plan § 7; settles L2, L5) — the warehouse leg, pure: the act a leg offers (once each, by the server's `may`
 * and the pack-and-send right), the shipments at our warehouse, the chip, the Send on form and the 409 WARNINGS of the base helper
 * (a payment due before shipping is open: a yellow line in words; "Send it anyway" sends `overrides`). Made-up data only.
 */

const leg = (shipmentId: string, state: Leg['state'], over: Partial<Leg> = {}): Leg => ({
  shipmentId,
  version: 3,
  warehouse: { siteId: 'wh-1', name: 'Milan warehouse', city: 'Milan' },
  state,
  arrivedAt: state === 'ON_THE_WAY' ? null : '2026-11-20T09:00:00.000Z',
  forwardedAt: state === 'SENT_ON' ? '2026-11-22T09:00:00.000Z' : null,
  forwardedWithoutLabel: false,
  label: null,
  may: { arrived: state === 'ON_THE_WAY', sendOn: state === 'AT_OUR_WAREHOUSE', label: true },
  ...over,
})
const SEND = { send: true }

describe('the act a leg offers now', () => {
  it('on its way: It arrived at the warehouse; at our warehouse: Send on to the customer; sent on: nothing', () => {
    expect(legActsOf(leg('a', 'ON_THE_WAY'), SEND)).toEqual(['ARRIVED'])
    expect(legActsOf(leg('b', 'AT_OUR_WAREHOUSE'), SEND)).toEqual(['SEND_ON'])
    expect(legActsOf(leg('c', 'SENT_ON'), SEND)).toEqual([])
    expect(legActsOf(leg('b', 'AT_OUR_WAREHOUSE'), { send: false })).toEqual([])
  })

  it('the window lists the shipments the act fits; the bar counts only the ones at our warehouse now', () => {
    const legs = [leg('a', 'ON_THE_WAY'), leg('b', 'AT_OUR_WAREHOUSE'), leg('c', 'SENT_ON'), leg('d', 'AT_OUR_WAREHOUSE')]
    expect(legsForAct(legs, 'SEND_ON', SEND).map((entry) => entry.shipmentId)).toEqual(['b', 'd'])
    expect(legsForAct(legs, 'ARRIVED', SEND).map((entry) => entry.shipmentId)).toEqual(['a'])
    expect([...atWarehouseIds(legs)]).toEqual(['b', 'd'])
    expect(atWarehouseIds(null).size).toBe(0)
    expect(legByShipment(legs).get('c')?.state).toBe('SENT_ON')
  })

  it('the chip: on its way to the warehouse · at our warehouse with the label here or awaited · sent on (without the label)', () => {
    expect(legChipOf(leg('a', 'ON_THE_WAY'))).toEqual({ kind: 'onTheWay', place: 'Milan warehouse' })
    expect(legChipOf(leg('b', 'AT_OUR_WAREHOUSE'))).toEqual({ kind: 'atWarehouse', place: 'Milan warehouse', label: false })
    expect(legChipOf(leg('b', 'AT_OUR_WAREHOUSE', { label: { sentAt: '2026-11-21T09:00:00.000Z', byCustomer: true, fileId: 'file-1' } }))).toEqual({ kind: 'atWarehouse', place: 'Milan warehouse', label: true })
    expect(legChipOf(leg('c', 'SENT_ON', { forwardedWithoutLabel: true }))).toEqual({ kind: 'sentOn', withoutLabel: true })
  })
})

describe('Send on to the customer', () => {
  it('carrier and tracking are optional (blank: null); only their length holds it', () => {
    expect(sendOnHeld({ carrier: '', trackingNumber: '' }, false)).toBeNull()
    expect(sendOnHeld({ carrier: 'x'.repeat(SEND_ON_MAX + 1), trackingNumber: '' }, false)).toEqual({ key: 'leg.held.long', params: { max: SEND_ON_MAX } })
    expect(sendOnHeld({ carrier: '', trackingNumber: '' }, true)).toEqual({ key: 'leg.held.busy' })
    expect(sendOnBody(leg('b', 'AT_OUR_WAREHOUSE'), { carrier: '  ', trackingNumber: ' 1Z999 ' })).toEqual({ version: 3, carrier: null, trackingNumber: '1Z999' })
  })

  it('no label from the customer yet: a yellow line, never a stop; the payment warning joins it after a 409', () => {
    expect(sendOnLines(leg('b', 'AT_OUR_WAREHOUSE'), null)).toEqual([{ key: 'leg.noLabel' }])
    expect(sendOnLines(leg('b', 'AT_OUR_WAREHOUSE', { label: { sentAt: '2026-11-21T09:00:00.000Z', byCustomer: true, fileId: 'file-1' } }), ['PAYMENT_DUE_AT_SHIP'])).toEqual([{ key: 'warning.paymentDueAtShip' }])
  })

  it('the 409 WARNINGS path: the kinds read from the issues; "Send it anyway" sends them as overrides', () => {
    const answer = new ApiError('conflict', 409, 'conflict', 'Check before you go on: A payment due before shipping is still open. Go on only if you mean it.', null, [{ path: 'warning/PAYMENT_DUE_AT_SHIP', message: 'A payment due before shipping is still open.' }])
    expect(warningsOf(answer)).toEqual(['PAYMENT_DUE_AT_SHIP'])
    expect(sendOnActKey(warningsOf(answer))).toBe('leg.sendOn.anyway')
    expect(sendOnActKey(null)).toBe('leg.sendOn.act')
    expect(sendOnBody(leg('b', 'AT_OUR_WAREHOUSE'), { carrier: 'GLS', trackingNumber: '' }, ['PAYMENT_DUE_AT_SHIP'])).toEqual({ version: 3, carrier: 'GLS', trackingNumber: null, overrides: ['PAYMENT_DUE_AT_SHIP'] })
    // Another refusal is not a warning: it is said by its own words.
    expect(warningsOf(new ApiError('conflict', 409, 'conflict', 'No live sale DDT.', null, [{ path: 'shipment/ddt', message: 'No live sale DDT.' }]))).toBeNull()
    expect(warningsOf(new ApiError('forbidden', 403, 'forbidden', 'No.'))).toBeNull()
    expect(warningsOf(new Error('network'))).toBeNull()
  })
})
