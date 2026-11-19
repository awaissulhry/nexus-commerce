import { defineDesignScreen } from '../../../../../../lib/design/design-screen'
import type { ReadyCell } from '../../../../../warehouse/shipments/api'
import type { ElsewherePreview, ElsewhereRecorded } from './api'
import { changed, emptyForm, liveProblems, type ElsewhereForm } from './model'
import { ElsewhereDialog, type ElsewhereDialogModel } from './view/ElsewhereDialog'

/**
 * SCR-039-elsewhere — the sales order's "Record a shipment made elsewhere…" (F-OP-123; order page N5; 10-order-page §8.5; review R-9,
 * R-10, R-23), a dialog of SCR-039 › Shipments. Made-up data only: order SO-26-0031 of the made-up customer "Moto Demo S.r.l.", style
 * "DEMO-JKT-01", a paper DDT "123/2026". Its live rules on a fixed clock (19 Nov 2026, 10:00 UTC).
 */

const uid = (n: number) => `0190f0e2-7123-7000-8000-${String(n).padStart(12, '0')}`
const NOW = new Date('2026-11-19T10:00:00.000Z')
const RELEASED = '2026-11-12T09:00:00.000Z'

const cell = (n: number, size: string, shippable: number, over: Partial<ReadyCell> = {}): ReadyCell => ({
  workOrderSizeId: uid(10 + n),
  workOrderId: uid(2),
  workOrderNumber: 'WO-DEMO-0051',
  batchNumber: 'B-DEMO-26-052',
  siteId: uid(3),
  salesOrderLineId: uid(4),
  lineSeq: 1,
  styleCode: 'DEMO-JKT-01',
  styleName: 'Giacca moto Demo',
  colourwayCode: 'BLK',
  colourwayName: 'Nero',
  size,
  pieces: shippable + 2,
  released: shippable,
  reversed: 0,
  onShipments: 0,
  shippable,
  serialTracked: false,
  ...over,
})
const CELLS = [cell(1, '50', 3), cell(2, '52', 5)]
const SERIAL = cell(3, '54', 2, { styleCode: 'DEMO-JKT-02', serialTracked: true })

const preview = (over: Partial<ElsewherePreview> = {}): ElsewherePreview => ({
  order: { id: uid(1), number: 'SO-26-0031' },
  siteId: uid(3),
  lines: CELLS.map((entry) => ({ workOrderSizeId: entry.workOrderSizeId, label: `WO-DEMO-0051 BLK ${entry.size}`, quantity: 2, shippable: entry.shippable, releasedAt: RELEASED, serialTracked: false })),
  earliest: RELEASED,
  problems: [],
  holds: { held: false, accountHold: null, creditHeld: false, mayRelease: false },
  ddtUsed: false,
  noticeOn: true,
  ddtCitable: true,
  ...over,
})

const typed = (over: Partial<ElsewhereForm> = {}): ElsewhereForm =>
  changed(changed(emptyForm(NOW), { quantities: { [CELLS[0]!.workOrderSizeId]: 2, [CELLS[1]!.workOrderSizeId]: 2 }, ddtNumber: '123/2026', carrierName: 'Demo Corriere', trackingNumber: 'DEMO-TRK-77' }, NOW), { ddtDate: '2026-11-18', ...over }, NOW)

const model = (over: Partial<ElsewhereDialogModel> = {}, form: ElsewhereForm = typed(), read: ElsewherePreview | null = preview(), cells: readonly ReadyCell[] = CELLS): ElsewhereDialogModel => ({
  order: { id: uid(1), number: 'SO-26-0031', customer: 'Moto Demo S.r.l.', waiting: 24 },
  prefix: '/w/DEMO',
  cells,
  form,
  preview: read,
  problems: liveProblems(form, cells, read, NOW),
  busy: false,
  refusal: null,
  done: null,
  now: NOW.toISOString(),
  ...over,
})

const recorded = (warnings: string[]): ElsewhereRecorded =>
  ({ shipment: { id: uid(90), number: 'SH-26-0170', status: 'SHIPPED' }, warnings }) as unknown as ElsewhereRecorded

