import { LABELS_MANAGE } from '@nexus/factory-domain/compliance/labels/permissions'
import { renderLabel, type CellCertificate, type Identification, type LabelValues, type RenderedLabel } from '@nexus/factory-domain/compliance/labels/render'
import { hundredthsOf, mmText } from '@nexus/factory-domain/compliance/labels/rules'
import { garmentLabelZpl } from '@nexus/factory-domain/compliance/labels/zpl'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { queueModuleLabel } from '../../../platform/print/jobs'
import { bodyMeasuresOf, certificateGateFor } from '../certificates/gate'
import { classLabelHoldFor } from '../type-changes/reviews'
import { renderGarmentLabelPdf } from './pdf'
import { factsOf, findStyle, labelStyleOf, officeOf, readTemplate, readVisibleStyle, TEMPLATE_SELECT, todayOf, type Reader, type StyleRow, type TemplateRow } from './store'

/**
 * The garment label of one cell (B-W1-19; PRD-331; design 02 `lb-builder`, `lb-test`): a template rendered for a style
 * (or one of its revisions), a colourway and a size, with the certificate gate's answer for the cell on the day
 * (B-W1-12's `certificateGateFor`, the same question the work-order release and the floor ask), each value with its
 * source (factory-domain compliance/labels/render).
 *
 *   preview     GET …/preview: the rendered label (a SAMPLE: placeholders for the batch or serial and the date of
 *               manufacture, a banner), with its ZPL at the asked resolution; GET …/preview/pdf: the same as a PDF
 *   test print  POST …/test-print: the SAMPLE label queued on a label printer through the print service (print.labels on
 *               the printer, PrintJob of record LabelTemplate, label kind GARMENT, id SAMPLE)
 *   B-W1-44     `garmentLabelFor(client, question)` renders the real label at the final operation: the work order's batch
 *               number or the garment's serial, its release day, no banner; `printable` false names every reason
 *               (the gate, the template's status, a language the buyer's market needs…). It checks no permission.
 */

/** Which cell to render. Left out: the label's own style, its first active colourway, its base size. */
export interface CellQuery {
  readonly styleRevisionId?: string | undefined
  readonly styleId?: string | undefined
  readonly colourwayId?: string | undefined
  readonly size?: string | undefined
  /** "de,it": the languages the buyer's market needs. */
  readonly languages?: string | undefined
  readonly date?: BusinessDate | undefined
}

interface Cell {
  readonly style: StyleRow
  readonly revision: { readonly id: string; readonly revision: number } | null
  readonly colourway: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly size: LabelValues['size']
  readonly certificate: CellCertificate | null
  readonly date: BusinessDate
}

const invalid = (path: string, message: string) => new ValidationError('The label cannot be rendered for this cell.', [{ path, message }])

/** The style revision asked for, or the newest one naming the template, else the released one, else the newest. */
async function revisionFor(client: Reader, styleId: string, templateId: string, askedId: string | null): Promise<{ id: string; revision: number } | null> {
  if (askedId !== null) return client.styleRevision.findFirst({ where: { id: askedId, styleId }, select: { id: true, revision: true } })
  const revisions = await client.styleRevision.findMany({ where: { styleId }, select: { id: true, revision: true, status: true, labelTemplateId: true }, orderBy: { revision: 'desc' } })
  const chosen = revisions.find((entry) => entry.labelTemplateId === templateId) ?? revisions.find((entry) => entry.status === 'RELEASED') ?? revisions[0]
  return chosen ? { id: chosen.id, revision: chosen.revision } : null
}

