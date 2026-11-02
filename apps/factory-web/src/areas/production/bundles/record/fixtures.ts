import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, inShell, PREFIX } from '../../_shared/fixtures'
import type { BundleRecord, RecordScan } from '../api'
import { bundlesCanAs } from '../fixtures'
import type { ReprintRun } from '../list-model'
import type { BundleTab } from '../model'
import type { BundleRecordModel } from './record-model'
import { BundleRecordView } from './view/BundleRecordView'

/**
 * SCR-259-record — the Bundle record (design production.bundles rec:Bundle) with made-up data only: Progress (done · here ·
 * not reached), Scans with and without a worker's name, Quality with the genealogy tree, Ticket with its replaced
 * codes, print history and coupons, Void bundle (and why it is held), Reprint, and the loading, error, not-found and
 * no-permission states.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const op = (seq: number, code: string, name: string) => ({ id: uid('3333', seq), seq, code, name })
const CUT = op(10, 'TAGLIO', 'Taglio pelle')
const BACK = op(20, 'SCHIENA', 'Assemblaggio schiena')
const SLEEVE = op(30, 'MANICHE', 'Montaggio maniche')
const STATION = { id: uid('4444', 1), code: 'CUC-03', name: 'Postazione cucito 3' }

export const RECORD: BundleRecord = {
  bundle: { id: uid('7171', 1), code: 'BN-000001', replacedCodes: ['BN-000040'], workOrderId: uid('9191', 1), colourwayCode: 'BLK', colourwayName: 'Nero', size: '52', part: null, quantity: 10, status: 'ACTIVE', voidedAt: null, voidReason: null, parentBundleId: null, version: 3, createdAt: at(28, 15, 10), scans: 3 },
  workOrder: { id: uid('9191', 1), number: 'WO-00012', batchNumber: 'BA-00052', status: 'IN_PROGRESS', siteId: uid('2222', 1) },
  style: { id: uid('7777', 1), code: 'DEMO-JKT-01', name: 'Giacca pelle demo' },
  place: 'LINE',
  qualityReason: null,
  operation: BACK,
  next: SLEEVE,
  subcontract: null,
  since: at(29, 8, 40),
  lastScan: { at: at(29, 8, 40), operation: BACK, station: STATION },
  stuck: { stuck: true, workingHours: 5.2, limitHours: 4 },
  progress: [
    { ...CUT, scanRequired: true, state: 'DONE', good: 10, scrap: 0, rework: 0 },
    { ...BACK, scanRequired: true, state: 'DONE', good: 9, scrap: 1, rework: 0 },
    { ...SLEEVE, scanRequired: true, state: 'HERE', good: null, scrap: null, rework: null },
    { ...op(40, 'FINIT', 'Finitura'), scanRequired: true, state: 'NOT_REACHED', good: null, scrap: null, rework: null },
  ],
  quality: { holds: [{ id: uid('1616', 1), subjectType: 'Bundle', reasonCode: 'QUALITY', placedAt: at(29, 8, 45) }], reworks: [{ id: uid('1717', 1), status: 'OPEN', quantity: 1, createdAt: at(29, 8, 50) }] },
  genealogy: {
    hides: [{ hideId: uid('5555', 1), code: 'PL-00412', lotId: uid('5656', 1), lotCode: 'LT-0098' }],
    shades: ['BLACK 01'],
    parent: null,
    children: [{ id: uid('7171', 9), code: 'BN-000009', quantity: 2, status: 'ACTIVE' }],
    serials: [{ id: uid('1818', 1), serial: 'SN-000123', status: 'ACTIVE' }],
  },
  ticket: {
    code: 'BN-000001',
    replacedCodes: ['BN-000040'],
    reprints: [{ code: 'BN-000001', replacedCode: 'BN-000040', reason: 'Cartellino rovinato', printerId: uid('8383', 1), postedBy: 'OFFICE', at: at(29, 7, 30) }],
    jobs: [{ jobId: uid('1919', 1), printerId: uid('8383', 1), scanId: 'BN-000001', status: 'PRINTED', lastError: null, createdAt: at(29, 7, 30) }],
    coupons: [{ id: uid('2020', 1), code: 'BN-000101', status: 'ACTIVE', operation: SLEEVE, voidedAt: null, voidReason: null, replacesId: null, postedBy: 'FLOOR', createdAt: at(28, 15, 20) }],
  },
  asOf: at(29, 9, 42),
}

const scan = (n: number, extra: Partial<RecordScan>): RecordScan => ({ id: uid('2121', n), kind: 'REPORT', bundleId: RECORD.bundle.id, operation: CUT, correctsId: null, goodQuantity: 10, scrapQuantity: 0, reworkQuantity: 0, scrapReason: null, deviceTime: at(28, 16, 4), serverTime: at(28, 16, 5), worker: null, station: STATION, approvedById: null, voidedById: null, ...extra })

const SCANS: RecordScan[] = [
  scan(1, {}),
  scan(2, { operation: BACK, goodQuantity: 8, scrapQuantity: 2, scrapReason: 'Cucitura storta', serverTime: at(29, 8, 20), voidedById: uid('2121', 3) }),
  scan(3, { kind: 'CORRECTION', operation: BACK, goodQuantity: 9, scrapQuantity: 1, scrapReason: 'Cucitura storta', serverTime: at(29, 8, 40), correctsId: uid('2121', 2), approvedById: uid('2222', 9) }),
]
const NAMED = SCANS.map((entry) => ({ ...entry, worker: { id: uid('1515', 1), name: 'Bea Esempio' } }))

const REPRINT: ReprintRun = { rows: [{ id: RECORD.bundle.id, code: RECORD.bundle.code }], printers: { value: { printers: [], defaultPrinterId: null }, problem: null }, running: false, done: false, results: {} }

const base = (tab: BundleTab, over: Partial<BundleRecordModel> = {}): BundleRecordModel => ({ prefix: PREFIX, can: bundlesCanAs('manager'), tab, bundle: { status: 'ready', value: RECORD }, scans: { value: SCANS, problem: null }, live: 'live', notice: null, voiding: null, reprint: null, ...over })
const quiet: BundleRecord = { ...RECORD, bundle: { ...RECORD.bundle, scans: 0, replacedCodes: [] }, stuck: { stuck: false, workingHours: 0, limitHours: 4 }, place: 'CUTTING', operation: null, next: CUT, lastScan: null, progress: RECORD.progress.map((entry, index) => ({ ...entry, state: index === 0 ? ('HERE' as const) : ('NOT_REACHED' as const), good: null, scrap: null, rework: null })), quality: { holds: [], reworks: [] }, genealogy: { hides: RECORD.genealogy.hides, shades: [], parent: null, children: [], serials: [] }, ticket: { code: RECORD.bundle.code, replacedCodes: [], reprints: [], jobs: [], coupons: [] } }
const voided: BundleRecord = { ...quiet, bundle: { ...quiet.bundle, status: 'VOID', voidedAt: at(29, 9, 0), voidReason: 'Taglia sbagliata' }, place: 'VOID', next: null }

function RecordDesign({ model }: { model: BundleRecordModel }) {
  return inShell(`/production/bundles/${RECORD.bundle.id}`, createElement(BundleRecordView, { model }), 'manager')
}

export const designScreen = defineDesignScreen<BundleRecordModel>({
  screen: 'SCR-259-record',
  title: 'Bundle record (Production › Bundles)',
  view: RecordDesign,
  cases: [
    { id: 'progress', label: 'Progress: done · here · not reached with good, scrap and rework; stuck past the limit', model: base('progress') },
    { id: 'scans', label: 'Scans at a station site: no worker column; a correction and what it voids', model: base('scans') },
    { id: 'scans-named', label: 'Scans where the site names workers: inside this one bundle, with the note', model: base('scans', { scans: { value: NAMED, problem: null } }) },
    { id: 'scans-loading', label: 'Scans: reading', model: base('scans', { scans: { value: null, problem: null } }) },
    { id: 'scans-error', label: 'Scans: the read failed', model: base('scans', { scans: { value: null, problem: 'error.offline' } }) },
    { id: 'scans-no-right', label: 'Scans: no workorders.view', model: base('scans', { scans: null, can: { ...bundlesCanAs('reader'), workOrders: false } }) },
    { id: 'quality', label: 'Quality: holds, rework and the genealogy tree', model: base('quality') },
    { id: 'quality-none', label: 'Quality: nothing held', model: base('quality', { bundle: { status: 'ready', value: quiet } }) },
    { id: 'ticket', label: 'Ticket: the label, replaced codes, reprints, print history, coupons', model: base('ticket') },
    { id: 'ticket-first', label: 'Ticket: the first one, nothing printed yet', model: base('ticket', { bundle: { status: 'ready', value: quiet } }) },
    { id: 'ticket-no-jobs-right', label: 'Ticket: no print.view, the history says so', model: base('ticket', { bundle: { status: 'ready', value: { ...RECORD, ticket: { ...RECORD.ticket, jobs: null } } } }) },
    { id: 'ticket-reader', label: 'Read-only: Reprint and the PDF held with their permissions', model: base('ticket', { can: bundlesCanAs('reader') }) },
    { id: 'reprint', label: 'Reprint: a site with no label printer, the PDF in the browser', model: base('ticket', { reprint: REPRINT }) },
    { id: 'void-held', label: 'Void bundle held in ⋯: scans name this bundle', model: base('progress') },
    { id: 'void', label: 'Void bundle: a reason; scans no longer take it', model: base('progress', { bundle: { status: 'ready', value: quiet }, voiding: { busy: false, problem: null } }) },
    { id: 'void-refused', label: 'Void bundle: refused meanwhile (a scan came in), in words', model: base('progress', { bundle: { status: 'ready', value: quiet }, voiding: { busy: false, problem: { key: 'production:refusal.bundle.SCANNED' }, reason: 'Taglia sbagliata' } }) },
    { id: 'voided', label: 'A void bundle: the banner with why', model: base('progress', { bundle: { status: 'ready', value: voided }, notice: { tone: 'success', words: { key: 'void.done' } } }) },
    { id: 'loading', label: 'Loading', model: base('progress', { bundle: { status: 'loading' } }) },
    { id: 'error', label: 'The read failed', model: base('progress', { bundle: { status: 'error', problem: 'error.offline' } }) },
    { id: 'not-found', label: 'Not found', model: base('progress', { bundle: { status: 'not_found' } }) },
    { id: 'no-permission', label: 'No permission', model: base('progress', { bundle: { status: 'forbidden' } }) },
  ],
})
