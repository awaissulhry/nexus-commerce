import { z } from 'zod'
import { defineEvent } from '../events/define'
import { STYLE_LIFECYCLES } from '../product/lifecycle/rules'

/**
 * The style lifecycle, product types and product settings events (B-W2b-221; the code is factory-domain product/lifecycle,
 * product/types, product/settings). A module folder of its own, as textile-rules and production-lays (the event guard wants
 * `src/<module>/events.ts`). apps/factory-api's modules/product/{lifecycle,types,settings} emit them in the command that
 * makes the change; a style's type set or its replacing style named is W1's style.updated (with the field).
 *
 *   style.lifecycle_changed     a style moved from one lifecycle state to another (with the replacing style, when named)
 *   product_type.changed        a product type was added, changed, archived or restored
 *   product_settings.changed    the edit rules or the consumption tolerance of a company (or the tenant) changed
 *
 * Live on the style and settings screens for product.styles.view. Ids, codes and states only: no person, no money.
 */
export const PRODUCT_TYPE_CHANGES = ['CREATED', 'UPDATED', 'ARCHIVED', 'RESTORED'] as const

const live = { permission: 'product.styles.view' } as const

export const events = [
  defineEvent({
    type: 'style.lifecycle_changed',
    context: 'product-lifecycle',
    description: 'A style moved through its lifecycle (concept, development, sampling, approved, in production, phase out, discontinued).',
    payload: z.strictObject({ styleId: z.uuid(), code: z.string(), from: z.enum(STYLE_LIFECYCLES), to: z.enum(STYLE_LIFECYCLES), replacedById: z.uuid().nullable() }),
    live: { ...live, fields: ['styleId', 'code', 'from', 'to'] },
  }),
  defineEvent({
    type: 'product_type.changed',
    context: 'product-lifecycle',
    description: 'A product type was added, changed, archived or restored (its required attributes or the defaults its new styles take).',
    payload: z.strictObject({ productTypeId: z.uuid(), code: z.string(), change: z.enum(PRODUCT_TYPE_CHANGES) }),
    live: { ...live, fields: ['productTypeId', 'code', 'change'] },
  }),
  defineEvent({
    type: 'product_settings.changed',
    context: 'product-lifecycle',
    description: 'The edit rules per lifecycle state or the consumption tolerance of a company, or of every company, changed.',
    payload: z.strictObject({ companyId: z.uuid().nullable(), fields: z.array(z.string()) }),
    live: { ...live, fields: ['companyId', 'fields'] },
  }),
] as const
