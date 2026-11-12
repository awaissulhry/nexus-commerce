import type { Prisma, Uom } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { baseQuantityOf } from '@nexus/factory-domain/inventory/ledger/units'
import { INVENTORY_ISSUE } from '@nexus/factory-domain/inventory/permissions'
import { askAnswer, noApproverWords, stillOpen, SUBSTITUTION_LIMITS, tooMuchRefusal, type SubstituteKind } from '@nexus/factory-domain/inventory/substitutions/rules'
import { NOT_COUNTED_WORDS, usabilityOf } from '@nexus/factory-domain/planning/usable'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { askApproval, type Requester } from '../../../platform/approvals/engine'
import { asTenantSystem } from '../../production/bundles/codes'
import { mayAt, stockContextOf, type StockContext } from '../ledger/access'
import { lockWorkOrderIssues, readPickHeader } from '../issue/store'
import { heldByQualityHolds } from '../../quality/holds/stock'
import { certificateCovering } from '../../quality/lab/store'
import { loadLine, ratioOf, standingOf } from './options'
import { changed, refuse, substitutionViews, SUBSTITUTION_COLUMNS, unitsOf } from './store'

/**
 * Ask for a substitute (B-W2b-298; MES-139; follow-up PK1:01: "alternateUse is called with the work order's facts; the use is a
 * MaterialSubstitution with its yes, not an audit row only"). POST /inventory/substitutions, office and the floor of the work
 * order's site (inventory.issue). ONE command:
 *
 *   1. the work order's issue lock (an issue or another ask of it waits), its line read again: the pick list's need, what is
 *      issued, what nothing covers, the substitutions standing on the line
 *   2. what stands in: the line's own material (another lot, named) or one of the line's alternates (its own colour when it
 *      names one); a lot named is of the site, of that material and colour, and usable now (released, its chromium VI test
 *      passed when it needs one, on no quality hold): else refused in words
 *   3. the rule (factory-domain inventory/substitutions askAnswer → B-W2b-228 alternateUse with the work order's facts): only
 *      when short, a certificate check, a person's yes; at most what is still open of the line (a WHEN_SHORT one: the short part)
 *   4. the MaterialSubstitution WAITING with the rule's answer as given, then its yes asked of the approval engine (kind
 *      MATERIAL_SUBSTITUTION): a rule that holds → the request names it (approvalTaskId), the substitution waits; no rule →
 *      approved at once when nobody's yes is needed, else refused (NO_APPROVER: nobody could decide it) and nothing is kept
 *   5. its audit row and inventory.substitution_changed (ASKED; APPROVED too when approved at once)
 * A floor worker asks through the tenant's system caller (the approval engine writes in an office or system command): the
 * request names the worker, never the tablet's user; the floor's own rights are checked first.
 */

export interface AskInput {
  readonly workOrderId: string
  readonly bomLineId: string
  readonly toItemId: string
  readonly toItemColourId?: string | null | undefined
  readonly toLotId?: string | undefined
  readonly quantity: string
  readonly uom?: Uom | undefined
  readonly baseQuantity?: string | undefined
  readonly reasonCode?: string | undefined
  readonly reason: string
  readonly note?: string | undefined
}

const OPEN_STATUSES = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD']

