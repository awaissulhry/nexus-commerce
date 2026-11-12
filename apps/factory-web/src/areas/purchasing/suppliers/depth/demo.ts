import type { Party } from '../../../parties/_shared/api'
import type { BankAccount, BankView, ChangeRequest, ClaimRow, DocumentsSummary, Qualifications, ReceiptRow, SupplierProfile, SupplierRow, Vault } from './api'
import { depthCan, type DepthCan } from './model'

/**
 * Made-up data for the design cases of B-W2b-334 (SCR-056, SCR-057): the invented suppliers of the parties fixtures
 * (Conceria Demo, Lab. Terzista Demo …), made-up documents, qualifications, receipts and claims, and test IBANs only
 * (IT, ABI and CAB 00000, right check digits). Nothing here is a real company, person, number or account. Design-only (it
 * exports no `designScreen`).
 */

export const TODAY = '2026-11-12'
const at = (day: string, time = '09:30') => `${day}T${time}:00.000Z`
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
export const ME = '0190f0e2-1111-7000-8000-000000000001'
const FINANCE = { id: uid('1212', 1), name: 'Franca Esempio' }
const BUYER = { id: uid('1212', 2), name: 'Bruno Prova' }

/** Every right of the step (the owner's view). */
export const ALL_CAN: DepthCan = depthCan([
  'parties.manage',
  'purchasing.suppliers.status',
  'purchasing.qualification.manage',
  'purchasing.supplierDocuments.review',
  'purchasing.supplierChanges.decide',
  'partners.tasks.manage',
  'purchasing.bank.view',
  'purchasing.bank.propose',
  'purchasing.bank.callBack',
  'purchasing.bank.verify',
  'purchasing.bank.reveal',
  'inventory.stock.view',
  'purchasing.view',
  'files.read',
  'purchasing.questionnaire.view',
])
/** A planner: reads, decides nothing (no manage, status, review, bank). */
export const READ_CAN: DepthCan = depthCan(['inventory.stock.view', 'purchasing.view', 'files.read'])

// ---- the profile ----

export function profileOf(party: Party, over: Partial<SupplierProfile> = {}): SupplierProfile {
  const active = party.contacts.filter((contact) => contact.status === 'ACTIVE')
  const receives = (index: number): SupplierProfile['contacts'][number]['receives'] => (index === 0 ? ['PO', 'CLAIM'] : index === 1 ? ['QUALITY', 'DOCUMENT'] : index === 2 ? ['REMITTANCE'] : [])
  const contacts = party.contacts.map((contact, index) => ({ id: contact.id, name: contact.name, email: contact.email, phone: contact.phone, roles: [...contact.roles], receives: contact.email ? receives(index) : [], language: contact.language, status: contact.status, version: contact.version }))
  const by = (kind: 'PO' | 'CLAIM' | 'REMITTANCE' | 'QUALITY' | 'DOCUMENT') => {
    const ids = contacts.filter((contact) => contact.status === 'ACTIVE' && contact.receives.includes(kind)).map((contact) => contact.id)
    return { kind, by: ids.length > 0 ? ('RECEIVES' as const) : active.length > 0 && kind === 'PO' && active[0]!.email ? ('ROLE' as const) : ('NONE' as const), contactIds: ids.length > 0 ? ids : kind === 'PO' && active[0]?.email ? [active[0].id] : [] }
  }
  return {
    id: party.id,
    companyId: party.companyId,
    code: party.code,
    name: party.tradeName ?? party.legalName,
    legalName: party.legalName,
    roles: [...party.roles],
    partyStatus: party.status,
    kinds: ['TANNERY'],
    standing: { status: 'APPROVED', source: 'SUPPLIER', supplierStatus: 'APPROVED', reason: null, changedAt: at('2026-09-14'), changedBy: BUYER.name },
    newOrderProblem: null,
    leadTimeDays: 21,
    origin: { country: 'IT', region: 'Toscana', note: 'Concia a Santa Croce sull’Arno; rifinitura in sede.', hideCountries: ['IT', 'FR'], tannages: ['CHROME', 'VEGETABLE'] },
    closures: {
      calendarId: uid('3131', 1),
      weeklyDaysOff: [6, 7],
      ahead: [
        { from: '2026-12-24', to: '2027-01-06', kind: 'CLOSURE', name: 'Chiusura natalizia', days: 14 },
        { from: '2027-08-02', to: '2027-08-27', kind: 'CLOSURE', name: 'Chiusura estiva', days: 26 },
      ],
      orderedToday: { orderDate: TODAY, leadTimeDays: 21, arrives: '2026-12-03', skipped: [], capped: false },
    },
    contacts,
    routing: (['PO', 'CLAIM', 'REMITTANCE', 'QUALITY', 'DOCUMENT'] as const).map(by),
    version: party.version,
    ...over,
  }
}

