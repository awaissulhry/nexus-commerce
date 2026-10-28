import type { Prisma } from '@nexus/factory-db'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import { failureText } from '@nexus/factory-domain/email/rules'
import { events as emailInEvents } from '@nexus/factory-domain/email-in/events'
import { MAX_FETCH_ATTEMPTS, MAX_RAW_BYTES, type InboundAttachment } from '@nexus/factory-domain/email-in/rules'
import { eventFor } from '@nexus/factory-domain/events/define'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { GatewayCallFailed } from '../gateway/gateway'
import { defineHandler, type EventHandler } from '../outbox/dispatch'
import { putPart, storeAccountFor } from './files'
import { parseRawMail, type ParsedMail } from './parse'
import { processEmailIn, type EmailInRuntime } from './service'

/**
 * Reading a received mail (plan A1 §3.3 `email-in`: "fetch raw mail from S3 → parse → sanitise"), the worker's handler of
 * email.inbound_received. Outside any transaction: the raw mail through the gateway (store.ts, one IntegrationCall row),
 * postal-mime and the sanitiser (parse.ts), and each kept attachment put in the file store (one files.put each). Then ONE
 * command `emailIn.recordFetched`: the row, still RECEIVED, becomes FETCHED with what the mail holds (From, To, Cc,
 * subject, Message-ID, In-Reply-To, References, text, sanitised HTML, the attachments' objects) and the event
 * email.inbound_fetched (the sorting handler, sort.ts); a Message-ID another received mail of the tenant already has
 * makes it REJECTED (DUPLICATE) instead.
 *
 * Safe to repeat: only a RECEIVED row is read and moved, so a mail is fetched once however often its event comes (a
 * second worker's puts are left without a row: never listed, removed by a later sweep, as platform/files says). A failed
 * try is counted (`emailIn.fetchFailed`: attempts + 1, lastError) and retried with backoff; after MAX_FETCH_ATTEMPTS, or
 * at once when retrying cannot help (the object is gone or too large, the mail cannot be parsed, files are not set
 * up), the mail is FAILED and shows on "mail to sort", where a person may throw it away.
 */

const [, fetched, sorted] = emailInEvents

const ROW = {
  id: true,
  tenantId: true,
  companyId: true,
  accountId: true,
  s3Bucket: true,
  s3Key: true,
  status: true,
  attempts: true,
  fromAddress: true,
  fromName: true,
  subject: true,
  emailMessageId: true,
} as const satisfies Prisma.InboundEmailSelect
type Row = Prisma.InboundEmailGetPayload<{ select: typeof ROW }>

/** How one try ended: read (FETCHED, or REJECTED as a duplicate), to be tried again, failed for good, or nothing to do. */
export type FetchOutcome = 'fetched' | 'duplicate' | 'retry' | 'failed' | 'settled'

/** A failure no retry can mend. */
class FinalFailure extends Error {
  override name = 'FinalFailure'
}

const errorText = (error: unknown): string => failureText(error instanceof Error ? `${error.name}: ${error.message}` : String(error))

/** Records a failed try; answers whether the job should try again. */
async function recordFailure(caller: CommandCaller, row: Row, error: unknown, final: boolean, causationId: string | undefined): Promise<boolean> {
  const lastError = errorText(error)
  const { result } = await command(caller, { name: 'emailIn.fetchFailed', input: { inboundEmailId: row.id }, ...(causationId ? { causationId } : {}) }, async (tools: CommandTools) => {
    const current = await tools.tx.inboundEmail.findUnique({ where: { id: row.id }, select: { status: true, attempts: true } })
    if (current?.status !== 'RECEIVED') {
      tools.audit({ action: 'emailIn.fetchSkipped', recordType: 'InboundEmail', recordId: row.id, companyId: row.companyId, after: { status: current?.status ?? null } })
      return false
    }
    const attempts = current.attempts + 1
    const failed = final || attempts >= MAX_FETCH_ATTEMPTS
    await tools.tx.inboundEmail.update({
      where: { id: row.id },
      data: { attempts, lastError, version: { increment: 1 }, ...(failed ? { status: 'FAILED', sortedAt: tools.now } : {}) },
      select: { id: true },
    })
    tools.audit({ recordType: 'InboundEmail', recordId: row.id, companyId: row.companyId, before: { status: 'RECEIVED' }, after: { status: failed ? 'FAILED' : 'RECEIVED', attempts, lastError } })
    if (failed) tools.emit(eventFor(sorted, { subject: row.id, companyId: row.companyId, payload: { inboundEmailId: row.id, status: 'FAILED', threadId: null, messageId: null } }))
    return !failed
  })
  return result
}

