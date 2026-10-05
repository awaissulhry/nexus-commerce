/**
 * Item ID control (step I1) — the eBay Item ID cell's control: which row it acts on and the fence it sends, what the
 * dialog offers (Check → Link / Keep, Clear), how a write's answer reads, the event that makes the sheet re-read, and
 * that its words are the API's. The dialog itself is DS parts (Modal, Field, Input, Banner, Button); Node has no DOM, so
 * the rules are tested here, not the rendering.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { liveRefreshNeeded } from '../../listingValuesLive'
import {
  CHANNEL_ID_COPY, CHANNEL_ID_PERMISSION, ChannelIdControlProvider, ChannelIdFindings, channelIdActions, channelIdChangedEvent, channelIdTarget, looksLikeItemId,
  readWriteAnswer, typedItemId, useChannelIdControl, type ChannelIdCheckAnswer, type ChannelIdTarget,
} from './channelIdControl'
import type { ChannelSheetRow } from './types'

const row = (over: Partial<ChannelSheetRow> & { listing?: Record<string, unknown> | null } = {}) => ({
  id: 'root-1', sku: 'JKT', parentId: null,
  listing: { id: 'L-1', version: 4, externalListingId: '520000000001', listingStatus: 'ACTIVE', isPublished: true },
  ...over,
}) as unknown as ChannelSheetRow

const TARGET: ChannelIdTarget = { listingId: 'L-1', productId: 'root-1', sku: 'JKT', currentId: '520000000001', version: 4 }
const answer = (over: Partial<ChannelIdCheckAnswer> = {}): ChannelIdCheckAnswer => ({
  listingId: 'L-1', currentId: '520000000001', version: 4, itemId: '520000000002', ok: true, unchanged: false, refusal: null, status: 'ACTIVE',
  found: [], rows: [], moved: [], kept: [], pushes: 'Pushes stay paused: Nexus sends nothing to this item until you resume them (Sync).', ...over,
})

describe('the row it acts on, and the fence it sends', () => {
  it('eBay, the main row, with a listing: the listing, the family root, the Item ID and the version this sheet read', () => {
    expect(channelIdTarget(row(), 'EBAY')).toEqual(TARGET)
    expect(channelIdTarget(row({ listing: { id: 'L-1', version: 2, externalListingId: '  ', listingStatus: 'DRAFT', isPublished: false } as never }), 'EBAY')).toMatchObject({ currentId: null, version: 2 })
  })
  it('never a variation row (one item per family), a row with no listing, or another channel', () => {
    expect(channelIdTarget(row({ parentId: 'root-1' }), 'EBAY')).toBeNull()
    expect(channelIdTarget(row({ listing: null }), 'EBAY')).toBeNull()
    expect(channelIdTarget(row(), 'AMAZON')).toBeNull()
  })
})

describe('what the dialog offers', () => {
  it('typed ids drop spaces; a first hint before eBay is asked (the API proves it)', () => {
    expect(typedItemId(' 5200 0000 0002 ')).toBe('520000000002')
    expect(looksLikeItemId('520000000002')).toBe(true)
    for (const bad of ['', '12345678', '1234567890123456', 'B0ABC']) expect(looksLikeItemId(bad)).toBe(false)
  })

  it('Check first; Link once a check of THIS id allows it; Keep when it is the id Nexus holds; Clear while an id is held', () => {
    const base = { target: TARGET, busy: null, canEdit: true } as const
    expect(channelIdActions({ ...base, typed: '520000000002', check: null })).toEqual({ check: true, link: null, clear: true, hint: null })
    expect(channelIdActions({ ...base, typed: '520000000002', check: answer() }).link).toEqual({ label: 'Link', enabled: true })
    expect(channelIdActions({ ...base, typed: '520000000001', check: answer({ itemId: '520000000001' }) }).link).toEqual({ label: 'Keep', enabled: true })
    // A changed id after the check: check again; a refused or unchanged check offers no Link.
    expect(channelIdActions({ ...base, typed: '520000000003', check: answer() })).toMatchObject({ link: null, hint: CHANNEL_ID_COPY.checkAgain })
    expect(channelIdActions({ ...base, typed: '520000000002', check: answer({ ok: false, refusal: 'Another seller.' }) }).link).toBeNull()
    expect(channelIdActions({ ...base, typed: '520000000001', check: answer({ itemId: '520000000001', unchanged: true }) }).link).toBeNull()
    expect(channelIdActions({ ...base, target: { ...TARGET, currentId: null }, typed: '520000000002', check: null }).clear).toBe(false)
  })

  it('busy or without the permission: nothing can be pressed, and the dialog says why', () => {
    expect(channelIdActions({ target: TARGET, typed: '520000000002', check: answer(), busy: 'link', canEdit: true })).toMatchObject({ check: false, link: { enabled: false }, clear: false })
    expect(channelIdActions({ target: TARGET, typed: '520000000002', check: null, busy: null, canEdit: false })).toMatchObject({ check: false, clear: false, hint: CHANNEL_ID_COPY.noPermission })
    expect(channelIdActions({ target: TARGET, typed: '', check: null, busy: null, canEdit: true }).hint).toBe(CHANNEL_ID_COPY.typeFirst)
    expect(channelIdActions({ target: TARGET, typed: '12ab', check: null, busy: null, canEdit: true })).toMatchObject({ check: false, hint: CHANNEL_ID_COPY.notANumber })
    expect(CHANNEL_ID_PERMISSION).toBe('listings.recover')
  })
})

describe('before Link: the rows it moves from another item, and the rows it leaves alone (Owner, option A)', () => {
  const MOVE = 'M holds item 520000000030; eBay shows its SKU JKT-M on item 520000000002; Link moves it to 520000000002.'
  const KEEP = 'L holds item 520000000040; eBay does not show its SKU on item 520000000002, so Link leaves it as it is.'
  const render = (check: ChannelIdCheckAnswer) => renderToStaticMarkup(createElement(ChannelIdFindings, { check }))
  it('every moved row, in the API\'s words, under a warning that counts them; the kept rows among the findings', () => {
    const html = render(answer({
      moved: [{ listingId: 'L-M', sku: 'JKT-M', channelSku: 'JKT-M', from: '520000000030', sentence: MOVE }],
      kept: [{ id: 'L-L', sku: 'JKT-L', externalListingId: '520000000040', sentence: KEEP }], found: [KEEP],
    }))
    expect(html).toContain(CHANNEL_ID_COPY.moves(1))
    expect(html).toContain(MOVE)
    expect(html).toContain(KEEP)
    expect(html.indexOf(MOVE)).toBeLessThan(html.indexOf(KEEP))
    expect(CHANNEL_ID_COPY.moves(2)).toBe('Link moves 2 rows from another item')
  })
  it('a refused check moves nothing and says so only through its refusal', () => {
    const html = render(answer({ ok: false, refusal: 'Another seller.', moved: [{ listingId: 'L-M', sku: 'JKT-M', channelSku: 'JKT-M', from: '1', sentence: MOVE }] }))
    expect(html).toContain('Another seller.')
    expect(html).not.toContain(MOVE)
  })
})

describe('a write\'s answer', () => {
  it('the API\'s answer, or its refusal sentence, or the idempotency layer\'s words; never a guess', () => {
    const done = { ok: true, externalId: '520000000002', rows: [{ listingId: 'L-1', version: 5 }], sentence: 'Linked item 520000000002 on 1 row.' }
    expect(readWriteAnswer({ ok: true }, done, null)).toEqual(done)
    expect(readWriteAnswer({ ok: false }, { error: 'conflict', message: 'This listing changed after it was read.' }, null)).toEqual({ error: 'This listing changed after it was read.' })
    expect(readWriteAnswer({ ok: false }, null, null)).toEqual({ error: CHANNEL_ID_COPY.failed })
    expect(readWriteAnswer({ ok: false }, null, 'Your earlier Item ID change is still running.')).toEqual({ error: 'Your earlier Item ID change is still running.' })
  })

  it('after a write the sheet re-reads the family in full (the event the API sends to the other tabs)', () => {
    const event = channelIdChangedEvent(TARGET, [{ listingId: 'L-1', version: 5 }, { listingId: 'L-2', version: 9 }])
    const scope = { familyId: 'root-1', memberIds: ['root-1', 'child-1'], knownVersions: new Map([['L-1', 4], ['L-2', 8]]) }
    expect(liveRefreshNeeded(event, scope)).toBe('full')
    // Its own echo once the sheet holds those versions; another family's sheet ignores it.
    expect(liveRefreshNeeded(event, { ...scope, knownVersions: new Map([['L-1', 5], ['L-2', 9]]) })).toBe('none')
    expect(liveRefreshNeeded(event, { ...scope, familyId: 'other', memberIds: ['other'] })).toBe('none')
  })
})

describe('the provider', () => {
  it('renders the sheet inside it; outside it the cell has no control (read-only)', () => {
    let seen: ReturnType<typeof useChannelIdControl> | undefined
    const Probe = () => { seen = useChannelIdControl(); return createElement('span', null, 'sheet') }
    expect(renderToStaticMarkup(createElement(ChannelIdControlProvider, { channel: 'EBAY', marketplace: 'IT', children: createElement(Probe) }))).toBe('<span>sheet</span>')
    expect(seen).toMatchObject({ channel: 'EBAY', marketplace: 'IT', canEdit: false })
    renderToStaticMarkup(createElement(Probe))
    expect(seen).toBeNull()
  })
})

describe('the words are the API\'s', () => {
  const root = fileURLToPath(new URL('../../../../../../../../../../', import.meta.url))
  const api = readFileSync(path.join(root, 'apps/api/src/services/identity/channel-id.service.ts'), 'utf8')
  it('the Clear confirm says what the API answers', () => {
    expect(CHANNEL_ID_COPY.clearSentence('X')).toBe('Nexus forgets item X. Nothing changes on eBay; it stays live and Nexus stops updating it.')
    expect(api).toContain('`Nexus forgets item ${itemId}. Nothing changes on eBay; it stays live and Nexus stops updating it.`')
  })
})
