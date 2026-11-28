import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { holds } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import { NO_TEAM, NO_TEAM_ORDERS, teamNumbers } from '@nexus/factory-domain/production/baskets/board'
import { FLOOR_ASK_CODES, FLOOR_PROBLEM_CODES } from '@nexus/factory-domain/production/baskets/signals'
import { OPEN_CALL_STATUSES } from '@nexus/factory-domain/production/calls/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { codeWordsOf } from '../calls/store'
import { floorOf, systemView } from '../scans/access'
import { workerNames, type Reader } from '../scans/store'
import { scanSubjectFor } from '../settings/subject'
import { FLOOR_LEAD, orderPictures, rowOf } from './board'
import { basketFacts, ofTeamOrders } from './board-store'

/**
 * The team leader's home on a phone (owb- order workflow, S5 fl4 step 1; `_owb-fl-common.md` § 3 "fl2 (built in fl4)"; design
 * P/fsteps.js leaderHome: two parts Baskets · Team, the team's 4 numbers, "For you", the baskets BY ORDER; P/fplus.js whoHas,
 * handCard):
 *
 *   GET /production/baskets/team   floor.lead at the device's site
 *
 *   team        the leader's team: the signed-in worker → their employee → their live TeamMember row as the team's lead at the
 *               site (as floornotes/asks.ts reads a worker's team)
 *   baskets     the bundles of the orders the team has an open OrderTeam row of (a row naming baskets: those only); before
 *               the office gives the team an order (S3 fills OrderTeam), an honest-empty answer with a sentence
 *   numbers     Working · Waiting · Late · Problem of the TEAM's baskets (factory-domain production/baskets/board teamNumbers;
 *               never one person's count)
 *   forYou      the open problems and asks on the team's baskets and the line's newest handover note
 *   people      "Who has what": the team's people and the basket they hold now (the open stretch at its step) — a name only
 *               where the site names workers (scanSubject WORKER); a site that records stations names nobody and holds none
 *   missing     how many of the team are not signed in on any device now (a number, never who)
 *   doneToday   the team's baskets reported at their route's last step today
 *   handover    the line's newest handover note (today's GET /production/dispatch/handover reads the same rows)
 *
 * Read in the tenant's system view after the floor's checks (the floor role reads no People, OrderTeam or Party).
 */

/** The team the signed-in worker leads at the device's site now, or null. */
export async function leaderTeam(db: Reader, context: FloorContext, now: Date) {
  const worker = await db.worker.findUnique({ where: { id: context.actorId }, select: { employeeId: true } })
  if (!worker?.employeeId) return null
  const site = await db.site.findUnique({ where: { id: context.siteId }, select: { timezone: true } })
  const day = new Date(`${businessDate(now, site?.timezone)}T00:00:00.000Z`)
  const lead = await db.teamMember.findFirst({
    where: { employeeId: worker.employeeId, siteId: context.siteId, isLead: true, since: { lte: day }, OR: [{ until: null }, { until: { gte: day } }], team: { status: 'ACTIVE' } },
    orderBy: [{ since: 'desc' }, { id: 'asc' }],
    select: { team: { select: { id: true, name: true, siteId: true, companyId: true, lineId: true, pictureKind: true, pictureIcon: true, pictureColour: true } } },
  })
  return lead?.team ?? null
}

