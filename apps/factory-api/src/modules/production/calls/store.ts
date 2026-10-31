import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { callTimes, isOpenCall, secondsOpen, typeOrder, type CallKind, type CallStatus } from '@nexus/factory-domain/production/calls/rules'
import type { CommandTx } from '../../../core/command'
import type { CallContext } from './access'

/**
 * Reading help calls and their types (B-W2b-35), for the office and the floor alike (each reads in its own scope: the
 * floor only its site's rows). A type's words, icon and colour are its code's in the HELP_CALL reason list; its responder
 * group is a team of the site (people.prisma), or the site's team leaders (the leads of the teams of the call's line, else
 * of the site) when it names none.
 *
 * People: a list names nobody but office users (who answered, in the office); the caller and a floor worker who answered
 * are named only inside one call (the floor's card, the office's record), and the caller only where the site's floor
 * records name workers (HelpCall.workerId is set only there). Response times are the call's, never a person's.
 */

export type Reader = FactoryClient | CommandTx

export const CALL_COLUMNS = {
  id: true,
  siteId: true,
  typeId: true,
  stationId: true,
  lineId: true,
  workerId: true,
  workOrderId: true,
  bundleId: true,
  note: true,
  status: true,
  sentAt: true,
  seenAt: true,
  seenById: true,
  onTheWayAt: true,
  onTheWayById: true,
  solvedAt: true,
  solvedById: true,
  resolutionCode: true,
  resolutionNote: true,
  cancelledAt: true,
  cancelledById: true,
  escalatedAt: true,
  outcomeRecordType: true,
  outcomeRecordId: true,
  deviceId: true,
  clientEventId: true,
  version: true,
  type: { select: { id: true, companyId: true, code: true, kind: true, responderTeamId: true, offStandardCodeId: true, active: true } },
  station: { select: { id: true, companyId: true, code: true, name: true } },
  line: { select: { id: true, code: true, name: true } },
  workOrder: { select: { id: true, number: true } },
  bundle: { select: { id: true, code: true } },
} as const satisfies Prisma.HelpCallSelect
export type CallRow = Prisma.HelpCallGetPayload<{ select: typeof CALL_COLUMNS }>

/** A call's company and site, for can(). */
export const scopeOfCall = (row: Pick<CallRow, 'siteId' | 'station'>) => ({ companyId: row.station.companyId, siteId: row.siteId })

export async function readCall(db: Reader, id: string): Promise<CallRow | null> {
  return db.helpCall.findUnique({ where: { id }, select: CALL_COLUMNS })
}

/** The call row locked for the command. */
export async function lockCall(tx: CommandTx, id: string): Promise<CallRow | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "HelpCall" WHERE "id" = ${id}::uuid FOR UPDATE`
  return locked.length === 0 ? null : readCall(tx, id)
}

/** The open call of a station and type (one at most: the partial unique index). */
export async function openCallOf(db: Reader, stationId: string, typeId: string): Promise<CallRow | null> {
  return db.helpCall.findFirst({ where: { stationId, typeId, status: { in: ['SENT', 'SEEN', 'ON_THE_WAY'] } }, select: CALL_COLUMNS })
}

/** The call a device sent under this client event id (a resent queued call is answered once). */
export async function callByClientEvent(db: Reader, deviceId: string, clientEventId: string): Promise<CallRow | null> {
  return db.helpCall.findFirst({ where: { deviceId, clientEventId }, select: CALL_COLUMNS })
}

// ---- sites, stations, devices -------------------------------------------------------------------------------------------

export const SITE = { id: true, companyId: true, code: true, name: true, timezone: true } as const
export type SiteRow = Prisma.SiteGetPayload<{ select: typeof SITE }>

export async function siteOf(db: Reader, siteId: string): Promise<SiteRow | null> {
  return db.site.findUnique({ where: { id: siteId }, select: SITE })
}

export const STATION = { id: true, companyId: true, siteId: true, code: true, name: true, lineId: true, status: true, line: { select: { id: true, code: true, name: true } } } as const
export type StationRow = Prisma.StationGetPayload<{ select: typeof STATION }>

export async function stationOf(db: Reader, stationId: string): Promise<StationRow | null> {
  return db.station.findUnique({ where: { id: stationId }, select: STATION })
}

/** The device's station and line (a LINE or DISPLAY device names a line and no station). */
export async function devicePlaceOf(db: Reader, deviceId: string): Promise<{ readonly stationId: string | null; readonly lineId: string | null }> {
  const device = await db.device.findUnique({ where: { id: deviceId }, select: { stationId: true, lineId: true, station: { select: { lineId: true } } } })
  return { stationId: device?.stationId ?? null, lineId: device?.lineId ?? device?.station?.lineId ?? null }
}

// ---- types --------------------------------------------------------------------------------------------------------------

export const TYPE_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  code: true,
  kind: true,
  responderTeamId: true,
  escalateAfterMinutes: true,
  offStandardCodeId: true,
  sortOrder: true,
  active: true,
  version: true,
  responderTeam: { select: { id: true, code: true, name: true, status: true, lineId: true } },
  offStandardCode: { select: { id: true, code: true, labelIt: true, labelEn: true, active: true } },
} as const satisfies Prisma.HelpCallTypeSelect
export type TypeRow = Prisma.HelpCallTypeGetPayload<{ select: typeof TYPE_COLUMNS }>

export async function readType(db: Reader, id: string): Promise<TypeRow | null> {
  return db.helpCallType.findUnique({ where: { id }, select: TYPE_COLUMNS })
}

export async function lockType(tx: CommandTx, id: string): Promise<TypeRow | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "HelpCallType" WHERE "id" = ${id}::uuid FOR UPDATE`
  return locked.length === 0 ? null : readType(tx, id)
}

