import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Audit P5/P6 (2026-10-01) — readiness agrees with publish: an eBay main row that publish KNOWS it cannot complete (no
 * item location anywhere, no policy of a kind in this market) is not "Ready"; what publish can fill is never named. And a
 * family new to the readiness index is built after an import, instead of staying "Not computed".
 */
const m = vi.hoisted(() => ({ metadata: {} as unknown, pending: [] as unknown[], anyRow: null as unknown, built: [] as string[] }))
vi.mock('../../db.js', () => ({ default: {
  channelConnection: { findUnique: async () => ({ connectionMetadata: m.metadata }) },
  $queryRaw: async () => m.pending,
  readinessIndex: { findFirst: async () => m.anyRow },
  product: { findUniqueOrThrow: async ({ where }: { where: { id: string } }) => { m.built.push(where.id); throw new Error('rebuild started') } },
} }))
vi.mock('../../lib/database-context.js', async original => ({ ...(await original<object>()), inDatabaseTransaction: async (_db: unknown, work: () => Promise<unknown>) => work() }))

import { addEbayPublishReadiness, ebayPublishReadinessIssues } from './ebay-publish-readiness.js'
import { rebuildImportedFamily } from './readiness-index.service.js'

const READ = { ebayAccountRead: { locations: { readAt: '2026-10-01T10:00:00Z', found: false }, policies: { EBAY_IT: { shipping: false, payment: true, return: true, readAt: '2026-10-01T10:00:00Z' } } } }
const FIELDS = ['itemLocationCountry', 'itemPostalCode', 'itemLocation', 'fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId']
const LABELS: Record<string, string> = { itemPostalCode: 'Item location postal code', fulfillmentPolicyId: 'Shipping policy' }
const issuesFor = (metadata: unknown, values: Record<string, unknown> = {}) => ebayPublishReadinessIssues({ market: 'IT', metadata, env: {},
  valueOf: field => values[field], labelOf: field => LABELS[field] ?? field, keyOf: field => FIELDS.includes(field) ? field : undefined })

describe('what eBay needs for a new listing, in readiness', () => {
  it('names the location and a missing policy when the last eBay read found none', () => {
    expect(issuesFor(READ)).toEqual([
      { key: 'itemPostalCode', label: 'Item location postal code', severity: 'error', message: expect.stringContaining('eBay needs the item location country and a postal code or city') },
      { key: 'fulfillmentPolicyId', label: 'Shipping policy', severity: 'error', message: 'This eBay account has no shipping policy for eBay IT. Create one in eBay (Account › Business policies).' },
    ])
  })
  it('names nothing publish can fill: the row\'s own values, the account default, the stored location', () => {
    expect(issuesFor(READ, { itemLocationCountry: 'IT', itemLocation: 'Rimini', fulfillmentPolicyId: 'ship-1' })).toEqual([])
    expect(issuesFor({ ...READ, itemLocation: { country: 'IT', postalCode: '47822' }, ebayPolicies: { fulfillmentPolicyId: 'f' } })).toEqual([])
  })
  it('names nothing it does not know: an account never read', () => {
    expect(issuesFor({})).toEqual([])
  })
  it('marks only the main row of a listing not yet on eBay, and turns its state to errors', async () => {
    m.metadata = READ
    const columns = FIELDS.map(field => ({ key: `col-${field}`, label: LABELS[field] ?? field, channels: { 'eBay · IT': { store: { kind: 'platformAttributes', path: [field] } } } }))
    const row = (parentId: string | null, live = false) => ({ parentId, listing: live ? { externalListingId: '123' } : null, values: {}, readiness: { state: 'ready', issues: [] as any[] } })
    const main = row(null), child = row('p'), liveMain = row(null, true)
    await addEbayPublishReadiness({ rows: [main, child, liveMain], columns, label: 'eBay · IT', market: 'IT', accountId: 'acc' })
    expect(main.readiness.issues.map(i => i.key)).toEqual(['col-itemPostalCode', 'col-fulfillmentPolicyId'])
    expect(main.readiness.state).toBe('errors')
    expect(child.readiness.issues).toEqual([])
    expect(liveMain.readiness.issues).toEqual([])
  })
})

describe('after an import (P6)', () => {
  beforeEach(() => { m.pending = []; m.anyRow = null; m.built = [] })
  it('a family with no readiness row at all is built', async () => {
    await expect(rebuildImportedFamily('root')).rejects.toThrow('rebuild started')
    expect(m.built).toEqual(['root'])
  })
  it('a family that has rows and nothing pending is left alone', async () => {
    m.anyRow = { id: 'r1' }
    await expect(rebuildImportedFamily('root')).resolves.toBe(0)
    expect(m.built).toEqual([])
  })
})
