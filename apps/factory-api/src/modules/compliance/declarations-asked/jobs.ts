import type { FactoryDatabase } from '@nexus/factory-db'
import { reminderDue, WAITING, type DeclarationStatus } from '@nexus/factory-domain/compliance/declarations-asked/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { callerFor, runCommand, type CommandCaller } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import type { Clock } from '../../../core/time'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { reopenInCommand, taskById } from '../../../platform/portal/tasks/store'
import { substancesClock, substancesGuarded, substancesSettings } from '../substances/common'
import { answerInCommand, remindInCommand } from './decide'
import { dayOf, dayValue, REQUEST_SELECT } from './store'

/**
 * The declarations' own jobs (B-W2b-256; PRD-304):
 *
 *   hourly (minute 35)   a request still waiting after its due day moves OVERDUE; a waiting request asked in the portal
 *                        whose own cadence came (every `reminderEveryDays` from the last reminder or from when it went
 *                        out) is reminded through its partner task (B-W2b-167 tells the supplier's people, only while its
 *                        portal is on: the Owner's switch per partner, OFF by default). One asked by the office is never
 *                        "reminded" by the system: nothing goes out from here (the list shows `reminderDue`).
 *   on an upload         `supplier_document.uploaded`: the supplier's upload against a request's task answers it (ANSWERED
 *                        with the upload). A file the supplier sent as something else than a declaration does not answer:
 *                        the task opens again so the supplier is still asked.
 *
 * Each change is ONE system command (Idempotency-Key per request and day, or per event).
 */

const BATCH = 500

export interface JobOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

