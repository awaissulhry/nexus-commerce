import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { ageDays, claimActions, CLAIM_REASON_LIST, claimReasonOf, linesValue } from '@nexus/factory-domain/purchasing/claims/rules'
import { dayOf, quantityText, type Reader } from '../store'
import { nameOf } from '../subcontracting/store'
import { factsOf, readLines, type ClaimRow, type LineRow } from './store'

/**
 * The claims as the office reads them (B-W2a-44; design purchasing.claims: the "Returns and claims" grid, the record's
 * Claim, Goods returned and Credit tabs). Each read names its columns and runs one query after another on the client it
 * is given. The value of the goods and the credit asked are costs (marked: dropped without the cost grain); a person is
 * an id with the names beside (`people`).
 */

const byId = <Row extends { id: string }>(rows: readonly Row[]): Map<string, Row> => new Map(rows.map((row) => [row.id, row]))
const unique = (values: readonly (string | null)[]): string[] => [...new Set(values.filter((value): value is string => value !== null))]

/**
 * The reason as the screens show it: the CLAIM code with its words in both languages, and the person's note (B-W2b-14:
 * the reasonCode column; a claim made before W2b leads its reason text with the code).
 */
async function reasonsOf(db: Reader, claims: readonly Pick<ClaimRow, 'reason' | 'reasonCode'>[]) {
  const codes = unique(claims.map((claim) => claimReasonOf(claim).code))
  const rows = codes.length === 0 ? [] : await db.reasonCode.findMany({ where: { list: CLAIM_REASON_LIST, code: { in: codes } }, select: { code: true, labelIt: true, labelEn: true } })
  const labels = new Map(rows.map((row) => [row.code, row]))
  return (claim: Pick<ClaimRow, 'reason' | 'reasonCode'>) => {
    const { code, note } = claimReasonOf(claim)
    const label = code ? labels.get(code) : undefined
    return { code, labelEn: label?.labelEn ?? null, labelIt: label?.labelIt ?? null, note }
  }
}

