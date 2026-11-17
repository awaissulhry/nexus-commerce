import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { assertOneParty, sharesPerParty, supervisorChangedEvent, type PartyOrder } from '@nexus/factory-domain/production-brand/events'
import { PRODUCTION_BRAND_MANAGE } from '@nexus/factory-domain/production-brand/permissions'
import { backupProblems, effectiveSupervisor } from '@nexus/factory-domain/production-brand/supervisor'
import { NOT_IN_PRODUCTION_WORDS } from '@nexus/factory-domain/production-brand/words'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { lockParty, settingsOf } from '../../../platform/auth/partners/store'
import { KEEPER_ORDER_STATES } from '../brand/facts'
import { officeContextOf } from '../work-orders/access'
import { PICK_LIST_MAX } from './contract'
import {
  candidateOf,
  customerCompanies,
  isCustomer,
  personProblems,
  personRefusals,
  reachesEvery,
  reachesSome,
  readCustomer,
  refusalIssues,
  refusalsOver,
  scopesOf,
  ELIGIBILITY_WORDS,
  type CustomerRow,
  type CustomerScope,
} from './eligible'
import { brandProductionKey, customerDefaultsOf, type Reader } from './resolver'

/**
 * B-PR-42a — the production supervisor, set and read (production plan §3 "Supervisor"; lead picks L21, L22; review fixes R-41,
 * R-48, R-53, R-56, R-57, R-58; the Owner's point N3: "assign a certain person, a supervisor who's in charge of production for a
 * suit for a specific brand"; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand.
 * But we, as the production unit, should be able to see it all. And manage it all as well."). The Inquiry assignee's pattern:
 * a User foreign key (Restrict: a person is made inactive, never deleted), both-or-neither with since when, an audit row, an
 * event.
 *
 *   GET  /production/supervisors?partyId&companyId?   the pick list: ACTIVE office people eligible there (./eligible), by name
 *                                                     only, at most 500 read; production.brand.manage over the company (or
 *                                                     every company of the customer) AND the customer, else 404 — a person
 *                                                     limited to another customer never learns this one exists (PW-14)
 *   PUT  /production/brands/:partyId/supervisor      the customer's default supervisor and backup {supervisorId|null,
 *                                                     backupId|null, version}: production.brand.manage over every company of
 *                                                     the customer; the PortalSettings row is made when the customer has
 *                                                     none, with the portal OFF (R-53: a supervisor needs no portal — no
 *                                                     sign-in, no portal person, no code is made); one audit row and one
 *                                                     brand_production.supervisor_changed (scope BRAND, no order named: the
 *                                                     default moves every order without its own — B-PR-42b's worker moves the
 *                                                     follows, never this request)
 *   POST /production/orders/supervisor               an order's own supervisor, 1 to 100 orders of one or several customers
 *                                                     {orderIds, supervisorId|null} (null: back to the customer's default):
 *                                                     production.brand.manage per order; each order the caller sees is
 *                                                     changed, unchanged or skipped with why (another customer's that the
 *                                                     caller does not see: counted, never named — sales orders-depth
 *                                                     priority.ts's pattern); one audit row and one supervisor_changed per
 *                                                     customer and company of the changed orders, each with its own batch
 *
 * The person is checked when newly named (./eligible: ACTIVE office, production.brand.manage or workorders.view over the company
 * AND the customer, sales.measurements.view, reads its order threads); one named already stays named even if made inactive
 * since (the record reads "no longer active"). The customer is never told who (R-41): the event is office only and no portal
 * read carries these columns (PortalSettings has no partner grant; BrandOrderProduction.supervisorId is hidden from the partner).
 */

const CUSTOMER_NOT_FOUND = 'Customer not found.'
const ORDER_NOT_FOUND = 'Sales order not found.'
const NOT_THE_PERSON = (path: string, refusals: ReturnType<typeof personRefusals>): ValidationError => {
  const issues = refusalIssues(refusals, path)
  return new ValidationError(issues[0]!.message, issues)
}

/** The office person as a dialog shows them: name and active. */
async function personOf(db: Reader, userId: string | null): Promise<{ id: string; name: string; active: boolean } | null> {
  if (userId === null) return null
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true, status: true } })
  return { id: userId, name: user?.displayName ?? '', active: user?.status === 'ACTIVE' }
}

/** How many of the customer's open orders have no supervisor of their own (a new default moves them). */
async function ordersOnDefault(db: Reader, partyId: string): Promise<number> {
  return db.brandOrderProduction.count({ where: { partyId, supervisorId: null, salesOrder: { status: { in: [...KEEPER_ORDER_STATES] } } } })
}

