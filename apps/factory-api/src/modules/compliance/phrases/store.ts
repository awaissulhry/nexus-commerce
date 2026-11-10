import type { Prisma } from '@nexus/factory-db'
import { approvedText, cellOf, type PhraseFacts, type TranslationFacts, type TranslationStatus } from '@nexus/factory-domain/compliance/phrases/rules'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { actorOf, type OfficeContext } from '../../../core/context'
import { companyReach, namesFor, type Reader } from '../register-of-rules/common'
import type { PhraseView } from './contract'

/**
 * The phrase library's reads (B-W2b-249; PRD-343): phrases with their translations, one cell per language, the coverage
 * per language (how much of the library prints in it), and `approvedTexts` — what a label, a DoC or a leaflet prints for
 * a key in a language (the source words, or the approved translation of the current words; null: missing). Later steps
 * (B-W2b-253 label rules, B-W2b-257 the DoC generator, B-W2b-258 user information, B-W2b-270) read the words here.
 */

export const PHRASE_SELECT = {
  id: true,
  key: true,
  kind: true,
  companyId: true,
  sourceLanguage: true,
  sourceText: true,
  revision: true,
  note: true,
  status: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.PhraseSelect
export type PhraseRow = Prisma.PhraseGetPayload<{ select: typeof PHRASE_SELECT }>

export const TRANSLATION_SELECT = {
  id: true,
  phraseId: true,
  language: true,
  revision: true,
  text: true,
  status: true,
  sourceRevision: true,
  translatedById: true,
  createdById: true,
  createdAt: true,
  approvedAt: true,
  approvedById: true,
  version: true,
} as const satisfies Prisma.PhraseTranslationSelect
export type TranslationRow = Prisma.PhraseTranslationGetPayload<{ select: typeof TRANSLATION_SELECT }>

export const factsOf = (row: TranslationRow): TranslationFacts & { phraseId: string; createdAt: Date } => ({ ...row, status: row.status as TranslationStatus })

/** The phrases a person may read (every company's and their companies'), with the filters given. */
export async function readPhrases(db: Reader, context: OfficeContext, where: Prisma.PhraseWhereInput): Promise<PhraseRow[]> {
  return db.phrase.findMany({ where: { AND: [companyReach(actorOf(context)) as Prisma.PhraseWhereInput, where] }, select: PHRASE_SELECT, orderBy: [{ kind: 'asc' }, { key: 'asc' }] })
}

export async function translationsOf(db: Reader, phraseIds: readonly string[], only: 'LIVE' | 'ALL' = 'LIVE'): Promise<Map<string, TranslationRow[]>> {
  if (phraseIds.length === 0) return new Map()
  const rows = await db.phraseTranslation.findMany({
    where: { phraseId: { in: [...phraseIds] }, ...(only === 'LIVE' ? { status: { in: ['DRAFT', 'APPROVED'] } } : {}) },
    select: TRANSLATION_SELECT,
    orderBy: [{ language: 'asc' }, { revision: 'desc' }],
  })
  const out = new Map<string, TranslationRow[]>()
  for (const row of rows) out.set(row.phraseId, [...(out.get(row.phraseId) ?? []), row])
  return out
}

/** The phrases as the grid shows them: one cell per language asked (and per language a translation exists in). */
export async function phraseViews(db: Reader, rows: readonly PhraseRow[], languages: readonly string[]): Promise<PhraseView[]> {
  const translations = await translationsOf(db, rows.map((row) => row.id))
  const all = [...translations.values()].flat()
  const person = await namesFor(db, all.flatMap((row) => [row.translatedById ?? row.createdById, row.approvedById]))
  return rows.map((row) => {
    const own = (translations.get(row.id) ?? []).map(factsOf)
    const shown = [...new Set([...languages, ...own.map((entry) => entry.language)])].sort()
    return {
      id: row.id,
      key: row.key,
      kind: row.kind as PhraseView['kind'],
      companyId: row.companyId,
      sourceLanguage: row.sourceLanguage,
      sourceText: row.sourceText,
      revision: row.revision,
      note: row.note,
      status: row.status as PhraseView['status'],
      version: row.version,
      updatedAt: toUtcIso(row.updatedAt),
      cells: shown.map((language) => {
        const cell = cellOf(row, language, own)
        return {
          language,
          state: cell.state,
          approved: cell.approved
            ? { id: cell.approved.id, text: cell.approved.text, revision: cell.approved.revision, sourceRevision: cell.approved.sourceRevision, approvedAt: cell.approved.approvedAt ? toUtcIso(cell.approved.approvedAt) : null, approvedBy: person(cell.approved.approvedById) }
            : null,
          draft: cell.draft
            ? { id: cell.draft.id, text: cell.draft.text, revision: cell.draft.revision, sourceRevision: cell.draft.sourceRevision, proposedBy: person(cell.draft.translatedById ?? cell.draft.createdById), version: cell.draft.version }
            : null,
        }
      }),
    }
  })
}

/** Per language: how many ACTIVE phrases print in it, wait for an approval, are stale or missing. */
export async function phraseCoverage(db: Reader, context: OfficeContext, languages: readonly string[]) {
  const rows = await readPhrases(db, context, { status: 'ACTIVE' })
  const translations = await translationsOf(db, rows.map((row) => row.id))
  return languages.map((language) => {
    const counts = { language, inLibrary: rows.length, ready: 0, proposed: 0, stale: 0, missing: 0 }
    for (const row of rows) {
      const state = cellOf(row, language, (translations.get(row.id) ?? []).map(factsOf)).state
      if (state === 'SOURCE' || state === 'APPROVED') counts.ready += 1
      else if (state === 'PROPOSED') counts.proposed += 1
      else if (state === 'STALE') counts.stale += 1
      else counts.missing += 1
    }
    return counts
  })
}

/**
 * What prints for each key in each language (ACTIVE phrases only): the source words, or the approved translation of the
 * current words; null when it is missing (a label for a market that needs the language must not print: B-W2b-253/254).
 * In the caller's own scope (office or floor: the floor reads APPROVED and SUPERSEDED translations only, which is enough).
 */
export async function approvedTexts(db: Reader, keys: readonly string[], languages: readonly string[]): Promise<{ key: string; language: string; text: string | null; revision: number }[]> {
  if (keys.length === 0 || languages.length === 0) return []
  const rows = await db.phrase.findMany({ where: { key: { in: [...keys] }, status: 'ACTIVE' }, select: PHRASE_SELECT })
  const translations = await translationsOf(db, rows.map((row) => row.id))
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const out: { key: string; language: string; text: string | null; revision: number }[] = []
  for (const key of keys) {
    const row = byKey.get(key)
    for (const language of languages) {
      const facts: PhraseFacts | undefined = row
      out.push({ key, language, text: facts ? approvedText(facts, language, (translations.get(row!.id) ?? []).map(factsOf)) : null, revision: row?.revision ?? 0 })
    }
  }
  return out
}
