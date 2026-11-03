import type { Prisma, Uom } from '@nexus/factory-db'
import { ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { isAreaUom } from '@nexus/factory-domain/inventory/hides/area'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { goneOnRefusal, mayMoveRemnant, revivedOnReopen, type RemnantCause, type RemnantSource, type RemnantState } from '@nexus/factory-domain/inventory/remnants/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { allocateScanIds } from '../../../platform/numbering/scan-ids'

/**
 * A remnant's life beside its hide (B-W2b-100; SCM-254; factory-domain inventory/remnants/rules). The ledger stays per hide;
 * these keep the tag's row in step with what a command does to the hide, INSIDE that command, after its moves (the
 * database's factory_remnant_guard wants a reversal posted before its pieces go VOID):
 *
 *   tagRemnantInCommand        a REMNANT move (or a W1 RETURN, backfilled) gets its tag: the tenant's REMNANT scan id
 *                              (allocateScanIds, online), a Remnant row IN_STOCK at the move's place, an audit row, the event
 *   remnantsOnIssue            the hide issued to a work order: its pieces in stock → ISSUED
 *   remnantsOnIssueReversed    that issue undone or reversed: ISSUED → IN_STOCK
 *   remnantsOnWholeReturn      the hide back whole from the work order (a RETURN): ISSUED → IN_STOCK at the return's place
 *   remnantsOnClose            the hide cut and closed (Hide done) or a part of it back as a new remnant: ISSUED → USED
 *   remnantsOnMoveReversed     a REMNANT move reversed: its pieces → VOID (refused in words while one went on), then the
 *                              pieces that close used → ISSUED again; a RETURN of the hide reversed: IN_STOCK → ISSUED
 *   remnantsOnReopen           a close undone (the cut log's mirror entry): the pieces it used → ISSUED again
 *   remnantsOnScrap / …Reversed  the hide written off whole: IN_STOCK → SCRAPPED, and back when its scrap is reversed
 *   remnantsFollowTransfers    postMoves' hook: a TRANSFER of a hide takes its pieces in stock to the move's place
 *
 * Every state change records an audit row on the Remnant (before → after, the cause) and emits inventory.remnant_changed. A
 * floor device writes them too (grant s i u at its site); the row names no worker (createdById: the office person only).
 */

export const REMNANT_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  lotId: true,
  hideId: true,
  code: true,
  area: true,
  areaUom: true,
  baseArea: true,
  gradeId: true,
  locationId: true,
  state: true,
  moveId: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.RemnantSelect
export type RemnantRow = Prisma.RemnantGetPayload<{ select: typeof REMNANT_SELECT }>

type Reader = Pick<CommandTx, 'remnant'>

/** The pieces of these hides (every state), oldest first (UUIDv7 ids sort by time). */
export async function remnantsOfHides(db: Reader, hideIds: readonly string[]): Promise<RemnantRow[]> {
  if (hideIds.length === 0) return []
  return db.remnant.findMany({ where: { hideId: { in: [...new Set(hideIds)] } }, select: REMNANT_SELECT, orderBy: { id: 'asc' } })
}

/** The live tag of each hide (IN_STOCK, else ISSUED; the newest), for the pick list's and the find's rows. */
export async function liveTagsOf(db: Reader, hideIds: readonly string[]): Promise<Map<string, { id: string; code: string; state: RemnantState }>> {
  const tags = new Map<string, { id: string; code: string; state: RemnantState }>()
  for (const row of await remnantsOfHides(db, hideIds)) {
    if (row.state !== 'IN_STOCK' && row.state !== 'ISSUED') continue
    const kept = tags.get(row.hideId)
    if (!kept || kept.state !== 'IN_STOCK' || row.state === 'IN_STOCK') tags.set(row.hideId, { id: row.id, code: row.code, state: row.state })
  }
  return tags
}

interface Change {
  readonly cause: RemnantCause
  readonly workOrderId: string | null
  readonly locationId?: string | undefined
  readonly reason?: string | undefined
}

/** Moves each piece to `to` (those the state machine lets go there), with its audit row and event. Answers the moved. */
async function moveTo(tools: CommandTools, pieces: readonly RemnantRow[], to: RemnantState, change: Change): Promise<RemnantRow[]> {
  const moved: RemnantRow[] = []
  for (const piece of pieces) {
    if (!mayMoveRemnant(piece.state, to)) continue
    const data = { state: to, version: { increment: 1 }, updatedAt: tools.now, ...(change.locationId !== undefined ? { locationId: change.locationId } : {}) }
    const row = await tools.tx.remnant.update({ where: { id: piece.id }, data, select: REMNANT_SELECT })
    tools.audit({
      action: 'inventory.remnantState',
      recordType: 'Remnant',
      recordId: piece.id,
      companyId: piece.companyId,
      siteId: piece.siteId,
      before: { state: piece.state, locationId: piece.locationId },
      after: { state: to, locationId: row.locationId, cause: change.cause, workOrderId: change.workOrderId },
      ...(change.reason ? { reason: change.reason } : {}),
    })
    tools.emit({
      type: 'inventory.remnant_changed',
      subject: piece.id,
      companyId: piece.companyId,
      siteId: piece.siteId,
      payload: { remnantId: piece.id, code: piece.code, hideId: piece.hideId, from: piece.state, to, cause: change.cause, workOrderId: change.workOrderId },
    })
    moved.push(row)
  }
  return moved
}

const inState = (pieces: readonly RemnantRow[], state: RemnantState) => pieces.filter((piece) => piece.state === state)

export interface TagInput {
  /** The REMNANT move (or W1 RETURN) that put the piece into stock: never a reversal, of its hide, entering its place. */
  readonly move: { readonly id: string; readonly companyId: string; readonly siteId: string; readonly toLocationId: string | null; readonly quantity: string; readonly uom: Uom; readonly baseQuantity: string; readonly workOrderId: string | null }
  readonly hide: { readonly id: string; readonly lotId: string; readonly itemId: string }
  readonly baseUom: Uom
  readonly source: RemnantSource
  /** The piece's area when it is less than the move (a backfill of part of a return); default the move's. */
  readonly baseArea?: string | undefined
  readonly note?: string | null | undefined
}

/** Tags a piece that came back to stock (rules in the header). Answers the new row. */
export async function tagRemnantInCommand(tools: CommandTools, input: TagInput): Promise<RemnantRow> {
  const { move } = input
  if (!move.toLocationId) throw new ConflictError('A remnant lies where its move put it: the move enters no place.')
  const baseArea = input.baseArea ?? move.baseQuantity
  // In the unit it was measured in when that is an area unit and the whole move; else in the base unit.
  const asMeasured = input.baseArea === undefined && isAreaUom(move.uom)
  const area = asMeasured ? move.quantity : baseArea
  const areaUom: Uom = asMeasured ? move.uom : input.baseUom
  const [code] = (await allocateScanIds(tools, 'REMNANT', 1)).codes
  const id = newId()
  const row = await tools.tx.remnant.create({
    data: {
      id,
      companyId: move.companyId,
      siteId: move.siteId,
      lotId: input.hide.lotId,
      hideId: input.hide.id,
      code: code!,
      area: quantityText(area),
      areaUom,
      baseArea: quantityText(baseArea),
      locationId: move.toLocationId,
      moveId: move.id,
      note: input.note?.trim() || null,
      createdAt: tools.now,
      updatedAt: tools.now,
      createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
    },
    select: REMNANT_SELECT,
  })
  tools.audit({
    action: 'inventory.tagRemnant',
    recordType: 'Remnant',
    recordId: id,
    companyId: move.companyId,
    siteId: move.siteId,
    after: { code: row.code, hideId: input.hide.id, lotId: input.hide.lotId, moveId: move.id, area: row.area.toFixed(4), areaUom, baseArea: row.baseArea.toFixed(4), locationId: move.toLocationId, source: input.source },
  })
  tools.emit({
    type: 'inventory.remnant_tagged',
    subject: id,
    companyId: move.companyId,
    siteId: move.siteId,
    payload: { remnantId: id, code: row.code, hideId: input.hide.id, lotId: input.hide.lotId, itemId: input.hide.itemId, moveId: move.id, workOrderId: move.workOrderId, locationId: move.toLocationId, baseArea: row.baseArea.toFixed(4), source: input.source },
  })
  return row
}

export async function remnantsOnIssue(tools: CommandTools, hideId: string, workOrderId: string): Promise<RemnantRow[]> {
  return moveTo(tools, inState(await remnantsOfHides(tools.tx, [hideId]), 'IN_STOCK'), 'ISSUED', { cause: 'ISSUE', workOrderId })
}

export async function remnantsOnIssueReversed(tools: CommandTools, hideId: string, workOrderId: string): Promise<RemnantRow[]> {
  return moveTo(tools, inState(await remnantsOfHides(tools.tx, [hideId]), 'ISSUED'), 'IN_STOCK', { cause: 'ISSUE_REVERSED', workOrderId })
}

export async function remnantsOnWholeReturn(tools: CommandTools, hideId: string, workOrderId: string, toLocationId: string): Promise<RemnantRow[]> {
  return moveTo(tools, inState(await remnantsOfHides(tools.tx, [hideId]), 'ISSUED'), 'IN_STOCK', { cause: 'RETURN', workOrderId, locationId: toLocationId })
}

export async function remnantsOnClose(tools: CommandTools, hideId: string, workOrderId: string): Promise<RemnantRow[]> {
  return moveTo(tools, inState(await remnantsOfHides(tools.tx, [hideId]), 'ISSUED'), 'USED', { cause: 'CUT', workOrderId })
}

export async function remnantsOnReopen(tools: CommandTools, hideId: string, workOrderId: string): Promise<RemnantRow[]> {
  return moveTo(tools, revivedOnReopen(await remnantsOfHides(tools.tx, [hideId])), 'ISSUED', { cause: 'CLOSE_REVERSED', workOrderId })
}

/**
 * Before a REMNANT move's reversal is posted: refused in words (409) while one of its pieces went on. The caller posts the
 * reversal, then calls remnantsOnMoveReversed.
 */
export async function assertRemnantMoveReversible(tx: Reader, moveIds: readonly string[]): Promise<void> {
  if (moveIds.length === 0) return
  const pieces = await tx.remnant.findMany({ where: { moveId: { in: [...moveIds] } }, select: { code: true, state: true } })
  const refusal = goneOnRefusal(pieces)
  if (refusal) throw new RemnantRefusedError(refusal.code, refusal.message)
}

/** A refusal of the remnant rules: a 409 whose issue path is `refusal/<CODE>`. */
export class RemnantRefusedError extends ConflictError {
  override name = 'RemnantRefusedError'
  override readonly issues: readonly Issue[]
  constructor(
    readonly refusalCode: string,
    message: string,
  ) {
    super(message)
    this.issues = [{ path: `refusal/${refusalCode}`, message }]
  }
}

/** After a move of the hide was reversed (its mirror posted): REMNANT → its pieces VOID and the close's pieces back; RETURN → back at the work order. */
export async function remnantsOnMoveReversed(tools: CommandTools, original: { readonly id: string; readonly reason: string; readonly hideId: string | null; readonly workOrderId: string | null }): Promise<RemnantRow[]> {
  if (!original.hideId) return []
  const pieces = await remnantsOfHides(tools.tx, [original.hideId])
  if (original.reason === 'REMNANT') {
    const voided = await moveTo(
      tools,
      pieces.filter((piece) => piece.moveId === original.id),
      'VOID',
      { cause: 'MOVE_REVERSED', workOrderId: original.workOrderId },
    )
    if (!original.workOrderId) return voided
    const revived = await moveTo(tools, revivedOnReopen(await remnantsOfHides(tools.tx, [original.hideId])), 'ISSUED', { cause: 'MOVE_REVERSED', workOrderId: original.workOrderId })
    return [...voided, ...revived]
  }
  if (original.reason === 'RETURN' && original.workOrderId) {
    return moveTo(tools, inState(pieces, 'IN_STOCK'), 'ISSUED', { cause: 'RETURN_REVERSED', workOrderId: original.workOrderId })
  }
  return []
}

export async function remnantsOnScrap(tools: CommandTools, hideId: string, reason: string): Promise<RemnantRow[]> {
  return moveTo(tools, inState(await remnantsOfHides(tools.tx, [hideId]), 'IN_STOCK'), 'SCRAPPED', { cause: 'SCRAP', workOrderId: null, reason })
}

export async function remnantsOnScrapReversed(tools: CommandTools, hideId: string, reason: string): Promise<RemnantRow[]> {
  return moveTo(tools, inState(await remnantsOfHides(tools.tx, [hideId]), 'SCRAPPED'), 'IN_STOCK', { cause: 'SCRAP_REVERSED', workOrderId: null, reason })
}

/**
 * postMoves' hook (B-W2b-100): a TRANSFER of a hide's stock takes its pieces in stock to the move's place, in the same
 * command (a remnant says where it lies). Only the place changes, so no state event: the move's own inventory.moved says it.
 */
export async function remnantsFollowTransfers(tools: CommandTools, moves: readonly { readonly reason: string; readonly hideId: string | null; readonly toLocationId: string | null }[]): Promise<void> {
  const transfers = moves.filter((move) => move.reason === 'TRANSFER' && move.hideId !== null && move.toLocationId !== null)
  if (transfers.length === 0) return
  const pieces = inState(await remnantsOfHides(tools.tx, transfers.map((move) => move.hideId!)), 'IN_STOCK')
  for (const move of transfers) {
    for (const piece of pieces.filter((row) => row.hideId === move.hideId && row.locationId !== move.toLocationId)) {
      await tools.tx.remnant.update({ where: { id: piece.id }, data: { locationId: move.toLocationId, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ action: 'inventory.remnantPlace', recordType: 'Remnant', recordId: piece.id, companyId: piece.companyId, siteId: piece.siteId, before: { locationId: piece.locationId }, after: { locationId: move.toLocationId } })
    }
  }
}
