import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { PORTAL_APPROVE, PORTAL_COMMENT, PORTAL_UPLOAD } from '@nexus/factory-domain/auth/partners/permissions'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { linkState } from '@nexus/factory-domain/links/purposes'
import {
  DECLINE_REASON_WORDS,
  DECLINE_REASONS,
  JOB_CHIP_WORDS,
  JOB_CHIPS,
  JOB_STATE_WORDS,
  jobActsOf,
  jobChipOf,
  jobStateOf,
  materialBackOf,
  NEXT_STEP_WORDS,
  nextStepOf,
  readyOf,
  announceableOf,
  receivePrefillOf,
  returnQuantitiesOf,
  SCRAP_REASONS,
  type JobChip,
  type JobFacts,
  type Locale,
} from '@nexus/factory-domain/purchasing/portal-jobs/jobs'
import type { KitLineStatus, SubcontractOrderStatus } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import { actorOf, requireContext } from '../../../core/context'
import { portalSessionOf, type PortalSession } from '../../../platform/auth/portal/authenticator'
import { systemCallerOf } from '../../../platform/files/files'
import { dayOf, quantityText, type Reader } from '../store'
import { readWorkOrderFacts, sizesOf } from '../subcontracting/store'

/**
 * Subcontractor jobs, read (B-W2b-176; SCM-154 job list and record; design portal.supplier.jobs, links.job,
 * purchasing.subcontracting › Kit "received by the workshop"). Two readers, as the supplier's orders (B-W2b-174):
 *
 *   own      the caller's own scope: a portal or link session (factory_partner_runtime: the workshop's own party, the
 *            partner role's column grants — no fee, amount, internal note or office person) reads the order, its kit lines,
 *            its progress reports and return notices; the office reads the same with its client. Another party's order is
 *            as unknown as a wrong id (404).
 *   system   the tenant's system scope, for THIS order only, after `own` found it: what the partner role may not read but
 *            the job sheet says anyway — the operations (code, name, pieces per size, sent and back; never the fee), the
 *            work order's number and style, the cells' colourway and size, the bundles that went out, the items, colours,
 *            lots and hides of the kit, our kit DDTs, the buying company's name, who of ours entered an answer (yes or no).
 *
 * Nothing here is money (Owner answer C2). Words for the workshop are its locale's (it/en).
 */

const LIST_MAX = 300
const iso = (value: Date | null): string | null => (value === null ? null : toUtcIso(value))
const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [...new Set(values.filter((value): value is T => value !== null && value !== undefined))]

export const localeOf = (value: string | null | undefined): Locale => (value === 'en' ? 'en' : 'it')

/** The order's columns a partner may read (the policies hide the rest; selecting one of them would fail). */
export const JOB_ORDER_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  partyId: true,
  workOrderId: true,
  status: true,
  orderDate: true,
  expectedBackDate: true,
  note: true,
  issuedAt: true,
  closedAt: true,
  cancelledAt: true,
  acceptedAt: true,
  acceptedByName: true,
  proposedDate: true,
  proposedDateReason: true,
  declinedAt: true,
  declinedByName: true,
  declineReason: true,
  proposedDateDecision: true,
  proposedDateDecidedAt: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.SubcontractOrderSelect
export type JobOrderRow = Prisma.SubcontractOrderGetPayload<{ select: typeof JOB_ORDER_COLUMNS }>

export const JOB_KIT_COLUMNS = {
  id: true,
  seq: true,
  itemId: true,
  itemColourId: true,
  lotId: true,
  hideId: true,
  quantity: true,
  uom: true,
  status: true,
  sentAt: true,
  ddtId: true,
  note: true,
  receivedByWorkshopAt: true,
  receivedByWorkshopQuantity: true,
  receivedByWorkshopNote: true,
} as const satisfies Prisma.SubcontractKitLineSelect
export type JobKitRow = Prisma.SubcontractKitLineGetPayload<{ select: typeof JOB_KIT_COLUMNS }>

