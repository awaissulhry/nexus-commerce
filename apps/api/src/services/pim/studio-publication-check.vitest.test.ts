import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Sheet publish parity, step 4 — D3 "Mark as checked" and "Publish failed products again…", on the real schema and
 * tenant policies.
 *
 * Mark as checked: a publication still waiting for a result blocks its destination; a person's check keeps its status,
 * closes it, lets a new review start, is announced once and audited, survives a result arriving later, and the sweep
 * never looks at it again. A finished publication, a review never sent and a send still inside its deadline are
 * refused, and so is a publication of another business.
 *
 * Retry selection: the failed products of a publication and the fields they carried (an Amazon PARTIAL feed; an eBay
 * refusal before anything was sent), refused while the result is not known.
 */
const fixture = vi.hoisted(() => ({ database: null as any, facts: vi.fn(), readAmazon: vi.fn(), readEbay: vi.fn(), published: [] as any[] }))

vi.mock('@nexus/database', async () => {
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../test-support/concurrent-database.js')
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  return { default: fixture.database.client }
})
vi.mock('./studio-publication-plan.js', async () => {
  const { createHash } = await import('node:crypto')
  return { readPublicationFacts: fixture.facts,
    publicationDigest: (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    object: (value: unknown) => value && typeof value === 'object' ? value : {} }
})
vi.mock('../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: () => 'live' }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live' }))
vi.mock('../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: () => 'live' }))
// The status event is a refresh hint on the listing bus; here it is only recorded.
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (event: unknown) => { fixture.published.push(event) } }))
vi.mock('./studio-publication-amazon.js', () => ({
  prepareAmazonPublication: async (facts: any) => ({ kind: 'amazon', sellerId: 'seller-a', marketplaceId: 'market-it',
    products: facts.products.map((p: any) => ({ productId: p.id, sku: p.sku })),
    feed: { header: { version: '2.0' }, messages: facts.products.map((p: any, i: number) => ({ messageId: i + 1, sku: p.sku, operationType: 'PATCH', productType: 'COAT' })) } }),
  sendAmazonPublication: vi.fn(), readAmazonPublication: fixture.readAmazon,
}))
vi.mock('./studio-publication-ebay.js', () => ({ prepareEbayPublication: vi.fn(), sendEbayPublication: vi.fn(), readEbayPublication: fixture.readEbay,
  usesEbayInventory: () => false, prepareEbayInventoryPublication: vi.fn() }))
