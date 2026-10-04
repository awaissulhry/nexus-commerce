import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { StudioPublishChange } from '@nexus/shared/studio-publication'
import { PublicationChanges, REPLACES_INTRO, publicationValueText, replacesWords } from './PublicationChanges'

const change: StudioPublishChange = { id: 'title', productId: 'child', sku: 'CHILD', field: 'title', label: 'Title',
  current: { state: 'value', value: '<script>text only</script>' }, lastAccepted: { state: 'unknown', reason: 'No accepted publish record' },
  channel: { state: 'value', value: 'Channel title' }, status: 'DIFFERS', localChanged: null, channelChanged: null,
  selectable: true, selectedByDefault: false, reason: 'Choose explicitly.', operation: 'replace' }
it('keeps missing evidence, a deletion, null and empty text distinct', () => {
  expect(publicationValueText({ state: 'unknown', reason: 'Read failed' })).toBe('Unknown — Read failed')
  expect(publicationValueText({ state: 'absent' })).toBe('Cleared / absent')
  expect(publicationValueText({ state: 'value', value: null })).toBe('Empty value (null)')
  expect(publicationValueText({ state: 'value', value: '' })).toBe('(empty text)')
  expect(publicationValueText({ state: 'value', value: ['One', 'Two'] })).toContain('"Two"')
})
it('shows first publication differences unchecked with escaped values and exact selected counts', () => {
  const render = (selectedIds: string[]) => renderToStaticMarkup(createElement(PublicationChanges, { changes: [change], selectedIds, disabled: false, onSelectionChange: () => {} }))
  expect(render([])).toContain('0 changes'); expect(render([])).not.toContain('checked=""')
  const selected = render(['title'])
  expect(selected).toContain('1 change'); expect(selected).toContain('checked=""')
  expect(selected).toContain('Unknown — No accepted publish record')
  expect(selected).toContain('&lt;script&gt;text only&lt;/script&gt;'); expect(selected).not.toContain('<script>')
})
it('keeps unchanged evidence available and never counts unknown or refused rows as selected', () => {
  const rows = [change, { ...change, id: 'same', status: 'SAME' as const, selectable: false },
    { ...change, id: 'unread', status: 'CANNOT_COMPARE' as const, selectable: false, reason: 'Permission denied', channel: { state: 'unknown' as const, reason: 'Read failed' } }]
  const html = renderToStaticMarkup(createElement(PublicationChanges, { changes: rows, selectedIds: ['same', 'unread'], disabled: false, onSelectionChange: () => {} }))
  expect(html).toContain('0 changes'); expect(html).toContain('1 field needs no send')
  expect(html).toContain('Cannot compare'); expect(html).toContain('Permission denied'); expect(html).not.toContain('checked=""')
})

// One-click "Nexus wins" (O2) — the words of each line.
const price: StudioPublishChange = { ...change, id: 'price', field: 'price', label: 'Price', status: 'DIFFERS', selectedByDefault: true,
  current: { state: 'value', value: 149 }, lastAccepted: { state: 'value', value: 139 }, channel: { state: 'value', value: 129 }, localChanged: true, channelChanged: true,
  reason: 'The channel differs from the last accepted publish. Publish replaces its value with Nexus\'s; untick it to keep the channel\'s.',
  replaces: { kind: 'both_changed', channel: '129.00', nexus: '149.00', sentence: 'Changed in Nexus and on Amazon. Amazon has 129.00 — Publish sets 149.00.',
    note: 'Amazon\'s Automate Pricing can change it again.' } }
const renderLines = (changes: StudioPublishChange[], selectedIds: string[], extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(PublicationChanges, { changes, selectedIds, disabled: false, onSelectionChange: () => {}, channel: 'AMAZON', ...extra }))
it('a ticked line that replaces a channel value shows its warning and note under the line', () => {
  const html = renderLines([price], ['price'])
  expect(html).toContain('<strong>Warning: </strong>Changed in Nexus and on Amazon. Amazon has 129.00 — Publish sets 149.00. Amazon&#x27;s Automate Pricing can change it again.')
  // Under the line's reason, inside the note the tick is described by.
  expect(html).toMatch(/<p id="[^"]+" class="nds-change-review-note">The channel differs[^<]*<span class="[^"]*">/)
  expect(replacesWords(price, true)).toEqual({ warning: true, text: 'Changed in Nexus and on Amazon. Amazon has 129.00 — Publish sets 149.00. Amazon\'s Automate Pricing can change it again.' })
})
it('unticked ("Keep Amazon\'s values"), the line says what the channel keeps — never "Publish sets"', () => {
  const html = renderLines([price], [])
  expect(html).toContain('Unticked: Amazon keeps 129.00.'); expect(html).not.toContain('Warning:'); expect(html).not.toContain('Publish sets 149.00')
  expect(replacesWords({ replaces: { ...price.replaces!, channel: null } }, false, 'EBAY')!.text).toBe('Unticked: nothing is set on eBay.')
  expect(replacesWords(price, false)!.text).toBe('Unticked: the channel keeps 129.00.')
})
it('a line without replaces, and a line a photos-only review cannot send, get no replaces words', () => {
  expect(replacesWords(change, true)).toBeNull()
  const html = renderLines([price], ['price'], { photosOnly: true })
  expect(html).toContain('Fix the problems listed above'); expect(html).not.toContain('Warning:')
})
it('a photo line judged on Nexus\'s side (the channel re-hosts its photos) shows its reason, unticked', () => {
  const COPY = 'Amazon shows its own copy of the photos, so Nexus cannot compare them. Tick it to send Nexus\'s photos.'
  const photos: StudioPublishChange = { ...change, id: JSON.stringify(['child', 'pictures']), field: 'pictures', label: 'Photos', status: 'CANNOT_COMPARE',
    selectable: true, selectedByDefault: false, reason: COPY, channel: { state: 'value', value: ['https://m.media-amazon.com/images/I/1.jpg'] } }
  const html = renderLines([photos], [])
  expect(html).toContain('Cannot compare'); expect(html).toContain('Amazon shows its own copy of the photos, so Nexus cannot compare them. Tick it to send Nexus&#x27;s photos.')
  expect(html).not.toContain('checked=""'); expect(html).not.toContain('Warning:')
})
it('the line above the list says how a line that replaces a channel value is told apart (whatever the ticks)', () => {
  expect(renderLines([price], [])).toContain(REPLACES_INTRO)
  expect(renderLines([price], [], { compact: true })).not.toContain(REPLACES_INTRO)
})
