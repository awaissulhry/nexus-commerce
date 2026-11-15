import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Bench, Carton } from './api'
import type { CartonsModel } from './model'
import { CartonsView } from './view/CartonsView'

/**
 * SCR-594 — Lines & cartons › Cartons in depth (B-W2b-410 on B-W2b-384; design sh-cartons, pop:sh-carton, sh-lines
 * "serials"): each carton n of N with its packaging, contents by size and serials, weights, size, tracking, marks and label;
 * the docked carton drawer; packed by size; the shipment's serials. Made-up data only (styles DEMO-JKT, DEMO-PNT).
 */

const uid = (n: number) => `0190f0e2-7411-7000-8000-${String(n).padStart(12, '0')}`
const serial = (n: number, at: string | null = '2026-11-14T10:0' + (n % 10) + ':00.000Z') => ({ id: uid(900 + n), serial: `DM26-${String(4100 + n)}`, packedAt: at })

const carton = (over: Partial<Carton> & Pick<Carton, 'id' | 'seq'>): Carton => ({
  version: 2,
  closed: true,
  cartonNumber: over.seq,
  cartonCount: 3,
  marksPrintedAt: '2026-11-14T10:30:00.000Z',
  marksCurrent: true,
  labelled: false,
  packagingType: { id: uid(50), name: 'Carton 60 × 40 × 40', kind: 'CARTON' },
  grossWeightKg: '8.4500',
  netWeightKg: '7.9500',
  lengthCm: '60.00',
  widthCm: '40.00',
  heightCm: '40.00',
  garments: 4,
  contents: [],
  ...over,
})

const content = (n: number, size: string, quantity: number, serials: ReturnType<typeof serial>[] = []) => ({
  id: uid(100 + n),
  shipmentLineId: uid(200 + n),
  styleCode: n < 5 ? 'DEMO-JKT' : 'DEMO-PNT',
  styleName: n < 5 ? 'Demo touring jacket' : 'Demo touring trousers',
  colourwayCode: 'BLK',
  colourwayName: 'Black',
  size,
  quantity,
  workOrderNumber: n < 5 ? 'WO-26-0031' : 'WO-26-0032',
  batchNumber: n < 5 ? 'LOT-26-0031' : 'LOT-26-0032',
  originCountry: 'IT',
  serials,
})

const bench = (over: Partial<Bench> = {}): Bench => ({
  shipment: { id: uid(1), number: 'SH-26-0107', status: 'PACKED', version: 7 },
  hold: null,
  grid: [
    { styleId: uid(60), styleCode: 'DEMO-JKT', styleName: 'Demo touring jacket', colourwayId: uid(61), colourwayCode: 'BLK', colourwayName: 'Black', serialTracked: true, batchNumbers: ['LOT-26-0031'], sizes: [ { size: '50', ordered: 2, packed: 2 }, { size: '52', ordered: 3, packed: 3 }, { size: '54', ordered: 1, packed: 1 } ] },
    { styleId: uid(62), styleCode: 'DEMO-PNT', styleName: 'Demo touring trousers', colourwayId: uid(61), colourwayCode: 'BLK', colourwayName: 'Black', serialTracked: false, batchNumbers: ['LOT-26-0032'], sizes: [ { size: '50', ordered: 2, packed: 2 }, { size: '52', ordered: 2, packed: 2 } ] },
  ],
  cartons: [
    carton({ id: uid(11), seq: 1, contents: [content(1, '50', 2, [serial(1), serial(2)]), content(2, '52', 2, [serial(3), serial(4)])], garments: 4 }),
    carton({ id: uid(12), seq: 2, contents: [content(3, '52', 1, [serial(5)]), content(4, '54', 1, [serial(6)]), content(5, '50', 2)], garments: 4, grossWeightKg: '7.1000', netWeightKg: '6.6000' }),
    carton({ id: uid(13), seq: 3, contents: [content(6, '52', 2)], garments: 2, packagingType: { id: uid(51), name: 'Box 40 × 30 × 20', kind: 'BOX' }, grossWeightKg: '2.3000', netWeightKg: '2.0000', lengthCm: '40.00', widthCm: '30.00', heightCm: '20.00' }),
  ],
  openCartonId: null,
  problems: [],
  ...over,
})

