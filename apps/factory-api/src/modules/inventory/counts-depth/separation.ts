import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { INVENTORY_RULES_MANAGE } from '@nexus/factory-domain/inventory/posting/permissions'
import { offReasonProblem, SEPARATION_FIELDS, SEPARATION_RULES, SEPARATION_WORDS, separationInForce, separationLoosened, type SeparationInForce, type SeparationRule, type SeparationRow } from '@nexus/factory-domain/inventory/counts-depth/separation'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { separationOf, separationRowsOf, type Db, type SeparationRows } from './store'

/**
 * Separation of duties (B-W2b-299; SCM-293; design warehouse.settings ws-sod, ws-stepup): the two switches of the warehouse
 * rules, on the same InventorySettings row as B-W2b-314's cards (the company's, id = the company's; or the tenant-wide one,
 * id = the tenant's).
 *
 *   GET /inventory/rules/separation-of-duties?companyId   inventory.stock.view over the company (tenant-wide: any grant): each
 *                                                         switch's own value, what is in force and where it comes from, its
 *                                                         words, the reason a switch was turned off, who changed it last
 *   PUT /inventory/rules/separation-of-duties             inventory.rules.manage over the scope (tenant-wide: every company);
 *                                                         a switch turned off asks the reason and a fresh code (it widens what
 *                                                         one person can do); turned on asks nothing
 *
 * The counter's switch is read by the database (`factory_wh_counter_not_approver`) and by the counts (../counts approve and
 * the scans' recount); the receiver's by payables (modules/payables/matching.ts receiverRefusals: approve, accept a
 * difference). Each save is one command at the row's version (a new row at 0), checked again under the row's lock.
 */

function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

async function assertCompany(caller: CommandCaller, companyId: string): Promise<void> {
  const context = officeOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
  if (!row || !(can(actorOf(context), INVENTORY_STOCK_VIEW, { companyId }) || can(actorOf(context), INVENTORY_RULES_MANAGE, { companyId }))) throw new NotFoundError('Company not found.')
}

async function viewOf(db: Db, context: OfficeContext, companyId: string | null) {
  const rows = await separationRowsOf(db, context.tenantId, companyId)
  const own = companyId === null ? rows.tenant : rows.company
  const inForce = separationOf(companyId, rows)
  const changer = own?.updatedById ? await db.user.findUnique({ where: { id: own.updatedById }, select: { id: true, displayName: true } }) : null
  return {
    companyId,
    version: own?.version ?? 0,
    updatedAt: own ? toUtcIso(own.updatedAt) : null,
    changedBy: changer ? { id: changer.id, name: changer.displayName } : null,
    mayChange: mayWrite(actorOf(context), INVENTORY_RULES_MANAGE, companyId),
    switches: SEPARATION_RULES.map((rule) => ({
      rule,
      own: own ? own[SEPARATION_FIELDS[rule]] : null,
      inForce: inForce[rule],
      words: inForce[rule].on ? SEPARATION_WORDS[rule].on : SEPARATION_WORDS[rule].off,
    })),
    offReason: own?.separationOffReason ?? null,
  }
}

/** GET /inventory/rules/separation-of-duties */
export async function getSeparation(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  const companyId = query.companyId ?? null
  if (companyId !== null) await assertCompany(caller, companyId)
  else if (!can(actorOf(context), INVENTORY_STOCK_VIEW, {}) && !can(actorOf(context), INVENTORY_RULES_MANAGE, {})) throw new ForbiddenError()
  return caller.withClient((db) => viewOf(db, context, companyId))
}

export interface SeparationBody {
  readonly companyId?: string | null | undefined
  readonly version: number
  readonly counterNotApprover?: boolean | null | undefined
  readonly receiverNotMatcher?: boolean | null | undefined
  readonly reason?: string | null | undefined
}

/** The scope's own row once the asked values are written. */
function nextRow(own: SeparationRow | null, body: SeparationBody, reason: string | null): SeparationRow {
  const counterNotApprover = body.counterNotApprover !== undefined ? body.counterNotApprover : (own?.counterNotApprover ?? null)
  const receiverNotMatcher = body.receiverNotMatcher !== undefined ? body.receiverNotMatcher : (own?.receiverNotMatcher ?? null)
  const anyOff = counterNotApprover === false || receiverNotMatcher === false
  // The database: the reason exactly while a switch of the row is off (a new one replaces it; none once both are on or follow).
  return { counterNotApprover, receiverNotMatcher, separationOffReason: anyOff ? (reason ?? own?.separationOffReason ?? null) : null }
}

const inForceAfter = (companyId: string | null, rows: SeparationRows, next: SeparationRow): SeparationInForce =>
  companyId === null ? separationInForce(undefined, next) : separationInForce(next, rows.tenant)

