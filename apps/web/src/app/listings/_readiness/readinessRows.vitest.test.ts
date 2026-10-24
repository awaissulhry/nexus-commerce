import { describe, expect, it } from 'vitest'
import type { ReadinessFamilyRow, ReadinessMemberRow } from '@nexus/shared/listing-readiness'
import { canExpand, familyFooter, familyPreview, isFamilyRow, isMemberRow, isReadinessFooter, readinessRowId } from './readinessRows'
import { EMPTY_PLAN, addToPlan, familiesToRefresh, readinessRootOf } from './readinessLive'

const base = { sku: 'S', name: null, imageUrl: null, photoCount: 0, state: 'ready' as const, chips: [], nextStep: null, computedAt: null, pending: false, editorHref: '/e' }
const familyRow = (over: Partial<ReadinessFamilyRow> = {}): ReadinessFamilyRow => ({ ...base, id: 'root', isParent: true, variantCount: 40, matchingCount: 12, ...over })
const memberRow = (over: Partial<ReadinessMemberRow> = {}): ReadinessMemberRow => ({ ...base, id: 'm1', parentId: 'root', isParentListing: false, ...over })

describe('the grid’s rows', () => {
  it('a family with matching members folds open; a single product and an empty family do not', () => {
    expect(canExpand(familyRow())).toBe(true)
    expect(canExpand(familyRow({ isParent: false, variantCount: 0, matchingCount: 1 }))).toBe(false)
    expect(canExpand(familyRow({ matchingCount: 0 }))).toBe(false)
    expect(canExpand(memberRow())).toBe(false)
  })
  it('tells the three kinds apart', () => {
    const footer = familyFooter('root', 10, 40)
    expect(isReadinessFooter(footer)).toBe(true)
    expect(isFamilyRow(familyRow())).toBe(true)
    expect(isMemberRow(memberRow())).toBe(true)
    expect(isMemberRow(familyRow())).toBe(false)
    expect(isFamilyRow(footer)).toBe(false)
    expect(footer).toMatchObject({ parentId: 'root', shown: 10, total: 40 })
  })
  it('row ids carry their path, so a parent’s own listing does not collide with its family row', () => {
    expect(readinessRowId({ id: 'root' }, undefined)).toBe('root')
    expect(readinessRowId({ id: 'root' }, ['root'])).toBe('root/root')
  })
})

describe('live: what an event refreshes', () => {
  it('readiness.updated names its family (the subject id, else the payload)', () => {
    expect(readinessRootOf({ type: 'readiness.updated', id: 'r1' })).toBe('r1')
    expect(readinessRootOf({ type: 'readiness.updated', meta: { rootProductId: 'r2' } })).toBe('r2')
    expect(readinessRootOf({ type: 'product.updated', id: 'p1' })).toBeNull()
  })
  it('only the named open families; any other event refreshes every open family', () => {
    let plan = addToPlan(EMPTY_PLAN, { type: 'readiness.updated', id: 'r1' })
    plan = addToPlan(plan, { type: 'readiness.updated', id: 'r9' })
    expect(familiesToRefresh(plan, ['r1', 'r2'])).toEqual(['r1'])
    plan = addToPlan(plan, { type: 'listing.updated', id: 'l1' })
    expect(familiesToRefresh(plan, ['r1', 'r2'])).toEqual(['r1', 'r2'])
    expect(familiesToRefresh(EMPTY_PLAN, ['r1'])).toEqual([])
  })
})

describe('an open family’s preview', () => {
  const members = (n: number, parent: boolean) => [
    ...(parent ? [memberRow({ id: 'root', parentId: null, isParentListing: true })] : []),
    ...Array.from({ length: n }, (_, i) => memberRow({ id: `v${i}` })),
  ]
  it('shows the parent’s own listing and 10 variations, and the footer counts variations only', () => {
    const rows = familyPreview('root', { rows: members(10, true), total: 21 }, 10)
    expect(rows).toHaveLength(12)
    expect(rows[11]).toMatchObject({ __familyFooter: true, shown: 10, total: 20 })
  })
  it('without a matching parent listing it keeps 10 variations', () => {
    const rows = familyPreview('root', { rows: members(11, false), total: 40 }, 10)
    expect(rows).toHaveLength(11)
    expect(rows[10]).toMatchObject({ shown: 10, total: 40 })
  })
  it('a family with nothing that matches has no footer', () => {
    expect(familyPreview('root', { rows: [], total: 0 }, 10)).toEqual([])
  })
})
