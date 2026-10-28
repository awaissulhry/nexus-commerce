import { ForbiddenError, ValidationError } from '@nexus/factory-domain/core/errors'
import { composeLabel, type LabelInput } from '@nexus/factory-domain/labels/model'
import { stockProblems } from '@nexus/factory-domain/labels/zpl'
import { tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import type { CommandCaller } from '../../core/command'
import { renderLabelPdf } from '../documents/label-pdf'
import { contextOf } from './printers'

/**
 * The browser's fallback for labels (GAP-007): the same composed label as a PDF page of the stock's size, for any
 * printer, with the scannable id as Code 128 bars. Nothing is queued or stored; the label must still carry one of the
 * tenant's own codes of its kind.
 */
export async function labelPdf(caller: CommandCaller, input: { label: LabelInput; widthMm: number; heightMm: number; copies: number }): Promise<{ pdf: Buffer; fileName: string }> {
  const context = contextOf(caller)
  if (context.audience === 'platform') throw new ForbiddenError()
  const problems = stockProblems({ widthMm: input.widthMm, heightMm: input.heightMm, dpi: 203 }, 'body')
  if (problems.length > 0) throw new ValidationError('The label stock is not valid.', problems)
  const label = composeLabel(input.label, { tenantTag: tenantTag(context.tenantId) })
  return { pdf: await renderLabelPdf(label, { widthMm: input.widthMm, heightMm: input.heightMm }, input.copies), fileName: `${label.scanId}.pdf` }
}
