import { z } from 'zod'
import { partnerSearchAnswer, type PartnerSearchAnswer } from '@nexus/factory-domain/search/partner/contracts'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'

/**
 * Every call the portal frame makes (B-W2b-173), each answer checked against what the API's contracts say (apps/factory-api
 * platform/auth/portal, platform/auth/partners, platform/portal/{tasks,notifications,threads,search}). The web reads only what
 * it uses: a field the API adds never breaks the frame. Words the API gives in both languages (a task's verb, a notification's
 * sentence, an e-mail topic) are factory-domain's own catalogue, said in the page's language; an error's English never is.
 */

const words = z.object({ it: z.string(), en: z.string() })
const legalBlock = z.object({ name: z.string(), lines: z.array(z.string()) })

export const portalMeSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), displayName: z.string(), locale: z.string(), partnerKind: z.string().nullable(), accessUntil: z.string().nullable() }),
  party: z.object({ id: z.string(), name: z.string(), code: z.string(), kinds: z.array(z.string()) }),
  company: z.object({ id: z.string(), code: z.string(), name: z.string(), legal: z.object({ it: legalBlock, en: legalBlock }) }),
  session: z.object({ id: z.string(), createdAt: z.string(), idleExpiresAt: z.string(), absoluteExpiresAt: z.string(), stepUpUntil: z.string().nullable() }),
  preview: z.boolean(),
  terms: z.object({ noticeId: z.string(), label: z.string(), acknowledged: z.boolean() }).nullable(),
  termsDue: z.boolean(),
  permissions: z.array(z.string()),
})
export type PortalMe = z.infer<typeof portalMeSchema>

export const fetchPortalMe = (api: ApiClient, signal?: AbortSignal): Promise<PortalMe> => api.get('/portal/me', { schema: portalMeSchema, signal })

const times = z.object({ idleExpiresAt: z.string(), absoluteExpiresAt: z.string() })
/** "Stay signed in": the idle end moves now. */
export const refreshSession = (api: ApiClient) => api.post('/portal/sessions/refresh', { body: {}, schema: times })
/** Ends this browser's portal session (only the portal cookie; an office tab keeps working). */
export const signOutPortal = (api: ApiClient) => api.post('/portal/sign-out', { body: {} })
/** The person's own language (SCM-101). */
export const changeLocale = (api: ApiClient, locale: 'it' | 'en') => api.post('/portal/me/locale', { body: { locale }, schema: z.object({ locale: z.string(), changed: z.boolean() }), idempotencyKey: newIdempotencyKey() })

// ── the one task list (B-W2b-167) ────────────────────────────────────────────────────────────────────────────────────────
export const portalTaskSchema = z.object({
  id: z.string(),
  kind: z.string(),
  verb: words,
  words,
  record: z.object({ type: z.string(), id: z.string(), label: z.string() }),
  dueAt: z.string().nullable(),
  due: z.enum(['OVERDUE', 'TODAY', 'SOON', 'LATER', 'NONE']),
  askedBy: z.string().nullable(),
  status: z.string(),
  area: z.string(),
  version: z.number(),
  link: z.string(),
  canMarkDone: z.boolean(),
  canUndo: z.boolean(),
})
export type PortalTask = z.infer<typeof portalTaskSchema>

export const portalBadgeSchema = z.object({ area: z.string(), count: z.number(), words })
export type PortalBadge = z.infer<typeof portalBadgeSchema>

export const portalTasksSchema = z.object({
  asOf: z.string(),
  items: z.array(portalTaskSchema),
  badges: z.array(portalBadgeSchema),
  counts: z.object({ open: z.number(), overdue: z.number(), dueSoon: z.number() }),
  live: z.object({ events: z.array(z.string()) }),
})
export type PortalTasks = z.infer<typeof portalTasksSchema>

export const fetchTasks = (api: ApiClient, signal?: AbortSignal) => api.get('/portal/tasks', { query: { state: 'OPEN' }, schema: portalTasksSchema, signal })
const oneTask = z.object({ task: portalTaskSchema })
export const markTaskDone = (api: ApiClient, task: Pick<PortalTask, 'id' | 'version'>) => api.post(`/portal/tasks/${encodeURIComponent(task.id)}/done`, { body: { version: task.version }, schema: oneTask, idempotencyKey: newIdempotencyKey() })
export const undoTask = (api: ApiClient, taskId: string) => api.post(`/portal/tasks/${encodeURIComponent(taskId)}/undo`, { body: {}, schema: oneTask, idempotencyKey: newIdempotencyKey() })

// ── the bell (B-W2b-167) ─────────────────────────────────────────────────────────────────────────────────────────────────
export const portalNotificationSchema = z.object({
  id: z.string(),
  record: z.object({ type: z.string(), id: z.string(), label: z.string() }),
  sentence: words,
  link: z.string(),
  read: z.boolean(),
  createdAt: z.string(),
  group: z.object({ key: z.string(), count: z.number(), ids: z.array(z.string()) }),
})
export type PortalNotification = z.infer<typeof portalNotificationSchema>

const notificationsSchema = z.object({ asOf: z.string(), unread: z.number(), complete: z.boolean(), items: z.array(portalNotificationSchema), nextCursor: z.string().nullable() })
export type PortalNotifications = z.infer<typeof notificationsSchema>
const countsSchema = z.object({ asOf: z.string(), unread: z.number(), complete: z.boolean() })

