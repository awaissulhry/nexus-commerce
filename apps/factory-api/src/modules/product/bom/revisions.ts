import { ConflictError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { BomDiffView, BomView, CompareQuery, CopyRevisionBody, ObsoleteBody, ReleaseBody } from '@nexus/factory-domain/product/bom/contracts'
import { copyLines } from '@nexus/factory-domain/product/bom/copy'
import { diffBoms } from '@nexus/factory-domain/product/bom/diff'
import { PRODUCT_BOM_MANAGE, PRODUCT_BOM_RELEASE } from '@nexus/factory-domain/product/bom/permissions'
import { obsoleteRefusal, releaseRefusal, type BomLineData } from '@nexus/factory-domain/product/bom/rules'
import { newRevisionRefusal, nextRevisionNumber, styleRevisionMachine } from '@nexus/factory-domain/product/styles/revisions'
import { styleMachine } from '@nexus/factory-domain/product/styles/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { command, type CommandCaller } from '../../../core/command'
import { readOperations, readSteps } from '../routing/read'
import { openTypeChangeReviewsInCommand } from '../../compliance/type-changes/detect'
import { requireEditRule } from '../lifecycle/edit-rule'
import { copyPiecesInCommand, lineMapBySeq } from '../pieces/copy'
// B-W2b-225: the routing's depth travels with its steps; the release closes the old revision's effective days.
import { auditedDepthCopy, copyStepDepthInCommand } from '../routing-depth/copy'
import { effectivityAtReleaseInCommand, effectivityAtWithdrawalInCommand } from '../routing-depth/effectivity'
// B-W2b-223: B-W2b-211's columns travel with the copy; the release reads the BOM check's structure blockers.
import { assertStructureReleasable, structureBlockersInCommand } from '../bom-structure/check'
import { copyStructureInCommand, emptyCopy } from '../bom-structure/copy'
// B-W2b-224: the measurement spec and the protector placement travel with a copied revision.
import { copyMeasuresInCommand, emptyMeasuresCopy } from '../measures/copy'
// B-W2b-226: a change order starts its draft revision with the copy and is released with the draft.
import { changeOrderAtReleaseInCommand, linkDraftInCommand, releaseChangeOrderInCommand, type DraftFor } from '../changes/hooks'
import {
  assertMayWrite,
  bomStyleOf,
  bomViewInTx,
  bumpRevision,
  contextOf,
  findRevision,
  isUniqueViolation,
  lockMaterials,
  lockStyleRow,
  readColourways,
  readLines,
  readMaterials,
  readRevisionFor,
  readStyleFor,
  releaseBlocked,
  releaseCheck,
} from './store'

/**
 * A style's revisions beyond their DRAFT shell (plan A1 §2.5; features PRD-076, PRD-100): a frozen revision copied into
 * the next DRAFT, two revisions compared, a draft released, and a revision made obsolete. Each write locks the style row
 * first and then compares and sets the revision's version.
 *
 * Release: ./store `releaseCheck` (the same check the BOM view's `issues` and `releasable` show) finds no blocker in the
 * draft's BOM nor in its routing (at least one step, minutes above 0, a scanned step), because a work order is released
 * with one operation per routing step and the floor reports at the scanned ones: a released revision without a routing
 * would be a dead end. Every blocker of both is refused at once (409); warnings pass. The style's RELEASED revision
 * becomes OBSOLETE first, then this one RELEASED (the partial unique index allows one RELEASED revision per style,
 * checked row by row), and a DRAFT style becomes ACTIVE (it can now be sold). From then on the database refuses any
 * change to its parts, for every login.
 */

/**
 * product.bom.copyRevision: a RELEASED (or OBSOLETE) revision's BOM, routing, pattern pieces (B-W2b-95), planned yield and label into the next DRAFT.
 * B-W2b-226: `changeOrder` (its own "Start the draft revision" only) lets it through the CHANGE_ORDER edit rule and names the draft its proposed revision.
 */
export async function copyRevision(caller: CommandCaller, styleId: string, sourceId: string, body: CopyRevisionBody, idempotencyKey?: string, changeOrder?: DraftFor): Promise<BomView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, sourceId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)

  const { result } = await command(caller, { name: 'product.bom.copyRevision', idempotencyKey, input: { styleId, sourceId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const locked = await lockStyleRow(tx, styleId)
    const source = await findRevision(tx, styleId, sourceId)
    if (source.status === 'DRAFT') throw new InvalidStateError(`Revision ${source.revision} is a draft: change it in place; only a frozen revision is copied.`)
    const revisions = await tx.styleRevision.findMany({ where: { styleId }, select: { revision: true, status: true } })
    const refusal = newRevisionRefusal(locked.status, revisions)
    if (refusal) throw new ConflictError(refusal)
    // B-W2b-221: a new revision under the edit rule of the style's lifecycle state.
    await requireEditRule(tx, styleId, 'NEW_REVISION', changeOrder?.number)
    const id = newId()
    const revision = nextRevisionNumber(revisions)
    const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
    await tx.styleRevision.create({
      data: {
        id,
        styleId,
        revision,
        status: 'DRAFT',
        changeNote: body.changeNote ?? null,
        plannedHideYieldPct: source.plannedHideYieldPct,
        labelTemplateId: source.labelTemplateId,
        createdAt: now,
        updatedAt: now,
        createdById,
      },
      select: { id: true },
    })

    const stamp = { createdAt: now, updatedAt: now, createdById }
    // The routing (B-W1-14) travels with the revision: its steps are copied as they are, a subcontracted step (W2a,
    // PRD-120) with its workshop, fee per piece and transit days (office columns: the floor never reads the fee), and
    // (B-W2b-88) its parallel group. BEFORE the BOM: a line names its step by place (BomLine.routingSeq's key).
    const routing = await tx.routingOperation.findMany({
      where: { revisionId: sourceId },
      select: {
        id: true,
        seq: true,
        operationId: true,
        code: true,
        name: true,
        nameI18n: true,
        workCentreKind: true,
        standardMinutes: true,
        scanRequired: true,
        instructions: true,
        parallelGroup: true,
        supplierId: true,
        pricePerPiece: true,
        transitDays: true,
      },
      orderBy: { seq: 'asc' },
    })
    // B-W2b-225: each copy's new id, so its depth (minutes, cells, checkpoint, size times, settings) follows it.
    const stepCopies = routing.map((step) => ({ from: step.id, to: newId() }))
    if (routing.length > 0) {
      await tx.routingOperation.createMany({
        data: routing.map((step, index) => ({ ...step, id: stepCopies[index]!.to, styleId, revisionId: id, nameI18n: step.nameI18n ?? undefined, ...stamp })),
      })
    }
    const depth = await copyStepDepthInCommand(tools, { styleId, revisionId: id }, stepCopies)

    const sourceLines = await readLines(tx, sourceId)
    const lines = copyLines(sourceLines, newId)
    if (lines.length > 0) {
      await tx.bomLine.createMany({
        data: lines.map((line) => ({
          id: line.id,
          styleId,
          revisionId: id,
          seq: line.seq,
          itemId: line.itemId,
          placement: line.placement,
          qty: line.qty,
          uom: line.uom,
          wastagePct: line.wastagePct,
          // A line keeps only the parts its dependence uses (an older revision may hold others).
          sizeDependent: line.sizeDependent,
          colourDependent: line.colourDependent,
          itemColourId: line.itemColourId,
          colourwayId: line.colourwayId,
          supplierId: line.supplierId,
          note: line.note,
          // B-W2b-88: the step that uses it, by place: the copied routing keeps every place.
          routingSeq: line.routingSeq ?? null,
          ...stamp,
        })),
      })
      const sizes = lines.flatMap((line) => (line.sizeDependent ? line.sizes.map((row) => ({ id: newId(), revisionId: id, bomLineId: line.id, size: row.size, qty: row.qty, ...stamp })) : []))
      if (sizes.length > 0) await tx.bomLineSize.createMany({ data: sizes })
      const cells = lines.flatMap((line) =>
        line.colourDependent
          ? line.colours.map((cell) => ({ id: newId(), styleId, revisionId: id, bomLineId: line.id, itemId: line.itemId, colourwayId: cell.colourwayId, itemColourId: cell.itemColourId, ...stamp }))
          : [],
      )
      if (cells.length > 0) await tx.bomLineColour.createMany({ data: cells })
    }

    // B-W2b-223: each line's section, group row, sub-assembly, customer, kit, rule, option and made-to-measure point, the
    // alternates and the output (what is no longer true is left out and said in its own audit row).
    const structure = await copyStructureInCommand(tools, { revisionId: sourceId }, { styleId, revisionId: id }, lineMapBySeq(sourceLines, lines))
    if (!emptyCopy(structure)) tools.audit({ recordType: 'StyleRevision', recordId: id, companyId: locked.companyId, after: { styleId, structure } })
    // B-W2b-95: the pattern pieces travel with the BOM, AFTER it (a piece names its line); the range is the style's now.
    const pieces = await copyPiecesInCommand(tools, { revisionId: sourceId }, { styleId, revisionId: id }, lineMapBySeq(sourceLines, lines), (await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { sizes: true } })).sizes)
    // B-W2b-224: the spec (a DRAFT again, cells of the range now) and the protector placement, after the BOM.
    const range = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { sizes: true, sizeScaleId: true } })
    const measures = await copyMeasuresInCommand(tools, { revisionId: sourceId }, { styleId, revisionId: id }, range.sizes, range.sizeScaleId)
    if (!emptyMeasuresCopy(measures)) tools.audit({ recordType: 'StyleRevision', recordId: id, companyId: locked.companyId, after: { styleId, measures } })
    const copied = { revision, status: 'DRAFT', copiedFrom: { id: sourceId, revision: source.revision }, lines: lines.length, routingSteps: routing.length, pieces, changeNote: body.changeNote ?? null, ...(auditedDepthCopy(depth) ? { routingDepth: auditedDepthCopy(depth) } : {}) }
    tools.audit({ recordType: 'StyleRevision', recordId: id, companyId: locked.companyId, after: { styleId, ...copied } })
    tools.audit({ recordType: 'Style', recordId: styleId, companyId: locked.companyId, after: { revision: { id, revision, status: 'DRAFT', copiedFrom: source.revision } } })
    if (changeOrder) await linkDraftInCommand(tools, changeOrder, { styleId, revisionId: id, revision })
    tools.emit({ type: 'style.revision_created', subject: styleId, companyId: locked.companyId, payload: { styleId, code: locked.code, revisionId: id, revision } })
    return bomViewInTx(tx, styleId, id)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('Another revision was started at the same time: load the style again.')
    throw error
  })
  return result
}

