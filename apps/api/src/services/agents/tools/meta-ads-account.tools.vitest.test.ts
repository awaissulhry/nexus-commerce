/**
 * Meta ads step 3 — meta-ad-account, meta-billing, meta-account-access. Every view asks Meta only with fixed field lists and
 * only what the real gateway lets through; only the chosen ad account, its own portfolio (business-level billing only when
 * no other business uses it: id + flag, no call), the chosen Page / Instagram account, a catalog of the portfolio and a pixel
 * of the account are read; a Page, Instagram account, ad account or portfolio another business uses is its id and a flag;
 * people are names and tasks (never an e-mail or token); a payment method is Meta's masked words only; money is in minor
 * units under money keys (spend_cap read in offset units; a credit line in its own currency). Meta and the database are
 * stubbed; made-up ids only.
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
    // meta-ads-live's own reads (promoted Pages, Instagram accounts) page with metaReadAll.
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

import { META_ADS_ACCOUNT_TOOLS, META_BILLING_MONEY } from './meta-ads-account.tools.js'
import { MetaReadError, failureOfAnswer } from '../../marketing/meta-ads/errors.js'
import { currencyAmountMicros, META_CURRENCY_OFFSETS, META_OFFSET_ONE, metaAccountSpendCapMicros, metaCurrencyCode, minorOf, minorToMetaStandard, minorToMetaUnits } from '../../marketing/meta-ads/money.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const tool = (name: string) => META_ADS_ACCOUNT_TOOLS.find((t) => t.name === name)!
const ctx = { can: () => true, via: 'claude' as const }
const run = (name: string, args: Record<string, unknown>) => tool(name).handler(tool(name).input.parse(args), ctx as never)
const refusedByMeta = (words: string, code = '100', errorClass = 'validation') => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass, channelCode: code, channelMessage: words } as never }), 'x', 1)
const fieldsOf = (req: Req) => String(req.query?.fields ?? '')
const data = (res: { ok: boolean; data?: unknown; error?: string }) => { if (!res.ok) throw new Error(res.error); return res.data as Record<string, any> }

const ACCOUNT = '1234567890'
const PORTFOLIO = '9876543210'
const SYSTEM_USER = '100000000000001'
const PERSON = '100000000000002'
const PAGE = '120000000000010'
const IG = '170000000000001'
const APP = '300000000000001'
const PIXEL = '400000000000001'
const CREDIT = '500000000000001'
const GROUP = '510000000000001'
const CATALOG = '600000000000001'
const IG_ASSET = '180000000000001'
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok', systemUser: { id: SYSTEM_USER, name: 'Nexus system user' }, appId: '300000000000009',
  adAccount: { adAccountId: ACCOUNT, name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: PORTFOLIO },
  page: { pageId: PAGE }, instagram: { instagramId: IG }, read: {},
}

/** Made-up answers for every read of the step. */
function answers(req: Req): unknown {
  const f = fieldsOf(req)
  if (req.path === `act_${ACCOUNT}` && f.includes('account_status')) {
    return {
      id: `act_${ACCOUNT}`, account_id: ACCOUNT, name: 'Shop A ads', account_status: 1, disable_reason: 0, currency: 'EUR', business: { id: PORTFOLIO, name: 'Shop A' },
      end_advertiser: PAGE, end_advertiser_name: 'Shop A', media_agency: 'NONE', partner: 'NONE', is_personal: 0, user_tasks: ['MANAGE', 'ADVERTISE', 'ANALYZE'],
      ad_account_promotable_objects: { promotable_page_ids: [PAGE, '120000000000099'], promotable_app_ids: [], promotable_urls: ['https://shop.example.com/'] },
      owner_business: { id: '9000000000001', name: 'Other portfolio' }, liable_address: { street1: 'Via A 1', city: 'Rome', country: 'IT', vat_tax_id: 'IT00000000000' },
    }
  }
  if (req.path === `act_${ACCOUNT}` && f.startsWith('agency_client_declaration')) {
    return { agency_client_declaration: { agency_representing_client: 0, client_name: 'Shop A', client_email_address: 'someone@example.com', client_city: 'Rome' } }
  }
  if (req.path === `act_${ACCOUNT}` && f.includes('amount_spent')) return { currency: 'EUR', amount_spent: '12345', spend_cap: '50000', balance: '2000', min_daily_budget: '100', min_campaign_group_spend_cap: '10000' }
  if (req.path === `act_${ACCOUNT}` && f.includes('funding_source_details')) return { funding_source_details: { id: '700000000000001', type: 1, display_string: 'Visa *0000' } }
  if (req.path === `act_${ACCOUNT}` && f.includes('default_dsa_payor')) return { default_dsa_payor: 'Shop A', default_dsa_beneficiary: 'Shop A' }
  if (req.path.endsWith('/dsa_recommendations')) return { data: [{ recommendations: ['Shop A', 'Shop A ltd'] }] }
  if (req.path.endsWith('/minimum_budgets')) return { data: [{ currency: 'USD', min_daily_budget_imp: 100 }, { currency: 'EUR', min_daily_budget_imp: 200, min_daily_budget_high_freq: 500 }] }
  if (req.path.endsWith('/assigned_users')) {
    return {
      data: [
        { id: PERSON, name: 'Person A', user_type: 'business_user', tasks: ['ADVERTISE', 'ANALYZE'], business: { id: PORTFOLIO, name: 'Shop A' } },
        { id: SYSTEM_USER, name: 'Nexus system user', user_type: 'system_user', tasks: ['MANAGE', 'ADVERTISE', 'ANALYZE'], business: { id: PORTFOLIO, name: 'Shop A' } },
      ],
      summary: { total_count: 2 },
    }
  }
  if (req.path.endsWith('/applications') || req.path.endsWith('/advertisable_applications')) return { data: [{ id: APP, name: 'App A' }] }
  if (req.path.endsWith('/adspixels')) return { data: [{ id: PIXEL }] }
  if (req.path.endsWith('/owned_product_catalogs')) return { data: [{ id: CATALOG }] }
  if (req.path.endsWith('/extendedcredits')) return { data: [{ id: CREDIT, credit_type: 'ADS_BUSINESS', owner_business: { id: PORTFOLIO, name: 'Shop A' }, legal_entity_name: 'Shop A ltd', balance: { amount: '100.00', currency: 'USD', offsetted_amount: '10000' } }] }
  if (req.path.endsWith('/owned_instagram_assets')) return { data: [{ id: IG_ASSET, ig_user_id: IG }] }
  if (req.path.endsWith('/extended_credit_invoice_groups')) return { data: [{ id: GROUP, name: 'Group A', emails: ['a@example.com', 'b@example.com'] }] }
  if (req.path === `${GROUP}/ad_accounts`) return { data: [{ account_id: ACCOUNT, name: 'Shop A ads' }, { account_id: '5550001112', name: 'Other ads' }] }
  if (req.path.endsWith('/insights/feature-settings/list-features')) return { data: [{ feature_name: 'comscore', feature_type: 'breakdown' }, { feature_name: 'impression_device', feature_type: 'breakdown' }] }
  if (req.path.endsWith('/insights/feature-settings')) return { data: [{ feature_name: 'comscore', status: 'enabled', insights_effective_date: '2026-07-15' }] }
  return { data: [] }
}

beforeEach(() => {
  h.connections = [CHOSEN]; h.calls.length = 0; h.answer = answers; h.taken = []
})

describe('the three tools are reads of Meta', () => {
  it('read only, open world; billing needs the ad-spend permission; money keys restricted', () => {
    expect(META_ADS_ACCOUNT_TOOLS.map((t) => t.name)).toEqual(['meta-ad-account', 'meta-billing', 'meta-account-access'])
    for (const t of META_ADS_ACCOUNT_TOOLS) expect({ readOnly: t.readOnly, openWorld: t.openWorld, execute: t.execute, riskTier: t.riskTier }).toEqual({ readOnly: true, openWorld: true, execute: undefined, riskTier: 'low' })
    expect(tool('meta-ad-account').requires).toEqual(['ads.view'])
    expect(tool('meta-account-access').requires).toEqual(['ads.view'])
    expect(tool('meta-billing').requires).toEqual(['ads.view', 'financials.adspend.view'])
    expect(tool('meta-ad-account').restrictedFields).toMatchObject({ minDailyBudgetImpressionsCents: 'financials.adspend.view', bidAmountCents: 'financials.adspend.view' })
    expect(Object.values(META_BILLING_MONEY).every((p) => p === 'financials.adspend.view')).toBe(true)
    expect(tool('meta-billing').restrictedFields).toMatchObject({ spendCapCents: 'financials.adspend.view', amountDueCents: 'financials.adspend.view', metaRaw: 'financials.adspend.view' })
  })
})

