import { SkillKind, SkillLevel } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedPeople } from './people'
import { seed as seedPlant } from './plant'
import { seed as seedProduct } from './product'

/**
 * The skills seed (W2b schema wave 4/7, B-W2b-06), per tenant of seed/_core.ts, written in the tenant's office scope as
 * the app does, for the people of seed/people.ts. Made-up levels and dates only.
 *
 *   skills          tenant-wide: sewing the body and cutting leather (the product seed's operations), the post-bed and
 *                   walking-foot machines (the plant seed's classes), pattern reading (general).
 *   levels          E1 can sew the body and is an expert on the post-bed; E1 was a cutting trainee, signed off on
 *                   2026-10-15 by the seed member with E2 as the trainer; E2 trains sewing; E3 (agency) is learning to sew,
 *                   a trainee until 2026-12-15; E5 was an expert cutter (removed when they left); EB1 on plant B1 can sew.
 *   authorisations  E1 on post-bed machines (open), E2 on walking-foot machines until 2027-02-01; E5's walking-foot one
 *                   revoked when they left; EB1 on lockstitch machines (plant B1).
 *
 * Levels are a person's judgement (MES-281): each names who assessed it and when (the seed owner). The generated
 * isolation tests copy the FIRST row of each table by id: E5's removed level and revoked authorisation sort first (one
 * level and one authorisation in force per person count only rows not removed or revoked), and so does the sewing
 * skill (its code is suffixed in the copy). Idempotent: each record is written once and skipped when it exists.
 */

