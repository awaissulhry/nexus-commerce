import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { StudioPublishChange, StudioPublishReview } from '@nexus/shared/studio-publication'
import { DiffersSummary, keepChannelIds, keepChannelWords, keepingChannelValues, withChannelValuesKept } from './DiffersSummary'
import { ReviewBody, exactRequestSummary } from './ReviewBody'

/** One-click "Nexus wins" (SIMPLIFY item 3): the one line per market and its "Keep Amazon's values" switch. */
const replaces = { kind: 'channel_changed' as const, channel: '129.00', nexus: '149.00', sentence: 'Changed on Amazon since the last publish. Amazon has 129.00 — Publish sets 149.00.', note: null }
const change = (id: string, over: Partial<StudioPublishChange> = {}): StudioPublishChange => ({
  id, productId: 'p', sku: 'SKU', field: id, label: id, status: 'SEND', selectable: true, selectedByDefault: true, reason: '', localChanged: true, channelChanged: false,
  current: { state: 'value', value: 1 }, lastAccepted: { state: 'value', value: 0 }, channel: { state: 'value', value: 0 }, operation: 'replace', ...over,
})
const changes = [
  change('title'),
  change('price', { status: 'DIFFERS', replaces }),
  change('brand', { status: 'DIFFERS', replaces: { ...replaces, kind: 'never_published' } }),
  change('size', { status: 'DIFFERS', replaces, locked: true }),
  change('colour', { status: 'SAME', selectable: false, selectedByDefault: false }),
]
const review = (over: Partial<StudioPublishReview> = {}): StudioPublishReview => ({
  id: 'r-IT', productId: 'p', scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'acc' }, accountLabel: 'Xavia', aliasLabel: 'Primary listing', mode: 'live',
  action: 'update', rows: [{ productId: 'p', sku: 'SKU', title: 'Jacket', existing: true }], excluded: 0, issues: [], expiresAt: '2026-10-04T12:15:00Z', changes, ...over,
})

describe('the "Keep Amazon’s values" switch', () => {
  it('governs the lines that replace a channel value, never a Full update row’s field or a line that cannot be ticked', () => {
    expect(keepChannelIds(changes)).toEqual(['price', 'brand'])
    expect(keepChannelIds(changes, true)).toEqual([])
    expect(keepChannelWords('AMAZON')).toBe('Keep Amazon’s values')
  })
  it('on unticks every ticked line that replaces a channel value; off ticks them back; other ticks stay', () => {
    const all = ['title', 'price', 'brand', 'size']
    const kept = withChannelValuesKept(changes, all, true)
    expect(kept).toEqual(['title', 'size'])
    expect(keepingChannelValues(changes, kept)).toBe(true)
    expect(keepingChannelValues(changes, all)).toBe(false)
    expect(withChannelValuesKept(changes, kept, false).sort()).toEqual(all.sort())
    // One line ticked back by hand: the switch reads off, and switching it on unticks it again.
    expect(keepingChannelValues(changes, [...kept, 'brand'])).toBe(false)
  })
  it('shows the one line from differsSummary with the switch, as a warning while Publish replaces values', () => {
    const html = (selectedIds: string[], locked = false) => renderToStaticMarkup(createElement(DiffersSummary, { review: review(), selectedIds, locked, onSelectionChange: () => {} }))
    const on = html(['title', 'price', 'brand', 'size'])
    expect(on).toContain('3 values on Amazon · IT differ from Nexus. Publish replaces them.')
    expect(on).toContain('nds-banner warning')
    expect(on).toContain('role="switch"'); expect(on).toContain('aria-checked="false"')
    expect(on).toContain('Keep Amazon’s values')
    const kept = html(['title', 'size'])
    expect(kept).toContain('aria-checked="true"')
    expect(kept).toContain('Publish replaces 1 of them.')
    expect(html(['title'], true)).toContain('disabled=""')
  })
  it('says nothing when no value differs', () => {
    const html = renderToStaticMarkup(createElement(DiffersSummary, { review: review({ changes: [change('title')] }), selectedIds: ['title'], locked: false, onSelectionChange: () => {} }))
    expect(html).toBe('')
  })
})

describe('the review body of a market tab', () => {
  const props = { selectedIds: ['title', 'price', 'brand', 'size'], locationId: '', confirmed: false, locked: false,
    onSelectionChange: () => {}, onLocationChange: () => {}, onConfirmChange: () => {} }
  const selection = { reviewId: 'r-IT', token: 't', selectedIds: ['title'], fieldCount: 4, products: [{ productId: 'p', sku: 'SKU' }],
    payload: { format: 'json' as const, content: '{"patches":[{"op":"replace"}]}' } }
  it('opens with the Nexus-wins line where the window asks for it', () => {
    expect(renderToStaticMarkup(createElement(ReviewBody, { ...props, review: review(), selection: null, nexusWins: true }))).toContain('differ from Nexus')
    expect(renderToStaticMarkup(createElement(ReviewBody, { ...props, review: review(), selection: null }))).not.toContain('differ from Nexus')
  })
  it('keeps the exact request in a closed fold, and says when it is still being prepared', () => {
    const built = renderToStaticMarkup(createElement(ReviewBody, { ...props, review: review(), selection }))
    expect(built).toContain('<details'); expect(built).not.toContain('<details open')
    expect(built).toContain('Exact request to the channel · 4 changes affecting 1 product')
    expect(built).toContain('{&quot;patches&quot;')
    expect(built).not.toContain('Selected request ready')
    const building = renderToStaticMarkup(createElement(ReviewBody, { ...props, review: review(), selection: null, selecting: true }))
    expect(building).toContain('Exact request to the channel · preparing…')
    expect(exactRequestSummary(null)).toBe('Exact request to the channel')
  })
})
