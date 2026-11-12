import { z } from 'zod'
import {
  assigneesView,
  bulkAnswer,
  inquiryList,
  inquiryView,
  mailDraftView,
  quoteAnswer,
  type CreateInquiryBody,
  type FromMailBody,
  type UpdateInquiryBody,
} from '@nexus/factory-domain/sales/inquiries/contracts'
import type { DeclineReason, InquirySource, InquiryTile } from '@nexus/factory-domain/sales/inquiries/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { completeUpload, downloadLink, requestUpload } from '../../../record-panels/api'
import { contentTypeOf, uploadProblem, type FileKind } from '../../../record-panels/model'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Sales › Inquiries (SCR-105 and the inquiry's full page; apps/factory-api modules/sales/inquiries, B-W2b-295),
 * each answer checked against the API's own contracts (factory-domain sales/inquiries/contracts; zod drops unknown fields).
 * Every write carries the version the screen read and one Idempotency-Key per attempt. The API's English (a refusal's
 * message, the quote's `warnings`, `leftOut[].reason`) is never shown: the screens say their own words from codes and facts
 * (model.ts). The money fields are the target price and the quote's value, both prices: the API leaves them out without
 * money.price and the screens never send a price without it. Beside them: the customer, contact and style pickers, the
 * thread's mail for the decline's message, and the files (the generic routes, record type Inquiry).
 */

export type InquiryList = z.infer<typeof inquiryList>
export type InquiryRow = InquiryList['rows'][number]
export type InquiryView = z.infer<typeof inquiryView>
export type InquiryLine = InquiryView['lines'][number]
export type InquiryFile = InquiryView['files'][number]
export type QuoteAnswer = z.infer<typeof quoteAnswer>
export type BulkAnswer = z.infer<typeof bulkAnswer>
export type MailDraft = z.infer<typeof mailDraftView>
export type Assignee = z.infer<typeof assigneesView>['people'][number]
export type Assignees = z.infer<typeof assigneesView>

const enc = encodeURIComponent
const base = '/sales/inquiries'
const one = (inquiryId: string) => `${base}/${enc(inquiryId)}`
const key = (idempotencyKey?: string) => ({ idempotencyKey: idempotencyKey ?? newIdempotencyKey() })
const answer = z.object({ inquiry: inquiryView })

/** The most rows one read brings (the API's limit). */
export const LIST_LIMIT = 200

// ---- the list -------------------------------------------------------------------------------------------------------------

export interface InquiryQuery {
  tile?: InquiryTile | null
  source?: InquirySource | null
  partyId?: string | null
  prospect?: boolean
  q?: string
}

export function listInquiries(api: ApiClient, query: InquiryQuery, signal?: AbortSignal): Promise<InquiryList> {
  return api.get(base, {
    query: {
      tile: query.tile ?? undefined,
      source: query.source ?? undefined,
      partyId: query.prospect ? undefined : (query.partyId ?? undefined),
      prospect: query.prospect ? 'true' : undefined,
      q: query.q?.trim() || undefined,
      limit: LIST_LIMIT,
    },
    schema: inquiryList,
    signal,
  })
}

// ---- one inquiry ------------------------------------------------------------------------------------------------------------

export function readInquiry(api: ApiClient, inquiryId: string, signal?: AbortSignal): Promise<InquiryView> {
  return api.get(one(inquiryId), { schema: answer, signal }).then((result) => result.inquiry)
}

export function createInquiry(api: ApiClient, body: CreateInquiryBody, idempotencyKey?: string): Promise<InquiryView> {
  return api.post(base, { body, schema: answer, ...key(idempotencyKey) }).then((result) => result.inquiry)
}

export function updateInquiry(api: ApiClient, inquiryId: string, body: UpdateInquiryBody, idempotencyKey?: string): Promise<InquiryView> {
  return api.request('PATCH', one(inquiryId), { body, schema: answer, ...key(idempotencyKey) }).then((result) => result.inquiry)
}

export function assignInquiry(api: ApiClient, inquiryId: string, body: { version: number; assigneeId: string | null }, idempotencyKey?: string): Promise<InquiryView> {
  return api.post(`${one(inquiryId)}/assign`, { body, schema: answer, ...key(idempotencyKey) }).then((result) => result.inquiry)
}

export function askInfo(api: ApiClient, inquiryId: string, version: number, idempotencyKey?: string): Promise<InquiryView> {
  return api.post(`${one(inquiryId)}/ask-info`, { body: { version }, schema: answer, ...key(idempotencyKey) }).then((result) => result.inquiry)
}

export function resumeInquiry(api: ApiClient, inquiryId: string, version: number, idempotencyKey?: string): Promise<InquiryView> {
  return api.post(`${one(inquiryId)}/resume`, { body: { version }, schema: answer, ...key(idempotencyKey) }).then((result) => result.inquiry)
}

export function declineInquiry(api: ApiClient, inquiryId: string, body: { version: number; reason: DeclineReason; note?: string }, idempotencyKey?: string): Promise<InquiryView> {
  return api.post(`${one(inquiryId)}/decline`, { body, schema: answer, ...key(idempotencyKey) }).then((result) => result.inquiry)
}

export function loseInquiry(api: ApiClient, inquiryId: string, body: { version: number; note: string }, idempotencyKey?: string): Promise<InquiryView> {
  return api.post(`${one(inquiryId)}/lost`, { body, schema: answer, ...key(idempotencyKey) }).then((result) => result.inquiry)
}

export function quoteInquiry(api: ApiClient, inquiryId: string, body: { version: number; customerRef?: string }, idempotencyKey?: string): Promise<QuoteAnswer> {
  return api.post(`${one(inquiryId)}/quote`, { body, schema: quoteAnswer, ...key(idempotencyKey) })
}

// ---- a selection: all or none -------------------------------------------------------------------------------------------------

export interface BulkItem {
  inquiryId: string
  version: number
}

export function assignMany(api: ApiClient, items: readonly BulkItem[], assigneeId: string | null, idempotencyKey?: string): Promise<BulkAnswer> {
  return api.post(`${base}/assign`, { body: { items: [...items], assigneeId }, schema: bulkAnswer, ...key(idempotencyKey) })
}

export function declineMany(api: ApiClient, items: readonly BulkItem[], body: { reason: DeclineReason; note?: string }, idempotencyKey?: string): Promise<BulkAnswer> {
  return api.post(`${base}/decline`, { body: { items: [...items], ...body }, schema: bulkAnswer, ...key(idempotencyKey) })
}

/** Who an inquiry of a company (and customer) may be given to: by name, nobody counted. */
export function listAssignees(api: ApiClient, companyId: string, partyId: string | null, signal?: AbortSignal): Promise<Assignees> {
  return api.get(`${base}/assignees`, { query: { companyId, partyId: partyId ?? undefined }, schema: assigneesView, signal })
}

// ---- "Make an inquiry" from a mail ------------------------------------------------------------------------------------------

export function readMailDraft(api: ApiClient, inboundEmailId: string, signal?: AbortSignal): Promise<MailDraft> {
  return api.get(`${base}/from-mail/${enc(inboundEmailId)}`, { schema: mailDraftView, signal })
}

export function createFromMail(api: ApiClient, inboundEmailId: string, body: FromMailBody, idempotencyKey?: string): Promise<InquiryView> {
  return api.post(`${base}/from-mail/${enc(inboundEmailId)}`, { body, schema: answer, ...key(idempotencyKey) }).then((result) => result.inquiry)
}

/** The mail's version, read with the mail's own route (the inquiry's command checks it). */
export function readMailVersion(api: ApiClient, inboundEmailId: string, signal?: AbortSignal): Promise<number> {
  return api.get(`/email/inbound/${enc(inboundEmailId)}`, { schema: z.object({ mail: z.object({ version: z.number().int() }) }), signal }).then((result) => result.mail.version)
}

// ---- the pickers: customers, contacts, styles -----------------------------------------------------------------------------------

const partyOption = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })
export type PartyOption = z.infer<typeof partyOption>