/** What changed from one revision's BOM to another's (both of this style). */
export async function compareRevisions(caller: CommandCaller, styleId: string, query: CompareQuery): Promise<BomDiffView> {
  const style = await readStyleFor(caller, styleId)
  return caller.withClient(async (client) => {
    const from = await findRevision(client, styleId, query.from)
    const to = await findRevision(client, styleId, query.to)
    const order = { sizes: style.sizes, colourwayIds: (await readColourways(client, styleId)).map((colourway) => colourway.id) }
    const fromLines = await readLines(client, from.id, order)
    const toLines = await readLines(client, to.id, order)
    const { materials } = await readMaterials(client, [...fromLines, ...toLines].map((line) => line.itemId))
    const yieldOf = (value: { toString(): string } | null) => (value === null ? null : decimalText(value.toString()))
    const diff = diffBoms(
      { plannedHideYieldPct: yieldOf(from.plannedHideYieldPct), labelTemplateId: from.labelTemplateId, lines: fromLines },
      { plannedHideYieldPct: yieldOf(to.plannedHideYieldPct), labelTemplateId: to.labelTemplateId, lines: toLines },
    )
    const ref = (line: BomLineData) => ({ lineId: line.id, seq: line.seq, itemId: line.itemId, code: materials.get(line.itemId)?.code ?? '', placement: line.placement, colourwayId: line.colourwayId })
    const revisionRef = (row: typeof from) => ({ id: row.id, revision: row.revision, status: row.status })
    return {
      from: revisionRef(from),
      to: revisionRef(to),
      revision: [...diff.revision],
      added: diff.added.map(ref),
      removed: diff.removed.map(ref),
      changed: diff.changed.map((change) => ({ from: ref(change.from), to: ref(change.to), fields: [...change.fields], sizes: [...change.sizes], colours: [...change.colours] })),
      unchanged: diff.unchanged,
    }
  })
}