export async function typesOfSite(db: Reader, siteId: string, options: { readonly active?: boolean } = {}): Promise<TypeRow[]> {
  return typeOrder(await db.helpCallType.findMany({ where: { siteId, ...(options.active === undefined ? {} : { active: options.active }) }, select: TYPE_COLUMNS }))
}

/** The words, icon and colour of HELP_CALL codes (the tiles), by code. */
export interface CodeWords {
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n: Readonly<Record<string, string>>
  readonly icon: string | null
  readonly colour: string | null
  readonly active: boolean
}

export async function codeWordsOf(db: Reader, codes: readonly string[]): Promise<Map<string, CodeWords>> {
  const wanted = [...new Set(codes)]
  if (wanted.length === 0) return new Map()
  const rows = await db.reasonCode.findMany({ where: { list: 'HELP_CALL', code: { in: wanted } }, select: { code: true, labelIt: true, labelEn: true, labelI18n: true, icon: true, colour: true, active: true } })
  return new Map(rows.map((row) => [row.code, { labelIt: row.labelIt, labelEn: row.labelEn, labelI18n: (row.labelI18n ?? {}) as Record<string, string>, icon: row.icon, colour: row.colour, active: row.active }]))
}

const wordsOf = (code: string, words: ReadonlyMap<string, CodeWords>) => {
  const found = words.get(code)
  return { labelIt: found?.labelIt ?? code, labelEn: found?.labelEn ?? code, labelI18n: found?.labelI18n ?? {}, icon: found?.icon ?? null, colour: found?.colour ?? null }
}

/**
 * Who answers a type's calls at the site: its team's current members, or — no team named — the site's team leaders (the
 * leads of the teams of the line, else of every team of the site). `accounts`: also their office accounts (for the notice;
 * the office and the system only: the floor reads no employee's account).
 */
export async function respondersOf(db: Reader, input: { readonly siteId: string; readonly responderTeamId: string | null; readonly lineId: string | null }, options: { readonly accounts: boolean } = { accounts: false }) {
  const current = { until: null, employee: { status: 'ACTIVE' as const } }
  let rows: { employeeId: string }[]
  if (input.responderTeamId) {
    rows = await db.teamMember.findMany({ where: { teamId: input.responderTeamId, ...current }, select: { employeeId: true } })
  } else {
    const leads = (where: Prisma.TeamWhereInput) => db.teamMember.findMany({ where: { isLead: true, ...current, team: { siteId: input.siteId, status: 'ACTIVE', ...where } }, select: { employeeId: true } })
    rows = input.lineId ? await leads({ lineId: input.lineId }) : []
    if (rows.length === 0) rows = await leads({})
  }
  const employeeIds = [...new Set(rows.map((row) => row.employeeId))]
  const accounts = options.accounts && employeeIds.length > 0 ? await db.employee.findMany({ where: { id: { in: employeeIds }, userId: { not: null } }, select: { userId: true } }) : []
  return { employeeIds, userIds: [...new Set(accounts.map((row) => row.userId).filter((id): id is string => id !== null))] }
}

