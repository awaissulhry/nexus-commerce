/**
 * Meta step 29 — the live state of a rule change: ONE rule of the chosen ad account (step 8's ownRule: account_id first,
 * another account's rule never read on), its specs as Meta sends them (a JSON string read as an object), and Meta's
 * preview of a schedule rule (a POST that only reads) — its list read, an unknown shape or a refusal said plainly, and
 * nothing sent while Meta changes are switched off. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  bodies: new Map<string, Record<string, unknown>>(),
  reads: [] as Array<{ path: string; fields: unknown }>,
  preview: null as null | (() => unknown),
  previewCalls: 0,
}))
vi.mock('./live.js', async (importActual) => ({
  ...(await importActual<typeof import('./live.js')>()),
  metaChosenAccount: vi.fn(async () => ({ connection: { systemUser: { id: '100009' } }, connectionId: 'm-1', adAccountId: '1234567890', currency: 'EUR' })),
}))
vi.mock('./read-client.js', async () => {
  const { MetaReadError, localFailure } = await import('./errors.js')
  return {
    metaReadOne: vi.fn(async (_t: unknown, input: { path: string; query?: Record<string, unknown> }) => {
      h.reads.push({ path: input.path, fields: input.query?.fields })
      const body = h.bodies.get(input.path)
      if (!body) throw new MetaReadError({ ...localFailure('Unsupported get request.', '100'), origin: 'meta', notFound: true }, 'x', 1)
      return { body, calls: 1 }
    }),
  }
})
vi.mock('../../gateway/meta.js', () => ({
  metaRulePreviewCall: vi.fn(async () => { h.previewCalls++; return h.preview!() }),
}))

import { liveRule, liveRuleGone, liveRulePreview } from './live-rules.js'
import { GatewayRefusal } from '../../gateway/gateway.js'

const account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
const RULE = '120000000000101'
const EVAL = { evaluation_type: 'SCHEDULE', filters: [{ field: 'entity_type', value: 'ADSET', operator: 'EQUAL' }] }
const answer = (body: unknown, ok = true, status = 200) => ({ ok, status, verdict: ok ? null : { channelCode: '100', channelMessage: 'Invalid parameter' }, json: () => body })

beforeEach(() => {
  h.bodies.clear(); h.reads = []; h.previewCalls = 0; h.preview = null
  vi.unstubAllEnvs()
})

describe('liveRule', () => {
  it('reads the rule\'s account first, then the rule; its specs as objects, in words as meta-ad-rules shows them', async () => {
    h.bodies.set(RULE, { id: RULE, account_id: '1234567890', name: 'Rule A', status: 'ENABLED', evaluation_spec: EVAL, execution_spec: '{"execution_type":"UNPAUSE"}', schedule_spec: { schedule_type: 'DAILY' } })
    const rule = await liveRule(account, RULE)
    expect(h.reads.map((r) => r.fields)).toEqual(['account_id', expect.stringMatching(/^id,account_id,name,status,evaluation_spec/)])
    expect(rule).toMatchObject({ id: RULE, name: 'Rule A', status: 'ENABLED', specs: { evaluation: EVAL, execution: { execution_type: 'UNPAUSE' }, schedule: { schedule_type: 'DAILY' } } })
    expect(rule.words).toMatchObject({ canRaiseSpend: true, evaluationType: 'SCHEDULE' })
  })
  it('a rule of another account is never read on; gone or not a rule reads as gone', async () => {
    h.bodies.set(RULE, { account_id: '5555555555' })
    await expect(liveRule(account, RULE)).rejects.toThrow(/another ad account/)
    expect(h.reads).toHaveLength(1)
    expect(await liveRuleGone(account, RULE)).toBeNull()
    h.bodies.clear()
    expect(await liveRuleGone(account, RULE)).toBe(true)
    h.bodies.set(RULE, { id: RULE, account_id: '1234567890', status: 'DELETED', evaluation_spec: EVAL, execution_spec: { execution_type: 'PAUSE' } })
    expect(await liveRuleGone(account, RULE)).toBe(true)
  })
})

describe('liveRulePreview (RU-031)', () => {
  it('reads Meta\'s list of objects (data[], with names) and says how many', async () => {
    h.preview = () => answer({ data: [{ id: '120000000000002', name: 'Ad set B' }, { id: 120000000000003 }], paging: { next: 'x' } })
    const p = await liveRulePreview(account, RULE)
    expect(p).toMatchObject({ read: true, more: true, objects: [{ id: '120000000000002', name: 'Ad set B' }, { id: '120000000000003', name: null }] })
    expect(p.sentence).toMatch(/would act on 2\+ objects now/)
  })
  it('an answer in a shape Nexus does not know, or Meta\'s refusal, is said plainly; nothing at all while Meta changes are off', async () => {
    h.preview = () => answer({ id: RULE })
    expect(await liveRulePreview(account, RULE)).toMatchObject({ read: false, sentence: expect.stringMatching(/shape Nexus does not know yet/) })
    h.preview = () => answer({ error: { code: 100 } }, false, 400)
    expect(await liveRulePreview(account, RULE)).toMatchObject({ read: false, sentence: expect.stringMatching(/did not give its preview/) })
    h.preview = () => { throw new GatewayRefusal('refused', 'META_ACCOUNT_NOT_CHOSEN', 'Nothing was sent to Meta: rule 1 is not of the Meta ad account this business chose.', 403) }
    expect(await liveRulePreview(account, RULE)).toMatchObject({ read: false, sentence: expect.stringMatching(/was not asked/) })
    h.previewCalls = 0
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    expect(await liveRulePreview(account, RULE)).toMatchObject({ read: false, sentence: expect.stringMatching(/switched off/) })
    expect(h.previewCalls).toBe(0)
  })
})
