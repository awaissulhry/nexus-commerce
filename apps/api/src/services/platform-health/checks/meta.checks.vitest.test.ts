/**
 * Platform health — the Meta ads connection check (Meta ads step 5), its judge on fixture facts, healthy and failing. Pure:
 * no database and no Meta call (its gather runs on PGlite in platform-health.vitest.test.ts, with the rest). The failing
 * fixtures are what an unattended Meta run must not miss: a token Meta no longer accepts, one about to end that Nexus
 * could not renew, a heartbeat that stopped checking it, a daily read that stopped or lost the token, an ad account Meta
 * disabled (or thinks compromised), Meta throttling Nexus, and calls on an expired API version.
 */
import { describe, expect, it, vi } from 'vitest'

const g = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  accounts: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ model: string; args: Record<string, any> }>,
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => g.connections) }))
vi.mock('../../../db.js', () => ({
  default: {
    metaAdAccount: { findMany: vi.fn(async (args: Record<string, any>) => { g.queries.push({ model: 'metaAdAccount', args }); return g.accounts }) },
    outboundApiCallLog: {
      groupBy: vi.fn(async (args: Record<string, any>) => {
        g.queries.push({ model: 'ledger', args })
        return args.by.includes('errorCode')
          ? [{ connectionId: 'conn-1', errorCode: '80004', _count: { _all: 3 }, _max: { createdAt: new Date('2026-10-21T07:00:00Z') } }, { connectionId: 'conn-1', errorCode: 'RATE_LIMITED_LOCAL', _count: { _all: 9 }, _max: { createdAt: null } }]
          : [{ connectionId: 'conn-1', _count: { _all: 41 } }]
      }),
    },
    notification: { findMany: vi.fn(async (args: Record<string, any>) => { g.queries.push({ model: 'notification', args }); return [{ entityId: 'META:/v20.0/act_1/campaigns' }] }) },
  },
}))

import { gatherMetaHealthFacts, judgeMetaHealth, metaAdsCheck, type MetaConnectionFacts, type MetaHealthFacts } from './meta.checks.js'
import { HEALTH_CHECKS } from '../registry.js'

