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
export function isEntityGoneError(
  err: string | null | undefined,
  opts?: { kind?: string | null },
): boolean {
  if (!err) return false
  const e = err.toLowerCase()

  // DL.3 — "not found" is only evidence of deletion if we asked the endpoint that OWNS the entity.
  //
  // This module's own header records 662 dead-lettered writes diagnosed as "keywords deleted on
  // Amazon". They were not deleted: every product/auto target's bid was being PUT to /sp/keywords
  // (see DL.1), so Amazon truthfully reported no keyword with that id — and this detector read our
  // routing bug as proof the entity was gone, orphaning 27 healthy targets and silently disabling
  // rank control on four live campaigns.
  //
  // Amazon names the location it looked in ($.keywords[0].keywordId /
  // $.targetingClauses[0].targetId). When that contradicts the entity's own kind, the miss says
  // something about OUR request, not about Amazon's inventory — so refuse to conclude "gone".
  if (mentionsWrongEndpointFor(e, opts?.kind)) return false

  // Amazon v3 batch responses: {"errorType":"entityNotFoundError", …}
  if (e.includes('entitynotfounderror')) return true

  // Prose forms observed across the SP/SB/SD surfaces.
  if (/could not find (keyword|target|ad ?group|campaign|product ?ad)/.test(e)) return true
  if (/(keyword|target|ad ?group|campaign|product ?ad)\s+(with id\s+\S+\s+)?(was )?not found/.test(e)) return true
  // Constant-style forms: ENTITY_NOT_FOUND / entity-not-found.
  if (/entity[\s_-]+not[\s_-]+found/.test(e)) return true

  return false
}

/**
 * DL.3 — did the error come from an endpoint that cannot own this entity?
 *
 * `kind` is AdTarget.kind. KEYWORD ids live under /sp/keywords; PRODUCT and AUTO ids live under
 * /sp/targets. A keyword-shaped miss for a product target (or the reverse) is a routing fault.
 *
 * Silent on an absent/unknown kind — this must only ever SUPPRESS a false positive, never invent
 * one, and callers that cannot supply a kind keep the previous behaviour exactly.
 */
function mentionsWrongEndpointFor(lowerErr: string, kind?: string | null): boolean {
  const k = (kind ?? '').toUpperCase()
  if (k !== 'KEYWORD' && k !== 'PRODUCT' && k !== 'AUTO') return false

  const keywordShaped = lowerErr.includes('keywordid') || lowerErr.includes('$.keywords')
  const targetShaped = lowerErr.includes('targetid') || lowerErr.includes('targetingclauses') || lowerErr.includes('$.targets')

  // Only decide when the error points at exactly one of the two.
  if (keywordShaped === targetShaped) return false
  if (k === 'KEYWORD') return targetShaped
  return keywordShaped // PRODUCT | AUTO
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
