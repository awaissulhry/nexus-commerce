/**
 * P4.3d — `routedCeiling` behaviourally: the number the three send lanes cap to,
 * and the refusal they return when nothing is routed.
 *
 * The arithmetic is proved next door in `routed-oversell-ceiling.p43`. What this
 * file proves is the wiring the lanes actually run: the ledger the product
 * FOLLOWS (its own warehouses, or the pool), routed by the listing's market and
 * its source pins, with the listing's buffer on top — and that "nothing routed"
 * comes back as a refusal rather than a ceiling of zero.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { syncLedgerOf } from './sync-control-core.js'

const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return { outbound, loadSyncLedgers: vi.fn() }
})
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('./stock-pool/sync-ledgers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./stock-pool/sync-ledgers.js')>()),
  loadSyncLedgers: m.loadSyncLedgers,
}))
const { default: OutboundSyncService } = await import('./outbound-sync.service.js')

const ledgerOf = (rows: Array<[string, number, string[]]>) =>
  syncLedgerOf(rows.map(([locationCode, available, syncRoutes]) => ({ locationCode, available, syncRoutes })))

/** A product on its OWN stock: two warehouses, each serving one market. */
const ownLedger = (rows: Array<[string, number, string[]]>) => ({
  productId: 'p-1',
  source: { kind: 'own' as const },
  ledger: ledgerOf(rows),
  quantity: rows.reduce((s, r) => s + r[1], 0),
  available: rows.reduce((s, r) => s + r[1], 0),
  uncountedIsZero: true,
  fbaBucket: 0,
})

/** A product following a POOL: an uncounted market is unknown, never zero. */
const pooledLedger = (rows: Array<[string, number, string[]]>) => ({
  ...ownLedger(rows),
  source: { kind: 'pool' as const, grantId: 'g-1', ownerWorkspaceId: 'w-1', locations: [] },
  uncountedIsZero: false,
})

const TWO_MARKETS: Array<[string, number, string[]]> = [['IT-MAIN', 10, ['AMAZON:IT']], ['GB-MAIN', 40, ['AMAZON:UK']]]

describe('P4.3d routedCeiling', () => {
  beforeEach(() => { vi.clearAllMocks() })
  const call = (args: Partial<Parameters<any>[0]> = {}) => (OutboundSyncService as any).routedCeiling({
    productId: 'p-1', channel: 'AMAZON', channelLabel: 'Amazon', marketplace: 'IT',
    sourceLocationCodes: [], stockBuffer: 0, ...args,
  })

  it('caps to the routed market, not to every warehouse the product holds', async () => {
    m.loadSyncLedgers.mockResolvedValue(new Map([['p-1', ownLedger(TWO_MARKETS)]]))
    // The whole ledger is 50; Italy is routed 10.
    await expect(call({ marketplace: 'IT' })).resolves.toMatchObject({ available: 10, routedAvailable: 10, locationCodes: ['IT-MAIN'], refusal: null })
    await expect(call({ marketplace: 'UK' })).resolves.toMatchObject({ available: 40, routedAvailable: 40, locationCodes: ['GB-MAIN'], refusal: null })
  })

  it("the listing's buffer comes off the ROUTED number, not the whole ledger", async () => {
    m.loadSyncLedgers.mockResolvedValue(new Map([['p-1', ownLedger(TWO_MARKETS)]]))
    await expect(call({ marketplace: 'IT', stockBuffer: 4 })).resolves.toMatchObject({ available: 6, routedAvailable: 10 })
    // A buffer larger than the routed stock floors at 0 — it does not go negative
    // and it does not fall back to the wider ledger.
    await expect(call({ marketplace: 'IT', stockBuffer: 99 })).resolves.toMatchObject({ available: 0, routedAvailable: 10, refusal: null })
  })

  it("a source pin narrows it further, and a pooled product's pin is ignored (the pool decides)", async () => {
    m.loadSyncLedgers.mockResolvedValue(new Map([['p-1', ownLedger([['IT-MAIN', 10, []], ['GB-MAIN', 40, []]])]]))
    await expect(call({ sourceLocationCodes: ['IT-MAIN'] })).resolves.toMatchObject({ available: 10, locationCodes: ['IT-MAIN'] })
    m.loadSyncLedgers.mockResolvedValue(new Map([['p-1', pooledLedger([['POOL-A', 7, []], ['POOL-B', 8, []]])]]))
    // ledgerInputs drops the pin for a pooled product: both lent warehouses count.
    await expect(call({ sourceLocationCodes: ['POOL-A'] })).resolves.toMatchObject({ available: 15 })
  })

  it('🔴 a POOLED product with nothing routed is REFUSED, not capped to zero', async () => {
    m.loadSyncLedgers.mockResolvedValue(new Map([['p-1', pooledLedger([['IT-MAIN', 10, ['AMAZON:IT']]])]]))
    const result = await call({ marketplace: 'DE' })
    expect(result.refusal).toContain('no stock location is routed to DE')
    expect(result.refusal).toContain('Amazon')
    // The ceiling is still reported as 0 — but the refusal is what the lane reads,
    // so nobody sends that 0. These are two different facts and they stay apart.
    expect(result.available).toBe(0)
  })

  it('positive control: an OWN-stock product with nothing routed is a true zero, not a refusal', async () => {
    // `uncountedIsZero` is the discriminator: a business's own uncounted stock IS
    // zero, so pushing 0 there is honest. Only the pool is unknown.
    m.loadSyncLedgers.mockResolvedValue(new Map([['p-1', ownLedger([['IT-MAIN', 10, ['AMAZON:IT']]])]]))
    await expect(call({ marketplace: 'DE' })).resolves.toMatchObject({ available: 0, routedAvailable: 0, refusal: null })
  })

  it('a routed market that genuinely holds nothing is a zero, not a refusal', async () => {
    m.loadSyncLedgers.mockResolvedValue(new Map([['p-1', pooledLedger([['IT-MAIN', 0, ['AMAZON:IT']]])]]))
    await expect(call({ marketplace: 'IT' })).resolves.toMatchObject({ available: 0, routedAvailable: 0, refusal: null, locationCodes: ['IT-MAIN'] })
  })

  it('a product with no ledger at all is refused, never silently zero', async () => {
    // `ledgerInputs(undefined)` returns uncountedIsZero: false — an absent ledger
    // is unknown, and this is the arm a database hiccup lands in.
    m.loadSyncLedgers.mockResolvedValue(new Map())
    await expect(call({})).resolves.toMatchObject({ available: 0, refusal: expect.stringContaining('cannot be worked out') })
  })

  it.each([['eBay', 'EBAY'], ['Shopify', 'SHOPIFY'], ['Amazon', 'AMAZON']])('%s names itself in its own refusal', async (channelLabel, channel) => {
    m.loadSyncLedgers.mockResolvedValue(new Map())
    const result = await call({ channel, channelLabel, marketplace: 'IT' })
    expect(result.refusal).toContain(`Nothing was sent to ${channelLabel}`)
  })
})

