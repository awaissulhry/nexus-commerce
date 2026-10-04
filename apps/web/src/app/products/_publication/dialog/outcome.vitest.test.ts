import { describe, expect, it } from 'vitest'
import type { StudioPublicationStatus } from '@nexus/shared/studio-publication'
import { SHOW_ALL_ACTION, SHOW_REJECTED_ACTION, destinationLabel, isSettled, publicationEventMatches, publicationEventOf, publicationMark, publicationOutcome, rejectedFilterMenuLabel, resultCounts, summaryCounts, withRejectedFilter } from './outcome'

const destination = { productIds: ['child', 'family'], channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', aliasKey: '' }
const meta = { publicationId: 'pub', productId: 'family', channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', aliasKey: '', status: 'PARTIAL', terminal: true, source: 'sse' }
const counts = (c: Partial<Record<'products' | 'accepted' | 'verified' | 'failed' | 'submitted', number>>) => ({ products: 0, accepted: 0, verified: 0, failed: 0, submitted: 0, needsCheck: false, ...c })

function read(over: Partial<StudioPublicationStatus>): StudioPublicationStatus {
  return { destination: { channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', aliasKey: '' }, inFlight: null, latest: null, rows: [], readAt: '2026-10-02T10:00:00.000Z', ...over }
}

describe('publicationEventOf', () => {
  it('reads the bus payload from the invalidation meta', () => {
    expect(publicationEventOf({ id: 'pub', meta })).toEqual({ publicationId: 'pub', productId: 'family', channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', aliasKey: '', status: 'PARTIAL', terminal: true })
  })
  it('refuses an event that does not name a destination or a status', () => {
    expect(publicationEventOf({ meta: { ...meta, accountId: undefined } })).toBeNull()
    expect(publicationEventOf({ meta: { ...meta, status: '' } })).toBeNull()
    expect(publicationEventOf(null)).toBeNull()
  })
  it('treats a missing terminal flag as not final', () => {
    expect(publicationEventOf({ meta: { ...meta, terminal: 'true' } })?.terminal).toBe(false)
  })
})

describe('publicationEventMatches', () => {
  const event = publicationEventOf({ meta })!
  it('matches the family on the exact destination', () => {
    expect(publicationEventMatches(event, destination)).toBe(true)
  })
  it('ignores another account, market, listing or product', () => {
    expect(publicationEventMatches({ ...event, accountId: 'other' }, destination)).toBe(false)
    expect(publicationEventMatches({ ...event, marketplace: 'DE' }, destination)).toBe(false)
    expect(publicationEventMatches({ ...event, aliasKey: 'alt' }, destination)).toBe(false)
    expect(publicationEventMatches({ ...event, productId: 'else' }, destination)).toBe(false)
  })
})

describe('publicationOutcome', () => {
  it('says every product went through', () => {
    expect(publicationOutcome('ACCEPTED', counts({ products: 21, accepted: 21 }), 'AMAZON', 'IT')).toEqual({ tone: 'info', message: 'Amazon · IT accepted all 21 products.' })
    expect(publicationOutcome('VERIFIED', counts({ products: 1, verified: 1 }), 'EBAY', 'IT')).toEqual({ tone: 'success', message: 'eBay · IT accepted the product.' })
  })
  it('counts a partial result', () => {
    expect(publicationOutcome('PARTIAL', counts({ products: 21, accepted: 19, failed: 2 }), 'AMAZON', 'IT'))
      .toEqual({ tone: 'warning', message: 'Amazon · IT accepted 19 of 21 products. 2 were rejected.' })
    expect(publicationOutcome('PARTIAL', counts({ products: 3, verified: 2, failed: 1 }), 'AMAZON', 'IT')?.message).toBe('Amazon · IT accepted 2 of 3 products. 1 was rejected.')
  })
  it('says nothing changed only when nothing was accepted', () => {
    expect(publicationOutcome('FAILED', counts({}), 'AMAZON', 'IT')).toEqual({ tone: 'danger', message: 'Amazon · IT rejected the upload. Nothing changed on Amazon.' })
    expect(publicationOutcome('FAILED', counts({ products: 4, failed: 4 }), 'AMAZON', 'IT')?.message).toBe('Amazon · IT rejected all 4 products. Nothing changed on Amazon.')
    expect(publicationOutcome('FAILED', counts({ products: 4, accepted: 1, failed: 3 }), 'AMAZON', 'IT')?.message).toBe('Amazon · IT accepted 1 of 4 products. 3 were rejected.')
  })
  it('warns when the channel never answered', () => {
    expect(publicationOutcome('UNVERIFIED', null, 'AMAZON', 'DE')).toEqual({ tone: 'warning', message: 'Not confirmed — Amazon · DE has not answered. It may have arrived. Check before you publish again.' })
  })
  it('has nothing to say while a publication is on its way', () => {
    expect(publicationOutcome('SUBMITTED', counts({ products: 5, submitted: 5 }), 'AMAZON', 'IT')).toBeNull()
    expect(publicationOutcome('PUBLISHING', null, 'AMAZON', 'IT')).toBeNull()
  })
})

describe('publicationMark', () => {
  const latest = (status: string, summary: Record<string, unknown> | null) => ({ publicationId: 'pub', status, at: '2026-10-01T20:00:00.000Z', completedAt: '2026-10-01T20:20:00.000Z', summary })
  it('shows nothing without a read, a publication, or after a clean one', () => {
    expect(publicationMark(null, 'AMAZON', 'IT')).toBeNull()
    expect(publicationMark(read({}), 'AMAZON', 'IT')).toBeNull()
    expect(publicationMark(read({ latest: latest('VERIFIED', { products: 3, verified: 3 }) }), 'AMAZON', 'IT')).toBeNull()
    expect(publicationMark(read({ latest: latest('ACCEPTED', { products: 3, accepted: 3 }) }), 'AMAZON', 'IT')).toBeNull()
  })
  it('counts the products of the publication on its way', () => {
    const mark = publicationMark(read({ inFlight: { publicationId: 'pub', status: 'SUBMITTED' }, latest: latest('SUBMITTED', { products: 21, submitted: 21 }) }), 'AMAZON', 'IT')
    expect(mark).toMatchObject({ tone: 'info', label: 'Amazon · IT is processing 21 products' })
    expect(mark?.detail).toContain('Nexus checks Amazon by itself')
    expect(mark?.onSelect).toBeUndefined()
  })
  it('does not borrow the counts of an older publication', () => {
    const mark = publicationMark(read({ inFlight: { publicationId: 'new', status: 'PUBLISHING' }, latest: latest('FAILED', { products: 21, failed: 21 }) }), 'AMAZON', 'IT')
    expect(mark?.label).toBe('Sending the last publish to Amazon · IT')
  })
  it('warns about an unconfirmed publication and one the sweep gave up on', () => {
    expect(publicationMark(read({ inFlight: { publicationId: 'pub', status: 'UNVERIFIED' } }), 'EBAY', 'IT')).toMatchObject({ tone: 'warning', label: 'Result unknown on eBay · IT' })
    const stale = publicationMark(read({ inFlight: { publicationId: 'pub', status: 'SUBMITTED' }, latest: latest('SUBMITTED', { products: 2, submitted: 2, needsCheck: true }) }), 'AMAZON', 'IT')
    expect(stale).toMatchObject({ tone: 'warning', label: 'Result unknown on Amazon · IT' })
    expect(stale?.detail).toContain('7 days')
  })
  it('counts the rejected products of the last publish', () => {
    const mark = publicationMark(read({ latest: latest('PARTIAL', { products: 21, accepted: 19, failed: 2 }) }), 'AMAZON', 'IT')
    expect(mark).toMatchObject({ tone: 'danger', label: '2 rejected on Amazon · IT' })
    expect(mark?.detail).toMatch(/^In the publish of .+, Amazon rejected 2 of 21 products\.$/)
    expect(publicationMark(read({ latest: latest('FAILED', null) }), 'AMAZON', 'IT')?.label).toBe('Last publish failed on Amazon · IT')
  })
})

describe('counts and labels', () => {
  it('reads a stored summary and ignores junk', () => {
    expect(summaryCounts({ products: 3, accepted: 2, failed: 1, verified: 'x', needsCheck: true })).toEqual({ products: 3, accepted: 2, verified: 0, failed: 1, submitted: 0, needsCheck: true })
    expect(summaryCounts(null)).toBeNull()
  })
  it('counts a dialog result by per-SKU status', () => {
    const results = [{ sku: 'A', status: 'ACCEPTED' }, { sku: 'B', status: 'FAILED' }, { sku: 'C', status: 'VERIFIED' }, { sku: 'D', status: 'SUBMITTED' }] as never
    expect(resultCounts({ results })).toEqual({ products: 4, accepted: 1, verified: 1, failed: 1, submitted: 1, needsCheck: false })
  })
  it('names a destination the way every message does', () => {
    expect(destinationLabel('EBAY', 'DE')).toBe('eBay · DE')
  })
  it('settles on a final status only', () => {
    expect(isSettled('PARTIAL')).toBe(true)
    expect(isSettled('VERIFIED')).toBe(true)
    expect(isSettled('SUBMITTED')).toBe(false)
    expect(isSettled('UNVERIFIED')).toBe(false)
    expect(isSettled(null)).toBe(false)
  })
})

describe('withRejectedFilter — the "N rejected" mark shows those rows (step 3)', () => {
  const rejected = { tone: 'danger' as const, label: '2 rejected on Amazon · IT', detail: 'In the publish of 1 Oct, 20:07, Amazon rejected 2 of 21 products.' }
  it('makes a rejection mark a toggle while some row can be shown', () => {
    const toggle = () => undefined
    expect(withRejectedFilter(rejected, 2, false, toggle)).toEqual({ ...rejected, onSelect: toggle, actionLabel: SHOW_REJECTED_ACTION, selected: false })
    expect(withRejectedFilter(rejected, 2, true, toggle)).toMatchObject({ actionLabel: SHOW_ALL_ACTION, selected: true })
  })
  it('leaves a mark that only reports alone: no rows to show, or not a rejection', () => {
    const toggle = () => undefined
    expect(withRejectedFilter(rejected, 0, false, toggle)).toBe(rejected)
    const processing = { tone: 'info' as const, label: 'Amazon · IT is processing 21 products' }
    expect(withRejectedFilter(processing, 3, false, toggle)).toBe(processing)
    expect(withRejectedFilter(null, 3, false, toggle)).toBeNull()
  })
  it('names the same filter in the ⋯ menu, where a folded mark cannot be pressed', () => {
    expect(rejectedFilterMenuLabel(2, false, 'AMAZON', 'IT')).toBe('Show the 2 rows rejected on Amazon · IT')
    expect(rejectedFilterMenuLabel(1, false, 'AMAZON', 'IT')).toBe('Show the row rejected on Amazon · IT')
    expect(rejectedFilterMenuLabel(2, true, 'AMAZON', 'IT')).toBe('Show all rows')
  })
})
