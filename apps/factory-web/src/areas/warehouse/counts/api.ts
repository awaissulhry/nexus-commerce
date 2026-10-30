import { z } from 'zod'
import { COUNT_ITEM_KINDS, STOCK_COUNT_KINDS, STOCK_COUNT_STATUSES } from '@nexus/factory-domain/inventory/counts/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../record-panels/api'

/**
 * Every call of Warehouse › Counts (SCR-132; B-W2a-28 on the API of B-W2a-15, apps/factory-api
 * modules/inventory/counts/contract.ts), with the answer's shape checked (zod; unknown fields are dropped). Paths start
 * `/inventory/stock-counts`. Values carry the cost grain: absent (never null) without it, so the screens draw no value
 * column then. Every write is one command with its own Idempotency-Key and the version the screen read. The API's
 * English is never drawn: the screens say their own words from codes and numbers.
 */

export type CountKind = (typeof STOCK_COUNT_KINDS)[number]
export type CountStatus = (typeof STOCK_COUNT_STATUSES)[number]
export const ITEM_KIND_CHOICES = COUNT_ITEM_KINDS
export type CountItemKind = (typeof COUNT_ITEM_KINDS)[number]
export const LINE_FILTERS = ['all', 'uncounted', 'differs', 'recount', 'added'] as const
export type LineFilter = (typeof LINE_FILTERS)[number]
const HELD_CODES = ['NOT_SUBMITTED', 'NO_RIGHT', 'OWN_VARIANCE'] as const

const uom = z.enum(UOMS)
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const lotRef = z.object({ id: z.string(), code: z.string() })
const action = z.object({ allowed: z.boolean(), reason: z.string().nullable() })
/** A cost-grain amount in minor units: absent without the grain, null when it is not known. */
const costMinor = z.number().nullable().optional()

const countSchema = z.object({
  id: z.string(),
  number: z.string(),
  kind: z.enum(STOCK_COUNT_KINDS),
  status: z.enum(STOCK_COUNT_STATUSES),
  companyId: z.string(),
  site: ref,
  scope: z.object({
    location: z.object({ id: z.string(), code: z.string(), name: z.string(), path: z.string() }).nullable(),
    item: ref.nullable(),
    lot: lotRef.nullable(),
    itemKind: z.enum(COUNT_ITEM_KINDS).nullable(),
  }),
  inventoryDate: z.string().nullable(),
  countTeam: z.string().nullable(),
  note: z.string().nullable(),
  startedAt: z.string().nullable(),
  snapshotAt: z.string().nullable(),
  submittedAt: z.string().nullable(),
  approvalRequired: z.boolean().nullable(),
  differenceAmount: costMinor,
  currency: z.string(),
  approvedAt: z.string().nullable(),
  approvalNote: z.string().nullable(),
  rejectedAt: z.string().nullable(),
  rejectReason: z.string().nullable(),
  appliedAt: z.string().nullable(),
  signedOffAt: z.string().nullable(),
  valuedList: z.object({ pdfFileId: z.string(), sheetFileId: z.string().nullable() }).nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  lines: z.object({ all: z.number(), counted: z.number(), differing: z.number() }),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CountRow = z.infer<typeof countSchema>

const person = z.string().nullable()
const countRecordSchema = countSchema.extend({
  people: z.object({ createdBy: person, submittedBy: person, approvedBy: person, rejectedBy: person, appliedBy: person, signedOffBy: person }),
  summary: z.object({
    lines: z.number(),
    counted: z.number(),
    uncounted: z.number(),
    recountsDue: z.number(),
    differing: z.number(),
    unreasoned: z.number(),
    recountSuggested: z.number(),
    movedSinceSnapshot: z.number(),
    differenceAmount: z.number().optional(),
    unvalued: z.number(),
  }),
  approval: z.object({
    required: z.boolean(),
    limitAmount: z.number().optional(),
    mayApprove: z.boolean(),
    held: z.enum(HELD_CODES).nullable(),
    heldReason: z.string().nullable(),
  }),
  actions: z.object({ edit: action, start: action, record: action, submit: action, approve: action, sendBack: action, apply: action, signOff: action, cancel: action }),
})
export type CountRecord = z.infer<typeof countRecordSchema>

const lineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  location: ref,
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), tracking: z.enum(['NONE', 'LOT', 'HIDE', 'SERIAL']), uom }),
  colour: ref.nullable(),
  lot: lotRef.nullable(),
  hide: z.object({ id: z.string(), code: z.string(), area: z.string() }).nullable(),
  origin: z.enum(['SNAPSHOT', 'ADDED']),
  expected: z.string(),
  counted: z.string().nullable(),
  countedAt: z.string().nullable(),
  countedByYou: z.boolean(),
  recount: z.object({ requestedAt: z.string(), quantity: z.string().nullable(), at: z.string().nullable() }).nullable(),
  final: z.string().nullable(),
  difference: z.string().nullable(),
  percent: z.string().nullable(),
  status: z.enum(['UNCOUNTED', 'RECOUNT_DUE', 'COUNTED']),
  recountSuggested: z.boolean(),
  reasonCode: z.string().nullable(),
  reasonNote: z.string().nullable(),
  move: z.object({ id: z.string().nullable(), direction: z.enum(['IN', 'OUT']), baseQuantity: z.string() }).nullable(),
  unitCost: z.string().nullable().optional(),
  differenceAmount: costMinor,
  movedSinceSnapshot: z.boolean(),
  version: z.number(),
})
export type CountLine = z.infer<typeof lineSchema>

