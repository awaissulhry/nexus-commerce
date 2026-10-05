/**
 * Sheet publish parity, step 3 — the "Last publish" column's values. Every fact is the server's publication-status
 * read; these rules only key it to the sheet's rows and name the sheet columns the channel's problems belong to.
 */
import { describe, expect, it } from 'vitest'
import type { StudioPublicationStatus, StudioRowLastPublish, StudioRowPublicationStatus } from '@nexus/shared/studio-publication'
import { publishCellModel } from '@/design-system/grid'
import {
  PUBLISH_COLUMN, PUBLISH_COLUMN_WIDTH, SELLING_REREAD_WINDOW_MS, familyCounts, isRejectedRow, lastPublishKindLabel, publishCellText, publishColumn,
  publishColumnLookup, publishIssues, publishReadFor, publishSheetColumn, rejectedRowCount, rowPublishValue, samePublishValue, sellingChangeInFlight, sentFieldLabels,
  statusRowFor, type PublishRead,
} from './publishColumn'

const SCOPE = 'Amazon · IT'
const columns = [
  { key: 'title', label: 'Title', channels: { [SCOPE]: { key: 'item_name', attribute: 'item_name' } } },
  { key: 'color', label: 'Colour', channels: { [SCOPE]: { key: 'color', attribute: 'color' } } },
  { key: 'closure_type', label: 'Closure type', channels: { [SCOPE]: { key: 'closure__type', attribute: 'closure' } } },
  { key: 'bullet_point__2', label: 'Bullet point 2', slot: { index: 2 }, channels: { [SCOPE]: { key: 'bullet_point', attribute: 'bullet_point' } } },
  { key: 'bullet_point__1', label: 'Bullet point 1', slot: { index: 1 }, channels: { [SCOPE]: { key: 'bullet_point', attribute: 'bullet_point' } } },
  { key: 'brand', label: 'Brand', channels: { 'eBay · IT': { key: 'aspect_Marca', attribute: 'aspect_Marca' } } },
]
const lookup = publishColumnLookup(columns, SCOPE)

