import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod'
import { databaseHardLockWords, PERIOD_LOCK_ISSUES } from '@nexus/factory-domain/accounting/periods'
import { DomainError, type ErrorCode, type Issue } from '@nexus/factory-domain/core/errors'
import type { ErrorBody } from '@nexus/factory-domain/core/contracts'
import { reportError } from '../observability/tracker'

/**
 * Error mapping (plan A1 §3.2): every failure leaves the API as `{ error: { code, message, requestId, issues? } }`
 * with a stable code (`@nexus/factory-domain/core/errors` ERROR_CODES) and the status below. A domain error keeps its
 * own message; anything else gets the fixed message of its code. A stack trace, SQL, a driver message or a Prisma
 * message never reaches the caller: an unexpected error is logged with its request id and answered `internal_error`.
 * A busy database (B-W2b-F2, `isBusyDatabaseError` below) is answered 503 `not_ready` "busy, try again" with Retry-After.
 */

export const STATUS_OF: Readonly<Record<ErrorCode, number>> = {
  bad_request: 400,
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  origin_not_allowed: 403,
  not_found: 404,
  route_not_found: 404,
  conflict: 409,
  invalid_state: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  not_ready: 503,
  internal_error: 500,
}

const MESSAGE_OF: Readonly<Record<ErrorCode, string>> = {
  bad_request: 'The request could not be read.',
  validation_failed: 'The request is not valid.',
  unauthenticated: 'Sign in first.',
  forbidden: 'You may not do this.',
  origin_not_allowed: 'Requests from this origin are not allowed.',
  not_found: 'Not found.',
  route_not_found: 'There is no such route.',
  conflict: 'This clashes with what is stored.',
  invalid_state: 'This is not possible in the current state.',
  payload_too_large: 'The request body is too large.',
  unsupported_media_type: 'This content type is not accepted.',
  rate_limited: 'Too many requests. Try again shortly.',
  not_ready: 'The service is not ready.',
  internal_error: 'Something went wrong. The error was logged.',
}

/** An error the API itself raises (as opposed to a rule in the domain), with a stable code. */
export class ApiError extends Error {
  override name = 'ApiError'
  constructor(
    readonly code: ErrorCode,
    message: string = MESSAGE_OF[code],
  ) {
    super(message)
  }
}

/** Fastify's own client errors, by code (body parsing, content type). Any other 4xx falls back to its status. */
const FASTIFY_CODES: Readonly<Record<string, ErrorCode>> = {
  FST_ERR_CTP_BODY_TOO_LARGE: 'payload_too_large',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'unsupported_media_type',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'bad_request',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'bad_request',
  FST_ERR_CTP_INVALID_JSON_BODY: 'bad_request',
}
const BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
}

export interface MappedError {
  readonly status: number
  readonly code: ErrorCode
  readonly message: string
  readonly issues?: readonly Issue[]
  /** True when the error was not expected: it is logged at error level. */
  readonly unexpected: boolean
  /** Seconds the caller waits before trying again (the Retry-After header). Only a busy database sets it. */
  readonly retryAfterSeconds?: number
}

/** B-W2b-F2: the answer to a busy database, in words, and how long the caller waits before trying again. */
export const BUSY_MESSAGE = 'The factory is busy. Try again in a moment.'
export const BUSY_RETRY_AFTER_SECONDS = 3

/**
 * B-W2b-F2: Prisma's codes for a database that is busy right now, not for a wrong request. Under load a command's
 * interactive transaction waits for a pool connection longer than its maxWait, or outlives its timeout (P2028
 * "Transaction API error": unable to start in the given time, expired, already closed, not found); Prisma's own pool
 * times out (P2024); PostgreSQL ends a transaction in a deadlock or a serialization failure, which Prisma says to retry
 * (P2034); the server has no connection slot left (P2037, SQLSTATE 53300). Each is answered 503 `not_ready` with
 * Retry-After, never 500: nothing was written (the transaction rolled back), and the same request can be sent again.
 */
const BUSY_PRISMA_CODES: ReadonlySet<string> = new Set(['P2024', 'P2028', 'P2034', 'P2037'])

/** A Prisma request error (PrismaClientKnownRequestError, by name: the class is not exported here) with a busy code. */
export function isBusyDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'PrismaClientKnownRequestError') return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && BUSY_PRISMA_CODES.has(code)
}

function validationIssues(error: unknown): Issue[] {
  if (!hasZodFastifySchemaValidationErrors(error)) return []
  const where = (error as { validationContext?: string }).validationContext
  return error.validation.map((issue) => ({
    path: [where, ...issue.instancePath.split('/').filter(Boolean)].filter(Boolean).join('/'),
    message: issue.message ?? 'Invalid value.',
  }))
}

