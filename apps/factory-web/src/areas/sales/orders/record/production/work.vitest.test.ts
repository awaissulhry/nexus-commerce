import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { actsCanOf, rowActsOf } from '../../../../../lib/production/work-order-acts/model'
import { WORK, workActsRead } from '../overview/fixtures'
import { afterDueOf, decisionSentenceOf, decisionsOf, priorityShownOf, shownActsOf, statusKeyOf, unitStateKeyOf, unitsOf, workDatesOf, workProgressOf, workSummaryOf, WO_TONE } from './work'

// F-PT-104 (order PRODUCTION tab, W1): the Work orders rows — the head's answer, On hold in words (B1), Rush ≠ Urgent (B3), Checked
// (B4), one Decide… per waiting change incl. MAKE_MORE (B5), a draft unit "not released yet" (B6), hidden acts without the right (L9).

const w = (en: string, it: string) => ({ en, it })
const [first, second] = WORK.workOrders as [(typeof WORK.workOrders)[number], (typeof WORK.workOrders)[number]]

describe('F-PT-104: the head and the rows', () => {
  it('"N work orders · N pieces for this order · N on hold · N after due" (made-to-measure units count one each)', () => {
    expect(workSummaryOf(WORK)).toEqual({ count: 2 + 12, pieces: 8 + 6 + 12, onHold: 1, afterDue: 0 })
    const late = { ...WORK, workOrders: [{ ...first, daysLate: 3 }, second] }
    expect(workSummaryOf(late).afterDue).toBe(1)
  })

  it('On hold has its own words and the warning tone, never the raw key (B1)', () => {
    expect(statusKeyOf('ON_HOLD')).toBe('productionTab.wo.onHold')
    expect(statusKeyOf('RELEASED')).toBe('woStatus.RELEASED')
    expect(WO_TONE.ON_HOLD).toBe('warning')
    expect(unitStateKeyOf('DRAFT')).toBe('productionTab.wo.unitDraft')
  })

  it('ONE figure and the other steps beside it; the quality step is "checked" (B4); a step not counted is null, never 0', () => {
    const view = workProgressOf({ cells: 4, pieces: 8, cut: 8, sewn: 5, checked: 2 }, 'IN_PROGRESS')
    expect(view.step).toBe('checked')
    expect(view.others).toEqual([{ step: 'cut', value: 8 }, { step: 'sewn', value: 5 }])
    const noSewing = workProgressOf({ cells: 3, pieces: 6, cut: 3, sewn: null, checked: 0 }, 'RELEASED')
    expect(noSewing.others.find((entry) => entry.step === 'sewn')?.value).toBeNull()
    expect(workProgressOf({ cells: 1, pieces: 4, cut: 0, sewn: null, checked: 0 }, 'DRAFT').others).toEqual([])
  })

  it('dates: the plan’s end and "after due" only when the server sends the risk (B-PT-001); a shared row gets none', () => {
    expect(workDatesOf(first)).toEqual({ due: '2026-12-05', daysLate: null, planEnd: null, planned: null, afterDue: false, risk: null })
    const risky = { ...first, risk: { state: 'AT_RISK' as const, daysLate: null, plannedEnd: '2026-12-09', planAfterDue: true, raised: null, blockedBy: null } }
    expect(workDatesOf(risky)).toEqual({ due: '2026-12-05', daysLate: null, planEnd: '2026-12-09', planned: true, afterDue: true, risk: { state: 'AT_RISK', blockedBy: null } })
    expect(workDatesOf({ ...risky, risk: { ...risky.risk, plannedEnd: null, planAfterDue: false, state: 'ON_TRACK' } })).toMatchObject({ planned: false, risk: null })
    expect(workDatesOf({ ...risky, sharedWithOtherCustomers: true })).toMatchObject({ planEnd: null, planned: null, afterDue: false, risk: null })
    expect(afterDueOf({ daysLate: 2, risk: undefined })).toBe(true)
    expect(priorityShownOf(0)).toBeNull()
    expect(priorityShownOf(200)).toBe(200)
  })
})

