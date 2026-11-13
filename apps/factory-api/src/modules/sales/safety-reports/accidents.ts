import type { Prisma } from '@nexus/factory-db'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_SAFETY_LOG, SALES_SAFETY_VIEW } from '@nexus/factory-domain/sales/safety-reports/permissions'
import { ACCIDENT_LOG_RECORD, logStateOf, revisionProblems, SAFETY_LAW, SAFETY_LIMITS, type AccidentOutcome } from '@nexus/factory-domain/sales/safety-reports/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { refuse } from '../service/open'
import { LOG_WORDS, officeOf, officeReport } from './access'
import { asDay, dayOf, LOG_COLUMNS, lockReport, peopleOf, revisionsOf, revisionView, touchReport } from './store'
import { reportRecordOf, type ReportView } from './view'

/**
 * The accident log (B-W2b-351; SAL-423; GPSR, Reg. (EU) 2023/988 art. 20; design compliance.register "Accident log (W2b)",
 * B-W2b-357's screen): one entry per report, append-only (the database refuses an UPDATE, also to the owner): revision 1 records
 * the accident, a later revision corrects or completes it with why, or records when the market surveillance authority was told
 * (through the Safety Business Gateway), by whom, its reference and the authority notice sent (a SENT notice of the company).
 * The newest revision is the entry. Kept whether or not GPSR reaches PPE (the Owner's Q37). Never the injury's words.
 *
 *   GET  /sales/safety-reports/accident-log          the log: the newest revision per report, the accident's day first
 *   GET  /sales/safety-reports/:id/accident-log      every revision of one report, newest first
 *   POST /sales/safety-reports/:id/accident-log      a new revision (what it leaves out is the newest's)
 */

export interface LogQuery {
  readonly companyId?: string | undefined
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
  readonly outcome?: AccidentOutcome | undefined
  readonly told?: 'yes' | 'no' | undefined
  readonly limit?: number | undefined
}

const SCOPE = { company: 'companyId', party: { field: 'partyId', nullable: true } } as const

/** GET /sales/safety-reports/accident-log */
export async function accidentLog(caller: CommandCaller, query: LogQuery) {
  const context = officeOf(caller)
  const now = serverClock.now()
  const limit = Math.min(query.limit ?? SAFETY_LIMITS.list, SAFETY_LIMITS.list)
  if (query.from && query.to && query.from > query.to) throw new ValidationError('The period ends before it starts.', [{ path: 'querystring/to', message: 'On or after from.' }])
  return caller.withClient(async (client) => {
    const scope = scopeWhere(actorOf(context), SALES_SAFETY_VIEW, SCOPE) as Prisma.ProductSafetyReportWhereInput
    const rows = await client.accidentLogEntry.findMany({
      where: { report: { AND: [scope, query.companyId ? { companyId: query.companyId } : {}] } },
      select: { ...LOG_COLUMNS, report: { select: { number: true, status: true, style: { select: { id: true, code: true, name: true } } } } },
      orderBy: [{ reportId: 'asc' }, { revision: 'desc' }],
      take: SAFETY_LIMITS.logRead,
    })
    const counts = new Map<string, number>()
    const newest: typeof rows = []
    for (const row of rows) {
      counts.set(row.reportId, (counts.get(row.reportId) ?? 0) + 1)
      if (counts.get(row.reportId) === 1) newest.push(row)
    }
    const kept = newest
      .filter((row) => (!query.from || dayOf(row.occurredOn) >= query.from) && (!query.to || dayOf(row.occurredOn) <= query.to))
      .filter((row) => !query.outcome || row.outcome === query.outcome)
      .filter((row) => !query.told || (query.told === 'yes') === (row.authorityToldAt !== null))
      .sort((a, b) => b.occurredOn.getTime() - a.occurredOn.getTime() || (a.reportId < b.reportId ? 1 : -1))
    const shown = kept.slice(0, limit)
    return {
      entries: shown.map((row) => {
        const state = logStateOf({ outcome: row.outcome as AccidentOutcome, authorityToldAt: row.authorityToldAt })
        return {
          ...revisionView(row),
          reportId: row.reportId,
          companyId: row.companyId,
          number: row.report.number,
          reportStatus: row.report.status,
          style: row.report.style,
          revisions: counts.get(row.reportId) ?? 1,
          mustTell: state.mustTell,
          words: state.words,
        }
      }),
      total: kept.length,
      tiles: { entries: newest.length, toTell: newest.filter((row) => logStateOf({ outcome: row.outcome as AccidentOutcome, authorityToldAt: row.authorityToldAt }).mustTell).length, told: newest.filter((row) => row.authorityToldAt !== null).length },
      law: SAFETY_LAW.log,
      q37: SAFETY_LAW.q37,
      people: await peopleOf(client, shown.flatMap((row) => [row.authorityToldById, row.createdById])),
      asOf: toUtcIso(now),
    }
  })
}

