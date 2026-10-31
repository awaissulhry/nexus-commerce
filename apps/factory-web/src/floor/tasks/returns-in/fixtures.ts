import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_SITE, onFloor, signedInFrame } from '../../frame/fixtures'
import type { DockLine, DockReturn } from './api'
import { countAll, countLine, emptyArrival, type Arrival } from './model'
import { ReturnsInView, type ReturnsInViewModel } from './view/ReturnsInView'

/**
 * SCR-180's cases (design floor.returnsin): scan the RMA (and the unknown one), the parcel's condition with photos and the
 * customer's delivery note, the lines counted by scan or tap (partial, complete, a label not on the return, a line full),
 * the receipt held offline, grading with the policy's suggestion (a protective garment returned for a defect, a used one),
 * a person who receives but may not grade, where the goods go (to confirm, confirmed, no place), done, the problem
 * states, no permission and the worker notice. A warehouse tablet (no station). Made-up returns, garments and places of a
 * made-up tenant; no price, credit or decision anywhere.
 */

const frame = (extra: Parameters<typeof signedInFrame>[1] = {}) => signedInFrame('tile.returnsin', { station: { name: null, site: DEMO_SITE }, ...extra })

const line = (seq: number, extra: Partial<DockLine>): DockLine => ({
  id: `rl-${seq}`,
  seq,
  description: null,
  style: { code: 'GIA-DEMO-01', name: 'Giacca demo' },
  colourway: { code: 'NERO', name: 'Nero' },
  size: '52',
  serial: null,
  batchNumber: null,
  ppe: false,
  safety: false,
  reasonCode: 'WRONG_SIZE',
  reason: { labelIt: 'Taglia sbagliata', labelEn: 'Wrong size' },
  quantity: 1,
  receivedQuantity: 0,
  expected: 1,
  grade: null,
  cause: null,
  photos: 0,
  suggestedOutcome: null,
  disposition: null,
  goodsOutcome: null,
  place: null,
  version: 1,
  ...extra,
})

const lines: DockLine[] = [
  line(10, { serial: 'SN-DEMO-0042', ppe: true, style: { code: 'GIA-PRO-07', name: 'Giacca protettiva demo' }, reasonCode: 'DEFECT', reason: { labelIt: 'Difetto', labelEn: 'Defect' }, safety: true }),
  line(20, { batchNumber: 'LB-DEMO-17', quantity: 3, expected: 3, size: '50' }),
  line(30, { batchNumber: 'LB-DEMO-18', colourway: { code: 'ROSSO', name: 'Rosso' }, size: '54', quantity: 2, expected: 2 }),
]

const dock: DockReturn = {
  id: 'rma-1',
  number: 'RMA-DEMO-0007',
  site: { id: 'site-1', code: 'A1', name: DEMO_SITE },
  customerRef: 'RESO-CLIENTE-55',
  status: 'AUTHORISED',
  goodsDueBy: '2026-11-14',
  receivedAt: null,
  lines,
  receipts: [],
  places: { inspection: { id: 'loc-qua', code: 'A1-QUA', name: 'Quarantena resi' }, quarantine: { id: 'loc-qua', code: 'A1-QUA', name: 'Quarantena resi' }, finishedGoods: { id: 'loc-fg', code: 'A1-FG', name: 'Prodotto finito' } },
  version: 3,
}

/** The return after this parcel was received: lines 10 and 20 in (line 20 partly), line 30 still expected. */
const received: DockReturn = {
  ...dock,
  status: 'RECEIVED',
  receivedAt: '2026-10-31T08:12:00.000Z',
  lines: [
    { ...lines[0]!, receivedQuantity: 1, expected: 0, place: 'A1-QUA' },
    { ...lines[1]!, receivedQuantity: 2, expected: 1, place: 'A1-QUA' },
    lines[2]!,
  ],
  receipts: [{ id: 'rr-1', receivedAt: '2026-10-31T08:12:00.000Z', parcels: 1, parcelCondition: 'DAMAGED', customerDdtNumber: 'DDT-CLI-881', photos: 2 }],
  version: 4,
}

const parcel: Arrival = { ...emptyArrival(), condition: 'DAMAGED', ddtNumber: 'DDT-CLI-881', photos: [{ key: 'p1' }, { key: 'p2' }] }
const counted = countLine(countLine(countLine(parcel, lines[0]!, 1), lines[1]!, 1), lines[1]!, 1)
const allCounted = countAll(parcel, dock)
const allIn: DockReturn = { ...received, lines: received.lines.map((entry) => ({ ...entry, receivedQuantity: entry.quantity, expected: 0, place: 'A1-QUA' })) }

const base = (extra: Partial<ReturnsInViewModel>): ReturnsInViewModel => ({ frame: frame(), online: true, stage: 'parcel', mayGrade: true, dock, arrival: emptyArrival(), ...extra })
const refused = (code: string, shown: string | null) => ({ problem: { kind: 'refused' as const, code, message: code, fix: null }, code: shown })

