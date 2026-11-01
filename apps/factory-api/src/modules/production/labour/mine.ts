import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { addDays, changesOf, DISPUTE_REASONS_FOR, LABOUR_LIMITS, rangeProblems, STATION_SITE } from '@nexus/factory-domain/production/labour/rules'
import { minutesOf } from '@nexus/factory-domain/production/offstandard/rules'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { legalGateFor, legalGateReader } from '../../people/privacy/gate'
import { codesById, wordsOf } from '../offstandard/store'
import { scanSubjectFor } from '../settings/subject'
import { floorOf } from './access'
import type { MineQuery } from './contract'
import { DISPUTE, floorDisputeOf } from './disputes'
import { operationRefOf } from './records'
import { bundlesById, dayColumn, dayRange, isoDay, jsonObject, recordsFor, SCAN, sitesById, workOrdersById } from './store'

/**
 * Workers see their own records (B-W2b-45; MES-205; GDPR art. 15; c.c. art. 2101; design floor.myday "Your records": "your
 * scans today and this period: time, bundle, operation, good and scrap"; "Only you: the PIN is asked again"). floor.work,
 * the signed-in worker only, with the PIN (the route asks requireFloorStepUp, My day's step-up): their reports with what
 * stands of each, their off-standard blocks, their disputes and the answers, and every change made to their records (what,
 * from → to, when, why).
 *
 * The worker always reads their own records (art. 15): whatever the site's legal gate for one person's work figures says.
 * The standard minutes of each report — a figure about one person's work — show only where that gate is on (Statuto dei
 * Lavoratori art. 4 c.1; My day's figures are behind the same switch). A site that records stations names nobody: there is
 * no personal list (the answer says so).
 */

export async function mine(caller: CommandCaller, query: MineQuery) {
  const context = floorOf(caller)
  const now = serverClock.now()
  const site = await caller.withClient(async (db) => (await sitesById(db, [context.siteId])).get(context.siteId) ?? null)
  if (!site) throw new NotFoundError('Site not found.')
  const today = businessDate(now, site.timezone)
  const from = query.from ?? query.to ?? today
  const to = query.to ?? (query.from ? query.from : today)
  const problems = [...rangeProblems(from, to), ...(addDays(from, LABOUR_LIMITS.mineDays - 1) < to ? [{ path: 'querystring/to', message: `Your records show at most ${LABOUR_LIMITS.mineDays} days at a time.` }] : [])]
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const reasons = { OperationScan: [...DISPUTE_REASONS_FOR.OperationScan], OffStandardEntry: [...DISPUTE_REASONS_FOR.OffStandardEntry] }
  const subject = await caller.withClient((db) => scanSubjectFor(db, context.siteId))
  if (subject === 'STATION') return { subject, from, to, minutesShown: false, words: [STATION_SITE.message], records: [], blocks: [], disputes: [], edits: [], reasons }
  const minutesShown = (await legalGateReader(caller, (db) => legalGateFor(db, context.siteId, 'PERFORMANCE'))).open
  return caller.withClient(async (db) => {
    const range = dayRange(from, to, site.timezone)
    const reports = await db.operationScan.findMany({ where: { siteId: context.siteId, workerId: context.actorId, kind: 'REPORT', serverTime: { gte: range.start, lt: range.end } }, select: SCAN, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })
    const set = await recordsFor(db, reports, site.timezone)
    const bundles = await bundlesById(db, set.records.map((record) => record.bundleId))
    const workOrders = await workOrdersById(db, set.records.map((record) => record.workOrderId))
    const blocks = await db.offStandardEntry.findMany({
      where: { siteId: context.siteId, workerId: context.actorId, workDate: { gte: dayColumn(from), lte: dayColumn(to) } },
      select: { id: true, codeId: true, workDate: true, startedAt: true, endedAt: true, status: true, rejectReason: true },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    })
    const codes = await codesById(db, blocks.map((block) => block.codeId))
    // My disputes of the period, and every one of mine still open.
    const disputes = await db.labourDispute.findMany({
      where: { siteId: context.siteId, workerId: context.actorId, OR: [{ workDate: { gte: dayColumn(from), lte: dayColumn(to) } }, { status: 'OPEN' }] },
      select: DISPUTE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    const latestDispute = new Map<string, { id: string; status: (typeof disputes)[number]['status'] }>()
    for (const row of disputes) if (!latestDispute.has(row.recordId)) latestDispute.set(row.recordId, { id: row.id, status: row.status })
    const edits = await db.labourEdit.findMany({
      where: { siteId: context.siteId, workerId: context.actorId, workDate: { gte: dayColumn(from), lte: dayColumn(to) } },
      select: { id: true, recordType: true, recordId: true, before: true, after: true, reason: true, disputeId: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return {
      subject,
      from,
      to,
      minutesShown,
      words: minutesShown ? [] : ["The minutes of each report are not shown: this site's legal basis for one person's work figures is not on record (Statuto dei Lavoratori art. 4). Your records are shown as recorded."],
      records: set.records.map((record) => ({
        scanId: record.scanId,
        at: toUtcIso(record.at),
        workDate: record.workDate,
        workOrder: { id: record.workOrderId, number: workOrders.get(record.workOrderId)?.number ?? '' },
        bundle: { id: record.bundleId, code: bundles.get(record.bundleId)?.code ?? '' },
        operation: operationRefOf(set.operations.get(record.workOrderOperationId), record.workOrderOperationId),
        reported: record.reported,
        counts: record.counts,
        state: record.state,
        minutes: minutesShown ? record.earnedMinutes : null,
        disputable: record.state !== 'UNDONE',
        dispute: latestDispute.get(record.scanId) ?? null,
      })),
      blocks: blocks.map((block) => {
        const code = codes.get(block.codeId)
        return {
          id: block.id,
          code: { id: block.codeId, code: code?.code ?? '', labelIt: code?.labelIt ?? '', labelEn: code?.labelEn ?? '', labelI18n: code ? wordsOf(code.labelI18n) : {}, icon: code?.icon ?? null, colour: code?.colour ?? null },
          workDate: isoDay(block.workDate),
          startedAt: toUtcIso(block.startedAt),
          endedAt: block.endedAt ? toUtcIso(block.endedAt) : null,
          minutes: minutesOf(block.startedAt, block.endedAt, now),
          status: block.status,
          rejectReason: block.rejectReason,
          disputable: block.endedAt !== null && block.status !== 'OPEN',
          dispute: latestDispute.get(block.id) ?? null,
        }
      }),
      disputes: disputes.map(floorDisputeOf),
      edits: edits.map((edit) => ({ id: edit.id, at: toUtcIso(edit.createdAt), recordType: edit.recordType, recordId: edit.recordId, changes: changesOf(jsonObject(edit.before), jsonObject(edit.after)), reason: edit.reason, disputeId: edit.disputeId })),
      reasons,
    }
  })
}
