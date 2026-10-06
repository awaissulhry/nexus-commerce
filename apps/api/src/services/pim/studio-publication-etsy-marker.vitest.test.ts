/**
 * E3 — the "creating" marker of a new Etsy listing (`studio-publication-etsy-marker.ts`): claimed in one locked step
 * before the POST, kept as unknown, released, turned into the listing link (the go-live write of a create), and resolved
 * by a person's Mark as checked (the draft search). The database is an in-memory stand-in that applies each statement's
 * effect (its SQL is asserted too); the real statements run on PostgreSQL in studio-publication-check.vitest.test.ts.
 * Etsy is stubbed (`../live-read/etsy.js`). Fake ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = { id: string; channel: string; productId: string; marketplace: string; channelConnectionId: string; aliasKey: string
  externalListingId: string | null; platformAttributes: any; version: number; listingStatus: string; isPublished: boolean; syncPaused: boolean }
const h = vi.hoisted(() => ({
  rows: [] as any[],
  publications: new Map<string, any>(),
  sql: [] as Array<{ text: string; values: unknown[]; inTransaction: boolean }>,
  inTransaction: false,
  drafts: vi.fn(),
  listingPlain: vi.fn(),
  shop: vi.fn(),
  /** E3 round 2 (N1) — the accepted `unlink` snapshot a person's Listing ID unlink leaves, or null. */
  unlink: vi.fn(),
}))

/** The subset of Prisma's `where` this module uses. */
function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, condition]: [string, any]) => {
    if (key === 'NOT') return !matches(row, condition)
    if (condition === null) return row[key] === null
    if (condition && typeof condition === 'object' && 'in' in condition) return condition.in.includes(row[key])
    if (condition && typeof condition === 'object' && 'not' in condition) return row[key] !== condition.not
    return row[key] === condition
  })
}
const pick = (row: any, select?: Record<string, boolean>) => select ? Object.fromEntries(Object.keys(select).map(key => [key, structuredClone(row[key])])) : structuredClone(row)

vi.mock('../../db.js', () => {
  const mainOf = (values: unknown[]) => {
    const [productId, marketplace, account, alias] = values
    return h.rows.find(row => row.channel === 'ETSY' && row.productId === productId && row.marketplace === marketplace && row.channelConnectionId === account && row.aliasKey === alias)
  }
  const raw = (strings: TemplateStringsArray, values: unknown[]) => {
    const text = strings.join('$?').replace(/\s+/g, ' ').trim()
    h.sql.push({ text, values, inTransaction: h.inTransaction })
    return text
  }
  const db: any = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = raw(strings, values)
      if (!/FOR UPDATE$/.test(text)) throw new Error(`unexpected query: ${text}`)
      const row = mainOf(values)
      return row ? [{ id: row.id, externalListingId: row.externalListingId, platformAttributes: structuredClone(row.platformAttributes) }] : []
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = raw(strings, values)
      const bump = (row: any) => { row.version += 1 }
      if (text.includes("jsonb_build_object('_etsyCreate'")) {
        const row = h.rows.find(r => r.id === values[1])
        if (!row) return 0
        row.platformAttributes = { ...(row.platformAttributes ?? {}), _etsyCreate: JSON.parse(String(values[0])) }; bump(row)
        return 1
      }
      if (text.includes('jsonb_set')) {
        const row = mainOf(values.slice(1, 5))
        if (!row || row.platformAttributes?._etsyCreate?.reviewId !== values[5]) return 0
        row.platformAttributes = { ...row.platformAttributes, _etsyCreate: { ...row.platformAttributes._etsyCreate, ...JSON.parse(String(values[0])) } }; bump(row)
        return 1
      }
      if (text.includes("- '_etsyCreate'")) {
        const byId = text.includes('WHERE id =')
        const row = byId ? h.rows.find(r => r.id === values[0]) : mainOf(values.slice(0, 4))
        const reviewId = values[values.length - 1]
        if (!row || row.platformAttributes?._etsyCreate?.reviewId !== reviewId) return 0
        const { _etsyCreate, ...rest } = row.platformAttributes
        row.platformAttributes = rest; bump(row)
        return 1
      }
      throw new Error(`unexpected statement: ${text}`)
    },
    channelListing: {
      findFirst: async ({ where, select }: any) => { const row = h.rows.find(r => matches(r, where)); return row ? pick(row, select) : null },
      findMany: async ({ where, select }: any) => h.rows.filter(r => matches(r, where)).map(r => pick(r, select)),
      updateMany: async ({ where, data }: any) => {
        const hits = h.rows.filter(r => matches(r, where))
        for (const row of hits) for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in (value as any) ? row[key] + (value as any).increment : value
        return { count: hits.length }
      },
    },
    bulkOperation: { findFirst: async ({ where, select }: any) => { const row = h.publications.get(where.id); return row ? pick(row, select) : null } },
    channelListingSnapshot: { findFirst: h.unlink },
    $transaction: async (work: (tx: any) => Promise<unknown>) => {
      // All or nothing, as PostgreSQL does: a throw puts every row back.
      const before = structuredClone(h.rows)
      h.inTransaction = true
      try { return await work(db) } catch (error) { h.rows.splice(0, h.rows.length, ...before); throw error } finally { h.inTransaction = false }
    },
  }
  return { default: db }
})
vi.mock('../live-read/etsy.js', () => ({
  findEtsyDrafts: h.drafts,
  etsyListingReads: vi.fn(() => ({ listingPlain: h.listingPlain, shop: h.shop })),
}))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { EtsyReadError } from '../etsy/read-client.js'
import { WorkspaceScopeError } from './workspace-destination.js'
import {
  claimEtsyCreate, ETSY_CREATE_OPEN, etsyCreateMarkerOf, markEtsyCreateUnknown, openEtsyCreateMarker, releaseEtsyCreate, resolveEtsyCreateOnCheck,
  storeEtsyCreatedListing, type EtsyCreateMarker, type EtsyCreateWhere,
} from './studio-publication-etsy-marker.js'

