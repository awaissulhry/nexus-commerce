import type { FastifyRequest } from 'fastify'
import { DomainError } from '@nexus/factory-domain/core/errors'
import type { Clock } from '../../../core/time'
import { floorSessionOf } from './authenticator'

/**
 * The floor's step-up (Owner answer F1 a; anatomy 3.8 "on the floor, PinPad"): at a site where a badge alone signs a
 * worker in, the PIN is still asked to sign (a release, an approval, a PPE receipt), to open My day, and with a
 * sign-in by name. The floor session keeps when the worker last proved their PIN (`FloorSession.pinVerifiedAt`): a
 * sign-in with a PIN sets it, a sign-in with a badge alone leaves it empty, and `POST /floor/step-up` (sign-in.ts)
 * sets it again.
 *
 *   requireFloorStepUp   a signing act's or My day's route calls it after its own checks: a 403 naming `stepUp`
 *                        (the web's `step_up` kind: the tablet shows the PIN pad, then retries) unless the PIN was
 *                        proved in the last FLOOR_STEP_UP_VALID_MS. A session started by a badge alone never passes
 *                        before a step-up.
 *
 * Why a short window and not "once per session": a floor tablet is shared, and the step-up stands for "it is still
 * me at this tablet" at the moment of the act (anatomy 3.8: asked at the action, never at page load).
 */

/** A proved PIN opens signing acts and My day for 2 minutes (the office's step-up: 5 minutes). */
export const FLOOR_STEP_UP_VALID_MS = 2 * 60_000

/** Until when a PIN proved at `pinVerifiedAt` opens signing acts; null when none was proved. */
export function floorStepUpUntil(pinVerifiedAt: Date | null): Date | null {
  return pinVerifiedAt ? new Date(pinVerifiedAt.getTime() + FLOOR_STEP_UP_VALID_MS) : null
}

/** The step-up is still open at `now`. */
export function floorSteppedUp(pinVerifiedAt: Date | null, now: Date): boolean {
  const until = floorStepUpUntil(pinVerifiedAt)
  return until !== null && until.getTime() > now.getTime()
}

/** The step-up a signing act or My day needs: a 403 that names `stepUp` when no PIN was proved this recently. */
export class FloorStepUpRequiredError extends DomainError {
  override name = 'FloorStepUpRequiredError'
  constructor() {
    super('forbidden', 'Enter your PIN first (step-up).', [{ path: 'stepUp', message: 'Required.' }])
  }
}

/** For a signing act's or My day's route, after its own checks. */
export function requireFloorStepUp(auth: { readonly clock: Clock }, request: FastifyRequest): void {
  if (!floorSteppedUp(floorSessionOf(request).pinVerifiedAt, auth.clock.now())) throw new FloorStepUpRequiredError()
}
