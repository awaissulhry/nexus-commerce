/**
 * PES.3 — the channel-write contract (§14). Three rules, each of which fails SILENTLY if broken:
 * a write that lands on the wrong layer, on the wrong listing, or is refused for a conflict that
 * never happened. None of them throws, so only a test or a database read-back catches them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { addListingAlias, channelSheetResponse, commitChannelRow, updateListingAlias, writeLandsOnListing } from './useChannelSheet'
import { wireAliasKey, type ChannelSheetRow, type StudioCellValue } from './types'

const cell = (over: Partial<StudioCellValue>): StudioCellValue =>
  ({
    value: 'x', source: 'master', inheritedFrom: null, inherited: false, layer: 'master',
    pinned: false, follows: null, editable: true, linkGroupId: null, mapped: null,
    writeField: 'material', writeTarget: 'channelListing', writeVerb: 'channel',
    affectsAllChannels: false, writable: true,
    ...over,
  }) as unknown as StudioCellValue

const row = (over: Partial<ChannelSheetRow> = {}): ChannelSheetRow =>
  ({
    id: 'p1', rowId: 'primary:p1', sku: 'GALE-JACKET-BLACK-MEN-M', rowKind: 'variant',
    aliasId: null, version: 7,
    // The two counters are unrelated — the shape the whole §14 token contract exists for. Measured
    // on GALE-JACKET-BLACK-MEN-4XL: product 3, listing 82.
    listing: { id: 'l1', version: 82 },
    values: {
      material: cell({}),
      // The six column-backed fields: channelListing target, MASTER verb.
      ebay_title: cell({ writeField: 'ebay_title', writeTarget: 'channelListing', writeVerb: 'master' }),
      sku: cell({ writeField: 'sku', writeTarget: 'master', writeVerb: 'master' }),
    },
    ...over,
  }) as unknown as ChannelSheetRow

function captureBody(response: Record<string, unknown> = { updated: 1 }) {
  const seen: { body?: any } = {}
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
    seen.body = JSON.parse(init.body)
    return { ok: true, status: 200, json: async () => response } as unknown as Response
  }))
  return seen
}

afterEach(() => vi.unstubAllGlobals())

const coord = { channel: 'EBAY' as const, marketplace: 'IT' }

describe('channel information reads', () => {
  const empty = { rows: [], columns: [], aliases: [], scope: { channel: 'EBAY', marketplace: 'IT' }, meta: { schemaMissing: [], schemaAge: [] } }
  it('accepts a valid empty sheet without inventing a request failure', () => {
    expect(channelSheetResponse(empty)).toBe(empty)
  })
  it.each([null, {}, { ...empty, rows: null }, { ...empty, meta: {} }, { ...empty, scope: {} }])('rejects an incomplete success payload: %j', body => {
    expect(() => channelSheetResponse(body)).toThrow('information response was incomplete')
  })
})

describe('reference names are resolved by the server', () => {
  it('sends the pasted name and acknowledges the canonical ID on the saved cell', async () => {
    const seen = captureBody({
      updated: 1,
      normalizedChanges: [{ id: 'p1', field: 'attr_descriptionThemeId', value: 'theme-modern' }],
    })
    const r = row({ values: {
      descriptionThemeId: cell({ value: 'Modern', writeField: 'attr_descriptionThemeId' }),
    } })
    const result = await commitChannelRow({
      rowId: 'primary:p1', row: r,
      cells: [{ colId: 'descriptionThemeId', value: 'Modern', intent: 'set' }],
    } as never, { ...coord, accountId: 'account-a' })
    expect(seen.body.changes).toEqual([{ id: 'p1', field: 'attr_descriptionThemeId', value: 'Modern', target: 'channel', intent: 'set' }])
    expect(result.ok).toBe(true)
    expect(r.values.descriptionThemeId.value).toBe('theme-modern')
  })
})

describe('changes[].target is ECHOED from writeVerb, never derived', () => {
  it('sends target:channel for an override-bag attribute', async () => {
    const seen = captureBody()
    await commitChannelRow({ rowId: 'primary:p1', row: row(), cells: [{ colId: 'material', value: 'Nylon', intent: 'set' }] } as never, coord)
    expect(seen.body.changes[0].target).toBe('channel')
  })

  /**
   * 🔴 INVERTED by hub ruling #697. This case asserted `target: 'master'` for the six prefixed
   * fields until today, on the stated ground that `target: 'channel'` "would fire both routes".
   * Checked against the endpoint before changing it: `isChannelChange` (`products.routes.ts:1354`)
   * routes a non-`attr_*` field by its NAME and ignores `target`, and the write is a single
   * `if/else if/else` (`:2536`) — there is no second route. What `target` decides for these fields
   * is WHICH ROW's version the CAS guards (`:2703`), so the old pairing sent the PRODUCT's token
   * for a listing-only write: captured on the wire, `amazon_title` with `expectedVersion: 3` on a
   * row whose listing was at 82.
   */
  it('🔴 sends target:CHANNEL for the six prefixed fields — the row the write lands on (#697)', async () => {
    const seen = captureBody()
    await commitChannelRow({ rowId: 'primary:p1', row: row(), cells: [{ colId: 'ebay_title', value: 'T', intent: 'set' }] } as never, coord)
    expect(seen.body.changes[0].target).toBe('channel')
    // The FIELD is still the prefixed name — it is what the endpoint's map is keyed on.
    expect(seen.body.changes[0].field).toBe('ebay_title')
    // And the token is the LISTING's, not the product's 7.
    expect(seen.body.expectedVersion).toBe(82)
  })

  it('reads the SERVER\'s writeTarget, not a client copy of CHANNEL_FIELD_MAP (D15.16.4)', async () => {
    // A field the API's map does not know, that the server nonetheless says lands on the listing.
    // A client re-deriving the routing from the `amazon_`/`ebay_` prefix would call this master.
    const seen = captureBody()
    const r = row({ values: { ...row().values, future_field: cell({ writeField: 'shopify_title', writeTarget: 'channelListing', writeVerb: 'master' }) } } as never)
    await commitChannelRow({ rowId: 'primary:p1', row: r, cells: [{ colId: 'future_field', value: 'T', intent: 'set' }] } as never, coord)
    expect(seen.body.changes[0].target).toBe('channel')
    expect(writeLandsOnListing(r.values!.future_field)).toBe(true)
    expect(writeLandsOnListing(r.values!.sku)).toBe(false)
    expect(writeLandsOnListing(undefined)).toBe(false)
  })

  it('defaults to master when the server sent no cell — the safe direction', async () => {
    const seen = captureBody()
    await commitChannelRow({ rowId: 'primary:p1', row: row(), cells: [{ colId: 'unknown_col', value: 1, intent: 'set' }] } as never, coord)
    expect(seen.body.changes[0].target).toBe('master')
  })
})

