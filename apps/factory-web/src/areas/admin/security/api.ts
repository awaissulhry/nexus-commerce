import { z } from 'zod'
import { DRILL_KEYS } from '@nexus/factory-domain/ops/drills'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { presignedSchema } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Admin › Security & health (SCR-166; apps/factory-api platform/admin/security, B-W2a-36), with the
 * answer's shape checked (zod). The shapes mirror platform/admin/security/contract.ts. The API's English (refusal
 * messages) is never drawn: the page says its own words from the codes, counts and dates.
 */

export const STATUS_PARTS = ['api', 'database', 'jobs', 'scheduled', 'files', 'backups', 'drill'] as const
export const STATUS_STATES = ['ok', 'warning', 'failing', 'needs', 'unknown'] as const
export const PROTECTION_FACTS = ['inTransit', 'atRest', 'secrets', 'bank', 'headers', 'virusScan'] as const
export const PROTECTION_STATES = ['on', 'off', 'provider', 'partly'] as const
export const DRILL_STATES = ['none', 'failed', 'overdue', 'due_soon', 'ok'] as const
export const REFUSAL_CODES = ['floor', 'money', 'template', 'already', 'notAsked', 'held', 'stale', 'lockOut'] as const
export const ATTENTION_KINDS = ['integrationFailing', 'mailDomain', 'tabletUnseen', 'drill', 'jobsFailed', 'twoFactorMissing'] as const

const statusLine = z.object({
  part: z.enum(STATUS_PARTS),
  state: z.enum(STATUS_STATES),
  count: z.number().nullable(),
  minutes: z.number().nullable(),
  at: z.string().nullable(),
  days: z.number().nullable(),
  mode: z.string().nullable(),
})
export type StatusLine = z.infer<typeof statusLine>

const drillStatus = z.object({
  state: z.enum(DRILL_STATES),
  lastOn: z.string().nullable(),
  lastResult: z.enum(['PASSED', 'FAILED']).nullable(),
  daysAgo: z.number().nullable(),
  dueOn: z.string().nullable(),
  daysLeft: z.number().nullable(),
})
export type DrillStatus = z.infer<typeof drillStatus>

const drill = z.object({
  id: z.string(),
  drilledOn: z.string(),
  environment: z.string(),
  backupAt: z.string().nullable(),
  result: z.enum(['PASSED', 'FAILED']),
  durationMinutes: z.number().nullable(),
  notes: z.string().nullable(),
  checks: z.array(z.object({ key: z.string(), source: z.string().nullable(), restored: z.string().nullable(), match: z.boolean() })),
  evidenceFileId: z.string().nullable(),
  performedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  createdAt: z.string(),
})
export type Drill = z.infer<typeof drill>

const page = z.object({
  asOf: z.string(),
  status: z.array(statusLine),
  signIn: z.object({
    password: z.object({ minLength: z.number(), maxLength: z.number() }),
    lockout: z.object({ afterFailures: z.number(), firstLockMinutes: z.number(), maxLockMinutes: z.number() }),
    sessions: z.object({ idleHours: z.number(), absoluteDays: z.number(), stepUpMinutes: z.number() }),
    twoFactor: z.object({ officeRoles: z.number(), asking: z.number(), holdersWithout: z.number() }).nullable(),
  }),
  backups: z.object({ drill: drillStatus, drills: z.array(drill), canRecord: z.boolean() }),
  protection: z.array(z.object({ fact: z.enum(PROTECTION_FACTS), state: z.enum(PROTECTION_STATES), count: z.number().nullable() })),
})
export type SecurityFacts = z.infer<typeof page>

const holder = z.object({ userId: z.string(), name: z.string().nullable(), twoFactor: z.boolean() })
export type TwoFactorHolder = z.infer<typeof holder>
const twoFactorRole = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  system: z.boolean(),
  requireMfa: z.boolean(),
  lock: z.enum(['floor', 'money', 'template']).nullable(),
  templateAsks: z.boolean(),
  version: z.number(),
  holders: z.array(holder),
  heldByMe: z.boolean(),
})
export type TwoFactorRole = z.infer<typeof twoFactorRole>
const twoFactorList = z.object({ roles: z.array(twoFactorRole), canChange: z.boolean() })
export type TwoFactorList = z.infer<typeof twoFactorList>

