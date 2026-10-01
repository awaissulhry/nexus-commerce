/**
 * The sheet reads Etsy's resource names (shipping profile, return policy, shop section, readiness state) at
 * `/api/etsy/information/references` (`referenceOptions.ts`: `${getBackendUrl()}/api/${path}`). The route was declared as
 * `/etsy/information/references` inside `estyRoutes`, which index.ts registers WITHOUT a prefix, so the sheet's request
 * answered 404 "Route … not found" and every Etsy reference cell said its names were unavailable (found 2026-10-01 by
 * the final local browser round: the lane04 spec allows no console error).
 */
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { estyRoutes } from './etsy.js'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'

describe('Etsy information references route', () => {
  it('answers at the path the sheet requests, registered as index.ts registers it', async () => {
    const app = Fastify()
    await app.register(estyRoutes)
    try {
      // An unsupported resource is refused by the route itself: proof it exists, without reaching Etsy.
      const response = await app.inject({ method: 'GET', url: '/api/etsy/information/references?accountId=e2e_account&field=not_a_reference' })
      expect(response.statusCode, response.body).toBe(400)
      expect(response.json()).toEqual({ error: 'Choose an Etsy account and supported resource.' })
    } finally { await app.close() }
  })

  it('is a read of listings, like the other channel reference lookups', () => {
    expect(permissionForRoute('GET', '/api/etsy/information/references')).toBe('listings.view')
  })
})
