/**
 * Meta step 41 — the people and partner access drafts (pure): the leader's hard floors in words before Meta is called
 * (the last admin, Nexus's own system user, only people and partners named and of the portfolio, never another Nexus
 * business's), step 40's disabled-account rule, the exact request (form fields in Nexus's one spelling), the from → to
 * line, the Full access tier named, the records undo reads, and the read-back judges. Made-up ids and names only.
 */
import { describe, expect, it } from 'vitest'
import { ACCESS_EXPLAIN, ACCESS_EXPLAIN_PAGE, metaUndoTasks, partnerAccessDraft, partnerReadBack, PIXEL_NO_REMOVE, serverEventsDraft, tierWarning, userAccessDraft, userReadBack, type PartnerAccessLive, type ServerEventsLive, type UserAccessLive } from './change-access.js'
import type { MetaChangeDraft } from './change-draft.js'

const PORTFOLIO = '9876543210'
const ME = '120000000000001'
const PERSON = '120000000000002'
const OWNER = '120000000000003'
const OTHER_SYSTEM_USER = '120000000000004'
const PARTNER = '120000000000070'
const STATE = { adAccountId: '1234567890', name: 'Shop A ads', status: 1, disableReason: 0, portfolioId: PORTFOLIO, tier: 'development_access' }
const ACCOUNT_ASSET = { asset: 'ad-account' as const, nodeId: 'act_1234567890', label: 'ad account 1234567890 ("Shop A ads")' }

const userLive = (over: Partial<UserAccessLive> = {}): UserAccessLive => ({
  state: { ...STATE }, portfolioId: PORTFOLIO, portfolioShared: false, nexusSystemUserId: ME, asset: ACCOUNT_ASSET,
  assigned: new Map([
    [OWNER, { id: OWNER, name: 'Person B', tasks: ['ADVERTISE', 'ANALYZE', 'MANAGE'] }],
    [PERSON, { id: PERSON, name: 'Person A', tasks: ['ANALYZE'] }],
    [ME, { id: ME, name: 'Nexus', tasks: ['ADVERTISE', 'ANALYZE', 'MANAGE'] }],
  ]),
  assignedMore: false,
  people: new Map([[PERSON, { name: 'Person A', kind: 'person' as const }], [OWNER, { name: 'Person B', kind: 'person' as const }], [ME, { name: 'Nexus', kind: 'system user' as const }], [OTHER_SYSTEM_USER, { name: 'Tool B', kind: 'system user' as const }]]),
  peopleMore: false,
  ...over,
})
const drafted = (d: MetaChangeDraft | { refusal: string }) => { if ('refusal' in d) throw new Error(d.refusal); return d }
const refusal = (d: MetaChangeDraft | { refusal: string }) => ('refusal' in d ? d.refusal : null)

