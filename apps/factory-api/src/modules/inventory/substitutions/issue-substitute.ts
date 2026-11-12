import type { Uom } from '@nexus/factory-db'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { parseInstant } from '@nexus/factory-domain/core/time'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_ISSUE } from '@nexus/factory-domain/inventory/permissions'
import { issueRefusal, type SubstitutionStatus } from '@nexus/factory-domain/inventory/substitutions/rules'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { mayAt, stockContextOf } from '../ledger/access'
import { issueInCommand, type IssueInput, type IssueResult } from '../issue/issue'
import { lockWorkOrderIssues, readAtWorkOrder, readPickHeader } from '../issue/store'
import { changed, lockSubstitution, readItemsOf, readSubstitution, refuse, substitutionViews, SUBSTITUTION_COLUMNS } from './store'

/**
 * An approved substitute issued with its own moves (B-W2b-298; MES-139: "then issued with its own move"). POST
 * /inventory/substitutions/:id/issue, office and the floor of the work order's site (inventory.issue; a tablet's write with its
 * Idempotency-Key; queued offline as inventory.substitute.issue). ONE command, in the issue's lock order (the work order's
 * issue lock first, then the substitution's row): the substitution APPROVED (else refused in words), then W1's
 * `issueInCommand` for each piece of stock — the issue's own rules (a hide whole, a lot by quantity, chromium VI and quality
 * holds, another order's reservation, the shade rule, over-issue only by the office with inventory.issue.over and the
 * reason) — against what the substitution allows (`plannedAs`: what the work order held of the substitute before, plus the
 * substitution's quantity), never against the work order's plan of its own material. Then ISSUED with its moves (the
 * database checks they are ISSUE moves of the work order and the substitute, of its lot when named), its audit row and
 * inventory.substitution_changed; the issue's own audit and inventory.issued follow as for any issue (a RELEASED work order
 * starts on its first issue).
 *
 *   a hide-tracked substitute   the hides scanned or named (each whole, each of the substitution's lot when it names one)
 *   a lot-tracked one           its lot (the substitution's, else the one scanned or named), how much (default: what is allowed)
 *   untracked                   how much (default: what is allowed), from where it lies
 */

export interface IssueSubstituteInput {
  readonly version?: number | undefined
  /** A scanned tag: a hide's, else a lot's code. */
  readonly code?: string | undefined
  readonly lotId?: string | undefined
  readonly hideIds?: readonly string[] | undefined
  readonly quantity?: string | undefined
  readonly uom?: Uom | undefined
  readonly baseQuantity?: string | undefined
  readonly fromLocationId?: string | undefined
  readonly overIssueReason?: string | undefined
  readonly occurredAt?: string | undefined
}

const wrongStock = (message: string) => new DomainError('conflict', message, [{ path: 'refusal/WRONG_STOCK', message }])

