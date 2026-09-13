/**
 * PES.8 — the rules the review surface depends on, tested without a server.
 *
 * The two that matter most are negative: a cell must NOT be tinted for a draft nobody can approve,
 * and "approve this column" must NOT quietly include the stale ones. Both are the kind of thing
 * that looks right on screen while doing the wrong thing.
 */
import { describe, expect, it } from 'vitest'

import {
  cellIndexKey,
  projectDrafts,
  displayValue,
  groupByColumn,
  indexDrafts,
  isCleanlyApprovable,
  isNoOpDiff,
  measure,
  provenanceFor,
  splitViolations,
  toSheetDraft,
} from './drafts'
import type { AiDraft } from './types'

const draft = (over: Partial<AiDraft> = {}): AiDraft => ({
  id: over.id ?? 'd1',
  productId: over.productId ?? 'p1',
  cellKey: 'master:name',
  writeField: 'name',
  columnKey: 'item_name',
  channel: null,
  marketplace: null,
  aliasId: null,
  locale: null,
  draftValue: 'a new title',
  baseValue: 'the old title',
  baseSource: 'stored',
  status: 'pending',
  confidence: 'high',
  rationale: null,
  violations: null,
  capsUsed: null,
  runId: 'r1',
  provider: 'anthropic',
  model: 'claude-opus-5',
  createdAt: '2026-09-01T00:00:00.000Z',
  stale: false,
  unverified: false,
  lastApplyError: null,
  ...over,
})

describe('provenanceFor', () => {
  it('marks a clean pending draft as drafted, not stale', () => {
    const idx = indexDrafts([draft()])
    expect(provenanceFor(idx, { rowId: 'p1', colId: 'item_name' })).toEqual({
      aiDrafted: true,
      aiStale: false,
    })
  })

  it('marks a stale draft stale, so it cannot be drawn as a clean one', () => {
    const idx = indexDrafts([draft({ stale: true })])
    expect(provenanceFor(idx, { rowId: 'p1', colId: 'item_name' })).toEqual({
      aiDrafted: true,
      aiStale: true,
    })
  })

  it('treats an unverifiable draft as stale — never as clean', () => {
    // We could not read the cell, so "not stale" would be a claim we have not earned.
    const idx = indexDrafts([draft({ unverified: true })])
    expect(provenanceFor(idx, { rowId: 'p1', colId: 'item_name' })?.aiStale).toBe(true)
  })

  it('does NOT tint a cell for a failed draft', () => {
    // A draft that broke a hard cap has no offerable value; tinting the cell would promise the
    // operator something to approve that the server will refuse.
    const idx = indexDrafts([draft({ status: 'failed' })])
    expect(provenanceFor(idx, { rowId: 'p1', colId: 'item_name' })).toBeNull()
  })

  it('returns null for a cell with no draft, so existing provenance survives', () => {
    const idx = indexDrafts([draft()])
    expect(provenanceFor(idx, { rowId: 'p1', colId: 'description' })).toBeNull()
    expect(provenanceFor(idx, { rowId: 'p2', colId: 'item_name' })).toBeNull()
  })

  it('keeps the newest when a cell somehow carries two drafts', () => {
    const idx = indexDrafts([
      draft({ id: 'old', draftValue: 'old', createdAt: '2026-09-01T00:00:00.000Z' }),
      draft({ id: 'new', draftValue: 'new', createdAt: '2026-09-02T00:00:00.000Z' }),
    ])
    expect(idx.get(cellIndexKey('p1', 'item_name'))?.id).toBe('new')
  })
})

describe('groupByColumn', () => {
  it('offers only cleanly approvable drafts for a column-level approve', () => {
    const group = groupByColumn([
      draft({ id: 'clean', productId: 'p1' }),
      draft({ id: 'stale', productId: 'p2', stale: true }),
      draft({ id: 'failed', productId: 'p3', status: 'failed' }),
      draft({ id: 'unverified', productId: 'p4', unverified: true }),
    ])[0]

    expect(group.drafts).toHaveLength(4)
    // The bulk control must never waive staleness — that decision belongs beside the value it
    // would replace, one cell at a time.
    expect(group.approvable.map((d) => d.id)).toEqual(['clean'])
    expect(group.staleCount).toBe(1)
    expect(group.failedCount).toBe(1)
    expect(group.unverifiedCount).toBe(1)
  })

  it('surfaces the caps a column was held to', () => {
    const group = groupByColumn([
      draft({ capsUsed: null }),
      draft({ id: 'd2', productId: 'p2', capsUsed: { maxLength: 200, maxBytes: 200, capFrom: 'Amazon · IT' } }),
    ])[0]
    expect(group.caps).toEqual({ maxLength: 200, maxBytes: 200, capFrom: 'Amazon · IT' })
  })

  it('sorts groups by column so the review is stable across reloads', () => {
    const groups = groupByColumn([
      draft({ columnKey: 'material' }),
      draft({ columnKey: 'bullet_point', id: 'b' }),
      draft({ columnKey: 'item_name', id: 'c' }),
    ])
    expect(groups.map((g) => g.columnKey)).toEqual(['bullet_point', 'item_name', 'material'])
  })
})

