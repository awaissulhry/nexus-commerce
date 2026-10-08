/**
 * Step 2 "Sells from" — the ledger loader (`loadSyncLedgers`, `loadLedgerChoices`):
 *   • the business's market lists (SyncChannelPolicy.sourceLocationCodes, rows with no account) ride on every own ledger;
 *   • a switched-off warehouse feeds no listing (rows and totals);
 *   • own rows come in sale order: the default warehouse first, then by code;
 *   • a pooled product's ledger carries no list, and its listings' own codes are blanked (`ledgerInputs`).
 */
import { describe, expect, it, vi } from 'vitest'
import { loadLedgerChoices, loadMarketSources, loadSyncLedgers, ledgerInputs } from './sync-ledgers.js'
import { resolveIntendedQuantity, sellsFrom } from '../sync-control-core.js'

type Level = { productId: string; quantity: number; available: number; location: Record<string, unknown> | null }
const loc = (code: string, over: Record<string, unknown> = {}) => ({ type: 'WAREHOUSE', code, syncRoutes: [], isActive: true, warehouse: null, ...over })
const level = (productId: string, location: Record<string, unknown>, quantity: number, available = quantity): Level => ({ productId, quantity, available, location })
const policy = (channel: string, marketplace: string, sourceLocationCodes: string[], over: Record<string, unknown> = {}) =>
  ({ channel, marketplace, sourceLocationCodes, channelConnectionId: null, updatedAt: new Date('2026-10-07T10:00:00Z'), ...over })

function fakeDb(args: { levels: Level[]; policies?: Array<Record<string, unknown>>; pooled?: Array<Record<string, unknown>>; links?: string[] }) {
  const policyFind = vi.fn(async (query?: { where?: { channelConnectionId?: null } }) =>
    (args.policies ?? []).filter((p) => query?.where?.channelConnectionId !== null || p.channelConnectionId == null)
      .filter((p) => (p.sourceLocationCodes as string[]).length > 0))
  return {
    stockLevel: { findMany: vi.fn(async () => args.levels) },
    stockPoolLink: { findMany: vi.fn(async () => (args.links ?? []).map((productId) => ({ productId }))) },
    syncChannelPolicy: { findMany: policyFind },
    $queryRaw: vi.fn(async () => args.pooled ?? []),
    stockPoolGrant: { findUnique: vi.fn(async () => ({ ownerWorkspaceId: 'ws-lender' })) },
  }
}

describe('Step 2 — loadMarketSources', () => {
  it('keeps the non-empty lists of rows with no account, keyed CHANNEL:MARKET, newest first wins', async () => {
    const db = fakeDb({
      levels: [],
      policies: [
        policy('AMAZON', 'IT', ['OLD'], { updatedAt: new Date('2026-10-01T00:00:00Z') }),
        policy('AMAZON', 'IT', ['IT-MAIN', 'MI-3PL']),
        policy('EBAY', 'EBAY_DE', ['MI-3PL']),
        policy('SHOPIFY', '*', ['IT-MAIN']),
        policy('AMAZON', 'FR', ['MI-3PL'], { channelConnectionId: 'acct-1' }),
        policy('AMAZON', 'ES', []),
      ],
    })
    const lists = await loadMarketSources(db as never)
    expect(Object.fromEntries(lists)).toEqual({ 'AMAZON:IT': ['IT-MAIN', 'MI-3PL'], 'EBAY:DE': ['MI-3PL'] })
    expect(db.syncChannelPolicy.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { channelConnectionId: null, NOT: { sourceLocationCodes: { isEmpty: true } } },
    }))
  })
})