const REPORT_COLUMNS = {
  id: true,
  subcontractOperationId: true,
  bundleId: true,
  workOrderSizeId: true,
  finishedQuantity: true,
  finishBy: true,
  reportedAt: true,
  reportedByName: true,
  note: true,
} as const satisfies Prisma.SubcontractProgressReportSelect
export type ReportRow = Prisma.SubcontractProgressReportGetPayload<{ select: typeof REPORT_COLUMNS }>

const NOTICE_COLUMNS = {
  id: true,
  seq: true,
  status: true,
  quantities: true,
  materialBack: true,
  parcels: true,
  expectedDate: true,
  weCollect: true,
  workshopDdtNumber: true,
  workshopDdtDate: true,
  announcedByName: true,
  note: true,
  receiptId: true,
  receivedAt: true,
  cancelledAt: true,
  cancelReason: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.SubcontractReturnNoticeSelect
export type NoticeRow = Prisma.SubcontractReturnNoticeGetPayload<{ select: typeof NOTICE_COLUMNS }>

/** What the caller's own scope reads of one job. */
export interface JobRows {
  readonly order: JobOrderRow
  readonly kit: readonly JobKitRow[]
  readonly reports: readonly ReportRow[]
  readonly notices: readonly NoticeRow[]
}

/** The order in the caller's scope, or null. */
export const readJobOrder = (own: Reader, orderId: string): Promise<JobOrderRow | null> =>
  isUuid(orderId) ? own.subcontractOrder.findUnique({ where: { id: orderId }, select: JOB_ORDER_COLUMNS }) : Promise.resolve(null)

export async function readJobRows(own: Reader, order: JobOrderRow): Promise<JobRows> {
  const kit = await own.subcontractKitLine.findMany({ where: { subcontractOrderId: order.id }, orderBy: { seq: 'asc' }, select: JOB_KIT_COLUMNS })
  const reports = await own.subcontractProgressReport.findMany({ where: { subcontractOrderId: order.id }, orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }], select: REPORT_COLUMNS })
  const notices = await own.subcontractReturnNotice.findMany({ where: { subcontractOrderId: order.id }, orderBy: { seq: 'asc' }, select: NOTICE_COLUMNS })
  return { order, kit, reports, notices }
}

/** The operations' counts the workshop may know (never the fee): read in the system scope (or the office's). */
const OPERATION_COLUMNS = {
  id: true,
  seq: true,
  workOrderOperationId: true,
  pieces: true,
  sizes: true,
  expectedBackDate: true,
  piecesSent: true,
  piecesBackGood: true,
  piecesBackDefective: true,
  piecesScrapped: true,
  note: true,
} as const satisfies Prisma.SubcontractOperationSelect
type OperationRow = Prisma.SubcontractOperationGetPayload<{ select: typeof OPERATION_COLUMNS }>

/** What the system scope adds for one job. */
export interface JobContext {
  readonly operations: readonly OperationRow[]
  readonly workOrder: { readonly number: string; readonly style: { readonly code: string; readonly name: string } }
  readonly cells: ReadonlyMap<string, { readonly colourway: string; readonly size: string }>
  readonly operationNames: ReadonlyMap<string, { readonly code: string; readonly name: string }>
  readonly bundles: readonly { readonly id: string; readonly code: string; readonly workOrderSizeId: string | null; readonly quantity: number; readonly sentAt: Date }[]
  readonly items: ReadonlyMap<string, { readonly code: string; readonly name: string }>
  readonly colours: ReadonlyMap<string, string>
  readonly lots: ReadonlyMap<string, string>
  readonly hides: ReadonlyMap<string, string>
  readonly ddts: ReadonlyMap<string, { readonly number: string; readonly date: string | null; readonly cancelled: boolean }>
  readonly companyName: string
  /** Rows the office entered for the workshop (createdById set): their ids. */
  readonly byOffice: ReadonlySet<string>
  readonly photos: ReadonlyMap<string, { readonly id: string; readonly originalName: string; readonly createdAt: string }[]>
}

