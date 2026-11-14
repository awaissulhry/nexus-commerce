import type { Prisma } from '@nexus/factory-db'
import { APPROVALS_DECIDE } from '@nexus/factory-domain/approvals/permissions'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { COSTING_SHEETS_MANAGE } from '@nexus/factory-domain/costing/sheet-components/permissions'
import type { SubmitVersionBody, TakeBackBody } from '@nexus/factory-domain/costing/sheet-versions/contracts'
import { COSTING_SHEETS_APPROVE } from '@nexus/factory-domain/costing/sheet-versions/permissions'
import { COST_SHEET_KIND, leftOutWords } from '@nexus/factory-domain/costing/sheet-versions/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { askApproval, withdrawPending } from '../../../platform/approvals/engine'
import type { TaskRef } from '../../../platform/approvals/kinds/kind'
import { decidersOf } from '../../../platform/approvals/store'
import { contextOf } from '../../product/bom/store'
import { refused, versionRefusalOf } from './refusals'
import { leftOutOf, linesOf, lockSeries, readSheetFor, SHEET_COLUMNS, type SheetRow } from './store'
import { assertDraft, emitChanged, versionRowOf } from './versions'

/**
 * A cost sheet version's approval and lock (B-W2b-420; FIN-015; Rule 1: prices are released from an approved sheet), through
 * the platform's approval engine (B-W2b-282), never around it:
 *
 *   submit     costing.sheets.manage: a DRAFT with lines, for an open season (or none), nothing the components left out
 *              (unless its typed lines are said to cover it) asks a COST_SHEET request: an approval rule in force names who
 *              decides; else the costing owner's role (costing.sheets.approve with approvals.decide; the Owner's last) with
 *              someone other than the person asking and the version's maker. The request's id is kept on the draft.
 *   the yes    the engine's (Home › Approvals, POST /approvals/tasks/:id/approve): never the person who asked nor the
 *              version's maker (409 OWN_SHEET); the version as it was asked (a change made it STALE). In the decision's
 *              command, under the series' lock: the version in force of the series is FROZEN (SUPERSEDED) and this one
 *              APPROVED by the person who decided, on that request — locked: a change is a new version.
 *   the no, withdrawn, stale   the draft stays a DRAFT, the request no longer named on it
 *   take back  costing.sheets.approve: an approved version FROZEN (WITHDRAWN) with a reason (a mistake found)
 *   season     the season's close freezes its approved versions (SEASON_CLOSED, by the system) and sends back its drafts'
 *              waiting requests, in the close's own command (modules/sales/seasons calls `freezeSeasonSheets`)
 */

const tenantOf = (tools: CommandTools): string => ('tenantId' in tools.context ? tools.context.tenantId : '') ?? ''
const actorIdOf = (tools: CommandTools): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/**
 * The costing owner's role when no approval rule names an approver: an office role holding costing.sheets.approve and
 * approvals.decide (the Owner's last), the first with someone other than `askers` who may decide over the company; else the
 * first such role (the request waits until someone else holds it); none → null.
 */