const T = {
  setup: new Date('2026-10-01T08:00:00.000Z'),
  left: new Date('2026-07-01T08:00:00.000Z'),
} as const
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`)
const at = (iso: string): Date => new Date(`${iso}T08:00:00.000Z`)

export interface SkillsSeed {
  readonly skillIds: { readonly sew: string; readonly cut: string; readonly postBed: string; readonly walkingFoot: string; readonly pattern: string }
  /** E5's removed cutting level (sorts first), E1's sewing level, E3's trainee level, E1's signed-off cutting level. */
  readonly levelIds: { readonly removed: string; readonly e1Sew: string; readonly e3Trainee: string; readonly e1SignedOff: string }
  /** E5's revoked walking-foot authorisation (sorts first), E1's post-bed one. */
  readonly authorisationIds: { readonly revoked: string; readonly e1PostBed: string }
}

export async function seed(context: SeedContext): Promise<SkillsSeed> {
  const { db, namespace } = context
  const people = await seedPeople(context)
  const { classIds } = await seedPlant(context)
  await seedProduct(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const memberId = id('user:member')
  const site = { A1: id('site:A1'), B1: id('site:B1') }
  const operation = { cut: id('product:operation:CUT'), sew: id('product:operation:SEW') }
  const e = people.employeeIds
  const office = { audience: 'office' as const, tenantId, actorId }
  const stamp = (when: Date = T.setup) => ({ createdAt: when, updatedAt: when, createdById: actorId })
  const classOf = (code: string): string => {
    const classId = classIds[code]
    if (!classId) throw new Error(`skills seed: the plant seed has no machine class ${code}`)
    return classId
  }

  const skillIds = {
    sew: firstId('skills:skill:SEW-ASM'),
    cut: id('skills:skill:CUT-LEA'),
    postBed: id('skills:skill:POST-BED'),
    walkingFoot: id('skills:skill:WALKING-FOOT'),
    pattern: id('skills:skill:PATTERN'),
  }
  const skills = [
    { id: skillIds.sew, code: 'SEED-SK-SEW-ASM', name: 'Sew and assemble the body', nameI18n: { it: 'Cucitura e montaggio', en: 'Sew and assemble the body' }, kind: SkillKind.OPERATION, operationId: operation.sew, sortOrder: 1 },
    { id: skillIds.cut, code: 'SEED-SK-CUT-LEA', name: 'Cut leather panels', nameI18n: { it: 'Taglio pelle', en: 'Cut leather panels' }, kind: SkillKind.OPERATION, operationId: operation.cut, sortOrder: 2 },
    { id: skillIds.postBed, code: 'SEED-SK-POST-BED', name: 'Post-bed machine', nameI18n: { it: 'Macchina a colonna', en: 'Post-bed machine' }, kind: SkillKind.MACHINE, machineClassId: classOf('POST_BED'), sortOrder: 3 },
    { id: skillIds.walkingFoot, code: 'SEED-SK-WALKING-FOOT', name: 'Walking-foot machine', nameI18n: { it: 'Triplo trasporto', en: 'Walking-foot machine' }, kind: SkillKind.MACHINE, machineClassId: classOf('WALKING_FOOT'), sortOrder: 4 },
    { id: skillIds.pattern, code: 'SEED-SK-PATTERN', name: 'Pattern reading', nameI18n: { it: 'Lettura del cartamodello', en: 'Pattern reading' }, kind: SkillKind.GENERAL, sortOrder: 5 },
  ]
  const levelIds = { removed: firstId('skills:level:E5:CUT-LEA'), e1Sew: id('skills:level:E1:SEW-ASM'), e3Trainee: id('skills:level:E3:SEW-ASM'), e1SignedOff: id('skills:level:E1:CUT-LEA') }
  const assessed = (iso: string) => ({ assessedAt: at(iso), assessedById: actorId })
  const levels = [
    { id: levelIds.removed, siteId: site.A1, employeeId: e.e5, skillId: skillIds.cut, level: SkillLevel.EXPERT, since: day('2021-06-01'), ...assessed('2021-06-01'), removedAt: T.left, removedById: actorId, removeReason: 'Left the company (made-up)' },
    { id: levelIds.e1Sew, siteId: site.A1, employeeId: e.e1, skillId: skillIds.sew, level: SkillLevel.CAN_DO, since: day('2024-05-02'), ...assessed('2024-05-02') },
    { id: id('skills:level:E1:POST-BED'), siteId: site.A1, employeeId: e.e1, skillId: skillIds.postBed, level: SkillLevel.EXPERT, since: day('2025-02-03'), ...assessed('2025-02-03') },
    {
      id: levelIds.e1SignedOff, siteId: site.A1, employeeId: e.e1, skillId: skillIds.cut, level: SkillLevel.CAN_DO, since: day('2026-09-01'), ...assessed('2026-10-15'),
      traineeUntil: day('2026-10-31'), signedOffOn: day('2026-10-15'), signedOffById: memberId, trainerEmployeeId: e.e2,
    },
    { id: id('skills:level:E2:SEW-ASM'), siteId: site.A1, employeeId: e.e2, skillId: skillIds.sew, level: SkillLevel.TRAINER, since: day('2023-03-01'), ...assessed('2023-03-01') },
    { id: levelIds.e3Trainee, siteId: site.A1, employeeId: e.e3, skillId: skillIds.sew, level: SkillLevel.LEARNING, since: day('2026-09-01'), ...assessed('2026-09-01'), traineeUntil: day('2026-12-15') },
    { id: id('skills:level:EB1:SEW-ASM'), siteId: site.B1, employeeId: e.eb1, skillId: skillIds.sew, level: SkillLevel.CAN_DO, since: day('2025-03-03'), ...assessed('2025-03-03') },
  ]
  const authorisationIds = { revoked: firstId('skills:auth:E5:WALKING_FOOT'), e1PostBed: id('skills:auth:E1:POST_BED') }
  const authorisations = [
    { id: authorisationIds.revoked, siteId: site.A1, employeeId: e.e5, machineClassId: classOf('WALKING_FOOT'), authorisedOn: day('2022-01-10'), authorisedById: actorId, revokedAt: T.left, revokedById: actorId, revokeReason: 'Left the company (made-up)' },
    { id: authorisationIds.e1PostBed, siteId: site.A1, employeeId: e.e1, machineClassId: classOf('POST_BED'), authorisedOn: day('2025-02-03'), authorisedById: actorId },
    { id: id('skills:auth:E2:WALKING_FOOT'), siteId: site.A1, employeeId: e.e2, machineClassId: classOf('WALKING_FOOT'), authorisedOn: day('2023-02-01'), validUntil: day('2027-02-01'), authorisedById: actorId },
    { id: id('skills:auth:EB1:LOCKSTITCH'), siteId: site.B1, employeeId: e.eb1, machineClassId: classOf('LOCKSTITCH'), authorisedOn: day('2025-03-03'), authorisedById: actorId },
  ]

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      for (const { id: rowId, ...data } of skills) {
        if (!(await tx.skill.findUnique({ where: { id: rowId }, select: { id: true } }))) await tx.skill.create({ data: { id: rowId, ...data, ...stamp() }, select: { id: true } })
      }
      for (const { id: rowId, ...data } of levels) {
        if (!(await tx.employeeSkill.findUnique({ where: { id: rowId }, select: { id: true } }))) await tx.employeeSkill.create({ data: { id: rowId, ...data, ...stamp() }, select: { id: true } })
      }
      for (const { id: rowId, ...data } of authorisations) {
        if (!(await tx.machineAuthorisation.findUnique({ where: { id: rowId }, select: { id: true } }))) await tx.machineAuthorisation.create({ data: { id: rowId, ...data, ...stamp() }, select: { id: true } })
      }
    }),
  )

  return { skillIds, levelIds, authorisationIds }
}