// ---- the vault ----

const doc = (n: number, over: Partial<Vault['documents'][number]>): Vault['documents'][number] => ({
  fileId: uid('4141', n),
  category: 'TEST_REPORT',
  name: 'rapporto-cromo-vi-2026.pdf',
  issuer: 'Laboratorio Prova S.r.l.',
  number: 'LP-2026-0001',
  issuedOn: '2026-03-02',
  expiresOn: '2027-03-01',
  daysLeft: 109,
  state: 'VALID',
  source: 'OFFICE',
  uploadId: null,
  articleCodes: [],
  addedAt: at('2026-03-04'),
  ...over,
})

export const UPLOAD: Vault['review']['uploads'][number] = {
  uploadId: uid('4242', 1),
  fileId: uid('4141', 9),
  companyId: uid('0101', 1),
  record: { type: 'Party', id: uid('6666', 21), label: 'Conceria Demo' },
  category: 'DECLARATION',
  issuer: 'Conceria Demo S.p.A.',
  number: 'REACH-2026-07',
  issuedOn: '2026-11-03',
  expiresOn: '2027-11-02',
  articleCodes: ['DEMO-PL-NAP12'],
  lotCodes: [],
  note: 'Dichiarazione aggiornata per la nuova collezione.',
  replacesFileId: null,
  uploadedByName: 'Luca Prova',
  receivedAt: at('2026-11-10', '14:05'),
  version: 1,
}

export function vaultOf(party: Party, over: Partial<Vault> = {}): Vault {
  return {
    supplier: { id: party.id, code: party.code, name: party.tradeName ?? party.legalName, kinds: ['TANNERY'], roles: [...party.roles] },
    asked: [
      { category: 'SUPPLIER_CERTIFICATE', required: false, codes: ['LWG_AUDIT'], laws: [], state: 'EXPIRING', fileId: uid('4141', 2), expiresOn: '2026-12-01', waiting: false },
      { category: 'TEST_REPORT', required: true, codes: ['CR_VI_TEST_REPORT'], laws: ['REACH Annex XVII entry 47'], state: 'MET', fileId: uid('4141', 1), expiresOn: '2027-03-01', waiting: false },
      { category: 'DECLARATION', required: true, codes: ['REACH_DECLARATION'], laws: ['REACH art. 33'], state: 'MISSING', fileId: null, expiresOn: null, waiting: true },
    ],
    materials: [
      { itemId: uid('4701', 1), code: 'DEMO-PL-NAP12', name: 'Pelle bovina pieno fiore 1,2 mm', kind: 'LEATHER', needs: 'CR_VI_TEST_REPORT', law: 'REACH Annex XVII entry 47', state: 'MET', fileId: uid('4141', 1), certificate: null, expiresOn: '2027-03-01', checkedAtSend: true, heldAtSend: false },
      { itemId: uid('4701', 2), code: 'DEMO-PL-SCAM08', name: 'Pelle scamosciata 0,8 mm', kind: 'LEATHER', needs: 'CR_VI_TEST_REPORT', law: 'REACH Annex XVII entry 47', state: 'EXPIRED', fileId: uid('4141', 3), certificate: null, expiresOn: '2026-10-30', checkedAtSend: true, heldAtSend: true },
    ],
    documents: [
      doc(1, {}),
      doc(2, { category: 'SUPPLIER_CERTIFICATE', name: 'audit-lwg-gold.pdf', issuer: 'Ente Esempio', number: 'LWG-DEMO-77', issuedOn: '2025-12-02', expiresOn: '2026-12-01', daysLeft: 19, state: 'EXPIRING', source: 'PORTAL', uploadId: uid('4242', 7) }),
      doc(3, { name: 'rapporto-cromo-vi-scamosciato.pdf', number: 'LP-2025-0420', issuedOn: '2025-10-31', expiresOn: '2026-10-30', daysLeft: -13, state: 'EXPIRED', articleCodes: ['DEMO-PL-SCAM08'] }),
    ],
    nextExpiry: '2026-12-01',
    review: { uploads: [UPLOAD], changes: [{ requestId: uid('4343', 1), companyId: uid('0101', 1), requestedByName: 'Luca Prova', sentAt: at('2026-11-09', '10:12') }] },
    questionnaire: [{ responseId: uid('4444', 1), companyId: uid('0101', 1), decision: 'ACCEPTED', submittedAt: at('2026-09-01'), reviewedAt: at('2026-09-03') }],
    may: { review: true, decideChanges: true, upload: true, qualify: true },
    ...over,
  }
}

