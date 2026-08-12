/** AX2.0 — entity-gone detection. A false positive silently kills a live keyword. */
import { describe, it, expect } from 'vitest'
import { isEntityGoneError, orphanReasonFrom, isContradictoryOrphan } from './amazon-entity-gone.js'

// Verbatim from a production dead-letter row, 2026-07-27.
const REAL = 'amazon_rejected: [{"errorType":"entityNotFoundError","errorValue":{"entityNotFoundError":{"cause":{"location":"$.keywords[0].keywordId","trigger":"207019562887495"},"entityId":"207019562887495","entityType":"KEYWORD","message":"Could not find keyword with id 207019562887495"}}}]'

describe('isEntityGoneError', () => {
  it('detects the real production error', () => {
    expect(isEntityGoneError(REAL)).toBe(true)
  })

  it('detects the prose variants across entity types', () => {
    expect(isEntityGoneError('Could not find keyword with id 123')).toBe(true)
    expect(isEntityGoneError('Could not find ad group with id 9')).toBe(true)
    expect(isEntityGoneError('Campaign not found')).toBe(true)
    expect(isEntityGoneError('target with id 55 not found')).toBe(true)
    expect(isEntityGoneError('ENTITY_NOT_FOUND')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isEntityGoneError('ENTITYNOTFOUNDERROR')).toBe(true)
    expect(isEntityGoneError('entityNotFoundError')).toBe(true)
  })

  // ── the conservative half: these must NOT orphan a healthy entity ───────
  it('does NOT treat a bare 404 as gone', () => {
    expect(isEntityGoneError('HTTP 404')).toBe(false)
    expect(isEntityGoneError('amazon_rejected: 404 Not Found')).toBe(false)
  })

  it('does NOT treat validation or auth failures as gone', () => {
    expect(isEntityGoneError('invalid bid value')).toBe(false)
    expect(isEntityGoneError('amazon_rejected: {"errorType":"invalidArgumentError"}')).toBe(false)
    expect(isEntityGoneError('401 unauthorized')).toBe(false)
    expect(isEntityGoneError('403 forbidden')).toBe(false)
    expect(isEntityGoneError('duplicate keyword')).toBe(false)
  })

  it('does NOT treat throttling or outages as gone', () => {
    expect(isEntityGoneError('429 too many requests')).toBe(false)
    expect(isEntityGoneError('503 service unavailable')).toBe(false)
    expect(isEntityGoneError('socket hang up')).toBe(false)
  })

  it('is false for empty input — absence of an error is not evidence of absence', () => {
    expect(isEntityGoneError(null)).toBe(false)
    expect(isEntityGoneError(undefined)).toBe(false)
    expect(isEntityGoneError('')).toBe(false)
  })
})

describe('orphanReasonFrom', () => {
  it('extracts entity type and id from the real payload', () => {
    const r = orphanReasonFrom(REAL)
    expect(r).toMatch(/no longer exists/)
    expect(r).toMatch(/keyword/)
    expect(r).toMatch(/207019562887495/)
  })
  it('falls back cleanly with no structured detail', () => {
    expect(orphanReasonFrom('Campaign not found')).toMatch(/no longer exists/)
    expect(orphanReasonFrom(null)).toMatch(/not found at Amazon/)
  })
  it('stays short enough for a column', () => {
    expect(orphanReasonFrom('x'.repeat(5000)).length).toBeLessThanOrEqual(300)
  })
})

