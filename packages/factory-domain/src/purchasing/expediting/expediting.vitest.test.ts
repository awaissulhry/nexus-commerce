import { describe, expect, it } from 'vitest'
import { chaseMail, chaseProblem, confirmedLaterByOf, expectedDayOf, expediteOrder, expediteReasonsOf, lateByOf, nextDeliveryOf, type RankFacts } from './worklist'

// Hand-computed cases (B-W2b-305). Days are made up; today is Thursday 12 November 2026.
const today = '2026-11-12'
const now = new Date('2026-11-12T09:00:00.000Z')

describe('the day an open line is expected', () => {
  const deliveries = [
    { seq: 2, baseQuantity: '6.0000', needDate: '2026-12-20', confirmedDate: '2026-12-27' },
    { seq: 1, baseQuantity: '4.0000', needDate: '2026-11-10', confirmedDate: null },
  ]
  it('the next delivery what came does not cover, by base quantity in order', () => {
    expect(nextDeliveryOf(deliveries, '0')?.seq).toBe(1)
    expect(nextDeliveryOf(deliveries, '3.9999')?.seq).toBe(1)
    expect(nextDeliveryOf(deliveries, '4')?.seq).toBe(2)
    expect(nextDeliveryOf(deliveries, '10')).toBeNull()
    expect(nextDeliveryOf([], '0')).toBeNull()
  })
  it('its day: the supplier’s, else the day asked; a line without a schedule its own', () => {
    expect(expectedDayOf({ needDate: '2026-11-10', confirmedDate: null }, nextDeliveryOf(deliveries, '4'))).toBe('2026-12-27')
    expect(expectedDayOf({ needDate: '2026-11-10', confirmedDate: null }, nextDeliveryOf(deliveries, '0'))).toBe('2026-11-10')
    expect(expectedDayOf({ needDate: '2026-11-10', confirmedDate: '2026-11-14' }, null)).toBe('2026-11-14')
  })
})

describe('why a line is on the worklist (SCM-068)', () => {
  const base = { orderStatus: 'CONFIRMED', needDate: '2026-11-20', confirmedDate: '2026-11-20', expectedDate: '2026-11-20', deliveries: [], confirmBy: null, today, now }
  it('in time and confirmed as asked: not listed', () => {
    expect(expediteReasonsOf(base)).toEqual([])
  })
  it('LATE: expected before today', () => {
    expect(expediteReasonsOf({ ...base, expectedDate: '2026-11-11' })).toEqual(['LATE'])
  })
  it('NOT_CONFIRMED: still waiting for the answer after confirm-by (not before it, not once answered)', () => {
    expect(expediteReasonsOf({ ...base, orderStatus: 'SENT', confirmedDate: null, confirmBy: new Date('2026-11-12T08:00:00.000Z') })).toEqual(['NOT_CONFIRMED'])
    expect(expediteReasonsOf({ ...base, orderStatus: 'SENT', confirmedDate: null, confirmBy: new Date('2026-11-12T10:00:00.000Z') })).toEqual([])
    expect(expediteReasonsOf({ ...base, orderStatus: 'CONFIRMED', confirmBy: new Date('2026-11-12T08:00:00.000Z') })).toEqual([])
  })
  it('CONFIRMED_LATE: the line or a delivery confirmed later than asked (the most days)', () => {
    expect(expediteReasonsOf({ ...base, confirmedDate: '2026-11-25', expectedDate: '2026-11-25' })).toEqual(['CONFIRMED_LATE'])
    const scheduled = { ...base, deliveries: [{ seq: 1, baseQuantity: '1', needDate: '2026-11-20', confirmedDate: '2026-11-20' }, { seq: 2, baseQuantity: '1', needDate: '2026-12-01', confirmedDate: '2026-12-08' }] }
    expect(confirmedLaterByOf(scheduled)).toBe(7)
    expect(expediteReasonsOf(scheduled)).toEqual(['CONFIRMED_LATE'])
  })
  it('several reasons at once', () => {
    expect(expediteReasonsOf({ ...base, orderStatus: 'CHANGES_PROPOSED', confirmedDate: '2026-11-11', needDate: '2026-11-05', expectedDate: '2026-11-11', confirmBy: new Date('2026-11-01T00:00:00.000Z') })).toEqual(['LATE', 'NOT_CONFIRMED', 'CONFIRMED_LATE'])
  })
  it('a demand is late by the days the line is expected after it is needed', () => {
    expect(lateByOf('2026-11-25', '2026-11-20')).toBe(5)
    expect(lateByOf('2026-11-15', '2026-11-20')).toBe(0)
  })
})

