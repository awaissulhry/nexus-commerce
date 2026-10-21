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
const change = { objectId: '120000000000001', kind: 'campaign' as const, params: { status: 'PAUSED' }, operation: 'campaign.status', readBackInPost: true }
const adSetChange = { objectId: '120000000000002', kind: 'adset' as const, params: { status: 'PAUSED' }, operation: 'adset.status' }
const answer = (status: number, body: unknown, verdict: Record<string, unknown> | null = null) => ({ ok: status >= 200 && status < 300, status, text: JSON.stringify(body), verdict, json: () => body })
const metaError = (status: number, code: string, cls: string, message = 'Meta words') => answer(status, { error: { message } }, { errorClass: cls, channelCode: code, channelMessage: message })
const outcomeOf = async (work: Promise<unknown>) => { const err = await work.catch((e) => e); return err instanceof MetaWriteError ? { outcome: err.outcome, message: err.message } : err }

beforeEach(() => { h.writes = []; h.answers = []; h.reads = []; h.readAnswer = null; __metaObjectLimitsTest.useMemory() })

describe('Meta\'s check (validate_only)', () => {
  it('asks the gateway for a check (a read) with exactly the change\'s fields; success = Meta would accept it', async () => {
    h.answers.push(answer(200, { success: true }))
    await metaCheckChange(target, change)
    expect(h.writes).toEqual([{ connectionId: 'm-1', operation: 'campaign.status.check', objectId: '120000000000001', objectKind: 'campaign', params: { status: 'PAUSED' }, check: true }])
  })
  it('step 27 — a new ad\'s check asks Meta\'s integrity review (adReview) beside step 19\'s recommendations, and the recommendations come back', async () => {
    h.answers.push(answer(200, { success: true, recommendations: [{ title: 'T' }] }))
    const got = await metaCheckChange(target, { objectId: 'act_1234567890', kind: 'adaccount', params: { name: 'Ad A' }, operation: 'ad.create', edge: 'ads', adReview: true, recommendations: true })
    expect(got).toEqual({ recommendations: [{ title: 'T' }] })
    expect(h.writes[0]).toMatchObject({ objectId: 'act_1234567890', edge: 'ads', check: true, adReview: true, recommendations: true })
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
    h.answers.push(new Error('database down'))
    expect(await outcomeOf(metaCheckChange(target, change))).toMatchObject({ outcome: 'not_sent', message: expect.stringMatching(/database down/) })
  })
})

