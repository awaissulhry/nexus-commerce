/**
 * Meta ads step 6 — the read helpers of live-objects.ts: one object in field groups (a part Meta refuses is named, the
 * core must answer, a lost token or a throttle is never retried), a list page by page with Meta's cursor and total, cut
 * at maxRows, and a list that falls back to its core fields. Meta is stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ operation: string; path: string; query?: Record<string, unknown> }>, answer: null as null | ((req: { operation: string; query?: Record<string, unknown> }) => unknown) }))
vi.mock('./read-client.js', () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: { operation: string; path: string; query?: Record<string, unknown> }) => {
    h.calls.push(req)
    const out = h.answer?.(req)
    if (out instanceof Error) throw out
    return { body: out ?? {}, calls: 1 }
  }),
  metaReadAll: vi.fn(),
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => []) }))
vi.mock('../../../db.js', () => ({ default: {} }))

import { listGroups, listPaged, readGroups, STATUS_WORDS } from './live-objects.js'
import { MetaReadError, failureOfAnswer } from './errors.js'

const refused = (cls: string, code: string, words: string) => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass: cls, channelCode: code, channelMessage: words } as never }), 'x', 1)
const groups = [{ name: 'core', fields: 'id,name' }, { name: 'extra', fields: 'destination_spec' }, { name: 'more', fields: 'instagram_branded_content' }]

beforeEach(() => { h.calls.length = 0; h.answer = null })

describe('readGroups', () => {
  it('asks every group in one call when Meta answers it', async () => {
    h.answer = () => ({ id: '1', name: 'A', destination_spec: {} })
    expect(await readGroups('conn-1', 'op', '120000000000401', groups)).toEqual({ body: { id: '1', name: 'A', destination_spec: {} }, missing: [] })
    expect(h.calls.map((c) => c.query?.fields)).toEqual(['id,name,destination_spec,instagram_branded_content'])
  })
  it('when Meta refuses the whole read, reads each group alone and names the ones Meta refused', async () => {
    h.answer = (req) => (String(req.query?.fields).includes('destination_spec') ? refused('validation', '100', 'nonexisting field (destination_spec)') : { id: '1' })
    const read = await readGroups('conn-1', 'op', '120000000000401', groups)
    expect(read).toEqual({ body: { id: '1' }, missing: [{ part: 'extra', sentence: expect.stringMatching(/destination_spec/) }] })
    expect(h.calls.map((c) => c.operation)).toEqual(['op', 'op.core', 'op.extra', 'op.more'])
  })
  it('the core must answer; a throttle, a lost token or an object not found is never retried part by part', async () => {
    h.answer = () => refused('validation', '100', 'Unsupported get request')
    await expect(readGroups('conn-1', 'op', '1', groups)).rejects.toThrow(/Unsupported get request/)
    for (const [cls, code] of [['rate_limited', '17'], ['auth_revoked', '190'], ['not_found', '100/33']]) {
      h.calls.length = 0
      h.answer = () => refused(cls, code, 'x')
      await expect(readGroups('conn-1', 'op', '1', groups)).rejects.toBeInstanceOf(MetaReadError)
      expect(h.calls).toHaveLength(1)
    }
  })
})

describe('listPaged and listGroups', () => {
  it('pages with the cursor while Meta gives a next page, cut at maxRows (more: true), with Meta\'s total from the first page', async () => {
    h.answer = (req) => ({ data: [{ id: `${req.query?.after ?? 'p0'}-a` }, { id: `${req.query?.after ?? 'p0'}-b` }], paging: { cursors: { after: `${req.query?.after ?? 'p0'}x` }, next: 'n' }, summary: { total_count: 9 } })
    const read = await listPaged('conn-1', 'op', 'act_1234567890/campaigns', { fields: 'id' }, 3, true)
    expect(read).toEqual({ rows: [{ id: 'p0-a' }, { id: 'p0-b' }, { id: 'p0x-a' }], more: true, totalCount: 9 })
    expect(h.calls.map((c) => [c.query?.limit, c.query?.summary ?? null, c.query?.after ?? null])).toEqual([[3, 'total_count', null], [3, null, 'p0x']])
  })
  it('ends without more when Meta gives no next page', async () => {
    h.answer = () => ({ data: [{ id: '1' }], paging: { cursors: { after: 'c' } } })
    expect(await listPaged('conn-1', 'op', 'x', {}, 100)).toEqual({ rows: [{ id: '1' }], more: false, totalCount: null })
  })
  it('a list Meta refuses with its full fields is read with its core fields and says which details are missing', async () => {
    h.answer = (req) => (String(req.query?.fields).includes('destination_spec') ? refused('validation', '100', 'nonexisting field') : { data: [{ id: '1' }] })
    const read = await listGroups('conn-1', 'op', 'act_1234567890/adcreatives', groups, {}, 10)
    expect(read.rows).toEqual([{ id: '1' }])
    expect(read.missing.map((m) => m.part)).toEqual(['extra', 'more'])
    expect(h.calls.map((c) => c.query?.fields)).toEqual(['id,name,destination_spec,instagram_branded_content', 'id,name'])
  })
})

it('every effective status Meta lists has words', () => {
  for (const s of ['ACTIVE', 'PAUSED', 'DELETED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO', 'CAMPAIGN_PAUSED', 'ARCHIVED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES']) expect(STATUS_WORDS[s], s).toBeTruthy()
})
