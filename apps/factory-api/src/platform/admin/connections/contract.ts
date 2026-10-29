import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { notMoney } from '@nexus/factory-domain/money/marked'

/**
 * The Connections page's routes (B-W0-28, design 02 admin.connections; PLT-139, PLT-195, PLT-197): each account the
 * factory holds with an outside service, said for a non-technical owner (what it is for comes from the web's words per
 * provider), with its mode (LIVE, SANDBOX, FAKE), its state, its last success and failure, its calls of the last 24 h
 * and the webhooks it sent. A secret is NEVER read back: only whether one is saved and when (SecretValue is sealed).
 */

export const INTEGRATION_PROVIDERS = ['SES', 'R2', 'SDI', 'SENDCLOUD', 'VIES'] as const
export const INTEGRATION_MODES = ['LIVE', 'SANDBOX', 'FAKE'] as const
export const ACCOUNT_STATUSES = ['ACTIVE', 'PAUSED', 'DISABLED'] as const
export const CALL_STATUSES = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'REFUSED'] as const
export const INBOUND_STATUSES = ['RECEIVED', 'PROCESSED', 'FAILED', 'REJECTED'] as const

const secretState = output({
  /** A sealed value is stored. */
  saved: z.boolean(),
  savedAt: instant().nullable(),
  /** Re-sealed under a new data key (rotation). */
  rotatedAt: instant().nullable(),
})

export const accountView = output({
  id: id(),
  /** Null: tenant-wide (SES, R2, VIES use the environment's credentials). */
  companyId: id().nullable(),
  provider: z.enum(INTEGRATION_PROVIDERS),
  code: z.string(),
  label: z.string(),
  mode: z.enum(INTEGRATION_MODES),
  status: z.enum(ACCOUNT_STATUSES),
  credentials: secretState,
  webhookSecret: secretState,
  /** The settings that are not secret (top-level scalar values only). */
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  limits: output({
    ratePerMinute: z.number().int(),
    burst: z.number().int(),
    timeoutMs: z.number().int(),
    circuitFailureThreshold: z.number().int(),
    circuitCooldownSeconds: z.number().int(),
  }),
  lastOkAt: instant().nullable(),
  lastErrorAt: instant().nullable(),
  /** The gateway's last failure, as recorded (secrets scrubbed). */
  lastError: z.string().nullable(),
  /** Calls of the last 24 hours, and how many of them failed (failed, timed out or refused). */
  calls24h: output({ total: notMoney(z.number().int()), failed: z.number().int() }),
  /** Webhooks received and not processed yet (received, or failed and waiting for a retry). */
  inboundWaiting: z.number().int(),
  /** Where this account's webhooks are posted (a path on the API), when its provider sends any. */
  inboundPath: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type AccountView = z.infer<typeof accountView>

export const callView = output({
  id: id(),
  startedAt: instant(),
  durationMs: z.number().int(),
  operation: z.string(),
  status: z.enum(CALL_STATUSES),
  /** Why a call was refused or failed, a code (`paused`, `circuit_open`, `rate_limited`, `timeout`, …). */
  reason: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  attempts: z.number().int(),
  error: z.string().nullable(),
  requestId: z.string(),
})
export type CallView = z.infer<typeof callView>

export const inboundView = output({
  id: id(),
  receivedAt: instant(),
  eventType: z.string().nullable(),
  verified: z.boolean(),
  status: z.enum(INBOUND_STATUSES),
  attempts: z.number().int(),
  processedAt: instant().nullable(),
  /** Why processing failed, or why the delivery was rejected. Never the body. */
  error: z.string().nullable(),
  bodyBytes: z.number().int(),
})
export type InboundView = z.infer<typeof inboundView>

const accountParams = input({ accountId: id() })

export const listAccountsContract = defineContract({
  querystring: input({ provider: z.enum(INTEGRATION_PROVIDERS).optional(), includeDisabled: z.enum(['true', 'false']).optional() }),
  response: { 200: output({ accounts: z.array(accountView) }) },
})

export const getAccountContract = defineContract({ params: accountParams, response: { 200: output({ account: accountView }) } })

export const listCallsContract = defineContract({
  params: accountParams,
  querystring: input({
    /** Only the failed ones (FAILED, TIMED_OUT, REFUSED). */
    failed: z.enum(['true', 'false']).optional(),
    /** Calls older than this one (paging, newest first). */
    before: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ calls: z.array(callView), nextBefore: id().nullable() }) },
})

export const listInboundContract = defineContract({
  params: accountParams,
  querystring: input({ status: z.enum(INBOUND_STATUSES).optional(), before: id().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: { 200: output({ inbound: z.array(inboundView), nextBefore: id().nullable() }) },
})

export const pauseAccountContract = defineContract({
  params: accountParams,
  body: input({ version: z.number().int().min(1), reason: z.string().trim().min(3).max(500).optional() }),
  response: { 200: output({ account: accountView }) },
})

export const resumeAccountContract = defineContract({
  params: accountParams,
  body: input({ version: z.number().int().min(1), reason: z.string().trim().min(3).max(500).optional() }),
  response: { 200: output({ account: accountView }) },
})
