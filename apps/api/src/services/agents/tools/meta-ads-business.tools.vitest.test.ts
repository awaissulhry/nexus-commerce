/**
 * Meta ads step 4 — meta-business, meta-business-people, meta-business-assets, meta-business-partners. Every view asks Meta
 * only with fixed field lists and only what the real gateway lets through; only the chosen ad account's business portfolio
 * (and the chosen Page, a pending invitation of it, a WhatsApp account of it) is read; a Page, Instagram account, ad
 * account or portfolio another business uses is its id and a flag; an asset not owned here is named only when Meta names
 * its owner and that owner is not taken (else its id only); a shared portfolio's people, partners, domains and settings are
 * never read (no call) and its other assets are ids only; people are names, roles and tasks (never an e-mail address,
 * invitation link, verification code or token). Meta and the database are stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ operation: string; path: string; query?: Record<string, unknown> }>,
  answer: null as null | ((req: { operation: string; path: string; query?: Record<string, unknown> }) => unknown),
  taken: [] as Array<{ product: string; id: string }>,
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', async () => {
  const answerOf = (req: Req) => {
    h.calls.push(req)
    const out = h.answer?.(req)
    if (out instanceof Error) throw out
    return (out ?? { data: [] }) as Record<string, unknown>
  }
  return {
    metaReadOne: vi.fn(async (_t: unknown, req: Req) => ({ body: answerOf(req), calls: 1 })),
    metaReadAll: vi.fn(async (_t: unknown, req: Req, onRows: (rows: unknown[]) => void) => {
      const body = answerOf(req)
      const rows = Array.isArray(body.data) ? body.data : []
      onRows(rows)
      return { rows: rows.length, calls: 1, truncated: false }
    }),
  }
})
vi.mock('../../../db.js', () => ({
  default: {
    metaAdsCampaign: { findFirst: vi.fn(async () => null) },
    metaAdsAdSet: { findFirst: vi.fn(async () => null) },
    metaAdsAd: { findFirst: vi.fn(async () => null) },
    // nexus_meta_links_taken(product, ids): the ids of that product another business picked.
    $queryRaw: vi.fn(async (_s: unknown, product: string, ids: string[]) => h.taken.filter((t) => t.product === product && ids.includes(t.id)).map((t) => ({ id: t.id }))),
  },
}))

import { META_ADS_BUSINESS_TOOLS } from './meta-ads-business.tools.js'
import { MetaReadError, failureOfAnswer } from '../../marketing/meta-ads/errors.js'
import { BUSINESS_SETTINGS_FIELDS, plainOf, readBusinessSettings, readInvitations, readPortfolioPeople, readSystemUsers, seenAs } from '../../marketing/meta-ads/live-business.js'
import { metaChosenAccount } from '../../marketing/meta-ads/live.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const tool = (name: string) => META_ADS_BUSINESS_TOOLS.find((t) => t.name === name)!
const ctx = { can: () => true, via: 'claude' as const }
const run = (name: string, args: Record<string, unknown>) => tool(name).handler(tool(name).input.parse(args), ctx as never)
const refusedByMeta = (words: string, code = '100', errorClass = 'validation') => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass, channelCode: code, channelMessage: words } as never }), 'x', 1)
const fieldsOf = (req: Req) => String(req.query?.fields ?? '')
const data = (res: { ok: boolean; data?: unknown; error?: string }) => { if (!res.ok) throw new Error(res.error); return res.data as Record<string, any> }
const errorOf = (res: { ok: boolean; error?: string }) => { if (res.ok) throw new Error('expected a refusal'); return res.error! }
const listOf = (out: Record<string, any>, edge: string) => out.lists.find((l: { edge: string }) => l.edge === edge).items

const ACCOUNT = '1234567890'
const PORTFOLIO = '9876543210'
const OTHER_PORTFOLIO = '9000000000001'
const AGENCY = '9000000000002'
const SYSTEM_USER = '100000000000001'
const PERSON = '100000000000002'
const PAGE = '120000000000010'
const PAGE_2 = '120000000000011'
const PAGE_TAKEN = '120000000000099'
const IG = '170000000000001'
const IG_TAKEN = '170000000000099'
const IG_ASSET = '180000000000001'
const NEXUS_APP = '300000000000009'
const APP = '300000000000001'
const INVITE = '200000000000001'
const WABA = '210000000000001'
const GROUP = '220000000000001'
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok', systemUser: { id: SYSTEM_USER, name: 'Nexus system user' }, appId: NEXUS_APP,
  adAccount: { adAccountId: ACCOUNT, name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: PORTFOLIO },
  page: { pageId: PAGE }, instagram: { instagramId: IG }, read: {},
}
const SHARED_PORTFOLIO = { product: 'PORTFOLIO', id: PORTFOLIO }

/** Made-up answers for every read of the step (an e-mail, a link or a code Meta might add is in some, to prove it is dropped). */
function answers(req: Req): unknown {
  const f = fieldsOf(req)
  if (req.path === PORTFOLIO && f.includes('verification_status')) {
    return {
      id: PORTFOLIO, name: 'Shop A', verification_status: 'verified', timezone_id: 21, two_factor_type: 'admin_required', vertical: 'RETAIL', vertical_id: 7,
      primary_page: { id: PAGE, name: 'Shop A page' }, created_by: { id: SYSTEM_USER }, updated_by: { id: PERSON }, link: 'https://business.facebook.com/x', is_hidden: false,
      payment_account_id: '340000000000001',
      marketing_messages_onboarding_status: { status: 'NOT_ONBOARDED', time: '2026-01-01' }, collaborative_ads_managed_partner_eligibility: { is_eligible: false, reason_code: 3, reason_description: 'Not a seller' },
      collaborative_ads_managed_partner_business_info: { seller_business_status: 'NONE', sales_rep_email: 'rep@example.com' },
    }
  }
  if (req.path === PORTFOLIO && f === BUSINESS_SETTINGS_FIELDS) return { id: PORTFOLIO, name: ' Shop A ', timezone_id: 21, primary_page: { id: PAGE }, vertical: 'RETAIL', two_factor_type: 'none' }
  if (req.path === 'me/businesses') return { data: [{ id: PORTFOLIO, name: 'Shop A', verification_status: 'verified', permitted_roles: ['ADMIN'] }, { id: OTHER_PORTFOLIO, name: 'Shop B' }, { id: '9000000000003', name: 'Agency C' }] }
  if (req.path.endsWith('/owned_domains')) return { data: [{ id: '230000000000001', domain_name: 'shop.example.com', status: 'verified', verification_code: 'abc-secret' }] }
  if (req.path.endsWith('/business_users')) {
    return {
      data: [
        { id: PERSON, name: 'Person A', role: 'ADMIN', two_fac_status: 'enabled', email: 'a@example.com', tasks: ['MANAGE'] },
        { id: '100000000000003', name: 'Person B', role: 'EMPLOYEE', two_fac_status: 'disabled', finance_permission: 'ANALYST' },
      ],
      summary: { total_count: 2 },
    }
  }
  if (req.path.endsWith('/system_users')) return { data: [{ id: SYSTEM_USER, name: 'Nexus system user', role: 'EMPLOYEE', created_by: { id: PERSON } }, { id: '100000000000009', name: 'Admin SU', role: 'ADMIN' }], summary: { total_count: 2 } }
  if (req.path.endsWith('/pending_users')) return { data: [{ id: INVITE, role: 'EMPLOYEE', status: 'PENDING', email: 'new@example.com', invite_link: 'https://business.facebook.com/invitation/?token=x', created_by: { id: PERSON }, tasks: ['ADVERTISE'] }], summary: { total_count: 1 } }
  if (req.path === `${INVITE}/assigned_owned_assets`) {
    if (req.query?.asset_type === 'PAGE') {
      return {
        data: [
          { id: '330000000000001', asset: { id: PAGE_2 }, name: 'Shop A outlet', role: 'MANAGE', permitted_tasks: ['ADVERTISE'] },
          { id: '330000000000002', asset: { id: PAGE_TAKEN }, name: 'Shop B page', role: 'MANAGE' },
          { id: '330000000000003', name: 'No asset id', role: 'MANAGE' },
        ],
      }
    }
    if (req.query?.asset_type === 'PIXEL') return { data: [{ id: '400000000000001', name: 'Pixel A', role: 'EDIT' }] }
    return { data: [] }
  }
  if (req.path === `${INVITE}/assigned_client_assets`) {
    if (req.query?.asset_type === 'PRODUCT_CATALOG') return { data: [{ id: '600000000000002', name: 'Client catalog', role: 'ADVERTISE' }] }
    if (req.query?.asset_type === 'PAGE') return { data: [{ id: '120000000000070', name: 'Nobody picked it', role: 'ADVERTISE' }] }
    return { data: [] }
  }
  if (req.path.endsWith('/finance_permissions')) return { data: [{ finance_permission: 'EDITOR', user: { id: PERSON, name: 'Person A' } }] }
  if (req.path.endsWith('/owned_pages')) return { data: [{ id: PAGE, name: 'Shop A page', is_published: true }, { id: PAGE_2, name: 'Shop A outlet' }, { id: PAGE_TAKEN, name: 'Shop B page' }, { id: '120000000000012_1', name: 'Odd id page' }], summary: { total_count: 4 } }
  if (req.path.endsWith('/client_pages')) return { data: [{ id: '120000000000020', name: 'Client page', permitted_tasks: ['ADVERTISE'] }, { id: '120000000000021', name: 'Shop B other page', business: { id: OTHER_PORTFOLIO } }, { id: '120000000000022', name: 'Owner says us', business: { id: PORTFOLIO } }] }
  if (req.path.endsWith('/pending_owned_pages')) return { data: [{ id: '250000000000001', page: { id: '120000000000030', name: 'Wanted page' }, business: { id: '9000000000007' } }] }
  if (req.path.endsWith('/pending_client_pages')) return { data: [] }
  if (req.path === `${PAGE}/global_brand_children`) return { data: [{ id: '120000000000040', name: 'Shop A DE', business: { id: PORTFOLIO } }, { id: PAGE_TAKEN, name: 'Shop B page' }, { id: '120000000000041', name: 'Unknown child' }, { id: '120000000000042', name: 'Shop B child', business: { id: OTHER_PORTFOLIO } }] }
  if (req.path === `${PAGE}/store_locations`) return { data: [{ id: '260000000000001', store_code: 'S1', full_address: 'Via A 1, Rome', phone_number: '+39 000', hours: { mon_1_open: '09:00' } }] }
  if (req.path.endsWith('/owned_instagram_assets')) return { data: [{ id: IG_ASSET, ig_user_id: IG, ig_username: 'shop_a' }, { id: '180000000000099', ig_user_id: IG_TAKEN, ig_username: 'shop_b' }, { id: '180000000000003', ig_username: 'no_ig_id' }] }
  if (req.path.endsWith('/client_instagram_assets')) return { data: [{ id: '180000000000002', ig_user_id: '170000000000003', ig_username: 'nobody_picked' }] }
  if (req.path.endsWith('/owned_instagram_accounts')) return { data: [{ id: IG, username: 'shop_a' }, { id: '170000000000004', username: 'shop_a_second' }] }
  if (req.path.endsWith('/instagram_accounts') && !req.path.includes('_instagram_accounts')) return { data: [{ id: IG, username: 'shop_a' }, { id: '170000000000002', username: 'shop_b_other', owner_business: { id: OTHER_PORTFOLIO } }, { id: '170000000000005', username: 'owner_unknown' }] }
  if (req.path.endsWith('/instagram_business_accounts')) return { data: [{ id: '170000000000006', username: 'shop_b_second_ig' }, { id: '170000000000007', username: 'third_party_ig', owner_business: { id: '9000000000007' } }, { id: '170000000000008', username: 'owner_says_us', owner_business: { id: PORTFOLIO } }] }
  if (req.path.endsWith('/owned_apps')) return { data: [{ id: NEXUS_APP, name: 'Shop A app', category: 'Business' }, { id: '300000000000004', name: 'Second app' }] }
  if (req.path.endsWith('/client_apps')) return { data: [{ id: APP, name: 'Client app', permitted_tasks: ['DEVELOP'], business: { id: OTHER_PORTFOLIO } }, { id: '300000000000002', name: 'Unknown owner app' }, { id: '300000000000006', name: 'Third-party app', business: { id: '9000000000007' } }, { id: '300000000000007', name: 'Owner says us', business: { id: PORTFOLIO } }, { name: 'No id app', business: { id: '9000000000007' } }] }
  if (req.path.endsWith('/pending_client_apps')) return { data: [{ id: '270000000000001', application: { id: '300000000000003', name: 'Offered app' }, is_requested: false }] }
  if (req.path.endsWith('/business_asset_groups') && !req.path.endsWith('client_business_asset_groups')) return { data: [{ id: GROUP, name: 'Group A' }] }
  if (req.path.endsWith('/client_business_asset_groups')) return { data: [{ id: '220000000000002', name: 'Group B', owner_business: { id: OTHER_PORTFOLIO } }, { id: '220000000000003', name: 'Group C', owner_business: { id: '9000000000007' } }, { id: '220000000000004', name: 'Group D no owner' }] }
  if (req.path.endsWith('/client_objects')) {
    if (req.query?.type === 'page') return { data: [{ id: '120000000000050', name: 'Client page', permitted_tasks: ['ADVERTISE'] }, { id: PAGE_TAKEN, name: 'Shop B page' }, { id: PAGE, name: 'Shop A page' }] }
    if (req.query?.type === 'ad-account') return { data: [{ id: 'act_5550001113', name: 'Shop B second ads' }] }
    return { data: [{ id: '600000000000003', name: 'Some catalog', permitted_tasks: ['ADVERTISE'] }] }
  }
  if (req.path.endsWith('/owned_offsite_signal_container_business_objects')) return { data: [{ id: '280000000000001', name: 'Container A', business: { id: PORTFOLIO } }] }
  if (req.path.endsWith('/client_offsite_signal_container_business_objects')) return { data: [{ id: '280000000000002', name: 'Container B', business: { id: OTHER_PORTFOLIO } }, { id: '280000000000003', name: 'Container C' }, { id: '280000000000004', name: 'Owner says us', business: { id: PORTFOLIO } }] }
  if (req.path.endsWith('/owned_whatsapp_business_accounts')) return { data: [{ id: WABA, name: 'Shop A WhatsApp', status: 'ACTIVE', primary_funding_id: '350000000000001', health_status: { can_send_message: 'AVAILABLE' } }] }
  if (req.path === `${WABA}/phone_numbers`) return { data: [{ id: '290000000000001', display_phone_number: '+39 000 000', verified_name: 'Shop A', quality_rating: 'GREEN' }] }
  if (req.path.endsWith('/agencies')) {
    return {
      data: [
        { id: AGENCY, name: 'Agency A', adaccount_permissions: [{ id: `act_${ACCOUNT}`, permitted_tasks: ['ADVERTISE'], contact_email: 'x@example.com' }, { id: 'act_5550001112', permitted_tasks: ['ANALYZE'] }], page_permissions: [{ id: PAGE_TAKEN, permitted_tasks: ['ADVERTISE'] }], shared_ca_count: 2 },
        { id: OTHER_PORTFOLIO, name: 'Shop B', adaccount_permissions: [] },
      ],
      summary: { total_count: 2 },
    }
  }
  if (req.path.endsWith('/clients')) return { data: [{ id: '9000000000004', name: 'Client D', page_permissions: [{ id: '120000000000060', permitted_tasks: ['ADVERTISE'] }] }, { id: OTHER_PORTFOLIO, name: 'Shop B' }] }
  if (req.path.endsWith('/partners')) return { data: [{ id: AGENCY, name: 'Agency A' }, { id: OTHER_PORTFOLIO, name: 'Shop B' }], summary: { total_count: 2 } }
  if (req.path.endsWith('/partner_relationships')) return { data: [{ id: AGENCY, name: 'Agency A', relationship: ['AGENCY', { type: 'PARTNER', note_email: 'y@example.com' }] }, { id: OTHER_PORTFOLIO, name: 'Shop B', relationship: ['CLIENT'] }] }
  if (req.path.endsWith('_sharing_agreements')) return { data: [{ id: '310000000000001', request_status: 'PENDING' }] }
  if (req.path.endsWith('/owned_businesses')) return { data: [{ id: '9000000000005', name: 'Child A' }, { id: OTHER_PORTFOLIO, name: 'Shop B' }] }
  return { data: [] }
}

