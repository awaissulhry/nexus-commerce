import { z } from 'zod'
import { PRODUCT_TYPES } from '@nexus/factory-domain/product/styles/rules'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The measurement templates a product type may name as its default (B-W2b-283, FU1:03): `GET /product/measurement-templates`
 * (product.styles.view; apps/factory-api modules/product/measures/templates.ts), every status, one page of 200 (a factory
 * keeps a handful). The template page itself is the made-to-measure office's (B-W2b-358).
 */

const templateRef = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  nameI18n: z.record(z.string(), z.string()),
  productType: z.enum(PRODUCT_TYPES),
  companyId: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  rulesOn: z.boolean(),
  points: z.number(),
})
export type TemplateRef = z.infer<typeof templateRef>

export const listMeasurementTemplates = (api: ApiClient, signal?: AbortSignal): Promise<TemplateRef[]> =>
  api.get('/product/measurement-templates', { query: { status: 'ALL', limit: 200 }, schema: z.object({ templates: z.array(templateRef), more: z.boolean() }), signal }).then((answer) => answer.templates)
