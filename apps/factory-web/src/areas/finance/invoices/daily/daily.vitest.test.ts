import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CHARGE_KINDS as DOMAIN_CHARGE_KINDS } from '@nexus/factory-domain/invoicing/charges/charges'
import { RETURN_CREDIT_SKIPS as DOMAIN_SKIPS } from '@nexus/factory-domain/invoicing/credit-note/from-return'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { depositGate } from '../../../sales/orders/model'
import { deposit, order as orderOf, SCHEDULE } from '../../../sales/orders/_demo/fixtures'
import { dayProblem, stepAbilitiesOf, stepVerbs } from '../../../sales/orders/record/schedule/model'
import { CHARGE_KINDS } from '../../_shared/api'
import { itemLabel, lineInputsOf } from '../../_shared/model'
import { canOf, OPEN_ITEMS, TD01_LINES } from '../../_demo/fixtures'
import { designScreen as invoicesScreen } from '../list/fixtures'
import { designScreen as recordScreen } from '../record/fixtures'
import { designScreen as xmlScreen } from '../xml/fixtures'
import { KNOWN_TAGS, parseXml, prettyXml, valueWordsKey, versionOf, xmlSections } from '../xml/model'
import { createDeferred, draftReturnCredit, RETURN_CREDIT_SKIPS } from './api'
import { DEFERRED, DEFERRED_LATE, DRAFT_WITH_CHARGES, OVERPAID, QUEUE_W2A, RETURN_CREDIT, RETURN_CREDITED, SAMPLE_XML } from './demo/fixtures'
import { bulkWords, carryHeld, chargeHeld, chargeProblems, ddtDeadline, deferredDdtIds, deferredHeld, deferredTile, freightWords, groupOf, monthWords, returnCreditHeld, shippedViewOf, termsSourceOf, withCharge, withoutLine } from './model'

const params = (query: string) => new URLSearchParams(query)

describe('B-W2a-80 — the enums mirror factory-domain', () => {
  it('charge kinds and the reasons a return line is left out', () => {
    expect([...CHARGE_KINDS]).toEqual([...DOMAIN_CHARGE_KINDS])
    expect([...RETURN_CREDIT_SKIPS]).toEqual([...DOMAIN_SKIPS])
  })
  it('the readable XML is a page the Office knows (a new tab of the record)', () => {
    expect(OFFICE_PAGES.has('/finance/invoices/[id]/xml')).toBe(true)
  })
})

describe('the calls send what the API’s strict bodies take', () => {
  const recorder = () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const client = {
      post: async (path: string, options: { body: unknown; schema: { parse: (value: unknown) => unknown } }) => {
        calls.push({ path, body: options.body })
        return path.endsWith('/deferred') ? { invoice: { id: 'i1' }, freight: [] } : { creditNotes: [], notCredited: [] }
      },
    }
    return { calls, client: client as unknown as Parameters<typeof createDeferred>[0] }
  }
  it('the month’s deferred invoice sends only company, customer and month (a group carries more)', async () => {
    const { calls, client } = recorder()
    await createDeferred(client, DEFERRED.groups[0]!, 'k1')
    expect(calls[0]).toEqual({ path: '/invoicing/invoices/deferred', body: { companyId: DEFERRED.groups[0]!.companyId, partyId: DEFERRED.groups[0]!.partyId, month: '2026-10' } })
  })
  it('a return’s credit notes: every line (empty body) or some lines', async () => {
    const { calls, client } = recorder()
    await draftReturnCredit(client, 'r1', null, 'k1')
    await draftReturnCredit(client, 'r1', ['l1'], 'k2')
    expect(calls.map((call) => call.body)).toEqual([{}, { lineIds: ['l1'] }])
  })
})

