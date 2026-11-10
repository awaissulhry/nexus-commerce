import { DECLARATIONS_CHECK } from '@nexus/factory-domain/compliance/declarations/permissions'
import { checkRefusal, contentOf, LANGUAGE, stateMoveRefusal, translationRefusal, type TranslationState } from '@nexus/factory-domain/compliance/declarations/rules'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import type { CommandCaller } from '../../../core/command'
import { assertMayWriteDocument, declarationsCommand, DOCUMENT_SELECT, officeOf, readVisibleDocument, refused, todayOf } from './common'
import { readPhraseBook } from './facts'
import { insertTranslation, lockStyleDeclarations, planTranslations, recompose, writableDraft } from './generate'
import { detailAfter } from './read'

/**
 * Translations of a generated DoC (B-W2b-257; PRD-293; Reg. (EU) 2016/425 art. 15(2): the DoC in the language the Member
 * State asks; design compliance.declarations › Translate, Languages): each a GENERATED document of the same revision in
 * another language, translating the original (B-W2b-218's translationOfId), its words from the phrase library first. A
 * point the library cannot give keeps the original's words (UNTRANSLATED) and the translation is IN_TRANSLATION until a
 * translator types them (PATCH, generate.ts). A second person checks it — never its author nor anyone who typed its words
 * (the database refuses the author too) — and the check is undone to change its words again. Checked or not, it stays a
 * draft until GATE-PPE-TEXTS.
 *
 *   POST /compliance/declarations/:id/translations        languages to add to an original (one command)
 *   POST /compliance/declarations/:id/translation-state   DRAFT ⇄ IN_TRANSLATION; from CHECKED: the check undone
 *   POST /compliance/declarations/:id/check               CHECKED by a second person (compliance.declarations.check)
 */

/** POST /compliance/declarations/:id/translations {languages}: translations of an original draft. */
export async function startTranslations(caller: CommandCaller, documentId: string, body: { readonly languages: string[] }, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const problems = body.languages.flatMap((language, index) =>
    !LANGUAGE.test(language) ? [{ path: `body/languages/${index}`, message: 'A language as an ISO 639 code ("de").' }] : body.languages.indexOf(language) !== index ? [{ path: `body/languages/${index}`, message: `${language} is given twice.` }] : [],
  )
  if (body.languages.length < 1 || body.languages.length > 10) problems.push({ path: 'body/languages', message: '1 to 10 languages.' })
  if (problems.length > 0) throw new ValidationError('The translations are not valid.', problems)
  const prepared = await caller.withClient(async (db) => {
    const row = await writableDraft(db, context, documentId)
    if (row.translationOfId !== null) throw refused('invalid_state', { code: 'TRANSLATION', message: 'This is a translation: translate the original.' })
    const fresh = await recompose(db, row, todayOf())
    // The library of every language asked (recompose read only the original's).
    const book = await readPhraseBook(db, row.companyId, body.languages)
    return { row, fresh, plans: planTranslations({ facts: fresh.read.facts, book }, body.languages, contentOf(row.content).points) }
  })
  const { row, fresh, plans } = prepared
  await declarationsCommand(
    caller,
    { name: 'compliance.declarations.translate', idempotencyKey, input: { documentId, ...body } },
    async (tools) => {
      const { tx } = tools
      await lockStyleDeclarations(tools, row.styleId)
      const original = await tx.complianceDocument.findUniqueOrThrow({ where: { id: documentId }, select: DOCUMENT_SELECT })
      if (original.status !== 'DRAFT') throw refused('invalid_state', { code: 'NOT_DRAFT', message: `The original is ${original.status}.` })
      const taken = await tx.complianceDocument.findMany({ where: { styleId: row.styleId, kind: row.kind, revision: row.revision, origin: 'GENERATED' }, select: { language: true } })
      for (const plan of plans) {
        const refusal = translationRefusal({ originalLanguage: row.language, language: plan.language, taken: taken.map((entry) => entry.language) })
        if (refusal) throw refused('conflict', refusal)
      }
      for (const plan of plans) await insertTranslation(tools, original, fresh.read, plan)
      return documentId
    },
    { taken: 'This revision has a generated DoC in one of these languages already.' },
  )
  return detailAfter(caller, documentId)
}

