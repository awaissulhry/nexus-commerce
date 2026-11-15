import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Pod, ShipmentProblems } from './api'
import type { DeliveryModel } from './model'
import { DeliveryView } from './view/DeliveryView'

/**
 * SCR-597 — Tracking & delivery › Proof of delivery and tracking problems (B-W2b-410 on B-W2b-398; design sh-pod "signer, time
 * and image", sh-track "no event for 3 days"). Made-up data only (signer "G. Demo").
 */

const uid = (n: number) => `0190f0e2-7414-7000-8000-${String(n).padStart(12, '0')}`

const pod = (over: Partial<Pod> = {}): Pod => ({
  shipment: { id: uid(1), number: 'SH-26-0107', status: 'DELIVERED', shippedAt: '2026-11-12T15:00:00.000Z', version: 9 },
  deliveredAt: '2026-11-13T10:42:00.000Z',
  deliveredVia: 'CARRIER',
  pod: { signedBy: 'G. Demo', signedAt: '2026-11-13T10:42:00.000Z', file: { id: uid(30), name: 'pod-SH-26-0107.pdf', contentType: 'application/pdf', sizeBytes: 182_000 } },
  carrierAsked: true,
  recordHeld: 'KEPT',
  signerMax: 200,
  ...over,
})

const problems = (over: Partial<ShipmentProblems> = {}): ShipmentProblems => ({
  shipment: { id: uid(1), number: 'SH-26-0107', status: 'SHIPPED' },
  noScanDays: 3,
  problems: [],
  ...over,
})

const MANAGER = { manage: true, readFiles: true, uploadFiles: true }
const model = (over: Partial<DeliveryModel> = {}, value: Pod = pod(), list: ShipmentProblems = problems()): DeliveryModel => ({ pod: { state: 'ready', value }, problems: { state: 'ready', value: list }, can: MANAGER, facts: { expectedAt: null, returnedAt: null }, dialog: null, busy: false, problem: null, done: null, ...over })

const travelling = pod({ shipment: { id: uid(1), number: 'SH-26-0107', status: 'SHIPPED', shippedAt: '2026-11-12T15:00:00.000Z', version: 8 }, deliveredAt: null, deliveredVia: null, pod: null, carrierAsked: false, recordHeld: 'NOT_DELIVERED' })
const typedNoProof = pod({ deliveredVia: 'TYPED', pod: { signedBy: null, signedAt: null, file: null }, carrierAsked: false, recordHeld: null })
const openProblems = problems({
  problems: [
    { id: uid(61), kind: 'NO_SCAN', raisedAt: '2026-11-15T07:10:00.000Z', resolvedAt: null, taskId: uid(71), taskStatus: 'OPEN', raisedBySystem: true },
    { id: uid(62), kind: 'ADDRESS_PROBLEM', raisedAt: '2026-11-14T16:20:00.000Z', resolvedAt: null, taskId: uid(72), taskStatus: 'OPEN', raisedBySystem: false },
    { id: uid(63), kind: 'DELAYED', raisedAt: '2026-11-13T08:00:00.000Z', resolvedAt: '2026-11-13T12:00:00.000Z', taskId: uid(73), taskStatus: 'DONE', raisedBySystem: true },
  ],
})

export const designScreen = defineDesignScreen<DeliveryModel>({
  screen: 'SCR-597',
  title: 'Shipment › Tracking & delivery: proof of delivery (signer, time, image) and tracking problems',
  view: DeliveryView,
  part: true,
  cases: [
    { id: 'kept', label: 'Delivered, the carrier\'s proof kept whole: never changes, download for a dispute', model: model(), note: 'In place of W1\'s Proof of delivery card on Tracking & delivery of SCR-067.' },
    { id: 'typed', label: 'Delivered (typed by the office), no proof yet: Record the proof', model: model({}, typedNoProof) },
    { id: 'record', label: 'Record the proof: signer, time, image picked', model: model({ dialog: { kind: 'pod', signedBy: 'G. Demo', signedAt: '2026-11-13T10:40:00.000Z', file: { name: 'pod-photo.jpg', type: 'image/jpeg', size: 1_200_000 } } }, typedNoProof) },
    { id: 'record-part', label: 'The signer kept by the carrier: only time and image left', model: model({ dialog: { kind: 'pod', signedBy: '', signedAt: null, file: null } }, pod({ pod: { signedBy: 'G. Demo', signedAt: null, file: null }, recordHeld: null })) },
    { id: 'travelling', label: 'On its way: expected day, not delivered yet (held with why), open problems', model: model({ facts: { expectedAt: '2026-11-16T16:00:00.000Z', returnedAt: null } }, travelling, openProblems) },
    { id: 'resolve', label: 'Resolve the address problem with a note', model: model({ dialog: { kind: 'resolve', problemId: uid(62), note: 'Customer confirmed the gate code; the carrier delivers tomorrow.' } }, travelling, openProblems) },
    { id: 'refused', label: 'A refused record, in words (a part kept already)', model: model({ dialog: { kind: 'pod', signedBy: 'Someone else', signedAt: null, file: null }, problem: { key: 'pod.refusal.KEPT' } }, typedNoProof) },
    { id: 'read-only', label: 'A reader without shipping.manage or files: buttons held with why', model: model({ can: { manage: false, readFiles: false, uploadFiles: false } }, typedNoProof, openProblems) },
    { id: 'returned', label: 'Returned to us', model: model({ facts: { expectedAt: null, returnedAt: '2026-11-15T09:00:00.000Z' } }, pod({ shipment: { id: uid(1), number: 'SH-26-0107', status: 'RETURNED', shippedAt: '2026-11-12T15:00:00.000Z', version: 9 }, deliveredAt: null, deliveredVia: null, pod: null, carrierAsked: false, recordHeld: 'NOT_DELIVERED' })) },
    { id: 'loading', label: 'Loading', model: { ...model(), pod: { state: 'loading' }, problems: { state: 'loading' } } },
    { id: 'error', label: 'Could not be read: Try again', model: { ...model(), pod: { state: 'error', problem: { key: 'problem.read.internal' } }, problems: { state: 'error', problem: { key: 'problem.read.unavailable' } } } },
  ],
})