/** The customers and brands an inquiry may be from (parties.view). */
export function listCustomers(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<PartyOption[]> {
  return api
    .get('/parties', { query: { role: 'CUSTOMER,BRAND', status: 'ACTIVE', companyId: companyId ?? undefined, limit: 200 }, schema: z.object({ parties: z.array(partyOption) }), signal })
    .then((result) => result.parties)
}

const contactOption = z.object({ id: z.string(), name: z.string(), email: z.string().nullable(), status: z.string() })
export type ContactOption = z.infer<typeof contactOption>

/** A customer's active contacts (the inquiry's contact). */
export function listContacts(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<ContactOption[]> {
  return api
    .get(`/parties/${enc(partyId)}`, { schema: z.object({ party: z.object({ contacts: z.array(contactOption) }) }), signal })
    .then((result) => result.party.contacts.filter((contact) => contact.status === 'ACTIVE'))
}

const styleOption = z.object({ id: z.string(), code: z.string(), name: z.string(), sizes: z.array(z.string()), status: z.string() })
export type StyleOption = z.infer<typeof styleOption>

export function findStyles(api: ApiClient, q: string, signal?: AbortSignal): Promise<StyleOption[]> {
  return api.get('/product/styles', { query: { q: q.trim() || undefined, status: 'OPEN', limit: 200 }, schema: z.object({ styles: z.array(styleOption) }), signal }).then((result) => result.styles)
}

const styleDetail = z.object({
  style: styleOption.extend({
    colourways: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), status: z.string(), offeredSizes: z.array(z.string()) })),
  }),
})
export type StyleDetail = z.infer<typeof styleDetail>['style']

