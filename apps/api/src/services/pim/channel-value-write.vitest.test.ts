import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('../categories/reference-labels.service.js', () => ({ sellerShippingTemplateLabels: async ({ accountId }: { accountId: string }) => ({ [`template-${accountId}`]: 'Standard delivery' }) }))
import { PGlite } from '@electric-sql/pglite'
import { channelValueMutation, storedChannelState } from './channel-value-mutation.js'
import { writeChannelOverrideMerge } from './channel-value-write.js'
import { createReferenceResolver } from './reference-values.service.js'

// Execute the production SQL against disposable PostgreSQL, never the connected catalog.
// Only columns referenced by that statement are needed for this persistence fixture.
const db = new PGlite()
const sqlWriter = {
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.reduce((text, part, i) => text + (i ? `$${i}` : '') + part, '')
    return db.query(sql, values)
  },
}
const primary = { productId: 'fixture-product', channel: 'AMAZON', marketplace: 'IT', aliasKey: '' }
const write = (patch: Record<string, unknown>, remove: string[] = [], coord = primary, connection: string | null = 'account-a') =>
  writeChannelOverrideMerge(sqlWriter, { ...coord, patch, remove }, connection)
const rows = async () => (await db.query<Record<string, any>>('SELECT * FROM "ChannelListing" ORDER BY "id"')).rows

beforeAll(async () => {
  await db.exec(`CREATE TABLE "ChannelListing" (
    "workspaceId" text NOT NULL DEFAULT 'nexus_legacy_workspace',
    "id" text PRIMARY KEY, "productId" text NOT NULL, "channel" text NOT NULL,
    "marketplace" text NOT NULL, "channelMarket" text NOT NULL, "region" text NOT NULL,
    "aliasKey" text NOT NULL, "aliasId" text, "channelConnectionId" text, "overrideData" jsonb,
    "listingStatus" text NOT NULL, "isPublished" boolean NOT NULL, "version" integer NOT NULL,
    "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL,
    UNIQUE NULLS NOT DISTINCT ("workspaceId", "productId", "channel", "marketplace", "channelConnectionId", "aliasKey")
  )`)
}, 30_000)
beforeEach(() => db.exec('TRUNCATE "ChannelListing"'))
afterAll(() => db.close())

describe('channel override persistence', () => {
  it('stores resolved shipping IDs in PostgreSQL and refuses a foreign account’s ID before spending a version', async () => {
    const resolve = createReferenceResolver()
    const commit = async (name: string, accountId: string) => {
      const value = await resolve({ field: 'merchant_shipping_group', value: name, channel: 'AMAZON', marketplace: 'IT', accountId, productType: 'COAT' })
      await write({ merchant_shipping_group: value }, [], primary, accountId)
    }
    await commit('Standard delivery', 'account-a')
    await commit('Standard delivery', 'account-b')
    const before = await rows()
    expect(before.find(row => row.channelConnectionId === 'account-a')?.overrideData.merchant_shipping_group).toBe('template-account-a')
    expect(before.find(row => row.channelConnectionId === 'account-b')?.overrideData.merchant_shipping_group).toBe('template-account-b')
    await expect(commit('template-account-b', 'account-a')).rejects.toThrow('not an available choice')
    expect(await rows()).toEqual(before)
    expect(before.every(row => row.isPublished === false && row.version === 1)).toBe(true)
  })

  it.each([false, 0, '', ['first', null, 'third']].map(value => ({ value })))('round trips an explicit value, clear and inheritance: $value', async ({ value }) => {
    await write({ retained: 'unrelated', legacy: 'old' })
    for (const action of ['SET', 'CLEAR', 'INHERIT'] as const) {
      const mutation = channelValueMutation(undefined, ['field', 'legacy'], action, value)
      await write(mutation.overrideSet, mutation.overrideRemove)
      const [listing] = await rows()
      expect(listing.overrideData.retained).toBe('unrelated')
      expect(listing.overrideData).not.toHaveProperty('legacy')
      expect(storedChannelState(listing, undefined, ['field'])).toEqual(action === 'INHERIT'
        ? { state: 'inherited', value: null }
        : { state: 'stored', value: action === 'CLEAR' ? null : value })
      expect(listing.isPublished).toBe(false)
      expect(listing.listingStatus).toBe('DRAFT')
    }
    expect((await rows())[0].version).toBe(4)
  })

  it('keeps account, alias, market, channel and product coordinates independent', async () => {
    await write({ field: 'primary' })
    await write({ field: 'account-b' }, [], primary, 'account-b')
    await write({ field: 'alias-b' }, [], { ...primary, aliasKey: 'alias-b' })
    await write({ field: 'Germany' }, [], { ...primary, marketplace: 'DE' })
    await write({ field: 'eBay' }, [], { ...primary, channel: 'EBAY' })
    await write({ field: 'another-product' }, [], { ...primary, productId: 'other' })
    await write({}, ['field'])
    const saved = await rows()
    expect(saved).toHaveLength(6)
    expect(saved.find(r => r.aliasKey === 'alias-b').aliasId).toBe('alias-b')
    expect(saved.filter(r => r.aliasKey === '').every(r => r.aliasId === null)).toBe(true)
    expect(saved.filter(r => !Object.hasOwn(r.overrideData, 'field'))).toHaveLength(1)
    expect(saved.map(r => r.overrideData.field).filter(Boolean).sort()).toEqual(['Germany', 'account-b', 'alias-b', 'another-product', 'eBay'])
  })

  it('merges independent simultaneous edits without replacing unrelated JSON', async () => {
    await write({ retained: true })
    await Promise.all([write({ first: 'one' }), write({ second: 'two' })])
    expect((await rows())[0]).toMatchObject({ overrideData: { retained: true, first: 'one', second: 'two' }, version: 3 })
  })

  it('updates one unattributed listing when the account is null', async () => {
    await write({ first: true }, [], primary, null)
    await write({ second: false }, [], primary, null)
    expect(await rows()).toMatchObject([{ channelConnectionId: null, overrideData: { first: true, second: false }, version: 2 }])
  })

  it('rolls a merge back with its containing transaction', async () => {
    await write({ field: 'original' })
    await db.exec('BEGIN')
    await write({ field: 'changed' })
    await db.exec('ROLLBACK')
    expect((await rows())[0]).toMatchObject({ overrideData: { field: 'original' }, version: 1 })
  })
})
