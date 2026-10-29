import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { floorWrite } from './task-api'
import type { PinProblem } from './view/TaskParts'

/**
 * The floor's PIN step-up (Owner answer F1: a badge alone starts work, the PIN signs): a signing act (decide an
 * inspection, release garments) answers 403 `stepUp` unless a PIN was proved on this tablet in the last 2 minutes; the
 * screen then shows its PIN step, `POST /floor/step-up {pin}` opens the window, and the SAME action is sent again with
 * the same Idempotency-Key. A wrong PIN counts towards the lockout (400 `pin`; the person stays signed in); locked: 403.
 * The PIN goes only in the body and never into an outcome.
 */

const answer = z.object({ stepUpUntil: z.string() })

export type StepUpOutcome = { readonly ok: true; readonly until: string } | { readonly ok: false; readonly problem: Exclude<PinProblem, null> | 'signedOut' }

export async function floorStepUp(api: ApiClient, pin: string): Promise<StepUpOutcome> {
  const result = await floorWrite(api, 'POST', '/floor/step-up', { body: { pin }, schema: answer })
  if (result.ok) return { ok: true, until: result.value.stepUpUntil }
  switch (result.problem.kind) {
    case 'invalid':
      return { ok: false, problem: 'wrong' }
    case 'forbidden':
    case 'stepUp':
    case 'rateLimited':
      return { ok: false, problem: 'locked' }
    case 'signedOut':
      return { ok: false, problem: 'signedOut' }
    case 'offline':
      return { ok: false, problem: 'offline' }
    default:
      return { ok: false, problem: 'unavailable' }
  }
}

/** Whether the tablet's last PIN still covers a signing act now (the API decides; this only saves a 403 round trip). */
export function steppedUp(stepUpUntil: string | null | undefined, now: Date = new Date()): boolean {
  if (!stepUpUntil) return false
  const until = Date.parse(stepUpUntil)
  return Number.isFinite(until) && until - now.getTime() > 5_000
}
