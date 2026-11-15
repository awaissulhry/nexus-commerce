import { createElement, Fragment } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { LabelCheck, LabelJobs, Transport } from './api'
import type { ReprintModel, TransportModel } from './model'
import { ReprintView } from './view/ReprintView'
import { TransportView } from './view/TransportView'

/**
 * SCR-595 — Carrier & label in depth (B-W2b-410 on B-W2b-390 and B-W2b-391; design sh-booking "own van or manual; customer
 * collects", sh-labels "Reprint with a reason"): how it travels, the statuses typed, the check before printing, the label
 * prints and a reprint with a reason. Made-up data only (carrier "Demo Express", printer "Banco etichette 1").
 */

const uid = (n: number) => `0190f0e2-7412-7000-8000-${String(n).padStart(12, '0')}`
const may = { allowed: true, refusal: null }
const no = (code: 'LEFT' | 'LABELLED' | 'DECLARED' | 'NOT_LEFT' | 'CARRIER_TRACKED' | 'CUSTOMER_COLLECTS' | 'NOT_A_CARRIER') => ({ allowed: false, refusal: { code } })

const transport = (over: Partial<Transport> = {}, shipment: Partial<Transport['shipment']> = {}): Transport => ({
  shipment: { id: uid(1), number: 'SH-26-0107', status: 'PACKED', version: 7, transportBy: 'CARRIER', carrierCode: 'demo-express', carrierName: 'Demo Express', serviceCode: 'standard', manualTrackingNumber: null, ddtRequired: true, shippedAt: null, deliveredAt: null, returnedAt: null, ...shipment },
  arrangement: 'CARRIER',
  ddt: null,
  labels: { carrier: 0, test: 0 },
  may: { arrange: may, track: may, status: no('CARRIER_TRACKED') },
  events: [],
  ...over,
})

const check = (over: Partial<LabelCheck> = {}): LabelCheck => ({
  testMode: false,
  applies: true,
  notApplying: null,
  carrier: { code: 'demo-express', name: 'Demo Express', ruleKept: false },
  printable: true,
  problems: [],
  parcels: [{ parcelId: uid(11), seq: 1, labelled: false, ok: true, problems: [] }, { parcelId: uid(12), seq: 2, labelled: false, ok: true, problems: [] }],
  ...over,
})

const MANAGER = { manage: true, pack: true }
const tm = (over: Partial<TransportModel> = {}, value: Transport = transport(), checked: LabelCheck | null = check()): TransportModel => ({ transport: { state: 'ready', value }, check: checked ? { state: 'ready', value: checked } : null, can: MANAGER, dialog: null, busy: false, problem: null, done: null, ...over })

const printer = { id: uid(70), code: 'LBL-1', name: 'Banco etichette 1' }
const jobs: LabelJobs = {
  shipmentId: uid(1),
  number: 'SH-26-0107',
  status: 'PACKED',
  parcels: [
    {
      parcelId: uid(11),
      seq: 1,
      trackingNumber: 'DEMO00012345',
      jobs: [
        { jobId: uid(81), kind: 'MARKS', test: false, scanId: 'SH-26-0107-1', status: 'PRINTED', printer, copies: 1, createdAt: '2026-11-14T10:31:00.000Z', reprintOfId: null, reason: null, requestedBy: { by: 'FLOOR', name: null, device: 'PACK-01', hidden: true }, reprintable: true, refusal: null },
        { jobId: uid(82), kind: 'CARRIER', test: false, scanId: 'DEMO00012345', status: 'PRINTED', printer, copies: 1, createdAt: '2026-11-14T11:02:00.000Z', reprintOfId: null, reason: null, requestedBy: { by: 'OFFICE', name: 'Marta Demo', device: null, hidden: false }, reprintable: true, refusal: null },
        { jobId: uid(83), kind: 'CARRIER', test: false, scanId: 'DEMO00012345', status: 'SENT', printer, copies: 1, createdAt: '2026-11-14T11:20:00.000Z', reprintOfId: uid(82), reason: 'The label got wet at the dock.', requestedBy: { by: 'OFFICE', name: 'Marta Demo', device: null, hidden: false }, reprintable: true, refusal: null },
      ],
    },
    {
      parcelId: uid(12),
      seq: 2,
      trackingNumber: 'DEMO00012346',
      jobs: [
        { jobId: uid(84), kind: 'MARKS', test: false, scanId: 'SH-26-0107-2', status: 'PRINTED', printer, copies: 1, createdAt: '2026-11-14T10:33:00.000Z', reprintOfId: null, reason: null, requestedBy: { by: 'FLOOR', name: null, device: 'PACK-01', hidden: true }, reprintable: false, refusal: { code: 'MARKS_CHANGED' } },
        { jobId: uid(85), kind: 'CARRIER', test: false, scanId: 'DEMO00012346', status: 'FAILED', printer, copies: 1, createdAt: '2026-11-14T11:02:00.000Z', reprintOfId: null, reason: null, requestedBy: { by: 'OFFICE', name: 'Marta Demo', device: null, hidden: false }, reprintable: true, refusal: null },
      ],
    },
  ],
}
const testJobs: LabelJobs = { ...jobs, parcels: jobs.parcels.map((parcel) => ({ ...parcel, trackingNumber: `TEST-${parcel.seq}A2B3C4D5E-1`, jobs: parcel.jobs.map((job) => (job.kind === 'CARRIER' ? { ...job, test: true } : job)) })) }
const PACKER = { pack: true, printLabels: true }
const rp = (over: Partial<ReprintModel> = {}, value: LabelJobs = jobs): ReprintModel => ({ jobs: { state: 'ready', value }, can: PACKER, picked: [], dialog: null, busy: false, problem: null, done: null, ...over })

