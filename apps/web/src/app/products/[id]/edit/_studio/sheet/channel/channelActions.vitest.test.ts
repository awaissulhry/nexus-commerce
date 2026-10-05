/**
 * PES.3 — the channel verbs' refusals, which are the part that must never lie.
 */
import { describe, expect, it } from 'vitest'

import { AVAILABLE } from '@/design-system/grid/actions/registry'
import type { PublishActionCell } from '@nexus/shared/publish-actions'
import { tidyServerMessage } from './rows'

import {
  ACTION_NOT_ON_CHANNEL, ACTION_ROLE_CANNOT_DELETE, CHANNEL_VERB_PERMISSION, LISTING_NOT_RECORDED, PUBLISH_THIS_LISTING, SHOW_ALL_LISTINGS, SHOW_ONLY_LISTING,
  actionMenuEntries, broadcastToListings, channelActions, listingBandActions, openRecordAction, permissionRefusal, type ChannelActionDeps, type ListingBandDeps,
} from './channelActions'
import { actionsFor, ROW } from '@/design-system/grid/actions/registry'
import type { ChannelSheetRow } from './types'

describe('permission refusals name the RIGHT permission (ruling #123)', () => {
  it('names products.edit, not a channels permission', () => {
    // Measured against permissions-manifest.ts:412 — `/api/products` prefix, so a CHANNEL verb
    // needs a PRODUCTS permission. Guessing by subject matter names the wrong one.
    expect(CHANNEL_VERB_PERMISSION).toBe('products.edit')
    expect(permissionRefusal('denied')).toContain('products.edit')
  })

  it('distinguishes NOT SIGNED IN from genuinely lacking it', () => {
    const noSession = permissionRefusal('no-session')!
    const denied = permissionRefusal('denied')!
    expect(noSession).not.toBe(denied)
    // The local-dev case must say so, or a developer reads a missing cookie as a permission defect.
    expect(noSession).toMatch(/not a permission problem/i)
    expect(denied).toMatch(/lacks/i)
  })

  it('says it is still checking rather than guessing', () => {
    expect(permissionRefusal('checking')).toMatch(/checking/i)
  })

  it('refuses nothing once granted', () => {
    expect(permissionRefusal('granted')).toBeNull()
  })
})

describe('the drawer has a way in (#135)', () => {
  /**
   * The drawer was mounted on the channel scope, wired to the registry and able to resolve any row
   * — and unreachable, because nothing offered to open it. A surface that exists only for the
   * person who built it has not shipped.
   */
  const deps = (openRecord: (id: string) => void): ChannelActionDeps => ({
    permission: 'granted', channelConnectionId: null,
    channel: 'EBAY',
    marketplace: 'IT',
    scopeLabel: 'eBay · IT',
    aliases: [],
    siblingMarkets: [],
    pickMarkets: async () => null,
    openRecord,
    openRecordId: null,
  })

  const variant = { rowId: 'primary:p1', rowKind: 'variant' } as unknown as ChannelSheetRow
  const band = { rowId: 'primary:band', rowKind: 'band' } as unknown as ChannelSheetRow

  it('is offered on a listing row', () => {
    expect(openRecordAction(deps(() => {})).available([variant])).toEqual(AVAILABLE)
  })

  it('is HIDDEN on an alias band — a group header is not a record', () => {
    // Not disabled: a band has no record to show, so the verb does not apply at all. Offering it
    // greyed out would ask the operator to work out why a header has no detail.
    expect(openRecordAction(deps(() => {})).available([band]).kind).toBe('hidden')
  })

  it('opens the row it was given, and nothing else', () => {
    const opened: string[] = []
    return openRecordAction(deps((id) => opened.push(id)))
      .run([variant])
      .then((r) => {
        expect(r.ok).toBe(true)
        expect(opened).toEqual(['primary:p1'])
      })
  })

  it('hides itself on the record already open — the drawer is the only surface today', () => {
    const d = deps(() => {})
    expect(openRecordAction({ ...d, openRecordId: 'primary:p1' }).available([variant]).kind).toBe('hidden')
  })

  it('needs no permission — reading a record is not products.edit', () => {
    const d = deps(() => {})
    expect(openRecordAction({ ...d, permission: 'no-session' }).available([variant])).toEqual(AVAILABLE)
  })
})

