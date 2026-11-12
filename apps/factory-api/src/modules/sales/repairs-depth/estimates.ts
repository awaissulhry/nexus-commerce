import type { Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { isCurrencyCode } from '@nexus/factory-domain/core/money'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, parseInstant, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_REPAIRS_MANAGE } from '@nexus/factory-domain/sales/repairs/permissions'
import type { RepairStage } from '@nexus/factory-domain/sales/repairs/rules'
import {
  answerHeld,
  DEPTH_LIMITS,
  draftHeld,
  editHeld,
  estimateActions,
  lineAmounts,
  lineProblems,
  LIVE_ESTIMATE,
  newestOf,
  sendHeld,
  withdrawHeld,
  workHeldByEstimate,
  type AnswerVia,
  type EstimateAnswer,
  type EstimateLineKind,
  type EstimateLineShape,
  type EstimateStatus,
} from '@nexus/factory-domain/sales/repairs-depth/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeRepair } from '../repairs/access'
import { lockRepair, moveStageInCommand } from '../repairs/stages'
import { peopleOf, readRepair, type RepairRow } from '../repairs/store'
import { dayOrNull, ESTIMATE_COLUMNS, estimatesOf, isoOrNull, itemsOf, LINE_COLUMNS, linesOf, officeLines, sumsOf, type EstimateRow, type LineRow, type Reader } from './store'

/**
 * A repair quote from parts and labour (B-W2b-342; SAL-387; design sales.returns rec "Repair order" › Estimate: "Parts and
 * labour, approved by the customer before work starts" · "Send estimate" · "Customer decision shown with time"):
 *
 *   GET    /sales/repairs/:repairId/estimates                  every revision, newest first, with its lines, sums and actions
 *   POST   /sales/repairs/:repairId/estimates                  a new revision (DRAFT): empty, a copy of the newest's lines, or
 *                                                              in place of the sent one (that one WITHDRAWN in the same command)
 *   PATCH  /sales/repairs/estimates/:estimateId               the terms while a draft (valid until, words to the customer,
 *                                                              currency); the internal note at any time
 *   POST   /sales/repairs/estimates/:estimateId/lines         a part or a job (a draft's); PATCH and DELETE …/lines/:lineId
 *   POST   /sales/repairs/estimates/:estimateId/send          DRAFT → SENT (one line at least, the garment here); the repair
 *                                                              received → estimated in the same command
 *   POST   /sales/repairs/estimates/:estimateId/answer        the customer's answer as the office heard it (OFFICE, who
 *                                                              recorded it, how): ACCEPTED approves the repair in the same command
 *   POST   /sales/repairs/estimates/:estimateId/withdraw      a draft or a sent one taken back
 *
 * Office only, sales.repairs.view to read and sales.repairs.manage to write over the repair's company, site and customer;
 * every write also needs the price grain (an estimate is prices: a role without them cannot write what it cannot see) and
 * runs as ONE command: the repair's row first when the stage may move (FOR UPDATE), then the estimate's (FOR UPDATE, at the
 * version the screen read), the change, its version moved on, audit rows (no amount: the estimate's own rows are the
 * record of its money) and events. The customer reads and answers a sent estimate in the portal (./portal.ts).
 */

export const PRICES_WORDS = 'An estimate is prices: your role does not see selling prices, so it cannot write one.'

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

function refuse(problems: readonly Issue[], words: string): never {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems)
}

function assertPrices(context: OfficeContext): void {
  if (!heldGrains(actorOf(context)).has('price')) throw new ForbiddenError(PRICES_WORDS)
}

const today = (now: Date = serverClock.now()): BusinessDate => businessDate(now)

const asDay = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)

/** The estimate the office caller sees (through its repair) and acts on with `permission`. */
async function officeEstimate(caller: CommandCaller, estimateId: string, permission: Permission = SALES_REPAIRS_MANAGE) {
  const row = isUuid(estimateId) ? await caller.withClient((client) => client.repairEstimate.findUnique({ where: { id: estimateId }, select: { repairId: true } })) : null
  if (!row) throw new NotFoundError('Estimate not found.')
  const { context, repair } = await officeRepair(caller, row.repairId, permission).catch((error: unknown) => {
    if (error instanceof NotFoundError) throw new NotFoundError('Estimate not found.')
    throw error
  })
  return { context, repair }
}

