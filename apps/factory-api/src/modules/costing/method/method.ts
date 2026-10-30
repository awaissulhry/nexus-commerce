import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { DECIDED_METHODS, isProvisional, methodWords, type CostingMethod } from '@nexus/factory-domain/costing/ledger/entries'
import { COSTING_METHOD_MANAGE, COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import type { ChooseMethodBody, CostingMethodView } from '@nexus/factory-domain/costing/standards/contracts'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID, type RequestContext } from '../../../core/context'
import { contextOf, mayWrite } from '../../product/materials/store'
import { companyOrTenant } from '../inputs'
import type { Reader } from '../actual/store'

/**
 * The costing method per company (B-W2a-21; FIN-025; c.c. art. 2426; design finance.settings "Costing" and its pop-up
 * "Why the costing method is locked"): standard, moving average or FIFO, the accountant's choice (GATE-ACCOUNTANT). It
 * lives on W1's CostingSettings row: the company's own, else the tenant-wide one (id = the tenant's), else UNDECIDED.
 * UNDECIDED is the default and stays until someone with costing.method.manage (and a fresh step-up) chooses: every cost
 * entry posted meanwhile is provisional (it says UNDECIDED). The first entry posted under a decided method locks it, in
 * the same command (lockMethodInCommand); from then on it never changes (the …_money_w2a_guards trigger), and the screen
 * holds the choice with that reason. Nothing here ever picks a method by itself.
 */

const SETTINGS = { id: true, companyId: true, overheadPct: true, costingMethod: true, methodLockedAt: true, methodLockedById: true, version: true } as const satisfies Prisma.CostingSettingsSelect
type SettingsRow = Prisma.CostingSettingsGetPayload<{ select: typeof SETTINGS }>

/** The method a company's entries are posted under, and the row it comes from. */
export interface MethodInForce {
  readonly method: CostingMethod
  readonly row: SettingsRow | null
  readonly from: 'COMPANY' | 'TENANT' | 'DEFAULT'
}

/** companyId null: the tenant-wide row only. */
export async function methodInForce(db: Reader, companyId: string | null): Promise<MethodInForce> {
  const rows = await db.costingSettings.findMany({ where: companyOrTenant(companyId), select: SETTINGS })
  const own = companyId === null ? undefined : rows.find((row) => row.companyId === companyId)
  const tenant = rows.find((row) => row.companyId === null)
  const row = own ?? tenant ?? null
  return { method: (row?.costingMethod ?? 'UNDECIDED') as CostingMethod, row, from: own ? 'COMPANY' : tenant ? 'TENANT' : 'DEFAULT' }
}

/**
 * The method an entry of `companyId` posts under now; a decided one not yet locked is locked here, in the caller's
 * command (when, and who: the office person, or the system for the worker), with its audit row and event.
 */
export async function lockMethodInCommand(tools: Pick<CommandTools, 'tx' | 'now' | 'context' | 'audit' | 'emit'>, companyId: string): Promise<CostingMethod> {
  const { tx, now } = tools
  const inForce = await methodInForce(tx, companyId)
  if (isProvisional(inForce.method) || inForce.row === null || inForce.row.methodLockedAt !== null) return inForce.method
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : SYSTEM_ACTOR_ID
  const locked = await tx.costingSettings.updateMany({
    where: { id: inForce.row.id, methodLockedAt: null, costingMethod: inForce.method },
    data: { methodLockedAt: now, methodLockedById: actorId, version: { increment: 1 }, updatedAt: now },
  })
  if (locked.count === 0) {
    const again = await methodInForce(tx, companyId)
    if (again.method !== inForce.method) throw new ConflictError('The costing method changed while the cost was being posted: try again.')
    return again.method
  }
  tools.audit({ action: 'costing.lockMethod', recordType: 'CostingSettings', recordId: inForce.row.id, companyId: inForce.row.companyId, before: { methodLockedAt: null }, after: { method: inForce.method, methodLockedAt: toUtcIso(now) }, reason: 'The first cost entry posted under this method locks it (c.c. art. 2426).' })
  tools.emit({ type: 'costing_method.changed', subject: inForce.row.id, companyId: inForce.row.companyId, payload: { settingsId: inForce.row.id, method: inForce.method, change: 'locked' } })
  return inForce.method
}

const tenantOf = (context: RequestContext): string => {
  if (!('tenantId' in context)) throw new ForbiddenError()
  return context.tenantId
}

async function assertCompany(caller: CommandCaller, companyId: string, permission: Permission = COSTING_VIEW): Promise<void> {
  const context = contextOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
  if (!row || !can(actorOf(context), permission, { companyId })) throw new NotFoundError('Company not found.')
}

