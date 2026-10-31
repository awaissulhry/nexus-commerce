import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { defineReportMeta, type ReportMeta } from '@nexus/factory-domain/insights/reports/definition'
import type { ReportRow } from '@nexus/factory-domain/insights/reports/rights'
import type { CommandCaller } from '../../../core/command'

/**
 * What a standard report is on the API side (B-W2a-79; ANA-029): ONE file per report in `./defs/` (`sales.late-orders.ts`
 * …), default-exporting `defineReport({ ...meta, read })`. The folder is the registry (./report-files.ts finds the files
 * for the routes, the tests and the build alike): a step that adds a report adds its file and edits no list.
 *
 *   meta   factory-domain insights/reports/definition (key, area, title, question, permission, needs, columns, filters,
 *          sources, definition, numbers, mail, formats), checked when the file is imported
 *   read   the rows of one run, read AS THE PERSON through the module's own list or read function (its company, site and
 *          party scopes; money it marks for the grain filter), under the filters the run applied. Every column's cell,
 *          money in minor units of the row's currency. It returns at most `limit` rows and says whether it stopped there.
 *
 * The rights are applied around the read (./run.ts): a person who cannot read the list never reaches `read`; a column of
 * a grain they lack is dropped from every row before the answer; people figures of small groups are blanked.
 */

export interface ReportRun {
  readonly caller: CommandCaller
  /** The run's filter values (the definition's keys; a site filter's value is a site id the person reaches, or null). */
  readonly filters: Readonly<Record<string, string | null>>
  /** The site's day the run is for (Europe/Rome). */
  readonly today: BusinessDate
  readonly now: Date
  readonly limit: number
  /** The reader's language, for words a record keeps in both (a reason code's label). */
  readonly locale: 'it' | 'en'
}

export interface ReportRead {
  readonly rows: readonly ReportRow[]
  /** False when the module's list or the report stopped before every row (the answer says "first N"). */
  readonly complete: boolean
  /** When the read's data stands (default: now). */
  readonly asOf?: Date
  /** What the run looked at, in words the web knows (`period` → from/to days), beside the filters. */
  readonly range?: { readonly from: BusinessDate; readonly to: BusinessDate } | null
  /** A filter the read settled itself (a report of one site picks the first when none is asked): its value and words. */
  readonly applied?: Readonly<Record<string, { readonly value: string; readonly label: string }>>
}

export interface ReportDefinition extends ReportMeta {
  read(run: ReportRun): Promise<ReportRead>
}

export class ReportConfigError extends Error {
  override name = 'ReportConfigError'
}

/** Declares a report: the meta is checked at import (a bad one never reaches the registry). */
export function defineReport(definition: ReportDefinition): ReportDefinition {
  if (typeof definition.read !== 'function') throw new ReportConfigError(`${definition.key}: a report reads its rows`)
  const meta = defineReportMeta(definition)
  return Object.freeze({ ...meta, read: definition.read })
}

export function isReport(value: unknown): value is ReportDefinition {
  return typeof value === 'object' && value !== null && typeof (value as ReportDefinition).key === 'string' && typeof (value as ReportDefinition).read === 'function'
}
