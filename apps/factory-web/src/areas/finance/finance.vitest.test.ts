import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CREDIT_REASONS as DOMAIN_CREDIT_REASONS } from '@nexus/factory-domain/invoicing/credit-note/credit-note'
import { INVOICE_DOC_TYPES as DOMAIN_DOC_TYPES, INVOICE_STATUSES as DOMAIN_STATUSES } from '@nexus/factory-domain/invoicing/invoices'
import { SDI_ERROR_CODES } from '@nexus/factory-domain/invoicing/sdi/errors'
import { SDI_SEND_STATUSES as DOMAIN_SEND_STATUSES } from '@nexus/factory-domain/invoicing/sdi/states'
import { SDI_NEXT_ACTIONS as DOMAIN_ACTIONS, SDI_STATE_CODES as DOMAIN_CODES } from '@nexus/factory-domain/invoicing/sdi/words'
import { ALLOCATION_TARGETS as DOMAIN_TARGETS, PAYMENT_METHODS as DOMAIN_METHODS, PAYMENT_STATUSES as DOMAIN_PAYMENT_STATUSES } from '@nexus/factory-domain/payments/payments'
import { SDI_NOTIFICATION_TYPES as DOMAIN_NOTIFICATIONS } from '@nexus/factory-domain/ports/sdi'
import { ApiError } from '../../lib/api/errors'
import type { DesignScreen } from '../../lib/design/design-screen'
import { LOCALES } from '../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { LIST_PAGES, listAddress, recordAddress, RECORD_PAGES } from '../../lib/records/record-links'
import { OFFICE_PAGES } from '../../shell/nav/office-nav'
import { ALLOCATION_TARGETS, CREDIT_REASONS, INVOICE_DOC_TYPES, INVOICE_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES, SDI_NEXT_ACTIONS, SDI_NOTIFICATION_TYPES, SDI_SEND_STATUSES, SDI_STATE_CODES } from './_shared/api'
import {
  allocationsOf,
  CHECK_CODES,
  checkOf,
  creditHeld,
  creditProblems,
  ddtHeld,
  deadlineWords,
  invoicesAddress,
  journeyOf,
  leftToPlace,
  lineInputsOf,
  lineDraftsOf,
  lineProblems,
  NATURA_WORDED,
  nextStepOf,
  parseAmount,
  paymentProblems,
  payStateOf,
  placedStateOf,
  placementProblems,
  queryFromAddress,
  ROW_VIEWS,
  SDI_ERRORS_WORDED,
  selectionHeld,
  suggestPlacement,
  suggestedType,
  vatOf,
  writeProblem,
} from './_shared/model'
import { canOf, CHECKS_FAIL, CHECKS_READY, invoice, OPEN_ITEMS, PAYMENT, PAYMENT_REVERSED, QUEUE, QUEUE_IN_DRAFT, sdi, TD01_LINES, TD02, TD04, TODAY } from './_demo/fixtures'
import { runWithStepUp } from './_shared/hooks'
import { designScreen as invoicesScreen } from './invoices/list/fixtures'
import { designScreen as invoiceScreen } from './invoices/record/fixtures'
import { designScreen as paymentsScreen } from './payments/list/fixtures'
import { designScreen as settingsScreen } from './settings/fixtures'
import { ibanProblem } from './settings/settings-model'

const params = (query: string) => new URLSearchParams(query)

