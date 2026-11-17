import type { FactoryClient } from '@nexus/factory-db'
import type { Finding, RulePlace } from '@nexus/factory-domain/alerts/rules'
import { businessDate } from '@nexus/factory-domain/core/time'
import { isStale, PROJECT_LIMITS, type ProjectStatus } from '@nexus/factory-domain/projects/rules'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { listRowsOf } from './list'
import { dayOf, mayRead, officeOf, PROJECT_COLUMNS, readableWhere } from './store'

/**
 * Projects around the day (threads plan TH-5, B-TH-071; PROJ-G14; design PROJ.home-F03, F04):
 *
 *   GET /projects/mine        Today's "My projects" panel: the open projects I am in (I lead it, made it, was added or follow
 *                             it), nearest target date first, with the target's state in words and my own new marks (muted:
 *                             none). Empty: the panel hides. Office only; threads.read over each.
 *   alert PROJECT_STALE       an open project past its target date whose thread has had no message for 14 days: its lead is
 *                             told "close or update it" (platform/alerts: this file's finder; the notification goes to the lead
 *                             only, platform/notifications/rules/alerts.ts). It suggests, never acts.
 *
 * "Changed since you looked" (Today) already lists a project with new messages: its followers are its people.
 */

/** GET /projects/mine */
export async function myProjects(caller: CommandCaller) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (db) => {
    const mine = await db.recordFollower.findMany({ where: { recordType: 'Project', userId: context.actorId }, select: { recordId: true }, take: PROJECT_LIMITS.list })
    const rows = await db.project.findMany({
      where: { AND: [readableWhere(actor), { status: { not: 'CLOSED' } }, { OR: [{ leadId: context.actorId }, { id: { in: mine.map((row) => row.recordId) } }] }] },
      orderBy: [{ targetDate: 'asc' }, { id: 'asc' }],
      take: 50,
      select: PROJECT_COLUMNS,
    })
    const visible = rows.filter((row) => mayRead(actor, row))
    const listed = await listRowsOf(db, context.actorId, visible, today)
    return { projects: listed.map((row) => ({ ...row, lead: { ...row.lead, me: row.lead.id === context.actorId } })) }
  })
}

const DAY_MS = 86_400_000

/**
 * The finder of PROJECT_STALE (platform/alerts/evaluators FINDERS), in the tenant's system scope: the open projects (the rule's
 * company, else every one) past their target date whose thread's last message (none: its making) is 14 days old or more. One
 * alert per project; it clears when the project is closed, its target date moves or someone writes. `only`: a recheck's projects.
 * Its scope is the project's own (company, outside company): a person limited to other customers never sees it. The facts name
 * the target date and the quiet days, never a person.
 */
export async function projectsStaleFindings(tx: FactoryClient | CommandTx, rule: RulePlace, now: Date, only?: readonly string[]): Promise<Finding[]> {
  const today = businessDate(now)
  const rows = await tx.project.findMany({
    where: {
      status: { not: 'CLOSED' },
      targetDate: { lt: new Date(`${today}T00:00:00.000Z`) },
      ...(rule.companyId ? { companyId: rule.companyId } : {}),
      ...(only ? { id: { in: [...only] } } : {}),
    },
    orderBy: [{ targetDate: 'asc' }, { id: 'asc' }],
    take: 1000,
    select: { id: true, companyId: true, partyId: true, number: true, name: true, status: true, targetDate: true, createdAt: true },
  })
  if (rows.length === 0) return []
  const last = new Map((await tx.thread.findMany({ where: { recordType: 'Project', recordId: { in: rows.map((row) => row.id) } }, select: { recordId: true, lastMessageAt: true } })).map((row) => [row.recordId, row.lastMessageAt]))
  const findings: Finding[] = []
  for (const row of rows) {
    const lastMessageAt = last.get(row.id) ?? null
    if (!isStale({ status: row.status as ProjectStatus, targetDate: dayOf(row.targetDate), lastMessageAt, createdAt: row.createdAt }, today, now)) continue
    findings.push({
      recordType: 'Project',
      recordId: row.id,
      label: `${row.number} ${row.name}`,
      scope: { companyId: row.companyId, siteId: null, partyId: row.partyId },
      facts: { targetDate: dayOf(row.targetDate), quietDays: Math.floor((now.getTime() - (lastMessageAt ?? row.createdAt).getTime()) / DAY_MS) },
    })
  }
  return findings
}