export const designScreen = defineDesignScreen<ReturnsInViewModel>({
  screen: 'SCR-180',
  title: 'Receive a return',
  view: onFloor(ReturnsInView),
  cases: [
    {
      id: 'scan',
      label: 'Scan the return',
      model: { frame: frame(), online: true, stage: 'scan', mayGrade: true },
      note: 'The RMA sheet in the box or the box label opens the right return. No price, credit or decision on the floor.',
    },
    { id: 'scan-loading', label: 'Looking it up', model: { frame: frame(), online: true, stage: 'scan', mayGrade: true, busy: 'read' } },
    {
      id: 'unknown-rma',
      label: 'Refused: unknown RMA',
      model: { frame: frame(), online: true, stage: 'scan', mayGrade: true, problem: refused('NOT_OPEN', 'RMA-DEMO-9999') },
      note: "The design's words: no open return with this code; put the parcel aside and tell customer service.",
    },
    { id: 'scan-offline', label: 'Offline: opening a return waits', model: { frame: frame({ online: false }), online: false, stage: 'scan', mayGrade: true }, note: 'Opening a return needs the office: the scan field is held with the reason.' },
    { id: 'parcel', label: 'Parcel condition', model: base({}), note: 'Three tiles: box fine, box damaged, opened. Lines is held until one is picked.' },
    { id: 'parcel-picked', label: 'Damaged, two photos, the customer’s note', model: base({ arrival: parcel }), note: 'The photos wait on the tablet and go onto the receipt once it is made.' },
    { id: 'parcel-camera', label: 'Photo of the parcel', model: base({ arrival: parcel, camera: 'parcel' }), note: 'Products only, people kept out of the picture (DS PhotoCapture).' },
    { id: 'lines', label: 'Receive the lines', model: base({ stage: 'lines', arrival: parcel }), note: 'Scan each garment’s serial or batch label, or tap its line: one piece each time.' },
    { id: 'lines-counting', label: 'Counting: partial receipt', model: base({ stage: 'lines', arrival: counted, lastLineId: 'rl-20' }), note: 'What does not arrive now stays expected (the API splits nothing: SAL-350 is W2b).' },
    { id: 'lines-all', label: 'Every expected piece counted', model: base({ stage: 'lines', arrival: allCounted }) },
    { id: 'lines-offline', label: 'Offline: Receive waits', model: base({ stage: 'lines', arrival: counted, online: false, frame: frame({ online: false }) }), note: 'Counting goes on; Receive is held with the reason (a receipt is the office’s record).' },
    { id: 'lines-busy', label: 'Sending the receipt', model: base({ stage: 'lines', arrival: counted, busy: 'receive' }) },
    { id: 'refused-no-line', label: 'Refused: label not on the return', model: base({ stage: 'lines', arrival: counted, problem: refused('NO_LINE', 'SN-DEMO-7777') }) },
    { id: 'refused-full', label: 'Refused: line already full', model: base({ stage: 'lines', arrival: allCounted, problem: refused('FULL', 'LB-DEMO-17') }) },
    { id: 'refused-changed', label: 'Refused: the return changed', model: base({ stage: 'lines', arrival: counted, problem: refused('CHANGED', 'RMA-DEMO-0007') }), note: 'Customer service changed the RMA meanwhile: it was read again.' },
    { id: 'all-in', label: 'Everything arrived before', model: base({ stage: 'lines', dock: allIn }) },
    { id: 'grade', label: 'Grade a garment', model: base({ stage: 'grade', dock: received }), note: 'Five tiles with icons; the line waiting first; others below.' },
    {
      id: 'grade-safety',
      label: 'Protective garment returned for a defect',
      model: base({ stage: 'grade', dock: received, gradeLineId: 'rl-10', grade: 'LIKE_NEW', linePhotos: 1 }),
      note: 'The policy suggests quarantine; restocking as new is held with the reason. The office decides.',
    },
    { id: 'grade-used', label: 'An ordinary garment, used', model: base({ stage: 'grade', dock: received, gradeLineId: 'rl-20', grade: 'GOOD' }), note: 'Second quality suggested: only a new or like-new garment goes back to stock as new.' },
    { id: 'grade-camera', label: 'Photo of the garment with marks', model: base({ stage: 'grade', dock: received, gradeLineId: 'rl-20', grade: 'DAMAGED', camera: 'line' }) },
    { id: 'grade-offline', label: 'Offline: Confirm grade waits', model: base({ stage: 'grade', dock: received, grade: 'NEW', online: false, frame: frame({ online: false }) }) },
    { id: 'grade-receiver', label: 'Receiver only (may not grade)', model: base({ stage: 'grade', dock: received, mayGrade: false }), note: 'A person with sales.returns.receive but not .inspect: the goods go to the inspection place ungraded.' },
    { id: 'route', label: 'Where it goes', model: base({ stage: 'route', dock: received }), note: 'The inspection place until the office decides; scan its label to confirm. No label prints from the tablet yet.' },
    { id: 'route-confirmed', label: 'Place confirmed', model: base({ stage: 'route', dock: received, placeOk: true }) },
    { id: 'route-wrong', label: 'Refused: wrong place', model: base({ stage: 'route', dock: received, problem: refused('PLACE', 'A1-FG') }) },
    { id: 'route-no-place', label: 'No inspection place at the site', model: base({ stage: 'route', dock: { ...received, places: { inspection: null, quarantine: null, finishedGoods: null }, lines: received.lines.map((entry) => ({ ...entry, place: null })) } }) },
    { id: 'done', label: 'Done', model: base({ stage: 'done', dock: received, done: { pieces: 3, graded: 2 } }) },
    { id: 'done-photos', label: 'Done, a photo did not go', model: base({ stage: 'done', dock: received, done: { pieces: 3, graded: 1 }, photosFailed: 1 }), note: 'The receipt stands; the office can add the photo.' },
    { id: 'error', label: 'Server not answering', model: { frame: frame(), online: true, stage: 'scan', mayGrade: true, problem: { problem: { kind: 'unavailable' }, code: null } } },
    { id: 'no-permission', label: 'No permission', model: { frame: frame(), online: true, stage: 'noPermission' }, note: 'Without sales.returns.receive the tile is not shown either: fail closed.' },
    { id: 'notice-held', label: 'Scans held by the worker notice', model: { frame: frame(), online: true, stage: 'scan', mayGrade: true, held: true } },
  ],
})