describe('#327·10 — a server sentence never ends mid-clause', () => {
  /**
   * Measured on Amazon·PL: `Unknown market "AMAZON:PL". This platform has: ` — 47 characters ending
   * in a colon that promises a list and delivers nothing, rendered on the surface that replaced the
   * listing wizard. A sentence stopping at a colon reads as a truncated bug report.
   */
  it('drops dangling punctuation and closes the sentence', () => {
    expect(tidyServerMessage('Unknown market "AMAZON:PL". This platform has: '))
      .toBe('Unknown market "AMAZON:PL". This platform has.')
  })

  it('leaves a well-formed message alone', () => {
    expect(tidyServerMessage('eBay refused this write.')).toBe('eBay refused this write.')
  })

  it('does not invent a full stop for an empty message', () => {
    expect(tidyServerMessage('   ')).toBe('')
  })
})

describe('Presence W0 — broadcast stays held', () => {
  const deps = (channel: ChannelActionDeps['channel']): ChannelActionDeps => ({
    permission: 'granted', channelConnectionId: null, channel, marketplace: 'IT', scopeLabel: `${channel} · IT`,
    aliases: [], siblingMarkets: [{ code: 'DE', label: 'Germany' }], pickMarkets: async () => ['DE'],
    openRecord: () => {}, openRecordId: null,
  })
  const row = { id: 'p1', sku: 'GALE-JACKET', rowId: 'primary:p1', rowKind: 'variant', aliasId: null, listing: { offerActive: true } } as ChannelSheetRow
  it('broadcast is held on rows with and without an identity', async () => {
    const verb = broadcastToListings(deps('EBAY'))
    const impact = await verb.preflight!([row])
    expect(impact.level).toBe('none')
    expect(impact.unavailable).toBe('Broadcast is not built. Nothing is sent on any row, live or not.')
    expect((await verb.run([row])).message).toBe(impact.unavailable)
  })
})