const LISTING = '9000000001'
const where: EtsyCreateWhere = { marketplace: 'GLOBAL', accountId: 'etsy-account-1', aliasKey: '', ownerProductId: 'family' }
const row = (id: string, productId: string, over: Partial<Row> = {}): Row => ({ id, channel: 'ETSY', productId, marketplace: 'GLOBAL', channelConnectionId: 'etsy-account-1',
  aliasKey: '', externalListingId: null, platformAttributes: { _etsyInformationLocales: ['it'] }, version: 1, listingStatus: 'DRAFT', isPublished: false, syncPaused: true, ...over })
const marker = (over: Partial<EtsyCreateMarker> = {}): EtsyCreateMarker => ({ v: 1, state: 'creating', reviewId: 'pub-create', startedAt: '2026-10-05T18:00:00.000Z',
  title: 'Guanti da moto', skus: ['FAKE-SKU-1', 'FAKE-SKU-2'], userId: 'user-1', ...over })
const publication = (id: string, status: string, over: Record<string, unknown> = {}) =>
  h.publications.set(id, { id, status, productId: 'family', channel: 'ETSY', marketplace: 'GLOBAL', channelConnectionId: 'etsy-account-1', aliasKey: '', ...over })
const main = () => h.rows.find(r => r.id === 'listing-family')!
const withMarker = (over: Partial<EtsyCreateMarker> = {}) => { main().platformAttributes = { ...main().platformAttributes, _etsyCreate: marker(over) } }
const writes = () => h.sql.filter(s => !s.text.startsWith('SELECT'))

beforeEach(() => {
  vi.clearAllMocks()
  h.unlink.mockReset().mockResolvedValue(null)
  h.sql = []; h.publications.clear()
  h.rows = [row('listing-family', 'family'), row('listing-1', 'child-1'), row('listing-2', 'child-2'),
    // Another business's rows are hidden by row-level security; another destination of this account is not this listing.
    row('listing-other-market', 'family', { marketplace: 'IT' })]
})

describe('etsyCreateMarkerOf — pure', () => {
  it('reads a marker Nexus wrote, and nothing else', () => {
    expect(etsyCreateMarkerOf({ _etsyCreate: marker() })).toEqual(marker())
    expect(etsyCreateMarkerOf(JSON.stringify({ _etsyCreate: marker({ state: 'unknown', listingId: LISTING, message: 'No answer' }) })))
      .toEqual(marker({ state: 'unknown', listingId: LISTING, message: 'No answer' }))
    for (const bad of [null, undefined, 'x', [], {}, { _etsyCreate: null }, { _etsyCreate: { ...marker(), v: 2 } }, { _etsyCreate: { ...marker(), state: 'done' } },
      { _etsyCreate: { ...marker(), reviewId: '' } }, { _etsyCreate: { ...marker(), startedAt: 'soon' } }, { _etsyCreate: { ...marker(), skus: [1] } },
      { _etsyCreate: { ...marker(), listingId: '12x' } }, { _etsyCreate: { ...marker(), userId: 5 } }])
      expect(etsyCreateMarkerOf(bad)).toBeNull()
  })
})

describe('claimEtsyCreate — one locked step before the POST', () => {
  it('locks the main row (FOR UPDATE, this destination exactly) and writes the marker with a version bump, in one transaction', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-05T18:00:00Z'))
    try {
      await claimEtsyCreate(where, { reviewId: 'pub-create', title: 'Guanti da moto', skus: ['FAKE-SKU-1', 'FAKE-SKU-2'], userId: 'user-1' })
    } finally { vi.useRealTimers() }
    expect(main().platformAttributes).toEqual({ _etsyInformationLocales: ['it'], _etsyCreate: marker() })
    expect(main().version).toBe(2)
    expect(h.rows.find(r => r.id === 'listing-other-market')!.platformAttributes).not.toHaveProperty('_etsyCreate')
    const [lock, update] = h.sql
    expect(lock).toMatchObject({ inTransaction: true, values: ['family', 'GLOBAL', 'etsy-account-1', ''] })
    expect(lock.text).toMatch(/^SELECT id, "externalListingId", "platformAttributes" FROM "ChannelListing" WHERE channel = 'ETSY' AND "productId" = \$\? .* FOR UPDATE$/)
    expect(update.inTransaction).toBe(true)
    // NIT-1: a bag that is not an object (SQL NULL, or a JSON null) starts as {}; the marker never turns it into an array.
    expect(update.text).toContain(`SET "platformAttributes" = (CASE WHEN jsonb_typeof("platformAttributes") = 'object' THEN "platformAttributes" ELSE '{}'::jsonb END) || jsonb_build_object('_etsyCreate', $?::jsonb), "version" = "version" + 1`)
    expect(JSON.parse(String(update.values[0]))).toEqual(marker())
  })

  it('refuses a row with a listing id, a missing row and an unreadable bag — nothing written, every sentence says "Nothing was sent."', async () => {
    main().externalListingId = LISTING
    await expect(claimEtsyCreate(where, { reviewId: 'pub-create', title: 'T', skus: [], userId: null })).rejects.toThrow('This Etsy listing already has a listing number in Nexus. Review again. Nothing was sent.')
    main().externalListingId = null; main().platformAttributes = ['not', 'a', 'bag']
    await expect(claimEtsyCreate(where, { reviewId: 'pub-create', title: 'T', skus: [], userId: null })).rejects.toThrow(/cannot be read.*Nothing was sent\.$/)
    await expect(claimEtsyCreate({ ...where, ownerProductId: 'nobody' }, { reviewId: 'pub-create', title: 'T', skus: [], userId: null }))
      .rejects.toThrow('The main row of this Etsy listing has no listing record here. Nothing was sent.')
    await expect(claimEtsyCreate(where, { reviewId: '', title: 'T', skus: [], userId: null })).rejects.toThrow(/Nothing was sent\.$/)
    expect(writes()).toEqual([])
  })

  it('🔴 refuses while another create of this listing is open: being sent now, or unknown since its start (with its time)', async () => {
    withMarker({ reviewId: 'pub-earlier' })
    publication('pub-earlier', 'PUBLISHING')
    await expect(claimEtsyCreate(where, { reviewId: 'pub-create', title: 'T', skus: [], userId: null }))
      .rejects.toThrow('A create of this Etsy listing is being sent now. Wait for its result before you publish again. Nothing was sent.')
    for (const status of ['UNVERIFIED', 'SUBMITTED', 'VERIFIED']) {
      publication('pub-earlier', status)
      await expect(claimEtsyCreate(where, { reviewId: 'pub-create', title: 'T', skus: [], userId: null }))
        .rejects.toThrow('A create of this Etsy listing started on 2026-10-05 18:00 UTC and Nexus did not see Etsy\'s answer')
    }
    // A marker whose publish this business cannot find still stands (the safe side).
    h.publications.clear()
    await expect(claimEtsyCreate(where, { reviewId: 'pub-create', title: 'T', skus: [], userId: null })).rejects.toThrow('Nothing was sent.')
    expect(writes()).toEqual([])
    expect(main().platformAttributes._etsyCreate.reviewId).toBe('pub-earlier')
  })

  it.each([
    ['its publish FAILED (nothing reached Etsy)', 'FAILED', {}],
    ['its publish was never sent (PREVIEW)', 'PREVIEW', {}],
    ['a copied bag: its publish is another product\'s', 'UNVERIFIED', { productId: 'other-family' }],
    ['a copied bag: another alias', 'UNVERIFIED', { aliasKey: 'alias-2' }],
    ['a copied bag: another account', 'UNVERIFIED', { channelConnectionId: 'etsy-account-2' }],
    ['a copied bag: another market', 'UNVERIFIED', { marketplace: 'IT' }],
    ['a copied bag: another channel', 'UNVERIFIED', { channel: 'EBAY' }],
  ])('a stale marker — %s — is overwritten', async (_name, status, over) => {
    withMarker({ reviewId: 'pub-stale' })
    publication('pub-stale', status, over)
    await claimEtsyCreate(where, { reviewId: 'pub-create', title: 'Guanti da moto', skus: ['FAKE-SKU-1'], userId: null })
    expect(main().platformAttributes._etsyCreate).toMatchObject({ reviewId: 'pub-create', state: 'creating', userId: null, skus: ['FAKE-SKU-1'] })
  })
})

