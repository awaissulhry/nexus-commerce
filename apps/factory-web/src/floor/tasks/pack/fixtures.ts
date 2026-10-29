import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { Labels, PackLine, PackParcel, Packing } from './api'
import { documentsState, shipmentModel } from './model'
import { PackView, type DocumentsModel, type JobModel, type PackRowModel, type PackViewModel } from './view/PackView'

/**
 * SCR-098's cases: the packing bench at tablet width, from the site's shipments to pack to the printed documents, with
 * every state the design names (the list, empty, loading, error, no permission; a shipment opened, packing in progress,
 * a serial-tracked style, each scan refusal, weighing a carton, packing done; packed and waiting for the office, the
 * documents with their print states, a station without printers; offline with the last read kept, a refused write;
 * done) and the roles (a packing operator, a team leader, a worker without packing). Made-up shipments, styles,
 * batches, serials and tracking numbers of a made-up "Demo" plant; no customer, no money, never another person.
 */

const PACK = 'PACK-01 · Banco imballo'
const frame = (extra: Partial<PackViewModel['frame']> = {}) => signedInFrame('tile.pack', { station: { name: PACK, site: 'Stabilimento Demo Nord' }, ...extra })
const CAN = { pack: true, printLabels: true }
const AT = '2026-10-29T09:41:00.000Z'

const ROWS: PackRowModel[] = [
  { id: 'sh-demo-0012', number: 'SH-DEMO-0012', status: 'DRAFT', carrier: 'BRT', garments: 8, cartons: 0 },
  { id: 'sh-demo-0013', number: 'SH-DEMO-0013', status: 'DRAFT', carrier: 'GLS', garments: 24, cartons: 2 },
  { id: 'sh-demo-0014', number: 'SH-DEMO-0014', status: 'DRAFT', carrier: null, garments: 4, cartons: 0 },
  { id: 'sh-demo-0010', number: 'SH-DEMO-0010', status: 'PACKED', carrier: 'BRT', garments: 12, cartons: 2 },
]

let n = 0
const line = (cell: string, size: string, quantity: number, parcelId: string | null, extra: Partial<PackLine> = {}): PackLine => ({
  id: `line-${++n}`,
  version: 1,
  parcelId,
  workOrderId: 'wo-demo-0042',
  workOrderNumber: 'WO-DEMO-0042',
  batchNumber: 'BT-DM-26-041',
  workOrderSizeId: `cell-${cell}-${size}`,
  styleCode: 'GIA-01',
  styleName: 'Giacca moto Demo',
  colourwayCode: cell,
  colourwayName: cell === 'NERO' ? 'Nero' : 'Rosso',
  size,
  quantity,
  serialTracked: false,
  serials: [],
  ...extra,
})

const parcel = (seq: number, extra: Partial<PackParcel> = {}): PackParcel => ({ id: `carton-${seq}`, version: 1, seq, grossWeightKg: null, lengthCm: null, widthCm: null, heightCm: null, trackingNumber: null, labelledAt: null, garments: 0, ...extra })

const packing = (lines: PackLine[], parcels: PackParcel[], extra: Partial<Packing> = {}): Packing => ({
  id: 'sh-demo-0012',
  number: 'SH-DEMO-0012',
  status: 'DRAFT',
  version: 4,
  siteId: 'site-demo',
  transportBy: 'CARRIER',
  carrierCode: 'brt',
  serviceCode: 'express',
  packedAt: null,
  lines,
  parcels,
  garments: lines.reduce((sum, entry) => sum + entry.quantity, 0),
  documents: { ddt: null, packingList: null },
  settings: { cutOffTime: '17:00', labelPrinterId: 'printer-label', documentPrinterId: 'printer-a4' },
  ...extra,
})

/** Nothing packed yet: 8 garments of one batch, two colours, three sizes. */
const fresh = packing([line('NERO', '50', 2, null), line('NERO', '52', 4, null), line('NERO', '54', 2, null)], [])

/** Two cartons: carton 1 closed and weighed, carton 2 open with garments; some still loose. */
const inProgress = packing(
  [line('NERO', '50', 2, 'carton-1'), line('NERO', '52', 2, 'carton-1'), line('NERO', '52', 1, 'carton-2'), line('NERO', '52', 1, null), line('NERO', '54', 1, 'carton-2'), line('NERO', '54', 1, null)],
  [parcel(1, { grossWeightKg: '4.2500', garments: 4 }), parcel(2, { garments: 2 })],
)

/** A serial-tracked style: every garment's serial is packed with it. */
const SERIAL = { serialTracked: true, styleCode: 'TUT-02', styleName: 'Tuta pista Demo', batchNumber: 'BT-DM-26-055', workOrderNumber: 'WO-DEMO-0055', workOrderId: 'wo-demo-0055' } as const
const serials = packing(
  [
    line('ROSSO', '50', 2, 'carton-1', { ...SERIAL, workOrderSizeId: 'cell-r50', serials: [{ id: 's1', serial: 'SN-7K-00A01T-4' }, { id: 's2', serial: 'SN-7K-00A01V-9' }] }),
    line('ROSSO', '52', 1, 'carton-1', { ...SERIAL, workOrderSizeId: 'cell-r52', serials: [{ id: 's3', serial: 'SN-7K-00A01W-2' }] }),
    line('ROSSO', '52', 2, null, { ...SERIAL, workOrderSizeId: 'cell-r52' }),
  ],
  [parcel(1, { garments: 3 })],
)

