import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import { COLOURS, MATERIALS, SITE, SUPPLIERS, uid } from '../../../_shared/buying/fixtures'
import type { Claim, ClaimCounts, ClaimLine, ClaimRow, ClaimStatus, HideRow, LotRecord, LotRow, PickerReason, ReturnAnswer, SendCheck, SupplierContact } from '../api'
import { claimsCan, type ClaimsCan } from '../model'

/**
 * Made-up data for Purchasing › Returns & claims' design cases (SCR-131): an invented company ("Officina Demo"), its site
 * ("STAB-N"), suppliers ("Conceria Demo S.r.l.", "Tessitura Esempio S.p.A.", "Protezioni Prova S.r.l."), lots, hides,
 * receipts, DDT numbers, people and amounts. Nothing here is a real company, person, order or number. Design-only
 * (fixtures and tests import it); it exports no `designScreen`.
 */

export { PREFIX, TIME_ZONE } from '../../../_shared/buying/fixtures'
export const NOW = '2026-11-18T09:30:00.000Z'
export const at = (day: number, hour: number, minute = 0, month = 11) => new Date(Date.UTC(2026, month - 1, day, hour, minute)).toISOString()
export const COMPANY = DEMO_COMPANIES[0].id

// ---- roles (the real templates: buyer and warehouse hold the claims rights; the buyer sees costs) ---------------------------

const templatePermissions = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']
const ROLE_PERMISSIONS = {
  owner: [...OWNER_PERMISSIONS, ...(templateOf('owner')?.permissions ?? []), 'money.cost', 'money.price', 'money.margin'],
  buyer: [...templatePermissions('buyer'), 'money.cost'],
  warehouse: templatePermissions('warehouse'),
  planner: templatePermissions('planner'),
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
  sales: templatePermissions('sales'),
} as const
export type RoleCase = keyof typeof ROLE_PERMISSIONS
export const canFor = (role: RoleCase): ClaimsCan => claimsCan(ROLE_PERMISSIONS[role])

/** The Office shell around a page (the role's navigation, this page's place). */
export function inShell(path: string, page: ReactNode, role: RoleCase = 'buyer'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...ROLE_PERMISSIONS[role]])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- the parts ------------------------------------------------------------------------------------------------------------------

const site = { id: SITE.id, code: SITE.code }
const tannery = { id: SUPPLIERS.tannery.id, code: SUPPLIERS.tannery.code, name: SUPPLIERS.tannery.legalName }
const fabric = { id: SUPPLIERS.fabric.id, code: SUPPLIERS.fabric.code, name: SUPPLIERS.fabric.legalName }
const protector = { id: SUPPLIERS.protector.id, code: SUPPLIERS.protector.code, name: SUPPLIERS.protector.legalName }
const leather = { id: MATERIALS.leather.id, code: MATERIALS.leather.code, name: MATERIALS.leather.name }
const lining = { id: MATERIALS.lining.id, code: MATERIALS.lining.code, name: MATERIALS.lining.name }
const pads = { id: MATERIALS.protector.id, code: MATERIALS.protector.code, name: MATERIALS.protector.name }
export const LOTS = {
  leather: { id: uid('8181', 1), code: 'LT-DEMO-0042' },
  leatherB: { id: uid('8181', 2), code: 'LT-DEMO-0043' },
  lining: { id: uid('8181', 3), code: 'LT-DEMO-0051' },
  pads: { id: uid('8181', 4), code: 'LT-DEMO-0060' },
}
export const RECEIPT = { id: uid('6301', 22), number: 'GR-DEMO-0022', supplierDdtNumber: 'DDT-CD-118', supplierDdtDate: '2026-11-10' }
export const ORDER = { id: uid('5801', 7), number: 'PO-DEMO-0007' }
export const PEOPLE = { buyer: { id: uid('9191', 1), name: 'Giulia Esempio' }, warehouse: { id: uid('9191', 2), name: 'Marco Prova' } }

