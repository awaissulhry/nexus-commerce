import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PEOPLE_PIECERATES_MANAGE, PEOPLE_PIECERATES_VIEW } from '@nexus/factory-domain/people/piecerates/permissions'
import {
  CHANGE_REASON_WORDS,
  cancelRefusal,
  confirmRefusal,
  decimalText,
  editRefusal,
  inForceOn,
  inForcePlan,
  publishRefusal,
  readByOf,
  trialTiles,
  versionStateOf,
  type ChangeReason,
  type RateBasis,
  type VersionRefusal,
  type VersionRow,
  type VersionStatus,
} from '@nexus/factory-domain/people/piecerates/rates'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeOf, seesPay } from './access'
import type { VersionDetail } from './contract'
import { missingBySite } from './switch'

/**
 * The reads of piece rates (B-W2b-34; design people.piecerates "Tiles", "Rate table", the rate detail with who read it,
 * the "Publish rates" dialog). Office only, within the caller's grants (people.piecerates.view on the table's company
 * and site). Every rate is returned as `money.pay`; the grain filter drops it for a caller without the pay grain, and
 * `payShown` says so ("Pay figures are hidden for your role: operations and SMVs only"). A worker's name appears only
 * inside one version's record and the publish dialog (who it goes to, who has read it: c.c. art. 2101).
 */

export type Db = CommandTx

export const day = (value: Date | null): BusinessDate | null => (value ? value.toISOString().slice(0, 10) : null)
export const dateOf = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)
export const todayOf = (now: Date): BusinessDate => businessDate(now)

export const SITE_SELECT = { id: true, companyId: true, code: true, name: true } as const satisfies Prisma.SiteSelect
export type SiteRow = Prisma.SiteGetPayload<{ select: typeof SITE_SELECT }>

export const TABLE_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  code: true,
  name: true,
  styleId: true,
  lineId: true,
  currency: true,
  status: true,
  note: true,
  version: true,
} as const satisfies Prisma.PieceRateTableSelect
export type TableRow = Prisma.PieceRateTableGetPayload<{ select: typeof TABLE_SELECT }>

export const VERSION_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  tableId: true,
  versionNo: true,
  changeReason: true,
  changeNote: true,
  effectiveFrom: true,
  effectiveTo: true,
  provisional: true,
  trialEndsOn: true,
  status: true,
  confirmedAt: true,
  confirmedById: true,
  supersededAt: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  createdById: true,
  version: true,
} as const satisfies Prisma.PieceRateVersionSelect
export type VersionRecord = Prisma.PieceRateVersionGetPayload<{ select: typeof VERSION_SELECT }>

export const PUBLICATION_SELECT = {
  id: true,
  versionId: true,
  siteId: true,
  lineId: true,
  workerIds: true,
  onFloor: true,
  printed: true,
  status: true,
  publishedAt: true,
  publishedById: true,
  withdrawnAt: true,
  withdrawReason: true,
  version: true,
} as const satisfies Prisma.RatePublicationSelect
export type PublicationRow = Prisma.RatePublicationGetPayload<{ select: typeof PUBLICATION_SELECT }>

export const RATE_SELECT = {
  id: true,
  versionId: true,
  operationId: true,
  sizeBand: true,
  basis: true,
  standardMinutes: true,
  ratePerMinute: true,
  ratePerPiece: true,
  note: true,
} as const satisfies Prisma.PieceRateEntrySelect
export type RateRecord = Prisma.PieceRateEntryGetPayload<{ select: typeof RATE_SELECT }>

/** A version row as the domain rules read it. */
export const versionRowOf = (row: Pick<VersionRecord, 'id' | 'versionNo' | 'status' | 'effectiveFrom' | 'effectiveTo' | 'provisional' | 'trialEndsOn'>): VersionRow => ({
  id: row.id,
  versionNo: row.versionNo,
  status: row.status as VersionStatus,
  effectiveFrom: day(row.effectiveFrom)!,
  effectiveTo: day(row.effectiveTo),
  provisional: row.provisional,
  trialEndsOn: day(row.trialEndsOn),
})

const mayOn = (context: OfficeContext, permission: Permission, row: { companyId: string; siteId: string }): boolean => can(actorOf(context), permission, { companyId: row.companyId, siteId: row.siteId })