/** The customer the caller reaches (production.brand.manage or workorders.view at some of its companies), else not found. */
async function reachedCustomer(db: Reader, actor: Actor, partyId: string): Promise<{ party: CustomerRow; scopes: CustomerScope[] }> {
  const party = await readCustomer(db, partyId)
  const scopes = party ? scopesOf(await customerCompanies(db, party), party.id) : []
  if (!party || !(reachesSome(actor, PRODUCTION_BRAND_MANAGE, scopes) || reachesSome(actor, WORKORDERS_VIEW, scopes))) throw new NotFoundError(CUSTOMER_NOT_FOUND)
  return { party, scopes }
}

// ---- the pick list ----------------------------------------------------------------------------------------------------------

/** GET /production/supervisors?partyId&companyId?: who may supervise this customer's production there (names only). */
export async function supervisorPickList(caller: CommandCaller, query: { readonly partyId: string; readonly companyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const party = await readCustomer(db, query.partyId)
    // A company named must be one of the tenant's, and the customer's own when it has one; its people are read only by who
    // manages the customer there (else 404, the words of an unknown customer).
    const named = query.companyId === undefined ? null : await db.company.findUnique({ where: { id: query.companyId }, select: { id: true } })
    const companies = party === null ? [] : query.companyId !== undefined ? (named !== null && (party.companyId === null || party.companyId === named.id) ? [named.id] : []) : await customerCompanies(db, party)
    const scopes = party ? scopesOf(companies, party.id) : []
    if (!party || !reachesEvery(actor, PRODUCTION_BRAND_MANAGE, scopes)) throw new NotFoundError(CUSTOMER_NOT_FOUND)
    const users = await db.user.findMany({ where: { status: 'ACTIVE', audience: 'OFFICE' }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: PICK_LIST_MAX, select: { id: true } })
    const people: { id: string; name: string; me: boolean }[] = []
    for (const user of users) {
      const candidate = await candidateOf(db, context.tenantId, user.id, now)
      if (candidate && refusalsOver(candidate, scopes).length === 0) people.push({ id: candidate.id, name: candidate.name, me: candidate.id === context.actorId })
    }
    return { people, complete: users.length < PICK_LIST_MAX, ordersOnDefault: isCustomer(party) ? await ordersOnDefault(db, party.id) : 0 }
  })
}

// ---- the customer's default and backup ------------------------------------------------------------------------------------

export interface CustomerSupervisorBody {
  readonly supervisorId: string | null
  readonly backupId: string | null
  readonly version: number
}

async function customerAnswer(db: Reader, partyId: string) {
  const settings = await settingsOf(db, partyId)
  return {
    customer: {
      partyId,
      supervisor: await personOf(db, settings.productionSupervisorId),
      backup: await personOf(db, settings.productionBackupId),
      version: settings.version,
      ordersOnDefault: await ordersOnDefault(db, partyId),
    },
  }
}