export async function readJobContext(system: Reader, rows: JobRows, photoParty: string | null): Promise<JobContext> {
  const { order } = rows
  const operations = await system.subcontractOperation.findMany({ where: { subcontractOrderId: order.id }, orderBy: { seq: 'asc' }, select: OPERATION_COLUMNS })
  const workOrder = await readWorkOrderFacts(system, order.workOrderId)
  const cells = new Map((workOrder?.cells ?? []).map((cell) => [cell.id, { colourway: cell.colourway, size: cell.size }]))
  const operationNames = new Map((workOrder?.operations ?? []).map((operation) => [operation.id, { code: operation.code, name: operation.name }]))
  const sent = await system.subcontractBundle.findMany({ where: { subcontractOrderId: order.id }, orderBy: { sentAt: 'asc' }, select: { bundleId: true, quantity: true, sentAt: true } })
  const bundleRows = await system.bundle.findMany({ where: { id: { in: unique(sent.map((row) => row.bundleId)) } }, select: { id: true, code: true, workOrderSizeId: true } })
  const bundleOf = new Map(bundleRows.map((row) => [row.id, row]))
  const items = await system.item.findMany({ where: { id: { in: unique(rows.kit.map((line) => line.itemId)) } }, select: { id: true, code: true, name: true } })
  const colours = await system.itemColour.findMany({ where: { id: { in: unique(rows.kit.map((line) => line.itemColourId)) } }, select: { id: true, name: true } })
  const lots = await system.lot.findMany({ where: { id: { in: unique(rows.kit.map((line) => line.lotId)) } }, select: { id: true, code: true } })
  const hides = await system.hide.findMany({ where: { id: { in: unique(rows.kit.map((line) => line.hideId)) } }, select: { id: true, code: true } })
  const ddts = await system.ddt.findMany({ where: { id: { in: unique(rows.kit.map((line) => line.ddtId)) } }, select: { id: true, number: true, documentDate: true, cancellations: { select: { id: true }, take: 1 } } })
  const company = await system.company.findUnique({ where: { id: order.companyId }, select: { legalName: true, tradeName: true } })
  const entered = [
    ...(await system.subcontractProgressReport.findMany({ where: { subcontractOrderId: order.id, createdById: { not: null } }, select: { id: true } })),
    ...(await system.subcontractReturnNotice.findMany({ where: { subcontractOrderId: order.id, createdById: { not: null } }, select: { id: true } })),
  ]
  const files = await system.storedFile.findMany({
    where: { recordType: 'SubcontractKitLine', recordId: { in: rows.kit.map((line) => line.id) }, status: 'AVAILABLE', ...(photoParty ? { partyId: photoParty } : {}) },
    orderBy: { createdAt: 'asc' },
    select: { id: true, recordId: true, originalName: true, createdAt: true },
  })
  const photos = new Map<string, { id: string; originalName: string; createdAt: string }[]>()
  for (const file of files) photos.set(file.recordId, [...(photos.get(file.recordId) ?? []), { id: file.id, originalName: file.originalName, createdAt: toUtcIso(file.createdAt) }])
  return {
    operations,
    workOrder: { number: workOrder?.number ?? '', style: { code: workOrder?.style.code ?? '', name: workOrder?.style.name ?? '' } },
    cells,
    operationNames,
    bundles: sent.map((row) => ({ id: row.bundleId, code: bundleOf.get(row.bundleId)?.code ?? '', workOrderSizeId: bundleOf.get(row.bundleId)?.workOrderSizeId ?? null, quantity: row.quantity, sentAt: row.sentAt })),
    items: new Map(items.map((row) => [row.id, { code: row.code, name: row.name }])),
    colours: new Map(colours.map((row) => [row.id, row.name])),
    lots: new Map(lots.map((row) => [row.id, row.code])),
    hides: new Map(hides.map((row) => [row.id, row.code])),
    ddts: new Map(ddts.map((row) => [row.id, { number: row.number, date: dayOf(row.documentDate), cancelled: row.cancellations.length > 0 }])),
    companyName: company ? (company.tradeName ?? company.legalName) : '',
    byOffice: new Set(entered.map((row) => row.id)),
    photos,
  }
}

// ---- the facts and the counts --------------------------------------------------------------------------------------------

