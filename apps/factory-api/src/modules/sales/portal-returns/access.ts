import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { PORTAL_UPLOAD } from '@nexus/factory-domain/auth/partners/permissions'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { PORTAL_COMPLAINTS_VIEW, PORTAL_RETURNS_REQUEST } from '@nexus/factory-domain/sales/portal-returns/permissions'
import { actorOf, requireContext } from '../../../core/context'
import { portalSessionOf, type PortalSession } from '../../../platform/auth/portal/authenticator'
import { portalOf } from '../../../platform/auth/portal/service'
import type { Place } from './store'

/**
 * Who reads and asks in the portal (B-W2b-192): a customer's portal session (the route's manifest checked the page's
 * permission over the session's party). Returns and complaints are not partner-readable (no grant: the plan's reads go
 * through the API), so every read runs in the tenant's office scope AS THE PERSON (officeAuth.inTenant) and names the
 * session's company and party itself (store.ts). A price (the credit note's reference, a line's price) shows only with the
 * price grain of the person's role; an office preview reads and never asks.
 */

export interface PortalReader {
  readonly session: PortalSession
  readonly actor: Actor
  readonly place: Place
  readonly seesPrices: boolean
  /** The person may ask for a return or report a complaint (portal.returns.request; never a preview). */
  readonly mayRequest: boolean
  /** The person may add photos (the upload capability, B-W2b-162). */
  readonly mayUpload: boolean
  /** The person follows the complaints' investigation, the answer letter and the 8D (portal.complaints.view). */
  readonly readsComplaints: boolean
  /** A read in the tenant's office scope, as the person. */
  inTenant<T>(work: (client: FactoryClient) => Promise<T>): Promise<T>
}

export function portalReader(app: FastifyInstance, request: FastifyRequest): PortalReader {
  const session = portalSessionOf(request)
  const actor = actorOf(requireContext(request))
  const auth = portalOf(app).auth
  const place: Place = { companyId: session.company.id, partyId: session.partyId }
  const holds = (permission: Parameters<typeof can>[1]) => can(actor, permission, place)
  return {
    session,
    actor,
    place,
    seesPrices: heldGrains(actor).has('price'),
    mayRequest: !session.preview && holds(PORTAL_RETURNS_REQUEST),
    mayUpload: !session.preview && holds(PORTAL_RETURNS_REQUEST) && holds(PORTAL_UPLOAD),
    readsComplaints: holds(PORTAL_COMPLAINTS_VIEW),
    inTenant: (work) => auth.inTenant(session.tenantId, session.userId, work),
  }
}

export const REQUEST_WORDS = "Your access lets you follow your returns, not ask for one: ask your admin for the right to ask."
export const UPLOAD_WORDS = 'Your access lets you follow your returns, not send files: ask your admin for the right to upload.'
export const PREVIEW_WORDS = 'A preview reads the portal; it never acts for the customer.'

export function assertMayRequest(reader: PortalReader): void {
  if (reader.session.preview) throw new ForbiddenError(PREVIEW_WORDS)
  if (!reader.mayRequest) throw new ForbiddenError(REQUEST_WORDS)
}

export function assertMayUpload(reader: PortalReader): void {
  assertMayRequest(reader)
  if (!reader.mayUpload) throw new ForbiddenError(UPLOAD_WORDS)
}
