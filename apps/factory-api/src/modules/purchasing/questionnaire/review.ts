import type { FastifyInstance, FastifyRequest } from 'fastify'
import { InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { cleanSites, filesOf, type AnswerEntry, type SiteRow } from '@nexus/factory-domain/purchasing/questionnaire/answers'
import { QUESTIONNAIRE_MANAGE, QUESTIONNAIRE_REVIEW, QUESTIONNAIRE_SEND, QUESTIONNAIRE_VIEW } from '@nexus/factory-domain/purchasing/questionnaire/permissions'
import { categoryOf, DOCUMENT_CATEGORIES, questionsOf, type Question } from '@nexus/factory-domain/purchasing/questionnaire/questions'
import { answerStateOf, questionsMessage, reviewProblems, type ReviewDecision } from '@nexus/factory-domain/purchasing/questionnaire/rules'
import { events as taskEvents } from '@nexus/factory-domain/tasks/events'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { actorOf } from '../../../core/context'
import { appClock, commandOn } from '../../../platform/portal/tasks/clock'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'
import { senderOf } from './send'
import { ANSWER_COLUMNS, answerPdfsOf, answersOf, currentVersion, linksOf, linkStateOf, namesOf, RECORD, reviewTaskId, versionsOf, versionView } from './store'

/**
 * The buyer's side of the questionnaire on the supplier's record (B-W2b-172; SCM-023; design purchasing.suppliers
 * "Links › Supplier questionnaire — Onboarding", "answers reviewed, versioned"; links.onboard sec:done "Paolo reviews it"):
 *
 *   GET  /purchasing/suppliers/:partyId/questionnaire   purchasing.questionnaire.view over the supplier's company (a
 *        tenant-wide supplier: the screen's company): the company's questionnaire (the newest published version, a draft),
 *        the links sent (open, answered, expired, withdrawn; to whom, by whom), the answers newest first (each with its
 *        version, answers, sites, documents and their state, the PDF kept, the review and its task), the supplier's
 *        contacts with an e-mail (where a link may go), and what the person may do.
 *   POST /purchasing/questionnaire-answers/:responseId/review {decision, note?, questions?, version}
 *        purchasing.questionnaire.review: ONE command on the answer's version (set once, the database holds it):
 *        ACCEPTED — each document of the answer is tagged with its question's kind and the expiry the supplier gave, and
 *        shared back with the supplier (PARTNER), so the required-document rules and the expiry reminders see it (B-W2b-177);
 *        QUESTIONS — the buyer's questions go on the supplier's thread (OUTBOUND, shared with its party); asked again, the
 *        supplier answers with a new link (a new answer). Either way the review task is done.
 */

const [, , taskCompleted] = taskEvents
export const QUESTIONNAIRE_LIVE_EVENTS = ['supplier_questionnaire.link_sent', 'supplier_questionnaire.answered', 'supplier_questionnaire.reviewed', 'supplier_questionnaire.published'] as const

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const sitesOf = (value: unknown): SiteRow[] => (Array.isArray(value) ? cleanSites(value.filter((row): row is SiteRow => isRecord(row) && typeof row.name === 'string' && typeof row.country === 'string').map((row) => ({ ...row, steps: Array.isArray(row.steps) ? row.steps : [] }))) : [])
const answersMap = (value: unknown): Record<string, AnswerEntry> => (isRecord(value) ? (value as Record<string, AnswerEntry>) : {})
const dayOf = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10))

/** The supplier and the company whose questionnaire it is, as the office person reads it; else the one 404. */
async function supplierOf(request: FastifyRequest, partyId: string) {
  const party = isUuid(partyId) ? await request.withClient((client) => client.party.findUnique({ where: { id: partyId }, select: { id: true, code: true, legalName: true, tradeName: true, language: true, companyId: true } })) : null
  if (!party) throw new NotFoundError('Supplier not found.')
  const { context, companyId } = senderOf(request, party)
  const actor = actorOf(context)
  if (!can(actor, QUESTIONNAIRE_VIEW, { companyId, partyId })) throw new NotFoundError('Supplier not found.')
  return { party, context, companyId, actor }
}