/** One tick over every active tenant (the cron's; tests call it). How many requests moved OVERDUE and how many were reminded. */
export async function declarationsTick(options: JobOptions): Promise<{ readonly overdue: number; readonly reminded: number }> {
  const clock = options.clock ?? substancesClock()
  const settings = { ...substancesSettings(), clock }
  const now = clock.now()
  const today = businessDate(now)
  const requestId = `declarations-tick-${newId()}`
  let overdue = 0
  let reminded = 0
  for (const tenantId of await activeTenants(options.database)) {
    try {
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const late = await caller.withClient((client) => client.supplierDeclarationRequest.findMany({ where: { status: 'SENT', dueOn: { lt: dayValue(today) } }, select: { id: true }, orderBy: { dueOn: 'asc' }, take: BATCH }))
      for (const { id } of late) {
        try {
          const outcome = await substancesGuarded(() =>
            runCommand(
              caller,
              { name: 'compliance.supplierDeclarations.overdue', idempotencyKey: `declaration-overdue:${id}`, input: { requestId: id, day: today } },
              async (tools) => {
                const row = await tools.tx.supplierDeclarationRequest.findUnique({ where: { id }, select: REQUEST_SELECT })
                if (!row || row.status !== 'SENT' || dayOf(row.dueOn) >= businessDate(tools.now)) {
                  tools.audit({ action: 'compliance.supplierDeclarations.overdue', recordType: 'SupplierDeclarationRequest', recordId: id, after: { skipped: true } })
                  return false
                }
                await tools.tx.supplierDeclarationRequest.update({ where: { id }, data: { status: 'OVERDUE', version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
                tools.audit({ action: 'compliance.supplierDeclarations.overdue', recordType: 'SupplierDeclarationRequest', recordId: id, companyId: row.companyId, before: { status: 'SENT' }, after: { status: 'OVERDUE' } })
                tools.emit({ type: 'compliance_material_tests.declaration_overdue', subject: id, companyId: row.companyId, payload: { requestId: id, partyId: row.partyId, dueOn: dayOf(row.dueOn) } })
                return true
              },
              settings,
            ),
          )
          if (!outcome.replayed && outcome.result) overdue += 1
        } catch (error) {
          options.log.error({ err: error, tenantId, requestId: id }, 'a declaration request could not move overdue')
        }
      }
      const waiting = await caller.withClient((client) =>
        client.supplierDeclarationRequest.findMany({ where: { status: { in: ['SENT', 'OVERDUE'] }, channel: 'PORTAL', reminderEveryDays: { not: null } }, select: { id: true, status: true, reminderEveryDays: true, sentAt: true, lastRemindedAt: true }, take: BATCH }),
      )
      for (const candidate of waiting.filter((row) => reminderDue(row, now))) {
        try {
          const outcome = await substancesGuarded(() =>
            runCommand(
              caller,
              { name: 'compliance.supplierDeclarations.remind', idempotencyKey: `declaration-remind:${candidate.id}:${today}`, input: { requestId: candidate.id, day: today } },
              async (tools) => {
                const row = await tools.tx.supplierDeclarationRequest.findUnique({ where: { id: candidate.id }, select: REQUEST_SELECT })
                const task = row?.partnerTaskId ? await taskById(tools.tx, row.partnerTaskId) : null
                if (!row || !reminderDue(row, tools.now) || task?.status !== 'OPEN') {
                  tools.audit({ action: 'compliance.supplierDeclarations.remind', recordType: 'SupplierDeclarationRequest', recordId: candidate.id, after: { skipped: true } })
                  return false
                }
                await remindInCommand(tools, row, 'SCHEDULE')
                return true
              },
              settings,
            ),
          )
          if (!outcome.replayed && outcome.result) reminded += 1
        } catch (error) {
          options.log.error({ err: error, tenantId, requestId: candidate.id }, 'a declaration request could not be reminded')
        }
      }
    } catch (error) {
      options.log.error({ err: error, tenantId }, 'the declaration requests of a tenant could not be read')
    }
  }
  if (overdue + reminded > 0) options.log.info({ overdue, reminded }, 'declaration requests moved on')
  return { overdue, reminded }
}

/** The scheduler's cron: hourly at minute 35 (Europe/Rome). */
export function declarationsCron(options: JobOptions): CronJob {
  return defineCron({
    name: 'compliance.supplierDeclarations',
    schedule: '35 * * * *',
    lockTtlMs: 600_000,
    async run() {
      await declarationsTick(options)
    },
  })
}

/** The supplier's portal upload against a request's task answers it (the worker; one system command per event). */
export async function takePortalUpload(caller: CommandCaller, fileId: string, eventId: string): Promise<'ANSWERED' | 'REOPENED' | 'NONE'> {
  const upload = await caller.withClient((client) => client.supplierDocumentUpload.findFirst({ where: { fileId }, select: { id: true, taskId: true, partyId: true, companyId: true, category: true, receivedAt: true } }))
  if (!upload?.taskId) return 'NONE'
  const taskId = upload.taskId
  const request = await caller.withClient((client) => client.supplierDeclarationRequest.findFirst({ where: { partnerTaskId: taskId }, select: { id: true } }))
  if (!request) return 'NONE'
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.supplierDeclarations.portalAnswer', idempotencyKey: `declaration-upload:${eventId}`, input: { requestId: request.id, uploadId: upload.id }, causationId: eventId },
      async (tools) => {
        const row = await tools.tx.supplierDeclarationRequest.findUniqueOrThrow({ where: { id: request.id }, select: REQUEST_SELECT })
        if (!WAITING.has(row.status as DeclarationStatus) || upload.partyId !== row.partyId || upload.companyId !== row.companyId) {
          tools.audit({ action: 'compliance.supplierDeclarations.answer', recordType: 'SupplierDeclarationRequest', recordId: row.id, companyId: row.companyId, after: { skipped: true, uploadId: upload.id, status: row.status } })
          return 'NONE' as const
        }
        if (upload.category !== 'DECLARATION') {
          // Sent as a certificate or a test report: it does not answer a declaration request; the supplier is still asked.
          const task = await taskById(tools.tx, taskId)
          if (task && task.status !== 'OPEN') await reopenInCommand(tools, task, false)
          tools.audit({ action: 'compliance.supplierDeclarations.answer', recordType: 'SupplierDeclarationRequest', recordId: row.id, companyId: row.companyId, after: { notADeclaration: upload.category, uploadId: upload.id, taskReopened: true } })
          return 'REOPENED' as const
        }
        const answeredAt = upload.receivedAt && upload.receivedAt.getTime() >= row.sentAt.getTime() ? upload.receivedAt : tools.now
        await answerInCommand(tools, row, { uploadId: upload.id, fileId: null, answeredAt, validTo: null, listVersionId: null }, 'PORTAL')
        return 'ANSWERED' as const
      },
      substancesSettings(),
    ),
  )
  return result
}

/** The worker's handlers (background.ts W2B_256_HANDLERS, with the profiles' re-evaluation). */
export function declarationHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'supplierDeclarations.takeUpload',
      events: ['supplier_document.uploaded'],
      async handle(event, { caller }) {
        const { fileId } = event.payload as { fileId: string }
        await takePortalUpload(caller, fileId, event.eventId)
      },
    }),
  ]
}