async function viewOf(db: Reader, companyId: string | null, inForce: MethodInForce): Promise<CostingMethodView> {
  const where = companyId === null ? {} : { companyId }
  const first = await db.workOrderCostEntry.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
  const entries = await db.workOrderCostEntry.count({ where })
  const lockedAt = inForce.row?.methodLockedAt ?? null
  return {
    companyId,
    settingsId: inForce.row?.id ?? null,
    from: inForce.from,
    method: inForce.method,
    provisional: isProvisional(inForce.method),
    locked: lockedAt !== null,
    lockedAt: lockedAt ? toUtcIso(lockedAt) : null,
    lockedById: inForce.row?.methodLockedById ?? null,
    firstEntryAt: first ? toUtcIso(first.createdAt) : null,
    entries,
    words: methodWords(inForce.method, lockedAt ? businessDate(lockedAt) : null),
    choices: [...DECIDED_METHODS],
    open: lockedAt === null,
    version: inForce.row?.version ?? null,
  }
}

/** GET /costing/method: the method in force for a company (or the tenant-wide one), in words. */
export async function methodOf(caller: CommandCaller, query: { readonly companyId?: string | undefined }): Promise<CostingMethodView> {
  if (query.companyId !== undefined) await assertCompany(caller, query.companyId)
  const companyId = query.companyId ?? null
  return caller.withClient(async (db) => viewOf(db, companyId, await methodInForce(db, companyId)))
}

const heldWords = (method: string, lockedAt: Date): string =>
  `The costing method is ${method}, locked since ${businessDate(lockedAt)}: cost entries rely on it, and changing it would revalue them (c.c. art. 2426).`

/**
 * costing.chooseMethod (PUT /costing/method, step-up in the route): the accountant's method for a company (its own
 * settings row; made now when it has none, with the tenant-wide overhead copied so nothing else changes) or the
 * tenant-wide one. Refused once locked; refused for a company whose entries were posted under the tenant-wide method
 * once that one is locked.
 */
export async function chooseMethod(caller: CommandCaller, body: ChooseMethodBody, idempotencyKey?: string): Promise<CostingMethodView> {
  const context = contextOf(caller)
  const companyId = body.companyId ?? null
  if (!mayWrite(actorOf(context), COSTING_METHOD_MANAGE, companyId)) throw new ForbiddenError(companyId === null ? 'The tenant-wide costing method is chosen only by a role over every company.' : undefined)
  if (companyId !== null) await assertCompany(caller, companyId, COSTING_METHOD_MANAGE)
  const id = companyId ?? tenantOf(context)
  const existing = await caller.withClient((db) => db.costingSettings.findUnique({ where: { id }, select: SETTINGS }))
  if (existing && body.version === undefined) throw new ConflictError('These costing settings exist: send their version to change the method.')
  if (!existing && body.version !== undefined) throw new ConflictError('These costing settings do not exist yet: choose the method without a version.')

  const { result } = await command(
    caller,
    { name: 'costing.chooseMethod', idempotencyKey, input: body, ...(existing ? { record: { type: 'CostingSettings', id, expectedVersion: body.version } } : {}) },
    async (tools) => {
      const { tx, now } = tools
      const row = existing ? await tx.costingSettings.findUniqueOrThrow({ where: { id }, select: SETTINGS }) : null
      if (row?.methodLockedAt) throw new ConflictError(heldWords(row.costingMethod, row.methodLockedAt))
      if (row === null && companyId !== null) await refuseLeavingLockedTenantMethod(tx, companyId, body.method)
      const before = row?.costingMethod ?? (companyId === null ? 'UNDECIDED' : (await methodInForce(tx, companyId)).method)
      if (row === null) {
        const tenant = companyId === null ? null : await tx.costingSettings.findFirst({ where: { companyId: null }, select: { overheadPct: true } })
        const overheadPct = tenant?.overheadPct.toString() ?? '0'
        await tx.costingSettings.create({ data: { id, companyId, overheadPct, costingMethod: body.method, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null }, select: { id: true } })
        tools.audit({ recordType: 'CostingSettings', recordId: id, companyId, after: { companyId, overheadPct, method: body.method }, ...(body.reason ? { reason: body.reason } : {}) })
      } else {
        if (row.costingMethod !== body.method) await tx.costingSettings.update({ where: { id }, data: { costingMethod: body.method, updatedAt: now }, select: { id: true } })
        tools.audit({ recordType: 'CostingSettings', recordId: id, companyId, before: { method: row.costingMethod }, after: { method: body.method }, ...(body.reason ? { reason: body.reason } : {}) })
      }
      if (before !== body.method || row === null) tools.emit({ type: 'costing_method.changed', subject: id, companyId, payload: { settingsId: id, method: body.method, change: 'chosen' } })
      return viewOf(tx, companyId, await methodInForce(tx, companyId))
    },
  )
  return result
}

/** A company without its own row follows the tenant-wide method: once that one is locked and the company posted under it, it keeps it. */
async function refuseLeavingLockedTenantMethod(tx: CommandTx, companyId: string, method: CostingMethod): Promise<void> {
  const tenant = await tx.costingSettings.findFirst({ where: { companyId: null }, select: SETTINGS })
  if (!tenant?.methodLockedAt || tenant.costingMethod === method) return
  const posted = await tx.workOrderCostEntry.count({ where: { companyId, costingMethod: tenant.costingMethod } })
  if (posted > 0) throw new ConflictError(`${heldWords(tenant.costingMethod, tenant.methodLockedAt)} This company's cost entries were posted under the tenant-wide method, so it keeps it.`)
}
