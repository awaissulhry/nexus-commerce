/**
 * Meta step 19 — the write client for creates and copies: a create names the chosen ad account's edge and reads back the
 * NEW object; a copy reads back the copy and keeps Meta's answer beside it (ad_object_ids — the read cannot give them
 * again); Meta's check of a create goes on the same edge, asks Meta's recommendations when the change says so, and hands
 * them back; an error answer to a create or a copy is Meta's refusal (nothing made). The gateway is a stand-in; made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ writes: [] as Array<Record<string, unknown>>, answers: [] as Array<unknown>, reads: [] as Array<Record<string, unknown>>, readAnswer: null as unknown }))
vi.mock('../../gateway/meta.js', () => ({
  metaWriteCall: vi.fn(async (req: Record<string, unknown>) => {
    h.writes.push(req)
    return h.answers.shift()
  }),
}))
vi.mock('./read-client.js', () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Record<string, unknown>) => {
    h.reads.push(req)
    return { body: h.readAnswer, calls: 1 }
  }),
}))

import { createdIdOf, metaCheckChange, metaSendChange, MetaWriteError } from './write-client.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'

const target = { connectionId: 'm-1', adAccountId: '1234567890' }
const answer = (status: number, body: unknown, verdict: Record<string, unknown> | null = null) => ({ ok: status >= 200 && status < 300, status, text: JSON.stringify(body), verdict, json: () => body })

beforeEach(() => { h.writes = []; h.answers = []; h.reads = []; h.readAnswer = null; __metaObjectLimitsTest.useMemory() })

describe('createdIdOf', () => {
  it('a create\'s id, or a copy\'s copied_<kind>_id; ids stay strings', () => {
    expect(createdIdOf({ id: '120000000000099' })).toBe('120000000000099')
    expect(createdIdOf({ copied_campaign_id: '120000000000098', ad_object_ids: [] })).toBe('120000000000098')
    expect(createdIdOf({ copied_adset_id: '120000000000097' })).toBe('120000000000097')
    expect(createdIdOf({ copied_ad_id: '120000000000096' })).toBe('120000000000096')
    expect(createdIdOf({ success: true })).toBeNull()
    expect(createdIdOf(null)).toBeNull()
  })
})

describe('a create and a copy', () => {
  const create = { objectId: 'act_1234567890', kind: 'adaccount' as const, edge: 'campaigns' as const, params: { name: 'A', status: 'PAUSED' }, operation: 'campaign.create', expect: { status: 'PAUSED' }, readBackFields: 'id,name,status,effective_status' }
  it('a create goes on the ad account\'s edge and reads back the NEW campaign', async () => {
    h.answers.push(answer(200, { id: '120000000000099' }))
    h.readAnswer = { id: '120000000000099', name: 'A', status: 'PAUSED', effective_status: 'PAUSED' }
    const out = await metaSendChange(target, create, { sleep: async () => undefined })
    expect(h.writes[0]).toMatchObject({ objectId: 'act_1234567890', objectKind: 'adaccount', edge: 'campaigns', check: false, params: { name: 'A', status: 'PAUSED' } })
    expect(h.reads[0]).toMatchObject({ path: '120000000000099', query: { fields: 'id,name,status,effective_status' } })
    expect(out).toMatchObject({ node: { id: '120000000000099', status: 'PAUSED' }, readBack: 'second-read' })
  })
  it('a copy reads back the copy and keeps Meta\'s answer (ad_object_ids) beside it', async () => {
    h.answers.push(answer(200, { copied_campaign_id: '120000000000098', ad_object_ids: [{ ad_object_type: 'ad_set', source_id: '120000000000002', copied_id: '120000000000097' }] }))
    h.readAnswer = { id: '120000000000098', status: 'PAUSED' }
    const out = await metaSendChange(target, { objectId: '120000000000001', kind: 'campaign', edge: 'copies', params: { status_option: 'PAUSED' }, operation: 'campaign.copy', expect: { status: 'PAUSED' }, readBackFields: 'id,name,status,effective_status' }, { sleep: async () => undefined })
    expect(h.reads[0]).toMatchObject({ path: '120000000000098' })
    expect(out.node).toMatchObject({ id: '120000000000098', status: 'PAUSED', copied_campaign_id: '120000000000098', ad_object_ids: [expect.objectContaining({ copied_id: '120000000000097' })] })
  })
  it('an error answer to a create is Meta\'s refusal: nothing made, nothing read', async () => {
    h.answers.push(answer(400, { error: { message: 'Invalid parameter' } }, { errorClass: 'invalid', channelCode: '100', channelMessage: 'Invalid parameter' }))
    const err = await metaSendChange(target, create, { sleep: async () => undefined }).catch((e) => e)
    expect(err).toBeInstanceOf(MetaWriteError)
    expect(err.outcome).toBe('refused')
    expect(h.reads).toHaveLength(0)
  })
  it('review A4 — an error answer to a copy with its children (or a background copy) is NOT a refusal: part of it may exist', async () => {
    const deep = { objectId: '120000000000001', kind: 'campaign' as const, edge: 'copies' as const, params: { status_option: 'PAUSED', deep_copy: 'true' }, operation: 'campaign.copy', expect: { status: 'PAUSED' } }
    h.answers.push(answer(400, { error: { message: 'Invalid parameter' } }, { errorClass: 'invalid', channelCode: '100', channelMessage: 'Invalid parameter' }))
    const err = await metaSendChange(target, deep, { sleep: async () => undefined }).catch((e) => e)
    expect(err).toBeInstanceOf(MetaWriteError)
    expect(err.outcome).toBe('unknown')
    expect(err.message).toMatch(/^Not confirmed: .*part of the copy may exist/)
    expect(err.message).not.toMatch(/Nothing was changed/)
    h.answers.push(answer(400, { error: { message: 'Invalid parameter' } }, { errorClass: 'invalid', channelCode: '100', channelMessage: 'Invalid parameter' }))
    const bg = await metaSendChange(target, { objectId: 'act_1234567890', kind: 'adaccount', edge: 'async_batch_requests', params: { name: 'x', adbatch: '[]' }, operation: 'copy.background' }, { sleep: async () => undefined }).catch((e) => e)
    expect(bg.outcome).toBe('unknown')
    // A copy of the object alone stays Meta's refusal.
    h.answers.push(answer(400, { error: { message: 'Invalid parameter' } }, { errorClass: 'invalid', channelCode: '100', channelMessage: 'Invalid parameter' }))
    const alone = await metaSendChange(target, { ...deep, params: { status_option: 'PAUSED', deep_copy: 'false' } }, { sleep: async () => undefined }).catch((e) => e)
    expect(alone.outcome).toBe('refused')
  })
  it('Meta\'s check of a create goes on the same edge, asks its recommendations when the change says so, and hands them back', async () => {
    h.answers.push(answer(200, { success: true, recommendations: [{ title: 'Use Advantage+ placements' }] }))
    const out = await metaCheckChange(target, { ...create, recommendations: true })
    expect(h.writes[0]).toMatchObject({ objectId: 'act_1234567890', objectKind: 'adaccount', edge: 'campaigns', check: true, recommendations: true })
    expect(out).toEqual({ recommendations: [{ title: 'Use Advantage+ placements' }] })
    h.answers.push(answer(200, { success: true }))
    expect(await metaCheckChange(target, { objectId: '120000000000001', kind: 'campaign', params: { status: 'PAUSED' }, operation: 'campaign.status' })).toEqual({ recommendations: [] })
    expect(h.writes[1]).not.toHaveProperty('edge')
    expect(h.writes[1]).not.toHaveProperty('recommendations')
  })
})