/** GET /purchasing/suppliers/:partyId/questionnaire. */
export async function supplierQuestionnaire(app: FastifyInstance, request: FastifyRequest, partyId: string) {
  const { party, companyId, actor } = await supplierOf(request, partyId)
  const now = appClock(app).now()
  const read = await request.withClient(async (client) => {
    const versions = await versionsOf(client, companyId)
    const current = await currentVersion(client, companyId)
    const links = await linksOf(client, companyId, party.id)
    const answers = await answersOf(client, companyId, party.id)
    const pdfs = await answerPdfsOf(client, answers.map((row) => row.id))
    const fileIds = answers.flatMap((row) => {
      const version = versions.find((entry) => entry.id === row.questionnaireId)
      return filesOf(questionsOf(version?.questions), answersMap(row.answers)).map((file) => file.fileId)
    })
    const files = new Map(
      (fileIds.length + pdfs.size === 0
        ? []
        : await client.storedFile.findMany({ where: { id: { in: [...fileIds, ...pdfs.values()] } }, select: { id: true, originalName: true, contentType: true, status: true, category: true, expiresOn: true } })
      ).map((row) => [row.id, row] as const),
    )
    const tasks = new Map((answers.length === 0 ? [] : await client.task.findMany({ where: { id: { in: answers.map((row) => reviewTaskId(row.id)) } }, select: { id: true, status: true, assigneeId: true, dueDate: true } })).map((row) => [row.id, row] as const))
    const names = await namesOf(client, [...links.map((row) => row.createdById), ...answers.map((row) => row.reviewedById), ...[...tasks.values()].map((row) => row.assigneeId)])
    const contacts = await client.partyContact.findMany({ where: { partyId: party.id, status: 'ACTIVE', email: { not: null } }, orderBy: { createdAt: 'asc' }, take: 50, select: { id: true, name: true, email: true, language: true } })
    return { versions, current, links, answers, pdfs, files, tasks, names, contacts }
  })
  const versionById = new Map(read.versions.map((row) => [row.id, row] as const))
  const answeredBy = new Map(read.answers.filter((row) => row.linkId !== null).map((row) => [row.linkId!, row.id] as const))
  const draft = read.versions.find((row) => row.publishedAt === null) ?? null
  return {
    party: { id: party.id, code: party.code, name: party.tradeName ?? party.legalName, language: party.language },
    companyId,
    current: read.current ? versionView(read.current) : null,
    draft: draft ? { id: draft.id, revision: draft.revision } : null,
    versions: read.versions.filter((row) => row.publishedAt !== null && read.answers.some((answer) => answer.questionnaireId === row.id)).map(versionView),
    links: read.links.map((row) => ({
      id: row.id,
      state: linkStateOf(row, now),
      email: row.email,
      note: row.note,
      sentAt: toUtcIso(row.createdAt),
      sentByName: read.names.get(row.createdById) ?? null,
      expiresAt: toUtcIso(row.expiresAt),
      answerId: answeredBy.get(row.id) ?? null,
    })),
    answers: read.answers.map((row) => {
      const version = versionById.get(row.questionnaireId)
      const questions = questionsOf(version?.questions)
      const answers = answersMap(row.answers)
      const pdfId = read.pdfs.get(row.id) ?? null
      const pdf = pdfId ? read.files.get(pdfId) : undefined
      const task = read.tasks.get(reviewTaskId(row.id))
      return {
        id: row.id,
        questionnaireId: row.questionnaireId,
        revision: version?.revision ?? 0,
        state: answerStateOf(row.decision),
        via: row.linkId ? ('LINK' as const) : ('PORTAL' as const),
        linkId: row.linkId,
        submittedAt: toUtcIso(row.submittedAt),
        signedName: row.signedName,
        signedRole: row.signedRole,
        answers,
        sites: sitesOf(row.sites),
        subTierSites: sitesOf(row.subTierSites),
        documents: filesOf(questions, answers).map((document) => {
          const file = read.files.get(document.fileId)
          return {
            key: document.key,
            fileId: document.fileId,
            name: file?.originalName ?? '',
            contentType: file?.contentType ?? '',
            status: file?.status ?? 'DELETED',
            category: categoryOf(document.question),
            issuer: document.issuer ?? null,
            number: document.number ?? null,
            issuedOn: document.issuedOn ?? null,
            expiresOn: document.expiresOn ?? null,
            inForce: (DOCUMENT_CATEGORIES as readonly string[]).includes(file?.category ?? ''),
          }
        }),
        pdf: pdf ? { fileId: pdf.id, name: pdf.originalName } : null,
        review: row.reviewedAt ? { at: toUtcIso(row.reviewedAt), byName: row.reviewedById ? (read.names.get(row.reviewedById) ?? null) : null, note: row.reviewNote } : null,
        task: task ? { id: task.id, open: task.status === 'OPEN', assigneeName: task.assigneeId ? (read.names.get(task.assigneeId) ?? null) : null, dueDate: dayOf(task.dueDate) } : null,
        version: row.version,
      }
    }),
    contacts: read.contacts.map((row) => ({ id: row.id, name: row.name, email: row.email!, language: row.language })),
    may: {
      send: can(actor, QUESTIONNAIRE_SEND, { companyId, partyId: party.id }),
      review: can(actor, QUESTIONNAIRE_REVIEW, { companyId, partyId: party.id }),
      manage: can(actor, QUESTIONNAIRE_MANAGE, { companyId }),
    },
    live: { events: [...QUESTIONNAIRE_LIVE_EVENTS] },
  }
}

export interface ReviewBody {
  readonly decision: ReviewDecision
  readonly note?: string | null | undefined
  readonly questions?: string | null | undefined
  readonly version: number
}

