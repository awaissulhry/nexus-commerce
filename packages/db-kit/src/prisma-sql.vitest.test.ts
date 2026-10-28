import { PrismaClient } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { checkStatement } from './sql-guard'

/**
 * The statement guard is an allow-list, and the tenant adapter runs it on Prisma's OWN statements too. This test makes
 * sure Prisma 7 generates nothing it refuses: a recording driver adapter (no database; every query returns no rows)
 * captures the SQL of typical ORM reads and writes, and every captured statement must pass `checkStatement`.
 *
 * db-kit has no schema of its own, so this runs the repository's default generated client (Commerce's models `order`
 * and `orderItem`, reached untyped so their types do not matter). factory-db should repeat it with the factory client.
 */
type Delegate = Record<string, (args?: unknown) => Promise<unknown>>

function recordingClient(): { client: PrismaClient; statements: string[] } {
  const statements: string[] = []
  const empty = async (query: { sql: string }) => {
    statements.push(query.sql)
    return { columnNames: [], columnTypes: [], rows: [] }
  }
  const count = async (query: { sql: string }) => {
    statements.push(query.sql)
    return 0
  }
  const queryable = { provider: 'postgres' as const, adapterName: '@prisma/adapter-pg', queryRaw: empty, executeRaw: count }
  const adapter = {
    ...queryable,
    connect: async () => ({
      ...queryable,
      executeScript: async () => {},
      dispose: async () => {},
      getConnectionInfo: () => ({ supportsRelationJoins: true }),
      startTransaction: async () => ({ ...queryable, options: { usePhantomQuery: false }, commit: async () => {}, rollback: async () => {} }),
    }),
  }
  return { client: new PrismaClient({ adapter, log: [] }), statements }
}

describe('Prisma 7 generated SQL', () => {
  it('passes the statement guard for typical reads and writes', async () => {
    const { client, statements } = recordingClient()
    const models = client as unknown as Record<string, Delegate>
    const order = models.order as Delegate
    const item = models.orderItem as Delegate
    const where = {
      status: { in: ['PENDING', 'SHIPPED'] },
      customerEmail: { contains: "o'brien", mode: 'insensitive' },
      totalPrice: { gte: '10.50' },
      items: { some: { quantity: { gt: 1 } } },
      OR: [{ marketplace: null }, { marketplace: { startsWith: 'IT' } }],
    }
    const operations: (() => Promise<unknown>)[] = [
      () => order.findMany!({ where, orderBy: [{ totalPrice: 'desc' }, { id: 'asc' }], take: 20, skip: 5 }),
      () => order.findMany!({ where: { id: 'o1' }, include: { items: { where: { sku: { endsWith: '-XL' } } }, customer: true } }),
      () => order.findMany!({ select: { id: true, _count: { select: { items: true } } }, distinct: ['customerEmail'] }),
      () => order.findMany!({ cursor: { id: 'o1' }, take: 10 }),
      () => order.findUnique!({ where: { id: 'o1' } }),
      () => order.findFirst!({ where: { shippingAddress: { path: ['country'], equals: 'IT' } } }),
      () => order.count!({ where }),
      () => order.aggregate!({ _sum: { totalPrice: true }, _avg: { totalPrice: true }, where }),
      () => order.groupBy!({ by: ['status'], _count: { _all: true }, having: { status: { not: 'CANCELLED' } } }),
      () => order.updateMany!({ where, data: { customerName: 'x', currencyCode: null } }),
      () => order.update!({ where: { id: 'o1' }, data: { customerName: 'x', items: { deleteMany: { quantity: 0 } } } }),
      () => item.updateMany!({ where: { orderId: 'o1' }, data: { quantity: { increment: 1 } } }),
      () => item.deleteMany!({ where: { orderId: 'o1', sku: { notIn: ['a', 'b'] } } }),
      () => order.delete!({ where: { id: 'o1' } }),
      () => item.createMany!({ data: [{ orderId: 'o1', sku: 'a', quantity: 1, price: '1.00' }], skipDuplicates: true }),
      () => item.create!({ data: { order: { connect: { id: 'o1' } }, sku: 'a', quantity: 1, price: '1.00' } }),
      () => item.upsert!({ where: { id: 'i1' }, create: { order: { connect: { id: 'o1' } }, sku: 'a', quantity: 1, price: '1.00' }, update: { quantity: 2 } }),
      () => client.$transaction([order.count!({}), item.count!({})] as never),
    ]
    for (const operation of operations) {
      // No rows come back, so some operations end in "record not found" after their SQL was sent; only the SQL matters.
      await operation().catch(() => undefined)
    }
    await client.$disconnect()

    const refused = statements.flatMap((sql) => {
      try {
        checkStatement(sql)
        return []
      } catch (error) {
        return [`${(error as Error).message}\n    ${sql}`]
      }
    })
    expect(refused).toEqual([])
    const kinds = new Set(statements.map((sql) => sql.trim().split(/\s/)[0]?.toUpperCase()))
    // Not vacuous: reads, writes and the engine's own transaction control were all captured.
    for (const kind of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'COMMIT']) expect(kinds).toContain(kind)
    expect(statements.length).toBeGreaterThanOrEqual(operations.length)
  })
})