describe('the enums mirror factory-domain (the screens say words for every value the API sends)', () => {
  it('invoices, SDI, credit notes and payments', () => {
    expect([...INVOICE_DOC_TYPES]).toEqual([...DOMAIN_DOC_TYPES])
    expect([...INVOICE_STATUSES]).toEqual([...DOMAIN_STATUSES])
    expect([...SDI_STATE_CODES]).toEqual([...DOMAIN_CODES])
    expect([...SDI_NEXT_ACTIONS]).toEqual([...DOMAIN_ACTIONS])
    expect([...SDI_SEND_STATUSES]).toEqual([...DOMAIN_SEND_STATUSES])
    expect([...SDI_NOTIFICATION_TYPES]).toEqual([...DOMAIN_NOTIFICATIONS])
    expect([...CREDIT_REASONS]).toEqual([...DOMAIN_CREDIT_REASONS])
    expect([...PAYMENT_STATUSES]).toEqual([...DOMAIN_PAYMENT_STATUSES])
    expect([...PAYMENT_METHODS]).toEqual([...DOMAIN_METHODS])
    expect([...ALLOCATION_TARGETS]).toEqual([...DOMAIN_TARGETS])
    // Every NS error the domain words has words here too.
    expect([...SDI_ERRORS_WORDED].sort()).toEqual(Object.keys(SDI_ERROR_CODES).sort())
  })
})

describe('the saved views and the address (the API’s own filter names: Home › Today lands here)', () => {
  it('reads ?status= and ?docType= and writes them back', () => {
    expect(queryFromAddress(params('status=REJECTED'))).toEqual({ rows: 'rejected', query: { status: 'REJECTED' } })
    expect(queryFromAddress(params('status=DRAFT'))).toEqual({ rows: 'drafts', query: { status: 'DRAFT' } })
    expect(queryFromAddress(params('docType=TD04'))).toEqual({ rows: 'creditNotes', query: { docType: 'TD04' } })
    expect(queryFromAddress(params('status=ISSUED'))).toEqual({ rows: 'custom', query: { status: 'ISSUED' } })
    expect(queryFromAddress(params('status=nonsense'))).toEqual({ rows: 'all', query: {} })
    for (const view of ROW_VIEWS) expect(queryFromAddress(params(invoicesAddress('/x', view).split('?')[1] ?? '')).rows).toBe(view)
  })

  it('an invoice and a payment open their own pages; the list routes go to the finance lists', () => {
    expect(RECORD_PAGES.Invoice).toBe('/finance/invoices/[id]')
    expect(recordAddress({ type: 'Invoice', id: 'abc' }, OFFICE_PAGES)).toBe('/finance/invoices/abc')
    expect(recordAddress({ type: 'Payment', id: 'p1' }, OFFICE_PAGES)).toBe('/finance/payments/p1')
    expect(LIST_PAGES['/invoicing/invoices']).toBe('/finance/invoices')
    expect(listAddress('/invoicing/invoices', { status: 'REJECTED' }, OFFICE_PAGES)).toBe('/finance/invoices?status=REJECTED')
    expect(listAddress('/payments', null, OFFICE_PAGES)).toBe('/finance/payments')
  })
})

