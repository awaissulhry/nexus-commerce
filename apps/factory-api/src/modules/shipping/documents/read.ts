import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { linkState } from '@nexus/factory-domain/links/purposes'
import { classificationOf, DOCUMENT_KINDS, type ComplianceCheck, type DocumentKind } from '@nexus/factory-domain/product/compliance/rules'
import type { ShipmentDocumentsView } from '@nexus/factory-domain/shipping/documents/contracts'
import {
  languageChain,
  linkRecipients,
  shipmentDocuments,
  type ContactFacts,
  type DocOnFile,
  type FileFacts,
  type SharedFile,
  type ShipmentDocuments,
  type ShipmentDocumentsFacts,
  type StyleOnShipment,
} from '@nexus/factory-domain/shipping/documents/documents'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSpec, type CommandTools, type CommandTx } from '../../../core/command'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import { serverClock, type Clock } from '../../../core/time'
import { currentDocFor, STYLE_SELECT, styleFactsOf } from '../../product/compliance/read'
import { pdfFileIdOf } from '../ddt/store'
import { readShipment, type ShipmentHeader } from '../store'

/**
 * The documents of a shipment, read side (B-W1-49; A2 SCR-067 Documents tab): the facts factory-domain
 * shipping/documents decides from, read one query after another (one connection runs one query at a time):
 *
 *   styles     the shipment's lines → their work orders → each work order's FROZEN StyleRevision (its number) and its
 *              style (PPE or not: product/compliance classificationOf); garments of one style and revision are one entry
 *   DoC/leaflet  product/compliance `currentDocFor(tx, styleId, revisionNo, kind, language)` for each language of the
 *              chain (the sales order's language, then en, then it): issued for exactly that revision, with its file
 *   DDT        the live DDT and its PDF (ddt/store pdfFileIdOf: its first stored FISCAL_ARCHIVE file)
 *   packing list  the newest packing list printed for the shipment (the shipment's only DOCUMENT shared with its floor)
 *   shared     the shipment's files shared with its party's links: the copies that travel
 *
 * `shipmentDocumentBlockers(tx, shipmentId)` is the ship step's question: what of the DoC and the leaflet blocks
 * SHIPPED, in the compliance step's shape and words (empty: nothing). It checks no permission; the ship step calls it
 * inside its command, under the shipment's lock.
 */

export type Reader = FactoryClient | CommandTx

let clock: Clock = serverClock
/** Test only: the clock of the documents' commands, links and retention (default the server clock). */
export function useShipmentDocumentsClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}
export const documentsClock = (): Clock => clock

/** command() on the documents' clock. */
export function documentsCommand<Result, State extends string = string, Facts = undefined>(caller: CommandCaller, spec: CommandSpec<State, Facts>, work: (tools: CommandTools) => Promise<Result>) {
  return runCommand(caller, spec, work, { ...COMMAND_SETTINGS, clock })
}

/** One attach or send per shipment at a time (the office and the ship handler together make one set of copies). */
export async function lockShipmentDocuments(tx: CommandTx, tenantId: string, shipmentId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.ship-docs', ${tenantId}::uuid, ${shipmentId}::uuid), 0))`
}

const FILE_FACTS = { id: true, originalName: true, sha256: true, sizeBytes: true } as const satisfies Prisma.StoredFileSelect
const SHARED_SELECT = { ...FILE_FACTS, contentType: true, availableAt: true } as const satisfies Prisma.StoredFileSelect

/**
 * The shipment's files shared with its party's links (AVAILABLE), oldest first. In a link's own scope row-level
 * security adds the party's wall; the conditions say the same for every other reader.
 */
