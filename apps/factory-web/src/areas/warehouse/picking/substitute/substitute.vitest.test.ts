import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SUBSTITUTION_REFUSAL_CODES, SUBSTITUTION_STATUSES } from '@nexus/factory-domain/inventory/substitutions/rules'
import { ALTERNATE_USES } from '@nexus/factory-domain/product/bom-lines/rules'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { substituteHeld } from '../../../production/work-orders/materials/substitute/WorkOrderSubstitute'
import { designScreen as workOrderScreen } from '../../../production/work-orders/record/fixtures'
import { designScreen as pickingScreen } from '../fixtures'
import { PICK_ROLES } from '../demo/fixtures'
import { askSubstitute, withdrawSubstitute, type BomRows } from './api'
import { NAMED_SELF, OPTIONS, SUB_CAN, SUB_CAN_NONE, SUBSTITUTIONS } from './demo/fixtures'
import { approvalWords, askBodyOf, askHeld, askProblem, blankAsk, bomLinesOf, certificateWords, choiceHeld, lotHeld, subCan, SUB_NAMESPACE, withdrawHeld } from './model'

/**
 * B-W2b-320 — "Use a substitute" and the substitutes list: who may ask (the pickers' inventory.issue), the BOM lines of a
 * material, why a choice or a lot is held (from the codes and facts, never the API's English), the ask's check and body,
 * a refusal in our words, the calls (an Idempotency-Key each), the record link from Home › Approvals, and every W2b design
 * case (Picking, the work order's Materials) drawn in Italian and English with no key left.
 */

describe('substitutes: abilities and lines', () => {
  it('lets the warehouse ask (inventory.issue); read-only sees only', () => {
    expect(subCan(PICK_ROLES.warehouse)).toEqual({ ask: true, view: true })
    expect(subCan(PICK_ROLES.readOnly)).toEqual({ ask: false, view: true })
    expect(substituteHeld({ can: SUB_CAN, status: 'IN_PROGRESS' })).toBeNull()
    expect(substituteHeld({ can: SUB_CAN, status: 'DRAFT' })!.key).toBe('sb.held.notOpen')
    expect(substituteHeld({ can: SUB_CAN_NONE, status: 'RELEASED' })!.key).toBe('sb.held.noRight')
  })

  it('groups the work order’s pick rows by BOM line, of the material asked', () => {
    const rows: BomRows = {
      workOrder: { id: 'w1' },
      lines: [
        { itemId: 'p', itemCode: 'PRT', itemName: 'Prot', itemColourId: null, colourCode: null, baseUom: 'PCS', toIssue: '14', covered: false, rows: [{ bomLineId: 'b30', bomSeq: 30, placement: 'Spalle', planned: '12', issued: '5', toIssue: '7' }, { bomLineId: 'b30', bomSeq: 30, placement: 'Spalle', planned: '12', issued: '5', toIssue: '7' }, { bomLineId: 'b31', bomSeq: 31, placement: 'Gomiti', planned: '6', issued: '0', toIssue: '6' }] },
        { itemId: 'l', itemCode: 'LIN', itemName: 'Lining', itemColourId: 'c', colourCode: 'BLK', baseUom: 'M', toIssue: '3', covered: false, rows: [{ bomLineId: 'b20', bomSeq: 20, placement: null, planned: '3', issued: '0', toIssue: '3' }] },
      ],
    }
    expect(bomLinesOf(rows, { itemId: 'p', itemColourId: null }).map((line) => [line.bomLineId, line.toIssue])).toEqual([
      ['b30', 14],
      ['b31', 6],
    ])
    expect(bomLinesOf(rows).map((line) => line.seq)).toEqual([20, 30, 31])
  })

  it('names a BOM line once when its colour follows the garment’s (one pick line per colour)', () => {
    const row = (toIssue: string) => [{ bomLineId: 'b40', bomSeq: 40, placement: 'Fodera', planned: toIssue, issued: '0', toIssue }]
    const rows: BomRows = {
      workOrder: { id: 'w1' },
      lines: [
        { itemId: 'l', itemCode: 'LIN', itemName: 'Lining', itemColourId: 'c1', colourCode: 'BLK', baseUom: 'M', toIssue: '2', covered: false, rows: row('2') },
        { itemId: 'l', itemCode: 'LIN', itemName: 'Lining', itemColourId: 'c2', colourCode: 'RED', baseUom: 'M', toIssue: '3', covered: false, rows: row('3') },
      ],
    }
    const lines = bomLinesOf(rows)
    expect(lines.map((line) => [line.bomLineId, line.colourCode, line.toIssue])).toEqual([['b40', 'BLK, RED', 5]])
    expect(bomLinesOf(rows, { itemId: 'l', itemColourId: 'c2' }).map((line) => [line.colourCode, line.toIssue])).toEqual([['RED', 3]])
  })
})