describe('where an invoice stands, and its next step held with its reason', () => {
  const finance = canOf('finance')
  const sales = canOf('sales')

  it('a draft: Check and issue once the checks pass, held otherwise', () => {
    expect(nextStepOf(invoice('DRAFT'), null, finance, CHECKS_READY)).toEqual({ kind: 'issue', held: null })
    expect(nextStepOf(invoice('DRAFT'), null, finance, CHECKS_FAIL).held).toEqual({ key: 'held.checksFail', params: { count: 2 } })
    expect(nextStepOf(invoice('DRAFT'), null, finance, null).held?.key).toBe('held.checksReading')
    expect(nextStepOf(invoice('DRAFT'), null, sales, CHECKS_READY).held?.key).toBe('held.noIssue')
  })

  it('issued: send; rejected: fix and resend; failed: send again; delivered and open: record payment', () => {
    expect(nextStepOf(invoice('ISSUED'), sdi('notSent'), finance, null)).toEqual({ kind: 'send', held: null })
    expect(nextStepOf(invoice('REJECTED'), sdi('rejected'), finance, null)).toEqual({ kind: 'fix', held: null })
    expect(nextStepOf(invoice('REJECTED'), sdi('rejected'), sales, null).held?.key).toBe('held.noIssue')
    expect(nextStepOf(invoice('ERROR'), sdi('error'), finance, null)).toEqual({ kind: 'sendAgain', held: null })
    expect(nextStepOf(invoice('DELIVERED'), sdi('delivered'), finance, null)).toEqual({ kind: 'recordPayment', held: null })
    expect(nextStepOf(invoice('DELIVERED', { openAmount: 0 }), sdi('delivered'), finance, null).kind).toBeNull()
    expect(nextStepOf(TD02, sdi('delivered'), finance, null).kind).toBeNull()
  })

  it('the journey: draft → checks → issued → SDI → delivered → paid', () => {
    expect(journeyOf(invoice('DRAFT'), CHECKS_FAIL).map((step) => step.state)).toEqual(['current', 'problem', 'todo', 'todo', 'todo', 'todo'])
    expect(journeyOf(invoice('SENT'), null).map((step) => step.state)).toEqual(['done', 'done', 'done', 'current', 'todo', 'todo'])
    expect(journeyOf(invoice('REJECTED'), null)[3]!.state).toBe('problem')
    expect(journeyOf(invoice('NOT_DELIVERABLE'), null)[4]!.state).toBe('problem')
    expect(journeyOf(invoice('DELIVERED', { openAmount: 0 }), null)[5]!.state).toBe('done')
    expect(journeyOf(TD04, null)[5]!.state).toBe('skipped')
  })

  it('the payment state: unpaid, part paid, paid, overdue N days; a TD02 by its deposit; a TD04 asks nothing', () => {
    const row = { docType: 'TD01' as const, status: 'DELIVERED' as const, paidAmount: 0, openAmount: 1000, dueDate: '2026-11-20' }
    expect(payStateOf(row, TODAY)).toEqual({ state: 'UNPAID', days: 0 })
    expect(payStateOf({ ...row, paidAmount: 500 }, TODAY)?.state).toBe('PART_PAID')
    expect(payStateOf({ ...row, openAmount: 0 }, TODAY)?.state).toBe('PAID')
    expect(payStateOf({ ...row, dueDate: '2026-10-17' }, TODAY)).toEqual({ state: 'OVERDUE', days: 12 })
    expect(payStateOf({ ...row, docType: 'TD02' }, TODAY)?.state).toBe('BY_DEPOSIT')
    expect(payStateOf({ ...row, docType: 'TD04' }, TODAY)?.state).toBe('CREDIT')
    // Without the price grain the amounts are absent: no state is guessed (the column is not drawn).
    expect(payStateOf({ ...row, openAmount: undefined, paidAmount: undefined }, TODAY)).toBeNull()
  })

  it('each failed check has words and says where it is fixed', () => {
    expect(checkOf({ code: 'PARTY_WARNING', path: 'party/sdiCode' })).toEqual({ key: 'check.PARTY_WARNING', fix: 'party' })
    expect(checkOf({ code: 'SELLER', path: 'company/vatNumber' }).fix).toBe('company')
    expect(checkOf({ code: 'FATTURAPA', path: 'lines/1/description' }).fix).toBe('lines')
    expect(checkOf({ code: 'FATTURAPA', path: 'causale' }).fix).toBe('text')
    expect(checkOf({ code: 'DEDUCTION_OVER', path: 'lines/2' }).fix).toBe('deduction')
    expect(checkOf({ code: 'SERIES', path: 'numbering' }).fix).toBe('series')
    expect(checkOf({ code: 'SOMETHING_NEW', path: '' }).key).toBe('check.OTHER')
  })

  it('a credit note: only of an issued TD01/TD24/TD02, never of a rejected one; never above what is creditable', () => {
    const finance = canOf('finance')
    expect(creditHeld(invoice('DELIVERED'), finance)).toBeNull()
    expect(creditHeld(invoice('REJECTED'), finance)?.key).toBe('held.creditOfRejected')
    expect(creditHeld(invoice('DRAFT'), finance)?.key).toBe('held.creditOfDraft')
    expect(creditHeld(TD04, finance)?.key).toBe('held.creditOfCredit')
    expect(creditHeld(invoice('DELIVERED', { creditedAmount: 532896 }), finance)?.key).toBe('held.creditNothingLeft')
    expect(creditHeld(invoice('DELIVERED'), canOf('sales'))?.key).toBe('held.noManage')
    expect(creditProblems({ mode: 'amount', reason: 'PRICE_REDUCTION', text: '', amount: '61,00', picked: 0, creditedBefore: 0, creditable: 532896 })).toEqual({})
    expect(creditProblems({ mode: 'amount', reason: 'PRICE_REDUCTION', text: '', amount: '6000,00', picked: 0, creditedBefore: 0, creditable: 532896 }).amount).toBe('credit.problem.over')
    expect(creditProblems({ mode: 'full', reason: '', text: '', amount: '', picked: 0, creditedBefore: 100, creditable: 1000 })).toEqual({ reason: 'credit.problem.reason', full: 'credit.problem.fullAfterPart' })
    expect(creditProblems({ mode: 'lines', reason: 'OTHER', text: 'x', amount: '', picked: 0, creditedBefore: 0, creditable: 1 })).toEqual({ reason: 'credit.problem.text', lines: 'credit.problem.lines' })
  })

  it('a draft’s lines and a correction send back every stored field, the typed ones replaced; deductions never', () => {
    const drafts = lineDraftsOf(TD01_LINES, 'it')
    expect(drafts.map((draft) => draft.id)).toEqual([TD01_LINES[0]!.id, TD01_LINES[1]!.id])
    expect(drafts[0]).toMatchObject({ quantity: '8', unitPrice: '450' })
    const edited = drafts.map((draft, index) => (index === 1 ? { ...draft, description: 'DEMO-JKT-01 Giacca Demo - Nero, taglia 52 ', unitPrice: '430,50' } : draft))
    expect(lineProblems(edited)).toEqual({})
    const inputs = lineInputsOf(TD01_LINES, edited)
    expect(inputs).toHaveLength(2)
    expect(inputs[1]).toMatchObject({ description: 'DEMO-JKT-01 Giacca Demo - Nero, taglia 52', unitPrice: '430.50', quantity: '6', vatRatePct: '22.00', ddtId: TD01_LINES[1]!.ddtId, salesOrderLineId: TD01_LINES[1]!.salesOrderLineId, size: '52' })
    expect(lineProblems([{ ...drafts[0]!, quantity: '0' }])[drafts[0]!.id]).toBe('lines.problem.quantity')
    expect(lineProblems([{ ...drafts[0]!, discountPct: '100' }])[drafts[0]!.id]).toBe('lines.problem.discount')
  })

  it('the VAT cell: a rate, or the reason without VAT with its words', () => {
    expect(vatOf({ vatRatePct: '22.00', vatNature: null, vatLegalRef: null })).toEqual({ rate: 22, nature: null, key: null, law: null })
    expect(vatOf({ vatRatePct: '0.00', vatNature: 'N3.2', vatLegalRef: 'art. 41' })).toEqual({ rate: null, nature: 'N3.2', key: 'natura.N3_2', law: 'art. 41' })
    expect(vatOf({ vatRatePct: '0.00', vatNature: 'N6.3', vatLegalRef: 'x' }).key).toBeNull()
  })
})

