import type { Prisma } from '@nexus/factory-db'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { ApproveBody, OperationMinutesView, ProposeBody, RejectBody, WaitingQuery, WaitingView } from '@nexus/factory-domain/product/minutes/contracts'
import { decisionRefusal, inForceOn, pendingOf, planProposal, rejectionProblems, waitingToTakeEffect } from '@nexus/factory-domain/product/minutes/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import {
  actorIdOf,
  contextOf,
  dateOf,
  lockOperation,
  mayDecide,
  mayPropose,
  operationMinutesInTx,
  operationMinutesViewOf,
  readOperationFor,
  readVersions,
  readVersionsOf,
  settleOperation,
  timeVersionViewOf,
  todayOf,
  userNames,
  visibleOperations,
  type MinutesOperationRow,
  type VersionRecord,
} from './store'

/**
 * SMV governance (B-W2b-215; PRD-111, PRD-113; design products.operations › Minutes, pop-up "Propose SMV change", tile "SMV
 * changes waiting for approval"; products.changes "SMV change"). Each write is ONE command with its audit rows and events:
 *
 *   propose   product.smv.propose: basic minutes and allowances (the SMV they give, the database's rounding), the source,
 *             the first day (today or later, not before an approved version's) and why → a PROPOSED version, numbered
 *             after the last. One PROPOSED per operation: a second is refused unless it names the one it `replaces` (that
 *             one SUPERSEDED with no decision). Any operation, governed or not; an archived one takes none.
 *   approve   product.smv.approve, never by the proposer (four eyes; the database too) → APPROVED, decided now, with an
 *             optional note; when its day has come the operation takes its numbers at once and the versions before it are
 *             SUPERSEDED (./store settleOperation), else it waits for its day (./take-effect, hourly).
 *   reject    product.smv.approve, never by the proposer, with why → REJECTED.
 *
 * The operation row is locked FOR UPDATE first in each; a decision sends the version's `version` (compared under that lock).
 */

const invalid = (message: string, issues: readonly Issue[]) => new ValidationError(message, issues)
const prefixed = (issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))

function assertOffice(caller: CommandCaller) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

// ---- reads --------------------------------------------------------------------------------------------------------------

/** GET /product/operations/:operationId/minutes */
export async function getOperationMinutes(caller: CommandCaller, operationId: string): Promise<OperationMinutesView> {
  const context = contextOf(caller)
  const row = await readOperationFor(caller, operationId)
  return caller.withClient((client) => operationMinutesViewOf(client, context, row, todayOf(serverClock.now())))
}