/** The site, when the caller may see its piece rates (else 404) and do `permission` there (else 403). */
export async function siteOf(caller: CommandCaller, siteId: string, permission: Permission): Promise<{ context: OfficeContext; site: SiteRow }> {
  const context = officeOf(caller)
  const site = isUuid(siteId) ? await caller.withClient((client) => client.site.findUnique({ where: { id: siteId }, select: SITE_SELECT })) : null
  if (!site || !mayOn(context, PEOPLE_PIECERATES_VIEW, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Site not found.')
  if (!mayOn(context, permission, { companyId: site.companyId, siteId: site.id })) throw new ForbiddenError()
  return { context, site }
}

/** The table, when the caller may see it (else 404) and do `permission` on it (else 403). */
export async function tableOf(caller: CommandCaller, tableId: string, permission: Permission): Promise<{ context: OfficeContext; table: TableRow }> {
  const context = officeOf(caller)
  const table = isUuid(tableId) ? await caller.withClient((client) => client.pieceRateTable.findUnique({ where: { id: tableId }, select: TABLE_SELECT })) : null
  if (!table || !mayOn(context, PEOPLE_PIECERATES_VIEW, table)) throw new NotFoundError('Piece-rate table not found.')
  if (!mayOn(context, permission, table)) throw new ForbiddenError()
  return { context, table }
}

/** The version and its table, when the caller may see them (else 404) and do `permission` (else 403). */
export async function versionOf(caller: CommandCaller, versionId: string, permission: Permission): Promise<{ context: OfficeContext; version: VersionRecord; table: TableRow }> {
  const context = officeOf(caller)
  const found = isUuid(versionId)
    ? await caller.withClient(async (client) => {
        const version = await client.pieceRateVersion.findUnique({ where: { id: versionId }, select: VERSION_SELECT })
        const table = version ? await client.pieceRateTable.findUnique({ where: { id: version.tableId }, select: TABLE_SELECT }) : null
        return version && table ? { version, table } : null
      })
    : null
  if (!found || !mayOn(context, PEOPLE_PIECERATES_VIEW, found.table)) throw new NotFoundError('Rate version not found.')
  if (!mayOn(context, permission, found.table)) throw new ForbiddenError()
  return { context, ...found }
}

const refsOf = async (db: Db, styleIds: readonly (string | null)[], lineIds: readonly (string | null)[]) => {
  const styles = await db.style.findMany({ where: { id: { in: [...new Set(styleIds.filter((value): value is string => value !== null))] } }, select: { id: true, code: true, name: true } })
  const lines = await db.line.findMany({ where: { id: { in: [...new Set(lineIds.filter((value): value is string => value !== null))] } }, select: { id: true, code: true, name: true } })
  return { styles: new Map(styles.map((row) => [row.id, row])), lines: new Map(lines.map((row) => [row.id, row])) }
}

/** The tables as answers show them (styles, lines and whether a version left DRAFT read once for all). */
export async function tableViews(db: Db, tables: readonly TableRow[]) {
  const { styles, lines } = await refsOf(
    db,
    tables.map((table) => table.styleId),
    tables.map((table) => table.lineId),
  )
  const fixedRows = tables.length === 0 ? [] : await db.pieceRateVersion.findMany({ where: { tableId: { in: tables.map((table) => table.id) }, status: { not: 'DRAFT' } }, select: { tableId: true }, distinct: ['tableId'] })
  const fixed = new Set(fixedRows.map((row) => row.tableId))
  return new Map(
    tables.map((table) => [
      table.id,
      {
        id: table.id,
        companyId: table.companyId,
        siteId: table.siteId,
        code: table.code,
        name: table.name,
        style: table.styleId ? (styles.get(table.styleId) ?? null) : null,
        line: table.lineId ? (lines.get(table.lineId) ?? null) : null,
        currency: table.currency,
        status: table.status as 'ACTIVE' | 'ARCHIVED',
        note: table.note,
        fixed: fixed.has(table.id),
        version: table.version,
      },
    ]),
  )
}

export type VersionSummary = ReturnType<typeof summaryOf>

function summaryOf(row: VersionRecord, facts: { rateCount: number; publishedOn: BusinessDate | null; readBy: { read: number; of: number } }, today: BusinessDate) {
  const rules = versionRowOf(row)
  const { state, words } = versionStateOf(rules, today)
  return {
    id: row.id,
    tableId: row.tableId,
    versionNo: row.versionNo,
    status: row.status as VersionStatus,
    state,
    stateWords: words,
    changeReason: row.changeReason as ChangeReason,
    changeReasonWords: CHANGE_REASON_WORDS[row.changeReason as ChangeReason],
    changeNote: row.changeNote,
    effectiveFrom: rules.effectiveFrom,
    effectiveTo: rules.effectiveTo,
    provisional: row.provisional,
    trialEndsOn: rules.trialEndsOn,
    inForceToday: inForceOn(rules, today),
    rateCount: facts.rateCount,
    publishedOn: facts.publishedOn,
    readBy: facts.readBy,
    version: row.version,
  }
}

/** The receipts of publications, one per worker and publication (the earliest), for "read by" and the AckTracker. */
async function receiptsOf(db: Db, publicationIds: readonly string[]) {
  if (publicationIds.length === 0) return []
  return db.rateAcknowledgement.findMany({
    where: { publicationId: { in: [...publicationIds] } },
    select: { publicationId: true, workerId: true, channel: true, serverTime: true },
    orderBy: [{ serverTime: 'asc' }, { id: 'asc' }],
  })
}

/** Each version's summary: rate count, first publication day, "read by n of m". */
export async function versionSummaries(db: Db, versions: readonly VersionRecord[], today: BusinessDate): Promise<Map<string, VersionSummary>> {
  if (versions.length === 0) return new Map()
  const ids = versions.map((row) => row.id)
  const counts = await db.pieceRateEntry.groupBy({ by: ['versionId'], where: { versionId: { in: ids } }, _count: { _all: true } })
  const countOf = new Map(counts.map((row) => [row.versionId, row._count._all]))
  const publications = await db.ratePublication.findMany({ where: { versionId: { in: ids } }, select: { id: true, versionId: true, status: true, workerIds: true, publishedAt: true } })
  const receipts = await receiptsOf(
    db,
    publications.map((row) => row.id),
  )
  const answer = new Map<string, VersionSummary>()
  for (const row of versions) {
    const own = publications.filter((publication) => publication.versionId === row.id)
    const live = own.filter((publication) => publication.status === 'PUBLISHED').map((publication) => businessDate(publication.publishedAt))
    const ownIds = new Set(own.map((publication) => publication.id))
    answer.set(
      row.id,
      summaryOf(
        row,
        {
          rateCount: countOf.get(row.id) ?? 0,
          publishedOn: live.length > 0 ? [...live].sort()[0]! : null,
          readBy: readByOf(
            own,
            receipts.filter((receipt) => ownIds.has(receipt.publicationId)),
          ),
        },
        today,
      ),
    )
  }
  return answer
}

const operationsOf = async (db: Db, operationIds: readonly string[]) => {
  const rows = operationIds.length === 0 ? [] : await db.operation.findMany({ where: { id: { in: [...new Set(operationIds)] } }, select: { id: true, code: true, name: true } })
  return new Map(rows.map((row) => [row.id, row]))
}

export const rateViewOf = (row: RateRecord, operation: { id: string; code: string; name: string } | undefined) => ({
  id: row.id,
  operation: operation ?? { id: row.operationId, code: '?', name: '?' },
  sizeBand: row.sizeBand,
  basis: row.basis as RateBasis,
  standardMinutes: row.standardMinutes === null ? null : decimalText(row.standardMinutes.toString()),
  ratePerMinute: asMoney('pay', row.ratePerMinute === null ? null : decimalText(row.ratePerMinute.toString())),
  ratePerPiece: asMoney('pay', decimalText(row.ratePerPiece.toString())),
  note: row.note,
})

const names = async (db: Db, userIds: readonly (string | null)[]) => {
  const ids = [...new Set(userIds.filter((value): value is string => value !== null))]
  const rows = ids.length === 0 ? [] : await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })
  return new Map(rows.map((row) => [row.id, row.displayName]))
}