describe('every view asks only what the real gateway lets through', () => {
  it('all views, with made-up answers; never an e-mail, token, PDF link or card detail is asked', async () => {
    const views: Array<[string, Record<string, unknown>]> = [
      ['meta-ad-account', { view: 'settings' }], ['meta-ad-account', { view: 'dsa' }], ['meta-ad-account', { view: 'terms' }], ['meta-ad-account', { view: 'capabilities' }],
      ['meta-ad-account', { view: 'controls' }], ['meta-ad-account', { view: 'tracking' }], ['meta-ad-account', { view: 'limits', bidAmountCents: 150 }], ['meta-ad-account', { view: 'goals' }],
      ['meta-ad-account', { view: 'attribution-options', appId: APP, optimizationGoal: 'app_installs', eventName: 'purchase' }], ['meta-ad-account', { view: 'insights-features', feature: 'comscore' }],
      ['meta-billing', { view: 'spend' }], ['meta-billing', { view: 'payment' }], ['meta-billing', { view: 'tax' }], ['meta-billing', { view: 'events', from: '2026-10-01', to: '2026-10-20' }],
      ['meta-billing', { view: 'invoices', from: '2026-01-01', to: '2026-10-01', issuedFrom: '2026-01-01', issuedTo: '2026-10-01', invoiceType: 'inv' }], ['meta-billing', { view: 'invoices', invoiceId: '123456' }],
      ['meta-billing', { view: 'credit-lines' }], ['meta-billing', { view: 'invoice-groups' }], ['meta-billing', { view: 'invoice-groups', creditLineId: CREDIT }],
      ['meta-billing', { view: 'credit-allocations' }], ['meta-billing', { view: 'cards' }], ['meta-billing', { view: 'credit-applications', pendingOnly: true }],
      ['meta-account-access', { view: 'people' }], ['meta-account-access', { view: 'agencies' }], ['meta-account-access', { view: 'apps' }], ['meta-account-access', { view: 'pages' }],
      ['meta-account-access', { view: 'instagram' }], ['meta-account-access', { view: 'by-person' }], ['meta-account-access', { view: 'by-person', personId: PERSON, kinds: ['adAccounts', 'catalogs'] }],
      ['meta-account-access', { view: 'asset-people', asset: 'page' }], ['meta-account-access', { view: 'asset-people', asset: 'instagram' }],
      ['meta-account-access', { view: 'asset-people', asset: 'catalog', assetId: CATALOG }], ['meta-account-access', { view: 'asset-people', asset: 'pixel', assetId: PIXEL }],
    ]
    const failed: unknown[] = []
    for (const [name, args] of views) {
      const res = await run(name, args)
      if (!res.ok) failed.push([name, args, res.error])
    }
    expect(failed).toEqual([])
    const refused = h.calls.map((c) => [c.operation, c.path, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, , problem]) => problem)
    expect(refused).toEqual([])
    const asked = h.calls.map((c) => fieldsOf(c)).join(' ')
    expect(asked).not.toMatch(/email|token|download_uri|card_holder|expiry|billing_address|phone|submitter|user_tos_accepted|preview/)
    // Only the chosen account, its portfolio, the chosen Page / Instagram account, a checked catalog or pixel, the system user,
    // an assigned person, the portfolio's credit line and invoice group.
    const roots = new Set(h.calls.map((c) => c.path.split('/')[0]))
    expect([...roots].sort()).toEqual([`act_${ACCOUNT}`, PERSON, SYSTEM_USER, PAGE, IG, IG_ASSET, CREDIT, GROUP, PIXEL, PORTFOLIO, CATALOG].sort())
    // Instagram people are read on the portfolio's Instagram business asset, never on the IG user node (review B1).
    expect(h.calls.some((c) => c.path === `${IG}/assigned_users`)).toBe(false)
    expect(h.calls.find((c) => c.path === `${IG_ASSET}/assigned_users`)?.query?.business).toBe(PORTFOLIO)
  })
})

describe('meta-ad-account', () => {
  it('settings: SDK-only fields in their own group (a refusal is named), the declaration read alone and without its e-mail, another business\'s Page masked', async () => {
    h.taken = [{ product: 'PAGE', id: '120000000000099' }, { product: 'PORTFOLIO', id: '9000000000001' }]
    h.answer = (req) => {
      const f = fieldsOf(req)
      if (req.path === `act_${ACCOUNT}` && f.includes('account_status') && f.includes('liable_address')) return refusedByMeta('(#100) Tried accessing nonexisting field (liable_address)')
      if (req.path === `act_${ACCOUNT}` && f.startsWith('liable_address')) return refusedByMeta('(#100) Tried accessing nonexisting field (liable_address)')
      return answers(req)
    }
    const out = data(await run('meta-ad-account', { view: 'settings' }))
    expect(out.missing).toEqual([{ part: 'sdkAddresses', sentence: expect.stringMatching(/nonexisting field/) }])
    // The other SDK-only groups still answer (review B3): another business's portfolio is its id and the flag.
    expect(out.ownerPortfolio).toEqual({ portfolioId: '9000000000001', takenByAnotherBusiness: true })
    expect(out.agencyDeclaration).toMatchObject({ clientName: 'Shop A', agencyRepresentingClient: false })
    expect(JSON.stringify(out)).not.toMatch(/someone@example\.com|IT00000000000/)
    expect(out.promotable.pages).toEqual([{ pageId: PAGE, chosenHere: true, takenByAnotherBusiness: false }, { pageId: '120000000000099', takenByAnotherBusiness: true }])
    expect(out.portfolio).toMatchObject({ portfolioId: PORTFOLIO, chosenAccountsPortfolio: true })
    expect(out.nexusRole).toMatch(/^Admin/)
    expect(h.calls.filter((c) => fieldsOf(c).startsWith('agency_client_declaration'))).toHaveLength(1)
    // Its own sub-fields, never the client's e-mail (review A4).
    expect(h.calls.find((c) => fieldsOf(c).startsWith('agency_client_declaration'))?.query?.fields).toMatch(/^agency_client_declaration\{agency_representing_client,.*\}$/)
  })
  it('settings: custom_audience_info is not in v26\'s Reading table, so a refusal costs only sdkOther, never the settings (review round 2, B1)', async () => {
    h.answer = (req) => (/custom_audience_info/.test(fieldsOf(req)) ? refusedByMeta('(#100) Tried accessing nonexisting field (custom_audience_info)') : answers(req))
    const out = data(await run('meta-ad-account', { view: 'settings' }))
    expect(out.name).toBe('Shop A ads')
    expect(out.missing).toEqual([{ part: 'sdkOther', sentence: expect.stringMatching(/custom_audience_info/) }])
    expect(fieldsOf(h.calls.find((c) => c.operation === 'account.settings.core')!)).not.toMatch(/custom_audience_info/)
  })
  it('when Meta refuses the declaration\'s sub-field list, the whole field is read once more and the e-mail is still dropped', async () => {
    h.answer = (req) => (fieldsOf(req).startsWith('agency_client_declaration{') ? refusedByMeta('(#100) Unknown fields') : answers(req))
    const out = data(await run('meta-ad-account', { view: 'settings' }))
    expect(out.agencyDeclaration).toMatchObject({ clientName: 'Shop A' })
    expect(JSON.stringify(out)).not.toMatch(/someone@example\.com/)
    expect(h.calls.filter((c) => fieldsOf(c).startsWith('agency_client_declaration')).map((c) => fieldsOf(c).length > 30)).toEqual([true, false])
  })
  it('a declaration Meta refuses (not a Business Manager admin) costs only itself', async () => {
    h.answer = (req) => (fieldsOf(req).startsWith('agency_client_declaration') ? refusedByMeta('(#200) Requires business manager admin', '200', 'forbidden') : answers(req))
    const out = data(await run('meta-ad-account', { view: 'settings' }))
    expect(out.name).toBe('Shop A ads')
    expect(out.missing).toEqual([{ part: 'agencyDeclaration', sentence: expect.stringMatching(/Business Manager admin/) }])
    // Review round 2 — a permission refusal (#200) is not a refused field list: no second, whole-field read.
    expect(h.calls.filter((c) => fieldsOf(c).startsWith('agency_client_declaration'))).toHaveLength(1)
  })
  it('terms never asks user_tos_accepted (system users cannot have it) and says why', async () => {
    const out = data(await run('meta-ad-account', { view: 'terms' }))
    expect(h.calls.some((c) => /user_tos_accepted/.test(fieldsOf(c)))).toBe(false)
    expect(out.notes.join(' ')).toMatch(/not valid for system users/)
  })
  it('limits: the manual bid goes in Meta\'s units; each currency\'s floors in its minor units, the account\'s first', async () => {
    const out = data(await run('meta-ad-account', { view: 'limits', bidAmountCents: 150 }))
    expect(h.calls.find((c) => c.path.endsWith('/minimum_budgets'))?.query?.bid_amount).toBe(150)
    expect(out.minimumDailyBudgets[0]).toMatchObject({ currency: 'EUR', chosenAccountsCurrency: true, minDailyBudgetImpressionsCents: 200, minDailyBudgetHighFrequencyCents: 500 })
    expect(out.minimumDailyBudgets[1]).toMatchObject({ currency: 'USD', minDailyBudgetImpressionsCents: 100 })
  })
  it('attribution-options needs an app of the account: no app, or another app, is refused before the read', async () => {
    expect((await run('meta-ad-account', { view: 'attribution-options' })).error).toMatch(/APP's events only/)
    expect((await run('meta-ad-account', { view: 'attribution-options', appId: '300000000000777', optimizationGoal: 'APP_INSTALLS' })).error).toMatch(/not one connected/)
    expect((await run('meta-ad-account', { view: 'attribution-options', appId: APP, optimizationGoal: 'APP_INSTALLS', eventName: 'other' })).error).toMatch(/custom app event/)
    expect(h.calls.some((c) => c.path.endsWith('/campaign_attribution_options'))).toBe(false)
    h.answer = (req) => (req.path.endsWith('/campaign_attribution_options') ? { data: [{ value: '7d_click', is_eligible: true }] } : answers(req))
    expect(data(await run('meta-ad-account', { view: 'attribution-options', appId: APP, optimizationGoal: 'APP_INSTALLS' })).options).toEqual([{ value: '7d_click', eligible: true }])
    expect(h.calls.find((c) => c.path.endsWith('/campaign_attribution_options'))?.query?.fields).toBe('is_eligible,value')
  })
  it('insights-features: what is available, which is on and from when', async () => {
    const out = data(await run('meta-ad-account', { view: 'insights-features' }))
    expect(out.features).toEqual([
      { name: 'comscore', type: 'breakdown', unlocks: 'breakdowns=comscore_market', enabled: true, dataFrom: '2026-07-15' },
      { name: 'impression_device', type: 'breakdown', unlocks: 'breakdowns=impression_device', enabled: false, dataFrom: null },
    ])
    expect(out.notes.join(' ')).toMatch(/EMPTY with no error/)
    // Review A5 — reads only: exactly the two GETs, each one the gateway passes as a read.
    expect(h.calls.map((c) => c.path).sort()).toEqual([`act_${ACCOUNT}/insights/feature-settings`, `act_${ACCOUNT}/insights/feature-settings/list-features`])
    for (const c of h.calls) expect(metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })).toBeNull()
    expect(metaReadOnlyProblem({ method: 'POST', url: metaUrl(`act_${ACCOUNT}/insights/feature-settings`), kind: 'read' })).toMatch(/not a read/)
  })
})