beforeEach(() => {
  h.connections = [CHOSEN]; h.calls.length = 0; h.answer = answers; h.taken = []
})

describe('the four tools are reads of Meta', () => {
  it('read only, open world, ads.view; the payment ids are money keys (ad-spend view, as meta-billing)', () => {
    expect(META_ADS_BUSINESS_TOOLS.map((t) => t.name)).toEqual(['meta-business', 'meta-business-people', 'meta-business-assets', 'meta-business-partners'])
    for (const t of META_ADS_BUSINESS_TOOLS) {
      expect({ readOnly: t.readOnly, openWorld: t.openWorld, execute: t.execute, riskTier: t.riskTier, category: t.category }).toEqual({ readOnly: true, openWorld: true, execute: undefined, riskTier: 'low', category: 'insights' })
      expect(t.requires).toEqual(['ads.view'])
      expect(t.description).toMatch(/Read only: Meta is never changed here/)
    }
    expect(tool('meta-business').restrictedFields).toEqual({ paymentAccountId: 'financials.adspend.view' })
    expect(tool('meta-business-assets').restrictedFields).toEqual({ primaryFundingId: 'financials.adspend.view' })
    expect(tool('meta-business-people').restrictedFields).toBeUndefined()
    expect(tool('meta-business-partners').restrictedFields).toBeUndefined()
  })
})

