import type { Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  HOLD_LIMITS,
  HOLD_REASON_WORDS,
  holdRefusalPath,
  placeProblems,
  placeRefusal,
  reasonsInForce,
  releasePermissionFor,
  releaseProblems,
  releaseRefusal,
  SHIPMENT_HOLD_REASONS,
  type HoldRefusalCode,
  type ShipmentHoldReason,
} from '@nexus/factory-domain/shipping/holds/holds'
import { SHIPPING_HOLDS_MANAGE } from '@nexus/factory-domain/shipping/holds/permissions'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import type { ShipmentStatus } from '@nexus/factory-domain/shipping/shipments'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { assertMay, mayOn, officeContextOf } from '../access'
import { readShipment } from '../store'
import { factsOf, holdView, lockShipmentRow, namesOf, placeHoldInCommand, readHolds, releaseHoldInCommand, type HoldRow, type LockedShipment } from './store'

/**
 * Hold and release a shipment (B-W2b-386; LOG-017, FIN-079; design warehouse.shipments: the selection row's "Hold" (W2b), the
 * record's ready check "W2b: no hold (credit, deposit or balance, quality, customer request)"; rules factory-domain
 * shipping/holds). Office only. shipping.view reads a shipment's holds (the words and who, inside this one record) and the
 * holds list (reasons and since when: no person in a list); shipping.holds.manage places them; releasing needs the
 * permission of the hold's kind (a money hold or the system's: shipping.holds.release). Rule 1: the dispatch desk works the
 * queue every day; a hold is no longer a note on the shipment.
 */

/** Refuses with the words and the code (`refusal/<CODE>`: the screens word it). */
function refused(code: HoldRefusalCode, message: string): never {
  throw new DomainError('conflict', message, [{ path: holdRefusalPath(code), message }])
}

const may = (context: OfficeContext, shipment: { companyId: string; siteId: string; partyId: string }) => (permission: Permission) => mayOn(context, permission, shipment)

/** The shipment the office may see (else 404). */
async function seenShipment(caller: CommandCaller, shipmentId: string) {
  const context = officeContextOf(caller)
  const shipment = await caller.withClient((client) => readShipment(client, shipmentId))
  assertMay(context, SHIPPING_VIEW, SHIPPING_VIEW, shipment)
  return { context, shipment: shipment! }
}

/** A shipment's holds as its record reads them. */
async function holdsView(caller: CommandCaller, context: OfficeContext, shipment: { id: string; number: string; status: string; companyId: string; siteId: string; partyId: string }) {
  return caller.withClient(async (client) => {
    const rows = await readHolds(client, [shipment.id])
    const names = await namesOf(client, rows.flatMap((row) => [row.placedById, row.releasedById]))
    const allowed = may(context, shipment)
    const views = rows.map((row) => ({ ...holdView(row, names), mayRelease: row.releasedAt === null && allowed(releasePermissionFor(row.reason as ShipmentHoldReason, row.placedById === null)) }))
    const inForce = views.filter((view) => view.inForce)
    return {
      shipmentId: shipment.id,
      number: shipment.number,
      status: shipment.status as ShipmentStatus,
      /** The ready check's "no hold": false while one is in force. */
      held: inForce.length > 0,
      reasons: reasonsInForce(rows.map(factsOf)),
      holds: [...inForce, ...views.filter((view) => !view.inForce)],
      mayPlace: (shipment.status === 'DRAFT' || shipment.status === 'PACKED') && allowed(SHIPPING_HOLDS_MANAGE),
      reasonChoices: SHIPMENT_HOLD_REASONS.map((reason) => ({ reason, words: HOLD_REASON_WORDS[reason], wordsRequired: reason === 'OTHER', releasedBy: releasePermissionFor(reason, false) })),
    }
  })
}
export type ShipmentHoldsView = Awaited<ReturnType<typeof holdsView>>

/** GET /shipping/shipments/:shipmentId/holds (shipping.view). */
export async function getHolds(caller: CommandCaller, shipmentId: string): Promise<{ holds: ShipmentHoldsView }> {
  const { context, shipment } = await seenShipment(caller, shipmentId)
  return { holds: await holdsView(caller, context, shipment) }
}

export interface PlaceBody {
  readonly reason: ShipmentHoldReason
  readonly words?: string | null | undefined
}

const bodyProblems = (issues: readonly Issue[], prefix = 'body'): Issue[] => issues.map((issue) => ({ path: `${prefix}/${issue.path}`, message: issue.message }))

