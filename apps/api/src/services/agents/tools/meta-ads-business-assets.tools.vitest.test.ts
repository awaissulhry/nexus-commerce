/**
 * Meta ads step 43 — set-meta-business-assets, remove-meta-business-asset, create-meta-ad-account, create-meta-appeal and
 * set-meta-billing (D1 = A).
 * They are READS: no write of any kind reaches Meta (the read client is the only way out, and every call is a GET the real
 * gateway lets through), only the chosen ad account's business portfolio is read, nothing at all when another business in
 * Nexus uses it, an asset another business uses gets no steps, never an e-mail field; a guide asked again reads the result.
 * Meta and the database are stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ operation: string; path: string; query?: Record<string, unknown> }>,
  answer: null as null | ((req: { operation: string; path: string; query?: Record<string, unknown> }) => unknown),
  taken: [] as Array<{ product: string; id: string }>,
  state: { status: 1, disableReason: 0, name: 'Shop A ads' } as Record<string, unknown>,
  stateCalls: 0,
  own: { adAccounts: ['1234567890'], pages: ['120000000000010'], instagram: [] } as { adAccounts: string[] | null; pages: string[] | null; instagram: string[] | null },
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
// Step 41's account read (its own test covers its request): here only the status it names.
vi.mock('../../marketing/meta-ads/live-access-change.js', () => ({
  liveAccessState: vi.fn(async () => { h.stateCalls++; return { ...h.state } }),
  // Step 41's read of the portfolio's own ad accounts, Pages and Instagram accounts (its own test covers its requests).
  livePortfolioOwnAssets: vi.fn(async () => structuredClone(h.own)),
}))
vi.mock('../../../db.js', () => ({
  default: {
    // nexus_meta_links_taken(product, ids): the ids of that product another business picked.
    $queryRaw: vi.fn(async (_s: unknown, product: string, ids: string[]) => h.taken.filter((t) => t.product === product && ids.includes(t.id)).map((t) => ({ id: t.id }))),
  },
}))

import { META_ADS_BUSINESS_ASSETS_TOOLS } from './meta-ads-business-assets.tools.js'
import { ASSETS_SHARED, BILLING_SHARED } from '../../marketing/meta-ads/live-business-assets-admin.js'
import { ONE_INVOICE_GROUP } from '../../marketing/meta-ads/business-assets-admin.js'
import { BUSINESS_SETTINGS_FIELDS } from '../../marketing/meta-ads/live-business.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const tool = (name: string) => META_ADS_BUSINESS_ASSETS_TOOLS.find((t) => t.name === name)!
const ctx = { can: () => true, via: 'claude' as const }
const run = (name: string, args: Record<string, unknown>) => tool(name).handler(tool(name).input.parse(args), ctx as never)
const fieldsOf = (req: Req) => String(req.query?.fields ?? '')
const data = (res: { ok: boolean; data?: unknown; error?: string }) => { if (!res.ok) throw new Error(res.error); return res.data as Record<string, any> }
const errorOf = (res: { ok: boolean; error?: string }) => { if (res.ok) throw new Error('expected a refusal'); return res.error! }

const ACCOUNT = '1234567890'
const OTHER_ACCOUNT = '1234567891'
const PORTFOLIO = '9876543210'
const OTHER_PORTFOLIO = '9876543211'
const PAGE = '120000000000010'
const PAGE_2 = '120000000000011'
const CLIENT_PAGE = '120000000000012'
const IG = '17840000000000001'
const LINE = '120000000000300'
const GROUP_A = '120000000000310'
const GROUP_B = '120000000000311'
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok', systemUser: { id: '100000000000001', name: 'Nexus system user' }, appId: '300000000000009',
  adAccount: { adAccountId: ACCOUNT, name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: PORTFOLIO },
  page: { pageId: PAGE, name: 'Shop A page' }, instagram: { instagramId: IG, username: 'shop_a' }, read: {}, token: { checkedAt: null, scopes: [], missing: [] },
}

/** Made-up answers (an e-mail Meta might add is in some, to prove it never comes out). */
function answers(req: Req): unknown {
  const f = fieldsOf(req)
  if (req.path === PORTFOLIO && f === BUSINESS_SETTINGS_FIELDS) return { id: PORTFOLIO, name: 'Shop A', timezone_id: 21, primary_page: { id: PAGE }, vertical: 'RETAIL', two_factor_type: 'none' }
  if (req.path.endsWith('/owned_pages')) return { data: [{ id: PAGE, name: 'Shop A page' }, { id: PAGE_2, name: 'Shop A outlet' }], summary: { total_count: 2 } }
  if (req.path.endsWith('/client_pages')) return { data: [{ id: CLIENT_PAGE, name: 'Partner page', permitted_tasks: ['ADVERTISE'], business: { id: OTHER_PORTFOLIO } }], summary: { total_count: 1 } }
  if (req.path.endsWith('/owned_ad_accounts')) return { data: [{ account_id: ACCOUNT, name: 'Shop A ads', currency: 'EUR', timezone_name: 'Europe/Rome', account_status: 1, business: { id: PORTFOLIO } }] }
  if (req.path.endsWith('/client_ad_accounts')) return { data: [{ account_id: OTHER_ACCOUNT, name: 'Partner ads', currency: 'EUR', account_status: 1, business: { id: OTHER_PORTFOLIO } }] }
  if (req.path.endsWith('/owned_instagram_accounts')) return { data: [{ id: IG, username: 'shop_a', email: 'x@example.com' }] }
  if (req.path.endsWith('/owned_instagram_assets')) return { data: [{ id: '120000000000090', ig_user_id: IG, ig_username: 'shop_a' }] }
  if (req.path === `${IG}/authorized_adaccounts`) return { data: [{ account_id: ACCOUNT, name: 'Shop A ads' }] }
  if (req.path.endsWith('/owned_apps')) return { data: [{ id: '300000000000009', name: 'Shop A app' }] }
  // set-meta-billing: the portfolio's own credit line, its groups (auto_enroll), a group's ad accounts, the ad account's own billing.
  if (req.path === `${PORTFOLIO}/extendedcredits`) return { data: [{ id: LINE, owner_business: { id: PORTFOLIO } }] }
  if (req.path === `${LINE}/extended_credit_invoice_groups`) return { data: [{ id: GROUP_A, name: 'Group A', auto_enroll: false, emails: ['a@example.com'] }, { id: GROUP_B, name: 'Group B', auto_enroll: true }] }
  if (req.path === `${GROUP_A}/ad_accounts`) return { data: [{ account_id: ACCOUNT }] }
  if (req.path === `${GROUP_B}/ad_accounts`) return { data: [] }
  if (req.path === `act_${ACCOUNT}` && f.includes('extended_credit_invoice_group')) return { funding_source: '500000000000009', extended_credit_invoice_group: { id: GROUP_A, name: 'Group A' }, is_prepay_account: false }
  if (req.path === `act_${ACCOUNT}` && f.includes('funding_source_details')) return { funding_source_details: { id: LINE, type: 4, display_string: 'Credit line' } }
  return { data: [] }
}

