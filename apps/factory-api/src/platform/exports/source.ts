import type { Grain } from '@nexus/factory-domain/auth/grains/grains'
import type { Actor, Permission } from '@nexus/factory-domain/core/permissions'
import type { CellValue } from '@nexus/factory-domain/imports/cells'
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
 *   formats     CSV and XLSX by default (+ XLSX_REIMPORT when the source names its importer, below)
 *
 * W2b (B-W2b-11; PLT-184) adds, each optional:
 *   page        the list's address under /w/<company> (`/sales/orders`; default: the list key with `/` for its dots):
 *               the link of the e-mail that says the file is ready (`?export=<job>` opens the job on its list)
 *   refusal     why the person may not export it beyond `permission`, in words (a report they may not run), or null
 *   count       how many rows the view holds, read before the run (JobProgress "38 of 61"); without it the worker
 *               counts by reading the list once without writing (factory-domain views/export/progress.ts)
 *   reimport    "Full file for re-import (XLSX)": the importer (platform/imports registry key) whose layout the file
 *               has and the key of each row (the importer's key columns). The worker reads every importer column the
 *               person may see (money only with its grain) through the importer's own load, so the file reads back
 *               through the same importer as UNCHANGED rows until someone edits a cell.
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

/** What a read may need beyond its query: the file's language (a report's words that a record keeps in both). */
export interface ExportReadOptions {
  readonly locale: ExportLocale
}

export interface ExportReimport<Row> {
  /** The importer's key (`product.materials`): its layout, its key columns, its load. */
  readonly importer: string
  /** The row's key, by the importer's key column names (`{ code: 'PEL-001' }`). */
  key(row: Row): Readonly<Record<string, CellValue>>
}

export interface ExportSource<Query, Row> {
  readonly listKey: string
  readonly permission: Permission
  query(address: URLSearchParams): Query
  read(caller: CommandCaller, query: Query, cursor: string | null, limit: number, options?: ExportReadOptions): Promise<ExportPage<Row>>
  readonly columns: Readonly<Record<string, ExportColumn<Row>>>
  readonly words?: Readonly<Record<ExportLocale, Readonly<Record<string, string>>>>
  readonly formats?: readonly ExportFormat[]
  readonly page?: string
  refusal?(actor: Actor): string | null
  count?(caller: CommandCaller, query: Query): Promise<number>
  readonly reimport?: ExportReimport<Row>
}

/** A source with its types erased, as the registry and the worker hold it. */
export type AnyExportSource = ExportSource<unknown, unknown>

export class ExportSourceError extends Error {
  override name = 'ExportSourceError'
}

/** The list's address under /w/<company>: the source's page, else its key with `/` for its dots. */
export const pageOf = (source: Pick<AnyExportSource, 'listKey' | 'page'>): string => source.page ?? `/${source.listKey.split('.').join('/')}`

/** The formats a source writes: its own, else CSV and XLSX, + XLSX_REIMPORT when it names an importer. */
export const formatsOf = (source: Pick<AnyExportSource, 'formats' | 'reimport'>): ExportFormat[] => [...(source.formats ?? (source.reimport ? ['CSV', 'XLSX', 'XLSX_REIMPORT'] : ['CSV', 'XLSX']))]

/** Declares a list's export. A bad list key, no column or a column id the frame could not name throws at import. */
export function defineExportSource<Query, Row>(source: ExportSource<Query, Row>): AnyExportSource {
  if (!LIST_KEY.test(source.listKey)) throw new ExportSourceError(`${source.listKey}: not a list key (a page id with dots)`)
  const keys = Object.keys(source.columns)
  if (keys.length === 0) throw new ExportSourceError(`${source.listKey}: an export needs a column`)
  for (const key of keys) if (!/^[A-Za-z0-9_.:-]+$/.test(key)) throw new ExportSourceError(`${source.listKey}: "${key}" is not a column id`)
  if (source.formats?.includes('XLSX_REIMPORT') && !source.reimport) throw new ExportSourceError(`${source.listKey}: a file for re-import needs the importer it reads back through`)
  if (source.page !== undefined && !/^\/[a-z0-9/._-]*$/.test(source.page)) throw new ExportSourceError(`${source.listKey}: "${source.page}" is not a page address`)
  return Object.freeze({ ...source }) as unknown as AnyExportSource
}
