import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { ConflictError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { IncidentRefusal } from '@nexus/factory-domain/safety/incidents/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID, type FloorContext, type OfficeContext, type SystemContext } from '../../../core/context'

/**
 * Who may do what with an incident (B-W2b-125): office routes check each incident with can() against its company and site
 * (safety.incidents.view | report | manage | people); a tablet reports with floor.work at its own site only. A record the
 * caller may not read is not found (404); a write the caller may read but not make is a 403 in words. A rule's refusal is a
 * 409 `refusal/<CODE>` (+ `body/<field>`), the shape of the safety organisation's (modules/safety/organisation/access.ts).
 */

export { actorIdOf, bodyIssue, dateOf, dayOf, problemsError, todayOf } from '../../people/employees/access'

export type IncidentContext = OfficeContext | FloorContext

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export function floorOf(caller: Pick<CommandCaller, 'factoryContext'>): FloorContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'floor') throw new ForbiddenError()
  return context
}

export type Placed = { readonly companyId: string; readonly siteId: string }

/** The screen's company (`/w/<company>`) and the permission over the incident's company and site. */
export const may = (context: OfficeContext, permission: Permission, place: Placed): boolean =>
  (!context.companyId || context.companyId === place.companyId) && can(actorOf(context), permission, place)

export function assertMay(context: OfficeContext, permission: Permission, place: Placed, what = 'Incident'): void {
  if (!may(context, permission, place)) throw new NotFoundError(`${what} not found.`)
}

export function assertMayWrite(context: OfficeContext, permission: Permission, place: Placed, words: string): void {
  if (!may(context, permission, place)) throw new ForbiddenError(words)
}

/** A list's filter: the incidents of the companies and sites the permission reaches, in the screen's company. */
export function scopeOf(context: OfficeContext, permission: Permission): Record<string, unknown> {
  const reach = scopeWhere(actorOf(context), permission, { company: 'companyId', site: 'siteId' }) as Record<string, unknown>
  return context.companyId ? { AND: [reach, { companyId: context.companyId }] } : reach
}

export class IncidentRefusedError extends ConflictError {
  override name = 'IncidentRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: IncidentRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }, ...(refusal.field ? [{ path: `body/${refusal.field}`, message: refusal.message }] : [])]
  }
}

/** A rule's refusal (409). */
export function refuse(refusal: IncidentRefusal | null): void {
  if (refusal) throw new IncidentRefusedError(refusal)
}

/** The tenant's system caller for one place only, holding exactly these permissions (the files' pattern, B-W2b-96). */
export function placeCaller(request: FastifyRequest, tenantId: string, place: Placed, permissions: readonly Permission[], requestId = String(request.id)): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [...permissions], companies: [place.companyId], sites: [place.siteId], parties: 'all' }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId, grants: [grant] })
  view.factoryContext = context
  return view
}

/**
 * A report sent without a name (QHS-265; B-W2b-91's note; the lead's rule "audited WITHOUT the worker"): written in the FLOOR
 * scope of the tablet's site (the database's rule: a floor report comes from a floor session) as the system actor, so that
 * neither the worker nor the tablet appears anywhere the report leaves a trace: its audit row (actor = the system actor,
 * device = the system actor: no tablet has that id), its number's ledger row (allocatedById = the system actor), its
 * receipt (the key below), its event, the request id (a fresh one, not the HTTP request's) and the floor-sync ledger (an
 * anonymous report is never queued). The tablet's grants stay (the permission was checked on the real session).
 */
export function anonymousCaller(caller: CommandCaller, context: FloorContext, requestId: string): CommandCaller {
  const view = Object.create(caller) as CommandCaller & { factoryContext: CommandCaller['factoryContext'] }
  const anonymous: FloorContext = Object.freeze({ audience: 'floor', tenantId: context.tenantId, siteId: context.siteId, actorId: SYSTEM_ACTOR_ID, deviceId: SYSTEM_ACTOR_ID, grants: context.grants, requestId })
  view.factoryContext = anonymous
  return view
}

/**
 * The receipt key of a report without a name: the tablet's Idempotency-Key hashed with the tenant and site, so a resend
 * answers from the same receipt while the stored key cannot name the tablet (a floor key is often `<device>.<event id>`).
 */
export const anonymousKey = (context: FloorContext, key: string): string => `anon.${createHash('sha256').update(`${context.tenantId}:${context.siteId}:${key}`).digest('hex').slice(0, 48)}`