describe('shipped, not invoiced: one invoice per customer and month', () => {
  const rows = QUEUE.customers.flatMap((customer) => customer.ddts)
  it('holds a selection across customers, months or DDTs already in a draft', () => {
    expect(selectionHeld([])?.key).toBe('held.noDdt')
    expect(selectionHeld([rows[0]!])).toBeNull()
    expect(selectionHeld([rows[0]!, rows[1]!])?.key).toBe('held.oneCustomer')
    expect(selectionHeld([rows[1]!, rows[2]!])).toBeNull()
    expect(selectionHeld([rows[1]!, { ...rows[2]!, date: '2026-09-30' }])?.key).toBe('held.oneMonth')
    const inDraft = QUEUE_IN_DRAFT.customers[0]!.ddts[0]!
    expect(ddtHeld(inDraft)?.key).toBe('held.ddtInDraft')
    expect(selectionHeld([inDraft])?.key).toBe('held.ddtInDraft')
  })
  it('suggests TD01 for one DDT in its 12 days, else TD24; the deadline in words', () => {
    expect(suggestedType([rows[0]!])).toBe('TD01')
    expect(suggestedType([rows[1]!, rows[2]!])).toBe('TD24')
    expect(suggestedType([rows[1]!])).toBe('TD24')
    expect(deadlineWords({ docType: 'TD01', dueBy: '2026-11-08', daysLeft: 10, state: 'OPEN' })).toEqual({ key: 'deadline.left.TD01', params: { count: 10 } })
    expect(deadlineWords({ docType: 'TD01', dueBy: '2026-10-18', daysLeft: -11, state: 'LATE' })).toEqual({ key: 'deadline.late.TD01', params: { count: 11 } })
  })
})

