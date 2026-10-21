/**
 * Meta step 40 — the change's own live read of the chosen ad account (stand-ins for the read client, the chosen account and
 * step 3's views): ONE GET of fixed fields, raw values as the drafts compare them, account_status and disable_reason always
 * asked (the Nexus safety rule stands on them), the agency declaration without the e-mail, flags as "0" / "1", a refusal of
 * the declaration in words, and an insights feature offered / on / not read. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  reads: [] as Array<{ path: string; query: Record<string, unknown> }>,
  body: {} as Record<string, unknown>,
  agency: null as Record<string, unknown> | Error | null,
  chosen: { adAccountId: '1234567890', pageId: '120000000000080' } as Record<string, unknown>,
  view: {} as Record<string, unknown>,
  paged: { rows: [] as Array<Record<string, unknown>>, more: false },
  pagedCalls: [] as unknown[][],
}))
vi.mock('./read-client.js', () => ({
  metaReadOne: vi.fn(async (_c: unknown, req: { path: string; query: Record<string, unknown> }) => {
    h.reads.push({ path: req.path, query: req.query })
    if (String(req.query.fields).startsWith('agency_client_declaration')) {
      if (h.agency instanceof Error) throw h.agency
      return { body: { agency_client_declaration: h.agency } }
    }
    return { body: h.body }
  }),
}))
vi.mock('./paging.js', async (importActual) => ({
  ...(await importActual<typeof import('./paging.js')>()),
  listPaged: vi.fn(async (...args: unknown[]) => { h.pagedCalls.push(args); return { rows: structuredClone(h.paged.rows), more: h.paged.more, totalCount: null } }),
}))
vi.mock('./live.js', async (importActual) => ({
  ...(await importActual<typeof import('./live.js')>()),
  metaChosenAccount: vi.fn(async () => h.chosen),
}))
vi.mock('./live-account.js', async (importActual) => ({
  ...(await importActual<typeof import('./live-account.js')>()),
  adAccountView: vi.fn(async () => h.view),
}))

import { ACCOUNT_CHANGE_FIELDS, liveAccountState, liveAgencyDeclaration, liveInsightsFeature, liveTrackingSpecs } from './live-account-settings.js'
import { MetaReadError } from './errors.js'

const target = { connectionId: 'm-1', adAccountId: '1234567890' }

beforeEach(() => {
  h.reads = []
  h.body = {}
  h.agency = null
  h.chosen = { adAccountId: '1234567890', pageId: '120000000000080' }
  h.view = {}
  h.paged = { rows: [], more: false }
  h.pagedCalls = []
})

describe('liveAccountState', () => {
  it('one GET of act_<id> with fixed fields, status and disable reason always among them; raw values back', async () => {
    h.body = { id: 'act_1234567890', account_status: 2, disable_reason: '15', currency: 'EUR', name: 'Shop A ads', business_city: 'Città A', business_zip: '', is_personal: 0, tax_id_status: 1, default_dsa_payor: 'Shop A', is_notifications_enabled: false, end_advertiser: 120000000000080, media_agency: 'NONE', spend_cap: '50000', amount_spent: 12000 }
    const s = await liveAccountState(target)
    expect(h.reads).toEqual([{ path: 'act_1234567890', query: { fields: ACCOUNT_CHANGE_FIELDS } }])
    expect(ACCOUNT_CHANGE_FIELDS.split(',')).toEqual(expect.arrayContaining(['account_status', 'disable_reason', 'spend_cap', 'amount_spent', 'currency']))
    expect(ACCOUNT_CHANGE_FIELDS).not.toMatch(/email|agency_client_declaration/)
    expect(s).toMatchObject({
      status: 2, disableReason: 15, currency: 'EUR', name: 'Shop A ads', businessUse: true, notifications: false,
      dsa: { payor: 'Shop A', beneficiary: null }, parties: { end_advertiser: '120000000000080', media_agency: 'NONE', partner: null },
      spendCap: '50000', amountSpent: '12000', pageId: '120000000000080',
    })
    expect(s.businessInfo).toMatchObject({ business_city: 'Città A', business_zip: null, business_name: null })
  })
  it('fix round 1 (A-F1) — a spending limit Meta sent is never dropped: past 2^53 it stays visible as unsafe; only a missing one is null', async () => {
    h.body = { account_status: 1, spend_cap: 2 ** 60 }
    expect((await liveAccountState(target)).spendCap).toMatch(/^unsafe:/)
    h.body = { account_status: 1, spend_cap: '500.00' }
    expect((await liveAccountState(target)).spendCap).toBe('500.00')
    h.body = { account_status: 1, spend_cap: 0 }
    expect((await liveAccountState(target)).spendCap).toBe('0')
    h.body = { account_status: 1 }
    expect((await liveAccountState(target)).spendCap).toBeNull()
  })
  it('a personal-use account (or one Meta does not say) is not business use; another chosen account refuses', async () => {
    h.body = { account_status: 1, is_personal: 1 }
    expect((await liveAccountState(target)).businessUse).toBe(false)
    h.body = { account_status: 1 }
    expect((await liveAccountState(target)).businessUse).toBe(false)
    h.body = { account_status: 1, is_personal: 0, tax_id_status: 5 }
    expect((await liveAccountState(target)).businessUse).toBe(false)
    h.chosen = { adAccountId: '5555555555', pageId: null }
    await expect(liveAccountState(target)).rejects.toThrow(/chose changed while Nexus read it/)
  })
})

describe('liveAgencyDeclaration', () => {
  it('its own sub-fields (never the e-mail), flags as "0" / "1"; a refusal in words (Business Manager admin)', async () => {
    h.agency = { client_name: 'Client A', agency_representing_client: 1, client_based_in_france: false, client_email_address: 'a@example.com' }
    expect(await liveAgencyDeclaration(target)).toEqual({ declaration: { client_name: 'Client A', agency_representing_client: '1', client_based_in_france: '0' } })
    expect(String(h.reads[0].query.fields)).not.toMatch(/email/)
    h.agency = new MetaReadError({ origin: 'meta', httpStatus: 400, code: '200', authLost: false, throttled: false, permissionDenied: true, notFound: false, sentence: 'Meta does not let this system user read this.' }, 'accountChange.agencyDeclaration')
    expect(await liveAgencyDeclaration(target)).toEqual({ notRead: expect.stringMatching(/only to a Business Manager admin/) })
  })
})

describe('liveInsightsFeature', () => {
  it('offered when step 3\'s view lists it (with or without a type), on when Meta lists it on; not read: null', async () => {
    h.view = { features: [{ name: 'comscore', type: null, enabled: false, dataFrom: null }], missing: [] }
    expect(await liveInsightsFeature(target, 'comscore')).toEqual({ name: 'comscore', offered: true, enabled: false, dataFrom: null })
    h.view = { features: [], missing: [] }
    expect(await liveInsightsFeature(target, 'comscore')).toMatchObject({ offered: false, enabled: false })
    h.view = { features: [{ name: 'comscore', type: null, enabled: true, dataFrom: '2026-07-15' }], missing: [{ part: 'available' }] }
    expect(await liveInsightsFeature(target, 'comscore')).toEqual({ name: 'comscore', offered: null, enabled: true, dataFrom: '2026-07-15' })
    h.view = { features: [{ name: 'comscore', type: 'breakdown', enabled: null, dataFrom: null }], missing: [{ part: 'enabled' }] }
    expect(await liveInsightsFeature(target, 'comscore')).toMatchObject({ offered: true, enabled: null })
  })
})

describe('liveTrackingSpecs (last pass)', () => {
  it('reads to one past the most a change sends (21) and REFUSES a list it cannot read in full', async () => {
    h.paged = { rows: [{ tracking_specs: { 'action.type': ['like'], page: ['120000000000080'] } }, { tracking_specs: null }], more: false }
    expect(await liveTrackingSpecs(target)).toEqual([{ 'action.type': ['like'], page: ['120000000000080'] }])
    expect(h.pagedCalls[0]).toEqual(['m-1', 'accountChange.tracking', 'act_1234567890/tracking', { fields: 'tracking_specs' }, 21])
    h.paged = { rows: Array.from({ length: 21 }, (_, i) => ({ tracking_specs: { 'action.type': ['offsite_conversion'], fb_pixel: [String(120000000000100 + i)] } })), more: false }
    await expect(liveTrackingSpecs(target)).rejects.toThrow(/more than 20 account-level tracking specs/)
    h.paged = { rows: [{ tracking_specs: { 'action.type': ['like'], page: ['120000000000080'] } }], more: true }
    await expect(liveTrackingSpecs(target)).rejects.toThrow(/whole list/)
  })
})