export const fetchNotifications = (api: ApiClient, signal?: AbortSignal) => api.get('/portal/notifications', { query: { limit: 30 }, schema: notificationsSchema, signal })
export const fetchUnread = (api: ApiClient, signal?: AbortSignal) => api.get('/portal/notifications/counts', { schema: countsSchema, signal })
export const markRead = (api: ApiClient, body: { ids: string[] } | { all: true }) => api.post('/portal/notifications/read', { body: { ...body, read: true }, schema: z.object({ changed: z.number() }), idempotencyKey: newIdempotencyKey() })

// ── e-mail settings (B-W2b-167, COL-063) ─────────────────────────────────────────────────────────────────────────────────
export const EMAIL_FREQUENCIES = ['INSTANT', 'DAILY', 'WEEKLY', 'OFF'] as const
export type EmailFrequency = (typeof EMAIL_FREQUENCIES)[number]
export const emailSettingsSchema = z.object({
  topics: z.array(z.object({ topic: z.string(), frequency: z.enum(EMAIL_FREQUENCIES), locked: z.boolean(), stored: z.boolean(), words, reason: words.nullable() })),
  nonEssentialOff: z.boolean(),
})
export type EmailSettings = z.infer<typeof emailSettingsSchema>
export const fetchEmailSettings = (api: ApiClient, signal?: AbortSignal) => api.get('/portal/email-settings', { schema: emailSettingsSchema, signal })
export const saveEmailSettings = (api: ApiClient, body: { topics?: { topic: string; frequency: EmailFrequency }[]; nonEssential?: EmailFrequency }) =>
  api.request('PUT', '/portal/email-settings', { body, schema: emailSettingsSchema, idempotencyKey: newIdempotencyKey() })

// ── My access (B-W2b-162) ────────────────────────────────────────────────────────────────────────────────────────────────
export const myAccessSchema = z.object({
  kind: z.string().nullable(),
  role: z.object({ key: z.string(), name: z.string(), seesPrices: z.boolean(), admin: z.boolean() }).nullable(),
  capabilities: z.array(z.string()),
  allows: z.array(z.object({ permission: z.string() })),
  accessUntil: z.string().nullable(),
  accessEndsSoon: z.boolean(),
  admins: z.array(z.object({ id: z.string(), displayName: z.string() })),
  preview: z.boolean(),
})
export type MyAccess = z.infer<typeof myAccessSchema>
export const fetchMyAccess = (api: ApiClient, signal?: AbortSignal) => api.get('/portal/access', { schema: myAccessSchema, signal })

// ── search (B-W2b-168, SAL-084) ──────────────────────────────────────────────────────────────────────────────────────────
export const searchPortal = (api: ApiClient, q: string, signal?: AbortSignal): Promise<PartnerSearchAnswer> => api.get('/portal/search', { query: { q }, schema: partnerSearchAnswer, signal })

// ── a record's conversation (B-W2b-168, COL-059, COL-060) ────────────────────────────────────────────────────────────────
const partnerRecord = z.object({ type: z.string(), id: z.string(), theirRef: z.string().nullable(), ourRef: z.string().nullable(), subtitle: z.string().nullable(), status: z.string().nullable() })
export type PartnerRecord = z.infer<typeof partnerRecord>
const partnerMessage = z.object({
  id: z.string(),
  side: z.enum(['COMPANY', 'PARTNER']),
  channel: z.string(),
  author: z.object({ name: z.string().nullable(), mine: z.boolean() }),
  body: z.string(),
  attachments: z.array(z.object({ id: z.string(), originalName: z.string(), sizeBytes: z.number() })),
  at: z.string(),
})
export type PartnerMessageRead = z.infer<typeof partnerMessage>
export const partnerThreadSchema = z.object({
  record: partnerRecord,
  thread: z.object({ id: z.string(), status: z.string() }).nullable(),
  messages: z.array(partnerMessage),
  nextCursor: z.string().nullable(),
  composer: z.object({ canPost: z.boolean(), reason: z.string().nullable(), words: z.string().nullable(), replyByEmail: z.boolean(), hint: z.string().nullable() }),
})
export type PartnerThreadRead = z.infer<typeof partnerThreadSchema>

const recordPath = (type: string, id: string) => `/portal/threads/${encodeURIComponent(type)}/${encodeURIComponent(id)}`
export const fetchThread = (api: ApiClient, type: string, id: string, cursor?: string | null, signal?: AbortSignal) =>
  api.get(recordPath(type, id), { query: { limit: 50, ...(cursor ? { cursor } : {}) }, schema: partnerThreadSchema, signal })
export const postMessage = (api: ApiClient, type: string, id: string, body: string, idempotencyKey: string) =>
  api.post(`${recordPath(type, id)}/messages`, { body: { body }, schema: z.object({ message: partnerMessage }), idempotencyKey })

// ── the portal terms (B-W2b-159) ─────────────────────────────────────────────────────────────────────────────────────────
export const termsSchema = z.object({
  notice: z.object({ id: z.string(), label: z.string(), versionNo: z.number(), publishedAt: z.string().nullable(), locale: z.string(), body: z.string(), languages: z.array(z.string()), languageReady: z.boolean() }).nullable(),
  acknowledged: z.boolean(),
})
export type PortalTerms = z.infer<typeof termsSchema>
export const fetchTerms = (api: ApiClient, locale: string, signal?: AbortSignal) => api.get('/portal/terms', { query: { locale }, schema: termsSchema, signal })
