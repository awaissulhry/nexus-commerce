/**
 * Meta step 18 — the write client past status: a change names its own read-back fields and what they must show
 * (`expect`); a create on an edge reads back the NEW object (never its parent); a DELETE answers {"success": true} and
 * reads nothing back; an error answer to a settings change is judged by reading its fields; an error answer to a create
 * or a delete is Meta's refusal (nothing made). Step 17's status path is untouched (write-client.vitest.test.ts). The
 * gateway is a stand-in; made-up ids.
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

import { expectedOf, metaSendChange, MetaWriteError, readBackMismatch, readsOf } from './write-client.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'

const target = { connectionId: 'm-1', adAccountId: '1234567890' }
const answer = (status: number, body: unknown, verdict: Record<string, unknown> | null = null) => ({ ok: status >= 200 && status < 300, status, text: JSON.stringify(body), verdict, json: () => body })
const metaError = (status: number, code: string, cls: string, message = 'Meta words') => answer(status, { error: { message } }, { errorClass: cls, channelCode: code, channelMessage: message })
const outcomeOf = async (work: Promise<unknown>) => { const err = await work.catch((e) => e); return err instanceof MetaWriteError ? { outcome: err.outcome, message: err.message } : err }

beforeEach(() => { h.writes = []; h.answers = []; h.reads = []; h.readAnswer = null; __metaObjectLimitsTest.useMemory() })

describe('the judge', () => {
  it('status by default; a change\'s own fields when it names them; a field not sent back is not judged', () => {
    expect(expectedOf({ params: { status: 'PAUSED' } })).toEqual({ status: 'PAUSED' })
    expect(expectedOf({ params: { daily_budget: '7000' }, expect: { daily_budget: '7000' } })).toEqual({ daily_budget: '7000' })
    expect(readBackMismatch({ daily_budget: '5000' }, { daily_budget: '7000' })).toEqual(['daily_budget'])
    expect(readBackMismatch({ daily_budget: 7000 }, { daily_budget: '7000' })).toEqual([])
    expect(readBackMismatch({ is_adset_budget_sharing_enabled: false }, { is_adset_budget_sharing_enabled: 'false' })).toEqual([])
    expect(readBackMismatch({ id: '1' }, { daily_budget: '7000' })).toEqual([])
    expect(readsOf({ daily_budget: '7000' }, { daily_budget: '7000', name: 'x' })).toBe('daily_budget 7000, name (not sent back)')
  })
})

describe('a settings change', () => {
  const campaign = { objectId: '120000000000001', kind: 'campaign' as const, params: { daily_budget: '7000' }, operation: 'campaign.settings', readBackInPost: true, expect: { daily_budget: '7000' }, readBackFields: 'id,daily_budget' }
  it('asks its own read-back fields on the POST and takes the node Meta answers', async () => {
    h.answers.push(answer(200, { id: '120000000000001', daily_budget: '7000' }))
    const done = await metaSendChange(target, campaign, { sleep: async () => {} })
    expect(h.writes[0]).toMatchObject({ operation: 'campaign.settings', params: { daily_budget: '7000', fields: 'id,daily_budget' } })
    expect(done).toEqual({ node: { id: '120000000000001', daily_budget: '7000' }, readBack: 'same-request', waitedMs: 0 })
    expect(h.reads).toEqual([])
  })
  it('an ad set\'s settings are read back with one GET of the change\'s own fields', async () => {
    h.answers.push(answer(200, { success: true }))
    h.readAnswer = { id: '120000000000002', bid_amount: 150 }
    const done = await metaSendChange(target, { objectId: '120000000000002', kind: 'adset', params: { bid_amount: '150' }, operation: 'adset.settings', expect: { bid_amount: '150' }, readBackFields: 'id,bid_amount' }, { sleep: async () => {} })
    expect(h.reads[0]).toMatchObject({ path: '120000000000002', query: { fields: 'id,bid_amount' } })
    expect(done.readBack).toBe('second-read')
  })
  it('an error answer, yet the fields read back as asked: Meta made it; read back otherwise: refused', async () => {
    h.answers.push(metaError(400, '1', 'transient', 'An unknown error occurred'))
    h.readAnswer = { id: '120000000000001', daily_budget: '7000' }
    expect(await metaSendChange(target, campaign, { sleep: async () => {} })).toMatchObject({ readBack: 'second-read', afterError: expect.stringMatching(/unknown error/) })
    h.answers.push(metaError(400, '100', 'validation', 'Invalid parameter'))
    h.readAnswer = { id: '120000000000001', daily_budget: '5000' }
    __metaObjectLimitsTest.useMemory()
    expect(await outcomeOf(metaSendChange(target, campaign, { sleep: async () => {} }))).toEqual({ outcome: 'refused', message: expect.stringMatching(/Invalid parameter.*it reads daily_budget 5000/) })
  })
})

describe('a budget schedule', () => {
  const create = {
    objectId: '120000000000001', kind: 'campaign' as const, edge: 'budget_schedules' as const, operation: 'budgetSchedule.create', readBackInPost: true,
    params: { budget_value: '20', budget_value_type: 'ABSOLUTE', time_start: '4070937600', time_end: '4070980800' }, expect: { budget_value: '20', budget_value_type: 'ABSOLUTE' },
    readBackFields: 'id,budget_value,budget_value_type,time_start,time_end',
  }
  it('a create goes on the edge and reads back the NEW period (never the campaign)', async () => {
    h.answers.push(answer(200, { id: '120000000000032' }))
    h.readAnswer = { id: '120000000000032', budget_value: 20, budget_value_type: 'ABSOLUTE' }
    const done = await metaSendChange(target, create, { sleep: async () => {} })
    expect(h.writes[0]).toMatchObject({ edge: 'budget_schedules', objectId: '120000000000001' })
    expect(h.reads[0]).toMatchObject({ path: '120000000000032' })
    expect(done.node).toMatchObject({ id: '120000000000032', budget_value: 20 })
    h.answers.push(answer(200, { id: '120000000000033', budget_value: 20, budget_value_type: 'ABSOLUTE' }))
    __metaObjectLimitsTest.useMemory()
    expect(await metaSendChange(target, create, { sleep: async () => {} })).toMatchObject({ readBack: 'same-request', node: { id: '120000000000033' } })
  })
  it('a create Meta refuses made nothing (refused, not unknown); no answer stays unknown', async () => {
    h.answers.push(metaError(400, '100', 'validation', 'Invalid parameter'))
    expect(await outcomeOf(metaSendChange(target, create, { sleep: async () => {} }))).toMatchObject({ outcome: 'refused' })
    expect(h.reads).toEqual([])
    h.answers.push(answer(0, ''))
    __metaObjectLimitsTest.useMemory()
    expect(await outcomeOf(metaSendChange(target, create, { sleep: async () => {} }))).toMatchObject({ outcome: 'unknown' })
  })
  it('a DELETE names its period and campaign, answers {"success": true}, reads nothing back', async () => {
    h.answers.push(answer(200, { success: true }))
    const done = await metaSendChange(target, { objectId: '120000000000031', kind: 'highdemandperiod', method: 'DELETE', parent: { kind: 'campaign', id: '120000000000001' }, params: {}, operation: 'budgetSchedule.delete' }, { sleep: async () => {} })
    expect(h.writes[0]).toMatchObject({ method: 'DELETE', objectKind: 'highdemandperiod', parent: { kind: 'campaign', id: '120000000000001' } })
    expect(done).toEqual({ node: { success: true }, readBack: 'none', waitedMs: 0 })
    expect(h.reads).toEqual([])
  })
})