export async function sharedFilesOf(db: Reader, shipment: { readonly id: string; readonly partyId: string }): Promise<SharedFile[]> {
  const rows = await db.storedFile.findMany({
    where: { recordType: 'Shipment', recordId: shipment.id, status: 'AVAILABLE', visibility: { has: 'LINK' }, partyId: shipment.partyId },
    select: SHARED_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return rows.map((row) => ({ id: row.id, originalName: row.originalName, sha256: row.sha256, sizeBytes: row.sizeBytes, contentType: row.contentType, availableAt: toUtcIso(row.availableAt!) }))
}

const nonNull = <T>(value: T | null): value is T => value !== null

/** The styles × frozen revisions of the shipment's garments, with their DoCs and leaflets on file in the chain's languages. */
async function stylesOf(db: Reader, shipmentId: string, chain: readonly string[]): Promise<StyleOnShipment[]> {
  const lines = await db.shipmentLine.findMany({ where: { shipmentId }, select: { workOrderId: true, quantity: true } })
  if (lines.length === 0) return []
  const workOrders = await db.workOrder.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.workOrderId))] } }, select: { id: true, styleId: true, styleRevisionId: true } })
  const revisionIds = [...new Set(workOrders.map((order) => order.styleRevisionId).filter(nonNull))]
  const revisions = revisionIds.length > 0 ? await db.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true } }) : []
  const styles = await db.style.findMany({ where: { id: { in: [...new Set(workOrders.map((order) => order.styleId))] } }, select: STYLE_SELECT })
  const orderOf = new Map(workOrders.map((order) => [order.id, order]))
  const numberOf = new Map(revisions.map((revision) => [revision.id, revision.revision]))

  const groups = new Map<string, { styleId: string; revision: number | null; garments: number }>()
  for (const line of lines) {
    const order = orderOf.get(line.workOrderId)
    if (!order) continue
    // THE rule: the revision the work order froze, never the style's newest or released one.
    const revision = order.styleRevisionId ? (numberOf.get(order.styleRevisionId) ?? null) : null
    const key = `${order.styleId}|${revision ?? 'none'}`
    const group = groups.get(key) ?? { styleId: order.styleId, revision, garments: 0 }
    group.garments += line.quantity
    groups.set(key, group)
  }

  const result: StyleOnShipment[] = []
  for (const group of groups.values()) {
    const style = styles.find((entry) => entry.id === group.styleId)
    if (!style) continue
    const { documentsRequired } = classificationOf(styleFactsOf(style))
    const onFile: Record<DocumentKind, DocOnFile[]> = { DECLARATION_OF_CONFORMITY: [], USER_INFORMATION: [] }
    if (documentsRequired && group.revision !== null) {
      for (const kind of DOCUMENT_KINDS) {
        for (const language of chain) {
          const found = await currentDocFor(db, style.id, group.revision, kind, language)
          if (!found) continue
          onFile[kind].push({
            documentId: found.document.id,
            language: found.document.language,
            revision: found.document.revision,
            number: found.document.number,
            issuedAt: found.document.issuedAt,
            file: { id: found.file.id, originalName: found.file.originalName, sha256: found.file.sha256, sizeBytes: found.file.sizeBytes },
          })
          // The chain stops at the first language on file; the others are not needed.
          break
        }
      }
    }
    result.push({ styleId: style.id, code: style.code, name: style.name, revision: group.revision, documentsRequired, garments: group.garments, onFile })
  }
  return result
}

export interface DocumentsRead {
  readonly facts: ShipmentDocumentsFacts
  readonly documents: ShipmentDocuments
  readonly order: { readonly number: string; readonly customerRef: string | null; readonly language: string } | null
}

