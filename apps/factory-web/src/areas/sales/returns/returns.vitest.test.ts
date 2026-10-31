import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { REPAIR_ACTIONS, REPAIR_STAGES } from '@nexus/factory-domain/sales/repairs/rules'
import { RETURN_ACTIONS, RETURN_STATUSES } from '@nexus/factory-domain/sales/returns/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, RECORD_PAGES } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { RETURNABLE, REPAIR_RECEIVED, REPAIR_REPAIRED, REPAIR_ROWS, RETURN_ROWS, RMA_AUTHORISED, RMA_INSPECTED, RMA_RECEIVED } from './demo/fixtures'
import { designScreen as listScreen } from './fixtures'
import {
  addressOf,
  BLANK_CHECKLIST,
  BLANK_DDT,
  BLANK_RETURN,
  checklistBody,
  checklistProblems,
  checklistResult,
  closeReasonText,
  ddtBody,
  ddtPreviewWords,
  ddtProblems,
  decisionLinesOf,
  effectOf,
  mergedRows,
  minorOf,
  newRepairBody,
  newReturnBody,
  newReturnProblems,
  outsideWindow,
  previewProblemWords,
  queryOf,
  receiptBody,
  receiptDraftOf,
  receiptProblems,
  refusalOf,
  repairHeld,
  repairStep,
  returnHeld,
  returnsCan,
  returnStep,
  rowStatusWords,
  rowsCsv,
  sourcesOf,
  trackingWords,
  type Words,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'

const params = (query: string) => new URLSearchParams(query)
const flat = (tree: unknown, prefix = ''): Record<string, string> =>
  Object.entries(tree as Record<string, unknown>).reduce<Record<string, string>>((out, [key, value]) => (typeof value === 'string' ? { ...out, [`${prefix}${key}`]: value } : { ...out, ...flat(value, `${prefix}${key}.`) }), {})
const catalogue = (locale: 'it' | 'en') => CATALOGUE[locale]['sales-returns'] ?? {}
const has = (words: Words | null, locale: 'it' | 'en' = 'en') => {
  if (!words) return true
  if (words.key.startsWith('quality:')) return (CATALOGUE[locale].quality ?? {})[words.key.slice(8)] !== undefined
  const dictionary = catalogue(locale)
  return dictionary[words.key] !== undefined || dictionary[`${words.key}_other`] !== undefined
}
const ALL = returnsCan(['sales.returns.view', 'sales.returns.manage', 'sales.returns.receive', 'sales.returns.inspect', 'sales.returns.decide', 'sales.repairs.view', 'sales.repairs.manage', 'sales.repairs.receive', 'sales.repairs.check', 'sales.repairs.ship', 'shipping.ddt.issue', 'orders.manage', 'workorders.manage', 'invoices.manage'])

describe('the list: one filter model, two sources, one grid', () => {
  it('reads the view and the search; an unknown view is the default; the default is left out of the address', () => {
    expect(addressOf(params('view=inRepair&q=REP'))).toEqual({ view: 'inRepair', q: 'REP' })
    expect(addressOf(params('view=nonsense')).view).toBe('open')
    expect(queryOf({ view: 'open', q: '' })).toBe('')
    expect(queryOf({ view: 'waiting', q: ' x ' }, { new: 'return' })).toBe('?view=waiting&q=x&new=return')
  })

  it('each view names which source it reads (the tiles and Rows ▾ are one set)', () => {
    expect(sourcesOf('open')).toEqual({ returns: 'open', repairs: 'open' })
    expect(sourcesOf('waiting')).toEqual({ returns: 'waiting', repairs: 'awaiting' })
    expect(sourcesOf('inRepair')).toEqual({ returns: null, repairs: 'inRepair' })
    expect(sourcesOf('replacement')).toEqual({ returns: 'replacement', repairs: null })
    expect(sourcesOf('toInspect')).toEqual({ returns: 'toInspect', repairs: null })
  })

  it('merges both sources newest first with unique keys; a repair has no credit, a return its own', () => {
    const rows = mergedRows(RETURN_ROWS, REPAIR_ROWS)
    expect(rows).toHaveLength(RETURN_ROWS.length + REPAIR_ROWS.length)
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
    expect(rows.map((row) => row.at)).toEqual([...rows.map((row) => row.at)].sort().reverse())
    expect(rows.find((row) => row.kind !== 'RETURN')!.credit).toBeNull()
    expect(rows.find((row) => row.number === 'RMA-DEMO-0003')!.credit).toBe(25000)
  })

  it('the status in words: late goods, received pieces, a repaired garment waiting for its check', () => {
    const rows = mergedRows(RETURN_ROWS, REPAIR_ROWS)
    expect(rowStatusWords(rows.find((row) => row.number === 'RMA-DEMO-0004')!, '2026-10-31')).toEqual({ key: 'sub.late', params: { date: '2026-10-20' } })
    expect(rowStatusWords(rows.find((row) => row.number === 'RMA-DEMO-0002')!, '2026-10-31')).toEqual({ key: 'sub.received', params: { received: 1, count: 1 } })
    expect(rowStatusWords(rows.find((row) => row.number === 'REP-DEMO-0003')!, '2026-10-31').key).toBe('sub.repairedToCheck')
  })

  it('the CSV names the columns and leaves the credit out without the price grain', () => {
    const rows = mergedRows(RETURN_ROWS, []).filter((row) => row.number === 'RMA-DEMO-0003')
    const csv = (price: boolean) => rowsCsv(rows, ['n', 't', 'c', 'o', 'u', 's', 'r', 'd', 'cr'], () => 'Return', () => 'Inspected', price)
    expect(csv(true).split('\n')[1]).toContain('250.00')
    expect(csv(false).split('\n')[1]).not.toContain('250.00')
  })
})

describe('held steps in our words (the API’s sentences are English)', () => {
  it('an RMA: every action, every status, has words in both languages', () => {
    for (const status of RETURN_STATUSES)
      for (const rma of [RMA_AUTHORISED, RMA_RECEIVED, RMA_INSPECTED]) {
        const record = { ...rma, status, actions: rma.actions.map((entry) => ({ ...entry, allowed: false })) }
        for (const action of RETURN_ACTIONS) {
          const words = returnHeld(action, record)
          expect(words, `${status} ${action}`).not.toBeNull()
          for (const locale of LOCALES) expect(has(words, locale), `${words!.key} (${locale})`).toBe(true)
        }
      }
  })

  it('an allowed action is not held; the role comes first, then offline', () => {
    expect(returnStep('receive', RMA_AUTHORISED, ALL, false)).toBeNull()
    expect(returnStep('receive', RMA_AUTHORISED, returnsCan(['sales.returns.view']), false)).toEqual({ key: 'held.right.receive' })
    expect(returnStep('receive', RMA_AUTHORISED, ALL, true)).toEqual({ key: 'held.offline' })
    expect(returnHeld('close', { ...RMA_RECEIVED, actions: [] })).toEqual({ key: 'held.decideFirst', params: { count: 2 } })
  })

  it('a repair: every action, every stage, has words in both languages', () => {
    for (const stage of REPAIR_STAGES)
      for (const repair of [REPAIR_RECEIVED, REPAIR_REPAIRED]) {
        const record = { ...repair, stage, actions: repair.actions.map((entry) => ({ ...entry, allowed: false })) }
        for (const action of REPAIR_ACTIONS) {
          const words = repairHeld(action, record)
          expect(words, `${stage} ${action}`).not.toBeNull()
          for (const locale of LOCALES) expect(has(words, locale), `${words!.key} (${locale})`).toBe(true)
        }
      }
    expect(repairStep('safetyCheck', REPAIR_REPAIRED, returnsCan(['sales.repairs.view', 'sales.repairs.manage']), false)).toEqual({ key: 'held.right.repairsCheck' })
    expect(repairHeld('startRepair', { ...REPAIR_RECEIVED, stage: 'APPROVED', actions: [], workOrder: { id: 'w', number: 'WO-1', status: 'DRAFT' } })).toEqual({ key: 'held.releaseWorkOrder', params: { number: 'WO-1' } })
  })

  it('every missing right has words', () => {
    for (const ability of Object.keys(ALL)) for (const locale of LOCALES) expect(has({ key: `held.right.${ability}` }, locale), ability).toBe(true)
  })
})

describe('the API’s refusals by place', () => {
  it('a quantity above what was sold carries the numbers of the API’s sentence', () => {
    const error = new ApiError('conflict', 409, 'conflict', 'x', 'r', [{ path: 'body/lines/0/quantity', message: 'At most 1 can come back: 2 sold, 1 already on other returns.' }])
    expect(refusalOf(error)).toEqual({ key: 'refusal.aboveSoldMax', params: { max: 1, sold: 2 } })
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'x', 'r', []))).toEqual({ key: 'refusal.stale' })
    expect(refusalOf(new ApiError('conflict', 409, 'invalid_state', 'x', 'r', []))).toEqual({ key: 'refusal.state' })
    expect(refusalOf(new ApiError('invalid', 400, 'invalid', 'x', 'r', [{ path: 'body/note', message: 'Say why.' }]))).toEqual({ key: 'refusal.noteNeeded' })
    expect(refusalOf(new ApiError('forbidden', 403, 'forbidden', 'x', 'r', []))).toEqual({ key: 'quality:problem.forbidden' })
  })

  it('a preview’s problems in our words, one per kind', () => {
    const words = previewProblemWords(
      [
        { path: 'company/numbering', message: 'No series.' },
        { path: 'body/lines/1/reasonCode', message: 'x' },
        { path: 'body/lines/0/reasonCode', message: 'x' },
      ],
      'return',
    )
    expect(words).toEqual([{ key: 'problem.numberingReturn' }, { key: 'problem.reason' }])
    expect(previewProblemWords([{ path: 'conflict', message: 'x' }], 'repair')).toEqual([{ key: 'problem.repairExists' }])
    expect(ddtPreviewWords([{ path: 'body/carrier', message: 'x' }, { path: 'company/vatNumber', message: 'x' }])).toEqual([{ key: 'ddt.problem.carrier' }, { key: 'ddt.problem.company' }])
  })
})

