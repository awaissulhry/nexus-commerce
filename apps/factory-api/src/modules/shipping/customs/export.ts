import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SHIPPING_CUSTOMS_MANAGE } from '@nexus/factory-domain/shipping/customs/permissions'
import { CUSTOMS_REFUSAL_WORDS, EXIT_ALERT_DAYS, exitDaysLeft, exitDueAt, exitOverdue, type CustomsRefusal, type DeclarationStatus } from '@nexus/factory-domain/shipping/customs/rules'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { mayOn } from '../access'
import { declarationOf, type DeclarationRow } from './declarations'
import { customsFactsOf, exportInvoicesOf, type CustomsFacts } from './facts'
import { customsDocumentsOf, customsShipment, documentView, heldWords, papersHeld, postalChoiceOf, seesValuesOf } from './papers'
import { territoryWords } from '@nexus/factory-domain/tax/special-territories'

/**
 * The shipment's Export tab, read (B-W2b-409; design warehouse.shipments record › Export "Export papers": destination class,
 * Incoterm and place, the commercial invoice, CN 22 / CN 23, the broker pack link, the MRN, the proof of exit with a countdown
 * to the alert; "domestic shipment: Not needed: delivered in Italy"). GET /shipping/shipments/:shipmentId/export, shipping.view.
 * No amount is answered (the papers' values are in their PDFs, behind the price grain); the declaration's broker is a party
 * name, the MRN a customs reference. What a person may do now is said in codes with words (held), never a dead button.
 */

const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

/** What stops a CN 22 / CN 23 now beside the papers' own refusal (the parcels packed, weighed, every style weighed). */
function postalHeld(facts: CustomsFacts): CustomsRefusal | null {
  if (facts.unpacked > 0 || facts.parcels.length === 0 || facts.parcels.some((parcel) => parcel.items.length === 0)) return 'NOT_PACKED'
  if (facts.parcels.some((parcel) => parcel.grossKg === null)) return 'NOT_WEIGHED'
  if (facts.parcels.some((parcel) => parcel.items.some((item) => item.netKg === null))) return 'CUSTOMS_DATA'
  return null
}

