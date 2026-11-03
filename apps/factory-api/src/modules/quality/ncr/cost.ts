import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { QUALITY_NCR_MANAGE } from '@nexus/factory-domain/quality/ncr/permissions'
import {
  COST_LIMITS,
  computePlan,
  costHeld,
  costLineProblems,
  costTotal,
  otherNeedsWords,
  planIsEmpty,
  type ComputedLine,
  type CostKind,
  type CostSource,
} from '@nexus/factory-domain/quality/ncr/cost'
import { valueOf } from '@nexus/factory-domain/quality/ncr/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { lotCostOf } from '../../purchasing/claims/store'
import { emitChanged, may, refuse, visibleNcr } from './ncr'
import { COST_LINE_COLUMNS, lockNcr, NCR_RECORD, readCostLines, readDecisions, readNcr, seesCost, type CostLineRow, type NcrRow, type Reader } from './store'

/**
 * The NCR's cost (B-W2b-113; QHS-086; design quality.ncr record tab "Cost" ncr-cost). Every amount is the cost grain: the
 * office reader needs quality.ncr.view and the cost grain at the NCR's site (the tab is absent otherwise: "You need the
 * cost grain to see costs"), a writer quality.ncr.manage and the grain; the contract marks every amount money.cost, so the
 * API drops it for anyone else and refuses a request that sends one without it. Never the floor, never a partner, never a
 * report or letter that leaves the company.
 *
 *   GET    /quality/ncr/:ncrId/cost                    the lines, the total, the computed lines' state, what waits
 *   POST   /quality/ncr/:ncrId/cost/lines              a typed line (kind, words, amount)
 *   PATCH  /quality/ncr/:ncrId/cost/lines/:lineId      a typed line changed (its own version: the tab saves line by line)
 *   DELETE /quality/ncr/:ncrId/cost/lines/:lineId      a typed line removed
 *   POST   /quality/ncr/:ncrId/cost/compute            the computed lines brought up to date (one per record)
 *
 * Each write is ONE command: the NCR's row locked first (FOR UPDATE: two cost writes of one NCR take turns, the close
 * waits) without moving the NCR's version (the Problem tab's open form is not made stale by a cost line), the line at its
 * own version, the audit (amounts marked money.cost), ncr.changed {fields: ['cost']} (no amount in the event). The database
 * refuses every write once the NCR is closed or cancelled (NcrCostLine_guard): refused here first, in words.
 *
 * Computed (factory-domain quality/ncr/cost): SCRAP_VALUE per SCRAP decision (carried out: the moves it posted, valued by
 * the cost ledger or the stock valuation; not yet: the lot's valuation × the quantity decided) and per rework order opened
 * for the NCR that ended in scrap (the ledger's SCRAP entries it posted); a record not valued yet waits, said in words.
 */

const NO_COST = 'An NCR\'s cost is shown only with the cost grain (see costs) at its site.'

/** The NCR the caller sees, with the cost grain there (and the right named, when given). */
async function costNcr(caller: CommandCaller, ncrId: string, permission?: typeof QUALITY_NCR_MANAGE): Promise<{ context: OfficeContext; row: NcrRow }> {
  const { context, row } = await visibleNcr(caller, ncrId, permission)
  if (!seesCost(context, row)) throw new ForbiddenError(NO_COST)
  return { context, row }
}

/** Inside the command: the NCR's row FOR UPDATE (no version bump), neither closed nor cancelled. */
async function lockForCost(tools: CommandTools, ncrId: string): Promise<NcrRow> {
  const locked = await lockNcr(tools.tx, ncrId)
  if (!locked) throw new NotFoundError('NCR not found.')
  const held = costHeld(locked.stage)
  if (held) throw new InvalidStateError(held)
  return (await readNcr(tools.tx, ncrId))!
}

// ---- computing --------------------------------------------------------------------------------------------------------

interface Computed {
  readonly lines: ComputedLine[]
  readonly waiting: { recordType: string; recordId: string; label: string | null; words: string }[]
  readonly labels: Map<string, string>
}

