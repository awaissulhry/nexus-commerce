import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { OFFICE_DRAFT_WORDS } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Actor, Permission } from '@nexus/factory-domain/core/permissions'
import { partnerLocaleOf } from '@nexus/factory-domain/threads/partner/rules'
import { actorOf, type OfficeContext } from '../../../core/context'
import { assertMay, assertSees, officeContextOf, type OrderScope } from '../orders/access'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions' // owb- po2.4
import { portalReader } from '../portal-orders/access'
import { readRequest, type RequestRow } from './store'

/**
 * od-s s.2 (order start, 13-backend § 2; Owner yes 1a): who writes a draft order. ONE draft (PortalOrderRequest) is filled from two
 * doors through the SAME draft commands (./requests.ts, ./draft-files.ts); each command takes the writer instead of reading the
 * portal session itself.
 *
 *   portal   the customer's portal session (portalWriter): reads and commands in the partner scope (its party's rows only, row-level
 *            security), the portal's company; the tenant's rows (the catalogue, made to measure, names) in the office scope as the
 *            person. Exactly today's reader: nothing changes for the portal.
 *   office   an office person with orders.manage (orders.view to read) over the draft's company AND its customer (officeWriter:
 *            can() first — a customer out of reach is not found). Reads and commands in the tenant's office scope, so every
 *            party read of a draft command names the writer's party itself (W1: the delivery addresses, the default ship-to, the
 *            20-draft cap, the header's address check), and a draft of another customer is not found even by its id.
 *
 * Money: `seesPrices` (the person's price grain) shapes only the ANSWER (the grain filter drops every marked field anyway);
 * `stampsPrices` says whether a new catalogue line takes the customer's list price today as the price it was shown (W4: the
 * portal stamps only for a person who sees prices — today's rule; the office always stamps, so a Buyer who reads prices is never
 * asked to confirm a price the office's line left empty; a no-price reader never sees it).
 */

export interface DraftWriter {
  readonly door: 'portal' | 'office'
  readonly app: FastifyInstance
  /** The caller every read and command of the draft runs as: portal — the partner scope; office — the tenant's office scope. */
  readonly request: FastifyRequest
  readonly tenantId: string
  /** The draft's company (portal: the portal's; office: the draft's, or the one the office starts it in). */
  readonly companyId: string
  /** The draft's customer (portal: the session's party; office: the customer can() was checked over). */
  readonly partyId: string
  /** The person who saves (portal: the portal person; office: the office person). */
  readonly userId: string
  readonly actor: Actor
  /** The person's price grain: what the answer may show. */
  readonly seesPrices: boolean
  /** Whether a new catalogue line takes the list price today as its price shown (portal: = seesPrices; office: always). */
  readonly stampsPrices: boolean
  /** The words of a refusal said to this person (the portal person's language; the office: English, its words are the web's). */
  readonly locale: 'it' | 'en'
  /** An office preview of the portal (it writes nothing). Always false for the office. */
  readonly preview: boolean
  /** A read in the writer's own scope (portal: its party's rows; office: the tenant's). */
  scoped<T>(work: (client: FactoryClient) => Promise<T>): Promise<T>
  /** A read of the tenant's rows (portal: the office scope as the portal person; office: its own scope). */
  inTenant<T>(work: (client: FactoryClient) => Promise<T>): Promise<T>
}

/** The portal's writer: today's reader (the session, its party, its company, its price grain), nothing else. */
export function portalWriter(app: FastifyInstance, request: FastifyRequest): DraftWriter {
  const reader = portalReader(app, request)
  const { session } = reader
  return {
    door: 'portal',
    app,
    request,
    tenantId: session.tenantId,
    companyId: session.company.id,
    partyId: session.partyId,
    userId: session.userId,
    actor: reader.actor,
    seesPrices: reader.seesPrices,
    stampsPrices: reader.seesPrices,
    locale: partnerLocaleOf(session.person.locale),
    preview: session.preview,
    scoped: (work) => request.withClient(work),
    inTenant: (work) => reader.inTenant(work),
  }
}

/**
 * The office's writer over a draft's company and customer: `permission` (orders.manage to write, orders.view to read) checked with
 * can() first — out of reach is "Order request not found." (404), in reach without the permission is 403.
 */
export function officeWriter(app: FastifyInstance, request: FastifyRequest, scope: OrderScope, permission: Permission): DraftWriter {
  const context = officeContextOf(request)
  assertMay(context, permission, scope, 'Order request')
  return officeWriterOf(app, request, context, scope)
}

/** The office writer's own shape over a scope already checked (officeWriter, officeDraftReader). */
function officeWriterOf(app: FastifyInstance, request: FastifyRequest, context: OfficeContext, scope: OrderScope): DraftWriter {
  const actor = actorOf(context)
  return {
    door: 'office',
    app,
    request,
    tenantId: context.tenantId,
    companyId: scope.companyId,
    partyId: scope.partyId,
    userId: context.actorId,
    actor,
    seesPrices: heldGrains(actor).has('price'),
    stampsPrices: true,
    locale: 'en',
    preview: false,
    scoped: (work) => request.withClient(work),
    inTenant: (work) => request.withClient(work),
  }
}

/**
 * Money wall (13-backend § 2): the customer's own price ("Your price", `brandUnitPrice`) is typed by the customer only — an office
 * body that sends it is refused (400, in words), even from a person with the price grain (without it the grain filter says 403 first).
 */
export function refuseOwnPrice(body: unknown, at: string): void {
  const own = (value: unknown): boolean => typeof value === 'object' && value !== null && (value as { brandUnitPrice?: unknown }).brandUnitPrice !== undefined
  const line = typeof body === 'object' && body !== null ? (body as { line?: unknown }).line : undefined
  if (own(body) || own(line)) {
    const path = own(line) ? `${at}/line/brandUnitPrice` : `${at}/brandUnitPrice`
    throw new ValidationError(OFFICE_DRAFT_WORDS.OWN_PRICE.en, [{ path, message: OFFICE_DRAFT_WORDS.OWN_PRICE.en }])
  }
}

/**
 * owb- po2.4 (S2's ask; R20): the office's READER of ONE draft (GET /sales/order-requests/:id/draft): orders.view over it, or
 * orders.view.own while the reader is on it (S2's ONE rule, `assertSees`) — else not found. It reads only (no command takes it).
 */
export async function officeDraftReader(app: FastifyInstance, request: FastifyRequest, requestId: string): Promise<{ readonly writer: DraftWriter; readonly row: RequestRow }> {
  const context = officeContextOf(request)
  const row = isUuid(requestId) ? await request.withClient((client) => readRequest(client, requestId)) : null
  if (!row) throw new NotFoundError('Order request not found.')
  const scope = { companyId: row.companyId, partyId: row.partyId }
  await request.withClient((client) => assertSees(client, context, ORDERS_VIEW, scope, { requestId: row.id }, 'Order request'))
  return { writer: officeWriterOf(app, request, context, scope), row }
}

/** The office's writer of ONE draft: the request read in the office scope (none: 404), then officeWriter over its company and customer. */
export async function officeDraftWriter(app: FastifyInstance, request: FastifyRequest, requestId: string, permission: Permission): Promise<{ readonly writer: DraftWriter; readonly row: RequestRow }> {
  officeContextOf(request)
  const row = isUuid(requestId) ? await request.withClient((client) => readRequest(client, requestId)) : null
  if (!row) throw new NotFoundError('Order request not found.')
  return { writer: officeWriter(app, request, { companyId: row.companyId, partyId: row.partyId }, permission), row }
}
