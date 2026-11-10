import type { FactoryClient } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { ApprovalBody, MaterialDepthView, PropertiesBody } from '@nexus/factory-domain/product/materials-depth/contracts'
import { PRODUCT_MATERIALS_APPROVE } from '@nexus/factory-domain/product/materials-depth/permissions'
import {
  approvalConsequences,
  approvalProblems,
  changedProperties,
  fibreReadings,
  normaliseProperties,
  noteOf,
  PROPERTY_KEYS,
  propertiesProblems,
  shapeOf,
  type MaterialApproval,
  type MaterialProperties,
} from '@nexus/factory-domain/product/materials-depth/rules'
import { PRODUCT_MATERIALS_MANAGE } from '@nexus/factory-domain/product/materials/permissions'
import type { FibreShare } from '@nexus/factory-domain/product/materials/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { assertMayWrite, contextOf, readMaterial } from '../materials/store'
import { reachOf } from './where-used'

/**
 * A material in depth (B-W2b-238; design products.materials Properties & grades › Properties by kind, Compliance › Approval
 * status): GET …/depth reads its typed properties, its fibres as the label reads them and its approval with what a decision
 * reaches; PUT …/properties writes the properties of its kind (product.materials.manage); PUT …/approval decides
 * (product.materials.approve). Every write through command() at the material's version (COL-078), with its audit row and
 * its event; every refusal in words before B-W2b-206's Item_w2b4_depth trigger speaks.
 *
 * Who decides: anyone holding product.materials.approve over the material's company (a material of every company: a grant
 * over every company). The design names no four eyes for a material's approval (the Owner's answers name them for releases
 * of garments and change orders), so the person who added a material may approve it.
 */

const DEPTH_COLUMNS = {
  id: true,
  code: true,
  name: true,
  kind: true,
  companyId: true,
  status: true,
  version: true,
  properties: true,
  composition: true,
  approval: true,
  approvedAt: true,
  approvedById: true,
  approvalNote: true,
} as const

type Reader = FactoryClient | CommandTx

const compositionOf = (value: unknown): FibreShare[] | null =>
  Array.isArray(value) ? value.filter((entry): entry is FibreShare => typeof entry === 'object' && entry !== null && typeof (entry as FibreShare).fibre === 'string' && typeof (entry as FibreShare).percent === 'string') : null

const propertiesOf = (value: unknown): MaterialProperties | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as MaterialProperties) : null)

/** The depth view of a material (a read, or a command's answer with its transaction). */
export async function depthViewOf(db: Reader, context: RequestContext, materialId: string): Promise<MaterialDepthView> {
  const row = await db.item.findUniqueOrThrow({ where: { id: materialId }, select: DEPTH_COLUMNS })
  const decidedBy = row.approvedById === null ? null : await db.user.findUnique({ where: { id: row.approvedById }, select: { id: true, displayName: true } })
  const reach = await reachOf(db, actorOf(context), materialId)
  const shape = shapeOf(row.kind)
  const values = propertiesOf(row.properties)
  return {
    material: { id: row.id, code: row.code, name: row.name, kind: row.kind as MaterialDepthView['material']['kind'], companyId: row.companyId, status: row.status, version: row.version },
    properties: { shape, keys: shape ? [...PROPERTY_KEYS[shape]] : [], values: values ? { ...(values as Record<string, string | boolean>) } : null },
    fibres: fibreReadings(compositionOf(row.composition)),
    approval: {
      approval: row.approval,
      note: row.approvalNote,
      decidedAt: row.approvedAt ? toUtcIso(row.approvedAt) : null,
      decidedBy: decidedBy ? { id: decidedBy.id, name: decidedBy.displayName } : null,
    },
    reach,
    consequences: approvalConsequences('BLOCKED', { ...reach, openWorkOrders: reach.openWorkOrders ?? 0 }),
  }
}

/** GET /product/materials/:materialId/depth */
export async function readDepth(caller: CommandCaller, materialId: string): Promise<MaterialDepthView> {
  await readMaterial(caller, materialId)
  const context = contextOf(caller)
  return caller.withClient((client) => depthViewOf(client, context, materialId))
}

const invalid = (issues: readonly Issue[]) => new ValidationError('The properties are not valid.', issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))

function activeOnly(status: string, code: string): void {
  if (status !== 'ACTIVE') throw new InvalidStateError(`Material ${code} is archived: reactivate it before changing it.`)
}

/**
 * PUT /product/materials/:materialId/properties — the typed properties of its kind, all at once (product.materials.manage;
 * command product.materialsDepth.setProperties). What is left out is cleared; null clears them all. Event W1's
 * material.updated with `fields: ['properties']`; the audit row keeps the properties before and after.
 */
