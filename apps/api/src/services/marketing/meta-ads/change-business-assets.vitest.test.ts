/**
 * Meta ads step 43 — the drafts of create-meta-backed-account and set-meta-billing, pure: one request each, its exact path,
 * kind and keys; refused (nothing queued) when it would do nothing or when Nexus cannot tell; money said plainly; the
 * floors (only the chosen ad account, the portfolio's own credit line, no group that bills another business, only an empty
 * group deleted, confirmDelete). Made-up ids and names.
 */
import { describe, expect, it } from 'vitest'
import { BACKED_NO_UNDO, NO_CREDIT_LINE, backedDraft, billingDraft, madeIdOf, type BillingLive, type InvoiceGroupNow } from './change-business-assets.js'
import type { MetaChangeDraft } from './change-draft.js'

const PAGE = '120000000000010'
const IG = '17840000000000001'
const ACCOUNT = '1234567890'
const LINE = '120000000000300'
const GROUP_A = '120000000000310'
const GROUP_B = '120000000000311'

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
  it('Threads: on the chosen Instagram account or Page; a Page-backed one without a Page-backed Instagram account is warned; a linked one is named', () => {
    const ig = ok(backedDraft({ kind: 'threads-for-instagram', objectId: IG, existing: { id: null }, linkedThreads: '900000000000001' }))
    expect(ig.requests[0]).toMatchObject({ objectId: IG, objectKind: 'backedinstagram', edge: 'instagram_backed_threads_user' })
    expect(ig.warnings.join(' ')).toMatch(/already has a linked Threads account \(900000000000001\)/)
    const page = ok(backedDraft({ kind: 'threads-for-page', objectId: PAGE, existing: { id: null }, pageBackedInstagram: null }))
    expect(page.requests[0]).toMatchObject({ objectId: PAGE, objectKind: 'backedpage', edge: 'page_backed_threads_accounts' })
    expect(page.warnings.join(' ')).toMatch(/You should only use a Page-backed Threads account when you are using a Page-backed Instagram account/)
    expect(page.warnings.join(' ')).toMatch(/has no Page-backed Instagram account yet/)
    expect(ok(backedDraft({ kind: 'threads-for-page', objectId: PAGE, existing: { id: null }, pageBackedInstagram: '17840000000000050' })).warnings.join(' ')).not.toMatch(/has no Page-backed Instagram account yet/)
  })
  it('the made id from Meta\'s answer: id or threads_user_id, digits only', () => {
    expect(madeIdOf({ node: { id: '17840000000000099' } })).toBe('17840000000000099')
    expect(madeIdOf({ node: { threads_user_id: 900000000000002 } })).toBe('900000000000002')
    expect(madeIdOf({ node: { id: 'act_1' } })).toBeNull()
    expect(madeIdOf({ node: null })).toBeNull()
  })
})

