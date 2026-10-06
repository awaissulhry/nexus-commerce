/**
 * CC-12 / CC-18 — what reaches the wire, driven through the REAL liveCall and the REAL channel gateway with `fetch`
 * stubbed (the pattern of ads-api-client.vitest.test.ts). Nothing leaves the process.
 *
 * - CC-12: `POST /sd/targets` carries SD's dialect (bare array, numeric adGroupId, `expressionType: 'manual'`, lowercase
 *   state, `asinSameAs`), and the id is read from SD's bare-array answer.
 * - CC-18: `POST /sp/negativeTargets` (v3) carries `ASIN_SAME_AS`, the v3 type Amazon's SP 3.0 document lists — not the
 *   v2 `asinSameAs`. Both still need one live confirmation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
vi.mock('../../db.js', () => ({
  default: {
    adKeywordProtection: { findMany: async () => [] },
    campaign: { findFirst: async () => ({ id: 'c-1', marketplace: 'IT' }) },
    adTarget: { findFirst: async () => null },
  },
}))
vi.mock('../gateway/account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../gateway/ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../../lib/workspace-context.js', async (original) => ({ ...(await original<object>()), requireWorkspace: () => ({ workspaceId: 'ws' }) }))
vi.mock('../connection-resolver.service.js', async (original) => ({
  ...(await original<object>()),
  resolveConnectionForProfile: vi.fn(async () => ({ id: 'ads-1', connectionMetadata: {} })),
}))
vi.mock('../cx/apps.service.js', () => ({ getChannelApp: vi.fn(async () => ({ clientId: 'amzn1.application-oa2-client.x' })) }))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'ads-token') }))
vi.mock('../outbound-api-call-log.service.js', async (original) => ({
  ...(await original<object>()),
  recordApiCall: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
}))

import { gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest } from '../gateway/rate.js'
import { createNegativeProductTarget, createSdTarget } from './ads-api-client.js'
import { sdTargetExpression } from './sd-target-expression.js'

const ctx = { profileId: '123', region: 'EU' as const }

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', 'off')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response('[]', { status: 207 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

describe('CC-12 — POST /sd/targets on the wire', () => {
  it('a product target: SD dialect in the body, the id read from the bare-array answer', async () => {
    h.answers.push(() => new Response(JSON.stringify([{ code: 'SUCCESS', targetId: 555001 }]), { status: 207 }))
    const r = await createSdTarget(ctx, { externalCampaignId: '900', externalAdGroupId: '901', expression: sdTargetExpression({ kind: 'PRODUCT', value: 'B0TEST0001' }), bid: 0.4 })
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['POST', '/sd/targets']])
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual([
      { adGroupId: 901, expressionType: 'manual', expression: [{ type: 'asinSameAs', value: 'B0TEST0001' }], bid: 0.4, state: 'enabled' },
    ])
    expect(r).toMatchObject({ ok: true, mode: 'live', externalId: '555001', error: null })
  })

  it('a views audience goes nested, with its lookback', async () => {
    h.answers.push(() => new Response(JSON.stringify([{ code: 'SUCCESS', targetId: 555002 }]), { status: 207 }))
    await createSdTarget(ctx, { externalAdGroupId: '901', expression: sdTargetExpression({ kind: 'AUDIENCE', audienceType: 'VIEWS_REMARKETING', value: 'exactProduct' }), bid: 0.5 })
    expect(JSON.parse(String(h.calls[0].init.body))[0].expression).toEqual([{ type: 'views', value: [{ type: 'exactProduct' }, { type: 'lookback', value: '30' }] }])
  })

  it('a refused target is not ok, and carries Amazon\'s words', async () => {
    h.answers.push(() => new Response(JSON.stringify([{ code: 'INVALID_ARGUMENT', description: 'Cannot create targeting clause: audience size is too small' }]), { status: 207 }))
    const r = await createSdTarget(ctx, { externalAdGroupId: '901', expression: sdTargetExpression({ kind: 'PRODUCT', value: 'B0TEST0001' }), bid: 0.4 })
    expect(r.ok).toBe(false)
    expect(r.externalId).toBeNull()
    expect(r.error).toMatch(/audience size is too small/)
  })
})

describe('CC-18 — POST /sp/negativeTargets on the wire', () => {
  it('the v3 predicate type ASIN_SAME_AS, the same casing the positive /sp/targets path uses', async () => {
    h.answers.push(() => new Response(JSON.stringify({ negativeTargetingClauses: { success: [{ index: 0, targetId: 'nt-1' }], error: [] } }), { status: 207 }))
    const r = await createNegativeProductTarget(ctx, { externalCampaignId: 'EXT-1', externalAdGroupId: 'EXT-G', asin: 'B0TEST0002' })
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['POST', '/sp/negativeTargets']])
    const sent = JSON.parse(String(h.calls[0].init.body))
    expect(sent.negativeTargetingClauses[0].expression).toEqual([{ type: 'ASIN_SAME_AS', value: 'B0TEST0002' }])
    expect(JSON.stringify(sent)).not.toContain('asinSameAs')
    expect(r.externalId).toBe('nt-1')
  })
})