/** Everything in weighed cartons: Packing done. */
const complete = packing([line('NERO', '50', 2, 'carton-1'), line('NERO', '52', 4, 'carton-1'), line('NERO', '54', 2, 'carton-2')], [parcel(1, { grossWeightKg: '6.1000', garments: 6 }), parcel(2, { grossWeightKg: '2.4000', garments: 2 })])

const packed = (extra: Partial<Packing> = {}, labelled = false): Packing => ({
  ...complete,
  status: 'PACKED',
  packedAt: AT,
  parcels: complete.parcels.map((entry) => (labelled ? { ...entry, trackingNumber: `BRT-DM-${entry.seq}A`, labelledAt: AT } : entry)),
  ...extra,
})

const labelsOf = (value: Packing, extra: Partial<Labels> = {}): Labels => ({
  labelPrinterId: 'printer-label',
  toLabel: value.parcels.filter((entry) => entry.trackingNumber === null).length,
  cutOff: { time: '17:00', at: '2026-10-29T16:00:00.000Z', passed: false },
  parcels: value.parcels.map((entry) => ({ parcelId: entry.id, seq: entry.seq, trackingNumber: entry.trackingNumber, labelledAt: entry.labelledAt, print: null })),
  ...extra,
})

const DDT = { id: 'ddt-demo-0153', number: 'DDT-DEMO-0153', documentDate: '2026-10-29', fileId: 'file-ddt' }

const docs = (value: Packing, labels: Labels | null, jobs: JobModel[] = [], printLabels = true): DocumentsModel => ({
  ...documentsState(value, labels, { printLabels }),
  trackingNumbers: value.parcels.map((entry) => ({ seq: entry.seq, trackingNumber: entry.trackingNumber })),
  jobs,
})

const base = (step: PackViewModel['step'], extra: Partial<PackViewModel> = {}): PackViewModel => ({ frame: frame(), online: true, can: CAN, step, ...extra })
const pack = (value: Packing, extra: Partial<Extract<PackViewModel['step'], { kind: 'pack' }>> = {}, picked: string | null = null): PackViewModel['step'] => ({ kind: 'pack', shipment: shipmentModel(value, picked), weigh: null, note: null, unpackHeld: null, ...extra })
const documents = (value: Packing, labels: Labels | null, jobs: JobModel[] = [], printLabels = true): PackViewModel['step'] => ({ kind: 'documents', shipment: shipmentModel(value, null), documents: docs(value, labels, jobs, printLabels), unpackHeld: value.parcels.some((entry) => entry.trackingNumber) ? 'labelled' : value.documents.ddt ? 'ddt' : null })

const ready = packed({ documents: { ddt: DDT, packingList: { fileId: 'file-pl', createdAt: AT } } }, true)
const JOBS: JobModel[] = [
  { id: 'job-1', what: 'LABEL', seq: 1, status: 'PRINTED', detail: null },
  { id: 'job-2', what: 'LABEL', seq: 2, status: 'SENT', detail: null },
  { id: 'job-3', what: 'DDT', seq: null, status: 'QUEUED', detail: null },
  { id: 'job-4', what: 'PACKING_LIST', seq: null, status: 'FAILED', detail: 'La stampante A4-PACK-01 non ha risposto.' },
]