describe('the dialogs’ drafts and what they send', () => {
  it('New return: the customer, at least one line, never above what is left, a reason each', () => {
    expect(newReturnProblems(BLANK_RETURN, null)).toEqual([{ key: 'newReturn.problem.customer' }])
    const draft = { ...BLANK_RETURN, partyId: 'p', lines: { [RETURNABLE[0]!.invoiceLineId!]: { quantity: '2', reasonCode: '', note: '' } } }
    expect(newReturnProblems(draft, RETURNABLE)).toEqual([{ key: 'refusal.aboveSoldMax', params: { max: 1, sold: 2 } }, { key: 'newReturn.problem.reason', params: { line: RETURNABLE[0]!.description } }])
    const ok = { ...draft, lines: { [RETURNABLE[0]!.invoiceLineId!]: { quantity: '1', reasonCode: 'DEFECT', note: ' zip ' } } }
    expect(newReturnProblems(ok, RETURNABLE)).toEqual([])
    expect(newReturnBody(ok, RETURNABLE, 'c')).toMatchObject({ companyId: 'c', partyId: 'p', lines: [{ invoiceLineId: RETURNABLE[0]!.invoiceLineId, quantity: 1, reasonCode: 'DEFECT', reasonNote: 'zip', batchNumber: 'B-DEMO-0142' }] })
  })

  it('a shipped line without its invoice is named by its order line and size', () => {
    const shipped = { ...RETURNABLE[2]!, left: 1 }
    const body = newReturnBody({ ...BLANK_RETURN, partyId: 'p', lines: { [`${shipped.salesOrderLineId}|54`]: { quantity: '1', reasonCode: 'DEFECT', note: '' } } }, [shipped], 'c')
    expect(body.lines[0]).toMatchObject({ salesOrderLineId: shipped.salesOrderLineId, size: '54' })
    expect(body.lines[0]).not.toHaveProperty('invoiceLineId')
  })

  it('the return window is a warning only', () => {
    expect(outsideWindow({ deliveredOn: '2026-09-15' }, 30, '2026-10-31')).toBe(46)
    expect(outsideWindow({ deliveredOn: '2026-10-06' }, 30, '2026-10-31')).toBeNull()
    expect(outsideWindow({ deliveredOn: '2026-09-15' }, null, '2026-10-31')).toBeNull()
  })

  it('New repair: from an RMA line only the line; by hand the customer, the serial and received with its DDT', () => {
    expect(newRepairBody({ returnLineId: 'l', serial: 's', partyId: '', kind: 'REPAIR', problem: '', received: false, inboundDdtNumber: '', inboundDdtDate: '', internalNote: '' }, 'c')).toEqual({ returnLineId: 'l', kind: 'REPAIR', internalNote: null })
    expect(newRepairBody({ returnLineId: '', serial: ' S1 ', partyId: 'p', kind: 'ALTERATION', problem: 'x', received: true, inboundDdtNumber: 'D1', inboundDdtDate: '', internalNote: '' }, 'c')).toEqual({ companyId: 'c', partyId: 'p', kind: 'ALTERATION', serial: 'S1', problem: 'x', internalNote: null, received: { inboundDdtNumber: 'D1', inboundDdtDate: null } })
  })

  it('Receive goods: the pieces each line still expects, never more', () => {
    const draft = receiptDraftOf(RMA_AUTHORISED)
    expect(Object.values(draft.lines)).toEqual(['1', '2'])
    expect(receiptProblems(draft, RMA_AUTHORISED)).toEqual([])
    expect(receiptProblems({ ...draft, lines: { [RMA_AUTHORISED.lines[0]!.id]: '3' } }, RMA_AUTHORISED)).toEqual([{ key: 'receive.problem.more', params: { seq: 10, max: 1 } }])
    expect(receiptBody({ ...draft, ddtNumber: ' C1 ' })).toMatchObject({ parcels: 1, parcelCondition: 'INTACT', customerDdtNumber: 'C1', lines: [{ quantity: 1 }, { quantity: 2 }] })
  })

  it('a decision sends the lines with a disposition, the suggested outcome when it fits, a credit only with the price grain', () => {
    const line = { ...RMA_RECEIVED.lines[1]!, suggestedOutcome: 'RESTOCK' as const }
    const drafts = { [line.id]: { disposition: 'CREDIT_ONLY' as const, outcome: '' as const, credit: '120,50' } }
    expect(decisionLinesOf(drafts, [line], true)).toEqual([{ lineId: line.id, disposition: 'CREDIT_ONLY', goodsOutcome: 'RESTOCK', creditAmount: 12050 }])
    expect(decisionLinesOf(drafts, [line], false)).toEqual([{ lineId: line.id, disposition: 'CREDIT_ONLY', goodsOutcome: 'RESTOCK' }])
    expect(decisionLinesOf({ [line.id]: { disposition: 'REPAIR', outcome: 'RESTOCK', credit: '' } }, [line], true)[0]!.goodsOutcome).toBe('REPAIR')
    expect(minorOf('12.3')).toBe(1230)
    expect(minorOf('abc')).toBeNull()
  })

  it('the effect in words: money, stock and work in one line', () => {
    expect(effectOf({ disposition: 'CREDIT_ONLY', goodsOutcome: 'RESTOCK', creditAmount: 100, place: 'A1-FG' })).toEqual([{ key: 'effect.credit' }, { key: 'effect.goodsAt.RESTOCK', params: { place: 'A1-FG' } }, { key: 'effect.follow.CREDIT_NOTE' }])
    expect(effectOf({ disposition: 'REPLACE', goodsOutcome: 'QUARANTINE', creditAmount: 0 })).toEqual([{ key: 'effect.noCredit' }, { key: 'effect.goods.QUARANTINE' }, { key: 'effect.follow.REPLACEMENT_ORDER' }])
  })

  it('the safety check: every point answered, a replaced protector’s lot and level; PASS only with no failure and the certificate covering', () => {
    expect(checklistProblems(BLANK_CHECKLIST).length).toBe(5)
    const filled = { ...BLANK_CHECKLIST, seams: 'PASS' as const, abrasionZones: 'PASS' as const, closures: 'NOT_APPLICABLE' as const, protectors: 'PASS' as const, certificateCovers: true, replaced: true, lot: '', level: '' as const }
    expect(checklistProblems(filled)).toEqual([{ key: 'safety.problem.lot' }, { key: 'safety.problem.level' }])
    expect(checklistResult({ ...filled, lot: 'L', level: '2' })).toBe('PASS')
    expect(checklistResult({ ...filled, closures: 'FAIL' })).toBe('FAIL')
    expect(checklistResult({ ...filled, certificateCovers: false })).toBe('FAIL')
    expect(checklistBody({ ...filled, lot: ' L7 ', level: '2' }).protectors).toEqual({ result: 'PASS', replaced: true, lot: 'L7', level: '2' })
  })

  it('a DDT: who carries it, packages and weight', () => {
    expect(ddtProblems(BLANK_DDT).map((words) => words.key)).toEqual(['ddt.problem.carrier', 'ddt.problem.weight'])
    expect(ddtBody({ ...BLANK_DDT, carrier: ' C ', weight: '1,4' }, 'REPAIR')).toMatchObject({ reason: 'REPAIR', transportBy: 'CARRIER', carrier: { name: 'C' }, packages: 1, grossWeightKg: '1.4' })
  })

  it('the close reason is the chosen words, then the note', () => {
    expect(closeReasonText('Credited', '  ')).toBe('Credited')
    expect(closeReasonText('Other', 'customer kept it')).toBe('Other: customer kept it')
  })

  it('the milestones say the deadline and how many lines are decided', () => {
    expect(trackingWords(RMA_AUTHORISED.tracking[1]!, RMA_AUTHORISED)).toEqual({ key: 'track.sub.sendBy', params: { date: '2026-11-14' } })
    expect(trackingWords(RMA_RECEIVED.tracking[3]!, RMA_RECEIVED)).toEqual({ key: 'track.sub.decided', params: { decided: 0, count: 2 } })
  })
})

