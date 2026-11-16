import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRIVACY_REQUESTS_VIEW } from '@nexus/factory-domain/privacy/retention/permissions'
import {
  clockOf,
  ERASED_PERSON_WORDS,
  OPEN_REQUEST_STATUSES,
  REQUEST_HELD_WORDS,
  requestActions,
  type DataRequestKind,
  type DataRequestStatus,
  type DataSubjectKind,
  type RequestAction,
  type RequestHeld,
} from '@nexus/factory-domain/privacy/retention/requests'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { mayOn, officeOf } from '../access'
import { personFacts } from '../erasure/sources/person'
import type { Reader } from '../erasure/sources/type'

/**
 * Reading data requests (B-W2b-405; PLT-202, PLT-203; design admin.privacy "Data requests": person, kind, received, due with a
 * Countdown, state). A request is a record of its company: privacy.requests.view on that company to know it exists (404
 * otherwise), the route's permission to act (403). The package's collection is followed through its audit rows (asked, ready,
 * failed): no column of its own.
 */

export const REQUEST_SELECT = {
  id: true,
  companyId: true,
  personKind: true,
  personRecordType: true,
  personRecordId: true,
  kind: true,
  receivedAt: true,
  dueAt: true,
  extendedDueAt: true,
  extensionReason: true,
  note: true,
  identityCheckedAt: true,
  identityCheckedById: true,
  status: true,
  decidedAt: true,
  decidedById: true,
  refusalReason: true,
  packageFileId: true,
  version: true,
  createdAt: true,
  company: { select: { id: true, code: true, legalName: true, tradeName: true } },
  packageFile: { select: { id: true, originalName: true, sizeBytes: true, sha256: true, availableAt: true, status: true, deleteAfter: true } },
} as const satisfies Prisma.DataRequestSelect
export type RequestRow = Prisma.DataRequestGetPayload<{ select: typeof REQUEST_SELECT }>

/** The commands whose audit rows follow a package's collection. */
export const COLLECT_ACTIONS = { asked: 'privacy.requestCollect', ready: 'privacy.requestPackage', failed: 'privacy.requestPackageFailed' } as const

const coded = (held: RequestHeld | null) => (held === null ? null : { code: held, words: REQUEST_HELD_WORDS[held] })
const actionView = (action: RequestAction) => ({ allowed: action.allowed, held: coded(action.held) })

/** Why there is no package to download: never collected, or deleted on its date (B-W2b-GF1, G274). */
export const packageHeld = (file: { readonly status: string } | null | undefined): 'NO_PACKAGE' | 'PACKAGE_DELETED' => (file?.status === 'DELETED' ? 'PACKAGE_DELETED' : 'NO_PACKAGE')

/** What may be done on the request now (each held with a code and its words). */
export function actionsOf(request: Pick<RequestRow, 'kind' | 'status' | 'dueAt' | 'extendedDueAt' | 'identityCheckedAt' | 'packageFileId'> & { readonly packageFile?: { readonly status: string } | null }, erasures: number, now: Date) {
  const actions = requestActions(
    {
      kind: request.kind as DataRequestKind,
      status: request.status as DataRequestStatus,
      dueAt: request.dueAt,
      extendedDueAt: request.extendedDueAt,
      identityCheckedAt: request.identityCheckedAt,
      packageFileId: request.packageFileId,
      // B-W2b-GF1 (G274): a package deleted on its date is no package to hand over (the database refuses DONE without one).
      packageDeleted: request.packageFile?.status === 'DELETED',
      erasures,
    },
    now,
  )
  return Object.fromEntries(Object.entries(actions).map(([key, action]) => [key, actionView(action)])) as { [Key in keyof typeof actions]: ReturnType<typeof actionView> }
}

async function namesOf(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  const users = await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })
  return new Map(users.map((user) => [user.id, user.displayName]))
}