describe('marketplaceContexts carries aliasKey, and primary is the EMPTY STRING', () => {
  it('retains the named account alongside the listing destination', async () => {
    const seen = captureBody()
    await commitChannelRow({ rowId: 'alias-2:p1', row: row({ aliasId: 'alias-2' }), cells: [{ colId: 'material', value: 'N', intent: 'set' }] } as never, { ...coord, accountId: 'account-b' })
    expect(seen.body.marketplaceContexts).toEqual([{ channel: 'EBAY', marketplace: 'IT', accountId: 'account-b', aliasKey: 'alias-2' }])
  })
  it("sends '' for the primary listing, never 'primary'", async () => {
    // `aliasKeyOf` returns 'primary' for building a sheet ROW ID. Sending that as the wire key
    // would miss the upsert's ON CONFLICT target and INSERT a second listing.
    expect(wireAliasKey(null)).toBe('')
    const seen = captureBody()
    await commitChannelRow({ rowId: 'primary:p1', row: row(), cells: [{ colId: 'material', value: 'N', intent: 'set' }] } as never, coord)
    expect(seen.body.marketplaceContexts[0].aliasKey).toBe('')
    expect(seen.body.marketplaceContexts[0]).not.toHaveProperty('aliasId')
  })

  it('sends the alias id for a non-primary alias', async () => {
    expect(wireAliasKey('alias-2')).toBe('alias-2')
    const seen = captureBody()
    await commitChannelRow({ rowId: 'alias-2:p1', row: row({ aliasId: 'alias-2' }), cells: [{ colId: 'material', value: 'N', intent: 'set' }] } as never, coord)
    expect(seen.body.marketplaceContexts[0].aliasKey).toBe('alias-2')
  })
})

