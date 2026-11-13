import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  CronRunStatus,
  CronTrigger,
  DataRequestKind,
  DataRequestStatus,
  DataSubjectKind,
  ErasureMethod,
  IntegrationErrorSource,
  IntegrationErrorState,
  MasterStatus,
  PartyContactRole,
  RetentionAction,
  RetentionSweepMode,
  RetentionSweepStatus,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'

/**
 * The privacy and integration seed (W2b schema wave 53/57, B-W2b-375), per tenant of seed/_core.ts, written as the API and
 * its jobs write these rows: in the tenant's office scope. The CLI runs the seed files in name order and this one sorts
 * after auth, files, floor-auth, integration, outbox and parties, whose rows it names (it runs the auth seed itself, as
 * seed/security.ts does). Every name, address and text is made up; the retention periods are made up too (GATE-PRIVACY:
 * they wait for the Owner's privacy consultant), so no rule is switched on and no sweep applies anything.
 *
 *   requests   company A: worker A1-1 asks for a copy of their data (RECEIVED: the first row); the member's copy, handed over
 *              as a package (DONE); P3's former contact asks to be erased (IN_PROGRESS: the contact is anonymised, the
 *              erasure recorded); the member asks for a correction, extended once with the reason (IN_PROGRESS). Company B:
 *              worker B1-1's request refused (the identity could not be checked).
 *   erasure    the former contact's name, e-mail and phone blanked (the first row: of the request in progress).
 *   rules      every company: report runs 12 months then deleted (the first row), mail that joined no record 24 months then
 *              anonymised, failed messages 6 months and job runs 3 months then deleted, exports 3 months (switched off);
 *              company A: invoices 120 months then archived. All only report.
 *   sweeps     report runs (DONE: the first row), mail (FAILED, a code), job runs (DONE): each a REPORT.
 *   errors     the refused SDI send of the integration seed (OPEN: the first row), its rejected webhook (DISMISSED with the
 *              reason), a mail send that timed out (RETRIED by the owner), an outbox event whose job failed (OPEN; the event
 *              itself PUBLISHED: the golden flows leave no event undelivered).
 *   runs       outbox.lag twice (SUCCEEDED: the first row), portalTasks.remind (FAILED, its error), a run of
 *              portalNotifications.digest the owner asked for (SUCCEEDED).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id (ids with eight
 * zeros) and insert the copy: so the first request is RECEIVED, the first erasure is of a request in progress, the first
 * error item is OPEN. Fixed instants, so nothing depends on the clock. Idempotent: rows are written once (skipDuplicates),
 * and each later step only moves a row still in the step before.
 */

const AT = new Date('2026-11-12T08:00:00.000Z')
const minutes = (n: number): Date => new Date(AT.getTime() + n * 60_000)
const DAY = 24 * 60
const DUE = 720 * 60 * 60_000
/** The integration seed's instant (its refused SDI call and its rejected webhook). */
const INTEGRATION_AT = new Date('2026-10-28T08:00:00.000Z')

/** The business day (Europe/Rome) of an instant, less `months` months, a month end clamped: a sweep's cut-off. */
export function cutoffDay(startedAt: Date, months: number): Date {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(startedAt)
    .split('-')
    .map(Number) as [number, number, number]
  const total = y * 12 + (m - 1) - months
  const year = Math.floor(total / 12)
  const month = total - year * 12
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(d, last)))
}

export interface PrivacyOpsSeed {
  readonly requestIds: {
    readonly workerAccess: string
    readonly memberAccess: string
    readonly contactErasure: string
    readonly memberCorrection: string
    readonly refusedB: string
  }
  readonly formerContactId: string
  readonly packageFileId: string
  readonly erasureIds: readonly string[]
  readonly ruleIds: { readonly reportRuns: string; readonly inboundMail: string; readonly invoicesA: string; readonly errors: string; readonly runs: string; readonly exports: string }
  readonly sweepIds: readonly string[]
  readonly errorIds: { readonly sdiRefused: string; readonly webhookRejected: string; readonly mailTimeout: string; readonly jobFailed: string }
  readonly runIds: readonly string[]
}

