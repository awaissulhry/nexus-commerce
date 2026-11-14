import type { ApiClient } from '../../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { endedAnswer, sessionsAnswer } from '../../../../me/sessions/api'

/**
 * A person's live sessions in Admin › Users (B-W2b-413 on B-W2b-404's API; PLT-064), users.sessions.manage: where they are
 * signed in now, and "End all sessions" (ENDED_BY_ADMIN; 409 `sessions/self` for one's own: My profile is for that).
 */

export const userSessions = (api: ApiClient, userId: string) => api.get(`/auth/users/${encodeURIComponent(userId)}/sessions`, { schema: sessionsAnswer }).then((answer) => answer.sessions)

export const endUserSessions = (api: ApiClient, userId: string, reason?: string) =>
  api.post(`/auth/users/${encodeURIComponent(userId)}/sessions/end`, { body: reason ? { reason } : {}, schema: endedAnswer, idempotencyKey: newIdempotencyKey() })