// ── DL.3 — "not found" only means deleted if we asked the endpoint that owns the entity ────────
//
// This module was created after 662 dead-lettered writes diagnosed as "keywords deleted on
// Amazon". They were not deleted: every product/auto bid was being PUT to /sp/keywords, so Amazon
// truthfully reported no keyword with that id — and this detector read our own routing bug as
// proof of deletion, orphaning 27 healthy targets and silently disabling rank control on four live
// campaigns. The kind now vetoes that conclusion when the error points at the wrong endpoint.
describe('DL.3 isEntityGoneError — endpoint/kind mismatch is a routing fault, not a deletion', () => {
  // The exact shape Amazon returned for a product target sent to the keywords endpoint.
  const keywordMiss = 'amazon_rejected: [{"errorType":"entityNotFoundError","errorValue":{"entityNotFoundError":{"cause":{"location":"$.keywords[0].keywordId","trigger":"2563190727532"}}}}]'
  const targetMiss = 'amazon_rejected: [{"errorType":"entityNotFoundError","errorValue":{"entityNotFoundError":{"cause":{"location":"$.targetingClauses[0].targetId","trigger":"991"}}}}]'

  it('refuses to orphan a PRODUCT target on a keyword-shaped miss', () => {
    expect(isEntityGoneError(keywordMiss, { kind: 'PRODUCT' })).toBe(false)
  })
  it('refuses to orphan an AUTO target on a keyword-shaped miss', () => {
    expect(isEntityGoneError(keywordMiss, { kind: 'AUTO' })).toBe(false)
  })
  it('refuses to orphan a KEYWORD target on a target-shaped miss', () => {
    expect(isEntityGoneError(targetMiss, { kind: 'KEYWORD' })).toBe(false)
  })

  // The veto must be narrow: a genuine deletion, reported by the right endpoint, still orphans.
  it('still orphans a KEYWORD gone from the keywords endpoint', () => {
    expect(isEntityGoneError(keywordMiss, { kind: 'KEYWORD' })).toBe(true)
  })
  it('still orphans a PRODUCT target gone from the targets endpoint', () => {
    expect(isEntityGoneError(targetMiss, { kind: 'PRODUCT' })).toBe(true)
    expect(isEntityGoneError(targetMiss, { kind: 'AUTO' })).toBe(true)
  })

  // It may only ever suppress a false positive, never invent one — callers that cannot supply a
  // kind must behave exactly as before.
  it('is inert without a kind, or with an unrecognised one', () => {
    expect(isEntityGoneError(keywordMiss)).toBe(true)
    expect(isEntityGoneError(keywordMiss, { kind: null })).toBe(true)
    expect(isEntityGoneError(keywordMiss, { kind: 'SOMETHING_NEW' })).toBe(true)
  })
  it('is inert when the error names neither endpoint, or names both', () => {
    expect(isEntityGoneError('amazon_rejected: entityNotFoundError', { kind: 'PRODUCT' })).toBe(true)
    expect(isEntityGoneError('entityNotFoundError keywordId targetId', { kind: 'PRODUCT' })).toBe(true)
  })
  it('never turns a non-gone error into a gone one', () => {
    expect(isEntityGoneError('amazon_rejected: BID_TOO_LOW', { kind: 'PRODUCT' })).toBe(false)
    expect(isEntityGoneError(null, { kind: 'PRODUCT' })).toBe(false)
  })
})

/**
 * WF.1 — withdrawing an orphan mark that contradicts the entity carrying it.
 *
 * The deadlock this breaks: `orphanedAt` blocks every non-forced write, and only a successful
 * write clears `orphanedAt`. Anything mis-marked before DL.3 existed is therefore stuck for good —
 * four AUTO targets have been since 2026-06-15. The detector must be as conservative as DL.3's,
 * because a false POSITIVE here un-suppresses writes to an entity that really is gone.
 */
describe('WF.1 isContradictoryOrphan', () => {
  const KEYWORD_MISS = 'Amazon reports this entity no longer exists (keyword 142867388929955)'
  const TARGET_MISS = 'Amazon reports this entity no longer exists (targetingclause 99007000337844)'

  it('an AUTO/PRODUCT target orphaned for a missing KEYWORD is a routing artefact', () => {
    // The exact four rows observed on Auto_Close_Moss.
    expect(isContradictoryOrphan(KEYWORD_MISS, 'AUTO')).toBe(true)
    expect(isContradictoryOrphan(KEYWORD_MISS, 'PRODUCT')).toBe(true)
  })
  it('a KEYWORD target orphaned for a missing TARGET is the mirror artefact', () => {
    expect(isContradictoryOrphan(TARGET_MISS, 'KEYWORD')).toBe(true)
  })
  it('a consistent orphan is left alone — this must not un-suppress a genuinely dead entity', () => {
    expect(isContradictoryOrphan(KEYWORD_MISS, 'KEYWORD')).toBe(false)
    expect(isContradictoryOrphan(TARGET_MISS, 'AUTO')).toBe(false)
    expect(isContradictoryOrphan(TARGET_MISS, 'PRODUCT')).toBe(false)
  })
  it('says nothing when the reason names neither, or both', () => {
    expect(isContradictoryOrphan('Amazon reports this entity no longer exists', 'AUTO')).toBe(false)
    expect(isContradictoryOrphan('keyword and target both missing', 'AUTO')).toBe(false)
    expect(isContradictoryOrphan(null, 'AUTO')).toBe(false)
    expect(isContradictoryOrphan('', 'AUTO')).toBe(false)
  })
  it('says nothing for a kind whose endpoint ownership is not established', () => {
    for (const k of ['AUDIENCE', 'PRODUCT_CATEGORY', 'PRODUCT_AUDIENCE', '', null, undefined]) {
      expect(isContradictoryOrphan(KEYWORD_MISS, k as string | null)).toBe(false)
    }
  })
  it('agrees with isEntityGoneError: what DL.3 refuses to mark, this refuses to keep', () => {
    // The same live error DL.3 declines to treat as gone, stamped as a reason, must be withdrawable.
    const liveErr = 'amazon_rejected: [{"errorType":"entityNotFoundError","errorValue":{"entityNotFoundError":{"cause":{"location":"$.keywords[0].keywordId","trigger":"1"},"entityType":"KEYWORD"}}}]'
    expect(isEntityGoneError(liveErr, { kind: 'AUTO' })).toBe(false)
    expect(isContradictoryOrphan(orphanReasonFrom(liveErr), 'AUTO')).toBe(true)
  })
})

