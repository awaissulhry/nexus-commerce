/**
 * VTR step 0 — a Shopify family that has never saved its content document must open.
 *
 * `readContent` returns `storedDocumentRevision: digest(pa[CONTENT_KEY])`, and before any save that value is `undefined`.
 * `JSON.stringify(undefined)` is `undefined`, and `Hash.update(undefined)` throws — so the content workspace and the Shopify
 * publish preview crashed for every never-initialised family (measured on a private copy: GALE-JACKET · Shopify, 2026-09-26).
 */
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { digest } from './content-workspace.service.js'

describe('content-workspace digest', () => {
  it('a document that was never saved has a revision (the same as an explicit null), and does not throw', () => {
    expect(() => digest(undefined)).not.toThrow()
    expect(digest(undefined)).toBe(digest(null))
  })

  it('positive control: a saved document still has its own revision, unchanged by this rule', () => {
    const saved = { axes: ['Colore'], optionNames: {} }
    expect(digest(saved)).not.toBe(digest(null))
    // Existing revisions do not move: the digest of a defined value is the plain SHA-256 of its JSON.
    expect(digest(saved)).toBe(createHash('sha256').update(JSON.stringify(saved)).digest('hex'))
  })
})