describe('account refusals and alias requests', () => {
  it('keeps a delayed conflict on account A from changing account B’s version or destination', async () => {
    const pending = new Map<string, (response: Response) => void>()
    const bodies = new Map<string, any>()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      const account = body.marketplaceContexts[0].accountId
      bodies.set(account, body)
      return new Promise<Response>(resolve => pending.set(account, resolve))
    }))
    const a = row({ listing: { id: 'listing-a', version: 7 } } as Partial<ChannelSheetRow>)
    const b = row({ listing: { id: 'listing-b', version: 82 } } as Partial<ChannelSheetRow>)
    const request = (r: ChannelSheetRow) => ({ rowId: 'primary:p1', row: r, cells: [{ colId: 'material', value: 'N', intent: 'set' }] })
    const savingA = commitChannelRow(request(a) as never, { ...coord, accountId: 'account-a' })
    const savingB = commitChannelRow(request(b) as never, { ...coord, accountId: 'account-b' })
    expect(bodies.get('account-a').expectedVersion).toBe(7)
    expect(bodies.get('account-b').expectedVersion).toBe(82)
    pending.get('account-b')!(new Response(JSON.stringify({ updated: 1, currentVersion: 83, versionOf: 'channelListing' })))
    expect((await savingB).ok).toBe(true)
    pending.get('account-a')!(new Response(JSON.stringify({ code: 'VERSION_CONFLICT', currentVersion: 8, versionOf: 'channelListing' }), { status: 409 }))
    expect(await savingA).toMatchObject({ ok: false, conflict: true })
    expect(a.listing?.version).toBe(8)
    expect(b.listing).toMatchObject({ id: 'listing-b', version: 83 })
    expect(a.version).toBe(7)
    expect(b.version).toBe(7)
  })

  it.each(['AMBIGUOUS_CONNECTION', 'LISTING_SCOPE_MISMATCH'])('reports %s without inventing a row-version conflict', async code => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ code, message: 'Select the correct account' }) })))
    const result = await commitChannelRow({ rowId: 'primary:p1', row: row(), cells: [{ colId: 'material', value: 'N', intent: 'set' }] } as never, coord)
    expect(result).toEqual({ ok: false, reason: 'Select the correct account' })
  })

  it('includes the named account in both alias creation and rename', async () => {
    const seen = captureBody()
    await addListingAlias({ productId: 'p1', channel: 'EBAY', marketplace: 'IT', accountId: 'account-b' })
    expect(seen.body).toMatchObject({ accountId: 'account-b', channel: 'EBAY', marketplace: 'IT' })
    await updateListingAlias({ productId: 'p1', aliasId: 'alias-b', accountId: 'account-b', label: 'Italy' })
    expect(seen.body).toEqual({ accountId: 'account-b', label: 'Italy' })
  })
})

describe('expectedVersion names the row the write lands on', () => {
  /**
   * 🔴 REWRITTEN, and it had been passing for the wrong reason. It read "omits it for a channel
   * write — the CAS is on the LISTING version, WHICH WE DO NOT HAVE", which was true only until
   * `SheetListing.version` (§14.3) landed; the fixture row carried no `listing`, so the case could
   * not tell "omitted deliberately" from "omitted because this row has nothing to send". Giving the
   * fixture the real shape (product 7, listing 82 — the pair measured on GALE-JACKET) turned it
   * red, which is the case doing its job three months late. The omit branch is now its own test
   * below, on a row that genuinely has no listing.
   */
  it('sends the LISTING version for a channel write, never the product\'s', async () => {
    // Measured: 156 of 252 eBay·IT listings have a version differing from their product's, so
    // sending the product's would 409 on 62% of writes with a conflict that never happened.
    const seen = captureBody()
    await commitChannelRow({ rowId: 'primary:p1', row: row(), expectedVersion: 7, cells: [{ colId: 'material', value: 'N', intent: 'set' }] } as never, coord)
    expect(seen.body.expectedVersion).toBe(82)
    expect(seen.body.expectedVersion).not.toBe(7)
  })

  it('omits it for a channel write on a row with NO listing — never the product\'s as a stand-in', async () => {
    const seen = captureBody()
    await commitChannelRow({ rowId: 'primary:p1', row: row({ listing: undefined } as never), expectedVersion: 7, cells: [{ colId: 'material', value: 'N', intent: 'set' }] } as never, coord)
    expect(seen.body).not.toHaveProperty('expectedVersion')
  })

  it('keeps it for a master-only batch — that is the case the CAS was built for', async () => {
    const seen = captureBody()
    await commitChannelRow({ rowId: 'primary:p1', row: row(), expectedVersion: 7, cells: [{ colId: 'sku', value: 'S', intent: 'set' }] } as never, coord)
    expect(seen.body.expectedVersion).toBe(7)
  })

  it('🔴 sends the LISTING version for a mapped field, where it used to send the product\'s (#697)', async () => {
    // The pre-#697 payload — `amazon_title` with the product's 3 while the listing was at 82 — is
    // what PES.5's listing CAS must 409 on. This asserts the client no longer produces it.
    const seen = captureBody()
    await commitChannelRow({ rowId: 'primary:p1', row: row(), expectedVersion: 7, cells: [{ colId: 'ebay_title', value: 'T', intent: 'set' }] } as never, coord)
    expect(seen.body.expectedVersion).toBe(82)
    expect(seen.body.expectedVersion).not.toBe(7)
  })

  it('omits the token for a mapped field on a row with NO listing — never the product\'s as a stand-in', async () => {
    const seen = captureBody()
    const r = row({ listing: undefined } as never)
    await commitChannelRow({ rowId: 'primary:p1', row: r, expectedVersion: 7, cells: [{ colId: 'ebay_title', value: 'T', intent: 'set' }] } as never, coord)
    expect(seen.body).not.toHaveProperty('expectedVersion')
  })

  it.each(['ebay_title', 'material'])('splits a mixed paste and guards both persisted rows (%s)', async colId => {
    captureBody()
    await commitChannelRow({ rowId: 'primary:p1', row: row(), expectedVersion: 7, cells: [
      { colId: 'sku', value: 'S', intent: 'set' },
      { colId, value: 'T', intent: 'set' },
    ] }, coord)
    const sent = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(init!.body as string))
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({ expectedVersion: 7, changes: [{ field: 'sku', target: 'master' }] })
    expect(sent[1]).toMatchObject({ expectedVersion: 82, changes: [{ target: 'channel' }] })
  })

  it('keeps a saved Master cell distinct from an unanswered listing write', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ updated: 1, currentVersion: 8, versionOf: 'product' }) })
      .mockRejectedValueOnce(new TypeError('Failed to fetch')))
    const result = await commitChannelRow({ rowId: 'primary:p1', row: row(), expectedVersion: 7, cells: [
      { colId: 'sku', value: 'S', intent: 'set' }, { colId: 'material', value: 'T', intent: 'set' },
    ] }, coord)
    expect(result).toMatchObject({ ok: false, unreachable: true, version: 8, cells: {
      sku: { ok: true, unreachable: false }, material: { ok: false, unreachable: true },
    } })
  })

})