describe('substitutes: choices, lots and the ask', () => {
  it('says why a choice is held from its codes: the rule, nobody to decide (you named), no stock', () => {
    const [alternate, outside, own] = OPTIONS.choices
    expect(choiceHeld(alternate!)).toBeNull()
    expect(choiceHeld(outside!)!.key).toBe('sb.refusal.OUTSIDE_CERTIFICATE')
    expect(choiceHeld(own!)).toBeNull()
    expect(choiceHeld(NAMED_SELF.choices[0]!)!.key).toBe('sb.held.namedSelf')
    expect(choiceHeld({ ...alternate!, approval: { ...alternate!.approval, asks: false } })!.key).toBe('sb.refusal.NO_APPROVER')
    expect(choiceHeld({ ...alternate!, max: '0.0000' })!.key).toBe('sb.held.nothingLeft')
    expect(choiceHeld({ ...alternate!, stock: { onHand: '0', lots: [] } })!.key).toBe('sb.held.noStock')
    expect(approvalWords(alternate!)).toEqual({ key: 'sb.approval.role', params: { name: 'Responsabile produzione' } })
    expect(approvalWords({ ...alternate!, needsPerson: false, approval: { ...alternate!.approval, asks: false } }).key).toBe('sb.approval.atOnce')
    expect(certificateWords(alternate!)!.key).toBe('sb.cert.covered')
    expect(certificateWords(outside!)!.key).toBe('sb.cert.missing')
  })

  it('says why a lot cannot be named from its facts (quarantine, chromium VI, a hold)', () => {
    const quarantine = OPTIONS.choices[2]!.stock.lots[1]!
    expect(lotHeld(quarantine)).toEqual({ key: 'sb.lot.quality.QUARANTINE', params: { code: 'LOT-D-000135' } })
    expect(lotHeld({ ...quarantine, lot: { ...quarantine.lot!, qualityStatus: 'RELEASED', requiresCrViTest: true, crViStatus: 'PENDING' } })!.key).toBe('sb.lot.crVi')
    expect(lotHeld({ ...quarantine, lot: { ...quarantine.lot!, qualityStatus: 'RELEASED' } })!.key).toBe('sb.lot.hold')
    expect(lotHeld(OPTIONS.choices[2]!.stock.lots[0]!)).toBeNull()
  })

  it('holds Ask with why, and sends the line, the substitute, its lot and how much', () => {
    const draft = blankAsk(OPTIONS)
    expect(draft.choice).toBe(0)
    expect(askHeld(OPTIONS, draft, SUB_CAN_NONE, false)!.key).toBe('sb.held.noRight')
    expect(askHeld(OPTIONS, draft, SUB_CAN, false)!.key).toBe('sb.held.quantity')
    expect(askHeld(OPTIONS, { ...draft, quantity: '12' }, SUB_CAN, false)!.key).toBe('sb.held.tooMuch')
    expect(askHeld(OPTIONS, { ...draft, quantity: '4' }, SUB_CAN, false)!.key).toBe('sb.held.reason')
    expect(askHeld(OPTIONS, { ...draft, choice: 2, quantity: '4', reason: 'x' }, SUB_CAN, false)!.key).toBe('sb.held.pickLot')
    expect(askHeld(OPTIONS, { ...draft, choice: 2, lotId: OPTIONS.choices[2]!.stock.lots[1]!.lot!.id, quantity: '4', reason: 'x' }, SUB_CAN, false)!.key).toBe('sb.lot.quality.QUARANTINE')
    expect(askHeld(OPTIONS, { ...draft, choice: 1, quantity: '4', reason: 'x' }, SUB_CAN, false)!.key).toBe('sb.refusal.OUTSIDE_CERTIFICATE')
    const ready = { ...draft, quantity: '4,5', reason: ' In ritardo ' }
    expect(askHeld(OPTIONS, ready, SUB_CAN, false)).toBeNull()
    expect(askBodyOf(OPTIONS, ready)).toEqual({ workOrderId: OPTIONS.workOrder.id, bomLineId: OPTIONS.line.id, toItemId: OPTIONS.choices[0]!.item.id, quantity: '4.5', uom: 'PCS', reason: 'In ritardo' })
  })

  it('says a refusal by its code, and withdraws only what waits or is approved', () => {
    expect(askProblem(new ApiError('conflict', 409, 'refusal', 'x', null, [{ path: 'refusal/ONLY_WHEN_SHORT' }])).key).toBe('sb.refusal.ONLY_WHEN_SHORT')
    expect(askProblem(new ApiError('forbidden', 403, 'forbidden', 'x')).key).toBe('sb.held.noRight')
    expect(askProblem(new ApiError('conflict', 409, 'conflict', 'x')).key).toBe('sb.changed')
    expect(withdrawHeld(SUBSTITUTIONS[0]!, SUB_CAN)).toBeNull()
    expect(withdrawHeld({ status: 'ISSUED' }, SUB_CAN)!.key).toBe('sb.held.final')
    expect(withdrawHeld(SUBSTITUTIONS[0]!, SUB_CAN_NONE)!.key).toBe('sb.held.noRight')
  })

  it('asks and withdraws with an Idempotency-Key each; Home › Approvals opens the substitute on Picking', async () => {
    const calls: { url: string; method: string; body: unknown; key: string | null }[] = []
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, key: new Headers(init?.headers).get('idempotency-key') })
      const body = url.endsWith('/withdraw') ? { substitution: SUBSTITUTIONS[0] } : { substitution: SUBSTITUTIONS[0], approval: { asked: true, taskId: 't1', approverRoleId: 'r1', approverUserId: null, dueAt: null }, approvedAtOnce: false }
      return new Response(JSON.stringify(body), { status: url.endsWith('/withdraw') ? 200 : 201, headers: { 'content-type': 'application/json' } })
    }
    const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetcher as unknown as typeof globalThis.fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' })
    expect((await askSubstitute(api, askBodyOf(OPTIONS, { ...blankAsk(OPTIONS), quantity: '4', reason: 'x' }))).approval.taskId).toBe('t1')
    await withdrawSubstitute(api, SUBSTITUTIONS[0]!, 'Arrivate')
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', '/api/inventory/substitutions'],
      ['POST', `/api/inventory/substitutions/${SUBSTITUTIONS[0]!.id}/withdraw`],
    ])
    expect(calls[1]!.body).toEqual({ version: 1, reason: 'Arrivate' })
    expect(calls.every((call) => !!call.key)).toBe(true)
    expect(recordAddress({ type: 'MaterialSubstitution', id: 's1' }, OFFICE_PAGES)).toBe('/warehouse/picking?substitution=s1')
  })
})

