import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DISMISS_REASON, ERROR_SOURCES, ERROR_STATES, FIX_PLACES, RETRY_HELD } from '@nexus/factory-domain/integration-health/errors'
import { INTEGRATION_PROVIDERS } from '../connections/contract'

/**
 * The error queue (B-W2b-415; PLT-201; design admin.connections sec:errors, pop:error-item) and a connection's Test and
 * Reconnect (PLT-196; pop:test). What failed is a code (an operation, an event type) and the reason a code with the
 * provider's own message as it came (scrubbed); the web says them in words. Never a secret, a webhook body or a payload.
 */

export const errorItemView = output({
  id: id(),
  companyId: id().nullable(),
  source: z.enum(ERROR_SOURCES),
  provider: z.enum(INTEGRATION_PROVIDERS).nullable(),
  /** What failed: the call's operation (`sdi.send_invoice`), the event type, the job's name, `webhook.process`. */
  operation: z.string(),
  record: output({ type: z.string(), id: id() }).nullable(),
  reasonCode: z.string(),
  /** The provider's own message as received (scrubbed), when there is one. */
  reasonText: z.string().nullable(),
  tries: z.number().int(),
  firstFailedAt: instant(),
  lastFailedAt: instant(),
  state: z.enum(ERROR_STATES),
  retriedAt: instant().nullable(),
  /** The latest retry was the system's (it went through on its own), not a person's; null: never retried. */
  retriedBySystem: z.boolean().nullable(),
  dismissedAt: instant().nullable(),
  dismissReason: z.string().nullable(),
  /** Where a failed call is fixed and sent again ("Edit and retry"); null: nowhere. */
  fixPlace: z.enum(FIX_PLACES).nullable(),
  retry: output({ held: z.enum([...RETRY_HELD, 'NO_RIGHT']).nullable() }),
  dismiss: output({ held: z.enum(['DISMISSED', 'NO_RIGHT']).nullable() }),
  version: z.number().int(),
})
export type ErrorItemView = z.infer<typeof errorItemView>

const line = output({ key: z.string(), value: z.string() })
const who = output({ system: z.boolean(), name: z.string().nullable() }).nullable()

export const errorDetail = output({
  source: z.discriminatedUnion('kind', [
    output({ kind: z.literal('gone') }),
    output({ kind: z.literal('event'), type: z.string(), occurredAt: instant(), status: z.string(), attempts: z.number().int() }),
    output({
      kind: z.literal('webhook'),
      eventType: z.string().nullable(),
      receivedAt: instant(),
      status: z.string(),
      attempts: z.number().int(),
      bodyBytes: z.number().int(),
      verified: z.boolean(),
      accountId: id(),
      accountLabel: z.string().nullable(),
    }),
    output({
      kind: z.literal('call'),
      startedAt: instant(),
      durationMs: z.number().int(),
      attempts: z.number().int(),
      httpStatus: z.number().int().nullable(),
      status: z.string(),
      reason: z.string().nullable(),
      mode: z.string(),
      accountId: id(),
      accountLabel: z.string().nullable(),
      /** The summaries the gateway kept (no secret, no personal data), top-level values only. */
      request: z.array(line),
      response: z.array(line),
    }),
  ]),
  /** Who sent it again or dismissed it: a person's name, or the system (inside the one item only). */
  retriedBy: who,
  dismissedBy: who,
})
export type ErrorDetail = z.infer<typeof errorDetail>

export const listErrorsContract = defineContract({
  querystring: input({
    view: z.enum(['open', 'retried', 'dismissed', 'all']).default('open'),
    source: z.enum(ERROR_SOURCES).optional(),
    before: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      items: z.array(errorItemView),
      counts: output({ open: z.number().int(), retried: z.number().int(), dismissed: z.number().int() }),
      nextBefore: id().nullable(),
      /** The person may retry or dismiss some item (integrations.errors.manage). */
      canManage: z.boolean(),
    }),
  },
})

const itemParams = input({ itemId: id() })

export const getErrorContract = defineContract({ params: itemParams, response: { 200: output({ item: errorItemView, detail: errorDetail }) } })

export const retryErrorContract = defineContract({
  params: itemParams,
  body: input({ version: z.number().int().min(1) }),
  response: { 200: output({ item: errorItemView }) },
})

export const dismissErrorContract = defineContract({
  params: itemParams,
  body: input({ version: z.number().int().min(1), reason: z.string().trim().min(DISMISS_REASON.min).max(DISMISS_REASON.max) }),
  response: { 200: output({ item: errorItemView }) },
})

export const testAnswer = output({
  accountId: id(),
  outcome: z.enum(['OK', 'FAILED', 'REFUSED']),
  reason: z.string().nullable(),
  message: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  durationMs: z.number().int(),
  fake: z.boolean(),
  reconnected: z.boolean(),
  circuitBefore: output({ failures: z.number().int(), openUntil: instant().nullable() }).nullable(),
  testedAt: instant(),
})

const accountParams = input({ accountId: id() })

export const testAccountContract = defineContract({ params: accountParams, body: input({}).optional(), response: { 200: output({ test: testAnswer }) } })
export const reconnectAccountContract = defineContract({ params: accountParams, body: input({}).optional(), response: { 200: output({ test: testAnswer }) } })
