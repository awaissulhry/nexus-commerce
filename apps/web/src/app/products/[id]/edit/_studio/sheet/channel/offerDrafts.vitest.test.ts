/**
 * Amazon sheet gaps (D4=B, D7=A) — the channel sheet's offer changes waiting for Publish: every word, the count, the
 * mark and its filter, the ⋯ items, the discard plan and the Last publish column's "Edited". All from `pendingPublish`.
 */
import { describe, expect, it, vi } from 'vitest'
import { publishFullTime } from '@/design-system/grid/renderers/publishStatus'
import { SHOW_ALL_ACTION, SHOW_REJECTED_ACTION } from '@/app/products/_publication/dialog/outcome'
import {
  OFFER_DRAFT_COPY, discardOfferDrafts, liveChangedLine, offerDraftControls, offerDraftCellWords, offerDraftCounts, offerDraftDiscard,
  offerDraftEditedSince, offerDraftResetLabel, offerValueText, pendingPublishOf, rowHasOfferDraft, type OfferDraftRow, type OfferPendingPublish,
} from './offerDrafts'

const SAVED_AT = '2026-10-02T12:03:00.000Z'
const pending = (over: Partial<OfferPendingPublish> = {}): OfferPendingPublish => ({
  value: 44.9, live: 49.9, savedAt: SAVED_AT, savedBy: 'sheet@test', note: 'Saved — pins at 44.90 when you publish', sent: true, ...over,
})
const cell = (over: Record<string, unknown> = {}) => ({ value: 44.9, editable: true, writable: true, writeBlockedReason: null, ...over })
const row = (rowId: string, values: Record<string, unknown>, sku = rowId.toUpperCase()): OfferDraftRow => ({ rowId, sku, values })
const PRICE = 'purchasable_offer__our_price'
const MIN = 'purchasable_offer__minimum_seller_allowed_price'
const LEAD = 'fulfillment_availability__lead_time_to_ship_max_days'
const labelOf = (colId: string) => ({ [PRICE]: 'Price', [MIN]: 'Minimum price', [LEAD]: 'Handling time' } as Record<string, string>)[colId] ?? colId

describe('the cell words — the server’s sentence first, then what waits and what is live', () => {
  it('reads only a real waiting change', () => {
    expect(pendingPublishOf(cell({ pendingPublish: pending() }))).toMatchObject({ value: 44.9 })
    expect(pendingPublishOf(cell())).toBeNull()
    expect(pendingPublishOf(cell({ pendingPublish: null }))).toBeNull()
    expect(pendingPublishOf(undefined)).toBeNull()
  })
  it('says the saved value, the live value, when and by whom, under the server’s note', () => {
    expect(offerDraftCellWords(pending())).toEqual({
      label: 'Waits for Publish', notSent: false,
      description: `Saved — pins at 44.90 when you publish. Saved value: 44.90. Live until you publish: 49.90. Saved ${publishFullTime(SAVED_AT)} by sheet@test`,
    })
  })
  it('keeps every server sentence as it is: sent on Publish, follows a rule', () => {
    expect(offerDraftCellWords(pending({ note: 'Saved — sent when you publish' })).description).toMatch(/^Saved — sent when you publish\. /)
    expect(offerDraftCellWords(pending({ note: 'Saved — follows Base price + 10% when you publish' })).description).toMatch(/^Saved — follows Base price \+ 10% when you publish\. /)
    expect(offerDraftCellWords(pending({ note: undefined })).description).toMatch(/^Saved — sent when you publish\. /)
  })
  it('names a saved value that is not sent (a restock date that has passed)', () => {
    const words = offerDraftCellWords(pending({ value: '2026-09-01', live: null, sent: false, note: 'Restock date has passed — not sent. Change it or discard it.' }))
    expect(words.label).toBe('Saved, not sent')
    expect(words.notSent).toBe(true)
    expect(words.description).toMatch(/^Restock date has passed — not sent\. Change it or discard it\. Saved value: 2026-09-01\. Live until you publish: none\./)
  })
  it('D7 — a live change since the save: the server’s line, right after its note; built from the values when it has none', () => {
    const moved = pending({ liveChangedSince: { from: 49.9, to: 52, note: 'Live changed since you saved: 49.90 → 52.00. Publish sends your saved value.' } })
    expect(offerDraftCellWords(moved).description).toMatch(/^Saved — pins at 44\.90 when you publish\. Live changed since you saved: 49\.90 → 52\.00\. Publish sends your saved value\. Saved value/)
    expect(liveChangedLine(pending({ liveChangedSince: { from: 49.9, to: 52, note: '' } }))).toBe('Live changed since you saved: 49.90 → 52. Publish sends your saved value.')
    expect(liveChangedLine(pending())).toBeNull()
  })
  it('writes values as a person reads them', () => {
    expect([offerValueText(null), offerValueText(''), offerValueText(true), offerValueText(false), offerValueText(3), offerValueText(49.9), offerValueText([28]), offerValueText('R-123')])
      .toEqual(['none', 'none', 'On', 'Off', '3', '49.90', '28', 'R-123'])
  })
  it('the discard offer names the live value it goes back to', () => {
    expect(offerDraftResetLabel(pending())).toBe('Discard saved change (live: 49.90)')
    expect(offerDraftResetLabel(pending({ live: null }))).toBe('Discard saved change (live: none)')
    expect(OFFER_DRAFT_COPY.resetDetail('Amazon · IT')).toBe('The saved change goes and the cell shows the live value again. Nothing is sent to Amazon · IT.')
  })
})

