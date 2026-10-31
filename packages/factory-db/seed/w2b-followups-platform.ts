import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The W2a follow-ups for sales, product and platform (W2b schema wave 3/7, B-W2b-03), per tenant of seed/_core.ts,
 * written in the tenant's office scope as the app writes them. It runs last (seeds run in name order): the parties,
 * price lists (seed/pricing.ts), people (seed/auth.ts) and companies it names are there; they are named by id only.
 *
 *   price lists     P1's dated lists: SEED-PL-BASE in September 2026 (ended), its own SEED-PL-P1 from 1 October 2026
 *                   (open: the list on its Party row, as seed/pricing.ts gives it); P3 had SEED-PL-BASE in October 2026
 *                   (ended; no list of its own now).
 *   first load      company B's first step, customers, done as "nothing to load" (its customers are company A's).
 *   report runs     the owner ran production.daily twice and sales.open-orders once ("last run by me").
 *
 * The new columns of W0-W2a tables (closed-short reason code, copied-from and gender, two-factor since, a lifted
 * block, device network, personal default view, a supplier's time zone) are left as the earlier seeds made them: the
 * W2a code does not read them yet (a lifted block would read as blocked to it); Role.requireMfaSince is kept by the
 * database on every role the roles seed makes ask for two-factor.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy (its unique dates moved a thousand years on): P3's ended October row gets an id that starts with eight zeros (a
 * copy of a row of P1 would overlap P1's open row, which runs on for ever).
 * Every name and date is invented. Idempotent: rows are inserted once (skipped when they exist).
 */

const AT = {
  september: new Date('2026-09-01T07:00:00.000Z'),
  october: new Date('2026-10-01T07:00:00.000Z'),
  november: new Date('2026-11-01T07:00:00.000Z'),
  noOrders: new Date('2026-10-20T09:00:00.000Z'),
  daily1: new Date('2026-10-29T06:30:00.000Z'),
  daily2: new Date('2026-10-30T06:30:00.000Z'),
  openOrders: new Date('2026-10-30T08:15:00.000Z'),
} as const
const DAY = {
  septemberFrom: new Date('2026-09-01T00:00:00.000Z'),
  septemberTo: new Date('2026-09-30T00:00:00.000Z'),
  octoberFrom: new Date('2026-10-01T00:00:00.000Z'),
  octoberTo: new Date('2026-10-31T00:00:00.000Z'),
} as const

export interface FollowupsPlatformSeed {
  /** P1's ended (September) and open (October) price list assignments, and P3's ended one (October). */
  readonly assignmentIds: { readonly september: string; readonly october: string; readonly p3October: string }
  readonly firstLoadStepId: string
  readonly reportRunIds: readonly [string, string, string]
}

export async function seed({ db, namespace }: SeedContext): Promise<FollowupsPlatformSeed> {
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const ownerId = id('actor')
  const P1 = id('party:P1')
  const P3 = id('party:P3')
  const baseListId = id('pricing:list:BASE')
  const customerListId = id('pricing:list:P1')
  const assignmentIds = {
    september: id('w2b:pricing:assignment:P1:BASE:2026-09'),
    october: id('w2b:pricing:assignment:P1:P1:2026-10'),
    p3October: firstId('w2b:pricing:assignment:P3:BASE:2026-10'),
  }
  const firstLoadStepId = id('w2b:imports:first-load:B:customers')
  const reportRunIds = [id('w2b:insights:run:daily:1'), id('w2b:insights:run:daily:2'), id('w2b:insights:run:open-orders:1')] as const
  const select = { id: true } as const

  await db.withScope({ audience: 'office', tenantId, actorId: ownerId }, (client) =>
    client.$transaction(async (tx) => {
      if (!(await tx.partyPriceListAssignment.findUnique({ where: { id: assignmentIds.september }, select }))) {
        await tx.partyPriceListAssignment.create({
          data: { id: assignmentIds.september, partyId: P1, priceListId: baseListId, validFrom: DAY.septemberFrom, validTo: DAY.septemberTo, createdAt: AT.september, updatedAt: AT.october, createdById: ownerId },
          select,
        })
      }
      if (!(await tx.partyPriceListAssignment.findUnique({ where: { id: assignmentIds.october }, select }))) {
        await tx.partyPriceListAssignment.create({
          data: { id: assignmentIds.october, partyId: P1, priceListId: customerListId, validFrom: DAY.octoberFrom, createdAt: AT.october, updatedAt: AT.october, createdById: ownerId },
          select,
        })
      }
      if (!(await tx.partyPriceListAssignment.findUnique({ where: { id: assignmentIds.p3October }, select }))) {
        await tx.partyPriceListAssignment.create({
          data: { id: assignmentIds.p3October, partyId: P3, priceListId: baseListId, validFrom: DAY.octoberFrom, validTo: DAY.octoberTo, createdAt: AT.october, updatedAt: AT.november, createdById: ownerId },
          select,
        })
      }

      if (!(await tx.firstLoadStep.findUnique({ where: { id: firstLoadStepId }, select }))) {
        await tx.firstLoadStep.create({
          data: {
            id: firstLoadStepId,
            companyId: id('company:B'),
            step: 'customers',
            nothingToLoad: true,
            reason: 'Seed company B sells through seed company A: no customers of its own.',
            doneAt: AT.noOrders,
            doneById: ownerId,
            createdAt: AT.noOrders,
            updatedAt: AT.noOrders,
            createdById: ownerId,
          },
          select,
        })
      }

      const runs = [
        { id: reportRunIds[0], reportKey: 'production.daily', params: { companyId: id('company:A'), siteId: id('site:A1') }, at: AT.daily1 },
        { id: reportRunIds[1], reportKey: 'production.daily', params: { companyId: id('company:A'), siteId: id('site:A1') }, at: AT.daily2 },
        { id: reportRunIds[2], reportKey: 'sales.open-orders', params: {}, at: AT.openOrders },
      ]
      await tx.reportRun.createMany({ data: runs.map((run) => ({ ...run, userId: ownerId, createdAt: run.at, createdById: ownerId })), skipDuplicates: true })
    }),
  )
  return { assignmentIds, firstLoadStepId, reportRunIds }
}
