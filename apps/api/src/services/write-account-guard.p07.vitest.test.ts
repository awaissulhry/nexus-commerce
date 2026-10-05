/**
 * P0.7 (docs/channel-connections/FINAL-PLAN.md) — the wrong-account guard: a write that would reach
 * account A for a listing recorded as account B's is refused, nothing sent. Part 1 pins the rule
 * (prisma is a stand-in that answers the ownership queries). Part 2 is a census: every source file
 * that sends eBay listing writes through the primary account must call the guard, or be listed
 * here as not writing listings, with the reason.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  /** S8 — `channelSku` / `liveChannelSku`: a listing's own channel SKU (sent / confirmed), not its product's. */
  listings: [] as Array<{ id: string; channel: string; productId: string; marketplace: string; region: string; externalListingId: string | null; channelConnectionId: string | null; sku: string; channelSku?: string | null; liveChannelSku?: string | null }>,
  /** S8 — every channelListing.findMany argument, to pin the hot-path query shape. */
  calls: [] as any[],
  members: [] as Array<{ itemId: string; sku: string; marketplace: string; channelConnectionId: string | null }>,
  fail: false,
  namesFail: false,
  queries: 0,
}))

/** Enough of Prisma's where-language for the guard's two queries. */
function matchListing(row: (typeof h.listings)[number], where: any): boolean {
  if (!where) return true
  if (where.channel && row.channel !== where.channel) return false
  if (where.channelConnectionId?.not === null && row.channelConnectionId === null) return false
  if (where.id?.in && !where.id.in.includes(row.id)) return false
  if (where.externalListingId?.in && !where.externalListingId.in.includes(row.externalListingId)) return false
  if (where.productId?.in && !where.productId.in.includes(row.productId)) return false
  if (where.product?.sku?.in && !where.product.sku.in.includes(row.sku)) return false
  if (where.channelSku?.in && !where.channelSku.in.includes(row.channelSku)) return false
  if (where.liveChannelSku?.in && !where.liveChannelSku.in.includes(row.liveChannelSku)) return false
  if (where.marketplace && typeof where.marketplace === 'string' && row.marketplace !== where.marketplace) return false
  if (where.region && typeof where.region === 'string' && row.region !== where.region) return false
  if (where.AND && !where.AND.every((w: any) => matchListing(row, w))) return false
  if (where.OR && !where.OR.some((w: any) => matchListing(row, w))) return false
  return true
}
vi.mock('../db.js', () => ({
  default: {
    channelListing: {
      findMany: async (args: any) => {
        h.queries++
        h.calls.push(args)
        if (h.fail) throw new Error('database unavailable')
        return h.listings.filter((row) => matchListing(row, args.where)).map((row) => ({ channelConnectionId: row.channelConnectionId, product: { sku: row.sku }, channelSku: row.channelSku ?? null, liveChannelSku: row.liveChannelSku ?? null }))
      },
    },
    sharedListingMembership: {
      findMany: async ({ where }: any) => {
        h.queries++
        return h.members.filter((m) => m.channelConnectionId !== null &&
          (!where.sku?.in || where.sku.in.includes(m.sku)) && (!where.marketplace || m.marketplace === where.marketplace) &&
          (!where.OR || where.OR.some((w: any) => (w.itemId?.in?.includes(m.itemId)) || (w.sku?.in?.includes(m.sku) && (!w.marketplace || w.marketplace === m.marketplace)))))
      },
    },
    channelConnection: {
      findMany: async () => {
        if (h.namesFail) throw new Error('names unavailable')
        return [{ id: 'conn-A', displayName: 'Xavia IT', externalAccountId: 'xavia' }, { id: 'conn-B', displayName: 'Second shop', externalAccountId: 'second' }]
      },
    },
  },
}))

import { assertWriteAccount, assertWriteAccountPerSku, marketplaceCodeOf, WrongAccountWriteError } from './write-account-guard.js'

const listing = (id: string, owner: string | null, over: Partial<(typeof h.listings)[number]> = {}) =>
  h.listings.push({ id, channel: 'EBAY', productId: `p-${id}`, marketplace: 'IT', region: 'IT', externalListingId: `item-${id}`, channelConnectionId: owner, sku: `SKU-${id}`, ...over })

beforeEach(() => { h.listings.length = 0; h.members.length = 0; h.calls.length = 0; h.fail = false; h.namesFail = false; h.queries = 0 })

