import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * The account calls every partner kind's admin and person share (lifted from the customer's Account, B-W2b-196, by
 * B-W2b-193 for the supplier's Profile): colleagues and roles (B-W2b-162, apps/factory-api platform/auth/partners/
 * colleagues.ts; the API scopes them to the admin's own kind), their open requests and the hand-over (B-W2b-167 / F14,
 * platform/portal/tasks), the step-up by e-mail code (B-W2b-159), and the person's own sessions (B-W2b-196:
 * platform/auth/portal/self.ts). E-mail settings are the frame's calls (portal/shell/api.ts). Each answer is checked
 * against what the API's contracts say; the API's English never reaches the screen.
 */

const words = z.object({ it: z.string(), en: z.string() })
const STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const
export type ColleagueStatus = (typeof STATUSES)[number]
export const CAPABILITIES = ['comment', 'upload', 'approve'] as const
export type Capability = (typeof CAPABILITIES)[number]

// ── colleagues (B-W2b-162) ───────────────────────────────────────────────────────────────────────────────────────────────
const colleague = z.object({
  id: z.string(),
  displayName: z.string(),
  /** Only for the organisation's admins. */
  email: z.string().nullable(),
  status: z.enum(STATUSES),
  roleKey: z.string().nullable(),
  roleName: z.string().nullable(),
  seesPrices: z.boolean(),
  admin: z.boolean(),
  capabilities: z.array(z.enum(CAPABILITIES)),
  lastSignInAt: z.string().nullable(),
  invitationExpiresAt: z.string().nullable(),
  version: z.number(),
})
export type Colleague = z.infer<typeof colleague>

const role = z.object({
  key: z.string(),
  kind: z.string(),
  name: z.string(),
  description: z.string(),
  seesPrices: z.boolean(),
  admin: z.boolean(),
  capabilities: z.object({ allowed: z.array(z.enum(CAPABILITIES)), byDefault: z.array(z.enum(CAPABILITIES)) }),
  offered: z.boolean(),
})
export type OfferedRole = z.infer<typeof role>

export const colleaguesSchema = z.object({
  me: z.string(),
  canManage: z.boolean(),
  admins: z.array(z.object({ id: z.string(), displayName: z.string(), email: z.string() })),
  people: z.array(colleague),
  roles: z.array(role),
  seats: z.object({ taken: z.number(), max: z.number().nullable() }).nullable(),
})
export type Colleagues = z.infer<typeof colleaguesSchema>

export const fetchColleagues = (api: ApiClient, signal?: AbortSignal) => api.get('/portal/colleagues', { schema: colleaguesSchema, signal })

export interface InviteBody {
  email: string
  displayName: string
  locale: 'it' | 'en'
  roleKey: string
  capabilities?: Capability[]
}
const invited = z.object({ invitation: z.object({ id: z.string(), userId: z.string(), email: z.string(), expiresAt: z.string() }), delivery: z.enum(['sent', 'already_sent']) })
/** One key per dialog: a retry of the same invite is the same invitation (no second mail). */
export const inviteColleague = (api: ApiClient, body: InviteBody, idempotencyKey: string) => api.post('/portal/colleagues', { body, schema: invited, idempotencyKey })
export const changeColleague = (api: ApiClient, userId: string, body: { roleKey?: string; capabilities?: Capability[]; version: number }) =>
  api.request('PATCH', `/portal/colleagues/${encodeURIComponent(userId)}`, { body, schema: z.object({ id: z.string() }), idempotencyKey: newIdempotencyKey() })
export const deactivateColleague = (api: ApiClient, userId: string, version: number) =>
  api.post(`/portal/colleagues/${encodeURIComponent(userId)}/deactivate`, { body: { version }, schema: z.object({ id: z.string(), status: z.string(), sessionsEnded: z.number() }), idempotencyKey: newIdempotencyKey() })

// ── a colleague's open requests (B-W2b-167, F14) ─────────────────────────────────────────────────────────────────────────
export const handoverSchema = z.object({
  open: z.number(),
  kept: z.number(),
  assigned: z.number(),
  alone: z.array(z.object({ id: z.string(), kind: z.string(), words, record: z.object({ type: z.string(), id: z.string(), label: z.string() }), dueAt: z.string().nullable() })),
  colleagues: z.array(z.object({ id: z.string(), displayName: z.string(), count: z.number() })),
})
export type Handover = z.infer<typeof handoverSchema>
export const fetchHandover = (api: ApiClient, userId: string, signal?: AbortSignal) => api.get(`/portal/tasks/handover/${encodeURIComponent(userId)}`, { schema: handoverSchema, signal })

const handedTask = z.object({ id: z.string(), version: z.number(), assignee: z.object({ id: z.string(), displayName: z.string() }).nullable().optional() })
const openTasks = z.object({ items: z.array(handedTask) })
/** The open requests the person sees, with whom each is handed to (F14). */
export const fetchOpenTasks = (api: ApiClient, signal?: AbortSignal) => api.get('/portal/tasks', { query: { state: 'OPEN' }, schema: openTasks, signal })
export const assignTask = (api: ApiClient, task: { id: string; version: number }, assigneeId: string | null) =>
  api.post(`/portal/tasks/${encodeURIComponent(task.id)}/assign`, { body: { version: task.version, assigneeId }, idempotencyKey: newIdempotencyKey() })

// ── step-up by e-mail code (B-W2b-159) ───────────────────────────────────────────────────────────────────────────────────
export const startStepUp = (api: ApiClient) => api.post('/portal/step-up/start', { body: {}, schema: z.object({ status: z.literal('sent'), to: z.string(), expiresInSeconds: z.number(), resendAfterSeconds: z.number() }) })
export const proveStepUp = (api: ApiClient, code: string) => api.post('/portal/step-up', { body: { code }, schema: z.object({ stepUpUntil: z.string() }) })

// ── the person's own sessions (B-W2b-196: platform/auth/portal/self.ts) ──────────────────────────────────────────────────
const session = z.object({ id: z.string(), current: z.boolean(), createdAt: z.string(), lastSeenAt: z.string(), idleExpiresAt: z.string(), absoluteExpiresAt: z.string(), userAgent: z.string().nullable() })
export type PortalSessionRow = z.infer<typeof session>
export const sessionsSchema = z.object({ sessions: z.array(session) })
export const fetchSessions = (api: ApiClient, signal?: AbortSignal) => api.get('/portal/sessions', { schema: sessionsSchema, signal })
export const endOtherSessions = (api: ApiClient) => api.post('/portal/sessions/end-others', { body: {}, schema: z.object({ ended: z.number() }), idempotencyKey: newIdempotencyKey() })