/**
 * product.bom.release: the draft becomes the style's current revision (A1 §2.5). Refused while its BOM has a blocker
 * (409 with every blocker as an issue). The previous RELEASED revision becomes OBSOLETE first; a DRAFT style becomes
 * ACTIVE.
 */
export async function releaseRevision(caller: CommandCaller, styleId: string, revisionId: string, body: ReleaseBody, idempotencyKey?: string): Promise<BomView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_RELEASE, style.companyId)

  const { result } = await command(caller, { name: 'product.bom.release', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const locked = await lockStyleRow(tx, styleId)
    const row = await findRevision(tx, styleId, revisionId)
    const refusal = releaseRefusal(row, locked.status)
    if (refusal) throw new InvalidStateError(refusal)
    // B-W2b-221: a release under the edit rule of the style's lifecycle state.
    await requireEditRule(tx, styleId, 'RELEASE')
    const changeOrder = await changeOrderAtReleaseInCommand(tools, { styleId, revisionId })
    assertTransition(styleRevisionMachine, row.status, 'RELEASED')
    const version = await bumpRevision(tx, revisionId, body.version, now)

    // The BOM as it is now, its materials held: none archived or changed between this check and the commit.
    const lines = await readLines(tx, revisionId)
    await lockMaterials(tx, lines.map((line) => line.itemId))
    const { materials } = await readMaterials(tx, lines.map((line) => line.itemId))
    const current = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { sizes: true, baseSize: true } })
    // The routing as it is now (its steps change only under the style row this command holds).
    const steps = await readSteps(tx, revisionId)
    // The same check the BOM view shows (./store releaseCheck): the view never says releasable for a refused release.
    const { blockers } = releaseCheck({
      lines,
      style: bomStyleOf(current, await readColourways(tx, styleId)),
      materials,
      plannedHideYieldPct: row.plannedHideYieldPct === null ? null : decimalText(row.plannedHideYieldPct.toString()),
      steps,
      operations: await readOperations(tx, steps.map((step) => step.operationId)),
    })
    // B-W2b-223 (PRD-087, PRD-106): the BOM check's structure blockers (a draft or obsolete sub-assembly, a blocked material
    // or alternate, a circle, a size or colourway its sub-assembly lacks) refused in words with W1's, before the database.
    assertStructureReleasable(blockers, await structureBlockersInCommand(tools, { styleId, revisionId }))
    if (blockers.length > 0) throw releaseBlocked(blockers)

    const previous = await tx.styleRevision.findFirst({ where: { styleId, status: 'RELEASED' }, select: { id: true, revision: true, version: true } })
    if (previous) {
      // First: one RELEASED revision per style, checked row by row.
      await bumpRevision(tx, previous.id, previous.version, now, { status: 'OBSOLETE' })
      tools.audit({ recordType: 'StyleRevision', recordId: previous.id, companyId: locked.companyId, before: { status: 'RELEASED' }, after: { status: 'OBSOLETE', replacedBy: { id: revisionId, revision: row.revision } } })
    }
    const releasedById = tools.context.audience === 'office' ? tools.context.actorId : null
    await tx.styleRevision.update({
      where: { id: revisionId },
      data: { status: 'RELEASED', releasedAt: now, releasedById, ...(body.changeNote === undefined ? {} : { changeNote: body.changeNote }) },
      select: { id: true },
    })
    // B-W2b-225 (PRD-124): it takes effect today (a draft planned for another day is refused); the old revision's days end.
    const days = await effectivityAtReleaseInCommand(tools, { revisionId, revision: row.revision }, previous?.id ?? null)
    tools.audit({
      recordType: 'StyleRevision',
      recordId: revisionId,
      companyId: locked.companyId,
      before: { status: 'DRAFT', ...(body.changeNote === undefined ? {} : { changeNote: row.changeNote }) },
      after: { status: 'RELEASED', releasedAt: toUtcIso(now), releasedById, version, lines: lines.length, ...(body.changeNote === undefined ? {} : { changeNote: body.changeNote }), ...days },
    })

    let styleStatus: typeof locked.status = locked.status
    if (locked.status === 'DRAFT') {
      assertTransition(styleMachine, 'DRAFT', 'ACTIVE', { releasedRevision: true })
      await tx.style.update({ where: { id: styleId }, data: { status: 'ACTIVE', version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      styleStatus = 'ACTIVE'
      tools.emit({ type: 'style.status_changed', subject: styleId, companyId: locked.companyId, payload: { styleId, code: locked.code, status: 'ACTIVE' } })
    }
    tools.audit({
      recordType: 'Style',
      recordId: styleId,
      companyId: locked.companyId,
      before: { status: locked.status, ...(previous ? { revision: { id: previous.id, revision: previous.revision, status: 'RELEASED' } } : {}) },
      after: { status: styleStatus, revision: { id: revisionId, revision: row.revision, status: 'RELEASED' } },
    })
    // B-W2a-66 (PRD-285, Annex V 7.2): a change to the approved type of a covering certificate opens its review (and holds the class label).
    await openTypeChangeReviewsInCommand(tools, { styleId, revisionId, revision: row.revision, previousRevisionId: previous?.id ?? null, companyId: locked.companyId })
    tools.emit({
      type: 'style.revision_released',
      subject: styleId,
      companyId: locked.companyId,
      payload: { styleId, code: locked.code, revisionId, revision: row.revision, obsoletedRevisionId: previous?.id ?? null },
    })
    if (changeOrder) await releaseChangeOrderInCommand(tools, changeOrder)
    return bomViewInTx(tx, styleId, revisionId)
  })
  return result
}