describe('the count and the toolbar mark', () => {
  const rows = [
    row('a', { [PRICE]: cell({ pendingPublish: pending() }), [MIN]: cell({ pendingPublish: pending({ value: 30, live: 28 }) }), title: cell() }),
    row('b', { [PRICE]: cell(), [LEAD]: cell({ editable: false, writable: false, writeBlockedReason: 'Amazon stores and ships this listing (FBA).', pendingPublish: pending({ value: 3, live: 2 }) }) }),
    row('c', { [PRICE]: cell() }),
  ]
  it('counts the rows and the waiting cells, and which of them this sheet can discard', () => {
    expect(offerDraftCounts(rows)).toEqual({ rows: 2, changes: 3, discardable: 2, held: 1, heldReason: 'Amazon stores and ships this listing (FBA).' })
    expect(offerDraftCounts([row('c', { [PRICE]: cell() })])).toEqual({ rows: 0, changes: 0, discardable: 0, held: 0, heldReason: null })
  })
  it('says one change in the singular and many in the plural, with where they go', () => {
    expect(OFFER_DRAFT_COPY.mark(1)).toBe('1 change waits for Publish')
    expect(OFFER_DRAFT_COPY.mark(3)).toBe('3 changes wait for Publish')
    expect(OFFER_DRAFT_COPY.markDetail(1, 'Amazon · IT')).toBe('Saved in Nexus. It goes to Amazon · IT when you publish; live prices and stock keep syncing until then.')
    expect(OFFER_DRAFT_COPY.markDetail(3, 'Amazon · IT')).toBe('Saved in Nexus. They go to Amazon · IT when you publish; live prices and stock keep syncing until then.')
  })
  it('the mark is an info mark that filters to those rows, and back', () => {
    const toggle = vi.fn()
    const off = offerDraftControls(rows, { filterOn: false, toggle, destination: 'Amazon · IT', labelOf, discard: vi.fn() })
    expect(off.mark).toEqual({ tone: 'info', label: '3 changes wait for Publish', detail: OFFER_DRAFT_COPY.markDetail(3, 'Amazon · IT'), onSelect: toggle, actionLabel: SHOW_REJECTED_ACTION, selected: false })
    expect(SHOW_REJECTED_ACTION).toBe('Show these rows')
    const on = offerDraftControls(rows, { filterOn: true, toggle, destination: 'Amazon · IT', labelOf, discard: vi.fn() })
    expect(on.mark).toMatchObject({ actionLabel: SHOW_ALL_ACTION, selected: true })
    expect(on.filterOn).toBe(true)
    expect(rows.filter(on.keep).map(r => r.rowId)).toEqual(['a', 'b'])
    expect(rowHasOfferDraft(rows[2])).toBe(false)
  })
  it('nothing waits: no mark, no ⋯ items, and the filter is off whatever it was', () => {
    const none = offerDraftControls([rows[2]], { filterOn: true, toggle: vi.fn(), destination: 'Amazon · IT', labelOf, discard: vi.fn() })
    expect(none).toMatchObject({ mark: null, menu: [], filterOn: false })
  })
})