export interface TwoFactorChange {
  roleId: string
  version: number
  requireMfa: boolean
}
const preview = z.object({
  affected: z.array(holder),
  openSessions: z.number(),
  refusals: z.array(z.object({ path: z.string(), code: z.enum(REFUSAL_CODES), message: z.string() })),
})
export type TwoFactorPreview = z.infer<typeof preview>

const fingerprint = z.object({ asOf: z.string(), fingerprint: z.object(Object.fromEntries(DRILL_KEYS.map((key) => [key, z.string()])) as Record<(typeof DRILL_KEYS)[number], z.ZodString>), line: z.string() })
export type FingerprintAnswer = z.infer<typeof fingerprint>

const attention = z.object({
  asOf: z.string(),
  items: z.array(
    z.object({
      kind: z.enum(ATTENTION_KINDS),
      subject: z.string().nullable(),
      state: z.string().nullable(),
      since: z.string().nullable(),
      count: z.number().nullable(),
      days: z.number().nullable(),
      href: z.string(),
      severity: z.enum(['warning', 'critical']),
    }),
  ),
  unread: z.array(z.enum(ATTENTION_KINDS)),
})
export type Attention = z.infer<typeof attention>
export type AttentionItem = Attention['items'][number]

export const securityFacts = (api: ApiClient) => api.get('/admin/security', { schema: page })
export const twoFactorRoles = (api: ApiClient) => api.get('/admin/security/two-factor', { schema: twoFactorList })
export const previewTwoFactor = (api: ApiClient, changes: readonly TwoFactorChange[]) => api.post('/admin/security/two-factor/preview', { body: { changes }, schema: preview })
export const changeTwoFactor = (api: ApiClient, changes: readonly TwoFactorChange[], reason?: string) =>
  api.post('/admin/security/two-factor', { body: { changes, ...(reason ? { reason } : {}) }, schema: z.object({ roles: z.array(twoFactorRole) }), idempotencyKey: newIdempotencyKey() })
export const readFingerprint = (api: ApiClient, asOf?: string) => api.get('/admin/security/fingerprint', { query: { asOf }, schema: fingerprint })
export const readAttention = (api: ApiClient) => api.get('/admin/security/attention', { schema: attention })

export interface DrillInput {
  drilledOn: string
  environment: string
  backupAt: string
  restored: string
  durationMinutes?: number
  notes?: string
}

/** The evidence first (its drill id is made by the API), then the drill with that id. */
export async function recordDrill(api: ApiClient, input: DrillInput, evidence: File | null) {
  let id: string | undefined
  let evidenceFileId: string | undefined
  if (evidence) {
    const bytes = await evidence.arrayBuffer()
    const announced = await api.post('/admin/security/drills/evidence', {
      body: { originalName: evidence.name, contentType: evidence.type || 'application/octet-stream', sizeBytes: evidence.size, sha256: await sha256Hex(bytes) },
      schema: z.object({ drillId: z.string(), file: z.object({ id: z.string() }).loose(), upload: presignedSchema }),
      idempotencyKey: newIdempotencyKey(),
    })
    await putToStore(announced.upload, bytes)
    await api.post(`/admin/security/drills/evidence/${encodeURIComponent(announced.file.id)}/complete`, { schema: z.object({ file: z.object({ id: z.string() }).loose() }) })
    id = announced.drillId
    evidenceFileId = announced.file.id
  }
  return api.post('/admin/security/drills', {
    body: { ...input, ...(id ? { id, evidenceFileId } : {}) },
    schema: z.object({ drill, drillStatus }),
    idempotencyKey: newIdempotencyKey(),
  })
}
