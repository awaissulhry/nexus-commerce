import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { colourwayListProblems, normaliseColourway } from '@nexus/factory-domain/product/styles/colourways'
import type { CreateStyleBody, GarmentTrackingBody, ListStylesQuery, StyleRow, StyleView, UpdateStyleBody } from '@nexus/factory-domain/product/styles/contracts'
import { followPlan, generatePlan } from '@nexus/factory-domain/product/styles/matrix'
import { PRODUCT_STYLES_MANAGE, PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import {
  changeStyle,
  garmentTrackingRefusal,
  newStyle,
  reactivatedStatus,
  styleChangeRefusals,
  styleMachine,
  type GarmentTrackingUses,
  type ScaleSizes,
  type StyleFacts,
  type StyleFields,
  type StyleInput,
  type StylePatch,
} from '@nexus/factory-domain/product/styles/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { afterCursor, decodeCursor, encodeCursor } from './cursor'
import { applyMatrixPlan, emitSkus } from './skus'
import {
  assertMayWrite,
  brandProblems,
  clearStyleNames,
  colourProblems,
  COLOURWAY_COLUMNS,
  contextOf,
  fieldsOf,
  invalid,
  isUniqueViolation,
  offerOf,
  prefixed,
  readParts,
  readStyle,
  scaleProblems,
  STYLE_COLUMNS,
  STYLE_SCOPE,
  styleRowView,
  styleViewInTx,
  styleViewOf,
  templateProblems,
  VARIANT_COLUMNS,
  withRefs,
} from './store'

/**
 * Styles (plan A1 §2.4 B; A2 SCR-040 "Styles", SCR-041 "Style › Overview & variants"; features PRD-001, PRD-002,
 * PRD-022, PRD-048, PRD-270): the list, one style, and its writes, each through command() with its audit rows and its
 * event. The domain (factory-domain product/styles) decides what a style may be; this file adds what only the database
 * knows: the code is free, the scale, brand, template and colours are the tenant's and fit the style's company, the
 * style's SKUs freeze its code and scale, and a change of the range moves the SKUs (product/styles/matrix).
 */

// ---- reads -------------------------------------------------------------------------------------------------------------

/** The styles the caller may see, by code, one page at a time (SCR-040). */
export async function listStyles(caller: CommandCaller, query: ListStylesQuery): Promise<{ styles: StyleRow[]; nextCursor: string | null; count: number }> {
  const context = contextOf(caller)
  const search = query.q?.trim()
  const filters: Prisma.StyleWhereInput[] = [
    scopeWhere(actorOf(context), PRODUCT_STYLES_VIEW, STYLE_SCOPE) as Prisma.StyleWhereInput,
    query.status === 'ALL' ? {} : query.status === 'OPEN' ? { status: { in: ['DRAFT', 'ACTIVE'] } } : { status: query.status },
    search
      ? {
          OR: [
            { code: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
            { season: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {},
    query.productType ? { productType: { in: query.productType } } : {},
    query.ppeCategory ? { ppeCategory: { in: query.ppeCategory } } : {},
    query.season ? { season: { equals: query.season, mode: 'insensitive' } } : {},
    query.brandPartyId ? { brandPartyId: query.brandPartyId } : {},
    query.sizeScaleId ? { sizeScaleId: query.sizeScaleId } : {},
    query.mtmAllowed === undefined ? {} : { mtmAllowed: query.mtmAllowed },
    query.draftRevision === undefined ? {} : query.draftRevision ? { revisions: { some: { status: 'DRAFT' } } } : { revisions: { none: { status: 'DRAFT' } } },
    query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {},
  ]
  const cursor = decodeCursor(query.cursor)
  return caller.withClient(async (client) => {
    const rows = await client.style.findMany({ where: { AND: [...filters, afterCursor(cursor)] }, select: STYLE_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: query.limit + 1 })
    const count = await client.style.count({ where: { AND: filters } })
    const page = await withRefs(client, rows.slice(0, query.limit))
    const ids = page.map((row) => row.id)
    const skus = await client.variant.groupBy({ by: ['styleId'], where: { styleId: { in: ids }, status: 'ACTIVE' }, _count: { _all: true } })
    const revisions = await client.styleRevision.findMany({ where: { styleId: { in: ids } }, select: { styleId: true, revision: true, status: true } })
    const skuCount = new Map(skus.map((entry) => [entry.styleId, entry._count._all]))
    const last = page.at(-1)
    return {
      styles: page.map((row) => styleRowView(row, { skuCount: skuCount.get(row.id) ?? 0, revisions: revisions.filter((entry) => entry.styleId === row.id) })),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
      count,
    }
  })
}

/** One style with its colourways, range, SKU matrix and revisions (SCR-041). */
export async function getStyle(caller: CommandCaller, styleId: string): Promise<StyleView> {
  const row = await readStyle(caller, styleId)
  return styleViewOf(row, await caller.withClient((client) => readParts(client, row)))
}

// ---- shared -------------------------------------------------------------------------------------------------------------

const readScaleSizes = (client: FactoryClient | CommandTx, scaleId: string): Promise<ScaleSizes> =>
  client.size.findMany({ where: { scaleId }, select: { code: true, seq: true, status: true } })

async function codeTaken(tx: CommandTx, code: string, except?: string): Promise<boolean> {
  return (await tx.style.findFirst({ where: { code, ...(except ? { id: { not: except } } : {}) }, select: { id: true } })) !== null
}
const codeConflict = (code: string) => new ConflictError(`The style code ${code} is taken.`)

/** The columns a set of style fields writes; nameI18n set to null is left out here (cleared by clearStyleNames). */
function columnsOf(fields: Partial<StyleFields>): Prisma.StyleUncheckedUpdateInput {
  const data: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || (value === null && key === 'nameI18n')) continue
    data[key] = value
  }
  return data as Prisma.StyleUncheckedUpdateInput
}

function openOnly(status: string): void {
  if (status === 'ARCHIVED') throw new InvalidStateError('This style is archived: reactivate it before changing it.')
}

export const releasedFacts = async (client: FactoryClient | CommandTx, styleId: string): Promise<StyleFacts> => ({
  releasedRevision: (await client.styleRevision.count({ where: { styleId, status: 'RELEASED' } })) > 0,
})

// ---- create ------------------------------------------------------------------------------------------------------------

function styleInputOf(body: CreateStyleBody): StyleInput {
  const { companyId: _company, colourways: _colourways, generateSkus: _generate, ...fields } = body
  return fields
}

/** product.styles.create: a style with its colourways and range (and, when asked, its SKU matrix at once). */
export async function createStyle(caller: CommandCaller, body: CreateStyleBody, idempotencyKey?: string): Promise<StyleView> {
  const context = contextOf(caller)
  const companyId = body.companyId ?? null
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, companyId)
  const input = styleInputOf(body)
  const colourways = (body.colourways ?? []).map(normaliseColourway)
  // Checked here first against the scale as it is, so a refusal answers before any lock; again on the locked scale.
  const preview = newStyle(input, await caller.withClient((client) => readScaleSizes(client, body.sizeScaleId)))
  const issues = [...(preview.ok ? [] : prefixed(preview.issues)), ...prefixed(colourwayListProblems(colourways))]
  if (issues.length > 0 || !preview.ok) throw invalid(issues)
  const code = preview.style.code

  const { result } = await command(caller, { name: 'product.styles.create', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if (companyId !== null && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) {
      throw invalid([{ path: 'body/companyId', message: 'No such company.' }])
    }
    const scale = await scaleProblems(tx, body.sizeScaleId, companyId, true)
    if (scale.length > 0) throw invalid(scale)
    const outcome = newStyle(input, await readScaleSizes(tx, body.sizeScaleId))
    if (!outcome.ok) throw invalid(prefixed(outcome.issues))
    const style = outcome.style
    const problems: Issue[] = [
      ...(await brandProblems(tx, style.brandPartyId, companyId)),
      ...(await templateProblems(tx, style.measurementTemplateId, style, companyId)),
    ]
    for (const [index, colourway] of colourways.entries()) problems.push(...(await colourProblems(tx, colourway.colourId, companyId, `body/colourways/${index}/colourId`)))
    if (problems.length > 0) throw invalid(problems)
    if (await codeTaken(tx, style.code)) throw codeConflict(style.code)

    const id = newId()
    const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
    await tx.style.create({
      data: { ...(columnsOf(style) as Prisma.StyleUncheckedCreateInput), id, companyId, createdAt: now, updatedAt: now, createdById },
      select: { id: true },
    })
    if (colourways.length > 0) {
      await tx.colourway.createMany({ data: colourways.map((colourway) => ({ id: newId(), styleId: id, ...colourway, createdAt: now, updatedAt: now, createdById })) })
    }
    tools.audit({ recordType: 'Style', recordId: id, companyId, after: { ...style, status: 'DRAFT', colourways: colourways.map((colourway) => ({ ...colourway })) } })
    tools.emit({ type: 'style.created', subject: id, companyId, payload: { styleId: id, code: style.code } })
    if (body.generateSkus) {
      const rows = await tx.colourway.findMany({ where: { styleId: id }, select: COLOURWAY_COLUMNS, orderBy: [{ createdAt: 'asc' }, { code: 'asc' }] })
      const target = { id, code: style.code, companyId }
      emitSkus(tools, target, await applyMatrixPlan(tools, target, generatePlan(style.code, offerOf(style.sizes, rows), [])))
    }
    return styleViewInTx(tx, id)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw codeConflict(code)
    throw error
  })
  return result
}

// ---- update ------------------------------------------------------------------------------------------------------------

/**
 * product.styles.update: the fields sent (versioned, COL-078). Once the style has SKUs its code and scale stay; a new
 * range moves the SKUs: sizes added get theirs (or their archived ones back), sizes taken out have theirs archived,
 * never deleted (PRD-022).
 */
export async function updateStyle(caller: CommandCaller, styleId: string, body: UpdateStyleBody, idempotencyKey?: string): Promise<StyleView> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId)
  openOnly(seen.status)
  const { version, ...patch } = body
  const preview = changeStyle(fieldsOf(seen), patch as StylePatch, await caller.withClient((client) => readScaleSizes(client, patch.sizeScaleId ?? seen.sizeScaleId)))
  if (!preview.ok) throw invalid(prefixed(preview.issues))
  if (preview.changed.length === 0) return getStyle(caller, styleId)

  const { result } = await command(
    caller,
    { name: 'product.styles.update', idempotencyKey, input: { styleId, ...body }, record: { type: 'Style', id: styleId, expectedVersion: version } },
    async (tools) => {
      const { tx } = tools
      const row = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: STYLE_COLUMNS })
      openOnly(row.status)
      const current = fieldsOf(row)
      const scaleId = patch.sizeScaleId ?? current.sizeScaleId
      const scale = await scaleProblems(tx, scaleId, row.companyId, scaleId !== current.sizeScaleId)
      if (scale.length > 0) throw invalid(scale)
      const change = changeStyle(current, patch as StylePatch, await readScaleSizes(tx, scaleId))
      if (!change.ok) throw invalid(prefixed(change.issues))
      const { style: next, changed } = change
      const variants = await tx.variant.findMany({ where: { styleId }, select: VARIANT_COLUMNS })
      const refusals = styleChangeRefusals(current, next, { variants: variants.length })
      if (refusals.length > 0) throw new ConflictError(refusals.join(' '))
      if (changed.includes('brandPartyId') && current.brandPartyId !== null) {
        // The style's thread shares its messages with the brand it had (platform/threads): another brand would read them.
        const shared = await tx.thread.findFirst({ where: { recordType: 'Style', recordId: styleId, partyId: current.brandPartyId }, select: { id: true } })
        if (shared) throw new ConflictError("The style's thread is shared with its brand: its brand stays (another brand's style is a new style).")
      }
      const problems: Issue[] = []
      if (changed.includes('brandPartyId')) problems.push(...(await brandProblems(tx, next.brandPartyId, row.companyId)))
      if (changed.includes('measurementTemplateId') || changed.includes('productType')) problems.push(...(await templateProblems(tx, next.measurementTemplateId, next, row.companyId)))
      if (problems.length > 0) throw invalid(problems)
      if (changed.includes('code') && (await codeTaken(tx, next.code, styleId))) throw codeConflict(next.code)

      const after = Object.fromEntries(changed.map((field) => [field, next[field]])) as Partial<StyleFields>
      const before = Object.fromEntries(changed.map((field) => [field, current[field]])) as Partial<StyleFields>
      await tx.style.update({ where: { id: styleId }, data: columnsOf(after), select: { id: true } })
      if (after.nameI18n === null) await clearStyleNames(tx, styleId)
      tools.audit({ recordType: 'Style', recordId: styleId, companyId: row.companyId, before, after })
      if (changed.length > 0) tools.emit({ type: 'style.updated', subject: styleId, companyId: row.companyId, payload: { styleId, code: next.code, fields: [...changed] } })

      if (changed.includes('sizes')) {
        const colourways = await tx.colourway.findMany({ where: { styleId }, select: { id: true, code: true, status: true } })
        const plan = followPlan(next.code, offerOf(current.sizes, colourways), offerOf(next.sizes, colourways), variants)
        const target = { id: styleId, code: next.code, companyId: row.companyId }
        emitSkus(tools, target, await applyMatrixPlan(tools, target, plan))
      }
      return styleViewInTx(tx, styleId)
    },
  ).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('The style code is taken.')
    throw error
  })
  return result
}

