/**
 * Meta ads step 43 — the business-asset guides (D1 = A), pure: what is asked from → to, whether it is so already, the Owner's
 * steps (Meta's Help Center), how to put it back, the warnings; never "done" for an id Nexus cannot find on a first ask;
 * nothing for an asset another business in Nexus uses or one whose owner Meta does not name. Made-up ids and names.
 */
import { describe, expect, it } from 'vitest'
import {
  appealGuide, assetGuide, newAdAccountGuide, removeGuide, ASSET_GROUP_NO_API, D1_APPEAL_LINE, D1_ASSET_LINE, NEW_ACCOUNT_MONEY,
  type AppealLive, type AssetLists, type AssetLive, type ListedAsset, type NewAdAccountLive, type RemoveLive,
} from './business-assets-admin.js'
import type { AdminGuide } from './business-admin.js'

const PORTFOLIO = '9876543210'
const ACCOUNT = '1234567890'
const OTHER_ACCOUNT = '1234567891'
const PAGE = '120000000000010'
const OTHER_PAGE = '120000000000011'
const IG = '17840000000000001'
const APP = '300000000000009'
const READ_AT = '2026-10-26T10:00:00.000Z'

const lists = (rows: ListedAsset[], more: Partial<AssetLists> = {}): AssetLists => ({ rows, cut: false, unread: [], ...more })
const assetLive = (over: Partial<AssetLive> = {}): AssetLive => ({
  portfolioId: PORTFOLIO, portfolioName: 'Shop A', readAt: READ_AT, taken: false, lists: lists([]),
  chosen: { adAccountId: ACCOUNT, pageId: PAGE, instagramId: IG, instagramName: 'shop_a', appId: APP }, ...over,
})
const ok = (out: AdminGuide | { refusal: string }): AdminGuide => { if ('refusal' in out) throw new Error(out.refusal); return out }
const no = (out: AdminGuide | { refusal: string }): string => { if (!('refusal' in out)) throw new Error('expected a refusal'); return out.refusal }
const steps = (g: AdminGuide) => g.ownerSteps.join(' ')

