import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { POLL_AFTER_MS, POLL_STEP_MS, POLL_UNCERTAIN_FOR_MS, pollDue } from '@nexus/factory-domain/invoicing/sdi/poll'
import { failureReasonOf, type SdiSendStatus } from '@nexus/factory-domain/invoicing/sdi/states'
import type { SdiStatusAnswer } from '@nexus/factory-domain/ports/sdi'
import { callerFor, command, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { GatewayCallFailed, GatewayRefusal } from '../../../platform/gateway/gateway'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { activeTenants, asSystem, systemContext } from '../../../platform/outbox/system'
import { afterSendMove, applyMessages } from './record'
import { processSdi, type SdiRuntime } from './runtime'
import { lockInvoice, readSend } from './store'

/**
 * The status poll (FIN-086; plan A1 §4 "a status poll catches lost webhooks"; the rule: factory-domain
 * invoicing/sdi/poll): the scheduler's clustered cron `invoicing.sdiPoll` (every five minutes, one replica per tick)
 * finds, per ACTIVE tenant in its system context, the sends with no outcome that are due, and emits one
 * `invoice.sdi_poll_due` per send in ONE command per tenant; the worker's handler `invoicing.sdiPoll` asks the
 * provider (one gateway call, sdi.get_status) and records what it says in ONE command (`recordPoll`): a SENDING send the
 * provider has becomes SENT, one it never got becomes FAILED (nothing sent); SDI's notifications are recorded once
 * each (a webhook that came first, or comes later, adds nothing). A refused call (the connection paused, the circuit
 * open) waits for the next tick.
 */

export const POLL_DUE_COMMAND = 'invoices.sdiPollDue'
const MAX_PER_TENANT = 200

/**
 * Inside a command: what the provider said about one send. `staleSending`: the send has been SENDING since before the
 * poll's wait, so an unknown file means the sending process stopped before the provider got it.
 */
export async function recordPoll(tools: CommandTools, submissionId: string, answer: SdiStatusAnswer, options: { readonly staleSending: boolean }): Promise<{ sendStatus: SdiSendStatus; recorded: number }> {
  const first = await readSend(tools.tx, submissionId)
  if (!first) return { sendStatus: 'FAILED', recorded: 0 }
  await lockInvoice(tools.tx, first.invoiceId)
  const send = (await readSend(tools.tx, submissionId))!
  const companyId = (await tools.tx.invoice.findUniqueOrThrow({ where: { id: send.invoiceId }, select: { companyId: true } })).companyId
  if (send.status === 'SENDING' && (answer.known || options.staleSending)) {
    const data = answer.known
      ? { status: 'SENT' as const, providerRef: send.providerRef ?? answer.providerRef, sentAt: answer.acceptedAt ? new Date(answer.acceptedAt) : tools.now }
      : { status: 'FAILED' as const, failureReason: failureReasonOf('NOT_SENT', 'the sending process stopped before the SDI intermediary got the file') }
    await tools.tx.sdiSubmission.update({ where: { id: send.id }, data: { ...data, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'invoices.sdiSendResult', recordType: 'SdiSubmission', recordId: send.id, companyId, before: { status: 'SENDING' }, after: { status: data.status, by: 'poll' } })
    await afterSendMove(tools, send, data.status)
  } else if (answer.known && send.providerRef === null && answer.providerRef && send.status !== 'SENDING') {
    await tools.tx.sdiSubmission.update({ where: { id: send.id }, data: { providerRef: answer.providerRef, version: { increment: 1 } }, select: { id: true } })
  }
  const applied = answer.messages.length > 0 ? await applyMessages(tools, send.id, answer.messages, { inboundWebhookId: null }) : null
  tools.audit({ action: 'invoices.sdiPoll', recordType: 'SdiSubmission', recordId: send.id, companyId, after: { known: answer.known, notifications: answer.messages.length, recorded: applied?.recorded ?? 0 } })
  const now = (await readSend(tools.tx, submissionId))!
  return { sendStatus: now.status, recorded: applied?.recorded ?? 0 }
}

/** The worker's work for one due send (the handler of invoice.sdi_poll_due). */
export async function pollSend(sdi: SdiRuntime, caller: CommandCaller, submissionId: string, options: { readonly causationId?: string; readonly clock?: Clock } = {}): Promise<'recorded' | 'settled' | 'refused'> {
  const causationId = options.causationId
  const send = await caller.withClient((client) => readSend(client, submissionId))
  if (!send || !['SENDING', 'SENT', 'FAILED'].includes(send.status)) return 'settled'
  const staleSending = send.status === 'SENDING' && (options.clock ?? serverClock).now().getTime() - send.createdAt.getTime() >= POLL_AFTER_MS
  let answer: SdiStatusAnswer
  try {
    answer = await sdi.status(caller, send.integrationAccountId, { providerRef: send.providerRef, fileName: send.fileName, idempotencyKey: send.id })
  } catch (error) {
    if (error instanceof GatewayRefusal) return 'refused'
    if (error instanceof GatewayCallFailed && !error.retryable) return 'refused'
    throw error
  }
  await command(caller, { name: 'invoices.sdiPollResult', input: { submissionId }, ...(causationId ? { causationId } : {}) }, async (tools) => recordPoll(tools, submissionId, answer, { staleSending }))
  return 'recorded'
}

/** The worker's handler of invoice.sdi_poll_due. Listed in background.ts HANDLERS. */
export function sdiPollHandler(runtime: () => SdiRuntime = processSdi, clock: Clock = serverClock): EventHandler {
  return defineHandler({
    name: 'invoicing.sdiPoll',
    events: ['invoice.sdi_poll_due'],
    attempts: 3,
    async handle(event, { caller }) {
      const { submissionId } = event.payload as { submissionId: string }
      await pollSend(runtime(), caller, submissionId, { causationId: event.eventId, clock })
    },
  })
}

export interface PollOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

/** One tick over every active tenant: the due sends get their event (the cron's run; tests call it directly). */
export async function runSdiPoll(options: PollOptions): Promise<{ tenants: number; due: number; failed: number }> {
  const clock = options.clock ?? serverClock
  const tick = clock.now()
  const step = Math.floor(tick.getTime() / POLL_STEP_MS)
  const waited = new Date(tick.getTime() - POLL_AFTER_MS)
  const oldest = new Date(tick.getTime() - POLL_UNCERTAIN_FOR_MS)
  const requestId = `sdi-poll-${newId()}`
  let due = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const rows = await asSystem(options.database, tenantId, requestId, (client) =>
        client.sdiSubmission.findMany({
          where: {
            OR: [
              { status: 'SENT', sentAt: { lte: waited } },
              { status: 'SENDING', createdAt: { lte: waited } },
              { status: 'FAILED', failureReason: { startsWith: 'NO_ANSWER:' }, updatedAt: { lte: waited, gte: oldest } },
            ],
          },
          select: { id: true, invoiceId: true, status: true, failureReason: true, sentAt: true, createdAt: true, updatedAt: true, invoice: { select: { companyId: true } } },
          orderBy: { id: 'asc' },
        }),
      )
      const sends = rows
        .filter((send) => pollDue({ status: send.status, failureReason: send.failureReason, since: send.status === 'SENT' ? (send.sentAt ?? send.createdAt) : send.status === 'FAILED' ? send.updatedAt : send.createdAt }, tick))
        .slice(0, MAX_PER_TENANT)
      if (sends.length === 0) continue
      await runCommand(
        callerFor(options.database, systemContext(tenantId, requestId)),
        { name: POLL_DUE_COMMAND, input: { step, sends: sends.map((send) => send.id) } },
        async ({ audit, emit }) => {
          for (const send of sends) {
            audit({ recordType: 'SdiSubmission', recordId: send.id, companyId: send.invoice.companyId, after: { status: send.status, poll: true } })
            emit({ type: 'invoice.sdi_poll_due', subject: send.invoiceId, companyId: send.invoice.companyId, payload: { invoiceId: send.invoiceId, submissionId: send.id } })
          }
          return { due: sends.length }
        },
        { ...COMMAND_SETTINGS, clock },
      )
      due += sends.length
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the SDI sends of a tenant could not be polled')
    }
  }
  if (due > 0 || failed > 0) options.log.info({ tenants: tenants.length, due, failed }, 'SDI status poll')
  return { tenants: tenants.length, due, failed }
}

/** The scheduler's cron, every five minutes. */
export function sdiPollCron(options: PollOptions): CronJob {
  return defineCron({
    name: 'invoicing.sdiPoll',
    schedule: '*/5 * * * *',
    async run() {
      await runSdiPoll(options)
    },
  })
}
