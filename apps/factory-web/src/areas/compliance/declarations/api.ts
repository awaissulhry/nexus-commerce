import { z } from 'zod'
import { CELL_STATES, COVERAGE_KINDS } from '@nexus/factory-domain/compliance/declarations/coverage'
import { TRANSLATION_STATES } from '@nexus/factory-domain/compliance/declarations/rules'
import { PACK_STATES } from '@nexus/factory-domain/compliance/user-information/packs'
import type { ApiClient } from '../../../lib/api/client'
import { documentDownload, getDocument } from '../../products/styles/api'

/**
 * Every call of Compliance › Declarations & instructions (SCR-052; B-W2b-268 on the APIs of B-W2b-257 the DoC generator,
 * apps/factory-api modules/compliance/declarations, and B-W2b-258 the user information builder, modules/compliance/
 * user-information): the grid, the language coverage with the tiles, a declaration or a leaflet with its parts, the New
 * declaration preview and create, edits, refresh, withdraw, translations and their check, versions by batch, the batches that
 * left without a recorded version, the shipment compliance pack, and a signed document's file (W1's style routes). Each answer's
 * shape is checked (zod mirrors of the API's contracts; unknown fields are dropped). The API's English (`message`,
 * `sourceWords`, `gate.words`) is read but never shown: the screens say their own words from the codes. No money.
 */

const seg = (value: string) => encodeURIComponent(value)
const person = z.object({ id: z.string(), name: z.string() })
const kind = z.enum(COVERAGE_KINDS)
const status = z.enum(['DRAFT', 'ISSUED', 'SUPERSEDED', 'WITHDRAWN'])
const origin = z.enum(['SIGNED', 'GENERATED'])
const translationState = z.enum(TRANSLATION_STATES)
const source = z.object({ kind: z.string(), recordType: z.string().optional(), recordId: z.string().optional() })
const problem = z.object({ code: z.string(), point: z.string().nullable(), message: z.string() })
const wording = z.object({ key: z.string(), kind: z.enum(['PHRASE', 'TEMPLATE']) })
const value = z.object({ field: z.string(), value: z.string(), source })
const point = z.object({ point: z.string(), text: z.string(), source, wording: wording.nullable(), values: z.array(value) })
const section = z.object({ key: z.string(), text: z.string(), source, wording: wording.nullable(), values: z.array(value) })
const gate = z.object({ name: z.literal('GATE-PPE-TEXTS') })

export type DocKind = z.infer<typeof kind>
export type DocStatus = z.infer<typeof status>
export type Source = z.infer<typeof source>
export type ApiProblem = z.infer<typeof problem>
export type PointView = z.infer<typeof point>
export type SectionView = z.infer<typeof section>

