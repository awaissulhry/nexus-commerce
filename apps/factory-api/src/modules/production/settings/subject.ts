import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { floorRecordSubject, scanSubjectOf, type ScanSubject } from '@nexus/factory-domain/production/settings/monitoring'
import type { CommandTx } from '../../../core/command'
import { acknowledgedInForce } from '../../../platform/privacy/read'

/**
 * Who a floor record names at a site, for the modules that write floor records: cutting (B-W1-40, CutLog) and scans
 * (B-W1-42, OperationScan). Call these inside the writing command, in the office or the floor scope: they read only
 * `ProductionSettings.scanSubject` (the floor may read nothing else of the row) and the acknowledgements. The
 * …_production_guards triggers check the same at the insert, for every login; these answer first, in words (409).
 */

type Reader = Pick<CommandTx, 'productionSettings' | 'workerNoticeAck' | 'site' | 'privacyNotice'>

/** The site's scan subject: WORKER (the default, also for a site without floor rules) or STATION. */
export async function scanSubjectFor(tx: Pick<CommandTx, 'productionSettings'>, siteId: string): Promise<ScanSubject> {
  const row = await tx.productionSettings.findUnique({ where: { id: siteId }, select: { scanSubject: true } })
  return scanSubjectOf(row)
}

/**
 * The worker acknowledged the information notice that counts at the site (the database's rule for naming them, B-W1-36:
 * the worker notice in force at the site's company; before the company ever published one, any acknowledgement).
 */
export async function hasAcknowledgedNotice(tx: Pick<CommandTx, 'workerNoticeAck' | 'site' | 'privacyNotice'>, siteId: string, workerId: string): Promise<boolean> {
  return acknowledgedInForce(tx, siteId, workerId)
}

/**
 * The worker and station a new floor record at the site names: at a STATION site the station and no worker; at a WORKER
 * site the signed-in worker once they acknowledged the notice (and the station, when given, as where it happened).
 * Otherwise a 409 (invalid_state) that says what to do first.
 */
export async function floorRecordSubjectFor(
  tx: Reader,
  input: { readonly siteId: string; readonly workerId: string | null | undefined; readonly stationId: string | null | undefined },
): Promise<{ readonly workerId: string | null; readonly stationId: string | null }> {
  const scanSubject = await scanSubjectFor(tx, input.siteId)
  const workerAcknowledged = scanSubject === 'WORKER' && input.workerId ? await hasAcknowledgedNotice(tx, input.siteId, input.workerId) : false
  const subject = floorRecordSubject({ scanSubject, workerId: input.workerId, workerAcknowledged, stationId: input.stationId })
  if (!subject.ok) throw new InvalidStateError(subject.message)
  return { workerId: subject.workerId, stationId: subject.stationId }
}
