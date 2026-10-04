import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Sheet publish parity, step 3 (item 2) — the "Last publish" read, on the real schema and tenant policies.
 *
 * One family (a parent and two sizes) is listed on Amazon IT under two accounts and an alias. Publications and their
 * journals are written directly, as the publish path leaves them. The cases pin: each row shows its NEWEST publish on
 * the exact destination (another account's or alias's newer publish never leaks in); the per-SKU result and its
 * channel issues; a create reads as a complete listing; open issues carry the attributes the channel named; a
 * publication that has not settled is reported as in flight; and the stored request is never read out of the database.
 * Build shape v2: a newer selling change (Pause offer, Delete listing…) is the row's last publish, with its kind; a row
 * sent as a Full update says so.
 */
const state = vi.hoisted(() => ({ db: null as any, raw: [] as Array<{ sql: string; result: unknown }> }))
vi.mock('@nexus/database', async () => {
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../test-support/concurrent-database.js')
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  const client = state.db.client
  // Every raw statement and what it returned, so a case can prove what was (not) read out of the database.
  return { default: new Proxy(client, { get(target, prop) {
    if (prop === '$queryRaw') return async (query: { strings: string[] }, ...rest: unknown[]) => {
      const result = await target.$queryRaw(query, ...rest)
      state.raw.push({ sql: query.strings.join('?'), result })
      return result
    }
    const value = Reflect.get(target, prop, target)
    return typeof value === 'function' ? value.bind(target) : value
  } }) }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readPublicationStatus } from './publication-status.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
/** Sits in every stored request and change plan: if it ever comes out of the database, the read loaded too much. */
const MARKER = 'STORED-REQUEST-MUST-NOT-BE-READ'
const ids: Record<string, string> = {}
const listing: Record<string, string> = {}
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 10, minutes))

async function publication(id: string, input: { account: string; aliasKey?: string; status: string; minute: number; userId?: string | null
  results?: Array<Record<string, unknown>> }) {
  await prisma.bulkOperation.create({ data: {
    id, userId: input.userId ?? null, productCount: 3, changeCount: 3, status: input.status,
    changes: { kind: 'studio-publication', plan: { note: MARKER }, ...(input.results ? { result: { id, status: input.status, message: 'stored', results: input.results } } : {}) },
    kind: 'studio-publication', productId: ids.root, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: input.account, aliasKey: input.aliasKey ?? '',
    submittedAt: input.status === 'PREVIEW' ? null : at(input.minute), createdAt: at(input.minute),
    summary: input.status === 'PREVIEW' ? undefined : { products: 3, accepted: 2, failed: 1 },
  } as never })
}