/** command()'s record guard by hand: the estimate's row FOR UPDATE, at the version the caller read. */
export async function lockEstimate(tools: Pick<CommandTools, 'tx'>, estimateId: string, expectedVersion: number | undefined): Promise<EstimateRow> {
  const [locked] = await tools.tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "RepairEstimate" WHERE "id" = ${estimateId}::uuid FOR UPDATE`
  if (!locked) throw new NotFoundError('Estimate not found.')
  if (expectedVersion !== undefined && locked.version !== expectedVersion) throw new StaleVersionError('RepairEstimate', estimateId, locked.version, expectedVersion)
  return (await tools.tx.repairEstimate.findUnique({ where: { id: estimateId }, select: ESTIMATE_COLUMNS }))!
}

const touchEstimate = (tools: Pick<CommandTools, 'tx' | 'now'>, estimate: Pick<EstimateRow, 'id'>, data: Prisma.RepairEstimateUncheckedUpdateInput = {}) =>
  tools.tx.repairEstimate.update({ where: { id: estimate.id }, data: { ...data, updatedAt: tools.now, version: { increment: 1 } }, select: ESTIMATE_COLUMNS })

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

const factsOf = (repair: Pick<RepairRow, 'number' | 'stage'>, estimate: Pick<EstimateRow, 'revision' | 'status' | 'validUntil'>, lines: number, now: Date) => ({
  repairNumber: repair.number,
  stage: repair.stage as RepairStage,
  revision: estimate.revision,
  status: estimate.status as EstimateStatus,
  lines,
  validUntil: dayOrNull(estimate.validUntil),
  today: today(now),
})

// ---- the view -----------------------------------------------------------------------------------------------------------

/** GET /sales/repairs/:repairId/estimates: every revision of the repair, newest first, with what may be done. */
export async function estimatesView(db: Reader, repair: RepairRow, context: OfficeContext, now: Date = serverClock.now()) {
  const estimates = await estimatesOf(db, repair.id)
  const lines = await linesOf(db, estimates.map((row) => row.id))
  const items = await itemsOf(db, [...lines.values()].flat())
  const newest = newestOf(estimates.map((row) => ({ ...row, status: row.status as EstimateStatus })))
  const live = estimates.find((row) => LIVE_ESTIMATE.includes(row.status as EstimateStatus)) ?? null
  const grains = heldGrains(actorOf(context))
  const newHeld = draftHeld({ repairNumber: repair.number, stage: repair.stage as RepairStage, live: live ? { revision: live.revision, status: live.status as EstimateStatus } : null, replaces: live?.status === 'SENT' })
  return {
    repair: { id: repair.id, number: repair.number, stage: repair.stage, version: repair.version, partyId: repair.partyId },
    estimates: estimates.map((row) => {
      const own = lines.get(row.id) ?? []
      return {
        id: row.id,
        revision: row.revision,
        status: row.status,
        currency: row.currency,
        validUntil: dayOrNull(row.validUntil),
        customerNote: row.customerNote,
        internalNote: row.internalNote,
        sentAt: isoOrNull(row.sentAt),
        sentById: row.sentById,
        answeredAt: isoOrNull(row.answeredAt),
        answeredVia: row.answeredVia,
        answeredByName: row.answeredByName,
        recordedById: row.recordedById,
        declineReason: row.declineReason,
        withdrawnAt: isoOrNull(row.withdrawnAt),
        withdrawnById: row.withdrawnById,
        version: row.version,
        createdAt: toUtcIso(row.createdAt),
        createdById: row.createdById,
        lines: officeLines(own, items),
        summary: sumsOf(own),
        actions: estimateActions({ ...factsOf(repair, row, own.length, now), newest: newest?.id === row.id }),
      }
    }),
    liveId: live?.id ?? null,
    newEstimate: { allowed: newHeld === null && grains.has('price'), held: newHeld ?? (grains.has('price') ? null : PRICES_WORDS), replaces: live?.status === 'SENT' ? live.id : null },
    workHeld: {
      approve: workHeldByEstimate(repair.number, 'APPROVED', newest ? { revision: newest.revision, status: newest.status } : null),
      startRepair: workHeldByEstimate(repair.number, 'IN_REPAIR', newest ? { revision: newest.revision, status: newest.status } : null),
    },
    seesPrices: grains.has('price'),
    seesCosts: grains.has('cost'),
    people: await peopleOf(db, estimates.flatMap((row) => [row.createdById, row.sentById, row.recordedById, row.withdrawnById])),
  }
}

export type EstimatesView = Awaited<ReturnType<typeof estimatesView>>

async function viewOf(caller: CommandCaller, repairId: string): Promise<EstimatesView> {
  const { context, repair } = await officeRepair(caller, repairId)
  return caller.withClient(async (client) => estimatesView(client, (await readRepair(client, repair.id))!, context))
}

export async function getEstimates(caller: CommandCaller, repairId: string): Promise<EstimatesView> {
  return viewOf(caller, repairId)
}

// ---- a new revision -----------------------------------------------------------------------------------------------------

export interface NewEstimateBody {
  /** The sent estimate this one replaces (it is withdrawn); required when one waits for its answer. */
  readonly replaces?: string | null | undefined
  /** Copy the lines of the estimate it replaces, else of the newest one. */
  readonly copyLines?: boolean | undefined
  readonly currency?: string | undefined
  readonly validUntil?: BusinessDate | null | undefined
  readonly customerNote?: string | null | undefined
  readonly internalNote?: string | null | undefined
}

function termsProblems(body: { readonly currency?: string | undefined; readonly validUntil?: BusinessDate | null | undefined; readonly customerNote?: string | null | undefined; readonly internalNote?: string | null | undefined }, now: Date): Issue[] {
  const problems: Issue[] = []
  if (body.currency !== undefined && !isCurrencyCode(body.currency)) problems.push({ path: 'body/currency', message: 'An ISO 4217 currency code (EUR).' })
  if (body.validUntil && body.validUntil < today(now)) problems.push({ path: 'body/validUntil', message: 'Today or a later day.' })
  if ((blank(body.customerNote) ?? '').length > DEPTH_LIMITS.customerNote) problems.push({ path: 'body/customerNote', message: `At most ${DEPTH_LIMITS.customerNote} characters.` })
  if ((blank(body.internalNote) ?? '').length > DEPTH_LIMITS.internalNote) problems.push({ path: 'body/internalNote', message: `At most ${DEPTH_LIMITS.internalNote} characters.` })
  return problems
}

/** Withdraws a live estimate inside the caller's command (its version moved on, audit, event). */
async function withdrawInCommand(tools: CommandTools, repair: RepairRow, estimate: EstimateRow, reason: string | null): Promise<void> {
  await touchEstimate(tools, estimate, { status: 'WITHDRAWN', withdrawnAt: tools.now, withdrawnById: actorIdOf(tools) })
  tools.audit({ action: 'repairsDepth.estimateWithdraw', recordType: 'RepairEstimate', recordId: estimate.id, companyId: repair.companyId, siteId: repair.siteId, before: { status: estimate.status }, after: { status: 'WITHDRAWN', repairId: repair.id, revision: estimate.revision }, ...(reason ? { reason } : {}) })
  tools.emit({ type: 'repair_estimate.withdrawn', subject: repair.id, companyId: repair.companyId, siteId: repair.siteId, payload: { repairId: repair.id, number: repair.number, estimateId: estimate.id, revision: estimate.revision, from: estimate.status as 'DRAFT' | 'SENT' } })
}

export async function createEstimate(caller: CommandCaller, repairId: string, body: NewEstimateBody, idempotencyKey?: string): Promise<EstimatesView> {
  const { context, repair: seen } = await officeRepair(caller, repairId, SALES_REPAIRS_MANAGE)
  assertPrices(context)
  await command(caller, { name: 'repairsDepth.estimateCreate', idempotencyKey, input: { repairId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const repair = await lockRepair(tools, seen.id, undefined)
    const problems = termsProblems(body, now)
    if (problems.length > 0) refuse(problems, 'The estimate cannot be made like this.')
    const estimates = await estimatesOf(tx, repair.id)
    const live = estimates.find((row) => LIVE_ESTIMATE.includes(row.status as EstimateStatus)) ?? null
    if (body.replaces && (!live || live.id !== body.replaces || live.status !== 'SENT')) throw new InvalidStateError(live ? `Estimate ${live.revision} is the live one: the new one replaces only a sent estimate.` : 'No estimate waits for an answer: make the new one without replacing.')
    const held = draftHeld({ repairNumber: repair.number, stage: repair.stage as RepairStage, live: live ? { revision: live.revision, status: live.status as EstimateStatus } : null, replaces: !!body.replaces })
    if (held) throw new InvalidStateError(held)
    if (live && body.replaces) await withdrawInCommand(tools, repair, live, 'Replaced by a new revision.')
    const source = body.replaces ? live : body.copyLines ? (estimates[0] ?? null) : null
    const copied = source ? ((await linesOf(tx, [source.id])).get(source.id) ?? []) : []
    const revision = (estimates[0]?.revision ?? 0) + 1
    const id = newId()
    await tx.repairEstimate.create({
      data: {
        id,
        companyId: repair.companyId,
        siteId: repair.siteId,
        partyId: repair.partyId,
        repairId: repair.id,
        revision,
        currency: body.currency ?? source?.currency ?? estimates[0]?.currency ?? 'EUR',
        validUntil: body.validUntil ? asDay(body.validUntil) : null,
        customerNote: blank(body.customerNote) ?? source?.customerNote ?? null,
        internalNote: blank(body.internalNote),
        createdAt: now,
        updatedAt: now,
        createdById: actorIdOf(tools),
      },
      select: { id: true },
    })
    for (const line of copied) {
      await tx.repairEstimateLine.create({ data: { id: newId(), partyId: repair.partyId, estimateId: id, seq: line.seq, kind: line.kind, itemId: line.itemId, description: line.description, quantity: line.quantity, minutes: line.minutes, unitPrice: line.unitPrice, amount: line.amount, unitCost: line.unitCost, costAmount: line.costAmount, createdAt: now, updatedAt: now, createdById: actorIdOf(tools) }, select: { id: true } })
    }
    tools.audit({ action: 'repairsDepth.estimateCreate', recordType: 'RepairEstimate', recordId: id, companyId: repair.companyId, siteId: repair.siteId, after: { repairId: repair.id, revision, status: 'DRAFT', copiedFrom: source?.id ?? null, lines: copied.length, replaces: body.replaces ?? null } })
    return { estimateId: id }
  })
  return viewOf(caller, seen.id)
}

// ---- the terms ----------------------------------------------------------------------------------------------------------

export interface TermsBody {
  readonly version: number
  readonly currency?: string | undefined
  readonly validUntil?: BusinessDate | null | undefined
  readonly customerNote?: string | null | undefined
  readonly internalNote?: string | null | undefined
}

export async function changeEstimate(caller: CommandCaller, estimateId: string, body: TermsBody, idempotencyKey?: string): Promise<EstimatesView> {
  const { context, repair: seen } = await officeEstimate(caller, estimateId)
  assertPrices(context)
  await command(caller, { name: 'repairsDepth.estimateChange', idempotencyKey, input: { estimateId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const estimate = await lockEstimate(tools, estimateId, body.version)
    const repair = (await readRepair(tx, seen.id))!
    const problems = termsProblems(body, now)
    if (problems.length > 0) refuse(problems, 'The estimate cannot be changed like this.')
    const terms = body.currency !== undefined || body.validUntil !== undefined || body.customerNote !== undefined
    const held = terms ? editHeld(factsOf(repair, estimate, 0, now)) : null
    if (held) throw new InvalidStateError(held)
    const data: Prisma.RepairEstimateUncheckedUpdateInput = {}
    if (body.currency !== undefined) data.currency = body.currency
    if (body.validUntil !== undefined) data.validUntil = body.validUntil ? asDay(body.validUntil) : null
    if (body.customerNote !== undefined) data.customerNote = blank(body.customerNote)
    if (body.internalNote !== undefined) data.internalNote = blank(body.internalNote)
    if (data.currency !== undefined && data.currency !== estimate.currency && (await tx.repairEstimateLine.count({ where: { estimateId } })) > 0) {
      refuse([{ path: 'body/currency', message: 'The lines are in the estimate’s currency: change it before adding lines.' }], 'The currency cannot change now.')
    }
    await touchEstimate(tools, estimate, data)
    tools.audit({ action: 'repairsDepth.estimateChange', recordType: 'RepairEstimate', recordId: estimate.id, companyId: repair.companyId, siteId: repair.siteId, before: { currency: estimate.currency, validUntil: dayOrNull(estimate.validUntil) }, after: { currency: data.currency, validUntil: body.validUntil, customerNote: data.customerNote, internalNote: data.internalNote, fields: Object.keys(data) } })
    return null
  })
  return viewOf(caller, seen.id)
}

// ---- the lines ----------------------------------------------------------------------------------------------------------

export interface LineBody {
  readonly version: number
  readonly kind?: EstimateLineKind | undefined
  readonly itemId?: string | null | undefined
  readonly description?: string | undefined
  readonly quantity?: string | undefined
  readonly minutes?: number | null | undefined
  readonly unitPrice?: string | undefined
  readonly unitCost?: string | null | undefined
}

async function checkItem(tx: CommandTools['tx'], itemId: string | null | undefined, problems: Issue[]): Promise<{ name: string } | null> {
  if (!itemId) return null
  const item = isUuid(itemId) ? await tx.item.findUnique({ where: { id: itemId }, select: { name: true } }) : null
  if (!item) problems.push({ path: 'body/itemId', message: 'Not an item of ours.' })
  return item
}

/** A line's values after the change, checked; its amounts computed in the estimate's currency. */
async function plannedLine(tx: CommandTools['tx'], estimate: EstimateRow, before: LineRow | null, body: LineBody) {
  const problems: Issue[] = []
  const kind = body.kind ?? before?.kind ?? null
  if (!kind) problems.push({ path: 'body/kind', message: 'A part or labour.' })
  if (body.unitPrice === undefined && !before) problems.push({ path: 'body/unitPrice', message: 'The price per unit to the customer.' })
  if (body.quantity === undefined && !before) problems.push({ path: 'body/quantity', message: 'The quantity.' })
  const itemId = body.itemId !== undefined ? body.itemId : (before?.itemId ?? null)
  const item = await checkItem(tx, kind === 'PART' ? itemId : null, problems)
  if (problems.length > 0) refuse(problems, 'The line cannot be written like this.')
  const shape: EstimateLineShape = {
    kind: kind!,
    itemId: kind === 'LABOUR' ? (body.itemId ?? null) : itemId,
    description: body.description !== undefined ? body.description : (before?.description ?? item?.name ?? ''),
    quantity: body.quantity ?? before!.quantity.toFixed(),
    minutes: body.minutes !== undefined ? body.minutes : kind === before?.kind ? (before?.minutes ?? null) : null,
    unitPrice: body.unitPrice ?? before!.unitPrice.toFixed(),
    unitCost: body.unitCost !== undefined ? body.unitCost : (before?.unitCost?.toFixed() ?? null),
  }
  const shapeProblems = lineProblems(shape)
  if (shapeProblems.length > 0) refuse(shapeProblems, 'The line cannot be written like this.')
  return { shape, amounts: lineAmounts(shape, estimate.currency) }
}

async function lineCommand(caller: CommandCaller, estimateId: string, name: `${string}.${string}`, body: { readonly version: number }, idempotencyKey: string | undefined, input: Record<string, unknown>, work: (tools: CommandTools, estimate: EstimateRow, repair: RepairRow) => Promise<{ before: unknown; after: unknown }>): Promise<EstimatesView> {
  const { context, repair: seen } = await officeEstimate(caller, estimateId)
  assertPrices(context)
  await command(caller, { name, idempotencyKey, input: { estimateId, ...input } }, async (tools) => {
    const estimate = await lockEstimate(tools, estimateId, body.version)
    const repair = (await readRepair(tools.tx, seen.id))!
    const held = editHeld(factsOf(repair, estimate, 0, tools.now))
    if (held) throw new InvalidStateError(held)
    const { before, after } = await work(tools, estimate, repair)
    await touchEstimate(tools, estimate)
    tools.audit({ action: name, recordType: 'RepairEstimate', recordId: estimate.id, companyId: repair.companyId, siteId: repair.siteId, before: before as Record<string, unknown> | null, after: after as Record<string, unknown> | null })
    return null
  })
  return viewOf(caller, seen.id)
}

/** The audit's picture of a line: what it is, never its money (the line's own row is the record of that). */
const lineAudit = (line: { readonly seq: number; readonly kind: string; readonly description: string; readonly quantity: string; readonly minutes: number | null; readonly itemId: string | null }) => ({ seq: line.seq, kind: line.kind, description: line.description, quantity: line.quantity, minutes: line.minutes, itemId: line.itemId })

export async function addLine(caller: CommandCaller, estimateId: string, body: LineBody, idempotencyKey?: string): Promise<EstimatesView> {
  return lineCommand(caller, estimateId, 'repairsDepth.lineAdd', body, idempotencyKey, { ...body }, async (tools, estimate) => {
    const count = await tools.tx.repairEstimateLine.count({ where: { estimateId } })
    if (count >= DEPTH_LIMITS.lines) throw new InvalidStateError(`An estimate holds at most ${DEPTH_LIMITS.lines} lines.`)
    const { shape, amounts } = await plannedLine(tools.tx, estimate, null, body)
    const last = await tools.tx.repairEstimateLine.findFirst({ where: { estimateId }, select: { seq: true }, orderBy: { seq: 'desc' } })
    const seq = (last?.seq ?? 0) + 10
    await tools.tx.repairEstimateLine.create({
      data: { id: newId(), partyId: estimate.partyId, estimateId, seq, kind: shape.kind, itemId: shape.itemId ?? null, description: shape.description.trim(), quantity: shape.quantity, minutes: shape.minutes ?? null, unitPrice: shape.unitPrice, amount: amounts.amount, unitCost: shape.unitCost ?? null, costAmount: amounts.costAmount, createdAt: tools.now, updatedAt: tools.now, createdById: actorIdOf(tools) },
      select: { id: true },
    })
    return { before: null, after: lineAudit({ seq, kind: shape.kind, description: shape.description.trim(), quantity: shape.quantity, minutes: shape.minutes ?? null, itemId: shape.itemId ?? null }) }
  })
}

async function lineOf(tx: CommandTools['tx'], estimateId: string, lineId: string): Promise<LineRow> {
  const line = isUuid(lineId) ? await tx.repairEstimateLine.findFirst({ where: { id: lineId, estimateId }, select: LINE_COLUMNS }) : null
  if (!line) throw new NotFoundError('Line not found.')
  return line
}

export async function changeLine(caller: CommandCaller, estimateId: string, lineId: string, body: LineBody, idempotencyKey?: string): Promise<EstimatesView> {
  return lineCommand(caller, estimateId, 'repairsDepth.lineChange', body, idempotencyKey, { lineId, ...body }, async (tools, estimate) => {
    const before = await lineOf(tools.tx, estimateId, lineId)
    const { shape, amounts } = await plannedLine(tools.tx, estimate, before, body)
    await tools.tx.repairEstimateLine.update({
      where: { id: lineId },
      data: { kind: shape.kind, itemId: shape.itemId ?? null, description: shape.description.trim(), quantity: shape.quantity, minutes: shape.minutes ?? null, unitPrice: shape.unitPrice, amount: amounts.amount, unitCost: shape.unitCost ?? null, costAmount: amounts.costAmount, updatedAt: tools.now, version: { increment: 1 } },
      select: { id: true },
    })
    return { before: lineAudit({ ...before, quantity: before.quantity.toFixed() }), after: lineAudit({ seq: before.seq, kind: shape.kind, description: shape.description.trim(), quantity: shape.quantity, minutes: shape.minutes ?? null, itemId: shape.itemId ?? null }) }
  })
}

export async function removeLine(caller: CommandCaller, estimateId: string, lineId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<EstimatesView> {
  return lineCommand(caller, estimateId, 'repairsDepth.lineRemove', body, idempotencyKey, { lineId, ...body }, async (tools) => {
    const before = await lineOf(tools.tx, estimateId, lineId)
    await tools.tx.repairEstimateLine.delete({ where: { id: lineId } })
    return { before: lineAudit({ ...before, quantity: before.quantity.toFixed() }), after: null }
  })
}

// ---- send, answer, withdraw ---------------------------------------------------------------------------------------------

/** POST …/send: the estimate SENT (its terms and lines frozen: what the customer sees); a received repair is estimated. */
export async function sendEstimate(caller: CommandCaller, estimateId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<EstimatesView> {
  const { context, repair: seen } = await officeEstimate(caller, estimateId)
  assertPrices(context)
  await command(caller, { name: 'repairsDepth.estimateSend', idempotencyKey, input: { estimateId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const repair = await lockRepair(tools, seen.id, undefined)
    const estimate = await lockEstimate(tools, estimateId, body.version)
    const lines = await tx.repairEstimateLine.count({ where: { estimateId } })
    const held = sendHeld(factsOf(repair, estimate, lines, now))
    if (held) throw new InvalidStateError(held)
    // The withdrawn revision it replaced, if any (for the event).
    const replaced = await tx.repairEstimate.findFirst({ where: { repairId: repair.id, status: 'WITHDRAWN', revision: { lt: estimate.revision } }, select: { id: true, sentAt: true }, orderBy: { revision: 'desc' } })
    await touchEstimate(tools, estimate, { status: 'SENT', sentAt: now, sentById: actorIdOf(tools) })
    tools.audit({ action: 'repairsDepth.estimateSend', recordType: 'RepairEstimate', recordId: estimate.id, companyId: repair.companyId, siteId: repair.siteId, before: { status: 'DRAFT' }, after: { status: 'SENT', sentAt: toUtcIso(now), repairId: repair.id, revision: estimate.revision, lines } })
    tools.emit({ type: 'repair_estimate.sent', subject: repair.id, companyId: repair.companyId, siteId: repair.siteId, payload: { repairId: repair.id, number: repair.number, estimateId: estimate.id, revision: estimate.revision, partyId: repair.partyId, replacedEstimateId: replaced?.sentAt ? replaced.id : null } })
    if (repair.stage === 'RECEIVED') await moveStageInCommand(tools, repair, 'ESTIMATED', { note: `Estimate ${estimate.revision} sent to the customer.`, audit: { estimateId: estimate.id, revision: estimate.revision } })
    return null
  })
  return viewOf(caller, seen.id)
}

export interface AnswerInput {
  readonly answer: EstimateAnswer
  readonly via: AnswerVia
  readonly at: Date
  readonly byName: string | null
  readonly recordedById: string | null
  readonly declineReason: string | null
  /** How the answer reached us, for the stage note (the office's words), or null. */
  readonly how: string | null
}

/**
 * The customer's answer inside the caller's command (the office's record or the portal's): the repair row and the
 * estimate's locked by the caller, the answer checked, written once, and an acceptance moves the repair to approved with
 * a note that names the estimate (never its amount).
 */
export async function answerInCommand(tools: CommandTools, repair: RepairRow, estimate: EstimateRow, input: AnswerInput): Promise<void> {
  const held = answerHeld(factsOf(repair, estimate, 1, tools.now))
  if (held) throw new InvalidStateError(held)
  const problems: Issue[] = []
  if (input.at.getTime() > tools.now.getTime() + 5 * 60_000) problems.push({ path: 'body/at', message: 'The answer came now or earlier.' })
  if (estimate.sentAt && input.at.getTime() < estimate.sentAt.getTime()) problems.push({ path: 'body/at', message: 'The answer came after the estimate was sent.' })
  if (input.answer === 'DECLINED' && !input.declineReason) problems.push({ path: 'body/declineReason', message: "Say why the customer declined, in their words." })
  if ((input.declineReason ?? '').length > DEPTH_LIMITS.declineReason) problems.push({ path: 'body/declineReason', message: `At most ${DEPTH_LIMITS.declineReason} characters.` })
  if ((input.byName ?? '').length > DEPTH_LIMITS.answeredByName) problems.push({ path: 'body/answeredByName', message: `At most ${DEPTH_LIMITS.answeredByName} characters.` })
  if (problems.length > 0) refuse(problems, 'The answer cannot be recorded like this.')
  const at = input.at.getTime() > tools.now.getTime() ? tools.now : input.at
  await touchEstimate(tools, estimate, {
    status: input.answer,
    answeredAt: at,
    answeredVia: input.via,
    answeredByName: input.byName,
    recordedById: input.via === 'OFFICE' ? input.recordedById : null,
    declineReason: input.answer === 'DECLINED' ? input.declineReason : null,
  })
  tools.audit({
    action: 'repairsDepth.estimateAnswer',
    recordType: 'RepairEstimate',
    recordId: estimate.id,
    companyId: repair.companyId,
    siteId: repair.siteId,
    before: { status: 'SENT' },
    after: { status: input.answer, answeredAt: toUtcIso(at), answeredVia: input.via, answeredByName: input.byName, repairId: repair.id, revision: estimate.revision, ...(input.how ? { how: input.how } : {}), ...(input.via !== 'OFFICE' ? { byPartner: true } : {}) },
    ...(input.declineReason ? { reason: input.declineReason } : {}),
  })
  tools.emit({ type: 'repair_estimate.answered', subject: repair.id, companyId: repair.companyId, siteId: repair.siteId, payload: { repairId: repair.id, number: repair.number, estimateId: estimate.id, revision: estimate.revision, partyId: repair.partyId, answer: input.answer, via: input.via } })
  if (input.answer === 'ACCEPTED') {
    const how = input.via === 'OFFICE' ? `recorded by the office${input.how ? `: ${input.how}` : ''}` : input.via === 'PORTAL' ? 'in the portal' : 'by link'
    await moveStageInCommand(tools, repair, 'APPROVED', { note: `Estimate ${estimate.revision} accepted by the customer (${how}).`.slice(0, 1000), audit: { estimateId: estimate.id, revision: estimate.revision, answeredVia: input.via } })
  }
}

export interface OfficeAnswerBody {
  readonly version: number
  readonly answer: EstimateAnswer
  /** How the office heard it ("by phone", "by e-mail of 12 Nov"): needed. */
  readonly how: string
  readonly at?: string | undefined
  /** The customer's person who answered, as they gave it. */
  readonly answeredByName?: string | null | undefined
  readonly declineReason?: string | null | undefined
}

/** POST …/answer: the customer's answer as the office heard it. */
export async function recordAnswer(caller: CommandCaller, estimateId: string, body: OfficeAnswerBody, idempotencyKey?: string): Promise<EstimatesView> {
  const { context, repair: seen } = await officeEstimate(caller, estimateId)
  assertPrices(context)
  const how = blank(body.how)
  if (!how || how.length > DEPTH_LIMITS.how) refuse([{ path: 'body/how', message: `Say how the customer answered (by phone, by e-mail …), at most ${DEPTH_LIMITS.how} characters.` }], 'Say how the customer answered.')
  await command(caller, { name: 'repairsDepth.estimateAnswer', idempotencyKey, input: { estimateId, ...body } }, async (tools) => {
    const repair = await lockRepair(tools, seen.id, undefined)
    const estimate = await lockEstimate(tools, estimateId, body.version)
    const at = body.at ? parseInstant(body.at) : tools.now
    if (!at) refuse([{ path: 'body/at', message: 'An ISO 8601 time with its zone.' }], 'The time is not valid.')
    await answerInCommand(tools, repair, estimate, { answer: body.answer, via: 'OFFICE', at: at!, byName: blank(body.answeredByName), recordedById: context.actorId, declineReason: blank(body.declineReason), how })
    return null
  })
  return viewOf(caller, seen.id)
}

/** POST …/withdraw: a draft or a sent estimate taken back. */
export async function withdrawEstimate(caller: CommandCaller, estimateId: string, body: { readonly version: number; readonly reason?: string | null | undefined }, idempotencyKey?: string): Promise<EstimatesView> {
  const { context, repair: seen } = await officeEstimate(caller, estimateId)
  assertPrices(context)
  await command(caller, { name: 'repairsDepth.estimateWithdraw', idempotencyKey, input: { estimateId, ...body } }, async (tools) => {
    const repair = (await readRepair(tools.tx, seen.id))!
    const estimate = await lockEstimate(tools, estimateId, body.version)
    const held = withdrawHeld(factsOf(repair, estimate, 0, tools.now))
    if (held) throw new InvalidStateError(held)
    const reason = blank(body.reason)
    if (reason && reason.length > DEPTH_LIMITS.how) refuse([{ path: 'body/reason', message: `At most ${DEPTH_LIMITS.how} characters.` }], 'The reason is too long.')
    await withdrawInCommand(tools, repair, estimate, reason)
    return null
  })
  return viewOf(caller, seen.id)
}
