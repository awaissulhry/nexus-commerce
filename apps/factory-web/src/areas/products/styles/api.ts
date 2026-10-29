import { z } from 'zod'
import { costDiffView, costSheetView, type CostDiffView, type CostSheetView } from '@nexus/factory-domain/costing/contracts'
import { bomView, type BomView } from '@nexus/factory-domain/product/bom/contracts'
import { complianceDocumentDetail, styleComplianceView, type ComplianceDocumentDetail, type StyleComplianceView } from '@nexus/factory-domain/product/compliance/contracts'
import { materialRow, materialView, type MaterialRow, type MaterialView } from '@nexus/factory-domain/product/materials/contracts'
import { operationRow, routingView, type OperationRow, type RoutingView } from '@nexus/factory-domain/product/routing/contracts'
import { scaleRow, type ScaleRow } from '@nexus/factory-domain/product/sizes/contracts'
import { colourRow, generatedSkus, revisionView, styleRow, styleView, type ColourRow, type GeneratedSkus, type RevisionView, type StyleRow, type StyleView } from '@nexus/factory-domain/product/styles/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../record-panels/api'

/**
 * Every call the Styles list and the Style studio make (SCR-040 … SCR-045), each answer checked against the API's own
 * contract (factory-domain): product/styles (styles, colourways, SKUs, revisions, the colour library), product/sizes
 * (scales), product/bom (the BOM, release, copy, abandon), product/routing (the routing and the operation library),
 * costing (the cost sheet and its comparison), product/compliance (the Compliance tab and the DoC / leaflet files),
 * compliance/labels (a draft revision names its garment label). Money fields are optional in those contracts: the API
 * drops them for a person without the grain, and the screens draw "not in your role", never 0.
 *
 * Every write sends the version it was made on (COL-078) and an idempotency key; a 409 reads the record again.
 */

export type { BomView, ColourRow, ComplianceDocumentDetail, CostDiffView, CostSheetView, GeneratedSkus, MaterialRow, MaterialView, OperationRow, RevisionView, RoutingView, ScaleRow, StyleComplianceView, StyleRow, StyleView }
export type BomLine = BomView['lines'][number]
export type RoutingStep = RoutingView['steps'][number]
export type CostCell = CostSheetView['cells'][number]
export type MissingInput = CostSheetView['missing'][number]
export type CoverageCell = StyleComplianceView['coverage']['cells'][number]
export type ComplianceCheck = StyleComplianceView['checks'][number]
export type LanguageStatus = StyleComplianceView['documents']['declarations'][number]
export type ColourwayView = StyleView['colourways'][number]
export type MatrixRow = StyleView['matrix']['rows'][number]

const enc = encodeURIComponent
const stylePath = (styleId: string) => `/product/styles/${enc(styleId)}`
const revisionPath = (styleId: string, revisionId: string) => `${stylePath(styleId)}/revisions/${enc(revisionId)}`
const key = () => ({ idempotencyKey: newIdempotencyKey() })

// ---- the list (SCR-040) -------------------------------------------------------------------------------------------------

export interface StyleQuery {
  q?: string
  status?: 'OPEN' | 'DRAFT' | 'ACTIVE' | 'ARCHIVED' | 'ALL'
  draftRevision?: boolean
  productType?: string
  ppeCategory?: string
  limit?: number
  cursor?: string | null
}

const stylePage = z.object({ styles: z.array(styleRow), nextCursor: z.string().nullable(), count: z.number().int() })
export type StylePage = z.infer<typeof stylePage>

export function listStyles(api: ApiClient, query: StyleQuery): Promise<StylePage> {
  return api.get('/product/styles', {
    query: {
      q: query.q?.trim() || undefined,
      status: query.status ?? 'OPEN',
      draftRevision: query.draftRevision === undefined ? undefined : String(query.draftRevision),
      productType: query.productType || undefined,
      ppeCategory: query.ppeCategory || undefined,
      limit: query.limit ?? 50,
      cursor: query.cursor ?? undefined,
    },
    schema: stylePage,
  })
}

/** How many styles a saved filter holds (the tile's number is the list's total under that filter). */
export async function countStyles(api: ApiClient, query: StyleQuery): Promise<number> {
  return (await listStyles(api, { ...query, limit: 1, cursor: null })).count
}

const oneStyle = z.object({ style: styleView })