describe('the deferred invoices due by the 15th', () => {
  it('the tile counts the groups and says how many are due soon or late; unknown is "—"', () => {
    expect(deferredTile(null)).toEqual({ value: '—', hint: null })
    expect(deferredTile(DEFERRED)).toEqual({ value: '1', hint: { key: 'deferred.tileOpen' } })
    expect(deferredTile(DEFERRED_LATE)).toEqual({ value: '2', hint: { key: 'deferred.tileLate', params: { count: 1 } } })
    expect(deferredTile({ ...DEFERRED, counts: { groups: 0, open: 0, dueSoon: 0, late: 0 }, groups: [] })).toEqual({ value: '0', hint: null })
  })
  it('the saved filter is the address (?shipped=deferred) and keeps the DDTs a deferred invoice takes', () => {
    expect(shippedViewOf(params('shipped=deferred'))).toBe('deferred')
    expect(shippedViewOf(params(''))).toBe('all')
    const ids = deferredDdtIds(DEFERRED)
    expect([...ids]).toEqual(QUEUE_W2A.customers[1]!.ddts.map((ddt) => ddt.ddtId))
    expect(groupOf(DEFERRED, QUEUE_W2A.customers[0]!.ddts[0]!.ddtId)).toBeNull()
    expect(groupOf(DEFERRED, [...ids][0]!)?.month).toBe('2026-10')
  })
  it('the month’s deferred invoice is held without the right, and when everything of it is in a draft', () => {
    const group = DEFERRED.groups[0]!
    const ddts = QUEUE_W2A.customers[1]!.ddts
    expect(deferredHeld(group, ddts, { manageInvoices: false })?.key).toBe('deferred.held.noManage')
    expect(deferredHeld(group, ddts, { manageInvoices: true })).toBeNull()
    const inDraft = ddts.map((ddt) => ({ ...ddt, lines: ddt.lines.map((line) => ({ ...line, inDraft: line.notInvoiced })) }))
    expect(deferredHeld(group, inDraft, { manageInvoices: true })?.key).toBe('deferred.held.inDraft')
  })
  it('the bulk action says "Create deferred invoice for N DDTs of <customer>" for one customer’s deferred DDTs', () => {
    const rows = QUEUE_W2A.customers.flatMap((customer) => customer.ddts.map((ddt) => ({ ...ddt, customer })))
    const monthly = rows.filter((row) => row.partyId === QUEUE_W2A.customers[1]!.partyId)
    expect(bulkWords(monthly, DEFERRED)).toEqual({ key: 'deferred.bulk', params: { count: 2, customer: QUEUE_W2A.customers[1]!.legalName } })
    expect(bulkWords(rows, DEFERRED).key).toBe('deferred.bulkPlain')
    expect(bulkWords(rows.slice(0, 1), DEFERRED).key).toBe('deferred.bulkPlain')
  })
  it('a DDT counts down to its deadline by the customer’s preset (else W1’s rule); freight in words', () => {
    const perShipment = QUEUE_W2A.customers[0]!.ddts[0]!
    const monthly = QUEUE_W2A.customers[1]!.ddts[0]!
    expect(ddtDeadline(perShipment, null)).toMatchObject({ docType: 'TD01', dueBy: '2026-11-08' })
    expect(ddtDeadline(monthly, null)).toMatchObject({ docType: 'TD24', dueBy: '2026-11-15' })
    const late = { ...perShipment, deadline: undefined, immediate: { ...perShipment.immediate, state: 'LATE' as const, daysLeft: -2 } }
    expect(ddtDeadline(late, { docType: 'TD24', dueBy: '2026-11-15', daysLeft: 17, state: 'OPEN' })).toMatchObject({ docType: 'TD24' })
    expect(freightWords(perShipment)).toEqual({ key: 'deferred.freight.toBill', amount: 1200 })
    expect(freightWords(QUEUE_W2A.customers[1]!.ddts[1]!)).toEqual({ key: 'deferred.freight.undecided', amount: null })
    expect(freightWords({ freight: { currency: 'EUR', billed: true, amount: 1200 } })).toEqual({ key: 'deferred.freight.billed', amount: null })
    expect(freightWords({ freight: { currency: 'EUR', billed: false } })).toBeNull()
    expect(monthWords('2026-10', 'it')).toBe('ottobre 2026')
    expect(monthWords('2026-10', 'en')).toBe('October 2026')
  })
})

