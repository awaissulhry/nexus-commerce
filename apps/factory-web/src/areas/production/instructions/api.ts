import { z } from 'zod'
import { operationRow, type OperationRow } from '@nexus/factory-domain/product/routing/contracts'
import { ACK_DUE, MEDIA_KINDS, VERSION_STATUSES } from '@nexus/factory-domain/production/instructions/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../record-panels/api'

/**
 * Every call of Production › Floor control › Work instructions (SCR-141 and its record, floor preview and PDF sheet), each
 * answer checked against the shape of apps/factory-api modules/production/instructions (B-W2b-214; zod drops unknown
 * fields). Every write carries the row's version and its own Idempotency-Key (one per attempt). The API's English
 * sentences (`rights.approveHeld`, a refusal's message) are not shown: the screen says its own words from the codes and
 * facts (model.ts). A worker is named only in the acknowledgements' `people` (production.instructions.people, and only
 * where the site's legal gate lets an office read name one). No money anywhere here.
 */

const enc = encodeURIComponent
const base = '/production/instructions'
const one = (instructionId: string) => `${base}/${enc(instructionId)}`
const versionPath = (instructionId: string, versionId: string) => `${one(instructionId)}/versions/${enc(versionId)}`
const key = (idempotencyKey?: string) => ({ idempotencyKey: idempotencyKey ?? newIdempotencyKey() })

const words = z.record(z.string(), z.string())
const status = z.enum(VERSION_STATUSES)
const person = z.object({ id: z.string(), name: z.string() })
const operationRef = z.object({ id: z.string(), code: z.string(), name: z.string() })
const styleRef = z.object({ id: z.string(), code: z.string(), name: z.string(), revisionId: z.string(), revision: z.number().int(), revisionStatus: z.string() })

export type VersionStatus = z.infer<typeof status>

const setting = z.object({
  seq: z.number().int(),
  machineClass: z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string() }).nullable(),
  stitchType: z.string().nullable(),
  needle: z.string().nullable(),
  thread: z.string().nullable(),
  stitchesPerCm: z.string().nullable(),
  tension: z.string().nullable(),
  foot: z.string().nullable(),
  notes: z.string().nullable(),
})
export type MachineSetting = z.infer<typeof setting>

// ---- the list --------------------------------------------------------------------------------------------------------------

export const listRow = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  status: z.string(),
  operation: operationRef,
  style: styleRef.nullable(),
  current: z
    .object({ versionId: z.string(), number: z.number().int(), publishedAt: z.string().nullable(), steps: z.number().int(), media: z.number().int(), languages: z.array(z.string()), missingLanguages: z.array(z.string()), seen: z.number().int() })
    .nullable(),
  draft: z.object({ versionId: z.string(), number: z.number().int() }).nullable(),
  usedIn: z.number().int(),
  updatedAt: z.string(),
})
export type InstructionRow = z.infer<typeof listRow>

const listAnswer = z.object({ instructions: z.array(listRow), truncated: z.boolean(), counts: z.object({ active: z.number().int(), archived: z.number().int(), drafts: z.number().int() }), canManage: z.boolean() })
export type InstructionList = z.infer<typeof listAnswer>

export interface ListQuery {
  companyId: string | null
  status: 'ACTIVE' | 'ARCHIVED'
  q?: string
}

export function listInstructions(api: ApiClient, query: ListQuery, signal?: AbortSignal): Promise<InstructionList> {
  return api.get(base, { query: { companyId: query.companyId ?? undefined, status: query.status, q: query.q?.trim() || undefined }, schema: listAnswer, signal })
}

// ---- the record ------------------------------------------------------------------------------------------------------------

export const versionView = z.object({
  id: z.string(),
  number: z.number().int(),
  status,
  changeNote: z.string().nullable(),
  acknowledgementRequired: z.boolean(),
  author: person,
  approvedBy: person.nullable(),
  publishedAt: z.string().nullable(),
  supersededAt: z.string().nullable(),
  createdAt: z.string(),
  steps: z.number().int(),
  media: z.number().int(),
  seen: z.number().int(),
  version: z.number().int(),
})
export type VersionView = z.infer<typeof versionView>