interface CarrierCase {
  readonly transport?: TransportModel
  readonly reprint?: ReprintModel
}

function CarrierDesign({ model }: { model: CarrierCase }) {
  return createElement(Fragment, null, model.transport ? createElement(TransportView, { model: model.transport }) : null, model.reprint ? createElement(ReprintView, { model: model.reprint }) : null)
}

const manual = transport({ arrangement: 'MANUAL_CARRIER', may: { arrange: may, track: may, status: no('NOT_LEFT') } }, { carrierName: 'Trasporti Demo', carrierCode: null, serviceCode: null, manualTrackingNumber: 'TD-5501-22' })
const ownVanLeft = transport(
  {
    arrangement: 'OWN_VAN',
    ddt: { id: uid(40), number: '153/2026' },
    may: { arrange: no('LEFT'), track: no('NOT_A_CARRIER'), status: may },
    events: [
      { id: uid(91), status: 'OUT_FOR_DELIVERY', description: 'Second stop of the round.', location: 'Treviso', occurredAt: '2026-11-15T09:10:00.000Z', recordedAt: '2026-11-15T09:12:00.000Z' },
      { id: uid(92), status: 'IN_TRANSIT', description: null, location: 'Montebelluna', occurredAt: '2026-11-15T07:30:00.000Z', recordedAt: '2026-11-15T07:31:00.000Z' },
    ],
  },
  { status: 'SHIPPED', transportBy: 'SENDER', carrierCode: null, carrierName: null, serviceCode: null, shippedAt: '2026-11-15T07:20:00.000Z' },
)