export async function approverRoleOf(tools: CommandTools, companyId: string, askers: readonly string[]): Promise<string | null> {
  const tenantId = tenantOf(tools)
  if (!tenantId) return null
  const roles = await tools.tx.role.findMany({
    where: { audience: 'OFFICE', permissions: { hasEvery: [COSTING_SHEETS_APPROVE, APPROVALS_DECIDE] } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { id: true, key: true },
  })
  const ordered = [...roles.filter((role) => role.key !== 'owner'), ...roles.filter((role) => role.key === 'owner')]
  for (const role of ordered) {
    if ((await decidersOf(tools.tx, tenantId, { approverRoleId: role.id, approverUserId: null }, { companyId, siteId: null }, askers, tools.now)).length > 0) return role.id
  }
  return ordered[0]?.id ?? null
}

async function seasonOpen(tools: CommandTools, seasonId: string | null): Promise<boolean> {
  if (seasonId === null) return true
  return (await tools.tx.season.findUnique({ where: { id: seasonId }, select: { status: true } }))?.status === 'OPEN'
}

/** costing.submitCostSheetVersion — POST /costing/cost-sheets/:sheetId/submit: a draft sent for its yes (see the module comment). */
export async function submitVersion(caller: CommandCaller, sheetId: string, body: SubmitVersionBody, idempotencyKey?: string) {
  const seen = await readSheetFor(caller, sheetId)
  if (!can(actorOf(contextOf(caller)), COSTING_SHEETS_MANAGE, { companyId: seen.companyId })) throw new ForbiddenError()
  assertDraft(seen)
  const { result } = await command(caller, { name: 'costing.submitCostSheetVersion', idempotencyKey, input: { sheetId, ...body }, record: { type: 'CostSheet', id: sheetId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const asker = actorIdOf(tools)!
    const sheet = await tx.costSheet.findUniqueOrThrow({ where: { id: sheetId }, select: SHEET_COLUMNS })
    assertDraft(sheet)
    const lines = await linesOf(tx, sheetId)
    if (lines.length === 0) throw refused('NO_LINES')
    if (!(await seasonOpen(tools, sheet.seasonId))) throw refused('SEASON_CLOSED')
    const leftOut = leftOutOf(sheet.inputs)
    if (leftOut.length > 0 && (!body.coveredByTyped || !lines.some((line) => line.source === 'TYPED'))) throw refused('LEFT_OUT', leftOutWords(leftOut.length))
    if (leftOut.length > 0) {
      const kept = sheet.inputs && typeof sheet.inputs === 'object' && !Array.isArray(sheet.inputs) ? (sheet.inputs as Record<string, unknown>) : {}
      await tx.costSheet.update({ where: { id: sheetId }, data: { inputs: { ...kept, approval: { coveredByTyped: true, saidById: asker } } as Prisma.InputJsonObject, updatedAt: now }, select: { id: true } })
    }
    const roleId = await approverRoleOf(tools, sheet.companyId, [asker, ...(sheet.createdById ? [sheet.createdById] : [])])
    const outcome = await askApproval(tools, { kind: COST_SHEET_KIND, recordId: sheetId, requester: { userId: asker }, note: body.note ?? null, ...(roleId ? { whenNoRule: { approverRoleId: roleId, requireStepUp: false } } : {}) })
    if (!outcome.asked) throw refused('NO_APPROVER')
    await tx.costSheet.update({ where: { id: sheetId }, data: { approvalTaskId: outcome.taskId, updatedAt: now }, select: { id: true } })
    tools.audit({ recordType: 'CostSheet', recordId: sheetId, companyId: sheet.companyId, after: { taskId: outcome.taskId, ruleIds: outcome.ruleIds, approverRoleId: outcome.approverRoleId, approverUserId: outcome.approverUserId, coveredByTyped: leftOut.length > 0 } })
    emitChanged(tools, sheet, 'DRAFT', 'submitted')
    return { sheet: await versionRowOf(tx, sheetId) }
  }).catch((error: unknown) => {
    throw versionRefusalOf(error)
  })
  return result
}

/** Freezes the series' version in force (if any, other than `sheet`) as SUPERSEDED, by the person who approved its successor. */
async function freezeInForce(tools: CommandTools, sheet: Pick<SheetRow, 'id' | 'key'>, byId: string | null): Promise<string | null> {
  const current = await tools.tx.costSheet.findFirst({ where: { key: sheet.key, state: 'APPROVED', id: { not: sheet.id } }, select: SHEET_COLUMNS })
  if (!current) return null
  await freeze(tools, current, 'SUPERSEDED', byId, null)
  return current.id
}

async function freeze(tools: CommandTools, sheet: SheetRow, reason: 'SUPERSEDED' | 'SEASON_CLOSED' | 'WITHDRAWN', byId: string | null, words: string | null): Promise<void> {
  await tools.tx.costSheet.update({ where: { id: sheet.id }, data: { state: 'FROZEN', frozenAt: tools.now, frozenById: byId, frozenReason: reason, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
  tools.audit({ action: 'costing.freezeCostSheetVersion', recordType: 'CostSheet', recordId: sheet.id, companyId: sheet.companyId, before: { state: sheet.state }, after: { state: 'FROZEN', frozenReason: reason, frozenById: byId }, ...(words ? { reason: words } : {}) })
  emitChanged(tools, sheet, 'FROZEN', 'frozen', reason)
}

/** The kind's yes (in the decision's command; the sheet row locked by the kind): see the module comment. */
export async function approvedInCommand(tools: CommandTools, task: TaskRef): Promise<void> {
  try {
    const sheet = await tools.tx.costSheet.findUnique({ where: { id: task.recordId }, select: SHEET_COLUMNS })
    if (!sheet || task.decidedById === null) return
    assertDraft(sheet)
    if (sheet.createdById !== null && sheet.createdById === task.decidedById) throw refused('OWN_SHEET')
    if (!(await seasonOpen(tools, sheet.seasonId))) throw refused('SEASON_CLOSED')
    await lockSeries(tools.tx, tenantOf(tools), sheet.key)
    const supersededId = await freezeInForce(tools, sheet, task.decidedById)
    await tools.tx.costSheet.update({ where: { id: sheet.id }, data: { state: 'APPROVED', approvedAt: tools.now, approvedById: task.decidedById, approvalTaskId: task.id, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'costing.approveCostSheetVersion', recordType: 'CostSheet', recordId: sheet.id, companyId: sheet.companyId, before: { state: 'DRAFT' }, after: { state: 'APPROVED', approvedById: task.decidedById, taskId: task.id, supersededId } })
    tools.emit({ type: 'cost_sheet.approved', subject: sheet.id, companyId: sheet.companyId, payload: { sheetId: sheet.id, styleId: sheet.styleId, sheetVersion: sheet.sheetVersion, taskId: task.id, approvedById: task.decidedById, supersededId } })
  } catch (error) {
    throw versionRefusalOf(error)
  }
}

/** The kind's no, withdrawal or stale: the draft stays a draft, the request no longer named on it. */
export async function returnedInCommand(tools: CommandTools, task: TaskRef): Promise<void> {
  const sheet = await tools.tx.costSheet.findUnique({ where: { id: task.recordId }, select: SHEET_COLUMNS })
  if (!sheet || sheet.state !== 'DRAFT' || sheet.approvalTaskId !== task.id) return
  await tools.tx.costSheet.update({ where: { id: sheet.id }, data: { approvalTaskId: null, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
  tools.audit({ action: 'costing.returnCostSheetVersion', recordType: 'CostSheet', recordId: sheet.id, companyId: sheet.companyId, before: { taskId: task.id }, after: { taskId: null } })
  emitChanged(tools, sheet, 'DRAFT', 'returned')
}

/** costing.takeBackCostSheetVersion — POST /costing/cost-sheets/:sheetId/take-back: the approved version FROZEN (WITHDRAWN). */
export async function takeBackVersion(caller: CommandCaller, sheetId: string, body: TakeBackBody, idempotencyKey?: string) {
  const seen = await readSheetFor(caller, sheetId)
  if (!can(actorOf(contextOf(caller)), COSTING_SHEETS_APPROVE, { companyId: seen.companyId })) throw new ForbiddenError()
  if (seen.state !== 'APPROVED') throw refused('NOT_APPROVED')
  // No `record`: command()'s own version bump would be an edit of an approved row, which the database refuses (only its freeze
  // may change it). The row is locked and its version checked here; the freeze bumps it.
  const { result } = await command(caller, { name: 'costing.takeBackCostSheetVersion', idempotencyKey, input: { sheetId, ...body } }, async (tools) => {
    await tools.tx.$queryRaw`SELECT 1 FROM "CostSheet" WHERE id = ${sheetId}::uuid FOR UPDATE`
    const sheet = await tools.tx.costSheet.findUniqueOrThrow({ where: { id: sheetId }, select: SHEET_COLUMNS })
    if (sheet.version !== body.version) throw new StaleVersionError('CostSheet', sheetId, sheet.version, body.version)
    if (sheet.state !== 'APPROVED') throw refused('NOT_APPROVED')
    await lockSeries(tools.tx, tenantOf(tools), sheet.key)
    await freeze(tools, sheet, 'WITHDRAWN', actorIdOf(tools), body.reason)
    return { sheet: await versionRowOf(tools.tx, sheetId) }
  }).catch((error: unknown) => {
    throw versionRefusalOf(error)
  })
  return result
}

/**
 * The season's close (modules/sales/seasons moveSeason, in its command, before the season is CLOSED): its approved versions
 * FROZEN (SEASON_CLOSED, by the system) and its drafts' waiting requests sent back.
 */
export async function freezeSeasonSheets(tools: CommandTools, seasonId: string): Promise<void> {
  const sheets = await tools.tx.costSheet.findMany({ where: { seasonId, state: { in: ['APPROVED', 'DRAFT'] } }, select: SHEET_COLUMNS, orderBy: [{ key: 'asc' }, { sheetVersion: 'asc' }] })
  for (const sheet of sheets) {
    if (sheet.state === 'APPROVED') {
      await lockSeries(tools.tx, tenantOf(tools), sheet.key)
      await freeze(tools, sheet, 'SEASON_CLOSED', null, 'The season closed.')
    } else {
      await withdrawPending(tools, { kind: COST_SHEET_KIND, recordId: sheet.id, byId: null, words: 'The season closed.' })
    }
  }
}
