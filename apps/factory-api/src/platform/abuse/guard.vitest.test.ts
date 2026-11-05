import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { solveChallenge } from '@nexus/factory-domain/abuse/pow'
import type { RouteManifestEntry } from '../../core/manifest'
import { FLOOR_COOKIE } from '../auth/floor/cookies'
import { SESSION_COOKIE } from '../auth/sessions/cookies'
import { PORTAL_COOKIE } from '../auth/portal/cookies'
import { portalRequest, withPortalSessions } from '../auth/portal/authenticator'
import { createAbuseGuard, networkOf } from './guard'
import { failoverStore, memoryAbuseStore, type AbuseStore } from './store'

// The abuse guard of the public routes (B-W2b-159; PLT-066) and the portal's place in the authenticator chain, without
// a database: counts per subject and network, the wait in words, a challenge only after suspicious traffic, each solved
// challenge once; Redis down → this process's memory.

let now = Date.parse('2026-11-05T09:00:00Z')
const clock = { now: () => new Date(now) }
const silent = { info() {}, warn() {}, error() {}, debug() {} }

function request(ip: string, extra: Partial<FastifyRequest> = {}): FastifyRequest {
  return { ip, log: silent, ...extra } as unknown as FastifyRequest
}

function reply(): FastifyReply & { headers: Record<string, string> } {
  const headers: Record<string, string> = {}
  return { headers, header: (name: string, value: string) => ((headers[name] = value), undefined) } as unknown as FastifyReply & { headers: Record<string, string> }
}

const guardOf = (store: AbuseStore = memoryAbuseStore(() => now)) => createAbuseGuard({ store, key: Buffer.alloc(32, 7), prefix: 'unit', clock })

async function issueOf(work: Promise<void>): Promise<{ path: string; message: string } | null> {
  try {
    await work
    return null
  } catch (error) {
    return ((error as { issues?: { path: string; message: string }[] }).issues ?? [])[0] ?? null
  }
}

