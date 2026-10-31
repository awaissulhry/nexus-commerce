import type { Prisma } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import { QUALITY_HOLDS_PLACE, QUALITY_HOLDS_RELEASE, QUALITY_HOLDS_VIEW } from '@nexus/factory-domain/quality/holds/permissions'
import {
  HOLD_LIMITS,
  holdPreviewWords,
  releasable,
  STOCK_SUBJECTS,
  unholdableWords,
  workOrderHoldMove,
  type HoldQuarantine,
  type HoldStatus,
  type HoldSubjectType,
} from '@nexus/factory-domain/quality/holds/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { heldRoles } from '../../../platform/auth/roles/access'
import { officeOf, releaseChecksFor } from './holds'
import { HOLD_COLUMNS, holdView, idsOfCodes, quantityWords, readHold, readSubjects, viewFactsOf, type Subject } from './store'

/**
 * The holds' reads (B-W2a-26; design quality.holds qh-metrics, qh-grid, the Hold record, qh-place's preview; Owner answer
 * Q3: until the Holds page, holds are reached from Inspections, Lots and the reversed view — `subjectId` finds the holds
 * of any record). Office only, within the caller's companies and sites (quality.holds.view).
 *
 *   GET  /quality/holds          newest first: status (default ACTIVE; ALL), kind, a held record, site, owner (`me`),
 *                                overdue, placed by the system, the quarantine move; at most 200 (`truncated`).
 *   GET  /quality/holds/counts   the tiles: open, overdue, placed by the system, mine, waiting for the quarantine move.
 *   GET  /quality/holds/:holdId  one hold: its records, the work orders it holds, the release checks for the caller.
 *   POST /quality/holds/preview  (quality.holds.place) what a hold of these records (ids or scanned codes) would hold and
 *                                block, each record's problem in words, the site's quarantine places. Writes nothing.
 *   GET  /quality/holds/people   (quality.holds.place, B-W2a-67) who may own a hold of the site: the ACTIVE office users
 *                                whose live roles see holds there (quality.holds.view), me first, then by name. A picker
 *                                only: no floor worker, no figure.
 */

const LIST_LIMIT = 200
const SCOPE = { company: 'companyId', site: 'siteId' } as const

export interface ListQuery {
  readonly status?: HoldStatus | 'ALL' | undefined
  readonly subjectType?: HoldSubjectType | undefined
  readonly subjectId?: string | undefined
  readonly siteId?: string | undefined
  readonly ownerId?: string | undefined
  readonly overdue?: boolean | undefined
  readonly system?: boolean | undefined
  readonly quarantine?: HoldQuarantine | undefined
}

function whereOf(caller: CommandCaller, query: ListQuery): Prisma.QualityHoldWhereInput {
  const context = officeOf(caller)
  const status = query.status ?? 'ACTIVE'
  const today = new Date(`${businessDate(serverClock.now())}T00:00:00.000Z`)
  return {
    AND: [
      scopeWhere(actorOf(context), QUALITY_HOLDS_VIEW, SCOPE) as Prisma.QualityHoldWhereInput,
      status === 'ALL' ? {} : { status },
      query.subjectType ? { subjectType: query.subjectType } : {},
      query.subjectId ? { subjectIds: { has: query.subjectId } } : {},
      query.siteId ? { siteId: query.siteId } : {},
      query.ownerId ? { ownerId: query.ownerId === 'me' ? context.actorId : query.ownerId } : {},
      query.overdue ? { status: 'ACTIVE', expectedReleaseOn: { lt: today } } : {},
      query.system ? { placedById: null, placedByWorkerId: null } : {},
      query.quarantine ? { quarantine: query.quarantine } : {},
    ],
  }
}

