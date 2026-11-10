import { z } from 'zod'
import { ASK_CHANNELS, DECLARATION_CHANNELS, DECLARATION_STATUSES, SHOWN_STATUSES } from '@nexus/factory-domain/compliance/declarations-asked/rules'
import { DECLARATION_KINDS, SUBSTANCE_UNITS } from '@nexus/factory-domain/compliance/substances/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { completeUpload, downloadLink, requestUpload } from '../../../../record-panels/api'
import { putToStore, readFromStore, sha256Hex } from '../../../../record-panels/store'

/**
 * Every call of Compliance › Tests & substances › Supplier declarations (B-W2b-267 on B-W2b-256's API,
 * apps/factory-api modules/compliance/declarations-asked): the list with its tiles, one request with its lines, the
 * Request declarations review (dry run) and send, remind, the office's answer (a file of the request), the lines per
 * material, accept, refuse, cancel, ask again, and the answer's file address. Each answer's shape is checked (zod mirrors of
 * the API's contracts; unknown fields are dropped). The API's English (`kindWords`, `why`) is read but never shown: the
 * screens say their own words from the codes. No money.
 */

const seg = (value: string) => encodeURIComponent(value)
const kind = z.enum(DECLARATION_KINDS)
const listVersion = z.object({ id: z.string(), publishedOn: z.string() })
const newestVersion = z.object({ id: z.string(), publishedOn: z.string(), entryCount: z.number().int() }).nullable()

export const requestSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  party: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  kind,
  kindShort: z.string(),
  svhcListVersion: listVersion.nullable(),
  answeredListVersion: listVersion.nullable(),
  channel: z.enum(DECLARATION_CHANNELS),
  sentAt: z.string(),
  dueOn: z.string(),
  overdueDays: z.number().int(),
  reminderEveryDays: z.number().int().nullable(),
  remindersSent: z.number().int(),
  lastRemindedAt: z.string().nullable(),
  reminderDue: z.boolean(),
  status: z.enum(DECLARATION_STATUSES),
  shown: z.enum(SHOWN_STATUSES),
  answeredAt: z.string().nullable(),
  validTo: z.string().nullable(),
  file: z.object({ source: z.enum(['UPLOAD', 'FILE']), uploadId: z.string().nullable(), fileId: z.string().nullable(), uploadStatus: z.string().nullable() }).nullable(),
  materials: z.array(z.object({ itemId: z.string(), code: z.string(), name: z.string(), kind: z.string(), articleLabel: z.string() })),
  lines: z.number().int(),
  answeredLines: z.number().int(),
  supersedesId: z.string().nullable(),
  supersededBy: z.object({ id: z.string(), number: z.string() }).nullable(),
  version: z.number().int(),
})
export type DeclarationRequest = z.infer<typeof requestSchema>
export type DeclarationKind = z.infer<typeof kind>
export type ShownStatus = DeclarationRequest['shown']

const lineSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string() }),
  articleLabel: z.string(),
  contains: z.boolean().nullable(),
  aboveThreshold: z.boolean().nullable(),
  substance: z.object({ id: z.string(), casNumber: z.string().nullable(), name: z.string() }).nullable(),
  substanceName: z.string().nullable(),
  concentration: z.string().nullable(),
  concentrationUnit: z.enum(SUBSTANCE_UNITS).nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
})
export type DeclarationLine = z.infer<typeof lineSchema>

export const detailSchema = requestSchema.extend({
  message: z.string().nullable(),
  internalNote: z.string().nullable(),
  lineRows: z.array(lineSchema),
  upload: z
    .object({
      id: z.string(),
      fileId: z.string(),
      status: z.string(),
      category: z.string(),
      issuer: z.string().nullable(),
      documentNumber: z.string().nullable(),
      issuedOn: z.string().nullable(),
      expiresOn: z.string().nullable(),
      receivedAt: z.string().nullable(),
      uploadedByName: z.string(),
      documentFileId: z.string().nullable(),
    })
    .nullable(),
  partnerTask: z.object({ id: z.string(), status: z.string(), dueAt: z.string().nullable(), remindedAt: z.string().nullable(), closedAt: z.string().nullable() }).nullable(),
  decidedAt: z.string().nullable(),
  decidedBy: z.object({ id: z.string().nullable(), name: z.string() }).nullable(),
  refuseReason: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  supersedes: z.object({ id: z.string(), number: z.string(), status: z.string() }).nullable(),
  newestListVersion: newestVersion,
})
export type DeclarationDetail = z.infer<typeof detailSchema>

