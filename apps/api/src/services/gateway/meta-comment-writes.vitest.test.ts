/**
 * Meta step 37 on the gateway — comments and moderation:
 *   - the comment rules are an exact ALLOW-list: keys per kind of object, every value judged (booleans as true / false, one
 *     id in the block list, https links, text only in the reply's own key, Meta's lengths), a like with no body at all;
 *   - Facebook and Instagram go AS the chosen Page (the gateway reads the Page's own token for that one call, never hands it
 *     out); Threads goes with the system-user token;
 *   - the owner check per kind — a post or comment of the chosen Page (the Page's own comment for an edit), a branded post
 *     that tags it, the chosen Instagram account's media / comment / own node with the mention's ids, an ad's Threads post
 *     and its direct reply — with a neighbour of another business and a node of another kind, each refused before
 *     anything is sent.
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

import { gatewayLedger, gatewayMetaChosen, gatewayMetaInstagram, gatewayMetaPage } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaUrl, metaWriteCall } from './meta.js'
import { metaReadOnlyProblem, metaWriteVerdict } from './meta-calls.js'
import { IG_POLL_COMMENT_FIELDS, IG_POLL_MEDIA_FIELDS, IG_POLL_MEDIA_FIELDS_PLAIN } from '../marketing/meta-ads/instagram-comment-poll.js'
import { META_COMMENT_LIMITS, META_COMMENT_TEXT } from './meta-comment-rules.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'
import { metaSendChange } from '../marketing/meta-ads/write-client.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const PAGE = '120000000000010'
const OTHER_PAGE = '120000000000099'
const POST = `${PAGE}_500000000000001`
const COMMENT = '500000000000001_900000000000001'
const IG = '170000000000010'
const MEDIA = '180000000000001'
const IG_COMMENT = '190000000000001'
const AD = '120000000000003'
const THREADS = '210000000000001'
const REPLY = '210000000000002'

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const tokenAnswer = () => json({ id: PAGE, access_token: PAGE_TOKEN })
const sent = (i: number) => ({ method: h.calls[i].init.method, url: new URL(h.calls[i].url), body: h.calls[i].init.body })
const paths = () => h.calls.map((c) => `${c.init.method} ${new URL(c.url).pathname.replace(`/${META_DEFAULT_GRAPH_API_VERSION}`, '')}`)
const verdict = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => metaWriteVerdict({ method: 'POST', url: `${BASE}/${COMMENT}`, kind: 'write', objectKind: 'fbcomment', body: 'is_hidden=true', ...input })
const problem = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const store of [gatewayMetaPage, gatewayMetaInstagram, gatewayMetaChosen]) for (const key of Object.keys(store)) delete store[key]
  // The chosen Page and Instagram account of m-1 (main's stubs choose none unless a test sets them).
  gatewayMetaPage['m-1'] = PAGE
  gatewayMetaInstagram['m-1'] = IG
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('the comment rules are an exact allow-list', () => {
  it('hide / unhide a Facebook comment: is_hidden true or false only, made as the Page', () => {
    expect(verdict({})).toMatchObject({ write: { rule: 'fbcomment.hide', objectId: COMMENT, auth: 'page', body: 'is_hidden=true' } })
    expect(problem({ body: 'is_hidden=1' })).toMatch(/true or false/)
    expect(problem({ body: 'is_hidden=true&message=x' })).toMatch(/only Meta change/)
    expect(problem({ body: 'is_hidden=true&fields=id' })).toMatch(/only Meta change/)
    expect(problem({ body: 'is_hidden=true&is_hidden=false' })).toMatch(/more than once/)
    // Branded content (OT-032) takes only the hide rule.
    expect(verdict({ objectKind: 'brandedcomment' })).toMatchObject({ write: { rule: 'fbcomment.hide', auth: 'page' } })
    expect(problem({ objectKind: 'brandedcomment', body: form({ message: 'x' }) })).toMatch(/only Meta change/)
  })
  it('the step-17 status rule is untouched: a bare id is a campaign\'s status, a comment id is not', () => {
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/120000000000001`, kind: 'write', body: 'status=PAUSED', objectKind: 'campaign' })).toEqual({ write: { rule: 'object.status', objectId: '120000000000001', check: false, body: 'status=PAUSED', budget: false } })
    expect(problem({ body: 'status=PAUSED', objectKind: 'campaign' })).toMatch(/only Meta change/)
    expect(problem({ objectKind: undefined })).toMatch(/only Meta change/)
  })
  it('a comment or reply as the Page: message and / or an https image or GIF link; text only in message', () => {
    const create = (body: string, objectKind = 'fbpost', url = `${BASE}/${POST}/comments`) => metaWriteVerdict({ method: 'POST', url, kind: 'write', objectKind, body })
    expect(create(form({ message: 'Grazie! 😊\nA presto' }))).toMatchObject({ write: { rule: 'fbcomment.create', objectId: POST, auth: 'page' } })
    expect(create(form({ message: 'Danke', attachment_url: 'https://example.com/a.jpg' }), 'fbcomment', `${BASE}/${COMMENT}/comments`)).toMatchObject({ write: { rule: 'fbcomment.create', objectId: COMMENT } })
    expect(create(form({ attachment_share_url: 'https://example.com/a.gif' }))).toMatchObject({ write: { rule: 'fbcomment.create' } })
    expect(create(form({ attachment_url: 'http://example.com/a.jpg' }))).toMatchObject({ problem: expect.stringMatching(/https link/) })
    expect(create(form({ message: 'x', source: 'file' }))).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(create(form({ message: 'x', attachment_id: '1' }))).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(create('')).toMatchObject({ problem: expect.stringMatching(/form body/) })
    expect(create(form({ message: '   ' }))).toMatchObject({ problem: expect.stringMatching(/reply's text/) })
    expect(create(form({ message: 'x'.repeat(META_COMMENT_LIMITS.facebook + 1) }))).toMatchObject({ problem: expect.stringMatching(/at most 8000/) })
    // No control or format character (a bidi override, a zero-width mark); a line break is allowed.
    expect(create(form({ message: 'Ciao‮olleh' }))).toMatchObject({ problem: expect.stringMatching(/printable text/) })
    expect(create(form({ message: 'Ciao​x' }))).toMatchObject({ problem: expect.stringMatching(/printable text/) })
    expect(create(form({ message: 'Ciao\r\nx' }))).toMatchObject({ problem: expect.stringMatching(/printable text/) })
    expect(META_COMMENT_TEXT.test('Linea uno\nLinea due 👨‍👩‍👧')).toBe(true)
    // Plain ASCII in a link.
    expect(create(form({ message: 'x', attachment_url: 'https://example.com/è.jpg' }))).toMatchObject({ problem: expect.stringMatching(/plain ASCII/) })
    // A post's comments only for a post or comment kind; never the Page's own node.
    expect(create(form({ message: 'x' }), 'page')).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
  })
  it('an edit only of the Page\'s own comment (its own kind); a hide never rides on it', () => {
    expect(verdict({ objectKind: 'fbpagecomment', body: form({ message: 'Nuovo testo' }) })).toMatchObject({ write: { rule: 'fbcomment.edit', auth: 'page' } })
    expect(problem({ objectKind: 'fbcomment', body: form({ message: 'x' }) })).toMatch(/only Meta change/)
    expect(problem({ objectKind: 'fbpagecomment', body: form({ message: 'x', is_hidden: 'true' }) })).toMatch(/only Meta change/)
  })
  it('a like has no body at all; an unlike and a delete no body; a body on a like is refused', () => {
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${POST}/likes`, kind: 'write', objectKind: 'fbpost', body: '' })).toEqual({ write: { rule: 'fblike.create', objectId: POST, check: false, body: '', budget: false, kinds: ['fbpost', 'fbcomment', 'fbpagecomment'], auth: 'page' } })
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${POST}/likes`, kind: 'read', objectKind: 'fbpost', body: '' })).toMatchObject({ problem: expect.stringMatching(/goes as a write/) })
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${POST}/likes`, kind: 'write', objectKind: 'fbpost', body: 'x=1' })).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(metaWriteVerdict({ method: 'DELETE', url: `${BASE}/${COMMENT}/likes`, kind: 'write', objectKind: 'fbcomment' })).toMatchObject({ write: { rule: 'fblike.delete', method: 'DELETE', auth: 'page' } })
    expect(metaWriteVerdict({ method: 'DELETE', url: `${BASE}/${COMMENT}`, kind: 'write', objectKind: 'fbcomment' })).toMatchObject({ write: { rule: 'fbcomment.delete', method: 'DELETE', auth: 'page' } })
    expect(metaWriteVerdict({ method: 'DELETE', url: `${BASE}/${COMMENT}`, kind: 'write', objectKind: 'fbcomment', body: 'x=1' })).toMatchObject({ problem: expect.stringMatching(/deletes on Meta only .*set-meta-comments/) })
    // A bodyless POST on any other path is still refused.
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/${COMMENT}`, kind: 'write', objectKind: 'fbcomment', body: '' })).toMatchObject({ problem: expect.stringMatching(/form body/) })
  })
  it('a block: ONE Page-scoped id (psid) as Nexus writes the list; an unblock: one psid; never `user`, never two keys; the ledger keeps no person', () => {
    const block = (body: string, method = 'POST') => metaWriteVerdict({ method, url: `${BASE}/${PAGE}/blocked`, kind: 'write', objectKind: 'page', body })
    expect(block(form({ psid: '["300000000000001"]' }))).toMatchObject({ write: { rule: 'pageblock.create', objectId: PAGE, auth: 'page', ledgerBody: 'psid=%5B%22%28a+person%29%22%5D' } })
    for (const bad of ['["1","2"]', '[300000000000001]', '[ "300000000000001"]', '300000000000001', '["abc"]']) expect(block(form({ psid: bad })), bad).toMatchObject({ problem: expect.stringMatching(/exactly one Page-scoped id/) })
    // Review fix B1 — a comment's author is a PSID: the `user` key (User or Page ids) is never sent, alone or with psid.
    expect(block(form({ user: '["300000000000001"]' }))).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(block(form({ psid: '["300000000000001"]', user: '["300000000000001"]' }))).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(block(form({ uid: '["1"]' }))).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(block(form({ asid: '["1"]' }))).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(block(form({ psid: '300000000000001' }), 'DELETE')).toMatchObject({ write: { rule: 'pageblock.delete', method: 'DELETE', auth: 'page', ledgerBody: 'psid=%28a+person%29' } })
    expect(block(form({ user: '300000000000001' }), 'DELETE')).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(block(form({ psid: '300000000000001', user: '300000000000001' }), 'DELETE')).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(block(form({ psid: '["300000000000001"]' }), 'DELETE')).toMatchObject({ problem: expect.stringMatching(/one Page-scoped id/) })
    expect(metaWriteVerdict({ method: 'DELETE', url: `${BASE}/${PAGE}/blocked`, kind: 'write', objectKind: 'page' })).toMatchObject({ problem: expect.stringMatching(/deletes on Meta only .*set-meta-comments/) })
  })
  it('the Instagram comment poll\'s two reads pass the read gate as they are sent (total_comments_count included)', () => {
    expect(IG_POLL_MEDIA_FIELDS).toContain('total_comments_count')
    for (const [path, fields, limit] of [[`${IG}/media`, IG_POLL_MEDIA_FIELDS, 25], [`${IG}/media`, IG_POLL_MEDIA_FIELDS_PLAIN, 25], [`${MEDIA}/comments`, IG_POLL_COMMENT_FIELDS, 50]] as const) {
      expect(metaReadOnlyProblem({ method: 'GET', url: metaUrl(path, { fields, limit }), kind: 'read' }), `${path} ${fields}`).toBeNull()
      expect(metaReadOnlyProblem({ method: 'GET', url: metaUrl(path, { fields, limit, after: 'QVFIUm' }), kind: 'read' })).toBeNull()
    }
    // A person's words or name are never in what the comments read asks.
    expect(IG_POLL_COMMENT_FIELDS).toBe('id,timestamp')
  })
  it('Instagram: hide, delete, reply, a top-level comment, comments on / off, a mention reply — each its own keys and kind', () => {
    const ig = (path: string, body: string, objectKind: string, method = 'POST') => metaWriteVerdict({ method, url: `${BASE}/${path}`, kind: 'write', objectKind, body })
    expect(ig(IG_COMMENT, 'hide=true', 'igcomment')).toMatchObject({ write: { rule: 'igcomment.hide', auth: 'page' } })
    expect(ig(IG_COMMENT, 'hide=yes', 'igcomment')).toMatchObject({ problem: expect.stringMatching(/true or false/) })
    expect(ig(IG_COMMENT, 'is_hidden=true', 'igcomment')).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(ig(IG_COMMENT, '', 'igcomment', 'DELETE')).toMatchObject({ write: { rule: 'igcomment.delete', auth: 'page' } })
    expect(ig(`${IG_COMMENT}/replies`, form({ message: 'Grazie!' }), 'igcomment')).toMatchObject({ write: { rule: 'igcomment.reply', auth: 'page' } })
    expect(ig(`${IG_COMMENT}/replies`, form({ message: 'x'.repeat(META_COMMENT_LIMITS.instagram + 1) }), 'igcomment')).toMatchObject({ problem: expect.stringMatching(/at most 2200/) })
    expect(ig(`${MEDIA}/comments`, form({ message: 'Ciao' }), 'igmedia')).toMatchObject({ write: { rule: 'igmedia.comment', auth: 'page' } })
    expect(ig(MEDIA, 'comment_enabled=false', 'igmedia')).toMatchObject({ write: { rule: 'igmedia.commentEnabled', auth: 'page' } })
    expect(ig(MEDIA, 'comment_enabled=false&caption=x', 'igmedia')).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(ig(MEDIA, 'status=ACTIVE', 'igmedia')).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(ig(`${IG}/mentions`, form({ media_id: MEDIA, comment_id: IG_COMMENT, message: 'Grazie' }), 'iguser')).toMatchObject({ write: { rule: 'iguser.mention', ids: [{ id: IG_COMMENT, kind: 'mentionedcomment' }, { id: MEDIA, kind: 'mentionedmedia' }] } })
    expect(ig(`${IG}/mentions`, form({ media_id: MEDIA, message: 'Grazie' }), 'iguser')).toMatchObject({ write: { ids: [{ id: MEDIA, kind: 'mentionedmedia' }] } })
    expect(ig(`${IG}/mentions`, form({ comment_id: IG_COMMENT, message: 'x' }), 'iguser')).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(ig(`${IG}/mentions`, form({ media_id: 'abc', message: 'x' }), 'iguser')).toMatchObject({ problem: expect.stringMatching(/media id/) })
    // A kind of another platform does not reach an Instagram rule.
    expect(ig(IG_COMMENT, 'hide=true', 'fbcomment')).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
  })
  it('Threads: manage_reply hide and add_reply text, with the system-user token (no Page auth)', () => {
    const th = (path: string, body: string, objectKind: string) => metaWriteVerdict({ method: 'POST', url: `${BASE}/${path}`, kind: 'write', objectKind, body })
    const hide = th(`${REPLY}/manage_reply`, 'hide=true', 'threadsreply')
    expect(hide).toMatchObject({ write: { rule: 'threadsreply.hide' } })
    expect('write' in hide && hide.write.auth).toBeFalsy()
    expect(th(`${THREADS}/add_reply`, form({ text: 'Thanks!' }), 'threadsmedia')).toMatchObject({ write: { rule: 'threads.reply' } })
    expect(th(`${THREADS}/add_reply`, form({ text: 'x'.repeat(501) }), 'threadsmedia')).toMatchObject({ problem: expect.stringMatching(/at most 500/) })
    expect(th(`${THREADS}/add_reply`, form({ text: 'x', media_type: 'IMAGE' }), 'threadsmedia')).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
    expect(th(`${REPLY}/manage_reply`, 'hide=true', 'threadsmedia')).toMatchObject({ problem: expect.stringMatching(/only Meta change/) })
  })
})

describe('the owner check, then the Page token', () => {
  it('a Facebook comment on a post of the chosen Page: the post, then the comment (system-user token), then the change with the Page\'s own token', async () => {
    h.answers.push(json({ id: POST }), json({ id: COMMENT }), tokenAnswer(), json({ success: true }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'fbcomment.hide', objectId: COMMENT, objectKind: 'fbcomment', params: { is_hidden: 'true' }, check: false })
    expect(res.ok).toBe(true)
    expect(paths()).toEqual([`GET /${POST}`, `GET /${COMMENT}`, `GET /${PAGE}`, `POST /${COMMENT}`])
    expect(sent(0).url.searchParams.get('access_token')).toBe(SYSTEM_TOKEN)
    expect(sent(1).url.searchParams.get('fields')).toBe('id')
    expect(sent(3).url.searchParams.get('access_token')).toBe(PAGE_TOKEN)
    expect(sent(3).body).toBe('is_hidden=true')
    expect(JSON.stringify([gatewayLedger, res.text])).not.toContain(PAGE_TOKEN)
  })
  it('a comment on a photo or video of the chosen Page counts; one of another Page, or one Meta cannot place, is refused — nothing sent', async () => {
    h.answers.push(json({ error: { code: 100, message: 'Object does not exist' } }, 400), json({ id: '500000000000001', from: { id: PAGE } }), json({ id: COMMENT }), tokenAnswer(), json({ success: true }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'fbcomment.hide', objectId: COMMENT, objectKind: 'fbcomment', params: { is_hidden: 'false' }, check: false })).ok).toBe(true)
    h.calls = []
    __metaObjectLimitsTest.useMemory()
    // A neighbour's comment: not on a post of the chosen Page, and its photo is another Page's.
    h.answers.push(json({ error: { code: 100, message: 'Object does not exist' } }, 400), json({ id: '500000000000002', from: { id: OTHER_PAGE } }))
    const neighbour = await metaWriteCall({ connectionId: 'm-1', operation: 'fbcomment.hide', objectId: '500000000000002_900000000000002', objectKind: 'fbcomment', params: { is_hidden: 'true' }, check: false }).catch((e) => e)
    expect(neighbour).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN', message: expect.stringMatching(/not on a post of the Facebook Page this business chose/) })
    expect(neighbour.message).not.toContain(OTHER_PAGE)
    // Meta cannot answer either read: unconfirmed.
    h.answers.push(json({ error: { code: 1, message: 'An unknown error occurred' } }, 500), json({ error: { code: 1, message: 'An unknown error occurred' } }, 500))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'fbcomment.hide', objectId: '500000000000003_900000000000003', objectKind: 'fbcomment', params: { is_hidden: 'true' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_PAGE_UNCONFIRMED' })
    // The comment id is not one Meta answers.
    h.answers.push(json({ id: `${PAGE}_500000000000004` }), json({ id: '500000000000004_999' }))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'fbcomment.hide', objectId: '500000000000004_900000000000004', objectKind: 'fbcomment', params: { is_hidden: 'true' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_PAGE_UNCONFIRMED' })
    expect(h.calls.every((c) => c.init.method === 'GET' && new URL(c.url).searchParams.get('access_token') === SYSTEM_TOKEN)).toBe(true)
  })
  it('a post of another Page (another business\'s too), no Page chosen, a shape that is not a post: refused before any call', async () => {
    const like = (objectId: string, connectionId = 'm-1') => metaWriteCall({ connectionId, operation: 'fblike.create', objectId, objectKind: 'fbpost', edge: 'likes', params: {}, check: false }).catch((e) => e)
    expect(await like(`${OTHER_PAGE}_500000000000001`)).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    delete gatewayMetaPage['m-3']
    expect(await like(POST, 'm-3')).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
    // The Page's own post: one read of its id, then a like with no body, as the Page.
    h.answers.push(json({ id: POST }), tokenAnswer(), json({ success: true }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'fblike.create', objectId: POST, objectKind: 'fbpost', edge: 'likes', params: {}, check: false })
    expect(res.ok).toBe(true)
    expect(paths()).toEqual([`GET /${POST}`, `GET /${PAGE}`, `POST /${POST}/likes`])
    // No form field: the gateway sends an empty body, as for step 29's run now (meta-ad-rule-writes).
    expect(sent(2).body).toBe('')
  })
  it('an edit only of a comment the chosen Page wrote', async () => {
    h.answers.push(json({ id: POST }), json({ id: COMMENT, from: { id: '300000000000001' } }))
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'fbcomment.edit', objectId: COMMENT, objectKind: 'fbpagecomment', params: { message: 'x' }, check: false }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/edits only the Page's own comments/) })
    expect(sent(1).url.searchParams.get('fields')).toBe('id,from{id}')
    expect(h.calls).toHaveLength(2)
    h.calls = []
    h.answers.push(json({ id: POST }), json({ id: COMMENT, from: { id: PAGE } }), tokenAnswer(), json({ success: true }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'fbcomment.edit', objectId: COMMENT, objectKind: 'fbpagecomment', params: { message: 'Nuovo' }, check: false })).ok).toBe(true)
  })
  it('a branded-content comment: the post must tag the chosen Page as sponsor, the comment must be on it; the post is named', async () => {
    const BRANDED = '130000000000001_600000000000001'
    const hide = (objectId: string, parent?: { kind: 'brandedpost' | 'ad'; id: string }) => metaWriteCall({ connectionId: 'm-1', operation: 'fbcomment.hide', objectId, objectKind: 'brandedcomment', params: { is_hidden: 'true' }, check: false, ...(parent ? { parent } : {}) }).catch((e) => e)
    expect(await hide('600000000000001_900000000000001')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/names that post/) })
    expect(await hide('600000000000009_900000000000001', { kind: 'brandedpost', id: BRANDED })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not on branded-content post/) })
    expect(h.calls).toHaveLength(0)
    h.answers.push(json({ data: [{ id: OTHER_PAGE }] }))
    expect(await hide('600000000000001_900000000000001', { kind: 'brandedpost', id: BRANDED })).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN', message: expect.stringMatching(/does not tag the Facebook Page this business chose/) })
    expect(paths()).toEqual([`GET /${BRANDED}/sponsor_tags`])
    h.calls = []
    h.answers.push(json({ data: [{ id: PAGE }] }), json({ id: '600000000000001_900000000000001' }), tokenAnswer(), json({ success: true }))
    const ok = await hide('600000000000001_900000000000001', { kind: 'brandedpost', id: BRANDED })
    expect(ok.ok).toBe(true)
    expect(sent(3).url.searchParams.get('access_token')).toBe(PAGE_TOKEN)
  })
  it('an Instagram comment: its media must be the chosen account\'s (owner, else username); another account\'s is refused', async () => {
    h.answers.push(json({ id: IG_COMMENT, media: { id: MEDIA } }), json({ id: MEDIA, owner: { id: IG } }), tokenAnswer(), json({ success: true }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'igcomment.hide', objectId: IG_COMMENT, objectKind: 'igcomment', params: { hide: 'true' }, check: false })).ok).toBe(true)
    expect(paths()).toEqual([`GET /${IG_COMMENT}`, `GET /${MEDIA}`, `GET /${PAGE}`, `POST /${IG_COMMENT}`])
    expect(sent(0).url.searchParams.get('fields')).toBe('id,media{id}')
    expect(sent(3).url.searchParams.get('access_token')).toBe(PAGE_TOKEN)
    h.calls = []
    // Username match when Meta answers no owner.
    h.answers.push(json({ id: MEDIA, username: 'shop_a' }), json({ id: IG, username: 'Shop_A' }), tokenAnswer(), json({ success: true }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'igmedia.commentEnabled', objectId: MEDIA, objectKind: 'igmedia', params: { comment_enabled: 'false' }, check: false })).ok).toBe(true)
    h.calls = []
    __metaObjectLimitsTest.useMemory()
    h.answers.push(json({ id: '190000000000009', media: { id: '180000000000009' } }), json({ id: '180000000000009', owner: { id: '170000000000099' } }))
    const other = await metaWriteCall({ connectionId: 'm-1', operation: 'igcomment.delete', objectId: '190000000000009', objectKind: 'igcomment', method: 'DELETE', params: {}, check: false }).catch((e) => e)
    expect(other).toMatchObject({ code: 'META_INSTAGRAM_NOT_CHOSEN' })
    expect(other.message).not.toContain('170000000000099')
    // A node of another kind (Meta: nonexisting field), and no Instagram account chosen.
    h.answers.push(json({ error: { code: 100, message: 'Tried accessing nonexisting field (media) on node type (Page)' } }, 400))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'igcomment.hide', objectId: PAGE, objectKind: 'igcomment', params: { hide: 'true' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not an Instagram comment/) })
    delete gatewayMetaInstagram['m-4']
    expect(await metaWriteCall({ connectionId: 'm-4', operation: 'igcomment.hide', objectId: IG_COMMENT, objectKind: 'igcomment', params: { hide: 'true' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_INSTAGRAM_NOT_CHOSEN' })
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
  })
  it('a mention reply: on the chosen account\'s own node, with ids Meta answers as a mention of it', async () => {
    const mention = (params: Record<string, string>, objectId = IG) => metaWriteCall({ connectionId: 'm-1', operation: 'iguser.mention', objectId, objectKind: 'iguser', edge: 'mentions', params, check: false }).catch((e) => e)
    expect(await mention({ media_id: MEDIA, message: 'Grazie' }, '170000000000099')).toMatchObject({ code: 'META_INSTAGRAM_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
    h.answers.push(json({ id: IG }))
    expect(await mention({ media_id: MEDIA, message: 'Grazie' })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/does not answer media .* @mentions/) })
    expect(sent(0).url.searchParams.get('fields')).toBe(`id,mentioned_media.media_id(${MEDIA}){id}`)
    h.calls = []
    h.answers.push(json({ id: IG, mentioned_comment: { id: IG_COMMENT, media: { id: '180000000000009' } } }))
    expect(await mention({ media_id: MEDIA, comment_id: IG_COMMENT, message: 'Grazie' })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/is not on media/) })
    h.calls = []
    h.answers.push(json({ id: IG, mentioned_comment: { id: IG_COMMENT, media: { id: MEDIA } } }), tokenAnswer(), json({ id: '190000000000077' }))
    const ok = await mention({ media_id: MEDIA, comment_id: IG_COMMENT, message: 'Grazie' })
    expect(ok.ok).toBe(true)
    expect(paths()).toEqual([`GET /${IG}`, `GET /${PAGE}`, `POST /${IG}/mentions`])
  })
  it('Threads: the ad must be the chosen account\'s, the post its creative\'s, a reply a direct one; system-user token, no Page token read', async () => {
    const th = (objectId: string, objectKind: 'threadsmedia' | 'threadsreply', parent?: { kind: 'ad' | 'brandedpost'; id: string }, edge: 'add_reply' | 'manage_reply' = 'add_reply', params: Record<string, string> = { text: 'Thanks' }) =>
      metaWriteCall({ connectionId: 'm-1', operation: 'threads.reply', objectId, objectKind, edge, params, check: false, ...(parent ? { parent } : {}) }).catch((e) => e)
    expect(await th(THREADS, 'threadsmedia')).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/names the ad/) })
    expect(h.calls).toHaveLength(0)
    h.answers.push(json({ id: AD, account_id: '9999999999', creative: { threads_media_id: THREADS } }))
    expect(await th(THREADS, 'threadsmedia', { kind: 'ad', id: AD })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    h.answers.push(json({ id: AD, account_id: '1234567890', creative: { threads_media_id: '210000000000009' } }))
    expect(await th(THREADS, 'threadsmedia', { kind: 'ad', id: AD })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not the Threads post of ad/) })
    h.answers.push(json({ id: AD, account_id: '1234567890', creative: { threads_media_id: THREADS } }), json({ data: [{ id: '210000000000005' }] }))
    expect(await th(REPLY, 'threadsreply', { kind: 'ad', id: AD }, 'manage_reply', { hide: 'true' })).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not a direct reply/) })
    h.calls = []
    __metaObjectLimitsTest.useMemory()
    h.answers.push(json({ id: AD, account_id: '1234567890', creative: { threads_media_id: THREADS } }), json({ data: [{ id: REPLY }] }), json({ success: true }))
    const ok = await th(REPLY, 'threadsreply', { kind: 'ad', id: AD }, 'manage_reply', { hide: 'true' })
    expect(ok.ok).toBe(true)
    expect(paths()).toEqual([`GET /${AD}`, `GET /${THREADS}/replies`, `POST /${REPLY}/manage_reply`])
    expect(sent(2).url.searchParams.get('access_token')).toBe(SYSTEM_TOKEN)
    expect(sent(0).url.searchParams.get('fields')).toBe('id,account_id,creative{threads_media_id}')
  })
  it('re-review B — a refused block or unblock names the Page token, MODERATE and error 283\'s permissions; step 36\'s lead-form sentence is unchanged', async () => {
    const target = { connectionId: 'm-1', adAccountId: '1234567890' }
    const refused = () => json({ error: { code: 200, message: '(#200) Permissions error' } }, 403)
    h.answers.push(tokenAnswer(), refused())
    const block = await metaSendChange(target, { objectId: PAGE, kind: 'page', edge: 'blocked', params: { psid: '["300000000000001"]' }, operation: 'pageblock.create', skipReadBack: true }).catch((e) => e)
    expect(block.message).toMatch(/block or unblock made as the chosen Facebook Page \(200[^)]*\).*Page's own token.*MODERATE task.*pages_read_engagement and pages_manage_metadata \(Meta's error 283/)
    expect(block.message).not.toMatch(/Advertise|pages_manage_ads/)
    __metaObjectLimitsTest.useMemory()
    h.answers.push(tokenAnswer(), refused())
    const unblock = await metaSendChange(target, { objectId: PAGE, kind: 'page', edge: 'blocked', method: 'DELETE', params: { psid: '300000000000001' }, operation: 'pageblock.delete' }).catch((e) => e)
    expect(unblock.message).toMatch(/block or unblock made as the chosen Facebook Page.*MODERATE/)
    __metaObjectLimitsTest.useMemory()
    h.answers.push(tokenAnswer(), refused())
    const form = await metaSendChange(target, { objectId: PAGE, kind: 'page', edge: 'leadgen_forms', params: { name: 'Form A', questions: '[{"type":"EMAIL","key":"email"}]', is_lead_capture_ai_agent_enabled: 'false', block_display_for_non_targeted_viewer: 'true' }, operation: 'leadform.create' }).catch((e) => e)
    expect(form.message).toMatch(/^Meta did not accept this change made as the chosen Facebook Page \(200[^)]*\): \(#200\) Permissions error\. The system user may have lost its role or its Advertise task on the Page \(Meta Business settings › Users › System users › Assign assets\), or its token pages_manage_ads\. Nothing was changed\.$/)
  })
  it('a kind of one platform never passes another\'s check; with Meta changes off nothing is read or sent', async () => {
    // A Threads kind with a Page rule's path, a Page kind with a Threads path: the verdict refuses it.
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: COMMENT, objectKind: 'threadsreply', params: { is_hidden: 'true' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: REPLY, objectKind: 'igcomment', edge: 'manage_reply', params: { hide: 'true' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'fbcomment.hide', objectId: COMMENT, objectKind: 'fbcomment', params: { is_hidden: 'true' }, check: false }).catch((e) => e)).toMatchObject({ outcome: 'gated' })
    expect(h.calls).toHaveLength(0)
  })
})
