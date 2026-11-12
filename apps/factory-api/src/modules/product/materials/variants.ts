import { z } from 'zod'
import type { FactoryClient } from '@nexus/factory-db'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCT_MATERIALS_MANAGE } from '@nexus/factory-domain/product/materials/permissions'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { ITEM_KINDS, ITEM_TRACKINGS, materialMachine, type ItemKind, type ItemTracking } from '@nexus/factory-domain/product/materials/rules'
import { keepsVariantsApart, normalVariant, VARIANT_LIMITS, variantProblems, variantsForSize, type NormalVariant } from '@nexus/factory-domain/purchasing/line-kinds/variants'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { assertMayWrite, contextOf, isUniqueViolation, readMaterial, type MaterialRowData } from './store'

/**
 * Colour and size variants of one material (B-W2b-328; SCM-186: "W1 treats each trim colour and size as its own material";
 * factory-db buying-depth.prisma ItemVariant; the rules: factory-domain purchasing/line-kinds/variants). A zip in two
 * lengths and three colours, a protector in S, M and L: one material, each variant a code that a purchase order line, a lot
 * and (by its size) a BOM size line name. Office only, as the material itself (product.materials.view / .manage over the
 * material's company; a tenant-wide material by a role over every company). Never deleted: archived, and not while an
 * open purchase order line buys it (its lots must carry an active variant).
 *
 *   GET   /product/materials/:materialId/variants                      the variants, with their open order lines and lots
 *   POST  /product/materials/:materialId/variants {variants[]}          1 to 200 new ones (a colour × size grid at once)
 *   PATCH /product/materials/:materialId/variants/:variantId {version, supplierCode?, status?}
 *   GET   /product/materials/:materialId/variants/bom-sizes            the BOM size lines of the material and the variant each
 *                                                                        size uses (its size, its colour): no BOM column names
 *                                                                        a variant yet, so the rule decides
 *
 * Each write records an audit row per variant and one on its material, and material.updated (fields ["variants"]).
 */

// Orders that may still receive goods, or be changed and sent again (a declined one too).
const OPEN_ORDER_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'SENT', 'CHANGES_PROPOSED', 'CONFIRMED', 'PARTLY_RECEIVED', 'DECLINED'] as const

const variantView = output({
  id: id(),
  code: z.string(),
  itemColourId: id().nullable(),
  colour: output({ code: z.string(), name: z.string() }).nullable(),
  size: z.string().nullable(),
  supplierCode: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  /** Purchase order lines of open orders (not received, closed or cancelled) that buy it. */
  openOrderLines: z.number().int(),
  /** Lots of it (received on its lines). */
  lots: z.number().int(),
  version: z.number().int(),
  createdAt: instant(),
})

const variantsView = output({
  material: output({
    id: id(),
    code: z.string(),
    kind: z.enum(ITEM_KINDS),
    tracking: z.enum(ITEM_TRACKINGS),
    /** Tracked by lot (or hide, serial): each lot keeps its variant apart in stock; not tracked: one balance for all. */
    keepsVariantsApart: z.boolean(),
  }),
  variants: z.array(variantView),
})

const materialParams = input({ materialId: id() })
const draft = input({
  itemColourId: id().nullable().optional(),
  size: z.string().max(VARIANT_LIMITS.size + 20).nullable().optional(),
  code: z.string().max(VARIANT_LIMITS.code).nullable().optional(),
  supplierCode: z.string().max(VARIANT_LIMITS.supplierCode).nullable().optional(),
})

export const listVariantsContract = defineContract({ params: materialParams, querystring: input({ status: z.enum(['ACTIVE', 'ARCHIVED', 'all']).optional() }), response: { 200: variantsView } })
export const addVariantsContract = defineContract({ params: materialParams, body: input({ variants: z.array(draft).min(1).max(VARIANT_LIMITS.perCall) }), response: { 201: variantsView } })
export const updateVariantContract = defineContract({
  params: input({ materialId: id(), variantId: id() }),
  body: input({ version: z.number().int().min(1), supplierCode: z.string().max(VARIANT_LIMITS.supplierCode).nullable().optional(), status: z.enum(['ACTIVE', 'ARCHIVED']).optional() }),
  response: { 200: variantsView },
})
export const bomSizesContract = defineContract({
  params: materialParams,
  response: {
    200: output({
      material: output({ id: id(), code: z.string() }),
      lines: z.array(
        output({
          styleId: id(),
          styleCode: z.string(),
          revisionId: id(),
          revision: z.number().int(),
          revisionStatus: z.string(),
          bomLineId: id(),
          seq: z.number().int(),
          placement: z.string().nullable(),
          /** The line's colours: its own, or the colourway grid's (empty: any colour). */
          itemColourIds: z.array(id()),
          sizes: z.array(output({ size: z.string(), qty: z.string(), match: z.enum(['ONE', 'SEVERAL', 'NONE']), variantCodes: z.array(z.string()) })),
        }),
      ),
    }),
  },
})

