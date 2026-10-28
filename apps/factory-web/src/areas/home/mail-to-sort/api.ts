import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import {
  HELD_REASONS,
  INBOUND_STATUSES,
  MAIL_VERDICTS,
  MATCHED_BY,
  REJECT_REASONS,
  SKIP_REASONS,
  TO_SORT,
  type MailDetail,
  type MailFilter,
  type MailSummary,
  type PersonRejectReason,
  type RecordCandidate,
} from './model'

/**
 * "Mail to sort"'s calls to the factory API (apps/factory-api CLAUDE.md "Email in"), through the ONE client: the list
 * (`GET /email/inbound`, default TRIAGE + HELD + FAILED), one mail (`GET /email/inbound/:id`), and the three answers —
 * assign to a record, release a held mail, throw it away — each with the mail's version as read (COL-078: a mail the
 * worker or a colleague moved meanwhile is a 409, never overwritten) and an Idempotency-Key.
 */

const verdict = z.enum(MAIL_VERDICTS)
const summaryShape = {
  id: z.string(),
  status: z.enum(INBOUND_STATUSES),
  receivedAt: z.string(),
  from: z.object({ address: z.string().nullable(), name: z.string().nullable() }),
  subject: z.string().nullable(),
  excerpt: z.string(),
  verdicts: z.object({ spf: verdict, dkim: verdict, dmarc: verdict, dmarcPolicy: z.string().nullable(), spam: verdict, virus: verdict }),
  heldReason: z.enum(HELD_REASONS).nullable(),
  rejectReason: z.enum(REJECT_REASONS).nullable(),
  matchedBy: z.enum(MATCHED_BY).nullable(),
  threadId: z.string().nullable(),
  suggestion: z.object({ partyId: z.string().nullable(), contactId: z.string().nullable() }),
  attachmentCount: z.number().int(),
  version: z.number().int(),
}
const summarySchema = z.object(summaryShape)
const detailSchema = z.object({
  ...summaryShape,
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bodyText: z.string().nullable(),
  bodyHtml: z.string().nullable(),
  attachments: z.array(
    z.object({
      name: z.string(),
      contentType: z.string(),
      sizeBytes: z.number().int(),
      kept: z.boolean(),
      skipReason: z.enum(SKIP_REASONS).nullable(),
      file: z.object({ id: z.string() }).nullable(),
    }),
  ),
  thread: z.object({ id: z.string(), recordType: z.string(), recordId: z.string(), status: z.enum(['OPEN', 'CLOSED']) }).nullable(),
  attempts: z.number().int(),
  fetchedAt: z.string().nullable(),
})
const oneMail = z.object({ mail: detailSchema })

function summaryOf(mail: z.infer<typeof summarySchema>): MailSummary {
  return {
    id: mail.id,
    status: mail.status,
    receivedAt: mail.receivedAt,
    from: mail.from,
    subject: mail.subject,
    excerpt: mail.excerpt,
    verdicts: mail.verdicts,
    heldReason: mail.heldReason,
    rejectReason: mail.rejectReason,
    threadId: mail.threadId,
    suggestedPartyId: mail.suggestion.partyId,
    attachmentCount: mail.attachmentCount,
    version: mail.version,
  }
}

function detailOf(mail: z.infer<typeof detailSchema>): MailDetail {
  return {
    ...summaryOf(mail),
    to: mail.to,
    cc: mail.cc,
    bodyText: mail.bodyText,
    bodyHtml: mail.bodyHtml,
    attachments: mail.attachments.map((attachment) => ({
      name: attachment.name,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      kept: attachment.kept,
      skipReason: attachment.skipReason,
      fileId: attachment.file?.id ?? null,
    })),
    thread: mail.thread ? { recordType: mail.thread.recordType, recordId: mail.thread.recordId, status: mail.thread.status } : null,
    attempts: mail.attempts,
    fetchedAt: mail.fetchedAt,
  }
}

const mailPath = (id: string) => `/email/inbound/${encodeURIComponent(id)}`

/** GET /email/inbound: the mail to sort (or one place), newest first, a page at a time. */
export async function listMail(api: ApiClient, filter: MailFilter, cursor?: string | null, signal?: AbortSignal): Promise<{ mails: MailSummary[]; nextCursor: string | null }> {
  const answer = await api.get('/email/inbound', {
    query: { status: filter === 'all' ? undefined : filter, cursor: cursor ?? undefined, limit: 50 },
    schema: z.object({ mails: z.array(summarySchema), nextCursor: z.string().nullable() }),
    signal,
  })
  // The default list is TO_SORT; a mail sorted between two pages may still come back once: keep only what waits.
  const wanted: readonly string[] = filter === 'all' ? TO_SORT : [filter]
  return { mails: answer.mails.filter((mail) => wanted.includes(mail.status)).map(summaryOf), nextCursor: answer.nextCursor }
}

/** GET /email/inbound/:id: one mail with its sanitised body and attachments. */
export async function getMail(api: ApiClient, id: string, signal?: AbortSignal): Promise<MailDetail> {
  return detailOf((await api.get(mailPath(id), { schema: oneMail, signal })).mail)
}

/** POST …/assign: the mail joins the record's thread; its files become the record's (COL-025). */
export async function assignMail(api: ApiClient, mail: Pick<MailSummary, 'id' | 'version'>, record: Pick<RecordCandidate, 'type' | 'id'>): Promise<MailDetail> {
  const answer = await api.post(`${mailPath(mail.id)}/assign`, {
    body: { recordType: record.type, recordId: record.id, version: mail.version },
    schema: oneMail,
    idempotencyKey: newIdempotencyKey(),
  })
  return detailOf(answer.mail)
}

