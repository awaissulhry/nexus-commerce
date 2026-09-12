/**
 * PES.7 — what an edit writes. These pin down the two edges of `bulk-save` that are invisible from
 * the call site (a missing id CREATES; every upsert resets publish state) and the rule that decides
 * between them: pinning an inherited cell must never edit the row it inherits FROM.
 */
import { describe, expect, it } from 'vitest'

import type { CascadeRow, ResolvedCell } from './cascade'
import { clearCell, moveImage, ownRowAt, placeImage, type CellCoordinate } from './edits'

const row = (p: Partial<CascadeRow> & { id: string; url: string }): CascadeRow => ({
  scope: 'PLATFORM', platform: 'AMAZON', marketplace: null, amazonSlot: 'MAIN',
  variantGroupKey: null, variantGroupValue: null, ...p,
})

const at = (p: Partial<CellCoordinate> = {}): CellCoordinate =>
  ({ slot: 'MAIN', groupValue: 'Giallo', groupKey: 'Color', market: null, ...p })

const resolved = (p: Partial<ResolvedCell>): ResolvedCell =>
  ({ origin: 'empty', url: null, row: null, inheritedFrom: null, ...p })

describe('placeImage — update in place vs pin a new row', () => {
  it('carries the id when the cell OWNS its row, so bulk-save updates instead of duplicating', () => {
    const own = row({ id: 'giallo-main', url: 'old', variantGroupValue: 'Giallo' })
    const u = placeImage({ at: at(), url: 'new', resolved: resolved({ origin: 'platform', url: 'old', row: own }) })
    expect(u.id).toBe('giallo-main')
    expect(u.url).toBe('new')
  })

  it('OMITS the id when the picture is inherited — pinning must not edit the shared row', () => {
    // The cell shows the shared bucket's picture. Sending that row's id would repaint every colour.
    const shared = row({ id: 'shared-main', url: 'shared' })
    const u = placeImage({ at: at(), url: 'new', resolved: resolved({ origin: 'shared', url: 'shared', row: shared }) })
    expect(u.id).toBeUndefined()
    expect(u.variantGroupValue).toBe('Giallo')
  })

  it('omits the id when the picture came from master', () => {
    const u = placeImage({ at: at(), url: 'new', resolved: resolved({ origin: 'master', url: 'master/MAIN' }) })
    expect(u.id).toBeUndefined()
  })

  it('UPDATES a pictureless row rather than leaving the phantom behind', () => {
    // The 16 real rows with an empty url: filling one is an update, not a second row.
    const phantom = row({ id: 'phantom', url: '', variantGroupValue: 'Giallo' })
    const u = placeImage({ at: at(), url: 'new', resolved: resolved({ origin: 'pictureless', url: null, row: phantom }) })
    expect(u.id).toBe('phantom')
  })

  it('writes at the market layer being viewed, never wider', () => {
    const u = placeImage({ at: at({ market: 'IT' }), url: 'new', resolved: resolved({}) })
    expect(u.scope).toBe('MARKETPLACE')
    expect(u.marketplace).toBe('IT')
  })

  it('writes the all-markets layer when no market is selected', () => {
    const u = placeImage({ at: at(), url: 'new', resolved: resolved({}) })
    expect(u.scope).toBe('PLATFORM')
    expect(u.marketplace).toBeNull()
  })

  it('does not attach a bucket key to the shared row', () => {
    const u = placeImage({ at: at({ groupValue: null }), url: 'new', resolved: resolved({}) })
    expect(u.variantGroupValue).toBeNull()
    expect(u.variantGroupKey).toBeNull()
  })

  it('uses the STORED key for a bucket, not the axis display name', () => {
    // The axis is "Colore"; the rows are keyed "Color". The write must match storage.
    const u = placeImage({ at: at({ groupKey: 'Color' }), url: 'new', resolved: resolved({}) })
    expect(u.variantGroupKey).toBe('Color')
  })
})

