import { newId } from '@nexus/factory-domain/core/ids'
import { circleProblem, subAssemblyCircle, subAssemblyProblems } from '@nexus/factory-domain/product/bom-structure/rules'
import type { CommandTools } from '../../../core/command'
import { lockSubAssemblyLinks, readEdges, readStructure, readStyleCodes, readTargets } from './store'

/**
 * B-W2b-211's columns travel with a copy of the BOM (B-W2b-223): a frozen revision copied into the next draft (W1's
 * product/bom revisions.ts copyRevision) and a style duplicated with its BOM (product/styles duplicate.ts) carry, AFTER W1
 * has written the lines (`lines` maps each source line to its copy, by place), each line's section, group row (remapped to
 * the copy's lines), sub-assembly, customer, workshop kit, rule, option value and made-to-measure point, the lines'
 * alternates and the revision's output. W1's copies wrote none of them.
 *
 * What is no longer true is not written (the database would refuse it written anew) and is answered for the caller's audit
 * row: a group row not copied (the line is ungrouped); a sub-assembly revision made obsolete since (the style's released
 * revision is taken instead, else none), or one the line can no longer take (its material, the company, a circle); a
 * customer that is no longer a customer or a brand; an option the style no longer offers (or archived); a made-to-measure
 * point of another template; an alternate that is now a blocked material. A duplicate first takes the source style's
 * active option offers (`copyOffersInCommand`, before the routing and the BOM name their values).
 */

export interface StructureCopy {
  /** Lines whose structure was written. */
  readonly lines: number
  readonly output: { readonly outputQuantity: number; readonly outputUom: string } | null
  readonly ungrouped: readonly number[]
  readonly subAssembliesMoved: readonly { readonly seq: number; readonly code: string; readonly from: number; readonly to: number }[]
  readonly subAssembliesCleared: readonly { readonly seq: number; readonly code: string; readonly reason: string }[]
  readonly customersCleared: readonly number[]
  readonly optionsCleared: readonly number[]
  readonly madeToMeasureCleared: readonly number[]
  readonly alternates: number
  readonly alternatesLeftOut: readonly { readonly seq: number; readonly priority: number; readonly code: string }[]
}

/** True when nothing of B-W2b-211's was carried or dropped (the audit row then names nothing). */
export const emptyCopy = (copy: StructureCopy): boolean =>
  copy.lines === 0 &&
  copy.output === null &&
  copy.alternates === 0 &&
  [copy.ungrouped, copy.subAssembliesMoved, copy.subAssembliesCleared, copy.customersCleared, copy.optionsCleared, copy.madeToMeasureCleared, copy.alternatesLeftOut].every((list) => list.length === 0)

