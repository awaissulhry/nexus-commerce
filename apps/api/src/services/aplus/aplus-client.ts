/**
 * Amazon A+ content (2026-10-19) — the client the A+ tools run on: the ten A+ Content operations of
 * aplusContent_2020-11-01.json and the one Uploads operation that gives an image its upload destination. Every call
 * names its Amazon account and goes through the channel gateway (`amazonSellerFetch` → `gatewayFetch`: account state,
 * the Amazon publish mode for writes, rate bucket, one call-ledger row). Nothing here reads or writes Nexus's own A+
 * rows: Amazon's document is the record.
 *
 * What the model and Amazon's guides say, and this file keeps:
 *   - getContentDocument / listContentDocumentAsinRelations take `includedDataSet` as ONE comma-separated value
 *     (`CONTENTS,METADATA`); repeating the parameter keeps only the first. `asinSet` is comma-separated too.
 *   - validateContentDocumentAsinRelations is a POST that changes nothing, and it is sent as a read (`kind: 'read'`):
 *     the gateway's own list knows the bare operationId, not this file's `aplus.`-prefixed ledger name, and would class
 *     it as a write that a dry run refuses. A 200 from it can still carry `errors`.
 *   - updateContentDocument and postContentDocumentAsinRelations (which REPLACES the whole set) give the same result
 *     when sent twice: idempotent. create, submit and suspend are never repeated by the gateway.
 *   - Answers are flat JSON; the Uploads answer is inside `payload`.
 *   - The upload destination's `url` carries a signature and a POST policy: it is returned to the one caller that
 *     posts the photo (aplus-images.ts) and never logged, stored or put in an error.
 *
 * Errors: one class, `AplusError`, whose message is already the sentence a person reads (`aplusErrorSentence`). Nothing
 * sent (a gateway refusal — a dry run has status 200) is `refused`; no answer is `no_answer`; Amazon's 400 / 403 / 404 /
 * 429 / 5xx are invalid / forbidden / not_found / throttled / unavailable, with Amazon's `errors[]` kept in `amazon`.
 */
import prisma from '../../db.js'
import { amazonAccount } from '../../lib/amazon-sp-client.js'
import { amazonSellerFetch } from '../gateway/amazon-sdk.js'
import { getAmazonPublishMode } from '../amazon-publish-gate.service.js'
import { languageTag, marketLanguages } from '../pim/market-languages.js'
import { normalizeLanguage } from '../pim/content-language.js'
import type { PublishMode } from '../gateway/channels.js'
import type { GatewayRefusal } from '../gateway/gateway.js'
import type { AplusModuleType } from './aplus-modules.js'

export type AplusContentType = 'EBC' | 'EMC' | 'BrandStory'
export type AplusStatus = 'APPROVED' | 'DRAFT' | 'REJECTED' | 'SUBMITTED'
export type AplusBadge = 'BULK' | 'GENERATED' | 'LAUNCHPAD' | 'PREMIUM' | 'STANDARD'
export type AplusAsinBadge = 'BRAND_NOT_ELIGIBLE' | 'CATALOG_NOT_FOUND' | 'CONTENT_NOT_PUBLISHED' | 'CONTENT_PUBLISHED'
export interface AplusMessage { code: string; message: string; details?: string | null }
/** ContentMetadata. It has no contentType: the tier is the badge (PREMIUM or STANDARD; none for Brand Story). */
export interface AplusMetadata { name: string; marketplaceId: string; status: AplusStatus; badgeSet: AplusBadge[]; updateTime: string }
export interface AplusModule { contentModuleType: AplusModuleType; [payloadKey: string]: unknown }
export interface AplusDocument { name: string; contentType: AplusContentType; contentSubType?: string; locale: string; contentModuleList: AplusModule[] }
export interface AplusRecord { contentReferenceKey: string; contentMetadata: AplusMetadata | null; contentDocument: AplusDocument | null }
export interface AplusAsin { asin: string; badgeSet: AplusAsinBadge[]; parent: string | null; title: string | null; imageUrl: string | null; contentReferenceKeySet: string[] }
/** A publish record. Its `locale` is in Amazon's underscore form (en_US) and read-only. */
export interface AplusPublishRecord { marketplaceId: string; locale: string; asin: string; contentType: AplusContentType; contentSubType: string | null; contentReferenceKey: string }
/** Where an A+ call goes: the Amazon account (ChannelConnection id) and the marketplace. */
export interface AplusTarget { accountId: string; marketplaceId: string }
export interface AplusMarket extends AplusTarget {
  /** The market code as business-overview lists it (UK for Great Britain). */
  market: string
  marketName: string
  /** The content language the document is written in (it, de, …). */
  language: string
  /** The document's locale, with a hyphen (it-IT, en-GB). */
  locale: string
  publishMode: PublishMode
}

