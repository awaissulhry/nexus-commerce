import { z } from 'zod'
import type { Prisma } from '@nexus/factory-db'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { PRODUCT_TYPES } from '@nexus/factory-domain/product/styles/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from './store'

/**
 * The measurement templates, listed for pickers (B-W2b-283, follow-up FU1:03 of B-W2b-239 and -240): a product type's
 * default template is picked in Products › Settings, not only shown and cleared. The template page itself (its points,
 * its made-to-measure rules) is the made-to-measure office's (B-W2b-358).
 *
 *   GET /product/measurement-templates?productType&companyId&status&q&limit   product.styles.view (the style library's)
 *
 * The templates of the companies the caller sees with product.styles.view and every company's; `companyId` keeps those a
 * record of that company may name (its own and every company's, as the type's own check `fits`); `productType` one kind
 * of garment (a type names a template of its own kind); `status` ACTIVE (default), ARCHIVED or ALL. Each with how many
 * points it measures and whether its made-to-measure rules are on (GATE-MTM, B-W2b-248). By code; at most 200 (a factory
 * keeps a handful). Reads only; no money, no person.
 */

export const templatesQuery = input({
  productType: z.enum(PRODUCT_TYPES).optional(),
  companyId: id().optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ACTIVE'),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(200),
})
export type TemplatesQuery = z.output<typeof templatesQuery>

export const templateListView = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  nameI18n: z.record(z.string(), z.string()),
  productType: z.enum(PRODUCT_TYPES),
  /** null: every company's template. */
  companyId: id().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  /** Its made-to-measure rules are checked (off until the Owner starts them per template, GATE-MTM). */
  rulesOn: z.boolean(),
  /** The points it measures. */
  points: z.number().int(),
})
export type TemplateListView = z.infer<typeof templateListView>

export const listTemplatesContract = defineContract({
  querystring: templatesQuery,
  response: { 200: output({ templates: z.array(templateListView), more: z.boolean() }) },
})

const TEMPLATE_SELECT = { id: true, code: true, name: true, nameI18n: true, productType: true, companyId: true, status: true, rulesOn: true } as const satisfies Prisma.MeasurementTemplateSelect

const textsOf = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}

/** GET /product/measurement-templates */
export async function listTemplates(caller: CommandCaller, query: TemplatesQuery): Promise<{ templates: TemplateListView[]; more: boolean }> {
  const context = contextOf(caller)
  const actor = actorOf(context)
  if (query.companyId !== undefined && !can(actor, PRODUCT_STYLES_VIEW, { companyId: query.companyId })) throw new NotFoundError('Company not found.')
  const where: Prisma.MeasurementTemplateWhereInput = {
    AND: [
      scopeWhere(actor, PRODUCT_STYLES_VIEW, { company: { field: 'companyId', nullable: true } }) as Prisma.MeasurementTemplateWhereInput,
      query.companyId !== undefined ? { OR: [{ companyId: null }, { companyId: query.companyId }] } : {},
      query.productType ? { productType: query.productType } : {},
      query.status === 'ALL' ? {} : { status: query.status },
      query.q ? { OR: [{ code: { contains: query.q, mode: 'insensitive' } }, { name: { contains: query.q, mode: 'insensitive' } }] } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.measurementTemplate.findMany({ where, select: TEMPLATE_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: query.limit + 1 })
    const shown = rows.slice(0, query.limit)
    const counts = shown.length === 0 ? [] : await client.measurementPoint.groupBy({ by: ['templateId'], where: { templateId: { in: shown.map((row) => row.id) } }, _count: { _all: true } })
    const points = new Map(counts.map((row) => [row.templateId, row._count._all]))
    return {
      templates: shown.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        nameI18n: textsOf(row.nameI18n),
        productType: row.productType,
        companyId: row.companyId,
        status: row.status === 'ARCHIVED' ? ('ARCHIVED' as const) : ('ACTIVE' as const),
        rulesOn: row.rulesOn,
        points: points.get(row.id) ?? 0,
      })),
      more: rows.length > query.limit,
    }
  })
}
