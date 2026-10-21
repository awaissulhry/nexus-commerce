/**
 * Meta step 39 — set-meta-block-list and remove-meta-block-list as drafts: a list Nexus fills is a draft of a file Nexus
 * writes, then the list made from it (after Meta has read the file); a name that exists is refused (Meta replaces a
 * same-name list); a replace changes the list for everyone using it and keeps what it held for undo when it can; shares
 * name the business that gets access; the chosen ad account only; anything that unblocks something while a campaign
 * delivers is SPENDS MONEY; a delete only once unshared and unapplied. Made-up ids.
 */
import { describe, expect, it, vi } from 'vitest'
import { blockListDraft, entriesOf, removeBlockListDraft, type BlockListLive } from './change-block-lists.js'
import type { MetaChangeDraft, MetaChangeRequest } from './change-draft.js'
import type { MetaChangeResult } from './write-client.js'

const ACCOUNT = '1234567890'
const PORTFOLIO = '9876543210'
const LIST = '120000000000601'
const CBL = '120000000000701'
const base: BlockListLive = { adAccountId: ACCOUNT, portfolio: PORTFOLIO, delivering: true }
const list = { blockListId: LIST, name: 'List A', items: 2, ownerAdAccountId: ACCOUNT, ownerBusinessId: null }
const draftOf = (d: MetaChangeDraft | { refusal: string }) => { if ('refusal' in d) throw new Error(d.refusal); return d }
const wait = vi.fn(async () => undefined)
const done = (node: Record<string, unknown>) => [{ request: { step: 1 } as MetaChangeRequest, result: { node, readBack: 'second-read', waitedMs: 0 } as MetaChangeResult }]

