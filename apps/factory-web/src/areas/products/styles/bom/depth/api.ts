import { z } from 'zod'
import { bomStructureView, usedInView, type BomStructureView, type UsedInView } from '@nexus/factory-domain/product/bom-structure/contracts'
import { bomDepthView, type BomDepthView } from '@nexus/factory-domain/product/bom-lines/contracts'
import { lineOptionView, styleOptionsView, type LineOptionView, type StyleOptionsView } from '@nexus/factory-domain/product/options/contracts'
import type { AlternateUse } from '@nexus/factory-domain/product/bom-lines/rules'
import type { BomSection } from '@nexus/factory-domain/product/bom-structure/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'

/**
 * Every call of the BOM in depth (B-W2b-241 on B-W2b-223's, B-W2b-228's and B-W2b-229's API; design products.styles ›
 * Materials (BOM): the Section column and group rows, the Sub-assemblies tree, Alternates, Customer-supplied and Option,
 * the BOM check): the structure of a revision (its sections, group rows, sub-assembly tree and THE check), its lines in
 * depth (alternates, who sends a line, the workshop's kit), the options the style offers, where the style is used as a
 * sub-assembly — and the writes, each at the REVISION's version (a revision's BOM, routing and pieces are one versioned
 * record: every write moves it by one) with an idempotency key. Every answer is checked against factory-domain's own
 * contracts. No money.
 */

export type { BomDepthView, BomStructureView, LineOptionView, StyleOptionsView, UsedInView }
export type StructureLine = BomStructureView['lines'][number]
export type TreeNode = BomStructureView['tree'][number]
export type CheckItem = BomStructureView['check']['blockers'][number]
export type DepthLine = BomDepthView['lines'][number]
export type Alternate = DepthLine['alternates'][number]
export type OfferView = StyleOptionsView['offers'][number]
export type RevisionRef = { id: string; version: number }

const enc = encodeURIComponent
const revisionPath = (styleId: string, revisionId: string) => `/product/styles/${enc(styleId)}/revisions/${enc(revisionId)}`
const linePath = (styleId: string, revisionId: string, lineId: string) => `${revisionPath(styleId, revisionId)}/bom/lines/${enc(lineId)}`
const key = () => ({ idempotencyKey: newIdempotencyKey() })

const structureAnswer = z.object({ structure: bomStructureView })
const depthAnswer = z.object({ depth: bomDepthView })

// ---- reads ---------------------------------------------------------------------------------------------------------------

/** GET …/bom/structure (product.bom.view): lines in grouped order, sections, the sub-assembly tree, THE check. */
export const getStructure = (api: ApiClient, styleId: string, revisionId: string): Promise<BomStructureView> =>
  api.get(`${revisionPath(styleId, revisionId)}/bom/structure`, { schema: structureAnswer }).then((answer) => answer.structure)

/** GET …/bom/depth (product.bom.view): every line's alternates, who sends it, the workshop's kit. */
export const getDepth = (api: ApiClient, styleId: string, revisionId: string): Promise<BomDepthView> =>
  api.get(`${revisionPath(styleId, revisionId)}/bom/depth`, { schema: depthAnswer }).then((answer) => answer.depth)

/** GET /product/styles/:styleId/options (product.styles.view): the offers (their values a line may be for) and the option lines. */
export const getStyleOptions = (api: ApiClient, styleId: string): Promise<StyleOptionsView> =>
  api.get(`/product/styles/${enc(styleId)}/options`, { schema: z.object({ options: styleOptionsView }) }).then((answer) => answer.options)

/** GET /product/styles/:styleId/used-in (product.bom.view): the revisions of other styles that take this style as a sub-assembly. */
export const getUsedIn = (api: ApiClient, styleId: string): Promise<UsedInView> =>
  api.get(`/product/styles/${enc(styleId)}/used-in`, { schema: z.object({ usedIn: usedInView }) }).then((answer) => answer.usedIn)

/** A customer or brand that may send a line's material (parties.view): `role=CUSTOMER,BRAND`, active. */
const partyRow = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })
export type PartyRow = z.infer<typeof partyRow>

export const findCustomers = (api: ApiClient, q: string): Promise<PartyRow[]> =>
  api
    .get('/parties', { query: { q: q.trim() || undefined, role: 'CUSTOMER,BRAND', status: 'ACTIVE', limit: 20 }, schema: z.object({ parties: z.array(partyRow) }) })
    .then((answer) => answer.parties)

// ---- the structure (B-W2b-223) ---------------------------------------------------------------------------------------------

export interface StructureBody {
  section?: BomSection | null
  parentLineId?: string | null
  subAssembly?: { styleId: string; revisionId: string } | null
}