const action = (refusal: VersionRefusal | null) => ({ allowed: refusal === null, refusal })

/** The publication days of a version's PUBLISHED publications (Europe/Rome), for putting it in force. */
export async function publishedDaysOf(db: Db, versionId: string): Promise<BusinessDate[]> {
  const rows = await db.ratePublication.findMany({ where: { versionId, status: 'PUBLISHED' }, select: { publishedAt: true } })
  return rows.map((row) => businessDate(row.publishedAt))
}

/** What putting a DRAFT in force needs now (the domain's plan, with the facts read here). */
export async function inForcePlanFor(db: Db, version: VersionRecord, table: Pick<TableRow, 'status'>, today: BusinessDate) {
  const rateCount = await db.pieceRateEntry.count({ where: { versionId: version.id } })
  const others = await db.pieceRateVersion.findMany({ where: { tableId: version.tableId, id: { not: version.id } }, select: VERSION_SELECT })
  return inForcePlan({ version: versionRowOf(version), today, rateCount, tableActive: table.status === 'ACTIVE', publishedOn: await publishedDaysOf(db, version.id), others: others.map(versionRowOf) })
}

/** One version's record: its rates, its publications with who has read them (AckTracker), and what may be done now. */
export async function versionDetailOf(db: Db, context: OfficeContext, versionId: string, now: Date): Promise<VersionDetail> {
  const today = todayOf(now)
  const version = (await db.pieceRateVersion.findUnique({ where: { id: versionId }, select: VERSION_SELECT }))!
  const table = (await db.pieceRateTable.findUnique({ where: { id: version.tableId }, select: TABLE_SELECT }))!
  const site = (await db.site.findUnique({ where: { id: table.siteId }, select: SITE_SELECT }))!
  const tableView = (await tableViews(db, [table])).get(table.id)!
  const summary = (await versionSummaries(db, [version], today)).get(version.id)!
  const rates = await db.pieceRateEntry.findMany({ where: { versionId }, select: RATE_SELECT, orderBy: [{ sizeBand: 'asc' }, { id: 'asc' }] })
  const operations = await operationsOf(
    db,
    rates.map((row) => row.operationId),
  )
  const publications = await db.ratePublication.findMany({ where: { versionId }, select: PUBLICATION_SELECT, orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }] })
  const receipts = await receiptsOf(
    db,
    publications.map((row) => row.id),
  )
  const workerIds = [...new Set(publications.flatMap((row) => row.workerIds))]
  const workers = workerIds.length === 0 ? [] : await db.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, displayName: true, employeeId: true } })
  const workerById = new Map(workers.map((row) => [row.id, row]))
  const lineIds = publications.map((row) => row.lineId)
  const { lines } = await refsOf(db, [], lineIds)
  const userNames = await names(db, [version.confirmedById, version.createdById, ...publications.map((row) => row.publishedById)])
  const plan = version.status === 'DRAFT' ? await inForcePlanFor(db, version, table, today) : null
  const rules = versionRowOf(version)
  const actor = actorOf(context)
  return {
    table: tableView,
    site,
    version: {
      ...summary,
      confirmedAt: version.confirmedAt ? toUtcIso(version.confirmedAt) : null,
      confirmedByName: version.confirmedById ? (userNames.get(version.confirmedById) ?? null) : null,
      supersededAt: version.supersededAt ? toUtcIso(version.supersededAt) : null,
      cancelledAt: version.cancelledAt ? toUtcIso(version.cancelledAt) : null,
      cancelReason: version.cancelReason,
      createdAt: toUtcIso(version.createdAt),
      createdByName: version.createdById ? (userNames.get(version.createdById) ?? null) : null,
    },
    rates: rates.map((row) => rateViewOf(row, operations.get(row.operationId))),
    publications: publications.map((publication) => {
      const own = receipts.filter((receipt) => receipt.publicationId === publication.id)
      const firstRead = new Map<string, { at: string; channel: 'DEVICE' | 'PAPER' }>()
      for (const receipt of own) if (!firstRead.has(receipt.workerId)) firstRead.set(receipt.workerId, { at: toUtcIso(receipt.serverTime), channel: receipt.channel as 'DEVICE' | 'PAPER' })
      return {
        id: publication.id,
        status: publication.status as 'PUBLISHED' | 'WITHDRAWN',
        line: publication.lineId ? (lines.get(publication.lineId) ?? null) : null,
        onFloor: publication.onFloor,
        printed: publication.printed,
        publishedAt: toUtcIso(publication.publishedAt),
        publishedByName: userNames.get(publication.publishedById) ?? null,
        withdrawnAt: publication.withdrawnAt ? toUtcIso(publication.withdrawnAt) : null,
        withdrawReason: publication.withdrawReason,
        workers: publication.workerIds.map((workerId) => ({
          workerId,
          name: workerById.get(workerId)?.displayName ?? '?',
          employeeId: workerById.get(workerId)?.employeeId ?? null,
          read: firstRead.get(workerId) ?? null,
        })),
        readBy: readByOf([publication], own),
        version: publication.version,
      }
    }),
    actions: {
      edit: action(editRefusal(rules)),
      publish: action(publishRefusal(rules)),
      putInForce: action(version.status === 'DRAFT' ? plan!.refusal : editRefusal(rules)),
      confirm: action(confirmRefusal(rules, today)),
      cancel: action(cancelRefusal(rules)),
    },
    payShown: seesPay(context),
    canManage: can(actor, PEOPLE_PIECERATES_MANAGE, { companyId: table.companyId, siteId: table.siteId }),
  }
}

