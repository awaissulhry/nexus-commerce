import type { FactoryClient } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import type { GeneratedSkus, GenerateSkusBody, StyleView, UpdateSkuBody } from '@nexus/factory-domain/product/styles/contracts'
import { generatePlan, isEmptyPlan, isOffered, skuClashes, skuMachine, type MatrixPlan } from '@nexus/factory-domain/product/styles/matrix'
import { PRODUCT_STYLES_MANAGE } from '@nexus/factory-domain/product/styles/permissions'
import { parseGtin, skuProblem } from '@nexus/factory-domain/product/styles/sku'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import {
  assertMayWrite,
  bumpVersion,
  COLOURWAY_COLUMNS,
  contextOf,
  isUniqueViolation,
  lockStyle,
  offerOf,
  readParts,
  readStyle,
  styleViewInTx,
  styleViewOf,
  VARIANT_COLUMNS,
} from './store'

/**
 * The colour x size SKU matrix (feature PRD-005; factory-domain product/styles/matrix and sku): generating the SKUs,
 * one cell switched on or off, a barcode (GTIN) per SKU, and `applyMatrixPlan`, which every command that changes what
 * a style offers (its range, its colourways) calls with factory-domain's plan. A SKU is never deleted: off is ARCHIVED.
 * Every SKU written has its own audit row, and the style one more that lists them; one `style.skus_changed` event.
 */

export interface MatrixStyle {
  readonly id: string
  readonly code: string
  readonly companyId: string | null
}

export interface AppliedPlan {
  readonly created: readonly { readonly id: string; readonly colourwayId: string; readonly size: string; readonly sku: string }[]
  readonly archived: number
  readonly restored: number
}

const skuConflict = (skus: readonly string[]) =>
  new ConflictError(`SKU ${skus.slice(0, 5).join(', ')}${skus.length > 5 ? ' …' : ''} exists already in the tenant: change the style or colourway code before making it.`)

/** The SKUs of the plan that may not be made: too long or odd (a 400), or taken in the tenant (a 409). */
async function checkNewSkus(client: FactoryClient | CommandTx, plan: MatrixPlan): Promise<void> {
  const problems = plan.create.map((entry) => skuProblem(entry.sku)).filter((problem): problem is string => problem !== null)
  if (problems.length > 0) throw new ValidationError('The SKUs cannot be made.', problems.slice(0, 20).map((message) => ({ path: 'sku', message })))
  if (plan.create.length === 0) return
  const taken = await client.variant.findMany({ where: { sku: { in: plan.create.map((entry) => entry.sku) } }, select: { sku: true } })
  const clashes = skuClashes(plan, new Set(taken.map((row) => row.sku)))
  if (clashes.length > 0) throw skuConflict(clashes)
}

/**
 * Writes a matrix plan inside a command, after the style's lock: new SKUs, SKUs off and on again. Answers what it did
 * (nothing for an empty plan); the caller emits the event (`emitSkus`).
 */
export async function applyMatrixPlan(tools: CommandTools, style: MatrixStyle, plan: MatrixPlan, action?: Permission): Promise<AppliedPlan> {
  if (isEmptyPlan(plan)) return { created: [], archived: 0, restored: 0 }
  const { tx, now, context } = tools
  await checkNewSkus(tx, plan)
  const createdById = context.audience === 'office' ? context.actorId : null
  const created = plan.create.map((entry) => ({ id: newId(), ...entry }))
  if (created.length > 0) {
    await tx.variant.createMany({ data: created.map((entry) => ({ id: entry.id, styleId: style.id, colourwayId: entry.colourwayId, size: entry.size, sku: entry.sku, createdAt: now, updatedAt: now, createdById })) })
  }
  const moved = async (ids: readonly string[], status: 'ACTIVE' | 'ARCHIVED') => {
    if (ids.length === 0) return []
    const rows = await tx.variant.findMany({ where: { id: { in: [...ids] }, styleId: style.id }, select: { id: true, sku: true, status: true } })
    await tx.variant.updateMany({ where: { id: { in: rows.map((row) => row.id) } }, data: { status, version: { increment: 1 } } })
    return rows
  }
  const archived = await moved(plan.archive, 'ARCHIVED')
  const restored = await moved(plan.restore, 'ACTIVE')
  const at = { ...(action ? { action } : {}), recordType: 'Variant', companyId: style.companyId } as const
  for (const entry of created) tools.audit({ ...at, recordId: entry.id, after: { sku: entry.sku, colourwayId: entry.colourwayId, size: entry.size, status: 'ACTIVE' } })
  for (const row of archived) tools.audit({ ...at, recordId: row.id, before: { status: row.status }, after: { status: 'ARCHIVED' } })
  for (const row of restored) tools.audit({ ...at, recordId: row.id, before: { status: row.status }, after: { status: 'ACTIVE' } })
  tools.audit({
    ...(action ? { action } : {}),
    recordType: 'Style',
    recordId: style.id,
    companyId: style.companyId,
    after: { skus: { created: created.map((entry) => entry.sku), archived: archived.map((row) => row.sku), restored: restored.map((row) => row.sku) } },
  })
  return { created, archived: archived.length, restored: restored.length }
}

