import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { COMPANIES, DEVICES, ROLES, USERS, WORKERS } from './shared/fixtures'
import { createCompany, createDevice, createSite, editCompany, editStation, giveRole, invite, issueBadge, listCompanies, listRoles, listUsers, putFloorSettings, resetPin, revokeDevice } from './shared/api'
import { runWithStepUp, StepUpCancelled } from './shared/step-up'

/**
 * The Admin calls against a mocked API (B-W0-27): each goes to the API's own route with its method, the company header,
 * the CSRF token on writes and an Idempotency-Key where the API takes one; each answer is checked against its shape;
 * a change the API holds for a step-up runs again once the code went through, and only then.
 */

interface Call {
  method: string
  url: string
  headers: Headers
  body: unknown
}

function mockApi(answers: Array<{ status: number; body: unknown }>): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined })
    const next = answers.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: 'no answer left' } } }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

const stepUpRefusal = { status: 403, body: { error: { code: 'forbidden', message: 'Step-up required.', issues: [{ path: 'stepUp', message: 'fresh code' }] } } }

describe('the org calls (platform/admin/org)', () => {
  it('lists the tree with archived rows when asked, with the company header', async () => {
    const { api, calls } = mockApi([{ status: 200, body: { companies: COMPANIES } }])
    const companies = await listCompanies(api, true)
    expect(companies.map((company) => company.code)).toEqual(['DEMO', 'ESEMPIO'])
    expect(calls[0]).toMatchObject({ method: 'GET', url: '/api/org/companies?includeArchived=true' })
    expect(calls[0]!.headers.get('x-factory-company')).toBe('DEMO')
    expect(calls[0]!.headers.get('x-csrf-token')).toBeNull()
  })

  it('a create sends its body, the CSRF token and an Idempotency-Key', async () => {
    const { api, calls } = mockApi([{ status: 201, body: { company: COMPANIES[0] } }])
    await createCompany(api, { code: 'NEW', legalName: 'Nuova Demo S.r.l.', vatNumber: null, country: 'IT' })
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/org/companies', body: { code: 'NEW', legalName: 'Nuova Demo S.r.l.', vatNumber: null, country: 'IT' } })
    expect(calls[0]!.headers.get('x-csrf-token')).toBe('csrf-demo')
    expect(calls[0]!.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('an edit is a PATCH with the version read; a stale version is a conflict the page reads again', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: { company: COMPANIES[0] } },
      { status: 409, body: { error: { code: 'conflict', message: 'Stale.' } } },
    ])
    await editCompany(api, COMPANIES[0]!.id, { version: 7, tradeName: null })
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `/api/org/companies/${COMPANIES[0]!.id}`, body: { version: 7, tradeName: null } })
    const error = await editStation(api, 'station-id', { version: 1, lineId: null }).catch((caught: unknown) => caught)
    expect(isApiError(error) && error.kind).toBe('conflict')
  })

  it('an answer of the wrong shape is a contract error, never half-read', async () => {
    const { api } = mockApi([{ status: 201, body: { site: { id: 'x' } } }])
    const error = await createSite(api, { companyId: COMPANIES[0]!.id, code: 'S1', name: 'S', kind: 'PLANT' }).catch((caught: unknown) => caught)
    expect(isApiError(error) && error.kind).toBe('contract')
  })
})

