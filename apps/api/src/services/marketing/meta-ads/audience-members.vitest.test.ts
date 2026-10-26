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
  consent: [] as Array<{ emailSha256: string; emailState: string; connectionOk: boolean; emailConsentAt: Date | null; createdAt: Date; updatedAt: Date }>,
  consentWheres: [] as unknown[],
}))
vi.mock('../../../db.js', () => ({
  default: {
    emailSuppression: { findMany: vi.fn(async (args: { where: unknown }) => { h.where = args.where; return h.rows }) },
    // A stand-in that applies the where it is given (state, account, consent time, creation, updatedAt, notIn), so the
    // test sees what the query keeps; any other key fails the test.
    shopifyMarketingConsent: {
      findMany: vi.fn(async (args: { where: Record<string, any> }) => {
        h.consentWheres.push(args.where)
        const w = args.where
        for (const key of Object.keys(w)) if (!['emailState', 'connection', 'emailConsentAt', 'createdAt', 'updatedAt', 'emailSha256'].includes(key)) throw new Error(`stand-in: unknown key ${key}`)
        const state = (r: { emailState: string }) => (w.emailState === undefined ? true
          : typeof w.emailState === 'string' ? r.emailState === w.emailState
            : w.emailState.in ? w.emailState.in.includes(r.emailState) : r.emailState !== w.emailState.not)
        return h.consent.filter((r) => state(r)
          && (w.connection === undefined || r.connectionOk)
          && (w.emailConsentAt === undefined || (r.emailConsentAt !== null && r.emailConsentAt >= w.emailConsentAt.gte))
          && (w.createdAt === undefined || r.createdAt <= w.createdAt.lte)
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
  addedPeople, replaceBatches, sha256Hex, unionOf,
} from './audience-members.js'
import { MEMBERS_PER_REQUEST } from '../../gateway/meta-audience-rules.js'

beforeEach(() => { h.rows = []; h.where = null; h.consent = []; h.consentWheres = [] })

const OCT = new Date('2026-10-01T00:00:00Z')
const SEP = new Date('2026-09-01T00:00:00Z')
/** A consent row: its Shopify consent time (null: Shopify gave none), when Nexus made it, and when a write last touched it (a backfill bumps it). */
const row = (email: string, emailState: string, connectionOk = true, emailConsentAt: Date | null = new Date('2026-10-20T00:00:00Z'), createdAt = new Date('2026-10-02T00:00:00Z')) =>
  ({ emailSha256: sha256Hex(email), emailState, connectionOk, emailConsentAt, createdAt, updatedAt: new Date('2026-10-26T06:00:00Z') })

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
      row('old@example.com', 'SUBSCRIBED', true, SEP),
      row('timeless@example.com', 'SUBSCRIBED', true, null),
    ]
    h.rows = [{ email: 'OptOut@example.com ' }]
    const all = await consentedPeople(null)
    expect(all).toEqual({ hashes: [sha256Hex('yes@example.com'), sha256Hex('old@example.com'), sha256Hex('timeless@example.com')].sort(), skipped: 0 })
    expect(h.consentWheres.at(-1)).toEqual({
      emailState: 'SUBSCRIBED',
      connection: { is: { channelType: 'SHOPIFY', isActive: true, workspaceId: 'ws-a' } },
      emailSha256: { notIn: [sha256Hex('optout@example.com')] },
    })
    // The opt-outs are read for every day (an old opt-out still holds), only the consent rows by since.
    expect(h.where).toEqual({ channel: null, source: { in: [...OPT_OUT_SOURCES] } })
    // Review NIT 4 — since is Shopify's consent time: every row here was touched by today's backfill (updatedAt), and that
    // changes nothing; a yes Shopify gave no time for is sent only without since.
    expect(await consentedPeople(OCT)).toEqual({ hashes: [sha256Hex('yes@example.com')], skipped: 0 })
    expect(h.consentWheres.at(-1)).toMatchObject({ emailConsentAt: { gte: OCT } })
    expect(h.consentWheres.at(-1)).not.toHaveProperty('updatedAt')
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
  it('review FIX-1 — a yes that ended is UNSUBSCRIBED only: a buyer who never said yes is never taken out, not even in a DELETE', async () => {
    h.consent = [
      row('ended@example.com', 'UNSUBSCRIBED'),
      row('never@example.com', 'NOT_SUBSCRIBED'),
      row('pending@example.com', 'PENDING'),
      row('invalid@example.com', 'INVALID'),
      row('redacted@example.com', 'REDACTED'),
      row('both@example.com', 'UNSUBSCRIBED'),
      row('both@example.com', 'SUBSCRIBED'),
      row('elsewhere@example.com', 'UNSUBSCRIBED'),
      row('elsewhere@example.com', 'SUBSCRIBED', false),
      row('early@example.com', 'UNSUBSCRIBED', true, SEP),
    ]
    const since = await consentEndedPeople(OCT)
    expect(since).toEqual({ hashes: [sha256Hex('ended@example.com'), sha256Hex('elsewhere@example.com')].sort(), skipped: 0 })
    expect(h.consentWheres[0]).toEqual({ emailState: 'UNSUBSCRIBED', emailConsentAt: { gte: OCT } })
    const all = await consentEndedPeople(null)
    expect(all.hashes).toContain(sha256Hex('early@example.com'))
    for (const never of ['never@example.com', 'pending@example.com', 'invalid@example.com', 'redacted@example.com']) {
      expect(since.hashes).not.toContain(sha256Hex(never))
      expect(all.hashes).not.toContain(sha256Hex(never))
    }
  })
  it('review FIX-2 — the undo of an add: yes or ended rows Nexus already held when the add ran, with the add\'s own since', async () => {
    const ranAt = new Date('2026-10-10T12:00:00Z')
    const changed = { ...row('old-address@example.com', 'SUBSCRIBED'), emailSha256: sha256Hex('new-address@example.com') }
    h.consent = [
      row('sent@example.com', 'SUBSCRIBED'),
      row('sent-then-ended@example.com', 'UNSUBSCRIBED'),
      row('other-add@example.com', 'SUBSCRIBED', false),
      row('never@example.com', 'NOT_SUBSCRIBED'),
      row('moved@example.com', 'INVALID'),
      row('later@example.com', 'SUBSCRIBED', true, new Date('2026-10-20T00:00:00Z'), new Date('2026-10-11T00:00:00Z')),
      changed,
      // erased@example.com (customers/redact) and uninstalled@example.com (app/uninstalled) have no row any more.
    ]
    const undo = await addedPeople(ranAt, null)
    expect(h.consentWheres.at(-1)).toEqual({ emailState: { in: ['SUBSCRIBED', 'UNSUBSCRIBED'] }, createdAt: { lte: ranAt } })
    // Who it takes out: whom it sent, a yes that ended since, and (Nexus keeps no list) someone another add may have put in.
    for (const out of ['sent@example.com', 'sent-then-ended@example.com', 'other-add@example.com']) expect(undo.hashes).toContain(sha256Hex(out))
    // Never a person who never said yes, nor a row Nexus made after the add ran.
    for (const stays of ['never@example.com', 'later@example.com']) expect(undo.hashes).not.toContain(sha256Hex(stays))
    // What it cannot reach: a state now neither yes nor ended, an e-mail changed at Shopify since (only the new hash is
    // held), a person erased since or a shop uninstalled since (no row).
    expect(undo.hashes).not.toContain(sha256Hex('moved@example.com'))
    expect(undo.hashes).not.toContain(sha256Hex('old-address@example.com'))
    expect(undo.hashes).toContain(sha256Hex('new-address@example.com'))
    for (const gone of ['erased@example.com', 'uninstalled@example.com']) expect(undo.hashes).not.toContain(sha256Hex(gone))
    // The add's own since (Shopify's consent time) narrows it, never past whom the add sent.
    const narrowed = await addedPeople(ranAt, OCT)
    expect(h.consentWheres.at(-1)).toEqual({ emailState: { in: ['SUBSCRIBED', 'UNSUBSCRIBED'] }, createdAt: { lte: ranAt }, emailConsentAt: { gte: OCT } })
    expect(narrowed.hashes).toContain(sha256Hex('sent@example.com'))
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