const tilesSchema = z.object({ drafts: z.number(), counting: z.number(), waitingApproval: z.number(), toApply: z.number(), yearEnd: z.number() })
export type CountTiles = z.infer<typeof tilesSchema>

const reasonSchema = z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string(), needsDetail: z.boolean() })
export type CountReason = z.infer<typeof reasonSchema>

const seg = (value: string) => encodeURIComponent(value)
const countPath = (id: string) => `/inventory/stock-counts/${seg(id)}`
type Query = Readonly<Record<string, string | number | boolean | null | undefined>>
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))
const key = () => ({ idempotencyKey: newIdempotencyKey() })
const one = z.object({ count: countRecordSchema })

// ---- reads ----------------------------------------------------------------------------------------------------------------

export interface CountQuery {
  siteId?: string | null
  status?: CountStatus | null
  kind?: CountKind | null
  open?: boolean
  q?: string | null
  cursor?: string | null
  limit?: number
}

export const listCounts = (api: ApiClient, query: CountQuery, signal?: AbortSignal) =>
  api.get('/inventory/stock-counts', {
    query: clean({ siteId: query.siteId, status: query.status, kind: query.kind, open: query.open ? 'true' : undefined, q: query.q?.trim(), cursor: query.cursor, limit: query.limit }),
    schema: z.object({ counts: z.array(countSchema), nextCursor: z.string().nullable() }),
    signal,
  })

export const countTiles = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/inventory/stock-counts/counts', { query: clean({ siteId }), schema: tilesSchema, signal })

export const countReasons = (api: ApiClient, signal?: AbortSignal) => api.get('/inventory/stock-counts/reasons', { schema: z.object({ reasons: z.array(reasonSchema) }), signal }).then((answer) => answer.reasons)

export const countRecord = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(countPath(id), { schema: one, signal }).then((answer) => answer.count)

export interface LinesQuery {
  filter?: LineFilter
  locationId?: string | null
  q?: string | null
  cursor?: number | null
  limit?: number
}

export const countLines = (api: ApiClient, id: string, query: LinesQuery, signal?: AbortSignal) =>
  api.get(`${countPath(id)}/lines`, {
    query: clean({ filter: query.filter, locationId: query.locationId, q: query.q?.trim(), cursor: query.cursor, limit: query.limit }),
    schema: z.object({ lines: z.array(lineSchema), nextCursor: z.number().nullable() }),
    signal,
  })

// ---- writes ---------------------------------------------------------------------------------------------------------------

export interface NewCountBody {
  siteId: string
  kind: CountKind
  locationId?: string
  itemId?: string
  lotId?: string
  itemKind?: CountItemKind
  inventoryDate?: string
  countTeam?: string
  note?: string
  start?: boolean
}

export const createCount = (api: ApiClient, body: NewCountBody) => api.post('/inventory/stock-counts', { body, schema: one, ...key() }).then((answer) => answer.count)

export const editCount = (api: ApiClient, count: Pick<CountRow, 'id' | 'version'>, body: { countTeam: string | null; note: string | null }) =>
  api.request('PATCH', countPath(count.id), { body: { version: count.version, ...body }, schema: one, ...key() }).then((answer) => answer.count)

const versioned = (path: string) => (api: ApiClient, count: Pick<CountRow, 'id' | 'version'>) =>
  api.post(`${countPath(count.id)}/${path}`, { body: { version: count.version }, schema: one, ...key() }).then((answer) => answer.count)
export const startCount = versioned('start')
export const submitCount = versioned('submit')

export interface LineEntry {
  lineId: string
  version: number
  counted?: string | null
  recount?: string
  reasonCode?: string | null
  reasonNote?: string | null
}

const recordAnswer = z.object({ lines: z.array(lineSchema), counted: z.number(), all: z.number() })
export const recordLines = (api: ApiClient, countId: string, lines: readonly LineEntry[]) =>
  api.post(`${countPath(countId)}/lines/record`, { body: { lines }, schema: recordAnswer, ...key() })

export interface FoundLine {
  locationId: string
  itemId: string
  itemColourId?: string
  lotId?: string
  hideId?: string
  counted: string
  reasonCode?: string
  reasonNote?: string
}
export const addLine = (api: ApiClient, countId: string, body: FoundLine) => api.post(`${countPath(countId)}/lines`, { body, schema: z.object({ line: lineSchema }), ...key() }).then((answer) => answer.line)

export const removeLine = (api: ApiClient, countId: string, line: Pick<CountLine, 'id' | 'version'>) =>
  api.post(`${countPath(countId)}/lines/${seg(line.id)}/remove`, { body: { version: line.version }, schema: z.object({ removed: z.string() }), ...key() })

