import { ValidationError } from '@nexus/factory-domain/core/errors'
import { binLabel, LOCATION_LABEL_KIND, LOCATION_RECORD, type BinLabel, type BinLabelFacts } from '@nexus/factory-domain/inventory/locations-depth/labels'
import type { LabelLanguage } from '@nexus/factory-domain/labels/model'
import { labelZpl, stockProblems } from '@nexus/factory-domain/labels/zpl'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { renderLabelPdf } from '../../documents/label-pdf'
import type { PrintJobView } from '../contract'
import { queueModuleLabel } from '../jobs'

/**
 * The bin label (B-W2b-289; SCM-178; design warehouse.locations › Labels, "Print labels", the bin labels PDF): a place's
 * label in the scan labels' layout (factory-domain labels/zpl LABEL_LAYOUT), heading "Ubicazione · <maker>", the place's
 * name, its label code as Code 128 bars and as text (what the phone or tablet camera reads), then site, kind, path, code
 * (factory-domain inventory/locations-depth labels.ts composes it).
 *
 *   queueBinLabel   ZPL for a label printer of the place's site: a print job of the location (recordType "Location",
 *                   label kind LOCATION), QUEUED → SENT → PRINTED or FAILED and sent again (platform/print); print.labels
 *                   and the printer are checked by queueModuleLabel
 *   binLabelsPdf    the same labels as one PDF, a page of the stock's size per label and copy, for any printer (the
 *                   browser prints it at 100 %); stored nowhere
 *
 * The routes are modules/inventory/locations-depth's (labels.ts), which check the places and give a place without a code
 * its suggested code first.
 */

/** A place's facts for its label (its code given). */
export async function binLabelFacts(
  db: Pick<CommandTx, 'location' | 'company'>,
  place: { readonly id: string; readonly companyId: string; readonly siteId: string; readonly code: string; readonly name: string; readonly kind: BinLabelFacts['kind']; readonly site: { readonly code: string } },
  labelCode: string,
  path: readonly string[],
): Promise<BinLabelFacts> {
  const company = await db.company.findUnique({ where: { id: place.companyId }, select: { legalName: true, tradeName: true } })
  return { labelCode, maker: company?.tradeName || company?.legalName || null, name: place.name, siteCode: place.site.code, path, kind: place.kind, code: place.code }
}

/** Queues one place's label on a label printer (one print job of `copies`). */
export function queueBinLabel(caller: CommandCaller, input: { readonly printerId: string; readonly locationId: string; readonly facts: BinLabelFacts; readonly copies: number; readonly language: LabelLanguage }, idempotencyKey?: string): Promise<PrintJobView> {
  const label = binLabel(input.facts, input.language)
  return queueModuleLabel(
    caller,
    { printerId: input.printerId, recordType: LOCATION_RECORD, recordId: input.locationId, copies: input.copies, labelKind: LOCATION_LABEL_KIND, scanId: label.scanId, zplFor: (stock) => labelZpl(label, stock, input.copies) },
    idempotencyKey,
  )
}

/** The labels as one PDF of the stock's size (each label's copies, then the next). */
export async function binLabelsPdf(labels: readonly BinLabel[], stock: { readonly widthMm: number; readonly heightMm: number }, copies: number): Promise<Buffer> {
  const problems = stockProblems({ widthMm: stock.widthMm, heightMm: stock.heightMm, dpi: 203 })
  if (problems.length > 0) throw new ValidationError('The label stock is not valid.', problems.map((issue) => ({ path: `body/${issue.path.replace(/^printer\//, '')}`, message: issue.message })))
  return renderLabelPdf(labels, stock, copies)
}
