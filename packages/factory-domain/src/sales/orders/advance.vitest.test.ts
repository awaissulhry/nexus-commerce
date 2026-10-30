import { describe, expect, it } from 'vitest'
import type { Instalment } from '../terms/terms'
import { ADVANCE_STEP_KINDS, isAdvanceStep, remadeSchedule, stepRequestFor, stepStays, type StoredMilestone } from './schedule'

/**
 * B-W2a-F2: a step paid before the goods leave is an advance (DPR 633/1972 art. 6 c.4), so a BEFORE_SHIPPING step has a
 * deposit request of its own (the money module's TD02 flow invoices a payment through it), pure. Amounts made up.
 */

const DEP30: Instalment[] = [
  { sharePct: '30.0000', from: 'ORDER', days: 0, endOfMonth: false },
  { sharePct: '70.0000', from: 'BEFORE_SHIPPING', days: 5, endOfMonth: false },
]

describe("a before-shipping step's deposit request (B-W2a-F2)", () => {
  it('the deposit and the balance before shipping are the steps paid through a request of their own', () => {
    expect(ADVANCE_STEP_KINDS).toEqual(['DEPOSIT', 'BEFORE_SHIPPING'])
    expect(['DEPOSIT', 'BEFORE_SHIPPING', 'ON_DELIVERY', 'ON_INVOICE'].map((kind) => isAdvanceStep(kind as never))).toEqual([true, true, false, false])
  })

  it("an Italian business: an acconto of the step's amount, due on the step's day, a TD02 when paid", () => {
    expect(stepRequestFor({ kind: 'BEFORE_SHIPPING', amount: 532_896, sharePct: '70.0000', dueDate: '2026-12-15' }, 'EUR', { taxMode: 'IT_B2B' })).toEqual({
      kind: 'ACCONTO',
      depositPct: '70.0000',
      currency: 'EUR',
      amount: 532_896,
      dueDate: '2026-12-15',
      fiscalDocument: 'TD02',
      fiscalRule: 'DEPOSIT_INVOICE_IT',
      reason: 'Italian business: the deposit is invoiced on the day it is paid.',
    })
  })

  it("the deposit's own fiscal rule: an EU business with a VIES proof buying goods asks no TD02; no tax identity: a TD02", () => {
    const step = { kind: 'BEFORE_SHIPPING' as const, amount: 70_000, sharePct: '70.0000', dueDate: '2026-12-15' }
    expect(stepRequestFor(step, 'EUR', { taxMode: 'EU_B2B', viesValid: true })).toMatchObject({ fiscalDocument: 'NONE', fiscalRule: 'DEPOSIT_EU_B2B_GOODS' })
    expect(stepRequestFor(step, 'EUR', null)).toMatchObject({ kind: 'ACCONTO', fiscalDocument: 'TD02', fiscalRule: 'DEPOSIT_INVOICE_IT' })
  })

  it('no request for another kind of step, a step of nothing, or a step without its day yet', () => {
    expect(stepRequestFor({ kind: 'ON_INVOICE', amount: 70_000, sharePct: '70.0000', dueDate: '2026-12-15' }, 'EUR', { taxMode: 'IT_B2B' })).toBeNull()
    expect(stepRequestFor({ kind: 'DEPOSIT', amount: 30_000, sharePct: '30.0000', dueDate: '2026-11-01' }, 'EUR', { taxMode: 'IT_B2B' })).toBeNull()
    expect(stepRequestFor({ kind: 'BEFORE_SHIPPING', amount: 0, sharePct: null, dueDate: '2026-12-15' }, 'EUR', { taxMode: 'IT_B2B' })).toBeNull()
    expect(stepRequestFor({ kind: 'BEFORE_SHIPPING', amount: 70_000, sharePct: '70.0000', dueDate: null }, 'EUR', { taxMode: 'IT_B2B' })).toBeNull()
  })

  it('an amendment cancels an unpaid before-shipping step (with its request) and keeps a part-paid one', () => {
    const deposit: StoredMilestone = { id: 'm1', seq: 10, kind: 'DEPOSIT', status: 'PAID', amount: 30_000, dueDate: '2026-11-01', depositRequestId: 'd1' }
    const unpaid: StoredMilestone = { id: 'm2', seq: 20, kind: 'BEFORE_SHIPPING', status: 'OPEN', amount: 70_000, dueDate: '2026-12-15', depositRequestId: 'd2', requestPaid: 0 }
    expect(stepStays(unpaid)).toBe(false)
    expect(remadeSchedule([deposit, unpaid], { gross: 120_000, instalments: DEP30, promiseDate: '2026-12-20' })).toEqual({
      cancel: ['m2'],
      insert: [{ seq: 30, kind: 'BEFORE_SHIPPING', sharePct: '75.0000', amount: 90_000, dueDate: '2026-12-15', depositRequestId: null }],
      overpaid: 0,
    })
    // Part paid: its TD02s name it; it stays, and the rest of the new gross falls due on the invoice.
    const partPaid: StoredMilestone = { ...unpaid, requestPaid: 20_000 }
    expect(stepStays(partPaid)).toBe(true)
    expect(remadeSchedule([deposit, partPaid], { gross: 120_000, instalments: DEP30, promiseDate: '2026-12-20' })).toEqual({
      cancel: [],
      insert: [{ seq: 30, kind: 'ON_INVOICE', sharePct: '16.6667', amount: 20_000, dueDate: null, depositRequestId: null }],
      overpaid: 0,
    })
    // An unchanged total changes nothing (the step and its request stay).
    expect(remadeSchedule([deposit, unpaid], { gross: 100_000, instalments: DEP30, promiseDate: '2026-12-20' })).toEqual({ cancel: [], insert: [], overpaid: 0 })
  })
})