describe('built pages and where records open', () => {
  it('the list, the RMA and the repair are built; a return and a repair open their records; both API lists open the grid', () => {
    for (const page of ['/sales/returns', '/sales/returns/[id]', '/sales/returns/repairs/[id]', '/sales/settings']) expect(OFFICE_PAGES.has(page), page).toBe(true)
    expect(RECORD_PAGES.ReturnAuthorisation).toBe('/sales/returns/[id]')
    expect(RECORD_PAGES.RepairOrder).toBe('/sales/returns/repairs/[id]')
    expect(LIST_PAGES['/sales/returns']).toBe('/sales/returns')
    expect(LIST_PAGES['/sales/repairs']).toBe('/sales/returns')
  })
})

// ---- every design case, both languages, no key on screen -------------------------------------------------------------------

const en = flat(CATALOGUE.en['sales-returns'] ? Object.fromEntries(Object.entries(CATALOGUE.en['sales-returns']).map(([key, value]) => [key, value])) : {})
const PREFIXES = [...new Set(Object.keys(en).map((key) => key.split('.')[0]!))].filter((prefix) => prefix.length > 2)
const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.join('|')})\\.[a-zA-Z][a-zA-Z0-9_]*(?:\\.[a-zA-Z0-9_]+)*`)

describe('every design case draws in both languages with no key left on screen', () => {
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  for (const screen of [listScreen, recordScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale).replace(/(?:href|src|id|class|aria-[a-z]+|data-[a-z-]+|name|for|value|placeholder|title)="[^"]*"/g, '')
          expect(html.length, item.id).toBeGreaterThan(300)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html, `${screen.screen}/${item.id} (${locale})`).not.toMatch(/\{[a-z]+\}/i)
        }
      })
    }
  }

  it('the price grain: a role without it sees no amount', () => {
    const warehouse = listScreen.cases.find((item) => item.id === 'warehouse')!
    expect(render(listScreen as DesignScreen<unknown>, warehouse.model, 'en')).not.toMatch(/€\s?\d|\d\s?€/)
    const credit = recordScreen.cases.find((item) => item.id === 'rma-credit-no-grain')!
    expect(render(recordScreen as DesignScreen<unknown>, credit.model, 'en')).not.toMatch(/€\s?\d|\d\s?€/)
  })
})
