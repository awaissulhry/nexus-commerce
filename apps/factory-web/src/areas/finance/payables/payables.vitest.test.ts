import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LINE_KINDS as DOMAIN_LINE_KINDS, MATCH_STATUSES as DOMAIN_MATCH } from '@nexus/factory-domain/payables/match'
import { approvalProblems, INVOICE_SOURCES as DOMAIN_SOURCES, INVOICE_STATUSES as DOMAIN_STATUSES, TILES as DOMAIN_TILES } from '@nexus/factory-domain/payables/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { RECORD_TABS as PO_TABS } from '../../purchasing/orders/model'
import { INVOICE_SOURCES, INVOICE_STATUSES, LINE_KINDS, MATCH_STATUSES, TILES, VERDICTS } from './api'
import { asSeenBy, CANDIDATES, COUNTS, DETAIL_0412, DETAIL_0420, ROWS, XML_0412 } from './demo/fixtures'
import { designScreen as listScreen } from './fixtures'
import {
  actionHeld,
  addressOf,
  amountOf,
  APPROVAL_CODES,
  decimalOf,
  foreignProblems,
  EMPTY_FOREIGN,
  liveTouches,
  mappingInputOf,
  mappingOptions,
  mappingValue,
  payablesCanOf,
  payablesHref,
  payProblem,
  queryOf,
  recordTouched,
  REFUSAL_CODES,
  refusalPhrase,
  refusalsOf,
  rowHeld,
  tabOf,
  tilesOf,
  unmappedLines,
  writeProblem,
} from './model'
import { designScreen as poScreen } from './po-tab/fixtures'
import { designScreen as recordScreen } from './record/fixtures'
import { maskIban } from './record/view/RecordTabs'
import { designScreen as xmlScreen } from './xml/fixtures'

/**
 * Finance › Supplier invoices (SCR-153 list, record and XML tab) and the PO studio's Invoices tab (B-W2a-81 on B-W2a-62's
 * API): the lists equal factory-domain's, the pure rules (who may do what, the address ⇄ the API's query, the tiles, which
 * rows a bulk approval takes, a line's mapping as a Combobox value and back, the API's refusals in words, the dialogs'
 * checks), the costs hidden without the cost grain, and every design case drawn in Italian and English with no key or
 * placeholder left on screen and no permission name.
 */

describe('the lists mirror factory-domain', () => {
  it('statuses, sources, tiles, match statuses, line kinds; the approval codes are the domain rule’s', () => {
    expect(INVOICE_STATUSES).toEqual(DOMAIN_STATUSES)
    expect(INVOICE_SOURCES).toEqual(DOMAIN_SOURCES)
    expect(TILES).toEqual(DOMAIN_TILES)
    expect(MATCH_STATUSES).toEqual(DOMAIN_MATCH)
    expect(LINE_KINDS).toEqual(DOMAIN_LINE_KINDS)
    const every = approvalProblems(
      { number: 'X', status: 'APPROVED', source: 'SDI', kind: 'INVOICE', matchStatus: 'PENDING', createdById: 'me', xmlFileId: null, unaccepted: 2, linesNet: 10_000, netTotal: 1, lines: 0 },
      'me',
    )
    for (const problem of every) expect(APPROVAL_CODES as readonly string[]).toContain(problem.code)
    expect(new Set(REFUSAL_CODES).size).toBe(REFUSAL_CODES.length)
  })
})

describe('who may do what', () => {
  it('finance does everything; a buyer maps and accepts, never approves or pays; a reader sees no amount', () => {
    expect(payablesCanOf(['payables.view', 'payables.manage', 'payables.differences.accept', 'payables.approve', 'payables.pay', 'money.cost'])).toMatchObject({
      view: true,
      manage: true,
      accept: true,
      approve: true,
      pay: true,
      cost: true,
    })
    expect(payablesCanOf(['payables.view', 'payables.manage', 'payables.differences.accept', 'money.cost'])).toMatchObject({ approve: false, pay: false, accept: true })
    expect(payablesCanOf(['payables.view'])).toMatchObject({ view: true, cost: false, manage: false })
  })

  it('the API drops every cost for a reader without the grain (the fixtures do as the API)', () => {
    const blind = asSeenBy(DETAIL_0412, { cost: false })
    expect(blind.netTotal).toBeUndefined()
    expect(blind.lines[0]!.unitPrice).toBeUndefined()
    expect(blind.matches[0]!.orderedUnitPrice).toBeUndefined()
    expect(blind.matches[0]!.words.en).not.toMatch(/\d/)
    expect(asSeenBy(XML_0412, { cost: false }).xml).toBeUndefined()
  })
})

