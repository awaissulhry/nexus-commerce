import { describe, expect, it } from 'vitest'
import { placeProblems, placeRefusal, reasonsInForce, releasePermissionFor, releaseProblems, releaseRefusal, type HoldFacts } from './holds'
import { SHIPPING_HOLDS_ADDS, SHIPPING_HOLDS_MANAGE, SHIPPING_HOLDS_RELEASE } from './permissions'
import { LIFT_WORDS, systemHoldPlan, wantedHolds, type SystemHoldFacts } from './system'

// Made-up facts: dates, numbers and codes are invented for the test.
const at = (iso: string) => new Date(iso)
const hold = (over: Partial<HoldFacts>): HoldFacts => ({ id: 'h1', reason: 'CUSTOMER_REQUEST', placedAt: at('2026-11-10T08:00:00Z'), placedById: 'person-1', releasedAt: null, releasedById: null, ...over })

describe('placing and releasing a hold (LOG-017)', () => {
  it('needs words for OTHER only, at most 2000 characters', () => {
    expect(placeProblems({ reason: 'OTHER', words: ' ' })).toEqual([{ path: 'words', message: 'Say in words why the shipment is held.' }])
    expect(placeProblems({ reason: 'CUSTOMER_REQUEST' })).toEqual([])
    expect(placeProblems({ reason: 'QUALITY', words: 'x'.repeat(2001) })[0]!.path).toBe('words')
    expect(releaseProblems('')).toHaveLength(1)
    expect(releaseProblems('The customer paid by transfer.')).toEqual([])
  })

  it('holds only a shipment that has not left, once per reason in force', () => {
    expect(placeRefusal({ number: 'SH-1', status: 'SHIPPED' }, 'QUALITY', [])?.code).toBe('NOT_OPEN')
    expect(placeRefusal({ number: 'SH-1', status: 'PACKED' }, 'QUALITY', [hold({ reason: 'QUALITY' })])?.code).toBe('ALREADY_HELD')
    expect(placeRefusal({ number: 'SH-1', status: 'PACKED' }, 'QUALITY', [hold({ reason: 'QUALITY', releasedAt: at('2026-11-11T08:00:00Z') })])).toBeNull()
    expect(placeRefusal({ number: 'SH-1', status: 'DRAFT' }, 'CREDIT', [hold({ reason: 'QUALITY' })])).toBeNull()
  })

  it('lets only allowed roles release: money and system holds need shipping.holds.release', () => {
    expect(releasePermissionFor('CUSTOMER_REQUEST', false)).toBe(SHIPPING_HOLDS_MANAGE)
    expect(releasePermissionFor('BALANCE_UNPAID', false)).toBe(SHIPPING_HOLDS_RELEASE)
    expect(releasePermissionFor('OTHER', true)).toBe(SHIPPING_HOLDS_RELEASE)
    const desk = (permission: string) => permission === SHIPPING_HOLDS_MANAGE
    expect(releaseRefusal('SH-1', hold({ reason: 'QUALITY' }), desk)).toBeNull()
    expect(releaseRefusal('SH-1', hold({ reason: 'CREDIT' }), desk)?.code).toBe('MAY_NOT_RELEASE')
    expect(releaseRefusal('SH-1', hold({ reason: 'QUALITY', placedById: null }), desk)?.message).toMatch(/system's hold/)
    expect(releaseRefusal('SH-1', hold({ releasedAt: at('2026-11-11T08:00:00Z') }), () => true)?.code).toBe('NOT_IN_FORCE')
  })

  it('lists the reasons in force in their order, and gives the warehouse and finance their permissions', () => {
    expect(reasonsInForce([hold({ reason: 'OTHER' }), hold({ reason: 'CREDIT' }), hold({ reason: 'QUALITY', releasedAt: at('2026-11-11T08:00:00Z') })])).toEqual(['CREDIT', 'OTHER'])
    expect(SHIPPING_HOLDS_ADDS).toEqual({ warehouse: [SHIPPING_HOLDS_MANAGE], finance: [SHIPPING_HOLDS_MANAGE, SHIPPING_HOLDS_RELEASE] })
  })
})

describe("the system's holds (FIN-079, LQ1:01)", () => {
  const base: SystemHoldFacts = { customerCode: 'TEST-C1', orderNumber: 'SO-TEST-1', balanceOpenSince: null, accountHolds: [], creditHeld: null, holds: [] }

  // owb- (order workflow, S3 ss1 step 1.4; R39 (a)): flipped — the balance before shipping is no longer a hold (a warning when the
  // goods leave, modules/shipping); the system lifts its old balance holds, never a person's.
  it('never wants the balance before shipping, open or not, and lifts its own old balance hold', () => {
    const open = { ...base, balanceOpenSince: at('2026-11-01T09:00:00Z') }
    expect(wantedHolds(open)).toEqual([])
    expect(systemHoldPlan(open).place).toEqual([])
    const placed = hold({ id: 'sys', reason: 'BALANCE_UNPAID', placedById: null })
    expect(systemHoldPlan({ ...open, holds: [placed] }).lift.map((row) => row.id)).toEqual(['sys'])
    expect(systemHoldPlan({ ...base, holds: [placed] }).lift.map((row) => row.id)).toEqual(['sys'])
    expect(LIFT_WORDS.BALANCE_UNPAID).toMatch(/no longer holds the shipment/)
  })

  it("never lifts a person's balance hold (the hand hold stays), and never places one again", () => {
    const personal = hold({ id: 'p', reason: 'BALANCE_UNPAID', placedById: 'person-1' })
    expect(systemHoldPlan({ ...base, balanceOpenSince: at('2026-11-01T09:00:00Z'), holds: [personal] })).toEqual({ place: [], lift: [] })
    const letGo = hold({ id: 'sys', reason: 'BALANCE_UNPAID', placedById: null, releasedAt: at('2026-11-05T10:00:00Z'), releasedById: 'finance-1' })
    expect(systemHoldPlan({ ...base, balanceOpenSince: at('2026-11-06T09:00:00Z'), holds: [letGo] }).place).toEqual([])
  })

  it('maps account holds and the credit limit to credit, quality and other holds', () => {
    const facts = { ...base, accountHolds: [{ reason: 'LEGAL', placedAt: at('2026-11-02T09:00:00Z') }, { reason: 'QUALITY_DISPUTE', placedAt: at('2026-11-03T09:00:00Z') }], creditHeld: { since: null } }
    const wanted = wantedHolds(facts)
    expect(wanted.map((row) => row.reason)).toEqual(['CREDIT', 'QUALITY', 'OTHER'])
    expect(wanted[0]!.words).toMatch(/^TEST-C1 is over the credit limit/)
    expect(wanted[2]!.words).toMatch(/a legal matter/)
  })
})