/** One table's record: its versions, newest first. */
export async function tableDetailOf(db: Db, context: OfficeContext, tableId: string, now: Date) {
  const table = (await db.pieceRateTable.findUnique({ where: { id: tableId }, select: TABLE_SELECT }))!
  const site = (await db.site.findUnique({ where: { id: table.siteId }, select: SITE_SELECT }))!
  const versions = await db.pieceRateVersion.findMany({ where: { tableId }, select: VERSION_SELECT, orderBy: { versionNo: 'desc' } })
  const summaries = await versionSummaries(db, versions, todayOf(now))
  return {
    table: (await tableViews(db, [table])).get(table.id)!,
    site,
    versions: versions.map((row) => summaries.get(row.id)!),
    canManage: can(actorOf(context), PEOPLE_PIECERATES_MANAGE, { companyId: table.companyId, siteId: table.siteId }),
  }
}

// ---- routes ---------------------------------------------------------------------------------------------------------

const tableScope = (context: OfficeContext) => scopeWhere(actorOf(context), PEOPLE_PIECERATES_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.PieceRateTableWhereInput

/** people.piecerates.view: each site in reach with its switch and the tiles (provisional trials ending, unread, drafts). */
export async function overview(caller: CommandCaller, query: { companyId?: string | undefined; siteId?: string | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const today = todayOf(serverClock.now())
  return caller.withClient(async (client) => {
    const sites = await client.site.findMany({
      where: { AND: [scopeWhere(actor, PEOPLE_PIECERATES_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, query.companyId ? { companyId: query.companyId } : {}, query.siteId ? { id: query.siteId } : {}] },
      select: SITE_SELECT,
      orderBy: [{ companyId: 'asc' }, { code: 'asc' }],
    })
    const siteIds = sites.map((site) => site.id)
    const switches = siteIds.length === 0 ? [] : await client.piecePaySwitch.findMany({ where: { siteId: { in: siteIds } }, select: { siteId: true, state: true, onFrom: true, offFrom: true } })
    const switchOf = new Map(switches.map((row) => [row.siteId, row]))
    const versions = siteIds.length === 0 ? [] : await client.pieceRateVersion.findMany({ where: { siteId: { in: siteIds }, status: { in: ['DRAFT', 'PROVISIONAL', 'PUBLISHED', 'SUPERSEDED'] } }, select: VERSION_SELECT })
    const summaries = await versionSummaries(
      client,
      versions.filter((row) => row.status !== 'SUPERSEDED' || (row.effectiveTo !== null && day(row.effectiveTo)! >= today)),
      today,
    )
    const missing = await missingBySite(client, sites, today)
    return {
      today,
      payShown: seesPay(context),
      sites: sites.map((site) => {
        const own = versions.filter((row) => row.siteId === site.id)
        const live = own.filter((row) => row.status !== 'DRAFT' && summaries.has(row.id))
        const toggle = switchOf.get(site.id)
        const trials = trialTiles(own.map(versionRowOf), today)
        return {
          site,
          switch: { state: (toggle?.state ?? 'OFF') as 'OFF' | 'ON', onFrom: day(toggle?.onFrom ?? null), offFrom: day(toggle?.offFrom ?? null), missing: missing.get(site.id) ?? 0 },
          tiles: {
            trialEndingSoon: trials.endingSoon,
            trialEnded: trials.ended,
            unread: live.filter((row) => {
              const readBy = summaries.get(row.id)!.readBy
              return readBy.read < readBy.of
            }).length,
            drafts: own.filter((row) => row.status === 'DRAFT').length,
          },
        }
      }),
    }
  })
}

/** people.piecerates.view: the rate table of a site, one row per rate of the versions shown (grouped by style on screen). */
export async function rates(
  caller: CommandCaller,
  query: { siteId: string; tableId?: string | undefined; styleId?: string | undefined; view?: 'CURRENT' | 'ALL' | undefined; state?: string | undefined; q?: string | undefined; limit?: number | undefined },
) {
  const { context, site } = await siteOf(caller, query.siteId, PEOPLE_PIECERATES_VIEW)
  const today = todayOf(serverClock.now())
  const limit = query.limit ?? 1000
  return caller.withClient(async (client) => {
    const tables = await client.pieceRateTable.findMany({
      where: { AND: [tableScope(context), { siteId: site.id }, query.tableId ? { id: query.tableId } : {}, query.styleId ? { styleId: query.styleId } : {}] },
      select: TABLE_SELECT,
      orderBy: { code: 'asc' },
    })
    const views = await tableViews(client, tables)
    const tableIds = tables.map((table) => table.id)
    let versions = tableIds.length === 0 ? [] : await client.pieceRateVersion.findMany({ where: { tableId: { in: tableIds } }, select: VERSION_SELECT, orderBy: [{ tableId: 'asc' }, { versionNo: 'desc' }] })
    if ((query.view ?? 'CURRENT') === 'CURRENT') {
      versions = versions.filter((row) => {
        const rules = versionRowOf(row)
        return row.status === 'DRAFT' || inForceOn(rules, today) || (row.status !== 'CANCELLED' && rules.effectiveFrom > today)
      })
    }
    const summaries = await versionSummaries(client, versions, today)
    if (query.state) versions = versions.filter((row) => summaries.get(row.id)!.state === query.state)
    const entries = versions.length === 0 ? [] : await client.pieceRateEntry.findMany({ where: { versionId: { in: versions.map((row) => row.id) } }, select: RATE_SELECT, orderBy: [{ versionId: 'asc' }, { sizeBand: 'asc' }, { id: 'asc' }] })
    const operations = await operationsOf(
      client,
      entries.map((row) => row.operationId),
    )
    const needle = query.q?.trim().toLowerCase() ?? ''
    const versionById = new Map(versions.map((row) => [row.id, row]))
    const rows = []
    for (const entry of entries) {
      const version = versionById.get(entry.versionId)!
      const table = views.get(version.tableId)!
      const operation = operations.get(entry.operationId)
      if (needle !== '' && ![operation?.code, operation?.name, table.code, table.name, table.style?.code, table.style?.name].some((value) => value?.toLowerCase().includes(needle))) continue
      rows.push({ table: { id: table.id, code: table.code, name: table.name, currency: table.currency }, style: table.style, line: table.line, rate: rateViewOf(entry, operation), version: summaries.get(version.id)! })
    }
    rows.sort((a, b) => (a.style?.code ?? '').localeCompare(b.style?.code ?? '') || a.table.code.localeCompare(b.table.code) || a.rate.operation.code.localeCompare(b.rate.operation.code) || b.version.versionNo - a.version.versionNo)
    return { today, payShown: seesPay(context), rows: rows.slice(0, limit), complete: rows.length <= limit }
  })
}

/** people.piecerates.view: the tables in reach, each with the version in force today, the next one and its drafts. */
export async function tables(caller: CommandCaller, query: { siteId?: string | undefined; companyId?: string | undefined; includeArchived?: 'true' | 'false' | undefined }) {
  const context = officeOf(caller)
  const today = todayOf(serverClock.now())
  return caller.withClient(async (client) => {
    const rows = await client.pieceRateTable.findMany({
      where: { AND: [tableScope(context), query.siteId ? { siteId: query.siteId } : {}, query.companyId ? { companyId: query.companyId } : {}, query.includeArchived === 'true' ? {} : { status: 'ACTIVE' }] },
      select: TABLE_SELECT,
      orderBy: [{ siteId: 'asc' }, { code: 'asc' }],
    })
    const views = await tableViews(client, rows)
    const versions = rows.length === 0 ? [] : await client.pieceRateVersion.findMany({ where: { tableId: { in: rows.map((row) => row.id) }, status: { not: 'CANCELLED' } }, select: VERSION_SELECT })
    const summaries = await versionSummaries(client, versions, today)
    return {
      tables: rows.map((table) => {
        const own = versions.filter((row) => row.tableId === table.id)
        const current = own.find((row) => inForceOn(versionRowOf(row), today)) ?? null
        const next = own.filter((row) => row.status !== 'DRAFT' && row.status !== 'SUPERSEDED' && day(row.effectiveFrom)! > today).sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())[0] ?? null
        return { table: views.get(table.id)!, current: current ? summaries.get(current.id)! : null, next: next ? summaries.get(next.id)! : null, drafts: own.filter((row) => row.status === 'DRAFT').length }
      }),
    }
  })
}

export async function table(caller: CommandCaller, tableId: string) {
  const { context, table: row } = await tableOf(caller, tableId, PEOPLE_PIECERATES_VIEW)
  return caller.withClient((client) => tableDetailOf(client, context, row.id, serverClock.now()))
}

export async function version(caller: CommandCaller, versionId: string): Promise<VersionDetail> {
  const { context, version: row } = await versionOf(caller, versionId, PEOPLE_PIECERATES_VIEW)
  return caller.withClient((client) => versionDetailOf(client, context, row.id, serverClock.now()))
}

/** The workers a publication would go to: ACTIVE at the site (on a line: those whose home line it is). */
export async function audienceOf(db: Db, siteId: string, lineId: string | null) {
  const workers = await db.worker.findMany({ where: { siteId, status: 'ACTIVE' }, select: { id: true, displayName: true, employeeId: true }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }] })
  if (lineId === null) return workers
  const employeeIds = workers.map((row) => row.employeeId).filter((value): value is string => value !== null)
  const onLine = employeeIds.length === 0 ? [] : await db.employee.findMany({ where: { id: { in: employeeIds }, homeLineId: lineId }, select: { id: true } })
  const keep = new Set(onLine.map((row) => row.id))
  return workers.filter((row) => row.employeeId !== null && keep.has(row.employeeId))
}