/** GET /production/baskets/team. */
export async function teamHome(caller: CommandCaller) {
  const context = floorOf(caller)
  if (!holds(actorOf(context), FLOOR_LEAD)) throw new ForbiddenError("The team's home is the team leader's.")
  const now = serverClock.now()
  return systemView(caller).withClient(async (db) => {
    const zero = { working: 0, waiting: 0, late: 0, problem: 0 }
    const nothing = { forYou: [], orders: [], people: [], missing: 0, doneToday: 0, handover: null, more: false }
    const team = await leaderTeam(db, context, now)
    if (!team) return { team: null, empty: NO_TEAM, numbers: zero, ...nothing }
    const teamLook = { id: team.id, name: team.name, pictureKind: team.pictureKind as string, pictureIcon: team.pictureIcon, pictureColour: team.pictureColour, lineId: team.lineId }
    const site = await db.site.findUnique({ where: { id: context.siteId }, select: { timezone: true } })
    const today = businessDate(now, site?.timezone)
    const dayStart = businessDayStart(today, site?.timezone)
    const day = new Date(`${today}T00:00:00.000Z`)

    const handoverRow = team.lineId ? await db.handoverNote.findFirst({ where: { lineId: team.lineId }, orderBy: [{ shiftDate: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }], select: { id: true, shiftDate: true, shiftLabel: true, text: true, createdAt: true, updatedAt: true } }) : null
    const handover = handoverRow ? { id: handoverRow.id, shiftDate: handoverRow.shiftDate.toISOString().slice(0, 10), shiftLabel: handoverRow.shiftLabel, text: handoverRow.text, writtenAt: toUtcIso(handoverRow.createdAt) } : null

    // The team's people and who of them is signed in now.
    const subject = await scanSubjectFor(db, context.siteId)
    const members = await db.teamMember.findMany({ where: { teamId: team.id, since: { lte: day }, OR: [{ until: null }, { until: { gte: day } }] }, orderBy: [{ isLead: 'desc' }, { since: 'asc' }, { id: 'asc' }], select: { employeeId: true } })
    const workers = await db.worker.findMany({ where: { siteId: context.siteId, status: 'ACTIVE', employeeId: { in: [...new Set(members.map((member) => member.employeeId))] } }, select: { id: true, employeeId: true } })
    const signedIn = new Set(
      (await db.floorSession.findMany({ where: { siteId: context.siteId, workerId: { in: workers.map((worker) => worker.id) }, endedAt: null, endsAt: { gt: now }, idleExpiresAt: { gt: now } }, select: { workerId: true } })).map((row) => row.workerId),
    )
    const missing = workers.filter((worker) => !signedIn.has(worker.id)).length

    const rows = await db.orderTeam.findMany({ where: { teamId: team.id, endedAt: null }, select: { salesOrderId: true, bundleIds: true } })
    if (rows.length === 0) return { team: teamLook, empty: NO_TEAM_ORDERS, numbers: zero, ...nothing, missing, handover, forYou: handover ? [{ kind: 'HANDOVER' as const, bundleId: null, code: null, words: handover.text ?? handover.shiftLabel, at: handover.writtenAt }] : [] }

    const { facts, more } = await basketFacts(db, { AND: [{ siteId: context.siteId }, ofTeamOrders(rows)] }, now)
    const pictures = await orderPictures(caller, db, facts.flatMap((fact) => (fact.salesOrderId ? [{ salesOrderId: fact.salesOrderId, siteId: fact.siteId }] : [])), 'floor')
    const byOrder = new Map<string | null, typeof facts>()
    for (const fact of facts) byOrder.set(fact.salesOrderId, [...(byOrder.get(fact.salesOrderId) ?? []), fact])
    const orders = [...byOrder.entries()].map(([salesOrderId, baskets]) => ({
      salesOrderId,
      customerCode: baskets[0]?.customerCode ?? null,
      picture: salesOrderId ? (pictures.get(salesOrderId) ?? null) : null,
      baskets: baskets.filter((fact) => !fact.ready).map((fact) => rowOf(fact, pictures)),
    }))

    // For you: the open problems and asks on the team's baskets (the leader's), and the line's newest handover note.
    const codeOf = new Map(facts.map((fact) => [fact.bundleId, fact.code]))
    const calls = facts.length === 0
      ? []
      : await db.helpCall.findMany({
          where: { bundleId: { in: facts.map((fact) => fact.bundleId) }, status: { in: [...OPEN_CALL_STATUSES] }, type: { code: { in: [...FLOOR_PROBLEM_CODES, ...FLOOR_ASK_CODES] } } },
          orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
          take: 50,
          select: { id: true, bundleId: true, sentAt: true, type: { select: { code: true } } },
        })
    const words = await codeWordsOf(db, calls.map((call) => call.type.code))
    const forYou = [
      ...calls.map((call) => ({
        kind: ((FLOOR_ASK_CODES as readonly string[]).includes(call.type.code) ? 'ASK' : 'PROBLEM') as 'ASK' | 'PROBLEM',
        bundleId: call.bundleId,
        code: call.bundleId ? (codeOf.get(call.bundleId) ?? null) : null,
        words: words.get(call.type.code)?.labelEn ?? call.type.code,
        at: toUtcIso(call.sentAt),
      })),
      ...(handover ? [{ kind: 'HANDOVER' as const, bundleId: null, code: null, words: handover.text ?? handover.shiftLabel, at: handover.writtenAt }] : []),
    ]

    // Who has what: a name and a basket only where the site names workers.
    const names = subject === 'WORKER' ? await workerNames(db, workers.map((worker) => worker.id)) : new Map<string, string>()
    const people = workers.map((worker, index) => {
      const held = subject === 'WORKER' ? (facts.find((fact) => fact.workerId === worker.id && fact.state !== 'WAITING') ?? null) : null
      return { key: subject === 'WORKER' ? worker.id : `member-${index + 1}`, name: subject === 'WORKER' ? (names.get(worker.id) ?? null) : null, holds: held ? { bundleId: held.bundleId, code: held.code } : null }
    })

    return {
      team: teamLook,
      empty: facts.length === 0 ? NO_TEAM_ORDERS : null,
      numbers: teamNumbers(facts.map((fact) => ({ state: fact.state, late: fact.late !== null, problem: fact.problem !== null, ready: fact.ready }))),
      forYou,
      orders,
      people,
      missing,
      doneToday: facts.filter((fact) => fact.finishedAt !== null && fact.finishedAt.getTime() >= dayStart.getTime()).length,
      handover,
      more,
    }
  })
}
