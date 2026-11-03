import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { RollChange } from '@nexus/factory-domain/inventory-rolls/events'
import { INVENTORY_RECEIVE, INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { INVENTORY_ROLLS_MANAGE } from '@nexus/factory-domain/inventory/rolls/permissions'
import {
  describeRefusal,
  descriptionProblems,
  endDecision,
  isLengthUom,
  lengthIn,
  ROLL_LIMITS,
  rollDraftProblems,
  rollShadeProblem,
  tagRefusal,
  untaggedAt,
  type LengthUom,
  type RollDescription,
} from '@nexus/factory-domain/inventory/rolls/rolls'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { allocateScanIds } from '../../../platform/numbering/scan-ids'
import { mayAt, postedBy, stockContextOf, type StockContext } from '../ledger/access'
import { lengthUom, lockLotRolls, lotCheckOf, LOT_SELECT, placesOf, refuseRoll, rollFactsOf, rollFor, ROLL_SELECT, rollView, type LotRow, type RollRow } from './facts'

/**
 * Tagging a fabric lot's rolls and correcting what a roll is (B-W2b-107; SCM-260; design floor.receive "how it is tracked
 * (hide, roll, lot)", floor.incoming "rolls: width and length pads", production.cutting "rolls by shade, width and shrinkage
 * group").
 *
 *   POST  /inventory/lots/:lotId/rolls   office and the receiving tablet at its site (inventory.receive): rolls of what the
 *                                        lot holds at a place that no roll claims yet, each with its length (in the lot's
 *                                        length unit, or another length unit), the supplier's number, width, shade (a group
 *                                        of the article, or words), shrinkage and defects. ONE command under the lot's roll
 *                                        lock: the lot's stock per place read from the ledger, never more than a place holds
 *                                        without a roll (409 in words), tags from the tenant's ROLL scan ids (online), the
 *                                        rows, an audit row each, fabric_roll.tagged. No stock moves: the stock came in with
 *                                        its receipt or opening move; a roll is the tag and what is left.
 *   PATCH /inventory/rolls/:rollId       office (inventory.rolls.manage): at the roll's version, its supplier number, width,
 *                                        shade group (its label is the shade text) or shade words, shrinkage, defects, note,
 *                                        and `end` (a part roll set aside as an end of roll, or back). A scrapped or returned
 *                                        roll is history. Audit before → after, fabric_roll.changed.
 */

interface RollDraftBody extends RollDescription {
  readonly length: string
  readonly shadeGroupId?: string | null | undefined
}

export interface TagBody {
  readonly locationId?: string | undefined
  readonly uom?: LengthUom | undefined
  readonly rolls: readonly RollDraftBody[]
}

const refuse = (problems: readonly Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

/** The lot the caller tags: the office sees it with inventory.stock.view (else not found) and tags with inventory.receive. */
async function lotFor(caller: CommandCaller, lotId: string): Promise<{ lot: LotRow; context: StockContext }> {
  const context = stockContextOf(caller)
  const lot = isUuid(lotId) ? await caller.withClient((client) => client.lot.findUnique({ where: { id: lotId }, select: LOT_SELECT })) : null
  const sees = lot !== null && mayAt(context, context.audience === 'office' ? INVENTORY_STOCK_VIEW : INVENTORY_RECEIVE, lot)
  if (!lot || !sees) throw new NotFoundError('Lot not found.')
  if (!mayAt(context, INVENTORY_RECEIVE, lot)) throw new ForbiddenError("Tagging rolls is receiving's: it needs inventory.receive at the lot's site.")
  return { lot, context }
}

type ShadeGroupRow = { id: string; itemId: string; itemColourId: string | null; lotId: string | null; label: string; active: boolean }
async function shadeGroupsOf(tx: Pick<CommandTx, 'shadeGroup'>, ids: readonly string[]): Promise<Map<string, ShadeGroupRow>> {
  const unique = [...new Set(ids)].filter(isUuid)
  if (unique.length === 0) return new Map()
  return new Map((await tx.shadeGroup.findMany({ where: { id: { in: unique } }, select: { id: true, itemId: true, itemColourId: true, lotId: true, label: true, active: true } })).map((row) => [row.id, row]))
}

const text = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}
const decimalOrNull = (value: string | null | undefined, scale: number): string | null => (value === null || value === undefined || value.trim() === '' ? null : new Dec(value.trim()).toFixed(scale))

/** POST /inventory/lots/:lotId/rolls. */
export async function tagRolls(caller: CommandCaller, lotId: string, body: TagBody, idempotencyKey?: string) {
  const { lot, context } = await lotFor(caller, lotId)
  const base = lot.item.baseUom
  if (lot.item.tracking !== 'LOT' || !isLengthUom(base)) {
    refuseRoll({ code: 'NOT_A_FABRIC_LOT', message: `Lot ${lot.code} is of ${lot.item.code}, ${lot.item.tracking === 'LOT' ? `counted in ${base}` : `tracked by ${lot.item.tracking}`}: rolls are parts of a lot counted by length.` })
  }
  const baseUom = base as LengthUom
  const uom = body.uom ?? baseUom
  if (body.rolls.length === 0 || body.rolls.length > ROLL_LIMITS.perTag) refuse([{ path: 'rolls', message: `From 1 to ${ROLL_LIMITS.perTag} rolls at a time.` }], 'Name the rolls.')
  const problems = body.rolls.flatMap((roll, index) => rollDraftProblems(roll, uom).map((problem) => ({ ...problem, path: `rolls/${index}/${problem.path}` })))
  if (problems.length > 0) refuse(problems, 'Some rolls are not valid.')

  const { result } = await command(caller, { name: 'inventory.tagRolls', idempotencyKey, input: { lotId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockLotRolls(tx, context.tenantId, lot.id)
    const { check } = await lotCheckOf(tx, lot, baseUom)
    const free = check.places.filter((place) => untaggedAt(place).greaterThan(0))
    let locationId = body.locationId
    if (!locationId) {
      if (free.length !== 1) {
        const where = await placesOf(tx, free.map((place) => place.locationId))
        refuse(
          [{ path: 'locationId', message: free.length === 0 ? `Lot ${lot.code} has nothing in stock that no roll claims.` : `Name the place: lot ${lot.code} lies at ${[...where.values()].map((place) => place.code).join(', ')}.` }],
          'Name the place.',
        )
      }
      locationId = free[0]!.locationId
    }
    const place = check.places.find((entry) => entry.locationId === locationId)
    const placeCode = (await placesOf(tx, [locationId])).get(locationId)?.code ?? 'that place'
    const refusal = tagRefusal(lot.code, placeCode, place, body.rolls.map((roll) => lengthIn(roll.length, uom, baseUom)), baseUom)
    if (refusal) refuseRoll(refusal)

    const groups = await shadeGroupsOf(tx, body.rolls.flatMap((roll) => (roll.shadeGroupId ? [roll.shadeGroupId] : [])))
    const shadeProblems: Issue[] = []
    body.rolls.forEach((roll, index) => {
      if (!roll.shadeGroupId) return
      const group = groups.get(roll.shadeGroupId)
      const problem = group ? rollShadeProblem(group, { code: `#${index + 1}`, itemId: lot.itemId, lotId: lot.id, itemColourId: lot.itemColourId, shadeGroupId: null }) : 'Not a shade group of this tenant.'
      if (problem) shadeProblems.push({ path: `rolls/${index}/shadeGroupId`, message: problem })
    })
    if (shadeProblems.length > 0) refuse(shadeProblems, 'Some shade groups do not fit these rolls.')

    const tags = await allocateScanIds(tools, 'ROLL', body.rolls.length)
    const by = postedBy(context)
    const rows: Prisma.FabricRollCreateManyInput[] = body.rolls.map((roll, index) => {
      const length = new Dec(roll.length).toFixed(4)
      const group = roll.shadeGroupId ? groups.get(roll.shadeGroupId)! : null
      return {
        id: newId(),
        companyId: lot.companyId,
        siteId: lot.siteId,
        itemId: lot.itemId,
        lotId: lot.id,
        code: tags.codes[index]!,
        supplierRollRef: text(roll.supplierRollRef),
        length,
        uom,
        lengthLeft: length,
        widthCm: decimalOrNull(roll.widthCm, 2),
        shade: group ? group.label : text(roll.shade),
        shadeGroupId: group ? group.id : null,
        shrinkageLengthPercent: decimalOrNull(roll.shrinkageLengthPercent, 2),
        shrinkageWidthPercent: decimalOrNull(roll.shrinkageWidthPercent, 2),
        shrinkageGroup: text(roll.shrinkageGroup),
        defects: text(roll.defects),
        locationId: locationId!,
        state: 'FULL',
        note: text(roll.note),
        createdAt: now,
        updatedAt: now,
        // The office person; a roll tagged on a tablet names no worker.
        createdById: by.audience === 'OFFICE' ? by.createdById : null,
      }
    })
    await tx.fabricRoll.createMany({ data: rows })
    for (const row of rows) {
      tools.audit({
        action: 'inventory.tagRoll',
        recordType: 'FabricRoll',
        recordId: row.id,
        companyId: lot.companyId,
        siteId: lot.siteId,
        after: { code: row.code, lotId: lot.id, length: row.length, uom, lengthLeft: row.lengthLeft, state: 'FULL', locationId: row.locationId, widthCm: row.widthCm ?? null, shadeGroupId: row.shadeGroupId ?? null },
      })
    }
    tools.emit({
      type: 'fabric_roll.tagged',
      subject: lot.id,
      companyId: lot.companyId,
      siteId: lot.siteId,
      payload: { lotId: lot.id, itemId: lot.itemId, locationId: locationId!, rollIds: rows.map((row) => row.id), codes: rows.map((row) => row.code), postedBy: by.audience },
    })
    const created = await tx.fabricRoll.findMany({ where: { id: { in: rows.map((row) => row.id) } }, select: ROLL_SELECT, orderBy: { code: 'asc' } })
    return { rolls: created.map(rollView), lot: (await lotCheckOf(tx, lot, baseUom)).view }
  })
  return result
}

// ---- describe -------------------------------------------------------------------------------------------------------------

export interface DescribeBody extends RollDescription {
  readonly version: number
  readonly shadeGroupId?: string | null | undefined
  /** true: a part roll set aside as an end of roll; false: back to a part roll. */
  readonly end?: boolean | undefined
}

const DESCRIBED = ['supplierRollRef', 'widthCm', 'shade', 'shadeGroupId', 'shrinkageLengthPercent', 'shrinkageWidthPercent', 'shrinkageGroup', 'defects', 'note', 'state'] as const
type Described = Record<(typeof DESCRIBED)[number], string | null>

const describedOf = (row: RollRow): Described => ({
  supplierRollRef: row.supplierRollRef,
  widthCm: row.widthCm === null ? null : new Dec(row.widthCm.toString()).toFixed(2),
  shade: row.shade,
  shadeGroupId: row.shadeGroupId,
  shrinkageLengthPercent: row.shrinkageLengthPercent === null ? null : new Dec(row.shrinkageLengthPercent.toString()).toFixed(2),
  shrinkageWidthPercent: row.shrinkageWidthPercent === null ? null : new Dec(row.shrinkageWidthPercent.toString()).toFixed(2),
  shrinkageGroup: row.shrinkageGroup,
  defects: row.defects,
  note: row.note,
  state: row.state,
})

/** What the body makes of the roll (null fields clear), checked against its groups; problems paths relative to the body. */
async function nextOf(tx: Pick<CommandTx, 'shadeGroup'>, row: RollRow, body: DescribeBody): Promise<{ next: Described; problems: Issue[] }> {
  const next: Described = { ...describedOf(row) }
  const problems: Issue[] = descriptionProblems(body)
  if (body.supplierRollRef !== undefined) next.supplierRollRef = text(body.supplierRollRef)
  if (body.widthCm !== undefined) next.widthCm = decimalOrNull(body.widthCm, 2)
  if (body.shrinkageLengthPercent !== undefined) next.shrinkageLengthPercent = decimalOrNull(body.shrinkageLengthPercent, 2)
  if (body.shrinkageWidthPercent !== undefined) next.shrinkageWidthPercent = decimalOrNull(body.shrinkageWidthPercent, 2)
  if (body.shrinkageGroup !== undefined) next.shrinkageGroup = text(body.shrinkageGroup)
  if (body.defects !== undefined) next.defects = text(body.defects)
  if (body.note !== undefined) next.note = text(body.note)
  if (body.shadeGroupId !== undefined) {
    if (body.shadeGroupId === null) {
      // Clearing the group clears its label; words given with it stay.
      next.shadeGroupId = null
      next.shade = body.shade !== undefined ? text(body.shade) : row.shadeGroupId ? null : row.shade
    } else {
      const group = (await shadeGroupsOf(tx, [body.shadeGroupId])).get(body.shadeGroupId)
      const problem = group ? rollShadeProblem(group, { code: row.code, itemId: row.itemId, lotId: row.lotId, itemColourId: row.lot.itemColourId, shadeGroupId: row.shadeGroupId }) : 'Not a shade group of this tenant.'
      if (problem) problems.push({ path: 'shadeGroupId', message: problem })
      else {
        next.shadeGroupId = group!.id
        next.shade = group!.label
        if (body.shade !== undefined && text(body.shade) !== group!.label) problems.push({ path: 'shade', message: `The shade is its group's label (${group!.label}).` })
      }
    }
  } else if (body.shade !== undefined) {
    if (row.shadeGroupId && text(body.shade) !== row.shade) problems.push({ path: 'shade', message: `The shade is its group's label (${row.shade ?? ''}): pick another group, or clear it (shadeGroupId null) to write words.` })
    else next.shade = text(body.shade)
  }
  if (body.end !== undefined) {
    const decision = endDecision(rollFactsOf(row), body.end)
    if (!decision.ok && decision.refusal.code !== 'NOTHING_CHANGES') refuseRoll(decision.refusal)
    if (decision.ok) next.state = decision.after.state
  }
  return { next, problems }
}

const changedOf = (before: Described, after: Described) => DESCRIBED.filter((field) => before[field] !== after[field])

/** PATCH /inventory/rolls/:rollId. */
export async function describeRoll(caller: CommandCaller, rollId: string, body: DescribeBody, idempotencyKey?: string) {
  const { row } = await rollFor(caller, rollId, INVENTORY_ROLLS_MANAGE)
  const gone = describeRefusal(rollFactsOf(row))
  if (gone) refuseRoll(gone)
  const preview = await caller.withClient((client) => nextOf(client, row, body))
  if (preview.problems.length > 0) refuse(preview.problems, 'The roll is not valid.')
  if (changedOf(describedOf(row), preview.next).length === 0) return { roll: rollView(row) }

  const { result } = await command(caller, { name: 'inventory.describeRoll', idempotencyKey, input: { rollId, ...body }, record: { type: 'FabricRoll', id: row.id, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = await tx.fabricRoll.findUniqueOrThrow({ where: { id: row.id }, select: ROLL_SELECT })
    const stillGone = describeRefusal(rollFactsOf(current))
    if (stillGone) refuseRoll(stillGone)
    const { next, problems } = await nextOf(tx, current, body)
    if (problems.length > 0) refuse(problems, 'The roll is not valid.')
    const before = describedOf(current)
    const changed = changedOf(before, next)
    await tx.fabricRoll.update({ where: { id: current.id }, data: { ...(Object.fromEntries(changed.map((field) => [field, next[field]])) as Prisma.FabricRollUncheckedUpdateInput), updatedAt: now }, select: { id: true } })
    const updated = await tx.fabricRoll.findUniqueOrThrow({ where: { id: current.id }, select: ROLL_SELECT })
    describedAudit(tools, updated, before, next, changed)
    const change: RollChange = changed.length === 1 && changed[0] === 'state' ? (next.state === 'END' ? 'END_SET' : 'END_CLEARED') : 'DESCRIBED'
    emitChange(tools, updated, change, [], null)
    return { roll: rollView(updated) }
  })
  return result
}

function describedAudit(tools: Pick<CommandTools, 'audit'>, row: RollRow, before: Described, after: Described, changed: readonly (keyof Described)[]): void {
  tools.audit({
    action: 'inventory.describeRoll',
    recordType: 'FabricRoll',
    recordId: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    before: { ...Object.fromEntries(changed.map((field) => [field, before[field]])), state: before.state, lengthLeft: new Dec(row.lengthLeft.toString()).toFixed(4) },
    after: { ...Object.fromEntries(changed.map((field) => [field, after[field]])), state: after.state, lengthLeft: new Dec(row.lengthLeft.toString()).toFixed(4) },
  })
}

/** The roll's change as its event (every roll write emits one). */
export function emitChange(tools: Pick<CommandTools, 'emit' | 'context'>, row: RollRow, change: RollChange, moveIds: readonly string[], workOrderId: string | null): void {
  tools.emit({
    type: 'fabric_roll.changed',
    subject: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    payload: {
      rollId: row.id,
      code: row.code,
      lotId: row.lotId,
      change,
      state: row.state,
      lengthLeft: new Dec(row.lengthLeft.toString()).toFixed(4),
      uom: lengthUom(row.uom),
      moveIds: [...moveIds],
      workOrderId,
      postedBy: postedBy(stockContextOf({ factoryContext: tools.context, withClient: () => Promise.reject(new Error('inside a command')) })).audience,
    },
  })
}