/** PUT /production/brands/:partyId/supervisor (see the file's head). */
export async function setCustomerSupervisor(caller: CommandCaller, partyId: string, body: CustomerSupervisorBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const { party, scopes } = await caller.withClient((db) => reachedCustomer(db, actor, partyId))
  // The default moves the customer's orders at every one of its companies: set by who manages it at all of them.
  if (!reachesEvery(actor, PRODUCTION_BRAND_MANAGE, scopes)) throw new ForbiddenError("Your role does not set this customer's production supervisor at every company it works with.")
  if (!isCustomer(party)) {
    const message = 'A production supervisor is set only for a customer or a brand.'
    throw new DomainError('conflict', message, [{ path: 'params/partyId', message }])
  }
  const shape = backupProblems(body)
  if (shape.length > 0) throw new ValidationError(shape[0]!.message, shape)
  const { result } = await command(caller, { name: 'production.setCustomerSupervisor', idempotencyKey, input: { partyId, ...body } }, async (tools) => {
    await lockParty(tools.tx, party.id)
    const before = await settingsOf(tools.tx, party.id)
    if (body.version !== before.version) throw new StaleVersionError('PortalSettings', party.id, before.version, body.version)
    const supervisorMoved = body.supervisorId !== before.productionSupervisorId
    const backupMoved = body.backupId !== before.productionBackupId
    if (!supervisorMoved && !backupMoved) throw new InvalidStateError('Nothing changes: these are the supervisor and the backup already.')
    // A person newly named in a slot is checked (one named already stays, even if made inactive since).
    const problems: Issue[] = []
    if (supervisorMoved && body.supervisorId !== null) problems.push(...(await personProblems(tools.tx, context.tenantId, body.supervisorId, scopes, tools.now, 'body/supervisorId')))
    if (backupMoved && body.backupId !== null) problems.push(...(await personProblems(tools.tx, context.tenantId, body.backupId, scopes, tools.now, 'body/backupId')))
    if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
    const data = {
      productionSupervisorId: body.supervisorId,
      ...(supervisorMoved ? { productionSupervisorSetAt: body.supervisorId === null ? null : tools.now } : {}),
      productionBackupId: body.backupId,
    }
    if (before.exists) {
      await tools.tx.portalSettings.update({ where: { id: party.id }, data: { ...data, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
    } else {
      // One row per party, its id the party's (B-W2b-152); the portal stays OFF (R-53: a supervisor needs no portal).
      await tools.tx.portalSettings.create({ data: { id: party.id, partyId: party.id, portalOn: false, ...data, productionSupervisorSetAt: body.supervisorId === null ? null : tools.now, createdAt: tools.now, createdById: context.actorId }, select: { id: true } })
    }
    const batchId = newId()
    tools.audit({
      recordType: 'PortalSettings',
      recordId: party.id,
      companyId: party.companyId,
      before: before.exists ? { productionSupervisorId: before.productionSupervisorId, productionBackupId: before.productionBackupId } : null,
      after: { productionSupervisorId: body.supervisorId, productionBackupId: body.backupId, batchId, ...(before.exists ? {} : { portalOn: false, made: 'portal settings made with the portal off' }) },
    })
    const previousIds = [...new Set([before.productionSupervisorId, before.productionBackupId].filter((userId): userId is string => userId !== null))]
    // One customer, no order named (the default moves every order without its own).
    const event = supervisorChangedEvent({ companyId: party.companyId, partyId: party.id, orderIds: [] }, { supervisorId: body.supervisorId, previousIds, backupId: body.backupId, scope: 'BRAND', batchId })
    assertOneParty(event.payload, new Map())
    tools.emit(event)
    return customerAnswer(tools.tx, party.id)
  })
  return result
}

// ---- an order's own supervisor, one or many -------------------------------------------------------------------------------

export interface OrderSupervisorsBody {
  readonly orderIds: readonly string[]
  readonly supervisorId: string | null
}

interface OrderRow extends PartyOrder {
  readonly number: string
}

/** The caller sees the order (its company AND customer) with workorders.view or production.brand.manage. */
const seesOrder = (actor: Actor, row: { readonly companyId: string; readonly partyId: string }): boolean =>
  can(actor, WORKORDERS_VIEW, { companyId: row.companyId, partyId: row.partyId }) || can(actor, PRODUCTION_BRAND_MANAGE, { companyId: row.companyId, partyId: row.partyId })

/** The keeper's own lock of an order (modules/production/brand keeper and health): a supervisor change never crosses a keeper pass. */
const lockOrder = (tools: CommandTools, orderId: string) => tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.brand-keeper', ${orderId}::uuid), 0))`

/** POST /production/orders/supervisor (see the file's head). */
export async function setOrderSupervisors(caller: CommandCaller, body: OrderSupervisorsBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const ids = [...new Set(body.orderIds)]
  if (ids.some((orderId) => !isUuid(orderId))) throw new ValidationError('Sales order ids only.', [{ path: 'body/orderIds', message: 'Sales order ids only.' }])
  const rows: OrderRow[] = await caller.withClient((db) =>
    db.salesOrder.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, companyId: true, partyId: true }, orderBy: [{ number: 'asc' }, { id: 'asc' }] }),
  ).then((found) => found.map((row) => ({ orderId: row.id, number: row.number, companyId: row.companyId, partyId: row.partyId })))
  // Another customer's order the caller does not reach is as unknown: counted, never named.
  const visible = rows.filter((row) => seesOrder(actor, row))
  if (visible.length === 0) throw new NotFoundError(ORDER_NOT_FOUND)
  const { result } = await command(caller, { name: 'production.setOrderSupervisors', idempotencyKey, input: { orderIds: ids, supervisorId: body.supervisorId } }, async (tools) => {
    const candidate = body.supervisorId === null ? null : await candidateOf(tools.tx, context.tenantId, body.supervisorId, tools.now)
    // The person themselves (no such office person, or no longer active): nothing is changed for anybody.
    if (body.supervisorId !== null) {
      const refused = personRefusals(candidate)
      if (refused.length > 0) throw NOT_THE_PERSON('body/supervisorId', refused)
    }
    // The keeper's locks, in one order (no two commands wait on each other).
    for (const orderId of visible.map((row) => row.orderId).sort()) await lockOrder(tools, orderId)
    const states = new Map(
      (await tools.tx.brandOrderProduction.findMany({ where: { key: { in: visible.map((row) => brandProductionKey(row.orderId)) } }, select: { id: true, salesOrderId: true, supervisorId: true } })).map((row) => [row.salesOrderId, row]),
    )
    const statuses = new Map((await tools.tx.salesOrder.findMany({ where: { id: { in: visible.map((row) => row.orderId) } }, select: { id: true, status: true } })).map((row) => [row.id, row.status]))
    const defaults = await customerDefaultsOf(tools.tx, visible.map((row) => row.partyId))
    const changed: { row: OrderRow; before: string | null; previous: string | null }[] = []
    const unchanged: { orderId: string; number: string }[] = []
    const skipped: { orderId: string; number: string; why: string }[] = []
    const skip = (row: OrderRow, why: string) => skipped.push({ orderId: row.orderId, number: row.number, why })
    for (const row of visible) {
      if (!can(actor, PRODUCTION_BRAND_MANAGE, { companyId: row.companyId, partyId: row.partyId })) {
        skip(row, "Your role does not set this order's production supervisor.")
        continue
      }
      const status = statuses.get(row.orderId) ?? ''
      if (!(KEEPER_ORDER_STATES as readonly string[]).includes(status)) {
        skip(row, NOT_IN_PRODUCTION_WORDS.en)
        continue
      }
      const state = states.get(row.orderId)
      if (!state) {
        skip(row, 'This order has no production state yet: it is made when the order is confirmed. Try again in a moment.')
        continue
      }
      if (state.supervisorId === body.supervisorId) {
        unchanged.push({ orderId: row.orderId, number: row.number })
        continue
      }
      if (candidate) {
        const refused = refusalsOver(candidate, [{ companyId: row.companyId, partyId: row.partyId }])
        if (refused.length > 0) {
          skip(row, ELIGIBILITY_WORDS[refused[0]!].en)
          continue
        }
      }
      await tools.tx.brandOrderProduction.update({
        where: { id: state.id },
        data: { supervisorId: body.supervisorId, supervisorAssignedAt: body.supervisorId === null ? null : tools.now, updatedAt: tools.now, version: { increment: 1 } },
        select: { id: true },
      })
      changed.push({ row, before: state.supervisorId, previous: effectiveSupervisor(state.supervisorId, defaults.get(row.partyId)?.supervisorId ?? null).userId })
    }
    // R-48: one audit row and one event per customer and company, each with its own batch; each names only its own orders.
    const partyOf = new Map(changed.map(({ row }) => [row.orderId, row.partyId]))
    for (const share of sharesPerParty(changed.map(({ row }) => row))) {
      const own = changed.filter(({ row }) => share.orderIds.includes(row.orderId))
      const batchId = newId()
      tools.audit({
        recordType: 'Party',
        recordId: share.partyId,
        companyId: share.companyId,
        before: { orders: own.map(({ row, before }) => ({ orderId: row.orderId, number: row.number, supervisorId: before })) },
        after: { scope: 'ORDER', orderIds: [...share.orderIds], supervisorId: body.supervisorId, ...(body.supervisorId === null ? {} : { supervisorAssignedAt: toUtcIso(tools.now) }), batchId },
      })
      const previousIds = [...new Set(own.flatMap(({ previous }) => (previous !== null ? [previous] : [])))]
      const event = supervisorChangedEvent(share, { supervisorId: body.supervisorId, previousIds, backupId: null, scope: 'ORDER', batchId })
      assertOneParty(event.payload, partyOf)
      tools.emit(event)
    }
    // Nothing changed: still one audit row per customer and company seen, with its own counts only (every write is audited).
    if (changed.length === 0) {
      for (const share of sharesPerParty(visible)) {
        const mine = (orderId: string) => share.orderIds.includes(orderId)
        tools.audit({
          recordType: 'Party',
          recordId: share.partyId,
          companyId: share.companyId,
          after: { scope: 'ORDER', changed: 0, unchanged: unchanged.filter((row) => mine(row.orderId)).length, skipped: skipped.filter((row) => mine(row.orderId)).length },
        })
      }
    }
    return {
      supervisor: await personOf(tools.tx, body.supervisorId),
      changed: changed.map(({ row }) => ({ orderId: row.orderId, number: row.number })),
      unchanged,
      skipped,
      unknown: ids.length - visible.length,
    }
  })
  return result
}