/** What the cost ledger and the stock valuation say the NCR cost now (factory-domain cost.ts's "what is computed"). */
async function computeLines(db: Reader, row: NcrRow): Promise<Computed> {
  const company = await db.company.findUnique({ where: { id: row.companyId }, select: { currency: true } })
  const currency = company?.currency ?? 'EUR'
  const lines: ComputedLine[] = []
  const waiting: Computed['waiting'] = []
  const labels = new Map<string, string>()

  // Each SCRAP decision: carried out, the SCRAP moves it posted (each keeps its first; all of them carry the NCR's number and
  // the time it was carried out); not yet, the lot's valuation × the quantity decided.
  const decisions = await readDecisions(db, [row.id])
  const codes = decisions.length === 0 ? [] : await db.dispositionCode.findMany({ where: { id: { in: [...new Set(decisions.map((decision) => decision.dispositionCodeId))] } }, select: { id: true, code: true, stockMoveReason: true } })
  const codeOf = new Map(codes.map((code) => [code.id, code]))
  const item = row.itemId ? await db.item.findUnique({ where: { id: row.itemId }, select: { baseUom: true } }) : null
  for (const decision of decisions) {
    const code = codeOf.get(decision.dispositionCodeId)
    if (code?.stockMoveReason !== 'SCRAP') continue
    const label = `${decision.seq} · ${code.code}`
    labels.set(decision.id, label)
    let amount: number | null = null
    if (decision.doneAt) {
      const moves = await db.stockMove.findMany({
        where: { siteId: row.siteId, reason: 'SCRAP', OR: [...(decision.stockMoveId ? [{ id: decision.stockMoveId }] : []), { reference: row.number, createdAt: decision.doneAt }] },
        select: { id: true, siteId: true, lotId: true, baseQuantity: true },
        orderBy: { id: 'asc' },
      })
      const entries = moves.length === 0 ? [] : await db.workOrderCostEntry.findMany({ where: { stockMoveId: { in: moves.map((move) => move.id) }, kind: 'SCRAP' }, select: { stockMoveId: true, amount: true, currency: true } })
      let sum = 0
      let valued = moves.length > 0
      for (const move of moves) {
        const own = entries.filter((entry) => entry.stockMoveId === move.id)
        if (own.length > 0 && own.every((entry) => entry.currency === currency)) sum += own.reduce((total, entry) => total + entry.amount, 0)
        else if (own.length === 0 && move.lotId) {
          const cost = await lotCostOf(db as never, move.siteId, move.lotId)
          const value = cost && cost.currency === currency ? valueOf(move.baseQuantity.toString(), cost.unitCost) : null
          if (value === null) valued = false
          else sum += value
        } else valued = false
      }
      amount = valued ? sum : null
    } else if (row.lotId && item && item.baseUom === row.uom) {
      const cost = await lotCostOf(db as never, row.siteId, row.lotId)
      amount = cost && cost.currency === currency ? valueOf(decision.quantity.toString(), cost.unitCost) : null
    }
    if (amount === null || amount < 0) waiting.push({ recordType: 'NcrDispositionLine', recordId: decision.id, label, words: decision.doneAt ? 'The scrap it posted is not valued yet: it is computed once the cost ledger or the stock valuation knows it.' : 'Not carried out yet and its goods have no value to estimate from: it is computed once carried out.' })
    else lines.push({ kind: 'SCRAP_VALUE', recordType: 'NcrDispositionLine', recordId: decision.id, amount, description: '' })
  }

  // The rework orders opened for it that ended in scrap: the SCRAP entries the ledger posted for them (B-W2b-22).
  const reworks = await db.reworkOrder.findMany({ where: { siteId: row.siteId, recordType: NCR_RECORD, recordId: row.id, status: 'DONE', scrapQuantity: { gt: 0 } }, select: { id: true, scrapQuantity: true, workOrder: { select: { number: true } } }, orderBy: { id: 'asc' } })
  const reworkEntries = reworks.length === 0 ? [] : await db.workOrderCostEntry.findMany({ where: { sourceType: 'ReworkOrder', sourceId: { in: reworks.map((rework) => rework.id) }, kind: 'SCRAP' }, select: { sourceId: true, amount: true, currency: true } })
  for (const rework of reworks) {
    const label = rework.workOrder.number
    labels.set(rework.id, label)
    const entries = reworkEntries.filter((entry) => entry.sourceId === rework.id)
    const amount = entries.length > 0 && entries.every((entry) => entry.currency === currency) ? entries.reduce((sum, entry) => sum + entry.amount, 0) : null
    if (amount === null || amount < 0) waiting.push({ recordType: 'ReworkOrder', recordId: rework.id, label, words: 'The scrap of this rework is not in the cost ledger yet: it is computed once the ledger has posted it.' })
    else lines.push({ kind: 'SCRAP_VALUE', recordType: 'ReworkOrder', recordId: rework.id, amount, description: '' })
  }
  return { lines, waiting, labels }
}

