import type { Prisma } from '@nexus/factory-db'
import { LANGUAGE, withdrawRefusal, type PhraseBook, type TranslationState } from '@nexus/factory-domain/compliance/declarations/rules'
import { packTranslations, type PackMarket } from '@nexus/factory-domain/compliance/user-information/packs'
import { USER_INFORMATION_GENERATE } from '@nexus/factory-domain/compliance/user-information/permissions'
import {
  applyEdits,
  composeUserInformation,
  keepTyped,
  sectionEditProblems,
  sectionsJson,
  sectionsOf,
  sectionsToType,
  sourceWords,
  startingState,
  translationRefusal,
  type Composition,
  type LeafletContent,
  type LeafletFacts,
  type Section,
  type SectionEdit,
} from '@nexus/factory-domain/compliance/user-information/rules'
import { InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { assertMayWriteDocument, declarationsCommand, officeOf, readVisibleStyle, refused, STYLE_SELECT, todayOf, type Reader, type StyleRow } from '../declarations/common'
import { chosenRevision, readRevision, type ReadFacts, type RevisionRow } from '../declarations/facts'
import { lockStyleDeclarations } from '../declarations/generate'
import { compositionRefusal, companyOf, KIND, LANGUAGES_MAX, languageProblems, LEAFLET_SELECT, leafletNumber, readMarket, writableLeaflet, type LeafletRow } from './common'
import { readLeafletBook, readLeafletComposition } from './facts'
import { leafletAfter } from './read'

/**
 * The user information builder, write side (B-W2b-258; PRD-350, PRD-351, PRD-353, PRD-354; Reg. (EU) 2016/425 art. 8(7),
 * Annex II 1.4; GATE-PPE-TEXTS):
 *
 *   preview   GET  /compliance/user-information/preview      what a leaflet of a style revision would say in a language,
 *                                                            each section with its source, and what refuses it (no write)
 *   create    POST /compliance/user-information              ONE command: the original GENERATED draft in the first
 *                                                            language and a translation per other language and per
 *                                                            language the markets named ask (their language packs)
 *   refresh   POST /compliance/user-information/:id/refresh  the sections composed again from the records (typed kept)
 *   edit      PATCH /compliance/user-information/:id         typed words of sections, the number, the market
 *   withdraw  POST /compliance/user-information/:id/withdraw a draft withdrawn with the reason (an original takes its draft
 *                                                            translations with it); the revision's language stays taken
 *
 * One generated leaflet per style revision and language (B-W2b-218's key has the origin in it: it sits beside W1's signed
 * leaflet of the same revision). Never ISSUED here: the database refuses it until GATE-PPE-TEXTS; the signed leaflet uploaded
 * through W1 stays the live route. Every write takes the style's advisory lock (the DoC generator's,
 * `factory.declarations|<tenant>|<style>`) and is one command (audit, event, Idempotency-Key, the row's version).
 */

const sectionsView = (sections: readonly Section[]) => sections.map((section) => ({ ...section, source: { ...section.source }, sourceWords: sourceWords(section.source), wording: section.wording ? { ...section.wording } : null, values: (section.values ?? []).map((value) => ({ ...value, source: { ...value.source }, sourceWords: sourceWords(value.source) })) }))

/** The columns a composition writes on a leaflet (the maker, the certificate, the standards, the product, the sections). */
function composedColumns(read: ReadFacts, content: LeafletContent) {
  return {
    certificateId: read.certificateId,
    makerPartyId: read.makerPartyId,
    makerName: read.facts.maker?.name ?? '',
    makerAddress: read.facts.maker?.address ?? '',
    productIdentification: content.sections.find((section) => section.key === 'product')?.text.slice(0, 4000) ?? null,
    standards: read.standardLabels,
    sections: sectionsJson(content) as Prisma.InputJsonValue,
  }
}

const problemsOf = (composition: Composition) => ({ blocking: composition.blocking.map((problem) => ({ ...problem })), warnings: composition.warnings.map((problem) => ({ ...problem })) })

// ---- preview -----------------------------------------------------------------------------------------------------------------

export interface PreviewQuery {
  readonly styleId: string
  readonly revisionId?: string | undefined
  readonly companyId?: string | undefined
  readonly language: string
  readonly marketCode?: string | undefined
}

/** GET /compliance/user-information/preview: the leaflet a style revision would get, without writing it. */
export async function previewLeaflet(caller: CommandCaller, query: PreviewQuery) {
  const context = officeOf(caller)
  if (!LANGUAGE.test(query.language)) throw new ValidationError('The language is not valid.', [{ path: 'querystring/language', message: 'A language as an ISO 639 code ("it").' }])
  return caller.withClient(async (db) => {
    const style = await readVisibleStyle(db, context, query.styleId)
    const companyId = await companyOf(db, context, style, query.companyId, 'querystring/companyId')
    if (query.marketCode) await readMarket(db, query.marketCode, 'querystring/marketCode')
    const revision = await chosenRevision(db, style.id, query.revisionId)
    const read = await readLeafletComposition(db, { style, revision, companyId, marketCode: query.marketCode ?? null, day: todayOf() }, [query.language])
    const composition = composeUserInformation(read.facts, query.language, read.book)
    const existing = revision ? await db.complianceDocument.findFirst({ where: { styleId: style.id, kind: KIND, revision: revision.revision, language: query.language, origin: 'GENERATED' }, select: { id: true, status: true } }) : null
    return {
      preview: {
        style: { id: style.id, code: style.code, name: style.name, ppeCategory: style.ppeCategory },
        revision: revision ? { id: revision.id, revision: revision.revision, status: revision.status } : null,
        companyId,
        language: query.language,
        number: revision ? leafletNumber(style.code, query.language, revision.revision) : null,
        maker: read.facts.declaration.maker ? { name: read.facts.declaration.maker.name, address: read.facts.declaration.maker.address, partyId: read.read.makerPartyId, sourceWords: sourceWords(read.facts.declaration.maker.source) } : null,
        certificate: read.facts.declaration.certificate ? { id: read.facts.declaration.certificate.id, number: read.facts.declaration.certificate.number, body: read.facts.declaration.certificate.bodyName, bodyNumber: read.facts.declaration.certificate.bodyNumber } : null,
        standards: read.read.standardLabels,
        sections: sectionsView(composition.content.sections),
        protectorPositions: composition.content.protectorPositions.map((entry) => ({ ...entry, protector: { ...entry.protector }, sizes: [...entry.sizes] })),
        spareProtectors: composition.content.spareProtectors.map((entry) => ({ ...entry, zones: [...entry.zones], certificate: { ...entry.certificate } })),
        ...problemsOf(composition),
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
  /** The market the original is made for (its operators: the importer); null: every market of its language. */
  readonly marketCode?: string | null | undefined
  /** Markets whose language packs to start: a translation per language they ask that has no leaflet yet. */
  readonly packs?: string[] | undefined
}

export interface Planned {
  readonly language: string
  readonly marketCode: string | null
  readonly composition: Composition
  readonly state: TranslationState
}

/** The translations' compositions of an original's sections, each in its market (the library first; the original's words where it has none). */
export async function planTranslations(db: Reader, base: { readonly style: StyleRow; readonly revision: RevisionRow; readonly companyId: string | null; readonly day: BusinessDate; readonly citedCertificateId?: string | null }, wanted: readonly { language: string; marketCode: string | null }[], original: readonly Section[]): Promise<{ plans: Planned[]; reads: Map<string, ReadFacts> }> {
  const plans: Planned[] = []
  const reads = new Map<string, ReadFacts>()
  const byMarket = new Map<string, { facts: LeafletFacts; read: ReadFacts }>()
  let book: PhraseBook | null = null
  for (const entry of wanted) {
    // A translation is composed in its own market (a pack's), else for every market of its language: as a refresh reads it.
    const market = entry.marketCode
    const key = market ?? ''
    let read = byMarket.get(key)
    if (!read) {
      const fresh = await readLeafletComposition(db, { style: base.style, revision: base.revision, companyId: base.companyId, marketCode: market, day: base.day, citedCertificateId: base.citedCertificateId ?? null }, [])
      read = { facts: fresh.facts, read: fresh.read }
      byMarket.set(key, read)
    }
    book ??= await readLeafletBook(db, base.companyId, wanted.map((item) => item.language))
    const composition = composeUserInformation(read.facts, entry.language, book, original)
    plans.push({ language: entry.language, marketCode: market, composition, state: startingState(composition.content.sections) })
    reads.set(entry.language, read.read)
  }
  return { plans, reads }
}

/** Inside a command: a generated translation row of an original leaflet. */
export async function insertTranslation(tools: CommandTools, original: LeafletRow, read: ReadFacts, plan: Planned, styleCode: string): Promise<string> {
  const { tx, audit, emit, context } = tools
  const id = newId()
  await tx.complianceDocument.create({
    data: {
      id,
      companyId: original.companyId,
      styleId: original.styleId,
      kind: KIND,
      language: plan.language,
      revision: original.revision,
      number: leafletNumber(styleCode, plan.language, original.revision),
      status: 'DRAFT',
      origin: 'GENERATED',
      ...composedColumns(read, plan.composition.content),
      marketCode: plan.marketCode,
      translationOfId: original.id,
      translationStatus: plan.state,
      createdById: context.audience === 'office' ? context.actorId : null,
    },
    select: { id: true },
  })
  audit({
    action: 'compliance.userInformation.translate',
    recordType: 'ComplianceDocument',
    recordId: id,
    companyId: original.companyId,
    after: { translationOf: original.id, language: plan.language, marketCode: plan.marketCode, revision: original.revision, translationStatus: plan.state, untranslated: sectionsToType(plan.composition.content.sections), missingPhrases: [...plan.composition.missingPhrases], template: plan.composition.content.template },
  })
  emit({ type: 'compliance_user_information.translation_changed', subject: id, companyId: original.companyId, payload: { documentId: id, translationOfId: original.id, styleId: original.styleId, language: plan.language, marketCode: plan.marketCode, state: plan.state, change: 'STARTED' } })
  return id
}

/** The active markets that apply to a company's leaflets (its own and every company's), switched on or not (a pack says which). */
export async function packMarkets(db: Reader, companyId: string | null): Promise<PackMarket[]> {
  const rows = await db.marketProfile.findMany({ where: { status: 'ACTIVE' }, select: { code: true, name: true, companyId: true, userInfoLanguages: true, switchedOn: true }, orderBy: [{ seq: 'asc' }, { code: 'asc' }] })
  return rows.filter((row) => row.companyId === null || companyId === null || row.companyId === companyId)
}

/** The languages to translate: those named, then those the named markets' packs ask (with the market each is made for). */
export async function wantedTranslations(db: Reader, input: { readonly companyId: string | null; readonly originalLanguage: string; readonly languages: readonly string[]; readonly packs: readonly string[]; readonly taken: readonly string[] }): Promise<{ language: string; marketCode: string | null }[]> {
  // A language named that is the original's or taken already is refused in the command, in words (SOURCE_LANGUAGE, TAKEN).
  const out: { language: string; marketCode: string | null }[] = input.languages.map((language) => ({ language, marketCode: null }))
  if (input.packs.length > 0) {
    const markets = await packMarkets(db, input.companyId)
    const known = new Set(markets.map((market) => market.code))
    const unknown = input.packs.filter((code) => !known.has(code))
    if (unknown.length > 0) throw new ValidationError('The markets are not valid.', unknown.map((code) => ({ path: `body/packs/${input.packs.indexOf(code)}`, message: `There is no market ${code} for this company.` })))
    for (const entry of packTranslations(markets, input.packs, input.originalLanguage, [...input.taken, ...out.map((item) => item.language)])) out.push(entry)
  }
  return out
}

/** POST /compliance/user-information: the original draft and its translations (and the language packs asked), in one command. */
export async function createLeaflet(caller: CommandCaller, body: CreateBody, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const problems = languageProblems(body.languages, 'body/languages')
  if (body.languages.length < 1 || body.languages.length > LANGUAGES_MAX) problems.push({ path: 'body/languages', message: `1 to ${LANGUAGES_MAX} languages: the original's first.` })
  if (problems.length > 0) throw new ValidationError('The user information is not valid.', problems)
  const [originalLanguage, ...others] = body.languages as [string, ...string[]]

  const prepared = await caller.withClient(async (db) => {
    const style = await readVisibleStyle(db, context, body.styleId)
    const companyId = await companyOf(db, context, style, body.companyId, 'body/companyId')
    assertMayWriteDocument(context, USER_INFORMATION_GENERATE, companyId)
    if (body.marketCode) await readMarket(db, body.marketCode, 'body/marketCode')
    const revision = await chosenRevision(db, style.id, body.revisionId)
    const day = todayOf()
    const fresh = await readLeafletComposition(db, { style, revision, companyId, marketCode: body.marketCode ?? null, day }, [originalLanguage])
    const original = composeUserInformation(fresh.facts, originalLanguage, fresh.book)
    if (original.blocking.length > 0) throw compositionRefusal(original.blocking)
    const wanted = await wantedTranslations(db, { companyId, originalLanguage, languages: others, packs: body.packs ?? [], taken: [] })
    if (wanted.length + 1 > LANGUAGES_MAX) throw new ValidationError('The user information is not valid.', [{ path: 'body/packs', message: `At most ${LANGUAGES_MAX} languages in one go: start the other packs from the leaflet.` }])
    const { plans, reads } = await planTranslations(db, { style, revision: revision!, companyId, day }, wanted, original.content.sections)
    return { style, companyId, revision: revision!, read: fresh.read, original, plans, reads }
  })
  const { style, companyId, revision, read, original, plans, reads } = prepared
  const languages = [originalLanguage, ...plans.map((plan) => plan.language)]

  const { result: documentId } = await declarationsCommand(
    caller,
    { name: 'compliance.userInformation.generate', idempotencyKey, input: body },
    async (tools) => {
      const { tx, audit, emit } = tools
      await lockStyleDeclarations(tools, style.id)
      const taken = await tx.complianceDocument.findMany({ where: { styleId: style.id, kind: KIND, revision: revision.revision, origin: 'GENERATED', language: { in: languages } }, select: { id: true, language: true, status: true } })
      const takenOriginal = taken.find((entry) => entry.language === originalLanguage)
      if (takenOriginal) {
        throw refused('conflict', {
          code: takenOriginal.status === 'WITHDRAWN' ? 'WITHDRAWN' : 'EXISTS',
          message:
            takenOriginal.status === 'WITHDRAWN'
              ? `The generated user information of ${style.code} revision ${revision.revision} in ${originalLanguage} was withdrawn: the next revision gets a new one.`
              : `${style.code} revision ${revision.revision} has generated user information in ${originalLanguage} already: open it and refresh it from the records.`,
        })
      }
      for (const plan of plans) {
        const refusal = translationRefusal({ originalLanguage, language: plan.language, taken: taken.map((entry) => entry.language) })
        if (refusal) throw refused('conflict', refusal)
      }
      const id = newId()
      const columns = composedColumns(read, original.content)
      const row = await tx.complianceDocument.create({
        data: {
          id,
          companyId,
          styleId: style.id,
          kind: KIND,
          language: originalLanguage,
          revision: revision.revision,
          number: leafletNumber(style.code, originalLanguage, revision.revision),
          status: 'DRAFT',
          origin: 'GENERATED',
          ...columns,
          marketCode: body.marketCode ?? null,
          createdById: context.actorId,
        },
        select: LEAFLET_SELECT,
      })
      audit({
        action: 'compliance.userInformation.generate',
        recordType: 'ComplianceDocument',
        recordId: id,
        companyId,
        after: {
          styleId: style.id,
          revision: revision.revision,
          language: originalLanguage,
          marketCode: body.marketCode ?? null,
          origin: 'GENERATED',
          template: original.content.template,
          number: row.number,
          certificateId: row.certificateId,
          makerPartyId: row.makerPartyId,
          makerName: row.makerName,
          standards: row.standards,
          sources: original.content.sections.map((section) => ({ key: section.key, source: section.source })),
          protectorPositions: original.content.protectorPositions.length,
          spareProtectors: original.content.spareProtectors.map((spare) => ({ itemId: spare.itemId, certificateId: spare.certificate.id })),
          warnings: original.warnings.map((problem) => problem.code),
        },
      })
      emit({ type: 'compliance_user_information.draft_changed', subject: id, companyId, payload: { documentId: id, styleId: style.id, revision: revision.revision, language: originalLanguage, translationOfId: null, change: 'CREATED' } })
      for (const plan of plans) await insertTranslation(tools, row, reads.get(plan.language)!, plan, style.code)
      return id
    },
    { taken: `${style.code} revision ${revision.revision} has generated user information in one of these languages already.` },
  )
  return leafletAfter(caller, documentId)
}

// ---- refresh -----------------------------------------------------------------------------------------------------------------

/** The composition of a leaflet draft from today's records: an original's, or a translation's on its original's sections. */
export async function recompose(db: Reader, row: Pick<LeafletRow, 'styleId' | 'revision' | 'translationOfId' | 'companyId' | 'marketCode' | 'certificateId' | 'language'>, day: BusinessDate) {
  const style = await db.style.findUnique({ where: { id: row.styleId }, select: STYLE_SELECT })
  if (!style) throw new NotFoundError('The style is gone.')
  const revision: RevisionRow = await readRevision(db, row.styleId, row.revision)
  const original = row.translationOfId ? await db.complianceDocument.findUnique({ where: { id: row.translationOfId }, select: LEAFLET_SELECT }) : null
  const read = await readLeafletComposition(db, { style, revision, companyId: row.companyId, marketCode: row.marketCode, day, citedCertificateId: row.certificateId }, [row.language])
  const composition = composeUserInformation(read.facts, row.language, read.book, original ? sectionsOf(original.sections).sections : null)
  return { style, revision, original, read, composition }
}

/** POST /compliance/user-information/:id/refresh {version, keepTyped}: the sections composed again from the records. */
export async function refreshLeaflet(caller: CommandCaller, documentId: string, body: { readonly version: number; readonly keepTyped?: boolean | undefined }, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const prepared = await caller.withClient(async (db) => {
    const row = await writableLeaflet(db, context, documentId)
    if (row.translationStatus === 'CHECKED') throw refused('invalid_state', { code: 'CHECKED', message: 'This translation is checked: undo the check before its words change.' })
    const fresh = await recompose(db, row, todayOf())
    if (fresh.composition.blocking.length > 0) throw compositionRefusal(fresh.composition.blocking)
    return { row, ...fresh }
  })
  const { row, read, composition } = prepared
  const keep = body.keepTyped !== false
  const stored = sectionsOf(row.sections)
  const sections = keep ? keepTyped(composition.content.sections, stored.sections) : [...composition.content.sections]
  const content: LeafletContent = { ...composition.content, sections }
  await declarationsCommand(
    caller,
    { name: 'compliance.userInformation.refresh', idempotencyKey, input: { documentId, ...body }, record: { type: 'ComplianceDocument', id: documentId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, audit, emit } = tools
      await lockStyleDeclarations(tools, row.styleId)
      const columns = composedColumns(read.read, content)
      const state = row.translationOfId ? (startingState(sections) === 'IN_TRANSLATION' ? 'IN_TRANSLATION' : (row.translationStatus as TranslationState)) : null
      await tx.complianceDocument.update({ where: { id: documentId }, data: { ...columns, ...(state ? { translationStatus: state } : {}) }, select: { id: true } })
      audit({
        action: 'compliance.userInformation.refresh',
        recordType: 'ComplianceDocument',
        recordId: documentId,
        companyId: row.companyId,
        before: { certificateId: row.certificateId, makerName: row.makerName, standards: row.standards, sections: stored.sections.map((section) => ({ key: section.key, text: section.text })), spareProtectors: stored.spareProtectors.map((spare) => spare.itemId) },
        after: { certificateId: columns.certificateId, makerName: columns.makerName, standards: columns.standards, keepTyped: keep, sections: sections.map((section) => ({ key: section.key, text: section.text, source: section.source.kind })), spareProtectors: content.spareProtectors.map((spare) => spare.itemId) },
      })
      emit({ type: 'compliance_user_information.draft_changed', subject: documentId, companyId: row.companyId, payload: { documentId, styleId: row.styleId, revision: row.revision, language: row.language, translationOfId: row.translationOfId, change: 'REFRESHED' } })
      return documentId
    },
  )
  return leafletAfter(caller, documentId)
}

// ---- edit --------------------------------------------------------------------------------------------------------------------

export interface EditBody {
  readonly version: number
  readonly sections?: SectionEdit[] | undefined
  readonly number?: string | null | undefined
  readonly marketCode?: string | null | undefined
}

/** PATCH /compliance/user-information/:id: typed words of sections, the number, the market. */
export async function editLeaflet(caller: CommandCaller, documentId: string, body: EditBody, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const problems = sectionEditProblems(body.sections ?? [])
  if (body.number !== undefined && body.number !== null && (body.number.trim() === '' || body.number.length > 60)) problems.push({ path: 'body/number', message: 'The number: 1 to 60 characters, or none.' })
  if (problems.length > 0) throw new ValidationError('The user information is not valid.', problems)
  const row = await caller.withClient(async (db) => {
    const found = await writableLeaflet(db, context, documentId)
    if (found.translationStatus === 'CHECKED') throw refused('invalid_state', { code: 'CHECKED', message: 'This translation is checked: undo the check before its words change.' })
    if (body.marketCode) await readMarket(db, body.marketCode, 'body/marketCode')
    return found
  })
  const stored = sectionsOf(row.sections)
  const sections = applyEdits(stored.sections, body.sections ?? [], context.actorId)
  await declarationsCommand(
    caller,
    { name: 'compliance.userInformation.edit', idempotencyKey, input: { documentId, ...body }, record: { type: 'ComplianceDocument', id: documentId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, audit, emit } = tools
      const data: Prisma.ComplianceDocumentUpdateInput = { sections: sectionsJson({ ...stored, sections }) as Prisma.InputJsonValue }
      if (body.number !== undefined) data.number = body.number
      if (body.marketCode !== undefined) data.marketCode = body.marketCode
      if ((body.sections ?? []).some((edit) => edit.key === 'product')) data.productIdentification = sections.find((section) => section.key === 'product')?.text.slice(0, 4000) ?? null
      // A translation whose last open section was typed stays IN_TRANSLATION until a person moves it (or checks it).
      await tx.complianceDocument.update({ where: { id: documentId }, data, select: { id: true } })
      audit({
        action: 'compliance.userInformation.edit',
        recordType: 'ComplianceDocument',
        recordId: documentId,
        companyId: row.companyId,
        before: { number: row.number, marketCode: row.marketCode, sections: (body.sections ?? []).map((edit) => ({ key: edit.key, text: stored.sections.find((section) => section.key === edit.key)?.text ?? null })) },
        after: { number: body.number, marketCode: body.marketCode, sections: (body.sections ?? []).map((edit) => ({ key: edit.key, text: edit.text.trim() })) },
      })
      emit({ type: 'compliance_user_information.draft_changed', subject: documentId, companyId: row.companyId, payload: { documentId, styleId: row.styleId, revision: row.revision, language: row.language, translationOfId: row.translationOfId, change: 'EDITED' } })
      return documentId
    },
  )
  return leafletAfter(caller, documentId)
}

// ---- withdraw ----------------------------------------------------------------------------------------------------------------

/** POST /compliance/user-information/:id/withdraw {version, reason}: the draft withdrawn (an original with its draft translations). */
export async function withdrawLeaflet(caller: CommandCaller, documentId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const row = await caller.withClient((db) => writableLeaflet(db, context, documentId))
  const refusal = withdrawRefusal({ status: row.status, reason: body.reason })
  if (refusal) throw refusal.code === 'REASON' ? new ValidationError('The withdrawal is not valid.', [{ path: 'body/reason', message: refusal.message }]) : new InvalidStateError(refusal.message)
  await declarationsCommand(
    caller,
    { name: 'compliance.userInformation.withdraw', idempotencyKey, input: { documentId, ...body }, record: { type: 'ComplianceDocument', id: documentId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, audit, emit } = tools
      await lockStyleDeclarations(tools, row.styleId)
      const translations = row.translationOfId === null ? await tx.complianceDocument.findMany({ where: { translationOfId: row.id, status: 'DRAFT' }, select: { id: true, language: true } }) : []
      for (const target of [{ id: row.id, language: row.language, translationOfId: row.translationOfId }, ...translations.map((entry) => ({ ...entry, translationOfId: row.id }))]) {
        await tx.complianceDocument.update({ where: { id: target.id }, data: { status: 'WITHDRAWN', ...(target.id === row.id ? {} : { version: { increment: 1 } }) }, select: { id: true } })
        audit({ action: 'compliance.userInformation.withdraw', recordType: 'ComplianceDocument', recordId: target.id, companyId: row.companyId, before: { status: 'DRAFT' }, after: { status: 'WITHDRAWN', ...(target.id === row.id ? {} : { withOriginal: row.id }) }, reason: body.reason.trim() })
        emit({ type: 'compliance_user_information.draft_changed', subject: target.id, companyId: row.companyId, payload: { documentId: target.id, styleId: row.styleId, revision: row.revision, language: target.language, translationOfId: target.translationOfId, change: 'WITHDRAWN' } })
      }
      return documentId
    },
  )
  return leafletAfter(caller, documentId)
}

