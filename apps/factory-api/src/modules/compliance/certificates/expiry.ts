import type { FactoryDatabase } from '@nexus/factory-db'
import { addDays, certificateMachine, daysToExpiry, EXPIRY_WARNING_DAYS, expiryWarningDue } from '@nexus/factory-domain/compliance/certificates/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, asSystem, systemContext } from '../../../platform/outbox/system'
import { certificateFacts, dateColumn, dayOf } from './certificates'

/**
 * Certificate expiry (QHS-103, PRD-282, PRD-284; Reg. (EU) 2016/425 Annex V 6.1: at most five years), run daily by the
 * scheduler's clustered cron `compliance.certificateExpiry` (00:20 Europe/Rome, just after the business date turns;
 * one replica per tick). For every ACTIVE tenant, in its system context:
 *
 *   expire  each VALID or SUSPENDED certificate whose last valid day is before today's business date becomes EXPIRED:
 *           one command per certificate, the move checked by the certificate machine, an audit row, the event
 *           `compliance.certificate_expired`. Its Idempotency-Key is fixed per certificate, so a run that raced
 *           another (the lock lost, a retry) answers from the first one's receipt instead of expiring it twice.
 *   warn    each VALID certificate that reached a warning threshold (90, 30, 7 days before its last valid day; the
 *           smallest one reached) gets one `compliance.certificate_expiring` event per threshold, ever: the warnings
 *           already given are read from the certificate's audit rows, and the command's key is fixed per threshold.
 *
 * The certificate gate never waits for this job: it treats a VALID certificate past its last valid day as expired.
 * A run that skipped days (the scheduler down) catches up on the next one. A certificate or tenant that fails is
 * logged and the others go on.
 */

export const EXPIRE_COMMAND = 'compliance.certificates.expire'
export const WARN_COMMAND = 'compliance.certificates.warnExpiry'

export interface ExpiryOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export interface ExpiryRun {
  readonly tenants: number
  readonly today: BusinessDate
  readonly expired: number
  readonly warned: number
  readonly failed: number
}

const EXPIRY_SELECT = { id: true, companyId: true, number: true, standard: true, notifiedBodyNumber: true, validTo: true, status: true } as const

async function expireOne(caller: CommandCaller, certificate: { id: string; validTo: Date }, today: BusinessDate, settings: CommandSettings): Promise<boolean> {
  const validTo = dayOf(certificate.validTo)
  const { replayed } = await runCommand(
    caller,
    {
      name: EXPIRE_COMMAND,
      idempotencyKey: `certificate-expire:${certificate.id}`,
      input: { certificateId: certificate.id, validTo },
      record: { type: 'Certificate', id: certificate.id, transition: { machine: certificateMachine, to: 'EXPIRED', facts: (tx) => certificateFacts(tx, certificate.id, today, null) } },
    },
    async ({ tx, audit, emit, now, record }) => {
      const statusReason = `Past its last valid day, ${validTo}.`
      const row = await tx.certificate.update({ where: { id: certificate.id }, data: { statusReason, statusChangedAt: now }, select: EXPIRY_SELECT })
      const previousStatus = record!.from as 'VALID' | 'SUSPENDED'
      audit({ recordType: 'Certificate', recordId: row.id, companyId: row.companyId, before: { status: previousStatus }, after: { status: row.status, statusReason } })
      emit({
        type: 'compliance.certificate_expired',
        subject: row.id,
        companyId: row.companyId,
        payload: { certificateId: row.id, number: row.number, standard: row.standard, notifiedBodyNumber: row.notifiedBodyNumber, validTo, previousStatus },
      })
      return { certificateId: row.id, status: row.status }
    },
    settings,
  )
  return !replayed
}

