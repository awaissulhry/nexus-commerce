/**
 * Partner sessions (B-W2b-152 schema; B-W2b-159; A1 §3.10 "invite only, a 6-digit code, 12 h sessions"; design
 * portal.frame stay-signed-in "For your security we sign you out after 30 minutes without use"). A portal session is
 * bound to ONE party (its person's) and the company whose portal it opened, and runs as factory_partner_runtime:
 *
 *   idle       30 minutes without a request ends it; slid forward at most once a minute, never past the absolute end
 *              (the database refuses an idle end more than 30 minutes after the last request);
 *   absolute   12 hours after sign-in at most;
 *   step-up    a fresh e-mail code on THIS session opens the sensitive partner acts for 5 minutes.
 */

export const PORTAL_SESSION = Object.freeze({
  idleMs: 30 * 60_000,
  absoluteMs: 12 * 60 * 60_000,
  /** The idle end moves at most this often (one write a minute per session, not one per request). */
  slideEveryMs: 60_000,
  /** A step-up opens the sensitive partner acts for this long. */
  stepUpValidMs: 5 * 60_000,
})

/**
 * The idle end after a request at `now`, never later than the absolute end. B-W2b-404 (PLT-068): `idleMs` is the tenant's
 * portal idle time (SecuritySettings, at most these 30 minutes; factory-domain auth/sessions/lengths); default A1's.
 */
export function portalIdleExpiryAt(now: Date, absoluteExpiresAt: Date, idleMs: number = PORTAL_SESSION.idleMs): Date {
  return new Date(Math.min(now.getTime() + idleMs, absoluteExpiresAt.getTime()))
}

/** The end of a session started at `now`; `absoluteMs` the tenant's longest portal session (at most these 12 hours). */
export function portalAbsoluteExpiryAt(now: Date, absoluteMs: number = PORTAL_SESSION.absoluteMs): Date {
  return new Date(now.getTime() + absoluteMs)
}

/** Until when the last step-up of a session holds (null: none, or none any more). */
export function portalStepUpUntil(stepUpAt: Date | null, now: Date): Date | null {
  if (stepUpAt === null) return null
  const until = new Date(stepUpAt.getTime() + PORTAL_SESSION.stepUpValidMs)
  return until.getTime() > now.getTime() ? until : null
}