describe('the address and the tiles', () => {
  it('reads the tile, the search and the Add dialog; ignores what is not one', () => {
    expect(addressOf(new URLSearchParams('tile=DIFFERENCES&q=0412&new=1'))).toEqual({ tile: 'DIFFERENCES', q: '0412', adding: true })
    expect(addressOf(new URLSearchParams('tile=SOMETHING'))).toEqual({ tile: null, q: null, adding: false })
    expect(payablesHref('/w/DEMO', { tile: 'TO_APPROVE', q: null, adding: false })).toBe('/w/DEMO/finance/payables?tile=TO_APPROVE')
    expect(queryOf({ tile: 'DUE_THIS_WEEK', q: 'conc', adding: false }, 'c1', 'cur')).toEqual({ companyId: 'c1', tile: 'DUE_THIS_WEEK', q: 'conc', cursor: 'cur', limit: 50 })
  })

  it('tiles in the design’s order; unknown counts are null (drawn —), never 0', () => {
    expect(tilesOf(COUNTS).map((tile) => [tile.id, tile.count])).toEqual([
      ['NEW_FROM_SDI', 3],
      ['DIFFERENCES', 1],
      ['TO_APPROVE', 2],
      ['DUE_THIS_WEEK', 1],
    ])
    expect(tilesOf(null).every((tile) => tile.count === null)).toBe(true)
  })

  it('a bulk approval takes only received invoices; the others carry their reason', () => {
    expect(ROWS.filter((row) => rowHeld(row) === null).map((row) => row.status)).toEqual(['RECEIVED', 'RECEIVED', 'RECEIVED', 'RECEIVED', 'RECEIVED'])
    expect(rowHeld({ status: 'PAID' })).toBe('held.row.PAID')
  })

  it('the record’s tabs; the PO studio has Invoices after Receipts (the design’s order)', () => {
    expect(tabOf('match')).toBe('match')
    expect(tabOf('nope')).toBe('lines')
    expect(PO_TABS).toEqual(['lines', 'answer', 'receipts', 'invoices', 'documents', 'activity'])
  })
})

describe('a line’s mapping', () => {
  it('is a Combobox value and back: a PO line, a subcontract order, a service, a charge', () => {
    const line = DETAIL_0412.lines[0]!
    expect(mappingValue(line)).toBe(`pol:${line.purchaseOrderLine!.id}`)
    expect(mappingValue(DETAIL_0420.lines[0]!)).toBe('')
    expect(mappingInputOf('pol:abc')).toEqual({ purchaseOrderLineId: 'abc' })
    expect(mappingInputOf('sco:abc')).toEqual({ subcontractOrderId: 'abc' })
    expect(mappingInputOf('kind:SERVICE')).toEqual({ kind: 'SERVICE', purchaseOrderLineId: null, subcontractOrderId: null })
    expect(mappingInputOf('kind:GOODS')).toBeNull()
    expect(mappingInputOf('')).toBeNull()
    const words = { poLine: (o: string, s: number) => `${o}/${s}`, subcontract: (o: string) => o, service: 'S', charge: 'C' }
    expect(mappingOptions(CANDIDATES, DETAIL_0420.lines[0]!, words).map((option) => option.label)).toEqual(['PO-2026-0101/10', 'PO-2026-0101/20', 'S', 'C'])
    // The line's own order stays offered while the candidates are not read.
    expect(mappingOptions(null, line, words)[0]!.value).toBe(`pol:${line.purchaseOrderLine!.id}`)
    expect(unmappedLines(DETAIL_0420)).toBe(1)
    expect(unmappedLines(DETAIL_0412)).toBe(0)
  })
})

