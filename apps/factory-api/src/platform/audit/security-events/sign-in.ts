import type { FastifyRequest } from 'fastify'
import { isPinLocked } from '@nexus/factory-domain/auth/floor/pin'
import type { DeviceRequest } from '../../auth/floor/device'
import { siteScope } from '../../auth/floor/store'
import { PRE_SESSION_ACTOR_ID, type OfficeAuth } from '../../auth/sessions/office-auth'
import { insertSecurityEvent } from './record'

/**
 * The sign-ins refused before anybody is proved (B-W2b-399; PLT-075 "unknown attempts too"): an address nobody has, a person
 * without a password, a locked, suspended or inactive account; an unknown badge or worker, a worker without a PIN, locked or
 * inactive; a portal code for an address with no account or no live code. A wrong secret of a known person is a command and
 * its own event (ledgers.ts). Each is written after the answer (`auth.afterAnswer`), so its time tells nothing either: the
 * answers stay the same for every one of them. Never the address typed: the reason is a code, the actor null when nobody is
 * known. A sign-in that names no known tenant writes nothing (there is no tenant to write into).
 */

export type OfficeRefusal = 'UNKNOWN_ACCOUNT' | 'NO_PASSWORD' | 'LOCKED' | 'SUSPENDED' | 'INACTIVE'

/** The office sign-in's refusal, in the tenant's office scope. */
export function officeSignInRefused(auth: OfficeAuth, request: FastifyRequest, tenantId: string, actorId: string | null, reason: OfficeRefusal): void {
  const ipHash = auth.secrets.ipHash(request.ip)
  auth.afterAnswer(() => auth.inTenant(tenantId, PRE_SESSION_ACTOR_ID, (client) => insertSecurityEvent(client, { kind: 'SIGN_IN_FAILED', surface: 'OFFICE', actorId, ipHash, details: { reason } })), request.log)
}

interface FloorCandidate {
  readonly worker: { readonly id: string; readonly status: string; readonly pinHash: string | null; readonly pinLockedUntil: Date | null } | null | undefined
}

/** The floor sign-in's refusal, in the device's floor scope (its site). */
export function floorSignInRefused(auth: OfficeAuth, request: FastifyRequest, place: DeviceRequest, byBadge: boolean, candidate: FloorCandidate | null, now: Date): void {
  const worker = candidate?.worker ?? null
  const reason = !worker ? (byBadge ? 'UNKNOWN_BADGE' : 'UNKNOWN_WORKER') : worker.status !== 'ACTIVE' ? 'INACTIVE' : worker.pinHash === null ? 'NO_PIN' : isPinLocked(worker, now) ? 'LOCKED' : 'REFUSED'
  const ipHash = auth.secrets.ipHash(request.ip)
  auth.afterAnswer(
    () => auth.database.withScope(siteScope(place.token), (client) => insertSecurityEvent(client, { kind: 'SIGN_IN_FAILED', surface: 'FLOOR', siteId: place.device.siteId, actorId: worker?.id ?? null, ipHash, details: { reason } })),
    request.log,
  )
}

/** The portal sign-in's refusal of a code (no account, or no live code), in the tenant's office scope. */
export function portalSignInRefused(auth: OfficeAuth, request: FastifyRequest, tenantSlug: string, person: { readonly id: string; readonly partyId: string } | null): void {
  const ipHash = auth.secrets.ipHash(request.ip)
  auth.afterAnswer(async () => {
    const tenant = await auth.inPlatform((client) => client.tenant.findUnique({ where: { slug: tenantSlug.toLowerCase() }, select: { id: true, status: true } }))
    if (tenant?.status !== 'ACTIVE') return
    await auth.inTenant(tenant.id, PRE_SESSION_ACTOR_ID, (client) =>
      insertSecurityEvent(client, { kind: 'SIGN_IN_FAILED', surface: 'PORTAL', actorId: person?.id ?? null, partyId: person?.partyId ?? null, ipHash, details: { reason: person ? 'NO_CODE' : 'UNKNOWN_ACCOUNT' } }),
    )
  }, request.log)
}