describe('P0.7 — the rule', () => {
  it('a listing of account B, written through A: refused, naming both accounts', async () => {
    listing('1', 'conn-B')
    const refusal = await assertWriteAccount('EBAY', 'conn-A', { listingIds: ['1'] }).catch((e) => e)
    expect(refusal).toBeInstanceOf(WrongAccountWriteError)
    expect(refusal).toMatchObject({ code: 'WRONG_ACCOUNT_WRITE', statusCode: 409, detail: { usedConnectionId: 'conn-A', ownerConnectionIds: ['conn-B'] } })
    expect(refusal.message).toMatch(/^Nothing was sent to eBay: .*"Second shop".*"Xavia IT"/)
  })
  it('positive control: the same listing written through its own account passes', async () => {
    listing('1', 'conn-B')
    await expect(assertWriteAccount('EBAY', 'conn-B', { listingIds: ['1'] })).resolves.toBeUndefined()
  })
  it('a listing with no recorded account, or a target no listing names, is not refused', async () => {
    listing('1', null)
    await expect(assertWriteAccount('EBAY', 'conn-A', { listingIds: ['1'] })).resolves.toBeUndefined()
    await expect(assertWriteAccount('EBAY', 'conn-A', { skus: ['UNKNOWN-SKU'] })).resolves.toBeUndefined()
  })
  it('no account in use, or nothing to check: no query at all', async () => {
    await assertWriteAccount('EBAY', null, { listingIds: ['1'] })
    await assertWriteAccount('EBAY', 'conn-A', { skus: [null, '', undefined] })
    expect(h.queries).toBe(0)
  })
  it('a SKU listed on BOTH accounts passes through either', async () => {
    listing('1', 'conn-A', { sku: 'SHARED' }); listing('2', 'conn-B', { sku: 'SHARED' })
    await expect(assertWriteAccount('EBAY', 'conn-A', { skus: ['SHARED'], marketplace: 'EBAY_IT' })).resolves.toBeUndefined()
  })
  it('the marketplace narrows SKU and product matches (EBAY_IT, IT and an Amazon id all read as IT)', async () => {
    listing('1', 'conn-A', { sku: 'S', marketplace: 'DE', region: 'DE' }); listing('2', 'conn-B', { sku: 'S' })
    await expect(assertWriteAccount('EBAY', 'conn-A', { skus: ['S'], marketplace: 'EBAY_IT' })).rejects.toBeInstanceOf(WrongAccountWriteError)
    await expect(assertWriteAccount('EBAY', 'conn-A', { skus: ['S'], marketplace: 'DE' })).resolves.toBeUndefined()
    expect([marketplaceCodeOf('EBAY_IT'), marketplaceCodeOf('it'), marketplaceCodeOf('APJ6JRA9NG5V4'), marketplaceCodeOf('nonsense')]).toEqual(['IT', 'IT', 'IT', null])
  })
  it('an eBay ItemID owned through a shared-listing membership counts', async () => {
    h.members.push({ itemId: '1234', sku: 'V-1', marketplace: 'IT', channelConnectionId: 'conn-B' })
    await expect(assertWriteAccount('EBAY', 'conn-A', { itemIds: ['1234'] })).rejects.toBeInstanceOf(WrongAccountWriteError)
    await expect(assertWriteAccount('EBAY', 'conn-B', { itemIds: ['1234'] })).resolves.toBeUndefined()
  })
  it('Amazon never reads eBay shared-listing memberships', async () => {
    h.members.push({ itemId: '1234', sku: 'V-1', marketplace: 'IT', channelConnectionId: 'conn-B' })
    await expect(assertWriteAccount('AMAZON', 'conn-A', { skus: ['V-1'] })).resolves.toBeUndefined()
  })
  it('when the account NAMES cannot be read, it is still a refusal (with ids), never a crash', async () => {
    listing('1', 'conn-B'); h.namesFail = true
    await expect(assertWriteAccount('EBAY', 'conn-A', { listingIds: ['1'] })).rejects.toMatchObject({ code: 'WRONG_ACCOUNT_WRITE', message: expect.stringContaining('"conn-B"') })
  })
  it('when ownership cannot be read, the write is refused (fail closed)', async () => {
    h.fail = true
    await expect(assertWriteAccount('EBAY', 'conn-A', { listingIds: ['1'] })).rejects.toThrow(/could not confirm which eBay account/)
  })
})