/** The cell's records, read with this client (a request's, or a command's transaction). The style is given, already checked. */
async function readCell(client: Reader, style: StyleRow, templateId: string, ask: { revisionId: string | null; colourwayId?: string | undefined; size?: string | undefined; date: BusinessDate }): Promise<Cell> {
  const revision = await revisionFor(client, style.id, templateId, ask.revisionId)
  const colourway = ask.colourwayId
    ? await client.colourway.findFirst({ where: { id: ask.colourwayId, styleId: style.id }, select: { id: true, code: true, name: true } })
    : ((await client.colourway.findFirst({ where: { styleId: style.id, status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })) ??
      (await client.colourway.findFirst({ where: { styleId: style.id }, select: { id: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })))
  if (ask.colourwayId && !colourway) throw invalid('querystring/colourwayId', `Not a colourway of style ${style.code}.`)
  const sizeCode = ask.size ?? style.baseSize ?? style.sizes[0] ?? null
  let size: LabelValues['size'] = null
  if (sizeCode !== null) {
    if (!style.sizes.includes(sizeCode)) throw invalid('querystring/size', `Size ${sizeCode} is not in the size range of style ${style.code} (${style.sizes.join(', ') || 'none'}).`)
    const row = await client.size.findFirst({ where: { scaleId: style.sizeScaleId, code: sizeCode }, select: { code: true, label: true, bodyMeasures: true } })
    const scale = await client.sizeScale.findUnique({ where: { id: style.sizeScaleId }, select: { id: true, code: true } })
    if (!row || !scale) throw invalid('querystring/size', `Size ${sizeCode} is not in the size scale of style ${style.code}.`)
    size = { code: row.code, label: row.label, scaleId: scale.id, scaleCode: scale.code, bodyMeasures: bodyMeasuresOf(row.bodyMeasures) }
  }
  let certificate: CellCertificate | null = null
  if (colourway && size) {
    const answer = await certificateGateFor(client, { styleId: style.id, colourwayId: colourway.id, size: size.code }, ask.date)
    // B-W2a-66 (PRD-285, Annex V 7.2): a change to the approved type holds the class label until the notified body's answer.
    const held = answer.outcome === 'covered' && answer.certificate ? await classLabelHoldFor(client, revision?.id ?? null, answer.certificate.id) : null
    certificate = {
      outcome: held ? 'refused' : answer.outcome,
      certificate: answer.certificate ? { id: answer.certificate.id, number: answer.certificate.number, standard: answer.certificate.standard, ppeClass: answer.certificate.ppeClass, validTo: answer.certificate.validTo } : null,
      reasons: held ? [held] : answer.reasons.map((reason) => reason.message),
      date: ask.date,
    }
  }
  return { style, revision, colourway, size, certificate, date: ask.date }
}

const identificationOf = (style: StyleRow): Identification => ({ kind: style.garmentTracking === 'SERIAL' ? 'SERIAL' : 'BATCH', value: null, recordType: null, recordId: null, reference: null })
const languagesOf = (value: string | undefined): string[] => (value ? [...new Set(value.split(',').map((language) => language.trim()).filter((language) => language !== ''))] : [])

/** The label as the contract answers it (fresh arrays). */
export function labelView(label: RenderedLabel) {
  return {
    ...label,
    template: { ...label.template },
    banner: [...label.banner],
    languages: [...label.languages],
    blocks: label.blocks.map((block) => ({
      ...block,
      lines: block.lines.map((line) => ({ ...line })),
      graphic: block.graphic === null ? null : block.graphic.kind === 'CARE' ? { kind: 'CARE' as const, symbols: block.graphic.symbols.map((symbol) => ({ ...symbol })) } : { ...block.graphic },
      source: { ...block.source },
    })),
    fit: label.fit ? { ...label.fit } : null,
    problems: label.problems.map((issue) => ({ ...issue })),
    warnings: label.warnings.map((issue) => ({ ...issue })),
  }
}

/** The style a preview is for: the revision's, the asked one, or the label's own (a shared label needs one named). */
async function styleFor(client: Reader, context: RequestContext, template: TemplateRow, query: CellQuery): Promise<{ style: StyleRow; revisionId: string | null }> {
  let styleId = query.styleId ?? null
  let revisionId: string | null = null
  if (query.styleRevisionId) {
    const revision = isUuid(query.styleRevisionId) ? await client.styleRevision.findUnique({ where: { id: query.styleRevisionId }, select: { id: true, styleId: true } }) : null
    if (!revision) throw invalid('querystring/styleRevisionId', 'No such style revision.')
    if (styleId !== null && styleId !== revision.styleId) throw invalid('querystring/styleId', "The style revision is another style's.")
    styleId = revision.styleId
    revisionId = revision.id
  }
  styleId ??= template.styleId
  if (styleId === null) throw invalid('querystring/styleId', 'A shared label is previewed on a style: name the style or one of its revisions.')
  return { style: await readVisibleStyle(client, context, styleId), revisionId }
}

interface Preview {
  readonly label: RenderedLabel
  /** What the cell was rendered with (a SAMPLE's values), for the browser's own render of a draft being typed. */
  readonly values: Omit<LabelValues, 'identification' | 'manufactured' | 'sample'> & { readonly identification: { readonly kind: Identification['kind'] } }
  readonly cell: {
    styleId: string
    styleCode: string
    styleRevisionId: string | null
    revision: number | null
    colourwayId: string | null
    size: string | null
    date: BusinessDate
    certificate: { outcome: CellCertificate['outcome']; number: string | null; reasons: string[] } | null
  }
}

async function render(caller: CommandCaller, templateId: string, query: CellQuery): Promise<Preview & { readonly row: TemplateRow }> {
  const context = officeOf(caller)
  const row = await readTemplate(caller, templateId)
  const date = query.date ?? todayOf()
  return caller.withClient(async (client) => {
    const { style, revisionId } = await styleFor(client, context, row, query)
    const cell = await readCell(client, style, row.id, { revisionId, colourwayId: query.colourwayId, size: query.size, date })
    const values: LabelValues = {
      style: labelStyleOf(style),
      colourway: cell.colourway,
      size: cell.size,
      certificate: cell.certificate,
      identification: identificationOf(style),
      manufactured: null,
      date,
      sample: true,
      marketLanguages: languagesOf(query.languages),
    }
    const label = renderLabel(factsOf(row), values)
    return {
      row,
      label,
      values: {
        style: { ...values.style },
        colourway: values.colourway ? { ...values.colourway } : null,
        size: values.size ? { ...values.size, bodyMeasures: values.size.bodyMeasures ? structuredClone(values.size.bodyMeasures) : null } : null,
        certificate: values.certificate
          ? { ...values.certificate, certificate: values.certificate.certificate ? { ...values.certificate.certificate } : null, reasons: [...values.certificate.reasons] }
          : null,
        identification: { kind: values.identification.kind },
        date,
        marketLanguages: [...values.marketLanguages],
      },
      cell: {
        styleId: style.id,
        styleCode: style.code,
        styleRevisionId: cell.revision?.id ?? null,
        revision: cell.revision?.revision ?? null,
        colourwayId: cell.colourway?.id ?? null,
        size: cell.size?.code ?? null,
        date,
        certificate: cell.certificate ? { outcome: cell.certificate.outcome, number: cell.certificate.certificate?.number ?? null, reasons: [...cell.certificate.reasons] } : null,
      },
    }
  })
}

/** GET /compliance/labels/:templateId/preview: the rendered SAMPLE label with its sources and problems, and its ZPL. */
export async function previewLabel(caller: CommandCaller, templateId: string, query: CellQuery & { readonly dpi: number }) {
  const { label, cell, values } = await render(caller, templateId, query)
  let zpl: { dpi: number; text: string } | null = null
  try {
    zpl = { dpi: query.dpi, text: garmentLabelZpl(label, query.dpi) }
  } catch (error) {
    // A label whose size is not readable has no ZPL (its problems say why).
    if (!(error instanceof RangeError)) throw error
  }
  return {
    label: labelView(label),
    cell,
    values: { ...values, marketLanguages: [...values.marketLanguages], certificate: values.certificate ? { ...values.certificate, reasons: [...values.certificate.reasons] } : null },
    zpl,
  }
}

/** GET /compliance/labels/:templateId/preview/pdf: the same SAMPLE label as a PDF of its size, stored nowhere. */
export async function previewPdf(caller: CommandCaller, templateId: string, query: CellQuery): Promise<{ pdf: Buffer; fileName: string }> {
  const { label, row } = await render(caller, templateId, query)
  if (!label.fit) throw invalid('querystring', `Label ${row.code} r${row.revision} has no readable size: fix its width and height first.`)
  return { pdf: await renderGarmentLabelPdf(label), fileName: `${row.code}-r${row.revision}-sample.pdf` }
}

/**
 * POST /compliance/labels/:templateId/test-print: the SAMPLE label on a label printer (design 02 `lb-test`), with
 * compliance.labels.manage over the label's company; print.labels over the printer's company and site is the print
 * service's check. The printer's stock must hold the label.
 */
export async function testPrint(caller: CommandCaller, templateId: string, body: CellQuery & { readonly printerId: string; readonly copies: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { label, row } = await render(caller, templateId, body)
  if (!can(actorOf(context), LABELS_MANAGE, { companyId: row.companyId })) throw new ForbiddenError()
  const width = label.fit ? hundredthsOf(label.fit.widthMm) : null
  const height = label.fit ? hundredthsOf(label.fit.heightMm) : null
  if (width === null || height === null) throw invalid('body', `Label ${row.code} r${row.revision} has no readable size: fix its width and height first.`)
  const job = await queueModuleLabel(
    caller,
    {
      printerId: body.printerId,
      recordType: 'LabelTemplate',
      recordId: row.id,
      copies: body.copies,
      labelKind: 'GARMENT',
      scanId: 'SAMPLE',
      zplFor: (stock) => {
        if (stock.widthMm * 100 < width || stock.heightMm * 100 < height) {
          throw invalid('body/printerId', `This printer holds ${stock.widthMm} × ${stock.heightMm} mm labels; label ${row.code} is ${mmText(width)} × ${mmText(height)} mm.`)
        }
        return garmentLabelZpl(label, stock.dpi, body.copies)
      },
    },
    idempotencyKey,
  )
  return { job, label: labelView(label) }
}

// ---- for the final operation (B-W1-44) ---------------------------------------------------------------------------------------

export interface GarmentLabelQuestion {
  readonly labelTemplateId: string
  readonly styleId: string
  /** The style revision the work order was released with (its frozen spec). */
  readonly styleRevisionId: string | null
  readonly colourwayId: string
  readonly size: string
  /** The work order's batch number, or the garment's serial. */
  readonly identification: Identification
  /** The work order's release day (the batch's date of manufacture). */
  readonly manufactured: LabelValues['manufactured']
  /** The day of the print (the certificate gate's day). */
  readonly date: BusinessDate
  /** The languages the buyer's market needs (the order's party, the market). */
  readonly marketLanguages: readonly string[]
}

/**
 * The real garment label of a cell, rendered with this client inside the caller's own command (B-W1-44 at the final
 * operation): no permission is checked here. `printable` false: the label must not be printed; `problems` say why.
 */
export async function garmentLabelFor(client: Reader, question: GarmentLabelQuestion): Promise<RenderedLabel> {
  const row = await client.labelTemplate.findUnique({ where: { id: question.labelTemplateId }, select: TEMPLATE_SELECT })
  if (!row) throw new NotFoundError('Label not found.')
  const style = await findStyle(client, question.styleId)
  if (!style) throw new NotFoundError('Style not found.')
  const cell = await readCell(client, style, row.id, { revisionId: question.styleRevisionId, colourwayId: question.colourwayId, size: question.size, date: question.date })
  return renderLabel(factsOf(row), {
    style: labelStyleOf(style),
    colourway: cell.colourway,
    size: cell.size,
    certificate: cell.certificate,
    identification: question.identification,
    manufactured: question.manufactured,
    date: question.date,
    sample: false,
    marketLanguages: question.marketLanguages,
  })
}
