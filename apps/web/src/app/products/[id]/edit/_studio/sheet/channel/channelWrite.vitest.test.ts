/**
 * PES.3 — the channel-write contract (§14). Three rules, each of which fails SILENTLY if broken:
 * a write that lands on the wrong layer, on the wrong listing, or is refused for a conflict that
 * never happened. None of them throws, so only a test or a database read-back catches them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CellSaveTracker, SheetWriter } from '@/design-system/grid'
import { commitVariationTheme } from '../master/masterWrite'
import { runBulkOperation, type BulkSavePost, type BulkSend } from '../bulkOperation'
import { preserveContentVersions } from '../contentVersions'

import { addListingAlias, channelSheetResponse, commitChannelRow, createdListingsOf, NO_LISTING_VERSION, updateListingAlias, writeLandsOnListing, type CreatedListing } from './useChannelSheet'
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

describe('shared content versions across listing aliases', () => {
  it('does not confirm an older alias cell from another alias own save', async () => {
    const make = (id: string, version: number, contentVersion: number) => row({ rowId: id, aliasId: id, version,
      values: { title: cell({ writeField: 'name', writeTarget: 'master', writeVerb: 'master',
        contentAddress: { tier: 'language', language: 'de' }, contentVersion } as never) } })
    const fresh = make('fresh-alias', 7, 4), stale = make('stale-alias', 6, 3)
    const bodies: Array<{ expectedVersion?: number; changes: Array<{ contentVersion?: number }> }> = []
    let owner = 7, content = 4
    const options = { ...coord, locale: 'de', familyRows: () => [fresh, stale], bulkSend: async (body: unknown) => {
      const sent = body as (typeof bodies)[number]
      bodies.push(sent)
      const accepted = sent.expectedVersion === owner && sent.changes[0].contentVersion === content
      if (accepted) { owner++; content++ }
      return new Response(JSON.stringify(accepted ? { updated: 1, currentVersion: owner, versionOf: 'product',
        contentVersions: [{ id: 'p1', tier: 'language', language: 'de', version: content }] }
        : { error: 'Changed', currentVersion: owner, versionOf: 'product' }), { status: accepted ? 200 : 409 })
    } }
    const save = (target: ChannelSheetRow) => commitChannelRow({ rowId: target.rowId, row: target, expectedVersion: target.version,
      cells: [{ colId: 'title', value: 'Next title', intent: 'set' }] }, options)
    expect((await save(fresh)).ok).toBe(true)
    expect(stale.version).toBe(8) // Generic fact ownership can move; the content proof must remain older.
    expect(stale.values.title.contentVersion).toBe(3)
    expect((await save(stale)).ok).toBe(false)
    expect(bodies.map(body => [body.expectedVersion, body.changes[0].contentVersion])).toEqual([[7, 4], [6, 3]])
  })

  it.each([['language', 'seed'], ['language', 'edit'], ['pin', 'seed'], ['pin', 'edit']] as const)('an older %s row supplied by %s keeps confirmed versions', async (tier, through) => {
    const make = () => row({ values: { title: cell({ writeField: 'name',
      writeTarget: tier === 'language' ? 'master' : 'channelListing', writeVerb: tier === 'language' ? 'master' : 'channel',
      contentAcknowledged: true, contentAddress: { tier, language: 'de',
        ...(tier === 'pin' ? { coordinate: { channel: 'EBAY', market: 'DE', accountId: 'account-a' } } : {}) }, contentVersion: 4 } as never) } })
    const initial = make(), stale = make()
    let ownerVersion = tier === 'language' ? 7 : 82, contentVersion = 4
    const sent: Array<{ owner: unknown; content: number }> = []
    const tracker = new CellSaveTracker()
    const writer = new SheetWriter<ChannelSheetRow>({ tracker, getApi: () => null, mergeRow: preserveContentVersions, commit: req => commitChannelRow(req, {
      ...coord, marketplace: 'DE', locale: 'de', accountId: 'account-a', familyRows: () => req.row ? [req.row] : [],
      onProductVersionsChanged: rows => writer.seed(rows.map(r => ({ id: r.rowId, version: r.version }))),
      bulkSend: async body => {
        const token = (body.changes as Array<{ contentVersion: number }>)[0].contentVersion
        sent.push({ owner: body.expectedVersion, content: token })
        const ok = body.expectedVersion === ownerVersion && token === contentVersion
        if (ok) { ownerVersion++; contentVersion++ }
        return new Response(JSON.stringify(ok ? { updated: 1, currentVersion: ownerVersion,
          versionOf: tier === 'language' ? 'product' : 'channelListing', contentVersions: [{ id: 'p1', tier, language: 'de', version: contentVersion }] }
          : { error: 'Changed' }), { status: ok ? 200 : 409 })
      },
    }) })
    writer.seed([{ id: initial.rowId, version: initial.version, row: initial }])
    try {
      writer.set(initial.rowId, 'title', 'First'); await writer.flush()
      expect(initial.values.title.contentVersion).toBe(5)
      if (through === 'seed') writer.seed([{ id: stale.rowId, version: stale.version, row: stale }])
      writer.set(initial.rowId, 'title', 'Second', through === 'edit' ? { row: stale } : {}); await writer.flush()
      expect(sent).toEqual(tier === 'language' ? [{ owner: 7, content: 4 }, { owner: 8, content: 5 }]
        : [{ owner: 82, content: 4 }, { owner: 83, content: 5 }])
      expect(tracker.get(initial.rowId, 'title')?.state).toBe('saved')
      // A later external delete/recreate is a fresh snapshot, not a stale content counter to keep.
      ownerVersion++; contentVersion = 1
      const fresh = make()
      if (tier === 'language') fresh.version = ownerVersion
      else fresh.listing!.version = ownerVersion
      fresh.values.title.contentVersion = 1
      writer.seed([{ id: fresh.rowId, version: fresh.version, row: fresh }])
      writer.set(fresh.rowId, 'title', 'After reset'); await writer.flush()
      expect(sent.at(-1)).toEqual({ owner: ownerVersion - 1, content: 1 })
      expect(tracker.get(fresh.rowId, 'title')?.state).toBe('saved')
    } finally { writer.destroy() }
  })
  it.each(['language', 'pin'] as const)('chains an immediate sibling save with the correct %s token before any read', async tier => {
    const makeRow = (aliasId: string | null, listingId: string) => row({ aliasId, rowId: `${aliasId ?? 'primary'}:p1`,
      listing: { id: listingId, version: 82 } as ChannelSheetRow['listing'],
      values: { title_de: cell({ writeField: 'title', writeTarget: tier === 'language' ? 'master' : 'channelListing', writeVerb: tier === 'language' ? 'master' : 'channel',
        contentAddress: { tier, language: 'de', coordinate: { channel: 'EBAY', market: 'IT', accountId: 'account-a', aliasKey: aliasId ?? '' } }, contentVersion: 4 } as never) },
    })
    const primary = makeRow(null, 'listing-primary')
    const alias = makeRow('alias-2', 'listing-alias')
    const anotherProduct = { ...makeRow(null, 'listing-other'), id: 'p2', rowId: 'primary:p2' }
    const bodies: any[] = []
    const bulkSend = vi.fn(async (body: unknown) => {
      bodies.push(body)
      return new Response(JSON.stringify({ updated: 1, currentVersion: (tier === 'language' ? 7 : 82) + bodies.length,
        versionOf: tier === 'language' ? 'product' : 'channelListing', contentVersions: [{ id: 'p1', tier, language: 'de', version: 4 + bodies.length }] }))
    })
    const options = { ...coord, accountId: 'account-a', familyRows: () => [primary, alias, anotherProduct], bulkSend }
    const save = (r: ChannelSheetRow) => commitChannelRow({ rowId: r.rowId, row: r, expectedVersion: r.version,
      cells: [{ colId: 'title_de', value: 'A new title', intent: 'set' }] } as never, options)

    expect((await save(primary)).ok).toBe(true)
    expect((await save(alias)).ok).toBe(true)
    expect(bodies.map(body => body.changes[0].contentVersion)).toEqual([4, tier === 'language' ? 5 : 4])
    expect(bodies.map(body => body.expectedVersion)).toEqual(tier === 'language' ? [7, 8] : [82, 82])
    expect(anotherProduct.version).toBe(7)
    expect(anotherProduct.values.title_de.contentVersion).toBe(4)
    expect(primary.values.title_de.contentVersion).toBe(tier === 'language' ? 6 : 5)
    expect(bulkSend).toHaveBeenCalledTimes(2)
  })
  it('a late answer never puts sibling content tokens behind a newer confirmed save', async () => {
    const r = row({ version: 9, values: { title: cell({ writeField: 'title', writeTarget: 'master', writeVerb: 'master', contentAddress: { tier: 'language', language: 'de' }, contentVersion: 6 } as never) } })
    const changed = vi.fn()
    const result = await commitChannelRow({ rowId: r.rowId, row: r, expectedVersion: 7, cells: [{ colId: 'title', value: 'Old response', intent: 'set' }] } as never,
      { ...coord, familyRows: () => [r], onProductVersionsChanged: changed,
        bulkSend: async () => new Response(JSON.stringify({ updated: 1, currentVersion: 8, versionOf: 'product', contentVersions: [{ id: 'p1', tier: 'language', language: 'de', version: 5 }] })) })
    expect(r.version).toBe(9)
    expect(r.values.title.contentVersion).toBe(6)
    expect(result.version).toBe(9)
    expect(changed).not.toHaveBeenCalled()
  })
  it('seeds the writer token of the sibling alias before its next queued edit', async () => {
    const make = (aliasId: string | null) => row({ aliasId, rowId: `${aliasId ?? 'primary'}:p1`, values: {
      title: cell({ writeField: 'title', writeTarget: 'master', writeVerb: 'master', contentAddress: { tier: 'language', language: 'de' }, contentVersion: 4 } as never),
    } })
    const primary = make(null), alias = make('alias-2'), rows = [primary, alias]
    const bodies: any[] = []
    const tracker = new CellSaveTracker()
    const writer = new SheetWriter<ChannelSheetRow>({ tracker, getApi: () => null, commit: req => commitChannelRow(req, {
      ...coord, familyRows: () => rows,
      onProductVersionsChanged: changed => writer.seed(changed.map(r => ({ id: r.rowId, version: r.version }))),
      bulkSend: async body => {
        bodies.push(body)
        const number = bodies.length
        const correct = body.expectedVersion === 6 + number && (body.changes as any[])[0].contentVersion === 3 + number
        return new Response(JSON.stringify(correct ? { updated: 1, versionOf: 'product', currentVersion: 7 + number,
          contentVersions: [{ id: 'p1', tier: 'language', language: 'de', version: 4 + number }] } : { error: 'Stale product or content version' }), { status: correct ? 200 : 409 })
      },
    }) })
    writer.seed(rows.map(r => ({ id: r.rowId, version: r.version, row: r })))
    try {
      writer.set(primary.rowId, 'title', 'First', { row: primary }); await writer.flush()
      writer.set(alias.rowId, 'title', 'Second', { row: alias }); await writer.flush()
      expect(bodies.map(body => body.expectedVersion)).toEqual([7, 8])
      expect(bodies.map(body => body.changes[0].contentVersion)).toEqual([4, 5])
      expect(tracker.get(alias.rowId, 'title')?.state).toBe('saved')
    } finally { writer.destroy() }
  })
  it('keeps a shared batch version after a no-op and an alias change, so the next edit saves', async () => {
    const make = (aliasId: string | null, value: string) => row({ aliasId, rowId: `${aliasId ?? 'primary'}:p1`, values: {
      title: cell({ value, writeField: 'name', writeTarget: 'master', writeVerb: 'master', contentAcknowledged: true,
        contentAddress: { tier: 'language', language: 'de' }, contentVersion: 4 } as never),
    } })
    const primary = make(null, 'Current'), alias = make('alias-2', 'Next'), rows = [primary, alias]
    let serverVersion = 7, contentVersion = 4, stored = 'Current'
    const sentVersions: unknown[] = []
    const post: BulkSavePost = async (_operation, units) => new Response(JSON.stringify({ units: units.map(unit => {
      sentVersions.push(unit.expectedVersion)
      const change = (unit.changes as Array<{ value: string; contentVersion: number }>)[0]
      if (unit.expectedVersion !== serverVersion || change.contentVersion !== contentVersion) {
        return { key: unit.key, status: 409, body: { currentVersion: serverVersion, versionOf: 'product', error: 'Changed' } }
      }
      if (change.value !== stored) { stored = change.value; serverVersion++; contentVersion++ }
      // applyContentBulk counts accepted plans as updated, including a byte-identical content write.
      return { key: unit.key, status: 200, body: { updated: 1, currentVersion: serverVersion, versionOf: 'product', errors: [],
        contentVersions: [{ id: 'p1', tier: 'language', language: 'de', version: contentVersion }] } }
    }) }))
    const tracker = new CellSaveTracker()
    const commit = (request: Parameters<typeof commitChannelRow>[0], bulkSend?: BulkSend) => commitChannelRow(request, {
      ...coord, marketplace: 'DE', locale: 'de', familyRows: () => rows, bulkSend,
      onProductVersionsChanged: changed => writer.seed(changed.map(r => ({ id: r.rowId, version: r.version }))),
    })
    const writer = new SheetWriter<ChannelSheetRow>({ tracker, getApi: () => null, commit,
      commitBatch: requests => runBulkOperation(requests, commit, { post }) })
    writer.seed(rows.map(r => ({ id: r.rowId, version: r.version, row: r })))
    try {
      writer.beginOperation()
      writer.set(primary.rowId, 'title', 'Current', { row: primary })
      writer.set(alias.rowId, 'title', 'Next', { row: alias })
      writer.endOperation()
      await writer.flush()
      expect(stored).toBe('Next')
      expect(serverVersion).toBe(8)
      expect(rows.map(r => r.version)).toEqual([8, 8])
      expect(writer.versionOf(alias.rowId)).toBe(8)
      expect.soft(writer.versionOf(primary.rowId)).toBe(8)
      writer.set(primary.rowId, 'title', 'Third', { row: primary })
      await writer.flush()
      expect.soft(sentVersions).toEqual([7, 7, 8])
      expect.soft(tracker.get(primary.rowId, 'title')?.state).toBe('saved')
    } finally { writer.destroy() }
  })
})

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

  /* Create path, step 6: was "omits it". The token for "I saw no listing" is 0 — never the product's as a stand-in, and
     never nothing, which the price and fulfilment doors refused with the wrong reason. */
  it('sends 0 for a channel write on a row with NO listing — never the product\'s as a stand-in', async () => {
    const seen = captureBody()
    await commitChannelRow({ rowId: 'primary:p1', row: row({ listing: undefined } as never), expectedVersion: 7, cells: [{ colId: 'material', value: 'N', intent: 'set' }] } as never, coord)
    expect(seen.body.expectedVersion).toBe(0)
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

  it('sends 0 for a mapped field on a row with NO listing — never the product\'s as a stand-in', async () => {
    const seen = captureBody()
    const r = row({ listing: undefined } as never)
    await commitChannelRow({ rowId: 'primary:p1', row: r, expectedVersion: 7, cells: [{ colId: 'ebay_title', value: 'T', intent: 'set' }] } as never, coord)
    expect(seen.body.expectedVersion).toBe(0)
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

describe('a listing-field refusal on a market with no listing (draft listing safety, step 1)', () => {
  const noListing = 'No AMAZON listing on SE yet — a listing field needs the listing to exist'
  const brandRow = () => row({ listing: null, values: {
    brand: cell({ writeField: 'attr_brand', writeTarget: 'channelListing', writeVerb: 'channel' }),
    material: cell({}),
  } } as never)
  const save = (r: ChannelSheetRow) => commitChannelRow({ rowId: r.rowId, row: r, cells: [
    { colId: 'brand', value: ['Nexus Moto'], intent: 'set' }, { colId: 'material', value: 'Nylon', intent: 'set' },
  ] } as never, { channel: 'AMAZON', marketplace: 'SE', accountId: 'account-a' })

  it('paints the refused cell refused when the server names the change field, and its sibling saved', async () => {
    captureBody({ updated: 2, errors: [{ id: 'p1', field: 'attr_brand', error: noListing }] })
    const result = await save(brandRow())
    expect(result.ok).toBe(false)
    expect(result.cells?.brand).toEqual({ ok: false, reason: noListing })
    expect(result.cells?.material).toEqual({ ok: true })
  })

  it('the control: the old answer under the JSON path matches no cell, so the refused cell painted saved', async () => {
    // Why the server must answer under `change.field`: the sheet matches errors EXACTLY and never guesses a path.
    captureBody({ updated: 2, errors: [{ id: 'p1', field: 'brand,attributes.brand.0.value', error: noListing }] })
    const result = await save(brandRow())
    expect(result.cells?.brand).toEqual({ ok: true })
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


/**
 * Product-sheet create path, step 6 (the Owner's D1 = A, 2026-09-27). The first channel-scope save on a market with no
 * listing starts the family's inert DRAFT (parent + every variant) on the server; the sheet sends 0 for "I saw no
 * listing", adopts what the server started, and answers the version-0 conflict by adopting the listing it names and
 * sending the edit once more.
 */
describe('a new market: version 0, the started draft, and the version-0 conflict', () => {
  const SE = { channel: 'AMAZON' as const, marketplace: 'SE', accountId: 'account-a' }
  const family = () => ({
    parent: row({ id: 'root', rowId: 'primary:root', sku: 'GALE-JACKET', rowKind: 'parent', listing: null } as never),
    v1: row({ id: 'p1', rowId: 'primary:p1', listing: null } as never),
    v2: row({ id: 'p2', rowId: 'primary:p2', sku: 'GALE-JACKET-BLACK-MEN-L', listing: null } as never),
    // The same child under another listing alias is another row — a primary draft is not its listing.
    aliased: row({ id: 'p2', rowId: 'alias-2:p2', aliasId: 'alias-2', listing: null } as never),
    // A row that already holds a listing keeps it: a started draft never replaces a listing the sheet read.
    listed: row({ id: 'p3', rowId: 'primary:p3', listing: { id: 'l-p3', version: 40 } } as never),
  })
  const started = [
    { productId: 'root', listingId: 'l-root', version: 1 },
    { productId: 'p1', listingId: 'l-p1', version: 2 },
    { productId: 'p2', listingId: 'l-p2', version: 1 },
    { productId: 'p3', listingId: 'l-other', version: 9 },
  ]
  const edit = (r: ChannelSheetRow) => ({ rowId: r.rowId, row: r, expectedVersion: 7, cells: [{ colId: 'material', value: 'Nylon', intent: 'set' as const }] })

  it('sends 0 on the first save, then adopts the WHOLE started family so the next save on any row carries its real version', async () => {
    const f = family()
    const seen = captureBody({ updated: 1, currentVersion: 2, versionOf: 'channelListing', createdListings: started })
    const told: Array<{ created: CreatedListing[]; adopted: string[] }> = []
    const result = await commitChannelRow(edit(f.v1) as never, { ...SE, familyRows: () => Object.values(f),
      onListingsCreated: (created, adopted) => told.push({ created, adopted: adopted.map(r => r.rowId) }) })
    expect(seen.body.expectedVersion).toBe(NO_LISTING_VERSION)
    expect(result.ok).toBe(true)
    // The saved row, its parent and its sibling — each at the version the server read back.
    expect(f.v1.listing).toMatchObject({ id: 'l-p1', version: 2, listingStatus: 'DRAFT', isPublished: false, externalListingId: null })
    expect(f.parent.listing).toMatchObject({ id: 'l-root', version: 1 })
    expect(f.v2.listing).toMatchObject({ id: 'l-p2', version: 1 })
    // Not another alias's row, and not a row that already had a listing.
    expect(f.aliased.listing).toBeNull()
    expect(f.listed.listing).toEqual({ id: 'l-p3', version: 40 })
    expect(told).toEqual([{ created: started, adopted: ['primary:p1', 'primary:root', 'primary:p2'] }])

    // The next save on a SIBLING row: its own draft's version, no reload in between.
    const next = captureBody({ updated: 1, currentVersion: 2, versionOf: 'channelListing' })
    await commitChannelRow(edit(f.v2) as never, { ...SE, familyRows: () => Object.values(f) })
    expect(next.body.expectedVersion).toBe(1)
  })

  it('adopts a started draft on a stated no-op too — clearing an empty value still started the listing', async () => {
    const f = family()
    captureBody({ success: true, updated: 0, unchanged: 1, currentVersion: 1, versionOf: 'channelListing', createdListings: started.slice(0, 3) })
    const result = await commitChannelRow(edit(f.v1) as never, { ...SE, familyRows: () => Object.values(f) })
    expect(result.ok).toBe(true)
    // Adopted at its read-back version, then the answer's own listing version for the saved row.
    expect(f.v1.listing).toMatchObject({ id: 'l-p1', version: 1 })
    expect(f.parent.listing).toMatchObject({ id: 'l-root' })
  })

  it('reads createdListings defensively: a malformed entry is left out, a missing version is not guessed', () => {
    expect(createdListingsOf({ createdListings: [{ productId: 'a', listingId: 'l-a', version: 3 }, { productId: 'b', listingId: 'l-b', version: null }, { productId: 7 }, null] }))
      .toEqual([{ productId: 'a', listingId: 'l-a', version: 3 }, { productId: 'b', listingId: 'l-b', version: null }])
    expect(createdListingsOf({ updated: 1 })).toEqual([])
    expect(createdListingsOf(null)).toEqual([])
  })

  it('a started listing with no read-back version is left for the next read (that row sends 0 again)', async () => {
    const f = family()
    captureBody({ updated: 1, createdListings: [{ productId: 'p1', listingId: 'l-p1', version: 2 }, { productId: 'p2', listingId: 'l-p2', version: null }] })
    await commitChannelRow(edit(f.v1) as never, { ...SE, familyRows: () => Object.values(f) })
    expect(f.v2.listing).toBeNull()
  })

  const conflict = { code: 'VERSION_CONFLICT', error: 'Another change landed first on this listing — refresh the scope to pick up the latest version.',
    expectedVersion: 0, currentVersion: 5, listingId: 'l-found', versionOf: 'channelListing' }

  it('on the version-0 conflict adopts the listing it names and sends the edit ONCE more at its version', async () => {
    const f = family()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(conflict), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ updated: 1, currentVersion: 6, versionOf: 'channelListing' })))
    vi.stubGlobal('fetch', fetchMock)
    const result = await commitChannelRow(edit(f.v1) as never, SE)
    const sent = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string))
    expect(sent.map(body => body.expectedVersion)).toEqual([0, 5])
    // The same edit, the same destination — only the token moved.
    expect(sent[1].changes).toEqual(sent[0].changes)
    expect(sent[1].marketplaceContexts).toEqual(sent[0].marketplaceContexts)
    expect(result).toMatchObject({ ok: true })
    expect(f.v1.listing).toMatchObject({ id: 'l-found', version: 6 })
  })

  it('never loops: a second conflict on the retry is reported as a conflict, after exactly two requests', async () => {
    const f = family()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(conflict), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...conflict, expectedVersion: 5, currentVersion: 7 }), { status: 409 }))
      .mockResolvedValue(new Response(JSON.stringify({ updated: 1 })))
    vi.stubGlobal('fetch', fetchMock)
    const result = await commitChannelRow(edit(f.v1) as never, SE)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ ok: false, conflict: true })
    // The writer is left holding the newest version the server named, ready for the operator's retry.
    expect(f.v1.listing).toMatchObject({ id: 'l-found', version: 7 })
  })

  it('the CONTROL: a conflict on a row that already had a listing is answered exactly as before — no retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...conflict, expectedVersion: 82, currentVersion: 83 }), { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = row()
    const result = await commitChannelRow(edit(r) as never, SE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: false, conflict: true })
    expect(r.listing).toMatchObject({ id: 'l1', version: 83 })
  })

  it('a version-0 conflict that names no listing is not retried (an older server): reported as a conflict', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'VERSION_CONFLICT', currentVersion: 5, versionOf: 'channelListing' }), { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    const f = family()
    const result = await commitChannelRow(edit(f.v1) as never, SE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: false, conflict: true })
    expect(f.v1.listing).toBeNull()
  })

  it.each([
    'Connect an Amazon account before listing on SE.',
    'Amazon · SE is not an active market in this business.',
    'The selected Amazon account is not connected. Reconnect it or choose another account before listing on SE.',
  ])('paints the draft creator\'s refusal on the cell that asked: %s', async (sentence) => {
    const f = family()
    f.v1.values = { ...f.v1.values, brand: cell({ writeField: 'attr_brand' }) }
    captureBody({ success: true, updated: 0, errors: [{ id: 'p1', field: 'material', error: sentence }] })
    const result = await commitChannelRow({ ...edit(f.v1), cells: [{ colId: 'material', value: 'Nylon', intent: 'set' }] } as never, SE)
    expect(result.ok).toBe(false)
    expect(result.cells?.material).toEqual({ ok: false, reason: sentence })
    expect(f.v1.listing).toBeNull()
  })
})