async function journal(listingId: string, publicationId: string, input: { sku: string; account: string; aliasKey?: string; minute: number; outcome?: string
  create?: boolean; fields?: string[] }) {
  const request = input.create
    ? { feedType: 'JSON_LISTINGS_FEED', message: { sku: input.sku, operationType: 'UPDATE', attributes: { item_name: [{ value: MARKER }] } }, intentVersion: 1,
      writes: [{ field: 'item_name', value: { state: 'value', value: MARKER } }, { field: 'brand', value: { state: 'value', value: MARKER } }] }
    : { feedType: 'JSON_LISTINGS_FEED', message: { sku: input.sku, operationType: 'PATCH', patches: [{ op: 'replace', value: MARKER }] }, intentVersion: 1,
      writes: (input.fields ?? []).map(field => ({ field, value: { state: 'value', value: MARKER } })) }
  await prisma.channelListingSnapshot.create({ data: {
    channelListingId: listingId, channel: 'AMAZON', marketplace: 'IT', aliasKey: input.aliasKey ?? '', reason: 'publish', publishEventId: publicationId,
    outcome: input.outcome ?? 'UNACCEPTED', createdAt: at(input.minute),
    payload: { schemaVersion: 1, kind: 'studio-publication', productId: 'x', channelConnectionId: input.account, sku: input.sku, requests: [request] },
  } as never })
}

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', region: 'EU', currency: 'EUR', language: 'it', languages: ['it'] } as never })
    ids.user = (await prisma.userProfile.create({ data: { displayName: 'Publisher Person', email: 'publisher@example.test' } as never })).id
    ids.a = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'Account A', isActive: true, externalAccountId: 'SELLER-A', authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
    ids.b = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'Account B', isActive: true, externalAccountId: 'SELLER-B', authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
    ids.root = (await prisma.product.create({ data: { sku: 'COAT', name: 'Coat', basePrice: 10, isParent: true } as never })).id
    ids.s = (await prisma.product.create({ data: { sku: 'COAT-S', name: 'Coat S', basePrice: 10, parentId: ids.root } as never })).id
    ids.m = (await prisma.product.create({ data: { sku: 'COAT-M', name: 'Coat M', basePrice: 10, parentId: ids.root } as never })).id
    ids.alias = (await prisma.productListingAlias.create({ data: { productId: ids.root, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: ids.a, label: 'Winter', position: 1 } as never })).id
    for (const [key, productId] of [['root', ids.root], ['s', ids.s], ['m', ids.m]] as const) {
      const base = { productId, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU' }
      listing[key] = (await prisma.channelListing.create({ data: { ...base, channelConnectionId: ids.a } as never })).id
      listing[`${key}B`] = (await prisma.channelListing.create({ data: { ...base, channelConnectionId: ids.b } as never })).id
      listing[`${key}Alias`] = (await prisma.channelListing.create({ data: { ...base, channelConnectionId: ids.a, aliasId: ids.alias, aliasKey: ids.alias } as never })).id
    }

    // Older: every row verified. Newer: the parent created again (a full listing), size S refused with an issue.
    await publication('pub-old', { account: ids.a, status: 'VERIFIED', minute: 1, userId: ids.user, results: [
      { sku: 'COAT', status: 'VERIFIED', message: 'Verified', reference: 'FEED-OLD' },
      { sku: 'COAT-S', status: 'VERIFIED', message: 'Verified', reference: 'FEED-OLD' },
      { sku: 'COAT-M', status: 'VERIFIED', message: 'Verified', reference: 'FEED-OLD' }] })
    for (const [key, sku] of [['root', 'COAT'], ['s', 'COAT-S'], ['m', 'COAT-M']] as const)
      await journal(listing[key], 'pub-old', { sku, account: ids.a, minute: 1, outcome: 'ACCEPTED', fields: ['item_name'] })
    await publication('pub-new', { account: ids.a, status: 'PARTIAL', minute: 5, userId: ids.user, results: [
      { sku: 'COAT', status: 'ACCEPTED', message: 'Accepted', reference: 'FEED-NEW' },
      { sku: 'COAT-S', status: 'FAILED', message: 'Amazon refused 1 attribute.', reference: 'FEED-NEW',
        issues: [{ code: '8541', severity: 'error', message: 'The value is not allowed.', attributeNames: ['color'] }] }] })
    await journal(listing.root, 'pub-new', { sku: 'COAT', account: ids.a, minute: 5, outcome: 'ACCEPTED', create: true })
    await journal(listing.s, 'pub-new', { sku: 'COAT-S', account: ids.a, minute: 5, outcome: 'FAILED', fields: ['color', 'bullet_point', 'color'] })

    // Newer still, but elsewhere: account B and the alias. Neither may show on account A's primary listing.
    await publication('pub-b', { account: ids.b, status: 'FAILED', minute: 9, results: [{ sku: 'COAT-M', status: 'FAILED', message: 'Account B refused' }] })
    await journal(listing.mB, 'pub-b', { sku: 'COAT-M', account: ids.b, minute: 9, outcome: 'FAILED', fields: ['item_name'] })
    await publication('pub-alias', { account: ids.a, aliasKey: ids.alias, status: 'VERIFIED', minute: 9, results: [{ sku: 'COAT-M', status: 'VERIFIED', message: 'Alias verified' }] })
    await journal(listing.mAlias, 'pub-alias', { sku: 'COAT-M', account: ids.a, aliasKey: ids.alias, minute: 9, outcome: 'ACCEPTED', fields: ['item_name'] })

    // Issues the channel reports now: open on size S (account A), resolved on size S, open on account B's size S.
    const issue = (listingId: string, fingerprint: string, extra: object = {}) => prisma.listingIssue.create({ data: {
      listingId, code: '8541', severity: 'ERROR', message: 'Colour value is not allowed.', attributeNames: ['color'], categories: [], source: 'amazon-feed',
      fingerprint, lastSeenAt: at(6), ...extra } as never })
    await issue(listing.s, 'open-a')
    await issue(listing.s, 'resolved-a', { resolvedAt: at(7) })
    await issue(listing.sB, 'open-b')
  })
}, 120_000)

