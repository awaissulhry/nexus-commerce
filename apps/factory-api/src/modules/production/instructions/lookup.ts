import { checklistOfSteps, type MarkedStep } from '@nexus/factory-domain/production/instructions/rules'
import type { Reader } from '../scans/store'
import { INSTRUCTION, SETTING, STEP, VERSION, type InstructionRow, type SettingRow, type StepRow, type VersionRow } from './store'

/**
 * Which work instruction the floor shows for an operation of a work order (B-W2b-214; B-W2b-205's lookup): of the work order's
 * company and the operation of the library (the routing step's, or an unplanned operation's own), ACTIVE, the one for the
 * work order's own style revision first, else the one for every style; the first of them with a PUBLISHED version (a
 * revision's own instruction still in its first draft leaves the one for every style in force). Read as the caller: a floor
 * device reads only published and superseded versions (its grant and policy), and the steps the scans' report holds Finish
 * for are read inside its command, on its one connection.
 */

export interface OperationPlace {
  readonly workOrderOperationId: string
  readonly workOrderId: string
  readonly companyId: string
  readonly siteId: string
  /** The operation of the library; null for a routing step that names none (never, by the schema) or a missing row. */
  readonly operationId: string | null
  /** The work order's frozen style revision. */
  readonly revisionId: string
  /** The revision's routing step (null for an unplanned operation). */
  readonly routingOperationId: string | null
  readonly routingSeq: number | null
  /** The routing step's typed instructions (B-W2b-47's `[ ] CODE words` lines, until an instruction is published). */
  readonly typedLines: string | null
}

/** Where an operation of a work order stands: its company, its library operation, its revision and routing step. */
export async function operationPlaceOf(db: Reader, workOrderOperationId: string): Promise<OperationPlace | null> {
  const operation = await db.workOrderOperation.findUnique({ where: { id: workOrderOperationId }, select: { id: true, workOrderId: true, siteId: true, styleRevisionId: true, routingSeq: true, operationId: true } })
  if (!operation) return null
  const workOrder = await db.workOrder.findUnique({ where: { id: operation.workOrderId }, select: { companyId: true } })
  if (!workOrder) return null
  const step = operation.routingSeq === null ? null : await db.routingOperation.findFirst({ where: { revisionId: operation.styleRevisionId, seq: operation.routingSeq }, select: { id: true, operationId: true, instructions: true } })
  return {
    workOrderOperationId: operation.id,
    workOrderId: operation.workOrderId,
    companyId: workOrder.companyId,
    siteId: operation.siteId,
    operationId: step?.operationId ?? operation.operationId,
    revisionId: operation.styleRevisionId,
    routingOperationId: step?.id ?? null,
    routingSeq: operation.routingSeq,
    typedLines: step?.instructions ?? null,
  }
}

export interface InForce {
  readonly instruction: InstructionRow
  readonly version: VersionRow
}

/** The instruction in force for (company, operation, revision), with its published version; null: none is published. */
export async function instructionInForce(db: Reader, place: { readonly companyId: string; readonly operationId: string | null; readonly revisionId: string | null }): Promise<InForce | null> {
  if (!place.operationId) return null
  const candidates = await db.workInstruction.findMany({
    where: { companyId: place.companyId, operationId: place.operationId, status: 'ACTIVE', OR: [{ styleRevisionId: null }, ...(place.revisionId ? [{ styleRevisionId: place.revisionId }] : [])] },
    select: INSTRUCTION,
  })
  const ordered = [...candidates.filter((row) => place.revisionId !== null && row.styleRevisionId === place.revisionId), ...candidates.filter((row) => row.styleRevisionId === null)]
  for (const instruction of ordered) {
    const version = await db.workInstructionVersion.findFirst({ where: { instructionId: instruction.id, status: 'PUBLISHED' }, select: VERSION })
    if (version) return { instruction, version }
  }
  return null
}

/** The published steps of the operation's instruction, as the checklist (B-W2b-47's reader); null: no instruction is published. */
export async function publishedStepsOf(db: Reader, place: OperationPlace, language?: string | null): Promise<MarkedStep[] | null> {
  const inForce = await instructionInForce(db, place)
  if (!inForce) return null
  const rows: StepRow[] = await db.workInstructionStep.findMany({ where: { versionId: inForce.version.id }, select: STEP, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] })
  return checklistOfSteps(rows, language)
}

/** The machine settings the tablet shows with the instruction: the routing step's own, else the library operation's. */
export async function settingsOf(db: Reader, place: Pick<OperationPlace, 'routingOperationId' | 'operationId'>): Promise<SettingRow[]> {
  if (place.routingOperationId) {
    const own = await db.operationMachineSetting.findMany({ where: { routingOperationId: place.routingOperationId }, select: SETTING, orderBy: { seq: 'asc' } })
    if (own.length > 0) return own
  }
  return place.operationId ? db.operationMachineSetting.findMany({ where: { operationId: place.operationId }, select: SETTING, orderBy: { seq: 'asc' } }) : []
}
