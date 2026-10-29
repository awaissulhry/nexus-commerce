import { describe, expect, it } from 'vitest'
import { createApiClient } from '../../../lib/api/client'
import { rememberScope } from '../../../lib/session/scope-memory'
import { acceptInvitation, chooseRequiredPassword, confirmReset, previewInvitation, requestReset, sessionPlaces, signIn } from './auth-api'

/**
 * SCR-001's flows against a scripted API: each route answers what the factory API answers (apps/factory-api
 * platform/auth), and the test reads every request the page made — the CSRF cookie asked first, the header on each
 * write, a token only ever in a body.
 */

type Reply = { status: number; body?: unknown }
type Script = Record<string, Reply | Reply[]>

const TENANT = '0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10'
const USER = '0190f0e2-3333-7000-8000-000000000001'
const TOKEN = `${TENANT}.${USER}.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde`
const ME = (mfa: { enabled: boolean; required: boolean; satisfied: boolean }) => ({
  user: { id: USER, email: 'alex.demo@example.com', displayName: 'Alex Demo', locale: 'it' },
  tenant: { id: TENANT, slug: 'demo', name: 'Officina Demo' },
  company: { id: '0190f0e2-1111-7000-8000-000000000001', code: 'DEMO', name: 'Officina Demo S.r.l.' },
  session: { id: '0190f0e2-5555-7000-8000-000000000001', createdAt: '2026-10-28T08:00:00.000Z', idleExpiresAt: '2026-10-28T16:00:00.000Z', absoluteExpiresAt: '2026-11-04T08:00:00.000Z', stepUpUntil: null },
  mfa: { ...mfa, recoveryCodesLeft: mfa.enabled ? 10 : 0 },
  permissions: [],
})
const refused = (status: number, code: string, issues?: { path: string; message: string }[]) => ({ status, body: { error: { code, message: 'English for the logs', requestId: 'r1', ...(issues ? { issues } : {}) } } })

/** A client on a scripted fetch; `calls` holds what the page sent. */
function scripted(script: Script) {
  const calls: { method: string; url: string; csrf: string | null; body: unknown }[] = []
  const used = new Map<string, number>()
  const fetch = async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    calls.push({ method, url, csrf: headers.get('x-csrf-token'), body: init.body ? JSON.parse(String(init.body)) : undefined })
    const key = `${method} ${url.replace(/^\/api/, '')}`
    const entry = script[key]
    if (!entry) return new Response(JSON.stringify({ error: { code: 'route_not_found', message: key } }), { status: 404 })
    const index = used.get(key) ?? 0
    used.set(key, index + 1)
    const reply = Array.isArray(entry) ? entry[Math.min(index, entry.length - 1)]! : entry
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), { status: reply.status })
  }
  const api = createApiClient({ baseUrl: '/api', fetch: fetch as unknown as typeof globalThis.fetch, csrfToken: () => 'csrf-1' })
  return { api, calls }
}

const CSRF: Script = { 'GET /auth/csrf': { status: 200, body: { csrfToken: 'csrf-1' } } }

