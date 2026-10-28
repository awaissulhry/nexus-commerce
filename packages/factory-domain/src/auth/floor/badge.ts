import { createHash, randomBytes } from 'node:crypto'

/**
 * Worker badges (plan A1 §3.10 "Floor"; features PLT-019, PLT-057; MES-276): a printed QR code or barcode carrying a
 * random badge code, scanned on an enrolled device and followed by the worker's PIN. Never biometric data (GDPR
 * art. 9; the Garante refused biometric attendance), never the PIN, never anything about the person.
 *
 *   code     128 random bits, written in Crockford base32 as 26 characters (the last one carries 3 bits): upper-case
 *            letters and digits only, so a keyboard-wedge scanner, Code 128 and a QR code all carry it, and nobody
 *            mistypes I for 1 or O for 0 (they read the same).
 *   stored   only SHA-256 of the normalized code (`badgeCodeHash`): random, nothing to guess, so no slow hash; the
 *            last four characters (`badgeHint`) name a badge on screen.
 *   reprint  a new badge for a worker revokes their older ones (the API does it in the same command).
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 26
const CODE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`)

/** A new badge code (128 random bits). */
export function newBadgeCode(): string {
  const bytes = randomBytes(16)
  let bits = 0n
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte)
  // 128 bits → 26 characters of 5 bits: two zero bits complete the last character.
  bits <<= 2n
  let code = ''
  for (let index = CODE_LENGTH - 1; index >= 0; index--) code += ALPHABET[Number((bits >> BigInt(index * 5)) & 31n)]
  return code
}

/**
 * A scanned or typed code as stored: upper case, without spaces or hyphens (a printed code may be grouped), with the
 * look-alikes of Crockford base32 read as digits (I and L → 1, O → 0). Null for anything that is not a badge code.
 */
export function normalizeBadgeCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null
  const code = value.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
  return CODE.test(code) ? code : null
}

/** What is stored for a badge code: SHA-256 (hex) of the normalized code. */
export function badgeCodeHash(code: string): string {
  const normalized = normalizeBadgeCode(code)
  if (normalized === null) throw new Error('Not a badge code.')
  return createHash('sha256').update(`factory-badge\u0000${normalized}`, 'utf8').digest('hex')
}

/** The last four characters, shown to name a badge (never enough to rebuild it). */
export function badgeHint(code: string): string {
  const normalized = normalizeBadgeCode(code)
  if (normalized === null) throw new Error('Not a badge code.')
  return normalized.slice(-4)
}

/** The code grouped for printing under the barcode (`XXXX-XXXX-…`); scanning ignores the hyphens. */
export function printedBadgeCode(code: string): string {
  const normalized = normalizeBadgeCode(code)
  if (normalized === null) throw new Error('Not a badge code.')
  return normalized.match(/.{1,4}/g)!.join('-')
}
