import type { Uom } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { PRODUCTION_REWORK } from '@nexus/factory-domain/production/rework/permissions'
import { PURCHASING_CLAIMS_MANAGE } from '@nexus/factory-domain/purchasing/claims/permissions'
import { approvalNeeded, outcomeWords, type DefectClass, type DispositionFollowUp, type DispositionMove, type DispositionOutcome } from '@nexus/factory-domain/quality/defects/rules'
import type { DecisionChange } from '@nexus/factory-domain/quality/ncr/changes'
import { QUALITY_NCR_APPROVE, QUALITY_NCR_MANAGE } from '@nexus/factory-domain/quality/ncr/permissions'
import { approveProblem, carryOutProblem, decisionProblems, FOLLOW_UP_TYPES, MOVE_PERMISSIONS, NCR_LIMITS, problemEditable, stageWords, valueOf, type NcrStage } from '@nexus/factory-domain/quality/ncr/rules'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { openRework } from '../../production/rework/rework'
import { readReworkReasons } from '../../production/rework/store'
import { createClaimInCommand, resolveClaim } from '../../purchasing/claims/claims'
import { lotCostOf } from '../../purchasing/claims/store'
import { postDispositionInCommand, type DispositionStockLine } from '../defects/stock'
import { answerOf, assertOpen, contextOf, lockNcrRow, may, refuse, visibleNcr } from './ncr'
import { CODE_COLUMNS, DECISION_COLUMNS, readDecisions, type CodeRow, type DecisionRow, type NcrRow } from './store'

/**
 * The decisions of an NCR by quantity (B-W2a-47; QHS-083, QHS-005, QHS-091; design ncr-disp: "Rows per decision: Use
 * as is · Rework · Repair · Regrade (second quality) · Return to supplier · Scrap - quantity, approval needed (by value or
 * severity rule), approver, stock move state, follow-up"; "'Use as is' on a major or any critical defect is refused";
 * "'Create rework order' (QHS-091) opens a prefilled work order; re-inspection required before release"). Each write is
 * one command: the NCR's row locked and its version bumped first (the decision trigger locks it too: two decisions of
 * one NCR take turns), then the decision at the version the caller read.
 *
 *   add / change / remove  (quality.ncr.manage) while the NCR is OPEN or CONTAINED and the decision is neither approved
 *            nor carried out: never more than is left to decide; "use as is" only on a MINOR NCR; whether it needs
 *            another person's approval by the code's rule (factory-domain approvalNeeded: the NCR's class, or the value
 *            of the goods = the lot's cost × the quantity when the NCR is in the material's base unit; unknown asks).
 *   approve  (quality.ncr.approve) once, while OPEN or CONTAINED, never by who decided it (four eyes).
 *   carry out (quality.ncr.manage, and the right of what it makes) once approved when it must be, until the NCR is
 *            closed: the code's stock move through defects/stock.ts postDispositionInCommand (inventory.scrap |
 *            transfer | adjust | issue; the moves in the NCR's unit add up to the decision), and its follow-up record —
 *            a rework order or repair named (made from Production or the return), a supplier claim named or opened now
 *            (purchasing.claims.manage: DRAFT, the NCR named in its note). The follow-up is linked to the NCR.
 *   rework   "Create rework order" (QHS-091): production/rework openRework for the NCR's work order (its own command,
 *            production.rework; the record behind it this NCR), then the decision carried out with it.
 */

const scopeOf = (row: Pick<NcrRow, 'companyId' | 'siteId'>) => ({ companyId: row.companyId, siteId: row.siteId })

function assertDeciding(row: Pick<NcrRow, 'stage'>): void {
  assertOpen(row)
  if (!problemEditable(row.stage as NcrStage)) throw new InvalidStateError(`The NCR is ${stageWords(row.stage as NcrStage)}: decisions are added and changed while it is open or contained.`)
}