describe('every view asks only what the real gateway lets through', () => {
  it('all views, with made-up answers; never an e-mail, a name part, an invitation link, a verification code or a token', async () => {
    const views: Array<[string, Record<string, unknown>]> = [
      ['meta-business', { view: 'portfolio' }], ['meta-business', { view: 'businesses' }], ['meta-business', { view: 'domains' }],
      ['meta-business-people', { view: 'people' }], ['meta-business-people', { view: 'system-users' }], ['meta-business-people', { view: 'invitations' }],
      ['meta-business-people', { view: 'invitation-assets', invitationId: INVITE }], ['meta-business-people', { view: 'invitation-assets', invitationId: INVITE, assetTypes: ['app', 'whatsapp_business_account', 'owned_domain'] }],
      ['meta-business-people', { view: 'finance' }],
      ['meta-business-assets', { view: 'pages' }], ['meta-business-assets', { view: 'page-children' }], ['meta-business-assets', { view: 'store-locations' }],
      ['meta-business-assets', { view: 'instagram' }], ['meta-business-assets', { view: 'apps' }], ['meta-business-assets', { view: 'asset-groups' }],
      ...Object.keys((await import('../../meta/meta-business-lists.js')).META_CLIENT_OBJECT_TYPES).map((objectType): [string, Record<string, unknown>] => ['meta-business-assets', { view: 'client-objects', objectType }]),
      ['meta-business-assets', { view: 'signal-containers' }], ['meta-business-assets', { view: 'whatsapp' }], ['meta-business-assets', { view: 'whatsapp-numbers', whatsappAccountId: WABA }],
      ['meta-business-partners', { view: 'agencies' }], ['meta-business-partners', { view: 'clients' }], ['meta-business-partners', { view: 'partners' }], ['meta-business-partners', { view: 'relationships' }],
      ['meta-business-partners', { view: 'relationships', includeDeclined: true }], ['meta-business-partners', { view: 'sharing-agreements', status: 'pending', receivingPortfolioId: AGENCY }],
      ['meta-business-partners', { view: 'sharing-agreements', list: 'received', status: 'approve', requestingPortfolioId: AGENCY }],
      ['meta-business-partners', { view: 'child-businesses' }],
    ]
    const failed: unknown[] = []
    const outputs: string[] = []
    for (const [name, args] of views) {
      const res = await run(name, args)
      if (!res.ok) failed.push([name, args, res.error])
      else outputs.push(JSON.stringify(res.data))
    }
    expect(failed).toEqual([])
    const refused = h.calls.map((c) => [c.operation, c.path, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, , problem]) => problem)
    expect(refused).toEqual([])
    const asked = h.calls.map((c) => fieldsOf(c)).join(' ')
    expect(asked).not.toMatch(/email|first_name|last_name|title|invite_link|verification_code|token|secret|sales_rep|credit_limit/)
    // Never an e-mail address, an invitation link or a verification code in what the tools answer, whatever Meta sent.
    expect(outputs.join(' ')).not.toMatch(/@example\.com|invitation\/\?token|abc-secret/)
    // Only the chosen account's portfolio, the system user's own list, the chosen Page, a pending invitation of the portfolio, its WhatsApp account.
    const roots = new Set(h.calls.map((c) => c.path.split('/')[0]))
    expect([...roots].sort()).toEqual([PORTFOLIO, 'me', PAGE, INVITE, WABA].sort())
  })
})

