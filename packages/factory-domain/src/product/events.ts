import { z } from 'zod'
import { defineEvent } from '../events/define'
import { DOCUMENT_KINDS } from './compliance/rules'
import { MATERIAL_STATUSES } from './materials/rules'
import { OPERATION_STATUSES } from './routing/operations'
import { REVISION_STATUSES } from './styles/revisions'
import { STYLE_STATUSES } from './styles/rules'

/**
 * The product module's events (plan A1 §3.4, §3.5). apps/factory-api's modules/product emits them in the transaction
 * that changes the record. The material ones (B-W1-09; PRD-028, PRD-032, GAP-006) refresh the material list and page
 * on the office screens that may see the material's company; the style ones (B-W1-11) the style list and page and the
 * size scale library; the BOM ones (B-W1-13) the BOM screen and the style's revisions; the routing ones (B-W1-14) the
 * routing tab and the operation library. Payloads carry ids and codes only: never a cost (a screen refetches what it
 * shows, with its viewer's grains).
 */

const live = { permission: 'product.materials.view', fields: ['itemId', 'code'] } as const
const styleLive = { permission: 'product.styles.view', fields: ['styleId', 'code'] } as const
const scaleLive = { permission: 'product.styles.view', fields: ['sizeScaleId', 'code'] } as const
const revisionLive = { permission: 'product.styles.view', fields: ['styleId', 'code', 'revisionId', 'revision'] } as const
const operationLive = { permission: 'product.routing.view', fields: ['operationId', 'code'] } as const
const complianceLive = { permission: 'compliance.certificates.view', fields: ['styleId', 'code', 'documentId', 'kind', 'language', 'revision'] } as const

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
    description: 'A style changed: its name, product type, brand, size range, base size, PPE classification, made-to-measure settings or how its garments are numbered (Q31).',
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
  // The routing of a revision and the operation library (B-W1-14; PRD-109, PRD-110, PRD-111): the routing tab, the
  // operation list and record. No money in a routing.
  defineEvent({
    type: 'style.routing_changed',
    context: 'product',
    description: "A draft revision's routing changed: steps added, changed, removed, reordered or copied from a released routing.",
    payload: z.strictObject({ styleId: z.uuid(), code: z.string(), revisionId: z.uuid(), revision: z.number().int(), stepIds: z.array(z.uuid()) }),
    live: { permission: 'product.routing.view', fields: ['styleId', 'code', 'revisionId', 'revision', 'stepIds'] },
  }),
  defineEvent({
    type: 'operation.created',
    context: 'product',
    description: 'An operation was added to the library.',
    payload: z.strictObject({ operationId: z.uuid(), code: z.string() }),
    live: operationLive,
  }),
  defineEvent({
    type: 'operation.updated',
    context: 'product',
    description: 'A library operation changed: its name, kind of work centre, machine, skill, instructions or standard minutes (routings keep their copy).',
    payload: z.strictObject({ operationId: z.uuid(), code: z.string(), fields: z.array(z.string()) }),
    live: { ...operationLive, fields: ['operationId', 'code', 'fields'] },
  }),
  defineEvent({
    type: 'operation.status_changed',
    context: 'product',
    description: 'A library operation was archived (in no new routing step) or reactivated.',
    payload: z.strictObject({ operationId: z.uuid(), code: z.string(), status: z.enum(OPERATION_STATUSES) }),
    live: { ...operationLive, fields: ['operationId', 'code', 'status'] },
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
  // The style's signed DoC and user information leaflet (B-W1-20; LOG-020; Reg. (EU) 2016/425 art. 8(7)(8), art. 15):
  // the style's Compliance tab, and the shipping step that sends the document with the goods (B-W1-49). Ids, the kind,
  // the language and the style revision number only.
  defineEvent({
    type: 'style.compliance_document_issued',
    context: 'product',
    description: "A style revision's signed Declaration of Conformity or user information leaflet in one language was confirmed and issued; the older revisions' ones in that language are superseded.",
    payload: z.strictObject({
      styleId: z.uuid(),
      code: z.string(),
      documentId: z.uuid(),
      kind: z.enum(DOCUMENT_KINDS),
      language: z.string(),
      revision: z.number().int().min(1),
      fileId: z.uuid(),
      supersededDocumentIds: z.array(z.uuid()),
    }),
    live: complianceLive,
  }),
  defineEvent({
    type: 'style.compliance_document_replaced',
    context: 'product',
    description: 'A new version of an issued Declaration of Conformity or user information leaflet was confirmed; the earlier file is kept.',
    payload: z.strictObject({
      styleId: z.uuid(),
      code: z.string(),
      documentId: z.uuid(),
      kind: z.enum(DOCUMENT_KINDS),
      language: z.string(),
      revision: z.number().int().min(1),
      fileId: z.uuid(),
      previousFileId: z.uuid().nullable(),
    }),
    live: complianceLive,
  }),
] as const
