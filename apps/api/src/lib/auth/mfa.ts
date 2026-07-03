/**
 * Phase S5 — TOTP MFA helpers.
 *
 * One home for the 2FA primitives (otplib TOTP + hashed recovery codes),
 * shared by the login MFA step and the self-service enrolment endpoints.
 * No hand-rolled crypto: otplib for TOTP, bcrypt for recovery-code hashing,
 * CSPRNG for the codes themselves.
 */

import { generateSecret, generateURI, verifySync } from 'otplib'
import QRCode from 'qrcode'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'
import prisma from '../../db.js'

const TOTP = { digits: 6, step: 30 } as const
const ISSUER = 'Nexus Commerce'

/** Verify a 6-digit TOTP code against a base32 secret (±1 step tolerance). */
export function verifyTotp(secret: string, code: string): boolean {
  const clean = (code ?? '').replace(/\s/g, '')
  if (!/^\d{6}$/.test(clean) || !secret) return false
  try {
    return verifySync({
      token: clean, secret,
      digits: TOTP.digits, period: TOTP.step, epochTolerance: TOTP.step,
    }).valid
  } catch {
    return false
  }
}

/** Consume a single-use recovery code (bcrypt-compared, marked used). */
export async function consumeRecoveryCode(userId: string, raw: string): Promise<boolean> {
  const clean = (raw ?? '').trim().toUpperCase()
  if (clean.length < 8) return false
  const codes = await (prisma as any).twoFactorRecoveryCode.findMany({
    where: { userId, usedAt: null }, select: { id: true, codeHash: true },
  })
  for (const c of codes) {
    if (await bcrypt.compare(clean, c.codeHash).catch(() => false)) {
      await (prisma as any).twoFactorRecoveryCode.update({ where: { id: c.id }, data: { usedAt: new Date() } })
      return true
    }
  }
  return false
}

/** Generate a fresh enrolment: secret + otpauth URI + QR data URL. */
export async function generateEnrollment(accountName: string): Promise<{ secret: string; otpauth: string; qrDataUrl: string }> {
  const secret = generateSecret()
  const otpauth = generateURI({
    strategy: 'totp', label: accountName || 'user', issuer: ISSUER,
    secret, digits: TOTP.digits, period: TOTP.step,
  })
  const qrDataUrl = await QRCode.toDataURL(otpauth, { margin: 1, width: 240 })
  return { secret, otpauth, qrDataUrl }
}

/** 10 recovery codes as XXXX-XXXX; returns (raw shown once, hashed to store). */
export async function generateRecoveryCodes(): Promise<{ raw: string[]; hashed: string[] }> {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I
  const raw: string[] = []
  for (let i = 0; i < 10; i++) {
    const bytes = randomBytes(8)
    let s = ''
    for (let j = 0; j < 8; j++) s += ALPHABET[bytes[j] % ALPHABET.length]
    raw.push(`${s.slice(0, 4)}-${s.slice(4, 8)}`)
  }
  const hashed = await Promise.all(raw.map((c) => bcrypt.hash(c, 10)))
  return { raw, hashed }
}