describe('F-PT-104: the row’s acts — hidden without the right (L9), held only by state', () => {
  const read = (rights: { manage: boolean; release: boolean; hold: boolean }) => workActsRead(rights).work!.workOrders
  const planner = actsCanOf(['workorders.view', 'workorders.manage', 'workorders.release', 'workorders.hold', 'planning.view'])
  const sales = actsCanOf(['workorders.view'])

  it('a planner: every act, Due and Priority and rush in place; nothing hidden', () => {
    const row = read({ manage: true, release: true, hold: true }).find((entry) => entry.number === 'WO-00021')!
    const shown = shownActsOf(rowActsOf(row, planner))
    expect(shown.inline).toBe(true)
    expect(shown.acts).toContain('note')
    expect(shown.hidden).toBe(false)
  })

  it('Sales: no act, no in-place field — the row’s links stay and the section says who does it', () => {
    const row = read({ manage: false, release: false, hold: false }).find((entry) => entry.number === 'WO-00021')!
    const shown = shownActsOf(rowActsOf(row, sales))
    expect(shown.acts).toEqual([])
    expect(shown.inline).toBe(false)
    expect(shown.links).toEqual(['open'])
    expect(shown.hidden).toBe(true)
  })

  it('F-PT-104b: the ⋯ only with an act, Priority and rush… or a link the row does not give (Open in Planning)', async () => {
    const { rowMenuShown } = await import('./work')
    expect(rowMenuShown({ acts: [], links: ['open'], inline: false, hidden: true })).toBe(false)
    expect(rowMenuShown({ acts: [], links: ['planning', 'open'], inline: false, hidden: true })).toBe(true)
    expect(rowMenuShown({ acts: ['note'], links: ['open'], inline: false, hidden: false })).toBe(true)
    expect(rowMenuShown({ acts: [], links: ['open'], inline: true, hidden: false })).toBe(true)
  })

  it('a shared work order: nothing but its link and its words (R-11)', () => {
    const row = read({ manage: true, release: true, hold: true }).find((entry) => entry.sharedWithOtherCustomers)!
    expect(shownActsOf(rowActsOf(row, planner))).toEqual({ acts: [], links: [], inline: false, hidden: false })
  })
})

describe('F-PT-105: the waiting decisions and the made-to-measure units', () => {
  // fx8: a change as the read sends it — its kind, its cells (the schema requires them: never absent), its work order (none: a MAKE_MORE)
  // and the request it came from.
  const change = (over: Record<string, unknown>) => ({ id: 'c1', status: 'PROPOSED', kind: 'MAKE_MORE', proposedAt: '2026-11-20T09:00:00Z', mayDecide: true, workOrder: null, requestId: null, cells: [{ salesOrderLineId: 'l1', lineSeq: 10, size: '50', from: 0, to: 6, workOrderSizeId: null }], words: { title: w('Make 6 more', 'Crea altri 6'), status: w('x', 'x'), cells: 'Red 6' }, ...over }) as never

  it('every PROPOSED change, oldest first — a MAKE_MORE with no work order too (B5); at most 3, then how many more', () => {
    const list = [change({ id: 'c2', proposedAt: '2026-11-21T09:00:00Z' }), change({ id: 'c1' }), change({ id: 'c3', status: 'APPLIED' }), change({ id: 'c4', proposedAt: '2026-11-22T09:00:00Z' }), change({ id: 'c5', proposedAt: '2026-11-23T09:00:00Z', workOrder: null })]
    const view = decisionsOf(list)
    expect(view.shown.map((row) => row.id)).toEqual(['c1', 'c2', 'c4'])
    expect(view.more).toBe(1)
    expect(view.shown[0]).toMatchObject({ id: 'c1', at: '2026-11-20T09:00:00Z', mayDecide: true })
    // Each row says its change as a sentence (here: six more on line 10, the order's own change).
    expect(view.shown[0]!.sentence).toEqual({ verb: { key: 'productionTab.wo.decision.moreLines', params: { count: 6, what: '', lines: 1 } }, why: { key: 'productionTab.wo.decision.byOrder', params: { seq: 10 } } })
    expect(decisionsOf(null)).toEqual({ shown: [], more: 0 })
  })

  it('units: the list B-PT-003 sends (`unitList`, by number; how many more); none sent: null — the count stays `units`', () => {
    const group = WORK.mtm[0]!
    expect(unitsOf(group)).toBeNull()
    const units = [{ id: 'u2', number: 'WO-0421', status: 'RELEASED', lineSeq: 40 }, { id: 'u1', number: 'WO-0420', status: 'DRAFT', lineSeq: 40 }]
    expect(unitsOf({ ...group, unitList: units, unitsMore: 10 })).toEqual({ units: [units[1], units[0]], more: 10 })
    expect(unitsOf({ ...group, unitList: units })?.more).toBe(0)
  })

  it('the words in it + en; the section file holds the rows and their anchors', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['productionTab.wo.title', 'productionTab.wo.summary', 'productionTab.wo.onHold', 'productionTab.wo.rush', 'productionTab.wo.toldAt', 'productionTab.wo.planEnds', 'productionTab.wo.notPlanned', 'productionTab.wo.afterDue', 'productionTab.wo.priority', 'productionTab.wo.priorityRush', 'productionTab.wo.ask', 'productionTab.wo.decisions', 'productionTab.wo.decide', 'productionTab.wo.decisionsMore', 'productionTab.wo.unitDraft', 'productionTab.wo.details', 'productionTab.step.cut', 'productionTab.step.sewn', 'productionTab.step.checked'])
        expect(t(key, { count: 2, pieces: 8, onHold: 1, afterDue: 1, number: 'WO-1', time: '21 Nov 10:42', date: '3 Dec', value: 200, figure: 'x' }), `${locale} ${key}`).not.toMatch(/^productionTab\.|\{/)
    }
    const it_ = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect(it_('productionTab.wo.onHold')).toBe('In sospeso')
    expect(it_('productionTab.wo.rush')).toBe('Urgente (fabbrica)')
    const section = readFileSync(new URL('../view/production/WorkOrdersSection.tsx', import.meta.url), 'utf8')
    expect(section).toContain("id={rowAnchor('WorkOrder', row.id)}")
    expect(section).toContain("t('productionTab.wo.toldAt', { time: formatDateTime(floorAt, { locale }) })")
  })
})

