import { describe, expect, it } from 'vitest'
import { moveModeLabel, type StudioPublishChange, type StudioPublishReview } from './studio-publication.js'
import {
  confirmCountMatches, confirmMatches, confirmRowsTicked, defaultLifecycleTicks, defaultReviewTicks, MANY_PUBLISH_ACTION_LABEL, MANY_PUBLISH_ACTIONS, manyEndCount,
  publishPlanCounts, publishPlanUsesBatch, STATUS_TARGET_ACTIONS, TYPE_COUNT_TO_END, type PublishPlanDestination, type PublishPlanLifecycleRow,
} from './publish-plan.js'

/** Build shape v2, P6 — the pure helpers of one mixed Publish: default ticks, the counts for the summary line, the path. */
const change = (id: string, productId: string, extra: Partial<StudioPublishChange> = {}): StudioPublishChange => ({ id, productId, sku: productId, field: id, label: id,
  current: { state: 'absent' }, lastAccepted: { state: 'absent' }, channel: { state: 'absent' }, status: 'SEND', localChanged: true, channelChanged: false,
  selectable: true, selectedByDefault: true, reason: '', operation: 'replace', ...extra })

const review = (changes: StudioPublishChange[], full: string[] = []): StudioPublishReview => ({ id: 'r1', productId: 'f', scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'a' },
  accountLabel: '', aliasLabel: '', mode: 'live', action: 'update', excluded: 0, issues: [], expiresAt: '', changes,
  rows: [...new Set(changes.map(c => c.productId))].map(productId => ({ productId, sku: productId, title: productId, existing: true, mode: full.includes(productId) ? 'full' as const : 'partial' as const })) })

const row = (id: string, action: PublishPlanLifecycleRow['action'], extra: Partial<PublishPlanLifecycleRow> = {}): PublishPlanLifecycleRow => ({ id, listingId: id, productId: id, sku: id,
  isParent: false, column: action === 'delete' ? 'send' : 'status', value: action === 'delete' ? 'delete' : action === 'pause' ? 'inactive' : action === 'end' ? 'ended' : 'active',
  action, step: action, state: 'active', sentence: '', consequence: '', warning: null, checkedAtSend: null, setAt: '', setById: null, setByName: null,
  stale: false, tickedByDefault: true, needsTypedConfirm: action === 'end' || action === 'delete', refused: null, ...extra })

const destination = (r: StudioPublishReview | null, lifecycle: PublishPlanLifecycleRow[], outgrown = 0): PublishPlanDestination => ({
  scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'a' }, destination: { channel: 'AMAZON', marketplace: 'IT', accountId: 'a', aliasKey: '' }, label: 'Amazon · IT',
  review: r, fullProductIds: [], contentHeld: [], lifecycle, error: null,
  outgrown: Array.from({ length: outgrown }, (_, i) => ({ id: `o${i}`, listingId: `o${i}`, productId: `o${i}`, sku: `o${i}`, column: 'status' as const, value: 'inactive' as const, reason: 'Already inactive.' })) })

describe('publish plan counts', () => {
  const plan = { destinations: [destination(review([change('s1', 'S', { locked: true }), change('s2', 'S', { locked: true }), change('m1', 'M'), change('l1', 'L'),
    change('l2', 'L', { selectedByDefault: false }), change('x1', 'X', { selectable: false })], ['S']), [
    row('p1', 'pause'), row('p2', 'pause', { stale: true, tickedByDefault: false }), row('r1', 'relist'), row('e1', 'end'),
    row('d1', 'delete', { refused: 'Your role cannot end or delete listings, so this stays waiting.', tickedByDefault: false })])] }

  it('counts the default ticks: partial rows and fields, full rows, and each lifecycle step; never a refused row', () => {
    expect(defaultReviewTicks(plan.destinations[0].review)).toEqual(['s1', 's2', 'm1', 'l1'])
    expect(defaultLifecycleTicks(plan)).toEqual(['p1', 'r1', 'e1'])
    expect(publishPlanCounts(plan)).toEqual({ partial: 2, fields: 2, full: 1, delete: 0, active: 1, inactive: 1, ended: 1 })
  })

  it('recounts with the person\'s ticks', () => {
    expect(publishPlanCounts(plan, { fields: { r1: ['l1', 'l2'] }, lifecycle: ['p1', 'p2', 'd1'] }))
      .toEqual({ partial: 1, fields: 2, full: 0, delete: 0, active: 0, inactive: 2, ended: 0 })
    expect(confirmRowsTicked(plan, ['e1', 'd1', 'p1'])).toBe(1)
  })

  it('S10: a moved row (mode "move") is counted as a move, never as a partial or full update', () => {
    const moved = review([change('c1', 'M'), change('t1', 'P')])
    moved.rows = moved.rows.map(entry => entry.productId === 'M' ? { ...entry, mode: 'move' as const } : entry)
    expect(publishPlanCounts({ destinations: [destination(moved, [])] })).toEqual({ partial: 1, fields: 1, full: 0, delete: 0, active: 0, inactive: 0, ended: 0, moved: 1 })
    expect(moveModeLabel('GALE-M-IT')).toBe('Move to GALE-M-IT')
  })
})