const announcedOf = (notices: readonly Pick<NoticeRow, 'status' | 'quantities'>[], operationId: string): number =>
  notices
    .filter((notice) => notice.status === 'ANNOUNCED')
    .flatMap((notice) => returnQuantitiesOf(notice.quantities))
    .filter((row) => row.subcontractOperationId === operationId)
    .reduce((sum, row) => sum + row.finished + row.scrapped, 0)

const finishedOf = (reports: readonly Pick<ReportRow, 'subcontractOperationId' | 'finishedQuantity'>[], operationId: string): number =>
  reports.filter((row) => row.subcontractOperationId === operationId).reduce((sum, row) => sum + row.finishedQuantity, 0)

/** What the facts of a job need of its rows (the list reads no more). */
export interface FactRows {
  readonly order: Pick<JobOrderRow, 'status' | 'acceptedAt' | 'declinedAt'>
  readonly kit: readonly Pick<JobKitRow, 'status' | 'receivedByWorkshopAt'>[]
  readonly reports: readonly Pick<ReportRow, 'subcontractOperationId' | 'finishedQuantity'>[]
  readonly notices: readonly Pick<NoticeRow, 'status' | 'quantities'>[]
}

export function operationCounts(operation: Pick<OperationRow, 'id' | 'pieces' | 'piecesSent' | 'piecesBackGood' | 'piecesBackDefective' | 'piecesScrapped'>, rows: Pick<FactRows, 'reports' | 'notices'>) {
  return {
    pieces: operation.pieces,
    piecesSent: operation.piecesSent,
    piecesBackGood: operation.piecesBackGood,
    piecesBackDefective: operation.piecesBackDefective,
    piecesScrapped: operation.piecesScrapped,
    finished: finishedOf(rows.reports, operation.id),
    announced: announcedOf(rows.notices, operation.id),
  }
}

export function jobFactsOf(rows: FactRows, operations: readonly Pick<OperationRow, 'id' | 'pieces' | 'piecesSent' | 'piecesBackGood' | 'piecesBackDefective' | 'piecesScrapped'>[]): JobFacts {
  return {
    status: rows.order.status as SubcontractOrderStatus,
    accepted: rows.order.acceptedAt !== null,
    declined: rows.order.declinedAt !== null,
    kitLines: rows.kit.map((line) => ({ status: line.status as KitLineStatus, checked: line.receivedByWorkshopAt !== null })),
    operations: operations.map((operation) => operationCounts(operation, rows)),
  }
}

// ---- the job --------------------------------------------------------------------------------------------------------------

const cellWords = (context: JobContext, cellId: string | null) => {
  const cell = cellId ? context.cells.get(cellId) : undefined
  return cell ? { workOrderSizeId: cellId, colourway: cell.colourway, size: cell.size } : { workOrderSizeId: cellId, colourway: '', size: '' }
}

