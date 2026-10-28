/**
 * Domain errors: what a rule, a state machine or a permission check throws when it refuses. Each carries a stable
 * code that the API turns into the HTTP status and the JSON body `{ error: { code, message, requestId } }`
 * (apps/factory-api/src/core/errors.ts). The message is written for the caller and must never hold a secret, a
 * stack trace or SQL.
 */

/** Every code the API answers with. Codes are part of the contract: add new ones, never rename or reuse one. */
export const ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'origin_not_allowed',
  'not_found',
  'route_not_found',
  'conflict',
  'invalid_state',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
  'not_ready',
  'internal_error',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

/** One problem in a request, at a path such as `body/lines/0/qty`. */
export interface Issue {
  readonly path: string
  readonly message: string
}

export class DomainError extends Error {
  override name = 'DomainError'
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly issues?: readonly Issue[],
  ) {
    super(message)
  }
}

/** The record does not exist, or the caller may not know that it exists. */
export class NotFoundError extends DomainError {
  override name = 'NotFoundError'
  constructor(message = 'Not found.') {
    super('not_found', message)
  }
}

/** The caller is signed in but may not do this (missing permission, out of scope). */
export class ForbiddenError extends DomainError {
  override name = 'ForbiddenError'
  constructor(message = 'You may not do this.') {
    super('forbidden', message)
  }
}

/** No session, or one that ended. */
export class UnauthenticatedError extends DomainError {
  override name = 'UnauthenticatedError'
  constructor(message = 'Sign in first.') {
    super('unauthenticated', message)
  }
}

/** The request clashes with what is stored (a duplicate code, a newer version). */
export class ConflictError extends DomainError {
  override name = 'ConflictError'
  constructor(message = 'This clashes with what is stored.') {
    super('conflict', message)
  }
}

/** The record's state machine does not allow this action now (A1 §2.5). */
export class InvalidStateError extends DomainError {
  override name = 'InvalidStateError'
  constructor(message: string) {
    super('invalid_state', message)
  }
}

/** The input is well formed but breaks a rule. */
export class ValidationError extends DomainError {
  override name = 'ValidationError'
  constructor(message: string, issues: readonly Issue[] = []) {
    super('validation_failed', message, issues)
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError
}
