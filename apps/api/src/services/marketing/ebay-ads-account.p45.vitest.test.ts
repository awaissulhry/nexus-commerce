/**
 * P4.5a — an eBay Promoted Listings write goes to the campaign's OWN account.
 *
 * ## What was measured first
 *
 * `EbayCampaign.channelConnectionId` is a **required column with a relation**
 * (`schema.prisma:13837`), so every campaign already records the account it belongs
 * to. Every write threw that away: 13 call sites in `ebay-ads-write.service.ts` —
 * plus 6 in `routes/ebay-ads.routes.ts`, 2 in `ebay-ads-reports.service.ts` and 1 in
 * the entity sync, 22 in all — asked `getActiveEbayAdsAuth()` for the **primary**
 * account's token and sent the change with that.
 *
 * P0.7 built the wrong-account guard for listing writes and named this row as the
 * one it was leaving: *"eBay Promoted Listings writes (ads, not listings; P4.5)."*
 *
 * ## Why it had not bitten yet — and why that is the dangerous part
 *
 * Measured on the development database 2026-09-21: **two active eBay connections**
 * (`cmr4aaqb…` primary, `cmt142bli…` not primary) and **13 campaigns, all 13 on the
 * primary**. So "the primary" was the right answer every time.
 *
 * 🔴 The reason it was right every time is the SECOND defect: `syncEbayAdsEntities`
 * also called `getActiveEbayAdsAuth()`, visited that one account and reported
 * `connections: 1`. A second account's campaigns could not enter our database, so no
 * row could ever contradict "the primary".
 *
 * Fixing the sweep ALONE would have made every second-account campaign visible to a
 * write layer that still sent its changes to the first account — turning a latent
 * misroute into a live one. Producer and consumer land in the same change.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HERE = import.meta.dirname
const writeSrc = readFileSync(join(HERE, 'ebay-ads-write.service.ts'), 'utf8')
const syncSrc = readFileSync(join(HERE, 'ebay-ads-entity-sync.service.ts'), 'utf8')
// MCP full control A13 — the eBay reads Claude's ad tools share with the console, and those tools.
const readSrc = readFileSync(join(HERE, 'ebay-ads-read.service.ts'), 'utf8')
const toolsSrc = readFileSync(join(HERE, '..', 'agents', 'tools', 'ads-read.tools.ts'), 'utf8')

/**
 * Lines of real code — comment lines dropped.
 *
 * Both files NAME the old accessor in their headers, to record what they used to do.
 * A census that counted those would fail on the very sentence that explains the fix,
 * and the obvious repair (deleting the sentence) loses the explanation. So the census
 * reads code, and each check below carries a positive control that the pattern still
 * matches something.
 */
const codeLines = (src: string) =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))

// ── Doubles ────────────────────────────────────────────────────────────────
const PRIMARY = 'conn-primary'
const SECOND = 'conn-second'

const connections: Record<string, { id: string; channelType: string; isActive: boolean; isPrimary: boolean }> = {
  [PRIMARY]: { id: PRIMARY, channelType: 'EBAY', isActive: true, isPrimary: true },
  [SECOND]: { id: SECOND, channelType: 'EBAY', isActive: true, isPrimary: false },
  'conn-amazon': { id: 'conn-amazon', channelType: 'AMAZON', isActive: true, isPrimary: false },
  'conn-dead': { id: 'conn-dead', channelType: 'EBAY', isActive: false, isPrimary: false },
}

class NoConnectionError extends Error {}

vi.mock('../connection-resolver.service.js', () => ({
  NoConnectionError,
  resolveConnection: async (scope: any) => {
    if ('accountId' in scope) {
      const row = connections[scope.accountId]
      if (!row) throw new NoConnectionError(`ChannelConnection ${scope.accountId} not found.`)
      if (!row.isActive) throw new NoConnectionError(`ChannelConnection ${scope.accountId} is not active.`)
      return row
    }
    return connections[PRIMARY]
  },
  tryResolveConnection: async () => connections[PRIMARY],
  listActiveConnections: async (channel?: string) =>
    Object.values(connections).filter((c) => c.isActive && (!channel || c.channelType === channel)),
}))

// The token is the account id with a prefix, so an assertion on the token IS an
// assertion on which account the call was made as.
vi.mock('../ebay-auth.service.js', () => ({
  EbayAuthService: class {
    async getValidToken(id: string) {
      if (id === 'conn-notoken') throw new Error('no grant')
      return `token-for-${id}`
    }
  },
}))

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { getEbayAdsAuthFor, listEbayAdsAccounts } = await import('./ebay-ads-api.service.js')

// ── 1. The accessor names its account ──────────────────────────────────────
describe('getEbayAdsAuthFor (P4.5a — the account is named, never inferred)', () => {
  it('returns the NAMED account token, not the primary one', async () => {
    const auth = await getEbayAdsAuthFor(SECOND)
    expect(auth).toEqual({ connectionId: SECOND, token: `token-for-${SECOND}` })
    // The control: had it fallen back, this is what we would have seen.
    expect(auth.token).not.toBe(`token-for-${PRIMARY}`)
  })

  it('the primary account through the same door is still the primary (control)', async () => {
    expect(await getEbayAdsAuthFor(PRIMARY)).toEqual({ connectionId: PRIMARY, token: `token-for-${PRIMARY}` })
  })

  it('REFUSES a disconnected account rather than falling through to a live one', async () => {
    // This is the arm "ask for the primary" could never have: the primary is by
    // definition active, so a write aimed at a disconnected account silently
    // became a write to a different, live account.
    await expect(getEbayAdsAuthFor('conn-dead')).rejects.toThrow(/not active/)
  })

  it('REFUSES a connection of another channel', async () => {
    await expect(getEbayAdsAuthFor('conn-amazon')).rejects.toThrow(/is AMAZON, not EBAY/)
  })

  it('REFUSES an id no connection carries', async () => {
    await expect(getEbayAdsAuthFor('conn-nope')).rejects.toThrow(/not found/)
  })
})

