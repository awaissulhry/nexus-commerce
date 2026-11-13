import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { JobStatus, Labels, PackLine, PackParcel, Packing } from './api'
import type { Bench, BenchCarton, BenchContent, BenchPackaging } from './carton/api'
import { benchLeft, benchMain, cartonMarkCode, cartonsOf, closeChoice, closeHeld, currentCartonOf, holdReasonOf, marksFacts, overweight, packGrid, type CloseChoice, type FlashBody, type KeptScan, type MarksNote, type ScanFlash } from './carton/model'
import { packedSummary } from './done/model'
import { documentsState, headOf, type PackHead } from './model'
import { PackView, type BenchStep, type DocumentsModel, type JobModel, type PackRowModel, type PackViewModel } from './view/PackView'

/**
 * SCR-098's cases: the packing bench at tablet width, from the site's shipments to pack to Packed, with every state the
 * design names — the list, empty, loading, error, no permission; B-W2b-387's Scan into the carton (a shipment opened, packing
 * in progress with the size grid live, each refusal flashing with its reason, a batch label that names no size, taking a
 * garment out, a serial-tracked style, on hold, offline with scans kept on the tablet and one refused when sent, Close carton
 * with its packaging and weight, the marks sent to the printer or not printed with the PDF made here, marks to print again
 * after the count changed, everything packed); the documents with their print states and a station without printers; and
 * Packed's summary — with the roles (a packing operator, a team leader, a worker without packing, a packer without label
 * printing). Made-up shipments, styles, batches, serials and tracking numbers of a made-up "Demo" plant; no customer, no
 * money, never another person.
 */

const PACK = 'PACK-01 · Banco imballo'
const frame = (extra: Partial<PackViewModel['frame']> = {}) => signedInFrame('tile.pack', { station: { name: PACK, site: 'Stabilimento Demo Nord' }, ...extra })
const CAN = { pack: true, printLabels: true }
const AT = '2026-11-13T09:41:00.000Z'
const NUMBER = 'SH-DEMO-0012'

const ROWS: PackRowModel[] = [
  { id: 'sh-demo-0012', number: NUMBER, status: 'DRAFT', carrier: 'BRT', garments: 8, cartons: 0 },
  { id: 'sh-demo-0013', number: 'SH-DEMO-0013', status: 'DRAFT', carrier: 'GLS', garments: 24, cartons: 2 },
  { id: 'sh-demo-0014', number: 'SH-DEMO-0014', status: 'DRAFT', carrier: null, garments: 4, cartons: 0 },
  { id: 'sh-demo-0010', number: 'SH-DEMO-0010', status: 'PACKED', carrier: 'BRT', garments: 12, cartons: 2 },
]

// ---- the shipment as packing reads it (W1's view: its lines name each cell's work order and batch) -------------------------