export const rowSchema = z.object({
  id: z.string(),
  styleId: z.string(),
  style: z.object({ code: z.string(), name: z.string() }),
  companyId: z.string().nullable(),
  kind,
  language: z.string(),
  revision: z.number().int(),
  number: z.string().nullable(),
  status,
  origin,
  translationOfId: z.string().nullable(),
  translationStatus: translationState.nullable(),
  translationCheckedAt: z.string().nullable(),
  translationCheckedBy: person.nullable(),
  marketCode: z.string().nullable(),
  certificate: z.object({ id: z.string(), number: z.string() }).nullable(),
  maker: z.object({ name: z.string(), address: z.string(), partyId: z.string().nullable(), role: z.enum(['COMPANY', 'BRAND']) }),
  standards: z.array(z.string()),
  signedByName: z.string().nullable(),
  signedByFunction: z.string().nullable(),
  signedPlace: z.string().nullable(),
  signedOn: z.string().nullable(),
  issuedAt: z.string().nullable(),
  batches: z.number().int(),
  shipments: z.number().int(),
  marketsNeeding: z.array(z.string()),
  draftUntilChecked: z.boolean(),
  pointsToType: z.array(z.string()),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type DeclarationRow = z.infer<typeof rowSchema>

const timelineGroup = z.object({
  revision: z.number().int(),
  documents: z.array(z.object({ id: z.string(), kind: z.string(), language: z.string(), revision: z.number().int(), number: z.string().nullable(), status: z.string() })),
  batches: z.array(
    z.object({
      batchNumber: z.string(),
      workOrderId: z.string().nullable(),
      shipmentIds: z.array(z.string()),
      documentIds: z.array(z.string()),
      firstRecordedAt: z.string(),
      shipments: z.array(z.object({ id: z.string(), number: z.string() })).optional(),
    }),
  ),
})
export type TimelineGroup = z.infer<typeof timelineGroup>

const familyEntry = z.object({
  id: z.string(),
  language: z.string(),
  status,
  origin,
  translationStatus: translationState.nullable(),
  translationCheckedBy: person.nullable(),
  marketCode: z.string().nullable(),
  original: z.boolean(),
})
const may = z.object({ edit: z.boolean(), refresh: z.boolean(), translate: z.boolean(), check: z.boolean(), withdraw: z.boolean() })
const common = {
  template: z.string().nullable(),
  gate: gate.nullable(),
  createdBy: person.nullable(),
  original: z.object({ id: z.string(), language: z.string(), status }).nullable(),
  problems: z.array(problem),
  batches: z.array(timelineGroup),
  may,
}

export const declarationSchema = rowSchema.extend({
  ...common,
  points: z.array(point),
  languages: z.array(familyEntry.extend({ pointsToType: z.array(z.string()) })),
  stale: z.object({ differences: z.array(z.object({ point: z.string(), stored: z.string().nullable(), fresh: z.string().nullable() })), problems: z.array(problem) }).nullable(),
  publication: z.object({ styleCode: z.string(), address: z.string(), live: z.boolean() }).nullable(),
})
export type DeclarationDetail = z.infer<typeof declarationSchema>

const protectorPosition = z.object({
  zone: z.string(),
  pocket: z.string(),
  placementId: z.string(),
  seq: z.number().int(),
  protector: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  standard: z.string(),
  level: z.string(),
  sizes: z.array(z.string()),
  note: z.string().nullable(),
})
export type ProtectorPosition = z.infer<typeof protectorPosition>
const spareProtector = z.object({
  name: z.string(),
  code: z.string(),
  itemId: z.string(),
  zones: z.array(z.string()),
  standard: z.string(),
  level: z.string(),
  certificate: z.object({ id: z.string(), number: z.string(), validTo: z.string() }),
  placed: z.boolean(),
})
export type SpareProtector = z.infer<typeof spareProtector>
const packDocument = z.object({ id: z.string(), language: z.string(), revision: z.number().int(), status: z.string(), origin: z.string(), translationStatus: z.string().nullable(), marketCode: z.string().nullable(), number: z.string().nullable() })
export const languagePackSchema = z.object({
  market: z.object({ code: z.string(), name: z.string(), switchedOn: z.boolean() }),
  languages: z.array(z.object({ language: z.string(), state: z.enum(PACK_STATES), signed: packDocument.nullable(), generated: packDocument.nullable() })),
  live: z.boolean(),
  missing: z.array(z.string()),
})
export type LanguagePack = z.infer<typeof languagePackSchema>

export const leafletSchema = rowSchema.extend({
  ...common,
  sections: z.array(section.extend({ law: z.string().nullable() })),
  protectorPositions: z.array(protectorPosition),
  spareProtectors: z.array(spareProtector),
  sectionsToType: z.array(z.string()),
  languages: z.array(familyEntry.extend({ sectionsToType: z.array(z.string()) })),
  stale: z
    .object({
      differences: z.array(z.object({ key: z.string(), stored: z.string().nullable(), fresh: z.string().nullable() })),
      lists: z.object({ positions: z.boolean(), spares: z.boolean() }),
      problems: z.array(problem),
    })
    .nullable(),
  packs: z.array(languagePackSchema),
  publication: z.object({ docAddress: z.string() }).nullable(),
})
export type LeafletDetail = z.infer<typeof leafletSchema>

const coverageCell = z.object({ language: z.string(), state: z.enum(CELL_STATES), documentId: z.string().nullable(), revision: z.number().int().nullable(), markets: z.array(z.string()) })
export type CoverageCellView = z.infer<typeof coverageCell>
export const coverageSchema = z.object({
  languages: z.array(z.string()),
  rows: z.array(z.object({ style: z.object({ id: z.string(), code: z.string(), name: z.string(), revision: z.number().int().nullable() }), kind, cells: z.array(coverageCell) })),
  tiles: z.object({ issued: z.number().int(), drafts: z.number().int(), languagesMissing: z.number().int(), supersededIn30Days: z.number().int(), batchesShippedWithoutVersion: z.number().int() }),
  asOf: z.string(),
})
export type Coverage = z.infer<typeof coverageSchema>
export type CoverageRow = Coverage['rows'][number]
export type Tiles = Coverage['tiles']

const listAnswer = z.object({ declarations: z.array(rowSchema), more: z.boolean(), asOf: z.string() })
export type ListAnswer = z.infer<typeof listAnswer>

export interface ListQuery {
  readonly styleId?: string | null
  readonly kind?: DocKind | null
  readonly origin?: 'SIGNED' | 'GENERATED' | null
  readonly status?: DocStatus | null
  readonly language?: string | null
  readonly q?: string | null
}

const terms = (query: ListQuery) => ({
  ...(query.styleId ? { styleId: query.styleId } : {}),
  ...(query.kind ? { kind: query.kind } : {}),
  ...(query.origin ? { origin: query.origin } : {}),
  ...(query.status ? { status: query.status } : {}),
  ...(query.language ? { language: query.language } : {}),
  ...(query.q && query.q.trim() ? { q: query.q.trim().slice(0, 100) } : {}),
})

/** GET /compliance/declarations: the grid, the API's own filters (the export reads the same terms). */
export const listDeclarations = (api: ApiClient, query: ListQuery, signal?: AbortSignal) => api.get('/compliance/declarations', { query: terms(query), schema: listAnswer, signal })

/** GET /compliance/declarations/coverage: the language matrix and the tiles. */
export const readCoverage = (api: ApiClient, styleId: string | null, signal?: AbortSignal) => api.get('/compliance/declarations/coverage', { query: styleId ? { styleId } : {}, schema: coverageSchema, signal })

/** GET /compliance/declarations/:id (any kind; a leaflet's own parts come from the leaflet route). */
export const readDeclaration = async (api: ApiClient, id: string, signal?: AbortSignal) => (await api.get(`/compliance/declarations/${seg(id)}`, { schema: z.object({ declaration: declarationSchema }), signal })).declaration

/** GET /compliance/user-information/:id: a leaflet with its sections, protectors, spares and language packs. */
export const readLeaflet = async (api: ApiClient, id: string, signal?: AbortSignal) => (await api.get(`/compliance/user-information/${seg(id)}`, { schema: z.object({ leaflet: leafletSchema }), signal })).leaflet

const base = (kindOf: DocKind) => (kindOf === 'USER_INFORMATION' ? '/compliance/user-information' : '/compliance/declarations')

/** A generated draft's PDF, painted now by the API (a plain link cannot send the company header: the page reads the bytes). */
export const draftPdf = (api: ApiClient, kindOf: DocKind, id: string, signal?: AbortSignal) => api.bytes(`${base(kindOf)}/${seg(id)}/pdf`, { signal })

/** A signed document's PDF: W1's file of the style (GET the document, then a 60-second address of its current file). */
export async function signedPdfAddress(api: ApiClient, styleId: string, documentId: string): Promise<string | null> {
  const document = await getDocument(api, styleId, documentId)
  const file = document.currentFile
  if (!file) return null
  const url = (await documentDownload(api, styleId, documentId, file.id)).url
  return url.startsWith('/') && !url.startsWith('//') ? `/api${url}` : url
}

const previewDoc = z.object({
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), ppeCategory: z.string() }),
  revision: z.object({ id: z.string(), revision: z.number().int(), status: z.string() }).nullable(),
  companyId: z.string().nullable(),
  language: z.string(),
  number: z.string().nullable(),
  maker: z.object({ name: z.string(), address: z.string(), partyId: z.string().nullable() }).nullable(),
  certificate: z.object({ id: z.string(), number: z.string(), body: z.string(), bodyNumber: z.string() }).nullable(),
  standards: z.array(z.string()),
  blocking: z.array(problem),
  warnings: z.array(problem),
  missingPhrases: z.array(z.string()),
  existing: z.object({ id: z.string(), status: z.string() }).nullable(),
})
const docPreview = previewDoc.extend({ points: z.array(point) })
const leafletPreview = previewDoc.extend({ sections: z.array(section), protectorPositions: z.array(protectorPosition), spareProtectors: z.array(spareProtector) })
export type DocPreview = z.infer<typeof docPreview>
export type LeafletPreview = z.infer<typeof leafletPreview>
export type Preview = (DocPreview & { readonly kind: 'DECLARATION_OF_CONFORMITY' }) | (LeafletPreview & { readonly kind: 'USER_INFORMATION' })