describe('a payment and where it goes', () => {
  it('step 1: the customer, an amount, a day not after today, a bank reference', () => {
    expect(paymentProblems({ partyId: 'p', amount: '2.000,00', receivedOn: TODAY, reference: 'cro 0000 88', today: TODAY })).toEqual({})
    expect(paymentProblems({ partyId: null, amount: '0', receivedOn: '2026-10-30', reference: '', today: TODAY })).toEqual({ party: 'recordPay.problem.party', amount: 'recordPay.problem.amount', receivedOn: 'recordPay.problem.future', reference: 'recordPay.problem.reference' })
    expect(paymentProblems({ partyId: 'p', amount: '10', receivedOn: TODAY, reference: 'CRO#1', today: TODAY }).reference).toBe('recordPay.problem.referenceChars')
    expect(parseAmount('1.250,50')).toBe(125050)
    expect(parseAmount('1250.5')).toBe(125050)
    expect(parseAmount('0,00')).toBeNull()
  })
  it('step 2: Suggest fills oldest first, never above what an item asks; what is left is exact', () => {
    expect(suggestPlacement(OPEN_ITEMS, 400000)).toEqual({ [OPEN_ITEMS[0]!.id]: 329400, [OPEN_ITEMS[1]!.id]: 70600 })
    const plan = { [OPEN_ITEMS[0]!.id]: 329400 }
    expect(leftToPlace(400000, plan)).toBe(70600)
    expect(placementProblems(OPEN_ITEMS, { [OPEN_ITEMS[0]!.id]: 400000 }, 500000).items[OPEN_ITEMS[0]!.id]).toBe('match.problem.over')
    expect(placementProblems(OPEN_ITEMS, plan, 100000).total).toBe('match.problem.tooMuch')
    expect(allocationsOf(OPEN_ITEMS, { [OPEN_ITEMS[1]!.id]: 120000, [OPEN_ITEMS[2]!.id]: 0 })).toEqual([{ depositRequestId: OPEN_ITEMS[1]!.id, amount: 120000 }])
  })
  it('placed · partly · not placed · voided; unknown without the price grain', () => {
    expect(placedStateOf(PAYMENT)).toBe('PARTLY')
    expect(placedStateOf(PAYMENT_REVERSED)).toBe('NOT_PLACED')
    expect(placedStateOf({ ...PAYMENT, unallocated: 0 })).toBe('PLACED')
    expect(placedStateOf({ ...PAYMENT, status: 'VOIDED' })).toBe('VOIDED')
    expect(placedStateOf({ status: 'RECEIVED', allocated: undefined, unallocated: undefined })).toBeNull()
  })
})

