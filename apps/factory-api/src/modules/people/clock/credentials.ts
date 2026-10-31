import type { FastifyRequest } from 'fastify'
import { badgeCodeHash, normalizeBadgeCode } from '@nexus/factory-domain/auth/floor/badge'
import { isPinLocked, verifyPin } from '@nexus/factory-domain/auth/floor/pin'
import { UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import type { CommandTx } from '../../../core/command'
import type { DeviceRequest } from '../../../platform/auth/floor/device'
import { recordWrongPin } from '../../../platform/auth/floor/sign-in'
import { siteScope } from '../../../platform/auth/floor/store'
import type { OfficeAuth } from '../../../platform/auth/sessions/office-auth'
import type { ClockWay } from '@nexus/factory-domain/people/clock/rules'

/**
 * Who clocks at the tablet (B-W2b-33; MES-223, MES-239; Owner answer F1: a badge alone starts work, the PIN only when
 * signing in by name). Read in the FLOOR scope of the device token's site, before anyone is signed in:
 *
 *   badge         the badge's code (SHA-256 looked up, never kept): an ACTIVE badge of an ACTIVE worker of the site. A
 *                 badge alone always clocks, at every site (attendance by badge, Statuto dei Lavoratori art. 4 c.2): it
 *                 proves no PIN, so it never clears a count of wrong PINs.
 *   name and PIN  "Forgot your badge": the worker picked by name and their PIN (flagged FORGOT_BADGE for the team leader).
 *                 The same answer for an unknown worker, one without a PIN, a locked one and a wrong PIN, after the same
 *                 scrypt work (no oracle); a wrong PIN counts towards the worker's lockout as at sign-in (the device's
 *                 floor command `floor.signInFailed`); the lock is checked before the PIN.
 * No biometric factor exists (GDPR art. 9). The code and the PIN never reach a command's input, result, audit row or log.
 *
 * Mirrors the floor sign-in's check (platform/auth/floor/sign-in.ts): that file is B-W2b-52's lane while it merges, and
 * keeps its proof private there; this one never starts a session.
 */

const wrongCredentials = () => new UnauthenticatedError('The badge or PIN is wrong, or this worker is locked for a few minutes after too many wrong PINs.')

const WORKER_SELECT = { id: true, status: true, displayName: true, employeeId: true, pinHash: true, pinLockedUntil: true } as const

export interface ProvedClocker {
  readonly worker: { readonly id: string; readonly displayName: string; readonly employeeId: string | null }
  readonly way: ClockWay
  /** NAME: the PIN hash the PIN matched (the command claims it again: same PIN, not locked meanwhile). */
  readonly pinHash: string | null
}

export interface ClockCredentials {
  readonly badgeCode?: string | undefined
  readonly workerId?: string | undefined
  readonly pin?: string | undefined
}

/** The worker the credentials name at the device's site, or a uniform 401 (a wrong PIN counted first). */
export async function proveClocker(auth: OfficeAuth, request: FastifyRequest, place: DeviceRequest, body: ClockCredentials): Promise<ProvedClocker> {
  if ((body.badgeCode === undefined) === (body.workerId === undefined)) {
    throw new ValidationError('Scan your badge, or pick your name and enter your PIN.', [{ path: 'badgeCode', message: 'Send a badge code or a worker id, not both.' }])
  }
  const now = auth.clock.now()
  if (body.badgeCode !== undefined) {
    const code = normalizeBadgeCode(body.badgeCode)
    const found = code === null ? null : await auth.database.withScope(siteScope(place.token), (client) =>
      client.badge.findUnique({ where: { codeHash: badgeCodeHash(code) }, select: { status: true, worker: { select: WORKER_SELECT } } }),
    )
    if (!found || found.status !== 'ACTIVE' || found.worker.status !== 'ACTIVE') throw wrongCredentials()
    return { worker: { id: found.worker.id, displayName: found.worker.displayName, employeeId: found.worker.employeeId }, way: 'BADGE', pinHash: null }
  }
  if (body.pin === undefined) throw new ValidationError('Enter your PIN: clocking by name always needs it.', [{ path: 'pin', message: 'Required.' }])
  const worker = await auth.database.withScope(siteScope(place.token), (client) => client.worker.findUnique({ where: { id: body.workerId! }, select: WORKER_SELECT }))
  if (!worker || worker.status !== 'ACTIVE' || worker.pinHash === null || isPinLocked(worker, now)) {
    await verifyPin(body.pin, null, auth.pins)
    throw wrongCredentials()
  }
  const check = await verifyPin(body.pin, worker.pinHash, auth.pins)
  if (!check.ok) {
    await recordWrongPin(auth, request, place.device, worker.id, place.device.id)
    throw wrongCredentials()
  }
  return { worker: { id: worker.id, displayName: worker.displayName, employeeId: worker.employeeId }, way: 'NAME', pinHash: worker.pinHash }
}

/**
 * Inside the clock's command, after a name and PIN: the worker still has that PIN and is not locked meanwhile, and the
 * proved PIN clears the count of wrong ones (as a sign-in does). Else the uniform 401 (nothing is recorded).
 */
export async function claimPin(tx: CommandTx, workerId: string, pinHash: string, now: Date): Promise<void> {
  const claimed = await tx.worker.updateMany({
    where: { id: workerId, status: 'ACTIVE', pinHash, OR: [{ pinLockedUntil: null }, { pinLockedUntil: { lte: now } }] },
    data: { failedPinAttempts: 0, pinLockedUntil: null },
  })
  if (claimed.count !== 1) throw wrongCredentials()
}