export interface PreviewQuery {
  readonly kind: DocKind
  readonly styleId: string
  readonly companyId: string | null
  readonly language: string
  readonly marketCode: string | null
}

/** GET …/preview: what a new draft would hold (live, nothing written). */
export async function readPreview(api: ApiClient, query: PreviewQuery, signal?: AbortSignal): Promise<Preview> {
  const params = { styleId: query.styleId, language: query.language, ...(query.companyId ? { companyId: query.companyId } : {}), ...(query.marketCode ? { marketCode: query.marketCode } : {}) }
  if (query.kind === 'USER_INFORMATION') {
    const answer = await api.get('/compliance/user-information/preview', { query: params, schema: z.object({ preview: leafletPreview }), signal })
    return { ...answer.preview, kind: 'USER_INFORMATION' }
  }
  const answer = await api.get('/compliance/declarations/preview', { query: params, schema: z.object({ preview: docPreview }), signal })
  return { ...answer.preview, kind: 'DECLARATION_OF_CONFORMITY' }
}

export interface CreateBody {
  readonly styleId: string
  readonly companyId: string | null
  readonly languages: readonly string[]
  readonly marketCode: string | null
  /** User information only: the markets whose language packs start with it. */
  readonly packs: readonly string[]
}

const idOf = z.object({ declaration: z.object({ id: z.string() }).passthrough() })
const leafletIdOf = z.object({ leaflet: z.object({ id: z.string() }).passthrough() })

