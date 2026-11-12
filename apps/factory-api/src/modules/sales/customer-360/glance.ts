import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { HoldReason } from '@nexus/factory-domain/parties/holds/holds'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import type { RequirementKind, RequirementStage } from '@nexus/factory-domain/parties/requirements/requirements'
import type { PartyKind, PartyRole, PartyStatus } from '@nexus/factory-domain/parties/rules'
import { availableOf, overLimitBy, usedOf, usedPercent } from '@nexus/factory-domain/sales/credit/credit'
import { creditStateOf, daysLate, GLANCE_LIMITS, GLANCE_PARTS, latestProfiles, PART_PERMISSIONS, PROMISE_STATUSES, promisesOf, REPAIR_OPEN_STAGES, SAMPLE_OPEN_STAGES, type GlancePart } from '@nexus/factory-domain/sales/customer-360/glance'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { RepairKind, RepairStage } from '@nexus/factory-domain/sales/repairs/rules'
import { SALES_REPAIRS_VIEW } from '@nexus/factory-domain/sales/repairs/permissions'
import type { SampleKind, SampleStage } from '@nexus/factory-domain/sales/samples/rules'
import { SALES_SAMPLES_VIEW } from '@nexus/factory-domain/sales/samples/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { holdsInForce } from '../../parties/holds/holds'
import { contextOf, PARTY_SCOPE, readParty } from '../../parties/store'
import { readCredit, type Reader } from '../credit/reading'

/**
 * GET /sales/customer-360/:partyId?companyId= (B-W2b-324; SAL-019 "Customer 360 page"; design sales.customers record ›
 * Overview: Key numbers, Now, the side panel; rules factory-domain sales/customer-360/glance). parties.view over the
 * customer (the route); the company is the query's or the screen's (`x-factory-company`), one the reader sees the
 * customer in. In ONE read: the account holds in force (the status pill's hold reason), the requirements in force with
 * the company, the open orders' promises (orders.view), free credit (sales.credit.view; amounts with the price grain),
 * sample rounds in progress (sales.samples.view), the measurement profiles kept for the customer (sales.measurements.view;
 * never the measurements), a team's riders and a rider's team (parties.view), repairs and alterations in progress
 * (sales.repairs.view). A part without its permission is null and named in `withheld`; rows are filtered by each
 * permission's own scope (scopeWhere). W1's quotes and orders and W2a's money late and returns stay their own reads.
 */

const label = (party: { tradeName: string | null; legalName: string }) => party.tradeName ?? party.legalName

