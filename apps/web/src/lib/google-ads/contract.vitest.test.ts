/**
 * Google Ads steps 1a and 1b — the typed calls of the web's one copy of the API contract. The backend is built in
 * parallel, so every answer here is a stand-in `fetch`; what is pinned is the request the web sends and how it reads the
 * answer. Ids and values are made up.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://localhost:8091' }))

import {
  GoogleAdsHttpError,
  MAX_GOOGLE_PAGES,
  errorText,
  fetchAllGoogleCampaigns,
  fetchAllGooglePages,
  fetchGoogleActsOnItsOwn,
  fetchGoogleAdGroups,
  fetchGoogleAlerts,
  fetchGoogleAssetGroups,
  fetchGoogleBrandSplit,
  fetchGoogleDisapprovals,
  fetchGoogleKeywords,
  fetchGoogleNegatives,
  fetchGoogleProducts,
  fetchGoogleRecommendations,
  fetchGoogleSearchTerms,
  fetchGoogleCampaignChanges,
  fetchGoogleCampaignDays,
  fetchGoogleChoices,
  fetchGoogleConnections,
  fetchGoogleOverview,
  requestGoogleRead,
  saveGoogleSelection,
} from './contract'

function reply(body: unknown, status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

describe('connection calls (C1–C3)', () => {
  it('C1 reads the business’s Google sign-ins with credentials and no cache', async () => {
    const f = reply({ items: [] })
    await expect(fetchGoogleConnections(f)).resolves.toEqual({ items: [] })
    expect(f).toHaveBeenCalledWith('http://localhost:8091/api/google-ads/connections', expect.objectContaining({ credentials: 'include', cache: 'no-store' }))
  })

  it('C2 encodes the connection id', async () => {
    const f = reply({ missingProducts: [], ads: { customers: [], error: null }, merchantCenter: { accounts: [], error: null }, analytics: { properties: [], error: null } })
    await fetchGoogleChoices('conn/1', f)
    expect(f.mock.calls[0]![0]).toBe('http://localhost:8091/api/google-ads/connections/conn%2F1/choices')
  })

  it('C3 PUTs the selection body and returns the saved account', async () => {
    const account = { connectionId: 'c1' }
    const f = reply({ account })
    const body = { adsCustomerId: '1112223333', managerCustomerId: null, merchantCenterId: null, analyticsPropertyId: null }
    await expect(saveGoogleSelection('c1', body, f)).resolves.toEqual({ ok: true, account })
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('http://localhost:8091/api/google-ads/connections/c1/selection')
    expect(init).toMatchObject({ method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' } })
    expect(JSON.parse(String(init!.body))).toEqual(body)
  })

  it.each(['customer_taken', 'not_offered'] as const)('C3 reads a 409 %s as a refusal with its code', async (code) => {
    const f = reply({ code, error: 'Refused in words.' }, 409)
    await expect(saveGoogleSelection('c1', { adsCustomerId: '1', managerCustomerId: null, merchantCenterId: null, analyticsPropertyId: null }, f))
      .resolves.toEqual({ ok: false, status: 409, code, error: 'Refused in words.' })
  })

  it('C3 reads a 409 taken_by_other_business with the product another business picked', async () => {
    const f = reply({ code: 'taken_by_other_business', product: 'merchant_center', error: 'Refused in words.' }, 409)
    await expect(saveGoogleSelection('c1', { adsCustomerId: '1', managerCustomerId: null, merchantCenterId: '2', analyticsPropertyId: null }, f))
      .resolves.toEqual({ ok: false, status: 409, code: 'taken_by_other_business', product: 'merchant_center', error: 'Refused in words.' })
  })

  it('C3 keeps an unknown 409 code out of the typed codes', async () => {
    const f = reply({ code: 'something_else', error: 'No.' }, 409)
    const r = await saveGoogleSelection('c1', { adsCustomerId: '1', managerCustomerId: null, merchantCenterId: null, analyticsPropertyId: null }, f)
    expect(r).toMatchObject({ ok: false, code: null })
  })
})

describe('read calls (R1–R4, S)', () => {
  it('R1 sends the window, and the account only when one is picked', async () => {
    const f = reply({})
    await fetchGoogleOverview({ from: '2026-09-13', to: '2026-10-12' }, f)
    await fetchGoogleOverview({ account: 'c2', from: '2026-09-13', to: '2026-10-12' }, f)
    expect(f.mock.calls[0]![0]).toBe('http://localhost:8091/api/google-ads/overview?from=2026-09-13&to=2026-10-12')
    expect(f.mock.calls[1]![0]).toBe('http://localhost:8091/api/google-ads/overview?account=c2&from=2026-09-13&to=2026-10-12')
  })

  it('R2 follows the cursor until the last page', async () => {
    const pages = [
      { window: {}, currency: 'EUR', dataAsOf: null, coverage: {}, items: [{ campaignId: 'a' }], nextCursor: 'k1', total: 2 },
      { window: {}, currency: 'EUR', dataAsOf: null, coverage: {}, items: [{ campaignId: 'b' }], nextCursor: null, total: 2 },
    ]
    const f = vi.fn(async () => new Response(JSON.stringify(pages.shift()), { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>
    const all = await fetchAllGoogleCampaigns({ from: '2026-10-01', to: '2026-10-12' }, f)
    expect(all.items.map((c) => c.campaignId)).toEqual(['a', 'b'])
    expect(all.truncated).toBe(false)
    expect(f.mock.calls[0]![0]).toBe('http://localhost:8091/api/google-ads/campaigns?from=2026-10-01&to=2026-10-12&limit=500')
    expect(f.mock.calls[1]![0]).toBe('http://localhost:8091/api/google-ads/campaigns?from=2026-10-01&to=2026-10-12&limit=500&cursor=k1')
  })

  it('R3 and R4 address one campaign', async () => {
    const f = reply({})
    await fetchGoogleCampaignDays('cmp 1', { from: '2026-10-01', to: '2026-10-12' }, f)
    await fetchGoogleCampaignChanges('cmp 1', f)
    expect(f.mock.calls[0]![0]).toBe('http://localhost:8091/api/google-ads/campaigns/cmp%201/days?from=2026-10-01&to=2026-10-12')
    expect(f.mock.calls[1]![0]).toBe('http://localhost:8091/api/google-ads/campaigns/cmp%201/changes')
  })

  it('a 404 outside the business is an error carrying its status and the server’s sentence', async () => {
    const f = reply({ error: 'Campaign not found' }, 404)
    const err = await fetchGoogleCampaignDays('x', { from: '2026-10-01', to: '2026-10-02' }, f).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleAdsHttpError)
    expect(err).toMatchObject({ status: 404, message: 'Campaign not found' })
  })

  it('S posts with no body and reads queued / reason', async () => {
    const f = reply({ queued: false, reason: 'A read ran less than an hour ago.' })
    await expect(requestGoogleRead(null, f)).resolves.toEqual({ queued: false, reason: 'A read ran less than an hour ago.' })
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('http://localhost:8091/api/google-ads/sync')
    expect(init).toEqual({ method: 'POST', credentials: 'include' })
  })

  it('S never treats a malformed answer as queued', async () => {
    await expect(requestGoogleRead(null, reply({ queued: 'yes' }))).resolves.toEqual({ queued: false, reason: null })
  })
})

describe('errorText', () => {
  it('prefers the informative half of an error body', () => {
    expect(errorText({ error: 'Internal Server Error', message: 'Google did not answer.' }, 500)).toBe('Google did not answer.')
    expect(errorText({ error: 'Choose an account first.' }, 400)).toBe('Choose an account first.')
  })
  it('says what a bare 403 means', () => {
    expect(errorText(null, 403)).toMatch(/role cannot see/)
  })
})

describe('step 1b reads (R5–R15): GET only, the window and the filters as query parameters', () => {
  const base = 'http://localhost:8091/api/google-ads'
  const win = { from: '2026-10-01', to: '2026-10-12' }

  it('R5 ad groups: the window, the campaign (its id encoded) and a page', async () => {
    const f = reply({})
    await fetchGoogleAdGroups({ ...win, campaignId: '1112223333~444', status: 'ENABLED', limit: 500, cursor: 'k1' }, f)
    expect(f.mock.calls[0]![0]).toBe(`${base}/ad-groups?from=2026-10-01&to=2026-10-12&campaignId=1112223333%7E444&status=ENABLED&limit=500&cursor=k1`)
    expect(f.mock.calls[0]![1]).toEqual({ credentials: 'include', cache: 'no-store' })
  })

  it('R6 keywords: ad group, match type, sort and search', async () => {
    const f = reply({})
    await fetchGoogleKeywords({ account: 'c2', ...win, campaignId: 'cmp_1', adGroupId: 'ag 1', matchType: 'EXACT', search: 'red shoes', sort: 'spend' }, f)
    expect(f.mock.calls[0]![0]).toBe(`${base}/keywords?account=c2&from=2026-10-01&to=2026-10-12&campaignId=cmp_1&adGroupId=ag+1&matchType=EXACT&search=red+shoes&sort=spend`)
  })

  it('R7 negatives take no window', async () => {
    const f = reply({})
    await fetchGoogleNegatives({ campaignId: 'cmp_1', level: 'list' }, f)
    expect(f.mock.calls[0]![0]).toBe(`${base}/negatives?campaignId=cmp_1&level=list`)
  })

  it('R8 search terms and R9 the brand split', async () => {
    const f = reply({})
    await fetchGoogleSearchTerms({ ...win, campaignId: null, brand: 'non_brand', sort: 'clicks', limit: 500 }, f)
    await fetchGoogleBrandSplit({ account: 'c2', ...win }, f)
    expect(f.mock.calls[0]![0]).toBe(`${base}/search-terms?from=2026-10-01&to=2026-10-12&brand=non_brand&sort=clicks&limit=500`)
    expect(f.mock.calls[1]![0]).toBe(`${base}/brand-split?account=c2&from=2026-10-01&to=2026-10-12`)
  })

  it('R10 asset groups and R11 products', async () => {
    const f = reply({})
    await fetchGoogleAssetGroups({ ...win, campaignId: 'cmp_1' }, f)
    await fetchGoogleProducts({ ...win, issue: 'not_eligible', sort: 'title', search: 'SKU-1' }, f)
    expect(f.mock.calls[0]![0]).toBe(`${base}/asset-groups?from=2026-10-01&to=2026-10-12&campaignId=cmp_1`)
    expect(f.mock.calls[1]![0]).toBe(`${base}/products?from=2026-10-01&to=2026-10-12&issue=not_eligible&search=SKU-1&sort=title`)
  })

  it('R12–R15: the account only when one is picked, and their filters', async () => {
    const f = reply({})
    await fetchGoogleActsOnItsOwn({}, f)
    await fetchGoogleRecommendations({ account: 'c2', campaignId: 'cmp_1', type: 'KEYWORD' }, f)
    await fetchGoogleAlerts({ account: 'c2' }, f)
    await fetchGoogleDisapprovals({ kind: 'product' }, f)
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      `${base}/acts-on-its-own`,
      `${base}/recommendations?account=c2&campaignId=cmp_1&type=KEYWORD`,
      `${base}/alerts?account=c2`,
      `${base}/disapprovals?kind=product`,
    ])
  })

  it('never sends a write: every step-1b call is a plain GET', async () => {
    const f = reply({})
    await fetchGoogleAdGroups(win, f)
    await fetchGoogleAlerts({}, f)
    for (const [, init] of f.mock.calls) expect((init as RequestInit | undefined)?.method ?? 'GET').toBe('GET')
  })

  it('a refusal carries its status and the server’s sentence', async () => {
    const err = await fetchGoogleKeywords({ ...win, campaignId: 'not-mine' }, reply({ error: 'Campaign not found' }, 404)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleAdsHttpError)
    expect(err).toMatchObject({ status: 404, message: 'Campaign not found' })
  })
})

describe('fetchAllGooglePages: follows the cursor, up to a cap, and says when it stopped short', () => {
  type P = { read: string; items: string[]; nextCursor: string | null; total: number }
  const pageOf = (n: number, last: number): P => ({ read: `meta-${n}`, items: [`row-${n}`], nextCursor: n < last ? `k${n + 1}` : null, total: last + 1 })

  it('every page, in order, with the first page’s other fields', async () => {
    const asked: Array<string | null> = []
    const all = await fetchAllGooglePages<P>(async (cursor) => { asked.push(cursor); return pageOf(cursor ? Number(cursor.slice(1)) : 0, 2) })
    expect(asked).toEqual([null, 'k1', 'k2'])
    expect(all).toEqual({ read: 'meta-0', items: ['row-0', 'row-1', 'row-2'], nextCursor: null, total: 3, truncated: false })
  })

  it('stops at the cap and says the list is cut', async () => {
    let calls = 0
    const all = await fetchAllGooglePages<P>(async (cursor) => { calls++; return pageOf(cursor ? Number(cursor.slice(1)) : 0, 99) }, 3)
    expect(calls).toBe(3)
    expect(all.items).toHaveLength(3)
    expect(all).toMatchObject({ nextCursor: null, truncated: true })
    expect(MAX_GOOGLE_PAGES).toBeGreaterThan(1)
  })

  it('a failed page fails the whole read (never a partial list shown as whole)', async () => {
    const p = fetchAllGooglePages<P>(async (cursor) => { if (cursor) throw new GoogleAdsHttpError(500, 'Google did not answer.'); return pageOf(0, 1) })
    await expect(p).rejects.toMatchObject({ status: 500 })
  })
})