describe('Step 2 — loadSyncLedgers', () => {
  it('attaches the market lists to an own ledger, and the core follows them', async () => {
    const db = fakeDb({
      levels: [level('p1', loc('IT-MAIN'), 10), level('p1', loc('MI-3PL'), 4)],
      policies: [policy('AMAZON', 'DE', ['MI-3PL'])],
    })
    const p1 = (await loadSyncLedgers(db as never, ['p1'])).get('p1')!
    expect(p1.ledger.marketSources?.get('AMAZON:DE')).toEqual(['MI-3PL'])
    const follow = (marketplace: string) => resolveIntendedQuantity({
      channel: 'AMAZON', marketplace, isFba: false, followMasterQuantity: true, syncPaused: false, pinnedQuantity: null, stockBuffer: 0,
      channelPolicy: null, ...ledgerInputs(p1, []),
    })
    expect(follow('DE')).toMatchObject({ kind: 'FOLLOW', quantity: 4, routedLocations: ['MI-3PL'] })
    expect(follow('IT')).toMatchObject({ kind: 'FOLLOW', quantity: 14 })
  })

  it('a switched-off warehouse feeds no listing: dropped from the rows and the totals (FBA bucket unchanged)', async () => {
    const db = fakeDb({
      levels: [
        level('p1', loc('IT-MAIN'), 10, 9),
        level('p1', loc('OLD-WH', { isActive: false }), 7),
        level('p1', loc('AMAZON-EU-FBA', { type: 'AMAZON_FBA' }), 5),
      ],
    })
    const p1 = (await loadSyncLedgers(db as never, ['p1'])).get('p1')!
    expect(p1.ledger.map((r) => r.locationCode)).toEqual(['IT-MAIN'])
    expect(p1).toMatchObject({ quantity: 10, available: 9, fbaBucket: 5 })
  })

  it('a product whose only warehouse is switched off has no row: UNCOUNTED, never a manufactured 0', async () => {
    const db = fakeDb({ levels: [level('p1', loc('OLD-WH', { isActive: false }), 0)] })
    const p1 = (await loadSyncLedgers(db as never, ['p1'])).get('p1')!
    expect(p1.ledger).toHaveLength(0)
    expect(resolveIntendedQuantity({
      channel: 'EBAY', marketplace: 'IT', isFba: false, followMasterQuantity: true, syncPaused: false, pinnedQuantity: null, stockBuffer: 0,
      channelPolicy: null, ...ledgerInputs(p1, []),
    })).toEqual({ kind: 'UNCOUNTED' })
  })

  it('own rows come in sale order: the default warehouse first, then by code', async () => {
    const db = fakeDb({
      levels: [
        level('p1', loc('B-WH'), 1),
        level('p1', loc('A-WH'), 1),
        level('p1', loc('Z-MAIN', { warehouse: { isDefault: true, isActive: true } }), 1),
        level('p1', loc('C-WH', { warehouse: { isDefault: true, isActive: false } }), 1),
      ],
    })
    const p1 = (await loadSyncLedgers(db as never, ['p1'])).get('p1')!
    expect(p1.ledger.map((r) => r.locationCode)).toEqual(['Z-MAIN', 'A-WH', 'B-WH', 'C-WH'])
    expect(sellsFrom({ ledger: p1.ledger, channel: 'AMAZON', marketplace: 'IT', sourceLocationCodes: [] }).codes).toEqual(['Z-MAIN', 'A-WH', 'B-WH', 'C-WH'])
  })

  it('a pooled product follows the pool: no market list on its ledger, and its listings\' own codes are blanked', async () => {
    const db = fakeDb({
      levels: [level('p1', loc('IT-MAIN'), 3)],
      policies: [policy('AMAZON', 'IT', ['IT-MAIN'])],
      links: ['p1'],
      pooled: [{ product_id: 'p1', grant_id: 'g1', owner_workspace_id: 'ws-lender', location_id: 'l9', location_code: 'LENDER-WH', quantity: 20, reserved: 0, available: 20 }],
    })
    const p1 = (await loadSyncLedgers(db as never, ['p1'])).get('p1')!
    expect(p1.source.kind).toBe('pool')
    expect(p1.ledger.marketSources).toBeUndefined()
    const inputs = ledgerInputs(p1, ['IT-MAIN'])
    expect(inputs.sourceLocationCodes).toEqual([])
    expect(sellsFrom({ ledger: inputs.ledger, channel: 'AMAZON', marketplace: 'IT', sourceLocationCodes: inputs.sourceLocationCodes })).toMatchObject({ origin: 'routes', codes: ['LENDER-WH'] })
  })
})

describe('Step 2 — loadLedgerChoices (the product switch preview)', () => {
  it('the own choice drops switched-off warehouses and carries the market lists', async () => {
    const db = fakeDb({
      levels: [level('p1', loc('IT-MAIN'), 6), level('p1', loc('OLD-WH', { isActive: false }), 2)],
      policies: [policy('AMAZON', 'IT', ['IT-MAIN'])],
    })
    const choice = (await loadLedgerChoices(db as never, ['p1'], null)).get('p1')!
    expect(choice.own.ledger.map((r) => r.locationCode)).toEqual(['IT-MAIN'])
    expect(choice.own.quantity).toBe(6)
    expect(choice.own.ledger.marketSources?.get('AMAZON:IT')).toEqual(['IT-MAIN'])
    expect(choice.pool).toBeNull()
  })
})
