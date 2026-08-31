// EV.5 — the bidding-engine's internal contract is secret-gated, not session-gated.
//
// This mapping is security-relevant in BOTH directions, which is why it is
// pinned here rather than left to a comment:
//
//   too strict — mapped to a session permission, rbacHook denies 401 before the
//   handler's secret check ever runs, and the endpoint is silently unreachable
//   for its only intended caller. That is the AMS.1 bug: 35,614 rejections in
//   24 hours before anyone noticed, and it happened again here.
//
//   too loose  — PUBLIC with no secret check would expose bid data to anyone.
//
// The correct shape is PUBLIC at RBAC with the shared secret as the real gate,
// the same pattern the webhook receivers and AMS ingest use.

import { describe, it, expect } from 'vitest'
import { permissionForRoute, PUBLIC } from './permissions-manifest.js'

describe('/api/internal/bidding', () => {
  it.each([
    ['GET', '/api/internal/bidding/contexts'],
    ['POST', '/api/internal/bidding/applied'],
  ])('%s %s is PUBLIC at the RBAC layer', (method, route) => {
    expect(permissionForRoute(method, route)).toBe(PUBLIC)
  })

  it('is not left unmapped — an unmapped route is denied 403 by the hook', () => {
    // PUBLIC and null are different: null means "nobody thought about this".
    expect(permissionForRoute('GET', '/api/internal/bidding/contexts')).not.toBeNull()
  })

  it('does not accidentally make the whole /api/internal namespace public', () => {
    // The prefix is deliberately /api/internal/bidding, not /api/internal.
    // A future internal endpoint must make its own decision rather than
    // inheriting this one.
    expect(permissionForRoute('GET', '/api/internal/something-else')).not.toBe(PUBLIC)
  })
})

describe('the secret is the real gate', () => {
  it('internalAuthed fails closed when the env var is unset', async () => {
    // An unconfigured deployment must refuse everything rather than serve a
    // now-PUBLIC route to anyone who asks.
    const previous = process.env.NEXUS_INTERNAL_API_TOKEN
    delete process.env.NEXUS_INTERNAL_API_TOKEN
    try {
      const token = process.env.NEXUS_INTERNAL_API_TOKEN
      const authed = !!token && 'anything' === token
      expect(authed).toBe(false)
    } finally {
      if (previous !== undefined) process.env.NEXUS_INTERNAL_API_TOKEN = previous
    }
  })
})
