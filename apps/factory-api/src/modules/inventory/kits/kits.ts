import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { INVENTORY_ISSUE, INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { kitActions, kitHeldWords, stagingProblem, type KitAction, type KitChange } from '@nexus/factory-domain/inventory/kits/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { mayAt, officeContextOf } from '../ledger/access'
import type { Reader } from '../issue/store'
import { picksOf, readKits } from './store'

/**
 * Kit staging (B-W2b-15; SCM-213; follow-up Z2:04 of B-W2a-58; design warehouse.picking pk-grid "kit location", pop:pk-list
 * "Kit complete check" and "Mark kit complete (held while lines are short)"). ONE kit record per work order (WorkOrderKit,
 * its id the work order's, made by its first write): where the picked material waits, and whether a person checked it
 * complete. Office routes; a floor screen comes with the floor's kit section (W2b-5: the grants are there already).
 *
 *   GET  /inventory/kits/:workOrderId            inventory.stock.view  the kit: the picks' state, place, check, actions
 *   POST /inventory/kits/:workOrderId/stage      inventory.issue       put it at a place of the site, or take it off
 *   POST /inventory/kits/:workOrderId/complete   inventory.issue       checked complete (held while a line is short)
 *   POST /inventory/kits/:workOrderId/reopen     inventory.issue       open again, with the reason (kept in the history)
 *
 * Each write is ONE command() with the version read (0 before the first write): the picks are read in it, the actions
 * judged by factory-domain inventory/kits (a held action is a 409 `kit/<CODE>` in words), the work order's audit row and
 * `inventory.kit_changed`. The database (WorkOrderKit_guard) keeps the last word: an open work order at the first write,
 * when and by whom both or neither, a place in use that is not a workshop's.
 */

const RECORD = 'WorkOrder'

interface Header {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly companyId: string
  readonly siteId: string
}

async function headerOf(db: Reader, workOrderId: string): Promise<Header | null> {
  return isUuid(workOrderId) ? db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, number: true, status: true, companyId: true, siteId: true } }) : null
}

/** The kit record view: the picks' state, its place and check, and what may be done now. */
async function kitRecordOf(db: Reader, header: Header) {
  const picks = await picksOf(db, header.id)
  const fields = (await readKits(db, [header.id])).get(header.id)!
  const actions = kitActions({ workOrderStatus: header.status, lines: picks.all, short: picks.short, checked: fields.checkedAt !== null })
  return {
    workOrderId: header.id,
    number: header.number,
    workOrderStatus: header.status,
    siteId: header.siteId,
    status: picks.status,
    lines: { all: picks.all, picked: picks.picked, short: picks.short },
    location: fields.location,
    checkedAt: fields.checkedAt,
    note: fields.note,
    version: fields.version,
    actions,
  }
}

/** GET /inventory/kits/:workOrderId. */
export async function getKit(caller: CommandCaller, workOrderId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (db) => {
    const header = await headerOf(db, workOrderId)
    if (!header || !mayAt(context, INVENTORY_STOCK_VIEW, header)) throw new NotFoundError('Work order not found.')
    return { kit: await kitRecordOf(db, header) }
  })
}

class KitHeldError extends ConflictError {
  override name = 'KitHeldError'
  override readonly issues: readonly { path: string; message: string }[]
  constructor(message: string, code: string) {
    super(message)
    this.issues = [{ path: `kit/${code}`, message }]
  }
}

interface KitWrite {
  readonly action: KitAction
  readonly change: (current: { checked: boolean; locationId: string | null }) => KitChange
  readonly version: number
  readonly data: (tools: CommandTools) => { stagingLocationId?: string | null; completedAt?: Date | null; completedById?: string | null; note?: string | null }
  readonly reason?: string
  readonly locationId?: string | null
}

