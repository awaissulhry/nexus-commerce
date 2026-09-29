/**
 * P2 (docs/attributes/PLAN.md §4.7) — which failures `inDatabaseTransaction` runs again. A lost race (serialization
 * conflict or deadlock) is rolled back by PostgreSQL and safe to retry; anything else must surface.
 */
import { expect, it } from 'vitest'
import { abortedByEarlierStatement, retryableConflict, transactionMustRestart } from './database-context.js'

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

it('retries a lost race that a writer WRAPPED (a 500 that keeps the race as its cause)', () => {
  // `applyProductBulkEdits` answers every unexpected failure as ProductBulkError(500) and keeps the original as `cause`.
  const wrapped = Object.assign(new Error('Bulk update failed'), { cause: { code: 'P2034' } })
  expect(retryableConflict(wrapped)).toBe(true)
  expect(transactionMustRestart(wrapped)).toBe(true)
  expect(retryableConflict(Object.assign(new Error('Bulk update failed'), { cause: { code: 'P2002' } }))).toBe(false)
})

it('restarts a transaction that an EARLIER statement already aborted (25P02), however Prisma reports it', () => {
  // Measured 2026-09-29: sibling queries of a lost race answer 25P02 and one of them is what the caller sees.
  const p2039 = { code: 'P2039', message: 'Invalid `prisma.productMediaPlan.findMany()` invocation:\n\nDatabase error. Code: `25P02`. Message: `current transaction is aborted, commands ignored until end of transaction block`' }
  expect(abortedByEarlierStatement(p2039)).toBe(true)
  expect(abortedByEarlierStatement({ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '25P02' } } } })).toBe(true)
  expect(abortedByEarlierStatement(Object.assign(new Error('Bulk update failed'), { cause: p2039 }))).toBe(true)
  expect(transactionMustRestart(p2039)).toBe(true)
  // It is not a race by itself: `retryableConflict` keeps its narrow meaning.
  expect(retryableConflict(p2039)).toBe(false)
  expect(abortedByEarlierStatement({ code: 'P2002' })).toBe(false)
  expect(abortedByEarlierStatement({ message: 'new row violates row-level security policy for table "Product"' })).toBe(false)
})