/** The job as the workshop reads it (the office reads the same, with what it may add): no fee, no amount. */
export function jobView(rows: JobRows, context: JobContext, locale: Locale) {
  const { order } = rows
  const facts = jobFactsOf(rows, context.operations)
  const state = jobStateOf(facts)
  const chip = jobChipOf(facts)
  const nextStep = nextStepOf(facts)
  const acts = jobActsOf(facts)
  const words = (value: { it: string; en: string } | null) => (value === null ? null : value[locale])
  const bundleOf = new Map(context.bundles.map((bundle) => [bundle.id, bundle]))
  const operationOf = new Map(context.operations.map((operation) => [operation.id, operation]))
  const lastFinishBy = [...rows.reports].reverse().find((report) => report.finishBy !== null)?.finishBy ?? null
  const kitDays = unique(rows.kit.map((line) => (line.sentAt ? businessDate(line.sentAt) : null))).sort()
  return {
    id: order.id,
    number: order.number,
    status: order.status as SubcontractOrderStatus,
    state,
    stateWords: JOB_STATE_WORDS[state][locale],
    chip,
    nextStep,
    nextStepWords: NEXT_STEP_WORDS[nextStep][locale],
    from: { companyName: context.companyName },
    workOrder: context.workOrder,
    orderDate: dayOf(order.orderDate)!,
    expectedBackDate: dayOf(order.expectedBackDate),
    issuedAt: iso(order.issuedAt),
    /** The note for the workshop (printed on the job sheet). */
    note: order.note,
    answer: {
      acceptedAt: iso(order.acceptedAt),
      acceptedByName: order.acceptedByName,
      proposedDate: dayOf(order.proposedDate),
      proposedDateReason: order.proposedDateReason,
      declinedAt: iso(order.declinedAt),
      declinedByName: order.declinedByName,
      declineReason: order.declineReason,
      /** Our answer to the date it proposed. */
      dateDecision: order.proposedDateDecision === null ? null : { decision: order.proposedDateDecision, at: iso(order.proposedDateDecidedAt)! },
    },
    operations: context.operations.map((operation) => {
      const counts = operationCounts(operation, rows)
      const name = context.operationNames.get(operation.workOrderOperationId)
      const cells = sizesOf(operation.sizes)
      return {
        id: operation.id,
        seq: operation.seq,
        code: name?.code ?? '',
        name: name?.name ?? '',
        pieces: operation.pieces,
        sizes: cells.map((size) => ({
          ...cellWords(context, size.workOrderSizeId),
          workOrderSizeId: size.workOrderSizeId,
          pieces: size.pieces,
          finished: rows.reports.filter((report) => report.subcontractOperationId === operation.id && report.workOrderSizeId === size.workOrderSizeId).reduce((sum, report) => sum + report.finishedQuantity, 0),
        })),
        expectedBackDate: dayOf(operation.expectedBackDate),
        piecesSent: operation.piecesSent,
        back: { good: operation.piecesBackGood, defective: operation.piecesBackDefective, scrapped: operation.piecesScrapped },
        finished: counts.finished,
        announced: counts.announced,
        ready: readyOf(counts),
        announceable: announceableOf(counts),
        note: operation.note,
      }
    }),
    bundles: context.bundles.map((bundle) => ({ id: bundle.id, code: bundle.code, ...cellWords(context, bundle.workOrderSizeId), quantity: bundle.quantity, sentAt: toUtcIso(bundle.sentAt) })),
    kit: {
      sentOn: kitDays,
      toConfirm: facts.kitLines.filter((line) => line.status === 'SENT' && !line.checked).length,
      lines: rows.kit
        .filter((line) => line.status !== 'CANCELLED')
        .map((line) => {
          const item = context.items.get(line.itemId)
          const ddt = line.ddtId ? context.ddts.get(line.ddtId) : undefined
          const check = line.receivedByWorkshopAt
            ? { at: toUtcIso(line.receivedByWorkshopAt), quantity: quantityText(line.receivedByWorkshopQuantity!), note: line.receivedByWorkshopNote, short: line.receivedByWorkshopQuantity!.lessThan(line.quantity) }
            : null
          return {
            id: line.id,
            seq: line.seq,
            item: { code: item?.code ?? '', name: item?.name ?? '' },
            colour: line.itemColourId ? (context.colours.get(line.itemColourId) ?? '') : null,
            lot: line.lotId ? (context.lots.get(line.lotId) ?? '') : null,
            hide: line.hideId ? (context.hides.get(line.hideId) ?? '') : null,
            quantity: quantityText(line.quantity),
            uom: line.uom,
            status: line.status as KitLineStatus,
            sentAt: iso(line.sentAt),
            ddt: ddt && !ddt.cancelled ? { number: ddt.number, date: ddt.date } : null,
            check,
            photos: context.photos.get(line.id) ?? [],
          }
        }),
    },
    finishBy: dayOf(lastFinishBy),
    reports: rows.reports.map((report) => {
      const operation = operationOf.get(report.subcontractOperationId)
      const bundle = report.bundleId ? bundleOf.get(report.bundleId) : undefined
      return {
        id: report.id,
        at: toUtcIso(report.reportedAt),
        operationId: report.subcontractOperationId,
        operationSeq: operation?.seq ?? 0,
        ...cellWords(context, report.workOrderSizeId),
        bundle: report.bundleId ? { id: report.bundleId, code: bundle?.code ?? '' } : null,
        finished: report.finishedQuantity,
        finishBy: dayOf(report.finishBy),
        byName: report.reportedByName,
        byOffice: context.byOffice.has(report.id),
        note: report.note,
      }
    }),
    returns: rows.notices.map((notice) => {
      const quantities = returnQuantitiesOf(notice.quantities)
      return {
        id: notice.id,
        seq: notice.seq,
        status: notice.status,
        expectedDate: dayOf(notice.expectedDate)!,
        parcels: notice.parcels,
        weCollect: notice.weCollect,
        ddt: notice.workshopDdtNumber === null ? null : { number: notice.workshopDdtNumber, date: dayOf(notice.workshopDdtDate) },
        pieces: quantities.reduce((sum, row) => sum + row.finished + row.scrapped, 0),
        quantities: quantities.map((row) => ({
          operationId: row.subcontractOperationId,
          operationSeq: operationOf.get(row.subcontractOperationId)?.seq ?? 0,
          ...cellWords(context, row.workOrderSizeId),
          bundle: row.bundleId ? { id: row.bundleId, code: bundleOf.get(row.bundleId)?.code ?? '' } : null,
          finished: row.finished,
          scrapped: row.scrapped,
          reasonCode: row.reasonCode ?? null,
        })),
        materialBack: materialBackOf(notice.materialBack).map((row) => {
          const line = rows.kit.find((kit) => kit.id === row.kitLineId)
          const item = line ? context.items.get(line.itemId) : undefined
          return { kitLineId: row.kitLineId, seq: line?.seq ?? 0, item: { code: item?.code ?? '', name: item?.name ?? '' }, quantity: row.quantity, uom: line?.uom ?? null }
        }),
        byName: notice.announcedByName,
        byOffice: context.byOffice.has(notice.id),
        note: notice.note,
        announcedAt: toUtcIso(notice.createdAt),
        receivedAt: iso(notice.receivedAt),
        cancelledAt: iso(notice.cancelledAt),
        cancelReason: notice.cancelReason,
        version: notice.version,
      }
    }),
    acts: { accept: words(acts.accept), decline: words(acts.decline), kit: words(acts.kit), progress: words(acts.progress), sendBack: words(acts.sendBack) },
    choices: {
      declineReasons: DECLINE_REASONS.map((reason) => ({ code: reason, words: DECLINE_REASON_WORDS[reason][locale] })),
      scrapReasons: SCRAP_REASONS.map((reason) => ({ code: reason.code, words: reason.words[locale] })),
    },
    version: order.version,
  }
}
export type JobView = ReturnType<typeof jobView>