/**
 * A derived census, not a hand-written list: every `routedCeiling` call site must
 * read its refusal. A fourth lane added later is covered without editing this test
 * — which is the whole point, because "a rule learned once and applied in only one
 * of two builders" is the defect shape this package keeps finding.
 *
 * Amazon sheet gaps (bug 3): the Amazon lane's ceiling moved into THE send quantity (`amazon/send-quantity.ts`
 * `routedSendCeiling`, shared with studio Publish), so its call site is counted there, and the lane must read that
 * function's refusal.
 */
describe('P4.3d: every send lane reads the refusal', () => {
  it('each routedCeiling call site checks ceiling.refusal within its own block', async () => {
    const { readFileSync } = await import('node:fs')
    const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const source = readFileSync(new URL('./outbound-sync.service.ts', import.meta.url), 'utf8')
    const shared = readFileSync(new URL('./amazon/send-quantity.ts', import.meta.url), 'utf8')
    // Strip comments: the helper's own doc comment mentions every lane by name.
    const code = strip(source)
    const sharedCode = strip(shared)
    expect(code).toContain('routedCeiling')            // the stripper did not empty the file
    expect(code.length).toBeGreaterThan(source.length / 2)
    expect(sharedCode.length).toBeGreaterThan(shared.length / 2)

    const sitesIn = (text: string, call: RegExp) => {
      const lines = text.split('\n')
      return lines.map((line, i) => ({ line, i, lines })).filter(({ line }) => call.test(line))
    }
    const callSites = [...sitesIn(code, /this\.routedCeiling\(\{/), ...sitesIn(sharedCode, /=\s*routedSendCeiling\(/)]
    // Positive control: three lanes today (eBay and Shopify here, Amazon through the shared send quantity). A drop
    // would otherwise pass silently.
    expect(callSites.length).toBeGreaterThanOrEqual(3)

    for (const { i, lines } of callSites) {
      // 🔴 Match the WHOLE trimmed condition, not the substring. `if (false) { …
      // message: ceiling.refusal … }` keeps the substring and turns the rule off:
      // a `toContain` on part of a condition does not test that condition.
      const window = lines.slice(i, i + 20)
      const tests = window.filter((line) => /^if \(ceiling\.refusal\)/.test(line.trim()))
      expect(tests.length, `the routedCeiling call at line ${i + 1} has ${tests.length} lines testing ceiling.refusal, expected exactly 1`).toBe(1)
    }
    // The Amazon lane sends THE send quantity and reads its refusal; the class's ceiling is the same function.
    expect(code).toMatch(/const sent = amazonSendQuantity\(\{/)
    expect(code.split('\n').filter((line) => /^if \(sent\.code === 'NO_ROUTED_LOCATION'\)/.test(line.trim()))).toHaveLength(1)
    expect(code).toMatch(/return routedSendCeiling\(productLedger, args\)/)
  })
})
