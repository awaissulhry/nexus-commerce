import { z } from 'zod'
import {
  orderList,
  orderView,
  requestList,
  requestView,
  type CreateOrderBody,
  type CreateRequestBody,
  type OrderRow,
  type OrderView,
  type RequestRow,
  type RequestView,
  type UpdateOrderBody,
  type UpdateRequestBody,
} from '@nexus/factory-domain/product/changes/contracts'
import type { ChangeDecision, ChangeOrderStatus, ChangeRequestStatus, OrderTile, RequestTile, WipDisposition } from '@nexus/factory-domain/product/changes/rules'
import { approverOptionsView, releasedList, type ApproverOptionsView, type ReleasedList, type ReleasedRow } from '@nexus/factory-domain/product/changes/screens'
import { operationMinutesView, waitingView, type OperationMinutesView, type WaitingView } from '@nexus/factory-domain/product/minutes/contracts'
import { styleDriftView, versionsCompareView, type StyleDriftView, type VersionsCompareView } from '@nexus/factory-domain/product/versions/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { completeUpload, requestUpload } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Products › Development › Changes & versions (SCR-117 and the change's record), each answer checked against
 * the API's own contracts (factory-domain product/changes, B-W2b-226 and this step's screens.ts; product/minutes, B-W2b-215;
 * product/versions, B-W2b-220; zod drops unknown fields). Every write carries the record's version where the API asks it
 * and one Idempotency-Key per attempt. The API's English (a refusal's message, a compare's `words`) is never shown: the
 * screens say their own words from the codes and facts (model.ts). No money: the compare's cost section is not read here.
 */

export type { ApproverOptionsView, OperationMinutesView, OrderRow, OrderView, ReleasedList, ReleasedRow, RequestRow, RequestView, StyleDriftView, VersionsCompareView, WaitingView }
export type RequestList = z.infer<typeof requestList>
export type OrderList = z.infer<typeof orderList>
export type SmvWaiting = WaitingView['versions'][number]

const enc = encodeURIComponent
const key = (idempotencyKey?: string) => ({ idempotencyKey: idempotencyKey ?? newIdempotencyKey() })
const requestPath = (id: string) => `/product/change-requests/${enc(id)}`
const orderPath = (id: string) => `/product/change-orders/${enc(id)}`

// ---- the lists ---------------------------------------------------------------------------------------------------------------

export interface ListFilters {
  styleId?: string | null
  q?: string
}

export function listRequests(api: ApiClient, query: { tile: RequestTile; status?: ChangeRequestStatus } & ListFilters, limit: number, signal?: AbortSignal): Promise<RequestList> {
  return api.get('/product/change-requests', { query: { tile: query.tile, status: query.status, styleId: query.styleId ?? undefined, q: query.q?.trim() || undefined, limit }, schema: requestList, signal })
}

export function listOrders(api: ApiClient, query: { tile: OrderTile; status?: ChangeOrderStatus } & ListFilters, limit: number, signal?: AbortSignal): Promise<OrderList> {
  return api.get('/product/change-orders', { query: { tile: query.tile, status: query.status, styleId: query.styleId ?? undefined, q: query.q?.trim() || undefined, limit }, schema: orderList, signal })
}

/** The SMV changes waiting for approval (B-W2b-215; product.routing.view). */
export function listWaitingSmv(api: ApiClient, signal?: AbortSignal): Promise<WaitingView> {
  return api.get('/product/minutes/waiting', { query: { limit: 200 }, schema: waitingView, signal })
}

export function listReleased(api: ApiClient, query: ListFilters, signal?: AbortSignal): Promise<ReleasedList> {
  return api.get('/product/released-versions', { query: { styleId: query.styleId ?? undefined, q: query.q?.trim() || undefined, limit: 200 }, schema: releasedList, signal })
}

// ---- a change request ------------------------------------------------------------------------------------------------------

const oneRequest = z.object({ changeRequest: requestView })

export function readRequest(api: ApiClient, id: string, signal?: AbortSignal): Promise<RequestView> {
  return api.get(requestPath(id), { schema: oneRequest, signal }).then((answer) => answer.changeRequest)
}

export function createRequest(api: ApiClient, body: CreateRequestBody, idempotencyKey?: string): Promise<RequestView> {
  return api.post('/product/change-requests', { body, schema: oneRequest, ...key(idempotencyKey) }).then((answer) => answer.changeRequest)
}

