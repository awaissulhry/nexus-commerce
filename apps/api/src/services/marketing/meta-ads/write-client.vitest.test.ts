/**
 * Meta step 17 — the write client: Meta's check (validate_only) judged or not judged; a change sent once with its
 * read-back, waiting out Meta's 30-s per-object limit (a longer hold refuses it, nothing sent); an answer Meta did not give
 * (no answer, a 5xx) is "not confirmed", never sent again; a refusal is Meta's words about a CHANGE. The gateway is a
 * stand-in (its own tests judge the calls); made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ writes: [] as Array<Record<string, unknown>>, answers: [] as Array<unknown>, reads: [] as Array<Record<string, unknown>>, readAnswer: null as unknown }))
vi.mock('../../gateway/meta.js', () => ({
  metaWriteCall: vi.fn(async (req: Record<string, unknown>) => {
    h.writes.push(req)
    const next = h.answers.shift()
    if (next instanceof Error) throw next
    return next
  }),
}))
vi.mock('./read-client.js', () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Record<string, unknown>) => {
    h.reads.push(req)
    if (h.readAnswer instanceof Error) throw h.readAnswer
    return { body: h.readAnswer, calls: 1 }
  }),
}))

import { metaCheckChange, metaSendChange, MetaWriteError, META_UNKNOWN_OUTCOME, READ_BACK } from './write-client.js'
import { MetaReadError, localFailure } from './errors.js'
import { GatewayRefusal } from '../../gateway/gateway.js'
import { __metaObjectLimitsTest, holdMetaObject, noteMetaObjectTouched } from '../../gateway/meta-object-limits.js'

const target = { connectionId: 'm-1', adAccountId: '1234567890' }
const change = { objectId: '120000000000001', params: { status: 'PAUSED' }, operation: 'campaign.status' }
const answer = (status: number, body: unknown, verdict: Record<string, unknown> | null = null) => ({ ok: status >= 200 && status < 300, status, text: JSON.stringify(body), verdict, json: () => body })
const metaError = (status: number, code: string, cls: string, message = 'Meta words') => answer(status, { error: { message } }, { errorClass: cls, channelCode: code, channelMessage: message })
const outcomeOf = async (work: Promise<unknown>) => { const err = await work.catch((e) => e); return err instanceof MetaWriteError ? { outcome: err.outcome, message: err.message } : err }

beforeEach(() => { h.writes = []; h.answers = []; h.reads = []; h.readAnswer = null; __metaObjectLimitsTest.useMemory() })

describe('Meta\'s check (validate_only)', () => {
  it('asks the gateway for a check (a read) with exactly the change\'s fields; success = Meta would accept it', async () => {
    h.answers.push(answer(200, { success: true }))
    await metaCheckChange(target, change)
    expect(h.writes).toEqual([{ connectionId: 'm-1', operation: 'campaign.status.check', objectId: '120000000000001', params: { status: 'PAUSED' }, check: true }])
  })
  it('Meta\'s refusal is judged (refused); no answer, Meta unwell, a throttle or a gateway refusal is not judged (not_sent)', async () => {
    h.answers.push(metaError(400, '100', 'validation', 'Invalid parameter'))
    expect(await outcomeOf(metaCheckChange(target, change))).toEqual({ outcome: 'refused', message: expect.stringMatching(/Meta refused it \(100\): Invalid parameter/) })
    h.answers.push(answer(0, ''))
    expect(await outcomeOf(metaCheckChange(target, change))).toMatchObject({ outcome: 'not_sent' })
    h.answers.push(metaError(500, '1', 'transient'))
    expect(await outcomeOf(metaCheckChange(target, change))).toMatchObject({ outcome: 'not_sent' })
    h.answers.push(metaError(400, '613/4841018', 'rate_limited'))
    expect(await outcomeOf(metaCheckChange(target, change))).toMatchObject({ outcome: 'not_sent', message: expect.stringMatching(/slow down/) })
    h.answers.push(new GatewayRefusal('refused', 'META_ACCOUNT_NOT_CHOSEN', 'Nothing was sent to Meta: not of the chosen account.', 403))
    expect(await outcomeOf(metaCheckChange(target, change))).toMatchObject({ outcome: 'not_sent', message: expect.stringMatching(/not of the chosen account/) })
  })
})

describe('a change', () => {
  it('goes once as a write with the read-back fields; Meta\'s read-after-write answer is the read-back', async () => {
    h.answers.push(answer(200, { id: '120000000000001', status: 'PAUSED', effective_status: 'PAUSED' }))
    const res = await metaSendChange(target, change)
    expect(res).toEqual({ node: { id: '120000000000001', status: 'PAUSED', effective_status: 'PAUSED' }, readBack: 'same-request', waitedMs: 0 })
    expect(h.writes).toEqual([expect.objectContaining({ check: false, params: { status: 'PAUSED', fields: READ_BACK }, maxRateWaitMs: 60_000 })])
    expect(h.reads).toEqual([])
  })
  it('Meta answers only success: one GET reads it back; a read that fails leaves the read-back empty (Meta confirmed it)', async () => {
    h.answers.push(answer(200, { success: true }))
    h.readAnswer = { id: '120000000000001', status: 'PAUSED', effective_status: 'CAMPAIGN_PAUSED' }
    expect(await metaSendChange(target, change)).toMatchObject({ readBack: 'second-read', node: { status: 'PAUSED' } })
    expect(h.reads).toEqual([{ operation: 'campaign.status.readBack', path: '120000000000001', query: { fields: READ_BACK } }])
    __metaObjectLimitsTest.useMemory()
    h.answers.push(answer(200, { success: true }))
    h.readAnswer = new MetaReadError(localFailure('no', 'X'), 'r')
    expect(await metaSendChange(target, change)).toMatchObject({ readBack: 'none', node: null })
  })
  it('no answer or a 5xx: NOT CONFIRMED (unknown), never sent again; a 4xx is Meta\'s refusal; a gateway refusal sent nothing', async () => {
    h.answers.push(answer(0, ''))
    expect(await outcomeOf(metaSendChange(target, change))).toEqual({ outcome: 'unknown', message: META_UNKNOWN_OUTCOME })
    h.answers.push(metaError(503, '2', 'transient'))
    expect(await outcomeOf(metaSendChange(target, change))).toMatchObject({ outcome: 'unknown' })
    h.answers.push(metaError(400, '100/1487007', 'validation', 'The ad set has ended'))
    expect(await outcomeOf(metaSendChange(target, change))).toEqual({ outcome: 'refused', message: 'Meta refused it (100/1487007): The ad set has ended. Nothing was changed.' })
    h.answers.push(metaError(403, '200', 'forbidden', 'Permissions error'))
    expect(await outcomeOf(metaSendChange(target, change))).toMatchObject({ outcome: 'refused', message: expect.stringMatching(/does not let this system user change this.*ads_management/) })
    h.answers.push(new GatewayRefusal('gated', 'PUBLISH_GATED', 'Nothing was sent to Meta: Meta publishing is switched off.', 503))
    expect(await outcomeOf(metaSendChange(target, change))).toMatchObject({ outcome: 'not_sent' })
    h.answers.push(answer(200, { success: false }))
    expect(await outcomeOf(metaSendChange(target, change))).toMatchObject({ outcome: 'refused', message: expect.stringMatching(/success: false/) })
    expect(h.writes).toHaveLength(6)
  })
  it('waits out Meta\'s 30-s limit on the same object (after a change or a check), then sends', async () => {
    const now = Date.now()
    await noteMetaObjectTouched('m-1', '120000000000001', {}, now - 20_000)
    const slept: number[] = []
    h.answers.push(answer(200, { id: '120000000000001', status: 'PAUSED' }))
    const res = await metaSendChange(target, change, { sleep: async (ms) => { slept.push(ms) }, now: () => now })
    expect(slept).toHaveLength(1)
    expect(slept[0]).toBeGreaterThan(9_000)
    expect(slept[0]).toBeLessThan(11_000)
    expect(res.waitedMs).toBe(slept[0])
  })
  it('a hold longer than the 30 s (an ad set\'s budget hour) is refused in words: nothing sent', async () => {
    await holdMetaObject('m-1', '120000000000002', 'budget')
    const err = await outcomeOf(metaSendChange(target, { objectId: '120000000000002', params: { status: 'PAUSED' }, operation: 'adset.status', budget: true }, { sleep: async () => { throw new Error('must not wait an hour') } }))
    expect(err).toMatchObject({ outcome: 'not_sent', message: expect.stringMatching(/budget changes for an hour.*Nothing was changed/) })
    expect(h.writes).toHaveLength(0)
  })
})