vi.mock('./studio-publication-baseline.js', () => ({ readPublicationBaseline: async () => ({ values: new Map(), revision: 'baseline-1' }) }))
vi.mock('./studio-publication-amazon-changes.js', () => ({
  prepareAmazonChanges: async (_facts: any, publication: any) => ({ kind: 'amazon-changes', publication, remoteRevision: 'remote-1', products: [],
    changes: publication.products.map((p: any) => ({ id: JSON.stringify([p.productId, 'item_name']), ...p, field: 'item_name', label: 'Title',
      current: { state: 'value', value: 'Saved' }, lastAccepted: { state: 'unknown', reason: 'No record' }, channel: { state: 'value', value: 'Live' },
      status: 'SEND', selectable: true, selectedByDefault: true, localChanged: true, channelChanged: false, reason: 'Changed', operation: 'replace' })) }),
  compileAmazonChanges: vi.fn(),
}))
vi.mock('./studio-publication-ebay-changes.js', () => ({ prepareEbayChanges: vi.fn(), compileEbayChanges: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { permissionForRoute } from '../../lib/auth/permissions-manifest.js'
import { publicationDigest } from './studio-publication-plan.js'
import { previewStudioPublication } from './studio-publication.service.js'
import { markPublicationChecked, publicationRetrySelection } from './studio-publication-check.service.js'
import { reschedulePublication, storeResult } from './studio-publication-settle.js'
import { runPublicationSettleTick } from '../../jobs/studio-publication-settle.job.js'

const WORKSPACE_B = 'publication_check_workspace_b'
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const scoped = <T>(work: () => Promise<T>) => inside(LEGACY_WORKSPACE_ID, work)
const ids: Record<string, string> = {}
const ACCOUNT = 'check-amazon-account'
const EBAY_ACCOUNT = 'check-ebay-account'
const NOW = new Date(Date.UTC(2026, 9, 2, 12, 0))
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)
const changeId = (productId: string, field: string) => JSON.stringify([productId, field])
/** The destination key a review of the family computes in this business (`previewStudioPublication`). */
const keyFor = (account: string, channel = 'AMAZON') => publicationDigest([LEGACY_WORKSPACE_ID, ids.root, channel, account, 'IT', null])

async function publication(id: string, input: { status: string; channel?: string; account?: string; userId?: string | null; submittedAt?: Date | null
  nextCheckAt?: Date | null; checkCount?: number | null; summary?: Record<string, unknown>; data?: Record<string, unknown> }) {
  const channel = input.channel ?? 'AMAZON'
  const account = input.account ?? ACCOUNT
  const submittedAt = input.submittedAt === undefined ? minutesAgo(60) : input.submittedAt
  await prisma.bulkOperation.create({ data: {
    id, userId: input.userId ?? null, status: input.status, productCount: 3, changeCount: 3,
    kind: 'studio-publication', productId: ids.root, channel, marketplace: 'IT', channelConnectionId: account, aliasKey: '',
    submittedAt, nextCheckAt: input.nextCheckAt ?? null, checkCount: input.checkCount ?? null, summary: input.summary as never,
    changes: { kind: 'studio-publication', publicationKey: keyFor(account, channel), productId: ids.root, scope: { channel, marketplace: 'IT', accountId: account },
      delivery: { productIds: [ids.root, ids.s, ids.m], aliasKey: '' }, ...(submittedAt ? { startedAt: submittedAt.toISOString() } : {}), ...input.data },
  } as never })
}

const facts = () => ({ scope: { channel: 'AMAZON', marketplace: 'IT', accountId: ACCOUNT }, destination: { familyId: ids.root, aliasKey: null },
  account: { displayName: 'Amazon account' }, parent: { id: ids.root },
  products: [{ id: ids.root, sku: 'COAT', name: 'Coat' }, { id: ids.s, sku: 'COAT-S', name: 'Coat S' }, { id: ids.m, sku: 'COAT-M', name: 'Coat M' }],
  listings: [], resolved: [], issues: [], excluded: 0, aliasLabel: 'Primary listing', revision: 'facts-1' })

beforeAll(async () => {
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  fixture.facts.mockImplementation(async () => facts())
  await scoped(async () => {
    ids.publisher = (await prisma.userProfile.create({ data: { displayName: 'Publisher Person', email: 'publisher-check@example.test' } as never })).id
    ids.checker = (await prisma.userProfile.create({ data: { displayName: 'Checker Person', email: 'checker@example.test' } as never })).id
    ids.root = (await prisma.product.create({ data: { sku: 'COAT', name: 'Coat', basePrice: 10, isParent: true } as never })).id
    ids.s = (await prisma.product.create({ data: { sku: 'COAT-S', name: 'Coat S', basePrice: 10, parentId: ids.root } as never })).id
    ids.m = (await prisma.product.create({ data: { sku: 'COAT-M', name: 'Coat M', basePrice: 10, parentId: ids.root } as never })).id
  })
  await fixture.database.client.workspace.create({ data: { id: WORKSPACE_B, name: 'Other business', createdByUserId: ids.publisher, creationKey: 'publication-check-b' } as never })
}, 120_000)

afterAll(async () => { vi.unstubAllEnvs(); await fixture.database?.close?.() })

const row = (id: string) => scoped(() => prisma.bulkOperation.findFirst({ where: { id } }))
const eventsFor = (id: string) => fixture.published.filter(event => event.publicationId === id)
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

describe('mark as checked (D3)', () => {
  it('keeps the status, closes the publication, unblocks the destination, and is announced and audited once', async () => {
    await scoped(() => publication('stuck', { status: 'SUBMITTED', userId: ids.publisher, submittedAt: minutesAgo(8 * 24 * 60), checkCount: 9,
      summary: { products: 3, accepted: 0, verified: 0, failed: 0, submitted: 3, needsCheck: true },
      data: { result: { id: 'stuck', status: 'SUBMITTED', message: 'Submitted', results: [{ sku: 'COAT', status: 'SUBMITTED', message: 'Awaiting', reference: 'FEED-1' }] } } }))

    const blocked = await scoped(() => previewStudioPublication(ids.root, { channel: 'AMAZON', marketplace: 'IT', accountId: ACCOUNT }, ids.publisher))
    expect(blocked).toMatchObject({ id: null, previousPublicationId: 'stuck' })

    const checked = await scoped(() => markPublicationChecked(ids.root, 'stuck', { note: '  Seen live in Seller Central  ' }, ids.checker, NOW))
    expect(checked).toEqual({ publicationId: 'stuck', status: 'SUBMITTED', checkedAt: NOW.toISOString(),
      checkedBy: { id: ids.checker, name: 'Checker Person' }, note: 'Seen live in Seller Central', destinationOpen: true })
    const stored = await row('stuck')
    expect(stored).toMatchObject({ status: 'SUBMITTED', completedAt: NOW, nextCheckAt: null })
    expect(stored!.summary).toEqual({ products: 3, accepted: 0, verified: 0, failed: 0, submitted: 3, needsCheck: true,
      checkedAt: NOW.toISOString(), checkedBy: ids.checker, checkedNote: 'Seen live in Seller Central' })
    await vi.waitFor(() => expect(eventsFor('stuck')).toHaveLength(1))
    expect(eventsFor('stuck')).toEqual([expect.objectContaining({ type: 'publication.status_changed', status: 'SUBMITTED', terminal: true,
      productId: ids.root, channel: 'AMAZON', marketplace: 'IT', accountId: ACCOUNT })])
    const audits = await scoped(() => prisma.auditLog.findMany({ where: { entityId: 'stuck', action: 'publication.mark_checked' } }))
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ userId: ids.checker, entityType: 'BulkOperation', after: { status: 'SUBMITTED', note: 'Seen live in Seller Central' } })

    const open = await scoped(() => previewStudioPublication(ids.root, { channel: 'AMAZON', marketplace: 'IT', accountId: ACCOUNT }, ids.publisher))
    expect(open.id).toEqual(expect.any(String))
    expect(open.previousPublicationId).toBeUndefined()
    expect(open.issues.filter(issue => issue.severity === 'error')).toEqual([])

    // Repeating it returns the first check: no second event, no second audit row, nothing rewritten.
    const again = await scoped(() => markPublicationChecked(ids.root, 'stuck', { note: 'other words' }, ids.publisher, new Date(NOW.getTime() + 60_000)))
    expect(again).toMatchObject({ checkedAt: NOW.toISOString(), checkedBy: { id: ids.checker }, note: 'Seen live in Seller Central' })
    await settle()
    expect(eventsFor('stuck')).toHaveLength(1)
    expect(await scoped(() => prisma.auditLog.count({ where: { entityId: 'stuck', action: 'publication.mark_checked' } }))).toBe(1)
  })

  it('accepts the check from any product of the family', async () => {
    await scoped(() => publication('stuck-variation', { status: 'UNVERIFIED', account: 'variation-account', submittedAt: minutesAgo(120) }))
    await expect(scoped(() => markPublicationChecked(ids.s, 'stuck-variation', {}, ids.checker, NOW))).resolves.toMatchObject({ status: 'UNVERIFIED', note: null })
  })

  it('refuses a finished publication, a review never sent, and a send still inside its 30-minute deadline', async () => {
    await scoped(async () => {
      await publication('done', { status: 'ACCEPTED', account: 'done-account' })
      await publication('never', { status: 'PREVIEW', account: 'never-account', submittedAt: null })
      await publication('sending', { status: 'PUBLISHING', account: 'sending-account', submittedAt: minutesAgo(5) })
      await publication('sending-late', { status: 'PUBLISHING', account: 'late-account', submittedAt: minutesAgo(45) })
    })
    await expect(scoped(() => markPublicationChecked(ids.root, 'done', {}, ids.checker, NOW))).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/already has its result/) })
    await expect(scoped(() => markPublicationChecked(ids.root, 'never', {}, ids.checker, NOW))).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/never sent/) })
    await expect(scoped(() => markPublicationChecked(ids.root, 'sending', {}, ids.checker, NOW))).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/still being sent/) })
    await expect(scoped(() => markPublicationChecked(ids.root, 'sending-late', {}, ids.checker, NOW))).resolves.toMatchObject({ status: 'PUBLISHING' })
    await expect(scoped(() => markPublicationChecked(ids.root, 'done', { note: 7 }, ids.checker, NOW))).rejects.toMatchObject({ statusCode: 400 })
    await expect(scoped(() => markPublicationChecked(ids.root, 'done', { note: 'x'.repeat(501) }, ids.checker, NOW))).rejects.toMatchObject({ statusCode: 400 })
    expect(await row('done')).toMatchObject({ status: 'ACCEPTED' })
  })

  it('refuses a publication of another business and leaves it as it was', async () => {
    await scoped(() => publication('foreign', { status: 'UNVERIFIED', account: 'foreign-account', submittedAt: minutesAgo(90) }))
    await expect(inside(WORKSPACE_B, () => markPublicationChecked(ids.root, 'foreign', {}, ids.checker, NOW))).rejects.toMatchObject({ statusCode: 404 })
    await expect(inside(WORKSPACE_B, () => publicationRetrySelection(ids.root, 'foreign'))).rejects.toMatchObject({ statusCode: 404 })
    // Another product's id is not a way in either.
    const other = await scoped(async () => (await prisma.product.create({ data: { sku: 'OTHER', name: 'Other', basePrice: 1 } as never })).id)
    await expect(scoped(() => markPublicationChecked(other, 'foreign', {}, ids.checker, NOW))).rejects.toMatchObject({ statusCode: 404 })
    expect(await row('foreign')).toMatchObject({ status: 'UNVERIFIED', completedAt: null })
  })

  it('is never swept again, and a sweep that claimed it first cannot reopen it', async () => {
    fixture.readAmazon.mockReset(); fixture.readEbay.mockReset()
    await scoped(async () => {
      await publication('swept', { status: 'SUBMITTED', account: 'swept-account', nextCheckAt: minutesAgo(1), checkCount: 2,
        data: { result: { id: 'swept', status: 'SUBMITTED', message: 'Submitted', results: [{ sku: 'COAT', status: 'SUBMITTED', message: 'Awaiting', reference: 'FEED-2' }] } } })
      await markPublicationChecked(ids.root, 'swept', {}, ids.checker, NOW)
    })
    const tick = await scoped(() => runPublicationSettleTick(NOW))
    expect(tick.claimed).toBe(0)
    expect(fixture.readAmazon).not.toHaveBeenCalled()

    // A sweep claimed it (its lease is in nextCheckAt), then a person checked it, then the sweep reschedules.
    await scoped(async () => {
      await publication('leased', { status: 'SUBMITTED', account: 'leased-account', nextCheckAt: new Date(NOW.getTime() + 5 * 60_000), checkCount: 3 })
      await markPublicationChecked(ids.root, 'leased', {}, ids.checker, NOW)
    })
    expect(await scoped(() => reschedulePublication('leased', NOW))).toBeNull()
    expect(await row('leased')).toMatchObject({ nextCheckAt: null, completedAt: NOW })
  })

  it('keeps the check when a result still arrives: unknown stays closed, a real result is stored with the mark', async () => {
    const data = (id: string) => ({ kind: 'studio-publication', productId: ids.root, scope: { channel: 'EBAY', marketplace: 'IT', accountId: EBAY_ACCOUNT },
      delivery: { productIds: [ids.root], aliasKey: '' }, result: { id, status: 'UNVERIFIED', message: 'Acknowledged', results: [{ sku: 'COAT', status: 'ACCEPTED', message: 'Acknowledged', reference: 'ITEM-1' }] } })
    await scoped(async () => {
      await publication('late-result', { status: 'UNVERIFIED', channel: 'EBAY', account: EBAY_ACCOUNT, submittedAt: minutesAgo(600), checkCount: 12 })
      await markPublicationChecked(ids.root, 'late-result', { note: 'Ended on eBay by hand' }, ids.checker, NOW)
    })
    const unknown = { id: 'late-result', status: 'UNVERIFIED' as const, message: 'Still unknown', results: [{ sku: 'COAT', status: 'ACCEPTED' as const, message: 'Acknowledged', reference: 'ITEM-1' }] }
    expect((await scoped(() => storeResult('late-result', data('late-result'), null, unknown, ['UNVERIFIED']))).count).toBe(1)
    expect(await row('late-result')).toMatchObject({ status: 'UNVERIFIED', completedAt: NOW, nextCheckAt: null,
      summary: expect.objectContaining({ checkedAt: NOW.toISOString(), checkedBy: ids.checker, checkedNote: 'Ended on eBay by hand' }) })

    const accepted = { ...unknown, status: 'ACCEPTED' as const, message: 'eBay accepted item ITEM-1 and reports it active.' }
    expect((await scoped(() => storeResult('late-result', data('late-result'), null, accepted, ['UNVERIFIED']))).count).toBe(1)
    const final = await row('late-result')
    expect(final).toMatchObject({ status: 'ACCEPTED', nextCheckAt: null, summary: expect.objectContaining({ checkedAt: NOW.toISOString(), accepted: 1 }) })
    expect(final!.completedAt).toBeInstanceOf(Date)
  })
})

