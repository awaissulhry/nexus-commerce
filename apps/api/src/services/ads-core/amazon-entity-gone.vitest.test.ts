/** AX2.0 — entity-gone detection. A false positive silently kills a live keyword. */
import { describe, it, expect } from 'vitest'
import { isEntityGoneError, orphanReasonFrom } from './amazon-entity-gone.js'

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
