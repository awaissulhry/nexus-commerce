import type { Prisma } from '@nexus/factory-db'
import { PROCESS_WORDS, type CauseProcess } from '@nexus/factory-domain/quality/defects/causes'
import { isHideDefect } from '@nexus/factory-domain/quality/defects/grades'
import { appliesAt, type DefectClass, type QualityStage } from '@nexus/factory-domain/quality/defects/rules'
import { classesAllowed, classLocked, classWordsIn, SEVERITY_CLASSES } from '@nexus/factory-domain/quality/defects/severity'
import { coverageOf, languageOf, otherFloorLanguages, wordsIn, type CoverageList, type CoverageRow, type VocabularyChange, type VocabularyList } from '@nexus/factory-domain/quality/defects/vocabulary'
import type { CommandCaller, CommandTools } from '../../../core/command'
import type { FloorContext, OfficeContext } from '../../../core/context'
import { officeOf, officeOrFloorOf } from './access'

/**
 * The defect vocabulary in the person's language (B-W2b-90; QHS-007; design floor.reasons, quality.defects): ONE read
 * for every picker of the office and the floor, so an inspection step, the bench and the cutting table pick from the same
 * codes, each shown in the language of the person reading it.
 *
 *   GET /quality/vocabulary            any office or floor session (`?stage=` the defects of a stage, none: all;
 *                                      `?language=` an ISO 639 code, none: the person's own: the worker's on the floor,
 *                                      the user's in the office). The severity classes, the active defects of active
 *                                      categories (icon and colour their own, else their category's; the classes a
 *                                      record may give each: a critical one stays critical), the hide defects (the hide
 *                                      category's, for incoming and cutting), the active cause codes and leather grades;
 *                                      each with its words in that language, `missing` where it has none (English stands
 *                                      in). Nothing personal, no money.
 *   GET /quality/vocabulary/coverage   quality.defects.view: per other floor language of the tenant's sites, the active
 *                                      codes of the library, the causes and the grades with no words in it.
 *
 * The shared parts of causes.ts and grades.ts live here too: the words of a JSON column, the tenant's floor languages,
 * and the one place that emits `quality.vocabulary_changed`.
 */

type Client = Prisma.TransactionClient

export const wordsOf = (value: Prisma.JsonValue): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

/** The other floor languages of the sites the caller sees (the editor's word columns; the floor: its own site's). */
export async function floorLanguages(client: Pick<Client, 'site'>): Promise<string[]> {
  return otherFloorLanguages(await client.site.findMany({ select: { floorLocales: true } }))
}

/** The one emit of the vocabulary event (cause codes and leather grades); nothing changed: nothing emitted. */
export function vocabularyChanged(tools: Pick<CommandTools, 'emit'>, list: VocabularyList, change: VocabularyChange, codes: readonly string[]): void {
  if (codes.length > 0) tools.emit({ type: 'quality.vocabulary_changed', subject: 'defect-vocabulary', companyId: null, siteId: null, payload: { list, change, codes: [...codes] } })
}

/** The words of retiring a used cause or grade (design df-retire's, for the two lists). */
export function retiredWords(what: 'Cause code' | 'Grade', code: string, used: number): string {
  return used === 0
    ? `${what} ${code} is not used yet: retiring it takes it out of the pickers.`
    : `${what} ${code} is used on ${used} ${used === 1 ? 'record' : 'records'}; it stays on them and leaves the pickers.`
}

/** The person's own language: the signed-in worker's on the floor, the user's in the office. */
async function personalLanguage(client: Pick<Client, 'worker' | 'user'>, context: OfficeContext | FloorContext): Promise<string | null> {
  if (context.audience === 'floor') return (await client.worker.findUnique({ where: { id: context.actorId }, select: { locale: true } }))?.locale ?? null
  return (await client.user.findUnique({ where: { id: context.actorId }, select: { locale: true } }))?.locale ?? null
}

const DEFECT_COLUMNS = {
  id: true,
  parentId: true,
  code: true,
  labelIt: true,
  labelEn: true,
  labelI18n: true,
  icon: true,
  colour: true,
  pictureFileId: true,
  severity: true,
  zone: true,
  stages: true,
  needsDetail: true,
  sortOrder: true,
  active: true,
} as const satisfies Prisma.DefectCodeSelect
type DefectRow = Prisma.DefectCodeGetPayload<{ select: typeof DEFECT_COLUMNS }>

const byOrder = (a: { sortOrder: number; code: string }, b: { sortOrder: number; code: string }): number => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)