// ---- the portal ------------------------------------------------------------------------------------------------------------

/** The events after which a portal page of jobs reads again (the partner's live channel). */
export const PORTAL_JOB_EVENTS: string[] = [
  'subcontract_order.job_answered',
  'subcontract_order.date_decided',
  'subcontract_order.kit_checked',
  'subcontract_order.progress_reported',
  'subcontract_order.return_announced',
  'subcontract_order.return_cancelled',
  'partner_task.opened',
  'partner_task.closed',
]

export const systemOf = (request: FastifyRequest, tenantId: string) => systemCallerOf(request)(tenantId)

/** The jobs of the portal's company the workshop holds: sent to it (issued at least once and not back in draft). */
const heldWhere = (session: PortalSession): Prisma.SubcontractOrderWhereInput => ({ companyId: session.company.id, status: { not: 'DRAFT' }, issuedAt: { not: null } })

/** One job the workshop holds, in its own scope, or 404. */
export async function heldJob(own: Reader, session: PortalSession, orderId: string): Promise<JobOrderRow> {
  const order = isUuid(orderId) ? await own.subcontractOrder.findFirst({ where: { AND: [{ id: orderId }, heldWhere(session)] }, select: JOB_ORDER_COLUMNS }) : null
  if (!order) throw new NotFoundError('Job not found.')
  return order
}