export async function listHolds(caller: CommandCaller, query: ListQuery) {
  if (query.ownerId && query.ownerId !== 'me' && !/^[0-9a-f-]{36}$/i.test(query.ownerId)) throw new ValidationError('Not an owner.', [{ path: 'querystring/ownerId', message: 'A person\'s id, or me.' }])
  const where = whereOf(caller, query)
  return caller.withClient(async (client) => {
    const rows = await client.qualityHold.findMany({ where, select: HOLD_COLUMNS, orderBy: [{ placedAt: 'desc' }, { id: 'desc' }], take: LIST_LIMIT + 1 })
    const shown = rows.slice(0, LIST_LIMIT)
    const facts = await viewFactsOf(client, shown, serverClock.now())
    return { holds: shown.map((row) => holdView(row, facts)), truncated: rows.length > LIST_LIMIT }
  })
}

export async function holdCounts(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeOf(caller)
  const base = (extra: ListQuery) => whereOf(caller, { status: 'ACTIVE', ...(query.siteId ? { siteId: query.siteId } : {}), ...extra })
  return caller.withClient(async (client) => ({
    counts: {
      open: await client.qualityHold.count({ where: base({}) }),
      overdue: await client.qualityHold.count({ where: base({ overdue: true }) }),
      system: await client.qualityHold.count({ where: base({ system: true }) }),
      mine: await client.qualityHold.count({ where: base({ ownerId: context.actorId }) }),
      waitingQuarantine: await client.qualityHold.count({ where: base({ quarantine: 'ASKED' }) }),
    },
  }))
}

export async function getHold(caller: CommandCaller, holdId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const row = await readHold(client, holdId)
    if (!row || !can(actorOf(context), QUALITY_HOLDS_VIEW, { companyId: row.companyId, siteId: row.siteId })) throw new NotFoundError('Hold not found.')
    const now = serverClock.now()
    const facts = await viewFactsOf(client, [row], now)
    const workOrders =
      row.subjectType === 'WorkOrder'
        ? (await client.workOrder.findMany({ where: { id: { in: row.subjectIds } }, select: { id: true, number: true, status: true, heldFromStatus: true, holdReason: true, holdRecordType: true, holdRecordId: true, batchNumber: true }, orderBy: { number: 'asc' } })).map((order) => ({
            id: order.id,
            number: order.number,
            status: order.status as WorkOrderStatus,
            heldFromStatus: order.heldFromStatus as WorkOrderStatus | null,
            holdReason: order.holdReason,
            /** ON_HOLD under this hold (else another record's, or not held: COMPLETED). */
            heldByThis: order.holdRecordType === 'QualityHold' && order.holdRecordId === row.id,
            batchNumber: order.batchNumber,
          }))
        : []
    const checks = await releaseChecksFor(client, row, { userId: context.actorId }, false)
    const mayRelease = can(actorOf(context), QUALITY_HOLDS_RELEASE, { companyId: row.companyId, siteId: row.siteId })
    return {
      hold: holdView(row, facts),
      workOrders,
      release: { checks, releasable: mayRelease && releasable(checks.filter((check) => check.key !== 'STATEMENT')), mayRelease },
      canChange: row.status === 'ACTIVE' && can(actorOf(context), QUALITY_HOLDS_PLACE, { companyId: row.companyId, siteId: row.siteId }),
    }
  })
}

export interface PreviewBody {
  readonly subjectType: HoldSubjectType
  readonly subjectIds?: readonly string[] | undefined
  /** Scanned or typed codes (a lot's, a hide's tag, a work order's number, a bundle ticket, a serial, a shipment's number). */
  readonly codes?: readonly string[] | undefined
}