async function issueInSubstitution(tools: CommandTools, substitutionId: string, workOrderId: string, body: IssueSubstituteInput, key: string) {
  const { tx, now } = tools
  const tenantId = (tools.context as { tenantId: string }).tenantId
  await lockWorkOrderIssues(tx, tenantId, workOrderId)
  const row = await lockSubstitution(tx, substitutionId)
  if (!row) throw new NotFoundError('Substitute not found.')
  if (body.version !== undefined && body.version !== row.version) throw new DomainError('conflict', 'This substitute changed since you looked: read it again.', [{ path: 'body/version', message: `Now version ${row.version}.` }])
  refuse(issueRefusal(row.status as SubstitutionStatus))
  const item = (await readItemsOf(tx, [row.toItemId])).get(row.toItemId)!

  // The stock it names.
  const refs: IssueInput[] = []
  let lotUsed: string | null = row.toLotId
  if (item.tracking === 'HIDE') {
    if (body.quantity !== undefined) throw new ValidationError('A hide is issued whole, with what it measures.', [{ path: 'body/quantity', message: 'Leave it out for hides.' }])
    const hideIds = [...(body.hideIds ?? [])]
    if (body.code) {
      const hide = await tx.hide.findFirst({ where: { code: body.code.trim() }, select: { id: true } })
      if (!hide) throw wrongStock(`${body.code.trim()} is not a hide of ${item.code}.`)
      hideIds.push(hide.id)
    }
    if (hideIds.length === 0) throw new ValidationError(`${item.code} is issued hide by hide: scan or name its hides.`, [{ path: 'body/hideIds', message: 'One hide or more.' }])
    const hides = await tx.hide.findMany({ where: { id: { in: hideIds.filter(isUuid) } }, select: { id: true, code: true, itemId: true, lotId: true, siteId: true } })
    const lots = new Set<string>()
    for (const hideId of [...new Set(hideIds)]) {
      const hide = hides.find((entry) => entry.id === hideId)
      if (!hide || hide.itemId !== item.id || hide.siteId !== row.siteId) throw wrongStock(`That is not a hide of ${item.code} at this site.`)
      if (row.toLotId && hide.lotId !== row.toLotId) throw wrongStock(`Hide ${hide.code} is of another lot than the approved one.`)
      lots.add(hide.lotId)
      refs.push({ hideId: hide.id })
    }
    if (!lotUsed && lots.size === 1) lotUsed = [...lots][0]!
  } else if (item.tracking === 'LOT') {
    let lotId = body.lotId ?? null
    if (!lotId && body.code) lotId = (await tx.lot.findFirst({ where: { code: body.code.trim() }, select: { id: true } }))?.id ?? null
    lotId = lotId ?? row.toLotId
    if (!lotId) throw new ValidationError(`${item.code} is issued by its lot: scan or name it.`, [{ path: 'body/lotId', message: 'The lot.' }])
    if (row.toLotId && lotId !== row.toLotId) throw wrongStock('That is another lot than the approved one.')
    const lot = await tx.lot.findUnique({ where: { id: lotId }, select: { id: true, itemId: true, itemColourId: true, siteId: true, code: true } })
    if (!lot || lot.itemId !== item.id || lot.siteId !== row.siteId) throw wrongStock(`That is not a lot of ${item.code} at this site.`)
    if (lot.itemColourId !== row.toItemColourId) throw wrongStock(`Lot ${lot.code} is of another colour than the approved one.`)
    lotUsed = lot.id
    refs.push({ lotId: lot.id, ...(body.quantity !== undefined ? { quantity: body.quantity, uom: body.uom, baseQuantity: body.baseQuantity } : {}) })
  } else {
    refs.push({ itemId: item.id, itemColourId: row.toItemColourId, ...(body.quantity !== undefined ? { quantity: body.quantity, uom: body.uom, baseQuantity: body.baseQuantity } : {}) })
  }

  // What the substitution allows: what the work order held of the substitute before it, plus its quantity.
  const before = (await readAtWorkOrder(tx, row.siteId, workOrderId, { itemId: row.toItemId, itemColourId: row.toItemColourId })).reduce((sum, entry) => sum.plus(new Dec(entry.quantity)), ZERO)
  const plannedAs = quantityText(before.plus(new Dec(row.baseQuantity.toString())))
  const results: IssueResult[] = []
  for (const [index, ref] of refs.entries()) {
    results.push(
      await issueInCommand(
        tools,
        workOrderId,
        { ...ref, ...(body.fromLocationId && !ref.hideId ? { fromLocationId: body.fromLocationId } : {}), ...(body.overIssueReason ? { overIssueReason: body.overIssueReason } : {}), ...(body.occurredAt ? { occurredAt: body.occurredAt } : {}) },
        `${key}:${index}`,
        'body',
        { plannedAs },
      ),
    )
  }
  const moveIds = results.flatMap((result) => result.issue.moves.map((move) => move.id))
  const after = await tx.materialSubstitution.update({
    where: { id: row.id },
    data: { status: 'ISSUED', issuedAt: now, moveIds, ...(row.toLotId === null && lotUsed ? { toLotId: lotUsed } : {}), version: { increment: 1 }, updatedAt: now },
    select: SUBSTITUTION_COLUMNS,
  })
  const header = (await readPickHeader(tx, workOrderId))!
  const issued = results.reduce((sum, result) => sum.plus(new Dec(result.issue.baseQuantity)), ZERO)
  tools.audit({
    action: 'inventory.issueSubstitute',
    recordType: 'MaterialSubstitution',
    recordId: row.id,
    companyId: header.companyId,
    siteId: row.siteId,
    before: { status: row.status },
    after: { status: 'ISSUED', moveIds, toLotId: after.toLotId, baseQuantity: quantityText(issued) },
  })
  changed(tools, after, header.companyId, 'ISSUED')
  const [view] = await substitutionViews(tx, [after], { requests: tools.context.audience !== 'floor' })
  return { substitution: view!, issued: quantityText(issued), moveIds, line: results.at(-1)!.line }
}

export async function issueSubstitute(caller: CommandCaller, substitutionId: string, body: IssueSubstituteInput, idempotencyKey?: string) {
  const context = stockContextOf(caller)
  const found = await caller.withClient((db) => readSubstitution(db, substitutionId))
  const header = found ? await caller.withClient((db) => readPickHeader(db, found.workOrderId)) : null
  if (!found || !header || !mayAt(context, INVENTORY_ISSUE, header)) throw new NotFoundError('Substitute not found.')
  const occurredAt = body.occurredAt ? parseInstant(body.occurredAt) : null
  const key = `inventory.issueSubstitute:${idempotencyKey ?? `g-${newId()}`}`
  const { result } = await command(
    caller,
    { name: 'inventory.issueSubstitute', idempotencyKey, input: { substitutionId, ...body }, ...(context.audience === 'floor' && occurredAt ? { deviceTime: occurredAt } : {}) },
    (tools) => issueInSubstitution(tools, substitutionId, found.workOrderId, body, key),
  )
  return result
}