afterAll(async () => { await state.db?.close?.() })

const read = (extra: { aliasKey?: string; accountId?: string } = {}) => scoped(() =>
  readPublicationStatus({ productId: ids.s, channel: 'amazon', marketplace: 'it', accountId: extra.accountId ?? ids.a, aliasKey: extra.aliasKey }, at(30)))
const rowOf = (status: Awaited<ReturnType<typeof read>>, productId: string) => status.rows.find(row => row.productId === productId)!

describe('readPublicationStatus', () => {
  it('shows each row its newest publish on the exact destination, with its own result and issues', async () => {
    const status = await read()
    expect(status.destination).toEqual({ channel: 'AMAZON', marketplace: 'IT', accountId: ids.a, aliasKey: '' })
    expect(status.rows.map(row => row.listingId).sort()).toEqual([listing.root, listing.s, listing.m].sort())

    const s = rowOf(status, ids.s)
    expect(s.sku).toBe('COAT-S')
    expect(s.last).toEqual({
      publicationId: 'pub-new', status: 'PARTIAL', outcome: 'FAILED', at: at(5).toISOString(), userName: 'Publisher Person',
      message: 'Amazon refused 1 attribute.', reference: 'FEED-NEW', sentFields: ['color', 'bullet_point'],
      issues: [{ code: '8541', severity: 'error', message: 'The value is not allowed.', attributeNames: ['color'] }], kind: 'publish',
    })
    // A create reads as a complete listing, not as the hundred attributes it carried.
    expect(rowOf(status, ids.root).last).toMatchObject({ publicationId: 'pub-new', outcome: 'ACCEPTED', sentFields: ['$create'] })
    // Size M was not in the newer publish: its last publish is the older one.
    expect(rowOf(status, ids.m).last).toMatchObject({ publicationId: 'pub-old', status: 'VERIFIED', outcome: 'VERIFIED', reference: 'FEED-OLD', sentFields: ['item_name'] })
  })

  it('never lets another account or alias leak in, and reads each of them on its own', async () => {
    const primary = await read()
    expect(JSON.stringify(primary)).not.toContain('pub-b')
    expect(JSON.stringify(primary)).not.toContain('pub-alias')

    const other = await read({ accountId: ids.b })
    expect(other.rows.map(row => row.listingId).sort()).toEqual([listing.rootB, listing.sB, listing.mB].sort())
    expect(rowOf(other, ids.m).last).toMatchObject({ publicationId: 'pub-b', status: 'FAILED', outcome: 'FAILED', message: 'Account B refused' })
    expect(rowOf(other, ids.root).last).toBeNull()

    const alias = await read({ aliasKey: ids.alias })
    expect(alias.destination.aliasKey).toBe(ids.alias)
    expect(alias.rows.map(row => row.listingId).sort()).toEqual([listing.rootAlias, listing.sAlias, listing.mAlias].sort())
    expect(rowOf(alias, ids.m).last).toMatchObject({ publicationId: 'pub-alias', status: 'VERIFIED' })
  })

  it('lists the open issues the channel reports now, with the attributes it named', async () => {
    const status = await read()
    expect(rowOf(status, ids.s).issues).toEqual([{ code: '8541', severity: 'error', message: 'Colour value is not allowed.', attributeNames: ['color'],
      source: 'amazon-feed', seenAt: at(6).toISOString() }])
    expect(rowOf(status, ids.m).issues).toEqual([])
  })

  it('reports a publication that has not settled as in flight, and the newest sent one as latest; a preview is neither', async () => {
    expect((await read()).inFlight).toBeNull()
    await scoped(async () => {
      await publication('pub-flight', { account: ids.a, status: 'SUBMITTED', minute: 20 })
      await publication('pub-preview', { account: ids.a, status: 'PREVIEW', minute: 25 })
    })
    const waiting = await read()
    expect(waiting.inFlight).toEqual({ publicationId: 'pub-flight', status: 'SUBMITTED' })
    expect(waiting.latest).toMatchObject({ publicationId: 'pub-flight', status: 'SUBMITTED', at: at(20).toISOString() })
    // The rows keep their last finished journal until the in-flight publish journals them.
    expect(rowOf(waiting, ids.s).last?.publicationId).toBe('pub-new')

    await scoped(() => prisma.bulkOperation.update({ where: { id: 'pub-flight' }, data: { status: 'VERIFIED', completedAt: at(22) } }))
    const settled = await read()
    expect(settled.inFlight).toBeNull()
    expect(settled.latest).toMatchObject({ publicationId: 'pub-flight', status: 'VERIFIED', completedAt: at(22).toISOString(), summary: { products: 3, accepted: 2, failed: 1 } })
  })

  it('does not report a publication a person marked checked (D3) as in flight; it stays the latest, with its check', async () => {
    const checkedAt = at(27).toISOString()
    await scoped(async () => {
      await publication('pub-checked', { account: ids.a, status: 'UNVERIFIED', minute: 26 })
      await prisma.bulkOperation.update({ where: { id: 'pub-checked' }, data: { completedAt: at(27),
        summary: { products: 3, accepted: 0, failed: 0, needsCheck: true, checkedAt, checkedBy: ids.user, checkedNote: null } } as never })
    })
    const status = await read()
    expect(status.inFlight).toBeNull()
    expect(status.latest).toMatchObject({ publicationId: 'pub-checked', status: 'UNVERIFIED', completedAt: checkedAt, summary: { checkedAt, needsCheck: true } })
  })

  it('never reads the stored request or change plan out of the database', async () => {
    state.raw.length = 0
    await read()
    expect(state.raw.length).toBe(2)
    for (const call of state.raw) expect(JSON.stringify(call.result)).not.toContain(MARKER)
    // Every mention of the journal payload is a path into it, never the column itself; the plan column is never named.
    const sql = state.raw.map(call => call.sql).join('\n')
    expect(sql.match(/payload(?!->|,)/g) ?? []).toEqual([])
    expect(sql).not.toMatch(/changes(?!->)/)
  })

  it('a selling change is the row\'s last publish when it is newer: its action, Accepted (never Verified), and a failure keeps its message', async () => {
    await scoped(async () => {
      ids.boot = (await prisma.product.create({ data: { sku: 'BOOT', name: 'Boot', basePrice: 10, isParent: true } as never })).id
      ids.bootS = (await prisma.product.create({ data: { sku: 'BOOT-S', name: 'Boot S', basePrice: 10, parentId: ids.boot } as never })).id
      ids.bootM = (await prisma.product.create({ data: { sku: 'BOOT-M', name: 'Boot M', basePrice: 10, parentId: ids.boot } as never })).id
      for (const [key, productId] of [['boot', ids.boot], ['bootS', ids.bootS], ['bootM', ids.bootM]] as const)
        listing[key] = (await prisma.channelListing.create({ data: { productId, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU',
          channelConnectionId: ids.a } as never })).id
      // A publish that sent BOOT-S as a Full update and BOOT-M as a Partial update…
      await prisma.bulkOperation.create({ data: { id: 'pub-full', userId: ids.user, productCount: 3, changeCount: 3, status: 'VERIFIED',
        changes: { kind: 'studio-publication', plan: { note: MARKER }, fullProductIds: [ids.bootS], result: { id: 'pub-full', status: 'VERIFIED', message: 'ok',
          results: [{ sku: 'BOOT', status: 'VERIFIED' }, { sku: 'BOOT-S', status: 'VERIFIED' }, { sku: 'BOOT-M', status: 'VERIFIED' }] } },
        kind: 'studio-publication', productId: ids.boot, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: ids.a, aliasKey: '',
        submittedAt: at(2), createdAt: at(2) } as never })
      for (const [key, sku] of [['boot', 'BOOT'], ['bootS', 'BOOT-S'], ['bootM', 'BOOT-M']] as const)
        await journal(listing[key], 'pub-full', { sku, account: ids.a, minute: 2, outcome: 'ACCEPTED', fields: ['item_name'] })
      // …then BOOT-S paused (accepted) and BOOT-M's delete refused, as the listing-action engine records them.
      const selling = async (id: string, status: string, minute: number, rows: Array<{ key: string; sku: string; action: string; outcome: string; message: string }>) => {
        await prisma.bulkOperation.create({ data: { id, userId: ids.user, productCount: rows.length, changeCount: rows.length, status, kind: 'listing-action',
          productId: ids.boot, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: ids.a, aliasKey: '', submittedAt: at(minute), completedAt: at(minute), createdAt: at(minute - 1),
          changes: { kind: 'listing-action', action: rows[0].action, preview: { note: MARKER } } } as never })
        for (const row of rows) await prisma.channelListingSnapshot.create({ data: {
          channelListingId: listing[row.key], channel: 'AMAZON', marketplace: 'IT', aliasKey: '', reason: row.action, publishEventId: id,
          outcome: row.outcome === 'DONE' ? 'ACCEPTED' : 'FAILED', acceptedAt: row.outcome === 'DONE' ? at(minute) : null, createdAt: at(minute),
          payload: { kind: 'listing-action', action: row.action, sku: row.sku, outcome: row.outcome, message: row.message, evidence: { raw: MARKER } },
        } as never })
      }
      await selling('la-pause', 'DONE', 4, [{ key: 'bootS', sku: 'BOOT-S', action: 'pause', outcome: 'DONE', message: 'Paused on Amazon · IT.' }])
      await selling('la-delete', 'FAILED', 6, [{ key: 'bootM', sku: 'BOOT-M', action: 'delete', outcome: 'FAILED', message: 'Amazon refused the delete: the listing is locked.' }])
      // A snapshot of another kind (a restore point) never counts as a publish.
      await prisma.channelListingSnapshot.create({ data: { channelListingId: listing.boot, channel: 'AMAZON', marketplace: 'IT', aliasKey: '', reason: 'pause',
        publishEventId: 'la-pause', outcome: 'ACCEPTED', createdAt: at(8), payload: { kind: 'something-else' } } as never })
    })
    state.raw.length = 0
    const status = await scoped(() => readPublicationStatus({ productId: ids.bootS, channel: 'AMAZON', marketplace: 'IT', accountId: ids.a }, at(30)))
    expect(state.raw.length).toBe(2)
    for (const call of state.raw) expect(JSON.stringify(call.result)).not.toContain(MARKER)
    expect(rowOf(status, ids.bootS).last).toEqual({ publicationId: 'la-pause', status: 'ACCEPTED', outcome: 'ACCEPTED', at: at(4).toISOString(),
      userName: 'Publisher Person', message: 'Paused on Amazon · IT.', reference: null, sentFields: [], issues: [], kind: 'pause' })
    expect(rowOf(status, ids.bootM).last).toEqual({ publicationId: 'la-delete', status: 'FAILED', outcome: 'FAILED', at: at(6).toISOString(),
      userName: 'Publisher Person', message: 'Amazon refused the delete: the listing is locked.', reference: null, sentFields: [], issues: [], kind: 'delete' })
    // The parent's newest real record is still the publish; a row sent as a Full update says so.
    expect(rowOf(status, ids.boot).last).toMatchObject({ publicationId: 'pub-full', kind: 'publish', outcome: 'VERIFIED' })
    await scoped(() => prisma.channelListingSnapshot.deleteMany({ where: { publishEventId: 'la-pause' } }))
    const before = await scoped(() => readPublicationStatus({ productId: ids.bootS, channel: 'AMAZON', marketplace: 'IT', accountId: ids.a }, at(30)))
    expect(rowOf(before, ids.bootS).last).toMatchObject({ publicationId: 'pub-full', kind: 'full_update', outcome: 'VERIFIED', sentFields: ['item_name'] })
  })

  it('refuses a read without a channel or account, or for a missing product', async () => {
    await expect(scoped(() => readPublicationStatus({ productId: ids.s, channel: '', marketplace: 'IT', accountId: ids.a }))).rejects.toThrow('Choose the channel.')
    await expect(scoped(() => readPublicationStatus({ productId: ids.s, channel: 'AMAZON', marketplace: 'IT' }))).rejects.toThrow('Choose the connected account.')
    await expect(scoped(() => readPublicationStatus({ productId: 'no-such-product', channel: 'AMAZON', marketplace: 'IT', accountId: ids.a }))).rejects.toThrow('This product is unavailable.')
  })
})
