import { statementPrinterOf } from '@nexus/factory-domain/people/myday/rules'
import type { Client } from '../attendance/store'

/**
 * The printer of a worker's statement (B-W2b-89; B-W2b-68's rule with the office's choice first): the printer named in the
 * company's People settings (PeopleSettings.statementPrinterId) while it is an ACTIVE A4 printer, wherever it stands; named
 * and archived: none (held, never another printer); none named: the site's ONE active A4 printer. Read in the tenant's system
 * view (the floor role has no grant on the column).
 */
export async function statementPrinterFor(db: Client, place: { readonly companyId: string; readonly siteId: string }) {
  const select = { id: true, code: true, name: true, companyId: true, siteId: true, kind: true, status: true } as const
  const settings = await db.peopleSettings.findUnique({ where: { id: place.companyId }, select: { statementPrinterId: true } })
  const namedId = settings?.statementPrinterId ?? null
  const named = namedId ? await db.printer.findUnique({ where: { id: namedId }, select }) : null
  const site = namedId ? [] : await db.printer.findMany({ where: { siteId: place.siteId, kind: 'A4_PDF', status: 'ACTIVE' }, select, take: 2 })
  return statementPrinterOf({ id: namedId, printer: named }, site)
}