/** GET /sales/safety-reports/:reportId/accident-log */
export async function reportRevisions(caller: CommandCaller, reportId: string) {
  const { row } = await officeReport(caller, reportId)
  return caller.withClient(async (client) => {
    const revisions = await revisionsOf(client, row.id)
    const newest = revisions[0] ?? null
    return {
      reportId: row.id,
      number: row.number,
      revisions: revisions.map(revisionView),
      state: logStateOf(newest ? { outcome: newest.outcome as AccidentOutcome, authorityToldAt: newest.authorityToldAt } : null),
      people: await peopleOf(client, revisions.flatMap((entry) => [entry.authorityToldById, entry.createdById])),
    }
  })
}

export interface RevisionBody {
  readonly version: number
  readonly occurredOn?: BusinessDate | undefined
  readonly place?: string | undefined
  readonly outcome?: AccidentOutcome | undefined
  readonly styleId?: string | null | undefined
  readonly serial?: string | null | undefined
  readonly batchNumber?: string | null | undefined
  readonly authorityToldAt?: string | undefined
  readonly authorityReference?: string | null | undefined
  readonly authorityNoticeId?: string | null | undefined
  readonly note?: string | null | undefined
}

const trimmed = (value: string | null | undefined): string | null => (value === null || value === undefined ? null : value.trim())