/** Every fact of the shipment's documents, and what the rules make of them. */
export async function readDocuments(db: Reader, shipment: ShipmentHeader): Promise<DocumentsRead> {
  const order = await db.salesOrder.findUnique({ where: { id: shipment.salesOrderId }, select: { number: true, customerRef: true, language: true } })
  const chain = languageChain(order?.language)
  const styles = await stylesOf(db, shipment.id, chain)
  const live = await db.ddt.findFirst({ where: { shipmentId: shipment.id, cancellations: { none: {} } }, select: { id: true, number: true, documentDate: true }, orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }] })
  const pdfId = live ? await pdfFileIdOf(db, live.id) : null
  const pdf: FileFacts | null = pdfId ? await db.storedFile.findUnique({ where: { id: pdfId }, select: FILE_FACTS }) : null
  const packingList = await db.storedFile.findFirst({
    where: { recordType: 'Shipment', recordId: shipment.id, kind: 'DOCUMENT', status: 'AVAILABLE', visibility: { has: 'FLOOR' } },
    select: FILE_FACTS,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  const facts: ShipmentDocumentsFacts = {
    shipment: { number: shipment.number, status: shipment.status },
    wantedLanguage: order?.language ?? null,
    styles,
    ddt: { required: shipment.ddtRequired, live: live ? { id: live.id, number: live.number, documentDate: live.documentDate.toISOString().slice(0, 10), pdf } : null },
    packingList,
    shared: await sharedFilesOf(db, shipment),
  }
  return { facts, documents: shipmentDocuments(facts), order }
}

/**
 * What of the DoC and the leaflet blocks the shipment from leaving (B-W1-20's rule: PPE ships only with them, in the
 * compliance step's ComplianceCheck shape and words; empty: nothing blocks). For the ship step, inside its command.
 */
export async function shipmentDocumentBlockers(tx: Reader, shipmentId: string): Promise<ComplianceCheck[]> {
  const shipment = await readShipment(tx as CommandTx, shipmentId)
  if (!shipment) throw new InvalidStateError('The shipment is gone.')
  return [...(await readDocuments(tx, shipment)).documents.blockers]
}

export const CONTACT_SELECT = { id: true, name: true, email: true, roles: true, status: true } as const satisfies Prisma.PartyContactSelect

export async function contactsOf(db: Reader, partyId: string): Promise<ContactFacts[]> {
  return db.partyContact.findMany({ where: { partyId }, select: CONTACT_SELECT, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
}

const LINK_SELECT = { id: true, email: true, expiresAt: true, maxUses: true, uses: true, lastUsedAt: true, revokedAt: true, createdAt: true, createdById: true } as const satisfies Prisma.OneOffLinkSelect

const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

/** The office's view of the documents: the rules' answer, who the link goes to, and the links made (never a token). */
export async function documentsView(db: Reader, shipment: ShipmentHeader, now: Date): Promise<ShipmentDocumentsView> {
  const { documents } = await readDocuments(db, shipment)
  const recipients = linkRecipients(await contactsOf(db, shipment.partyId))
  const links = await db.oneOffLink.findMany({
    where: { recordType: 'Shipment', recordId: shipment.id, purpose: 'DOCUMENT_VIEW' },
    select: LINK_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
  })
  return {
    shipment: { id: shipment.id, number: shipment.number, status: shipment.status, partyId: shipment.partyId, shippedAt: iso(shipment.shippedAt) },
    languages: [...documents.languages],
    documents: documents.documents.map((document) => ({ ...document, style: document.style ? { ...document.style } : null, source: document.source ? { ...document.source } : null, copy: document.copy ? { ...document.copy } : null })),
    checks: documents.checks.map((check) => ({ ...check, blocks: [...check.blocks], problems: [...check.problems] })),
    blockers: documents.blockers.map((check) => ({ ...check, blocks: [...check.blocks], problems: [...check.problems] })),
    warnings: [...documents.warnings],
    counts: { ...documents.counts },
    recipients: recipients.map((contact) => ({ contactId: contact.id, name: contact.name, email: contact.email! })),
    links: links.map((link) => ({
      id: link.id,
      email: link.email,
      state: linkState(link, now),
      expiresAt: toUtcIso(link.expiresAt),
      maxUses: link.maxUses,
      uses: link.uses,
      lastUsedAt: iso(link.lastUsedAt),
      revokedAt: iso(link.revokedAt),
      createdAt: toUtcIso(link.createdAt),
      automatic: link.createdById === SYSTEM_ACTOR_ID,
    })),
  }
}