/** What the person may do besides reading (the capabilities beside the role; an office preview never acts). */
export function mayActOf(request: FastifyRequest, session: PortalSession, order: { readonly companyId: string; readonly partyId: string }) {
  const actor = actorOf(requireContext(request))
  const holds = (permission: Permission) => !session.preview && can(actor, permission, { companyId: order.companyId, partyId: order.partyId })
  return { approve: holds(PORTAL_APPROVE), comment: holds(PORTAL_COMMENT), upload: holds(PORTAL_UPLOAD) }
}

/** GET /portal/jobs/:subcontractOrderId: the job record. */
export async function portalJob(request: FastifyRequest, orderId: string) {
  const session = portalSessionOf(request)
  const rows = await request.withClient(async (client) => readJobRows(client, await heldJob(client, session, orderId)))
  const context = await systemOf(request, session.tenantId).withClient((client) => readJobContext(client, rows, session.partyId))
  return { job: jobView(rows, context, localeOf(session.person.locale)), mayAct: mayActOf(request, session, rows.order), live: { events: PORTAL_JOB_EVENTS } }
}

export interface PortalJobsQuery {
  readonly chip?: JobChip | undefined
  readonly q?: string | undefined
}

/** GET /portal/jobs: the chips with their counts and the job cards of one (no fee, no amount). */
export async function listPortalJobs(request: FastifyRequest, query: PortalJobsQuery, now: Date) {
  const session = portalSessionOf(request)
  const locale = localeOf(session.person.locale)
  const today = businessDate(now)
  const own = await request.withClient(async (client) => {
    const orders = await client.subcontractOrder.findMany({ where: heldWhere(session), orderBy: [{ issuedAt: 'desc' }, { number: 'desc' }], take: LIST_MAX + 1, select: JOB_ORDER_COLUMNS })
    const ids = orders.slice(0, LIST_MAX).map((order) => order.id)
    const kit = await client.subcontractKitLine.findMany({ where: { subcontractOrderId: { in: ids } }, select: { subcontractOrderId: true, status: true, sentAt: true, receivedByWorkshopAt: true } })
    const reports = await client.subcontractProgressReport.findMany({ where: { subcontractOrderId: { in: ids } }, select: { subcontractOrderId: true, subcontractOperationId: true, finishedQuantity: true } })
    const notices = await client.subcontractReturnNotice.findMany({ where: { subcontractOrderId: { in: ids } }, select: { subcontractOrderId: true, status: true, quantities: true } })
    return { orders, kit, reports, notices }
  })
  const page = own.orders.slice(0, LIST_MAX)
  const ids = page.map((order) => order.id)
  const system = await systemOf(request, session.tenantId).withClient(async (client) => {
    const operations = await client.subcontractOperation.findMany({ where: { subcontractOrderId: { in: ids } }, orderBy: { seq: 'asc' }, select: { ...OPERATION_COLUMNS, subcontractOrderId: true } })
    const workOrders = await client.workOrder.findMany({ where: { id: { in: unique(page.map((order) => order.workOrderId)) } }, select: { id: true, number: true, style: { select: { code: true, name: true } } } })
    const steps = await client.workOrderOperation.findMany({ where: { id: { in: unique(operations.map((operation) => operation.workOrderOperationId)) } }, select: { id: true, code: true, name: true } })
    return { operations, workOrders: new Map(workOrders.map((row) => [row.id, row])), steps: new Map(steps.map((row) => [row.id, row])) }
  })
  const text = query.q?.trim().toLowerCase() ?? ''
  const cards = page.map((order) => {
    const kit = own.kit.filter((line) => line.subcontractOrderId === order.id)
    const reports = own.reports.filter((row) => row.subcontractOrderId === order.id)
    const notices = own.notices.filter((row) => row.subcontractOrderId === order.id)
    const operations = system.operations.filter((row) => row.subcontractOrderId === order.id)
    const facts = jobFactsOf({ order, kit, reports, notices }, operations)
    const state = jobStateOf(facts)
    const chip = jobChipOf(facts)
    const nextStep = nextStepOf(facts)
    const workOrder = system.workOrders.get(order.workOrderId)
    const pieces = operations.reduce((sum, row) => sum + row.pieces, 0)
    const finished = Math.min(pieces, facts.operations.reduce((sum, row) => sum + row.finished, 0))
    const due = dayOf(order.proposedDateDecision === 'ACCEPTED' ? order.proposedDate : order.expectedBackDate)
    const kitDays = unique(kit.map((line) => (line.sentAt ? businessDate(line.sentAt) : null))).sort()
    return {
      id: order.id,
      number: order.number,
      status: order.status as SubcontractOrderStatus,
      state,
      stateWords: JOB_STATE_WORDS[state][locale],
      chip,
      nextStep,
      nextStepWords: NEXT_STEP_WORDS[nextStep][locale],
      operations: operations.map((row) => ({ seq: row.seq, code: system.steps.get(row.workOrderOperationId)?.code ?? '', name: system.steps.get(row.workOrderOperationId)?.name ?? '' })),
      workOrder: { number: workOrder?.number ?? '', style: { code: workOrder?.style.code ?? '', name: workOrder?.style.name ?? '' } },
      pieces,
      finished,
      kitDate: kitDays.at(-1) ?? null,
      dueBack: due,
      late: due !== null && due < today && chip !== 'DONE',
      proposedDate: dayOf(order.proposedDate),
      version: order.version,
    }
  })
  const found = text === '' ? cards : cards.filter((card) => [card.number, card.workOrder.number, card.workOrder.style.code, card.workOrder.style.name].some((value) => value.toLowerCase().includes(text)))
  const counts = new Map<JobChip, number>(JOB_CHIPS.map((chip) => [chip, 0]))
  for (const card of found) counts.set(card.chip, counts.get(card.chip)! + 1)
  // Default: the first chip with something to do, else every open job.
  const chip = query.chip ?? (['NEW', 'KIT', 'BACK', 'WORK'] as const).find((entry) => counts.get(entry)! > 0) ?? 'WORK'
  return {
    asOf: toUtcIso(now),
    chip,
    chips: JOB_CHIPS.map((entry) => ({ chip: entry, count: counts.get(entry)!, words: JOB_CHIP_WORDS[entry][locale] })),
    counts: { toAccept: counts.get('NEW')!, kitToConfirm: counts.get('KIT')!, readyToSendBack: counts.get('BACK')!, late: found.filter((card) => card.late).length },
    items: found.filter((card) => card.chip === chip),
    complete: own.orders.length <= LIST_MAX,
    live: { events: PORTAL_JOB_EVENTS },
  }
}

