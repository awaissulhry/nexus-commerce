import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { compareSpec, type SpecSnapshot } from '@nexus/factory-domain/production/work-orders/compare'
import { certificateCheck } from '@nexus/factory-domain/production/work-orders/release'
import type { BomLineData } from '@nexus/factory-domain/product/bom/rules'
import type { StepData } from '@nexus/factory-domain/product/routing/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller } from '../../../core/command'
import { readMaterials, readLines } from '../../product/bom/store'
import { readSteps } from '../../product/routing/read'
import { readBasics, readGates } from './facts'
import { readLabel, readReleasedRevision, type Reader, type RevisionRow } from './store'
import { officeWorkOrder, todayNow } from './work-orders'

/**
 * The frozen specification against today's master (B-W1-38; MES-005; design 02 "Frozen spec" › "Compare with the
 * current master", the Spec differences modal): the work order's revision against the style's RELEASED revision now —
 * BOM, routing and garment label template (factory-domain production/work-orders/compare) — and the certificate gate
 * today for each cell. A read: nothing changes (a different specification is a new work order, or a W2b change request).
 */

async function snapshotOf(db: Reader, revision: RevisionRow): Promise<SpecSnapshot> {
  const label = await readLabel(db, revision.labelTemplateId)
  return {
    revision: { id: revision.id, revision: revision.revision, status: revision.status },
    label: label ? { id: label.id, code: label.code, revision: label.revision, status: label.status } : null,
    bom: {
      plannedHideYieldPct: revision.plannedHideYieldPct === null ? null : decimalText(revision.plannedHideYieldPct.toString()),
      labelTemplateId: revision.labelTemplateId,
      lines: await readLines(db, revision.id),
    },
    steps: await readSteps(db, revision.id),
  }
}

export async function compareWithMaster(caller: CommandCaller, workOrderId: string) {
  const workOrder = await officeWorkOrder(caller, workOrderId)
  return caller.withClient(async (client) => {
    const basics = await readBasics(client, workOrder)
    if (!basics.revision) throw new InvalidStateError(`Work order ${workOrder.number} has no revision chosen yet: there is no specification to compare.`)
    const frozen = await snapshotOf(client, basics.revision)
    const released = await readReleasedRevision(client, workOrder.styleId)
    const master = released ? await snapshotOf(client, released) : null
    const diff = compareSpec(frozen, master)
    const { materials } = await readMaterials(client, [...frozen.bom.lines, ...(master?.bom.lines ?? [])].map((line) => line.itemId))
    const lineRef = (line: BomLineData) => ({ lineId: line.id, seq: line.seq, itemId: line.itemId, code: materials.get(line.itemId)?.code ?? '', placement: line.placement, colourwayId: line.colourwayId })
    const stepRef = (step: StepData) => ({ stepId: step.id, seq: step.seq, code: step.code, name: step.name, standardMinutes: step.standardMinutes })
    const gates = await readGates(client, workOrder.styleId, basics.cells, todayNow())
    return {
      workOrderId: workOrder.id,
      number: workOrder.number,
      frozen: workOrder.status !== 'DRAFT',
      revision: frozen.revision,
      label: frozen.label,
      master: master ? { revision: master.revision, label: master.label } : null,
      sameRevision: diff.sameRevision,
      noMaster: diff.noMaster,
      summary: [...diff.summary],
      bom: diff.bom
        ? {
            revision: [...diff.bom.revision],
            added: diff.bom.added.map(lineRef),
            removed: diff.bom.removed.map(lineRef),
            changed: diff.bom.changed.map((change) => ({ from: lineRef(change.from), to: lineRef(change.to), fields: [...change.fields], sizes: [...change.sizes], colours: [...change.colours] })),
            unchanged: diff.bom.unchanged,
          }
        : null,
      routing: diff.routing
        ? {
            added: diff.routing.added.map(stepRef),
            removed: diff.routing.removed.map(stepRef),
            changed: diff.routing.changed.map((change) => ({ from: stepRef(change.from), to: stepRef(change.to), fields: [...change.fields] })),
            unchanged: diff.routing.unchanged,
            minutes: { ...diff.routing.minutes },
          }
        : null,
      labelChanged: diff.label.changed,
      certificate: (() => {
        const check = certificateCheck(gates)
        return { state: check.state, message: check.message, problems: [...check.problems] }
      })(),
    }
  })
}