describe('openEtsyCreateMarker and ETSY_CREATE_OPEN — the review\'s rule', () => {
  it('null without a marker, for a row that has a listing id, or a stale marker; sending while its publish is PUBLISHING', async () => {
    expect(await openEtsyCreateMarker(where, undefined)).toBeNull()
    expect(await openEtsyCreateMarker(where, { platformAttributes: {} })).toBeNull()
    expect(await openEtsyCreateMarker(where, { platformAttributes: { _etsyCreate: marker() }, externalListingId: LISTING })).toBeNull()
    publication('pub-create', 'FAILED')
    expect(await openEtsyCreateMarker(where, { platformAttributes: { _etsyCreate: marker() } })).toBeNull()
    publication('pub-create', 'PUBLISHING')
    expect(await openEtsyCreateMarker(where, { platformAttributes: { _etsyCreate: marker() } })).toEqual({ marker: marker(), sending: true })
    publication('pub-create', 'UNVERIFIED')
    const open = await openEtsyCreateMarker(where, { platformAttributes: { _etsyCreate: marker() } })
    expect(open).toEqual({ marker: marker(), sending: false })
    expect(ETSY_CREATE_OPEN(open!)).toBe('A create of this Etsy listing started on 2026-10-05 18:00 UTC and Nexus did not see Etsy\'s answer, so Etsy may already hold it as a draft. '
      + 'Nexus will not create a second one: in Publish history, open that publish and choose Mark as checked — Nexus first looks for the draft on Etsy and links it.')
    // Etsy's answer was seen (its listing id kept): the sentence names that listing instead of "did not see Etsy's answer".
    const known = ETSY_CREATE_OPEN({ marker: { ...marker(), state: 'unknown', listingId: '9000000007' } as never, sending: false })
    expect(known).toContain('Etsy answered with listing 9000000007, but Nexus did not finish recording it.')
    expect(known).not.toContain("did not see Etsy's answer")
  })
})

describe('markEtsyCreateUnknown and releaseEtsyCreate — only their own publish\'s marker', () => {
  it('unknown keeps the marker, as unknown, with why and Etsy\'s id; another publish\'s marker is never touched (and says so)', async () => {
    withMarker()
    await markEtsyCreateUnknown(where, 'pub-create', 'Etsy did not answer', LISTING)
    expect(main().platformAttributes._etsyCreate).toEqual(marker({ state: 'unknown', message: 'Etsy did not answer', listingId: LISTING }))
    expect(main().version).toBe(2)
    expect(writes()[0].text).toContain(`"platformAttributes"->'_etsyCreate'->>'reviewId' = $?`)
    await markEtsyCreateUnknown(where, 'pub-create', 'Still no answer')
    expect(main().platformAttributes._etsyCreate).toMatchObject({ state: 'unknown', message: 'Still no answer', listingId: LISTING })
    await expect(markEtsyCreateUnknown(where, 'pub-other', 'x')).rejects.toThrow('not on the main row')
    expect(main().platformAttributes._etsyCreate.message).toBe('Still no answer')
  })

  it('release removes only this publish\'s marker (other keys of the bag kept); a repeat or another publish changes nothing', async () => {
    withMarker()
    await releaseEtsyCreate(where, 'pub-other')
    expect(main().platformAttributes._etsyCreate).toBeDefined()
    await releaseEtsyCreate(where, 'pub-create')
    expect(main().platformAttributes).toEqual({ _etsyInformationLocales: ['it'] })
    expect(main().version).toBe(2)
    await releaseEtsyCreate(where, 'pub-create')
    expect(main().version).toBe(2)
  })
})

