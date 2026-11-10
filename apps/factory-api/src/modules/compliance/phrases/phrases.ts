import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { PHRASES_APPROVE, PHRASES_MANAGE } from '@nexus/factory-domain/compliance/phrases/permissions'
import { approveRefusal, nextRevision, phraseProblems, proposeRefusal, type PhraseKind, type TranslationStatus } from '@nexus/factory-domain/compliance/phrases/rules'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { holds } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { activeMarkets } from '../markets/markets'
import { assertMayKeep, mayReadCompany, namesFor, officeOf, rulesClock, rulesGuarded, type Reader } from '../register-of-rules/common'
import type { PhraseView } from './contract'
import { approvedTexts, factsOf, PHRASE_SELECT, phraseViews, readPhrases, TRANSLATION_SELECT, translationsOf, type PhraseRow } from './store'

/**
 * The phrase library (B-W2b-249; PRD-343): warnings, care, marking, DoC, user information and claim phrases with their
 * approved translations, versioned. Reading needs compliance.certificates.view; a phrase is kept with
 * compliance.phrases.manage over its company (a phrase of every company: over every company), which also proposes and
 * withdraws translations; compliance.phrases.approve approves one — never one's own proposal (the database refuses it
 * too). Each write is ONE command with its audit row and an event (`compliance_rules.phrase_changed`,
 * `compliance_rules.translation_changed`); a phrase's translations are serialised by an advisory lock per phrase.
 *
 * New source words are the phrase's next revision (one UPDATE: the database's rule); the approved translations of the
 * older words stay on record, shown STALE, and a label must not print them (approvedTexts gives null) until a translation
 * of the current words is approved. Approving supersedes the language's approved translation first, then approves the
 * draft (one APPROVED per language).
 */

const settings = () => ({ ...COMMAND_SETTINGS, clock: rulesClock() })
const refused = (refusal: { code: string; message: string }, status: 'conflict' | 'validation_failed' = 'conflict') =>
  new DomainError(status, refusal.message, [{ path: status === 'conflict' ? `refusal/${refusal.code}` : 'body', message: refusal.message }])

/** The languages the switched-on markets need (label, DoC, user information), sorted. */
async function marketLanguagesOf(db: Reader, context: OfficeContext): Promise<string[]> {
  const markets = (await activeMarkets(db, context)).filter((market) => market.switchedOn)
  return [...new Set(markets.flatMap((market) => [...market.labelLanguages, ...market.docLanguages, ...market.userInfoLanguages]))].sort()
}

/** GET /compliance/rules/phrases */
export async function listPhrases(request: FastifyRequest, query: { readonly kind?: PhraseKind | undefined; readonly status?: 'ACTIVE' | 'ARCHIVED' | 'ALL' | undefined; readonly q?: string | undefined; readonly languages?: string[] | undefined }) {
  const context = officeOf(request)
  const actor = actorOf(context)
  const filters: Prisma.PhraseWhereInput[] = []
  if (query.kind) filters.push({ kind: query.kind })
  const status = query.status ?? 'ACTIVE'
  if (status !== 'ALL') filters.push({ status })
  if (query.q) filters.push({ OR: [{ key: { contains: query.q, mode: 'insensitive' } }, { sourceText: { contains: query.q, mode: 'insensitive' } }] })
  return request.withClient(async (db) => {
    const languages = query.languages ?? (await marketLanguagesOf(db, context))
    const rows = await readPhrases(db, context, { AND: filters })
    return { phrases: await phraseViews(db, rows, languages), languages, asOf: toUtcIso(rulesClock().now()), mayManage: mayWrite(actor, PHRASES_MANAGE, null), mayApprove: holds(actor, PHRASES_APPROVE) }
  })
}

async function readPhrase(db: Reader, context: OfficeContext, key: string): Promise<PhraseRow> {
  const row = await db.phrase.findFirst({ where: { key }, select: PHRASE_SELECT })
  if (!row || !mayReadCompany(actorOf(context), row.companyId)) throw new NotFoundError(`There is no phrase ${key}.`)
  return row
}

/** GET /compliance/rules/phrases/:key — the phrase, its cells and every translation it ever had. */
export async function getPhrase(request: FastifyRequest, key: string) {
  const context = officeOf(request)
  return request.withClient(async (db) => {
    const row = await readPhrase(db, context, key)
    const [phrase] = await phraseViews(db, [row], await marketLanguagesOf(db, context))
    const history = (await translationsOf(db, [row.id], 'ALL')).get(row.id) ?? []
    const person = await namesFor(db, history.flatMap((entry) => [entry.translatedById ?? entry.createdById, entry.approvedById]))
    return {
      phrase: phrase!,
      history: history.map((entry) => ({
        id: entry.id,
        language: entry.language,
        revision: entry.revision,
        text: entry.text,
        status: entry.status as TranslationStatus,
        sourceRevision: entry.sourceRevision,
        proposedBy: person(entry.translatedById ?? entry.createdById),
        proposedAt: toUtcIso(entry.createdAt),
        approvedBy: person(entry.approvedById),
        approvedAt: entry.approvedAt ? toUtcIso(entry.approvedAt) : null,
      })),
    }
  })
}

