import type { Prisma } from '@nexus/factory-db'
import type { PreviewChange } from '@nexus/factory-domain/approvals/rules'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import type { AlternateUse } from '@nexus/factory-domain/product/bom-lines/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { approvedByEngine, refusedByEngine, withdrawnByEngine } from '../../../modules/inventory/substitutions/decisions'
import { SUBSTITUTION_FIELDS, substitutionFacts } from '../../../modules/inventory/substitutions/facts'
import { kindOfRow, readItemsOf, readSubstitution } from '../../../modules/inventory/substitutions/store'
import type { ApprovalKindDefinition, ApprovalSubject, Reader, TaskRef } from './kind'

/**
 * MATERIAL_SUBSTITUTION (B-W2b-298; MES-139 "Substitute material with approval"; design warehouse.picking pop:pk-sub "Ask for
 * approval", conn "Substitution approvals (home.approvals)"): a substitute on a work order's BOM line before it is used — another
 * lot of the line's own material, or one of the line's alternates whose rule asks a person (B-W2b-228's WITH_APPROVAL) or that an
 * approval rule of this kind catches.
 *
 * The subject is the MaterialSubstitution itself (B-W2b-277; its `approvalTaskId` names the request, once). Only the
 * substitutes' ask (POST /inventory/substitutions) asks: never the generic route. The fingerprint covers the substitution as it
 * will be used — what it replaces and by what, its colour and lot, how much, why, the rule's answer (the database keeps
 * these fixed once asked; the lot only until it is issued). The facts its rules test are modules/inventory/substitutions/facts.ts (no money). On
 * the yes (the approver's command) it is APPROVED, by the approver; on a no REFUSED with the no's words; taken back or found
 * changed it is WITHDRAWN (its request is named once: ask again).
 */

export const MATERIAL_SUBSTITUTION_RECORD = 'MaterialSubstitution'

async function readSubject(client: Reader, recordId: string): Promise<ApprovalSubject | null> {
  const row = await readSubstitution(client, recordId)
  if (!row) return null
  const order = await client.workOrder.findUnique({ where: { id: row.workOrderId }, select: { number: true, companyId: true } })
  const site = await client.site.findUnique({ where: { id: row.siteId }, select: { code: true } })
  const line = await client.bomLine.findUnique({ where: { id: row.bomLineId }, select: { seq: true } })
  const items = await readItemsOf(client, [row.fromItemId, row.toItemId])
  const own = items.get(row.fromItemId)
  const substitute = items.get(row.toItemId)
  if (!order || !site || !line || !own || !substitute) return null
  const lot = row.toLotId ? await client.lot.findUnique({ where: { id: row.toLotId }, select: { code: true } }) : null
  const colour = row.toItemColourId ? await client.itemColour.findUnique({ where: { id: row.toItemColourId }, select: { code: true } }) : null
  const alternate = row.alternateId ? await client.bomLineAlternate.findUnique({ where: { id: row.alternateId }, select: { priority: true, allowedWhen: true } }) : null
  const kind = kindOfRow(row)
  const what = `${substitute.code}${colour ? ` ${colour.code}` : ''}${lot ? ` lot ${lot.code}` : ''}`
  const quantity = `${quantityText(row.quantity.toString())} ${row.uom}`
  const snapshot = {
    substitution: {
      id: row.id,
      workOrderId: row.workOrderId,
      bomLineId: row.bomLineId,
      fromItemId: row.fromItemId,
      toItemId: row.toItemId,
      toItemColourId: row.toItemColourId,
      toLotId: row.toLotId,
      alternateId: row.alternateId,
      quantity: quantityText(row.quantity.toString()),
      uom: row.uom,
      baseQuantity: quantityText(row.baseQuantity.toString()),
      reasonCode: row.reasonCode,
      reason: row.reason,
      ruleAnswer: row.ruleAnswer,
    },
  }
  const changes: PreviewChange[] = [
    { field: 'material', from: `${own.code} (line ${line.seq})`, to: what, grain: null },
    { field: 'quantity', from: null, to: quantity, grain: null },
    { field: 'status', from: 'WAITING', to: 'APPROVED', grain: null },
  ]
  return {
    companyId: order.companyId,
    siteId: row.siteId,
    label: `${order.number} line ${line.seq} · ${substitute.code}`,
    summary: `${order.number}: ${what} instead of ${own.code} (line ${line.seq}), ${quantity}: ${row.reason}`.slice(0, 500),
    facts: substitutionFacts({
      kind,
      allowedWhen: (alternate?.allowedWhen as AlternateUse | undefined) ?? null,
      ppe: own.isPpeComponent || substitute.isPpeComponent,
      materialKind: substitute.kind,
      itemCode: substitute.code,
      lineMaterialCode: own.code,
      quantity: quantityText(row.baseQuantity.toString()),
      siteCode: site.code,
      reasonCode: row.reasonCode,
      askedOnFloor: row.requestedByWorkerId !== null,
    }),
    snapshot,
    changes,
    held: row.status === 'WAITING' ? null : `This substitute is ${row.status.toLowerCase()}: it waits for no yes.`,
  }
}

/** The request's no in words, read in the decision's command ("Wrong material — the lining shows through"). */
async function rejectWords(tools: CommandTools, taskId: string): Promise<string> {
  const task = await tools.tx.approvalTask.findUnique({ where: { id: taskId }, select: { rejectReasonCode: true, rejectReason: true } })
  return [task?.rejectReasonCode, task?.rejectReason].filter((part): part is string => Boolean(part)).join(': ') || 'Refused.'
}

export const MATERIAL_SUBSTITUTION_KIND: ApprovalKindDefinition = Object.freeze({
  kind: 'MATERIAL_SUBSTITUTION',
  recordType: MATERIAL_SUBSTITUTION_RECORD,
  label: { en: 'Material substitution', it: 'Sostituzione di materiale' },
  view: INVENTORY_STOCK_VIEW,
  // Only the substitutes' ask asks (POST /inventory/substitutions): never the generic route.
  ask: null,
  fields: SUBSTITUTION_FIELDS,
  read: readSubject,
  async lock(tx: CommandTx, recordId: string) {
    if (isUuid(recordId)) await tx.$queryRaw`SELECT id FROM "MaterialSubstitution" WHERE id = ${recordId}::uuid FOR UPDATE`
  },
  async recent(client: Reader, companyId: string | null, limit: number) {
    const where: Prisma.MaterialSubstitutionWhereInput = companyId ? { workOrder: { companyId } } : {}
    const rows = await client.materialSubstitution.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, select: { id: true } })
    return rows.map((row) => row.id)
  },
  onApproved: (tools: CommandTools, task: TaskRef) => approvedByEngine(tools, task.recordId, task.decidedById),
  onRejected: async (tools: CommandTools, task: TaskRef) => refusedByEngine(tools, task.recordId, task.decidedById!, await rejectWords(tools, task.id)),
  onWithdrawn: (tools: CommandTools, task: TaskRef) => withdrawnByEngine(tools, task.recordId, 'Its request for a yes was taken back: ask again if it is still needed.'),
  onStale: (tools: CommandTools, task: TaskRef) => withdrawnByEngine(tools, task.recordId, 'It changed since its yes was asked: ask again.'),
})
