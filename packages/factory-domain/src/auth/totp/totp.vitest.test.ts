import { describe, expect, it } from 'vitest'
import { checkTotpCode, RECOVERY_CODES, recoveryCodeFrom, recoveryCodeOf, timeStepAt, totpCodeOf, TOTP, type CodeAt } from './totp'

// Ported from Commerce's mfa.vitest.test.ts and step-up.vitest.test.ts: a code is accepted once, inside the drift
// window, and refused when replayed or malformed. The codes come from a stand-in generator (the API's otplib adapter
// is checked against the RFC 6238 vectors in apps/factory-api).
const codeAt: CodeAt = (step) => String(step % 1_000_000).padStart(6, '0')
const at = (seconds: number) => new Date(seconds * 1000)
const NOW = at(1_761_642_000) // a step boundary: 1761642000 / 30 = 58721400
const STEP = 58_721_400

describe('time steps', () => {
  it('are RFC 6238 counters of 30 seconds', () => {
    expect(TOTP).toMatchObject({ digits: 6, periodSeconds: 30, window: 1 })
    expect(timeStepAt(NOW)).toBe(STEP)
    expect(timeStepAt(at(1_761_642_029))).toBe(STEP)
    expect(timeStepAt(at(1_761_642_030))).toBe(STEP + 1)
    expect(timeStepAt(at(59))).toBe(1)
  })
})

describe('checkTotpCode', () => {
  const check = (code: unknown, lastStep: number | null = null, now = NOW) => checkTotpCode({ code, now, lastStep, codeAt })

  it('accepts the code of now, and of one step before or after (clock drift)', () => {
    expect(check(codeAt(STEP))).toEqual({ ok: true, step: STEP })
    expect(check(codeAt(STEP - 1))).toEqual({ ok: true, step: STEP - 1 })
    expect(check(codeAt(STEP + 1))).toEqual({ ok: true, step: STEP + 1 })
    expect(check(` ${codeAt(STEP).slice(0, 3)} ${codeAt(STEP).slice(3)} `)).toEqual({ ok: true, step: STEP })
  })

  it('refuses a code outside the window', () => {
    expect(check(codeAt(STEP - 2))).toEqual({ ok: false, reason: 'wrong' })
    expect(check(codeAt(STEP + 2))).toEqual({ ok: false, reason: 'wrong' })
    expect(check('000000')).toEqual({ ok: false, reason: 'wrong' })
  })

  it('refuses a replay: the step already used, or an earlier one', () => {
    expect(check(codeAt(STEP), STEP)).toEqual({ ok: false, reason: 'replayed' })
    expect(check(codeAt(STEP - 1), STEP)).toEqual({ ok: false, reason: 'replayed' })
    expect(check(codeAt(STEP - 1), STEP - 1)).toEqual({ ok: false, reason: 'replayed' })
    // The next step's code is still good after the current one was used.
    expect(check(codeAt(STEP + 1), STEP)).toEqual({ ok: true, step: STEP + 1 })
    expect(check(codeAt(STEP), STEP - 1)).toEqual({ ok: true, step: STEP })
  })

  it('takes a step after the last one when the same code matches two steps', () => {
    const repeating: CodeAt = () => '123456'
    expect(checkTotpCode({ code: '123456', now: NOW, lastStep: STEP - 1, codeAt: repeating })).toEqual({ ok: true, step: STEP })
    expect(checkTotpCode({ code: '123456', now: NOW, lastStep: STEP + 1, codeAt: repeating })).toEqual({ ok: false, reason: 'replayed' })
  })

  it('refuses anything that is not six digits, without computing a code', () => {
    let computed = 0
    const counting: CodeAt = (step) => {
      computed++
      return codeAt(step)
    }
    for (const code of ['12345', '1234567', 'abcdef', '', null, 123456, undefined]) {
      expect(checkTotpCode({ code, now: NOW, lastStep: null, codeAt: counting })).toEqual({ ok: false, reason: 'malformed' })
    }
    expect(computed).toBe(0)
    expect(totpCodeOf(' 12 34 56 ')).toBe('123456')
  })

  it('computes every step of the window, whatever matched', () => {
    const steps: number[] = []
    checkTotpCode({ code: codeAt(STEP - 1), now: NOW, lastStep: null, codeAt: (step) => (steps.push(step), codeAt(step)) })
    expect(steps).toEqual([STEP - 1, STEP, STEP + 1])
  })
})

describe('recovery codes', () => {
  it('are ten readable characters, shown in two groups', () => {
    const code = recoveryCodeFrom(new Uint8Array([0, 1, 2, 3, 4, 30, 31, 62, 255, 100]))
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/)
    // byte % 31: 0..4 → ABCDE, 30 → 9, 31 and 62 → A, 255 and 100 → H.
    expect(code).toBe('ABCDE-9AAHH')
    expect(RECOVERY_CODES.alphabet).toHaveLength(31)
    expect(RECOVERY_CODES.count).toBe(10)
    expect(() => recoveryCodeFrom(new Uint8Array(9))).toThrow(/10 random bytes/)
  })

  it('read back in one stored form, whatever the case, spaces or hyphens', () => {
    expect(recoveryCodeOf('abcde-9a9jh')).toBe('ABCDE9A9JH')
    expect(recoveryCodeOf(' ABCDE 9A9JH ')).toBe('ABCDE9A9JH')
    expect(recoveryCodeOf('ABCDE9A9J')).toBeNull()
    expect(recoveryCodeOf('ABCDE-9A9J0')).toBeNull()
    expect(recoveryCodeOf('123456')).toBeNull()
    expect(recoveryCodeOf(null)).toBeNull()
  })
})
