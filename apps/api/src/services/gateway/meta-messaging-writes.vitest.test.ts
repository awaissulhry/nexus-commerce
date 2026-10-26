/**
 * Meta step 38 on the gateway — messages, inbox labels, templates and the messaging setup:
 *   - the rules are an exact ALLOW-list: keys per kind of object, every value judged, JSON in ONE spelling with every key at
 *     every depth on a list, text only where a person types it (no control or format character, even escaped inside JSON),
 *     the dead message tags refused in words, Meta's own limits (Instagram's 1,000 bytes, 13 quick replies, …);
 *   - the Page rules go AS the chosen Page (its own token read for that one call); the WhatsApp rules with the system-user token;
 *   - the owner check per kind and of every id inside the body — the person (a conversation of the chosen Page or Instagram
 *     account), a comment, a persona, a message of the same conversation, an app on the Page, a creator, a label, a template,
 *     a flow, the WhatsApp account and its templates — with a neighbour of another business and a node of another kind, each
 *     refused before anything is sent;
 *   - nothing of a person (their id, the words) or a verification code reaches the call log.
 * Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PAGE_TOKEN = 'pagetoken0123456789abcdefghijKLMN'
const SYSTEM_TOKEN = 'meta-system-user-token'
const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init: RequestInit }>,
  answers: [] as Array<() => Response>,
}))
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
vi.mock('../../utils/otel-setup.js', () => ({ withSpan: vi.fn(async (_n: string, _a: Record<string, unknown>, fn: (span: null) => Promise<unknown>) => fn(null)) }))

import { gatewayLedger, gatewayMetaInstagram, gatewayMetaPage, gatewayMetaPortfolio, gatewayMetaSharedPortfolios, gatewayMetaStored, gatewayMetaTakenLinks } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaWriteCall } from './meta.js'
import { metaWriteVerdict } from './meta-calls.js'
import { META_INSTAGRAM_INBOX_APP, META_MESSAGE_LIMITS, META_PAGE_INBOX_APP, META_WHATSAPP_KINDS, templateComponentsProblem } from './meta-messaging-rules.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const PAGE = '120000000000010'
const OTHER_PAGE = '120000000000099'
const IG = '170000000000010'
const PERSON = '300000000000001'
const CONV = 't_400000000000001'
const MID = 'm_AbCdEfGhIjKlMnOp0123456789'
const LABEL = '120000000000801'
const WABA = '120000000000900'
const PORTFOLIO = '9876543210'

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const tokenAnswer = () => json({ id: PAGE, access_token: PAGE_TOKEN })
const sent = (i: number) => ({ method: h.calls[i].init.method, url: new URL(h.calls[i].url), body: h.calls[i].init.body })
const paths = () => h.calls.map((c) => `${c.init.method} ${new URL(c.url).pathname.replace(`/${META_DEFAULT_GRAPH_API_VERSION}`, '')}`)
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const j = (v: unknown) => JSON.stringify(v)
const verdict = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => metaWriteVerdict({ method: 'POST', url: `${BASE}/${PAGE}/messages`, kind: 'write', objectKind: 'messengerpage', body: '', ...input })
const problem = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const msg = (o: Record<string, unknown>, objectKind = 'messengerpage') => problem({ objectKind, body: form(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : j(v)]))) })
const text = (t: string, extra: Record<string, unknown> = {}) => ({ recipient: { id: PERSON }, messaging_type: 'RESPONSE', message: { text: t }, ...extra })
const conversation = (people = [PERSON, PAGE]) => json({ data: [{ id: CONV, participants: { data: people.map((id) => ({ id })) } }] })

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const store of [gatewayMetaPage, gatewayMetaInstagram, gatewayMetaPortfolio]) for (const key of Object.keys(store)) delete store[key]
  gatewayMetaTakenLinks.clear(); gatewayMetaSharedPortfolios.clear()
  gatewayMetaPage['m-1'] = PAGE
  gatewayMetaInstagram['m-1'] = IG
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('the message rules are an exact allow-list', () => {
  it('a RESPONSE, an UPDATE, a HUMAN_AGENT reply: as the Page, a person by id, the words in one spelling; the call log keeps neither', () => {
    const v = verdict({ body: form({ recipient: j({ id: PERSON }), messaging_type: 'RESPONSE', message: j({ text: 'Ciao 😊\nGrazie' }) }) })
    expect(v).toMatchObject({ write: { rule: 'messenger.message', objectId: PAGE, auth: 'page', edgeCall: true, ids: [{ id: PERSON, kind: 'messageperson' }] } })
    const ledger = 'write' in v ? v.write.ledgerBody ?? '' : ''
    expect(ledger).not.toContain(PERSON)
    expect(ledger).not.toContain('Ciao')
    expect(msg(text('x', { messaging_type: 'UPDATE' }))).toBeNull()
    expect(msg(text('x', { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' }))).toBeNull()
    expect(msg(text('x', { message: { text: 'x', quick_replies: [{ content_type: 'text', title: 'Sì', payload: 'YES' }] } }))).toBeNull()
  })
  it('the dead tags in words; a tag only with MESSAGE_TAG and MESSAGE_TAG only with HUMAN_AGENT; a type always named', () => {
    for (const tag of ['ACCOUNT_UPDATE', 'POST_PURCHASE_UPDATE', 'CONFIRMED_EVENT_UPDATE']) expect(msg(text('x', { messaging_type: 'MESSAGE_TAG', tag }))).toMatch(/error 100 since 2026-04-27/)
    expect(msg(text('x', { messaging_type: 'MESSAGE_TAG', tag: 'CUSTOMER_FEEDBACK' }))).toMatch(/only message tag Nexus sends is HUMAN_AGENT/)
    expect(msg(text('x', { messaging_type: 'MESSAGE_TAG' }))).toMatch(/tag goes with/)
    expect(msg(text('x', { tag: 'HUMAN_AGENT' }))).toMatch(/tag goes with/)
    expect(msg({ recipient: { id: PERSON }, message: { text: 'x' } })).toMatch(/messaging_type is one of/)
    expect(msg(text('x', { messaging_type: 'NON_PROMOTIONAL_SUBSCRIPTION' }))).toMatch(/messaging_type is one of/)
  })
  it('every key at every depth: no other key, no JSON with spaces or escapes, no control or format character even escaped, one recipient', () => {
    expect(msg(text('x', { thread_control: { control_type: 'pass' } }))).toMatch(/only Meta change/)
    expect(msg({ ...text('x'), message: { text: 'x', metadata: 'y' } })).toMatch(/no key "metadata"/)
    expect(problem({ body: form({ recipient: '{ "id": "300000000000001" }', messaging_type: 'RESPONSE', message: j({ text: 'x' }) }) })).toMatch(/one spelling/)
    expect(problem({ body: form({ recipient: j({ id: PERSON }), messaging_type: 'RESPONSE', message: '{"text":"Ciao\\u202ex"}' }) })).toMatch(/one spelling/)
    expect(msg(text('Ciao‮x'))).toMatch(/printable text/)
    expect(msg(text('Ciao​x'))).toMatch(/printable text/)
    expect(msg({ ...text('x'), recipient: { id: PERSON, comment_id: '1' } })).toMatch(/exactly one of id/)
    expect(msg({ ...text('x'), recipient: { id: 'abc' } })).toMatch(/digits/)
    expect(msg({ ...text('x'), recipient: { user_ref: 'abc' } })).toMatch(/exactly one of id/)
    expect(msg(text('x'.repeat(META_MESSAGE_LIMITS.messengerText + 1)))).toMatch(/at most 2000/)
    expect(msg({ ...text('x'), message: { text: 'x', quick_replies: Array.from({ length: 14 }, (_, i) => ({ content_type: 'text', title: `R${i}`, payload: 'P' })) } })).toMatch(/list of 1 to 13/)
    expect(msg({ ...text('x'), message: { text: 'x', quick_replies: [{ content_type: 'user_email', title: 'E', payload: 'P' }] } })).toMatch(/content_type is one of text/)
    expect(msg({ ...text('x'), message: { attachment: { type: 'image', payload: { url: 'http://example.com/a.jpg' } } } })).toMatch(/https link/)
    expect(msg({ ...text('x'), message: { attachment: { type: 'image', payload: { url: 'https://example.com/a.jpg', is_reusable: true } } } })).toMatch(/no key "is_reusable"/)
    expect(msg({ ...text('x'), message: { attachment: { type: 'image', payload: { url: 'https://example.com/a.jpg' } } } })).toBeNull()
  })
  it('Instagram: 1,000 bytes, no persona or notification, no utility; the Partnership folder only there, with its own three keys', () => {
    expect(msg(text('é'.repeat(501)), 'instagrampage')).toMatch(/1000 bytes on Instagram/)
    expect(msg(text('x', { persona_id: '120000000000901' }), 'instagrampage')).toMatch(/only Meta change/)
    expect(msg(text('x', { notification_type: 'SILENT_PUSH' }), 'instagrampage')).toMatch(/only Meta change/)
    expect(msg({ recipient: { id: PERSON }, messaging_type: 'UTILITY', message: { template: { name: 'a', language: { code: 'it' } } } }, 'instagrampage')).toMatch(/messaging_type is one of RESPONSE, UPDATE, MESSAGE_TAG$/)
    expect(msg({ ...text('x'), message: { attachment: { type: 'file', payload: { url: 'https://example.com/a.pdf' } } } }, 'instagrampage')).toMatch(/type is one of image, video, audio/)
    expect(msg({ recipient: { id: '942900000000001' }, message: { text: 'Ciao' }, folder: 'partnership' }, 'instagrampage')).toBeNull()
    expect(verdict({ objectKind: 'instagrampage', body: form({ recipient: j({ id: '942900000000001' }), message: j({ text: 'Ciao' }), folder: 'partnership' }) })).toMatchObject({ write: { rule: 'instagram.message', ids: [{ id: '942900000000001', kind: 'creator' }] } })
    expect(msg({ recipient: { id: '942900000000001' }, message: { text: 'Ciao' }, folder: 'partnership', messaging_type: 'RESPONSE' }, 'instagrampage')).toMatch(/creator message takes recipient, message, folder only/)
    expect(msg({ recipient: { id: '942900000000001' }, message: { text: 'Ciao' }, folder: 'general' }, 'instagrampage')).toMatch(/folder is one of partnership/)
    expect(msg({ recipient: { id: PERSON }, message: { text: 'x' }, folder: 'partnership' })).toMatch(/only Meta change/)
  })
  it('a private reply: a comment or (Facebook) a visitor post, RESPONSE, one text, nothing more', () => {
    expect(verdict({ body: form({ recipient: j({ comment_id: '500000000000001_900000000000001' }), messaging_type: 'RESPONSE', message: j({ text: 'x' }) }) })).toMatchObject({ write: { ids: [{ id: '500000000000001_900000000000001', kind: 'messagecomment' }] } })
    expect(verdict({ body: form({ recipient: j({ post_id: `${PAGE}_500000000000001` }), messaging_type: 'RESPONSE', message: j({ text: 'x' }) }) })).toMatchObject({ write: { ids: [{ id: `${PAGE}_500000000000001`, kind: 'visitorpost' }] } })
    expect(msg({ recipient: { post_id: `${PAGE}_500000000000001` }, messaging_type: 'RESPONSE', message: { text: 'x' } }, 'instagrampage')).toMatch(/Messenger's/)
    expect(msg({ recipient: { comment_id: '1' }, messaging_type: 'UPDATE', message: { text: 'x' } })).toMatch(/RESPONSE/)
    expect(msg({ recipient: { comment_id: '1' }, messaging_type: 'RESPONSE', message: { text: 'x', quick_replies: [{ content_type: 'text', title: 'a', payload: 'b' }] } })).toMatch(/no key "quick_replies"/)
    expect(msg({ recipient: { comment_id: '1' }, messaging_type: 'RESPONSE', message: { text: 'x' }, persona_id: '1' })).toMatch(/private reply takes recipient, messaging_type, message only/)
  })
  it('a sender action: recipient and the action only; react names the message and one emoji (Instagram: love)', () => {
    expect(msg({ recipient: { id: PERSON }, sender_action: 'typing_on' })).toBeNull()
    expect(msg({ recipient: { id: PERSON }, sender_action: 'typing_on', message: { text: 'x' } })).toMatch(/sender action takes recipient, sender_action, payload only/)
    expect(msg({ recipient: { id: PERSON }, sender_action: 'TYPING_ON' })).toMatch(/sender_action is one of mark_seen/)
    expect(verdict({ body: form({ recipient: j({ id: PERSON }), sender_action: 'react', payload: j({ message_id: MID, reaction: '👍' }) }) })).toMatchObject({ write: { ids: [{ id: PERSON, kind: 'messageperson' }, { id: MID, kind: 'threadmessage' }] } })
    expect(msg({ recipient: { id: PERSON }, sender_action: 'react', payload: { message_id: MID, reaction: 'wow' } })).toMatch(/one emoji/)
    expect(msg({ recipient: { id: PERSON }, sender_action: 'react', payload: { message_id: MID, reaction: 'love' } }, 'instagrampage')).toBeNull()
    expect(msg({ recipient: { id: PERSON }, sender_action: 'react', payload: { message_id: MID, reaction: '👍' } }, 'instagrampage')).toMatch(/one of love/)
    expect(msg({ recipient: { id: PERSON }, sender_action: 'mark_seen', payload: { message_id: MID } })).toMatch(/takes no payload/)
    expect(msg({ recipient: { comment_id: '1' }, sender_action: 'mark_seen' })).toMatch(/goes to a person/)
  })
  it('a utility template: Messenger, UTILITY, the template\'s name, language and values as the utility guide sends them, nothing more', () => {
    const utility = (message: unknown, extra: Record<string, unknown> = {}) => msg({ recipient: { id: PERSON }, messaging_type: 'UTILITY', message, ...extra })
    expect(utility({ template: { name: 'order_update', language: { code: 'it_IT' }, components: [{ type: 'body', parameters: [{ type: 'text', text: '1001' }] }, { type: 'buttons', parameters: [{ type: 'URL', url: '1001' }] }] } })).toBeNull()
    expect(utility({ template: { name: 'order_update', language: { code: 'it_IT' } } }, { persona_id: '1' })).toMatch(/utility message takes recipient, messaging_type, message only/)
    expect(utility({ text: 'x' })).toMatch(/no key "text"/)
    expect(utility({ template: { name: 'Order Update', language: { code: 'it_IT' } } })).toMatch(/template name/)
    expect(utility({ template: { name: 'a', language: { code: 'it_IT' }, components: [{ type: 'body', parameters: [{ type: 'currency', text: 'x' }] }] } })).toMatch(/type is one of text/)
    expect(msg(text('x', { message: { template: { name: 'a', language: { code: 'it' } } } }))).toMatch(/no key "template"/)
  })
  it('an instant form: a Messenger lead form inside the window only', () => {
    const formMsg = { attachment: { type: 'template', payload: { template_type: 'instant_form', form_id: '120000000000601' } } }
    expect(verdict({ body: form({ recipient: j({ id: PERSON }), messaging_type: 'RESPONSE', message: j(formMsg) }) })).toMatchObject({ write: { ids: [{ id: PERSON, kind: 'messageperson' }, { id: '120000000000601', kind: 'messageleadform' }] } })
    expect(msg({ recipient: { id: PERSON }, messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT', message: formMsg })).toMatch(/never with a tag/)
    expect(msg({ recipient: { id: PERSON }, messaging_type: 'RESPONSE', message: { attachment: { type: 'template', payload: { template_type: 'button', form_id: '1' } } } })).toMatch(/template_type is one of instant_form/)
    expect(msg({ recipient: { id: PERSON }, messaging_type: 'RESPONSE', message: formMsg }, 'instagrampage')).toMatch(/type is one of image/)
  })
  it('thread control: pass (an app id inside), release and take; never another key; a message rule never on another kind', () => {
    const thread = (control: string, body: Record<string, string>) => metaWriteVerdict({ method: 'POST', url: `${BASE}/${PAGE}/${control}_thread_control`, kind: 'write', objectKind: 'messengerpage', body: form(body) })
    expect(thread('pass', { recipient: j({ id: PERSON }), target_app_id: META_PAGE_INBOX_APP, metadata: 'escalated' })).toMatchObject({ write: { rule: 'thread.pass', auth: 'page', ids: [{ id: PERSON, kind: 'messageperson' }, { id: META_PAGE_INBOX_APP, kind: 'pageapp' }], ledgerBody: expect.not.stringContaining(PERSON) } })
    expect(thread('release', { recipient: j({ id: PERSON }), target_app_id: META_PAGE_INBOX_APP })).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(thread('take', { recipient: j({ id: PERSON }) })).toMatchObject({ write: { rule: 'thread.take' } })
    expect(thread('request', { recipient: j({ id: PERSON }) })).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(thread('pass', { recipient: j({ comment_id: '1' }) })).toMatchObject({ problem: expect.stringMatching(/no key "comment_id"/) })
    for (const kind of ['page', 'messagingpage', 'pagelabel', 'waba']) expect(msg(text('x'), kind), kind).toMatch(/only Meta change/)
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${PAGE}/messages`, kind: 'write', body: form({ recipient: j({ id: PERSON }), messaging_type: 'RESPONSE', message: j({ text: 'x' }) }) })).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
  })
})

describe('the label, template and setup rules', () => {
  const at = (path: string, body: string, objectKind: string, method = 'POST') => metaWriteVerdict({ method, url: `${BASE}/${path}`, kind: 'write', objectKind, body })
  it('labels: a name; a person by id (never in the call log); a delete with no body', () => {
    expect(at(`${PAGE}/custom_labels`, form({ page_label_name: 'Reso chiesto' }), 'messagingpage')).toMatchObject({ write: { rule: 'pagelabel.create', auth: 'page' } })
    expect(at(`${LABEL}/label`, form({ user: PERSON }), 'pagelabel')).toMatchObject({ write: { rule: 'pagelabel.assign', ids: [{ id: PERSON, kind: 'messageperson' }], ledgerBody: 'user=%28a+person%29' } })
    expect(at(`${LABEL}/label`, form({ user: PERSON }), 'pagelabel', 'DELETE')).toMatchObject({ write: { rule: 'pagelabel.unassign', method: 'DELETE' } })
    expect(at(`${LABEL}/label`, form({ user: 'abc' }), 'pagelabel')).toMatchObject({ problem: expect.stringMatching(/digits/) })
    expect(at(LABEL, '', 'pagelabel', 'DELETE')).toMatchObject({ write: { rule: 'pagelabel.delete', method: 'DELETE', auth: 'page' } })
    expect(at(LABEL, '', 'persona', 'DELETE')).toMatchObject({ write: { rule: 'persona.delete' } })
    expect(at(LABEL, '', 'templategroup', 'DELETE')).toMatchObject({ write: { rule: 'templategroup.delete' } })
    expect('write' in at(LABEL, '', 'templategroup', 'DELETE') && (at(LABEL, '', 'templategroup', 'DELETE') as { write: { auth?: string } }).write.auth).toBeFalsy()
    expect(at(LABEL, form({ name: 'x' }), 'pagelabel', 'DELETE')).toMatchObject({ problem: expect.stringMatching(/deletes on Meta only .*set-meta-conversation-labels/) })
  })
  it('templates: the parts and their examples judged; a media header refused; one template deleted by name AND id', () => {
    const components = (c: unknown, format: 'NAMED' | 'POSITIONAL' = 'POSITIONAL', channel: 'messenger' | 'whatsapp' = 'messenger') => templateComponentsProblem(c, channel, format)
    expect(components([{ type: 'BODY', text: 'Order {{1}}', example: { body_text: [['1001']] } }])).toBeNull()
    expect(components([{ type: 'BODY', text: 'Order {{1}}' }])).toMatch(/example/)
    expect(components([{ type: 'BODY', text: 'Order {{2}}', example: { body_text: [['1001']] } }])).toMatch(/in order/)
    expect(components([{ type: 'BODY', text: 'Order {{order}}', example: { body_text_named_params: [{ param_name: 'order', example: '1001' }] } }], 'NAMED')).toBeNull()
    expect(components([{ type: 'BODY', text: 'Order {{order}}', example: { body_text: [['1001']] } }], 'NAMED')).toMatch(/no key "body_text"/)
    expect(components([{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4:abc'] } }, { type: 'BODY', text: 'x' }])).toMatch(/Resumable Upload/)
    expect(components([{ type: 'BODY', text: 'x' }, { type: 'HEADER', format: 'TEXT', text: 'y' }])).toMatch(/in that order/)
    expect(components([{ type: 'BODY', text: 'x' }, { type: 'FOOTER', text: 'y' }])).toMatch(/type is one of HEADER, BODY, BUTTONS/)
    expect(components([{ type: 'BODY', text: 'x' }, { type: 'FOOTER', text: 'y' }], 'POSITIONAL', 'whatsapp')).toBeNull()
    expect(components([{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Go', url: 'https://example.com/{{1}}' }] }])).toMatch(/fixed https link/)
    expect(components([{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'OTP', text: 'Code' }] }])).toMatch(/type is one of URL, PHONE_NUMBER, POSTBACK/)
    const create = (body: Record<string, string>, objectKind = 'messagingpage') => at(`${PAGE}/message_templates`, form(body), objectKind)
    expect(create({ name: 'order_update', language: 'it_IT', category: 'UTILITY', components: j([{ type: 'BODY', text: 'x' }]) })).toMatchObject({ write: { rule: 'pagetemplate.create', auth: 'page' } })
    expect(create({ name: 'order_update', language: 'it_IT', category: 'MARKETING', components: j([{ type: 'BODY', text: 'x' }]) })).toMatchObject({ problem: expect.stringMatching(/UTILITY/) })
    expect(create({ name: 'order_update', language: 'it_IT', category: 'UTILITY', components: j([{ type: 'BODY', text: 'x' }]), library_template_name: 'lib' })).toMatchObject({ problem: expect.stringMatching(/one of them/) })
    expect(at(`${PAGE}/message_templates`, form({ name: 'order_update', template_id: '120000000000811' }), 'messagingpage', 'DELETE')).toMatchObject({ write: { rule: 'pagetemplate.delete', ids: [{ id: '120000000000811', kind: 'pagetemplate' }] } })
    expect(at(`${PAGE}/message_templates`, form({ name: 'order_update' }), 'messagingpage', 'DELETE')).toMatchObject({ problem: expect.stringMatching(/only Meta change .* DELETE \/120000000000010\/message_templates with name$/) })
    // WhatsApp: the system-user token, never AUTHENTICATION, a delete by hsm_id AND name.
    const wa = create({ name: 'promo', language: 'it', category: 'MARKETING', components: j([{ type: 'BODY', text: 'x' }]) }, 'waba')
    expect(wa).toMatchObject({ write: { rule: 'wabatemplate.create' } })
    expect('write' in wa && wa.write.auth).toBeFalsy()
    expect(create({ name: 'code', language: 'it', category: 'AUTHENTICATION', components: j([{ type: 'BODY', text: 'x' }]) }, 'waba')).toMatchObject({ problem: expect.stringMatching(/one-time sign-in codes/) })
    expect(at(`${WABA}/message_templates`, form({ hsm_id: '120000000000901', name: 'promo' }), 'waba', 'DELETE')).toMatchObject({ write: { rule: 'wabatemplate.delete', ids: [{ id: '120000000000901', kind: 'wabatemplate' }] } })
    expect(at(`${WABA}/template_groups`, form({ name: 'Group A', whatsapp_business_templates: j(['120000000000901', '120000000000901']) }), 'waba')).toMatchObject({ problem: expect.stringMatching(/each template once/) })
    expect(at('120000000000950', form({ add_templates: j(['1']), remove_templates: j(['1']) }), 'templategroup')).toMatchObject({ problem: expect.stringMatching(/not both/) })
    expect([...META_WHATSAPP_KINDS].sort()).toEqual(['templategroup', 'waba'])
  })
  it('the setup: profile properties (default locale, Instagram\'s two), a person\'s menu, personas, NLP without a token, calling, flows, a number with its code kept out of the call log', () => {
    const profile = (body: Record<string, string>, method = 'POST') => at(`${PAGE}/messenger_profile`, form(body), 'messagingpage', method)
    expect(profile({ greeting: j([{ locale: 'default', text: 'Ciao {{user_first_name}}' }]) })).toMatchObject({ write: { rule: 'messengerprofile.set' } })
    expect(profile({ greeting: j([{ locale: 'it_IT', text: 'Ciao' }]) })).toMatchObject({ problem: expect.stringMatching(/"default" locale/) })
    expect(profile({ greeting: j([{ locale: 'default', text: 'x' }]), platform: 'instagram' })).toMatchObject({ problem: expect.stringMatching(/Instagram the profile takes ice_breakers, persistent_menu only/) })
    expect(profile({ ice_breakers: j([{ locale: 'default', call_to_actions: [{ question: 'Taglie?', payload: 'SIZES' }] }]), platform: 'instagram' })).toMatchObject({ write: { rule: 'messengerprofile.set' } })
    expect(profile({ persistent_menu: j([{ locale: 'default', composer_input_disabled: true, call_to_actions: [{ type: 'postback', title: 'Aiuto', payload: 'HELP' }] }]), platform: 'instagram' })).toMatchObject({ problem: expect.stringMatching(/no key "composer_input_disabled"/) })
    expect(profile({ account_linking_url: 'http://example.com' })).toMatchObject({ problem: expect.stringMatching(/https link/) })
    expect(profile({ platform: 'instagram' })).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(profile({ fields: j(['greeting', 'get_started']) }, 'DELETE')).toMatchObject({ write: { rule: 'messengerprofile.delete', method: 'DELETE' } })
    expect(profile({ fields: j(['subject_to_new_eu_privacy_rules']) }, 'DELETE')).toMatchObject({ problem: expect.stringMatching(/one of get_started/) })
    expect(at(`${PAGE}/custom_user_settings`, form({ psid: PERSON, params: '["persistent_menu"]' }), 'messagingpage', 'DELETE')).toMatchObject({ write: { rule: 'usermenu.delete', ledgerBody: expect.not.stringContaining(PERSON) } })
    expect(at(`${PAGE}/custom_user_settings`, form({ psid: PERSON, params: '["ice_breakers"]' }), 'messagingpage', 'DELETE')).toMatchObject({ problem: expect.stringMatching(/persistent_menu/) })
    expect(at(`${PAGE}/personas`, form({ name: 'Anna R.', profile_picture_url: 'https://example.com/a.jpg' }), 'messagingpage')).toMatchObject({ write: { rule: 'persona.create' } })
    expect(at(`${PAGE}/personas`, form({ name: 'A'.repeat(51), profile_picture_url: 'https://example.com/a.jpg' }), 'messagingpage')).toMatchObject({ problem: expect.stringMatching(/at most 50/) })
    expect(at(`${PAGE}/nlp_configs`, form({ nlp_enabled: 'true', model: 'ITALIAN_STANDARD' }), 'messagingpage')).toMatchObject({ write: { rule: 'nlp.set' } })
    expect(at(`${PAGE}/nlp_configs`, form({ nlp_enabled: 'true', custom_token: 'abcdef' }), 'messagingpage')).toMatchObject({ problem: expect.stringMatching(/which no Nexus change sends/) })
    expect(at(`${PAGE}/messenger_call_settings`, form({ call_hours: j({ timezone_id: 'Europe/Rome', weekly_operating_hours: [{ day_of_week: 'MONDAY', open_time: '0900', close_time: '1800' }, { day_of_week: 'MONDAY', open_time: '1900', close_time: '2000' }] }) }), 'messagingpage')).toMatchObject({ problem: expect.stringMatching(/each day once/) })
    expect(at(`${PAGE}/messenger_call_settings`, form({ call_routing: j({ ring_target: 'PARTNERS' }), icon_enabled: 'false' }), 'messagingpage')).toMatchObject({ write: { rule: 'calling.set' } })
    const flow = j([{ message: { text: 'Ciao!', quick_replies: [{ content_type: 'text', title: 'Taglie', payload: 'SIZES' }] } }])
    expect(at(`${PAGE}/welcome_message_flows`, form({ name: 'Flow A', welcome_message_flow: flow, eligible_platforms: j(['messenger']) }), 'messagingpage')).toMatchObject({ write: { rule: 'welcomeflow.create' } })
    expect(at(`${PAGE}/welcome_message_flows`, form({ flow_id: '120000000000701', name: 'Flow B' }), 'messagingpage')).toMatchObject({ write: { rule: 'welcomeflow.update', ids: [{ id: '120000000000701', kind: 'welcomeflow' }] } })
    expect(at(`${PAGE}/welcome_message_flows`, form({ name: 'Flow A', welcome_message_flow: flow, eligible_platforms: j(['whatsapp']) }), 'messagingpage')).toMatchObject({ problem: expect.stringMatching(/one of messenger, instagram/) })
    const verify = at(`${PAGE}/page_whatsapp_number_verification`, form({ whatsapp_number: '+390000000000', verification_code: '483920' }), 'messagingpage')
    expect(verify).toMatchObject({ write: { rule: 'whatsappnumber.verify', secrets: ['483920'] } })
    expect(at(`${PAGE}/page_whatsapp_number_verification`, form({ whatsapp_number: '+39 000 000' }), 'messagingpage')).toMatchObject({ problem: expect.stringMatching(/international form/) })
  })
})

describe('the owner check, then the Page token', () => {
  const send = (params: Record<string, string>, extra: Partial<Parameters<typeof metaWriteCall>[0]> = {}) => metaWriteCall({ connectionId: 'm-1', operation: 'messenger.message', objectId: PAGE, objectKind: 'messengerpage', edge: 'messages', params, check: false, ...extra })
  const textParams = (t = 'Ciao') => ({ recipient: j({ id: PERSON }), messaging_type: 'RESPONSE', message: j({ text: t }) })
  it('a message to a person with a conversation of the chosen Page: the conversation read with the Page\'s token, then the message as the Page; no person or words in the call log', async () => {
    h.answers.push(tokenAnswer(), conversation(), tokenAnswer(), json({ recipient_id: PERSON, message_id: 'm_sent0123456789' }))
    const res = await send(textParams('Grazie del messaggio'))
    expect(res.ok).toBe(true)
    expect(paths()).toEqual([`GET /${PAGE}`, `GET /${PAGE}/conversations`, `GET /${PAGE}`, `POST /${PAGE}/messages`])
    expect(sent(1).url.searchParams.get('user_id')).toBe(PERSON)
    expect(sent(1).url.searchParams.get('platform')).toBe('messenger')
    expect(sent(1).url.searchParams.get('access_token')).toBe(PAGE_TOKEN)
    expect(sent(3).url.searchParams.get('access_token')).toBe(PAGE_TOKEN)
    expect(sent(3).body).toBe(form(textParams('Grazie del messaggio')))
    expect(JSON.stringify(gatewayLedger)).not.toContain(PAGE_TOKEN)
    expect(JSON.stringify(gatewayLedger.map((r) => r.endpoint))).not.toContain(PERSON)
  })
  it('a failed message keeps no person and no words in the call log', async () => {
    h.answers.push(tokenAnswer(), conversation(), tokenAnswer(), json({ error: { code: 551, message: 'This person isn\'t available right now.' } }, 400))
    const res = await send(textParams('Parole riservate'))
    expect(res.ok).toBe(false)
    const row = JSON.stringify(gatewayLedger[gatewayLedger.length - 1])
    expect(row).not.toContain(PERSON)
    expect(row).not.toContain('Parole riservate')
  })
  it('a person with no conversation of the chosen Page, or one another business uses, or another Page in the path: nothing sent', async () => {
    h.answers.push(tokenAnswer(), json({ data: [] }))
    expect(await send(textParams()).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/no Messenger conversation with the chosen Facebook Page/) })
    h.answers.push(tokenAnswer(), conversation([PERSON, OTHER_PAGE]))
    expect(await send(textParams()).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
    h.calls = []
    gatewayMetaTakenLinks.add(`PAGE:${PERSON}`)
    expect(await send(textParams()).catch((e) => e)).toMatchObject({ message: expect.stringMatching(/another business in Nexus uses/) })
    gatewayMetaTakenLinks.clear()
    expect(await send(textParams(), { objectId: OTHER_PAGE }).catch((e) => e)).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    delete gatewayMetaPage['m-1']
    expect(await send(textParams()).catch((e) => e)).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
  })
  it('Instagram Direct: only when Meta names the chosen Instagram account as the Page\'s; the person in an Instagram conversation of it', async () => {
    const ig = (answers: Array<() => Response>) => { h.answers.push(...answers); return send(textParams(), { objectKind: 'instagrampage', operation: 'instagram.message' }).catch((e) => e) }
    expect(await ig([json({ id: PAGE, instagram_business_account: { id: '170000000000099' } })])).toMatchObject({ code: 'META_INSTAGRAM_NOT_CHOSEN' })
    h.calls = []
    const ok = await ig([json({ id: PAGE, instagram_business_account: { id: IG } }), tokenAnswer(), conversation([PERSON, IG]), tokenAnswer(), json({ recipient_id: PERSON, message_id: 'aWdfSentMessage012345' })])
    expect(ok.ok).toBe(true)
    expect(sent(2).url.searchParams.get('platform')).toBe('instagram')
    expect(sent(0).url.searchParams.get('access_token')).toBe(SYSTEM_TOKEN)
  })
  it('a persona, a reply-to, an app: each the Page\'s own or of this conversation', async () => {
    h.answers.push(tokenAnswer(), conversation(), tokenAnswer(), json({ data: [{ id: '120000000000902' }] }))
    expect(await send({ ...textParams(), persona_id: '120000000000901' }).catch((e) => e)).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN', message: expect.stringMatching(/inside this change, 120000000000901 is not one of the chosen Page's personas/) })
    h.calls = []
    h.answers.push(tokenAnswer(), conversation(), tokenAnswer(), json({ data: [{ id: 'm_Other0123456789' }] }))
    expect(await send({ ...textParams(), reply_to: j({ mid: MID }) }).catch((e) => e)).toMatchObject({ message: expect.stringMatching(/not one of the 20 newest/) })
    expect(sent(3).url.pathname).toContain(`/${CONV}/messages`)
    h.calls = []
    const pass = (app: string) => metaWriteCall({ connectionId: 'm-1', operation: 'thread.pass', objectId: PAGE, objectKind: 'messengerpage', edge: 'pass_thread_control', params: { recipient: j({ id: PERSON }), target_app_id: app }, check: false }).catch((e) => e)
    h.answers.push(tokenAnswer(), conversation(), tokenAnswer(), json({ success: true }))
    expect((await pass(META_INSTAGRAM_INBOX_APP)).ok).toBe(true)
    h.calls = []
    h.answers.push(tokenAnswer(), conversation(), tokenAnswer(), json({ data: [{ id: '120000000000077' }] }))
    expect(await pass('120000000000088')).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN', message: expect.stringMatching(/not one of the apps installed on the chosen Page/) })
  })
  it('a creator: the messaging id Meta\'s marketplace answers for the named creator, never one another business uses', async () => {
    const creator = (parent?: { kind: 'creator'; id: string }) => send({ recipient: j({ id: '942900000000001' }), message: j({ text: 'Ciao' }), folder: 'partnership' }, { objectKind: 'instagrampage', operation: 'instagram.message', ...(parent ? { parent } : {}) }).catch((e) => e)
    h.answers.push(json({ id: PAGE, instagram_business_account: { id: IG } }))
    expect(await creator()).toMatchObject({ message: expect.stringMatching(/names the creator/) })
    h.answers.push(json({ id: PAGE, instagram_business_account: { id: IG } }), json({ data: [{ id: '178000000000001', messaging_id: '942900000000002' }] }))
    expect(await creator({ kind: 'creator', id: 'creator.a' })).toMatchObject({ message: expect.stringMatching(/not the messaging id/) })
    gatewayMetaTakenLinks.add('INSTAGRAM:178000000000001')
    h.answers.push(json({ id: PAGE, instagram_business_account: { id: IG } }), json({ data: [{ id: '178000000000001', messaging_id: '942900000000001' }] }))
    expect(await creator({ kind: 'creator', id: 'creator.a' })).toMatchObject({ message: expect.stringMatching(/another business in Nexus uses/) })
    gatewayMetaTakenLinks.clear()
    h.calls = []
    h.answers.push(json({ id: PAGE, instagram_business_account: { id: IG } }), json({ data: [{ id: '178000000000001', messaging_id: '942900000000001' }] }), tokenAnswer(), json({ recipient_id: '942900000000001', message_id: 'mid.$c0123456' }))
    expect((await creator({ kind: 'creator', id: 'creator.a' })).ok).toBe(true)
    expect(sent(1).url.searchParams.get('username')).toBe('creator.a')
  })
  it('a label: one the chosen Page lists, on a person with a Messenger conversation of it', async () => {
    const assign = () => metaWriteCall({ connectionId: 'm-1', operation: 'pagelabel.assign', objectId: LABEL, objectKind: 'pagelabel', edge: 'label', params: { user: PERSON }, check: false }).catch((e) => e)
    h.answers.push(tokenAnswer(), json({ data: [{ id: '120000000000888' }] }))
    expect(await assign()).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN', message: expect.stringMatching(/not one of the chosen Page's inbox labels/) })
    h.calls = []
    h.answers.push(tokenAnswer(), json({ data: [{ id: LABEL }] }), tokenAnswer(), conversation(), tokenAnswer(), json({ success: true }))
    expect((await assign()).ok).toBe(true)
    expect(paths()).toEqual([`GET /${PAGE}`, `GET /${PAGE}/custom_labels`, `GET /${PAGE}`, `GET /${PAGE}/conversations`, `GET /${PAGE}`, `POST /${LABEL}/label`])
    expect(sent(5).body).toBe(`user=${PERSON}`)
  })
  it('a template delete: the Page\'s template with that name; a flow an ad uses is never changed', async () => {
    const del = (name: string) => metaWriteCall({ connectionId: 'm-1', operation: 'pagetemplate.delete', objectId: PAGE, objectKind: 'messagingpage', edge: 'message_templates', method: 'DELETE', params: { name, template_id: '120000000000811' }, check: false }).catch((e) => e)
    h.answers.push(tokenAnswer(), json({ data: [{ id: '120000000000811', name: 'order_update' }] }))
    expect(await del('other_name')).toMatchObject({ message: expect.stringMatching(/is named "order_update", not "other_name"/) })
    h.answers.push(tokenAnswer(), json({ data: [{ id: '120000000000701', is_used_in_ad: true }] }))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'welcomeflow.update', objectId: PAGE, objectKind: 'messagingpage', edge: 'welcome_message_flows', params: { flow_id: '120000000000701', name: 'Flow B' }, check: false }).catch((e) => e)).toMatchObject({ message: expect.stringMatching(/used in an ad/) })
  })
  it('WhatsApp: only an account of the chosen ad account\'s own portfolio, never a shared one; its own templates; the system-user token', async () => {
    const create = (objectId = WABA) => metaWriteCall({ connectionId: 'm-1', operation: 'templategroup.create', objectId, objectKind: 'waba', edge: 'template_groups', params: { name: 'Group A', whatsapp_business_templates: j(['120000000000901']) }, check: false }).catch((e) => e)
    gatewayMetaSharedPortfolios.add(PORTFOLIO)
    expect(await create()).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/another business in Nexus uses an ad account of this Meta business portfolio/) })
    gatewayMetaSharedPortfolios.clear()
    expect(h.calls).toHaveLength(0)
    h.answers.push(json({ data: [{ id: '120000000000999' }] }))
    expect(await create()).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/not a WhatsApp account the chosen ad account's business portfolio owns/) })
    h.calls = []
    h.answers.push(json({ data: [{ id: WABA }] }), json({ data: [{ id: '120000000000902' }] }))
    expect(await create()).toMatchObject({ message: expect.stringMatching(/template 120000000000901 is not one of this WhatsApp account's templates/) })
    expect(sent(1).url.searchParams.get('summary')).toBe('total_count')
    h.calls = []
    h.answers.push(json({ data: [{ id: WABA }] }), json({ data: [{ id: '120000000000901' }] }), json({ id: '120000000000950' }))
    expect((await create()).ok).toBe(true)
    expect(paths()).toEqual([`GET /${PORTFOLIO}/owned_whatsapp_business_accounts`, `GET /${WABA}/message_templates`, `POST /${WABA}/template_groups`])
    expect(h.calls.every((c) => new URL(c.url).searchParams.get('access_token') === SYSTEM_TOKEN)).toBe(true)
    // A group of another account; no portfolio at all.
    h.calls = []
    h.answers.push(json({ data: [{ id: WABA }] }), json({ id: '120000000000950', whatsapp_business_account: { id: '120000000000998' } }))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'templategroup.delete', objectId: '120000000000950', objectKind: 'templategroup', method: 'DELETE', params: {}, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    gatewayMetaPortfolio['m-1'] = null
    expect(await create()).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/names no Meta business portfolio/) })
  })
  it('a verification code never reaches the call log, even when Meta refuses it', async () => {
    h.answers.push(tokenAnswer(), json({ error: { code: 100, message: 'Invalid parameter 483920' } }, 400))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'whatsappnumber.verify', objectId: PAGE, objectKind: 'messagingpage', edge: 'page_whatsapp_number_verification', params: { whatsapp_number: '+390000000000', verification_code: '483920' }, check: false })
    expect(res.ok).toBe(false)
    expect(JSON.stringify(gatewayLedger)).not.toContain('483920')
    expect(res.text).not.toContain('483920')
  })
  it('a Page\'s own Messenger (80006) or Instagram (80002) limit on a message holds nothing of the ad account: a pause still goes', async () => {
    gatewayMetaStored['120000000000001'] = { adAccountId: '1234567890', kind: 'campaign' }
    const pause = () => metaWriteCall({ connectionId: 'm-1', operation: 'status.change', objectId: '120000000000001', objectKind: 'campaign', params: { status: 'PAUSED' }, check: false }).catch((e) => e)
    for (const code of [80006, 80002]) {
      __metaObjectLimitsTest.useMemory()
      h.calls = []
      h.answers.push(tokenAnswer(), conversation(), tokenAnswer(), json({ error: { code, message: 'There have been too many messenger api calls to this Page account. Wait a bit and try again.' } }, 400))
      const refused = await send(textParams())
      expect(refused.ok, String(code)).toBe(false)
      h.answers.push(json({ success: true }))
      expect((await pause()).ok, String(code)).toBe(true)
    }
    delete gatewayMetaStored['120000000000001']
  })
  it('a WhatsApp account\'s own limit (80008) on a template change holds only the WhatsApp bucket: a pause still goes', async () => {
    gatewayMetaStored['120000000000001'] = { adAccountId: '1234567890', kind: 'campaign' }
    h.answers.push(json({ data: [{ id: WABA }] }), json({ data: [{ id: '120000000000901' }] }), json({ error: { code: 80008, message: 'There have been too many calls to this WhatsApp Business account.' } }, 400))
    const refused = await metaWriteCall({ connectionId: 'm-1', operation: 'templategroup.create', objectId: WABA, objectKind: 'waba', edge: 'template_groups', params: { name: 'Group A', whatsapp_business_templates: j(['120000000000901']) }, check: false })
    expect(refused.ok).toBe(false)
    h.answers.push(json({ success: true }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'status.change', objectId: '120000000000001', objectKind: 'campaign', params: { status: 'PAUSED' }, check: false })).ok).toBe(true)
    delete gatewayMetaStored['120000000000001']
  })
})