describe('create and replace (BS-005–008)', () => {
  it('create: the file as a draft (Nexus writes it), then the list from it once Meta read it; nothing spends', async () => {
    const d = draftOf(blockListDraft({ action: 'create', name: 'List B', urls: ['Example.com', 'https://www.facebook.com/a-page'] }, { ...base, accountLists: [{ blockListId: LIST, name: 'List A' }] }, wait))
    expect(d.requests.map((r) => [r.step, r.objectKind, r.objectId, r.edge, r.params, r.grant])).toEqual([
      [1, 'business', PORTFOLIO, 'block_list_drafts', {}, 'block_list_management_v2_api_access'],
      [2, 'business', PORTFOLIO, 'publisher_block_lists', { name: 'List B' }, 'block_list_management_v2_api_access'],
    ])
    expect(d.requests[0].file).toBe('example.com\nhttps://www.facebook.com/a-page')
    expect(d.requests.every((r) => r.check === 'none' && !r.raisesSpend)).toBe(true)
    expect(d.spendsMoney).toEqual([])
    expect(await d.requests[1].prepare!(done({ id: '120000000000801', async_job_status: 'scheduled' }))).toEqual({ draft_id: '120000000000801' })
    expect(wait).toHaveBeenCalledWith('120000000000801')
    await expect(d.requests[1].prepare!(done({}))).rejects.toThrow(/gave no id/)
    // Review B8 — step 1 refused: said so, nothing more sent.
    await expect(d.requests[1].prepare!([])).rejects.toThrow(/^Not sent: step 1 \(the upload of the file as a draft\) was not made, so nothing more was sent\.$/)
    // Review A3 — Meta may replace a same-name list the ad account cannot see: said, and the create has no undo.
    expect(d.warnings.join(' ')).toMatch(/Meta REPLACES a list of the same name .* Nexus cannot undo this create/)
    expect(d.after).toEqual({ action: 'create', name: 'List B', urls: ['example.com', 'https://www.facebook.com/a-page'] })
  })
  it('create refused in words: a name that exists (Meta would REPLACE it), no URLs, an entry Nexus will not write', () => {
    expect(blockListDraft({ action: 'create', name: 'List A', urls: ['example.com'] }, { ...base, accountLists: [{ blockListId: LIST, name: 'List A' }] }, wait)).toEqual({ refusal: expect.stringMatching(/Meta REPLACES a list of the same name/) })
    expect(blockListDraft({ action: 'create', name: 'List B' }, base, wait)).toEqual({ refusal: expect.stringMatching(/Name the hosts or URLs/) })
    expect(blockListDraft({ action: 'create', name: 'List B', urls: ['http://example.com'] }, base, wait)).toEqual({ refusal: expect.stringMatching(/plain hosts or https URLs/) })
    expect(blockListDraft({ action: 'create', name: 'List B', urls: ['example.com'] }, { ...base, portfolio: null }, wait)).toEqual({ refusal: expect.stringMatching(/names no business portfolio/) })
  })
  it('replace: the same list from a new draft; what it held is kept for undo; unblocking while a campaign delivers = SPENDS MONEY', () => {
    const live: BlockListLive = { ...base, list, contents: { web: ['example.com'], app: ['https://play.google.com/store/apps/details?id=com.example.app'], total: 2, cut: false, bad: 0 } }
    const d = draftOf(blockListDraft({ action: 'replace', blockListId: LIST, urls: ['example.com', 'example.org'] }, live, wait))
    expect(d.requests[1]).toMatchObject({ params: { name: 'List A', block_list_id: LIST }, raisesSpend: true, operation: 'blockList.replace' })
    expect(d.spendsMoney[0]).toMatch(/unblocks 1 host or URL it held/)
    expect(d.warnings.join(' ')).toMatch(/changes it for EVERY ad account and business that uses it/)
    expect(d.before).toEqual({ action: 'replace', blockListId: LIST, name: 'List A', urls: ['example.com', 'https://play.google.com/store/apps/details?id=com.example.app'] })
    // Review A3 — a new name may not be another list's (Meta would replace that one too); its own name is fine.
    expect(blockListDraft({ action: 'replace', blockListId: LIST, name: 'List B', urls: ['example.com'] }, { ...live, accountLists: [{ blockListId: LIST, name: 'List A' }, { blockListId: '120000000000602', name: 'List B' }] }, wait)).toEqual({ refusal: expect.stringMatching(/Another block list is named "List B"/) })
    expect(draftOf(blockListDraft({ action: 'replace', blockListId: LIST, name: 'List A', urls: ['example.com'] }, { ...live, accountLists: [{ blockListId: LIST, name: 'List A' }] }, wait)).requests).toHaveLength(2)
    const adds = draftOf(blockListDraft({ action: 'replace', blockListId: LIST, urls: ['example.com', 'https://play.google.com/store/apps/details?id=com.example.app', 'example.net'] }, live, wait))
    expect(adds.spendsMoney).toEqual([])
    // Not all of it read: undo cannot put it back (said), and it may unblock something.
    const cut = draftOf(blockListDraft({ action: 'replace', blockListId: LIST, urls: ['example.com'] }, { ...live, list: { ...list, items: 900 } }, wait))
    expect(cut.before).toMatchObject({ urls: null, urlsWhy: expect.stringMatching(/held 900 entries/) })
    expect(cut.warnings.join(' ')).toMatch(/Undo cannot put the list back/)
    expect(cut.spendsMoney[0]).toMatch(/may unblock hosts or URLs/)
  })
  it('the entries Meta answers (web domain_url, app store_url) as Nexus writes them; one it cannot is counted', () => {
    expect(entriesOf([{ url: 'www.facebook.com/a-page' }, { url: 'Example.com' }], [{ store_url: 'https://apps.apple.com/app/id123' }, { store_url: 'not a url' }])).toEqual({ web: ['https://www.facebook.com/a-page', 'example.com'], app: ['https://apps.apple.com/app/id123'], bad: 1 })
  })
})

