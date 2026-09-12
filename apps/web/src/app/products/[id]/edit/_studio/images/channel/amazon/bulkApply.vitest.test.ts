/**
 * PES.7 — bulk apply targeting. The point of these is that nothing is overwritten silently and
 * that "pin" is counted apart from "fill", because they look the same on screen and are not.
 */
import { describe, expect, it } from 'vitest'

import type { CascadeRow, ResolvedCell } from './cascade'
import { buildBulkPlan, classifyTarget, describe as describePlan } from './bulkApply'
import type { CellCoordinate } from './edits'

const at = (p: Partial<CellCoordinate> = {}): CellCoordinate =>
  ({ slot: 'PT01', groupValue: 'Giallo', groupKey: 'Color', market: null, ...p })

const resolved = (p: Partial<ResolvedCell>): ResolvedCell =>
  ({ origin: 'empty', url: null, row: null, inheritedFrom: null, ...p })

const row = (p: Partial<CascadeRow> & { id: string; url: string }): CascadeRow => ({
  scope: 'PLATFORM', platform: 'AMAZON', marketplace: null, amazonSlot: 'PT01',
  variantGroupKey: null, variantGroupValue: null, ...p,
})

describe('classifyTarget', () => {
  it('an empty cell is a fill', () => {
    expect(classifyTarget({ at: at(), resolved: resolved({}), writable: true }).outcome).toBe('fill')
  })

  it('a cell showing the shared picture is a PIN, not a fill', () => {
    // It will look unchanged afterwards. Counting it as a fill would let an operator believe they
    // filled empties when they actually pinned inherited slots.
    const shared = row({ id: 's', url: 'shared' })
    expect(classifyTarget({ at: at(), resolved: resolved({ origin: 'shared', url: 'shared', row: shared }), writable: true }).outcome).toBe('pin')
  })

  it('a cell showing master is a pin too', () => {
    expect(classifyTarget({ at: at(), resolved: resolved({ origin: 'master', url: 'm' }), writable: true }).outcome).toBe('pin')
  })

  it('a cell with a row of its own is an OVERWRITE', () => {
    const own = row({ id: 'o', url: 'old', variantGroupValue: 'Giallo' })
    expect(classifyTarget({ at: at(), resolved: resolved({ origin: 'platform', url: 'old', row: own }), writable: true }).outcome).toBe('overwrite')
  })

  it('a pictureless row of its own is still an overwrite, not a fill', () => {
    // The row exists; writing replaces it rather than adding a second at the same coordinate.
    const phantom = row({ id: 'p', url: '', variantGroupValue: 'Giallo' })
    expect(classifyTarget({ at: at(), resolved: resolved({ origin: 'pictureless', url: null, row: phantom }), writable: true }).outcome).toBe('overwrite')
  })

  it('🔴 an all-markets picture seen from a MARKET is a pin, not a fill', () => {
    // The case that shipped wrong: viewing IT, the picture comes from the PLATFORM row, which
    // ownRowAt correctly refuses to treat as owned. It is not empty, so it must never be a fill.
    const platformRow = row({ id: 'p', url: 'pic', variantGroupValue: 'Giallo' })
    const t = classifyTarget({
      at: at({ market: 'IT' }),
      resolved: resolved({ origin: 'platform', url: 'pic', row: platformRow }),
      writable: true,
    })
    expect(t.outcome).toBe('pin')
  })

  it('classifies by whether a picture is THERE, not by which origin produced it', () => {
    const odd = resolved({ origin: 'market', url: 'pic', row: row({ id: 'x', url: 'pic' }) })
    // Not owned at this coordinate (different bucket), but a picture is present.
    expect(classifyTarget({ at: at({ groupValue: 'Nero' }), resolved: odd, writable: true }).outcome).toBe('pin')
  })

  it('a read-only slot is skipped, with the reason', () => {
    const t = classifyTarget({ at: at(), resolved: resolved({}), writable: false })
    expect(t.outcome).toBe('skip')
    expect(t.reason).toMatch(/read-only/)
  })

  it('a locked row is skipped, with a different reason', () => {
    const locked = row({ id: 'l', url: 'u', variantGroupValue: 'Giallo', locked: true })
    const t = classifyTarget({ at: at(), resolved: resolved({ origin: 'platform', url: 'u', row: locked }), writable: true })
    expect(t.outcome).toBe('skip')
    expect(t.reason).toMatch(/locked/)
  })
})

describe('buildBulkPlan', () => {
  it('counts each outcome and emits an upsert only for what it will write', () => {
    const own = row({ id: 'o', url: 'old', variantGroupValue: 'Giallo' })
    const plan = buildBulkPlan({
      url: 'new',
      targets: [
        { at: at({ slot: 'PT01' }), resolved: resolved({}), writable: true },
        { at: at({ slot: 'PT02' }), resolved: resolved({ origin: 'platform', url: 'old', row: own }), writable: true },
        { at: at({ slot: 'PT03' }), resolved: resolved({}), writable: false },
      ],
    })
    expect(plan.counts).toEqual({ fill: 1, pin: 0, overwrite: 1, skip: 1 })
    expect(plan.upserts).toHaveLength(2)
  })

  it('carries the existing row id on an overwrite, so bulk-save updates rather than duplicating', () => {
    const own = row({ id: 'keep-me', url: 'old', variantGroupValue: 'Giallo' })
    const plan = buildBulkPlan({
      url: 'new',
      targets: [{ at: at(), resolved: resolved({ origin: 'platform', url: 'old', row: own }), writable: true }],
    })
    expect(plan.upserts[0].id).toBe('keep-me')
  })

  it('omits the id when pinning over an inherited picture', () => {
    const shared = row({ id: 'shared', url: 'x' })
    const plan = buildBulkPlan({
      url: 'new',
      targets: [{ at: at(), resolved: resolved({ origin: 'shared', url: 'x', row: shared }), writable: true }],
    })
    expect(plan.upserts[0].id).toBeUndefined()
  })
})

describe('the sentence on the button', () => {
  it('leads with REPLACE when anything would be overwritten', () => {
    const s = describePlan({ fill: 3, pin: 2, overwrite: 4, skip: 0 })
    expect(s.indexOf('REPLACE')).toBeLessThan(s.indexOf('fill'))
    expect(s).toMatch(/REPLACE 4 existing images/)
  })

  it('names pins separately from fills', () => {
    expect(describePlan({ fill: 2, pin: 3, overwrite: 0, skip: 0 }))
      .toMatch(/fill 2 empty slots, pin 3 inherited slots\./)
  })

  it('says plainly when there is nothing to write', () => {
    expect(describePlan({ fill: 0, pin: 0, overwrite: 0, skip: 4 })).toMatch(/Nothing to write/)
    expect(describePlan({ fill: 0, pin: 0, overwrite: 0, skip: 0 })).toBe('No slots selected.')
  })

  it('mentions skips without letting them lead', () => {
    expect(describePlan({ fill: 1, pin: 0, overwrite: 0, skip: 2 })).toMatch(/skip 2 read-only or locked\.$/)
  })
})