describe('charge lines on a draft', () => {
  it('every line goes back with its kind (W1 dropped chargeKind: the API refused the whole PUT)', () => {
    const inputs = lineInputsOf(DRAFT_WITH_CHARGES.lines, [])
    expect(inputs.filter((line) => line.kind === 'CHARGE').map((line) => (line as { chargeKind?: string }).chargeKind)).toEqual(['FREIGHT', 'PACKAGING'])
    expect(inputs.some((line) => (line.kind as string) === 'DEPOSIT_DEDUCTION')).toBe(false)
    expect(lineInputsOf(TD01_LINES, []).every((line) => !('chargeKind' in line))).toBe(true)
  })
  it('adds one charge after the stored lines, naming the invoice’s only DDT; removes one and keeps the rest', () => {
    const added = withCharge(DRAFT_WITH_CHARGES, { kind: 'SAMPLES', description: ' Campionatura ', quantity: '2', unitPrice: '17,50', ddtId: '' })
    const last = added[added.length - 1]!
    expect(last).toMatchObject({ kind: 'CHARGE', chargeKind: 'SAMPLES', description: 'Campionatura', quantity: '2', unitPrice: '17.50', ddtId: DRAFT_WITH_CHARGES.lines[0]!.ddtId })
    expect(last).not.toHaveProperty('vatRatePct')
    expect(added).toHaveLength(5)
    const removed = withoutLine(DRAFT_WITH_CHARGES, DRAFT_WITH_CHARGES.lines[2]!.id)
    expect(removed.map((line) => line.description)).not.toContain(DRAFT_WITH_CHARGES.lines[2]!.description)
    expect(removed).toHaveLength(3)
  })
  it('a typed charge’s problems; the DDT is asked only on an invoice of several', () => {
    expect(chargeProblems({ kind: '', description: '', quantity: '0', unitPrice: '', ddtId: '' }, 2)).toEqual({ kind: 'charge.problem.kind', description: 'charge.problem.description', quantity: 'charge.problem.quantity', unitPrice: 'charge.problem.price', ddt: 'charge.problem.ddt' })
    expect(chargeProblems({ kind: 'FREIGHT', description: 'Trasporto', quantity: '1', unitPrice: '12', ddtId: '' }, 1)).toEqual({})
  })
  it('held: no right, an issued invoice, a deposit invoice, a credit note from a return', () => {
    const can = { manageInvoices: true }
    expect(chargeHeld(DRAFT_WITH_CHARGES, can)).toBeNull()
    expect(chargeHeld(DRAFT_WITH_CHARGES, { manageInvoices: false })?.key).toBe('charge.held.noManage')
    expect(chargeHeld({ ...DRAFT_WITH_CHARGES, status: 'ISSUED' }, can)?.key).toBe('charge.held.issued')
    expect(chargeHeld({ ...DRAFT_WITH_CHARGES, docType: 'TD02' }, can)?.key).toBe('charge.held.deposit')
    expect(chargeHeld({ ...DRAFT_WITH_CHARGES, docType: 'TD04', lines: [{ ...DRAFT_WITH_CHARGES.lines[0]!, returnLineId: 'r1' }] }, can)?.key).toBe('charge.held.fromReturn')
  })
  it('where the due dates come from', () => {
    expect(termsSourceOf(DRAFT_WITH_CHARGES)).toEqual({ key: 'terms.source.TERMS', params: { code: 'BB30FM' } })
    expect(termsSourceOf({ paymentTerms: { installments: [], source: { kind: 'MANUAL', method: 'MP05' } } })?.key).toBe('terms.source.MANUAL')
    expect(termsSourceOf({ paymentTerms: { installments: [], source: { kind: 'ADVANCE' } } })?.key).toBe('terms.source.ADVANCE')
    expect(termsSourceOf({ paymentTerms: null })).toBeNull()
  })
})

describe('a return’s credit notes; refund or carry an over-payment', () => {
  it('create is held without the right, while reading, and when nothing is left to credit', () => {
    expect(returnCreditHeld(RETURN_CREDIT, { manageInvoices: true })).toBeNull()
    expect(returnCreditHeld(RETURN_CREDIT, { manageInvoices: false })?.key).toBe('returnCredit.held.noManage')
    expect(returnCreditHeld(null, { manageInvoices: true })?.key).toBe('returnCredit.held.reading')
    expect(returnCreditHeld(RETURN_CREDITED, { manageInvoices: true })?.key).toBe('returnCredit.held.nothing')
  })
  it('carry the credit: payments.record, a TD01/TD24, something over-paid', () => {
    expect(carryHeld(OVERPAID, { recordPayments: true })).toBeNull()
    expect(carryHeld(OVERPAID, { recordPayments: false })?.key).toBe('carry.held.noRecord')
    expect(carryHeld({ ...OVERPAID, docType: 'TD02' }, { recordPayments: true })?.key).toBe('carry.held.deposit')
    expect(carryHeld({ ...OVERPAID, refundDueAmount: 0 }, { recordPayments: true })?.key).toBe('carry.held.nothing')
  })
})