export const CHANGES: readonly ChangeRequest[] = [
  {
    requestId: uid('4343', 1),
    state: 'OPEN',
    sentAt: at('2026-11-09', '10:12'),
    sentBy: 'Luca Prova',
    note: null,
    changes: [
      { target: 'ADDRESS', op: 'CHANGE', before: { name: 'Magazzino pelli', line1: 'Via del Cuoio 8' }, after: { name: 'Magazzino pelli', line1: 'Via del Cuoio 10' }, changed: ['line1'] },
      { target: 'CONTACT', op: 'ADD', before: null, after: { name: 'Marta Esempio', email: 'logistica@conceria-demo.example.com' }, changed: [] },
    ],
  },
]

// ---- qualifications ----

export function qualificationsOf(party: Party, workshop: boolean, over: Partial<Qualifications> = {}): Qualifications {
  return {
    supplier: { id: party.id, code: party.code, name: party.tradeName ?? party.legalName, roles: [...party.roles], kinds: workshop ? ['SUBCONTRACTOR'] : ['TANNERY'] },
    qualifications: workshop
      ? [
          {
            id: uid('4545', 1),
            companyId: uid('0101', 1),
            status: 'APPROVED',
            scope: { workCentreKinds: ['SEWING'], materialKinds: [], operations: [] },
            validFrom: '2026-02-01',
            validUntil: '2027-01-31',
            evidence: [{ recordType: 'SupplierQuestionnaireResponse', recordId: uid('4444', 2), label: 'Questionario 2026', documents: [{ fileId: uid('4141', 20), expiresOn: '2026-12-20', expired: false }] }],
            decided: { at: at('2026-02-01'), by: { id: BUYER.id, name: BUYER.name } },
            conditions: null,
            refuseReason: null,
            suspended: null,
            withdrawn: null,
            standing: { standing: 'QUALIFIED' },
            version: 3,
            may: { change: false, decide: false, suspend: true, lift: false, withdraw: true },
          },
          {
            id: uid('4545', 2),
            companyId: uid('0101', 1),
            status: 'PENDING',
            scope: { workCentreKinds: ['FINISHING'], materialKinds: [], operations: [] },
            validFrom: null,
            validUntil: null,
            evidence: [{ recordType: 'SupplierQuestionnaireResponse', recordId: uid('4444', 2), label: 'Questionario 2026', documents: [] }],
            decided: null,
            conditions: null,
            refuseReason: null,
            suspended: null,
            withdrawn: null,
            standing: { standing: 'PENDING' },
            version: 1,
            may: { change: true, decide: true, suspend: false, lift: false, withdraw: false },
          },
        ]
      : [],
    work: workshop
      ? [
          { companyId: uid('0101', 1), workCentreKind: 'SEWING', qualified: true, standing: 'QUALIFIED', qualificationId: uid('4545', 1) },
          { companyId: uid('0101', 1), workCentreKind: 'FINISHING', qualified: false, standing: 'PENDING', qualificationId: uid('4545', 2) },
        ]
      : [],
    may: { create: true },
    ...over,
  }
}