/** GET /compliance/rules/phrases/texts?keys=&languages= — what prints (labels, DoCs, leaflets); null: missing. */
export async function phraseTexts(request: FastifyRequest, query: { readonly keys: string[]; readonly languages: string[] }) {
  officeOf(request)
  return { texts: await request.withClient((db) => approvedTexts(db, query.keys, query.languages)) }
}

const auditOf = (row: PhraseRow) => ({ key: row.key, kind: row.kind, companyId: row.companyId, sourceLanguage: row.sourceLanguage, revision: row.revision, status: row.status })

async function viewOf(db: Reader, context: OfficeContext, row: PhraseRow): Promise<PhraseView> {
  return (await phraseViews(db, [row], await marketLanguagesOf(db, context)))[0]!
}

const lockPhrase = (tools: CommandTools, phraseId: string) => tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.phrase', ${phraseId}::uuid), 0))`

export interface CreateBody {
  readonly key: string
  readonly kind: PhraseKind
  readonly sourceLanguage?: string | undefined
  readonly sourceText: string
  readonly note?: string | null | undefined
  readonly companyId?: string | null | undefined
}

const takenWords = (key: string) => `There is a phrase ${key} already (perhaps archived): edit or restore it.`

/** POST /compliance/rules/phrases */
export async function createPhrase(caller: CommandCaller, body: CreateBody, key: string | null | undefined): Promise<{ phrase: PhraseView }> {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  assertMayKeep(context, PHRASES_MANAGE, companyId, 'A phrase')
  const problems = phraseProblems(body)
  if (problems.length > 0) throw new ValidationError('The phrase is not valid.', problems)
  const { result } = await rulesGuarded(
    () =>
      runCommand(
        caller,
        { name: 'compliance.phrases.create', idempotencyKey: key, input: body },
        async (tools) => {
          const { tx, now, audit, emit } = tools
          if (await tx.phrase.findFirst({ where: { key: body.key }, select: { id: true } })) throw new ConflictError(takenWords(body.key))
          if (companyId && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
          const id = newId()
          const row = await tx.phrase.create({
            data: { id, key: body.key, kind: body.kind, companyId, sourceLanguage: body.sourceLanguage ?? 'it', sourceText: body.sourceText, note: body.note ?? null, createdAt: now, updatedAt: now, createdById: context.actorId },
            select: PHRASE_SELECT,
          })
          audit({ recordType: 'Phrase', recordId: id, companyId, after: auditOf(row) })
          emit({ type: 'compliance_rules.phrase_changed', subject: id, companyId, payload: { phraseId: id, key: row.key, revision: row.revision, change: 'CREATED' } })
          return { phrase: await viewOf(tx, context, row) }
        },
        settings(),
      ),
    { taken: takenWords(body.key) },
  )
  return result
}

export interface EditBody {
  readonly version: number
  readonly kind?: PhraseKind | undefined
  readonly sourceText?: string | undefined
  readonly sourceLanguage?: string | undefined
  readonly note?: string | null | undefined
  readonly status?: 'ACTIVE' | 'ARCHIVED' | undefined
}

/** PATCH /compliance/rules/phrases/:key */
export async function editPhrase(caller: CommandCaller, phraseKey: string, body: EditBody, key: string | null | undefined): Promise<{ phrase: PhraseView }> {
  const context = officeOf(caller)
  const known = await caller.withClient((db) => readPhrase(db, context, phraseKey))
  assertMayKeep(context, PHRASES_MANAGE, known.companyId, 'A phrase')
  const problems = phraseProblems(body)
  if (problems.length > 0) throw new ValidationError('The phrase is not valid.', problems)
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.phrases.edit', idempotencyKey: key, input: { phraseKey, ...body }, record: { type: 'Phrase', id: known.id, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit, emit } = tools
        await lockPhrase(tools, known.id)
        const before = await tx.phrase.findUniqueOrThrow({ where: { id: known.id }, select: PHRASE_SELECT })
        const sourceText = body.sourceText ?? before.sourceText
        const sourceLanguage = body.sourceLanguage ?? before.sourceLanguage
        const revised = sourceText !== before.sourceText || sourceLanguage !== before.sourceLanguage
        if (revised && sourceLanguage !== before.sourceLanguage) {
          const clash = await tx.phraseTranslation.findFirst({ where: { phraseId: known.id, language: sourceLanguage, status: { in: ['DRAFT', 'APPROVED'] } }, select: { id: true } })
          if (clash) throw refused({ code: 'SOURCE_LANGUAGE_TRANSLATED', message: `The phrase has a translation in ${sourceLanguage}: withdraw it, or keep the source language.` })
        }
        const row = await tx.phrase.update({
          where: { id: known.id },
          data: {
            ...(body.kind !== undefined ? { kind: body.kind } : {}),
            ...(body.note !== undefined ? { note: body.note } : {}),
            ...(body.status !== undefined ? { status: body.status } : {}),
            ...(revised ? { sourceText, sourceLanguage, revision: before.revision + 1 } : {}),
            updatedAt: now,
          },
          select: PHRASE_SELECT,
        })
        audit({ recordType: 'Phrase', recordId: row.id, companyId: row.companyId, before: auditOf(before), after: auditOf(row) })
        const change = revised ? 'REVISED' : before.status !== row.status ? (row.status === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED') : 'EDITED'
        emit({ type: 'compliance_rules.phrase_changed', subject: row.id, companyId: row.companyId, payload: { phraseId: row.id, key: row.key, revision: row.revision, change } })
        return { phrase: await viewOf(tx, context, row) }
      },
      settings(),
    ),
  )
  return result
}