describe('storeEtsyCreatedListing — the go-live write of a create', () => {
  const store = (over: Partial<{ reviewId: string; productIds: string[]; listingId: string }> = {}) =>
    storeEtsyCreatedListing(where, { reviewId: 'pub-create', productIds: ['family', 'child-1', 'child-2'], listingId: LISTING, ...over })

  it('every delivered row of this destination: the listing id, DRAFT, unpublished, paused, version + 1; the marker removed; in one transaction', async () => {
    withMarker()
    h.rows.forEach(r => { r.isPublished = true; r.syncPaused = false })
    expect(await store()).toBe(3)
    for (const id of ['listing-family', 'listing-1', 'listing-2'])
      expect(h.rows.find(r => r.id === id)).toMatchObject({ externalListingId: LISTING, listingStatus: 'DRAFT', isPublished: false, syncPaused: true })
    expect(main().platformAttributes).toEqual({ _etsyInformationLocales: ['it'] })
    expect(main().version).toBe(3)
    expect(h.rows.find(r => r.id === 'listing-1')!.version).toBe(2)
    // Another market of this product is another listing: untouched.
    expect(h.rows.find(r => r.id === 'listing-other-market')).toMatchObject({ externalListingId: null, isPublished: true })
    expect(h.sql.every(s => s.inTransaction)).toBe(true)
  })

  it('🔴 refuses an id another row of this account holds — nothing written, the marker kept', async () => {
    withMarker()
    h.rows.push(row('listing-elsewhere', 'other-product', { externalListingId: LISTING }))
    await expect(store()).rejects.toThrow(`Etsy listing ${LISTING} is already linked to another product in Nexus; Nexus did not link it again.`)
    expect(h.rows.filter(r => r.externalListingId === LISTING).map(r => r.id)).toEqual(['listing-elsewhere'])
    expect(main().platformAttributes._etsyCreate).toEqual(marker())
    // The same product at another market holding it is "another" too.
    h.rows.pop(); h.rows.find(r => r.id === 'listing-other-market')!.externalListingId = LISTING
    await expect(store()).rejects.toThrow('already linked to another product')
  })

  it('refuses to split a family across listings, a main row that holds another id, and a marker that is not this publish\'s', async () => {
    withMarker()
    h.rows.find(r => r.id === 'listing-2')!.externalListingId = '9000000002'
    await expect(store()).rejects.toThrow('A product of this family is already on Etsy listing 9000000002')
    h.rows.find(r => r.id === 'listing-2')!.externalListingId = null
    main().externalListingId = '9000000002'
    await expect(store()).rejects.toThrow('already has listing number 9000000002')
    main().externalListingId = null
    await expect(store({ reviewId: 'pub-other' })).rejects.toThrow('Another create (publish pub-create) is recorded on this Etsy listing')
    await expect(store({ listingId: '12x' })).rejects.toThrow('not an Etsy listing number')
    expect(h.rows.every(r => r.externalListingId === null)).toBe(true)
    expect(main().platformAttributes._etsyCreate).toEqual(marker())
  })

  it('a repeat of a link that already happened writes nothing and returns 0 (a second Mark as checked at the same time)', async () => {
    withMarker()
    await store()
    const versions = h.rows.map(r => r.version)
    expect(await store()).toBe(0)
    expect(h.rows.map(r => r.version)).toEqual(versions)
  })

  it('the owner (main) row is always linked, even when the delivery did not name it', async () => {
    withMarker()
    expect(await store({ productIds: ['child-1'] })).toBe(2)
    expect(main().externalListingId).toBe(LISTING)
    expect(h.rows.find(r => r.id === 'listing-2')!.externalListingId).toBeNull()
  })
})