// ---- garment numbering (Q31) ----------------------------------------------------------------------------------------------

/**
 * How the style's garments are numbered on their labels (Q31: BATCH or SERIAL, a setting per style;
 * `PUT /product/styles/:styleId/garment-tracking`, product.styles.manage over the style's company). It changes while the
 * style's work orders printed no garment label, gave no serial and released no garment: after that the API answers 409
 * in words (factory-domain `garmentTrackingRefusal`) before the database's factory_style_garment_tracking_guard, which
 * holds the same rule. One command on the Style: its version is the compare-and-set, the row stays locked to the end.
 */
export async function setGarmentTracking(caller: CommandCaller, styleId: string, body: GarmentTrackingBody, idempotencyKey?: string): Promise<StyleView> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId)
  openOnly(seen.status)
  // The same choice again changes nothing (like a PATCH with no change): no command, no version bump.
  if (seen.garmentTracking === body.tracking) return getStyle(caller, styleId)
  const { result } = await command(
    caller,
    { name: 'product.styles.setGarmentTracking', idempotencyKey, input: { styleId, ...body }, record: { type: 'Style', id: styleId, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      const row = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { code: true, status: true, companyId: true, garmentTracking: true } })
      openOnly(row.status)
      const refusal = garmentTrackingRefusal({ code: row.code, tracking: row.garmentTracking }, await trackingUses(tx, styleId))
      if (refusal) throw new ConflictError(refusal)
      await tx.style.update({ where: { id: styleId }, data: { garmentTracking: body.tracking }, select: { id: true } })
      tools.audit({ recordType: 'Style', recordId: styleId, companyId: row.companyId, before: { garmentTracking: row.garmentTracking }, after: { garmentTracking: body.tracking } })
      tools.emit({ type: 'style.updated', subject: styleId, companyId: row.companyId, payload: { styleId, code: row.code, fields: ['garmentTracking'] } })
      return styleViewInTx(tx, styleId)
    },
  )
  return result
}

