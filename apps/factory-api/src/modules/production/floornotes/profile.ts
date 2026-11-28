import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate, businessDayStart } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { floorSteppedUp } from '../../../platform/auth/floor/step-up'
import { floorOf, systemView } from '../scans/access'
import { scanSubjectFor } from '../settings/subject'

/**
 * The Me page's read (owb- order workflow, S5 fl3 step 4; design floorMe; GET /floor/me stays the session's, platform/auth/floor):
 *
 *   GET /floor/me/profile   my team and its leader, the departments I may work in, today's done count for my eyes, my language
 *                           and the site's floor languages
 *
 * floor.work, the signed-in worker only. The floor role reads no People: after the session is checked the API reads the worker's
 * own rows in the tenant's system view (as My day). No new data:
 *   - team: the worker's live team at the site (Worker → employee → TeamMember, as floornotes/asks.ts reads it); its leader
 *     (the team's live lead) by their floor name only where the site names workers (else `{ name: null }`);
 *   - departments: the departments of the operations of the worker's live skills (EmployeeSkill → Skill.operationId →
 *     Operation.departmentId); none known → every active department (`departmentsFrom: 'ALL'`);
 *   - doneToday: the baskets I reported today and did not undo, ONLY after the PIN step-up (My day's rule: every figure asks the
 *     PIN again; Owner answer F1) and only where the site names workers; else null. Never anyone else's figure;
 *   - locale: the worker's floor language; floorLocales: the site's (a language is added only with its worker notice in force).
 */

const asWords = (value: Prisma.JsonValue | null): Record<string, string> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).flatMap(([key, word]) => (typeof word === 'string' ? [[key, word]] : []))) : {}

const DEPARTMENT = { id: true, number: true, name: true, shortName: true, tone: true, icon: true, nameI18n: true } as const

export interface ProfileAnswer {
  readonly subject: 'WORKER' | 'STATION'
  readonly team: { readonly id: string; readonly name: string } | null
  readonly leader: { readonly name: string | null } | null
  readonly departments: { readonly id: string; readonly number: number; readonly name: string; readonly shortName: string; readonly tone: string; readonly icon: string; readonly nameI18n: Record<string, string> }[]
  readonly departmentsFrom: 'SKILLS' | 'ALL'
  readonly doneToday: number | null
  readonly locale: string
  readonly floorLocales: string[]
}

/** GET /floor/me/profile. */
export async function myProfile(caller: CommandCaller): Promise<ProfileAnswer> {
  const context = floorOf(caller)
  const now = serverClock.now()
  // The session's PIN proof (the device's current session, the worker signed in now).
  const pinVerifiedAt = await caller.withClient(async (db) => {
    const device = await db.device.findUnique({ where: { id: context.deviceId }, select: { currentSessionId: true } })
    if (!device?.currentSessionId) return null
    const session = await db.floorSession.findUnique({ where: { id: device.currentSessionId }, select: { workerId: true, pinVerifiedAt: true } })
    return session && session.workerId === context.actorId ? session.pinVerifiedAt : null
  })
  return systemView(caller).withClient(async (db) => {
    const site = await db.site.findUnique({ where: { id: context.siteId }, select: { companyId: true, timezone: true, floorLocales: true } })
    if (!site) throw new NotFoundError('Site not found.')
    const subject = await scanSubjectFor(db, context.siteId)
    const worker = await db.worker.findUnique({ where: { id: context.actorId }, select: { employeeId: true, locale: true } })
    const today = businessDate(now, site.timezone)
    const day = new Date(`${today}T00:00:00.000Z`)
    const live = { since: { lte: day }, OR: [{ until: null }, { until: { gte: day } }] }

    // My team and its leader.
    const membership = worker?.employeeId
      ? await db.teamMember.findFirst({ where: { employeeId: worker.employeeId, siteId: context.siteId, ...live, team: { status: 'ACTIVE' } }, orderBy: [{ since: 'desc' }, { id: 'asc' }], select: { team: { select: { id: true, name: true } } } })
      : null
    let leader: { readonly name: string | null } | null = null
    if (membership) {
      const lead = await db.teamMember.findFirst({ where: { teamId: membership.team.id, isLead: true, ...live }, orderBy: [{ since: 'desc' }, { id: 'asc' }], select: { employeeId: true } })
      if (lead) {
        const name = subject === 'WORKER' ? ((await db.worker.findFirst({ where: { employeeId: lead.employeeId, siteId: context.siteId, status: 'ACTIVE' }, select: { displayName: true } }))?.displayName ?? null) : null
        leader = { name }
      }
    }

    // The departments I may work in: my live skills' operations, else every active one.
    const skills = worker?.employeeId ? await db.employeeSkill.findMany({ where: { employeeId: worker.employeeId, siteId: context.siteId, removedAt: null }, select: { skill: { select: { operation: { select: { departmentId: true } } } } } }) : []
    const fromSkills = [...new Set(skills.map((row) => row.skill.operation?.departmentId).filter((id): id is string => typeof id === 'string'))]
    const activeDepartments = (only: readonly string[] | null) =>
      db.department.findMany({
        where: { status: 'ACTIVE', OR: [{ companyId: null }, { companyId: site.companyId }], ...(only ? { id: { in: [...only] } } : {}) },
        orderBy: [{ seq: 'asc' }, { number: 'asc' }],
        select: DEPARTMENT,
      })
    const skilled = fromSkills.length > 0 ? await activeDepartments(fromSkills) : []
    const departmentRows = skilled.length > 0 ? skilled : await activeDepartments(null)

    // Today's done count, for my eyes only after the PIN step-up (My day's rule).
    let doneToday: number | null = null
    if (subject === 'WORKER' && floorSteppedUp(pinVerifiedAt, now)) {
      const reports = await db.operationScan.findMany({
        where: { siteId: context.siteId, workerId: context.actorId, kind: 'REPORT', serverTime: { gte: businessDayStart(today, site.timezone) } },
        select: { id: true, correctedBy: { where: { kind: 'UNDO' }, select: { id: true } } },
      })
      doneToday = reports.filter((report) => report.correctedBy.length === 0).length
    }

    return {
      subject,
      team: membership ? { id: membership.team.id, name: membership.team.name } : null,
      leader,
      departments: departmentRows.map((row) => ({ ...row, nameI18n: asWords(row.nameI18n) })),
      departmentsFrom: skilled.length > 0 ? 'SKILLS' : 'ALL',
      doneToday,
      locale: worker?.locale ?? 'it',
      floorLocales: [...site.floorLocales],
    }
  })
}
