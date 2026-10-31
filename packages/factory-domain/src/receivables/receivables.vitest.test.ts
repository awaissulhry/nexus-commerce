import { describe, expect, it } from 'vitest'
import type { CompanyLegal } from '../documents/model'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { templateOf } from '../auth/roles/templates'
import { letterDocument, movementLabel, statementDocument } from './documents'
import { effectiveSettings, interestProblems, ladderOf, ladderProblems, numberedLadder, stepWords, switchBlockers, switchWords, type LadderStep } from './ladder'
import { addToAgeing, bucketOf, emptyAgeing, firstOpenDueDate, instalmentsOf, openInstalments, statementOf, type Movement } from './ledger'
import { RECEIVABLES_PERMISSIONS } from './permissions'
import { agreedInterest, claimNow, coveredLevel, planLadder, reachedStep, reminderByHand, type KnownReminder, type OpenInvoice } from './reminders'
import { reminderLanguageOf, reminderText } from './wording'

const LADDER: LadderStep[] = [
  { level: 1, offsetDays: -3, action: 'EMAIL', template: 'BEFORE_DUE' },
  { level: 2, offsetDays: 7, action: 'EMAIL', template: 'LATE_7' },
  { level: 3, offsetDays: 30, action: 'LETTER', template: 'LATE_30' },
]

const invoice = (id: string, dueDate: string, open: number, extra: Partial<OpenInvoice> = {}): OpenInvoice => ({
  id,
  number: `FT-${id}`,
  issueDate: '2026-09-01',
  currency: 'EUR',
  dueDateKnown: true,
  instalments: [{ dueDate, amount: open, open }],
  ...extra,
})

const reminder = (id: string, level: number, status: KnownReminder['status'], invoiceIds: string[], amountDue: number, extra: Partial<KnownReminder> = {}): KnownReminder => ({
  id,
  level,
  status,
  invoiceIds,
  amountDue,
  currency: 'EUR',
  preparedOn: '2026-10-01',
  byHand: false,
  ...extra,
})

const NONE = { mode: 'NONE' as const, agreedPct: null }

describe('the ladder and the settings', () => {
  it('reads the stored ladder leniently and checks a typed one in words', () => {
    expect(ladderOf([{ level: 1, offsetDays: -3, action: 'EMAIL', template: 'BEFORE_DUE' }, { level: 2, offsetDays: 'x', action: 'EMAIL' }, null])).toEqual([{ level: 1, offsetDays: -3, action: 'EMAIL', template: 'BEFORE_DUE' }])
    expect(ladderProblems([{ offsetDays: 7, action: 'EMAIL' }, { offsetDays: 7, action: 'LETTER' }]).map((issue) => issue.path)).toEqual(['body/ladder/1/offsetDays'])
    expect(ladderProblems([{ offsetDays: -61, action: 'FAX' }]).map((issue) => issue.path)).toEqual(['body/ladder/0/offsetDays', 'body/ladder/0/action'])
    expect(ladderProblems([{ offsetDays: 1, action: 'EMAIL', template: 'late 7' }]).map((issue) => issue.path)).toEqual(['body/ladder/0/template'])
    expect(numberedLadder([{ offsetDays: -3, action: 'EMAIL' }, { offsetDays: 10, action: 'CALL', template: 'X' }])).toEqual([
      { level: 1, offsetDays: -3, action: 'EMAIL', template: null },
      { level: 2, offsetDays: 10, action: 'CALL', template: 'X' },
    ])
    expect([stepWords(-3), stepWords(0), stepWords(7, 'it'), stepWords(-1, 'it')]).toEqual(['3 days before the due date', 'on the due date', '7 giorni di ritardo', '1 giorno prima della scadenza'])
  })

  it("the company's row wins whole, else the tenant's, else nothing; the switch needs a ladder and a decided interest rule", () => {
    const row = (id: string, companyId: string | null, remindersEnabled = false) => ({ id, companyId, version: 1, remindersEnabled, ladder: LADDER, lateInterestMode: 'UNDECIDED' as const, lateInterestAgreedPct: null, recoveryChargeAmount: null, minimumAmount: 1000 })
    expect(effectiveSettings(row('c', 'c'), row('t', null, true))).toMatchObject({ source: 'COMPANY', id: 'c', remindersEnabled: false, minimumAmount: 1000 })
    expect(effectiveSettings(null, row('t', null, true))).toMatchObject({ source: 'TENANT', remindersEnabled: true })
    expect(effectiveSettings(null, null)).toMatchObject({ source: 'NONE', ladder: [] })
    expect(switchBlockers({ ladder: [], lateInterestMode: 'UNDECIDED' })).toEqual(['NO_LADDER', 'INTEREST_UNDECIDED'])
    expect(switchBlockers({ ladder: LADDER, lateInterestMode: 'NONE' })).toEqual([])
    expect(switchWords({ remindersEnabled: false, ladder: LADDER, lateInterestMode: 'UNDECIDED' })).toContain('accountant')
    expect(interestProblems('AGREED', null)).toHaveLength(1)
    expect(interestProblems('AGREED', '0')).toHaveLength(1)
    expect(interestProblems('AGREED', '8.5')).toEqual([])
    expect(interestProblems('NONE', '8')).toHaveLength(1)
  })
})