/** The Cost tab (contract costView). */
async function sheetOf(db: Reader, row: NcrRow, context: OfficeContext) {
  const lines = await readCostLines(db, row.id)
  const company = await db.company.findUnique({ where: { id: row.companyId }, select: { currency: true } })
  const computed = await computeLines(db, row)
  const stored = lines.filter((line) => line.source === 'COMPUTED').map((line) => ({ id: line.id, recordType: line.recordType, recordId: line.recordId, kind: line.kind as CostKind, amount: line.amount, description: line.description }))
  const plan = computePlan(stored, computed.lines)
  // Labels of records a stored line names that the computation no longer finds.
  for (const line of lines) {
    if (!line.recordId || computed.labels.has(line.recordId)) continue
    if (line.recordType === 'NcrDispositionLine') {
      const decision = await db.ncrDispositionLine.findUnique({ where: { id: line.recordId }, select: { seq: true, dispositionCode: { select: { code: true } } } })
      if (decision) computed.labels.set(line.recordId, `${decision.seq} · ${decision.dispositionCode.code}`)
    } else if (line.recordType === 'ReworkOrder') {
      const rework = await db.reworkOrder.findUnique({ where: { id: line.recordId }, select: { workOrder: { select: { number: true } } } })
      if (rework) computed.labels.set(line.recordId, rework.workOrder.number)
    }
  }
  const held = costHeld(row.stage) ?? (may(context, QUALITY_NCR_MANAGE, row) ? null : "Changing the cost needs quality.ncr.manage at the NCR's site.")
  return {
    ncrId: row.id,
    number: row.number,
    currency: company?.currency ?? 'EUR',
    lines: lines.map((line) => lineView(line, computed.labels)),
    total: asMoney('cost', costTotal(lines)),
    computed: { upToDate: planIsEmpty(plan), add: plan.add.length, change: plan.change.length, remove: plan.remove.length, waiting: computed.waiting },
    held,
    version: row.version,
  }
}

function lineView(line: CostLineRow, labels: ReadonlyMap<string, string>) {
  return {
    id: line.id,
    seq: line.seq,
    kind: line.kind as CostKind,
    source: line.source as CostSource,
    description: line.description,
    amount: asMoney('cost', line.amount),
    record: line.recordType && line.recordId ? { type: line.recordType, id: line.recordId, label: labels.get(line.recordId) ?? null } : null,
    version: line.version,
    createdAt: line.createdAt.toISOString(),
    createdById: line.createdById,
    updatedAt: line.updatedAt.toISOString(),
  }
}

const sheetAfter = async (tools: CommandTools, ncrId: string, context: OfficeContext) => sheetOf(tools.tx, (await readNcr(tools.tx, ncrId))!, context)

// ---- routes -----------------------------------------------------------------------------------------------------------

/** GET /quality/ncr/:ncrId/cost */
export async function ncrCost(caller: CommandCaller, ncrId: string) {
  const { context, row } = await costNcr(caller, ncrId)
  return caller.withClient(async (client) => ({ sheet: await sheetOf(client, row, context) }))
}

export interface CostLineBody {
  readonly kind?: CostKind | undefined
  readonly description?: string | null | undefined
  readonly amount?: number | null | undefined
}