describe('resolveEtsyCreateOnCheck — Mark as checked on a create whose answer was lost', () => {
  const data = (over: Record<string, unknown> = {}) => ({ kind: 'studio-publication', productId: 'family', etsyCreate: true,
    scope: { channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'etsy-account-1' }, delivery: { productIds: ['family', 'child-1', 'child-2'], aliasKey: '' },
    changePlan: { publication: { ownerProductId: 'family' } }, ...over })
  const draft = (listingId: string) => ({ listingId, title: 'Guanti da moto', createdAt: '2026-10-05T18:00:05.000Z' })
  /** The marker's create started 2026-10-05 18:00 UTC: one minute later Etsy may still be finishing it; sixteen minutes later not. */
  const EARLY = new Date('2026-10-05T18:01:00Z')
  const LATE = new Date('2026-10-05T18:16:00Z')

  it('null for anything that is not an Etsy create holding THIS publication\'s marker (nothing read from Etsy)', async () => {
    withMarker()
    expect(await resolveEtsyCreateOnCheck('pub-create', data({ scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'ebay-1' } }))).toBeNull()
    expect(await resolveEtsyCreateOnCheck('pub-create', data({ etsyCreate: false }))).toBeNull()
    expect(await resolveEtsyCreateOnCheck('pub-other', data())).toBeNull()
    main().platformAttributes = {}
    expect(await resolveEtsyCreateOnCheck('pub-create', data())).toBeNull()
    expect(h.drafts).not.toHaveBeenCalled()
  })

  it('one matching draft → linked on every delivered row, the marker removed, and the note says so', async () => {
    withMarker()
    h.drafts.mockResolvedValue([draft(LISTING)])
    expect(await resolveEtsyCreateOnCheck('pub-create', data())).toBe(`Nexus found the draft on Etsy (listing ${LISTING}) and linked it to this family; the next Publish sends what it still lacks.`)
    expect(h.drafts).toHaveBeenCalledWith('etsy-account-1', { title: 'Guanti da moto', since: '2026-10-05T18:00:00.000Z', skus: ['FAKE-SKU-1', 'FAKE-SKU-2'] })
    expect(h.rows.filter(r => r.externalListingId === LISTING).map(r => r.id).sort()).toEqual(['listing-1', 'listing-2', 'listing-family'])
    expect(main().platformAttributes._etsyCreate).toBeUndefined()
  })

  it('none → the marker is cleared (the next Publish creates the draft); nothing linked', async () => {
    withMarker()
    h.drafts.mockResolvedValue([])
    expect(await resolveEtsyCreateOnCheck('pub-create', data(), LATE)).toBe('Nexus looked in this shop\'s Etsy drafts and found none from this publish, so the next Publish creates the draft.')
    expect(main().platformAttributes._etsyCreate).toBeUndefined()
    expect(h.rows.every(r => r.externalListingId === null)).toBe(true)
  })

  it('several → a 409 naming them; Etsy unreadable → a 409; in both the marker stays and nothing is linked', async () => {
    withMarker()
    h.drafts.mockResolvedValue([draft(LISTING), draft('9000000002')])
    const several = await resolveEtsyCreateOnCheck('pub-create', data()).catch((error: unknown) => error)
    expect(several).toBeInstanceOf(WorkspaceScopeError)
    expect(several).toMatchObject({ statusCode: 409, message: `Etsy holds 2 drafts that match this publish (listings ${LISTING}, 9000000002). Delete the extra ones on Etsy, then mark this publication checked again; Nexus then links the one left.` })
    h.drafts.mockRejectedValue(new Error('Etsy could not read this resource (HTTP 503).'))
    await expect(resolveEtsyCreateOnCheck('pub-create', data())).rejects.toMatchObject({ statusCode: 409,
      message: 'Nexus could not look for the draft on Etsy (Etsy could not read this resource (HTTP 503).), so it cannot tell whether Etsy holds one. Try again in a while.' })
    expect(main().platformAttributes._etsyCreate).toEqual(marker())
    expect(h.rows.every(r => r.externalListingId === null)).toBe(true)
  })

  it('a link Nexus refuses (the id Etsy answered is already another product\'s) is a 409 too: the publication stays open', async () => {
    withMarker({ state: 'unknown', listingId: LISTING })
    h.rows.push(row('listing-elsewhere', 'other-product', { externalListingId: LISTING }))
    h.listingPlain.mockResolvedValue({ listing_id: 9000000001, shop_id: 90000001, state: 'draft' })
    h.shop.mockResolvedValue({ shop_id: 90000001 })
    await expect(resolveEtsyCreateOnCheck('pub-create', data())).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('already linked to another product') })
    expect(main().platformAttributes._etsyCreate).toEqual(marker({ state: 'unknown', listingId: LISTING }))
  })

  it('the marker kept Etsy\'s id → the listing must read back as this shop\'s → linked (no draft search)', async () => {
    withMarker({ state: 'unknown', listingId: LISTING, message: 'Etsy created listing, but Nexus could not record it' })
    h.listingPlain.mockResolvedValue({ listing_id: 9000000001, shop_id: 90000001, state: 'draft' })
    h.shop.mockResolvedValue({ shop_id: 90000001 })
    expect(await resolveEtsyCreateOnCheck('pub-create', data())).toBe(`Nexus linked Etsy listing ${LISTING} (the draft this publish created) to this family; the next Publish sends what it still lacks.`)
    expect(h.listingPlain).toHaveBeenCalledWith(LISTING)
    expect(h.drafts).not.toHaveBeenCalled()
    expect(main().externalListingId).toBe(LISTING)
  })

  it('the kept id: another shop\'s (or no shop said) → 409, nothing linked; a read failure → 409; Etsy no longer holds it (404) → the marker is cleared', async () => {
    withMarker({ state: 'unknown', listingId: LISTING })
    h.shop.mockResolvedValue({ shop_id: 90000001 })
    for (const answer of [{ listing_id: 9000000001, shop_id: 90000099 }, { listing_id: 9000000001 }, { listing_id: 9000000002, shop_id: 90000001 }]) {
      h.listingPlain.mockResolvedValue(answer)
      await expect(resolveEtsyCreateOnCheck('pub-create', data())).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('is in this shop') })
    }
    h.listingPlain.mockRejectedValue(new EtsyReadError(503))
    await expect(resolveEtsyCreateOnCheck('pub-create', data())).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('could not look for the draft') })
    expect(main().externalListingId).toBeNull()
    expect(main().platformAttributes._etsyCreate.listingId).toBe(LISTING)
    h.listingPlain.mockRejectedValue(new EtsyReadError(404))
    expect(await resolveEtsyCreateOnCheck('pub-create', data(), LATE)).toBe(`Etsy no longer holds listing ${LISTING} (the draft this publish created), so Nexus linked nothing; the next Publish creates the draft.`)
    expect(main().platformAttributes._etsyCreate).toBeUndefined()
    expect(main().externalListingId).toBeNull()
  })
})