/**
 * #700 — what the sheet does with a 200 that changed nothing. Measured on screen before it was
 * written: the header said "1 change not saved" for a save the server had explicitly accepted.
 */
describe('a stated no-op is a SUCCESS; an unexplained one is not', () => {
  it('🔴 treats 200 {updated:0, unchanged:1} as saved — the server compared and had nothing to do', async () => {
    captureBody({ success: true, updated: 0, unchanged: 1, currentVersion: 82, versionOf: 'channelListing' })
    const r = await commitChannelRow({ rowId: 'primary:p1', row: row(), cells: [{ colId: 'material', value: 'N', intent: 'set' }] } as never, coord)
    expect(r.ok).toBe(true)
  })

  it('and writes the LISTING version back onto the row, so the next edit chains without a refetch', async () => {
    captureBody({ success: true, updated: 0, unchanged: 1, currentVersion: 99, versionOf: 'channelListing' })
    const r = row()
    await commitChannelRow({ rowId: 'primary:p1', row: r, cells: [{ colId: 'material', value: 'N', intent: 'set' }] } as never, coord)
    expect((r as unknown as { listing: { version: number } }).listing.version).toBe(99)
  })

  it('🔴 the CONTROL: 200 {updated:0} with NO `unchanged` stays a failure — that is the silent drop', async () => {
    // The shape this guard was built for: nothing happened and nobody said why. An older server
    // that has not got #675 answers exactly like this, and painting it as saved would be the lie
    // the guard exists to prevent.
    captureBody({ updated: 0 })
    const r = await commitChannelRow({ rowId: 'primary:p1', row: row(), cells: [{ colId: 'material', value: 'N', intent: 'set' }] } as never, coord)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('The server accepted the request but changed nothing')
  })
})

describe('unanswered writes', () => {
  it('reports a dropped connection as unknown instead of a server refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const result = await commitChannelRow({ rowId: 'primary:p1', row: row(), cells: [{ colId: 'material', value: 'N', intent: 'set' }] }, coord)
    expect(result).toMatchObject({ ok: false, unreachable: true, reason: expect.stringContaining('check whether this saved') })
    expect(result.conflict).not.toBe(true)
  })
})


describe('whole-list Follow Master', () => {
  it('sends one list reset at the exact alias and returns errors to the clicked slot', async () => {
    const seen = captureBody({ updated: 0, errors: [{ id: 'p1', field: 'amazon_bulletPoints', error: 'List refused' }] })
    const r = row({ aliasId: 'alias-2', values: { bulletPoints_2: cell({ writeField: 'amazon_bulletPoints[2]' }) } })
    const result = await commitChannelRow({ rowId: r.rowId, row: r, cells: [{ colId: 'bulletPoints_2', value: null, intent: 'reset-list' }] }, coord)
    expect(seen.body).toMatchObject({ changes: [{ field: 'amazon_bulletPoints', value: null, intent: 'reset', target: 'channel' }],
      marketplaceContexts: [{ aliasKey: 'alias-2' }], expectedVersion: 82 })
    expect(result.cells?.bulletPoints_2).toEqual({ ok: false, reason: 'List refused' })
  })
})