export function updateRequest(api: ApiClient, id: string, body: UpdateRequestBody, idempotencyKey?: string): Promise<RequestView> {
  return api.request('PATCH', requestPath(id), { body, schema: oneRequest, ...key(idempotencyKey) }).then((answer) => answer.changeRequest)
}

export function moveRequest(api: ApiClient, id: string, body: { version: number; to: 'IN_REVIEW' | 'ACCEPTED' | 'REJECTED'; note?: string }, idempotencyKey?: string): Promise<RequestView> {
  return api.post(`${requestPath(id)}/move`, { body, schema: oneRequest, ...key(idempotencyKey) }).then((answer) => answer.changeRequest)
}

/** One photo onto the request (files.upload): announce, send the bytes, confirm. */
export async function uploadRequestPhoto(api: ApiClient, request: { id: string; companyId: string }, file: File): Promise<void> {
  const bytes = await file.arrayBuffer()
  const { file: stored, upload } = await requestUpload(api, {
    companyId: request.companyId,
    record: { type: 'ChangeRequest', id: request.id },
    kind: 'PHOTO',
    name: file.name || 'photo.jpg',
    contentType: file.type || 'image/jpeg',
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(upload, bytes)
  await completeUpload(api, stored.id)
}

// ---- a change order --------------------------------------------------------------------------------------------------------

const oneOrder = z.object({ changeOrder: orderView })
const orderOf = (answer: { changeOrder: OrderView }) => answer.changeOrder

export function readOrder(api: ApiClient, id: string, signal?: AbortSignal): Promise<OrderView> {
  return api.get(orderPath(id), { schema: oneOrder, signal }).then(orderOf)
}

export function createOrder(api: ApiClient, body: CreateOrderBody, idempotencyKey?: string): Promise<OrderView> {
  return api.post('/product/change-orders', { body, schema: oneOrder, ...key(idempotencyKey) }).then(orderOf)
}

export function updateOrder(api: ApiClient, id: string, body: UpdateOrderBody, idempotencyKey?: string): Promise<OrderView> {
  return api.request('PATCH', orderPath(id), { body, schema: oneOrder, ...key(idempotencyKey) }).then(orderOf)
}

export function setOrderRequests(api: ApiClient, id: string, body: { version: number; requestIds: string[] }, idempotencyKey?: string): Promise<OrderView> {
  return api.request('PUT', `${orderPath(id)}/requests`, { body, schema: oneOrder, ...key(idempotencyKey) }).then(orderOf)
}

export function setWorkInProgress(api: ApiClient, id: string, body: { version: number; lines: { workOrderId: string; disposition: WipDisposition; note?: string }[] }, idempotencyKey?: string): Promise<OrderView> {
  return api.request('PUT', `${orderPath(id)}/work-in-progress`, { body, schema: oneOrder, ...key(idempotencyKey) }).then(orderOf)
}

export function setApprovers(api: ApiClient, id: string, body: { version: number; approvers: { userId: string; required: boolean }[] }, idempotencyKey?: string): Promise<OrderView> {
  return api.request('PUT', `${orderPath(id)}/approvers`, { body, schema: oneOrder, ...key(idempotencyKey) }).then(orderOf)
}

export function startDraftRevision(api: ApiClient, id: string, body: { version: number; changeNote?: string }, idempotencyKey?: string): Promise<OrderView> {
  return api.post(`${orderPath(id)}/draft-revision`, { body, schema: oneOrder, ...key(idempotencyKey) }).then(orderOf)
}

export function submitOrder(api: ApiClient, id: string, version: number, idempotencyKey?: string): Promise<OrderView> {
  return api.post(`${orderPath(id)}/submit`, { body: { version }, schema: oneOrder, ...key(idempotencyKey) }).then(orderOf)
}

export function decideOrder(api: ApiClient, id: string, body: { version: number; decision: ChangeDecision; reason?: string }, idempotencyKey?: string): Promise<OrderView> {
  return api.post(`${orderPath(id)}/decide`, { body, schema: oneOrder, ...key(idempotencyKey) }).then(orderOf)
}

export function cancelOrder(api: ApiClient, id: string, body: { version: number; reason: string }, idempotencyKey?: string): Promise<OrderView> {
  return api.post(`${orderPath(id)}/cancel`, { body, schema: oneOrder, ...key(idempotencyKey) }).then(orderOf)
}

export function releaseOrder(api: ApiClient, id: string, body: { version: number; changeNote?: string }, idempotencyKey?: string): Promise<OrderView> {
  return api.post(`${orderPath(id)}/release`, { body, schema: oneOrder, ...key(idempotencyKey) }).then(orderOf)
}

export function approverOptions(api: ApiClient, id: string, signal?: AbortSignal): Promise<ApproverOptionsView> {
  return api.get(`${orderPath(id)}/approver-options`, { schema: approverOptionsView, signal })
}

// ---- the redline and the impact (B-W2b-220's reads) ---------------------------------------------------------------------------

/** B-W2b-245: `companyId` prices a tenant-wide style's cost section for the company the page works in (cost grain only). */
export function readCompare(api: ApiClient, compare: { styleId: string; from: string; to: string; companyId?: string | null }, signal?: AbortSignal): Promise<VersionsCompareView> {
  return api.get(`/product/styles/${enc(compare.styleId)}/versions/compare`, { query: { from: compare.from, to: compare.to, companyId: compare.companyId ?? undefined }, schema: z.object({ compare: versionsCompareView }), signal }).then((answer) => answer.compare)
}

export function readDrift(api: ApiClient, styleId: string, signal?: AbortSignal): Promise<StyleDriftView> {
  return api.get(`/product/styles/${enc(styleId)}/versions/drift`, { schema: z.object({ drift: styleDriftView }), signal }).then((answer) => answer.drift)
}

// ---- an SMV change (B-W2b-215's reads and decisions) -------------------------------------------------------------------------

export function readMinutes(api: ApiClient, operationId: string, signal?: AbortSignal): Promise<OperationMinutesView> {
  return api.get(`/product/operations/${enc(operationId)}/minutes`, { schema: z.object({ minutes: operationMinutesView }), signal }).then((answer) => answer.minutes)
}

export function decideSmv(api: ApiClient, smv: { operationId: string; versionId: string; version: number }, decision: ChangeDecision, note: string | null, idempotencyKey?: string): Promise<unknown> {
  const path = `/product/operations/${enc(smv.operationId)}/minutes/versions/${enc(smv.versionId)}/${decision === 'APPROVED' ? 'approve' : 'reject'}`
  return api.post(path, { body: { version: smv.version, ...(note ? { note } : {}) }, ...key(idempotencyKey) })
}

// ---- the pickers -----------------------------------------------------------------------------------------------------------------

const styleOption = z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string().nullable() })
export type StyleOption = z.infer<typeof styleOption>