async function warnOne(
  caller: CommandCaller,
  certificate: { id: string; companyId: string | null; number: string; standard: string; notifiedBodyNumber: string; validTo: Date },
  thresholdDays: number,
  today: BusinessDate,
  settings: CommandSettings,
): Promise<boolean> {
  const validTo = dayOf(certificate.validTo)
  const daysLeft = daysToExpiry(validTo, today)
  const { replayed } = await runCommand(
    caller,
    { name: WARN_COMMAND, idempotencyKey: `certificate-expiry-warning:${certificate.id}:${thresholdDays}`, input: { certificateId: certificate.id, thresholdDays } },
    async ({ audit, emit }) => {
      audit({ recordType: 'Certificate', recordId: certificate.id, companyId: certificate.companyId, after: { thresholdDays, daysLeft, validTo } })
      emit({
        type: 'compliance.certificate_expiring',
        subject: certificate.id,
        companyId: certificate.companyId,
        payload: { certificateId: certificate.id, number: certificate.number, standard: certificate.standard, notifiedBodyNumber: certificate.notifiedBodyNumber, validTo, daysLeft, thresholdDays },
      })
      return { certificateId: certificate.id, thresholdDays }
    },
    settings,
  )
  return !replayed
}

/** The thresholds already warned for these certificates (their audit rows), by certificate. */
async function warnedOf(database: FactoryDatabase, tenantId: string, requestId: string, ids: readonly string[]): Promise<Map<string, Set<number>>> {
  const rows = await asSystem(database, tenantId, requestId, (client) =>
    client.auditLog.findMany({ where: { recordType: 'Certificate', recordId: { in: [...ids] }, action: WARN_COMMAND }, select: { recordId: true, after: true } }),
  )
  const warned = new Map<string, Set<number>>()
  for (const row of rows) {
    const threshold = (row.after as { thresholdDays?: unknown } | null)?.thresholdDays
    if (typeof threshold === 'number') warned.set(row.recordId, new Set([...(warned.get(row.recordId) ?? []), threshold]))
  }
  return warned
}

/** One run over every active tenant (the cron's tick; tests call it directly). */
export async function runCertificateExpiry(options: ExpiryOptions): Promise<ExpiryRun> {
  const clock = options.clock ?? serverClock
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock }
  const today = businessDate(clock.now())
  const requestId = `certificate-expiry-${newId()}`
  let expired = 0
  let warned = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const due = await asSystem(options.database, tenantId, requestId, (client) =>
        client.certificate.findMany({ where: { status: { in: ['VALID', 'SUSPENDED'] }, validTo: { lt: dateColumn(today) } }, select: EXPIRY_SELECT, orderBy: { id: 'asc' } }),
      )
      for (const certificate of due) {
        try {
          if (await expireOne(caller, certificate, today, settings)) expired++
        } catch (error) {
          failed++
          options.log.error({ err: error, tenantId, certificateId: certificate.id }, 'a certificate past its last valid day could not be expired')
        }
      }

      const horizon = addDays(today, Math.max(...EXPIRY_WARNING_DAYS))
      const ending = await asSystem(options.database, tenantId, requestId, (client) =>
        client.certificate.findMany({ where: { status: 'VALID', validTo: { gte: dateColumn(today), lte: dateColumn(horizon) } }, select: EXPIRY_SELECT, orderBy: { id: 'asc' } }),
      )
      const given = ending.length > 0 ? await warnedOf(options.database, tenantId, requestId, ending.map((certificate) => certificate.id)) : new Map<string, Set<number>>()
      for (const certificate of ending) {
        const threshold = expiryWarningDue(dayOf(certificate.validTo), today)
        if (threshold === null || given.get(certificate.id)?.has(threshold)) continue
        try {
          if (await warnOne(caller, certificate, threshold, today, settings)) warned++
        } catch (error) {
          failed++
          options.log.error({ err: error, tenantId, certificateId: certificate.id }, 'an expiry warning could not be given')
        }
      }
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the certificates of a tenant could not be checked for expiry')
    }
  }
  const result = { tenants: tenants.length, today, expired, warned, failed }
  options.log.info({ ...result }, 'certificate expiry checked')
  return result
}

/** The scheduler's daily cron (00:20 Europe/Rome). */
export function certificateExpiryCron(options: ExpiryOptions): CronJob {
  return defineCron({
    name: 'compliance.certificateExpiry',
    schedule: '20 0 * * *',
    async run() {
      await runCertificateExpiry(options)
    },
  })
}