describe('B-W2a-F2 leftovers the brief named: the balance before shipping is not the deposit', () => {
  it('the production gate reads only the deposit’s request', () => {
    const balance = deposit({ id: 'balance', stepKind: 'BEFORE_SHIPPING', status: 'OPEN' })
    const paidDeposit = deposit({ status: 'PAID', paidAmount: 228384 })
    const base = orderOf('CONFIRMED')
    expect(depositGate({ depositRequired: true, chain: { ...base.chain, depositRequests: [balance] } }).state).toBe('MISSING')
    expect(depositGate({ depositRequired: true, chain: { ...base.chain, depositRequests: [balance, paidDeposit] } }).state).toBe('PAID')
  })
  it('a matcher row of the balance before shipping is named so', () => {
    expect(itemLabel({ ...OPEN_ITEMS[1]!, stepKind: 'BEFORE_SHIPPING' })).toEqual({ key: 'item.balance', params: { order: 'SO-2026-0090' } })
    expect(itemLabel(OPEN_ITEMS[1]!)).toEqual({ key: 'item.deposit', params: { order: 'SO-2026-0090' } })
  })
})

describe('the schedule card’s verbs (B-W2a-F2’s note)', () => {
  const full = stepAbilitiesOf(['orders.manage', 'invoices.manage'])
  const balance = SCHEDULE.steps.find((step) => step.kind === 'BEFORE_SHIPPING')!
  const depositStep = SCHEDULE.steps.find((step) => step.kind === 'DEPOSIT')!
  it('a before-shipping step without its request: Open for payment (a day asked when it has none); held once goods left', () => {
    expect(stepVerbs(balance, { status: 'CONFIRMED' }, full)).toEqual([{ kind: 'open', held: null, needsDay: false }])
    expect(stepVerbs({ ...balance, dueDate: null }, { status: 'IN_PRODUCTION' }, full)).toEqual([{ kind: 'open', held: null, needsDay: true }])
    expect(stepVerbs(balance, { status: 'PARTLY_SHIPPED' }, full)[0]).toMatchObject({ held: { key: 'schedule.verbs.held.goodsLeft' } })
    expect(stepVerbs(balance, { status: 'CONFIRMED' }, stepAbilitiesOf([]))[0]).toMatchObject({ held: { key: 'schedule.verbs.held.noManage' } })
  })
  it('a step with its request: Invoice this step (invoices.manage); other kinds and closed steps offer nothing', () => {
    expect(stepVerbs(depositStep, { status: 'CONFIRMED' }, full)).toEqual([{ kind: 'invoice', held: null }])
    expect(stepVerbs({ ...balance, depositRequestId: 'r1' }, { status: 'READY' }, stepAbilitiesOf(['orders.manage']))[0]).toMatchObject({ kind: 'invoice', held: { key: 'schedule.verbs.held.noInvoice' } })
    expect(stepVerbs({ ...balance, kind: 'ON_DELIVERY' }, { status: 'CONFIRMED' }, full)).toEqual([])
    expect(stepVerbs({ ...balance, status: 'CANCELLED' }, { status: 'CONFIRMED' }, full)).toEqual([])
    expect(dayProblem('2026-10-28', '2026-10-29')).toBe('schedule.verbs.problem.past')
    expect(dayProblem('2026-11-05', '2026-10-29')).toBeNull()
  })
  it('their words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['open', 'invoice', 'openTitle', 'openBody', 'openGo', 'day', 'opened', 'held.noManage', 'held.goodsLeft', 'held.noInvoice', 'held.busy', 'problem.day', 'problem.past', 'problem.moved', 'problem.state', 'problem.forbidden', 'problem.write']) expect(t(`schedule.verbs.${key}`), `${locale}: ${key}`).not.toBe(`schedule.verbs.${key}`)
    }
  })
})

