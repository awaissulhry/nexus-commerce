/**
 * P4.1 — every eBay Trading rejection reaches its listing.
 *
 * ## What was measured (2026-09-20)
 *
 * P3.2 built the whole path and left the callers to name the listing. The
 * handover recorded that two still did not. A census derived from the source
 * says the real number is **14 Trading WRITE call sites across 12 files, and 0
 * of them pass a listingId** — and one of the two files the handover named
 * (`ebay-shared-fanout.service.ts`) makes no Trading call at all. So no eBay
 * rejection has ever reached a listing on any write path.
 *
 * The census below is derived from the source in this test, not typed out: a
 * list of members goes stale in hours.
 *
 * ## The rules
 *
 * 1. a named listing wins outright;
 * 2. never resolve without the account;
 * 3. a shared eBay item is MANY listings, and the rejection is about all of them;
 * 4. "filed on none" and "never asked" must not look alike.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  itemIdOfTradingXml,
  recordEbayTradingRejection,
  resolveEbayListingIds,
} from './listing-issue-recorder.service.js'

const SRC = join(import.meta.dirname, '..')

/* ── a prisma stub that records what it was asked and what it wrote ───────── */

function stubPrisma(rows: Array<{ id: string }>) {
  const asked: any[] = []
  const written: any[] = []
  return {
    asked,
    written,
    client: {
      channelListing: {
        findMany: async (args: any) => {
          asked.push(args)
          return rows
        },
      },
      listingIssue: {
        upsert: async (args: any) => {
          written.push(args)
          return {}
        },
        updateMany: async () => ({ count: 0 }),
      },
    } as any,
  }
}

const ISSUE = [{ code: '21916584', message: 'Input data for tag <Item.Variations> is invalid', severity: 'ERROR', attributeNames: [], categories: [] }]

/* ── 0. the ItemID extractor ──────────────────────────────────────────────── */

describe('the ItemID the call is about', () => {
  it('reads it from a revise REQUEST, which is where it lives on a revise', () => {
    const xml = '<ReviseFixedPriceItemRequest><Item><ItemID>123456789012</ItemID><SKU>P-1</SKU></Item></ReviseFixedPriceItemRequest>'
    expect(itemIdOfTradingXml(xml)).toBe('123456789012')
  })

  it('reads it from an ANSWER, which is where it lives on an add', () => {
    expect(itemIdOfTradingXml('<AddFixedPriceItemResponse><ItemID>999888777666</ItemID></AddFixedPriceItemResponse>')).toBe('999888777666')
  })

  it('refuses anything that is not an eBay item number', () => {
    // A non-numeric ItemID is the dry-run sentinel or a malformed answer. Taking
    // it would query for a listing that cannot exist and read as "none linked".
    expect(itemIdOfTradingXml('<ItemID>DRYRUN-AddFixedPriceItem</ItemID>')).toBeNull()
    expect(itemIdOfTradingXml('<ItemID></ItemID>')).toBeNull()
    expect(itemIdOfTradingXml('')).toBeNull()
    expect(itemIdOfTradingXml(null)).toBeNull()
  })
})

/* ── 1 & 2. resolution ────────────────────────────────────────────────────── */

describe('1. a listing the caller named wins outright', () => {
  it('uses it and asks the database nothing', async () => {
    const p = stubPrisma([{ id: 'other-listing' }])
    const ids = await resolveEbayListingIds({ listingId: 'named', itemId: '123456789012', connectionId: 'conn-A', prisma: p.client })
    expect(ids).toEqual(['named'])
    expect(p.asked).toEqual([]) // explicit beats inference: no query at all
  })
})

describe('2. never resolve without the account', () => {
  it('returns nothing when the account is unknown', async () => {
    const p = stubPrisma([{ id: 'L1' }])
    expect(await resolveEbayListingIds({ itemId: '123456789012', connectionId: null, prisma: p.client })).toEqual([])
    expect(await resolveEbayListingIds({ itemId: '123456789012', connectionId: undefined, prisma: p.client })).toEqual([])
    // Not "it found nothing" — it never asked. Filing one seller's rejection on
    // another seller's listing is the MAP.3 ratchet's exact refusal.
    expect(p.asked).toEqual([])
  })

  it('returns nothing when there is no ItemID', async () => {
    const p = stubPrisma([{ id: 'L1' }])
    expect(await resolveEbayListingIds({ itemId: null, connectionId: 'conn-A', prisma: p.client })).toEqual([])
    expect(p.asked).toEqual([])
  })

  it('keys the query on BOTH the item and the account', async () => {
    const p = stubPrisma([{ id: 'L1' }])
    await resolveEbayListingIds({ itemId: '123456789012', connectionId: 'conn-A', prisma: p.client })
    expect(p.asked).toHaveLength(1) // positive control: it really did ask
    expect(p.asked[0].where).toEqual({
      channel: 'EBAY',
      externalListingId: '123456789012',
      channelConnectionId: 'conn-A',
    })
  })
})