/** The workers a version has been told to already (PUBLISHED publications). */
export async function toldOf(db: Db, versionId: string): Promise<Set<string>> {
  const rows = await db.ratePublication.findMany({ where: { versionId, status: 'PUBLISHED' }, select: { workerIds: true } })
  return new Set(rows.flatMap((row) => row.workerIds))
}

/** people.piecerates.manage: the "Publish rates" dialog: who it would go to (names inside this dialog only). */
export async function publishPreview(caller: CommandCaller, versionId: string, query: { lineId?: string | undefined }) {
  const { version: row, table: owner } = await versionOf(caller, versionId, PEOPLE_PIECERATES_MANAGE)
  return caller.withClient(async (client) => {
    const lineId = query.lineId ?? owner.lineId ?? null
    const line = lineId ? await client.line.findFirst({ where: { id: lineId, siteId: owner.siteId }, select: { id: true, code: true, name: true } }) : null
    if (lineId && !line) throw new NotFoundError('Line not found at this site.')
    const told = await toldOf(client, row.id)
    const workers = (await audienceOf(client, owner.siteId, lineId)).map((worker) => ({ workerId: worker.id, name: worker.displayName, employeeId: worker.employeeId, alreadyTold: told.has(worker.id) }))
    return {
      version: { id: row.id, versionNo: row.versionNo, status: row.status as VersionStatus },
      line,
      workers,
      count: workers.length,
      newCount: workers.filter((worker) => !worker.alreadyTold).length,
      withoutEmployee: workers.filter((worker) => worker.employeeId === null).length,
      refusal: publishRefusal(versionRowOf(row)),
    }
  })
}
