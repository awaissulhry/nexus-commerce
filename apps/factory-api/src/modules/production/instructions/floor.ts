import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { decimalOf, decimalText } from '@nexus/factory-domain/product/units/units'
import { asWords, wordsIn, type Words } from '@nexus/factory-domain/production/instructions/rules'
import type { CommandCaller } from '../../../core/command'
import { floorOf } from '../scans/access'
import { bundleState } from '../terminal/views'
import type { BundleRef } from '../terminal/timing'
import { seenStateOf, workerOf } from './acks'
import { instructionInForce, operationPlaceOf, settingsOf } from './lookup'
import { settingViews } from './office'
import { classesOf, kindOf, mediaOf, stepsOf, wordsOrNull, type Db } from './store'

/**
 * The tablet's look at the operation in hand (B-W2b-214; PRD-258, MES-110, MES-120; design floor.instructions SCR-174 "For
 * this work", "How to do it", "Spec for this size", "Seen"; floor.operation "New instruction (MES-110 opens it first)"):
 *
 *   GET /production/instructions/floor/operation?code|bundleId[&workOrderOperationId][&language]
 *       the bundle and its operation as the operation screen decides them (terminal's state), the instruction in force
 *       (its revision's own first, else the one for every style) with its steps in the worker's language (each step says
 *       which language it is shown in), its photos and videos (each opened through …/floor/media/:id/download), the machine
 *       settings, and whether Seen waits for this worker (FIRST time, or CHANGED since they saw a version): a version that
 *       waits opens before Start
 *   GET /production/instructions/floor/spec?code|bundleId
 *       the frozen spec of the bundle's work order for its size and colour: the style revision it was released on, the
 *       size's measures, the materials of its cell per garment, the label, the routing
 *
 * Read as the floor (its own site, published and superseded versions only, never a price or a cost); whether Seen waits is
 * read in the system scope (the floor reads no acknowledgement). Nothing is written.
 */

export interface FloorQuery extends BundleRef {
  readonly language?: string | undefined
}

/** GET /production/instructions/floor/operation. */
export async function floorInstruction(caller: CommandCaller, query: FloorQuery) {
  const context = floorOf(caller)
  const state = await bundleState(caller, query)
  const found = await caller.withClient(async (client) => {
    const db = client as Db
    const worker = await workerOf(db, context.actorId)
    const language = query.language ?? worker.locale
    const place = await operationPlaceOf(db, state.operation.id)
    if (!place) throw new NotFoundError('Operation not found.')
    const settings = await settingsOf(db, place)
    const inForce = await instructionInForce(db, place)
    return {
      worker,
      language,
      settings: settingViews(settings, await classesOf(db, settings.map((row) => row.machineClassId))),
      inForce,
      steps: inForce ? await stepsOf(db, [inForce.version.id]) : [],
      media: inForce ? await mediaOf(db, [inForce.version.id]) : [],
    }
  })
  const { inForce, language } = found
  const seen = inForce ? await seenStateOf(caller, found.worker, inForce.version) : null
  const caption = (words: Words | null) => (words ? (wordsIn(words, language)?.text ?? null) : null)
  return {
    bundle: { id: state.bundle.id, code: state.bundle.code, quantity: state.bundle.quantity },
    workOrder: { id: state.workOrder.id, number: state.workOrder.number },
    operation: state.operation,
    language,
    instruction: inForce
      ? {
          id: inForce.instruction.id,
          number: inForce.instruction.number,
          forRevision: inForce.instruction.styleRevisionId !== null,
          version: {
            id: inForce.version.id,
            number: inForce.version.number,
            publishedAt: inForce.version.publishedAt ? toUtcIso(inForce.version.publishedAt) : null,
            changeNote: inForce.version.changeNote,
            acknowledgementRequired: inForce.version.acknowledgementRequired,
          },
          steps: found.steps.map((step) => {
            const words = wordsIn(asWords(step.textI18n), language)
            const safety = wordsOrNull(step.safetyNoteI18n)
            return {
              code: step.code,
              words: words?.text ?? step.code,
              shownIn: words?.language ?? null,
              critical: step.critical,
              safety: safety ? (wordsIn(safety, language)?.text ?? null) : null,
              icon: step.icon,
              requiredTick: step.requiredTick,
              media: found.media.filter((medium) => medium.stepId === step.id).map((medium) => ({ id: medium.id, kind: kindOf(medium), caption: caption(wordsOrNull(medium.captionI18n)) })),
            }
          }),
        }
      : null,
    settings: found.settings,
    /** Seen: `due` FIRST or CHANGED opens the instruction before Start; null: nothing waits. */
    acknowledgement: seen ? { due: seen.due, seenAt: seen.seenAt } : null,
  }
}

interface Measure {
  readonly point: string
  readonly min: string | null
  readonly max: string | null
  readonly unit: string | null
}

/** A size's body measures (`{ chest: { min, max, unit } }`), as rows; anything else is left out. */
function measuresOf(value: unknown): Measure[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const text = (entry: unknown): string | null => (typeof entry === 'number' || typeof entry === 'string' ? String(entry) : null)
  return Object.entries(value as Record<string, unknown>).flatMap(([point, entry]) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const row = entry as Record<string, unknown>
      return [{ point, min: text(row.min), max: text(row.max), unit: typeof row.unit === 'string' ? row.unit : null }]
    }
    const single = text(entry)
    return single === null ? [] : [{ point, min: single, max: single, unit: null }]
  })
}

