/**
 * PES.3 — the channel verbs' refusals, which are the part that must never lie.
 */
import { describe, expect, it, vi } from 'vitest'

import { AVAILABLE, actionLabel } from '@/design-system/grid/actions/registry'
import { tidyServerMessage } from './rows'

import { CHANNEL_VERB_PERMISSION, offerMarkConsequence, broadcastToListings, offerToggle, openRecordAction, permissionRefusal, type ChannelActionDeps } from './channelActions'
import type { ChannelSheetRow } from './types'

it.each([false, true, undefined])('the offer effect follows the wire flag %s, without guessing an absent flag', async offerActiveHonoured => {
  const deps: ChannelActionDeps = { permission: 'granted', channelConnectionId: 'shopify-account',
    channel: 'SHOPIFY', marketplace: 'GLOBAL', scopeLabel: 'Shopify', aliases: [], siblingMarkets: [],
    pickMarkets: async () => null, openRecord: () => {}, openRecordId: null }
  const row = { id: 'p', rowId: 'primary:p', rowKind: 'variant', aliasId: null, sku: 'XAVIA',
    listing: { offerActive: true, offerActiveHonoured } } as unknown as ChannelSheetRow
  const impact = await offerToggle(deps).preflight!([row])
  expect(impact.consequences).toContain('Recorded as paused in Nexus. Nothing is sent to Shopify — the offer keeps selling there until you end it on the channel itself.')
  expect(impact.consequences?.includes('This channel does not act on the Nexus offer mark.')).toBe(offerActiveHonoured === false)
})

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

describe('#363 — the offer verb words itself from the SELECTION', () => {
  /**
   * The reason the resolver takes ROWS and not a count: with 2 of 3 paused, "Activate 3 offers"
   * is a lie about one of them. Only the verb knows which rows it would actually touch.
   */
  const deps2 = (): ChannelActionDeps => ({
    permission: 'granted', channelConnectionId: null, channel: 'EBAY', marketplace: 'IT', scopeLabel: 'eBay · IT',
    aliases: [], siblingMarkets: [], pickMarkets: async () => null,
    openRecord: () => {}, openRecordId: null,
  })
  const r = (offerActive: boolean | null) =>
    ({ id: 'p1', rowId: `r${Math.random()}`, rowKind: 'variant', aliasId: null,
       listing: offerActive === null ? null : { offerActive } }) as unknown as ChannelSheetRow

  const labelFor = (rows: ChannelSheetRow[]) => actionLabel(offerToggle(deps2()), rows)

  it('says "Pause N offers" when every selected offer is active', () => {
    expect(labelFor([r(true), r(true), r(true)])).toBe('Mark paused 3 offers on eBay · IT')
  })

  it('says "Activate N offers" when every selected offer is paused', () => {
    expect(labelFor([r(false), r(false)])).toBe('Mark active 2 offers on eBay · IT')
  })

  it('🔴 names the SUBSET on a mixed selection — the sentence a fixed string could not produce', () => {
    // 2 paused of 3: "Activate 3 offers" would be a lie about the active one.
    expect(labelFor([r(false), r(false), r(true)])).toBe('Mark active 2 of 3 offers on eBay · IT')
  })

  it('falls back to the bare verb when no selected row has a listing', () => {
    expect(labelFor([r(null)])).toBe('Mark paused offer on eBay · IT')
  })

  it('the label and the availability agree — both read the same plan', () => {
    const rows = [r(false), r(false), r(true)]
    expect(labelFor(rows)).toContain('Mark active 2 of 3')
    expect(offerToggle(deps2()).available(rows)).toEqual(AVAILABLE)
  })

  it('refuses only an EVEN split, where neither verb is more useful', () => {
    const a = offerToggle(deps2()).available([r(true), r(false)])
    expect(a.kind).toBe('disabled')
    expect((a as { reason: string }).reason).toMatch(/even split/)
  })
})