describe('the legal XML shown readable', () => {
  it('reads the FatturaPA file: entities, the version, the sections a person checks', () => {
    const root = parseXml(SAMPLE_XML)
    expect(root?.name).toBe('FatturaElettronica')
    expect(versionOf(SAMPLE_XML)).toBe('FPR12')
    const sections = xmlSections(root)
    expect(sections.map((section) => section.tag)).toEqual(['DatiTrasmissione', 'CedentePrestatore', 'CessionarioCommittente', 'DatiGeneraliDocumento', 'DatiOrdineAcquisto', 'DatiDDT', 'DettaglioLinee', 'DatiRiepilogo', 'DatiPagamento'])
    const document = sections.find((section) => section.tag === 'DatiGeneraliDocumento')!
    expect(document.fields.find((field) => field.path.at(-1) === 'Causale')?.value).toBe('Fattura DDT n. 144/2026 del 27/10/2026 & acconto dedotto')
    const lines = sections.find((section) => section.tag === 'DettaglioLinee')!.tables[0]!
    expect(lines.rows).toHaveLength(3)
    expect(lines.columns.map((column) => column.at(-1))).toContain('PrezzoTotale')
    const ddt = sections.find((section) => section.tag === 'DatiDDT')!.tables[0]!
    expect(ddt.rows[0]![ddt.columns.findIndex((column) => column.at(-1) === 'RiferimentoNumeroLinea')]).toBe('1; 2')
    const payment = sections.find((section) => section.tag === 'DatiPagamento')!
    expect(payment.fields[0]).toEqual({ path: ['CondizioniPagamento'], value: 'TP02' })
    expect(payment.tables[0]!.tag).toBe('DettaglioPagamento')
    const seller = sections.find((section) => section.tag === 'CedentePrestatore')!
    expect(seller.fields.find((field) => field.path.join('/') === 'DatiAnagrafici/Anagrafica/Denominazione')?.value).toBe('Officina Demo S.r.l.')
  })
  it('refuses a file that is not well-formed (it is then shown as it is)', () => {
    expect(parseXml('<a><b></a>')).toBeNull()
    expect(parseXml('<a>')).toBeNull()
    expect(xmlSections(parseXml('<FatturaElettronica><Broken>'))).toEqual([])
  })
  it('lays the source out one element per line; value words for type, terms and the reason without VAT', () => {
    const pretty = prettyXml(SAMPLE_XML)
    expect(pretty.split('\n')).toContain('      <ProgressivoInvio>00031</ProgressivoInvio>')
    expect(valueWordsKey('TipoDocumento', 'TD01')).toEqual({ ns: 'finance', key: 'docType.TD01' })
    expect(valueWordsKey('CondizioniPagamento', 'TP02')).toEqual({ ns: 'finance-daily', key: 'xml.value.TP02' })
    expect(valueWordsKey('Natura', 'N3.2')).toEqual({ ns: 'finance', key: 'natura.N3_2' })
    expect(valueWordsKey('Natura', 'N9')).toBeNull()
  })
})

const LEFT_KEY = /\b(?:deferred|charge|terms|returnCredit|carry|refund|refunds|refundLink|costing|balance|xml|action|bank|check|col|common|credit|docType|held|invoiceStatus|item|list|live|match|money|notice|payment|payments|problem|record|recordPay|sdi|shipped|step|stepUp|tab|tile|totals|vat)\.[a-zA-Z]+(?:\.[a-zA-Z0-9_]+)*\b/
const NOT_KEYS = /\b[\w.-]+@[\w.-]+\.\w+\b|\b[\w-]+\.(?:pdf|csv|xml)\b/g
const PERMISSION = /\b(?:invoices|payments|orders|companies|integrations|paymentterms|costing)\.(?:view|manage|issue|record|void|bank|refund|method)\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every W2a design case draws in both languages with no key and no permission name on screen', () => {
  for (const screen of [invoicesScreen, recordScreen, xmlScreen] as unknown as DesignScreen<unknown>[]) {
    const cases = screen.screen === 'SCR-081-xml' ? screen.cases : screen.cases.filter((item) => item.id.startsWith('w2a-'))
    it(`${screen.screen}: ${cases.length} cases × it, en`, () => {
      expect(cases.length).toBeGreaterThan(5)
      for (const item of cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(NOT_KEYS, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html, `${screen.screen}/${item.id} (${locale}): a permission name`).not.toMatch(PERMISSION)
        }
      }
    })
  }

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['finance-daily'])['finance-daily']!)
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const kind of CHARGE_KINDS) {
        has(`charge.kind.${kind}`)
        has(`charge.words.${kind}`)
      }
      for (const code of RETURN_CREDIT_SKIPS) has(`returnCredit.skip.${code}`)
      for (const tag of KNOWN_TAGS) has(`xml.tag.${tag}`)
      for (const code of ['TP01', 'TP02', 'TP03']) has(`xml.value.${code}`)
      for (const timing of ['PER_SHIPMENT', 'MONTHLY']) has(`deferred.timing.${timing}`)
      for (const view of ['all', 'deferred']) has(`deferred.rows.${view}`)
      for (const state of ['draft', 'pending']) {
        has(`xml.none.${state}`)
        has(`xml.none.${state}Body`)
      }
      has('deferred.bulk', 2)
      has('deferred.issueBy', 2)
    }
  })

  it('the tile and the shipped list’s saved filter are on the page for every role that reads invoices', () => {
    for (const id of ['w2a-deferred', 'w2a-deferred-sales']) {
      const item = invoicesScreen.cases.find((entry) => entry.id === id)!
      const html = render(invoicesScreen as unknown as DesignScreen<unknown>, item.model, 'en')
      expect(html).toContain('Deferred invoices due by the 15th')
      expect(html).toContain('Which DDTs')
    }
    expect(canOf('sales').manageInvoices).toBe(false)
  })
})