export function readStyle(api: ApiClient, styleId: string, signal?: AbortSignal): Promise<StyleDetail> {
  return api.get(`/product/styles/${enc(styleId)}`, { schema: styleDetail, signal }).then((result) => result.style)
}

// ---- the thread's mail (the decline's message) and the files -------------------------------------------------------------------

/** POST /threads/Inquiry/<id>/emails: the decline's message to the customer, as the person (the thread's own composer route). */
export function messageCustomer(api: ApiClient, inquiryId: string, input: { to: string; subject: string; body: string }, idempotencyKey?: string): Promise<unknown> {
  return api.post(`/threads/Inquiry/${enc(inquiryId)}/emails`, { body: { to: [input.to], subject: input.subject, body: input.body, attachments: [] }, ...key(idempotencyKey) })
}

/** A file's download address (a presigned GET; a same-origin path goes through this app's /api). Always an attachment. */
export async function fileAddress(api: ApiClient, fileId: string): Promise<string> {
  const { download } = await downloadLink(api, fileId)
  return download.url.startsWith('/') && !download.url.startsWith('//') ? `/api${download.url}` : download.url
}

/** The kind a file added at New inquiry is filed as: a picture a PHOTO, anything else an ATTACHMENT (the panel's rules). */
export const kindOfUpload = (file: { type: string; name: string }): FileKind => ((file.type || contentTypeOf(file.name)).startsWith('image/') ? 'PHOTO' : 'ATTACHMENT')

/** Why a picked file cannot be added (its type or size), in the record panels' words, or null. */
export const uploadRefusal = (file: File): { key: string; params?: Record<string, string | number> } | null => uploadProblem({ name: file.name, type: file.type || contentTypeOf(file.name), size: file.size }, kindOfUpload(file))

/** One file onto the inquiry (files.upload): announce, send the bytes, confirm. Office only; shared later from Files & specs. */
export async function uploadFile(api: ApiClient, inquiry: { id: string; companyId: string }, file: File): Promise<void> {
  const bytes = await file.arrayBuffer()
  const { file: stored, upload } = await requestUpload(api, {
    companyId: inquiry.companyId,
    record: { type: 'Inquiry', id: inquiry.id },
    kind: kindOfUpload(file),
    name: file.name || 'file',
    contentType: file.type || contentTypeOf(file.name),
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(upload, bytes)
  await completeUpload(api, stored.id)
}
