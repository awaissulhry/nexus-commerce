import { ConflictError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import {
  applyChanges,
  changedFields,
  differs,
  editProblems,
  mergeWithPlan,
  protectedAfter,
  protectedAfterReset,
  readPlanValues,
  shiftedBy,
  type EditFacts,
  type EditIssue,
  type PlanFields,
  type PlannedChanges,
  type ProtectableField,
} from '@nexus/factory-domain/planning/actions/protect'
import { PLANNING_PLANNED_EDIT } from '@nexus/factory-domain/planning/actions/permissions'
import type { PlannedOrderKind } from '@nexus/factory-domain/planning/planned-orders/rules'
import { protectedPlanOf, readRunInputs } from '@nexus/factory-domain/planning/run-log/inputs'
import { command, StaleVersionError, type CommandCaller, type CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { mayAt, officeContextOf, siteFor } from '../access'
import { latestDoneRun } from '../inputs'
import type { PlannedOrderView } from '../planned-orders/contract'
import { plannedFor, viewsOf } from '../planned-orders/read'
import { PLANNED_COLUMNS, readPlanned, type PlannedRow } from '../planned-orders/store'
import type { Reader } from '../store'
import { columnsOf, fieldsOfRow, kitAtFor } from './fields'

/**
 * A planner's edits of planned work and subcontract orders, kept across runs (B-W2b-306; PLN-076, PLN-078, PLN-083; design
 * planning.mrp "To make": an edited cell keeps a dot and Reset to plan; the bulk edit with one review):
 *
 *   PATCH  /planning/planned-orders/:id         the fields given change (sizes, start, due, line, workshop, steps, kit date,
 *                                               revision; a note too), each one that changes is protected from the next run
 *                                               (PlannedWorkOrder.protectedFields, with who and when); every problem at once
 *                                               in words (400); nothing planned before today
 *   POST   /planning/planned-orders/:id/reset   Reset to plan: the fields named (none: every one) are no longer protected and
 *                                               take the latest plan's values back at once (the run log keeps them), keeping
 *                                               start ≤ due and the kit by the due date
 *   POST   /planning/planned-orders/bulk        several rows with one review: `preview` says what changes on each row and every
 *                                               problem; without it ONE command writes them all or none
 *
 * planning.planned.edit over the site; a firm row may be edited too (it stays firm); a row made real never changes.
 * ONE command per request on the row's version (a bulk edit: compare-and-set on each row's version); audited per row
 * (`planning.plannedOrders.edit` / `.reset`); event planned_work_orders.edited. No money, no person.
 */

const todayAt = (timezone: string) => businessDate(serverClock.now(), timezone)
const NOTE_MAX = 2000

/** What an edit of a row needs to be checked: the style's sizes, the routing's steps, the line, workshop and revision named. */
async function editFactsOf(db: Reader, row: PlannedRow, next: PlanFields, today: string): Promise<EditFacts> {
  const style = await db.style.findUnique({ where: { id: row.styleId }, select: { sizes: true } })
  const revisionId = next.styleRevisionId ?? row.styleRevisionId ?? (await db.styleRevision.findFirst({ where: { styleId: row.styleId, status: 'RELEASED' }, select: { id: true }, orderBy: { revision: 'desc' } }))?.id ?? null
  const steps = revisionId ? await db.routingOperation.findMany({ where: { revisionId }, select: { seq: true }, orderBy: { seq: 'asc' } }) : []
  const line = next.lineId ? await db.line.findFirst({ where: { id: next.lineId, siteId: row.siteId }, select: { id: true, status: true } }) : null
  const party = next.partyId ? await db.party.findUnique({ where: { id: next.partyId }, select: { id: true, code: true, roles: true, status: true } }) : null
  const revision = next.styleRevisionId ? await db.styleRevision.findUnique({ where: { id: next.styleRevisionId }, select: { id: true, styleId: true, status: true } }) : null
  return {
    kind: row.kind as PlannedOrderKind,
    today,
    styleSizes: style?.sizes ?? [],
    routingSeqs: steps.map((step) => step.seq),
    line,
    workshop: party ? { id: party.id, usable: party.status === 'ACTIVE' && party.roles.includes('SUBCONTRACTOR'), why: !party.roles.includes('SUBCONTRACTOR') ? `${party.code} has no SUBCONTRACTOR role.` : party.status !== 'ACTIVE' ? `${party.code} is ${party.status.toLowerCase()}.` : null } : null,
    revision: revision ? { id: revision.id, ofStyle: revision.styleId === row.styleId, usable: revision.status === 'RELEASED' || revision.id === row.styleRevisionId } : null,
  }
}

const issuesError = (issues: readonly EditIssue[], prefix: string) => new ValidationError(issues[0]!.message, issues.map((issue) => ({ path: `${prefix}/${issue.field}`, message: issue.message })))

/** The value of a field, for an audit row or the review. */
const valueOf = (fields: PlanFields, field: ProtectableField): unknown => fields[field]

/** One row's edit inside a command: checked, written at its version (compare-and-set), audited; null when nothing changes. */
async function writeEdit(tx: CommandTx, row: PlannedRow, changes: PlannedChanges, note: string | null | undefined, facts: { readonly today: string; readonly actorId: string | null; readonly now: Date; readonly version: number; readonly bumped: boolean }, prefix: string, audit: (entry: { recordId: string; companyId: string; siteId: string; before: unknown; after: unknown }) => void) {
  if (row.status !== 'PLANNED') throw new ConflictError('It was made real already: its work order says the rest.')
  const current = fieldsOfRow(row)
  const next = applyChanges(current, changes)
  const changed = changedFields(current, next)
  const noteChanges = note !== undefined && (note === null ? row.note !== null : note !== row.note)
  if (changed.length === 0 && !noteChanges) throw new ValidationError('Nothing changes: name at least one field with a new value.', [{ path: `${prefix}`, message: 'Name at least one field with a new value.' }])
  if (changed.length > 0) {
    const problems = editProblems(next, changed, await editFactsOf(tx, row, next, facts.today))
    if (problems.length > 0) throw issuesError(problems, prefix)
  }
  const protectedNow = protectedAfter(row.protectedFields, changed)
  const data = {
    ...(changed.length > 0 ? { ...columnsOf(next), protectedFields: protectedNow, protectedAt: facts.now, protectedById: facts.actorId } : {}),
    ...(noteChanges ? { note } : {}),
    // The command's record guard bumped the version already; a bulk edit bumps it here.
    ...(facts.bumped ? {} : { version: facts.version + 1 }),
    updatedAt: facts.now,
  }
  const { count } = await tx.plannedWorkOrder.updateMany({ where: { id: row.id, status: 'PLANNED', version: facts.bumped ? facts.version + 1 : facts.version }, data })
  if (count !== 1) throw new StaleVersionError('PlannedWorkOrder', row.id, row.version, facts.version)
  audit({
    recordId: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    before: { ...Object.fromEntries(changed.map((field) => [field, valueOf(current, field)])), ...(noteChanges ? { note: row.note } : {}), protectedFields: row.protectedFields },
    after: { ...Object.fromEntries(changed.map((field) => [field, valueOf(next, field)])), ...(noteChanges ? { note } : {}), protectedFields: protectedNow },
  })
  return { changed, protectedNow }
}

export interface EditBody extends PlannedChanges {
  readonly version: number
  readonly note?: string | null | undefined
}

const changesOf = (body: PlannedChanges): PlannedChanges => ({
  ...(body.sizes !== undefined ? { sizes: body.sizes.map((row) => ({ size: row.size.trim(), quantity: row.quantity })) } : {}),
  ...(body.startDate !== undefined ? { startDate: body.startDate } : {}),
  ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
  ...(body.lineId !== undefined ? { lineId: body.lineId } : {}),
  ...(body.partyId !== undefined ? { partyId: body.partyId } : {}),
  ...(body.operationSeqs !== undefined ? { operationSeqs: body.operationSeqs } : {}),
  ...(body.kitDueAt !== undefined ? { kitDueAt: body.kitDueAt === null ? null : new Date(body.kitDueAt).toISOString() } : {}),
  ...(body.styleRevisionId !== undefined ? { styleRevisionId: body.styleRevisionId } : {}),
})

async function viewOne(caller: CommandCaller, id: string): Promise<PlannedOrderView> {
  const office = officeContextOf(caller)
  const [view] = await caller.withClient(async (db) => viewsOf(db, [(await readPlanned(db, id))!], office))
  return view!
}

/** PATCH /planning/planned-orders/:plannedOrderId: edit fields; each one that changes is protected from the next run. */
export async function editPlannedOrder(caller: CommandCaller, id: string, body: EditBody, idempotencyKey?: string): Promise<{ plannedOrder: PlannedOrderView; protectedNow: ProtectableField[]; replayed: boolean }> {
  const row = await plannedFor(caller, id, PLANNING_PLANNED_EDIT)
  const site = await siteFor(caller, row.siteId, PLANNING_PLANNED_EDIT)
  const changes = changesOf(body)
  const note = body.note === undefined ? undefined : body.note === null || body.note.trim() === '' ? null : body.note.trim().slice(0, NOTE_MAX)
  const { result, replayed } = await command(
    caller,
    { name: 'planning.plannedOrders.edit', idempotencyKey, input: { plannedWorkOrderId: id, ...body }, record: { type: 'PlannedWorkOrder', id, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now, context } = tools
      const current = (await readPlanned(tx, id))!
      const actorId = context.audience === 'office' ? context.actorId : null
      const written = await writeEdit(tx, current, changes, note, { today: todayAt(site.timezone), actorId, now, version: body.version, bumped: true }, 'body', (entry) => tools.audit({ action: 'planning.plannedOrders.edit', recordType: 'PlannedWorkOrder', ...entry }))
      tools.emit({ type: 'planned_work_orders.edited', subject: id, companyId: current.companyId, siteId: current.siteId, payload: { siteId: current.siteId, change: 'EDITED', plannedWorkOrderIds: [id] } })
      return { protectedNow: written.protectedNow }
    },
  )
  return { plannedOrder: await viewOne(caller, id), protectedNow: result.protectedNow, replayed }
}

/** The latest DONE run's plan values of a row's protected fields (the run log). */
async function planValuesFor(db: Reader, siteId: string, plannedWorkOrderId: string): Promise<Partial<PlanFields>> {
  const run = await latestDoneRun(db, siteId)
  if (!run) return {}
  const row = await db.planningRun.findUnique({ where: { id: run.id }, select: { inputs: true } })
  return readPlanValues(protectedPlanOf(readRunInputs(row?.inputs ?? null), plannedWorkOrderId))
}

/** POST /planning/planned-orders/:plannedOrderId/reset: Reset to plan (the fields named, or every one). */
export async function resetPlannedOrder(caller: CommandCaller, id: string, body: { readonly version: number; readonly fields?: readonly ProtectableField[] | undefined }, idempotencyKey?: string) {
  const row = await plannedFor(caller, id, PLANNING_PLANNED_EDIT)
  const site = await siteFor(caller, row.siteId, PLANNING_PLANNED_EDIT)
  const { result, replayed } = await command(
    caller,
    { name: 'planning.plannedOrders.reset', idempotencyKey, input: { plannedWorkOrderId: id, ...body }, record: { type: 'PlannedWorkOrder', id, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const current = (await readPlanned(tx, id))!
      if (current.status !== 'PLANNED') throw new ConflictError('It was made real already: its work order says the rest.')
      if (current.protectedFields.length === 0) throw new ConflictError('Nothing of it is protected: it follows the plan already.')
      const asked = body.fields && body.fields.length > 0 ? body.fields.filter((field) => current.protectedFields.includes(field)) : (current.protectedFields as ProtectableField[])
      if (asked.length === 0) throw new ConflictError(`None of those fields is protected (protected: ${current.protectedFields.join(', ')}).`)
      const remaining = protectedAfterReset(current.protectedFields, asked)
      const stored = fieldsOfRow(current)
      const values = await planValuesFor(tx, current.siteId, id)
      const restored = asked.every((field) => values[field] !== undefined)
      // The plan's values of the fields reset (those the log has), the row's own for the rest; the same rules as a run.
      const plan: PlanFields = { ...stored, ...Object.fromEntries(asked.flatMap((field) => (values[field] !== undefined ? [[field, values[field]]] : []))) }
      const next = mergeWithPlan(stored, plan, remaining, current.kind, kitAtFor(site.timezone), todayAt(site.timezone))
      const changed = (['sizes', 'startDate', 'dueDate', 'lineId', 'partyId', 'operationSeqs', 'kitDueAt', 'styleRevisionId'] as const).filter((field) => differs(field, stored, next))
      await tx.plannedWorkOrder.update({
        where: { id },
        data: { ...columnsOf(next), protectedFields: remaining, protectedAt: remaining.length > 0 ? current.protectedAt : null, protectedById: remaining.length > 0 ? current.protectedById : null, updatedAt: now },
        select: { id: true },
      })
      tools.audit({
        action: 'planning.plannedOrders.reset',
        recordType: 'PlannedWorkOrder',
        recordId: id,
        companyId: current.companyId,
        siteId: current.siteId,
        before: { ...Object.fromEntries(changed.map((field) => [field, stored[field]])), protectedFields: current.protectedFields },
        after: { ...Object.fromEntries(changed.map((field) => [field, next[field]])), protectedFields: remaining, restored },
      })
      tools.emit({ type: 'planned_work_orders.edited', subject: id, companyId: current.companyId, siteId: current.siteId, payload: { siteId: current.siteId, change: 'RESET', plannedWorkOrderIds: [id] } })
      return { reset: asked, restored }
    },
  )
  return { plannedOrder: await viewOne(caller, id), reset: [...result.reset], restored: result.restored, replayed }
}

export interface BulkBody {
  readonly siteId: string
  readonly set?: PlannedChanges | undefined
  readonly shiftDays?: number | undefined
  readonly rows: readonly { readonly id: string; readonly version: number; readonly changes?: PlannedChanges | undefined }[]
  readonly preview?: boolean | undefined
}

/** POST /planning/planned-orders/bulk: several rows with one review; written all or none. */
export async function bulkEditPlannedOrders(caller: CommandCaller, body: BulkBody, idempotencyKey?: string) {
  const office = officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, PLANNING_PLANNED_EDIT)
  const ids = body.rows.map((row) => row.id)
  if (new Set(ids).size !== ids.length) throw new ValidationError('A planned order is named twice.', [{ path: 'body/rows', message: 'Name each planned order once.' }])
  const today = todayAt(site.timezone)
  const changesFor = (row: PlannedRow, entry: BulkBody['rows'][number]): PlannedChanges => ({ ...(body.shiftDays ? shiftedBy(fieldsOfRow(row), body.shiftDays) : {}), ...changesOf(body.set ?? {}), ...changesOf(entry.changes ?? {}) })
  /** Every row checked at once (nothing written): its changes from → to and its problems. */
  const review = async (db: Reader) => {
    const rows = await db.plannedWorkOrder.findMany({ where: { id: { in: ids } }, select: PLANNED_COLUMNS })
    const out: { id: string; row: PlannedRow | null; changes: { field: ProtectableField; from: unknown; to: unknown }[]; problems: { field: string; message: string }[] }[] = []
    for (const [index, entry] of body.rows.entries()) {
      const row = rows.find((candidate) => candidate.id === entry.id) ?? null
      const at = `body/rows/${index}`
      if (!row || row.siteId !== site.id || !mayAt(office, PLANNING_PLANNED_EDIT, row)) {
        out.push({ id: entry.id, row: null, changes: [], problems: [{ field: `${at}/id`, message: 'This planned order is not found at the site.' }] })
        continue
      }
      const problems: { field: string; message: string }[] = []
      if (row.status !== 'PLANNED') problems.push({ field: `${at}/id`, message: 'It was made real already: its work order says the rest.' })
      if (row.version !== entry.version) problems.push({ field: `${at}/version`, message: `It changed since you read it (version ${row.version}, you sent ${entry.version}): read it again.` })
      const current = fieldsOfRow(row)
      const next = applyChanges(current, changesFor(row, entry))
      const changed = changedFields(current, next)
      if (changed.length === 0) problems.push({ field: `${at}/changes`, message: 'Nothing changes on this row.' })
      else for (const issue of editProblems(next, changed, await editFactsOf(db, row, next, today))) problems.push({ field: `${at}/${issue.field}`, message: issue.message })
      out.push({ id: entry.id, row, changes: changed.map((field) => ({ field, from: current[field], to: next[field] })), problems })
    }
    return out
  }
  if (body.preview) {
    return caller.withClient(async (db) => {
      const checked = await review(db)
      const views = await viewsOf(db, checked.flatMap((entry) => (entry.row ? [entry.row] : [])), office)
      return { preview: true, changed: checked.filter((entry) => entry.changes.length > 0 && entry.problems.length === 0).length, rows: checked.map((entry) => ({ id: entry.id, plannedOrder: views.find((view) => view.id === entry.id) ?? null, changes: entry.changes, problems: entry.problems })), replayed: false }
    })
  }
  const { result, replayed } = await command(caller, { name: 'planning.plannedOrders.bulkEdit', idempotencyKey, input: body }, async (tools) => {
    const { tx, now, context } = tools
    const checked = await review(tx)
    const problems = checked.flatMap((entry) => entry.problems)
    if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems.map((problem) => ({ path: problem.field, message: problem.message })))
    const actorId = context.audience === 'office' ? context.actorId : null
    for (const [index, entry] of body.rows.entries()) {
      const row = checked[index]!.row!
      await writeEdit(tx, row, changesFor(row, entry), undefined, { today, actorId, now, version: entry.version, bumped: false }, `body/rows/${index}`, (audit) => tools.audit({ action: 'planning.plannedOrders.edit', recordType: 'PlannedWorkOrder', ...audit }))
    }
    tools.emit({ type: 'planned_work_orders.edited', subject: site.id, companyId: site.companyId, siteId: site.id, payload: { siteId: site.id, change: 'EDITED', plannedWorkOrderIds: ids } })
    return { checked: checked.map((entry) => ({ id: entry.id, changes: entry.changes })) }
  })
  const views = await caller.withClient(async (db) => viewsOf(db, await db.plannedWorkOrder.findMany({ where: { id: { in: ids } }, select: PLANNED_COLUMNS }), office))
  return { preview: false, changed: ids.length, rows: result.checked.map((entry) => ({ id: entry.id, plannedOrder: views.find((view) => view.id === entry.id) ?? null, changes: entry.changes, problems: [] })), replayed }
}
