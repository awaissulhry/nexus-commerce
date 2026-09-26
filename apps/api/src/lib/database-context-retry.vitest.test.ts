/**
 * P2 (docs/attributes/PLAN.md §4.7) — which failures `inDatabaseTransaction` runs again. A lost race (serialization
 * conflict or deadlock) is rolled back by PostgreSQL and safe to retry; anything else must surface.
 */
import { expect, it } from 'vitest'
import { retryableConflict } from './database-context.js'

it('retries a lost race however Prisma reports it', () => {
  expect(retryableConflict({ code: 'P2034' })).toBe(true)
  expect(retryableConflict({ code: 'P2010', meta: { code: '40001' } })).toBe(true)
  expect(retryableConflict({ code: 'P2010', meta: { code: '40P01' } })).toBe(true)
  expect(retryableConflict({ message: 'ConnectorError(... PostgresError { code: "40P01", message: "deadlock detected" ...' })).toBe(true)
  // Prisma 7 (pg adapter): the SQLSTATE rides in the driver-adapter cause, mapped to `TransactionWriteConflict`.
  expect(retryableConflict({ code: 'P2010', meta: { driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: '40001', originalMessage: 'could not serialize access due to concurrent update', kind: 'TransactionWriteConflict' } } } })).toBe(true)
  expect(retryableConflict({ code: 'P2010', meta: { driverAdapterError: { cause: { kind: 'TransactionWriteConflict' } } } })).toBe(true)
  expect(retryableConflict({ message: 'Invalid `prisma.$executeRaw()` invocation:\n\nRaw query failed. Code: `40001`. Message: `could not serialize access due to concurrent update`' })).toBe(true)
})

it('does not retry anything else', () => {
  expect(retryableConflict(null)).toBe(false)
  expect(retryableConflict({ code: 'P2002' })).toBe(false)
  expect(retryableConflict({ code: 'P2010', meta: { code: '23505' } })).toBe(false)
  // Prisma 7's shape for an ordinary raw-SQL error (measured: division by zero) is not a race.
  expect(retryableConflict({ code: 'P2010', meta: { driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: '22012', originalMessage: 'division by zero', kind: 'postgres', code: '22012' } } } })).toBe(false)
  expect(retryableConflict({ message: 'Raw query failed. Code: `22012`. Message: `division by zero`' })).toBe(false)
  expect(retryableConflict({ code: 'P2025' })).toBe(false)
  expect(retryableConflict(new Error('Transaction already closed: A query cannot be executed on an expired transaction.'))).toBe(false)
  expect(retryableConflict({ message: 'new row violates row-level security policy for table "Product"' })).toBe(false)
})
