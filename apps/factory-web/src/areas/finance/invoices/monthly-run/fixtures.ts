import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PARTIES, PREFIX, type Role } from '../../_demo/fixtures'
import { withoutPrices } from '../../_demo/fixtures'
import { financeCanOf } from '../test-mode/demo/fixtures'
import type { Candidates, IssuedRun, Run } from './api'
import { MonthlyRunDialog, type MonthlyRunModel } from './view/MonthlyRunDialog'

/**
 * SCR-440 — Invoices › Monthly invoice run (design finance.invoices pop:monthly-run; B-W2b-417 on B-W2b-396's API; FIN-068),
 * with made-up data only: October's customers with deferred invoicing (one in another preview, held with why), the preview —
 * one draft per customer with its totals and its CheckList (ready, held by two checks, nothing to invoice, issued) —, the
 * confirm with the month typed (Owner answer P1) and "send at once", what was issued and sent, the states (loading, failed,
 * nothing to invoice, a refusal said in the dialog) and the roles: Finance (everything) and Sales (read only, every verb held
 * with why). Every customer, DDT and amount is invented.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const [MOTO, ESEMPIO_RACING, SQUADRA] = PARTIES

const CANDIDATES: Candidates = {
  asOf: '2026-11-14',
  companyId: uid('1111', 1),
  month: '2026-10',
  customers: [
    { partyId: MOTO.id, code: MOTO.code, legalName: MOTO.name, ddts: 3, valueAmount: 1248000, freightAmount: 4500, drafts: [], deadline: { docType: 'TD24', dueBy: '2026-11-15', daysLeft: 1, state: 'DUE_SOON' }, inRunId: null },
    { partyId: ESEMPIO_RACING.id, code: ESEMPIO_RACING.code, legalName: ESEMPIO_RACING.name, ddts: 2, valueAmount: 684000, freightAmount: 0, drafts: [uid('8181', 40)], deadline: { docType: 'TD24', dueBy: '2026-11-15', daysLeft: 1, state: 'DUE_SOON' }, inRunId: null },
    { partyId: SQUADRA.id, code: SQUADRA.code, legalName: SQUADRA.name, ddts: 1, valueAmount: 132000, freightAmount: 2500, drafts: [], deadline: { docType: 'TD24', dueBy: '2026-11-15', daysLeft: 1, state: 'DUE_SOON' }, inRunId: uid('9292', 7) },
  ],
}

const RUN: Run = {
  id: uid('9393', 1),
  version: 2,
  companyId: uid('1111', 1),
  month: '2026-10',
  status: 'PREVIEW',
  issuedAt: null,
  createdAt: '2026-11-14T08:30:00.000Z',
  customers: [
    { partyId: MOTO.id, code: MOTO.code, legalName: MOTO.name, invoice: { id: uid('8181', 41), version: 1, docType: 'TD24', status: 'DRAFT', number: null, currency: 'EUR', ddts: 3, netTotal: 1252500, grossTotal: 1528050, ready: true, problems: [] } },
    { partyId: ESEMPIO_RACING.id, code: ESEMPIO_RACING.code, legalName: ESEMPIO_RACING.name, invoice: { id: uid('8181', 40), version: 3, docType: 'TD24', status: 'DRAFT', number: null, currency: 'EUR', ddts: 2, netTotal: 684000, grossTotal: 834480, ready: false, problems: [{ code: 'BUYER', path: 'buyer/sdiCode' }, { code: 'STAMP_DUTY', path: 'lines/stampDuty' }] } },
    { partyId: SQUADRA.id, code: SQUADRA.code, legalName: SQUADRA.name, invoice: null },
  ],
  counts: { customers: 3, drafts: 2, ready: 1, issued: 0 },
  can: { pick: true, issue: true, delete: true },
}

const ISSUED: IssuedRun = {
  run: { ...RUN, status: 'ISSUED', issuedAt: '2026-11-14T09:02:00.000Z', counts: { customers: 3, drafts: 1, ready: 0, issued: 1 }, can: { pick: false, issue: false, delete: false }, customers: RUN.customers.map((customer, index) => (index === 0 && customer.invoice ? { ...customer, invoice: { ...customer.invoice, status: 'SENT', number: 'FT-2026-00412' } } : customer)) },
  issued: [{ invoiceId: uid('8181', 41), number: 'FT-2026-00412', filesPending: false, sent: true, sendProblem: null }],
  held: [{ invoiceId: uid('8181', 40), partyId: ESEMPIO_RACING.id, problems: [{ code: 'BUYER', path: 'buyer/sdiCode' }] }],
}

interface RunCase {
  role: Role
  run: MonthlyRunModel
}

const base = (role: Role, over: Partial<MonthlyRunModel> = {}): RunCase => {
  const can = financeCanOf(role)
  return {
    role,
    run: {
      can,
      prefix: PREFIX,
      months: ['2026-09', '2026-10', '2026-11'],
      month: '2026-10',
      phase: 'pick',
      candidates: { value: can.price ? CANDIDATES : withoutPrices(CANDIDATES), problem: null },
      issuedRun: null,
      picked: [MOTO.id, ESEMPIO_RACING.id],
      run: null,
      skipped: 0,
      repick: false,
      send: true,
      typed: '',
      result: null,
      busy: false,
      problem: null,
      notice: null,
      ...over,
    },
  }
}

function RunDesign({ model }: { model: RunCase }) {
  return inShell('/finance/invoices', createElement(MonthlyRunDialog, { model: model.run }), model.role)
}

export const designScreen = defineDesignScreen<RunCase>({
  screen: 'SCR-440',
  title: 'Invoices › Monthly invoice run: customers with deferred invoicing, the preview per customer with its checks, issue and send',
  view: RunDesign,
  cases: [
    { id: 'pick', label: 'Finance · October: three customers, one in another preview (held with why); two picked', model: base('finance'), note: 'A draft already made by hand for the month is taken into the run.' },
    { id: 'pick-none', label: 'Finance · Nothing picked: Create preview held with why', model: base('finance', { picked: [] }) },
    { id: 'pick-issued-run', label: 'Finance · A run of October was issued already (said beside the pick)', model: base('finance', { issuedRun: { id: uid('9393', 9), version: 4, companyId: uid('1111', 1), month: '2026-10', status: 'ISSUED', customers: 4, invoices: 4, issuedAt: '2026-11-10T09:00:00.000Z' } }) },
    { id: 'pick-empty', label: 'Finance · No deferred invoice waits for September', model: base('finance', { month: '2026-09', candidates: { value: { ...CANDIDATES, month: '2026-09', customers: [] }, problem: null }, picked: [] }) },
    { id: 'pick-loading', label: 'Loading the customers', model: base('finance', { candidates: { value: null, problem: null }, picked: [] }) },
    { id: 'pick-error', label: 'The read failed (in words, Try again)', model: base('finance', { candidates: { value: null, problem: 'problem.read.unavailable' }, picked: [] }) },
    { id: 'preview', label: 'Finance · The preview: one ready, one held by two checks, one with nothing to invoice', model: base('finance', { phase: 'preview', run: RUN, skipped: 1 }) },
    { id: 'preview-none-ready', label: 'Finance · No draft passes its checks: Issue held with why', model: base('finance', { phase: 'preview', run: { ...RUN, counts: { ...RUN.counts, ready: 0 }, customers: RUN.customers.slice(1) } }) },
    { id: 'repick', label: 'Finance · Change customers of the preview (its own customers kept, the other preview’s held)', model: base('finance', { phase: 'pick', repick: true, run: RUN, picked: [MOTO.id] }) },
    { id: 'confirm', label: 'Finance · Issue and send 1 invoice: type 2026-10 (held until typed)', model: base('finance', { phase: 'confirm', run: RUN, typed: '2026-1' }) },
    { id: 'confirm-ready', label: 'Finance · The month typed: Issue and send 1 invoice (a fresh code next)', model: base('finance', { phase: 'confirm', run: RUN, typed: '2026-10' }) },
    { id: 'confirm-no-send', label: 'Finance · Issue only, send each one later', model: base('finance', { phase: 'confirm', run: RUN, typed: '2026-10', send: false }) },
    { id: 'done', label: 'Finance · Issued FT-2026-00412 and sent; one draft stayed back with its check', model: base('finance', { phase: 'done', run: ISSUED.run, result: ISSUED }) },
    { id: 'refused', label: 'Finance · Refused: a customer is in another preview of the month (said in the dialog)', model: base('finance', { problem: { key: 'finance-invoices-depth:run.problem.otherRun', reload: true } }) },
    { id: 'deleted', label: 'Finance · The preview deleted: its drafts stay drafts', model: base('finance', { notice: { key: 'run.deleted', params: { count: 2 } } }) },
    { id: 'sales', label: 'Sales · Read only: the preview’s verbs held with why (prices shown)', model: base('sales', { phase: 'preview', run: { ...RUN, can: { pick: false, issue: false, delete: false } } }) },
  ],
})