describe('set-meta-billing drafts (BM-903 … BM-907)', () => {
  const group = (over: Partial<InvoiceGroupNow> = {}): InvoiceGroupNow => ({ groupId: GROUP_A, creditLineId: LINE, name: 'Group A', adAccountIds: [], accountsMore: false, takenAccounts: [], ...over })
  const live = (groups: InvoiceGroupNow[] = [group()], over: Partial<BillingLive> = {}): BillingLive => ({ portfolioId: '9876543210', adAccountId: ACCOUNT, creditLines: [LINE], foreignLines: 0, groups, groupsUnsure: null, ...over })

  it('no credit line of its own: nothing to change (a shared-in line is that portfolio\'s)', () => {
    expect(no(billingDraft({ action: 'create-group', name: 'Group B' }, live([], { creditLines: [] })))).toBe(NO_CREDIT_LINE)
    expect(no(billingDraft({ action: 'create-group', name: 'Group B' }, live([], { creditLines: [], foreignLines: 1 })))).toMatch(/shares into this one is that portfolio's/)
  })
  it('create-group: on the only line by default, its name only (never e-mails), read back by its name, undo deletes it', () => {
    const d = ok(billingDraft({ action: 'create-group', name: 'Group B' }, live()))
    expect(d.requests[0]).toMatchObject({ objectId: LINE, objectKind: 'creditline', edge: 'extended_credit_invoice_groups', params: { name: 'Group B' }, expect: { name: 'Group B' }, readBackFields: 'id,name', recordEvenIfNotAsAsked: true, undoable: true })
    expect(Object.keys(d.requests[0].params)).toEqual(['name'])
    expect(d.warnings.join(' ')).toMatch(/never takes or reads an invoice group's e-mail addresses/)
    expect(d.after).toMatchObject({ op: 'create-group', creditLineId: LINE, exists: true })
    expect(no(billingDraft({ action: 'create-group', name: 'Group A' }, live()))).toMatch(/named "Group A" already/)
    expect(no(billingDraft({ action: 'create-group', name: 'Group B' }, live([], { creditLines: [LINE, '120000000000301'] })))).toMatch(/2 credit lines of its own: name the one/)
    expect(no(billingDraft({ action: 'create-group', name: 'Group B', creditLineId: '120000000000399' }, live()))).toMatch(/not one the business portfolio owns/)
    expect(no(billingDraft({ action: 'create-group', name: 'Group B' }, live([group()], { groupsUnsure: 'Meta did not answer' })))).toMatch(/could not read the credit line's invoice groups in full/)
    expect(no(billingDraft({ action: 'create-group', name: 'Group B', invoiceGroupId: GROUP_A }, live()))).toMatch(/invoiceGroupId is not an argument of action create-group/)
  })
  it('rename-group: the old name kept for undo; same name, a group Nexus cannot read in full or one that bills another business: refused', () => {
    const d = ok(billingDraft({ action: 'rename-group', invoiceGroupId: GROUP_A, name: 'Group C' }, live()))
    expect(d.requests[0]).toMatchObject({ objectId: GROUP_A, objectKind: 'invoicegroup', params: { name: 'Group C' }, expect: { name: 'Group C' } })
    expect(d.requests[0].edge).toBeUndefined()
    expect(d.before).toMatchObject({ name: 'Group A' })
    expect(no(billingDraft({ action: 'rename-group', invoiceGroupId: GROUP_A, name: 'Group A' }, live()))).toMatch(/nothing to change/)
    expect(no(billingDraft({ action: 'rename-group', invoiceGroupId: GROUP_A, name: 'Group C' }, live([group({ adAccountIds: null })])))).toMatch(/could not read every ad account/)
    expect(no(billingDraft({ action: 'rename-group', invoiceGroupId: GROUP_A, name: 'Group C' }, live([group({ adAccountIds: ['1234567891'], takenAccounts: ['1234567891'] })])))).toMatch(/another business in Nexus uses \(act_1234567891\)/)
    expect(no(billingDraft({ action: 'rename-group', invoiceGroupId: '120000000000399', name: 'Group C' }, live()))).toMatch(/is not an invoice group of the business portfolio's own credit line/)
  })
  it('add-account: the CHOSEN ad account, from the group that billed it; BILLING said plainly; read back from the group; undo moves it back', () => {
    const groups = [group({ groupId: GROUP_A, name: 'Group A', adAccountIds: [ACCOUNT] }), group({ groupId: GROUP_B, name: 'Group B', adAccountIds: [] })]
    const d = ok(billingDraft({ action: 'add-account', invoiceGroupId: GROUP_B }, live(groups)))
    expect(d.requests[0]).toMatchObject({ objectId: GROUP_B, objectKind: 'invoicegroup', edge: 'ad_accounts', params: { ad_account_id: 'act_1234567890' }, readBackOf: `${GROUP_B}/ad_accounts`, readBackFields: 'account_id', raisesSpend: false })
    expect(d.requests[0].method).toBeUndefined()
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings[0]).toMatch(/^BILLING \(money, your decision\): from now on the spend of ad account act_1234567890 is billed on the monthly invoice of invoice group "Group B" .* instead of invoice group "Group A"/)
    expect(d.after).toMatchObject({ op: 'add-account', groupId: GROUP_B, adAccountId: ACCOUNT, inGroup: true, previousGroupId: GROUP_A })
    const judge = d.requests[0].judge!
    expect(judge({ data: [{ account_id: ACCOUNT }] })).toEqual({ moved: [], reads: `act_${ACCOUNT} in invoice group "Group B" (${GROUP_B})` })
    expect(judge({ data: [] }).moved).toEqual(['ad_accounts'])
    expect(judge({ id: GROUP_B }).moved).toEqual(['ad_accounts'])
    expect(no(billingDraft({ action: 'add-account', invoiceGroupId: GROUP_A }, live(groups)))).toMatch(/bills the chosen ad account act_1234567890 already/)
    // Where it is billed now must be known (else the undo could not put it back).
    expect(no(billingDraft({ action: 'add-account', invoiceGroupId: GROUP_B }, live([groups[0], { ...groups[1] }, group({ groupId: '120000000000312', adAccountIds: null })])))).toMatch(/could not read every ad account|cannot tell where/)
    expect(no(billingDraft({ action: 'add-account', invoiceGroupId: GROUP_B }, live(groups, { groupsUnsure: 'more groups than Nexus reads' })))).toMatch(/cannot tell where act_1234567890 is billed now/)
  })
  it('remove-account: a DELETE with ad_account_id, judged gone; refused when the group does not bill it', () => {
    const d = ok(billingDraft({ action: 'remove-account', invoiceGroupId: GROUP_A }, live([group({ adAccountIds: [ACCOUNT] })])))
    expect(d.requests[0]).toMatchObject({ method: 'DELETE', edge: 'ad_accounts', params: { ad_account_id: 'act_1234567890' } })
    expect(d.requests[0].judge!({ data: [] })).toMatchObject({ moved: [] })
    expect(d.warnings[0]).toMatch(/^BILLING \(money, your decision\): ad account act_1234567890's spend is no longer billed/)
    expect(d.requests[0].explain!['49002']).toMatch(/49002/)
    expect(no(billingDraft({ action: 'remove-account', invoiceGroupId: GROUP_A }, live()))).toMatch(/does not bill the chosen ad account/)
  })
  it('delete-group: only on confirmDelete, only an empty group; a DELETE with no body; no undo', () => {
    expect(no(billingDraft({ action: 'delete-group', invoiceGroupId: GROUP_A }, live()))).toMatch(/takes confirmDelete: true/)
    expect(no(billingDraft({ action: 'delete-group', invoiceGroupId: GROUP_A, confirmDelete: true }, live([group({ adAccountIds: [ACCOUNT] })])))).toMatch(/still bills 1 ad account \(act_1234567890\)/)
    const d = ok(billingDraft({ action: 'delete-group', invoiceGroupId: GROUP_A, confirmDelete: true }, live()))
    expect(d.requests[0]).toMatchObject({ method: 'DELETE', objectId: GROUP_A, objectKind: 'invoicegroup', params: {}, undoable: false })
    expect(d.requests[0].edge).toBeUndefined()
    expect(d.warnings[0]).toMatch(/^No undo/)
  })
})
