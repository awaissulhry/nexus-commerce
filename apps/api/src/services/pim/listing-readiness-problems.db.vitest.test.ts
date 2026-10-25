/**
 * Listings live layer, step 7 — the Problems view end to end on a real PostgreSQL (PGlite): the rows of every source
 * (readiness fields aggregated per destination with their most urgent kind, channel messages word for word, Ready-not-
 * listed with drafts counted as not listed), their order and counts, a caller without `listings.view`, the page's
 * filters (state tile, language, search) and THE INVARIANT: Show products (`problem=<row id>` on the families endpoint)
 * lists exactly the row's products, and the tiles and the ETag follow it. Ids invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))

import { createHash } from 'node:crypto'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readinessFamilies, readinessFamiliesIfChanged, readinessFamilyMembers } from './listing-readiness-families.service.js'
import { readinessProblems, readinessProblemsIfChanged } from './listing-readiness-problems.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const key = (c: (string | null)[]) => JSON.stringify(c)
const md5 = (text: string) => createHash('md5').update(text).digest('hex')
const SHARED = [null, null, null, null], AMAZON_DE = ['AMAZON', 'DE', 'pr-a1', null], AMAZON_IT = ['AMAZON', 'IT', 'pr-a1', null], EBAY_IT = ['EBAY', 'IT', 'pr-e1', null]
const computedAt = new Date('2026-10-25T08:00:00Z')
const index = (productId: string, c: (string | null)[], s = 'ready', missing: unknown[] = [], language = 'de') => ({
  productId, coordinateKey: key(c), channel: c[0], market: c[1], accountId: c[2], aliasId: c[3], language,
  label: c[0] ? `${c[0]} · ${c[1]}` : 'Shared product', pct: null, state: s, requiredFilled: 0, requiredTotal: 0, missing, note: null, computedAt,
})
const listing = (id: string, productId: string, [channel, marketplace, account]: (string | null)[], extra: Record<string, unknown> = {}) => ({
  id, productId, channel, marketplace, channelConnectionId: account, aliasKey: '', channelMarket: `${channel}_${marketplace}`, region: marketplace,
  listingStatus: 'ACTIVE', isPublished: true, externalListingId: `X-${id}`, ...extra,
})
const SIZE_CHART = { field: 'size_chart', label: 'Size chart', reason: 'Required and empty', requiredEmpty: true }
const BULLETS = { field: 'bullet_point', label: 'Bullet points', reason: 'Add five bullet points' }
const NOT_ALLOWED = "The value for 'size_name' is not allowed.", BRAND = 'Item specifics missing: Brand'

beforeAll(() => scoped(async () => {
  await prisma.channelConnection.create({ data: { id: 'pr-a1', channelType: 'AMAZON', isActive: true, accountLabel: 'Xavia', externalAccountId: 'seller-a1' } as never })
  await prisma.channelConnection.create({ data: { id: 'pr-e1', channelType: 'EBAY', isActive: true, externalAccountId: 'seller-e1' } as never })
  for (const [channel, code] of [['AMAZON', 'DE'], ['AMAZON', 'IT'], ['EBAY', 'IT']])
    await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, region: 'EU', currency: 'EUR', language: 'de', isActive: true } as never })
  await prisma.product.create({ data: { id: 'pr-root', sku: 'PR', name: 'Problem Parka', basePrice: 10, isParent: true, status: 'DRAFT' } })
  for (const [id, sku] of [['pr-v1', 'PR-M'], ['pr-v2', 'PR-L'], ['pr-v3', 'PR-XL']]) await prisma.product.create({ data: { id, sku, name: `Variant ${sku}`, basePrice: 10, parentId: 'pr-root', status: 'DRAFT' } })
  await prisma.product.create({ data: { id: 'pr-solo', sku: 'PR-SOLO', name: 'Solo gloves', basePrice: 10, status: 'DRAFT' } })
  await prisma.product.create({ data: { id: 'pr-ok', sku: 'PR-OK', name: 'Fine boots', basePrice: 10, status: 'DRAFT' } })
  await prisma.readinessIndex.createMany({ data: [
    ...['pr-root', 'pr-v1', 'pr-v2', 'pr-v3', 'pr-solo', 'pr-ok'].map(id => index(id, SHARED)),
    index('pr-root', AMAZON_DE), index('pr-v1', AMAZON_DE, 'blocked', [SIZE_CHART, BULLETS]), index('pr-v2', AMAZON_DE, 'warn', [BULLETS]), index('pr-v3', AMAZON_DE),
    index('pr-solo', AMAZON_DE, 'blocked', [SIZE_CHART]),
    index('pr-solo', AMAZON_DE, 'warn', [{ field: 'size_chart', label: 'Size chart', reason: 'Not translated', kind: 'language-fallback' }], 'en'),
    ...['pr-root', 'pr-v1', 'pr-v2', 'pr-v3', 'pr-solo', 'pr-ok'].map(id => index(id, AMAZON_IT)),
    index('pr-solo', EBAY_IT), index('pr-ok', EBAY_IT),
  ] as never })
  await prisma.channelListing.createMany({ data: [
    listing('pr-l-root-it', 'pr-root', AMAZON_IT), listing('pr-l-v1-it', 'pr-v1', AMAZON_IT), listing('pr-l-v2-it', 'pr-v2', AMAZON_IT),
    // A draft is not on the channel: Ready, not listed.
    listing('pr-l-v3-it', 'pr-v3', AMAZON_IT, { listingStatus: 'DRAFT', isPublished: false, externalListingId: null }),
    listing('pr-l-ok-it', 'pr-ok', AMAZON_IT), listing('pr-l-solo-e', 'pr-solo', EBAY_IT), listing('pr-l-ok-e', 'pr-ok', EBAY_IT),
  ] as never })
  const issue = (listingId: string, code: string, severity: string, message: string, extra: Record<string, unknown> = {}) =>
    ({ listingId, code, severity, message, attributeNames: [], categories: [], fingerprint: `${code}::${listingId}`, ...extra })
  await prisma.listingIssue.createMany({ data: [
    issue('pr-l-v1-it', '90220', 'ERROR', NOT_ALLOWED), issue('pr-l-v2-it', '90220', 'ERROR', NOT_ALLOWED),
    issue('pr-l-solo-e', '21919303', 'WARNING', BRAND), issue('pr-l-ok-e', '21919303', 'WARNING', BRAND),
    // Resolved: not a problem any more.
    issue('pr-l-ok-it', '8541', 'ERROR', 'Gone', { resolvedAt: new Date('2026-10-24T00:00:00Z') }),
  ] })
}), 120_000)
afterAll(async () => { await state.db?.close() })

const R = (c: (string | null)[], field: string) => `r:${key(c)}:${field}`
const C = (c: (string | null)[], message: string, code: string) => `c:${key(c)}:${md5(message)}:${code}`
const N = (c: (string | null)[]) => `n:${key(c)}`

describe('the Problems view', () => {
  it('one row per problem × destination, in order, with the page’s words and counts', async () => {
    const page = await scoped(() => readinessProblems({}, null, { live: true }))
    expect(page).toMatchObject({ total: 6, limit: 500, live: true })
    expect(page.rows.map(r => [r.id, r.label, r.state ?? r.severity, r.destination.label, r.products, r.listings])).toEqual([
      // Blocked: the field's most urgent kind and its sentence (pr-solo's English row says "Not translated").
      [R(AMAZON_DE, 'size_chart'), 'Size chart', 'blocked', 'Amazon DE', 2, 2],
      [R(AMAZON_DE, 'bullet_point'), 'Bullet points', 'blocked', 'Amazon DE', 1, 2],
      // Channel messages word for word: most products first.
      [C(EBAY_IT, BRAND, '21919303'), 'Message from eBay', 'warning', 'eBay IT', 2, 2],
      [C(AMAZON_IT, NOT_ALLOWED, '90220'), 'Message from Amazon', 'error', 'Amazon IT', 1, 2],
      // Ready, not listed: pr-solo (no listing) and pr-v3 (a draft) on Amazon IT; the parent and pr-v3 on Amazon DE.
      [N(AMAZON_IT), 'Ready, not listed', null, 'Amazon IT', 2, 2],
      [N(AMAZON_DE), 'Ready, not listed', null, 'Amazon DE', 1, 2],
    ])
    expect(page.rows[0]).toMatchObject({ kind: 'required', message: 'Required and empty', field: 'size_chart', code: null })
    expect(page.rows[1]).toMatchObject({ kind: 'check', message: 'Add five bullet points' })
    expect(page.rows[3]).toMatchObject({ code: '90220', message: NOT_ALLOWED, kind: null })
  })

  it('without listings.view: readiness only', async () => {
    const page = await scoped(() => readinessProblems({}, null))
    expect(page.live).toBe(false)
    expect(page.rows.map(r => r.id)).toEqual([R(AMAZON_DE, 'size_chart'), R(AMAZON_DE, 'bullet_point')])
    expect(page.total).toBe(2)
  })

  it('Show products lists exactly the row’s products — every row', async () => {
    const page = await scoped(() => readinessProblems({}, null, { live: true }))
    for (const row of page.rows) {
      const families = await scoped(() => readinessFamilies({ problem: row.id }, null, { live: true }))
      expect(families.total, row.id).toBe(row.products)
    }
    const ids = async (problem: string, live = true) => (await scoped(() => readinessFamilies({ problem }, null, { live }))).rows.map(r => r.id)
    expect(await ids(R(AMAZON_DE, 'size_chart'))).toEqual(['pr-root', 'pr-solo'])
    expect(await ids(C(EBAY_IT, BRAND, '21919303'))).toEqual(['pr-solo', 'pr-ok'])
    expect(await ids(N(AMAZON_IT))).toEqual(['pr-root', 'pr-solo'])
    // A channel problem without listings.view is ignored, like the live filters.
    expect(await ids(C(EBAY_IT, BRAND, '21919303'), false)).toHaveLength(3)
    // A problem nobody has any more: nothing.
    expect(await ids(R(AMAZON_DE, 'no_such_field'))).toEqual([])
  })

  it('the tiles and the live tiles follow the problem; the open family is not narrowed', async () => {
    const all = await scoped(() => readinessFamilies({}, null, { live: true }))
    const bullets = await scoped(() => readinessFamilies({ problem: R(AMAZON_DE, 'bullet_point') }, null, { live: true }))
    expect(all.stats.all).toBe(19)
    // The parka family alone: 4 members × Shared, Amazon DE, Amazon IT.
    expect(bullets.stats).toMatchObject({ all: 12, blocked: 1, warn: 1, ready: 10 })
    // The live tiles' Not listed counts a draft as a listing (step 3's rule): the four Amazon DE pairs.
    expect(bullets.liveStats).toMatchObject({ listings: 4, notListed: 4 })
    const members = await scoped(() => readinessFamilyMembers('pr-root', { problem: R(AMAZON_DE, 'bullet_point') }, null))
    expect(members.total).toBe(4)
  })

  it('refuses a problem that is not an id', async () => {
    await expect(scoped(() => readinessFamilies({ problem: 'r:nonsense' }, null))).rejects.toThrow('Select a problem from the Problems view')
    // The Problems view lists every problem: its own `problem` is not a filter of it.
    expect((await scoped(() => readinessProblems({ problem: 'r:nonsense' }, null))).total).toBe(2)
  })

  it('follows the page’s filters: the state tile, a language, the search', async () => {
    const blocked = await scoped(() => readinessProblems({ state: 'blocked' }, null, { live: true }))
    // pr-ok has no blocked listing: its family is not listed, so its eBay message counts pr-solo only.
    expect(blocked.rows.find(r => r.id === C(EBAY_IT, BRAND, '21919303'))).toMatchObject({ products: 1, listings: 1 })
    expect((await scoped(() => readinessFamilies({ state: 'blocked', problem: C(EBAY_IT, BRAND, '21919303') }, null, { live: true }))).total).toBe(1)
    const english = await scoped(() => readinessProblems({ language: 'en' }, null, { live: true }))
    expect(english.rows.filter(r => r.source === 'readiness').map(r => [r.id, r.state, r.kind, r.message, r.products, r.listings]))
      .toEqual([[R(AMAZON_DE, 'size_chart'), 'warn', 'translation', 'Not translated', 1, 1]])
    const searched = await scoped(() => readinessProblems({ q: 'PR-OK' }, null, { live: true }))
    expect(searched.rows.map(r => [r.id, r.products])).toEqual([[C(EBAY_IT, BRAND, '21919303'), 1]])
    const ebay = await scoped(() => readinessProblems({ channel: 'EBAY' }, null, { live: true }))
    expect(ebay.rows.map(r => r.id)).toEqual([C(EBAY_IT, BRAND, '21919303')])
  })

  it('answers an unchanged poll with its ETag; the families ETag knows the problem', async () => {
    const first = await scoped(() => readinessProblemsIfChanged({}, null, () => false, { live: true }))
    const again = await scoped(() => readinessProblemsIfChanged({}, null, tag => tag === first.etag, { live: true }))
    expect(again).toEqual({ etag: first.etag, page: null })
    const one = await scoped(() => readinessFamiliesIfChanged({ problem: R(AMAZON_DE, 'size_chart') }, null, () => false, { live: true }))
    const other = await scoped(() => readinessFamiliesIfChanged({ problem: R(AMAZON_DE, 'bullet_point') }, null, () => false, { live: true }))
    expect(one.etag).not.toBe(other.etag)
  })
})