export const recordSchema = z.object({
  instruction: z.object({ id: z.string(), number: z.string(), companyId: z.string(), status: z.string(), version: z.number().int(), operation: operationRef, style: styleRef.nullable(), createdAt: z.string(), updatedAt: z.string() }),
  versions: z.array(versionView),
  currentVersionId: z.string().nullable(),
  draftVersionId: z.string().nullable(),
  settings: z.array(setting),
  floorLanguages: z.array(z.string()),
  usedIn: z.array(z.object({ revisionId: z.string(), styleId: z.string(), styleCode: z.string(), styleName: z.string(), revision: z.number().int(), status: z.string() })),
  rights: z.object({ canManage: z.boolean(), canApprove: z.boolean(), canSeePeople: z.boolean(), approveHeld: z.string().nullable() }),
})
export type InstructionRecord = z.infer<typeof recordSchema>

export function getInstruction(api: ApiClient, instructionId: string, signal?: AbortSignal): Promise<InstructionRecord> {
  return api.get(one(instructionId), { schema: recordSchema, signal })
}

export interface CreateBody {
  companyId: string
  operationId: string
  styleRevisionId?: string | null
  copyVersionId?: string | null
}

export function createInstruction(api: ApiClient, body: CreateBody, idempotencyKey?: string): Promise<InstructionRecord> {
  return api.post(base, { body, schema: recordSchema, ...key(idempotencyKey) })
}

export function setStatus(api: ApiClient, instructionId: string, to: 'ARCHIVED' | 'ACTIVE', body: { version: number; reason?: string | null }, idempotencyKey?: string): Promise<InstructionRecord> {
  return api.post(`${one(instructionId)}/${to === 'ARCHIVED' ? 'archive' : 'restore'}`, { body, schema: recordSchema, ...key(idempotencyKey) })
}

// ---- a version ---------------------------------------------------------------------------------------------------------------

const fileFacts = z.object({ originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int(), status: z.string() })

export const stepView = z.object({
  id: z.string(),
  code: z.string(),
  sortOrder: z.number().int(),
  text: words,
  critical: z.boolean(),
  safety: words.nullable(),
  icon: z.string().nullable(),
  requiredTick: z.boolean(),
  missingLanguages: z.array(z.string()),
  media: z.array(z.object({ id: z.string(), fileId: z.string(), kind: z.enum(MEDIA_KINDS), sortOrder: z.number().int(), caption: words.nullable(), file: fileFacts.nullable() })),
})
export type StepView = z.infer<typeof stepView>
export type FileFacts = z.infer<typeof fileFacts>

const comparedWith = z.object({ id: z.string(), number: z.number().int(), added: z.array(z.string()), removed: z.array(z.string()), changed: z.array(z.string()) }).nullable()

export const versionAnswer = z.object({ version: versionView, steps: z.array(stepView), comparedWith })
export type VersionAnswer = z.infer<typeof versionAnswer>

export function getVersion(api: ApiClient, instructionId: string, versionId: string, compare?: string | null, signal?: AbortSignal): Promise<VersionAnswer> {
  return api.get(versionPath(instructionId, versionId), { query: { compare: compare ?? undefined }, schema: versionAnswer, signal })
}

export function draftVersion(api: ApiClient, instructionId: string, body: { version: number; fromVersionId?: string | null; changeNote?: string | null }, idempotencyKey?: string): Promise<VersionAnswer> {
  return api.post(`${one(instructionId)}/versions`, { body, schema: versionAnswer, ...key(idempotencyKey) })
}

export interface StepBody {
  code: string
  text: Record<string, string>
  critical: boolean
  safety: Record<string, string> | null
  icon: string | null
  requiredTick: boolean
  media: Array<{ fileId: string; kind: 'PHOTO' | 'VIDEO'; caption: Record<string, string> | null }>
}

export interface SaveBody {
  version: number
  changeNote: string | null
  acknowledgementRequired: boolean
  steps: StepBody[]
}