/** POST /compliance/declarations/:id/translation-state {version, state}: DRAFT ⇄ IN_TRANSLATION; from CHECKED the check is undone. */
export async function moveTranslation(caller: CommandCaller, documentId: string, body: { readonly version: number; readonly state: 'DRAFT' | 'IN_TRANSLATION' }, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const row = await caller.withClient((db) => writableDraft(db, context, documentId))
  if (row.translationOfId === null || row.translationStatus === null) throw refused('invalid_state', { code: 'NOT_A_TRANSLATION', message: 'This is an original: only a translation has a translation state.' })
  const from = row.translationStatus as TranslationState
  const refusal = stateMoveRefusal(from, body.state)
  if (refusal) throw refused('conflict', refusal)
  await declarationsCommand(
    caller,
    { name: 'compliance.declarations.translationState', idempotencyKey, input: { documentId, ...body }, record: { type: 'ComplianceDocument', id: documentId, expectedVersion: body.version } },
    async ({ tx, audit, emit }) => {
      await tx.complianceDocument.update({ where: { id: documentId }, data: { translationStatus: body.state, translationCheckedAt: null, translationCheckedById: null }, select: { id: true } })
      audit({ action: 'compliance.declarations.translationState', recordType: 'ComplianceDocument', recordId: documentId, companyId: row.companyId, before: { translationStatus: from }, after: { translationStatus: body.state, checkUndone: from === 'CHECKED' } })
      emit({
        type: 'compliance_declarations.translation_changed',
        subject: documentId,
        companyId: row.companyId,
        payload: { documentId, translationOfId: row.translationOfId!, styleId: row.styleId, language: row.language, state: body.state, change: from === 'CHECKED' ? 'UNCHECKED' : 'MOVED' },
      })
      return documentId
    },
  )
  return detailAfter(caller, documentId)
}

/** POST /compliance/declarations/:id/check {version}: the translation CHECKED by a second person. */
export async function checkTranslation(caller: CommandCaller, documentId: string, body: { readonly version: number }, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const row = await caller.withClient((db) => readVisibleDocument(db, context, documentId))
  if (row.origin !== 'GENERATED') throw refused('invalid_state', { code: 'SIGNED', message: 'This is a signed document (W1): its translation was checked before it was signed.' })
  if (row.kind !== 'DECLARATION_OF_CONFORMITY') throw refused('invalid_state', { code: 'USER_INFORMATION', message: 'This is user information: the leaflet step (B-W2b-258) checks its translations.' })
  assertMayWriteDocument(context, DECLARATIONS_CHECK, row.companyId)
  const refusal = checkRefusal({ status: row.status, translationState: row.translationStatus as TranslationState | null, authorId: row.createdById, checkerId: context.actorId, points: contentOf(row.content).points })
  if (refusal) throw refused(refusal.code === 'OWN_TRANSLATION' || refusal.code === 'OWN_WORDS' ? 'conflict' : 'invalid_state', refusal)
  await declarationsCommand(
    caller,
    { name: 'compliance.declarations.check', idempotencyKey, input: { documentId, ...body }, record: { type: 'ComplianceDocument', id: documentId, expectedVersion: body.version } },
    async ({ tx, audit, emit, now }) => {
      await tx.complianceDocument.update({ where: { id: documentId }, data: { translationStatus: 'CHECKED', translationCheckedAt: now, translationCheckedById: context.actorId }, select: { id: true } })
      audit({ action: 'compliance.declarations.check', recordType: 'ComplianceDocument', recordId: documentId, companyId: row.companyId, before: { translationStatus: row.translationStatus }, after: { translationStatus: 'CHECKED', checkedAt: now.toISOString() } })
      emit({ type: 'compliance_declarations.translation_changed', subject: documentId, companyId: row.companyId, payload: { documentId, translationOfId: row.translationOfId!, styleId: row.styleId, language: row.language, state: 'CHECKED', change: 'CHECKED' } })
      return documentId
    },
  )
  return detailAfter(caller, documentId)
}
