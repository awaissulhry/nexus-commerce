import { describe, expect, it } from 'vitest'
import type { StudioPublishValue } from '@nexus/shared/studio-publication'
import { planPublicationChanges, publicationChangeId, publicationValueWords, selectPublicationChanges, type PublicationChangeInput } from './studio-publication-changes.js'

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
  // One-click "Nexus wins" (Owner 2026-10-04): a selectable DIFFERS line starts ticked, like SEND.
  ['channel edit, local unchanged', { current: value('Old title'), channel: value('Remote edit') }, 'DIFFERS', true, true, false, true],
  ['both edited differently', { channel: value('Remote edit') }, 'DIFFERS', true, true, true, true],
  ['first publish differs', { lastAccepted: unknown() }, 'DIFFERS', true, true, null, null],
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
    ['remote-recreated', 'DIFFERS', 'delete', false, true, true],
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
  expect(changes.map(change => change.selectedByDefault)).toEqual([true, true, false])
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

describe('one-click "Nexus wins" (Owner 2026-10-04)', () => {
  const plan = (patch: Partial<PublicationChangeInput>) => planPublicationChanges([input(patch)], { channel: 'Amazon' })[0]

  it.each([
    ['channel_changed', { field: 'list_price', current: value(149), lastAccepted: value(149), channel: value(129) },
      'Changed on Amazon since the last publish. Amazon has 129.00 — Publish sets 149.00.'],
    ['both_changed', { current: value('New title'), lastAccepted: value('Old title'), channel: value('Remote title') },
      'Changed in Nexus and on Amazon. Amazon has Remote title — Publish sets New title.'],
    ['never_published', { lastAccepted: unknown(), channel: value('Imported title') },
      'Not published from Nexus before. Amazon has Imported title — Publish sets New title.'],
    ['never_published', { lastAccepted: unknown(), channel: absent }, 'Not published from Nexus before. Amazon has no value — Publish sets New title.'],
    ['removes', { current: absent, lastAccepted: absent, channel: value('Remote value') }, 'Amazon has Remote value — Publish removes it.'],
  ] as const)('a ticked DIFFERS line says what Publish replaces (%s)', (kind, patch, sentence) => {
    const change = plan(patch)
    expect(change).toMatchObject({ status: 'DIFFERS', selectable: true, selectedByDefault: true, replaces: { kind, sentence, note: null } })
  })

  it('never ticks or warns on SAME, CANNOT_COMPARE, SEND or a refused line', () => {
    const rows = planPublicationChanges([
      input({ field: 'same', current: value('Old title') }),
      input({ field: 'unread', channel: unknown('Read failed') }),
      input({ field: 'unread-first', lastAccepted: unknown(), channel: unknown('Read failed') }),
      input({ field: 'send' }),
      input({ field: 'refused', channel: value('Remote edit'), refusal: 'FBA listing — Amazon fulfils it.' }),
    ], { channel: 'Amazon' })
    expect(rows.map(row => [row.field, row.status, row.selectedByDefault, row.replaces])).toEqual([
      ['same', 'SAME', false, undefined], ['unread', 'CANNOT_COMPARE', false, undefined], ['unread-first', 'CANNOT_COMPARE', false, undefined],
      ['send', 'SEND', true, undefined], ['refused', 'DIFFERS', false, undefined],
    ])
    expect(rows[4].reason).toBe('FBA listing — Amazon fulfils it.')
  })

  it('puts values in words: markup stripped, cut to 60 characters, photos counted, selectors left out', () => {
    const long = `<p>${'Very long description '.repeat(10)}</p>`
    const words = publicationValueWords(value(long), 'description')!
    expect(words.length).toBe(60)
    expect(words.endsWith('…')).toBe(true)
    expect(words.startsWith('Very long description')).toBe(true)
    expect(publicationValueWords(value(['https://a.test/1.jpg', 'https://a.test/2.jpg']), 'pictures')).toBe('2 photos')
    expect(publicationValueWords(value([{ media_location: 'https://a.test/1.jpg', marketplace_id: 'IT' }]), 'main_product_image_locator')).toBe('1 photo')
    expect(publicationValueWords(value([{ value: 'Rosso', language_tag: 'it_IT', marketplace_id: 'APJ6JRA9NG5V4' }]), 'color')).toBe('Rosso')
    expect(publicationValueWords(value([{ value_with_tax: 129, currency: 'EUR', marketplace_id: 'APJ6JRA9NG5V4' }]), 'list_price')).toBe('129.00')
    expect(publicationValueWords(value(['Cotton', 'Linen']), 'aspect:material')).toBe('Cotton, Linen')
    expect(publicationValueWords(absent)).toBeNull()
    expect(publicationValueWords(unknown())).toBeNull()
  })

  it('two values whose words read the same still say Publish replaces the channel value', () => {
    const one = `${'A'.repeat(70)} one`, two = `${'A'.repeat(70)} two`
    expect(plan({ field: 'description', current: value(one), lastAccepted: value(one), channel: value(two) }).replaces!.sentence)
      .toBe(`Changed on Amazon since the last publish. Amazon has ${'A'.repeat(59)}… — Publish sets Nexus's version.`)
  })

  it('names "the channel" when no channel label is given', () => {
    expect(planPublicationChanges([input({ current: absent, lastAccepted: absent, channel: value('X') })])[0].replaces!.sentence)
      .toBe('The channel has X — Publish removes it.')
  })
})

describe('a channel that shows its own copy (re-hosted photos)', () => {
  const COPY = 'Amazon shows its own copy of the photos, so Nexus cannot compare them. Tick it to send Nexus\'s photos.'
  const nexus = value([{ media_location: 'https://res.cloudinary.com/nexus-demo/image/upload/v1/coat/main.jpg' }])
  const changedNexus = value([{ media_location: 'https://res.cloudinary.com/nexus-demo/image/upload/v2/coat/main.jpg' }])
  const amazonCopy = value([{ media_location: 'https://m.media-amazon.com/images/I/71AbCdEfGhL.jpg' }])
  const plan = (patch: Partial<PublicationChangeInput>) =>
    planPublicationChanges([input({ field: 'main_product_image_locator', current: nexus, lastAccepted: nexus, channel: amazonCopy, channelCopy: COPY, ...patch })], { channel: 'Amazon' })[0]

  it.each([
    ['unchanged in Nexus → SAME, never ticked', {}, 'SAME', false, false],
    ['changed in Nexus → SEND, ticked', { current: changedNexus }, 'SEND', true, true],
    ['no accepted record → cannot compare: selectable, never ticked', { lastAccepted: unknown() }, 'CANNOT_COMPARE', true, false],
  ] as const)('%s', (_name, patch, status, selectable, selectedByDefault) => {
    const change = plan(patch)
    expect(change).toMatchObject({ status, selectable, selectedByDefault, channelChanged: null })
    expect(change.replaces).toBeUndefined()
  })
  it('the no-record line says why in plain words', () => {
    expect(plan({ lastAccepted: unknown() }).reason).toBe(COPY)
  })
  it('a refusal still wins, and a channel with no value is compared as usual (a real difference)', () => {
    expect(plan({ current: changedNexus, refusal: 'Closed' })).toMatchObject({ selectable: false, selectedByDefault: false, reason: 'Closed' })
    expect(plan({ channel: absent })).toMatchObject({ status: 'DIFFERS', selectedByDefault: true, replaces: { kind: 'channel_changed' } })
  })
})