/** How many answer each type now (team members, or the site's team leaders), by type id. */
async function responderCounts(db: Reader, types: readonly TypeRow[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  for (const type of types) counts.set(type.id, (await respondersOf(db, { siteId: type.siteId, responderTeamId: type.responderTeamId, lineId: type.responderTeam?.lineId ?? null })).employeeIds.length)
  return counts
}

/** The routing grid and "Who is called" (design production.settings "Help-call routing", production.calls "Who is called"). */
export async function typeViews(db: Reader, types: readonly TypeRow[]) {
  const words = await codeWordsOf(db, types.map((type) => type.code))
  const members = await responderCounts(db, types)
  const ids = types.map((type) => type.id)
  const used = ids.length === 0 ? [] : await db.helpCall.groupBy({ by: ['typeId'], where: { typeId: { in: ids } }, _count: { _all: true } })
  const open = ids.length === 0 ? [] : await db.helpCall.groupBy({ by: ['typeId'], where: { typeId: { in: ids }, status: { in: ['SENT', 'SEEN', 'ON_THE_WAY'] } }, _count: { _all: true } })
  const countOf = (rows: { typeId: string; _count: { _all: number } }[], id: string) => rows.find((row) => row.typeId === id)?._count._all ?? 0
  return types.map((type) => ({
    id: type.id,
    companyId: type.companyId,
    siteId: type.siteId,
    code: type.code,
    kind: type.kind as CallKind,
    ...wordsOf(type.code, words),
    codeListed: words.get(type.code)?.active ?? false,
    responder: type.responderTeam
      ? { kind: 'TEAM' as const, team: { id: type.responderTeam.id, code: type.responderTeam.code, name: type.responderTeam.name, active: type.responderTeam.status === 'ACTIVE' }, members: members.get(type.id) ?? 0 }
      : { kind: 'TEAM_LEADERS' as const, team: null, members: members.get(type.id) ?? 0 },
    escalateAfterMinutes: type.escalateAfterMinutes,
    waitingCode: type.offStandardCode ? { id: type.offStandardCode.id, code: type.offStandardCode.code, labelIt: type.offStandardCode.labelIt, labelEn: type.offStandardCode.labelEn, active: type.offStandardCode.active } : null,
    sortOrder: type.sortOrder,
    active: type.active,
    version: type.version,
    usedCount: countOf(used, type.id),
    openCount: countOf(open, type.id),
  }))
}

// ---- people --------------------------------------------------------------------------------------------------------------

export type Person = { readonly kind: 'USER' | 'WORKER'; readonly name: string | null }

/**
 * Who took a step, from an actor id (an office user or a floor worker). The office reads users by name; the floor reads
 * no user table, so an office responder shows there as an office user with their team (design floor.help "who is coming").
 * `named`: a floor worker's name may show (inside one call only).
 */
export async function peopleOf(db: Reader, context: CallContext, ids: readonly (string | null)[], named: boolean): Promise<Map<string, Person>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  const people = new Map<string, Person>()
  if (wanted.length === 0) return people
  const workers = await db.worker.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })
  for (const worker of workers) people.set(worker.id, { kind: 'WORKER', name: named ? worker.displayName : null })
  const rest = wanted.filter((id) => !people.has(id))
  if (rest.length > 0 && context.audience === 'office') {
    for (const user of await db.user.findMany({ where: { id: { in: rest } }, select: { id: true, displayName: true } })) people.set(user.id, { kind: 'USER', name: user.displayName })
  }
  for (const id of rest) if (!people.has(id)) people.set(id, { kind: 'USER', name: null })
  return people
}

// ---- call views ----------------------------------------------------------------------------------------------------------

const iso = (at: Date | null) => (at ? toUtcIso(at) : null)

/** Calls with a booked waiting block (MES-148: "Waiting time not counted" on the row). */
async function waitingOf(db: Reader, callIds: readonly string[]): Promise<Map<string, { id: string; status: string; startedAt: Date; endedAt: Date | null; code: string }>> {
  if (callIds.length === 0) return new Map()
  const blocks = await db.offStandardEntry.findMany({ where: { helpCallId: { in: [...callIds] } }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }], select: { id: true, helpCallId: true, status: true, startedAt: true, endedAt: true, code: { select: { code: true } } } })
  return new Map(blocks.map((block) => [block.helpCallId!, { id: block.id, status: block.status, startedAt: block.startedAt, endedAt: block.endedAt, code: block.code.code }]))
}