/** The style.skus_changed event of what a command did to the SKUs (none when nothing). */
export function emitSkus(tools: CommandTools, style: MatrixStyle, applied: AppliedPlan, updated = 0): void {
  if (applied.created.length + applied.archived + applied.restored + updated === 0) return
  tools.emit({
    type: 'style.skus_changed',
    subject: style.id,
    companyId: style.companyId,
    payload: { styleId: style.id, code: style.code, created: applied.created.length, archived: applied.archived, restored: applied.restored, updated },
  })
}

function openStyle(status: string): void {
  if (status === 'ARCHIVED') throw new InvalidStateError('This style is archived: reactivate it before changing its SKUs.')
}

/**
 * product.styles.generateSkus: a SKU for every colourway and size of the range that has none (PRD-005). A cell switched
 * off stays off. `dryRun` answers the SKUs it would make and writes nothing. Generating also starts the matrix
 * following the style's range and colourways (factory-domain matrix).
 */
export async function generateSkus(caller: CommandCaller, styleId: string, body: GenerateSkusBody, idempotencyKey?: string): Promise<GeneratedSkus> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId)
  openStyle(seen.status)
  const describe = (created: readonly { colourwayId: string; size: string; sku: string }[], codes: ReadonlyMap<string, string>) =>
    created.map((entry) => ({ colourwayId: entry.colourwayId, colourwayCode: codes.get(entry.colourwayId) ?? '', size: entry.size, sku: entry.sku }))

  if (body.dryRun) {
    const { plan, parts } = await caller.withClient(async (client) => {
      const parts = await readParts(client, seen)
      const plan = generatePlan(seen.code, offerOf(seen.sizes, parts.colourways), parts.variants)
      await checkNewSkus(client, plan)
      return { plan, parts }
    })
    const codes = new Map(parts.colourways.map((colourway) => [colourway.id, colourway.code]))
    return { dryRun: true, skus: describe(plan.create, codes), style: styleViewOf(seen, parts) }
  }

  const { result } = await command(caller, { name: 'product.styles.generateSkus', idempotencyKey, input: { styleId, ...body } }, async (tools) => {
    const { tx } = tools
    const locked = await lockStyle(tx, styleId)
    openStyle(locked.status)
    const row = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { sizes: true } })
    const colourways = await tx.colourway.findMany({ where: { styleId }, select: COLOURWAY_COLUMNS, orderBy: [{ createdAt: 'asc' }, { code: 'asc' }] })
    const variants = await tx.variant.findMany({ where: { styleId }, select: VARIANT_COLUMNS })
    const plan = generatePlan(locked.code, offerOf(row.sizes, colourways), variants)
    const style = { id: styleId, code: locked.code, companyId: locked.companyId }
    const applied = await applyMatrixPlan(tools, style, plan)
    // Nothing to make is still an answer: one audit row says the matrix was asked for and was complete.
    if (applied.created.length === 0) tools.audit({ recordType: 'Style', recordId: styleId, companyId: locked.companyId, after: { skus: { created: [] } } })
    emitSkus(tools, style, applied)
    const codes = new Map(colourways.map((colourway) => [colourway.id, colourway.code]))
    return { dryRun: false, skus: describe(applied.created, codes), style: await styleViewInTx(tx, styleId) }
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('Another SKU was made at the same time: load the style and generate again.')
    throw error
  })
  return result
}

