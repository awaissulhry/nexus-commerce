import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PARCEL_TRACKING_LIMITS } from '@nexus/factory-domain/shipping/own-transport/rules'
import type { Transport, TransportParcel } from './api'
import { awbCheck, noticeOffered, parcelChangesOf, parcelProblem, trackingBody, trackingDialogOf, trackingProblem, trackingReasonNeeded } from './model'

/**
 * F-OS-301 (order SHIPMENTS tab; Owner D4; 10-design §7 D5; 18-lead-settles L2, L4; 13-backend B-OS-022) — Tracking numbers…, Warehouse's
 * tracking dialog extended ONCE for both pages, pure: one row per parcel no label tracks (a labelled one is read only), the body sends
 * only the parcels that change, a number the customer saw that changes after the goods left asks why, the air waybill's last digit
 * checked in words (never a refusal), "Send the shipping notice again" offered once the goods left. Made-up data only.
 */

const uid = (n: number) => `0190f0e2-7499-7000-8000-${String(n).padStart(12, '0')}`
const may = { allowed: true, refusal: null }
const parcel = (seq: number, over: Partial<TransportParcel> = {}): TransportParcel => ({ id: uid(10 + seq), seq, label: null, typed: null, may, ...over })

const transport = (shipment: Partial<Transport['shipment']> = {}, parcels: TransportParcel[] | undefined = [parcel(1), parcel(2), parcel(3)]): Transport => ({
  shipment: { id: uid(1), number: 'SEED-SH-0014', status: 'PACKED', version: 4, transportBy: 'CARRIER', carrierCode: null, carrierName: 'Seed Air Cargo', serviceCode: null, manualTrackingNumber: null, manualTrackingUrl: null, ddtRequired: false, shippedAt: null, deliveredAt: null, returnedAt: null, ...shipment },
  arrangement: 'MANUAL_CARRIER',
  ddt: null,
  labels: { carrier: 0, test: 0 },
  may: { arrange: may, track: may, status: may },
  events: [],
  ...(parcels ? { parcels } : {}),
})

describe('Tracking numbers… opens on what the shipment has now', () => {
  it('the consignment number and link, then one row per parcel no label tracks (a labelled parcel is read only, never in the rows)', () => {
    const read = transport({ manualTrackingNumber: '157-12345675', manualTrackingUrl: 'https://track.seed-air-cargo.example.com/157-12345675' }, [parcel(2, { typed: { number: 'HAWB-2', url: null } }), parcel(1, { label: { number: 'BRT-001', test: false, url: null } }), parcel(3)])
    const dialog = trackingDialogOf(read)
    expect(dialog).toMatchObject({ kind: 'tracking', text: '157-12345675', link: 'https://track.seed-air-cargo.example.com/157-12345675', reason: '', notify: false })
    expect(dialog.parcels).toEqual([
      { id: uid(12), seq: 2, text: 'HAWB-2', link: '' },
      { id: uid(13), seq: 3, text: '', link: '' },
    ])
  })

  it('an older answer without parcels keeps the one number, as before (no parcel rows)', () => {
    expect(trackingDialogOf(transport({}, undefined)).parcels).toBeUndefined()
  })
})

describe('the body: the shipment\'s number as before, plus only the parcels that change', () => {
  it('sends a parcel once its number or link differs from the read; a blank number clears it, and its link with it', () => {
    const read = transport({}, [parcel(1, { typed: { number: 'HAWB-1', url: 'https://example.com/1' } }), parcel(2), parcel(3, { typed: { number: 'HAWB-3', url: null } })])
    const dialog = { ...trackingDialogOf(read), text: '157-12345675', parcels: [{ id: uid(11), seq: 1, text: 'HAWB-1', link: 'https://example.com/1' }, { id: uid(12), seq: 2, text: ' HAWB-2 ', link: 'https://example.com/2' }, { id: uid(13), seq: 3, text: '', link: 'https://example.com/3' }] }
    expect(parcelChangesOf(dialog, read)).toEqual([
      { parcelId: uid(12), trackingNumber: 'HAWB-2', trackingUrl: 'https://example.com/2' },
      { parcelId: uid(13), trackingNumber: null, trackingUrl: null },
    ])
    expect(trackingBody(dialog, 4, read)).toEqual({ version: 4, trackingNumber: '157-12345675', trackingUrl: null, parcels: parcelChangesOf(dialog, read) })
    // Before the goods left no reason is asked or sent.
    expect(trackingReasonNeeded(dialog, read)).toBe(false)
  })

  it('nothing changed on the parcels: today\'s body exactly (F-OP-135)', () => {
    const read = transport({ manualTrackingNumber: '0123456789' })
    expect(trackingBody(trackingDialogOf(read), 4, read)).toEqual({ version: 4, trackingNumber: '0123456789', trackingUrl: null })
    expect(trackingBody({ kind: 'tracking', text: '', link: '' }, 4)).toEqual({ version: 4, trackingNumber: null, trackingUrl: null })
  })

  it('a labelled parcel is never sent, even if a row for it were typed', () => {
    const read = transport({}, [parcel(1, { label: { number: 'BRT-001', test: true, url: null } })])
    expect(parcelChangesOf({ kind: 'tracking', text: '', parcels: [{ id: uid(11), seq: 1, text: 'TYPED-1', link: '' }] }, read)).toEqual([])
  })
})