/**
 * Step 4 end to end in the web: the variation theme cell on a market with no listing is served writable with
 * `write.expectedVersion: 0` — nothing in the sheet may block it or swap the token, and the projection it answers
 * with names the listings the save started.
 */
describe('the variation theme on a market with no listing', () => {
  const write = { endpoint: 'projection' as const, expectedVersion: 0, aliasKey: '', coordinate: { channel: 'AMAZON', market: 'SE', accountId: 'account-a' } }
  const served = {
    axes: [{ axisKey: 'color', familyKey: 'Colore', target: 'color_name', included: true }],
    theme: null, write, writable: true, writeBlockedReason: null,
    deliveryNote: 'Saved to the Amazon · SE draft. Publish sends it.',
  }
  const picked = { ...served, theme: { code: 'COLOR' }, baseline: served }

  it('sends the theme to the projection at version 0, and adopts the parent listing the save started', async () => {
    const parent = row({ id: 'root', rowId: 'primary:root', rowKind: 'parent', listing: null,
      values: { variation_theme: cell({ writeField: 'variation_theme', value: served as never }) } } as never)
    const child = row({ id: 'p1', rowId: 'primary:p1', listing: null } as never)
    // A variant the sheet already showed listed here was not started by this save.
    const listedChild = row({ id: 'p3', rowId: 'primary:p3', listing: { id: 'l-p3', version: 4 } } as never)
    const seen: { url?: string; body?: any } = {}
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      seen.url = url; seen.body = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ version: 2,
        parent: { id: 'root', listing: { listingId: 'l-root', state: 'draft' } },
        children: [{ id: 'p1', listing: { listingId: 'l-p1', state: 'draft' } }, { id: 'p2', listing: { listingId: null, state: 'not-set-up' } },
          { id: 'p3', listing: { listingId: 'l-p3', state: 'draft' } }] }))
    }))
    const told: CreatedListing[][] = []
    const result = await commitChannelRow({ rowId: 'primary:root', row: parent, cells: [{ colId: 'variation_theme', value: picked, intent: 'set' }] } as never,
      { channel: 'AMAZON', marketplace: 'SE', accountId: 'account-a', kindOf: (colId) => colId === 'variation_theme' ? 'variationTheme' : undefined,
        familyRows: () => [parent, child, listedChild], onListingsCreated: (created) => told.push(created) })
    expect(new URL(seen.url!, 'http://x').pathname).toBe('/api/products/root/studio/projection')
    expect(Object.fromEntries(new URL(seen.url!, 'http://x').searchParams)).toEqual({ channel: 'AMAZON', market: 'SE', accountId: 'account-a' })
    expect(seen.body).toEqual({ expectedVersion: 0, theme: 'COLOR', mapping: [{ axisKey: 'Colore', target: 'color_name', order: 0 }] })
    expect(result.cells?.variation_theme).toEqual({ ok: true })
    // The parent at the version the projection states; a variant's version is not stated there, so it waits for the read.
    expect(told).toEqual([[{ productId: 'root', listingId: 'l-root', version: 2 }, { productId: 'p1', listingId: 'l-p1', version: null }]])
    expect(parent.listing).toMatchObject({ id: 'l-root', version: 2 })
    expect(child.listing).toBeNull()
    expect(listedChild.listing).toEqual({ id: 'l-p3', version: 4 })
  })

  it('a theme saved on a coordinate that HAS a listing reports no started draft', async () => {
    const parent = row({ id: 'root', rowId: 'primary:root', rowKind: 'parent' } as never)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: 83, parent: { id: 'root', listing: { listingId: 'l1' } }, children: [] }))))
    const told: CreatedListing[][] = []
    const live = { ...served, write: { ...write, expectedVersion: 82 }, deliveryNote: undefined }
    await commitChannelRow({ rowId: 'primary:root', row: parent, cells: [{ colId: 'variation_theme', value: { ...live, theme: { code: 'COLOR' }, baseline: live }, intent: 'set' }] } as never,
      { channel: 'AMAZON', marketplace: 'SE', kindOf: () => 'variationTheme', onListingsCreated: (created) => told.push(created) })
    expect(told).toEqual([])
  })
})


