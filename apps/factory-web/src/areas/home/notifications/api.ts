import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { changedSchema, countsSchema, digestSchema, listSchema, type Digest, type DigestDraft, type NotificationCounts, type NotificationList, type NotificationState, type NotificationTab } from './model'

/**
 * The notification centre's calls (apps/factory-api platform/notifications), through the one API client (`useOfficeApi`
 * adds the company): my list by tab and state, the bell's counts, read / done / snooze / wake (my own rows, at most 200
 * ids, or a whole tab for "mark all read"), my daily digest, and mute (my follow of the record, platform/threads). Every
 * write carries an Idempotency-Key. Problems come back as message keys of `home-notifications`, never the API's words.
 */

export function fetchNotifications(api: ApiClient, query: { readonly tab: NotificationTab; readonly state: NotificationState; readonly cursor?: string | null; readonly limit?: number }, signal?: AbortSignal): Promise<NotificationList> {
  return api.get('/notifications', { query: { tab: query.tab, state: query.state, cursor: query.cursor ?? undefined, limit: query.limit ?? 50 }, schema: listSchema, signal })
}

/** The bell: unread notifications still to look at, per tab (one light read). */
export function fetchCounts(api: ApiClient, signal?: AbortSignal): Promise<NotificationCounts> {
  return api.get('/notifications/counts', { schema: countsSchema, signal })
}

type Changed = { readonly changed: number; readonly unknown: readonly string[] }

export function markRead(api: ApiClient, ids: readonly string[], read = true): Promise<Changed> {
  return api.post('/notifications/read', { body: { ids, read }, schema: changedSchema, idempotencyKey: newIdempotencyKey() })
}

/** ⇧E: every unread notification of the tab. */
export function markTabRead(api: ApiClient, tab: NotificationTab): Promise<Changed> {
  return api.post('/notifications/read', { body: { tab, read: true }, schema: changedSchema, idempotencyKey: newIdempotencyKey() })
}

/** Done (it is read too), or back on the list (`done` false: Undo). */
export function markDone(api: ApiClient, ids: readonly string[], done = true): Promise<Changed> {
  return api.post('/notifications/done', { body: { ids, done }, schema: changedSchema, idempotencyKey: newIdempotencyKey() })
}

/** Snooze until a time, or (null) until there is new activity on the record. */
export function snoozeNotifications(api: ApiClient, ids: readonly string[], until: string | null): Promise<Changed> {
  return api.post('/notifications/snooze', { body: { ids, until }, schema: changedSchema, idempotencyKey: newIdempotencyKey() })
}

export function wakeNotifications(api: ApiClient, ids: readonly string[]): Promise<Changed> {
  return api.post('/notifications/wake', { body: { ids }, schema: changedSchema, idempotencyKey: newIdempotencyKey() })
}

/** M: keep following the record without its news (a mention of me still reaches me). */
export function muteRecord(api: ApiClient, record: { readonly type: string; readonly id: string }): Promise<unknown> {
  return api.request('PUT', `/threads/${encodeURIComponent(record.type)}/${encodeURIComponent(record.id)}/followers/me`, { body: { following: true, muted: true }, idempotencyKey: newIdempotencyKey() })
}

export async function fetchDigest(api: ApiClient, signal?: AbortSignal): Promise<Digest> {
  return (await api.get('/notifications/digest', { schema: digestSchema, signal })).digest
}

export async function saveDigest(api: ApiClient, draft: DigestDraft, version: number): Promise<Digest> {
  const answer = await api.request('PUT', '/notifications/digest', { body: { ...draft, weekdays: [...draft.weekdays].sort((a, b) => a - b), version }, schema: digestSchema, idempotencyKey: newIdempotencyKey() })
  return answer.digest
}

/** A failed read, as a message key. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden') return 'problem.forbidden'
  if (error.kind === 'unavailable') return 'problem.offline'
  if (error.kind === 'signed_out') return 'problem.signedOut'
  return 'problem.read'
}

/** A refused write, as a notice key; `reload`: the list may have moved, read it again. */
export function writeProblem(error: unknown): { key: string; tone: 'warning' | 'danger'; reload: boolean } {
  if (!isApiError(error)) return { key: 'problem.failed', tone: 'danger', reload: false }
  if (error.kind === 'conflict') return { key: 'problem.changed', tone: 'warning', reload: true }
  if (error.kind === 'invalid') return { key: 'problem.invalid', tone: 'warning', reload: true }
  if (error.kind === 'forbidden') return { key: 'problem.forbidden', tone: 'danger', reload: false }
  if (error.kind === 'unavailable') return { key: 'problem.offline', tone: 'danger', reload: false }
  if (error.kind === 'signed_out') return { key: 'problem.signedOut', tone: 'danger', reload: false }
  return { key: 'problem.failed', tone: 'danger', reload: false }
}

/** A refused mute: the record has no news to mute (a task, an alert), or the person may not read it any more. */
export function muteProblem(error: unknown): string {
  if (isApiError(error) && (error.kind === 'not_found' || error.kind === 'invalid')) return 'notice.muteNoRecord'
  if (isApiError(error) && error.kind === 'forbidden') return 'notice.muteForbidden'
  return writeProblem(error).key
}

/** A refused digest save: someone (this person elsewhere) changed it since it was read, or a field is wrong. */
export function digestSaveProblem(error: unknown): string {
  if (isApiError(error) && error.kind === 'conflict') return 'digest.problem.changed'
  if (isApiError(error) && error.kind === 'invalid') return 'digest.problem.invalid'
  return writeProblem(error).key
}