// ── 2. The sweep reaches every account ─────────────────────────────────────
describe('listEbayAdsAccounts (P4.5a — every active eBay account, not one)', () => {
  it('returns both active eBay accounts and no other channel', async () => {
    const got = await listEbayAdsAccounts()
    expect(got.map((a) => a.connectionId).sort()).toEqual([PRIMARY, SECOND].sort())
    expect(got.map((a) => a.token)).toEqual(expect.arrayContaining([`token-for-${PRIMARY}`, `token-for-${SECOND}`]))
  })

  it('an account with no usable token does not hide the others', async () => {
    connections['conn-notoken'] = { id: 'conn-notoken', channelType: 'EBAY', isActive: true, isPrimary: false }
    try {
      const got = await listEbayAdsAccounts()
      expect(got.map((a) => a.connectionId).sort()).toEqual([PRIMARY, SECOND].sort())
    } finally {
      delete connections['conn-notoken']
    }
  })
})

// ── 3. The census — derived from the source, so it cannot drift ────────────
describe('census (P4.5a — no ads write resolves "the primary")', () => {
  it('ebay-ads-write.service.ts never calls getActiveEbayAdsAuth', () => {
    // Every function in that file loads its `EbayCampaign` row first, so the
    // account is always on hand. A 14th write path cannot forget it without
    // failing here.
    const hits = codeLines(writeSrc).filter((l) => l.includes('getActiveEbayAdsAuth('))
    expect(hits, `these ads writes would go to the primary account:\n${hits.join('\n')}`).toEqual([])
  })

  it('every auth resolution in the write service names an account', () => {
    const sites = codeLines(writeSrc).filter((l) => /await (authForCampaign|getEbayAdsAuthFor)\(/.test(l))
    // A positive control on the census itself: if the pattern stopped matching,
    // an empty list would read as "nothing to check" instead of "all clean".
    expect(sites.length).toBeGreaterThanOrEqual(13)
    for (const line of sites) {
      expect(line, `an auth call with no argument:\n${line}`).not.toMatch(/\((\s*)\)/)
    }
  })

  it('the entity sync sweeps accounts rather than resolving one', () => {
    const code = codeLines(syncSrc)
    expect(code.filter((l) => l.includes('listEbayAdsAccounts()')).length).toBe(1)
    expect(code.filter((l) => l.includes('getActiveEbayAdsAuth('))).toEqual([])
    // It counts what it reached, so a shortfall is reported rather than assumed.
    expect(syncSrc).toContain('report.connections++')
  })

  it('one account failing its campaign fetch does not end the sweep', () => {
    // The old code `return`ed on a campaigns error. Inside a per-account
    // function that returns from the ACCOUNT, not from the sweep — the
    // difference between "account 2 was skipped" and "account 2 was never tried".
    const fn = syncSrc.slice(syncSrc.indexOf('async function syncOneAccount'))
    expect(fn).toMatch(/report\.errors\.push\(`campaigns \(\$\{auth\.connectionId\}\)/)
    expect(syncSrc).toMatch(/for \(const auth of accounts\) await syncOneAccount\(auth, report\)/)
  })
})

// ── 4. Claude's eBay reads (MCP full control A13) ──────────────────────────
describe('census (A13 — a read names the campaign\'s own account and calls no account)', () => {
  it('the read service resolves no token and makes no eBay call: it reads stored rows only', () => {
    const code = codeLines(readSrc)
    // Positive control: this IS the file with the eBay reads in it.
    expect(code.some((l) => l.includes('export async function ebayAdsCampaigns('))).toBe(true)
    for (const call of ['getActiveEbayAdsAuth(', 'getEbayAdsAuthFor(', 'listEbayAdsAccounts(', 'fetch(', 'gateway']) {
      expect(code.filter((l) => l.includes(call)), `the read service must not call ${call}`).toEqual([])
    }
  })

  it('each campaign\'s account is read from the campaign itself (channelConnectionId), never resolved as "the primary"', () => {
    const fn = readSrc.slice(readSrc.indexOf('export async function ebayCampaignAccounts'))
    expect(fn).toMatch(/connectionId: c\.channelConnectionId/)
    expect(codeLines(readSrc).filter((l) => /isPrimary/.test(l))).toEqual([])
  })

  it("Claude's eBay campaign rows carry that account, and the tools resolve no account either", () => {
    const code = codeLines(toolsSrc)
    expect(code.filter((l) => l.includes('ebayCampaignAccounts(')).length).toBeGreaterThanOrEqual(2)
    expect(code.filter((l) => /account: accountOut\(accounts\.get\(c\.id\)\)/.test(l)).length).toBeGreaterThanOrEqual(2)
    expect(code.filter((l) => /getActiveEbayAdsAuth\(|getEbayAdsAuthFor\(|listEbayAdsAccounts\(/.test(l))).toEqual([])
  })
})