/** GET /production/instructions/floor/spec: the frozen spec of the bundle's work order for its size (PRD-258). */
export async function floorSpec(caller: CommandCaller, query: BundleRef) {
  floorOf(caller)
  const state = await bundleState(caller, query)
  return caller.withClient(async (client) => {
    const db = client as Db
    const bundle = await db.bundle.findUnique({ where: { id: state.bundle.id }, select: { id: true, code: true, quantity: true, part: true, workOrderSizeId: true } })
    const cell = bundle ? await db.workOrderSize.findUnique({ where: { id: bundle.workOrderSizeId }, select: { id: true, size: true, quantity: true, colourwayId: true, styleId: true } }) : null
    const workOrder = await db.workOrder.findUnique({ where: { id: state.workOrder.id }, select: { id: true, number: true, batchNumber: true, styleId: true, styleRevisionId: true, labelTemplateId: true, releasedAt: true } })
    if (!bundle || !cell || !workOrder) throw new NotFoundError('Bundle not found.')
    const style = await db.style.findUnique({ where: { id: workOrder.styleId }, select: { id: true, code: true, name: true, sizeScaleId: true, ppeCategory: true, ppeStandard: true, ppeClass: true } })
    const revision = workOrder.styleRevisionId ? await db.styleRevision.findUnique({ where: { id: workOrder.styleRevisionId }, select: { id: true, revision: true, status: true, releasedAt: true, effectiveFrom: true } }) : null
    const colourway = await db.colourway.findUnique({ where: { id: cell.colourwayId }, select: { code: true, name: true } })
    const size = style ? await db.size.findFirst({ where: { scaleId: style.sizeScaleId, code: cell.size }, select: { code: true, label: true, bodyMeasures: true } }) : null
    const label = workOrder.labelTemplateId ? await db.labelTemplate.findUnique({ where: { id: workOrder.labelTemplateId }, select: { code: true, name: true, revision: true, languages: true } }) : null
    // The materials frozen for the bundle's cell, per garment (the cell's planned quantity over its garments); never a cost.
    const materials = await db.workOrderMaterial.findMany({ where: { workOrderSizeId: cell.id }, select: { id: true, bomLineId: true, itemId: true, itemColourId: true, quantity: true, uom: true }, orderBy: { id: 'asc' } })
    const lines = new Map((await db.bomLine.findMany({ where: { id: { in: [...new Set(materials.map((row) => row.bomLineId))] } }, select: { id: true, seq: true, placement: true } })).map((row) => [row.id, row]))
    const items = new Map((await db.item.findMany({ where: { id: { in: [...new Set(materials.map((row) => row.itemId))] } }, select: { id: true, code: true, name: true, nameI18n: true } })).map((row) => [row.id, row]))
    const colours = new Map((await db.itemColour.findMany({ where: { id: { in: [...new Set(materials.map((row) => row.itemColourId).filter((id): id is string => id !== null))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
    const operations = await db.workOrderOperation.findMany({ where: { workOrderId: workOrder.id }, select: { id: true, seq: true, code: true, name: true }, orderBy: { seq: 'asc' } })
    const perGarment = (quantity: { toString(): string }) => (cell.quantity > 0 ? decimalText(decimalOf(quantity.toString()).div(cell.quantity).toDecimalPlaces(4)) : decimalText(quantity.toString()))
    return {
      bundle: { id: bundle.id, code: bundle.code, quantity: bundle.quantity, part: bundle.part },
      workOrder: { id: workOrder.id, number: workOrder.number, batchNumber: workOrder.batchNumber, releasedAt: workOrder.releasedAt ? toUtcIso(workOrder.releasedAt) : null },
      style: style ? { id: style.id, code: style.code, name: style.name, ppeCategory: style.ppeCategory as string, ppeStandard: style.ppeStandard, ppeClass: style.ppeClass } : null,
      /** The revision the work order was released on: its spec is frozen with it. */
      revision: revision ? { id: revision.id, revision: revision.revision, status: revision.status as string, releasedAt: revision.releasedAt ? toUtcIso(revision.releasedAt) : null } : null,
      colourway: colourway ? { code: colourway.code, name: colourway.name } : null,
      size: { code: cell.size, label: size?.label ?? null, measures: measuresOf(size?.bodyMeasures ?? null) },
      materials: materials
        .map((row) => {
          const item = items.get(row.itemId)
          const colour = row.itemColourId ? colours.get(row.itemColourId) : undefined
          const line = lines.get(row.bomLineId)
          return { seq: line?.seq ?? 0, placement: line?.placement ?? null, item: { code: item?.code ?? '', name: item?.name ?? '', nameI18n: asWords(item?.nameI18n ?? null) }, colour: colour ? { code: colour.code, name: colour.name } : null, perGarment: perGarment(row.quantity), uom: row.uom as string }
        })
        .sort((a, b) => a.seq - b.seq),
      label: label ? { code: label.code, name: label.name, revision: label.revision, languages: [...label.languages] } : null,
      operations: operations.map((row) => ({ ...row, current: row.id === state.operation.id })),
    }
  })
}
