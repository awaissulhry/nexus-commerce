import { ValidationError } from '@nexus/factory-domain/core/errors'
import type { CreateStyleBody } from '@nexus/factory-domain/product/styles/contracts'
import type { StyleDraftBody } from '@nexus/factory-domain/sales/inquiries/contracts'
import { SALES_INQUIRIES_VIEW } from '@nexus/factory-domain/sales/inquiries/permissions'
import { STYLE_DRAFTS_MAX, styleDraftRefusal, summaryOf } from '@nexus/factory-domain/sales/inquiries/rules'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { codeConflict, makeStyleInCommand, prepareStyle } from '../../product/styles/styles'
import { isUniqueViolation } from '../../product/styles/store'
import { carryFiles, requestFiles } from './carry'
import { databaseRefusal, factsOf, officeInquiry, readInquiryRow, refuse, type InquiryData } from './store'
import { viewInCommand } from './inquiries'

/**
 * B-TH-026 (threads plan TH-2, L2-G18, N8; design O-SAL-INQ-LIST.pane-actions-F04 "Make style draft"; wall W12): a DRAFT style
 * made from a request, for the request's customer's own label.
 *
 *   POST /sales/inquiries/:inquiryId/style-draft   sales.inquiries.view over the request and product.styles.manage over its
 *                                                  company: the production manager may (B-TH-014 reads requests; this action
 *                                                  is the product office's, so READ_ONLY does not hold it back)
 *
 * In ONE command: the request locked at the version read (open: a draft does not answer it; it stays NEW, In progress or Need
 * info), the style made by the style library's own making (product/styles `makeStyleInCommand`: its code free, its range from
 * the scale or the product type, DRAFT, `style.created`) with the request's company and, as its brand (the label on the
 * garment), the REQUEST's customer — never one the body names (W12: the body has no brand field) — its name the request's
 * subject unless typed, and the style appended to the request's drafts (`styleIds`, in the order made; the database rechecks
 * that no other customer's private label is named). Then the files picked are carried to the style (Use on…, ./carry.ts).
 * A style needs a released revision and an active colourway before an order takes it (the style's own page says so); "Make
 * order" stays held until the request's lines name it.
 */

/** POST /sales/inquiries/:inquiryId/style-draft: "Make style draft". */
export async function styleDraftOf(caller: CommandCaller, inquiryId: string, body: StyleDraftBody, idempotencyKey?: string) {
  const { inquiry } = await officeInquiry(caller, inquiryId, SALES_INQUIRIES_VIEW)
  refuse(styleDraftRefusal(factsOf(inquiry), inquiry.styleIds.length))
  const picked = body.fileIds ?? []
  const files = await requestFiles(caller, inquiry, picked)
  const missing = picked.filter((fileId) => !files.some((file) => file.id === fileId))
  if (missing.length > 0) throw new ValidationError('Pick files of this request (or of its mail) that are available.', missing.map((fileId) => ({ path: `body/fileIds/${picked.indexOf(fileId)}`, message: 'Not an available file of this request.' })))
  const styleBody: CreateStyleBody = {
    companyId: inquiry.companyId,
    code: body.code,
    name: body.name ?? (summaryOf(inquiry.request).slice(0, 200) || inquiry.number),
    productType: body.productType,
    brandPartyId: inquiry.partyId,
    ...(body.productTypeProfileId !== undefined ? { productTypeProfileId: body.productTypeProfileId } : {}),
    ...(body.sizeScaleId !== undefined ? { sizeScaleId: body.sizeScaleId } : {}),
    ...(body.sizes !== undefined ? { sizes: body.sizes } : {}),
    ...(body.baseSize !== undefined ? { baseSize: body.baseSize } : {}),
    ...(body.season !== undefined ? { season: body.season } : {}),
    ...(body.ppeCategory !== undefined ? { ppeCategory: body.ppeCategory } : {}),
  } as CreateStyleBody
  // product.styles.manage over the company, the type's defaults and the range: refused in words before any lock.
  const prepared = await prepareStyle(caller, styleBody)

  const { result } = await command(caller, { name: 'sales.inquiries.styleDraft', idempotencyKey, input: { inquiryId, ...body } }, async (tools) => {
    // The request locked (the person may only read requests: the lock is the request's own, not lockForChange's manage check).
    await tools.tx.$queryRaw`SELECT id FROM "Inquiry" WHERE id = ${inquiry.id}::uuid FOR UPDATE`
    const row = (await readInquiryRow(tools.tx, inquiry.id)) as InquiryData
    if (row.version !== body.version) throw new StaleVersionError('Inquiry', row.id, row.version, body.version)
    refuse(styleDraftRefusal(factsOf(row), row.styleIds.length))
    const style = await makeStyleInCommand(tools, styleBody, prepared)
    const styleIds = [...row.styleIds, style.id].slice(0, STYLE_DRAFTS_MAX)
    const { count } = await tools.tx.inquiry.updateMany({ where: { id: row.id, version: row.version }, data: { styleIds, version: row.version + 1, updatedAt: tools.now } })
    if (count === 0) throw new StaleVersionError('Inquiry', row.id, row.version + 1, row.version)
    tools.audit({ action: 'sales.inquiries.styleDraft', recordType: 'Inquiry', recordId: row.id, companyId: row.companyId, before: { styleIds: row.styleIds }, after: { styleIds, styleId: style.id, styleCode: style.code } })
    return { inquiry: await viewInCommand(tools, row.id), style: { id: style.id, code: style.code, name: style.name, status: style.status } }
  })
    .catch((error: unknown) => {
      if (isUniqueViolation(error)) throw codeConflict(prepared.code)
      throw error
    })
    .catch(databaseRefusal)

  return { ...result, files: await carryFiles(caller, files, { recordType: 'Style', recordId: result.style.id }, idempotencyKey) }
}
