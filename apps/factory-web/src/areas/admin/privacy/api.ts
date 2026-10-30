import { z } from 'zod'
import { NOTICE_KINDS, NOTICE_STATUSES } from '@nexus/factory-domain/privacy/notices'
import { DPIA_STATUSES, PROCESSING_ACTIVITY_STATUSES } from '@nexus/factory-domain/privacy/records'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Admin › Privacy & notices (SCR-086; apps/factory-api platform/privacy, B-W1-36), with the answer's shape
 * checked (zod; unknown fields are dropped). The shapes mirror platform/privacy/contract.ts; the enum lists are
 * factory-domain's. The API's English (duty words, readiness notes, publish words) is never drawn: the page says its own
 * words from the codes, counts and dates. Names of people come back only with privacy.manage, inside one notice.
 */

export const KINDS = NOTICE_KINDS
export type NoticeKind = (typeof NOTICE_KINDS)[number]
export type NoticeStatus = (typeof NOTICE_STATUSES)[number]
export type DpiaStatus = (typeof DPIA_STATUSES)[number]
export type ActivityStatus = (typeof PROCESSING_ACTIVITY_STATUSES)[number]

const seg = (value: string) => encodeURIComponent(value)
const company = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type CompanyRef = z.infer<typeof company>

const languageSchema = z.object({ locale: z.string(), body: z.string().nullable(), hasText: z.boolean(), fileId: z.string().nullable(), sha256: z.string() })
export type NoticeLanguage = z.infer<typeof languageSchema>
const countsSchema = z.object({ active: z.number(), acknowledged: z.number(), notAcknowledged: z.number() })
export type AckCounts = z.infer<typeof countsSchema>

const noticeSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  kind: z.enum(NOTICE_KINDS),
  versionNo: z.number(),
  label: z.string(),
  status: z.enum(NOTICE_STATUSES),
  publishedAt: z.string().nullable(),
  publishedById: z.string().nullable(),
  supersededAt: z.string().nullable(),
  version: z.number(),
  languages: z.array(languageSchema),
  acknowledgements: countsSchema.nullable(),
})
export type Notice = z.infer<typeof noticeSchema>
const oneNotice = z.object({ notice: noticeSchema })

const inForce = z.object({ id: z.string(), label: z.string(), publishedAt: z.string().nullable() }).nullable()
const overviewSchema = z.object({
  companies: z.array(
    z.object({
      company,
      duties: z.array(z.object({ key: z.enum(['register', 'publicNotice', 'staffNotice', 'workerNotice', 'dpia']), done: z.boolean() })),
      notices: z.object({ WORKER_FLOOR: inForce, OFFICE_STAFF: inForce, PRIVACY_PUBLIC: inForce }),
      dpia: z.object({ id: z.string(), versionNo: z.number(), signedOn: z.string().nullable(), reviewDueOn: z.string().nullable() }).nullable(),
      activities: z.number(),
      sites: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), readyForFloor: z.boolean() })),
    }),
  ),
})
export type CompanyOverview = z.infer<typeof overviewSchema>['companies'][number]
export type DutyKey = CompanyOverview['duties'][number]['key']

const personSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  siteId: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  channel: z.enum(['DEVICE', 'PAPER', 'OFFICE']).nullable(),
  locale: z.string().nullable(),
})
export type AckPerson = z.infer<typeof personSchema>
const acksSchema = z.object({
  notice: z.object({ id: z.string(), kind: z.enum(NOTICE_KINDS), label: z.string(), status: z.enum(NOTICE_STATUSES) }),
  counts: countsSchema.nullable(),
  people: z.array(personSchema).nullable(),
})
export type NoticeAcks = z.infer<typeof acksSchema>

const dpiaSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  versionNo: z.number(),
  scope: z.string(),
  status: z.enum(DPIA_STATUSES),
  fileId: z.string().nullable(),
  fileSha256: z.string().nullable(),
  signedByName: z.string().nullable(),
  signedOn: z.string().nullable(),
  reviewDueOn: z.string().nullable(),
  storedAt: z.string().nullable(),
  supersededAt: z.string().nullable(),
  version: z.number(),
})
export type Dpia = z.infer<typeof dpiaSchema>
const dpiaListSchema = z.object({ company, stored: dpiaSchema.nullable(), versions: z.array(dpiaSchema) })
export type DpiaList = z.infer<typeof dpiaListSchema>

