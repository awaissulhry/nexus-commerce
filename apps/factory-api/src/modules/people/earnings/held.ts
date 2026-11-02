import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PEOPLE_EARNINGS_MANAGE, PEOPLE_EARNINGS_VIEW } from '@nexus/factory-domain/people/earnings/permissions'
import { DECIDED, HOLD_WORDS, notClockedInYet, OWN_RECORD, SCAN_VOIDED, voidedScans, type HoldReason, type HoldStatus, LIST_LIMIT } from '@nexus/factory-domain/people/earnings/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { lockPerson } from '../attendance/compute'
import { fullName, type Client } from '../attendance/store'
import { dateOf } from '../employees/access'
import { assertPersonDecides } from '../privacy/decide'
import { refusePersonKeys } from '../privacy/groups'
import { hasRight, officeOf, payGuarded, refuseEarnings, tenantOf } from './access'
import type { CountBody, HeldQuery, NotPaidBody } from './contract'
import { syncBundleInCommand } from './scans'
import { clockOf, membersOfScans, momentOf, PayFacts, SCAN_SELECT, workOfScans, type ScanRecord } from './store'

/**
 * Held scans (B-W2b-43; MES-264; design people.piecerates "Held scans", pop-up "Resolve held scan"). The list names nobody
 * (Owner answer W1): time · bundle · operation · why held; one record names the worker, for those with the right. A person
 * decides (never the worker it is about): "Clocked in late, count it" needs the attendance to show it first, and then the
 * entry is written in the same command; "Do not pay" says why. The system closes a hold only on a fact (scans.ts).
 */

const SCOPE = { company: 'companyId', site: 'siteId' } as const
const HOLD_SELECT = { id: true, companyId: true, siteId: true, payPeriodId: true, employeeId: true, workerId: true, operationScanId: true, reason: true, heldAt: true, status: true, resolvedAt: true, resolvedById: true, resolutionNote: true, fixRecordType: true, fixRecordId: true, version: true } as const satisfies Prisma.HeldScanSelect
type HoldRow = Prisma.HeldScanGetPayload<{ select: typeof HOLD_SELECT }>

async function holdOf(caller: CommandCaller, heldScanId: string, permission: Permission): Promise<{ context: OfficeContext; hold: HoldRow }> {
  const context = officeOf(caller)
  const hold = isUuid(heldScanId) ? await caller.withClient((db) => db.heldScan.findUnique({ where: { id: heldScanId }, select: HOLD_SELECT })) : null
  const actor = actorOf(context)
  if (!hold || !can(actor, PEOPLE_EARNINGS_VIEW, { companyId: hold.companyId, siteId: hold.siteId })) throw new NotFoundError('Held scan not found.')
  if (permission !== PEOPLE_EARNINGS_VIEW && !can(actor, permission, { companyId: hold.companyId, siteId: hold.siteId })) throw new NotFoundError('Held scan not found.')
  return { context, hold }
}

async function rowsOf(db: Client, holds: readonly HoldRow[]) {
  const scans = holds.length === 0 ? [] : await db.operationScan.findMany({ where: { id: { in: holds.map((row) => row.operationScanId) } }, select: SCAN_SELECT })
  const work = await workOfScans(db, scans)
  const byScan = new Map(scans.map((scan) => [scan.id, scan]))
  return holds.map((hold) => {
    const scan = byScan.get(hold.operationScanId)!
    const facts = work.get(scan.id)!
    return {
      id: hold.id,
      siteId: hold.siteId,
      periodId: hold.payPeriodId,
      at: toUtcIso(momentOf(scan)),
      bundle: facts.bundleCode,
      operation: { code: facts.code, name: facts.name },
      lineId: facts.lineId,
      pieces: scan.goodQuantity,
      reason: hold.reason as HoldReason,
      reasonWords: HOLD_WORDS[hold.reason as HoldReason],
      status: hold.status as HoldStatus,
      version: hold.version,
    }
  })
}

