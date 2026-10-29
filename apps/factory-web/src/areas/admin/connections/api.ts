import { z } from 'zod'
import { DISPLAY_NAME_POLICIES, IDENTITY_KINDS, IDENTITY_STATUSES, VERIFICATION_STATUSES } from '@nexus/factory-domain/email/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * The calls of Connections & API (B-W0-28, SCR-087 and SCR-015), each answer checked against its shape (a mismatch is a
 * `contract` error, never half-read). Mirrors apps/factory-api platform/admin/connections/contract.ts (the integration
 * accounts, their calls and received webhooks; pause and resume) and platform/email-out/contract.ts (the companies'
 * sending identities). Never a secret: the API answers only whether one is saved and when. Only containers call these.
 */

// ---- platform/admin/connections ---------------------------------------------------------------------------------------

export const INTEGRATION_PROVIDERS = ['SES', 'R2', 'SDI', 'SENDCLOUD', 'VIES'] as const
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number]
export const INTEGRATION_MODES = ['LIVE', 'SANDBOX', 'FAKE'] as const
export type IntegrationMode = (typeof INTEGRATION_MODES)[number]
export const ACCOUNT_STATUSES = ['ACTIVE', 'PAUSED', 'DISABLED'] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]
export const CALL_STATUSES = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'REFUSED'] as const
export type CallStatus = (typeof CALL_STATUSES)[number]
export const INBOUND_STATUSES = ['RECEIVED', 'PROCESSED', 'FAILED', 'REJECTED'] as const
export type InboundStatus = (typeof INBOUND_STATUSES)[number]

const secretState = z.object({ saved: z.boolean(), savedAt: z.string().nullable(), rotatedAt: z.string().nullable() })
export type SecretState = z.infer<typeof secretState>

export const integrationAccountSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  provider: z.enum(INTEGRATION_PROVIDERS),
  code: z.string(),
  label: z.string(),
  mode: z.enum(INTEGRATION_MODES),
  status: z.enum(ACCOUNT_STATUSES),
  credentials: secretState,
  webhookSecret: secretState,
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  limits: z.object({ ratePerMinute: z.number(), burst: z.number(), timeoutMs: z.number(), circuitFailureThreshold: z.number(), circuitCooldownSeconds: z.number() }),
  lastOkAt: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  lastError: z.string().nullable(),
  calls24h: z.object({ total: z.number(), failed: z.number() }),
  inboundWaiting: z.number(),
  inboundPath: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
/** One account the factory holds with an outside service (an IntegrationAccount, as the API shows it). */
export type IntegrationAccount = z.infer<typeof integrationAccountSchema>

export const callSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  durationMs: z.number(),
  operation: z.string(),
  status: z.enum(CALL_STATUSES),
  reason: z.string().nullable(),
  httpStatus: z.number().nullable(),
  attempts: z.number(),
  error: z.string().nullable(),
  requestId: z.string(),
})
export type IntegrationCall = z.infer<typeof callSchema>

export const inboundSchema = z.object({
  id: z.string(),
  receivedAt: z.string(),
  eventType: z.string().nullable(),
  verified: z.boolean(),
  status: z.enum(INBOUND_STATUSES),
  attempts: z.number(),
  processedAt: z.string().nullable(),
  error: z.string().nullable(),
  bodyBytes: z.number(),
})
export type InboundDelivery = z.infer<typeof inboundSchema>

const oneAccount = z.object({ account: integrationAccountSchema })

/** GET /integrations/accounts (integrations.view): the accounts the person's grants reach, by provider and code. */
export const listAccounts = (api: ApiClient, query?: { provider?: string }): Promise<IntegrationAccount[]> =>
  api.get('/integrations/accounts', { query: { provider: query?.provider }, schema: z.object({ accounts: z.array(integrationAccountSchema) }) }).then((answer) => answer.accounts)

export const getAccount = (api: ApiClient, accountId: string): Promise<IntegrationAccount> =>
  api.get(`/integrations/accounts/${encodeURIComponent(accountId)}`, { schema: oneAccount }).then((answer) => answer.account)