describe('meta-business', () => {
  it('portfolio: the settings, verification in words, the creator by name only when it is Nexus, a retailer\'s contact never shown', async () => {
    const out = data(await run('meta-business', {}))
    expect(out).toMatchObject({ portfolioId: PORTFOLIO, name: 'Shop A', sharedWithAnotherBusiness: false, verification: { status: 'verified', statusText: 'Verified' }, paymentAccountId: '340000000000001' })
    expect(out.settings).toMatchObject({ timeZoneId: 21, vertical: 'RETAIL', twoFactorType: 'admin_required', twoFactorText: 'Required for admins', primaryPage: { pageId: PAGE, chosenHere: true, takenByAnotherBusiness: false } })
    expect(out.createdBy).toEqual({ id: SYSTEM_USER, who: 'Nexus\'s own system user', name: 'Nexus system user' })
    expect(out.updatedBy).toEqual({ id: PERSON, who: expect.stringMatching(/a person or system user/) })
    expect(out.collaborativeAds).toMatchObject({ managedPartnerEligible: false, reason: 'Not a seller', managedPartnerStatus: { seller_business_status: 'NONE' } })
    expect(JSON.stringify(out)).not.toMatch(/rep@example\.com/)
    expect(out.notes.join(' ')).toMatch(/legal name, address, phone number and website/)
    expect(out.notes.join(' ')).toMatch(/Meta documents no API for it/)
  })
  it('portfolio: a group Meta refuses costs only itself; another business\'s primary Page is its id and the flag', async () => {
    h.taken = [{ product: 'PAGE', id: PAGE }]
    h.connections = [{ ...CHOSEN, page: null }]
    h.answer = (req) => {
      const f = fieldsOf(req)
      if (req.path === PORTFOLIO && f.includes('collaborative_ads')) return refusedByMeta('(#100) Tried accessing nonexisting field (collaborative_ads_managed_partner_business_info)')
      return answers(req)
    }
    const out = data(await run('meta-business', { view: 'portfolio' }))
    expect(out.name).toBe('Shop A')
    expect(out.missing).toEqual([{ part: 'collaborativeAds', sentence: expect.stringMatching(/nonexisting field/) }])
    expect(out.settings.primaryPage).toEqual({ pageId: PAGE, takenByAnotherBusiness: true })
  })
  it('A-F2 — portfolio: in a shared portfolio the primary Page (not chosen here) is its id only', async () => {
    h.taken = [SHARED_PORTFOLIO]
    h.connections = [{ ...CHOSEN, page: null }]
    const out = data(await run('meta-business', { view: 'portfolio' }))
    expect(out.sharedWithAnotherBusiness).toBe(true)
    expect(out.settings.primaryPage).toEqual({ pageId: PAGE, takenByAnotherBusiness: null })
  })
  it('readBusinessSettings: exactly the fields step 42 changes, the name exactly as Meta keeps it (A-F7); refused for a shared portfolio before any call (A-F3)', async () => {
    const settings = await readBusinessSettings(await metaChosenAccount())
    expect(settings).toEqual({ portfolioId: PORTFOLIO, name: ' Shop A ', timezoneId: 21, primaryPageId: PAGE, vertical: 'RETAIL', twoFactorType: 'none' })
    expect(h.calls.map((c) => [c.path, fieldsOf(c)])).toEqual([[PORTFOLIO, 'id,name,timezone_id,primary_page{id},vertical,two_factor_type']])
    h.taken = [SHARED_PORTFOLIO]
    h.calls.length = 0
    await expect(readBusinessSettings(await metaChosenAccount())).rejects.toThrow(/does not read its settings for a change/)
    expect(h.calls).toEqual([])
  })
  it('businesses: works before an ad account is chosen; the chosen account\'s portfolio marked, another business\'s portfolio its id only', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }, SHARED_PORTFOLIO]
    const out = data(await run('meta-business', { view: 'businesses' }))
    expect(out.businesses).toEqual([
      expect.objectContaining({ portfolioId: PORTFOLIO, name: 'Shop A', permittedRoles: ['ADMIN'], chosenAccountsPortfolio: true, sharedWithAnotherBusiness: true }),
      { portfolioId: OTHER_PORTFOLIO, takenByAnotherBusiness: true },
      expect.objectContaining({ portfolioId: '9000000000003', name: 'Agency C', chosenAccountsPortfolio: false, takenByAnotherBusiness: false }),
    ])
    h.connections = [{ ...CHOSEN, adAccount: null }]
    h.calls.length = 0
    expect(data(await run('meta-business', { view: 'businesses' })).chosenPortfolioId).toBeNull()
    expect(errorOf(await run('meta-business', { view: 'portfolio' }))).toMatch(/No Meta ad account is chosen/)
  })
  it('domains: never the verification code; a shared portfolio\'s domains are not read (no call)', async () => {
    const out = data(await run('meta-business', { view: 'domains' }))
    expect(out.domains).toEqual([{ domainId: '230000000000001', domain: 'shop.example.com', status: 'verified' }])
    h.taken = [SHARED_PORTFOLIO]
    h.calls.length = 0
    expect(errorOf(await run('meta-business', { view: 'domains' }))).toMatch(/its domains are not read here/)
    expect(h.calls).toEqual([])
  })
  it('a portfolio the chosen ad account does not have is refused in words', async () => {
    h.connections = [{ ...CHOSEN, adAccount: { ...CHOSEN.adAccount, businessId: null } }]
    expect(errorOf(await run('meta-business', { view: 'portfolio' }))).toMatch(/belongs to no Meta business portfolio/)
    expect(h.calls).toEqual([])
  })
})

describe('meta-business-people', () => {
  it('people: names, roles, tasks and two-factor status; the admins counted; never an e-mail', async () => {
    const out = data(await run('meta-business-people', {}))
    expect(out.totalCount).toBe(2)
    expect(out.admins).toBe(1)
    expect(out.people[0]).toEqual({ personId: PERSON, name: 'Person A', role: 'ADMIN', financeRole: null, adsRightsRole: null, twoFactor: 'enabled', tasks: ['MANAGE'], markedForRemoval: null })
    expect(JSON.stringify(out)).not.toMatch(/@example\.com/)
    expect(h.calls[0].query).toMatchObject({ summary: 'total_count' })
  })
  it('A-F4 — tasks Meta did not answer are null, never "no tasks" (people and invitations)', async () => {
    // As Meta does: only the top-level fields asked are answered.
    const asked = (req: Req, body: unknown) => {
      const names = new Set(fieldsOf(req).replace(/\{[^}]*\}/g, '').split(','))
      return { ...(body as Record<string, unknown>), data: ((body as { data?: Array<Record<string, unknown>> }).data ?? []).map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => names.has(k)))) }
    }
    h.answer = (req) => (/tasks/.test(fieldsOf(req)) ? refusedByMeta('(#100) Tried accessing nonexisting field (tasks)') : asked(req, answers(req)))
    const people = await readPortfolioPeople(await metaChosenAccount())
    expect(people.people.map((p) => p.tasks)).toEqual([null, null])
    expect(people.missing).toEqual([{ part: 'sdkOnly', sentence: expect.stringMatching(/Meta refused these details/) }])
    const invitations = await readInvitations(await metaChosenAccount())
    // Re-review step-42 note — each group on its own: the refused tasks group never drops who sent the invitation.
    expect(invitations.invitations[0]).toMatchObject({ invitationId: INVITE, tasks: null, adsRightsRole: null, sdkRead: false, createdBy: { id: PERSON } })
    h.answer = answers
    expect((await readInvitations(await metaChosenAccount())).invitations[0]).toMatchObject({ tasks: ['ADVERTISE'], sdkRead: true })
  })
  it('a shared portfolio\'s people, system users, invitations and finance roles are never read (no call)', async () => {
    h.taken = [SHARED_PORTFOLIO]
    for (const view of ['people', 'system-users', 'invitations', 'finance']) expect(errorOf(await run('meta-business-people', { view })), view).toMatch(/its people are not read here/)
    expect(errorOf(await run('meta-business-people', { view: 'invitation-assets', invitationId: INVITE }))).toMatch(/its people are not read here/)
    expect(h.calls).toEqual([])
    await expect(readPortfolioPeople(await metaChosenAccount())).rejects.toThrow(/not read here/)
  })
  it('system users: Nexus\'s own marked, counted by role, the creator by id; Meta\'s words on the limits and the rename', async () => {
    const out = data(await run('meta-business-people', { view: 'system-users' }))
    expect(out.counts).toEqual({ admin: 1, other: 1 })
    expect(out.systemUsers[0]).toMatchObject({ systemUserId: SYSTEM_USER, nexusSystemUser: true, createdBy: { id: PERSON } })
    expect(out.systemUsers[0].createdBy.name).toBeUndefined()
    expect(out.systemUsers[1].nexusSystemUser).toBe(false)
    expect(out.notes.join(' ')).toMatch(/Ads Management Standard Access/)
    expect(out.notes.join(' ')).toMatch(/Meta documents a rename only/)
    expect((await readSystemUsers(await metaChosenAccount())).systemUsers).toHaveLength(2)
  })
  it('B-F3 — system users refused for an Employee token: Meta\'s words and the admin-token note', async () => {
    h.answer = (req) => (req.path.endsWith('/system_users') ? refusedByMeta('(#200) Requires an admin', '200', 'forbidden') : answers(req))
    expect(errorOf(await run('meta-business-people', { view: 'system-users' }))).toMatch(/admin user's or an admin system user's token/)
  })
  it('invitations: role, status, who sent it by id; never the address or the invitation link', async () => {
    const out = data(await run('meta-business-people', { view: 'invitations' }))
    expect(out.invitations).toEqual([expect.objectContaining({ invitationId: INVITE, role: 'EMPLOYEE', status: 'PENDING', createdBy: { id: PERSON, who: expect.any(String) } })])
    expect(JSON.stringify(out)).not.toMatch(/new@example\.com|invitation\/\?token/)
    expect((await readInvitations(await metaChosenAccount())).invitations[0]).toMatchObject({ invitationId: INVITE, createdBy: { id: PERSON } })
  })
  it('invitation-assets: only an invitation of the portfolio; every asset type on both edges; owned Pages named only by Meta\'s asset id; client assets ids only', async () => {
    expect(errorOf(await run('meta-business-people', { view: 'invitation-assets', invitationId: '200000000000999' }))).toMatch(/not a pending invitation/)
    expect(h.calls.some((c) => /assigned_/.test(c.path))).toBe(false)
    expect(errorOf(await run('meta-business-people', { view: 'invitation-assets' }))).toMatch(/Name the invitation/)
    h.calls.length = 0
    h.taken = [{ product: 'PAGE', id: PAGE_TAKEN }]
    const out = data(await run('meta-business-people', { view: 'invitation-assets', invitationId: INVITE }))
    const asked = h.calls.filter((c) => /assigned_/.test(c.path)).map((c) => `${c.path.split('/')[1]} ${c.query?.asset_type}`)
    expect(asked.sort()).toEqual(['AD_ACCOUNT', 'PAGE', 'INSTAGRAM_ACCOUNT_V2', 'PRODUCT_CATALOG', 'PIXEL'].flatMap((t) => [`assigned_client_assets ${t}`, `assigned_owned_assets ${t}`]).sort())
    // The owned Page / IG / ad account reads ask Meta's asset{id} in its own group; the client ones do not.
    expect(h.calls.filter((c) => /assigned_owned_assets/.test(c.path) && c.query?.asset_type === 'PAGE').map(fieldsOf)).toEqual(['id,role,permitted_tasks,name,asset{id}'])
    expect(h.calls.filter((c) => /assigned_client_assets/.test(c.path)).every((c) => !/asset\{/.test(fieldsOf(c)))).toBe(true)
    expect(out.assets.PAGE.owned).toEqual([
      { id: '330000000000001', assetId: PAGE_2, name: 'Shop A outlet', role: 'MANAGE', tasks: ['ADVERTISE'], takenByAnotherBusiness: false },
      { id: '330000000000002', takenByAnotherBusiness: true },
      // No asset id from Meta: Nexus cannot check it (B-F7).
      { id: '330000000000003', tasks: [], takenByAnotherBusiness: null },
    ])
    expect(out.assets.PIXEL.owned).toEqual([{ id: '400000000000001', name: 'Pixel A', role: 'EDIT', tasks: [], takenByAnotherBusiness: false }])
    // A-F1 S5 / B-F7 — a client Page nobody picked, and a client catalog: ids only.
    expect(out.assets.PAGE.client).toEqual([{ id: '120000000000070', tasks: [], takenByAnotherBusiness: null }])
    expect(out.assets.PRODUCT_CATALOG.client).toEqual([{ id: '600000000000002', tasks: [], takenByAnotherBusiness: null }])
  })
  it('invitation-assets: a refused asset type costs only itself', async () => {
    h.answer = (req) => (req.query?.asset_type === 'PIXEL' ? refusedByMeta('(#100) Invalid parameter') : answers(req))
    const out = data(await run('meta-business-people', { view: 'invitation-assets', invitationId: INVITE, assetTypes: ['page', 'pixel'] }))
    expect(out.assets.PAGE.owned).toHaveLength(3)
    expect(out.assets.PIXEL).toEqual({ owned: null, client: null })
    expect(out.missing.map((m: { part: string }) => m.part)).toEqual(['PIXEL owned', 'PIXEL client'])
  })
  it('finance: who holds a finance role; a refused user{id,name} is read whole once (B-F11)', async () => {
    expect(data(await run('meta-business-people', { view: 'finance' })).financeRoles).toEqual([{ personId: PERSON, name: 'Person A', financeRole: 'EDITOR' }])
    h.answer = (req) => (req.path.endsWith('/finance_permissions') && fieldsOf(req).includes('user{') ? refusedByMeta('(#100) Unknown fields') : answers(req))
    h.calls.length = 0
    const out = data(await run('meta-business-people', { view: 'finance' }))
    expect(out.financeRoles).toEqual([{ personId: PERSON, name: 'Person A', financeRole: 'EDITOR' }])
    expect(h.calls.map(fieldsOf)).toEqual(['finance_permission,user{id,name}', 'finance_permission,user'])
    expect(out.missing).toEqual([{ part: 'user', sentence: expect.stringMatching(/read whole/) }])
  })
})

