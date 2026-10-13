/**
 * Google Ads step 1a — the typed calls of the web's one copy of the API contract. The backend is built in parallel, so
 * every answer here is a stand-in `fetch`; what is pinned is the request the web sends and how it reads the answer.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://localhost:8091' }))

import {
  GoogleAdsHttpError,
  errorText,
  fetchAllGoogleCampaigns,
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