export const listCalls = (api: ApiClient, accountId: string, query: { failed?: boolean; before?: string | null; limit?: number } = {}) =>
  api.get(`/integrations/accounts/${encodeURIComponent(accountId)}/calls`, {
    query: { failed: query.failed ? 'true' : undefined, before: query.before ?? undefined, limit: query.limit ?? 50 },
    schema: z.object({ calls: z.array(callSchema), nextBefore: z.string().nullable() }),
  })

export const listInbound = (api: ApiClient, accountId: string, query: { status?: InboundStatus | null; before?: string | null; limit?: number } = {}) =>
  api.get(`/integrations/accounts/${encodeURIComponent(accountId)}/inbound`, {
    query: { status: query.status ?? undefined, before: query.before ?? undefined, limit: query.limit ?? 50 },
    schema: z.object({ inbound: z.array(inboundSchema), nextBefore: z.string().nullable() }),
  })

/** POST …/pause or …/resume (integrations.manage): the kill switch, with the version read and an optional reason. */
export const setPaused = (api: ApiClient, accountId: string, paused: boolean, body: { version: number; reason?: string }): Promise<IntegrationAccount> =>
  api
    .post(`/integrations/accounts/${encodeURIComponent(accountId)}/${paused ? 'pause' : 'resume'}`, { body, schema: oneAccount, idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.account)

// ---- platform/email-out: the sending identities -----------------------------------------------------------------------

export { DISPLAY_NAME_POLICIES, IDENTITY_KINDS, IDENTITY_STATUSES, VERIFICATION_STATUSES }
export type IdentityKind = (typeof IDENTITY_KINDS)[number]
export type DisplayNamePolicy = (typeof DISPLAY_NAME_POLICIES)[number]
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

export const identitySchema = z.object({
  id: z.string(),
  companyId: z.string(),
  kind: z.enum(IDENTITY_KINDS),
  domain: z.string(),
  fromAddress: z.string(),
  displayName: z.string(),
  displayNamePolicy: z.enum(DISPLAY_NAME_POLICIES),
  replyDomain: z.string(),
  accountId: z.string(),
  sesIdentityArn: z.string().nullable(),
  verificationStatus: z.enum(VERIFICATION_STATUSES),
  dkimStatus: z.enum(VERIFICATION_STATUSES),
  dkimRecords: z.array(z.object({ type: z.literal('CNAME'), name: z.string(), value: z.string() })),
  ready: z.boolean(),
  lastCheckedAt: z.string().nullable(),
  isDefault: z.boolean(),
  status: z.enum(IDENTITY_STATUSES),
  version: z.number(),
  createdAt: z.string(),
})
/** A company's sending identity: its domain, From address and the DNS records SES needs. */
export type SendingIdentity = z.infer<typeof identitySchema>

const oneIdentity = z.object({ identity: identitySchema })

/** GET /email/identities (email.send). */
export const listIdentities = (api: ApiClient): Promise<SendingIdentity[]> =>
  api.get('/email/identities', { schema: z.object({ identities: z.array(identitySchema) }) }).then((answer) => answer.identities)

export interface IdentityInput {
  companyId: string
  kind: IdentityKind
  domain: string
  localPart?: string
  displayNamePolicy?: DisplayNamePolicy
  accountId: string
}

/** POST /email/identities (email.manage; the API asks for a fresh code). */
export const createIdentity = (api: ApiClient, body: IdentityInput, idempotencyKey: string) =>
  api.post('/email/identities', { body, idempotencyKey, schema: z.object({ identity: identitySchema, sesChecked: z.boolean() }) })

/** POST /email/identities/:id/check (email.manage; step-up): SES's verification and DKIM state, read again. */
export const checkIdentity = (api: ApiClient, identityId: string): Promise<SendingIdentity> =>
  api.post(`/email/identities/${encodeURIComponent(identityId)}/check`, { body: {}, schema: oneIdentity }).then((answer) => answer.identity)
