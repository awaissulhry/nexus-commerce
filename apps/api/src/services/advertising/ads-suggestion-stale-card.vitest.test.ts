/**
 * Review 2026-10-08 — a target-ACoS bid card shows the bid a person approves. Since the ÷ r̂ formula (and the data-day
 * wait) the rule may ask another bid than an old card shows: the approval compares the card with the rule's dry run and
 * refuses a stale one, so Nexus never writes a different bid than the person saw. The end-to-end case (a 44¢ → 34¢ card
 * that now computes 55¢) runs on PGlite in ads-strategy/bids.vitest.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))
const { staleBidCardSentence } = await import('./ads-suggestion-decide.service.js')

const card = (wouldChange: unknown) => ({ type: 'bid_apply', op: 'targetAcos', value: 35, wouldChange })
const live = (wouldChange: string, extra: Record<string, unknown> = {}) => ({ ok: true, output: { dryRun: true, wouldChange, ...extra } })

describe('a bid card is current only when the rule still asks its bid', () => {
  it('the other way (44¢ → 34¢ shown, 44¢ → 55¢ asked): out of date, said with both', () => {
    expect(staleBidCardSentence(card('44¢ → 34¢'), live('44¢ → 55¢'))).toBe("The bid this card shows is out of date: it shows 44¢ → 34¢, and the rule now asks 44¢ → 55¢ — refresh. Nothing was written; the card stays waiting, and the rule's next run refreshes or expires it.")
  })

  it('the same way within 2¢ / 10 % (the larger) of the shown bid: current; beyond it: out of date', () => {
    expect(staleBidCardSentence(card('44¢ → 55¢'), live('44¢ → 60¢'))).toBeNull() // 5¢ ≤ 10 % of 55¢
    expect(staleBidCardSentence(card('44¢ → 55¢'), live('44¢ → 61¢'))).toMatch(/^The bid this card shows is out of date/)
    expect(staleBidCardSentence(card('10¢ → 12¢'), live('10¢ → 14¢'))).toBeNull() // 2¢ (10 % of 12¢ is less)
    expect(staleBidCardSentence(card('10¢ → 12¢'), live('10¢ → 15¢'))).toMatch(/out of date/)
    // The bid moved since the card, but the rule still asks the bid shown: current.
    expect(staleBidCardSentence(card('44¢ → 55¢'), live('46¢ → 55¢'))).toBeNull()
  })

  it('the rule now asks nothing (it waits a data day, the bid is already right, the handler failed): out of date, with why', () => {
    expect(staleBidCardSentence(card('44¢ → 34¢'), { ok: true, output: { skipped: 'waits_for_evidence', why: 'already moved on data day 2026-10-01 (44 → 50¢ by automation:auto-bid) — one move per data day' } }))
      .toBe("The bid this card shows is out of date: it shows 44¢ → 34¢, and the rule now asks no change (already moved on data day 2026-10-01 (44 → 50¢ by automation:auto-bid) — one move per data day). Nothing was written; the card stays waiting, and the rule's next run refreshes or expires it.")
    expect(staleBidCardSentence(card('44¢ → 34¢'), live('34¢ → 34¢', { noChange: true }))).toMatch(/now asks no change \(the bid is already where the rule wants it\)/)
    expect(staleBidCardSentence(card('44¢ → 34¢'), { ok: false, error: 'no measured clicks' })).toMatch(/now asks no change \(no measured clicks\)/)
  })

  it('a card that shows no bid has nothing to compare', () => {
    expect(staleBidCardSentence(card(undefined), live('44¢ → 55¢'))).toBeNull()
    expect(staleBidCardSentence(null, live('44¢ → 55¢'))).toBeNull()
  })
})
