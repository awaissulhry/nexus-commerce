/**
 * Group 1 (1g, review finding 2.9) — the Control Room's account dial and Resume.
 *
 * Before: a stopped account showed one button, Resume, whatever stopped it. Resume clears a halt and cannot move the
 * dial, so an account whose dial was at Off showed Resume, the press changed nothing, and no screen could turn the
 * dial back up (only Claude could).
 */
import { describe, expect, it } from 'vitest'
import { canConfirmAction } from '@/design-system/components/ActionConfirm'
import { validateImpact } from '@/design-system/grid/actions/registry'
import { accountStatus, dialMove, DIAL_MEANS, type AccountGlobal } from './dialState'

const g = (over: Partial<AccountGlobal> = {}): AccountGlobal => ({ autonomy: 'AUTO', halted: false, degraded: false, envKill: false, ...over })

describe('the status line and its button', () => {
  it('THE REGRESSION: a dial at Off gets no Resume; the dial is what turns it back on', () => {
    const s = accountStatus(g({ autonomy: 'OFF' }), 0, 9, true)
    expect(s).toEqual({
      stopped: true,
      headline: 'Automation is stopped',
      detail: 'The dial is at Off. Turn the dial to Suggest or Auto to start again.',
      action: null,
      dialLocked: null,
    })
  })

  it('a halt gets Resume; halted with the dial at Off says both steps', () => {
    expect(accountStatus(g({ halted: true }), 0, 9, true)).toMatchObject({ stopped: true, action: 'resume', detail: 'Halted. No engine can write to Amazon until you resume.' })
    expect(accountStatus(g({ halted: true, autonomy: 'OFF' }), 0, 9, true)).toMatchObject({
      action: 'resume', detail: 'Halted, and the dial is at Off. Resume clears the halt; then turn the dial up to start again.',
    })
  })

  it('running at Auto offers Stop everything; Suggest says what it holds and what it does not', () => {
    expect(accountStatus(g(), 4, 9, true)).toMatchObject({ stopped: false, headline: 'Automation is running', action: 'halt', detail: '4 of 9 engines are acting on their own.' })
    expect(accountStatus(g({ autonomy: 'SUGGEST' }), 0, 9, true)).toMatchObject({ stopped: false, action: 'halt', detail: `The dial is at Suggest. ${DIAL_MEANS.SUGGEST}` })
  })

  it('the dial is locked, with the reason in words, when the env kill is set, the state is unreadable, or the person may not change it', () => {
    expect(accountStatus(g({ envKill: true }), 0, 9, true)).toMatchObject({ action: null, dialLocked: 'The server kill switch stops everything, whatever the dial says.' })
    expect(accountStatus(g({ degraded: true, autonomy: 'SUGGEST' }), 0, 9, true).dialLocked).toBe('The dial could not be read.')
    expect(accountStatus(g(), 0, 9, false)).toMatchObject({ action: 'halt', dialLocked: 'Changing the dial needs the ads automation permission.' })
  })
})

describe('moving the dial asks first', () => {
  it('nothing to ask when the choice is where the dial already is, or not a dial level', () => {
    expect(dialMove(g(), 'AUTO')).toBeNull()
    expect(dialMove(g(), 'MANUAL')).toBeNull()
    expect(dialMove(g({ autonomy: 'weird' }), 'OFF')).toBeNull()
  })

  it('up from Off: a confirmation that needs the acknowledgement before Confirm arms, and says the halt stays', () => {
    const move = dialMove(g({ autonomy: 'OFF', halted: true }), 'AUTO')!
    expect(move.to).toBe('AUTO')
    expect(move.impact.title).toBe('Turn the account dial up to Auto?')
    expect(move.impact.consequences).toEqual([
      'The account dial goes from Off to Auto for this business, from each rule\'s and engine\'s next run.',
      DIAL_MEANS.AUTO,
      'Automation is halted and stays stopped until you press Resume. The dial does not clear a halt.',
    ])
    expect(validateImpact(move.impact)).toEqual([])
    expect(canConfirmAction(move.impact, '', false)).toBe(false)
    expect(canConfirmAction(move.impact, '', true)).toBe(true)
  })

  it('down to Off: a plain confirmation that says bids at their floor stay there', () => {
    const move = dialMove(g({ autonomy: 'SUGGEST' }), 'OFF')!
    expect(move.impact.title).toBe('Turn the account dial down to Off?')
    expect(move.impact.consequences).toContain(DIAL_MEANS.OFF)
    expect(DIAL_MEANS.OFF).toContain('Bids already at their floor stay there until the dial is turned up.')
    expect(validateImpact(move.impact)).toEqual([])
    expect(canConfirmAction(move.impact, '', false)).toBe(true)
  })
})
