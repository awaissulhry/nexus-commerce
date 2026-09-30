/**
 * P2 (docs/attributes/PLAN.md §4.7) — which failures `inDatabaseTransaction` runs again. A lost race (serialization
 * conflict or deadlock) is rolled back by PostgreSQL and safe to retry; anything else must surface.
 */
import { expect, it } from 'vitest'
import { abortedByEarlierStatement, afterDatabaseCommit, inDatabaseTransaction, retryableConflict, transactionMustRestart } from './database-context.js'

const directConflict = (originalCode = '40001') => Object.assign(new Error('TransactionWriteConflict'), {
  name: 'DriverAdapterError', cause: { originalCode, kind: 'TransactionWriteConflict' },
})

it.each(['40001', '40P01'])('retries the direct pg adapter commit failure %s, including a wrapped failure', code => {
  const error = directConflict(code)
  expect(retryableConflict(error)).toBe(true)
  expect(transactionMustRestart(Object.assign(new Error('Bulk update failed'), { cause: error }))).toBe(true)
})

it('recognizes the adapter rollback code or kind independently', () => {
  for (const cause of [{ originalCode: '40001' }, { code: '40P01' }, { kind: 'TransactionWriteConflict' }]) {
    expect(retryableConflict({ name: 'DriverAdapterError', cause })).toBe(true)
  }
})

it('does not turn an uncertain commit or an unrelated adapter error into a retry', () => {
  for (const cause of [
    { originalCode: '23505', kind: 'UniqueConstraintViolation' },
    { originalCode: '08006', kind: 'ConnectionClosed' },
    { originalCode: '57014', kind: 'postgres' },
    {},
  ]) expect(retryableConflict(Object.assign(new Error('commit failed'), { name: 'DriverAdapterError', cause }))).toBe(false)
  expect(retryableConflict({ cause: { originalCode: '40001', kind: 'TransactionWriteConflict' } })).toBe(false)
  expect(retryableConflict(new Error('TransactionWriteConflict'))).toBe(false)
})

it('restarts a rolled-back commit from the beginning and runs only the successful attempt effects', async () => {
  let attempts = 0
  const effects: number[] = []
  const client = { $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
    const result = await work({})
    if (attempts === 1) throw directConflict()
    return result
  } }
  const value = await inDatabaseTransaction(client as never, async () => {
    const attempt = ++attempts
    await afterDatabaseCommit('saved', async () => { effects.push(attempt) })
    return attempt
  })
  expect(value).toBe(2)
  expect(effects).toEqual([2])
})

it('bounds repeated rolled-back commit failures at three attempts without after-commit effects', async () => {
  let attempts = 0
  const effects: number[] = []
  const error = directConflict()
  const client = { $transaction: async (work: (tx: unknown) => Promise<unknown>) => { await work({}); throw error } }
  await expect(inDatabaseTransaction(client as never, async () => {
    const attempt = ++attempts
    await afterDatabaseCommit('saved', async () => { effects.push(attempt) })
  })).rejects.toBe(error)
  expect(attempts).toBe(3)
  expect(effects).toEqual([])
})

it.each(['08006', '57014'])('does not replay an uncertain commit (%s) after the callback completed', async code => {
  let attempts = 0
  const effects: number[] = []
  const error = Object.assign(new Error('commit outcome is unknown'), { name: 'DriverAdapterError', cause: { originalCode: code } })
  const client = { $transaction: async (work: (tx: unknown) => Promise<unknown>) => { await work({}); throw error } }
  await expect(inDatabaseTransaction(client as never, async () => {
    const attempt = ++attempts
    await afterDatabaseCommit('saved', async () => { effects.push(attempt) })
  })).rejects.toBe(error)
  expect(attempts).toBe(1)
  expect(effects).toEqual([])
})

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


it('restarts after a bare pg-adapter conflict at commit and runs effects only for the committed attempt', async () => {
  // Prisma 7 can throw this directly from COMMIT, without a P2010 wrapper (measured in the sheet race CI).
  const conflict = Object.assign(new Error('TransactionWriteConflict'), {
    name: 'DriverAdapterError', cause: { kind: 'TransactionWriteConflict' },
  })
  let attempts = 0
  const effects: number[] = []
  const client = {
    async $transaction(work: (tx: unknown) => Promise<number>) {
      attempts++
      const result = await work({})
      if (attempts === 1) throw conflict
      return result
    },
  }
  const result = await inDatabaseTransaction(client as never, async () => {
    const attempt = attempts
    await afterDatabaseCommit('committed-attempt', async () => { effects.push(attempt) })
    return attempt
  })
  expect(result).toBe(2)
  expect(attempts).toBe(2)
  expect(effects).toEqual([2])
  expect(retryableConflict(Object.assign(new Error('wrapped'), { cause: conflict }))).toBe(true)
})

it('does not restart an unrelated bare pg-adapter error or guess from its message', () => {
  expect(retryableConflict(Object.assign(new Error('UniqueConstraintViolation'), {
    name: 'DriverAdapterError', cause: { kind: 'UniqueConstraintViolation' },
  }))).toBe(false)
  expect(retryableConflict(new Error('TransactionWriteConflict'))).toBe(false)
})
