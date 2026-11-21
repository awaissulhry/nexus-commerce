import { describe, expect, it } from 'vitest'
import { SALES_ORDER_STATUSES, type SalesOrderStatus } from '../sales/orders/orders'
import {
  floorStageWords,
  HAND_STAGE_CHOICES,
  HAND_STAGES,
  handMoveOf,
  handSetOld,
  handStageChoicesOf,
  handStands,
  isHandStage,
  READY_UNRELEASED_WORDS,
  sameStageWords,
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
 * B-MS-001: the hand stage's rules (set the stage by hand, plan.md D1–D9; design A; R4, R14, R19). B-SC-001 (stage control B, the
 * Owner's pick 2026-11-21): any stage, forward or back, also below the floor and Ready by hand (warned); the end rule E1. Pure.
 */

const words = (refusal: keyof typeof STAGE_SET_REFUSAL_WORDS) => STAGE_SET_REFUSAL_WORDS[refusal].en
const rank = brandStageRank

describe('B-SC-001 what may be set by hand, and its limits', () => {
  it('any of the five stages — Preparing and Ready to ship too (B reverses 11-20 D1)', () => {
    expect([...HAND_STAGES]).toEqual(['PREPARING', 'CUTTING', 'SEWING', 'QUALITY', 'READY'])
    expect([...HAND_STAGES]).toEqual([...BRAND_STAGES])
    expect(BRAND_STAGES.filter(isHandStage)).toEqual([...BRAND_STAGES])
    expect(isHandStage('READY')).toBe(true)
    expect(isHandStage('PREPARING')).toBe(true)
    expect(isHandStage('PACKING')).toBe(false)
  })

  it('the four reasons (the database enum keeps these names: a wrong record is Something else with a note), a one-line note of 200, amber after 7 days', () => {
    expect([...STAGE_SET_REASON_CODES]).toEqual(['OUTAGE', 'FEW_PEOPLE', 'OUTSIDE', 'OTHER'])
    expect(STAGE_SET_NOTE_MAX).toBe(200)
    expect(STAGE_SET_CHECK_DAYS).toBe(7)
  })

  it('only In production and Partly shipped orders (R4)', () => {
    expect(SALES_ORDER_STATUSES.filter((status) => (STAGE_SET_STATUSES as readonly string[]).includes(status))).toEqual(['IN_PRODUCTION', 'PARTLY_SHIPPED'])
  })

  it('a move of what the customer reads: forward, back or the same', () => {
    expect(handMoveOf('PREPARING', 'SEWING')).toBe('FORWARD')
    expect(handMoveOf('CUTTING', 'READY')).toBe('FORWARD')
    expect(handMoveOf('QUALITY', 'CUTTING')).toBe('BACK')
    expect(handMoveOf('CUTTING', 'PREPARING')).toBe('BACK')
    expect(handMoveOf('SEWING', 'SEWING')).toBe('SAME')
    for (const from of BRAND_STAGES) for (const to of BRAND_STAGES) expect(handMoveOf(from, to)).toBe(rank(to) > rank(from) ? 'FORWARD' : rank(to) < rank(from) ? 'BACK' : 'SAME')
  })
})

describe('B-SC-001 end rule E1: a hand stage stands until the floor agrees or moves on', () => {
  /** E1 written out once, for every pair: the floor now, the hand stage, the floor when it was set. */
  const e1 = (floor: BrandStage, hand: BrandStage, atSet: BrandStage | null): boolean => {
    if (floor === hand) return false
    if (atSet !== null && rank(hand) < rank(atSet)) return rank(floor) <= rank(atSet)
    return rank(floor) < rank(hand)
  }

  it('every floor, hand stage and floor at the set (with none known: as set ahead)', () => {
    for (const floor of BRAND_STAGES) {
      for (const hand of HAND_STAGES) {
        for (const atSet of [null, ...BRAND_STAGES]) expect(handStands(floor, hand, atSet), `${floor} ${hand} ${atSet}`).toBe(e1(floor, hand, atSet))
      }
    }
  })

  it('set ahead: stands while the floor is below it, ends once the floor reaches or passes it (as before B)', () => {
    expect(handStands('PREPARING', 'CUTTING', 'PREPARING')).toBe(true)
    expect(handStands('CUTTING', 'QUALITY', 'PREPARING')).toBe(true)
    expect(handStands('CUTTING', 'CUTTING', 'PREPARING')).toBe(false)
    expect(handStands('QUALITY', 'SEWING', 'CUTTING')).toBe(false)
    // Ready by hand over a floor at Quality check: stands until quality releases every piece.
    expect(handStands('QUALITY', 'READY', 'QUALITY')).toBe(true)
    expect(handStands('READY', 'READY', 'QUALITY')).toBe(false)
    // The floor going back under a forward set: it still stands.
    expect(handStands('PREPARING', 'SEWING', 'CUTTING')).toBe(true)
    // No floor at the set known (a row written before B): today's rule.
    expect(handStands('PREPARING', 'SEWING', null)).toBe(true)
    expect(handStands('QUALITY', 'SEWING', null)).toBe(false)
  })

  it('set back (a wrong scan): stands under a lower or equal floor, ends when the floor equals it or moves past where it stood at the set', () => {
    // Quality check by the floor, set back to Sewing: the floor still at Quality check — it stands (shown lower than the floor).
    expect(handStands('QUALITY', 'SEWING', 'QUALITY')).toBe(true)
    // A release past where the floor stood: quality's truth takes over.
    expect(handStands('READY', 'SEWING', 'QUALITY')).toBe(false)
    // The floor agrees (a release reversed back down to Sewing): it ends.
    expect(handStands('SEWING', 'SEWING', 'QUALITY')).toBe(false)
    // The floor drops below it: it still stands (now ahead of the floor).
    expect(handStands('CUTTING', 'SEWING', 'QUALITY')).toBe(true)
    // Preparing back from Cutting: stands at Cutting, ends at Sewing.
    expect(handStands('CUTTING', 'PREPARING', 'CUTTING')).toBe(true)
    expect(handStands('SEWING', 'PREPARING', 'CUTTING')).toBe(false)
  })

  it('never with no open goods line', () => {
    for (const hand of HAND_STAGES) for (const atSet of [null, ...BRAND_STAGES]) expect(handStands(null, hand, atSet)).toBe(false)
  })
})

describe('B-SC-001 the shown stage: the hand stage while it stands, higher or lower than the floor', () => {
  it('every pair, as E1 says', () => {
    for (const floor of BRAND_STAGES) {
      expect(shownStageOf(floor, null, null)).toBe(floor)
      for (const hand of HAND_STAGES) {
        for (const atSet of [null, ...BRAND_STAGES]) expect(shownStageOf(floor, hand, atSet)).toBe(handStands(floor, hand, atSet) ? hand : floor)
      }
    }
  })

  it('a hand stage set back reads lower than the floor; set ahead, higher', () => {
    expect(shownStageOf('QUALITY', 'SEWING', 'QUALITY')).toBe('SEWING')
    expect(shownStageOf('CUTTING', 'PREPARING', 'CUTTING')).toBe('PREPARING')
    expect(shownStageOf('PREPARING', 'READY', 'PREPARING')).toBe('READY')
    expect(shownStageOf('READY', 'SEWING', 'QUALITY')).toBe('READY')
  })

  it('no goods line open: nothing is shown, as the floor (no hand stage stands)', () => {
    expect(shownStageOf(null, null, null)).toBeNull()
    for (const hand of HAND_STAGES) expect(shownStageOf(null, hand, 'CUTTING')).toBeNull()
  })
})

describe('B-SC-001 every refusal, in words (en + it)', () => {
  const ok: StageSetState & StageSetAsk = { status: 'IN_PRODUCTION', floor: 'PREPARING', shown: 'PREPARING', hand: null, paused: false, stage: 'CUTTING', reasonCode: 'OUTAGE', note: null }
  const problems = (over: Partial<StageSetState & StageSetAsk>) => stageSetProblems({ ...ok, ...over })

  it('every refusal has both languages; Never Ready and Never Preparing are gone', () => {
    for (const refusal of STAGE_SET_REFUSALS) {
      expect(STAGE_SET_REFUSAL_WORDS[refusal].en.length).toBeGreaterThan(0)
      expect(STAGE_SET_REFUSAL_WORDS[refusal].it.length).toBeGreaterThan(0)
    }
    expect([...STAGE_SET_REFUSALS]).toEqual(['NOT_STARTED', 'ALREADY_READY', 'PRODUCTION_OVER', 'NOTHING_LEFT', 'PAUSED', 'UNKNOWN_STAGE', 'UNKNOWN_REASON', 'NOTE_NEEDED', 'NOTE_TOO_LONG'])
    expect(sameStageWords('SEWING')).toEqual({ it: 'Il cliente legge già Cucitura.', en: 'The customer already reads Sewing.' })
    expect(floorStageWords('CUTTING')).toEqual({
      it: 'Taglio è la fase del reparto: togli la fase impostata a mano per tornarci.',
      en: "Cutting is the floor's own stage: clear the stage set by hand to go back to it.",
    })
    expect(READY_UNRELEASED_WORDS).toEqual({
      it: 'La qualità non ha rilasciato tutti i capi: il cliente legge Pronto per la spedizione, i capi restano come li ha registrati la qualità.',
      en: 'Quality has not released every piece: the customer reads Ready to ship, the pieces stay as quality recorded them.',
    })
    expect(STAGE_SET_REFUSAL_WORDS.ALREADY_READY).toEqual({
      it: "L'ordine è Pronto per la spedizione: la qualità ha rilasciato ogni capo, quindi la fase non si imposta più a mano.",
      en: 'The order is Ready to ship: quality released every piece, so its stage is no longer set by hand.',
    })
  })

  it('any stage but the one the customer reads passes: forward, back, Preparing and Ready to ship', () => {
    expect(problems({})).toEqual([])
    expect(problems({ status: 'PARTLY_SHIPPED', floor: 'CUTTING', shown: 'CUTTING', stage: 'QUALITY', reasonCode: 'FEW_PEOPLE' })).toEqual([])
    expect(problems({ reasonCode: 'OUTSIDE', note: 'At the outside workshop since Monday' })).toEqual([])
    // Ready by hand (the dialog warns; never a refusal).
    expect(problems({ floor: 'QUALITY', shown: 'QUALITY', stage: 'READY' })).toEqual([])
    expect(problems({ stage: 'READY' })).toEqual([])
    // Back, also below the floor (a wrong scan): Something else with a note.
    expect(problems({ floor: 'SEWING', shown: 'SEWING', stage: 'CUTTING', reasonCode: 'OTHER', note: 'Made-up: a wrong scan on the sewing line' })).toEqual([])
    expect(problems({ floor: 'CUTTING', shown: 'CUTTING', stage: 'PREPARING', reasonCode: 'OTHER', note: 'Made-up: the cut was logged on the wrong order' })).toEqual([])
  })

  it('a Confirmed order (or one waiting for a yes): production has not started yet (R4)', () => {
    expect(problems({ status: 'CONFIRMED' })).toEqual([{ path: 'body/stage', message: 'Production has not started yet: a stage is set by hand only once the order is in production.' }])
    expect(problems({ status: 'PENDING_APPROVAL' })).toEqual([{ path: 'body/stage', message: words('NOT_STARTED') }])
  })

  it('a Ready order: quality released every piece; a shipped, delivered, closed or cancelled one: production is over', () => {
    expect(problems({ status: 'READY', floor: 'READY', shown: 'READY', stage: 'QUALITY' })).toEqual([{ path: 'body/stage', message: 'The order is Ready to ship: quality released every piece, so its stage is no longer set by hand.' }])
    for (const status of ['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const satisfies readonly SalesOrderStatus[]) {
      expect(problems({ status, floor: null, shown: null })).toEqual([{ path: 'body/stage', message: words('PRODUCTION_OVER') }])
    }
    // Only the two states pass the status rule.
    for (const status of SALES_ORDER_STATUSES) {
      const refused = stageSetStateProblems({ ...ok, status }).length > 0
      expect(refused).toBe(!(STAGE_SET_STATUSES as readonly string[]).includes(status))
    }
  })

  it('an unknown stage is refused in words (the ask, 400)', () => {
    expect(problems({ stage: 'PACKING' })).toEqual([{ path: 'body/stage', message: 'Expected one of PREPARING, CUTTING, SEWING, QUALITY, READY.' }])
  })

  it('the stage the customer reads already: "The customer already reads …" (409)', () => {
    expect(problems({ stage: 'PREPARING' })).toEqual([{ path: 'body/stage', message: 'The customer already reads Preparing.' }])
    expect(problems({ floor: 'SEWING', shown: 'SEWING', stage: 'SEWING' })).toEqual([{ path: 'body/stage', message: 'The customer already reads Sewing.' }])
    // A hand stage standing: it is the one the customer reads (a Change of its words alone is no move).
    expect(problems({ floor: 'CUTTING', shown: 'SEWING', hand: 'SEWING', stage: 'SEWING', reasonCode: 'FEW_PEOPLE' })).toEqual([{ path: 'body/stage', message: 'The customer already reads Sewing.' }])
    // No row read yet (shown null): the floor's stage is the one it reads.
    expect(problems({ floor: 'CUTTING', shown: null, stage: 'CUTTING' })).toEqual([{ path: 'body/stage', message: 'The customer already reads Cutting.' }])
  })

  it("the floor's own stage while a hand stage stands: Clear goes back to it (409)", () => {
    expect(problems({ floor: 'CUTTING', shown: 'QUALITY', hand: 'QUALITY', stage: 'CUTTING' })).toEqual([{ path: 'body/stage', message: "Cutting is the floor's own stage: clear the stage set by hand to go back to it." }])
    // Set back below the floor: the floor's own (higher) stage is Clear's too.
    expect(problems({ floor: 'QUALITY', shown: 'SEWING', hand: 'SEWING', stage: 'QUALITY' })).toEqual([{ path: 'body/stage', message: floorStageWords('QUALITY').en }])
    // Any other stage is a Change, forward or back — also below the floor.
    expect(problems({ floor: 'CUTTING', shown: 'QUALITY', hand: 'QUALITY', stage: 'SEWING' })).toEqual([])
    expect(problems({ floor: 'CUTTING', shown: 'QUALITY', hand: 'QUALITY', stage: 'PREPARING' })).toEqual([])
    expect(problems({ floor: 'QUALITY', shown: 'SEWING', hand: 'SEWING', stage: 'READY' })).toEqual([])
  })

  it('nothing left to make: no stage to set', () => {
    expect(problems({ floor: null, shown: null })).toEqual([{ path: 'body/stage', message: words('NOTHING_LEFT') }])
  })

  it("held while the customer's own pause stands (R19), forward or back", () => {
    expect(problems({ paused: true })).toEqual([{ path: 'body/stage', message: "Paused at the customer's request: lift the pause first." }])
    expect(problems({ paused: true, floor: 'SEWING', shown: 'SEWING', stage: 'CUTTING' })).toEqual([{ path: 'body/stage', message: words('PAUSED') }])
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

  it('the ask (400) and the order (409) apart; the order first; paths under `at`', () => {
    expect(stageSetAskProblems({ stage: 'CUTTING', reasonCode: 'OUTAGE' })).toEqual([])
    expect(stageSetAskProblems({ stage: 'READY', reasonCode: 'OUTAGE' })).toEqual([])
    expect(stageSetAskProblems({ stage: 'PACKING', reasonCode: 'NOPE', note: 'a\nb' }, 'input').map((issue) => issue.path)).toEqual(['input/stage', 'input/reasonCode', 'input/note'])
    expect(stageSetStateProblems({ status: 'IN_PRODUCTION', floor: 'SEWING', shown: 'SEWING', hand: null, paused: true, stage: 'SEWING' })).toEqual([
      { path: 'body/stage', message: words('PAUSED') },
      { path: 'body/stage', message: 'The customer already reads Sewing.' },
    ])
    // A stage that is no stage is the ask's problem only, never also "already reads".
    expect(stageSetStateProblems({ status: 'IN_PRODUCTION', floor: 'SEWING', shown: 'SEWING', hand: null, paused: false, stage: 'PACKING' })).toEqual([])
    expect(problems({ status: 'CONFIRMED', stage: 'PACKING' }).map((issue) => issue.message)).toEqual([words('NOT_STARTED'), words('UNKNOWN_STAGE')])
  })
})

describe("B-SC-001 the dialog's rows: now, the floor's (while a hand stage stands), ahead and back", () => {
  const rows = (floor: BrandStage | null, shown: BrandStage, hand: BrandStage | null) => Object.fromEntries(handStageChoicesOf({ floor, shown, hand }).map((row) => [row.stage, row.choice]))
  const unreleased = (floor: BrandStage | null, shown: BrandStage) => handStageChoicesOf({ floor, shown, hand: null }).filter((row) => row.readyUnreleased).map((row) => row.stage)

  it("without a hand stage: the floor's stage is NOW, every other stage ahead or back", () => {
    expect([...HAND_STAGE_CHOICES]).toEqual(['NOW', 'FLOOR', 'AHEAD', 'BACK'])
    expect(rows('PREPARING', 'PREPARING', null)).toEqual({ PREPARING: 'NOW', CUTTING: 'AHEAD', SEWING: 'AHEAD', QUALITY: 'AHEAD', READY: 'AHEAD' })
    expect(rows('SEWING', 'SEWING', null)).toEqual({ PREPARING: 'BACK', CUTTING: 'BACK', SEWING: 'NOW', QUALITY: 'AHEAD', READY: 'AHEAD' })
    expect(rows('READY', 'READY', null)).toEqual({ PREPARING: 'BACK', CUTTING: 'BACK', SEWING: 'BACK', QUALITY: 'BACK', READY: 'NOW' })
    // One row per stage, in order.
    expect(handStageChoicesOf({ floor: 'PREPARING', shown: 'PREPARING', hand: null }).map((row) => row.stage)).toEqual([...BRAND_STAGES])
  })

  it("with a hand stage: it is NOW, the floor's own stage is FLOOR (Clear… goes back to it), the rest ahead or back of what the customer reads", () => {
    expect(rows('PREPARING', 'SEWING', 'SEWING')).toEqual({ PREPARING: 'FLOOR', CUTTING: 'BACK', SEWING: 'NOW', QUALITY: 'AHEAD', READY: 'AHEAD' })
    // Set back below the floor (a wrong scan): the floor's stage is ahead of what the customer reads, and still FLOOR.
    expect(rows('QUALITY', 'SEWING', 'SEWING')).toEqual({ PREPARING: 'BACK', CUTTING: 'BACK', SEWING: 'NOW', QUALITY: 'FLOOR', READY: 'AHEAD' })
    // No goods line read: no FLOOR row.
    expect(rows(null, 'SEWING', 'SEWING')).toEqual({ PREPARING: 'BACK', CUTTING: 'BACK', SEWING: 'NOW', QUALITY: 'AHEAD', READY: 'AHEAD' })
  })

  it('Ready to ship warns while the floor is not Ready (quality has not released every piece); never once it is', () => {
    expect(unreleased('QUALITY', 'QUALITY')).toEqual(['READY'])
    expect(unreleased('PREPARING', 'PREPARING')).toEqual(['READY'])
    expect(unreleased(null, 'SEWING')).toEqual(['READY'])
    expect(unreleased('READY', 'READY')).toEqual([])
    expect(handStageChoicesOf({ floor: 'QUALITY', shown: 'QUALITY', hand: null }).find((row) => row.stage === 'READY')).toEqual({ stage: 'READY', choice: 'AHEAD', readyUnreleased: true })
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