/**
 * product.bom.obsolete: a draft abandoned (product.bom.manage), or the released revision withdrawn without a replacement
 * (product.bom.release; only while the style is not active).
 */
export async function obsoleteRevision(caller: CommandCaller, styleId: string, revisionId: string, body: ObsoleteBody, idempotencyKey?: string): Promise<BomView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)

  const { result } = await command(caller, { name: 'product.bom.obsolete', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const locked = await lockStyleRow(tx, styleId)
    const row = await findRevision(tx, styleId, revisionId)
    const refusal = obsoleteRefusal(row, locked.status)
    if (refusal) throw new InvalidStateError(refusal)
    if (row.status === 'RELEASED') assertMayWrite(context, PRODUCT_BOM_RELEASE, locked.companyId)
    assertTransition(styleRevisionMachine, row.status, 'OBSOLETE')
    const version = await bumpRevision(tx, revisionId, body.version, now, { status: 'OBSOLETE' })
    // B-W2b-225 (PRD-124): a released revision withdrawn stops applying today.
    const effectiveTo = row.status === 'RELEASED' ? await effectivityAtWithdrawalInCommand(tools, revisionId) : null
    tools.audit({
      recordType: 'StyleRevision',
      recordId: revisionId,
      companyId: locked.companyId,
      before: { status: row.status },
      after: { status: 'OBSOLETE', version, ...(effectiveTo ? { effectiveTo } : {}) },
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    })
    tools.audit({ recordType: 'Style', recordId: styleId, companyId: locked.companyId, after: { revision: { id: revisionId, revision: row.revision, status: 'OBSOLETE', from: row.status } } })
    tools.emit({ type: 'style.revision_obsoleted', subject: styleId, companyId: locked.companyId, payload: { styleId, code: locked.code, revisionId, revision: row.revision, from: row.status } })
    return bomViewInTx(tx, styleId, revisionId)
  })
  return result
}
