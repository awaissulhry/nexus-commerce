import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { LABELS_MANAGE } from '@nexus/factory-domain/compliance/labels/permissions'
import { DomainError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { PRODUCT_BOM_MANAGE, PRODUCT_BOM_VIEW } from '@nexus/factory-domain/product/bom/permissions'
import { PRODUCT_ROUTING_MANAGE, PRODUCT_ROUTING_VIEW } from '@nexus/factory-domain/product/routing/permissions'
import type { DuplicatedView, DuplicateOfferView, DuplicateStyleBody } from '@nexus/factory-domain/product/styles/contracts'
import {
  copiedFields,
  copiedRange,
  copyBomLines,
  copyNote,
  copyRoutingSteps,
  COPY_PARTS,
  needsRevision,
  PART_NOT_YET,
  sourceRevisionOf,
  type CopyablePart,
  type CopyPart,
} from '@nexus/factory-domain/product/styles/copy'
import { generatePlan } from '@nexus/factory-domain/product/styles/matrix'
import { PRODUCT_STYLES_MANAGE } from '@nexus/factory-domain/product/styles/permissions'
import { newStyle, type StyleInput } from '@nexus/factory-domain/product/styles/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { readLines } from '../bom/store'
import { mayWrite } from '../materials/store'
import { readSubcontracts, readSteps } from '../routing/read'
import { insertSteps } from '../routing/store'
import { applyMatrixPlan, emitSkus } from './skus'
import {
  assertMayWrite,
  brandProblems,
  colourProblems,
  COLOURWAY_COLUMNS,
  contextOf,
  fieldsOf,
  findStyleRow,
  invalid,
  isUniqueViolation,
  lockStyle,
  offerOf,
  prefixed,
  readStyle,
  REVISION_COLUMNS,
  revisionViewOf,
  scaleProblems,
  styleViewInTx,
  templateProblems,
  type StyleRowData,
} from './store'
import { codeConflict, codeTaken, columnsOf, readScaleSizes } from './styles'

/**
 * Copy a style (feature PRD-011; design products.styles pop:styles.duplicate; factory-domain product/styles/copy):
 *
 *   GET  /product/styles/:styleId/duplicate   what the Duplicate dialog offers: each part, whether it can be picked and
 *                                             why not, from which revision, and the sizes a copy would leave out
 *   POST /product/styles/:styleId/duplicate   the copy: product.styles.manage over the style's company, plus the part's
 *                                             own write permission (BOM product.bom.manage, routing
 *                                             product.routing.manage, label compliance.labels.manage)
 *
 * The copy is a new DRAFT style of the source's company with its own code and name, the source's identity, its ACTIVE
 * colourways and the parts picked; the BOM, routing and label land in the copy's revision 1, a DRAFT (never released).
 * It is linked to its source by the audit rows, the `style.duplicated` event and its first revision's change note (no
 * column holds the link: a schema follow-up if a screen must show it).
 *
 * One command: the source style row FOR UPDATE (its draft's parts hold still while they are read), the code free, the
 * scale FOR SHARE, the new style, its colourways, revision 1 with the BOM lines, size quantities, colour cells and routing
 * steps (with their subcontract details), and the SKUs when asked. A material or operation archived since is copied as
 * it is: the copy's release check shows it, as for a copied revision.
 */

const PART_PERMISSION: Readonly<Partial<Record<CopyablePart, Permission>>> = { BOM: PRODUCT_BOM_MANAGE, ROUTING: PRODUCT_ROUTING_MANAGE, LABELS: LABELS_MANAGE }
const PART_NAME: Readonly<Record<CopyPart, string>> = { BOM: 'the BOM', ROUTING: 'the routing', MEASUREMENTS: 'the made-to-measure set-up', LABELS: 'the garment label', PICTURES: 'the pictures', OPTIONS: 'the options' }

type Client = FactoryClient | CommandTx
type SourceRevision = Prisma.StyleRevisionGetPayload<{ select: typeof SOURCE_REVISION_COLUMNS }>
const SOURCE_REVISION_COLUMNS = { id: true, revision: true, status: true, plannedHideYieldPct: true, labelTemplateId: true } as const satisfies Prisma.StyleRevisionSelect

interface PartOffer {
  readonly part: CopyPart
  readonly available: boolean
  readonly count: number | null
  readonly reason: string | null
}

/** Each part, whether this person can copy it from this revision now, and why not (the dialog and the copy's check). */
async function partOffers(client: Client, actor: Actor, source: StyleRowData, revision: SourceRevision | null): Promise<PartOffer[]> {
  const offers: PartOffer[] = []
  const noRevision = `${source.code} has no revision yet.`
  const may = (part: CopyablePart): string | null => {
    const permission = PART_PERMISSION[part]
    return permission === undefined || mayWrite(actor, permission, source.companyId) ? null : `Copying ${PART_NAME[part]} needs ${permission}${source.companyId === null ? ' over every company' : ''}.`
  }
  for (const part of COPY_PARTS) {
    const notYet = PART_NOT_YET[part]
    if (notYet !== undefined) {
      offers.push({ part, available: false, count: null, reason: notYet })
      continue
    }
    const copyable = part as CopyablePart
    if (part === 'MEASUREMENTS') {
      const reason = source.mtmAllowed ? null : `${source.code} is not made to measure.`
      offers.push({ part, available: reason === null, count: null, reason })
      continue
    }
    if (revision === null) {
      offers.push({ part, available: false, count: null, reason: noRevision })
      continue
    }
    if (part === 'BOM' || part === 'ROUTING') {
      const visible = can(actor, part === 'BOM' ? PRODUCT_BOM_VIEW : PRODUCT_ROUTING_VIEW, { companyId: source.companyId })
      const count = part === 'BOM' ? await client.bomLine.count({ where: { revisionId: revision.id } }) : await client.routingOperation.count({ where: { revisionId: revision.id } })
      const reason = count === 0 ? `Revision ${revision.revision} has no ${part === 'BOM' ? 'BOM lines' : 'routing steps'}.` : may(copyable)
      offers.push({ part, available: reason === null, count: visible ? count : null, reason })
      continue
    }
    // LABELS: the revision's label, when it is a shared one that is not retired.
    let reason: string | null
    if (revision.labelTemplateId === null) reason = `Revision ${revision.revision} has no garment label.`
    else {
      const label = await client.labelTemplate.findUnique({ where: { id: revision.labelTemplateId }, select: { code: true, revision: true, styleId: true, status: true } })
      if (!label) reason = `Revision ${revision.revision} has no garment label.`
      else if (label.styleId !== null) reason = `Label ${label.code} r${label.revision} is ${source.code}'s own label: make one for the copy in Compliance.`
      else if (label.status === 'RETIRED') reason = `Label ${label.code} r${label.revision} is retired.`
      else reason = may(copyable)
    }
    offers.push({ part, available: reason === null, count: null, reason })
  }
  return offers
}

async function revisionsOf(client: Client, styleId: string): Promise<SourceRevision[]> {
  return client.styleRevision.findMany({ where: { styleId }, select: SOURCE_REVISION_COLUMNS, orderBy: { revision: 'desc' } })
}

function chosenRevision(revisions: readonly SourceRevision[], fromRevisionId: string | undefined): SourceRevision | null {
  const revision = sourceRevisionOf(revisions, fromRevisionId)
  if (fromRevisionId !== undefined && revision === null) throw new NotFoundError('Revision not found.')
  return revision
}

/** What the Duplicate dialog offers for this style (product.styles.view). */
export async function duplicateOffer(caller: CommandCaller, styleId: string, fromRevisionId: string | undefined): Promise<DuplicateOfferView> {
  const context = contextOf(caller)
  const source = await readStyle(caller, styleId)
  return caller.withClient(async (client) => {
    const revision = chosenRevision(await revisionsOf(client, styleId), fromRevisionId)
    const parts = await partOffers(client, actorOf(context), source, revision)
    const colourways = await client.colourway.count({ where: { styleId, status: 'ACTIVE' } })
    const { dropped } = copiedRange(fieldsOf(source), await readScaleSizes(client, source.sizeScaleId))
    return {
      source: { id: source.id, code: source.code, name: source.name, status: source.status },
      revision: revision ? { id: revision.id, revision: revision.revision, status: revision.status } : null,
      parts,
      colourways,
      droppedSizes: dropped,
    }
  })
}

/** product.styles.duplicate: the copy, with the parts picked. */
export async function duplicateStyle(caller: CommandCaller, styleId: string, body: DuplicateStyleBody, idempotencyKey?: string): Promise<DuplicatedView> {
  const context = contextOf(caller)
  const actor = actorOf(context)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId)
  const parts = [...new Set(body.parts)] as CopyablePart[]
  for (const part of parts) {
    const permission = PART_PERMISSION[part]
    if (permission !== undefined && !mayWrite(actor, permission, seen.companyId)) throw new ForbiddenError(`Copying ${PART_NAME[part]} needs ${permission}${seen.companyId === null ? ' over every company' : ''}.`)
  }
  const companyId = seen.companyId

  const { result } = await command(caller, { name: 'product.styles.duplicate', idempotencyKey, input: { styleId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockStyle(tx, styleId)
    const source = await findStyleRow(tx, styleId)
    if (!source) throw new NotFoundError('Style not found.')
    const revision = chosenRevision(await revisionsOf(tx, styleId), body.fromRevisionId)
    const offers = await partOffers(tx, actor, source, revision)
    const refused: Issue[] = parts.flatMap((part, index) => {
      const offer = offers.find((entry) => entry.part === part)
      return offer && !offer.available ? [{ path: `body/parts/${index}`, message: offer.reason ?? `${PART_NAME[part]} cannot be copied.` }] : []
    })
    if (refused.length > 0) throw new DomainError('invalid_state', `${refused.length} part(s) cannot be copied from ${source.code}.`, refused)
    if (await codeTaken(tx, body.code)) throw codeConflict(body.code)

    const scale = await scaleProblems(tx, source.sizeScaleId, companyId, true)
    if (scale.length > 0) throw invalid(scale)
    const scaleSizes = await readScaleSizes(tx, source.sizeScaleId)
    const range = copiedRange(fieldsOf(source), scaleSizes)
    const typed = { code: body.code, name: body.name, season: body.season, brandPartyId: body.brandPartyId }
    const outcome = newStyle(copiedFields(fieldsOf(source), typed, parts, range) as StyleInput, scaleSizes)
    if (!outcome.ok) throw invalid(prefixed(outcome.issues))
    const style = outcome.style
    const problems: Issue[] = [...(await brandProblems(tx, style.brandPartyId, companyId)), ...(await templateProblems(tx, style.measurementTemplateId, style, companyId))]
    if (problems.length > 0) throw invalid(problems)

    const notes: string[] = []
    if (range.dropped.length > 0) notes.push(`Size(s) ${range.dropped.join(', ')} are archived in the scale: the copy's range leaves them out.`)
    const id = newId()
    const createdById = context.audience === 'office' ? context.actorId : null
    const stamp = { createdAt: now, updatedAt: now, createdById }
    await tx.style.create({
      data: { ...(columnsOf(style) as Prisma.StyleUncheckedCreateInput), id, companyId, garmentTracking: source.garmentTracking, ...stamp },
      select: { id: true },
    })
    tools.emit({ type: 'style.created', subject: id, companyId, payload: { styleId: id, code: style.code } })

    // The ACTIVE colourways, each under a new id (the BOM's colourway lines and cells follow them).
    const colourways = (await tx.colourway.findMany({ where: { styleId }, select: COLOURWAY_COLUMNS, orderBy: [{ createdAt: 'asc' }, { code: 'asc' }] })).filter((entry) => entry.status === 'ACTIVE')
    const archived = await tx.colourway.count({ where: { styleId, status: 'ARCHIVED' } })
    if (archived > 0) notes.push(`${archived} archived colourway(s) are not copied.`)
    const colourwayMap = new Map<string, string>()
    const copiedColourways = []
    for (const [index, colourway] of colourways.entries()) {
      const keepColour = colourway.colourId !== null && (await colourProblems(tx, colourway.colourId, companyId, `colourways/${index}/colourId`)).length === 0
      if (colourway.colourId !== null && !keepColour) notes.push(`Colourway ${colourway.code}: its library colour is archived or another company's; the copy has none.`)
      const copyId = newId()
      colourwayMap.set(colourway.id, copyId)
      copiedColourways.push({ id: copyId, styleId: id, code: colourway.code, name: colourway.name, colourId: keepColour ? colourway.colourId : null, description: colourway.description, ...stamp })
    }
    if (copiedColourways.length > 0) await tx.colourway.createMany({ data: copiedColourways })

    let revisionRow: Prisma.StyleRevisionGetPayload<{ select: typeof REVISION_COLUMNS }> | null = null
    let bomLines = 0
    let routingSteps = 0
    const label = parts.includes('LABELS')
    if (needsRevision(parts)) {
      const revisionId = newId()
      revisionRow = await tx.styleRevision.create({
        data: {
          id: revisionId,
          styleId: id,
          revision: 1,
          status: 'DRAFT',
          changeNote: copyNote(source, revision, body.changeNote),
          plannedHideYieldPct: parts.includes('BOM') ? (revision?.plannedHideYieldPct ?? null) : null,
          labelTemplateId: label ? (revision?.labelTemplateId ?? null) : null,
          ...stamp,
        },
        select: REVISION_COLUMNS,
      })
      tools.emit({ type: 'style.revision_created', subject: id, companyId, payload: { styleId: id, code: style.code, revisionId, revision: 1 } })
      if (parts.includes('BOM') && revision) {
        const copied = copyBomLines(await readLines(tx, revision.id), colourwayMap, range.sizes, newId)
        if (copied.dropped > 0) notes.push(`${copied.dropped} BOM line(s) of archived colourways are not copied.`)
        const lines = copied.lines
        bomLines = lines.length
        if (lines.length > 0) {
          await tx.bomLine.createMany({
            data: lines.map((line) => ({
              id: line.id,
              styleId: id,
              revisionId,
              seq: line.seq,
              itemId: line.itemId,
              placement: line.placement,
              qty: line.qty,
              uom: line.uom,
              wastagePct: line.wastagePct,
              sizeDependent: line.sizeDependent,
              colourDependent: line.colourDependent,
              itemColourId: line.itemColourId,
              colourwayId: line.colourwayId,
              supplierId: line.supplierId,
              note: line.note,
              ...stamp,
            })),
          })
          const sizes = lines.flatMap((line) => line.sizes.map((row) => ({ id: newId(), revisionId, bomLineId: line.id, size: row.size, qty: row.qty, ...stamp })))
          if (sizes.length > 0) await tx.bomLineSize.createMany({ data: sizes })
          const cells = lines.flatMap((line) => line.colours.map((cell) => ({ id: newId(), styleId: id, revisionId, bomLineId: line.id, itemId: line.itemId, colourwayId: cell.colourwayId, itemColourId: cell.itemColourId, ...stamp })))
          if (cells.length > 0) await tx.bomLineColour.createMany({ data: cells })
        }
      }
      if (parts.includes('ROUTING') && revision) {
        const steps = copyRoutingSteps(await readSteps(tx, revision.id), await readSubcontracts(tx, revision.id), newId)
        routingSteps = steps.length
        await insertSteps(
          tools,
          { styleId: id, revisionId },
          steps.map((entry) => entry.step),
          new Map(steps.flatMap((entry) => (entry.subcontract ? [[entry.step.id, entry.subcontract] as const] : []))),
        )
      }
    }

    let skus = 0
    if (body.generateSkus) {
      const rows = await tx.colourway.findMany({ where: { styleId: id }, select: COLOURWAY_COLUMNS, orderBy: [{ createdAt: 'asc' }, { code: 'asc' }] })
      const target = { id, code: style.code, companyId }
      const applied = await applyMatrixPlan(tools, target, generatePlan(style.code, offerOf(style.sizes, rows), []))
      skus = applied.created.length
      emitSkus(tools, target, applied)
    }

    const from = { styleId, code: source.code, revisionId: revision?.id ?? null, revision: revision?.revision ?? null }
    const copied = { from, parts, colourways: copiedColourways.length, bomLines, routingSteps, label, skus }
    tools.audit({
      recordType: 'Style',
      recordId: id,
      companyId,
      after: { ...style, status: 'DRAFT', garmentTracking: source.garmentTracking, colourways: copiedColourways.map((entry) => ({ code: entry.code, name: entry.name, colourId: entry.colourId, description: entry.description })), copiedFrom: from, parts },
    })
    tools.audit({ recordType: 'Style', recordId: styleId, companyId, after: { copiedTo: { styleId: id, code: style.code, parts } } })
    if (revisionRow) {
      tools.audit({ recordType: 'StyleRevision', recordId: revisionRow.id, companyId, after: { styleId: id, revision: 1, status: 'DRAFT', changeNote: revisionRow.changeNote, copiedFrom: from, lines: bomLines, routingSteps, labelTemplateId: revisionRow.labelTemplateId } })
    }
    tools.emit({ type: 'style.duplicated', subject: id, companyId, payload: { styleId: id, code: style.code, sourceStyleId: styleId, sourceCode: source.code, sourceRevisionId: from.revisionId, parts } })
    return { style: await styleViewInTx(tx, id), revision: revisionRow ? revisionViewOf(revisionRow) : null, copied, notes }
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw codeConflict(body.code)
    throw error
  })
  return result
}
