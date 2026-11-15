import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { SplitPreview } from './api'
import type { SplitModel } from './model'
import { SplitDialog } from './view/SplitDialog'

/**
 * SCR-593 — Split a shipment (B-W2b-410 on B-W2b-386, LOG-005; the record's ⋯ "Split…"): by hand or by the promise date.
 * Made-up data only (styles DEMO-JKT, DEMO-PNT).
 */

const uid = (n: number) => `0190f0e2-7416-7000-8000-${String(n).padStart(12, '0')}`

const preview = (over: Partial<SplitPreview> = {}): SplitPreview => ({
  shipmentId: uid(1),
  number: 'SH-26-0110',
  status: 'DRAFT',
  version: 3,
  splittable: true,
  held: false,
  lines: [
    { id: uid(11), label: 'DEMO-JKT · Black', size: '50', quantity: 4, packed: 1, serials: 1, movable: 3, shipBy: '2026-11-16' },
    { id: uid(12), label: 'DEMO-JKT · Black', size: '52', quantity: 3, packed: 0, serials: 0, movable: 3, shipBy: '2026-11-16' },
    { id: uid(13), label: 'DEMO-PNT · Black', size: '50', quantity: 2, packed: 0, serials: 0, movable: 2, shipBy: '2026-11-20' },
    { id: uid(14), label: 'DEMO-PNT · Black', size: '52', quantity: 1, packed: 1, serials: 0, movable: 0, shipBy: '2026-11-20' },
  ],
  reasons: ['CARRIER', 'SERVICE', 'SHIP_TO', 'PROMISE_DATE', 'PART_READY', 'CUSTOMER_REQUEST', 'OTHER'],
  rules: [{ rule: 'PROMISE_DATE', stays: '2026-11-16', shipments: [{ shipBy: '2026-11-20', garments: 2, lines: [{ lineId: uid(13), quantity: 2 }] }], kept: [{ lineId: uid(14), garments: 1 }] }],
  mayManage: true,
  ...over,
})

const model = (over: Partial<SplitModel> = {}, value: SplitPreview = preview()): SplitModel => ({ preview: { state: 'ready', value }, mode: 'hand', quantities: {}, reason: null, transportBy: 'CARRIER', carrierCode: '', serviceCode: '', busy: false, problem: null, made: null, prefix: '/w/DEMO', ...over })

export const designScreen = defineDesignScreen<SplitModel>({
  screen: 'SCR-593',
  title: 'Shipment › ⋯ Split…: by hand (garments, why, a new carrier or service) or by the promise date',
  view: SplitDialog,
  part: true,
  cases: [
    { id: 'hand', label: 'By hand: nothing picked yet (Split held with why)', model: model(), note: 'Opened from the record\'s ⋯ of SCR-067 on a draft.' },
    { id: 'hand-ready', label: 'By hand: 3 garments move, part ready', model: model({ quantities: { [uid(12)]: 3 }, reason: 'PART_READY' }) },
    { id: 'hand-carrier', label: 'By hand: another carrier for the new shipment', model: model({ quantities: { [uid(13)]: 2 }, reason: 'CARRIER', carrierCode: 'demo-express' }) },
    { id: 'hand-all', label: 'Everything movable picked: something must stay (held)', model: model({ quantities: { [uid(11)]: 4, [uid(12)]: 3, [uid(13)]: 2 }, reason: 'CUSTOMER_REQUEST' }, preview({ lines: preview().lines.slice(0, 3).map((line) => ({ ...line, packed: 0, serials: 0, movable: line.quantity })) })) },
    { id: 'rule', label: 'By promise date: one new shipment for 20 Nov', model: model({ mode: 'rule' }) },
    { id: 'rule-one-day', label: 'By promise date: all promised the same day (held)', model: model({ mode: 'rule' }, preview({ rules: [{ rule: 'PROMISE_DATE', stays: '2026-11-16', shipments: [], kept: [] }] })) },
    { id: 'held', label: 'A held shipment: the holds go with the new ones', model: model({}, preview({ held: true })) },
    { id: 'done', label: 'Split: the new shipment with its link', model: model({ made: [{ id: uid(2), number: 'SH-26-0111' }] }) },
    { id: 'refused', label: 'A refused split, in words', model: model({ quantities: { [uid(12)]: 3 }, reason: 'PART_READY', problem: { key: 'problem.write.moved' } }) },
    { id: 'no-right', label: 'A reader without shipping.manage: Split held with why', model: model({}, preview({ mayManage: false })) },
    { id: 'loading', label: 'Loading', model: { ...model(), preview: { state: 'loading' } } },
    { id: 'error', label: 'Could not be read: Try again', model: { ...model(), preview: { state: 'error', problem: { key: 'problem.read.internal' } } } },
  ],
})