async function declarationView(db: CommandTx, row: DeclarationRow, shippedAt: Date | null, now: Date) {
  const broker = row.brokerPartyId ? await db.party.findUnique({ where: { id: row.brokerPartyId }, select: { id: true, legalName: true, tradeName: true } }) : null
  const invoice = row.invoiceId ? await db.invoice.findUnique({ where: { id: row.invoiceId }, select: { id: true, number: true, issueDate: true } }) : null
  const file = row.exitFileId ? await db.storedFile.findUnique({ where: { id: row.exitFileId }, select: { id: true, originalName: true } }) : null
  const links = await db.oneOffLink.findMany({
    where: { purpose: 'BROKER_PACK', recordType: 'CustomsDeclaration', recordId: row.id },
    select: { id: true, email: true, expiresAt: true, revokedAt: true, uses: true, maxUses: true, lastUsedAt: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 20,
  })
  const due = exitDueAt(shippedAt, row.alertAfterDays)
  return {
    id: row.id,
    status: row.status as DeclarationStatus,
    filedBy: row.brokerPartyId ? ('BROKER' as const) : ('CARRIER' as const),
    broker: broker ? { id: broker.id, name: broker.tradeName ?? broker.legalName } : null,
    mrn: row.mrn,
    invoice: invoice ? { id: invoice.id, number: invoice.number ?? '', date: invoice.issueDate ? invoice.issueDate.toISOString().slice(0, 10) : null } : null,
    exitConfirmedAt: iso(row.exitConfirmedAt),
    exitFile: file ? { id: file.id, name: file.originalName } : null,
    alertAfterDays: row.alertAfterDays,
    /** When a missing proof raises its alert (null: the goods have not left), whole days left (negative: overdue). */
    exitDueAt: iso(due),
    daysLeft: row.status === 'EXITED' ? null : exitDaysLeft(shippedAt, row.alertAfterDays, now),
    overdue: exitOverdue(row, shippedAt, now),
    links: links.map((link) => ({ id: link.id, email: link.email, expiresAt: toUtcIso(link.expiresAt), revoked: link.revokedAt !== null, answered: link.uses >= link.maxUses, lastOpenedAt: iso(link.lastUsedAt), createdAt: toUtcIso(link.createdAt) })),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
  }
}

/** GET /shipping/shipments/:shipmentId/export. */
export async function getExport(caller: CommandCaller, shipmentId: string, now: Date) {
  const { context, shipment } = await customsShipment(caller, shipmentId)
  const mayManage = mayOn(context, SHIPPING_CUSTOMS_MANAGE, shipment)
  return caller.withClient(async (db) => {
    const facts = await customsFactsOf(db, shipment)
    const documents = await customsDocumentsOf(db, shipment.id)
    const row = await declarationOf(db, shipment.id)
    const settings = await db.shippingSettings.findUnique({ where: { id: shipment.siteId }, select: { brokerPackOn: true } })
    const held = papersHeld(shipment, facts)
    const postal = held ? null : postalHeld(facts)
    const choice = postalChoiceOf(facts)
    const versions = (kind: 'COMMERCIAL_INVOICE' | 'CN22' | 'CN23') => documents.filter((document) => document.kind === kind)
    const ofKinds = (kinds: readonly ('CN22' | 'CN23')[]) => documents.filter((document) => (kinds as readonly string[]).includes(document.kind)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    const declarationHeld: CustomsRefusal | null = shipment.status === 'CANCELLED' ? 'CANCELLED' : facts.destination === null ? 'NO_DESTINATION' : facts.destination !== 'EXPORT' ? 'NOT_EXPORT' : facts.eori === null ? 'NO_EORI' : row ? 'DECLARED' : null
    return {
      shipment: { id: shipment.id, number: shipment.number, status: shipment.status, shippedAt: iso(shipment.shippedAt), siteId: shipment.siteId, companyId: shipment.companyId },
      // B-W2b-GF2: the special fiscal territory, in words (it, en), with the law.
      destination: { country: facts.country, class: facts.destination, territory: facts.territory ? { key: facts.territory.key, vat: facts.territory.vat, customs: facts.territory.customs, law: facts.territory.law, words: territoryWords(facts.territory) } : null },
      /** Only an export (outside the EU) has export papers: "Not needed: delivered in Italy / in the EU" otherwise. */
      needed: facts.destination === 'EXPORT',
      eori: facts.eori,
      deliveryTerms: facts.deliveryTerms,
      papers: {
        held,
        heldWords: held ? heldWords(held, facts) : null,
        commercialInvoice: versions('COMMERCIAL_INVOICE').map((document, index) => documentView(document, index === 0)),
        postalForm: {
          suggested: choice?.form ?? null,
          because: choice?.because ?? [],
          becauseWords: choice?.words ?? [],
          held: postal,
          heldWords: postal ? (postal === 'CUSTOMS_DATA' ? 'Every style on a CN 22 or CN 23 needs its net weight.' : CUSTOMS_REFUSAL_WORDS[postal]) : null,
          versions: ofKinds(['CN22', 'CN23']).map((document, index) => documentView(document, index === 0)),
        },
      },
      declaration: row ? await declarationView(db, row, shipment.shippedAt, now) : null,
      declarationHeld,
      /** The site's switch for sending the broker's pack by link (OFF by default: the pack is then a download). */
      brokerPackOn: settings?.brokerPackOn ?? false,
      /** The issued invoices the exit may be proven against (those of the shipment's DDT first). */
      invoices: row && row.invoiceId === null && mayManage ? await exportInvoicesOf(db, shipment, facts.liveDdt?.id ?? null) : [],
      alertDays: EXIT_ALERT_DAYS,
      mayManage,
      /** The papers' PDFs and values need the price grain. */
      seesValues: seesValuesOf(context),
    }
  })
}
