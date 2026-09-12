import { describe, expect, it } from 'vitest'

import { describePlan, restorePlan } from './restorePlan'
import type { SnapshotRow } from './publishPrefs'
import type { CascadeRow } from '../channel/amazon/cascade'

const snapRow = (slot: string, url: string, position = 0, groupValue: string | null = 'Nero'): SnapshotRow =>
  ({ slot, url, position, groupValue })

const row = (over: Partial<CascadeRow> & { id: string }): CascadeRow => ({
  scope: 'MARKETPLACE', platform: 'AMAZON', marketplace: 'IT', amazonSlot: 'MAIN',
  variantGroupKey: 'Colore', variantGroupValue: 'Nero', url: 'now.jpg', ...over,
})

describe('restorePlan — writes only what differs', () => {
  it('does not rewrite a row that already matches the snapshot', () => {
    const plan = restorePlan({
      snapshot: [snapRow('MAIN', 'same.jpg')],
      current: [row({ id: 'r1', url: 'same.jpg', publishStatus: 'PUBLISHED' })],
      market: 'IT',
      groupKey: 'Colore',
    })
    // The whole point: an unchanged live row must not be demoted to DRAFT for nothing.
    expect(plan.upserts).toEqual([])
    expect(plan.unpublishes).toBe(0)
    expect(describePlan(plan)).toMatch(/already matches this restore point/)
  })

  it('still deletes rows added since, while leaving the matching ones untouched', () => {
    const plan = restorePlan({
      snapshot: [snapRow('MAIN', 'same.jpg')],
      current: [
        row({ id: 'r1', url: 'same.jpg', publishStatus: 'PUBLISHED' }),
        row({ id: 'added', amazonSlot: 'PT01', url: 'new.jpg' }),
      ],
      market: 'IT',
      groupKey: 'Colore',
    })
    expect(plan.upserts).toEqual([])
    expect(plan.deletes).toEqual(['added'])
  })
})

describe('restorePlan — the duplicate-row trap', () => {
  it('carries the existing row id so a restore updates rather than duplicating', () => {
    const plan = restorePlan({
      snapshot: [snapRow('MAIN', 'was.jpg')],
      current: [row({ id: 'r1' })],
      market: 'IT',
      groupKey: 'Colore',
    })
    expect(plan.upserts).toHaveLength(1)
    expect(plan.upserts[0].id).toBe('r1')
    expect(plan.upserts[0].url).toBe('was.jpg')
    expect(plan.creates).toBe(0)
  })

  it('creates only where no row exists at that coordinate', () => {
    const plan = restorePlan({
      snapshot: [snapRow('MAIN', 'was.jpg'), snapRow('PT01', 'other.jpg', 1)],
      current: [row({ id: 'r1' })],
      market: 'IT',
      groupKey: 'Colore',
    })
    expect(plan.creates).toBe(1)
    expect(plan.upserts.find((u) => u.amazonSlot === 'PT01')?.id).toBeUndefined()
    expect(plan.upserts.find((u) => u.amazonSlot === 'MAIN')?.id).toBe('r1')
  })
})

describe('restorePlan — scope', () => {
  it('leaves other markets entirely alone', () => {
    const plan = restorePlan({
      snapshot: [snapRow('MAIN', 'was.jpg')],
      current: [row({ id: 'it' }), row({ id: 'de', marketplace: 'DE' })],
      market: 'IT',
      groupKey: 'Colore',
    })
    expect(plan.upserts[0].id).toBe('it')
    expect(plan.deletes).toEqual([])
  })

  it('does not touch the PLATFORM layer when restoring a market', () => {
    const plan = restorePlan({
      snapshot: [snapRow('MAIN', 'was.jpg')],
      current: [row({ id: 'shared', scope: 'PLATFORM', marketplace: null })],
      market: 'IT',
      groupKey: 'Colore',
    })
    expect(plan.deletes).toEqual([])
    expect(plan.upserts[0].id).toBeUndefined()
  })

  it('restores the all-markets layer when market is null', () => {
    const plan = restorePlan({
      snapshot: [snapRow('MAIN', 'was.jpg')],
      current: [row({ id: 'shared', scope: 'PLATFORM', marketplace: null })],
      market: null,
      groupKey: 'Colore',
    })
    expect(plan.upserts[0]).toMatchObject({ id: 'shared', scope: 'PLATFORM', marketplace: null })
  })

  it('deletes what was added since, and only that', () => {
    const plan = restorePlan({
      snapshot: [snapRow('MAIN', 'was.jpg')],
      current: [row({ id: 'r1' }), row({ id: 'added', amazonSlot: 'PT01' })],
      market: 'IT',
      groupKey: 'Colore',
    })
    expect(plan.deletes).toEqual(['added'])
  })

  it('uses a null group key for the shared bucket, never the axis name', () => {
    const plan = restorePlan({
      snapshot: [snapRow('MAIN', 'was.jpg', 0, null)],
      current: [],
      market: 'IT',
      groupKey: 'Colore',
    })
    expect(plan.upserts[0].variantGroupKey).toBeNull()
    expect(plan.upserts[0].variantGroupValue).toBeNull()
  })

  it('ignores current rows with no slot', () => {
    const plan = restorePlan({
      snapshot: [],
      current: [row({ id: 'noslot', amazonSlot: null })],
      market: 'IT',
      groupKey: 'Colore',
    })
    expect(plan.deletes).toEqual([])
  })
})

describe('restorePlan — the publish state a snapshot cannot carry', () => {
  it('counts a live row whose picture would change', () => {
    const plan = restorePlan({
      snapshot: [snapRow('MAIN', 'was.jpg')],
      current: [row({ id: 'r1', url: 'now.jpg', publishStatus: 'PUBLISHED' })],
      market: 'IT',
      groupKey: 'Colore',
    })
    expect(plan.unpublishes).toBe(1)
  })

  it('does not count a live row the restore would leave byte-identical', () => {
    const plan = restorePlan({
      snapshot: [snapRow('MAIN', 'same.jpg')],
      current: [row({ id: 'r1', url: 'same.jpg', publishStatus: 'PUBLISHED' })],
      market: 'IT',
      groupKey: 'Colore',
    })
    expect(plan.unpublishes).toBe(0)
    expect(plan.upserts).toEqual([])
  })

  it('does not count a row that was never published', () => {
    const plan = restorePlan({
      snapshot: [snapRow('MAIN', 'was.jpg')],
      current: [row({ id: 'r1', url: 'now.jpg', publishStatus: 'DRAFT' })],
      market: 'IT',
      groupKey: 'Colore',
    })
    expect(plan.unpublishes).toBe(0)
  })
})

describe('describePlan', () => {
  it('says nothing would change when the channel already matches', () => {
    expect(describePlan({ upserts: [], deletes: [], creates: 0, unpublishes: 0 }))
      .toMatch(/already matches this restore point/)
  })

  it('counts each kind of change separately', () => {
    const d = describePlan({ upserts: [{} as never, {} as never, {} as never], deletes: ['a'], creates: 1, unpublishes: 0 })
    expect(d).toMatch(/2 pictures put back/)
    expect(d).toMatch(/1 restored to a slot that is empty now/)
    expect(d).toMatch(/1 added since removed/)
  })

  it('warns about demoted live rows, because the snapshot cannot put that back', () => {
    const d = describePlan({ upserts: [{} as never], deletes: [], creates: 0, unpublishes: 2 })
    expect(d).toMatch(/2 live rows will go back to unpublished/)
    expect(d).toMatch(/keeps the newer picture until you publish again/)
  })
})