export function findStyles(api: ApiClient, q: string, signal?: AbortSignal): Promise<StyleOption[]> {
  return api.get('/product/styles', { query: { q: q.trim() || undefined, status: 'OPEN', limit: 50 }, schema: z.object({ styles: z.array(styleOption) }), signal }).then((answer) => answer.styles)
}

const styleDetail = z.object({ style: styleOption.extend({ revisions: z.array(z.object({ id: z.string(), revision: z.number().int(), status: z.string() })) }) })
export type StyleDetail = z.infer<typeof styleDetail>['style']

export function readStyle(api: ApiClient, styleId: string, signal?: AbortSignal): Promise<StyleDetail> {
  return api.get(`/product/styles/${enc(styleId)}`, { schema: styleDetail, signal }).then((answer) => answer.style)
}

const partyOption = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })
export type PartyOption = z.infer<typeof partyOption>

/** Customers and brands (CUSTOMER), or suppliers and subcontractors (SUPPLIER), who may ask for a change (parties.view). */
export function listParties(api: ApiClient, side: 'CUSTOMER' | 'SUPPLIER', companyId: string | null, signal?: AbortSignal): Promise<PartyOption[]> {
  return api
    .get('/parties', { query: { role: side === 'CUSTOMER' ? 'CUSTOMER,BRAND' : 'SUPPLIER,SUBCONTRACTOR', status: 'ACTIVE', companyId: companyId ?? undefined, limit: 200 }, schema: z.object({ parties: z.array(partyOption) }), signal })
    .then((answer) => answer.parties)
}

const roundOption = z.object({ id: z.string(), number: z.string(), kind: z.string(), roundNo: z.number().int() })
export type RoundOption = z.infer<typeof roundOption>

/** The style's sample rounds (sales.samples.view): a request raised by a sample round names one. */
export function listRounds(api: ApiClient, styleId: string, signal?: AbortSignal): Promise<RoundOption[]> {
  return api.get('/sales/samples/rounds', { query: { styleId, limit: 200 }, schema: z.object({ rows: z.array(roundOption) }), signal }).then((answer) => answer.rows)
}