const countsSchema = z.object({ open: z.number().int(), overdue: z.number().int(), answered: z.number().int(), rerequest: z.number().int(), expired: z.number().int() })
export type DeclarationCounts = z.infer<typeof countsSchema>

const listSchema = z.object({ requests: z.array(requestSchema), more: z.boolean(), counts: countsSchema, newestListVersion: newestVersion, mayAsk: z.boolean(), asOf: z.string() })
export type DeclarationList = z.infer<typeof listSchema>

export interface DeclarationQuery {
  readonly shown?: ShownStatus | null
  readonly kind?: DeclarationKind | null
  readonly itemId?: string | null
  readonly q?: string | null
}

/** GET /compliance/declarations-asked (compliance.certificates.view): up to 500, newest first, with the tiles' counts. */
export const listRequests = (api: ApiClient, query: DeclarationQuery, signal?: AbortSignal): Promise<DeclarationList> =>
  api.get('/compliance/declarations-asked', { query: { shown: query.shown ?? undefined, kind: query.kind ?? undefined, itemId: query.itemId ?? undefined, q: query.q?.trim() || undefined }, schema: listSchema, signal })

const recordSchema = z.object({ request: detailSchema, mayManage: z.boolean(), asOf: z.string() })
export type DeclarationRecord = z.infer<typeof recordSchema>

/** GET /compliance/declarations-asked/:id: the request with its lines, the supplier's upload and the decision. */
export const getRequest = (api: ApiClient, requestId: string, signal?: AbortSignal): Promise<DeclarationRecord> => api.get(`/compliance/declarations-asked/${seg(requestId)}`, { schema: recordSchema, signal })

const groupSchema = z.object({
  party: z.object({ id: z.string(), code: z.string(), name: z.string(), portalOn: z.boolean() }),
  kind,
  kindShort: z.string(),
  channel: z.enum(ASK_CHANNELS).nullable(),
  outcome: z.enum(['SEND', 'ADD', 'SKIP']),
  /** The API's English reason of a SKIP: read, never shown (the screen says its own from the facts). */
  why: z.string().nullable(),
  materials: z.array(z.object({ itemId: z.string(), code: z.string(), name: z.string(), articleLabel: z.string() })),
  request: z.object({ requestId: z.string(), number: z.string() }).nullable(),
})
export type AskGroup = z.infer<typeof groupSchema>

const askSchema = z.object({
  sent: z.boolean(),
  companyId: z.string(),
  svhcListVersion: newestVersion,
  groups: z.array(groupSchema),
  counts: z.object({ send: z.number().int(), add: z.number().int(), skip: z.number().int() }),
})
export type AskAnswer = z.infer<typeof askSchema>

export interface AskBody {
  readonly materials: readonly { readonly itemId: string; readonly partyId?: string | null }[]
  readonly kinds: readonly DeclarationKind[]
  readonly dueOn: string
  readonly reminderEveryDays: number | null
  readonly message: string | null
  readonly channel: 'PORTAL' | 'OFFICE' | null
}

const askBody = (body: AskBody, dryRun: boolean) => ({
  materials: body.materials.map((material) => ({ itemId: material.itemId, ...(material.partyId ? { partyId: material.partyId } : {}) })),
  kinds: [...body.kinds],
  dueOn: body.dueOn,
  reminderEveryDays: body.reminderEveryDays,
  message: body.message?.trim() || null,
  channel: body.channel,
  ...(dryRun ? { dryRun: true } : {}),
})

/** POST …/declarations-asked with `dryRun`: the review per supplier and kind (SEND / ADD / SKIP), nothing written. */
export const reviewAsk = (api: ApiClient, body: AskBody, signal?: AbortSignal): Promise<AskAnswer> =>
  api.post('/compliance/declarations-asked', { body: askBody(body, true), schema: askSchema, signal })

/** POST …/declarations-asked: ONE command, a numbered request per SEND (a portal task where it goes through the portal). */
export const sendAsk = (api: ApiClient, body: AskBody, idempotencyKey: string): Promise<AskAnswer> =>
  api.post('/compliance/declarations-asked', { body: askBody(body, false), schema: askSchema, idempotencyKey })

