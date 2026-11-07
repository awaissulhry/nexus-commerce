import type { FastifyInstance, FastifyRequest } from 'fastify'
import { DomainError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { NumberFormat } from '@nexus/factory-domain/imports/cells'
import { mapHeaders } from '@nexus/factory-domain/imports/headers'
import type { CsvEncoding } from '@nexus/factory-domain/imports/job'
import { parseRow } from '@nexus/factory-domain/imports/plan'
import { importTemplate } from '@nexus/factory-domain/imports/templates'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { linesOfReady, ORDER_TEMPLATE_EXAMPLES, portalOrderLinesImporter, refusedRowsCsv, uploadVerdicts } from '@nexus/factory-domain/sales/portal-ordering/upload'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { processImporters } from '../../../platform/imports/registry'
import { readSheet, SheetError } from '../../../platform/imports/sheet'
import { templateFile } from '../../../platform/imports/templates/template'
import { appClock, commandOn } from '../../../platform/portal/tasks/clock'
import { portalReader } from '../portal-orders/access'
import { readCatalogue, uploadIndexOf } from './catalogue'
import { addLinesInCommand, ownRequest, pricesFor, requestView } from './requests'
import { readRequest } from './store'

/**
 * Order upload from a spreadsheet (B-W2b-190, SAL-073; design portal.customer.neworder upload, its template tab).
 *
 *   GET  /portal/order-template?format=xlsx|csv            the template (style, colour, size, quantity, your code) with
 *                                                          made-up example rows and a sheet that explains the columns
 *   POST /portal/order-requests/:id/upload                 the sheet (CSV or Excel, in the body as base64: at most about
 *                                                          700 KB, the API's 1 MiB body) read with the imports engine's
 *                                                          reader, its headers mapped and cells parsed by the registry's
 *                                                          importer `sales.portalOrderLines`, each row checked against the
 *                                                          customer's catalogue: a verdict per row (READY, or REFUSED
 *                                                          with the reason), the lines the ready rows make, the refused
 *                                                          rows as a CSV to fix. `apply: false` (the dry run) writes
 *                                                          nothing; `apply: true` (with the draft's version) reads the
 *                                                          sheet again and adds the ready rows to the draft in one command
 *                                                          ("Nothing is added until 'Add 42 rows to the order'")
 *
 * The sheet is never stored: it is read in the request and dropped.
 */

/** The decoded sheet's limit: the body is 1 MiB, base64 is 4/3 of the bytes. */
export const UPLOAD_MAX_BYTES = 700 * 1024

const importerOf = () => processImporters().get(portalOrderLinesImporter.key)?.importer ?? portalOrderLinesImporter

export async function orderTemplate(app: FastifyInstance, request: FastifyRequest, query: { readonly format: 'csv' | 'xlsx'; readonly numberFormat?: NumberFormat | undefined }) {
  const reader = portalReader(app, request)
  const numberFormat = query.numberFormat ?? (reader.session.person.locale === 'en' ? 'en' : 'it')
  const template = importTemplate(importerOf(), { numberFormat, grains: [...heldGrains(reader.actor)], examples: ORDER_TEMPLATE_EXAMPLES })
  return templateFile(template, query.format)
}

export interface UploadBody {
  readonly fileName: string
  readonly contentType: string
  /** The file's bytes, base64. */
  readonly content: string
  readonly numberFormat?: NumberFormat | undefined
  readonly sheetName?: string | null | undefined
  readonly encoding?: CsvEncoding | null | undefined
  readonly apply?: boolean | undefined
  /** The draft's version (needed to apply). */
  readonly version?: number | undefined
  readonly locale?: 'it' | 'en' | undefined
}

/** We could not read this file: the problem in words (400). */
const unreadable = (message: string, issues: readonly { path: string; message: string }[] = [{ path: 'body/content', message }]): DomainError => new DomainError('bad_request', `We could not read this file: ${message}`, issues)

export async function uploadSheet(app: FastifyInstance, request: FastifyRequest, requestId: string, body: UploadBody, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownRequest(request, reader, requestId)
  if (row.status !== 'DRAFT') throw new InvalidStateError('This request is no longer a draft.')
  if (body.apply && body.version === undefined) throw new ValidationError('Adding the rows needs the draft\'s version.', [{ path: 'body/version', message: 'Required to add the rows.' }])
  const bytes = Buffer.from(body.content, 'base64')
  if (bytes.length === 0) throw unreadable('the file is empty.')
  if (bytes.length > UPLOAD_MAX_BYTES) throw unreadable(`it is larger than ${Math.round(UPLOAD_MAX_BYTES / 1024)} KB; split it into smaller sheets.`)
  const importer = importerOf()
  const name = body.fileName.toLowerCase()
  const contentType = name.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : name.endsWith('.csv') ? 'text/csv' : body.contentType
  let sheet: Awaited<ReturnType<typeof readSheet>>
  try {
    sheet = await readSheet(bytes, { contentType, sheetName: body.sheetName ?? null, encoding: body.encoding ?? null, maxRows: importer.maxRows })
  } catch (error) {
    if (error instanceof SheetError) throw unreadable(error.issues.map((issue) => issue.message).join(' '), error.issues.map((issue) => ({ path: 'body/content', message: issue.message })))
    throw unreadable('it is not a CSV or Excel (.xlsx) sheet.')
  }
  const mapping = mapHeaders(importer.columns, sheet.headers, {})
  const missing = Object.entries(importer.columns).filter(([column, definition]) => definition.required && !mapping.columns.some((entry) => entry.column === column)).map(([, definition]) => definition.label)
  if (missing.length > 0) throw unreadable(`no column for ${missing.join(', ')} (the template's headers: Style, Colour, Size, Quantity, Your code).`)
  const numberFormat = body.numberFormat ?? (reader.session.person.locale === 'en' ? 'en' : 'it')
  const parsed = sheet.rows.map((sheetRow) => parseRow(importer, mapping.columns, sheetRow, { numberFormat }))
  const catalogue = await reader.inTenant((db) => readCatalogue(db, { companyId: row.companyId, partyId: row.partyId, day: businessDate(appClock(app).now()) }))
  const verdicts = uploadVerdicts(parsed, uploadIndexOf(catalogue))
  const lines = linesOfReady(verdicts)
  const locale = body.locale ?? (reader.session.person.locale === 'en' ? 'en' : 'it')
  const ready = verdicts.filter((verdict) => verdict.status === 'READY').length
  const dryRun = {
    rows: verdicts.length,
    ready,
    refused: verdicts.length - ready,
    verdicts: verdicts.map((verdict) => ({ ...verdict, reasons: [...verdict.reasons] })),
    lines: lines.map((line) => ({ styleId: line.styleId, styleCode: catalogue.styles.get(line.styleId)?.code ?? '', colourwayId: line.colourwayId, colourwayCode: catalogue.colourways.get(line.colourwayId)?.code ?? '', sizes: [...line.sizes], note: line.note })),
    refusedCsv: verdicts.length === ready ? null : refusedRowsCsv(verdicts, locale),
    columns: mapping.columns.map((entry) => ({ header: entry.header, column: entry.column })),
    ignored: mapping.ignored.map((entry) => entry.header).filter((header) => header !== ''),
  }
  if (!body.apply) return { dryRun, applied: false as const, record: null }
  if (lines.length === 0) throw new InvalidStateError('No row of this sheet is ready: nothing to add.')
  const withNotes = lines.map((line) => ({ ...line, sourceOrderLineId: null }))
  const prices = pricesFor(withNotes, catalogue, reader.seesPrices)
  const { result } = await commandOn(app, request, { name: 'portalOrdering.upload', idempotencyKey, input: { requestId, fileName: body.fileName, rows: verdicts.length, version: body.version }, record: { type: 'PortalOrderRequest', id: row.id, expectedVersion: body.version! } }, async (tools) => {
    const current = await readRequest(tools.tx, row.id)
    if (current?.status !== 'DRAFT') throw new InvalidStateError('This request is no longer a draft.')
    const outcome = await addLinesInCommand(tools, row, withNotes, prices, reader.session.userId, true)
    tools.audit({
      recordType: 'PortalOrderRequest',
      recordId: row.id,
      companyId: row.companyId,
      after: { upload: { fileName: body.fileName, rows: verdicts.length, ready, refused: verdicts.length - ready }, added: outcome.added, merged: outcome.merged, kept: outcome.kept, lines: withNotes.map((line) => ({ styleId: line.styleId, colourwayId: line.colourwayId, sizes: line.sizes, unitPriceShown: markMoney('price', prices.get(`${line.styleId}|${line.colourwayId}`) ?? null) })) },
    })
    return outcome
  })
  return { dryRun, applied: true as const, added: result.added.length, merged: [...result.merged], kept: [...result.kept], record: await requestView(app, request, reader, await ownRequest(request, reader, requestId)) }
}