describe('the other publisher block-list actions', () => {
  it('create-account-list (BS-011): an empty list on act_<id>; Meta documents no way to fill it there (said)', () => {
    const d = draftOf(blockListDraft({ action: 'create-account-list', name: 'List C' }, { ...base, accountLists: [] }, wait))
    expect(d.requests[0]).toMatchObject({ objectKind: 'adaccount', objectId: `act_${ACCOUNT}`, edge: 'publisher_block_lists', params: { name: 'List C' } })
    expect(d.warnings.join(' ')).toMatch(/documents no way to fill a list/)
  })
  it('share / unshare (BS-013 / BS-014): the business that gets access is named; MANAGE warned; already shared or not shared refused', () => {
    const live: BlockListLive = { ...base, list, sharedWith: ['5550000003'] }
    const share = draftOf(blockListDraft({ action: 'share', blockListId: LIST, agencyId: '5550000002', role: 'MANAGE_BLOCK_LIST' }, live, wait))
    expect(share.requests[0]).toMatchObject({ edge: 'agencies', params: { agency_id: '5550000002', permitted_roles: '["MANAGE_BLOCK_LIST"]' }, readBackOf: `${LIST}/agencies`, readBackFields: 'id' })
    expect(share.warnings.join(' ')).toMatch(/Business portfolio 5550000002 gets MANAGE_BLOCK_LIST: it may apply the list AND replace its contents/)
    expect(share.requests[0].judge!({ data: [{ id: '5550000002' }] })).toEqual({ moved: [], reads: 'its shares lists 5550000002' })
    expect(share.requests[0].judge!({ data: [] }).moved).toEqual(['its shares'])
    expect(blockListDraft({ action: 'share', blockListId: LIST, agencyId: '5550000003', role: 'APPLY_BLOCK_LIST' }, live, wait)).toEqual({ refusal: expect.stringMatching(/already shared .* unshare it first/) })
    expect(blockListDraft({ action: 'share', blockListId: LIST, agencyId: '5550000002' }, live, wait)).toEqual({ refusal: expect.stringMatching(/Say the role/) })
    const unshare = draftOf(blockListDraft({ action: 'unshare', blockListId: LIST, agencyId: '5550000003' }, live, wait))
    expect(unshare.requests[0]).toMatchObject({ method: 'DELETE', params: { agency_id: '5550000003' } })
    expect(unshare.warnings.join(' ')).toMatch(/undo shares it again as APPLY_BLOCK_LIST/)
    expect(blockListDraft({ action: 'unshare', blockListId: LIST, agencyId: '5550000002' }, live, wait)).toEqual({ refusal: expect.stringMatching(/not shared with/) })
    expect(blockListDraft({ action: 'share', blockListId: LIST, agencyId: '5550000002', role: 'APPLY_BLOCK_LIST' }, { ...base, list, sharedWith: null, sharedWithNotRead: 'Meta refused' }, wait)).toEqual({ refusal: expect.stringMatching(/could not read who/) })
  })
  it('assign-user / unassign-user (BS-016 / BS-017): the person\'s id and role; the old role kept for undo', () => {
    const live: BlockListLive = { ...base, list, people: [{ userId: '100000000000002', roles: ['APPLY_BLOCK_LIST'] }] }
    const assign = draftOf(blockListDraft({ action: 'assign-user', blockListId: LIST, userId: '100000000000001', role: 'APPLY_BLOCK_LIST' }, live, wait))
    expect(assign.requests[0]).toMatchObject({ edge: 'assigned_users', params: { user: '100000000000001', permitted_roles: '["APPLY_BLOCK_LIST"]' } })
    expect(assign.changes).toEqual({ 'publisher block list "List A" (120000000000601): person 100000000000001': { from: 'no role', to: 'APPLY_BLOCK_LIST' } })
    const unassign = draftOf(blockListDraft({ action: 'unassign-user', blockListId: LIST, userId: '100000000000002' }, live, wait))
    expect(unassign.requests[0]).toMatchObject({ method: 'DELETE', params: { user: '100000000000002' } })
    expect(unassign.before).toMatchObject({ role: 'APPLY_BLOCK_LIST' })
    expect(blockListDraft({ action: 'assign-user', blockListId: LIST, userId: '100000000000002', role: 'MANAGE_BLOCK_LIST' }, live, wait)).toEqual({ refusal: expect.stringMatching(/already has a role/) })
    expect(blockListDraft({ action: 'unassign-user', blockListId: LIST, userId: '100000000000003' }, live, wait)).toEqual({ refusal: expect.stringMatching(/has no role/) })
  })
  it('apply-account / unapply-account (BS-019 / BS-020): the chosen ad account only; business_id only for a list the portfolio owns; unapplying = SPENDS MONEY', () => {
    const owned: BlockListLive = { ...base, list: { ...list, ownerAdAccountId: null, ownerBusinessId: PORTFOLIO }, appliedTo: [] }
    const apply = draftOf(blockListDraft({ action: 'apply-account', blockListId: LIST }, owned, wait))
    expect(apply.requests[0]).toMatchObject({ edge: 'auto_applied_ad_accounts', params: { account_id: ACCOUNT, is_auto_blocking_on: 'true', business_id: PORTFOLIO }, raisesSpend: false })
    expect(apply.spendsMoney).toEqual([])
    const accountOwned = draftOf(blockListDraft({ action: 'apply-account', blockListId: LIST }, { ...base, list, appliedTo: [] }, wait))
    expect(accountOwned.requests[0].params).toEqual({ account_id: ACCOUNT, is_auto_blocking_on: 'true' })
    const unapply = draftOf(blockListDraft({ action: 'unapply-account', blockListId: LIST }, { ...base, list, appliedTo: [ACCOUNT] }, wait))
    expect(unapply.requests[0]).toMatchObject({ params: { account_id: ACCOUNT, is_auto_blocking_on: 'false' }, raisesSpend: true })
    expect(unapply.spendsMoney[0]).toMatch(/unblocks what it lists for every campaign of the account/)
    expect(blockListDraft({ action: 'apply-account', blockListId: LIST }, { ...base, list, appliedTo: [ACCOUNT] }, wait)).toEqual({ refusal: expect.stringMatching(/already applied/) })
  })
})

