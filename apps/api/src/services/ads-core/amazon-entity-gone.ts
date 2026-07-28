/**
 * AX2.0 — "Amazon says this entity no longer exists."
 *
 * Why this exists: 662 dead-lettered AD_BID_UPDATE rows, all
 * `entityNotFoundError`, all from exactly 23 AdTarget rows whose keywords had
 * been deleted on Amazon. `isRetryableSyncError` already stopped the reconcile
 * sweep from looping on them — but the rank engine re-derived the same bid
 * change every run and enqueued it again, ~23/day for 26 days.
 *
 * A retryable/not-retryable answer is not enough: we need to know the entity is
 * GONE, so we can mark it once and stop generating work for it. That is a
 * strictly narrower question than "should I retry", and it must be narrow — a
 * false positive silently stops a live keyword from ever being bid again.
 *
 * Pure: no I/O, unit-tested.
 */

/**
 * True only for errors that mean the entity is absent at Amazon.
 *
 * Deliberately conservative. Generic 404s and the word "invalid" are NOT
 * treated as gone: a malformed request or a transient routing 404 must not
 * orphan a healthy keyword. We require Amazon's own vocabulary.
 */
export function isEntityGoneError(err: string | null | undefined): boolean {
  if (!err) return false
  const e = err.toLowerCase()

  // Amazon v3 batch responses: {"errorType":"entityNotFoundError", …}
  if (e.includes('entitynotfounderror')) return true

  // Prose forms observed across the SP/SB/SD surfaces.
  if (/could not find (keyword|target|ad ?group|campaign|product ?ad)/.test(e)) return true
  if (/(keyword|target|ad ?group|campaign|product ?ad)\s+(with id\s+\S+\s+)?(was )?not found/.test(e)) return true
  // Constant-style forms: ENTITY_NOT_FOUND / entity-not-found.
  if (/entity[\s_-]+not[\s_-]+found/.test(e)) return true

  return false
}

/** Short, stable reason string stored on the entity for the operator. */
export function orphanReasonFrom(err: string | null | undefined): string {
  if (!err) return 'entity not found at Amazon'
  const id = err.match(/"trigger":"(\d+)"/)?.[1] ?? err.match(/with id (\d+)/i)?.[1]
  const type = err.match(/"entityType":"(\w+)"/)?.[1]
  const parts = ['Amazon reports this entity no longer exists']
  if (type) parts.push(`(${type.toLowerCase()}${id ? ` ${id}` : ''})`)
  else if (id) parts.push(`(id ${id})`)
  return parts.join(' ').slice(0, 300)
}
