import { checkStatement } from '@nexus/db-kit/sql-guard'
import { describe, expect, it } from 'vitest'
import { PrismaClient } from './generated/prisma/client'

/**
 * db-kit's tenant adapter runs its statement guard (an allow-list) on every statement, Prisma's own included. This is
 * db-kit's Prisma SQL capture test repeated with the FACTORY client: a recording driver adapter (no database; every
 * query returns no rows) captures the SQL of typical reads and writes on the core models, composite keys and the
 * tenant-safe relations included, and every captured statement must pass `checkStatement`.
 */
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
  return { client: new PrismaClient({ adapter: adapter as never }), statements }
}

const T = '01900000-0000-7000-8000-000000000001'
const S = '01900000-0000-7000-8000-000000000002'
const C = '01900000-0000-7000-8000-000000000003'

describe('Prisma 7 SQL of the factory client', () => {
  it('passes the statement guard for typical reads and writes on the core models', async () => {
    const { client, statements } = recordingClient()
    const where = {
      status: { in: ['ACTIVE' as const] },
      name: { contains: "o'brien", mode: 'insensitive' as const },
      OR: [{ code: { startsWith: 'L' } }, { code: { endsWith: '-2' } }],
      stations: { some: { workCentre: { kind: 'SEWING' as const } } },
    }
    const operations: (() => Promise<unknown>)[] = [
      () => client.line.findMany({ where, orderBy: [{ code: 'asc' }, { id: 'desc' }], take: 20, skip: 5 }),
      () => client.site.findMany({ include: { lines: { include: { stations: true } }, company: true }, where: { companyId: C } }),
      () => client.company.findMany({ select: { id: true, legalName: true, _count: { select: { sites: true } } }, distinct: ['country'] }),
      () => client.company.findMany({ where: { address: { path: ['city'], equals: 'Seedville' }, shareCapital: { gte: '10000.00' } } }),
      () => client.station.findMany({ cursor: { id: S }, take: 10 }),
      () => client.site.findUnique({ where: { tenantId_code: { tenantId: T, code: 'A1' } } }),
      () => client.tenant.findUnique({ where: { slug: 'seed' }, include: { companies: { where: { status: 'ACTIVE' } } } }),
      () => client.workCentre.count({ where: { siteId: S, kind: { not: 'SUBCONTRACT' } } }),
      () => client.company.aggregate({ _max: { shareCapital: true }, _count: { _all: true } }),
      () => client.station.groupBy({ by: ['workCentreId'], _count: { _all: true }, having: { workCentreId: { not: S } } }),
      () => client.line.updateMany({ where: { siteId: S, version: 3 }, data: { name: 'x', version: { increment: 1 } } }),
      () => client.company.update({ where: { id: C }, data: { tradeName: null, address: { line1: 'x' } } }),
      () => client.station.deleteMany({ where: { lineId: S, code: { notIn: ['a', 'b'] } } }),
      () => client.workCentre.createMany({ data: [{ id: S, companyId: C, siteId: S, code: 'CUT', name: 'Cutting', kind: 'CUTTING' }], skipDuplicates: true }),
      () => client.line.create({ data: { id: S, companyId: C, siteId: S, code: 'L1', name: 'Line 1' } }),
      () => client.site.create({ data: { id: S, code: 'A1', name: 'Plant', kind: 'PLANT', company: { connect: { id: C } } } }),
      () => client.station.upsert({ where: { id: S }, create: { id: S, companyId: C, siteId: S, lineId: S, workCentreId: S, code: 'S1', name: 'S' }, update: { name: 'S' } }),
      () => client.tenant.upsert({ where: { id: T }, create: { id: T, slug: 'seed', name: 'Seed' }, update: { name: 'Seed' } }),
      () => client.$transaction([client.line.count(), client.station.count()]),
      () => client.$transaction(async (tx) => tx.company.update({ where: { id: C }, data: { legalName: 'y' } })),
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
