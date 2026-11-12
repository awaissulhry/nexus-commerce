import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { REPORT_HELD, SERVE_HELD, SERVE_WHY, DEMAND_KINDS } from '@nexus/factory-domain/inventory/reception-report/rules'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import type { ReceptionReport, Unplanned } from './api'
import { designScreen, UNPLANNED_DEMO } from './fixtures'
import { choiceCounts, defaultChoice, namingBody, namingFor, namingHeld, NAMESPACE, reportProblem, reserveBody, reserveHeld, rowHeld, sendBackHeld, serveRows, suggestedOrder, waitingProblem } from './model'

/** SCR-379 — the reception report and goods without a PO on the receipt (B-W2b-300; SCM-119, SCM-122): the rules, the words. */

const serve = (key: string, extra: Partial<ReceptionReport['lines'][number]['serves'][number]> = {}) => ({ key, kind: key.startsWith('WORK') ? ('WORK_ORDER' as const) : ('ORDER_LINE' as const), why: 'NEEDS' as const, workOrder: key.startsWith('WORK') ? { id: key, number: key, status: 'RELEASED', dueDate: null } : null, orderLine: key.startsWith('ORDER') ? { id: key, number: 'SO-1', seq: 10, status: 'CONFIRMED' } : null, needDate: null, pegged: null, open: '10.0000', reservedHere: '0.0000', proposed: '10.0000', lots: [{ lotId: 'L', quantity: '10.0000' }], held: null, ...extra })
const report: ReceptionReport = {
  receipt: { id: 'r', number: 'GR-1', status: 'POSTED', companyId: 'c', siteId: 's', purchaseOrder: { id: 'po', number: 'PO-1', partyId: 'p' } },
  held: null,
  run: null,
  buyer: { id: 'u', name: 'Buyer' },
  lines: [{ receiptLineId: 'l1', seq: 10, purchaseOrderLineId: 'pol', item: { id: 'i', code: 'LIN', name: 'Lining', baseUom: 'M', tracking: 'LOT' }, colour: null, received: '30.0000', lots: [{ id: 'L', code: 'LA-1', qualityStatus: 'RELEASED', free: '30.0000', held: false }], serves: [serve('WORK_ORDER:a'), serve('ORDER_LINE:b'), serve('WORK_ORDER:c', { proposed: '0.0000', held: 'NOT_NEEDED', lots: [] })], left: '10.0000' }],
  proposals: 2,
  can: { reserve: true, send: true },
}

describe('the reception report', () => {
  const rows = serveRows(report)

  it('chooses what has something to take, says why the others may not be chosen, counts work orders and orders', () => {
    expect(defaultChoice(rows)).toEqual(['l1|WORK_ORDER:a', 'l1|ORDER_LINE:b'])
    expect(rowHeld(rows[2]!)).toBe('reception.held.NOT_NEEDED')
    expect(choiceCounts(rows, defaultChoice(rows))).toEqual({ workOrders: 1, orders: 1, rows: 2 })
    expect(choiceCounts(rows, ['l1|WORK_ORDER:c'])).toEqual({ workOrders: 0, orders: 0, rows: 0 })
  })

  it('holds the reserve with the reason, and sends only what may be reserved', () => {
    expect(reserveHeld(report, rows, defaultChoice(rows), false)).toBeNull()
    expect(reserveHeld(report, rows, [], false)).toBe('reception.held.choose')
    expect(reserveHeld(report, rows, defaultChoice(rows), true)).toBe('reception.held.busy')
    expect(reserveHeld({ ...report, held: 'NOT_POSTED' }, rows, [], false)).toBe('reception.report.NOT_POSTED')
    expect(reserveHeld({ ...report, can: { reserve: false, send: true } }, rows, defaultChoice(rows), false)).toBe('reception.held.noReserve')
    expect(reserveBody(rows, [...defaultChoice(rows), 'l1|WORK_ORDER:c'], true, ' Cut first ')).toEqual({ demands: [{ receiptLineId: 'l1', key: 'WORK_ORDER:a' }, { receiptLineId: 'l1', key: 'ORDER_LINE:b' }], tellBuyer: true, note: 'Cut first' })
  })

  it('says a refusal in our words by its path', () => {
    expect(reportProblem(['body/lines/0/refusal/RESERVED_FOR_OTHER'], { kind: 'conflict' })).toEqual({ key: 'reception.problem.refused' })
    expect(reportProblem([], { kind: 'conflict' })).toEqual({ key: 'reception.problem.nothing' })
    expect(reportProblem([], { kind: 'forbidden' })).toBeNull()
  })
})

const unplanned: Unplanned = UNPLANNED_DEMO