describe('userAccessDraft', () => {
  it('a person of the portfolio gets tasks on the chosen ad account: one POST, the tasks as Nexus writes them, ADVERTISE said, the tier named', () => {
    const d = drafted(userAccessDraft({ asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['ANALYZE', 'ADVERTISE'] }, userLive()))
    expect(d.requests).toHaveLength(1)
    expect(d.requests[0]).toMatchObject({
      objectId: 'act_1234567890', objectKind: 'accessadaccount', edge: 'assigned_users', operation: 'access.accessadaccount.user.set',
      params: { user: PERSON, tasks: '["ADVERTISE","ANALYZE"]' }, check: 'none', raisesSpend: false, undoable: true, explain: ACCESS_EXPLAIN,
    })
    expect(d.requests[0].method).toBeUndefined()
    expect(d.summary).toBe('Change person "Person A" (120000000000002) to ADVERTISE, ANALYZE on ad account 1234567890 ("Shop A ads")')
    expect(Object.values(d.changes)[0]).toEqual({ from: 'ANALYZE', to: expect.stringMatching(/^ADVERTISE \(create and edit ads that spend/) })
    expect(d.warnings.join(' ')).toMatch(/ADVERTISE lets person "Person A" .* spend its money/)
    expect(d.warnings.join(' ')).toMatch(/development_access \(Limited\) .* most likely refuse/)
    expect(d.spendsMoney).toEqual([])
    expect(d.before).toEqual({ op: 'set', asset: 'ad-account', nodeId: 'act_1234567890', personId: PERSON, assigned: true, tasks: ['ANALYZE'] })
    expect(d.after).toEqual({ op: 'set', asset: 'ad-account', nodeId: 'act_1234567890', personId: PERSON, assigned: true, tasks: ['ADVERTISE', 'ANALYZE'] })
  })
  it('the hard floors: never Nexus\'s own system user, never someone outside the portfolio, never the last admin', () => {
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'set', personId: ME, tasks: ['ANALYZE'] }, userLive()))).toMatch(/Nexus's own system user/)
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'remove', personId: ME }, userLive()))).toMatch(/Nexus's own system user/)
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['ANALYZE'] }, userLive({ nexusSystemUserId: null })))).toMatch(/could not read which system user/)
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'set', personId: '120000000000099', tasks: ['ANALYZE'] }, userLive()))).toMatch(/not a person or system user of the ad account's business portfolio/)
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'remove', personId: OWNER }, userLive()))).toMatch(/last person who is an admin/)
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'set', personId: OWNER, tasks: ['ANALYZE'] }, userLive()))).toMatch(/never removes or lowers the last admin/)
    // Another PERSON admin makes the change possible; Nexus's own system user never counts as one.
    const two = userLive()
    two.assigned.set(PERSON, { id: PERSON, name: 'Person A', tasks: ['MANAGE'] })
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'remove', personId: OWNER, }, two))).toBeNull()
    // Every row is read, or nothing is changed.
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'remove', personId: PERSON }, userLive({ assignedMore: true })))).toMatch(/more people hold tasks/i)
  })
  it('a portfolio another Nexus business uses (or one Nexus cannot tell): no system user is given access; a person still may', () => {
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'set', personId: OTHER_SYSTEM_USER, tasks: ['ANALYZE'] }, userLive()))).toBeNull()
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'set', personId: OTHER_SYSTEM_USER, tasks: ['ANALYZE'] }, userLive({ portfolioShared: true })))).toMatch(/cannot tell whose system user/)
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'set', personId: OTHER_SYSTEM_USER, tasks: ['ANALYZE'] }, userLive({ portfolioShared: null })))).toMatch(/could not tell that none does/)
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['ADVERTISE', 'ANALYZE'] }, userLive({ portfolioShared: true })))).toBeNull()
  })
  it('a removal: DELETE with the user only; making an admin is said; the same tasks again changes nothing', () => {
    const d = drafted(userAccessDraft({ asset: 'ad-account', action: 'remove', personId: PERSON }, userLive()))
    expect(d.requests[0]).toMatchObject({ method: 'DELETE', params: { user: PERSON }, operation: 'access.accessadaccount.user.remove' })
    expect(d.after).toMatchObject({ assigned: false, tasks: null })
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'remove', personId: OTHER_SYSTEM_USER }, userLive()))).toMatch(/holds no task/)
    const admin = drafted(userAccessDraft({ asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['MANAGE', 'ADVERTISE', 'ANALYZE'] }, userLive()))
    expect(admin.warnings[0]).toMatch(/makes person "Person A" .* an ADMIN .* payment methods/)
    const same = drafted(userAccessDraft({ asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['ANALYZE'] }, userLive()))
    expect(same.requests).toEqual([])
    expect(same.skipped[0]).toMatch(/exactly these tasks/)
  })
  it('the Page and the Instagram asset: their owner sent with the user; the asset\'s own tasks only', () => {
    const page = { asset: 'page' as const, nodeId: '120000000000080', label: 'Facebook Page 120000000000080' }
    const d = drafted(userAccessDraft({ asset: 'page', action: 'set', personId: PERSON, tasks: ['ADVERTISE', 'ANALYZE'] }, userLive({ asset: page, assigned: new Map([[OWNER, { id: OWNER, name: null, tasks: ['MANAGE'] }]]) })))
    expect(d.requests[0]).toMatchObject({ objectId: '120000000000080', objectKind: 'accesspage', params: { user: PERSON, tasks: '["ADVERTISE","ANALYZE"]', business: PORTFOLIO } })
    expect(d.warnings.join(' ')).toMatch(/Page token/)
    expect(refusal(userAccessDraft({ asset: 'page', action: 'set', personId: PERSON, tasks: ['CONTENT'] }, userLive({ asset: page })))).toMatch(/CONTENT is no task of a Page/)
    const ig = { asset: 'instagram' as const, nodeId: '120000000000090', label: 'Instagram account (17840000000000001; its business asset 120000000000090)' }
    const i = drafted(userAccessDraft({ asset: 'instagram', action: 'set', personId: PERSON, tasks: ['CONTENT'] }, userLive({ asset: ig, assigned: new Map() })))
    expect(i.requests[0]).toMatchObject({ objectId: '120000000000090', objectKind: 'accessinstagram', params: { business: PORTFOLIO } })
    expect(i.warnings.join(' ')).toMatch(/BUSINESS ASSET/)
  })
  it('review A-MF2 — a target whose tasks Nexus cannot judge counts as an admin: removing or lowering it needs another person admin', () => {
    for (const tasks of [[], ['FULL_CONTROL']]) {
      const live = userLive()
      live.assigned.set(OWNER, { id: OWNER, name: 'Person B', tasks })
      expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'remove', personId: OWNER }, live)), JSON.stringify(tasks)).toMatch(/last person who is an admin/)
      expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'set', personId: OWNER, tasks: ['ANALYZE'] }, live)), JSON.stringify(tasks)).toMatch(/last admin/)
      // Another person with tasks Nexus cannot judge does not count as the admin that stays.
      live.assigned.set(PERSON, { id: PERSON, name: 'Person A', tasks: ['FULL_CONTROL'] })
      expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'remove', personId: OWNER }, live))).toMatch(/last person/)
    }
  })
  it('review B-F4 — an ad account takes only Meta\'s three combinations; Meta\'s unpacked read-back is the same preset', () => {
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['ANALYZE', 'DRAFT'] }, userLive()))).toMatch(/only Meta's task combinations Admin \[ADVERTISE, ANALYZE, MANAGE\], General \[ADVERTISE, ANALYZE\], Reporting \[ANALYZE\]/)
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['MANAGE'] }, userLive()))).toMatch(/1752129/)
    const unpacked = userLive()
    unpacked.assigned.set(PERSON, { id: PERSON, name: 'Person A', tasks: ['ADVERTISE', 'ANALYZE', 'DRAFT'] })
    expect(drafted(userAccessDraft({ asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['ADVERTISE', 'ANALYZE'] }, unpacked)).requests).toEqual([])
    expect(metaUndoTasks('ad-account', ['ADVERTISE', 'ANALYZE', 'DRAFT'])).toEqual(['ADVERTISE', 'ANALYZE'])
    expect(metaUndoTasks('ad-account', ['DRAFT'])).toBeNull()
    expect(metaUndoTasks('page', ['ANALYZE', 'CASHIER_ROLE'])).toBeNull()
    expect(metaUndoTasks('page', [])).toBeNull()
    // A Page takes any of its tasks (no combination rule there).
    const page = { asset: 'page' as const, nodeId: '120000000000080', label: 'Facebook Page 120000000000080' }
    expect(refusal(userAccessDraft({ asset: 'page', action: 'set', personId: PERSON, tasks: ['ANALYZE', 'MODERATE'] }, userLive({ asset: page, assigned: new Map([[OWNER, { id: OWNER, name: null, tasks: ['MANAGE'] }]]) })))).toBeNull()
  })
  it('review A-N2 — a system user is changed only when Nexus\'s own is listed among the portfolio\'s system users', () => {
    const live = userLive()
    live.people.delete(ME)
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'set', personId: OTHER_SYSTEM_USER, tasks: ['ANALYZE'] }, live))).toMatch(/cannot be sure 120000000000004 is not itself/)
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['ADVERTISE', 'ANALYZE'] }, live))).toBeNull()
  })
  it('review A-N4 — the preview says when undo will refuse (a person holding no task, or a list Nexus cannot send back)', () => {
    const live = userLive()
    live.assigned.set(PERSON, { id: PERSON, name: 'Person A', tasks: [] })
    const d = drafted(userAccessDraft({ asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['ANALYZE'] }, live))
    expect(d.warnings.join(' ')).toMatch(/No undo: .* holds assigned, no task, which Nexus cannot send back as it is: undo of this change will refuse/)
    expect(d.before).toMatchObject({ noUndo: [expect.stringMatching(/undo of this change will refuse/)] })
    expect(drafted(userAccessDraft({ asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['ADVERTISE', 'ANALYZE'] }, userLive())).warnings.join(' ')).not.toMatch(/No undo/)
  })
  it('step 40\'s rule: nothing through a disabled or compromised ad account', () => {
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['ANALYZE'] }, userLive({ state: { ...STATE, status: 2 } })))).toMatch(/Nexus changes nothing on an ad account Meta has disabled/)
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'remove', personId: PERSON }, userLive({ state: { ...STATE, status: 1, disableReason: 15 } })))).toMatch(/compromised/i)
    expect(refusal(userAccessDraft({ asset: 'ad-account', action: 'remove', personId: PERSON }, userLive({ state: { ...STATE, status: null } })))).toMatch(/did not say/)
  })
  it('the basis stands on tasks and admins, never on names (a rename does not stale an approval)', () => {
    const a = drafted(userAccessDraft({ asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['ADVERTISE', 'ANALYZE'] }, userLive()))
    const renamed = userLive()
    renamed.people.set(PERSON, { name: 'Person A (new name)', kind: 'person' })
    const b = drafted(userAccessDraft({ asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['ADVERTISE', 'ANALYZE'] }, renamed))
    expect(b.stands).toEqual(a.stands)
    const moved = userLive()
    moved.assigned.set(PERSON, { id: PERSON, name: 'Person A', tasks: ['ADVERTISE'] })
    expect(drafted(userAccessDraft({ asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['ADVERTISE', 'ANALYZE'] }, moved)).stands).not.toEqual(a.stands)
  })
})

