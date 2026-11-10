import { stateMoveRefusal, type TranslationState } from '@nexus/factory-domain/compliance/declarations/rules'
import { USER_INFORMATION_CHECK } from '@nexus/factory-domain/compliance/user-information/permissions'
import { checkRefusal, sectionsOf, translationRefusal } from '@nexus/factory-domain/compliance/user-information/rules'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import type { CommandCaller } from '../../../core/command'
import { declarationsCommand, officeOf, refused, STYLE_SELECT, todayOf } from '../declarations/common'
import { readRevision } from '../declarations/facts'
import { lockStyleDeclarations } from '../declarations/generate'
import { KIND, LANGUAGES_MAX, languageProblems, LEAFLET_SELECT, writableLeaflet } from './common'
import { insertTranslation, planTranslations, wantedTranslations } from './generate'
import { leafletAfter } from './read'

/**
 * Translations of a generated leaflet and the language packs per market (B-W2b-258; PRD-351; Reg. (EU) 2016/425 art. 8(7):
 * the information in a language easily understood where the PPE is made available; design compliance.declarations ›
 * Translate, Language check): each a GENERATED leaflet of the same revision in another language, translating the original
 * (B-W2b-218's translationOfId), its words from the phrase library first. A section the library cannot give keeps the
 * original's words (UNTRANSLATED) and the translation is IN_TRANSLATION until a translator types them (PATCH). A market's
 * language pack = a translation for each language the market asks (MarketProfile.userInfoLanguages) that has no leaflet of
 * the revision yet; the translation names the market when only that market asked for it. A second person checks it —
 * never its author nor anyone who typed its words (the database refuses the author too) — and the check is undone to
 * change its words again. Checked or not, it stays a draft until GATE-PPE-TEXTS.
 *
 *   POST /compliance/user-information/:id/translations        languages and/or markets' packs to add to an original
 *   POST /compliance/user-information/:id/translation-state   DRAFT ⇄ IN_TRANSLATION; from CHECKED: the check undone
 *   POST /compliance/user-information/:id/check               CHECKED by a second person (compliance.userInformation.check)
 */

/** POST /compliance/user-information/:id/translations {languages?, packs?}: translations of an original draft. */
export async function startTranslations(caller: CommandCaller, documentId: string, body: { readonly languages?: string[] | undefined; readonly packs?: string[] | undefined }, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const languages = body.languages ?? []
  const packs = body.packs ?? []
  const problems = languageProblems(languages, 'body/languages')
  if (languages.length + packs.length < 1) problems.push({ path: 'body/languages', message: 'Name the languages to add, or the markets whose language packs to start.' })
  if (languages.length > LANGUAGES_MAX) problems.push({ path: 'body/languages', message: `1 to ${LANGUAGES_MAX} languages.` })
  if (problems.length > 0) throw new ValidationError('The translations are not valid.', problems)
  const prepared = await caller.withClient(async (db) => {
    const row = await writableLeaflet(db, context, documentId)
    if (row.translationOfId !== null) throw refused('invalid_state', { code: 'TRANSLATION', message: 'This is a translation: translate the original.' })
    const taken = await db.complianceDocument.findMany({ where: { styleId: row.styleId, kind: KIND, revision: row.revision, origin: 'GENERATED' }, select: { language: true } })
    const wanted = await wantedTranslations(db, { companyId: row.companyId, originalLanguage: row.language, languages, packs, taken: taken.map((entry) => entry.language) })
    if (wanted.length === 0) throw refused('conflict', { code: 'NOTHING_TO_ADD', message: 'Every language these markets ask has a leaflet of this revision already.' })
    if (wanted.length > LANGUAGES_MAX) throw new ValidationError('The translations are not valid.', [{ path: 'body/packs', message: `At most ${LANGUAGES_MAX} languages in one go.` }])
    const style = await db.style.findUniqueOrThrow({ where: { id: row.styleId }, select: STYLE_SELECT })
    const revision = await readRevision(db, row.styleId, row.revision)
    const { plans, reads } = await planTranslations(db, { style, revision, companyId: row.companyId, day: todayOf(), citedCertificateId: row.certificateId }, wanted, sectionsOf(row.sections).sections)
    return { row, style, plans, reads }
  })
  const { row, style, plans, reads } = prepared
  await declarationsCommand(
    caller,
    { name: 'compliance.userInformation.translate', idempotencyKey, input: { documentId, ...body } },
    async (tools) => {
      const { tx } = tools
      await lockStyleDeclarations(tools, row.styleId)
      const original = await tx.complianceDocument.findUniqueOrThrow({ where: { id: documentId }, select: LEAFLET_SELECT })
      if (original.status !== 'DRAFT') throw refused('invalid_state', { code: 'NOT_DRAFT', message: `The original is ${original.status}.` })
      const taken = await tx.complianceDocument.findMany({ where: { styleId: row.styleId, kind: KIND, revision: row.revision, origin: 'GENERATED' }, select: { language: true } })
      for (const plan of plans) {
        const refusal = translationRefusal({ originalLanguage: row.language, language: plan.language, taken: taken.map((entry) => entry.language) })
        if (refusal) throw refused('conflict', refusal)
      }
      for (const plan of plans) await insertTranslation(tools, original, reads.get(plan.language)!, plan, style.code)
      return documentId
    },
    { taken: 'This revision has generated user information in one of these languages already.' },
  )
  return leafletAfter(caller, documentId)
}