const last = (over: Partial<StudioRowLastPublish> = {}): StudioRowLastPublish => ({
  publicationId: 'pub-2', status: 'PARTIAL', outcome: 'FAILED', at: '2026-10-01T20:07:00.000Z', userName: 'Dev Owner', message: 'Amazon refused 1 attribute.',
  reference: 'FEED-1', sentFields: ['color', 'item_name'], issues: [{ code: '8541', severity: 'error', message: 'Not an allowed value.', attributeNames: ['color'] }], ...over,
})
const statusRow = (over: Partial<StudioRowPublicationStatus> = {}): StudioRowPublicationStatus => ({ productId: 'child-1', listingId: 'cl-1', sku: 'SKU-1', last: last(), issues: [], ...over })
const status = (over: Partial<StudioPublicationStatus> = {}): StudioPublicationStatus => ({
  destination: { channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', aliasKey: '' },
  inFlight: null,
  latest: { publicationId: 'pub-2', status: 'PARTIAL', at: '2026-10-01T20:07:00.000Z', completedAt: '2026-10-01T20:12:00.000Z', summary: { products: 2, failed: 1, accepted: 1 } },
  rows: [statusRow(), statusRow({ productId: 'child-2', listingId: 'cl-2', sku: 'SKU-2', last: last({ outcome: 'ACCEPTED', issues: [] }) })],
  readAt: '2026-10-02T10:00:00.000Z',
  ...over,
})
const ready = (s: StudioPublicationStatus | null = status()): PublishRead => ({ state: 'ready', status: s })
const row = (over: Partial<{ id: string; aliasId: string | null; listing: { id: string } | null; isParent: boolean }> = {}) => ({ id: 'child-1', aliasId: null, listing: { id: 'cl-1' }, ...over })

describe('publishColumnLookup — the sheet column a channel attribute belongs to', () => {
  it('prefers the channel’s own key, then its attribute, then a column’s own key', () => {
    expect(lookup('item_name')).toEqual({ key: 'title', label: 'Title' })
    expect(lookup('closure__type')).toEqual({ key: 'closure_type', label: 'Closure type' })
    expect(lookup('closure')).toEqual({ key: 'closure_type', label: 'Closure type' })
    expect(lookup('title')).toEqual({ key: 'title', label: 'Title' })
  })
  it('lands a list attribute on its first slot, whatever order the columns came in', () => {
    expect(lookup('bullet_point')?.key).toBe('bullet_point__1')
  })
  it('matches case-insensitively only after an exact match fails', () => {
    expect(lookup('COLOR')?.key).toBe('color')
  })
  it('reads an Amazon text field through its language suffix', () => {
    expect(lookup('item_name:["APJ6JRA9NG5V4","it_IT"]')).toEqual({ key: 'title', label: 'Title' })
    expect(sentFieldLabels(['item_name:["APJ6JRA9NG5V4","it_IT"]', 'generic_keyword:["APJ6JRA9NG5V4","it_IT"]'], lookup)).toEqual(['Title', 'generic_keyword'])
  })
  it('ignores another scope’s facts, and answers null for an attribute with no column here', () => {
    expect(lookup('aspect_Marca')).toBeNull()
    expect(lookup('item_package_weight')).toBeNull()
  })
})

describe('statusRowFor — keying the server’s rows to the sheet’s rows', () => {
  const rows = [statusRow(), statusRow({ productId: 'child-2', listingId: 'cl-2' })]
  it('keys by the row’s listing on this destination', () => {
    expect(statusRowFor(row({ id: 'child-2', listing: { id: 'cl-2' } }), rows)?.listingId).toBe('cl-2')
  })
  it('falls back to the product when the row has no listing here and exactly one status row names it', () => {
    expect(statusRowFor(row({ listing: null }), rows)?.listingId).toBe('cl-1')
  })
  it('never guesses between two listings of one product', () => {
    const twice = [statusRow(), statusRow({ listingId: 'cl-9' })]
    expect(statusRowFor(row({ listing: null }), twice)).toBeNull()
  })
})

describe('rowPublishValue — one row’s cell', () => {
  it('is undefined (a skeleton) until the first read answers', () => {
    expect(rowPublishValue(row(), { state: 'loading', status: null }, lookup, SCOPE)).toBeUndefined()
  })
  it('says the read failed instead of claiming "never published"', () => {
    const value = rowPublishValue(row(), { state: 'error', status: null }, lookup, SCOPE)
    expect(value).toMatchObject({ last: null, readError: 'Publish results could not be read.' })
    expect(publishCellModel(value as never).state).toBe('error')
  })
  it('keeps the last good answer when a later re-read fails', () => {
    expect(rowPublishValue(row(), { state: 'error', status: status() }, lookup, SCOPE)).toMatchObject({ last: { publicationId: 'pub-2' } })
  })
  it('is "never published" when there is nothing to read (no account) or no publish for the row', () => {
    expect(rowPublishValue(row(), { state: 'idle', status: null }, lookup, SCOPE)).toEqual({ destinationLabel: SCOPE, last: null })
    expect(rowPublishValue(row({ id: 'child-9', listing: { id: 'cl-9' } }), ready(), lookup, SCOPE)).toEqual({ destinationLabel: SCOPE, last: null })
  })
  it('says a row of another listing has its results there, never "never published"', () => {
    expect(rowPublishValue(row({ aliasId: 'alt-1' }), ready(), lookup, SCOPE)).toEqual({ otherListing: true, destinationLabel: SCOPE })
  })
  it('carries the row’s last publish with the sheet’s field names and each problem’s column', () => {
    const value = rowPublishValue(row(), ready(), lookup, SCOPE) as unknown as { last: Record<string, unknown> }
    expect(value.last).toMatchObject({
      publicationId: 'pub-2', status: 'FAILED', outcome: 'FAILED', userName: 'Dev Owner', reference: 'FEED-1', message: 'Amazon refused 1 attribute.',
      sentFields: ['Colour', 'Title'],
      issues: [{ code: '8541', severity: 'error', message: 'Not an allowed value.', fieldLabel: 'Colour', columnKey: 'color' }],
    })
  })
  it('tells each row’s own result: a row accepted inside a partly failed publish reads Accepted, never Partly failed', () => {
    const accepted = rowPublishValue(row({ id: 'child-2', listing: { id: 'cl-2' } }), ready(), lookup, SCOPE)
    expect(publishCellModel(accepted as never).meta.label).toBe('Accepted')
    expect(publishCellModel(rowPublishValue(row(), ready(), lookup, SCOPE) as never).meta.label).toBe('Failed')
    // No per-row result: the publication's word.
    const unknown = status({ rows: [statusRow({ last: last({ status: 'UNVERIFIED', outcome: 'UNKNOWN', issues: [] }) })] })
    expect(publishCellModel(rowPublishValue(row(), ready(unknown), lookup, SCOPE) as never).meta.label).toBe('Result unknown')
  })
  it('shows a publication still on its way through the row’s own last (its status is the in-flight one)', () => {
    const s = status({ inFlight: { publicationId: 'pub-3', status: 'SUBMITTED' }, rows: [statusRow({ last: last({ publicationId: 'pub-3', status: 'SUBMITTED', outcome: 'SUBMITTED', issues: [] }) })] })
    const value = rowPublishValue(row(), ready(s), lookup, SCOPE)
    expect(publishCellModel(value as never).meta.label).toBe('Waiting for channel')
  })
})

describe('publishIssues and sentFieldLabels', () => {
  it('names an attribute the sheet has no column for, and offers no "Go to field" for it', () => {
    const issues = publishIssues(last({ issues: [{ code: '', severity: 'warning', message: 'Recommended.', attributeNames: ['item_package_weight'] }] }), lookup)
    expect(issues).toEqual([{ code: null, severity: 'warning', message: 'Recommended.', fieldLabel: 'item_package_weight', columnKey: null }])
  })
  it('takes the first attribute that has a column', () => {
    expect(publishIssues(last({ issues: [{ code: 'x', severity: 'error', message: 'm', attributeNames: ['nope', 'closure'] }] }), lookup)[0].columnKey).toBe('closure_type')
  })
  it('keeps a complete new listing as one marker, and dedupes field names', () => {
    expect(sentFieldLabels(['$create', 'color'], lookup)).toEqual(['$create'])
    expect(sentFieldLabels(['bullet_point', 'bullet_point', 'unknown_field'], lookup)).toEqual(['Bullet point 1', 'unknown_field'])
  })
})

describe('isRejectedRow — what the "N rejected" filter shows', () => {
  it('is a row whose own result failed in the latest publish', () => {
    expect(isRejectedRow(row(), status())).toBe(true)
    expect(isRejectedRow(row({ id: 'child-2', listing: { id: 'cl-2' } }), status())).toBe(false)
  })
  it('is every row of a publication that failed whole, when no per-row result says otherwise', () => {
    const s = status({ latest: { publicationId: 'pub-2', status: 'FAILED', at: '', completedAt: null, summary: null }, rows: [statusRow({ last: last({ status: 'FAILED', outcome: null }) })] })
    expect(isRejectedRow(row(), s)).toBe(true)
    // …but a row whose own result says it went through is not rejected, whatever the publication's word.
    const passed = status({ latest: { publicationId: 'pub-2', status: 'FAILED', at: '', completedAt: null, summary: null }, rows: [statusRow({ last: last({ status: 'FAILED', outcome: 'ACCEPTED' }) })] })
    expect(isRejectedRow(row(), passed)).toBe(false)
  })
  it('ignores a row whose last publish is an older one, a row of another listing, and a latest publish that went through', () => {
    expect(isRejectedRow(row(), status({ rows: [statusRow({ last: last({ publicationId: 'pub-1' }) })] }))).toBe(false)
    expect(isRejectedRow(row({ aliasId: 'alt-1' }), status())).toBe(false)
    expect(isRejectedRow(row(), status({ latest: { publicationId: 'pub-2', status: 'VERIFIED', at: '', completedAt: null, summary: null } }))).toBe(false)
    expect(isRejectedRow(row(), null)).toBe(false)
  })
  it('counts the rows the filter will show', () => {
    expect(rejectedRowCount([row(), row({ id: 'child-2', listing: { id: 'cl-2' } })], status())).toBe(1)
  })
})

describe('every listing shown — each alias reads its own last publish (aliases, Owner 2026-10-05)', () => {
  // The sheet's own read answers for the main listing; alias "alt-1" was read on its own (aliasKey=alt-1).
  const altStatus = status({
    destination: { channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', aliasKey: 'alt-1' },
    latest: { publicationId: 'pub-9', status: 'FAILED', at: '2026-10-05T08:00:00.000Z', completedAt: null, summary: null },
    rows: [statusRow({ listingId: 'cl-alt-1', last: last({ publicationId: 'pub-9', status: 'FAILED', outcome: 'FAILED', at: '2026-10-05T08:00:00.000Z' }) })],
  })
  const byAlias: ReadonlyMap<string, PublishRead> = new Map([['alt-1', ready(altStatus)]])
  const altRow = row({ aliasId: 'alt-1', listing: { id: 'cl-alt-1' } })

  it('an alias row takes its alias\'s read; a main row and a listing nobody read take the sheet\'s', () => {
    expect(publishReadFor(altRow, ready(), byAlias).status).toBe(altStatus)
    expect(publishReadFor(row(), ready(), byAlias).status).toEqual(status())
    expect(publishReadFor(row({ aliasId: 'alt-2' }), ready(), byAlias).status).toEqual(status())
  })

  it('so an alias row shows its own last publish, not "Other listing"', () => {
    expect(rowPublishValue(altRow, ready(), lookup, SCOPE)).toEqual({ otherListing: true, destinationLabel: SCOPE })
    const own = rowPublishValue(altRow, publishReadFor(altRow, ready(), byAlias), lookup, SCOPE) as unknown as { last: Record<string, unknown> }
    expect(own.last).toMatchObject({ publicationId: 'pub-9', status: 'FAILED', at: '2026-10-05T08:00:00.000Z' })
    // While the alias's read is on its way, the cell is a skeleton — never another listing's answer.
    const loading = new Map([['alt-1', { state: 'loading', status: null } as PublishRead]])
    expect(rowPublishValue(altRow, publishReadFor(altRow, ready(), loading), lookup, SCOPE)).toBeUndefined()
  })

  it('the "N rejected" filter judges each row by its own listing\'s latest publish', () => {
    const statusOf = (r: { aliasId: string | null }) => publishReadFor(r, ready(), byAlias).status
    expect(isRejectedRow(altRow, statusOf)).toBe(true)
    expect(isRejectedRow(altRow, status())).toBe(false)
    expect(rejectedRowCount([row(), row({ id: 'child-2', listing: { id: 'cl-2' } }), altRow], statusOf)).toBe(2)
  })
})

describe('the column', () => {
  const def = publishColumn<ReturnType<typeof row>>({ value: () => undefined, cell: {} })
  it('is the scope’s Last publish system column, wide enough for its widest cell, never sortable or editable', () => {
    expect(def).toMatchObject({ colId: PUBLISH_COLUMN, headerName: 'Last publish', width: PUBLISH_COLUMN_WIDTH, sortable: false, editable: false })
    expect(PUBLISH_COLUMN_WIDTH).toBeGreaterThanOrEqual(160)
    expect(def.pinned).toBeUndefined()
    expect(def.lockPosition).toBeUndefined()
  })
  it('joins the column model as a sheet system column with its own Customise group', () => {
    expect(publishSheetColumn<Record<string, unknown>>()).toMatchObject({ key: PUBLISH_COLUMN, label: 'Last publish', group: 'Publish', managedBy: 'progress', writeField: '', editable: false })
  })
  it('picks the other-listing renderer only for a row of another listing', () => {
    const select = def.cellRendererSelector!
    expect((select({ value: { otherListing: true, destinationLabel: SCOPE } } as never) as { component: { name: string } }).component.name).toBe('OtherListingCell')
    expect((select({ value: undefined } as never) as { component: unknown }).component).not.toBe((select({ value: { otherListing: true } } as never) as { component: unknown }).component)
  })
  it('copies as words, and does not repaint for an unchanged reading', () => {
    const value = rowPublishValue(row(), ready(), lookup, SCOPE)
    expect(publishCellText(value, Date.parse('2026-10-02T10:00:00.000Z'))).toBe('Failed · 1 Oct')
    expect(publishCellText(undefined)).toBe('')
    expect(publishCellText({ otherListing: true, destinationLabel: SCOPE })).toBe('')
    expect(samePublishValue(value, rowPublishValue(row(), ready(), lookup, SCOPE))).toBe(true)
    expect(samePublishValue(value, rowPublishValue(row(), ready(status({ rows: [] })), lookup, SCOPE))).toBe(false)
  })
})

describe('the family main row (step 3 review, 2026-10-02)', () => {
  const parent = statusRow({ productId: 'parent', listingId: 'cl-p', sku: 'FAM', last: last({ outcome: 'ACCEPTED', issues: [] }) })
  const family = status({ rows: [parent, ...status().rows, statusRow({ productId: 'old', listingId: 'cl-o', sku: 'OLD', last: last({ publicationId: 'pub-1', outcome: 'FAILED' }) })] })
  it('counts the rows the publish carried and the ones that failed — never another publish’s rows', () => {
    expect(familyCounts(family.rows, 'pub-2')).toEqual({ total: 3, failed: 1 })
    expect(familyCounts(family.rows, 'pub-9')).toEqual({ total: 0, failed: 0 })
  })
  it('counts every row of a publication that failed whole, when no per-row result says otherwise', () => {
    expect(familyCounts([statusRow({ last: last({ status: 'FAILED', outcome: null }) }), statusRow({ last: last({ status: 'FAILED', outcome: null }) })], 'pub-2')).toEqual({ total: 2, failed: 2 })
  })
  it('the main row shows the family total over its own "Accepted"; its own result stays for the card', () => {
    const value = rowPublishValue(row({ id: 'parent', listing: { id: 'cl-p' }, isParent: true }), ready(family), lookup, SCOPE)
    expect(value && 'last' in value ? value.family : null).toEqual({ total: 3, failed: 1 })
    expect(value && 'last' in value ? value.last?.status : null).toBe('PARTIAL')
    expect(value && 'last' in value ? value.last?.outcome : null).toBe('ACCEPTED')
    expect(publishCellText(value, Date.parse('2026-10-02T10:00:00Z'))).toMatch(/^1 of 3 failed · /)
  })
  it('a variation row never carries a family total, and a family of one shows its own result', () => {
    const child = rowPublishValue(row(), ready(family), lookup, SCOPE)
    expect(child && 'last' in child ? child.family : 'x').toBeUndefined()
    const alone = rowPublishValue(row({ id: 'parent', listing: { id: 'cl-p' }, isParent: true }), ready(status({ rows: [parent] })), lookup, SCOPE)
    expect(alone && 'last' in alone ? [alone.family, alone.last?.status] : null).toEqual([undefined, 'ACCEPTED'])
  })
  it('the family total and the "N rejected" filter agree on which rows failed', () => {
    const rows = family.rows.filter(r => r.last?.publicationId === 'pub-2')
    const rejected = rows.filter(r => isRejectedRow({ id: r.productId, aliasId: null, listing: { id: r.listingId } }, family)).length
    expect(rejected).toBe(familyCounts(family.rows, 'pub-2').failed)
  })
})

/** Amazon sheet gaps (D4=B) — an offer change saved after the row's last publish waits for the next one: "Edited". */
describe('rowPublishValue — "Edited" from an offer change waiting for Publish', () => {
  const waitingSince = (savedAt: string) => ({ purchasable_offer__our_price: { value: [44.9], pendingPublish: { value: 44.9, live: 49.9, savedAt, savedBy: 'sheet@test', note: 'Saved — sent when you publish', sent: true } } })
  it('marks the row edited when the change was saved after its last publish (the DS draws "Edited" and its note)', () => {
    const value = rowPublishValue({ ...row(), values: waitingSince('2026-10-02T09:00:00.000Z') }, ready(), lookup, SCOPE)
    expect(value).toMatchObject({ editedSince: true, last: { publicationId: 'pub-2' } })
    expect(publishCellModel(value as never).ariaLabel).toContain('Edited since.')
  })
  it('does not, for a change saved before that publish or a row with nothing waiting', () => {
    expect(rowPublishValue({ ...row(), values: waitingSince('2026-10-01T19:00:00.000Z') }, ready(), lookup, SCOPE)).not.toHaveProperty('editedSince')
    expect(rowPublishValue({ ...row(), values: {} }, ready(), lookup, SCOPE)).not.toHaveProperty('editedSince')
  })
})

describe('build shape v2 (P12) — the kind of the last send, and re-reading while a selling change is in flight', () => {
  it('names a selling change or a Full update on the card; a plain publish says nothing extra', () => {
    expect(lastPublishKindLabel('pause')).toBe('Pause offer')
    expect(lastPublishKindLabel('full_update')).toBe('Full update')
    expect(lastPublishKindLabel('publish')).toBeNull()
    expect(lastPublishKindLabel(undefined)).toBeNull()
    const paused = status({ rows: [statusRow({ last: last({ kind: 'pause', status: 'ACCEPTED', outcome: 'ACCEPTED', sentFields: [], issues: [] }) })] })
    const value = rowPublishValue(row(), ready(paused), lookup, SCOPE) as unknown as { last: Record<string, unknown> }
    expect(value.last.kindLabel).toBe('Pause offer')
    const plain = rowPublishValue(row(), ready(), lookup, SCOPE) as unknown as { last: Record<string, unknown> }
    expect(plain.last).not.toHaveProperty('kindLabel')
  })
  it('is in flight only while a selling change is still sending, and only for 30 minutes', () => {
    const now = Date.parse('2026-10-01T20:10:00.000Z')
    const sending = (kind: StudioRowLastPublish['kind'], s: string, at = '2026-10-01T20:07:00.000Z') =>
      status({ rows: [statusRow({ last: last({ kind, status: s, at, issues: [] }) }), statusRow({ productId: 'child-2', listingId: 'cl-2', last: null })] })
    expect(sellingChangeInFlight(sending('pause', 'PUBLISHING'), now)).toBe(true)
    expect(sellingChangeInFlight(sending('end', 'QUEUED'), now)).toBe(true)
    expect(sellingChangeInFlight(sending('relist', 'SUBMITTED'), now)).toBe(true)
    // Settled, a content publish (it announces itself), no read, or stopped without a word long ago: no re-read.
    expect(sellingChangeInFlight(sending('pause', 'ACCEPTED'), now)).toBe(false)
    expect(sellingChangeInFlight(sending('pause', 'UNVERIFIED'), now)).toBe(false)
    expect(sellingChangeInFlight(sending('publish', 'PUBLISHING'), now)).toBe(false)
    expect(sellingChangeInFlight(sending(undefined, 'PUBLISHING'), now)).toBe(false)
    expect(sellingChangeInFlight(null, now)).toBe(false)
    const old = new Date(now - SELLING_REREAD_WINDOW_MS - 1000).toISOString()
    expect(sellingChangeInFlight(sending('pause', 'PUBLISHING', old), now)).toBe(false)
  })
})