/**
 * The two counters stay apart after a variation-theme save (found while building step 6; it predates it).
 *
 * `PATCH …/studio/projection` answers with the coordinate's PARENT LISTING version (`ProjectionRead.version`). The theme
 * commit handed that number back as the write result's `version`, which the sheet writer stores as the row's PRODUCT
 * version — and `seed` only ever raises a version, so the next read could not lower it back. The next edit on the parent
 * that writes the shared product then sent the listing's number (a false 409), and a channel edit on the parent sent
 * the listing's OLD number, because the new one never reached `row.listing` (another false 409).
 */
describe('a variation-theme save keeps the listing version and the product version apart', () => {
  const tracker = () => {
    const m = new Map<string, { state: string; reason?: string }>()
    return {
      set: (rowId: string, colId: string, state: string, reason?: string) => m.set(`${rowId}:${colId}`, { state, reason }),
      get: (rowId: string, colId: string) => m.get(`${rowId}:${colId}`),
      clear: (rowId: string, colId: string) => m.delete(`${rowId}:${colId}`),
      clearAll: () => m.clear(),
    }
  }
  const live = {
    axes: [{ axisKey: 'color', familyKey: 'Colore', target: 'color_name', included: true }],
    theme: { code: 'COLOR' }, writable: true, writeBlockedReason: null, locked: null,
    write: { endpoint: 'projection' as const, expectedVersion: 82, aliasKey: '', coordinate: { channel: 'AMAZON', market: 'SE', accountId: 'account-a' } },
  }

  it('a shared-product write after it sends the PRODUCT version, and a channel write sends the NEW listing version', async () => {
    // The parent: product at 7, its Amazon · SE listing at 82 — the unrelated pair the whole token contract exists for.
    const parent = row({ id: 'root', rowId: 'primary:root', rowKind: 'parent', version: 7, listing: { id: 'l-root', version: 82 },
      values: { ...row().values, variation_theme: cell({ writeField: 'variation_theme', value: live as never }) } } as never)
    const bodies: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      bodies.push({ url, body })
      // The projection answers with the parent listing's version, and nothing about the product.
      if (url.includes('/studio/projection')) return new Response(JSON.stringify({ version: 83, parent: { id: 'root', listing: { listingId: 'l-root' } }, children: [] }))
      // The bulk route, answering like the server: a stale token is a 409, never a silent write.
      const guarded = body.changes[0].target === 'channel' ? 83 : 7
      if (body.expectedVersion !== guarded) return new Response(JSON.stringify({ code: 'VERSION_CONFLICT', currentVersion: guarded, versionOf: body.changes[0].target === 'channel' ? 'channelListing' : 'product' }), { status: 409 })
      return new Response(JSON.stringify(body.changes[0].target === 'channel'
        ? { updated: 1, currentVersion: 84, versionOf: 'channelListing' } : { updated: 1, currentVersion: 8, versionOf: 'product' }))
    }))
    const coordinate = { channel: 'AMAZON' as const, marketplace: 'SE', accountId: 'account-a', kindOf: (colId: string) => colId === 'variation_theme' ? 'variationTheme' : undefined }
    const writer = new SheetWriter<ChannelSheetRow>({ tracker: tracker() as never, getApi: () => null, commit: (req) => commitChannelRow(req, coordinate) })
    writer.seed([{ id: parent.rowId, version: parent.version, row: parent }])

    writer.set(parent.rowId, 'variation_theme', { ...live, theme: { code: 'SIZE/COLOR' }, baseline: live }, { row: parent })
    await writer.flush()
    expect(bodies[0].body.expectedVersion).toBe(82)
    // The listing version the projection answered lands on the parent LISTING.
    expect(parent.listing).toMatchObject({ id: 'l-root', version: 83 })

    // A shared-product write on the parent: the product's own 7, not the listing's 83.
    writer.set(parent.rowId, 'sku', 'GALE-JACKET-2', { row: parent })
    await writer.flush()
    expect(bodies[1].body).toMatchObject({ expectedVersion: 7, changes: [{ field: 'sku', target: 'master' }] })

    // A channel write on the parent: the listing's NEW 83, not the 82 it was read at.
    writer.set(parent.rowId, 'material', 'Nylon', { row: parent })
    await writer.flush()
    expect(bodies[2].body).toMatchObject({ expectedVersion: 83, changes: [{ field: 'material', target: 'channel' }] })
    expect(bodies).toHaveLength(3)
    writer.destroy()
  })

  it('the CONTROL: on master, `variation-axes` answers the PRODUCT version, and it is still the result\'s version', async () => {
    const master = { ...live, write: { endpoint: 'variation-axes' as const, expectedVersion: 7, aliasKey: '', coordinate: { channel: null, market: 'IT', accountId: null }, childIds: ['c1'] } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: 8 }))))
    const result = await commitVariationTheme({ rowId: 'root', row: null, cells: [{ colId: 'variation_theme', value: { ...master, axes: [...master.axes, { axisKey: 'size', familyKey: 'Taglia', target: null, included: true }], baseline: master }, intent: 'set' }] }, 'root')
    expect(result).toMatchObject({ ok: true, version: 8 })
  })

  it('a projection answer that states a product version is taken as the product version', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: 83, product: { version: 9 } }))))
    const result = await commitVariationTheme({ rowId: 'root', row: null, cells: [{ colId: 'variation_theme', value: { ...live, theme: { code: 'SIZE/COLOR' }, baseline: live }, intent: 'set' }] }, 'root')
    expect(result).toMatchObject({ ok: true, version: 9 })
  })
})