function translationChanged(tools: CommandTools, phrase: PhraseRow, translation: { id: string; language: string; revision: number; status: string }, change: 'PROPOSED' | 'APPROVED' | 'WITHDRAWN'): void {
  tools.emit({
    type: 'compliance_rules.translation_changed',
    subject: phrase.id,
    companyId: phrase.companyId,
    payload: { phraseId: phrase.id, key: phrase.key, translationId: translation.id, language: translation.language, revision: translation.revision, status: translation.status as TranslationStatus, change },
  })
}

/** POST /compliance/rules/phrases/:key/translations — a proposal: a new draft, or new words for the language's waiting draft. */
export async function proposeTranslation(caller: CommandCaller, phraseKey: string, body: { readonly language: string; readonly text: string; readonly version?: number | undefined }, key: string | null | undefined): Promise<{ phrase: PhraseView }> {
  const context = officeOf(caller)
  const known = await caller.withClient((db) => readPhrase(db, context, phraseKey))
  assertMayKeep(context, PHRASES_MANAGE, known.companyId, 'A translation of a phrase')
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.phrases.propose', idempotencyKey: key, input: { phraseKey, ...body } },
      async (tools) => {
        const { tx, now, audit } = tools
        await lockPhrase(tools, known.id)
        const phrase = await tx.phrase.findUniqueOrThrow({ where: { id: known.id }, select: PHRASE_SELECT })
        const refusal = proposeRefusal({ phraseStatus: phrase.status, sourceLanguage: phrase.sourceLanguage, language: body.language, text: body.text })
        if (refusal) throw refused(refusal, refusal.code === 'ARCHIVED' ? 'conflict' : 'validation_failed')
        const rows = await tx.phraseTranslation.findMany({ where: { phraseId: phrase.id, language: body.language }, select: TRANSLATION_SELECT })
        const draft = rows.find((row) => row.status === 'DRAFT')
        let saved
        if (draft) {
          if (body.version === undefined) throw refused({ code: 'DRAFT_WAITING', message: `A proposed ${body.language} translation waits already: send its version to replace its words, or withdraw it.` })
          if (draft.version !== body.version) throw new ConflictError(`The waiting ${body.language} translation changed since it was read (version ${body.version}); it is now at version ${draft.version}. Reload it.`)
          saved = await tx.phraseTranslation.update({
            where: { id: draft.id },
            data: { text: body.text, sourceRevision: phrase.revision, translatedById: context.actorId, version: draft.version + 1, updatedAt: now },
            select: TRANSLATION_SELECT,
          })
          audit({ recordType: 'PhraseTranslation', recordId: draft.id, companyId: phrase.companyId, before: { sourceRevision: draft.sourceRevision, translatedById: draft.translatedById }, after: { phraseId: phrase.id, language: body.language, revision: draft.revision, sourceRevision: phrase.revision } })
        } else {
          const id = newId()
          saved = await tx.phraseTranslation.create({
            data: {
              id,
              phraseId: phrase.id,
              language: body.language,
              revision: nextRevision(body.language, rows.map(factsOf)),
              text: body.text,
              sourceRevision: phrase.revision,
              translatedById: context.actorId,
              createdAt: now,
              updatedAt: now,
              createdById: context.actorId,
            },
            select: TRANSLATION_SELECT,
          })
          audit({ recordType: 'PhraseTranslation', recordId: id, companyId: phrase.companyId, after: { phraseId: phrase.id, language: body.language, revision: saved.revision, sourceRevision: phrase.revision } })
        }
        translationChanged(tools, phrase, saved, 'PROPOSED')
        return { phrase: await viewOf(tx, context, phrase) }
      },
      settings(),
    ),
  )
  return result
}

