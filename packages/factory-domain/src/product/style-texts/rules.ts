import type { Issue } from '../../core/errors'

/**
 * A style's names and descriptions per language (B-W2b-227; PRD-019), pure. One StyleText row per style and language
 * (factory-db, B-W2b-206: unique per style and language; the database checks the same limits as `textProblems`).
 *
 * Which text a reader gets (`resolveText`): the row of the language asked for, then the row of its base language ("de"
 * for "de-CH"), then W1's own name in that language (Style.nameI18n, Italian and English), then the company's language
 * (its row, then W1's name in it), then the style's own name and description. Labels, the tech pack, the portal and the
 * search read texts through it, so a language nobody wrote yet falls back the same way everywhere.
 */

/** A BCP 47 tag as the database keeps it: a 2-3 letter language, then subtags of 1-8 letters or digits ("it", "de-CH"). */
export const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/
export const TEXT_LIMITS = Object.freeze({ name: 200, shortDescription: 500, longDescription: 10_000, language: 35 })

/** The tag in its stored form: the language in lower case, a 2-letter region in capitals ("DE-ch" → "de-CH"). Null: not a tag. */
export function normaliseLanguage(value: string): string | null {
  const parts = value.trim().replace(/_/g, '-').split('-')
  if (parts.some((part) => part.length === 0)) return null
  const [first, ...rest] = parts
  const tag = [first!.toLowerCase(), ...rest.map((part, index) => (index === 0 && /^[A-Za-z]{2}$/.test(part) ? part.toUpperCase() : part))].join('-')
  return tag.length <= TEXT_LIMITS.language && LANGUAGE_TAG.test(tag) ? tag : null
}

/** "de" for "de-CH"; the tag itself when it has no subtag. */
export const baseLanguage = (tag: string): string => tag.split('-')[0]!

export interface StyleTextInput {
  readonly name: string
  readonly shortDescription: string | null
  readonly longDescription: string | null
}

// Control characters but tab and line breaks (a long description keeps its paragraphs); a one-line text has none at all.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

function textProblem(value: string, max: number, lines: boolean): string | null {
  if (value.trim().length === 0) return 'Write something, or leave it out.'
  if (value.length > max) return `At most ${max} characters (${value.length} now).`
  if (!lines && /[\r\n]/.test(value)) return 'One line, without line breaks.'
  if (CONTROL.test(value) || (!lines && /\t/.test(value))) return lines ? 'Remove the hidden control characters.' : 'Remove the hidden control characters (tabs too).'
  return null
}

/** What is wrong with a text, each at its field (`name`, `shortDescription`, `longDescription`). */
export function textProblems(input: StyleTextInput): Issue[] {
  const issues: Issue[] = []
  const add = (path: string, problem: string | null) => {
    if (problem) issues.push({ path, message: problem })
  }
  add('name', textProblem(input.name, TEXT_LIMITS.name, false))
  if (input.shortDescription !== null) add('shortDescription', textProblem(input.shortDescription, TEXT_LIMITS.shortDescription, false))
  if (input.longDescription !== null) add('longDescription', textProblem(input.longDescription, TEXT_LIMITS.longDescription, true))
  return issues
}

/** A stored text row (what `resolveText` reads). */
export interface StoredText {
  readonly language: string
  readonly name: string
  readonly shortDescription: string | null
  readonly longDescription: string | null
}

/** The style's own words (W1): its name, its Italian and English names, its description. */
export interface StyleWords {
  readonly name: string
  readonly nameI18n: Readonly<Record<string, string | undefined>> | null
  readonly description: string | null
}

/**
 * Where a resolved text came from: the row of the language (TEXT), of its base language (BASE_TEXT), W1's name in it
 * (STYLE_NAME), the company language's row (COMPANY_TEXT) or W1's name in it (COMPANY_STYLE_NAME), the style itself (STYLE).
 */
export const TEXT_SOURCES = ['TEXT', 'BASE_TEXT', 'STYLE_NAME', 'COMPANY_TEXT', 'COMPANY_STYLE_NAME', 'STYLE'] as const
export type TextSource = (typeof TEXT_SOURCES)[number]

export interface ResolvedText {
  /** The language asked for. */
  readonly language: string
  /** The language of the words given (null: the style's own name, in no language in particular). */
  readonly from: string | null
  readonly source: TextSource
  readonly name: string
  readonly shortDescription: string | null
  readonly longDescription: string | null
}

/**
 * The text of a style in `language`, falling back as the header says. The descriptions come with the name they belong to,
 * but for the style's own description, which only the last step (or W1's name in a language, which has none) gives.
 */
export function resolveText(rows: readonly StoredText[], style: StyleWords, language: string, companyLanguage: string): ResolvedText {
  const asked = normaliseLanguage(language) ?? language
  const company = normaliseLanguage(companyLanguage) ?? companyLanguage
  const row = (tag: string) => rows.find((entry) => entry.language === tag)
  const styleName = (tag: string) => {
    const value = style.nameI18n?.[tag] ?? style.nameI18n?.[baseLanguage(tag)]
    return typeof value === 'string' && value.trim().length > 0 ? value : null
  }
  const fromRow = (entry: StoredText, source: TextSource): ResolvedText => ({
    language: asked,
    from: entry.language,
    source,
    name: entry.name,
    shortDescription: entry.shortDescription,
    longDescription: entry.longDescription,
  })
  const fromName = (name: string, from: string, source: TextSource): ResolvedText => ({ language: asked, from, source, name, shortDescription: null, longDescription: style.description })

  const own = row(asked)
  if (own) return fromRow(own, 'TEXT')
  const base = asked === baseLanguage(asked) ? undefined : row(baseLanguage(asked))
  if (base) return fromRow(base, 'BASE_TEXT')
  const named = styleName(asked)
  if (named) return fromName(named, asked, 'STYLE_NAME')
  const companyRow = row(company) ?? row(baseLanguage(company))
  if (companyRow) return fromRow(companyRow, 'COMPANY_TEXT')
  const companyName = styleName(company)
  if (companyName) return fromName(companyName, company, 'COMPANY_STYLE_NAME')
  return { language: asked, from: null, source: 'STYLE', name: style.name, shortDescription: null, longDescription: style.description }
}

/** Every name a style has, in any language, once each (what the search and the portal's search match). */
export function everyName(rows: readonly StoredText[], style: StyleWords): string[] {
  const names = [style.name, ...Object.values(style.nameI18n ?? {}), ...rows.map((entry) => entry.name)]
  return [...new Set(names.filter((name): name is string => typeof name === 'string' && name.trim().length > 0))]
}
