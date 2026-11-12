import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import type { LotLifecycle } from '@nexus/factory-domain/inventory/lots-depth/lifecycle'
import { INVENTORY_LOTS_MANAGE } from '@nexus/factory-domain/inventory/lots-depth/permissions'
import {
  childLotCodes,
  familyRefusal,
  hideMoveRefusal,
  proposalFromInspection,
  REGROUP_REASON_CODE,
  SPLIT_REASON_CODE,
  splitDraftProblems,
  type SplitDraft,
  type SplitKind,
} from '@nexus/factory-domain/inventory/lots-depth/split'
import type { Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { allocateScanIds } from '../../../platform/numbering/scan-ids'
import { postMoves, MAX_MOVES_PER_POST, type MoveDraft, type PostedMove } from '../ledger/post-moves'
import { fixed, locatedBy, mainPlace, type Located } from '../stock/read-kit'
import { syncLifecycleInCommand } from './lifecycle'
import { familyOf, lotFor, LOT_SELECT, type LotData } from './store'

/**
 * Split a lot into shade groups and regroup them (B-W2b-313; SCM-237; design warehouse.lots lt-split "hides listed with
 * shade; drag or pick a group per hide; each group becomes a child lot that keeps the parent link"; follow-up LT1:01: the
 * hide-by-hide incoming inspection names the groups). Office, inventory.lots.manage on the lot's company and site.
 *
 *   GET  /inventory/lots/:lotId/split     the dialog: the family (the lot that is no child, with the version a split or
 *                                         regroup sends, and its child lots), every hide of the family with its shade, grade,
 *                                         marks, place and what its incoming inspection said, why one cannot move, the shade
 *                                         groups to pick, and the groups the newest incoming inspection sorted the hides into
 *   POST /inventory/lots/:lotId/split     {version, groups: [{shadeGroupId? | label?, hideIds}], inspectionId?, note?}: each
 *                                         group becomes a NEW child lot of the family's parent (code <parent>-A, -B …)
 *   POST /inventory/lots/:lotId/regroup   {version, moves: [{hideId, toLotId}], note?}: hides into lots of the family that
 *                                         exist (a child, or back to the parent)
 *
 * Both are ONE command on the family's parent (its version is the family's edit guard, its bump the family's lock). A hide's
 * lot is part of the ledger's key and never changes (factory-domain inventory/lots-depth split.ts), so each hide that moves
 * becomes a new hide row in its new lot: a new HIDE tag (the answer lists it for printing), the same tannery number, area,
 * grade, thickness and defects, the target's shade, its marks still in force copied (the inspection's own stay on the old
 * row, which names it); its stock leaves the old row and enters the new one at the same place by two ADJUSTMENT moves
 * (postMoves: reason code LOT_SPLIT or LOT_REGROUP; the entry valued at the cost the exit took, so the family's value does
 * not change). A new child lot is a copy of the lot its hides come from: supplier, batch, receipt line (so the trace goes
 * back to the supplier), quality status and decision, Cr VI result, attributes, and its receiver (Lot.createdById: the
 * lab's four-eyes rule reads it); the person who split is in the audit rows. Hides of lots of two quality states never go
 * into one lot, and a hide in quarantine never goes into a released lot. The lifecycles of every lot touched follow at once
 * (lifecycle.ts). Audit: the parent's `inventory.splitLot` | `inventory.regroupLot` (what went where), each new lot's
 * `inventory.lotMadeBySplit`, each hide's `inventory.hideRelotted` on its old and new row (the link from the old tag to the
 * new one); events `lot.split`, `inventory.moved` per move, `lot.lifecycle_changed`.
 */

const HIDE_SELECT = {
  id: true,
  code: true,
  supplierCode: true,
  siteId: true,
  lotId: true,
  itemId: true,
  area: true,
  areaUom: true,
  baseArea: true,
  grade: true,
  gradeId: true,
  shade: true,
  shadeGroupId: true,
  thicknessMm: true,
  defects: true,
  state: true,
  createdAt: true,
} as const satisfies Prisma.HideSelect
type HideRow = Prisma.HideGetPayload<{ select: typeof HIDE_SELECT }>

const SHADE_SELECT = { id: true, itemId: true, itemColourId: true, lotId: true, label: true, outOfShade: true, active: true, sortOrder: true } as const satisfies Prisma.ShadeGroupSelect
type ShadeRow = Prisma.ShadeGroupGetPayload<{ select: typeof SHADE_SELECT }>

/** What the split reads (the command's transaction, or the caller's client for the dialog). */
type Db = Pick<CommandTx, 'lot' | 'hide' | 'stockMove' | 'reservation' | 'qualityHold' | 'incomingInspection' | 'stockCountLine' | 'warehouseTask' | 'transferLine' | 'supplierClaimLine' | 'subcontractKitLine' | 'hideMark' | 'shadeGroup'>

const OPEN_COUNTS = ['DRAFT', 'COUNTING', 'SUBMITTED', 'APPROVED'] as const
const OPEN_TRANSFERS = ['DRAFT', 'SHIPPED', 'PARTLY_RECEIVED'] as const
const OPEN_CLAIMS = ['DRAFT', 'SENT', 'ACCEPTED'] as const

interface Family {
  readonly parent: LotData
  readonly lots: readonly LotData[]
  readonly byId: ReadonlyMap<string, LotData>
  readonly hides: readonly HideRow[]
  readonly located: ReadonlyMap<string, Located>
  /** Why each hide cannot move now (null: it can). */
  readonly refusals: ReadonlyMap<string, string | null>
  readonly marks: ReadonlyMap<string, number>
}

/** The family of a lot with its hides, their stock and what still names them. */
async function readFamily(db: Db, lot: Pick<LotData, 'id' | 'parentLotId'>): Promise<Family> {
  const { parent, children } = await familyOf(db, lot)
  const lots = [parent, ...children]
  const lotIds = lots.map((row) => row.id)
  const hides = await db.hide.findMany({ where: { lotId: { in: lotIds } }, select: HIDE_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const hideIds = hides.map((hide) => hide.id)
  const none = { in: [] as string[] }
  const ids = hideIds.length > 0 ? { in: hideIds } : none
  // One query after another: inside the command's transaction they share one connection.
  const located = hideIds.length > 0 ? await locatedBy(db, 'hideId', { hideId: ids }) : new Map<string, Located>()
  const reservations = await db.reservation.findMany({ where: { hideId: ids, status: 'ACTIVE' }, select: { hideId: true } })
  const holds = await db.qualityHold.findMany({
    where: { status: 'ACTIVE', OR: [{ subjectType: 'Hide', subjectIds: { hasSome: hideIds } }, { subjectType: 'Lot', subjectIds: { hasSome: lotIds } }] },
    select: { subjectType: true, subjectIds: true },
  })
  const openInspections = await db.incomingInspection.findMany({ where: { lotId: { in: lotIds }, status: 'OPEN' }, select: { lotId: true, number: true } })
  const countLines = await db.stockCountLine.findMany({ where: { hideId: ids, count: { status: { in: [...OPEN_COUNTS] } } }, select: { hideId: true, count: { select: { number: true } } } })
  const tasks = await db.warehouseTask.findMany({ where: { hideId: ids, status: { in: ['OPEN', 'TAKEN'] } }, select: { hideId: true } })
  const transferLines = await db.transferLine.findMany({ where: { hideId: ids, transfer: { status: { in: [...OPEN_TRANSFERS] } } }, select: { hideId: true } })
  const claimLines = await db.supplierClaimLine.findMany({ where: { hideId: ids, claim: { status: { in: [...OPEN_CLAIMS] } } }, select: { hideId: true } })
  const kitLines = await db.subcontractKitLine.findMany({ where: { hideId: ids, status: 'PLANNED' }, select: { hideId: true } })
  const marks = await db.hideMark.groupBy({ by: ['hideId'], where: { hideId: ids, voidedAt: null }, _count: { _all: true } })
  const set = (rows: readonly { hideId: string | null }[]) => new Set(rows.map((row) => row.hideId).filter((value): value is string => value !== null))
  const reserved = set(reservations)
  const tasked = set(tasks)
  const travelling = set(transferLines)
  const claimed = set(claimLines)
  const kitted = set(kitLines)
  const heldHides = new Set(holds.filter((hold) => hold.subjectType === 'Hide').flatMap((hold) => hold.subjectIds))
  const heldLots = new Set(holds.filter((hold) => hold.subjectType === 'Lot').flatMap((hold) => hold.subjectIds))
  const inspectionOf = new Map(openInspections.map((row) => [row.lotId, row.number]))
  const countOf = new Map(countLines.map((row) => [row.hideId, row.count.number]))
  const refusals = new Map<string, string | null>()
  for (const hide of hides) {
    refusals.set(
      hide.id,
      hideMoveRefusal({
        code: hide.code,
        state: hide.state,
        onHand: fixed(located.get(hide.id)?.onHand),
        reserved: reserved.has(hide.id),
        held: heldHides.has(hide.id) || heldLots.has(hide.lotId),
        openInspection: inspectionOf.get(hide.lotId) ?? null,
        openCount: countOf.get(hide.id) ?? null,
        openTask: tasked.has(hide.id),
        openTransfer: travelling.has(hide.id),
        openClaim: claimed.has(hide.id),
        plannedKit: kitted.has(hide.id),
      }),
    )
  }
  return { parent, lots, byId: new Map(lots.map((row) => [row.id, row])), hides, located, refusals, marks: new Map(marks.map((row) => [row.hideId, row._count._all])) }
}

/** The shade groups a hide of the family may take: the article's (any colour or the lot's) and the family's own. */
async function shadeChoices(db: Db, family: Family): Promise<ShadeRow[]> {
  const { parent } = family
  const rows = await db.shadeGroup.findMany({
    where: { itemId: parent.itemId, OR: [{ itemColourId: null }, { itemColourId: parent.itemColourId }], AND: [{ OR: [{ lotId: null }, { lotId: { in: family.lots.map((lot) => lot.id) } }] }] },
    select: SHADE_SELECT,
  })
  return rows.sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
}

const lotRefOf = (lot: LotData) => ({ id: lot.id, code: lot.code, qualityStatus: lot.qualityStatus, lifecycle: lot.lifecycle as LotLifecycle, shade: lot.shade })

/** GET /inventory/lots/:lotId/split. */
export async function readSplit(caller: CommandCaller, lotId: string) {
  const { lot, context } = await lotFor(caller, lotId)
  return caller.withClient(async (client) => {
    const db: Db = client
    const family = await readFamily(db, lot)
    const shades = await shadeChoices(db, family)
    const locations = await client.location.findMany({ where: { id: { in: [...new Set(family.hides.map((hide) => mainPlace(family.located.get(hide.id))).filter((value): value is string => value !== null))] } }, select: { id: true, code: true, name: true } })
    const placeOf = new Map(locations.map((place) => [place.id, place]))
    // The newest incoming inspection of the family that sampled hides (open or decided), and what it said of each.
    const inspection = await client.incomingInspection.findFirst({
      where: { lotId: { in: family.lots.map((row) => row.id) }, status: { in: ['OPEN', 'DECIDED'] }, hideResults: { some: {} } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, number: true, status: true },
    })
    const results = inspection
      ? await client.incomingHideResult.findMany({ where: { incomingInspectionId: inspection.id }, select: { hideId: true, shadeGroup: true, shadeRecordId: true, decision: true }, orderBy: [{ seq: 'asc' }] })
      : []
    const resultOf = new Map(results.map((row) => [row.hideId, row]))
    const inStock = new Set(family.hides.filter((hide) => family.located.get(hide.id)?.onHand.greaterThan(0)).map((hide) => hide.id))
    const hidesInStock = new Map<string, number>()
    for (const hide of family.hides) if (inStock.has(hide.id)) hidesInStock.set(hide.lotId, (hidesInStock.get(hide.lotId) ?? 0) + 1)
    const refusal = familyRefusal({ code: family.parent.code, qualityStatus: family.parent.qualityStatus, tracking: family.parent.item.tracking })
    return {
      parent: { ...lotRefOf(family.parent), version: family.parent.version },
      lots: family.lots.map((row) => ({ ...lotRefOf(row), hidesInStock: hidesInStock.get(row.id) ?? 0 })),
      hides: family.hides
        .filter((hide) => inStock.has(hide.id))
        .map((hide) => {
          const result = resultOf.get(hide.id)
          const place = mainPlace(family.located.get(hide.id))
          return {
            id: hide.id,
            code: hide.code,
            supplierCode: hide.supplierCode,
            lot: { id: hide.lotId, code: family.byId.get(hide.lotId)!.code },
            state: hide.state,
            onHand: fixed(family.located.get(hide.id)?.onHand),
            area: hide.area.toFixed(4),
            areaUom: hide.areaUom,
            location: place ? (placeOf.get(place) ?? null) : null,
            grade: hide.grade,
            shade: hide.shade,
            shadeGroupId: hide.shadeGroupId,
            marks: family.marks.get(hide.id) ?? 0,
            inspection: result && inspection ? { number: inspection.number, decision: result.decision, shadeGroupId: result.shadeRecordId, shade: result.shadeGroup } : null,
            refusal: family.refusals.get(hide.id) ?? null,
          }
        }),
      shadeGroups: shades.map((row) => ({ id: row.id, label: row.label, outOfShade: row.outOfShade, lotId: row.lotId, active: row.active })),
      proposal: {
        inspection,
        groups: proposalFromInspection(results.filter((row) => inStock.has(row.hideId)).map((row) => ({ hideId: row.hideId, shadeGroupId: row.shadeRecordId, shadeLabel: row.shadeGroup, decision: row.decision }))),
      },
      refusal,
      may: refusal === null && can(actorOf(context), INVENTORY_LOTS_MANAGE, { companyId: lot.companyId, siteId: lot.siteId }),
    }
  })
}

// ---- the move of hides into other lots of the family -------------------------------------------------------------------

/** Where one hide goes: its lot, and the shade it takes there. */
interface Assignment {
  readonly hide: HideRow
  readonly to: LotData
  readonly shadeGroupId: string | null
  readonly shade: string | null
}

const refuse = (problems: Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems)
}

/** A hide of the family that may move now, or the refusal at `path`. */
function movable(family: Family, hideId: string, path: string, problems: Issue[]): HideRow | null {
  const hide = family.hides.find((row) => row.id === hideId)
  if (!hide) {
    problems.push({ path, message: `Not a hide of lot ${family.parent.code} or of a lot split from it.` })
    return null
  }
  const source = family.byId.get(hide.lotId)!
  // The hide's own lot first (a blocked or rejected lot keeps its hides), then what still names the hide.
  const problem = familyRefusal({ code: source.code, qualityStatus: source.qualityStatus, tracking: family.parent.item.tracking }) ?? family.refusals.get(hide.id) ?? null
  if (problem) {
    problems.push({ path, message: problem })
    return null
  }
  return hide
}

/** The same quality and Cr VI state: a hide in quarantine never goes into a released lot (nor the reverse). */
const sameQuality = (a: LotData, b: LotData) => a.qualityStatus === b.qualityStatus && a.crViStatus === b.crViStatus

/** Moves the hides: new hide rows, their marks, the two ADJUSTMENT moves per place, the lifecycles, the audit rows. */
async function moveHides(tools: CommandTools, family: Family, assignments: readonly Assignment[], kind: SplitKind, note: string | null) {
  const { tx, now, context } = tools
  const actorId = context.audience === 'office' ? context.actorId : null
  const { codes } = await allocateScanIds(tools, 'HIDE', assignments.length)
  const reasonCode = kind === 'SPLIT' ? SPLIT_REASON_CODE : REGROUP_REASON_CODE
  const made: { assignment: Assignment; id: string; code: string; marks: number }[] = []
  // Marks still in force, of a defect and a grade still in use (a retired one stays on the old row).
  const marks = await tx.hideMark.findMany({
    where: { hideId: { in: assignments.map((entry) => entry.hide.id) }, voidedAt: null },
    select: { hideId: true, kind: true, x: true, y: true, outline: true, defectCodeId: true, zoneGradeId: true, photoFileId: true, note: true, defectCode: { select: { active: true, parentId: true } }, zoneGrade: { select: { active: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  for (const [index, assignment] of assignments.entries()) {
    const { hide, to } = assignment
    const id = newId()
    const code = codes[index]!
    await tx.hide.create({
      data: {
        id,
        siteId: hide.siteId,
        lotId: to.id,
        itemId: hide.itemId,
        code,
        supplierCode: hide.supplierCode,
        area: hide.area,
        areaUom: hide.areaUom,
        baseArea: hide.baseArea,
        grade: hide.grade,
        gradeId: hide.gradeId,
        shade: assignment.shade,
        shadeGroupId: assignment.shadeGroupId,
        thicknessMm: hide.thicknessMm,
        defects: hide.defects,
        state: 'FULL',
        createdAt: now,
        updatedAt: now,
        createdById: actorId,
      },
      select: { id: true },
    })
    const copied = marks.filter((mark) => mark.hideId === hide.id && (mark.defectCode === null || (mark.defectCode.active && mark.defectCode.parentId !== null)) && (mark.zoneGrade === null || mark.zoneGrade.active))
    if (copied.length > 0) {
      await tx.hideMark.createMany({
        data: copied.map((mark) => ({
          id: newId(),
          siteId: hide.siteId,
          lotId: to.id,
          hideId: id,
          kind: mark.kind,
          x: mark.x,
          y: mark.y,
          outline: mark.outline as Prisma.InputJsonValue,
          defectCodeId: mark.defectCodeId,
          zoneGradeId: mark.zoneGradeId,
          photoFileId: mark.photoFileId,
          incomingInspectionId: null,
          note: mark.note,
          createdAt: now,
          updatedAt: now,
          createdById: actorId,
        })),
      })
    }
    made.push({ assignment, id, code, marks: copied.length })
  }

  // The stock: out of the old row at each place it lies, then into the new row at the same place, valued as it left.
  const outs: MoveDraft[] = []
  const ins: { readonly draft: Omit<MoveDraft, 'cost'>; readonly outIndex: number }[] = []
  for (const entry of made) {
    const { hide, to } = entry.assignment
    const from = family.byId.get(hide.lotId)!
    for (const [locationId, quantity] of family.located.get(hide.id)?.at ?? new Map<string, Decimal>()) {
      if (!quantity.greaterThan(0)) continue
      const words = `${kind === 'SPLIT' ? 'Split' : 'Regrouped'}: hide ${hide.code} of lot ${from.code} is hide ${entry.code} of lot ${to.code}.`
      const common = { siteId: hide.siteId, reason: 'ADJUSTMENT' as const, itemId: hide.itemId, quantity: fixed(quantity), reasonCode, reference: family.parent.code, note: note ? `${words} ${note}` : words }
      ins.push({ draft: { ...common, lotId: to.id, hideId: entry.id, toLocationId: locationId }, outIndex: outs.length })
      outs.push({ ...common, lotId: from.id, hideId: hide.id, fromLocationId: locationId })
    }
  }
  // Each move keeps its own key (`move:<id>`): the command's Idempotency-Key already answers a repeated request.
  const posted: PostedMove[] = []
  for (let start = 0; start < outs.length; start += MAX_MOVES_PER_POST) posted.push(...(await postMoves(tools, outs.slice(start, start + MAX_MOVES_PER_POST))))
  const valuations = new Map(
    (await tx.stockValuation.findMany({ where: { moveId: { in: posted.map((move) => move.id) } }, select: { moveId: true, unitCost: true } })).map((row) => [row.moveId, row.unitCost.toString()]),
  )
  const inDrafts: MoveDraft[] = ins.map(({ draft, outIndex }) => {
    const unitCost = valuations.get(posted[outIndex]!.id)
    return { ...draft, cost: unitCost === undefined ? null : { method: 'LOT_COST', unitCost } }
  })
  for (let start = 0; start < inDrafts.length; start += MAX_MOVES_PER_POST) posted.push(...(await postMoves(tools, inDrafts.slice(start, start + MAX_MOVES_PER_POST))))

  // The link from each old tag to its new one, on both rows.
  for (const entry of made) {
    const { hide, to } = entry.assignment
    const link = { before: { hideId: hide.id, code: hide.code, lotId: hide.lotId }, after: { hideId: entry.id, code: entry.code, lotId: to.id, shade: entry.assignment.shade, marks: entry.marks } }
    tools.audit({ action: 'inventory.hideRelotted', recordType: 'Hide', recordId: hide.id, companyId: to.companyId, siteId: to.siteId, ...link })
    tools.audit({ action: 'inventory.hideRelotted', recordType: 'Hide', recordId: entry.id, companyId: to.companyId, siteId: to.siteId, ...link })
  }
  // Every lot touched follows its ledger (a lot whose last hide left is DEPLETED; a new one RELEASED or QUARANTINE).
  const touched = [...new Set([...assignments.map((entry) => entry.hide.lotId), ...assignments.map((entry) => entry.to.id)])]
  for (const lotId of touched) await syncLifecycleInCommand(tools, lotId)
  return { made, moveIds: posted.map((move) => move.id), touched }
}

async function answerOf(tools: CommandTools, parentId: string, newLotIds: ReadonlySet<string>, made: Awaited<ReturnType<typeof moveHides>>['made']) {
  const { tx } = tools
  const lots = await tx.lot.findMany({ where: { OR: [{ id: parentId }, { parentLotId: parentId }] }, select: LOT_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const parent = lots.find((row) => row.id === parentId)!
  return {
    parent: { id: parent.id, code: parent.code, version: tools.record!.version },
    lots: lots.map((row) => ({ ...lotRefOf(row), made: newLotIds.has(row.id) })),
    hides: made.map((entry) => ({
      fromHideId: entry.assignment.hide.id,
      fromCode: entry.assignment.hide.code,
      hideId: entry.id,
      code: entry.code,
      lot: { id: entry.assignment.to.id, code: entry.assignment.to.code },
      area: entry.assignment.hide.area.toFixed(4),
      areaUom: entry.assignment.hide.areaUom,
      grade: entry.assignment.hide.grade,
      shade: entry.assignment.shade,
      marks: entry.marks,
    })),
  }
}

export interface SplitBody extends SplitDraft {
  readonly version: number
  readonly inspectionId?: string | null | undefined
}

/** POST /inventory/lots/:lotId/split. */
export async function splitLot(caller: CommandCaller, lotId: string, body: SplitBody, idempotencyKey?: string) {
  const { lot } = await lotFor(caller, lotId, INVENTORY_LOTS_MANAGE)
  const draftProblems = splitDraftProblems(body)
  if (draftProblems.length > 0) refuse(draftProblems.map((problem) => ({ ...problem, path: `body/${problem.path}` })), 'The split is not valid.')
  const parentId = lot.parentLotId ?? lot.id
  const { result } = await command(caller, { name: 'inventory.splitLot', idempotencyKey, input: { lotId, ...body }, record: { type: 'Lot', id: parentId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const family = await readFamily(tx, { id: parentId, parentLotId: null })
    // Only a lot of hides is split; the quality of each lot a hide comes from is checked per hide (movable).
    if (family.parent.item.tracking !== 'HIDE') throw new InvalidStateError(familyRefusal({ code: family.parent.code, qualityStatus: 'RELEASED', tracking: family.parent.item.tracking })!)
    if (body.inspectionId) {
      const inspection = await tx.incomingInspection.findUnique({ where: { id: body.inspectionId }, select: { lotId: true } })
      if (!inspection || !inspection.lotId || !family.byId.has(inspection.lotId)) throw new ValidationError('Not an incoming inspection of this lot or of a lot split from it.', [{ path: 'body/inspectionId', message: 'Not an incoming inspection of this family.' }])
    }
    const shades = new Map((await shadeChoices(tx, family)).map((row) => [row.id, row]))
    const problems: Issue[] = []
    // Each group: its hides (movable, of one quality state), its shade (an article's group, the family's own, or words).
    const groups = body.groups.map((group, index) => {
      const at = `body/groups/${index}`
      const hides = group.hideIds.map((hideId, position) => movable(family, hideId, `${at}/hideIds/${position}`, problems)).filter((hide): hide is HideRow => hide !== null)
      const sources = [...new Set(hides.map((hide) => hide.lotId))].map((id) => family.byId.get(id)!)
      if (sources.length > 1 && sources.some((source) => !sameQuality(source, sources[0]!))) {
        problems.push({ path: `${at}/hideIds`, message: `These hides come from lots of different quality states (${sources.map((source) => `${source.code} ${source.qualityStatus.toLowerCase()}`).join(', ')}): one lot holds hides of one state.` })
      }
      let shade: ShadeRow | null = null
      if (group.shadeGroupId) {
        shade = shades.get(group.shadeGroupId) ?? null
        if (!shade) problems.push({ path: `${at}/shadeGroupId`, message: `Not a shade group of ${family.parent.item.code} in this colour.` })
        else if (!shade.active) problems.push({ path: `${at}/shadeGroupId`, message: `Shade group ${shade.label} is retired.` })
      }
      const label = (shade?.label ?? group.label?.trim() ?? '').trim()
      // Words that name an article's group take that group.
      if (!shade && label !== '') shade = [...shades.values()].find((row) => row.lotId === null && row.active && row.label.toLowerCase() === label.toLowerCase()) ?? null
      return { hides, source: sources[0] ?? null, shade, label }
    })
    if (problems.length > 0) refuse(problems, 'The split is not valid.')
    const taken = (await tx.lot.findMany({ where: { code: { startsWith: `${family.parent.code}-` } }, select: { code: true } })).map((row) => row.code)
    const codes = childLotCodes(family.parent.code, taken, groups.length)
    const newLots: LotData[] = []
    for (const [index, group] of groups.entries()) {
      const source = group.source!
      const id = newId()
      // B-W2b-328 (SCM-186): a child takes its source lot's variant (the database refuses a lot of a variant's PO line
      // without it), and a new lot names only an ACTIVE variant: an archived one is restored first.
      if (source.variantCode) {
        const variant = await tx.itemVariant.findFirst({ where: { itemId: source.itemId, code: source.variantCode }, select: { status: true } })
        if (variant && variant.status !== 'ACTIVE') throw new InvalidStateError(`Lot ${source.code} is of variant ${source.variantCode}, which is archived: restore the variant (the material's variants) before splitting its hides into new lots.`)
      }
      await tx.lot.create({
        data: {
          id,
          companyId: source.companyId,
          siteId: source.siteId,
          itemId: source.itemId,
          itemColourId: source.itemColourId,
          code: codes[index]!,
          supplierId: source.supplierId,
          supplierLotRef: source.supplierLotRef,
          dyeBatch: source.dyeBatch,
          shade: group.label,
          receiptLineId: source.receiptLineId,
          // B-W2b-328: the source lot's variant.
          variantCode: source.variantCode,
          receivedAt: source.receivedAt,
          qualityStatus: source.qualityStatus === 'RELEASED' ? 'RELEASED' : 'QUARANTINE',
          qualityNote: source.qualityNote,
          qualityDecidedAt: source.qualityStatus === 'RELEASED' ? source.qualityDecidedAt : null,
          qualityDecidedById: source.qualityStatus === 'RELEASED' ? source.qualityDecidedById : null,
          requiresCrViTest: source.requiresCrViTest,
          crViLimitMgKg: source.crViLimitMgKg,
          crViStatus: source.crViStatus,
          crViMgKg: source.crViMgKg,
          crViEvidence: source.crViEvidence,
          crViTestedAt: source.crViTestedAt,
          parentLotId: family.parent.id,
          attributes: (source.attributes ?? {}) as Prisma.InputJsonValue,
          createdAt: now,
          updatedAt: now,
          // The receiver of the goods, not the person who split them: the lab's four-eyes rule on release reads it.
          createdById: source.createdById,
        },
        select: { id: true },
      })
      const made = (await tx.lot.findUnique({ where: { id }, select: LOT_SELECT }))!
      newLots.push(made)
      tools.audit({
        action: 'inventory.lotMadeBySplit',
        recordType: 'Lot',
        recordId: id,
        companyId: made.companyId,
        siteId: made.siteId,
        after: { parentLotId: family.parent.id, code: made.code, shade: group.label, shadeGroupId: group.shade?.id ?? null, qualityStatus: made.qualityStatus, hides: group.hides.length, fromLotIds: [...new Set(group.hides.map((hide) => hide.lotId))], inspectionId: body.inspectionId ?? null, splitById: tools.context.audience === 'office' ? tools.context.actorId : null },
      })
    }
    const assignments: Assignment[] = groups.flatMap((group, index) =>
      group.hides.map((hide) => {
        // An article's group travels with the hide; a lot's own group stays with its lot, its label becomes the hide's words.
        const articleGroup = group.shade && group.shade.lotId === null ? group.shade : null
        return { hide, to: newLots[index]!, shadeGroupId: articleGroup?.id ?? null, shade: group.label }
      }),
    )
    const note = body.note?.trim() || null
    const { made, moveIds } = await moveHides(tools, family, assignments, 'SPLIT', note)
    tools.audit({
      recordType: 'Lot',
      recordId: family.parent.id,
      companyId: family.parent.companyId,
      siteId: family.parent.siteId,
      after: {
        lots: newLots.map((row, index) => ({ lotId: row.id, code: row.code, shade: groups[index]!.label, hides: groups[index]!.hides.length })),
        hides: made.map((entry) => ({ from: entry.assignment.hide.id, fromCode: entry.assignment.hide.code, to: entry.id, code: entry.code, lotId: entry.assignment.to.id })),
        inspectionId: body.inspectionId ?? null,
        note,
      },
      ...(note ? { reason: note } : {}),
    })
    tools.emit({
      type: 'lot.split',
      subject: family.parent.id,
      companyId: family.parent.companyId,
      siteId: family.parent.siteId,
      payload: { kind: 'SPLIT', parentLotId: family.parent.id, fromLotIds: [...new Set(assignments.map((entry) => entry.hide.lotId))], toLotIds: newLots.map((row) => row.id), newLotIds: newLots.map((row) => row.id), hides: made.length, moveIds },
    })
    return answerOf(tools, family.parent.id, new Set(newLots.map((row) => row.id)), made)
  })
  return result
}

export interface RegroupBody {
  readonly version: number
  readonly moves: readonly { readonly hideId: string; readonly toLotId: string }[]
  readonly note?: string | null | undefined
}

/** POST /inventory/lots/:lotId/regroup. */
export async function regroupLot(caller: CommandCaller, lotId: string, body: RegroupBody, idempotencyKey?: string) {
  const { lot } = await lotFor(caller, lotId, INVENTORY_LOTS_MANAGE)
  const seen = new Set<string>()
  const draftProblems: Issue[] = []
  body.moves.forEach((move, index) => {
    if (seen.has(move.hideId)) draftProblems.push({ path: `body/moves/${index}/hideId`, message: 'This hide is named twice: a hide goes to one lot.' })
    seen.add(move.hideId)
  })
  if ((body.note?.length ?? 0) > 500) draftProblems.push({ path: 'body/note', message: 'At most 500 characters.' })
  if (draftProblems.length > 0) refuse(draftProblems, 'The regroup is not valid.')
  const parentId = lot.parentLotId ?? lot.id
  const { result } = await command(caller, { name: 'inventory.regroupLot', idempotencyKey, input: { lotId, ...body }, record: { type: 'Lot', id: parentId, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const family = await readFamily(tx, { id: parentId, parentLotId: null })
    if (family.parent.item.tracking !== 'HIDE') throw new InvalidStateError(familyRefusal({ code: family.parent.code, qualityStatus: 'RELEASED', tracking: family.parent.item.tracking })!)
    const shades = await shadeChoices(tx, family)
    const problems: Issue[] = []
    const assignments: Assignment[] = []
    body.moves.forEach((move, index) => {
      const at = `body/moves/${index}`
      const hide = movable(family, move.hideId, `${at}/hideId`, problems)
      const to = isUuid(move.toLotId) ? family.byId.get(move.toLotId) : undefined
      if (!to) {
        problems.push({ path: `${at}/toLotId`, message: `Not lot ${family.parent.code} or a lot split from it.` })
        return
      }
      const toProblem = familyRefusal({ code: to.code, qualityStatus: to.qualityStatus, tracking: family.parent.item.tracking })
      if (toProblem) {
        problems.push({ path: `${at}/toLotId`, message: toProblem })
        return
      }
      if (!hide) return
      const from = family.byId.get(hide.lotId)!
      if (from.id === to.id) {
        problems.push({ path: `${at}/toLotId`, message: `Hide ${hide.code} is in lot ${to.code} already.` })
        return
      }
      if (!sameQuality(from, to)) {
        problems.push({ path: `${at}/toLotId`, message: `Hide ${hide.code} is of lot ${from.code} (${from.qualityStatus.toLowerCase()}); lot ${to.code} is ${to.qualityStatus.toLowerCase()}: a hide goes only into a lot of the same quality state.` })
        return
      }
      // The target's shade: the article's group of that name, else the hide's own article group, else the target's words.
      const named = to.shade ? shades.find((row) => row.lotId === null && row.active && row.label.toLowerCase() === to.shade!.toLowerCase()) : undefined
      const own = hide.shadeGroupId ? shades.find((row) => row.id === hide.shadeGroupId && row.lotId === null) : undefined
      const group = named ?? (to.shade ? undefined : own)
      assignments.push({ hide, to, shadeGroupId: group?.id ?? null, shade: group?.label ?? to.shade ?? hide.shade })
    })
    if (problems.length > 0) refuse(problems, 'The regroup is not valid.')
    const note = body.note?.trim() || null
    const { made, moveIds } = await moveHides(tools, family, assignments, 'REGROUP', note)
    tools.audit({
      recordType: 'Lot',
      recordId: family.parent.id,
      companyId: family.parent.companyId,
      siteId: family.parent.siteId,
      after: { hides: made.map((entry) => ({ from: entry.assignment.hide.id, fromCode: entry.assignment.hide.code, fromLotId: entry.assignment.hide.lotId, to: entry.id, code: entry.code, lotId: entry.assignment.to.id })), note },
      ...(note ? { reason: note } : {}),
    })
    tools.emit({
      type: 'lot.split',
      subject: family.parent.id,
      companyId: family.parent.companyId,
      siteId: family.parent.siteId,
      payload: { kind: 'REGROUP', parentLotId: family.parent.id, fromLotIds: [...new Set(assignments.map((entry) => entry.hide.lotId))], toLotIds: [...new Set(assignments.map((entry) => entry.to.id))], newLotIds: [], hides: made.length, moveIds },
    })
    return answerOf(tools, family.parent.id, new Set(), made)
  })
  return result
}