export function getStyle(api: ApiClient, styleId: string): Promise<StyleView> {
  return api.get(stylePath(styleId), { schema: oneStyle }).then((answer) => answer.style)
}

export interface NewStyleInput {
  companyId: string | null
  code: string
  name: string
  productType: StyleView['productType']
  season: string | null
  brandPartyId: string | null
  sizeScaleId: string
  sizes: string[]
  baseSize: string | null
  ppeCategory: StyleView['ppeCategory']
  ppeStandard: string | null
  ppeClass: string | null
  mtmAllowed: boolean
}

export function createStyle(api: ApiClient, input: NewStyleInput): Promise<StyleView> {
  return api.post('/product/styles', { body: input, schema: oneStyle, ...key() }).then((answer) => answer.style)
}

export type StylePatch = Partial<Pick<NewStyleInput, 'code' | 'name' | 'productType' | 'season' | 'brandPartyId' | 'sizeScaleId' | 'sizes' | 'baseSize' | 'ppeCategory' | 'ppeStandard' | 'ppeClass' | 'mtmAllowed'>> & { description?: string | null }

export function updateStyle(api: ApiClient, style: Pick<StyleView, 'id' | 'version'>, patch: StylePatch): Promise<StyleView> {
  return api.request('PATCH', stylePath(style.id), { body: { ...patch, version: style.version }, schema: oneStyle, ...key() }).then((answer) => answer.style)
}

export function archiveStyle(api: ApiClient, style: Pick<StyleView, 'id' | 'version'> | Pick<StyleRow, 'id' | 'version'>, reason?: string): Promise<StyleView> {
  return api.post(`${stylePath(style.id)}/archive`, { body: { version: style.version, ...(reason ? { reason } : {}) }, schema: oneStyle, ...key() }).then((answer) => answer.style)
}

export function reactivateStyle(api: ApiClient, style: Pick<StyleView, 'id' | 'version'>): Promise<StyleView> {
  return api.post(`${stylePath(style.id)}/reactivate`, { body: { version: style.version }, schema: oneStyle, ...key() }).then((answer) => answer.style)
}

/** How the garments are numbered on their labels (Q31): the batch number, or one serial per garment. */
export function setGarmentTracking(api: ApiClient, style: Pick<StyleView, 'id' | 'version'>, tracking: StyleView['garmentTracking']): Promise<StyleView> {
  return api.request('PUT', `${stylePath(style.id)}/garment-tracking`, { body: { version: style.version, tracking }, schema: oneStyle, ...key() }).then((answer) => answer.style)
}

// ---- colourways and SKUs (SCR-041) ------------------------------------------------------------------------------------

export interface ColourwayInput {
  code: string
  name: string
  colourId: string | null
  description: string | null
}

export function addColourway(api: ApiClient, styleId: string, input: ColourwayInput): Promise<StyleView> {
  return api.post(`${stylePath(styleId)}/colourways`, { body: input, schema: oneStyle, ...key() }).then((answer) => answer.style)
}

export function updateColourway(
  api: ApiClient,
  styleId: string,
  colourway: Pick<ColourwayView, 'id' | 'version'>,
  patch: Partial<ColourwayInput> & { status?: 'ACTIVE' | 'ARCHIVED' },
): Promise<StyleView> {
  return api
    .request('PATCH', `${stylePath(styleId)}/colourways/${enc(colourway.id)}`, { body: { ...patch, version: colourway.version }, schema: oneStyle, ...key() })
    .then((answer) => answer.style)
}

export function generateSkus(api: ApiClient, styleId: string, dryRun: boolean): Promise<GeneratedSkus> {
  return api.post(`${stylePath(styleId)}/skus/generate`, { body: { dryRun }, schema: generatedSkus, ...key() })
}

export function updateSku(api: ApiClient, styleId: string, sku: { id: string; version: number }, patch: { status?: 'ACTIVE' | 'ARCHIVED'; gtin?: string | null }): Promise<StyleView> {
  return api.request('PATCH', `${stylePath(styleId)}/skus/${enc(sku.id)}`, { body: { ...patch, version: sku.version }, schema: oneStyle, ...key() }).then((answer) => answer.style)
}

// ---- revisions ----------------------------------------------------------------------------------------------------------

const oneRevision = z.object({ revision: revisionView })

