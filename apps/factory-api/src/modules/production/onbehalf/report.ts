import { ON_BEHALF_REASONS, onBehalfReasonText, onBehalfRefusal, type OnBehalfReasonCode } from '@nexus/factory-domain/production/onbehalf/rules'
import { clientIdReusedRefusal } from '@nexus/factory-domain/production/scans/rules'
import type { CommandCaller } from '../../../core/command'
import { countingAcks, workerNoticeRule } from '../../../platform/privacy/read'
import { floorOf, refuse } from '../scans/access'
import { reportScan, type ReportInput } from '../scans/scans'
import { readScanByClient } from '../scans/store'
import { hasAcknowledgedNotice, scanSubjectFor } from '../settings/subject'
import type { VerifiedOverride } from '../guards/override'

/**
 * The team leader records work for someone who could not scan (B-W2b-47; MES-099; design floor.supervisor "Scan on behalf":
 * "Pick the station (and the person when the site names workers) → scan the bundle → counts → reason; marked 'entered by
 * the team leader'"). The entry's own checks (factory-domain onbehalf/rules: the station, the person, their notice, the
 * reason), then the scans' report in its own command with `onBehalf`: the same rules, locks, audit and events as any report,
 * keyed `<device>.<clientScanId>`, a resend answered with the scan recorded first; the row names the person and createdById
 * the team leader (B-W2b-12's rule), and pay reads the person from it. Online and from the offline queue.
 */

export interface OnBehalfInput extends Omit<ReportInput, 'onBehalf' | 'override'> {
  readonly stationId: string
  readonly workerId?: string | undefined
  readonly reasonCode: OnBehalfReasonCode
  readonly note?: string | undefined
}

export async function reportOnBehalf(caller: CommandCaller, input: OnBehalfInput, options: { readonly override?: VerifiedOverride | undefined } = {}) {
  const context = floorOf(caller)
  const { stationId, workerId, reasonCode, note, ...report } = input
  const words = note?.trim() || null
  const person = workerId ?? null
  const facts = await caller.withClient(async (db) => {
    const scanSubject = await scanSubjectFor(db, context.siteId)
    const station = await db.station.findFirst({ where: { id: stationId, siteId: context.siteId, status: 'ACTIVE' }, select: { id: true } })
    const worker = person ? await db.worker.findFirst({ where: { id: person, siteId: context.siteId, status: 'ACTIVE' }, select: { id: true } }) : null
    return { scanSubject, stationHere: station !== null, personHere: worker !== null, acknowledged: worker ? await hasAcknowledgedNotice(db, context.siteId, worker.id) : false, sent: await readScanByClient(db, context.deviceId, report.clientScanId) }
  })
  // A resend answers the scan recorded first, whatever changed since; the same id for another person is another entry.
  if (facts.sent && facts.sent.workerId !== person) refuse(clientIdReusedRefusal(report.clientScanId))
  const refusal = facts.sent ? null : onBehalfRefusal({ scanSubject: facts.scanSubject, leadId: context.actorId, workerId: person, personHere: facts.personHere, acknowledged: facts.acknowledged, stationHere: facts.stationHere, reasonCode, note: words })
  if (refusal) refuse(refusal)
  return reportScan(caller, { ...report, onBehalf: { workerId: person, stationId, reasonCode, reason: onBehalfReasonText(reasonCode, words) }, override: options.override })
}

/** GET /production/on-behalf/options: the stations, the people who may be named, the reason tiles. */
export async function onBehalfOptions(caller: CommandCaller) {
  const context = floorOf(caller)
  return caller.withClient(async (db) => {
    const subject = await scanSubjectFor(db, context.siteId)
    const stations = await db.station.findMany({ where: { siteId: context.siteId, status: 'ACTIVE' }, select: { id: true, code: true, name: true, lineId: true }, orderBy: { code: 'asc' } })
    let people: { id: string; name: string }[] = []
    const counting = subject === 'WORKER' ? countingAcks(await workerNoticeRule(db, context.siteId)) : null
    if (counting) {
      const named = new Set((await db.workerNoticeAck.findMany({ where: { ...counting, siteId: context.siteId }, select: { workerId: true } })).map((row) => row.workerId))
      const workers = await db.worker.findMany({ where: { siteId: context.siteId, status: 'ACTIVE', id: { not: context.actorId } }, select: { id: true, displayName: true }, orderBy: { displayName: 'asc' } })
      people = workers.filter((worker) => named.has(worker.id)).map((worker) => ({ id: worker.id, name: worker.displayName }))
    }
    return { subject, stations, people, reasons: ON_BEHALF_REASONS.map((reason) => ({ code: reason.code, label: reason.label, needsNote: reason.needsNote })) }
  })
}