/** POST /compliance/rules/phrases/:key/translations/:translationId/approve — by a second person. */
export async function approveTranslation(caller: CommandCaller, phraseKey: string, translationId: string, body: { readonly version: number }, key: string | null | undefined): Promise<{ phrase: PhraseView }> {
  const context = officeOf(caller)
  const known = await caller.withClient((db) => readPhrase(db, context, phraseKey))
  assertMayKeep(context, PHRASES_APPROVE, known.companyId, 'A translation of a phrase')
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.phrases.approve', idempotencyKey: key, input: { phraseKey, translationId, ...body }, record: { type: 'PhraseTranslation', id: translationId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        await lockPhrase(tools, known.id)
        const phrase = await tx.phrase.findUniqueOrThrow({ where: { id: known.id }, select: PHRASE_SELECT })
        const draft = await tx.phraseTranslation.findUnique({ where: { id: translationId }, select: TRANSLATION_SELECT })
        if (!draft || draft.phraseId !== phrase.id) throw new NotFoundError('There is no such translation of this phrase.')
        const refusal = approveRefusal({ status: draft.status as TranslationStatus, sourceRevision: draft.sourceRevision, phraseRevision: phrase.revision, authorId: draft.translatedById ?? draft.createdById, approverId: context.actorId })
        if (refusal) throw refused(refusal)
        const before = await tx.phraseTranslation.findFirst({ where: { phraseId: phrase.id, language: draft.language, status: 'APPROVED' }, select: TRANSLATION_SELECT })
        if (before) {
          await tx.phraseTranslation.update({ where: { id: before.id }, data: { status: 'SUPERSEDED', version: before.version + 1, updatedAt: now }, select: { id: true } })
          audit({ recordType: 'PhraseTranslation', recordId: before.id, companyId: phrase.companyId, before: { status: 'APPROVED' }, after: { status: 'SUPERSEDED', supersededBy: draft.id } })
        }
        const approved = await tx.phraseTranslation.update({ where: { id: draft.id }, data: { status: 'APPROVED', approvedAt: now, approvedById: context.actorId, updatedAt: now }, select: TRANSLATION_SELECT })
        audit({ recordType: 'PhraseTranslation', recordId: draft.id, companyId: phrase.companyId, before: { status: 'DRAFT' }, after: { status: 'APPROVED', sourceRevision: approved.sourceRevision, supersedes: before?.id ?? null } })
        translationChanged(tools, phrase, approved, 'APPROVED')
        return { phrase: await viewOf(tx, context, phrase) }
      },
      settings(),
    ),
  )
  return result
}

/** DELETE /compliance/rules/phrases/:key/translations/:translationId?version= — a draft nobody wants. */
export async function withdrawTranslation(caller: CommandCaller, phraseKey: string, translationId: string, version: number, key: string | null | undefined): Promise<{ phrase: PhraseView }> {
  const context = officeOf(caller)
  const known = await caller.withClient((db) => readPhrase(db, context, phraseKey))
  assertMayKeep(context, PHRASES_MANAGE, known.companyId, 'A translation of a phrase')
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.phrases.withdraw', idempotencyKey: key, input: { phraseKey, translationId, version } },
      async (tools) => {
        const { tx, audit } = tools
        await lockPhrase(tools, known.id)
        const phrase = await tx.phrase.findUniqueOrThrow({ where: { id: known.id }, select: PHRASE_SELECT })
        const draft = await tx.phraseTranslation.findUnique({ where: { id: translationId }, select: TRANSLATION_SELECT })
        if (!draft || draft.phraseId !== phrase.id) throw new NotFoundError('There is no such translation of this phrase.')
        if (draft.status !== 'DRAFT') throw refused({ code: 'NOT_DRAFT', message: `This translation is ${draft.status}: it is kept (only a proposed one is withdrawn).` })
        if (draft.version !== version) throw new ConflictError(`This translation changed since it was read (version ${version}); it is now at version ${draft.version}. Reload it.`)
        await tx.phraseTranslation.delete({ where: { id: draft.id } })
        audit({ recordType: 'PhraseTranslation', recordId: draft.id, companyId: phrase.companyId, before: { phraseId: phrase.id, language: draft.language, revision: draft.revision, status: 'DRAFT' } })
        translationChanged(tools, phrase, draft, 'WITHDRAWN')
        return { phrase: await viewOf(tx, context, phrase) }
      },
      settings(),
    ),
  )
  return result
}