beforeEach(() => {
  h.connections = [CHOSEN]; h.calls.length = 0; h.answer = answers; h.taken = []; h.state = { status: 1, disableReason: 0, name: 'Shop A ads' }; h.stateCalls = 0
  h.own = { adAccounts: [ACCOUNT], pages: [PAGE], instagram: [] }
})

/** Every call these tools made: a GET the real gateway lets through, on the chosen portfolio (or the chosen Instagram account) only. */
function callsAreReadsOfThePortfolio() {
  const refused = h.calls.map((c) => [c.path, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, problem]) => problem)
  expect(refused).toEqual([])
  expect(new Set(h.calls.map((c) => c.path.split('/')[0]))).toSatisfy((roots: Set<string>) => [...roots].every((r) => r === PORTFOLIO || r === IG))
  expect(h.calls.map(fieldsOf).join(' ')).not.toMatch(/email|first_name|last_name|invite_link|token/)
}

describe('four read-only guides (D1)', () => {
  it('read only, open world, ads.view, no change contract; the descriptions say Nexus sends nothing', () => {
    expect(META_ADS_BUSINESS_ASSETS_TOOLS.map((t) => t.name)).toEqual(['set-meta-business-assets', 'remove-meta-business-asset', 'create-meta-ad-account', 'create-meta-appeal', 'set-meta-billing'])
    for (const t of META_ADS_BUSINESS_ASSETS_TOOLS) {
      expect({ readOnly: t.readOnly, openWorld: t.openWorld, execute: t.execute, undo: t.undo, reversibility: t.reversibility, maxClaudeTrust: t.maxClaudeTrust, alwaysAsk: t.alwaysAsk, riskTier: t.riskTier, category: t.category })
        .toEqual({ readOnly: true, openWorld: true, execute: undefined, undo: undefined, reversibility: undefined, maxClaudeTrust: undefined, alwaysAsk: undefined, riskTier: 'low', category: 'insights' })
      expect(t.requires).toEqual(t.name === 'set-meta-billing' ? ['ads.view', 'financials.adspend.view'] : ['ads.view'])
      expect(t.description).toMatch(/Nexus changes NOTHING and sends nothing to Meta with this tool \(Owner decision D1/)
    }
    expect(tool('create-meta-ad-account').description).toMatch(/MONEY: it spends nothing until it has a payment method/)
    // Review F2 — the one-group sentence is the same in the description and in every answer.
    expect(tool('set-meta-billing').description).toContain(ONE_INVOICE_GROUP)
    expect(tool('set-meta-billing').description).not.toMatch(/SDK only|reference says/)
  })
  it('a portfolio another business in Nexus uses: refused before any Meta call, for every guide but the ad account\'s appeal', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: PORTFOLIO }]
    expect(errorOf(await run('set-meta-business-assets', { action: 'claim-page', pageId: PAGE_2 }))).toBe(ASSETS_SHARED)
    expect(errorOf(await run('remove-meta-business-asset', { asset: 'page', id: PAGE_2 }))).toBe(ASSETS_SHARED)
    expect(errorOf(await run('create-meta-ad-account', { name: 'Shop A outlet' }))).toBe(ASSETS_SHARED)
    expect(errorOf(await run('create-meta-appeal', { subject: 'portfolio' }))).toBe(ASSETS_SHARED)
    expect(h.calls).toEqual([])
    // The ad account's own appeal reads only that account (step 41's read).
    expect(data(await run('create-meta-appeal', { subject: 'ad-account' })).state).toBe('done')
  })
})

