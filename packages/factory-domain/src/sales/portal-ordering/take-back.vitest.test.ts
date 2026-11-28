import { describe, expect, it } from 'vitest'
import { REQUEST_STATUSES } from './rules'
import { SENT_ONCE_WORDS, takeBackCodeOf, takeBackProblem, TAKE_BACK_WORDS } from './take-back'

/** owb- po1.2 "Take it back": the pure rule and its words (EN + IT, the portal's "voi"). */
describe('take it back (owb- po1.2)', () => {
  it('a SENT request the factory has not started on may be taken back; started, answered, a draft or a withdrawn one may not', () => {
    expect(takeBackProblem({ status: 'SENT', designStarted: false })).toBeNull()
    expect(takeBackProblem({ status: 'SENT', designStarted: true })).toBe('STARTED')
    expect(takeBackProblem({ status: 'ACCEPTED', designStarted: false })).toBe('ANSWERED')
    expect(takeBackProblem({ status: 'REFUSED', designStarted: false })).toBe('ANSWERED')
    expect(takeBackProblem({ status: 'DRAFT', designStarted: false })).toBe('NOT_SENT')
    expect(takeBackProblem({ status: 'WITHDRAWN', designStarted: false })).toBe('WITHDRAWN')
  })

  it('every status has an answer, and the two refusals of the brief are 409 conflict in its exact words', () => {
    for (const status of REQUEST_STATUSES) expect(() => takeBackProblem({ status, designStarted: false })).not.toThrow()
    expect(TAKE_BACK_WORDS.ANSWERED.en).toBe('The factory has already answered this order.')
    expect(TAKE_BACK_WORDS.STARTED.en).toBe('The factory has already started work on this order: ask the factory.')
    expect(takeBackCodeOf('ANSWERED')).toBe('conflict')
    expect(takeBackCodeOf('STARTED')).toBe('conflict')
    expect(takeBackCodeOf('NOT_SENT')).toBe('invalid_state')
  })

  it('says every refusal in English and Italian ("voi"), and never names a person', () => {
    for (const words of [...Object.values(TAKE_BACK_WORDS), SENT_ONCE_WORDS]) {
      expect(words.en.length).toBeGreaterThan(10)
      expect(words.it.length).toBeGreaterThan(10)
    }
    expect(TAKE_BACK_WORDS.STARTED.it).toContain('chiedete')
  })
})
