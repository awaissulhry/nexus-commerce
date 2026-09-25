import { expect, it } from 'vitest'
import type { StudioPublishValue } from '@nexus/shared/studio-publication'
import { planPublicationChanges, publicationChangeId, selectPublicationChanges, type PublicationChangeInput } from './studio-publication-changes.js'

const value = (value: unknown): StudioPublishValue => ({ state: 'value', value })
const absent: StudioPublishValue = { state: 'absent' }
const unknown = (reason = 'No accepted publish record'): StudioPublishValue => ({ state: 'unknown', reason })
const input = (patch: Partial<PublicationChangeInput> = {}): PublicationChangeInput => ({
  productId: 'child-1', sku: 'SELLER-1', field: 'item_name', label: 'Title', current: value('New title'), lastAccepted: value('Old title'), channel: value('Old title'), ...patch,
})

it.each([
  ['local edit, channel unchanged', {}, 'SEND', true, true, true, false],
  ['all match', { current: value('Old title') }, 'SAME', false, false, false, false],
  ['channel already has the local edit', { channel: value('New title') }, 'SAME', false, false, true, true],
  ['channel edit, local unchanged', { current: value('Old title'), channel: value('Remote edit') }, 'DIFFERS', true, false, false, true],
  ['both edited differently', { channel: value('Remote edit') }, 'DIFFERS', true, false, true, true],
  ['first publish differs', { lastAccepted: unknown() }, 'DIFFERS', true, false, null, null],
  ['first publish already matches', { lastAccepted: unknown(), channel: value('New title') }, 'SAME', false, false, null, null],
  ['first publish cannot read channel', { lastAccepted: unknown(), channel: unknown('Read failed') }, 'CANNOT_COMPARE', false, false, null, null],
  ['local edit cannot read channel', { channel: unknown('Read failed') }, 'CANNOT_COMPARE', true, false, true, null],
  ['unchanged local cannot read channel', { current: value('Old title'), channel: unknown('Read failed') }, 'CANNOT_COMPARE', false, false, false, null],
  ['unknown local with known baseline', { current: unknown('Mapping failed') }, 'CANNOT_COMPARE', false, false, null, false],
  ['unknown local with no baseline', { current: unknown('Mapping failed'), lastAccepted: unknown() }, 'CANNOT_COMPARE', false, false, null, null],
  ['new listing with known value', { newListing: true, lastAccepted: unknown(), channel: unknown('Not created') }, 'SEND', true, true, null, null],
  ['new listing with unknown value', { newListing: true, current: unknown('Mapping failed'), lastAccepted: unknown(), channel: unknown('Not created') }, 'CANNOT_COMPARE', false, false, null, null],
  ['new listing remains an atomic creation', { newListing: true, channel: value('New title') }, 'SEND', true, true, true, true],
] as const)('%s', (_name, patch, status, selectable, selectedByDefault, localChanged, channelChanged) => {
  const source = input(patch)
  const [change] = planPublicationChanges([source])
  expect(change).toMatchObject({ id: publicationChangeId('child-1', 'item_name'), productId: 'child-1', sku: 'SELLER-1', field: 'item_name', label: 'Title',
    status, selectable, selectedByDefault, localChanged, channelChanged, operation: source.current.state === 'unknown' ? null : 'replace' })
  expect(change.reason.length).toBeGreaterThan(0)
})

it('preserves an explicit deletion tombstone instead of treating it as an unknown baseline', () => {
  const rows = planPublicationChanges([
    input({ field: 'clear', current: absent }),
    input({ field: 'already-cleared', current: absent, lastAccepted: absent, channel: absent }),
    input({ field: 'recreate', lastAccepted: absent, channel: absent }),
    input({ field: 'remote-recreated', current: absent, lastAccepted: absent, channel: value('Remote value') }),
  ])
  expect(rows.map(row => [row.field, row.status, row.operation, row.localChanged, row.channelChanged, row.selectedByDefault])).toEqual([
    ['clear', 'SEND', 'delete', true, false, true],
    ['already-cleared', 'SAME', 'delete', false, false, false],
    ['recreate', 'SEND', 'replace', true, false, true],
    ['remote-recreated', 'DIFFERS', 'delete', false, true, false],
  ])
})

it('distinguishes an explicit null value from absence and unknown', () => {
  expect(planPublicationChanges([input({ current: value(null), lastAccepted: absent, channel: absent })])[0])
    .toMatchObject({ status: 'SEND', operation: 'replace', localChanged: true, current: { state: 'value', value: null } })
  expect(planPublicationChanges([input({ current: absent, lastAccepted: value(null), channel: value(null) })])[0])
    .toMatchObject({ status: 'SEND', operation: 'delete', localChanged: true })
  expect(planPublicationChanges([input({ current: unknown('Unresolved field') })])[0])
    .toMatchObject({ status: 'CANNOT_COMPARE', operation: null, reason: expect.stringContaining('Unresolved field') })
})

it('canonicalizes nested object keys while keeping array order and raw scalar values', () => {
  const original = { title: 'A', details: { second: 2, first: 1 }, values: [{ b: 2, a: 1 }, 'B'] }
  const reordered = { values: [{ a: 1, b: 2 }, 'B'], details: { first: 1, second: 2 }, title: 'A' }
  const rows = planPublicationChanges([
    input({ field: 'object', current: value(reordered), lastAccepted: value(original), channel: value(original) }),
    input({ field: 'array', current: value(['B', 'A']), lastAccepted: value(['A', 'B']), channel: value(['A', 'B']) }),
    input({ field: 'number', current: value('1'), lastAccepted: value(1), channel: value(1) }),
    input({ field: 'spaces', current: value('A  B'), lastAccepted: value('A B'), channel: value('A B') }),
  ])
  expect(rows.map(row => [row.status, row.localChanged])).toEqual([['SAME', false], ['SEND', true], ['SEND', true], ['SEND', true]])
})