describe('meta-billing', () => {
  it('spend: offset units to minor units; a spend cap of 0 is no cap', async () => {
    expect(data(await run('meta-billing', { view: 'spend' }))).toMatchObject({ amountSpentCents: 12345, spendCapCents: 50000, spendLeftCents: 37655, spendCapSet: true, balanceCents: 2000, minDailyBudgetCents: 100, minCampaignSpendCapCents: 10000 })
    h.answer = (req) => (fieldsOf(req).includes('amount_spent') ? { currency: 'EUR', amount_spent: '12345', spend_cap: '0' } : answers(req))
    expect(data(await run('meta-billing', { view: 'spend' }))).toMatchObject({ spendCapCents: null, spendCapSet: false, spendLeftCents: null })
  })
  it('payment: the method is its own read (MANAGE); Meta\'s masked words only; a refusal keeps the rest', async () => {
    const out = data(await run('meta-billing', { view: 'payment' }))
    expect(out.paymentMethod).toMatchObject({ typeText: 'Credit or debit card', shownAs: 'Visa *0000' })
    const own = h.calls.filter((c) => /funding_source_details/.test(fieldsOf(c)))
    expect(own.map((c) => fieldsOf(c))).toEqual(['funding_source_details,expired_funding_source_details'])
    h.calls.length = 0
    h.answer = (req) => (/funding_source_details/.test(fieldsOf(req)) ? refusedByMeta('(#200) Requires MANAGE', '200', 'forbidden') : answers(req))
    const refused = data(await run('meta-billing', { view: 'payment' }))
    expect(refused.paymentMethod).toBeNull()
    expect(refused.missing).toEqual([{ part: 'paymentMethod', sentence: expect.stringMatching(/MANAGE task/) }])
  })
  it('a portfolio another business uses: invoices, credit lines, groups, allocations, cards, applications are its id and a flag, with no call', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: PORTFOLIO }]
    for (const view of ['invoices', 'credit-lines', 'invoice-groups', 'credit-allocations', 'cards', 'credit-applications']) {
      expect(data(await run('meta-billing', { view })).portfolio, view).toMatchObject({ portfolioId: PORTFOLIO, takenByAnotherBusiness: true })
    }
    expect(h.calls).toHaveLength(0)
    // The account's own billing is still read.
    expect(data(await run('meta-billing', { view: 'spend' })).amountSpentCents).toBe(12345)
  })
  it('credit lines in their own currency; invoice groups never carry e-mails and mask another business\'s ad account', async () => {
    h.taken = [{ product: 'AD_ACCOUNT', id: '5550001112' }]
    expect(data(await run('meta-billing', { view: 'credit-lines' })).creditLines[0]).toMatchObject({ creditLineId: CREDIT, balanceCents: 10000, balanceCurrency: 'USD' })
    const groups = data(await run('meta-billing', { view: 'invoice-groups' }))
    expect(groups.invoiceGroups[0]).toMatchObject({ invoiceGroupId: GROUP, adAccounts: [{ adAccountId: ACCOUNT, chosenHere: true }, { adAccountId: '5550001112', takenByAnotherBusiness: true }] })
    expect(JSON.stringify(groups)).not.toMatch(/@example\.com|Other ads/)
    expect((await run('meta-billing', { view: 'invoice-groups', creditLineId: '500000000000999' })).error).toMatch(/not a credit line of the chosen/)
  })
  it('invoices: never the PDF links; the amount due in its currency; Meta\'s invoice amount as sent', async () => {
    h.answer = (req) => (req.path.endsWith('/business_invoices') ? { data: [{ id: '800000000000001', invoice_id: '1234', amount: '150.00', currency: 'EUR', amount_due: { amount: '20.00', currency: 'EUR', offsetted_amount: '2000' }, ad_account_ids: [ACCOUNT] }], summary: { total_count: 1 } } : answers(req))
    const out = data(await run('meta-billing', { view: 'invoices' }))
    expect(out.invoices[0]).toMatchObject({ invoiceNumber: '1234', amountMeta: '150.00', amountDueCents: 2000, amountDueCurrency: 'EUR', adAccounts: [{ adAccountId: ACCOUNT, chosenHere: true }] })
    expect(h.calls.some((c) => /download/.test(fieldsOf(c)))).toBe(false)
    expect((await run('meta-billing', { view: 'invoices', issuedTo: '2026-10-01' })).error).toMatch(/name issuedFrom too/)
  })
  it('tax: a personal-use account shows no VAT or registration numbers; is_tax_id_required is its own group', async () => {
    h.answer = (req) => (fieldsOf(req).startsWith('tax_id') ? { tax_id: 'IT00000000000', tax_id_status: 5, is_personal: 1 } : fieldsOf(req).startsWith('liable_address') || fieldsOf(req).includes(',liable_address') ? { liable_address: { city: 'Rome', vat_tax_id: 'IT00000000000' } } : answers(req))
    const personal = data(await run('meta-billing', { view: 'tax' }))
    expect(personal).toMatchObject({ taxId: null, taxIdStatus: 5, personalUse: true })
    expect(JSON.stringify(personal)).not.toMatch(/IT00000000000/)
    h.answer = (req) => (/tax_id/.test(fieldsOf(req)) ? { tax_id: 'IT00000000000', tax_id_status: 3, is_personal: 0, liable_address: { city: 'Rome', vat_tax_id: 'IT00000000000' } } : answers(req))
    h.calls.length = 0
    const business = data(await run('meta-billing', { view: 'tax' }))
    expect(business).toMatchObject({ taxId: 'IT00000000000', addresses: { liable: { vatTaxId: 'IT00000000000' } } })
    h.calls.length = 0
    h.answer = (req) => (fieldsOf(req).includes('is_tax_id_required') && fieldsOf(req).includes('tax_id,') ? refusedByMeta('(#200) Requires ADVERTISE', '200', 'forbidden') : fieldsOf(req) === 'is_tax_id_required' ? refusedByMeta('(#200) Requires ADVERTISE', '200', 'forbidden') : /tax_id/.test(fieldsOf(req)) ? { tax_id_status: 3 } : answers(req))
    expect(data(await run('meta-billing', { view: 'tax' })).missing).toEqual([{ part: 'taxIdRequired', sentence: expect.stringMatching(/ADVERTISE/) }])
  })
  it('credit lines another portfolio owns: no legal names; one another Nexus business owns: no amounts; their groups and allocations are never read', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: '9000000000005' }]
    h.answer = (req) => (req.path.endsWith('/extendedcredits') ? { data: [
      { id: CREDIT, owner_business: { id: PORTFOLIO, name: 'Shop A' }, legal_entity_name: 'Shop A ltd', balance: { amount: '1.00', currency: 'USD', offsetted_amount: '100' } },
      { id: '500000000000002', owner_business: { id: '9000000000004', name: 'Agency B' }, legal_entity_name: 'Agency B ltd', balance: { amount: '2.00', currency: 'USD', offsetted_amount: '200' } },
      { id: '500000000000003', owner_business: { id: '9000000000005', name: 'Other business' }, legal_entity_name: 'Other ltd', balance: { amount: '3.00', currency: 'USD', offsetted_amount: '300' } },
    ] } : answers(req))
    const lines = data(await run('meta-billing', { view: 'credit-lines' })).creditLines
    expect(lines[0]).toMatchObject({ creditLineId: CREDIT, ownedByThisPortfolio: true, legalEntityName: 'Shop A ltd', balanceCents: 100 })
    expect(lines[1]).toMatchObject({ creditLineId: '500000000000002', ownedByThisPortfolio: false, balanceCents: 200, owner: { portfolioId: '9000000000004', name: 'Agency B' } })
    expect(lines[1].legalEntityName).toBeUndefined()
    expect(lines[2]).toEqual({ creditLineId: '500000000000003', creditType: null, accessRevoked: null, automated: null, owner: { portfolioId: '9000000000005', takenByAnotherBusiness: true }, ownedByThisPortfolio: false })
    h.calls.length = 0
    const groups = data(await run('meta-billing', { view: 'invoice-groups' }))
    expect(groups.creditLinesOfOtherPortfolios).toEqual([{ creditLineId: '500000000000002', ownedByAnotherPortfolio: true }, { creditLineId: '500000000000003', ownedByAnotherPortfolio: true }])
    const allocations = data(await run('meta-billing', { view: 'credit-allocations', creditLineId: '500000000000002' }))
    expect(allocations).toMatchObject({ allocations: [], creditLinesOfOtherPortfolios: [{ creditLineId: '500000000000002', ownedByAnotherPortfolio: true }] })
    expect(h.calls.filter((c) => /^50000000000000[23]\//.test(c.path))).toEqual([])
    expect(h.calls.filter((c) => c.path.startsWith(`${CREDIT}/`)).map((c) => c.path)).toEqual([`${CREDIT}/extended_credit_invoice_groups`])
  })
  it('invoice groups of a personal-use account show no tax numbers in their addresses', async () => {
    h.answer = (req) => {
      if (fieldsOf(req) === 'is_personal,tax_id_status') return { is_personal: 1 }
      if (req.path.endsWith('/extended_credit_invoice_groups')) return { data: [{ id: GROUP, name: 'Group A', bill_to_address: { city: 'Rome', vat_tax_id: 'IT00000000000' } }] }
      return answers(req)
    }
    const out = data(await run('meta-billing', { view: 'invoice-groups' }))
    expect(out.invoiceGroups[0].billTo).toMatchObject({ city: 'Rome' })
    expect(JSON.stringify(out)).not.toMatch(/IT00000000000/)
  })
  it('events: the billing ones of the activity log, the days as Unix seconds', async () => {
    h.answer = (req) => (req.path.endsWith('/activities') ? { data: [
      { event_type: 'ad_account_billing_charge', event_time: '2026-10-02T10:00:00+0000', actor_name: 'Person A', extra_data: '{"amount":"1000","currency":"EUR","card":{"last4":"0000"},"note_x":"y"}' },
      { event_type: 'update_ad_set_budget', event_time: '2026-10-03T10:00:00+0000' },
    ] } : answers(req))
    const out = data(await run('meta-billing', { view: 'events', from: '2026-10-01', to: '2026-10-20' }))
    // Review A4 — only the plain keys Nexus knows; a nested object or an unknown key is left out and counted.
    expect(out.events).toEqual([expect.objectContaining({ type: 'ad_account_billing_charge', metaRaw: { amount: '1000', currency: 'EUR' }, detailsLeftOut: 2, leftOutKeys: ['card', 'note_x'] })])
    expect(JSON.stringify(out)).not.toMatch(/last4/)
    expect(h.calls.find((c) => c.path.endsWith('/activities'))?.query).toMatchObject({ category: 'BUDGET', since: Date.UTC(2026, 9, 1) / 1000, until: Date.UTC(2026, 9, 21) / 1000 })
    // Review round 4 — someone Nexus does not know is Meta's id at most, never a name.
    expect(out.events[0]).toMatchObject({ who: null, actorId: null })
    expect(out.events[0].actorName).toBeUndefined()
    expect(JSON.stringify(out)).not.toMatch(/Person A/)
    expect((await run('meta-billing', { view: 'events', from: '2025-01-01', to: '2026-10-20' })).error).toMatch(/at most 366 days/)
  })
})