describe('E3 review fixes — Mark as checked never makes a duplicate, never takes an alias\'s draft, never loses Etsy\'s id', () => {
  const data = (over: Record<string, unknown> = {}) => ({ kind: 'studio-publication', productId: 'family', etsyCreate: true, startedAt: '2026-10-05T18:00:00.000Z',
    scope: { channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'etsy-account-1' }, delivery: { productIds: ['family', 'child-1', 'child-2'], aliasKey: '' },
    changePlan: { publication: { ownerProductId: 'family' } }, ...over })
  const draft = (listingId: string) => ({ listingId, title: 'Guanti da moto', createdAt: '2026-10-05T18:00:05.000Z' })
  const EARLY = new Date('2026-10-05T18:01:00Z')
  const LATE = new Date('2026-10-05T18:16:00Z')
  const WAIT = 'Etsy may still be finishing this create. Check again after 18:15 UTC.'
  const linkedIds = () => h.rows.filter(r => r.aliasKey === '' && r.marketplace === 'GLOBAL').map(r => r.externalListingId)
  /** The create Etsy answered with an id Nexus could not store: the stored result names it (results SUBMITTED with the reference). */
  const answeredResult = (reference: string) => ({ result: { id: 'pub-create', status: 'UNVERIFIED', message: 'Etsy created draft listing',
    results: [{ sku: 'FAKE-SKU-1', status: 'SUBMITTED', reference }, { sku: 'FAKE-SKU-2', status: 'SUBMITTED', reference }] } })

  describe('MAJOR-1 — the marker is cleared only 15 minutes after the create started', () => {
    it('an empty draft search 1 minute in → 409 with the time to check again, the marker stays; 16 minutes in → cleared', async () => {
      withMarker()
      h.drafts.mockResolvedValue([])
      await expect(resolveEtsyCreateOnCheck('pub-create', data(), EARLY)).rejects.toMatchObject({ statusCode: 409,
        message: `Nexus found no draft from this publish in this shop's Etsy drafts yet. ${WAIT}` })
      expect(main().platformAttributes._etsyCreate).toEqual(marker())
      expect(await resolveEtsyCreateOnCheck('pub-create', data(), LATE)).toContain('found none from this publish')
      expect(main().platformAttributes._etsyCreate).toBeUndefined()
    })

    it('a 404 for the id Etsy answered, 1 minute in → 409, the marker (and its id) stays; 16 minutes in → cleared', async () => {
      withMarker({ state: 'unknown', listingId: LISTING })
      h.listingPlain.mockRejectedValue(new EtsyReadError(404))
      h.shop.mockResolvedValue({ shop_id: 90000001 })
      await expect(resolveEtsyCreateOnCheck('pub-create', data(), EARLY)).rejects.toMatchObject({ statusCode: 409,
        message: `Etsy does not show listing ${LISTING} right now: it may still be finishing, or it was deleted on Etsy. Check again after 18:15 UTC.` })
      expect(main().platformAttributes._etsyCreate.listingId).toBe(LISTING)
      expect(await resolveEtsyCreateOnCheck('pub-create', data(), LATE)).toContain(`Etsy no longer holds listing ${LISTING}`)
      expect(main().platformAttributes._etsyCreate).toBeUndefined()
    })

    it('a draft that IS found is linked at once (no wait)', async () => {
      withMarker()
      h.drafts.mockResolvedValue([draft(LISTING)])
      expect(await resolveEtsyCreateOnCheck('pub-create', data(), EARLY)).toContain(`listing ${LISTING}`)
      expect(main().externalListingId).toBe(LISTING)
    })
  })

  describe('MAJOR-2 — a draft another Nexus row of this account holds is never counted, linked or named', () => {
    beforeEach(() => {
      // Alias ALT1 of the same product, created seconds earlier with the same title and SKUs: its draft is listing 9000000003.
      h.rows.push(row('listing-alt1', 'family', { aliasKey: 'ALT1', externalListingId: '9000000003' }))
    })

    it('the alias\'s draft is the only match → "none" (after the wait), the marker cleared, the alias untouched', async () => {
      withMarker()
      h.drafts.mockResolvedValue([draft('9000000003')])
      await expect(resolveEtsyCreateOnCheck('pub-create', data(), EARLY)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining(WAIT) })
      expect(await resolveEtsyCreateOnCheck('pub-create', data(), LATE)).toContain('found none from this publish')
      expect(linkedIds()).toEqual([null, null, null])
      expect(h.rows.find(r => r.id === 'listing-alt1')).toMatchObject({ externalListingId: '9000000003', aliasKey: 'ALT1' })
    })

    it('the alias\'s draft and this publish\'s draft → this one is linked ("one", not "several")', async () => {
      withMarker()
      h.drafts.mockResolvedValue([draft('9000000003'), draft(LISTING)])
      expect(await resolveEtsyCreateOnCheck('pub-create', data(), EARLY)).toBe(`Nexus found the draft on Etsy (listing ${LISTING}) and linked it to this family; the next Publish sends what it still lacks.`)
      expect(linkedIds()).toEqual([LISTING, LISTING, LISTING])
    })

    it('"several" never names the alias\'s draft for deletion', async () => {
      withMarker()
      h.drafts.mockResolvedValue([draft('9000000003'), draft(LISTING), draft('9000000002')])
      const refused = await resolveEtsyCreateOnCheck('pub-create', data(), LATE).catch((error: unknown) => error) as Error
      expect(refused.message).toContain(`Etsy holds 2 drafts that match this publish (listings ${LISTING}, 9000000002)`)
      expect(refused.message).not.toContain('9000000003')
    })
  })

  describe('MINOR-1 — Etsy\'s id is never lost when the marker is gone', () => {
    it('landed with the marker gone (a whole-bag writer replaced the bag) still links the id Etsy answered', async () => {
      expect(await storeEtsyCreatedListing(where, { reviewId: 'pub-create', productIds: ['family', 'child-1', 'child-2'], listingId: LISTING })).toBe(3)
      expect(linkedIds()).toEqual([LISTING, LISTING, LISTING])
    })

    it('unknown with the marker gone writes a new unknown marker carrying the id (under the lock, only while the row has no id)', async () => {
      await markEtsyCreateUnknown(where, 'pub-create', 'Etsy created listing, but Nexus could not record it', LISTING)
      expect(main().platformAttributes._etsyCreate).toMatchObject({ v: 1, state: 'unknown', reviewId: 'pub-create', listingId: LISTING, title: '', skus: [],
        message: 'Etsy created listing, but Nexus could not record it' })
      expect(etsyCreateMarkerOf(main().platformAttributes)).not.toBeNull()
      expect(h.sql.find(q => q.text.startsWith('SELECT'))!.inTransaction).toBe(true)
      // ...and Mark as checked links exactly that id.
      h.listingPlain.mockResolvedValue({ listing_id: 9000000001, shop_id: 90000001, state: 'draft' })
      h.shop.mockResolvedValue({ shop_id: 90000001 })
      expect(await resolveEtsyCreateOnCheck('pub-create', data(), EARLY)).toContain(`Nexus linked Etsy listing ${LISTING}`)
      expect(linkedIds()).toEqual([LISTING, LISTING, LISTING])
    })

    it('unknown never puts an id on a row with another id, or over another publish\'s marker; with no id there is nothing to keep', async () => {
      main().externalListingId = '9000000002'
      await expect(markEtsyCreateUnknown(where, 'pub-create', 'x', LISTING)).rejects.toThrow('already has listing number 9000000002')
      main().externalListingId = LISTING
      await expect(markEtsyCreateUnknown(where, 'pub-create', 'x', LISTING)).resolves.toBeUndefined()
      main().externalListingId = null
      withMarker({ reviewId: 'pub-other' })
      await expect(markEtsyCreateUnknown(where, 'pub-create', 'x', LISTING)).rejects.toThrow('Another create (publish pub-other)')
      expect(main().platformAttributes._etsyCreate.reviewId).toBe('pub-other')
      main().platformAttributes = {}
      await expect(markEtsyCreateUnknown(where, 'pub-create', 'x')).rejects.toThrow('not on the main row')
      expect(main().platformAttributes).toEqual({})
    })

    it('no marker at all: the id the stored result names is read back and linked', async () => {
      main().platformAttributes = {}
      h.listingPlain.mockResolvedValue({ listing_id: 9000000001, shop_id: 90000001, state: 'draft' })
      h.shop.mockResolvedValue({ shop_id: 90000001 })
      expect(await resolveEtsyCreateOnCheck('pub-create', data(answeredResult(LISTING)), EARLY)).toContain(`Nexus linked Etsy listing ${LISTING}`)
      expect(h.listingPlain).toHaveBeenCalledWith(LISTING)
      expect(h.drafts).not.toHaveBeenCalled()
      expect(linkedIds()).toEqual([LISTING, LISTING, LISTING])
    })

    it('no marker: a row already on another listing is never relinked (said in the note, nothing written); no id, or two ids, → nothing to do', async () => {
      main().platformAttributes = {}
      main().externalListingId = '9000000002'
      expect(await resolveEtsyCreateOnCheck('pub-create', data(answeredResult(LISTING)), EARLY)).toBe(
        `Etsy created listing ${LISTING} in this publish, but this family is already on Etsy listing 9000000002, so Nexus did not link ${LISTING}. Delete listing ${LISTING} on Etsy if it is not needed.`)
      expect(h.rows.filter(r => r.externalListingId === LISTING)).toEqual([])
      main().externalListingId = LISTING
      expect(await resolveEtsyCreateOnCheck('pub-create', data(answeredResult(LISTING)), EARLY)).toBeNull()
      main().externalListingId = null
      expect(await resolveEtsyCreateOnCheck('pub-create', data(), EARLY)).toBeNull()
      const two = { result: { results: [{ sku: 'FAKE-SKU-1', reference: LISTING }, { sku: 'FAKE-SKU-2', reference: '9000000002' }] } }
      expect(await resolveEtsyCreateOnCheck('pub-create', data(two), EARLY)).toBeNull()
      expect(h.listingPlain).not.toHaveBeenCalled()
    })
  })

  describe('MINOR-2 — the link stores the status Etsy\'s state maps to', () => {
    it.each([['active', 'ACTIVE', true], ['sold_out', 'ACTIVE', true], ['inactive', 'INACTIVE', true], ['draft', 'DRAFT', false]])(
      'Etsy reports %p → %p, isPublished %p, sync paused', async (state, status, published) => {
        withMarker({ state: 'unknown', listingId: LISTING })
        h.listingPlain.mockResolvedValue({ listing_id: 9000000001, shop_id: 90000001, state })
        h.shop.mockResolvedValue({ shop_id: 90000001 })
        const note = await resolveEtsyCreateOnCheck('pub-create', data(), EARLY)
        for (const id of ['listing-family', 'listing-1', 'listing-2'])
          expect(h.rows.find(r => r.id === id)).toMatchObject({ externalListingId: LISTING, listingStatus: status, isPublished: published, syncPaused: true })
        expect(note).toContain(state === 'draft' ? '(the draft this publish created)' : `Etsy now reports it as ${state}`)
      })

    it('Etsy names no state, or one Nexus has no status for → 409 / refused, nothing linked; the draft search links DRAFT', async () => {
      withMarker({ state: 'unknown', listingId: LISTING })
      h.listingPlain.mockResolvedValue({ listing_id: 9000000001, shop_id: 90000001 })
      h.shop.mockResolvedValue({ shop_id: 90000001 })
      await expect(resolveEtsyCreateOnCheck('pub-create', data(), EARLY)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('did not say what state') })
      await expect(storeEtsyCreatedListing(where, { reviewId: 'pub-create', productIds: ['family'], listingId: LISTING, etsyState: 'paused' }))
        .rejects.toThrow('a state Nexus has no status for')
      expect(main().externalListingId).toBeNull()
      withMarker()
      h.drafts.mockResolvedValue([draft(LISTING)])
      await resolveEtsyCreateOnCheck('pub-create', data(), EARLY)
      expect(main()).toMatchObject({ externalListingId: LISTING, listingStatus: 'DRAFT', isPublished: false, syncPaused: true })
    })
  })

  describe('MINOR-3 — an account Nexus cannot use is said as such', () => {
    it('signed out (ConnectionNeedsReauth) or held by the gateway (ACCOUNT_NEEDS_SIGNIN) → a 409 that says to reconnect; the marker stays', async () => {
      withMarker()
      h.drafts.mockRejectedValue(Object.assign(new Error('Connection etsy-account-1 is needs_reauth; writes are paused until the operator reconnects.'), { name: 'ConnectionNeedsReauth' }))
      await expect(resolveEtsyCreateOnCheck('pub-create', data(), LATE)).rejects.toMatchObject({ statusCode: 409,
        message: expect.stringMatching(/^This Etsy account cannot be used in Nexus right now \(.*needs_reauth.*\), so Nexus cannot look for the draft on Etsy\. Reconnect the account, then mark this publication checked again\.$/) })
      withMarker({ state: 'unknown', listingId: LISTING })
      h.listingPlain.mockRejectedValue(Object.assign(new Error('Held, nothing sent: the Etsy account needs to be reconnected (revoked).'), { name: 'GatewayRefusal', code: 'ACCOUNT_NEEDS_SIGNIN' }))
      h.shop.mockResolvedValue({ shop_id: 90000001 })
      await expect(resolveEtsyCreateOnCheck('pub-create', data(), LATE)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('Reconnect the account') })
      expect(main().platformAttributes._etsyCreate).toBeDefined()
    })
  })
})