/** Places a hold on one locked shipment, or the refusal (the shipment's holds read under its lock). */
async function placeOn(tools: Parameters<Parameters<typeof command>[2]>[0], shipment: LockedShipment, body: PlaceBody): Promise<{ holdId: string } | { code: HoldRefusalCode; message: string }> {
  const holds = (await readHolds(tools.tx, [shipment.id])).map(factsOf)
  const refusal = placeRefusal(shipment, body.reason, holds)
  if (refusal) return refusal
  return { holdId: await placeHoldInCommand(tools, shipment, { reason: body.reason, words: body.words ?? null, bySystem: false }) }
}

/** POST /shipping/shipments/:shipmentId/holds (shipping.holds.manage): the shipment on hold with a reason and words. */
export async function placeHold(caller: CommandCaller, shipmentId: string, body: PlaceBody, idempotencyKey?: string): Promise<{ holdId: string; holds: ShipmentHoldsView }> {
  const context = officeContextOf(caller)
  const found = await caller.withClient((client) => readShipment(client, shipmentId))
  assertMay(context, SHIPPING_VIEW, SHIPPING_HOLDS_MANAGE, found)
  const problems = placeProblems(body)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, bodyProblems(problems))
  const { result } = await command(caller, { name: 'shipping.placeHold', idempotencyKey, input: { shipmentId, ...body } }, async (tools) => {
    const shipment = await lockShipmentRow(tools.tx, found!.id)
    const outcome = await placeOn(tools, shipment, body)
    if ('code' in outcome) refused(outcome.code, outcome.message)
    return { holdId: outcome.holdId, shipment }
  })
  return { holdId: result.holdId, holds: await holdsView(caller, context, result.shipment) }
}

export interface ReleaseBody {
  readonly words: string
}

/**
 * POST /shipping/shipments/:shipmentId/holds/:holdId/release (shipping.holds.manage; a money hold or the system's also
 * shipping.holds.release): released with words.
 */
export async function releaseHold(caller: CommandCaller, shipmentId: string, holdId: string, body: ReleaseBody, idempotencyKey?: string): Promise<{ holds: ShipmentHoldsView }> {
  const context = officeContextOf(caller)
  const found = await caller.withClient((client) => readShipment(client, shipmentId))
  assertMay(context, SHIPPING_VIEW, SHIPPING_HOLDS_MANAGE, found)
  const problems = releaseProblems(body.words)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, bodyProblems(problems))
  const { result } = await command(caller, { name: 'shipping.releaseHold', idempotencyKey, input: { shipmentId, holdId, ...body } }, async (tools) => {
    const shipment = await lockShipmentRow(tools.tx, found!.id)
    const row: HoldRow | undefined = isUuid(holdId) ? (await readHolds(tools.tx, [shipment.id])).find((candidate) => candidate.id === holdId) : undefined
    if (!row) throw new NotFoundError('Hold not found.')
    const refusal = releaseRefusal(shipment.number, factsOf(row), may(context, shipment))
    if (refusal) refused(refusal.code, refusal.message)
    await releaseHoldInCommand(tools, shipment, row, { words: body.words, bySystem: false })
    return { shipment }
  })
  return { holds: await holdsView(caller, context, result.shipment) }
}

export interface PlaceManyBody extends PlaceBody {
  readonly shipmentIds: readonly string[]
}

/**
 * POST /shipping/holds (shipping.holds.manage; the queue's selection row "Hold"): the same hold on several shipments in ONE
 * command. A shipment the person may not hold is refused as a whole (403); one that left or is held for that reason
 * already is skipped and said why.
 */