const context = { status: 'PACKED' as const, parcels: [{ id: uid(11), trackingNumber: null }, { id: uid(12), trackingNumber: null }, { id: uid(13), trackingNumber: null }], canPack: true, busy: false }
const model = (over: Partial<CartonsModel> = {}, value: Bench = bench()): CartonsModel => ({ bench: { state: 'ready', value }, context, openId: null, ...over })

const draftBench = bench({
  shipment: { id: uid(1), number: 'SH-26-0107', status: 'DRAFT', version: 4 },
  cartons: [
    carton({ id: uid(11), seq: 1, contents: [content(1, '50', 2, [serial(1), serial(2)])], garments: 2 }),
    carton({ id: uid(12), seq: 2, closed: false, cartonNumber: null, cartonCount: null, marksPrintedAt: null, marksCurrent: false, packagingType: null, grossWeightKg: null, netWeightKg: null, lengthCm: null, widthCm: null, heightCm: null, contents: [content(3, '52', 1, [serial(5)])], garments: 1 }),
    carton({ id: uid(14), seq: 3, closed: false, cartonNumber: null, cartonCount: null, marksPrintedAt: null, marksCurrent: false, packagingType: null, grossWeightKg: null, netWeightKg: null, lengthCm: null, widthCm: null, heightCm: null, contents: [], garments: 0 }),
  ],
  openCartonId: uid(12),
  problems: ['NOT_SCANNED', 'CARTON_OPEN', 'MARKS_NOT_PRINTED'],
})

export const designScreen = defineDesignScreen<CartonsModel>({
  screen: 'SCR-594',
  title: 'Shipment › Lines & cartons: cartons with contents, serials and the carton master; the carton drawer',
  view: CartonsView,
  part: true,
  cases: [
    { id: 'packed', label: 'Packed: 3 cartons, 1 of 3 … 3 of 3, packaging, contents by size, serials counted', model: model(), note: 'In place of W1\'s Cartons card on Lines & cartons of SCR-067.' },
    { id: 'drawer', label: 'Carton 2 of 3 open in the docked drawer: contents by size with lot and serials, weights, size, marks', model: model({ openId: uid(12) }) },
    { id: 'drawer-first', label: 'Carton 1 of 3: Previous held with why', model: model({ openId: uid(11) }) },
    { id: 'labelled', label: 'Labelled: tracking numbers, weigh held (labelled)', model: { ...model(), context: { ...context, parcels: [{ id: uid(11), trackingNumber: 'DEMO00012345' }, { id: uid(12), trackingNumber: 'DEMO00012346' }, { id: uid(13), trackingNumber: 'DEMO00012347' }] } } },
    { id: 'draft', label: 'Draft at the station: an open carton, an empty one, still to scan, marks to print', model: { ...model({}, draftBench), context: { ...context, status: 'DRAFT' } } },
    { id: 'stale-marks', label: 'Marks out of date after a renumber', model: model({ openId: uid(13) }, bench({ cartons: bench().cartons.map((entry) => (entry.seq === 3 ? { ...entry, marksCurrent: false } : entry)), problems: ['MARKS_NOT_PRINTED'] })) },
    { id: 'empty', label: 'No cartons yet', model: { ...model({}, bench({ cartons: [], grid: [] })), context: { ...context, status: 'DRAFT', parcels: [] } } },
    { id: 'read-only', label: 'A reader without the packing right: each button held with why', model: { ...model(), context: { ...context, canPack: false } } },
    { id: 'loading', label: 'Loading', model: { bench: { state: 'loading' }, context, openId: null } },
    { id: 'error', label: 'Could not be read: Try again', model: { bench: { state: 'error', problem: { key: 'problem.read.internal' } }, context, openId: null } },
  ],
})