/** The first revision of a new style (an empty draft: its BOM, routing and label come next). */
export function startRevision(api: ApiClient, styleId: string, changeNote?: string): Promise<RevisionView> {
  return api.post(`${stylePath(styleId)}/revisions`, { body: changeNote ? { changeNote } : {}, schema: oneRevision, ...key() }).then((answer) => answer.revision)
}

const oneBom = z.object({ bom: bomView })

/** A frozen revision copied into the style's next revision, a draft (its BOM lines, routing and label with it). */
export function copyRevision(api: ApiClient, styleId: string, fromRevisionId: string, changeNote?: string): Promise<BomView> {
  return api.post(`${revisionPath(styleId, fromRevisionId)}/copy`, { body: changeNote ? { changeNote } : {}, schema: oneBom, ...key() }).then((answer) => answer.bom)
}

export function releaseRevision(api: ApiClient, styleId: string, revision: { id: string; version: number }, changeNote?: string): Promise<BomView> {
  return api
    .post(`${revisionPath(styleId, revision.id)}/release`, { body: { version: revision.version, ...(changeNote ? { changeNote } : {}) }, schema: oneBom, ...key() })
    .then((answer) => answer.bom)
}

/** A draft abandoned (or a released revision withdrawn while the style is not active). */
export function obsoleteRevision(api: ApiClient, styleId: string, revision: { id: string; version: number }, reason?: string): Promise<BomView> {
  return api
    .post(`${revisionPath(styleId, revision.id)}/obsolete`, { body: { version: revision.version, ...(reason ? { reason } : {}) }, schema: oneBom, ...key() })
    .then((answer) => answer.bom)
}

// ---- libraries ----------------------------------------------------------------------------------------------------------

const scalePage = z.object({ scales: z.array(scaleRow), nextCursor: z.string().nullable(), count: z.number().int() })

export function listScales(api: ApiClient, companyId: string | null): Promise<ScaleRow[]> {
  return api.get('/product/size-scales', { query: { status: 'ACTIVE', limit: 200, companyId: companyId ?? undefined }, schema: scalePage }).then((answer) => answer.scales)
}

const colourList = z.object({ colours: z.array(colourRow) })

export function listColours(api: ApiClient, companyId: string | null): Promise<ColourRow[]> {
  return api.get('/product/colours', { query: { limit: 500, companyId: companyId ?? undefined }, schema: colourList }).then((answer) => answer.colours)
}

/** A brand (a party with the BRAND role), as a private-label style names it. */
const brandRow = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })
export type BrandRow = z.infer<typeof brandRow>
const brandPage = z.object({ parties: z.array(brandRow) })

export function listBrands(api: ApiClient): Promise<BrandRow[]> {
  return api.get('/parties', { query: { role: 'BRAND', status: 'ACTIVE', limit: 200 }, schema: brandPage }).then((answer) => answer.parties)
}

const materialPage = z.object({ materials: z.array(materialRow), nextCursor: z.string().nullable(), count: z.number().int() })

export function findMaterials(api: ApiClient, q: string, companyId: string | null): Promise<MaterialRow[]> {
  return api.get('/product/materials', { query: { q: q.trim() || undefined, limit: 20, companyId: companyId ?? undefined }, schema: materialPage }).then((answer) => answer.materials)
}

const oneMaterial = z.object({ material: materialView })

export function getMaterial(api: ApiClient, materialId: string): Promise<MaterialView> {
  return api.get(`/product/materials/${enc(materialId)}`, { schema: oneMaterial }).then((answer) => answer.material)
}

const operationPage = z.object({ operations: z.array(operationRow), nextCursor: z.string().nullable(), count: z.number().int() })

export function findOperations(api: ApiClient, q: string, kind: string | null, companyId: string | null): Promise<OperationRow[]> {
  return api
    .get('/product/operations', { query: { q: q.trim() || undefined, kind: kind ?? undefined, limit: 100, companyId: companyId ?? undefined }, schema: operationPage })
    .then((answer) => answer.operations)
}

// ---- the BOM (SCR-042) --------------------------------------------------------------------------------------------------

export function getBom(api: ApiClient, styleId: string, revisionId: string): Promise<BomView> {
  return api.get(`${revisionPath(styleId, revisionId)}/bom`, { schema: oneBom }).then((answer) => answer.bom)
}

export interface BomLineInput {
  itemId?: string
  placement?: string | null
  uom?: BomLine['uom']
  qty?: string
  wastagePct?: string
  sizeDependent?: boolean
  sizes?: Array<{ size: string; qty: string | null }>
  colourDependent?: boolean
  itemColourId?: string | null
  colours?: Array<{ colourwayId: string; itemColourId: string | null }>
  colourwayId?: string | null
  note?: string | null
}

