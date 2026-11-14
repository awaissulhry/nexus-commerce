import type { Issue } from '../core/errors'

/**
 * Placeholders in the words of a template (B-W2b-422; PLT-231, PLT-232, COL-016): `{{name}}` or `{{record.name}}` (letters,
 * digits and `_`, from a letter, up to five dotted parts; one space inside each brace allowed), as the database's
 * `factory_config_placeholders_ok` accepts them. Which names a template may use is its registry's (documents.ts, mail.ts,
 * replies.ts); the value of each is the issuing code's, filled when a person sends or a document is printed. Pure.
 */

const NAME = '[A-Za-z][A-Za-z0-9_]{0,59}(?:\\.[A-Za-z][A-Za-z0-9_]{0,59}){0,4}'
const pattern = (): RegExp => new RegExp(`\\{\\{ ?(${NAME}) ?\\}\\}`, 'g')

/** The words hold `{{` and `}}` only as placeholders (the database's rule). */
export function placeholderSyntaxOk(words: string | null | undefined): boolean {
  if (words === null || words === undefined) return true
  return !/\{\{|\}\}/.test(words.replace(pattern(), ''))
}

/** The placeholder names the words use, each once, in the order they first appear. */
export function placeholdersIn(words: string | null | undefined): string[] {
  if (!words) return []
  const names: string[] = []
  for (const match of words.matchAll(pattern())) if (!names.includes(match[1]!)) names.push(match[1]!)
  return names
}

/** The problems of a template's words: a broken placeholder, or a name its registry does not offer (each once). */
export function placeholderProblems(words: string | null | undefined, path: string, offered: readonly string[]): Issue[] {
  if (!placeholderSyntaxOk(words)) return [{ path, message: 'Write each placeholder as {{name}}: every {{ closed by }}.' }]
  return placeholdersIn(words)
    .filter((name) => !offered.includes(name))
    .map((name) => ({ path, message: `{{${name}}} is not offered here: use one of the placeholders listed.` }))
}

export type PlaceholderValues = Readonly<Record<string, string | null | undefined>>

/**
 * The words with each placeholder replaced by its value (a name without a value: nothing). A line left empty by an empty
 * value does not leave a gap: more than one empty line in a row become one, and the words are trimmed at both ends.
 */
export function fillPlaceholders(words: string, values: PlaceholderValues): string {
  const filled = words.replace(pattern(), (_all, name: string) => (Object.hasOwn(values, name) ? (values[name] ?? '') : ''))
  return filled
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The names the words use that have no value (an empty one counts as none). */
export function missingValues(words: string, values: PlaceholderValues): string[] {
  return placeholdersIn(words).filter((name) => !(values[name] ?? '').trim())
}