describe('instalments, ageing and the statement', () => {
  it('takes the instalments as they are when they add up, else one on the latest due date or the invoice date', () => {
    const terms = { condition: 'TP01', installments: [{ amount: 600, dueDate: '2026-12-31' }, { amount: 400, dueDate: '2026-11-30' }] }
    expect(instalmentsOf(terms, 1000, '2026-10-01')).toEqual({ instalments: [{ dueDate: '2026-11-30', amount: 400 }, { dueDate: '2026-12-31', amount: 600 }], dueDateKnown: true })
    expect(instalmentsOf(terms, 1200, '2026-10-01')).toEqual({ instalments: [{ dueDate: '2026-12-31', amount: 1200 }], dueDateKnown: true })
    expect(instalmentsOf(null, 500, '2026-10-01')).toEqual({ instalments: [{ dueDate: '2026-10-01', amount: 500 }], dueDateKnown: false })
    const open = openInstalments([{ dueDate: '2026-11-30', amount: 400 }, { dueDate: '2026-12-31', amount: 600 }], 500)
    expect(open.map((entry) => entry.open)).toEqual([0, 500])
    expect(firstOpenDueDate(open)).toBe('2026-12-31')
  })

  it('ages by days late: due today is not late; 1–30, 31–60, 61–90, over 90', () => {
    expect([bucketOf('2026-10-30', '2026-10-30'), bucketOf('2026-10-29', '2026-10-30'), bucketOf('2026-09-30', '2026-10-30'), bucketOf('2026-08-31', '2026-10-30'), bucketOf('2026-08-01', '2026-10-30'), bucketOf('2026-07-01', '2026-10-30')]).toEqual(['NOT_DUE', 'D1_30', 'D1_30', 'D31_60', 'D61_90', 'OVER_90'])
    const totals = addToAgeing(emptyAgeing(), [{ dueDate: '2026-11-15', amount: 100, open: 100 }, { dueDate: '2026-09-15', amount: 300, open: 250 }], '2026-10-30')
    expect(totals).toEqual({ open: 350, overdue: 250, buckets: { NOT_DUE: 100, D1_30: 0, D31_60: 250, D61_90: 0, OVER_90: 0 } })
  })

  it('the statement: opening balance + invoices − payments − credits = running balance', () => {
    const movement = (kind: Movement['kind'], date: string, amount: number, reference: string): Movement => ({ kind, date, amount, reference, recordType: kind === 'PAYMENT' ? 'Payment' : kind === 'REFUND' ? 'Refund' : 'Invoice', recordId: reference, docType: kind === 'CREDIT_NOTE' ? 'TD04' : kind === 'INVOICE' ? 'TD01' : null, dueDate: null })
    const statement = statementOf(
      [movement('PAYMENT', '2026-10-05', 200, 'CRO1'), movement('INVOICE', '2026-09-01', 1000, 'FT-1'), movement('INVOICE', '2026-10-01', 500, 'FT-2'), movement('CREDIT_NOTE', '2026-10-10', 100, 'NC-1'), movement('REFUND', '2026-10-20', 50, 'TRN1'), movement('INVOICE', '2026-11-01', 999, 'FT-3')],
      '2026-10-01',
      '2026-10-31',
    )
    expect(statement.opening).toBe(1000)
    expect(statement.lines.map((line) => [line.reference, line.debit, line.credit, line.balance])).toEqual([
      ['FT-2', 500, 0, 1500],
      ['CRO1', 0, 200, 1300],
      ['NC-1', 0, 100, 1200],
      ['TRN1', 50, 0, 1250],
    ])
    expect(statement.closing).toBe(1250)
    expect(statement.totals).toEqual({ invoiced: 500, credited: 100, paid: 200, refunded: 50 })
    expect(movementLabel({ kind: 'PAYMENT', docType: null, reference: 'CRO1' }, 'it')).toBe('Pagamento ricevuto (rif. CRO1)')
    expect(movementLabel({ kind: 'INVOICE', docType: 'TD24', reference: 'FT-9' }, 'en')).toBe('Deferred invoice FT-9')
  })
})