export function addBomLine(api: ApiClient, styleId: string, revision: { id: string; version: number }, input: BomLineInput & { itemId: string }): Promise<BomView> {
  return api.post(`${revisionPath(styleId, revision.id)}/bom/lines`, { body: { ...input, version: revision.version }, schema: oneBom, ...key() }).then((answer) => answer.bom)
}

export function updateBomLine(api: ApiClient, styleId: string, revision: { id: string; version: number }, lineId: string, input: BomLineInput): Promise<BomView> {
  return api
    .request('PATCH', `${revisionPath(styleId, revision.id)}/bom/lines/${enc(lineId)}`, { body: { ...input, version: revision.version }, schema: oneBom, ...key() })
    .then((answer) => answer.bom)
}

export function removeBomLine(api: ApiClient, styleId: string, revision: { id: string; version: number }, lineId: string): Promise<BomView> {
  return api
    .request('DELETE', `${revisionPath(styleId, revision.id)}/bom/lines/${enc(lineId)}`, { query: { version: revision.version }, schema: oneBom, ...key() })
    .then((answer) => answer.bom)
}

export function setBomSizes(api: ApiClient, styleId: string, revision: { id: string; version: number }, lineId: string, sizes: Array<{ size: string; qty: string | null }>): Promise<BomView> {
  return api
    .request('PUT', `${revisionPath(styleId, revision.id)}/bom/lines/${enc(lineId)}/sizes`, { body: { version: revision.version, sizes }, schema: oneBom, ...key() })
    .then((answer) => answer.bom)
}

export function setBomColours(api: ApiClient, styleId: string, revision: { id: string; version: number }, lineId: string, colours: Array<{ colourwayId: string; itemColourId: string | null }>): Promise<BomView> {
  return api
    .request('PUT', `${revisionPath(styleId, revision.id)}/bom/lines/${enc(lineId)}/colours`, { body: { version: revision.version, colours }, schema: oneBom, ...key() })
    .then((answer) => answer.bom)
}

export function updateRevision(api: ApiClient, styleId: string, revision: { id: string; version: number }, patch: { changeNote?: string | null; plannedHideYieldPct?: string | null }): Promise<BomView> {
  return api.request('PATCH', revisionPath(styleId, revision.id), { body: { ...patch, version: revision.version }, schema: oneBom, ...key() }).then((answer) => answer.bom)
}

// ---- the routing (SCR-043) ------------------------------------------------------------------------------------------------

const oneRouting = z.object({ routing: routingView })

export function getRouting(api: ApiClient, styleId: string, revisionId: string): Promise<RoutingView> {
  return api.get(`${revisionPath(styleId, revisionId)}/routing`, { schema: oneRouting }).then((answer) => answer.routing)
}

export function addSteps(api: ApiClient, styleId: string, revision: { id: string; version: number }, operationIds: readonly string[]): Promise<RoutingView> {
  return api
    .post(`${revisionPath(styleId, revision.id)}/routing/steps`, { body: { version: revision.version, operations: operationIds.map((operationId) => ({ operationId })) }, schema: oneRouting, ...key() })
    .then((answer) => answer.routing)
}

export function updateStep(
  api: ApiClient,
  styleId: string,
  revision: { id: string; version: number },
  stepId: string,
  patch: { standardMinutes?: string; scanRequired?: boolean; instructions?: string | null },
): Promise<RoutingView> {
  return api
    .request('PATCH', `${revisionPath(styleId, revision.id)}/routing/steps/${enc(stepId)}`, { body: { ...patch, version: revision.version }, schema: oneRouting, ...key() })
    .then((answer) => answer.routing)
}

export function removeStep(api: ApiClient, styleId: string, revision: { id: string; version: number }, stepId: string): Promise<RoutingView> {
  return api
    .request('DELETE', `${revisionPath(styleId, revision.id)}/routing/steps/${enc(stepId)}`, { query: { version: revision.version }, schema: oneRouting, ...key() })
    .then((answer) => answer.routing)
}

export function reorderSteps(api: ApiClient, styleId: string, revision: { id: string; version: number }, stepIds: readonly string[]): Promise<RoutingView> {
  return api
    .request('PUT', `${revisionPath(styleId, revision.id)}/routing/order`, { body: { version: revision.version, stepIds }, schema: oneRouting, ...key() })
    .then((answer) => answer.routing)
}