async function askInCommand(tools: CommandTools, context: StockContext, body: AskInput, requester: Requester) {
  const { tx, now } = tools
  const tenantId = (tools.context as { tenantId: string }).tenantId
  await lockWorkOrderIssues(tx, tenantId, body.workOrderId)
  const loaded = await loadLine(tx, context, body.workOrderId, body.bomLineId)
  const { header, line, own, site } = loaded
  if (!OPEN_STATUSES.includes(header.status)) refuse({ code: 'NOT_OPEN', message: `Work order ${header.number} is ${header.status.toLowerCase().replace('_', ' ')}: a substitute is asked for a work order that is not done.` })

  // 2. What stands in.
  const kind: SubstituteKind = body.toItemId === line.itemId ? 'OWN_MATERIAL' : 'ALTERNATE'
  const alternate = kind === 'ALTERNATE' ? loaded.alternates.find((row) => row.itemId === body.toItemId) : null
  if (kind === 'ALTERNATE' && !alternate) {
    const named = loaded.alternates.map((row) => `${row.priority}. ${loaded.items.get(row.itemId)?.code ?? '?'}`)
    refuse({ code: 'NOT_ON_THE_LINE', message: `That material is not an alternate of line ${line.seq} (${own.code})${named.length > 0 ? `: its alternates are ${named.join(', ')}` : ': the line has no alternates'}. Another lot of ${own.code} needs its lot named.` })
  }
  const item = kind === 'OWN_MATERIAL' ? own : loaded.items.get(body.toItemId)!
  if (kind === 'OWN_MATERIAL' && !body.toLotId) throw new ValidationError(`Another lot of ${own.code}: name the lot.`, [{ path: 'body/toLotId', message: 'Name the lot of the line’s own material that stands in.' }])
  const lot = body.toLotId ? await tx.lot.findUnique({ where: { id: body.toLotId }, select: { id: true, code: true, siteId: true, itemId: true, itemColourId: true, qualityStatus: true, requiresCrViTest: true, crViStatus: true } }) : null
  if (body.toLotId && (!lot || lot.siteId !== header.siteId || lot.itemId !== item.id)) throw new ValidationError(`Not a lot of ${item.code} at ${site.code}.`, [{ path: 'body/toLotId', message: `A lot of ${item.code} at ${site.code}.` }])
  let colourId: string | null = alternate?.itemColourId ?? (body.toItemColourId !== undefined ? body.toItemColourId : (lot?.itemColourId ?? null))
  if (alternate?.itemColourId && body.toItemColourId !== undefined && body.toItemColourId !== alternate.itemColourId) {
    throw new ValidationError(`Alternate ${alternate.priority} (${item.code}) names its colour: it is used in that colour.`, [{ path: 'body/toItemColourId', message: 'The alternate’s own colour.' }])
  }
  if (lot && lot.itemColourId !== colourId) {
    if (body.toItemColourId === undefined && !alternate?.itemColourId) colourId = lot.itemColourId
    else throw new ValidationError(`Lot ${lot.code} is of another colour.`, [{ path: 'body/toLotId', message: 'A lot of the substitute’s colour.' }])
  }
  if (colourId !== null) {
    const colour = await tx.itemColour.findUnique({ where: { id: colourId }, select: { itemId: true } })
    if (!colour || colour.itemId !== item.id) throw new ValidationError(`Not a colour of ${item.code}.`, [{ path: 'body/toItemColourId', message: `A colour of ${item.code}.` }])
  }
  if (lot) {
    const usability = usabilityOf(lot)
    const held = await heldByQualityHolds(tx, { lotIds: [lot.id], hideIds: [] })
    if (!usability.usable) refuse({ code: 'LOT_NOT_USABLE', message: `Lot ${lot.code}: ${NOT_COUNTED_WORDS[usability.reason]}. Only released stock stands in (REACH Annex XVII entry 47: chromium VI).` })
    if (held.lots.has(lot.id)) refuse({ code: 'LOT_NOT_USABLE', message: `Lot ${lot.code} is on a quality hold: it stands in once quality releases it.` })
  }

  // How much.
  const uom = body.uom ?? (item.baseUom as Uom)
  const base = baseQuantityOf({ quantity: body.quantity, uom, baseQuantity: body.baseQuantity ?? null }, unitsOf(item))
  if (base.problem) throw new ValidationError(base.problem.message, [{ path: `body/${base.problem.path}`, message: base.problem.message }])
  if (new Dec(base.baseQuantity).lte(ZERO)) throw new ValidationError('How much stands in: above 0.', [{ path: 'body/quantity', message: 'Above 0.' }])

  // 3. The rule, with the work order's facts.
  const today = businessDate(now)
  const certificateRequired = alternate ? alternate.certificateCheck || own.isPpeComponent || item.isPpeComponent : false
  const certificate = alternate && certificateRequired ? await certificateCovering(tx, { itemId: item.id, companyId: header.companyId }, today) : null
  const ownShort = new Dec(line.short).gt(ZERO)
  const answer = askAnswer({
    kind,
    line: { seq: line.seq, materialCode: own.code },
    alternate: alternate ? { priority: alternate.priority, code: item.code, allowedWhen: alternate.allowedWhen, certificateCheck: alternate.certificateCheck } : null,
    certificateRequired,
    certificate: certificate ? { number: certificate.number, validTo: certificate.validTo } : null,
    ownShort,
  })
  refuse(answer.refusal)
  const onlyShort = alternate?.allowedWhen === 'WHEN_SHORT'
  const ratio = ratioOf(loaded, kind, item, alternate?.qty ?? null)
  if (ratio === null) throw new ValidationError(`${item.code} does not convert to line ${line.seq}'s unit.`, [{ path: 'body/toItemId', message: 'Its units do not convert.' }])
  const standing = await standingOf(tx, loaded)
  const open = stillOpen({ toIssue: line.toIssue, short: line.short, standing: quantityText(standing), onlyShort })
  refuse(tooMuchRefusal({ asked: ratio.times(base.baseQuantity), open, ownCode: own.code, baseUom: own.baseUom, onlyShort }))

  // 4. The record, then its yes.
  const reason = body.reason.trim()
  const id = newId()
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  const data: Prisma.MaterialSubstitutionUncheckedCreateInput = {
    id,
    siteId: header.siteId,
    workOrderId: header.id,
    styleRevisionId: loaded.revisionId,
    bomLineId: line.bomLineId,
    fromItemId: line.itemId,
    toItemId: item.id,
    toItemColourId: colourId,
    toLotId: lot?.id ?? null,
    alternateId: alternate?.id ?? null,
    quantity: body.quantity,
    uom,
    baseQuantity: base.baseQuantity,
    reasonCode: body.reasonCode?.trim() || null,
    reason,
    ruleAnswer: JSON.parse(JSON.stringify(answer.ruleAnswer)) as Prisma.InputJsonObject,
    requestedById: 'userId' in requester ? requester.userId : null,
    requestedByWorkerId: 'workerId' in requester ? requester.workerId : null,
    note: body.note?.trim() || null,
    createdAt: now,
    updatedAt: now,
    createdById,
  }
  await tx.materialSubstitution.create({ data, select: { id: true } })
  const asked = await askApproval(tools, { kind: 'MATERIAL_SUBSTITUTION', recordId: id, requester, note: reason })
  let approvedAtOnce = false
  if (asked.asked) {
    await tx.materialSubstitution.update({ where: { id }, data: { approvalTaskId: asked.taskId, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  } else if (answer.needsPerson) {
    refuse({ code: 'NO_APPROVER', message: noApproverWords(alternate ? `Alternate ${alternate.priority} (${item.code})` : `Another lot of ${own.code}`) })
  } else {
    // Nobody's yes is needed (an ALWAYS alternate, a WHEN_SHORT one while short) and no rule asks one: approved at once.
    await tx.materialSubstitution.update({ where: { id }, data: { status: 'APPROVED', decidedAt: now, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    approvedAtOnce = true
  }
  const row = (await tx.materialSubstitution.findUnique({ where: { id }, select: SUBSTITUTION_COLUMNS }))!

  // 5. Its trace.
  tools.audit({
    action: 'inventory.substitute',
    recordType: 'MaterialSubstitution',
    recordId: id,
    companyId: header.companyId,
    siteId: header.siteId,
    after: {
      workOrderId: header.id,
      bomLineId: line.bomLineId,
      kind,
      fromItemId: line.itemId,
      toItemId: item.id,
      toItemColourId: colourId,
      toLotId: lot?.id ?? null,
      alternateId: alternate?.id ?? null,
      quantity: body.quantity,
      uom,
      baseQuantity: base.baseQuantity,
      ruleAnswer: answer.ruleAnswer,
      certificate: certificate ? { id: certificate.id, number: certificate.number } : null,
      status: row.status,
      approvalTaskId: row.approvalTaskId,
      askedOnFloor: 'workerId' in requester,
    },
    reason,
  })
  changed(tools, row, header.companyId, 'ASKED', row.status)
  if (approvedAtOnce) changed(tools, row, header.companyId, 'APPROVED')
  const [view] = await substitutionViews(tx, [row])
  return {
    substitution: view!,
    approval: asked.asked ? { asked: true, taskId: asked.taskId, approverRoleId: asked.approverRoleId, approverUserId: asked.approverUserId, dueAt: asked.dueAt } : { asked: false, taskId: null, approverRoleId: null, approverUserId: null, dueAt: null },
    approvedAtOnce,
  }
}

export async function askSubstitute(caller: CommandCaller, body: AskInput, idempotencyKey?: string) {
  const context = stockContextOf(caller)
  if (context.audience === 'system') throw new NotFoundError('Work order not found.')
  if (!isUuid(body.workOrderId)) throw new NotFoundError('Work order not found.')
  const header = await caller.withClient((db) => readPickHeader(db, body.workOrderId))
  if (!header || !mayAt(context, INVENTORY_ISSUE, header)) throw new NotFoundError('Work order not found.')
  if ([...body.reason.trim()].length === 0 || [...body.reason].length > SUBSTITUTION_LIMITS.reason) throw new ValidationError('Say why in words (1 to 1000 characters).', [{ path: 'body/reason', message: '1 to 1000 characters.' }])
  if (context.audience === 'floor') {
    // The floor's request is written by the tenant's system caller (the approval engine's rule), naming the worker.
    const system = asTenantSystem(caller, context)
    const requester: Requester = { workerId: context.actorId, siteId: context.siteId }
    const { result } = await command(system, { name: 'inventory.substitute', idempotencyKey, input: { ...body, workerId: context.actorId, deviceId: context.deviceId } }, (tools) =>
      askInCommand(tools, system.factoryContext as StockContext, body, requester),
    )
    return result
  }
  const { result } = await command(caller, { name: 'inventory.substitute', idempotencyKey, input: body }, (tools) => askInCommand(tools, context, body, { userId: context.actorId }))
  return result
}
