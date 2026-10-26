/**
 * Meta ads step 43 — the draft of create-meta-backed-account, pure: one request, its exact path, kind and (no) keys; refused
 * (nothing queued) when it would do nothing, when Nexus cannot tell, or when the account could run no ad (a Page-backed
 * Threads account without the Page's Page-backed Instagram account). Made-up ids and names.
 */
import { describe, expect, it } from 'vitest'
import { BACKED_NO_UNDO, backedDraft, madeIdOf } from './change-business-assets.js'
import type { MetaChangeDraft } from './change-draft.js'

const PAGE = '120000000000010'
const IG = '17840000000000001'

const ok = (out: MetaChangeDraft | { refusal: string }): MetaChangeDraft => { if ('refusal' in out) throw new Error(out.refusal); return out }
const no = (out: MetaChangeDraft | { refusal: string }): string => { if (!('refusal' in out)) throw new Error('expected a refusal'); return out.refusal }

describe('create-meta-backed-account drafts (BM-051, CR-228, CR-230)', () => {
  it('a Page-backed Instagram account: POST on the chosen Page\'s edge, no body, not read back, nothing spends, no undo', () => {
    const d = ok(backedDraft({ kind: 'instagram-for-page', objectId: PAGE, existing: { id: null } }))
    expect(d.requests).toHaveLength(1)
    expect(d.requests[0]).toMatchObject({ objectId: PAGE, objectKind: 'backedpage', edge: 'page_backed_instagram_accounts', params: {}, check: 'none', raisesSpend: false, undoable: false, skipReadBack: true, operation: 'assets.backed.instagram-for-page' })
    expect(d.requests[0].method).toBeUndefined()
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings).toContain(BACKED_NO_UNDO)
    expect(d.requests[0].doneSentence!({ node: { id: '17840000000000099' }, readBack: 'none', waitedMs: 0 })).toMatch(/Meta made it \(id 17840000000000099\)/)
    expect(d.requests[0].explain!['200']).toMatch(/Advertise task/)
  })
  it('one exists already, the read was refused, or nothing is chosen: refused, nothing queued', () => {
    expect(no(backedDraft({ kind: 'instagram-for-page', objectId: PAGE, existing: { id: '17840000000000050' } }))).toMatch(/has a Page-backed Instagram account already \(id 17840000000000050\)/)
    expect(no(backedDraft({ kind: 'threads-for-page', objectId: PAGE, existing: { refused: 'Meta said no.' } }))).toMatch(/could not read whether.*Meta said no/)
    expect(no(backedDraft({ kind: 'threads-for-instagram', objectId: null, existing: { id: null } }))).toMatch(/chosen no Instagram account/)
  })
  it('Threads: on the chosen Instagram account or Page; a linked one is named; a Page-backed one needs the Page\'s Page-backed Instagram account (refused without it, or when Nexus cannot tell)', () => {
    const ig = ok(backedDraft({ kind: 'threads-for-instagram', objectId: IG, existing: { id: null }, linkedThreads: '900000000000001' }))
    expect(ig.requests[0]).toMatchObject({ objectId: IG, objectKind: 'backedinstagram', edge: 'instagram_backed_threads_user' })
    expect(ig.warnings.join(' ')).toMatch(/already has a linked Threads account \(900000000000001\)/)
    // Review N1 — no Page-backed Instagram account: refused (the Threads account runs no ad and stays for good); unread: cannot tell.
    expect(no(backedDraft({ kind: 'threads-for-page', objectId: PAGE, existing: { id: null }, pageBackedInstagram: null }))).toMatch(/has no Page-backed Instagram account.*you cannot run ads on Threads if the Page-backed Instagram account from the same Page cannot run ads on Instagram/)
    expect(no(backedDraft({ kind: 'threads-for-page', objectId: PAGE, existing: { id: null } }))).toMatch(/Nexus cannot tell whether the chosen Page 120000000000010 has a Page-backed Instagram account/)
    const page = ok(backedDraft({ kind: 'threads-for-page', objectId: PAGE, existing: { id: null }, pageBackedInstagram: '17840000000000050' }))
    expect(page.requests[0]).toMatchObject({ objectId: PAGE, objectKind: 'backedpage', edge: 'page_backed_threads_accounts' })
    expect(page.warnings.join(' ')).toMatch(/You should only use a Page-backed Threads account when you are using a Page-backed Instagram account/)
    // Review N3.
    expect(page.warnings.join(' ')).toMatch(/pages_read_engagement/)
  })
  it('review N2 — a Page-backed Instagram account for a Page with a connected Instagram account: Meta\'s restriction quoted; unread: said', () => {
    expect(ok(backedDraft({ kind: 'instagram-for-page', objectId: PAGE, existing: { id: null }, connectedInstagram: '17840000000000077' })).warnings.join(' ')).toMatch(/connected Instagram account \(17840000000000077\).*you cannot use its PBIA to create ads/)
    expect(ok(backedDraft({ kind: 'instagram-for-page', objectId: PAGE, existing: { id: null } })).warnings.join(' ')).toMatch(/could not read whether the chosen Page has a connected Instagram account/)
    expect(ok(backedDraft({ kind: 'instagram-for-page', objectId: PAGE, existing: { id: null }, connectedInstagram: null })).warnings.join(' ')).not.toMatch(/connected Instagram account/)
  })
  it('the made id from Meta\'s answer: id or threads_user_id, digits only', () => {
    expect(madeIdOf({ node: { id: '17840000000000099' } })).toBe('17840000000000099')
    expect(madeIdOf({ node: { threads_user_id: 900000000000002 } })).toBe('900000000000002')
    expect(madeIdOf({ node: { id: 'act_1' } })).toBeNull()
    expect(madeIdOf({ node: null })).toBeNull()
  })
})
