import type { FastifyRequest } from 'fastify'
import { badgeCodeHash, normalizeBadgeCode } from '@nexus/factory-domain/auth/floor/badge'
import { UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import type { ClockWay } from '@nexus/factory-domain/people/clock/rules'
import type { CommandTx } from '../../../core/command'
import type { DeviceRequest } from '../../../platform/auth/floor/device'
import { claimProved, provedWorker, refuseByMode } from '../../../platform/auth/floor/sign-in'
import { siteScope } from '../../../platform/auth/floor/store'
import type { OfficeAuth } from '../../../platform/auth/sessions/office-auth'

/**
 * Who clocks at the tablet (B-W2b-33; MES-223, MES-239; Owner answer F1: a badge alone starts work, the PIN only when
 * signing in by name). Read in the FLOOR scope of the device token's site, before anyone is signed in:
 *
 *   device mode   B-W2b-52's rule, as at sign-in (`refuseByMode`): nobody clocks on a line board (DISPLAY: 403 before
 *                 any credential is read, clock.ts); a personal phone clocks only its own person (403 after the proof).
 *   name and PIN  "Forgot your badge": the floor sign-in's own check (`provedWorker`: the same answer for an unknown
 *   (or a badge   worker, one without a PIN, a locked one and a wrong PIN, after the same scrypt work; a wrong PIN counts
 *   with a PIN)   towards the lockout), claimed again inside the clock's command (`claimProved`: still active, same PIN,
 *                 not locked meanwhile; the proved PIN clears the count of wrong ones). A name is flagged FORGOT_BADGE.
 *   badge alone   the badge's code (SHA-256 looked up, never kept): an ACTIVE badge of an ACTIVE worker of the site. A
 *                 badge alone clocks at EVERY site, whatever the site's sign-in rule (`badgeOnlySignIn` is about signing
 *                 in; clocking by badge is the attendance tool, Statuto dei Lavoratori art. 4 c.2): it proves no PIN, so
 *                 it clears no count of wrong PINs. The sign-in's check would ask a PIN where the site wants one, so this
 *                 one path keeps its own lookup.
 * No biometric factor exists (GDPR art. 9). The code and the PIN never reach a command's input, result, audit row or log.
 */

const wrongCredentials = () => new UnauthenticatedError('The badge or PIN is wrong, or this worker is locked for a few minutes after too many wrong PINs.')

export interface ProvedClocker {
  readonly worker: { readonly id: string; readonly displayName: string }
  readonly way: ClockWay
  /** A PIN was proved: claimed again inside the clock's command (null: a badge alone). */
  readonly claim: ((tx: CommandTx, now: Date) => Promise<void>) | null
}

export interface ClockCredentials {
  readonly badgeCode?: string | undefined
  readonly workerId?: string | undefined
  readonly pin?: string | undefined
}

/** The worker the credentials name at the device's site, or a uniform 401 (a wrong PIN counted first); 403 on another person's phone. */
export async function proveClocker(auth: OfficeAuth, request: FastifyRequest, place: DeviceRequest, body: ClockCredentials): Promise<ProvedClocker> {
  if ((body.badgeCode === undefined) === (body.workerId === undefined)) {
    throw new ValidationError('Scan your badge, or pick your name and enter your PIN.', [{ path: 'badgeCode', message: 'Send a badge code or a worker id, not both.' }])
  }
  if (body.badgeCode !== undefined && body.pin === undefined) {
    const code = normalizeBadgeCode(body.badgeCode)
    const found =
      code === null
        ? null
        : await auth.database.withScope(siteScope(place.token), (client) =>
            client.badge.findUnique({ where: { codeHash: badgeCodeHash(code) }, select: { status: true, worker: { select: { id: true, status: true, displayName: true } } } }),
          )
    if (!found || found.status !== 'ACTIVE' || found.worker.status !== 'ACTIVE') throw wrongCredentials()
    refuseByMode(place, found.worker.id)
    return { worker: { id: found.worker.id, displayName: found.worker.displayName }, way: 'BADGE', claim: null }
  }
  const proved = await provedWorker(auth, request, place, body, place.device.id)
  const { worker, badgeId } = proved.candidate
  refuseByMode(place, worker.id)
  return { worker: { id: worker.id, displayName: worker.displayName }, way: badgeId ? 'BADGE' : 'NAME', claim: (tx, now) => claimProved(tx, place.device, proved, now) }
}
