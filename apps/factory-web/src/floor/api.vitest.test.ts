import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../lib/api/client'
import { ApiError } from '../lib/api/errors'
import { acknowledgeNotice, enrolDevice, fetchDevice, fetchMe, lookupHide, lookupLocation, lookupWorkOrder, problemOf, signIn } from './api'
import { floorIconSvg, floorManifest } from './install'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const error = (status: number, issues: unknown[] = []) => json(status, { error: { code: `http_${status}`, message: 'API words', requestId: 'r1', issues } })

type Route = (url: string, init: RequestInit) => Response
function api(route: Route) {
  const calls: { url: string; method: string; body: unknown; headers: Headers }[] = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init.headers) })
    return route(url, init)
  })
  return { client: createApiClient({ baseUrl: '/api', fetch: fetch as unknown as typeof globalThis.fetch, csrfToken: () => 'csrf-1' }), calls }
}

const station = { id: '0190f0e2-0000-7000-8000-00000000000a', code: 'CUT-01', name: 'Cutting table 1', workCentreKind: 'CUTTING' }
const device = {
  device: { id: '0190f0e2-0000-7000-8000-00000000000b', name: 'Tablet', kind: 'TABLET', station },
  site: { id: '0190f0e2-0000-7000-8000-00000000000c', code: 'A1', name: 'Plant' },
  defaultLocale: 'it',
  signIn: { badgeOnly: true },
  operatorSignedIn: false,
  roster: [],
}
const gate = { noticeId: null, label: null, acknowledged: false, due: false, blocksScans: false }
const session = { startedAt: '2026-10-29T08:00:00.000Z', idleExpiresAt: '2026-10-29T08:10:00.000Z', endsAt: '2026-10-29T13:00:00.000Z', idleMinutes: 10, stepUpUntil: null }
const me = {
  worker: { id: '0190f0e2-0000-7000-8000-00000000000d', displayName: 'Ada Demo', locale: 'it' },
  device: { id: device.device.id, name: 'Tablet', station },
  site: device.site,
  scanTag: '7K',
  session,
  pinMustChange: false,
  notice: gate,
  permissions: ['floor.work'],
}