describe('Presence W0 honest offer consequences and refusal shape', () => {
  const deps = (channel: ChannelActionDeps['channel']): ChannelActionDeps => ({
    permission: 'granted', channelConnectionId: null, channel, marketplace: 'IT', scopeLabel: `${channel} · IT`,
    aliases: [], siblingMarkets: [{ code: 'DE', label: 'Germany' }], pickMarkets: async () => ['DE'],
    openRecord: () => {}, openRecordId: null,
  })
  const row = { id: 'p1', sku: 'GALE-JACKET', rowId: 'primary:p1', rowKind: 'variant', aliasId: null, listing: { offerActive: true } } as ChannelSheetRow
  it.each([
    ['AMAZON', false, 'Recorded as paused in Nexus. Amazon is told at the next Amazon flat-file publish, which suppresses the offer.'],
    ['AMAZON', true, "The pause mark is cleared, and Nexus queues this SKU's stock to Amazon straight away."],
    ['EBAY', false, 'Recorded as paused in Nexus. Nothing is sent to eBay — the offer keeps selling there until you end it on the channel itself.'],
    ['EBAY', true, "The pause mark is cleared, and Nexus queues this SKU's stock to eBay straight away."],
    ['SHOPIFY', false, 'Recorded as paused in Nexus. Nothing is sent to Shopify — the offer keeps selling there until you end it on the channel itself.'],
    ['SHOPIFY', true, "The pause mark is cleared, and Nexus queues this SKU's stock to Shopify straight away."],
    ['WOOCOMMERCE', false, 'Recorded in Nexus. Nothing is sent to WooCommerce from here.'],
    ['WOOCOMMERCE', true, 'Recorded in Nexus. Nothing is sent to WooCommerce from here.'],
    ['ETSY', false, 'Recorded as paused in Nexus. Nothing is ever sent to Etsy from here.'],
    ['ETSY', true, 'Recorded as paused in Nexus. Nothing is ever sent to Etsy from here.'],
  ] as const)('%s active=%s pins the sentence the operator reads', async (channel, active, sentence) => {
    expect(offerMarkConsequence(channel, active)).toBe(sentence)
    const selected = { ...row, listing: { ...row.listing!, offerActive: !active } }
    expect((await offerToggle(deps(channel)).preflight!([selected])).consequences?.[0]).toBe(sentence)
  })
  it('unavailable means level none; a channel-id row cannot ask for confirmation', async () => {
    const d = deps('EBAY')
    d.aliases = [{ id: null, externalListingId: '257584954808' }] as ChannelActionDeps['aliases']
    const impact = await offerToggle(d).preflight!([row])
    expect(impact.level).toBe('none')
    expect(impact.unavailable).toBe('Refused on 1 rows whose listing holds a channel id on EBAY. This verb only writes a Nexus record, and this studio has no verb that can carry it to EBAY.')
    expect(impact.sideEffects).toEqual(['Refused: 1 of these belong to a listing that holds a channel id, and this verb cannot touch those. Nothing is marked.'])
    expect((await offerToggle(deps('EBAY')).preflight!([row])).level).toBe('confirm')
    expect((await offerToggle(deps('EBAY')).preflight!([row])).sideEffects).toEqual(['None of these hold a channel id. A listing record is created on this coordinate for any row that has none.'])
  })
  it.each([[null, null, ''], ['account-b', 'alias-b', 'alias-b']] as const)('names account %s and alias %s in the narrowed write', async (account, aliasId, aliasKey) => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    try {
      const action = offerToggle({ ...deps('EBAY'), channelConnectionId: account })
      expect((await action.run([{ ...row, aliasId }])).ok).toBe(true)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ markets: [{ channel: 'EBAY', marketplace: 'IT', channelConnectionId: account, aliasKey, offerActive: false }] })
    } finally { vi.unstubAllGlobals() }
  })
  it.each(['account', 'alias'])('refuses a missing %s before any write or confirmation', async missing => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    try {
      const d = { ...deps('EBAY'), ...(missing === 'account' ? { channelConnectionId: undefined } : {}) } as ChannelActionDeps
      const selected = { ...row, ...(missing === 'alias' ? { aliasId: undefined } : {}) } as ChannelSheetRow
      const action = offerToggle(d)
      expect(action.available([selected]).kind).toBe('disabled')
      const impact = await action.preflight!([selected])
      expect(impact.level).toBe('none')
      expect(impact.unavailable).toBe('The listing’s account or alias was not reported. Reload before changing its offer mark.')
      expect(await action.run([selected])).toMatchObject({ ok: false, message: impact.unavailable })
      expect(fetcher).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })
  it('the held run and preflight expose the same sentence without transport', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    try {
      const d = deps('EBAY'); d.aliases = [{ id: null, externalListingId: '257584954808' }] as ChannelActionDeps['aliases']
      const action = offerToggle(d)
      const impact = await action.preflight!([row])
      expect(await action.run([row])).toEqual({ ok: false, message: impact.unavailable })
      expect(fetcher).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })
  it('broadcast is held on rows with and without an identity', async () => {
    const verb = broadcastToListings(deps('EBAY'))
    const impact = await verb.preflight!([row])
    expect(impact.level).toBe('none')
    expect(impact.unavailable).toBe('Broadcast is not built. Nothing is sent on any row, live or not.')
    expect((await verb.run([row])).message).toBe(impact.unavailable)
  })
})