/** POST: the original draft in languages[0] and a translation per other language (one command); answers the new id. */
export async function createDraft(api: ApiClient, kindOf: DocKind, body: CreateBody, idempotencyKey: string): Promise<string> {
  const payload = { styleId: body.styleId, languages: [...body.languages], ...(body.companyId ? { companyId: body.companyId } : {}), ...(body.marketCode ? { marketCode: body.marketCode } : {}) }
  if (kindOf === 'USER_INFORMATION') return (await api.post('/compliance/user-information', { body: { ...payload, ...(body.packs.length > 0 ? { packs: [...body.packs] } : {}) }, schema: leafletIdOf, idempotencyKey })).leaflet.id
  return (await api.post('/compliance/declarations', { body: payload, schema: idOf, idempotencyKey })).declaration.id
}

export interface DocEdit {
  readonly version: number
  /** A DoC's points or a leaflet's sections (by point number or section key) as typed. */
  readonly parts?: readonly { readonly id: string; readonly text: string }[]
  readonly number?: string | null
  readonly signedByName?: string | null
  readonly signedByFunction?: string | null
  readonly signedPlace?: string | null
  readonly signedOn?: string | null
}

const anyAnswer = z.object({}).passthrough()

/** PATCH a draft at the version read (409 when someone changed it meanwhile). */
export function editDraft(api: ApiClient, kindOf: DocKind, id: string, edit: DocEdit, idempotencyKey: string) {
  const parts = edit.parts && edit.parts.length > 0 ? edit.parts : undefined
  const body =
    kindOf === 'USER_INFORMATION'
      ? { version: edit.version, ...(parts ? { sections: parts.map((part) => ({ key: part.id, text: part.text })) } : {}), ...(edit.number !== undefined ? { number: edit.number } : {}) }
      : {
          version: edit.version,
          ...(parts ? { points: parts.map((part) => ({ point: part.id, text: part.text })) } : {}),
          ...(edit.number !== undefined ? { number: edit.number } : {}),
          ...(edit.signedByName !== undefined ? { signedByName: edit.signedByName } : {}),
          ...(edit.signedByFunction !== undefined ? { signedByFunction: edit.signedByFunction } : {}),
          ...(edit.signedPlace !== undefined ? { signedPlace: edit.signedPlace } : {}),
          ...(edit.signedOn !== undefined ? { signedOn: edit.signedOn } : {}),
        }
  return api.request('PATCH', `${base(kindOf)}/${seg(id)}`, { body, schema: anyAnswer, idempotencyKey })
}