describe('build shape v2 — "Mark paused / active" is gone; Action ▾ counts what it would do', () => {
  const deps: ChannelActionDeps = { permission: 'granted', channelConnectionId: null, channel: 'AMAZON', marketplace: 'IT', scopeLabel: 'Amazon · IT',
    aliases: [], siblingMarkets: [], pickMarkets: async () => null, openRecord: () => {}, openRecordId: null }

  it('the channel verbs are Open record and Broadcast — no offer toggle', () => {
    expect(channelActions(deps).map(action => action.id)).toEqual(['open-record', 'broadcast-to-listings'])
  })

  const cell = (over: Partial<PublishActionCell> & { inactive?: boolean; end?: string | null; fba?: boolean } = {}): PublishActionCell => ({
    listingId: `l-${Math.random()}`, productId: 'p', sku: 'GALE-M', channel: 'AMAZON', marketplace: 'IT', accountId: 'a', aliasKey: '',
    state: 'active', stateReason: null,
    send: { mode: 'partial', setAt: null, setById: null, setByName: null, noLongerApplies: null },
    status: { target: null, setAt: null, setById: null, setByName: null, noLongerApplies: null },
    sendOptions: [
      { mode: 'partial', offered: true, reason: null, warning: null },
      { mode: 'full', offered: true, reason: null, warning: 'Every field…' },
      { mode: 'delete', offered: !over.fba, reason: over.fba ? 'Amazon holds FBA units for this offer.' : null, warning: null },
    ],
    statusOptions: [
      { target: 'active', offered: true, action: null, reason: null, warning: null, checkedAtSend: null },
      { target: 'inactive', offered: over.inactive ?? true, action: 'pause', reason: over.inactive === false ? 'Not possible from this state.' : null, warning: null, checkedAtSend: null },
      { target: 'ended', offered: over.end === undefined ? false : over.end === null, action: 'end', reason: over.end ?? 'Amazon has no End.', warning: null, checkedAtSend: null },
    ],
    ...over,
  })

  it('"Inactive — 18 of 21": each item counts the ticked rows whose own options allow it, and names why the rest cannot', () => {
    const rows = [
      ...Array.from({ length: 18 }, (_, i) => ({ sku: `GALE-${i}`, cell: cell() })),
      { sku: 'GALE-X', cell: cell({ inactive: false }) },
      { sku: 'GALE-Y', cell: cell({ inactive: false }) },
      { sku: 'GALE-NEW', cell: null },
    ]
    const entries = actionMenuEntries(rows, { publish: true, delete: true })
    expect(entries.map(e => e.label)).toEqual([
      'Active — 20 of 21', 'Inactive — 18 of 21', 'Ended — 0 of 21',
      'Partial update — 20 of 21', 'Full update — 20 of 21', 'Delete — 20 of 21',
    ])
    expect(entries.map(e => e.group)).toEqual(['Status', 'Status', 'Status', 'Send as', 'Send as', 'Send as'])
    const inactive = entries.find(e => e.id === 'status:inactive')!
    expect(inactive.note).toBe('3 not allowed: Not possible from this state.')
    expect(inactive.disabled).toBe(false)
    expect(inactive.change).toEqual({ column: 'status', target: 'inactive' })
    // None allow it: disabled, and the reason itself is the note.
    const ended = entries.find(e => e.id === 'status:ended')!
    expect(ended).toMatchObject({ disabled: true, note: 'Amazon has no End.', danger: true })
    expect(entries.find(e => e.id === 'send:partial')!.note).toBe(`1 not allowed: ${ACTION_NOT_ON_CHANNEL}`)
  })

  it('Ended and Delete need products.delete — the rest only products.publish', () => {
    const rows = [{ sku: 'A', cell: cell({ end: null }) }, { sku: 'B', cell: cell({ end: null, fba: true }) }]
    const entries = actionMenuEntries(rows, { publish: true, delete: false })
    expect(entries.find(e => e.id === 'status:ended')).toMatchObject({ allowed: 2, disabled: true, note: ACTION_ROLE_CANNOT_DELETE })
    expect(entries.find(e => e.id === 'send:delete')).toMatchObject({ allowed: 1, disabled: true, note: ACTION_ROLE_CANNOT_DELETE })
    expect(entries.find(e => e.id === 'send:full')).toMatchObject({ allowed: 2, disabled: false, note: null })
    const withRole = actionMenuEntries(rows, { publish: true, delete: true })
    expect(withRole.find(e => e.id === 'send:delete')).toMatchObject({ label: 'Delete — 1 of 2', disabled: false, note: '1 not allowed: Amazon holds FBA units for this offer.' })
  })

  it('delete and relist (simplify): a deleted row is a row not on the channel — its Status lists it again, its Full update changes nothing', () => {
    const already = 'Already deleted on Amazon · IT. To keep it off, leave its Status Not listed.'
    const deleted = cell({ state: 'not_listed', deleted: { at: '2026-10-04T06:00:00.000Z', where: 'Amazon · IT', oldReference: null, relistChosenAt: null, sentence: 'Deleted on Amazon · IT on 4 Oct.' },
      create: { target: 'not_listed', source: 'default', defaultTarget: 'not_listed', noRecord: false, sentence: 'Deleted on Amazon · IT on 4 Oct. To list it again, set Status to Active and Publish.' },
      sendOptions: [{ mode: 'partial', offered: false, reason: 'A new listing is always sent whole.', warning: null }, { mode: 'full', offered: true, reason: null, warning: 'A new listing is always sent whole.' },
        { mode: 'delete', offered: false, reason: already, warning: null }],
      statusOptions: (['active', 'inactive', 'not_listed'] as const).map(target => ({ target, offered: true, action: null, reason: null, warning: null, checkedAtSend: null })) })
    const mixed = actionMenuEntries([{ sku: 'A', cell: cell() }, { sku: 'B', cell: deleted }], { publish: true, delete: true })
    expect(mixed.find(e => e.id === 'status:active')).toMatchObject({ label: 'Active — 2 of 2', note: '1 deleted row is listed again on the next Publish.' })
    expect(mixed.find(e => e.id === 'status:not_listed')!.note).toMatch(/1 deleted row stays off\.$/)
    expect(mixed.find(e => e.id === 'send:full')).toMatchObject({ label: 'Full update — 2 of 2', note: '1 not on the channel is always sent whole.' })
    expect(mixed.find(e => e.id === 'send:delete')).toMatchObject({ label: 'Delete — 1 of 2', note: `1 not allowed: ${already}`, danger: true })
    // No "Keep deleted" any more: Delete on a deleted row alone is held with the reason.
    const only = actionMenuEntries([{ sku: 'B', cell: deleted }], { publish: true, delete: true })
    expect(only.find(e => e.id === 'send:delete')).toMatchObject({ label: 'Delete — 0 of 1', disabled: true, note: already })
    expect(only.some(e => e.label.startsWith('Keep deleted'))).toBe(false)
  })

  it('Ended appears only when a ticked row\'s channel can end a listing (never on Amazon)', () => {
    const amazon = cell({ statusOptions: (['active', 'inactive'] as const).map(target => ({ target, offered: true, action: target === 'inactive' ? 'pause' as const : null, reason: null, warning: null, checkedAtSend: null })) })
    expect(actionMenuEntries([{ sku: 'A', cell: amazon }], { publish: true, delete: true }).some(e => e.id === 'status:ended')).toBe(false)
  })
})