export async function listHeld(caller: CommandCaller, query: HeldQuery) {
  const context = officeOf(caller)
  refusePersonKeys({ filters: query.employeeId !== undefined ? ['employeeId'] : [] })
  return caller.withClient(async (db) => {
    const where: Prisma.HeldScanWhereInput = { AND: [scopeWhere(actorOf(context), PEOPLE_EARNINGS_VIEW, SCOPE) as Prisma.HeldScanWhereInput, query.periodId ? { payPeriodId: query.periodId } : {}, query.siteId ? { siteId: query.siteId } : {}, { status: query.status ?? 'OPEN' }] }
    const limit = query.limit ?? 100
    const rows = await db.heldScan.findMany({ where, select: HOLD_SELECT, orderBy: [{ heldAt: 'asc' }, { id: 'asc' }], take: Math.min(limit, LIST_LIMIT) })
    return { held: await rowsOf(db, rows), words: ['Held scans name nobody here: one held scan opens one at a time.'] }
  })
}

/** Is this hold's scan undone, or corrected by a later one? */
async function scanOf(db: Client, hold: Pick<HoldRow, 'operationScanId'>): Promise<{ scan: ScanRecord; voided: boolean }> {
  const scan = (await db.operationScan.findUnique({ where: { id: hold.operationScanId }, select: SCAN_SELECT }))!
  const siblings = await db.operationScan.findMany({ where: { bundleId: scan.bundleId, workOrderOperationId: scan.workOrderOperationId, kind: { in: ['UNDO', 'CORRECTION'] } }, select: { kind: true, correctsId: true } })
  return { scan, voided: voidedScans(siblings).has(scan.id) }
}

/** The people a hold waits on: the team of a team scan, else the scan's worker. */
async function peopleOf(db: Client, hold: HoldRow, scan: ScanRecord): Promise<string[]> {
  const team = (await membersOfScans(db, [scan])).get(scan.id) ?? []
  return team.length >= 2 ? team.flatMap((member) => (member.employeeId ? [member.employeeId] : [])) : [hold.employeeId]
}

async function clockedIn(db: Client, people: readonly string[], at: Date): Promise<{ allIn: boolean; clockEventId: string | null; out: string[] }> {
  let clockEventId: string | null = null
  const out: string[] = []
  for (const employeeId of people) {
    const stood = await clockOf(db, employeeId, at)
    if (stood.hold) out.push(employeeId)
    clockEventId ??= stood.clockEventId
  }
  return { allIn: out.length === 0, clockEventId, out }
}

export async function heldRecord(caller: CommandCaller, heldScanId: string) {
  const { context, hold } = await holdOf(caller, heldScanId, PEOPLE_EARNINGS_VIEW)
  return caller.withClient(async (db) => {
    const [row] = await rowsOf(db, [hold])
    const { scan, voided } = await scanOf(db, hold)
    const right = hasRight(context, hold)
    const facts = new PayFacts(db, serverClock.now())
    const people = await peopleOf(db, hold, scan)
    const named = right ? await db.employee.findMany({ where: { id: { in: people } }, select: { id: true, firstName: true, lastName: true } }) : []
    const stood = await clockedIn(db, people, momentOf(scan))
    const day = await facts.dayAt(scan.siteId, momentOf(scan))
    const attendance = await db.attendanceDay.findUnique({ where: { tenantId_employeeId_date: { tenantId: context.tenantId, employeeId: hold.employeeId, date: dateOf(day) } }, select: { id: true } })
    return {
      ...row!,
      day,
      /** Who the scan waits on, for those with the right; a team's scan names each member and whether they were in. */
      people: named.map((person) => ({ employeeId: person.id, name: fullName(person), clockedIn: !stood.out.includes(person.id) })),
      peopleShown: right,
      attendanceDayId: attendance?.id ?? null,
      voided,
      canCount: hold.status === 'OPEN' && !voided && stood.allIn,
      resolution: hold.status === 'OPEN' ? null : { at: hold.resolvedAt ? toUtcIso(hold.resolvedAt) : null, note: hold.resolutionNote, fixRecordType: hold.fixRecordType, fixRecordId: hold.fixRecordId },
    }
  })
}

const ownHold = async (db: Client, hold: HoldRow, actorId: string): Promise<boolean> => (await db.employee.findUnique({ where: { id: hold.employeeId }, select: { userId: true } }))?.userId === actorId

