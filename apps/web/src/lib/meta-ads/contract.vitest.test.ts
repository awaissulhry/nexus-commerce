/**
 * Meta ads — the typed calls of the web's one copy of the API contract. Every answer here is a stand-in `fetch`; what
 * is pinned is the request the web sends (paths, methods, bodies) and how it reads the answer — the app secret and the
 * token travel only in the connect / replace body.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://localhost:8091' }))

import {
  MetaAdsHttpError,
  checkMetaToken,
  errorText,
  fetchAllMetaCampaigns,
  fetchMetaCampaignDays,
  fetchMetaChoices,
  fetchMetaConnections,
  fetchMetaCustomerListsSwitch,
  fetchMetaEventsSwitch,
  fetchMetaOverview,
  requestMetaRead,
  saveMetaCredentials,
  saveMetaSelection,
  setMetaCustomerListsSwitch,
  setMetaEventsSwitch,
} from './contract'

function reply(body: unknown, status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

const CREDS = { appId: ' 1234567 ', appSecret: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6', systemUserToken: 'fixture-system-user-token-000000 ' }

describe('the connection', () => {
  it('reads the connections with credentials and no cache', async () => {
    const f = reply({ items: [] })
    await expect(fetchMetaConnections(f)).resolves.toEqual({ items: [] })
    expect(f).toHaveBeenCalledWith('http://localhost:8091/api/meta-ads/connections', expect.objectContaining({ credentials: 'include', cache: 'no-store' }))
  })

  it('connect POSTs the three values (trimmed); replace PUTs them to the connection', async () => {
    const f = reply({ connectionId: 'conn-1', placement: 'new', systemUser: { id: '120000000000001', name: null }, token: {}, adAccountsSeen: 1 })
    await expect(saveMetaCredentials(CREDS, null, f)).resolves.toMatchObject({ ok: true, answer: { connectionId: 'conn-1' } })
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('http://localhost:8091/api/meta-ads/connect')
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
    expect(JSON.parse(String(init!.body))).toEqual({ appId: '1234567', appSecret: CREDS.appSecret, systemUserToken: 'fixture-system-user-token-000000' })
    const g = reply({ connectionId: 'conn-1' })
    await saveMetaCredentials(CREDS, 'conn/1', g)
    expect(g.mock.calls[0]![0]).toBe('http://localhost:8091/api/meta-ads/connections/conn%2F1/credentials')
    expect(g.mock.calls[0]![1]).toMatchObject({ method: 'PUT' })
  })

  it('a refused connect keeps its code and sentence; an unknown code is not typed', async () => {
    await expect(saveMetaCredentials(CREDS, null, reply({ code: 'wrong_app', error: 'This token was made for another Meta app.' }, 409)))
      .resolves.toEqual({ ok: false, status: 409, code: 'wrong_app', error: 'This token was made for another Meta app.' })
    await expect(saveMetaCredentials(CREDS, null, reply({ code: 'other', error: 'No.' }, 400))).resolves.toMatchObject({ ok: false, code: null })
  })

  it('checks the token, and lists the choices (refresh=1 asks Meta again)', async () => {
    const t = reply({ token: { isValid: true } })
    await expect(checkMetaToken('conn-1', t)).resolves.toEqual({ isValid: true })
    expect(t.mock.calls[0]).toEqual(['http://localhost:8091/api/meta-ads/connections/conn-1/token-check', expect.objectContaining({ method: 'POST' })])
    const c = reply({ systemUser: null, adAccounts: { items: [], error: null }, pages: { items: [], error: null }, instagram: { items: [], error: null } })
    await fetchMetaChoices('conn-1', true, c)
    expect(c.mock.calls[0]![0]).toBe('http://localhost:8091/api/meta-ads/connections/conn-1/choices?refresh=1')
  })

  it.each(['not_offered', 'account_taken', 'taken_by_other_business'] as const)('the selection reads a 409 %s with its code and product', async (code) => {
    const f = reply({ code, error: 'Refused in words.', product: 'AD_ACCOUNT' }, 409)
    await expect(saveMetaSelection('conn-1', { adAccountId: '1234567890', pageId: null, instagramId: null }, f))
      .resolves.toEqual({ ok: false, status: 409, code, product: 'AD_ACCOUNT', error: 'Refused in words.' })
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({ adAccountId: '1234567890', pageId: null, instagramId: null })
  })
})

describe('step 33 — the "Send sales to Meta" switch', () => {
  it('reads it, and a person PUTs on or off; a refusal keeps the server\'s sentence', async () => {
    const r = reply({ switch: { on: false, since: null, by: null }, canChange: true })
    await expect(fetchMetaEventsSwitch(r)).resolves.toEqual({ switch: { on: false, since: null, by: null }, canChange: true })
    await expect(fetchMetaEventsSwitch(reply({ switch: { on: true, since: null, by: null } }))).resolves.toMatchObject({ canChange: false })
    expect(r.mock.calls[0]![0]).toBe('http://localhost:8091/api/meta-ads/conversions-api')
    const p = reply({ switch: { on: true, since: '2026-10-21T08:00:00.000Z', by: 'Owner' }, changed: true })
    await expect(setMetaEventsSwitch(true, p)).resolves.toEqual({ on: true, since: '2026-10-21T08:00:00.000Z', by: 'Owner' })
    expect(p.mock.calls[0]![1]).toMatchObject({ method: 'PUT', body: '{"on":true}' })
    await expect(setMetaEventsSwitch(true, reply({ error: 'Your role may not change this switch.' }, 403))).rejects.toThrow('Your role may not change this switch.')
  })
})

describe('consent PR 2 — the "Upload customer lists to Meta" switch', () => {
  it('reads it, and a person PUTs on or off; a refusal keeps the server\'s sentence', async () => {
    const r = reply({ switch: { on: false, since: null, by: null }, canChange: true })
    await expect(fetchMetaCustomerListsSwitch(r)).resolves.toEqual({ switch: { on: false, since: null, by: null }, canChange: true })
    await expect(fetchMetaCustomerListsSwitch(reply({ switch: { on: true, since: null, by: null } }))).resolves.toMatchObject({ canChange: false })
    expect(r.mock.calls[0]![0]).toBe('http://localhost:8091/api/meta-ads/customer-lists')
    const p = reply({ switch: { on: true, since: '2026-10-26T08:00:00.000Z', by: 'Owner' }, changed: true })
    await expect(setMetaCustomerListsSwitch(true, p)).resolves.toEqual({ on: true, since: '2026-10-26T08:00:00.000Z', by: 'Owner' })
    expect(p.mock.calls[0]![0]).toBe('http://localhost:8091/api/meta-ads/customer-lists')
    expect(p.mock.calls[0]![1]).toMatchObject({ method: 'PUT', body: '{"on":true}' })
    await expect(setMetaCustomerListsSwitch(true, reply({ error: 'Your role may not change this switch.' }, 403))).rejects.toThrow('Your role may not change this switch.')
  })
})

describe('the read', () => {
  it('asks the overview for the window and the connection', async () => {
    const f = reply({ connections: [] })
    await fetchMetaOverview({ account: 'conn-1', from: '2026-09-21', to: '2026-10-20' }, f)
    expect(f.mock.calls[0]![0]).toBe('http://localhost:8091/api/meta-ads/overview?account=conn-1&from=2026-09-21&to=2026-10-20')
  })

  it('reads every page of campaigns, and says when it stopped early', async () => {
    let n = 0
    const f = vi.fn(async () => new Response(JSON.stringify({ items: [{ campaignId: `c${++n}`, name: `Shop A ${n}` }], nextCursor: n < 25 ? `cur${n}` : null, window: {}, coverage: {}, total: 25 }))) as unknown as typeof fetch
    const all = await fetchAllMetaCampaigns({ from: '2026-09-21', to: '2026-10-20' }, f)
    expect(all.items).toHaveLength(20)
    expect(all.truncated).toBe(true)
  })

  it('one campaign\'s days, and "Read now"', async () => {
    const f = reply({ campaign: {}, days: [] })
    await fetchMetaCampaignDays('c 1', { from: '2026-10-01', to: '2026-10-20' }, f)
    expect(f.mock.calls[0]![0]).toBe('http://localhost:8091/api/meta-ads/campaigns/c%201/days?from=2026-10-01&to=2026-10-20')
    await expect(requestMetaRead('conn-1', reply({ queued: false, reason: ' Once an hour. ' }))).resolves.toEqual({ queued: false, reason: 'Once an hour.' })
  })

  it('a failed read throws the server\'s sentence; a bare status gets a plain one', async () => {
    await expect(fetchMetaOverview({ from: 'a', to: 'b' }, reply({ error: 'from must be a day written YYYY-MM-DD.' }, 400))).rejects.toThrow(MetaAdsHttpError)
    expect(errorText({ error: 'Internal Server Error' }, 500)).toBe('Nexus could not load this (HTTP 500).')
    expect(errorText({}, 403)).toMatch(/Your role/)
  })
})
