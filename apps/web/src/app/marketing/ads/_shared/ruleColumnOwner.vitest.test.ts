/**
 * Bid page review F1 — the Ad Manager's bid owner (bid-grid's `bidder`) knows `brain` (BAPI, 2026-10-10): the bid brain owns
 * the campaign's bids and sets its placement % by the hour, so the Bid Rule cell says "Brain" (not the raw kind) and the
 * Bid Multiplier tooltip says the lanes are governed (not "Nothing governs these lanes").
 */
import { describe, expect, it } from 'vitest'
import { ownerBits, placementGovernor } from './RuleColumnCells'

describe('the bid owner in the Ad Manager cells', () => {
  it('the brain reads "Brain" with a short tip; a schedule and manual as before', () => {
    expect(ownerBits('brain', null, true)).toMatchObject({ text: 'Brain' })
    expect(ownerBits('brain', null, true)?.tip).not.toMatch(/Owned by brain/)
    expect(ownerBits('schedule', 'Jacket plan', true)).toMatchObject({ text: 'Jacket plan' })
    expect(ownerBits('manual', null, true)).toMatchObject({ text: 'manual' })
    expect(ownerBits('none', null, true)).toBeNull()
  })

  it('the brain and a schedule govern the placement lanes; nobody else does', () => {
    expect(placementGovernor('brain', null)).toBe('The bid brain')
    expect(placementGovernor('schedule', 'Jacket plan')).toBe('An hourly bid schedule (Jacket plan)')
    expect(placementGovernor('schedule', null)).toBe('An hourly bid schedule')
    expect(placementGovernor('manual', null)).toBeNull()
    expect(placementGovernor(null, null)).toBeNull()
  })
})
