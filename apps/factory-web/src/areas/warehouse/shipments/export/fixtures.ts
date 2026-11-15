import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { BrokerPack, CustomsDocument, Declaration, ExportRead } from './api'
import type { ExportPapersModel } from './model'
import { ExportPapersView } from './view/ExportPapersView'

/**
 * SCR-653 — a shipment's Export papers (B-W2b-412 on B-W2b-409; design warehouse.shipments record › Export, sec sh-export): the
 * destination, the Incoterm, the EORI, the commercial invoice and the CN 22 / CN 23, the declaration with its MRN, invoice,
 * proof of exit and countdown, the broker's pack. Made-up data only (a workshop in Zürich "Officina Esempio AG", a broker
 * "Dogane Demo S.r.l.", EORI IT00000000001, MRN 26IT000000000DEMO1, invoice FT-2026-00001).
 */

const uid = (n: number) => `0190f0e2-7418-7000-8000-${String(n).padStart(12, '0')}`
const SHIPPED = '2026-11-12T15:20:00.000Z'

const paper = (kind: CustomsDocument['kind'], version: number, current: boolean, over: Partial<CustomsDocument> = {}): CustomsDocument => ({
  documentId: uid(100 + version + (kind === 'COMMERCIAL_INVOICE' ? 0 : 10)),
  kind,
  version,
  number: 'SH-26-0120',
  language: 'en',
  fileId: uid(200 + version),
  createdAt: `2026-11-1${version}T10:00:00.000Z`,
  current,
  ...over,
})

const declaration = (over: Partial<Declaration> = {}): Declaration => ({
  id: uid(300),
  status: 'PACK_SENT',
  filedBy: 'BROKER',
  broker: { id: uid(301), name: 'Dogane Demo S.r.l.' },
  mrn: null,
  invoice: null,
  exitConfirmedAt: null,
  exitFile: null,
  alertAfterDays: 30,
  exitDueAt: '2030-12-12T15:20:00.000Z',
  daysLeft: 27,
  overdue: false,
  links: [],
  version: 1,
  createdAt: '2026-11-12T16:00:00.000Z',
  ...over,
})

const read = (over: Partial<ExportRead> = {}): ExportRead => ({
  shipment: { id: uid(1), number: 'SH-26-0120', status: 'SHIPPED', shippedAt: SHIPPED, siteId: uid(2), companyId: uid(3) },
  destination: { country: 'CH', class: 'EXPORT' },
  needed: true,
  eori: 'IT00000000001',
  deliveryTerms: 'DAP Zürich',
  papers: { held: null, commercialInvoice: [], postalForm: { suggested: 'CN23', because: ['HEAVY', 'VALUE'], held: null, versions: [] } },
  declaration: null,
  declarationHeld: null,
  brokerPackOn: false,
  invoices: [
    { id: uid(401), number: 'FT-2026-00001', docType: 'TD01', status: 'ISSUED', date: '2026-11-12', ofShipment: true },
    { id: uid(402), number: 'FT-2026-00002', docType: 'TD24', status: 'ISSUED', date: '2026-11-13', ofShipment: false },
  ],
  alertDays: { default: 30, min: 1, max: 365 },
  mayManage: true,
  seesValues: true,
  ...over,
})

const pack = (over: Partial<BrokerPack> = {}): BrokerPack => ({
  shipment: { id: uid(1), number: 'SH-26-0120' },
  parts: [
    { part: 'COMMERCIAL_INVOICE', state: 'READY', files: [{ fileId: uid(501), name: 'SH-26-0120-commercial-invoice-v2.pdf', sizeBytes: 48_210 }] },
    { part: 'PACKING_LIST', state: 'MISSING', files: [] },
    { part: 'POSTAL_FORM', state: 'READY', files: [{ fileId: uid(502), name: 'SH-26-0120-cn23-v1.pdf', sizeBytes: 21_904 }] },
    { part: 'CONFORMITY', state: 'NONE', files: [] },
    { part: 'ORIGIN', state: 'READY', files: [] },
  ],
  originCandidates: [{ fileId: uid(503), name: 'certificato-origine-demo.pdf', sizeBytes: 81_330, createdAt: '2026-11-12T11:00:00.000Z' }],
  downloadHeld: null,
  linkHeld: 'SWITCH_OFF',
  brokerPackOn: false,
  ...over,
})

