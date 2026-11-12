import { z } from 'zod'
import {
  roundList,
  roundView,
  shipmentView,
  workOrderOptionsView,
  type CreateRoundBody,
  type CreateShipmentBody,
  type RoundRow,
  type RoundView,
  type ShipmentView,
  type UpdateRoundBody,
  type UpdateShipmentBody,
  type WorkOrderBody,
} from '@nexus/factory-domain/sales/samples/contracts'
import { approvalView, commentView, fitView, swatchView, type ApprovalView, type CommentView, type FitView, type SwatchView } from '@nexus/factory-domain/sales/sample-decisions/contracts'
import type { ManualStage, RoundTile, SampleDecision, SampleKind } from '@nexus/factory-domain/sales/samples/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of Products › Development › Samples & prototypes (SCR-110 and the round's record), each answer checked against
 * the API's own contracts (factory-domain sales/samples, B-W2b-246, and sales/sample-decisions, B-W2b-252; zod drops
 * unknown fields). Every write carries the row's version where the API asks it and one Idempotency-Key per attempt. The
 * API's English (a refusal's message, `blockers`, `warnings`, `outside[].words`) is never shown: the screens say their own
 * words from the codes and facts (model.ts). The one money field is the round's charge, a price: the API leaves it out
 * without money.price and the screens never send it without it.
 */

export type { ApprovalView, CommentView, FitView, RoundRow, RoundView, ShipmentView, SwatchView, WorkOrderBody }
export type RoundList = z.infer<typeof roundList>
export type WorkOrderOptions = z.infer<typeof workOrderOptionsView>

const enc = encodeURIComponent
const base = '/sales/samples'
const roundPath = (roundId: string) => `${base}/rounds/${enc(roundId)}`
const key = (idempotencyKey?: string) => ({ idempotencyKey: idempotencyKey ?? newIdempotencyKey() })

// ---- the board, the list and the calendar ---------------------------------------------------------------------------------

export interface RoundQuery {
  tile?: RoundTile | null
  kind?: SampleKind | null
  partyId?: string | null
  internal?: boolean
  styleId?: string | null
  revisionId?: string | null
  q?: string
}

export function listRounds(api: ApiClient, query: RoundQuery, signal?: AbortSignal): Promise<RoundList> {
  return api.get(`${base}/rounds`, {
    query: {
      tile: query.tile ?? undefined,
      kind: query.kind ?? undefined,
      partyId: query.partyId ?? undefined,
      internal: query.internal ? 'true' : undefined,
      styleId: query.styleId ?? undefined,
      revisionId: query.revisionId ?? undefined,
      q: query.q?.trim() || undefined,
      limit: 200,
    },
    schema: roundList,
    signal,
  })
}

// ---- one round --------------------------------------------------------------------------------------------------------------

const oneRound = z.object({ round: roundView })

export function readRound(api: ApiClient, roundId: string, signal?: AbortSignal): Promise<RoundView> {
  return api.get(roundPath(roundId), { schema: oneRound, signal }).then((answer) => answer.round)
}

export function createRound(api: ApiClient, body: CreateRoundBody, idempotencyKey?: string): Promise<RoundView> {
  return api.post(`${base}/rounds`, { body, schema: oneRound, ...key(idempotencyKey) }).then((answer) => answer.round)
}

export function updateRound(api: ApiClient, roundId: string, body: UpdateRoundBody, idempotencyKey?: string): Promise<RoundView> {
  return api.request('PATCH', roundPath(roundId), { body, schema: oneRound, ...key(idempotencyKey) }).then((answer) => answer.round)
}

export function moveRound(api: ApiClient, roundId: string, body: { version: number; to: ManualStage }, idempotencyKey?: string): Promise<RoundView> {
  return api.post(`${roundPath(roundId)}/move`, { body, schema: oneRound, ...key(idempotencyKey) }).then((answer) => answer.round)
}

export function cancelRound(api: ApiClient, roundId: string, body: { version: number; reason: string }, idempotencyKey?: string): Promise<RoundView> {
  return api.post(`${roundPath(roundId)}/cancel`, { body, schema: oneRound, ...key(idempotencyKey) }).then((answer) => answer.round)
}