describe('the reminder ladder', () => {
  it('reaches the highest step whose day came; covers by any reminder but a cancelled one', () => {
    expect(reachedStep(LADDER, '2026-10-30', '2026-10-26')).toBeNull()
    expect(reachedStep(LADDER, '2026-10-30', '2026-10-27')?.level).toBe(1)
    expect(reachedStep(LADDER, '2026-10-01', '2026-11-05')?.level).toBe(3)
    const reminders = [reminder('r1', 1, 'SENT', ['a'], 1), reminder('r2', 2, 'CANCELLED', ['a'], 1), reminder('r3', 2, 'SKIPPED', ['b'], 1)]
    expect([coveredLevel('a', reminders), coveredLevel('b', reminders), coveredLevel('c', reminders)]).toEqual([1, 2, 0])
  })

  it('prepares one reminder per level due when a timer fires, jumping the levels passed; timers for what comes next', () => {
    const plan = planLadder({
      ladder: LADDER,
      today: '2026-10-30',
      invoices: [invoice('a', '2026-11-01', 400), invoice('b', '2026-10-20', 600), invoice('c', '2026-09-01', 900), invoice('d', '2026-12-31', 100)],
      reminders: [],
      minimumAmount: null,
      interest: NONE,
      prepare: true,
    })
    expect(plan.cancel).toEqual([])
    expect(plan.prepare.map((entry) => [entry.level, entry.action, entry.invoiceIds, entry.amountDue, entry.oldestDueDate])).toEqual([
      [1, 'EMAIL', ['a'], 400, '2026-11-01'],
      [2, 'EMAIL', ['b'], 600, '2026-10-20'],
      [3, 'LETTER', ['c'], 900, '2026-09-01'],
    ])
    // a waits for +7 (8 Nov), b for +30 (19 Nov), c has nothing left, d for −3 (28 Dec).
    expect(plan.timers.map((timer) => [timer.invoiceId, timer.level, timer.fireOn])).toEqual([
      ['a', 2, '2026-11-08'],
      ['b', 3, '2026-11-19'],
      ['d', 1, '2026-12-28'],
    ])
  })

  it('without a firing: a timer for today where a reminder is due, nothing prepared', () => {
    const plan = planLadder({ ladder: LADDER, today: '2026-10-30', invoices: [invoice('b', '2026-10-20', 600)], reminders: [], minimumAmount: null, interest: NONE, prepare: false })
    expect(plan.prepare).toEqual([])
    expect(plan.timers.map((timer) => [timer.level, timer.fireOn])).toEqual([
      [2, '2026-10-30'],
      [3, '2026-11-19'],
    ])
  })

  it('waits while a reminder of the level is open, or under the minimum; cancels one whose claim changed', () => {
    const waiting = planLadder({
      ladder: LADDER,
      today: '2026-10-30',
      invoices: [invoice('a', '2026-10-20', 600), invoice('b', '2026-10-21', 300)],
      reminders: [reminder('r1', 2, 'PREPARED', ['a'], 600, { preparedOn: '2026-10-28' })],
      minimumAmount: null,
      interest: NONE,
      prepare: true,
    })
    expect(waiting.cancel).toEqual([])
    expect(waiting.prepare).toEqual([])
    expect(waiting.waiting).toEqual([{ invoiceId: 'b', level: 2, reason: 'OPEN_REMINDER' }])
    const small = planLadder({ ladder: LADDER, today: '2026-10-30', invoices: [invoice('a', '2026-10-20', 600)], reminders: [], minimumAmount: 1000, interest: NONE, prepare: true })
    expect(small.waiting).toEqual([{ invoiceId: 'a', level: 2, reason: 'UNDER_MINIMUM' }])
    expect(small.timers.map((timer) => timer.level)).toEqual([3])
    // 200 was paid on a since r1 asked 600: r1 is cancelled and a new level-2 reminder asks 400.
    const changed = planLadder({ ladder: LADDER, today: '2026-10-30', invoices: [invoice('a', '2026-10-20', 400)], reminders: [reminder('r1', 2, 'APPROVED', ['a'], 600, { preparedOn: '2026-10-27' })], minimumAmount: null, interest: NONE, prepare: true })
    expect(changed.cancel.map((entry) => entry.reminderId)).toEqual(['r1'])
    expect(changed.prepare.map((entry) => [entry.level, entry.amountDue])).toEqual([[2, 400]])
    // Paid in full: cancelled, nothing prepared.
    const paid = planLadder({ ladder: LADDER, today: '2026-10-30', invoices: [], reminders: [reminder('r1', 2, 'PREPARED', ['a'], 600)], minimumAmount: null, interest: NONE, prepare: true })
    expect(paid.cancel[0]!.reason).toContain('nothing it names is open')
    expect(claimNow(reminder('r1', 2, 'PREPARED', ['a'], 600, { preparedOn: '2026-10-28' }), new Map([['a', invoice('a', '2026-10-20', 600)]]), LADDER)).toBe(600)
    // Prepared by hand: all that is open, whatever the step.
    expect(claimNow(reminder('r2', 2, 'PREPARED', ['a'], 600, { byHand: true }), new Map([['a', invoice('a', '2026-12-20', 600)]]), LADDER)).toBe(600)
  })

  it('adds agreed late-payment interest per instalment late; none before the due date', () => {
    expect(agreedInterest(100_000, '8', 365)).toBe(8000)
    expect(agreedInterest(100_000, '8', 10)).toBe(219)
    expect(agreedInterest(100_000, '8', 0)).toBe(0)
    const plan = planLadder({ ladder: LADDER, today: '2026-10-30', invoices: [invoice('b', '2026-10-20', 100_000)], reminders: [], minimumAmount: null, interest: { mode: 'AGREED', agreedPct: '8' }, prepare: true })
    expect(plan.prepare[0]).toMatchObject({ amountDue: 100_000, interestAmount: 219 })
  })

  it('a reminder by hand: the next level of the chosen invoices, all that is open on them', () => {
    const planned = reminderByHand(LADDER, [invoice('a', '2026-12-31', 300), invoice('b', '2026-10-20', 200)], [reminder('r1', 1, 'SENT', ['b'], 200)], '2026-10-30', NONE)
    expect(planned).toMatchObject({ level: 2, action: 'EMAIL', invoiceIds: ['a', 'b'], amountDue: 500, offsetDays: null })
    expect(reminderByHand([], [invoice('a', '2026-12-31', 300)], [], '2026-10-30', NONE)).toBeNull()
    expect(reminderByHand(LADDER, [invoice('a', '2026-12-31', 300)], [reminder('r1', 3, 'SENT', ['a'], 300)], '2026-10-30', NONE)?.level).toBe(3)
  })
})