/** PUT /inventory/rules/separation-of-duties */
export async function saveSeparation(caller: CommandCaller, body: SeparationBody, options: { readonly stepUp: () => void | Promise<void>; readonly idempotencyKey?: string | undefined }) {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  if (!mayWrite(actorOf(context), INVENTORY_RULES_MANAGE, companyId)) {
    throw new ForbiddenError(companyId === null ? 'The warehouse rules of every company are changed only by a role over every company.' : 'Changing the warehouse rules needs inventory.rules.manage for the company.')
  }
  if (companyId !== null) await assertCompany(caller, companyId)
  if (body.counterNotApprover === undefined && body.receiverNotMatcher === undefined) throw new ValidationError('Send a switch to change.', [{ path: 'body/counterNotApprover', message: 'Send counterNotApprover or receiverNotMatcher.' }])
  const reason = body.reason?.trim() ? body.reason.trim() : null
  const planned = (rows: SeparationRows) => {
    const own = companyId === null ? rows.tenant : rows.company
    const next = nextRow(own, body, reason)
    return { own, next, loosened: separationLoosened(separationOf(companyId, rows), inForceAfter(companyId, rows, next)) }
  }
  const first = planned(await caller.withClient((db) => separationRowsOf(db, context.tenantId, companyId)))
  // A switch off needs its words (they stay on the row while it is off), whether it loosens what is in force or not.
  const switchedOff = (body.counterNotApprover === false && first.own?.counterNotApprover !== false) || (body.receiverNotMatcher === false && first.own?.receiverNotMatcher !== false)
  if (first.loosened.length > 0 || switchedOff) {
    const problem = offReasonProblem(reason)
    if (problem) throw new ValidationError(problem, [{ path: 'body/reason', message: problem }])
  }
  if (first.loosened.length > 0) await options.stepUp()
  let loosened: SeparationRule[] = first.loosened
  await command(caller, { name: 'inventory.rules.save', idempotencyKey: options.idempotencyKey, input: body }, async (tools: CommandTools) => {
    const id = companyId ?? context.tenantId
    const [locked] = await tools.tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "InventorySettings" WHERE "id" = ${id}::uuid FOR UPDATE`
    const current = locked?.version ?? 0
    if (current !== body.version) throw new StaleVersionError('InventorySettings', id, current, body.version)
    const rows = await separationRowsOf(tools.tx, context.tenantId, companyId)
    const now = planned(rows)
    if (now.loosened.some((rule) => !first.loosened.includes(rule))) {
      throw new ValidationError('The rules in force changed meanwhile: read them again, then switch the rule off with the reason and a fresh code.', [{ path: 'body/version', message: 'Read the rules again.' }])
    }
    loosened = now.loosened
    const before = { counterNotApprover: now.own?.counterNotApprover ?? null, receiverNotMatcher: now.own?.receiverNotMatcher ?? null, separationOffReason: now.own?.separationOffReason ?? null }
    const unchanged = before.counterNotApprover === now.next.counterNotApprover && before.receiverNotMatcher === now.next.receiverNotMatcher && before.separationOffReason === now.next.separationOffReason
    if (unchanged) {
      tools.audit({ action: 'inventory.rules.unchanged', recordType: 'InventorySettings', recordId: id, companyId, after: { card: 'SEPARATION_OF_DUTIES' } })
      return { id }
    }
    const data = { counterNotApprover: now.next.counterNotApprover, receiverNotMatcher: now.next.receiverNotMatcher, separationOffReason: now.next.separationOffReason }
    if (locked) {
      await tools.tx.inventorySettings.update({ where: { id }, data: { ...data, version: { increment: 1 }, updatedAt: tools.now, updatedById: context.actorId }, select: { id: true } })
    } else {
      await tools.tx.inventorySettings
        .create({ data: { id, companyId, ...data, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId, updatedById: context.actorId }, select: { id: true } })
        .catch((error: unknown) => {
          if ((error as { code?: unknown } | null)?.code === 'P2002') throw new ConflictError('These warehouse rules were just saved by someone else: read them again.')
          throw error
        })
    }
    const fields = (['counterNotApprover', 'receiverNotMatcher'] as const).filter((field) => before[field] !== now.next[field])
    tools.audit({
      action: 'inventory.rules.save',
      recordType: 'InventorySettings',
      recordId: id,
      companyId,
      before,
      after: { ...data, card: 'SEPARATION_OF_DUTIES', loosened: now.loosened },
      ...(reason ? { reason } : {}),
    })
    tools.emit({ type: 'inventory.rules_changed', subject: id, companyId, payload: { companyId, card: 'SEPARATION_OF_DUTIES', fields: fields.length > 0 ? [...fields] : ['separationOffReason'], loosened: now.loosened.length > 0 } })
    return { id }
  })
  return { rules: await caller.withClient((db) => viewOf(db, context, companyId)), loosened }
}