describe('goods without a PO on the receipt', () => {
  it('opens on the order that takes every line, each line on the one that fits', () => {
    expect(suggestedOrder(unplanned)).toBe('po-2')
    const draft = namingFor(unplanned, 'po-2')
    expect(draft.lines['grl-9']!.purchaseOrderLineId).toBe('pol-9')
    expect(namingFor(unplanned, 'po-3').lines['grl-9']!.purchaseOrderLineId).toBe('')
  })

  it('holds the naming until every line has its order line and the leather its hide areas', () => {
    const draft = namingFor(unplanned, 'po-2')
    expect(namingHeld(unplanned, { orderId: null, lines: {} }, false)).toEqual({ key: 'waiting.held.pickOrder' })
    expect(namingHeld(unplanned, draft, false)).toEqual({ key: 'waiting.held.hides', params: { seq: 20, code: 'DEMO-LEA-12' } })
    const ready = { ...draft, lines: { ...draft.lines, 'grl-10': { ...draft.lines['grl-10']!, hideAreas: '52,3 48.9\n51.3' } } }
    expect(namingHeld(unplanned, ready, false)).toBeNull()
    expect(namingHeld({ ...unplanned, orders: [] }, ready, false)).toEqual({ key: 'waiting.held.noOrder', params: { supplier: 'Conceria Demo Valdarno' } })
    expect(namingHeld({ ...unplanned, can: { decide: false, askBuyer: false } }, ready, false)).toEqual({ key: 'waiting.held.noDecide' })
    expect(namingBody(unplanned, ready)).toEqual({
      version: 2,
      purchaseOrderId: 'po-2',
      lines: [
        { receiptLineId: 'grl-9', purchaseOrderLineId: 'pol-9' },
        { receiptLineId: 'grl-10', purchaseOrderLineId: 'pol-10', hideAreas: ['52.3000', '48.9000', '51.3000'] },
      ],
    })
  })

  it('sends back only with a reason, and words a refused naming by its path', () => {
    expect(sendBackHeld(unplanned, '  ', false)).toEqual({ key: 'waiting.held.reason' })
    expect(sendBackHeld(unplanned, 'Not ours', false)).toBeNull()
    expect(waitingProblem(['body/lines/1/quantity'], { kind: 'conflict' })).toEqual({ key: 'waiting.problem.tolerance' })
    expect(waitingProblem(['body/lines/0/hideAreas'], { kind: 'invalid' })).toEqual({ key: 'waiting.problem.hides' })
    expect(waitingProblem(['body/purchaseOrderId'], { kind: 'invalid' })).toEqual({ key: 'waiting.problem.order' })
    expect(waitingProblem(['version'], { kind: 'conflict' })).toEqual({ key: 'waiting.problem.changed' })
  })
})

// ---- the words -----------------------------------------------------------------------------------------------------------------

const HERE = fileURLToPath(new URL('.', import.meta.url))
const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [join(dir, entry.name)] : []))
const keysOf = (tree: unknown, prefix = ''): string[] => (tree && typeof tree === 'object' ? Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) => keysOf(value, prefix ? `${prefix}.${key}` : key)) : [prefix])
const OWN = new Set(keysOf(CATALOGUE.en[NAMESPACE]).map((key) => key.replace(/_(one|other)$/, '')))

describe('SCR-379 speaks both languages, with no key left and no money', () => {
  it('has every key it names in the catalogue', () => {
    const used = filesUnder(HERE).flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/'((?:reception|waiting)\.[A-Za-z0-9_.]+)'/g)].map((match) => match[1]!))
    expect(used.length).toBeGreaterThan(80)
    expect(used.filter((key) => !OWN.has(key))).toEqual([])
    const dynamic = [...SERVE_HELD.map((code) => `reception.held.${code}`), ...REPORT_HELD.map((code) => `reception.report.${code}`), ...SERVE_WHY.map((code) => `reception.why.${code}`), ...DEMAND_KINDS.map((code) => `reception.kind.${code}`), ...['SENT', 'CONFIRMED', 'PARTLY_RECEIVED'].map((code) => `waiting.orderStatus.${code}`), ...['read', 'forbidden', 'offline', 'gone'].map((code) => `reception.problem.${code}`), 'reception.menu']
    expect(dynamic.filter((key) => !OWN.has(key))).toEqual([])
  })

  for (const locale of LOCALES) {
    it(`draws its banner cases in ${locale}`, () => {
      const View = designScreen.view as ComponentType<{ model: unknown }>
      for (const item of designScreen.cases.filter((entry) => entry.model.kind === 'waiting')) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['lists', 'records', NAMESPACE]) }, createElement(View, { model: item.model })))
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(/(?:reception|waiting|unplanned)\.[a-zA-Z]+\.?/)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html.replace(/<[^>]+>/g, ' ').match(/€|EUR\s?\d/)?.[0] ?? null, item.id).toBeNull()
      }
    })
  }
})