const NOW = new Date('2026-10-21T08:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const ahead = (ms: number) => new Date(NOW.getTime() + ms).toISOString()

function connection(over: Partial<MetaConnectionFacts> = {}): MetaConnectionFacts {
  return {
    connectionId: 'conn-1', label: 'Meta — Shop A', state: 'ok', stateText: 'Nexus reads the account once a day (read only).',
    token: { checkedAt: ago(3 * HOUR), isValid: true, expiresAt: ahead(45 * DAY), neverExpires: false, missingRequired: [] },
    adAccountId: '1234567890',
    read: { lastReadAt: ago(HOUR), lastSuccessAt: ago(HOUR), lastStatus: 'SUCCESS', lastDataDay: '2026-10-20' },
    account: { status: 1, disableReason: 0 },
    ...over,
  }
}
const facts = (over: Partial<MetaHealthFacts> = {}, c: MetaConnectionFacts = connection()): MetaHealthFacts =>
  ({ readingOn: true, connections: [c], throttles: [], calls: [{ connectionId: 'conn-1', calls: 40 }], versionNotices: 0, ...over })

describe('meta-ads — the Meta connection, from Nexus\'s own records', () => {
  it('is in the registry, last, as a data feed', () => {
    expect(HEALTH_CHECKS[HEALTH_CHECKS.length - 1]).toBe(metaAdsCheck)
    expect(metaAdsCheck).toMatchObject({ id: 'meta-ads', subsystem: 'data-feeds', title: 'Meta ads connection' })
  })
  it('no Meta connection: nothing to watch, ok', () => {
    expect(judgeMetaHealth(facts({ connections: [] }), NOW)).toMatchObject({ status: 'ok', message: expect.stringMatching(/no Meta connection/) })
  })
  it('healthy: a checked token far from its end, today\'s read, an active account, no throttle', () => {
    const v = judgeMetaHealth(facts(), NOW)
    expect(v.status).toBe('ok')
    expect(v.message).toMatch(/healthy/)
    expect(v.likelyCause).toBeNull()
    // Evidence: ids, dates, counts and codes only (never money).
    expect(JSON.stringify(v.evidence)).not.toMatch(/Cents|Micros|budget|spend/i)
  })
  it('a token Meta no longer accepts fails, with the connection\'s own sentence', () => {
    const v = judgeMetaHealth(facts({}, connection({ state: 'sign_in_needed', stateText: 'Meta no longer accepts this business\'s system-user token.' })), NOW)
    expect(v).toMatchObject({ status: 'fail', likelyCause: expect.stringMatching(/no longer accepts/) })
    expect(v.message).toMatch(/no longer accepts/)
  })
  it('a token near its end: warn from 14 days, fail under 7', () => {
    expect(judgeMetaHealth(facts({}, connection({ token: { ...connection().token, expiresAt: ahead(10 * DAY) } })), NOW).status).toBe('warn')
    const v = judgeMetaHealth(facts({}, connection({ token: { ...connection().token, expiresAt: ahead(3 * DAY) } })), NOW)
    expect(v.status).toBe('fail')
    expect(v.message).toMatch(/expires in 3 days and Nexus could not renew it/)
    expect(judgeMetaHealth(facts({}, connection({ token: { ...connection().token, expiresAt: null, neverExpires: true } })), NOW).status).toBe('ok')
  })
  it('a token not checked for 36 hours (the heartbeat stopped) warns', () => {
    const v = judgeMetaHealth(facts({}, connection({ token: { ...connection().token, checkedAt: ago(40 * HOUR) } })), NOW)
    expect(v).toMatchObject({ status: 'warn', message: expect.stringMatching(/last checked 40 hours ago/) })
    expect(judgeMetaHealth(facts({}, connection({ token: { ...connection().token, checkedAt: null } })), NOW).status).toBe('warn')
  })
  it('the daily read: late warns, two days fails, a token lost during it fails, an incomplete one warns, switched off warns', () => {
    expect(judgeMetaHealth(facts({}, connection({ read: { ...connection().read, lastSuccessAt: ago(30 * HOUR) } })), NOW).status).toBe('warn')
    expect(judgeMetaHealth(facts({}, connection({ read: { ...connection().read, lastSuccessAt: ago(55 * HOUR) } })), NOW)).toMatchObject({ status: 'fail', message: expect.stringMatching(/55 hours old/) })
    const lost = judgeMetaHealth(facts({}, connection({ state: 'read_failed', stateText: 'The last read stopped because Meta refused the token then.', read: { ...connection().read, lastStatus: 'AUTH_LOST' } })), NOW)
    expect(lost).toMatchObject({ status: 'fail', message: expect.stringMatching(/refused the token/) })
    expect(judgeMetaHealth(facts({}, connection({ read: { ...connection().read, lastStatus: 'THROTTLED' } })), NOW)).toMatchObject({ status: 'warn', message: expect.stringMatching(/slow down/) })
    expect(judgeMetaHealth(facts({ readingOn: false }), NOW)).toMatchObject({ status: 'warn', message: expect.stringMatching(/switched off/) })
    expect(judgeMetaHealth(facts({}, connection({ state: 'first_read_pending', read: { ...connection().read, lastSuccessAt: null } })), NOW)).toMatchObject({ status: 'warn', message: expect.stringMatching(/first read/) })
  })
  it('no ad account chosen warns; nothing is read', () => {
    expect(judgeMetaHealth(facts({}, connection({ state: 'choose_account', adAccountId: null, account: null })), NOW)).toMatchObject({ status: 'warn', message: expect.stringMatching(/no ad account is chosen/) })
  })
  it('the ad account at Meta: grace period warns (ads still run); disabled, unsettled or a compromised reason fails', () => {
    expect(judgeMetaHealth(facts({}, connection({ account: { status: 9, disableReason: 0 } })), NOW)).toMatchObject({ status: 'warn', message: expect.stringMatching(/grace period/) })
    expect(judgeMetaHealth(facts({}, connection({ account: { status: 3, disableReason: 0 } })), NOW)).toMatchObject({ status: 'fail', message: expect.stringMatching(/Unsettled/) })
    const v = judgeMetaHealth(facts({}, connection({ account: { status: 2, disableReason: 15 } })), NOW)
    expect(v.status).toBe('fail')
    expect(v.message).toMatch(/Disabled: no ad runs/)
    expect(v.message).toMatch(/compromised/)
  })
  it('Meta throttling: five calls in a day warn; Nexus\'s own holds alone do not; a 613 with no subcode always warns', () => {
    const t = (code: string, calls: number, local = false) => ({ connectionId: 'conn-1', code, calls, lastAt: ago(HOUR), local })
    expect(judgeMetaHealth(facts({ throttles: [t('80004', 5)] }), NOW)).toMatchObject({ status: 'warn', message: expect.stringMatching(/throttled 5 calls/) })
    expect(judgeMetaHealth(facts({ throttles: [t('RATE_LIMITED_LOCAL', 30, true), t('80004', 2)] }), NOW).status).toBe('ok')
    expect(judgeMetaHealth(facts({ throttles: [t('613', 1)] }), NOW)).toMatchObject({ status: 'warn', message: expect.stringMatching(/abuse protection/) })
    // Another connection's throttles are not this one's.
    expect(judgeMetaHealth(facts({ throttles: [{ ...t('80004', 9), connectionId: 'conn-2' }] }), NOW).status).toBe('ok')
  })
  it('a call Meta upgraded from an expired API version warns', () => {
    expect(judgeMetaHealth(facts({ versionNotices: 2 }), NOW)).toMatchObject({ status: 'warn', message: expect.stringMatching(/expired API version/) })
  })
})

describe('meta-ads — the gather reads Nexus\'s own records only (review A5)', () => {
  it('maps each connection with the account as last read, the ledger\'s throttles (Nexus\'s own holds apart) and the version notices', async () => {
    g.queries.length = 0
    g.connections = [{
      connectionId: 'conn-1', label: 'Meta — Shop A', state: 'ok', stateText: 'ok',
      token: { checkedAt: ago(HOUR), isValid: true, expiresAt: ahead(40 * DAY), neverExpires: false, missing: [{ scope: 'ads_read', required: true }, { scope: 'catalog_management', required: false }] },
      adAccount: { adAccountId: '1234567890' }, read: { lastReadAt: ago(HOUR), lastStatus: 'SUCCESS', lastDataDay: '2026-10-20' },
    }]
    g.accounts = [{ adAccountId: '1234567890', accountStatus: 9, disableReason: 0, lastSuccessAt: new Date(NOW.getTime() - 2 * HOUR) }]
    const facts = await gatherMetaHealthFacts(NOW)
    expect(facts.connections[0]).toMatchObject({
      connectionId: 'conn-1', adAccountId: '1234567890', account: { status: 9, disableReason: 0 },
      read: { lastSuccessAt: ago(2 * HOUR), lastStatus: 'SUCCESS' }, token: { missingRequired: ['ads_read'] },
    })
    expect(facts.throttles).toEqual([
      { connectionId: 'conn-1', code: '80004', calls: 3, lastAt: '2026-10-21T07:00:00.000Z', local: false },
      { connectionId: 'conn-1', code: 'RATE_LIMITED_LOCAL', calls: 9, lastAt: null, local: true },
    ])
    expect(facts).toMatchObject({ calls: [{ connectionId: 'conn-1', calls: 41 }], versionNotices: 1, readingOn: true })
    // Meta's rows of the last day only; the deprecation watch's Meta notices of 30 days.
    const ledger = g.queries.filter((q) => q.model === 'ledger')
    expect(ledger.every((q) => q.args.where.channel === 'META' && q.args.where.createdAt.gte.getTime() === NOW.getTime() - DAY)).toBe(true)
    expect(g.queries.find((q) => q.model === 'notification')?.args.where).toMatchObject({ type: 'channel-deprecation', entityId: { startsWith: 'META:' } })
    expect(judgeMetaHealth(facts, NOW)).toMatchObject({ status: 'warn', message: expect.stringMatching(/grace period/) })
  })
  it('no Meta connection: no account read, and the verdict is ok — never "could not measure"', async () => {
    g.queries.length = 0
    g.connections = []
    const facts = await gatherMetaHealthFacts(NOW)
    expect(facts.connections).toEqual([])
    expect(g.queries.some((q) => q.model === 'metaAdAccount')).toBe(false)
    expect(metaAdsCheck.judge(facts, NOW).status).toBe('ok')
  })
})