/** POST …/refresh: composed again from today's records; typed words kept. */
export const refreshDraft = (api: ApiClient, kindOf: DocKind, id: string, version: number, idempotencyKey: string) => api.post(`${base(kindOf)}/${seg(id)}/refresh`, { body: { version, keepTyped: true }, schema: anyAnswer, idempotencyKey })

/** POST …/withdraw: a draft withdrawn with the reason (an original takes its draft translations with it). */
export const withdrawDraft = (api: ApiClient, kindOf: DocKind, id: string, version: number, reason: string, idempotencyKey: string) => api.post(`${base(kindOf)}/${seg(id)}/withdraw`, { body: { version, reason }, schema: anyAnswer, idempotencyKey })

/** POST …/translations on an original: new translations (a leaflet also takes markets' packs). */
export const startTranslations = (api: ApiClient, kindOf: DocKind, id: string, languages: readonly string[], packs: readonly string[], idempotencyKey: string) =>
  api.post(`${base(kindOf)}/${seg(id)}/translations`, { body: kindOf === 'USER_INFORMATION' ? { ...(languages.length > 0 ? { languages: [...languages] } : {}), ...(packs.length > 0 ? { packs: [...packs] } : {}) } : { languages: [...languages] }, schema: anyAnswer, idempotencyKey })

/** POST …/check: a second person checks a translation. */
export const checkTranslation = (api: ApiClient, kindOf: DocKind, id: string, version: number, idempotencyKey: string) => api.post(`${base(kindOf)}/${seg(id)}/check`, { body: { version }, schema: anyAnswer, idempotencyKey })

/** POST …/translation-state: back to the translator (IN_TRANSLATION) or ready (DRAFT); from CHECKED the check is undone. */
export const moveTranslation = (api: ApiClient, kindOf: DocKind, id: string, version: number, state: 'DRAFT' | 'IN_TRANSLATION', idempotencyKey: string) =>
  api.post(`${base(kindOf)}/${seg(id)}/translation-state`, { body: { version, state }, schema: anyAnswer, idempotencyKey })

const packsAnswer = z.object({ style: z.object({ id: z.string(), code: z.string(), name: z.string() }), revision: z.object({ id: z.string(), revision: z.number().int(), status: z.string() }), original: z.object({ id: z.string(), language: z.string(), status: z.string() }).nullable(), packs: z.array(languagePackSchema) })
export type PacksAnswer = z.infer<typeof packsAnswer>

/** GET /compliance/user-information/packs?styleId: per market its user-information languages and their state (PRD-351). */
export const readPacks = (api: ApiClient, styleId: string, signal?: AbortSignal) => api.get('/compliance/user-information/packs', { query: { styleId }, schema: packsAnswer, signal })

const unrecordedAnswer = z.object({
  unrecorded: z.array(z.object({ shipmentId: z.string(), shipmentNumber: z.string(), shippedAt: z.string().nullable(), workOrderId: z.string(), workOrderNumber: z.string(), batchNumber: z.string(), styleId: z.string(), styleCode: z.string() })),
  asOf: z.string(),
})
export type Unrecorded = z.infer<typeof unrecordedAnswer>['unrecorded'][number]

/** GET /compliance/declarations/batches/unrecorded: shipment × batch pairs that left with PPE and no recorded version. */
export const readUnrecorded = async (api: ApiClient, signal?: AbortSignal) => (await api.get('/compliance/declarations/batches/unrecorded', { schema: unrecordedAnswer, signal })).unrecorded