/** POST /quality/holds/preview. */
export async function previewHold(caller: CommandCaller, body: PreviewBody) {
  const context = officeOf(caller)
  const ids = body.subjectIds ?? []
  const codes = body.codes ?? []
  if (ids.length + codes.length === 0) throw new ValidationError('Name what to hold.', [{ path: 'body/subjectIds', message: 'Ids or scanned codes.' }])
  if (ids.length + codes.length > HOLD_LIMITS.subjects) throw new ValidationError(`At most ${HOLD_LIMITS.subjects} records in one hold.`, [{ path: 'body/subjectIds', message: 'Too many.' }])
  return caller.withClient(async (client) => {
    const byCode = await idsOfCodes(client, body.subjectType, codes)
    const wanted = [...new Set([...ids, ...codes.flatMap((code) => byCode.get(code.trim()) ?? byCode.get(code.trim().toUpperCase()) ?? [])])]
    const found = new Map((await readSubjects(client, body.subjectType, wanted)).map((subject) => [subject.id, subject]))
    const visible = (subject: Subject) => can(actorOf(context), QUALITY_HOLDS_VIEW, { companyId: subject.companyId, siteId: subject.siteId })
    const sites = new Set([...found.values()].filter(visible).map((subject) => subject.siteId))
    const rows = [
      ...ids.map((id) => ({ id, code: null as string | null })),
      ...codes.map((code) => ({ id: byCode.get(code.trim()) ?? byCode.get(code.trim().toUpperCase()) ?? null, code })),
    ].map((entry) => {
      const subject = entry.id ? found.get(entry.id) : undefined
      if (!subject || !visible(subject)) return { id: entry.id && subject ? entry.id : null, code: entry.code, label: null, state: null, quantity: null, problem: 'Not found at a site you reach.' }
      const problem = unholdableWords(body.subjectType, subject) ?? (sites.size > 1 ? 'The goods are at several sites: one hold per site.' : null) ?? (can(actorOf(context), QUALITY_HOLDS_PLACE, { companyId: subject.companyId, siteId: subject.siteId }) ? null : 'You do not place holds at this site.')
      return { id: subject.id, code: entry.code, label: subject.label, state: subject.state, quantity: quantityWords([subject]), problem }
    })
    const ok = [...new Map(rows.filter((row) => row.id && !row.problem).map((row) => [row.id!, found.get(row.id!)!])).values()]
    const siteId = sites.size === 1 ? [...sites][0]! : null
    const places = siteId && STOCK_SUBJECTS.includes(body.subjectType) ? await client.location.findMany({ where: { siteId, kind: 'QUARANTINE', status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }) : []
    const workOrders =
      body.subjectType === 'WorkOrder'
        ? ok.map((subject) => ({ id: subject.id, number: subject.label, status: subject.state as WorkOrderStatus, move: workOrderHoldMove(subject.state as WorkOrderStatus) }))
        : []
    return {
      siteId,
      subjects: rows,
      words: ok.length > 0 ? holdPreviewWords(body.subjectType, ok.length, quantityWords(ok)) : null,
      quantity: quantityWords(ok),
      workOrders,
      quarantinePlaces: places,
    }
  })
}

/** The most office people the owner picker reads (a tenant's office staff). */
const MAX_PEOPLE = 500

/** GET /quality/holds/people?siteId — the owner picker (B-W2a-67; design qh-place "owner", qh-grid "Owner" inline edit). */
export async function holdPeople(caller: CommandCaller, siteId: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const site = isUuid(siteId) ? await client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true } }) : null
    if (!site || !can(actor, QUALITY_HOLDS_VIEW, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Site not found.')
    const scope = { companyId: site.companyId, siteId: site.id }
    if (!can(actor, QUALITY_HOLDS_PLACE, scope)) throw new ForbiddenError('Choosing a hold\'s owner needs quality.holds.place at its site.')
    const people: { id: string; name: string; me: boolean }[] = []
    const users = await client.user.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: MAX_PEOPLE, select: { id: true, displayName: true } })
    for (const user of users) {
      const reader: Actor = { audience: 'office', tenantId: context.tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(client, user.id, now), true) }
      if (can(reader, QUALITY_HOLDS_VIEW, scope)) people.push({ id: user.id, name: user.displayName, me: user.id === context.actorId })
    }
    return { people: [...people.filter((person) => person.me), ...people.filter((person) => !person.me)] }
  })
}
