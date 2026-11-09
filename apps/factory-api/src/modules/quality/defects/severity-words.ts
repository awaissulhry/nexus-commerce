import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { DEFECT_CLASSES, type DefectClass } from '@nexus/factory-domain/quality/defects/rules'
import { SAFETY_LAW, SAFETY_RULE, SEVERITY_CLASSES, severityClassOf } from '@nexus/factory-domain/quality/defects/severity'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { assertManage, mayManage, officeOf } from './access'
import { floorLanguages, vocabularyChanged } from './vocabulary'

/**
 * The tenant's severity words (B-W2b-213; B-W2b-90's and -118's schema need, W2b schema wave 24/33
 * QualitySettings.severityTexts; design quality.defects df-severity "Text per class … EditModeBar for the texts"; QHS-002).
 *
 *   GET /quality/severity   (./severity.ts) the classes with the words and meaning in force (the tenant's over the standard
 *                           texts, Italian and English), what the tenant wrote per language (`own`), the standard texts,
 *                           the languages to write (Italian, English and the sites' floor languages), `editable` true,
 *                           whether the caller keeps them and the settings row's version.
 *   PUT /quality/severity   quality.defects.manage over every company (the defect library's rule: the words are the whole
 *                           group's): { version, texts } — the whole set (a class or language left out is the standard
 *                           text), or null to go back to the standard texts. ONE command at the tenant-wide QualitySettings
 *                           row's version (made when missing), its audit row and `quality.vocabulary_changed` (list
 *                           SEVERITY, codes = the classes whose words changed), so every picker reads them again.
 *
 * The rule (QHS-002, Reg. (EU) 2016/425): a class keeps its meaning for the rules (critical: never accepted, AQL 0); a tenant
 * changes how each class is called and explained on screen, per language. CRITICAL's meaning is the domain's locked text:
 * its words may be the tenant's, its meaning never (the database refuses one: QualitySettings_severity_texts_check). Each
 * text: not blank, words at most 60 characters, a meaning at most 500; a language is a code of two or three letters.
 */

export const SEVERITY_TEXT_LIMITS = Object.freeze({ words: 60, meaning: 500, languages: 12 })
export const TEXT_PARTS = ['words', 'meaning'] as const
export type TextPart = (typeof TEXT_PARTS)[number]

/** Per class: per part, per language, the tenant's text. */
export type SeverityTexts = Partial<Record<DefectClass, Partial<Record<TextPart, Record<string, string>>>>>

const LANGUAGE = /^[a-z]{2,3}$/
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The texts kept on the settings row, as this file reads them (anything else left out). */
export function textsOf(value: unknown): SeverityTexts {
  if (!isObject(value)) return {}
  const out: SeverityTexts = {}
  for (const klass of DEFECT_CLASSES) {
    const entry = value[klass]
    if (!isObject(entry)) continue
    const parts: Partial<Record<TextPart, Record<string, string>>> = {}
    for (const part of TEXT_PARTS) {
      const texts = entry[part]
      if (!isObject(texts)) continue
      const kept = Object.fromEntries(Object.entries(texts).filter((pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1].trim() !== ''))
      if (Object.keys(kept).length > 0) parts[part] = kept
    }
    if (Object.keys(parts).length > 0) out[klass] = parts
  }
  return out
}

/** Every problem of a set of texts at once (paths `texts/<CLASS>/<part>/<language>`); none: it may be saved. */
export function severityTextsProblems(texts: unknown): Issue[] {
  if (texts === null) return []
  if (!isObject(texts)) return [{ path: 'texts', message: 'The words per class, or null for the standard texts.' }]
  const problems: Issue[] = []
  const languages = new Set<string>()
  for (const [klass, entry] of Object.entries(texts)) {
    const at = `texts/${klass}`
    if (!(DEFECT_CLASSES as readonly string[]).includes(klass)) {
      problems.push({ path: at, message: 'A class is critical, major or minor.' })
      continue
    }
    if (!isObject(entry)) {
      problems.push({ path: at, message: 'Its words and what it means, per language.' })
      continue
    }
    for (const [part, values] of Object.entries(entry)) {
      const partAt = `${at}/${part}`
      if (!(TEXT_PARTS as readonly string[]).includes(part)) {
        problems.push({ path: partAt, message: 'A class has its words and what it means.' })
        continue
      }
      if (klass === 'CRITICAL' && part === 'meaning') {
        problems.push({ path: partAt, message: `What critical means is locked (a safety or compliance failure, never accepted: ${SAFETY_LAW}): only how it is called is yours.` })
        continue
      }
      if (!isObject(values)) {
        problems.push({ path: partAt, message: 'A text per language.' })
        continue
      }
      const limit = SEVERITY_TEXT_LIMITS[part as TextPart]
      for (const [language, text] of Object.entries(values)) {
        const textAt = `${partAt}/${language}`
        languages.add(language)
        if (!LANGUAGE.test(language)) problems.push({ path: textAt, message: 'A language is a code of two or three lower-case letters.' })
        else if (typeof text !== 'string' || text.trim() === '') problems.push({ path: textAt, message: 'Write the text, or leave the language out for the standard one.' })
        else if (text.trim().length > limit) problems.push({ path: textAt, message: `At most ${limit} characters.` })
      }
    }
  }
  if (languages.size > SEVERITY_TEXT_LIMITS.languages) problems.push({ path: 'texts', message: `At most ${SEVERITY_TEXT_LIMITS.languages} languages.` })
  return problems
}

