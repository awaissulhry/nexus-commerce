import { PartyKind, PartyRole, PartyStatus } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFiles } from './files'
import { seed as seedPeople } from './people'
import { seed as seedPrint } from './print'

/**
 * The W2b-1 follow-ups for people and pay (W2b schema wave 9/16, B-W2b-75), per tenant of seed/_core.ts, written in the
 * tenant's office scope as the app writes them. It runs after the seeds it names (name order), and runs them again for a
 * test that calls it alone (all idempotent).
 *
 *   consultant   a made-up labour consultant of company A: a party with the CONSULTANT role only, so it is on neither the
 *                customers' nor the suppliers' list.
 *   settings     company A's people settings name A1's A4 printer and that consultant; the review limits stay the defaults
 *                (10 percent, 5 bundles), the constants B-W2b-44 reads until B-W2b-89.
 *   company      company A's payroll code (made up). Company B has none: the state of a company whose consultant has not
 *                given one.
 *
 * Not seeded: an earnings entry of kind BONUS (the readers know the kind from B-W2b-84 on, and a BONUS row before it would
 * fail their contracts), and the confirmation and corrections columns (no seeded layout is a provider's, and the exports
 * seed/pay.ts makes carried no correction). Every name and code is invented. Idempotent: a second run changes nothing.
 */

const AT = new Date('2026-10-15T08:00:00.000Z')

export interface FollowupsPeopleSeed {
  readonly consultantId: string
  readonly statementPrinterId: string
  readonly payrollCode: string
}

export async function seed(context: SeedContext): Promise<FollowupsPeopleSeed> {
  const { db, namespace } = context
  await seedPeople(context)
  await seedFiles(context)
  await seedPrint(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const consultantId = id('party:CONSULTANT')
  const statementPrinterId = id('print:printer:A1:A4')
  const payrollCode = 'SEED-A'

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.party.createMany({
        data: [
          {
            id: consultantId,
            companyId: companyA,
            code: 'SEED-CONSULTANT',
            kind: PartyKind.ORGANISATION,
            legalName: 'Seed Payroll Studio',
            roles: [PartyRole.CONSULTANT],
            status: PartyStatus.ACTIVE,
            createdAt: AT,
            updatedAt: AT,
            createdById: actorId,
          },
        ],
        skipDuplicates: true,
      })
      await tx.peopleSettings.updateMany({ where: { id: companyA, statementPrinterId: null }, data: { statementPrinterId, updatedAt: AT } })
      await tx.peopleSettings.updateMany({ where: { id: companyA, payrollConsultantPartyId: null }, data: { payrollConsultantPartyId: consultantId, updatedAt: AT } })
      await tx.company.updateMany({ where: { id: companyA, payrollCode: null }, data: { payrollCode, updatedAt: AT } })
    }),
  )
  return { consultantId, statementPrinterId, payrollCode }
}
