/**
 * Meta step 21 — the write client for a campaign's labels edge (POST /<campaign>/adlabels answers {"success": true}): the
 * campaign itself is read back (readBackObject), never a new object, and its whole label list judged; an edge without it
 * (a create) still reads back what it made. The gateway is a stand-in; made-up ids.
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

import { metaSendChange, readBackMismatch, readsOf } from './write-client.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'

const target = { connectionId: 'm-1', adAccountId: '1234567890' }
const answer = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: JSON.stringify(body), verdict: null, json: () => body })
const C = '120000000000001'
const L1 = '120000000000070'
const L2 = '120000000000071'

beforeEach(() => { h.writes = []; h.answers = []; h.reads = []; h.readAnswer = null; __metaObjectLimitsTest.useMemory() })

describe('round 2 — a value rule set read back by its rules, not only its name', () => {
  const asked = JSON.stringify([{ id: '120000000000082', name: 'Young', adjust_sign: 'INCREASE', adjust_value: 40, status: 'ACTIVE', criterias: [{ criteria_type: 'GENDER', operator: 'CONTAINS', criteria_values: ['MALE'], criteria_value_types: ['NONE'] }] }])
  const read = (over: Record<string, unknown> = {}, values = ['male']) => ({ id: '120000000000080', name: 'Set A', rules: { data: [{ id: '120000000000082', name: 'Young', adjust_sign: 'INCREASE', adjust_value: 40, status: 'ACTIVE', criterias: { data: [{ id: '1', criteria_type: 'GENDER', operator: 'CONTAINS', criteria_values: values, criteria_value_types: ['NONE'] }] }, ...over }] } })
  const expect_ = { name: 'Set A', rules: asked }
  it('the rules as asked match (GENDER without case); another percentage, value or rule id does not', () => {
    expect(readBackMismatch(read(), expect_)).toEqual([])
    expect(readBackMismatch(read({ adjust_value: 20 }), expect_)).toEqual(['rules'])
    expect(readBackMismatch(read({}, ['female']), expect_)).toEqual(['rules'])
    expect(readBackMismatch(read({ id: '9' }), expect_)).toEqual(['rules'])
    expect(readsOf(read(), expect_)).toBe('name Set A, rules (1)')
  })
  it('an error answer with the same name but other rules is Meta\'s refusal, never done', async () => {
    h.answers.push(answer(400, { error: { message: 'Invalid parameter', code: 100 } }))
    h.readAnswer = read({ adjust_value: 20 })
    const change = { objectId: '120000000000080', kind: 'valueruleset' as const, params: { name: 'Set A', rules: asked }, operation: 'valueRuleSet.change', expect: expect_, readBackFields: 'id,name,rules' }
    await expect(metaSendChange(target, change, { sleep: async () => undefined })).rejects.toMatchObject({ outcome: 'refused' })
    h.answers.push(answer(400, { error: { message: 'Invalid parameter', code: 100 } }))
    h.readAnswer = read()
    expect(await metaSendChange(target, change, { sleep: async () => undefined })).toMatchObject({ readBack: 'second-read', afterError: expect.stringMatching(/Meta refused it/) })
  })
})

describe('a campaign\'s labels edge', () => {
  const add = {
    objectId: C, kind: 'campaign' as const, edge: 'adlabels' as const, readBackObject: true as const, params: { adlabels: JSON.stringify([{ id: L2 }]) },
    operation: 'campaign.labels.add', expect: { adlabels: JSON.stringify([{ id: L1 }, { id: L2 }]) }, readBackFields: 'id,adlabels{id,name}',
  }
  it('reads back the campaign itself (Meta answers only success) and keeps its label list', async () => {
    h.answers.push(answer(200, { success: true }))
    h.readAnswer = { id: C, adlabels: [{ id: L2, name: 'Summer' }, { id: L1, name: 'Spring' }] }
    const out = await metaSendChange(target, add, { sleep: async () => undefined })
    expect(h.writes[0]).toMatchObject({ objectId: C, objectKind: 'campaign', edge: 'adlabels', params: { adlabels: JSON.stringify([{ id: L2 }]) } })
    expect(h.reads[0]).toMatchObject({ path: C, query: { fields: 'id,adlabels{id,name}' } })
    expect(out).toMatchObject({ readBack: 'second-read', node: { id: C, success: true } })
    expect(readBackMismatch(out.node, add.expect)).toEqual([])
  })
  it('without readBackObject an edge reads back only what Meta answered it made (nothing here)', async () => {
    h.answers.push(answer(200, { success: true }))
    const { readBackObject: _r, ...plain } = add
    const out = await metaSendChange(target, plain, { sleep: async () => undefined })
    expect(h.reads).toHaveLength(0)
    expect(out).toMatchObject({ readBack: 'none', node: { success: true } })
  })
  it('an error answer to the add edge is Meta\'s refusal (nothing added), never read as done', async () => {
    h.answers.push(answer(400, { error: { message: 'Invalid parameter', code: 100 } }))
    await expect(metaSendChange(target, add, { sleep: async () => undefined })).rejects.toMatchObject({ outcome: 'refused' })
  })
})
