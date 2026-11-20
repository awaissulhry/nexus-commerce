import { describe, expect, it } from 'vitest'
import { SALES_ORDER_STATUSES, type SalesOrderStatus } from '../sales/orders/orders'
import {
  floorAlreadyWords,
  HAND_STAGE_CHOICES,
  HAND_STAGES,
  handSetOld,
  handStageChoicesOf,
  handStands,
  isHandStage,
  shownStageOf,
  STAGE_BY_HAND_WORDS,
  STAGE_SET_CHECK_DAYS,
  STAGE_SET_NOTE_MAX,
  STAGE_SET_REASON_CODES,
  STAGE_SET_REFUSAL_WORDS,
  STAGE_SET_REFUSALS,
  STAGE_SET_STATUSES,
  stageSetAskProblems,
  stageSetProblems,
  stageSetStateProblems,
  type StageSetAsk,
  type StageSetState,
} from './stage-set'
import { BRAND_STAGES, brandStageRank, type BrandStage } from './stages'

/**
 * B-MS-001: the hand stage's rules (set the stage by hand, plan.md D1–D9; design A; R4, R14, R19). Pure.
 */

const words = (refusal: keyof typeof STAGE_SET_REFUSAL_WORDS) => STAGE_SET_REFUSAL_WORDS[refusal].en

describe('B-MS-001 what may be set by hand, and its limits', () => {
  it('Cutting, Sewing or Quality check — never Preparing, never Ready to ship (Owner D1)', () => {
    expect([...HAND_STAGES]).toEqual(['CUTTING', 'SEWING', 'QUALITY'])
    expect(BRAND_STAGES.filter(isHandStage)).toEqual(['CUTTING', 'SEWING', 'QUALITY'])
    expect(isHandStage('READY')).toBe(false)
    expect(isHandStage('PREPARING')).toBe(false)
  })

  it('the four reasons (the database enum keeps these names), a one-line note of 200, amber after 7 days', () => {
    expect([...STAGE_SET_REASON_CODES]).toEqual(['OUTAGE', 'FEW_PEOPLE', 'OUTSIDE', 'OTHER'])
    expect(STAGE_SET_NOTE_MAX).toBe(200)
    expect(STAGE_SET_CHECK_DAYS).toBe(7)
  })

  it('only In production and Partly shipped orders (R4)', () => {
    expect(SALES_ORDER_STATUSES.filter((status) => (STAGE_SET_STATUSES as readonly string[]).includes(status))).toEqual(['IN_PRODUCTION', 'PARTLY_SHIPPED'])
  })
})

describe('B-MS-001 the shown stage: the higher of the floor and the hand (the keeper’s one rule)', () => {
  it('every pair', () => {
    for (const floor of BRAND_STAGES) {
      expect(shownStageOf(floor, null)).toBe(floor)
      for (const hand of HAND_STAGES) {
        const higher = brandStageRank(hand) > brandStageRank(floor) ? hand : floor
        expect(shownStageOf(floor, hand)).toBe(higher)
      }
    }
  })

  it('no goods line open: nothing is shown, as the floor (no hand stage stands)', () => {
    expect(shownStageOf(null, null)).toBeNull()
    for (const hand of HAND_STAGES) expect(shownStageOf(null, hand)).toBeNull()
  })

  it('a stored value that is no hand stage never leads', () => {
    expect(shownStageOf('CUTTING', 'READY')).toBe('CUTTING')
    expect(shownStageOf('PREPARING', 'PREPARING')).toBe('PREPARING')
  })
})

