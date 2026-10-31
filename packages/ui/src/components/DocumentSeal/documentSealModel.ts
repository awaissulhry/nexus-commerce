/**
 * DocumentSeal's rules (B-W2b-28, design part DocumentSeal): the proof of a frozen document — the LUL calendar, a payroll
 * file, a DVR version, a statutory check — shown the same way everywhere: version, SHA-256, when and by which clock,
 * the signers with dates, and "Verify a file".
 *
 * - **The fingerprint** is 64 hexadecimal characters, compared without case, spaces or colons. Shown whole (in groups
 *   of 8, selectable) and short (first and last 8) — never cut silently.
 * - **Verify** computes the SHA-256 of a file the person picks, on the device (Web Crypto): the file is never sent.
 *   The answer is "matches" or "does NOT match", in words, with the file's name.
 * - **Signers**: who signed and when; a signer without a date is waiting. "2 of 4 signed".
 */

/** The fingerprint as 64 lower-case hex characters, or null when it is not a SHA-256. */
export function normalizeSha256(hex: string | null | undefined): string | null {
  if (!hex) return null
  const clean = hex.replace(/[\s:]/g, '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(clean) ? clean : null
}

/** "3f9a1c2e…77d0c21b". */
export function sealShort(hex: string): string {
  const h = normalizeSha256(hex) ?? hex
  return h.length > 20 ? `${h.slice(0, 8)}…${h.slice(-8)}` : h
}

/** The whole fingerprint in groups of 8 for reading aloud or by eye. */
export function sealGroups(hex: string): string {
  const h = normalizeSha256(hex) ?? hex
  return h.match(/.{1,8}/g)?.join(' ') ?? h
}

export function hexOf(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The SHA-256 of some bytes, on this device. */
export async function sha256Hex(data: ArrayBuffer | Uint8Array, subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle): Promise<string> {
  if (!subtle) throw new Error('Web Crypto is not available')
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  return hexOf(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
}

/** The same fingerprint (case, spaces and colons ignored); a malformed one never matches. */
export function sealMatches(expected: string, actual: string): boolean {
  const a = normalizeSha256(expected)
  return a !== null && a === normalizeSha256(actual)
}

export function sealSigned(signers: readonly { signedAt?: string | null }[]): { signed: number; total: number } {
  return { signed: signers.filter((s) => !!s.signedAt).length, total: signers.length }
}
