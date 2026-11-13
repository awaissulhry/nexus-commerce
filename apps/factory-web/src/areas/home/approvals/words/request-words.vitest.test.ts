import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { designScreen } from '../fixtures'
import { subjectAddress } from '../subject-links/subject-link'
import { requestName, requestWords, saidIn } from './request-words'

/**
 * B-W2b-382 (follow-ups XF7:01, XF7:02, after B-W2b-377): Home › Approvals says every request of the approval engine in words
 * from its codes — rows, the review, the notice after a decision, Approve N, the conversation's title — never the API's
 * English `summary`; a subject with no page opens its parent's page, also when the review is opened alone.
 */

const it_ = (key: string, params: Record<string, string | number> = {}) => (key === 'row.task' ? `${params.kind}: ${params.label}` : key)
const PO = { kindLabel: { en: 'Purchase order', it: "Ordine d'acquisto" }, record: { type: 'PurchaseOrder', id: 'po1', label: 'PO2 · rev 1' } }

describe('a request in words from its codes', () => {
  it('says the kind in the person’s language and the record as its kind reads it', () => {
    expect(requestWords(PO, 'it', it_)).toBe("Ordine d'acquisto: PO2 · rev 1")
    expect(requestWords(PO, 'en', it_)).toBe('Purchase order: PO2 · rev 1')
    expect(saidIn(PO.kindLabel, 'it')).toBe("Ordine d'acquisto")
  })
  it('says only the kind when the kind names no record, and a short name for a list', () => {
    const bare = { ...PO, record: { type: 'PurchaseOrder', id: 'po1', label: null } }
    expect(requestWords(bare, 'en', it_)).toBe('Purchase order')
    expect(requestName(bare, 'it')).toBe("Ordine d'acquisto")
    expect(requestName(PO, 'it')).toBe('PO2 · rev 1')
  })
})

describe('no screen of Home › Approvals draws the API’s English summary', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const files = ['Approvals.tsx', ...readdirSync(join(root, 'view')).map((name) => join('view', name))]
  it.each(files)('%s reads no request’s `summary`', (file) => {
    const source = readFileSync(join(root, file), 'utf8')
    expect(source).not.toMatch(/\b(?:task|row\.task|now|read|detail|line|data\.task)!?\??\.summary\b/)
  })

  const View = designScreen.view as unknown as ComponentType<{ model: unknown }>
  const render = (model: unknown, locale: 'it' | 'en') => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  const caseOf = (id: string) => designScreen.cases.find((item) => item.id === id)!

  it('the notice after a signed yes says the request in words (Italian and English), never "{request}" or the summary', () => {
    const it = render(caseOf('w2b-382-notice').model, 'it')
    expect(it).toContain('Firmata e approvata: Ordine d&#x27;acquisto: PO-DEMO-0042 · rev 1')
    const en = render(caseOf('w2b-382-notice').model, 'en')
    expect(en).toContain('Signed and approved: Purchase order: PO-DEMO-0042 · rev 1')
    expect(en).not.toContain('to be sent')
    expect(en).not.toContain('{request}')
  })
  // The review and Approve N are centred dialogs (portals: not drawn by a server render): their models are checked.
  it('Approve N carries each request’s facts and says it by its record and kind, never the summary', () => {
    const model = caseOf('w2b-307-bulk').model as unknown as { depth: { dialog: { lines: readonly Record<string, unknown>[] } } }
    const lines = model.depth.dialog.lines
    expect(lines.every((line) => !('summary' in line) && !('label' in line))).toBe(true)
    expect(lines.map((line) => requestName(line.request as Parameters<typeof requestName>[0], 'it'))).toEqual(['PRICE-DEMO-001 · Giacca Demo 1', 'PRICE-DEMO-002 · Giacca Demo 2', 'PRICE-DEMO-003 · Giacca Demo 3'])
    expect(saidIn((lines[0]!.request as Parameters<typeof requestName>[0]).kindLabel, 'it')).toBe('Cambio di prezzo')
  })
  it('a review opened alone keeps its record’s page: the held order of a credit check, never its panels', () => {
    const model = caseOf('w2b-382-review-alone').model as unknown as { depth: { rows: { items: readonly { task?: { id: string } }[] }; taskReview: { id: string; recordHref: string } } }
    expect(model.depth.rows.items.some((row) => row.task?.id === model.depth.taskReview.id)).toBe(false)
    expect(model.depth.taskReview.recordHref).toMatch(/^\/w\/[A-Z]+\/sales\/orders\/[0-9a-f-]+$/)
    const source = readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'view', 'TaskReview.tsx'), 'utf8')
    expect(source).toContain('row?.href ?? review.recordHref')
  })
})

describe('three approval subjects open their parent’s page', () => {
  const at = (record: { type: string; id: string; parent?: { type: string; id: string } | null }) => subjectAddress({ record, companyId: 'c1', siteId: null }, '/w/DEMO', OFFICE_PAGES)
  it('a credit override opens the held order, a bank change the supplier’s Bank details, a return line its return', () => {
    expect(at({ type: 'CreditCheck', id: 'cc1', parent: { type: 'SalesOrder', id: 'so1' } })).toBe('/w/DEMO/sales/orders/so1')
    expect(at({ type: 'SupplierBankAccount', id: 'b1', parent: { type: 'SupplierBank', id: 'p1' } })).toBe('/w/DEMO/purchasing/suppliers/p1?tab=bank')
    expect(at({ type: 'ReturnLine', id: 'rl1', parent: { type: 'ReturnAuthorisation', id: 'ra1' } })).toBe('/w/DEMO/sales/returns/ra1')
    expect(at({ type: 'GoodsReceiptLine', id: 'gl1', parent: { type: 'GoodsReceipt', id: 'gr1' } })).toBe('/w/DEMO/warehouse/receipts/gr1')
  })
  it('a subject with a page of its own opens it; one with neither opens its panels', () => {
    expect(at({ type: 'PurchaseOrder', id: 'po1' })).toBe('/w/DEMO/purchasing/orders/po1')
    expect(at({ type: 'NoSuchType', id: 'x1', parent: null })).toMatch(/^\/w\/DEMO\/records\/NoSuchType\/x1/)
  })
})
