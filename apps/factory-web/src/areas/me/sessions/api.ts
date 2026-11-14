import { z } from 'zod'
import { DEVICE_KINDS } from '@nexus/factory-domain/auth/sessions/device'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Where a person is signed in (B-W2b-413 on B-W2b-404's API, PLT-064): the shape of one live session as
 * `GET /auth/sessions` and `GET /auth/users/:userId/sessions` answer it (apps/factory-api platform/auth/sessions/contract.ts
 * `sessionView`), and my own sessions' calls. Codes and facts only: the screen says the device kind, the surface and the
 * place in the person's language. Never an address: a place is a country and a city, when an edge proxy gave them.
 */

export const SESSION_SURFACES = ['OFFICE', 'PORTAL', 'PREVIEW'] as const

export const sessionSchema = z.object({
  id: z.string(),
  current: z.boolean(),
  surface: z.enum(SESSION_SURFACES),
  deviceKind: z.enum(DEVICE_KINDS).nullable(),
  deviceLabel: z.string().nullable(),
  browser: z.string().nullable(),
  place: z.object({ country: z.string().nullable(), city: z.string().nullable() }),
  startedAt: z.string(),
  lastUsedAt: z.string(),
  idleExpiresAt: z.string(),
  absoluteExpiresAt: z.string(),
})
export type LiveSession = z.infer<typeof sessionSchema>

export const sessionsAnswer = z.object({ sessions: z.array(sessionSchema) })
export const endedAnswer = z.object({ ended: z.number() })

/** My live sessions, this browser's among them (`current`). */
export const mySessions = (api: ApiClient) => api.get('/auth/sessions', { schema: sessionsAnswer }).then((answer) => answer.sessions)

/** Ends one of my other sessions (409 `sessions/current` for this browser: Sign out is for that). */
export const endMySession = (api: ApiClient, sessionId: string) =>
  api.post(`/auth/sessions/${encodeURIComponent(sessionId)}/end`, { body: {}, schema: endedAnswer, idempotencyKey: newIdempotencyKey() })

/** Ends every session of mine but this browser's ("Sign out everywhere else"). */
export const endOtherSessions = (api: ApiClient) => api.post('/auth/sessions/end-others', { body: {}, schema: endedAnswer, idempotencyKey: newIdempotencyKey() })