describe('sign-in (PLT-047, PLT-048)', () => {
  it('opens the company\'s office entry, after asking for the CSRF cookie and sending its header', async () => {
    const { api, calls } = scripted({
      ...CSRF,
      'POST /auth/office/sign-in': { status: 200, body: { status: 'signed_in', csrfToken: 'csrf-1' } },
      'GET /auth/office/me': { status: 200, body: ME({ enabled: false, required: false, satisfied: true }) },
    })
    const outcome = await signIn(api, { company: ' Demo ', email: ' alex.demo@example.com ', password: 'calm-meadow-river-91' })
    expect(outcome).toMatchObject({ kind: 'open', to: '/w/DEMO', tenantSlug: 'demo', mfaRequired: false })
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/auth/csrf', 'POST /api/auth/office/sign-in', 'GET /api/auth/office/me'])
    expect(calls[1]).toMatchObject({ csrf: 'csrf-1', body: { tenant: 'Demo', email: 'alex.demo@example.com', password: 'calm-meadow-river-91' } })
    expect(calls[1]!.body).not.toHaveProperty('code')
  })

  it('asks for the code, then sends it with the same password; a wrong code names no part', async () => {
    const { api, calls } = scripted({
      ...CSRF,
      'POST /auth/office/sign-in': [{ status: 200, body: { status: 'totp_required' } }, refused(401, 'unauthenticated'), { status: 200, body: { status: 'signed_in', csrfToken: 'c' } }],
      'GET /auth/office/me': { status: 200, body: ME({ enabled: true, required: true, satisfied: true }) },
    })
    const input = { company: 'demo', email: 'alex.demo@example.com', password: 'calm-meadow-river-91' }
    expect(await signIn(api, input)).toEqual({ kind: 'code' })
    expect(await signIn(api, { ...input, code: '123456' })).toEqual({ kind: 'problem', problem: 'wrongCode' })
    expect(await signIn(api, { ...input, code: 'ABCDE23456' })).toMatchObject({ kind: 'open', to: '/w/DEMO' })
    expect(calls.filter((call) => call.url.endsWith('/sign-in')).map((call) => (call.body as { code?: string }).code)).toEqual([undefined, '123456', 'ABCDE23456'])
  })

  it('answers wrong credentials, a lock, a suspension, too many tries and an API away in its own words', async () => {
    const input = { company: 'demo', email: 'alex.demo@example.com', password: 'wrong' }
    const answer = async (reply: Reply) => signIn(scripted({ ...CSRF, 'POST /auth/office/sign-in': reply }).api, input)
    expect(await answer(refused(401, 'unauthenticated'))).toEqual({ kind: 'problem', problem: 'wrongCredentials' })
    expect(await answer(refused(403, 'forbidden'))).toEqual({ kind: 'problem', problem: 'suspended' })
    expect(await answer(refused(429, 'rate_limited'))).toEqual({ kind: 'problem', problem: 'rateLimited' })
    expect(await answer({ status: 502 })).toEqual({ kind: 'problem', problem: 'unavailable' })
    expect(await answer({ status: 200, body: { status: 'something new' } })).toEqual({ kind: 'problem', problem: 'unavailable' })
  })

  it('a person whose role needs two-factor they have not set up opens on the authenticator set-up', async () => {
    const { api } = scripted({
      ...CSRF,
      'POST /auth/office/sign-in': { status: 200, body: { status: 'signed_in' } },
      'GET /auth/office/me': { status: 200, body: ME({ enabled: false, required: true, satisfied: false }) },
    })
    expect(await signIn(api, { company: 'demo', email: 'alex.demo@example.com', password: 'p' })).toMatchObject({ to: '/w/DEMO/me#authenticator', entry: '/w/DEMO' })
  })

  it('opens the company this person last worked in on this device, else the session\'s, else the first their roles reach', () => {
    const me = ME({ enabled: false, required: false, satisfied: true })
    const two = { ...me, company: null, companies: [{ code: 'DEMO' }, { code: 'ESEMPIO' }] }
    const remembered = rememberScope(undefined, { tenantId: TENANT, userId: USER }, { company: 'ESEMPIO', site: null })
    expect(sessionPlaces(me, undefined)).toMatchObject({ to: '/w/DEMO' })
    expect(sessionPlaces(two, remembered)).toMatchObject({ to: '/w/ESEMPIO' })
    expect(sessionPlaces(two, undefined)).toMatchObject({ to: '/w/DEMO' })
    // A remembered company the roles no longer reach is not opened.
    expect(sessionPlaces({ ...two, companies: [{ code: 'DEMO' }] }, remembered)).toMatchObject({ to: '/w/DEMO' })
    expect(sessionPlaces({ ...me, company: null, companies: [] }, undefined)).toEqual({ kind: 'problem', problem: 'noCompany' })
  })
})

describe('a new password an administrator required (PLT-070)', () => {
  it('sets it with the sign-in\'s token, then signs in with it at once', async () => {
    const { api, calls } = scripted({
      ...CSRF,
      'POST /auth/office/sign-in': [{ status: 200, body: { status: 'password_change_required', resetToken: TOKEN, expiresAt: '2026-10-28T09:15:00.000Z' } }, { status: 200, body: { status: 'totp_required' } }],
      'POST /auth/office/password/reset': { status: 200, body: { status: 'password_set' } },
    })
    const first = await signIn(api, { company: 'demo', email: 'alex.demo@example.com', password: 'old-password-1' })
    expect(first).toEqual({ kind: 'change', resetToken: TOKEN })
    const next = await chooseRequiredPassword(api, { resetToken: TOKEN, company: 'demo', email: 'alex.demo@example.com', password: 'calm-meadow-river-91' })
    expect(next).toEqual({ kind: 'code' })
    expect(calls.find((call) => call.url.endsWith('/password/reset'))).toMatchObject({ csrf: 'csrf-1', body: { token: TOKEN, password: 'calm-meadow-river-91' } })
    expect(calls.filter((call) => call.url.endsWith('/sign-in')).at(-1)!.body).toMatchObject({ password: 'calm-meadow-river-91' })
  })

  it('sends the person back to sign-in when its time ran out', async () => {
    const { api } = scripted({ ...CSRF, 'POST /auth/office/password/reset': refused(404, 'not_found') })
    expect(await chooseRequiredPassword(api, { resetToken: TOKEN, company: 'demo', email: 'a@example.com', password: 'calm-meadow-river-91' })).toEqual({ kind: 'problem', problem: 'changeExpired' })
  })
})