const WITH_PAPERS = { held: null, commercialInvoice: [paper('COMMERCIAL_INVOICE', 2, true), paper('COMMERCIAL_INVOICE', 1, false, { language: 'it' })], postalForm: { suggested: 'CN23' as const, because: ['HEAVY' as const, 'VALUE' as const], held: null, versions: [paper('CN23', 1, true)] } }
const CAN = { customs: true, price: true, uploadFiles: true, readFiles: true, viewParties: true, settingsView: true }

const model = (value: ExportRead | null, over: Partial<ExportPapersModel> = {}): ExportPapersModel => ({
  read: value ? { state: 'ready', value } : { state: 'loading' },
  can: CAN,
  dialog: null,
  busy: false,
  problem: null,
  done: null,
  brokers: null,
  pack: null,
  packPdf: null,
  passOn: null,
  prefix: '/w/DEMO',
  ...over,
})

export const designScreen = defineDesignScreen<ExportPapersModel>({
  screen: 'SCR-653',
  title: 'Shipment › Export papers: commercial invoice, CN 22 / CN 23, the declaration with MRN, invoice and proof of exit, the broker pack',
  view: ExportPapersView,
  cases: [
    { id: 'no-papers', label: 'Outside the EU, nothing made yet: Create commercial invoice; CN 23 for HEAVY and VALUE', model: model(read()) },
    { id: 'papers', label: 'The commercial invoice in two versions and the CN 23: each opens in a new tab; Open the declaration', model: model(read({ papers: WITH_PAPERS })) },
    { id: 'pack-sent', label: 'The declaration opened with the broker: Record MRN, Name the invoice, Send broker pack, Remove', model: model(read({ papers: WITH_PAPERS, declaration: declaration() })) },
    { id: 'filed', label: 'Filed with its MRN and invoice: the countdown to the alert; Proof of exit', model: model(read({ papers: WITH_PAPERS, declaration: declaration({ status: 'FILED', mrn: '26IT000000000DEMO1', invoice: { id: uid(401), number: 'FT-2026-00001', date: '2026-11-12' }, links: [{ id: uid(601), email: 'dogana@dogane-demo.example', expiresAt: '2026-11-26T16:00:00.000Z', revoked: false, answered: true, lastOpenedAt: '2026-11-13T09:10:00.000Z', createdAt: '2026-11-12T16:05:00.000Z' }] }) })) },
    { id: 'overdue', label: 'No proof of exit after the alert days: overdue (art. 8 DPR 633/72)', model: model(read({ papers: WITH_PAPERS, declaration: declaration({ status: 'FILED', mrn: '26IT000000000DEMO1', invoice: { id: uid(401), number: 'FT-2026-00001', date: '2026-11-12' }, daysLeft: -3, overdue: true }) })) },
    { id: 'exited', label: 'Exit confirmed with its proof: the declaration never changes', model: model(read({ papers: WITH_PAPERS, declaration: declaration({ status: 'EXITED', mrn: '26IT000000000DEMO1', invoice: { id: uid(401), number: 'FT-2026-00001', date: '2026-11-12' }, exitConfirmedAt: '2026-11-14T10:00:00.000Z', exitFile: { id: uid(701), name: 'uscita-demo.pdf' }, daysLeft: null }) })) },
    { id: 'by-carrier', label: 'The carrier files it (no broker)', model: model(read({ papers: WITH_PAPERS, declaration: declaration({ filedBy: 'CARRIER', broker: null }) })) },
    { id: 'no-eori', label: 'The company has no EORI: papers held with why, the link to Shipping settings', model: model(read({ eori: null, papers: { ...WITH_PAPERS, held: 'NO_EORI', commercialInvoice: [], postalForm: { ...WITH_PAPERS.postalForm, held: 'NO_EORI', versions: [] } } })) },
    { id: 'no-price', label: 'Without the price grain: the papers held (they show values)', model: model(read({ seesValues: false, papers: WITH_PAPERS }), { can: { ...CAN, price: false } }) },
    { id: 'cn22', label: 'Light parcels within the CN 22 limits: CN 22 offered', model: model(read({ papers: { held: null, commercialInvoice: [paper('COMMERCIAL_INVOICE', 1, true)], postalForm: { suggested: 'CN22', because: [], held: null, versions: [] } } })) },
    { id: 'domestic', label: 'Delivered in Italy: not needed', model: model(read({ destination: { country: 'IT', class: 'DOMESTIC' }, needed: false })) },
    { id: 'eu', label: 'Delivered in another EU state: not needed (the transport proof is above)', model: model(read({ destination: { country: 'DE', class: 'EU' }, needed: false })) },
    { id: 'invoice-dialog', label: 'Create commercial invoice: language, the reason, notes', model: model(read(), { dialog: { kind: 'invoice', language: '', reason: 'SALE_OF_GOODS', reasonText: '', notes: '' } }) },
    { id: 'declaration-dialog', label: 'Open the declaration: the broker or the carrier, the alert days', model: model(read({ papers: WITH_PAPERS }), { dialog: { kind: 'declaration', brokerPartyId: uid(301), alertAfterDays: 30 }, brokers: { state: 'ready', value: [{ id: uid(301), code: 'BRK-DEMO', legalName: 'Dogane Demo S.r.l.', roles: ['SUPPLIER'] }] } }) },
    { id: 'mrn-dialog', label: 'Record MRN: checked while typing', model: model(read({ papers: WITH_PAPERS, declaration: declaration() }), { dialog: { kind: 'mrn', mrn: '26IT00000' } }) },
    { id: 'exit-dialog', label: 'Proof of exit: when, and the file', model: model(read({ papers: WITH_PAPERS, declaration: declaration({ status: 'FILED', mrn: '26IT000000000DEMO1', invoice: { id: uid(401), number: 'FT-2026-00001', date: '2026-11-12' } }) }), { dialog: { kind: 'exit', at: '2026-11-14T10:00:00.000Z', file: null, fileName: null } }) },
    { id: 'pack-dialog', label: 'Send broker pack: the parts, the papers of origin; the link held while the site\'s switch is off', model: model(read({ papers: WITH_PAPERS, declaration: declaration() }), { dialog: { kind: 'pack', origin: [] }, pack: { state: 'ready', value: pack() } }) },
    { id: 'pack-on', label: 'The site\'s switch on: send by link, or one link to pass on', model: model(read({ papers: WITH_PAPERS, declaration: declaration(), brokerPackOn: true }), { dialog: { kind: 'pack', origin: [uid(503)] }, pack: { state: 'ready', value: pack({ linkHeld: null, brokerPackOn: true }) }, passOn: 'https://factory.example/l#token=demo-link' }) },
    { id: 'remove-dialog', label: 'Remove the declaration sent by mistake: the reason', model: model(read({ papers: WITH_PAPERS, declaration: declaration() }), { dialog: { kind: 'remove', reason: '' } }) },
    { id: 'refused', label: 'A refusal in words (CN 22 not allowed for these parcels)', model: model(read({ papers: WITH_PAPERS }), { dialog: { kind: 'postal', form: 'CN23', language: '', reason: 'SALE_OF_GOODS', reasonText: '', comments: '' }, problem: { key: 'export.refusal.CN22_LIMIT' } }) },
    { id: 'no-right', label: 'Without shipping.customs.manage: every write held with why', model: model(read({ papers: WITH_PAPERS, declaration: declaration(), mayManage: false }), { can: { ...CAN, customs: false } }) },
    { id: 'loading', label: 'Reading the export', model: model(null) },
    { id: 'error', label: 'The export could not be read: Try again', model: model(null, { read: { state: 'error', problem: { key: 'problem.read.unavailable' } } }) },
  ],
})