export async function setProperties(caller: CommandCaller, materialId: string, body: PropertiesBody, idempotencyKey?: string): Promise<MaterialDepthView> {
  const context = contextOf(caller)
  const seen = await readMaterial(caller, materialId)
  assertMayWrite(context, PRODUCT_MATERIALS_MANAGE, seen.companyId)
  activeOnly(seen.status, seen.code)
  const next = normaliseProperties(body.properties)
  const problems = propertiesProblems(seen.kind, next)
  if (problems.length > 0) throw invalid(problems)

  const { result } = await command(
    caller,
    { name: 'product.materialsDepth.setProperties', idempotencyKey, input: { materialId, ...body }, record: { type: 'Item', id: materialId, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      const row = await tx.item.findUniqueOrThrow({ where: { id: materialId }, select: { code: true, kind: true, status: true, companyId: true, properties: true } })
      activeOnly(row.status, row.code)
      // The kind read again under the version's lock: a kind changed meanwhile was a stale version already.
      const again = propertiesProblems(row.kind, next)
      if (again.length > 0) throw invalid(again)
      const before = propertiesOf(row.properties)
      const changed = changedProperties(before, next)
      if (next === null) await tx.$executeRaw`UPDATE "Item" SET "properties" = NULL WHERE "id" = ${materialId}::uuid`
      else await tx.item.update({ where: { id: materialId }, data: { properties: next as Record<string, string | boolean> }, select: { id: true } })
      tools.audit({ recordType: 'Item', recordId: materialId, companyId: row.companyId, before: { properties: before }, after: { properties: next }, ...(body.reason ? { reason: body.reason } : {}) })
      if (changed.length > 0) tools.emit({ type: 'material.updated', subject: materialId, companyId: row.companyId, payload: { itemId: materialId, code: row.code, fields: ['properties'] } })
      return depthViewOf(tx, tools.context, materialId)
    },
  )
  return result
}

/**
 * PUT /product/materials/:materialId/approval — a decision (product.materials.approve; command
 * product.materialsDepth.decideApproval): approval, who (the caller) and when (the command's time) together; a condition
 * and a block with why; back to pending clears who and when (the note may say why). The same decision with the same note
 * again is a 409 in words. Event material.approval_changed; the audit row keeps the decision before and after and what a
 * block reached (draft revisions held at release, released ones kept, their open work orders).
 */
export async function decideApproval(caller: CommandCaller, materialId: string, body: ApprovalBody, idempotencyKey?: string): Promise<MaterialDepthView> {
  const context = contextOf(caller)
  const seen = await readMaterial(caller, materialId)
  assertMayWrite(context, PRODUCT_MATERIALS_APPROVE, seen.companyId)
  activeOnly(seen.status, seen.code)
  const note = noteOf(body.note)
  const problems = approvalProblems(body.approval, note)
  if (problems.length > 0) throw new ValidationError('The decision is not valid.', problems)

  const { result } = await command(
    caller,
    { name: 'product.materialsDepth.decideApproval', idempotencyKey, input: { materialId, ...body }, record: { type: 'Item', id: materialId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const row = await tx.item.findUniqueOrThrow({ where: { id: materialId }, select: { code: true, status: true, companyId: true, approval: true, approvedAt: true, approvedById: true, approvalNote: true } })
      activeOnly(row.status, row.code)
      const previous = row.approval as MaterialApproval
      if (previous === body.approval && row.approvalNote === note) throw new ConflictError(`Material ${row.code} is ${body.approval.toLowerCase()} already, with this note.`)
      const decided = previous !== body.approval
      const pending = body.approval === 'PENDING'
      const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
      const data = decided
        ? { approval: body.approval, approvedAt: pending ? null : now, approvedById: pending ? null : actorId, approvalNote: note }
        : // The same decision with another note: when and by whom stay (the database: they change only with the approval).
          { approvalNote: note }
      await tx.item.update({ where: { id: materialId }, data, select: { id: true } })
      const reach = await reachOf(tx, actorOf(tools.context), materialId)
      tools.audit({
        recordType: 'Item',
        recordId: materialId,
        companyId: row.companyId,
        before: { approval: previous, approvalNote: row.approvalNote, approvedAt: row.approvedAt ? toUtcIso(row.approvedAt) : null, approvedById: row.approvedById },
        after: {
          approval: body.approval,
          approvalNote: note,
          ...(decided ? { approvedAt: pending ? null : toUtcIso(now), approvedById: pending ? null : actorId } : {}),
          ...(body.approval === 'BLOCKED' && decided ? { reached: { draftRevisions: reach.draftRevisions, releasedRevisions: reach.releasedRevisions, openWorkOrders: reach.openWorkOrders } } : {}),
        },
        ...(note ? { reason: note } : {}),
      })
      if (decided) tools.emit({ type: 'material.approval_changed', subject: materialId, companyId: row.companyId, payload: { itemId: materialId, code: row.code, approval: body.approval, previous } })
      return depthViewOf(tx, tools.context, materialId)
    },
  )
  return result
}