export type AplusErrorCode = 'not_found' | 'forbidden' | 'invalid' | 'throttled' | 'unavailable' | 'no_answer' | 'refused' | 'unexpected'

/** An A+ call that did not give its answer. `message` is the plain sentence a person reads. */
export class AplusError extends Error {
  constructor(readonly code: AplusErrorCode, message: string, readonly status: number, readonly operation: string, readonly amazon: AplusMessage[] = []) {
    super(message)
    this.name = 'AplusError'
  }
}

// ── Plain words ──────────────────────────────────────────────────────────────────────────────────────

const BRAND_REGISTRY = 'Amazon refused it: this seller account cannot make Brand Story content. Brand Story needs the brand enrolled in Amazon Brand Registry.'
const READ_OPERATIONS = new Set([
  'aplus.searchContentDocuments', 'aplus.getContentDocument', 'aplus.listContentDocumentAsinRelations',
  'aplus.validateContentDocumentAsinRelations', 'aplus.searchContentPublishRecords',
])

const trimStop = (text: string) => text.trim().replace(/[.\s]+$/, '')

/**
 * One of Amazon's error entries in plain words. A field check names the module (counted from 1) and the field path:
 * "Request failed validation: create….contentDocument.contentModuleList[0].premiumImageText.headline: …" →
 * "module 1, premiumImageText.headline: …".
 */
function describeAmazonMessage(entry: AplusMessage): string {
  const details = (entry.details ?? '').trim()
  const field = /contentModuleList\[(\d+)\]\.([^:\s]+):\s*([\s\S]*)$/.exec(details)
  if (field) return `module ${Number(field[1]) + 1}, ${field[2]}: ${trimStop(field[3])}`
  const document = /^Request failed validation:\s*(?:\S*?\.)?contentDocument\.(\S+?):\s*([\s\S]*)$/.exec(details)
  if (document) return `${document[1]}: ${trimStop(document[2])}`
  const generic = /^Request failed validation:\s*(?:\S*?\.)?([^.\s]+):\s*([\s\S]*)$/.exec(details)
  if (generic) return `${generic[1]}: ${trimStop(generic[2])}`
  // A JSON shape error names the property in `details`; Amazon's `message` is then only "The request syntax is malformed…".
  return trimStop(details || entry.message)
}

/**
 * Amazon's error or warning entries (an answer's `errors[]`, or what validateContentDocumentAsinRelations found) in
 * plain words, joined with "; ", each module counted from 1. Empty when there are none.
 */
export function describeAplusMessages(messages: readonly AplusMessage[]): string {
  return [...new Set(messages.map(describeAmazonMessage).filter(Boolean))].join('; ')
}

