import type { ZodType } from 'zod'
import type { ApiClient, HttpMethod } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError, issuePath, type ApiError } from '../../../lib/api/errors'

/**
 * The floor task screens' calls (SCR-090, 093, 094, 095, 097): one read and one write helper over the app's API client,
 * each answer checked against its shape and each failure turned into what a task screen does next (a `TaskProblem`).
 * Every write first makes sure the CSRF double-submit cookie exists (`GET /auth/csrf`) and carries an Idempotency-Key
 * (the floor's writes need one; the screen keeps the key of a retried action so a resend is answered, never applied
 * twice). A rule's refusal is a 409 whose issue path is `refusal/<CODE>` (or `checks/<CODE>` for a release), with the
 * API's words and, for some modules, `fix` (or `checks/<CODE>/fix`): the screen shows its own words for a code it knows,
 * else the API's.
 */

export type TaskProblem =
  /** A rule said no (409 with a code): the screen's words for the code, else the API's message and fix. */
  | { readonly kind: 'refused'; readonly code: string; readonly message: string; readonly fix: string | null; readonly others?: readonly TaskRefusal[] }
  /** 403 `stepUp`: the PIN opens it (POST /floor/step-up), then the same call again. */
  | { readonly kind: 'stepUp' }
  /** 403 for another reason (the issue path, `maker` …, when the API names one). */
  | { readonly kind: 'forbidden'; readonly path: string | null; readonly message: string | null }
  /** 404: not at this site, or nothing with this code. */
  | { readonly kind: 'notFound' }
  /** 409 without a rule's code: changed meanwhile (a version), or a state that does not allow it. */
  | { readonly kind: 'conflict'; readonly message: string | null }
  /** 400 / 422: the request as sent is refused (the first issue's path). */
  | { readonly kind: 'invalid'; readonly path: string | null; readonly message: string | null }
  /** 401: the session ended (the app shows sign-in). */
  | { readonly kind: 'signedOut' }
  /** 429. */
  | { readonly kind: 'rateLimited' }
  /** No network on the tablet: the call was not made. */
  | { readonly kind: 'offline' }
  /** No answer, or an answer this web does not understand. */
  | { readonly kind: 'unavailable' }

export interface TaskRefusal {
  readonly code: string
  readonly message: string
  readonly fix: string | null
}

export type TaskOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: TaskProblem }

const REFUSAL_PATH = /^(?:refusal|checks)\/([A-Z][A-Z0-9_]*)$/

/** A rule's refusals in an error's issues, in order: `refusal/<CODE>` or `checks/<CODE>`, each with its fix. */
export function refusalsOf(error: ApiError): TaskRefusal[] {
  const issues = error.issues
  const found: TaskRefusal[] = []
  issues.forEach((issue, index) => {
    const match = REFUSAL_PATH.exec(issuePath(issue))
    if (!match) return
    const code = match[1]!
    const next = issues[index + 1]
    const fixPath = next ? issuePath(next) : ''
    const fix = fixPath === 'fix' || fixPath === `checks/${code}/fix` ? (next?.message ?? null) : null
    found.push({ code, message: issue.message ?? '', fix })
  })
  return found
}

/** The task screen's problem for a failed call. Exported for the tests. */
export function taskProblemOf(error: unknown): TaskProblem {
  if (!isApiError(error)) return { kind: 'unavailable' }
  const first = error.issues[0]
  const path = first ? issuePath(first) || null : null
  switch (error.kind) {
    case 'signed_out':
      return { kind: 'signedOut' }
    case 'step_up':
      return { kind: 'stepUp' }
    case 'forbidden':
      return { kind: 'forbidden', path, message: first?.message ?? null }
    case 'not_found':
      return { kind: 'notFound' }
    case 'conflict': {
      const [refusal, ...others] = refusalsOf(error)
      if (refusal) return { kind: 'refused', ...refusal, ...(others.length > 0 ? { others } : {}) }
      return { kind: 'conflict', message: first?.message ?? null }
    }
    case 'invalid':
      return { kind: 'invalid', path, message: first?.message ?? null }
    case 'rate_limited':
      return { kind: 'rateLimited' }
    default:
      return error.code === 'network' ? { kind: 'offline' } : { kind: 'unavailable' }
  }
}

export interface ReadOptions<T> {
  readonly query?: Readonly<Record<string, string | number | boolean | null | undefined>>
  readonly schema: ZodType<T>
}

/** A floor read: its answer, or the problem. */
export async function floorRead<T>(api: ApiClient, path: string, options: ReadOptions<T>): Promise<TaskOutcome<T>> {
  try {
    return { ok: true, value: await api.get(path, { query: options.query, schema: options.schema }) }
  } catch (error) {
    return { ok: false, problem: taskProblemOf(error) }
  }
}

export interface WriteOptions<T> {
  readonly body?: unknown
  readonly schema: ZodType<T>
  /** The action's key: keep it to send the same action again (a retry after a PIN, a lost answer). Default: a fresh one. */
  readonly idempotencyKey?: string
}

/** A floor write (CSRF cookie first, an Idempotency-Key always): its answer, or the problem. */
export async function floorWrite<T>(api: ApiClient, method: Exclude<HttpMethod, 'GET'>, path: string, options: WriteOptions<T>): Promise<TaskOutcome<T>> {
  try {
    await api.get('/auth/csrf')
    const value = await api.request(method, path, { body: options.body ?? {}, schema: options.schema, idempotencyKey: options.idempotencyKey ?? newIdempotencyKey() })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, problem: taskProblemOf(error) }
  }
}

/** A path segment from an id (never trusted as a path). */
export const seg = (value: string): string => encodeURIComponent(value)
