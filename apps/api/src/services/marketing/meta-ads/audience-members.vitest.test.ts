/**
 * Meta step 31 — the people of a customer list (D8): nobody is added (no consent field: the consent query refuses); the
 * people who opted out are read with the opt-out filter IN the database query, normalised and hashed at once (Meta's
 * rule: trim, lower case, SHA-256 lowercase hex), sorted, each once; requests of at most 10,000 with one session; Meta's
 * answer gives counts only. example.com addresses only — never a snapshot of an address or a hash.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rows: [] as Array<{ email: string }>, where: null as unknown }))
vi.mock('../../../db.js', () => ({
  default: { emailSuppression: { findMany: vi.fn(async (args: { where: unknown }) => { h.where = args.where; return h.rows }) } },
}))

import { consentedCustomers, memberBatches, memberCounts, normalisedEmail, NO_CONSENT, optedOutPeople, OPT_OUT_SOURCES, sha256Hex } from './audience-members.js'
import { MEMBERS_PER_REQUEST } from '../../gateway/meta-audience-rules.js'

beforeEach(() => { h.rows = []; h.where = null })

describe('consent (D8)', () => {
  it('the consent query has no field to filter on: it refuses, and says so', () => {
    expect(consentedCustomers()).toEqual({ refusal: NO_CONSENT })
    expect(NO_CONSENT).toMatch(/no consent field exists/)
    expect(NO_CONSENT).toMatch(/uploads nobody/)
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
    expect(people.fingerprint).toBe(sha256Hex(people.hashes.join('\n')))
    // Nothing of the plain addresses is kept.
    expect(JSON.stringify(people)).not.toContain('example.com')
    await optedOutPeople(null)
    expect(h.where).toEqual({ channel: null, source: { in: [...OPT_OUT_SOURCES] } })
  })
})

describe('the requests', () => {
  it('at most 10,000 hashes each, one session: batch_seq from 1, the last flagged, the total estimated; the same every time', () => {
    const hashes = Array.from({ length: MEMBERS_PER_REQUEST + 3 }, (_, i) => sha256Hex(`p${i}@example.com`)).sort()
    const batches = memberBatches(hashes, '1234567890|120000000000040|remove')
    expect(batches.map((b) => b.count)).toEqual([MEMBERS_PER_REQUEST, 3])
    const sessions = batches.map((b) => JSON.parse(b.params.session))
    expect(sessions.map((s) => [s.batch_seq, s.last_batch_flag, s.estimated_num_total])).toEqual([[1, false, MEMBERS_PER_REQUEST + 3], [2, true, MEMBERS_PER_REQUEST + 3]])
    expect(sessions[0].session_id).toBe(sessions[1].session_id)
    expect(Number.isSafeInteger(sessions[0].session_id) && sessions[0].session_id > 0).toBe(true)
    expect(JSON.parse(batches[1].params.payload)).toEqual({ schema: 'EMAIL_SHA256', data: hashes.slice(MEMBERS_PER_REQUEST) })
    // Built again (the run after the preview): the same requests; another list or place: another session.
    expect(memberBatches(hashes, '1234567890|120000000000040|remove')).toEqual(batches)
    expect(JSON.parse(memberBatches(hashes, '1234567890|any|opt-out')[0].params.session).session_id).not.toBe(sessions[0].session_id)
  })
  it('Meta\'s answer: its counts only, never its invalid-entry samples', () => {
    expect(memberCounts({ num_received: 2, num_invalid_entries: '1', invalid_entry_samples: { x: 'y' } })).toEqual({ received: 2, invalid: 1 })
    expect(memberCounts(null)).toEqual({ received: null, invalid: null })
  })
})
