import { describe, expect, it } from 'vitest'

import { blockingIssues, differsSentence, differsSummary, fullUpdateChange, isPhotoChangeId, type StudioPublishChange, type StudioPublishIssue } from './studio-publication.js'

const id = (field: string) => JSON.stringify(['parent', field])
const season: StudioPublishIssue = { productId: 'parent', field: 'season', severity: 'error', message: 'Season: Season contains an unaccepted value.' }
const account: StudioPublishIssue = { severity: 'error', message: 'Reconnect this account before publishing.' }

describe('photos-only publishing (Images rebuild P4c)', () => {
  it('knows the photo fields of the change review', () => {
    expect([id('pictures'), id('Pictures'), id('variationPictures')].every(isPhotoChangeId)).toBe(true)
    expect(isPhotoChangeId(id('title'))).toBe(false)
    expect(isPhotoChangeId('not json')).toBe(false)
  })
  it('an error on another field does not block a photos-only selection; it blocks any other', () => {
    expect(blockingIssues([season], [id('pictures'), id('Pictures')])).toEqual([])
    expect(blockingIssues([season], [id('pictures'), id('title')])).toEqual([season])
    expect(blockingIssues([season], [])).toEqual([season])
  })
  it('an error that names no field blocks everything, photos included; warnings never block', () => {
    expect(blockingIssues([season, account], [id('pictures')])).toEqual([season, account])
    expect(blockingIssues([{ ...season, severity: 'warning' }], [id('title')])).toEqual([])
  })
})

// Build shape v2 P4 — a Full update row's field is ticked and locked, DIFFERS and unchanged fields included, and its
// reason says what Full sends.
describe('fullUpdateChange', () => {
  const change = (status: StudioPublishChange['status'], current: StudioPublishChange['current'], channel: StudioPublishChange['channel']): StudioPublishChange => ({
    id: id('brand'), productId: 'parent', sku: 'SKU', field: 'brand', label: 'Brand', current, lastAccepted: { state: 'unknown', reason: 'none' }, channel, status,
    localChanged: null, channelChanged: null, selectable: false, selectedByDefault: false, reason: 'Partial reason', operation: 'replace' })
  const value = (v: string) => ({ state: 'value' as const, value: v })
  it.each([
    ['SAME', value('A'), value('A'), 'Full update sends it again (it already matches the channel).'],
    ['DIFFERS', value('A'), value('B'), 'Full update replaces the channel\'s different value with Nexus\'s.'],
    ['SEND', value('A'), value('B'), 'Full update sends Nexus\'s value.'],
    ['DIFFERS', { state: 'absent' as const }, value('B'), 'Full update removes it: Nexus holds no value here.'],
  ] as const)('%s → ticked, locked, with its own reason', (status, current, channel, reason) => {
    expect(fullUpdateChange(change(status, current, channel))).toMatchObject({ selectable: true, selectedByDefault: true, locked: true, reason, status })
  })
})

describe('one-click "Nexus wins" summary (Owner 2026-10-04)', () => {
  const line = (field: string, status: StudioPublishChange['status'], selectable = true, selectedByDefault = selectable): StudioPublishChange => ({
    id: id(field), productId: 'parent', sku: 'PARENT', field, label: field, current: { state: 'value', value: 'N' }, lastAccepted: { state: 'unknown', reason: 'none' },
    channel: { state: 'value', value: 'C' }, status, localChanged: null, channelChanged: null, selectable, selectedByDefault, reason: 'r', operation: 'replace',
  })
  const many = Array.from({ length: 12 }, (_, i) => line(`f${i}`, 'DIFFERS'))

  it('counts the selectable DIFFERS lines of a market: "12 values … differ … replaces them"', () => {
    const changes = [...many, line('send', 'SEND'), line('same', 'SAME', false), line('unread', 'CANNOT_COMPARE', false), line('refused', 'DIFFERS', false)]
    expect(differsSummary(changes, 'Amazon · IT')).toEqual({ count: 12, ticked: 12, sentence: '12 values on Amazon · IT differ from Nexus. Publish replaces them.' })
  })
  it('one value: singular words', () => {
    expect(differsSummary([line('title', 'DIFFERS')], 'eBay · IT')).toEqual({ count: 1, ticked: 1, sentence: '1 value on eBay · IT differs from Nexus. Publish replaces it.' })
  })
  it('"Keep Amazon\'s values" (none ticked) and a partial choice say what Publish does', () => {
    expect(differsSummary(many, 'Amazon · IT', [])!.sentence).toBe('12 values on Amazon · IT differ from Nexus. Publish keeps them.')
    expect(differsSummary(many, 'Amazon · IT', [id('f0'), id('f1'), 'other'])).toEqual({ count: 12, ticked: 2, sentence: '12 values on Amazon · IT differ from Nexus. Publish replaces 2 of them.' })
  })
  it('nothing differs → null', () => {
    expect(differsSummary([line('send', 'SEND')], 'Amazon · IT')).toBeNull()
    expect(differsSummary(undefined, 'Amazon · IT')).toBeNull()
  })
  it('the same words from counts alone (the products list has only each row\'s counts), ticks clamped', () => {
    expect(differsSentence(12, 12, 'Amazon · IT')).toBe(differsSummary(many, 'Amazon · IT')!.sentence)
    expect(differsSentence(1, 0, 'eBay · IT')).toBe('1 value on eBay · IT differs from Nexus. Publish keeps it.')
    expect(differsSentence(1200, 3, 'Amazon · DE')).toBe('1,200 values on Amazon · DE differ from Nexus. Publish replaces 3 of them.')
    expect(differsSentence(3, 9, 'eBay · IT')).toBe('3 values on eBay · IT differ from Nexus. Publish replaces them.')
  })
})