/** PUT …/bom/lines/:lineId/structure (product.bom.manage): one line's section, group row or sub-assembly; what is left out stays. */
export const setLineStructure = (api: ApiClient, styleId: string, revision: RevisionRef, lineId: string, body: StructureBody): Promise<BomStructureView> =>
  api.request('PUT', `${linePath(styleId, revision.id, lineId)}/structure`, { body: { version: revision.version, ...body }, schema: structureAnswer, ...key() }).then((answer) => answer.structure)

/** POST …/bom/structure/change (product.bom.manage): the selection filed under one section and/or grouped under one line. */
export const changeStructure = (api: ApiClient, styleId: string, revision: RevisionRef, lineIds: readonly string[], body: Omit<StructureBody, 'subAssembly'>): Promise<BomStructureView> =>
  api.post(`${revisionPath(styleId, revision.id)}/bom/structure/change`, { body: { version: revision.version, lineIds, ...body }, schema: structureAnswer, ...key() }).then((answer) => answer.structure)

// ---- lines in depth (B-W2b-228) ---------------------------------------------------------------------------------------------

export interface SupplyBody {
  customerSuppliedByPartyId?: string | null
  issueToSubcontract?: boolean
}

/** PUT …/bom/lines/:lineId/supply (product.bom.manage): who sends the line's material, whether it goes to the workshop. */
export const setSupply = (api: ApiClient, styleId: string, revision: RevisionRef, lineId: string, body: SupplyBody): Promise<BomDepthView> =>
  api.request('PUT', `${linePath(styleId, revision.id, lineId)}/supply`, { body: { version: revision.version, ...body }, schema: depthAnswer, ...key() }).then((answer) => answer.depth)

/** POST …/bom/supply/change (product.bom.manage): the selection's customer and/or workshop mark at once. */
export const changeSupply = (api: ApiClient, styleId: string, revision: RevisionRef, lineIds: readonly string[], body: SupplyBody): Promise<BomDepthView> =>
  api.post(`${revisionPath(styleId, revision.id)}/bom/supply/change`, { body: { version: revision.version, lineIds, ...body }, schema: depthAnswer, ...key() }).then((answer) => answer.depth)

export interface AlternateBody {
  itemId?: string
  itemColourId?: string | null
  /** In the line's unit, per output unit; null: the line's own quantity. */
  qty?: string | null
  allowedWhen?: AlternateUse
  certificateCheck?: boolean
  note?: string | null
}

/** POST …/lines/:lineId/alternates (product.bom.manage): a new alternate after the last one (201). */
export const addAlternate = (api: ApiClient, styleId: string, revision: RevisionRef, lineId: string, body: AlternateBody & { itemId: string }): Promise<BomDepthView> =>
  api.post(`${linePath(styleId, revision.id, lineId)}/alternates`, { body: { version: revision.version, ...body }, schema: depthAnswer, ...key() }).then((answer) => answer.depth)

/** PATCH …/alternates/:alternateId (product.bom.manage): only what it names. */
export const updateAlternate = (api: ApiClient, styleId: string, revision: RevisionRef, lineId: string, alternateId: string, body: AlternateBody): Promise<BomDepthView> =>
  api
    .request('PATCH', `${linePath(styleId, revision.id, lineId)}/alternates/${enc(alternateId)}`, { body: { version: revision.version, ...body }, schema: depthAnswer, ...key() })
    .then((answer) => answer.depth)

/** DELETE …/alternates/:alternateId?version= (product.bom.manage): the ones after it move up. */
export const removeAlternate = (api: ApiClient, styleId: string, revision: RevisionRef, lineId: string, alternateId: string): Promise<BomDepthView> =>
  api
    .request('DELETE', `${linePath(styleId, revision.id, lineId)}/alternates/${enc(alternateId)}`, { query: { version: revision.version }, schema: depthAnswer, ...key() })
    .then((answer) => answer.depth)

/** PUT …/lines/:lineId/alternate-order (product.bom.manage): every alternate once, the first is priority 1. */
export const orderAlternates = (api: ApiClient, styleId: string, revision: RevisionRef, lineId: string, alternateIds: readonly string[]): Promise<BomDepthView> =>
  api
    .request('PUT', `${linePath(styleId, revision.id, lineId)}/alternate-order`, { body: { version: revision.version, alternateIds }, schema: depthAnswer, ...key() })
    .then((answer) => answer.depth)

// ---- option lines (B-W2b-229) ----------------------------------------------------------------------------------------------

/** PUT …/bom/lines/:lineId/option (product.bom.manage): the line only for one option the style offers, or for every garment (null). */
export const setLineOption = (api: ApiClient, styleId: string, revision: RevisionRef, lineId: string, optionValueId: string | null): Promise<LineOptionView> =>
  api.request('PUT', `${linePath(styleId, revision.id, lineId)}/option`, { body: { version: revision.version, optionValueId }, schema: lineOptionView, ...key() })