type Reader = FactoryClient | CommandTx

const COLUMNS = { id: true, itemId: true, itemColourId: true, size: true, code: true, supplierCode: true, status: true, version: true, createdAt: true } as const

/** The variants of a material with their colours and use (open order lines, lots). */
async function variantsOf(db: Reader, material: MaterialRowData, status: 'ACTIVE' | 'ARCHIVED' | 'all' = 'all') {
  const rows = await db.itemVariant.findMany({ where: { itemId: material.id, ...(status === 'all' ? {} : { status }) }, select: COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const colourIds = [...new Set(rows.flatMap((row) => (row.itemColourId ? [row.itemColourId] : [])))]
  const colours = new Map(colourIds.length === 0 ? [] : (await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const codes = rows.map((row) => row.code)
  const lines = codes.length === 0 ? [] : await db.purchaseOrderLine.groupBy({ by: ['variantCode'], where: { itemId: material.id, variantCode: { in: codes }, cancelledAt: null, closedShortAt: null, purchaseOrder: { status: { in: [...OPEN_ORDER_STATUSES] } } }, _count: { _all: true } })
  const lots = codes.length === 0 ? [] : await db.lot.groupBy({ by: ['variantCode'], where: { itemId: material.id, variantCode: { in: codes } }, _count: { _all: true } })
  const linesOf = new Map(lines.map((row) => [row.variantCode, row._count._all]))
  const lotsOf = new Map(lots.map((row) => [row.variantCode, row._count._all]))
  return {
    material: { id: material.id, code: material.code, kind: material.kind as ItemKind, tracking: material.tracking as ItemTracking, keepsVariantsApart: keepsVariantsApart(material.tracking) },
    variants: rows.map((row) => {
      const colour = row.itemColourId ? (colours.get(row.itemColourId) ?? null) : null
      return {
        id: row.id,
        code: row.code,
        itemColourId: row.itemColourId,
        colour: colour ? { code: colour.code, name: colour.name } : null,
        size: row.size,
        supplierCode: row.supplierCode,
        status: row.status as 'ACTIVE' | 'ARCHIVED',
        openOrderLines: linesOf.get(row.code) ?? 0,
        lots: lotsOf.get(row.code) ?? 0,
        version: row.version,
        createdAt: toUtcIso(row.createdAt),
      }
    }),
  }
}

export type VariantsView = Awaited<ReturnType<typeof variantsOf>>

function changed(tools: CommandTools, material: MaterialRowData): void {
  tools.emit({ type: 'material.updated', subject: material.id, companyId: material.companyId, payload: { itemId: material.id, code: material.code, fields: ['variants'] } })
}

const variantAudit = (variant: Pick<NormalVariant, 'itemColourId' | 'size' | 'code' | 'supplierCode'> & { readonly status?: string }) => ({ code: variant.code, itemColourId: variant.itemColourId, size: variant.size, supplierCode: variant.supplierCode, ...(variant.status ? { status: variant.status } : {}) })

/** product.materials.view: the material's variants. */
export async function listVariants(caller: CommandCaller, materialId: string, query: { readonly status?: 'ACTIVE' | 'ARCHIVED' | 'all' | undefined }): Promise<VariantsView> {
  const material = await readMaterial(caller, materialId)
  return caller.withClient((client) => variantsOf(client, material, query.status ?? 'all'))
}

export interface VariantDraftBody {
  readonly itemColourId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly code?: string | null | undefined
  readonly supplierCode?: string | null | undefined
}

/** product.materials.manage: new variants of an active material (all or none). */
export async function addVariants(caller: CommandCaller, materialId: string, body: { readonly variants: readonly VariantDraftBody[] }, idempotencyKey?: string): Promise<VariantsView> {
  const context = contextOf(caller)
  const material = await readMaterial(caller, materialId)
  assertMayWrite(context, PRODUCT_MATERIALS_MANAGE, material.companyId)
  if (material.status !== 'ACTIVE') throw new InvalidStateError('This material is archived: reactivate it before adding variants.')
  const { result } = await command(caller, { name: 'product.materials.addVariants', idempotencyKey, input: { materialId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const colourIds = [...new Set(body.variants.flatMap((entry) => (entry.itemColourId ? [entry.itemColourId] : [])))]
    const colours = new Map((colourIds.length === 0 ? [] : await tx.itemColour.findMany({ where: { id: { in: colourIds.filter(isUuid) }, itemId: material.id }, select: { id: true, code: true, status: true } })).map((row) => [row.id, row]))
    const existing = await tx.itemVariant.findMany({ where: { itemId: material.id }, select: { code: true, itemColourId: true, size: true, status: true } })
    const problems: Issue[] = []
    const planned: NormalVariant[] = []
    const pairKey = (variant: { itemColourId: string | null; size: string | null }) => `${variant.itemColourId ?? '-'}|${(variant.size ?? '').replace(/\s+/g, '').toUpperCase()}`
    body.variants.forEach((entry, index) => {
      const at = `body/variants/${index}/`
      const colour = entry.itemColourId ? colours.get(entry.itemColourId) : undefined
      if (entry.itemColourId && !colour) {
        problems.push({ path: `${at}itemColourId`, message: 'Not a colour of this material.' })
        return
      }
      if (colour && colour.status !== 'ACTIVE') {
        problems.push({ path: `${at}itemColourId`, message: `Colour ${colour.code} is archived.` })
        return
      }
      const variant = normalVariant(entry, material, colour?.code ?? null)
      const shape = variantProblems(variant, at)
      if (shape.length > 0) {
        problems.push(...shape)
        return
      }
      if ([...existing, ...planned].some((other) => other.code === variant.code)) problems.push({ path: `${at}code`, message: `${material.code} has variant ${variant.code} already${existing.some((other) => other.code === variant.code && other.status === 'ARCHIVED') ? ' (archived: restore it instead)' : ''}.` })
      else if ([...existing.filter((other) => other.status === 'ACTIVE'), ...planned].some((other) => pairKey(other) === pairKey(variant))) problems.push({ path: `${at}size`, message: `${material.code} has an active variant of this colour and size already.` })
      else planned.push(variant)
    })
    if (problems.length > 0) {
      const taken = problems.every((issue) => /already/.test(issue.message))
      if (taken) throw new DomainError('conflict', problems[0]!.message, problems)
      throw new ValidationError(problems[0]!.message, problems)
    }
    const createdById = context.audience === 'office' ? context.actorId : null
    const rows = planned.map((variant) => ({ id: newId(), itemId: material.id, ...variant, createdAt: now, updatedAt: now, createdById }))
    await tx.itemVariant.createMany({ data: rows })
    for (const row of rows) tools.audit({ action: 'product.materials.addVariant', recordType: 'ItemVariant', recordId: row.id, companyId: material.companyId, after: variantAudit(row) })
    tools.audit({ action: 'product.materials.addVariants', recordType: 'Item', recordId: material.id, companyId: material.companyId, after: { variants: rows.map((row) => ({ id: row.id, ...variantAudit(row) })) } })
    changed(tools, material)
    return variantsOf(tx, material)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError(`${material.code} has one of these variant codes already.`)
    throw error
  })
  return result
}

/** product.materials.manage: a variant's supplier code, archived (no new use) or restored. */
export async function updateVariant(caller: CommandCaller, materialId: string, variantId: string, body: { readonly version: number; readonly supplierCode?: string | null | undefined; readonly status?: 'ACTIVE' | 'ARCHIVED' | undefined }, idempotencyKey?: string): Promise<VariantsView> {
  const context = contextOf(caller)
  const material = await readMaterial(caller, materialId)
  assertMayWrite(context, PRODUCT_MATERIALS_MANAGE, material.companyId)
  if (!isUuid(variantId)) throw new NotFoundError('Variant not found.')
  const before = await caller.withClient((client) => client.itemVariant.findUnique({ where: { id: variantId }, select: COLUMNS }))
  if (!before || before.itemId !== material.id) throw new NotFoundError('Variant not found.')
  if (body.supplierCode === undefined && body.status === undefined) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send the supplier code or the status.' }])
  const supplierCode = body.supplierCode === undefined ? before.supplierCode : body.supplierCode === null || body.supplierCode.trim() === '' ? null : body.supplierCode.trim()
  const shape = variantProblems({ itemColourId: before.itemColourId, size: before.size, code: before.code, supplierCode })
  if (shape.length > 0) throw new ValidationError(shape[0]!.message, shape)
  const move = body.status !== undefined && body.status !== before.status ? body.status : undefined
  if (move === 'ACTIVE' && material.status !== 'ACTIVE') throw new InvalidStateError('This material is archived: reactivate it before restoring its variants.')
  const { result } = await command(
    caller,
    {
      name: 'product.materials.updateVariant',
      idempotencyKey,
      input: { materialId, variantId, ...body },
      record: { type: 'ItemVariant', id: variantId, expectedVersion: body.version, ...(move ? { transition: { machine: materialMachine, to: move } } : {}) },
    },
    async (tools) => {
      const { tx } = tools
      if (move === 'ARCHIVED') {
        // Its lots must carry an active variant: an open order line that buys it keeps it active.
        const open = await tx.purchaseOrderLine.findMany({ where: { itemId: material.id, variantCode: before.code, cancelledAt: null, closedShortAt: null, purchaseOrder: { status: { in: [...OPEN_ORDER_STATUSES] } } }, select: { seq: true, purchaseOrder: { select: { number: true } } }, orderBy: [{ purchaseOrderId: 'asc' }, { seq: 'asc' }], take: 5 })
        if (open.length > 0) throw new ConflictError(`Variant ${before.code} is bought on open purchase orders (${open.map((line) => `${line.purchaseOrder.number} line ${line.seq}`).join(', ')}): receive, close or change them before archiving it.`)
      }
      if (supplierCode !== before.supplierCode) await tx.itemVariant.update({ where: { id: variantId }, data: { supplierCode }, select: { id: true } })
      const after = { ...before, supplierCode, status: move ?? before.status }
      tools.audit({ recordType: 'ItemVariant', recordId: variantId, companyId: material.companyId, before: variantAudit(before), after: variantAudit(after) })
      tools.audit({ action: 'product.materials.updateVariant', recordType: 'Item', recordId: material.id, companyId: material.companyId, before: { variant: { id: variantId, ...variantAudit(before) } }, after: { variant: { id: variantId, ...variantAudit(after) } } })
      changed(tools, material)
      return variantsOf(tx, material)
    },
  )
  return result
}

/**
 * product.materials.view and product.styles.view: the BOM size lines of the material in the styles the caller may see, and
 * the variant each size uses (the domain's rule).
 */
export async function bomSizes(caller: CommandCaller, materialId: string) {
  const material = await readMaterial(caller, materialId)
  const actor = actorOf(contextOf(caller))
  if (!can(actor, PRODUCT_STYLES_VIEW, {})) throw new ForbiddenError('The BOM lines of a material are read with product.styles.view.')
  return caller.withClient(async (db) => {
    const variants = await db.itemVariant.findMany({ where: { itemId: material.id }, select: COLUMNS, orderBy: [{ code: 'asc' }] })
    const lines = await db.bomLine.findMany({
      where: { itemId: material.id, sizeDependent: true, revision: { status: { in: ['DRAFT', 'RELEASED'] } } },
      select: {
        id: true,
        seq: true,
        placement: true,
        itemColourId: true,
        revisionId: true,
        styleId: true,
        revision: { select: { revision: true, status: true, style: { select: { code: true, companyId: true } } } },
        sizes: { select: { size: true, qty: true }, orderBy: [{ size: 'asc' }] },
        colours: { select: { itemColourId: true } },
      },
      orderBy: [{ styleId: 'asc' }, { revisionId: 'asc' }, { seq: 'asc' }],
      take: 500,
    })
    return {
      material: { id: material.id, code: material.code },
      lines: lines.filter((line) => can(actor, PRODUCT_STYLES_VIEW, { companyId: line.revision.style.companyId })).map((line) => {
        const colourIds = line.itemColourId ? [line.itemColourId] : [...new Set(line.colours.map((cell) => cell.itemColourId))]
        return {
          styleId: line.styleId,
          styleCode: line.revision.style.code,
          revisionId: line.revisionId,
          revision: line.revision.revision,
          revisionStatus: line.revision.status as string,
          bomLineId: line.id,
          seq: line.seq,
          placement: line.placement,
          itemColourIds: colourIds,
          sizes: line.sizes.map((row) => {
            const found = variantsForSize(variants, row.size, colourIds.length === 0 ? null : colourIds)
            return { size: row.size, qty: row.qty.toString(), match: found.match, variantCodes: found.variants.map((variant) => variant.code) }
          }),
        }
      }),
    }
  })
}
