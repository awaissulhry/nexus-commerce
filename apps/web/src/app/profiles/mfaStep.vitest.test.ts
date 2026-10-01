import { describe, expect, it } from 'vitest'
import { mfaStepOf } from './mfaStep'

describe('the profiles page says which two-factor step opens business profiles', () => {
  it('nothing to do when the sign-in is complete or two-factor does not apply', () => {
    expect(mfaStepOf(null)).toBeNull()
    expect(mfaStepOf({ mfaIncomplete: false, mfaEnabled: true })).toBeNull()
    expect(mfaStepOf({ mfaEnabled: false })).toBeNull()
  })
  it('two-factor set up, this sign-in without a code: sign in again', () => {
    expect(mfaStepOf({ mfaIncomplete: true, mfaEnabled: true })).toBe('sign-in-again')
  })
  it('two-factor required but not set up: set it up', () => {
    expect(mfaStepOf({ mfaIncomplete: true, mfaEnabled: false })).toBe('set-up')
  })
})
