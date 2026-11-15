import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { CollectionsSettings, RibaBatch, RibaBatchRow, RibaCandidates, RibaItem } from './api'
import { scoped } from './depth'
import { RibaDialog, type RibaDialogModel } from './view/RibaDialog'

/**
 * SCR-510 — the Ri.Ba. batch (B-W2b-425, design finance.payments pop:riba), made-up data only: three invented customers,
 * test bank codes 00000, a test IBAN of the collecting account. Every case of the pop-up: the window and its instalments,
 * a draft with a customer whose bank is not known, the file made, the bank's report, the Owner's switch off.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const TODAY = '2026-11-14'
const COMPANY = { id: uid('1111', 1), code: 'ALFA', name: 'Calzaturificio Esempio Srl' }
const C1 = { id: uid('2222', 1), code: 'C-0101', name: 'Boutique Prova Srl' }
const C2 = { id: uid('2222', 2), code: 'C-0102', name: 'Negozio Modello Snc' }
const C3 = { id: uid('2222', 3), code: 'C-0103', name: 'Pelletteria Finta Spa' }
const BANK = { abi: '00000', cab: '00000', name: 'Banca di prova', source: 'INVOICE' as const }

const CANDIDATES: RibaCandidates = {
  companyId: COMPANY.id,
  dueFrom: TODAY,
  dueTo: '2026-12-14',
  count: 3,
  total: 482050,
  candidates: [
    { invoice: { id: uid('3333', 1), number: 'FT-2026-00412', issueDate: '2026-10-01' }, customer: C1, instalment: 1, dueDate: '2026-11-30', instalmentAmount: 183000, amount: 183000, currency: 'EUR', debtorBank: BANK, held: null },
    { invoice: { id: uid('3333', 2), number: 'FT-2026-00418', issueDate: '2026-10-03' }, customer: C2, instalment: 2, dueDate: '2026-11-30', instalmentAmount: 120050, amount: 120050, currency: 'EUR', debtorBank: null, held: null },
    { invoice: { id: uid('3333', 3), number: 'FT-2026-00431', issueDate: '2026-10-10' }, customer: C3, instalment: 1, dueDate: '2026-12-10', instalmentAmount: 179000, amount: 179000, currency: 'EUR', debtorBank: { ...BANK, source: 'BANK_LINE' }, held: null },
    { invoice: { id: uid('3333', 4), number: 'FT-2026-00402', issueDate: '2026-09-28' }, customer: C1, instalment: 2, dueDate: '2026-12-05', instalmentAmount: 90000, amount: 90000, currency: 'EUR', debtorBank: BANK, held: { code: 'IN_ANOTHER_BATCH' } },
  ],
}

const item = (n: number, customer: typeof C1, number: string, amount: number, over: Partial<RibaItem> = {}): RibaItem => ({
  id: uid('4444', n),
  invoice: { id: uid('3333', n), number, issueDate: '2026-10-01' },
  customer,
  instalment: 1,
  dueDate: '2026-11-30',
  amount,
  status: 'ISSUED',
  settledOn: null,
  unpaidFee: null,
  paymentId: null,
  invoiceOpen: amount,
  debtorBank: BANK,
  version: 1,
  ...over,
})

const DRAFT: RibaBatch = {
  id: uid('5555', 1),
  company: COMPANY,
  bankAccount: { id: uid('6666', 1), iban: 'IT00X0000000000000000004321', bankName: 'Banca di prova', active: true },
  dueFrom: TODAY,
  dueTo: '2026-12-14',
  status: 'DRAFT',
  note: null,
  items: [item(1, C1, 'FT-2026-00412', 183000), item(2, C2, 'FT-2026-00418', 120050, { debtorBank: null }), item(3, C3, 'FT-2026-00431', 179000, { dueDate: '2026-12-10' })],
  count: 3,
  total: 482050,
  currency: 'EUR',
  file: null,
  issuedAt: null,
  issuedBy: null,
  cancelledAt: null,
  cancelReason: null,
  settled: { paid: 0, unpaid: 0, waiting: 3 },
  switchOn: true,
  can: { pick: true, issue: true, cancel: true, settle: false },
  createdAt: '2026-11-14T08:30:00.000Z',
  version: 1,
}
export const RIBA_ISSUED: RibaBatch = {
  ...DRAFT,
  status: 'ISSUED',
  items: DRAFT.items.map((entry) => ({ ...entry, debtorBank: entry.debtorBank ?? { ...BANK, source: 'GIVEN' as const } })),
  file: { id: uid('7777', 1), name: 'RIBA-ALFA-20261114-0190f0e2.txt', sizeBytes: 3256 },
  issuedAt: '2026-11-14T09:02:00.000Z',
  issuedBy: { id: uid('8888', 1), name: 'Persona Finanza' },
  can: { pick: false, issue: false, cancel: false, settle: true },
  version: 2,
}
const SETTLED: RibaBatch = {
  ...RIBA_ISSUED,
  items: [
    { ...RIBA_ISSUED.items[0]!, status: 'PAID', settledOn: '2026-12-01', paymentId: uid('9999', 1), invoiceOpen: 0 },
    { ...RIBA_ISSUED.items[1]!, status: 'UNPAID', settledOn: '2026-12-02', unpaidFee: 350 },
    RIBA_ISSUED.items[2]!,
  ],
  settled: { paid: 1, unpaid: 1, waiting: 1 },
}
const BATCHES: RibaBatchRow[] = [
  { id: uid('5555', 2), company: COMPANY, dueFrom: '2026-10-14', dueTo: '2026-11-13', status: 'ISSUED', count: 5, total: 612000, fileId: uid('7777', 2), issuedAt: '2026-10-14T09:00:00.000Z', settled: { paid: 4, unpaid: 1, waiting: 0 }, createdAt: '2026-10-14T08:00:00.000Z' },
  { id: uid('5555', 3), company: COMPANY, dueFrom: '2026-09-14', dueTo: '2026-10-13', status: 'CANCELLED', count: 2, total: 98000, fileId: null, issuedAt: null, settled: { paid: 0, unpaid: 0, waiting: 0 }, createdAt: '2026-09-14T08:00:00.000Z' },
]
const ON: CollectionsSettings = { companyId: COMPANY.id, source: 'COMPANY', settingsId: uid('1212', 1), version: 3, ribaOn: true, paymentNoticeToCustomerOn: false, mayChange: true }
const OFF: CollectionsSettings = { ...ON, ribaOn: false }

const FINANCE = { view: true, manage: true, record: true, price: true, switchRiba: false }
const OWNER = { ...FINANCE, switchRiba: true }
const START = { kind: 'start' as const, batches: BATCHES, batchesProblem: null, candidates: CANDIDATES, candidatesProblem: null, reading: false, window: { dueFrom: TODAY, dueTo: '2026-12-14' }, picked: null, repick: null }

const model = (over: Partial<RibaDialogModel> = {}): RibaDialogModel => ({
  prefix: '/w/ALFA',
  today: TODAY,
  can: FINANCE,
  stage: START,
  collections: ON,
  busy: false,
  problem: null,
  notice: null,
  sia: 'A1B2C',
  ...over,
})

const withoutPrices = (batch: RibaBatch): RibaBatch => ({ ...batch, total: undefined, items: batch.items.map((entry) => ({ ...entry, amount: undefined, invoiceOpen: undefined, unpaidFee: undefined })) })

export const designScreen = defineDesignScreen<RibaDialogModel>({
  screen: 'SCR-510',
  title: 'Finance › Payments › Ri.Ba. batch',
  view: RibaDialog,
  cases: [
    { id: 'start', label: 'Finance · The window\'s instalments, one already in a batch', model: model(), note: 'Instalments paid by Ri.Ba. due in the window; the free ones picked; the total in view.' },
    { id: 'start-loading', label: 'Loading', model: model({ stage: { ...START, batches: null, candidates: null, reading: true } }) },
    { id: 'start-empty', label: 'Nothing due by Ri.Ba. in the window', model: model({ stage: { ...START, candidates: { ...CANDIDATES, candidates: [], count: 0, total: 0 } } }) },
    { id: 'start-error', label: 'Could not read the instalments', model: model({ stage: { ...START, candidates: null, candidatesProblem: 'problem.read.unavailable' } }) },
    { id: 'start-window', label: 'Refused: a window longer than a year', model: model({ stage: { ...START, window: { dueFrom: TODAY, dueTo: '2027-12-31' }, candidates: null } }) },
    { id: 'draft', label: 'Draft: the SIA code, and the bank of a customer to type', model: model({ stage: { kind: 'batch', batch: DRAFT, problem: null } }), note: 'The file asks ABI and CAB of the customer whose bank is not known (test codes 00000).' },
    { id: 'draft-bank-typed', label: 'Draft: the bank typed, ready to make the file', model: model({ stage: { kind: 'batch', batch: DRAFT, problem: null }, draft: { banks: { [C2.id]: { abi: '00000', cab: '00000' } } } }) },
    { id: 'draft-refused', label: 'Refused: the file names a customer without bank', model: model({ stage: { kind: 'batch', batch: DRAFT, problem: null }, problem: { key: scoped('refusalItem.riba.NO_DEBTOR_BANK'), params: { invoice: 'FT-2026-00418', customer: C2.name }, reload: false, banksFor: [C2.id] } }) },
    { id: 'switched-off', label: 'The Owner\'s Ri.Ba. switch is off: the file waits', model: model({ stage: { kind: 'batch', batch: { ...DRAFT, switchOn: false }, problem: null }, collections: OFF }), note: 'A finance person sees why; only the Owner turns it on.' },
    { id: 'switch', label: 'The Owner turns Ri.Ba. on (a tick, then a fresh code)', model: model({ can: OWNER, collections: OFF, stage: { kind: 'switch', from: START }, draft: { tick: true } }) },
    { id: 'issued', label: 'File made: download it for the bank', model: model({ stage: { kind: 'batch', batch: RIBA_ISSUED, problem: null }, notice: { key: scoped('riba.notice.issued'), params: { name: 'RIBA-ALFA-20261114-0190f0e2.txt' } } }) },
    { id: 'settle', label: 'The bank\'s report: one paid, one back unpaid with its fee', model: model({ stage: { kind: 'batch', batch: RIBA_ISSUED, problem: null }, draft: { settle: { [RIBA_ISSUED.items[0]!.id]: { status: 'PAID', settledOn: '2026-12-01', fee: '' }, [RIBA_ISSUED.items[1]!.id]: { status: 'UNPAID', settledOn: '2026-12-02', fee: '3,50' } } } }) },
    { id: 'settled', label: 'Settled: paid, unpaid, one still waiting', model: model({ stage: { kind: 'batch', batch: SETTLED, problem: null } }) },
    { id: 'cancel', label: 'Cancel a draft with why', model: model({ stage: { kind: 'cancel', batch: DRAFT }, draft: { reason: 'Window chosen by mistake' } }) },
    { id: 'reader', label: 'Read only (receivables.view only)', model: model({ can: { view: true, manage: false, record: false, price: true, switchRiba: false }, stage: { kind: 'batch', batch: { ...DRAFT, can: { pick: false, issue: false, cancel: false, settle: false } }, problem: null } }) },
    { id: 'no-price', label: 'Without the price grain', model: model({ can: { ...FINANCE, price: false }, stage: { kind: 'batch', batch: withoutPrices(RIBA_ISSUED), problem: null } }), note: 'No amount and no total: the columns are not drawn.' },
    { id: 'batch-error', label: 'Could not read the batch', model: model({ stage: { kind: 'batch', batch: null, problem: 'problem.read.not_found' } }) },
  ],
})