const recordAnswer = z.object({ request: detailSchema, at: z.string() })
const path = (requestId: string, verb: string) => `/compliance/declarations-asked/${seg(requestId)}/${verb}`

export const remindRequest = (api: ApiClient, request: Pick<DeclarationRequest, 'id' | 'version'>, idempotencyKey = newIdempotencyKey()) =>
  api.post(path(request.id, 'remind'), { body: { version: request.version }, schema: recordAnswer, idempotencyKey })

export interface LineWrite {
  readonly lineId: string
  readonly contains: boolean | null
  readonly aboveThreshold?: boolean | null
  readonly substanceName?: string | null
  readonly concentration?: string | null
  readonly concentrationUnit?: (typeof SUBSTANCE_UNITS)[number] | null
  readonly note?: string | null
}

/** POST …/answer: the supplier's answer linked (PORTAL: its upload, default the newest; OFFICE: a file of the request). */
export const answerRequest = (api: ApiClient, request: Pick<DeclarationRequest, 'id' | 'version'>, body: { uploadId?: string | null; fileId?: string | null; validTo?: string | null; answeredListVersionId?: string | null }, idempotencyKey: string) =>
  api.post(path(request.id, 'answer'), { body: { version: request.version, ...body }, schema: recordAnswer, idempotencyKey })

/** PUT …/lines: the answer per material (every line written at the request's version). */
export const writeLines = (api: ApiClient, request: Pick<DeclarationRequest, 'id' | 'version'>, lines: readonly LineWrite[], idempotencyKey: string) =>
  api.request('PUT', path(request.id, 'lines'), { body: { version: request.version, lines: lines.map((line) => ({ ...line })) }, schema: recordAnswer, idempotencyKey })

export const acceptRequest = (api: ApiClient, request: Pick<DeclarationRequest, 'id' | 'version'>, body: { validTo: string | null; answeredListVersionId?: string | null }, idempotencyKey: string) =>
  api.post(path(request.id, 'accept'), { body: { version: request.version, validTo: body.validTo, ...(body.answeredListVersionId ? { answeredListVersionId: body.answeredListVersionId } : {}) }, schema: recordAnswer, idempotencyKey })

export const refuseRequest = (api: ApiClient, request: Pick<DeclarationRequest, 'id' | 'version'>, reason: string, idempotencyKey: string) =>
  api.post(path(request.id, 'refuse'), { body: { version: request.version, reason: reason.trim() }, schema: recordAnswer, idempotencyKey })

export const cancelRequest = (api: ApiClient, request: Pick<DeclarationRequest, 'id' | 'version'>, reason: string, idempotencyKey: string) =>
  api.post(path(request.id, 'cancel'), { body: { version: request.version, reason: reason.trim() }, schema: z.object({ request: requestSchema }), idempotencyKey })

export const askAgain = (api: ApiClient, request: Pick<DeclarationRequest, 'id' | 'version'>, body: { dueOn: string; reminderEveryDays: number | null; message: string | null }, idempotencyKey: string) =>
  api.post(path(request.id, 'ask-again'), {
    body: { version: request.version, dueOn: body.dueOn, reminderEveryDays: body.reminderEveryDays, message: body.message?.trim() || null },
    schema: z.object({ request: requestSchema, previous: z.object({ id: z.string(), number: z.string(), status: z.string() }), at: z.string() }),
    idempotencyKey,
  })

/** The answer's file for the viewer: its bytes, read once through the 60-second address (GET /files/:id/download). */
export async function fileBytes(api: ApiClient, fileId: string): Promise<Uint8Array> {
  const { download } = await downloadLink(api, fileId)
  return readFromStore(download)
}

/** The office's answer: the supplier's file uploaded as a DOCUMENT of the request (announce, the bytes, confirm). Its id. */
export async function uploadAnswerFile(api: ApiClient, request: Pick<DeclarationRequest, 'id' | 'companyId'>, file: File): Promise<string> {
  const bytes = await file.arrayBuffer()
  const { file: stored, upload } = await requestUpload(api, {
    companyId: request.companyId,
    record: { type: 'SupplierDeclarationRequest', id: request.id },
    kind: 'DOCUMENT',
    name: file.name || 'declaration.pdf',
    contentType: file.type || 'application/pdf',
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(upload, bytes)
  await completeUpload(api, stored.id)
  return stored.id
}
