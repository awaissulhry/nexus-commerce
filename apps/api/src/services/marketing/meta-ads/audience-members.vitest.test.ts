/**
 * Meta step 31 — the people of a customer list (D8): the people who opted out are read with the opt-out filter IN the
 * database query, normalised and hashed at once (Meta's rule: trim, lower case, SHA-256 lowercase hex), sorted, each
 * once; requests of at most 10,000; Meta's answer gives counts only. Consent PR 2 — the people an upload may send:
 * Shopify buyers who said yes (SUBSCRIBED) on an ACTIVE Shopify account this business owns, less every opt-out, all in
 * the database query; the people whose Shopify consent ended; a replace as one session. example.com addresses only —
 * never a snapshot of an address or a hash.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rows: [] as Array<{ email: string }>,
  where: null as unknown,
  consent: [] as Array<{ emailSha256: string; emailState: string; connectionOk: boolean; updatedAt: Date }>,
  consentWheres: [] as unknown[],
}))
vi.mock('../../../db.js', () => ({
  default: {
    emailSuppression: { findMany: vi.fn(async (args: { where: unknown }) => { h.where = args.where; return h.rows }) },
    // A stand-in that applies the where it is given (state, account, since, notIn), so the test sees what the query keeps.
    shopifyMarketingConsent: {
      findMany: vi.fn(async (args: { where: Record<string, any> }) => {
        h.consentWheres.push(args.where)
        const w = args.where
        return h.consent.filter((r) => (w.emailState === undefined || (typeof w.emailState === 'string' ? r.emailState === w.emailState : r.emailState !== w.emailState.not))
          && (w.connection === undefined || r.connectionOk)
          && (w.updatedAt === undefined || r.updatedAt >= w.updatedAt.gte)
          && (w.emailSha256 === undefined || !w.emailSha256.notIn.includes(r.emailSha256)))
          .map((r) => ({ emailSha256: r.emailSha256 }))
      }),
    },
  },
}))
vi.mock('@nexus/database/workspace-context', () => ({ workspaceIdForQuery: () => 'ws-a' }))

import {
  consentedPeople, consentEndedPeople, MAX_OPT_OUTS_SUBTRACTED, memberBatches, memberCounts, newSessionId, normalisedEmail, NO_CONSENT, optedOutPeople, OPT_OUT_SOURCES,
  replaceBatches, sha256Hex, shopifyConsentPeople, unionOf,
} from './audience-members.js'
import { MEMBERS_PER_REQUEST } from '../../gateway/meta-audience-rules.js'

beforeEach(() => { h.rows = []; h.where = null; h.consent = []; h.consentWheres = [] })

const OCT = new Date('2026-10-01T00:00:00Z')
const row = (email: string, emailState: string, connectionOk = true, updatedAt = new Date('2026-10-20T00:00:00Z')) => ({ emailSha256: sha256Hex(email), emailState, connectionOk, updatedAt })

describe('consent (D8) — the switch-off words', () => {
  it('say the switch is off, who turns it on, and that taking people out needs none', () => {
    expect(NO_CONSENT).toMatch(/Uploading customer lists to Meta is switched off for this business/)
    expect(NO_CONSENT).toMatch(/Settings › Channels › Meta, "Upload customer lists to Meta"\); Claude cannot/)
    expect(NO_CONSENT).toMatch(/never Amazon, eBay or Etsy buyers/)
    expect(NO_CONSENT).toMatch(/needs no switch/)
  })
})

describe('consent PR 2 — who an upload may send', () => {
  it('SUBSCRIBED rows of an ACTIVE Shopify account this business owns, less every opt-out — every filter in the database query', async () => {
    h.consent = [
      row('yes@example.com', 'SUBSCRIBED'),
      row('no@example.com', 'UNSUBSCRIBED'),
      row('pending@example.com', 'PENDING'),
      row('gone@example.com', 'SUBSCRIBED', false),
      row('optout@example.com', 'SUBSCRIBED'),
      row('old@example.com', 'SUBSCRIBED', true, new Date('2026-09-01T00:00:00Z')),
    ]
    h.rows = [{ email: 'OptOut@example.com ' }]
    const all = await consentedPeople(null)
    expect(all).toEqual({ hashes: [sha256Hex('yes@example.com'), sha256Hex('old@example.com')].sort(), skipped: 0 })
    expect(h.consentWheres.at(-1)).toEqual({
      emailState: 'SUBSCRIBED',
      connection: { is: { channelType: 'SHOPIFY', isActive: true, workspaceId: 'ws-a' } },
      emailSha256: { notIn: [sha256Hex('optout@example.com')] },
    })
    // The opt-outs are read for every day (an old opt-out still holds), only the consent rows by since.
    expect(h.where).toEqual({ channel: null, source: { in: [...OPT_OUT_SOURCES] } })
    expect(await consentedPeople(OCT)).toEqual({ hashes: [sha256Hex('yes@example.com')], skipped: 0 })
    expect(h.consentWheres.at(-1)).toMatchObject({ updatedAt: { gte: OCT } })
    // Nothing of a plain address leaves.
    expect(JSON.stringify(all)).not.toContain('example.com')
  })
  it('a stored value that is no SHA-256 is counted, never sent; one person on two accounts goes once', async () => {
    h.consent = [row('yes@example.com', 'SUBSCRIBED'), row('yes@example.com', 'SUBSCRIBED'), { ...row('x@example.com', 'SUBSCRIBED'), emailSha256: 'NOT-A-HASH' }]
    expect(await consentedPeople(null)).toEqual({ hashes: [sha256Hex('yes@example.com')], skipped: 1 })
    expect(h.consentWheres.at(-1)).not.toHaveProperty('emailSha256')
  })
  it('too many opt-outs to subtract in one query: nobody is uploaded, said in words', async () => {
    h.rows = Array.from({ length: MAX_OPT_OUTS_SUBTRACTED + 1 }, (_, i) => ({ email: `p${i}@example.com` }))
    expect(await consentedPeople(null)).toEqual({ refusal: expect.stringMatching(/uploads nobody rather than someone who said no/) })
    expect(h.consentWheres).toHaveLength(0)
  })
  it('consent ended: rows no longer SUBSCRIBED since a day, unless the person still says yes on an active account of the business', async () => {
    h.consent = [
      row('ended@example.com', 'UNSUBSCRIBED'),
      row('both@example.com', 'UNSUBSCRIBED'),
      row('both@example.com', 'SUBSCRIBED'),
      row('elsewhere@example.com', 'UNSUBSCRIBED'),
      row('elsewhere@example.com', 'SUBSCRIBED', false),
      row('early@example.com', 'INVALID', true, new Date('2026-09-01T00:00:00Z')),
    ]
    expect(await consentEndedPeople(OCT)).toEqual({ hashes: [sha256Hex('ended@example.com'), sha256Hex('elsewhere@example.com')].sort(), skipped: 0 })
    expect(h.consentWheres[0]).toEqual({ emailState: { not: 'SUBSCRIBED' }, updatedAt: { gte: OCT } })
    expect((await consentEndedPeople(null)).hashes).toContain(sha256Hex('early@example.com'))
  })
  it('the undo of an add: everyone with a consent row (any state) since its day; two lists as one', async () => {
    h.consent = [row('a@example.com', 'SUBSCRIBED'), row('b@example.com', 'UNSUBSCRIBED', false), row('c@example.com', 'SUBSCRIBED', true, new Date('2026-09-01T00:00:00Z'))]
    expect((await shopifyConsentPeople(OCT)).hashes).toEqual([sha256Hex('a@example.com'), sha256Hex('b@example.com')].sort())
    expect(h.consentWheres.at(-1)).toEqual({ updatedAt: { gte: OCT } })
    expect((await shopifyConsentPeople(null)).hashes).toHaveLength(3)
    expect(unionOf({ hashes: ['b', 'a'], skipped: 1 }, { hashes: ['a', 'c'], skipped: 0 })).toEqual({ hashes: ['a', 'b', 'c'], skipped: 1 })
  })
})

describe('consent PR 2 — a replace is one session', () => {
  it('batch_seq from 1, the last flagged, the total; one id per session; the plan reads no id', () => {
    const hashes = Array.from({ length: MEMBERS_PER_REQUEST + 3 }, (_, i) => sha256Hex(`p${i}@example.com`)).sort()
    const batches = replaceBatches(hashes, 123456789)
    expect(batches.map((b) => JSON.parse(b.params.session))).toEqual([
      { session_id: 123456789, batch_seq: 1, last_batch_flag: false, estimated_num_total: MEMBERS_PER_REQUEST + 3 },
      { session_id: 123456789, batch_seq: 2, last_batch_flag: true, estimated_num_total: MEMBERS_PER_REQUEST + 3 },
    ])
    expect(batches.map((b) => b.planParams.session)).toEqual([
      `{"batch_seq":1,"last_batch_flag":false,"estimated_num_total":${MEMBERS_PER_REQUEST + 3}}`,
      `{"batch_seq":2,"last_batch_flag":true,"estimated_num_total":${MEMBERS_PER_REQUEST + 3}}`,
    ])
    expect(JSON.parse(batches[1].params.payload)).toEqual({ schema: 'EMAIL_SHA256', data: hashes.slice(MEMBERS_PER_REQUEST) })
    // A new id each time, a positive whole number JSON keeps exact.
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(Number.isSafeInteger(id) && id > 0).toBe(true)
    expect(JSON.parse(replaceBatches([hashes[0]])[0].params.session)).toMatchObject({ batch_seq: 1, last_batch_flag: true, estimated_num_total: 1 })
  })
})

describe('normalising and hashing (custom-audiences guide #hash)', () => {
  it('trims and lower-cases an e-mail; refuses what is no address', () => {
    expect(normalisedEmail('  Mary@Example.COM ')).toBe('mary@example.com')
    expect(normalisedEmail('not an address')).toBeNull()
    expect(normalisedEmail('a b@example.com')).toBeNull()
    expect(normalisedEmail(undefined)).toBeNull()
  })
  it('SHA-256 in lowercase hex: Meta\'s own example', () => {
    // Meta's guide: hash("sha256", "mary@example.com") = f1904cf1…bb79.
    expect(sha256Hex('mary@example.com')).toBe('f1904cf1a9d73a55fa5de0ac823c4403ded71afd4c3248d00bdcd0866552bb79')
  })
})

describe('the people who opted out', () => {
  it('the opt-out filter is in the database query: every channel, a "no" (never a bounce), since a day', async () => {
    h.rows = [{ email: 'B@example.com' }, { email: 'a@example.com ' }, { email: 'b@example.com' }, { email: 'broken' }]
    const people = await optedOutPeople(new Date('2026-10-01T00:00:00Z'))
    expect(h.where).toEqual({ channel: null, source: { in: [...OPT_OUT_SOURCES] }, createdAt: { gte: new Date('2026-10-01T00:00:00Z') } })
    expect(OPT_OUT_SOURCES).not.toContain('BOUNCE_HARD')
    expect(people.hashes).toEqual([sha256Hex('a@example.com'), sha256Hex('b@example.com')].sort())
    expect(people.skipped).toBe(1)
    // Nothing of the plain addresses is kept.
    expect(JSON.stringify(people)).not.toContain('example.com')
    await optedOutPeople(null)
    expect(h.where).toEqual({ channel: null, source: { in: [...OPT_OUT_SOURCES] } })
  })
})

describe('the requests', () => {
  it('at most 10,000 hashes each, the payload only: no session id, so two runs with the same people never reuse one (review B1)', () => {
    const hashes = Array.from({ length: MEMBERS_PER_REQUEST + 3 }, (_, i) => sha256Hex(`p${i}@example.com`)).sort()
    const batches = memberBatches(hashes)
    expect(batches.map((b) => b.count)).toEqual([MEMBERS_PER_REQUEST, 3])
    expect(batches.every((b) => Object.keys(b.params).join(',') === 'payload')).toBe(true)
    expect(JSON.parse(batches[1].params.payload)).toEqual({ schema: 'EMAIL_SHA256', data: hashes.slice(MEMBERS_PER_REQUEST) })
    // Built again (the run after the preview, or a second change with the same people): the same requests, no id in them.
    const again = memberBatches(hashes)
    expect(again).toEqual(batches)
    expect(JSON.stringify(again)).not.toMatch(/session/)
  })
  it('Meta\'s answer: its counts only, never its invalid-entry samples', () => {
    expect(memberCounts({ num_received: 2, num_invalid_entries: '1', invalid_entry_samples: { x: 'y' } })).toEqual({ received: 2, invalid: 1 })
    expect(memberCounts(null)).toEqual({ received: null, invalid: null })
  })
})