describe('P0.7 — the batch form checks each SKU on its own', () => {
  it('one SKU of another account refuses the whole batch and names it, even when the others are ours', async () => {
    listing('1', 'conn-A', { sku: 'OURS' }); listing('2', 'conn-B', { sku: 'THEIRS' })
    const refusal = await assertWriteAccountPerSku('EBAY', 'conn-A', ['OURS', 'THEIRS', 'UNKNOWN'], 'IT').catch((e) => e)
    expect(refusal).toBeInstanceOf(WrongAccountWriteError)
    expect(refusal.message).toMatch(/SKU THEIRS belong to the eBay account "Second shop"/)
  })
  it('positive control: every SKU ours (or unrecorded) passes', async () => {
    listing('1', 'conn-A', { sku: 'OURS' })
    await expect(assertWriteAccountPerSku('EBAY', 'conn-A', ['OURS', 'UNKNOWN'], 'IT')).resolves.toBeUndefined()
  })
  it('the union rule would have let THEIRS through; the per-SKU rule does not (why batches use it)', async () => {
    listing('1', 'conn-A', { sku: 'OURS' }); listing('2', 'conn-B', { sku: 'THEIRS' })
    await expect(assertWriteAccount('EBAY', 'conn-A', { skus: ['OURS', 'THEIRS'] })).resolves.toBeUndefined()
    await expect(assertWriteAccountPerSku('EBAY', 'conn-A', ['OURS', 'THEIRS'])).rejects.toBeInstanceOf(WrongAccountWriteError)
  })
})

// ── Part 2: census ──────────────────────────────────────────────────────────────────────────────
const SRC = fileURLToPath(new URL('../', import.meta.url))
const PRIMARY_EBAY = /channel:\s*['"]EBAY['"],\s*primary:\s*true/
/**
 * Files that pick the primary eBay account but send no eBay LISTING write (read, or
 * Nexus-only).
 *
 * P2.3 removed `routes/ebay-notification.routes.ts` from this list, and the census is
 * what noticed: that file's entry read "notification preferences (P2.3), not a
 * listing", and P2.3 retired exactly those Trading-API preferences. With
 * `resolveEbayAccessToken` gone the file no longer picks the primary account at all,
 * so listing it here would be a stale exemption — the thing the second test below
 * exists to catch.
 */
const NOT_A_LISTING_WRITE: Record<string, string> = {
  'jobs/ebay-status-reconcile.job.ts': 'reads listing status from eBay into Nexus',
  'jobs/ebay-feed-poll.job.ts': 'reads feed task results',
  'routes/listings-syndication.routes.ts': 'creates a local DRAFT campaign row; no eBay call',
  'routes/ebay-description-push.routes.ts': 'relink-item-id reads eBay and writes Nexus; inventory-drift is GET-only',
  'routes/ebay.routes.ts': 'GET inventory item and GET policies (reads)',
  'services/ebay-import.service.ts': 'imports listings into Nexus (reads)',
  'services/ebay-category.service.ts': 'taxonomy reads',
  'services/ebay-inventory-readback.service.ts': 'read-back (reads)',
  'services/listing-reconciliation.service.ts': 'reconciliation reads',
  'services/marketing/ebay-ads-api.service.ts': 'Promoted Listings reads',
  'services/marketing/ebay-ads-write.service.ts': 'Promoted Listings campaigns (ads, not listings; P4.5)',
  'services/marketing/ebay-listing-index.service.ts': 'listing index reads',
  'services/ebay-marketing-dispatch.service.ts': 'Promoted Listings dispatch (ads, not listings; P4.5)',
  'services/ebay-financial-events.service.ts': 'Finances reads',
  'services/reviews/adapters/ebay-feedback.adapter.ts': 'feedback, not listings',
  'services/refunds/refund-publisher.service.ts': 'order refunds, not listings (a Return with no order falls back; see P0.4 record)',
}
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full)
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts') ? [full] : []
  })
}