// ---- the sample work order -------------------------------------------------------------------------------------------------

export function workOrderOptions(api: ApiClient, roundId: string, signal?: AbortSignal): Promise<WorkOrderOptions> {
  return api.get(`${roundPath(roundId)}/work-order-options`, { schema: workOrderOptionsView, signal })
}

const madeWorkOrder = z.object({ workOrder: z.object({ id: z.string(), number: z.string(), status: z.string() }), round: roundView })
export type MadeWorkOrder = z.infer<typeof madeWorkOrder>

export function makeWorkOrder(api: ApiClient, roundId: string, body: WorkOrderBody, idempotencyKey?: string): Promise<MadeWorkOrder> {
  return api.post(`${roundPath(roundId)}/work-orders`, { body, schema: madeWorkOrder, ...key(idempotencyKey) })
}

// ---- shipments -----------------------------------------------------------------------------------------------------------------

const withShipment = z.object({ shipment: shipmentView.optional(), round: roundView })
export type WithShipment = z.infer<typeof withShipment>

export function addShipment(api: ApiClient, roundId: string, body: CreateShipmentBody, idempotencyKey?: string): Promise<WithShipment> {
  return api.post(`${roundPath(roundId)}/shipments`, { body, schema: withShipment, ...key(idempotencyKey) })
}

export function updateShipment(api: ApiClient, shipmentId: string, body: UpdateShipmentBody, idempotencyKey?: string): Promise<WithShipment> {
  return api.request('PATCH', `${base}/shipments/${enc(shipmentId)}`, { body, schema: withShipment, ...key(idempotencyKey) })
}

export function removeShipment(api: ApiClient, shipmentId: string, version: number, idempotencyKey?: string): Promise<RoundView> {
  return api.request('DELETE', `${base}/shipments/${enc(shipmentId)}`, { query: { version }, schema: oneRound, ...key(idempotencyKey) }).then((answer) => answer.round)
}

// ---- the approval (decision, the brand, swatches, the CE test sample) ------------------------------------------------------------

export function readApproval(api: ApiClient, roundId: string, signal?: AbortSignal): Promise<ApprovalView> {
  return api.get(`${roundPath(roundId)}/approval`, { schema: approvalView, signal })
}

export function decideRound(api: ApiClient, roundId: string, body: { version: number; decision: SampleDecision; comments?: string }, idempotencyKey?: string): Promise<ApprovalView> {
  return api.post(`${roundPath(roundId)}/decision`, { body, schema: approvalView, ...key(idempotencyKey) })
}

export function nextRound(api: ApiClient, roundId: string, body: { version?: number; dueDate?: string; instructions?: string }, idempotencyKey?: string): Promise<RoundView> {
  return api.post(`${roundPath(roundId)}/next-round`, { body, schema: oneRound, ...key(idempotencyKey) }).then((answer) => answer.round)
}

export function recordTestResult(api: ApiClient, roundId: string, body: { version: number; testResult?: 'PASSED' | 'FAILED'; certificateId?: string }, idempotencyKey?: string): Promise<ApprovalView> {
  return api.post(`${roundPath(roundId)}/test-result`, { body, schema: approvalView, ...key(idempotencyKey) })
}

const oneSwatch = z.object({ swatch: swatchView })

export function sendSwatch(api: ApiClient, swatch: Pick<SwatchView, 'id' | 'version'>, sentAt: string, idempotencyKey?: string): Promise<SwatchView> {
  return api.request('PATCH', `${base}/swatches/${enc(swatch.id)}`, { body: { version: swatch.version, sentAt }, schema: oneSwatch, ...key(idempotencyKey) }).then((answer) => answer.swatch)
}

export function decideSwatch(api: ApiClient, swatch: Pick<SwatchView, 'id' | 'version'>, body: { decision: SampleDecision; comments?: string }, idempotencyKey?: string): Promise<SwatchView> {
  return api.post(`${base}/swatches/${enc(swatch.id)}/decision`, { body: { version: swatch.version, ...body }, schema: oneSwatch, ...key(idempotencyKey) }).then((answer) => answer.swatch)
}