/** What the style's work orders did with its garment numbering: labels printed, serials given, garments released. */
async function trackingUses(tx: CommandTx, styleId: string): Promise<GarmentTrackingUses> {
  const workOrderIds = (await tx.workOrder.findMany({ where: { styleId }, select: { id: true } })).map((row) => row.id)
  if (workOrderIds.length === 0) return { labels: 0, serials: 0, releases: 0 }
  const where = { workOrderId: { in: workOrderIds } }
  // One query after the other: a transaction has one connection.
  const labels = await tx.garmentLabelPrint.count({ where })
  const serials = await tx.garmentSerial.count({ where })
  const releases = await tx.qualityRelease.count({ where })
  return { labels, serials, releases }
}

// ---- archive, reactivate -----------------------------------------------------------------------------------------------

/**
 * product.styles.archive / reactivate (PRD-022: a style in use is never deleted): out of new use, read only, and back
 * (ACTIVE when it has a released revision, else DRAFT). Its colourways and SKUs keep their states.
 */
export async function moveStyle(caller: CommandCaller, styleId: string, direction: 'archive' | 'reactivate', body: { version: number; reason?: string | undefined }, idempotencyKey?: string): Promise<StyleView> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId)
  const to = direction === 'archive' ? 'ARCHIVED' : reactivatedStatus(await caller.withClient((client) => releasedFacts(client, styleId)))
  const { result } = await command(
    caller,
    {
      name: direction === 'archive' ? 'product.styles.archive' : 'product.styles.reactivate',
      idempotencyKey,
      input: { styleId, ...body },
      record: { type: 'Style', id: styleId, expectedVersion: body.version, transition: { machine: styleMachine, to, facts: (tx) => releasedFacts(tx, styleId) } },
    },
    async (tools) => {
      const { tx, record } = tools
      tools.audit({ recordType: 'Style', recordId: styleId, companyId: seen.companyId, before: { status: record!.from }, after: { status: to }, ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'style.status_changed', subject: styleId, companyId: seen.companyId, payload: { styleId, code: seen.code, status: to } })
      return styleViewInTx(tx, styleId)
    },
  )
  return result
}