describe('a change', () => {
  it('a campaign: goes once as a write with the read-back fields in the POST (documented); its answer is the read-back', async () => {
    h.answers.push(answer(200, { id: '120000000000001', status: 'PAUSED', effective_status: 'PAUSED' }))
    const res = await metaSendChange(target, change)
    expect(res).toEqual({ node: { id: '120000000000001', status: 'PAUSED', effective_status: 'PAUSED' }, readBack: 'same-request', waitedMs: 0 })
    expect(h.writes).toEqual([expect.objectContaining({ check: false, objectKind: 'campaign', params: { status: 'PAUSED', fields: READ_BACK }, maxRateWaitMs: 60_000 })])
    expect(h.reads).toEqual([])
  })
  it('an ad set or ad: no fields on the POST (undocumented, ST17-05); one GET reads it back; a read that fails — of any kind — leaves it empty', async () => {
    h.answers.push(answer(200, { success: true }))
    h.readAnswer = { id: '120000000000002', status: 'PAUSED', effective_status: 'CAMPAIGN_PAUSED' }
    expect(await metaSendChange(target, adSetChange)).toMatchObject({ readBack: 'second-read', node: { status: 'PAUSED' } })
    expect(h.writes[0]).toMatchObject({ objectKind: 'adset', params: { status: 'PAUSED' } })
    expect(h.reads).toEqual([{ operation: 'adset.status.readBack', path: '120000000000002', query: { fields: READ_BACK } }])
    for (const failure of [new MetaReadError(localFailure('no', 'X'), 'r'), new Error('database down')]) {
      __metaObjectLimitsTest.useMemory()
      h.answers.push(answer(200, { success: true }))
      h.readAnswer = failure
      expect(await metaSendChange(target, adSetChange)).toMatchObject({ readBack: 'none', node: null })
    }
  })
  it('review fix B1 — an error answer is no proof nothing changed: read once; as asked = done, unchanged = refused, unreadable = not confirmed', async () => {
    // Meta answered an error, yet the object reads PAUSED: Meta made it.
    h.answers.push(metaError(400, '100', 'validation', 'Some error'))
    h.readAnswer = { id: '120000000000001', status: 'PAUSED' }
    expect(await metaSendChange(target, change)).toMatchObject({ node: { status: 'PAUSED' }, readBack: 'second-read', afterError: expect.stringMatching(/Some error/) })
    expect(h.reads.at(-1)).toMatchObject({ operation: 'campaign.status.readAfterError', query: { fields: READ_BACK } })
    // Unchanged: Meta's refusal stands, with what it reads now.
    __metaObjectLimitsTest.useMemory()
    h.answers.push(metaError(400, '100/1487007', 'validation', 'The ad set has ended'))
    h.readAnswer = { id: '120000000000001', status: 'ACTIVE' }
    expect(await outcomeOf(metaSendChange(target, change))).toEqual({ outcome: 'refused', message: 'Meta refused it (100/1487007): The ad set has ended. Nothing was changed (it still reads ACTIVE).' })
    __metaObjectLimitsTest.useMemory()
    h.answers.push(metaError(403, '200', 'forbidden', 'Permissions error'))
    expect(await outcomeOf(metaSendChange(target, change))).toMatchObject({ outcome: 'refused', message: expect.stringMatching(/does not let this system user change this.*ads_management/) })
    // Unreadable after an error: nobody knows.
    __metaObjectLimitsTest.useMemory()
    h.answers.push(metaError(400, '1', 'validation', 'An unknown error occurred'))
    h.readAnswer = new MetaReadError(localFailure('no', 'X'), 'r')
    expect(await outcomeOf(metaSendChange(target, change))).toMatchObject({ outcome: 'unknown', message: expect.stringMatching(/could not read the object back.*never sends it again/) })
    // success: false is not a success either.
    __metaObjectLimitsTest.useMemory()
    h.answers.push(answer(200, { success: false }))
    h.readAnswer = { id: '120000000000001', status: 'ACTIVE' }
    expect(await outcomeOf(metaSendChange(target, change))).toMatchObject({ outcome: 'refused', message: expect.stringMatching(/success: false.*still reads ACTIVE/) })
  })
  it('no answer or a 5xx: read once — as asked = done; unchanged or unreadable = NOT CONFIRMED (Meta may still apply it), never sent again', async () => {
    h.answers.push(answer(0, ''))
    h.readAnswer = null
    expect(await outcomeOf(metaSendChange(target, change))).toEqual({ outcome: 'unknown', message: META_UNKNOWN_OUTCOME })
    __metaObjectLimitsTest.useMemory()
    h.answers.push(metaError(503, '2', 'transient'))
    h.readAnswer = { id: '120000000000001', status: 'ACTIVE' }
    expect(await outcomeOf(metaSendChange(target, change))).toMatchObject({ outcome: 'unknown', message: expect.stringMatching(/still reads ACTIVE, but Meta may still apply it/) })
    __metaObjectLimitsTest.useMemory()
    h.answers.push(metaError(500, '1', 'transient'))
    h.readAnswer = { id: '120000000000001', status: 'PAUSED' }
    expect(await metaSendChange(target, change)).toMatchObject({ afterError: 'Meta did not answer, or failed on its side', node: { status: 'PAUSED' } })
    expect(h.writes).toHaveLength(3)
  })
  it('nothing sent: a gateway refusal or a problem of Nexus\'s own before Meta (the gateway throws only before it sends)', async () => {
    h.answers.push(new GatewayRefusal('gated', 'PUBLISH_GATED', 'Nothing was sent to Meta: Meta publishing is switched off.', 503))
    expect(await outcomeOf(metaSendChange(target, change))).toMatchObject({ outcome: 'not_sent' })
    h.answers.push(new Error('database down'))
    expect(await outcomeOf(metaSendChange(target, change))).toMatchObject({ outcome: 'not_sent', message: expect.stringMatching(/database down.*Nothing was sent/) })
    expect(h.reads).toEqual([])
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
    const err = await outcomeOf(metaSendChange(target, { ...adSetChange, budget: true }, { sleep: async () => { throw new Error('must not wait an hour') } }))
    expect(err).toMatchObject({ outcome: 'not_sent', message: expect.stringMatching(/budget changes for an hour.*Nothing was changed/) })
    expect(h.writes).toHaveLength(0)
  })
})