function officeOf(caller: CommandCaller): OfficeContext {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

export async function readGlance(caller: CommandCaller, partyId: string, query: { readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  const party = await readParty(caller, partyId)
  const companyId = query.companyId ?? context.companyId
  if (!companyId) throw new ValidationError('Name the company the customer is seen in.', [{ path: 'query/companyId', message: 'Expected one of our companies.' }])
  const actor = actorOf(context)
  const at = { companyId, partyId: party.id }
  if (!can(actor, PARTIES_VIEW, at)) throw new ValidationError('Not a company you may see this customer in.', [{ path: 'query/companyId', message: 'Expected a company you see the customer in.' }])
  if (party.companyId !== null && party.companyId !== companyId) {
    throw new ValidationError(`${party.code} is a customer of another company.`, [{ path: 'query/companyId', message: "Expected the customer's own company." }])
  }
  const may = (permission: Permission) => can(actor, permission, at)
  const allowed = (part: GlancePart) => PART_PERMISSIONS[part].every(may)
  const now = serverClock.now()
  const today = businessDate(now)

  return caller.withClient(async (db) => {
    const company = await db.company.findUniqueOrThrow({ where: { id: companyId }, select: { id: true, code: true, legalName: true, tradeName: true } })
    const team = party.kind === 'PERSON' ? await teamOf(db, context, party.id) : null
    return {
      party: { id: party.id, code: party.code, name: label(party), kind: party.kind as PartyKind, roles: party.roles as PartyRole[], status: party.status as PartyStatus },
      company: { id: company.id, code: company.code, name: label(company) },
      hold: await holdOf(db, party.id, companyId),
      team,
      requirements: await requirementsOf(db, context, party.id, companyId),
      promises: allowed('promises') ? await promisesFor(db, context, party.id, companyId, today) : null,
      credit: allowed('credit') ? await creditOf(db, party.id, companyId, now) : null,
      samples: allowed('samples') ? await samplesOf(db, context, party.id, companyId, today) : null,
      profiles: allowed('profiles') ? await profilesOf(db, party.id) : null,
      riders: party.kind === 'ORGANISATION' ? await ridersOf(db, context, party.id, companyId) : null,
      repairs: allowed('repairs') ? await repairsOf(db, context, party.id, companyId) : null,
      withheld: GLANCE_PARTS.filter((part) => !allowed(part)),
      readAt: toUtcIso(now),
    }
  })
}

/** The holds in force for the company, the oldest first, with who placed them (null: the system). */
async function holdOf(db: Reader, partyId: string, companyId: string) {
  const rows = await holdsInForce(db, partyId, companyId)
  const people = [...new Set(rows.flatMap((row) => (row.placedById ? [row.placedById] : [])))]
  const names = new Map((people.length > 0 ? await db.user.findMany({ where: { id: { in: people } }, select: { id: true, displayName: true } }) : []).map((row) => [row.id, row.displayName]))
  const holds = rows.map((row) => ({
    id: row.id,
    reason: row.reason as HoldReason,
    words: row.words,
    everyCompany: row.companyId === null,
    placedAt: toUtcIso(row.placedAt),
    placedBy: row.placedById ? (names.get(row.placedById) ?? null) : null,
  }))
  return { onHold: holds.length > 0, holds }
}

/** A rider's team or dealer, when the reader may see it. */
async function teamOf(db: Reader, context: OfficeContext, partyId: string) {
  const rider = await db.party.findUniqueOrThrow({ where: { id: partyId }, select: { teamPartyId: true } })
  if (!rider.teamPartyId) return null
  const team = await db.party.findUnique({ where: { id: rider.teamPartyId }, select: { id: true, code: true, legalName: true, tradeName: true, status: true, companyId: true } })
  if (!team || !can(actorOf(context), PARTIES_VIEW, { companyId: team.companyId, partyId: team.id })) return null
  return { id: team.id, code: team.code, name: label(team), status: team.status as PartyStatus }
}

/** The customer's requirements in force with the company (its own and every company's), the newest first. */
async function requirementsOf(db: Reader, context: OfficeContext, partyId: string, companyId: string) {
  const where: Prisma.CustomerRequirementWhereInput = { partyId, active: true, OR: [{ companyId }, { companyId: null }] }
  const actor = actorOf(context)
  const rows = (await db.customerRequirement.findMany({ where, select: { id: true, companyId: true, kind: true, words: true, appliesAt: true, styleIds: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })).filter(
    (row) => row.companyId === null || can(actor, PARTIES_VIEW, { companyId: row.companyId, partyId }),
  )
  return {
    count: rows.length,
    rows: rows.slice(0, GLANCE_LIMITS.requirements).map((row) => ({
      id: row.id,
      kind: row.kind as RequirementKind,
      words: row.words,
      appliesAt: row.appliesAt as RequirementStage[],
      everyStyle: row.styleIds.length === 0,
      everyCompany: row.companyId === null,
    })),
  }
}

/** The open orders' promises with the company (orders.view's own scope). */
async function promisesFor(db: Reader, context: OfficeContext, partyId: string, companyId: string, today: string) {
  const orders = await db.salesOrder.findMany({
    where: { AND: [scopeWhere(actorOf(context), ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput, { partyId, companyId, status: { in: [...PROMISE_STATUSES] } }] },
    select: { promiseDate: true },
  })
  return promisesOf(
    orders.map((order) => ({ promiseDate: order.promiseDate ? order.promiseDate.toISOString().slice(0, 10) : null })),
    today,
  )
}

/** Free credit with the company now (B-W2b-304's reading): NONE without a limit. */
async function creditOf(db: Reader, partyId: string, companyId: string, now: Date) {
  const reading = await readCredit(db, { partyId, companyId, now })
  if (!reading) {
    const none = asMoney('price', null)
    return { state: 'NONE' as const, currency: null, limit: none, used: none, available: none, overLimitBy: none, overdue: none, usedPct: null, onHold: false }
  }
  const available = availableOf(reading)
  return {
    state: creditStateOf({ limit: reading.limit, available }),
    currency: reading.currency,
    limit: asMoney('price', reading.limit),
    used: asMoney('price', usedOf(reading)),
    available: asMoney('price', available),
    overLimitBy: asMoney('price', overLimitBy(reading)),
    overdue: asMoney('price', reading.overdue),
    usedPct: usedPercent(reading),
    onHold: reading.onHold,
  }
}

/** Sample rounds of the customer with the company in progress, the earliest due first (none last). */
async function samplesOf(db: Reader, context: OfficeContext, partyId: string, companyId: string, today: string) {
  const where: Prisma.SampleRoundWhereInput = {
    AND: [scopeWhere(actorOf(context), SALES_SAMPLES_VIEW, { company: 'companyId', party: { field: 'partyId', nullable: true } }) as Prisma.SampleRoundWhereInput, { partyId, companyId, stage: { in: [...SAMPLE_OPEN_STAGES] } }],
  }
  const [count, rows] = [
    await db.sampleRound.count({ where }),
    await db.sampleRound.findMany({
      where,
      select: { id: true, number: true, kind: true, roundNo: true, stage: true, dueDate: true, style: { select: { id: true, code: true, name: true } } },
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }],
      take: GLANCE_LIMITS.rows,
    }),
  ]
  return {
    count,
    rows: rows.map((row) => {
      const due = row.dueDate ? row.dueDate.toISOString().slice(0, 10) : null
      return { id: row.id, number: row.number, kind: row.kind as SampleKind, roundNo: row.roundNo, stage: row.stage as SampleStage, style: row.style, dueDate: due, daysLate: daysLate(due, today) }
    }),
  }
}

/** The customer's measurement profiles, the newest revision per rider and garment type (never the measurements). */
async function profilesOf(db: Reader, partyId: string) {
  const rows = await db.measurementProfile.findMany({ where: { partyId }, select: { id: true, partyId: true, riderName: true, garmentType: true, revision: true, baseSize: true, takenAt: true } })
  const latest = latestProfiles(rows.map((row) => ({ ...row, takenAt: toUtcIso(row.takenAt) })))
  return { count: latest.length, rows: latest.slice(0, GLANCE_LIMITS.profiles).map((row) => ({ id: row.id, riderName: row.riderName, garmentType: row.garmentType, revision: row.revision, baseSize: row.baseSize, takenAt: row.takenAt })) }
}

/** A team's or dealer's riders the reader may see, with how many measurement profiles each has. */
async function ridersOf(db: Reader, context: OfficeContext, partyId: string, companyId: string) {
  const where: Prisma.PartyWhereInput = { AND: [{ teamPartyId: partyId }, scopeWhere(actorOf(context), PARTIES_VIEW, PARTY_SCOPE) as Prisma.PartyWhereInput] }
  const count = await db.party.count({ where })
  if (count === 0) return { count: 0, rows: [] }
  const riders = await db.party.findMany({ where, select: { id: true, code: true, legalName: true, tradeName: true, status: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: GLANCE_LIMITS.riders })
  const mayProfiles = can(actorOf(context), SALES_MEASUREMENTS_VIEW, { companyId, partyId })
  const counts = mayProfiles ? await db.measurementProfile.groupBy({ by: ['partyId'], where: { partyId: { in: riders.map((rider) => rider.id) } }, _count: { _all: true } }) : []
  const byRider = new Map(counts.map((row) => [row.partyId, row._count._all]))
  return { count, rows: riders.map((rider) => ({ id: rider.id, code: rider.code, name: label(rider), status: rider.status as PartyStatus, profiles: byRider.get(rider.id) ?? 0 })) }
}

/** Repairs and alterations of the customer with the company in progress, the newest first. */
async function repairsOf(db: Reader, context: OfficeContext, partyId: string, companyId: string) {
  const where: Prisma.RepairOrderWhereInput = {
    AND: [scopeWhere(actorOf(context), SALES_REPAIRS_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.RepairOrderWhereInput, { partyId, companyId, stage: { in: [...REPAIR_OPEN_STAGES] } }],
  }
  const count = await db.repairOrder.count({ where })
  const rows = await db.repairOrder.findMany({ where, select: { id: true, number: true, kind: true, stage: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: GLANCE_LIMITS.rows })
  return { count, rows: rows.map((row) => ({ id: row.id, number: row.number, kind: row.kind as RepairKind, stage: row.stage as RepairStage, createdAt: toUtcIso(row.createdAt) })) }
}

export type CustomerGlance = Awaited<ReturnType<typeof readGlance>>
