import { z } from 'zod'
import { defineEvent } from '../events/define'
import { MATERIAL_STATUSES } from './materials/rules'

/**
 * The product module's events (plan A1 §3.4, §3.5). apps/factory-api's modules/product emits them in the transaction
 * that changes the record. The material ones (B-W1-09; PRD-028, PRD-032, GAP-006) refresh the material list and page
 * on the office screens that may see the material's company; later product steps (styles, BOMs, routings) add theirs
 * here. Payloads carry ids and codes only: never a cost (a screen refetches what it shows, with its viewer's grains).
 */

const live = { permission: 'product.materials.view', fields: ['itemId', 'code'] } as const

export const events = [
  defineEvent({
    type: 'material.created',
    context: 'product',
    description: 'A material was added to the library (by hand or by an import).',
    payload: z.strictObject({ itemId: z.uuid(), code: z.string() }),
    live,
  }),
  defineEvent({
    type: 'material.updated',
    context: 'product',
    description: 'A material changed: its name, units, make or buy, tracking, supplier, leather or Cr VI settings.',
    payload: z.strictObject({ itemId: z.uuid(), code: z.string(), fields: z.array(z.string()) }),
    live,
  }),
  defineEvent({
    type: 'material.status_changed',
    context: 'product',
    description: 'A material was archived (no new use) or reactivated.',
    payload: z.strictObject({ itemId: z.uuid(), code: z.string(), status: z.enum(MATERIAL_STATUSES) }),
    live: { ...live, fields: ['itemId', 'code', 'status'] },
  }),
  defineEvent({
    type: 'material.colours_changed',
    context: 'product',
    description: 'A colour of a material was added, changed, removed or restored.',
    payload: z.strictObject({ itemId: z.uuid(), code: z.string(), itemColourIds: z.array(z.uuid()) }),
    live,
  }),
  defineEvent({
    type: 'material.standard_cost_changed',
    context: 'product',
    description: "A material's standard purchase price was set, changed or removed (the value is in the audit row, for the cost grain).",
    payload: z.strictObject({ itemId: z.uuid(), code: z.string() }),
    live,
  }),
] as const