describe('B-MS-001 a hand stage stands until the floor reaches or passes it', () => {
  it('at each floor stage', () => {
    for (const floor of BRAND_STAGES) {
      for (const hand of HAND_STAGES) expect(handStands(floor, hand)).toBe(brandStageRank(hand) > brandStageRank(floor))
    }
    expect(handStands('PREPARING', 'CUTTING')).toBe(true)
    expect(handStands('CUTTING', 'CUTTING')).toBe(false)
    expect(handStands('QUALITY', 'SEWING')).toBe(false)
    expect(handStands('READY', 'QUALITY')).toBe(false)
  })

  it('never with no open goods line', () => {
    for (const hand of HAND_STAGES) expect(handStands(null, hand)).toBe(false)
  })
})

describe('B-MS-001 every refusal, in words (en + it)', () => {
  const ok: StageSetState & StageSetAsk = { status: 'IN_PRODUCTION', floor: 'PREPARING', hand: null, paused: false, stage: 'CUTTING', reasonCode: 'OUTAGE', note: null }
  const problems = (over: Partial<StageSetState & StageSetAsk>) => stageSetProblems({ ...ok, ...over })

  it('every refusal has both languages', () => {
    for (const refusal of STAGE_SET_REFUSALS) {
      expect(STAGE_SET_REFUSAL_WORDS[refusal].en.length).toBeGreaterThan(0)
      expect(STAGE_SET_REFUSAL_WORDS[refusal].it.length).toBeGreaterThan(0)
    }
    expect(floorAlreadyWords('SEWING')).toEqual({ it: 'Il reparto segna già Cucitura.', en: 'The floor already shows Sewing.' })
  })

  it('a Set on an In production or a Partly shipped order, ahead of the floor, passes', () => {
    expect(problems({})).toEqual([])
    expect(problems({ status: 'PARTLY_SHIPPED', floor: 'CUTTING', stage: 'QUALITY', reasonCode: 'FEW_PEOPLE' })).toEqual([])
    expect(problems({ reasonCode: 'OUTSIDE', note: 'At the outside workshop since Monday' })).toEqual([])
  })

  it('a Confirmed order (or one waiting for a yes): production has not started yet (R4)', () => {
    expect(problems({ status: 'CONFIRMED' })).toEqual([{ path: 'body/stage', message: 'Production has not started yet: a stage is set by hand only once the order is in production.' }])
    expect(problems({ status: 'PENDING_APPROVAL' })).toEqual([{ path: 'body/stage', message: words('NOT_STARTED') }])
  })

  it('a Ready order: nothing ahead; a shipped, delivered, closed or cancelled one: production is over', () => {
    expect(problems({ status: 'READY', floor: 'READY', stage: 'QUALITY' })).toEqual([{ path: 'body/stage', message: words('ALREADY_READY') }])
    for (const status of ['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const satisfies readonly SalesOrderStatus[]) {
      expect(problems({ status, floor: null })).toEqual([{ path: 'body/stage', message: words('PRODUCTION_OVER') }])
    }
    // Only the two states pass the status rule.
    for (const status of SALES_ORDER_STATUSES) {
      const refused = stageSetStateProblems({ ...ok, status }).length > 0
      expect(refused).toBe(!(STAGE_SET_STATUSES as readonly string[]).includes(status))
    }
  })

  it('Ready and Preparing are never asked by hand; an unknown stage is refused', () => {
    expect(problems({ stage: 'READY' })).toEqual([{ path: 'body/stage', message: "Only quality's release of every piece makes it Ready to ship." }])
    expect(problems({ stage: 'PREPARING' })).toEqual([{ path: 'body/stage', message: words('NEVER_PREPARING') }])
    expect(problems({ stage: 'PACKING' })).toEqual([{ path: 'body/stage', message: 'Expected one of CUTTING, SEWING, QUALITY.' }])
  })

  it('at or below the floor: the floor already shows it', () => {
    expect(problems({ floor: 'SEWING', stage: 'SEWING' })).toEqual([{ path: 'body/stage', message: 'The floor already shows Sewing.' }])
    expect(problems({ floor: 'SEWING', stage: 'CUTTING' })).toEqual([{ path: 'body/stage', message: 'The floor already shows Sewing.' }])
    expect(problems({ status: 'PARTLY_SHIPPED', floor: 'READY', stage: 'QUALITY' })).toEqual([{ path: 'body/stage', message: 'The floor already shows Ready to ship.' }])
  })

  it('nothing left to make: no stage to set', () => {
    expect(problems({ floor: null })).toEqual([{ path: 'body/stage', message: words('NOTHING_LEFT') }])
  })

  it("held while the customer's own pause stands (R19)", () => {
    expect(problems({ paused: true })).toEqual([{ path: 'body/stage', message: "Paused at the customer's request: lift the pause first." }])
  })

  it('Something else needs a note; the note is one line of at most 200', () => {
    expect(problems({ reasonCode: 'OTHER' })).toEqual([{ path: 'body/note', message: 'Something else needs a note.' }])
    expect(problems({ reasonCode: 'OTHER', note: '   ' })).toEqual([{ path: 'body/note', message: words('NOTE_NEEDED') }])
    expect(problems({ reasonCode: 'OTHER', note: 'Scanned on paper, keyed in later' })).toEqual([])
    expect(problems({ note: 'one line\nand another' })).toEqual([{ path: 'body/note', message: 'The note is one line of at most 200 characters.' }])
    expect(problems({ note: 'x'.repeat(201) })).toEqual([{ path: 'body/note', message: words('NOTE_TOO_LONG') }])
    expect(problems({ note: 'x'.repeat(200) })).toEqual([])
    expect(problems({ note: `  ${'x'.repeat(200)}  ` })).toEqual([])
  })

  it('an unknown reason code is refused', () => {
    expect(problems({ reasonCode: 'SHORT_STAFFED' })).toEqual([{ path: 'body/reasonCode', message: 'Expected one of OUTAGE, FEW_PEOPLE, OUTSIDE, OTHER.' }])
  })

  it('a Change may go down while it stays above the floor (Owner D9); never to or below the floor', () => {
    expect(problems({ floor: 'PREPARING', hand: 'QUALITY', stage: 'CUTTING' })).toEqual([])
    expect(problems({ floor: 'CUTTING', hand: 'QUALITY', stage: 'SEWING' })).toEqual([])
    expect(problems({ floor: 'CUTTING', hand: 'QUALITY', stage: 'CUTTING' })).toEqual([{ path: 'body/stage', message: 'The floor already shows Cutting.' }])
    // The same stage again with another reason: a Change of its words.
    expect(problems({ floor: 'CUTTING', hand: 'SEWING', stage: 'SEWING', reasonCode: 'FEW_PEOPLE' })).toEqual([])
  })

  it('the ask (400) and the order (409) apart; the order first; paths under `at`', () => {
    expect(stageSetAskProblems({ stage: 'CUTTING', reasonCode: 'OUTAGE' })).toEqual([])
    expect(stageSetAskProblems({ stage: 'READY', reasonCode: 'NOPE', note: 'a\nb' }, 'input').map((issue) => issue.path)).toEqual(['input/stage', 'input/reasonCode', 'input/note'])
    expect(stageSetStateProblems({ status: 'IN_PRODUCTION', floor: 'SEWING', hand: null, paused: true, stage: 'CUTTING' })).toEqual([
      { path: 'body/stage', message: words('PAUSED') },
      { path: 'body/stage', message: 'The floor already shows Sewing.' },
    ])
    // A stage that is no hand stage is the ask's problem only, never also "the floor already shows".
    expect(stageSetStateProblems({ status: 'IN_PRODUCTION', floor: 'SEWING', hand: null, paused: false, stage: 'PREPARING' })).toEqual([])
    expect(problems({ status: 'CONFIRMED', stage: 'READY' }).map((issue) => issue.message)).toEqual([words('NOT_STARTED'), words('NEVER_READY')])
  })
})

describe("B-MS-001 the dialog's rows: done, now, open, set, Ready held", () => {
  const rows = (floor: BrandStage, hand: BrandStage | null) => Object.fromEntries(handStageChoicesOf(floor, hand).map((row) => [row.stage, row.choice]))

  it('for each floor stage, without a hand stage', () => {
    expect([...HAND_STAGE_CHOICES]).toEqual(['DONE', 'NOW', 'OPEN', 'SET', 'READY_HELD'])
    expect(rows('PREPARING', null)).toEqual({ PREPARING: 'NOW', CUTTING: 'OPEN', SEWING: 'OPEN', QUALITY: 'OPEN', READY: 'READY_HELD' })
    expect(rows('CUTTING', null)).toEqual({ PREPARING: 'DONE', CUTTING: 'NOW', SEWING: 'OPEN', QUALITY: 'OPEN', READY: 'READY_HELD' })
    expect(rows('SEWING', null)).toEqual({ PREPARING: 'DONE', CUTTING: 'DONE', SEWING: 'NOW', QUALITY: 'OPEN', READY: 'READY_HELD' })
    expect(rows('QUALITY', null)).toEqual({ PREPARING: 'DONE', CUTTING: 'DONE', SEWING: 'DONE', QUALITY: 'NOW', READY: 'READY_HELD' })
    expect(rows('READY', null)).toEqual({ PREPARING: 'DONE', CUTTING: 'DONE', SEWING: 'DONE', QUALITY: 'DONE', READY: 'NOW' })
    // One row per stage, in order.
    expect(handStageChoicesOf('PREPARING', null).map((row) => row.stage)).toEqual([...BRAND_STAGES])
  })

  it('with a hand stage: it reads SET (a Change pre-picks it); the stages between it and the floor stay open (going down)', () => {
    expect(rows('PREPARING', 'SEWING')).toEqual({ PREPARING: 'NOW', CUTTING: 'OPEN', SEWING: 'SET', QUALITY: 'OPEN', READY: 'READY_HELD' })
    expect(rows('CUTTING', 'QUALITY')).toEqual({ PREPARING: 'DONE', CUTTING: 'NOW', SEWING: 'OPEN', QUALITY: 'SET', READY: 'READY_HELD' })
    expect(rows('PREPARING', 'CUTTING')).toEqual({ PREPARING: 'NOW', CUTTING: 'SET', SEWING: 'OPEN', QUALITY: 'OPEN', READY: 'READY_HELD' })
  })

  it('a hand stage the floor reached no longer reads SET: the floor’s counts decide', () => {
    expect(rows('SEWING', 'SEWING')).toEqual(rows('SEWING', null))
    expect(rows('QUALITY', 'CUTTING')).toEqual(rows('QUALITY', null))
  })
})

describe('B-MS-001 the office’s 7-day reminder, and the export’s words', () => {
  it('amber at 7 days, not at 6 (calendar days, company time)', () => {
    expect(handSetOld('2026-11-13T09:00:00Z', '2026-11-20')).toBe(true)
    expect(handSetOld(new Date('2026-11-13T09:00:00Z'), '2026-11-20')).toBe(true)
    expect(handSetOld('2026-11-14T09:00:00Z', '2026-11-20')).toBe(false)
    expect(handSetOld('2026-11-01T09:00:00Z', '2026-11-20')).toBe(true)
    // 23:30 UTC on 13 Nov is already 14 Nov in Rome: 6 days.
    expect(handSetOld('2026-11-13T23:30:00Z', '2026-11-20')).toBe(false)
    expect(handSetOld('2026-11-20T08:00:00Z', '2026-11-20')).toBe(false)
    expect(handSetOld('not a time', '2026-11-20')).toBe(false)
  })

  it('"Sewing (by hand)" in the office export', () => {
    expect(STAGE_BY_HAND_WORDS).toEqual({ it: '(a mano)', en: '(by hand)' })
  })
})