describe('meta-billing, review round 2', () => {
  const days = { view: 'events', from: '2026-10-01', to: '2026-10-20' }
  const activityReads = () => h.calls.filter((c) => c.path.endsWith('/activities'))
  it('events: billing events from category BUDGET; a failed charge from ONE read without a category, kept only for that type (review round 4)', async () => {
    h.answer = (req) => {
      if (!req.path.endsWith('/activities')) return answers(req)
      if (req.query?.category === 'BUDGET') return { data: [
        { event_type: 'ad_account_billing_charge', event_time: '2026-10-03T10:00:00+0000', extra_data: { amount: '1000', old_value: 'someone@example.com', payer_note: 'kept out', 'other@example.com': 1 } },
        { event_type: 'update_campaign_budget', event_time: '2026-10-04T10:00:00+0000' },
        { event_type: 'ad_account_billing_refund', event_time: '2026-10-01T10:00:00+0000' },
      ] }
      return { data: [
        { event_type: 'ad_account_billing_charge_failed', event_time: '2026-10-02T10:00:00+0000' },
        // The whole log holds the BUDGET events too: never answered twice, and nothing else is taken from it.
        { event_type: 'ad_account_billing_charge', event_time: '2026-10-03T10:00:00+0000', extra_data: { amount: '1000', old_value: 'someone@example.com', payer_note: 'kept out', 'other@example.com': 1 } },
        { event_type: 'ad_account_billing_decline', event_time: '2026-10-05T10:00:00+0000' },
        { event_type: 'ad_review_declined', event_time: '2026-10-06T10:00:00+0000' },
      ] }
    }
    const out = data(await run('meta-billing', days))
    const [first, second, ...rest] = activityReads()
    expect([first.query?.category, second.query?.category, rest.length]).toEqual(['BUDGET', undefined, 0])
    expect(second.query).toEqual({ fields: first.query?.fields, since: first.query?.since, until: first.query?.until, limit: first.query?.limit })
    // The newest first: the charge, the failed charge (from the whole log), the refund; never the budget change, the review or a second copy.
    expect(out.events.map((e: Record<string, unknown>) => e.type)).toEqual(['ad_account_billing_charge', 'ad_account_billing_charge_failed', 'ad_account_billing_refund'])
    expect(out.scanned).toEqual({ budgetCategory: 3, wholeLog: 4 })
    // A value that looks like an e-mail address is never passed on; the keys left out are named, never their values (A6).
    // A key that is not a plain name (here an address) is counted, never named.
    expect(out.events[0]).toMatchObject({ metaRaw: { amount: '1000' }, detailsLeftOut: 3, leftOutKeys: ['old_value', 'payer_note'] })
    expect(JSON.stringify(out)).not.toMatch(/@example\.com|kept out/)
    expect(out.notes.join(' ')).toMatch(/in none of Meta's categories/)
    for (const c of [first, second]) expect(metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, c.query as never), kind: 'read' })).toBeNull()
  })
  it('events: a failed charge Meta files under BUDGET after all is answered once, not twice (LIVE-PROBES LG-003)', async () => {
    const failed = { event_type: 'ad_account_billing_charge_failed', event_time: '2026-10-02T10:00:00+0000', object_id: ACCOUNT }
    h.answer = (req) => (req.path.endsWith('/activities') ? { data: [failed] } : answers(req))
    expect(data(await run('meta-billing', days)).events.map((e: Record<string, unknown>) => e.type)).toEqual(['ad_account_billing_charge_failed'])
  })
  it('events: the whole-log read Meta refuses costs only the failed charges; a throttle or a lost token ends the read', async () => {
    h.answer = (req) => (req.path.endsWith('/activities') ? (req.query?.category ? { data: [{ event_type: 'ad_account_billing_refund' }] } : refusedByMeta('(#100) Please reduce the amount of data', '100')) : answers(req))
    const out = data(await run('meta-billing', days))
    expect(out).toMatchObject({ events: [expect.objectContaining({ type: 'ad_account_billing_refund' })], scanned: { budgetCategory: 1, wholeLog: null }, missing: [{ part: 'failedCharges', sentence: expect.stringMatching(/reduce the amount/) }] })
    for (const [code, cls, words] of [['80004', 'rate_limited', /slow down/], ['190', 'auth_expired', /no longer accepts/]] as const) {
      h.calls.length = 0
      h.answer = (req) => (req.path.endsWith('/activities') ? (req.query?.category ? { data: [] } : refusedByMeta('(#x) stop', code, cls)) : answers(req))
      expect((await run('meta-billing', days)).error).toMatch(words)
    }
  })
  it('events: who made a change — Nexus\'s system user or the chosen Page by name, anyone else Meta\'s id only (step 5\'s rule)', async () => {
    h.answer = (req) => (req.path.endsWith('/activities') && req.query?.category ? { data: [
      { event_type: 'add_funding_source', event_time: '2026-10-03T10:00:00+0000', actor_id: SYSTEM_USER, actor_name: 'Nexus system user' },
      { event_type: 'billing_event', event_time: '2026-10-02T10:00:00+0000', actor_id: PAGE, actor_name: 'Shop A page' },
      { event_type: 'remove_funding_source', event_time: '2026-10-01T10:00:00+0000', actor_id: PERSON, actor_name: 'Person A' },
    ] } : answers(req))
    const out = data(await run('meta-billing', days))
    expect(out.events.map((e: Record<string, unknown>) => [e.who, e.actorId, e.actorName])).toEqual([
      ['Nexus\'s own system user', SYSTEM_USER, 'Nexus system user'], ['the chosen Facebook Page', PAGE, 'Shop A page'], ['someone else (a person, an agency or Meta)', PERSON, undefined],
    ])
    expect(JSON.stringify(out)).not.toMatch(/Person A/)
  })
  it('tax: when Meta does not say the account is for business use (no is_personal), the tax numbers are masked (A6)', async () => {
    h.answer = (req) => (/tax_id/.test(fieldsOf(req)) ? { tax_id: 'IT00000000000', tax_id_status: 3, liable_address: { city: 'Rome', vat_tax_id: 'IT00000000000' } } : answers(req))
    const out = data(await run('meta-billing', { view: 'tax' }))
    expect(out).toMatchObject({ taxId: null, personalUse: null, addresses: { liable: { city: 'Rome' } } })
    expect(JSON.stringify(out)).not.toMatch(/IT00000000000/)
    expect(out.notes.join(' ')).toMatch(/did not say/)
    h.answer = (req) => {
      if (fieldsOf(req) === 'is_personal,tax_id_status') return { tax_id_status: 3 }
      if (req.path.endsWith('/extended_credit_invoice_groups')) return { data: [{ id: GROUP, name: 'Group A', bill_to_address: { city: 'Rome', vat_tax_id: 'IT00000000000' } }] }
      return answers(req)
    }
    expect(JSON.stringify(data(await run('meta-billing', { view: 'invoice-groups' })))).not.toMatch(/IT00000000000/)
  })
  it('addresses of a personal-use account, or one Meta says nothing about, show no street or post code (review round 3)', async () => {
    const liable = { street1: 'Via A 1', street2: 'Scala B', city: 'Rome', postal_code: '00100', country: 'IT', vat_tax_id: 'IT00000000000' }
    for (const flags of [{ is_personal: 1 }, {}]) {
      h.answer = (req) => (/tax_id/.test(fieldsOf(req)) ? { tax_id_status: 3, ...flags, liable_address: liable } : answers(req))
      const tax = data(await run('meta-billing', { view: 'tax' }))
      expect(tax.addresses.liable, JSON.stringify(flags)).toEqual({ city: 'Rome', state: null, country: 'IT', validationStatus: null })
      h.answer = (req) => (req.path === `act_${ACCOUNT}` && fieldsOf(req).includes('account_status') ? { ...(answers(req) as object), ...flags, is_personal: (flags as { is_personal?: number }).is_personal, liable_address: liable, business_street: 'Via A 1', business_zip: '00100', business_city: 'Rome' } : answers(req))
      const settings = data(await run('meta-ad-account', { view: 'settings' }))
      expect(settings.addresses.liable).toEqual({ city: 'Rome', state: null, country: 'IT', validationStatus: null })
      expect(settings.businessAddress).toMatchObject({ city: 'Rome' })
      for (const out of [tax, settings]) expect(JSON.stringify(out)).not.toMatch(/Via A 1|Scala B|00100|IT00000000000/)
      h.answer = (req) => {
        if (fieldsOf(req) === 'is_personal,tax_id_status') return flags
        if (req.path.endsWith('/extended_credit_invoice_groups')) return { data: [{ id: GROUP, name: 'Group A', bill_to_address: liable }] }
        return answers(req)
      }
      expect(JSON.stringify(data(await run('meta-billing', { view: 'invoice-groups' })))).not.toMatch(/Via A 1|00100|IT00000000000/)
    }
    // A business-use account (is_personal explicitly 0): the street and post code show (and, in billing, its tax ids).
    h.answer = (req) => (/tax_id/.test(fieldsOf(req)) ? { tax_id_status: 3, is_personal: 0, liable_address: liable } : answers(req))
    expect(data(await run('meta-billing', { view: 'tax' })).addresses.liable).toMatchObject({ street: ['Via A 1', 'Scala B'], postalCode: '00100', vatTaxId: 'IT00000000000' })
    h.answer = (req) => (req.path === `act_${ACCOUNT}` && fieldsOf(req).includes('account_status') ? { ...(answers(req) as object), liable_address: liable, business_street: 'Via A 1', business_zip: '00100' } : answers(req))
    const settings = data(await run('meta-ad-account', { view: 'settings' }))
    expect(settings.addresses.liable).toMatchObject({ street: ['Via A 1', 'Scala B'], postalCode: '00100' })
    expect(settings.addresses.liable.vatTaxId).toBeUndefined()
    expect(settings.businessAddress).toMatchObject({ street: 'Via A 1', zip: '00100' })
  })
  it('credit lines: one whose owner Meta does not name is treated as another business\'s — no amounts, no names (A3)', async () => {
    h.answer = (req) => (req.path.endsWith('/extendedcredits') ? { data: [
      { id: '500000000000004', credit_type: 'ADS_BUSINESS', legal_entity_name: 'Unknown ltd', owner_business_name: 'Unknown owner', partition_from: 'Unknown grant', balance: { amount: '4.00', currency: 'USD', offsetted_amount: '400' } },
    ] } : answers(req))
    const lines = data(await run('meta-billing', { view: 'credit-lines' })).creditLines
    expect(lines).toEqual([{ creditLineId: '500000000000004', creditType: 'ADS_BUSINESS', accessRevoked: null, automated: null, owner: null, ownedByThisPortfolio: false }])
  })
})