function invalidSentence(amazon: AplusMessage[]): string {
  if (amazon.some((entry) => /shouldn'?t be using project type/i.test(`${entry.message} ${entry.details ?? ''}`))) return BRAND_REGISTRY
  const described = describeAplusMessages(amazon)
  return described ? `Amazon refused it: ${described}.` : 'Amazon refused it as not valid (HTTP 400), without saying why.'
}

const amazonText = (amazon: AplusMessage[]) => [...new Set(amazon.map((entry) => trimStop(entry.message || entry.details || '')).filter(Boolean))].join('; ')

/** The sentence for Amazon's answer `status` to `operation`. */
function answerSentence(code: AplusErrorCode, status: number, operation: string, amazon: AplusMessage[]): string {
  switch (code) {
    case 'invalid': return invalidSentence(amazon)
    case 'forbidden':
      return `Amazon refused access (${amazonText(amazon) || `HTTP ${status}`}). The Nexus Amazon app may lack the Product Listing role, the document may be in another market, or an ASIN is not in your brand.`
    case 'not_found': return 'Amazon has no such A+ document in this market.'
    case 'throttled': return 'Amazon is busy (too many A+ requests at once); ask again in a minute.'
    case 'unavailable': return `Amazon's A+ service did not work just now (HTTP ${status}); ask again in a few minutes.`
    default: return `Amazon answered HTTP ${status} to ${operation}${amazonText(amazon) ? `: ${amazonText(amazon)}` : ''}.`
  }
}

function noAnswerSentence(operation: string): string {
  return READ_OPERATIONS.has(operation)
    ? 'Amazon did not answer; ask again in a minute.'
    : 'Amazon did not answer; it may or may not have applied it — read it with aplus-content before asking again.'
}

/**
 * Any error of an A+ call as the sentence a person reads. An `AplusError` already is one; a gateway refusal says what
 * was not sent; anything else is said as Nexus's own failure. Never contains an upload address.
 */
export function aplusErrorSentence(error: unknown): string {
  if (error instanceof AplusError) return error.message
  if (error instanceof Error) {
    if (error.name === 'GatewayRefusal' || error.name === 'AplusImageError' || error.name === 'WorkspaceError') return error.message
    if (error.name === 'GatewayNoAnswer') return noAnswerSentence((error as { operation?: string }).operation ?? '')
    return `Nexus could not finish the A+ call: ${error.message}`
  }
  return `Nexus could not finish the A+ call: ${String(error)}`
}

// ── The transport ────────────────────────────────────────────────────────────────────────────────────

const APLUS = '/aplus/2020-11-01'
const UPLOAD_OPERATION = 'uploads.createUploadDestinationForResource'

/** A query string in the given order; a list goes as ONE comma-separated value (Amazon's csv collection format). */
function query(params: Record<string, string | readonly string[] | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== undefined && (typeof value === 'string' ? value !== '' : value.length > 0))
    .map(([name, value]) => `${name}=${typeof value === 'string' ? encodeURIComponent(value) : value.map(encodeURIComponent).join(',')}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

const documentPath = (key: string) => `${APLUS}/contentDocuments/${encodeURIComponent(key)}`

interface Call {
  method: 'GET' | 'POST'
  path: string
  /** The ledger name: `aplus.<operationId>` or `uploads.createUploadDestinationForResource`. */
  operation: string
  body?: unknown
  kind?: 'read'
  idempotent?: boolean
}

function fromThrown(error: unknown, operation: string): AplusError {
  if (error instanceof AplusError) return error
  if (error instanceof Error && error.name === 'GatewayRefusal') {
    const refusal = error as GatewayRefusal
    return new AplusError('refused', refusal.message, refusal.statusCode ?? 0, operation)
  }
  if (error instanceof Error && error.name === 'GatewayNoAnswer') return new AplusError('no_answer', noAnswerSentence(operation), 0, operation)
  // The account the call names could not be used (amazonAccount: unavailable, needs sign-in, another business's).
  if (error instanceof Error && error.name === 'WorkspaceError') return new AplusError('refused', error.message, (error as { statusCode?: number }).statusCode ?? 409, operation)
  const failure = new AplusError('unexpected', `Nexus could not send ${operation} to Amazon: ${error instanceof Error ? error.message : String(error)}`, 0, operation)
  return Object.assign(failure, { cause: error })
}

function codeOf(status: number): AplusErrorCode {
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'invalid'
  if (status === 401 || status === 403) return 'forbidden'
  if (status === 404 || status === 410) return 'not_found'
  if (status === 429) return 'throttled'
  if (status >= 500) return 'unavailable'
  return 'unexpected'
}

function messagesOf(value: unknown): AplusMessage[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => entry && typeof entry === 'object').map((entry: Record<string, unknown>) => ({
    code: typeof entry.code === 'string' ? entry.code : '',
    message: typeof entry.message === 'string' ? entry.message : '',
    ...(typeof entry.details === 'string' && entry.details ? { details: entry.details } : {}),
  }))
}

/** Send one A+ call through the gateway; the answer's body (unwrapped from `payload` when Amazon wraps it), or AplusError. */
async function send(target: AplusTarget, call: Call): Promise<Record<string, any>> {
  let res: Response
  try {
    res = await amazonSellerFetch({
      accountId: target.accountId,
      method: call.method,
      path: call.path,
      operation: call.operation,
      ...(call.body !== undefined ? { body: call.body } : {}),
      ...(call.kind ? { kind: call.kind } : {}),
      ...(call.idempotent !== undefined ? { idempotent: call.idempotent } : {}),
    })
  } catch (error) {
    throw fromThrown(error, call.operation)
  }
  const text = await res.text()
  let parsed: unknown = null
  try { parsed = text ? JSON.parse(text) : {} } catch { parsed = null }
  if (!res.ok) {
    const amazon = messagesOf((parsed as { errors?: unknown } | null)?.errors)
    const code = codeOf(res.status)
    throw new AplusError(code, answerSentence(code, res.status, call.operation, amazon), res.status, call.operation, amazon)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unreadable(call.operation, res.status)
  const body = parsed as Record<string, any>
  return body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : body
}

const unreadable = (operation: string, status: number) =>
  new AplusError('unexpected', `Amazon answered ${operation} in a form Nexus does not read (HTTP ${status}).`, status, operation)

// ── Answers, typed from the model ────────────────────────────────────────────────────────────────────

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

function metadataOf(value: unknown): AplusMetadata | null {
  if (!value || typeof value !== 'object') return null
  const m = value as Record<string, unknown>
  return { name: str(m.name) ?? '', marketplaceId: str(m.marketplaceId) ?? '', status: m.status as AplusStatus, badgeSet: strings(m.badgeSet) as AplusBadge[], updateTime: str(m.updateTime) ?? '' }
}

function documentOf(value: unknown): AplusDocument | null {
  if (!value || typeof value !== 'object') return null
  const d = value as Record<string, any>
  return {
    name: str(d.name) ?? '',
    contentType: d.contentType as AplusContentType,
    ...(str(d.contentSubType) ? { contentSubType: d.contentSubType as string } : {}),
    locale: str(d.locale) ?? '',
    contentModuleList: Array.isArray(d.contentModuleList) ? (d.contentModuleList as AplusModule[]) : [],
  }
}

function asinOf(value: Record<string, unknown>): AplusAsin {
  return {
    asin: str(value.asin) ?? '',
    badgeSet: strings(value.badgeSet) as AplusAsinBadge[],
    parent: str(value.parent),
    title: str(value.title),
    imageUrl: str(value.imageUrl),
    contentReferenceKeySet: strings(value.contentReferenceKeySet),
  }
}

const warningsOf = (body: Record<string, unknown>) => messagesOf(body.warnings)
const nextOf = (body: Record<string, unknown>) => str(body.nextPageToken)
const records = (value: unknown): Array<Record<string, any>> => (Array.isArray(value) ? value.filter((v) => v && typeof v === 'object') : [])

// ── The market ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The Amazon market a tool names, in this business: its marketplace id (from the Marketplace row), the content language
 * (asked, or the market's first), the document locale with a hyphen (it-IT; UK → en-GB), the Amazon account (the one
 * named, or the one the resolver allows) and the publish mode. Both refusals contain "not found".
 */
export async function resolveAplusMarket(input: { market: string; accountId?: string; language?: string }): Promise<AplusMarket | { error: string }> {
  const asked = String(input.market ?? '').trim().toUpperCase()
  const code = asked === 'GB' ? 'UK' : asked
  const row = await prisma.marketplace.findFirst({
    where: { channel: 'AMAZON', code },
    select: { code: true, name: true, marketplaceId: true, language: true, languages: true },
  })
  if (!row || !row.marketplaceId) return { error: `The Amazon market ${code || '(none)'} is not found in this business (business-overview lists its markets).` }
  let languages: string[]
  let language: string
  let locale: string
  try {
    languages = marketLanguages('AMAZON', row.code, [{ channel: 'AMAZON', code: row.code, languages: row.languages ?? [], language: row.language }])
    if (input.language !== undefined) {
      let wanted: string
      try { wanted = normalizeLanguage(input.language) } catch { wanted = '' }
      if (!wanted || !languages.includes(wanted)) {
        return { error: `Amazon ${row.code} content is written in ${languages.join(' or ')}; ${JSON.stringify(input.language)} is not one of its languages.` }
      }
      language = wanted
    } else {
      language = languages[0]
    }
    locale = languageTag(language, row.code).replace('_', '-')
  } catch (error) {
    return { error: `The Amazon market ${row.code} has no content language Nexus can use: ${error instanceof Error ? error.message : String(error)}` }
  }
  let accountId: string
  try {
    accountId = (await amazonAccount({ accountId: input.accountId })).id
  } catch (error) {
    return { error: `Amazon account not found for this business: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { accountId, marketplaceId: row.marketplaceId, market: row.code, marketName: row.name, language, locale, publishMode: getAmazonPublishMode() }
}

// ── The A+ operations ────────────────────────────────────────────────────────────────────────────────

/** The account's A+ and Brand Story documents in the market, metadata only, one Amazon page at a time. */
export async function searchContentDocuments(t: AplusTarget, pageToken?: string): Promise<{ records: Array<{ contentReferenceKey: string; contentMetadata: AplusMetadata }>; nextPageToken: string | null; warnings: AplusMessage[] }> {
  const operation = 'aplus.searchContentDocuments'
  const body = await send(t, { method: 'GET', path: `${APLUS}/contentDocuments${query({ marketplaceId: t.marketplaceId, pageToken })}`, operation })
  if (!Array.isArray(body.contentMetadataRecords)) throw unreadable(operation, 200)
  return {
    records: records(body.contentMetadataRecords)
      .filter((r) => str(r.contentReferenceKey) && metadataOf(r.contentMetadata))
      .map((r) => ({ contentReferenceKey: r.contentReferenceKey as string, contentMetadata: metadataOf(r.contentMetadata)! })),
    nextPageToken: nextOf(body),
    warnings: warningsOf(body),
  }
}

/** One document: its content and metadata (the default), or its metadata only. */
export async function getContentDocument(t: AplusTarget, key: string, data: 'CONTENTS,METADATA' | 'METADATA' = 'CONTENTS,METADATA'): Promise<{ record: AplusRecord; warnings: AplusMessage[] }> {
  const operation = 'aplus.getContentDocument'
  const body = await send(t, { method: 'GET', path: `${documentPath(key)}${query({ marketplaceId: t.marketplaceId, includedDataSet: data.split(',') })}`, operation })
  const record = body.contentRecord
  if (!record || typeof record !== 'object') throw unreadable(operation, 200)
  return {
    record: { contentReferenceKey: str(record.contentReferenceKey) ?? key, contentMetadata: metadataOf(record.contentMetadata), contentDocument: documentOf(record.contentDocument) },
    warnings: warningsOf(body),
  }
}

/** One page of the ASINs a document is applied to; with `metadata`, each with its badges (CONTENT_PUBLISHED: live there), title and parent. */
export async function listContentDocumentAsinRelations(t: AplusTarget, key: string, opts: { metadata?: boolean; asins?: string[]; pageToken?: string } = {}): Promise<{ asins: AplusAsin[]; nextPageToken: string | null; warnings: AplusMessage[] }> {
  const operation = 'aplus.listContentDocumentAsinRelations'
  const path = `${documentPath(key)}/asins${query({ marketplaceId: t.marketplaceId, includedDataSet: opts.metadata ? ['METADATA'] : undefined, asinSet: opts.asins, pageToken: opts.pageToken })}`
  const body = await send(t, { method: 'GET', path, operation })
  if (!Array.isArray(body.asinMetadataSet)) throw unreadable(operation, 200)
  return { asins: records(body.asinMetadataSet).map(asinOf).filter((a) => a.asin), nextPageToken: nextOf(body), warnings: warningsOf(body) }
}

/** Every page of a document's ASINs, up to `maxPages` (20); `complete` is false when pages were left unread. */
export async function listAllAsinRelations(t: AplusTarget, key: string, opts: { metadata?: boolean; maxPages?: number } = {}): Promise<{ asins: AplusAsin[]; complete: boolean; warnings: AplusMessage[] }> {
  const maxPages = Math.max(1, opts.maxPages ?? 20)
  const asins: AplusAsin[] = []
  const warnings: AplusMessage[] = []
  let pageToken: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const answer = await listContentDocumentAsinRelations(t, key, { metadata: opts.metadata, pageToken })
    asins.push(...answer.asins)
    warnings.push(...answer.warnings)
    if (!answer.nextPageToken) return { asins, complete: true, warnings }
    pageToken = answer.nextPageToken
  }
  return { asins, complete: false, warnings }
}

/** Amazon's check of a document (on these ASINs, when given). Changes nothing; a 200 can still carry errors. */
export async function validateContentDocumentAsinRelations(t: AplusTarget, document: AplusDocument, asins?: string[]): Promise<{ errors: AplusMessage[]; warnings: AplusMessage[] }> {
  const operation = 'aplus.validateContentDocumentAsinRelations'
  const body = await send(t, {
    method: 'POST',
    path: `${APLUS}/contentAsinValidations${query({ marketplaceId: t.marketplaceId, asinSet: asins })}`,
    operation,
    body: { contentDocument: document },
    // Sent as a read: it changes nothing, and the gateway would class this ledger name as a write (see the header).
    kind: 'read',
  })
  return { errors: messagesOf(body.errors), warnings: warningsOf(body) }
}

/** A new document, made as a DRAFT applied to no ASIN. */
export async function createContentDocument(t: AplusTarget, document: AplusDocument): Promise<{ contentReferenceKey: string; warnings: AplusMessage[] }> {
  const operation = 'aplus.createContentDocument'
  const body = await send(t, { method: 'POST', path: `${APLUS}/contentDocuments${query({ marketplaceId: t.marketplaceId })}`, operation, body: { contentDocument: document }, idempotent: false })
  const key = str(body.contentReferenceKey)
  if (!key) throw unreadable(operation, 200)
  return { contentReferenceKey: key, warnings: warningsOf(body) }
}

/** Replace a document's content. An APPROVED document becomes a DRAFT; its approved version stays live until the new one is approved. */
export async function updateContentDocument(t: AplusTarget, key: string, document: AplusDocument): Promise<{ contentReferenceKey: string; warnings: AplusMessage[] }> {
  const operation = 'aplus.updateContentDocument'
  const body = await send(t, { method: 'POST', path: `${documentPath(key)}${query({ marketplaceId: t.marketplaceId })}`, operation, body: { contentDocument: document }, idempotent: true })
  return { contentReferenceKey: str(body.contentReferenceKey) ?? key, warnings: warningsOf(body) }
}

/** REPLACE the whole set of ASINs a document is applied to (an empty set too). A removed ASIN loses the content at once. */
export async function postContentDocumentAsinRelations(t: AplusTarget, key: string, asins: string[]): Promise<{ warnings: AplusMessage[] }> {
  const operation = 'aplus.postContentDocumentAsinRelations'
  const body = await send(t, { method: 'POST', path: `${documentPath(key)}/asins${query({ marketplaceId: t.marketplaceId })}`, operation, body: { asinSet: asins }, idempotent: true })
  return { warnings: warningsOf(body) }
}

/** One page of the documents published on an ASIN now (one A+ and one Brand Story at most). */
export async function searchContentPublishRecords(t: AplusTarget, asin: string, pageToken?: string): Promise<{ records: AplusPublishRecord[]; nextPageToken: string | null; warnings: AplusMessage[] }> {
  const operation = 'aplus.searchContentPublishRecords'
  const body = await send(t, { method: 'GET', path: `${APLUS}/contentPublishRecords${query({ marketplaceId: t.marketplaceId, asin, pageToken })}`, operation })
  if (!Array.isArray(body.publishRecordList)) throw unreadable(operation, 200)
  return {
    records: records(body.publishRecordList).filter((r) => str(r.contentReferenceKey) && str(r.asin)).map((r) => ({
      marketplaceId: str(r.marketplaceId) ?? t.marketplaceId,
      locale: str(r.locale) ?? '',
      asin: r.asin as string,
      contentType: r.contentType as AplusContentType,
      contentSubType: str(r.contentSubType),
      contentReferenceKey: r.contentReferenceKey as string,
    })),
    nextPageToken: nextOf(body),
    warnings: warningsOf(body),
  }
}

/** Send a document for Amazon's review; once approved it replaces what is published on its ASINs. */
export async function postContentDocumentApprovalSubmission(t: AplusTarget, key: string): Promise<{ warnings: AplusMessage[] }> {
  const operation = 'aplus.postContentDocumentApprovalSubmission'
  const body = await send(t, { method: 'POST', path: `${documentPath(key)}/approvalSubmissions${query({ marketplaceId: t.marketplaceId })}`, operation, idempotent: false })
  return { warnings: warningsOf(body) }
}

/** Take a document off every ASIN at once; the document and its ASIN set stay. */
export async function postContentDocumentSuspendSubmission(t: AplusTarget, key: string): Promise<{ warnings: AplusMessage[] }> {
  const operation = 'aplus.postContentDocumentSuspendSubmission'
  const body = await send(t, { method: 'POST', path: `${documentPath(key)}/suspendSubmissions${query({ marketplaceId: t.marketplaceId })}`, operation, idempotent: false })
  return { warnings: warningsOf(body) }
}

/**
 * Where one image's bytes go (Uploads API, resource aplus/2020-11-01/contentDocuments): its uploadDestinationId, and
 * the pre-signed storage `url` and `headers` the bytes are POSTed with. The url and headers carry a signature and a
 * policy: the caller posts the photo with them and keeps them nowhere.
 */
export async function createUploadDestination(t: AplusTarget, input: { contentMD5: string; contentType: 'image/jpeg' | 'image/png' }): Promise<{ uploadDestinationId: string; url: string; headers: Record<string, string> }> {
  const path = `/uploads/2020-11-01/uploadDestinations/aplus/2020-11-01/contentDocuments${query({ marketplaceIds: t.marketplaceId, contentMD5: input.contentMD5, contentType: input.contentType })}`
  const body = await send(t, { method: 'POST', path, operation: UPLOAD_OPERATION, idempotent: false })
  const uploadDestinationId = str(body.uploadDestinationId)
  const url = str(body.url)
  if (!uploadDestinationId || !url) throw unreadable(UPLOAD_OPERATION, 201)
  const headers: Record<string, string> = {}
  if (body.headers && typeof body.headers === 'object') {
    for (const [name, value] of Object.entries(body.headers as Record<string, unknown>)) if (typeof value === 'string') headers[name] = value
  }
  return { uploadDestinationId, url, headers }
}

/**
 * A document as it stands at Amazon now: its status and last update (METADATA), every ASIN it is applied to and those
 * it is published on (badge CONTENT_PUBLISHED). `complete` is false when not every page of ASINs was read.
 */
export async function aplusLiveState(t: AplusTarget, key: string): Promise<{ status: AplusStatus | null; updateTime: string | null; asins: string[]; publishedAsins: string[]; complete: boolean }> {
  const { record } = await getContentDocument(t, key, 'METADATA')
  const relations = await listAllAsinRelations(t, key, { metadata: true })
  return {
    status: record.contentMetadata?.status ?? null,
    updateTime: record.contentMetadata?.updateTime || null,
    asins: relations.asins.map((a) => a.asin).sort(),
    publishedAsins: relations.asins.filter((a) => a.badgeSet.includes('CONTENT_PUBLISHED')).map((a) => a.asin).sort(),
    complete: relations.complete,
  }
}