/**
 * B-W2a-F8: the database's own refusal of a write dated inside a HARD period lock (…_money_w2a_guards
 * factory_period_refuse_locked: check_violation 'period lock: …'), when a write reached it without its command's check:
 * a 409 in the words of the commands' check (issue `period/HARD_LOCKED`), never a 500. The last line of defence.
 */
function hardPeriodLockRefusal(error: unknown): MappedError | null {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (cause?.originalCode !== '23514' || typeof cause.originalMessage !== 'string') return null
  const message = databaseHardLockWords(cause.originalMessage)
  return message ? { status: STATUS_OF.conflict, code: 'conflict', message, issues: [{ path: PERIOD_LOCK_ISSUES.hard, message: 'Dated inside a month closed for good.' }], unexpected: false } : null
}

/** What an error becomes on the wire. Pure, so the mapping is tested without a server. */
export function mapError(error: unknown): MappedError {
  if (error instanceof DomainError) {
    const issues = error.issues && error.issues.length > 0 ? { issues: error.issues } : {}
    return { status: STATUS_OF[error.code], code: error.code, message: error.message, ...issues, unexpected: false }
  }
  if (error instanceof ApiError) {
    return { status: STATUS_OF[error.code], code: error.code, message: error.message, unexpected: error.code === 'internal_error' }
  }
  const closedMonth = hardPeriodLockRefusal(error)
  if (closedMonth) return closedMonth
  if (isBusyDatabaseError(error)) {
    return { status: STATUS_OF.not_ready, code: 'not_ready', message: BUSY_MESSAGE, unexpected: false, retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS }
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    const code: ErrorCode = 'validation_failed'
    return { status: STATUS_OF[code], code, message: MESSAGE_OF[code], issues: validationIssues(error), unexpected: false }
  }
  const fastify = error as Partial<FastifyError> | null
  const status = typeof fastify?.statusCode === 'number' ? fastify.statusCode : 500
  if (status >= 400 && status < 500) {
    const code = (fastify?.code && FASTIFY_CODES[fastify.code]) || BY_STATUS[status] || 'bad_request'
    return { status: STATUS_OF[code], code, message: MESSAGE_OF[code], unexpected: false }
  }
  return { status: 500, code: 'internal_error', message: MESSAGE_OF.internal_error, unexpected: true }
}

export function errorBodyFor(code: ErrorCode, requestId: string, message: string = MESSAGE_OF[code], issues?: readonly Issue[]): ErrorBody {
  return { error: { code, message, requestId, ...(issues && issues.length > 0 ? { issues: [...issues] } : {}) } }
}

/** Sends an error answer for a code (used by hooks that answer before a route runs). */
export function sendError(reply: FastifyReply, code: ErrorCode, message: string = MESSAGE_OF[code]): FastifyReply {
  return reply.code(STATUS_OF[code]).type('application/json; charset=utf-8').send(errorBodyFor(code, String(reply.request.id), message))
}

/** The audience and tenant of a request that had a context (an error report keeps no person). */
function contextFields(request: FastifyRequest): { audience?: string; tenantId?: string } {
  const context = (request as { factoryContext?: { audience: string; tenantId?: string } }).factoryContext
  if (!context) return {}
  return { audience: context.audience, ...(context.tenantId ? { tenantId: context.tenantId } : {}) }
}

/** Installs the error handler and the not-found handler on the root instance. */
export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const mapped = mapError(error)
    if (mapped.unexpected) {
      request.log.error({ err: error }, 'request failed')
      // B-W2a-42 (PLT-218): the redacted report; route pattern, never the URL.
      reportError(error, { route: request.routeOptions?.url ?? null, method: request.method, statusCode: mapped.status, requestId: String(request.id), ...contextFields(request) })
    } else if (mapped.retryAfterSeconds !== undefined) {
      // B-W2b-F2: a busy database is not a bug, but the operator must see it (with the error, never on the wire).
      request.log.warn({ err: error, code: mapped.code, status: mapped.status }, 'database busy')
      void reply.header('retry-after', String(mapped.retryAfterSeconds))
    } else {
      request.log.info({ code: mapped.code, status: mapped.status }, 'request refused')
    }
    void reply
      .code(mapped.status)
      .type('application/json; charset=utf-8')
      .send(errorBodyFor(mapped.code, String(request.id), mapped.message, mapped.issues))
  })
  app.setNotFoundHandler((_request, reply) => {
    void sendError(reply, 'route_not_found')
  })
}
