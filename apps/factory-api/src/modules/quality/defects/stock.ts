import type { Uom } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { stockActionWords, type DispositionFollowUp, type DispositionMove, type DispositionOutcome } from '@nexus/factory-domain/quality/defects/rules'
import { ZERO } from '@nexus/factory-domain/tax/decimal'
import type { CommandTools } from '../../../core/command'
import { readHides, readSiteStock } from '../../inventory/issue/store'
import { completeKeys, postMoves, type MoveDraft, type PostedMove } from '../../inventory/ledger/post-moves'
import { lockReservations, reserveKeyOf, type ReserveKey } from '../../inventory/reservations/store'
import { holdOnIssue } from '../holds/checks'
import { dispositionCodeOf, type DispositionRow } from './dispositions'

/**
 * Dispositions mapped to stock actions (B-W2a-26; QHS-005: "one decision should move the stock and start the rework
 * without retyping"). INSIDE the deciding command (the NCR's decision done, B-W2a-47): the code's stock move, posted
 * through the inventory ledger's one writer (`postMoves`, inventory/ledger) — never a hand-written move:
 *
 *   SCRAP       the stock leaves the site as SCRAP from where it lies (a hide left with nothing is SCRAPPED).
 *   TRANSFER    the stock moves to `toLocationId`: a QUARANTINE place of the site for the QUARANTINE outcome, any other
 *               place of the site (a second-quality shelf) for REGRADE and RETURN_TO_SUPPLIER.
 *   ADJUSTMENT  the stock leaves the site as an ADJUSTMENT out (the goods go back to the supplier).
 *   ISSUE       the stock is issued to `workOrderId` (refused while a hold blocks it: close or release the hold first).
 *   none        no move (use as is, rework, repair): `lines` must be empty.
 *
 * Lock order: the reserve lock of each item and colour (inventory reservations: before the stock locks), then postMoves'
 * stock locks; the caller's own locks (its NCR row) come first. Answers the moves posted, the follow-up the code opens
 * (the caller opens it: a rework order, a repair, a supplier claim) and whether the goods are inspected again. Refusals
 * are in words at `<path>/lines/<i>/…`.
 */

export interface DispositionStockLine {
  readonly itemId?: string | undefined
  readonly itemColourId?: string | null | undefined
  readonly lotId?: string | null | undefined
  /** A hide moves whole from every place that holds it unless `quantity` and `fromLocationId` say otherwise. */
  readonly hideId?: string | null | undefined
  readonly fromLocationId?: string | undefined
  readonly quantity?: string | undefined
  readonly uom?: Uom | undefined
  readonly baseQuantity?: string | undefined
}

export interface DispositionStockInput {
  readonly dispositionCodeId: string
  readonly siteId: string
  readonly lines: readonly DispositionStockLine[]
  /** TRANSFER: where the goods go. */
  readonly toLocationId?: string | null | undefined
  /** ISSUE: the work order they are issued to. */
  readonly workOrderId?: string | null | undefined
  /** The deciding record's number (an NCR's): the moves' reference. */
  readonly reference: string
  /** Why, in words: the moves' note (`<CODE>: <note>`). */
  readonly note: string
  /** The command's key: the moves' keys are `<key>:<n>`. */
  readonly key: string
  /** Where the refusals point (default `body`). */
  readonly path?: string | undefined
}

export interface DispositionStockResult {
  readonly code: DispositionRow
  readonly move: DispositionMove | null
  readonly moves: PostedMove[]
  /** Hides left with nothing in stock by this scrap or return: SCRAPPED. */
  readonly scrappedHides: string[]
  /** What the caller opens next (null: nothing). */
  readonly followUp: DispositionFollowUp | null
  readonly reinspection: boolean
  /** The code's action in words. */
  readonly words: string
}