describe('the typed confirmation and the path', () => {
  it('confirms with the exact SKU, ignoring surrounding spaces', () => {
    expect(confirmMatches('GALE', ' GALE ')).toBe(true)
    expect(confirmMatches('GALE', 'gale')).toBe(false)
    expect(confirmMatches('GALE', null)).toBe(false)
    expect(confirmMatches('', '')).toBe(false)
  })

  it('takes the batch for many destinations, a ticked lifecycle row or a value to clear; one destination with content only goes direct', () => {
    const one = { destinations: [destination(null, [])] }
    expect(publishPlanUsesBatch(one, { destinations: 1, lifecycle: [] })).toBe(false)
    expect(publishPlanUsesBatch(one, { destinations: 2, lifecycle: [] })).toBe(true)
    expect(publishPlanUsesBatch(one, { destinations: 1, lifecycle: ['p1'] })).toBe(true)
    expect(publishPlanUsesBatch({ destinations: [destination(null, [], 1)] }, { destinations: 1, lifecycle: [] })).toBe(true)
  })
})

/** P11 — the products list's Publish… window: a Status for many products, Ended confirmed by the typed count. */
describe('many products × markets with a Status', () => {
  it('offers Send changes and the three Status targets, never Delete', () => {
    expect(MANY_PUBLISH_ACTIONS).toEqual(['content', 'active', 'inactive', 'ended'])
    expect(MANY_PUBLISH_ACTIONS.map(a => MANY_PUBLISH_ACTION_LABEL[a])).toEqual(['Send changes', 'Set Active', 'Set Inactive', 'Set Ended'])
    expect(Object.values(STATUS_TARGET_ACTIONS).flat()).not.toContain('delete')
    expect(STATUS_TARGET_ACTIONS.active).toEqual(['resume', 'relist'])
  })

  it('Ended asks for the count of listings it ends, typed exactly (spaces around it do not count)', () => {
    const end = (sendCount: number, status = 'PREVIEW') => ({ kind: 'lifecycle' as const, status, action: 'end' as const, sendCount })
    const children = [end(30), end(6), end(0), end(4, 'NOT_SENT'), { kind: 'lifecycle' as const, status: 'PREVIEW', action: 'pause' as const, sendCount: 9 },
      { kind: 'content' as const, status: 'PREVIEW', action: null, sendCount: null }]
    expect(manyEndCount(children)).toBe(36)
    expect(TYPE_COUNT_TO_END(36)).toBe('Type 36 to end 36 listings.')
    expect(TYPE_COUNT_TO_END(1)).toBe('Type 1 to end 1 listing.')
    expect(confirmCountMatches(36, ' 36 ')).toBe(true)
    expect(confirmCountMatches(36, '35')).toBe(false)
    expect(confirmCountMatches(36, 'GALE')).toBe(false)
    expect(confirmCountMatches(0, '0')).toBe(false)
    expect(confirmCountMatches(36, null)).toBe(false)
  })
})

/** New listings (ND4 B, Owner 2026-10-04) — "New listings start as" and the review's "Creates GALE-M (inactive)". */
describe('New listings start as', () => {
  it('takes Active or Inactive only, and says what each row creates', async () => {
    const { createsSentence, isStartAsTarget, START_AS_LABEL, START_AS_WORD } = await import('./publish-plan.js')
    expect(START_AS_LABEL).toBe('New listings start as')
    expect(START_AS_WORD).toEqual({ active: 'Active', inactive: 'Inactive' })
    expect(isStartAsTarget('inactive')).toBe(true)
    expect(isStartAsTarget('ended')).toBe(false)
    expect(createsSentence([])).toBeNull()
    expect(createsSentence([{ sku: 'GALE-M', startsAs: 'inactive' }])).toBe('Creates GALE-M (inactive).')
    expect(createsSentence(['S', 'M', 'L', 'XL', 'XXL'].map(size => ({ sku: `GALE-${size}`, startsAs: 'active' as const }))))
      .toBe('Creates GALE-S (active), GALE-M (active), GALE-L (active) and 2 more.')
  })
})