describe('networks', () => {
  it('counts IPv4 whole and IPv6 by its /64', () => {
    expect(networkOf('203.0.113.7')).toBe('203.0.113.7')
    expect(networkOf('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(networkOf('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64')
    expect(networkOf('2001:db8:1:2::9')).toBe(networkOf('2001:0db8:0001:0002:ffff::1'))
    expect(networkOf('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(networkOf(undefined)).toBe('unknown')
  })
})

describe('the guard', () => {
  it('holds the fourth sign-in e-mail for one address in 10 minutes, with the wait in words and Retry-After', async () => {
    const guard = guardOf()
    for (let index = 0; index < 3; index++) await guard.check(request('203.0.113.1'), reply(), 'portal.signin.start', { subject: 't|anna@example.com' })
    now += 6 * 60_000
    const answer = reply()
    await expect(guard.check(request('203.0.113.2'), answer, 'portal.signin.start', { subject: 'T|Anna@example.com ' })).rejects.toMatchObject({
      code: 'rate_limited',
      message: 'Wait 4 minutes before asking again.',
      issues: [{ path: 'retryAfter', message: '240' }],
    })
    expect(answer.headers['retry-after']).toBe('240')
    now += 4 * 60_000 + 1
    await expect(guard.check(request('203.0.113.3'), reply(), 'portal.signin.start', { subject: 't|anna@example.com' })).resolves.toBeUndefined()
  })

  it('asks a busy network for a challenge, takes a solved one once, and refuses one of another network', async () => {
    const guard = guardOf()
    const busy = request('198.51.100.9')
    for (let index = 0; index < 6; index++) await guard.check(busy, reply(), 'portal.signin.start', { subject: `t|p${index}@example.com` })
    expect(await issueOf(guard.check(busy, reply(), 'portal.signin.start', { subject: 't|p6@example.com' }))).toEqual({ path: 'challenge', message: 'Required.' })
    const issued = await guard.challenge(busy, 'portal.signin.start')
    expect(issued).toMatchObject({ policy: 'portal.signin.start', bits: 15, algorithm: 'sha256-leading-zero-bits' })
    const proof = { challenge: issued.challenge, nonce: solveChallenge(issued.challenge, issued.bits)! }
    expect(await issueOf(guard.check(request('192.0.2.50'), reply(), 'portal.signin.start', { subject: 't|x@example.com', proof }))).toBeNull() // that network is not busy
    for (let index = 0; index < 5; index++) await guard.check(request('192.0.2.50'), reply(), 'portal.signin.start', { subject: `t|y${index}@example.com` })
    expect(await issueOf(guard.check(request('192.0.2.50'), reply(), 'portal.signin.start', { subject: 't|z@example.com', proof }))).toEqual({ path: 'challenge', message: 'Required.' })
    expect(await issueOf(guard.check(busy, reply(), 'portal.signin.start', { subject: 't|p7@example.com', proof }))).toBeNull()
    expect(await issueOf(guard.check(busy, reply(), 'portal.signin.start', { subject: 't|p8@example.com', proof }))).toEqual({ path: 'challenge', message: 'Required.' })
  })

  it('raises suspicion on wrong answers alone', async () => {
    const guard = guardOf()
    const guesser = request('198.51.100.77')
    for (let index = 0; index < 6; index++) await guard.failed(guesser, 'portal.signin.code')
    expect(await issueOf(guard.check(guesser, reply(), 'portal.signin.code', { subject: 't|a@example.com' }))).toEqual({ path: 'challenge', message: 'Required.' })
    expect(await issueOf(guard.check(request('198.51.100.78'), reply(), 'portal.signin.code', { subject: 't|a@example.com' }))).toBeNull()
  })

  it('keeps counting in memory while Redis does not answer', async () => {
    const down: AbuseStore = {
      hit: () => Promise.reject(new Error('down')),
      peek: () => Promise.reject(new Error('down')),
      claimOnce: () => Promise.reject(new Error('down')),
      forget: () => Promise.reject(new Error('down')),
    }
    const guard = guardOf(failoverStore(down, memoryAbuseStore(() => now), { warn() {}, info() {} }))
    for (let index = 0; index < 3; index++) await guard.check(request('203.0.113.200'), reply(), 'portal.signin.start', { subject: 't|b@example.com' })
    expect(await issueOf(guard.check(request('203.0.113.200'), reply(), 'portal.signin.start', { subject: 't|b@example.com' }))).toMatchObject({ path: 'retryAfter' })
    expect(await guard.claim('portal.signin.code', 'gap', 't|b@example.com', 60_000)).toBe(true)
    expect(await guard.claim('portal.signin.code', 'gap', 't|b@example.com', 60_000)).toBe(false)
  })
})

describe('the portal in the authenticator chain', () => {
  const routed = (audiences: RouteManifestEntry['audiences'], cookies: Record<string, string>) =>
    ({ cookies, routeOptions: { config: { manifest: { audiences, permission: 'files.read', scope: 'record' } } } }) as unknown as FastifyRequest

  it('sends a partner-only route to the portal, whatever cookie came; other routes onwards', () => {
    expect(portalRequest(routed(['partner'], {}))).toBe(true)
    expect(portalRequest(routed(['partner'], { [SESSION_COOKIE]: 'office' }))).toBe(true)
    expect(portalRequest(routed(['office'], { [PORTAL_COOKIE]: 'portal' }))).toBe(false)
    expect(portalRequest(routed('public', { [PORTAL_COOKIE]: 'portal' }))).toBe(false)
  })

  it('reads the portal cookie on a shared route only when it is the one session cookie (office and floor keep theirs)', () => {
    const shared = ['office', 'floor', 'partner', 'link'] as const
    expect(portalRequest(routed(shared, { [PORTAL_COOKIE]: 'portal' }))).toBe(true)
    expect(portalRequest(routed(shared, { [FLOOR_COOKIE]: 'floor' }))).toBe(false)
    expect(portalRequest(routed(shared, {}))).toBe(false)
    expect(portalRequest(routed(shared, { [PORTAL_COOKIE]: 'portal', [SESSION_COOKIE]: 'office' }))).toBe(false)
    expect(portalRequest(routed(shared, { [PORTAL_COOKIE]: 'portal', [FLOOR_COOKIE]: 'floor' }))).toBe(false)
  })

  it('chains: the portal authenticator for a portal request, the next one otherwise', async () => {
    const chain = withPortalSessions(
      async () => ({ audience: 'partner', tenantId: 't', actorId: 'p', partyId: 'x', grants: [] }),
      async () => ({ audience: 'office', tenantId: 't', actorId: 'o', grants: [] }),
    )
    expect((await chain(routed(['partner'], {})))?.audience).toBe('partner')
    expect((await chain(routed(['office', 'floor', 'partner', 'link'], { [FLOOR_COOKIE]: 'floor' })))?.audience).toBe('office')
  })
})
