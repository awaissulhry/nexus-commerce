import { describe, expect, it } from 'vitest'
import { hashPassword, PASSWORD_MAX_LENGTH, passwordProblems, SCRYPT_PARAMS, verifyPassword, type ScryptParams } from './password'

// Ported from Commerce's apps/api/src/lib/auth/auth.vitest.test.ts (password hashing, strength gate), for scrypt.
// Cheap parameters keep the round trips fast; the stored form carries them, so verify reads them back.
const CHEAP: ScryptParams = { logN: 10, r: 8, p: 1 }
const GOOD = 'tidy-lantern-orchard-47'

describe('password hashing (scrypt)', () => {
  it('round-trips in the PHC string format; current parameters need no rehash', async () => {
    const stored = await hashPassword(GOOD)
    expect(stored).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/)
    expect(await verifyPassword(GOOD, stored)).toEqual({ ok: true, needsRehash: false })
  })

  it('salts every hash', async () => {
    expect(await hashPassword(GOOD, CHEAP)).not.toBe(await hashPassword(GOOD, CHEAP))
  })

  it('refuses a wrong password, and flags a hash of other parameters for a rehash only when right', async () => {
    const stored = await hashPassword(GOOD, CHEAP)
    expect(await verifyPassword('tidy-lantern-orchard-48', stored)).toEqual({ ok: false, needsRehash: false })
    expect(await verifyPassword(GOOD, stored)).toEqual({ ok: true, needsRehash: true })
  })

  it('normalizes (NFKC): the same characters in another composition verify', async () => {
    const composed = 'café-lantern-orchard'
    const decomposed = 'café-lantern-orchard'
    expect(composed).not.toBe(decomposed)
    expect((await verifyPassword(decomposed, await hashPassword(composed, CHEAP))).ok).toBe(true)
  })

  it('never matches without a usable stored hash, and still does the work (same time either way)', async () => {
    for (const stored of [null, undefined, '', 'not-a-hash', '$scrypt$ln=99,r=8,p=1$c2FsdHNhbHRzYWx0c2FsdA$' + 'A'.repeat(43)]) {
      const started = performance.now()
      expect(await verifyPassword(GOOD, stored)).toEqual({ ok: false, needsRehash: false })
      // One scrypt with the production parameters ran (tens of milliseconds), not an early return.
      expect(performance.now() - started).toBeGreaterThan(5)
    }
  })

  it('refuses a damaged hash and an input that is not a password', async () => {
    const stored = await hashPassword(GOOD, CHEAP)
    expect((await verifyPassword(GOOD, stored.slice(0, -2) + 'AA')).ok).toBe(false)
    expect((await verifyPassword(GOOD, stored.replace('$scrypt$', '$scrypt2$'))).ok).toBe(false)
    expect((await verifyPassword(123, stored)).ok).toBe(false)
    expect((await verifyPassword('x'.repeat(PASSWORD_MAX_LENGTH + 1), stored)).ok).toBe(false)
  })

  it('will not hash an overlong input or use parameters out of bounds', async () => {
    await expect(hashPassword('x'.repeat(PASSWORD_MAX_LENGTH + 1))).rejects.toThrow(/too long/)
    await expect(hashPassword(GOOD, { ...CHEAP, logN: 9 })).rejects.toThrow(/logN/)
    await expect(hashPassword(GOOD, { ...CHEAP, p: 0 })).rejects.toThrow(/p must be/)
    expect(SCRYPT_PARAMS).toEqual({ logN: 15, r: 8, p: 3 })
  })
})

describe('password policy', () => {
  const problem = (password: unknown, context = {}) => passwordProblems(password, context)[0]?.message

  it('accepts a long passphrase', () => {
    expect(passwordProblems(GOOD)).toEqual([])
    expect(passwordProblems('ζωή είναι ωραία πολύ')).toEqual([])
  })

  it('refuses a short or overlong password, counting characters, not bytes', () => {
    expect(problem('short-pass1')).toMatch(/at least 12/)
    expect(problem('x'.repeat(PASSWORD_MAX_LENGTH + 1))).toMatch(/at most 256/)
    expect(problem('🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂')).toMatch(/at least 12/)
    expect(problem(undefined)).toMatch(/Enter a password/)
  })

  it('refuses blanks, too few different characters and well-known passwords', () => {
    expect(problem(' '.repeat(14))).toMatch(/only spaces|different/)
    expect(problem('abababababab')).toMatch(/different/)
    expect(problem('Password1234')).toMatch(/too common/)
    expect(problem('QAZWSXEDCRFV')).toMatch(/too common/)
  })

  it('refuses a password built on the account email or name', () => {
    expect(problem('marta.rossi-2026!', { email: 'marta.rossi@example.com' })).toMatch(/name or email/)
    expect(problem('lantern-Bianchi-77', { displayName: 'Paola Bianchi' })).toMatch(/name or email/)
    expect(problem('tidy-lantern-orchard', { email: 'al@example.com' })).toBeUndefined()
  })

  it('answers at the password field', () => {
    expect(passwordProblems('short')).toEqual([{ path: 'password', message: expect.any(String) }])
  })
})