describe('E3 review round 2', () => {
  const data = (over: Record<string, unknown> = {}) => ({ kind: 'studio-publication', productId: 'family', etsyCreate: true, startedAt: '2026-10-05T18:00:00.000Z',
    scope: { channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'etsy-account-1' }, delivery: { productIds: ['family', 'child-1', 'child-2'], aliasKey: '' },
    changePlan: { publication: { ownerProductId: 'family' } }, ...over })
  const EARLY = new Date('2026-10-05T18:01:00Z')
  const result = (status: string, rows: Array<{ status: string; reference?: string }>) =>
    ({ result: { id: 'pub-create', status, message: status, results: rows.map((row, i) => ({ sku: `FAKE-SKU-${i + 1}`, ...row })) } })
  const linked = () => h.rows.filter(r => r.externalListingId === LISTING)
  beforeEach(() => {
    main().platformAttributes = {}
    h.listingPlain.mockResolvedValue({ listing_id: 9000000001, shop_id: 90000001, state: 'draft' })
    h.shop.mockResolvedValue({ shop_id: 90000001 })
  })

  describe('N1 — the stored result gives an id only in the "created on Etsy, not recorded in Nexus" outcome', () => {
    it('an ordinary sent-but-unconfirmed result (ACCEPTED rows: the id WAS stored, then unlinked by a person) links nothing', async () => {
      expect(await resolveEtsyCreateOnCheck('pub-create', data(result('UNVERIFIED', [{ status: 'ACCEPTED', reference: LISTING }, { status: 'ACCEPTED', reference: LISTING }])), EARLY)).toBeNull()
      expect(await resolveEtsyCreateOnCheck('pub-create', data(result('VERIFIED', [{ status: 'VERIFIED', reference: LISTING }])), EARLY)).toBeNull()
      // A mixed shape is not that outcome either; a create with no answer names no id.
      expect(await resolveEtsyCreateOnCheck('pub-create', data(result('UNVERIFIED', [{ status: 'SUBMITTED', reference: LISTING }, { status: 'ACCEPTED', reference: LISTING }])), EARLY)).toBeNull()
      expect(await resolveEtsyCreateOnCheck('pub-create', data(result('UNVERIFIED', [{ status: 'SUBMITTED' }, { status: 'SUBMITTED' }])), EARLY)).toBeNull()
      expect(h.listingPlain).not.toHaveBeenCalled()
      expect(linked()).toEqual([])
    })

    it('the create-unknown outcome (UNVERIFIED, every product SUBMITTED with Etsy\'s id) is linked', async () => {
      expect(await resolveEtsyCreateOnCheck('pub-create', data(result('UNVERIFIED', [{ status: 'SUBMITTED', reference: LISTING }, { status: 'SUBMITTED', reference: LISTING }])), EARLY))
        .toContain(`Nexus linked Etsy listing ${LISTING}`)
      expect(linked().map(r => r.id).sort()).toEqual(['listing-1', 'listing-2', 'listing-family'])
    })

    it('a listing a person unlinked from this destination since the create started is never linked again (the accepted unlink snapshot)', async () => {
      h.unlink.mockResolvedValue({ id: 'snapshot-unlink' })
      const note = await resolveEtsyCreateOnCheck('pub-create', data(result('UNVERIFIED', [{ status: 'SUBMITTED', reference: LISTING }])), EARLY)
      expect(note).toBe(`Etsy listing ${LISTING} (created by this publish) was unlinked from this family in Nexus since, so Nexus did not link it again.`)
      expect(h.unlink).toHaveBeenCalledWith({ where: { reason: 'unlink', outcome: 'ACCEPTED', channel: 'ETSY', marketplace: 'GLOBAL', aliasKey: '',
        channelListing: { channelConnectionId: 'etsy-account-1' }, payload: { path: ['evidence', 'oldExternalListingId'], equals: LISTING },
        acceptedAt: { gte: new Date('2026-10-05T18:00:00.000Z') } }, select: { id: true } })
      expect(h.listingPlain).not.toHaveBeenCalled()
      expect(linked()).toEqual([])
      // The same for the id the marker kept: the marker is cleared (the person chose to forget that listing).
      withMarker({ state: 'unknown', listingId: LISTING })
      expect(await resolveEtsyCreateOnCheck('pub-create', data(), EARLY)).toContain('was unlinked from this family in Nexus since')
      expect(main().platformAttributes._etsyCreate).toBeUndefined()
      expect(linked()).toEqual([])
    })
  })

  describe('N2 — a draft whose existence Etsy could not confirm is a 409, never "none"', () => {
    it('the search\'s EtsyDraftUnconfirmed is said as is, and the marker stays', async () => {
      withMarker()
      h.drafts.mockRejectedValue(Object.assign(new Error('Nexus could not tell whether Etsy still holds draft 9000000002 (Etsy could not read this resource (HTTP 500).); check again later.'),
        { name: 'EtsyDraftUnconfirmed' }))
      await expect(resolveEtsyCreateOnCheck('pub-create', data(), new Date('2026-10-05T18:30:00Z'))).rejects.toMatchObject({ statusCode: 409,
        message: 'Nexus could not tell whether Etsy still holds draft 9000000002 (Etsy could not read this resource (HTTP 500).); check again later.' })
      expect(main().platformAttributes._etsyCreate).toEqual(marker())
    })
  })
})
