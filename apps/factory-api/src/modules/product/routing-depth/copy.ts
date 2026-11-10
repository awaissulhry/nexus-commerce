import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { CommandTools } from '../../../core/command'
// B-W2b-229: a copied step keeps only the options the target style still offers.
import { offeredValuesOf } from '../options/offers'
import { readSettings, settingDataOf } from './store'

/**
 * A routing's depth travels with its steps (B-W2b-225; the lead's 11-09 note, B-W2b-205's and -215's "what the next steps
 * must know"): W1's copies (a released revision into the next DRAFT, bom/revisions.ts copyRevision; a released routing's
 * steps into a draft, routing/steps.ts copyRoutingSteps) insert the W1 columns, then call `copyStepDepthInCommand` with
 * each copied step's source and new id. It carries, per step:
 *
 *   minutes      the basic minutes and allowances, and the APPROVED SMV version the step copied (B-W2b-215): kept as is
 *                while that version is still APPROVED; a version since SUPERSEDED is no longer named (the database names
 *                only an APPROVED one), the numbers stay (the step's SMV is the source's): "Use library value" re-copies.
 *   side times   set-up, wait and move minutes; the extra minutes per size, for sizes of the target style's range.
 *   cells        the sizes (of the target's range) and colourways (of the same style only) it is for; a list that loses
 *                every value leaves the step for every cell, said in the audit row (`widened`). Option values: those
 *                the target style still offers active (B-W2b-229; the database names no other), likewise widened.
 *   checkpoint   the plan, when it is of the target style's company (or the style is every company's).
 *   settings     the step's machine and stitch settings, all of them.
 *
 * Inside the copying command, after the steps are inserted (the new revision is a DRAFT: its parts may still be written).
 * Answers what it carried and what it could not, for the copy's audit row.
 */

const SOURCE_COLUMNS = {
  id: true,
  styleId: true,
  basicMinutes: true,
  personalPct: true,
  fatiguePct: true,
  delayPct: true,
  timeVersionId: true,
  setupMinutes: true,
  waitMinutes: true,
  moveMinutes: true,
  appliesToSizes: true,
  appliesToColourwayIds: true,
  appliesToOptionValueIds: true,
  inspectionPlanId: true,
} as const satisfies Prisma.RoutingOperationSelect

export interface DepthCopy {
  readonly steps: number
  readonly sizeTimes: number
  readonly settings: number
  readonly checkpoints: number
  /** Steps whose SMV version is no longer APPROVED: the numbers stay, the version is not named. */
  readonly versionsDropped: number
  /** Steps whose cells were all outside the target (another style's colourways, sizes out of its range): now for every cell. */
  readonly widened: readonly string[]
  /** Steps whose checkpoint plan is another company's than the target style's: none now. */
  readonly checkpointsDropped: readonly string[]
}