/** POST /compliance/user-information/:id/translation-state {version, state}: DRAFT ⇄ IN_TRANSLATION; from CHECKED the check is undone. */
export async function moveTranslation(caller: CommandCaller, documentId: string, body: { readonly version: number; readonly state: 'DRAFT' | 'IN_TRANSLATION' }, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const row = await caller.withClient((db) => writableLeaflet(db, context, documentId))
  if (row.translationOfId === null || row.translationStatus === null) throw refused('invalid_state', { code: 'NOT_A_TRANSLATION', message: 'This is an original: only a translation has a translation state.' })
  const from = row.translationStatus as TranslationState
  const refusal = stateMoveRefusal(from, body.state)
  if (refusal) throw refused('conflict', refusal)
  await declarationsCommand(
    caller,
    { name: 'compliance.userInformation.translationState', idempotencyKey, input: { documentId, ...body }, record: { type: 'ComplianceDocument', id: documentId, expectedVersion: body.version } },
    async ({ tx, audit, emit }) => {
      await tx.complianceDocument.update({ where: { id: documentId }, data: { translationStatus: body.state, translationCheckedAt: null, translationCheckedById: null }, select: { id: true } })
      audit({ action: 'compliance.userInformation.translationState', recordType: 'ComplianceDocument', recordId: documentId, companyId: row.companyId, before: { translationStatus: from }, after: { translationStatus: body.state, checkUndone: from === 'CHECKED' } })
      emit({
        type: 'compliance_user_information.translation_changed',
        subject: documentId,
        companyId: row.companyId,
        payload: { documentId, translationOfId: row.translationOfId!, styleId: row.styleId, language: row.language, marketCode: row.marketCode, state: body.state, change: from === 'CHECKED' ? 'UNCHECKED' : 'MOVED' },
      })
      return documentId
    },
  )
  return leafletAfter(caller, documentId)
}

/** POST /compliance/user-information/:id/check {version}: the translation CHECKED by a second person. */
export async function checkTranslation(caller: CommandCaller, documentId: string, body: { readonly version: number }, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const row = await caller.withClient((db) => writableLeaflet(db, context, documentId, USER_INFORMATION_CHECK))
  const refusal = checkRefusal({ status: row.status, translationState: row.translationStatus as TranslationState | null, authorId: row.createdById, checkerId: context.actorId, sections: sectionsOf(row.sections).sections })
  if (refusal) throw refused(refusal.code === 'OWN_TRANSLATION' || refusal.code === 'OWN_WORDS' ? 'conflict' : 'invalid_state', refusal)
  await declarationsCommand(
    caller,
    { name: 'compliance.userInformation.check', idempotencyKey, input: { documentId, ...body }, record: { type: 'ComplianceDocument', id: documentId, expectedVersion: body.version } },
    async ({ tx, audit, emit, now }) => {
      await tx.complianceDocument.update({ where: { id: documentId }, data: { translationStatus: 'CHECKED', translationCheckedAt: now, translationCheckedById: context.actorId }, select: { id: true } })
      audit({ action: 'compliance.userInformation.check', recordType: 'ComplianceDocument', recordId: documentId, companyId: row.companyId, before: { translationStatus: row.translationStatus }, after: { translationStatus: 'CHECKED', checkedAt: now.toISOString() } })
      emit({ type: 'compliance_user_information.translation_changed', subject: documentId, companyId: row.companyId, payload: { documentId, translationOfId: row.translationOfId!, styleId: row.styleId, language: row.language, marketCode: row.marketCode, state: 'CHECKED', change: 'CHECKED' } })
      return documentId
    },
  )
  return leafletAfter(caller, documentId)
}