describe('the API’s errors in this app’s words; the step-up', () => {
  it('maps 409s by their path or code', () => {
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/version' }]))).toEqual({ key: 'problem.write.moved', reload: true })
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/externalRef' }]))).toEqual({ key: 'problem.write.reference', reload: false })
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/ddtIds/0' }])).key).toBe('problem.write.ddts')
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'credit', code: 'CREDIT_OVER' }])).key).toBe('problem.write.creditOver')
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'party', code: 'PARTY_BLOCKED' }])).key).toBe('problem.write.checks')
    expect(writeProblem(new ApiError('step_up', 403, 'forbidden', 'x')).key).toBe('problem.write.step_up')
    expect(writeProblem(new Error('x')).key).toBe('problem.write.internal')
  })
  it('a 403 step-up waits for the code, then runs once more', async () => {
    let calls = 0
    const work = async () => {
      calls += 1
      if (calls === 1) throw new ApiError('step_up', 403, 'forbidden', 'step up', null, [{ path: 'stepUp' }])
      return 'done'
    }
    await expect(runWithStepUp(work, async () => undefined)).resolves.toBe('done')
    expect(calls).toBe(2)
  })
  it('an IBAN is checked by its check digits', () => {
    expect(ibanProblem('IT60 X054 2811 1010 0000 0123 456')).toBeNull()
    expect(ibanProblem('IT61 X054 2811 1010 0000 0123 456')).toBe('bank.problem.ibanCheck')
    expect(ibanProblem('12345')).toBe('bank.problem.iban')
    expect(ibanProblem('')).toBeNull()
  })
})

const LEFT_KEY =
  /\b(?:action|bank|basis|bulk|check|checks|col|common|credit|creditReason|csv|deadline|delete|depositKind|details|docType|docs|fix|fromDdts|held|invoiceStatus|issue|item|journey|lines|linesDialog|list|live|match|money|natura|notice|part|pay|payRows|payTile|payment|paymentStatus|payments|placed|problem|record|recordPay|rejected|requestStatus|rows|sdi|sdiError|send|settings|shipType|shipped|step|stepUp|tab|tile|totals|vat)\.[a-zA-Z]+(?:\.[a-zA-Z0-9_]+)*\b/
// A file name, an e-mail address or a legal reference ("art. 41") is not a key.
const NOT_KEYS = /\b[\w.-]+@[\w.-]+\.\w+\b|\b[\w-]+\.(?:pdf|csv|xml)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [invoicesScreen, invoiceScreen, paymentsScreen, settingsScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(NOT_KEYS, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html, `${screen.screen}/${item.id} (${locale}): a permission name on screen`).not.toMatch(/\b(?:invoices|payments|orders|companies|integrations)\.(?:view|manage|issue|record|void|bank)\b/)
        }
      }
    })
  }

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['finance']).finance!)
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const docType of INVOICE_DOC_TYPES) has(`docType.${docType}`)
      for (const status of INVOICE_STATUSES) has(`invoiceStatus.${status}`)
      for (const code of SDI_STATE_CODES) {
        has(`sdi.state.${code}`)
        has(`sdi.explain.${code}`)
      }
      for (const action of SDI_NEXT_ACTIONS) has(`sdi.next.${action}`)
      for (const status of SDI_SEND_STATUSES) has(`sdi.send.${status}`)
      for (const type of SDI_NOTIFICATION_TYPES) has(`sdi.notification.${type}`)
      for (const code of SDI_ERRORS_WORDED) has(`sdiError.c${code}`)
      for (const code of [...CHECK_CODES, 'OTHER']) has(`check.${code}`)
      for (const code of NATURA_WORDED) has(`natura.${code.replace('.', '_')}`)
      for (const reason of CREDIT_REASONS) has(`creditReason.${reason}`)
      for (const view of ROW_VIEWS) has(`rows.${view}`)
      for (const state of ['NONE', 'BY_DEPOSIT', 'CREDIT', 'UNPAID', 'PART_PAID', 'PAID']) has(`pay.${state}`)
      has('pay.OVERDUE', 3)
      for (const state of ['PLACED', 'PARTLY', 'NOT_PLACED', 'VOIDED']) has(`placed.${state}`)
      for (const type of ['TD01', 'TD24']) {
        has(`deadline.left.${type}`, 2)
        has(`deadline.late.${type}`, 2)
      }
    }
  })
})