describe('a forgotten password (PLT-070)', () => {
  it('asks for a link and answers "sent" whatever the address', async () => {
    const { api, calls } = scripted({ ...CSRF, 'POST /auth/office/password/reset-request': { status: 200, body: { status: 'requested' } } })
    expect(await requestReset(api, { company: ' demo ', email: 'nobody@example.com ' })).toEqual({ kind: 'sent' })
    expect(calls.at(-1)!.body).toEqual({ tenant: 'demo', email: 'nobody@example.com' })
    expect(await requestReset(scripted({ ...CSRF, 'POST /auth/office/password/reset-request': refused(429, 'rate_limited') }).api, { company: 'd', email: 'a@example.com' })).toEqual({
      kind: 'problem',
      problem: 'rateLimited',
    })
  })

  it('sets the new password from the mailed link; a used or expired link says so; a well-known password is refused', async () => {
    const reset = (reply: Reply) => confirmReset(scripted({ ...CSRF, 'POST /auth/office/password/reset': reply }).api, { token: TOKEN, password: 'calm-meadow-river-91' })
    expect(await reset({ status: 200, body: { status: 'password_set' } })).toEqual({ kind: 'done' })
    expect(await reset(refused(404, 'not_found'))).toEqual({ kind: 'link-invalid' })
    expect(await reset(refused(400, 'validation_failed', [{ path: 'password', message: 'This password is too common; choose another.' }]))).toEqual({ kind: 'problem', problem: 'passwordRefused' })
  })
})

describe('an invitation (PLT-015)', () => {
  it('shows what the link opens, or one answer for used, expired, withdrawn or unknown', async () => {
    const preview = { tenant: { name: 'Officina Demo' }, email: 'new.person@example.com', displayName: 'New Person', expiresAt: '2026-11-04T09:00:00.000Z' }
    const { api, calls } = scripted({ 'POST /auth/invitations/preview': { status: 200, body: preview } })
    expect(await previewInvitation(api, TOKEN)).toEqual({ kind: 'invitation', invitation: preview })
    expect(calls[0]).toMatchObject({ url: '/api/auth/invitations/preview', body: { token: TOKEN } })
    expect(await previewInvitation(scripted({ 'POST /auth/invitations/preview': refused(404, 'not_found') }).api, TOKEN)).toEqual({ kind: 'link-invalid' })
  })

  it('accepting sets the password, opens a session and offers the authenticator', async () => {
    const { api, calls } = scripted({
      ...CSRF,
      'POST /auth/invitations/accept': { status: 200, body: { status: 'signed_in' } },
      'GET /auth/office/me': { status: 200, body: ME({ enabled: false, required: false, satisfied: true }) },
    })
    const outcome = await acceptInvitation(api, { token: TOKEN, displayName: ' New Person ', password: 'calm-meadow-river-91' })
    expect(outcome).toMatchObject({ kind: 'open', entry: '/w/DEMO', authenticator: '/w/DEMO/me#authenticator', mfaRequired: false })
    expect(calls.find((call) => call.url.endsWith('/accept'))).toMatchObject({ csrf: 'csrf-1', body: { token: TOKEN, displayName: 'New Person', password: 'calm-meadow-river-91' } })
  })

  it('never puts a token in an address', async () => {
    const { api, calls } = scripted({ ...CSRF, 'POST /auth/invitations/preview': refused(404, 'not_found'), 'POST /auth/invitations/accept': refused(404, 'not_found'), 'POST /auth/office/password/reset': refused(404, 'not_found') })
    await previewInvitation(api, TOKEN)
    await acceptInvitation(api, { token: TOKEN, displayName: 'x', password: 'calm-meadow-river-91' })
    await confirmReset(api, { token: TOKEN, password: 'calm-meadow-river-91' })
    for (const call of calls) expect(call.url).not.toContain(TOKEN.split('.')[2]!)
  })
})
