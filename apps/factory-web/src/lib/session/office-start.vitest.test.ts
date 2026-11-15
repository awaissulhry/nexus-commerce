import { beforeEach, describe, expect, it, vi } from 'vitest'
import { officeStartOf, rootDestination } from './office-start'
import { rememberScope } from './scope-memory'
import type { OfficeSession } from './session'
import type { SessionLoad } from './server'

/** B-W2b-F58: the bare address `/` (src/app/page.tsx) and where it sends a person (made-up people and companies). */

const session = (over: Partial<OfficeSession> = {}): OfficeSession => ({
  user: { id: 'u1', email: 'alex.demo@example.com', displayName: 'Alex Demo', locale: 'en' },
  tenant: { id: 't1', slug: 'demo', name: 'Officina Demo' },
  company: { id: 'c1', code: 'SCA', name: 'Seed Company A' },
  companies: [
    { id: 'c1', code: 'SCA', name: 'Seed Company A' },
    { id: 'c2', code: 'SCB', name: 'Seed Company B' },
  ],
  sites: [],
  permissions: ['home.view'],
  mfa: { enabled: true, required: false, satisfied: true },
  ...over,
})

describe('where `/` sends a person (lib/session/office-start.ts)', () => {
  it('signed in: their company’s office entry, the company they last worked in on this device first', () => {
    expect(officeStartOf(session(), null)).toBe('/w/SCA')
    const remembered = rememberScope(null, { tenantId: 't1', userId: 'u1' }, { company: 'SCB', site: null })
    expect(officeStartOf(session(), remembered)).toBe('/w/SCB')
    // A remembered company the person may no longer open is ignored; a tenant of several companies starts in none.
    expect(officeStartOf(session({ companies: [{ id: 'c1', code: 'SCA', name: 'Seed Company A' }] }), remembered)).toBe('/w/SCA')
    expect(officeStartOf(session({ company: null }), null)).toBe('/w/SCA')
    // Two-factor not proved yet: the session's own company (the entry then opens My profile, where the card waits).
    expect(officeStartOf(session({ companies: [], permissions: [], mfa: { enabled: false, required: true, satisfied: false } }), null)).toBe('/w/SCA')
    expect(officeStartOf(session({ company: null, companies: [] }), null)).toBeNull()
  })

  it('signed out (or no company to open): the sign-in; the API away: no redirect (the page says it)', () => {
    const signedIn: SessionLoad = { kind: 'signed_in', session: session() }
    expect(rootDestination(signedIn, null, '/sign-in')).toBe('/w/SCA')
    expect(rootDestination({ kind: 'signed_out' }, null, '/sign-in')).toBe('/sign-in')
    expect(rootDestination({ kind: 'forbidden' }, null, '/sign-in')).toBe('/sign-in')
    expect(rootDestination({ kind: 'signed_in', session: session({ company: null, companies: [] }) }, null, '/sign-in')).toBe('/sign-in')
    expect(rootDestination({ kind: 'unavailable', code: 'network', requestId: null }, null, '/sign-in')).toBeNull()
  })
})

// The page itself, with the session loader, the cookies and Next's redirect stood in.
const state = vi.hoisted(() => ({ load: { kind: 'signed_out' } as SessionLoad }))
vi.mock('./server', () => ({ SIGN_IN_PATH: '/sign-in', loadOfficeSession: async () => state.load }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`)
  },
  useRouter: () => ({ refresh() {}, push() {} }),
}))

describe('the page `/` (src/app/page.tsx): no scaffold placeholder any more', () => {
  beforeEach(() => {
    state.load = { kind: 'signed_out' }
  })

  it('redirects a signed-out person to the sign-in and a signed-in one to their company', async () => {
    const { default: RootPage } = await import('../../app/page')
    await expect(RootPage()).rejects.toThrow('REDIRECT /sign-in')
    state.load = { kind: 'signed_in', session: session() }
    await expect(RootPage()).rejects.toThrow('REDIRECT /w/SCA')
  })

  it('says the API is away instead of redirecting', async () => {
    const { default: RootPage } = await import('../../app/page')
    state.load = { kind: 'unavailable', code: 'network', requestId: null }
    const element = (await RootPage()) as { props: { code: string } }
    expect(element.props.code).toBe('network')
  })
})