/** POST /sales/safety-reports/:reportId/accident-log — a new revision; the authority told by the person who records it. */
export async function reviseAccident(caller: CommandCaller, reportId: string, body: RevisionBody, idempotencyKey?: string): Promise<{ report: ReportView; entry: ReturnType<typeof revisionView> }> {
  const { context, row: seen } = await officeReport(caller, reportId, SALES_SAFETY_LOG, LOG_WORDS)
  const { result } = await command(caller, { name: 'safetyReports.reviseAccident', idempotencyKey, input: { reportId, ...body } }, async (tools) => {
    // The log is kept also for a closed report (an authority told later).
    const row = await lockReport(tools, seen.id, body.version, { closedToo: true })
    const newest = (await revisionsOf(tools.tx, row.id))[0] ?? null
    const toldAt = body.authorityToldAt ? new Date(body.authorityToldAt) : (newest?.authorityToldAt ?? null)
    const fresh = body.authorityToldAt !== undefined
    const facts = {
      occurredOn: body.occurredOn ?? (newest ? dayOf(newest.occurredOn) : null),
      place: body.place !== undefined ? trimmed(body.place) : (newest?.place ?? null),
      outcome: body.outcome ?? ((newest?.outcome as AccidentOutcome | undefined) ?? null),
      styleId: body.styleId !== undefined ? body.styleId : (newest?.styleId ?? row.styleId),
      serial: body.serial !== undefined ? trimmed(body.serial) || null : (newest?.serial ?? row.garmentSerial ?? row.serial),
      batchNumber: body.batchNumber !== undefined ? trimmed(body.batchNumber) || null : (newest?.batchNumber ?? row.garmentBatch ?? row.batchNumber),
      authorityToldAt: toldAt,
      authorityToldById: fresh ? context.actorId : (newest?.authorityToldById ?? null),
      authorityReference: body.authorityReference !== undefined ? trimmed(body.authorityReference) || null : fresh ? null : (newest?.authorityReference ?? null),
      authorityNoticeId: body.authorityNoticeId !== undefined ? body.authorityNoticeId : fresh ? null : (newest?.authorityNoticeId ?? null),
      note: trimmed(body.note) || null,
    }
    const problems = revisionProblems({
      first: newest === null,
      occurredOn: facts.occurredOn,
      place: facts.place,
      outcome: facts.outcome,
      serial: facts.serial,
      batchNumber: facts.batchNumber,
      authorityToldAt: facts.authorityToldAt,
      authorityReference: facts.authorityReference,
      authorityNoticeId: facts.authorityNoticeId,
      note: facts.note,
      receivedOn: businessDate(row.receivedAt),
      today: businessDate(tools.now),
      now: tools.now,
      authorityDay: facts.authorityToldAt ? businessDate(facts.authorityToldAt) : null,
    })
    if (facts.styleId && !(isUuid(facts.styleId) && (await tools.tx.style.findUnique({ where: { id: facts.styleId }, select: { id: true } })))) problems.push({ path: 'body/styleId', message: 'Not a style of the tenant.' })
    if (facts.authorityNoticeId && body.authorityNoticeId !== undefined) {
      const notice = isUuid(facts.authorityNoticeId) ? await tools.tx.authorityNotice.findUnique({ where: { id: facts.authorityNoticeId }, select: { companyId: true, status: true } }) : null
      if (!notice || notice.companyId !== row.companyId || notice.status !== 'SENT') problems.push({ path: 'body/authorityNoticeId', message: 'A SENT authority notice of the report’s company.' })
    }
    if (problems.length > 0) refuse(problems, 'The accident log cannot take this revision.')
    const id = newId()
    const revision = (newest?.revision ?? 0) + 1
    const written = await tools.tx.accidentLogEntry.create({
      data: {
        id,
        companyId: row.companyId,
        reportId: row.id,
        revision,
        occurredOn: asDay(facts.occurredOn!),
        place: facts.place!,
        styleId: facts.styleId,
        serial: facts.serial,
        batchNumber: facts.batchNumber,
        outcome: facts.outcome!,
        authorityToldAt: facts.authorityToldAt,
        authorityToldById: facts.authorityToldAt ? facts.authorityToldById : null,
        authorityReference: facts.authorityReference,
        authorityNoticeId: facts.authorityNoticeId,
        note: facts.note,
        createdAt: tools.now,
        createdById: context.actorId,
      },
      select: LOG_COLUMNS,
    })
    await touchReport(tools, row)
    tools.audit({
      action: 'safetyReports.reviseAccident',
      recordType: ACCIDENT_LOG_RECORD,
      recordId: id,
      companyId: row.companyId,
      after: { reportId: row.id, revision, occurredOn: facts.occurredOn, place: facts.place, styleId: facts.styleId, serial: facts.serial, batchNumber: facts.batchNumber, outcome: facts.outcome, authorityToldAt: facts.authorityToldAt?.toISOString() ?? null, authorityReference: facts.authorityReference, authorityNoticeId: facts.authorityNoticeId, note: facts.note ? 'set' : null },
    })
    tools.emit({ type: 'accident_log.revised', subject: row.id, companyId: row.companyId, payload: { reportId: row.id, number: row.number, entryId: id, revision, outcome: facts.outcome!, authorityTold: facts.authorityToldAt !== null } })
    return revisionView(written)
  })
  return { report: await reportRecordOf(caller, seen.id), entry: result }
}