describe('a listing band\'s own verbs (aliases, Owner 2026-10-05)', () => {
  const band = (aliasId: string | null) => ({ rowId: `${aliasId ?? 'primary'}:fam-1`, rowKind: 'parent', aliasId, id: 'fam-1' }) as unknown as ChannelSheetRow
  const variant = { rowId: 'primary:child-1', rowKind: 'variant', aliasId: null, id: 'child-1' } as unknown as ChannelSheetRow
  function setup(over: Partial<ListingBandDeps> = {}) {
    const calls: { listing: Array<string | undefined>; publish: Array<string | null> } = { listing: [], publish: [] }
    const deps: ListingBandDeps = {
      listingCount: 3, shownAliasKey: null, publishRefusal: null,
      selectionOf: (aliasId) => aliasId ?? 'cl-main',
      setListing: (listing) => { calls.listing.push(listing) },
      publishListing: (aliasId) => { calls.publish.push(aliasId) },
      ...over,
    }
    return { calls, actions: listingBandActions(deps) }
  }
  const offered = (actions: ReturnType<typeof listingBandActions>, row: ChannelSheetRow) =>
    actionsFor(actions, ROW, [row]).map(({ action, availability }) => [action.label, availability.kind])

  it('a band offers "Show only this listing" and "Publish this listing…" — a variation row offers neither', () => {
    const { actions } = setup()
    expect(offered(actions, band('alias-1'))).toEqual([[SHOW_ONLY_LISTING, 'available'], [PUBLISH_THIS_LISTING, 'available']])
    expect(offered(actions, band(null))).toEqual([[SHOW_ONLY_LISTING, 'available'], [PUBLISH_THIS_LISTING, 'available']])
    expect(offered(actions, variant)).toEqual([])
  })

  it('one lone listing needs no band verbs', () => {
    expect(offered(setup({ listingCount: 1 }).actions, band(null))).toEqual([])
  })

  it('with one listing shown alone, the band offers the way back instead', () => {
    const { actions, calls } = setup({ shownAliasKey: 'alias-1', listingCount: 3 })
    expect(offered(actions, band('alias-1'))).toEqual([[SHOW_ALL_LISTINGS, 'available'], [PUBLISH_THIS_LISTING, 'available']])
    void actions.find(a => a.id === 'show-all-listings')!.run([band('alias-1')])
    expect(calls.listing).toEqual([undefined])
  })

  it('shows an alias by its alias id and the main listing by its own record', async () => {
    const { actions, calls } = setup()
    const show = actions.find(a => a.id === 'show-only-listing')!
    await show.run([band('alias-2')])
    await show.run([band(null)])
    expect(calls.listing).toEqual(['alias-2', 'cl-main'])
  })

  it('a listing with no record here cannot be shown alone, and says why', () => {
    const { actions } = setup({ selectionOf: () => undefined })
    expect(actions.find(a => a.id === 'show-only-listing')!.available([band('alias-1')])).toEqual({ kind: 'disabled', reason: LISTING_NOT_RECORDED })
  })

  it('publishes only this listing: an alias by its alias id, the main listing by none', async () => {
    const { actions, calls } = setup()
    const publish = actions.find(a => a.id === 'publish-listing')!
    await publish.run([band('alias-1')])
    await publish.run([band(null)])
    expect(calls.publish).toEqual(['alias-1', null])
  })

  it('Publish is held with its reason when the window cannot open here', async () => {
    const { actions, calls } = setup({ publishRefusal: 'Choose an account for this market first.' })
    const publish = actions.find(a => a.id === 'publish-listing')!
    expect(publish.available([band('alias-1')])).toEqual({ kind: 'disabled', reason: 'Choose an account for this market first.' })
    expect((await publish.run([band('alias-1')])).ok).toBe(false)
    expect(calls.publish).toEqual([])
  })

  it('every band verb stays on this page: local reach, no preflight', () => {
    for (const action of setup().actions) expect([action.reach, action.preflight]).toEqual(['local', undefined])
  })
})