describe('set-meta-business-assets', () => {
  it('claim-page: an owned Page is done; a new one gives the Help Center steps; only GETs of the portfolio', async () => {
    const owned = data(await run('set-meta-business-assets', { action: 'claim-page', pageId: PAGE_2 }))
    expect(owned).toMatchObject({ nexusSends: 'nothing', state: 'done', ownerSteps: [] })
    const fresh = data(await run('set-meta-business-assets', { action: 'claim-page', pageId: '120000000000013' }))
    expect(fresh.state).toBe('to-do')
    expect(fresh.ownerSteps.join(' ')).toMatch(/Add an existing Facebook Page/)
    callsAreReadsOfThePortfolio()
  })
  it('a Page another business in Nexus picked, or one whose owner portfolio it uses: no steps; the lists are not even read for a picked one', async () => {
    h.taken = [{ product: 'PAGE', id: '120000000000013' }]
    expect(errorOf(await run('set-meta-business-assets', { action: 'claim-page', pageId: '120000000000013' }))).toMatch(/Another business in Nexus uses Page 120000000000013/)
    expect(h.calls.some((c) => c.path.includes('_pages'))).toBe(false)
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    expect(errorOf(await run('set-meta-business-assets', { action: 'request-page', pageId: CLIENT_PAGE }))).toMatch(/Another business in Nexus/)
  })
  it('request-page: a partner\'s Page this portfolio has is done', async () => {
    expect(data(await run('set-meta-business-assets', { action: 'request-page', pageId: CLIENT_PAGE })).state).toBe('done')
  })
  it('claim-ad-account / request-ad-account read step 2\'s lists; an ad account id may be written act_…', async () => {
    expect(data(await run('set-meta-business-assets', { action: 'claim-ad-account', adAccountId: `act_${ACCOUNT}` })).state).toBe('done')
    expect(data(await run('set-meta-business-assets', { action: 'request-ad-account', adAccountId: OTHER_ACCOUNT })).state).toBe('done')
    expect(errorOf(await run('set-meta-business-assets', { action: 'claim-ad-account', adAccountId: OTHER_ACCOUNT }))).toMatch(/one business portfolio/)
    expect(h.calls.some((c) => c.path === `${PORTFOLIO}/owned_ad_accounts`)).toBe(true)
    callsAreReadsOfThePortfolio()
  })
  it('link-instagram: step 3\'s read of the chosen Instagram account, with the portfolio as `business`', async () => {
    const out = data(await run('set-meta-business-assets', { action: 'link-instagram' }))
    expect(out.state).toBe('done')
    const call = h.calls.find((c) => c.path === `${IG}/authorized_adaccounts`)!
    expect(call.query).toMatchObject({ business: PORTFOLIO, fields: 'account_id,name' })
    callsAreReadsOfThePortfolio()
  })
  it('claim-app: Nexus\'s own app owned already is done; asset-group: Meta cannot by API', async () => {
    expect(data(await run('set-meta-business-assets', { action: 'claim-app', appId: '300000000000009' })).state).toBe('done')
    const group = data(await run('set-meta-business-assets', { action: 'asset-group', name: 'Brand A' }))
    expect(group.warnings.join(' ')).toMatch(/Meta cannot make a business asset group by its API/)
  })
})