export async function placeHolds(caller: CommandCaller, body: PlaceManyBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const ids = [...new Set(body.shipmentIds)]
  if (ids.length === 0 || ids.length > HOLD_LIMITS.bulk) throw new ValidationError(`Choose 1 to ${HOLD_LIMITS.bulk} shipments.`, [{ path: 'body/shipmentIds', message: `1 to ${HOLD_LIMITS.bulk} shipments.` }])
  const problems = placeProblems(body)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, bodyProblems(problems))
  const found = await caller.withClient((client) => client.shipment.findMany({ where: { id: { in: ids.filter(isUuid) } }, select: { id: true, companyId: true, siteId: true, partyId: true } }))
  const byId = new Map(found.map((row) => [row.id, row]))
  ids.forEach((id, index) => {
    const row = byId.get(id) ?? null
    if (!row || !mayOn(context, SHIPPING_VIEW, row)) throw new ValidationError('A chosen shipment is not one you may see.', [{ path: `body/shipmentIds/${index}`, message: 'Not a shipment you may see.' }])
  })
  for (const row of found) assertMay(context, SHIPPING_VIEW, SHIPPING_HOLDS_MANAGE, row)
  const { result } = await command(caller, { name: 'shipping.placeHolds', idempotencyKey, input: body }, async (tools) => {
    const placed: { shipmentId: string; number: string; holdId: string }[] = []
    const skipped: { shipmentId: string; number: string; code: HoldRefusalCode; message: string }[] = []
    for (const id of [...ids].sort()) {
      const shipment = await lockShipmentRow(tools.tx, id)
      const outcome = await placeOn(tools, shipment, body)
      if ('code' in outcome) skipped.push({ shipmentId: id, number: shipment.number, code: outcome.code, message: outcome.message })
      else placed.push({ shipmentId: id, number: shipment.number, holdId: outcome.holdId })
    }
    if (placed.length === 0) refused(skipped[0]!.code, skipped.length === 1 ? skipped[0]!.message : `None of the ${skipped.length} shipments could be held: ${skipped.map((row) => row.message).join(' ')}`)
    return { placed, skipped }
  })
  return result
}

export interface HoldsQuery {
  readonly siteId?: string | undefined
  readonly reason?: ShipmentHoldReason | undefined
  /** IN_FORCE (default): held shipments that have not left; RELEASED: holds released in the window; ALL. */
  readonly state?: 'IN_FORCE' | 'RELEASED' | 'ALL' | undefined
  readonly bySystem?: 'true' | 'false' | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/**
 * GET /shipping/holds (shipping.view): the holds the reader sees, newest first, with their shipment (number, status, order,
 * customer, site) — reasons, since when and whether the system placed them; never the words or a person (a list).
 */
export async function listHolds(caller: CommandCaller, query: HoldsQuery) {
  const context = officeContextOf(caller)
  const state = query.state ?? 'IN_FORCE'
  const where: Prisma.ShipmentHoldWhereInput = {
    AND: [
      { shipment: scopeWhere(actorOf(context), SHIPPING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.ShipmentWhereInput },
      state === 'IN_FORCE' ? { releasedAt: null, shipment: { status: { in: ['DRAFT', 'PACKED'] } } } : state === 'RELEASED' ? { releasedAt: { not: null } } : {},
      query.siteId ? { siteId: query.siteId } : {},
      query.reason ? { reason: query.reason } : {},
      query.bySystem === 'true' ? { placedById: null } : query.bySystem === 'false' ? { placedById: { not: null } } : {},
      query.cursor && isUuid(query.cursor) ? { id: { lt: query.cursor } } : {},
    ],
  }
  const rows = await caller.withClient((client) =>
    client.shipmentHold.findMany({
      where,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: {
        id: true,
        reason: true,
        placedAt: true,
        placedById: true,
        releasedAt: true,
        releasedById: true,
        shipment: { select: { id: true, number: true, status: true, companyId: true, siteId: true, partyId: true, salesOrder: { select: { id: true, number: true, customerRef: true, party: { select: { code: true, legalName: true } } } } } },
      },
    }),
  )
  const page = rows.slice(0, query.limit)
  const actor = actorOf(context)
  return {
    holds: page.map((row) => ({
      id: row.id,
      reason: row.reason as ShipmentHoldReason,
      inForce: row.releasedAt === null,
      bySystem: row.placedById === null,
      placedAt: toUtcIso(row.placedAt),
      releasedAt: row.releasedAt ? toUtcIso(row.releasedAt) : null,
      mayRelease: row.releasedAt === null && can(actor, releasePermissionFor(row.reason as ShipmentHoldReason, row.placedById === null), { companyId: row.shipment.companyId, siteId: row.shipment.siteId, partyId: row.shipment.partyId }),
      shipment: {
        id: row.shipment.id,
        number: row.shipment.number,
        status: row.shipment.status as ShipmentStatus,
        siteId: row.shipment.siteId,
        salesOrderId: row.shipment.salesOrder.id,
        salesOrderNumber: row.shipment.salesOrder.number,
        customerRef: row.shipment.salesOrder.customerRef,
        partyCode: row.shipment.salesOrder.party.code,
        partyName: row.shipment.salesOrder.party.legalName,
      },
    })),
    nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
  }
}