export function saveVersion(api: ApiClient, instructionId: string, versionId: string, body: SaveBody, idempotencyKey?: string): Promise<VersionAnswer> {
  return api.request('PUT', versionPath(instructionId, versionId), { body, schema: versionAnswer, ...key(idempotencyKey) })
}

const publishAnswer = versionAnswer.extend({ superseded: z.object({ id: z.string(), number: z.number().int() }).nullable() })
export type PublishAnswer = z.infer<typeof publishAnswer>

export function publishVersion(api: ApiClient, instructionId: string, versionId: string, body: { version: number }, idempotencyKey?: string): Promise<PublishAnswer> {
  return api.post(`${versionPath(instructionId, versionId)}/publish`, { body, schema: publishAnswer, ...key(idempotencyKey) })
}

export function discardVersion(api: ApiClient, instructionId: string, versionId: string, body: { version: number; reason: string }, idempotencyKey?: string): Promise<VersionAnswer> {
  return api.post(`${versionPath(instructionId, versionId)}/discard`, { body, schema: versionAnswer, ...key(idempotencyKey) })
}

/** The printed sheet of a version (made now, kept nowhere): a plain link cannot send the company header, so the page reads it. */
export function sheetBytes(api: ApiClient, instructionId: string, versionId: string, language: 'it' | 'en', signal?: AbortSignal): Promise<Uint8Array> {
  return api.bytes(`${versionPath(instructionId, versionId)}/sheet`, { query: { language }, signal })
}

// ---- photos and videos -------------------------------------------------------------------------------------------------------

const announced = z.object({ file: z.object({ id: z.string(), status: z.string() }).passthrough(), upload: presignedSchema })
const completed = z.object({ file: z.object({ id: z.string(), status: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int() }).passthrough() })

export interface AnnounceBody {
  kind: 'PHOTO' | 'VIDEO'
  originalName: string
  contentType: string
  sizeBytes: number
  sha256: string
}

export function announceMedia(api: ApiClient, instructionId: string, body: AnnounceBody, idempotencyKey?: string): Promise<{ fileId: string; upload: Presigned }> {
  return api.post(`${one(instructionId)}/files`, { body, schema: announced, ...key(idempotencyKey) }).then((answer) => ({ fileId: answer.file.id, upload: answer.upload }))
}

export function completeMedia(api: ApiClient, instructionId: string, fileId: string, idempotencyKey?: string): Promise<z.infer<typeof completed>['file']> {
  return api.post(`${one(instructionId)}/files/${enc(fileId)}/complete`, { schema: completed, ...key(idempotencyKey) }).then((answer) => answer.file)
}

/** A photo or video the office looks at: the generic files route (files.read; an instruction's files are OFFICE files). */
export function mediaDownload(api: ApiClient, fileId: string, signal?: AbortSignal): Promise<Presigned> {
  return api.get(`/files/${enc(fileId)}/download`, { schema: z.object({ download: presignedSchema }), signal }).then((answer) => answer.download)
}

// ---- acknowledgements ----------------------------------------------------------------------------------------------------------

export const acksSchema = z.object({
  versions: z.array(z.object({ versionId: z.string(), number: z.number().int(), status, seen: z.number().int() })),
  current: z
    .object({ versionId: z.string(), number: z.number().int(), acknowledgementRequired: z.boolean(), perSite: z.array(z.object({ siteId: z.string(), code: z.string(), name: z.string(), seen: z.number().int(), of: z.number().int() })) })
    .nullable(),
  people: z
    .object({
      rows: z.array(
        z.object({
          worker: person.nullable(),
          workerHidden: z.boolean(),
          site: z.object({ id: z.string(), code: z.string() }),
          holdsSkill: z.boolean(),
          lastSeen: z.object({ versionNumber: z.number().int(), at: z.string(), locale: z.string(), way: z.enum(['FLOOR', 'PAPER']) }).nullable(),
          seenCurrent: z.boolean(),
        }),
      ),
    })
    .nullable(),
  canSeePeople: z.boolean(),
})
export type Acknowledgements = z.infer<typeof acksSchema>
export type AckPerson = NonNullable<Acknowledgements['people']>['rows'][number]