describe('step 39 — a change judged by its own read-back, a DELETE with keys, the one file', () => {
  const judge = (node: Record<string, unknown>) => {
    const listed = Array.isArray(node.data) ? (node.data as Array<{ id: string }>).map((r) => r.id) : []
    return { moved: listed.includes('5550000002') ? [] : ['its shares'], reads: `its shares ${listed.join(',') || 'none'}` }
  }
  const share = { objectId: '120000000000601', kind: 'publisherblocklist' as const, params: { agency_id: '5550000002', permitted_roles: '["APPLY_BLOCK_LIST"]' }, operation: 'blockList.share', edge: 'agencies' as const, readBackOf: '120000000000601/agencies', readBackFields: 'id', judge }
  it('success: one GET of what it names (never the answer), handed back for the judge', async () => {
    h.answers.push(answer(200, { success: true }))
    h.readAnswer = { data: [{ id: '5550000002' }] }
    expect(await metaSendChange(target, share)).toEqual({ node: { data: [{ id: '5550000002' }] }, readBack: 'second-read', waitedMs: 0 })
    expect(h.writes[0]).toMatchObject({ objectId: '120000000000601', objectKind: 'publisherblocklist', edge: 'agencies', params: share.params })
    expect(h.reads).toEqual([{ operation: 'blockList.share.readBack', path: '120000000000601/agencies', query: { fields: 'id' } }])
  })
  it('an error answer: the read-back decides — as asked = made; not as asked = refused, in its own words', async () => {
    h.answers.push(metaError(400, '100', 'validation', 'Already shared'))
    h.readAnswer = { data: [{ id: '5550000002' }] }
    expect(await metaSendChange(target, share)).toMatchObject({ afterError: expect.stringMatching(/Already shared/) })
    h.answers.push(metaError(400, '100', 'validation', 'Invalid parameter'))
    h.readAnswer = { data: [] }
    expect(await outcomeOf(metaSendChange(target, share))).toMatchObject({ outcome: 'refused', message: expect.stringMatching(/Invalid parameter.*it reads its shares none/) })
  })
  it('a DELETE with keys and the file (as its form keys) pass through as asked; a DELETE answered with an error (no judge) made nothing', async () => {
    h.answers.push(answer(200, { success: true }))
    await metaSendChange(target, { objectId: '120000000000601', kind: 'publisherblocklist', params: { agency_id: '5550000002' }, operation: 'blockList.unshare', edge: 'agencies', method: 'DELETE' })
    expect(h.writes[0]).toMatchObject({ method: 'DELETE', edge: 'agencies', params: { agency_id: '5550000002' } })
    h.answers.push(answer(200, { id: '120000000000801' }))
    h.readAnswer = { id: '120000000000801', async_job_status: 'scheduled' }
    const draft = await metaSendChange(target, { objectId: '9876543210', kind: 'business', params: { publisher_urls_file: 'example.com', publisher_urls_file_name: 'publisher_urls.txt' }, operation: 'blockList.draft', edge: 'block_list_drafts', readBackFields: 'id,async_job_status' })
    expect(h.writes[1]).toMatchObject({ edge: 'block_list_drafts', params: { publisher_urls_file: 'example.com', publisher_urls_file_name: 'publisher_urls.txt' } })
    expect(draft.node).toEqual({ id: '120000000000801', async_job_status: 'scheduled' })
    h.answers.push(metaError(400, '100', 'validation', 'Cannot delete'))
    expect(await outcomeOf(metaSendChange(target, { objectId: '120000000000601', kind: 'publisherblocklist', params: {}, operation: 'blockList.delete', method: 'DELETE' }))).toMatchObject({ outcome: 'refused' })
  })
})