it('keeps each product and field independent, including delimiter-like identifiers', () => {
  const rows = planPublicationChanges([input(), input({ field: 'brand', current: value('Old title') }), input({ productId: 'child-2', sku: 'SELLER-2' })])
  expect(rows.map(row => [row.productId, row.field, row.status])).toEqual([
    ['child-1', 'item_name', 'SEND'], ['child-1', 'brand', 'SAME'], ['child-2', 'item_name', 'SEND'],
  ])
  expect(publicationChangeId('p:a', 'b')).toBe(JSON.stringify(['p:a', 'b']))
  expect(publicationChangeId('p:a', 'b')).not.toBe(publicationChangeId('p', 'a:b'))
})

it.each([
  [{}, 'SEND'], [{ channel: value('Remote edit') }, 'DIFFERS'], [{ current: value('Old title') }, 'SAME'], [{ channel: unknown('Read failed') }, 'CANNOT_COMPARE'],
] as const)('a refusal disables selection without hiding the comparison status (%j)', (patch, status) => {
  expect(planPublicationChanges([input({ ...patch, refusal: 'Offer closed — not sent' })])[0])
    .toMatchObject({ status, selectable: false, selectedByDefault: false, reason: 'Offer closed — not sent' })
})

it('keeps channel-read failure reasons visible', () => {
  expect(planPublicationChanges([input({ channel: unknown('Permission denied') })])[0].reason).toContain('Permission denied')
  expect(planPublicationChanges([input({ lastAccepted: unknown(), channel: unknown('Timed out') })])[0].reason).toContain('Timed out')
})

it('does not mutate the inputs or their nested value objects', () => {
  const nested = Object.freeze({ x: Object.freeze(['A', 'B']), a: 1 })
  const source = Object.freeze([Object.freeze(input({ current: Object.freeze(value(nested)) }))])
  const before = JSON.stringify(source)
  planPublicationChanges([...source])
  expect(JSON.stringify(source)).toBe(before)
})

it('uses provider comparison verdicts without normalizing the exact accepted-write baseline', () => {
  const matching = input({ current: value('1'), lastAccepted: value('0'), channel: value(1) })
  expect(planPublicationChanges([{ ...matching, currentMatchesChannel: true }])[0]).toMatchObject({ status: 'SAME', localChanged: true })
  const unchangedChannel = input({ channel: value(' Old title ') })
  expect(planPublicationChanges([{ ...unchangedChannel, currentMatchesChannel: false, acceptedMatchesChannel: true }])[0])
    .toMatchObject({ status: 'SEND', localChanged: true, channelChanged: false, selectedByDefault: true })
})

it('never lets a provider comparison verdict manufacture knowledge of an unread value', () => {
  const unread = { ...input({ current: unknown('Unresolved'), channel: unknown('Read failed') }), currentMatchesChannel: true, acceptedMatchesChannel: true }
  expect(planPublicationChanges([unread])[0]).toMatchObject({ status: 'CANNOT_COMPARE', selectable: false, localChanged: null, channelChanged: null })
  expect(planPublicationChanges([{ ...input({ lastAccepted: unknown(), channel: unknown('Read failed') }), currentMatchesChannel: true }])[0])
    .toMatchObject({ status: 'CANNOT_COMPARE', selectable: false })
})

it('never automatically sends unchanged Nexus values when only accepted-channel equality is supplied', () => {
  const same = input({ current: value('1'), lastAccepted: value('1'), channel: value(1) })
  expect(planPublicationChanges([{ ...same, acceptedMatchesChannel: true }])[0])
    .toMatchObject({ status: 'SAME', localChanged: false, channelChanged: false, selectable: false, selectedByDefault: false })
})

it('selects only explicitly chosen eligible fields, preserving review order', () => {
  const changes = planPublicationChanges([input(), input({ field: 'brand', channel: value('Remote edit') }), input({ field: 'unknown-channel', channel: unknown('Read failed') })])
  expect(selectPublicationChanges(changes, [])).toEqual([])
  expect(() => selectPublicationChanges(changes, [changes[2].id, changes[1].id])).not.toThrow()
  expect(selectPublicationChanges(changes, [changes[2].id, changes[1].id])).toEqual([changes[1], changes[2]])
  expect(changes.map(change => change.selectedByDefault)).toEqual([true, false, false])
})

it('rejects unknown, duplicate, case-changed and nonselectable selection IDs', () => {
  const changes = planPublicationChanges([input(), input({ field: 'same', current: value('Old title') }), input({ field: 'unresolved', current: unknown('Mapping failed') }), input({ field: 'closed', refusal: 'Closed' })])
  for (const ids of [['unknown'], [changes[0].id, changes[0].id], [changes[0].id.toUpperCase()], [changes[1].id], [changes[2].id], [changes[3].id]]) {
    expect(() => selectPublicationChanges(changes, ids)).toThrow()
  }
})

it('refuses ambiguous duplicate field coordinates', () => {
  expect(() => planPublicationChanges([input(), input()])).toThrow(/duplicate|ambiguous/i)
  const changes = planPublicationChanges([input()])
  expect(() => selectPublicationChanges([...changes, ...changes], [changes[0].id])).toThrow(/duplicate|ambiguous/i)
})