/** GET /product/minutes/waiting: the proposals waiting for a decision, oldest first, on operations the caller may see. */
export async function listWaiting(caller: CommandCaller, query: WaitingQuery): Promise<WaitingView> {
  const context = contextOf(caller)
  const today = todayOf(serverClock.now())
  return caller.withClient(async (client) => {
    const operationWhere: Prisma.OperationWhereInput = { AND: [visibleOperations(context), query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {}] }
    const where: Prisma.OperationTimeVersionWhereInput = { status: 'PROPOSED', operation: operationWhere }
    const rows = await client.operationTimeVersion.findMany({ where, select: { id: true, operationId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: query.limit })
    const count = await client.operationTimeVersion.count({ where })
    const operationIds = rows.map((row) => row.operationId)
    const operations = operationIds.length === 0 ? [] : await client.operation.findMany({ where: { id: { in: operationIds } }, select: { id: true, code: true, name: true, companyId: true, standardMinutes: true } })
    const operationOf = new Map(operations.map((operation) => [operation.id, operation]))
    const versionsOf = await readVersionsOf(client, operationIds)
    const proposals = rows.flatMap((row) => {
      const all = versionsOf.get(row.operationId) ?? []
      const version = all.find((entry) => entry.id === row.id)
      const operation = operationOf.get(row.operationId)
      return version && operation ? [{ version, operation, all }] : []
    })
    const names = await userNames(
      client,
      proposals.flatMap(({ version }) => [version.row.proposedById, version.row.decidedById]),
    )
    return {
      versions: proposals.map(({ version, operation, all }) => ({
        operation: { id: operation.id, code: operation.code, name: operation.name, companyId: operation.companyId, standardMinutes: decimalText(operation.standardMinutes.toString()) },
        proposal: timeVersionViewOf(version, names, inForceOn(all, today)?.id ?? null, new Set(waitingToTakeEffect(all, today).map((entry) => entry.id))),
        mayDecide: mayDecide(context, operation.companyId) && version.proposedById !== actorIdOf(context),
      })),
      count,
    }
  })
}

// ---- propose ------------------------------------------------------------------------------------------------------------

function assertMayPropose(caller: CommandCaller, operation: MinutesOperationRow) {
  const context = assertOffice(caller)
  if (!mayPropose(context, operation.companyId)) {
    throw new ForbiddenError(operation.companyId === null ? 'An SMV change of an operation for every company is proposed only by a role over every company.' : undefined)
  }
  return context
}

/** POST /product/operations/:operationId/minutes/proposals — "Send for approval". */
export async function proposeChange(caller: CommandCaller, operationId: string, body: ProposeBody, idempotencyKey?: string): Promise<{ minutes: OperationMinutesView; versionId: string }> {
  const seen = await readOperationFor(caller, operationId)
  const context = assertMayPropose(caller, seen)
  const proposerId = actorIdOf(context)!

  const { result } = await command(caller, { name: 'product.smv.propose', idempotencyKey, input: { operationId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const operation = await lockOperation(tx, operationId)
    if (operation.status !== 'ACTIVE') throw new InvalidStateError(`Operation ${operation.code} is archived: reactivate it before changing its SMV.`)
    const today = todayOf(now)
    const versions = await readVersions(tx, operationId)
    const pending = pendingOf(versions)
    if (pending && body.replaces !== pending.id) {
      throw new DomainError('conflict', `SMV version ${pending.number} of operation ${operation.code} waits for approval: a second person decides it first, or the new proposal replaces it (replaces: its id).`, [
        { path: 'body/replaces', message: `Version ${pending.number} (${pending.id}) waits for approval.` },
      ])
    }
    if (!pending && body.replaces !== undefined) throw invalid('Nothing to replace.', [{ path: 'body/replaces', message: 'No proposal of this operation waits for approval.' }])
    const plan = planProposal(body, today, versions)
    if (!plan.ok) throw invalid('The SMV change is not valid.', prefixed(plan.issues))
    const { proposal } = plan

    if (pending) {
      await tx.operationTimeVersion.update({ where: { id: pending.id }, data: { status: 'SUPERSEDED', version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ action: 'product.smv.replace', recordType: 'OperationTimeVersion', recordId: pending.id, companyId: operation.companyId, before: { status: 'PROPOSED' }, after: { status: 'SUPERSEDED', replacedBy: versions.length + 1 } })
      emitVersion(tools, operation, pending, 'SUPERSEDED', 'REPLACED')
    }
    const id = newId()
    const number = (versions[0]?.number ?? 0) + 1
    await tx.operationTimeVersion.create({
      data: {
        id,
        operationId,
        number,
        basicMinutes: proposal.basicMinutes,
        personalPct: proposal.personalPct,
        fatiguePct: proposal.fatiguePct,
        delayPct: proposal.delayPct,
        standardMinutes: proposal.standardMinutes,
        source: proposal.source,
        effectiveFrom: dateOf(proposal.effectiveFrom),
        reason: proposal.reason,
        proposedById: proposerId,
        createdAt: now,
        updatedAt: now,
        createdById: proposerId,
      },
      select: { id: true },
    })
    tools.audit({
      action: 'product.smv.propose',
      recordType: 'OperationTimeVersion',
      recordId: id,
      companyId: operation.companyId,
      after: { operationId, number, ...proposal, from: operation.standardMinutes.toString(), replaces: pending?.id ?? null },
    })
    tools.emit({
      type: 'smv_version.changed',
      subject: id,
      companyId: operation.companyId,
      payload: { operationId, code: operation.code, versionId: id, number, status: 'PROPOSED', change: 'PROPOSED', standardMinutes: proposal.standardMinutes, effectiveFrom: proposal.effectiveFrom },
    })
    return { minutes: await operationMinutesInTx(tx, context, operationId, today), versionId: id }
  }).catch(onDuplicateNumber)
  return result
}

const onDuplicateNumber = (error: unknown): never => {
  if ((error as { code?: unknown } | null)?.code === 'P2002') throw new ConflictError('Another SMV version of this operation was proposed at the same time: load it again.')
  throw error
}

function emitVersion(tools: CommandTools, operation: MinutesOperationRow, version: VersionRecord, status: 'APPROVED' | 'REJECTED' | 'SUPERSEDED', change: 'APPROVED' | 'REJECTED' | 'REPLACED') {
  tools.emit({
    type: 'smv_version.changed',
    subject: version.id,
    companyId: operation.companyId,
    payload: { operationId: operation.id, code: operation.code, versionId: version.id, number: version.number, status, change, standardMinutes: version.standardMinutes, effectiveFrom: version.effectiveFrom },
  })
}

// ---- decide -------------------------------------------------------------------------------------------------------------

/** The version of this operation (404 otherwise), read before the command. */
async function versionFor(caller: CommandCaller, operationId: string, versionId: string): Promise<MinutesOperationRow> {
  const operation = await readOperationFor(caller, operationId)
  if (!isUuid(versionId)) throw new NotFoundError('SMV version not found.')
  const found = await caller.withClient((client) => client.operationTimeVersion.findUnique({ where: { id: versionId }, select: { operationId: true } }))
  if (!found || found.operationId !== operationId) throw new NotFoundError('SMV version not found.')
  return operation
}

function assertMayDecide(caller: CommandCaller, operation: MinutesOperationRow) {
  const context = assertOffice(caller)
  if (!mayDecide(context, operation.companyId)) {
    throw new ForbiddenError(operation.companyId === null ? 'An SMV change of an operation for every company is decided only by a role over every company.' : undefined)
  }
  return context
}

/**
 * The version as it is decided (the operation locked first, so no record guard on the version: a proposal that replaces it
 * locks the operation too): at the version the caller read, still waiting, not the decider's own, in the order of first days.
 */
async function decidable(tools: CommandTools, operationId: string, versionId: string, deciderId: string, decision: 'APPROVE' | 'REJECT', sentVersion: number) {
  const versions = await readVersions(tools.tx, operationId)
  const version = versions.find((entry) => entry.id === versionId)
  if (!version) throw new NotFoundError('SMV version not found.')
  if (version.row.version !== sentVersion) throw new StaleVersionError('OperationTimeVersion', versionId, version.row.version, sentVersion)
  const refusal = decisionRefusal(version, deciderId, decision, versions)
  if (refusal?.code === 'OWN_PROPOSAL') throw new ForbiddenError(refusal.message)
  if (refusal) throw new InvalidStateError(refusal.message)
  return version
}

/** POST …/minutes/versions/:versionId/approve */
export async function approveVersion(caller: CommandCaller, operationId: string, versionId: string, body: ApproveBody, idempotencyKey?: string): Promise<{ minutes: OperationMinutesView; tookEffect: boolean }> {
  const seen = await versionFor(caller, operationId, versionId)
  const context = assertMayDecide(caller, seen)
  const deciderId = actorIdOf(context)!
  const { result } = await command(
    caller,
    { name: 'product.smv.approve', idempotencyKey, input: { operationId, versionId, ...body } },
    async (tools) => {
      const { tx, now } = tools
      const operation = await lockOperation(tx, operationId)
      const version = await decidable(tools, operationId, versionId, deciderId, 'APPROVE', body.version)
      const note = body.note?.trim() || null
      await tx.operationTimeVersion.update({ where: { id: versionId }, data: { status: 'APPROVED', decidedById: deciderId, decidedAt: now, decisionNote: note, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ action: 'product.smv.approve', recordType: 'OperationTimeVersion', recordId: versionId, companyId: operation.companyId, before: { status: 'PROPOSED' }, after: { status: 'APPROVED', note } })
      emitVersion(tools, operation, version, 'APPROVED', 'APPROVED')
      const settled = await settleOperation(tools, operation, 'APPROVAL')
      return { minutes: await operationMinutesInTx(tx, context, operationId, todayOf(now)), tookEffect: settled.tookEffect === versionId }
    },
  )
  return result
}

/** POST …/minutes/versions/:versionId/reject */
export async function rejectVersion(caller: CommandCaller, operationId: string, versionId: string, body: RejectBody, idempotencyKey?: string): Promise<{ minutes: OperationMinutesView }> {
  const seen = await versionFor(caller, operationId, versionId)
  const context = assertMayDecide(caller, seen)
  const deciderId = actorIdOf(context)!
  const problems = rejectionProblems(body.note)
  if (problems.length > 0) throw invalid('Say why the proposal is rejected.', prefixed(problems))
  const { result } = await command(
    caller,
    { name: 'product.smv.reject', idempotencyKey, input: { operationId, versionId, ...body } },
    async (tools) => {
      const { tx, now } = tools
      const operation = await lockOperation(tx, operationId)
      const version = await decidable(tools, operationId, versionId, deciderId, 'REJECT', body.version)
      const note = body.note.trim()
      await tx.operationTimeVersion.update({ where: { id: versionId }, data: { status: 'REJECTED', decidedById: deciderId, decidedAt: now, decisionNote: note, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ action: 'product.smv.reject', recordType: 'OperationTimeVersion', recordId: versionId, companyId: operation.companyId, before: { status: 'PROPOSED' }, after: { status: 'REJECTED' }, reason: note })
      emitVersion(tools, operation, version, 'REJECTED', 'REJECTED')
      return { minutes: await operationMinutesInTx(tx, context, operationId, todayOf(now)) }
    },
  )
  return result
}