// ---- bank details (test IBANs only) ----

const account = (n: number, over: Partial<BankAccount>): BankAccount => ({
  id: uid('4646', n),
  masked: 'IT** **** **** 3456',
  ibanCountry: 'IT',
  ibanLast4: '3456',
  bic: null,
  bankName: 'Banca Esempio',
  holder: 'Conceria Demo S.p.A.',
  currency: 'EUR',
  status: 'ACTIVE',
  pill: 'USABLE',
  source: 'OFFICE',
  replacesId: null,
  proposedAt: at('2026-03-01'),
  proposedBy: FINANCE,
  callBack: { at: at('2026-03-02', '10:00'), by: BUYER, kind: 'CONTACT', onFileId: uid('5555', 23), label: 'Paola Campione', phone: '+39 000 000 0003' },
  verified: { at: at('2026-03-02', '15:00'), by: BUYER },
  activatedAt: at('2026-03-02', '15:00'),
  refused: null,
  retired: null,
  files: [{ id: uid('4141', 30), name: 'lettera-banca-esempio.pdf', status: 'AVAILABLE' }],
  approval: null,
  callBackCandidates: null,
  may: { callBack: false, verify: false, refuse: false, retire: true, reveal: true },
  heldWhy: { callBack: null, verify: null },
  version: 4,
  ...over,
})

export const ACTIVE_ACCOUNT = account(1, {})
export const WAITING_CALL = account(2, {
  masked: 'IT** **** **** 5001',
  ibanLast4: '5001',
  bankName: 'Banca Prova',
  status: 'PROPOSED',
  pill: 'WAITING_CALL_BACK',
  source: 'PORTAL',
  replacesId: ACTIVE_ACCOUNT.id,
  proposedAt: at('2026-11-10', '16:20'),
  proposedBy: { id: uid('1212', 9), name: 'Luca Prova' },
  callBack: null,
  verified: null,
  activatedAt: null,
  files: [],
  callBackCandidates: {
    usable: [
      { kind: 'CONTACT', id: uid('5555', 23), label: 'Paola Campione', phone: '+39 000 000 0003' },
      { kind: 'ADDRESS', id: uid('3333', 21), label: 'Via delle Concerie 1', phone: '+39 000 000 0001' },
    ],
    held: [{ kind: 'CONTACT', id: uid('5555', 29), label: 'Marta Esempio', phone: '+39 000 000 0099', hold: 'ADDED_AFTER' }],
  },
  may: { callBack: true, verify: false, refuse: true, retire: false, reveal: false },
  version: 1,
})
export const WAITING_CHECK = account(3, {
  ...WAITING_CALL,
  id: uid('4646', 3),
  pill: 'WAITING_SECOND_CHECK',
  callBack: { at: at('2026-11-11', '11:00'), by: BUYER, kind: 'CONTACT', onFileId: uid('5555', 23), label: 'Paola Campione', phone: '+39 000 000 0003' },
  callBackCandidates: null,
  may: { callBack: false, verify: true, refuse: true, retire: false, reveal: false },
  version: 2,
})
export const REFUSED_ACCOUNT = account(4, { masked: 'IT** **** **** 8800', ibanLast4: '8800', status: 'REFUSED', pill: 'REFUSED', source: 'PORTAL', proposedAt: at('2026-06-01'), proposedBy: { id: uid('1212', 9), name: 'Luca Prova' }, callBack: null, verified: null, activatedAt: null, refused: { at: at('2026-06-02'), by: FINANCE, reason: 'Il numero richiamato non ha confermato il cambio.' }, files: [], may: { callBack: false, verify: false, refuse: false, retire: false, reveal: false }, version: 2 })

export const bankOf = (party: Party, accounts: readonly BankAccount[], over: Partial<BankView> = {}): BankView => ({
  supplier: { id: party.id, code: party.code, name: party.tradeName ?? party.legalName, companyId: party.companyId },
  accounts: [...accounts],
  payable: accounts.filter((row) => row.status === 'ACTIVE').map((row) => ({ currency: row.currency, accountId: row.id })),
  may: { propose: true },
  ...over,
})

