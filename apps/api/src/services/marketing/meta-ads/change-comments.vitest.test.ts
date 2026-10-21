/**
 * Meta step 37 — comment changes as pure drafts: one request each, the exact keys the gateway takes, Meta's rules in
 * words (the Page edits only its own comment, Instagram replies only to a shown top-level comment, a story takes no
 * comment, the account's own comment always shows), "already so" sends nothing, nothing spends, and no person's words,
 * name or id in a preview or a record. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import {
  brandedHideDraft, facebookCommentDraft, facebookDeleteDraft, facebookEditDraft, facebookHideDraft, facebookLikeDraft, instagramCommentDraft, instagramCommentsSwitchDraft,
  instagramDeleteDraft, instagramHideDraft, instagramMentionDraft, instagramReplyDraft, pageBlockDraft, threadsHideDraft, threadsReplyDraft, COMMENT_PUBLIC, COMMENT_DELETE_FINAL,
  THREADS_NO_DELETE, editUndoProblem,
} from './change-comments.js'
import { metaWriteVerdict } from '../../gateway/meta-calls.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../../meta/api-version.js'
import type { MetaChangeDraft } from './change-draft.js'
import type { FacebookCommentState, InstagramCommentState, InstagramMediaState } from './live-comments.js'

const PAGE = '120000000000010'
const POST = `${PAGE}_500000000000001`
const COMMENT = '500000000000001_900000000000001'
const PERSON = '300000000000001'
const fb = (extra: Partial<FacebookCommentState> = {}): FacebookCommentState => ({
  pageId: PAGE, postId: POST, commentId: COMMENT, hidden: false, canHide: true, canRemove: true, canReply: true, byThePage: false, pageText: null, authorId: PERSON, ...extra,
})
const ig = (extra: Partial<InstagramCommentState> = {}): InstagramCommentState => ({ instagramId: '170000000000010', mediaId: '180000000000001', commentId: '190000000000001', hidden: false, isReply: false, byTheAccount: false, productType: 'FEED', ...extra })
const media = (extra: Partial<InstagramMediaState> = {}): InstagramMediaState => ({ instagramId: '170000000000010', mediaId: '180000000000001', commentsEnabled: true, productType: 'FEED', mediaType: 'IMAGE', ...extra })
const ok = (d: MetaChangeDraft | { refusal: string }): MetaChangeDraft => { if ('refusal' in d) throw new Error(d.refusal); return d }
const refusal = (d: MetaChangeDraft | { refusal: string }): string => ('refusal' in d ? d.refusal : '')

/** What the gateway would say of each request (the draft's keys are exactly what a rule takes). */
function gatewayTakes(d: MetaChangeDraft): void {
  for (const r of d.requests) {
    const path = r.edge ? `${r.objectId}/${r.edge}` : r.objectId
    const body = Object.keys(r.params).length ? new URLSearchParams(r.params).toString() : undefined
    const v = metaWriteVerdict({ method: r.method ?? 'POST', url: `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}/${path}`, kind: 'write', objectKind: r.objectKind, body })
    expect(v, `${r.label}: ${'problem' in v ? v.problem : ''}`).toHaveProperty('write')
    expect(('write' in v) && v.write.rule).toBe(r.operation)
  }
}
const PRIVATE = [PERSON, 'Person A', 'person_a']