/** POST /purchasing/questionnaire-answers/:responseId/review. */
export async function reviewAnswer(app: FastifyInstance, request: FastifyRequest, responseId: string, body: ReviewBody, idempotencyKey?: string) {
  const row = isUuid(responseId) ? await request.withClient((client) => client.supplierQuestionnaireResponse.findUnique({ where: { id: responseId }, select: ANSWER_COLUMNS })) : null
  if (!row) throw new NotFoundError('Answer not found.')
  const { context, party, actor } = await supplierOf(request, row.partyId)
  if (!can(actor, QUESTIONNAIRE_REVIEW, { companyId: row.companyId, partyId: row.partyId })) throw new NotFoundError('Answer not found.')
  if (row.decision !== null) throw new InvalidStateError(row.decision === 'ACCEPTED' ? 'This answer was accepted already.' : 'Questions on this answer were sent already: the supplier answers again with a new link.')
  const problems = reviewProblems(body)
  if (problems.length > 0) throw new ValidationError('The review is not valid.', problems)
  const version = await request.withClient((client) => client.supplierQuestionnaire.findUnique({ where: { id: row.questionnaireId }, select: { revision: true, questions: true } }))
  const questions: Question[] = questionsOf(version?.questions)
  const documents = filesOf(questions, answersMap(row.answers))
  const note = body.note?.trim() || null
  const words = body.questions?.trim() ?? ''
  const locale = party.language === 'en' ? 'en' : 'it'
  const { result } = await commandOn(
    app,
    request,
    { name: 'purchasing.questionnaire.review', idempotencyKey, input: { responseId, decision: body.decision, note, questions: words.length }, record: { type: 'SupplierQuestionnaireResponse', id: responseId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const updated = await tx.supplierQuestionnaireResponse.updateMany({ where: { id: responseId, decision: null }, data: { decision: body.decision, reviewedAt: now, reviewedById: context.actorId, reviewNote: note, updatedAt: now } })
      if (updated.count !== 1) throw new InvalidStateError('This answer was reviewed meanwhile: read it again.')
      let tagged = 0
      let messageId: string | null = null
      if (body.decision === 'ACCEPTED') {
        // Each document of the answer is in force from now: its kind and expiry, shared back with the supplier.
        for (const document of documents) {
          const file = await tx.storedFile.findFirst({ where: { id: document.fileId, recordType: 'Party', recordId: row.partyId, status: 'AVAILABLE' }, select: { id: true, visibility: true, category: true } })
          if (!file) continue
          const expiresOn = document.expiresOn ? new Date(`${document.expiresOn}T00:00:00.000Z`) : null
          const visibility = [...new Set([...file.visibility, 'OFFICE', 'PARTNER'] as const)]
          await tx.storedFile.update({ where: { id: file.id }, data: { category: categoryOf(document.question), expiresOn, expiryRemindedAt: null, visibility, partyId: row.partyId, updatedAt: now }, select: { id: true } })
          tools.audit({ action: 'purchasing.questionnaire.acceptDocument', recordType: 'StoredFile', recordId: file.id, companyId: row.companyId, before: { category: file.category, visibility: file.visibility }, after: { category: categoryOf(document.question), expiresOn: document.expiresOn ?? null, visibility, responseId, question: document.key } })
          tagged++
        }
      } else {
        // The questions go on the supplier's thread, shared with its party (it answers again with a new link).
        const { thread } = await ensureThread(tools, { type: 'Party', id: row.partyId }, context.actorId)
        const author = await tx.user.findUnique({ where: { id: context.actorId }, select: { displayName: true } })
        const message = await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'APP', author: { kind: 'USER', id: context.actorId, name: author?.displayName ?? null }, bodyText: cleanBody(questionsMessage(locale, { questions: words, revision: version?.revision ?? 0 })) })
        messageId = message.id
      }
      // The review task is done (when it is still open).
      const taskId = reviewTaskId(responseId)
      const task = await tx.task.findUnique({ where: { id: taskId }, select: { id: true, status: true, companyId: true, siteId: true, recordType: true, recordId: true } })
      if (task?.status === 'OPEN') {
        const closed = await tx.task.updateMany({ where: { id: taskId, status: 'OPEN' }, data: { status: 'DONE', closedAt: now, closedById: context.actorId, snoozedUntil: null, version: { increment: 1 }, updatedAt: now } })
        if (closed.count === 1) {
          tools.audit({ action: 'tasks.status', recordType: 'Task', recordId: taskId, companyId: task.companyId, siteId: task.siteId, before: { status: 'OPEN' }, after: { status: 'DONE', by: 'questionnaire' } })
          tools.emit(eventFor(taskCompleted, { subject: taskId, companyId: task.companyId, siteId: task.siteId, payload: { taskId, recordType: task.recordType, recordId: task.recordId } }))
        }
      }
      tools.audit({ action: 'purchasing.questionnaire.review', recordType: RECORD, recordId: responseId, companyId: row.companyId, before: { decision: null }, after: { decision: body.decision, documents: tagged, messageId, noted: note !== null } })
      tools.emit({ type: 'supplier_questionnaire.reviewed', subject: responseId, companyId: row.companyId, payload: { responseId, partyId: row.partyId, questionnaireId: row.questionnaireId, revision: version?.revision ?? 1, decision: body.decision, documents: tagged } })
      return { id: responseId, state: body.decision, documents: tagged, messageId }
    },
  )
  return result
}