describe('every guide sends nothing and carries D1', () => {
  it('nexusSends nothing, the asset rule line, the portfolio named, readAt', () => {
    const g = ok(assetGuide({ action: 'claim-page', pageId: OTHER_PAGE }, assetLive()))
    expect(g).toMatchObject({ nexusSends: 'nothing', rule: D1_ASSET_LINE, portfolioId: PORTFOLIO, readAt: READ_AT, state: 'to-do' })
    expect(D1_ASSET_LINE).toMatch(/For all add and remove endpoints: Access token's user needs to be an admin of the business/)
    expect(steps(g)).toMatch(/"Shop A" \(id 9876543210/)
  })
})

describe('claim-ad-account / request-ad-account (AA-063, AA-064)', () => {
  it('a claim: Meta\'s help steps; a claim is for good; the ad account limit and the prepaid rule', () => {
    const g = ok(assetGuide({ action: 'claim-ad-account', adAccountId: OTHER_ACCOUNT }, assetLive()))
    expect(g.state).toBe('to-do')
    expect(steps(g)).toMatch(/Accounts › Ad accounts › Add an ad account/)
    expect(steps(g)).toMatch(/Enter the ad account ID 1234567891.*Claim ad account/)
    expect(g.putBack.possible).toBe('partly')
    expect(g.warnings.join(' ')).toMatch(/can't be deleted or transferred/)
    expect(g.warnings.join(' ')).toMatch(/prepaid balance/)
    expect(g.items[0].asked).toEqual({ adAccountId: 'act_1234567891', owner: 'this portfolio' })
  })
  it('already the portfolio\'s own: done, no steps; a request for it is refused', () => {
    const live = assetLive({ lists: lists([{ id: OTHER_ACCOUNT, list: 'owned', name: 'Shop A outlet', seen: 'named' }]) })
    const g = ok(assetGuide({ action: 'claim-ad-account', adAccountId: OTHER_ACCOUNT }, live))
    expect(g.state).toBe('done')
    expect(g.ownerSteps).toEqual([])
    expect(no(assetGuide({ action: 'request-ad-account', adAccountId: OTHER_ACCOUNT }, live))).toMatch(/this portfolio's own/)
  })
  it('a partner\'s ad account: Meta keeps it in one portfolio (no claim); a request is done', () => {
    const live = assetLive({ lists: lists([{ id: OTHER_ACCOUNT, list: 'client', name: 'Partner ads', seen: 'named' }]) })
    expect(no(assetGuide({ action: 'claim-ad-account', adAccountId: OTHER_ACCOUNT }, live))).toMatch(/An ad account can only be in one business portfolio/)
    expect(ok(assetGuide({ action: 'request-ad-account', adAccountId: OTHER_ACCOUNT }, live)).state).toBe('done')
  })
  it('a claim waiting: the ad account\'s admin accepts it in Ads Manager; a request while a claim waits is refused', () => {
    const live = assetLive({ lists: lists([{ id: OTHER_ACCOUNT, list: 'pending-owned', name: null, seen: 'unknown', requestId: '500000000000001' }]) })
    const g = ok(assetGuide({ action: 'claim-ad-account', adAccountId: OTHER_ACCOUNT }, live))
    expect(g.state).toBe('to-do')
    expect(g.ownerSteps[0]).toMatch(/An admin of ad account act_1234567891 signs in to Meta Ads Manager and accepts/)
    expect(no(assetGuide({ action: 'request-ad-account', adAccountId: OTHER_ACCOUNT }, live))).toMatch(/claim of ad account act_1234567891 waiting already/)
  })
  it('another business\'s ad account (or its portfolio): no steps at all', () => {
    expect(no(assetGuide({ action: 'claim-ad-account', adAccountId: OTHER_ACCOUNT }, assetLive({ taken: true })))).toMatch(/Another business in Nexus uses ad account act_1234567891/)
    const live = assetLive({ lists: lists([{ id: OTHER_ACCOUNT, list: 'client', name: null, seen: 'taken' }]) })
    expect(no(assetGuide({ action: 'request-ad-account', adAccountId: OTHER_ACCOUNT }, live))).toMatch(/Another business in Nexus/)
  })
  it('a request: Meta cannot by API for Nexus\'s app (30 days), the access level, the owner\'s money', () => {
    const g = ok(assetGuide({ action: 'request-ad-account', adAccountId: OTHER_ACCOUNT, access: 'full' }, assetLive()))
    expect(steps(g)).toMatch(/Request access to an ad account in another business portfolio.*full control/)
    expect(g.warnings.join(' ')).toMatch(/limited to apps that called it within the last 30 days/)
    expect(g.warnings.join(' ')).toMatch(/its owner's money/)
    expect(g.putBack.possible).toBe('yes')
  })
  it('a list cut or not read: not found is "cannot tell", the steps still come; arguments of another action are refused', () => {
    expect(ok(assetGuide({ action: 'claim-ad-account', adAccountId: OTHER_ACCOUNT }, assetLive({ lists: lists([], { cut: true }) }))).state).toBe('cannot-tell')
    const g = ok(assetGuide({ action: 'claim-ad-account', adAccountId: OTHER_ACCOUNT }, assetLive({ lists: lists([], { unread: ['owned ad accounts: refused'] }) })))
    expect(g.items[0].sentence).toMatch(/Meta did not answer one list/)
    expect(g.ownerSteps.length).toBeGreaterThan(1)
    expect(no(assetGuide({ action: 'claim-ad-account', adAccountId: OTHER_ACCOUNT, access: 'full' }, assetLive()))).toMatch(/access is for request-ad-account/)
    expect(no(assetGuide({ action: 'claim-ad-account' }, assetLive()))).toMatch(/Name the ad account/)
  })
})

describe('link-instagram (AA-066)', () => {
  it('listed: done; not listed: the developer guide\'s place, worded "if Meta offers"; not read: cannot tell', () => {
    expect(ok(assetGuide({ action: 'link-instagram' }, assetLive({ authorized: { adAccountIds: [ACCOUNT], more: false } }))).state).toBe('done')
    const g = ok(assetGuide({ action: 'link-instagram' }, assetLive({ authorized: { adAccountIds: [], more: false } })))
    expect(g.state).toBe('to-do')
    expect(steps(g)).toMatch(/If Meta offers its connected assets there.*add the ad account act_1234567890/)
    expect(g.warnings.join(' ')).toMatch(/all users of the business who can run ads for that account/)
    expect(ok(assetGuide({ action: 'link-instagram' }, assetLive({ authorized: { refused: 'Meta said no.' } }))).state).toBe('cannot-tell')
    expect(ok(assetGuide({ action: 'link-instagram' }, assetLive({ authorized: { adAccountIds: [], more: true } }))).state).toBe('cannot-tell')
  })
  it('only the chosen ones: no ids taken; no Instagram account chosen: refused', () => {
    expect(no(assetGuide({ action: 'link-instagram', adAccountId: OTHER_ACCOUNT }, assetLive()))).toMatch(/takes no ids/)
    expect(no(assetGuide({ action: 'link-instagram' }, assetLive({ chosen: { adAccountId: ACCOUNT, pageId: PAGE, instagramId: null, instagramName: null, appId: null } })))).toMatch(/chosen no Instagram account/)
  })
})

describe('claim-page / request-page (BM-044, BM-045)', () => {
  it('a claim: Meta\'s help steps, the 7-day rule, the linked Instagram account; put back by removing it', () => {
    const g = ok(assetGuide({ action: 'claim-page', pageId: OTHER_PAGE }, assetLive()))
    expect(steps(g)).toMatch(/Accounts › Pages › \+ Add › Add an existing Facebook Page.*Add Page; Done/)
    expect(g.warnings.join(' ')).toMatch(/more than 7 days/)
    expect(g.warnings.join(' ')).toMatch(/add that Instagram account/)
    expect(g.putBack).toMatchObject({ possible: 'yes' })
  })
  it('a request: the spam lock warning, the primary Page first, partial access by default', () => {
    const g = ok(assetGuide({ action: 'request-page', pageId: OTHER_PAGE }, assetLive()))
    expect(steps(g)).toMatch(/Request shared access to a Facebook Page.*partial access.*primary Page/)
    expect(g.warnings.join(' ')).toMatch(/we lock the Business Manager/)
  })
  it('another\'s Page cannot be claimed while it is in their portfolio; an owned one is done; taken is refused', () => {
    const client = assetLive({ lists: lists([{ id: OTHER_PAGE, list: 'client', name: 'Partner page', seen: 'named' }]) })
    expect(no(assetGuide({ action: 'claim-page', pageId: OTHER_PAGE }, client))).toMatch(/must first remove it from their business portfolio/)
    expect(ok(assetGuide({ action: 'request-page', pageId: OTHER_PAGE }, client)).state).toBe('done')
    const owned = assetLive({ lists: lists([{ id: OTHER_PAGE, list: 'owned', name: 'Shop A outlet', seen: 'named' }]) })
    expect(ok(assetGuide({ action: 'claim-page', pageId: OTHER_PAGE }, owned)).state).toBe('done')
    expect(no(assetGuide({ action: 'claim-page', pageId: OTHER_PAGE }, assetLive({ taken: true })))).toMatch(/Another business in Nexus uses Page/)
  })
})

describe('claim-app / request-app (BM-055) and asset-group (BM-056)', () => {
  it('apps: Connect an app ID / Request access to an app ID; Nexus\'s own app named; no API way back', () => {
    const claim = ok(assetGuide({ action: 'claim-app', appId: APP }, assetLive({ lists: lists([]) })))
    expect(steps(claim)).toMatch(/Accounts › Apps › Add › Connect an app ID: enter the App ID 300000000000009/)
    expect(claim.warnings.join(' ')).toMatch(/business's own Meta app that Nexus uses.*104001/)
    expect(claim.putBack.possible).toBe('partly')
    const request = ok(assetGuide({ action: 'request-app', appId: '300000000000008' }, assetLive()))
    expect(steps(request)).toMatch(/Request access to an app ID/)
    expect(request.warnings.join(' ')).toMatch(/cannot tell whether another business in Nexus uses this app/)
    const pending = ok(assetGuide({ action: 'request-app', appId: '300000000000008' }, assetLive({ lists: lists([{ id: '300000000000008', list: 'pending', name: null, seen: 'unknown', requestId: '1' }]) })))
    expect(pending.ownerSteps[0]).toMatch(/The owner of app 300000000000008 accepts/)
    // A partner's app: a claim sends its owner a request (Meta's help) — only when Meta names the owner.
    const shared = (seen: 'named' | 'unknown') => assetLive({ lists: lists([{ id: '300000000000008', list: 'client', name: 'Partner app', seen }]) })
    const claimShared = ok(assetGuide({ action: 'claim-app', appId: '300000000000008' }, shared('named')))
    expect(claimShared.state).toBe('to-do')
    expect(steps(claimShared)).toMatch(/Connect an app ID: enter the App ID 300000000000008/)
    expect(no(assetGuide({ action: 'claim-app', appId: '300000000000008' }, shared('unknown')))).toMatch(/Meta does not name whose app/)
    expect(ok(assetGuide({ action: 'request-app', appId: '300000000000008' }, shared('unknown'))).state).toBe('done')
  })
  it('an asset group: Meta cannot by API, the Owner\'s steps; one with that name is done', () => {
    const g = ok(assetGuide({ action: 'asset-group', name: 'Brand A' }, assetLive()))
    expect(g.warnings).toContain(ASSET_GROUP_NO_API)
    expect(ASSET_GROUP_NO_API).toMatch(/you'll need to create business asset groups using your business portfolio/)
    expect(steps(g)).toMatch(/Business asset groups › Create business asset group.*"Brand A"/)
    expect(ok(assetGuide({ action: 'asset-group', name: 'Brand A' }, assetLive({ lists: lists([{ id: '400000000000001', list: 'owned', name: 'Brand A', seen: 'named' }]) }))).state).toBe('done')
    expect(no(assetGuide({ action: 'asset-group' }, assetLive()))).toMatch(/Name the new business asset group/)
  })
})

describe('remove-meta-business-asset (AA-065, BM-047, BM-049)', () => {
  const removeLive = (rows: ListedAsset[], over: Partial<RemoveLive> = {}): RemoveLive => ({
    portfolioId: PORTFOLIO, portfolioName: 'Shop A', chosen: { adAccountId: ACCOUNT, pageId: PAGE, instagramId: IG }, lists: lists(rows), taken: false, readAt: READ_AT, ...over,
  })
  it('a first ask with an id Nexus cannot find is refused, never "done"; asked again with since, absence is the result', () => {
    expect(no(removeGuide({ asset: 'page', id: OTHER_PAGE }, removeLive([])))).toMatch(/is not in this business portfolio/)
    expect(ok(removeGuide({ asset: 'page', id: OTHER_PAGE, since: READ_AT }, removeLive([]))).state).toBe('done')
    expect(ok(removeGuide({ asset: 'page', id: OTHER_PAGE, since: READ_AT }, { ...removeLive([]), lists: lists([], { cut: true }) })).state).toBe('cannot-tell')
    expect(no(removeGuide({ asset: 'page', id: OTHER_PAGE, since: 'yesterday' }, removeLive([])))).toMatch(/since must be a time/)
  })
  it('an ad account the portfolio OWNS: Meta does not allow it — deactivate instead', () => {
    const out = no(removeGuide({ asset: 'ad-account', id: OTHER_ACCOUNT }, removeLive([{ id: OTHER_ACCOUNT, list: 'owned', name: 'Shop A outlet', seen: 'named' }])))
    expect(out).toMatch(/You cannot remove ad accounts from your business if you're OWNER and if the accounts are CONFIRMED/)
    expect(out).toMatch(/Deactivate/)
  })
  it('partner access to an ad account whose owner Meta names: the steps; unknown owner or taken: refused', () => {
    const g = ok(removeGuide({ asset: 'ad-account', id: OTHER_ACCOUNT }, removeLive([{ id: OTHER_ACCOUNT, list: 'client', name: 'Partner ads', seen: 'named' }])))
    expect(g.state).toBe('to-do')
    expect(steps(g)).toMatch(/Accounts › Ad accounts: click "Partner ads" \(ad account act_1234567891\), then Remove/)
    expect(g.putBack.possible).toBe('partly')
    expect(no(removeGuide({ asset: 'ad-account', id: OTHER_ACCOUNT }, removeLive([{ id: OTHER_ACCOUNT, list: 'client', name: null, seen: 'unknown' }])))).toMatch(/Meta does not name whose ad account/)
    expect(no(removeGuide({ asset: 'ad-account', id: OTHER_ACCOUNT }, removeLive([{ id: OTHER_ACCOUNT, list: 'client', name: null, seen: 'taken' }])))).toMatch(/Another business in Nexus/)
    expect(no(removeGuide({ asset: 'ad-account', id: OTHER_ACCOUNT }, removeLive([], { taken: true })))).toMatch(/Another business in Nexus/)
  })
  it('the chosen Page: disconnect Instagram first (42001), Meta\'s help steps, and what it stops in Nexus', () => {
    const g = ok(removeGuide({ asset: 'page', id: PAGE }, removeLive([{ id: PAGE, list: 'owned', name: 'Shop A page', seen: 'named', chosenHere: true }])))
    expect(steps(g)).toMatch(/42001.*Accounts › Pages: click "Shop A page" \(Page 120000000000010\), then Remove; review the information and click Remove Page from business portfolio/)
    expect(g.warnings[0]).toMatch(/This is the Page Nexus works with for this business.*set-meta-connection/)
    expect(g.afterwards).toMatch(/since "2026-10-26T10:00:00.000Z"/)
    expect(g.putBack.sentence).toMatch(/more than 7 days/)
  })
  it('an Instagram account the portfolio owns: re-adding needs its username and password', () => {
    const g = ok(removeGuide({ asset: 'instagram', id: '17840000000000002' }, removeLive([{ id: '17840000000000002', list: 'owned', name: 'shop_b', seen: 'named' }])))
    expect(g.putBack.sentence).toMatch(/username and password/)
    expect(g.warnings.join(' ')).not.toMatch(/works with for this business/)
  })
  it('a request still waiting: cancel it where Meta offers', () => {
    const g = ok(removeGuide({ asset: 'page', id: OTHER_PAGE }, removeLive([{ id: OTHER_PAGE, list: 'pending-client', name: 'Partner page', seen: 'named', requestId: '500000000000002' }])))
    expect(steps(g)).toMatch(/is still waiting: if Meta offers to cancel it there/)
  })
})

describe('create-meta-ad-account (AA-062)', () => {
  const live = (over: Partial<NewAdAccountLive> = {}): NewAdAccountLive => ({
    portfolioId: PORTFOLIO, portfolioName: 'Shop A', chosen: { adAccountId: ACCOUNT, currency: 'EUR', timeZone: 'Europe/Rome' },
    owned: { accounts: [{ adAccountId: ACCOUNT, name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome' }], more: false }, readAt: READ_AT, ...over,
  })
  it('the steps with the chosen account\'s currency and time zone, the MONEY line, no way back, Meta\'s limits', () => {
    const g = ok(newAdAccountGuide({ name: 'Shop A outlet' }, live()))
    expect(g.state).toBe('to-do')
    expect(steps(g)).toMatch(/Create a new ad account/)
    expect(steps(g)).toMatch(/time zone \(Europe\/Rome, as the business's chosen ad account\) and its currency \(EUR, as the business's chosen ad account\)/)
    expect(g.warnings).toContain(NEW_ACCOUNT_MONEY)
    expect(NEW_ACCOUNT_MONEY).toMatch(/^MONEY: a new ad account spends nothing until it has a payment method/)
    expect(g.putBack.possible).toBe('no')
    expect(g.warnings.join(' ')).toMatch(/this portfolio has 1 of its own now/)
    expect(g.items[0].asked).toEqual({ name: 'Shop A outlet', currency: 'EUR', timeZone: 'Europe/Rome' })
  })
  it('asked again: one with that name is made; Meta\'s list not read: cannot tell', () => {
    const made = live({ owned: { accounts: [{ adAccountId: OTHER_ACCOUNT, name: 'Shop A outlet', currency: 'USD', timeZone: 'Europe/Rome' }], more: false } })
    const g = ok(newAdAccountGuide({ name: 'Shop A outlet', currency: 'USD', since: READ_AT }, made))
    expect(g.state).toBe('done')
    expect(g.items[0].sentence).toMatch(/made/)
    expect(ok(newAdAccountGuide({ name: 'Shop A outlet' }, live({ owned: { refused: 'Meta said no.' } }))).state).toBe('cannot-tell')
  })
})

describe('create-meta-appeal (LG-015, LG-016)', () => {
  const live = (status: number | null, reason = 0): AppealLive => ({
    portfolioId: PORTFOLIO, account: { adAccountId: ACCOUNT, name: 'Shop A ads', status, disableReason: reason },
    statusWords: { 1: 'Active', 2: 'Disabled', 3: 'Unsettled', 7: 'Pending risk review', 101: 'Closed' }, reasonWords: { 1: 'Ads integrity policy', 15: 'Compromised ad account' }, readAt: READ_AT,
  })
  it('a disabled ad account: Business Support Home steps, the appeal rule line, final and limited, ads do not restart', () => {
    const g = ok(appealGuide({ subject: 'ad-account' }, live(2, 1)))
    expect(g).toMatchObject({ state: 'to-do', rule: D1_APPEAL_LINE, putBack: { possible: 'no' } })
    expect(steps(g)).toMatch(/Business Support Home.*Account status overview.*Request review/)
    expect(g.items[0].now).toEqual({ adAccountId: 'act_1234567890', status: 'Disabled', disableReason: 'Ads integrity policy' })
    expect(g.warnings.join(' ')).toMatch(/Once the review is completed, the decision is final/)
    expect(g.warnings.join(' ')).toMatch(/do NOT start again by themselves.*set-meta-status — SPENDS MONEY/)
  })
  it('asked again: Active means Meta lifted it; still disabled: cannot tell (Meta shows no review by API)', () => {
    expect(ok(appealGuide({ subject: 'ad-account', since: READ_AT }, live(1))).state).toBe('done')
    expect(ok(appealGuide({ subject: 'ad-account', since: READ_AT }, live(2))).state).toBe('cannot-tell')
  })
  it('active, closed, a payment matter or in review: no appeal steps', () => {
    const active = ok(appealGuide({ subject: 'ad-account' }, live(1)))
    expect(active).toMatchObject({ state: 'done', ownerSteps: [] })
    expect(no(appealGuide({ subject: 'ad-account' }, live(101)))).toMatch(/closed \(or closing\), not restricted/)
    expect(no(appealGuide({ subject: 'ad-account' }, live(3)))).toMatch(/payment matter/)
    expect(no(appealGuide({ subject: 'ad-account' }, live(7)))).toMatch(/reviewing it already/)
    expect(no(appealGuide({ subject: 'ad-account' }, { ...live(2), account: { refused: 'Meta said no.' } }))).toMatch(/cannot read the chosen ad account's status/)
  })
  it('a compromised account is secured first; the portfolio: Nexus cannot tell, the same place', () => {
    expect(ok(appealGuide({ subject: 'ad-account' }, live(2, 15))).warnings[0]).toMatch(/compromised ad account/)
    const g = ok(appealGuide({ subject: 'portfolio' }, live(null)))
    expect(g.state).toBe('cannot-tell')
    expect(g.items[0].sentence).toMatch(/Meta documents no field that says whether a business portfolio is restricted/)
    expect(steps(g)).toMatch(/the business portfolio \(id 9876543210\)/)
  })
})