describe('after the goods left: a number the customer saw that changes asks why (B-OS-022\'s rule)', () => {
  const left = transport({ status: 'SHIPPED', shippedAt: '2026-11-18T09:00:00.000Z' }, [parcel(1, { typed: { number: 'HAWB-1', url: null } }), parcel(2)])
  it('changing or clearing a seen number needs 3 to 500 characters; typing a first number does not', () => {
    const first = { ...trackingDialogOf(left), parcels: [{ id: uid(11), seq: 1, text: 'HAWB-1', link: '' }, { id: uid(12), seq: 2, text: 'HAWB-2', link: '' }] }
    expect(trackingReasonNeeded(first, left)).toBe(false)
    expect(trackingProblem(first, null, left)).toBeNull()
    const changed = { ...first, parcels: [{ id: uid(11), seq: 1, text: 'HAWB-1-B', link: '' }, { id: uid(12), seq: 2, text: '', link: '' }] }
    expect(trackingReasonNeeded(changed, left)).toBe(true)
    expect(trackingProblem(changed, null, left)).toEqual({ key: 'door.tracking.why', params: { min: PARCEL_TRACKING_LIMITS.reasonMin } })
    const why = { ...changed, reason: 'The forwarder sent the right number for parcel 1.' }
    expect(trackingProblem(why, null, left)).toBeNull()
    expect(trackingBody(why, 4, left).reason).toBe('The forwarder sent the right number for parcel 1.')
    expect(trackingProblem({ ...changed, reason: 'x'.repeat(PARCEL_TRACKING_LIMITS.reasonMax + 1) }, null, left)).toEqual({ key: 'transport.form.tooLong', params: { max: PARCEL_TRACKING_LIMITS.reasonMax } })
    const cleared = { ...first, parcels: [{ id: uid(11), seq: 1, text: '', link: '' }, { id: uid(12), seq: 2, text: '', link: '' }] }
    expect(trackingReasonNeeded(cleared, left)).toBe(true)
  })

  it('"Send the shipping notice again" is offered once the goods left, never before', () => {
    expect(noticeOffered(left)).toBe(true)
    expect(noticeOffered(transport())).toBe(false)
    expect(noticeOffered(transport({ status: 'DELIVERED' }))).toBe(true)
  })
})

describe('each parcel\'s number by the shipment\'s own rules; the air waybill checked in words, never refused (L4)', () => {
  it('one line, the lengths, a link only with its number and on https', () => {
    expect(parcelProblem({ id: uid(11), seq: 1, text: 'HAWB-1', link: 'https://example.com/1' })).toBeNull()
    expect(parcelProblem({ id: uid(11), seq: 1, text: 'A\nB', link: '' })).toMatchObject({ key: 'door.tracking.parcelTooLong', params: { seq: 1 } })
    expect(parcelProblem({ id: uid(11), seq: 2, text: '', link: 'https://example.com/2' })).toEqual({ key: 'door.tracking.parcelLinkNeedsNumber', params: { seq: 2 } })
    expect(parcelProblem({ id: uid(11), seq: 3, text: 'HAWB-3', link: 'http://example.com/3' })).toMatchObject({ key: 'door.tracking.parcelLink', params: { seq: 3 } })
    // The dialog holds Save with the first parcel's problem.
    const read = transport()
    expect(trackingProblem({ ...trackingDialogOf(read), parcels: [{ id: uid(12), seq: 2, text: '', link: 'https://example.com/2' }] }, null, read)).toEqual({ key: 'door.tracking.parcelLinkNeedsNumber', params: { seq: 2 } })
  })

  it('157-12345675 fits (1234567 mod 7 = 5); a wrong last digit says check it; anything else says nothing', () => {
    expect(awbCheck('157-12345675')).toBe('fits')
    expect(awbCheck('15712345675')).toBe('fits')
    expect(awbCheck('157 12345676')).toBe('off')
    expect(awbCheck('BRT 0581 2290 0112')).toBeNull()
    expect(awbCheck('')).toBeNull()
    // Never a refusal: an "off" air waybill number still saves.
    const read = transport()
    expect(trackingProblem({ ...trackingDialogOf(read), text: '157-12345676' }, null, read)).toBeNull()
  })
})

describe('one dialog for both pages (13-backend §7: extended once, never copied)', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  it('Warehouse\'s card and the tab\'s door open the same TrackingDialog on trackingDialogOf; the write sends the parcels, then the notice only when ticked', () => {
    const view = source('./view/TransportView.tsx')
    expect(view).toContain('actions?.onDialog?.(trackingDialogOf(transport)')
    expect(view).toContain('<TrackingDialog transport={transport} model={model} actions={actions} parcelWords={parcelWords} />')
    expect(view.match(/function TrackingDialog\(/g)?.length).toBe(1)
    const door = source('../../../sales/orders/record/shipments/ShipmentTransportDoor.tsx')
    expect(door).toContain('return trackingDialogOf(transport)')
    const hook = source('./CarrierDepth.tsx')
    expect(hook).toContain('typeTrackingNumber(api, shipmentId, trackingBody(dialog, transport.shipment.version, transport), key)')
    expect(hook).toContain('if (!notify) return { next, done: saved, problem: null }')
    expect(hook).toContain('await sendNotice(api, shipmentId, null,')
  })
})
