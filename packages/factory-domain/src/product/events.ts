import { z } from 'zod'
import { defineEvent } from '../events/define'
import { MATERIAL_STATUSES } from './materials/rules'
import { REVISION_STATUSES } from './styles/revisions'
import { STYLE_STATUSES } from './styles/rules'

/**
 * The product module's events (plan A1 §3.4, §3.5). apps/factory-api's modules/product emits them in the transaction
 * that changes the record. The material ones (B-W1-09; PRD-028, PRD-032, GAP-006) refresh the material list and page
 * on the office screens that may see the material's company; the style ones (B-W1-11) the style list and page and the
 * size scale library; the BOM ones (B-W1-13) the BOM screen and the style's revisions; later product steps (routings)
 * add theirs here. Payloads carry ids and codes only: never a cost (a screen refetches what it shows, with its viewer's
 * grains).
 */

const live = { permission: 'product.materials.view', fields: ['itemId', 'code'] } as const
const styleLive = { permission: 'product.styles.view', fields: ['styleId', 'code'] } as const
const scaleLive = { permission: 'product.styles.view', fields: ['sizeScaleId', 'code'] } as const
const revisionLive = { permission: 'product.styles.view', fields: ['styleId', 'code', 'revisionId', 'revision'] } as const

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
  // Styles and size scales (B-W1-11; PRD-001, PRD-004, PRD-005, PRD-047, PRD-048): the style list and page, the size
  // scale library. No money in a style.
  defineEvent({
    type: 'style.created',
    context: 'product',
    description: 'A style was added, with its colourways and size range.',
    payload: z.strictObject({ styleId: z.uuid(), code: z.string() }),
    live: styleLive,
  }),
  defineEvent({
    type: 'style.updated',
    context: 'product',
    description: 'A style changed: its name, product type, brand, size range, base size, PPE classification or made-to-measure settings.',
    payload: z.strictObject({ styleId: z.uuid(), code: z.string(), fields: z.array(z.string()) }),
    live: styleLive,
  }),
  defineEvent({
    type: 'style.status_changed',
    context: 'product',
    description: 'A style was archived (no new use) or reactivated.',
    payload: z.strictObject({ styleId: z.uuid(), code: z.string(), status: z.enum(STYLE_STATUSES) }),
    live: { ...styleLive, fields: ['styleId', 'code', 'status'] },
  }),
  defineEvent({
    type: 'style.colourways_changed',
    context: 'product',
    description: 'A colourway of a style was added, renamed, archived or restored.',
    payload: z.strictObject({ styleId: z.uuid(), code: z.string(), colourwayIds: z.array(z.uuid()) }),
    live: styleLive,
  }),
  defineEvent({
    type: 'style.skus_changed',
    context: 'product',
    description: "SKUs of a style's colour x size matrix were made, switched on or off, or given a barcode.",
    payload: z.strictObject({ styleId: z.uuid(), code: z.string(), created: z.number().int(), archived: z.number().int(), restored: z.number().int(), updated: z.number().int() }),
    live: styleLive,
  }),
  defineEvent({
    type: 'style.revision_created',
    context: 'product',
    description: 'A DRAFT revision of a style was started (its BOM, routing and label are edited in it).',
    payload: z.strictObject({ styleId: z.uuid(), code: z.string(), revisionId: z.uuid(), revision: z.number().int() }),
    live: { ...styleLive, fields: ['styleId', 'code', 'revisionId', 'revision'] },
  }),
  // The BOM of a revision and its release (B-W1-13; PRD-043, PRD-076, PRD-079, PRD-082, PRD-100): the BOM screen, the
  // style's revisions and status. No money in a BOM.
  defineEvent({
    type: 'style.bom_changed',
    context: 'product',
    description: "A draft revision's BOM changed: a line added, changed or removed, its size quantities or colour grid, or the planned hide yield.",
    payload: z.strictObject({ styleId: z.uuid(), code: z.string(), revisionId: z.uuid(), revision: z.number().int(), lineIds: z.array(z.uuid()) }),
    live: { permission: 'product.bom.view', fields: ['styleId', 'code', 'revisionId', 'revision', 'lineIds'] },
  }),
  defineEvent({
    type: 'style.revision_released',
    context: 'product',
    description: "A revision was released: its BOM, routing and label are frozen and it is the style's current one (the previous one is obsolete).",
    payload: z.strictObject({ styleId: z.uuid(), code: z.string(), revisionId: z.uuid(), revision: z.number().int(), obsoletedRevisionId: z.uuid().nullable() }),
    live: revisionLive,
  }),
  defineEvent({
    type: 'style.revision_obsoleted',
    context: 'product',
    description: 'A draft revision was abandoned, or a released one withdrawn without a replacement.',
    payload: z.strictObject({ styleId: z.uuid(), code: z.string(), revisionId: z.uuid(), revision: z.number().int(), from: z.enum(REVISION_STATUSES) }),
    live: revisionLive,
  }),
  defineEvent({
    type: 'size_scale.created',
    context: 'product',
    description: 'A size scale was added to the library.',
    payload: z.strictObject({ sizeScaleId: z.uuid(), code: z.string() }),
    live: scaleLive,
  }),
  defineEvent({
    type: 'size_scale.changed',
    context: 'product',
    description: 'A size scale changed: its name or code, its sizes (added, edited, reordered, archived, restored) or its status.',
    payload: z.strictObject({ sizeScaleId: z.uuid(), code: z.string() }),
    live: scaleLive,
  }),
] as const