// ── NEG.3 — the orphan trap, one entity class over ───────────────────────────────────────────
//
// DL.3 asks "did the error come from an endpoint that cannot own this entity?" and answers it from
// `kind`. That is not enough for a NEGATIVE keyword, which is also kind=KEYWORD: before the NEG.3
// routing fix, archiving one PUT to /sp/keywords, Amazon answered `entityNotFoundError` at
// `$.keywords[0].keywordId`, and this detector saw keyword-shaped error + KEYWORD kind = no
// contradiction = GONE. The row would then be orphaned, `orphanedAt` blocks every non-forced
// write, and `isContradictoryOrphan` could not clear it for the same reason. Live at Amazon, dead
// here, permanently unwritable — the WF.1 deadlock on a new entity class.
describe('NEG.3 — a negative row is not gone just because /sp/keywords could not find it', () => {
  const NOT_FOUND = '{"errorType":"entityNotFoundError","message":"not found","location":"$.keywords[0].keywordId"}'

  it('🔴 a POSITIVE-keyword-shaped miss on a NEGATIVE row is a routing fault, not a deletion', () => {
    expect(isEntityGoneError(NOT_FOUND, { kind: 'KEYWORD', isNegative: true })).toBe(false)
  })
  it('…and the same error on a POSITIVE keyword still means gone, exactly as before', () => {
    expect(isEntityGoneError(NOT_FOUND, { kind: 'KEYWORD', isNegative: false })).toBe(true)
    expect(isEntityGoneError(NOT_FOUND, { kind: 'KEYWORD' })).toBe(true)
  })
  it('a miss from the NEGATIVE endpoint on a negative row IS a real deletion', () => {
    // Once routing is correct, Amazon's "not found" is about its inventory again — and must be
    // believed, or a genuinely deleted negative would be retried forever.
    const negMiss = '{"errorType":"entityNotFoundError","location":"$.negativeKeywords[0].keywordId"}'
    expect(isEntityGoneError(negMiss, { kind: 'KEYWORD', isNegative: true })).toBe(true)
  })
  it('a campaign-negative miss on a negative row is also believed', () => {
    const campMiss = '{"errorType":"entityNotFoundError","location":"$.campaignNegativeKeywords[0].keywordId"}'
    expect(isEntityGoneError(campMiss, { kind: 'KEYWORD', isNegative: true })).toBe(true)
  })
  it('🔴 substring care: $.negativeKeywords must not be read as $.keywords', () => {
    // `"$.negativekeywords".includes("$.keywords")` is false only because of the `$.`; the check
    // does not rely on that — the negative shape is tested first and wins.
    const negMiss = '{"errorType":"entityNotFoundError","location":"$.negativeKeywords[0].keywordId"}'
    expect(isEntityGoneError(negMiss, { kind: 'KEYWORD', isNegative: false })).toBe(false) // positive row, negative endpoint = our fault
  })
  it('a targeting-clause miss on a negative product target is a routing fault too', () => {
    const tgtMiss = '{"errorType":"entityNotFoundError","location":"$.targetingClauses[0].targetId"}'
    expect(isEntityGoneError(tgtMiss, { kind: 'PRODUCT', isNegative: true })).toBe(false)
  })
})

describe('NEG.3 — isContradictoryOrphan can withdraw a mark made before the routing fix', () => {
  it('🔴 a negative stamped with a POSITIVE keyword miss is self-contradictory', () => {
    expect(isContradictoryOrphan('Amazon reports this entity no longer exists (keyword 1428)', 'KEYWORD', true)).toBe(true)
  })
  it('a negative stamped with a NEGATIVE miss is NOT contradictory — that mark is supported', () => {
    expect(isContradictoryOrphan('Amazon reports this entity no longer exists (negativekeyword 1428)', 'KEYWORD', true)).toBe(false)
  })
  it('a POSITIVE keyword stamped with a keyword miss stays orphaned, exactly as before', () => {
    expect(isContradictoryOrphan('Amazon reports this entity no longer exists (keyword 1428)', 'KEYWORD', false)).toBe(false)
    expect(isContradictoryOrphan('Amazon reports this entity no longer exists (keyword 1428)', 'KEYWORD')).toBe(false)
  })
  it('the DL.1/WF.1 case is untouched: an AUTO target stamped with a keyword miss is contradictory', () => {
    expect(isContradictoryOrphan('Amazon reports this entity no longer exists (keyword 1428)', 'AUTO')).toBe(true)
  })
})
