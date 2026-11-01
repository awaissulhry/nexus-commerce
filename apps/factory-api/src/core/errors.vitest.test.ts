import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { ApiError, BUSY_MESSAGE, BUSY_RETRY_AFTER_SECONDS, errorBodyFor, installErrorHandling, mapError, STATUS_OF } from './errors'

const fastifyError = (code: string, statusCode: number, message = 'fastify said something') =>
  Object.assign(new Error(message), { code, statusCode })

/** A PrismaClientKnownRequestError as Prisma 7's client throws it (name, code, meta; the class is not exported here). */
const prismaError = (code: string, message: string, meta: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { name: 'PrismaClientKnownRequestError', code, meta, clientVersion: '7.10.0' })

/** B-W2b-F2: what Prisma 7 says when the database is busy (messages as its runtime writes them). */
const BUSY_ERRORS = {
  'P2028 unable to start (no pool connection within maxWait)': prismaError('P2028', 'Transaction API error: Unable to start a transaction in the given time.'),
  'P2028 expired (the transaction outlived its timeout)': prismaError(
    'P2028',
    'Transaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was 10000 ms, however 10050 ms passed since the start of the transaction.',
    { operation: 'query', timeout: 10_000, timeTaken: 10_050 },
  ),
  'P2028 already closed': prismaError('P2028', 'Transaction API error: Transaction already closed: A commit cannot be executed on a transaction that was rolled back.'),
  'P2028 not found': prismaError('P2028', 'Transaction API error: Transaction not found. Transaction ID is invalid, refers to an old closed transaction.'),
  'P2024 pool timeout': prismaError('P2024', 'Timed out fetching a new connection from the connection pool.'),
  'P2034 deadlock or serialization failure': prismaError('P2034', 'Transaction failed due to a write conflict or a deadlock. Please retry your transaction'),
  'P2037 no connection slot left on the server': prismaError('P2037', 'Too many database connections opened: sorry, too many clients already'),
} as const

describe('mapError()', () => {
  it('has a status for every stable code', () => {
    for (const code of ERROR_CODES) expect(STATUS_OF[code], code).toBeGreaterThanOrEqual(400)
  })

  it('keeps a domain error code, status and message', () => {
    expect(mapError(new NotFoundError('Quote Q-7 does not exist.'))).toEqual({
      status: 404,
      code: 'not_found',
      message: 'Quote Q-7 does not exist.',
      unexpected: false,
    })
    expect(mapError(new ForbiddenError()).status).toBe(403)
    expect(mapError(new UnauthenticatedError()).status).toBe(401)
    expect(mapError(new ValidationError('Bad lines.', [{ path: 'body/lines/0/qty', message: 'Must be above zero.' }]))).toEqual({
      status: 400,
      code: 'validation_failed',
      message: 'Bad lines.',
      issues: [{ path: 'body/lines/0/qty', message: 'Must be above zero.' }],
      unexpected: false,
    })
  })

  it('maps Fastify client errors to fixed messages, never theirs', () => {
    expect(mapError(fastifyError('FST_ERR_CTP_BODY_TOO_LARGE', 413))).toMatchObject({ status: 413, code: 'payload_too_large' })
    expect(mapError(fastifyError('FST_ERR_CTP_INVALID_MEDIA_TYPE', 415))).toMatchObject({ status: 415, code: 'unsupported_media_type' })
    expect(mapError(fastifyError('FST_ERR_CTP_EMPTY_JSON_BODY', 400))).toMatchObject({ code: 'bad_request' })
    expect(mapError(fastifyError('SOMETHING_ELSE', 429)).code).toBe('rate_limited')
    expect(mapError(fastifyError('SOMETHING_ELSE', 418)).code).toBe('bad_request')
    expect(mapError(fastifyError('FST_ERR_CTP_BODY_TOO_LARGE', 413)).message).not.toContain('fastify said')
  })

  it('turns anything else into internal_error, flagged unexpected', () => {
    const sql = new Error('duplicate key value violates unique constraint "Company_pkey" DETAIL: Key (id)=(…)')
    expect(mapError(sql)).toEqual({
      status: 500,
      code: 'internal_error',
      message: 'Something went wrong. The error was logged.',
      unexpected: true,
    })
    expect(mapError('a thrown string').code).toBe('internal_error')
    expect(mapError(null).code).toBe('internal_error')
    expect(mapError(fastifyError('FST_ERR_RESPONSE_SERIALIZATION', 500)).unexpected).toBe(true)
    expect(mapError(new ApiError('internal_error', 'The database is not configured.')).unexpected).toBe(true)
  })

  it.each(Object.entries(BUSY_ERRORS))('answers a busy database (%s) 503 "busy, try again", never 500', (_, error) => {
    expect(mapError(error)).toEqual({
      status: 503,
      code: 'not_ready',
      message: 'The factory is busy. Try again in a moment.',
      unexpected: false,
      retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS,
    })
  })

  it('keeps every other Prisma error, and a busy code on anything but a Prisma error, a logged 500', () => {
    for (const error of [
      prismaError('P2002', 'Unique constraint failed on the fields: (`code`)'),
      prismaError('P2025', 'An operation failed because it depends on one or more records that were required but not found.'),
      prismaError('P2010', 'Raw query failed. Code: `42601`.'),
      Object.assign(new Error('not Prisma'), { code: 'P2028' }),
      { name: 'PrismaClientKnownRequestError', code: 'P2028', message: 'not an Error' },
      new Error('Transaction API error: Unable to start a transaction in the given time.'),
    ]) {
      expect(mapError(error), String((error as { code?: string }).code)).toEqual({ status: 500, code: 'internal_error', message: 'Something went wrong. The error was logged.', unexpected: true })
    }
  })

  it('writes the error body', () => {
    expect(errorBodyFor('not_found', 'req-1')).toEqual({ error: { code: 'not_found', message: 'Not found.', requestId: 'req-1' } })
    expect(errorBodyFor('validation_failed', 'req-2', 'Bad.', [{ path: 'body', message: 'x' }]).error.issues).toHaveLength(1)
    expect(errorBodyFor('validation_failed', 'req-3', 'Bad.', []).error).not.toHaveProperty('issues')
  })
})

describe('installErrorHandling() and a busy database (B-W2b-F2)', () => {
  async function appThrowing(error: unknown) {
    const app = Fastify({ logger: false })
    installErrorHandling(app)
    app.post('/write', async () => {
      throw error
    })
    await app.ready()
    return app
  }

  it('answers 503 with Retry-After and the words, never Prisma\'s message', async () => {
    const app = await appThrowing(BUSY_ERRORS['P2028 unable to start (no pool connection within maxWait)'])
    const response = await app.inject({ method: 'POST', url: '/write' })
    expect(response.statusCode).toBe(503)
    expect(response.headers['retry-after']).toBe(String(BUSY_RETRY_AFTER_SECONDS))
    expect(response.json()).toEqual({ error: { code: 'not_ready', message: BUSY_MESSAGE, requestId: expect.any(String) } })
    expect(response.body).not.toContain('Transaction API error')
    await app.close()
  })

  it('keeps an unexpected error a 500 without Retry-After', async () => {
    const app = await appThrowing(new Error('a bug'))
    const response = await app.inject({ method: 'POST', url: '/write' })
    expect(response.statusCode).toBe(500)
    expect(response.headers['retry-after']).toBeUndefined()
    expect(response.json().error.code).toBe('internal_error')
    await app.close()
  })
})