export const designScreen = defineDesignScreen<CarrierCase>({
  screen: 'SCR-595',
  title: 'Shipment › Carrier & label: own van, a carrier by hand, the customer collects; check before printing; reprint with a reason',
  view: CarrierDesign,
  part: true,
  cases: [
    { id: 'carrier-ok', label: 'A carrier: every parcel passes the check (limits not kept for this carrier)', model: { transport: tm() }, note: 'Cards beside W1\'s Booking and Labels on Carrier & label of SCR-067.' },
    { id: 'check-problems', label: 'The check: postal code, the phone outside the EU, a parcel too heavy (in words)', model: { transport: tm({}, transport(), check({ printable: false, carrier: { code: 'ups', name: 'UPS', ruleKept: true }, problems: [{ code: 'POSTAL_CODE', parcelSeq: null, path: 'shipment/shipTo/postalCode', params: { who: 'recipient', value: '3110', country: 'IT', example: '31100' } }, { code: 'PHONE_NEEDED', parcelSeq: null, path: 'shipment/shipTo/phone', params: { why: 'OUTSIDE_EU' } }], parcels: [{ parcelId: uid(11), seq: 1, labelled: false, ok: false, problems: [{ code: 'TOO_HEAVY', parcelSeq: 1, path: 'parcels/1/grossWeightKg', params: { seq: 1, weightKg: '72.5', carrier: 'UPS', maxKg: '70' } }] }] })) } },
    { id: 'test-mode', label: 'Test mode: labels say TEST, nothing is sent', model: { transport: tm({}, transport({ labels: { carrier: 2, test: 2 } }), check({ testMode: true, parcels: [{ parcelId: uid(11), seq: 1, labelled: true, ok: true, problems: [] }, { parcelId: uid(12), seq: 2, labelled: true, ok: true, problems: [] }] })) } },
    { id: 'arrange', label: 'Our van or a carrier by hand: the dialog (carrier booked by hand)', model: { transport: tm({ dialog: { kind: 'arrange', mode: 'MANUAL_CARRIER', carrierName: 'Trasporti Demo', trackingNumber: '' } }) } },
    { id: 'manual', label: 'A carrier booked by hand with its tracking number; statuses wait until it leaves', model: { transport: tm({}, manual, null) } },
    { id: 'tracking', label: 'Change the typed tracking number', model: { transport: tm({ dialog: { kind: 'tracking', text: 'TD-5501-22' } }, manual, null) } },
    { id: 'own-van', label: 'Our own van, left: the statuses typed as the driver reports them', model: { transport: tm({}, ownVanLeft, null) } },
    { id: 'status', label: 'Type a status: delivered moves the shipment', model: { transport: tm({ dialog: { kind: 'status', status: 'DELIVERED', occurredAt: null, description: '', location: 'Treviso' } }, ownVanLeft, null) } },
    { id: 'collects', label: 'The customer collects (ex works): nothing to arrange or type', model: { transport: tm({}, transport({ arrangement: 'CUSTOMER_COLLECTS', may: { arrange: no('CUSTOMER_COLLECTS'), track: no('NOT_A_CARRIER'), status: no('CUSTOMER_COLLECTS') } }, { transportBy: 'RECIPIENT', carrierCode: null, carrierName: null, serviceCode: null }), null) } },
    { id: 'held-labelled', label: 'Labels bought: the arrangement is held with why', model: { transport: tm({}, transport({ labels: { carrier: 2, test: 0 }, may: { arrange: no('LABELLED'), track: no('LABELLED'), status: no('CARRIER_TRACKED') } })) } },
    { id: 'reprint', label: 'Label prints: carrier labels and carton marks, a reprint with its reason, marks renumbered (held)', model: { reprint: rp() } },
    { id: 'reprint-dialog', label: 'Reprint 2 labels: the reason, nothing bought again', model: { reprint: rp({ picked: [uid(83), uid(85)], dialog: { reason: 'Printer jammed on the second label.' } }) } },
    { id: 'reprint-test', label: 'TEST labels reprinted stay TEST', model: { reprint: rp({ done: { reason: 'Training', jobs: [{ jobId: uid(99), reprintOfId: uid(82), seq: 1, kind: 'CARRIER', test: true }] } }, testJobs) } },
    { id: 'reprint-refused', label: 'A refused reprint, in words (no label printer)', model: { reprint: rp({ picked: [uid(82)], dialog: { reason: 'Torn label.' }, problem: { key: 'reprint.refusal.PRINTER' } }) } },
    { id: 'reprint-no-right', label: 'A reader without the print right: reprint held with why', model: { reprint: rp({ can: { pack: true, printLabels: false } }) } },
    { id: 'reprint-none', label: 'No label printed yet', model: { reprint: rp({}, { ...jobs, parcels: jobs.parcels.map((parcel) => ({ ...parcel, trackingNumber: null, jobs: [] })) }) } },
    { id: 'loading', label: 'Loading', model: { transport: { ...tm(), transport: { state: 'loading' }, check: null }, reprint: { ...rp(), jobs: { state: 'loading' } } } },
    { id: 'error', label: 'Could not be read: Try again', model: { transport: { ...tm(), transport: { state: 'error', problem: { key: 'problem.read.unavailable' } }, check: null }, reprint: { ...rp(), jobs: { state: 'error', problem: { key: 'problem.read.forbidden' } } } } },
  ],
})
