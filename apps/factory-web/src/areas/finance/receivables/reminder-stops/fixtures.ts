import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { scoped } from '../../payments/riba/depth'
import type { CustomerTrust, ReminderStop } from './api'
import { stopsCanOf } from './model'
import { ReminderDepthView, type ReminderDepthModel } from './view/ReminderDepthView'
import { StopsSection, type StopsSectionModel } from './view/StopsSection'

/**
 * SCR-514 — Finance › Receivables: held reminders and trusted levels (B-W2b-425; design finance.receivables sec:reminders#1
 * "Held (W2b stop rules)", #2 "Trusted levels can be automatic per customer"), made-up data only: invented customers and
 * invoices. The Reminder stops section under Reminders, and inside a reminder its stops and the customer's trusted level.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const TODAY = '2026-11-14'
const COMPANY = { id: uid('1111', 1), code: 'ALFA', name: 'Calzaturificio Esempio Srl' }
const PERSON = { id: uid('8888', 1), name: 'Persona Finanza' }
const FINANCE = stopsCanOf(['receivables.view', 'receivables.reminders.manage'])
const OWNER = stopsCanOf(['receivables.view', 'receivables.reminders.manage', 'receivables.reminders.trust'])
const READER = stopsCanOf(['receivables.view'])

const stop = (n: number, customer: string, number: string, reason: ReminderStop['reason'], over: Partial<ReminderStop> = {}): ReminderStop => ({
  id: uid('6161', n),
  company: COMPANY,
  customer: { id: uid('2222', n), code: `C-01${String(n).padStart(2, '0')}`, name: customer },
  invoice: { id: uid('3333', n), number },
  reason,
  until: null,
  note: null,
  state: 'holding',
  holdsReminders: [uid('6262', n)],
  createdAt: '2026-11-10T09:00:00.000Z',
  createdBy: PERSON,
  liftedAt: null,
  liftedBy: null,
  liftReason: null,
  can: { change: true, lift: true },
  version: 1,
  ...over,
})
const STOPS: ReminderStop[] = [
  stop(1, 'Boutique Prova Srl', 'FT-2026-00412', 'PROMISE_TO_PAY', { until: '2026-11-30', note: 'Promised by phone for the end of the month' }),
  stop(2, 'Negozio Modello Snc', 'FT-2026-00418', 'DISPUTE', { note: 'Two pairs returned damaged' }),
  stop(3, 'Pelletteria Finta Spa', 'FT-2026-00431', 'PAYMENT_PROCESSING', { holdsReminders: [] }),
  stop(4, 'Boutique Prova Srl', 'FT-2026-00380', 'CREDIT_PENDING', { state: 'lifted', liftedAt: '2026-11-12T15:00:00.000Z', liftedBy: PERSON, liftReason: 'Credit note issued', can: { change: false, lift: false }, holdsReminders: [] }),
]
const TRUST: CustomerTrust = {
  customer: { id: uid('2222', 1), code: 'C-0101', name: 'Boutique Prova Srl', version: 4 },
  level: 1,
  companies: [{ id: COMPANY.id, code: COMPANY.code, remindersEnabled: true, steps: [{ level: 1, offsetDays: 7, action: 'EMAIL' }, { level: 2, offsetDays: 21, action: 'EMAIL' }, { level: 3, offsetDays: 35, action: 'LETTER' }] }],
  mayChange: true,
}

type Case = { kind: 'stops'; model: StopsSectionModel } | { kind: 'reminder'; model: ReminderDepthModel }

const stops = (over: Partial<StopsSectionModel> = {}): Case => ({
  kind: 'stops',
  model: { prefix: '/w/ALFA', today: TODAY, can: FINANCE, state: 'holding', stops: STOPS.filter((row) => row.state === 'holding'), problem: null, updates: 0, dialog: null, busy: false, writeProblem: null, notice: null, ...over },
})
const reminder = (over: Partial<ReminderDepthModel> = {}): Case => ({
  kind: 'reminder',
  model: {
    today: TODAY,
    can: FINANCE,
    reminder: { status: 'PREPARED', invoices: [{ id: uid('3333', 1), number: 'FT-2026-00412' }, { id: uid('3333', 5), number: 'FT-2026-00440' }], trusted: { level: 1, goesByItself: true, approvedByLevel: false } },
    stops: [STOPS[0]!],
    stopsProblem: null,
    trust: { ...TRUST, mayChange: false },
    trustProblem: null,
    busy: false,
    problem: null,
    notice: null,
    ...over,
  },
})

function Design({ model }: { model: Case }) {
  return model.kind === 'stops' ? createElement(StopsSection, { model: model.model }) : createElement(ReminderDepthView, { model: model.model })
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-514',
  title: 'Finance › Receivables: held reminders (stop rules) and trusted levels',
  view: Design,
  cases: [
    { id: 'stops', label: 'Finance · Reminder stops in force', model: stops(), note: 'A promise to pay holds until its day; a stop is changed or lifted with why.' },
    { id: 'stops-all', label: 'Finance · Rows: all, a lifted one among them', model: stops({ state: 'all', stops: STOPS }) },
    { id: 'stops-selected', label: 'Finance · Rows chosen: Export N (CSV)', model: stops({ selected: [STOPS[0]!.id, STOPS[1]!.id] }) },
    { id: 'stops-lift', label: 'Finance · Lift a stop with why', model: stops({ dialog: { kind: 'lift', stop: STOPS[1]! }, draft: { reason: 'Dispute settled with the customer' } }) },
    { id: 'stops-change', label: 'Finance · Change a promise\'s day', model: stops({ dialog: { kind: 'change', stop: STOPS[0]! }, draft: { until: '2026-12-05', note: 'Promised again for 5 December' } }) },
    { id: 'stops-refused', label: 'Refused: the stop was lifted meanwhile', model: stops({ dialog: { kind: 'lift', stop: STOPS[1]! }, writeProblem: { key: scoped('refusal.stop.LIFTED'), reload: true } }) },
    { id: 'stops-reader', label: 'Read only: change and lift held with why', model: stops({ can: READER }) },
    { id: 'stops-empty', label: 'No stop in force', model: stops({ stops: [] }) },
    { id: 'stops-loading', label: 'Loading', model: stops({ stops: null }) },
    { id: 'stops-error', label: 'Could not read the stops', model: stops({ stops: null, problem: 'problem.read.unavailable' }) },
    { id: 'reminder-held', label: 'Finance · Inside a reminder: held by a promise to pay; trusted level 1', model: reminder(), note: 'The reminder is not approved or sent while the stop holds.' },
    { id: 'reminder-add', label: 'Finance · Stop reminders of an invoice', model: reminder({ stops: [], draft: { stop: { invoiceId: uid('3333', 5), reason: 'PAYMENT_PROCESSING', note: 'Transfer announced by the customer' } } }) },
    { id: 'reminder-approved-by-level', label: 'A reminder approved by its trusted level', model: reminder({ stops: [], reminder: { status: 'APPROVED', invoices: [{ id: uid('3333', 5), number: 'FT-2026-00440' }], trusted: { level: 2, goesByItself: false, approvedByLevel: true } }, trust: { ...TRUST, level: 2, mayChange: false } }) },
    { id: 'reminder-owner', label: 'Owner · Set the trusted level (a fresh code)', model: reminder({ can: OWNER, trust: TRUST, draft: { level: '2' } }) },
    { id: 'reminder-trust-error', label: 'Could not read the trusted level', model: reminder({ trust: null, trustProblem: 'problem.read.forbidden' }) },
    { id: 'reminder-loading', label: 'Loading', model: reminder({ stops: null, trust: null }) },
  ],
})
