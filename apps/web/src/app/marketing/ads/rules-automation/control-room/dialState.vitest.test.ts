/**
 * Group 1 (1g, review finding 2.9) — the Control Room's account level (the dial), Stop now and Start again.
 *
 * Before: a stopped account showed one button, Resume, whatever stopped it. Resume clears a halt and cannot move the
 * dial, so an account whose dial was at Off showed Resume, the press changed nothing, and no screen could turn the
 * dial back up (only Claude could).
 *
 * CR rebuild 1: the words are the Control Room's one level scale (SUGGEST = "Ask me"), and Stop now asks first.
 */
import { describe, expect, it } from 'vitest'
import { canConfirmAction } from '@/design-system/components/ActionConfirm'
import { validateImpact } from '@/design-system/grid/actions/registry'
import { accountStatus, dialMove, haltMove, resumeMove, DIAL_LABEL, DIAL_MEANS, type AccountGlobal } from './dialState'

const g = (over: Partial<AccountGlobal> = {}): AccountGlobal => ({ autonomy: 'AUTO', halted: false, degraded: false, envKill: false, ...over })

describe('the top band and its button', () => {
  it('THE REGRESSION: a level at Off gets no Start again; the level is what turns it back on', () => {
    expect(accountStatus(g({ autonomy: 'OFF' }), 0, true)).toEqual({
      stopped: true,
      headline: 'Off',
      detail: 'Nothing changes your ads by itself. Raise the level to Ask me or Auto to start again.',
      action: null,
      dialLocked: null,
    })
  })

  it('a stop gets Start again; stopped with the level at Off says both steps', () => {
    expect(accountStatus(g({ halted: true }), 0, true)).toMatchObject({
      stopped: true, headline: 'Stopped', action: 'resume', detail: 'Nothing raises or adds to your ads by itself until you press Start again. Bids can still go down to their floor.',
    })
    expect(accountStatus(g({ halted: true, autonomy: 'OFF' }), 0, true)).toMatchObject({
      action: 'resume', detail: 'Stopped, and the level is Off. Press Start again, then raise the level. Bids can still go down to their floor.',
    })
  })

  it('at Auto it says how many change the ads alone, and never says "running" when none does', () => {
    expect(accountStatus(g(), 4, true)).toMatchObject({ stopped: false, headline: 'Running', action: 'halt', detail: '4 automations change your ads by themselves.' })
    expect(accountStatus(g(), 1, true).detail).toBe('1 automation changes your ads by itself.')
    expect(accountStatus(g(), 0, true)).toMatchObject({ headline: 'Auto is allowed', detail: 'No automation changes your ads by itself now.' })
    // Not counted yet (or a read failed): never a false "none".
    expect(accountStatus(g(), null, true)).toMatchObject({ headline: 'Auto is allowed', detail: 'What changes your ads by itself could not be counted yet.' })
  })

  it('Ask me (SUGGEST) says what it holds and what it does not, and offers Stop now', () => {
    expect(DIAL_LABEL.SUGGEST).toBe('Ask me')
    expect(accountStatus(g({ autonomy: 'SUGGEST' }), 0, true)).toMatchObject({ stopped: false, headline: 'Ask me first', action: 'halt', detail: DIAL_MEANS.SUGGEST })
  })

  it('the server emergency switch: no button, and plain words instead of the variable name', () => {
    const s = accountStatus(g({ envKill: true }), 0, true)
    expect(s).toMatchObject({ stopped: true, headline: 'Stopped by the server', action: null })
    expect(s.detail).not.toMatch(/NEXUS_/)
    expect(s.dialLocked).toBe('The server’s emergency switch holds everything off, whatever the level says.')
  })

  it('the level is locked, with the reason in words, when the state is unreadable or the person may not change it', () => {
    expect(accountStatus(g({ degraded: true, autonomy: 'SUGGEST' }), 0, true).dialLocked).toBe('The level could not be read.')
    expect(accountStatus(g(), 0, false)).toMatchObject({ action: 'halt', dialLocked: 'Changing the level needs the ads automation permission.' })
  })
})

describe('moving the level asks first', () => {
  it('nothing to ask when the choice is where the level already is, or not a level', () => {
    expect(dialMove(g(), 'AUTO')).toBeNull()
    expect(dialMove(g(), 'MANUAL')).toBeNull()
    expect(dialMove(g({ autonomy: 'weird' }), 'OFF')).toBeNull()
  })

  it('up from Off: a confirmation that needs the tick before Confirm arms, and says the stop stays', () => {
    const move = dialMove(g({ autonomy: 'OFF', halted: true }), 'AUTO')!
    expect(move.to).toBe('AUTO')
    expect(move.impact.title).toBe('Raise the account level to Auto?')
    expect(move.impact.consequences).toEqual([
      'The account level goes from Off to Auto for this business, from each rule’s and engine’s next run.',
      DIAL_MEANS.AUTO,
      'Automation is stopped and stays stopped until you press Start again. The level does not clear a stop.',
    ])
    expect(validateImpact(move.impact)).toEqual([])
    expect(canConfirmAction(move.impact, '', false)).toBe(false)
    expect(canConfirmAction(move.impact, '', true)).toBe(true)
  })

  it('down to Off: a plain confirmation that says bids at their floor stay there', () => {
    const move = dialMove(g({ autonomy: 'SUGGEST' }), 'OFF')!
    expect(move.impact.title).toBe('Lower the account level to Off?')
    expect(move.impact.consequences?.[0]).toBe('The account level goes from Ask me to Off for this business, from each rule’s and engine’s next run.')
    expect(move.impact.consequences).toContain(DIAL_MEANS.OFF)
    expect(DIAL_MEANS.OFF).toContain('Bids at their floor stay there until you raise the level.')
    expect(validateImpact(move.impact)).toEqual([])
    expect(canConfirmAction(move.impact, '', false)).toBe(true)
  })
})

describe('Stop now and Start again ask first', () => {
  it('Stop now is a plain question: no tick, so the brake stays one confirm away', () => {
    const impact = haltMove()
    expect(impact.title).toBe('Stop all ads automation now?')
    expect(impact.confirmLabel).toBe('Stop now')
    expect(impact.consequences).toContain('Bids can still go down to their floor: a stop never holds a bid high.')
    expect(validateImpact(impact)).toEqual([])
    expect(canConfirmAction(impact, '', false)).toBe(true)
  })

  it('Start again needs the tick while anything may act; at Off it says nothing will act and needs none', () => {
    const auto = resumeMove(g({ halted: true }))
    expect(auto.title).toBe('Start ads automation again?')
    expect(auto.consequences).toEqual(['The stop is cleared. Rules and engines act again from their next run, at the account level Auto.'])
    expect(validateImpact(auto)).toEqual([])
    expect(canConfirmAction(auto, '', false)).toBe(false)
    expect(canConfirmAction(auto, '', true)).toBe(true)

    expect(canConfirmAction(resumeMove(g({ halted: true, autonomy: 'SUGGEST' })), '', false)).toBe(false)
    const atOff = resumeMove(g({ halted: true, autonomy: 'OFF' }))
    expect(atOff.consequences).toEqual(['The stop is cleared. The level is Off, so nothing acts until you raise it.'])
    expect(validateImpact(atOff)).toEqual([])
    expect(canConfirmAction(atOff, '', false)).toBe(true)
  })
})