// ---- the office ------------------------------------------------------------------------------------------------------------

/** The job's JOB_ACCEPT links (office scope), oldest first, with their state now (never the token). */
export async function jobLinksOf(db: Reader, orderId: string, now: Date) {
  const rows = await db.oneOffLink.findMany({
    where: { recordType: 'SubcontractOrder', recordId: orderId, purpose: 'JOB_ACCEPT' },
    select: { id: true, email: true, expiresAt: true, uses: true, maxUses: true, lastUsedAt: true, revokedAt: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return rows.map((row) => ({ id: row.id, email: row.email, state: linkState(row, now), expiresAt: toUtcIso(row.expiresAt), usedAt: iso(row.lastUsedAt), createdAt: toUtcIso(row.createdAt) }))
}

/** The receive back prefilled from each ANNOUNCED notice, with the kit's material as it went out (the place is the office's). */
export function prefillsOf(rows: JobRows) {
  return rows.notices
    .filter((notice) => notice.status === 'ANNOUNCED')
    .map((notice) => {
      const base = receivePrefillOf({ quantities: returnQuantitiesOf(notice.quantities), workshopDdtNumber: notice.workshopDdtNumber, workshopDdtDate: dayOf(notice.workshopDdtDate) as BusinessDate | null })
      const returns = materialBackOf(notice.materialBack).flatMap((row) => {
        const line = rows.kit.find((kit) => kit.id === row.kitLineId)
        return line ? [{ kitLineId: line.id, itemId: line.itemId, itemColourId: line.itemColourId, lotId: line.lotId, hideId: line.hideId, quantity: row.quantity, uom: line.uom }] : []
      })
      return { returnNoticeId: notice.id, ...base, returns, note: notice.note }
    })
}