describe('retry selection ("Publish failed products again…")', () => {
  it('returns the failed products of an Amazon PARTIAL feed and the fields they carried, the named ones flagged', async () => {
    // An Amazon content field is one language instance of its root: `bullet_point:["<marketplaceId>","<tag>"]`.
    const bullet = 'bullet_point:["APJ6JRA9NG5V4","it_IT"]'
    await scoped(() => publication('partial', { status: 'PARTIAL', account: 'partial-account', data: {
      scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'partial-account', listingId: 'listing-root' },
      selection: { selectedIds: [changeId(ids.root, 'item_name'), changeId(ids.s, 'color'), changeId(ids.s, bullet), changeId(ids.m, 'item_name')],
        products: [{ productId: ids.root, sku: 'COAT' }, { productId: ids.s, sku: 'SELLER-COAT-S' }, { productId: ids.m, sku: 'COAT-M' }] },
      result: { id: 'partial', status: 'PARTIAL', message: '1 products were rejected by Amazon.', results: [
        { sku: 'COAT', status: 'ACCEPTED', message: 'Accepted', reference: 'FEED-3' },
        { sku: 'SELLER-COAT-S', status: 'FAILED', message: 'The value is not allowed.', reference: 'FEED-3',
          issues: [{ code: '8541', severity: 'error', message: 'The value is not allowed.', attributeNames: ['color'] }] },
        { sku: 'COAT-M', status: 'ACCEPTED', message: 'Accepted', reference: 'FEED-3' }] } } }))
    const retry = await scoped(() => publicationRetrySelection(ids.root, 'partial'))
    expect(retry).toEqual({
      publicationId: 'partial', status: 'PARTIAL',
      destination: { channel: 'AMAZON', marketplace: 'IT', accountId: 'partial-account', listingId: 'listing-root', aliasKey: '' },
      productIds: [ids.s], fieldIds: [changeId(ids.s, 'color'), changeId(ids.s, bullet)],
      products: [{ productId: ids.s, sku: 'SELLER-COAT-S', message: 'The value is not allowed.', attributeNames: ['color'],
        fieldIds: [changeId(ids.s, 'color'), changeId(ids.s, bullet)], flaggedFieldIds: [changeId(ids.s, 'color')] }],
      unmatchedSkus: [], notSent: false,
    })
  })

  it('returns every delivered product when eBay refused before anything was sent', async () => {
    await scoped(() => publication('ebay-refused', { status: 'FAILED', channel: 'EBAY', account: 'refused-account', data: {
      changePlan: { kind: 'ebay-changes', products: [{ productId: ids.root, sku: 'COAT' }, { productId: ids.s, sku: 'COAT-S' }, { productId: ids.m, sku: 'COAT-M' }] },
      selection: { selectedIds: [changeId(ids.root, 'Title'), changeId(ids.root, 'ItemSpecifics')], products: [{ productId: ids.root, sku: 'COAT' }] },
      result: { id: 'ebay-refused', status: 'FAILED', message: 'Nothing was submitted. Choose shipping, payment and return policies.', results: [] } } }))
    const retry = await scoped(() => publicationRetrySelection(ids.root, 'ebay-refused'))
    expect(retry).toMatchObject({ status: 'FAILED', notSent: true, productIds: [ids.root, ids.s, ids.m],
      fieldIds: [changeId(ids.root, 'Title'), changeId(ids.root, 'ItemSpecifics')], unmatchedSkus: [],
      destination: { channel: 'EBAY', marketplace: 'IT', accountId: 'refused-account', aliasKey: '' } })
    expect(retry.products.map(product => [product.sku, product.message])).toEqual([
      ['COAT', 'Nothing was submitted. Choose shipping, payment and return policies.'],
      ['COAT-S', 'Nothing was submitted. Choose shipping, payment and return policies.'],
      ['COAT-M', 'Nothing was submitted. Choose shipping, payment and return policies.']])
  })

  it('returns nothing to retry when every product was accepted, and refuses while the result is not known', async () => {
    await scoped(async () => {
      await publication('all-good', { status: 'VERIFIED', account: 'good-account', data: { result: { id: 'all-good', status: 'VERIFIED', message: 'Verified',
        results: [{ sku: 'COAT', status: 'VERIFIED', message: 'Verified' }] } } })
      await publication('waiting', { status: 'SUBMITTED', account: 'waiting-account' })
      await publication('unknown-checked', { status: 'UNVERIFIED', account: 'unknown-account', submittedAt: minutesAgo(90) })
      await markPublicationChecked(ids.root, 'unknown-checked', {}, ids.checker, NOW)
    })
    await expect(scoped(() => publicationRetrySelection(ids.root, 'all-good'))).resolves.toMatchObject({ productIds: [], fieldIds: [], products: [], notSent: false })
    await expect(scoped(() => publicationRetrySelection(ids.root, 'waiting'))).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/still waiting/) })
    await expect(scoped(() => publicationRetrySelection(ids.root, 'unknown-checked'))).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/does not know which products failed/) })
  })
})

describe('permissions', () => {
  it('both actions need products.publish', () => {
    expect(permissionForRoute('POST', '/api/products/:id/studio-publication/:reviewId/mark-checked')).toBe('products.publish')
    expect(permissionForRoute('GET', '/api/products/:id/studio-publication/:reviewId/retry-selection')).toBe('products.publish')
  })
})
