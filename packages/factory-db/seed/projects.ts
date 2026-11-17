import type { Prisma } from '../src/generated/prisma/client'
import { FollowReason, ProjectOutcome, ProjectStatus } from '../src/generated/prisma/enums'
import { seedAt } from '../src/seed-calendar' // B-W2b-F53: the seeds' future follows the calendar
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedNumbering } from './numbering'
import { seed as seedPortalAuth } from './portal-auth'
import { seed as seedProduct } from './product'

/**
 * The projects' synthetic seed (TH-5, threads plan schema wave 8/9, B-TH-065), per tenant of seed/_core.ts, in company A:
 *
 *   SEED-PRJ-001  "Seed touring jacket family" for P1 (the customer and brand of the other seeds' partner rows), ACTIVE, led by
 *                 the owner, due in the seeds' future; it links P1's private-label style SEED-JKT-01 (tenant-wide); its people:
 *                 the owner (CREATOR), the office member (ADDED by the owner) and P1's portal buyer (ADDED by the owner: a
 *                 member of the outside company, the row names P1).
 *   SEED-PRJ-002  "Seed lining supplier search", office only (no outside company), ON_HOLD, led by the office member.
 *   SEED-PRJ-003  "Seed glove colour range" for P1, CLOSED as DONE with its outcome line.
 *
 * Numbers SEED-PRJ-… are made up and outside the PROJECT series the numbering seed gives (PRJ-{YY}-{N:3}), so the first
 * project the app makes still takes PRJ-26-001. SEED-PRJ-001's id starts with eight zeros: it is the first project and its
 * link the first link, the ones the generated isolation tests copy (an ACTIVE project; a link of an open project); the member
 * rows start with eight f's, so no generated test copies a portal person's follow. The CLI runs the seeds in name order and
 * this file sorts after the auth, numbering, portal sign-in and product seeds it builds on; it runs them first anyway (each
 * idempotent). Needs the core and parties seeds of the same namespace first. Written in the tenant's office scope, as the app does; every name is invented.
 * Idempotent: a second run adds nothing (INSERT … ON CONFLICT DO NOTHING).
 */

/** Fixed instants of the seeds' history (a project made in October, one closed in November). */
const T = {
  made: new Date('2026-10-20T08:00:00.000Z'),
  closed: new Date('2026-11-10T16:00:00.000Z'),
} as const

export interface ProjectsSeed {
  readonly active: string
  readonly officeOnly: string
  readonly closed: string
  readonly styleLink: string
  readonly buyerMember: string
}

export async function seed(context: SeedContext): Promise<ProjectsSeed> {
  const { db, namespace } = context
  await seedAuth(context)
  await seedNumbering(context)
  await seedProduct(context)
  const portal = await seedPortalAuth(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const zeros = (key: string): string => `00000000${id(key).slice(8)}`
  const effs = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const ownerId = id('actor')
  const memberId = id('user:member')
  const companyA = id('company:A')
  const p1 = id('party:P1')
  const styleId = id('product:style:JKT-01')
  const made: ProjectsSeed = {
    active: zeros('projects:PRJ-001'),
    officeOnly: effs('projects:PRJ-002'),
    closed: effs('projects:PRJ-003'),
    styleLink: zeros('projects:link:PRJ-001:JKT-01'),
    buyerMember: effs('projects:member:PRJ-001:p1-buyer'),
  }
  const stamp = { createdAt: T.made, updatedAt: T.made, createdById: ownerId }
  const projects: Prisma.ProjectCreateManyInput[] = [
    {
      id: made.active,
      companyId: companyA,
      number: 'SEED-PRJ-001',
      name: 'Seed touring jacket family',
      goal: 'Seed: three touring jackets on one pattern block, proto to salesman samples.',
      leadId: ownerId,
      partyId: p1,
      targetDate: seedAt('2027-03-15T00:00:00.000Z'),
      ...stamp,
    },
    {
      id: made.officeOnly,
      companyId: companyA,
      number: 'SEED-PRJ-002',
      name: 'Seed lining supplier search',
      goal: 'Seed: find a second mesh lining supplier.',
      leadId: memberId,
      targetDate: seedAt('2027-01-29T00:00:00.000Z'),
      ...stamp,
    },
    {
      id: made.closed,
      companyId: companyA,
      number: 'SEED-PRJ-003',
      name: 'Seed glove colour range',
      leadId: ownerId,
      partyId: p1,
      targetDate: new Date('2026-11-06T00:00:00.000Z'),
      ...stamp,
    },
  ]
  const links: Prisma.ProjectLinkCreateManyInput[] = [
    {
      id: made.styleLink,
      projectId: made.active,
      recordType: 'Style',
      recordId: styleId,
      key: `link:${made.active}:Style:${styleId}`,
      note: 'Seed: the base jacket of the family.',
      createdAt: T.made,
      createdById: ownerId,
    },
  ]
  const follow = { recordType: 'Project', recordId: made.active, createdAt: T.made, updatedAt: T.made }
  const followers: Prisma.RecordFollowerCreateManyInput[] = [
    { id: effs('projects:member:PRJ-001:owner'), ...follow, userId: ownerId, reason: FollowReason.CREATOR, createdById: ownerId },
    { id: effs('projects:member:PRJ-001:member'), ...follow, userId: memberId, reason: FollowReason.ADDED, createdById: ownerId },
    { id: made.buyerMember, ...follow, userId: portal.userIds.p1Buyer, partyId: p1, reason: FollowReason.ADDED, createdById: ownerId },
  ]
  await db.withScope({ audience: 'office', tenantId, actorId: ownerId }, async (client) => {
    await client.project.createMany({ data: projects, skipDuplicates: true })
    await client.projectLink.createMany({ data: links, skipDuplicates: true })
    await client.recordFollower.createMany({ data: followers, skipDuplicates: true })
    // The links stay while the project is open: on hold and closed come after them (a closed project links nothing new).
    await client.project.updateMany({ where: { id: made.officeOnly, status: ProjectStatus.ACTIVE }, data: { status: ProjectStatus.ON_HOLD } })
    await client.project.updateMany({
      where: { id: made.closed, status: ProjectStatus.ACTIVE },
      data: { status: ProjectStatus.CLOSED, outcome: ProjectOutcome.DONE, outcomeNote: 'Seed: six colours approved for the range.', closedAt: T.closed, closedById: ownerId },
    })
  })
  return made
}