export async function copyStructureInCommand(
  tools: CommandTools,
  from: { readonly revisionId: string },
  to: { readonly styleId: string; readonly revisionId: string },
  lines: ReadonlyMap<string, string>,
): Promise<StructureCopy> {
  const { tx, now } = tools
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  const source = await readStructure(tx, from.revisionId)
  const output = await tx.styleRevision.findUniqueOrThrow({ where: { id: from.revisionId }, select: { outputQuantity: true, outputUom: true } })
  const keepOutput = output.outputQuantity !== 1 || output.outputUom !== 'PCS'
  if (keepOutput) await tx.styleRevision.update({ where: { id: to.revisionId }, data: { outputQuantity: output.outputQuantity, outputUom: output.outputUom }, select: { id: true } })

  const copy = {
    lines: 0,
    output: keepOutput ? { outputQuantity: output.outputQuantity, outputUom: output.outputUom } : null,
    ungrouped: [] as number[],
    subAssembliesMoved: [] as { seq: number; code: string; from: number; to: number }[],
    subAssembliesCleared: [] as { seq: number; code: string; reason: string }[],
    customersCleared: [] as number[],
    optionsCleared: [] as number[],
    madeToMeasureCleared: [] as number[],
    alternates: 0,
    alternatesLeftOut: [] as { seq: number; priority: number; code: string }[],
  }
  const copied = source.filter((line) => lines.has(line.id))
  const structured = copied.filter(
    (line) =>
      line.section !== null ||
      line.parentLineId !== null ||
      line.subAssemblyRevisionId !== null ||
      line.customerSuppliedByPartyId !== null ||
      line.issueToSubcontract ||
      line.sourceKey !== null ||
      line.optionValueId !== null ||
      line.mtmScalePointId !== null,
  )
  const alternates = await tx.bomLineAlternate.findMany({
    where: { revisionId: from.revisionId, bomLineId: { in: copied.map((line) => line.id) } },
    select: { bomLineId: true, priority: true, itemId: true, itemColourId: true, qty: true, allowedWhen: true, certificateCheck: true, note: true },
    orderBy: [{ bomLineId: 'asc' }, { priority: 'asc' }],
  })
  if (structured.length === 0 && alternates.length === 0) return copy

  const style = await tx.style.findUniqueOrThrow({ where: { id: to.styleId }, select: { id: true, companyId: true, measurementTemplateId: true } })
  // What the lines name, as it is now.
  const targets = await readTargets(tx, structured.flatMap((line) => (line.subAssemblyRevisionId ? [line.subAssemblyRevisionId] : [])), true)
  const itemIds = [...new Set([...copied.map((line) => line.itemId), ...alternates.map((alternate) => alternate.itemId)])]
  const items = new Map((await tx.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, kind: true, sourcing: true, approval: true } })).map((item) => [item.id, item]))
  const partyIds = [...new Set(structured.flatMap((line) => (line.customerSuppliedByPartyId ? [line.customerSuppliedByPartyId] : [])))]
  const customers = new Set(partyIds.length === 0 ? [] : (await tx.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, roles: true } })).filter((party) => party.roles.includes('CUSTOMER') || party.roles.includes('BRAND')).map((party) => party.id))
  const valueIds = [...new Set(structured.flatMap((line) => (line.optionValueId ? [line.optionValueId] : [])))]
  const values = valueIds.length === 0 ? [] : await tx.optionValue.findMany({ where: { id: { in: valueIds } }, select: { id: true, groupId: true, status: true } })
  const offered = new Set(valueIds.length === 0 ? [] : (await tx.styleOptionGroup.findMany({ where: { styleId: to.styleId, status: 'ACTIVE' }, select: { groupId: true } })).map((offer) => offer.groupId))
  const usableValues = new Set(values.filter((value) => value.status === 'ACTIVE' && offered.has(value.groupId)).map((value) => value.id))
  const pointIds = [...new Set(structured.flatMap((line) => (line.mtmScalePointId ? [line.mtmScalePointId] : [])))]
  const pointsOfTemplate = new Set(pointIds.length === 0 ? [] : (await tx.measurementPoint.findMany({ where: { id: { in: pointIds } }, select: { id: true, templateId: true } })).filter((point) => point.templateId === style.measurementTemplateId).map((point) => point.id))

  let linksLocked = false
  for (const line of structured) {
    const copyId = lines.get(line.id)!
    let subAssemblyStyleId: string | null = null
    let subAssemblyRevisionId: string | null = null
    if (line.subAssemblyRevisionId !== null) {
      let target = targets.get(line.subAssemblyRevisionId)
      const code = target?.code ?? '?'
      if (target && target.status === 'OBSOLETE') {
        const released = await tx.styleRevision.findFirst({ where: { styleId: target.styleId, status: 'RELEASED' }, select: { id: true } })
        const moved = released ? (await readTargets(tx, [released.id], true)).get(released.id) : undefined
        if (moved) copy.subAssembliesMoved.push({ seq: line.seq, code, from: target.revision, to: moved.revision })
        target = moved
      }
      const item = items.get(line.itemId)
      const reason = !target
        ? 'its revision is obsolete and the style has no released revision'
        : target.companyId !== null && target.companyId !== style.companyId
          ? "it belongs to another company than the style's"
          : !item || item.kind === 'FINISHED'
            ? 'its material cannot be read'
            : (subAssemblyProblems({ seq: line.seq, styleId: to.styleId, uom: line.uom, customerSupplied: line.customerSuppliedByPartyId !== null && customers.has(line.customerSuppliedByPartyId), material: { code: item.code, kind: item.kind, sourcing: item.sourcing } }, target)[0]?.message ?? null)
      let circle: string | null = null
      if (reason === null && target) {
        if (!linksLocked) await lockSubAssemblyLinks(tx)
        linksLocked = true
        const verdict = subAssemblyCircle({ revisionId: to.revisionId, styleId: to.styleId }, { revisionId: target.revisionId, styleId: target.styleId }, await readEdges(tx))
        const codes = await readStyleCodes(tx, verdict.circleStyleId === null ? [] : [verdict.circleStyleId])
        circle = circleProblem(line.seq, target, verdict, (styleId) => codes.get(styleId) ?? '?')
      }
      if (reason === null && circle === null && target) {
        subAssemblyStyleId = target.styleId
        subAssemblyRevisionId = target.revisionId
      } else {
        copy.subAssembliesCleared.push({ seq: line.seq, code, reason: circle ?? reason ?? 'it cannot be taken' })
      }
    }
    const parentLineId = line.parentLineId === null ? null : (lines.get(line.parentLineId) ?? null)
    if (line.parentLineId !== null && parentLineId === null) copy.ungrouped.push(line.seq)
    const customer = line.customerSuppliedByPartyId !== null && customers.has(line.customerSuppliedByPartyId) && subAssemblyRevisionId === null ? line.customerSuppliedByPartyId : null
    if (line.customerSuppliedByPartyId !== null && customer === null) copy.customersCleared.push(line.seq)
    const optionValueId = line.optionValueId !== null && usableValues.has(line.optionValueId) ? line.optionValueId : null
    if (line.optionValueId !== null && optionValueId === null) copy.optionsCleared.push(line.seq)
    const mtm = line.mtmScalePointId !== null && pointsOfTemplate.has(line.mtmScalePointId)
    if (line.mtmScalePointId !== null && !mtm) copy.madeToMeasureCleared.push(line.seq)
    await tx.bomLine.update({
      where: { id: copyId },
      data: {
        section: line.section,
        parentLineId,
        subAssemblyStyleId,
        subAssemblyRevisionId,
        customerSuppliedByPartyId: customer,
        // The customer sends it: the copy names no supplier (W1 copied the source's, which had none).
        ...(customer !== null ? { supplierId: null } : {}),
        issueToSubcontract: line.issueToSubcontract,
        sourceKey: line.sourceKey,
        optionValueId,
        mtmScalePointId: mtm ? line.mtmScalePointId : null,
        mtmScaleFactor: mtm ? line.mtmScaleFactor : null,
        updatedAt: now,
      },
      select: { id: true },
    })
    copy.lines += 1
  }

  const seqOf = new Map(source.map((line) => [line.id, line.seq]))
  const kept = alternates.filter((alternate) => {
    const item = items.get(alternate.itemId)
    if (item && item.approval !== 'BLOCKED') return true
    copy.alternatesLeftOut.push({ seq: seqOf.get(alternate.bomLineId) ?? 0, priority: alternate.priority, code: item?.code ?? '?' })
    return false
  })
  if (kept.length > 0) {
    await tx.bomLineAlternate.createMany({
      data: kept.map((alternate) => ({ ...alternate, id: newId(), revisionId: to.revisionId, bomLineId: lines.get(alternate.bomLineId)!, createdAt: now, updatedAt: now, createdById })),
    })
  }
  copy.alternates = kept.length
  return copy
}