/** "A rejected round may raise a change" (B-W2b-226's change request, source SAMPLE). The answer is read again through the approval. */
export function raiseChangeRequest(api: ApiClient, body: { styleId: string; sampleRoundId: string; revisionId: string; title: string; reason: string }, idempotencyKey?: string): Promise<unknown> {
  return api.post('/product/change-requests', { body: { ...body, source: 'SAMPLE' }, ...key(idempotencyKey) })
}

// ---- the fit -------------------------------------------------------------------------------------------------------------------------

export function readFit(api: ApiClient, roundId: string, signal?: AbortSignal): Promise<FitView> {
  return api.get(`${roundPath(roundId)}/fit`, { schema: fitView, signal })
}

export interface FitCell {
  pointOfMeasureId: string
  size: string
  measured: string | null
  version?: number
}

export function saveFit(api: ApiClient, roundId: string, cells: readonly FitCell[], idempotencyKey?: string): Promise<FitView> {
  return api.request('PUT', `${roundPath(roundId)}/fit`, { body: { cells }, schema: fitView, ...key(idempotencyKey) })
}

const oneComment = z.object({ comment: commentView })

export function addComment(api: ApiClient, roundId: string, body: { pointOfMeasureId?: string; bodyArea?: string; text: string }, idempotencyKey?: string): Promise<CommentView> {
  return api.post(`${roundPath(roundId)}/comments`, { body, schema: oneComment, ...key(idempotencyKey) }).then((answer) => answer.comment)
}

export function updateComment(api: ApiClient, comment: Pick<CommentView, 'id' | 'version'>, patch: { resolved?: boolean }, idempotencyKey?: string): Promise<CommentView> {
  return api.request('PATCH', `${base}/comments/${enc(comment.id)}`, { body: { version: comment.version, ...patch }, schema: oneComment, ...key(idempotencyKey) }).then((answer) => answer.comment)
}

export function removeComment(api: ApiClient, comment: Pick<CommentView, 'id' | 'version'>, idempotencyKey?: string): Promise<unknown> {
  return api.request('DELETE', `${base}/comments/${enc(comment.id)}`, { query: { version: comment.version }, ...key(idempotencyKey) })
}

// ---- the pickers of New sample request ------------------------------------------------------------------------------------------

const styleOption = z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string().nullable(), sizes: z.array(z.string()), baseSize: z.string().nullable(), status: z.string(), lifecycle: z.string().optional() })
export type StyleOption = z.infer<typeof styleOption>

export function findStyles(api: ApiClient, q: string, signal?: AbortSignal): Promise<StyleOption[]> {
  return api.get('/product/styles', { query: { q: q.trim() || undefined, status: 'OPEN', limit: 50 }, schema: z.object({ styles: z.array(styleOption) }), signal }).then((answer) => answer.styles)
}

const styleDetail = z.object({
  style: styleOption.extend({
    revisions: z.array(z.object({ id: z.string(), revision: z.number().int(), status: z.string() })),
    colourways: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), status: z.string(), offeredSizes: z.array(z.string()) })),
    brand: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  }),
})
export type StyleDetail = z.infer<typeof styleDetail>['style']

export function readStyle(api: ApiClient, styleId: string, signal?: AbortSignal): Promise<StyleDetail> {
  return api.get(`/product/styles/${enc(styleId)}`, { schema: styleDetail, signal }).then((answer) => answer.style)
}

const partyOption = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })
export type PartyOption = z.infer<typeof partyOption>

/** The customers and brands a round may be for (parties.view). */
export function listCustomers(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<PartyOption[]> {
  return api
    .get('/parties', { query: { role: 'CUSTOMER,BRAND', status: 'ACTIVE', companyId: companyId ?? undefined, limit: 200 }, schema: z.object({ parties: z.array(partyOption) }), signal })
    .then((answer) => answer.parties)
}
