import { cookies } from 'next/headers'
import { readFactoryApiUrl } from '../../lib/api-url'
import { createApiClient, CSRF_COOKIE } from '../../lib/api/client'
import { readSession, type SignedIn } from './api'

/** The API's portal session cookie (apps/factory-api platform/auth/portal/cookies.ts). */
const PORTAL_COOKIE = '__Host-factory_portal'

/**
 * The portal session of this request, for the sign-in page's server render (B-W2b-164): `GET /portal/me` with the request's
 * PORTAL cookie and the CSRF cookie only — never an office cookie. No portal cookie: no call (the page then asks nothing of
 * the API that it knows answers "signed out"). Null without a live session, or when the API does not answer (the page
 * then simply signs in).
 */
export async function loadSignInSession(): Promise<SignedIn | null> {
  const jar = await cookies()
  const portal = jar.get(PORTAL_COOKIE)?.value
  if (!portal) return null
  const csrf = jar.get(CSRF_COOKIE)?.value
  const cookie = [`${PORTAL_COOKIE}=${portal}`, ...(csrf === undefined ? [] : [`${CSRF_COOKIE}=${csrf}`])].join('; ')
  const api = createApiClient({ baseUrl: readFactoryApiUrl(process.env.FACTORY_API_URL), cookie })
  return readSession(api).catch(() => null)
}