/**
 * A duplicated style takes its source's ACTIVE option offers (B-W2b-211's StyleOptionGroup) whose group is still ACTIVE, the
 * default value kept while ACTIVE, BEFORE its routing and BOM are copied: their lines and steps name the values of offered
 * groups only. Answers how many were copied.
 */
export async function copyOffersInCommand(tools: CommandTools, fromStyleId: string, toStyleId: string): Promise<number> {
  const { tx, now } = tools
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  const offers = await tx.styleOptionGroup.findMany({
    where: { styleId: fromStyleId, status: 'ACTIVE' },
    select: { groupId: true, seq: true, minPicks: true, maxPicks: true, defaultValueId: true },
    orderBy: [{ seq: 'asc' }, { groupId: 'asc' }],
  })
  if (offers.length === 0) return 0
  const groups = new Set((await tx.optionGroup.findMany({ where: { id: { in: offers.map((offer) => offer.groupId) }, status: 'ACTIVE' }, select: { id: true } })).map((group) => group.id))
  const defaults = offers.flatMap((offer) => (offer.defaultValueId ? [offer.defaultValueId] : []))
  const activeValues = new Set(defaults.length === 0 ? [] : (await tx.optionValue.findMany({ where: { id: { in: defaults }, status: 'ACTIVE' }, select: { id: true } })).map((value) => value.id))
  const kept = offers.filter((offer) => groups.has(offer.groupId))
  if (kept.length === 0) return 0
  await tx.styleOptionGroup.createMany({
    data: kept.map((offer) => ({
      ...offer,
      id: newId(),
      styleId: toStyleId,
      defaultValueId: offer.defaultValueId !== null && activeValues.has(offer.defaultValueId) ? offer.defaultValueId : null,
      createdAt: now,
      updatedAt: now,
      createdById,
    })),
  })
  return kept.length
}