describe('the floor app\'s calls', () => {
  it('reads "not enrolled" and "nobody signed in" from a 401, never as an outage', async () => {
    expect(await fetchDevice(api(() => error(401)).client)).toEqual({ ok: true, value: null })
    expect(await fetchMe(api(() => error(401)).client)).toEqual({ ok: true, value: null })
    expect((await fetchDevice(api(() => error(503)).client)).ok).toBe(false)
    expect(await fetchDevice(api(() => json(200, device)).client)).toEqual({ ok: true, value: device })
  })

  it('signs in with a badge alone (no PIN in the body), or switches person on /floor/switch', async () => {
    const { client, calls } = api((url) => (url.endsWith('/auth/csrf') ? json(200, {}) : url.endsWith('/floor/me') ? json(200, me) : json(200, { status: 'signed_in', worker: me.worker, session, pinMustChange: false, notice: gate })))
    expect(await signIn(client, { badgeCode: 'B' })).toEqual({ ok: true, value: me })
    const post = calls.find((call) => call.method === 'POST')!
    expect(post.url).toBe('/api/floor/sign-in')
    expect(post.body).toEqual({ badgeCode: 'B' })
    expect(post.headers.get('x-csrf-token')).toBe('csrf-1')
    await signIn(client, { badgeCode: 'C', pin: '482913' }, 'switch')
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual(['/api/floor/sign-in', '/api/floor/switch'])
  })

  it('turns each refusal into the screen\'s words, never the API\'s', async () => {
    expect(await signIn(api((url) => (url.endsWith('/auth/csrf') ? json(200, {}) : error(401))).client, { badgeCode: 'B', pin: '1' })).toMatchObject({ ok: false, problem: 'wrong' })
    expect(await signIn(api((url) => (url.endsWith('/auth/csrf') ? json(200, {}) : error(400, [{ path: 'pin', message: 'Required.' }]))).client, { badgeCode: 'B' })).toMatchObject({ ok: false, problem: 'pinNeeded' })
    expect(await signIn(api((url) => (url.endsWith('/auth/csrf') ? json(200, {}) : error(409))).client, { badgeCode: 'B', pin: '1' })).toMatchObject({ ok: false, problem: 'operatorActive' })
    expect(await enrolDevice(api((url) => (url.endsWith('/auth/csrf') ? json(200, {}) : error(401))).client, 'code', 'v')).toMatchObject({ ok: false, problem: 'codeInvalid' })
    expect(await acknowledgeNotice(api((url) => (url.endsWith('/auth/csrf') ? json(200, {}) : error(409))).client, { id: 'n', locale: 'it', sha256: 's' })).toMatchObject({ ok: false, problem: 'newerNotice' })
    expect(problemOf(new ApiError('rate_limited', 429, 'x', 'm'))).toMatchObject({ problem: 'rateLimited' })
    expect(problemOf(new ApiError('forbidden', 403, 'x', 'm'))).toMatchObject({ problem: 'locked' })
    expect(problemOf(new Error('boom'))).toMatchObject({ problem: 'unavailable' })
  })

  it('acknowledges with the notice\'s id, language and fingerprint, and an idempotency key', async () => {
    const { client, calls } = api((url) => (url.endsWith('/auth/csrf') ? json(200, {}) : json(200, { acknowledged: true, changed: true, gate: { ...gate, acknowledged: true } })))
    expect(await acknowledgeNotice(client, { id: 'n1', locale: 'en', sha256: 'abc' })).toMatchObject({ ok: true, value: { acknowledged: true } })
    const post = calls.find((call) => call.method === 'POST')!
    expect(post.body).toMatchObject({ noticeId: 'n1', locale: 'en', sha256: 'abc' })
    expect(post.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('scan anything\'s lookups', () => {
  it('maps a hide, keeps only the work orders it can be cut for; 404 is "not this"', async () => {
    const hide = {
      hide: { code: 'H1', itemName: 'Leather', colourCode: 'BLK', area: '52.4', areaUom: 'ft²', grade: 'A', shade: null, thicknessMm: '1.2', state: 'FULL', lot: { code: 'L1', qualityStatus: 'RELEASED', crViStatus: 'PASS', usable: true, words: null } },
      onHand: [{ locationCode: 'A1-STORE-01', onHand: '52.4' }],
      workOrders: [
        { number: 'WO-1', cuttable: true },
        { number: 'WO-2', cuttable: false },
      ],
    }
    const card = await lookupHide(api(() => json(200, hide)).client, 'H1')
    expect(card).toMatchObject({ kind: 'hide', code: 'H1', item: 'Leather', onHand: [{ location: 'A1-STORE-01', quantity: '52.4' }], workOrders: ['WO-1'] })
    expect(await lookupHide(api(() => error(404)).client, 'H9')).toBeNull()
    await expect(lookupHide(api(() => error(503)).client, 'H9')).rejects.toBeInstanceOf(ApiError)
  })

  it('finds a work order by its number and a location by its code (any case)', async () => {
    const order = { number: 'WO-1', batchNumber: null, status: 'RELEASED', dueDate: null, style: { code: 'S1', name: 'Jacket' }, colourways: ['BLK'], pieces: 10, toCut: 4, sizesLeft: ['BLK 50'] }
    const found = api(() => json(200, { workOrders: [order] }))
    expect(await lookupWorkOrder(found.client, 'WO-1')).toMatchObject({ kind: 'workOrder', number: 'WO-1', style: 'S1 · Jacket', toCut: 4 })
    expect(found.calls[0]!.url).toBe('/api/production/cutting/work-orders?number=WO-1&limit=1')
    expect(await lookupWorkOrder(api(() => json(200, { workOrders: [] })).client, 'WO-9')).toBeNull()
    const sites = { sites: [{ id: 's', locations: [{ code: 'A1-STORE-01', name: 'Leather store', kind: 'BIN', status: 'ACTIVE', path: ['A1-STORE', 'A1-STORE-01'] }] }] }
    expect(await lookupLocation(api(() => json(200, sites)).client, 's', 'a1-store-01')).toEqual({ kind: 'location', code: 'A1-STORE-01', name: 'Leather store', locationKind: 'BIN', path: ['A1-STORE', 'A1-STORE-01'] })
    expect(await lookupLocation(api(() => json(200, sites)).client, 's', 'B9')).toBeNull()
  })
})

describe('the installable app (PLT-236)', () => {
  it('starts and stays under /floor, full screen, with an icon in the brand colours', () => {
    const manifest = floorManifest()
    expect(manifest).toMatchObject({ id: '/floor', start_url: '/floor', scope: '/floor', display: 'fullscreen', orientation: 'landscape' })
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(manifest.icons.map((icon) => icon.purpose)).toEqual(['any', 'maskable'])
    expect(floorIconSvg()).toMatch(/^<svg[^>]*viewBox="0 0 512 512"/)
  })
})