describe('Facebook', () => {
  it('hide / unhide: is_hidden, read back; already so sends nothing; can_hide false refused', () => {
    const d = ok(facebookHideDraft('hide', fb()))
    expect(d.requests).toEqual([expect.objectContaining({ objectId: COMMENT, objectKind: 'fbcomment', operation: 'fbcomment.hide', params: { is_hidden: 'true' }, expect: { is_hidden: 'true' }, check: 'none', raisesSpend: false, undoable: true })])
    expect(d.after).toMatchObject({ action: 'hide', platform: 'facebook', commentId: COMMENT, postId: POST, hidden: true })
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings[0]).toMatch(/Meta has no check/)
    gatewayTakes(d)
    expect(ok(facebookHideDraft('unhide', fb({ hidden: true }))).requests[0].params).toEqual({ is_hidden: 'false' })
    expect(ok(facebookHideDraft('hide', fb({ hidden: true })))).toMatchObject({ requests: [], skipped: [expect.stringMatching(/already hidden/)] })
    // Review fix B4 — can_hide is the viewer's (the system user's), not the Page's: a warning, never a refusal.
    const notViewer = ok(facebookHideDraft('hide', fb({ canHide: false })))
    expect(notViewer.requests).toHaveLength(1)
    expect(notViewer.warnings.join(' ')).toMatch(/can_hide false to the system user's read .* Meta refuses in its own words/)
  })
  it('a branded-content comment is hidden by its own kind, naming its post', () => {
    const d = ok(brandedHideDraft('hide', { pageId: PAGE, brandedPostId: '130000000000001_600000000000001', commentId: '600000000000001_900000000000001', hidden: false, canHide: true }))
    expect(d.requests[0]).toMatchObject({ objectKind: 'brandedcomment', parent: { kind: 'brandedpost', id: '130000000000001_600000000000001' }, operation: 'fbcomment.hide' })
    gatewayTakes(d)
  })
  it('delete: final, no undo, and Meta\'s can_remove honoured', () => {
    const d = ok(facebookDeleteDraft(fb()))
    expect(d.requests[0]).toMatchObject({ method: 'DELETE', operation: 'fbcomment.delete', params: {}, undoable: false })
    expect(d.warnings).toContain(COMMENT_DELETE_FINAL)
    gatewayTakes(d)
    expect(ok(facebookDeleteDraft(fb({ canRemove: false }))).warnings.join(' ')).toMatch(/can_remove false/)
  })
  it('reply and comment: the exact words in the preview, public at once, its own kind and edge', () => {
    const reply = ok(facebookCommentDraft({ pageId: PAGE, postId: POST, commentId: COMMENT, canReply: true }, { message: 'Grazie!\nA presto', imageUrl: 'https://example.com/a.jpg' }))
    expect(reply.requests[0]).toMatchObject({ objectId: COMMENT, objectKind: 'fbcomment', edge: 'comments', params: { message: 'Grazie!\nA presto', attachment_url: 'https://example.com/a.jpg' } })
    expect(Object.values(reply.changes)[0]).toEqual({ from: 'none', to: '"Grazie!\nA presto" + image https://example.com/a.jpg' })
    expect(reply.warnings).toContain(COMMENT_PUBLIC)
    gatewayTakes(reply)
    const comment = ok(facebookCommentDraft({ pageId: PAGE, postId: POST }, { message: 'Ciao' }))
    expect(comment.requests[0]).toMatchObject({ objectId: POST, objectKind: 'fbpost', edge: 'comments' })
    expect(comment.after).toMatchObject({ action: 'comment', postId: POST, replyId: null, message: 'Ciao' })
    gatewayTakes(comment)
    expect(refusal(facebookCommentDraft({ pageId: PAGE, postId: POST }, {}))).toMatch(/Give the words/)
    expect(refusal(facebookCommentDraft({ pageId: PAGE, postId: POST }, { message: 'x'.repeat(8001) }))).toMatch(/at most 8000/)
    expect(ok(facebookCommentDraft({ pageId: PAGE, postId: POST, commentId: COMMENT, canReply: false }, { message: 'x' })).warnings.join(' ')).toMatch(/can_comment false/)
    // Review fix A5 — the encoded body is judged in the preview: 7,000 emoji fit the 8,000 cap but not the body once encoded.
    expect(refusal(facebookCommentDraft({ pageId: PAGE, postId: POST }, { message: '😀'.repeat(7000) }))).toMatch(/too long once encoded/)
    expect(refusal(instagramReplyDraft(ig(), '😀'.repeat(2200)))).toBe('')
    expect(ok(facebookCommentDraft({ pageId: PAGE, postId: POST }, { message: 'Ciao @[120000000000020]' })).warnings.join(' ')).toMatch(/Page Mentioning/)
  })
  it('edit: only the Page\'s own comment; its old words kept for the undo; the same words send nothing', () => {
    expect(refusal(facebookEditDraft(fb({ byThePage: false }), { message: 'x' }))).toMatch(/only its own comments/)
    const d = ok(facebookEditDraft(fb({ byThePage: true, pageText: 'Vecchio', authorId: PAGE }), { message: 'Nuovo' }))
    expect(d.requests[0]).toMatchObject({ objectKind: 'fbpagecomment', operation: 'fbcomment.edit', params: { message: 'Nuovo' }, expect: { message: 'Nuovo' }, undoable: true })
    expect(d.before).toMatchObject({ oldMessage: 'Vecchio' })
    expect(d.after).toMatchObject({ oldMessage: 'Vecchio', message: 'Nuovo' })
    gatewayTakes(d)
    expect(ok(facebookEditDraft(fb({ byThePage: true, pageText: 'Same' }), { message: 'Same' }))).toMatchObject({ requests: [] })
  })
  it('review fix A2 — an edit has an undo only when its old words can be sent again exactly', () => {
    for (const old of ['', '   ', null, 'Ciao\r', 'Ciao\u200Bx', 'Ciao\u200Ex', '\uFEFFCiao', 'x'.repeat(8001), '😀'.repeat(7000)]) {
      const d = ok(facebookEditDraft(fb({ byThePage: true, pageText: old, authorId: PAGE }), { message: 'Nuovo' }))
      expect(d.requests[0].undoable, JSON.stringify(old)).toBe(false)
      expect(d.after).toMatchObject({ oldMessage: null })
      expect(d.warnings.join(' '), JSON.stringify(old)).toMatch(/This edit has NO undo/)
    }
    expect(editUndoProblem('Vecchio\nsu due righe')).toBeNull()
  })
  it('like / unlike: a bodyless POST or a DELETE on likes, never read back', () => {
    const like = ok(facebookLikeDraft('like', { pageId: PAGE, postId: POST, commentId: COMMENT }))
    expect(like.requests[0]).toMatchObject({ objectId: COMMENT, objectKind: 'fbcomment', edge: 'likes', params: {}, skipReadBack: true, operation: 'fblike.create' })
    expect(like.requests[0].method).toBeUndefined()
    expect(like.warnings.join(' ')).toMatch(/Page review/)
    gatewayTakes(like)
    const unlike = ok(facebookLikeDraft('unlike', { pageId: PAGE, postId: POST }))
    expect(unlike.requests[0]).toMatchObject({ objectId: POST, objectKind: 'fbpost', method: 'DELETE', operation: 'fblike.delete' })
    gatewayTakes(unlike)
  })
  it('block / unblock: the person\'s id only in the request — never in the preview, the label or the record', () => {
    const d = ok(pageBlockDraft('block', { pageId: PAGE, personId: PERSON, via: 'comment', postId: POST, commentId: COMMENT }, { blocked: false }))
    expect(d.requests[0]).toMatchObject({ objectId: PAGE, objectKind: 'page', edge: 'blocked', params: { psid: `["${PERSON}"]` }, operation: 'pageblock.create', answerOnly: true })
    gatewayTakes(d)
    const shown = JSON.stringify([d.summary, d.changes, d.warnings, d.requests.map((r) => r.label), d.before, d.after, d.stands])
    for (const p of PRIVATE) expect(shown).not.toContain(p)
    expect(d.after).toEqual({ action: 'block', platform: 'facebook', pageId: PAGE, via: 'comment', blocked: true, postId: POST, commentId: COMMENT })
    const un = ok(pageBlockDraft('unblock', { pageId: PAGE, personId: PERSON, via: 'id' }, { blocked: true }))
    expect(un.requests[0]).toMatchObject({ method: 'DELETE', params: { psid: PERSON }, operation: 'pageblock.delete' })
    gatewayTakes(un)
    expect(ok(pageBlockDraft('block', { pageId: PAGE, personId: PERSON, via: 'id' }, { blocked: true })).requests).toEqual([])
    expect(ok(pageBlockDraft('block', { pageId: PAGE, personId: PERSON, via: 'id' }, { blocked: null, note: 'Meta refused' })).warnings.join(' ')).toMatch(/could not read the Page's blocked list \(Meta refused\)/)
    expect(refusal(pageBlockDraft('block', { pageId: PAGE, personId: PAGE, via: 'id' }, { blocked: false }))).toMatch(/cannot block itself/)
  })
})

describe('Instagram', () => {
  it('hide: hide true / false, read back hidden; the account\'s own comment is refused (Meta always shows it)', () => {
    const d = ok(instagramHideDraft('hide', ig()))
    expect(d.requests[0]).toMatchObject({ objectKind: 'igcomment', operation: 'igcomment.hide', params: { hide: 'true' }, expect: { hidden: 'true' } })
    gatewayTakes(d)
    expect(refusal(instagramHideDraft('hide', ig({ byTheAccount: true })))).toMatch(/will always be displayed/)
    // Someone else's comment (Meta answered no `user`): hidden as asked, no warning; an unreadable `user`: the warning.
    expect(ok(instagramHideDraft('hide', ig({ byTheAccount: false }))).warnings.join(' ')).not.toMatch(/could not read/)
    expect(ok(instagramHideDraft('hide', ig({ byTheAccount: null }))).warnings.join(' ')).toMatch(/in a form Nexus could not read/)
    expect(ok(instagramHideDraft('unhide', ig({ hidden: false }))).requests).toEqual([])
  })
  it('delete, reply, comment, comments on / off, mention reply: Meta\'s rules in words', () => {
    gatewayTakes(ok(instagramDeleteDraft(ig())))
    const reply = ok(instagramReplyDraft(ig(), 'Grazie!'))
    expect(reply.requests[0]).toMatchObject({ edge: 'replies', operation: 'igcomment.reply', params: { message: 'Grazie!' } })
    gatewayTakes(reply)
    expect(refusal(instagramReplyDraft(ig({ isReply: true }), 'x'))).toMatch(/only to top-level comments/)
    expect(refusal(instagramReplyDraft(ig({ hidden: true }), 'x'))).toMatch(/hidden comment/)
    expect(refusal(instagramReplyDraft(ig(), 'x'.repeat(2201)))).toMatch(/at most 2200/)
    gatewayTakes(ok(instagramCommentDraft(media(), 'Ciao')))
    expect(refusal(instagramCommentDraft(media({ commentsEnabled: false }), 'x'))).toMatch(/Comments are off/)
    expect(refusal(instagramCommentDraft(media({ productType: 'STORY' }), 'x'))).toMatch(/story/)
    const off = ok(instagramCommentsSwitchDraft('comments-off', media()))
    expect(off.requests[0]).toMatchObject({ params: { comment_enabled: 'false' }, expect: { is_comment_enabled: 'false' }, readBackFields: 'id,is_comment_enabled' })
    gatewayTakes(off)
    expect(ok(instagramCommentsSwitchDraft('comments-on', media())).requests).toEqual([])
    const mention = ok(instagramMentionDraft({ instagramId: '170000000000010', mediaId: '180000000000009', commentId: '190000000000009' }, 'Grazie'))
    expect(mention.requests[0]).toMatchObject({ objectId: '170000000000010', objectKind: 'iguser', edge: 'mentions', params: { media_id: '180000000000009', comment_id: '190000000000009', message: 'Grazie' }, undoable: false })
    expect(mention.warnings.join(' ')).toMatch(/NO undo/)
    gatewayTakes(mention)
  })
})

describe('Threads', () => {
  const state = { adId: '120000000000003', threadsMediaId: '210000000000001', replyId: '210000000000002', hidden: false }
  it('hide: manage_reply, judged by hide_status; reply: add_reply text, no undo', () => {
    const d = ok(threadsHideDraft('hide', state))
    expect(d.requests[0]).toMatchObject({ objectId: '210000000000002', objectKind: 'threadsreply', parent: { kind: 'ad', id: '120000000000003' }, edge: 'manage_reply', params: { hide: 'true' } })
    expect(d.requests[0].judge!({ hide_status: 'HUSHED' })).toEqual({ moved: [], reads: 'hide_status HUSHED' })
    expect(d.requests[0].judge!({ hide_status: 'UNHUSHED' }).moved).toEqual(['hide_status'])
    gatewayTakes(d)
    const toAd = ok(threadsReplyDraft({ ...state, replyId: null }, 'Thanks!'))
    expect(toAd.requests[0]).toMatchObject({ objectId: '210000000000001', objectKind: 'threadsmedia', edge: 'add_reply', params: { text: 'Thanks!' }, undoable: false })
    gatewayTakes(toAd)
    expect(ok(threadsReplyDraft(state, 'Thanks!')).requests[0]).toMatchObject({ objectId: '210000000000002', objectKind: 'threadsreply' })
    expect(refusal(threadsReplyDraft(state, 'x'.repeat(501)))).toMatch(/at most 500/)
    expect(toAd.warnings).toContain(THREADS_NO_DELETE)
    expect(THREADS_NO_DELETE).toMatch(/Threads login token and the threads_delete permission/)
    expect(refusal(threadsHideDraft('hide', { ...state, replyId: null }))).toMatch(/Name the reply/)
  })
})
