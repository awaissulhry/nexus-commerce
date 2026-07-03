/**
 * Phase S5 — MFA helper tests (TOTP verify round-trip + recovery format).
 */
import { describe, it, expect } from 'vitest'
import { generateSecret, generateSync } from 'otplib'
import { verifyTotp, generateEnrollment, generateRecoveryCodes } from './mfa.js'

describe('TOTP verification', () => {
  it('accepts a freshly generated code and rejects malformed ones', () => {
    const secret = generateSecret()
    const good = generateSync({ secret, digits: 6, period: 30 })
    expect(verifyTotp(secret, good)).toBe(true)
    expect(verifyTotp(secret, 'abcdef')).toBe(false)
    expect(verifyTotp(secret, '12345')).toBe(false) // wrong length
    expect(verifyTotp(secret, '')).toBe(false)
    expect(verifyTotp('', good)).toBe(false)
  })
})

describe('enrolment + recovery codes', () => {
  it('produces a secret + otpauth + QR data URL', async () => {
    const e = await generateEnrollment('user@example.com')
    expect(e.secret.length).toBeGreaterThan(10)
    expect(e.otpauth).toContain('otpauth://totp/')
    expect(e.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })
  it('generates 10 XXXX-XXXX recovery codes with matching hashes', async () => {
    const { raw, hashed } = await generateRecoveryCodes()
    expect(raw).toHaveLength(10)
    expect(hashed).toHaveLength(10)
    for (const c of raw) expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(hashed.every((h) => h.startsWith('$2'))).toBe(true)
  })
})