describe('the wording (placeholders to confirm with the accountant)', () => {
  const facts = {
    customerName: 'Cliente Uno S.r.l.',
    companyName: 'Fabbrica S.r.l.',
    currency: 'EUR',
    action: 'EMAIL' as const,
    lines: [{ number: 'FT-2026-00001', issueDate: '2026-10-01', dueDate: '2026-10-20', claimed: 41_000, daysLate: 10 }],
    amountDue: 41_000,
    interestAmount: 219,
    interestMode: 'AGREED' as const,
    recoveryChargeAmount: 4000,
    iban: 'IT60X0542811101000000123456',
  }
  it('writes the customer language, the invoices, the total, interest and the recovery charge when late', () => {
    const it_ = reminderText('LATE_7', { ...facts, language: 'it', offsetDays: 7 })
    expect(it_.subject).toBe('Sollecito di pagamento: fattura FT-2026-00001 scaduta il 20/10/2026')
    expect(it_.body).toContain('- Fattura FT-2026-00001 del 01/10/2026, scadenza 20/10/2026: € 410,00 (scaduta da 10 giorni)')
    expect(it_.body).toContain('Totale: € 410,00')
    expect(it_.body).toContain('Interessi di mora (D.Lgs. 231/2002) maturati a oggi: € 2,19')
    expect(it_.body).toContain('(art. 6 D.Lgs. 231/2002): € 40,00 per fattura')
    expect(it_.body).toContain('IBAN IT60X0542811101000000123456')
    const en = reminderText('UNKNOWN_KEY', { ...facts, language: 'en', offsetDays: -3, interestAmount: null })
    expect(en.template).toBe('GENERIC')
    expect(en.subject).toBe('Reminder: invoice FT-2026-00001 is due on 20 Oct 2026')
    expect(en.body).not.toContain('interest')
    expect(reminderText('LATE_30', { ...facts, language: 'en', offsetDays: 30, interestAmount: null, interestMode: 'STATUTORY' }).body).toContain('Late-payment interest is due on the overdue amounts under D.Lgs. 231/2002.')
    expect([reminderLanguageOf('it'), reminderLanguageOf('de'), reminderLanguageOf(null)]).toEqual(['it', 'en', 'en'])
  })
})