// ---- the cost sheet (SCR-044) -------------------------------------------------------------------------------------------

const oneSheet = z.object({ sheet: costSheetView })
const oneDiff = z.object({ diff: costDiffView })

export function getCostSheet(api: ApiClient, styleId: string, revisionId: string, companyId: string | null): Promise<CostSheetView> {
  return api
    .get(`/costing/styles/${enc(styleId)}/revisions/${enc(revisionId)}/cost-sheet`, { query: { companyId: companyId ?? undefined }, schema: oneSheet })
    .then((answer) => answer.sheet)
}

export function compareCost(api: ApiClient, styleId: string, from: string, to: string, companyId: string | null): Promise<CostDiffView> {
  return api.get(`/costing/styles/${enc(styleId)}/cost-sheet/compare`, { query: { from, to, companyId: companyId ?? undefined }, schema: oneDiff }).then((answer) => answer.diff)
}

// ---- compliance (SCR-045) ---------------------------------------------------------------------------------------------

const oneCompliance = z.object({ compliance: styleComplianceView })

export function getCompliance(api: ApiClient, styleId: string, revisionId: string | null): Promise<StyleComplianceView> {
  return api.get(`${stylePath(styleId)}/compliance`, { query: { revisionId: revisionId ?? undefined }, schema: oneCompliance }).then((answer) => answer.compliance)
}

const announced = z.object({ document: z.object({ id: z.string() }).passthrough(), file: z.object({ id: z.string() }).passthrough(), upload: presignedSchema })

export interface DocumentUpload {
  revisionId: string
  kind: 'DECLARATION_OF_CONFORMITY' | 'USER_INFORMATION'
  language: string
  number: string | null
  originalName: string
  contentType: string
  sizeBytes: number
  sha256: string
}

/** Announce a signed DoC or a leaflet (the answer carries the presigned upload). */
export function announceDocument(api: ApiClient, styleId: string, input: DocumentUpload): Promise<{ documentId: string; fileId: string; upload: Presigned }> {
  return api
    .post(`${stylePath(styleId)}/compliance/documents`, { body: { ...input, number: input.number || undefined }, schema: announced, ...key() })
    .then((answer) => ({ documentId: answer.document.id, fileId: answer.file.id, upload: answer.upload }))
}

/** The uploaded file confirmed: the document is issued (or gets a new version). */
export function confirmDocument(api: ApiClient, styleId: string, documentId: string, fileId: string): Promise<unknown> {
  return api.post(`${stylePath(styleId)}/compliance/documents/${enc(documentId)}/files/${enc(fileId)}/complete`, { ...key() })
}

const oneDownload = z.object({ download: presignedSchema })

export function documentDownload(api: ApiClient, styleId: string, documentId: string, fileId: string): Promise<Presigned> {
  return api.get(`${stylePath(styleId)}/compliance/documents/${enc(documentId)}/files/${enc(fileId)}/download`, { schema: oneDownload }).then((answer) => answer.download)
}

const oneDocument = z.object({ document: complianceDocumentDetail })

export function getDocument(api: ApiClient, styleId: string, documentId: string): Promise<ComplianceDocumentDetail> {
  return api.get(`${stylePath(styleId)}/compliance/documents/${enc(documentId)}`, { schema: oneDocument }).then((answer) => answer.document)
}

/** An ACTIVE garment label template a draft revision may name (compliance/labels). */
const labelTemplate = z.object({ id: z.string(), code: z.string(), revision: z.number().int(), name: z.string(), styleId: z.string().nullable(), status: z.string(), languages: z.array(z.string()) })
export type LabelTemplateRow = z.infer<typeof labelTemplate>
const templateList = z.object({ templates: z.array(labelTemplate) })

export function listLabelTemplates(api: ApiClient): Promise<LabelTemplateRow[]> {
  return api.get('/compliance/labels', { query: { status: 'ACTIVE' }, schema: templateList }).then((answer) => answer.templates)
}

export function assignLabel(api: ApiClient, styleId: string, revision: { id: string; version: number }, labelTemplateId: string | null): Promise<unknown> {
  return api.request('PUT', `${revisionPath(styleId, revision.id)}/label`, { body: { labelTemplateId, version: revision.version }, ...key() })
}