describe('the API in our words', () => {
  const refused = (codes: string[]) =>
    new ApiError(
      'conflict',
      409,
      'conflict',
      'x',
      null,
      codes.map((code) => ({ path: `refusal/${code}`, message: 'English' })),
    )
  it('a refusal by its code; an unknown code a general sentence; never the API’s English', () => {
    expect(refusalsOf(refused(['OWN_INVOICE', 'DIFFERENCES']))).toEqual(['OWN_INVOICE', 'DIFFERENCES'])
    expect(refusalPhrase('OWN_INVOICE')).toEqual({ key: 'refusal.OWN_INVOICE' })
    expect(refusalPhrase('SOMETHING_NEW')).toEqual({ key: 'refusal.other' })
    expect(writeProblem(refused(['FROM_SDI']))).toEqual({ phrases: [{ key: 'refusal.FROM_SDI' }], reload: true })
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/version', message: 'moved' }]))).toEqual({ phrases: [{ key: 'problem.write.moved' }], reload: true })
    expect(writeProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/paidOn', message: 'future' }])).phrases).toEqual([{ key: 'problem.write.paidOn' }])
    expect(writeProblem(new Error('x'))).toEqual({ phrases: [{ key: 'problem.write.internal' }], reload: false })
  })

  it('held actions follow the API’s actions, in our words', () => {
    expect(actionHeld(DETAIL_0412, 'edit')).toEqual({ key: 'held.editSdi' })
    expect(actionHeld(DETAIL_0412, 'map')).toBeNull()
    expect(actionHeld(DETAIL_0412, 'pay')).toEqual({ key: 'held.pay' })
  })

  it('live: supplier-invoice events touch the page; the record reads again for its own id or a receipt', () => {
    expect(liveTouches({ type: 'supplier_invoice.matched' })).toBe(true)
    expect(liveTouches({ type: 'invoice.issued' })).toBe(false)
    expect(recordTouched({ type: 'supplier_invoice.approved', fields: { supplierInvoiceId: 'a' } }, 'a')).toBe(true)
    expect(recordTouched({ type: 'supplier_invoice.approved', fields: { supplierInvoiceId: 'b' } }, 'a')).toBe(false)
    expect(recordTouched({ type: 'inventory.receipt_posted', fields: {} }, 'a')).toBe(true)
  })
})

describe('the dialogs’ checks', () => {
  it('Mark paid: a day from the invoice’s to today, a reference', () => {
    expect(payProblem({ paidOn: '2026-10-31', paymentRef: 'CRO' }, { issueDate: '2026-10-02' }, '2026-10-30')).toBe('pay.problem.future')
    expect(payProblem({ paidOn: '2026-10-01', paymentRef: 'CRO' }, { issueDate: '2026-10-02' }, '2026-10-30')).toBe('pay.problem.beforeIssue')
    expect(payProblem({ paidOn: '2026-10-30', paymentRef: ' ' }, { issueDate: '2026-10-02' }, '2026-10-30')).toBe('pay.problem.ref')
    expect(payProblem({ paidOn: '2026-10-30', paymentRef: 'CRO 1' }, { issueDate: '2026-10-02' }, '2026-10-30')).toBeNull()
  })

  it('amounts and decimals in either language’s way', () => {
    expect(amountOf('1.250,50')).toBe(125_050)
    expect(amountOf('1250.5')).toBe(125_050)
    expect(amountOf('0')).toBeNull()
    expect(amountOf('0', true)).toBe(0)
    expect(decimalOf('12,5')).toBe('12.5')
    expect(decimalOf('0')).toBeNull()
  })

  it('Add foreign invoice: what is missing; an Italian supplier comes through SDI', () => {
    expect(foreignProblems(EMPTY_FOREIGN, '2026-10-30')).toContain('foreign.problem.supplier')
    const filled = {
      ...EMPTY_FOREIGN,
      partyId: 'p',
      country: 'DE',
      number: 'DE-1',
      issueDate: '2026-10-28',
      description: 'x',
      net: '100',
      vat: '0',
      vatRate: '0',
      vatNature: 'N2.1',
      fileName: 'a.pdf',
    }
    expect(foreignProblems(filled, '2026-10-30')).toEqual([])
    expect(foreignProblems({ ...filled, country: 'IT' }, '2026-10-30')).toEqual(['refusal.COMES_THROUGH_SDI'])
    expect(foreignProblems({ ...filled, vatNature: '' }, '2026-10-30')).toEqual(['foreign.problem.vatNature'])
  })

  it('an IBAN shown masked', () => {
    expect(maskIban('IT60X0542811101000000123456')).toBe('IT60 •••• 3456')
  })
})

const LEFT_KEY =
  /\b(?:noAccess|common|live|band|held|tile|filter|list|col|row|kind|source|status|match|verdict|bulk|pickup|keys|foreign|record|tab|lines|approval|payment|dialog|pay|notice|refusal|problem|xml|po)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const PERMISSION = /\b(?:payables|money|files|purchasing)\.[a-z]+(?:\.[a-z]+)?\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key, placeholder or permission name on screen', () => {
  for (const screen of [listScreen, recordScreen, xmlScreen, poScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(120)
          const text = html.replace(/<[^>]+>/g, ' ')
          expect(text.match(LEFT_KEY)?.[0] ?? null, `${screen.screen} ${item.id} (${locale})`).toBeNull()
          expect(text.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen} ${item.id} (${locale}) placeholder`).toBeNull()
          expect(text.match(PERMISSION)?.[0] ?? null, `${screen.screen} ${item.id} (${locale}) permission`).toBeNull()
        }
      }
    })
  }

  it('without the cost grain: no amount on the record, no XML text (the grid’s cells draw in the browser only)', () => {
    const record = recordScreen as unknown as DesignScreen<unknown>
    const blind = render(record, recordScreen.cases.find((entry) => entry.id === 'lines-readonly')!.model, 'en')
    expect(blind).not.toContain('€')
    expect(blind).toContain('your role does not see purchase costs')
    const finance = render(record, recordScreen.cases.find((entry) => entry.id === 'lines')!.model, 'en')
    expect(finance).toContain('€569.13')
    const xml = render(xmlScreen as unknown as DesignScreen<unknown>, xmlScreen.cases.find((entry) => entry.id === 'no-cost')!.model, 'en')
    expect(xml).not.toContain('PrezzoUnitario')
    expect(xml).toContain('holds the prices')
  })

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['finance-payables'])['finance-payables']!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const status of INVOICE_STATUSES) {
        has(`status.${status}`)
        has(`held.row.${status}`)
      }
      for (const source of INVOICE_SOURCES) has(`source.${source}`)
      for (const status of MATCH_STATUSES) has(`match.${status}`)
      for (const tile of TILES) {
        has(`tile.${tile}`)
        has(`tile.${tile}Hint`)
      }
      for (const kind of LINE_KINDS) has(`kind.line.${kind}`)
      for (const verdict of VERDICTS) has(`verdict.${verdict}`)
      for (const code of [...REFUSAL_CODES, 'other']) has(`refusal.${code}`)
      for (const action of ['edit', 'editSdi', 'map', 'dispute', 'reopen', 'withdraw', 'pay', 'void', 'voidSdi']) has(`held.${action}`)
      for (const tab of ['lines', 'match', 'approval', 'payment', 'activity']) has(`tab.${tab}`)
      for (const state of ['connecting', 'live', 'offline']) has(`live.${state}`)
      for (const kind of ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'internal']) has(`problem.read.${kind}`)
      for (const kind of ['moved', 'state', 'invalid', 'paidOn', 'mapping', 'lines', 'signed_out', 'forbidden', 'not_found', 'rate_limited', 'unavailable', 'internal']) has(`problem.write.${kind}`)
      for (const dialog of ['dispute', 'withdraw', 'reopen', 'void']) for (const part of ['title', 'body', 'confirm']) has(`dialog.${dialog}.${part}`, { number: 'X' })
      has('row.toCheck', { count: 2 })
      has('list.count', { count: 1, total: 3 })
    }
  })
})
