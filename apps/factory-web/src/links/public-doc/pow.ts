/**
 * The self-hosted proof of work the public routes ask for after suspicious traffic (B-W2b-159, PLT-066; no third party,
 * nothing about the reader sent anywhere): a nonce such that SHA-256(`<challenge>:<nonce>`) starts with `bits` zero bits,
 * nonces 0, 1, 2 … in base 36 — factory-domain `abuse/pow.ts solveChallenge` is the reference. B-W2b-166: the same as
 * src/portal/signin/pow.ts (B-W2b-164), repeated here because the Links view may not import the Portal view
 * (check-view-boundaries); one shared copy in src/lib would serve both.
 */

export type Digest = (data: Uint8Array) => Promise<ArrayBuffer>

const webDigest: Digest = (data) => crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)

/** True when the digest starts with `bits` zero bits (the API's `meetsDifficulty`). */
export function hasLeadingZeroBits(digest: Uint8Array, bits: number): boolean {
  let left = bits
  for (const byte of digest) {
    if (left <= 0) return true
    if (left >= 8) {
      if (byte !== 0) return false
      left -= 8
    } else {
      return byte >> (8 - left) === 0
    }
  }
  return left <= 0
}

const BATCH = 512

/**
 * A nonce that solves the challenge, or null after `limit` tries or when `signal` aborts. `digest` (tests) defaults to
 * the browser's WebCrypto SHA-256.
 */
export async function solveChallenge(challenge: string, bits: number, options: { digest?: Digest; limit?: number; signal?: AbortSignal } = {}): Promise<string | null> {
  const digest = options.digest ?? webDigest
  const limit = options.limit ?? 1 << 26
  const encoder = new TextEncoder()
  for (let start = 0; start < limit; start += BATCH) {
    if (options.signal?.aborted) return null
    const nonces = Array.from({ length: Math.min(BATCH, limit - start) }, (_, index) => (start + index).toString(36))
    const digests = await Promise.all(nonces.map((nonce) => digest(encoder.encode(`${challenge}:${nonce}`))))
    const found = digests.findIndex((value) => hasLeadingZeroBits(new Uint8Array(value), bits))
    if (found >= 0) return nonces[found]!
  }
  return null
}