export async function copyStepDepthInCommand(tools: CommandTools, target: { readonly styleId: string; readonly revisionId: string }, pairs: readonly { readonly from: string; readonly to: string }[]): Promise<DepthCopy> {
  const { tx, now } = tools
  const none: DepthCopy = { steps: 0, sizeTimes: 0, settings: 0, checkpoints: 0, versionsDropped: 0, widened: [], checkpointsDropped: [] }
  if (pairs.length === 0) return none
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  const sources = new Map((await tx.routingOperation.findMany({ where: { id: { in: pairs.map((pair) => pair.from) } }, select: SOURCE_COLUMNS })).map((row) => [row.id, row]))
  const style = await tx.style.findUniqueOrThrow({ where: { id: target.styleId }, select: { sizes: true, companyId: true } })
  const colourways = new Set((await tx.colourway.findMany({ where: { styleId: target.styleId }, select: { id: true } })).map((row) => row.id))
  const offered = new Set([...sources.values()].some((row) => row.appliesToOptionValueIds.length > 0) ? (await offeredValuesOf(tx, target.styleId)).map((value) => value.id) : [])
  const versionIds = [...new Set([...sources.values()].flatMap((row) => (row.timeVersionId ? [row.timeVersionId] : [])))]
  const approved = new Set(versionIds.length === 0 ? [] : (await tx.operationTimeVersion.findMany({ where: { id: { in: versionIds }, status: 'APPROVED' }, select: { id: true } })).map((row) => row.id))
  const planIds = [...new Set([...sources.values()].flatMap((row) => (row.inspectionPlanId ? [row.inspectionPlanId] : [])))]
  const planCompany = new Map(planIds.length === 0 ? [] : (await tx.inspectionPlan.findMany({ where: { id: { in: planIds } }, select: { id: true, companyId: true } })).map((row) => [row.id, row.companyId]))

  let steps = 0
  let checkpoints = 0
  let versionsDropped = 0
  const widened: string[] = []
  const checkpointsDropped: string[] = []
  for (const pair of pairs) {
    const source = sources.get(pair.from)
    if (!source) continue
    const data: Prisma.RoutingOperationUncheckedUpdateInput = {}
    if (source.basicMinutes !== null) {
      Object.assign(data, { basicMinutes: source.basicMinutes, personalPct: source.personalPct, fatiguePct: source.fatiguePct, delayPct: source.delayPct })
      if (source.timeVersionId !== null) {
        if (approved.has(source.timeVersionId)) data.timeVersionId = source.timeVersionId
        else versionsDropped++
      }
    }
    if (source.setupMinutes !== null) data.setupMinutes = source.setupMinutes
    if (source.waitMinutes !== null) data.waitMinutes = source.waitMinutes
    if (source.moveMinutes !== null) data.moveMinutes = source.moveMinutes
    const sameStyle = source.styleId === target.styleId
    const sizes = source.appliesToSizes.filter((size) => style.sizes.includes(size))
    const cws = sameStyle ? source.appliesToColourwayIds.filter((id) => colourways.has(id)) : []
    const options = source.appliesToOptionValueIds.filter((id) => offered.has(id))
    if ((source.appliesToSizes.length > 0 && sizes.length === 0) || (source.appliesToColourwayIds.length > 0 && cws.length === 0) || (source.appliesToOptionValueIds.length > 0 && options.length === 0)) widened.push(pair.to)
    if (sizes.length > 0) data.appliesToSizes = sizes
    if (cws.length > 0) data.appliesToColourwayIds = cws
    if (options.length > 0) data.appliesToOptionValueIds = options
    if (source.inspectionPlanId !== null) {
      const company = planCompany.get(source.inspectionPlanId)
      if (company !== undefined && (style.companyId === null || company === style.companyId)) {
        data.inspectionPlanId = source.inspectionPlanId
        checkpoints++
      } else checkpointsDropped.push(pair.to)
    }
    if (Object.keys(data).length === 0) continue
    await tx.routingOperation.update({ where: { id: pair.to }, data: { ...data, updatedAt: now }, select: { id: true } })
    steps++
  }

  const toOf = new Map(pairs.map((pair) => [pair.from, pair.to]))
  const times = await tx.routingOperationSizeTime.findMany({ where: { routingOperationId: { in: pairs.map((pair) => pair.from) } }, select: { routingOperationId: true, size: true, extraMinutes: true }, orderBy: [{ routingOperationId: 'asc' }, { size: 'asc' }] })
  const keptTimes = times.filter((row) => style.sizes.includes(row.size))
  if (keptTimes.length > 0) {
    await tx.routingOperationSizeTime.createMany({
      data: keptTimes.map((row) => ({ id: newId(), revisionId: target.revisionId, routingOperationId: toOf.get(row.routingOperationId)!, size: row.size, extraMinutes: row.extraMinutes, createdAt: now, updatedAt: now, createdById })),
    })
  }
  const settings = await readSettings(tx, 'step', pairs.map((pair) => pair.from))
  const rows = [...settings.entries()].flatMap(([from, list]) => list.map((row) => ({ to: toOf.get(from)!, data: settingDataOf(row) })))
  if (rows.length > 0) {
    await tx.operationMachineSetting.createMany({
      data: rows.map((row) => ({ id: newId(), revisionId: target.revisionId, routingOperationId: row.to, ...row.data, createdAt: now, updatedAt: now, createdById })),
    })
  }
  return { steps, sizeTimes: keptTimes.length, settings: rows.length, checkpoints, versionsDropped, widened, checkpointsDropped }
}

/** The copy as the audit row keeps it (only what is not empty). */
export function auditedDepthCopy(copy: DepthCopy): Record<string, unknown> | undefined {
  if (copy.steps === 0 && copy.sizeTimes === 0 && copy.settings === 0 && copy.widened.length === 0 && copy.checkpointsDropped.length === 0) return undefined
  return { ...copy, widened: [...copy.widened], checkpointsDropped: [...copy.checkpointsDropped] }
}