/**
 * product.styles.updateSku: one cell switched off (ARCHIVED) or on again (ACTIVE: only a cell the style offers, PRD-005),
 * and its barcode set, changed or removed (GTIN, check digit checked, unique in the tenant). Versioned per SKU.
 */
export async function updateSku(caller: CommandCaller, styleId: string, skuId: string, body: UpdateSkuBody, idempotencyKey?: string): Promise<StyleView> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId)
  openStyle(seen.status)
  if (!isUuid(skuId)) throw new NotFoundError('SKU not found.')
  const before = await caller.withClient((client) => client.variant.findUnique({ where: { id: skuId }, select: VARIANT_COLUMNS }))
  if (!before || before.styleId !== styleId) throw new NotFoundError('SKU not found.')
  let gtin: string | null | undefined
  if (body.gtin === null) gtin = null
  else if (body.gtin !== undefined) {
    const parsed = parseGtin(body.gtin)
    if (!parsed.ok) throw new ValidationError('The SKU is not valid.', [{ path: 'body/gtin', message: parsed.message }])
    gtin = parsed.gtin
  }
  if (gtin === undefined && body.status === undefined) return styleViewOf(seen, await caller.withClient((client) => readParts(client, seen)))

  const { result } = await command(caller, { name: 'product.styles.updateSku', idempotencyKey, input: { styleId, skuId, ...body } }, async (tools) => {
    const { tx } = tools
    const locked = await lockStyle(tx, styleId)
    openStyle(locked.status)
    await bumpVersion(tx, 'variant', skuId, body.version)
    const current = await tx.variant.findUniqueOrThrow({ where: { id: skuId }, select: VARIANT_COLUMNS })
    const move = body.status !== undefined && body.status !== current.status ? body.status : undefined
    if (move) {
      assertTransition(skuMachine, current.status, move)
      if (move === 'ACTIVE') {
        const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { sizes: true } })
        const colourways = await tx.colourway.findMany({ where: { styleId }, select: { id: true, code: true, status: true } })
        if (!isOffered(offerOf(style.sizes, colourways), current)) {
          throw new InvalidStateError(`SKU ${current.sku} is not offered: its colourway is archived or size ${current.size} is not in the range. Change the style first.`)
        }
      }
    }
    if (gtin !== undefined && gtin !== null && gtin !== current.gtin) {
      const holder = await tx.variant.findFirst({ where: { gtin, id: { not: skuId } }, select: { sku: true } })
      if (holder) throw new ConflictError(`GTIN ${gtin} is on SKU ${holder.sku} already.`)
    }
    const data = { ...(gtin === undefined ? {} : { gtin }), ...(move ? { status: move } : {}) }
    const shape = (row: { gtin: string | null; status: string }) => ({ ...(gtin === undefined ? {} : { gtin: row.gtin }), ...(move ? { status: row.status } : {}) })
    if (Object.keys(data).length > 0) await tx.variant.update({ where: { id: skuId }, data, select: { id: true } })
    tools.audit({ recordType: 'Variant', recordId: skuId, companyId: locked.companyId, before: { sku: current.sku, ...shape(current) }, after: { sku: current.sku, ...shape({ gtin: gtin === undefined ? current.gtin : gtin, status: move ?? current.status }) } })
    const style = { id: styleId, code: locked.code, companyId: locked.companyId }
    emitSkus(tools, style, { created: [], archived: move === 'ARCHIVED' ? 1 : 0, restored: move === 'ACTIVE' ? 1 : 0 }, gtin !== undefined ? 1 : 0)
    return styleViewInTx(tx, styleId)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('This GTIN is on another SKU already.')
    throw error
  })
  return result
}