export interface VocabularyQuery {
  readonly stage?: QualityStage | undefined
  readonly language?: string | undefined
}

/** GET /quality/vocabulary. */
export async function readVocabulary(caller: CommandCaller, query: VocabularyQuery) {
  const context = officeOrFloorOf(caller)
  return caller.withClient(async (client) => {
    // One after the other: a scoped client runs one statement at a time.
    const language = languageOf(query.language, await personalLanguage(client, context))
    const languages = ['it', 'en', ...(await floorLanguages(client))]
    const library = await client.defectCode.findMany({ where: { active: true }, select: DEFECT_COLUMNS })
    const causes = await client.causeCode.findMany({ where: { active: true }, select: { id: true, code: true, labelIt: true, labelEn: true, labelI18n: true, process: true, sortOrder: true } })
    const grades = await client.leatherGrade.findMany({ where: { active: true }, select: { id: true, code: true, labelIt: true, labelEn: true, labelI18n: true, usableShare: true, sortOrder: true } })
    const categories = new Map(library.filter((row) => row.parentId === null).map((row) => [row.id, row]))
    const inLibrary = library.filter((row) => row.parentId !== null && categories.has(row.parentId)).sort((a, b) => byOrder(categories.get(a.parentId!)!, categories.get(b.parentId!)!) || byOrder(a, b))
    const defectOf = (row: DefectRow) => {
      const category = categories.get(row.parentId!)!
      const words = wordsIn({ ...row, labelI18n: wordsOf(row.labelI18n) }, language)
      const severity = row.severity as DefectClass
      return {
        id: row.id,
        code: row.code,
        category: { id: category.id, code: category.code, label: wordsIn({ ...category, labelI18n: wordsOf(category.labelI18n) }, language).label },
        label: words.label,
        missing: words.missing,
        icon: row.icon ?? category.icon,
        colour: row.colour ?? category.colour,
        pictureFileId: row.pictureFileId,
        severity,
        classLocked: classLocked(severity),
        classes: classesAllowed(severity),
        zone: row.zone,
        stages: [...row.stages],
        needsDetail: row.needsDetail,
      }
    }
    return {
      language,
      languages,
      classes: SEVERITY_CLASSES.map((entry) => ({
        class: entry.class,
        label: classWordsIn(entry.class, language),
        meaning: language === 'it' ? entry.meaning.it : entry.meaning.en,
        locked: entry.locked,
        missing: language !== 'it' && language !== 'en',
      })),
      defects: inLibrary.filter((row) => query.stage === undefined || appliesAt(row.stages, query.stage)).map(defectOf),
      hideDefects: inLibrary.filter((row) => isHideDefect(row, categories.get(row.parentId!)!.code)).map(defectOf),
      causes: [...causes].sort(byOrder).map((row) => {
        const words = wordsIn({ ...row, labelI18n: wordsOf(row.labelI18n) }, language)
        const process = PROCESS_WORDS[row.process as CauseProcess]
        return { id: row.id, code: row.code, label: words.label, missing: words.missing, process: row.process as CauseProcess, processLabel: language === 'it' ? process.it : process.en }
      }),
      grades: [...grades].sort(byOrder).map((row) => {
        const words = wordsIn({ ...row, labelI18n: wordsOf(row.labelI18n) }, language)
        return { id: row.id, code: row.code, label: words.label, missing: words.missing, usableShare: row.usableShare.toFixed(2) }
      }),
    }
  })
}

/** GET /quality/vocabulary/coverage. */
export async function readCoverage(caller: CommandCaller) {
  officeOf(caller)
  return caller.withClient(async (client) => {
    const sites = await client.site.findMany({ select: { floorLocales: true } })
    const rows = { code: true, labelI18n: true, active: true, sortOrder: true } as const
    const library = await client.defectCode.findMany({ select: { ...rows, parentId: true } })
    const causes = await client.causeCode.findMany({ select: rows })
    const grades = await client.leatherGrade.findMany({ select: rows })
    const listed = (list: readonly { code: string; labelI18n: Prisma.JsonValue; active: boolean; sortOrder: number }[]): CoverageRow[] =>
      [...list].sort(byOrder).map((row) => ({ code: row.code, active: row.active, labelI18n: wordsOf(row.labelI18n) }))
    const lists: Record<CoverageList, CoverageRow[]> = { DEFECTS: listed(library), CAUSES: listed(causes), GRADES: listed(grades) }
    return { languages: coverageOf(lists, sites) }
  })
}