async function codeOf(tools: Pick<CommandTools, 'tx'>, id: string, path = 'dispositionCodeId'): Promise<CodeRow> {
  const code = isUuid(id) ? await tools.tx.dispositionCode.findUnique({ where: { id }, select: CODE_COLUMNS }) : null
  if (!code) refuse([{ path, message: 'Not a disposition code.' }], 'The disposition code is not found.')
  return code!
}

/** The goods' value for an approval rule: the lot's cost × the quantity (minor units), when the NCR is in the lot's base unit. */
async function valueFor(tools: Pick<CommandTools, 'tx'>, ncr: NcrRow, quantity: string): Promise<number | null> {
  if (!ncr.lotId || !ncr.itemId) return null
  const item = await tools.tx.item.findUnique({ where: { id: ncr.itemId }, select: { baseUom: true } })
  if (!item || item.baseUom !== ncr.uom) return null
  const cost = await lotCostOf(tools.tx, ncr.siteId, ncr.lotId)
  const company = await tools.tx.company.findUnique({ where: { id: ncr.companyId }, select: { currency: true } })
  if (!cost || !company || cost.currency !== company.currency) return null
  return valueOf(quantity, cost.unitCost)
}

async function approvalFor(tools: Pick<CommandTools, 'tx'>, ncr: NcrRow, codeId: string, quantity: string): Promise<boolean> {
  const rule = await tools.tx.dispositionCode.findUnique({ where: { id: codeId }, select: { approvalSeverity: true, approvalAmount: true } })
  if (!rule) return false
  const value = rule.approvalAmount === null ? null : await valueFor(tools, ncr, quantity)
  return approvalNeeded({ approvalSeverity: rule.approvalSeverity as DefectClass | null, approvalAmount: rule.approvalAmount }, { severity: ncr.severity as DefectClass, value }).needed
}

function emit(tools: CommandTools, ncr: NcrRow, decision: Pick<DecisionRow, 'id' | 'seq' | 'quantity' | 'approvalRequired' | 'followUpType' | 'followUpId'>, code: Pick<CodeRow, 'code'>, change: DecisionChange, stockMoveIds: readonly string[] = []): void {
  tools.emit({
    type: 'ncr.decision_changed',
    subject: ncr.id,
    ...scopeOf(ncr),
    payload: { ncrId: ncr.id, number: ncr.number, decisionId: decision.id, seq: decision.seq, dispositionCode: code.code, change, quantity: decision.quantity.toString(), approvalRequired: decision.approvalRequired, stockMoveIds: [...stockMoveIds], followUpType: decision.followUpType, followUpId: decision.followUpId },
  })
}

const leftOf = (ncr: NcrRow, decisions: readonly DecisionRow[], except?: string) => new Dec(ncr.quantityAffected.toString()).minus(decisions.filter((decision) => decision.id !== except).reduce((sum, decision) => sum.plus(decision.quantity.toString()), ZERO))

/** The decision of this NCR at the version the caller read (inside the command, after the NCR's lock). */
async function decisionAt(tools: CommandTools, ncrId: string, decisionId: string, expectedVersion: number): Promise<DecisionRow> {
  const decision = isUuid(decisionId) ? await tools.tx.ncrDispositionLine.findUnique({ where: { id: decisionId }, select: DECISION_COLUMNS }) : null
  if (!decision || decision.ncrId !== ncrId) throw new NotFoundError('Decision not found.')
  if (decision.version !== expectedVersion) throw new StaleVersionError('NcrDispositionLine', decisionId, decision.version, expectedVersion)
  return decision
}

// ---- add, change, remove -------------------------------------------------------------------------------------------------