/* ── 3. a shared item is many listings ────────────────────────────────────── */

describe('3. a shared eBay item is MANY listings', () => {
  it('returns every member, not the first one', async () => {
    const p = stubPrisma([{ id: 'L1' }, { id: 'L2' }, { id: 'L3' }])
    expect(await resolveEbayListingIds({ itemId: '123456789012', connectionId: 'conn-A', prisma: p.client })).toEqual(['L1', 'L2', 'L3'])
  })

  it('files the rejection on every member', async () => {
    // findFirst would have filed a real rejection on an arbitrary one of them and
    // left the other two showing a healthy listing.
    const p = stubPrisma([{ id: 'L1' }, { id: 'L2' }, { id: 'L3' }])
    const result = await recordEbayTradingRejection({
      itemId: '123456789012', connectionId: 'conn-A', issues: ISSUE, prisma: p.client,
    })
    expect(result).toEqual({ listings: 3, issues: 3 })
    expect(p.written.map((w: any) => w.create.listingId).sort()).toEqual(['L1', 'L2', 'L3'])
    expect(p.written[0].create.source).toBe('ebay-write')
    expect(p.written[0].create.code).toBe('21916584')
  })

  it('files in eBay’s own words', async () => {
    const p = stubPrisma([{ id: 'L1' }])
    await recordEbayTradingRejection({ itemId: '123456789012', connectionId: 'conn-A', issues: ISSUE, prisma: p.client })
    expect(p.written[0].create.message).toBe('Input data for tag <Item.Variations> is invalid')
  })
})

/* ── 4. nothing filed is a COUNT, not a silence ───────────────────────────── */

describe('4. "filed on none" and "never asked" do not look alike', () => {
  it('reports zero listings when no listing is linked to the item', async () => {
    const p = stubPrisma([])
    expect(await recordEbayTradingRejection({ itemId: '123456789012', connectionId: 'conn-A', issues: ISSUE, prisma: p.client }))
      .toEqual({ listings: 0, issues: 0 })
    expect(p.asked).toHaveLength(1) // it DID ask — that is the difference
    expect(p.written).toEqual([])
  })

  it('reports zero listings when it could not ask', async () => {
    const p = stubPrisma([{ id: 'L1' }])
    expect(await recordEbayTradingRejection({ itemId: null, connectionId: null, issues: ISSUE, prisma: p.client }))
      .toEqual({ listings: 0, issues: 0 })
    expect(p.asked).toEqual([]) // it did NOT ask
  })

  it('never throws, because an issue row reports on a call rather than being part of one', async () => {
    const broken = { channelListing: { findMany: async () => { throw new Error('db down') } } } as any
    await expect(resolveEbayListingIds({ itemId: '123456789012', connectionId: 'conn-A', prisma: broken })).resolves.toEqual([])
  })
})

/* ── the census, derived ──────────────────────────────────────────────────── */

const WRITE_CALLS = /^(AddFixedPriceItem|ReviseFixedPriceItem|ReviseItem|AddItem|EndFixedPriceItem|EndItem|RelistFixedPriceItem|VerifyAddFixedPriceItem)$/

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'test-support') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, found)
    else if (entry.endsWith('.ts') && !/\.(test|vitest\.test)\.ts$/.test(entry) && !entry.includes('.vitest.')) found.push(full)
  }
  return found
}

/** Every callTradingApi site outside the module itself, with its operation names. */
function tradingCallSites(): Array<{ file: string; names: string[]; write: boolean }> {
  const sites: Array<{ file: string; names: string[]; write: boolean }> = []
  for (const file of sourceFiles(SRC)) {
    if (file.endsWith('ebay-trading-api.service.ts')) continue
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/callTradingApi\(\s*([^,]+),/g)) {
      // The call name is not always a literal: studio-publication-ebay.ts passes
      // `plan.itemId ? 'Revise…' : 'Add…'`. Matching only literals UNDER-COUNTS.
      const names = [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1])
      sites.push({ file: file.replace(SRC + '/', ''), names, write: names.some((n) => WRITE_CALLS.test(n)) })
    }
  }
  return sites
}

