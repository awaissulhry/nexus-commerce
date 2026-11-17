import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import type { ImportJob } from '../../../admin/import/api'

/**
 * B-TH-293 (threads plan TH-9, SHEET-G13; feature SHEET.brand-view-F09 "Import orders for this customer"; wall W17): order import
 * remembers a customer's columns. When the Orders sheet is on one customer (the Customer switcher, `?party=`) and a sheet's dry run
 * has read its headers, the API offers the columns of that customer's last applied import of a sheet with the same headers
 * (GET /sales/order-import/:importId/remembered-mapping?partyId=, B-TH-101). The import screen says so in one line: the columns
 * were read the same way (nothing to do), or "Use them" checks the sheet again with them. Asked only for the sheet's own customer
 * (W17: a mapping kept for customer A is never offered for customer B; without a customer nothing is asked). Pure rules and the
 * one read; no React.
 */

const rememberedSchema = z.object({
  remembered: z.object({ mapping: z.record(z.string(), z.string().nullable()), fromImportId: z.string(), fileName: z.string(), appliedAt: z.string() }).nullable(),
})
export type Remembered = NonNullable<z.infer<typeof rememberedSchema>['remembered']>

/** The columns a customer's last import of the same headers used, or null (none, or the person may not import for that customer). */
export const rememberedMapping = (api: ApiClient, importId: string, partyId: string, signal?: AbortSignal): Promise<Remembered | null> =>
  api.get(`/sales/order-import/${encodeURIComponent(importId)}/remembered-mapping`, { query: { partyId }, schema: rememberedSchema, signal }).then((answer) => answer.remembered)

/** What the dry run read (platform/imports Layout), as far as the mapping needs it. */
interface LayoutFacts {
  readonly columns?: ReadonlyArray<{ readonly header: string; readonly column: string }>
  readonly ignored?: ReadonlyArray<{ readonly header: string }>
}

/** The mapping a job's dry run used: each header to its column, a header it left out to null (the API's mappingOf); null: not read yet. */
export function mappingOfJob(job: Pick<ImportJob, 'layout'>): Record<string, string | null> | null {
  const layout = job.layout as LayoutFacts | null
  if (!layout || !Array.isArray(layout.columns)) return null
  return { ...Object.fromEntries((layout.ignored ?? []).map((entry) => [entry.header, null])), ...Object.fromEntries(layout.columns.map((entry) => [entry.header, entry.column])) }
}

/** The two mappings read the sheet the same way: every header to the same column (a header both leave out counts as the same). */
export function sameMapping(a: Readonly<Record<string, string | null>>, b: Readonly<Record<string, string | null>>): boolean {
  const key = (header: string) => header.trim().toLowerCase()
  const left = new Map(Object.entries(a).map(([header, column]) => [key(header), column]))
  const right = new Map(Object.entries(b).map(([header, column]) => [key(header), column]))
  const headers = new Set([...left.keys(), ...right.keys()])
  for (const header of headers) if ((left.get(header) ?? null) !== (right.get(header) ?? null)) return false
  return true
}

/** The one line on the import screen: the customer, the earlier sheet, whether it changes how this sheet is read. */
export interface ImportMemory {
  readonly customer: string
  readonly fileName: string
  readonly appliedAt: string
  /** true: this sheet was read with the same columns (nothing to do); false: "Use them" checks it again with those columns. */
  readonly same: boolean
  /** The columns to check the sheet again with. */
  readonly mapping: Readonly<Record<string, string | null>>
  readonly busy: boolean
}

/** Whether to ask for a job: a dry run that read its headers, the sheet's customer known, the person may run imports. */
export function asksMemory(job: Pick<ImportJob, 'status' | 'layout'> | null | undefined, partyId: string | null, mayRun: boolean): boolean {
  return !!job && job.status === 'PLANNED' && partyId !== null && mayRun && mappingOfJob(job) !== null
}

/** The line, or null: nothing remembered for this customer (nothing is said: never a hint that another customer has one). */
export function memoryOf(job: Pick<ImportJob, 'layout'>, remembered: Remembered | null, customer: string | null, busy: boolean): ImportMemory | null {
  const now = mappingOfJob(job)
  if (!remembered || !now || !customer) return null
  return { customer, fileName: remembered.fileName, appliedAt: remembered.appliedAt, same: sameMapping(now, remembered.mapping), mapping: remembered.mapping, busy }
}
