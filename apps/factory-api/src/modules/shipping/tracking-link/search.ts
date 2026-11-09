import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { makeHeld, normalReference, postcodeMatches, searchProblems, TRACKABLE_STATUSES, TRACKING_LINK } from '@nexus/factory-domain/shipping/tracking-link/rules'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import { abuseGuardOf, type ProofInput } from '../../../platform/abuse/guard'
import { portalCompany } from '../../../platform/auth/portal/store'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { processEmail } from '../../../platform/email-out/service'
import { systemCallerOf } from '../../../platform/files/files'
import { SHIPMENT_HEADER, type ShipmentHeader } from '../store'
import { makeTrackingLinks } from './make'

/**
 * "Find your order" (B-W2b-170; LOG-062; design links.tracking sec:search, `/t`): PUBLIC `POST /tracking/search` {tenant,
 * company?, reference, postcode, proof?} for a customer without the link. The fields are checked first (400 in words at
 * the field); then the abuse guard (policy public.lookup, B-W2b-159: per order reference of the tenant and per network,
 * a proof-of-work challenge after suspicious traffic; every miss counts as a failure). Then, in the tenant's system scope:
 * the company of the address (its code, else the tenant's only active one), its orders whose reference — the customer's
 * own, or our order number — is the one typed (case aside), their shipments that are packed, on the way or delivered less
 * than 60 days ago, and among them those going to the typed postcode (both normalised), newest first, at most five. Each
 * one found gets a ONE-DAY tracking link (via SEARCH: no papers, no claim) whose token is answered once, to this visitor.
 *
 * ONE answer for a miss, whatever was wrong (no such tenant, company, order, or postcode): `{shipments: []}`, and a hit
 * and a miss take at least the same time (TRACKING_LINK.searchAnswerFloorMs), so neither the words nor the time tell
 * whether an order exists.
 */

export interface SearchBody {
  readonly tenant: string
  readonly company?: string | undefined
  readonly reference: string
  readonly postcode: string
  readonly proof?: ProofInput | undefined
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function findShipments(app: FastifyInstance, request: FastifyRequest, body: SearchBody): Promise<{ tenantId: string; shipments: ShipmentHeader[] } | null> {
  const auth = officeAuthOf(app)
  const now = auth.clock.now()
  const tenant = await auth.inPlatform((client) => client.tenant.findUnique({ where: { slug: body.tenant.trim().toLowerCase() }, select: { id: true, status: true } }))
  if (tenant?.status !== 'ACTIVE') return null
  const reference = normalReference(body.reference)
  const shipments = await systemCallerOf(request)(tenant.id).withClient(async (client) => {
    const company = await portalCompany(client, body.company?.trim() || undefined)
    if (!company) return []
    const orders = await client.salesOrder.findMany({
      where: { companyId: company.id, OR: [{ customerRef: { equals: reference, mode: 'insensitive' } }, { number: { equals: reference, mode: 'insensitive' } }] },
      select: { id: true },
      take: 20,
    })
    if (orders.length === 0) return []
    const rows = await client.shipment.findMany({
      where: { companyId: company.id, salesOrderId: { in: orders.map((order) => order.id) }, status: { in: [...TRACKABLE_STATUSES] } },
      select: SHIPMENT_HEADER,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    })
    return rows.filter((row) => postcodeMatches(row.shipTo, body.postcode) && makeHeld(row, now) === null).slice(0, TRACKING_LINK.searchMaxShipments)
  })
  return { tenantId: tenant.id, shipments }
}

/** POST /tracking/search */
export async function searchTracking(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, body: SearchBody) {
  const problems = searchProblems(body)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const guard = abuseGuardOf(app)
  const subject = `track|${body.tenant.trim().toLowerCase()}|${normalReference(body.reference).toLowerCase()}`
  await guard.check(request, reply, 'public.lookup', { subject, proof: body.proof })
  const started = Date.now()
  const auth = officeAuthOf(app)
  const answer: Array<{ token: string; number: string; status: ShipmentHeader['status']; shippedAt: string | null }> = []
  try {
    const found = await findShipments(app, request, body)
    if (found && found.shipments.length > 0) {
      const system = systemCallerOf(request)(found.tenantId)
      for (const shipment of found.shipments) {
        const made = await makeTrackingLinks({ caller: system, delivery: system, email: processEmail(), clock: auth.clock, linkUrl: (token) => auth.link('/l', token), shipment, via: 'SEARCH', to: [], sender: null, createdById: SYSTEM_ACTOR_ID })
        const token = made.links[0] ? made.tokens.get(made.links[0].id) : undefined
        if (token) answer.push({ token, number: shipment.number, status: shipment.status, shippedAt: shipment.shippedAt ? toUtcIso(shipment.shippedAt) : null })
      }
    }
  } finally {
    const wait = TRACKING_LINK.searchAnswerFloorMs - (Date.now() - started)
    if (wait > 0) await pause(wait)
  }
  if (answer.length === 0) await guard.failed(request, 'public.lookup')
  request.log.info({ found: answer.length }, 'a tracking search')
  return { shipments: answer }
}
