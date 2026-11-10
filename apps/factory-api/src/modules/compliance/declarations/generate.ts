import type { Prisma } from '@nexus/factory-db'
import { DECLARATIONS_GENERATE } from '@nexus/factory-domain/compliance/declarations/permissions'
import {
  applyEdits,
  composeDeclaration,
  contentJson,
  contentOf,
  declarationNumber,
  draftFieldProblems,
  keepTyped,
  LANGUAGE,
  pointEditProblems,
  sourceWords,
  startingState,
  translationRefusal,
  withdrawRefusal,
  type AnnexPoint,
  type Composition,
  type DeclarationFacts,
  type PhraseBook,
  type PointEdit,
  type Problem,
  type TranslationState,
} from '@nexus/factory-domain/compliance/declarations/rules'
import { DomainError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller, CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import {
  assertMayWriteDocument,
  dateDay,
  dateOf,
  declarationsCommand,
  DOCUMENT_SELECT,
  mayRead,
  officeOf,
  readVisibleDocument,
  readVisibleStyle,
  refused,
  STYLE_SELECT,
  todayOf,
  type DocumentRow,
  type Reader,
  type StyleRow,
} from './common'
import { chosenRevision, readComposition, readRevision, type ReadFacts, type RevisionRow } from './facts'
import { detailAfter } from './read'

/**
 * The DoC generator, write side (B-W2b-257; PRD-292, PRD-293; Reg. (EU) 2016/425 art. 15, Annex IX; GATE-PPE-TEXTS):
 *
 *   preview   GET  /compliance/declarations/preview      what a draft of a style revision would say in a language, each
 *                                                        point with its source, and what refuses it (no write)
 *   create    POST /compliance/declarations              ONE command: the original GENERATED draft in the first language
 *                                                        and a translation per other language (the library first; the
 *                                                        points it cannot give keep the original's words, IN_TRANSLATION)
 *   refresh   POST /compliance/declarations/:id/refresh  the points composed again from the records (typed points kept)
 *   edit      PATCH /compliance/declarations/:id         typed words of points, the number, the signatory, the market
 *   withdraw  POST /compliance/declarations/:id/withdraw a draft withdrawn with the reason (an original takes its
 *                                                        translations with it); the revision's language stays taken
 *
 * One generated draft per style revision, kind and language (B-W2b-218's key has the origin in it: it sits beside the signed
 * document of the same revision). Never ISSUED here: the database refuses it until GATE-PPE-TEXTS; the signed PDF uploaded
 * through W1 stays the live route. The maker is the brand for a style it sells under its own name, else our company (the
 * database's rule; the names come from the economic operators). Every write takes the style's advisory lock
 * `factory.declarations|<tenant>|<style>` and is one command (audit, event, Idempotency-Key, the row's version).
 */

const KIND = 'DECLARATION_OF_CONFORMITY' as const
const LANGUAGES_MAX = 10

export async function lockStyleDeclarations(tools: Pick<CommandTools, 'tx' | 'context'>, styleId: string): Promise<void> {
  const tenantId = (tools.context as OfficeContext).tenantId
  await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.declarations', ${tenantId}::uuid, ${styleId}::uuid), 0))`
}

/** The problems of a composition as the API's refusal: 409 with each problem at `refusal/<CODE>`. */
function compositionRefusal(blocking: readonly Problem[]): DomainError {
  return new DomainError(
    'conflict',
    blocking.map((problem) => problem.message).join(' '),
    blocking.map((problem) => ({ path: `refusal/${problem.code}`, message: problem.message })),
  )
}

/** The company whose declaration it is: the style's, or (a style of every company) the one named. */
async function companyOf(db: Reader, context: OfficeContext, style: StyleRow, asked: string | null | undefined, path: string): Promise<string | null> {
  if (style.companyId !== null) {
    if (asked && asked !== style.companyId) throw new ValidationError('The company is not valid.', [{ path, message: `Style ${style.code} is company ${style.companyId}'s: its declaration is that company's.` }])
    return style.companyId
  }
  if (!asked) return null
  const company = await db.company.findUnique({ where: { id: asked }, select: { id: true } })
  if (!company || !mayRead(context, company.id)) throw new ValidationError('The company is not valid.', [{ path, message: 'Not a company you reach.' }])
  return company.id
}

const languagesProblems = (languages: readonly string[]) => {
  const problems: { path: string; message: string }[] = []
  if (languages.length < 1 || languages.length > LANGUAGES_MAX) problems.push({ path: 'body/languages', message: `1 to ${LANGUAGES_MAX} languages: the original's first.` })
  languages.forEach((language, index) => {
    if (!LANGUAGE.test(language)) problems.push({ path: `body/languages/${index}`, message: 'A language as an ISO 639 code ("it").' })
    else if (languages.indexOf(language) !== index) problems.push({ path: `body/languages/${index}`, message: `${language} is given twice.` })
  })
  return problems
}

const signatoryOf = (row: Pick<DocumentRow, 'signedByName' | 'signedByFunction' | 'signedPlace' | 'signedOn'> | null): DeclarationFacts['signatory'] => ({
  name: row?.signedByName ?? null,
  function: row?.signedByFunction ?? null,
  place: row?.signedPlace ?? null,
  on: row?.signedOn ? dateDay(row.signedOn) : null,
})

const pointsView = (points: readonly AnnexPoint[]) => points.map((point) => ({ ...point, source: { ...point.source }, sourceWords: sourceWords(point.source), wording: point.wording ? { ...point.wording } : null, values: (point.values ?? []).map((value) => ({ ...value, source: { ...value.source }, sourceWords: sourceWords(value.source) })) }))

/** The columns a composition writes on a document (the maker, the certificate, the standards, the product's identification). */
function composedColumns(read: ReadFacts, composition: Composition) {
  return {
    certificateId: read.certificateId,
    makerPartyId: read.makerPartyId,
    makerName: read.facts.maker?.name ?? '',
    makerAddress: read.facts.maker?.address ?? '',
    productIdentification: composition.content.points.find((point) => point.point === '4')?.text ?? composition.content.points.find((point) => point.point === '1')?.text ?? null,
    standards: read.standardLabels,
    content: contentJson(composition.content) as Prisma.InputJsonValue,
  }
}

// ---- preview -----------------------------------------------------------------------------------------------------------------

export interface PreviewQuery {
  readonly styleId: string
  readonly revisionId?: string | undefined
  readonly companyId?: string | undefined
  readonly language: string
  readonly marketCode?: string | undefined
}

/** GET /compliance/declarations/preview: the draft a style revision would get, without writing it. */
export async function previewDeclaration(caller: CommandCaller, query: PreviewQuery) {
  const context = officeOf(caller)
  if (!LANGUAGE.test(query.language)) throw new ValidationError('The language is not valid.', [{ path: 'querystring/language', message: 'A language as an ISO 639 code ("it").' }])
  return caller.withClient(async (db) => {
    const style = await readVisibleStyle(db, context, query.styleId)
    const companyId = await companyOf(db, context, style, query.companyId, 'querystring/companyId')
    const revision = await chosenRevision(db, style.id, query.revisionId)
    const read = await readComposition(db, { style, revision, companyId, marketCode: query.marketCode ?? null, day: todayOf() }, [query.language])
    const composition = composeDeclaration(read.facts, query.language, read.book)
    const existing = revision ? await db.complianceDocument.findFirst({ where: { styleId: style.id, kind: KIND, revision: revision.revision, language: query.language, origin: 'GENERATED' }, select: { id: true, status: true } }) : null
    return {
      preview: {
        style: { id: style.id, code: style.code, name: style.name, ppeCategory: style.ppeCategory },
        revision: revision ? { id: revision.id, revision: revision.revision, status: revision.status } : null,
        companyId,
        language: query.language,
        number: revision ? declarationNumber(style.code, query.language, revision.revision) : null,
        maker: read.facts.maker ? { name: read.facts.maker.name, address: read.facts.maker.address, partyId: read.makerPartyId, sourceWords: sourceWords(read.facts.maker.source) } : null,
        certificate: read.facts.certificate ? { id: read.facts.certificate.id, number: read.facts.certificate.number, body: read.facts.certificate.bodyName, bodyNumber: read.facts.certificate.bodyNumber } : null,
        standards: read.standardLabels,
        points: pointsView(composition.content.points),
        blocking: composition.blocking.map((problem) => ({ ...problem })),
        warnings: composition.warnings.map((problem) => ({ ...problem })),
        missingPhrases: [...composition.missingPhrases],
        existing: existing ? { id: existing.id, status: existing.status } : null,
      },
    }
  })
}

// ---- create ------------------------------------------------------------------------------------------------------------------

export interface CreateBody {
  readonly styleId: string
  readonly revisionId?: string | undefined
  readonly companyId?: string | undefined
  /** The original's language first, then the translations'. */
  readonly languages: string[]
  readonly marketCode?: string | null | undefined
}

interface Planned {
  readonly language: string
  readonly composition: Composition
  readonly state: TranslationState | null
}

/** The translations' compositions of an original's points (the library first; the original's words where it has none). */
export function planTranslations(read: { facts: DeclarationFacts; book: PhraseBook }, languages: readonly string[], original: readonly AnnexPoint[]): Planned[] {
  return languages.map((language) => {
    const composition = composeDeclaration(read.facts, language, read.book, original)
    return { language, composition, state: startingState(composition.content.points) }
  })
}

/** Inside a command: a generated translation row of an original. */
export async function insertTranslation(tools: CommandTools, original: DocumentRow, read: ReadFacts, plan: Planned): Promise<string> {
  const { tx, audit, emit, context } = tools
  const id = newId()
  const columns = composedColumns(read, plan.composition)
  await tx.complianceDocument.create({
    data: {
      id,
      companyId: original.companyId,
      styleId: original.styleId,
      kind: KIND,
      language: plan.language,
      revision: original.revision,
      number: declarationNumber(read.facts.style.code, plan.language, original.revision),
      status: 'DRAFT',
      origin: 'GENERATED',
      ...columns,
      signedByName: original.signedByName,
      signedByFunction: original.signedByFunction,
      signedPlace: original.signedPlace,
      signedOn: original.signedOn,
      translationOfId: original.id,
      translationStatus: plan.state!,
      createdById: context.audience === 'office' ? context.actorId : null,
    },
    select: { id: true },
  })
  const untranslated = plan.composition.content.points.filter((point) => point.source.kind === 'UNTRANSLATED').map((point) => point.point)
  audit({
    action: 'compliance.declarations.translate',
    recordType: 'ComplianceDocument',
    recordId: id,
    companyId: original.companyId,
    after: { translationOf: original.id, language: plan.language, revision: original.revision, translationStatus: plan.state, untranslated, missingPhrases: [...plan.composition.missingPhrases], template: plan.composition.content.template },
  })
  emit({ type: 'compliance_declarations.translation_changed', subject: id, companyId: original.companyId, payload: { documentId: id, translationOfId: original.id, styleId: original.styleId, language: plan.language, state: plan.state!, change: 'STARTED' } })
  return id
}

/** POST /compliance/declarations: the original draft and its translations, in one command. */
export async function createDeclaration(caller: CommandCaller, body: CreateBody, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const problems = [...languagesProblems(body.languages), ...draftFieldProblems({ marketCode: body.marketCode })]
  if (problems.length > 0) throw new ValidationError('The declaration is not valid.', problems)
  const [originalLanguage, ...others] = body.languages as [string, ...string[]]

  const prepared = await caller.withClient(async (db) => {
    const style = await readVisibleStyle(db, context, body.styleId)
    const companyId = await companyOf(db, context, style, body.companyId, 'body/companyId')
    assertMayWriteDocument(context, DECLARATIONS_GENERATE, companyId)
    const revision = await chosenRevision(db, style.id, body.revisionId)
    const read = await readComposition(db, { style, revision, companyId, marketCode: body.marketCode ?? null, day: todayOf() }, body.languages)
    const original = composeDeclaration(read.facts, originalLanguage, read.book)
    if (original.blocking.length > 0) throw compositionRefusal(original.blocking)
    const plans = planTranslations(read, others, original.content.points)
    return { style, companyId, revision: revision!, read, original, plans }
  })
  const { style, companyId, revision, read, original, plans } = prepared
  if (body.marketCode) await assertMarket(caller, body.marketCode)

  const { result: documentId } = await declarationsCommand(
    caller,
    { name: 'compliance.declarations.generate', idempotencyKey, input: body },
    async (tools) => {
      const { tx, audit, emit } = tools
      await lockStyleDeclarations(tools, style.id)
      const taken = await tx.complianceDocument.findMany({ where: { styleId: style.id, kind: KIND, revision: revision.revision, origin: 'GENERATED', language: { in: body.languages } }, select: { id: true, language: true, status: true } })
      const takenOriginal = taken.find((entry) => entry.language === originalLanguage)
      if (takenOriginal) {
        throw refused('conflict', {
          code: takenOriginal.status === 'WITHDRAWN' ? 'WITHDRAWN' : 'EXISTS',
          message:
            takenOriginal.status === 'WITHDRAWN'
              ? `The generated DoC of ${style.code} revision ${revision.revision} in ${originalLanguage} was withdrawn: the next revision gets a new one.`
              : `${style.code} revision ${revision.revision} has a generated DoC in ${originalLanguage} already: open it and refresh it from the records.`,
        })
      }
      for (const plan of plans) {
        const refusal = translationRefusal({ originalLanguage, language: plan.language, taken: taken.map((entry) => entry.language) })
        if (refusal) throw refused('conflict', refusal)
      }
      const id = newId()
      const columns = composedColumns(read, original)
      const row = await tx.complianceDocument.create({
        data: {
          id,
          companyId,
          styleId: style.id,
          kind: KIND,
          language: originalLanguage,
          revision: revision.revision,
          number: declarationNumber(style.code, originalLanguage, revision.revision),
          status: 'DRAFT',
          origin: 'GENERATED',
          ...columns,
          marketCode: body.marketCode ?? null,
          createdById: context.actorId,
        },
        select: DOCUMENT_SELECT,
      })
      audit({
        action: 'compliance.declarations.generate',
        recordType: 'ComplianceDocument',
        recordId: id,
        companyId,
        after: {
          styleId: style.id,
          revision: revision.revision,
          language: originalLanguage,
          origin: 'GENERATED',
          template: original.content.template,
          number: row.number,
          certificateId: row.certificateId,
          makerPartyId: row.makerPartyId,
          makerName: row.makerName,
          standards: row.standards,
          sources: original.content.points.map((point) => ({ point: point.point, source: point.source })),
          warnings: original.warnings.map((problem) => problem.code),
        },
      })
      emit({ type: 'compliance_declarations.draft_changed', subject: id, companyId, payload: { documentId: id, styleId: style.id, revision: revision.revision, language: originalLanguage, translationOfId: null, change: 'CREATED' } })
      for (const plan of plans) await insertTranslation(tools, row, read, plan)
      return id
    },
    { taken: `${style.code} revision ${revision.revision} has a generated DoC in one of these languages already.` },
  )
  return detailAfter(caller, documentId)
}

async function assertMarket(caller: CommandCaller, code: string): Promise<void> {
  const market = await caller.withClient((db) => db.marketProfile.findFirst({ where: { code }, select: { code: true } }))
  if (!market) throw new ValidationError('The market is not valid.', [{ path: 'body/marketCode', message: `There is no market ${code}.` }])
}

// ---- refresh -----------------------------------------------------------------------------------------------------------------

/** A generated draft of this caller, writable: the document, its style and revision. */
export async function writableDraft(db: Reader, context: OfficeContext, documentId: string) {
  const row = await readVisibleDocument(db, context, documentId)
  if (row.origin !== 'GENERATED') throw refused('invalid_state', { code: 'SIGNED', message: 'This is a signed document (W1): its data and PDF are uploaded, never generated or edited here.' })
  if (row.kind !== KIND) throw refused('invalid_state', { code: 'USER_INFORMATION', message: 'This is user information: its builder is the leaflet step (B-W2b-258).' })
  if (row.status !== 'DRAFT') throw refused('invalid_state', { code: 'NOT_DRAFT', message: `This declaration is ${row.status}: it changes no more.` })
  assertMayWriteDocument(context, DECLARATIONS_GENERATE, row.companyId)
  return row
}

/** The composition of a draft from today's records: an original's, or a translation's on its original's points. */
export async function recompose(db: Reader, row: DocumentRow, day: BusinessDate, signatoryFrom?: DocumentRow | null) {
  const style = await db.style.findUnique({ where: { id: row.styleId }, select: STYLE_SELECT })
  if (!style) throw new NotFoundError('The style is gone.')
  const revision: RevisionRow = await readRevision(db, row.styleId, row.revision)
  const original = row.translationOfId ? await db.complianceDocument.findUnique({ where: { id: row.translationOfId }, select: DOCUMENT_SELECT }) : null
  const signatory = signatoryOf(signatoryFrom ?? original ?? row)
  const read = await readComposition(db, { style, revision, companyId: row.companyId, marketCode: row.marketCode, day, citedCertificateId: row.certificateId, signatory }, [row.language])
  const composition = composeDeclaration(read.facts, row.language, read.book, original ? contentOf(original.content).points : null)
  return { style, revision, original, read, composition }
}

/** POST /compliance/declarations/:id/refresh {version, keepTyped}: the points composed again from the records. */
export async function refreshDeclaration(caller: CommandCaller, documentId: string, body: { readonly version: number; readonly keepTyped?: boolean | undefined }, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const prepared = await caller.withClient(async (db) => {
    const row = await writableDraft(db, context, documentId)
    if (row.translationStatus === 'CHECKED') throw refused('invalid_state', { code: 'CHECKED', message: 'This translation is checked: undo the check before its words change.' })
    const fresh = await recompose(db, row, todayOf())
    if (fresh.composition.blocking.length > 0) throw compositionRefusal(fresh.composition.blocking)
    return { row, ...fresh }
  })
  const { row, read, composition } = prepared
  const keep = body.keepTyped !== false
  const points = keep ? keepTyped(composition.content.points, contentOf(row.content).points) : [...composition.content.points]
  const refreshed: Composition = { ...composition, content: { template: composition.content.template, points } }
  await declarationsCommand(
    caller,
    { name: 'compliance.declarations.refresh', idempotencyKey, input: { documentId, ...body }, record: { type: 'ComplianceDocument', id: documentId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, audit, emit } = tools
      await lockStyleDeclarations(tools, row.styleId)
      const columns = composedColumns(read, refreshed)
      const state = row.translationOfId ? (startingState(points) === 'IN_TRANSLATION' ? 'IN_TRANSLATION' : (row.translationStatus as TranslationState)) : null
      await tx.complianceDocument.update({ where: { id: documentId }, data: { ...columns, ...(state ? { translationStatus: state } : {}) }, select: { id: true } })
      audit({
        action: 'compliance.declarations.refresh',
        recordType: 'ComplianceDocument',
        recordId: documentId,
        companyId: row.companyId,
        before: { certificateId: row.certificateId, makerName: row.makerName, standards: row.standards, points: contentOf(row.content).points.map((point) => ({ point: point.point, text: point.text })) },
        after: { certificateId: columns.certificateId, makerName: columns.makerName, standards: columns.standards, keepTyped: keep, points: points.map((point) => ({ point: point.point, text: point.text, source: point.source.kind })) },
      })
      emit({ type: 'compliance_declarations.draft_changed', subject: documentId, companyId: row.companyId, payload: { documentId, styleId: row.styleId, revision: row.revision, language: row.language, translationOfId: row.translationOfId, change: 'REFRESHED' } })
      return documentId
    },
  )
  return detailAfter(caller, documentId)
}

// ---- edit --------------------------------------------------------------------------------------------------------------------

export interface EditBody {
  readonly version: number
  readonly points?: PointEdit[] | undefined
  readonly number?: string | null | undefined
  readonly signedByName?: string | null | undefined
  readonly signedByFunction?: string | null | undefined
  readonly signedPlace?: string | null | undefined
  readonly signedOn?: BusinessDate | null | undefined
  readonly marketCode?: string | null | undefined
}

const SIGNATORY_FIELDS = ['signedByName', 'signedByFunction', 'signedPlace', 'signedOn'] as const

/** PATCH /compliance/declarations/:id: typed words of points, the number, the signatory (an original's), the market. */
export async function editDeclaration(caller: CommandCaller, documentId: string, body: EditBody, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const problems = [...pointEditProblems(body.points ?? []), ...draftFieldProblems(body)]
  if (problems.length > 0) throw new ValidationError('The declaration is not valid.', problems)
  const signatoryChanged = SIGNATORY_FIELDS.some((field) => body[field] !== undefined)
  const prepared = await caller.withClient(async (db) => {
    const row = await writableDraft(db, context, documentId)
    if (row.translationStatus === 'CHECKED') throw refused('invalid_state', { code: 'CHECKED', message: 'This translation is checked: undo the check before its words change.' })
    if (signatoryChanged && row.translationOfId) throw refused('invalid_state', { code: 'TRANSLATION_SIGNATORY', message: "A translation takes the original's signatory: type it on the original, then refresh the translation." })
    // The signatory's line of point 9 follows the typed fields (unless a person typed point 9 itself).
    let point9: AnnexPoint | null = null
    if (signatoryChanged) {
      const next = { ...row, ...Object.fromEntries(SIGNATORY_FIELDS.filter((field) => body[field] !== undefined).map((field) => [field, field === 'signedOn' ? (body.signedOn ? dateOf(body.signedOn) : null) : body[field]])) } as DocumentRow
      const fresh = await recompose(db, next, todayOf(), next)
      point9 = fresh.composition.content.points.find((point) => point.point === '9') ?? null
    }
    return { row, point9 }
  })
  const { row, point9 } = prepared
  if (body.marketCode) await assertMarket(caller, body.marketCode)
  const stored = contentOf(row.content).points
  let points = applyEdits(stored, body.points ?? [], context.actorId)
  if (point9 && points.find((point) => point.point === '9')?.source.kind !== 'TYPED') points = [...points.filter((point) => point.point !== '9'), point9].sort((a, b) => a.point.localeCompare(b.point, 'en', { numeric: true }))
  await declarationsCommand(
    caller,
    { name: 'compliance.declarations.edit', idempotencyKey, input: { documentId, ...body }, record: { type: 'ComplianceDocument', id: documentId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, audit, emit } = tools
      const data: Prisma.ComplianceDocumentUpdateInput = { content: contentJson({ template: contentOf(row.content).template, points }) as Prisma.InputJsonValue }
      if (body.number !== undefined) data.number = body.number
      if (body.signedByName !== undefined) data.signedByName = body.signedByName
      if (body.signedByFunction !== undefined) data.signedByFunction = body.signedByFunction
      if (body.signedPlace !== undefined) data.signedPlace = body.signedPlace
      if (body.signedOn !== undefined) data.signedOn = body.signedOn ? dateOf(body.signedOn) : null
      if (body.marketCode !== undefined) data.marketCode = body.marketCode
      // A translation whose last open point was typed stays IN_TRANSLATION until a person moves it (or checks it).
      await tx.complianceDocument.update({ where: { id: documentId }, data, select: { id: true } })
      audit({
        action: 'compliance.declarations.edit',
        recordType: 'ComplianceDocument',
        recordId: documentId,
        companyId: row.companyId,
        before: { number: row.number, signedByName: row.signedByName, signedByFunction: row.signedByFunction, signedPlace: row.signedPlace, signedOn: row.signedOn ? dateDay(row.signedOn) : null, marketCode: row.marketCode, points: (body.points ?? []).map((edit) => ({ point: edit.point, text: stored.find((point) => point.point === edit.point)?.text ?? null })) },
        after: { number: body.number, signedByName: body.signedByName, signedByFunction: body.signedByFunction, signedPlace: body.signedPlace, signedOn: body.signedOn, marketCode: body.marketCode, points: (body.points ?? []).map((edit) => ({ point: edit.point, text: edit.text.trim() })) },
      })
      emit({ type: 'compliance_declarations.draft_changed', subject: documentId, companyId: row.companyId, payload: { documentId, styleId: row.styleId, revision: row.revision, language: row.language, translationOfId: row.translationOfId, change: 'EDITED' } })
      return documentId
    },
  )
  return detailAfter(caller, documentId)
}

// ---- withdraw ----------------------------------------------------------------------------------------------------------------

/** POST /compliance/declarations/:id/withdraw {version, reason}: the draft withdrawn (an original with its draft translations). */
export async function withdrawDeclaration(caller: CommandCaller, documentId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const row = await caller.withClient((db) => writableDraft(db, context, documentId))
  const refusal = withdrawRefusal({ status: row.status, reason: body.reason })
  if (refusal) throw refusal.code === 'REASON' ? new ValidationError('The withdrawal is not valid.', [{ path: 'body/reason', message: refusal.message }]) : new InvalidStateError(refusal.message)
  await declarationsCommand(
    caller,
    { name: 'compliance.declarations.withdraw', idempotencyKey, input: { documentId, ...body }, record: { type: 'ComplianceDocument', id: documentId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, audit, emit } = tools
      await lockStyleDeclarations(tools, row.styleId)
      const translations = row.translationOfId === null ? await tx.complianceDocument.findMany({ where: { translationOfId: row.id, status: 'DRAFT' }, select: { id: true, language: true } }) : []
      for (const target of [{ id: row.id, language: row.language, translationOfId: row.translationOfId }, ...translations.map((entry) => ({ ...entry, translationOfId: row.id }))]) {
        await tx.complianceDocument.update({ where: { id: target.id }, data: { status: 'WITHDRAWN', ...(target.id === row.id ? {} : { version: { increment: 1 } }) }, select: { id: true } })
        audit({ action: 'compliance.declarations.withdraw', recordType: 'ComplianceDocument', recordId: target.id, companyId: row.companyId, before: { status: 'DRAFT' }, after: { status: 'WITHDRAWN', ...(target.id === row.id ? {} : { withOriginal: row.id }) }, reason: body.reason.trim() })
        emit({ type: 'compliance_declarations.draft_changed', subject: target.id, companyId: row.companyId, payload: { documentId: target.id, styleId: row.styleId, revision: row.revision, language: target.language, translationOfId: target.translationOfId, change: 'WITHDRAWN' } })
      }
      return documentId
    },
  )
  return detailAfter(caller, documentId)
}