const activitySchema = z.object({
  id: z.string(),
  companyId: z.string(),
  code: z.string(),
  name: z.string(),
  purpose: z.string(),
  legalBasis: z.string(),
  dataSubjects: z.array(z.string()),
  dataCategories: z.array(z.string()),
  recipients: z.array(z.string()),
  processors: z.array(z.string()),
  transfers: z.string(),
  retention: z.string(),
  security: z.string(),
  status: z.enum(PROCESSING_ACTIVITY_STATUSES),
  version: z.number(),
  updatedAt: z.string(),
})
export type Activity = z.infer<typeof activitySchema>
const oneActivity = z.object({ activity: activitySchema })

// ---- reads -----------------------------------------------------------------------------------------------------------------

/** GET /privacy/overview: the duties of every company this person's privacy.view reaches, and each site's floor gate. */
export const privacyOverview = (api: ApiClient, signal?: AbortSignal) => api.get('/privacy/overview', { schema: overviewSchema, signal }).then((answer) => answer.companies)
/** GET /privacy/notices?companyId=: every version of the company's three notices. */
export const listNotices = (api: ApiClient, companyId: string, signal?: AbortSignal) =>
  api.get('/privacy/notices', { query: { companyId }, schema: z.object({ company, notices: z.array(noticeSchema) }), signal }).then((answer) => answer.notices)
export const getNotice = (api: ApiClient, noticeId: string, signal?: AbortSignal) => api.get(`/privacy/notices/${seg(noticeId)}`, { schema: oneNotice, signal }).then((answer) => answer.notice)
/** Counts for every viewer; names (sorted by name, never a ranking) only with privacy.manage. */
export const noticeAcks = (api: ApiClient, noticeId: string, signal?: AbortSignal) => api.get(`/privacy/notices/${seg(noticeId)}/acknowledgements`, { schema: acksSchema, signal })
export const listDpia = (api: ApiClient, companyId: string, signal?: AbortSignal) => api.get('/privacy/dpia', { query: { companyId }, schema: dpiaListSchema, signal })
export const listActivities = (api: ApiClient, companyId: string, signal?: AbortSignal) =>
  api.get('/privacy/register', { query: { companyId }, schema: z.object({ company, activities: z.array(activitySchema) }), signal }).then((answer) => answer.activities)

// ---- notices -----------------------------------------------------------------------------------------------------------------

export const createNotice = (api: ApiClient, body: { companyId: string; kind: NoticeKind; label?: string; copyTexts: boolean }, idempotencyKey: string) =>
  api.post('/privacy/notices', { body, schema: oneNotice, idempotencyKey }).then((answer) => answer.notice)
