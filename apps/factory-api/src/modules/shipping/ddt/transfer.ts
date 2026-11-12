import { DomainError, InvalidStateError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { composeDocument, documentProblems } from '@nexus/factory-domain/documents/compose'
import type { CompanyLegal, DdtReason, DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { transferDdtDocument, type TransferDdtFacts } from '@nexus/factory-domain/inventory/transfers/ddt'
import type { TransferTransport } from '@nexus/factory-domain/inventory/transfers/rules'
import { postalAddressOf } from '@nexus/factory-domain/shipping/ddt'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { FactoryClient } from '@nexus/factory-db'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { ApiError } from '../../../core/errors'
import { companyLegalOf, documentFileName } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import { putGeneratedFile, recordGeneratedFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'

/**
 * A transfer's DDT as a PDF (B-W2b-326; DPR 472/1996; design warehouse.transfers "DDT PDF", a new tab: "a legal document
 * printed and signed by the driver"). The DDT itself lives on the transfer (factory-db TransferOrder, B-W2b-277 decided 3:
 * not a Ddt row, which names a partner party); its number comes from the sending company's DDT series in the ship's own
 * command (modules/inventory/transfers/ship.ts). Here:
 *
 *   transferDdtFactsOf   the facts the DDT prints, read from the frozen transfer (or, before the ship, what it would print:
 *                        the ship's layout check, with the number "DDT")
 *   transferDdtProblems  composeDocument's own check of that layout (the companies' legal data, the recipient's address):
 *                        the ship refuses BEFORE it takes a number
 *   printTransferDdt     after the ship's commit: rendered from the frozen columns, stored as a FISCAL_ARCHIVE file of the
 *                        transfer (shared with the sending site's floor, which hands it to the driver), named on the
 *                        transfer once (ddtFileId) in one command with the file's row. A file store that fails leaves the
 *                        transfer shipped and says why; POST /inventory/transfer-orders/:id/ddt/pdf prints it again.
 */

type Client = FactoryClient | CommandTx

/** What the ship says before it takes the number (the layout check). */
export interface DraftDdt {
  readonly reason: DdtReason
  readonly reasonText: string | null
  readonly transportBy: TransferTransport
  readonly carrier: { readonly name: string; readonly vatNumber: string | null } | null
  readonly appearance: string
  readonly packages: number
  readonly grossWeightKg: string
  readonly language: DocumentLanguage
  readonly date: BusinessDate
  readonly startAt: string
}

const quantity = (value: { toString(): string }) => {
  const fixed = new Dec(value.toString()).toFixed(4)
  return fixed.replace(/0+$/, '').replace(/\.$/, '')
}

/** The facts the DDT of a transfer prints: its frozen DDT once shipped, else the draft the ship would issue. */
export async function transferDdtFactsOf(client: Client, transferId: string, language: DocumentLanguage, draft?: DraftDdt): Promise<TransferDdtFacts & { readonly companyId: string; readonly fromSiteId: string }> {
  const row = await client.transferOrder.findUnique({
    where: { id: transferId },
    select: {
      id: true,
      companyId: true,
      number: true,
      fromSiteId: true,
      status: true,
      ddtNumber: true,
      ddtDate: true,
      ddtReason: true,
      ddtReasonText: true,
      transportBy: true,
      carrier: true,
      packages: true,
      grossWeightKg: true,
      appearance: true,
      shippedAt: true,
      fromSite: { select: { code: true, name: true } },
      toSite: { select: { code: true, name: true, address: true, company: { select: { legalName: true, address: true, vatNumber: true, fiscalCode: true } } } },
    },
  })
  if (!row) throw new NotFoundError('Transfer not found.')
  const company = await client.company.findUnique({ where: { id: row.companyId }, select: { currency: true } })
  const lines = await client.transferLine.findMany({
    where: { transferId, ...(draft ? {} : { shippedQuantity: { gt: 0 } }) },
    select: { baseQuantity: true, shippedQuantity: true, item: { select: { code: true, name: true, baseUom: true } }, itemColour: { select: { name: true } }, lot: { select: { code: true } }, hide: { select: { code: true } } },
    orderBy: [{ seq: 'asc' }, { id: 'asc' }],
  })
  const recipient = row.toSite.company
  const base = {
    companyId: row.companyId,
    fromSiteId: row.fromSiteId,
    language,
    currency: company?.currency ?? 'EUR',
    transferNumber: row.number,
    fromSite: { code: row.fromSite.code, name: row.fromSite.name },
    toSite: { code: row.toSite.code, name: row.toSite.name, address: postalAddressOf(row.toSite.address) },
    recipient: { name: recipient.legalName, address: postalAddressOf(recipient.address), vatNumber: recipient.vatNumber, fiscalCode: recipient.fiscalCode },
    lines: lines.map((line) => ({
      code: line.item.code,
      name: line.item.name,
      colour: line.itemColour?.name ?? null,
      lot: line.lot?.code ?? null,
      hide: line.hide?.code ?? null,
      quantity: quantity(draft ? line.baseQuantity : (line.shippedQuantity ?? line.baseQuantity)),
      uom: line.item.baseUom,
    })),
  }
  if (draft) return { ...base, number: 'DDT', date: draft.date, reason: draft.reason, reasonText: draft.reasonText, transportBy: draft.transportBy, carrier: draft.carrier, startAt: draft.startAt, appearance: draft.appearance, packages: draft.packages, grossWeightKg: draft.grossWeightKg }
  if (!row.ddtNumber || !row.ddtDate || !row.transportBy || row.packages === null || row.grossWeightKg === null || !row.appearance || !row.shippedAt) {
    throw new InvalidStateError('This transfer has no DDT yet: it gets one when it is shipped.')
  }
  const carrier = row.carrier && typeof row.carrier === 'object' && !Array.isArray(row.carrier) ? (row.carrier as { name?: unknown; vatNumber?: unknown }) : null
  return {
    ...base,
    number: row.ddtNumber,
    date: row.ddtDate.toISOString().slice(0, 10),
    reason: row.ddtReason,
    reasonText: row.ddtReasonText,
    transportBy: row.transportBy,
    carrier: carrier && typeof carrier.name === 'string' ? { name: carrier.name, vatNumber: typeof carrier.vatNumber === 'string' ? carrier.vatNumber : null } : null,
    startAt: toUtcIso(row.shippedAt),
    appearance: row.appearance,
    packages: row.packages,
    grossWeightKg: quantity(row.grossWeightKg),
  }
}

/** composeDocument's check of the DDT the ship would issue (the sending company's legal data, the recipient's address). */
export function transferDdtProblems(facts: TransferDdtFacts, company: CompanyLegal): Issue[] {
  return documentProblems({ ...transferDdtDocument(facts), company })
}

/** What printing answers: the stored file (or null) and why it is missing. */
export interface PrintedTransferDdt {
  readonly fileId: string | null
  readonly created: boolean
  readonly pdfProblem: string | null
}

/**
 * The DDT's PDF of a shipped transfer: the stored one, else rendered now and stored, named on the transfer once. The caller
 * checked its own permission (the ship's, or printing again: inventory.stock.view). `safe`: a failure is said, not thrown.
 */
export async function printTransferDdt(files: FilesRuntime, caller: CommandCaller, transferId: string, options: { readonly language?: DocumentLanguage; readonly safe?: boolean; readonly onError?: (error: unknown) => void } = {}): Promise<PrintedTransferDdt> {
  try {
    const stored = await caller.withClient((client) => client.transferOrder.findUnique({ where: { id: transferId }, select: { ddtFileId: true } }))
    if (!stored) throw new NotFoundError('Transfer not found.')
    if (stored.ddtFileId) return { fileId: stored.ddtFileId, created: false, pdfProblem: null }
    const facts = await caller.withClient((client) => transferDdtFactsOf(client, transferId, options.language ?? 'it'))
    const company = await companyLegalOf(caller, facts.companyId)
    const composed = composeDocument({ ...transferDdtDocument(facts), company, sample: false })
    const pdf = await renderDocumentPdf(composed)
    const prepared = await putGeneratedFile(files, caller, {
      companyId: facts.companyId,
      recordType: 'TransferOrder',
      recordId: transferId,
      kind: 'FISCAL_ARCHIVE',
      originalName: documentFileName(composed),
      contentType: 'application/pdf',
      body: pdf,
      visibility: ['FLOOR'],
      floorSiteId: facts.fromSiteId,
    })
    const { result } = await command(caller, { name: 'inventory.transfers.printDdt', input: { transferId, sha256: prepared.sha256 } }, async (tools) => {
      const file = await recordGeneratedFile(tools, prepared, { details: { documentType: 'DDT', number: facts.number, layout: composed.layout, language: composed.language } })
      // Named once: a print that raced this one keeps its file (this one stays a copy of the same DDT).
      const named = await tools.tx.transferOrder.updateMany({ where: { id: transferId, ddtFileId: null }, data: { ddtFileId: file.id } })
      const row = await tools.tx.transferOrder.findUniqueOrThrow({ where: { id: transferId }, select: { id: true, number: true, companyId: true, fromSiteId: true, toSiteId: true, toCompanyId: true, status: true, ddtNumber: true, ddtFileId: true } })
      tools.audit({ recordType: 'TransferOrder', recordId: transferId, companyId: row.companyId, siteId: row.fromSiteId, after: { ddtFileId: row.ddtFileId, ddtNumber: row.ddtNumber, ...(named.count === 0 ? { copy: file.id } : {}) } })
      tools.emit({
        type: 'inventory.transfer_changed',
        subject: row.id,
        companyId: row.companyId,
        siteId: row.fromSiteId,
        payload: { transferId: row.id, number: row.number, change: 'PRINTED', status: row.status, previousStatus: row.status, fromSiteId: row.fromSiteId, toSiteId: row.toSiteId, toCompanyId: row.toCompanyId, ddtNumber: row.ddtNumber, lineId: null, resolution: null },
      })
      return { fileId: row.ddtFileId }
    })
    return { fileId: result.fileId, created: true, pdfProblem: null }
  } catch (error) {
    if (!options.safe) throw error
    options.onError?.(error)
    const why = error instanceof DomainError || (error instanceof ApiError && error.code !== 'internal_error') ? ` (${error.message})` : ''
    return { fileId: null, created: false, pdfProblem: `The transfer is shipped and its DDT issued; the PDF could not be stored now${why}. Print it again with POST /inventory/transfer-orders/${transferId}/ddt/pdf.` }
  }
}

/** The day a DDT issued now is dated (Europe/Rome). */
export const ddtDayOf = (now: Date): BusinessDate => businessDate(now)