/** POST /quality/ncr/:ncrId/cost/lines: a typed line. */
export async function addCostLine(caller: CommandCaller, ncrId: string, body: CostLineBody, idempotencyKey?: string) {
  const { context, row } = await costNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  const held = costHeld(row.stage)
  if (held) throw new InvalidStateError(held)
  const { result } = await command(caller, { name: 'quality.addNcrCostLine', idempotencyKey, input: { ncrId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const ncr = await lockForCost(tools, ncrId)
    const description = body.description?.trim() || null
    const problems = costLineProblems(body, true)
    const other = otherNeedsWords(body.kind!, description)
    if (other) problems.push(other)
    if (problems.length > 0) refuse(problems, 'The cost line is not valid.')
    const lines = await readCostLines(tx, ncrId)
    if (lines.length >= COST_LIMITS.lines) throw new ConflictError(`An NCR has at most ${COST_LIMITS.lines} cost lines.`)
    const id = newId()
    const seq = Math.max(0, ...lines.map((line) => line.seq)) + 1
    await tx.ncrCostLine.create({ data: { id, siteId: ncr.siteId, ncrId, seq, kind: body.kind!, source: 'TYPED', description, amount: body.amount!, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
    tools.audit({ action: 'quality.addNcrCostLine', recordType: NCR_RECORD, recordId: ncrId, companyId: ncr.companyId, siteId: ncr.siteId, after: { lineId: id, seq, kind: body.kind, source: 'TYPED', amount: markMoney('cost', body.amount) } })
    emitChanged(tools, ncr, ['cost'])
    return { sheet: await sheetAfter(tools, ncrId, context) }
  })
  return result
}

/** The typed line of this NCR at the version the caller read (a computed line changes only by computing again). */
async function typedLineAt(tools: CommandTools, ncrId: string, lineId: string, expectedVersion: number): Promise<CostLineRow> {
  const line = isUuid(lineId) ? await tools.tx.ncrCostLine.findUnique({ where: { id: lineId }, select: COST_LINE_COLUMNS }) : null
  if (!line || line.ncrId !== ncrId) throw new NotFoundError('Cost line not found.')
  if (line.version !== expectedVersion) throw new StaleVersionError('NcrCostLine', lineId, line.version, expectedVersion)
  if (line.source === 'COMPUTED') throw new ConflictError('A computed line changes only when the cost is computed again (Compute again).')
  return line
}

/** PATCH /quality/ncr/:ncrId/cost/lines/:lineId: a typed line's kind, words or amount (its own version). */
export async function editCostLine(caller: CommandCaller, ncrId: string, lineId: string, body: CostLineBody & { readonly version: number }, idempotencyKey?: string) {
  const { context, row } = await costNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  const held = costHeld(row.stage)
  if (held) throw new InvalidStateError(held)
  const { result } = await command(caller, { name: 'quality.editNcrCostLine', idempotencyKey, input: { ncrId, lineId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const ncr = await lockForCost(tools, ncrId)
    const line = await typedLineAt(tools, ncrId, lineId, body.version)
    const kind = body.kind ?? (line.kind as CostKind)
    const description = body.description === undefined ? line.description : body.description?.trim() || null
    const amount = body.amount ?? line.amount
    const problems = costLineProblems(body, false)
    const other = otherNeedsWords(kind, description)
    if (other) problems.push(other)
    if (problems.length > 0) refuse(problems, 'The cost line is not valid.')
    if (kind === line.kind && description === line.description && amount === line.amount) {
      // Nothing changed (a cell saved twice): the command still says what it did.
      tools.audit({ action: 'quality.editNcrCostLine', recordType: NCR_RECORD, recordId: ncrId, companyId: ncr.companyId, siteId: ncr.siteId, after: { lineId: lineId, unchanged: true } })
      return { sheet: await sheetAfter(tools, ncrId, context) }
    }
    await tx.ncrCostLine.update({ where: { id: lineId }, data: { kind, description, amount, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({
      action: 'quality.editNcrCostLine',
      recordType: NCR_RECORD,
      recordId: ncrId,
      companyId: ncr.companyId,
      siteId: ncr.siteId,
      before: { lineId: lineId, kind: line.kind, description: line.description, amount: markMoney('cost', line.amount) },
      after: { lineId: lineId, kind, description, amount: markMoney('cost', amount) },
    })
    emitChanged(tools, ncr, ['cost'])
    return { sheet: await sheetAfter(tools, ncrId, context) }
  })
  return result
}

/** DELETE /quality/ncr/:ncrId/cost/lines/:lineId?version=: a typed line removed (the audit keeps it). */
export async function removeCostLine(caller: CommandCaller, ncrId: string, lineId: string, query: { readonly version: number }, idempotencyKey?: string) {
  const { context, row } = await costNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  const held = costHeld(row.stage)
  if (held) throw new InvalidStateError(held)
  const { result } = await command(caller, { name: 'quality.removeNcrCostLine', idempotencyKey, input: { ncrId, lineId, ...query } }, async (tools) => {
    const ncr = await lockForCost(tools, ncrId)
    const line = await typedLineAt(tools, ncrId, lineId, query.version)
    await tools.tx.ncrCostLine.delete({ where: { id: lineId }, select: { id: true } })
    tools.audit({ action: 'quality.removeNcrCostLine', recordType: NCR_RECORD, recordId: ncrId, companyId: ncr.companyId, siteId: ncr.siteId, before: { lineId: lineId, seq: line.seq, kind: line.kind, description: line.description, amount: markMoney('cost', line.amount) } })
    emitChanged(tools, ncr, ['cost'])
    return { sheet: await sheetAfter(tools, ncrId, context) }
  })
  return result
}

/** POST /quality/ncr/:ncrId/cost/compute: the computed lines brought up to date (changed in place, added, removed). */
export async function computeCost(caller: CommandCaller, ncrId: string, idempotencyKey?: string) {
  const { context, row } = await costNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  const held = costHeld(row.stage)
  if (held) throw new InvalidStateError(held)
  // Up to date already: the sheet as it stands, no command (a command writes and audits something).
  const before = await caller.withClient(async (client) => sheetOf(client, row, context))
  if (before.computed.upToDate) return { sheet: before, added: 0, changed: 0, removed: 0 }
  const { result } = await command(caller, { name: 'quality.computeNcrCost', idempotencyKey, input: { ncrId } }, async (tools) => {
    const { tx, now } = tools
    const ncr = await lockForCost(tools, ncrId)
    const lines = await readCostLines(tx, ncrId)
    const computed = await computeLines(tx, ncr)
    const plan = computePlan(
      lines.filter((line) => line.source === 'COMPUTED').map((line) => ({ id: line.id, recordType: line.recordType, recordId: line.recordId, kind: line.kind as CostKind, amount: line.amount, description: line.description })),
      computed.lines,
    )
    if (planIsEmpty(plan)) {
      // Brought up to date meanwhile by someone else.
      tools.audit({ action: 'quality.computeNcrCost', recordType: NCR_RECORD, recordId: ncrId, companyId: ncr.companyId, siteId: ncr.siteId, after: { unchanged: true } })
      return { sheet: await sheetAfter(tools, ncrId, context), added: 0, changed: 0, removed: 0 }
    }
    if (lines.length - plan.remove.length + plan.add.length > COST_LIMITS.lines) throw new ConflictError(`An NCR has at most ${COST_LIMITS.lines} cost lines.`)
    for (const id of plan.remove) await tx.ncrCostLine.delete({ where: { id }, select: { id: true } })
    for (const { id, line } of plan.change) await tx.ncrCostLine.update({ where: { id }, data: { kind: line.kind, amount: line.amount, description: line.description || null, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    let seq = Math.max(0, ...lines.map((line) => line.seq))
    for (const line of plan.add) {
      seq += 1
      await tx.ncrCostLine.create({ data: { id: newId(), siteId: ncr.siteId, ncrId, seq, kind: line.kind, source: 'COMPUTED', description: line.description || null, amount: line.amount, recordType: line.recordType, recordId: line.recordId, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
    }
    tools.audit({
      action: 'quality.computeNcrCost',
      recordType: NCR_RECORD,
      recordId: ncrId,
      companyId: ncr.companyId,
      siteId: ncr.siteId,
      after: {
        added: plan.add.map((line) => ({ recordType: line.recordType, recordId: line.recordId, kind: line.kind, amount: markMoney('cost', line.amount) })),
        changed: plan.change.map(({ id, line }) => ({ lineId: id, amount: markMoney('cost', line.amount) })),
        removed: plan.remove,
      },
    })
    emitChanged(tools, ncr, ['cost'])
    return { sheet: await sheetAfter(tools, ncrId, context), added: plan.add.length, changed: plan.change.length, removed: plan.remove.length }
  })
  return result
}
