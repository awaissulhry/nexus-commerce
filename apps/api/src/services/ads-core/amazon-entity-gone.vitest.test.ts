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
