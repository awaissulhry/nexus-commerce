import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PAYMENT } from '../../_demo/fixtures'
import { record, type PaymentsCase } from '../list/fixtures'
import { PaymentRecordView, type PaymentRecordDepth } from '../record/view/PaymentRecordView'
import { scoped } from '../riba/depth'
import type { PaymentWriteOffs, WriteOff } from '../write-off/api'
import { WriteOffCard, type WriteOffModel } from '../write-off/view/WriteOffCard'
import type { PaymentBankLine } from './api'
import { BankLineCard, type BankLineModel } from './view/BankLineCard'

/**
 * SCR-513 — a payment's record in depth (B-W2b-425; design finance.payments rec:Payment allocation match#1 "small difference
 * → write-off within tolerance", bank#1 "confidence and reasons"), made-up data only: the demo payment, a 0.04 difference
 * within a 1.00 tolerance, a bank line with a test IBAN (bank and branch 00000).
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const PERSON = { id: uid('8888', 1), name: 'Persona Finanza' }
const POSSIBLE = { kind: 'UNDERPAYMENT' as const, allocationId: uid('7171', 1), invoiceId: uid('3333', 1), number: 'FT-2026-00031', amount: 4, withinTolerance: true }
const ANSWER: PaymentWriteOffs = { paymentId: PAYMENT.id, tolerance: { amount: 100, source: 'COMPANY' }, writeOffs: [], possible: [POSSIBLE] }
const MADE: WriteOff = { id: uid('7272', 1), kind: 'UNDERPAYMENT', allocationId: POSSIBLE.allocationId, invoiceId: POSSIBLE.invoiceId, amount: 4, reason: 'ROUNDING', note: null, toleranceAmount: 100, reversalOfId: null, reversed: false, writtenOffById: PERSON.id, createdAt: '2026-10-29T10:20:00.000Z' }

const writeOff = (over: Partial<WriteOffModel> = {}): WriteOffModel => ({
  prefix: '/w/DEMO',
  can: { writeOff: true, price: true },
  currency: 'EUR',
  voided: false,
  answer: ANSWER,
  problem: null,
  people: [PERSON],
  dialog: null,
  busy: false,
  writeProblem: null,
  notice: null,
  ...over,
})

const LINE: PaymentBankLine = {
  paymentId: PAYMENT.id,
  recordedByHand: false,
  line: {
    id: uid('9292', 1),
    statementId: uid('9393', 1),
    bank: 'Banca di prova',
    accountIban: 'IT00X0000000000000000004321',
    bookedOn: '2026-10-28',
    valueOn: '2026-10-29',
    referenceText: 'BONIFICO SALDO FT 2026/00031 BOUTIQUE PROVA',
    counterpartyName: 'Boutique Prova Srl',
    counterpartyIban: 'IT00Y0000000000000000009876',
    match: { id: uid('9494', 1), confidence: 'HIGH', reasons: [{ code: 'AMOUNT_WITHIN_TOLERANCE' }, { code: 'NUMBER_IN_REFERENCE' }, { code: 'IBAN_KNOWN' }], chosenByPerson: false, acceptedAt: '2026-10-29T09:10:00.000Z', acceptedById: PERSON.id, reversedAt: null },
  },
}
const bank = (over: Partial<BankLineModel> = {}): BankLineModel => ({ value: LINE, problem: null, people: [PERSON], prefix: '/w/DEMO', ...over })

type DepthCase = { case: PaymentsCase; depth: { writeOff?: WriteOffModel; bank?: BankLineModel } }

function RecordDesign({ model }: { model: DepthCase }) {
  if (model.case.kind !== 'record') return null
  const depth: PaymentRecordDepth = {
    writeOff: model.depth.writeOff ? createElement(WriteOffCard, { model: model.depth.writeOff }) : undefined,
    bank: model.depth.bank ? createElement(BankLineCard, { model: model.depth.bank }) : undefined,
  }
  return inShell(`/finance/payments/${PAYMENT.id}`, createElement(PaymentRecordView, { model: model.case.record, depth }), model.case.role)
}

const allocation = (w: Partial<WriteOffModel> = {}): DepthCase => ({ case: record('finance', PAYMENT, { tab: 'allocation' }), depth: { writeOff: writeOff(w) } })
const bankTab = (b: Partial<BankLineModel> = {}): DepthCase => ({ case: record('finance', PAYMENT, { tab: 'bank' }), depth: { bank: bank(b) } })

export const designScreen = defineDesignScreen<DepthCase>({
  screen: 'SCR-513',
  title: 'Finance › Payments › a payment: the write-off within tolerance and the bank line\'s reasons',
  view: RecordDesign,
  cases: [
    { id: 'write-off', label: 'Finance · A 0.04 difference within the 1.00 tolerance: Write off…', model: allocation(), note: 'The WHOLE difference is written off, with a reason.' },
    { id: 'write-off-dialog', label: 'Finance · Write off with a reason', model: allocation({ dialog: { kind: 'writeOff', possible: POSSIBLE }, draft: { reason: 'ROUNDING' } }) },
    { id: 'write-off-done', label: 'Finance · Written off; take it back with a note', model: allocation({ answer: { ...ANSWER, writeOffs: [MADE], possible: [] }, notice: { key: scoped('writeOff.notice.done') } }) },
    { id: 'take-back', label: 'Finance · Take a write-off back', model: allocation({ answer: { ...ANSWER, writeOffs: [MADE], possible: [] }, dialog: { kind: 'takeBack', writeOff: MADE }, draft: { note: 'Customer paid the cents after all' } }) },
    { id: 'over-tolerance', label: 'Above the tolerance: held with why', model: allocation({ answer: { ...ANSWER, possible: [{ ...POSSIBLE, amount: 2500, withinTolerance: false }] } }) },
    { id: 'no-tolerance', label: 'No tolerance set: held with why', model: allocation({ answer: { ...ANSWER, tolerance: { amount: null, source: null }, possible: [{ ...POSSIBLE, withinTolerance: false }] } }) },
    { id: 'no-right', label: 'Without payments.writeOff: held with why', model: allocation({ can: { writeOff: false, price: true } }) },
    { id: 'write-off-error', label: 'Could not read the write-offs', model: allocation({ answer: null, problem: 'problem.read.unavailable' }) },
    { id: 'bank-high', label: 'Finance · Bank line: High, with its reasons', model: bankTab() },
    { id: 'bank-chosen', label: 'Finance · Bank line: Medium, chosen by a person', model: bankTab({ value: { ...LINE, line: { ...LINE.line!, match: { ...LINE.line!.match, confidence: 'MEDIUM', reasons: [{ code: 'NAME_MATCHES' }, { code: 'CHOSEN_BY_PERSON' }], chosenByPerson: true } } } }) },
    { id: 'bank-by-hand', label: 'A payment typed by hand: no bank line', model: bankTab({ value: { paymentId: PAYMENT.id, recordedByHand: true, line: null } }) },
    { id: 'bank-no-right', label: 'Without payments.bank.view: the line is not shown', model: bankTab({ value: { paymentId: PAYMENT.id, recordedByHand: false, line: null } }) },
    { id: 'bank-loading', label: 'Loading the bank line', model: bankTab({ value: null }) },
    { id: 'bank-error', label: 'Could not read the bank line', model: bankTab({ value: null, problem: 'problem.read.internal' }) },
  ],
})
