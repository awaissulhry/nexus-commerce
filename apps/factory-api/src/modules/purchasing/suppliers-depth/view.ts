import { leadTimeWindow } from '@nexus/factory-domain/calendars/suppliers'
import { businessDate } from '@nexus/factory-domain/core/time'
import { closuresAhead, orderedOn } from '@nexus/factory-domain/purchasing/suppliers-depth/closures'
import { newOrderProblem, type SupplierKind } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'
import { CONTACT_RECEIVES, routeMail, routingSentence, type ContactReceives } from '@nexus/factory-domain/purchasing/suppliers-depth/routing'
import type { Prisma } from '@nexus/factory-db'
import { supplierCalendarsFor } from '../../../platform/calendars/service'
import type { Reader } from '../store'
import { CONTACT_COLUMNS, nameOf, peopleNames, standingOf, statusView, type ContactRow, type SupplierRow } from './store'

/**
 * The supplier's depth as the record shows it (GET /purchasing/suppliers/:partyId/profile, and every write's answer): its
 * kinds, where it stands with us and since when, why it gets no new order (in words), its default lead time and origin,
 * its closures of the next year from its calendar with when an order placed today arrives, and its contacts with what
 * each receives and who gets each kind of mail (by routing, by W1's role, or nobody).
 */

export const contactsOf = (db: Reader, partyId: string): Promise<ContactRow[]> =>
  db.partyContact.findMany({ where: { partyId }, select: CONTACT_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })

export async function supplierView(db: Reader, row: SupplierRow, now: Date) {
  const today = businessDate(now)
  const contacts = await contactsOf(db, row.id)
  const names = await peopleNames(db, [row.supplierStatusChangedById])
  const loaded = (await supplierCalendarsFor(db as Prisma.TransactionClient, [row.id], leadTimeWindow(today, row.leadTimeDays ?? 0, 'forward'))).get(row.id)
  const calendar = loaded?.calendar ?? null
  const closures = closuresAhead(calendar, today)
  const ordered = orderedOn(calendar, today, row.leadTimeDays)
  const routing = CONTACT_RECEIVES.map((kind) => {
    const routed = routeMail(kind, contacts)
    return { kind, by: routed.by, contactIds: routed.contacts.map((contact) => contact.id), sentence: routingSentence(routed) }
  })
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: nameOf(row),
    legalName: row.legalName,
    roles: [...row.roles],
    partyStatus: row.status,
    kinds: [...row.supplierKinds] as SupplierKind[],
    standing: statusView(row, names),
    newOrderProblem: newOrderProblem(standingOf(row)),
    leadTimeDays: row.leadTimeDays,
    origin: { country: row.originCountry, region: row.originRegion, note: row.originNote, hideCountries: [...row.hideOriginCountries], tannages: [...row.tannages] },
    closures: {
      calendarId: loaded?.calendarRow?.id ?? null,
      weeklyDaysOff: [...closures.weeklyDaysOff],
      ahead: closures.ahead.map((span) => ({ ...span })),
      orderedToday: ordered ? { ...ordered, skipped: [...ordered.skipped] } : null,
    },
    contacts: contacts.map((contact) => ({ ...contact, roles: [...contact.roles], receives: [...contact.receives] as ContactReceives[] })).map(({ partyId: _party, ...contact }) => contact),
    routing,
    version: row.version,
  }
}
export type SupplierDepthView = Awaited<ReturnType<typeof supplierView>>