describe('ownRowAt — a row only counts as owned at its own layer', () => {
  it('refuses an all-markets row as owned when a market is being viewed', () => {
    // Editing IT must not update the PLATFORM row — that would change every other market.
    const platformRow = row({ id: 'p', url: 'u', variantGroupValue: 'Giallo' })
    const r = resolved({ origin: 'platform', url: 'u', row: platformRow })
    expect(ownRowAt(r, at({ market: 'IT' }))).toBeNull()
  })

  it('accepts a market row at its own market', () => {
    const mk = row({ id: 'm', url: 'u', variantGroupValue: 'Giallo', scope: 'MARKETPLACE', marketplace: 'IT' })
    expect(ownRowAt(resolved({ origin: 'market', url: 'u', row: mk }), at({ market: 'IT' }))?.id).toBe('m')
  })

  it('refuses a row belonging to a different bucket', () => {
    const other = row({ id: 'o', url: 'u', variantGroupValue: 'Nero' })
    expect(ownRowAt(resolved({ origin: 'platform', url: 'u', row: other }), at())).toBeNull()
  })
})

describe('clearCell — a delete must not do something bigger than it looks', () => {
  it('deletes the row a cell owns', () => {
    const own = row({ id: 'giallo-main', url: 'u', variantGroupValue: 'Giallo' })
    expect(clearCell({ at: at(), resolved: resolved({ origin: 'platform', url: 'u', row: own }) }))
      .toEqual({ kind: 'delete', id: 'giallo-main' })
  })

  it('REFUSES to clear an inherited cell, and says why', () => {
    const shared = row({ id: 'shared', url: 'u' })
    const r = clearCell({ at: at(), resolved: resolved({ origin: 'shared', url: 'u', row: shared }) })
    expect(r.kind).toBe('refused')
    expect(r.kind === 'refused' && r.reason).toMatch(/every bucket/)
  })

  it('refuses a master-sourced cell with a different explanation', () => {
    const r = clearCell({ at: at(), resolved: resolved({ origin: 'master', url: 'm' }) })
    expect(r.kind === 'refused' && r.reason).toMatch(/master gallery/)
  })

  it('refuses an empty cell rather than sending a delete for nothing', () => {
    expect(clearCell({ at: at(), resolved: resolved({}) }).kind).toBe('refused')
  })
})

describe('moveImage', () => {
  it('places at the target and clears the source when the source owns its row', () => {
    const src = row({ id: 'src', url: 'pic', variantGroupValue: 'Giallo' })
    const m = moveImage({
      from: at(), fromResolved: resolved({ origin: 'platform', url: 'pic', row: src }),
      to: at({ slot: 'PT01' }), toResolved: resolved({}),
    })!
    expect(m.upsert.amazonSlot).toBe('PT01')
    expect(m.upsert.url).toBe('pic')
    expect(m.deleteId).toBe('src')
  })

  it('COPIES rather than moves out of an inherited cell — there is nothing to remove', () => {
    const shared = row({ id: 'shared', url: 'pic' })
    const m = moveImage({
      from: at(), fromResolved: resolved({ origin: 'shared', url: 'pic', row: shared }),
      to: at({ slot: 'PT01' }), toResolved: resolved({}),
    })!
    expect(m.deleteId).toBeNull()
  })

  it('never deletes the row it just wrote', () => {
    // Dropping a cell onto itself must not write then delete the same row.
    const own = row({ id: 'same', url: 'pic', variantGroupValue: 'Giallo' })
    const r = resolved({ origin: 'platform', url: 'pic', row: own })
    const m = moveImage({ from: at(), fromResolved: r, to: at(), toResolved: r })!
    expect(m.upsert.id).toBe('same')
    expect(m.deleteId).toBeNull()
  })

  it('returns null when the source has no picture', () => {
    expect(moveImage({ from: at(), fromResolved: resolved({}), to: at({ slot: 'PT01' }), toResolved: resolved({}) })).toBeNull()
  })
})