/** Reads, parses and stores the parts of one mail, outside any transaction. */
async function readMail(runtime: EmailInRuntime, caller: CommandCaller, row: Row): Promise<{ parsed: ParsedMail; sizeBytes: number; attachments: InboundAttachment[] }> {
  let raw: Buffer | null
  try {
    raw = await runtime.raw.fetch(caller, row.accountId, { bucket: row.s3Bucket, key: row.s3Key }, MAX_RAW_BYTES)
  } catch (error) {
    // Too large, another bucket, no key: the adapter's answer is final (not retryable).
    if (error instanceof GatewayCallFailed && !error.retryable) throw new FinalFailure(error.message)
    throw error
  }
  if (!raw) throw new FinalFailure('the raw mail is no longer in the bucket')
  let parsed: ParsedMail
  try {
    parsed = await parseRawMail(raw)
  } catch (error) {
    throw new FinalFailure(`the raw mail cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  const attachments: InboundAttachment[] = []
  const kept = parsed.parts.filter((entry) => entry.kept)
  const files = runtime.files()
  let storeAccountId: string | null = null
  if (kept.length > 0) {
    try {
      storeAccountId = await caller.withClient((client) => storeAccountFor(client, row.companyId))
    } catch (error) {
      if (error instanceof ConflictError) throw new FinalFailure(error.message)
      throw error
    }
  }
  for (const entry of parsed.parts) {
    if (!entry.kept) {
      attachments.push({ kept: false, ...entry.part })
      continue
    }
    attachments.push(await putPart(files, caller, { tenantId: row.tenantId, companyId: row.companyId, storeAccountId: storeAccountId! }, entry.part))
  }
  return { parsed, sizeBytes: raw.length, attachments }
}

/** Reads one received mail (see the module comment). */
export async function fetchInbound(runtime: EmailInRuntime, caller: CommandCaller, inboundEmailId: string, options: { readonly causationId?: string } = {}): Promise<FetchOutcome> {
  const row = await caller.withClient((client) => client.inboundEmail.findUnique({ where: { id: inboundEmailId }, select: ROW }))
  if (!row || row.status !== 'RECEIVED') return 'settled'

  let mail: Awaited<ReturnType<typeof readMail>>
  try {
    mail = await readMail(runtime, caller, row)
  } catch (error) {
    // Retrying mends what the gateway refused or a store that did not answer (and anything unexpected, counted).
    const final = error instanceof FinalFailure || (error instanceof GatewayCallFailed && !error.retryable)
    return (await recordFailure(caller, row, error, final, options.causationId)) ? 'retry' : 'failed'
  }

  const { parsed } = mail
  const { result } = await command(caller, { name: 'emailIn.recordFetched', input: { inboundEmailId }, ...(options.causationId ? { causationId: options.causationId } : {}) }, async (tools) => {
    const { tx, now } = tools
    const current = await tx.inboundEmail.findUnique({ where: { id: inboundEmailId }, select: { status: true, attempts: true } })
    if (current?.status !== 'RECEIVED') {
      tools.audit({ action: 'emailIn.fetchSkipped', recordType: 'InboundEmail', recordId: inboundEmailId, companyId: row.companyId, after: { status: current?.status ?? null } })
      return 'settled' as const
    }
    // The notification's Message-ID wins (SES read the same header); a mail without one in the notification takes the
    // parsed one, unless another received mail of the tenant has it: then this one is the same mail again.
    const messageId = row.emailMessageId ?? parsed.emailMessageId
    const taken =
      row.emailMessageId === null && messageId !== null
        ? await tx.inboundEmail.findFirst({ where: { emailMessageId: messageId, id: { not: inboundEmailId } }, select: { id: true } })
        : null
    const status = taken ? 'REJECTED' : 'FETCHED'
    await tx.inboundEmail.update({
      where: { id: inboundEmailId },
      data: {
        fromAddress: row.fromAddress ?? parsed.from.address,
        fromName: parsed.from.name ?? row.fromName,
        to: [...parsed.to],
        cc: [...parsed.cc],
        subject: parsed.subject ?? row.subject,
        emailMessageId: taken ? null : messageId,
        inReplyTo: parsed.inReplyTo,
        referenceIds: [...parsed.referenceIds],
        sizeBytes: mail.sizeBytes,
        bodyText: parsed.text,
        bodyHtml: parsed.html,
        attachments: mail.attachments as unknown as Prisma.InputJsonValue,
        attempts: current.attempts + 1,
        lastError: null,
        fetchedAt: now,
        status,
        ...(taken ? { rejectReason: 'DUPLICATE', sortedAt: now } : {}),
        version: { increment: 1 },
      },
      select: { id: true },
    })
    tools.audit({
      recordType: 'InboundEmail',
      recordId: inboundEmailId,
      companyId: row.companyId,
      before: { status: 'RECEIVED' },
      after: {
        status,
        sizeBytes: mail.sizeBytes,
        attachments: mail.attachments.map((part) => (part.kept ? { kept: true, contentType: part.contentType, sizeBytes: part.sizeBytes } : { kept: false, contentType: part.contentType, sizeBytes: part.sizeBytes, reason: part.reason })),
        ...(taken ? { rejectReason: 'DUPLICATE', duplicateOf: taken.id } : {}),
      },
    })
    const where = { subject: inboundEmailId, companyId: row.companyId }
    if (taken) tools.emit(eventFor(sorted, { ...where, payload: { inboundEmailId, status: 'REJECTED', threadId: null, messageId: null } }))
    else tools.emit(eventFor(fetched, { ...where, payload: { inboundEmailId } }))
    return taken ? ('duplicate' as const) : ('fetched' as const)
  })
  return result
}

export const EMAIL_FETCH_HANDLER = 'emailIn.fetch'
const receivedPayload = emailInEvents[0].payload

/**
 * The worker's handler of email.inbound_received (background.ts HANDLERS). A try that should be repeated throws, so
 * BullMQ retries it with backoff (MAX_FETCH_ATTEMPTS tries); a mail read, failed for good or settled ends the job.
 */
export function emailFetchHandler(runtime: () => EmailInRuntime = processEmailIn): EventHandler {
  return defineHandler({
    name: EMAIL_FETCH_HANDLER,
    events: ['email.inbound_received'],
    attempts: MAX_FETCH_ATTEMPTS,
    async handle(event, tools) {
      const { inboundEmailId } = receivedPayload.parse(event.payload)
      const outcome = await fetchInbound(runtime(), tools.caller, inboundEmailId, { causationId: event.eventId })
      if (outcome === 'retry') throw new Error(`received mail ${inboundEmailId} was not read this time; it will be tried again`)
    },
  })
}
