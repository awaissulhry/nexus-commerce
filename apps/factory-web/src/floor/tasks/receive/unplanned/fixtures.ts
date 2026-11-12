import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_SITE, onFloor, signedInFrame } from '../../../frame/fixtures'
import type { Material, UnplannedReceipt, UnplannedStart } from './api'
import { emptyDraft, lineOf, type Draft } from './model'
import { UnplannedView, type UnplannedViewModel } from './view/UnplannedView'

/**
 * SCR-378's cases (B-W2b-300; design floor.receive sec:unplanned "Goods without a PO — Received to a holding place and sent to a
 * buyer", SCM-122): who sent it (our suppliers, filtered by a typed name), what came (a material found by its code, its colour,
 * the quantity on the pad, the hides of leather), the delivery note (number, date, photo), the holding place (suggested, or its
 * label scanned), "Put it in the holding area" held with its reason (offline, nothing yet, no place), done (where it waits, the
 * buyer asked, the photo sent or failed with Retry), refusals in words (not a holding place), no permission, loading. A
 * warehouse device; made-up suppliers, materials and numbers; no money, nobody's name.
 */

const frame = () => signedInFrame('tile.receive', { station: { name: null, site: DEMO_SITE } })
const start: UnplannedStart = {
  serverTime: '2026-11-12T08:10:00.000Z',
  holding: { id: 'loc-hold', code: 'A1-HOLD', name: 'Goods without a PO' },
  suppliers: [
    { id: 'sup-1', code: 'SUP-TAN', name: 'Conceria Demo Valdarno' },
    { id: 'sup-2', code: 'SUP-TEX', name: 'Tessiture Demo Como' },
    { id: 'sup-3', code: 'SUP-TRIM', name: 'Minuterie Demo Brescia' },
  ],
}
const lining: Material = { id: 'mat-lin', code: 'DEMO-LIN-140', name: 'Mesh lining 140 cm', tracking: 'LOT', baseUom: 'M', purchaseUom: 'M', colours: [{ id: 'col-gry', code: 'GRY', name: 'Grey' }, { id: 'col-blk', code: 'BLK', name: 'Black' }] }
const leather: Material = { id: 'mat-lea', code: 'DEMO-LEA-12', name: 'Cowhide 1.2 mm', tracking: 'HIDE', baseUom: 'FT2', purchaseUom: 'FT2', colours: [{ id: 'col-lblk', code: 'BLK', name: 'Black' }] }
const zips: Material = { id: 'mat-zip', code: 'DEMO-ZIP-60', name: 'Zip 60 cm', tracking: 'NONE', baseUom: 'PCS', purchaseUom: 'BOX', colours: [] }
const supplier = start.suppliers[0]!
const lines: Draft['lines'] = [
  { ...lineOf(lining, 'l-1'), colour: lining.colours[0]!, quantity: 45 },
  { ...lineOf(leather, 'l-2'), quantity: 152.5, hideCount: 3 },
]
const draft = (extra: Partial<Draft> = {}): Draft => ({ ...emptyDraft(), supplier, lines, ddtNumber: '4512', ddtDate: '2026-11-12', ...extra })
const ddt = { today: '2026-11-12', moreDays: false, camera: false, photo: null }
const PHOTO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#e7e5e0"/><text x="20" y="40" font-family="sans-serif" font-size="18" fill="#333">DDT 4512</text></svg>')
const base: UnplannedViewModel = { frame: frame(), online: true, stage: 'lines', start, supplierQuery: '', materials: null, materialQuery: null, draft: draft(), ddt, busy: null, problem: null, done: null }
const receipt: UnplannedReceipt = {
  id: 'gr-1',
  number: 'GR-2026-0042',
  state: 'WAITING',
  supplier: { id: 'sup-1', name: supplier.name },
  holding: start.holding,
  supplierDdtNumber: '4512',
  supplierDdtDate: '2026-11-12',
  receivedAt: '2026-11-12T08:14:00.000Z',
  buyerAsked: true,
  ddtPhotos: 1,
  lines: [
    { id: 'grl-1', seq: 10, label: 'Line 10 (DEMO-LIN-140 GRY)', item: { id: lining.id, code: lining.code, name: lining.name, tracking: 'LOT' }, colour: { code: 'GRY', name: 'Grey' }, quantity: '45.0000', uom: 'M', hideCount: null },
    { id: 'grl-2', seq: 20, label: 'Line 20 (DEMO-LEA-12 BLK)', item: { id: leather.id, code: leather.code, name: leather.name, tracking: 'HIDE' }, colour: { code: 'BLK', name: 'Black' }, quantity: '152.5000', uom: 'FT2', hideCount: 3 },
  ],
}

