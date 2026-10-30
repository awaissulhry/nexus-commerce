import type { Grain } from '@nexus/factory-domain/auth/grains/grains'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { ExportCell, ExportFormat, ExportLocale } from '@nexus/factory-domain/views/exports'
import { LIST_KEY } from '@nexus/factory-domain/views/state'
import type { CommandCaller } from '../../core/command'

/**
 * The lists that can be exported (B-W2a-23; PLT-179): one export source per list, in `sources/` (one file per list,
 * listed in sources/index.ts), named by the list's page id (`sales.orders`) as the web's list frame names it. A source
 * says how to read its list as the person who asked — through the list's OWN read (the module's list function), so the
 * file holds exactly the rows the screen shows that person, with the same filters and scopes — and what each of the
 * screen's columns holds:
 *
 *   permission  the list's own view permission (asked over the screen's company, beside views.export)
 *   query       the list's address terms (the frame sends the screen's address: `late=true&q=rossi`) → its read's query;
 *               unknown terms are ignored, a bad one is a ValidationError (the list itself would refuse it)
 *   read        one page of rows in the list's order and the cursor of the next page
 *   columns     by the frame's column id: the cell (factory-domain views/exports ExportCell) and, for money, its grain:
 *               a column of a grain the person does not hold is never read into the file (it is named instead)
 *   words       the words of the codes a cell names (statuses), per language (the file is in the person's language)
 *   formats     CSV and XLSX by default; XLSX_REIMPORT only for a list whose importer reads the file back
 *
 * A list without a source shows no Export ▾ (its own "Export N" of the selected rows stays). Tests set their own
 * sources with useExportSources([...]).
 */

export interface ExportColumn<Row> {
  /** The money grain of the column; absent: not money. */
  readonly grain?: Grain
  /** The cell of a row. `words(code)` gives a code's words in the file's language (the source's `words`). */
  value(row: Row, words: (code: string) => string): ExportCell
}

export interface ExportPage<Row> {
  readonly rows: readonly Row[]
  readonly next: string | null
}

export interface ExportSource<Query, Row> {
  readonly listKey: string
  readonly permission: Permission
  query(address: URLSearchParams): Query
  read(caller: CommandCaller, query: Query, cursor: string | null, limit: number): Promise<ExportPage<Row>>
  readonly columns: Readonly<Record<string, ExportColumn<Row>>>
  readonly words?: Readonly<Record<ExportLocale, Readonly<Record<string, string>>>>
  readonly formats?: readonly ExportFormat[]
}

/** A source with its types erased, as the registry and the worker hold it. */
export type AnyExportSource = ExportSource<unknown, unknown>

export class ExportSourceError extends Error {
  override name = 'ExportSourceError'
}

/** Declares a list's export. A bad list key, no column or a column id the frame could not name throws at import. */
export function defineExportSource<Query, Row>(source: ExportSource<Query, Row>): AnyExportSource {
  if (!LIST_KEY.test(source.listKey)) throw new ExportSourceError(`${source.listKey}: not a list key (a page id with dots)`)
  const keys = Object.keys(source.columns)
  if (keys.length === 0) throw new ExportSourceError(`${source.listKey}: an export needs a column`)
  for (const key of keys) if (!/^[A-Za-z0-9_.:-]+$/.test(key)) throw new ExportSourceError(`${source.listKey}: "${key}" is not a column id`)
  return Object.freeze({ ...source }) as unknown as AnyExportSource
}