async function collectStateOf(db: Reader, request: RequestRow) {
  if (request.kind !== 'ACCESS') return null
  const rows = await db.auditLog.findMany({ where: { recordType: 'DataRequest', recordId: request.id, action: { in: Object.values(COLLECT_ACTIONS) } }, select: { action: true, at: true, reason: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: 1 })
  const last = rows[0]
  const asked = last?.action === COLLECT_ACTIONS.asked
  return {
    state: !last ? (request.packageFileId ? ('READY' as const) : ('NONE' as const)) : asked ? ('RUNNING' as const) : last.action === COLLECT_ACTIONS.ready ? ('READY' as const) : ('FAILED' as const),
    at: last ? toUtcIso(last.at) : null,
    failure: last?.action === COLLECT_ACTIONS.failed ? (last.reason ?? null) : null,
  }
}

/** One request as the screens show it (the person by name, the clock, the package, what an erasure did, the actions). */
export async function requestViewOf(db: Reader, request: RequestRow, now: Date, names?: ReadonlyMap<string, string>) {
  const person = await personFacts(db, request.personKind as DataSubjectKind, request.personRecordType, request.personRecordId)
  const people = names ?? (await namesOf(db, [request.identityCheckedById, request.decidedById]))
  const erasures = request.kind === 'ERASURE' ? await db.erasureRecord.groupBy({ by: ['method'], where: { dataRequestId: request.id }, _count: { _all: true } }) : []
  const countOf = (method: string) => erasures.find((row) => row.method === method)?._count._all ?? 0
  const erasureCount = countOf('ANONYMISED') + countOf('DELETED') + countOf('KEPT')
  const clock = clockOf(request, now)
  return {
    id: request.id,
    company: { id: request.company.id, code: request.company.code, name: request.company.tradeName ?? request.company.legalName },
    person: { kind: request.personKind, recordType: request.personRecordType, recordId: request.personRecordId, name: person?.name ?? ERASED_PERSON_WORDS.en, erased: person?.erased ?? true },
    kind: request.kind,
    receivedAt: toUtcIso(request.receivedAt),
    dueAt: toUtcIso(clock.dueAt),
    originalDueAt: toUtcIso(request.dueAt),
    extended: clock.extended,
    extensionReason: request.extensionReason,
    overdue: clock.overdue,
    hoursLeft: clock.hoursLeft,
    note: request.note,
    identityCheckedAt: request.identityCheckedAt ? toUtcIso(request.identityCheckedAt) : null,
    identityCheckedBy: request.identityCheckedById ? { id: request.identityCheckedById, name: people.get(request.identityCheckedById) ?? '' } : null,
    status: request.status,
    decidedAt: request.decidedAt ? toUtcIso(request.decidedAt) : null,
    decidedBy: request.decidedById ? { id: request.decidedById, name: people.get(request.decidedById) ?? '' } : null,
    refusalReason: request.refusalReason,
    package:
      request.packageFile && request.packageFile.status === 'AVAILABLE'
        ? {
            fileId: request.packageFile.id,
            name: request.packageFile.originalName,
            sizeBytes: request.packageFile.sizeBytes,
            sha256: request.packageFile.sha256,
            madeAt: request.packageFile.availableAt ? toUtcIso(request.packageFile.availableAt) : null,
            // B-W2b-GF1 (G274): when the package goes (privacy.purgePackages).
            deleteAfter: request.packageFile.deleteAfter ? toUtcIso(request.packageFile.deleteAfter) : null,
          }
        : null,
    collect: await collectStateOf(db, request),
    erasure: request.kind === 'ERASURE' ? { records: erasureCount, anonymised: countOf('ANONYMISED'), deleted: countOf('DELETED'), kept: countOf('KEPT') } : null,
    version: request.version,
    actions: actionsOf(request, erasureCount, now),
  }
}
export type RequestView = Awaited<ReturnType<typeof requestViewOf>>

/** The request, when the caller may know it (404) and do `permission` on it (403). */
export async function readRequest(caller: CommandCaller, requestId: string, permission: Permission): Promise<{ context: OfficeContext; request: RequestRow }> {
  const context = officeOf(caller)
  const request = isUuid(requestId) ? await caller.withClient((client) => client.dataRequest.findUnique({ where: { id: requestId }, select: REQUEST_SELECT })) : null
  if (!request) throw new NotFoundError('Data request not found.')
  // The person's request is known with privacy.requests.view (not privacy.view: it names a person).
  assertMayRequest(context, permission, request.companyId)
  return { context, request }
}

export function assertMayRequest(context: OfficeContext, permission: Permission, companyId: string): void {
  if (!mayOn(context, PRIVACY_REQUESTS_VIEW, companyId)) throw new NotFoundError('Data request not found.')
  if (!mayOn(context, permission, companyId)) throw new ForbiddenError()
}

/** The answer after a write: the request as it is now. */
export async function requestAnswer(caller: CommandCaller, requestId: string, now: Date): Promise<RequestView> {
  return caller.withClient(async (client) => requestViewOf(client, await client.dataRequest.findUniqueOrThrow({ where: { id: requestId }, select: REQUEST_SELECT }), now))
}

export interface ListQuery {
  readonly companyId?: string | undefined
  readonly view?: 'open' | 'closed' | 'all' | undefined
  readonly kind?: DataRequestKind | undefined
  readonly personKind?: DataSubjectKind | undefined
}

/** GET /privacy/requests: open first by their due time (the countdown), then closed newest first; at most 200. */
export async function listRequests(caller: CommandCaller, query: ListQuery, now: Date) {
  const context = officeOf(caller)
  const view = query.view ?? 'open'
  const visible = scopeWhere(actorOf(context), PRIVACY_REQUESTS_VIEW, { company: 'companyId' }) as Prisma.DataRequestWhereInput
  const where: Prisma.DataRequestWhereInput = {
    AND: [
      visible,
      query.companyId ? { companyId: query.companyId } : {},
      view === 'open' ? { status: { in: [...OPEN_REQUEST_STATUSES] } } : view === 'closed' ? { status: { notIn: [...OPEN_REQUEST_STATUSES] } } : {},
      query.kind ? { kind: query.kind } : {},
      query.personKind ? { personKind: query.personKind } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.dataRequest.findMany({ where, select: REQUEST_SELECT, orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], take: 200 })
    const open = rows.filter((row) => (OPEN_REQUEST_STATUSES as readonly string[]).includes(row.status))
    const closed = rows.filter((row) => !(OPEN_REQUEST_STATUSES as readonly string[]).includes(row.status)).sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0))
    open.sort((a, b) => (a.extendedDueAt ?? a.dueAt).getTime() - (b.extendedDueAt ?? b.dueAt).getTime())
    const names = await namesOf(client, rows.flatMap((row) => [row.identityCheckedById, row.decidedById]))
    const requests = []
    for (const row of [...open, ...closed]) requests.push(await requestViewOf(client, row, now, names))
    const counts = await client.dataRequest.findMany({ where: { AND: [visible, query.companyId ? { companyId: query.companyId } : {}, { status: { in: [...OPEN_REQUEST_STATUSES] } }] }, select: { dueAt: true, extendedDueAt: true } })
    const overdue = counts.filter((row) => (row.extendedDueAt ?? row.dueAt).getTime() < now.getTime()).length
    return { requests, counts: { open: counts.length, overdue } }
  })
}