describe('meta-account-access', () => {
  it('people: names and tasks, roles, Nexus\'s system user marked; never an e-mail', async () => {
    const out = data(await run('meta-account-access', { view: 'people' }))
    expect(out.assigned).toEqual([
      expect.objectContaining({ personId: PERSON, name: 'Person A', role: 'Advertiser (advertise, analyse)', nexusSystemUser: false }),
      expect.objectContaining({ personId: SYSTEM_USER, role: 'Admin (manage, advertise, analyse)', nexusSystemUser: true }),
    ])
    expect(out.assignedTotal).toBe(2)
    expect(h.calls.find((c) => c.path.endsWith('/assigned_users'))?.query?.business).toBe(PORTFOLIO)
  })
  it('agencies: a portfolio another business uses is its id and the flag only', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: '9000000000002' }]
    h.answer = (req) => (req.path.endsWith('/agencies') ? { data: [{ id: '9000000000002', name: 'Other business', access_status: 'CONFIRMED' }, { id: '9000000000003', name: 'Agency A', permitted_tasks: ['ANALYZE'] }] } : answers(req))
    const out = data(await run('meta-account-access', { view: 'agencies' }))
    expect(out.agencies).toEqual([{ portfolioId: '9000000000002', takenByAnotherBusiness: true }, expect.objectContaining({ portfolioId: '9000000000003', name: 'Agency A', tasks: ['ANALYZE'] })])
    expect(JSON.stringify(out)).not.toMatch(/"name":"Other business"|CONFIRMED/)
  })
  it('by-person: Nexus\'s system user by default; only someone assigned to the account; other businesses\' assets masked', async () => {
    h.taken = [{ product: 'AD_ACCOUNT', id: '5550001112' }]
    h.answer = (req) => (req.path === `${SYSTEM_USER}/assigned_ad_accounts` ? { data: [{ account_id: ACCOUNT, name: 'Shop A ads' }, { account_id: '5550001112', name: 'Other ads' }] } : answers(req))
    const out = data(await run('meta-account-access', { view: 'by-person', kinds: ['adAccounts'] }))
    expect(out).toMatchObject({ personId: SYSTEM_USER, nexusSystemUser: true, assets: { adAccounts: [{ id: ACCOUNT, chosenHere: true }, { id: '5550001112', takenByAnotherBusiness: true }] } })
    h.calls.length = 0
    expect((await run('meta-account-access', { view: 'by-person', personId: '100000000000999' })).error).toMatch(/not assigned to the chosen ad account/)
    // Review A5 — refused before any read of what that person reaches.
    expect(h.calls.map((c) => c.path)).toEqual([`act_${ACCOUNT}/assigned_users`])
    expect(h.calls.some((c) => /^100000000000999\//.test(c.path))).toBe(false)
  })
  it('by-person: a catalog, pixel, app … shows its name only when this portfolio owns it (review A2)', async () => {
    h.answer = (req) => {
      if (req.path === `${SYSTEM_USER}/assigned_product_catalogs`) return { data: [{ id: CATALOG, name: 'Catalog A', business: { id: PORTFOLIO } }, { id: '600000000000009', name: 'Catalog of another', business: { id: '9000000000007' } }, { id: '600000000000010', name: 'No owner said' }] }
      if (req.path === `${SYSTEM_USER}/assigned_monetization_properties`) return { data: [{ id: '650000000000001' }] }
      return answers(req)
    }
    const out = data(await run('meta-account-access', { view: 'by-person', kinds: ['catalogs', 'monetization'] }))
    expect(out.assets.catalogs).toEqual([{ id: CATALOG, name: 'Catalog A', ownedByThisPortfolio: true }, { id: '600000000000009', takenByAnotherBusiness: null }, { id: '600000000000010', takenByAnotherBusiness: null }])
    expect(out.assets.monetization).toEqual([{ id: '650000000000001', takenByAnotherBusiness: null }])
    expect(JSON.stringify(out)).not.toMatch(/Catalog of another|No owner said/)
    // v26 product-catalog documents `business` ("Business that owns a catalog"); owner_business is SDK only (review round 2, B4).
    expect(h.calls.find((c) => c.path === `${SYSTEM_USER}/assigned_product_catalogs`)?.query?.fields).toBe('id,name,business{id}')
  })
  it('by-person in a portfolio another business shares: catalogs and the rest are ids only', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: PORTFOLIO }]
    h.answer = (req) => (req.path.endsWith('/assigned_product_catalogs') ? { data: [{ id: CATALOG, name: 'Catalog A', business: { id: PORTFOLIO } }] } : answers(req))
    const out = data(await run('meta-account-access', { view: 'by-person', kinds: ['catalogs'] }))
    expect(out.assets.catalogs).toEqual([{ id: CATALOG, takenByAnotherBusiness: null }])
    expect(JSON.stringify(out)).not.toMatch(/Catalog A/)
  })
  it('asset-people: only the chosen Page / Instagram account, a catalog of the portfolio, a pixel of the account', async () => {
    expect((await run('meta-account-access', { view: 'asset-people', asset: 'page', assetId: '120000000000099' })).error).toMatch(/Only the Facebook Page this business chose/)
    expect((await run('meta-account-access', { view: 'asset-people', asset: 'pixel', assetId: '400000000000999' })).error).toMatch(/not one of the chosen ad account's pixels/)
    expect((await run('meta-account-access', { view: 'asset-people', asset: 'catalog', assetId: '600000000000002' })).error).toMatch(/not a catalog of the chosen ad account's business portfolio/)
    h.taken = [{ product: 'PORTFOLIO', id: PORTFOLIO }]
    expect((await run('meta-account-access', { view: 'asset-people', asset: 'catalog', assetId: CATALOG })).error).toMatch(/cannot tell whose this catalog is/)
    expect(h.calls.some((c) => c.path.endsWith('/assigned_users') && c.path !== `act_${ACCOUNT}/assigned_users`)).toBe(false)
  })
  it('a Page\'s people Meta refuses to the system-user token: said with what that means', async () => {
    h.answer = (req) => (req.path === `${PAGE}/assigned_users` ? refusedByMeta('(#200) Requires a Page access token', '200', 'forbidden') : answers(req))
    expect((await run('meta-account-access', { view: 'asset-people', asset: 'page' })).error).toMatch(/Page access token|system-user token/)
  })
  it('instagram: the chosen account\'s allowed ad accounts asked with the portfolio; another business\'s masked', async () => {
    h.taken = [{ product: 'AD_ACCOUNT', id: '5550001112' }, { product: 'INSTAGRAM', id: '170000000000099' }]
    h.answer = (req) => {
      if (req.path === `${IG}/authorized_adaccounts`) return { data: [{ account_id: ACCOUNT, name: 'Shop A ads' }, { account_id: '5550001112', name: 'Other ads' }] }
      if (req.path.endsWith('/connected_instagram_accounts')) return { data: [{ id: IG, username: 'shop_a' }, { id: '170000000000099', username: 'other' }] }
      return answers(req)
    }
    const out = data(await run('meta-account-access', { view: 'instagram' }))
    expect(out.chosenAccountMayAdvertiseFrom).toEqual([{ adAccountId: ACCOUNT, name: 'Shop A ads', chosenHere: true, takenByAnotherBusiness: false }, { adAccountId: '5550001112', takenByAnotherBusiness: true }])
    expect(out.connected).toEqual([{ instagramId: IG, username: 'shop_a', chosenHere: true, takenByAnotherBusiness: false }, { instagramId: '170000000000099', takenByAnotherBusiness: true }])
    expect(h.calls.find((c) => c.path === `${IG}/authorized_adaccounts`)?.query?.business).toBe(PORTFOLIO)
    expect(h.calls.find((c) => c.path === `act_${ACCOUNT}/instagram_accounts`)?.query?.summary).toBe('total_count')
  })
  it('asset-people instagram: the chosen account must be an Instagram asset of the portfolio (owned, else client)', async () => {
    h.answer = (req) => (req.path.endsWith('_instagram_assets') ? { data: [{ id: IG_ASSET, ig_user_id: '170000000000099' }] } : answers(req))
    expect((await run('meta-account-access', { view: 'asset-people', asset: 'instagram' })).error).toMatch(/not an Instagram asset of the chosen ad account's business portfolio/)
    expect(h.calls.map((c) => c.path)).toEqual([`${PORTFOLIO}/owned_instagram_assets`, `${PORTFOLIO}/client_instagram_assets`])
  })
})

describe('meta-account-access, review round 2', () => {
  const OTHER_PORTFOLIO = '9000000000008'
  const people = (req: Req) => {
    if (req.path === `${SYSTEM_USER}/assigned_ad_accounts`) return { data: [
      { account_id: ACCOUNT, name: 'Shop A ads', business: { id: PORTFOLIO } },
      { account_id: '5550001113', name: 'Shop A second', business: { id: PORTFOLIO } },
      { account_id: '5550001114', name: 'Unpicked of another', business: { id: OTHER_PORTFOLIO } },
      { account_id: '5550001115', name: 'Owner not said' },
    ] }
    if (req.path === `${SYSTEM_USER}/assigned_pages`) return { data: [
      { id: PAGE, name: 'Shop A page', business: { id: OTHER_PORTFOLIO } },
      { id: '120000000000011', name: 'Shop A other page', business: { id: PORTFOLIO } },
      { id: '120000000000012', name: 'Page of another', business: { id: OTHER_PORTFOLIO } },
    ] }
    if (req.path === `${SYSTEM_USER}/assigned_instagram_accounts`) return { data: [{ id: IG, username: 'shop_a' }, { id: '170000000000002', username: 'shop_a_two' }, { id: '170000000000003', username: 'someone_else' }] }
    if (req.path === `${PORTFOLIO}/owned_instagram_assets`) return { data: [{ id: IG_ASSET, ig_user_id: '170000000000002' }] }
    if (req.path === `${PORTFOLIO}/client_instagram_assets`) return { data: [{ id: '180000000000003', ig_user_id: '170000000000003' }] }
    return answers(req)
  }
  const unnamed = /Unpicked of another|Owner not said|Page of another|someone_else/
  it('by-person: ad accounts, Pages and Instagram accounts are named only when chosen here, or owned by the chosen portfolio (A1)', async () => {
    h.answer = people
    const out = data(await run('meta-account-access', { view: 'by-person', kinds: ['adAccounts', 'pages', 'instagram'] }))
    expect(out.assets.adAccounts).toEqual([
      { id: ACCOUNT, name: 'Shop A ads', chosenHere: true, ownedByThisPortfolio: true, takenByAnotherBusiness: false },
      { id: '5550001113', name: 'Shop A second', chosenHere: false, ownedByThisPortfolio: true, takenByAnotherBusiness: false },
      { id: '5550001114', takenByAnotherBusiness: null },
      { id: '5550001115', takenByAnotherBusiness: null },
    ])
    expect(out.assets.pages).toEqual([
      { id: PAGE, name: 'Shop A page', chosenHere: true, ownedByThisPortfolio: false, takenByAnotherBusiness: false },
      { id: '120000000000011', name: 'Shop A other page', chosenHere: false, ownedByThisPortfolio: true, takenByAnotherBusiness: false },
      { id: '120000000000012', takenByAnotherBusiness: null },
    ])
    // Instagram: the portfolio's OWN Instagram business assets decide; a client asset is another portfolio's (id only).
    expect(out.assets.instagram).toEqual([
      { id: IG, name: 'shop_a', chosenHere: true, ownedByThisPortfolio: false, takenByAnotherBusiness: false },
      { id: '170000000000002', name: 'shop_a_two', chosenHere: false, ownedByThisPortfolio: true, takenByAnotherBusiness: false },
      { id: '170000000000003', takenByAnotherBusiness: null },
    ])
    expect(JSON.stringify(out)).not.toMatch(unnamed)
    expect(h.calls.find((c) => c.path === `${SYSTEM_USER}/assigned_ad_accounts`)?.query?.fields).toBe('account_id,name,business{id}')
    expect(h.calls.find((c) => c.path === `${SYSTEM_USER}/assigned_pages`)?.query?.fields).toBe('id,name,business{id}')
    expect(h.calls.some((c) => c.path === `${PORTFOLIO}/client_instagram_assets`)).toBe(false)
    for (const c of h.calls) expect(metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' }), c.path).toBeNull()
  })
  it('by-person in a portfolio another business shares: only the assets chosen here are named, and the portfolio\'s Instagram list is not read', async () => {
    h.answer = people
    h.taken = [{ product: 'PORTFOLIO', id: PORTFOLIO }]
    const out = data(await run('meta-account-access', { view: 'by-person', kinds: ['adAccounts', 'pages', 'instagram'] }))
    expect(out.assets.adAccounts.map((a: Record<string, unknown>) => a.name ?? null)).toEqual(['Shop A ads', null, null, null])
    expect(out.assets.pages.map((a: Record<string, unknown>) => a.name ?? null)).toEqual(['Shop A page', null, null])
    expect(out.assets.instagram.map((a: Record<string, unknown>) => a.name ?? null)).toEqual(['shop_a', null, null])
    expect(JSON.stringify(out)).not.toMatch(/Shop A second|Shop A other page|shop_a_two/)
    expect(h.calls.some((c) => c.path.endsWith('_instagram_assets'))).toBe(false)
  })
  it('by-person Instagram: an owned list Meta refuses names only the chosen one and says why; a throttle ends the read', async () => {
    h.answer = (req) => (req.path === `${PORTFOLIO}/owned_instagram_assets` ? refusedByMeta('(#200) Requires business_management', '200', 'forbidden') : people(req))
    const out = data(await run('meta-account-access', { view: 'by-person', kinds: ['instagram'] }))
    expect(out.assets.instagram.map((a: Record<string, unknown>) => a.name ?? null)).toEqual(['shop_a', null, null])
    expect(out.missing).toEqual([{ part: 'instagram owner', sentence: expect.stringMatching(/could not list .*business_management/) }])
    h.answer = (req) => (req.path === `${PORTFOLIO}/owned_instagram_assets` ? refusedByMeta('(#80004) too many calls', '80004', 'rate_limited') : people(req))
    expect((await run('meta-account-access', { view: 'by-person', kinds: ['instagram'] })).error).toMatch(/slow down/)
  })
  it('asset-people catalog: the id must be in the portfolio\'s owned or client catalogs — a Page id of the same portfolio is refused before any people read (A5)', async () => {
    h.answer = (req) => (req.path === `${PORTFOLIO}/client_product_catalogs` ? { data: [{ id: '600000000000003' }] } : answers(req))
    expect((await run('meta-account-access', { view: 'asset-people', asset: 'catalog', assetId: '120000000000011' })).error).toMatch(/not a catalog of the chosen ad account's business portfolio/)
    expect(h.calls.map((c) => c.path)).toEqual([`${PORTFOLIO}/owned_product_catalogs`, `${PORTFOLIO}/client_product_catalogs`])
    expect(h.calls.some((c) => c.path.endsWith('/assigned_users'))).toBe(false)
    h.calls.length = 0
    expect(data(await run('meta-account-access', { view: 'asset-people', asset: 'catalog', assetId: '600000000000003' })).assetId).toBe('600000000000003')
    expect(h.calls.find((c) => c.path === '600000000000003/assigned_users')?.query?.business).toBe(PORTFOLIO)
    // A list Meta refuses is said with Meta's words; a throttle ends the read before the next list.
    h.calls.length = 0
    h.answer = (req) => (req.path === `${PORTFOLIO}/owned_product_catalogs` ? refusedByMeta('(#200) Requires catalog_management', '200', 'forbidden') : answers(req))
    expect((await run('meta-account-access', { view: 'asset-people', asset: 'catalog', assetId: CATALOG })).error).toMatch(/could not list the business portfolio's catalogs .*catalog_management/)
    h.calls.length = 0
    h.answer = (req) => (req.path === `${PORTFOLIO}/owned_product_catalogs` ? refusedByMeta('(#80004) too many calls', '80004', 'rate_limited') : answers(req))
    expect((await run('meta-account-access', { view: 'asset-people', asset: 'catalog', assetId: CATALOG })).error).toMatch(/slow down/)
    expect(h.calls.map((c) => c.path)).toEqual([`${PORTFOLIO}/owned_product_catalogs`])
  })
  it('asset-people instagram: a throttle or a lost token ends the read; another refusal is said, never "not an asset of the portfolio" (B5)', async () => {
    h.answer = (req) => (req.path === `${PORTFOLIO}/owned_instagram_assets` ? refusedByMeta('(#80004) too many calls', '80004', 'rate_limited') : answers(req))
    expect((await run('meta-account-access', { view: 'asset-people', asset: 'instagram' })).error).toMatch(/slow down/)
    expect(h.calls.map((c) => c.path)).toEqual([`${PORTFOLIO}/owned_instagram_assets`])
    h.calls.length = 0
    h.answer = (req) => (req.path === `${PORTFOLIO}/owned_instagram_assets` ? refusedByMeta('Error validating access token', '190', 'auth_expired') : answers(req))
    expect((await run('meta-account-access', { view: 'asset-people', asset: 'instagram' })).error).toMatch(/no longer accepts this business's system-user token/)
    expect(h.calls.map((c) => c.path)).toEqual([`${PORTFOLIO}/owned_instagram_assets`])
    h.calls.length = 0
    h.answer = (req) => (req.path === `${PORTFOLIO}/owned_instagram_assets` ? refusedByMeta('(#200) Requires business_management', '200', 'forbidden') : req.path.endsWith('/client_instagram_assets') ? { data: [] } : answers(req))
    const refused = (await run('meta-account-access', { view: 'asset-people', asset: 'instagram' })).error
    expect(refused).toMatch(/could not list the business portfolio's Instagram assets .*business_management/)
    expect(refused).not.toMatch(/is not an Instagram asset/)
    h.calls.length = 0
    h.answer = (req) => (req.path === `${PORTFOLIO}/owned_instagram_assets` ? refusedByMeta('(#200) Requires business_management', '200', 'forbidden') : req.path.endsWith('/client_instagram_assets') ? { data: [{ id: IG_ASSET, ig_user_id: IG }] } : answers(req))
    expect(data(await run('meta-account-access', { view: 'asset-people', asset: 'instagram' })).assetId).toBe(IG_ASSET)
  })
})

describe('the units (facts F1 X4, SDK currencyamount.py)', () => {
  it('spend_cap is read in offset units, 0 is no cap', () => {
    expect(metaAccountSpendCapMicros('2350', 'USD')).toBe(23_500_000n)
    expect(metaAccountSpendCapMicros('2350', 'JPY')).toBe(2_350_000_000n)
    expect(metaAccountSpendCapMicros('0', 'EUR')).toBeNull()
    expect(metaAccountSpendCapMicros(undefined, 'EUR')).toBeNull()
    // BHD: Meta's offset is 100 (hundredths), so "2350" is 23.50 BHD.
    expect(metaAccountSpendCapMicros('2350', 'BHD')).toBe(23_500_000n)
  })
  it('minor units → the standard-unit string Meta reads on a spend_cap WRITE (set-meta-spend-cap, step 40), from Meta\'s offset', () => {
    expect(minorToMetaStandard(50000, 'EUR')).toBe('500.00')
    expect(minorToMetaStandard(5, 'EUR')).toBe('0.05')
    expect(minorToMetaStandard(1250, 'JPY')).toBe('1250')
    // Review round 2 (A2, B3) — Meta's offset, never the currency's own decimals: BHD / JOD in hundredths (1250 = 1.250
    // BHD → "1.25"; 5 = 0.005 BHD is no whole hundredth → null), CRC / TWD in whole units.
    expect(minorToMetaStandard(1250, 'BHD')).toBe('1.25')
    expect(minorToMetaStandard(12500, 'BHD')).toBe('12.50')
    expect(minorToMetaStandard(5, 'BHD')).toBeNull()
    expect(minorToMetaStandard(12340, 'JOD')).toBe('12.34')
    expect(minorToMetaStandard(12345, 'JOD')).toBeNull()
    expect(minorToMetaStandard(125000, 'CRC')).toBe('1250')
    expect(minorToMetaStandard(125050, 'CRC')).toBeNull()
    expect(minorToMetaStandard(1200, 'TWD')).toBe('12')
    expect(minorToMetaStandard(1250, 'TWD')).toBeNull()
    expect(minorToMetaStandard(2350, 'usd')).toBe('23.50')
    // 0 would REMOVE the cap ("A value of 0 signifies no spending-cap"); a negative cap is none: never a string to send.
    expect(minorToMetaStandard(0, 'EUR')).toBeNull()
    expect(minorToMetaStandard(0, 'JPY')).toBeNull()
    expect(minorToMetaStandard(-250, 'USD')).toBeNull()
    // No currency, or one Meta does not list: never guessed.
    expect(minorToMetaStandard(1250, null)).toBeNull()
    expect(minorToMetaStandard(1250, undefined)).toBeNull()
    expect(minorToMetaStandard(1250, '')).toBeNull()
    expect(minorToMetaStandard(1250, 'KWD')).toBeNull()
    expect(minorToMetaStandard(1250, 'XYZ')).toBeNull()
    expect(minorToMetaStandard(1.5, 'EUR')).toBeNull()
  })
  it('a spend cap read and written back is the same cap, in every Meta currency', () => {
    for (const [currency, offset] of Object.entries(META_CURRENCY_OFFSETS)) {
      // Meta READS "2300" in offset units; Nexus answers minor units; the WRITE string is the same amount in standard units.
      const minor = minorOf(metaAccountSpendCapMicros('2300', currency), currency)!
      expect(minorToMetaStandard(minor, currency), currency).toBe(offset === 100 ? '23.00' : '2300')
    }
    for (const currency of ['EUR', 'USD', 'BHD', 'JOD']) expect(minorToMetaStandard(minorOf(metaAccountSpendCapMicros('2350', currency), currency)!, currency), currency).toBe('23.50')
  })
  it('Meta\'s currency table: the offset-1 currencies are exactly those metaOffset counts in whole units', () => {
    expect(Object.keys(META_CURRENCY_OFFSETS)).toHaveLength(66)
    expect(Object.entries(META_CURRENCY_OFFSETS).filter(([, o]) => o === 1).map(([c]) => c).sort()).toEqual([...META_OFFSET_ONE].sort())
    expect(['BHD', 'JOD', 'CRC', 'TWD'].map((c) => META_CURRENCY_OFFSETS[c])).toEqual([100, 100, 1, 1])
    expect(META_CURRENCY_OFFSETS.KWD).toBeUndefined()
  })
  it('one normalised currency code (review round 3): upper case, three letters, never trimmed — a padded code is refused, never 10× or 100× off', () => {
    expect([metaCurrencyCode('eur'), metaCurrencyCode('EUR'), metaCurrencyCode(' TWD'), metaCurrencyCode('TWD '), metaCurrencyCode('EURO'), metaCurrencyCode(''), metaCurrencyCode(null)]).toEqual(['EUR', 'EUR', null, null, null, null, null])
    expect(minorToMetaStandard(50000, 'eur')).toBe('500.00')
    expect(minorToMetaStandard(1200, 'twd')).toBe('12')
    for (const [minor, currency] of [[1250, ' TWD'], [1200, 'TWD '], [125000, ' CRC'], [1250, ' BHD'], [1250, 'BHD '], [2300, ' PKR'], [50000, 'EURO'], [50000, ' EUR']] as const) {
      expect(minorToMetaStandard(minor, currency), `${minor} "${currency}"`).toBeNull()
      expect(minorToMetaUnits(minor, currency), `${minor} "${currency}"`).toBeNull()
    }
  })
  it('never a rounded cap: Meta units past 2^53 are refused (review round 3)', () => {
    expect(minorToMetaStandard(900719925474099, 'PKR')).toBeNull()
    expect(minorToMetaUnits(900719925474099, 'PKR')).toBeNull()
    expect(minorToMetaUnits(Number.MAX_SAFE_INTEGER, 'EUR')).toBe(Number.MAX_SAFE_INTEGER)
    expect(minorToMetaStandard(Number.MAX_SAFE_INTEGER, 'EUR')).toBe('90071992547409.91')
  })
  it('minor units → Meta\'s offset units, only when whole, never below 0, never without a currency (the one helper)', () => {
    expect(minorToMetaUnits(1250, 'EUR')).toBe(1250)
    expect(minorToMetaUnits(1250, 'JPY')).toBe(1250)
    expect(minorToMetaUnits(1250, 'BHD')).toBe(125)
    expect(minorToMetaUnits(1255, 'BHD')).toBeNull()
    expect(minorToMetaUnits(1.5, 'EUR')).toBeNull()
    expect(minorToMetaUnits(-1, 'EUR')).toBeNull()
    expect(minorToMetaUnits(1250, '')).toBeNull()
    expect(minorToMetaUnits(1250, null)).toBeNull()
  })
  it('a CurrencyAmount in its own currency: offsetted_amount first, else the decimal amount', () => {
    expect(currencyAmountMicros({ amount: '100.00', currency: 'USD', offsetted_amount: '10000' })).toEqual({ micros: 100_000_000n, currency: 'USD' })
    expect(currencyAmountMicros({ amount: '1000', currency: 'jpy', offsetted_amount: '1000' })).toEqual({ micros: 1_000_000_000n, currency: 'JPY' })
    expect(currencyAmountMicros({ amount: '12.34', currency: 'EUR' })).toEqual({ micros: 12_340_000n, currency: 'EUR' })
    expect(currencyAmountMicros({ amount: '12.34' })).toBeNull()
    expect(currencyAmountMicros('12.34')).toBeNull()
  })
})

describe('without a Meta connection', () => {
  it('each tool refuses in words, before any call', async () => {
    h.connections = []
    for (const name of ['meta-ad-account', 'meta-billing', 'meta-account-access']) expect((await run(name, {})).error).toMatch(/not connected/)
    expect(h.calls).toHaveLength(0)
  })
})