describe('meta-business-assets', () => {
  it('pages: owned named, another business\'s Page its id only; a client Page named only with an owner Meta named; pending ids only; a refused list costs only itself', async () => {
    h.taken = [{ product: 'PAGE', id: PAGE_TAKEN }]
    h.answer = (req) => (req.path.endsWith('/pending_client_pages') ? refusedByMeta('(#200) Requires an admin system user', '200', 'forbidden') : answers(req))
    const out = data(await run('meta-business-assets', {}))
    expect(listOf(out, 'owned_pages')).toEqual([
      expect.objectContaining({ pageId: PAGE, name: 'Shop A page', chosenHere: true, published: true, takenByAnotherBusiness: false }),
      expect.objectContaining({ pageId: PAGE_2, name: 'Shop A outlet', chosenHere: false, takenByAnotherBusiness: false }),
      { pageId: PAGE_TAKEN, takenByAnotherBusiness: true },
      // Re-review N2 — a Page id Nexus cannot check (not digits): its id only, even in the owned list.
      { pageId: '120000000000012_1', takenByAnotherBusiness: null },
    ])
    expect(listOf(out, 'client_pages')).toEqual([
      // A-F1 — no owner from Meta: its id only, never "false".
      { pageId: '120000000000020', permittedTasks: ['ADVERTISE'], takenByAnotherBusiness: null },
      expect.objectContaining({ pageId: '120000000000021', name: 'Shop B other page', takenByAnotherBusiness: false }),
      // Re-review N3 — a client row whose "owner" is this very portfolio: its id only.
      { pageId: '120000000000022', takenByAnotherBusiness: null },
    ])
    // Re-review N6 — a field the read did not ask (a pending row's business) is never taken as its owner.
    expect(listOf(out, 'pending_owned_pages')).toEqual([{ requestId: '250000000000001', pageId: '120000000000030', takenByAnotherBusiness: null }])
    expect(out.missing).toEqual([{ part: 'pending_client_pages', sentence: expect.stringMatching(/admin system user/) }])
    expect(out.lists.find((l: { list: string }) => l.list === 'owned').totalCount).toBe(4)
  })
  it('pages: a shared portfolio shows every Page but the chosen one by id only; list picks one list', async () => {
    h.taken = [SHARED_PORTFOLIO]
    const out = data(await run('meta-business-assets', { view: 'pages', list: 'owned' }))
    expect(h.calls.map((c) => c.path)).toEqual([`${PORTFOLIO}/owned_pages`])
    expect(out.lists[0].items).toEqual([
      expect.objectContaining({ pageId: PAGE, name: 'Shop A page', takenByAnotherBusiness: false }),
      { pageId: PAGE_2, takenByAnotherBusiness: null },
      { pageId: PAGE_TAKEN, takenByAnotherBusiness: null },
      { pageId: '120000000000012_1', takenByAnotherBusiness: null },
    ])
    expect(errorOf(await run('meta-business-assets', { view: 'apps', list: 'pending-owned' }))).toMatch(/not one of this view/)
    expect(errorOf(await run('meta-business-assets', { view: 'whatsapp', list: 'owned' }))).toMatch(/has no lists/)
  })
  it('pages and Instagram: one whose owner portfolio another business in Nexus uses is its id and the flag', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    const pages = data(await run('meta-business-assets', { view: 'pages', list: 'client' }))
    expect(pages.lists[0].items).toEqual([{ pageId: '120000000000020', permittedTasks: ['ADVERTISE'], takenByAnotherBusiness: null }, { pageId: '120000000000021', takenByAnotherBusiness: true }, { pageId: '120000000000022', takenByAnotherBusiness: null }])
    expect(fieldsOf(h.calls[h.calls.length - 1])).toMatch(/business\{id\}$/)
    const ig = data(await run('meta-business-assets', { view: 'instagram', list: 'all' }))
    expect(ig.lists[0].items).toEqual([
      { instagramId: IG, username: 'shop_a', chosenHere: true, takenByAnotherBusiness: false },
      { instagramId: '170000000000002', takenByAnotherBusiness: true },
      // A-F1 — no owner from Meta: its id only.
      { instagramId: '170000000000005', takenByAnotherBusiness: null },
    ])
  })
  it('A-F1 S1 / B-F12 — a refused details field never drops the owner: each group of a list is read on its own', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    h.answer = (req) => (req.path.endsWith('/client_pages') && /verification_status/.test(fieldsOf(req)) ? refusedByMeta('(#100) Tried accessing nonexisting field (verification_status)') : answers(req))
    const out = data(await run('meta-business-assets', { view: 'pages', list: 'client' }))
    expect(out.lists[0].items).toEqual([{ pageId: '120000000000020', permittedTasks: ['ADVERTISE'], takenByAnotherBusiness: null }, { pageId: '120000000000021', takenByAnotherBusiness: true }, { pageId: '120000000000022', takenByAnotherBusiness: null }])
    expect(out.missing).toEqual([{ part: 'client_pages verification', sentence: expect.stringMatching(/verification_status/) }])
    expect(h.calls.map(fieldsOf)).toEqual([
      'id,name,permitted_tasks,category,link,is_published,verification_status,business{id}', 'id,name,permitted_tasks', 'id,category,link,is_published', 'id,verification_status', 'id,business{id}',
    ])
  })
  it('pages: when Meta refuses the owner of a client Page, the details still answer and every client Page is its id only', async () => {
    h.answer = (req) => (req.path.endsWith('/client_pages') && /business\{id\}/.test(fieldsOf(req)) ? refusedByMeta('(#200) Requires admin of the page', '200', 'forbidden') : answers(req))
    const out = data(await run('meta-business-assets', { view: 'pages', list: 'client' }))
    expect(out.lists[0].items).toEqual([{ pageId: '120000000000020', permittedTasks: ['ADVERTISE'], takenByAnotherBusiness: null }, { pageId: '120000000000021', takenByAnotherBusiness: null }, { pageId: '120000000000022', takenByAnotherBusiness: null }])
    expect(out.missing.map((m: { part: string }) => m.part)).toEqual(['client_pages owner'])
  })
  it('re-review N2 — page-children: in a shared portfolio a child owned here is its id only', async () => {
    h.taken = [SHARED_PORTFOLIO]
    const kids = data(await run('meta-business-assets', { view: 'page-children' }))
    expect(kids.children[0]).toEqual({ pageId: '120000000000040', takenByAnotherBusiness: null })
  })
  it('page-children and store-locations: the chosen Page only; a child named only when Meta names its owner; none chosen → refused before any call', async () => {
    h.taken = [{ product: 'PAGE', id: PAGE_TAKEN }, { product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    const kids = data(await run('meta-business-assets', { view: 'page-children' }))
    expect(kids.children).toEqual([
      { pageId: '120000000000040', name: 'Shop A DE', link: null, takenByAnotherBusiness: false },
      { pageId: PAGE_TAKEN, takenByAnotherBusiness: true },
      { pageId: '120000000000041', takenByAnotherBusiness: null },
      // Re-review N2 — a child whose owner portfolio another business in Nexus uses (it picked no Page of it): id and flag.
      { pageId: '120000000000042', takenByAnotherBusiness: true },
    ])
    const stores = data(await run('meta-business-assets', { view: 'store-locations' }))
    expect(stores.storeLocations[0]).toMatchObject({ storeLocationId: '260000000000001', storeCode: 'S1', address: 'Via A 1, Rome', hours: { mon1Open: '09:00' } })
    expect(stores.notes.join(' ')).toMatch(/Page Locations API/)
    h.connections = [{ ...CHOSEN, page: null }]
    h.calls.length = 0
    expect(errorOf(await run('meta-business-assets', { view: 'page-children' }))).toMatch(/No Facebook Page is chosen/)
    expect(h.calls).toEqual([])
  })
  it('a Page read Meta refuses for the token says what that means', async () => {
    h.answer = (req) => (req.path.endsWith('/global_brand_children') ? refusedByMeta('(#200) Requires MANAGE task', '200', 'forbidden') : answers(req))
    // Live-probe fix MD-101 — in the Page's words (Meta's, then what the Page needs), never the ad account's ads_read hint.
    const words = errorOf(await run('meta-business-assets', { view: 'page-children' }))
    expect(words).toMatch(/Meta refused this Facebook Page or Instagram read .*Requires MANAGE task.*What Meta needs: the business's chosen Facebook Page/)
    expect(words).not.toMatch(/ads_read|the ad account is assigned/)
  })
  it('instagram: owned assets named by a checkable Instagram id; a client asset and an asset without ig_user_id are ids only (A-F1 S2, S3)', async () => {
    h.taken = [{ product: 'INSTAGRAM', id: IG_TAKEN }]
    const out = data(await run('meta-business-assets', { view: 'instagram' }))
    expect(out.lists.map((l: { edge: string }) => l.edge)).toEqual(['owned_instagram_assets', 'client_instagram_assets', 'owned_instagram_accounts', 'client_instagram_accounts', 'instagram_accounts', 'instagram_business_accounts'])
    expect(listOf(out, 'owned_instagram_assets')).toEqual([
      { businessAssetId: IG_ASSET, instagramId: IG, username: 'shop_a', chosenHere: true, ownedByThisPortfolio: true, takenByAnotherBusiness: false },
      { instagramId: IG_TAKEN, takenByAnotherBusiness: true },
      { businessAssetId: '180000000000003', instagramId: null, takenByAnotherBusiness: null },
    ])
    expect(listOf(out, 'client_instagram_assets')).toEqual([{ businessAssetId: '180000000000002', instagramId: '170000000000003', takenByAnotherBusiness: null }])
    expect(listOf(out, 'owned_instagram_accounts')).toEqual([{ instagramId: IG, username: 'shop_a', chosenHere: true, takenByAnotherBusiness: false }, { instagramId: '170000000000004', username: 'shop_a_second', chosenHere: false, takenByAnotherBusiness: false }])
  })
  it('A-F2 — instagram: in a shared portfolio every account but the chosen one is its id only', async () => {
    h.taken = [SHARED_PORTFOLIO]
    const out = data(await run('meta-business-assets', { view: 'instagram', list: 'owned' }))
    expect(out.lists[0].items).toEqual([{ instagramId: IG, username: 'shop_a', chosenHere: true, takenByAnotherBusiness: false }, { instagramId: '170000000000004', takenByAnotherBusiness: null }])
  })
  it('re-review N1 / N3 — converted Instagram accounts are not owned: named only with an owner Meta names, never this very portfolio', async () => {
    const out = data(await run('meta-business-assets', { view: 'instagram', list: 'converted' }))
    expect(h.calls.map(fieldsOf)).toEqual(['id,username,owner_business{id}'])
    expect(out.lists[0].items).toEqual([
      { instagramId: '170000000000006', takenByAnotherBusiness: null },
      { instagramId: '170000000000007', username: 'third_party_ig', chosenHere: false, takenByAnotherBusiness: false },
      { instagramId: '170000000000008', takenByAnotherBusiness: null },
    ])
  })
  it('apps: Nexus\'s app marked and owned here; a client app of another business\'s portfolio flagged; named only with an owner Meta named; pending ids only', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    const out = data(await run('meta-business-assets', { view: 'apps' }))
    expect(out.nexusAppOwnedByThisPortfolio).toBe(true)
    expect(listOf(out, 'owned_apps')).toEqual([
      { appId: NEXUS_APP, name: 'Shop A app', category: 'Business', link: null, nexusApp: true, takenByAnotherBusiness: false },
      { appId: '300000000000004', name: 'Second app', category: null, link: null, nexusApp: false, takenByAnotherBusiness: false },
    ])
    expect(listOf(out, 'client_apps')).toEqual([
      { appId: APP, takenByAnotherBusiness: true },
      { appId: '300000000000002', takenByAnotherBusiness: null },
      { appId: '300000000000006', name: 'Third-party app', nexusApp: false, takenByAnotherBusiness: false },
      // Re-review N3 / N6 — an "owner" that is this very portfolio, and a row without an id: never named.
      { appId: '300000000000007', takenByAnotherBusiness: null },
      { appId: null, takenByAnotherBusiness: null },
    ])
    expect(listOf(out, 'pending_client_apps')).toEqual([{ requestId: '270000000000001', appId: '300000000000003', requestedByThisPortfolio: false, takenByAnotherBusiness: null }])
  })
  it('A-F6 — whether this portfolio owns Nexus\'s app: null when the owned list was cut, false only when it was read whole', async () => {
    h.answer = (req) => (req.path.endsWith('/owned_apps') ? { data: [{ id: '300000000000004', name: 'Second app' }], paging: { cursors: { after: 'next-page' }, next: 'https://graph.facebook.com/next' } } : answers(req))
    expect(data(await run('meta-business-assets', { view: 'apps', list: 'owned', maxRows: 1 })).nexusAppOwnedByThisPortfolio).toBeNull()
    h.answer = (req) => (req.path.endsWith('/owned_apps') ? { data: [{ id: '300000000000004', name: 'Second app' }] } : answers(req))
    expect(data(await run('meta-business-assets', { view: 'apps', list: 'owned' })).nexusAppOwnedByThisPortfolio).toBe(false)
  })
  it('A-F2 — apps: in a shared portfolio every app but Nexus\'s own is its id only', async () => {
    h.taken = [SHARED_PORTFOLIO]
    const out = data(await run('meta-business-assets', { view: 'apps', list: 'owned' }))
    expect(out.lists[0].items).toEqual([expect.objectContaining({ appId: NEXUS_APP, nexusApp: true, takenByAnotherBusiness: false }), { appId: '300000000000004', takenByAnotherBusiness: null }])
  })
  it('asset groups: owned named; a client group of another business\'s portfolio flagged; one of a third party named with its owner', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    const out = data(await run('meta-business-assets', { view: 'asset-groups' }))
    expect(out.lists[0].items).toEqual([{ assetGroupId: GROUP, name: 'Group A', takenByAnotherBusiness: false }])
    expect(out.lists[1].items).toEqual([
      { assetGroupId: '220000000000002', takenByAnotherBusiness: true }, { assetGroupId: '220000000000003', name: 'Group C', ownerPortfolioId: '9000000000007', takenByAnotherBusiness: false },
      // Re-review N2 — a client group Meta names no owner for: its id only.
      { assetGroupId: '220000000000004', takenByAnotherBusiness: null },
    ])
  })
  it('A-F2 — asset groups: in a shared portfolio each group is its id only', async () => {
    h.taken = [SHARED_PORTFOLIO]
    const out = data(await run('meta-business-assets', { view: 'asset-groups', list: 'owned' }))
    expect(out.lists[0].items).toEqual([{ assetGroupId: GROUP, takenByAnotherBusiness: null }])
  })
  it('client-objects: one Meta type per read, as Meta spells it; ids only but for the asset chosen here (B-F7, A-F1 S4)', async () => {
    expect(errorOf(await run('meta-business-assets', { view: 'client-objects' }))).toMatch(/Name the kind of client object/)
    h.taken = [{ product: 'PAGE', id: PAGE_TAKEN }, { product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    const pages = data(await run('meta-business-assets', { view: 'client-objects', objectType: 'page' }))
    expect(pages.objects).toEqual([
      { objectId: '120000000000050', permittedTasks: ['ADVERTISE'], takenByAnotherBusiness: null },
      { objectId: PAGE_TAKEN, permittedTasks: [], takenByAnotherBusiness: null },
      { objectId: PAGE, name: 'Shop A page', permittedTasks: [], takenByAnotherBusiness: false },
    ])
    const accounts = data(await run('meta-business-assets', { view: 'client-objects', objectType: 'ad-account' }))
    expect(accounts.objects).toEqual([{ objectId: '5550001113', permittedTasks: [], takenByAnotherBusiness: null }])
    const catalogs = data(await run('meta-business-assets', { view: 'client-objects', objectType: 'catalog' }))
    expect(catalogs.objects).toEqual([{ objectId: '600000000000003', permittedTasks: ['ADVERTISE'], takenByAnotherBusiness: null }])
    expect(h.calls.filter((c) => c.path.endsWith('/client_objects')).map((c) => c.query?.type)).toEqual(['page', 'ad-account', 'product-catalog'])
  })
  it('A-F2 — client-objects: in a shared portfolio ids only, the chosen asset still named', async () => {
    h.taken = [SHARED_PORTFOLIO]
    const out = data(await run('meta-business-assets', { view: 'client-objects', objectType: 'page' }))
    expect(out.objects.map((o: { takenByAnotherBusiness: unknown }) => o.takenByAnotherBusiness)).toEqual([null, null, false])
  })
  it('signal containers: owned named; a client one of another business\'s portfolio flagged (A-F2); without an owner its id only', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    const out = data(await run('meta-business-assets', { view: 'signal-containers' }))
    expect(listOf(out, 'owned_offsite_signal_container_business_objects')).toEqual([expect.objectContaining({ containerId: '280000000000001', name: 'Container A', takenByAnotherBusiness: false })])
    expect(listOf(out, 'client_offsite_signal_container_business_objects')).toEqual([{ containerId: '280000000000002', takenByAnotherBusiness: true }, { containerId: '280000000000003', takenByAnotherBusiness: null }, { containerId: '280000000000004', takenByAnotherBusiness: null }])
  })
  it('A-F2 — signal containers: in a shared portfolio each container is its id only', async () => {
    h.taken = [SHARED_PORTFOLIO]
    const out = data(await run('meta-business-assets', { view: 'signal-containers', list: 'owned' }))
    expect(out.lists[0].items).toEqual([{ containerId: '280000000000001', takenByAnotherBusiness: null }])
  })
  it('whatsapp: accounts and health; numbers only of a WhatsApp account of the portfolio, never of a shared one; a permission refusal says why', async () => {
    const accounts = data(await run('meta-business-assets', { view: 'whatsapp' }))
    expect(accounts.whatsappAccounts).toEqual([expect.objectContaining({ whatsappAccountId: WABA, name: 'Shop A WhatsApp', status: 'ACTIVE', primaryFundingId: '350000000000001', health: { canSendMessage: 'AVAILABLE' } })])
    const numbers = data(await run('meta-business-assets', { view: 'whatsapp-numbers', whatsappAccountId: WABA }))
    expect(numbers.numbers).toEqual([{ phoneNumberId: '290000000000001', displayNumber: '+39 000 000', verifiedName: 'Shop A', quality: 'GREEN', codeVerification: null, nameStatus: null }])
    expect(numbers.notes.join(' ')).toMatch(/NA \/ UNKNOWN/)
    h.calls.length = 0
    expect(errorOf(await run('meta-business-assets', { view: 'whatsapp-numbers', whatsappAccountId: '210000000000999' }))).toMatch(/not a WhatsApp Business Account of the chosen/)
    expect(h.calls.some((c) => c.path.endsWith('/phone_numbers'))).toBe(false)
    h.taken = [SHARED_PORTFOLIO]
    h.calls.length = 0
    expect(errorOf(await run('meta-business-assets', { view: 'whatsapp-numbers', whatsappAccountId: WABA }))).toMatch(/cannot tell whose WhatsApp account/)
    expect(h.calls).toEqual([])
    expect(data(await run('meta-business-assets', { view: 'whatsapp' })).whatsappAccounts).toEqual([{ whatsappAccountId: WABA, takenByAnotherBusiness: null }])
    h.taken = []
    h.answer = (req) => (req.path.endsWith('/owned_whatsapp_business_accounts') ? refusedByMeta('(#200) Requires whatsapp_business_management permission', '200', 'forbidden') : answers(req))
    expect(errorOf(await run('meta-business-assets', { view: 'whatsapp' }))).toMatch(/ADMIN system user's token with the whatsapp_business_management permission \(which may need Advanced Access\)/)
  })
})

describe('meta-business-partners', () => {
  it('agencies: another business\'s portfolio its id only; an ad account or Page another business picked its id only; only plain words of each permission', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }, { product: 'PAGE', id: PAGE_TAKEN }, { product: 'AD_ACCOUNT', id: '5550001112' }]
    const out = data(await run('meta-business-partners', {}))
    expect(out.partners).toEqual([
      {
        portfolioId: AGENCY, name: 'Agency A', takenByAnotherBusiness: false,
        adAccounts: [{ id: ACCOUNT, permitted_tasks: ['ADVERTISE'], takenByAnotherBusiness: false }, { id: '5550001112', takenByAnotherBusiness: true }],
        pages: [{ id: PAGE_TAKEN, takenByAnotherBusiness: true }], sharedAudiences: 2,
      },
      { portfolioId: OTHER_PORTFOLIO, takenByAnotherBusiness: true },
    ])
    expect(JSON.stringify(out)).not.toMatch(/@example\.com/)
  })
  it('a shared portfolio\'s partners are never read (no call)', async () => {
    h.taken = [SHARED_PORTFOLIO]
    for (const view of ['agencies', 'clients', 'partners', 'relationships', 'sharing-agreements', 'child-businesses']) expect(errorOf(await run('meta-business-partners', { view })), view).toMatch(/its partners are not read here/)
    expect(h.calls).toEqual([])
  })
  it('B-F1 — partners: the portfolios that work with this one, another business\'s portfolio its id only', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    const out = data(await run('meta-business-partners', { view: 'partners' }))
    expect(out).toMatchObject({ totalCount: 2, partners: [{ portfolioId: AGENCY, name: 'Agency A', takenByAnotherBusiness: false }, { portfolioId: OTHER_PORTFOLIO, takenByAnotherBusiness: true }] })
    expect(h.calls.map((c) => [c.path, fieldsOf(c)])).toEqual([[`${PORTFOLIO}/partners`, 'id,name']])
  })
  it('relationships: declined requests left out unless asked; the relationship in plain words only; a taken partner its id only (A-F2)', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    const out = data(await run('meta-business-partners', { view: 'relationships' }))
    expect(out.partners).toEqual([{ portfolioId: AGENCY, name: 'Agency A', relationship: ['AGENCY', { type: 'PARTNER' }], takenByAnotherBusiness: false }, { portfolioId: OTHER_PORTFOLIO, takenByAnotherBusiness: true }])
    await run('meta-business-partners', { view: 'relationships', includeDeclined: true })
    expect(h.calls.filter((c) => c.path.endsWith('/partner_relationships')).map((c) => c.query?.exclude_declined_requests)).toEqual([true, false])
  })
  it('sharing agreements: initiated and received (B-F1), each with its own partner filter; a filter on the wrong list or view refused', async () => {
    const out = data(await run('meta-business-partners', { view: 'sharing-agreements', status: 'pending' }))
    expect(out).toMatchObject({ list: 'initiated', agreements: [{ agreementId: '310000000000001', status: 'PENDING' }] })
    expect(h.calls[h.calls.length - 1]).toMatchObject({ path: `${PORTFOLIO}/initiated_sharing_agreements`, query: { request_status: 'PENDING', fields: 'id,request_status' } })
    const received = data(await run('meta-business-partners', { view: 'sharing-agreements', list: 'received', requestingPortfolioId: AGENCY }))
    expect(received).toMatchObject({ list: 'received', requestingPortfolioId: AGENCY })
    expect(h.calls[h.calls.length - 1]).toMatchObject({ path: `${PORTFOLIO}/received_sharing_agreements`, query: { requesting_business_id: AGENCY } })
    h.calls.length = 0
    expect(errorOf(await run('meta-business-partners', { view: 'sharing-agreements', list: 'received', receivingPortfolioId: AGENCY }))).toMatch(/requestingPortfolioId/)
    expect(errorOf(await run('meta-business-partners', { view: 'sharing-agreements', requestingPortfolioId: AGENCY }))).toMatch(/receivingPortfolioId/)
    expect(errorOf(await run('meta-business-partners', { view: 'agencies', list: 'received' }))).toMatch(/are for view sharing-agreements/)
    expect(h.calls).toEqual([])
  })
  it('re-review N5 — a sharing-agreements filter naming another business\'s portfolio is refused before any call', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    expect(errorOf(await run('meta-business-partners', { view: 'sharing-agreements', receivingPortfolioId: OTHER_PORTFOLIO }))).toMatch(/agreements with it are not read here/)
    expect(errorOf(await run('meta-business-partners', { view: 'sharing-agreements', list: 'received', requestingPortfolioId: OTHER_PORTFOLIO }))).toMatch(/agreements with it are not read here/)
    expect(h.calls).toEqual([])
  })
  it('A-F2 — child businesses: another business\'s portfolio its id only', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    const out = data(await run('meta-business-partners', { view: 'child-businesses' }))
    expect(out.childBusinesses).toEqual([expect.objectContaining({ portfolioId: '9000000000005', name: 'Child A', takenByAnotherBusiness: false }), { portfolioId: OTHER_PORTFOLIO, takenByAnotherBusiness: true }])
  })
  it('clients: a client portfolio another business in Nexus uses is its id only', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    const out = data(await run('meta-business-partners', { view: 'clients' }))
    expect(out.partners[1]).toEqual({ portfolioId: OTHER_PORTFOLIO, takenByAnotherBusiness: true })
    // Re-review N8 — a client's own Page Nexus cannot check: null, not false.
    expect(out.partners[0]).toMatchObject({ portfolioId: '9000000000004', pages: [{ id: '120000000000060', permitted_tasks: ['ADVERTISE'], takenByAnotherBusiness: null }] })
  })
})