/** POST /quality/ncr/:ncrId/decisions: a quantity and its disposition. */
export async function addDecision(caller: CommandCaller, ncrId: string, body: { readonly version: number; readonly dispositionCodeId: string; readonly quantity: string; readonly note?: string | null | undefined }, idempotencyKey?: string) {
  const { context, row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  assertDeciding(row)
  const { result } = await command(caller, { name: 'quality.addNcrDecision', idempotencyKey, input: { ncrId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const ncr = await lockNcrRow(tools, ncrId, body.version)
    assertDeciding(ncr)
    const code = await codeOf(tools, body.dispositionCodeId)
    if (!code.active) refuse([{ path: 'dispositionCodeId', message: `${code.code} is inactive: pick an active disposition.` }], 'The disposition is inactive.')
    const decisions = await readDecisions(tx, [ncrId])
    if (decisions.length >= NCR_LIMITS.decisions) throw new ConflictError(`An NCR has at most ${NCR_LIMITS.decisions} decisions.`)
    const problems = decisionProblems({ quantity: body.quantity, left: leftOf(ncr, decisions), uom: ncr.uom, outcome: code.outcome as DispositionOutcome, severity: ncr.severity as DefectClass, note: body.note })
    if (problems.length > 0) refuse(problems, 'The decision is not valid.')
    const approvalRequired = await approvalFor(tools, ncr, code.id, body.quantity)
    const id = newId()
    const created = await tx.ncrDispositionLine.create({
      data: { id, siteId: ncr.siteId, ncrId, seq: Math.max(0, ...decisions.map((decision) => decision.seq)) + 1, dispositionCodeId: code.id, quantity: body.quantity, note: body.note?.trim() || null, decidedAt: now, decidedById: context.actorId, approvalRequired, createdAt: now, updatedAt: now, createdById: context.actorId },
      select: DECISION_COLUMNS,
    })
    tools.audit({ action: 'quality.addNcrDecision', recordType: 'NcrDispositionLine', recordId: id, ...scopeOf(ncr), after: { ncrId, seq: created.seq, code: code.code, quantity: body.quantity, approvalRequired } })
    emit(tools, ncr, created, code, 'ADDED')
    return answerOf(tools, ncrId)
  })
  return result
}

/** PATCH /quality/ncr/:ncrId/decisions/:decisionId: its code, quantity or note, before it is approved or carried out. */
export async function editDecision(caller: CommandCaller, ncrId: string, decisionId: string, body: { readonly version: number; readonly dispositionCodeId?: string | undefined; readonly quantity?: string | undefined; readonly note?: string | null | undefined }, idempotencyKey?: string) {
  const { row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  assertDeciding(row)
  const { result } = await command(caller, { name: 'quality.editNcrDecision', idempotencyKey, input: { ncrId, decisionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const ncr = await lockNcrRow(tools, ncrId)
    assertDeciding(ncr)
    const decision = await decisionAt(tools, ncrId, decisionId, body.version)
    if (decision.approvedAt || decision.doneAt) throw new InvalidStateError(`This decision is ${decision.doneAt ? 'carried out' : 'approved'}: what it decides no longer changes (remove it while it is neither, or decide the rest).`)
    const code = await codeOf(tools, body.dispositionCodeId ?? decision.dispositionCodeId)
    if (body.dispositionCodeId && body.dispositionCodeId !== decision.dispositionCodeId && !code.active) refuse([{ path: 'dispositionCodeId', message: `${code.code} is inactive: pick an active disposition.` }], 'The disposition is inactive.')
    const quantity = body.quantity ?? decision.quantity.toString()
    const problems = decisionProblems({ quantity, left: leftOf(ncr, await readDecisions(tx, [ncrId]), decisionId), uom: ncr.uom, outcome: code.outcome as DispositionOutcome, severity: ncr.severity as DefectClass, note: body.note })
    if (problems.length > 0) refuse(problems, 'The decision is not valid.')
    const approvalRequired = await approvalFor(tools, ncr, code.id, quantity)
    const after = await tx.ncrDispositionLine.update({
      where: { id: decisionId },
      data: { dispositionCodeId: code.id, quantity, ...(body.note !== undefined ? { note: body.note?.trim() || null } : {}), approvalRequired, version: { increment: 1 }, updatedAt: now },
      select: DECISION_COLUMNS,
    })
    tools.audit({ action: 'quality.editNcrDecision', recordType: 'NcrDispositionLine', recordId: decisionId, ...scopeOf(ncr), before: { dispositionCodeId: decision.dispositionCodeId, quantity: decision.quantity.toString(), note: decision.note, approvalRequired: decision.approvalRequired }, after: { dispositionCodeId: after.dispositionCodeId, quantity, note: after.note, approvalRequired } })
    emit(tools, ncr, after, code, 'CHANGED')
    return answerOf(tools, ncrId)
  })
  return result
}

/** DELETE /quality/ncr/:ncrId/decisions/:decisionId?version=: while the NCR is open or contained and it is not carried out. */
export async function removeDecision(caller: CommandCaller, ncrId: string, decisionId: string, query: { readonly version: number }, idempotencyKey?: string) {
  const { row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  assertDeciding(row)
  const { result } = await command(caller, { name: 'quality.removeNcrDecision', idempotencyKey, input: { ncrId, decisionId, ...query } }, async (tools) => {
    const { tx } = tools
    const ncr = await lockNcrRow(tools, ncrId)
    assertDeciding(ncr)
    const decision = await decisionAt(tools, ncrId, decisionId, query.version)
    if (decision.doneAt) throw new InvalidStateError('This decision is carried out: it is kept.')
    const code = await codeOf(tools, decision.dispositionCodeId)
    await tx.ncrDispositionLine.delete({ where: { id: decisionId }, select: { id: true } })
    tools.audit({ action: 'quality.removeNcrDecision', recordType: 'NcrDispositionLine', recordId: decisionId, ...scopeOf(ncr), before: { seq: decision.seq, code: code.code, quantity: decision.quantity.toString(), approvedAt: decision.approvedAt } })
    emit(tools, ncr, decision, code, 'REMOVED')
    return answerOf(tools, ncrId)
  })
  return result
}

// ---- approve ------------------------------------------------------------------------------------------------------------

/** POST /quality/ncr/:ncrId/decisions/:decisionId/approve: the second person (never who decided it). */
export async function approveDecision(caller: CommandCaller, ncrId: string, decisionId: string, body: { readonly version: number; readonly note?: string | null | undefined }, idempotencyKey?: string) {
  const { context, row } = await visibleNcr(caller, ncrId, QUALITY_NCR_APPROVE)
  assertOpen(row)
  const { result } = await command(caller, { name: 'quality.approveNcrDecision', idempotencyKey, input: { ncrId, decisionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const ncr = await lockNcrRow(tools, ncrId)
    const decision = await decisionAt(tools, ncrId, decisionId, body.version)
    const problem = approveProblem({ stage: ncr.stage as NcrStage, approvalRequired: decision.approvalRequired, approved: decision.approvedAt !== null, done: decision.doneAt !== null, decidedById: decision.decidedById, approverId: context.actorId })
    if (problem) throw new ConflictError(problem)
    const code = await codeOf(tools, decision.dispositionCodeId)
    const after = await tx.ncrDispositionLine.update({ where: { id: decisionId }, data: { approvedAt: now, approvedById: context.actorId, version: { increment: 1 }, updatedAt: now }, select: DECISION_COLUMNS })
    tools.audit({ action: 'quality.approveNcrDecision', recordType: 'NcrDispositionLine', recordId: decisionId, ...scopeOf(ncr), before: { approvedAt: null }, after: { approvedAt: now, approvedById: context.actorId }, ...(body.note?.trim() ? { reason: body.note.trim() } : {}) })
    emit(tools, ncr, after, code, 'APPROVED')
    return answerOf(tools, ncrId)
  })
  return result
}

// ---- carry out ----------------------------------------------------------------------------------------------------------

export interface CarryOutBody {
  readonly version: number
  readonly note?: string | null | undefined
  readonly stock?: { readonly lines: readonly DispositionStockLine[]; readonly toLocationId?: string | null | undefined; readonly workOrderId?: string | null | undefined } | undefined
  readonly followUp?: { readonly type: 'ReworkOrder' | 'RepairOrder' | 'SupplierClaim'; readonly id: string } | undefined
  readonly claim?: { readonly kind: 'RETURN' | 'CLAIM'; readonly reasonCode: string; readonly reasonNote?: string | null | undefined; readonly remedy?: 'CREDIT' | 'REPLACEMENT' | null | undefined; readonly hideIds?: readonly string[] | undefined } | undefined
}

/** The follow-up record named: of the NCR's site (company), live, and for a rework the NCR is the record behind it. */
async function namedFollowUp(tools: CommandTools, ncr: NcrRow, decision: DecisionRow, followUp: NonNullable<CarryOutBody['followUp']>): Promise<{ type: string; id: string; moveIds: string[] }> {
  const { tx } = tools
  const at = 'followUp/id'
  if (followUp.type === 'ReworkOrder') {
    const rework = isUuid(followUp.id) ? await tx.reworkOrder.findUnique({ where: { id: followUp.id }, select: { id: true, siteId: true, status: true, quantity: true, recordType: true, recordId: true } }) : null
    if (!rework || rework.siteId !== ncr.siteId) refuse([{ path: at, message: "Not a rework order of the NCR's site." }], 'The rework order is not found.')
    if (rework!.status === 'CANCELLED') refuse([{ path: at, message: 'This rework order is cancelled.' }], 'The rework order is cancelled.')
    if (rework!.recordType !== 'Nonconformance' || rework!.recordId !== ncr.id) refuse([{ path: at, message: `This rework order was not opened for ${ncr.number}: open it from the NCR (Create rework order).` }], 'Another rework order.')
    if (new Dec(rework!.quantity).gt(decision.quantity.toString())) refuse([{ path: at, message: `The rework sends back ${rework!.quantity}; the decision is ${decision.quantity.toString()} ${ncr.uom}.` }], 'The rework is larger than the decision.')
  } else if (followUp.type === 'RepairOrder') {
    const repair = isUuid(followUp.id) ? await tx.repairOrder.findUnique({ where: { id: followUp.id }, select: { companyId: true, stage: true } }) : null
    if (!repair || repair.companyId !== ncr.companyId) refuse([{ path: at, message: "Not a repair of the NCR's company." }], 'The repair is not found.')
    if (repair!.stage === 'CANCELLED') refuse([{ path: at, message: 'This repair is cancelled.' }], 'The repair is cancelled.')
  }
  let moveIds: string[] = []
  if (followUp.type === 'SupplierClaim') {
    const claim = isUuid(followUp.id) ? await tx.supplierClaim.findUnique({ where: { id: followUp.id }, select: { companyId: true, siteId: true, partyId: true, status: true, lines: { select: { moveId: true }, orderBy: { seq: 'asc' } } } }) : null
    if (!claim || claim.siteId !== ncr.siteId) refuse([{ path: at, message: "Not a supplier claim of the NCR's site." }], 'The claim is not found.')
    if (ncr.supplierId && claim!.partyId !== ncr.supplierId) refuse([{ path: at, message: "The claim is to another supplier than the NCR's." }], 'Another supplier.')
    if (claim!.status === 'CANCELLED') refuse([{ path: at, message: 'This claim is cancelled.' }], 'The claim is cancelled.')
    moveIds = claim!.lines.flatMap((line) => (line.moveId ? [line.moveId] : []))
  }
  const used = await tx.ncrDispositionLine.findFirst({ where: { followUpType: followUp.type, followUpId: followUp.id, id: { not: decision.id } }, select: { ncrId: true, seq: true } })
  if (used) refuse([{ path: at, message: used.ncrId === ncr.id ? `Decision ${used.seq} of this NCR is carried out with it already.` : 'Another NCR is carried out with it already.' }], 'The record is used already.')
  return { type: followUp.type, id: followUp.id, moveIds }
}

/** POST /quality/ncr/:ncrId/decisions/:decisionId/carry-out: the code's stock move and its follow-up record. */
export async function carryOut(caller: CommandCaller, ncrId: string, decisionId: string, body: CarryOutBody, idempotencyKey?: string) {
  const { context, row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  assertOpen(row)
  const { result } = await command(caller, { name: 'quality.carryOutNcrDecision', idempotencyKey, input: { ncrId, decisionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const ncr = await lockNcrRow(tools, ncrId)
    const decision = await decisionAt(tools, ncrId, decisionId, body.version)
    const problem = carryOutProblem({ stage: ncr.stage as NcrStage, approvalRequired: decision.approvalRequired, approved: decision.approvedAt !== null, done: decision.doneAt !== null })
    if (problem) throw new ConflictError(problem)
    const code = await codeOf(tools, decision.dispositionCodeId)
    const move = code.stockMoveReason as DispositionMove | null
    const followUpKind = code.followUp as DispositionFollowUp | null
    const words = outcomeWords(code.outcome as DispositionOutcome)

    // The follow-up first (a claim's goods that went back give an ADJUSTMENT move).
    let followUp: { type: string; id: string; moveIds: string[] } | null = null
    if (followUpKind === null && (body.followUp || body.claim)) refuse([{ path: 'followUp', message: `${code.code} opens no other record.` }], `${words} opens no other record.`)
    if (followUpKind !== null) {
      const type = FOLLOW_UP_TYPES[followUpKind]
      if (body.followUp && body.claim) refuse([{ path: 'claim', message: 'Name the claim or open one, not both.' }], 'Name the claim or open one.')
      if (body.followUp) {
        if (body.followUp.type !== type) refuse([{ path: 'followUp/type', message: `${code.code} is carried out with a ${type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}.` }], 'Another kind of record.')
        followUp = await namedFollowUp(tools, ncr, decision, body.followUp)
      } else if (body.claim && followUpKind === 'SUPPLIER_CLAIM') {
        if (!may(contextOf(tools), PURCHASING_CLAIMS_MANAGE, ncr)) throw new ForbiddenError('Opening the supplier claim needs purchasing.claims.manage at the NCR\'s site.')
        if (!ncr.supplierId) refuse([{ path: 'claim', message: 'The NCR names no supplier: name it first.' }], 'No supplier.')
        if (!ncr.lotId) refuse([{ path: 'claim', message: 'The NCR names no lot: name the lot whose goods go back first.' }], 'No lot.')
        const internalNote = `NCR ${ncr.number}: ${ncr.title}`.slice(0, 1000)
        const resolved = await resolveClaim(tools, { kind: body.claim.kind, partyId: ncr.supplierId!, siteId: ncr.siteId, reasonCode: body.claim.reasonCode, reasonNote: body.claim.reasonNote ?? null, remedy: body.claim.remedy, internalNote, from: { lotId: ncr.lotId!, ...(body.claim.hideIds ? { hideIds: body.claim.hideIds } : {}) } }, 'LOT')
        const created = await createClaimInCommand(tools, resolved, { internalNote })
        followUp = { type: 'SupplierClaim', id: created.id, moveIds: [] }
      } else {
        const how = followUpKind === 'REWORK_ORDER' ? 'create the rework order (Create rework order) or name the one opened for this NCR' : followUpKind === 'REPAIR_ORDER' ? 'name its repair' : 'name the supplier claim, or open one now'
        refuse([{ path: 'followUp', message: `${code.code} is carried out with its follow-up record: ${how}.` }], 'The follow-up record is missing.')
      }
    }

    // The stock move: the code's, posted now; or (ADJUSTMENT with a supplier claim) the claim's goods that went back.
    let stockMoveIds: string[] = []
    if (move === null && body.stock) refuse([{ path: 'stock', message: `${code.code} moves no stock.` }], `${words} moves no stock.`)
    if (move !== null) {
      const permission = MOVE_PERMISSIONS[move]
      if (body.stock) {
        if (!may(contextOf(tools), permission, ncr)) throw new ForbiddenError(`This stock move needs ${permission} at the NCR's site.`)
        const posted = await postDispositionInCommand(tools, {
          dispositionCodeId: code.id,
          siteId: ncr.siteId,
          lines: body.stock.lines,
          toLocationId: body.stock.toLocationId ?? null,
          workOrderId: body.stock.workOrderId ?? null,
          reference: ncr.number,
          note: body.note?.trim() || decision.note || ncr.title,
          key: `ncr:${decision.id}`,
          path: 'body/stock',
        })
        stockMoveIds = posted.moves.map((entry) => entry.id)
        // In the NCR's unit, the moves add up to the decision.
        const units = new Map((await tx.item.findMany({ where: { id: { in: [...new Set(posted.moves.map((entry) => entry.itemId))] } }, select: { id: true, baseUom: true } })).map((item) => [item.id, item.baseUom as Uom]))
        if (posted.moves.every((entry) => units.get(entry.itemId) === ncr.uom)) {
          const total = posted.moves.reduce((sum, entry) => sum.plus(entry.baseQuantity), ZERO)
          if (!total.eq(decision.quantity.toString())) {
            throw new ValidationError(`The moves take ${total.toFixed(4)} ${ncr.uom}; the decision is ${decision.quantity.toFixed(4)} ${ncr.uom}: move exactly that, or change the decision first.`, [{ path: 'body/stock/lines', message: `${total.toFixed(4)} of ${decision.quantity.toFixed(4)} ${ncr.uom}.` }])
          }
        }
      } else if (followUp && followUp.moveIds.length > 0 && move === 'ADJUSTMENT') {
        const moves = await tx.stockMove.findMany({ where: { id: { in: followUp.moveIds } }, select: { id: true, reason: true }, orderBy: { id: 'asc' } })
        stockMoveIds = moves.filter((entry) => entry.reason === 'ADJUSTMENT').map((entry) => entry.id)
      }
      if (stockMoveIds.length === 0) refuse([{ path: 'stock', message: `${code.code} posts a ${move} move: name what moves${move === 'ADJUSTMENT' && followUpKind === 'SUPPLIER_CLAIM' ? ', or name the claim whose goods went back' : ''}.` }], 'The stock move is missing.')
    }

    const after = await tx.ncrDispositionLine.update({
      where: { id: decisionId },
      data: { doneAt: now, stockMoveId: stockMoveIds[0] ?? null, followUpType: followUp?.type ?? null, followUpId: followUp?.id ?? null, version: { increment: 1 }, updatedAt: now },
      select: DECISION_COLUMNS,
    })
    if (followUp && !(await tx.ncrLink.findFirst({ where: { ncrId, recordType: followUp.type, recordId: followUp.id }, select: { id: true } }))) {
      await tx.ncrLink.create({ data: { id: newId(), siteId: ncr.siteId, ncrId, recordType: followUp.type, recordId: followUp.id, note: `Decision ${decision.seq}`, createdAt: now, createdById: context.actorId }, select: { id: true } })
    }
    tools.audit({ action: 'quality.carryOutNcrDecision', recordType: 'NcrDispositionLine', recordId: decisionId, ...scopeOf(ncr), before: { doneAt: null }, after: { doneAt: now, stockMoveIds, followUpType: after.followUpType, followUpId: after.followUpId }, ...(body.note?.trim() ? { reason: body.note.trim() } : {}) })
    emit(tools, ncr, after, code, 'CARRIED_OUT', stockMoveIds)
    return { ...(await answerOf(tools, ncrId)), stockMoveIds, followUp: followUp ? { type: followUp.type, id: followUp.id } : null }
  })
  return result
}

// ---- Create rework order (QHS-091) -------------------------------------------------------------------------------------

export interface ReworkBody {
  readonly version: number
  readonly reworkAtOperationId: string
  readonly workOrderSizeId?: string | undefined
  readonly bundleId?: string | null | undefined
  readonly foundAtOperationId?: string | null | undefined
  readonly reasonCode?: string | undefined
  readonly description?: string | undefined
  readonly split?: boolean | undefined
  readonly printerId?: string | null | undefined
}

/**
 * POST /quality/ncr/:ncrId/decisions/:decisionId/rework: the decision's rework order for the NCR's work order (B-W2a-13's
 * rework loop, its own command: production.rework; the garments go back to the operation named and are inspected again),
 * then the decision carried out with it. A repeat with the same Idempotency-Key answers both again.
 */
export async function reworkFromDecision(caller: CommandCaller, ncrId: string, decisionId: string, body: ReworkBody, idempotencyKey?: string) {
  const { context, row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  assertOpen(row)
  if (!may(context, PRODUCTION_REWORK, row)) throw new ForbiddenError("A rework order needs production.rework at the NCR's site.")
  const decision = await caller.withClient((client) => client.ncrDispositionLine.findUnique({ where: { id: decisionId }, select: DECISION_COLUMNS }))
  if (!decision || decision.ncrId !== ncrId) throw new NotFoundError('Decision not found.')
  if (decision.version !== body.version) throw new StaleVersionError('NcrDispositionLine', decisionId, decision.version, body.version)
  const code = await caller.withClient((client) => client.dispositionCode.findUnique({ where: { id: decision.dispositionCodeId }, select: CODE_COLUMNS }))
  if (!code || code.followUp !== 'REWORK_ORDER') throw new ConflictError(`${code?.code ?? 'This disposition'} opens no rework order.`)
  const problem = carryOutProblem({ stage: row.stage as NcrStage, approvalRequired: decision.approvalRequired, approved: decision.approvedAt !== null, done: decision.doneAt !== null })
  if (problem) throw new ConflictError(problem)
  if (!row.workOrderId) refuse([{ path: 'workOrderId', message: 'The NCR names no work order: name it on the NCR first.' }], 'No work order.')
  if (row.uom !== 'PCS' || !decision.quantity.isInteger()) refuse([{ path: 'quantity', message: 'A rework order sends back whole garments: the decision is in pieces.' }], 'Not whole garments.')
  // The cell: named, else the NCR's colourway and size on the work order, else its only cell.
  let workOrderSizeId = body.workOrderSizeId
  if (!workOrderSizeId) {
    const cells = await caller.withClient((client) => client.workOrderSize.findMany({ where: { workOrderId: row.workOrderId! }, select: { id: true, colourwayId: true, size: true } }))
    const matching = cells.filter((cell) => (!row.colourwayId || cell.colourwayId === row.colourwayId) && (!row.size || cell.size === row.size))
    workOrderSizeId = matching.length === 1 ? matching[0]!.id : cells.length === 1 ? cells[0]!.id : undefined
  }
  if (!workOrderSizeId && !body.bundleId) refuse([{ path: 'workOrderSizeId', message: 'Name the cell (colourway and size) of the garments, or their bundle.' }], 'Name the cell.')
  const reasonCode = body.reasonCode ?? (await caller.withClient((client) => readReworkReasons(client)))[0]?.code
  if (!reasonCode) refuse([{ path: 'reasonCode', message: 'No active rework reason: add one in Floor rules & codes.' }], 'No rework reason.')
  const opened = await openRework(
    caller,
    {
      workOrderId: row.workOrderId!,
      ...(workOrderSizeId ? { workOrderSizeId } : {}),
      ...(body.bundleId !== undefined ? { bundleId: body.bundleId } : {}),
      ...(body.foundAtOperationId !== undefined ? { foundAtOperationId: body.foundAtOperationId } : {}),
      reworkAtOperationId: body.reworkAtOperationId,
      quantity: Number(decision.quantity.toFixed(0)),
      reasonCode: reasonCode!,
      description: (body.description?.trim() || `${row.number}: ${row.title}`).slice(0, 1000),
      recordType: 'Nonconformance',
      recordId: ncrId,
      ...(body.split !== undefined ? { split: body.split } : {}),
      ...(body.printerId !== undefined ? { printerId: body.printerId } : {}),
    },
    idempotencyKey ? `${idempotencyKey}:rework` : undefined,
  )
  // A repeat of the same key answers the same rework (its receipt) and the same carrying out.
  const carried = await carryOut(caller, ncrId, decisionId, { version: body.version, followUp: { type: 'ReworkOrder', id: opened.rework.id } }, idempotencyKey ? `${idempotencyKey}:carry` : undefined)
  return { record: carried.record, reworkId: opened.rework.id, ticket: opened.ticket ?? null }
}