export const putText = (api: ApiClient, noticeId: string, locale: string, body: string, version: number) =>
  api.request('PUT', `/privacy/notices/${seg(noticeId)}/texts/${seg(locale)}`, { body: { body, version }, schema: oneNotice, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.notice)
export const deleteText = (api: ApiClient, noticeId: string, locale: string, version: number) =>
  api.request('DELETE', `/privacy/notices/${seg(noticeId)}/texts/${seg(locale)}`, { query: { version }, schema: oneNotice }).then((answer) => answer.notice)
/** privacy.manage + a fresh code (the API asks it: 403 `stepUp`); its languages are checked first (409 with each missing one). */
export const publishNotice = (api: ApiClient, noticeId: string, version: number, idempotencyKey: string) =>
  api.post(`/privacy/notices/${seg(noticeId)}/publish`, { body: { version }, schema: z.object({ notice: noticeSchema, superseded: z.object({ id: z.string(), label: z.string() }).nullable() }), idempotencyKey })
export const deleteNotice = (api: ApiClient, noticeId: string, version: number) => api.request('DELETE', `/privacy/notices/${seg(noticeId)}`, { query: { version }, schema: z.object({ deleted: z.literal(true) }) })
/** A worker's signed paper copy of the worker notice in force (privacy.manage over the worker's company and site). */
export const paperAck = (api: ApiClient, noticeId: string, body: { workerId: string; locale: string }, idempotencyKey: string) =>
  api.post(`/privacy/notices/${seg(noticeId)}/paper-acknowledgements`, { body, schema: z.object({ acknowledgementId: z.string(), changed: z.boolean() }), idempotencyKey })

// ---- files: announce → the bytes straight to the store → complete ------------------------------------------------------------

export interface PickedFile {
  readonly name: string
  readonly contentType: string
  readonly size: number
  readonly bytes: ArrayBuffer
}
export async function pickedFile(file: File): Promise<PickedFile> {
  return { name: file.name, contentType: file.type || 'application/pdf', size: file.size, bytes: await file.arrayBuffer() }
}
const announced = z.object({ file: z.object({ id: z.string() }).loose(), upload: presignedSchema })
async function announceAndSend(api: ApiClient, path: string, file: PickedFile): Promise<string> {
  const sha256 = await sha256Hex(file.bytes)
  const answer = await api.post(path, { body: { originalName: file.name, contentType: file.contentType, sizeBytes: file.size, sha256 }, schema: announced, idempotencyKey: newIdempotencyKey() })
  await putToStore(answer.upload as Presigned, file.bytes)
  return answer.file.id
}

/** A language of a DRAFT as a PDF (a worker's own language that the screens do not speak, Q15). */
export async function uploadTextPdf(api: ApiClient, noticeId: string, locale: string, file: PickedFile): Promise<Notice> {
  const base = `/privacy/notices/${seg(noticeId)}/texts/${seg(locale)}/pdf`
  const fileId = await announceAndSend(api, base, file)
  return (await api.post(`${base}/${seg(fileId)}/complete`, { schema: oneNotice.extend({ file: z.object({ id: z.string() }).loose() }) })).notice
}

/** GET /files/<id>/download: a presigned GET that lives 60 seconds (always an attachment). */
export async function fileAddress(api: ApiClient, fileId: string): Promise<string> {
  const answer = await api.get(`/files/${seg(fileId)}/download`, { schema: z.object({ download: presignedSchema }) })
  const url = answer.download.url
  return url.startsWith('/') && !url.startsWith('//') ? `/api${url}` : url
}

// ---- the DPIA ----------------------------------------------------------------------------------------------------------------

export const createDpia = (api: ApiClient, body: { companyId: string; scope?: string }, idempotencyKey: string) => api.post('/privacy/dpia', { body, schema: z.object({ dpia: dpiaSchema }), idempotencyKey }).then((answer) => answer.dpia)
export async function uploadDpiaPdf(api: ApiClient, dpiaId: string, file: PickedFile): Promise<Dpia> {
  const base = `/privacy/dpia/${seg(dpiaId)}/pdf`
  const fileId = await announceAndSend(api, base, file)
  return (await api.post(`${base}/${seg(fileId)}/complete`, { schema: z.object({ dpia: dpiaSchema }).loose() })).dpia
}
/** privacy.manage + a fresh code: the signed draft is stored; the one stored before is superseded. */
export const storeDpia = (api: ApiClient, dpiaId: string, body: { signedByName: string; signedOn: string; reviewDueOn: string; version: number }, idempotencyKey: string) =>
  api.post(`/privacy/dpia/${seg(dpiaId)}/store`, { body, schema: z.object({ dpia: dpiaSchema, superseded: z.string().nullable() }), idempotencyKey })

// ---- the record of processing activities -----------------------------------------------------------------------------------

export interface ActivityFields {
  name: string
  purpose: string
  legalBasis: string
  dataSubjects: string[]
  dataCategories: string[]
  recipients: string[]
  processors: string[]
  transfers: string
  retention: string
  security: string
}
export const createActivity = (api: ApiClient, body: ActivityFields & { companyId: string; code: string }, idempotencyKey: string) =>
  api.post('/privacy/register', { body, schema: oneActivity, idempotencyKey }).then((answer) => answer.activity)
export const patchActivity = (api: ApiClient, activityId: string, body: Partial<ActivityFields> & { version: number }) =>
  api.request('PATCH', `/privacy/register/${seg(activityId)}`, { body, schema: oneActivity }).then((answer) => answer.activity)
export const archiveActivity = (api: ApiClient, activityId: string, version: number) =>
  api.post(`/privacy/register/${seg(activityId)}/archive`, { body: { version }, schema: oneActivity }).then((answer) => answer.activity)