/** The rows of a list (the office's inbox, the line's open calls): nobody named but office users who answered. */
export async function callViews(db: Reader, rows: readonly CallRow[], context: CallContext, now: Date) {
  const words = await codeWordsOf(db, rows.map((row) => row.type.code))
  const teamIds = [...new Set(rows.map((row) => row.type.responderTeamId).filter((id): id is string => id !== null))]
  const teams = new Map((teamIds.length === 0 ? [] : await db.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, code: true, name: true } })).map((team) => [team.id, team]))
  const people = await peopleOf(db, context, rows.map((row) => row.seenById), false)
  const waiting = await waitingOf(db, rows.map((row) => row.id))
  return rows.map((row) => {
    const team = row.type.responderTeamId ? (teams.get(row.type.responderTeamId) ?? null) : null
    const seenBy = row.seenById ? (people.get(row.seenById) ?? null) : null
    return {
      id: row.id,
      version: row.version,
      siteId: row.siteId,
      status: row.status as CallStatus,
      open: isOpenCall(row.status),
      type: { id: row.type.id, code: row.type.code, kind: row.type.kind as CallKind, ...wordsOf(row.type.code, words) },
      station: { id: row.station.id, code: row.station.code, name: row.station.name },
      line: row.line ? { id: row.line.id, code: row.line.code, name: row.line.name } : null,
      workOrder: row.workOrder ? { id: row.workOrder.id, number: row.workOrder.number } : null,
      bundle: row.bundle ? { id: row.bundle.id, code: row.bundle.code } : null,
      responderTeam: team ? { id: team.id, code: team.code, name: team.name } : null,
      note: row.note,
      sentAt: toUtcIso(row.sentAt),
      seenAt: iso(row.seenAt),
      onTheWayAt: iso(row.onTheWayAt),
      solvedAt: iso(row.solvedAt),
      cancelledAt: iso(row.cancelledAt),
      escalatedAt: iso(row.escalatedAt),
      openSeconds: isOpenCall(row.status) ? secondsOpen(row.sentAt, now) : null,
      times: callTimes(row),
      seenBy: seenBy ? { kind: seenBy.kind, name: seenBy.kind === 'USER' && context.audience === 'office' ? seenBy.name : null } : null,
      resolutionCode: row.resolutionCode,
      outcome: row.outcomeRecordType && row.outcomeRecordId ? { recordType: row.outcomeRecordType, recordId: row.outcomeRecordId } : null,
      waitingBooked: waiting.has(row.id),
    }
  })
}

const TIMELINE = [
  ['SENT', 'sentAt', null],
  ['SEEN', 'seenAt', 'seenById'],
  ['ON_THE_WAY', 'onTheWayAt', 'onTheWayById'],
  ['SOLVED', 'solvedAt', 'solvedById'],
  ['CANCELLED', 'cancelledAt', 'cancelledById'],
] as const

/**
 * One call (the office's DetailModal, the floor's "Your call" card): its timeline with who took each step, the caller
 * where the site names workers, who is coming ("Seed Worker · Line 1 team · on the way"), the waiting block.
 */
export async function callRecord(db: Reader, row: CallRow, context: CallContext, now: Date) {
  const [view] = await callViews(db, [row], context, now)
  const people = await peopleOf(db, context, [row.workerId, row.seenById, row.onTheWayById, row.solvedById, row.cancelledById], true)
  const personOf = (id: string | null) => (id ? (people.get(id) ?? { kind: 'USER' as const, name: null }) : null)
  const block = (await waitingOf(db, [row.id])).get(row.id) ?? null
  const timeline = TIMELINE.filter(([, at]) => row[at] !== null).map(([step, at, by]) => ({ step, at: toUtcIso(row[at]!), by: by ? personOf(row[by]) : null }))
  const comingId = row.onTheWayById ?? row.seenById
  return {
    ...view!,
    caller: row.workerId ? personOf(row.workerId) : null,
    timeline,
    coming: isOpenCall(row.status) && (row.onTheWayAt || row.seenAt) ? { step: row.onTheWayAt ? ('ON_THE_WAY' as const) : ('SEEN' as const), by: personOf(comingId), team: view!.responderTeam } : null,
    resolutionNote: row.resolutionNote,
    waiting: block ? { blockId: block.id, code: block.code, status: block.status, startedAt: toUtcIso(block.startedAt), endedAt: iso(block.endedAt) } : null,
    bookWaiting: row.type.offStandardCodeId !== null,
  }
}

/** The day's response figures of the calls given (sent today): per call, never per person. */
export function answeredOf(rows: readonly Pick<CallRow, 'sentAt' | 'seenAt'>[]): number[] {
  return rows.flatMap((row) => {
    const seconds = callTimes({ sentAt: row.sentAt, seenAt: row.seenAt, onTheWayAt: null, solvedAt: null }).responseSeconds
    return seconds === null ? [] : [seconds]
  })
}
