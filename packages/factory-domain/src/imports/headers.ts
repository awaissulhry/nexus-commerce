import type { Issue } from '../core/errors'
import { foldWord } from './cells'

/**
 * Header mapping (feature PLT-176 "map columns"), pure: which column of the sheet feeds which column of the importer.
 * A header matches a column by the column's name, its label or one of its aliases, compared without case, accents,
 * punctuation or spacing ("Prezzo unitario (€)" = "prezzo unitario", "unit_price" = "unitPrice" = "Unit price"). A
 * person can override the match per header (`overrides`: header → column, or null to ignore that header): the import
 * screen offers that when a header is not recognised.
 *
 * The result lists every sheet column once: mapped or ignored. Problems that stop the dry run: a required column with
 * no header, two headers for one column, an override naming a column the importer does not have. An unknown header
 * is ignored, and said (the screen shows it).
 */

export interface MappedColumn {
  /** The column's position in the sheet, from 0. */
  readonly index: number
  /** The header as written in the sheet. */
  readonly header: string
  /** The importer's column. */
  readonly column: string
}

export interface IgnoredColumn {
  readonly index: number
  readonly header: string
  /** unknown: no column matches it; ignored: the override said so; blank: the header cell is empty. */
  readonly reason: 'unknown' | 'ignored' | 'blank'
}

export interface HeaderMapping {
  readonly columns: readonly MappedColumn[]
  readonly ignored: readonly IgnoredColumn[]
  readonly issues: readonly Issue[]
}

/** What header mapping needs of an importer's column. */
export interface MappableColumn {
  readonly label: string
  readonly aliases?: readonly string[]
  readonly required?: boolean
}

/** A header, a column name, label or alias as compared: camelCase split, folded, punctuation as spaces. */
export function normaliseHeader(text: string): string {
  const split = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return foldWord(split)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Every name a column answers to, normalised. */
export function namesOf(name: string, column: MappableColumn): string[] {
  return [...new Set([name, column.label, ...(column.aliases ?? [])].map(normaliseHeader).filter((value) => value !== ''))]
}

/** The lookup from normalised name to column. Two columns answering to one name is an error (defineImporter). */
export function headerLookup(columns: Readonly<Record<string, MappableColumn>>): { lookup: Map<string, string>; clashes: string[] } {
  const lookup = new Map<string, string>()
  const clashes: string[] = []
  for (const [name, column] of Object.entries(columns)) {
    for (const key of namesOf(name, column)) {
      const other = lookup.get(key)
      if (other !== undefined && other !== name) clashes.push(`"${key}" names both ${other} and ${name}`)
      else lookup.set(key, name)
    }
  }
  return { lookup, clashes }
}

export function mapHeaders(
  columns: Readonly<Record<string, MappableColumn>>,
  headers: readonly string[],
  overrides: Readonly<Record<string, string | null>> = {},
): HeaderMapping {
  const { lookup } = headerLookup(columns)
  const override = new Map(Object.entries(overrides).map(([header, column]) => [normaliseHeader(header), column]))
  const mapped: MappedColumn[] = []
  const ignored: IgnoredColumn[] = []
  const issues: Issue[] = []

  for (const [header, column] of Object.entries(overrides)) {
    if (column !== null && !Object.hasOwn(columns, column)) {
      issues.push({ path: `mapping/${header}`, message: `This import has no column ${column}.` })
    }
    if (!headers.some((text) => normaliseHeader(text) === normaliseHeader(header))) {
      issues.push({ path: `mapping/${header}`, message: 'The sheet has no column with this header.' })
    }
  }

  headers.forEach((text, index) => {
    const header = text.trim()
    const key = normaliseHeader(header)
    if (key === '') {
      ignored.push({ index, header, reason: 'blank' })
      return
    }
    const chosen = override.has(key) ? override.get(key)! : (lookup.get(key) ?? undefined)
    if (chosen === null) {
      ignored.push({ index, header, reason: 'ignored' })
      return
    }
    if (chosen === undefined || !Object.hasOwn(columns, chosen)) {
      ignored.push({ index, header, reason: 'unknown' })
      return
    }
    mapped.push({ index, header, column: chosen })
  })

  for (const name of Object.keys(columns)) {
    const feeding = mapped.filter((entry) => entry.column === name)
    if (feeding.length > 1) {
      issues.push({
        path: `column/${name}`,
        message: `The headers ${feeding.map((entry) => `"${entry.header}"`).join(' and ')} both mean ${columns[name]!.label}; map one of them to another column or ignore it.`,
      })
    }
    if (columns[name]!.required && feeding.length === 0) {
      issues.push({ path: `column/${name}`, message: `The sheet has no column for ${columns[name]!.label}, which is required.` })
    }
  }
  return { columns: mapped, ignored, issues }
}
