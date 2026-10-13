/**
 * Google Ads step 1a — which Google accounts a business reads (google-accounts.service.ts, contract C1–C3), on a real
 * PostgreSQL with the production schema and every business policy (PGlite), business profiles ON. Google's discovery is a
 * stand-in (its own tests are in cx/connectors/google); it answers only for a Google sign-in this business can see.
 *
 *   C1: a sign-in with nothing chosen says "choose"; another business sees nothing
 *   C2: Google asked at most once per 5 minutes per sign-in (unless forced), per business
 *   C3: only ids Google offered this sign-in, a manager only when it is a discovered path; one link per product; the
 *       ledger row once per change; the account row prepared and the first read queued; another business's sign-in is
 *       not found; another connected sign-in of this business holding the choice is `customer_taken`
 *   the states in words; /api/accounts says "Choose a Google Ads account"
 * Values are made up (public repo).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
const h = vi.hoisted(() => ({ discoveries: 0, enqueued: [] as unknown[] }))
vi.mock('../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, {
    get: (_t, property) => (database.client as unknown as Record<string, unknown>)[property as string],
  }),
}))
const CHOICES = {
  missingProducts: [] as Array<'ads' | 'merchant_center' | 'analytics'>,
  ads: {
    customers: [
      { customerId: '1234567890', name: 'Test advertiser', currency: 'EUR', timeZone: 'Europe/Rome', isTest: false, direct: true, managers: [] },
      { customerId: '1112223334', name: 'Test client', currency: 'USD', timeZone: 'America/Los_Angeles', isTest: true, direct: false, managers: [{ customerId: '9876543210', name: 'Test manager' }] },
      { customerId: '5550001112', name: null, currency: null, timeZone: null, isTest: false, direct: true, managers: [] },
    ],
    error: null,
  },
  merchantCenter: { accounts: [{ id: '5555555555', name: 'Test merchant' }], error: null },
  analytics: { properties: [{ propertyId: '444444444', name: 'Test property', accountName: 'Test analytics account' }], error: null },
}
vi.mock('../cx/connectors/google/discovery.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../cx/connectors/google/discovery.js')>()
  return {
    ...real,
    discoverGoogleChoices: vi.fn(async (connectionId: string) => {
      h.discoveries++
      const row = await database.client.channelConnection.findUnique({ where: { id: connectionId } })
      if (!row || row.channelType !== 'GOOGLE') throw new real.GoogleConnectionNotFound(connectionId)
      return structuredClone(CHOICES)
    }),
  }
})
// No Redis in this test: the modules that load the queue module get none.
vi.mock('../../lib/queue.js', () => ({ redis: { connection: null } }))
vi.mock('../marketing/google-ads/enqueue.js', () => ({
  enqueueGoogleAdsSync: vi.fn(async (input: unknown) => { h.enqueued.push(input); return { queued: true, reason: null } }),
}))

import { GOOGLE_REQUIRED_SCOPES } from '../cx/connectors/google/scopes.js'
import { listAccountRows } from '../accounts/account-rows.service.js'
import {
  __clearGoogleChoicesCache, CHOICES_TTL_MS, choicesAnswer, getChoices, googleAccountState, GoogleConnectionNotFound, listGoogleAccounts, saveSelection,
} from './google-accounts.service.js'

const A = 'gacct_alpha'
const B = 'gacct_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const pick = (adsCustomerId: string, rest: Partial<{ managerCustomerId: string | null; merchantCenterId: string | null; analyticsPropertyId: string | null }> = {}) =>
  ({ adsCustomerId, managerCustomerId: null, merchantCenterId: null, analyticsPropertyId: null, ...rest })
let connA = ''
let connA2 = ''
let connB = ''

const googleConnection = (externalAccountId: string, displayName: string, extra: Record<string, unknown> = {}) => db().channelConnection.create({
  data: { channelType: 'GOOGLE', isActive: true, authStatus: 'connected', externalAccountId, displayName, grantedScopes: GOOGLE_REQUIRED_SCOPES, ...extra },
})
const refused = (work: Promise<unknown>) => work.then(() => { throw new Error('expected a refusal') }, (err: { statusCode?: number; code?: string; message: string }) => ({ status: err.statusCode, code: err.code, message: err.message }))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(
      `INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`,
      [id],
    )
  }
  connA = (await inA(() => googleConnection('test-google-login-a', 'owner.a@example.test'))).id
  connB = (await inB(() => googleConnection('test-google-login-b', 'owner.b@example.test'))).id
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

beforeEach(() => {
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_GOOGLE_ADS_SYNC', '')
  vi.stubEnv('NEXUS_GOOGLE_ADS_SYNC_SCHEDULE', '')
  __clearGoogleChoicesCache()
  h.discoveries = 0
  h.enqueued = []
})

describe('C1 — the Google sign-ins of this business', () => {
  it('a sign-in with nothing chosen says "choose"; its name is never an id; another business sees nothing of it', async () => {
    const items = await inA(() => listGoogleAccounts())
    expect(items).toEqual([{
      connectionId: connA, label: 'owner.a@example.test', state: 'choose_account', stateText: 'Choose a Google Ads account for Nexus to read.',
      authStatus: 'connected', missingProducts: [], ads: null, manager: null, merchantCenter: null, analytics: null,
      read: { lastReadAt: null, lastDataDay: null, nextReadAt: null, lastError: null },
    }])
    expect((await inB(() => listGoogleAccounts())).map((a) => a.connectionId)).toEqual([connB])
  })

  it('/api/accounts: a Google sign-in with no Google Ads account chosen says so', async () => {
    const { accounts } = await inB(() => listAccountRows({ includeDisconnected: false }))
    expect(accounts.find((a) => a.id === connB)).toMatchObject({ channel: 'GOOGLE', health: 'warn', healthReason: 'Choose a Google Ads account' })
  })
})

describe('C2 — what the sign-in can see', () => {
  it('Google asked at most once per 5 minutes per sign-in, unless forced; never for another business\'s sign-in', async () => {
    const now = Date.now()
    await inA(() => getChoices(connA, { now }))
    await inA(() => getChoices(connA, { now: now + 60_000 }))
    expect(h.discoveries).toBe(1)
    await inA(() => getChoices(connA, { force: true }))
    expect(h.discoveries).toBe(2)
    await inA(() => getChoices(connA, { now: Date.now() + CHOICES_TTL_MS + 1 }))
    expect(h.discoveries).toBe(3)
    await expect(inB(() => getChoices(connA))).rejects.toBeInstanceOf(GoogleConnectionNotFound)
  })

  it('an account listed by id only travels with empty currency and time zone, never invented ones', async () => {
    const answer = choicesAnswer(await inA(() => getChoices(connA)))
    expect(answer.ads.customers.find((c) => c.customerId === '5550001112')).toMatchObject({ name: null, currency: '', timeZone: '' })
  })
})

describe('C3 — the choice', () => {
  it('refuses what Google did not offer this sign-in, a manager that is no path, and a sign-in of another business', async () => {
    expect(await refused(inA(() => saveSelection(connA, { adsCustomerId: 'abc' })))).toMatchObject({ status: 400, code: 'invalid' })
    expect(await refused(inA(() => saveSelection(connA, pick('9999999999'))))).toMatchObject({ status: 409, code: 'not_offered' })
    expect(await refused(inA(() => saveSelection(connA, pick('1112223334'))))).toMatchObject({ status: 409, code: 'not_offered', message: expect.stringMatching(/manager account/) })
    expect(await refused(inA(() => saveSelection(connA, pick('1112223334', { managerCustomerId: '1111111111' }))))).toMatchObject({ status: 409, code: 'not_offered' })
    expect(await refused(inA(() => saveSelection(connA, pick('1234567890', { merchantCenterId: '1' }))))).toMatchObject({ status: 409, code: 'not_offered' })
    expect(await refused(inA(() => saveSelection(connA, pick('1234567890', { analyticsPropertyId: '2' }))))).toMatchObject({ status: 409, code: 'not_offered' })
    expect(await refused(inB(() => saveSelection(connA, pick('1234567890'))))).toMatchObject({ status: 404, code: 'not_found' })
    expect(await inA(() => db().googleAccountLink.count())).toBe(0)
    expect(h.enqueued).toEqual([])
  })

  it('saves one link per product, records it once, prepares the account row and queues the first read', async () => {
    const { account } = await inA(() => saveSelection(connA, pick('123-456-7890', { merchantCenterId: '5555555555', analyticsPropertyId: '444444444' }), { userId: 'user-a' }))
    expect(account).toMatchObject({
      connectionId: connA, state: 'first_read_pending', manager: null,
      ads: { customerId: '1234567890', name: 'Test advertiser', currency: 'EUR', timeZone: 'Europe/Rome', isTest: false },
      merchantCenter: { id: '5555555555', name: 'Test merchant' }, analytics: { propertyId: '444444444', name: 'Test property' },
      read: { lastReadAt: null, lastDataDay: null, lastError: null },
    })
    expect(account.stateText).toBe('Nexus has not finished reading “Test advertiser” yet. Campaigns appear when it does.')
    expect(account.read.nextReadAt).toMatch(/T06:25:00\.000Z$/)
    expect(h.enqueued).toEqual([{ customerId: '1234567890', kind: 'BACKFILL' }])
    await inA(async () => {
      expect((await db().googleAccountLink.findMany({ orderBy: { product: 'asc' } })).map((l) => [l.product, l.externalId, l.selectedByUserId, l.workspaceId]))
        .toEqual([['ADS', '1234567890', 'user-a', A], ['GA4', '444444444', 'user-a', A], ['MERCHANT', '5555555555', 'user-a', A]])
      expect(await db().googleAdsCustomer.findMany()).toEqual([expect.objectContaining({ customerId: '1234567890', connectionId: connA, status: 'UNKNOWN', currencyCode: 'EUR', backfillCompletedAt: null })])
      const events = await db().connectionEvent.findMany({ where: { type: 'accounts_linked' } })
      expect(events).toEqual([expect.objectContaining({ connectionId: connA, channelKey: 'GOOGLE', actorUserId: 'user-a' })])
      expect(events[0].detail).toMatchObject({ googleAds: 'Test advertiser', adsCustomerId: '1234567890', merchantCenter: 'Test merchant', analytics: 'Test property', actorKind: 'operator' })
    })
    // The same choice again: nothing changes, nothing more is recorded (the first read is still asked for — it has not run).
    await inA(() => saveSelection(connA, pick('1234567890', { merchantCenterId: '5555555555', analyticsPropertyId: '444444444' })))
    expect(await inA(() => db().connectionEvent.count({ where: { type: 'accounts_linked' } }))).toBe(1)
    // Another business sees none of it.
    await inB(async () => {
      expect(await db().googleAccountLink.count()).toBe(0)
      expect(await db().googleAdsCustomer.count()).toBe(0)
      expect((await listGoogleAccounts())[0]).toMatchObject({ connectionId: connB, state: 'choose_account', ads: null })
    })
  })

  it('a new choice replaces the old one: still one link per product; a product set to none loses its link', async () => {
    const { account } = await inA(() => saveSelection(connA, pick('1112223334', { managerCustomerId: '9876543210' })))
    expect(account).toMatchObject({
      ads: { customerId: '1112223334', name: 'Test client', currency: 'USD', isTest: true },
      manager: { customerId: '9876543210', name: 'Test manager' }, merchantCenter: null, analytics: null, state: 'first_read_pending',
    })
    await inA(async () => {
      expect((await db().googleAccountLink.findMany()).map((l) => [l.product, l.externalId, l.loginCustomerId])).toEqual([['ADS', '1112223334', '9876543210']])
      expect(await db().connectionEvent.count({ where: { type: 'accounts_linked' } })).toBe(2)
    })
  })

  it('another connected Google sign-in of this business holding the choice: customer_taken, never naming anything', async () => {
    connA2 = (await inA(() => googleConnection('test-google-login-a2', 'second.a@example.test'))).id
    const answer = await refused(inA(() => saveSelection(connA2, pick('1234567890'))))
    expect(answer).toMatchObject({ status: 409, code: 'customer_taken' })
    expect(answer.message).not.toMatch(/\d{6,}|example/)
    // Once that sign-in is disconnected, the choice moves.
    await inA(() => db().channelConnection.update({ where: { id: connA }, data: { isActive: false, authStatus: 'disconnected' } }))
    const { account } = await inA(() => saveSelection(connA2, pick('1234567890')))
    expect(account).toMatchObject({ connectionId: connA2, ads: { customerId: '1234567890' } })
    expect(await inA(() => db().googleAccountLink.findMany())).toEqual([expect.objectContaining({ product: 'ADS', connectionId: connA2 })])
  })

  it('after a read: ok with the newest day and the last read; a failed read in words; a lost sign-in', async () => {
    const at = new Date('2026-10-13T06:27:00Z')
    await inA(() => db().googleAdsCustomer.update({
      where: { google_ads_customer: { workspaceId: A, customerId: '1234567890' } },
      data: { lastSyncAt: at, lastSuccessAt: at, lastSyncStatus: 'SUCCESS', metricsReadFrom: new Date('2025-09-08T00:00:00Z'), metricsReadThrough: new Date('2026-10-12T00:00:00Z'), backfillCompletedAt: at },
    }))
    const [ok] = await inA(() => listGoogleAccounts())
    expect(ok).toMatchObject({ state: 'ok', stateText: 'Nexus reads “Test advertiser” once a day.', read: { lastReadAt: at.toISOString(), lastDataDay: '2026-10-12', lastError: null } })
    await inA(() => db().googleAdsCustomer.update({
      where: { google_ads_customer: { workspaceId: A, customerId: '1234567890' } },
      data: { lastSyncAt: new Date('2026-10-14T06:27:00Z'), lastSyncStatus: 'FAILED', lastSyncError: 'Google Ads refused this login access to the account.' },
    }))
    const [failed] = await inA(() => listGoogleAccounts())
    expect(failed).toMatchObject({ state: 'read_failed', read: { lastReadAt: at.toISOString(), lastDataDay: '2026-10-12', lastError: 'Google Ads refused this login access to the account.' } })
    expect(failed.stateText).toMatch(/^The last read of “Test advertiser” failed\. Google Ads refused this login access to the account\./)
  })
})

describe('the states in words', () => {
  const base = { isActive: true, authStatus: 'connected', missingProducts: [] as Array<'ads' | 'merchant_center' | 'analytics'>, adsLinked: true, accountName: 'Test advertiser', customer: null, readingOn: true }
  const read = (over: Record<string, unknown>) => ({ lastSyncAt: null, lastSuccessAt: null, lastSyncStatus: null, lastSyncError: null, metricsReadThrough: null, ...over })
  it.each([
    ['a revoked sign-in', { authStatus: 'needs_reauth' }, 'sign_in_needed'],
    ['a disconnected sign-in', { isActive: false }, 'sign_in_needed'],
    ['Google Ads not ticked', { missingProducts: ['ads'] }, 'permission_missing'],
    ['only Merchant Center not ticked, nothing chosen', { missingProducts: ['merchant_center'], adsLinked: false }, 'choose_account'],
    ['chosen, never read', {}, 'first_read_pending'],
    ['chosen, no allowance yet', { customer: read({ lastSyncStatus: 'SKIPPED_BUDGET', lastSyncError: 'No allowance.' }) }, 'first_read_pending'],
    ['the first read failed', { customer: read({ lastSyncStatus: 'FAILED', lastSyncError: 'No access.' }) }, 'read_failed'],
    ['a manager account chosen', { customer: read({ lastSyncStatus: 'MANAGER', lastSyncError: 'A manager.' }) }, 'read_failed'],
    ['the read lost the sign-in', { customer: read({ lastSyncStatus: 'AUTH_LOST', lastSyncError: 'Reconnect Google.' }) }, 'sign_in_needed'],
    ['read, then a partial read', { customer: read({ lastSyncStatus: 'PARTIAL', lastSyncError: 'Part.', metricsReadThrough: new Date() }) }, 'ok'],
  ])('%s', (_label, over, state) => {
    expect(googleAccountState({ ...base, ...over } as Parameters<typeof googleAccountState>[0]).state).toBe(state)
  })
  it('never says it reads when reading is switched off', () => {
    const text = googleAccountState({ ...base, customer: read({ lastSyncStatus: 'SUCCESS', metricsReadThrough: new Date() }), readingOn: false }).stateText
    expect(text).toBe('Nexus has read “Test advertiser”; reading is switched off on the server for now.')
    expect(googleAccountState({ ...base, readingOn: false })).toEqual({
      state: 'first_read_pending', stateText: 'Nexus has not read “Test advertiser” yet: reading Google Ads is switched off on the server for now.',
    })
  })
})