describe('people, roles and the floor (platform/auth)', () => {
  it('reads users and roles as the API answers them', async () => {
    const { api } = mockApi([
      { status: 200, body: { users: USERS } },
      { status: 200, body: { roles: ROLES } },
    ])
    expect((await listUsers(api)).length).toBe(USERS.length)
    expect((await listRoles(api)).find((role) => role.key === 'owner')?.grains).toEqual(['price', 'cost', 'margin', 'wages'])
  })

  it('an invitation carries its Idempotency-Key (a retry never mails twice) and the roles with their scope', async () => {
    const { api, calls } = mockApi([{ status: 200, body: { invitation: { id: 'i1', userId: 'u1', email: 'nuovo@example.com', expiresAt: '2026-11-05T09:00:00.000Z', roleIds: [ROLES[2]!.id] }, delivery: 'sent' } }])
    const answer = await invite(api, { email: 'nuovo@example.com', displayName: 'Nuovo Demo', locale: 'it', roles: [{ roleId: ROLES[2]!.id, allCompanies: false, companyIds: [COMPANIES[0]!.id], siteIds: [] }] }, 'key-1')
    expect(answer.delivery).toBe('sent')
    expect(calls[0]!.headers.get('idempotency-key')).toBe('key-1')
    expect(calls[0]!.body).toMatchObject({ email: 'nuovo@example.com', roles: [{ allCompanies: false, companyIds: [COMPANIES[0]!.id] }] })
  })

  it('a badge and a PIN reset answer their secret once; a repeat answers null', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: { badge: { id: 'b1', hint: '4821', issuedAt: '2026-10-29T09:00:00.000Z' }, code: 'DEMOCODE', printed: 'DEMO-CODE' } },
      { status: 200, body: { pin: null, pinMustChange: true } },
    ])
    expect((await issueBadge(api, WORKERS[0]!.id, 'k-badge')).code).toBe('DEMOCODE')
    expect((await resetPin(api, WORKERS[0]!.id, 'k-pin')).pin).toBeNull()
    expect(calls.map((call) => [call.method, call.url, call.headers.get('idempotency-key')])).toEqual([
      ['POST', `/api/auth/floor/workers/${WORKERS[0]!.id}/badges`, 'k-badge'],
      ['POST', `/api/auth/floor/workers/${WORKERS[0]!.id}/pin-reset`, 'k-pin'],
    ])
  })

  it('a device: create with its key (the enrolment code once), revoke with the version read, floor times by PUT', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: { device: DEVICES[3], enrolment: { code: 'c', url: 'https://factory.example.com/floor/enrol#code=x', qrSvg: '<svg/>', expiresAt: '2026-10-29T10:00:00.000Z' } } },
      { status: 200, body: { ...DEVICES[0], status: 'REVOKED' } },
      { status: 200, body: { siteId: 's', idleMinutes: 15, shiftEnds: ['14:00'], badgeOnlySignIn: true, timeZone: 'Europe/Rome', version: 3 } },
    ])
    expect((await createDevice(api, { siteId: DEVICES[3]!.siteId, name: 'Lettore', kind: 'HANDHELD' }, 'k-dev')).enrolment?.url).toContain('example.com')
    expect((await revokeDevice(api, DEVICES[0]!.id, { version: 2 })).status).toBe('REVOKED')
    const settings = await putFloorSettings(api, 's', { idleMinutes: 15, shiftEnds: ['14:00'], badgeOnlySignIn: true, version: 2 })
    expect([settings.version, settings.badgeOnlySignIn]).toEqual([3, true])
    expect(calls.map((call) => call.method)).toEqual(['POST', 'POST', 'PUT'])
    expect(calls[1]!.body).toEqual({ version: 2 })
    // F1: the switch travels in the floor settings' PUT, with the version read.
    expect(calls[2]).toMatchObject({ url: '/api/auth/floor/sites/s/settings', body: { idleMinutes: 15, shiftEnds: ['14:00'], badgeOnlySignIn: true, version: 2 } })
  })
})

describe('step-up: a change that raises rights asks for a fresh code, then runs once more', () => {
  it('403 stepUp → the code dialog → the same change again, and it succeeds', async () => {
    const { api, calls } = mockApi([stepUpRefusal, { status: 200, body: { id: 'a1', userId: 'u', roleId: ROLES[3]!.id, roleKey: 'planner', roleName: 'Planner', allCompanies: true, companyIds: [], siteIds: [], partyIds: [], validFrom: '2026-10-29T09:00:00.000Z', validTo: null, endedAt: null, live: true, version: 1 } }])
    let asked = 0
    const assignment = await runWithStepUp(
      () => giveRole(api, 'u', { roleId: ROLES[3]!.id, allCompanies: true, companyIds: [], siteIds: [] }),
      async () => {
        asked += 1
      },
    )
    expect(asked).toBe(1)
    expect(assignment.live).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('another refusal goes up as it is; closing the dialog makes no change', async () => {
    const { api } = mockApi([{ status: 403, body: { error: { code: 'forbidden', message: 'No.' } } }, stepUpRefusal])
    const asked: string[] = []
    const forbidden = await runWithStepUp(() => listUsers(api), async () => void asked.push('code')).catch((caught: unknown) => caught)
    expect(isApiError(forbidden) && forbidden.kind).toBe('forbidden')
    const cancelled = await runWithStepUp(
      () => listUsers(api),
      () => Promise.reject(new StepUpCancelled()),
    ).catch((caught: unknown) => caught)
    expect(cancelled).toBeInstanceOf(StepUpCancelled)
    expect(asked).toEqual([])
  })
})