describe('remove-meta-business-asset', () => {
  it('the chosen Page: steps and the warning of what it stops; a mistyped id on a first ask is refused', async () => {
    const out = data(await run('remove-meta-business-asset', { asset: 'page', id: PAGE }))
    expect(out.state).toBe('to-do')
    expect(out.warnings[0]).toMatch(/This is the Page Nexus works with for this business/)
    expect(errorOf(await run('remove-meta-business-asset', { asset: 'page', id: '120000000000019' }))).toMatch(/is not in this business portfolio/)
    callsAreReadsOfThePortfolio()
  })
  it('an ad account the portfolio owns: Meta does not allow it; a partner\'s: the steps', async () => {
    expect(errorOf(await run('remove-meta-business-asset', { asset: 'ad-account', id: `act_${ACCOUNT}` }))).toMatch(/OWNER and if the accounts are CONFIRMED/)
    const partner = data(await run('remove-meta-business-asset', { asset: 'ad-account', id: OTHER_ACCOUNT }))
    expect(partner.ownerSteps.join(' ')).toMatch(/"Partner ads" \(ad account act_1234567891\)/)
  })
  it('a partner\'s ad account whose owner portfolio another business in Nexus uses, or whose owner Meta names as this portfolio itself: no steps', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    expect(errorOf(await run('remove-meta-business-asset', { asset: 'ad-account', id: OTHER_ACCOUNT }))).toMatch(/Another business in Nexus/)
    h.taken = []
    h.answer = (req) => (req.path.endsWith('/client_ad_accounts') ? { data: [{ account_id: OTHER_ACCOUNT, name: 'Partner ads', business: { id: PORTFOLIO } }] } : answers(req))
    expect(errorOf(await run('remove-meta-business-asset', { asset: 'ad-account', id: OTHER_ACCOUNT }))).toMatch(/Meta does not name whose ad account/)
  })
  it('the chosen Instagram account: its own business asset list counts as owned', async () => {
    const out = data(await run('remove-meta-business-asset', { asset: 'instagram', id: IG }))
    expect(out.putBack.sentence).toMatch(/username and password/)
    expect(out.warnings[0]).toMatch(/Instagram account Nexus works with/)
  })
})

describe('create-meta-ad-account and create-meta-appeal', () => {
  it('a new ad account: the chosen account\'s currency and time zone as defaults; asked again, found by its name', async () => {
    const out = data(await run('create-meta-ad-account', { name: 'Shop A outlet' }))
    expect(out.items[0].asked).toEqual({ name: 'Shop A outlet', currency: 'EUR', timeZone: 'Europe/Rome' })
    expect(out.warnings.join(' ')).toMatch(/^MONEY:/)
    expect(data(await run('create-meta-ad-account', { name: 'Shop A ads', since: '2026-10-26T10:00:00.000Z' })).state).toBe('done')
    callsAreReadsOfThePortfolio()
  })
  it('an appeal of a disabled ad account: the steps; of an active one: nothing to appeal', async () => {
    h.state = { status: 2, disableReason: 1, name: 'Shop A ads' }
    const out = data(await run('create-meta-appeal', {}))
    expect(out.ownerSteps.join(' ')).toMatch(/Business Support Home/)
    expect(h.stateCalls).toBe(1)
    h.state = { status: 1, disableReason: 0, name: 'Shop A ads' }
    expect(data(await run('create-meta-appeal', { subject: 'ad-account' })).state).toBe('done')
  })
})

