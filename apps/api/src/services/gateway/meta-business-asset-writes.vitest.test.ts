/**
 * Meta step 43 on the gateway: a backed account and an invoice-group change reach Meta only on their EXACT allow-list entries —
 * one rule per change, step 43's own kinds (never another tool's call on the same edge), keys exact (never an invoice e-mail),
 * values judged — and only when the gateway's OWN reads confirm: the chosen Page or Instagram account; a credit line the
 * chosen ad account's portfolio owns, on a portfolio no other business in Nexus uses; an invoice group of such a line that
 * bills no other business's ad account; only the chosen ad account moved; only an empty group deleted. Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, routes: {} as Record<string, unknown>, taken: new Set<string>() }))
vi.mock('../marketing/meta-ads/taken.js', () => ({ takenIds: vi.fn(async (_p: string, ids: string[]) => new Set(ids.filter((id) => h.taken.has(id)))) }))
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
import type { MetaOwnerIo } from './meta-optimize-owner.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const PORTFOLIO = '9876543210'
const PAGE = '120000000000010'
const IG = '17840000000000001'
const LINE = '120000000000300'
const FOREIGN_LINE = '120000000000301'
const GROUP = '120000000000310'
const FULL_GROUP = '120000000000311'
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const verdict = (input: { body?: unknown; objectKind?: string; url: string; method?: string; kind?: string }) =>
  metaWriteVerdict({ method: input.method ?? 'POST', url: input.url, kind: input.kind ?? 'write', body: input.body, objectKind: input.objectKind })
const problem = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const ruleOf = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'write' in v ? v.write.rule : null }

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.routes = {}; h.taken = new Set(); gatewayLedger.length = 0
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
  it('invoice groups: create and rename with a name only (never e-mails); the chosen ad account in or out with ad_account_id; a bare delete', () => {
    expect(ruleOf({ url: `${BASE}/${LINE}/extended_credit_invoice_groups`, objectKind: 'creditline', body: form({ name: 'Group A' }) })).toBe('billing.invoiceGroup.create')
    expect(ruleOf({ url: `${BASE}/${GROUP}`, objectKind: 'invoicegroup', body: form({ name: 'Group B' }) })).toBe('billing.invoiceGroup.rename')
    expect(ruleOf({ url: `${BASE}/${GROUP}/ad_accounts`, objectKind: 'invoicegroup', body: form({ ad_account_id: ACT }) })).toBe('billing.invoiceGroup.addAccount')
    expect(ruleOf({ url: `${BASE}/${GROUP}/ad_accounts`, method: 'DELETE', objectKind: 'invoicegroup', body: form({ ad_account_id: ACT }) })).toBe('billing.invoiceGroup.removeAccount')
    expect(ruleOf({ url: `${BASE}/${GROUP}`, method: 'DELETE', objectKind: 'invoicegroup' })).toBe('billing.invoiceGroup.delete')
    // Never an e-mail, never another key, an ad account only as act_<digits>, a name judged.
    expect(problem({ url: `${BASE}/${LINE}/extended_credit_invoice_groups`, objectKind: 'creditline', body: form({ name: 'Group A', emails: '["a@example.com"]' }) })).toMatch(/only Meta change Nexus sends for business assets/)
    expect(problem({ url: `${BASE}/${GROUP}`, objectKind: 'invoicegroup', body: form({ name: 'Group B', emails: '[]' }) })).toMatch(/only Meta change Nexus sends for business assets/)
    expect(problem({ url: `${BASE}/${GROUP}/ad_accounts`, objectKind: 'invoicegroup', body: form({ ad_account_id: '1234567890' }) })).toMatch(/act_ and its digits/)
    expect(problem({ url: `${BASE}/${GROUP}`, objectKind: 'invoicegroup', body: form({ name: ' Group B' }) })).toMatch(/no space at either end/)
    expect(problem({ url: `${BASE}/${GROUP}`, objectKind: 'invoicegroup', body: form({ name: 'x'.repeat(101) }) })).toMatch(/at most 100 characters/)
    expect(problem({ url: `${BASE}/${GROUP}`, method: 'DELETE', objectKind: 'invoicegroup', body: form({ name: 'x' }) })).not.toBeNull()
    // The same bodies named another kind (or none) go by no step-43 rule.
    for (const objectKind of [undefined, 'adaccount', 'campaign', 'customaudience']) {
      expect(ruleOf({ url: `${BASE}/${GROUP}/ad_accounts`, objectKind, body: form({ ad_account_id: ACT }) }) ?? '', String(objectKind)).not.toMatch(/^billing\./)
    }
    // Meta documents validate_only on none of these edges.
    expect(problem({ url: `${BASE}/${GROUP}`, objectKind: 'invoicegroup', body: form({ name: 'Group B', execution_options: '["validate_only"]' }) })).not.toBeNull()
  })
  it('every step-43 rule is named as one (the gateway sends it to meta-business-asset-owner.ts)', () => {
    expect(META_BUSINESS_ASSET_WRITE_RULES.map((r) => r.name)).toEqual(['assets.backed.instagramForPage', 'assets.backed.threadsForPage', 'assets.backed.threadsForInstagram', 'billing.invoiceGroup.create', 'billing.invoiceGroup.rename', 'billing.invoiceGroup.addAccount', 'billing.invoiceGroup.removeAccount', 'billing.invoiceGroup.delete'])
    expect(META_BUSINESS_ASSET_WRITE_RULES.every((r) => isMetaBusinessAssetRule(r.name))).toBe(true)
    expect(isMetaBusinessAssetRule('access.accesspage.user.set')).toBe(false)
  })
})

// ── the owner check, with the gateway's own reads stood in ─────────────────────────────────────────────────────────

type Reads = Record<string, unknown>
function io(reads: Reads): MetaOwnerIo {
  return {
    chosenAdAccount: async () => '1234567890',
    read: async (path) => (reads[path] ?? null) as Record<string, unknown> | null,
    objectProblem: async () => null,
  }
}
const list = (...ids: string[]) => ({ data: ids.map((id) => ({ id })) })
const BASE_READS: Reads = {
  [ACT]: { business: { id: PORTFOLIO } },
  [`${PORTFOLIO}/owned_ad_accounts`]: { data: [{ account_id: '1234567890' }] },
  [`${PORTFOLIO}/owned_pages`]: list(PAGE),
  [`${PORTFOLIO}/owned_instagram_assets`]: { data: [{ id: '120000000000090', ig_user_id: IG }] },
  [`${PORTFOLIO}/extendedcredits`]: { data: [{ id: LINE, owner_business: { id: PORTFOLIO } }, { id: FOREIGN_LINE, owner_business: { id: '9876543211' } }] },
  [`${LINE}/extended_credit_invoice_groups`]: list(GROUP, FULL_GROUP),
  [`${FOREIGN_LINE}/extended_credit_invoice_groups`]: list('120000000000399'),
  [`${GROUP}/ad_accounts`]: { data: [] },
  [`${FULL_GROUP}/ad_accounts`]: { data: [{ account_id: '1234567890' }, { account_id: '1234567891' }] },
}
const judgedOf = (input: Parameters<typeof verdict>[0]): MetaJudgedWrite => {
  const v = verdict(input)
  if (!('write' in v)) throw new Error(v.problem)
  return v.write
}
const owner = (input: Parameters<typeof verdict>[0], reads: Reads = BASE_READS) => metaBusinessAssetOwnerProblem('m-1', judgedOf(input), input.objectKind, io(reads))
const rename = (group = GROUP) => ({ url: `${BASE}/${group}`, objectKind: 'invoicegroup', body: form({ name: 'Group B' }) })
const add = (group = GROUP, account = ACT) => ({ url: `${BASE}/${group}/ad_accounts`, objectKind: 'invoicegroup', body: form({ ad_account_id: account }) })

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
  it('a group is made only on a credit line the portfolio owns', async () => {
    expect(await owner({ url: `${BASE}/${LINE}/extended_credit_invoice_groups`, objectKind: 'creditline', body: form({ name: 'Group A' }) })).toBeNull()
    expect(await owner({ url: `${BASE}/${FOREIGN_LINE}/extended_credit_invoice_groups`, objectKind: 'creditline', body: form({ name: 'Group A' }) })).toMatchObject({ sentence: expect.stringMatching(/not a credit line the chosen ad account's business portfolio owns/) })
    expect(await owner({ url: `${BASE}/${LINE}/extended_credit_invoice_groups`, objectKind: 'creditline', body: form({ name: 'Group A' }) }, { ...BASE_READS, [`${PORTFOLIO}/extendedcredits`]: null })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
  })
  it('never on a portfolio another business in Nexus uses — by its link, or by one of its own assets — nor one Nexus cannot read in full', async () => {
    h.taken = new Set([PORTFOLIO])
    expect(await owner(rename())).toMatchObject({ sentence: expect.stringMatching(/another business in Nexus uses this Meta business portfolio/) })
    h.taken = new Set([PAGE])
    expect(await owner(rename())).toMatchObject({ sentence: expect.stringMatching(/another business in Nexus uses this Meta business portfolio/) })
    h.taken = new Set()
    expect(await owner(rename(), { ...BASE_READS, [`${PORTFOLIO}/owned_pages`]: null })).toMatchObject({ sentence: expect.stringMatching(/cannot tell that no other business/) })
  })
  it('an invoice group: of the portfolio\'s own line only; never one that bills another business\'s ad account; the chosen ad account only; only an empty one deleted', async () => {
    expect(await owner(rename())).toBeNull()
    expect(await owner(rename('120000000000399'))).toMatchObject({ sentence: expect.stringMatching(/not an invoice group of a credit line the chosen ad account's business portfolio owns/) })
    expect(await owner(add())).toBeNull()
    expect(await owner(add(GROUP, 'act_1234567891'))).toMatchObject({ sentence: expect.stringMatching(/only the ad account this business chose/) })
    expect(await owner({ url: `${BASE}/${GROUP}/ad_accounts`, method: 'DELETE', objectKind: 'invoicegroup', body: form({ ad_account_id: 'act_1234567891' }) })).toMatchObject({ sentence: expect.stringMatching(/only the ad account this business chose/) })
    h.taken = new Set(['1234567891'])
    expect(await owner(rename(FULL_GROUP))).toMatchObject({ sentence: expect.stringMatching(/bills an ad account another business in Nexus uses/) })
    h.taken = new Set()
    expect(await owner({ url: `${BASE}/${FULL_GROUP}`, method: 'DELETE', objectKind: 'invoicegroup' })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', sentence: expect.stringMatching(/still bills 2 ad accounts/) })
    expect(await owner({ url: `${BASE}/${GROUP}`, method: 'DELETE', objectKind: 'invoicegroup' })).toBeNull()
    // A list Meta does not answer, or cuts, refuses.
    expect(await owner(rename(), { ...BASE_READS, [`${GROUP}/ad_accounts`]: null })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
    expect(await owner(rename(), { ...BASE_READS, [`${GROUP}/ad_accounts`]: { data: [], paging: { next: 'x' } } })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
    expect(await owner(rename(), { ...BASE_READS, [`${LINE}/extended_credit_invoice_groups`]: null })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
  })
  it('Meta\'s check is refused; a write named another kind than its rule\'s is refused', async () => {
    expect(await metaBusinessAssetOwnerProblem('m-1', { ...judgedOf(rename()), check: true }, 'invoicegroup', io(BASE_READS))).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(await metaBusinessAssetOwnerProblem('m-1', judgedOf(rename()), 'creditline', io(BASE_READS))).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
  })
})

describe('through the gateway (metaWriteCall)', () => {
  const routes = (over: Record<string, unknown> = {}) => {
    h.routes = Object.fromEntries(Object.entries({ ...BASE_READS, ...over }).map(([path, body]) => [`GET ${path}`, body]))
  }
  it('a Page-backed Instagram account: sent to the chosen Page\'s edge with no body', async () => {
    routes()
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
  it('an invoice group renamed: the judged form body; another ad account put in: nothing sent', async () => {
    routes()
    const ok = await metaWriteCall({ connectionId: 'm-1', operation: 'billing.invoiceGroup.rename', objectId: GROUP, objectKind: 'invoicegroup', params: { name: 'Group B' }, check: false })
    expect(ok.ok).toBe(true)
    const post = h.calls.find((c) => c.init.method === 'POST')!
    expect(String(post.init.body)).toBe(form({ name: 'Group B' }))
    h.calls = []
    __metaObjectLimitsTest.reset(); __metaObjectLimitsTest.useMemory()
    const wrong = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: GROUP, objectKind: 'invoicegroup', edge: 'ad_accounts', params: { ad_account_id: 'act_1234567891' }, check: false }).catch((e) => e)
    expect(wrong).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls.filter((c) => c.init.method !== 'GET')).toEqual([])
  })
})