/** The list's rows (and the record's head). */
export async function claimSummaries(db: Reader, claims: readonly ClaimRow[], now: Date) {
  if (claims.length === 0) return []
  const ids = claims.map((claim) => claim.id)
  const lines = await db.supplierClaimLine.findMany({ where: { claimId: { in: ids } }, select: { claimId: true, itemId: true, lotId: true, quantity: true, uom: true, creditAmount: true, moveId: true }, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
  const sites = byId(await db.site.findMany({ where: { id: { in: unique(claims.map((claim) => claim.siteId)) } }, select: { id: true, code: true } }))
  const parties = byId(await db.party.findMany({ where: { id: { in: unique(claims.map((claim) => claim.partyId)) } }, select: { id: true, code: true, legalName: true, tradeName: true } }))
  const items = byId(await db.item.findMany({ where: { id: { in: unique(lines.map((line) => line.itemId)) } }, select: { id: true, code: true, name: true } }))
  const lots = byId(await db.lot.findMany({ where: { id: { in: unique(lines.map((line) => line.lotId)) } }, select: { id: true, code: true } }))
  const reason = await reasonsOf(db, claims)
  return claims.map((claim) => {
    const own = lines.filter((line) => line.claimId === claim.id)
    const units = new Set(own.map((line) => line.uom))
    const site = sites.get(claim.siteId)
    const party = parties.get(claim.partyId)
    return {
      id: claim.id,
      number: claim.number,
      kind: claim.kind,
      status: claim.status,
      companyId: claim.companyId,
      site: { id: claim.siteId, code: site?.code ?? '' },
      supplier: { id: claim.partyId, code: party?.code ?? '', name: party ? nameOf(party) : '' },
      foundAt: claim.foundAt,
      reason: reason(claim),
      remedy: claim.remedy,
      lots: unique(own.map((line) => line.lotId)).map((id) => ({ id, code: lots.get(id)?.code ?? '' })),
      materials: unique(own.map((line) => line.itemId)).map((id) => ({ id, code: items.get(id)?.code ?? '', name: items.get(id)?.name ?? '' })),
      /** The lines' quantity added up, when they share one unit (an area of leather, pieces); null otherwise. */
      quantity: own.length > 0 && units.size === 1 ? { quantity: own.reduce((sum, line) => sum.plus(line.quantity.toString()), new Dec(0)).toFixed(4), uom: own[0]!.uom } : null,
      lines: own.length,
      returned: own.filter((line) => line.moveId !== null).length,
      currency: claim.currency,
      /** The value of the goods claimed: the lines' cost × quantity. */
      value: asMoney('cost', linesValue(own)),
      /** The credit asked (the lines' value, or the amount agreed); none for a replacement. */
      expectedCreditAmount: asMoney('cost', claim.expectedCreditAmount),
      ageDays: ageDays(claim.createdAt, now),
      sentAt: claim.sentAt ? toUtcIso(claim.sentAt) : null,
      answeredAt: claim.answeredAt ? toUtcIso(claim.answeredAt) : null,
      closedAt: claim.closedAt ? toUtcIso(claim.closedAt) : null,
      version: claim.version,
      createdAt: toUtcIso(claim.createdAt),
      updatedAt: toUtcIso(claim.updatedAt),
    }
  })
}

export type ClaimSummaryView = Awaited<ReturnType<typeof claimSummaries>>[number]

/** One claim with its lines, the goods that went back and their DDTs, its credit and what may be done now. */
export async function claimDetailOf(db: Reader, claim: ClaimRow, now: Date) {
  const [summary] = await claimSummaries(db, [claim], now)
  const lines: LineRow[] = await readLines(db, claim.id)
  const items = byId(await db.item.findMany({ where: { id: { in: unique(lines.map((line) => line.itemId)) } }, select: { id: true, code: true, name: true, baseUom: true, tracking: true } }))
  const colours = byId(await db.itemColour.findMany({ where: { id: { in: unique(lines.map((line) => line.itemColourId)) } }, select: { id: true, code: true, name: true } }))
  const lots = byId(await db.lot.findMany({ where: { id: { in: unique(lines.map((line) => line.lotId)) } }, select: { id: true, code: true, qualityStatus: true } }))
  const hides = byId(await db.hide.findMany({ where: { id: { in: unique(lines.map((line) => line.hideId)) } }, select: { id: true, code: true, state: true } }))
  const discrepancies = byId(await db.receiptDiscrepancy.findMany({ where: { id: { in: unique(lines.map((line) => line.discrepancyId)) } }, select: { id: true, seq: true, kind: true, status: true, receiptId: true } }))
  const moves = byId(await db.stockMove.findMany({ where: { id: { in: unique(lines.map((line) => line.moveId)) } }, select: { id: true, occurredAt: true, quantity: true, uom: true, fromLocationId: true, reason: true } }))
  const locations = byId(await db.location.findMany({ where: { id: { in: unique([...moves.values()].map((move) => move.fromLocationId)) } }, select: { id: true, code: true, name: true } }))
  const ddtRows = await db.ddt.findMany({
    where: { sourceType: 'SupplierClaim', sourceId: claim.id },
    select: { id: true, number: true, documentDate: true, reason: true, startAt: true, lines: true, cancellations: { select: { id: true }, take: 1 } },
    orderBy: { id: 'asc' },
  })
  const ddts = ddtRows.map((row) => ({
    id: row.id,
    number: row.number,
    documentDate: dayOf(row.documentDate)!,
    reason: row.reason,
    startAt: toUtcIso(row.startAt),
    cancelled: row.cancellations.length > 0,
    lineIds: (Array.isArray(row.lines) ? row.lines : []).flatMap((line) => {
      const id = line !== null && typeof line === 'object' ? (line as Record<string, unknown>).sourceLineId : null
      return typeof id === 'string' ? [id] : []
    }),
  }))
  const ddtOf = byId(ddts)
  const receipt = claim.goodsReceiptId ? await db.goodsReceipt.findUnique({ where: { id: claim.goodsReceiptId }, select: { id: true, number: true, supplierDdtNumber: true, supplierDdtDate: true } }) : null
  const order = claim.purchaseOrderId ? await db.purchaseOrder.findUnique({ where: { id: claim.purchaseOrderId }, select: { id: true, number: true } }) : null
  const peopleIds = unique([claim.createdById, claim.sentById])
  const people = peopleIds.length === 0 ? [] : await db.user.findMany({ where: { id: { in: peopleIds } }, select: { id: true, displayName: true } })
  const value = linesValue(lines)
  const evidence = await evidenceOf(db, claim, lines)

  return {
    ...summary!,
    goodsReceipt: receipt ? { id: receipt.id, number: receipt.number, supplierDdtNumber: receipt.supplierDdtNumber, supplierDdtDate: dayOf(receipt.supplierDdtDate) } : null,
    purchaseOrder: order,
    supplierAnswer: claim.supplierAnswer,
    closeNote: claim.closeNote,
    cancelledAt: claim.cancelledAt ? toUtcIso(claim.cancelledAt) : null,
    cancelReason: claim.cancelReason,
    internalNote: claim.internalNote,
    sentById: claim.sentById,
    createdById: claim.createdById,
    lines: lines.map((line) => {
      const item = items.get(line.itemId)
      const move = line.moveId ? moves.get(line.moveId) : undefined
      const ddt = line.ddtId ? ddtOf.get(line.ddtId) : undefined
      // The live DDT that carries the line (a replacement after a cancel names the line; its column keeps the first).
      const carrying = ddts.find((entry) => !entry.cancelled && entry.lineIds.includes(line.id)) ?? null
      const discrepancy = line.discrepancyId ? discrepancies.get(line.discrepancyId) : undefined
      return {
        id: line.id,
        seq: line.seq,
        item: { id: line.itemId, code: item?.code ?? '', name: item?.name ?? '', baseUom: item?.baseUom ?? line.uom, tracking: item?.tracking ?? 'NONE' },
        colour: line.itemColourId ? { id: line.itemColourId, code: colours.get(line.itemColourId)?.code ?? '', name: colours.get(line.itemColourId)?.name ?? '' } : null,
        lot: line.lotId ? { id: line.lotId, code: lots.get(line.lotId)?.code ?? '', qualityStatus: lots.get(line.lotId)?.qualityStatus ?? '' } : null,
        // B-W2b-14: its state (RETURNED once it went back to the supplier whole).
        hide: line.hideId ? { id: line.hideId, code: hides.get(line.hideId)?.code ?? '', state: hides.get(line.hideId)?.state ?? null } : null,
        discrepancy: discrepancy ? { id: discrepancy.id, seq: discrepancy.seq, kind: discrepancy.kind, status: discrepancy.status, receiptId: discrepancy.receiptId } : null,
        receiptLineId: line.receiptLineId,
        quantity: quantityText(line.quantity),
        uom: line.uom,
        baseQuantity: quantityText(line.baseQuantity),
        reason: line.reason,
        unitCost: asMoney('cost', line.unitCost === null ? null : line.unitCost.toFixed(6)),
        creditAmount: asMoney('cost', line.creditAmount),
        /** The stock move that took the goods out (a return's line, once it went back). */
        move: move
          ? { id: move.id, reason: move.reason, occurredAt: toUtcIso(move.occurredAt), quantity: quantityText(move.quantity), uom: move.uom, fromLocation: move.fromLocationId ? { id: move.fromLocationId, code: locations.get(move.fromLocationId)?.code ?? '' } : null }
          : null,
        /** The return DDT the line went with (set once), and the live one that carries it now. */
        ddt: ddt ? { id: ddt.id, number: ddt.number, cancelled: ddt.cancelled } : null,
        liveDdt: carrying ? { id: carrying.id, number: carrying.number } : null,
        note: line.note,
        version: line.version,
      }
    }),
    /** The return DDTs (live and cancelled), newest last, with the claim lines each carries. */
    ddts,
    credit: {
      currency: claim.currency,
      remedy: claim.remedy,
      /** The credit asked: the lines' value, or the amount agreed with the supplier; none for a replacement. */
      expected: asMoney('cost', claim.expectedCreditAmount),
      value: asMoney('cost', value),
      /** The supplier's credit note matched to the claim (Finance, B-W2a-62): none yet. */
      matched: null,
      difference: null,
    },
    actions: claimActions(factsOf(claim, lines)),
    ...evidence,
    people: [...people.map((person) => ({ id: person.id, name: person.displayName })), ...evidence.people].filter((person, index, all) => all.findIndex((other) => other.id === person.id) === index),
  }
}

/**
 * B-W2b-14 (SCM-135; design rec "Claim": photos, the claim letter, the supplier): the claim's own photos (PHOTO files of
 * the SupplierClaim, category CLAIM_PHOTO), the photos of the receipt discrepancies its lines pursue (they stay the
 * discrepancy's), the claim letter's versions (GeneratedDocument CLAIM_LETTER, the newest first: the current one) and
 * the supplier's contact a claim goes to first (QUALITY, then ORDERS) with the NCR it came from.
 */
async function evidenceOf(db: Reader, claim: ClaimRow, lines: readonly LineRow[]) {
  const fileSelect = { id: true, recordId: true, originalName: true, contentType: true, sizeBytes: true, status: true, version: true, createdAt: true, createdById: true } as const
  const photos = await db.storedFile.findMany({ where: { recordType: 'SupplierClaim', recordId: claim.id, kind: 'PHOTO', status: { not: 'DELETED' } }, select: fileSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const discrepancyIds = unique(lines.map((line) => line.discrepancyId))
  const seqs = discrepancyIds.length === 0 ? new Map<string, number>() : new Map((await db.receiptDiscrepancy.findMany({ where: { id: { in: discrepancyIds } }, select: { id: true, seq: true } })).map((row) => [row.id, row.seq]))
  const discrepancyPhotos =
    discrepancyIds.length === 0 ? [] : await db.storedFile.findMany({ where: { recordType: 'ReceiptDiscrepancy', recordId: { in: discrepancyIds }, kind: 'PHOTO', status: { not: 'DELETED' } }, select: fileSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const letters = await db.generatedDocument.findMany({
    where: { recordType: 'SupplierClaim', recordId: claim.id, kind: 'CLAIM_LETTER' },
    select: { id: true, version: true, language: true, number: true, fileId: true, createdAt: true, createdById: true },
    orderBy: { version: 'desc' },
  })
  const contacts = await db.partyContact.findMany({ where: { partyId: claim.partyId, status: 'ACTIVE', email: { not: null } }, select: { id: true, name: true, email: true, roles: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
  const rank = (roles: readonly string[]) => (roles.includes('QUALITY') ? 0 : roles.includes('ORDERS') ? 1 : 2)
  const contact = [...contacts].sort((a, b) => rank(a.roles) - rank(b.roles))[0] ?? null
  const ncr = claim.ncrId ? await db.nonconformance.findUnique({ where: { id: claim.ncrId }, select: { id: true, number: true } }) : null
  const peopleIds = unique([...photos.map((file) => file.createdById), ...letters.map((letter) => letter.createdById)])
  const people = peopleIds.length === 0 ? [] : await db.user.findMany({ where: { id: { in: peopleIds } }, select: { id: true, displayName: true } })
  const file = (row: (typeof photos)[number]) => ({ id: row.id, originalName: row.originalName, contentType: row.contentType, sizeBytes: row.sizeBytes, status: row.status, version: row.version, createdAt: toUtcIso(row.createdAt), createdById: row.createdById })
  return {
    photos: photos.map(file),
    discrepancyPhotos: discrepancyPhotos.map((row) => ({ ...file(row), discrepancyId: row.recordId, discrepancySeq: seqs.get(row.recordId) ?? null })),
    letters: letters.map((letter) => ({ id: letter.id, version: letter.version, language: letter.language, number: letter.number, fileId: letter.fileId, createdAt: toUtcIso(letter.createdAt), createdById: letter.createdById })),
    supplierContact: contact ? { id: contact.id, name: contact.name, email: contact.email!, roles: [...contact.roles] } : null,
    ncr,
    people: people.map((person) => ({ id: person.id, name: person.displayName })),
  }
}

export type ClaimDetailView = Awaited<ReturnType<typeof claimDetailOf>>
