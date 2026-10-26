/**
 * Meta step 43 on the gateway: a backed account reaches Meta only on its EXACT allow-list entry — one rule per kind, step 43's
 * own kinds (never another tool's call on the same edge), no body — and only for the business's CHOSEN Page or Instagram
 * account (the gateway's own read of its links). Invoice groups are a read-only guide (D1): no billing write is on the
 * allow-list at all. Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, routes: {} as Record<string, unknown> }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/token.service.js', () => ({
  getAccessToken: vi.fn(async () => 'meta-system-user-token'),
  metaAppAccessToken: vi.fn(async () => '1234567|app-secret-for-tests'),
  metaAppIdOf: vi.fn(async () => '1234567'),
  metaRenewalToken: vi.fn(async () => 'stored-meta-token'),
  metaRequestProof: vi.fn(async () => ({ appsecret_proof: 'proof', appsecret_time: '1760000000' })),
}))
vi.mock('../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))
vi.mock('../cx/connectors/meta/token-check.js', () => ({ forgetMetaTokenCheck: vi.fn(async () => undefined) }))

import { gatewayLedger, gatewayMetaChosen, gatewayMetaInstagram, gatewayMetaPage } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaWriteCall } from './meta.js'
import { metaWriteVerdict, type MetaJudgedWrite } from './meta-calls.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { metaBusinessAssetOwnerProblem } from './meta-business-asset-owner.js'
import { META_BUSINESS_ASSET_WRITE_RULES, isMetaBusinessAssetRule } from './meta-business-asset-rules.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const PAGE = '120000000000010'
const IG = '17840000000000001'
const LINE = '120000000000300'
const GROUP = '120000000000310'
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const verdict = (input: { body?: unknown; objectKind?: string; url: string; method?: string; kind?: string }) =>
  metaWriteVerdict({ method: input.method ?? 'POST', url: input.url, kind: input.kind ?? 'write', body: input.body, objectKind: input.objectKind })
const problem = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const ruleOf = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'write' in v ? v.write.rule : null }

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.routes = {}; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  for (const key of Object.keys(gatewayMetaPage)) delete gatewayMetaPage[key]
  for (const key of Object.keys(gatewayMetaInstagram)) delete gatewayMetaInstagram[key]
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    const u = new URL(String(url))
    const path = u.pathname.replace(/^\/v\d+\.\d+\//, '')
    const answer = h.routes[`${init.method ?? 'GET'} ${path}`]
    return new Response(JSON.stringify(answer ?? { success: true }), { status: answer === undefined && (init.method ?? 'GET') === 'GET' ? 400 : 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('the allow-list: one rule per change, step 43\'s own kinds, exact keys', () => {
  it('backed accounts: POST on the chosen Page\'s or Instagram account\'s edge, with no body at all', () => {
    expect(ruleOf({ url: `${BASE}/${PAGE}/page_backed_instagram_accounts`, objectKind: 'backedpage' })).toBe('assets.backed.instagramForPage')
    expect(ruleOf({ url: `${BASE}/${PAGE}/page_backed_threads_accounts`, objectKind: 'backedpage' })).toBe('assets.backed.threadsForPage')
    expect(ruleOf({ url: `${BASE}/${IG}/instagram_backed_threads_user`, objectKind: 'backedinstagram' })).toBe('assets.backed.threadsForInstagram')
    // A body, another kind, the wrong object's edge, a DELETE: no rule.
    expect(problem({ url: `${BASE}/${PAGE}/page_backed_instagram_accounts`, objectKind: 'backedpage', body: form({ name: 'x' }) })).toMatch(/only Meta change Nexus sends for business assets/)
    expect(ruleOf({ url: `${BASE}/${PAGE}/page_backed_instagram_accounts`, objectKind: 'page' })).toBeNull()
    expect(ruleOf({ url: `${BASE}/${IG}/page_backed_threads_accounts`, objectKind: 'backedinstagram' })).toBeNull()
    expect(ruleOf({ url: `${BASE}/${PAGE}/page_backed_instagram_accounts`, objectKind: 'backedpage', method: 'DELETE' })).toBeNull()
  })
  it('no invoice-group write goes: create, rename, add, remove and delete match no rule, whatever the kind', () => {
    for (const objectKind of [undefined, 'creditline', 'invoicegroup', 'adaccount']) {
      expect(ruleOf({ url: `${BASE}/${LINE}/extended_credit_invoice_groups`, objectKind, body: form({ name: 'Group A' }) }), String(objectKind)).toBeNull()
      expect(ruleOf({ url: `${BASE}/${GROUP}`, objectKind, body: form({ name: 'Group B' }) }), String(objectKind)).toBeNull()
      expect(ruleOf({ url: `${BASE}/${GROUP}/ad_accounts`, objectKind, body: form({ ad_account_id: ACT }) }) ?? '', String(objectKind)).not.toMatch(/invoiceGroup/)
      expect(ruleOf({ url: `${BASE}/${GROUP}/ad_accounts`, method: 'DELETE', objectKind, body: form({ ad_account_id: ACT }) }) ?? '', String(objectKind)).not.toMatch(/invoiceGroup/)
      expect(ruleOf({ url: `${BASE}/${GROUP}`, method: 'DELETE', objectKind }) ?? '', String(objectKind)).not.toMatch(/invoiceGroup/)
    }
  })
  it('every step-43 rule is named as one (the gateway sends it to meta-business-asset-owner.ts)', () => {
    expect(META_BUSINESS_ASSET_WRITE_RULES.map((r) => r.name)).toEqual(['assets.backed.instagramForPage', 'assets.backed.threadsForPage', 'assets.backed.threadsForInstagram'])
    expect(META_BUSINESS_ASSET_WRITE_RULES.every((r) => isMetaBusinessAssetRule(r.name))).toBe(true)
    expect(isMetaBusinessAssetRule('access.accesspage.user.set')).toBe(false)
  })
})

// ── the owner check ────────────────────────────────────────────────────────────────────────────────────────────────

const judgedOf = (input: Parameters<typeof verdict>[0]): MetaJudgedWrite => {
  const v = verdict(input)
  if (!('write' in v)) throw new Error(v.problem)
  return v.write
}
const owner = (input: Parameters<typeof verdict>[0]) => metaBusinessAssetOwnerProblem('m-1', judgedOf(input), input.objectKind)

describe('the owner check (meta-business-asset-owner.ts)', () => {
  it('a backed account only for the chosen Page or Instagram account', async () => {
    const page = { url: `${BASE}/${PAGE}/page_backed_instagram_accounts`, objectKind: 'backedpage' }
    expect(await owner(page)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', sentence: expect.stringMatching(/chosen no Facebook Page/) })
    gatewayMetaPage['m-1'] = PAGE
    expect(await owner(page)).toBeNull()
    expect(await owner({ url: `${BASE}/120000000000011/page_backed_threads_accounts`, objectKind: 'backedpage' })).toMatchObject({ sentence: expect.stringMatching(/is not the Facebook Page this business chose/) })
    const ig = { url: `${BASE}/${IG}/instagram_backed_threads_user`, objectKind: 'backedinstagram' }
    expect(await owner(ig)).toMatchObject({ sentence: expect.stringMatching(/chosen no Instagram account/) })
    gatewayMetaInstagram['m-1'] = IG
    expect(await owner(ig)).toBeNull()
    expect(await owner({ url: `${BASE}/17840000000000002/instagram_backed_threads_user`, objectKind: 'backedinstagram' })).toMatchObject({ sentence: expect.stringMatching(/not the Instagram account this business chose/) })
  })
  it('Meta\'s check is refused; a write named another kind than its rule\'s is refused', async () => {
    gatewayMetaPage['m-1'] = PAGE
    const page = { url: `${BASE}/${PAGE}/page_backed_instagram_accounts`, objectKind: 'backedpage' }
    expect(await metaBusinessAssetOwnerProblem('m-1', { ...judgedOf(page), check: true }, 'backedpage')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(await metaBusinessAssetOwnerProblem('m-1', judgedOf(page), 'backedinstagram')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
  })
})

describe('through the gateway (metaWriteCall)', () => {
  it('a Page-backed Instagram account: sent to the chosen Page\'s edge with no body', async () => {
    gatewayMetaPage['m-1'] = PAGE
    h.routes[`POST ${PAGE}/page_backed_instagram_accounts`] = { id: '17840000000000099' }
    const ok = await metaWriteCall({ connectionId: 'm-1', operation: 'assets.backed.instagram-for-page', objectId: PAGE, objectKind: 'backedpage', edge: 'page_backed_instagram_accounts', params: {}, check: false })
    expect(ok.ok).toBe(true)
    const post = h.calls.find((c) => c.init.method === 'POST')!
    expect(new URL(post.url).pathname).toBe(`/${META_DEFAULT_GRAPH_API_VERSION}/${PAGE}/page_backed_instagram_accounts`)
    expect(post.init.body ?? '').toBe('')
    // Another Page: nothing sent.
    h.calls = []
    const other = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: '120000000000011', objectKind: 'backedpage', edge: 'page_backed_instagram_accounts', params: {}, check: false }).catch((e) => e)
    expect(other).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls.filter((c) => c.init.method !== 'GET')).toEqual([])
  })
})