describe('the rank: customer orders at risk first, not days late alone', () => {
  const row = (number: string, facts: Partial<RankFacts>): RankFacts => ({ salesOrdersAtRisk: 0, earliestPromise: null, workOrdersAtRisk: 0, daysLate: 0, expectedDate: '2026-11-20', number, seq: 10, ...facts })
  it('orders by customer orders at risk, the earliest promise, work orders at risk, days late, the day, the number', () => {
    const rows = [
      row('PO-A', { daysLate: 30 }),
      row('PO-B', { salesOrdersAtRisk: 1, earliestPromise: '2026-12-01' }),
      row('PO-C', { salesOrdersAtRisk: 1, earliestPromise: '2026-11-25' }),
      row('PO-D', { workOrdersAtRisk: 2 }),
      row('PO-E', { salesOrdersAtRisk: 2, earliestPromise: '2026-12-30' }),
      row('PO-F', { daysLate: 30, expectedDate: '2026-10-13' }),
    ]
    expect([...rows].sort(expediteOrder).map((entry) => entry.number)).toEqual(['PO-E', 'PO-C', 'PO-B', 'PO-D', 'PO-F', 'PO-A'])
  })
})

describe('the chase', () => {
  it('the lines in words, the buyer’s message, in Italian and English; no link, no price', () => {
    const lines = [
      { label: 'Line 10 · ART-100 Leather black', needDate: '2026-11-05', confirmedDate: '2026-11-09', reasons: ['LATE', 'CONFIRMED_LATE'] as const },
      { label: 'Line 20 · Lining grey', needDate: '2026-11-30', confirmedDate: null, reasons: ['NOT_CONFIRMED'] as const },
    ]
    const it = chaseMail({ language: 'it', number: 'SEED-PO-0007', recipientName: 'Mario Rossi', lines, message: 'Grazie.' })
    expect(it.subject).toBe('Sollecito: ordine di acquisto SEED-PO-0007')
    expect(it.body).toBe(
      [
        'Gentile Mario Rossi,',
        'le scriviamo per le righe del nostro ordine di acquisto SEED-PO-0007 qui sotto:',
        '- Line 10 · ART-100 Leather black: in ritardo: attesa per il 09/11/2026; confermata per il 09/11/2026, richiesta per il 05/11/2026\n- Line 20 · Lining grey: non ancora confermata',
        'Grazie.',
        "Ci può dire quando arriveranno? Se le date confermate non sono più valide, risponda a questa e-mail con le nuove date. Per l'ordine non ancora confermato, usi il link personale dell'e-mail con cui le abbiamo inviato l'ordine.",
      ].join('\n\n'),
    )
    const en = chaseMail({ language: 'en', number: 'SEED-PO-0007', recipientName: null, lines: [lines[0]!], message: null })
    expect(en.body.split('\n\n').slice(0, 3)).toEqual(['Hello,', 'we are writing about the lines of our purchase order SEED-PO-0007 below:', '- Line 10 · ART-100 Leather black: late: expected on 9 Nov 2026; confirmed for 9 Nov 2026, asked for 5 Nov 2026'])
    expect(en.body).not.toMatch(/#token=|EUR|€/)
  })
  it('only an order that waits for goods, with lines to chase', () => {
    expect(chaseProblem('DRAFT', 1)).toMatch(/nothing to chase/)
    expect(chaseProblem('CONFIRMED', 0)).toMatch(/No line of this order/)
    expect(chaseProblem('PARTLY_RECEIVED', 2)).toBeNull()
  })
})