describe('content block lists (BS-022, BS-025, BS-028, BS-029, BS-031, BS-032)', () => {
  const content: BlockListLive = { ...base, contentList: { contentBlockListId: CBL, name: 'Posts A' }, appliedTo: [ACCOUNT] }
  it('create (a name that exists refused), rename (read back by its name)', () => {
    expect(draftOf(blockListDraft({ action: 'create-content-list', name: 'Posts B' }, { ...base, contentLists: [] }, wait)).requests[0]).toMatchObject({ objectKind: 'business', objectId: PORTFOLIO, edge: 'content_block_lists', params: { name: 'Posts B' }, grant: 'brand_safety_content_block_list' })
    expect(blockListDraft({ action: 'create-content-list', name: 'Posts A' }, { ...base, contentLists: [{ contentBlockListId: CBL, name: 'Posts A' }] }, wait)).toEqual({ refusal: expect.stringMatching(/exists/) })
    const rename = draftOf(blockListDraft({ action: 'rename-content-list', contentBlockListId: CBL, name: 'Posts C' }, content, wait))
    expect(rename.requests[0]).toMatchObject({ objectKind: 'contentblocklist', objectId: CBL, params: { name: 'Posts C' }, expect: { name: 'Posts C' }, readBackFields: 'id,name' })
    expect(rename.before).toMatchObject({ name: 'Posts A' })
  })
  it('posts: at most 250 per platform, as JSON lists; removing them from a list applied to the account = SPENDS MONEY; undo warned', () => {
    const add = draftOf(blockListDraft({ action: 'add-posts', contentBlockListId: CBL, facebookIds: ['120000000000901_120000000000902'], instagramIds: ['17800000000000001'] }, content, wait))
    expect(add.requests[0]).toMatchObject({ edge: 'content', params: { facebook_ids: '["120000000000901_120000000000902"]', instagram_ids: '["17800000000000001"]' }, raisesSpend: false })
    expect(add.requests[0].method).toBeUndefined()
    expect(add.warnings.join(' ')).toMatch(/root post's id/)
    const remove = draftOf(blockListDraft({ action: 'remove-posts', contentBlockListId: CBL, threadsIds: ['17900000000000001'] }, content, wait))
    expect(remove.requests[0]).toMatchObject({ method: 'DELETE', params: { threads_ids: '["17900000000000001"]' }, raisesSpend: true })
    expect(remove.spendsMoney[0]).toMatch(/show next to them again/)
    expect(draftOf(blockListDraft({ action: 'remove-posts', contentBlockListId: CBL, threadsIds: ['17900000000000001'] }, { ...content, appliedTo: [] }, wait)).spendsMoney).toEqual([])
    expect(blockListDraft({ action: 'add-posts', contentBlockListId: CBL }, content, wait)).toEqual({ refusal: expect.stringMatching(/Name the posts/) })
  })
  it('apply / unapply on the chosen ad account (Meta: 75 per account); unapplying = SPENDS MONEY', () => {
    const apply = draftOf(blockListDraft({ action: 'apply-content-list', contentBlockListId: CBL }, { ...content, appliedTo: [] }, wait))
    expect(apply.requests[0]).toMatchObject({ edge: 'applied_ad_accounts', params: { account_id: ACCOUNT }, readBackOf: `${CBL}/applied_ad_accounts` })
    expect(apply.warnings.join(' ')).toMatch(/at most 75/)
    expect(apply.requests[0].judge!({ data: [{ id: ACCOUNT, account_id: `act_${ACCOUNT}` }] }).moved).toEqual([])
    const unapply = draftOf(blockListDraft({ action: 'unapply-content-list', contentBlockListId: CBL }, content, wait))
    expect(unapply.requests[0]).toMatchObject({ method: 'DELETE', raisesSpend: true })
    expect(unapply.spendsMoney).toHaveLength(1)
  })
})

describe('remove-meta-block-list (BS-012, BS-026)', () => {
  it('a publisher list only once shared with no business and applied to no ad account; deleting it = SPENDS MONEY while a campaign delivers', () => {
    expect(removeBlockListDraft({ kind: 'publisher', id: LIST }, { ...base, list, sharedWith: ['5550000002'], appliedTo: [] })).toEqual({ refusal: expect.stringMatching(/still shared .* unshare first/) })
    expect(removeBlockListDraft({ kind: 'publisher', id: LIST }, { ...base, list, sharedWith: [], appliedTo: [ACCOUNT] })).toEqual({ refusal: expect.stringMatching(/still applied .* unapply-account/) })
    expect(removeBlockListDraft({ kind: 'publisher', id: LIST }, { ...base, list, sharedWith: null, appliedTo: [] })).toEqual({ refusal: expect.stringMatching(/could not read who/) })
    const d = draftOf(removeBlockListDraft({ kind: 'publisher', id: LIST }, { ...base, list, sharedWith: [], appliedTo: [] }))
    expect(d.requests[0]).toMatchObject({ objectKind: 'publisherblocklist', objectId: LIST, method: 'DELETE', params: {}, undoable: false, raisesSpend: true })
    expect(d.warnings.join(' ')).toMatch(/cannot come back/)
  })
  it('a content list only when applied to no ad account', () => {
    expect(removeBlockListDraft({ kind: 'content', id: CBL }, { ...base, contentList: { contentBlockListId: CBL, name: 'Posts A' }, appliedTo: [ACCOUNT] })).toEqual({ refusal: expect.stringMatching(/applied to none/) })
    const d = draftOf(removeBlockListDraft({ kind: 'content', id: CBL }, { ...base, contentList: { contentBlockListId: CBL, name: 'Posts A' }, appliedTo: [] }))
    expect(d.requests[0]).toMatchObject({ objectKind: 'contentblocklist', method: 'DELETE', raisesSpend: false })
  })
})