export const designScreen = defineDesignScreen<PackViewModel>({
  screen: 'SCR-098',
  title: 'Packing bench',
  view: onFloor(PackView),
  cases: [
    { id: 'list', label: 'Shipments to pack (one packed, waiting for its documents)', model: base({ kind: 'list', rows: ROWS }), note: 'Scan the pack slip (Home hands its scan over) or pick a row: shipment, carrier, cartons and garments, never a customer’s name on a shared screen. The keys are in the list footer’s icon.' },
    { id: 'empty', label: 'Nothing released to pack', model: base({ kind: 'list', rows: [] }) },
    { id: 'not-found', label: 'A pack slip of no shipment here', model: base({ kind: 'list', rows: ROWS, scanned: { code: 'SH-DEMO-9999', why: 'notFound' } }) },
    { id: 'serial-first', label: 'A garment scanned before its shipment', model: base({ kind: 'list', rows: ROWS, scanned: { code: 'SN-7K-00A01T-4', why: 'serialFirst' } }) },
    { id: 'loading', label: 'Reading', model: base({ kind: 'loading', code: 'SH-DEMO-0012' }) },
    { id: 'error', label: 'The office does not answer', model: base({ kind: 'problem', problem: { kind: 'unavailable' }, code: 'SH-DEMO-0012' }) },
    { id: 'no-permission', label: 'A worker without packing', model: base({ kind: 'noPermission' }), note: 'The Pack tile needs shipping.pack: a sewing operator opening the address sees this.' },
    { id: 'opened', label: 'A shipment opened: nothing packed yet', model: base(pack(fresh)), note: 'Released? in one line (only released garments are planned). The first scan starts carton 1 by itself: 0 taps.' },
    {
      id: 'in-progress',
      label: 'Packing: carton 1 closed and weighed, carton 2 open',
      model: base(pack(inProgress, { note: { kind: 'packed', code: 'BT-DM-26-041', cell: 'GIA-01 NERO 54', carton: 2 } })),
      note: 'Each scan of a garment label puts one garment of its size in the current carton; Put the rest moves a size in one tap. The grid shows packed of planned, live.',
    },
    { id: 'serials', label: 'A serial-tracked style: one serial label per garment', model: base(pack(serials, { note: { kind: 'packed', code: 'SN-7K-00A01W-2', cell: 'TUT-02 ROSSO 52', carton: 1 } })) },
    { id: 'refused-not-released', label: 'Scan refused: not released by quality yet', model: base(pack(inProgress, { note: { kind: 'refused', code: 'SN-7K-00A09X-1', why: 'notReleased' } })) },
    { id: 'refused-other', label: 'Scan refused: packed in another shipment', model: base(pack(inProgress, { note: { kind: 'refused', code: 'SN-7K-00A05K-7', why: 'otherShipment' } })) },
    { id: 'refused-unknown', label: 'Scan refused: a wrong code', model: base(pack(inProgress, { note: { kind: 'refused', code: 'BT-DM-26-099', why: 'unknown' } })) },
    { id: 'refused-batch-done', label: 'Scan refused: nothing left of that batch', model: base(pack(complete, { note: { kind: 'refused', code: 'BT-DM-26-041', why: 'batchDone' } })) },
    { id: 'refused-serial-tracked', label: 'Scan refused: a serial-tracked batch label', model: base(pack(serials, { note: { kind: 'refused', code: 'BT-DM-26-055', why: 'serialTracked', cell: 'ROSSO 52' } })) },
    {
      id: 'weigh',
      label: 'Close carton: its weight',
      model: base(pack(inProgress, { weigh: { cartonId: 'carton-2', seq: 2, value: 1.85 } })),
      note: 'Close carton opens the pad; Enter or Save weight closes it. A weighed carton is closed: the next scan starts a new one.',
    },
    { id: 'packing-done', label: 'Everything in weighed cartons: Packing done', model: base(pack(complete)) },
    {
      id: 'waiting-office',
      label: 'Packed, waiting for the office (no DDT, no labels)',
      model: base(documents(packed(), labelsOf(packed()))),
      note: 'Issuing the DDT and buying the labels are the office’s: each part says so; the bench reads the shipment again by itself.',
    },
    { id: 'documents-ready', label: 'Documents ready: DDT, packing list and two labels', model: base(documents(ready, labelsOf(ready))), note: 'One tap prints the labels on the label printer and the DDT with the packing list on the A4 printer.' },
    { id: 'printing', label: 'Printing: queued, sent, printed, failed with Retry', model: base(documents(ready, labelsOf(ready), JOBS)) },
    {
      id: 'no-printers',
      label: 'A station without printers',
      model: base(documents({ ...ready, settings: { cutOffTime: '17:00', labelPrinterId: null, documentPrinterId: null } }, labelsOf(ready, { labelPrinterId: null }))),
      note: 'Held with the reason: the office prints the labels as PDF and the DDT meanwhile.',
    },
    { id: 'own-van', label: 'Own van: no carrier label', model: base(documents(packed({ transportBy: 'SENDER', carrierCode: null, documents: { ddt: DDT, packingList: null } }), labelsOf(packed()))) },
    {
      id: 'offline',
      label: 'Offline: every write waits',
      model: base(pack(inProgress), { online: false, asOf: AT, frame: frame({ online: false }) }),
      note: 'Packing is recorded by the office at once (not in the tablet’s queue): the last read stays, with its time.',
    },
    { id: 'refused-write', label: 'A write the office refused', model: base(pack(inProgress), { notice: { kind: 'refused', code: 'PARCEL_LABELLED', message: 'Parcel 1 has a carrier label: void the label first.', fix: null } }) },
    { id: 'done', label: 'Packed and printed', model: base({ kind: 'done', number: 'SH-DEMO-0012', cartons: 2, labelsPrinted: true }) },
    { id: 'team-leader', label: 'A team leader at the bench (packs and prints)', model: base(documents(ready, labelsOf(ready)), { frame: frame({ operator: { name: 'Teo Demo' } }) }) },
    {
      id: 'operator-no-labels',
      label: 'A packer without label printing',
      model: base(documents(ready, labelsOf(ready), [], false), { can: { pack: true, printLabels: false } }),
      note: 'The labels part is held with the reason; the DDT still prints.',
    },
  ],
})