describe('userReadBack', () => {
  it('done when every task asked is held and no admin task came unasked; Meta\'s list lagging is said, not judged', () => {
    expect(userReadBack('ad-account', ['ADVERTISE', 'ANALYZE'], { id: PERSON, name: null, tasks: ['ADVERTISE', 'ANALYZE', 'DRAFT'] })).toEqual({ moved: [], reads: 'tasks ADVERTISE, ANALYZE, DRAFT' })
    expect(userReadBack('ad-account', ['ANALYZE'], { id: PERSON, name: null, tasks: ['ANALYZE', 'MANAGE'] }).moved).toEqual(['tasks'])
    expect(userReadBack('ad-account', ['ADVERTISE', 'ANALYZE'], { id: PERSON, name: null, tasks: ['ANALYZE'] }).moved).toEqual(['tasks'])
    expect(userReadBack('ad-account', ['ANALYZE'], null)).toMatchObject({ moved: [], reads: expect.stringMatching(/not listed yet/) })
    expect(userReadBack('ad-account', null, { id: PERSON, name: null, tasks: ['ANALYZE'] })).toMatchObject({ moved: [], reads: expect.stringMatching(/still listed/) })
  })
})

const partnerLive = (over: Partial<PartnerAccessLive> = {}): PartnerAccessLive => ({
  state: { ...STATE }, portfolioId: PORTFOLIO, portfolioShared: false, nexusSystemUserId: ME, asset: ACCOUNT_ASSET,
  partners: new Map(), listMore: false, partnerTaken: false, systemUsers: new Set([ME]), sharesTaken: false, clientInstagram: 'ok',
  ...over,
})

