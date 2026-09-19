/**
 * P0.2 — constant-time check of a service caller's shared secret.
 *
 * A plain `header === token` returns as soon as one character differs, so the
 * response time leaks how much of a guess was right. Both sides are hashed to
 * fixed-length SHA-256 digests first, so the compare never throws on a length
 * mismatch and never reveals the secret's length either.
 *
 * Fails closed: an unset or empty secret, or a missing / non-string header,
 * is never a match.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

export function internalTokenMatches(header: unknown, secret: string | undefined): boolean {
  if (!secret || typeof header !== 'string' || header.length === 0) return false
  return timingSafeEqual(digest(header), digest(secret))
}
