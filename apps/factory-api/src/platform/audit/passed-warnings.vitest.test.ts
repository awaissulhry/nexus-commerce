import { describe, expect, it } from 'vitest'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { mapError } from '../../core/errors'
import { checkWarnings, passedWarningsAfter, warningIssuePath } from './passed-warnings'

/** owb- (order workflow, b2.5): warn, don't stop — 409 with the list until passed on; the passed list on the command's own audit row. */
describe('checkWarnings', () => {
  it('nothing found: goes on, nothing passed', () => {
    expect(checkWarnings([], undefined)).toEqual([])
    expect(checkWarnings([], ['PAYMENT_DUE_AT_SHIP'])).toEqual([])
  })

  it('a found warning not passed on: a 409 in words that lists it (path warning/<KIND>)', () => {
    let thrown: unknown = null
    try {
      checkWarnings(['PAYMENT_DUE_AT_SHIP'], undefined)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DomainError)
    const mapped = mapError(thrown)
    expect(mapped).toMatchObject({ status: 409, code: 'conflict', issues: [{ path: warningIssuePath('PAYMENT_DUE_AT_SHIP'), message: 'A payment due before shipping is still open.' }] })
    expect(mapped.message).toContain('A payment due before shipping is still open.')
    expect(() => checkWarnings(['PAYMENT_DUE_AT_SHIP'], [])).toThrow(DomainError)
    expect(() => checkWarnings(['PAYMENT_DUE_AT_SHIP'], null)).toThrow(DomainError)
  })

  it('passed on: goes on and returns the passed list once each', () => {
    expect(checkWarnings(['PAYMENT_DUE_AT_SHIP', 'PAYMENT_DUE_AT_SHIP'], ['PAYMENT_DUE_AT_SHIP'])).toEqual(['PAYMENT_DUE_AT_SHIP'])
  })
})

describe('passedWarningsAfter', () => {
  it('the command\'s own audit row keeps the passed list and the reason; nothing when none was passed', () => {
    expect(passedWarningsAfter(['PAYMENT_DUE_AT_SHIP'], 'The customer pays on delivery, agreed by phone.')).toEqual({ passedWarnings: ['PAYMENT_DUE_AT_SHIP'], reason: 'The customer pays on delivery, agreed by phone.' })
    expect(passedWarningsAfter(['PAYMENT_DUE_AT_SHIP'])).toEqual({ passedWarnings: ['PAYMENT_DUE_AT_SHIP'], reason: null })
    expect(passedWarningsAfter(['PAYMENT_DUE_AT_SHIP'], '   ')).toEqual({ passedWarnings: ['PAYMENT_DUE_AT_SHIP'], reason: null })
    expect(passedWarningsAfter([])).toEqual({})
    expect({ status: 'SHIPPED', ...passedWarningsAfter(checkWarnings(['PAYMENT_DUE_AT_SHIP'], ['PAYMENT_DUE_AT_SHIP'])) }).toEqual({ status: 'SHIPPED', passedWarnings: ['PAYMENT_DUE_AT_SHIP'], reason: null })
  })
})