describe('P1 — an emptied list is a clear (report 1 I-10)', () => {
  it('sends null, which the write path takes for every shape, instead of [] (refused: "0 values — needs at least 1")', async () => {
    const seen = captureBody()
    await commitChannelRow({ rowId: 'primary:p1', row: row(), cells: [{ colId: 'material', value: [], intent: 'set' }] } as never, coord)
    expect(seen.body.changes[0]).toMatchObject({ field: 'material', value: null, intent: 'set' })
  })
})

describe('the next content edit on a row chains on the version the last save answered (P3 commit sweep)', () => {
  it('chains a pin created under a real version-zero absence check', async () => {
    const bodies: Array<{ expectedVersion?: number; changes: Array<{ contentVersion?: number }> }> = []
    const address = { tier: 'pin', language: 'it', coordinate: { channel: 'EBAY', market: 'IT', accountId: 'account-a' } }
    const draft = row({ listing: null, values: { title: cell({ writeField: 'name', contentAddress: address, contentVersion: 0 } as never) } })
    const options = { ...coord, accountId: 'account-a', bulkSend: async (body: unknown) => {
      const sent = body as (typeof bodies)[number]
      bodies.push(sent)
      const before = bodies.length - 1
      const accepted = sent.expectedVersion === before && sent.changes[0].contentVersion === before
      return new Response(JSON.stringify(accepted ? { updated: 1, currentVersion: before + 1, versionOf: 'channelListing',
        ...(before === 0 ? { createdListings: [{ productId: 'p1', listingId: 'created-listing', version: 1 }] } : {}),
        contentVersions: [{ id: 'p1', tier: 'pin', language: 'it', version: before + 1 }] } : { error: 'Changed' }), { status: accepted ? 200 : 409 })
    } }
    const save = (value: string) => commitChannelRow({ rowId: draft.rowId, row: draft, expectedVersion: 7,
      cells: [{ colId: 'title', value, intent: 'set' }] }, options)
    expect((await save('First pin')).ok).toBe(true)
    expect((await save('Next pin')).ok).toBe(true)
    expect(bodies.map(body => [body.expectedVersion, body.changes[0].contentVersion])).toEqual([[0, 0], [1, 1]])
  })

  it.each([false, true])('an existing listing only confirms a successfully created absent pin (foreign pin=%s)', async foreignPin => {
    const bodies: Array<{ expectedVersion?: number; changes: Array<{ contentVersion?: number; value?: string }> }> = []
    const address = { tier: 'pin', language: 'it', coordinate: { channel: 'EBAY', market: 'IT', accountId: 'account-a' } }
    const draft = row({ listing: null, values: { title: cell({ writeField: 'name', contentAddress: address, contentVersion: 0 } as never) } })
    let owner = 4, content = foreignPin ? 1 : 0, stored = foreignPin ? 'Foreign pin' : null
    const options = { ...coord, accountId: 'account-a', bulkSend: async (body: unknown) => {
      const sent = body as (typeof bodies)[number]
      bodies.push(sent)
      if (sent.expectedVersion === 0) return new Response(JSON.stringify({ code: 'VERSION_CONFLICT', currentVersion: owner,
        listingId: 'existing-listing', versionOf: 'channelListing' }), { status: 409 })
      if (sent.expectedVersion !== owner || sent.changes[0].contentVersion !== content) return new Response(JSON.stringify({ error: 'Changed' }), { status: 409 })
      owner++; content++; stored = sent.changes[0].value ?? null
      return new Response(JSON.stringify({ updated: 1, currentVersion: owner, versionOf: 'channelListing',
        contentVersions: [{ id: 'p1', tier: 'pin', language: 'it', version: content }] }))
    } }
    const save = (value: string) => commitChannelRow({ rowId: draft.rowId, row: draft, expectedVersion: 7,
      cells: [{ colId: 'title', value, intent: 'set' }] }, options)
    expect((await save('Own pin')).ok).toBe(!foreignPin)
    expect(bodies.map(body => body.expectedVersion)).toEqual([0, 4])
    expect(draft.listing?.id).toBe('existing-listing')
    if (foreignPin) {
      expect(draft.values.title.contentVersion).toBe(0)
      expect(stored).toBe('Foreign pin')
    } else {
      expect(draft.values.title.contentVersion).toBe(1)
      expect((await save('Next own pin')).ok).toBe(true)
      expect(bodies[2]).toMatchObject({ expectedVersion: 5, changes: [{ contentVersion: 1 }] })
      expect(stored).toBe('Next own pin')
    }
  })

  it('a second bullet save sends the version the first save moved the pin to, with no read in between', async () => {
    const bodies: any[] = []
    const answers = [
      { updated: 1, currentVersion: 83, versionOf: 'channelListing', contentVersions: [{ id: 'p1', tier: 'pin', language: 'it', version: 5 }] },
      { updated: 1, currentVersion: 84, versionOf: 'channelListing', contentVersions: [{ id: 'p1', tier: 'pin', language: 'it', version: 6 }] },
    ]
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      bodies.push(JSON.parse(init.body))
      return { ok: true, status: 200, json: async () => answers[bodies.length - 1] } as unknown as Response
    }))
    const address = { tier: 'pin', language: 'it', coordinate: { channel: 'AMAZON', market: 'IT' } }
    const r = row({ values: {
      bulletPoints_1: cell({ writeField: 'bulletPoints[1]', contentAddress: address, contentVersion: 4 } as never),
      bulletPoints_2: cell({ writeField: 'bulletPoints[2]', contentAddress: address, contentVersion: 4 } as never),
    } } as never)
    await commitChannelRow({ rowId: 'primary:p1', row: r, cells: [{ colId: 'bulletPoints_1', value: 'One', intent: 'set' }] } as never, { channel: 'AMAZON', marketplace: 'IT' })
    await commitChannelRow({ rowId: 'primary:p1', row: r, cells: [{ colId: 'bulletPoints_2', value: 'Two', intent: 'set' }] } as never, { channel: 'AMAZON', marketplace: 'IT' })
    expect(bodies.map(body => body.changes[0].contentVersion)).toEqual([4, 5])
    expect(bodies.map(body => body.expectedVersion)).toEqual([82, 83])
    expect(r.values.bulletPoints_1.contentVersion).toBe(6)
  })
})