export const designScreen = defineDesignScreen<ElsewhereDialogModel>({
  screen: 'SCR-039-elsewhere',
  title: 'Sales order › Shipments: Record a shipment made elsewhere (paper DDT, released garments, holds)',
  view: ElsewhereDialog,
  cases: [
    { id: 'ready', label: 'Two sizes, the paper DDT of yesterday, a carrier booked by hand: Record', model: model(), note: '"No Nexus DDT number is issued": the paper DDT is the document. Left on follows the DDT date until changed.' },
    { id: 'reading', label: 'Reading what quality released', model: model({ cells: 'loading' }, emptyForm(NOW), null) },
    { id: 'none-released', label: 'Nothing of the order is released and on no shipment ("24 pieces wait for quality")', model: model({}, emptyForm(NOW), null, []) },
    { id: 'future', label: 'Live rules: left in the future, the DDT dated after the day it left', model: model({}, typed({ shippedAt: '2026-11-20T09:00:00.000Z', ddtDate: '2026-11-21' })) },
    { id: 'before-release', label: 'Live rules: "Not before the garments were released (12 Nov)"', model: model({}, typed({ shippedAt: '2026-11-11T09:00:00.000Z', ddtDate: '2026-11-11' })) },
    // F-OP-307 (walk #9): on open nothing is red (Record held with its words); a try or leaving the field shows the problem.
    { id: 'just-opened', label: 'Just opened: nothing typed yet — no problem shows; Record held "Choose at least one garment"', model: model({}, emptyForm(NOW), null) },
    { id: 'no-ddt', label: 'No paper DDT typed, after Record was pressed: required unless an immediate invoice travelled instead', model: model({ seen: { tried: true, left: [] } }, typed({ ddtNumber: '' })) },
    { id: 'no-ddt-untouched', label: 'No paper DDT typed yet, the field not left: nothing red; Record held with the problem\'s own words', model: model({}, typed({ ddtNumber: '' })) },
    { id: 'invoice-instead', label: 'An immediate invoice travelled instead of a DDT (R-23)', model: model({}, typed({ ddtNumber: '', invoiceInstead: true })) },
    { id: 'serials', label: 'A serial-tracked style: one serial of two typed', model: model({}, typed({ quantities: { [SERIAL.workOrderSizeId]: 2 }, serials: { [SERIAL.workOrderSizeId]: 'SN-DEMO-0001' } }), preview({ lines: [{ workOrderSizeId: SERIAL.workOrderSizeId, label: 'WO-DEMO-0051 BLK 54', quantity: 2, shippable: 2, releasedAt: RELEASED, serialTracked: true }] }), [SERIAL]) },
    { id: 'held-no-right', label: 'The customer is on hold: Record held — a person who may release holds records it (R-9)', model: model({}, typed(), preview({ holds: { held: true, accountHold: 'C-DEMO-01 is on hold: two invoices are overdue.', creditHeld: false, mayRelease: false } })) },
    { id: 'held-reason', label: 'The customer is on hold, the person may release holds: the reason is required (shown after the field was left)', model: model({ seen: { tried: false, left: ['reason'] } }, typed(), preview({ holds: { held: true, accountHold: null, creditHeld: true, mayRelease: true } })) },
    { id: 'ddt-used', label: 'That paper DDT is already recorded (R-10: no customer named)', model: model({}, typed(), preview({ ddtUsed: true })) },
    { id: 'not-citable', label: 'A paper DDT number the e-invoice cannot cite (over 20 characters)', model: model({}, typed({ ddtNumber: 'DDT-SUBCONTRACTOR-2026-000123' }), preview({ ddtCitable: false })) },
    { id: 'refused', label: 'Refused by the API: said inside the dialog, what was typed stays', model: model({ refusal: { words: { key: 'elsewhere.ddtUsed' }, detail: null } }) },
    { id: 'done', label: 'Recorded: SHIPPED, made elsewhere; a PPE document was not on file (warning)', model: model({ done: recorded(['DEMO-JKT-01 has no Declaration of Conformity on file.']) }) },
  ],
})