async function writeKit(caller: CommandCaller, workOrderId: string, name: `inventory.${string}`, input: unknown, spec: KitWrite, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const seen = await caller.withClient((db) => headerOf(db, workOrderId))
  if (!seen || !mayAt(context, INVENTORY_STOCK_VIEW, seen)) throw new NotFoundError('Work order not found.')
  if (!mayAt(context, INVENTORY_ISSUE, seen)) throw new NotFoundError('Work order not found.')
  const { result } = await command(caller, { name, idempotencyKey, input }, async (tools) => {
    const { tx } = tools
    // The work order's row, locked: its state cannot move under the kit's check.
    await tx.$queryRaw`SELECT 1 FROM "WorkOrder" WHERE id = ${seen.id}::uuid FOR UPDATE`
    const header = (await headerOf(tx, seen.id))!
    const picks = await picksOf(tx, header.id)
    const current = await tx.workOrderKit.findUnique({ where: { id: header.id }, select: { id: true, version: true, completedAt: true, stagingLocationId: true } })
    if ((current?.version ?? 0) !== spec.version) throw new ConflictError('The kit changed since you read it: read it again.')
    const checked = Boolean(current?.completedAt)
    const state = kitActions({ workOrderStatus: header.status, lines: picks.all, short: picks.short, checked })[spec.action]
    if (!state.allowed) throw new KitHeldError(kitHeldWords(state.held!, { number: header.number, status: header.status, ...(state.count === undefined ? {} : { count: state.count }) }), state.held!)
    if (spec.locationId) {
      const place = await tx.location.findUnique({ where: { id: spec.locationId }, select: { siteId: true, status: true, kind: true } })
      const problem = stagingProblem(place, header.siteId)
      if (problem) throw new ValidationError(problem, [{ path: 'body/locationId', message: problem }])
    }
    const data = spec.data(tools)
    if (current) {
      const changed = await tx.workOrderKit.updateMany({ where: { id: current.id, version: current.version }, data: { ...data, version: { increment: 1 }, updatedAt: tools.now } })
      if (changed.count !== 1) throw new ConflictError('The kit changed while it was saved: read it again.')
    } else {
      await tx.workOrderKit.create({ data: { id: header.id, siteId: header.siteId, workOrderId: header.id, ...data, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId }, select: { id: true } })
    }
    const after = await tx.workOrderKit.findUniqueOrThrow({ where: { id: header.id }, select: { stagingLocationId: true, completedAt: true } })
    const change = spec.change({ checked, locationId: current?.stagingLocationId ?? null })
    tools.audit({
      action: `inventory.kit${change[0]}${change.slice(1).toLowerCase()}`,
      recordType: RECORD,
      recordId: header.id,
      companyId: header.companyId,
      siteId: header.siteId,
      before: { kitPlace: current?.stagingLocationId ?? null, kitChecked: checked },
      after: { kitPlace: after.stagingLocationId, kitChecked: after.completedAt !== null },
      ...(spec.reason ? { reason: spec.reason } : {}),
    })
    tools.emit({
      type: 'inventory.kit_changed',
      subject: header.id,
      companyId: header.companyId,
      siteId: header.siteId,
      payload: { workOrderId: header.id, number: header.number, change, stagingLocationId: after.stagingLocationId, checked: after.completedAt !== null },
    })
    return { kit: await kitRecordOf(tx, header) }
  })
  return result
}

/** POST /inventory/kits/:workOrderId/stage: the kit waits at a place of the site (or, with null, at none). */
export async function stageKit(caller: CommandCaller, workOrderId: string, body: { readonly version: number; readonly locationId: string | null }, idempotencyKey?: string) {
  return writeKit(caller, workOrderId, 'inventory.stageKit', { workOrderId, ...body }, {
    action: 'stage',
    version: body.version,
    locationId: body.locationId,
    change: () => (body.locationId ? 'STAGED' : 'UNSTAGED'),
    data: () => ({ stagingLocationId: body.locationId }),
  }, idempotencyKey)
}

/** POST /inventory/kits/:workOrderId/complete: a person checked the kit complete (every line picked in full). */
export async function completeKit(caller: CommandCaller, workOrderId: string, body: { readonly version: number; readonly note?: string | undefined }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  return writeKit(caller, workOrderId, 'inventory.completeKit', { workOrderId, ...body }, {
    action: 'complete',
    version: body.version,
    change: () => 'COMPLETED',
    data: (tools) => ({ completedAt: tools.now, completedById: context.actorId, ...(body.note ? { note: body.note.trim() } : {}) }),
    ...(body.note ? { reason: body.note.trim() } : {}),
  }, idempotencyKey)
}

/** POST /inventory/kits/:workOrderId/reopen: a kit checked complete is open again, with the reason. */
export async function reopenKit(caller: CommandCaller, workOrderId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  return writeKit(caller, workOrderId, 'inventory.reopenKit', { workOrderId, ...body }, {
    action: 'reopen',
    version: body.version,
    change: () => 'REOPENED',
    data: () => ({ completedAt: null, completedById: null }),
    reason: body.reason.trim(),
  }, idempotencyKey)
}