/** The texts as they are kept: trimmed, empty parts and classes left out; null when nothing is the tenant's. */
export function keptTexts(texts: SeverityTexts | null): SeverityTexts | null {
  if (!texts) return null
  const out = textsOf(Object.fromEntries(Object.entries(texts).map(([klass, parts]) => [klass, Object.fromEntries(Object.entries(parts ?? {}).map(([part, values]) => [part, Object.fromEntries(Object.entries(values ?? {}).map(([language, text]) => [language, text.trim()]))]))])))
  return Object.keys(out).length > 0 ? out : null
}

/** The text of a class in a language: the tenant's, else the standard Italian or English, else English (`missing`). */
export function classTextIn(texts: SeverityTexts, klass: DefectClass, part: TextPart, language: string): { readonly text: string; readonly missing: boolean } {
  const standard = severityClassOf(klass)[part]
  const own = klass === 'CRITICAL' && part === 'meaning' ? undefined : texts[klass]?.[part]?.[language]
  if (own) return { text: own, missing: false }
  if (language === 'it') return { text: standard.it, missing: false }
  if (language === 'en') return { text: standard.en, missing: false }
  return { text: standard.en, missing: true }
}

/** The classes whose texts differ between two sets (the event's codes). */
export function changedClasses(before: SeverityTexts, after: SeverityTexts): DefectClass[] {
  return DEFECT_CLASSES.filter((klass) => JSON.stringify(before[klass] ?? {}) !== JSON.stringify(after[klass] ?? {}))
}

// ---- reads and the write -----------------------------------------------------------------------------------------------

type Client = Prisma.TransactionClient

/** The tenant-wide settings row's texts and version (version 0: no row yet). */
export async function tenantTexts(client: Pick<Client, 'qualitySettings'>, tenantId: string): Promise<{ texts: SeverityTexts; version: number; updatedAt: Date | null }> {
  const row = await client.qualitySettings.findUnique({ where: { id: tenantId }, select: { severityTexts: true, version: true, updatedAt: true } })
  return { texts: textsOf(row?.severityTexts ?? null), version: row?.version ?? 0, updatedAt: row?.updatedAt ?? null }
}

/** GET /quality/severity. */
export async function readSeverityWords(caller: CommandCaller) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const counts = await client.defectCode.groupBy({ by: ['severity'], where: { active: true, parentId: { not: null } }, _count: { _all: true } })
    const defectsOf = (klass: string) => counts.find((row) => row.severity === klass)?._count._all ?? 0
    const kept = await tenantTexts(client, context.tenantId)
    const languages = ['it', 'en', ...(await floorLanguages(client))]
    return {
      classes: SEVERITY_CLASSES.map((entry) => ({
        class: entry.class,
        rank: entry.rank,
        words: { it: classTextIn(kept.texts, entry.class, 'words', 'it').text, en: classTextIn(kept.texts, entry.class, 'words', 'en').text },
        meaning: { it: classTextIn(kept.texts, entry.class, 'meaning', 'it').text, en: classTextIn(kept.texts, entry.class, 'meaning', 'en').text },
        acceptanceNumber: entry.acceptanceNumber,
        locked: entry.locked,
        law: entry.law,
        defects: defectsOf(entry.class),
        /** What the tenant wrote, per part and language (empty: the standard text). */
        own: { words: { ...(kept.texts[entry.class]?.words ?? {}) }, meaning: { ...(kept.texts[entry.class]?.meaning ?? {}) } },
        standard: { words: { ...entry.words }, meaning: { ...entry.meaning } },
      })),
      safetyRule: { ...SAFETY_RULE, law: SAFETY_LAW },
      editable: true,
      languages,
      canManage: mayManage(context),
      version: kept.version,
      updatedAt: kept.updatedAt ? toUtcIso(kept.updatedAt) : null,
    }
  })
}

export interface SeverityWordsBody {
  readonly version: number
  readonly texts: SeverityTexts | null
}

/** PUT /quality/severity. */
export async function saveSeverityWords(caller: CommandCaller, body: SeverityWordsBody, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  assertManage(context)
  const problems = severityTextsProblems(body.texts)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The severity words are not valid.', problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
  const next = keptTexts(body.texts)
  const id = context.tenantId
  await command(caller, { name: 'quality.severityWords.save', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const [locked] = await tx.$queryRaw<{ version: number; severityTexts: Prisma.JsonValue | null }[]>`SELECT "version", "severityTexts" FROM "QualitySettings" WHERE "id" = ${id}::uuid FOR UPDATE`
    const version = locked?.version ?? 0
    if (version !== body.version) throw new StaleVersionError('QualitySettings', id, version, body.version)
    const before = textsOf(locked?.severityTexts ?? null)
    const value = (next ?? null) as Prisma.InputJsonValue | null
    if (locked) {
      // A JSON column is cleared in SQL (factory-db exports Prisma's types, not its runtime DbNull).
      if (value === null) await tx.$executeRaw`UPDATE "QualitySettings" SET "severityTexts" = NULL, "version" = "version" + 1, "updatedAt" = ${now} WHERE "id" = ${id}::uuid`
      else await tx.qualitySettings.update({ where: { id }, data: { severityTexts: value, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    } else {
      await tx.qualitySettings
        .create({ data: { id, companyId: null, ...(value === null ? {} : { severityTexts: value }), createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
        .catch((error: unknown) => {
          if ((error as { code?: unknown } | null)?.code === 'P2002') throw new ConflictError('The severity words were just saved by someone else: read them again.')
          throw error
        })
    }
    const changed = changedClasses(before, next ?? {})
    tools.audit({ recordType: 'QualitySettings', recordId: id, companyId: null, before: { severityTexts: before }, after: { severityTexts: next ?? null, classes: changed } })
    vocabularyChanged(tools, 'SEVERITY', 'EDITED', changed)
    return { id }
  })
  return readSeverityWords(caller)
}