/** "Clocked in late: count it": the attendance shows it, the hold is COUNTED and the scan pays, in one command. */
export async function countHeld(caller: CommandCaller, heldScanId: string, body: CountBody, idempotencyKey?: string) {
  const { hold } = await holdOf(caller, heldScanId, PEOPLE_EARNINGS_MANAGE)
  // Before the command: its version bump on a decided hold would reach the guard first (a 500, not these words).
  if (hold.status !== 'OPEN') refuseEarnings(DECIDED)
  await payGuarded(() => command(caller, { name: 'people.countHeldScan', idempotencyKey, input: body, record: { type: 'HeldScan', id: hold.id, expectedVersion: body.version } }, async (tools) => {
    const actorId = assertPersonDecides(tools.context, 'HELD_SCAN_DECISION')
    const current = (await tools.tx.heldScan.findUnique({ where: { id: hold.id }, select: HOLD_SELECT }))!
    if (await ownHold(tools.tx, current, actorId)) refuseEarnings(OWN_RECORD)
    const { scan, voided } = await scanOf(tools.tx, current)
    if (voided) refuseEarnings(SCAN_VOIDED)
    await lockPerson(tools.tx, tenantOf(tools.context), current.employeeId)
    const facts = new PayFacts(tools.tx, tools.now)
    const stood = await clockedIn(tools.tx, await peopleOf(tools.tx, current, scan), momentOf(scan))
    if (!stood.allIn || stood.clockEventId === null) refuseEarnings(notClockedInYet(await facts.dayAt(scan.siteId, momentOf(scan))))
    await tools.tx.heldScan.update({ where: { id: hold.id }, data: { status: 'COUNTED', resolvedAt: tools.now, resolvedById: actorId, resolutionNote: body.note?.trim() || null, fixRecordType: 'ClockEvent', fixRecordId: stood.clockEventId }, select: { id: true } })
    tools.audit({ action: 'people.countHeldScan', recordType: 'HeldScan', recordId: hold.id, companyId: hold.companyId, siteId: hold.siteId, before: { status: 'OPEN' }, after: { status: 'COUNTED', fixRecordType: 'ClockEvent', fixRecordId: stood.clockEventId } })
    tools.emit({ type: 'held_scan.changed', subject: hold.id, companyId: hold.companyId, siteId: hold.siteId, payload: { heldScanId: hold.id, siteId: hold.siteId, periodId: hold.payPeriodId, status: 'COUNTED', change: 'COUNTED' } })
    await syncBundleInCommand(tools, facts, { bundleId: scan.bundleId, workOrderOperationId: scan.workOrderOperationId })
    return { id: hold.id, status: 'COUNTED' }
  }))
  return heldRecord(caller, heldScanId)
}

/** "Do not pay": with why. */
export async function notPaidHeld(caller: CommandCaller, heldScanId: string, body: NotPaidBody, idempotencyKey?: string) {
  const { hold } = await holdOf(caller, heldScanId, PEOPLE_EARNINGS_MANAGE)
  if (hold.status !== 'OPEN') refuseEarnings(DECIDED)
  await payGuarded(() => command(caller, { name: 'people.notPayHeldScan', idempotencyKey, input: body, record: { type: 'HeldScan', id: hold.id, expectedVersion: body.version } }, async (tools) => {
    const actorId = assertPersonDecides(tools.context, 'HELD_SCAN_DECISION')
    const current = (await tools.tx.heldScan.findUnique({ where: { id: hold.id }, select: HOLD_SELECT }))!
    if (await ownHold(tools.tx, current, actorId)) refuseEarnings(OWN_RECORD)
    await tools.tx.heldScan.update({ where: { id: hold.id }, data: { status: 'NOT_PAID', resolvedAt: tools.now, resolvedById: actorId, resolutionNote: body.reason.trim() }, select: { id: true } })
    tools.audit({ action: 'people.notPayHeldScan', recordType: 'HeldScan', recordId: hold.id, companyId: hold.companyId, siteId: hold.siteId, before: { status: 'OPEN' }, after: { status: 'NOT_PAID' }, reason: body.reason.trim() })
    tools.emit({ type: 'held_scan.changed', subject: hold.id, companyId: hold.companyId, siteId: hold.siteId, payload: { heldScanId: hold.id, siteId: hold.siteId, periodId: hold.payPeriodId, status: 'NOT_PAID', change: 'NOT_PAID' } })
    return { id: hold.id, status: 'NOT_PAID' }
  }))
  return heldRecord(caller, heldScanId)
}

