/**
 * P4.5e — a disconnect removes the Amazon Ads secrets it used to leave behind.
 *
 * ## The defect, traced end to end
 *
 * FINAL-PLAN §4.1: *"Disconnect calls the channel only for eBay. For Ads, the old
 * per-profile secrets stay, and with profiles OFF the Ads client falls back to them —
 * **Ads calls continue after a disconnect** (`ads-api-client.ts:463-491`)."*
 *
 * The chain, read in the source:
 *
 * 1. `token.service.revoke()` nulls every token column — **on `ChannelConnection`** —
 *    and sets `isActive: false`.
 * 2. `ads-api-client.credentialsFromCore()` calls
 *    `resolveConnection({ channel: 'AMAZON_ADS', primary: true })`, which throws
 *    `NoConnectionError` for an inactive row, and returns **null**.
 * 3. `resolveCredentials` therefore falls through to
 *    `prisma.amazonAdsConnection.findFirst({ where: { isActive: true } })` and reads
 *    that row's intact `credentialsEncrypted` — `{ clientId, clientSecret,
 *    refreshToken }`.
 *
 * 🔴 So the disconnect does not merely fail to revoke at the channel: it **creates the
 * exact condition** under which the legacy fallback fires. The fallback is doing what
 * it was written to do. That is the shape this programme keeps finding — a failure
 * path whose premise stopped being true.
 *
 * Amazon Ads is the only channel with this shape. A census of `credentialsEncrypted`
 * in `schema.prisma` finds three columns; the other two are `Carrier` and
 * `CarrierAccount`, which are shipping carriers, not channels.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const updateManyCalls: any[] = []
let updateManyImpl: (a: any) => Promise<{ count: number }> = async () => ({ count: 0 })

vi.mock('../../db.js', () => ({
  default: {
    amazonAdsConnection: {
      updateMany: async (a: any) => { updateManyCalls.push(a); return updateManyImpl(a) },
    },
  },
}))
const logged: Array<[string, string, any]> = []
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: (m: string, d?: any) => logged.push(['info', m, d]),
    warn: (m: string, d?: any) => logged.push(['warn', m, d]),
    error: (m: string, d?: any) => logged.push(['error', m, d]),
    debug: vi.fn(),
  },
}))

const { clearLegacyChannelCredentials } = await import('./legacy-channel-credentials.js')

beforeEach(() => {
  updateManyCalls.length = 0
  logged.length = 0
  updateManyImpl = async () => ({ count: 9 })
})

describe('clearLegacyChannelCredentials (P4.5e)', () => {
  it('nulls the Amazon Ads credential blob on every row that carries one', async () => {
    const out = await clearLegacyChannelCredentials('AMAZON_ADS')
    expect(out).toEqual([{ table: 'AmazonAdsConnection', cleared: 9 }])
    expect(updateManyCalls).toHaveLength(1)
    expect(updateManyCalls[0].where).toEqual({ credentialsEncrypted: { not: null } })
    expect(updateManyCalls[0].data.credentialsEncrypted).toBeNull()
  })

  it('leaves a sentence on the row saying why it has no credentials', async () => {
    await clearLegacyChannelCredentials('AMAZON_ADS')
    expect(updateManyCalls[0].data.lastError).toMatch(/disconnected by the operator/i)
    expect(updateManyCalls[0].data.lastErrorAt).toBeInstanceOf(Date)
  })

  it('does NOT deactivate the rows — the refusal downstream is what stops the calls', async () => {
    // With the blob gone and isActive untouched, resolveCredentials reaches
    // `if (!conn?.credentialsEncrypted) throw` and every ads call refuses, naming the
    // profile. Deactivating as well would make the disconnect irreversible from the
    // connect flow, because P4.5b deliberately stopped the reconnect callback
    // reasserting isActive — that switch is the operator's.
    await clearLegacyChannelCredentials('AMAZON_ADS')
    expect(Object.keys(updateManyCalls[0].data)).not.toContain('isActive')
  })

  it('touches nothing for any other channel', async () => {
    for (const key of ['EBAY', 'SHOPIFY', 'ETSY', 'AMAZON_SP']) {
      expect(await clearLegacyChannelCredentials(key)).toEqual([])
    }
    expect(updateManyCalls).toEqual([])
  })

  it('a database failure is logged as an ERROR and does not fail the disconnect', async () => {
    // The uncomfortable case: a failure here leaves a live secret behind. But an
    // operator who has decided to disconnect must not be told it failed AND left with
    // a connected account — so the disconnect completes and the log says error.
    updateManyImpl = async () => { throw new Error('connection reset') }
    expect(await clearLegacyChannelCredentials('AMAZON_ADS')).toEqual([])
    const err = logged.find(([level]) => level === 'error')
    expect(err?.[1]).toMatch(/a live secret may remain/)
  })

  it('says nothing when there was nothing to clear', async () => {
    updateManyImpl = async () => ({ count: 0 })
    const out = await clearLegacyChannelCredentials('AMAZON_ADS')
    expect(out).toEqual([{ table: 'AmazonAdsConnection', cleared: 0 }])
    expect(logged.filter(([l]) => l === 'info')).toEqual([])
  })
})

describe('wiring (P4.5e — the sweep is on the one disconnect path)', () => {
  const SRC = join(import.meta.dirname, '..', '..')
  const token = readFileSync(join(SRC, 'services', 'cx', 'token.service.ts'), 'utf8')
  const client = readFileSync(join(SRC, 'services', 'advertising', 'ads-api-client.ts'), 'utf8')

  it('revoke() calls it', () => {
    const revoke = token.slice(token.indexOf('export async function revoke('))
    expect(revoke.slice(0, 3000)).toContain('await clearLegacyChannelCredentials(key)')
  })

  it('it runs AFTER the connection row is cleared, not before', () => {
    // Order matters for the honest reason: the sweep must not run and then have the
    // connection update fail, leaving a disconnected-looking account with no
    // credentials and no disconnect.
    const revoke = token.slice(token.indexOf('export async function revoke('))
    const update = revoke.indexOf('prisma.channelConnection.update')
    const sweep = revoke.indexOf('clearLegacyChannelCredentials(key)')
    expect(update).toBeGreaterThan(-1)
    expect(sweep).toBeGreaterThan(update)
  })

  it('the fallback this defends against is still there (positive control)', () => {
    // If the legacy fallback were removed, this whole slice would be dead code —
    // and a test that passes for that reason is the worst kind.
    expect(client).toContain("? await prisma.amazonAdsConnection.findFirst({ where: { isActive: true } })")
    expect(client).toContain('throw new Error(`[ADS-LIVE] no credentials for profileId=${profileId}`)')
  })

  it('AmazonAdsConnection is the only channel credential store outside the core', () => {
    const schema = readFileSync(join(SRC, '..', '..', '..', 'packages', 'database', 'prisma', 'schema.prisma'), 'utf8')
    const models: string[] = []
    let current = ''
    for (const line of schema.split('\n')) {
      const m = /^model (\w+)/.exec(line)
      if (m) current = m[1]
      if (/^\s+credentialsEncrypted\s/.test(line)) models.push(current)
    }
    // A fourth name appearing here means another channel grew a secret store that a
    // disconnect does not reach.
    expect(models.sort()).toEqual(['AmazonAdsConnection', 'Carrier', 'CarrierAccount'])
  })
})