describe('set-meta-billing (a D1 guide)', () => {
  it('add-account: the ad account\'s own invoice group and payment method (step 3\'s read), MONEY plainly, only GETs, never an e-mail', async () => {
    const out = data(await run('set-meta-billing', { action: 'add-account', invoiceGroupId: GROUP_B }))
    expect(out).toMatchObject({ nexusSends: 'nothing', state: 'to-do' })
    expect(out.items[0].now).toMatchObject({ adAccountId: `act_${ACCOUNT}`, invoiceGroup: GROUP_A, group: { invoiceGroupId: GROUP_B, autoEnroll: true } })
    expect(out.warnings[0]).toMatch(/^MONEY: this changes which monthly invoice pays for ad account act_1234567890.*so nothing spends more/)
    const refused = h.calls.map((c) => [c.path, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, problem]) => problem)
    expect(refused).toEqual([])
    expect(h.calls.map(fieldsOf).join(' ')).not.toMatch(/email|token/)
    expect(JSON.stringify(out)).not.toMatch(/example\.com/)
    // F3 — the group's own list is read only as the floor (its ad accounts), never for "now".
    expect(h.calls.some((c) => c.path === `act_${ACCOUNT}` && fieldsOf(c).includes('extended_credit_invoice_group'))).toBe(true)
  })
  it('asked again: the ad account\'s own invoice group decides', async () => {
    h.answer = (req) => (req.path === `act_${ACCOUNT}` && fieldsOf(req).includes('extended_credit_invoice_group') ? { funding_source: '1', extended_credit_invoice_group: { id: GROUP_B } } : answers(req))
    expect(data(await run('set-meta-billing', { action: 'add-account', invoiceGroupId: GROUP_B, since: '2026-10-26T10:00:00.000Z' })).state).toBe('done')
  })
  it('a portfolio another business uses — by its link, or by one of its own assets, or unreadable: refused; the link before any Meta call', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: PORTFOLIO }]
    expect(errorOf(await run('set-meta-billing', { action: 'rename-group', invoiceGroupId: GROUP_A, name: 'Group C' }))).toBe(ASSETS_SHARED)
    expect(h.calls).toEqual([])
    h.taken = [{ product: 'PAGE', id: PAGE }]
    expect(errorOf(await run('set-meta-billing', { action: 'rename-group', invoiceGroupId: GROUP_A, name: 'Group C' }))).toBe(BILLING_SHARED)
    h.taken = []; h.own = { adAccounts: [ACCOUNT], pages: null, instagram: [] }
    expect(errorOf(await run('set-meta-billing', { action: 'rename-group', invoiceGroupId: GROUP_A, name: 'Group C' }))).toBe(BILLING_SHARED)
  })
  it('a group that bills another business\'s ad account: refused; delete only an empty group, on confirmDelete', async () => {
    h.answer = (req) => (req.path === `${GROUP_A}/ad_accounts` ? { data: [{ account_id: ACCOUNT }, { account_id: OTHER_ACCOUNT }] } : answers(req))
    h.taken = [{ product: 'AD_ACCOUNT', id: OTHER_ACCOUNT }]
    expect(errorOf(await run('set-meta-billing', { action: 'rename-group', invoiceGroupId: GROUP_A, name: 'Group C' }))).toMatch(/bills an ad account another business in Nexus uses/)
    h.taken = []; h.answer = answers
    expect(errorOf(await run('set-meta-billing', { action: 'delete-group', invoiceGroupId: GROUP_A, confirmDelete: true }))).toMatch(/still bills 1 ad account/)
    expect(data(await run('set-meta-billing', { action: 'delete-group', invoiceGroupId: GROUP_B, confirmDelete: true })).ownerSteps.join(' ')).toMatch(/3-dot icon/)
    expect(() => tool('set-meta-billing').input.parse({ action: 'delete-group', invoiceGroupId: GROUP_B, confirmDelete: false })).toThrow()
  })
})