const reason = (code: string | null, labelIt: string | null, labelEn: string | null, note: string | null) => ({ code, labelIt, labelEn, note })
export const REASONS = {
  quality: reason('QUALITY', 'Difetto di qualità', 'Quality defect', 'Fori vicino al fianco su 3 pelli'),
  short: reason('SHORT_DELIVERY', 'Fornitura incompleta', 'Short delivery', null),
  wrong: reason('WRONG_ITEM', 'Articolo errato', 'Wrong item', 'Colore diverso dal campione'),
  own: reason('STAINS', null, null, 'Macchie di colla'),
}

const CLAIM_IDS = { ret: uid('1311', 1), claim: uid('1311', 2), pads: uid('1311', 3), lining: uid('1311', 4), closed: uid('1311', 5), cancelled: uid('1311', 6), rejected: uid('1311', 7) }

function row(over: Partial<ClaimRow> & Pick<ClaimRow, 'id' | 'number' | 'kind' | 'status'>): ClaimRow {
  return {
    companyId: COMPANY,
    site,
    supplier: tannery,
    foundAt: 'RECEIPT',
    reason: REASONS.quality,
    remedy: 'CREDIT',
    lots: [LOTS.leather],
    materials: [leather],
    quantity: { quantity: '156.2000', uom: 'FT2' },
    lines: 3,
    returned: 0,
    currency: 'EUR',
    value: 65604,
    expectedCreditAmount: 65604,
    ageDays: 2,
    sentAt: null,
    answeredAt: null,
    closedAt: null,
    version: 3,
    createdAt: at(16, 8, 10),
    updatedAt: at(16, 8, 40),
    ...over,
  }
}