describe('the census this package was built from', () => {
  it('finds the eBay Trading call sites at all', () => {
    // Positive control. An empty census makes every claim below vacuously true.
    const sites = tradingCallSites()
    expect(sites.length).toBeGreaterThan(20)
    expect(sites.filter((s) => s.write).length).toBeGreaterThan(10)
  })

  it('can read every call’s operation, including the computed one', () => {
    // A site whose operation cannot be read is a hole in the denominator, not a
    // pass. studio-publication-ebay.ts:224 is a ternary and must still count.
    expect(tradingCallSites().filter((s) => s.names.length === 0)).toEqual([])
    const ternaries = tradingCallSites().filter((s) => s.names.length > 1)
    expect(ternaries.length).toBeGreaterThan(0)
  })

  it('does not depend on any of them naming a listing', () => {
    // The point of P4.1: editing 14 call sites fixes it until the 15th is
    // written. `callTradingApi` resolves the listing itself, so this stays true
    // however many of them name one.
    const trading = readFileSync(join(SRC, 'services', 'ebay-trading-api.service.ts'), 'utf8')
    expect(trading).toContain('recordEbayTradingRejection')
    expect(trading).toContain('resolveEbayListingIds')
    // And the filing is no longer conditional on ctx.listingId alone.
    expect(trading).toMatch(/if \(ctx\.listingId \|\| rejectionItemId\)/)
  })

  it('leaves ONE sender of a Trading listing write, so the rule has one home', () => {
    // The first version of this guard claimed there was exactly one sender of
    // any Trading XML. It was FALSE: five other files carry
    // `X-EBAY-API-CALL-NAME`. Three of them really do send, and each is fine for
    // a written reason. A guard whose claim is too broad gets adjusted until it
    // passes, which is how a guard stops guarding — so the claim is narrowed to
    // what is actually true, with the exemptions named.
    const EXEMPT: Record<string, string> = {
      'services/contract/channel-contracts.ts':
        'P1.8 nightly contract run: VerifyAddFixedPriceItem against a deliberately minimal item that is not a listing. It watches the error vocabulary; there is no ChannelListing to file against. Off by default.',
      'services/marketing/ebay-listing-index.service.ts':
        'READS only: GetMyeBaySelling and GetItem. A read has no rejection to put on a listing.',
      'services/reviews/adapters/ebay-feedback.adapter.ts':
        'Feedback, not listings: RespondToFeedback and GetFeedback. A feedback reply is not a listing defect.',
    }

    const senders = sourceFiles(SRC)
      .filter((f) => !f.endsWith('ebay-trading-api.service.ts'))
      .map((f) => ({ rel: f.replace(SRC + '/', ''), text: readFileSync(f, 'utf8') }))
      // A comment mentioning the header is not a sender. Require it to be set on
      // an object, which is what an actual request does.
      .filter((s) => /['"]X-EBAY-API-CALL-NAME['"]\s*:/.test(s.text))
      .map((s) => s.rel)

    expect(senders.length).toBeGreaterThan(0) // positive control
    expect(senders.filter((f) => !(f in EXEMPT))).toEqual([])
    // And no exemption may go stale: a file that stopped sending must be removed
    // from the list rather than left as a permanent excuse.
    expect(Object.keys(EXEMPT).filter((f) => !senders.includes(f))).toEqual([])
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `${file} needs a real reason`).toBeGreaterThan(60)
    }
  })

  it('no exempt sender performs a Trading listing WRITE', () => {
    // The reason each exemption holds, checked rather than trusted. If
    // ebay-listing-index ever adds a ReviseFixedPriceItem, this fails.
    const WRITE_IN_EXEMPT = /['"]X-EBAY-API-CALL-NAME['"]\s*:\s*['"](AddFixedPriceItem|ReviseFixedPriceItem|ReviseItem|AddItem|EndFixedPriceItem|EndItem|RelistFixedPriceItem)['"]/
    for (const rel of ['services/marketing/ebay-listing-index.service.ts', 'services/reviews/adapters/ebay-feedback.adapter.ts', 'services/contract/channel-contracts.ts']) {
      const text = readFileSync(join(SRC, rel), 'utf8')
      expect(WRITE_IN_EXEMPT.test(text), `${rel} now sends a listing write outside callTradingApi`).toBe(false)
    }
    // Positive control: the pattern DOES match a real listing write.
    expect(WRITE_IN_EXEMPT.test(`'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem'`)).toBe(true)
  })
})