/** A made-up Italian test IBAN (ABI and CAB 00000, right check digits), grouped as the reveal answers. */
export const REVEALED = 'IT80 X000 0000 0000 0000 0003 456'

// ---- Quality & rating ----

export const RECEIPTS: readonly ReceiptRow[] = [
  { id: uid('4747', 1), number: 'GR-2026-0141', status: 'POSTED', purchaseOrder: { id: uid('4848', 1), number: 'PO-2026-0088' }, supplierDdtNumber: 'DDT 412', receivedAt: at('2026-11-04'), postedAt: at('2026-11-04', '11:00'), lines: 3, lots: 3, lotsReleased: 2, discrepancies: { count: 1, open: 1 } },
  { id: uid('4747', 2), number: 'GR-2026-0117', status: 'POSTED', purchaseOrder: { id: uid('4848', 2), number: 'PO-2026-0071' }, supplierDdtNumber: 'DDT 377', receivedAt: at('2026-10-15'), postedAt: at('2026-10-15', '10:00'), lines: 2, lots: 2, lotsReleased: 2, discrepancies: { count: 0, open: 0 } },
  { id: uid('4747', 3), number: 'GR-2026-0092', status: 'REVERSED', purchaseOrder: null, supplierDdtNumber: 'DDT 301', receivedAt: at('2026-09-20'), postedAt: at('2026-09-20', '09:00'), lines: 1, lots: 1, lotsReleased: 0, discrepancies: { count: 0, open: 0 } },
]

export const CLAIMS: readonly ClaimRow[] = [
  { id: uid('4949', 1), number: 'CL-2026-0012', kind: 'CLAIM', status: 'SENT', lots: [{ id: uid('5050', 1), code: 'L-2026-0441' }], materials: [{ id: uid('4701', 1), code: 'DEMO-PL-NAP12', name: 'Pelle bovina pieno fiore 1,2 mm' }], quantity: { quantity: '42.5', uom: 'FT2' }, lines: 1, returned: 0, ageDays: 6 },
  { id: uid('4949', 2), number: 'CL-2026-0007', kind: 'RETURN', status: 'CLOSED', lots: [{ id: uid('5050', 2), code: 'L-2026-0310' }], materials: [{ id: uid('4701', 2), code: 'DEMO-PL-SCAM08', name: 'Pelle scamosciata 0,8 mm' }], quantity: { quantity: '3', uom: 'HIDE' }, lines: 1, returned: 1, ageDays: 41 },
]

// ---- the list ----

export function summaryOf(rows: ReadonlyArray<{ id: string; code: string }>): DocumentsSummary {
  const counts = [
    { valid: 2, expiring: 1, expired: 1, missing: 1 },
    { valid: 1, expiring: 0, expired: 0, missing: 1 },
    { valid: 0, expiring: 0, expired: 0, missing: 2 },
    { valid: 1, expiring: 1, expired: 0, missing: 0 },
    { valid: 0, expiring: 0, expired: 0, missing: 0 },
    { valid: 1, expiring: 0, expired: 0, missing: 0 },
    { valid: 2, expiring: 2, expired: 0, missing: 0 },
    { valid: 0, expiring: 0, expired: 1, missing: 0 },
  ]
  const suppliers = rows.map((row, index) => ({ partyId: row.id, code: row.code, ...counts[index % counts.length]! }))
  return { suppliers, expiringIn30Days: suppliers.filter((row) => row.expiring > 0).length }
}

export function supplierRowsOf(rows: ReadonlyArray<{ id: string; code: string; legalName: string; tradeName: string | null; country: string; roles: readonly string[] }>): SupplierRow[] {
  return rows.map((row) => ({ id: row.id, code: row.code, name: row.tradeName ?? row.legalName, kinds: row.roles.includes('SUBCONTRACTOR') ? ['SUBCONTRACTOR'] : row.roles.includes('CARRIER') ? ['CARRIER'] : ['TANNERY'], status: 'APPROVED', country: row.country }))
}
