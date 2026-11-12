import { z } from 'zod'
import {
  oneTransfer,
  shipAnswer,
  stockList,
  transferList,
  transferOptions,
  type AddLineBody,
  type CancelBody,
  type CreateBody,
  type ReceiveBody,
  type SettleBody,
  type ShipAnswer,
  type ShipBody,
  type StockList,
  type TransferList,
  type TransferOptions,
  type TransferView,
  type UpdateBody,
  type UpdateLineBody,
} from '@nexus/factory-domain/inventory/transfers/contracts'
import type { TransferStatus, TransferTile } from '@nexus/factory-domain/inventory/transfers/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { presignedSchema } from '../../../record-panels/api'
import { storeUrl } from '../../../record-panels/store'

/**
 * Every call of Warehouse › Transfers (SCR-360, SCR-361), each answer checked against the API's own contracts
 * (factory-domain inventory/transfers/contracts; zod drops unknown fields). Every write carries the version read and one
 * Idempotency-Key per attempt. The API's English (a refusal's message) is never shown: the screens say their own words
 * from the codes (model.ts). No money anywhere.
 */

export type { ShipAnswer, StockList, TransferList, TransferOptions, TransferView }

const enc = encodeURIComponent
const base = '/inventory/transfer-orders'
const one = (transferId: string) => `${base}/${enc(transferId)}`
const key = (idempotencyKey?: string) => ({ idempotencyKey: idempotencyKey ?? newIdempotencyKey() })
const answer = (value: { transfer: TransferView }) => value.transfer

export interface TransferQuery {
  tile?: TransferTile | null
  status?: TransferStatus | null
  fromSiteId?: string | null
  toSiteId?: string | null
  q?: string
}

export function listTransfers(api: ApiClient, query: TransferQuery, signal?: AbortSignal): Promise<TransferList> {
  return api.get(base, {
    query: { tile: query.tile ?? undefined, status: query.status ?? undefined, fromSiteId: query.fromSiteId ?? undefined, toSiteId: query.toSiteId ?? undefined, q: query.q?.trim() || undefined, limit: 200 },
    schema: transferList,
    signal,
  })
}

export function readOptions(api: ApiClient, signal?: AbortSignal): Promise<TransferOptions> {
  return api.get(`${base}/options`, { schema: transferOptions, signal })
}

export function readTransfer(api: ApiClient, transferId: string, signal?: AbortSignal): Promise<TransferView> {
  return api.get(one(transferId), { schema: oneTransfer, signal }).then(answer)
}

export function createTransfer(api: ApiClient, body: CreateBody, idempotencyKey?: string): Promise<TransferView> {
  return api.post(base, { body, schema: oneTransfer, ...key(idempotencyKey) }).then(answer)
}

export function updateTransfer(api: ApiClient, transferId: string, body: UpdateBody, idempotencyKey?: string): Promise<TransferView> {
  return api.request('PATCH', one(transferId), { body, schema: oneTransfer, ...key(idempotencyKey) }).then(answer)
}

export function readStock(api: ApiClient, transferId: string, query: { locationId?: string | null; q?: string }, signal?: AbortSignal): Promise<StockList> {
  return api.get(`${one(transferId)}/stock`, { query: { locationId: query.locationId ?? undefined, q: query.q?.trim() || undefined }, schema: stockList, signal })
}

export function addLine(api: ApiClient, transferId: string, body: AddLineBody, idempotencyKey?: string): Promise<TransferView> {
  return api.post(`${one(transferId)}/lines`, { body, schema: oneTransfer, ...key(idempotencyKey) }).then(answer)
}

export function updateLine(api: ApiClient, transferId: string, lineId: string, body: UpdateLineBody, idempotencyKey?: string): Promise<TransferView> {
  return api.request('PATCH', `${one(transferId)}/lines/${enc(lineId)}`, { body, schema: oneTransfer, ...key(idempotencyKey) }).then(answer)
}

export function removeLine(api: ApiClient, transferId: string, lineId: string, version: number, idempotencyKey?: string): Promise<TransferView> {
  return api.post(`${one(transferId)}/lines/${enc(lineId)}/remove`, { body: { version }, schema: oneTransfer, ...key(idempotencyKey) }).then(answer)
}

export function shipTransfer(api: ApiClient, transferId: string, body: ShipBody, idempotencyKey?: string): Promise<ShipAnswer> {
  return api.post(`${one(transferId)}/ship`, { body, schema: shipAnswer, ...key(idempotencyKey) })
}

export function receiveTransfer(api: ApiClient, transferId: string, body: ReceiveBody, idempotencyKey?: string): Promise<TransferView> {
  return api.post(`${one(transferId)}/receive`, { body, schema: oneTransfer, ...key(idempotencyKey) }).then(answer)
}

export function settleLine(api: ApiClient, transferId: string, lineId: string, body: SettleBody, idempotencyKey?: string): Promise<TransferView> {
  return api.post(`${one(transferId)}/lines/${enc(lineId)}/settle`, { body, schema: oneTransfer, ...key(idempotencyKey) }).then(answer)
}

export function cancelTransfer(api: ApiClient, transferId: string, body: CancelBody, idempotencyKey?: string): Promise<TransferView> {
  return api.post(`${one(transferId)}/cancel`, { body, schema: oneTransfer, ...key(idempotencyKey) }).then(answer)
}

/** The DDT's PDF (a presigned GET; files.read too): the page opens it in a new tab. */
export async function ddtPdfAddress(api: ApiClient, transferId: string): Promise<string> {
  const read = await api.get(`${one(transferId)}/ddt/pdf`, { schema: z.object({ download: presignedSchema }) })
  return storeUrl(read.download.url)
}

/** Prints a missing PDF of the issued DDT again (the DDT itself never changes). */
export function printDdtAgain(api: ApiClient, transferId: string, language: 'it' | 'en'): Promise<unknown> {
  return api.post(`${one(transferId)}/ddt/pdf`, { body: { language }, schema: z.object({ file: z.object({ id: z.string() }) }), ...key() })
}
