/**
 * Meta step 36 on the gateway — lead forms and test leads, and THE Page token mode (Q1):
 *   - the lead-form rules are an exact ALLOW-list: every key at every depth of every JSON value, one spelling only, the
 *     silent AI agent always off, sliders / national ids / files / group ids refused, links https only;
 *   - every one goes AS the chosen Page: the gateway reads the Page's own token (GET /<page>?fields=access_token with the
 *     system-user token) for that ONE call, only after the object was confirmed the chosen Page or a child of it, and
 *     never hands it out: not in an answer, an error, the ledger, a trace — and a caller still cannot read or send one;
 *   - the owner check per kind (the Page, a form of it, a test lead Nexus made, a photo of it inside the body), with a
 *     neighbour of another business and a node of another kind.
 * Made-up ids only.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PAGE_TOKEN = 'pagetoken0123456789abcdefghijKLMN'
const SYSTEM_TOKEN = 'meta-system-user-token'
const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init: RequestInit }>,
  answers: [] as Array<() => Response>,
  proofs: [] as string[],
  spans: [] as Array<{ name: string; attrs: Record<string, unknown> }>,
}))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/token.service.js', () => ({
  getAccessToken: vi.fn(async () => 'meta-system-user-token'),
  metaAppAccessToken: vi.fn(async () => '1234567|app-secret-for-tests'),
  metaAppIdOf: vi.fn(async () => '1234567'),
  metaRenewalToken: vi.fn(async () => 'stored-meta-token'),
  metaRequestProof: vi.fn(async (_connectionId: string, token: string) => {
    h.proofs.push(token)
    return { appsecret_proof: `proof-${h.proofs.length}`, appsecret_time: '1760000000' }
  }),
}))
vi.mock('../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))
vi.mock('../cx/connectors/meta/token-check.js', () => ({ forgetMetaTokenCheck: vi.fn(async () => undefined) }))
vi.mock('../../utils/otel-setup.js', () => ({
  withSpan: vi.fn(async (name: string, attrs: Record<string, unknown>, fn: (span: null) => Promise<unknown>) => { h.spans.push({ name, attrs }); return fn(null) }),
}))

import { gatewayLedger, gatewayMetaNexusMade, gatewayMetaPage, gatewayMetaStored } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { gatewayCall, GatewayRefusal } from './gateway.js'
import { metaCall, metaWriteCall } from './meta.js'
import { metaWriteVerdict, scrubMetaAnswer } from './meta-calls.js'
import { META_LEAD_TYPES_SENT, metaLeadFormCreateProblem, metaTestLeadProblem } from './meta-lead-form-rules.js'
import { metaPageTokenFor, MetaPageTokenUnavailable, scrubExactToken } from './meta-page-token.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { metaSendChange } from '../marketing/meta-ads/write-client.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const PAGE = '120000000000010'
const OTHER_PAGE = '120000000000099'
const FORM = '600000000000001'
const OTHER_FORM = '600000000000099'
const LEAD = '700000000000001'
const PHOTO = '800000000000001'

const QUESTIONS = JSON.stringify([{ type: 'FULL_NAME', key: 'full_name' }, { type: 'EMAIL', key: 'email' }, { type: 'CUSTOM', key: 'size', label: 'Which size?', options: [{ value: 'M', key: 'm' }, { value: 'L', key: 'l' }] }])
const formParams = (extra: Record<string, string> = {}): Record<string, string> => ({
  name: 'Form A — Italia', questions: QUESTIONS, is_lead_capture_ai_agent_enabled: 'false', block_display_for_non_targeted_viewer: 'true', ...extra,
})
const formBody = (extra: Record<string, string> = {}) => new URLSearchParams(formParams(extra)).toString()
const verdict = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) =>
  metaWriteVerdict({ method: 'POST', url: `${BASE}/${PAGE}/leadgen_forms`, kind: 'write', objectKind: 'page', body: formBody(), ...input })
const problem = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => {
  const v = verdict(input)
  return 'problem' in v ? v.problem : null
}
const createProblem = (extra: Record<string, string>) => metaLeadFormCreateProblem(new Map(Object.entries(formParams(extra))))
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const tokenAnswer = (token = PAGE_TOKEN, id = PAGE) => json({ id, access_token: token })
const sent = (i: number) => ({ method: h.calls[i].init.method, url: new URL(h.calls[i].url), body: h.calls[i].init.body })
/** Everything the gateway kept or handed back, as one text: no Page token may be in it. */
const everythingKept = (extra: unknown[] = []) => JSON.stringify([gatewayLedger, h.spans, ...extra])

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; h.proofs = []; h.spans = []; gatewayLedger.length = 0
  // The merge with main: step 19's Page stub (no Page unless a test sets one); m-1 chose PAGE.
  for (const key of Object.keys(gatewayMetaPage)) delete gatewayMetaPage[key]
  gatewayMetaPage['m-1'] = PAGE
  for (const key of Object.keys(gatewayMetaStored)) delete gatewayMetaStored[key]
  gatewayMetaNexusMade.clear()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ id: FORM }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('the lead-form rules are an exact allow-list', () => {
  it('a form create of the chosen Page goes as a write made as the Page, its body written again in one order', () => {
    const v = verdict({ body: formBody({ locale: 'IT_IT' }) })
    expect(v).toMatchObject({ write: { rule: 'leadform.create', objectId: PAGE, check: false, budget: false, kinds: ['page'], auth: 'page' } })
    const body = new URLSearchParams(('write' in v) ? v.write.body : '')
    expect([...body.keys()]).toEqual(['name', 'questions', 'is_lead_capture_ai_agent_enabled', 'block_display_for_non_targeted_viewer', 'locale'])
    // Accents and the em dash are text a person types: allowed only in the rule's text keys.
    expect(body.get('name')).toBe('Form A — Italia')
  })
  it('every option of the reference passes, each judged', () => {
    expect(createProblem({
      locale: 'DE_DE',
      privacy_policy: JSON.stringify({ url: 'https://example.com/privacy', link_text: 'Datenschutz' }),
      context_card: JSON.stringify({ title: 'Hallo', style: 'LIST_STYLE', content: ['Eins', 'Zwei'], button_text: 'Weiter', cover_photo_id: PHOTO }),
      thank_you_page: JSON.stringify({ title: 'Danke', body: 'Wir melden uns.', button_type: 'VIEW_WEBSITE', website_url: 'https://example.com', business_phone_number: '+390000000000', country_code: 'IT', enable_messenger: false }),
      custom_disclaimer: JSON.stringify({ title: 'Einwilligung', body: { text: 'Siehe Bedingungen', url_entities: [{ offset: 6, length: 11, url: 'https://example.com/terms' }] }, checkboxes: [{ text: 'Ja', key: 'consent_marketing', is_required: false, is_checked_by_default: false }] }),
      follow_up_action_url: 'https://example.com/after', question_page_custom_headline: 'Ein paar Fragen',
      is_optimized_for_quality: 'true', is_phone_sms_verify_enabled: 'false', should_enforce_work_email: 'false', is_for_canvas: 'false',
      tracking_parameters: JSON.stringify({ campaign_ref: 'spring' }),
    })).toBeNull()
    expect(createProblem({ questions: JSON.stringify([{ type: 'DATE_TIME', key: 'when', label: 'Appointment', inline_context: 'We call you.' }, { type: 'STORE_LOOKUP', key: 'store', label: 'Store?', context_provider_type: 'LOCATION_MANAGER' }]) })).toBeNull()
    expect(createProblem({ questions: JSON.stringify([{ type: 'CUSTOM', key: 'b', label: 'B?', dependent_conditional_questions: [{ field_key: 'a', input_type: 'CUSTOM', name: 'A' }] }]) })).toBeNull()
  })
  it('the AI agent is always sent, and only false; who sees the form is always named', () => {
    expect(problem({ body: new URLSearchParams({ ...formParams(), is_lead_capture_ai_agent_enabled: 'true' }).toString() })).toMatch(/always false/)
    const { is_lead_capture_ai_agent_enabled: _a, ...noAgent } = formParams()
    expect(problem({ body: new URLSearchParams(noAgent).toString() })).toMatch(/only Meta change/)
    const { block_display_for_non_targeted_viewer: _b, ...noViewer } = formParams()
    expect(problem({ body: new URLSearchParams(noViewer).toString() })).toMatch(/only Meta change/)
    expect(problem({ body: formBody({ block_display_for_non_targeted_viewer: 'yes' }) })).toMatch(/true or false/)
  })
  it('refuses every key Nexus does not send: the deprecated flag, the two files, a token, a group id', () => {
    for (const key of ['allow_organic_lead_retrieval', 'cover_photo', 'upload_gated_file', 'status', 'fields', 'execution_options', 'page_id']) {
      expect(problem({ body: formBody({ [key]: 'x' }) }), key).toMatch(/only Meta change/)
    }
    expect(problem({ body: formBody({ access_token: PAGE_TOKEN }) })).toMatch(/no Nexus change sends/)
    expect(problem({ body: formBody({ page_access_token: PAGE_TOKEN }) })).toMatch(/no Nexus change sends/)
    expect(problem({ body: `${formBody()}&name=Twice` })).toMatch(/more than once/)
  })
  it('refuses any member Nexus does not send, at every depth of every JSON value', () => {
    const q = (extra: Record<string, unknown>) => JSON.stringify([{ type: 'CUSTOM', key: 'a', label: 'A?', ...extra }])
    expect(createProblem({ questions: q({ conditional_questions_group_id: '123' }) })).toMatch(/no key "conditional_questions_group_id"/)
    expect(createProblem({ questions: q({ options: [{ value: 'x', key: 'x', photo: { id: PHOTO } }] }) })).toMatch(/no key "photo"/)
    expect(createProblem({ questions: q({ dependent_conditional_questions: [{ field_key: 'a', input_type: 'CUSTOM', name: 'A', extra: 1 }] }) })).toMatch(/no key "extra"/)
    expect(createProblem({ thank_you_page: JSON.stringify({ title: 'T', button_type: 'NONE', gated_file: { id: '1' } }) })).toMatch(/no gated file/)
    expect(createProblem({ thank_you_page: JSON.stringify({ title: 'T', button_type: 'NONE', lead_gen_use_case: 'x' }) })).toMatch(/no key "lead_gen_use_case"/)
    expect(createProblem({ custom_disclaimer: JSON.stringify({ body: { text: 'T', extra: true } }) })).toMatch(/no key "extra"/)
    expect(createProblem({ custom_disclaimer: JSON.stringify({ body: { text: 'T' }, checkboxes: [{ text: 'x', key: 'k', other: 1 }] }) })).toMatch(/no key "other"/)
    expect(createProblem({ privacy_policy: JSON.stringify({ url: 'https://example.com', link_text: 'x', extra: 1 }) })).toMatch(/no key "extra"/)
    expect(createProblem({ context_card: JSON.stringify({ title: 'x', cover_photo: 'file' }) })).toMatch(/no key "cover_photo"/)
    expect(createProblem({ questions: '[{"type":"EMAIL","key":"email","__proto__":{"x":1}}]' })).toMatch(/no key "__proto__"/)
  })
  it('one spelling only: no spaces, no escapes Nexus does not write, no JSON-like text that is not JSON', () => {
    expect(createProblem({ questions: '[ {"type":"EMAIL","key":"email"} ]' })).toMatch(/one spelling/)
    expect(createProblem({ questions: '[{"type":"EM\\u0041IL","key":"email"}]' })).toMatch(/one spelling/)
    expect(createProblem({ questions: '[{\'type\':\'EMAIL\'}]' })).toMatch(/is JSON/)
    expect(createProblem({ questions: '[]' })).toMatch(/a list of 1 to 30/)
    expect(createProblem({ questions: JSON.stringify(Array.from({ length: 31 }, (_, i) => ({ type: 'CUSTOM', key: `q${i}`, label: 'x' }))) })).toMatch(/a list of 1 to 30/)
  })
  it('question rules: Meta\'s enum, no slider, no national id, a key each once, a CUSTOM label, options only on CUSTOM', () => {
    expect(META_LEAD_TYPES_SENT).toContain('MARITIAL_STATUS')
    expect(META_LEAD_TYPES_SENT).not.toContain('SLIDER')
    expect(createProblem({ questions: JSON.stringify([{ type: 'SLIDER', key: 's' }]) })).toMatch(/no shape for a slider/)
    expect(createProblem({ questions: JSON.stringify([{ type: 'ID_CPF', key: 'id' }]) })).toMatch(/Latin America only/)
    expect(createProblem({ questions: JSON.stringify([{ type: 'MARITAL_STATUS', key: 'm' }]) })).toMatch(/is one of/)
    expect(createProblem({ questions: JSON.stringify([{ type: 'EMAIL' }]) })).toMatch(/names key/)
    expect(createProblem({ questions: JSON.stringify([{ type: 'EMAIL', key: 'a' }, { type: 'PHONE', key: 'a' }]) })).toMatch(/each question's key once/)
    expect(createProblem({ questions: JSON.stringify([{ type: 'CUSTOM', key: 'a' }]) })).toMatch(/has a label/)
    expect(createProblem({ questions: JSON.stringify([{ type: 'EMAIL', key: 'a', options: [{ value: 'x', key: 'x' }] }]) })).toMatch(/only a CUSTOM question has options/)
    expect(createProblem({ questions: JSON.stringify([{ type: 'CUSTOM', key: 'a', label: 'A', options: [{ value: 'x', key: 'k' }, { value: 'y', key: 'k' }] }]) })).toMatch(/each option's key once/)
    expect(createProblem({ questions: JSON.stringify([{ type: 'EMAIL', key: 'a', context_provider_type: 'LOCATION_MANAGER' }]) })).toMatch(/only a store-locator/)
    expect(createProblem({ questions: JSON.stringify([{ type: 'CUSTOM', key: 'a-b', label: 'A' }]) })).toMatch(/letters, digits and _/)
  })
  it('values: https links only, link text at most 70, phone and country shapes, printable text, locale and button enums', () => {
    for (const bad of ['http://example.com', 'javascript:alert(1)', 'https://user:pw@example.com', 'https://localhost/x', 'https://exa mple.com', 'ftp://example.com']) {
      expect(createProblem({ privacy_policy: JSON.stringify({ url: bad }) }), bad).toMatch(/https link/)
    }
    expect(createProblem({ privacy_policy: JSON.stringify({ url: 'https://example.com', link_text: 'x'.repeat(71) }) })).toMatch(/at most 70/)
    expect(createProblem({ follow_up_action_url: 'http://example.com' })).toMatch(/https link/)
    expect(createProblem({ thank_you_page: JSON.stringify({ title: 'T', button_type: 'CALL_BUSINESS', business_phone_number: '+39 000' }) })).toMatch(/phone number/)
    expect(createProblem({ thank_you_page: JSON.stringify({ title: 'T', button_type: 'CALL_NOW' }) })).toMatch(/is one of/)
    expect(createProblem({ thank_you_page: JSON.stringify({ button_type: 'NONE' }) })).toMatch(/names title/)
    expect(createProblem({ locale: 'it_IT' })).toMatch(/locale is one of/)
    expect(createProblem({ questions: JSON.stringify([{ type: 'CUSTOM', key: 'a', label: 'A\u0007' }]) })).toMatch(/printable text/)
    expect(createProblem({ custom_disclaimer: JSON.stringify({ body: { text: 'Short', url_entities: [{ offset: 3, length: 10, url: 'https://example.com' }] } }) })).toMatch(/within it/)
    expect(createProblem({ tracking_parameters: JSON.stringify({ 'bad key': 'x' }) })).toMatch(/letters, digits/)
    // A control character in a text key is refused by the gateway before the JSON judges.
    expect(problem({ body: formBody({ name: 'Form\u0000A' }) })).toMatch(/printable text/)
    // Plain ASCII everywhere else.
    expect(problem({ body: formBody({ locale: 'IT_IT', follow_up_action_url: 'https://example.com/è' }) })).toMatch(/plain ASCII/)
  })
  it('one rule per kind: the path, the kind and the method must all match; a campaign\'s status rule is untouched', () => {
    expect(problem({ objectKind: undefined })).toMatch(/only Meta change/)
    expect(problem({ objectKind: 'campaign' })).toMatch(/only Meta change/)
    expect(problem({ objectKind: 'leadform' })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${PAGE}/leadgen_forms/${FORM}` })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${PAGE}/%6Ceadgen_forms` })).toMatch(/percent-encoded/)
    expect(problem({ url: `${BASE}/${PAGE}/leadgen_forms?name=x` })).toMatch(/never in the URL/)
    expect(problem({ body: formBody().padEnd(64_001, 'x') })).toMatch(/at most/)
    // The status rule of step 17: the same path shape, but a form's status goes only by its own kind.
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${FORM}`, kind: 'write', body: 'status=ARCHIVED', objectKind: 'leadform' })).toMatchObject({ write: { rule: 'leadform.status', auth: 'page', kinds: ['leadform'] } })
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${FORM}`, kind: 'write', body: 'status=ARCHIVED', objectKind: 'campaign' })).toEqual({ write: { rule: 'object.status', objectId: FORM, check: false, body: 'status=ARCHIVED', budget: false } })
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${FORM}`, kind: 'write', body: 'status=DELETED', objectKind: 'leadform' })).toMatchObject({ problem: expect.stringMatching(/does not support deleting a lead form/) })
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${FORM}`, kind: 'write', body: 'status=DRAFT', objectKind: 'leadform' })).toMatchObject({ problem: expect.stringMatching(/ARCHIVED or ACTIVE/) })
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${FORM}`, kind: 'write', body: 'status=ARCHIVED&fields=id', objectKind: 'leadform' })).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
  })
  it('test leads: made-up answers by key, consent boxes, nothing else; a DELETE only of a test lead, with no body', () => {
    const tl = (body: string, objectKind = 'leadform') => metaWriteVerdict({ method: 'POST', url: `${BASE}/${FORM}/test_leads`, kind: 'write', body, objectKind })
    const answers = JSON.stringify([{ name: 'email', values: ['test@example.com'] }])
    expect(tl(new URLSearchParams({ field_data: answers, custom_disclaimer_responses: JSON.stringify([{ checkbox_key: 'consent_marketing', is_checked: true }]) }).toString())).toMatchObject({ write: { rule: 'testlead.create', auth: 'page', kinds: ['leadform'] } })
    expect(tl(new URLSearchParams({ field_data: JSON.stringify([{ name: 'email', values: ['x'], extra: 1 }]) }).toString())).toMatchObject({ problem: expect.stringMatching(/no key "extra"/) })
    expect(tl(new URLSearchParams({ field_data: JSON.stringify([{ name: 'email', values: ['x'] }, { name: 'email', values: ['y'] }]) }).toString())).toMatchObject({ problem: expect.stringMatching(/each question's answer once/) })
    expect(tl(new URLSearchParams({ field_data: answers, custom_disclaimer_responses: JSON.stringify([{ checkbox_key: 'k', is_checked: 'true' }]) }).toString())).toMatchObject({ problem: expect.stringMatching(/true or false/) })
    expect(tl(new URLSearchParams({ field_data: "[{'name':'email','values':['x']}]" }).toString())).toMatchObject({ problem: expect.stringMatching(/is JSON/) })
    expect(tl(new URLSearchParams({ field_data: answers }).toString(), 'page')).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    const del = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => metaWriteVerdict({ method: 'DELETE', url: `${BASE}/${LEAD}`, kind: 'write', objectKind: 'testlead', ...input })
    expect(del({})).toEqual({ write: { rule: 'testlead.delete', objectId: LEAD, check: false, body: '', budget: false, kinds: ['testlead'], method: 'DELETE', auth: 'page' } })
    expect(del({ body: 'x=1' })).toMatchObject({ problem: expect.stringMatching(/Nexus deletes on Meta only .*a test lead Nexus made on a lead form of the chosen Page/) })
    expect(del({ objectKind: undefined })).toMatchObject({ problem: expect.stringMatching(/Nexus deletes on Meta only/) })
    expect(del({ objectKind: 'leadform' })).toMatchObject({ problem: expect.stringMatching(/Nexus deletes on Meta only/) })
    expect(del({ objectKind: 'page', url: `${BASE}/${PAGE}` })).toMatchObject({ problem: expect.stringMatching(/Nexus deletes on Meta only/) })
    expect(del({ kind: 'read' })).toMatchObject({ problem: expect.stringMatching(/goes as a write/) })
  })
  it('a caller can never ask for the Page token: any auth but the account\'s is refused, the Page\'s included', () => {
    for (const auth of ['page', 'app', 'none', { token: PAGE_TOKEN }, { token: PAGE_TOKEN, appSecret: 's' }]) {
      expect(problem({ auth }), JSON.stringify(auth)).toMatch(/goes only with the account's own system-user token/)
    }
  })
})

describe('THE Page token mode', () => {
  it('reads the chosen Page\'s token with the system-user token for that one call, sends the change with it, hands it to no one', async () => {
    h.answers.push(tokenAnswer(), json({ id: FORM }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'leadform.create', objectId: PAGE, objectKind: 'page', edge: 'leadgen_forms', params: formParams(), check: false })
    expect(res.ok).toBe(true)
    expect(h.calls).toHaveLength(2)
    // 1. the token read: GET /<chosen page>?fields=access_token, with the SYSTEM-USER token and its own proof.
    const read = sent(0)
    expect(read.method).toBe('GET')
    expect(read.url.pathname).toBe(`/v26.0/${PAGE}`)
    expect(read.url.searchParams.get('fields')).toBe('access_token')
    expect(read.url.searchParams.get('access_token')).toBe(SYSTEM_TOKEN)
    expect(h.calls[0].init.redirect).toBe('error')
    // 2. the change: POST with the PAGE token on the URL that is sent, and a proof made from the Page token.
    const post = sent(1)
    expect(post.method).toBe('POST')
    expect(post.url.pathname).toBe(`/v26.0/${PAGE}/leadgen_forms`)
    expect(post.url.searchParams.get('access_token')).toBe(PAGE_TOKEN)
    expect(h.proofs).toEqual([SYSTEM_TOKEN, PAGE_TOKEN])
    expect(String(post.body)).not.toContain(PAGE_TOKEN)
    // Nowhere else: not the answer, its url, the ledger (both rows), a trace.
    expect(JSON.stringify(res)).not.toContain(PAGE_TOKEN)
    expect(res.url).not.toContain('access_token')
    expect(gatewayLedger.map((r) => [r.operation, r.endpoint, r.success])).toEqual([
      ['page.token', `graph.facebook.com/v26.0/${PAGE}`, true],
      ['leadform.create', `graph.facebook.com/v26.0/${PAGE}/leadgen_forms`, true],
    ])
    expect(everythingKept()).not.toContain(PAGE_TOKEN)
    expect(everythingKept()).not.toContain(SYSTEM_TOKEN)
  })
  it('is never cached: each change reads the token again; a second business\'s connection reads its own chosen Page', async () => {
    h.answers.push(tokenAnswer(), json({ id: FORM }), tokenAnswer(), json({ id: OTHER_FORM }))
    await metaWriteCall({ connectionId: 'm-1', operation: 'leadform.create', objectId: PAGE, objectKind: 'page', edge: 'leadgen_forms', params: formParams(), check: false })
    __metaObjectLimitsTest.useMemory()
    await metaWriteCall({ connectionId: 'm-1', operation: 'leadform.create', objectId: PAGE, objectKind: 'page', edge: 'leadgen_forms', params: formParams(), check: false })
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'POST', 'GET', 'POST'])
    gatewayMetaPage['m-2'] = OTHER_PAGE
    h.calls = []
    h.answers.push(tokenAnswer('pagetokenOTHER0123456789abcdefgh', OTHER_PAGE), json({ id: OTHER_FORM }))
    await metaWriteCall({ connectionId: 'm-2', operation: 'leadform.create', objectId: OTHER_PAGE, objectKind: 'page', edge: 'leadgen_forms', params: formParams(), check: false })
    expect(sent(0).url.pathname).toBe(`/v26.0/${OTHER_PAGE}`)
  })
  it('a Page token Meta echoes in an answer or an error is scrubbed: the caller, the ledger and the error text never see it', async () => {
    h.answers.push(tokenAnswer(), json({ id: FORM, debug: `token ${PAGE_TOKEN} used`, access_token: PAGE_TOKEN }))
    const ok = await metaWriteCall({ connectionId: 'm-1', operation: 'leadform.create', objectId: PAGE, objectKind: 'page', edge: 'leadgen_forms', params: formParams(), check: false })
    expect(ok.text).not.toContain(PAGE_TOKEN)
    expect(ok.text).toContain('[removed]')
    __metaObjectLimitsTest.useMemory()
    h.answers.push(tokenAnswer(), json({ error: { code: 100, message: `Invalid parameter for ${PAGE_TOKEN}` } }, 400))
    const failed = await metaWriteCall({ connectionId: 'm-1', operation: 'leadform.create', objectId: PAGE, objectKind: 'page', edge: 'leadgen_forms', params: formParams(), check: false })
    expect(failed.ok).toBe(false)
    expect(JSON.stringify(failed)).not.toContain(PAGE_TOKEN)
    expect(failed.verdict?.channelMessage).not.toContain(PAGE_TOKEN)
    expect(everythingKept()).not.toContain(PAGE_TOKEN)
  })
  it('no Page token from Meta (refused, none for the system user, another object, no answer): held in words, nothing sent', async () => {
    const tryIt = async () => {
      __metaObjectLimitsTest.useMemory()
      return metaWriteCall({ connectionId: 'm-1', operation: 'leadform.create', objectId: PAGE, objectKind: 'page', edge: 'leadgen_forms', params: formParams(), check: false }).catch((e) => e)
    }
    h.answers.push(json({ error: { code: 200, message: '(#200) The user must be an admin, editor, or moderator of the page' } }, 403))
    expect(await tryIt()).toMatchObject({ outcome: 'held', code: 'META_PAGE_TOKEN_UNAVAILABLE', message: expect.stringMatching(/no token for the business's chosen Facebook Page \(Meta's words: \(#200\) The user must be.*Advertise/) })
    h.answers.push(json({ id: PAGE }))
    expect(await tryIt()).toMatchObject({ code: 'META_PAGE_TOKEN_UNAVAILABLE', message: expect.stringMatching(/without a token for the system user.*Assign assets/) })
    h.answers.push(json({ id: OTHER_PAGE, access_token: PAGE_TOKEN }))
    const other = await tryIt()
    expect(other).toMatchObject({ code: 'META_PAGE_TOKEN_UNAVAILABLE', message: expect.stringMatching(/another object than the chosen Page/) })
    expect(other.message).not.toContain(PAGE_TOKEN)
    h.answers.push(() => { throw new TypeError('fetch failed') })
    expect(await tryIt()).toMatchObject({ code: 'META_PAGE_TOKEN_UNAVAILABLE', message: expect.stringMatching(/did not answer/) })
    // Only the four token reads went out; no change was sent.
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'GET', 'GET', 'GET'])
    expect(gatewayLedger.filter((r) => r.operation === 'page.token').map((r) => r.success)).toEqual([false, false, false, false])
    expect(everythingKept()).not.toContain(PAGE_TOKEN)
  })
  it('only for a rule marked page: a campaign\'s status change goes with the system-user token and reads no Page token', async () => {
    gatewayMetaStored['120000000000001'] = { adAccountId: '1234567890', kind: 'campaign' }
    await metaWriteCall({ connectionId: 'm-1', operation: 'campaign.status', objectId: '120000000000001', objectKind: 'campaign', params: { status: 'PAUSED' }, check: false })
    expect(h.calls).toHaveLength(1)
    expect(sent(0).url.searchParams.get('access_token')).toBe(SYSTEM_TOKEN)
    expect(gatewayLedger.some((r) => r.operation === 'page.token')).toBe(false)
  })
  it('writes switched off: nothing is sent, and no Page token is read either', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'leadform.create', objectId: PAGE, objectKind: 'page', edge: 'leadgen_forms', params: formParams(), check: false }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'gated', code: 'PUBLISH_GATED' })
    expect(h.calls).toHaveLength(0)
  })
  it('a caller still cannot READ a Page token by any path, and every answer it gets is scrubbed (step 1, unchanged)', async () => {
    const refusedRead = (path: string, query: Record<string, string> = {}) => metaCall({ connectionId: 'm-1', operation: 'probe', path, query }).catch((e) => e)
    for (const [path, query] of [
      [PAGE, { fields: 'access_token' }], [PAGE, { fields: 'id,name,access_token' }], [PAGE, { fields: 'id,page_access_token' }], [PAGE, {}],
      ['me/accounts', {}], ['me/accounts', { fields: 'id,access_token' }], ['me', { fields: 'accounts' }], ['me', { fields: 'accounts.fields(access_token)' }],
      [PAGE, { fields: 'id', access_token: PAGE_TOKEN }],
    ] as Array<[string, Record<string, string>]>) {
      const err = await refusedRead(path, query)
      expect(err, `${path} ${JSON.stringify(query)}`).toBeInstanceOf(GatewayRefusal)
      expect(err.code).toBe('META_READ_ONLY')
    }
    // The gateway's own token read is not a caller's call: the same URL through the caller path is refused.
    const direct = await gatewayCall({ channel: 'META', operation: 'probe', kind: 'read', connectionId: 'm-1', url: `${BASE}/${PAGE}?fields=access_token`, method: 'GET' }).catch((e) => e)
    expect(direct).toMatchObject({ code: 'META_READ_ONLY' })
    expect(h.calls).toHaveLength(0)
    // An answer that carries a token anyway is scrubbed before the caller sees it.
    h.answers.push(json({ id: PAGE, name: 'Page A', access_token: PAGE_TOKEN }))
    const read = await metaCall({ connectionId: 'm-1', operation: 'probe', path: PAGE, query: { fields: 'id,name' } })
    expect(read.text).not.toContain(PAGE_TOKEN)
    expect(scrubMetaAnswer(JSON.stringify({ access_token: PAGE_TOKEN })).text).not.toContain(PAGE_TOKEN)
  })
  it('only gateway.ts imports the token read (the caller path can never reach it)', () => {
    const src = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
    // git grep: every file under apps/api/src that names the module in an import string (tests apart).
    const listed = execFileSync('git', ['grep', '--untracked', '-l', '-E', "meta-page-token(\\.js)?['\"]", '--', '.'], { cwd: src, encoding: 'utf8' })
    const importers = listed.split('\n').filter(Boolean).filter((file) => !/\.test\.ts$/.test(file))
    expect(importers.sort()).toEqual(['services/gateway/gateway.ts'])
    expect(readFileSync(join(src, 'services/gateway/gateway.ts'), 'utf8')).toMatch(/import \{ MetaPageTokenUnavailable, metaPageTokenFor, scrubExactToken \} from '\.\/meta-page-token\.js'/)
  })
})

describe('the owner check of a change made as the Page', () => {
  it('the Page itself: only the chosen one; none chosen, or another Page (another business\'s too): refused, nothing sent at all', async () => {
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'leadform.create', objectId: OTHER_PAGE, objectKind: 'page', edge: 'leadgen_forms', params: formParams(), check: false }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN', message: expect.stringMatching(/not the Facebook Page this business chose/) })
    delete gatewayMetaPage['m-3']
    expect(await metaWriteCall({ connectionId: 'm-3', operation: 'leadform.create', objectId: PAGE, objectKind: 'page', edge: 'leadgen_forms', params: formParams(), check: false }).catch((e) => e)).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    // No token read, no change.
    expect(h.calls).toHaveLength(0)
  })
  it('a Page kind named for a campaign rule, or a page rule with no kind: refused before anything', async () => {
    const none = await gatewayCall({ channel: 'META', operation: 'x', kind: 'write', connectionId: 'm-1', url: `${BASE}/${PAGE}/leadgen_forms`, method: 'POST', body: formBody() }).catch((e) => e)
    expect(none).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    const wrong = await gatewayCall({ channel: 'META', operation: 'x', kind: 'write', connectionId: 'm-1', url: `${BASE}/${FORM}`, method: 'POST', body: 'status=PAUSED', metaObjectKind: 'leadform' }).catch((e) => e)
    expect(wrong).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(h.calls).toHaveLength(0)
  })
  it('a form Nexus made on the chosen Page: no live read; archived with the Page token', async () => {
    gatewayMetaNexusMade.add(`leadform:${FORM}:${PAGE}`)
    h.answers.push(tokenAnswer(), json({ success: true }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'leadform.status', objectId: FORM, objectKind: 'leadform', params: { status: 'ARCHIVED' }, check: false })
    expect(res.ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['GET', `/v26.0/${PAGE}`], ['POST', `/v26.0/${FORM}`]])
    expect(sent(1).body).toBe('status=ARCHIVED')
  })
  it('any other form: ONE live read (system-user token) — its page_id must be the chosen Page; a neighbour\'s form or another kind of node: refused', async () => {
    h.answers.push(json({ id: FORM, page_id: PAGE, questions: [{ type: 'EMAIL' }] }), tokenAnswer(), json({ success: true }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'leadform.status', objectId: FORM, objectKind: 'leadform', params: { status: 'ACTIVE' }, check: false })).ok).toBe(true)
    expect(sent(0).url.searchParams.get('fields')).toBe('id,page_id,questions{type}')
    expect(sent(0).url.searchParams.get('access_token')).toBe(SYSTEM_TOKEN)
    h.calls = []
    // Another business's form (its Page is not this business's chosen one): one read, then nothing — not even the token read.
    h.answers.push(json({ id: OTHER_FORM, page_id: OTHER_PAGE, questions: { data: [{ type: 'EMAIL' }] } }))
    const neighbour = await metaWriteCall({ connectionId: 'm-1', operation: 'leadform.status', objectId: OTHER_FORM, objectKind: 'leadform', params: { status: 'ARCHIVED' }, check: false }).catch((e) => e)
    expect(neighbour).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    expect(neighbour.message).not.toContain(OTHER_PAGE)
    // A node of another kind: a post of the chosen Page has no page_id / questions (Meta: nonexisting field).
    h.answers.push(json({ error: { code: 100, message: 'Tried accessing nonexisting field (page_id) on node type (Post)' } }, 400))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'leadform.status', objectId: '500000000000001', objectKind: 'leadform', params: { status: 'ARCHIVED' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not a lead form/) })
    // Answers with the chosen page_id but no questions: not a lead form.
    h.answers.push(json({ id: '500000000000002', page_id: PAGE }))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'leadform.status', objectId: '500000000000002', objectKind: 'leadform', params: { status: 'ARCHIVED' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    // Meta answers another id, or cannot be asked: unconfirmed.
    h.answers.push(json({ id: '500000000000009', page_id: PAGE, questions: [{}] }))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'leadform.status', objectId: '500000000000003', objectKind: 'leadform', params: { status: 'ARCHIVED' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_PAGE_UNCONFIRMED' })
    h.answers.push(json({ error: { code: 1, message: 'An unknown error occurred' } }, 500))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'leadform.status', objectId: '500000000000004', objectKind: 'leadform', params: { status: 'ARCHIVED' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_PAGE_UNCONFIRMED' })
    expect(h.calls.every((c) => c.init.method === 'GET' && new URL(c.url).searchParams.get('fields') === 'id,page_id,questions{type}')).toBe(true)
  })
  it('a test lead: made on a form of that form\'s Page via its own edge; deleted only when Nexus made it — a real lead never', async () => {
    gatewayMetaNexusMade.add(`leadform:${FORM}:${PAGE}`)
    h.answers.push(tokenAnswer(), json({ id: LEAD }))
    const made = await metaWriteCall({ connectionId: 'm-1', operation: 'testlead.create', objectId: FORM, objectKind: 'leadform', edge: 'test_leads', params: { field_data: JSON.stringify([{ name: 'email', values: ['test@example.com'] }]) }, check: false })
    expect(made.ok).toBe(true)
    expect(sent(1).url.pathname).toBe(`/v26.0/${FORM}/test_leads`)
    h.calls = []
    const real = await metaWriteCall({ connectionId: 'm-1', operation: 'testlead.delete', objectId: '700000000000099', objectKind: 'testlead', method: 'DELETE', params: {}, check: false }).catch((e) => e)
    expect(real).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/never a real lead/) })
    expect(h.calls).toHaveLength(0)
    // Nexus's own record on ANOTHER Page does not count either.
    gatewayMetaNexusMade.add(`testlead:${LEAD}:${OTHER_PAGE}`)
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'testlead.delete', objectId: LEAD, objectKind: 'testlead', method: 'DELETE', params: {}, check: false }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    gatewayMetaNexusMade.add(`testlead:${LEAD}:${PAGE}`)
    h.answers.push(tokenAnswer(), json({ success: true }))
    const gone = await metaWriteCall({ connectionId: 'm-1', operation: 'testlead.delete', objectId: LEAD, objectKind: 'testlead', method: 'DELETE', params: {}, check: false })
    expect(gone.ok).toBe(true)
    // The merge with main: a DELETE without keys sends no form field (main's gateway passes its empty body on).
    expect(sent(1).method).toBe('DELETE')
    expect(sent(1).body ?? '').toBe('')
    expect(sent(1).url.searchParams.get('access_token')).toBe(PAGE_TOKEN)
  })
  it('an id inside the body: the intro\'s cover photo must be a photo OF the chosen Page', async () => {
    const card = (id: string) => formParams({ context_card: JSON.stringify({ title: 'Hi', cover_photo_id: id }) })
    const go = (id: string) => { __metaObjectLimitsTest.useMemory(); return metaWriteCall({ connectionId: 'm-1', operation: 'leadform.create', objectId: PAGE, objectKind: 'page', edge: 'leadgen_forms', params: card(id), check: false }).catch((e) => e) }
    h.answers.push(json({ id: PHOTO, from: { id: PAGE }, width: 1200, height: 628 }), tokenAnswer(), json({ id: FORM }))
    expect((await go(PHOTO)).ok).toBe(true)
    expect(sent(0).url.searchParams.get('fields')).toBe('id,from{id},width,height')
    h.calls = []
    h.answers.push(json({ id: '800000000000099', from: { id: OTHER_PAGE }, width: 1200, height: 628 }))
    expect(await go('800000000000099')).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN', message: expect.stringMatching(/not a photo of the Facebook Page this business chose/) })
    h.answers.push(json({ id: '800000000000098', from: { id: PAGE } }))
    expect(await go('800000000000098')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    h.answers.push(json({ error: { code: 100, message: 'Tried accessing nonexisting field (width) on node type (Video)' } }, 400))
    expect(await go('800000000000097')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not a photo/) })
    expect(h.calls.every((c) => c.init.method === 'GET' && new URL(c.url).searchParams.get('fields') === 'id,from{id},width,height')).toBe(true)
  })
})

describe('the write client on the Page rules (step 18\'s edge create and DELETE)', () => {
  const target = { connectionId: 'm-1', adAccountId: '1234567890' }
  it('a form create reads the NEW form back (system-user token), never the Page', async () => {
    h.answers.push(tokenAnswer(), json({ id: FORM }), json({ id: FORM, name: 'Form A', status: 'ACTIVE' }))
    const result = await metaSendChange(target, { objectId: PAGE, kind: 'page', edge: 'leadgen_forms', params: formParams(), operation: 'leadform.create', readBackFields: 'id,name,status' })
    expect(result).toMatchObject({ node: { id: FORM, status: 'ACTIVE' }, readBack: 'second-read' })
    expect(sent(2).url.pathname).toBe(`/v26.0/${FORM}`)
    expect(sent(2).url.searchParams.get('access_token')).toBe(SYSTEM_TOKEN)
  })
  it('a test lead is never read back (its id is all Nexus keeps); a DELETE reads nothing back; a refused one is refused', async () => {
    gatewayMetaNexusMade.add(`leadform:${FORM}:${PAGE}`).add(`testlead:${LEAD}:${PAGE}`)
    h.answers.push(tokenAnswer(), json({ id: LEAD }))
    expect(await metaSendChange(target, { objectId: FORM, kind: 'leadform', edge: 'test_leads', params: { field_data: JSON.stringify([{ name: 'email', values: ['x'] }]) }, operation: 'testlead.create', skipReadBack: true }))
      .toMatchObject({ node: { id: LEAD }, readBack: 'none' })
    expect(h.calls).toHaveLength(2)
    h.answers.push(tokenAnswer(), json({ success: true }))
    expect(await metaSendChange(target, { objectId: LEAD, kind: 'testlead', method: 'DELETE', params: {}, operation: 'testlead.delete' })).toMatchObject({ readBack: 'none' })
    expect(h.calls).toHaveLength(4)
    __metaObjectLimitsTest.useMemory()
    h.answers.push(tokenAnswer(), json({ error: { code: 100, message: 'You should not have existing test leads' } }, 400))
    const err = await metaSendChange(target, { objectId: FORM, kind: 'leadform', edge: 'test_leads', params: { field_data: JSON.stringify([{ name: 'email', values: ['x'] }]) }, operation: 'testlead.create', skipReadBack: true }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'refused', message: expect.stringMatching(/existing test leads/) })
    expect(JSON.stringify(err)).not.toContain(PAGE_TOKEN)
    expect(everythingKept()).not.toContain(PAGE_TOKEN)
  })
})

describe('review round 1', () => {
  const create = () => metaWriteCall({ connectionId: 'm-1', operation: 'leadform.create', objectId: PAGE, objectKind: 'page', edge: 'leadgen_forms', params: formParams(), check: false })
  it('A1 — a Page token Meta echoes with JSON \\u escapes is removed once decoded; so is one in a thrown error\'s message', async () => {
    const escaped = `{"id":"${FORM}","debug":"BSLASHu0070${PAGE_TOKEN.slice(1)}","BSLASHu0070${PAGE_TOKEN.slice(1)}":1}`.split('BSLASH').join(String.fromCharCode(92))
    expect(escaped).not.toContain(PAGE_TOKEN)
    expect(JSON.stringify(JSON.parse(escaped))).toContain(PAGE_TOKEN)
    h.answers.push(tokenAnswer(), () => new Response(escaped, { status: 200 }))
    const ok = await create()
    expect(JSON.stringify(ok.json())).not.toContain(PAGE_TOKEN)
    expect(ok.json()).toMatchObject({ id: FORM, debug: '[removed]', '[removed]': 1 })
    __metaObjectLimitsTest.useMemory()
    h.answers.push(tokenAnswer(), () => new Response(`{"error":{"code":100,"message":"bad BSLASHu0070${PAGE_TOKEN.slice(1)}"}}`.split('BSLASH').join(String.fromCharCode(92)), { status: 400 }))
    const failed = await create()
    expect(JSON.stringify(failed)).not.toContain(PAGE_TOKEN)
    expect(failed.verdict?.channelMessage).toContain('[removed]')
    __metaObjectLimitsTest.useMemory()
    h.answers.push(tokenAnswer(), () => { throw new Error(`socket closed after ${PAGE_TOKEN}`) })
    const thrown = await create()
    expect(thrown.ok).toBe(false)
    expect(JSON.stringify(thrown)).not.toContain(PAGE_TOKEN)
    expect(everythingKept()).not.toContain(PAGE_TOKEN)
    expect(scrubExactToken('{"a":"x"}', PAGE_TOKEN)).toEqual({ text: '{"a":"x"}', removed: 0 })
  })
  it('the scrub also removes the token as a URL writes it (a `|` as %7C or %7c), in plain text and inside JSON strings', () => {
    const app = '1234567|appsecretvalue0123456789'
    expect(scrubExactToken(`see https://example.com/?t=${encodeURIComponent(app)}&x=1`, app)).toEqual({ text: 'see https://example.com/?t=[removed]&x=1', removed: 1 })
    expect(scrubExactToken(`raw ${app} and ${encodeURIComponent(app).replace('%7C', '%7c')}`, app)).toEqual({ text: 'raw [removed] and [removed]', removed: 2 })
    const inJson = scrubExactToken(JSON.stringify({ link: `https://example.com/?t=${encodeURIComponent(app)}` }), app)
    expect(inJson.text).not.toContain(encodeURIComponent(app))
    expect(inJson.removed).toBe(1)
  })
  it('A2 — no Unicode format character in text a person reads (bidi overrides, zero-width, tags): step 18\'s shared pattern, ZWJ only between emoji', () => {
    const cp = (...codes: number[]) => String.fromCodePoint(...codes)
    for (const name of [`Form ${cp(0x202e)} A`, `Form ${cp(0x2066)}A`, `Form${cp(0x200b)}A`, `Form${cp(0xfeff)}`, `Form ${cp(0xe0041)}`]) {
      expect(problem({ body: formBody({ name }) }), JSON.stringify(name)).toMatch(/printable text \(no control or format characters\)/)
      expect(createProblem({ questions: JSON.stringify([{ type: 'CUSTOM', key: 'a', label: name }]) }), JSON.stringify(name)).toMatch(/printable text/)
    }
    expect(problem({ body: formBody({ name: `Form ${cp(0x1f469, 0x200d, 0x1f4bb)}` }) })).toBeNull()
    expect(problem({ body: formBody({ name: `Form ${cp(0x200d)} A` }) })).toMatch(/printable text/)
    expect(problem({ body: formBody({ name: `Form ${cp(0x200c)} A` }) })).toMatch(/printable text/)
    expect(problem({ body: formBody({ name: 'Città — Straße ñ' }) })).toBeNull()
  })
  it('A5 — a test answer names the form\'s own question key, whatever the form made in Meta\'s screens uses', () => {
    const tl = (rows: unknown) => metaTestLeadProblem(new Map([['field_data', JSON.stringify(rows)]]))
    expect(tl([{ name: 'favorite_color?', values: ['yellow'] }, { name: 'e-mail', values: ['test@example.com'] }])).toBeNull()
    expect(tl([{ name: 'x'.repeat(201), values: ['y'] }])).toMatch(/at most 200/)
    expect(tl([{ name: `a${String.fromCodePoint(0x202e)}b`, values: ['y'] }])).toMatch(/printable text/)
  })
  it('A6 — a failed test lead keeps the questions\' and boxes\' names in the ledger, never an answer', async () => {
    gatewayMetaNexusMade.add(`leadform:${FORM}:${PAGE}`)
    h.answers.push(tokenAnswer(), json({ error: { code: 100, message: 'You should not have existing test leads' } }, 400))
    const res = await metaWriteCall({
      connectionId: 'm-1', operation: 'testlead.create', objectId: FORM, objectKind: 'leadform', edge: 'test_leads', check: false,
      params: { field_data: JSON.stringify([{ name: 'email', values: ['answer-one@example.com'] }, { name: 'city', values: ['Answer Town'] }]), custom_disclaimer_responses: JSON.stringify([{ checkbox_key: 'consent_marketing', is_checked: true }]) },
    })
    expect(res.ok).toBe(false)
    const row = gatewayLedger.find((r) => r.operation === 'testlead.create')!
    expect(JSON.stringify(row.requestPayload)).toContain('email')
    expect(JSON.stringify(row.requestPayload)).toContain('consent_marketing')
    expect(JSON.stringify(gatewayLedger)).not.toMatch(/answer-one|Answer Town/)
  })
  it('A7 — the token read itself refuses with Meta changes switched off (not only the gateway\'s step 3)', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    const err = await metaPageTokenFor('m-1').catch((e) => e)
    expect(err).toBeInstanceOf(MetaPageTokenUnavailable)
    expect(err).toMatchObject({ code: 'PUBLISH_GATED' })
    expect(h.calls).toHaveLength(0)
  })
  it('B3 — a refused Page token or permission on a Page change says the Page\'s condition, never "make a new system-user token"', async () => {
    const target = { connectionId: 'm-1', adAccountId: '1234567890' }
    h.answers.push(tokenAnswer(), json({ error: { code: 190, message: 'Error validating access token' } }, 400))
    const lost = await metaSendChange(target, { objectId: PAGE, kind: 'page', edge: 'leadgen_forms', params: formParams(), operation: 'leadform.create' }).catch((e) => e)
    expect(lost.message).toMatch(/made as the chosen Facebook Page.*lost its role or its Advertise task on the Page/)
    expect(lost.message).not.toMatch(/Make a new token/)
    __metaObjectLimitsTest.useMemory()
    h.answers.push(tokenAnswer(), json({ error: { code: 200, message: '(#200) Permissions error' } }, 403))
    const denied = await metaSendChange(target, { objectId: PAGE, kind: 'page', edge: 'leadgen_forms', params: formParams(), operation: 'leadform.create' }).catch((e) => e)
    expect(denied.message).toMatch(/made as the chosen Facebook Page/)
    expect(denied.message).not.toMatch(/ad account|ads_management/)
  })
})
