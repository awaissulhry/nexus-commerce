import { ForbiddenError, NotFoundError, ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { PRODUCT_BOM_MANAGE } from '@nexus/factory-domain/product/bom/permissions'
import type { AddPlacementBody, OrderPlacementsBody, ProtectorPlacementView, RemovePlacementsBody, UpdatePlacementBody } from '@nexus/factory-domain/product/protectors/contracts'
import { PROTECTOR_CHANGES } from '@nexus/factory-domain/product-protectors/events'
import {
  fieldProblems,
  overlapProblems,
  PLACEMENT_LIMITS,
  POCKET_STANDARD,
  PROTECTOR_LEVELS,
  protectorProblems,
  type PlacementShape,
  type ProtectorLevel,
  type ProtectorPocket,
} from '@nexus/factory-domain/product/protectors/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { lockMaterials, readRevisionFor } from '../bom/store'
import { contextOf, mayWrite } from '../materials/store'
import {
  invalid,
  lockPlacements,
  mayChoose,
  placementsGuarded,
  placementView,
  placementViewInTx,
  prefixed,
  protectorFactsOf,
  readItems,
  readPlacements,
  type LockedPlacements,
  type PlacementRow,
} from './store'

/**
 * A style revision's protector placement (B-W2b-233; PRD-074; design products.styles › Sizes & measurements › Protector
 * placement: pocket · protector part, standard and level per size · pocket position; revision-bound): read with the BOM's
 * right (product.bom.view), written with product.bom.manage over the style's company while the revision is a DRAFT under
 * the style's edit rule (B-W2b-221). Every write: one command(), the style row locked first, a placement's own version on
 * a change (409 when stale), audit rows, `style.protectors_changed`. Refused in words: a material that is not an active
 * PROTECTOR of the style's company (or every company) or is blocked, a size outside the range, two placements of one
 * pocket on one size. The checks against the BOM and the certificates are the view's findings (never blocking).
 */

type Change = (typeof PROTECTOR_CHANGES)[number]

function emitChange(tools: CommandTools, locked: LockedPlacements, change: Change, placementIds: readonly string[]): void {
  const { style, revision } = locked
  tools.emit({
    type: 'style.protectors_changed',
    subject: style.id,
    companyId: style.companyId,
    payload: { styleId: style.id, code: style.code, revisionId: revision.id, revision: revision.revision, change, placementIds: [...placementIds] },
  })
}

const audited = (row: Pick<PlacementRow, 'seq' | 'pocket' | 'protectorItemId' | 'standard' | 'level' | 'sizes' | 'positionNote'>) => ({
  seq: row.seq,
  pocket: row.pocket,
  protectorItemId: row.protectorItemId,
  standard: row.standard,
  level: row.level,
  sizes: [...row.sizes],
  positionNote: row.positionNote,
})

/** The style and revision as the caller may see them (product.bom.view), and the write right over the style's company. */
async function writer(caller: CommandCaller, styleId: string, revisionId: string) {
  const seen = await readRevisionFor(caller, styleId, revisionId)
  if (!mayWrite(actorOf(contextOf(caller)), PRODUCT_BOM_MANAGE, seen.style.companyId)) {
    throw new ForbiddenError(seen.style.companyId === null ? 'The protector placement of a style for every company is changed only by a role over every company.' : undefined)
  }
  return seen
}

/** GET …/protectors: the revision's placement with what to look at. */
export async function getPlacements(caller: CommandCaller, styleId: string, revisionId: string): Promise<ProtectorPlacementView> {
  const { style, revision } = await readRevisionFor(caller, styleId, revisionId)
  return caller.withClient((client) => placementView(client, style, revision))
}

/** The protector a pocket takes, checked (and locked FOR SHARE): an active PROTECTOR of the style's company or every company, not blocked. */
async function protectorFor(tx: CommandTx, itemId: string, companyId: string | null): Promise<ReturnType<typeof protectorFactsOf>> {
  if (!isUuid(itemId)) throw invalid(prefixed(protectorProblems(null)))
  await lockMaterials(tx, [itemId])
  const row = (await readItems(tx, [itemId])).get(itemId)
  const facts = row ? protectorFactsOf(row) : null
  const problems = protectorProblems(facts)
  if (problems.length > 0) throw invalid(prefixed(problems))
  if (row && !mayChoose(row, companyId)) {
    throw invalid([{ path: 'body/protectorItemId', message: row.status !== 'ACTIVE' ? `${row.code} is archived: pick an active protector.` : `${row.code} belongs to another company than the style's.` }])
  }
  return facts!
}

const shapeOf = (row: PlacementRow): PlacementShape => ({ id: row.id, seq: row.seq, pocket: row.pocket as ProtectorPocket, sizes: [...row.sizes] })

/** The rows in their new order numbered 1, 2, 3 … (in two steps: a place is unique per revision); a moved row's version moves. */
async function renumber(tools: CommandTools, ordered: readonly PlacementRow[]): Promise<string[]> {
  const { tx, now } = tools
  const moves = ordered.map((row, index) => ({ row, to: index + 1 })).filter((move) => move.row.seq !== move.to)
  if (moves.length === 0) return []
  const offset = Math.max(ordered.length, ...ordered.map((row) => row.seq)) + 1
  for (const move of moves) await tx.protectorPlacement.update({ where: { id: move.row.id }, data: { seq: offset + move.to }, select: { id: true } })
  for (const move of moves) await tx.protectorPlacement.update({ where: { id: move.row.id }, data: { seq: move.to, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  return moves.map((move) => move.row.id)
}

/** product.protectors.add: a placement at the end of the draft's list. */
export async function addPlacement(caller: CommandCaller, styleId: string, revisionId: string, body: AddPlacementBody, idempotencyKey?: string): Promise<ProtectorPlacementView> {
  await writer(caller, styleId, revisionId)
  const { result } = await placementsGuarded(() =>
    command(caller, { name: 'product.protectors.add', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
      const { tx, now } = tools
      const locked = await lockPlacements(tools, styleId, revisionId)
      const range = locked.style.sizes
      const protector = await protectorFor(tx, body.protectorItemId, locked.style.companyId)
      const standard = body.standard ?? protector.standard ?? POCKET_STANDARD[body.pocket]
      const level: ProtectorLevel = body.level ?? ((PROTECTOR_LEVELS as readonly string[]).includes(protector.level ?? '') ? (protector.level as ProtectorLevel) : '1')
      const fields = { pocket: body.pocket, standard, level, sizes: body.sizes, positionNote: body.positionNote }
      const problems: Issue[] = prefixed(fieldProblems(fields, range))
      const existing = await readPlacements(tx, revisionId)
      if (existing.length >= PLACEMENT_LIMITS.placements) problems.push({ path: 'body', message: `A revision has at most ${PLACEMENT_LIMITS.placements} protector placements.` })
      const id = newId()
      const seq = existing.reduce((top, row) => Math.max(top, row.seq), 0) + 1
      if (problems.length === 0) problems.push(...prefixed(overlapProblems([...existing.map(shapeOf), { id, seq, pocket: body.pocket, sizes: body.sizes }], id, range)))
      if (problems.length > 0) throw invalid(problems)
      const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
      const row = { seq, pocket: body.pocket, protectorItemId: protector.id, standard, level, sizes: [...body.sizes], positionNote: body.positionNote }
      await tx.protectorPlacement.create({ data: { id, styleId, revisionId, ...row, createdAt: now, updatedAt: now, createdById }, select: { id: true } })
      tools.audit({ recordType: 'ProtectorPlacement', recordId: id, companyId: locked.style.companyId, after: { styleId, revisionId, revision: locked.revision.revision, ...audited(row) } })
      emitChange(tools, locked, 'ADDED', [id])
      return placementViewInTx(tx, styleId, revisionId)
    }),
  )
  return result
}

/** product.protectors.update: one placement's fields, at its version (a cell of the list, autosaved). */
export async function updatePlacement(caller: CommandCaller, styleId: string, revisionId: string, placementId: string, body: UpdatePlacementBody, idempotencyKey?: string): Promise<ProtectorPlacementView> {
  await writer(caller, styleId, revisionId)
  const { version, ...patch } = body
  if (Object.keys(patch).length === 0) throw invalid([{ path: 'body', message: 'Nothing changes: name a field of the placement.' }])
  const { result } = await placementsGuarded(() =>
    command(caller, { name: 'product.protectors.update', idempotencyKey, input: { styleId, revisionId, placementId, ...body } }, async (tools) => {
      const { tx, now } = tools
      const locked = await lockPlacements(tools, styleId, revisionId)
      const range = locked.style.sizes
      if (!isUuid(placementId)) throw new NotFoundError('Protector placement not found.')
      const [current] = await tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "ProtectorPlacement" WHERE "id" = ${placementId}::uuid AND "revisionId" = ${revisionId}::uuid FOR UPDATE`
      if (!current) throw new NotFoundError('Protector placement not found.')
      if (current.version !== version) throw new StaleVersionError('ProtectorPlacement', placementId, current.version, version)
      const rows = await readPlacements(tx, revisionId)
      const before = rows.find((row) => row.id === placementId)!
      if (patch.protectorItemId !== undefined && patch.protectorItemId !== before.protectorItemId) await protectorFor(tx, patch.protectorItemId, locked.style.companyId)
      const next = {
        seq: before.seq,
        pocket: (patch.pocket ?? before.pocket) as ProtectorPocket,
        protectorItemId: patch.protectorItemId ?? before.protectorItemId,
        standard: patch.standard ?? before.standard,
        level: patch.level ?? before.level,
        sizes: patch.sizes ?? [...before.sizes],
        positionNote: patch.positionNote !== undefined ? patch.positionNote : before.positionNote,
      }
      // A size that left the range may stay on a placement that keeps its sizes as they are (the copy keeps them in range).
      const problems: Issue[] = prefixed(fieldProblems({ ...next, sizes: patch.sizes === undefined ? next.sizes.filter((size) => range.includes(size)) : next.sizes }, range))
      if (problems.length === 0) problems.push(...prefixed(overlapProblems(rows.map((row) => (row.id === placementId ? { id: row.id, seq: row.seq, pocket: next.pocket, sizes: next.sizes } : shapeOf(row))), placementId, range)))
      if (problems.length > 0) throw invalid(problems)
      const { count } = await tx.protectorPlacement.updateMany({
        where: { id: placementId, version },
        data: { pocket: next.pocket, protectorItemId: next.protectorItemId, standard: next.standard, level: next.level, sizes: next.sizes, positionNote: next.positionNote, version: version + 1, updatedAt: now },
      })
      if (count !== 1) throw new StaleVersionError('ProtectorPlacement', placementId, version + 1, version)
      tools.audit({ recordType: 'ProtectorPlacement', recordId: placementId, companyId: locked.style.companyId, before: audited(before), after: audited(next) })
      emitChange(tools, locked, 'UPDATED', [placementId])
      return placementViewInTx(tx, styleId, revisionId)
    }),
  )
  return result
}

/** product.protectors.remove: the selection removed (each at its version; all or none), the rest numbered again. */
export async function removePlacements(caller: CommandCaller, styleId: string, revisionId: string, body: RemovePlacementsBody, idempotencyKey?: string): Promise<ProtectorPlacementView> {
  await writer(caller, styleId, revisionId)
  const { result } = await placementsGuarded(() =>
    command(caller, { name: 'product.protectors.remove', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
      const { tx } = tools
      const locked = await lockPlacements(tools, styleId, revisionId)
      const ids = [...new Set(body.placements.map((entry) => entry.id))].sort()
      const found = await tx.$queryRaw<{ id: string; version: number }[]>`SELECT "id"::text AS "id", "version" FROM "ProtectorPlacement" WHERE "id" = ANY(${ids}::uuid[]) AND "revisionId" = ${revisionId}::uuid ORDER BY "id" FOR UPDATE`
      for (const entry of body.placements) {
        const row = found.find((candidate) => candidate.id === entry.id)
        if (!row) throw new NotFoundError('Protector placement not found.')
        if (row.version !== entry.version) throw new StaleVersionError('ProtectorPlacement', entry.id, row.version, entry.version)
      }
      const rows = await readPlacements(tx, revisionId)
      const gone = rows.filter((row) => ids.includes(row.id))
      await tx.protectorPlacement.deleteMany({ where: { id: { in: ids }, revisionId } })
      for (const row of gone) tools.audit({ recordType: 'ProtectorPlacement', recordId: row.id, companyId: locked.style.companyId, before: audited(row), after: null })
      await renumber(
        tools,
        rows.filter((row) => !ids.includes(row.id)),
      )
      emitChange(tools, locked, 'REMOVED', ids)
      return placementViewInTx(tx, styleId, revisionId)
    }),
  )
  return result
}

/** product.protectors.order: every placement of the revision once, in its new order. */
export async function orderPlacements(caller: CommandCaller, styleId: string, revisionId: string, body: OrderPlacementsBody, idempotencyKey?: string): Promise<ProtectorPlacementView> {
  await writer(caller, styleId, revisionId)
  const { result } = await placementsGuarded(() =>
    command(caller, { name: 'product.protectors.order', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
      const { tx } = tools
      const locked = await lockPlacements(tools, styleId, revisionId)
      await tx.$queryRaw`SELECT "id" FROM "ProtectorPlacement" WHERE "revisionId" = ${revisionId}::uuid ORDER BY "id" FOR UPDATE`
      const rows = await readPlacements(tx, revisionId)
      const asked = body.placementIds
      if (asked.length !== rows.length || new Set(asked).size !== asked.length || !rows.every((row) => asked.includes(row.id))) {
        throw new ConflictError('The protector placement changed meanwhile: load it again, then put it in order.')
      }
      const ordered = asked.map((id) => rows.find((row) => row.id === id)!)
      const moved = await renumber(tools, ordered)
      tools.audit({ recordType: 'StyleRevision', recordId: revisionId, companyId: locked.style.companyId, before: { protectorOrder: rows.map((row) => row.id) }, after: { protectorOrder: [...asked], moved } })
      emitChange(tools, locked, 'ORDERED', moved)
      return placementViewInTx(tx, styleId, revisionId)
    }),
  )
  return result
}
