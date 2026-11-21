import { InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import { PRODUCTION_BRAND_MANAGE } from '@nexus/factory-domain/production-brand/permissions'
import { handMoveOf, STAGE_SET_REFUSAL_WORDS, stageSetAskProblems, stageSetStateProblems, type HandStage, type StageSetReasonCode } from '@nexus/factory-domain/production-brand/stage-set'
import type { BrandStage } from '@nexus/factory-domain/production-brand/stages'
import type { SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { officeContextOf } from '../work-orders/access'
import type { Reader } from '../work-orders/store'
import { lockOrder, officeOrder } from './health'
import { CLEAR_BRAND_STAGE, keepInCommand, SET_BRAND_STAGE, tellStageOnce, untellWaiting } from './keeper' // B-MS-008: untellWaiting
import { readHandFloor, tellCorrection } from './keeper' // B-SC-004

/**
 * B-MS-005 — the office sets an order's stage by hand (set-the-stage-by-hand plan.md D1–D9, design A; review fixes R1, R4, R6, R9,
 * R11, R12, R15, R19; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as
 * the production unit, should be able to see it all. And manage it all as well."). The ONE named exception to "a stage is only the
 * floor's and quality's". B-SC-004 (stage control B, "full control", the Owner's pick 2026-11-21): a person of the office sets the
 * stage the customer reads where the work really is — ANY of the five, forward or back, also below what the floor recorded (a wrong
 * scan) and Ready to ship (the dialog warns while quality has not released every piece) — with a reason and an office-only note.
 * Only the stage: the counts, quality's records, the order's status, the shipments, the change cut-offs, Mark urgent and planning
 * stay on the floor's records (factory-domain production-brand/stage-set).
 *
 *   set     PUT /production/brand-orders/:orderId/stage {stage, reasonCode, note?, version} (production.brand.manage): only an order
 *           In production or Partly shipped (R4), never while the customer's own pause stands (R19), a Set never at the stage the
 *           customer reads already, and never the LIVE floor's own stage while a hand stage stands (R12; Clear goes back to it). A
 *           Change is the same call while one stands: it replaces it, forward or back; at the same stage it changes only the reason
 *           or the note (audited, nothing told, the floor at the set kept) — all three unchanged: nothing to change (409).
 *   clear   DELETE the same ?version (production.brand.manage): the stage goes back to the live floor's (a step back on the floor's
 *           own day, R15).
 *   told    one rule for Set, Change and Clear (handMoveOf on the stage the customer reads): a forward move is told once
 *           (./keeper tellStageOnce, by hand); a move back is told once as a correction when the stage it leaves was told
 *           (./keeper tellCorrection), else nothing — every notice by hand waits the 10-minute undo window.
 *
 * The wall first (R11): the order is found by its id and the caller must reach its company AND its customer (./health officeOrder),
 * before anything about its state is read — another customer's order is "Sales order not found.", the words of an unknown id, and
 * never "The floor already shows Sewing". What is asked is judged next (400, in words); then ONE command under the keeper's own
 * advisory lock of the order (./health lockOrder): the production state's version as read (R9: required; null only while the order
 * has no production state yet), the keeper's own pass in the same command (./keeper keepInCommand: the facts read again under the
 * lock; with no row it MAKES it at Preparing with its first-stage marker, R1), the state judged against that live floor (409, in
 * words), then `stage` = the hand stage and the five columns (the database's guard: while it stands `stage` equals it; the setter an
 * active office person). Each write is audited twice: on the BrandOrderProduction row (before: stage, its day, the hand stage; after:
 * the stage, the hand stage, the floor — B-SC-004: the keeper's floorAtSet, ./keeper readHandFloor — the reason, the note; the
 * floor's day the Clear restores) and on the SalesOrder (R6: the
 * order's History reads only its own rows; `production.setBrandStage` / `production.clearBrandStage`, from → to as `stage`, the note
 * in `after` and never in `reason`, and NEVER a `status` key — the portal's order history and madeWaiting read that key). A forward
 * move of the stage the customer reads is told once (./keeper tellStageOnce), in the order's own customer's name, with the stage
 * before the set as `previous` (Preparing for a row just made, so the first-stage rule does not swallow it: R1). No new event and no
 * new worker handler: the customer reads a plain stage and the usual notice, never "by hand", the reason, the note or who.
 *
 * B-MS-008 (Owner D4: the 10-minute undo window; review R3a): the set's tell carries `byHand`, so the customer's notice waits 10
 * minutes (the partner fan-out's delayMs); the portal reads the stage at once. A Change or a Clear inside the window leaves the stage
 * it replaces untold (./keeper untellWaiting: the notice is dropped by its own check, and the stage is told when the floor reaches
 * it); after the window a notice sent stays sent.
 */

const HAND_SELECT = {
  id: true,
  partyId: true,
  salesOrderId: true,
  stage: true,
  stageAt: true,
  stageSet: true,
  stageSetReason: true,
  stageSetNote: true,
  stageSetAt: true,
  stageSetById: true,
  version: true,
} as const

interface HandRow {
  readonly id: string
  readonly partyId: string
  readonly salesOrderId: string
  readonly stage: BrandStage
  readonly stageAt: Date
  readonly stageSet: HandStage | null
  readonly stageSetReason: StageSetReasonCode | null
  readonly stageSetNote: string | null
  readonly stageSetAt: Date | null
  readonly stageSetById: string | null
  readonly version: number
}

/** "No stage set by hand stands on this order" (a Clear with none; office "tu" in Italian, "la fase" feminine). */
export const NO_HAND_STAGE_WORDS: Words = Object.freeze({
  it: "Su questo ordine non c'è una fase impostata a mano: il cliente legge la fase del reparto.",
  en: "No stage set by hand stands on this order: the customer reads the floor's stage.",
})

async function readHand(db: Reader, orderId: string): Promise<HandRow | null> {
  const row = await db.brandOrderProduction.findFirst({ where: { key: `brand-production:${orderId}` }, select: HAND_SELECT })
  if (!row) return null
  return { ...row, stage: row.stage as BrandStage, stageSet: row.stageSet as HandStage | null, stageSetReason: row.stageSetReason as StageSetReasonCode | null }
}

/** R9: the version the caller read — the production row's; null only while the order has no production state yet (R1). */
function checkVersion(row: HandRow | null, orderId: string, sent: number | null): void {
  const fresh = row === null ? sent === null : sent === row.version
  if (!fresh) throw new StaleVersionError('BrandOrderProduction', row?.id ?? orderId, row?.version ?? 0, sent ?? 0)
}

/** The answer: the live floor, the stage the customer reads, the stage set by hand while it stands, the row's version. */
async function viewOf(db: Reader, orderId: string, floor: BrandStage | null) {
  const row = (await readHand(db, orderId))!
  const setBy = row.stageSetById ? await db.user.findUnique({ where: { id: row.stageSetById }, select: { id: true, displayName: true } }) : null
  return {
    orderId,
    floor,
    stage: row.stage,
    byHand:
      row.stageSet !== null && row.stageSetReason !== null && row.stageSetAt !== null
        ? { stage: row.stageSet, reasonCode: row.stageSetReason, note: row.stageSetNote, setAt: toUtcIso(row.stageSetAt), setBy: setBy ? { id: setBy.id, name: setBy.displayName } : null }
        : null,
    version: row.version,
  }
}

export interface StageSetBody {
  /** B-SC-004: any of the five stages (the one the customer reads already, or the floor's while a hand stage stands: 409). */
  readonly stage: BrandStage
  readonly reasonCode: StageSetReasonCode
  /** The office's own words: one line of at most 200 characters (required for OTHER); never the customer's to read. */
  readonly note?: string | null | undefined
  /** The production state's version as read; null only while the order has none yet. */
  readonly version: number | null
}

/** PUT /production/brand-orders/:orderId/stage (production.brand.manage): the stage set by hand, or a Change of the one standing. */
export async function setBrandStage(caller: CommandCaller, orderId: string, body: StageSetBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  // R11: the wall before anything about the order's state.
  await officeOrder(caller, orderId, PRODUCTION_BRAND_MANAGE)
  const note = body.note?.trim() || null
  // What is asked first (400); the order's state under the lock (409).
  const asked = stageSetAskProblems({ stage: body.stage, reasonCode: body.reasonCode, note })
  if (asked.length > 0) throw new ValidationError(asked.length === 1 ? asked[0]!.message : 'This stage set by hand is not valid.', asked)
  const stage = body.stage as HandStage
  const reasonCode = body.reasonCode
  const { result } = await command(caller, { name: SET_BRAND_STAGE, idempotencyKey, input: { orderId, stage, reasonCode, note, version: body.version } }, async (tools) => {
    await lockOrder(tools, orderId)
    checkVersion(await readHand(tools.tx, orderId), orderId, body.version)
    // R12, R1: the keeper's own pass first, under the same lock — the live floor; with no row yet it is made (Preparing, its marker).
    const kept = await keepInCommand(tools, orderId, { what: SET_BRAND_STAGE, health: false })
    if (!kept.facts) throw new NotFoundError('Sales order not found.')
    const { facts } = kept
    const floor = facts.stage?.stage ?? null
    const row = await readHand(tools.tx, orderId)
    const paused = facts.blockers.some((blocker) => blocker.kind === 'BRAND_PAUSE')
    // B-SC-004: `shown` — the stage the customer reads after the keeper's pass (a Set must move it; a Change at the same stage must
    // change its reason or note).
    const refused = stageSetStateProblems({ status: facts.order.status as SalesOrderStatus, floor, shown: row?.stage ?? null, hand: row?.stageSet ?? null, handReason: row?.stageSetReason ?? null, handNote: row?.stageSetNote ?? null, paused, stage, reasonCode, note })
    if (refused.length > 0) throw new InvalidStateError(refused[0]!.message)
    // A kept order with a goods line open has its row now (the keeper's pass made it).
    if (!row) throw new InvalidStateError(STAGE_SET_REFUSAL_WORDS.NOTHING_LEFT.en)

    const changed = row.stageSet !== null
    // B-SC-004: a Change of the office's words only (the same stage) keeps the floor at the set, so the end rule stays as it was.
    const floorAtSet = changed && row.stageSet === stage ? ((await readHandFloor(tools.tx, row.id)) ?? floor) : floor
    await tools.tx.brandOrderProduction.update({
      where: { id: row.id },
      data: {
        stage,
        ...(row.stage !== stage ? { stageAt: tools.now } : {}),
        stageSet: stage,
        stageSetReason: reasonCode,
        stageSetNote: note,
        stageSetAt: tools.now,
        stageSetById: context.actorId,
        updatedAt: tools.now,
        version: { increment: 1 },
      },
      select: { id: true },
    })
    const reason = `${changed ? 'The stage set by hand changed' : 'Stage set by hand'}: ${stage} (${reasonCode}).`
    // On the row: before it the floor's stage and day while no hand stage stood (floorDayOf reads them back on a step back, R15).
    tools.audit({
      recordType: 'BrandOrderProduction',
      recordId: row.id,
      companyId: facts.order.companyId,
      before: { stage: row.stage, stageAt: toUtcIso(row.stageAt), hand: row.stageSet },
      after: { salesOrderId: orderId, stage, hand: stage, floor, floorAtSet /* B-SC-004: the keeper's readHandFloor */, reasonCode, note },
      reason,
    })
    // R6: the order's own History — from → to as `stage`, the note in `after`; never a `status` key.
    tools.audit({ recordType: 'SalesOrder', recordId: orderId, companyId: facts.order.companyId, before: { stage: row.stage }, after: { stage, floor, reasonCode, note }, reason })
    // B-MS-008: a Change inside the window — the stage it replaces, whose notice still waits, is left untold (the keeper's pass
    // above already left untold what it moved off).
    if (row.stage !== stage) await untellWaiting(tools, facts.order, row.id, stage, kept.untold)
    // A forward move of what the customer reads: told once, from the stage before the set (Preparing for a row just made, R1),
    // B-MS-008: by hand — its notice waits the undo window. B-SC-004: a move back is told once as a correction when the stage it
    // leaves was told (inside its window it was just left untold: nothing to correct).
    const move = handMoveOf(row.stage, stage)
    if (move === 'FORWARD') await tellStageOnce(tools, facts.order, row, stage, row.stage, true)
    else if (move === 'BACK') await tellCorrection(tools, facts.order, row, stage, row.stage)
    return viewOf(tools.tx, orderId, floor)
  })
  return result
}

/**
 * DELETE /production/brand-orders/:orderId/stage?version= (production.brand.manage): back to the floor's stage. B-SC-004: a Clear
 * that lowers what the customer reads is a move back (told as a correction when the stage it leaves was told); one that raises it
 * (a set back cleared) gets the usual forward notice, by hand (the keeper's pass).
 */
export async function clearBrandStage(caller: CommandCaller, orderId: string, version: number, idempotencyKey?: string) {
  // R11: the wall before anything about the order's state.
  await officeOrder(caller, orderId, PRODUCTION_BRAND_MANAGE)
  const { result } = await command(caller, { name: CLEAR_BRAND_STAGE, idempotencyKey, input: { orderId, version } }, async (tools) => {
    await lockOrder(tools, orderId)
    const before = await readHand(tools.tx, orderId)
    checkVersion(before, orderId, version)
    if (before === null || before.stageSet === null) throw new InvalidStateError(NO_HAND_STAGE_WORDS.en)
    // R12, R15: the keeper's own pass with the hand stage cleared, in this command — the five columns cleared and `stage` back to the
    // live floor's (no goods line: where the work reached) in one write, on the floor's own day. B-MS-008: inside the window the
    // stage cleared is left untold in that same pass (./keeper untellWaiting). B-SC-004: a forward move it makes is told there, by
    // hand; a step back is told below as a correction.
    const kept = await keepInCommand(tools, orderId, { what: CLEAR_BRAND_STAGE, health: false, clearHand: true })
    if (!kept.facts) throw new NotFoundError('Sales order not found.')
    const { facts } = kept
    const floor = facts.stage?.stage ?? null
    const after = (await readHand(tools.tx, orderId))!
    // B-SC-004: the Clear lowered what the customer reads — a correction when the stage it leaves was told (only while the order is
    // kept with a goods line open: one that left production, or has nothing left to make, reads no stage any more).
    if (facts.kept && floor !== null && handMoveOf(before.stage, after.stage) === 'BACK') await tellCorrection(tools, facts.order, before, after.stage, before.stage)
    const reason = `The stage set by hand was cleared: ${before.stageSet} (${before.stageSetReason ?? 'no reason'}).`
    tools.audit({
      recordType: 'BrandOrderProduction',
      recordId: before.id,
      companyId: facts.order.companyId,
      before: { stage: before.stage, stageAt: toUtcIso(before.stageAt), hand: before.stageSet, reasonCode: before.stageSetReason, note: before.stageSetNote },
      after: { salesOrderId: orderId, stage: after.stage, hand: null, floor },
      reason,
    })
    // R6: the order's own History; never a `status` key.
    tools.audit({ recordType: 'SalesOrder', recordId: orderId, companyId: facts.order.companyId, before: { stage: before.stage }, after: { stage: after.stage, floor }, reason })
    return viewOf(tools.tx, orderId, floor)
  })
  return result
}