describe('isCleanlyApprovable', () => {
  it('is true only for a pending, fresh, verifiable draft', () => {
    expect(isCleanlyApprovable(draft())).toBe(true)
    expect(isCleanlyApprovable(draft({ stale: true }))).toBe(false)
    expect(isCleanlyApprovable(draft({ unverified: true }))).toBe(false)
    expect(isCleanlyApprovable(draft({ status: 'failed' }))).toBe(false)
    expect(isCleanlyApprovable(draft({ status: 'approved' }))).toBe(false)
  })
})

describe('displayValue / measure', () => {
  it('renders a list one member per line, never truncated', () => {
    const long = 'x'.repeat(500)
    expect(displayValue(['a', 'b', 'c'])).toBe('a\nb\nc')
    expect(displayValue([long])).toHaveLength(500)
  })

  it('renders an absent value as empty rather than "null"', () => {
    expect(displayValue(null)).toBe('')
    expect(displayValue(undefined)).toBe('')
  })

  it('counts UTF-8 bytes, not just characters', () => {
    // The whole reason the byte cap exists: 150 accented characters are 300 bytes, and a
    // character-only counter reads green on a value Amazon refuses.
    const accented = 'à'.repeat(150)
    expect(measure(accented)).toEqual({ chars: 150, bytes: 300 })
  })
})

describe('isNoOpDiff / splitViolations', () => {
  it('spots a draft that would change nothing', () => {
    expect(isNoOpDiff(draft({ draftValue: 'same', baseValue: 'same' }))).toBe(true)
    expect(isNoOpDiff(draft({ draftValue: ['a', 'b'], baseValue: ['a', 'b'] }))).toBe(true)
    expect(isNoOpDiff(draft())).toBe(false)
  })

  it('separates blocking errors from ride-along warnings', () => {
    const { errors, warnings } = splitViolations([
      { kind: 'over_max_bytes', severity: 'error', message: 'too long' },
      { kind: 'off_list', severity: 'warn', message: 'not in the list' },
    ])
    expect(errors).toHaveLength(1)
    expect(warnings).toHaveLength(1)
  })

  it('treats no violations as no violations', () => {
    expect(splitViolations(null)).toEqual({ errors: [], warnings: [] })
  })
})

describe('the sheet overlay shape (PES.2 contract)', () => {
  it('never offers a failed draft to the cell renderer', () => {
    // The cell shows a proposal an operator can act on. A draft that broke a hard cap is not one:
    // the server refuses it, so tinting the cell would promise something undeliverable. It stays
    // in the review list where its violation can be read.
    expect(toSheetDraft(draft({ status: 'failed' }))).toBeNull()
    expect(toSheetDraft(draft({ status: 'approved' }))).toBeNull()
    expect(toSheetDraft(draft())).toMatchObject({ draftValue: 'a new title', stale: false })
  })

  it('passes violation MESSAGES through, since the cell tooltip renders strings', () => {
    const d = draft({
      violations: [{ kind: 'off_list', severity: 'warn', message: 'not in the list' }],
    })
    expect(d.violations?.map((v) => v.message)).toEqual(['not in the list'])
  })
})

it('projects draft language onto view keys before indexing and grouping', () => {
  const projected = projectDrafts([
    draft({ id: 'de', columnKey: 'name', locale: 'de-DE' }),
    draft({ id: 'fr', columnKey: 'name', locale: 'fr' }),
    draft({ id: 'es', columnKey: 'name', locale: 'es' }),
  ], ['name@de','name@fr'])
  expect(projected.map(d => [d.id,d.columnKey,d.writeField])).toEqual([['de','name@de','name'],['fr','name@fr','name']])
  expect(indexDrafts(projected).size).toBe(2)
  expect(groupByColumn(projected).map(group => group.columnKey)).toEqual(['name@de','name@fr'])
})
