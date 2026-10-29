/**
 * What went wrong with an API call, in a form a screen can act on. The factory API answers every error as
 * `{ error: { code, message, requestId, issues? } }` with a stable `code` (apps/factory-api core/errors.ts); the web maps
 * the status to a KIND (what the screen does) and keeps the code and request id (what support needs). The API's message
 * is English and meant for logs; a screen shows its own words for the kind, in the person's language.
 */

export type ApiErrorKind =
  /** 401: no session, or it ended. The office goes to sign-in. */
  | 'signed_out'
  /** 403 with the issue path `stepUp`: a fresh authenticator code opens it. */
  | 'step_up'
  /** 403: the person may not do this (or see this company). */
  | 'forbidden'
  /** 404: nothing here (a link that opens nothing answers only this). */
  | 'not_found'
  /** 409: changed by someone else, or a state that does not allow it. */
  | 'conflict'
  /** 400 / 422: the request was refused as it is. */
  | 'invalid'
  /** 429: too many tries; wait. */
  | 'rate_limited'
  /** 502 / 503 / 504, or no answer at all: try again. */
  | 'unavailable'
  /** The answer did not match what this web expects (a version mismatch). */
  | 'contract'
  /** 500 and anything else. */
  | 'internal'

export interface ApiIssue {
  /** Where the problem is: the factory API sends a dotted string (`stepUp`, `lines.0.qty`); a list is read too. */
  path?: string | ReadonlyArray<string | number>
  message?: string
  code?: string
}

/** An issue's path as one dotted string, whichever shape it came in (`''` without one). */
export function issuePath(issue: ApiIssue): string {
  const path = issue.path
  if (typeof path === 'string') return path
  return Array.isArray(path) ? path.join('.') : ''
}

export class ApiError extends Error {
  override name = 'ApiError'
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number,
    /** The API's stable code (`LINK_UNAVAILABLE`, `forbidden`, …); `network` / `contract` for the web's own. */
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
    readonly issues: readonly ApiIssue[] = [],
  ) {
    super(message)
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

/** The kind for an HTTP status (and, for 403, whether the API asked for a step-up). */
export function errorKindFor(status: number, issues: readonly ApiIssue[] = []): ApiErrorKind {
  if (status === 401) return 'signed_out'
  if (status === 403) return issues.some((issue) => issuePath(issue).split('.')[0] === 'stepUp') ? 'step_up' : 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 400 || status === 422) return 'invalid'
  if (status === 429) return 'rate_limited'
  if (status === 502 || status === 503 || status === 504) return 'unavailable'
  return 'internal'
}

/** The ApiError for an error answer, from its status and (when it parses) its body. */
export function apiErrorFrom(status: number, body: unknown): ApiError {
  const error = typeof body === 'object' && body !== null && 'error' in body ? (body as { error: unknown }).error : null
  const fields = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
  const issues = Array.isArray(fields.issues) ? (fields.issues as ApiIssue[]) : []
  const code = typeof fields.code === 'string' ? fields.code : `http_${status}`
  const message = typeof fields.message === 'string' ? fields.message : `The factory API answered ${status}.`
  const requestId = typeof fields.requestId === 'string' ? fields.requestId : null
  return new ApiError(errorKindFor(status, issues), status, code, message, requestId, issues)
}

/** No answer at all: the API is down, or the network is. */
export function networkError(cause: unknown): ApiError {
  const error = new ApiError('unavailable', 0, 'network', 'The factory API could not be reached.')
  ;(error as { cause?: unknown }).cause = cause
  return error
}