export function getAcknowledgements(api: ApiClient, instructionId: string, signal?: AbortSignal): Promise<Acknowledgements> {
  return api.get(`${one(instructionId)}/acknowledgements`, { schema: acksSchema, signal })
}

export function recordPaper(api: ApiClient, instructionId: string, versionId: string, body: { workerId: string; locale: string; acknowledgedAt?: string }, idempotencyKey?: string): Promise<Acknowledgements> {
  return api.post(`${versionPath(instructionId, versionId)}/acknowledgements`, { body, schema: acksSchema, ...key(idempotencyKey) })
}

// ---- the typed step lines of the routings ------------------------------------------------------------------------------------

const typedRow = z.object({
  routingOperationId: z.string(),
  style: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  revision: z.object({ id: z.string(), revision: z.number().int(), status: z.string() }),
  step: z.object({ seq: z.number().int(), code: z.string(), operationId: z.string() }),
  steps: z.array(z.object({ code: z.string(), words: z.string(), requiredTick: z.boolean() })),
  existing: z.object({ id: z.string(), number: z.string(), status: z.string() }).nullable(),
})
const typedAnswer = z.object({ rows: z.array(typedRow), toMake: z.number().int(), made: z.number().int() })
export type TypedSteps = z.infer<typeof typedAnswer>

export function typedSteps(api: ApiClient, companyId: string, language: string, signal?: AbortSignal): Promise<TypedSteps> {
  return api.get(`${base}/typed-steps`, { query: { companyId, language }, schema: typedAnswer, signal })
}

const broughtAnswer = z.object({ made: z.array(z.object({ instructionId: z.string(), number: z.string(), versionId: z.string(), routingOperationId: z.string() })) })

export function bringTypedSteps(api: ApiClient, body: { companyId: string; language: string }, idempotencyKey?: string): Promise<z.infer<typeof broughtAnswer>['made']> {
  return api.post(`${base}/typed-steps`, { body, schema: broughtAnswer, ...key(idempotencyKey) }).then((answer) => answer.made)
}

// ---- what New instruction picks from ---------------------------------------------------------------------------------------------

export type { OperationRow }
const operationsPage = z.object({ operations: z.array(operationRow), nextCursor: z.string().nullable(), count: z.number().int() })

/** The library operations to pick from (product.routing.view): the company's and the tenant-wide ones, at most 200. */
export function listOperations(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<OperationRow[]> {
  return api.get('/product/operations', { query: { companyId: companyId ?? undefined, status: 'ACTIVE', limit: 200 }, schema: operationsPage, signal }).then((page) => page.operations)
}

const styleHit = z.object({ id: z.string(), code: z.string(), name: z.string() })
const stylesPage = z.object({ styles: z.array(styleHit), nextCursor: z.string().nullable(), count: z.number().int() })
export type StyleHit = z.infer<typeof styleHit>

/** The styles to pick a revision of (product.styles.view), at most 200. */
export function listStyles(api: ApiClient, signal?: AbortSignal): Promise<StyleHit[]> {
  return api.get('/product/styles', { query: { status: 'OPEN', limit: 200 }, schema: stylesPage, signal }).then((page) => page.styles)
}

const revisionHit = z.object({ id: z.string(), revision: z.number().int(), status: z.string() })
export type RevisionHit = z.infer<typeof revisionHit>

/** A style's revisions (newest first): an instruction may belong to one of them. */
export function styleRevisions(api: ApiClient, styleId: string, signal?: AbortSignal): Promise<RevisionHit[]> {
  return api
    .get(`/product/styles/${enc(styleId)}`, { schema: z.object({ style: z.object({ revisions: z.array(revisionHit) }) }), signal })
    .then((answer) => [...answer.style.revisions].sort((a, b) => b.revision - a.revision))
}

export const ACK_DUE_REASONS = ACK_DUE
