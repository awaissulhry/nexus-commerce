import { describe, expect, it } from 'vitest'
import { recoveryCodeOf, timeStepAt } from '@nexus/factory-domain/auth/totp/totp'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { authSecrets } from '../sessions/secrets'
import { checkSecondFactor, claimOf, codesFor, newRecoveryCodes, newTotpSecret, otpauthUri } from './second-factor'

// The otplib adapter against RFC 6238 Appendix B (SHA-1, secret "12345678901234567890"): the vectors are 8 digits,
// a 6-digit code is their last six (the truncation is modulo 10^digits). Ported in spirit from Commerce's mfa tests.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const VECTORS: [seconds: number, code8: string][] = [
  [59, '94287082'],
  [1_111_111_109, '07081804'],
  [1_111_111_111, '14050471'],
  [1_234_567_890, '89005924'],
  [2_000_000_000, '69279037'],
]

const secrets = authSecrets(LOCAL_COOKIE_SECRET)

describe('TOTP codes (otplib)', () => {
  it.each(VECTORS)('match RFC 6238 at T=%i', (seconds, code8) => {
    expect(codesFor(RFC_SECRET)(timeStepAt(new Date(seconds * 1000)))).toBe(code8.slice(2))
  })

  it('makes 160-bit base32 secrets and an otpauth URI for the QR code', () => {
    const secret = newTotpSecret()
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    const uri = otpauthUri('ada@example.com', secret)
    expect(uri).toMatch(/^otpauth:\/\/totp\/Nexus%20Factory:ada%40example\.com\?/)
    expect(uri).toContain(`secret=${secret}`)
    expect(uri).toContain('issuer=Nexus%20Factory')
  })
})

describe('checkSecondFactor', () => {
  const now = new Date(1_234_567_890 * 1000)
  const step = timeStepAt(now)
  const state = (lastStep: number | null, hashes: string[] = []) => ({ totpSecretEnc: secrets.seal(RFC_SECRET), totpLastStep: lastStep, recoveryCodeHashes: hashes })

  it('accepts the current code once, as a claim on the step', () => {
    const ok = checkSecondFactor(secrets, state(null), '005924', now, { recovery: false })
    expect(ok).toEqual({ ok: true, proof: { kind: 'totp', step } })
    expect(checkSecondFactor(secrets, state(step), '005924', now, { recovery: false })).toEqual({ ok: false, failure: 'replayed' })
    expect(checkSecondFactor(secrets, state(null), '123456', now, { recovery: false })).toEqual({ ok: false, failure: 'wrong' })
    expect(claimOf(ok.ok ? ok.proof : null)).toEqual({ where: { OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] }, data: { totpLastStep: step } })
  })

  it('takes a recovery code only where allowed, and claims the list it read', () => {
    const codes = newRecoveryCodes(secrets)
    expect(codes.shown).toHaveLength(10)
    expect(new Set(codes.shown).size).toBe(10)
    expect(codes.hashes).toEqual(codes.shown.map((code) => secrets.recoveryCodeHash(recoveryCodeOf(code)!)))
    const typed = codes.shown[2]!.toLowerCase()
    const ok = checkSecondFactor(secrets, state(null, codes.hashes), typed, now, { recovery: true })
    expect(ok.ok && ok.proof).toEqual({ kind: 'recovery', before: codes.hashes, after: codes.hashes.filter((_, index) => index !== 2) })
    expect(checkSecondFactor(secrets, state(null, codes.hashes), typed, now, { recovery: false })).toEqual({ ok: false, failure: 'malformed' })
    expect(checkSecondFactor(secrets, state(null, codes.hashes), 'ZZZZZ-ZZZZZ', now, { recovery: true })).toEqual({ ok: false, failure: 'wrong' })
    expect(claimOf(ok.ok ? ok.proof : null).where).toEqual({ recoveryCodeHashes: { equals: codes.hashes } })
  })

  it('answers wrong without a secret', () => {
    expect(checkSecondFactor(secrets, { totpSecretEnc: null, totpLastStep: null, recoveryCodeHashes: [] }, '005924', now, { recovery: true })).toEqual({ ok: false, failure: 'wrong' })
  })
})