const line = (cell: string, size: string, quantity: number, extra: Partial<PackLine> = {}): PackLine => ({
  id: `line-${cell}-${size}`,
  version: 1,
  parcelId: null,
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
const LINES = [line('NERO', '50', 2), line('NERO', '52', 4), line('NERO', '54', 2)]

const parcel = (seq: number, extra: Partial<PackParcel> = {}): PackParcel => ({ id: `carton-${seq}`, version: 1, seq, grossWeightKg: null, lengthCm: null, widthCm: null, heightCm: null, trackingNumber: null, labelledAt: null, garments: 0, ...extra })

const packing = (extra: Partial<Packing> = {}): Packing => ({
  id: 'sh-demo-0012',
  number: NUMBER,
  status: 'DRAFT',
  version: 9,
  siteId: 'site-demo',
  transportBy: 'CARRIER',
  carrierCode: 'brt',
  serviceCode: 'express',
  packedAt: null,
  lines: LINES,
  parcels: [],
  garments: 8,
  documents: { ddt: null, packingList: null },
  settings: { cutOffTime: '17:00', labelPrinterId: 'printer-label', documentPrinterId: 'printer-a4' },
  ...extra,
})

// ---- the bench (B-W2b-384's view: the grid, the cartons with their contents, the packaging) ---------------------------------

const TYPES: BenchPackaging[] = [
  { id: 'pk-big', name: 'Cartone 60×40×40', kind: 'CARTON', innerLengthCm: '60.00', innerWidthCm: '40.00', innerHeightCm: '40.00', tareKg: '0.8000', maxWeightKg: '20.0000' },
  { id: 'pk-small', name: 'Cartone 40×30×20', kind: 'CARTON', innerLengthCm: '40.00', innerWidthCm: '30.00', innerHeightCm: '20.00', tareKg: '0.4000', maxWeightKg: '8.0000' },
  { id: 'pk-pallet', name: 'Pallet EUR', kind: 'PALLET', innerLengthCm: null, innerWidthCm: null, innerHeightCm: null, tareKg: '25.0000', maxWeightKg: '800.0000' },
]

const content = (size: string, quantity: number, extra: Partial<BenchContent> = {}): BenchContent => ({
  id: `content-${size}-${quantity}`,
  shipmentLineId: `line-NERO-${size}`,
  cellId: `cell-NERO-${size}`,
  styleCode: 'GIA-01',
  styleName: 'Giacca moto Demo',
  colourwayCode: 'NERO',
  colourwayName: 'Nero',
  size,
  quantity,
  workOrderNumber: 'WO-DEMO-0042',
  batchNumber: 'BT-DM-26-041',
  serials: [],
  ...extra,
})

const carton = (seq: number, contents: BenchContent[], extra: Partial<BenchCarton> = {}): BenchCarton => ({
  id: `carton-${seq}`,
  version: 2,
  seq,
  closed: false,
  cartonNumber: null,
  cartonCount: null,
  marksPrintedAt: null,
  marksCurrent: false,
  labelled: false,
  packagingType: null,
  grossWeightKg: null,
  netWeightKg: null,
  garments: contents.reduce((sum, entry) => sum + entry.quantity, 0),
  contents,
  ...extra,
})
const closed = (seq: number, of: number, contents: BenchContent[], extra: Partial<BenchCarton> = {}) =>
  carton(seq, contents, { closed: true, cartonNumber: seq, cartonCount: of, marksPrintedAt: AT, marksCurrent: true, packagingType: { id: 'pk-big', name: 'Cartone 60×40×40', kind: 'CARTON' }, grossWeightKg: '4.2500', netWeightKg: '3.4500', ...extra })

const grid = (packed: Record<string, number>, rows: Bench['grid'] = []): Bench['grid'] => [
  {
    styleCode: 'GIA-01',
    styleName: 'Giacca moto Demo',
    colourwayCode: 'NERO',
    colourwayName: 'Nero',
    serialTracked: false,
    batchNumbers: ['BT-DM-26-041'],
    sizes: [
      { size: '50', cellIds: ['cell-NERO-50'], ordered: 2, packed: packed['50'] ?? 0 },
      { size: '52', cellIds: ['cell-NERO-52'], ordered: 4, packed: packed['52'] ?? 0 },
      { size: '54', cellIds: ['cell-NERO-54'], ordered: 2, packed: packed['54'] ?? 0 },
    ],
  },
  ...rows,
]

const bench = (extra: Partial<Bench> = {}): Bench => ({
  shipment: { id: 'sh-demo-0012', number: NUMBER, status: 'DRAFT', version: 9 },
  hold: null,
  grid: grid({}),
  cartons: [],
  openCartonId: null,
  packagingTypes: TYPES,
  suggestedPackagingTypeId: 'pk-big',
  problems: ['NOT_SCANNED'],
  ...extra,
})

/** Nothing packed yet. */
const fresh = bench()
/** Carton 1 closed "1 of 2" with its marks; carton 2 open with garments; some still to scan. */
const inProgress = bench({
  grid: grid({ '50': 2, '52': 3, '54': 1 }),
  cartons: [closed(1, 2, [content('50', 2), content('52', 2)]), carton(2, [content('52', 1), content('54', 1)])],
  openCartonId: 'carton-2',
  problems: ['NOT_SCANNED', 'CARTON_OPEN'],
})
/** A second style traced by serial, its garments scanned by their serial labels. */
const SERIAL_ROW: Bench['grid'][number] = { styleCode: 'TUT-02', styleName: 'Tuta pista Demo', colourwayCode: 'ROSSO', colourwayName: 'Rosso', serialTracked: true, batchNumbers: ['BT-DM-26-055'], sizes: [{ size: '50', cellIds: ['cell-r50'], ordered: 2, packed: 2 }, { size: '52', cellIds: ['cell-r52'], ordered: 3, packed: 1 }] }
const withSerials = bench({
  grid: grid({ '50': 2, '52': 3, '54': 1 }, [SERIAL_ROW]),
  cartons: [
    closed(1, 2, [content('50', 2), content('52', 2)]),
    carton(2, [
      content('52', 1),
      content('54', 1),
      content('50', 2, { id: 'c-r50', styleCode: 'TUT-02', colourwayCode: 'ROSSO', cellId: 'cell-r50', batchNumber: 'BT-DM-26-055', serials: [{ id: 's1', serial: 'SN-7K-00A01T-4', packedAt: AT }, { id: 's2', serial: 'SN-7K-00A01V-9', packedAt: AT }] }),
      content('52', 1, { id: 'c-r52', styleCode: 'TUT-02', colourwayCode: 'ROSSO', cellId: 'cell-r52', batchNumber: 'BT-DM-26-055', serials: [{ id: 's3', serial: 'SN-7K-00A01W-2', packedAt: AT }] }),
    ]),
  ],
  openCartonId: 'carton-2',
  problems: ['NOT_SCANNED', 'CARTON_OPEN'],
})
/** Every garment scanned, carton 1 and 2 closed "of 2", weighed, marks printed: Packed. */
const complete = bench({ grid: grid({ '50': 2, '52': 4, '54': 2 }), cartons: [closed(1, 2, [content('50', 2), content('52', 4)]), closed(2, 2, [content('54', 2)], { grossWeightKg: '2.4000', netWeightKg: '2.0000', packagingType: { id: 'pk-small', name: 'Cartone 40×30×20', kind: 'CARTON' } })], problems: [] })
/** A third carton was opened and closed: cartons 1 and 2 still say "of 2". */
const marksDue = bench({
  grid: grid({ '50': 2, '52': 4, '54': 2 }),
  cartons: [closed(1, 2, [content('50', 2), content('52', 2)], { marksCurrent: false }), closed(2, 2, [content('52', 2)], { marksCurrent: false }), closed(3, 3, [content('54', 2)])],
  problems: ['MARKS_NOT_PRINTED'],
})

// ---- the step from a bench and the screen's own state ----------------------------------------------------------------------

interface Screen {
  flash?: ScanFlash | null
  takeOut?: string | null
  choosing?: readonly string[] | null
  close?: CloseChoice | null
  marks?: { note: MarksNote; job: JobStatus | null } | null
  printedMarks?: readonly number[] | null
  kept?: { waiting: KeptScan[]; refused: KeptScan[] }
  pdf?: BenchStep['pdf']
}

const head = (value: Bench, extra: Partial<Packing> = {}): PackHead => headOf(packing(extra), value.cartons.length)

function step(value: Bench, screen: Screen = {}): BenchStep {
  const cartons = cartonsOf(value)
  const left = benchLeft(value, cartons)
  const out = screen.takeOut ? cartons.find((entry) => entry.id === screen.takeOut) : undefined
  const marksCarton = screen.marks ? value.cartons.find((entry) => entry.id === screen.marks!.note.cartonId) : undefined
  return {
    grid: packGrid(value),
    cartons,
    current: currentCartonOf(cartons),
    left,
    main: benchMain(cartons, left),
    hold: value.hold ? holdReasonOf(value.hold.reason) : null,
    flash: screen.flash ?? null,
    takeOut: out ? { cartonId: out.id, seq: out.seq } : null,
    choosing: screen.choosing ?? null,
    close: screen.close ? { choice: screen.close, types: value.packagingTypes, suggestedId: value.suggestedPackagingTypeId, held: closeHeld(screen.close, value.packagingTypes), overweightMax: overweight(screen.close, value.packagingTypes) } : null,
    marks: screen.marks ? { note: screen.marks.note, job: screen.marks.job, facts: marksCarton ? { code: cartonMarkCode(NUMBER, marksCarton.seq), garments: marksCarton.garments, ...marksFacts(marksCarton) } : null } : null,
    printedMarks: screen.printedMarks ?? null,
    kept: screen.kept ?? { waiting: [], refused: [] },
    pdf: screen.pdf ?? null,
  }
}

const base = (stepModel: PackViewModel['step'], extra: Partial<PackViewModel> = {}): PackViewModel => ({ frame: frame(), online: true, can: CAN, step: stepModel, ...extra })
const pack = (value: Bench, screen: Screen = {}, extra: Partial<Packing> = {}): PackViewModel['step'] => ({ kind: 'pack', head: head(value, extra), bench: step(value, screen) })

let flashes = 0
const flash = (made: FlashBody): ScanFlash => ({ ...made, seq: ++flashes })
const refused = (code: string, refusal: Extract<ScanFlash, { kind: 'refused' }>['refusal']) => flash({ code, kind: 'refused', refusal })

const note = (seq: number, of: number, extra: Partial<MarksNote> = {}): MarksNote => ({ cartonId: `carton-${seq}`, seq, n: seq, of, printed: true, jobIds: ['job-marks-1'], problem: null, overweight: false, ...extra })

/** A made-up one-page PDF of the marks (what `…/marks/pdf` makes), for the viewer's case. */
function demoPdf(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 283 170] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const text = 'BT /F1 22 Tf 18 120 Td (Collo 1 di 2) Tj /F1 12 Tf 0 -30 Td (GIA-01 NERO 50, 52 - 6 capi) Tj 0 -22 Td (SH-DEMO-0012-1) Tj ET'
  objects[3] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

// ---- once packed: the documents and Packed --------------------------------------------------------------------------------

const PARCELS = [parcel(1, { grossWeightKg: '4.2500', garments: 6 }), parcel(2, { grossWeightKg: '2.4000', garments: 2 })]
const packed = (extra: Partial<Packing> = {}, labelled = false): Packing =>
  packing({ status: 'PACKED', packedAt: AT, parcels: PARCELS.map((entry) => (labelled ? { ...entry, trackingNumber: `BRT-DM-${entry.seq}A`, labelledAt: AT } : entry)), ...extra })

const labelsOf = (value: Packing, extra: Partial<Labels> = {}): Labels => ({
  labelPrinterId: 'printer-label',
  toLabel: value.parcels.filter((entry) => entry.trackingNumber === null).length,
  cutOff: { time: '17:00', at: '2026-11-13T16:00:00.000Z', passed: false },
  parcels: value.parcels.map((entry) => ({ parcelId: entry.id, seq: entry.seq, trackingNumber: entry.trackingNumber, labelledAt: entry.labelledAt, print: null })),
  ...extra,
})

const DDT = { id: 'ddt-demo-0153', number: 'DDT-DEMO-0153', documentDate: '2026-11-13', fileId: 'file-ddt' }

const docs = (value: Packing, labels: Labels | null, jobs: JobModel[] = [], printLabels = true): DocumentsModel => ({
  ...documentsState(value, labels, { printLabels }),
  trackingNumbers: value.parcels.map((entry) => ({ seq: entry.seq, trackingNumber: entry.trackingNumber })),
  jobs,
})
const documents = (value: Packing, labels: Labels | null, jobs: JobModel[] = [], printLabels = true): PackViewModel['step'] => ({
  kind: 'documents',
  head: headOf(value),
  documents: docs(value, labels, jobs, printLabels),
  unpackHeld: value.parcels.some((entry) => entry.trackingNumber) ? 'labelled' : value.documents.ddt ? 'ddt' : null,
})

const ready = packed({ documents: { ddt: DDT, packingList: { fileId: 'file-pl', createdAt: AT } } }, true)
const JOBS: JobModel[] = [
  { id: 'job-1', what: 'LABEL', seq: 1, status: 'PRINTED', detail: null },
  { id: 'job-2', what: 'LABEL', seq: 2, status: 'SENT', detail: null },
  { id: 'job-3', what: 'DDT', seq: null, status: 'QUEUED', detail: null },
  { id: 'job-4', what: 'PACKING_LIST', seq: null, status: 'FAILED', detail: 'La stampante A4-PACK-01 non ha risposto.' },
]
const PRINTED: JobModel[] = JOBS.map((job) => ({ ...job, status: 'PRINTED', detail: null }))
const done = (value: Packing, jobs: JobModel[], labels: Labels | null): PackViewModel['step'] => ({
  kind: 'done',
  summary: packedSummary({ number: value.number, cartons: value.parcels.length, marksDue: false, transportBy: value.transportBy, documents: documentsState(value, labels, { printLabels: true }), jobs }),
})

export const designScreen = defineDesignScreen<PackViewModel>({
  screen: 'SCR-098',
  title: 'Packing bench',
  view: onFloor(PackView),
  cases: [
    { id: 'list', label: 'Shipments to pack (one packed, waiting for its documents)', model: base({ kind: 'list', rows: ROWS }), note: 'Scan the pack slip or a carton’s marks (Home hands its scan over), or pick a row: shipment, carrier, cartons and garments, never a customer’s name on a shared screen. The keys are in the list footer’s icon.' },
    { id: 'empty', label: 'Nothing released to pack', model: base({ kind: 'list', rows: [] }) },
    { id: 'not-found', label: 'A pack slip of no shipment here', model: base({ kind: 'list', rows: ROWS, scanned: { code: 'SH-DEMO-9999', why: 'notFound' } }) },
    { id: 'serial-first', label: 'A garment scanned before its shipment', model: base({ kind: 'list', rows: ROWS, scanned: { code: 'SN-7K-00A01T-4', why: 'serialFirst' } }) },
    { id: 'loading', label: 'Reading', model: base({ kind: 'loading', code: NUMBER }) },
    { id: 'error', label: 'The office does not answer', model: base({ kind: 'problem', problem: { kind: 'unavailable' }, code: NUMBER }) },
    { id: 'no-permission', label: 'A worker without packing', model: base({ kind: 'noPermission' }), note: 'The Pack tile needs shipping.pack: a sewing operator opening the address sees this.' },
    { id: 'opened', label: 'A shipment opened: nothing packed yet', model: base(pack(fresh)), note: 'Released? in one line. The size grid shows 0 of each size ordered; the first scan opens carton 1 by itself: 0 taps. Close carton waits with its reason.' },
    {
      id: 'in-progress',
      label: 'Scan into the carton: a garment in, the grid live',
      model: base(pack(inProgress, { flash: flash({ code: 'BT-DM-26-041', kind: 'in', cell: 'GIA-01 NERO 54', carton: 2, newCarton: false, packed: 1, ordered: 2 }) })),
      note: 'Each scan is ONE call (B-W2b-384’s POST …/scan): the garment goes into the open carton and the grid counts it. Carton 1 is closed "1 of 2" with its marks; Close carton 2 is the main action (Enter).',
    },
    { id: 'refused-style', label: 'A wrong piece: wrong style (it flashes with its reason)', model: base(pack(inProgress, { flash: refused('SEED-JKT-01-BLK-52', 'WRONG_STYLE') })) },
    { id: 'refused-size', label: 'A wrong piece: wrong size', model: base(pack(inProgress, { flash: refused('GIA-01-NERO-56', 'WRONG_SIZE') })) },
    { id: 'refused-extra', label: 'An extra piece', model: base(pack(complete, { flash: refused('GIA-01-NERO-50', 'EXTRA_PIECE') })) },
    { id: 'refused-not-released', label: 'Not released by quality yet', model: base(pack(inProgress, { flash: refused('SN-7K-00A09X-1', 'NOT_RELEASED') })) },
    { id: 'refused-serial-needed', label: 'A serial-tracked style scanned by its batch label', model: base(pack(withSerials, { flash: refused('BT-DM-26-055', 'SERIAL_NEEDED') })) },
    { id: 'refused-unknown', label: 'A code that is no garment label', model: base(pack(inProgress, { flash: refused('XYZ-123', 'UNKNOWN_CODE') })) },
    {
      id: 'size-needed',
      label: 'A batch label that names no size: tap the size',
      model: base(pack(inProgress, { flash: flash({ code: 'BT-DM-26-041', kind: 'chooseSize', cellIds: ['cell-NERO-52', 'cell-NERO-54'] }), choosing: ['cell-NERO-52', 'cell-NERO-54'] })),
      note: 'SIZE_NEEDED: the sizes of that batch still to pack become big buttons on the grid; a tap sends the same scan with the cell. Esc drops it.',
    },
    { id: 'serials', label: 'A serial-tracked style: each garment by its serial', model: base(pack(withSerials, { flash: flash({ code: 'SN-7K-00A01W-2', kind: 'in', cell: 'TUT-02 ROSSO 52', carton: 2, newCarton: false, packed: 1, ordered: 3 }) })) },
    {
      id: 'take-out',
      label: 'Taking a garment out of carton 1',
      model: base(pack(inProgress, { takeOut: 'carton-1', flash: flash({ code: 'BT-DM-26-041', kind: 'out', cell: 'GIA-01 NERO 52', carton: 1, reopened: true }) })),
      note: 'Take a garment out: the next garment scanned comes out (online only). A closed carton opens again; its marks are cleared.',
    },
    {
      id: 'offline-kept',
      label: 'Offline: scans kept on the tablet',
      model: base(
        pack(inProgress, {
          flash: flash({ code: 'GIA-01-NERO-52', kind: 'kept' }),
          kept: {
            waiting: [
              { id: 'k1', code: 'GIA-01-NERO-52', at: AT, refusal: null },
              { id: 'k2', code: 'GIA-01-NERO-54', at: AT, refusal: null },
            ],
            refused: [],
          },
        }),
        { online: false, asOf: AT, frame: frame({ online: false }) },
      ),
      note: 'Scans queue as shipping.carton.scan under the try’s client id; Close carton, take-out, printing and Packed wait with the reason.',
    },
    {
      id: 'kept-refused',
      label: 'A kept scan refused when the network came back',
      model: base(pack(inProgress, { kept: { waiting: [], refused: [{ id: 'k3', code: 'SEED-JKT-01-BLK-52', at: AT, refusal: 'WRONG_STYLE' }] } })),
    },
    { id: 'on-hold', label: 'On hold: the gate turns red, scanning stops', model: base(pack(bench({ ...inProgress, hold: { reason: 'CREDIT', placedAt: AT } }))), note: 'A hold placed while the card is open: the bench reads again on the live event (or the 30 s beat); the scan field and every write wait with the reason.' },
    {
      id: 'close',
      label: 'Close carton: packaging and weight',
      model: base(pack(inProgress, { close: { ...closeChoice(cartonsOf(inProgress)[1]!, inProgress), weight: 1.85 } })),
      note: 'The suggested default is chosen; the pad confirms (Enter): one POST …/close stores the contents, numbers the carton and sends its marks to the station’s label printer.',
    },
    { id: 'close-overweight', label: 'Close carton: heavier than the packaging takes', model: base(pack(inProgress, { close: { ...closeChoice(cartonsOf(inProgress)[1]!, inProgress), packagingId: 'pk-small', weight: 9.5 } })) },
    { id: 'close-no-packaging', label: 'Close carton: no packaging set up', model: base(pack(bench({ ...inProgress, packagingTypes: [], suggestedPackagingTypeId: null }), { close: { ...closeChoice(cartonsOf(inProgress)[1]!, { packagingTypes: [], suggestedPackagingTypeId: null }), weight: null } })) },
    {
      id: 'closed-printed',
      label: 'Carton 2 of 2 closed: marks sent to the printer',
      model: base(pack(complete, { marks: { note: note(2, 2), job: 'SENT' } })),
      note: 'The marks preview shows what the floor knows (carton n of N, style, sizes, garments, batch and the barcode the marks carry); the address and the order print but are never shown here.',
    },
    {
      id: 'closed-not-printed',
      label: 'Carton closed, its marks not printed (no label printer)',
      model: base(pack(complete, { marks: { note: note(2, 2, { printed: false, jobIds: [], problem: 'validation_failed' }), job: null } })),
      note: 'The reason in words from the problem’s code; Print the marks again, or the marks as a PDF made here.',
    },
    { id: 'marks-pdf', label: 'The marks as a PDF made here', model: base(pack(complete, { pdf: { bytes: demoPdf(), number: NUMBER } })) },
    { id: 'marks-due', label: 'A carton added: the others’ marks to print again', model: base(pack(marksDue)), note: 'MARKS_NOT_PRINTED: "Print the marks again" is the main action before Packed.' },
    { id: 'ready', label: 'Everything scanned, closed and weighed: Packed', model: base(pack(complete)) },
    { id: 'refused-write', label: 'A write the office refused', model: base(pack(inProgress), { notice: { kind: 'refused', code: 'CARTON_LABELLED', message: 'Carton 1 has a carrier label.', fix: null } }) },
    {
      id: 'waiting-office',
      label: 'Packed, waiting for the office (no DDT, no labels)',
      model: base(documents(packed(), labelsOf(packed()))),
      note: 'Issuing the DDT and buying the labels are the office’s: each part says so; the bench reads the shipment again by itself. Done shows Packed’s summary.',
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
    { id: 'done', label: 'Packed: 2 cartons · labels printed', model: base(done(ready, PRINTED, labelsOf(ready))), note: 'Design floor.pack "Packed": the line from what really happened, then the marks, the labels and the documents.' },
    { id: 'done-office', label: 'Packed: the office buys the labels', model: base(done(packed(), [], labelsOf(packed()))) },
    { id: 'done-own-van', label: 'Packed: our own van', model: base(done(packed({ transportBy: 'SENDER', carrierCode: null, documents: { ddt: DDT, packingList: null } }), [{ id: 'job-3', what: 'DDT', seq: null, status: 'PRINTED', detail: null }], labelsOf(packed()))) },
    { id: 'team-leader', label: 'A team leader at the bench (packs and prints)', model: base(pack(inProgress), { frame: frame({ operator: { name: 'Teo Demo' } }) }) },
    {
      id: 'operator-no-labels',
      label: 'A packer without label printing',
      model: base(documents(ready, labelsOf(ready), [], false), { can: { pack: true, printLabels: false } }),
      note: 'The labels part is held with the reason; the DDT still prints.',
    },
  ],
})