export const ROWS: ClaimRow[] = [
  row({ id: CLAIM_IDS.ret, number: 'CLM-DEMO-0014', kind: 'RETURN', status: 'SENT', returned: 3, sentAt: at(17, 9, 5) }),
  row({ id: CLAIM_IDS.claim, number: 'CLM-DEMO-0013', kind: 'CLAIM', status: 'DRAFT', reason: REASONS.short, lots: [LOTS.leatherB], quantity: { quantity: '4.5000', uom: 'FT2' }, lines: 1, value: 1890, expectedCreditAmount: 1890, ageDays: 0, createdAt: at(18, 8, 0) }),
  row({ id: CLAIM_IDS.pads, number: 'CLM-DEMO-0012', kind: 'CLAIM', status: 'ACCEPTED', supplier: protector, foundAt: 'CUTTING', reason: REASONS.wrong, lots: [LOTS.pads], materials: [pads], quantity: { quantity: '24.0000', uom: 'PCS' }, lines: 1, value: 11280, expectedCreditAmount: 10000, ageDays: 9, sentAt: at(9, 11), answeredAt: at(12, 15) }),
  row({ id: CLAIM_IDS.lining, number: 'CLM-DEMO-0011', kind: 'RETURN', status: 'ACCEPTED', supplier: fabric, reason: REASONS.own, lots: [LOTS.lining], materials: [lining], quantity: null, lines: 2, returned: 0, value: 24250, expectedCreditAmount: null, remedy: 'REPLACEMENT', ageDays: 14, sentAt: at(4, 10), answeredAt: at(6, 9) }),
  row({ id: CLAIM_IDS.rejected, number: 'CLM-DEMO-0010', kind: 'CLAIM', status: 'REJECTED', reason: REASONS.quality, lines: 1, quantity: { quantity: '12.0000', uom: 'FT2' }, value: 5040, expectedCreditAmount: 5040, ageDays: 20, sentAt: at(29, 9, 0, 10), answeredAt: at(3, 9) }),
  row({ id: CLAIM_IDS.closed, number: 'CLM-DEMO-0009', kind: 'RETURN', status: 'CLOSED', supplier: fabric, reason: REASONS.wrong, lots: [LOTS.lining], materials: [lining], quantity: { quantity: '48.5000', uom: 'M' }, lines: 1, returned: 1, value: 13580, expectedCreditAmount: 13580, ageDays: 31, sentAt: at(18, 9, 0, 10), answeredAt: at(20, 9, 0, 10), closedAt: at(2, 16) }),
  row({ id: CLAIM_IDS.cancelled, number: 'CLM-DEMO-0008', kind: 'CLAIM', status: 'CANCELLED', reason: REASONS.short, lines: 0, quantity: null, value: null, expectedCreditAmount: null, ageDays: 33, remedy: null }),
]
export const OPEN_ROWS = ROWS.filter((entry) => ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'].includes(entry.status))
export const COUNTS: ClaimCounts = { open: 5, waitingForSupplier: 1, creditExpected: 1, closedThisMonth: 1 }
export const ZERO_COUNTS: ClaimCounts = { open: 0, waitingForSupplier: 0, creditExpected: 0, closedThisMonth: 0 }

/** A row as a role without the cost grain receives it (the API drops the values). */
export const withoutCost = ({ value: _value, expectedCreditAmount: _credit, ...rest }: ClaimRow): ClaimRow => rest

// ---- records --------------------------------------------------------------------------------------------------------------------

const hideLine = (seq: number, hide: number, area: string, over: Partial<ClaimLine> = {}): ClaimLine => ({
  id: uid('1312', seq),
  seq,
  item: { ...leather, baseUom: 'FT2', tracking: 'HIDE' },
  colour: COLOURS.black,
  lot: { id: LOTS.leather.id, code: LOTS.leather.code, qualityStatus: 'QUARANTINE' },
  hide: { id: uid('8282', hide), code: `HD-DEMO-0042-${hide}` },
  discrepancy: null,
  receiptLineId: uid('6302', 1),
  quantity: area,
  uom: 'FT2',
  baseQuantity: area,
  reason: null,
  unitCost: '4.200000',
  creditAmount: Math.round(Number(area) * 420),
  move: null,
  ddt: null,
  liveDdt: null,
  note: null,
  version: 1,
  ...over,
})

const DDT = { id: uid('1471', 1), number: '146/2026' }

export function claim(kind: 'RETURN' | 'CLAIM', status: ClaimStatus, over: Partial<Claim> = {}): Claim {
  const sent = status !== 'DRAFT' && status !== 'CANCELLED'
  const answered = status === 'ACCEPTED' || status === 'REJECTED' || status === 'CLOSED'
  const returned = kind === 'RETURN' && (status === 'CLOSED' || over.returned !== undefined)
  const lines: ClaimLine[] =
    kind === 'RETURN'
      ? [hideLine(10, 1, '52.4000'), hideLine(20, 2, '51.8000'), hideLine(30, 3, '52.0000')].map((line) =>
          returned ? { ...line, move: { id: uid('6464', line.seq), reason: 'ADJUSTMENT', occurredAt: at(17, 9, 20), quantity: line.quantity, uom: line.uom, fromLocation: { id: uid('2323', 2), code: 'N-STORE' } }, ddt: { id: DDT.id, number: DDT.number, cancelled: false }, liveDdt: { id: DDT.id, number: DDT.number } } : line,
        )
      : [hideLine(10, 7, '4.5000', { lot: { id: LOTS.leatherB.id, code: LOTS.leatherB.code, qualityStatus: 'RELEASED' }, hide: { id: uid('8282', 7), code: 'HD-DEMO-0043-7' }, discrepancy: { id: uid('6303', 1), seq: 10, kind: 'DAMAGED', status: sent ? (answered ? 'AGREED' : 'SENT') : 'OPEN', receiptId: RECEIPT.id }, reason: 'Graffio profondo sul fiore' })]
  const value = lines.reduce((sum, line) => sum + (line.creditAmount ?? 0), 0)
  return {
    id: kind === 'RETURN' ? CLAIM_IDS.ret : CLAIM_IDS.claim,
    number: kind === 'RETURN' ? 'CLM-DEMO-0014' : 'CLM-DEMO-0013',
    kind,
    status,
    companyId: COMPANY,
    site,
    supplier: tannery,
    foundAt: 'RECEIPT',
    reason: kind === 'RETURN' ? REASONS.quality : REASONS.short,
    remedy: 'CREDIT',
    lots: kind === 'RETURN' ? [LOTS.leather] : [LOTS.leatherB],
    materials: [leather],
    quantity: { quantity: lines.reduce((sum, line) => sum + Number(line.quantity), 0).toFixed(4), uom: 'FT2' },
    returned: lines.filter((line) => line.move).length,
    currency: 'EUR',
    value,
    expectedCreditAmount: status === 'ACCEPTED' && kind === 'CLAIM' ? 1500 : value,
    ageDays: 2,
    sentAt: sent ? at(17, 9, 5) : null,
    answeredAt: answered ? at(17, 15, 30) : null,
    closedAt: status === 'CLOSED' ? at(18, 9, 0) : null,
    version: 4,
    createdAt: at(16, 8, 10),
    updatedAt: at(17, 15, 30),
    goodsReceipt: RECEIPT,
    purchaseOrder: ORDER,
    supplierAnswer: answered ? (status === 'REJECTED' ? 'Il difetto rientra nella tolleranza della scelta concordata.' : 'Accettiamo: emetteremo nota di credito.') : null,
    closeNote: status === 'CLOSED' ? 'Nota di credito ricevuta e controllata.' : null,
    cancelledAt: status === 'CANCELLED' ? at(16, 11) : null,
    cancelReason: status === 'CANCELLED' ? 'Aperto per errore sulla ricezione sbagliata' : null,
    internalNote: 'Chiamato il fornitore il 17/11.',
    sentById: sent ? PEOPLE.buyer.id : null,
    createdById: PEOPLE.warehouse.id,
    lines,
    ddts: returned ? [{ id: DDT.id, number: DDT.number, documentDate: '2026-11-17', reason: 'RETURN', startAt: at(17, 9, 30), cancelled: false, lineIds: lines.map((line) => line.id) }] : [],
    credit: { currency: 'EUR', remedy: 'CREDIT', expected: status === 'ACCEPTED' && kind === 'CLAIM' ? 1500 : value, value, matched: null, difference: null },
    people: [PEOPLE.buyer, PEOPLE.warehouse],
    ...over,
  }
}

/** A record as a role without the cost grain receives it. */
export function costless(value: Claim): Claim {
  const { value: _value, expectedCreditAmount: _credit, ...rest } = value
  return { ...rest, lines: value.lines.map(({ unitCost: _unit, creditAmount: _amount, ...line }) => line), credit: { currency: value.credit.currency, remedy: value.credit.remedy, matched: null, difference: null } }
}

export const SEND_CHECK: SendCheck = {
  ready: true,
  problems: [],
  recipients: [
    { contactId: uid('6161', 1), name: 'Ufficio qualità Demo', email: 'qualita@conceria-demo.example.com', roles: ['QUALITY'], language: 'it', suggested: true },
    { contactId: uid('6161', 2), name: 'Ordini Demo', email: 'ordini@conceria-demo.example.com', roles: ['ORDERS'], language: 'it', suggested: false },
  ],
  language: 'it',
  subject: 'Reclamo CLM-DEMO-0013 — ricevimento GR-DEMO-0022',
  message: 'Buongiorno,\nsegnaliamo per la consegna DDT-CD-118 del 10/11/2026 una fornitura incompleta del lotto LT-DEMO-0043 (4,5 ft²).\nChiediamo una nota di credito.\nCordiali saluti',
}

export const REASON_LIST: PickerReason[] = [
  { id: uid('7373', 1), list: 'CLAIM', code: 'QUALITY', labelIt: 'Difetto di qualità', labelEn: 'Quality defect', labelI18n: {}, icon: 'shield', colour: null, needsDetail: false, sortOrder: 10 },
  { id: uid('7373', 2), list: 'CLAIM', code: 'SHORT_DELIVERY', labelIt: 'Fornitura incompleta', labelEn: 'Short delivery', labelI18n: {}, icon: 'package', colour: null, needsDetail: false, sortOrder: 20 },
  { id: uid('7373', 3), list: 'CLAIM', code: 'WRONG_ITEM', labelIt: 'Articolo errato', labelEn: 'Wrong item', labelI18n: {}, icon: 'box', colour: null, needsDetail: false, sortOrder: 30 },
  { id: uid('7373', 4), list: 'CLAIM', code: 'OTHER', labelIt: 'Altro', labelEn: 'Other', labelI18n: {}, icon: 'camera', colour: null, needsDetail: true, sortOrder: 40 },
]

// ---- Return to supplier --------------------------------------------------------------------------------------------------------

const lotRow = (over: Partial<LotRow>): LotRow => ({
  id: LOTS.leather.id,
  code: LOTS.leather.code,
  companyId: COMPANY,
  siteId: SITE.id,
  siteCode: SITE.code,
  item: { ...leather, baseUom: 'FT2', tracking: 'HIDE' },
  colour: COLOURS.black,
  supplier: tannery,
  supplierLotRef: 'CD-2211',
  dyeBatch: 'B-77',
  shade: 'A',
  receivedAt: at(10, 9),
  receipt: { id: RECEIPT.id, number: RECEIPT.number },
  opening: false,
  qualityStatus: 'QUARANTINE',
  qualityNote: null,
  qualityDecidedAt: null,
  crVi: { required: true, status: 'PENDING', valueMgKg: null, limitMgKg: '3.000', evidence: null, testedOn: null },
  documents: 1,
  onHand: '156.2000',
  hides: 3,
  issuedTo: 0,
  ...over,
})

export const FOUND_LOTS: LotRow[] = [
  lotRow({}),
  lotRow({ id: LOTS.pads.id, code: LOTS.pads.code, item: { ...pads, baseUom: 'PCS', tracking: 'LOT' }, colour: null, supplier: protector, supplierLotRef: 'PP-9', dyeBatch: null, shade: null, qualityStatus: 'RELEASED', crVi: { required: false, status: 'NOT_REQUIRED', valueMgKg: null, limitMgKg: null, evidence: null, testedOn: null }, onHand: '36.0000', hides: 0 }),
]

const hide = (n: number, area: string, location: string, over: Partial<HideRow> = {}): HideRow => ({
  id: uid('8282', n),
  code: `HD-DEMO-0042-${n}`,
  supplierCode: `T-${4400 + n}`,
  siteId: SITE.id,
  companyId: COMPANY,
  item: { ...leather, baseUom: 'FT2', tracking: 'HIDE' },
  colour: COLOURS.black,
  lot: { id: LOTS.leather.id, code: LOTS.leather.code, qualityStatus: 'QUARANTINE', crViStatus: 'PENDING', dyeBatch: 'B-77', shade: 'A' },
  grade: 'A',
  shade: 'A',
  thicknessMm: '1.20',
  defects: null,
  area,
  areaUom: 'FT2',
  baseArea: area,
  onHand: area,
  left: area,
  state: 'FULL',
  location: { id: uid('2323', 2), code: location, name: 'Magazzino pelli' },
  receivedAt: at(10, 9),
  createdAt: at(10, 9),
  ...over,
})
export const LOT_HIDES: HideRow[] = [hide(1, '52.4000', 'N-STORE'), hide(2, '51.8000', 'N-STORE', { defects: 'Fori sul fianco' }), hide(3, '52.0000', 'N-STORE')]

export const PAD_STOCK: LotRecord['stock'] = [
  { location: { id: uid('2323', 3), code: 'N-PPE-01', name: 'Scaffale protezioni' }, onHand: '24.0000', held: '0.0000', hides: 0 },
  { location: { id: uid('2323', 4), code: 'N-PPE-02', name: 'Scaffale protezioni 2' }, onHand: '12.0000', held: '0.0000', hides: 0 },
]
export const LEATHER_STOCK: LotRecord['stock'] = [{ location: { id: uid('2323', 2), code: 'N-STORE', name: 'Magazzino pelli' }, onHand: '156.2000', held: '0.0000', hides: 3 }]

export const CONTACTS: SupplierContact[] = [
  { id: uid('6161', 1), name: 'Ufficio qualità Demo', email: 'qualita@conceria-demo.example.com', roles: ['QUALITY'], language: 'it', status: 'ACTIVE' },
  { id: uid('6161', 2), name: 'Ordini Demo', email: 'ordini@conceria-demo.example.com', roles: ['ORDERS'], language: 'it', status: 'ACTIVE' },
]

export function returnAnswer(over: Partial<ReturnAnswer> = {}): ReturnAnswer {
  return {
    claim: claim('RETURN', 'SENT', { returned: 3 }),
    moveIds: [uid('6464', 10), uid('6464', 20), uid('6464', 30)],
    ddt: { id: DDT.id, number: DDT.number, file: { id: uid('1472', 1) }, pdfProblem: null },
    claimLinesKeepingOldDdt: [],
    overReserved: [],
    ...over,
  }
}