/** The disposition's stock move, inside the deciding command. */
export async function postDispositionInCommand(tools: CommandTools, input: DispositionStockInput): Promise<DispositionStockResult> {
  const { tx } = tools
  const base = input.path ?? 'body'
  const at = (index: number, field?: string) => `${base}/lines/${index}${field ? `/${field}` : ''}`
  const code = await dispositionCodeOf(tx, input.dispositionCodeId)
  if (!code) throw new NotFoundError('Disposition code not found.')
  if (!code.active) throw new ConflictError(`Disposition ${code.code} is inactive: pick an active one.`)
  const move = code.stockMoveReason as DispositionMove | null
  const action = { outcome: code.outcome as DispositionOutcome, stockMoveReason: move, followUp: code.followUp as DispositionFollowUp | null, reinspection: code.reinspection }
  const answer = (moves: PostedMove[], scrappedHides: string[]): DispositionStockResult => ({ code, move, moves, scrappedHides, followUp: action.followUp, reinspection: code.reinspection, words: stockActionWords(action) })

  if (move === null) {
    if (input.lines.length > 0) throw new ValidationError(`${code.code} moves no stock: send no lines.`, [{ path: `${base}/lines`, message: stockActionWords(action) }])
    return answer([], [])
  }
  if (input.lines.length === 0) throw new ValidationError(`${code.code} moves stock: name what it moves.`, [{ path: `${base}/lines`, message: stockActionWords(action) }])
  if (!input.note.trim()) throw new ValidationError('Say why, in words.', [{ path: `${base}/note`, message: 'The moves keep the reason.' }])

  const site = await tx.site.findUnique({ where: { id: input.siteId }, select: { id: true, companyId: true } })
  if (!site) throw new NotFoundError('Site not found.')
  let toLocationId: string | null = null
  let workOrderId: string | null = null
  if (move === 'TRANSFER') {
    const to = input.toLocationId && isUuid(input.toLocationId) ? await tx.location.findUnique({ where: { id: input.toLocationId }, select: { id: true, siteId: true, kind: true, code: true, status: true } }) : null
    if (!to || to.siteId !== site.id) throw new ValidationError('Name the place the goods go to.', [{ path: `${base}/toLocationId`, message: 'A place of the site.' }])
    if (code.outcome === 'QUARANTINE' && to.kind !== 'QUARANTINE') throw new ValidationError(`${to.code} is not a quarantine place.`, [{ path: `${base}/toLocationId`, message: 'A QUARANTINE place of the site.' }])
    toLocationId = to.id
  }
  if (move === 'ISSUE') {
    const order = input.workOrderId && isUuid(input.workOrderId) ? await tx.workOrder.findUnique({ where: { id: input.workOrderId }, select: { id: true, siteId: true } }) : null
    if (!order || order.siteId !== site.id) throw new ValidationError('Name the work order the goods are issued to.', [{ path: `${base}/workOrderId`, message: 'A work order of the site.' }])
    workOrderId = order.id
  }

  const note = `${code.code}: ${input.note.trim()}`
  const hides = await readHides(tx, input.lines.flatMap((line) => (line.hideId && isUuid(line.hideId) ? [line.hideId] : [])))
  const drafts: MoveDraft[] = []
  const lineOf: number[] = []
  const problems: Issue[] = []
  for (const [index, line] of input.lines.entries()) {
    const common = { siteId: site.id, reason: move, note, reference: input.reference, ...(toLocationId ? { toLocationId } : {}), ...(workOrderId ? { workOrderId } : {}) }
    if (line.hideId) {
      const hide = hides.get(line.hideId)
      if (!hide || hide.siteId !== site.id) {
        problems.push({ path: at(index, 'hideId'), message: 'Not a hide of this site.' })
        continue
      }
      const held = (await readSiteStock(tx, site.id, { itemIds: [hide.itemId], hideId: hide.id })).filter((balance) => !line.fromLocationId || balance.locationId === line.fromLocationId)
      if (held.length === 0) {
        problems.push({ path: at(index, 'hideId'), message: `Hide ${hide.code} is not in stock${line.fromLocationId ? ' at that place' : ''}.` })
        continue
      }
      if (line.quantity && held.length > 1) {
        problems.push({ path: at(index, 'fromLocationId'), message: `Hide ${hide.code} lies at ${held.length} places: name the one.` })
        continue
      }
      for (const balance of held) {
        if (balance.locationId === toLocationId) continue
        drafts.push({ ...common, itemId: hide.itemId, lotId: hide.lotId, hideId: hide.id, fromLocationId: balance.locationId, quantity: line.quantity ?? balance.onHand.toFixed(4), ...(line.uom ? { uom: line.uom } : {}), ...(line.baseQuantity ? { baseQuantity: line.baseQuantity } : {}) })
        lineOf.push(index)
      }
    } else {
      if (!line.itemId && !line.lotId) problems.push({ path: at(index, 'itemId'), message: 'Name the material, its lot, or a hide.' })
      else if (!line.fromLocationId) problems.push({ path: at(index, 'fromLocationId'), message: 'Name the place it leaves.' })
      else if (!line.quantity) problems.push({ path: at(index, 'quantity'), message: 'Name how much.' })
      else if (line.fromLocationId === toLocationId) problems.push({ path: at(index, 'fromLocationId'), message: 'It lies there already.' })
      else {
        const itemId = line.itemId ?? (await tx.lot.findUnique({ where: { id: line.lotId! }, select: { itemId: true } }))?.itemId
        if (!itemId) {
          problems.push({ path: at(index, 'lotId'), message: 'Not a lot of this site.' })
          continue
        }
        drafts.push({
          ...common,
          itemId,
          ...(line.itemColourId !== undefined ? { itemColourId: line.itemColourId } : {}),
          ...(line.lotId !== undefined ? { lotId: line.lotId } : {}),
          hideId: null,
          fromLocationId: line.fromLocationId,
          quantity: line.quantity,
          ...(line.uom ? { uom: line.uom } : {}),
          ...(line.baseQuantity ? { baseQuantity: line.baseQuantity } : {}),
        })
        lineOf.push(index)
      }
    }
  }
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'Some lines cannot move.', problems)
  if (drafts.length === 0) throw new ValidationError('Nothing to move: the goods lie there already.', [{ path: `${base}/lines`, message: 'Nothing to move.' }])

  const keyed = await completeKeys(tx, drafts)
  if (move === 'ISSUE') {
    // A hold blocks an issue (the database too): close or release it first, in words.
    for (const draft of keyed) {
      const held = await holdOnIssue(tx, tools.context, { lotId: draft.lotId ?? null, hideId: draft.hideId ?? null, workOrderId })
      if (held) throw new ConflictError(held)
    }
  }
  if (move !== 'TRANSFER') {
    const keys = new Map<string, ReserveKey>(keyed.map((draft) => [reserveKeyOf({ siteId: site.id, itemId: draft.itemId, itemColourId: draft.itemColourId }), { siteId: site.id, itemId: draft.itemId, itemColourId: draft.itemColourId }]))
    await lockReservations(tx, tenantOf(tools), [...keys.values()])
  }
  const moves = await postMoves(tools, keyed, { key: input.key, issuePath: (index) => at(lineOf[index]!) })

  // A hide that left the site (scrapped, sent back) with nothing in stock is SCRAPPED, as production's scrap does.
  const scrappedHides: string[] = []
  if (move === 'SCRAP' || move === 'ADJUSTMENT') {
    for (const hide of hides.values()) {
      const left = (await readSiteStock(tx, site.id, { itemIds: [hide.itemId], hideId: hide.id })).reduce((sum, balance) => sum.plus(balance.onHand), ZERO)
      if (left.gt(0) || hide.state === 'SCRAPPED' || hide.state === 'CONSUMED') continue
      await tx.hide.update({ where: { id: hide.id }, data: { state: 'SCRAPPED', version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'inventory.hideState', recordType: 'Hide', recordId: hide.id, companyId: site.companyId, siteId: site.id, before: { state: hide.state }, after: { state: 'SCRAPPED' }, reason: note })
      scrappedHides.push(hide.id)
    }
  }
  return answer(moves, scrappedHides)
}

const tenantOf = (tools: Pick<CommandTools, 'context'>): string => {
  const context = tools.context
  if (!('tenantId' in context) || !context.tenantId) throw new Error('postDispositionInCommand needs a tenant context')
  return context.tenantId
}