// ---- fx5 #13 (30-walk.md): the waiting change as a sentence, never "54 1 → 0" -----------------------------------------------------------
describe('fx5: the decision strip says what the change does', () => {
  const lines = [{ seq: 1, style: { code: 'SEED-JKT-02' }, colourway: { code: 'BLK', name: 'Black' } }, { seq: 2, style: { code: 'SEED-JKT-02' }, colourway: { code: 'RED', name: 'Red' } }]
  const cell = (lineSeq: number | null, from: number, to: number) => ({ salesOrderLineId: 'l', lineSeq, size: '50', from, to, workOrderSizeId: null })

  it('make more of one line, raised by the customer: "Make 6 more SEED-JKT-02 · Red — the customer changed line 2"', () => {
    const sentence = decisionSentenceOf({ kind: 'MAKE_MORE', cells: [cell(2, 0, 4), cell(2, 0, 2)], workOrder: null, requestId: 'r1' } as never, lines)
    expect(sentence).toEqual({ verb: { key: 'productionTab.wo.decision.more', params: { count: 6, what: 'SEED-JKT-02 · Red', lines: 1 } }, why: { key: 'productionTab.wo.decision.byCustomer', params: { seq: 2 } } })
  })

  it('fewer on a work order, by the order’s own change; several lines say how many', () => {
    expect(decisionSentenceOf({ kind: 'LOWER_TO_ORDER', cells: [cell(1, 1, 0)], workOrder: { id: 'w', number: 'SEED-WO-0001', status: 'RELEASED' }, requestId: null } as never, lines)).toEqual({ verb: { key: 'productionTab.wo.decision.fewer', params: { count: 1, what: 'SEED-JKT-02 · Black', lines: 1, number: 'SEED-WO-0001' } }, why: { key: 'productionTab.wo.decision.byOrder', params: { seq: 1 } } })
    expect(decisionSentenceOf({ kind: 'LOWER_TO_ORDER', cells: [cell(1, 2, 1), cell(2, 3, 1)], workOrder: { id: 'w', number: 'SEED-WO-0001', status: 'RELEASED' }, requestId: null } as never, lines).why).toEqual({ key: 'productionTab.wo.decision.byOrderLines', params: { count: 2 } })
  })

  it('its words exist in both languages and never show the raw cells', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      expect(t('productionTab.wo.decision.more', { count: 6, what: 'SEED-JKT-02 · Red' }), locale).toMatch(/6.*SEED-JKT-02 · Red/)
      for (const key of ['fewer', 'moreLines', 'fewerLines', 'byCustomer', 'byCustomerLines', 'byOrder', 'byOrderLines', 'proposed']) expect(t(`productionTab.wo.decision.${key}`, { count: 2, what: 'x', lines: 2, number: 'N', seq: 1, date: 'd' }), `${locale} ${key}`).not.toMatch(/productionTab\.|\{/)
    }
    const view = readFileSync(new URL('../view/production/WorkOrdersSection.tsx', import.meta.url), 'utf8')
    expect(view).not.toContain('row.cells')
  })
})