describe('the one rule and the plain-words filter', () => {
  it('seenAs: chosen, taken, shared, not checkable, owned, owner named — in that order', () => {
    expect(seenAs({ chosen: true, taken: true, shared: true, ownedHere: false })).toBe('details')
    expect(seenAs({ taken: true, shared: false, ownedHere: true })).toBe('taken')
    expect(seenAs({ ownerTaken: true, shared: false, ownedHere: false, ownerNamed: true })).toBe('taken')
    expect(seenAs({ shared: true, ownedHere: true })).toBe('idOnly')
    expect(seenAs({ shared: false, ownedHere: true, checkable: false })).toBe('idOnly')
    expect(seenAs({ shared: false, ownedHere: true })).toBe('details')
    expect(seenAs({ shared: false, ownedHere: false, ownerNamed: true })).toBe('details')
    // Not owned here and no owner Meta named: unknown, even for a Page Nexus's table does not know (A-F1).
    expect(seenAs({ shared: false, ownedHere: false })).toBe('idOnly')
    expect(seenAs({ shared: false, ownedHere: false, checkable: true })).toBe('idOnly')
  })
  it('plainOf: scalars under plain keys only; never a nested object, an e-mail, a link, a code or a token key', () => {
    expect(plainOf({ type: 'AGENCY', count: 2, ok: true, tasks: ['A', 'b@example.com'], nested: { x: 1 }, contact_email: 'x', page_url: 'u', access_token: 't', invite_code: 'c', Bad: 'y', note: 'z@example.com' }))
      .toEqual({ type: 'AGENCY', count: 2, ok: true, tasks: ['A'] })
    expect(plainOf('words')).toBeNull()
  })
})