describe('step 30 part 3 review round 2 (B-3, A-L3) — a refused token or permission, by the token its rule sends', () => {
  const PAGE = '120000000000010'
  const install = { objectId: PAGE, kind: 'page' as const, params: { subscribed_fields: 'feed' }, operation: 'webhooks.installPage', edge: 'subscribed_apps' as const, via: {} }
  const removal = { objectId: PAGE, kind: 'page' as const, params: {}, operation: 'webhooks.removePage', edge: 'subscribed_apps' as const, method: 'DELETE' as const, via: {} }
  const leadForm = { objectId: PAGE, kind: 'page' as const, params: { name: 'Form A' }, operation: 'leadform.create', edge: 'leadgen_forms' as const }
  it('install-page (as the Page, with its own words): generic words only — never step 36\'s Advertise task or pages_manage_ads', async () => {
    for (const [code, cls, status] of [['190', 'auth_revoked', 400], ['200', 'forbidden', 403]] as const) {
      h.answers.push(metaError(status, code, cls, 'Meta words'))
      const got = await outcomeOf(metaSendChange(target, install))
      expect(got.message, code).toBe(`Meta did not accept this change made as the chosen Facebook Page (${code}): Meta words. Nothing was changed.`)
      expect(got.message, code).not.toMatch(/Advertise task|pages_manage_ads|system-user token/)
    }
  })
  it('remove-page (the APP token by its rule): a 190 is the app token\'s — never the Page\'s words, nor "a new system-user token"', async () => {
    h.answers.push(metaError(400, '190', 'auth_revoked', 'Invalid OAuth access token'))
    const lost = await outcomeOf(metaSendChange(target, removal))
    expect(lost.message).toBe('Meta did not accept the business\'s Meta app token for this change (190): Invalid OAuth access token. Check the app id and secret in Settings › Channels › Meta. Nothing was changed.')
    expect(lost.message).not.toMatch(/as the chosen Facebook Page|Advertise task|system-user token|Make a new token/)
    h.answers.push(metaError(403, '200', 'forbidden', 'Permissions error'))
    const denied = await outcomeOf(metaSendChange(target, removal))
    expect(denied.message).toBe('Meta refused this change made with the business\'s Meta app token (200): Permissions error. Nothing was changed.')
    // An app subscription goes with the app token too.
    h.answers.push(metaError(400, '190', 'auth_revoked', 'Invalid OAuth access token'))
    expect((await outcomeOf(metaSendChange(target, { objectId: '1234567', kind: 'app', params: { object: 'page', fields: 'feed' }, operation: 'webhooks.subscribeApp', edge: 'subscriptions', via: {} }))).message).toMatch(/^Meta did not accept the business's Meta app token for this change \(190\)/)
  })
  it('step 36\'s lead forms keep their words', async () => {
    h.answers.push(metaError(400, '190', 'auth_revoked', 'Error validating access token'))
    expect((await outcomeOf(metaSendChange(target, leadForm))).message).toBe('Meta did not accept this change made as the chosen Facebook Page (190): Error validating access token. The system user may have lost its role or its Advertise task on the Page (Meta Business settings › Users › System users › Assign assets), or its token pages_manage_ads. Nothing was changed.')
  })
})