const LEFT_KEY = /\b(?:sb|ld|cd)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const PERMISSIONS = /\b(?:inventory\.[a-z]+\.[a-z]+|inventory\.issue)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'stock', 'lists', 'records', 'warehouse-picking', 'production', 'production-work-orders', SUB_NAMESPACE]) }, createElement(View, { model })))
}

describe('substitutes: every W2b design case draws in both languages with no key left', () => {
  for (const [screen, prefix] of [
    [pickingScreen, 'w2b-'],
    [workOrderScreen, 'w2b-320-'],
  ] as unknown as [DesignScreen<unknown>, string][]) {
    const cases = screen.cases.filter((item) => item.id.startsWith(prefix))
    it(`${screen.screen}: ${cases.length} W2b cases × it, en`, () => {
      expect(cases.length).toBeGreaterThan(2)
      for (const item of cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(PERMISSIONS, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('every refusal, status and use has words in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [SUB_NAMESPACE])[SUB_NAMESPACE]!)
      const has = (key: string) => expect(t(key), `${locale}: ${key}`).not.toBe(key)
      for (const code of SUBSTITUTION_REFUSAL_CODES) has(`sb.refusal.${code}`)
      for (const status of SUBSTITUTION_STATUSES) has(`sb.status.${status}`)
      for (const use of ALTERNATE_USES) has(`sb.use.${use}`)
      for (const status of ['QUARANTINE', 'BLOCKED', 'REJECTED', 'RELEASED']) has(`sb.lot.quality.${status}`)
    }
  })
})
