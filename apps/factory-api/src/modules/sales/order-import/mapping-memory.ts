import { IMPORTS_RUN, IMPORTS_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { ORDER_IMPORT_KEY } from '@nexus/factory-domain/sales/order-import/importer'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { Layout } from '../../../platform/imports/jobs'

/**
 * B-TH-101 (threads plan TH-9, SHEET-G13; feature SHEET.brand-view-F09 "Import orders for this customer"): order import remembers
 * a customer's columns. A customer sends the same sheet every week with its own headers ("Art.", "Col.", "Tg"); once the office
 * has mapped them and applied an import, the next sheet with the SAME headers for the SAME customer is offered that mapping again
 * (GET /sales/order-import/:importId/remembered-mapping?partyId=, the web's one line on the import screen; the office starts the
 * import again with it, POST /imports `mapping`). Nothing is stored for it: the memory is the newest APPLIED order import of the
 * company whose sheet had the same headers (trimmed, any case, any order) and whose every order went to that customer — the
 * columns its dry run read (the job's layout: header → column, a header it left out → null).
 *
 *   - the asking job: an order import (`sales.orders`) of a company the person may see imports and orders of; else not found;
 *   - the customer: one the person may make orders for (orders.manage over the company and customer) and may run imports;
 *     else nothing is offered — never a hint that another customer exists or has a mapping (W17-like: a mapping kept for brand A
 *     is never offered for brand B; a sheet whose orders went to two customers is no one's memory);
 *   - not read yet (no layout) or no such import before: nothing offered.
 * At most MEMORY_LOOKBACK applied imports are read, the newest first.
 */

export const MEMORY_LOOKBACK = 50

const normalized = (headers: readonly string[]): string[] => [...new Set(headers.map((header) => header.trim().toLowerCase()).filter((header) => header !== ''))].sort()
const sameHeaders = (a: readonly string[], b: readonly string[]): boolean => {
  const left = normalized(a)
  const right = normalized(b)
  return left.length > 0 && left.length === right.length && left.every((header, index) => header === right[index])
}
const layoutOf = (value: unknown): Layout | null => {
  const layout = value as Partial<Layout> | null
  return layout && Array.isArray(layout.headers) && Array.isArray(layout.columns) ? (layout as Layout) : null
}

/** The mapping an import of this layout would start with: each header to its column, the headers it left out to null. */
export function mappingOf(layout: Pick<Layout, 'columns' | 'ignored'>): Record<string, string | null> {
  return {
    ...Object.fromEntries((layout.ignored ?? []).map((entry) => [entry.header, null])),
    ...Object.fromEntries(layout.columns.map((entry) => [entry.header, entry.column])),
  }
}

export interface RememberedMapping {
  readonly remembered: { readonly mapping: Record<string, string | null>; readonly fromImportId: string; readonly fileName: string; readonly appliedAt: string } | null
}

export async function rememberedMapping(caller: CommandCaller, importId: string, partyId: string): Promise<RememberedMapping> {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const job = await client.importJob.findUnique({ where: { id: importId }, select: { id: true, importerKey: true, companyId: true, layout: true } })
    const companyId = job?.companyId ?? null
    if (!job || job.importerKey !== ORDER_IMPORT_KEY || companyId === null || !can(actor, IMPORTS_VIEW, { companyId }) || !can(actor, ORDERS_VIEW, { companyId })) throw new NotFoundError('Import not found.')
    const none: RememberedMapping = { remembered: null }
    if (!can(actor, IMPORTS_RUN, { companyId }) || !can(actor, ORDERS_MANAGE, { companyId, partyId })) return none
    const headers = layoutOf(job.layout)?.headers
    if (!headers) return none
    const before = await client.importJob.findMany({
      where: { importerKey: ORDER_IMPORT_KEY, companyId, status: 'APPLIED', appliedAt: { not: null }, id: { not: job.id } },
      orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
      take: MEMORY_LOOKBACK,
      select: { id: true, layout: true, appliedAt: true, file: { select: { originalName: true } } },
    })
    for (const candidate of before) {
      const layout = layoutOf(candidate.layout)
      if (!layout || !sameHeaders(layout.headers, headers)) continue
      // Whose orders the import made: every row's order line, its order's customer. One customer, and it is this one.
      const lineIds = (await client.importRow.findMany({ where: { jobId: candidate.id, recordId: { not: null } }, select: { recordId: true } })).map((row) => row.recordId!)
      if (lineIds.length === 0) continue
      const lines = await client.salesOrderLine.findMany({ where: { id: { in: [...new Set(lineIds)] } }, select: { order: { select: { partyId: true } } } })
      const parties = new Set(lines.map((line) => line.order.partyId))
      if (lines.length === 0 || parties.size !== 1 || !parties.has(partyId)) continue
      return { remembered: { mapping: mappingOf(layout), fromImportId: candidate.id, fileName: candidate.file.originalName, appliedAt: toUtcIso(candidate.appliedAt!) } }
    }
    return none
  })
}
