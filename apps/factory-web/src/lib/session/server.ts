import { cache } from 'react'
import { isApiError } from '../api/errors'
import { fetchOfficeMe } from '../api/office'
import { serverApi } from '../api/server'
import { sessionFromMe, type OfficeSession } from './session'

/**
 * The office session loader for server layouts: `GET /auth/office/me` with the request's factory cookies (and, inside
 * `/w/<company>`, `x-factory-company`). Once per request and company (React `cache`).
 */

export type SessionLoad =
  | { kind: 'signed_in'; session: OfficeSession }
  /** No session, or it ended: the office goes to sign-in. */
  | { kind: 'signed_out' }
  /** The person may not work in that company (or it is not one of the tenant's). */
  | { kind: 'forbidden' }
  /** The API did not answer as it should (down, or a version this web does not know). */
  | { kind: 'unavailable'; code: string; requestId: string | null }

export const SIGN_IN_PATH = '/sign-in'

export const loadOfficeSession = cache(async (company: string | null = null): Promise<SessionLoad> => {
  try {
    const me = await fetchOfficeMe(await serverApi({ company }))
    return { kind: 'signed_in', session: sessionFromMe(me) }
  } catch (error) {
    if (isApiError(error)) {
      if (error.kind === 'signed_out') return { kind: 'signed_out' }
      if (error.kind === 'forbidden' || error.kind === 'not_found') return { kind: 'forbidden' }
      return { kind: 'unavailable', code: error.code, requestId: error.requestId }
    }
    throw error
  }
})