describe('the printed documents', () => {
  const company: CompanyLegal = {
    legalName: 'Fabbrica Esempio S.r.l.',
    address: { line1: 'Via Esempio 1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' },
    vatNumber: 'IT00000000000',
    fiscalCode: '00000000000',
    reaOffice: 'MI',
    reaNumber: '000000',
    shareCapital: '10000.00',
    currency: 'EUR',
  }
  const customer = { name: 'Cliente Uno S.r.l.', code: 'C001', address: null, vatNumber: 'IT00000000001' }
  it('the statement and the letter carry the letterhead, the lines and the totals; an incomplete company is refused', () => {
    const statement = statementOf([{ kind: 'INVOICE', date: '2026-10-01', amount: 61000, reference: 'FT-1', recordType: 'Invoice', recordId: 'i', docType: 'TD01', dueDate: '2026-11-27' }], '2026-10-01', '2026-10-31')
    const doc = statementDocument({ language: 'it', company, customer, currency: 'EUR', statement, open: emptyAgeing(), printedOn: '2026-10-31' })
    expect(doc.layout).toBe('STATEMENT/1')
    expect(doc.title).toBe('Estratto conto')
    expect(doc.table.rows[0]).toEqual(['01/10/2026', 'Fattura FT-1', '27/11/2026', '€ 610,00', '', '€ 610,00'])
    expect(doc.totals.find((total) => total.label === 'Saldo finale')?.value).toBe('€ 610,00')
    const letter = letterDocument({ language: 'en', company, customer, currency: 'EUR', level: 3, action: 'LETTER', subject: 'Second reminder', body: 'Dear customer,…', lines: [{ number: 'FT-1', issueDate: '2026-10-01', dueDate: '2026-10-01', daysLate: 30, claimed: 61000 }], amountDue: 61000, interestAmount: null, printedOn: '2026-10-31' })
    expect(letter.layout).toBe('REMINDER_LETTER/1')
    expect(letter.notes?.value).toBe('Dear customer,…')
    expect(() => statementDocument({ language: 'it', company: { ...company, vatNumber: null, address: null }, customer, currency: 'EUR', statement, open: emptyAgeing(), printedOn: '2026-10-31' })).toThrow('cannot be printed')
  })
})

describe('catalogues', () => {
  it('declares the permissions and events; finance holds all but the Owner\'s switch', () => {
    for (const name of RECEIVABLES_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    expect(FACTORY_PERMISSIONS.get('receivables.reminders.switch')?.risk).toBe('stepUp')
    const finance = templateOf('finance')!.permissions
    expect(RECEIVABLES_PERMISSIONS.filter((name) => finance.includes(name))).toEqual(['receivables.view', 'receivables.reminders.manage', 'receivables.reminders.approve', 'receivables.statements.send', 'receivables.settings.manage'])
    expect(templateOf('owner')!.permissions).toEqual(expect.arrayContaining([...RECEIVABLES_PERMISSIONS]))
    expect(templateOf('read_only')!.permissions).toContain('receivables.view')
    expect(templateOf('read_only')!.permissions).not.toContain('receivables.reminders.approve')
    // B-W2a-81: sales reads what a customer owes (the customer's Overdue), never a reminder move.
    expect(RECEIVABLES_PERMISSIONS.filter((name) => templateOf('sales')!.permissions.includes(name))).toEqual(['receivables.view'])
    for (const type of ['payment_reminder.prepared', 'payment_reminder.approved', 'payment_reminder.sent', 'payment_reminder.skipped', 'payment_reminder.cancelled', 'payment_reminder.changed', 'receivables_settings.changed', 'customer_statement.sent']) {
      expect(EVENT_CATALOGUE.find(type, 1)?.context).toBe('receivables')
    }
  })
})
