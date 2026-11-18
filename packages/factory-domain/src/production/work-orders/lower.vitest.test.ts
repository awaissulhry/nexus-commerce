import { describe, expect, it } from 'vitest'
import { cutLinePlan, cutLineRefusal, cutOrderStand, followedQuantity, loweredTo, LOWER_WORDS, type CutLineFacts } from './lower'

/** B-SA-040: production's "Lower to the order", pure (lead pick R1). */

const line = (over: Partial<CutLineFacts>): CutLineFacts => ({ lineId: 'l1', cutOrderId: 'c1', number: 'CO-0001', seq: 10, stand: 'FOLLOWS', garments: 0, ...over })

describe('Lower to the order (B-SA-040)', () => {
  it('goes to the figure asked, never below what is cut and never above what it makes now', () => {
    expect(loweredTo(40, 36, 0)).toBe(36)
    expect(loweredTo(40, 36, 38)).toBe(38)
    expect(loweredTo(40, 0, 0)).toBe(0)
    expect(loweredTo(40, 36, 40)).toBe(40)
    expect(loweredTo(40, 44, 0)).toBe(40)
  })

  it('reads a cut order as following, fixed, being cut or cut', () => {
    expect(cutOrderStand({ kind: 'LEATHER', status: 'PLANNED' })).toBe('FOLLOWS')
    expect(cutOrderStand({ kind: 'FABRIC', status: 'PLANNED' })).toBe('FIXED')
    expect(cutOrderStand({ kind: 'LEATHER', status: 'RELEASED' })).toBe('FIXED')
    expect(cutOrderStand({ kind: 'FABRIC', status: 'IN_PROGRESS' })).toBe('CUTTING')
    expect(cutOrderStand({ kind: 'LEATHER', status: 'CUT' })).toBe('CUT')
    expect(cutOrderStand({ kind: 'FABRIC', status: 'RECONCILED' })).toBe('CUT')
  })

  it('lowers the following lines, the latest first, only as far as the figure asked needs', () => {
    const plan = cutLinePlan([line({ lineId: 'a', seq: 10, garments: 20 }), line({ lineId: 'b', seq: 20, garments: 20 })], 36)
    expect(plan).toEqual({ ok: true, lowered: [{ lineId: 'b', cutOrderId: 'c1', number: 'CO-0001', from: 20, to: 16 }] })
    expect(cutLinePlan([line({ lineId: 'a', garments: 10 })], 0)).toEqual({ ok: true, lowered: [{ lineId: 'a', cutOrderId: 'c1', number: 'CO-0001', from: 10, to: 0 }] })
    expect(cutLinePlan([line({ garments: 10 })], 12)).toEqual({ ok: true, lowered: [] })
  })

  it('refuses in words when a fixed cut order still holds more than the figure asked; a cut one is what is cut', () => {
    const fixed = cutLinePlan([line({ stand: 'FIXED', number: 'CO-0007', garments: 40 })], 36)
    expect(fixed).toEqual({ ok: false, code: 'REPLAN_LAY', number: 'CO-0007' })
    expect(cutLineRefusal(fixed as Extract<typeof fixed, { ok: false }>).words).toEqual({ en: 'Re-plan the lay of CO-0007 first', it: 'Ripianifica prima il piazzamento di CO-0007' })
    expect(cutLinePlan([line({ stand: 'CUTTING', number: 'CO-0008', garments: 40 })], 36)).toEqual({ ok: false, code: 'CUTTING_UNDER_WAY', number: 'CO-0008' })
    // A following line gives back first: the fixed one is then within the figure.
    expect(cutLinePlan([line({ stand: 'FIXED', number: 'CO-0007', garments: 30 }), line({ lineId: 'b', garments: 10 })], 36)).toMatchObject({ ok: true, lowered: [{ lineId: 'b', to: 6 }] })
    // What is cut holds what is cut: no refusal (the database's floor keeps the cell at least that).
    expect(cutLinePlan([line({ stand: 'CUT', garments: 40 })], 36)).toEqual({ ok: true, lowered: [] })
  })

  it('lets a planned material follow its cell down, rounded up, never up and never to nothing', () => {
    expect(followedQuantity('12.0000', 6, 4)).toBe('8')
    expect(followedQuantity('1', 3, 2)).toBe('0.6667')
    expect(followedQuantity('0.0001', 2, 1)).toBeNull()
    expect(followedQuantity('8', 4, 4)).toBeNull()
    expect(followedQuantity('8', 4, 0)).toBeNull()
  })

  it('says it in Italian and English, naming sizes and numbers only', () => {
    expect(LOWER_WORDS.lowered('52', 40, 36)).toEqual({ en: 'Lowered to the order: 52 40 → 36', it: "Ridotto all'ordine: 52 40 → 36" })
    expect(LOWER_WORDS.alreadyCut(38)).toEqual({ en: 'Already cut: 38', it: 'Già tagliati: 38' })
  })
})
