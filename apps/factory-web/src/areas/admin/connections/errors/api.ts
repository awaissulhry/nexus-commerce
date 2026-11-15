import { z } from 'zod'
import { ERROR_SOURCES, ERROR_STATES, FIX_PLACES, RETRY_HELD } from '@nexus/factory-domain/integration-health/errors'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { INTEGRATION_PROVIDERS } from '../api'

/**
 * The error queue and a connection's Test and Reconnect (B-W2b-415; PLT-196, PLT-201). Mirrors apps/factory-api
 * platform/admin/errors/contract.ts: codes only (what failed, why, the held reasons); the screen says them in words and shows
 * a provider's own message as data. Never a secret, a webhook body or a payload. Only containers call these.
 */

export const errorItemSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  source: z.enum(ERROR_SOURCES),
  provider: z.enum(INTEGRATION_PROVIDERS).nullable(),
  operation: z.string(),
  record: z.object({ type: z.string(), id: z.string() }).nullable(),
  reasonCode: z.string(),
  reasonText: z.string().nullable(),
  tries: z.number(),
  firstFailedAt: z.string(),
  lastFailedAt: z.string(),
  state: z.enum(ERROR_STATES),
  retriedAt: z.string().nullable(),
  retriedBySystem: z.boolean().nullable(),
  dismissedAt: z.string().nullable(),
  dismissReason: z.string().nullable(),
  fixPlace: z.enum(FIX_PLACES).nullable(),
  retry: z.object({ held: z.enum([...RETRY_HELD, 'NO_RIGHT']).nullable() }),
  dismiss: z.object({ held: z.enum(['DISMISSED', 'NO_RIGHT']).nullable() }),
  version: z.number(),
})
export type ErrorItem = z.infer<typeof errorItemSchema>

const line = z.object({ key: z.string(), value: z.string() })
const who = z.object({ system: z.boolean(), name: z.string().nullable() }).nullable()

export const errorDetailSchema = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('gone') }),
    z.object({ kind: z.literal('event'), type: z.string(), occurredAt: z.string(), status: z.string(), attempts: z.number() }),
    z.object({ kind: z.literal('webhook'), eventType: z.string().nullable(), receivedAt: z.string(), status: z.string(), attempts: z.number(), bodyBytes: z.number(), verified: z.boolean(), accountId: z.string(), accountLabel: z.string().nullable() }),
    z.object({
      kind: z.literal('call'),
      startedAt: z.string(),
      durationMs: z.number(),
      attempts: z.number(),
      httpStatus: z.number().nullable(),
      status: z.string(),
      reason: z.string().nullable(),
      mode: z.string(),
      accountId: z.string(),
      accountLabel: z.string().nullable(),
      request: z.array(line),
      response: z.array(line),
    }),
  ]),
  retriedBy: who,
  dismissedBy: who,
})
export type ErrorDetail = z.infer<typeof errorDetailSchema>

export const ERROR_VIEWS = ['open', 'retried', 'dismissed', 'all'] as const
export type ErrorView = (typeof ERROR_VIEWS)[number]

const listAnswer = z.object({
  items: z.array(errorItemSchema),
  counts: z.object({ open: z.number(), retried: z.number(), dismissed: z.number() }),
  nextBefore: z.string().nullable(),
  canManage: z.boolean(),
})
export type ErrorList = z.infer<typeof listAnswer>

export const listErrors = (api: ApiClient, query: { view: ErrorView; before?: string | null; limit?: number }) =>
  api.get('/integrations/errors', { query: { view: query.view, before: query.before ?? undefined, limit: query.limit }, schema: listAnswer })

export const getError = (api: ApiClient, itemId: string) => api.get(`/integrations/errors/${encodeURIComponent(itemId)}`, { schema: z.object({ item: errorItemSchema, detail: errorDetailSchema }) })

const oneItem = z.object({ item: errorItemSchema })

export const retryError = (api: ApiClient, item: Pick<ErrorItem, 'id' | 'version'>, idempotencyKey: string = newIdempotencyKey()) =>
  api.post(`/integrations/errors/${encodeURIComponent(item.id)}/retry`, { body: { version: item.version }, idempotencyKey, schema: oneItem }).then((answer) => answer.item)

export const dismissError = (api: ApiClient, item: Pick<ErrorItem, 'id' | 'version'>, reason: string, idempotencyKey: string = newIdempotencyKey()) =>
  api.post(`/integrations/errors/${encodeURIComponent(item.id)}/dismiss`, { body: { version: item.version, reason }, idempotencyKey, schema: oneItem }).then((answer) => answer.item)

export const testAnswerSchema = z.object({
  accountId: z.string(),
  outcome: z.enum(['OK', 'FAILED', 'REFUSED']),
  reason: z.string().nullable(),
  message: z.string().nullable(),
  httpStatus: z.number().nullable(),
  durationMs: z.number(),
  fake: z.boolean(),
  reconnected: z.boolean(),
  circuitBefore: z.object({ failures: z.number(), openUntil: z.string().nullable() }).nullable(),
  testedAt: z.string(),
})
export type TestAnswer = z.infer<typeof testAnswerSchema>

const testOne = z.object({ test: testAnswerSchema })

export const testConnection = (api: ApiClient, accountId: string) => api.post(`/integrations/accounts/${encodeURIComponent(accountId)}/test`, { body: {}, schema: testOne }).then((answer) => answer.test)

export const reconnectConnection = (api: ApiClient, accountId: string, idempotencyKey: string = newIdempotencyKey()) =>
  api.post(`/integrations/accounts/${encodeURIComponent(accountId)}/reconnect`, { body: {}, idempotencyKey, schema: testOne }).then((answer) => answer.test)