export async function seed(context: SeedContext): Promise<PrivacyOpsSeed> {
  const { db, namespace } = context
  const { ownerId, memberId } = await seedAuth(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const sha = (text: string): string => createHash('sha256').update(`seed privacy-ops ${namespace} ${text}`).digest('hex')
  const tenantId = id('tenant')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const office = { audience: 'office' as const, tenantId, actorId: ownerId }
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: ownerId })

  const result: PrivacyOpsSeed = {
    requestIds: {
      workerAccess: firstId('privacy-ops:request:worker-access'),
      memberAccess: id('privacy-ops:request:member-access'),
      contactErasure: id('privacy-ops:request:contact-erasure'),
      memberCorrection: id('privacy-ops:request:member-correction'),
      refusedB: id('privacy-ops:request:b-refused'),
    },
    formerContactId: id('privacy-ops:contact:P3:former'),
    packageFileId: id('privacy-ops:request:member-access:package'),
    erasureIds: [firstId('privacy-ops:erasure:former-contact')],
    ruleIds: {
      reportRuns: firstId('privacy-ops:rule:report-runs'),
      inboundMail: id('privacy-ops:rule:inbound-mail'),
      invoicesA: id('privacy-ops:rule:invoices:A'),
      errors: id('privacy-ops:rule:error-items'),
      runs: id('privacy-ops:rule:cron-runs'),
      exports: id('privacy-ops:rule:exports'),
    },
    sweepIds: [firstId('privacy-ops:sweep:report-runs'), id('privacy-ops:sweep:inbound-mail'), id('privacy-ops:sweep:cron-runs')],
    errorIds: {
      sdiRefused: firstId('privacy-ops:error:sdi-refused'),
      webhookRejected: id('privacy-ops:error:webhook-rejected'),
      mailTimeout: id('privacy-ops:error:mail-timeout'),
      jobFailed: id('privacy-ops:error:job-failed'),
    },
    runIds: [firstId('privacy-ops:run:outbox-lag:1'), id('privacy-ops:run:outbox-lag:2'), id('privacy-ops:run:portal-remind'), id('privacy-ops:run:digest-now')],
  }
  const R = result.requestIds

  // --- data requests (PLT-202, PLT-203) ----------------------------------------------------------------------------------
  const received = (at: Date) => ({ receivedAt: at, dueAt: new Date(at.getTime() + DUE) })
  const requests: Prisma.DataRequestCreateManyInput[] = [
    {
      id: R.workerAccess,
      companyId: companyA,
      personKind: DataSubjectKind.WORKER,
      personRecordType: 'Worker',
      personRecordId: id('worker:A1:operator'),
      kind: DataRequestKind.ACCESS,
      ...received(minutes(-3 * DAY)),
      note: 'Asks for a copy of what the floor tools keep about them (made up).',
      ...stamp(minutes(-3 * DAY)),
    },
    {
      id: R.memberAccess,
      companyId: companyA,
      personKind: DataSubjectKind.USER,
      personRecordType: 'User',
      personRecordId: memberId,
      kind: DataRequestKind.ACCESS,
      ...received(minutes(-20 * DAY)),
      note: 'Asks for everything kept about their account (made up).',
      ...stamp(minutes(-20 * DAY)),
    },
    {
      id: R.contactErasure,
      companyId: companyA,
      personKind: DataSubjectKind.CONTACT,
      personRecordType: 'PartyContact',
      personRecordId: result.formerContactId,
      kind: DataRequestKind.ERASURE,
      ...received(minutes(-10 * DAY)),
      note: 'A former buyer of P3 asks to be erased (made up).',
      ...stamp(minutes(-10 * DAY)),
    },
    {
      id: R.memberCorrection,
      companyId: companyA,
      personKind: DataSubjectKind.USER,
      personRecordType: 'User',
      personRecordId: memberId,
      kind: DataRequestKind.CORRECTION,
      ...received(minutes(-40 * DAY)),
      extendedDueAt: new Date(minutes(-40 * DAY).getTime() + 3 * DUE),
      extensionReason: 'The name to correct is printed on records of both companies; the person was told on day 20 (made up).',
      note: 'Asks to correct the spelling of their surname (made up).',
      ...stamp(minutes(-40 * DAY)),
    },
    {
      id: R.refusedB,
      companyId: companyB,
      personKind: DataSubjectKind.WORKER,
      personRecordType: 'Worker',
      personRecordId: id('worker:B1:operator'),
      kind: DataRequestKind.ACCESS,
      ...received(minutes(-15 * DAY)),
      ...stamp(minutes(-15 * DAY)),
    },
  ]
  const packageFile: Prisma.StoredFileCreateManyInput = {
    id: result.packageFileId,
    companyId: companyA,
    recordType: 'DataRequest',
    recordId: R.memberAccess,
    kind: 'DOCUMENT',
    originalName: 'Seed access copy.pdf',
    contentType: 'application/pdf',
    sizeBytes: 20480,
    sha256: sha('access copy'),
    storeAccountId: id('files:account:r2'),
    storageKey: `t/${tenantId}/c/${companyA}/2026/${id('privacy-ops:request:member-access:package:key')}`,
    status: 'AVAILABLE',
    availableAt: minutes(-6 * DAY),
    visibility: ['OFFICE'],
    ...stamp(minutes(-6 * DAY)),
  }

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      // P3's former buyer (made up): written with their data, then erased on request (the row stays, blank for good).
      if (!(await tx.partyContact.findUnique({ where: { id: result.formerContactId }, select: { id: true } }))) {
        await tx.partyContact.create({
          data: { id: result.formerContactId, partyId: id('party:P3'), name: 'Seed Former Contact', email: 'former.contact.p3@example.com', phone: '+39 000 0000013', roles: [PartyContactRole.ORDERS], ...stamp(minutes(-400 * DAY)) },
          select: { id: true },
        })
      }
      await tx.dataRequest.createMany({ data: requests, skipDuplicates: true })
      const step = (where: Prisma.DataRequestWhereInput, data: Prisma.DataRequestUpdateManyMutationInput) => tx.dataRequest.updateMany({ where, data })

      // The member's copy: identity checked, collected, handed over.
      await step({ id: R.memberAccess, status: DataRequestStatus.RECEIVED }, { status: DataRequestStatus.IN_PROGRESS, identityCheckedAt: minutes(-19 * DAY), identityCheckedById: ownerId, updatedAt: minutes(-19 * DAY) })
      await tx.storedFile.createMany({ data: [packageFile], skipDuplicates: true })
      if ((await tx.dataRequest.findUnique({ where: { id: R.memberAccess }, select: { status: true } }))?.status === DataRequestStatus.IN_PROGRESS) {
        await tx.dataRequest.update({
          where: { id: R.memberAccess },
          data: { status: DataRequestStatus.DONE, packageFileId: result.packageFileId, decidedAt: minutes(-5 * DAY), decidedById: ownerId, updatedAt: minutes(-5 * DAY) },
          select: { id: true },
        })
      }

      // The former contact: identity checked, the contact anonymised and the erasure recorded; the request goes on.
      await step({ id: R.contactErasure, status: DataRequestStatus.RECEIVED }, { status: DataRequestStatus.IN_PROGRESS, identityCheckedAt: minutes(-9 * DAY), identityCheckedById: ownerId, updatedAt: minutes(-9 * DAY) })
      await tx.partyContact.updateMany({
        where: { id: result.formerContactId, erasedAt: null },
        data: { name: '', email: null, phone: null, status: MasterStatus.ARCHIVED, erasedAt: minutes(-8 * DAY), erasedById: ownerId, updatedAt: minutes(-8 * DAY) },
      })
      await tx.erasureRecord.createMany({
        data: [
          {
            id: result.erasureIds[0]!,
            companyId: companyA,
            dataRequestId: R.contactErasure,
            recordType: 'PartyContact',
            recordId: result.formerContactId,
            method: ErasureMethod.ANONYMISED,
            erasedFields: ['name', 'email', 'phone'],
            keptFields: [],
            erasedAt: minutes(-8 * DAY),
            erasedById: ownerId,
          },
        ],
        skipDuplicates: true,
      })

      // The member's correction: identity checked, in progress (extended at receipt).
      await step({ id: R.memberCorrection, status: DataRequestStatus.RECEIVED }, { status: DataRequestStatus.IN_PROGRESS, identityCheckedAt: minutes(-39 * DAY), identityCheckedById: ownerId, updatedAt: minutes(-39 * DAY) })

      // Company B: refused, the identity could not be checked.
      await step(
        { id: R.refusedB, status: DataRequestStatus.RECEIVED },
        {
          status: DataRequestStatus.REFUSED,
          refusalReason: 'The person could not show who they are; they were told how to ask again (made up).',
          decidedAt: minutes(-2 * DAY),
          decidedById: ownerId,
          updatedAt: minutes(-2 * DAY),
        },
      )
    }),
  )

  // --- retention rules and sweeps (PLT-204; GATE-PRIVACY: made-up periods, nothing switched on) ---------------------------
  const MADE_UP = 'Made-up period: waits for the privacy consultant (GATE-PRIVACY).'
  const U = result.ruleIds
  const rule = (ruleId: string, recordType: string, companyId: string | null, keepMonths: number, thenAction: RetentionAction, legalReason: string, active = true): Prisma.RetentionRuleCreateManyInput => ({
    id: ruleId,
    companyId,
    key: `retention:${recordType}:${companyId ?? 'all'}`,
    recordType,
    keepMonths,
    thenAction,
    legalReason,
    active,
    ...stamp(minutes(-30 * DAY)),
  })
  const rules = [
    rule(U.reportRuns, 'ReportRun', null, 12, RetentionAction.DELETE, `What a person ran is kept only while useful (GDPR art. 5(1)(e)). ${MADE_UP}`),
    rule(U.inboundMail, 'InboundEmail', null, 24, RetentionAction.ANONYMISE, `Mail that never joined a record keeps no sender after two years. ${MADE_UP}`),
    rule(U.invoicesA, 'Invoice', companyA, 120, RetentionAction.ARCHIVE, 'c.c. art. 2220: accounting records and invoices are kept ten years.'),
    rule(U.errors, 'IntegrationErrorItem', null, 6, RetentionAction.DELETE, `A failed message may name a person in the provider's words. ${MADE_UP}`),
    rule(U.runs, 'CronRun', null, 3, RetentionAction.DELETE, `Job runs are kept for the jobs page and its failures of 7 days. ${MADE_UP}`),
    rule(U.exports, 'ExportJob', null, 3, RetentionAction.DELETE, `Exported files hold copies of records. ${MADE_UP}`, false),
  ]
  const sweep = (sweepId: string, ruleId: string, keepMonths: number, thenAction: RetentionAction, startedAt: Date, extra: Partial<Prisma.RetentionSweepCreateManyInput>): Prisma.RetentionSweepCreateManyInput => ({
    id: sweepId,
    ruleId,
    mode: RetentionSweepMode.REPORT,
    keepMonths,
    thenAction,
    cutoffOn: cutoffDay(startedAt, keepMonths),
    startedAt,
    status: RetentionSweepStatus.DONE,
    finishedAt: new Date(startedAt.getTime() + 2 * 60_000),
    ...extra,
  })
  // The night before, at 03:00 in Rome.
  const nightly = minutes(-DAY - 6 * 60)
  const sweeps = [
    sweep(result.sweepIds[0]!, U.reportRuns, 12, RetentionAction.DELETE, nightly, { dueCount: 3 }),
    sweep(result.sweepIds[1]!, U.inboundMail, 24, RetentionAction.ANONYMISE, new Date(nightly.getTime() + 60_000), {
      status: RetentionSweepStatus.FAILED,
      failures: [{ code: 'QUERY_TIMEOUT' }],
    }),
    sweep(result.sweepIds[2]!, U.runs, 3, RetentionAction.DELETE, new Date(nightly.getTime() + 2 * 60_000), { dueCount: 120 }),
  ]
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.retentionRule.createMany({ data: rules, skipDuplicates: true })
      await tx.retentionSweep.createMany({ data: sweeps, skipDuplicates: true })
    }),
  )

  // --- the error queue (PLT-201) ------------------------------------------------------------------------------------------
  const E = result.errorIds
  const timeoutCall = id('privacy-ops:call:mail-timeout')
  // Sorts last (eight f's): the isolation tests copy a tenant's FIRST outbox event, and a copy is born PENDING.
  const failedEvent = `ffffffff${id('privacy-ops:outbox:job-failed').slice(8)}`
  const errorItems: Prisma.IntegrationErrorItemCreateManyInput[] = [
    {
      id: E.sdiRefused,
      companyId: companyA,
      key: `call:${id('integration:call:refused')}`,
      source: IntegrationErrorSource.CALL,
      sourceId: id('integration:call:refused'),
      provider: 'SDI',
      operation: 'sdi.send_invoice',
      reasonCode: 'account_paused',
      firstFailedAt: INTEGRATION_AT,
      lastFailedAt: INTEGRATION_AT,
      createdAt: INTEGRATION_AT,
      updatedAt: INTEGRATION_AT,
    },
    {
      id: E.webhookRejected,
      companyId: companyA,
      key: `webhook:${id('integration:inbound:rejected')}`,
      source: IntegrationErrorSource.WEBHOOK,
      sourceId: id('integration:inbound:rejected'),
      provider: 'SDI',
      operation: 'webhook.process',
      reasonCode: 'signature_mismatch',
      firstFailedAt: INTEGRATION_AT,
      lastFailedAt: INTEGRATION_AT,
      createdAt: INTEGRATION_AT,
      updatedAt: INTEGRATION_AT,
    },
    {
      id: E.mailTimeout,
      key: `call:${timeoutCall}`,
      source: IntegrationErrorSource.CALL,
      sourceId: timeoutCall,
      provider: 'SES',
      operation: 'mail.send',
      reasonCode: 'timeout',
      reasonText: 'The mail service did not answer within 10 seconds (made up).',
      firstFailedAt: minutes(120),
      lastFailedAt: minutes(120),
      createdAt: minutes(120),
      updatedAt: minutes(120),
    },
    {
      id: E.jobFailed,
      companyId: companyA,
      key: `outbox:${failedEvent}`,
      source: IntegrationErrorSource.OUTBOX,
      sourceId: failedEvent,
      operation: 'seed.example',
      reasonCode: 'job_failed',
      reasonText: 'The job that handles the event failed three times (made up).',
      tries: 3,
      firstFailedAt: minutes(150),
      lastFailedAt: minutes(170),
      createdAt: minutes(170),
      updatedAt: minutes(170),
    },
  ]
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.integrationCall.createMany({
        data: [
          {
            id: timeoutCall,
            accountId: id('integration:account:ses'),
            provider: 'SES',
            mode: 'FAKE',
            operation: 'mail.send',
            requestId: 'seed-privacy-ops-mail-timeout',
            startedAt: new Date(minutes(120).getTime() - 10_000),
            finishedAt: minutes(120),
            durationMs: 10_000,
            attempts: 3,
            status: 'TIMED_OUT',
            reason: 'timeout',
          },
        ],
        skipDuplicates: true,
      })
      // An event no handler knows (as seed/outbox.ts), published, whose job failed.
      await tx.outboxEvent.createMany({
        data: [
          {
            id: failedEvent,
            companyId: companyA,
            type: 'seed.example',
            version: 1,
            context: 'seed',
            subject: companyA,
            correlationId: 'seed-privacy-ops-job-failed',
            source: 'seed.example',
            occurredAt: minutes(140),
            payload: { seeded: true },
          },
        ],
        skipDuplicates: true,
      })
      await tx.outboxEvent.updateMany({ where: { id: failedEvent, status: 'PENDING' }, data: { status: 'PUBLISHED', attempts: 1, publishedAt: minutes(141) } })
      await tx.integrationErrorItem.createMany({ data: errorItems, skipDuplicates: true })
      await tx.integrationErrorItem.updateMany({
        where: { id: E.webhookRejected, state: IntegrationErrorState.OPEN },
        data: { state: IntegrationErrorState.DISMISSED, dismissedAt: minutes(60), dismissedById: ownerId, dismissReason: 'A delivery whose signature failed: nothing came from the provider, nothing to retry (made up).', updatedAt: minutes(60) },
      })
      await tx.integrationErrorItem.updateMany({
        where: { id: E.mailTimeout, state: IntegrationErrorState.OPEN },
        data: { state: IntegrationErrorState.RETRIED, retriedAt: minutes(130), retriedById: ownerId, updatedAt: minutes(130) },
      })
    }),
  )

  // --- scheduled job runs (PLT-221) ---------------------------------------------------------------------------------------
  const epoch = (at: Date): number => Math.floor(at.getTime() / 1000)
  const tick = (runId: string, jobKey: string, scheduledAt: Date, status: CronRunStatus, extra: Partial<Prisma.CronRunCreateManyInput> = {}): Prisma.CronRunCreateManyInput => ({
    id: runId,
    jobKey,
    trigger: CronTrigger.SCHEDULE,
    key: `${jobKey}@${epoch(scheduledAt)}`,
    scheduledAt,
    startedAt: new Date(scheduledAt.getTime() + 1_000),
    finishedAt: new Date(scheduledAt.getTime() + 2_000),
    status,
    ranOn: 'seed-scheduler-1 (pid 4242)',
    createdAt: new Date(scheduledAt.getTime() + 1_000),
    ...extra,
  })
  const runs: Prisma.CronRunCreateManyInput[] = [
    tick(result.runIds[0]!, 'outbox.lag', minutes(-60), CronRunStatus.SUCCEEDED),
    tick(result.runIds[1]!, 'outbox.lag', minutes(-59), CronRunStatus.SUCCEEDED),
    tick(result.runIds[2]!, 'portalTasks.remind', minutes(-35), CronRunStatus.FAILED, { error: 'seed: the database did not answer in time (made up)' }),
    {
      id: result.runIds[3]!,
      jobKey: 'portalNotifications.digest',
      trigger: CronTrigger.RUN_NOW,
      key: 'portalNotifications.digest@now:seed-run-now-1',
      scheduledAt: minutes(-20),
      requestedById: ownerId,
      startedAt: minutes(-20),
      finishedAt: new Date(minutes(-20).getTime() + 4_000),
      status: CronRunStatus.SUCCEEDED,
      ranOn: 'seed-scheduler-1 (pid 4242)',
      createdAt: minutes(-20),
    },
  ]
  await db.withScope(office, (client) => client.cronRun.createMany({ data: runs, skipDuplicates: true }))

  return result
}