describe('S8 — a listing found by its own channel SKU (indexed columns only), not only by its product SKU', () => {
  it('a write naming a listing\'s own SKU through another account: refused (before S8 nobody owned that SKU)', async () => {
    listing('1', 'conn-B', { channel: 'AMAZON', sku: 'MASTER', channelSku: 'MASTER-IT' })
    await expect(assertWriteAccount('AMAZON', 'conn-A', { skus: ['MASTER-IT'], marketplace: 'IT' })).rejects.toMatchObject({ code: 'WRONG_ACCOUNT_WRITE', detail: { ownerConnectionIds: ['conn-B'] } })
    await expect(assertWriteAccount('AMAZON', 'conn-B', { skus: ['MASTER-IT'], marketplace: 'IT' })).resolves.toBeUndefined()
    // Its own SKU is per market: in DE nothing names it, so nothing contradicts the write.
    await expect(assertWriteAccount('AMAZON', 'conn-A', { skus: ['MASTER-IT'], marketplace: 'DE' })).resolves.toBeUndefined()
  })
  it('the SKU the channel confirmed (liveChannelSku) counts too', async () => {
    listing('1', 'conn-B', { channel: 'AMAZON', sku: 'MASTER', liveChannelSku: 'MASTER-LIVE' })
    await expect(assertWriteAccount('AMAZON', 'conn-A', { skus: ['MASTER-LIVE'] })).rejects.toBeInstanceOf(WrongAccountWriteError)
  })
  it('parity: the product SKU still finds the listing (a write that still names it is checked as before)', async () => {
    listing('1', 'conn-B', { channel: 'AMAZON', sku: 'MASTER', channelSku: 'MASTER-IT' })
    await expect(assertWriteAccount('AMAZON', 'conn-A', { skus: ['MASTER'] })).rejects.toBeInstanceOf(WrongAccountWriteError)
  })
  it('hot path: ONE statement, the own SKU matched in SQL on channelSku / liveChannelSku, only the account selected', async () => {
    await assertWriteAccount('AMAZON', 'conn-A', { skus: ['X'], marketplace: 'IT' })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].select).toEqual({ channelConnectionId: true })
    expect(h.calls[0].where.OR).toContainEqual({ AND: [{ OR: [{ channelSku: { in: ['X'] } }, { liveChannelSku: { in: ['X'] } }] }, { OR: [{ marketplace: 'IT' }, { region: 'IT' }] }] })
    expect(JSON.stringify(h.calls[0])).not.toMatch(/platformAttributes|flatFileSnapshot|overrideData/)
  })
  it('the batch form: an own SKU of another account refuses the batch and names it; its read selects three small columns', async () => {
    listing('1', 'conn-A', { channel: 'AMAZON', sku: 'OURS' }); listing('2', 'conn-B', { channel: 'AMAZON', sku: 'THEIRS-MASTER', channelSku: 'THEIRS-OWN', liveChannelSku: 'THEIRS-LIVE' })
    const refusal = await assertWriteAccountPerSku('AMAZON', 'conn-A', ['OURS', 'THEIRS-OWN'], 'IT').catch((e) => e)
    expect(refusal).toBeInstanceOf(WrongAccountWriteError)
    expect(refusal.message).toMatch(/SKU THEIRS-OWN belong to the Amazon account "Second shop"/)
    await expect(assertWriteAccountPerSku('AMAZON', 'conn-B', ['THEIRS-OWN', 'THEIRS-LIVE'], 'IT')).resolves.toBeUndefined()
    const own = h.calls.find((c) => JSON.stringify(c.where).includes('channelSku'))
    expect(own.select).toEqual({ channelConnectionId: true, channelSku: true, liveChannelSku: true })
    expect(JSON.stringify(h.calls)).not.toMatch(/platformAttributes|flatFileSnapshot|overrideData/)
  })
  it('only the asked SKUs are judged: a listing found by its own SKU does not bring its other SKU into the batch', async () => {
    // SHARED-X is ours (a product SKU on A) and B's own SKU; B's confirmed old SKU was not asked, so it is not judged.
    listing('1', 'conn-A', { channel: 'AMAZON', sku: 'SHARED-X' }); listing('2', 'conn-B', { channel: 'AMAZON', sku: 'B-MASTER', channelSku: 'SHARED-X', liveChannelSku: 'B-OLD' })
    await expect(assertWriteAccountPerSku('AMAZON', 'conn-A', ['SHARED-X'], 'IT')).resolves.toBeUndefined()
  })
})

describe('P0.7 — census: every primary-account eBay listing writer calls the guard', () => {
  const files = sourceFiles(SRC).map((f) => ({ file: relative(SRC, f), text: readFileSync(f, 'utf8') })).filter(({ text }) => PRIMARY_EBAY.test(text))
  it('finds the known writers (the census is not looking at nothing)', () => {
    const names = files.map((f) => f.file)
    for (const known of ['routes/ebay-flat-file.routes.ts', 'services/bulk-action.service.ts', 'services/listing-wizard/ebay-publish.adapter.ts']) expect(names).toContain(known)
  })
  it('P1.3 — the outbound queue no longer picks the primary eBay account: each row names its own', () => {
    const queue = readFileSync(join(SRC, 'services/outbound-sync.service.ts'), 'utf8')
    expect(PRIMARY_EBAY.test(queue)).toBe(false)
    expect(queue).toMatch(/tryResolveConnection\(\{ accountId: destination\.connectionId \}\)/)
  })
  it('each one either calls the guard or is listed as not writing listings', () => {
    const unguarded = files
      .filter(({ file }) => !(file in NOT_A_LISTING_WRITE))
      .filter(({ text }) => !/assertWriteAccount(PerSku)?\(/.test(text))
      .map(({ file }) => file)
    expect(unguarded).toEqual([])
  })
  it('the not-a-writer list has no stale entries (each still picks the primary account)', () => {
    const names = new Set(files.map((f) => f.file))
    expect(Object.keys(NOT_A_LISTING_WRITE).filter((f) => !names.has(f))).toEqual([])
  })
})