/** POST …/release: a HELD mail goes into the thread it named, or back to the list. */
export async function releaseMail(api: ApiClient, mail: Pick<MailSummary, 'id' | 'version'>, reason?: string): Promise<MailDetail> {
  const trimmed = reason?.trim()
  const answer = await api.post(`${mailPath(mail.id)}/release`, {
    body: { version: mail.version, ...(trimmed ? { reason: trimmed } : {}) },
    schema: oneMail,
    idempotencyKey: newIdempotencyKey(),
  })
  return detailOf(answer.mail)
}

/** POST …/reject: thrown away as spam, or as not for us. Nothing is deleted; it leaves the list. */
export async function rejectMail(api: ApiClient, mail: Pick<MailSummary, 'id' | 'version'>, reason: PersonRejectReason, note?: string): Promise<MailDetail> {
  const trimmed = note?.trim()
  const answer = await api.post(`${mailPath(mail.id)}/reject`, {
    body: { reason, version: mail.version, ...(trimmed ? { note: trimmed } : {}) },
    schema: oneMail,
    idempotencyKey: newIdempotencyKey(),
  })
  return detailOf(answer.mail)
}

/**
 * The records a mail can be assigned to, found by number. The API has no record search yet, so each record type that
 * has a thread brings its own finder here, from its module's list (W0: certificates, `GET /compliance/certificates`;
 * W1 adds quotes, orders, purchase orders …). A finder the person may not use (403) finds nothing.
 */
export interface RecordFinder {
  type: string
  find: (api: ApiClient, signal?: AbortSignal) => Promise<RecordCandidate[]>
}

const certificatesSchema = z.object({
  certificates: z.array(z.object({ id: z.string(), holderPartyId: z.string().nullable(), standard: z.string(), ppeClass: z.string().nullable(), number: z.string() })),
})

export const RECORD_FINDERS: readonly RecordFinder[] = [
  {
    type: 'Certificate',
    find: async (api, signal) =>
      (await api.get('/compliance/certificates', { schema: certificatesSchema, signal })).certificates.map((certificate) => ({
        type: 'Certificate',
        id: certificate.id,
        number: certificate.number,
        title: certificate.ppeClass ? `${certificate.standard} · ${certificate.ppeClass}` : certificate.standard,
        // A brand-held certificate's thread has the brand as its party; a company-held one has none.
        hasParty: certificate.holderPartyId !== null,
      })),
  },
]

/** Every finder's records; one that is refused or fails adds nothing, the others still answer. */
export async function findRecords(api: ApiClient, finders: readonly RecordFinder[] = RECORD_FINDERS, signal?: AbortSignal): Promise<RecordCandidate[]> {
  const found = await Promise.all(
    finders.map(async (finder) => {
      try {
        return await finder.find(api, signal)
      } catch (error) {
        if (isApiError(error) && (error.kind === 'forbidden' || error.kind === 'not_found')) return []
        throw error
      }
    }),
  )
  return found.flat()
}

/** Whether an answer says the mail changed since it was read (COL-078: its version, or its place, moved meanwhile). */
function movedMeanwhile(error: { code: string; issues: readonly { path?: unknown }[] }): boolean {
  if (error.code === 'invalid_state') return true
  return error.issues.some((issue) => (Array.isArray(issue.path) ? issue.path[0] : issue.path) === 'version')
}

/**
 * The notice for an answer (assign, release, reject) that failed: a message key of the `home` catalogue. A mail that
 * moved meanwhile (the worker, a colleague) is read again and says so; a record whose thread cannot take mail (no
 * customer or supplier) says that; the rest in plain words. Never the API's own English message.
 */
export function answerProblem(error: unknown): { key: string; tone: 'warning' | 'danger'; reload: boolean } {
  if (!isApiError(error)) return { key: 'mailToSort.notice.failed', tone: 'danger', reload: false }
  switch (error.kind) {
    case 'conflict':
      return movedMeanwhile(error) ? { key: 'mailToSort.notice.conflict', tone: 'warning', reload: true } : { key: 'mailToSort.notice.cannot', tone: 'warning', reload: true }
    case 'not_found':
      return { key: 'mailToSort.notice.notFound', tone: 'warning', reload: true }
    case 'forbidden':
    case 'step_up':
      return { key: 'mailToSort.notice.forbidden', tone: 'danger', reload: false }
    case 'invalid':
      return { key: 'mailToSort.notice.invalid', tone: 'danger', reload: false }
    case 'signed_out':
      return { key: 'mailToSort.notice.signedOut', tone: 'danger', reload: false }
    case 'rate_limited':
      return { key: 'mailToSort.notice.rateLimited', tone: 'warning', reload: false }
    case 'unavailable':
      return { key: 'mailToSort.notice.unavailable', tone: 'danger', reload: false }
    default:
      return { key: 'mailToSort.notice.failed', tone: 'danger', reload: false }
  }
}

/** The message key for a list or a mail that could not be read. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'mailToSort.problem.read'
  if (error.kind === 'forbidden') return 'mailToSort.problem.forbidden'
  if (error.kind === 'not_found') return 'mailToSort.problem.notFound'
  if (error.kind === 'signed_out') return 'mailToSort.notice.signedOut'
  if (error.kind === 'unavailable') return 'mailToSort.problem.unavailable'
  return 'mailToSort.problem.read'
}
