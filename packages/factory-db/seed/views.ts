import type { Prisma } from '../src/generated/prisma/client'
import { seed as seedAuth } from './auth'
import { seed as seedRoles } from './roles'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The list frame and report pack seed (B-W2a-23, B-W2a-38's tables), per tenant of seed/_core.ts:
 *   - saved views of Sales › Orders: the owner's own "Late orders", one for everyone, and the sales role's default view
 *     for company A;
 *   - exports: one QUEUED (the owner's), one that FAILED after it ran (its reason in words), one RUNNING;
 *   - the owner's daily production report of plant A1, Monday to Friday at 07:30, in Italian (B-W2b-30: the owner may read
 *     it; the member's sales role may not, so the report cron skipped it as not_allowed every day).
 * Made-up data, written in the tenant's office scope as the API writes them; idempotent (rows found by id first). First
 * rows (00000000) are ones the generated isolation tests can copy (an export is born QUEUED; a role default is unique
 * per list, role and company).
 */

const AT = new Date('2026-10-30T09:00:00.000Z')
const minutes = (n: number): Date => new Date(AT.getTime() + n * 60_000)

export async function seed(context: SeedContext): Promise<void> {
  const { db, namespace } = context
  const { ownerId, memberId } = await seedAuth(context)
  const { roleIds } = await seedRoles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const companyA = id('company:A')
  const stamp = { createdAt: AT, updatedAt: AT, createdById: ownerId }

  const views: Prisma.SavedViewCreateManyInput[] = [
    {
      id: firstId('views:view:late-orders'),
      listKey: 'sales.orders',
      name: 'Late orders',
      ownerId,
      audience: 'ONLY_ME',
      state: { filters: { late: true }, sort: [{ column: 'promiseDate', direction: 'asc' }] },
      ...stamp,
    },
    {
      id: id('views:view:this-week'),
      listKey: 'sales.orders',
      name: 'Shipping this week',
      ownerId,
      audience: 'EVERYONE',
      companyId: companyA,
      state: { filters: { promiseWithinDays: 7 }, columns: ['number', 'customer', 'promiseDate', 'status'] },
      ...stamp,
    },
    {
      id: id('views:view:sales-default'),
      listKey: 'sales.orders',
      name: 'My open orders',
      ownerId,
      audience: 'ROLE',
      roleId: roleIds['sales'] as string,
      roleDefault: true,
      companyId: companyA,
      state: { filters: { open: true, mine: true }, density: 'compact' },
      ...stamp,
    },
  ]
  const exportQuery = { filters: { open: true }, sort: [{ column: 'number', direction: 'desc' }] }
  const queued: Prisma.ExportJobCreateManyInput = {
    id: firstId('views:export:queued'),
    companyId: companyA,
    requestedById: ownerId,
    listKey: 'sales.orders',
    viewId: firstId('views:view:late-orders'),
    format: 'XLSX',
    query: exportQuery,
    omittedColumns: ['marginPct'],
    createdAt: minutes(50),
    updatedAt: minutes(50),
  }
  const failedId = id('views:export:failed')
  const runningId = id('views:export:running')

  await db.withScope({ audience: 'office', tenantId, actorId: ownerId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.savedView.createMany({ data: views, skipDuplicates: true })
      await tx.exportJob.createMany({ data: [queued], skipDuplicates: true })
      if (!(await tx.exportJob.findUnique({ where: { id: failedId }, select: { id: true } }))) {
        await tx.exportJob.create({
          data: { id: failedId, companyId: companyA, requestedById: ownerId, listKey: 'sales.orders', format: 'CSV', query: exportQuery, createdAt: minutes(5), updatedAt: minutes(5) },
          select: { id: true },
        })
        await tx.exportJob.update({ where: { id: failedId }, data: { status: 'RUNNING', startedAt: minutes(6), rowCount: 18_400, version: 2 }, select: { id: true } })
        await tx.exportJob.update({
          where: { id: failedId },
          data: { status: 'FAILED', rowsDone: 6_000, finishedAt: minutes(9), failureReason: 'The worker stopped before the file was complete; ask for the export again.', version: 3 },
          select: { id: true },
        })
      }
      if (!(await tx.exportJob.findUnique({ where: { id: runningId }, select: { id: true } }))) {
        await tx.exportJob.create({
          data: { id: runningId, companyId: companyA, requestedById: memberId, listKey: 'warehouse.moves', format: 'XLSX_REIMPORT', query: {}, createdAt: minutes(55), updatedAt: minutes(55) },
          select: { id: true },
        })
        await tx.exportJob.update({ where: { id: runningId }, data: { status: 'RUNNING', startedAt: minutes(56), rowsDone: 1_000, rowCount: 25_000, version: 2 }, select: { id: true } })
      }
      await tx.reportSubscription.createMany({
        data: [
          {
            id: firstId('views:subscription:daily-production'),
            userId: ownerId,
            locale: 'it',
            reportKey: 'production.daily',
            companyId: companyA,
            siteId: id('site:A1'),
            params: { lineIds: [id('site:A1:line:L1')] },
            weekdays: [1, 2, 3, 4, 5],
            sendTime: '07:30',
            ...stamp,
          },
        ],
        skipDuplicates: true,
      })
    }),
  )
}