describe('partnerAccessDraft', () => {
  it('a share: the partner\'s tasks always sent; SDK only and the tier said; undo takes it back', () => {
    const d = drafted(partnerAccessDraft({ action: 'share', asset: 'ad-account', partnerBusinessId: PARTNER, permittedTasks: ['ANALYZE', 'ADVERTISE'] }, partnerLive()))
    expect(d.requests[0]).toMatchObject({ objectId: 'act_1234567890', objectKind: 'accessadaccount', edge: 'agencies', operation: 'access.accessadaccount.partner.share', params: { business: PARTNER, permitted_tasks: '["ADVERTISE","ANALYZE"]' } })
    expect(d.warnings.join(' ')).toMatch(/names this route .* parameters are in its SDK only.*LIVE-PROBES ST41-03/)
    expect(d.warnings.join(' ')).toMatch(/spend its money/)
    expect(d.warnings.join(' ')).toMatch(/FULL Marketing API access tier/)
    expect(d.after).toEqual({ op: 'share', asset: 'ad-account', nodeId: 'act_1234567890', partnerId: PARTNER, shared: true, tasks: ['ADVERTISE', 'ANALYZE'] })
  })
  it('the floors: never the portfolio itself, never another Nexus business\'s; an existing share is not changed in place', () => {
    expect(refusal(partnerAccessDraft({ action: 'share', asset: 'ad-account', partnerBusinessId: PORTFOLIO, permittedTasks: ['ANALYZE'] }, partnerLive()))).toMatch(/own business portfolio/)
    expect(refusal(partnerAccessDraft({ action: 'share', asset: 'ad-account', partnerBusinessId: PARTNER, permittedTasks: ['ANALYZE'] }, partnerLive({ partnerTaken: true })))).toMatch(/another business in Nexus/)
    const shared = partnerLive({ partners: new Map([[PARTNER, { id: PARTNER, name: 'Agency A', tasks: ['ANALYZE'], accessStatus: 'CONFIRMED', takenByAnotherBusiness: false }]]) })
    expect(refusal(partnerAccessDraft({ action: 'share', asset: 'ad-account', partnerBusinessId: PARTNER, permittedTasks: ['ADVERTISE', 'ANALYZE'] }, shared))).toMatch(/already shared.*most likely be refused as a duplicate.*action remove/)
    // Review B-F3 — a Page already shared: the removal may not work by API, so Business settings.
    const pageAsset = { asset: 'page' as const, nodeId: '120000000000080', label: 'Facebook Page 120000000000080' }
    expect(refusal(partnerAccessDraft({ action: 'share', asset: 'page', partnerBusinessId: PARTNER, permittedTasks: ['ADVERTISE'] }, { ...shared, asset: pageAsset }))).toMatch(/3989.*Business settings › Partners/)
    expect(drafted(partnerAccessDraft({ action: 'share', asset: 'ad-account', partnerBusinessId: PARTNER, permittedTasks: ['ANALYZE'] }, shared)).requests).toEqual([])
  })
  it('review A-SF4 / B-F3 / B-F6 — what a share and a removal say: an admin\'s tasks, the Page\'s DELETE and token, undo\'s re-share', () => {
    const admin = drafted(partnerAccessDraft({ action: 'share', asset: 'ad-account', partnerBusinessId: PARTNER, permittedTasks: ['ADVERTISE', 'ANALYZE', 'MANAGE'] }, partnerLive()))
    expect(admin.warnings.join(' ')).toMatch(/makes business portfolio \(120000000000070\) an ADMIN .* take others' access away, yours too/)
    expect(refusal(partnerAccessDraft({ action: 'share', asset: 'ad-account', partnerBusinessId: PARTNER, permittedTasks: ['ANALYZE', 'DRAFT'] }, partnerLive()))).toMatch(/only Meta's task combinations/)
    const pageAsset = { asset: 'page' as const, nodeId: '120000000000080', label: 'Facebook Page 120000000000080' }
    const page = drafted(partnerAccessDraft({ action: 'share', asset: 'page', partnerBusinessId: PARTNER, permittedTasks: ['ADVERTISE'] }, partnerLive({ asset: pageAsset })))
    expect(page.warnings.join(' ')).toMatch(/Taking it back .* Page reference says is not supported .* Business settings › Partners/)
    expect(page.warnings.join(' ')).toMatch(/Page token of someone with MANAGE, and pages_manage_metadata/)
    expect(page.requests[0].explain).toBe(ACCESS_EXPLAIN_PAGE)
    expect(ACCESS_EXPLAIN_PAGE['200']).toMatch(/pages_manage_metadata/)
    // The Instagram asset's share is documented (review B-F1): no "SDK only" there.
    const ig = drafted(partnerAccessDraft({ action: 'share', asset: 'instagram', partnerBusinessId: PARTNER, permittedTasks: ['CONTENT'] }, partnerLive({ asset: { asset: 'instagram', nodeId: '120000000000090', label: 'Instagram account' } })))
    expect(ig.warnings.join(' ')).not.toMatch(/SDK/)
    const sharedAccount = partnerLive({ partners: new Map([[PARTNER, { id: PARTNER, name: null, tasks: ['ANALYZE'], accessStatus: null, takenByAnotherBusiness: false }]]) })
    expect(drafted(partnerAccessDraft({ action: 'remove', asset: 'ad-account', partnerBusinessId: PARTNER }, sharedAccount)).warnings.join(' ')).toMatch(/Meta may refuse it, and the partner may have to accept again — treat this removal as one-way until LIVE-PROBES ST41-03/)
  })
  it('review A-SF1 (M33) — step 40\'s rule holds for partners too: nothing through a disabled or compromised ad account', () => {
    expect(refusal(partnerAccessDraft({ action: 'share', asset: 'ad-account', partnerBusinessId: PARTNER, permittedTasks: ['ANALYZE'] }, partnerLive({ state: { ...STATE, status: 2 } })))).toMatch(/Nexus changes nothing on an ad account Meta has disabled/)
    expect(refusal(partnerAccessDraft({ action: 'end-relationship', relationship: 'agency', partnerBusinessId: PARTNER }, partnerLive({ state: { ...STATE, disableReason: 15 } })))).toMatch(/compromised/i)
  })
  it('a removal: only a partner listed, only when Nexus\'s system user is the portfolio\'s own; undo shares again with its tasks', () => {
    const shared = partnerLive({ partners: new Map([[PARTNER, { id: PARTNER, name: 'Agency A', tasks: ['ADVERTISE', 'ANALYZE'], accessStatus: 'CONFIRMED', takenByAnotherBusiness: false }]]) })
    const d = drafted(partnerAccessDraft({ action: 'remove', asset: 'ad-account', partnerBusinessId: PARTNER }, shared))
    expect(d.requests[0]).toMatchObject({ method: 'DELETE', params: { business: PARTNER }, operation: 'access.accessadaccount.partner.remove' })
    expect(d.before).toMatchObject({ shared: true, tasks: ['ADVERTISE', 'ANALYZE'] })
    expect(refusal(partnerAccessDraft({ action: 'remove', asset: 'ad-account', partnerBusinessId: PARTNER }, partnerLive()))).toMatch(/not shared/)
    expect(refusal(partnerAccessDraft({ action: 'remove', asset: 'ad-account', partnerBusinessId: PARTNER }, { ...shared, systemUsers: new Set([OTHER_SYSTEM_USER]) }))).toMatch(/may come through a partner/)
    expect(refusal(partnerAccessDraft({ action: 'remove', asset: 'ad-account', partnerBusinessId: PARTNER }, { ...shared, systemUsers: null }))).toMatch(/could not read the business portfolio's system users/)
    // The Page's removal is SDK only (the reference says the edge has no delete): said.
    const page = drafted(partnerAccessDraft({ action: 'remove', asset: 'page', partnerBusinessId: PARTNER }, { ...shared, asset: { asset: 'page', nodeId: '120000000000080', label: 'Facebook Page 120000000000080' } }))
    expect(page.warnings.join(' ')).toMatch(/Page reference says the agencies edge has no delete/)
  })
  it('ending a relationship: the whole of it, no undo, an admin\'s act; a client\'s only when the chosen Page and Instagram are the portfolio\'s own', () => {
    const rel = (shares: unknown = { adAccounts: ['1234567891'], pages: [], catalogs: null, apps: [] }) => new Map([[PARTNER, { id: PARTNER, name: 'Agency A', takenByAnotherBusiness: false, shares: shares as never }]])
    const d = drafted(partnerAccessDraft({ action: 'end-relationship', relationship: 'agency', partnerBusinessId: PARTNER }, partnerLive({ asset: undefined, partners: undefined, relationships: rel() })))
    expect(d.requests[0]).toMatchObject({ objectId: PORTFOLIO, objectKind: 'accessportfolio', edge: 'agencies', method: 'DELETE', params: { business: PARTNER }, undoable: false })
    expect(d.warnings[0]).toMatch(/WHOLE agency relationship.*1 ad account \(1234567891\); 0 Pages; catalogs: Meta did not say; 0 apps\. Meta's list names ad accounts, Pages, catalogs and apps only: Instagram accounts, datasets and any other asset of the relationship go too and are not listed\. NO UNDO/)
    expect(d.warnings.join(' ')).toMatch(/Meta may require an ADMIN of the business portfolio/)
    // Review A-SF3 — what it would lose is in the basis.
    expect(d.stands).toMatchObject({ shares: { adAccounts: ['1234567891'], pages: [], catalogs: null, apps: [] } })
    const more = drafted(partnerAccessDraft({ action: 'end-relationship', relationship: 'agency', partnerBusinessId: PARTNER }, partnerLive({ relationships: rel({ adAccounts: ['1234567891', '1234567893'], pages: [], catalogs: null, apps: [] }) })))
    expect(more.stands).not.toEqual(d.stands)
    // Review A-MF1 — fail closed: no readable ad-account and Page lists, a fallback note, or the taken check not made: nothing ends.
    expect(refusal(partnerAccessDraft({ action: 'end-relationship', relationship: 'agency', partnerBusinessId: PARTNER }, partnerLive({ relationships: rel(null) })))).toMatch(/did not list the ad accounts and Pages/)
    expect(refusal(partnerAccessDraft({ action: 'end-relationship', relationship: 'agency', partnerBusinessId: PARTNER }, partnerLive({ relationships: rel({ adAccounts: ['1234567891'], pages: null, catalogs: [], apps: [] }) })))).toMatch(/did not list the ad accounts and Pages/)
    // Re-review R-3 (D3) — the ad accounts unreadable alone refuses on its own, whatever the taken check said.
    expect(refusal(partnerAccessDraft({ action: 'end-relationship', relationship: 'agency', partnerBusinessId: PARTNER }, partnerLive({ relationships: rel({ adAccounts: null, pages: [], catalogs: [], apps: [] }), sharesTaken: false })))).toMatch(/did not list the ad accounts and Pages/)
    expect(refusal(partnerAccessDraft({ action: 'end-relationship', relationship: 'agency', partnerBusinessId: PARTNER }, partnerLive({ relationships: rel(), sharesNote: 'Meta refused page_permissions here' })))).toMatch(/Meta refused page_permissions/)
    expect(refusal(partnerAccessDraft({ action: 'end-relationship', relationship: 'agency', partnerBusinessId: PARTNER }, partnerLive({ relationships: rel(), sharesTaken: undefined })))).toMatch(/or Nexus could not check/)
    // Review A-SF1 (M30a) — Nexus's system user not the portfolio's own: nothing ends.
    expect(refusal(partnerAccessDraft({ action: 'end-relationship', relationship: 'agency', partnerBusinessId: PARTNER }, partnerLive({ relationships: rel(), systemUsers: new Set([OTHER_SYSTEM_USER]) })))).toMatch(/may come through a partner/)
    expect(refusal(partnerAccessDraft({ action: 'end-relationship', relationship: 'agency', partnerBusinessId: PARTNER }, partnerLive({ relationships: rel(), portfolioShared: null })))).toMatch(/could not tell that none does/)
    expect(refusal(partnerAccessDraft({ action: 'end-relationship', relationship: 'agency', partnerBusinessId: PARTNER }, partnerLive({ relationships: new Map() })))).toMatch(/not an agency/)
    expect(refusal(partnerAccessDraft({ action: 'end-relationship', relationship: 'agency', partnerBusinessId: PARTNER }, partnerLive({ relationships: rel(), portfolioShared: true })))).toMatch(/ends none/)
    expect(refusal(partnerAccessDraft({ action: 'end-relationship', relationship: 'agency', partnerBusinessId: PARTNER }, partnerLive({ relationships: rel(), sharesTaken: true })))).toMatch(/another business in Nexus uses \(or Nexus could not check\): ending it could cut that business off/)
    expect(refusal(partnerAccessDraft({ action: 'end-relationship', relationship: 'client', partnerBusinessId: PARTNER }, partnerLive({ relationships: rel(), chosenOwned: { page: false, instagram: 'none' } })))).toMatch(/chosen Facebook Page is not the business portfolio's own/)
    expect(refusal(partnerAccessDraft({ action: 'end-relationship', relationship: 'client', partnerBusinessId: PARTNER }, partnerLive({ relationships: rel(), chosenOwned: { page: true, instagram: false } })))).toMatch(/chosen Instagram account is not/)
    // Review A-MF1 — the test that pinned a client end without its shares now expects a refusal.
    expect(refusal(partnerAccessDraft({ action: 'end-relationship', relationship: 'client', partnerBusinessId: PARTNER }, partnerLive({ relationships: rel(null), chosenOwned: { page: true, instagram: 'none' } })))).toMatch(/did not list the ad accounts and Pages/)
    const client = drafted(partnerAccessDraft({ action: 'end-relationship', relationship: 'client', partnerBusinessId: PARTNER }, partnerLive({ relationships: rel(), chosenOwned: { page: true, instagram: 'none' } })))
    expect(client.requests[0]).toMatchObject({ edge: 'clients', operation: 'access.portfolio.client.end' })
    expect(client.before).toMatchObject({ noUndo: [expect.stringMatching(/no undo/)] })
    // A client end also looks at every Instagram account the portfolio holds as a client (Meta names none for a relationship).
    expect(refusal(partnerAccessDraft({ action: 'end-relationship', relationship: 'client', partnerBusinessId: PARTNER }, partnerLive({ relationships: rel(), chosenOwned: { page: true, instagram: 'none' }, clientInstagram: 'taken' })))).toMatch(/as a client, an Instagram account another business in Nexus uses/)
    expect(refusal(partnerAccessDraft({ action: 'end-relationship', relationship: 'client', partnerBusinessId: PARTNER }, partnerLive({ relationships: rel(), chosenOwned: { page: true, instagram: 'none' }, clientInstagram: 'unread' })))).toMatch(/could not read in full the Instagram accounts/)
  })
})

describe('the tier and Meta\'s codes in words', () => {
  it('names the tier Meta named, and the way to the Full tier; never a workaround', () => {
    expect(tierWarning('standard_access')).toMatch(/standard_access \(Full\)/)
    expect(tierWarning('development_access')).toMatch(/Limited.*after App Review.*Upgrade in the Meta App Dashboard › App Review › Permissions and Features.*no way around it/)
    expect(tierWarning(null)).toMatch(/did not name this app's tier/)
    expect(ACCESS_EXPLAIN['200']).toMatch(/Full Marketing API access tier/)
    expect(ACCESS_EXPLAIN['2620']).toMatch(/Invalid call to update account permissions/)
    expect(ACCESS_EXPLAIN['3']).toMatch(/most likely/)
    expect(ACCESS_EXPLAIN['100']).toMatch(/1752129/)
    expect(ACCESS_EXPLAIN['368']).toMatch(/wait and ask again later/)
  })
  it('a partner\'s read-back: the tasks asked held, or Meta\'s list lagging said', () => {
    expect(partnerReadBack(['ANALYZE'], { id: PARTNER, name: null, tasks: ['ANALYZE'], accessStatus: 'PENDING', takenByAnotherBusiness: false })).toEqual({ moved: [], reads: 'shared: ANALYZE (PENDING)' })
    expect(partnerReadBack(['ADVERTISE'], { id: PARTNER, name: null, tasks: ['ANALYZE'], accessStatus: null, takenByAnotherBusiness: false }).moved).toEqual(['permitted_tasks'])
    expect(partnerReadBack(null, null)).toEqual({ moved: [], reads: 'not shared' })
    // Re-review R-5 — Meta did not list the partner's tasks on this edge: said, never "moved".
    expect(partnerReadBack(['ANALYZE'], { id: PARTNER, name: null, tasks: null, accessStatus: 'PENDING', takenByAnotherBusiness: false })).toEqual({ moved: [], reads: 'shared (PENDING); Meta did not list its tasks' })
    const unlisted = partnerLive({ partners: new Map([[PARTNER, { id: PARTNER, name: null, tasks: null, accessStatus: null, takenByAnotherBusiness: false }]]) })
    expect(refusal(partnerAccessDraft({ action: 'share', asset: 'ad-account', partnerBusinessId: PARTNER, permittedTasks: ['ANALYZE'] }, unlisted))).toMatch(/already shared .*tasks not listed by Meta/)
    expect(drafted(partnerAccessDraft({ action: 'remove', asset: 'ad-account', partnerBusinessId: PARTNER }, unlisted)).warnings.join(' ')).toMatch(/No undo: Nexus did not read tasks it can give the partner back \(tasks not listed by Meta\)/)
  })
})

// ── Owner option 1: a dataset (pixel) ───────────────────────────────────────────────────────────────────────────────

const PIXEL_ASSET = { asset: 'pixel' as const, nodeId: '120000000000050', label: 'dataset 120000000000050 ("Dataset A")' }

describe('a dataset (Owner option 1)', () => {
  it('a person: POST with user + tasks (no business); EDIT is its admin; a first grant has no undo, said; no removal at all', () => {
    const live = userLive({ asset: PIXEL_ASSET, assigned: new Map([[OWNER, { id: OWNER, name: 'Person B', tasks: ['ADVERTISE', 'ANALYZE', 'EDIT'] }]]) })
    const d = drafted(userAccessDraft({ asset: 'pixel', action: 'set', personId: PERSON, tasks: ['UPLOAD', 'ANALYZE'] }, live))
    expect(d.requests[0]).toMatchObject({ objectId: '120000000000050', objectKind: 'accesspixel', edge: 'assigned_users', operation: 'access.accesspixel.user.set', params: { user: PERSON, tasks: '["ANALYZE","UPLOAD"]' } })
    expect(d.requests[0].params.business).toBeUndefined()
    expect(d.warnings.join(' ')).toMatch(/No undo: Meta has no way to take these tasks back by API — a person removes them in Meta Business settings › Data sources/)
    expect(d.warnings.join(' ')).toMatch(/SDK and Ads CLI only/)
    expect(d.before).toMatchObject({ noUndo: [expect.stringMatching(/no way to take these tasks back/)] })
    expect(refusal(userAccessDraft({ asset: 'pixel', action: 'remove', personId: OWNER }, live))).toBe(PIXEL_NO_REMOVE)
    expect(refusal(userAccessDraft({ asset: 'pixel', action: 'set', personId: OWNER, tasks: ['ANALYZE'] }, live))).toMatch(/last person who is an admin of the dataset \(EDIT\)/)
    expect(refusal(userAccessDraft({ asset: 'pixel', action: 'set', personId: PERSON, tasks: ['MANAGE'] }, live))).toMatch(/MANAGE is no task of a dataset/)
    expect(drafted(userAccessDraft({ asset: 'pixel', action: 'set', personId: PERSON, tasks: ['EDIT'] }, live)).warnings.join(' ')).toMatch(/an ADMIN of dataset/)
    // A person who already holds tasks: undo sends them again (no "no undo").
    live.assigned.set(PERSON, { id: PERSON, name: 'Person A', tasks: ['ANALYZE'] })
    expect(drafted(userAccessDraft({ asset: 'pixel', action: 'set', personId: PERSON, tasks: ['ANALYZE', 'UPLOAD'] }, live)).warnings.join(' ')).not.toMatch(/No undo/)
  })
  it('a partner: shared with the partner list (no AA_ANALYZE), the pending request and EDIT said; taken off on the QUERY, the plan naming it', () => {
    const live = partnerLive({ asset: PIXEL_ASSET })
    const d = drafted(partnerAccessDraft({ action: 'share', asset: 'pixel', partnerBusinessId: PARTNER, permittedTasks: ['EDIT', 'ANALYZE'] }, live))
    expect(d.requests[0]).toMatchObject({ objectKind: 'accesspixel', edge: 'agencies', params: { business: PARTNER, permitted_tasks: '["ANALYZE","EDIT"]' } })
    expect(d.warnings.join(' ')).toMatch(/pending request \(pending_request_id\)/)
    expect(d.warnings.join(' ')).toMatch(/EDIT on a dataset is limited by Meta/)
    expect(refusal(partnerAccessDraft({ action: 'share', asset: 'pixel', partnerBusinessId: PARTNER, permittedTasks: ['AA_ANALYZE'] }, live))).toMatch(/AA_ANALYZE is no task a partner can hold on a dataset/)
    const shared = partnerLive({ asset: PIXEL_ASSET, partners: new Map([[PARTNER, { id: PARTNER, name: null, tasks: ['ANALYZE'], accessStatus: null, takenByAnotherBusiness: false }]]) })
    const r = drafted(partnerAccessDraft({ action: 'remove', asset: 'pixel', partnerBusinessId: PARTNER }, shared))
    expect(r.requests[0]).toMatchObject({ method: 'DELETE', edge: 'agencies', params: {}, via: { query: { business: PARTNER } }, planParams: { business: PARTNER } })
    expect(r.warnings.join(' ')).toMatch(/admin's token of the portfolio that owns it/)
    expect(metaUndoTasks('pixel', ['ANALYZE', 'AA_ANALYZE'], 'partner')).toBeNull()
    expect(metaUndoTasks('pixel', ['ANALYZE', 'AA_ANALYZE'])).toEqual(['AA_ANALYZE', 'ANALYZE'])
  })
})

describe('serverEventsDraft (SG-014)', () => {
  const B1 = '120000000000071'
  const B2 = '120000000000072'
  const seLive = (over: Partial<ServerEventsLive> = {}): ServerEventsLive => ({
    state: { ...STATE }, portfolioId: PORTFOLIO, portfolioShared: false, nexusSystemUserId: ME, asset: PIXEL_ASSET,
    businesses: new Map([[B1, { id: B1, name: 'Partner A', takenByAnotherBusiness: false }]]), more: false, askedTaken: false, systemUsers: new Set([ME]), ...over,
  })
  it('the WHOLE list, from → to, one POST of the sorted ids; undo has the old list', () => {
    const d = drafted(serverEventsDraft({ businessIds: [B2, B1] }, seLive()))
    expect(d.requests[0]).toMatchObject({ objectId: '120000000000050', objectKind: 'accesspixel', operation: 'access.accesspixel.server_events', params: { server_events_business_ids: `["${B1}","${B2}"]` }, via: {}, expectedIds: [B1] })
    expect(d.requests[0].edge).toBeUndefined()
    expect(d.requests[0].readBackFields).toBeUndefined()
    expect(d.warnings[0]).toMatch(/WHOLE list \(Meta replaces it\)/)
    expect(d.before).toMatchObject({ op: 'server-events', businesses: [B1] })
    expect(d.after).toMatchObject({ op: 'server-events', businesses: [B1, B2] })
    expect(drafted(serverEventsDraft({ businessIds: [], confirmRemove: true }, seLive())).warnings.join(' ')).toMatch(/Taken off: "Partner A"/)
    // Option-1 review N2 — taking a business off takes confirmRemove.
    expect(refusal(serverEventsDraft({ businessIds: [] }, seLive()))).toMatch(/takes confirmRemove: true/)
    expect(drafted(serverEventsDraft({ businessIds: [B1] }, seLive())).requests).toEqual([])
  })
  it('the floors: never the portfolio itself, never another Nexus business\'s (asked, or on the list now), Nexus\'s system user the portfolio\'s', () => {
    expect(refusal(serverEventsDraft({ businessIds: [PORTFOLIO] }, seLive()))).toMatch(/own business portfolio is not one of the businesses/)
    expect(refusal(serverEventsDraft({ businessIds: [B2] }, seLive({ askedTaken: true })))).toMatch(/another business in Nexus uses/)
    expect(refusal(serverEventsDraft({ businessIds: [B2] }, seLive({ businesses: new Map([[B1, { id: B1, name: null, takenByAnotherBusiness: true }]]) })))).toMatch(/does not change the list/)
    expect(refusal(serverEventsDraft({ businessIds: [B2] }, seLive({ systemUsers: new Set([OTHER_SYSTEM_USER]) })))).toMatch(/its own server events may come through/)
    expect(refusal(serverEventsDraft({ businessIds: [B2] }, seLive({ systemUsers: null })))).toMatch(/could not read its own system user/)
    expect(refusal(serverEventsDraft({ businessIds: [B2] }, seLive({ more: true })))).toMatch(/More businesses/)
    expect(refusal(serverEventsDraft({ businessIds: [B2] }, seLive({ state: { ...STATE, status: 2 } })))).toMatch(/disabled/)
    // Option-1 review SF2 — the portfolio itself on Meta's list now: the list is not changed (its undo could never run).
    expect(refusal(serverEventsDraft({ businessIds: [B1, B2] }, seLive({ businesses: new Map([[B1, { id: B1, name: null, takenByAnotherBusiness: false }], [PORTFOLIO, { id: PORTFOLIO, name: null, takenByAnotherBusiness: false }]]) })))).toMatch(/own business portfolio among/)
    // N1 — more than Nexus sends back as one whole list.
    const many = new Map(Array.from({ length: 51 }, (_, i) => { const id = String(120000000000100 + i); return [id, { id, name: null, takenByAnotherBusiness: false }] as const }))
    expect(refusal(serverEventsDraft({ businessIds: [B2] }, seLive({ businesses: many })))).toMatch(/more than the 50 Nexus sends as one whole list/)
  })
})
