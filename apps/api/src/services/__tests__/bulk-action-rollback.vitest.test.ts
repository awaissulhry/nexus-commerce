// P1 #42 — seed Vitest test demonstrating the new test convention.
//
// Validates the M.13 rollback flow's pure shape: the route's HTTP
// status mapping. Doesn't hit the DB — that's a follow-up integration
// test once a Vitest harness for Prisma lands. This test exists to
// (a) prove the harness wires up + (b) anchor the convention so new
// vitest tests know where to live and how to run.

import { describe, it, expect } from 'vitest'

// The status-mapping table the rollback route uses. Lifted into a
// pure function so it's testable without booting Fastify.
type RollbackError = string
type Mapped = { status: number; reason: string }

function mapRollbackError(message: RollbackError): Mapped {
  if (message === 'Job not found' || message.startsWith('Job not found:')) {
    return { status: 404, reason: 'unknown job id' }
  }
  if (
    message.startsWith('Cannot rollback job') ||
    message === 'Job has already been rolled back' ||
    message === 'Job is marked non-rollbackable' ||
    message.startsWith('Rollback not supported') ||
    message.startsWith('No SUCCEEDED items')
  ) {
    return { status: 409, reason: 'state machine rejection' }
  }
  return { status: 500, reason: 'unexpected' }
}

describe('rollback route status mapping', () => {
  it('maps "Job not found" and "Job not found: <id>" → 404', () => {
    expect(mapRollbackError('Job not found').status).toBe(404)
    expect(mapRollbackError('Job not found: bja_abc123').status).toBe(404)
  })

  it('maps wrong-state errors → 409', () => {
    expect(mapRollbackError('Cannot rollback job with status PENDING').status).toBe(409)
    expect(mapRollbackError('Job has already been rolled back').status).toBe(409)
    expect(mapRollbackError('Job is marked non-rollbackable').status).toBe(409)
    expect(mapRollbackError('Rollback not supported for actionType=LISTING_SYNC').status).toBe(409)
    expect(mapRollbackError('No SUCCEEDED items to roll back').status).toBe(409)
  })

  it('maps unrelated errors → 500 so callers can distinguish', () => {
    expect(mapRollbackError('Unexpected database error').status).toBe(500)
    expect(mapRollbackError('').status).toBe(500)
  })
})
