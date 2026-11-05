import type { FastifyInstance } from 'fastify'
import { abuseGuardOf, abuseKey, type AbuseGuard } from '../../abuse/guard'
import { officeAuthOf, type OfficeAuth } from '../sessions/office-auth'
import { portalMailer, type PortalMailer } from './mail'

/**
 * What the portal routes share (B-W2b-159): the office sign-in object (database, clock, secrets, command(), the
 * after-answer queue), the abuse guard of the public routes, the code mailer and the code key. Made once per office
 * sign-in object; tests set the mailer and the answer floor with `usePortalOptions`.
 *
 * The answer floor: a failed code answers no sooner than this after the request came in, whatever was (or was not) looked
 * up, so the time of an answer does not tell an address with a partner account from one without.
 */

export interface PortalServices {
  readonly auth: OfficeAuth
  readonly guard: AbuseGuard
  readonly mailer: PortalMailer
  /** The HMAC key of the stored codes (derived from the cookie secret). */
  readonly codeKey: Buffer
  readonly answerFloorMs: number
}

export const ANSWER_FLOOR_MS = 400

let options: { mailer?: PortalMailer; answerFloorMs?: number } = {}
const byAuth = new WeakMap<object, PortalServices>()

/** Tests: a mailer of their own and a shorter answer floor. `{}` goes back to the defaults. */
export function usePortalOptions(next: { readonly mailer?: PortalMailer; readonly answerFloorMs?: number }): void {
  options = { ...next }
}

export function portalOf(app: FastifyInstance): PortalServices {
  const auth = officeAuthOf(app)
  const guard = abuseGuardOf(app)
  let base = byAuth.get(auth)
  if (!base) {
    base = { auth, guard, mailer: portalMailer({ database: auth.database, clock: auth.clock }), codeKey: abuseKey(auth.secrets, 'portal-code'), answerFloorMs: ANSWER_FLOOR_MS }
    byAuth.set(auth, base)
  }
  return { ...base, guard, mailer: options.mailer ?? base.mailer, answerFloorMs: options.answerFloorMs ?? base.answerFloorMs }
}

/** Waits until `floorMs` passed since `startedAt` (wall clock: the answer's timing, not the business clock). */
export async function answerFloor(startedAt: number, floorMs: number): Promise<void> {
  const wait = startedAt + floorMs - Date.now()
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}
