import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { priorityRushBodyOf, priorityRushHeld, PRIORITY_MAX, PRIORITY_MIN, sizeTableOf, workshopsOf } from './work-detail'

// F-PT-105 (order PRODUCTION tab, W1): the work order's window — this order's pieces per size, the workshops' days, Priority and rush….

const cell = (size: string, quantity: number, cut: number | null, extra: { sewn?: number | null; checked?: number | null } = {}) => ({ id: `c-${size}-${quantity}`, salesOrderLineId: 'l1', size, quantity, cut, ...extra })

describe('F-PT-105: per size Ordered · Cut · Sewn · Checked (this order’s cells only)', () => {
  it('before the server sends sewn / checked (B-PT-002): Ordered and Cut only — never a made-up 0', () => {
    expect(sizeTableOf([cell('48', 20, 20), cell('50', 36, 30)])).toEqual({
      sizes: ['48', '50'],
      rows: [
        { step: 'ordered', values: [20, 36], total: 56 },
        { step: 'cut', values: [20, 30], total: 50 },
      ],
    })
  })

  it('once sent: Sewn and Checked; two lines of one size summed; a step not counted there is "—" and the total too', () => {
    const table = sizeTableOf([cell('48', 10, 10, { sewn: 8, checked: null }), cell('48', 10, 10, { sewn: 2, checked: null }), cell('50', 5, 5, { sewn: 5, checked: null })])
    expect(table?.sizes).toEqual(['48', '50'])
    expect(table?.rows.find((row) => row.step === 'ordered')?.values).toEqual([20, 5])
    expect(table?.rows.find((row) => row.step === 'sewn')).toEqual({ step: 'sewn', values: [10, 5], total: 15 })
    expect(table?.rows.find((row) => row.step === 'checked')).toEqual({ step: 'checked', values: [null, null], total: null })
    expect(sizeTableOf([])).toBeNull()
    expect(sizeTableOf(undefined)).toBeNull()
  })

  it('the outside workshops with their days when sent; a name alone before', () => {
    expect(workshopsOf({ workshops: [{ name: 'Laboratorio Esempio' }] })).toEqual([{ name: 'Laboratorio Esempio', since: null, back: null }])
    expect(workshopsOf({ workshops: [{ name: 'Laboratorio Esempio', since: '2026-11-10', expectedBack: '2026-12-04' }] })).toEqual([{ name: 'Laboratorio Esempio', since: '2026-11-10', back: '2026-12-04' }])
  })
})

describe('F-PT-105: Priority and rush… — one write for both, only what changed', () => {
  const now = { priority: 100, rush: false }
  it('held in words: not a whole number in range, nothing changed, a write running', () => {
    expect(priorityRushHeld({ priority: 'x', rush: false }, now, false)).toEqual({ key: 'productionTab.priority.problem', params: { min: PRIORITY_MIN, max: PRIORITY_MAX } })
    expect(priorityRushHeld({ priority: '1001', rush: false }, now, false)?.key).toBe('productionTab.priority.problem')
    expect(priorityRushHeld({ priority: '2.5', rush: false }, now, false)?.key).toBe('productionTab.priority.problem')
    expect(priorityRushHeld({ priority: '100', rush: false }, now, false)).toEqual({ key: 'productionTab.priority.same' })
    expect(priorityRushHeld({ priority: '200', rush: false }, now, true)).toEqual({ key: 'held.busy' })
    expect(priorityRushHeld({ priority: '200', rush: true }, now, false)).toBeNull()
  })

  it('the body: only the changed fields (the acts hook adds the row’s version)', () => {
    expect(priorityRushBodyOf({ priority: '200', rush: false }, now)).toEqual({ priority: 200 })
    expect(priorityRushBodyOf({ priority: '100', rush: true }, now)).toEqual({ rush: true })
    expect(priorityRushBodyOf({ priority: '-100', rush: true }, now)).toEqual({ priority: -100, rush: true })
  })

  it('the wiring: the lib’s acts send ONE PATCH for both; the window is the DS DetailModal with ‹ › across the work orders', () => {
    const hook = readFileSync(new URL('../../../../../lib/production/work-order-acts/use-work-order-acts.ts', import.meta.url), 'utf8')
    expect(hook).toContain("onPriorityRush: (row, body) => inline(row, body.priority !== undefined ? 'priority' : 'rush', { ...body }), // F-PT-105")
    const detail = readFileSync(new URL('../view/production/WorkOrderDetail.tsx', import.meta.url), 'utf8')
    expect(detail).toContain('<DetailModal')
    expect(detail).toContain('nav={{ ids')
    expect(detail).not.toMatch(/from '[^']*use-[^']*'/)
  })

  it('the words in it + en', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['productionTab.priority.title', 'productionTab.priority.label', 'productionTab.priority.hint', 'productionTab.priority.rush', 'productionTab.priority.rushHint', 'productionTab.priority.save', 'productionTab.priority.problem', 'productionTab.priority.same', 'productionTab.detail.sizes', 'productionTab.detail.step.ordered', 'productionTab.detail.step.cut', 'productionTab.detail.step.sewn', 'productionTab.detail.step.checked', 'productionTab.detail.total', 'productionTab.detail.workshop', 'productionTab.detail.workshopBack', 'productionTab.detail.units', 'productionTab.detail.unitsMore', 'productionTab.detail.noRider', 'productionTab.detail.open', 'productionTab.detail.noun', 'productionTab.detail.plan', 'productionTab.detail.held'])
        expect(t(key, { min: -1000, max: 1000, name: 'n', since: 's', back: 'b', count: 2, number: 'WO-1', start: 'a', end: 'b', due: 'c' }), `${locale} ${key}`).not.toMatch(/^productionTab\.|\{/)
    }
  })
})