export const askRecounts = (api: ApiClient, countId: string, lineIds: readonly string[]) =>
  api.post(`${countPath(countId)}/recounts`, { body: { lineIds }, schema: z.object({ lines: z.array(lineSchema) }), ...key() }).then((answer) => answer.lines)

export const approveCount = (api: ApiClient, count: Pick<CountRow, 'id' | 'version'>, note: string | null) =>
  api.post(`${countPath(count.id)}/approve`, { body: { version: count.version, ...(note ? { note } : {}) }, schema: one, ...key() }).then((answer) => answer.count)

export const sendBack = (api: ApiClient, count: Pick<CountRow, 'id' | 'version'>, reason: string, recountLineIds: readonly string[]) =>
  api
    .post(`${countPath(count.id)}/send-back`, { body: { version: count.version, reason, ...(recountLineIds.length > 0 ? { recountLineIds } : {}) }, schema: one, ...key() })
    .then((answer) => answer.count)

const appliedAnswer = z.object({ count: countRecordSchema, moves: z.array(z.object({ id: z.string(), lineId: z.string(), seq: z.number(), direction: z.enum(['IN', 'OUT']), baseQuantity: z.string() })) })
export const applyCount = (api: ApiClient, count: Pick<CountRow, 'id' | 'version'>) => api.post(`${countPath(count.id)}/apply`, { body: { version: count.version }, schema: appliedAnswer, ...key() })

export const signOffCount = (api: ApiClient, count: Pick<CountRow, 'id' | 'version'>, phrase: string, language: 'it' | 'en') =>
  api.post(`${countPath(count.id)}/sign-off`, { body: { version: count.version, phrase, language }, schema: one, ...key() }).then((answer) => answer.count)

export const cancelCount = (api: ApiClient, count: Pick<CountRow, 'id' | 'version'>, reason: string) =>
  api.post(`${countPath(count.id)}/cancel`, { body: { version: count.version, reason }, schema: one, ...key() }).then((answer) => answer.count)

// ---- papers ---------------------------------------------------------------------------------------------------------------

/** The count sheets (PDF, made on request, stored nowhere): with the expected quantities, or blind. */
export const countSheets = (api: ApiClient, countId: string, expected: boolean, language: 'it' | 'en') =>
  api.bytes(`${countPath(countId)}/sheets`, { query: { expected: expected ? undefined : 'false', language } })

/** A year-end inventory's valued list before its sign-off (a preview with a banner; cost grain). */
export const valuedListPreview = (api: ApiClient, countId: string, format: 'pdf' | 'xlsx', language: 'it' | 'en') =>
  api.bytes(`${countPath(countId)}/valued-list`, { query: { format, language } })

/** A signed-off inventory's frozen file (PDF or XLSX): a presigned GET through the files route (files.read). */
export const fileLink = (api: ApiClient, fileId: string): Promise<Presigned> =>
  api.get(`/files/${seg(fileId)}/download`, { schema: z.object({ download: presignedSchema }) }).then((answer) => answer.download)

// ---- what the New count and Found stock dialogs choose from -------------------------------------------------------------------

const materialSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), baseUom: uom, tracking: z.enum(['NONE', 'LOT', 'HIDE', 'SERIAL']) })
export type MaterialChoice = z.infer<typeof materialSchema>
/** Materials by code or name (Products › Materials & trims' list: product.materials.view). */
export const findMaterials = (api: ApiClient, q: string, signal?: AbortSignal) =>
  api
    .get('/product/materials', { query: clean({ q: q.trim(), status: 'ACTIVE', limit: 20 }), schema: z.object({ materials: z.array(materialSchema) }), signal })
    .then((answer) => answer.materials)

const materialColours = z.object({ material: z.object({ id: z.string(), colours: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })).optional() }) })
/** A material's colours (its record). */
export const materialColoursOf = (api: ApiClient, itemId: string, signal?: AbortSignal) =>
  api.get(`/product/materials/${seg(itemId)}`, { schema: materialColours, signal }).then((answer) => answer.material.colours ?? [])

const lotChoice = z.object({ id: z.string(), code: z.string(), onHand: z.string() })
/** The lots of a material at a site (Lots & traceability's list: inventory.stock.view). */
export const lotsOf = (api: ApiClient, siteId: string, itemId: string, signal?: AbortSignal) =>
  api.get('/inventory/lots', { query: { siteId, itemId, limit: 50 }, schema: z.object({ lots: z.array(lotChoice) }), signal }).then((answer) => answer.lots)

const hideChoice = z.object({ id: z.string(), code: z.string(), baseArea: z.string(), state: z.string() })
/** The hides of a lot (Hides' list), every state: a count may find a hide the ledger lost. */
export const hidesOf = (api: ApiClient, siteId: string, lotId: string, signal?: AbortSignal) =>
  api.get('/inventory/hides', { query: { siteId, lotId, limit: 100 }, schema: z.object({ hides: z.array(hideChoice) }), signal }).then((answer) => answer.hides)
