import { cache } from 'react'
import { cookies } from 'next/headers'
import type { PublicBranding } from '@nexus/factory-domain/branding/contracts'
import { readFactoryApiUrl } from '../../lib/api-url'
import { readPublicBranding } from '../../lib/api/branding'
import { CSRF_COOKIE, createApiClient, type ApiClient } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { fetchPortalMe, fetchTerms, type PortalMe, type PortalTerms } from './api'

/**
 * The portal's session loader for its server layout (B-W2b-173): `GET /portal/me` with the request's PORTAL cookie and the
 * CSRF cookie — and no other cookie: an office person's session never travels with a portal read, and a portal read never
 * opens an office route (the API's authenticator keeps them apart too). Once per request (React `cache`).
 */

/** The API's portal session cookie (apps/factory-api platform/auth/portal/cookies.ts). */
export const PORTAL_COOKIE = '__Host-factory_portal'

async function portalServerApi(): Promise<ApiClient> {
  const jar = await cookies()
  const cookie = [PORTAL_COOKIE, CSRF_COOKIE]
    .flatMap((name) => {
      const value = jar.get(name)?.value
      return value === undefined ? [] : [`${name}=${value}`]
    })
    .join('; ')
  return createApiClient({ baseUrl: readFactoryApiUrl(process.env.FACTORY_API_URL), cookie: cookie === '' ? null : cookie })
}

export type PortalLoad =
  | { kind: 'signed_in'; me: PortalMe; branding: PublicBranding | null }
  /** No portal session, or it ended: sign in first (B-W2b-164's page), then back here. */
  | { kind: 'signed_out' }
  /** The API did not answer as it should. */
  | { kind: 'unavailable'; code: string; requestId: string | null }

export const loadPortalSession = cache(async (): Promise<PortalLoad> => {
  const api = await portalServerApi()
  let me: PortalMe
  try {
    me = await fetchPortalMe(api)
  } catch (error) {
    if (isApiError(error)) {
      if (error.kind === 'signed_out' || error.kind === 'forbidden') return { kind: 'signed_out' }
      return { kind: 'unavailable', code: error.code, requestId: error.requestId }
    }
    throw error
  }
  // The company's branding (B-W2b-161): a failed read draws the company's name in text and the standard colours.
  const branding = await readPublicBranding(api, me.company.id).catch(() => null)
  return { kind: 'signed_in', me, branding }
})

/** The portal terms in force in a language (the foot's "Portal terms", opened in a new tab). */
export async function loadPortalTerms(locale: string): Promise<PortalTerms | null> {
  try {
    return await fetchTerms(await portalServerApi(), locale)
  } catch (error) {
    if (isApiError(error)) return null
    throw error
  }
}