describe('the ⋯ items — the same filter, and "Discard saved changes…" with its question', () => {
  const rows = [
    row('a', { [PRICE]: cell({ pendingPublish: pending() }), [MIN]: cell({ pendingPublish: pending({ value: 30, live: 28 }) }) }, 'JACKET-M'),
    row('b', { [LEAD]: cell({ editable: false, writable: false, writeBlockedReason: 'Amazon stores and ships this listing (FBA).', pendingPublish: pending({ value: 3, live: 2 }) }) }, 'JACKET-L'),
  ]
  it('offers the filter in the menu too (a mark folded into "+N" cannot be pressed)', () => {
    const toggle = vi.fn()
    const [show] = offerDraftControls(rows, { filterOn: false, toggle, destination: 'Amazon · IT', labelOf, discard: vi.fn() }).menu
    expect(show).toMatchObject({ id: 'show-offer-drafts', label: 'Show the 2 rows with changes waiting for Publish' })
    show.onSelect?.()
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(OFFER_DRAFT_COPY.showRows(1)).toBe('Show the row with changes waiting for Publish')
    expect(offerDraftControls(rows, { filterOn: true, toggle, destination: 'Amazon · IT', labelOf, discard: vi.fn() }).menu[0].label).toBe('Show all rows')
  })
  it('asks first: what goes, what stays held, and every cell saved → live in one table', () => {
    const discard = vi.fn()
    const [, item] = offerDraftControls(rows, { filterOn: false, toggle: vi.fn(), destination: 'Amazon · IT', labelOf, discard }).menu
    expect(item).toMatchObject({ id: 'discard-offer-drafts', label: 'Discard saved changes…', disabled: false,
      description: 'The cells show the live values again. Nothing is sent to Amazon · IT.' })
    item.onSelect?.()
    const [impact, targets] = discard.mock.calls[0]
    expect(targets.map((t: { rowId: string; colId: string }) => `${t.rowId}:${t.colId}`)).toEqual([`a:${PRICE}`, `a:${MIN}`])
    expect(impact).toEqual({
      level: 'confirm', title: 'Discard 2 saved changes?',
      consequences: [
        'The saved values go and the row shows the live values again. Nothing is sent to Amazon · IT. One save.',
        '1 held change stays: Amazon stores and ships this listing (FBA).',
      ],
      review: { title: OFFER_DRAFT_COPY.reviewTitle, rows: [
        { label: 'JACKET-M · Price', before: '44.90', after: '49.90' },
        { label: 'JACKET-M · Minimum price', before: '30', after: '28' },
      ] },
    })
    expect(OFFER_DRAFT_COPY.confirmTitle(1)).toBe('Discard 1 saved change?')
  })
  it('is unavailable, with the reason, when every waiting change is held', () => {
    const [, item] = offerDraftControls([rows[1]], { filterOn: false, toggle: vi.fn(), destination: 'Amazon · IT', labelOf, discard: vi.fn() }).menu
    expect(item).toMatchObject({ disabled: true, description: 'No waiting change can be discarded here. Amazon stores and ships this listing (FBA).' })
    expect(offerDraftDiscard([rows[1]], { destination: 'Amazon · IT', labelOf })).toEqual({ targets: [], impact: null })
  })
  it('discards as resets in ONE operation, and leaves alone a change that no longer waits', () => {
    const calls: string[] = []
    const writer = {
      beginOperation: () => calls.push('begin'),
      endOperation: () => calls.push('end'),
      set: (rowId: string, colId: string, value: unknown, opts?: { intent?: string }) => calls.push(`${rowId}:${colId}:${String(value)}:${opts?.intent}`),
    }
    const { targets } = offerDraftDiscard(rows, { destination: 'Amazon · IT', labelOf })
    // Between the question and the answer the price was published: only the minimum price still waits.
    const now = row('a', { [PRICE]: cell(), [MIN]: cell({ pendingPublish: pending({ value: 30, live: 28 }) }) }, 'JACKET-M')
    expect(discardOfferDrafts(writer as never, targets, rowId => (rowId === 'a' ? now : undefined))).toBe(1)
    expect(calls).toEqual(['begin', `a:${MIN}:null:reset`, 'end'])
    expect(discardOfferDrafts(writer as never, targets, () => row('a', {}))).toBe(0)
    expect(calls).toHaveLength(3)
  })
})

describe('the Last publish column’s "Edited"', () => {
  const waiting = row('a', { [PRICE]: cell({ pendingPublish: pending() }) })
  it('a waiting change saved after the last publish', () => {
    expect(offerDraftEditedSince(waiting, '2026-10-01T20:07:00.000Z')).toBe(true)
  })
  it('not one saved before it (that publish did not carry it), not without a publish, not without a waiting change', () => {
    expect(offerDraftEditedSince(waiting, '2026-10-02T12:30:00.000Z')).toBe(false)
    expect(offerDraftEditedSince(waiting, null)).toBe(false)
    expect(offerDraftEditedSince(row('a', { [PRICE]: cell() }), '2026-10-01T20:07:00.000Z')).toBe(false)
  })
})