const recordedAnswer = z.object({ recorded: z.array(z.object({ id: z.string() }).passthrough()), skipped: z.array(z.object({ batchNumber: z.string(), documentId: z.string() }).passthrough()) })

/** POST /compliance/declarations/shipments/:id/versions: record what travelled with a shipment (once). */
export const recordShipment = (api: ApiClient, shipmentId: string, idempotencyKey: string) => api.post(`/compliance/declarations/shipments/${seg(shipmentId)}/versions`, { schema: recordedAnswer, idempotencyKey })

const packFile = z.object({ id: z.string(), originalName: z.string(), sha256: z.string(), sizeBytes: z.number().int() })
const packVersion = z.object({ id: z.string(), version: z.number().int(), language: z.string(), number: z.string().nullable(), fingerprint: z.string(), file: packFile.nullable(), shared: z.boolean(), documents: z.number().int(), createdAt: z.string(), createdBy: person.nullable() })
export type PackVersion = z.infer<typeof packVersion>
const packView = z.object({
  shipment: z.object({ id: z.string(), number: z.string(), status: z.string(), shippedOn: z.string().nullable() }),
  customer: z.object({ name: z.string() }).nullable(),
  order: z.object({ number: z.string(), customerRef: z.string().nullable() }).nullable(),
  wantedLanguage: z.string().nullable(),
  day: z.string(),
  locale: z.enum(['it', 'en']),
  styles: z.array(
    z.object({
      styleId: z.string(),
      code: z.string(),
      name: z.string(),
      revision: z.number().int().nullable(),
      category: z.string(),
      garments: z.number().int(),
      documents: z.array(z.object({ documentId: z.string(), kind, language: z.string(), revision: z.number().int(), number: z.string().nullable(), issuedAt: z.string().nullable(), fallback: z.boolean(), file: packFile })),
      certificate: z.object({ id: z.string(), number: z.string(), standard: z.string(), ppeClass: z.string().nullable(), bodyName: z.string(), bodyNumber: z.string(), validFrom: z.string(), validTo: z.string(), validOnDay: z.boolean() }).nullable(),
      batches: z.array(z.object({ workOrderId: z.string(), batchNumber: z.string(), garments: z.number().int(), publicDocAddress: z.string(), publicDocCode: z.string() })),
    }),
  ),
  contents: z.array(z.object({ title: z.string(), sha256: z.string(), recordType: z.string(), recordId: z.string(), fileId: z.string(), path: z.string() })),
  refusals: z.array(z.object({ code: z.string() })),
  warnings: z.array(z.object({ code: z.string() })),
  versions: z.array(packVersion),
})
export type PackView = z.infer<typeof packView>

/** GET …/shipments/:id/pack: what the shipment's compliance pack holds now, its refusals and warnings, its versions. */
export const readPack = async (api: ApiClient, shipmentId: string, signal?: AbortSignal) => (await api.get(`/compliance/declarations/shipments/${seg(shipmentId)}/pack`, { schema: z.object({ pack: packView }), signal })).pack

const madeAnswer = z.object({ pack: z.object({ version: packVersion, made: z.boolean() }) })
export type MadePack = z.infer<typeof madeAnswer>['pack']

/** POST …/shipments/:id/pack: a new version (or the newest again when nothing changed); `share` gives its PDF to the shipment's party. */
export const makePack = async (api: ApiClient, shipmentId: string, share: boolean, idempotencyKey: string) => (await api.post(`/compliance/declarations/shipments/${seg(shipmentId)}/pack`, { body: share ? { share: true } : {}, schema: madeAnswer, idempotencyKey })).pack

/** A pack version's PDF (bytes, for the viewer) and its ZIP (bytes, saved by the browser). */
export const packPdf = (api: ApiClient, shipmentId: string, documentId: string, signal?: AbortSignal) => api.bytes(`/compliance/declarations/shipments/${seg(shipmentId)}/pack/${seg(documentId)}/pdf`, { signal })
export const packZip = (api: ApiClient, shipmentId: string, documentId: string) => api.bytes(`/compliance/declarations/shipments/${seg(shipmentId)}/pack/${seg(documentId)}/zip`)

