import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { actsCanOf, rowActsOf } from '../../../../../lib/production/work-order-acts/model'
import { WORK, workActsRead } from '../overview/fixtures'
import { afterDueOf, decisionsOf, priorityShownOf, shownActsOf, statusKeyOf, unitStateKeyOf, unitsOf, workDatesOf, workProgressOf, workSummaryOf, WO_TONE } from './work'

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

  it('a shared work order: nothing but its link and its words (R-11)', () => {
    const row = read({ manage: true, release: true, hold: true }).find((entry) => entry.sharedWithOtherCustomers)!
    expect(shownActsOf(rowActsOf(row, planner))).toEqual({ acts: [], links: [], inline: false, hidden: false })
  })
})

describe('F-PT-105: the waiting decisions and the made-to-measure units', () => {
  const change = (over: Record<string, unknown>) => ({ id: 'c1', status: 'PROPOSED', proposedAt: '2026-11-20T09:00:00Z', mayDecide: true, words: { title: w('Make 6 more', 'Crea altri 6'), status: w('x', 'x'), cells: 'Red 6' }, ...over }) as never

  it('every PROPOSED change, oldest first — a MAKE_MORE with no work order too (B5); at most 3, then how many more', () => {
    const list = [change({ id: 'c2', proposedAt: '2026-11-21T09:00:00Z' }), change({ id: 'c1' }), change({ id: 'c3', status: 'APPLIED' }), change({ id: 'c4', proposedAt: '2026-11-22T09:00:00Z' }), change({ id: 'c5', proposedAt: '2026-11-23T09:00:00Z', workOrder: null })]
    const view = decisionsOf(list)
    expect(view.shown.map((row) => row.id)).toEqual(['c1', 'c2', 'c4'])
    expect(view.more).toBe(1)
    expect(view.shown[0]).toEqual({ id: 'c1', title: w('Make 6 more', 'Crea altri 6'), cells: 'Red 6', at: '2026-11-20T09:00:00Z', mayDecide: true })
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
