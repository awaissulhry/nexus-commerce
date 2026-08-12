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
  opts?: { kind?: string | null; isNegative?: boolean | null },
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
  if (mentionsWrongEndpointFor(e, opts?.kind, opts?.isNegative)) return false

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
 * NEG.3 — and `isNegative` is the third axis, because a NEGATIVE keyword is also `kind = KEYWORD`
 * and its id is also not a `/sp/keywords` keywordId: it lives under /sp/negativeKeywords or
 * /sp/campaignNegativeKeywords. Before the NEG.3 routing fix, a positive-keyword-shaped miss on a
 * negative row was indistinguishable from a genuine deletion — same kind, same error shape, no
 * contradiction to read — so the first archive of a negative would have orphaned it permanently.
 *
 * Substring care: `$.negativekeywords` does NOT contain `$.keywords` (the `$.` prevents it), but
 * `keywordid` matches both, so the negative shape is tested FIRST and wins.
 *
 * Silent on an absent/unknown kind — this must only ever SUPPRESS a false positive, never invent
 * one, and callers that cannot supply a kind keep the previous behaviour exactly.
 */
function mentionsWrongEndpointFor(lowerErr: string, kind?: string | null, isNegative?: boolean | null): boolean {
  const k = (kind ?? '').toUpperCase()
  if (k !== 'KEYWORD' && k !== 'PRODUCT' && k !== 'AUTO') return false

  // Does Amazon's message name a NEGATIVE surface? Covers `$.negativeKeywords[0]`,
  // `$.campaignNegativeKeywords[0]`, `negativeKeywordId` and `$.negativeTargetingClauses[0]`.
  const negativeShaped = /negativekeyword|negativetarget|campaignnegative/.test(lowerErr)
  const keywordShaped = !negativeShaped && (lowerErr.includes('keywordid') || lowerErr.includes('$.keywords'))
  const targetShaped = !negativeShaped && (lowerErr.includes('targetid') || lowerErr.includes('targetingclauses') || lowerErr.includes('$.targets'))

  if (isNegative === true) {
    // A negative's id is owned by a negative endpoint. Anything POSITIVE-shaped is our routing
    // fault, not Amazon's inventory, and must never be read as deletion.
    if (keywordShaped || targetShaped) return true
    return false
  }

  // A POSITIVE row can never legitimately be missed by a negative endpoint either.
  if (negativeShaped) return true

  // Only decide when the error points at exactly one of the two.
  if (keywordShaped === targetShaped) return false
  if (k === 'KEYWORD') return targetShaped
  return keywordShaped // PRODUCT | AUTO
}

/**
 * WF.1 — an orphan mark that contradicts the entity it sits on.
 *
 * `isEntityGoneError` refuses to CREATE this mark (DL.3), but nothing could ever remove one made
 * before that guard existed, and the reason is a deadlock rather than an oversight: `orphanedAt`
 * blocks every non-forced write, and the only thing that clears `orphanedAt` is a write
 * succeeding. The flag prevents the write that would remove the flag. Four AUTO targets on
 * Auto_Close_Moss have sat like this since 2026-06-15, each stamped "Amazon reports this entity no
 * longer exists (keyword …)" — a KEYWORD miss recorded against an AUTO target, which is the
 * routing bug's signature and not a statement about Amazon's inventory.
 *
 * Detecting it is the same question DL.3 asks, on the stored reason instead of the live error:
 * does the entity type Amazon complained about contradict this entity's own kind?
 *
 * Clearing on this signal is safe in the strong sense — it does not assert the entity exists. It
 * only withdraws a conclusion that was never supported, and hands the question back to Amazon: the
 * next write goes to the CORRECT endpoint now, and if the entity really is gone the worker
 * re-orphans it with an accurate reason. The system re-derives the truth either way.
 */
export function isContradictoryOrphan(
  orphanReason: string | null | undefined,
  kind: string | null | undefined,
  isNegative?: boolean | null,
): boolean {
  const k = (kind ?? '').toUpperCase()
  if (k !== 'KEYWORD' && k !== 'PRODUCT' && k !== 'AUTO') return false
  const r = (orphanReason ?? '').toLowerCase()
  if (!r) return false
  // orphanReasonFrom stamps the entityType Amazon named, e.g. "(keyword 1428…)".
  const saysNegative = /negativekeyword|negativetarget|campaignnegative|negative keyword|negative target/.test(r)
  const saysKeyword = !saysNegative && /\bkeyword\b/.test(r)
  const saysTarget = !saysNegative && /\btarget(ing)?(clause)?\b/.test(r)

  // NEG.3 — a NEGATIVE row orphaned for a missing POSITIVE keyword/target records the pre-NEG.3
  // routing fault, exactly as an AUTO target orphaned for a missing keyword recorded DL.1's. It
  // can never clear itself, for the same reason: the mark blocks the write whose success would
  // remove it. Withdraw the unsupported conclusion; the next write goes to the correct endpoint,
  // and if the entity really is gone the worker re-orphans it with an accurate reason.
  if (isNegative === true) return saysKeyword || saysTarget
  if (saysNegative) return true // a POSITIVE row orphaned for a missing negative — same fault, mirrored

  if (saysKeyword === saysTarget) return false // names both or neither → no contradiction to read
  return k === 'KEYWORD' ? saysTarget : saysKeyword
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