export const designScreen = defineDesignScreen<UnplannedViewModel>({
  screen: 'SCR-378',
  title: 'Goods without a PO (floor)',
  view: onFloor(UnplannedView),
  cases: [
    { id: 'supplier', label: 'Who sent it', model: { ...base, stage: 'supplier', draft: emptyDraft() }, note: 'Opened from Receive goods (first step, "Goods without a PO"). Our suppliers to tap; typing part of a name filters them.' },
    { id: 'supplier-filtered', label: 'Suppliers filtered', model: { ...base, stage: 'supplier', draft: emptyDraft(), supplierQuery: 'demo co' } },
    { id: 'supplier-none', label: 'No supplier matches', model: { ...base, stage: 'supplier', draft: emptyDraft(), supplierQuery: 'zzz' } },
    { id: 'material-ask', label: 'What came: scan its code', model: { ...base, stage: 'material', draft: draft({ lines: [] }) } },
    { id: 'material-found', label: 'Materials found', model: { ...base, stage: 'material', draft: draft({ lines: [] }), materials: [lining, leather, zips], materialQuery: 'demo' } },
    { id: 'material-none', label: 'No material matches', model: { ...base, stage: 'material', draft: draft({ lines: [] }), materials: [], materialQuery: 'XYZ-9' } },
    { id: 'quantity-colour', label: 'Pick the colour, then the quantity', model: { ...base, stage: 'quantity', draft: draft({ editing: lineOf(lining, 'l-3') }) }, note: 'Add is held until a colour is picked and a quantity typed (said on the button).' },
    { id: 'quantity-leather', label: 'Leather: area and hides', model: { ...base, stage: 'quantity', draft: draft({ editing: { ...lineOf(leather, 'l-4'), quantity: 98.4, hideCount: 2 } }) } },
    { id: 'lines', label: 'What came, ready for the holding area', model: base, note: '"Put it in the holding area" = ONE call: the receipt waits in A1-HOLD OPEN, no stock move, a buyer\'s task asks for the order.' },
    { id: 'lines-empty', label: 'Nothing added yet (held)', model: { ...base, draft: draft({ lines: [] }) } },
    { id: 'lines-no-place', label: 'No holding place known yet (held: scan its label)', model: { ...base, start: { ...start, holding: null } } },
    { id: 'lines-scanned-place', label: 'Another holding place scanned', model: { ...base, draft: draft({ placeCode: 'BIN-A1-R04' }) } },
    { id: 'offline', label: 'Offline: held with the reason', model: { ...base, online: false } },
    { id: 'posting', label: 'Sending', model: { ...base, busy: 'post' } },
    { id: 'ddt', label: 'Delivery note: number, date, photo', model: { ...base, stage: 'ddt' } },
    { id: 'ddt-photo', label: 'Delivery note with its photo kept', model: { ...base, stage: 'ddt', ddt: { ...ddt, photo: { url: PHOTO } } } },
    { id: 'place', label: 'Scan the holding place', model: { ...base, stage: 'place', draft: draft({ placeCode: 'BIN-A1-R04' }) } },
    { id: 'done', label: 'Waiting for a buyer', model: { ...base, stage: 'done', done: { receipt, photo: 'sent' } } },
    { id: 'done-photo-failed', label: 'Done, the photo failed (Retry)', model: { ...base, stage: 'done', done: { receipt: { ...receipt, buyerAsked: false, ddtPhotos: 0 }, photo: 'failed' } } },
    { id: 'refused-place', label: 'Refused: not a holding place', model: { ...base, problem: { problem: { kind: 'invalid', path: 'body/placeCode', message: null }, code: null } } },
    { id: 'error', label: 'No answer (Retry)', model: { ...base, problem: { problem: { kind: 'unavailable' }, code: null } } },
    { id: 'loading', label: 'Loading', model: { ...base, stage: 'loading', start: null } },
    { id: 'no-permission', label: 'No permission to receive', model: { ...base, stage: 'noPermission' } },
  ],
})
