import { describe, expect, it } from 'vitest'
import { ERROR_CODES, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { ApiError, errorBodyFor, mapError, STATUS_OF } from './errors'

const fastifyError = (code: string, statusCode: number, message = 'fastify said something') =>
  Object.assign(new Error(message), { code, statusCode })

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

  it('writes the error body', () => {
    expect(errorBodyFor('not_found', 'req-1')).toEqual({ error: { code: 'not_found', message: 'Not found.', requestId: 'req-1' } })
    expect(errorBodyFor('validation_failed', 'req-2', 'Bad.', [{ path: 'body', message: 'x' }]).error.issues).toHaveLength(1)
    expect(errorBodyFor('validation_failed', 'req-3', 'Bad.', []).error).not.toHaveProperty('issues')
  })
})
